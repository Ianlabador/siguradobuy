/**
 * QR Ph (PayMongo static QR) billing — user-facing routes.
 *
 * IMPORTANT: this is a STATIC QR. We cannot automatically tell which user paid,
 * so a payment never auto-activates a plan. The backend only ever creates a
 * `pending` record and moves it to `awaiting_review` when the user says they
 * paid. An admin confirms it in the portal, which is the ONLY thing that
 * activates Plus/Pro (see admin.ts → /billing/qrph/:id/confirm).
 *
 * The backend decides the official amount from the plan — never trust amount
 * from the client.
 */

import { Router, Request, Response } from 'express';
import { randomBytes } from 'crypto';
import { db } from '../db/client';
import { createCheckoutSession, PAYMONGO_CONFIGURED, PAYMONGO_MODE } from '../services/paymongo';

const router = Router();

// Server is the source of truth for prices (₱).
const PLAN_PRICES: Record<string, number> = { plus: 199, pro: 299 };
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL ?? 'https://siguradobuy-production.up.railway.app').replace(/\/$/, '');

function genReference(plan: string): string {
  return `SBQR-${plan.toUpperCase()}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`.toUpperCase();
}

// ── GET /api/billing/paymongo/status (config) ─────────────────────────────────
router.get('/paymongo/config', (_req: Request, res: Response): void => {
  res.json({ configured: PAYMONGO_CONFIGURED, mode: PAYMONGO_MODE });
});

// ── POST /api/billing/paymongo/create-checkout ────────────────────────────────
// Body: { userId, plan }. Creates a PayMongo hosted checkout + a pending record.
// Falls back (503) when PayMongo isn't configured → mobile uses the static QR.
router.post('/paymongo/create-checkout', async (req: Request, res: Response): Promise<void> => {
  if (!PAYMONGO_CONFIGURED) {
    res.status(503).json({ error: 'paymongo_not_configured', message: 'PayMongo is not configured on the server.' });
    return;
  }
  try {
    const { userId, plan } = req.body ?? {};
    if (!userId) { res.status(400).json({ error: 'userId is required' }); return; }
    if (plan !== 'plus' && plan !== 'pro') { res.status(400).json({ error: 'Invalid plan. Must be plus or pro.' }); return; }

    const amount    = PLAN_PRICES[plan];            // backend-decided
    const reference = genReference(plan);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    // 1. Create the pending record first so we have an id for metadata.
    const { data: created, error: insErr } = await db.from('billing_payments').insert({
      user_id:           userId,
      provider:          'paymongo',
      payment_method:    'qrph',
      plan,
      amount,
      currency:          'PHP',
      status:            'pending',
      payment_reference: reference,
      expires_at:        expiresAt,
    }).select('id').single();
    if (insErr || !created) { res.status(500).json({ error: insErr?.message ?? 'Could not create payment record' }); return; }

    // 2. Create the PayMongo checkout session.
    const session = await createCheckoutSession({
      amountPhp:       amount,
      plan,
      referenceNumber: reference,
      paymentId:       created.id,
      userId,
      successUrl:      `${PUBLIC_BASE_URL}/api/paymongo/return`,
      cancelUrl:       `${PUBLIC_BASE_URL}/api/paymongo/cancel`,
    });

    // 3. Save the checkout id + url on the record.
    await db.from('billing_payments').update({
      external_checkout_id: session.id,
      checkout_url:         session.checkoutUrl,
      updated_at:           new Date().toISOString(),
    }).eq('id', created.id);

    res.json({ paymentId: created.id, checkout_url: session.checkoutUrl, plan, amount, currency: 'PHP', reference });
  } catch (e: any) {
    const msg = e.response?.data?.errors?.[0]?.detail ?? e.message;
    console.error('[Billing] paymongo create-checkout error:', msg);
    res.status(500).json({ error: msg });
  }
});

