import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { db } from '../db/client';

const router = Router();

const VALID_CATEGORIES = [
  'app_bug',
  'wrong_risk_result',
  'scam_report_issue',
  'account_issue',
  'payment_subscription',
  'other',
] as const;

const VALID_STATUSES = ['open', 'in_progress', 'resolved', 'closed'] as const;

const CreateTicketSchema = z.object({
  userId:           z.string().uuid(),
  category:         z.enum(VALID_CATEGORIES),
  subject:          z.string().min(5).max(200),
  message:          z.string().min(10).max(5000),
  relatedCheckId:   z.string().uuid().optional(),
  relatedReportId:  z.string().uuid().optional(),
});

const AddReplySchema = z.object({
  userId:       z.string().uuid(),
  message:      z.string().min(1).max(5000),
  isStaffReply: z.boolean().optional().default(false),
});

// POST /api/tickets — create a new support ticket
router.post('/', async (req: Request, res: Response): Promise<void> => {
  const parsed = CreateTicketSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten().fieldErrors });
    return;
  }

  const { userId, category, subject, message, relatedCheckId, relatedReportId } = parsed.data;

  const { data, error } = await db
    .from('support_tickets')
    .insert({
      user_id:           userId,
      category,
      subject,
      message,
      related_check_id:  relatedCheckId ?? null,
      related_report_id: relatedReportId ?? null,
    })
    .select()
    .single();

  if (error) {
    console.error('[tickets] create error:', error.message);
    res.status(500).json({ error: 'Failed to create ticket. Please try again.' });
    return;
  }

  res.status(201).json({ ticket: data });
});

// GET /api/tickets/user/:userId — list user's tickets
router.get('/user/:userId', async (req: Request, res: Response): Promise<void> => {
  const { userId } = req.params;
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);

  const { data, error } = await db
    .from('support_tickets')
    .select(`
      id, category, subject, status, priority,
      created_at, updated_at,
      support_ticket_replies(count)
    `)
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .limit(limit);

  if (error) {
    res.status(500).json({ error: 'Failed to fetch tickets' });
    return;
  }

  res.json({ tickets: data ?? [] });
});

// GET /api/tickets/:id — get single ticket with replies
router.get('/:id', async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const { userId } = req.query;

  const { data: ticket, error: ticketError } = await db
    .from('support_tickets')
    .select('*')
    .eq('id', id)
    .single();

  if (ticketError || !ticket) {
    res.status(404).json({ error: 'Ticket not found' });
    return;
  }

  // Security: non-staff can only see their own tickets
  if (userId && ticket.user_id !== userId) {
    // Check if requester is staff
    const { data: profile } = await db
      .from('user_profiles')
      .select('is_staff')
      .eq('id', userId)
      .single();

    if (!profile?.is_staff) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }
  }

  const { data: replies } = await db
    .from('support_ticket_replies')
    .select('id, user_id, message, is_staff_reply, created_at')
    .eq('ticket_id', id)
    .order('created_at', { ascending: true });

  const { data: attachments } = await db
    .from('support_ticket_attachments')
    .select('id, file_url, file_name, file_type, file_size, created_at')
    .eq('ticket_id', id);

  res.json({
    ticket,
    replies:     replies ?? [],
    attachments: attachments ?? [],
  });
});

// POST /api/tickets/:id/reply — add a reply to a ticket
router.post('/:id/reply', async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const parsed = AddReplySchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten().fieldErrors });
    return;
  }

  const { userId, message, isStaffReply } = parsed.data;

  // Verify ticket exists and belongs to user (or user is staff)
  const { data: ticket } = await db
    .from('support_tickets')
    .select('user_id, status')
    .eq('id', id)
    .single();

  if (!ticket) {
    res.status(404).json({ error: 'Ticket not found' });
    return;
  }

  if (ticket.status === 'closed') {
    res.status(400).json({ error: 'Cannot reply to a closed ticket' });
    return;
  }

  const { data: reply, error } = await db
    .from('support_ticket_replies')
    .insert({
      ticket_id:     id,
      user_id:       userId,
      message,
      is_staff_reply: isStaffReply,
    })
    .select()
    .single();

  if (error) {
    res.status(500).json({ error: 'Failed to add reply' });
    return;
  }

  // Auto-update ticket status to in_progress if staff replied
  if (isStaffReply && ticket.status === 'open') {
    await db
      .from('support_tickets')
      .update({ status: 'in_progress' })
      .eq('id', id);
  }

  res.status(201).json({ reply });
});

// PATCH /api/tickets/:id/status — update ticket status (staff only)
router.patch('/:id/status', async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const { status, userId } = req.body;

  if (!VALID_STATUSES.includes(status)) {
    res.status(400).json({ error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` });
    return;
  }

  // Verify user is staff
  const { data: profile } = await db
    .from('user_profiles')
    .select('is_staff')
    .eq('id', userId)
    .single();

  if (!profile?.is_staff) {
    res.status(403).json({ error: 'Only staff can update ticket status' });
    return;
  }

  const { data, error } = await db
    .from('support_tickets')
    .update({ status })
    .eq('id', id)
    .select()
    .single();

  if (error) {
    res.status(500).json({ error: 'Failed to update status' });
    return;
  }

  res.json({ ticket: data });
});

export default router;
