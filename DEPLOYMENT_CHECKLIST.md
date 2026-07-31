# 배포 체크리스트 (2026-07-31 버그 수정)

이 체크리스트는 2026-07-31에 수정된 2개의 Critical 버그 배포를 위한 것입니다.

---

## ⚠️ 배포 전 확인사항

- [ ] 모든 변경사항이 커밋되어 있음
- [ ] 로컬에서 테스트 완료 (`make sync-notify`)
- [ ] 배포 후 롤백 계획 수립
- [ ] Slack 알림 채널 준비 (배포 알림 확인용)

---

## 🚀 배포 단계

### 1. Edge Functions 재배포 (필수)

```bash
# 두 함수 모두 재배포 (공유 로직 변경됨)
supabase functions deploy plaid-sync
supabase functions deploy plaid-webhook
```

**확인**:
- [ ] `plaid-sync` 배포 성공
- [ ] `plaid-webhook` 배포 성공
- [ ] Supabase Dashboard > Edge Functions > Logs 확인

---

### 2. DB 마이그레이션 실행 (필수)

```bash
supabase db push
```

**확인**:
- [ ] 마이그레이션 성공
- [ ] `idx_unique_posted_pending` 인덱스 생성 확인

**검증 쿼리**:
```sql
-- 인덱스 생성 확인
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'plaid_budget_ledger'
  AND indexname = 'idx_unique_posted_pending';
```

- [ ] 인덱스가 존재함

---

### 3. DB 상태 확인 및 수정 (필수)

#### 3.1 week_monday 값 확인

```sql
SELECT id, carryover, week_monday, updated_at
FROM plaid_sync_state
WHERE id = 1;
```

**올바른 week_monday 계산 방법**:
1. LA 타임존 기준 오늘 날짜 확인
2. 오늘이 무슨 요일인지 확인
3. 이번 주 월요일 날짜 계산

**예시** (2026-07-31 기준):
- 오늘: 2026-07-31 (LA 기준 금요일)
- 이번 주 월요일: 2026-07-28 ← **올바른 값**

- [ ] week_monday 값이 올바름
- [ ] 잘못된 경우 수정:
  ```sql
  UPDATE plaid_sync_state
  SET week_monday = '2026-07-28',  -- 올바른 월요일
      updated_at = NOW()
  WHERE id = 1;
  ```

#### 3.2 중복 Ledger 레코드 확인

```sql
-- 중복 레코드 확인
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

- [ ] 중복 레코드가 없음
- [ ] 중복 발견 시 제거 (docs/bug-duplicate-ledger.md 참고):
  ```sql
  -- pending 상태 레코드를 removed로 표시
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

#### 3.3 Carryover 재계산 (권장)

```sql
-- 지난 주 지출 확인
SELECT SUM(amount) as total_spent
FROM plaid_budget_ledger
WHERE status IN ('pending', 'posted')
  AND transaction_date >= '2026-07-21'  -- 지난 주 월요일
  AND transaction_date <= '2026-07-27'; -- 지난 주 일요일

-- 수동으로 carryover 재계산
-- carryover = (지난 주 예산 + 지난 주 carryover) - 지난 주 지출
-- 예: (350 + 0) - 320 = 30
```

- [ ] 지난 주 지출 확인
- [ ] Carryover 계산
- [ ] 필요 시 수정:
  ```sql
  UPDATE plaid_sync_state
  SET carryover = 30.00,  -- 계산된 값
      updated_at = NOW()
  WHERE id = 1;
  ```

---

## ✅ 배포 후 검증

### 4. Edge Function 로그 확인

Supabase Dashboard > Edge Functions > plaid-sync > Logs

**확인사항**:
- [ ] 최근 실행 로그에 오류 없음
- [ ] Plaid API 호출 성공
- [ ] DB 저장 성공
- [ ] Slack 전송 성공 (거래 있을 경우)

---

### 5. 수동 동기화 테스트

```bash
make sync-notify
```

**확인사항**:
- [ ] 스크립트 실행 성공
- [ ] 콘솔에 오류 없음
- [ ] 주간 지출 계산 정확함
- [ ] Slack 알림 정상 (거래 있을 경우)

