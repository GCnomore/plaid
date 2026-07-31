#!/usr/bin/env node

/**
 * 수동 버젯 수정 스크립트 (Adjustment Transaction 방식)
 *
 * 사용법:
 *   1. 아래 ADJUSTMENT_AMOUNT 값을 원하는 금액으로 변경
 *   2. node scripts/update-budget.js 실행
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
const ADJUSTMENT_AMOUNT = 0;  // 🔧 이 값을 수정하세요!
const ADJUSTMENT_NOTE = 'Manual Adjustment';  // 🔧 메모를 수정할 수 있습니다
// ============================================

const https = require('https');
const http = require('http');

// .env 파일 로드 (간단한 구현)
function loadEnv() {
  const fs = require('fs');
  const path = require('path');
  const envPath = path.join(__dirname, '..', '.env');

  if (!fs.existsSync(envPath)) {
    console.error('❌ .env 파일을 찾을 수 없습니다');
    process.exit(1);
  }

  const envContent = fs.readFileSync(envPath, 'utf8');
  const lines = envContent.split('\n');

  const env = {};
  lines.forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;

    const [key, ...valueParts] = trimmed.split('=');
    if (key && valueParts.length > 0) {
      env[key.trim()] = valueParts.join('=').trim();
    }
  });

  return env;
}

function getSupabaseKey(env) {
  if (env.SUPABASE_SECRET_KEYS) {
    try {
      const keys = JSON.parse(env.SUPABASE_SECRET_KEYS);
      if (keys.default) return keys.default;
    } catch (e) {
      console.error('❌ SUPABASE_SECRET_KEYS 파싱 실패:', e.message);
    }
  }

  if (env.SUPABASE_SERVICE_ROLE_KEY) {
    return env.SUPABASE_SERVICE_ROLE_KEY;
  }

  console.error('❌ SUPABASE_SECRET_KEYS 또는 SUPABASE_SERVICE_ROLE_KEY가 필요합니다');
  process.exit(1);
}

function makeRequest(url, options, body = null) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const protocol = parsedUrl.protocol === 'https:' ? https : http;

    const reqOptions = {
      ...options,
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
    };

    const req = protocol.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${JSON.stringify(parsed)}`));
          } else {
            resolve(parsed);
          }
        } catch (e) {
          reject(new Error(`응답 파싱 실패: ${data}`));
        }
      });
    });

    req.on('error', reject);

    if (body) {
      req.write(JSON.stringify(body));
    }

    req.end();
  });
}

function getWeekDateRange(timezone) {
  const now = new Date();

  // Get current date in target timezone
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const todayStr = formatter.format(now); // 'YYYY-MM-DD'

  const [y, m, d] = todayStr.split('-').map(Number);
  const todayLocal = new Date(y, m - 1, d);

  // Calculate Monday of current week
  const dayOfWeek = todayLocal.getDay(); // 0=Sun
  const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;

  const monday = new Date(todayLocal);
  monday.setDate(todayLocal.getDate() - daysFromMonday);

  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  const toIsoDate = (dt) => {
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

async function getCurrentBudgetState(supabaseUrl, apiKey) {
  const url = `${supabaseUrl}/rest/v1/plaid_sync_state?id=eq.1&select=carryover,week_monday,cursor,updated_at`;

  const response = await makeRequest(url, {
    method: 'GET',
    headers: {
      'apikey': apiKey,
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response || response.length === 0) {
    throw new Error('budget state를 찾을 수 없습니다');
  }

  return response[0];
}

async function getWeekSpent(supabaseUrl, apiKey, monday, sunday) {
  // 부호 포함 합산: 양수=지출, 음수=입금/adjustment → spent 감소
  const url = `${supabaseUrl}/rest/v1/plaid_budget_ledger?status=in.(pending,posted)&transaction_date=gte.${monday}&transaction_date=lte.${sunday}&select=amount`;

  const response = await makeRequest(url, {
    method: 'GET',
    headers: {
      'apikey': apiKey,
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  });

  return response.reduce((sum, row) => sum + parseFloat(row.amount), 0);
}

async function addAdjustmentTransaction(supabaseUrl, apiKey, adjustmentAmount, note, weekMonday) {
  const timestamp = Date.now();
  const budgetKey = `adjustment-${weekMonday}-${timestamp}`;

  // Positive adjustment = increase budget = negative amount (opposite of spending)
  // Negative adjustment = decrease budget = positive amount (like spending)
  const amount = -adjustmentAmount;

  const url = `${supabaseUrl}/rest/v1/plaid_budget_ledger`;

  await makeRequest(url, {
    method: 'POST',
    headers: {
      'apikey': apiKey,
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
  }, {
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

  return budgetKey;
}

function sendSlackNotification(slackWebhookUrl, weeklyBudget, carryover, spent, remaining, weekRange, adjustmentAmount) {
  return new Promise((resolve, reject) => {
    const formatAmount = (amt) => `$${Math.abs(amt).toFixed(2)}`;

    const totalBudget = weeklyBudget + carryover;
    const carryoverLine = carryover > 0
      ? `Carryover: ${formatAmount(carryover)}`
      : carryover < 0
      ? `Carryover: -${formatAmount(carryover)}`
      : 'Carryover: $0.00';

    let budgetLine;
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
          { type: 'mrkdwn', text: `*Applied On*\n${new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })}` },
        ],
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*This Week (Mon ${weekRange.monday} - Sun ${weekRange.sunday})*\nWeekly: ${formatAmount(weeklyBudget)}\n${carryoverLine}\nTotal: ${formatAmount(totalBudget)}`,
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

    const parsedUrl = new URL(slackWebhookUrl);
    const protocol = parsedUrl.protocol === 'https:' ? https : http;

    const reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    };

    const req = protocol.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`Slack 전송 실패: ${res.statusCode} - ${data}`));
        } else {
          resolve();
        }
      });
    });

    req.on('error', reject);
    req.write(JSON.stringify({ blocks }));
    req.end();
  });
}

async function main() {
  console.log('');
  console.log('💰 Plaid Budget 수동 수정 스크립트 (Adjustment Transaction)');
  console.log('===========================================================');
  console.log('');

  if (ADJUSTMENT_AMOUNT === 0) {
    console.log('⚠️  ADJUSTMENT_AMOUNT가 0입니다. 변경할 금액을 설정하세요.');
    console.log('');
    process.exit(0);
  }

  // .env 로드
  const env = loadEnv();
  const supabaseUrl = env.SUPABASE_URL;
  const weeklyBudget = parseFloat(env.WEEKLY_BUDGET || '350');
  const budgetTimezone = env.BUDGET_TIMEZONE || 'America/Los_Angeles';
  const slackWebhookUrl = env.SLACK_WEBHOOK_URL;
  const apiKey = getSupabaseKey(env);

  if (!supabaseUrl) {
    console.error('❌ SUPABASE_URL이 .env에 없습니다');
    process.exit(1);
  }

  // 현재 주 정보 가져오기
  const weekRange = getWeekDateRange(budgetTimezone);
  console.log(`📅 현재 주: ${weekRange.monday} ~ ${weekRange.sunday}`);
  console.log('');

  // 현재 상태 조회
  console.log('📊 현재 버젯 상태 조회 중...');
  const currentState = await getCurrentBudgetState(supabaseUrl, apiKey);
  const currentCarryover = parseFloat(currentState.carryover);
  const currentSpent = await getWeekSpent(supabaseUrl, apiKey, weekRange.monday, weekRange.sunday);
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
    supabaseUrl,
    apiKey,
    ADJUSTMENT_AMOUNT,
    ADJUSTMENT_NOTE,
    weekRange.monday
  );
  console.log(`✅ Transaction 추가 완료: ${budgetKey}`);
  console.log('');

  // 업데이트된 상태 조회
  console.log('📊 업데이트된 상태 조회 중...');
  const newSpent = await getWeekSpent(supabaseUrl, apiKey, weekRange.monday, weekRange.sunday);
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
      ADJUSTMENT_AMOUNT
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
}

main().catch(err => {
  console.error('');
  console.error('❌ 오류 발생:', err.message);
  console.error('');
  process.exit(1);
});
