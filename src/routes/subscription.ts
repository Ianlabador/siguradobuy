/**
 * RevenueCat webhook handler.
 *
 * In RevenueCat Dashboard → Project Settings → Webhooks, add:
 *   URL: https://your-api-domain.com/api/subscription/webhook
 *   Authorization header: Bearer YOUR_WEBHOOK_SECRET
 *
 * Set REVENUECAT_WEBHOOK_SECRET in api/.env
 */

import { Router, Request, Response } from 'express';
import { db } from '../db/client';

const router = Router();

// Map RevenueCat event types to plan + status
function parsePlanFromEvent(event: any): { plan: string; status: string } {
  const type = event.type as string;
  const productId: string = event.product_id ?? '';

  let plan = 'free';
  if (productId.includes('pro'))  plan = 'pro';
  else if (productId.includes('plus')) plan = 'plus';

  let status = 'none';
  switch (type) {
    case 'INITIAL_PURCHASE':
    case 'RENEWAL':
    case 'UNCANCELLATION':
      status = 'active';
      break;
    case 'CANCELLATION':
      status = 'cancelled';
      break;
    case 'EXPIRATION':
      status = 'expired';
      plan   = 'free';
      break;
    case 'BILLING_ISSUE':
      status = 'expired';
      break;
    case 'TRIAL_STARTED':
      status = 'trial';
      break;
    default:
      status = 'active';
  }

  return { plan, status };
}

router.post('/webhook', async (req: Request, res: Response): Promise<void> => {
  // Validate webhook secret
  const secret = process.env.REVENUECAT_WEBHOOK_SECRET;
  if (secret) {
    const authHeader = req.headers.authorization ?? '';
    if (authHeader !== `Bearer ${secret}`) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
  }

  const event = req.body?.event;
  if (!event) {
    res.status(400).json({ error: 'No event in payload' });
    return;
  }

  const rcAppUserId: string = event.app_user_id ?? '';
  const productId:   string = event.product_id ?? '';
  const expiresAt:   string | null = event.expiration_at_ms
    ? new Date(event.expiration_at_ms).toISOString()
    : null;

  // RevenueCat app_user_id = our Supabase auth.users UUID
  const { plan, status } = parsePlanFromEvent(event);

  try {
    // Log raw event
    await db.from('subscription_events').insert({
      user_id:     rcAppUserId || null,
      provider:    'revenuecat',
      event_type:  event.type,
      plan,
      status,
      store:       event.store ?? null,
      product_id:  productId,
      period_type: event.period_type ?? null,
      expires_at:  expiresAt,
      raw_payload: req.body,
    });

    // Update user profile
    if (rcAppUserId) {
      await db.rpc('update_subscription', {
        p_user_id:       rcAppUserId,
        p_plan:          plan,
        p_status:        status,
        p_provider:      'revenuecat',
        p_revenuecat_id: rcAppUserId,
        p_expires_at:    expiresAt,
      });
    }

    res.json({ received: true });
  } catch (err: any) {
    console.error('[subscription webhook] error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// GET /api/subscription/status?userId=xxx — get current plan for a user
router.get('/status', async (req: Request, res: Response): Promise<void> => {
  const { userId } = req.query as { userId?: string };
  if (!userId) { res.status(400).json({ error: 'userId required' }); return; }

  const { data, error } = await db
    .from('profiles')
    .select('plan,subscription_status,subscription_expires_at,free_checks_used,free_checks_limit,free_window_started_at,ad_check_available,ai_checks_used,ai_checks_limit')
    .eq('user_id', userId)
    .single();

  if (error || !data) { res.status(404).json({ error: 'Profile not found' }); return; }
  res.json(data);
});

export default router;
