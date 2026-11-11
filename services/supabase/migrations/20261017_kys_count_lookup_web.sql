-- 17 Oct 2026. The look-up service counts its web checks in kys_usage_counts to enforce DAILY_WEB_CAP (a tally of
-- searches the service ran, nothing about anyone). 'lookup_web' was missing from the allowed events, so the count
-- never saved and the daily cap only applied within one request. The public kys-count function keeps its own
-- shorter list, so the app can't send this event.
alter table public.kys_usage_counts drop constraint kys_usage_counts_event_check;
alter table public.kys_usage_counts add constraint kys_usage_counts_event_check
  check (event in ('statement_added', 'receipt_added', 'demo_opened', 'account_created', 'results_emailed', 'lookup_web'));
