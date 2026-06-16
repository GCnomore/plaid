import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from '@supabase/supabase-js';

import { resolveCarryover } from './budget-state.ts';
import { BUDGET_TIMEZONE, getWeekDateRange } from './budget.ts';
import { syncTransactions } from './plaid.ts';
import { sendSlackMessage } from './slack.ts';
import {
  calculateBudgetSummaryFromDb,
  processSyncUpdates,
} from './transaction-store.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;

function getSecretKey(): string {
  const secretKeysJson = Deno.env.get('SUPABASE_SECRET_KEYS');
  if (secretKeysJson) {
    const key = (JSON.parse(secretKeysJson) as Record<string, string>)['default'];
    if (key) return key;
  }
  throw new Error('SUPABASE_SECRET_KEYS env에 default 키가 없습니다');
}

function supabase() {
  return createClient(SUPABASE_URL, getSecretKey());
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

async function saveWebhookLog(body: Record<string, unknown>): Promise<void> {
  const { error } = await supabase()
    .from('plaid_webhook_logs')
    .insert({
      webhook_type: (body.webhook_type as string) ?? null,
      webhook_code: (body.webhook_code as string) ?? null,
      item_id: (body.item_id as string) ?? null,
      payload: body,
    });

  if (error) throw new Error(`webhook 로그 저장 실패: ${error.message}`);
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

  const url = new URL(req.url);

  if (url.searchParams.get('bootstrap') === '1') {
    try {
      const currentCursor = await readCursor();
      await bootstrapSync(currentCursor);
      console.log('✅ Bootstrap 완료, cursor 저장 + 거래 DB 적재');
      return new Response(JSON.stringify({ ok: true, bootstrapped: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err: any) {
      console.error('❌ Bootstrap 오류:', err.message);
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  try {
    await saveWebhookLog(body);
  } catch (err: any) {
    console.error('❌ webhook 로그 저장 오류:', err.message);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { webhook_type, webhook_code } = body;

  console.log(`[Webhook] type=${webhook_type}, code=${webhook_code}`);

  if (webhook_type !== 'TRANSACTIONS' || webhook_code !== 'SYNC_UPDATES_AVAILABLE') {
    return new Response(JSON.stringify({ skipped: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const cursor = await readCursor();
    const db = supabase();

    if (!cursor) {
      await bootstrapSync('');
      console.log('✅ 초기 cursor 저장 + 거래 DB 적재 (Slack 알림 없음)');
      return new Response(JSON.stringify({ ok: true, bootstrapped: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const { added, modified, removed, nextCursor } = await syncTransactions(cursor);
    await saveCursor(nextCursor);

    const notifications = await processSyncUpdates(
      db,
      { added, modified, removed },
      { notify: true },
    );

    if (notifications.length === 0) {
      return new Response(JSON.stringify({ ok: true, sent: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const carryover = await resolveCarryover(db);
    const weekRange = getWeekDateRange(BUDGET_TIMEZONE);
    const budget = await calculateBudgetSummaryFromDb(db, weekRange, carryover);

    let sent = 0;
    for (const { tx, kind, priorAmount, priorMerchant } of notifications) {
      const prior = priorAmount !== undefined && priorMerchant !== undefined
        ? { amount: priorAmount, merchant: priorMerchant }
        : undefined;
      await sendSlackMessage(tx, budget, kind, prior);
      sent++;
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
