-- 17 Oct 2026. How many times each shop name has been asked about, kept by the look-up service (kys-lookup): one
-- running count per name, with the first and last day it was asked. Nothing about who asked. It shows which shops most
-- people pay, so those are checked by hand first, and lets the look-up hold back its paid web search for a name only one
-- request has asked about when the AI can't tell what kind of business it is.
create table if not exists public.kys_lookup_names (
  name text primary key,
  requests integer not null default 0,
  first_seen date not null default current_date,
  last_seen date not null default current_date
);
alter table public.kys_lookup_names enable row level security;
revoke all on public.kys_lookup_names from anon, authenticated;

-- Adds one to each name's count (each name once per request) and returns the new counts.
create or replace function public.kys_count_names(p_names text[]) returns table (name text, requests integer)
language sql security definer set search_path = '' as $$
  insert into public.kys_lookup_names as n (name, requests)
  select distinct x, 1 from unnest(p_names) as x where x is not null and length(x) between 1 and 120
  on conflict (name) do update set requests = n.requests + 1, last_seen = current_date
  returning n.name, n.requests;
$$;
revoke all on function public.kys_count_names(text[]) from public, anon, authenticated;
