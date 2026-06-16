create table public.plaid_budget_transactions (
  transaction_id text primary key,
  pending_transaction_id text,
  amount numeric not null,
  merchant_name text,
  name text,
  transaction_date date not null,
  pending boolean not null default false,
  excluded boolean not null default false,
  counts_in_budget boolean not null default false,
  notified_at timestamptz,
  superseded_by text,
  removed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_plaid_budget_tx_date
  on public.plaid_budget_transactions (transaction_date)
  where counts_in_budget = true and excluded = false and removed_at is null;

create index idx_plaid_budget_tx_pending_ref
  on public.plaid_budget_transactions (pending_transaction_id)
  where pending_transaction_id is not null;

alter table public.plaid_budget_transactions enable row level security;
