/**
 * auth.ts — Custom email OTP verification (pure code, no Supabase, no DB).
 *
 * Sends via Brevo's HTTPS API (Railway blocks SMTP ports, so Gmail/nodemailer
 * times out — an HTTP API on port 443 works fine).
 *
 * Flow: send-otp → user receives a 6-digit code → verify-otp.
 * The mobile app only calls supabase.auth.signUp AFTER the code is verified.
 *
 * Env: BREVO_API_KEY (required), EMAIL_FROM or GMAIL_USER (verified Brevo sender),
 *      EMAIL_ASSET_BASE (optional, for logo URLs).
 */

import { Router, Request, Response } from 'express';
import axios from 'axios';

const router = Router();

// ─── In-memory OTP store ──────────────────────────────────────────────────────
interface OtpEntry { code: string; expiresAt: number; attempts: number; lastSentAt: number; verified: boolean; }
const otpStore = new Map<string, OtpEntry>();

const CODE_TTL_MS     = 10 * 60 * 1000; // code valid 10 minutes
const RESEND_COOLDOWN = 60 * 1000;      // 60s between sends
const MAX_ATTEMPTS    = 5;
const VERIFIED_TTL_MS = 30 * 60 * 1000; // verified flag valid 30 min (time to finish signup)

// Periodic cleanup so the map never grows unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of otpStore) {
    if (now > v.expiresAt && now > v.lastSentAt + VERIFIED_TTL_MS) otpStore.delete(k);
  }
}, 5 * 60 * 1000).unref?.();

function normalizeEmail(e: string): string { return e.trim().toLowerCase(); }
function genCode(): string { return String(Math.floor(100000 + Math.random() * 900000)); }
function isValidEmail(e: string): boolean { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }

// ─── Email sender (Brevo HTTPS API) ───────────────────────────────────────────
const SENDER_EMAIL = process.env.EMAIL_FROM || process.env.GMAIL_USER || 'siguradobuygenlinked@gmail.com';
const SENDER_NAME  = 'SiguradoBuy';

async function sendOtpEmail(to: string, code: string): Promise<void> {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) throw new Error('BREVO_API_KEY not set');

  await axios.post(
    'https://api.brevo.com/v3/smtp/email',
    {
      sender:      { name: SENDER_NAME, email: SENDER_EMAIL },
      to:          [{ email: to }],
      subject:     `Your SiguradoBuy code is ${code}`,
      htmlContent: emailHtml(code),
      textContent: `Your SiguradoBuy verification code is ${code}. It expires in 10 minutes.`,
    },
    {
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json', 'accept': 'application/json' },
      timeout: 15000,
    },
  );
}

