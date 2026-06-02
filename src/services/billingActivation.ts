/**
 * billingActivation.ts — single source of truth for turning a CONFIRMED payment
 * into plan access. Used by both the PayMongo and PayPal webhooks (and, as an
 * emergency fallback, by the admin manual-confirm route).
 *
 * Guarantees:
 *  - Idempotent: an already-paid record never extends the plan again.
 *  - Server-validated: the amount the provider reports must match the plan price.
 *  - Backend-only: only this module (running with the service-role key) flips a
 *    payment to paid and activates a plan. The client can never do it.
 */

import { db } from '../db/client';

export const PLAN_PRICES: Record<string, number> = { plus: 199, pro: 299 };
export const PLAN_DAYS = 30;

export function isValidPlan(p: unknown): p is 'plus' | 'pro' {
  return p === 'plus' || p === 'pro';
}

export interface ActivateResult {
  ok: boolean;
  alreadyProcessed: boolean;
  reason?: string;
  plan?: string;
  planExpiresAt?: string;
}

interface ActivateOpts {
  paymentId?: string;            // billing_payments.id
  externalPaymentId?: string;    // provider payment/order id
  externalCheckoutId?: string;   // PayMongo checkout session id
  provider: 'paymongo' | 'paypal';
  paymentMethod?: string;
  webhookEventId?: string | null;
  reportedAmount?: number | null; // amount provider says was paid, in PHP (already converted)
  rawMetadata?: unknown;
}

/** Locate the pending billing_payments row, validate, and activate the plan. */
export async function activatePaidPayment(opts: ActivateOpts): Promise<ActivateResult> {
  // 1. Locate the record by the most specific identifier available.
  let query = db.from('billing_payments').select('*').limit(1);
  if (opts.paymentId)             query = query.eq('id', opts.paymentId);
  else if (opts.externalPaymentId)  query = query.eq('external_payment_id', opts.externalPaymentId);
  else if (opts.externalCheckoutId) query = query.eq('external_checkout_id', opts.externalCheckoutId);
  else return { ok: false, alreadyProcessed: false, reason: 'no identifier provided' };

  const { data: rows, error } = await query;
  if (error) return { ok: false, alreadyProcessed: false, reason: error.message };
  const pay = rows?.[0];
  if (!pay) return { ok: false, alreadyProcessed: false, reason: 'payment record not found' };

  // 2. Dedup — already activated.
  if (pay.status === 'paid') {
    return { ok: true, alreadyProcessed: true, plan: pay.plan, planExpiresAt: pay.plan_expires_at };
  }

  // 3. Validate plan + amount (server is the source of truth).
  if (!isValidPlan(pay.plan)) return { ok: false, alreadyProcessed: false, reason: 'invalid plan on record' };
  const expected = PLAN_PRICES[pay.plan];
  if (opts.reportedAmount != null && Math.round(opts.reportedAmount) !== expected) {
    await db.from('billing_payments').update({
      status:      'failed',
      admin_notes: `amount mismatch: provider reported ${opts.reportedAmount}, expected ${expected}`,
      updated_at:  new Date().toISOString(),
    }).eq('id', pay.id);
    console.error(`[Activate] amount mismatch for ${pay.id}: ${opts.reportedAmount} != ${expected}`);
    return { ok: false, alreadyProcessed: false, reason: 'amount mismatch' };
  }

  // 4. Mark paid + activate plan for 30 days.
  const now     = new Date();
  const expires = new Date(now.getTime() + PLAN_DAYS * 86_400_000).toISOString();

  const { error: payErr } = await db.from('billing_payments').update({
    status:               'paid',
    confirmed_at:         now.toISOString(),
    plan_expires_at:      expires,
    webhook_event_id:     opts.webhookEventId ?? pay.webhook_event_id ?? null,
    raw_webhook_metadata: (opts.rawMetadata as object) ?? pay.raw_webhook_metadata ?? null,
    payment_method:       opts.paymentMethod ?? pay.payment_method ?? null,
    updated_at:           now.toISOString(),
  }).eq('id', pay.id);
  if (payErr) return { ok: false, alreadyProcessed: false, reason: payErr.message };

  // Core profile update — only guaranteed columns, so activation always applies.
  const { error: coreErr } = await db.from('profiles')
    .update({ plan: pay.plan, subscription_status: 'active' })
    .eq('user_id', pay.user_id);
  if (coreErr) console.error('[Activate] profile core update error:', coreErr.message);

  // Best-effort enrichment (migration 022 columns). Non-fatal.
  void db.from('profiles').update({
    subscription_source: opts.provider,
    plan_updated_at:     now.toISOString(),
    current_period_end:  expires,
  }).eq('user_id', pay.user_id);

  // Billing-history event (non-fatal).
  void db.from('subscription_events').insert({
    user_id:    pay.user_id,
    event_type: 'purchase',
    plan:       pay.plan,
    store:      opts.provider,
  });

  console.log(`[Activate] ${opts.provider} payment ${pay.id} → ${pay.plan} active until ${expires} (user ${pay.user_id})`);
  return { ok: true, alreadyProcessed: false, plan: pay.plan, planExpiresAt: expires };
}
