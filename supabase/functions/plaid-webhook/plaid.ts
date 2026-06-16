import type { PlaidTransaction } from './budget.ts';

const PLAID_CLIENT_ID = Deno.env.get('PLAID_CLIENT_ID')!;
const PLAID_SECRET = Deno.env.get('PLAID_SECRET')!;
const PLAID_ACCESS_TOKEN = Deno.env.get('PLAID_ACCESS_TOKEN')!;
const PLAID_ENV = Deno.env.get('PLAID_ENV') ?? 'sandbox';

const PLAID_BASE_URL = `https://${PLAID_ENV}.plaid.com`;

async function plaidPost<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${PLAID_BASE_URL}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: PLAID_CLIENT_ID,
      secret: PLAID_SECRET,
      ...body,
    }),
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(`Plaid API error (${endpoint}): ${JSON.stringify(err)}`);
  }

  return res.json() as Promise<T>;
}

export interface SyncResult {
  added: PlaidTransaction[];
  modified: PlaidTransaction[];
  removed: { transaction_id: string }[];
  nextCursor: string;
}

export async function refreshTransactions(): Promise<{ request_id: string }> {
  return plaidPost('/transactions/refresh', {
    access_token: PLAID_ACCESS_TOKEN,
  });
}

export async function syncTransactions(cursor: string): Promise<SyncResult> {
  let added: PlaidTransaction[] = [];
  let modified: PlaidTransaction[] = [];
  let removed: { transaction_id: string }[] = [];
  let currentCursor = cursor;
  let hasMore = true;

  while (hasMore) {
    const data = await plaidPost<{
      added: PlaidTransaction[];
      modified: PlaidTransaction[];
      removed: { transaction_id: string }[];
      next_cursor: string;
      has_more: boolean;
    }>('/transactions/sync', {
      access_token: PLAID_ACCESS_TOKEN,
      ...(currentCursor ? { cursor: currentCursor } : {}),
      options: { include_original_description: true },
    });

    added = added.concat(data.added);
    modified = modified.concat(data.modified);
    removed = removed.concat(data.removed);
    currentCursor = data.next_cursor;
    hasMore = data.has_more;
  }

  return { added, modified, removed, nextCursor: currentCursor };
}

export async function fetchWeekTransactions(
  startDate: string,
  endDate: string,
): Promise<PlaidTransaction[]> {
  let allTransactions: PlaidTransaction[] = [];
  let offset = 0;
  const count = 500;

  while (true) {
    const data = await plaidPost<{
      transactions: PlaidTransaction[];
      total_transactions: number;
    }>('/transactions/get', {
      access_token: PLAID_ACCESS_TOKEN,
      start_date: startDate,
      end_date: endDate,
      options: { count, offset, include_original_description: true },
    });

    allTransactions = allTransactions.concat(data.transactions);

    if (allTransactions.length >= data.total_transactions) {
      break;
    }
    offset += count;
  }

  return allTransactions;
}
