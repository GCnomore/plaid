create table public.plaid_weekly_budget_summaries (
  id bigint generated always as identity primary key,
  week_start date not null,
  week_end date not null,
  weekly_budget numeric not null,
  carryover_in numeric not null default 0,
  total_budget numeric not null,
  spent numeric not null,
  balance numeric not null,
  outcome text not null check (outcome in ('under_budget', 'over_budget', 'on_budget')),
  carryover_out numeric not null default 0,
  created_at timestamptz not null default now(),
  constraint plaid_weekly_budget_summaries_week_range check (week_end >= week_start),
  constraint plaid_weekly_budget_summaries_week_start_unique unique (week_start)
);

create index idx_plaid_weekly_budget_summaries_week_end
  on public.plaid_weekly_budget_summaries (week_end desc);

alter table public.plaid_weekly_budget_summaries enable row level security;
