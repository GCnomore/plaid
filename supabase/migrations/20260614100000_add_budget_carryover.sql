alter table public.plaid_sync_state
  add column if not exists carryover numeric not null default 0,
  add column if not exists week_monday date;
