import type { SupabaseClient } from '@supabase/supabase-js';

import {
  finalizePendingLedger,
  getWeekSpentFromLedger,
  insertPendingLedger,
  insertPostedLedgerNew,
  markLedgerRemoved,
  promoteLedgerToPosted,
  updatePendingLedgerAmount,
} from './budget-ledger.ts';
import {
  buildBudgetSummaryFromSpent,
  displayMerchant,
  isExcluded,
  type PlaidTransaction,
  type BudgetSummary,
  type WeekDateRange,
} from './budget.ts';

export interface BudgetTransactionRow {
  transaction_id: string;
  pending_transaction_id: string | null;
  amount: number;
  merchant_name: string | null;
  name: string | null;
  transaction_date: string;
  pending: boolean;
  excluded: boolean;
  counts_in_budget: boolean;
  notified_at: string | null;
  superseded_by: string | null;
  removed_at: string | null;
}

export type NotifyKind = 'pending' | 'posted_confirm' | 'posted_new';

export interface NotifyRequest {
  tx: PlaidTransaction;
  kind: NotifyKind;
  priorAmount?: number;
  priorMerchant?: string;
}

interface SyncBatch {
  added: PlaidTransaction[];
  modified: PlaidTransaction[];
  removed: { transaction_id: string }[];
}

interface ProcessOptions {
  notify: boolean;
}

function rowToTx(row: BudgetTransactionRow): PlaidTransaction {
  return {
    transaction_id: row.transaction_id,
    account_id: '',
    amount: Number(row.amount),
    merchant_name: row.merchant_name,
    name: row.name,
    date: row.transaction_date,
    pending: row.pending,
    pending_transaction_id: row.pending_transaction_id,
  };
}

async function findRow(
  supabase: SupabaseClient,
  transactionId: string,
): Promise<BudgetTransactionRow | null> {
  const { data, error } = await supabase
    .from('plaid_budget_transactions')
    .select('*')
    .eq('transaction_id', transactionId)
    .maybeSingle();

  if (error) throw new Error(`거래 조회 실패: ${error.message}`);
  return data as BudgetTransactionRow | null;
}

async function upsertRow(
  supabase: SupabaseClient,
  row: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase
    .from('plaid_budget_transactions')
    .upsert({ ...row, updated_at: new Date().toISOString() }, {
      onConflict: 'transaction_id',
    });

  if (error) throw new Error(`거래 저장 실패: ${error.message}`);
}

