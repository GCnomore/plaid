# 배포 로그 (2026-07-31)

## 배포 정보

- **배포 일시**: 2026-07-31
- **배포 내용**: Critical Bug Fixes (타임존 버그, 중복 Ledger 버그)
- **커밋**: `bde15d8` (9 commits)

---

## 배포 단계

### ✅ 1. Edge Functions 배포 완료

**plaid-sync**:
- 상태: ✅ 성공
- 크기: 792.2kB
- URL: https://supabase.com/dashboard/project/hqhmkdkipqhanqgdldjm/functions

**plaid-webhook**:
- 상태: ✅ 성공
- 크기: 791.8kB
- URL: https://supabase.com/dashboard/project/hqhmkdkipqhanqgdldjm/functions

### ✅ 2. DB 마이그레이션 완료

**마이그레이션 히스토리 수정**:
- `supabase migration repair --status reverted` 실행
- 3개 마이그레이션 reverted 처리: 20260630000000, 20260630100000, 20260630200000

**새 마이그레이션 적용**:
- 파일: `20260731000000_add_unique_posted_pending.sql`
- 내용: `idx_unique_posted_pending` UNIQUE INDEX 생성
- 상태: ✅ 적용 완료

### 📋 3. DB 검증 필요 (수동)

다음 항목을 Supabase Dashboard에서 확인해야 합니다:

```sql
-- verify-deployment.sql 파일 참조
```

1. **인덱스 생성 확인**:
   ```sql
   SELECT * FROM pg_indexes
   WHERE indexname = 'idx_unique_posted_pending';
   ```
   - 기대: 1 row

2. **week_monday 값 확인**:
   ```sql
   SELECT id, week_monday,
          EXTRACT(DOW FROM week_monday::date) as day_of_week
   FROM plaid_sync_state WHERE id = 1;
   ```
   - 기대: day_of_week = 1 (월요일)
   - 현재 날짜 기준 올바른 주 월요일인지 확인

3. **중복 레코드 확인**:
   ```sql
   SELECT pending_transaction_id, COUNT(*) as count
   FROM plaid_budget_ledger
   WHERE pending_transaction_id IS NOT NULL
     AND status IN ('pending', 'posted')
   GROUP BY pending_transaction_id
   HAVING COUNT(*) > 1;
   ```
   - 기대: 0 rows (중복 없음)

4. **이번 주 지출 확인**:
   ```sql
   SELECT
     COUNT(DISTINCT COALESCE(posted_transaction_id, pending_transaction_id)) as unique_tx,
     COUNT(*) as ledger_records,
     SUM(amount) as total_spent
   FROM plaid_budget_ledger
   WHERE status IN ('pending', 'posted')
     AND transaction_date >= '2026-07-28'  -- 이번 주 월요일
     AND transaction_date <= '2026-08-03'; -- 이번 주 일요일
   ```
   - 기대: unique_tx == ledger_records

### ⏳ 4. 프로덕션 검증 대기 중

다음 항목은 시간 경과 후 확인 필요:

- [ ] **1시간 후**: pg_cron 자동 실행 확인
  - Supabase Dashboard > Edge Functions > plaid-sync > Logs
  - 정각에 실행되는지 확인
  - 오류 없이 완료되는지 확인

- [ ] **Slack 알림 확인**: 새 거래 발생 시
  - 주간 예산 정보 정확한지
  - 남은 예산 계산 정확한지
  - 거래 중복 알림 없는지

- [ ] **24시간 후**: 전체 하루 동작 확인
  - 누적 로그 확인 (오류 없음)
  - 주간 지출 합계 확인
  - 중복 레코드 재확인

---

## 변경 사항 요약

### 🐛 수정된 버그

#### 1. 타임존 버그
- **파일**: `supabase/functions/_shared/budget.ts` (lines 90-149)
- **문제**: UTC 기준 요일 사용으로 주간 경계가 하루씩 틀어짐
- **수정**: 타임존 기준 요일 직접 계산, Date.UTC() 사용

#### 2. 중복 Ledger 버그
- **파일**: `supabase/functions/_shared/budget-ledger.ts` (lines 84-101)
- **문제**: pending → posted 전환 시 중복 레코드 생성
- **수정**: pending_transaction_id를 budget_key로 사용하여 자동 덮어쓰기
- **DB 제약조건**: UNIQUE INDEX 추가

### 📝 추가된 문서

- `docs/overview.md` - 시스템 전체 개요
- `docs/deployment-guide.md` - 배포 가이드
- `docs/bugfix-timezone.md` - 타임존 버그 분석
- `docs/bug-duplicate-ledger.md` - 중복 Ledger 버그 분석
- `docs/CHANGELOG.md` - 변경 이력
- `docs/README.md` - 문서 인덱스
- `DEPLOYMENT_CHECKLIST.md` - 배포 체크리스트
- `scripts/README.md` - 예산 조정 스크립트 가이드

---

## 다음 단계

### 즉시 수행

1. **DB 검증 쿼리 실행** (필수):
   - Supabase Dashboard에서 `verify-deployment.sql` 실행
   - 모든 항목이 정상인지 확인

2. **week_monday 수정** (필요 시):
   - DB 검증에서 week_monday가 잘못된 경우
   - 올바른 월요일 날짜로 수정

3. **중복 레코드 제거** (필요 시):
   - DB 검증에서 중복 발견 시
   - `docs/bug-duplicate-ledger.md` 참고하여 제거

### 모니터링

- **1시간 이내**: pg_cron 첫 실행 확인
- **당일**: Edge Function 로그 모니터링
- **1주일**: 주간 전환 (일요일 → 월요일) 정상 동작 확인

---

## 롤백 정보

문제 발생 시:

1. **Edge Functions 롤백**:
   ```bash
   git checkout 8675bd1
   supabase functions deploy plaid-sync
   supabase functions deploy plaid-webhook
   git checkout master
   ```

2. **DB 롤백** (주의 - 데이터 손실 가능):
   ```sql
   DROP INDEX IF EXISTS idx_unique_posted_pending;
   ```

3. **긴급 중지**:
   ```sql
   SELECT cron.unschedule('plaid-hourly-sync');
   ```

---

## 참고 링크

- **Supabase Project**: https://supabase.com/dashboard/project/hqhmkdkipqhanqgdldjm
- **Edge Functions**: https://supabase.com/dashboard/project/hqhmkdkipqhanqgdldjm/functions
- **SQL Editor**: https://supabase.com/dashboard/project/hqhmkdkipqhanqgdldjm/sql/new
- **문서**: [docs/README.md](docs/README.md)

---

**배포 담당자**: Claude Sonnet 4.5
**배포 완료 시각**: 2026-07-31
**상태**: ✅ 배포 완료, 검증 대기 중
