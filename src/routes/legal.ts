import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';

const router = Router();

// ─── GET /app-ads.txt — plain text (NOT HTML), for Appodeal authorized sellers ──
const APP_ADS_FALLBACK = [
  '#Appodeal',
  'appodeal.com, 264393, DIRECT',
  '#Google AdMob',
  'google.com, pub-8086500041326014, DIRECT, f08c47fec0942fa0',
  '#BidMachine',
  'bidmachine.io,1,DIRECT',
  'bidmachine.io,466,DIRECT',
  'bidmachine.io, 200, DIRECT',
  '#Unity',
  'unity.com, 125194720, DIRECT, 96cabb5fbdde37a7',
  '',
].join('\n');

router.get('/app-ads.txt', (_req: Request, res: Response) => {
  res.set('Content-Type', 'text/plain; charset=utf-8');
  // Prefer the full hosted file (public/app-ads.txt); fall back to essential lines.
  const candidates = [
    path.join(__dirname, '../../public/app-ads.txt'),
    path.join(__dirname, '../public/app-ads.txt'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) { res.send(fs.readFileSync(p, 'utf8')); return; }
    } catch { /* try next */ }
  }
  res.send(APP_ADS_FALLBACK);
});

const UPDATED = 'June 10, 2026';

// ─── Shared responsive black/gold page shell ────────────────────────────────────
function page(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>${title} — SiguradoBuy</title>
  <style>
    :root{--bg:#0A0A0A;--panel:#111827;--border:#1F2937;--gold:#D4AF37;--text:#F8F8F8;--muted:#9CA3AF}
    *{box-sizing:border-box}
    body{margin:0;background:var(--bg);color:var(--text);
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Inter,system-ui,sans-serif;
      line-height:1.65;-webkit-text-size-adjust:100%}
    .wrap{max-width:820px;margin:0 auto;padding:32px 20px 64px;
      padding-top:max(32px,env(safe-area-inset-top));
      padding-bottom:max(64px,env(safe-area-inset-bottom))}
    header{display:flex;flex-direction:column;align-items:center;text-align:center;
      border-bottom:1px solid var(--border);padding-bottom:24px;margin-bottom:28px}
    .logo-img{width:min(280px,72vw);height:auto;display:block;margin-bottom:6px}
    h1{font-size:clamp(24px,5vw,32px);margin:0 0 6px;font-weight:900}
    .updated{color:var(--muted);font-size:13px;margin-bottom:28px}
    h2{color:var(--gold);font-size:clamp(16px,3.5vw,19px);margin:30px 0 8px;font-weight:700}
    p,li{color:#D1D5DB;font-size:15px}
    ul{padding-left:20px}
    a{color:var(--gold)}
    .card{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:18px 20px;margin-top:24px}
    footer{margin-top:40px;border-top:1px solid var(--border);padding-top:20px;color:var(--muted);font-size:13px;text-align:center}
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <img class="logo-img" src="/buy1.png" alt="SiguradoBuy" />
    </header>
    <h1>${title}</h1>
    <div class="updated">Last updated: ${UPDATED}</div>
    ${bodyHtml}
    <footer>
      SiguradoBuy — Sure Before You Buy<br/>
      Questions? Contact us through the in-app Support tab.
    </footer>
  </div>
</body>
</html>`;
}

// ─── GET /privacy ───────────────────────────────────────────────────────────────
router.get('/privacy', (_req: Request, res: Response) => {
  const body = `
    <h2>1. Introduction</h2>
    <p>SiguradoBuy ("we", "us") helps Filipino online shoppers assess the risk of products and sellers before buying. This Privacy Policy explains what we collect and how we use it. By using the app you agree to this policy.</p>

    <h2>2. Information We Collect</h2>
    <ul>
      <li>Account info you provide (email address) when you sign in.</li>
      <li>Product links you submit for analysis.</li>
      <li>Product screenshots or images you upload for analysis (if you choose to).</li>
      <li>Scam reports and support tickets you submit.</li>
      <li>A push notification token (if you enable notifications) so we can send the alerts you opted into.</li>
      <li>Basic device and usage data needed to run the app and serve ads.</li>
    </ul>

    <h2>3. How We Use Information</h2>
    <p>To run product risk checks, maintain your check history, operate community scam alerts, provide support, process subscriptions, and improve the service.</p>

    <h2>4. Product Link Analysis</h2>
    <p>When you check a product link, we analyze publicly available signals and our community data to estimate risk. Checked links may be stored to power "checked before" memory and community insights.</p>

    <h2>5. Scam Reports and Community Alerts</h2>
    <p>Reports you submit are reviewed by our team. Approved reports may be shown publicly (without exposing your identity) to warn other buyers. Disapproved reports stay hidden.</p>

    <h2>6. Account and Billing Information</h2>
    <p>Subscription and payment processing for paid plans is handled by <strong>PayPal</strong> and <strong>PayMongo</strong>. We do not store your full card details. We store your plan status to unlock features.</p>

    <h2>7. Ads and Rewarded Ads</h2>
    <p>Free users may watch rewarded ads for extra checks. Ads are served through <strong>Appodeal</strong> mediation and its advertising partners (including <strong>Unity Ads</strong> and <strong>Google AdMob</strong>). These partners may collect device identifiers and ad-interaction data to deliver and measure ads, subject to their own policies.</p>

    <h2>8. Push Notifications</h2>
    <p>If you enable notifications, we collect a push notification token to deliver the alerts you opt into (scam alerts, support replies, and billing updates). Notifications are sent via the <strong>Expo</strong> push service. You can turn each notification type on or off in the app's Settings, and you can disable notifications entirely in your device settings. We do not send notifications for categories you have turned off.</p>

    <h2>9. Third-Party Services</h2>
    <p>We use third-party providers to operate the app, which may process limited data: <strong>Supabase</strong> (database/auth), <strong>Railway</strong> (backend hosting), <strong>Appodeal / Unity Ads / Google AdMob</strong> (ads), <strong>PayPal / PayMongo</strong> (payments), <strong>Expo</strong> (push notification delivery), and an AI provider for risk explanations. We share only what is necessary for these services to function.</p>

    <h2>10. Data Security and Retention</h2>
    <p>We use industry-standard measures (encryption in transit, access controls) to protect your data. We retain your data for as long as your account is active or as needed to provide the service, and remove it on account deletion except where we must keep records for legal or accounting reasons. No method is 100% secure, but we work to keep your information safe.</p>

    <h2>11. User Choices and Account Deletion</h2>
    <p>You can use the app as a guest with limited features, and manage notifications in Settings. To delete your account and associated data, open <strong>Settings → Delete Account</strong> or submit a support ticket; we process deletion requests within a reasonable period and remove your personal data except records we are legally required to retain. You may stop using the app at any time.</p>

    <h2>12. Contact / Support</h2>
    <p>For privacy questions or to request account deletion, use the in-app Support tab to reach our team.</p>

    <div class="card">
      <strong>Honest note:</strong> SiguradoBuy provides risk estimates only. We do not sell your personal data, but ad and payment partners listed above do process data needed to provide their services.
    </div>`;
  res.set('Content-Type', 'text/html; charset=utf-8').send(page('Privacy Policy', body));
});

// ─── GET /terms ─────────────────────────────────────────────────────────────────
router.get('/terms', (_req: Request, res: Response) => {
  const body = `
    <h2>1. Acceptance of Terms</h2>
    <p>By using SiguradoBuy you agree to these Terms of Service. If you do not agree, please do not use the app.</p>

    <h2>2. What SiguradoBuy Does</h2>
    <p>SiguradoBuy analyzes product links and seller signals to give you a risk estimate before you buy, plus community scam alerts.</p>

    <h2>3. No Guarantee / Informational Use Only</h2>
    <p>Our risk scores are <strong>estimates for guidance only</strong>. SiguradoBuy <strong>cannot guarantee</strong> that any product or seller is safe or unsafe. Always use your own judgment before paying.</p>

    <h2>4. User Responsibility</h2>
    <p>You are responsible for your own purchasing decisions. SiguradoBuy is a tool to help you decide — not a substitute for your own due diligence.</p>

    <h2>5. Product Risk Analysis Limitations</h2>
    <p>Analysis is based on available data, which may be incomplete. Results may vary and can be wrong. Limited data means lower confidence, not a guarantee of safety.</p>

    <h2>6. Scam Reports and Community Rules</h2>
    <p>Submit only honest, accurate reports. Do not submit false, malicious, or defamatory reports. We review reports and may reject or remove any content.</p>

    <h2>7. Prohibited Use</h2>
    <ul>
      <li>No abuse, spam, or attempts to manipulate scores or reports.</li>
      <li>No reverse engineering, scraping, or disrupting the service.</li>
      <li>No illegal use.</li>
    </ul>

    <h2>8. Paid Plans and Billing</h2>
    <p>Paid plans (Plus/Pro) are billed via PayPal and renew per the plan terms. The backend is the source of truth for your plan. Cancellation takes effect per your billing period; failed or expired payments may downgrade you to Free.</p>

    <h2>9. Rewarded Ads</h2>
    <p>Free users may watch rewarded ads (served via Appodeal/Unity) to earn extra checks. Ad availability is not guaranteed. Misuse of the ad/reward system is prohibited.</p>

    <h2>10. Account Suspension</h2>
    <p>We may suspend or terminate accounts that violate these Terms or abuse the service.</p>

    <h2>11. Limitation of Liability</h2>
    <p>To the maximum extent permitted by law, SiguradoBuy is not liable for losses arising from purchasing decisions, reliance on risk estimates, or third-party services. The app is provided "as is".</p>

    <h2>12. Changes to Terms</h2>
    <p>We may update these Terms. Continued use after changes means you accept the updated Terms.</p>

    <h2>13. Contact / Support</h2>
    <p>Questions? Reach us through the in-app Support tab.</p>

    <div class="card">
      <strong>Plain-language summary:</strong> SiguradoBuy gives you risk guidance to help you shop safer. It cannot promise a seller is safe or a scam. Always verify before sending money.
    </div>`;
  res.set('Content-Type', 'text/html; charset=utf-8').send(page('Terms of Service', body));
});

// ─── GET /delete-account — Google Play account/data deletion page ─────────────────
function deletionPage(_req: Request, res: Response) {
  const body = `
    <h2>Deleting Your SiguradoBuy Account and Data</h2>
    <p>This page explains how to request deletion of your <strong>SiguradoBuy</strong> account and the data associated with it, in line with Google Play's user data deletion requirements.</p>

    <h2>Option 1 — Delete your entire account (in the app)</h2>
    <ol>
      <li>Open the SiguradoBuy app.</li>
      <li>Go to <strong>Settings → Delete Account</strong>.</li>
      <li>Confirm the request. Our team processes account deletions within <strong>30 days</strong>.</li>
    </ol>

    <h2>Option 2 — Request deletion by email / support</h2>
    <p>You can also request account deletion, or deletion of <strong>specific data</strong> without deleting your whole account (for example, your check history or scam reports), by:</p>
    <ul>
      <li>Using the in-app <strong>Support</strong> tab to submit a request, or</li>
      <li>Emailing us at <strong>siguradobuygenlinked@gmail.com</strong> with the subject "Delete my data" from the email address on your account.</li>
    </ul>
    <p>Please tell us whether you want your entire account deleted, or only specific data removed.</p>

    <h2>What data is deleted</h2>
    <ul>
      <li>Your account and email address</li>
      <li>Your product check history and any product links/images you submitted</li>
      <li>Your scam reports' link to your identity (public anonymized warnings may remain to protect other buyers)</li>
      <li>Your notification preferences and push notification token</li>
      <li>Your app settings and preferences</li>
    </ul>

    <h2>What data may be kept, and for how long</h2>
    <p>We may retain a limited record of <strong>subscription/payment transactions</strong> where we are required to for legal, tax, or accounting purposes. These records are kept only as long as the law requires (typically up to <strong>5 years</strong>) and are not used for any other purpose. Everything else is deleted.</p>

    <div class="card">
      <strong>Need help?</strong> If you have any trouble deleting your account or data, contact us through the in-app Support tab or at siguradobuygenlinked@gmail.com and we will assist you.
    </div>`;
  res.set('Content-Type', 'text/html; charset=utf-8').send(page('Delete Account & Data', body));
}

router.get('/delete-account', deletionPage);
router.get('/delete-data', deletionPage);

export default router;
