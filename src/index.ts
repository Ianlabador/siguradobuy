import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import * as dotenv from 'dotenv';
import * as path from 'path';

import { globalRateLimit, checkRateLimit, reportRateLimit, supportRateLimit, analyticsRateLimit } from './middleware/rateLimit';
import checkRouter        from './routes/check';
import reportRouter       from './routes/report';
import sellerRouter       from './routes/seller';
import ticketsRouter      from './routes/tickets';
import subscriptionRouter from './routes/subscription';
import adminRouter        from './routes/admin';
import adminAnalyticsRouter from './routes/adminAnalytics';
import analyticsRouter    from './routes/analytics';
import paypalRouter       from './routes/paypal';
import billingRouter      from './routes/billing';
import paymongoRouter     from './routes/paymongo';
import aiRouter           from './routes/ai';
import legalRouter        from './routes/legal';

dotenv.config();

const app  = express();
const PORT = parseInt(process.env.PORT ?? '3000', 10);

app.use(helmet());

// Trust Railway's reverse proxy so express-rate-limit reads the real client IP
// from X-Forwarded-For instead of the internal proxy IP.
app.set('trust proxy', 1);

// CORS — mobile native apps don't need CORS, only web clients (admin portal) do.
// Set CORS_ORIGINS env var to a comma-separated list for production, e.g.:
//   https://admin.siguradobuy.app,https://siguradobuy.app
const allowedOrigins: string | string[] = (() => {
  if (process.env.CORS_ORIGINS) return process.env.CORS_ORIGINS.split(',').map(s => s.trim());
  if (process.env.NODE_ENV === 'production') return ['https://siguradobuy.app', 'https://app.siguradobuy.app'];
  return '*';
})();

app.use(cors({ origin: allowedOrigins, credentials: true }));
// Capture the raw request body so webhook signatures (PayMongo HMAC) can be
// verified against the exact bytes received, while still parsing JSON normally.
app.use(express.json({
  limit: '10mb',
  verify: (req, _res, buf) => { (req as any).rawBody = buf; },
}));
app.use(express.urlencoded({ extended: true }));
app.use(globalRateLimit);

// Health
app.get('/health', (_req, res) => {
  res.json({
    status:    'ok',
    version:   '2.0.0',
    app:       'SiguradoBuy API',
    timestamp: new Date().toISOString(),
    supabase:  !!process.env.SUPABASE_URL,
    ai:        !!process.env.OPENAI_API_KEY,
    aiProvider: 'openai',
    billing:   (!!process.env.PAYPAL_CLIENT_ID && !!process.env.PAYPAL_CLIENT_SECRET) || !!process.env.PAYMONGO_SECRET_KEY,
  });
});

// Routes
app.use('/api/check',        checkRateLimit,  checkRouter);
app.use('/api/report',       reportRateLimit, reportRouter);
app.use('/api/seller',                        sellerRouter);
app.use('/api/tickets',       supportRateLimit, ticketsRouter);
app.use('/api/subscription',                  subscriptionRouter);
app.use('/api/admin/analytics',               adminAnalyticsRouter);
app.use('/api/admin',                         adminRouter);
app.use('/api/analytics',     analyticsRateLimit, analyticsRouter);
app.use('/api/paypal',                        paypalRouter);
app.use('/api/billing',                       billingRouter);
app.use('/api/paymongo',                      paymongoRouter);
app.use('/api/ai',                            aiRouter);

// Static public assets (logo for legal pages, etc.)
app.use(express.static(path.join(__dirname, '../../public')));
app.use(express.static(path.join(__dirname, '../public')));

// Public legal pages (branded HTML) — /privacy and /terms
app.use('/',                                  legalRouter);

// Serve admin portal from /admin — works when API is hosted on Railway
app.use('/admin', express.static(path.join(__dirname, '../../admin')));

// 404
app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Global error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[Error]', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  const serviceKey  = process.env.SUPABASE_SERVICE_KEY;
  const openaiKey   = process.env.OPENAI_API_KEY;   // this app's AI provider
  const paypalReady = !!process.env.PAYPAL_CLIENT_ID && !!process.env.PAYPAL_CLIENT_SECRET;
  const paymongoReady = !!process.env.PAYMONGO_SECRET_KEY;
  console.log(`
╔════════════════════════════════════════════╗
║   SiguradoBuy API v2.0
║   Port:         ${PORT}
║   Supabase:     ${process.env.SUPABASE_URL ? '✓ connected' : '✗ missing URL'}
║   Service key:  ${serviceKey ? '✓ set' : '✗ missing (using anon)'}
║   OpenAI:       ${openaiKey ? '✓ configured (gpt-4o-mini)' : '✗ missing OPENAI_API_KEY'}
║   PayPal:       ${paypalReady ? '✓ configured' : '✗ not configured'}
║   PayMongo:     ${paymongoReady ? '✓ configured' : 'static QR fallback (no key)'}
╚════════════════════════════════════════════╝
  `);
});

export default app;
