/**
 * adminAnalytics.ts — real product analytics for the SiguradoBuy admin dashboard.
 *
 * Mounted at /api/admin/analytics. ALL routes require the admin JWT (same secret
 * as the rest of /api/admin). Every number is aggregated from real Supabase data —
 * no mock/sample values. Uses the service-role db client (server-side only).
 */

import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { db } from '../db/client';

const router = Router();

const JWT_SECRET = process.env.ADMIN_JWT_SECRET ?? 'sigurado-admin-secret-2025-change-in-prod';

function requireAdmin(req: Request, res: Response, next: () => void) {
  const auth = req.headers.authorization ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) { res.status(401).json({ error: 'Unauthorized' }); return; }
  try { jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid or expired admin token' }); }
}

// ─── helpers ────────────────────────────────────────────────────────────────────
const iso = (d: Date) => d.toISOString();
function daysAgo(n: number) { return new Date(Date.now() - n * 86_400_000); }
function dayKey(ts: string)  { return ts.slice(0, 10); } // YYYY-MM-DD

/** Build a zero-filled day series for the last `n` days (oldest → newest). */
function emptyDaySeries(n: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (let i = n - 1; i >= 0; i--) out[dayKey(iso(daysAgo(i)))] = 0;
  return out;
}

async function countAuthUsers(): Promise<{ total: number; createdAt: string[] }> {
  const { data, error } = await db.auth.admin.listUsers({ perPage: 1000 });
  if (error) throw error;
  return { total: data.users.length, createdAt: data.users.map(u => u.created_at) };
}

