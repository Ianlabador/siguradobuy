import { Router, Request, Response } from 'express';

const router = Router();

const UPDATED = 'May 30, 2026';

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
      <li>Scam reports and support tickets you submit.</li>
      <li>Basic device and usage data needed to run the app and serve ads.</li>
    </ul>

    <h2>3. How We Use Information</h2>
    <p>To run product risk checks, maintain your check history, operate community scam alerts, provide support, process subscriptions, and improve the service.</p>

    <h2>4. Product Link Analysis</h2>
    <p>When you check a product link, we analyze publicly available signals and our community data to estimate risk. Checked links may be stored to power "checked before" memory and community insights.</p>

    <h2>5. Scam Reports and Community Alerts</h2>
    <p>Reports you submit are reviewed by our team. Approved reports may be shown publicly (without exposing your identity) to warn other buyers. Disapproved reports stay hidden.</p>

    <h2>6. Account and Billing Information</h2>
    <p>Subscription and payment processing for paid plans is handled by <strong>PayPal</strong>. We do not store your full card details. We store your plan status to unlock features.</p>

    <h2>7. Ads and Rewarded Ads</h2>
    <p>Free users may watch rewarded ads for extra checks. Ads are served through <strong>Appodeal</strong> mediation and its advertising partners (including <strong>Unity Ads</strong>). These partners may collect device identifiers and ad-interaction data to deliver and measure ads, subject to their own policies.</p>

    <h2>8. Third-Party Services</h2>
    <p>We use third-party providers to operate the app, which may process limited data: <strong>Supabase</strong> (database/auth), <strong>Railway</strong> (backend hosting), <strong>Appodeal/Unity</strong> (ads), <strong>PayPal</strong> (payments), and an AI provider for risk explanations. We share only what is necessary for these services to function.</p>

    <h2>9. Data Security</h2>
    <p>We use industry-standard measures (encryption in transit, access controls) to protect your data. No method is 100% secure, but we work to keep your information safe.</p>

    <h2>10. User Choices</h2>
    <p>You can use the app as a guest with limited features, manage notifications in Settings, and request account deletion via a support ticket. You may stop using the app at any time.</p>

    <h2>11. Contact / Support</h2>
    <p>For privacy questions, use the in-app Support tab to reach our team.</p>

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

export default router;
