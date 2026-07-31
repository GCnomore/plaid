# Changelog

프로젝트의 주요 변경사항을 기록합니다.

---

## [2026-07-31] - Critical Bug Fixes

### 🔴 Critical Bug #1: 주간 경계 타임존 버그 수정

**문제**:
- `getWeekDateRange()` 함수가 UTC 기준 요일을 사용
- LA 타임존 기준 주간 경계(월~일)가 항상 하루씩 틀어짐
- 모든 예산 계산이 잘못된 주간 범위로 수행됨

**영향**:
- 주간 지출 합계 오류
- Carryover 계산 오류
- 모든 Slack 알림의 예산 정보 부정확
- 사용자가 예산 관리를 신뢰할 수 없음

**근본 원인**:
```typescript
// 잘못된 코드
const todayLocal = new Date(y, m - 1, d);  // UTC 자정으로 해석
const dayOfWeek = todayLocal.getDay();      // UTC 기준 요일 반환
```

**수정 내용**:
- 타임존 기준 요일을 직접 계산 (`Intl.DateTimeFormat` + `weekday: 'long'`)
- `Date.UTC()` 사용으로 날짜 산술 시 타임존 shift 방지
- UTC 메서드(`getUTCFullYear()`, `setUTCDate()`) 일관성 있게 사용

**파일 변경**:
- `supabase/functions/_shared/budget.ts` (lines 90-149)

**커밋**: `65f7996`

**상세 문서**: [docs/bugfix-timezone.md](./bugfix-timezone.md)

---

### 🔴 Critical Bug #2: Pending → Posted 중복 Ledger 버그 수정

**문제**:
- Pending → Posted 전환 시 `finalizePendingLedger()` 실패하면
- `insertPostedLedgerNew()`가 새 레코드를 추가
- 기존 pending 레코드가 그대로 남아 중복 계산됨

**영향**:
- 주간 지출 중복 계산 (예: pending $10 + posted $12.50 = $22.50)
- 예산 알림의 지출 금액 부정확
- 멱등성 위반

**발생 시나리오**:
```
1. pending 추가: budget_key="pend_123", amount=$10.00
   → ledger 레코드 1개, 지출 $10.00

2. posted 전환 시도:
   → finalizePendingLedger("pend_123") 실패 (null 반환)
   → insertPostedLedgerNew() 호출
   → budget_key="post_456", amount=$12.50 추가

3. 결과:
   → ledger 레코드 2개 (pending + posted)
   → 지출 $22.50 (중복 계산!)
```

**수정 내용**:

1. **코드 수정** (`supabase/functions/_shared/budget-ledger.ts`):
   ```typescript
   // insertPostedLedgerNew() 수정
   const budgetKey = tx.pending_transaction_id ?? tx.transaction_id;
   // ↑ pending_transaction_id를 budget_key로 사용하여 pending 레코드 덮어씀
   ```

2. **DB 제약조건 추가** (`supabase/migrations/20260731000000_add_unique_posted_pending.sql`):
   ```sql
   CREATE UNIQUE INDEX idx_unique_posted_pending
     ON plaid_budget_ledger (pending_transaction_id)
     WHERE status = 'posted' AND pending_transaction_id IS NOT NULL;
   ```

**결과**:
- ✅ `upsert`의 `onConflict: 'budget_key'` 로직으로 자동 멱등성 보장
- ✅ DB 레벨 안전장치로 중복 posted 레코드 방지
- ✅ 주간 지출 정확도 향상

**파일 변경**:
- `supabase/functions/_shared/budget-ledger.ts` (lines 84-101)
- `supabase/migrations/20260731000000_add_unique_posted_pending.sql` (신규)

**커밋**: `2e6122b`

**상세 문서**: [docs/bug-duplicate-ledger.md](./bug-duplicate-ledger.md)

---

## 배포 요구사항

### Edge Functions 재배포 (필수)
```bash
supabase functions deploy plaid-sync
supabase functions deploy plaid-webhook
```

### DB 마이그레이션 실행 (필수)
```bash
supabase db push
```

### DB 상태 확인 및 수정 (필수)

1. **week_monday 값 확인**:
   ```sql
   SELECT carryover, week_monday, updated_at
   FROM plaid_sync_state
   WHERE id = 1;
   ```

   잘못된 값이면 올바른 주 월요일로 수정

2. **중복 레코드 확인**:
   ```sql
   SELECT
     pending_transaction_id,
     COUNT(*) as count,
     STRING_AGG(budget_key, ', ') as budget_keys
   FROM plaid_budget_ledger
   WHERE pending_transaction_id IS NOT NULL
     AND status IN ('pending', 'posted')
   GROUP BY pending_transaction_id
   HAVING COUNT(*) > 1;
   ```

   중복 발견 시 제거 (상세 내용은 bug-duplicate-ledger.md 참고)

3. **Carryover 재계산 권장**:
   잘못된 주간 경계로 인해 carryover가 부정확할 수 있음

---

## 아키텍처 개선 (2026-07-31)

### 공유 모듈 구조 개선

**변경 내용**:
- 공유 로직을 `supabase/functions/_shared/` 디렉토리로 통합
- `plaid-sync`와 `plaid-webhook`이 동일한 로직 공유
- 중복 코드 제거 및 유지보수성 향상

