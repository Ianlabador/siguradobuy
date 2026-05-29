import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { db } from '../db/client';
import { authRateLimit } from '../middleware/rateLimit';

const router = Router();

const ADMIN_USERNAME = process.env.ADMIN_USERNAME ?? 'SiguradoBuy2025';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'Adminsigurado2026';
const JWT_SECRET     = process.env.ADMIN_JWT_SECRET ?? 'sigurado-admin-secret-2025-change-in-prod';
const TOKEN_TTL      = '8h';

function signAdminToken() {
  return jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

function requireAdmin(req: Request, res: Response, next: () => void) {
  const auth = req.headers.authorization ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) { res.status(401).json({ error: 'Unauthorized' }); return; }
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired admin token' });
  }
}

// ── POST /api/admin/login ─────────────────────────────────────────────────────
// authRateLimit: max 10 failed attempts / 15 min / IP — blunts brute-force.
router.post('/login', authRateLimit, (req: Request, res: Response): void => {
  const { username, password } = req.body ?? {};
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    const token = signAdminToken();

    // Log session (non-blocking)
    void db.from('admin_sessions').insert({ username });

    res.json({ token, expires: TOKEN_TTL });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

// ── GET /api/admin/analytics ──────────────────────────────────────────────────
router.get('/analytics', requireAdmin, async (_req: Request, res: Response): Promise<void> => {
  try {
    const now           = new Date();
    const sevenDaysAgo  = new Date(now.getTime() -  7 * 24 * 60 * 60 * 1000).toISOString();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const oneDayAgo     = new Date(now.getTime() -      24 * 60 * 60 * 1000).toISOString();

    // ── User counts from auth.users (source of truth) ────────────────────────
    const { data: authData, error: authError } = await db.auth.admin.listUsers({ perPage: 1000 });
    if (authError) throw authError;

    const authUsers   = authData.users;
    const totalUsers  = authUsers.length;
    const newUsers7d  = authUsers.filter(u => u.created_at >= sevenDaysAgo).length;
    const newUsers30d = authUsers.filter(u => u.created_at >= thirtyDaysAgo).length;

    // ── Plan breakdown from profiles (optional — zero if table empty) ─────────
    let plusUsers = 0;
    let proUsers  = 0;
    try {
      const { data: profileData } = await db.from('profiles').select('plan');
      plusUsers = (profileData ?? []).filter((p: any) => p.plan === 'plus').length;
      proUsers  = (profileData ?? []).filter((p: any) => p.plan === 'pro').length;
    } catch {
      // profiles unavailable — report 0 for paid plans
    }

    // ── Other counters ────────────────────────────────────────────────────────
    const [checks, reports, tickets, adEvents, aiLogs, checksToday] = await Promise.all([
      db.from('product_checks').select('*', { count: 'exact', head: true }),
      db.from('scam_reports').select('*', { count: 'exact', head: true }),
      db.from('support_tickets').select('status'),
      db.from('ad_events').select('*', { count: 'exact', head: true }),
      db.from('ai_usage_logs').select('*', { count: 'exact', head: true }),
      db.from('product_checks').select('*', { count: 'exact', head: true }).gte('created_at', oneDayAgo),
    ]);

    const ticketData = tickets.data ?? [];

    res.json({
      total_users:         totalUsers,
      new_users_7d:        newUsers7d,
      new_users_30d:       newUsers30d,
      plus_users:          plusUsers,
      pro_users:           proUsers,
      total_checks:        checks.count        ?? 0,
      checks_24h:          checksToday.count   ?? 0,
      total_scam_reports:  reports.count       ?? 0,
      total_tickets:       ticketData.length,
      open_tickets:        ticketData.filter((t: any) => t.status === 'open').length,
      in_progress_tickets: ticketData.filter((t: any) => t.status === 'in_progress').length,
      ad_unlocks_30d:      adEvents.count      ?? 0,
      ai_calls_30d:        aiLogs.count        ?? 0,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/admin/users ──────────────────────────────────────────────────────
// Source of truth: auth.users via listUsers (service key required).
// Optionally merges public.profiles for plan/checks — if profiles is empty,
// auth data alone is returned so the dashboard always shows real users.
router.get('/users', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    const { plan } = req.query;

    // 1. Fetch all auth users (up to 1000)
    const { data: authData, error: authError } = await db.auth.admin.listUsers({ perPage: 1000 });
    if (authError) throw authError;

    // 2. Build user list from auth.users
    let users = authData.users.map(u => ({
      user_id:         u.id,
      email:           u.email ?? '',
      full_name:       (u.user_metadata?.full_name as string | undefined)
                       ?? (u.user_metadata?.name as string | undefined)
                       ?? '',
      plan:            'free',
      country:         (u.user_metadata?.country as string | undefined) ?? '',
      free_checks_used: 0,
      ai_checks_used:   0,
      created_at:      u.created_at,
    }));

    // 3. Optionally merge public.profiles (non-fatal if empty/unavailable)
    try {
      const { data: profileData } = await db
        .from('profiles')
        .select('user_id,plan,free_checks_used,ai_checks_used,full_name,country');
      if (profileData && profileData.length > 0) {
        const profileMap = new Map((profileData as any[]).map((p: any) => [p.user_id, p]));
        users = users.map(u => {
          const p = profileMap.get(u.user_id) as any;
          if (!p) return u;
          return {
            ...u,
            plan:             p.plan            ?? u.plan,
            free_checks_used: p.free_checks_used ?? u.free_checks_used,
            ai_checks_used:   p.ai_checks_used   ?? u.ai_checks_used,
            full_name:        p.full_name        || u.full_name,
            country:          p.country          || u.country,
          };
        });
      }
    } catch {
      // profiles unavailable — use auth data only (already populated above)
    }

    // 4. Filter by plan if requested
    if (plan) {
      users = users.filter(u => u.plan === plan);
    }

    // 5. Sort newest first
    users.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    res.json({ users });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/admin/tickets ────────────────────────────────────────────────────
router.get('/tickets', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    const { status } = req.query;
    let query = db.from('support_tickets').select('id,subject,category,status,created_at,updated_at,user_id,message').order('created_at', { ascending: false }).limit(200);
    if (status) query = query.eq('status', status as string);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ tickets: data ?? [] });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/admin/tickets/:id/reply ─────────────────────────────────────────
router.post('/tickets/:id/reply', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    const { id }     = req.params;
    const { status, message } = req.body ?? {};

    if (status) {
      const { error } = await db.from('support_tickets').update({ status, updated_at: new Date().toISOString() }).eq('id', id);
      if (error) throw error;
    }

    if (message?.trim()) {
      const { error } = await db.from('support_ticket_replies').insert({
        ticket_id:       id,
        message:         message.trim(),
        is_staff_reply:  true,
      });
      if (error) throw error;
    }

    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/admin/reports?status=pending_review|approved|disapproved&platform= ──
router.get('/reports', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    const { platform, status } = req.query;
    let query = db
      .from('scam_reports')
      .select('id,seller_name,platform,description,amount_lost,status,admin_notes,reviewed_at,reporter_id,created_at,evidence_urls')
      .order('created_at', { ascending: false })
      .limit(200);
    if (platform) query = query.eq('platform', platform as string);
    if (status)   query = query.eq('status', status as string);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ reports: data ?? [] });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/admin/reports?status=pending_review|approved|disapproved ────────
// Override the generic GET above with status-filtered version when status param present
// (the generic route already supports this via query param)

// ── POST /api/admin/reports/:id/approve ──────────────────────────────────────
router.post('/reports/:id/approve', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    const { admin_notes } = req.body ?? {};
    const { error } = await db.from('scam_reports').update({
      status:       'approved',
      admin_notes:  admin_notes ?? null,
      reviewed_by:  'admin',
      reviewed_at:  new Date().toISOString(),
    }).eq('id', req.params.id);
    if (error) throw error;
    console.log(`[Admin] Report ${req.params.id} APPROVED`);
    res.json({ success: true, status: 'approved' });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/admin/reports/:id/disapprove ────────────────────────────────────
router.post('/reports/:id/disapprove', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    const { admin_notes } = req.body ?? {};
    const { error } = await db.from('scam_reports').update({
      status:       'disapproved',
      admin_notes:  admin_notes ?? null,
      reviewed_by:  'admin',
      reviewed_at:  new Date().toISOString(),
    }).eq('id', req.params.id);
    if (error) throw error;
    console.log(`[Admin] Report ${req.params.id} DISAPPROVED`);
    res.json({ success: true, status: 'disapproved' });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /api/admin/reports/:id ─────────────────────────────────────────────
router.delete('/reports/:id', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    const { error } = await db.from('scam_reports').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/admin/alerts ─────────────────────────────────────────────────────
router.get('/alerts', requireAdmin, async (_req: Request, res: Response): Promise<void> => {
  try {
    const { data, error } = await db.from('admin_alerts').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ alerts: data ?? [] });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/admin/alerts ────────────────────────────────────────────────────
router.post('/alerts', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    const { title, message, platform, severity, country_code, is_active } = req.body ?? {};
    if (!title?.trim() || !message?.trim()) { res.status(400).json({ error: 'Title and message are required' }); return; }
    const { data, error } = await db.from('admin_alerts').insert({
      title: title.trim(), message: message.trim(),
      platform: platform ?? 'all',
      severity: severity ?? 'medium',
      country_code: country_code ?? 'PH',
      is_active: is_active ?? true,
    }).select().single();
    if (error) throw error;
    res.json({ alert: data });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── PUT /api/admin/alerts/:id ─────────────────────────────────────────────────
router.put('/alerts/:id', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    const { title, message, platform, severity, country_code, is_active } = req.body ?? {};
    const { error } = await db.from('admin_alerts').update({
      title, message, platform, severity, country_code, is_active,
      updated_at: new Date().toISOString(),
    }).eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /api/admin/alerts/:id ──────────────────────────────────────────────
router.delete('/alerts/:id', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    const { error } = await db.from('admin_alerts').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/admin/checks ─────────────────────────────────────────────────────
router.get('/checks', requireAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    const { platform, risk_level } = req.query;
    let query = db
      .from('product_checks')
      .select('id,platform,product_name,risk_score,risk_level,plan_at_check,has_ai,input_url,created_at')
      .order('created_at', { ascending: false })
      .limit(200);
    if (platform)   query = query.eq('platform', platform as string);
    if (risk_level) query = query.eq('risk_level', risk_level as string);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ checks: data ?? [] });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/admin/verify ─────────────────────────────────────────────────────
router.get('/verify', requireAdmin, (_req: Request, res: Response): void => {
  res.json({ valid: true });
});

export default router;
