/**
 * analytics.ts — public event ingestion: POST /api/analytics/event
 *
 * The mobile app posts product-funnel events here (app_opened, product_check_started,
 * watch_ad_clicked, etc.). Validated + sanitized + rate-limited. Never stores secrets.
 * Writes to public.product_analytics_events via the service-role db client.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { db } from '../db/client';

const router = Router();

const ALLOWED_EVENTS = new Set([
  'app_opened', 'screen_viewed', 'product_link_pasted', 'product_check_started',
  'product_check_completed', 'product_check_failed', 'limit_reached', 'watch_ad_clicked',
  'rewarded_ad_loaded', 'rewarded_ad_failed', 'rewarded_ad_completed', 'upgrade_clicked',
  'subscription_started', 'subscription_cancelled', 'scam_report_started',
  'scam_report_submitted', 'support_ticket_created', 'privacy_opened', 'terms_opened',
  'history_opened',
]);

const EventSchema = z.object({
  userId:        z.string().uuid().optional(),
  guestId:       z.string().max(128).optional(),
  sessionId:     z.string().max(128).optional(),
  eventName:     z.string().min(1).max(64),
  eventCategory: z.string().min(1).max(48).optional().default('general'),
  platform:      z.enum(['android', 'ios', 'web', 'other']).optional(),
  route:         z.string().max(128).optional(),
  screenName:    z.string().max(64).optional(),
  productUrl:    z.string().max(2048).optional(),
  productCheckId:z.string().uuid().optional(),
  plan:          z.enum(['free', 'plus', 'pro']).optional(),
  metadata:      z.record(z.string(), z.any()).optional(),
});

// Strip anything sensitive from metadata and cap its size.
function sanitizeMetadata(meta: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!meta || typeof meta !== 'object') return {};
  const BANNED = /pass|secret|token|key|auth|card|cvv|otp|seed|bearer/i;
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const [k, v] of Object.entries(meta)) {
    if (n++ >= 20) break;                          // cap key count
    if (BANNED.test(k)) continue;                  // drop sensitive keys
    if (typeof v === 'string') out[k] = v.slice(0, 200);
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    // ignore nested objects/arrays to keep payloads small
  }
  return out;
}

router.post('/event', async (req: Request, res: Response): Promise<void> => {
  const parsed = EventSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid event payload' }); return; }
  const e = parsed.data;

  if (!ALLOWED_EVENTS.has(e.eventName)) {
    res.status(400).json({ error: 'Unknown event name' });
    return;
  }

  try {
    const { error } = await db.from('product_analytics_events').insert({
      user_id:          e.userId ?? null,
      guest_id:         e.guestId ?? null,
      session_id:       e.sessionId ?? null,
      event_name:       e.eventName,
      event_category:   e.eventCategory,
      platform:         e.platform ?? null,
      route:            e.route ?? null,
      screen_name:      e.screenName ?? null,
      product_url:      e.productUrl ? e.productUrl.slice(0, 2048) : null,
      product_check_id: e.productCheckId ?? null,
      plan:             e.plan ?? null,
      metadata:         sanitizeMetadata(e.metadata),
    });
    if (error) { console.warn('[analytics] insert error:', error.message); }
    // Always 204 — analytics must never block or error the client.
    res.status(204).end();
  } catch (err: any) {
    console.warn('[analytics] event error:', err?.message);
    res.status(204).end();
  }
});

export default router;
