# Plaid Weekly Budget Tracker - 시스템 개요

## 목차
1. [시스템 소개](#시스템-소개)
2. [전체 아키텍처](#전체-아키텍처)
3. [핵심 컴포넌트](#핵심-컴포넌트)
4. [데이터 흐름](#데이터-흐름)
5. [예산 시스템](#예산-시스템)
6. [Slack 알림 시스템](#slack-알림-시스템)
7. [데이터베이스 스키마](#데이터베이스-스키마)

---

## 시스템 소개

Plaid Weekly Budget Tracker는 Plaid API를 통해 은행 거래를 자동으로 동기화하고, 주간 예산을 추적하여 적격 거래(qualifying transactions)를 Slack으로 실시간 알림하는 시스템입니다.

### 주요 기능
- **자동 거래 동기화**: 매시간 Plaid API 폴링으로 최신 거래 내역 수집
- **주간 예산 추적**: 월요일~일요일 기준 주간 예산 관리 및 이월 시스템
- **실시간 Slack 알림**: 새 거래 발생 시 즉시 알림 (pending, posted 상태 추적)
- **거래 분류**: 제외 키워드 기반 자동 필터링
- **수동 예산 조정**: Adjustment transaction을 통한 예산 증감

### 핵심 설계 원칙
- **Ledger 기반 집계**: 모든 지출 계산은 `plaid_budget_ledger` 테이블 기준
- **부호 포함 합산**: 양수=지출, 음수=입금/adjustment로 자동 계산
- **이중 추적**: pending → posted 전환 시 금액/가맹점 변경 감지
- **멱등성**: 동일 거래 중복 알림 방지

---

## 전체 아키텍처

### 아키텍처 다이어그램

```
┌─────────────────────────────────────────────────────────────┐
│                      Plaid API                               │
│  (거래 데이터 제공: /transactions/refresh, /sync)            │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       │ HTTP
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                  Supabase Platform                           │
│                                                              │
│  ┌────────────────────────────────────────────────────┐    │
│  │  PostgreSQL Database                                │    │
│  │  - pg_cron (스케줄러)                               │    │
│  │  - pg_net (HTTP 클라이언트)                         │    │
│  │  - 5개 테이블 (sync_state, transactions, ledger...)│    │
│  └────────────┬───────────────────────────────────────┘    │
│               │                                              │
│               │ 매시간 trigger                               │
│               ▼                                              │
│  ┌────────────────────────────────────────────────────┐    │
│  │  DB Function: trigger_plaid_sync_v2()              │    │
│  │  - pg_net.http_post() 호출                         │    │
│  └────────────┬───────────────────────────────────────┘    │
│               │                                              │
│               │ HTTP POST                                    │
│               ▼                                              │
│  ┌────────────────────────────────────────────────────┐    │
│  │  Edge Function: plaid-sync (Deno)                  │    │
│  │  1. refreshTransactions() - Plaid API 호출         │    │
│  │  2. syncTransactions() - 거래 내역 가져오기        │    │
│  │  3. processSyncUpdates() - DB 저장 + 알림 판단    │    │
│  │  4. sendNotificationBatch() - Slack 전송           │    │
│  └────────────┬───────────────────────────────────────┘    │
│               │                                              │
└───────────────┼──────────────────────────────────────────────┘
                │
                │ HTTPS Webhook
                ▼
        ┌──────────────────┐
        │   Slack API      │
        │  (Incoming       │
        │   Webhook)       │
        └──────────────────┘
```

### 실행 흐름

1. **pg_cron 트리거** (매시간 정각)
   ```sql
   SELECT trigger_plaid_sync_v2();
   ```

2. **Edge Function 호출**
   ```
   trigger_plaid_sync_v2()
     → pg_net.http_post()
       → POST https://[project-id].supabase.co/functions/v1/plaid-sync
   ```

3. **Plaid API 동기화**
   ```typescript
   await refreshTransactions();  // Plaid에 최신 데이터 요청
   await sleep(3000);             // refresh 반영 대기
   const { added, modified, removed } = await syncTransactions(cursor);
   ```

4. **거래 처리 및 저장**
   ```typescript
   const notifications = await processSyncUpdates(db, {added, modified, removed}, {notify: true});
   // → plaid_budget_transactions 테이블 업데이트
   // → plaid_budget_ledger 테이블 업데이트
   // → NotifyRequest[] 생성
   ```

5. **Slack 알림 전송**
   ```typescript
   await sendNotificationBatch(db, notifications);
   // → 각 거래별 예산 계산
   // → Slack Webhook 호출
   ```

---

## 핵심 컴포넌트

### 1. Edge Functions (Supabase Functions)

#### `plaid-sync` (메인 엔트리포인트)
- **위치**: `supabase/functions/plaid-sync/index.ts`
- **역할**: 매시간 실행되는 메인 동기화 함수
- **트리거**: `pg_cron` → `trigger_plaid_sync_v2()` → HTTP POST
- **프로세스**:
  1. Cursor 읽기 (`plaid_sync_state.cursor`)
  2. Plaid API `/transactions/refresh` 호출 (최신 데이터 요청)
  3. 3초 대기 (refresh 반영 시간)
  4. Plaid API `/transactions/sync` 호출 (cursor 기반)
  5. 거래 데이터 처리 및 DB 저장
  6. Slack 알림 전송
  7. 새 cursor 저장

#### `plaid-webhook` (레거시)
- **위치**: `supabase/functions/plaid-webhook/index.ts`
- **역할**: Plaid webhook 수신용 (현재는 보조적 역할)
- **처리 이벤트**: `TRANSACTIONS.SYNC_UPDATES_AVAILABLE`
- **특징**:
  - 빈 cursor 시 bootstrap 모드 (알림 없음)
  - `?bootstrap=1` 파라미터 지원
  - 실제로는 하루 1회 정도만 webhook 수신 (알림 지연 문제로 폴링 방식으로 전환)

### 2. Shared Modules (`_shared/`)

모든 공통 로직은 `supabase/functions/_shared/` 에 위치하여 `plaid-sync`와 `plaid-webhook`이 공유합니다.

#### `plaid.ts`
- **Plaid API 통신 모듈**
- 주요 함수:
  - `refreshTransactions()`: Plaid에 최신 거래 데이터 요청
  - `syncTransactions(cursor)`: cursor 기반 거래 동기화
- 환경변수: `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ACCESS_TOKEN`, `PLAID_ENV`

#### `budget.ts`
- **예산 계산 핵심 로직**
- 주요 상수:
  - `WEEKLY_BUDGET`: 주간 기본 예산 (기본값: $350)
  - `BUDGET_TIMEZONE`: 주 경계 타임존 (기본값: `America/Los_Angeles`)
  - `EXCLUSION_KEYWORDS`: 제외 키워드 배열 (zelle, google, payroll 등)
- 주요 함수:
  - `getWeekDateRange(timezone)`: 현재 주 월요일~일요일 계산
  - `calculateSpent(transactions)`: 거래 배열의 지출 합계 (부호 포함)
  - `isExcluded(tx)`: 거래가 제외 대상인지 판단
  - `buildBudgetSummaryFromSpent()`: 예산 요약 객체 생성

#### `transaction-store.ts`
- **거래 데이터 저장 및 알림 판단 로직**
- 핵심 함수: `processSyncUpdates()`
- 책임:
  1. Plaid sync 결과(added/modified/removed) 처리
  2. `plaid_budget_transactions` 테이블 업데이트
  3. `plaid_budget_ledger` 업데이트 (pending/posted 추적)
  4. 알림 대상 판단 및 `NotifyRequest[]` 반환

#### `budget-ledger.ts`
- **Ledger 관리 모듈**
- 주요 함수:
  - `insertPendingLedger()`: pending 거래 ledger 추가
  - `insertPostedLedgerNew()`: posted 거래 직접 추가
  - `finalizePendingLedger()`: pending → posted 전환 (금액/가맹점 변경 감지)
  - `promoteLedgerToPosted()`: 자체 ID 기준 pending → posted
  - `updatePendingLedgerAmount()`: pending 거래 금액 수정
  - `getWeekSpentFromLedger()`: 주간 지출 합계 계산
- Ledger 상태: `pending`, `posted`, `excluded`, `removed`

#### `budget-state.ts`
- **Carryover 관리 모듈**
- 주요 함수:
  - `readCarryover()`: DB에서 carryover 읽기
  - `writeCarryover()`: 새 carryover 저장
  - `resolveCarryover()`: 주가 넘어갔을 때 자동 carryover 계산 및 저장

#### `notifications.ts`
- **Slack 알림 배치 전송 모듈**
- 주요 함수:
  - `sendNotificationBatch()`: 알림 배열을 날짜순으로 정렬하여 순차 전송
  - `notificationSpentDelta()`: 각 알림의 지출 변화량 계산
- 특징:
  - 거래를 날짜순으로 정렬
  - 각 거래마다 누적 spent 계산
  - 실시간 예산 상태 반영

#### `slack.ts`
- **Slack 메시지 전송 모듈**
- 주요 함수:
  - `sendSlackMessage()`: Slack Incoming Webhook 호출
- 메시지 타입별 포맷:
  - `pending`: 새로운 pending 거래
  - `posted_new`: 처음 posted된 거래
  - `posted_confirm`: pending → posted 시 금액/가맹점 변경

#### `budget-summary.ts`
- **주간 예산 요약 저장**
- 함수: `saveBudgetSummary()`
- `plaid_weekly_budget_summaries` 테이블에 주간 통계 저장

### 3. Scripts (로컬 실행용)

#### `scripts/sync.ts`
- **로컬 수동 동기화 스크립트**
- 사용법:
  ```bash
  make sync              # DB만 업데이트 (알림 없음)
  make sync-notify       # DB 업데이트 + Slack 알림
  ```
- 환경변수 `.env` 사용

#### `scripts/backfill-notify.ts`
- **전체 거래 재동기화 + 알림**
- 사용법: `make backfill-notify`
- 주의: cursor를 초기화하므로 기존 알림 받은 거래도 재전송 가능

#### `scripts/resend-ledger-notify.ts`
- **이번 주 ledger 기준 알림 재전송**
- 사용법: `make resend-ledger-notify`
- 용도: 알림이 누락되었을 때 이번 주 거래만 재전송

#### `scripts/update-budget.js` / `scripts/update-budget-deno.ts`
- **수동 예산 조정 스크립트**
- 사용법: `make update-budget` 또는 `node scripts/update-budget.js`
- 동작 방식:
  1. 스크립트 상단의 `ADJUSTMENT_AMOUNT` 변수 수정
  2. 실행 시 `plaid_budget_ledger`에 adjustment transaction 추가
  3. 양수 = 예산 증가 (음수 amount 기록), 음수 = 예산 감소 (양수 amount 기록)
  4. Slack 알림 자동 전송

---

## 데이터 흐름

### 1. 거래 발견 ~ Slack 알림까지 전체 플로우

```
[Plaid API]
    │
    │ 1. POST /transactions/refresh
    │    (최신 데이터 업데이트 요청)
    ▼
[Plaid 내부 처리]
    │
    │ 2. 3초 대기 (refresh 반영 시간)
    ▼
[plaid-sync Edge Function]
    │
    │ 3. POST /transactions/sync?cursor=xxx
    │    → 반환: {added[], modified[], removed[], next_cursor}
    ▼
[processSyncUpdates()]
    │
    ├─ 4a. removed[] 처리
    │      → markRemoved(transaction_id)
    │        → plaid_budget_transactions.removed_at = now
    │        → markLedgerRemoved()
    │
    ├─ 4b. modified[] 처리
    │      → handleModified(tx)
    │        ├─ isExcluded(tx)? → DB만 저장, 알림 없음
    │        ├─ tx.pending?
    │        │   → upsertRow() + updatePendingLedgerAmount()
    │        │   → 알림 없음 (pending 수정은 알림 X)
    │        └─ pending → posted?
    │            → markSuperseded(pending_id)
    │            → finalizePendingLedger() or promoteLedgerToPosted()
    │            → 금액/가맹점 변경 감지
    │            → 변경 있으면 NotifyRequest('posted_confirm') 반환
    │
    └─ 4c. added[] 처리
           → handleAdded(tx)
             ├─ 이미 존재? → 스킵
             ├─ isExcluded(tx)? → DB만 저장, 알림 없음
             ├─ tx.pending?
             │   → upsertRow() + insertPendingLedger()
             │   → NotifyRequest('pending') 반환
             └─ tx.posted?
                 ├─ pending_transaction_id 있음?
                 │   → markSuperseded()
                 │   → finalizePendingLedger()
                 │   → 변경 있으면 NotifyRequest('posted_confirm')
                 └─ pending_transaction_id 없음?
                     → insertPostedLedgerNew()
                     → NotifyRequest('posted_new') 반환
    │
    ▼
[sendNotificationBatch(notifications)]
    │
    ├─ 5a. 알림 날짜순 정렬
    ├─ 5b. 현재 주 spent 계산 (ledger 기준)
    ├─ 5c. 각 거래 순회
    │      ├─ runningSpent 누적
    │      ├─ buildBudgetSummaryFromSpent(weekRange, carryover, runningSpent)
    │      └─ sendSlackMessage(tx, budget, kind, prior)
    │
    └─ 5d. Slack Webhook 호출
           → POST SLACK_WEBHOOK_URL
             {
               "text": "💳 McDonald's $12.50",
               "attachments": [{
                 "color": "good/warning/danger",
                 "text": "Spent: $120 / $400 (Remaining: $280)"
               }]
             }
```

### 2. Pending → Posted 전환 상세 플로우

```
[Pending 거래 추가 시점]
  tx.pending = true
  tx.transaction_id = "pend_123"
  tx.amount = 10.00
    ↓
  handleAdded()
    → upsertRow(plaid_budget_transactions)
    → insertPendingLedger()
        budget_key: "pend_123"
        pending_transaction_id: "pend_123"
        amount: 10.00
        pending_amount: 10.00
        status: 'pending'
    → return NotifyRequest(kind='pending')
    ↓
  Slack: "⏳ Pending: McDonald's $10.00"

[Posted로 전환 시점]
  tx.pending = false
  tx.transaction_id = "post_456"
  tx.pending_transaction_id = "pend_123"
  tx.amount = 12.50  // 금액 변경됨
    ↓
  handleAdded() or handleModified()
    → markSuperseded(pend_123, post_456)
        plaid_budget_transactions에서 pend_123:
          superseded_by = "post_456"
          removed_at = now
    → finalizePendingLedger(tx)
        ledger 찾기: budget_key="pend_123"
        금액 비교: 12.50 vs 10.00 → amountChanged=true
        ledger 업데이트:
          posted_transaction_id: "post_456"
          amount: 12.50
          status: 'posted'
    → return NotifyRequest(kind='posted_confirm', priorAmount=10.00)
    ↓
  Slack: "✅ Confirmed: McDonald's $12.50 (was $10.00)"

[금액/가맹점 변경 없을 때]
  tx.amount = 10.00 (동일)
  tx.merchant_name = "McDonald's" (동일)
    ↓
  finalizePendingLedger()
    → amountChanged=false, merchantChanged=false
    → return null (알림 없음)
```

### 3. 주간 예산 계산 플로우

```
[매 알림 전송 시]
  1. resolveCarryover(db)
     → plaid_sync_state.carryover 읽기
     → 주가 바뀌었으면 자동 계산 및 저장

  2. getWeekDateRange(BUDGET_TIMEZONE)
     → 현재 날짜 기준 이번 주 월요일, 일요일 계산
     → 예: {monday: "2026-07-07", sunday: "2026-07-13"}

  3. getWeekSpentFromLedger(db, monday, sunday)
     → SELECT SUM(amount) FROM plaid_budget_ledger
        WHERE status IN ('pending', 'posted')
          AND transaction_date >= '2026-07-07'
          AND transaction_date <= '2026-07-13'
     → 부호 포함 합산:
        - 양수 (지출): +12.50
        - 음수 (입금/adjustment): -5.00
        - 결과: 12.50 - 5.00 = 7.50

  4. buildBudgetSummaryFromSpent(weekRange, carryover, spent)
     totalBudget = WEEKLY_BUDGET (350) + carryover (50) = 400
     remaining = totalBudget (400) - spent (120) = 280
     → {
         weeklyBudget: 350,
         carryover: 50,
         totalBudget: 400,
         spent: 120,
         remaining: 280,
         weekRange: {...}
       }
```

---

## 예산 시스템

### 1. 예산 구성 요소

```
┌─────────────────────────────────────────┐
│  총 예산 (Total Budget)                 │
│                                         │
│  = 주간 기본 예산 + 이월 금액            │
│    (WEEKLY_BUDGET)  (Carryover)        │
│                                         │
│  예: $350 + $50 = $400                  │
└─────────────────────────────────────────┘
              │
              │ 거래 발생
              ▼
┌─────────────────────────────────────────┐
│  주간 지출 (Spent This Week)            │
│                                         │
│  = ledger에서 pending/posted 상태의     │
│    amount 부호 포함 합산                │
│                                         │
│  예: $120 (양수=지출, 음수=입금)         │
└─────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────┐
│  남은 예산 (Remaining)                  │
│                                         │
│  = 총 예산 - 주간 지출                  │
│                                         │
│  예: $400 - $120 = $280                 │
└─────────────────────────────────────────┘
```

### 2. Carryover 시스템

**주가 넘어갈 때 자동 계산**:
```typescript
// budget-state.ts의 resolveCarryover()
if (현재_주 !== 저장된_주) {
  // 지난 주 예산 계산
  const lastWeekSpent = await getWeekSpentFromLedger(db, lastMonday, lastSunday);
  const lastWeekBudget = WEEKLY_BUDGET + oldCarryover;
  const newCarryover = lastWeekBudget - lastWeekSpent;

  // 새 carryover 저장
  await writeCarryover(db, newCarryover);
}
```

**예시**:
```
지난 주 (2026-06-30 ~ 2026-07-06):
  주간 예산: $350
  이월: $0
  지출: $320
  남은 금액: $30 → 이번 주로 이월

이번 주 (2026-07-07 ~ 2026-07-13):
  주간 예산: $350
  이월: $30 (지난 주에서)
  총 예산: $380
```

### 3. Adjustment Transaction

수동 예산 조정을 위한 특수 거래입니다.

**작동 원리**:
```
양수 adjustment (+$100):
  → ledger에 -$100 기록
  → spent가 $100 감소
  → 남은 예산 $100 증가

음수 adjustment (-$50):
  → ledger에 +$50 기록
  → spent가 $50 증가
  → 남은 예산 $50 감소
```

**DB 저장 형태**:
```sql
INSERT INTO plaid_budget_ledger (
  budget_key,
  amount,
  merchant_name,
  transaction_date,
  status
) VALUES (
  'adjustment-2026-07-07-1720742400000',
  -100.00,  -- 양수 adjustment는 음수로 저장
  '⚙️ Budget Adjustment',
  '2026-07-07',
  'posted'
);
```

### 4. 제외 키워드 시스템

특정 거래는 예산 계산 및 알림에서 자동 제외됩니다.

**제외 대상** (`EXCLUSION_KEYWORDS`):
- `zelle`: Zelle 송금
- `vzwrlss`: Verizon Wireless
- `check`: 수표
- `sterling`: Sterling 관련
- `arco`, `chevron`, `shell`, `cosmic fuel`, `oil`: 주유소
- `apple.com`, `google one`, `google`: 구독 서비스
- `frontier`: Frontier 통신
- `online transfer`: 온라인 이체
- `payroll`: 급여
- `robinhood`: Robinhood 투자

**판단 로직**:
```typescript
// budget.ts의 isExcluded()
function isExcluded(tx: PlaidTransaction): boolean {
  const haystack = [
    tx.merchant_name,
    tx.name,
    tx.original_description,
    ...tx.counterparties.map(c => c.name)
  ].join(' ').toLowerCase();

  return EXCLUSION_KEYWORDS.some(kw => haystack.includes(kw));
}
```

---

## Slack 알림 시스템

### 1. 알림 발송 조건

**알림이 나가는 경우**:

| 상황 | NotifyKind | 설명 |
|------|------------|------|
| 새 pending 거래 추가 | `pending` | 처음 발견된 pending 거래 |
| pending 없이 바로 posted | `posted_new` | pending 단계 없이 직접 posted |
| pending → posted 시 변경 | `posted_confirm` | 금액 또는 가맹점이 변경됨 |

**알림이 나가지 않는 경우**:
- `isExcluded(tx) === true` (제외 키워드 포함)
- 이미 DB에 존재하는 거래 (중복)
- pending 상태에서의 수정 (금액만 업데이트, 알림 없음)
- pending → posted 시 금액/가맹점 모두 동일
- 이미 posted된 거래의 추가 수정
- removed 처리된 거래

### 2. 알림 메시지 포맷

#### Pending 거래
```
⏳ Pending: McDonald's $12.50

This Week (Mon Jul 7 - Sun Jul 13)
Weekly: $350.00
Carryover: $50.00
Total: $400.00

Spent This Week: $120.50 / $400.00

Remaining: $279.50 left
```

#### Posted (새 거래)
```
💳 Posted: McDonald's $12.50

This Week (Mon Jul 7 - Sun Jul 13)
Weekly: $350.00
Carryover: $50.00
Total: $400.00

Spent This Week: $120.50 / $400.00

Remaining: $279.50 left
```

#### Posted (금액 변경 확인)
```
✅ Confirmed: McDonald's $12.50 (was $10.00)

This Week (Mon Jul 7 - Sun Jul 13)
Weekly: $350.00
Carryover: $50.00
Total: $400.00

Spent This Week: $122.50 / $400.00

Remaining: $277.50 left
```

#### Budget Adjustment
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

### 3. 색상 코드

Slack 메시지는 남은 예산 비율에 따라 색상이 변경됩니다:

```typescript
if (remaining > totalBudget * 0.5) return "good";      // 초록색: 50% 이상
if (remaining > totalBudget * 0.2) return "warning";   // 노란색: 20~50%
return "danger";                                        // 빨간색: 20% 미만
```

### 4. 알림 순서 보장

`sendNotificationBatch()`는 알림을 날짜순으로 정렬하여 전송합니다:

```typescript
function sortNotifications(notifications: NotifyRequest[]): NotifyRequest[] {
  return [...notifications].sort((a, b) => {
    const byDate = a.tx.date.localeCompare(b.tx.date);
    if (byDate !== 0) return byDate;
    return a.tx.transaction_id.localeCompare(b.tx.transaction_id);
  });
}
```

---

## 데이터베이스 스키마

### 1. `plaid_sync_state`
**동기화 상태 저장** (단일 행)

| 컬럼 | 타입 | 설명 |
|------|------|------|
| `id` | INTEGER | PK (항상 1) |
| `cursor` | TEXT | Plaid sync cursor |
| `carryover` | NUMERIC | 주간 이월 금액 |
| `week_monday` | DATE | carryover 기준 주 월요일 |
| `updated_at` | TIMESTAMPTZ | 마지막 업데이트 시각 |

### 2. `plaid_budget_transactions`
**Plaid 거래 미러 테이블**

| 컬럼 | 타입 | 설명 |
|------|------|------|
| `transaction_id` | TEXT | PK, Plaid transaction ID |
| `pending_transaction_id` | TEXT | Pending ID (posted 시 참조) |
| `amount` | NUMERIC | 거래 금액 (양수=지출) |
| `merchant_name` | TEXT | 가맹점명 |
| `name` | TEXT | 거래명 |
| `transaction_date` | DATE | 거래 날짜 |
| `pending` | BOOLEAN | Pending 여부 |
| `excluded` | BOOLEAN | 제외 대상 여부 |
| `counts_in_budget` | BOOLEAN | 예산 계산 포함 여부 |
| `notified_at` | TIMESTAMPTZ | 알림 전송 시각 |
| `superseded_by` | TEXT | Pending → Posted 시 새 ID |
| `removed_at` | TIMESTAMPTZ | 삭제 시각 |
| `created_at` | TIMESTAMPTZ | 생성 시각 |
| `updated_at` | TIMESTAMPTZ | 수정 시각 |

### 3. `plaid_budget_ledger`
**주간 지출 계산 기준 Ledger**

| 컬럼 | 타입 | 설명 |
|------|------|------|
| `id` | SERIAL | PK |
| `budget_key` | TEXT | UNIQUE, ledger 식별자 (transaction_id 또는 adjustment-xxx) |
| `pending_transaction_id` | TEXT | Pending 거래 ID |
| `posted_transaction_id` | TEXT | Posted 거래 ID |
| `amount` | NUMERIC | **현재 금액** (양수=지출, 음수=입금/adjustment) |
| `pending_amount` | NUMERIC | Pending 시점 금액 (변경 감지용) |
| `merchant_name` | TEXT | 가맹점명 |
| `name` | TEXT | 거래명 |
| `transaction_date` | DATE | 거래 날짜 |
| `status` | TEXT | `pending`, `posted`, `excluded`, `removed` |
| `week_monday` | DATE | 주간 경계 (인덱스용) |
| `created_at` | TIMESTAMPTZ | 생성 시각 |
| `updated_at` | TIMESTAMPTZ | 수정 시각 |

**핵심 개념**:
- 주간 지출 계산은 이 테이블의 `amount` 컬럼을 **부호 포함** 합산
- `status IN ('pending', 'posted')` 조건
- Adjustment transaction도 이 테이블에 저장 (음수 amount로 spent 감소)

### 4. `plaid_weekly_budget_summaries`
**주간 예산 요약 스냅샷**

| 컬럼 | 타입 | 설명 |
|------|------|------|
| `id` | SERIAL | PK |
| `week_monday` | DATE | 주 시작일 (월요일) |
| `week_sunday` | DATE | 주 종료일 (일요일) |
| `weekly_budget` | NUMERIC | 주간 기본 예산 |
| `carryover` | NUMERIC | 이월 금액 |
| `total_budget` | NUMERIC | 총 예산 |
| `spent` | NUMERIC | 주간 지출 |
| `remaining` | NUMERIC | 남은 예산 |
| `created_at` | TIMESTAMPTZ | 생성 시각 |

### 5. `plaid_webhook_logs`
**Webhook 수신 로그** (디버깅용)

| 컬럼 | 타입 | 설명 |
|------|------|------|
| `id` | SERIAL | PK |
| `webhook_type` | TEXT | 예: `TRANSACTIONS` |
| `webhook_code` | TEXT | 예: `SYNC_UPDATES_AVAILABLE` |
| `item_id` | TEXT | Plaid Item ID |
| `payload` | JSONB | 전체 webhook payload |
| `created_at` | TIMESTAMPTZ | 수신 시각 |

---

## 환경 변수

### Edge Function Secrets (Supabase Dashboard)

```bash
# Plaid API
PLAID_CLIENT_ID=your_client_id
PLAID_SECRET=your_secret
PLAID_ACCESS_TOKEN=your_access_token
PLAID_ENV=production

# Supabase
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SECRET_KEYS={"default":"service_role_key"}

# 예산 설정
WEEKLY_BUDGET=350
BUDGET_TIMEZONE=America/Los_Angeles

# Slack
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/xxx
```

### 로컬 `.env` (Scripts 실행용)

```bash
# Plaid
PLAID_CLIENT_ID=xxx
PLAID_SECRET=xxx
PLAID_ACCESS_TOKEN=xxx
PLAID_ENV=production

# Supabase
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SECRET_KEYS={"default":"service_role_key"}

# 예산
WEEKLY_BUDGET=350
BUDGET_TIMEZONE=America/Los_Angeles

# Slack
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/xxx

# 선택적 튜닝
REFRESH_WAIT_MS=3000          # refresh 후 대기 시간
SYNC_RETRY_COUNT=2            # sync 재시도 횟수
SYNC_RETRY_WAIT_MS=3000       # 재시도 대기 시간
SLACK_DELAY_MS=300            # 알림 간 지연 (backfill/resend)
```

---

## 배포 및 운영

### Edge Function 배포

```bash
# 단일 function 배포
supabase functions deploy plaid-sync

# 공통 로직 변경 시 둘 다 배포
supabase functions deploy plaid-sync
supabase functions deploy plaid-webhook
```

### Secrets 설정

```bash
supabase secrets set PLAID_CLIENT_ID=xxx
supabase secrets set PLAID_SECRET=xxx
supabase secrets set SLACK_WEBHOOK_URL=xxx
# ... 기타 환경변수
```

### pg_cron 설정

```sql
-- 매시간 정각 실행
SELECT cron.schedule(
  'plaid-hourly-sync',
  '0 * * * *',
  'SELECT trigger_plaid_sync_v2();'
);

-- 스케줄 확인
SELECT * FROM cron.job;

-- 실행 히스토리 확인
SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 10;
```

### 트러블슈팅 체크리스트

**Slack 알림이 안 올 때**:
1. pg_cron이 실행 중인지 확인 (`SELECT * FROM cron.job;`)
2. `trigger_plaid_sync_v2()` 로그 확인 (Supabase Dashboard)
3. `plaid-sync` Edge Function 로그 확인
4. `SLACK_WEBHOOK_URL` secret 설정 확인
5. 거래가 제외 키워드에 해당하는지 확인
6. pending → posted 시 금액/가맹점이 동일한지 확인 (의도적으로 무음)

**동기화가 안 될 때**:
1. `plaid_sync_state.cursor` 값 확인
2. `plaid_sync_state.updated_at` 갱신 여부 확인
3. Plaid API 응답 로그 확인 (Edge Function)
4. `PLAID_ACCESS_TOKEN` 유효성 확인

**Carryover가 이상할 때**:
1. `plaid_sync_state.carryover` 현재 값 확인
2. `plaid_sync_state.week_monday` 확인 (주 경계)
3. `resolveCarryover()` 로직 실행 로그 확인

---

## 추가 문서

상세 내용은 다음 문서를 참고하세요:
- `scripts/README.md`: 예산 수동 조정 가이드
- `README.md`: 프로젝트 Quick Start 가이드

---

**문서 작성일**: 2026-07-31
**대상 독자**: 개발자, 시스템 관리자
**문서 버전**: 1.0
