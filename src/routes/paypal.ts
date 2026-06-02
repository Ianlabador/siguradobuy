import { Router, Request, Response } from 'express';
import axios from 'axios';
import { db } from '../db/client';
import { activatePaidPayment } from '../services/billingActivation';

const router = Router();

const PAYPAL_MODE       = (process.env.PAYPAL_MODE ?? 'sandbox').trim().toLowerCase();
// Strip stray whitespace/newlines/quotes that can sneak in via env vars and break Basic auth.
const clean = (v: string | undefined) => (v ?? '').trim().replace(/^["']|["']$/g, '');
const PAYPAL_CLIENT_ID  = clean(process.env.PAYPAL_CLIENT_ID);
const PAYPAL_SECRET     = clean(process.env.PAYPAL_CLIENT_SECRET);
const PAYPAL_WEBHOOK_ID = clean(process.env.PAYPAL_WEBHOOK_ID);

// Accept BOTH 'live' and 'production' as the live environment. (PayPal docs say
// "live"; the previous code only matched "production", so PAYPAL_MODE=live wrongly
// used the sandbox URL with live credentials → 401.)
const PAYPAL_LIVE = PAYPAL_MODE === 'live' || PAYPAL_MODE === 'production';
const PAYPAL_BASE = PAYPAL_LIVE
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';

// Safe startup diagnostic — never logs the secret or full client id.
console.log(`[PAYPAL_CONFIG] mode=${PAYPAL_MODE} live=${PAYPAL_LIVE} baseUrl=${PAYPAL_BASE} clientIdPresent=${!!PAYPAL_CLIENT_ID} secretPresent=${!!PAYPAL_SECRET} clientIdLast4=${PAYPAL_CLIENT_ID.slice(-4) || 'none'} webhookIdPresent=${!!PAYPAL_WEBHOOK_ID}`);

// Public base URL of this API — used for PayPal return/cancel landing pages.
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL ?? 'https://siguradobuy-production.up.railway.app').replace(/\/$/, '');

// True only when both PayPal credentials are present on the server.
const PAYPAL_CONFIGURED = !!PAYPAL_CLIENT_ID && !!PAYPAL_SECRET;

// ── GET /api/paypal/status ────────────────────────────────────────────────────
// Lets the mobile app know whether billing is actually configured before
// showing a checkout. Never leaks the secret — only a boolean + mode.
router.get('/status', (_req: Request, res: Response): void => {
  res.json({ configured: PAYPAL_CONFIGURED, mode: PAYPAL_MODE });
});

// Verify a PayPal webhook signature using PayPal's verify-webhook-signature API.
// Returns true only if PayPal confirms the event is authentic.
// SECURITY: without this, anyone could POST a fake ACTIVATED event to upgrade a user.
async function verifyWebhookSignature(req: Request): Promise<boolean> {
  if (!PAYPAL_WEBHOOK_ID) {
    // Not configured — refuse to trust unverified events in live mode.
    if (PAYPAL_LIVE) {
      console.error('[PAYPAL_WEBHOOK_REJECTED] PAYPAL_WEBHOOK_ID not set — rejecting in live mode.');
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

// Thrown when PayPal rejects our credentials (so callers can return a clean error).
class PayPalAuthError extends Error {}

async function getPayPalToken(): Promise<string> {
  if (!PAYPAL_CLIENT_ID || !PAYPAL_SECRET) {
    throw new PayPalAuthError('PayPal credentials not configured on server');
  }
  console.log(`[PAYPAL_TOKEN_REQUEST_START] baseUrl=${PAYPAL_BASE} live=${PAYPAL_LIVE}`);
  try {
    const { data } = await axios.post(
      `${PAYPAL_BASE}/v1/oauth2/token`,
      'grant_type=client_credentials',
      {
        auth: { username: PAYPAL_CLIENT_ID, password: PAYPAL_SECRET },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      },
    );
    console.log('[PAYPAL_TOKEN_REQUEST_SUCCESS]');
    return data.access_token;
  } catch (e: any) {
    const status = e.response?.status;
    // Safe error fields only — never the secret.
    const name = e.response?.data?.error ?? e.code ?? 'unknown';
    const msg  = e.response?.data?.error_description ?? e.message;
    console.error(`[PAYPAL_TOKEN_REQUEST_FAIL] status=${status} paypalErrorName=${name} paypalErrorMessage=${msg}`);
    if (status === 401) {
      console.error('[PAYPAL_TOKEN_REQUEST_FAIL] 401 = PayPal rejected the credentials. Check: live keys copied from the LIVE REST app, no trailing spaces, PAYPAL_MODE=live, and the base URL matches the key environment.');
    }
    throw new PayPalAuthError(`PayPal auth failed (status ${status ?? 'n/a'})`);
  }
}

// ── POST /api/paypal/create-order ─────────────────────────────────────────────
// Body: { userId, plan: 'plus' | 'pro', currency?: 'PHP' }
router.post('/create-order', async (req: Request, res: Response): Promise<void> => {
  // Clear, honest signal when the server has no PayPal credentials — the app
  // shows "Billing is not configured correctly. Please contact support."
  if (!PAYPAL_CONFIGURED) {
    res.status(503).json({ error: 'billing_not_configured', message: 'PayPal credentials are not configured on the server.' });
    return;
  }
  try {
    const { userId, plan, currency = 'PHP' } = req.body ?? {};
    if (!userId || !plan) {
      res.status(400).json({ error: 'userId and plan are required' });
      return;
    }

    const PRICES: Record<string, string> = { plus: '199.00', pro: '299.00' };
    const amount = PRICES[plan];
    if (!amount) { res.status(400).json({ error: 'Invalid plan. Must be plus or pro.' }); return; }

    console.log(`[PAYPAL_CREATE_ORDER_START] plan=${plan} amount=${amount} ${currency}`);
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
          brand_name:  'SiguradoBuy',
          user_action: 'PAY_NOW',
          return_url:  `${PUBLIC_BASE_URL}/api/paypal/return`,
          cancel_url:  `${PUBLIC_BASE_URL}/api/paypal/cancel`,
        },
      },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } },
    );

    // The link the user must open to approve the payment in their browser.
    const links: Array<{ rel: string; href: string }> = data.links ?? [];
    const approveUrl =
      links.find(l => l.rel === 'payer-action')?.href ??
      links.find(l => l.rel === 'approve')?.href ??
      null;

    // Create a pending billing_payments record so the webhook can match + activate.
    void db.from('billing_payments').insert({
      user_id:            userId,
      provider:           'paypal',
      payment_method:     'paypal',
      plan,
      amount:             parseFloat(amount),
      currency,
      status:             'pending',
      payment_reference:  `SBPP-${plan.toUpperCase()}-${data.id}`,
      external_payment_id: data.id,    // PayPal order id
    });

    console.log(`[PAYPAL_CREATE_ORDER_SUCCESS] orderId=${data.id} status=${data.status}`);
    res.json({ orderId: data.id, status: data.status, approveUrl });
  } catch (e: any) {
    // Credential rejection (401) → distinct code so the app shows the right message.
    if (e instanceof PayPalAuthError) {
      console.error('[PAYPAL_CREATE_ORDER_FAIL] reason=auth', e.message);
      res.status(502).json({ error: 'paypal_auth_failed', message: 'PayPal payment is temporarily unavailable. Please try again later or use another payment method.' });
      return;
    }
    const status = e.response?.status;
    const safeName = e.response?.data?.name ?? e.code ?? 'unknown';
    const debugId  = e.response?.data?.debug_id ?? null;
    console.error(`[PAYPAL_CREATE_ORDER_FAIL] status=${status} name=${safeName} debugId=${debugId} msg=${e.message}`);
    res.status(502).json({ error: 'paypal_unavailable', message: 'PayPal payment is temporarily unavailable. Please try again later or use another payment method.' });
  }
});

