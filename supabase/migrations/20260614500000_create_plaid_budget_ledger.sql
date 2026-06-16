create table public.plaid_budget_ledger (
  id bigint generated always as identity primary key,
  budget_key text not null unique,
  pending_transaction_id text,
  posted_transaction_id text,
  amount numeric not null,
  pending_amount numeric not null,
  merchant_name text,
  name text,
  transaction_date date not null,
  status text not null check (status in ('pending', 'posted', 'excluded', 'removed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_plaid_budget_ledger_week
  on public.plaid_budget_ledger (transaction_date)
  where status in ('pending', 'posted');

create index idx_plaid_budget_ledger_pending_ref
  on public.plaid_budget_ledger (pending_transaction_id)
  where pending_transaction_id is not null;

create index idx_plaid_budget_ledger_posted_ref
  on public.plaid_budget_ledger (posted_transaction_id)
  where posted_transaction_id is not null;

alter table public.plaid_budget_ledger enable row level security;

-- 기존 plaid_budget_transactions → ledger 이전
insert into public.plaid_budget_ledger (
  budget_key, pending_transaction_id, posted_transaction_id,
  amount, pending_amount, merchant_name, name, transaction_date, status
)
select
  transaction_id,
  transaction_id,
  null,
  amount,
  amount,
  merchant_name,
  name,
  transaction_date,
  'pending'
from public.plaid_budget_transactions
where pending = true
  and excluded = false
  and removed_at is null
  and superseded_by is null
on conflict (budget_key) do nothing;

update public.plaid_budget_ledger l
set
  posted_transaction_id = p.transaction_id,
  amount = p.amount,
  merchant_name = p.merchant_name,
  name = p.name,
  transaction_date = p.transaction_date,
  status = 'posted',
  updated_at = now()
from public.plaid_budget_transactions p
where p.pending = false
  and p.excluded = false
  and p.removed_at is null
  and p.pending_transaction_id is not null
  and l.budget_key = p.pending_transaction_id;

insert into public.plaid_budget_ledger (
  budget_key, pending_transaction_id, posted_transaction_id,
  amount, pending_amount, merchant_name, name, transaction_date, status
)
select
  p.transaction_id,
  p.pending_transaction_id,
  p.transaction_id,
  p.amount,
  p.amount,
  p.merchant_name,
  p.name,
  p.transaction_date,
  'posted'
from public.plaid_budget_transactions p
where p.pending = false
  and p.excluded = false
  and p.removed_at is null
  and not exists (
    select 1 from public.plaid_budget_ledger l
    where l.budget_key = p.transaction_id
       or (p.pending_transaction_id is not null and l.budget_key = p.pending_transaction_id)
  )
on conflict (budget_key) do nothing;