// ─── Styled HTML email (light theme, gold accents, logos + Genlinked footer) ──
function emailHtml(code: string): string {
  const assetBase = process.env.EMAIL_ASSET_BASE || 'https://siguradobuy-production.up.railway.app';
  const year = new Date().getFullYear();
  return `<!DOCTYPE html>
<html lang="en">
<body style="margin:0;padding:0;background:#F4F5F7;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F5F7;padding:32px 0;">
    <tr><td align="center">
      <table role="presentation" width="500" cellpadding="0" cellspacing="0" style="max-width:500px;width:100%;background:#FFFFFF;border-radius:16px;overflow:hidden;border:1px solid #E5E7EB;box-shadow:0 1px 3px rgba(0,0,0,0.06);">

        <!-- Gold brand bar -->
        <tr><td style="height:5px;line-height:5px;font-size:0;background:#D4AF37;">&nbsp;</td></tr>

        <!-- Logo -->
        <tr><td align="center" style="padding:32px 32px 8px;">
          <img src="${assetBase}/siguradobuy-logo.png" alt="SiguradoBuy" width="180"
               style="display:block;max-width:180px;height:auto;border:0;" />
        </td></tr>

        <!-- Title + intro -->
        <tr><td align="center" style="padding:8px 36px 0;">
          <h1 style="margin:0;color:#111827;font-family:Arial,Helvetica,sans-serif;font-size:22px;font-weight:bold;">Verify your email address</h1>
          <p style="margin:14px 0 0;color:#4B5563;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:22px;">
            Thanks for joining <strong style="color:#111827;">SiguradoBuy</strong> — your buddy for checking if an online
            seller or product is safe <em>before</em> you pay. To finish setting up your account and confirm this email
            is really yours, just enter the 6-digit code below in the app:
          </p>
        </td></tr>

        <!-- Code -->
        <tr><td align="center" style="padding:26px 36px;">
          <div style="background:#FFF8E7;border:1px solid #D4AF37;border-radius:12px;padding:18px 28px;display:inline-block;">
            <span style="color:#9A7B12;font-family:'Courier New',Courier,monospace;font-size:36px;font-weight:bold;letter-spacing:12px;">${code}</span>
          </div>
        </td></tr>

        <!-- Expiry + security -->
        <tr><td align="center" style="padding:0 36px 28px;">
          <p style="margin:0 0 10px;color:#6B7280;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:20px;">
            This code is valid for <strong>10 minutes</strong>. For your safety, never share it with anyone —
            the SiguradoBuy team will <strong>never</strong> ask you for this code.
          </p>
          <p style="margin:0;color:#9CA3AF;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;">
            Didn't try to sign up? You can safely ignore this email — no account will be created without this code.
          </p>
        </td></tr>

        <!-- Divider -->
        <tr><td style="padding:0 36px;"><div style="height:1px;line-height:1px;font-size:0;background:#E5E7EB;">&nbsp;</div></td></tr>

        <!-- Footer: Powered by Genlinked -->
        <tr><td align="center" style="padding:24px 36px 30px;">
          <p style="margin:0 0 10px;color:#9CA3AF;font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:1px;">POWERED BY</p>
          <img src="${assetBase}/genlinked-logo.png" alt="Genlinked" width="120"
               style="display:block;margin:0 auto;max-width:120px;height:auto;border:0;" />
          <p style="margin:18px 0 0;color:#9CA3AF;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:17px;">
            SiguradoBuy helps Filipino shoppers spot online scams before paying.
          </p>
          <p style="margin:6px 0 0;color:#B0B6C0;font-family:Arial,Helvetica,sans-serif;font-size:10px;line-height:15px;">
            © ${year} SiguradoBuy · Sure before you buy.
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ─── POST /api/auth/send-otp ──────────────────────────────────────────────────
router.post('/send-otp', async (req: Request, res: Response): Promise<void> => {
  const email = normalizeEmail(String(req.body?.email ?? ''));
  if (!isValidEmail(email)) { res.status(400).json({ error: 'Please enter a valid email address.' }); return; }

  const now = Date.now();
  const existing = otpStore.get(email);
  if (existing && now - existing.lastSentAt < RESEND_COOLDOWN) {
    const wait = Math.ceil((RESEND_COOLDOWN - (now - existing.lastSentAt)) / 1000);
    res.status(429).json({ error: `Please wait ${wait}s before requesting another code.` });
    return;
  }

  if (!process.env.BREVO_API_KEY) {
    console.error('[OTP] BREVO_API_KEY not set');
    res.status(500).json({ error: 'Email service is not configured yet. Please try again later.' });
    return;
  }

  const code = genCode();
  otpStore.set(email, { code, expiresAt: now + CODE_TTL_MS, attempts: 0, lastSentAt: now, verified: false });

  try {
    await sendOtpEmail(email, code);
    console.log(`[OTP] sent to ${email}`);
    res.json({ success: true, message: 'Verification code sent.' });
  } catch (e: any) {
    const detail = e?.response?.data ? JSON.stringify(e.response.data) : (e?.message ?? 'unknown');
    console.error('[OTP] send failed:', detail);
    otpStore.delete(email);
    res.status(500).json({ error: 'Could not send the verification email. Check the address and try again.' });
  }
});

// ─── POST /api/auth/verify-otp ────────────────────────────────────────────────
router.post('/verify-otp', (req: Request, res: Response): void => {
  const email = normalizeEmail(String(req.body?.email ?? ''));
  const code  = String(req.body?.code ?? '').trim();
  const entry = otpStore.get(email);

  if (!entry) { res.status(400).json({ error: 'No code found. Please request a new one.' }); return; }
  if (Date.now() > entry.expiresAt && !entry.verified) {
    otpStore.delete(email);
    res.status(400).json({ error: 'Code expired. Please request a new one.' });
    return;
  }
  if (entry.attempts >= MAX_ATTEMPTS) {
    otpStore.delete(email);
    res.status(429).json({ error: 'Too many attempts. Please request a new code.' });
    return;
  }

  entry.attempts++;
  if (code !== entry.code) {
    res.status(400).json({ error: 'Incorrect code. Please try again.', attemptsLeft: MAX_ATTEMPTS - entry.attempts });
    return;
  }

  entry.verified = true;
  entry.expiresAt = Date.now() + VERIFIED_TTL_MS;
  res.json({ success: true, verified: true });
});

// ─── GET /api/auth/is-verified?email= ─────────────────────────────────────────
router.get('/is-verified', (req: Request, res: Response): void => {
  const email = normalizeEmail(String(req.query?.email ?? ''));
  const entry = otpStore.get(email);
  res.json({ verified: !!(entry?.verified && Date.now() < entry.expiresAt) });
});

export default router;
