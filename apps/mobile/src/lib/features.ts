/**
 * Features that need our server side (Supabase migration 20261011, the kys-email, kys-account,
 * kys-count and kys-unsubscribe Edge Functions, and Brevo for email): the optional account,
 * "Email me my results" and anonymous counts. On since 16 Oct 2026, when email went live; a build
 * with EXPO_PUBLIC_ONLINE_EXTRAS=0 hides them again (if the server side ever has to be switched off).
 */
export const ONLINE_EXTRAS = process.env.EXPO_PUBLIC_ONLINE_EXTRAS !== "0";
