/**
 * Check Budget Script
 *
 * 현재 주간 예산 상태를 조회하고 Slack으로 전송합니다.
 *
 * Usage:
 *   make check-budget
 *   npm run check-budget
 *   deno run --allow-env --allow-net scripts/check-budget.ts
 */

const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const secretKeysJson = Deno.env.get('SUPABASE_SECRET_KEYS');
const serviceRoleKey = secretKeysJson
  ? JSON.parse(secretKeysJson)['default']
  : Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

if (!SUPABASE_URL) {
  console.error('❌ SUPABASE_URL 환경변수가 설정되지 않았습니다.');
  Deno.exit(1);
}

if (!serviceRoleKey) {
  console.error('❌ SUPABASE_SECRET_KEYS 또는 SUPABASE_SERVICE_ROLE_KEY가 설정되지 않았습니다.');
  Deno.exit(1);
}

console.log('💰 Plaid Weekly Budget Status Check');
console.log('=====================================\n');

try {
  // Edge Function 호출
  const functionUrl = `${SUPABASE_URL}/functions/v1/budget-status`;

  console.log('📡 Edge Function 호출 중...');
  console.log(`   URL: ${functionUrl}\n`);

  const response = await fetch(functionUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${serviceRoleKey}`,
    },
    body: JSON.stringify({}),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Edge Function 호출 실패: ${response.status} ${response.statusText}\n${errorText}`);
  }

  const result = await response.json();

  if (result.ok && result.budget) {
    const { budget } = result;

    console.log('✅ 성공!\n');
    console.log('📊 현재 주간 예산 상태:');
    console.log('─────────────────────────');
    console.log(`주간 범위:    ${budget.week.monday} ~ ${budget.week.sunday}`);
    console.log(`              ${budget.week.label}`);
    console.log('');
    console.log(`주간 예산:    $${budget.weekly_budget.toFixed(2)}`);
    console.log(`이월:         ${budget.carryover >= 0 ? '+' : ''}$${budget.carryover.toFixed(2)}`);
    console.log(`총 예산:      $${budget.total_budget.toFixed(2)}`);
    console.log('');
    console.log(`지출:         $${budget.spent.toFixed(2)}`);
    console.log(`남은 예산:    $${budget.remaining.toFixed(2)}`);
    console.log('');

    const percentUsed = budget.total_budget > 0
      ? (budget.spent / budget.total_budget) * 100
      : 0;
    const percentRemaining = 100 - percentUsed;

    console.log(`사용률:       ${percentUsed.toFixed(1)}%`);
    console.log(`잔여율:       ${percentRemaining.toFixed(1)}%`);

    if (budget.remaining < budget.total_budget * 0.2) {
      console.log('\n🚨 경고: 남은 예산이 20% 미만입니다!');
    } else if (budget.remaining < budget.total_budget * 0.5) {
      console.log('\n⚠️  주의: 남은 예산이 50% 미만입니다.');
    } else {
      console.log('\n✅ 예산 상태 양호');
    }

    console.log('\n📨 Slack 알림이 전송되었습니다.');
  } else {
    console.error('❌ 예상치 못한 응답:', result);
    Deno.exit(1);
  }
} catch (error: any) {
  console.error('❌ 오류 발생:', error.message);
  Deno.exit(1);
}
