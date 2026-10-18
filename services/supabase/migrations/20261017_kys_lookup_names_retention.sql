-- 17 Oct 2026: the per-name request count keeps a name only until a year after the last request that asked about it
-- (the privacy notice says so). Done inside kys_count_names, as the project has no scheduler; the index keeps the
-- delete cheap, as it usually finds nothing.
create index if not exists kys_lookup_names_last_seen on public.kys_lookup_names (last_seen);

create or replace function public.kys_count_names(p_names text[]) returns table (name text, requests integer)
language sql security definer set search_path = '' as $$
  delete from public.kys_lookup_names where last_seen < current_date - 365;
  insert into public.kys_lookup_names as n (name, requests)
  select distinct x, 1 from unnest(p_names) as x where x is not null and length(x) between 1 and 120
  on conflict (name) do update set requests = n.requests + 1, last_seen = current_date
  returning n.name, n.requests;
$$;

revoke all on function public.kys_count_names(text[]) from public, anon, authenticated;