// ── GET /api/paypal/return & /cancel ──────────────────────────────────────────
// PayPal redirects the in-browser checkout here after approve/cancel. We just
// show a simple branded page telling the user to return to the SiguradoBuy app,
// which then calls capture-order to finalize. Plain HTML, no secrets.
function landingPage(title: string, body: string): string {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>SiguradoBuy</title><style>body{background:#0A0A0A;color:#fff;font-family:-apple-system,Segoe UI,Roboto,sans-serif;` +
    `display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:24px}` +
    `.c{max-width:360px}.t{color:#D4AF37;font-size:22px;font-weight:800;margin-bottom:10px}.m{color:#cfcfcf;font-size:15px;line-height:1.5}</style>` +
    `</head><body><div class="c"><div class="t">${title}</div><div class="m">${body}</div></div></body></html>`;
}

router.get('/return', (_req: Request, res: Response): void => {
  res.type('html').send(landingPage('Payment approved', 'You can now return to the SiguradoBuy app and tap “I’ve completed payment” to activate your plan.'));
});

router.get('/cancel', (_req: Request, res: Response): void => {
  res.type('html').send(landingPage('Payment cancelled', 'No charge was made. Return to the SiguradoBuy app to try again.'));
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

    // Extract the captured amount + custom_id (userId:plan) for validation.
    const capture     = data.purchase_units?.[0]?.payments?.captures?.[0];
    const customId    = capture?.custom_id ?? '';
    const capturedAmt = capture?.amount?.value ? parseFloat(capture.amount.value) : null;
    const [userId, plan] = customId.split(':');

    // Activate via the unified helper: validates amount, dedups, marks the
    // billing_payments row paid, and activates the plan for 30 days.
    const result = await activatePaidPayment({
      externalPaymentId: orderId,
      provider:          'paypal',
      paymentMethod:     'paypal',
      reportedAmount:    capturedAmt,
      rawMetadata:       { orderId, customId, source: 'capture-order' },
    });

    res.json({
      success:        result.ok,
      orderId,
      status:         data.status,
      plan,
      userId,
      planExpiresAt:  result.planExpiresAt ?? null,
      alreadyActive:  result.alreadyProcessed,
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
    console.log(`[PAYPAL_WEBHOOK_RECEIVED] event_type=${req.body?.event_type} id=${req.body?.id}`);
    // SECURITY: verify the event genuinely came from PayPal before trusting it.
    const verified = await verifyWebhookSignature(req);
    if (!verified) {
      console.error('[PAYPAL_WEBHOOK_REJECTED] signature verification failed');
      res.status(401).json({ error: 'Webhook signature verification failed' });
      return;
    }

    // PayPal sends the raw body as JSON — read event type and resource
    const event      = req.body ?? {};
    const eventType  = event.event_type as string | undefined;
    const resource   = event.resource   as Record<string, any> | undefined;

    console.log(`[PAYPAL_WEBHOOK_VERIFIED] [PAYPAL_WEBHOOK_EVENT_TYPE] ${eventType}`);

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

    const webhookEventId: string | null = event.id ?? null;

    switch (eventType) {

      // ── One-time Orders flow (what this app uses) ──────────────────────────
      case 'CHECKOUT.ORDER.APPROVED': {
        // Buyer approved — capture server-side so activation is fully automatic
        // (no reliance on the client calling capture-order).
        const orderId: string = resource.id;
        try {
          const token = await getPayPalToken();
          const { data: cap } = await axios.post(
            `${PAYPAL_BASE}/v2/checkout/orders/${orderId}/capture`,
            {},
            { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } },
          );
          const capture = cap.purchase_units?.[0]?.payments?.captures?.[0];
          const amt = capture?.amount?.value ? parseFloat(capture.amount.value) : null;
          if (cap.status === 'COMPLETED') {
            await activatePaidPayment({
              externalPaymentId: orderId,
              provider:          'paypal',
              paymentMethod:     'paypal',
              webhookEventId,
              reportedAmount:    amt,
              rawMetadata:       { orderId, source: 'webhook:ORDER.APPROVED' },
            });
          }
        } catch (e: any) {
          console.error('[PayPal Webhook] auto-capture failed:', e.response?.data ?? e.message);
        }
        break;
      }

      case 'PAYMENT.CAPTURE.COMPLETED': {
        // Capture already happened (client or webhook). Activate idempotently.
        const orderId: string | undefined = resource.supplementary_data?.related_ids?.order_id;
        const amt = resource.amount?.value ? parseFloat(resource.amount.value) : null;
        if (orderId) {
          await activatePaidPayment({
            externalPaymentId: orderId,
            provider:          'paypal',
            paymentMethod:     'paypal',
            webhookEventId,
            reportedAmount:    amt,
            rawMetadata:       { orderId, captureId: resource.id, source: 'webhook:CAPTURE.COMPLETED' },
          });
        } else {
          console.warn('[PayPal Webhook] CAPTURE.COMPLETED without related order_id — cannot match record.');
        }
        break;
      }

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
