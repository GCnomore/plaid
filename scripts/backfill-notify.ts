/**
 * ONE-TIME backfill: cursor 리셋 → 전체 sync → DB 저장 + Slack 알림
 *
 *   make backfill-notify
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { refreshTransactions, syncTransactions } from '../supabase/functions/plaid-webhook/plaid.ts';
import { sendNotificationBatch } from '../supabase/functions/plaid-webhook/notifications.ts';
import { processSyncUpdates } from '../supabase/functions/plaid-webhook/transaction-store.ts';

const REFRESH_WAIT_MS = parseInt(Deno.env.get('REFRESH_WAIT_MS') ?? '5000', 10);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resetForBackfill(supabase: SupabaseClient): Promise<void> {
  const { error: ledgerError } = await supabase
    .from('plaid_budget_ledger')
    .delete()
    .neq('budget_key', '');

  if (ledgerError) throw new Error(`plaid_budget_ledger 비우기 실패: ${ledgerError.message}`);

  const { error: txError } = await supabase
    .from('plaid_budget_transactions')
    .delete()
    .neq('transaction_id', '');

  if (txError) throw new Error(`plaid_budget_transactions 비우기 실패: ${txError.message}`);

  const { error: cursorError } = await supabase
    .from('plaid_sync_state')
    .update({ cursor: '', updated_at: new Date().toISOString() })
    .eq('id', 1);

  if (cursorError) throw new Error(`cursor 리셋 실패: ${cursorError.message}`);
}

async function saveCursor(supabase: SupabaseClient, cursor: string): Promise<void> {
  const { error } = await supabase
    .from('plaid_sync_state')
    .update({ cursor, updated_at: new Date().toISOString() })
    .eq('id', 1);

  if (error) throw new Error(`cursor 저장 실패: ${error.message}`);
}

console.log('⚠️  ONE-TIME BACKFILL — cursor/ledger 리셋 + 전체 sync + Slack');
console.log('');

const supabaseUrl = requireEnv('SUPABASE_URL');
const supabase = createClient(supabaseUrl, getSecretKey());

console.log('🗑️  ledger + transactions 삭제, cursor 리셋...');
await resetForBackfill(supabase);
console.log('✅ 리셋 완료');

console.log('🔄 /transactions/refresh 호출...');
const refresh = await refreshTransactions();
console.log(`✅ refresh 요청 완료 (request_id: ${refresh.request_id})`);

console.log(`⏳ ${REFRESH_WAIT_MS}ms 대기 후 전체 sync...`);
await sleep(REFRESH_WAIT_MS);

console.log('🔄 /transactions/sync (cursor=empty, paginate)...');
const { added, modified, removed, nextCursor } = await syncTransactions('');

console.log(
  `📦 sync 결과: added=${added.length}, modified=${modified.length}, removed=${removed.length}`,
);

if (added.length + modified.length + removed.length === 0) {
  console.error('❌ sync 결과가 비어 있습니다. Plaid Item 상태를 확인하세요.');
  Deno.exit(1);
}

const notifications = await processSyncUpdates(
  supabase,
  { added, modified, removed },
  { notify: true },
);

await saveCursor(supabase, nextCursor);
console.log(`✅ cursor 저장: ${nextCursor.slice(0, 20)}...`);
console.log(`💾 DB 저장 완료 (알림 대상: ${notifications.length}건)`);

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
console.log(`✅ backfill 완료 — ${sent}건 Slack 전송`);
console.log('ℹ️  이후에는 make sync / make sync-notify 를 사용하세요.');
