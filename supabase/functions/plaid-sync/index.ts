/**
 * Hourly polling entrypoint (pg_cron → trigger_plaid_sync_v2 → this function).
 * Shares budget/spent/Slack logic with plaid-webhook via ../_shared.
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from '@supabase/supabase-js';

import { resolveCarryover } from '../_shared/budget-state.ts';
import { refreshTransactions, syncTransactions } from '../_shared/plaid.ts';
import { sendNotificationBatch } from '../_shared/notifications.ts';
import { processSyncUpdates } from '../_shared/transaction-store.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const REFRESH_WAIT_MS = parseInt(Deno.env.get('REFRESH_WAIT_MS') ?? '3000', 10);
const SYNC_RETRY_COUNT = parseInt(Deno.env.get('SYNC_RETRY_COUNT') ?? '2', 10);
const SYNC_RETRY_WAIT_MS = parseInt(Deno.env.get('SYNC_RETRY_WAIT_MS') ?? '3000', 10);

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

function supabase() {
  return createClient(SUPABASE_URL, getSecretKey());
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readCursor(): Promise<string> {
  const { data, error } = await supabase()
    .from('plaid_sync_state')
    .select('cursor')
    .eq('id', 1)
    .single();

  if (error) throw new Error(`cursor 읽기 실패: ${error.message}`);
  return data.cursor ?? '';
}

async function saveCursor(cursor: string): Promise<void> {
  const { error } = await supabase()
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

async function bootstrapSync(cursor: string): Promise<void> {
  const { added, modified, removed, nextCursor } = await syncTransactions(cursor);
  await processSyncUpdates(supabase(), { added, modified, removed }, { notify: false });
  await saveCursor(nextCursor);
}

serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  // Cron sends body '{}'; ignore payload.
  try {
    await req.text();
  } catch {
    // ignore
  }

  try {
    const db = supabase();
    const cursor = await readCursor();

    if (!cursor) {
      console.log('📌 cursor empty — bootstrap (Slack 없음)');
      await bootstrapSync('');
      return new Response(JSON.stringify({ ok: true, bootstrapped: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    console.log('🔄 /transactions/refresh 호출...');
    try {
      const refresh = await refreshTransactions();
      console.log(`✅ refresh 요청 완료 (request_id: ${refresh.request_id})`);
      await sleep(REFRESH_WAIT_MS);
    } catch (err: any) {
      // refresh 실패해도 sync는 시도 (이미 알려진 거래 반영)
      console.warn(`⚠️ refresh 실패, sync 계속: ${err.message}`);
    }

    console.log(`📌 cursor: ${cursor.slice(0, 20)}...`);
    console.log('🔄 /transactions/sync 호출...');
    const { added, modified, removed, nextCursor } = await syncWithRetry(cursor);

    console.log(
      `📦 sync 결과: added=${added.length}, modified=${modified.length}, removed=${removed.length}`,
    );

    await saveCursor(nextCursor);

    const notifications = await processSyncUpdates(
      db,
      { added, modified, removed },
      { notify: true },
    );

    console.log(`💾 DB 저장 완료 (알림 대상: ${notifications.length}건)`);

    if (notifications.length === 0) {
      await resolveCarryover(db);
      return new Response(JSON.stringify({ ok: true, sent: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const sent = await sendNotificationBatch(db, notifications);

    for (const { tx, kind } of notifications) {
      console.log(`✅ Slack 전송 [${kind}]: ${tx.merchant_name || tx.name} ${tx.amount}`);
    }

    return new Response(JSON.stringify({ ok: true, sent }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error('❌ 오류:', err.message);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
