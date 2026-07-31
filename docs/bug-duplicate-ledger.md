# 중복 Ledger 버그 분석 (Pending → Posted)

## 버그 요약

**심각도**: 🔴 High

**증상**: pending → posted 전환 시 특정 상황에서 ledger에 중복 레코드가 생성되어 주간 지출이 중복 계산됨

**영향**: 주간 예산 계산 오류, Slack 알림의 지출 금액 부정확

---

## 멱등성 분석

### ✅ 정상 동작하는 경우

#### 1. Pending → Posted (정상 경로)
```
1. Pending 추가 (added):
   budget_key: "pend_123"
   status: 'pending'
   amount: $10.00

2. Posted 전환 (added with pending_transaction_id):
   finalizePendingLedger():
     - findLedgerByKey("pend_123") → 레코드 찾음
     - UPDATE budget_key="pend_123" SET status='posted', amount=$12.50

   결과:
   - ledger 레코드: 1개 (UPDATE)
   - 주간 지출: $12.50 ✅
```

#### 2. 동일 거래 중복 추가
```
1. Pending 추가 (added):
   transaction_id: "pend_123"

2. 동일 Pending 재추가 (added):
   handleAdded():
     existing = findRow("pend_123")
     if (existing && !existing.removed_at) {
       return null;  // 스킵 ✅
     }

   결과:
   - ledger 레코드: 1개
   - 멱등성 보장 ✅
```

#### 3. Pending 금액 변경
```
1. Pending 추가 (added):
   budget_key: "pend_123"
   amount: $10.00

2. Pending 수정 (modified):
   handleModified() → updatePendingLedgerAmount()
   UPDATE budget_key="pend_123" SET amount=$11.00

   결과:
   - ledger 레코드: 1개 (UPDATE)
   - 주간 지출: $11.00 ✅
```

---

## 🐛 버그 시나리오

### 시나리오 A: finalizePendingLedger() 실패

**발생 조건**:
1. Pending 거래가 ledger에 저장됨
2. Posted 전환 시 `finalizePendingLedger()`가 pending을 찾지 못함
3. `insertPostedLedgerNew()` 호출

**코드 흐름**:
```typescript
// handleAdded() - posted 처리
const ledgerResult = tx.pending_transaction_id
  ? await finalizePendingLedger(supabase, tx)  // null 반환!
  : null;

if (!ledgerResult) {
  await insertPostedLedgerNew(supabase, tx);  // 새 레코드 추가!
}
```

```typescript
// finalizePendingLedger()
const pendingId = tx.pending_transaction_id!;
const ledger = await findLedgerByKey(supabase, pendingId) ??
  await findLedgerByPendingId(supabase, pendingId);

if (!ledger) return null;  // ❌ 못 찾으면 null!
```

**결과**:
```
ledger 테이블:
1. budget_key="pend_123", status='pending', amount=$10.00  ← 그대로 남음
2. budget_key="post_456", status='posted', amount=$12.50   ← 새로 추가

주간 지출 계산:
SELECT SUM(amount) WHERE status IN ('pending', 'posted')
= $10.00 + $12.50 = $22.50  ❌

실제 지출: $12.50
오차: $10.00 중복!
```

**발생 가능한 원인**:
1. Pending 레코드가 `status='removed'`로 표시됨 (findLedgerByKey는 status 체크 안 함)
2. Pending 레코드가 DB에서 삭제됨 (매우 드묾)
3. `budget_key`가 일치하지 않는 경우 (pending_transaction_id 불일치)
4. 타이밍 이슈 (pending 저장 전에 posted 도착)

---

### 시나리오 B: handleModified()에서 동일 문제

```typescript
// handleModified() - pending → posted
if (wasPending && !tx.pending) {
  let prior: BudgetTransactionRow | null = existing;
  if (tx.pending_transaction_id) {
    prior = await markSuperseded(supabase, tx.pending_transaction_id, tx.transaction_id) ??
      existing;
  }

  const ledgerResult = tx.pending_transaction_id
    ? await finalizePendingLedger(supabase, tx)  // null 반환 가능
    : await promoteLedgerToPosted(supabase, tx);

  if (!ledgerResult) {
    await insertPostedLedgerNew(supabase, tx);  // 중복 추가!
  }

  // ...
}
```

동일한 문제가 `handleModified()`에도 존재합니다.

---

## 검증 방법

### 1. DB에서 중복 확인

```sql
-- 같은 pending_transaction_id를 가진 레코드가 여러 개 있는지 확인
SELECT
  pending_transaction_id,
  COUNT(*) as count,
  STRING_AGG(budget_key, ', ') as budget_keys,
  STRING_AGG(status, ', ') as statuses,
  STRING_AGG(amount::text, ', ') as amounts
FROM plaid_budget_ledger
WHERE pending_transaction_id IS NOT NULL
  AND status IN ('pending', 'posted')
GROUP BY pending_transaction_id
HAVING COUNT(*) > 1;
```

