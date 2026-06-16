/**
 * Plaid refresh → sync → DB 저장 (수동 실행)
 *
 *   make sync
 *   make sync-notify
 *   npm run sync
 *   npm run sync:notify
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { resolveCarryover } from '../supabase/functions/plaid-webhook/budget-state.ts';
import { refreshTransactions, syncTransactions } from '../supabase/functions/plaid-webhook/plaid.ts';
import { sendNotificationBatch } from '../supabase/functions/plaid-webhook/notifications.ts';
import { processSyncUpdates } from '../supabase/functions/plaid-webhook/transaction-store.ts';

const REFRESH_WAIT_MS = parseInt(Deno.env.get('REFRESH_WAIT_MS') ?? '5000', 10);
const SYNC_RETRY_COUNT = parseInt(Deno.env.get('SYNC_RETRY_COUNT') ?? '3', 10);
const SYNC_RETRY_WAIT_MS = parseInt(Deno.env.get('SYNC_RETRY_WAIT_MS') ?? '5000', 10);

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

async function readCursor(supabase: SupabaseClient): Promise<string> {
  const { data, error } = await supabase
    .from('plaid_sync_state')
    .select('cursor')
    .eq('id', 1)
    .single();

  if (error) throw new Error(`cursor 읽기 실패: ${error.message}`);
  return (data as { cursor: string | null }).cursor ?? '';
}

async function saveCursor(supabase: SupabaseClient, cursor: string): Promise<void> {
  const { error } = await supabase
    .from('plaid_sync_state')
    .update({ cursor, updated_at: new Date().toISOString() })
    .eq('id', 1);

  if (error) throw new Error(`cursor 저장 실패: ${error.message}`);
}

async function syncWithRetry(cursor: string) {
  let lastResult = await syncTransactions(cursor);

  for (let attempt = 1; attempt < SYNC_RETRY_COUNT; attempt++) {
    const total = lastResult.added.length + lastResult.modified.length +
      lastResult.removed.length;
    if (total > 0) break;

    console.log(
      `⏳ 변경 없음 — refresh 반영 대기 (${attempt}/${SYNC_RETRY_COUNT - 1}), ` +
        `${SYNC_RETRY_WAIT_MS}ms 후 재시도...`,
    );
    await sleep(SYNC_RETRY_WAIT_MS);
    lastResult = await syncTransactions(cursor);
  }

  return lastResult;
}

const notify = Deno.args.includes('--notify');

console.log('🔄 /transactions/refresh 호출...');
const refresh = await refreshTransactions();
console.log(`✅ refresh 요청 완료 (request_id: ${refresh.request_id})`);

console.log(`⏳ ${REFRESH_WAIT_MS}ms 대기 후 sync...`);
await sleep(REFRESH_WAIT_MS);

const supabaseUrl = requireEnv('SUPABASE_URL');
const supabase = createClient(supabaseUrl, getSecretKey());

const cursor = await readCursor(supabase);
console.log(`📌 cursor: ${cursor ? `${cursor.slice(0, 20)}...` : '(empty — 첫 sync)'}`);

console.log('🔄 /transactions/sync 호출...');
const { added, modified, removed, nextCursor } = await syncWithRetry(cursor);

console.log(
  `📦 sync 결과: added=${added.length}, modified=${modified.length}, removed=${removed.length}`,
);

await saveCursor(supabase, nextCursor);
console.log(`✅ cursor 저장: ${nextCursor.slice(0, 20)}...`);

const notifications = await processSyncUpdates(
  supabase,
  { added, modified, removed },
  { notify },
);

console.log(`💾 DB 저장 완료 (알림 대상: ${notifications.length}건)`);

if (notifications.length > 0 && notify) {
  const sent = await sendNotificationBatch(supabase, notifications);
  for (const { tx, kind } of notifications) {
    console.log(`📣 Slack [${kind}]: ${tx.merchant_name || tx.name} ${tx.amount}`);
  }
  console.log(`📣 Slack ${sent}건 전송`);
} else {
  if (notifications.length > 0) {
    console.log('ℹ️  --notify 없음: Slack 생략');
  }
  await resolveCarryover(supabase);
}

console.log('✅ 완료');
