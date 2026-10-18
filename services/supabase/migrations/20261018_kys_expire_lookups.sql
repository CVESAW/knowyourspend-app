-- Applied 18 Oct 2026 by Sam in the Supabase SQL editor (apply_migration was cancelled), so it isn't in Supabase's
-- migration list. The SQL Sam ran also called kys_expire_lookups() once straight away.
-- 18 Oct 2026 (Sam: yes): answers in the shared look-up cache are deleted once they're past their time, rather than
-- staying until the name is next looked up (a person's name the look-up took for "not a business" could otherwise
-- stay indefinitely). The same job deletes a name's request count a year after it was last asked about, which
-- kys_count_names also does whenever it runs. Supabase Cron (pg_cron) runs it every night at 03:17 UTC.
create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

create or replace function public.kys_expire_lookups() returns void
language sql security definer set search_path = '' as $$
  delete from public.kys_lookup_cache where expires_at < now();
  delete from public.kys_lookup_names where last_seen < current_date - 365;
$$;

revoke all on function public.kys_expire_lookups() from public, anon, authenticated;

select cron.schedule('kys-expire-lookups', '17 3 * * *', 'select public.kys_expire_lookups()');
