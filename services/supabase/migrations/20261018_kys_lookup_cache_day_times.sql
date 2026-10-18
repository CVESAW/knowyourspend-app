-- Applied 18 Oct 2026 by Sam in the Supabase SQL editor (apply_migration was cancelled), so it isn't in Supabase's
-- migration list.
-- 18 Oct 2026 (Sam: yes). Times in the shared look-up cache are kept to the day (UTC), so the names one request sent
-- don't share an exact time. kys-lookup has saved created_at, updated_at, expires_at and each answer's looked_up_at
-- that way since 18 Oct; this sets the column defaults to match and rounds the rows saved before: created and updated
-- times and the expiry down to the day (the expiry down, as the look-up does, so no answer is used past its time),
-- and looked_up_at to the date.
alter table public.kys_lookup_cache alter column created_at set default (date_trunc('day', now() at time zone 'UTC') at time zone 'UTC');
alter table public.kys_lookup_cache alter column updated_at set default (date_trunc('day', now() at time zone 'UTC') at time zone 'UTC');

update public.kys_lookup_cache set
  created_at = date_trunc('day', created_at at time zone 'UTC') at time zone 'UTC',
  updated_at = date_trunc('day', updated_at at time zone 'UTC') at time zone 'UTC',
  expires_at = date_trunc('day', expires_at at time zone 'UTC') at time zone 'UTC',
  result = case
    when result ? 'looked_up_at' then jsonb_set(result, '{looked_up_at}', to_jsonb(left(result ->> 'looked_up_at', 10)))
    else result
  end;
