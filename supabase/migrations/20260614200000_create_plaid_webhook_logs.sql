create table public.plaid_webhook_logs (
  id uuid primary key default gen_random_uuid(),
  received_at timestamptz not null default now(),
  webhook_type text,
  webhook_code text,
  item_id text,
  payload jsonb not null
);

create index plaid_webhook_logs_received_at_idx
  on public.plaid_webhook_logs (received_at desc);

create index plaid_webhook_logs_type_code_idx
  on public.plaid_webhook_logs (webhook_type, webhook_code);

alter table public.plaid_webhook_logs enable row level security;
