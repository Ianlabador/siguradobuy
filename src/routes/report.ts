import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/client';
import { detectPlatform } from '../services/extractor';

const router = Router();

const ReportSchema = z.object({
  sellerName: z.string().min(1).max(200),
  sellerUrl: z.string().url().optional(),
  platform: z.enum(['shopee', 'lazada', 'tiktok', 'facebook', 'other']).optional(),
  description: z.string().min(10).max(2000),
  amountLost: z.number().positive().optional(),
  checkId: z.string().uuid().optional(),
  reporterId: z.string().uuid().optional(),
  evidenceUrls: z.array(z.string().url()).max(5).optional(),
});

// Submit a scam report
router.post('/', async (req: Request, res: Response): Promise<void> => {
  const parsed = ReportSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten().fieldErrors });
    return;
  }

  const {
    sellerName, sellerUrl, description,
    amountLost, checkId, reporterId, evidenceUrls
  } = parsed.data;

  let platform = parsed.data.platform;
  if (!platform && sellerUrl) {
    platform = detectPlatform(sellerUrl);
  }

  const reportId = uuidv4();
  const { error } = await db.from('scam_reports').insert({
    id: reportId,
    reporter_id: reporterId ?? null,
    seller_name: sellerName,
    seller_url: sellerUrl ?? null,
    platform: platform ?? 'other',
    description,
    amount_lost: amountLost ?? null,
    evidence_urls: evidenceUrls ?? [],
    check_id: checkId ?? null,
  });

  if (error) {
    res.status(500).json({ error: 'Failed to submit report' });
    return;
  }

  // Increment seller report count in seller_profiles
  if (sellerName && platform) {
    await db.rpc('increment_report_count', {
      p_seller_name: sellerName,
      p_platform: platform,
    });
  }

  // Award reputation to reporter
  if (reporterId) {
    await db.rpc('increment_reputation', {
      p_user_id: reporterId,
      p_amount: 5,
    });
  }

  res.status(201).json({ reportId, success: true });
});

// Get recent community reports (scam alert feed)
router.get('/feed', async (req: Request, res: Response): Promise<void> => {
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);
  const platform = req.query.platform as string | undefined;

  let query = db
    .from('scam_reports')
    .select('id, seller_name, platform, description, amount_lost, upvotes, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (platform && platform !== 'all') {
    query = query.eq('platform', platform);
  }

  const { data, error } = await query;

  if (error) {
    res.status(500).json({ error: 'Failed to fetch reports' });
    return;
  }

  res.json({ reports: data });
});

// Get a specific report
router.get('/:id', async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;

  const { data, error } = await db
    .from('scam_reports')
    .select('*')
    .eq('id', id)
    .single();

  if (error || !data) {
    res.status(404).json({ error: 'Report not found' });
    return;
  }

  res.json(data);
});

// Upvote a report
router.post('/:id/upvote', async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const { userId } = req.body;

  if (!userId) {
    res.status(400).json({ error: 'userId required to upvote' });
    return;
  }

  const { error: upvoteError } = await db.from('report_upvotes').insert({
    report_id: id,
    user_id: userId,
  });

  if (upvoteError) {
    // Likely duplicate — already upvoted
    res.status(409).json({ error: 'Already upvoted this report' });
    return;
  }

  await db.rpc('increment_report_upvotes', { p_report_id: id });

  res.json({ success: true });
});

export default router;