---

### 6. DB 검증 쿼리 실행

#### 6.1 이번 주 지출 확인

```sql
SELECT
  COUNT(DISTINCT COALESCE(posted_transaction_id, pending_transaction_id)) as unique_transactions,
  COUNT(*) as ledger_records,
  SUM(amount) as total_spent
FROM plaid_budget_ledger
WHERE status IN ('pending', 'posted')
  AND transaction_date >= '2026-07-28'  -- 이번 주 월요일
  AND transaction_date <= '2026-08-03'; -- 이번 주 일요일
```

**기대 결과**:
- `unique_transactions` == `ledger_records` (중복 없음)

- [ ] 중복 없음

#### 6.2 최근 거래 확인

```sql
SELECT
  transaction_date,
  status,
  amount,
  merchant_name,
  budget_key,
  pending_transaction_id,
  posted_transaction_id
FROM plaid_budget_ledger
WHERE status IN ('pending', 'posted')
ORDER BY transaction_date DESC, id DESC
LIMIT 20;
```

- [ ] 데이터가 정상적으로 보임

---

### 7. Slack 알림 확인

**다음 정각에 pg_cron이 실행될 때**:
- [ ] Slack 알림 수신 (새 거래 있을 경우)
- [ ] 주간 예산 정보 정확함
- [ ] 남은 예산 계산 정확함

**또는 수동 트리거**:
```sql
SELECT trigger_plaid_sync_v2();
```

- [ ] Function 실행 성공
- [ ] Slack 알림 정상

---

## 📊 모니터링 (배포 후 24시간)

### 체크포인트

- [ ] **1시간 후**: pg_cron 자동 실행 확인
- [ ] **3시간 후**: 누적 로그 확인 (오류 없음)
- [ ] **24시간 후**: 전체 하루 동작 확인

### 모니터링 쿼리

```sql
-- pg_cron 실행 히스토리
SELECT *
FROM cron.job_run_details
WHERE jobname = 'plaid-hourly-sync'
ORDER BY start_time DESC
LIMIT 10;

-- 오늘 추가된 거래 수
SELECT COUNT(*)
FROM plaid_budget_ledger
WHERE created_at >= CURRENT_DATE;

-- 중복 레코드 재확인
SELECT
  pending_transaction_id,
  COUNT(*) as count
FROM plaid_budget_ledger
WHERE pending_transaction_id IS NOT NULL
  AND status IN ('pending', 'posted')
GROUP BY pending_transaction_id
HAVING COUNT(*) > 1;
```

---

## 🔄 롤백 (문제 발생 시)

### Edge Functions 롤백

```bash
# 이전 커밋으로 이동
git checkout 8675bd1  # 버그 수정 전 커밋

# 재배포
supabase functions deploy plaid-sync
supabase functions deploy plaid-webhook

# 다시 최신으로 복귀
git checkout master
```

### DB 롤백 (주의!)

```sql
-- UNIQUE INDEX 제거
DROP INDEX IF EXISTS idx_unique_posted_pending;

-- 마이그레이션 롤백은 데이터 손실 위험 있음
-- 프로덕션에서는 백업 필수!
```

---

## 📝 배포 완료 후

- [ ] 배포 완료 시각 기록: _______________
- [ ] 배포 담당자: _______________
- [ ] 배포 노트 작성 (이슈 발생 시)
- [ ] 팀에 배포 완료 공지

---

## 🆘 문제 발생 시 연락처

- **긴급**: Slack 알림 일시 중지
  ```sql
  SELECT cron.unschedule('plaid-hourly-sync');
  ```

- **로그 확인**: Supabase Dashboard > Edge Functions > Logs
- **문서 참고**:
  - [docs/deployment-guide.md](docs/deployment-guide.md)
  - [docs/bugfix-timezone.md](docs/bugfix-timezone.md)
  - [docs/bug-duplicate-ledger.md](docs/bug-duplicate-ledger.md)

---

**작성일**: 2026-07-31
**버전**: 1.0
