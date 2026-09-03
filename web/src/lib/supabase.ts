/**
 * Supabase client, configured entirely from environment variables.
 *
 * ONLY the publishable (anon) key ever appears here. Anything prefixed VITE_ is
 * inlined into the bundle every visitor downloads, so the service-role key, the
 * secret key and the database password must never be referenced in this file or
 * anywhere else under src/. Those bypass Row Level Security completely and
 * belong only to server-side tooling.
 *
 * The anon key is safe to publish because RLS is enforced in the database:
 * everyone signed in may read, and only a named admin may write.
 *
 * When the variables are absent the app runs on the audited sample data, so it
 * is fully usable before the backend is wired up.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as
  | string
  | undefined;

export const isSupabaseConfigured = Boolean(url && publishableKey);

export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(url!, publishableKey!, {
      auth: { persistSession: true, autoRefreshToken: true },
    })
  : null;

/** Where the figures on screen are coming from, shown in the UI. */
export function dataSourceLabel(): string {
  return isSupabaseConfigured ? 'Supabase' : 'Audited workbook sample';
}
