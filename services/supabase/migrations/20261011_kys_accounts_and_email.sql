-- KnowYourSpend: optional accounts with an end-to-end encrypted copy of the user's data, and
-- "email me my results". The server never sees the data in clear: kys_vault.blob is encrypted on the
-- device with a key derived from a passphrase only the user knows.
-- Apply with the Supabase MCP apply_migration (project cxvwngmnkxtweuwaxfmz) or the SQL editor.

create table if not exists public.kys_vault (
  user_id uuid primary key references auth.users (id) on delete cascade,
  blob text not null check (octet_length(blob) <= 15000000),
  bytes integer not null default 0,
  updated_at timestamptz not null default now()
);
alter table public.kys_vault enable row level security;

drop policy if exists "own vault: read" on public.kys_vault;
drop policy if exists "own vault: insert" on public.kys_vault;
drop policy if exists "own vault: update" on public.kys_vault;
drop policy if exists "own vault: delete" on public.kys_vault;
create policy "own vault: read" on public.kys_vault for select to authenticated using ((select auth.uid()) = user_id);
create policy "own vault: insert" on public.kys_vault for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "own vault: update" on public.kys_vault for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own vault: delete" on public.kys_vault for delete to authenticated using ((select auth.uid()) = user_id);
revoke all on public.kys_vault from anon;

-- keep updated_at and bytes honest whatever the client sends
create or replace function public.kys_vault_touch() returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  new.bytes := octet_length(new.blob);
  return new;
end $$;
drop trigger if exists kys_vault_touch on public.kys_vault;
create trigger kys_vault_touch before insert or update on public.kys_vault for each row execute function public.kys_vault_touch();

-- Rate limits for the email function: salted hashes only (of the IP or the recipient), one row per key
-- per day, removed after 30 days. Written only by the Edge Function (service role); no policies.
create table if not exists public.kys_email_limits (
  day date not null default current_date,
  key text not null,
  count integer not null default 0,
  primary key (day, key)
);
alter table public.kys_email_limits enable row level security;
revoke all on public.kys_email_limits from anon, authenticated;

create or replace function public.kys_email_bump(p_keys text[], p_limits integer[]) returns boolean
language plpgsql security definer set search_path = '' as $$
declare i integer; c integer;
begin
  delete from public.kys_email_limits where day < current_date - 30;
  for i in 1 .. coalesce(array_length(p_keys, 1), 0) loop
    select l.count into c from public.kys_email_limits l where l.day = current_date and l.key = p_keys[i];
    if coalesce(c, 0) >= p_limits[i] then return false; end if;
  end loop;
  for i in 1 .. coalesce(array_length(p_keys, 1), 0) loop
    insert into public.kys_email_limits (day, key, count) values (current_date, p_keys[i], 1)
    on conflict (day, key) do update set count = public.kys_email_limits.count + 1;
  end loop;
  return true;
end $$;
revoke all on function public.kys_email_bump(text[], integer[]) from public, anon, authenticated;

-- People who ticked "send me occasional updates" (marketing consent under PECR). Unsubscribe by token.
create table if not exists public.kys_subscribers (
  email text primary key check (position('@' in email) > 1 and length(email) <= 254),
  consented_at timestamptz not null default now(),
  consent_text text not null,
  source text not null default 'email-results',
  unsubscribe_token uuid not null default gen_random_uuid() unique
);
alter table public.kys_subscribers enable row level security;
revoke all on public.kys_subscribers from anon, authenticated;

-- Anonymous usage counts (off unless switched on in the app): one row per event per day, no IP, no ID.
create table if not exists public.kys_usage_counts (
  day date not null default current_date,
  event text not null check (event in ('statement_added', 'receipt_added', 'demo_opened', 'account_created', 'results_emailed')),
  count integer not null default 0,
  primary key (day, event)
);
alter table public.kys_usage_counts enable row level security;
revoke all on public.kys_usage_counts from anon, authenticated;

create or replace function public.kys_count(p_event text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.kys_usage_counts (day, event, count) values (current_date, p_event, 1)
  on conflict (day, event) do update set count = public.kys_usage_counts.count + 1;
end $$;
revoke all on function public.kys_count(text) from public, anon, authenticated;
