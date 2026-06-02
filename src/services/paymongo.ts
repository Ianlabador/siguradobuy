/**
 * paymongo.ts — PayMongo Checkout Sessions API + webhook signature verification.
 *
 * Secret key is read server-side only (PAYMONGO_SECRET_KEY). Never sent to the client.
 *
 * Docs: https://developers.paymongo.com/reference/checkout-session-resource
 *       https://developers.paymongo.com/docs/webhooks (signature header format)
 */

import axios from 'axios';
import crypto from 'crypto';

const PAYMONGO_BASE = 'https://api.paymongo.com/v1';

export const PAYMONGO_SECRET = process.env.PAYMONGO_SECRET_KEY ?? '';
export const PAYMONGO_MODE   = process.env.PAYMONGO_MODE ?? 'test';
export const PAYMONGO_WEBHOOK_SECRET = process.env.PAYMONGO_WEBHOOK_SECRET ?? '';
export const PAYMONGO_CONFIGURED = !!PAYMONGO_SECRET;

// Methods offered in the hosted checkout. QR Ph is the primary method for this app.
// Override with PAYMONGO_METHODS="qrph,gcash,card" if the account has more enabled.
const PAYMONGO_METHODS = (process.env.PAYMONGO_METHODS ?? 'qrph')
  .split(',').map(s => s.trim()).filter(Boolean);

function authHeader(): string {
  // Basic auth: base64(secretKey + ":")
  return 'Basic ' + Buffer.from(`${PAYMONGO_SECRET}:`).toString('base64');
}

export interface CheckoutSession {
  id: string;            // cs_xxx
  checkoutUrl: string;
}

/**
 * Create a hosted Checkout Session. `amountPhp` is in pesos; PayMongo wants centavos.
 * metadata carries our paymentId/userId/plan so the webhook can match the record.
 */
export async function createCheckoutSession(args: {
  amountPhp: number;
  plan: 'plus' | 'pro';
  referenceNumber: string;
  paymentId: string;
  userId: string;
  successUrl: string;
  cancelUrl: string;
}): Promise<CheckoutSession> {
  const body = {
    data: {
      attributes: {
        line_items: [{
          name:     `SiguradoBuy ${args.plan === 'pro' ? 'Pro' : 'Plus'} — 30 days`,
          amount:   Math.round(args.amountPhp * 100), // centavos
          currency: 'PHP',
          quantity: 1,
        }],
        payment_method_types: PAYMONGO_METHODS,
        description:           `SiguradoBuy ${args.plan} subscription`,
        reference_number:      args.referenceNumber,
        success_url:           args.successUrl,
        cancel_url:            args.cancelUrl,
        metadata: {
          paymentId: args.paymentId,
          userId:    args.userId,
          plan:      args.plan,
        },
      },
    },
  };

  const { data } = await axios.post(`${PAYMONGO_BASE}/checkout_sessions`, body, {
    headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
    timeout: 12000,
  });

  const id          = data?.data?.id as string;
  const checkoutUrl = data?.data?.attributes?.checkout_url as string;
  if (!id || !checkoutUrl) throw new Error('PayMongo did not return a checkout session');
  return { id, checkoutUrl };
}

/**
 * Verify a PayMongo webhook signature.
 * Header format: `Paymongo-Signature: t=<ts>,te=<test sig>,li=<live sig>`
 * Signature = HMAC-SHA256( `${t}.${rawBody}` , webhookSecret ).
 * Returns true if it matches the relevant signature for the current mode.
 * If no webhook secret is configured: allowed in test mode, rejected in live.
 */
export function verifyWebhookSignature(rawBody: Buffer | string, signatureHeader: string | undefined): boolean {
  if (!PAYMONGO_WEBHOOK_SECRET) {
    if (PAYMONGO_MODE === 'live') {
      console.error('[PayMongo] PAYMONGO_WEBHOOK_SECRET not set — rejecting in live mode.');
      return false;
    }
    console.warn('[PayMongo] PAYMONGO_WEBHOOK_SECRET not set — skipping verification (test mode).');
    return true;
  }
  if (!signatureHeader) return false;

  const parts: Record<string, string> = {};
  for (const seg of signatureHeader.split(',')) {
    const [k, v] = seg.split('=');
    if (k && v) parts[k.trim()] = v.trim();
  }
  const t = parts['t'];
  const provided = PAYMONGO_MODE === 'live' ? parts['li'] : parts['te'];
  if (!t || !provided) return false;

  const raw = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  const expected = crypto
    .createHmac('sha256', PAYMONGO_WEBHOOK_SECRET)
    .update(`${t}.${raw}`)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
  } catch {
    return false;
  }
}

/**
 * Pull the useful fields out of a PayMongo webhook event.
 * Handles `checkout_session.payment.paid` and `payment.paid`.
 */
export function parsePaidEvent(payload: any): {
  isPaid: boolean;
  eventId: string | null;
  checkoutId: string | null;
  paymentId: string | null;
  amountPhp: number | null;
  metadata: any;
} {
  const eventId = payload?.data?.id ?? null;
  const type    = payload?.data?.attributes?.type as string | undefined;
  const resource = payload?.data?.attributes?.data;          // the checkout_session or payment resource
  const attrs    = resource?.attributes ?? {};

  const isPaid = type === 'checkout_session.payment.paid' || type === 'payment.paid';

  // For checkout_session.payment.paid the resource is the checkout session.
  const checkoutId = resource?.id?.startsWith?.('cs_') ? resource.id : (attrs?.checkout_session_id ?? null);
  const payments   = attrs?.payments;
  const firstPayment = Array.isArray(payments) ? payments[0] : null;
  const paymentAttrs = firstPayment?.attributes ?? (type === 'payment.paid' ? attrs : null);

  const amountCentavos = paymentAttrs?.amount ?? attrs?.amount ?? null;
  const amountPhp = amountCentavos != null ? Number(amountCentavos) / 100 : null;
  const paymentId = firstPayment?.id ?? (type === 'payment.paid' ? resource?.id : null) ?? null;
  const metadata  = attrs?.metadata ?? paymentAttrs?.metadata ?? null;

  return { isPaid, eventId, checkoutId, paymentId, amountPhp, metadata };
}
