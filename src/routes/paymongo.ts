/**
 * paymongo.ts (routes) — PayMongo webhook + checkout landing pages.
 * Mounted at /api/paymongo.
 */

import { Router, Request, Response } from 'express';
import { verifyWebhookSignature, parsePaidEvent, PAYMONGO_MODE } from '../services/paymongo';
import { activatePaidPayment } from '../services/billingActivation';

const router = Router();

function landingPage(title: string, body: string): string {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>SiguradoBuy</title><style>body{background:#0A0A0A;color:#fff;font-family:-apple-system,Segoe UI,Roboto,sans-serif;` +
    `display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:24px}` +
    `.c{max-width:360px}.t{color:#D4AF37;font-size:22px;font-weight:800;margin-bottom:10px}.m{color:#cfcfcf;font-size:15px;line-height:1.5}</style>` +
    `</head><body><div class="c"><div class="t">${title}</div><div class="m">${body}</div></div></body></html>`;
}

router.get('/return', (_req: Request, res: Response): void => {
  res.type('html').send(landingPage('Payment received', 'Return to the SiguradoBuy app — your plan activates automatically once payment is confirmed.'));
});

router.get('/cancel', (_req: Request, res: Response): void => {
  res.type('html').send(landingPage('Payment cancelled', 'No charge was made. Return to the SiguradoBuy app to try again.'));
});

// ── POST /api/paymongo/webhook ────────────────────────────────────────────────
// PayMongo posts payment events here. We verify the signature, then activate the
// plan automatically. Always 200 on duplicates so PayMongo stops retrying.
router.post('/webhook', async (req: Request, res: Response): Promise<void> => {
  // rawBody is captured in index.ts via express.json({ verify }).
  const rawBody = (req as any).rawBody ?? JSON.stringify(req.body ?? {});
  const signature = req.headers['paymongo-signature'] as string | undefined;

  if (!verifyWebhookSignature(rawBody, signature)) {
    console.error('[PayMongo Webhook] signature verification failed — rejecting.');
    res.status(401).json({ error: 'invalid signature' });
    return;
  }

  try {
    const evt = parsePaidEvent(req.body);
    console.log(`[PayMongo Webhook] event=${req.body?.data?.attributes?.type} id=${evt.eventId} paid=${evt.isPaid} cs=${evt.checkoutId} amount=${evt.amountPhp} (verified, mode=${PAYMONGO_MODE})`);

    if (!evt.isPaid) {
      res.status(200).json({ received: true, ignored: true });
      return;
    }

    // Prefer the metadata paymentId (most precise), then checkout session id.
    const metaPaymentId = evt.metadata?.paymentId as string | undefined;

    const result = await activatePaidPayment({
      paymentId:          metaPaymentId,
      externalCheckoutId: evt.checkoutId ?? undefined,
      provider:           'paymongo',
      paymentMethod:      'qrph',
      webhookEventId:     evt.eventId,
      reportedAmount:     evt.amountPhp,
      rawMetadata:        { type: req.body?.data?.attributes?.type, checkoutId: evt.checkoutId, paymentId: evt.paymentId },
    });

    if (!result.ok && !result.alreadyProcessed) {
      console.error('[PayMongo Webhook] activation failed:', result.reason);
    }
    // Always 200 so PayMongo does not retry-storm; duplicates are handled idempotently.
    res.status(200).json({ received: true, activated: result.ok, duplicate: result.alreadyProcessed });
  } catch (e: any) {
    console.error('[PayMongo Webhook] error:', e.message);
    res.status(200).json({ received: true, error: e.message });
  }
});

export default router;
