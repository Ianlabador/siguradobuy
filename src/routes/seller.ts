import { Router, Request, Response } from 'express';
import { db } from '../db/client';

const router = Router();

// Get seller profile + recent reports
router.get('/:platform/:sellerId', async (req: Request, res: Response): Promise<void> => {
  const { platform, sellerId } = req.params;

  const { data: profile, error } = await db
    .from('seller_profiles')
    .select('*')
    .eq('platform', platform)
    .eq('seller_id', sellerId)
    .single();

  if (error || !profile) {
    res.status(404).json({ error: 'Seller not found in database' });
    return;
  }

  const { data: reports } = await db
    .from('scam_reports')
    .select('id, description, amount_lost, upvotes, created_at')
    .eq('seller_profile_id', profile.id)
    .order('created_at', { ascending: false })
    .limit(10);

  const { data: recentChecks } = await db
    .from('product_checks')
    .select('risk_score, risk_level, product_name, price, created_at')
    .eq('seller_id', sellerId)
    .eq('platform', platform)
    .order('created_at', { ascending: false })
    .limit(5);

  res.json({
    profile,
    recentReports: reports ?? [],
    recentChecks: recentChecks ?? [],
  });
});

// Search sellers by name
router.get('/search', async (req: Request, res: Response): Promise<void> => {
  const { q, platform } = req.query;

  if (!q || typeof q !== 'string') {
    res.status(400).json({ error: 'Query parameter "q" required' });
    return;
  }

  let query = db
    .from('seller_profiles')
    .select('id, platform, seller_id, seller_name, trust_score, report_count, last_checked')
    .ilike('seller_name', `%${q}%`)
    .order('report_count', { ascending: false })
    .limit(20);

  if (platform && typeof platform === 'string') {
    query = query.eq('platform', platform);
  }

  const { data, error } = await query;

  if (error) {
    res.status(500).json({ error: 'Search failed' });
    return;
  }

  res.json({ sellers: data });
});

// Get trending risky sellers (high report count, recently active)
router.get('/trending/risky', async (req: Request, res: Response): Promise<void> => {
  const { data, error } = await db
    .from('seller_profiles')
    .select('id, platform, seller_name, trust_score, report_count, last_checked')
    .gt('report_count', 0)
    .order('report_count', { ascending: false })
    .limit(10);

  if (error) {
    res.status(500).json({ error: 'Failed to fetch trending sellers' });
    return;
  }

  res.json({ sellers: data });
});

export default router;
