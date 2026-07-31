# Budget 수정 스크립트 사용법

프로젝트에 2가지 버전의 버젯 수정 스크립트가 있습니다. **Adjustment Transaction 방식**을 사용하여 ledger에 거래를 추가함으로써 예산을 조정합니다.

## 동작 방식

이 스크립트는 **carryover를 직접 수정하지 않고**, `plaid_budget_ledger` 테이블에 adjustment transaction을 추가하여 예산이 자동으로 재계산되도록 합니다.

### Adjustment Transaction 작동 원리:

- **양수 adjustment** (예: 100): 예산 증가 → ledger에 음수 금액(-100) 추가 → 지출 감소 효과
- **음수 adjustment** (예: -50): 예산 감소 → ledger에 양수 금액(50) 추가 → 지출 증가 효과

시스템은 `plaid_budget_ledger`의 `status='pending'` 또는 `status='posted'`인 모든 거래의 `amount`를 **부호 포함**으로 합산하여 주간 지출을 계산합니다. (양수=지출, 음수=입금/adjustment → spent 감소)

---

## 1. Node.js 버전 (권장 - 간단함)

**파일**: `scripts/update-budget.js`

### 사용 방법:

1. `scripts/update-budget.js` 파일을 열어서 상단의 `ADJUSTMENT_AMOUNT` 값을 수정합니다:

```javascript
const ADJUSTMENT_AMOUNT = 100;  // 🔧 원하는 조정 금액으로 변경
const ADJUSTMENT_NOTE = 'Manual Budget Adjustment';  // 🔧 메모 수정 가능
```

2. 스크립트를 실행합니다:

```bash
node scripts/update-budget.js
```

### 예시:

```javascript
// 예산에 $100 추가 (예: 특별 예산 지원)
const ADJUSTMENT_AMOUNT = 100;

// 예산에서 $50 차감 (예: 초과 지출 패널티)
const ADJUSTMENT_AMOUNT = -50;

// adjustment 없음 (스크립트가 종료됨)
const ADJUSTMENT_AMOUNT = 0;
```

---

## 2. Deno 버전

**파일**: `scripts/update-budget-deno.ts`

### 사용 방법:

1. `scripts/update-budget-deno.ts` 파일을 열어서 상단의 `ADJUSTMENT_AMOUNT` 값을 수정합니다:

```typescript
const ADJUSTMENT_AMOUNT = 100;  // 🔧 원하는 조정 금액으로 변경
const ADJUSTMENT_NOTE = 'Manual Budget Adjustment';  // 🔧 메모 수정 가능
```

2. 스크립트를 실행합니다:

```bash
npm run update-budget
```

또는

```bash
make update-budget
```

또는

```bash
deno run --config scripts/deno.json --env-file=.env --allow-net --allow-env scripts/update-budget-deno.ts
```

---

## 실행 결과 예시

```
💰 Plaid Budget 수동 수정 스크립트 (Adjustment Transaction)
===========================================================

📅 현재 주: 2026-07-07 ~ 2026-07-13

📊 현재 버젯 상태 조회 중...

현재 상태 (adjustment 적용 전):
  주간 기본 예산: $350.00
  이월 금액: $50.00
  총 예산: $400.00
  지출: $120.50
  남은 금액: $279.50

🔄 Adjustment transaction 추가 중: +$100.00...
✅ Transaction 추가 완료: adjustment-2026-07-07-1720742400000

📊 업데이트된 상태 조회 중...

새로운 상태 (adjustment 적용 후):
  주간 기본 예산: $350.00
  이월 금액: $50.00
  총 예산: $400.00
  지출: $20.50
  남은 금액: $379.50
  실질 예산 효과: $100.00

📣 Slack 알림 전송 중...
✅ Slack 알림 전송 완료

✅ 완료!

💡 팁:
  - 주간 기본 예산을 변경하려면 .env의 WEEKLY_BUDGET을 수정하세요
  - 추가 adjustment가 필요하면 ADJUSTMENT_AMOUNT를 변경하고 다시 실행하세요
  - adjustment는 누적됩니다 (이전 adjustment를 덮어쓰지 않습니다)
```

---

## Slack 알림

스크립트는 `.env`에 `SLACK_WEBHOOK_URL`이 설정되어 있으면 자동으로 Slack에 알림을 전송합니다.

**Slack 메시지 포맷:**

```
⚙️ Budget Adjustment Applied

Adjustment: Added $100.00 to budget
Applied On: 7/11/2026, 2:30:00 PM

This Week (Mon 2026-07-07 - Sun 2026-07-13)
Weekly: $350.00
Carryover: $50.00
Total: $400.00

Spent This Week: $20.50 / $400.00

Remaining: $379.50 left
```

