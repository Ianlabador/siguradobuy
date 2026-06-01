/**
 * Expo push notification sender.
 *
 * Sends through Expo's push service (https://exp.host/--/api/v2/push/send).
 * Every function here is best-effort and fully guarded: a notification failure
 * must NEVER break the admin action that triggered it (approve / reply).
 *
 * Requires:
 *  - Mobile app built with expo-notifications (EAS build) so devices register tokens.
 *  - public.notification_tokens (user_id, expo_push_token) populated on the device.
 *  - public.notification_preferences (user_id, push_enabled, scam_alerts_enabled,
 *    ticket_replies_enabled, billing_notifications_enabled).
 */

import axios from 'axios';
import { db } from '../db/client';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

interface PushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: 'default';
}

// Send messages to Expo in chunks of 100 (Expo's per-request limit).
async function sendExpo(messages: PushMessage[]): Promise<{ sent: number }> {
  const valid = messages.filter(m => typeof m.to === 'string' && m.to.startsWith('ExponentPushToken'));
  if (valid.length === 0) return { sent: 0 };

  let sent = 0;
  for (let i = 0; i < valid.length; i += 100) {
    const chunk = valid.slice(i, i + 100).map(m => ({ sound: 'default' as const, ...m }));
    try {
      await axios.post(EXPO_PUSH_URL, chunk, {
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        timeout: 10000,
      });
      sent += chunk.length;
    } catch (e: any) {
      console.error('[Push] Expo send failed:', e.response?.data ?? e.message);
    }
  }
  console.log(`[Push] Delivered ${sent}/${valid.length} messages to Expo.`);
  return { sent };
}

// Fetch the Expo push tokens for a set of user IDs.
async function tokensForUsers(userIds: string[]): Promise<{ user_id: string; expo_push_token: string }[]> {
  if (userIds.length === 0) return [];
  const { data, error } = await db
    .from('notification_tokens')
    .select('user_id,expo_push_token')
    .in('user_id', userIds);
  if (error) { console.error('[Push] tokensForUsers error:', error.message); return []; }
  return (data ?? []) as { user_id: string; expo_push_token: string }[];
}

/**
 * Notify all users who have scam-alert notifications enabled that a new
 * scam report was approved and is now visible to everyone.
 */
export async function notifyScamAlertApproved(report: { id: string; platform?: string | null }): Promise<void> {
  try {
    const { data: prefs, error } = await db
      .from('notification_preferences')
      .select('user_id')
      .eq('push_enabled', true)
      .eq('scam_alerts_enabled', true);
    if (error) { console.error('[Push] scam prefs error:', error.message); return; }

    const userIds = (prefs ?? []).map((p: any) => p.user_id).filter(Boolean);
    const tokens = await tokensForUsers(userIds);
    const platform = report.platform ? report.platform : 'a marketplace';

    const messages: PushMessage[] = tokens.map(t => ({
      to:    t.expo_push_token,
      title: 'New Scam Alert',
      body:  `A new scam report was approved on ${platform}. Check Scam Alerts before buying.`,
      data:  { type: 'scam_alert', reportId: report.id },
    }));

    const { sent } = await sendExpo(messages);
    console.log(`[Push] Scam alert for report ${report.id} → ${sent} devices.`);
  } catch (e: any) {
    console.error('[Push] notifyScamAlertApproved failed:', e.message);
  }
}

/**
 * Notify only the ticket owner that support replied — if they have
 * support-reply notifications enabled.
 */
export async function notifySupportReply(ticket: { id: string; user_id: string | null }): Promise<void> {
  try {
    if (!ticket.user_id) return;

    const { data: pref } = await db
      .from('notification_preferences')
      .select('push_enabled,ticket_replies_enabled')
      .eq('user_id', ticket.user_id)
      .single();

    // Default to enabled if no row exists yet (matches mobile defaults).
    const pushEnabled = pref?.push_enabled ?? true;
    const repliesEnabled = pref?.ticket_replies_enabled ?? true;
    if (!pushEnabled || !repliesEnabled) return;

    const tokens = await tokensForUsers([ticket.user_id]);
    const messages: PushMessage[] = tokens.map(t => ({
      to:    t.expo_push_token,
      title: 'Support replied to your ticket',
      body:  'Our team replied to your support request. Tap to view the conversation.',
      data:  { type: 'support_reply', ticketId: ticket.id },
    }));

    const { sent } = await sendExpo(messages);
    console.log(`[Push] Support reply for ticket ${ticket.id} → ${sent} devices.`);
  } catch (e: any) {
    console.error('[Push] notifySupportReply failed:', e.message);
  }
}
