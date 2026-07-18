import { createClient } from '@supabase/supabase-js';

// These env vars are set in AWS Amplify (.env) or locally for development.
// If missing/unset, the app runs in sandbox/demo mode (see AuthContext).
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

// Detect whether Supabase is properly configured with real (non-placeholder) values.
export const isSupabaseConfigured = !!(
  supabaseUrl &&
  supabaseUrl !== 'https://your-supabase-project.supabase.co' &&
  !supabaseUrl.includes('placeholder') &&
  supabaseAnonKey &&
  supabaseAnonKey !== 'your-supabase-anon-public-key' &&
  !supabaseAnonKey.includes('placeholder')
);

if (!isSupabaseConfigured) {
  console.warn(
    '[AI Video Studio] Supabase env vars are missing or placeholders. ' +
    'Running in sandbox/demo mode. Set NEXT_PUBLIC_SUPABASE_URL and ' +
    'NEXT_PUBLIC_SUPABASE_ANON_KEY to connect to real backend.'
  );
}

// Create the Supabase client. Uses a placeholder URL when unconfigured so
// the import doesn't throw at module level.
export const supabase = createClient(
  isSupabaseConfigured
    ? supabaseUrl
    : 'https://placeholder-project-id.supabase.co',
  isSupabaseConfigured
    ? supabaseAnonKey
    : 'placeholder-anon-key'
);