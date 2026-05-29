import { Router, Request, Response } from 'express';
import axios from 'axios';
import { db } from '../db/client';

const router = Router();

const PAYPAL_MODE       = process.env.PAYPAL_MODE ?? 'sandbox';
const PAYPAL_CLIENT_ID  = process.env.PAYPAL_CLIENT_ID ?? '';
const PAYPAL_SECRET     = process.env.PAYPAL_CLIENT_SECRET ?? '';
const PAYPAL_WEBHOOK_ID = process.env.PAYPAL_WEBHOOK_ID ?? '';

const PAYPAL_BASE = PAYPAL_MODE === 'production'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';

// Verify a PayPal webhook signature using PayPal's verify-webhook-signature API.
// Returns true only if PayPal confirms the event is authentic.
// SECURITY: without this, anyone could POST a fake ACTIVATED event to upgrade a user.
async function verifyWebhookSignature(req: Request): Promise<boolean> {
  if (!PAYPAL_WEBHOOK_ID) {
    // Not configured — refuse to trust unverified events in production.
    if (PAYPAL_MODE === 'production') {
      console.error('[PayPal Webhook] PAYPAL_WEBHOOK_ID not set — rejecting in production.');
      return false;
    }
    console.warn('[PayPal Webhook] PAYPAL_WEBHOOK_ID not set — skipping verification (sandbox only).');
    return true;
  }
  try {
    const token = await getPayPalToken();
    const { data } = await axios.post(
      `${PAYPAL_BASE}/v1/notifications/verify-webhook-signature`,
      {
        auth_algo:         req.headers['paypal-auth-algo'],
        cert_url:          req.headers['paypal-cert-url'],
        transmission_id:   req.headers['paypal-transmission-id'],
        transmission_sig:  req.headers['paypal-transmission-sig'],
        transmission_time: req.headers['paypal-transmission-time'],
        webhook_id:        PAYPAL_WEBHOOK_ID,
        webhook_event:     req.body,
      },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } },
    );
    return data.verification_status === 'SUCCESS';
  } catch (e: any) {
    console.error('[PayPal Webhook] Signature verification failed:', e.response?.data ?? e.message);
    return false;
  }
}

async function getPayPalToken(): Promise<string> {
  if (!PAYPAL_CLIENT_ID || !PAYPAL_SECRET) {
    throw new Error('PayPal credentials not configured on server');
  }
  const { data } = await axios.post(
    `${PAYPAL_BASE}/v1/oauth2/token`,
    'grant_type=client_credentials',
    {
      auth: { username: PAYPAL_CLIENT_ID, password: PAYPAL_SECRET },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    },
  );
  return data.access_token;
}

// ── POST /api/paypal/create-order ─────────────────────────────────────────────
// Body: { userId, plan: 'plus' | 'pro', currency?: 'PHP' }
router.post('/create-order', async (req: Request, res: Response): Promise<void> => {
  try {
    const { userId, plan, currency = 'PHP' } = req.body ?? {};
    if (!userId || !plan) {
      res.status(400).json({ error: 'userId and plan are required' });
      return;
    }

    const PRICES: Record<string, string> = { plus: '199.00', pro: '299.00' };
    const amount = PRICES[plan];
    if (!amount) { res.status(400).json({ error: 'Invalid plan. Must be plus or pro.' }); return; }

    const token = await getPayPalToken();

    const { data } = await axios.post(
      `${PAYPAL_BASE}/v2/checkout/orders`,
      {
        intent: 'CAPTURE',
        purchase_units: [{
          amount: { currency_code: currency, value: amount },
          description: `SiguradoBuy ${plan.charAt(0).toUpperCase() + plan.slice(1)} — 1 Month`,
          custom_id: `${userId}:${plan}`,
        }],
        application_context: {
          brand_name: 'SiguradoBuy',
          user_action: 'PAY_NOW',
        },
      },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } },
    );

    res.json({ orderId: data.id, status: data.status });
  } catch (e: any) {
    const msg = e.response?.data?.message ?? e.message;
    console.error('[PayPal] create-order error:', msg);
    res.status(500).json({ error: msg });
  }
});

// ── POST /api/paypal/capture-order ────────────────────────────────────────────
// Body: { orderId }
router.post('/capture-order', async (req: Request, res: Response): Promise<void> => {
  try {
    const { orderId } = req.body ?? {};
    if (!orderId) { res.status(400).json({ error: 'orderId is required' }); return; }

    const token = await getPayPalToken();

    const { data } = await axios.post(
      `${PAYPAL_BASE}/v2/checkout/orders/${orderId}/capture`,
      {},
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } },
    );

    if (data.status !== 'COMPLETED') {
      res.status(400).json({ error: 'Payment not completed', status: data.status });
      return;
    }

    // Extract userId and plan from custom_id
    const customId = data.purchase_units?.[0]?.payments?.captures?.[0]?.custom_id ?? '';
    const [userId, plan] = customId.split(':');

    // Update Supabase subscription only after confirmed payment
    if (userId && plan) {
      await db.from('profiles').update({
        plan,
        subscription_status: 'active',
        subscription_source: 'paypal',
      }).eq('user_id', userId);
    }

    res.json({
      success: true,
      orderId,
      status:  data.status,
      plan,
      userId,
    });
  } catch (e: any) {
    const msg = e.response?.data?.message ?? e.message;
    console.error('[PayPal] capture-order error:', msg);
    res.status(500).json({ error: msg });
  }
});

