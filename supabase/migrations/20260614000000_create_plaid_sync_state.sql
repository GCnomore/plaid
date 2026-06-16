create table public.plaid_sync_state (
  id int primary key default 1 check (id = 1),
  cursor text not null default '',
  updated_at timestamptz not null default now()
);

insert into public.plaid_sync_state (id, cursor) values (1, '');

alter table public.plaid_sync_state enable row level security;
