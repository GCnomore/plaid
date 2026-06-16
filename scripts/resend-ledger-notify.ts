/**
 * 이번 주 ledger 기준 Slack 재전송 (Plaid sync / DB 변경 없음)
 *
 *   make resend-ledger-notify
 */

import { createClient } from '@supabase/supabase-js';

import type { BudgetLedgerRow } from '../supabase/functions/plaid-webhook/budget-ledger.ts';
import { BUDGET_TIMEZONE, displayMerchant, getWeekDateRange } from '../supabase/functions/plaid-webhook/budget.ts';
import { sendNotificationBatch } from '../supabase/functions/plaid-webhook/notifications.ts';
import type { NotifyRequest } from '../supabase/functions/plaid-webhook/transaction-store.ts';
import type { PlaidTransaction } from '../supabase/functions/plaid-webhook/budget.ts';

const SLACK_DELAY_MS = parseInt(Deno.env.get('SLACK_DELAY_MS') ?? '300', 10);

function getSecretKey(): string {
  const secretKeysJson = Deno.env.get('SUPABASE_SECRET_KEYS');
  if (secretKeysJson) {
    const key = (JSON.parse(secretKeysJson) as Record<string, string>)['default'];
    if (key) return key;
  }
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (legacy) return legacy;
  throw new Error('SUPABASE_SECRET_KEYS 또는 SUPABASE_SERVICE_ROLE_KEY가 필요합니다');
}

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} env가 필요합니다`);
  return value;
}

function ledgerToTx(row: BudgetLedgerRow): PlaidTransaction {
  const transactionId = row.posted_transaction_id ?? row.budget_key;
  return {
    transaction_id: transactionId,
    account_id: '',
    amount: Number(row.amount),
    merchant_name: row.merchant_name,
    name: row.name,
    date: row.transaction_date,
    pending: row.status === 'pending',
    pending_transaction_id: row.pending_transaction_id,
  };
}

function ledgerToNotify(row: BudgetLedgerRow): NotifyRequest | null {
  const tx = ledgerToTx(row);
  const amount = Number(row.amount);
  const pendingAmount = Number(row.pending_amount);

  if (row.status === 'pending') {
    return { tx, kind: 'pending' };
  }

  if (row.status !== 'posted') {
    return null;
  }

  if (Math.abs(amount - pendingAmount) > 0.001) {
    return {
      tx,
      kind: 'posted_confirm',
      priorAmount: pendingAmount,
      priorMerchant: displayMerchant({
        transaction_id: row.budget_key,
        account_id: '',
        amount: pendingAmount,
        merchant_name: row.merchant_name,
        name: row.name,
        date: row.transaction_date,
        pending: true,
      }),
    };
  }

  const promotedFromPending = row.posted_transaction_id != null &&
    row.budget_key !== row.posted_transaction_id;
  if (promotedFromPending) {
    return null;
  }

  return { tx, kind: 'posted_new' };
}

const supabase = createClient(requireEnv('SUPABASE_URL'), getSecretKey());
const weekRange = getWeekDateRange(BUDGET_TIMEZONE);

console.log(`📅 이번 주: ${weekRange.label} (${weekRange.monday} ~ ${weekRange.sunday})`);

const { data, error } = await supabase
  .from('plaid_budget_ledger')
  .select('*')
  .in('status', ['pending', 'posted'])
  .gte('transaction_date', weekRange.monday)
  .lte('transaction_date', weekRange.sunday)
  .order('transaction_date', { ascending: true })
  .order('created_at', { ascending: true });

if (error) throw new Error(`ledger 조회 실패: ${error.message}`);

const rows = (data ?? []) as BudgetLedgerRow[];
const notifications = rows
  .map(ledgerToNotify)
  .filter((n): n is NotifyRequest => n !== null);

console.log(`📦 ledger ${rows.length}건 → 알림 대상 ${notifications.length}건`);

if (notifications.length === 0) {
  console.log('ℹ️  보낼 알림이 없습니다.');
  Deno.exit(0);
}

const sent = await sendNotificationBatch(supabase, notifications, {
  startingSpent: 0,
  delayMs: SLACK_DELAY_MS,
});

for (let i = 0; i < notifications.length; i++) {
  const { tx, kind } = notifications[i];
  console.log(`📣 Slack [${kind}] (${i + 1}/${notifications.length}): ${
    tx.merchant_name || tx.name
  } ${tx.amount}`);
}

console.log('');
console.log(`✅ 완료 — ${sent}건 Slack 전송`);
