-- 17 Oct 2026: the look-up can answer "a small local business" (status LOCAL_BUSINESS). The cache's status check didn't
-- allow it, so a request with such an answer kept none of its answers (the whole batch is one upsert).
alter table public.kys_lookup_cache drop constraint if exists kys_lookup_cache_status_check;
alter table public.kys_lookup_cache add constraint kys_lookup_cache_status_check
  check (status = any (array['RESOLVED'::text, 'NOT_A_BUSINESS'::text, 'UNRESOLVED'::text, 'LOCAL_BUSINESS'::text]));
