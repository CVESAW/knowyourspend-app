-- KnowYourSpend: daily limits that requests running side by side can't go past.
--
-- kys_limits + kys_take(): the look-up's requests, names sent to the AI step and web checks, overall and per
-- connection. A connection is only ever a salted SHA-256 of its IP address; rows are deleted after two days.
-- kys_email_bump() is rewritten the same way (it read the counts and then added to them, so requests at the same
-- moment could all get through), and its rows are now also deleted after two days (they were kept 30).
-- Names the look-up decided aren't a business are no longer kept (they may be someone's name): the ones kept
-- before are deleted here.

create table if not exists public.kys_limits (
  day date not null default current_date,
  key text not null,
  used integer not null default 0,
  primary key (day, key)
);
alter table public.kys_limits enable row level security;
revoke all on public.kys_limits from anon, authenticated;

-- Takes up to p_n units from today's limit for every key (p_caps[i] for p_keys[i]): the same number from each, as
-- many as the tightest one has left. Returns how many it took (0: a limit is reached).
create or replace function public.kys_take(p_keys text[], p_caps integer[], p_n integer default 1) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  got integer := greatest(coalesce(p_n, 0), 0);
  r record;
begin
  if coalesce(array_length(p_keys, 1), 0) = 0 or array_length(p_keys, 1) is distinct from array_length(p_caps, 1) then
    return 0;
  end if;
  delete from public.kys_limits where day < current_date - 1;
  insert into public.kys_limits (day, key, used)
    select current_date, k, 0 from unnest(p_keys) as k
    on conflict (day, key) do nothing;
  -- lock the rows in one order, so two requests can't each wait on the other
  for r in
    select l.used, c.cap
    from public.kys_limits l
    join unnest(p_keys, p_caps) as c(key, cap) on c.key = l.key
    where l.day = current_date
    order by l.key
    for update of l
  loop
    got := least(got, greatest(coalesce(r.cap, 0) - r.used, 0));
  end loop;
  if got > 0 then
    update public.kys_limits set used = used + got where day = current_date and key = any (p_keys);
  end if;
  return got;
end $$;
revoke all on function public.kys_take(text[], integer[], integer) from public, anon, authenticated;
grant execute on function public.kys_take(text[], integer[], integer) to service_role;

create or replace function public.kys_email_bump(p_keys text[], p_limits integer[]) returns boolean
language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  if coalesce(array_length(p_keys, 1), 0) = 0 or array_length(p_keys, 1) is distinct from array_length(p_limits, 1) then
    return false;
  end if;
  delete from public.kys_email_limits where day < current_date - 1;
  insert into public.kys_email_limits (day, key, count)
    select current_date, k, 0 from unnest(p_keys) as k
    on conflict (day, key) do nothing;
  for r in
    select l.count, c.lim
    from public.kys_email_limits l
    join unnest(p_keys, p_limits) as c(key, lim) on c.key = l.key
    where l.day = current_date
    order by l.key
    for update of l
  loop
    if r.count >= coalesce(r.lim, 0) then return false; end if;
  end loop;
  update public.kys_email_limits set count = count + 1 where day = current_date and key = any (p_keys);
  return true;
end $$;
revoke all on function public.kys_email_bump(text[], integer[]) from public, anon, authenticated;
grant execute on function public.kys_email_bump(text[], integer[]) to service_role;

delete from public.kys_email_limits where day < current_date - 1;
delete from public.kys_lookup_cache where status = 'NOT_A_BUSINESS';