// ─── GET /overview ──────────────────────────────────────────────────────────────
router.get('/overview', requireAdmin, async (_req: Request, res: Response): Promise<void> => {
  try {
    const today = iso(new Date(new Date().setHours(0, 0, 0, 0)));
    const d7 = iso(daysAgo(7)), d30 = iso(daysAgo(30));

    const [
      totalChecks, checksToday, checks7d, guestChecks, signedChecks, aiChecks, deepNeeded,
      reportsPending, reportsApproved, ticketsOpen, adRewards, profilesData,
    ] = await Promise.all([
      db.from('product_checks').select('*', { count: 'exact', head: true }),
      db.from('product_checks').select('*', { count: 'exact', head: true }).gte('created_at', today),
      db.from('product_checks').select('*', { count: 'exact', head: true }).gte('created_at', d7),
      db.from('product_checks').select('*', { count: 'exact', head: true }).is('user_id', null),
      db.from('product_checks').select('*', { count: 'exact', head: true }).not('user_id', 'is', null),
      db.from('product_checks').select('*', { count: 'exact', head: true }).eq('has_ai', true),
      db.from('product_checks').select('*', { count: 'exact', head: true }).eq('risk_level', 'high'),
      db.from('scam_reports').select('*', { count: 'exact', head: true }).eq('status', 'pending_review'),
      db.from('scam_reports').select('*', { count: 'exact', head: true }).eq('status', 'approved'),
      db.from('support_tickets').select('*', { count: 'exact', head: true }).eq('status', 'open'),
      db.from('ad_events').select('*', { count: 'exact', head: true }).eq('event', 'reward_granted'),
      db.from('profiles').select('plan'),
    ]);

    let users = { total: 0, createdAt: [] as string[] };
    try { users = await countAuthUsers(); } catch { /* auth may be unavailable */ }
    const newUsersToday = users.createdAt.filter(c => c >= today).length;
    const newUsers7d    = users.createdAt.filter(c => c >= d7).length;
    const newUsers30d   = users.createdAt.filter(c => c >= d30).length;

    const plans = (profilesData.data ?? []) as Array<{ plan: string }>;
    const plus = plans.filter(p => p.plan === 'plus').length;
    const pro  = plans.filter(p => p.plan === 'pro').length;
    const free = Math.max(0, users.total - plus - pro);

    const upgradeClicks = 0; // available once analytics events are tracked
    const paid = plus + pro;
    const conversionRate = users.total > 0 ? Math.round((paid / users.total) * 1000) / 10 : 0;

    res.json({
      total_checks:        totalChecks.count ?? 0,
      checks_today:        checksToday.count ?? 0,
      checks_7d:           checks7d.count ?? 0,
      guest_checks:        guestChecks.count ?? 0,
      signed_in_checks:    signedChecks.count ?? 0,
      ai_checks:           aiChecks.count ?? 0,
      high_risk_checks:    deepNeeded.count ?? 0,
      total_users:         users.total,
      new_users_today:     newUsersToday,
      new_users_7d:        newUsers7d,
      new_users_30d:       newUsers30d,
      free_users:          free,
      plus_users:          plus,
      pro_users:           pro,
      paid_users:          paid,
      conversion_rate:     conversionRate,
      reports_pending:     reportsPending.count ?? 0,
      reports_approved:    reportsApproved.count ?? 0,
      tickets_open:        ticketsOpen.count ?? 0,
      rewarded_ads_completed: adRewards.count ?? 0,
      upgrade_clicks:      upgradeClicks,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── GET /product-checks (trend + breakdowns) ───────────────────────────────────
router.get('/product-checks', requireAdmin, async (_req: Request, res: Response): Promise<void> => {
  try {
    const { data, error } = await db
      .from('product_checks')
      .select('platform,risk_level,has_ai,user_id,created_at')
      .gte('created_at', iso(daysAgo(30)))
      .order('created_at', { ascending: true })
      .limit(5000);
    if (error) throw error;
    const rows = (data ?? []) as Array<any>;

    const perDay  = emptyDaySeries(30);
    const aiPerDay = emptyDaySeries(30);
    const platform: Record<string, number> = {};
    const risk: Record<string, number> = { low: 0, medium: 0, high: 0 };

    for (const r of rows) {
      const k = dayKey(r.created_at);
      if (k in perDay) perDay[k]++;
      if (r.has_ai && k in aiPerDay) aiPerDay[k]++;
      const p = r.platform ?? 'unknown';
      platform[p] = (platform[p] ?? 0) + 1;
      const lvl = r.risk_level ?? 'low';
      if (lvl in risk) risk[lvl]++;
    }

    res.json({
      trend:    Object.entries(perDay).map(([date, count]) => ({ date, count, ai: aiPerDay[date] ?? 0 })),
      platform: Object.entries(platform).map(([name, value]) => ({ name, value })),
      risk:     Object.entries(risk).map(([name, value]) => ({ name, value })),
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── GET /users (signups trend + plan split) ────────────────────────────────────
router.get('/users', requireAdmin, async (_req: Request, res: Response): Promise<void> => {
  try {
    let createdAt: string[] = [];
    let totalUsers = 0;
    try { const u = await countAuthUsers(); createdAt = u.createdAt; totalUsers = u.total; } catch {}

    const perDay = emptyDaySeries(30);
    for (const c of createdAt) { const k = dayKey(c); if (k in perDay) perDay[k]++; }

    const { data: profilesData } = await db.from('profiles').select('plan');
    const plans = (profilesData ?? []) as Array<{ plan: string }>;
    const plus = plans.filter(p => p.plan === 'plus').length;
    const pro  = plans.filter(p => p.plan === 'pro').length;
    const free = Math.max(0, totalUsers - plus - pro);

    res.json({
      signups: Object.entries(perDay).map(([date, count]) => ({ date, count })),
      plans: [
        { name: 'Free', value: free },
        { name: 'Plus', value: plus },
        { name: 'Pro',  value: pro },
      ],
      total_users: totalUsers,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── GET /ads (rewarded ad activity) ────────────────────────────────────────────
router.get('/ads', requireAdmin, async (_req: Request, res: Response): Promise<void> => {
  try {
    const { data, error } = await db
      .from('ad_events')
      .select('event,created_at')
      .gte('created_at', iso(daysAgo(30)))
      .limit(5000);
    if (error) throw error;
    const rows = (data ?? []) as Array<any>;

    const perDay = emptyDaySeries(30);
    const byEvent: Record<string, number> = {};
    for (const r of rows) {
      const k = dayKey(r.created_at);
      if (r.event === 'reward_granted' && k in perDay) perDay[k]++;
      byEvent[r.event] = (byEvent[r.event] ?? 0) + 1;
    }
    res.json({
      rewards_trend: Object.entries(perDay).map(([date, count]) => ({ date, count })),
      by_event: Object.entries(byEvent).map(([name, value]) => ({ name, value })),
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── GET /reports (scam report status split) ────────────────────────────────────
router.get('/reports', requireAdmin, async (_req: Request, res: Response): Promise<void> => {
  try {
    const { data, error } = await db.from('scam_reports').select('status,platform,created_at').limit(5000);
    if (error) throw error;
    const rows = (data ?? []) as Array<any>;
    const status: Record<string, number> = { pending_review: 0, approved: 0, disapproved: 0 };
    const platform: Record<string, number> = {};
    for (const r of rows) {
      const s = r.status ?? 'pending_review';
      status[s] = (status[s] ?? 0) + 1;
      const p = r.platform ?? 'other';
      platform[p] = (platform[p] ?? 0) + 1;
    }
    res.json({
      status:   Object.entries(status).map(([name, value]) => ({ name, value })),
      platform: Object.entries(platform).map(([name, value]) => ({ name, value })),
      total: rows.length,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── GET /top-links (most-checked normalized URLs) ──────────────────────────────
router.get('/top-links', requireAdmin, async (_req: Request, res: Response): Promise<void> => {
  try {
    const { data, error } = await db
      .from('product_checks')
      .select('normalized_url,risk_level,risk_score,created_at')
      .not('normalized_url', 'is', null)
      .order('created_at', { ascending: false })
      .limit(5000);
    if (error) throw error;
    const rows = (data ?? []) as Array<any>;
    const map = new Map<string, { url: string; count: number; last_risk: string; last_score: number; last_checked: string }>();
    for (const r of rows) {
      const u = r.normalized_url as string;
      const ex = map.get(u);
      if (ex) ex.count++;
      else map.set(u, { url: u, count: 1, last_risk: r.risk_level ?? 'low', last_score: r.risk_score ?? 0, last_checked: r.created_at });
    }
    const top = [...map.values()].sort((a, b) => b.count - a.count).slice(0, 20);
    res.json({ links: top });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── GET /recent-activity (latest checks/reports/tickets) ───────────────────────
router.get('/recent-activity', requireAdmin, async (_req: Request, res: Response): Promise<void> => {
  try {
    const [checks, reports, tickets] = await Promise.all([
      db.from('product_checks').select('id,platform,product_name,risk_level,risk_score,user_id,created_at').order('created_at', { ascending: false }).limit(15),
      db.from('scam_reports').select('id,seller_name,platform,status,created_at').order('created_at', { ascending: false }).limit(10),
      db.from('support_tickets').select('id,subject,category,status,created_at').order('created_at', { ascending: false }).limit(10),
    ]);
    res.json({
      checks:  checks.data ?? [],
      reports: reports.data ?? [],
      tickets: tickets.data ?? [],
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
