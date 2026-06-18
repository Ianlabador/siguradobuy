/**
 * auth.ts — Custom email OTP verification (pure code, no Supabase, no DB).
 *
 * Flow: send-otp → user receives a 6-digit code → verify-otp.
 * The mobile app only calls supabase.auth.signUp AFTER the code is verified,
 * so fake/typo emails never become accounts.
 *
 * Codes live in memory (short-lived). Needs GMAIL_USER + GMAIL_APP_PASSWORD env.
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

function emailHtml(code: string): string {
  return `
  <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px;background:#0A0A0A;border-radius:12px;color:#fff">
    <h2 style="color:#D4AF37;margin:0 0 8px">SiguradoBuy</h2>
    <p style="color:#D1D5DB;font-size:14px;margin:0 0 16px">Use this code to verify your email:</p>
    <div style="font-size:32px;font-weight:800;letter-spacing:8px;color:#D4AF37;background:#111827;padding:16px;border-radius:10px;text-align:center">${code}</div>
    <p style="color:#9CA3AF;font-size:12px;margin:16px 0 0">This code expires in 10 minutes. If you didn't request it, ignore this email.</p>
  </div>`;
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