async function markRemoved(
  supabase: SupabaseClient,
  transactionId: string,
): Promise<void> {
  const { error } = await supabase
    .from('plaid_budget_transactions')
    .update({
      removed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('transaction_id', transactionId);

  if (error) throw new Error(`거래 removed 처리 실패: ${error.message}`);

  await markLedgerRemoved(supabase, transactionId);
}

async function markSuperseded(
  supabase: SupabaseClient,
  pendingId: string,
  postedId: string,
): Promise<BudgetTransactionRow | null> {
  const pending = await findRow(supabase, pendingId);
  if (!pending) return null;

  const { error } = await supabase
    .from('plaid_budget_transactions')
    .update({
      superseded_by: postedId,
      removed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('transaction_id', pendingId);

  if (error) throw new Error(`pending 대체 표시 실패: ${error.message}`);
  return pending;
}

function buildRow(tx: PlaidTransaction, excluded: boolean): Record<string, unknown> {
  return {
    transaction_id: tx.transaction_id,
    pending_transaction_id: tx.pending_transaction_id ?? null,
    amount: tx.amount,
    merchant_name: tx.merchant_name ?? null,
    name: tx.name ?? null,
    transaction_date: tx.date,
    pending: tx.pending,
    excluded,
    counts_in_budget: !excluded,
  };
}

async function notifyForPosted(
  tx: PlaidTransaction,
  notify: boolean,
  ledgerResult: Awaited<ReturnType<typeof finalizePendingLedger>>,
  prior: BudgetTransactionRow | null,
): Promise<NotifyRequest | null> {
  if (!notify) return null;

  if (ledgerResult) {
    if (ledgerResult.amountChanged || ledgerResult.merchantChanged) {
      return {
        tx,
        kind: 'posted_confirm',
        priorAmount: ledgerResult.ledger.pending_amount,
        priorMerchant: displayMerchant({
          transaction_id: ledgerResult.ledger.budget_key,
          account_id: '',
          amount: ledgerResult.ledger.pending_amount,
          merchant_name: ledgerResult.ledger.merchant_name,
          name: ledgerResult.ledger.name,
          date: ledgerResult.ledger.transaction_date,
          pending: true,
        }),
      };
    }
    return null;
  }

  if (prior) {
    const priorTx = rowToTx(prior);
    const merchantChanged = displayMerchant(tx).toLowerCase() !==
      displayMerchant(priorTx).toLowerCase();
    const amountChanged = Math.abs(tx.amount - prior.amount) > 0.001;
    if (merchantChanged || amountChanged) {
      return {
        tx,
        kind: 'posted_confirm',
        priorAmount: prior.amount,
        priorMerchant: displayMerchant(priorTx),
      };
    }
    return null;
  }

  return { tx, kind: 'posted_new' };
}

async function handleAdded(
  supabase: SupabaseClient,
  tx: PlaidTransaction,
  notify: boolean,
): Promise<NotifyRequest | null> {
  const existing = await findRow(supabase, tx.transaction_id);
  if (existing && !existing.removed_at) {
    return null;
  }

  const excluded = isExcluded(tx);

  if (excluded) {
    await upsertRow(supabase, buildRow(tx, true));
    console.log(`⏭️ 제외 거래 (기록만): ${displayMerchant(tx)} ${tx.amount}`);
    return null;
  }

  if (tx.pending) {
    await upsertRow(supabase, {
      ...buildRow(tx, false),
      notified_at: notify ? new Date().toISOString() : null,
    });
    await insertPendingLedger(supabase, tx);
    return notify ? { tx, kind: 'pending' } : null;
  }

  let prior: BudgetTransactionRow | null = null;
  if (tx.pending_transaction_id) {
    prior = await markSuperseded(supabase, tx.pending_transaction_id, tx.transaction_id);
  }

  const ledgerResult = tx.pending_transaction_id
    ? await finalizePendingLedger(supabase, tx)
    : null;

  if (!ledgerResult) {
    await insertPostedLedgerNew(supabase, tx);
  }

  await upsertRow(supabase, { ...buildRow(tx, false), notified_at: null });
  return notifyForPosted(tx, notify, ledgerResult, prior);
}

async function handleModified(
  supabase: SupabaseClient,
  tx: PlaidTransaction,
  notify: boolean,
): Promise<NotifyRequest | null> {
  const existing = await findRow(supabase, tx.transaction_id);
  const excluded = isExcluded(tx);

  if (excluded) {
    await upsertRow(supabase, buildRow(tx, true));
    return null;
  }

  const wasPending = existing?.pending ?? tx.pending;

  if (tx.pending) {
    await upsertRow(supabase, {
      ...buildRow(tx, false),
      notified_at: existing?.notified_at ?? null,
    });
    await updatePendingLedgerAmount(supabase, tx);
    return null;
  }

  if (wasPending && !tx.pending) {
    let prior: BudgetTransactionRow | null = existing;
    if (tx.pending_transaction_id) {
      prior = await markSuperseded(supabase, tx.pending_transaction_id, tx.transaction_id) ??
        existing;
    }

    const ledgerResult = tx.pending_transaction_id
      ? await finalizePendingLedger(supabase, tx)
      : await promoteLedgerToPosted(supabase, tx);

    if (!ledgerResult) {
      await insertPostedLedgerNew(supabase, tx);
    }

    await upsertRow(supabase, { ...buildRow(tx, false), notified_at: null });
    return notifyForPosted(tx, notify, ledgerResult, prior);
  }

  await upsertRow(supabase, {
    ...buildRow(tx, false),
    notified_at: existing?.notified_at ?? null,
  });
  return null;
}

export async function processSyncUpdates(
  supabase: SupabaseClient,
  batch: SyncBatch,
  options: ProcessOptions,
): Promise<NotifyRequest[]> {
  const { notify } = options;
  const notifications: NotifyRequest[] = [];

  for (const { transaction_id } of batch.removed) {
    await markRemoved(supabase, transaction_id);
    console.log(`🗑️ removed: ${transaction_id}`);
  }

  for (const tx of batch.modified) {
    const req = await handleModified(supabase, tx, notify);
    if (req) notifications.push(req);
  }

  for (const tx of batch.added) {
    const req = await handleAdded(supabase, tx, notify);
    if (req) notifications.push(req);
  }

  return notifications;
}

export async function getWeekSpentFromDb(
  supabase: SupabaseClient,
  monday: string,
  sunday: string,
): Promise<number> {
  return getWeekSpentFromLedger(supabase, monday, sunday);
}

export async function calculateBudgetSummaryFromDb(
  supabase: SupabaseClient,
  weekRange: WeekDateRange,
  carryover: number,
): Promise<BudgetSummary> {
  const spent = await getWeekSpentFromLedger(supabase, weekRange.monday, weekRange.sunday);
  return buildBudgetSummaryFromSpent(weekRange, carryover, spent);
}

export async function ingestSyncSilently(
  supabase: SupabaseClient,
  cursor: string,
  syncFn: (cursor: string) => Promise<SyncBatch & { nextCursor: string }>,
): Promise<string> {
  const { added, modified, removed, nextCursor } = await syncFn(cursor);
  await processSyncUpdates(supabase, { added, modified, removed }, { notify: false });
  return nextCursor;
}
