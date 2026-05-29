import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { extractFromUrl } from '../services/extractor';
import { scoreProduct, upsertSellerProfile } from '../services/scorer';
import { analyzeWithAI } from '../services/ai';
import { db } from '../db/client';
import { normalizeUrl } from '../services/urlNormalizer';

const router = Router();

const CheckSchema = z.object({
  url:           z.string().url('Invalid URL'),
  userId:        z.string().uuid().optional(),
  forceDeepScan: z.boolean().optional().default(false),
});

// ─── POST /api/check ──────────────────────────────────────────────────────────

router.post('/', async (req: Request, res: Response): Promise<void> => {
  const parsed = CheckSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten().fieldErrors });
    return;
  }

  const { url, userId, forceDeepScan } = parsed.data;
  const startMs     = Date.now();
  const normalizedUrl = normalizeUrl(url);
  console.log(`\n[Check] ▶ ${url}${userId ? ` user:${userId}` : ' (guest)'}`);
  console.log(`[Check] normalized_url=${normalizedUrl}`);

  // ── Memory: look up prior checks for this normalized URL ─────────────────
  let memory = {
    seenBefore:        false,
    checkedCount:      0,
    lastCheckedAt:     null as string | null,
    previousRiskLevel: null as string | null,
    previousScore:     null as number | null,
    approvedReportCount: 0,
    message:           '',
  };
  try {
    const [priorChecks, priorReports] = await Promise.all([
      db.from('product_checks')
        .select('risk_score,risk_level,created_at')
        .eq('normalized_url', normalizedUrl)
        .order('created_at', { ascending: false })
        .limit(10),
      db.from('scam_reports')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'approved')
        .or(`seller_profile_url.eq.${normalizedUrl},seller_url.eq.${normalizedUrl}`),
    ]);
    const prior = priorChecks.data ?? [];
    if (prior.length > 0) {
      memory.seenBefore        = true;
      memory.checkedCount      = prior.length;
      memory.lastCheckedAt     = prior[0].created_at;
      memory.previousRiskLevel = prior[0].risk_level;
      memory.previousScore     = prior[0].risk_score;
      memory.approvedReportCount = priorReports.count ?? 0;
      const prev = prior[0].risk_level;
      if (prev === 'high' || (memory.approvedReportCount ?? 0) > 0) {
        memory.message = `This link was checked ${prior.length} time${prior.length > 1 ? 's' : ''} before. Previous result: High Risk ${prior[0].risk_score}/100. Review carefully before paying.`;
      } else if (prev === 'medium') {
        memory.message = `This link was checked ${prior.length} time${prior.length > 1 ? 's' : ''} before. Previous result: Caution, ${prior[0].risk_score}/100. Verify before sending money.`;
      } else {
        memory.message = `This link was checked ${prior.length} time${prior.length > 1 ? 's' : ''} before. Previous result: Low Risk, ${prior[0].risk_score}/100. Always verify before buying.`;
      }
      console.log(`[Check] memory: seenBefore=true count=${prior.length} prev=${prev} ${prior[0].risk_score}/100`);
    }
  } catch (memErr: any) {
    console.warn('[Check] memory lookup failed (non-fatal):', memErr?.message);
  }

  // ── Quota check ────────────────────────────────────────────────────────────
  let planAtCheck: 'free' | 'plus' | 'pro' = 'free';
  let hasAI    = false;
  let isLocked = false;
  let quotaStatus = 'ok';

  if (userId) {
    const { data: quotaResult, error: quotaError } = await db
      .rpc('consume_check', { p_user_id: userId });

    if (quotaError) {
      console.error('[Check] consume_check error:', quotaError.message);
    } else if (quotaResult) {
      quotaStatus = quotaResult.status;
      console.log(`[Check] Quota → ${quotaResult.status} | plan:${quotaResult.plan ?? 'free'}`);

      if (quotaResult.status === 'quota_exceeded') {
        isLocked = true;
      } else {
        const plan = quotaResult.plan ?? 'free';
        planAtCheck = plan;
        hasAI = (plan === 'plus' || plan === 'pro');
      }
    }
  }

  // ── Extract (multi-worker) ────────────────────────────────────────────────
  let product: Awaited<ReturnType<typeof extractFromUrl>>;
  try {
    product = await extractFromUrl(url, hasAI, forceDeepScan);
  } catch (err) {
    console.error('[Check] Extraction threw:', err);
    res.status(422).json({ error: 'Could not extract product data from this URL.' });
    return;
  }

  // ── Score ──────────────────────────────────────────────────────────────────
  const scoring = await scoreProduct(product);

  // Log the full analysis result
  console.log(
    `[Check] Score → ${scoring.riskScore}/100 (${scoring.riskLevel.toUpperCase()})`,
    `| sub: scam=${scoring.subScores.scamScore} price=${scoring.subScores.priceScore}`,
    `seller=${scoring.subScores.sellerScore} quality=${scoring.subScores.qualityScore}`,
  );
  console.log(
    `[Check] Product → name:"${product.productName}" price:${product.price}`,
    `seller:"${product.sellerName}" rating:${product.rating} reviews:${product.reviewCount}`,
    `sold:${product.soldCount} partial:${product.partial} confidence:${product.confidence}%`,
    `worker:${product.workerUsed} method:${product.extractMethod}`,
  );
  console.log(
    `[Check] Signals → communityReports:${scoring.signals.communityReports}`,
    `keywords:[${scoring.signals.keywordsFound.join(',')}]`,
    `priceAnomaly:${scoring.signals.priceAnomalyPercent}%`,
    `newSeller:${scoring.signals.newSeller}`,
  );

  // ── AI explanation (Plus/Pro only) ─────────────────────────────────────────
  let aiResult = { summary: null as string | null, factors: [] as string[], recommendation: null as string | null };
  let aiUsed = false;

  if (hasAI && !isLocked && userId) {
    const { data: aiQuota } = await db.rpc('consume_ai_check', {
      p_user_id: userId,
      p_feature: 'url_analysis',
    });

    if (aiQuota?.status === 'ok') {
      try {
        const ai = await analyzeWithAI(product, scoring);
        aiResult = { summary: ai.summary, factors: ai.factors, recommendation: ai.recommendation };
        aiUsed = true;
        console.log(`[Check] AI → used:true summary_len:${ai.summary?.length ?? 0}`);
      } catch (e: any) {
        console.error('[Check] AI failed:', e.message);
      }

      await db.from('ai_usage_logs').insert({
        user_id:      userId,
        feature_type: 'url_analysis',
        input_type:   'url',
        plan:         planAtCheck,
        tokens_used:  null,
      });
    } else {
      console.log(`[Check] AI skipped: ${aiQuota?.status}`);
    }
  } else {
    console.log(`[Check] AI skipped: hasAI=${hasAI} locked=${isLocked} userId=${!!userId}`);
  }

  // ── Upsert seller profile ─────────────────────────────────────────────────
  if (product.sellerId && product.platform !== 'other') {
    const { data: spid } = await db.rpc('upsert_seller_profile', {
      p_platform:    product.platform,
      p_seller_id:   product.sellerId,
      p_seller_name: product.sellerName ?? '',
      p_risk_score:  scoring.riskScore,
    });
    if (spid) console.log(`[Check] Seller profile upserted: ${spid}`);
  }

  // ── Save check ────────────────────────────────────────────────────────────
  const checkId    = uuidv4();
  const dbPlatform = product.platform === 'other' ? 'unknown' : product.platform;

  const { error: insertError } = await db.from('product_checks').insert({
    id:             checkId,
    user_id:        userId ?? null,
    input_url:      url,
    normalized_url: normalizedUrl,
    input_type:     'url',
    platform:       dbPlatform,
    product_name:   product.productName,
    price:          product.price,
    seller_name:    product.sellerName,
    seller_id:      product.sellerId,
    risk_score:     scoring.riskScore,
    risk_level:     scoring.riskLevel,
    ai_summary:     aiResult.summary,
    factors:        aiResult.factors,
    signals:        { ...scoring.signals, subScores: scoring.subScores },
    plan_at_check:  planAtCheck,
    has_ai:         aiUsed,
    is_locked:      isLocked,
    partial_data:   product.partial,
    confidence:     product.confidence ?? null,
  });
  if (insertError) console.error('[Check] DB insert error:', insertError.message);

  console.log(`[Check] Done in ${Date.now() - startMs}ms | checkId:${checkId} locked:${isLocked}\n`);

  // ── Response ───────────────────────────────────────────────────────────────
  if (isLocked) {
    res.json({ locked: true, checkId, quotaStatus, message: "You've used your free checks. Watch an ad, wait for reset, or upgrade." });
    return;
  }

  res.json({
    locked:           false,
    checkId,
    inputUrl:         url,
    normalizedUrl,
    platform:         product.platform,
    productName:      product.productName,
    price:            product.price,
    sellerName:       product.sellerName,
    riskScore:        scoring.riskScore,
    riskLevel:        scoring.riskLevel,
    aiSummary:        aiResult.summary,
    factors:          aiResult.factors,
    recommendation:   aiResult.recommendation,
    signals:          scoring.signals,
    subScores:        scoring.subScores,
    hasAI:            aiUsed,
    planAtCheck,
    partial:          product.partial,
    extractMethod:    product.extractMethod,
    confidence:       product.confidence,
    workerUsed:       product.workerUsed,
    dataSources:      product.dataSources,
    needsDeeperCheck: product.needsDeeperCheck,
    createdAt:        new Date().toISOString(),
    memory,
  });
});