### 2. 주간 지출 이중 계산 확인

```sql
-- 특정 주의 실제 거래 수 vs ledger 레코드 수 비교
SELECT
  COUNT(DISTINCT COALESCE(posted_transaction_id, pending_transaction_id)) as unique_transactions,
  COUNT(*) as ledger_records,
  SUM(amount) as total_spent
FROM plaid_budget_ledger
WHERE status IN ('pending', 'posted')
  AND transaction_date >= '2026-07-27'
  AND transaction_date <= '2026-08-02';

-- unique_transactions < ledger_records 이면 중복 존재!
```

### 3. 고아 Pending 레코드 확인

```sql
-- Posted가 추가된 후에도 pending 상태로 남아있는 레코드
SELECT l.*
FROM plaid_budget_ledger l
WHERE l.status = 'pending'
  AND l.pending_transaction_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM plaid_budget_ledger l2
    WHERE l2.status = 'posted'
      AND l2.posted_transaction_id != l.pending_transaction_id
      AND l2.pending_transaction_id = l.pending_transaction_id
  );
```

---

## 수정 방안

### 옵션 1: insertPostedLedgerNew() 전에 pending 정리 (권장)

```typescript
// handleAdded() 수정
if (!ledgerResult) {
  // ✅ 먼저 pending 레코드를 제거
  if (tx.pending_transaction_id) {
    await markLedgerRemoved(supabase, tx.pending_transaction_id);
  }
  await insertPostedLedgerNew(supabase, tx);
}
```

```typescript
// handleModified() 수정
if (!ledgerResult) {
  // ✅ 먼저 pending 레코드를 제거
  if (tx.pending_transaction_id) {
    await markLedgerRemoved(supabase, tx.pending_transaction_id);
  }
  await insertPostedLedgerNew(supabase, tx);
}
```

### 옵션 2: insertPostedLedgerNew()에서 pending_transaction_id를 budget_key로 사용

```typescript
export async function insertPostedLedgerNew(
  supabase: SupabaseClient,
  tx: PlaidTransaction,
): Promise<void> {
  // ✅ pending_transaction_id가 있으면 그것을 budget_key로 사용
  const budgetKey = tx.pending_transaction_id ?? tx.transaction_id;

  await upsertLedger(supabase, {
    budget_key: budgetKey,  // ✅ 이렇게 하면 pending 레코드를 덮어씀
    pending_transaction_id: tx.pending_transaction_id ?? null,
    posted_transaction_id: tx.transaction_id,
    amount: tx.amount,
    pending_amount: tx.amount,
    ...ledgerFieldsFromTx(tx),
    status: 'posted',
  });
}
```

이 방법은 `upsert`의 `onConflict: 'budget_key'`를 활용하여 자동으로 pending을 덮어씁니다.

### 옵션 3: DB 제약조건 추가

```sql
-- pending_transaction_id도 UNIQUE하게 만들기 (status='posted'일 때만)
CREATE UNIQUE INDEX idx_unique_posted_pending
  ON plaid_budget_ledger (pending_transaction_id)
  WHERE status = 'posted' AND pending_transaction_id IS NOT NULL;
```

이렇게 하면 동일한 `pending_transaction_id`를 가진 posted 레코드가 중복으로 들어가는 것을 DB 레벨에서 방지합니다.

---

## 권장 수정안

**옵션 2 + 옵션 3 조합**:

1. `insertPostedLedgerNew()`에서 `pending_transaction_id`를 `budget_key`로 사용 (코드 수정)
2. DB에 UNIQUE 제약조건 추가 (안전장치)

이렇게 하면:
- ✅ 중복 방지 (upsert가 pending 레코드를 덮어씀)
- ✅ 멱등성 보장
- ✅ DB 레벨 안전장치

---

## 우선순위

**즉시 수정 필요**: 이 버그는 주간 예산 계산의 정확성에 직접적인 영향을 미치므로 높은 우선순위입니다.

**임시 해결책** (수정 전):
```sql
-- 중복 레코드 수동 제거
-- 주의: 프로덕션에서는 신중하게!
WITH duplicates AS (
  SELECT
    pending_transaction_id,
    MIN(id) as keep_id
  FROM plaid_budget_ledger
  WHERE pending_transaction_id IS NOT NULL
    AND status IN ('pending', 'posted')
  GROUP BY pending_transaction_id
  HAVING COUNT(*) > 1
)
UPDATE plaid_budget_ledger l
SET status = 'removed'
FROM duplicates d
WHERE l.pending_transaction_id = d.pending_transaction_id
  AND l.id != d.keep_id
  AND l.status = 'pending';
```

---

**작성일**: 2026-07-31
**우선순위**: High
**영향 범위**: 주간 예산 계산, Slack 알림
