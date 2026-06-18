/**
 * auth.ts — Custom email OTP verification (pure code, no Supabase, no DB).
 *
 * Flow: send-otp → user receives a 6-digit code → verify-otp.
 * The mobile app only calls supabase.auth.signUp AFTER the code is verified,
 * so fake/typo emails never become accounts.
 *
 * Codes live in memory (short-lived). Needs GMAIL_USER + GMAIL_APP_PASSWORD env.
 * Logos are served from api/public (EMAIL_ASSET_BASE overrides the base URL).
 */

import { Router, Request, Response } from 'express';
import nodemailer from 'nodemailer';

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

// ─── Gmail transporter (lazy) ─────────────────────────────────────────────────
let transporter: nodemailer.Transporter | null = null;
function getTransporter(): nodemailer.Transporter | null {
  if (transporter) return transporter;
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) return null;
  transporter = nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
  return transporter;
}

// ─── Styled HTML email (logo header + Powered by Genlinked footer) ────────────
function emailHtml(code: string): string {
  // Logos are served from the API's public folder. Override with EMAIL_ASSET_BASE if needed.
  const assetBase = process.env.EMAIL_ASSET_BASE || 'https://siguradobuy-production.up.railway.app';
  const year = new Date().getFullYear();
  return `<!DOCTYPE html>
<html lang="en">
<body style="margin:0;padding:0;background:#F3F4F6;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F3F4F6;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:#0A0A0A;border-radius:16px;overflow:hidden;border:1px solid #1F2937;">

        <!-- Logo -->
        <tr><td align="center" style="padding:32px 24px 4px;">
          <img src="${assetBase}/siguradobuy-logo.png" alt="SiguradoBuy" width="170"
               style="display:block;max-width:170px;height:auto;border:0;" />
        </td></tr>

        <!-- Title -->
        <tr><td align="center" style="padding:12px 32px 0;">
          <p style="margin:0;color:#FFFFFF;font-family:Arial,Helvetica,sans-serif;font-size:19px;font-weight:bold;">Verify your email</p>
          <p style="margin:8px 0 0;color:#9CA3AF;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:21px;">
            Enter this code in the SiguradoBuy app to finish creating your account.
          </p>
        </td></tr>

        <!-- Code -->
        <tr><td align="center" style="padding:24px 32px;">
          <div style="background:#111827;border:1px solid #D4AF3740;border-radius:12px;padding:18px 26px;display:inline-block;">
            <span style="color:#D4AF37;font-family:'Courier New',Courier,monospace;font-size:34px;font-weight:bold;letter-spacing:10px;">${code}</span>
          </div>
        </td></tr>

        <!-- Expiry / security -->
        <tr><td align="center" style="padding:0 32px 26px;">
          <p style="margin:0;color:#6B7280;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;">
            This code expires in 10 minutes.<br/>If you didn't request it, you can safely ignore this email.
          </p>
        </td></tr>

        <!-- Divider -->
        <tr><td style="padding:0 32px;"><div style="height:1px;line-height:1px;font-size:0;background:#1F2937;">&nbsp;</div></td></tr>

        <!-- Footer: Powered by Genlinked -->
        <tr><td align="center" style="padding:22px 32px 30px;">
          <p style="margin:0 0 8px;color:#4B5563;font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:0.5px;">POWERED BY</p>
          <img src="${assetBase}/genlinked-logo.png" alt="Genlinked" width="120"
               style="display:block;margin:0 auto;max-width:120px;height:auto;border:0;" />
          <p style="margin:16px 0 0;color:#374151;font-family:Arial,Helvetica,sans-serif;font-size:10px;line-height:15px;">
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

  const transport = getTransporter();
  if (!transport) {
    console.error('[OTP] GMAIL_USER / GMAIL_APP_PASSWORD not set');
    res.status(500).json({ error: 'Email service is not configured yet. Please try again later.' });
    return;
  }

  const code = genCode();
  otpStore.set(email, { code, expiresAt: now + CODE_TTL_MS, attempts: 0, lastSentAt: now, verified: false });

  try {
    await transport.sendMail({
      from: `"SiguradoBuy" <${process.env.GMAIL_USER}>`,
      to: email,
      subject: `Your SiguradoBuy code is ${code}`,
      text: `Your SiguradoBuy verification code is ${code}. It expires in 10 minutes.`,
      html: emailHtml(code),
    });
    console.log(`[OTP] sent to ${email}`);
    res.json({ success: true, message: 'Verification code sent.' });
  } catch (e: any) {
    console.error('[OTP] send failed:', e?.message);
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
  entry.expiresAt = Date.now() + VERIFIED_TTL_MS; // keep "verified" alive long enough to finish signup
  res.json({ success: true, verified: true });
});

// ─── GET /api/auth/is-verified?email= ─────────────────────────────────────────
router.get('/is-verified', (req: Request, res: Response): void => {
  const email = normalizeEmail(String(req.query?.email ?? ''));
  const entry = otpStore.get(email);
  res.json({ verified: !!(entry?.verified && Date.now() < entry.expiresAt) });
});

export default router;