**파일 구조**:
```
supabase/functions/
├── _shared/              ← 공유 모듈
│   ├── budget.ts
│   ├── budget-ledger.ts
│   ├── budget-state.ts
│   ├── budget-summary.ts
│   ├── notifications.ts
│   ├── plaid.ts
│   ├── slack.ts
│   └── transaction-store.ts
├── plaid-sync/           ← 시간당 폴링 (메인)
│   └── index.ts
└── plaid-webhook/        ← Webhook 수신 (레거시)
    └── index.ts
```

**주의사항**:
- `_shared/` 코드 변경 시 **두 함수 모두** 재배포 필수
- 배포하지 않으면 이전 번들 코드가 계속 실행됨

**커밋**: `65f7996`

---

## 문서 추가 (2026-07-31)

### 신규 문서

1. **[docs/overview.md](./overview.md)** - 시스템 전체 개요
   - 아키텍처 다이어그램
   - 데이터 흐름 상세 설명
   - 예산 시스템 작동 원리
   - DB 스키마 설명
   - 환경 변수 가이드

2. **[docs/deployment-guide.md](./deployment-guide.md)** - 배포 가이드
   - Edge Functions 배포 절차
   - Secrets 설정 방법
   - pg_cron 스케줄 설정
   - 배포 후 검증 및 롤백
   - 일반적인 배포 이슈 해결

3. **[docs/bugfix-timezone.md](./bugfix-timezone.md)** - 타임존 버그 분석
   - 버그 발생 메커니즘
   - 수정 전/후 코드 비교
   - 경계 케이스 시나리오
   - 배포 체크리스트

4. **[docs/bug-duplicate-ledger.md](./bug-duplicate-ledger.md)** - 중복 Ledger 버그 분석
   - 멱등성 분석
   - 버그 시나리오 상세 설명
   - DB 검증 쿼리
   - 수정 방안 비교

5. **[scripts/README.md](../scripts/README.md)** - 예산 조정 스크립트 가이드
   - Adjustment Transaction 원리
   - Node.js / Deno 버전 사용법
   - 예시 시나리오

---

## 스크립트 추가 (2026-07-31)

### 수동 예산 조정 스크립트

1. **scripts/update-budget.js** (Node.js 버전)
   - 간단한 예산 조정
   - `ADJUSTMENT_AMOUNT` 변수 수정 후 실행
   - `node scripts/update-budget.js`

2. **scripts/update-budget-deno.ts** (Deno 버전)
   - Deno 기반 예산 조정
   - `npm run update-budget` 또는 `make update-budget`

**동작 원리**:
- Adjustment transaction을 ledger에 추가
- 양수 adjustment (+$100) → 음수 amount (-$100) 저장 → 지출 감소
- 음수 adjustment (-$50) → 양수 amount (+$50) 저장 → 지출 증가
- Slack 알림 자동 전송

---

## 멱등성 보장

### 정상 동작하는 경우 ✅

1. **Pending → Posted 전환**:
   - `finalizePendingLedger()` 성공 시 UPDATE 사용
   - 레코드 1개 유지, 중복 없음

2. **동일 거래 중복 추가**:
   - `handleAdded()`에서 기존 레코드 체크
   - 이미 존재하면 스킵 (멱등성)

3. **Pending 금액 변경**:
   - `updatePendingLedgerAmount()` 사용
   - UPDATE로 처리, 중복 없음

### 버그 케이스 → 수정 완료 ✅

4. **finalizePendingLedger() 실패**:
   - **수정 전**: 새 레코드 추가 → 중복
   - **수정 후**: `pending_transaction_id`를 `budget_key`로 사용 → 자동 덮어쓰기

---

## 테스트 및 검증

### 주간 경계 테스트

경계 케이스 테스트 완료:
- ✅ 일요일 밤 11:59 PM (LA)
- ✅ 월요일 자정 (LA)
- ✅ 타임존 변경 지점

### 멱등성 테스트

시나리오별 검증 완료:
- ✅ Pending → Posted 정상 전환
- ✅ 동일 거래 재추가
- ✅ Pending 금액 변경
- ✅ finalizePendingLedger() 실패 시 fallback

---

## 향후 개선 사항

### 모니터링

1. **주간 경계 전환 모니터링**:
   - 일요일 밤 ~ 월요일 새벽 알림 확인
   - week_monday 값 자동 검증

2. **중복 레코드 자동 감지**:
   - 정기적으로 중복 확인 쿼리 실행
   - 중복 발견 시 알림

### 테스트 자동화

1. **타임존 테스트**:
   - CI/CD에 경계 케이스 테스트 추가
   - 배포 전 자동 검증

2. **멱등성 테스트**:
   - 동일 거래 중복 추가 시나리오
   - Pending → Posted 전환 시나리오

---

## 참고 링크

- [시스템 개요](./overview.md)
- [배포 가이드](./deployment-guide.md)
- [타임존 버그 분석](./bugfix-timezone.md)
- [중복 Ledger 버그 분석](./bug-duplicate-ledger.md)
- [예산 조정 스크립트 가이드](../scripts/README.md)

---

**마지막 업데이트**: 2026-07-31
