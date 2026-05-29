import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import ws from 'ws';

// Node 20 lacks native WebSocket — provide the ws package for Supabase realtime
if (!('WebSocket' in globalThis)) {
  (globalThis as any).WebSocket = ws;
}

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const serviceKey  = process.env.SUPABASE_SERVICE_KEY;
const anonKey     = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl) throw new Error('Missing SUPABASE_URL in environment');

const key = serviceKey || anonKey;
if (!key) throw new Error('Missing SUPABASE_SERVICE_KEY or SUPABASE_ANON_KEY in environment');

if (!serviceKey) {
  console.warn(
    '[DB] SUPABASE_SERVICE_KEY not set — using anon key. ' +
    'Some write operations may be blocked by RLS. ' +
    'Add your service role key from Supabase Dashboard → Settings → API.'
  );
}

export const db = createClient(supabaseUrl, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});