// ── POST /api/paypal/webhook ──────────────────────────────────────────────────
// Handles PayPal subscription lifecycle events.
// Verify the webhook signature before trusting any event.
router.post('/webhook', async (req: Request, res: Response): Promise<void> => {
  try {
    // SECURITY: verify the event genuinely came from PayPal before trusting it.
    const verified = await verifyWebhookSignature(req);
    if (!verified) {
      console.error('[PayPal Webhook] Rejected unverified webhook event.');
      res.status(401).json({ error: 'Webhook signature verification failed' });
      return;
    }

    // PayPal sends the raw body as JSON — read event type and resource
    const event      = req.body ?? {};
    const eventType  = event.event_type as string | undefined;
    const resource   = event.resource   as Record<string, any> | undefined;

    console.log(`[PayPal Webhook] event_type=${eventType} (verified)`);

    if (!eventType || !resource) {
      res.status(400).json({ error: 'Missing event_type or resource' });
      return;
    }

    // Extract the subscriber's custom_id — we encode it as userId:plan in create-order.
    // For subscription events, subscriber payer_id or custom_id is attached.
    const subscriptionId: string | undefined =
      resource.id ?? resource.billing_agreement_id;

    // Helper: update a user's subscription by PayPal subscription ID or custom_id
    async function updateBySubscriptionId(
      subId: string,
      fields: Record<string, unknown>,
    ) {
      const { error } = await db
        .from('profiles')
        .update({ ...fields, plan_updated_at: new Date().toISOString() })
        .eq('paypal_subscription_id', subId);
      if (error) console.error('[PayPal Webhook] DB update error:', error.message);
    }

    switch (eventType) {

      case 'BILLING.SUBSCRIPTION.ACTIVATED': {
        const customId: string = resource.custom_id ?? '';
        const [userId, plan]   = customId.split(':');
        if (userId && plan) {
          const startDate = resource.start_time ?? new Date().toISOString();
          const endDate   = resource.billing_info?.next_billing_time;
          await db.from('profiles').update({
            plan,
            subscription_status:    'active',
            subscription_source:    'paypal',
            paypal_subscription_id: subscriptionId,
            current_period_start:   startDate,
            current_period_end:     endDate ?? null,
            cancel_at_period_end:   false,
            last_payment_status:    'succeeded',
            plan_updated_at:        new Date().toISOString(),
          }).eq('user_id', userId);
          console.log(`[PayPal Webhook] Subscription ACTIVATED — user=${userId} plan=${plan}`);
        }
        break;
      }

      case 'BILLING.SUBSCRIPTION.CANCELLED':
      case 'BILLING.SUBSCRIPTION.EXPIRED': {
        if (subscriptionId) {
          await updateBySubscriptionId(subscriptionId, {
            plan:                'free',
            subscription_status: eventType.includes('CANCELLED') ? 'cancelled' : 'expired',
            cancel_at_period_end: false,
          });
          console.log(`[PayPal Webhook] Subscription ${eventType} — subId=${subscriptionId}`);
        }
        break;
      }

      case 'BILLING.SUBSCRIPTION.SUSPENDED': {
        if (subscriptionId) {
          await updateBySubscriptionId(subscriptionId, {
            subscription_status: 'suspended',
          });
          console.log(`[PayPal Webhook] Subscription SUSPENDED — subId=${subscriptionId}`);
        }
        break;
      }

      case 'PAYMENT.SALE.COMPLETED': {
        // Recurring payment succeeded — extend period end if present
        const subId = resource.billing_agreement_id;
        if (subId) {
          await updateBySubscriptionId(subId, {
            subscription_status: 'active',
            last_payment_status: 'succeeded',
          });
          console.log(`[PayPal Webhook] Payment COMPLETED — subId=${subId}`);
        }
        break;
      }

      case 'PAYMENT.SALE.DENIED':
      case 'PAYMENT.SALE.REFUNDED': {
        const subId = resource.billing_agreement_id;
        if (subId) {
          await updateBySubscriptionId(subId, {
            subscription_status: 'past_due',
            last_payment_status: eventType.includes('DENIED') ? 'failed' : 'refunded',
          });
          console.log(`[PayPal Webhook] Payment ${eventType} — subId=${subId}`);
        }
        break;
      }

      default:
        console.log(`[PayPal Webhook] Unhandled event: ${eventType}`);
    }

    // Always respond 200 to acknowledge receipt
    res.status(200).json({ received: true });
  } catch (e: any) {
    console.error('[PayPal Webhook] Error:', e.message);
    // Still return 200 to prevent PayPal retry storms on server errors
    res.status(200).json({ received: true, error: e.message });
  }
});

// ── POST /api/paypal/cancel-subscription ─────────────────────────────────────
// App calls this when user taps "Cancel Plan" — marks cancel_at_period_end
router.post('/cancel-subscription', async (req: Request, res: Response): Promise<void> => {
  try {
    const { userId } = req.body ?? {};
    if (!userId) { res.status(400).json({ error: 'userId required' }); return; }

    // Mark as cancel_at_period_end — user keeps access until period_end
    const { error } = await db.from('profiles').update({
      cancel_at_period_end: true,
      plan_updated_at:      new Date().toISOString(),
    }).eq('user_id', userId);

    if (error) throw error;

    // Optionally: call PayPal API to cancel the subscription immediately.
    // For now, we mark it locally and let the CANCELLED webhook downgrade.

    res.json({ success: true, message: 'Cancellation recorded. Access continues until end of billing period.' });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
