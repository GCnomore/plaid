/**
 * Budget Status Function
 *
 * 수동 요청 시 현재 주간 예산 상태를 Slack으로 전송합니다.
 *
 * Usage:
 *   POST /functions/v1/budget-status
 *   또는
 *   make check-budget
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from '@supabase/supabase-js';

import { resolveCarryover } from '../_shared/budget-state.ts';
import {
  buildBudgetSummaryFromSpent,
  BUDGET_TIMEZONE,
  getWeekDateRange,
  WEEKLY_BUDGET,
} from '../_shared/budget.ts';
import { getWeekSpentFromLedger } from '../_shared/budget-ledger.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SLACK_WEBHOOK_URL = Deno.env.get('SLACK_WEBHOOK_URL');

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

async function sendBudgetStatusToSlack(
  weekRange: { monday: string; sunday: string; label: string },
  carryover: number,
  spent: number,
) {
  if (!SLACK_WEBHOOK_URL) {
    console.log('⚠️  SLACK_WEBHOOK_URL이 설정되지 않았습니다. Slack 전송 스킵.');
    return;
  }

  const totalBudget = WEEKLY_BUDGET + carryover;
  const remaining = totalBudget - spent;
  const percentUsed = totalBudget > 0 ? (spent / totalBudget) * 100 : 0;

  // 색상 결정
  let color = 'good'; // 초록색
  let emoji = '✅';
  if (remaining < totalBudget * 0.2) {
    color = 'danger'; // 빨간색
    emoji = '🚨';
  } else if (remaining < totalBudget * 0.5) {
    color = 'warning'; // 노란색
    emoji = '⚠️';
  }

  const message = {
    text: `${emoji} Weekly Budget Status`,
    attachments: [
      {
        color,
        fields: [
          {
            title: 'This Week',
            value: weekRange.label,
            short: false,
          },
          {
            title: 'Weekly Budget',
            value: `$${WEEKLY_BUDGET.toFixed(2)}`,
            short: true,
          },
          {
            title: 'Carryover',
            value: `${carryover >= 0 ? '+' : ''}$${carryover.toFixed(2)}`,
            short: true,
          },
          {
            title: 'Total Budget',
            value: `$${totalBudget.toFixed(2)}`,
            short: true,
          },
          {
            title: 'Spent',
            value: `$${spent.toFixed(2)} (${percentUsed.toFixed(1)}%)`,
            short: true,
          },
          {
            title: 'Remaining',
            value: `$${remaining.toFixed(2)}`,
            short: false,
          },
        ],
        footer: '💰 Budget Status Check',
        ts: Math.floor(Date.now() / 1000),
      },
    ],
  };

  const response = await fetch(SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
  });

  if (!response.ok) {
    throw new Error(`Slack 전송 실패: ${response.status} ${response.statusText}`);
  }
}

serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  try {
    console.log('📊 현재 주간 예산 상태 조회 중...');

    const db = supabase();
    const weekRange = getWeekDateRange(BUDGET_TIMEZONE);
    const carryover = await resolveCarryover(db);
    const spent = await getWeekSpentFromLedger(db, weekRange.monday, weekRange.sunday);

    console.log(`주간 범위: ${weekRange.monday} ~ ${weekRange.sunday}`);
    console.log(`주간 예산: $${WEEKLY_BUDGET.toFixed(2)}`);
    console.log(`이월: $${carryover.toFixed(2)}`);
    console.log(`지출: $${spent.toFixed(2)}`);
    console.log(`총 예산: $${(WEEKLY_BUDGET + carryover).toFixed(2)}`);
    console.log(`남은 예산: $${(WEEKLY_BUDGET + carryover - spent).toFixed(2)}`);

    await sendBudgetStatusToSlack(weekRange, carryover, spent);

    console.log('✅ Slack 전송 완료');

    return new Response(
      JSON.stringify({
        ok: true,
        budget: {
          week: weekRange,
          weekly_budget: WEEKLY_BUDGET,
          carryover,
          total_budget: WEEKLY_BUDGET + carryover,
          spent,
          remaining: WEEKLY_BUDGET + carryover - spent,
        },
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  } catch (err: any) {
    console.error('❌ 오류:', err.message);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
