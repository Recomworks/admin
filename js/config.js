// Recomworks Admin — connection settings
// Fill these in with your own Supabase project's values:
// Supabase dashboard -> Project Settings -> API -> "Project URL" and "anon public" key.
// These are safe to publish in client-side code: on their own they grant no access —
// every table requires a real signed-in, 2FA-verified session (see supabase-schema.sql).
window.RECOMWORKS_CONFIG = {
  SUPABASE_URL: 'YOUR_SUPABASE_PROJECT_URL',
  SUPABASE_ANON_KEY: 'YOUR_SUPABASE_ANON_KEY'
};
