#!/usr/bin/env -S deno run --config scripts/deno.json --env-file=.env --allow-net --allow-env

/**
 * 수동 버젯 수정 스크립트 (Adjustment Transaction 방식) - Deno 버전
 *
 * 사용법:
 *   1. 아래 ADJUSTMENT_AMOUNT 값을 원하는 금액으로 변경
 *   2. deno run --config scripts/deno.json --env-file=.env --allow-net --allow-env scripts/update-budget-deno.ts
 *      또는
 *      npm run update-budget
 *      또는
 *      make update-budget
 *
 * 동작 방식:
 *   - adjustment transaction을 ledger에 추가하여 예산을 조정합니다
 *   - 양수: 예산 증가 (예: 100 = +$100 예산 추가)
 *   - 음수: 예산 감소 (예: -50 = -$50 예산 차감)
 *
 * 예시:
 *   - 예산에 $100 추가: ADJUSTMENT_AMOUNT = 100
 *   - 예산에서 $50 차감: ADJUSTMENT_AMOUNT = -50
 */

// ============================================
// 📝 여기에 조정할 금액을 입력하세요
// ============================================
const ADJUSTMENT_AMOUNT = 0; // 🔧 이 값을 수정하세요!
const ADJUSTMENT_NOTE = 'Manual Budget Adjustment'; // 🔧 메모를 수정할 수 있습니다
// ============================================

import { createClient } from '@supabase/supabase-js';

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

interface WeekDateRange {
  monday: string;
  sunday: string;
}

function getWeekDateRange(timezone: string): WeekDateRange {
  const now = new Date();

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const todayStr = formatter.format(now);

  const [y, m, d] = todayStr.split('-').map(Number);
  const todayLocal = new Date(y, m - 1, d);

  const dayOfWeek = todayLocal.getDay();
  const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;

  const monday = new Date(todayLocal);
  monday.setDate(todayLocal.getDate() - daysFromMonday);

  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  const toIsoDate = (dt: Date): string => {
    const yy = dt.getFullYear();
    const mm = String(dt.getMonth() + 1).padStart(2, '0');
    const dd = String(dt.getDate()).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
  };

  return {
    monday: toIsoDate(monday),
    sunday: toIsoDate(sunday),
  };
}

interface BudgetState {
  carryover: number;
  week_monday: string | null;
  updated_at: string;
}

async function getCurrentBudgetState(supabase: any): Promise<BudgetState> {
  const { data, error } = await supabase
    .from('plaid_sync_state')
    .select('carryover, week_monday, updated_at')
    .eq('id', 1)
    .single();

  if (error) throw new Error(`budget state 읽기 실패: ${error.message}`);

  return {
    carryover: Number(data.carryover ?? 0),
    week_monday: data.week_monday ?? null,
    updated_at: data.updated_at,
  };
}

async function getWeekSpent(supabase: any, monday: string, sunday: string): Promise<number> {
  // 부호 포함 합산: 양수=지출, 음수=입금/adjustment → spent 감소
  const { data, error } = await supabase
    .from('plaid_budget_ledger')
    .select('amount')
    .in('status', ['pending', 'posted'])
    .gte('transaction_date', monday)
    .lte('transaction_date', sunday);

  if (error) throw new Error(`주간 지출 조회 실패: ${error.message}`);

  return (data ?? []).reduce((sum: number, row: any) => sum + Number(row.amount), 0);
}

async function addAdjustmentTransaction(
  supabase: any,
  adjustmentAmount: number,
  note: string,
  weekMonday: string,
): Promise<string> {
  const timestamp = Date.now();
  const budgetKey = `adjustment-${weekMonday}-${timestamp}`;

  // Positive adjustment = increase budget = negative amount (opposite of spending)
  // Negative adjustment = decrease budget = positive amount (like spending)
  const amount = -adjustmentAmount;

  const { error } = await supabase
    .from('plaid_budget_ledger')
    .insert({
      budget_key: budgetKey,
      pending_transaction_id: null,
      posted_transaction_id: budgetKey,
      amount: amount,
      pending_amount: amount,
      merchant_name: '⚙️ Budget Adjustment',
      name: note,
      transaction_date: weekMonday,
      status: 'posted',
    });

  if (error) throw new Error(`adjustment transaction 추가 실패: ${error.message}`);

  return budgetKey;
}