// ─── GET /api/check/:id ────────────────────────────────────────────────────────

router.get('/:id', async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const { userId } = req.query as { userId?: string };

  const query = db.from('product_checks').select('*').eq('id', id);
  if (userId) query.eq('user_id', userId);

  const { data, error } = await query.single();
  if (error || !data) { res.status(404).json({ error: 'Check not found' }); return; }
  if (data.is_locked)  { res.json({ locked: true, checkId: id }); return; }

  res.json(data);
});

// ─── GET /api/check/user/:userId ──────────────────────────────────────────────

router.get('/user/:userId', async (req: Request, res: Response): Promise<void> => {
  const { userId } = req.params;
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);

  const { data, error } = await db
    .from('product_checks')
    .select('id,platform,product_name,price,seller_name,risk_score,risk_level,has_ai,created_at')
    .eq('user_id', userId)
    .eq('is_locked', false)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) { res.status(500).json({ error: 'Failed to fetch history' }); return; }
  res.json({ checks: data });
});

// ─── POST /api/check/:id/feedback ─────────────────────────────────────────────

router.post('/:id/feedback', async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const { userId, wasCorrect, actualOutcome, notes } = req.body;

  if (typeof wasCorrect !== 'boolean') {
    res.status(400).json({ error: 'wasCorrect must be a boolean' });
    return;
  }

  const { error } = await db.from('result_feedback').upsert(
    { check_id: id, user_id: userId ?? null, was_correct: wasCorrect, actual_outcome: actualOutcome ?? null, notes: notes ?? null },
    { onConflict: 'check_id,user_id' },
  );

  if (error) { res.status(500).json({ error: 'Failed to save feedback' }); return; }
  res.json({ success: true });
});

// ─── POST /api/check/grant-ad-check ───────────────────────────────────────────

router.post('/grant-ad-check', async (req: Request, res: Response): Promise<void> => {
  const { userId, checkId, unityTxnId } = req.body;
  if (!userId) { res.status(400).json({ error: 'userId required' }); return; }

  await db.from('ad_events').insert({
    user_id:        userId,
    check_id:       checkId ?? null,
    ad_provider:    'unity',
    ad_type:        'rewarded',
    placement:      'Rewarded_Android',
    event:          'reward_granted',
    completed:      true,
    reward_granted: true,
    unity_txn_id:   unityTxnId ?? null,
  });

  const { data, error } = await db.rpc('grant_ad_check', { p_user_id: userId });
  if (error) { res.status(500).json({ error: 'Failed to grant ad check' }); return; }

  res.json({ success: true, adCheckAvailable: true });
});

export default router;