// ── GET /api/billing/status/:paymentId ────────────────────────────────────────
// Unified status poll for any provider. No secrets exposed.
router.get('/status/:paymentId', async (req: Request, res: Response): Promise<void> => {
  try {
    const { data, error } = await db
      .from('billing_payments')
      .select('id,provider,payment_method,plan,amount,currency,status,plan_expires_at,confirmed_at,created_at')
      .eq('id', String(req.params.paymentId))
      .single();
    if (error || !data) { res.status(404).json({ error: 'Payment not found' }); return; }

    const messageMap: Record<string, string> = {
      pending:         'Waiting for your payment to be confirmed.',
      awaiting_review: 'Payment submitted — awaiting confirmation.',
      paid:            'Payment confirmed. Your plan is active.',
      failed:          'Payment failed. You have not been charged for an active plan.',
      rejected:        'Payment was not approved. You remain on the Free plan.',
      cancelled:       'Payment was cancelled.',
      expired:         'This payment request expired. Please start again.',
    };

    res.json({
      status:          data.status,
      provider:        data.provider,
      payment_method:  data.payment_method,
      plan:            data.plan,
      amount:          data.amount,
      currency:        data.currency,
      created_at:      data.created_at,
      confirmed_at:    data.confirmed_at,
      plan_expires_at: data.plan_expires_at,
      message:         messageMap[data.status] ?? '',
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/billing/qrph/create-pending ─────────────────────────────────────
// Body: { userId, plan: 'plus' | 'pro' }
router.post('/qrph/create-pending', async (req: Request, res: Response): Promise<void> => {
  try {
    const { userId, plan } = req.body ?? {};
    if (!userId)               { res.status(400).json({ error: 'userId is required' }); return; }
    if (plan !== 'plus' && plan !== 'pro') {
      res.status(400).json({ error: 'Invalid plan. Must be plus or pro.' }); return;
    }

    const amount = PLAN_PRICES[plan];            // backend-decided amount
    const reference = genReference(plan);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24h window

    const { data, error } = await db.from('billing_payments').insert({
      user_id:           userId,
      provider:          'paymongo_qrph',
      plan,
      amount,
      currency:          'PHP',
      status:            'pending',
      payment_reference: reference,
    }).select('id,plan,amount,currency,status,payment_reference,created_at').single();

    if (error) { res.status(500).json({ error: error.message }); return; }

    res.json({ payment: { ...data, expires_at: expiresAt } });
  } catch (e: any) {
    console.error('[Billing] create-pending error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/billing/qrph/status/:paymentId ───────────────────────────────────
// Lets the app poll whether an admin has confirmed the payment yet.
router.get('/qrph/status/:paymentId', async (req: Request, res: Response): Promise<void> => {
  try {
    const { data, error } = await db
      .from('billing_payments')
      .select('id,plan,status,plan_expires_at,confirmed_at')
      .eq('id', String(req.params.paymentId))
      .single();
    if (error || !data) { res.status(404).json({ error: 'Payment not found' }); return; }
    res.json({
      status:          data.status,
      plan:            data.plan,
      plan_expires_at: data.plan_expires_at ?? null,
      confirmed_at:    data.confirmed_at ?? null,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/billing/qrph/mark-submitted ─────────────────────────────────────
// Body: { paymentId, userId }
// User tapped "I have paid". Moves pending → awaiting_review. Never activates a
// plan and never touches a record that is already paid/rejected.
router.post('/qrph/mark-submitted', async (req: Request, res: Response): Promise<void> => {
  try {
    const { paymentId, userId } = req.body ?? {};
    if (!paymentId || !userId) { res.status(400).json({ error: 'paymentId and userId are required' }); return; }

    const { data: current, error } = await db
      .from('billing_payments')
      .select('status,user_id')
      .eq('id', paymentId)
      .single();
    if (error || !current)             { res.status(404).json({ error: 'Payment not found' }); return; }
    if (current.user_id !== userId)    { res.status(403).json({ error: 'Not your payment' }); return; }

    // Only advance from pending → awaiting_review. Leave paid/rejected untouched.
    if (current.status === 'pending') {
      await db.from('billing_payments').update({
        status:       'awaiting_review',
        submitted_at: new Date().toISOString(),
        updated_at:   new Date().toISOString(),
      }).eq('id', paymentId);
    }

    res.json({ success: true, status: 'awaiting_review' });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
