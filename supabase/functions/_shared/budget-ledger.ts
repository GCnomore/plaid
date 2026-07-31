import type { SupabaseClient } from '@supabase/supabase-js';

import { displayMerchant, type PlaidTransaction } from './budget.ts';

export type LedgerStatus = 'pending' | 'posted' | 'excluded' | 'removed';

export interface BudgetLedgerRow {
  id: number;
  budget_key: string;
  pending_transaction_id: string | null;
  posted_transaction_id: string | null;
  amount: number;
  pending_amount: number;
  merchant_name: string | null;
  name: string | null;
  transaction_date: string;
  status: LedgerStatus;
}

function ledgerFieldsFromTx(tx: PlaidTransaction) {
  return {
    merchant_name: tx.merchant_name ?? null,
    name: tx.name ?? null,
    transaction_date: tx.date,
  };
}

async function findLedgerByKey(
  supabase: SupabaseClient,
  budgetKey: string,
): Promise<BudgetLedgerRow | null> {
  const { data, error } = await supabase
    .from('plaid_budget_ledger')
    .select('*')
    .eq('budget_key', budgetKey)
    .maybeSingle();

  if (error) throw new Error(`ledger 조회 실패: ${error.message}`);
  return data as BudgetLedgerRow | null;
}

async function findLedgerByPendingId(
  supabase: SupabaseClient,
  pendingId: string,
): Promise<BudgetLedgerRow | null> {
  const { data, error } = await supabase
    .from('plaid_budget_ledger')
    .select('*')
    .eq('pending_transaction_id', pendingId)
    .maybeSingle();

  if (error) throw new Error(`ledger pending 조회 실패: ${error.message}`);
  return data as BudgetLedgerRow | null;
}

async function upsertLedger(
  supabase: SupabaseClient,
  row: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase
    .from('plaid_budget_ledger')
    .upsert({ ...row, updated_at: new Date().toISOString() }, {
      onConflict: 'budget_key',
    });

  if (error) throw new Error(`ledger 저장 실패: ${error.message}`);
}

export async function insertPendingLedger(
  supabase: SupabaseClient,
  tx: PlaidTransaction,
): Promise<void> {
  await upsertLedger(supabase, {
    budget_key: tx.transaction_id,
    pending_transaction_id: tx.transaction_id,
    posted_transaction_id: null,
    amount: tx.amount,
    pending_amount: tx.amount,
    ...ledgerFieldsFromTx(tx),
    status: 'pending',
  });
}

export async function insertPostedLedgerNew(
  supabase: SupabaseClient,
  tx: PlaidTransaction,
): Promise<void> {
  await upsertLedger(supabase, {
    budget_key: tx.transaction_id,
    pending_transaction_id: tx.pending_transaction_id ?? null,
    posted_transaction_id: tx.transaction_id,
    amount: tx.amount,
    pending_amount: tx.amount,
    ...ledgerFieldsFromTx(tx),
    status: 'posted',
  });
}

export interface PostedLedgerResult {
  ledger: BudgetLedgerRow;
  amountChanged: boolean;
  merchantChanged: boolean;
}

export async function promoteLedgerToPosted(
  supabase: SupabaseClient,
  tx: PlaidTransaction,
): Promise<PostedLedgerResult | null> {
  const ledger = await findLedgerByKey(supabase, tx.transaction_id);
  if (!ledger || ledger.status !== 'pending') return null;

  const priorMerchant = displayMerchant({
    transaction_id: ledger.budget_key,
    account_id: '',
    amount: ledger.amount,
    merchant_name: ledger.merchant_name,
    name: ledger.name,
    date: ledger.transaction_date,
    pending: true,
  });

  const amountChanged = Math.abs(tx.amount - ledger.pending_amount) > 0.001;
  const merchantChanged = displayMerchant(tx).toLowerCase() !== priorMerchant.toLowerCase();

  const { error } = await supabase
    .from('plaid_budget_ledger')
    .update({
      posted_transaction_id: tx.transaction_id,
      amount: tx.amount,
      ...ledgerFieldsFromTx(tx),
      status: 'posted',
      updated_at: new Date().toISOString(),
    })
    .eq('budget_key', ledger.budget_key);

  if (error) throw new Error(`ledger posted 승격 실패: ${error.message}`);

  return { ledger, amountChanged, merchantChanged };
}

export async function finalizePendingLedger(
  supabase: SupabaseClient,
  tx: PlaidTransaction,
): Promise<PostedLedgerResult | null> {
  const pendingId = tx.pending_transaction_id!;
  const ledger = await findLedgerByKey(supabase, pendingId) ??
    await findLedgerByPendingId(supabase, pendingId);

  if (!ledger) return null;

  const priorMerchant = displayMerchant({
    transaction_id: ledger.budget_key,
    account_id: '',
    amount: ledger.amount,
    merchant_name: ledger.merchant_name,
    name: ledger.name,
    date: ledger.transaction_date,
    pending: true,
  });

  const amountChanged = Math.abs(tx.amount - ledger.pending_amount) > 0.001;
  const merchantChanged = displayMerchant(tx).toLowerCase() !== priorMerchant.toLowerCase();

  const { error } = await supabase
    .from('plaid_budget_ledger')
    .update({
      posted_transaction_id: tx.transaction_id,
      amount: tx.amount,
      ...ledgerFieldsFromTx(tx),
      status: 'posted',
      updated_at: new Date().toISOString(),
    })
    .eq('budget_key', ledger.budget_key);

  if (error) throw new Error(`ledger posted 업데이트 실패: ${error.message}`);

  return {
    ledger,
    amountChanged,
    merchantChanged,
  };
}

export async function updatePendingLedgerAmount(
  supabase: SupabaseClient,
  tx: PlaidTransaction,
): Promise<void> {
  const ledger = await findLedgerByKey(supabase, tx.transaction_id);
  if (!ledger || ledger.status !== 'pending') return;

  const { error } = await supabase
    .from('plaid_budget_ledger')
    .update({
      amount: tx.amount,
      pending_amount: tx.amount,
      ...ledgerFieldsFromTx(tx),
      updated_at: new Date().toISOString(),
    })
    .eq('budget_key', ledger.budget_key);

  if (error) throw new Error(`ledger pending 수정 실패: ${error.message}`);
}

export async function markLedgerRemoved(
  supabase: SupabaseClient,
  transactionId: string,
): Promise<void> {
  for (const column of ['budget_key', 'pending_transaction_id', 'posted_transaction_id'] as const) {
    const { error } = await supabase
      .from('plaid_budget_ledger')
      .update({
        status: 'removed',
        updated_at: new Date().toISOString(),
      })
      .eq(column, transactionId)
      .in('status', ['pending', 'posted']);

    if (error) throw new Error(`ledger removed 처리 실패: ${error.message}`);
  }
}

export async function getWeekSpentFromLedger(
  supabase: SupabaseClient,
  monday: string,
  sunday: string,
): Promise<number> {
  // 부호 포함 합산: 양수=지출, 음수=입금/adjustment → spent 감소
  const { data, error } = await supabase
    .from('plaid_budget_ledger')
    .select('amount')
    .in('status', ['pending', 'posted'])
    .gte('transaction_date', monday)
    .lte('transaction_date', sunday);

  if (error) throw new Error(`ledger 주간 지출 조회 실패: ${error.message}`);

  return (data ?? []).reduce((sum, row) => sum + Number(row.amount), 0);
}