async function sendSlackNotification(
  slackWebhookUrl: string,
  weeklyBudget: number,
  carryover: number,
  spent: number,
  remaining: number,
  weekRange: WeekDateRange,
  adjustmentAmount: number,
): Promise<void> {
  const formatAmount = (amt: number) => `$${Math.abs(amt).toFixed(2)}`;

  const totalBudget = weeklyBudget + carryover;
  const carryoverLine = carryover > 0
    ? `Carryover: ${formatAmount(carryover)}`
    : carryover < 0
    ? `Carryover: -${formatAmount(carryover)}`
    : 'Carryover: $0.00';

  let budgetLine: string;
  if (remaining < 0) {
    budgetLine = `*Remaining*\n🔴 ${formatAmount(remaining)} over budget`;
  } else if (remaining <= 50) {
    budgetLine = `*Remaining*\n🟡 ${formatAmount(remaining)} left`;
  } else {
    budgetLine = `*Remaining*\n${formatAmount(remaining)} left`;
  }

  const adjustmentText = adjustmentAmount > 0
    ? `Added ${formatAmount(adjustmentAmount)} to budget`
    : adjustmentAmount < 0
    ? `Deducted ${formatAmount(adjustmentAmount)} from budget`
    : 'No change';

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: '⚙️ Budget Adjustment Applied' },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Adjustment*\n${adjustmentText}` },
        {
          type: 'mrkdwn',
          text: `*Applied On*\n${new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })}`,
        },
      ],
    },
    {
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text:
            `*This Week (Mon ${weekRange.monday} - Sun ${weekRange.sunday})*\nWeekly: ${formatAmount(weeklyBudget)}\n${carryoverLine}\nTotal: ${formatAmount(totalBudget)}`,
        },
        {
          type: 'mrkdwn',
          text: `*Spent This Week*\n${formatAmount(spent)} / ${formatAmount(totalBudget)}`,
        },
      ],
    },
    {
      type: 'section',
      fields: [{ type: 'mrkdwn', text: budgetLine }],
    },
    { type: 'divider' },
  ];

  const res = await fetch(slackWebhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blocks }),
  });

  if (!res.ok) {
    throw new Error(`Slack 전송 실패: ${res.status}`);
  }
}

// Main
console.log('');
console.log('💰 Plaid Budget 수동 수정 스크립트 (Adjustment Transaction)');
console.log('===========================================================');
console.log('');

if (ADJUSTMENT_AMOUNT === 0) {
  console.log('⚠️  ADJUSTMENT_AMOUNT가 0입니다. 변경할 금액을 설정하세요.');
  console.log('');
  Deno.exit(0);
}

const supabaseUrl = requireEnv('SUPABASE_URL');
const weeklyBudget = parseFloat(Deno.env.get('WEEKLY_BUDGET') ?? '350');
const budgetTimezone = Deno.env.get('BUDGET_TIMEZONE') ?? 'America/Los_Angeles';
const slackWebhookUrl = Deno.env.get('SLACK_WEBHOOK_URL');
const supabase = createClient(supabaseUrl, getSecretKey());

// 현재 주 정보 가져오기
const weekRange = getWeekDateRange(budgetTimezone);
console.log(`📅 현재 주: ${weekRange.monday} ~ ${weekRange.sunday}`);
console.log('');

// 현재 상태 조회
console.log('📊 현재 버젯 상태 조회 중...');
const currentState = await getCurrentBudgetState(supabase);
const currentCarryover = currentState.carryover;
const currentSpent = await getWeekSpent(supabase, weekRange.monday, weekRange.sunday);
const currentTotal = weeklyBudget + currentCarryover;
const currentRemaining = currentTotal - currentSpent;

console.log('');
console.log('현재 상태 (adjustment 적용 전):');
console.log('  주간 기본 예산: $' + weeklyBudget.toFixed(2));
console.log('  이월 금액: $' + currentCarryover.toFixed(2));
console.log('  총 예산: $' + currentTotal.toFixed(2));
console.log('  지출: $' + currentSpent.toFixed(2));
console.log('  남은 금액: $' + currentRemaining.toFixed(2));
console.log('');

// Adjustment 적용
const adjSign = ADJUSTMENT_AMOUNT > 0 ? '+' : '';
console.log(`🔄 Adjustment transaction 추가 중: ${adjSign}$${ADJUSTMENT_AMOUNT.toFixed(2)}...`);
const budgetKey = await addAdjustmentTransaction(
  supabase,
  ADJUSTMENT_AMOUNT,
  ADJUSTMENT_NOTE,
  weekRange.monday,
);
console.log(`✅ Transaction 추가 완료: ${budgetKey}`);
console.log('');

// 업데이트된 상태 조회
console.log('📊 업데이트된 상태 조회 중...');
const newSpent = await getWeekSpent(supabase, weekRange.monday, weekRange.sunday);
const newTotal = weeklyBudget + currentCarryover;
const newRemaining = newTotal - newSpent;

console.log('');
console.log('새로운 상태 (adjustment 적용 후):');
console.log('  주간 기본 예산: $' + weeklyBudget.toFixed(2));
console.log('  이월 금액: $' + currentCarryover.toFixed(2));
console.log('  총 예산: $' + newTotal.toFixed(2));
console.log('  지출: $' + newSpent.toFixed(2));
console.log('  남은 금액: $' + newRemaining.toFixed(2));
console.log('  실질 예산 효과: $' + (newRemaining - currentRemaining).toFixed(2));
console.log('');

// Slack 알림 전송
if (slackWebhookUrl) {
  console.log('📣 Slack 알림 전송 중...');
  await sendSlackNotification(
    slackWebhookUrl,
    weeklyBudget,
    currentCarryover,
    newSpent,
    newRemaining,
    weekRange,
    ADJUSTMENT_AMOUNT,
  );
  console.log('✅ Slack 알림 전송 완료');
} else {
  console.log('ℹ️  SLACK_WEBHOOK_URL이 설정되지 않아 Slack 알림을 생략합니다');
}

console.log('');
console.log('✅ 완료!');
console.log('');
console.log('💡 팁:');
console.log('  - 주간 기본 예산을 변경하려면 .env의 WEEKLY_BUDGET을 수정하세요');
console.log('  - 추가 adjustment가 필요하면 ADJUSTMENT_AMOUNT를 변경하고 다시 실행하세요');
console.log('  - adjustment는 누적됩니다 (이전 adjustment를 덮어쓰지 않습니다)');
console.log('');
