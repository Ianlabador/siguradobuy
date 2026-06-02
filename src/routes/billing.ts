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

const router = Router();

// Server is the source of truth for prices (₱).
const PLAN_PRICES: Record<string, number> = { plus: 199, pro: 299 };

function genReference(plan: string): string {
  return `SBQR-${plan.toUpperCase()}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`.toUpperCase();
}

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