---

## 버젯 시스템 이해하기

### 버젯 구성 요소:

1. **주간 기본 예산 (WEEKLY_BUDGET)**:
   - `.env` 파일에서 설정
   - 매주 새로 부여되는 기본 예산
   - 기본값: $350

2. **이월 금액 (Carryover)**:
   - 데이터베이스에 저장 (`plaid_sync_state.carryover`)
   - 이전 주에서 남거나 초과한 금액
   - 양수: 남은 금액이 이번 주로 이월
   - 음수: 초과 지출이 이번 주에서 차감

3. **Adjustment Transactions**:
   - `plaid_budget_ledger` 테이블에 저장
   - 특별한 거래로 기록됨 (merchant_name: "⚙️ Budget Adjustment")
   - 예산 계산 시 자동으로 포함됨
   - 누적됨 (여러 번 실행 가능)

4. **주간 지출 (Spent)**:
   - ledger의 pending/posted 금액 부호 포함 합계
   - adjustment transactions 포함 (음수면 spent 감소)

5. **총 예산**:
   ```
   총 예산 = 주간 기본 예산 + 이월 금액
   ```

6. **남은 예산 (Remaining)**:
   ```
   남은 예산 = 총 예산 - 주간 지출
   ```

### 예시 시나리오:

**시나리오 1: 추가 예산 지원**
```
초기 상태:
  주간 기본 예산: $350
  이월 금액: $0
  지출: $100
  남은 금액: $250

Adjustment: +$100 추가

결과:
  주간 기본 예산: $350
  이월 금액: $0
  지출: $0 (100 - 100 adjustment)
  남은 금액: $350
  실질 효과: +$100 예산 증가
```

**시나리오 2: 초과 지출 패널티**
```
초기 상태:
  주간 기본 예산: $350
  이월 금액: $50
  지출: $150
  남은 금액: $250

Adjustment: -$50 차감

결과:
  주간 기본 예산: $350
  이월 금액: $50
  지출: $200 (150 + 50 adjustment)
  남은 금액: $200
  실질 효과: -$50 예산 감소
```

---

## 다른 버젯 설정 방법

### 1. 주간 기본 예산 변경

`.env` 파일을 수정합니다:

```bash
WEEKLY_BUDGET=500  # $500으로 변경
```

### 2. 타임존 변경

주간 시작 기준이 되는 타임존을 변경하려면:

```bash
BUDGET_TIMEZONE=Asia/Seoul  # 한국 시간으로 변경
```

### 3. Slack 알림 설정

Slack Webhook URL을 설정합니다:

```bash
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/YOUR/WEBHOOK/URL
```

---

## 현재 버젯 상태 확인

버젯 상태를 확인하려면 sync 스크립트를 `--notify` 없이 실행:

```bash
npm run sync
```

또는

```bash
make sync
```

이렇게 하면 Slack 알림 없이 현재 주간 예산 상태를 볼 수 있습니다.

---

## 주의사항

1. **누적 효과**: Adjustment는 누적됩니다. 동일한 금액으로 여러 번 실행하면 그만큼 예산이 누적 조정됩니다.

2. **현재 주에만 적용**: Adjustment transaction은 현재 주 시작일(`week_monday`)로 추가됩니다. 이전 주나 미래 주에는 영향을 주지 않습니다.

3. **Carryover는 변경되지 않음**: 이 스크립트는 carryover 값을 직접 변경하지 않습니다. 대신 지출을 조정하여 남은 예산을 변경합니다.

4. **영구 기록**: Adjustment transactions는 `plaid_budget_ledger`에 영구적으로 저장됩니다. 실수로 추가한 경우 데이터베이스에서 직접 삭제해야 합니다.

---

## 문제 해결

### Adjustment를 취소하고 싶은 경우

반대 금액으로 다시 실행하거나, 데이터베이스에서 직접 삭제:

```sql
-- 특정 adjustment 삭제
DELETE FROM plaid_budget_ledger
WHERE budget_key = 'adjustment-2026-07-07-1720742400000';

-- 또는 모든 adjustment 삭제 (주의!)
DELETE FROM plaid_budget_ledger
WHERE merchant_name = '⚙️ Budget Adjustment';
```

### 스크립트가 "ADJUSTMENT_AMOUNT가 0입니다" 메시지를 출력하는 경우

`ADJUSTMENT_AMOUNT`를 0이 아닌 값으로 설정하세요.
