# 배포 가이드

## Edge Functions 배포

### 사전 요구사항

1. Supabase CLI 설치
   ```bash
   npm install -g supabase
   ```

2. Supabase 프로젝트 로그인
   ```bash
   supabase login
   supabase link --project-ref <your-project-ref>
   ```

### 배포 명령

#### 1. 단일 Function 배포

```bash
# plaid-sync 배포
supabase functions deploy plaid-sync

# plaid-webhook 배포
supabase functions deploy plaid-webhook
```

#### 2. 공유 로직 변경 시 (중요!)

`supabase/functions/_shared/` 디렉토리의 파일을 수정한 경우, **반드시 두 함수를 모두 재배포**해야 합니다:

```bash
supabase functions deploy plaid-sync
supabase functions deploy plaid-webhook
```

**이유**: Edge Functions는 배포 시 필요한 파일을 번들링하므로, 공유 로직 변경 후 재배포하지 않으면 이전 코드가 계속 실행됩니다.

### 환경 변수 (Secrets) 설정

#### 필수 Secrets

```bash
# Plaid API
supabase secrets set PLAID_CLIENT_ID=your_client_id
supabase secrets set PLAID_SECRET=your_secret
supabase secrets set PLAID_ACCESS_TOKEN=your_access_token
supabase secrets set PLAID_ENV=production

# Supabase
supabase secrets set SUPABASE_URL=https://your-project.supabase.co
supabase secrets set SUPABASE_SECRET_KEYS='{"default":"your_service_role_key"}'

# 예산 설정
supabase secrets set WEEKLY_BUDGET=350
supabase secrets set BUDGET_TIMEZONE=America/Los_Angeles

# Slack
supabase secrets set SLACK_WEBHOOK_URL=https://hooks.slack.com/services/YOUR/WEBHOOK/URL
```

#### Secrets 확인

```bash
supabase secrets list
```

#### 개별 Secret 삭제

```bash
supabase secrets unset SECRET_NAME
```

---

## 데이터베이스 마이그레이션

### 새 마이그레이션 적용

```bash
# 로컬 Supabase 시작 (필요시)
supabase start

# 마이그레이션 적용
supabase db push

# 또는 프로덕션에 직접 적용
supabase db push --db-url postgresql://postgres:[password]@[host]:5432/postgres
```

### 마이그레이션 생성

```bash
# SQL 파일로 직접 생성
supabase migration new create_new_table

# 또는 UI 변경사항 기반 자동 생성
supabase db diff --schema public > supabase/migrations/new_migration.sql
```

---

## pg_cron 스케줄 설정

### 초기 설정

Supabase Dashboard > SQL Editor에서 실행:

```sql
-- 1. pg_cron extension 활성화 (이미 되어있을 수 있음)
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- 2. trigger_plaid_sync_v2 함수 생성
CREATE OR REPLACE FUNCTION trigger_plaid_sync_v2()
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  request_id BIGINT;
  function_url TEXT;
BEGIN
  function_url := 'https://YOUR_PROJECT_ID.supabase.co/functions/v1/plaid-sync';

  SELECT INTO request_id net.http_post(
    url := function_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );

  RAISE NOTICE 'Plaid sync triggered at %, request_id: %', now(), request_id;
  RETURN 'Request ID: ' || request_id::text;
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'Error triggering plaid sync: %', SQLERRM;
    RETURN 'Error: ' || SQLERRM;
END;
$$;

-- 3. 매시간 실행 스케줄 등록
SELECT cron.schedule(
  'plaid-hourly-sync',      -- job name
  '0 * * * *',              -- cron expression (매시간 정각)
  'SELECT trigger_plaid_sync_v2();'
);
```

### 스케줄 확인

```sql
-- 등록된 스케줄 목록
SELECT * FROM cron.job;

-- 최근 실행 히스토리
SELECT *
FROM cron.job_run_details
ORDER BY start_time DESC
LIMIT 20;
```

### 스케줄 수정

```sql
-- 스케줄 일시 중지
SELECT cron.unschedule('plaid-hourly-sync');

-- 새 스케줄 등록 (예: 30분마다)
SELECT cron.schedule(
  'plaid-30min-sync',
  '*/30 * * * *',
  'SELECT trigger_plaid_sync_v2();'
);
```

### Cron Expression 예시

```
0 * * * *      → 매시간 정각
*/30 * * * *   → 30분마다
0 */2 * * *    → 2시간마다
0 9 * * *      → 매일 오전 9시
0 9 * * 1      → 매주 월요일 오전 9시
```

---

## 배포 후 검증

### 1. Edge Function 로그 확인

Supabase Dashboard > Edge Functions > Logs

확인 사항:
- Function 호출 성공 여부
- Plaid API 응답
- DB 저장 성공 여부
- Slack 전송 성공 여부

### 2. 수동 동기화 테스트

```bash
# 로컬에서 테스트
make sync-notify

# 또는
npm run sync:notify
```

### 3. DB 상태 확인

```sql
-- sync_state 확인
SELECT * FROM plaid_sync_state WHERE id = 1;

-- 최근 거래 확인
SELECT
  transaction_date,
  status,
  amount,
  merchant_name
FROM plaid_budget_ledger
WHERE status IN ('pending', 'posted')
ORDER BY transaction_date DESC
LIMIT 20;

-- 이번 주 지출 확인
SELECT
  SUM(amount) as total_spent,
  COUNT(*) as transaction_count
FROM plaid_budget_ledger
WHERE status IN ('pending', 'posted')
  AND transaction_date >= '2026-07-27'  -- 이번 주 월요일
  AND transaction_date <= '2026-08-02'; -- 이번 주 일요일
```

### 4. Slack 알림 확인

pg_cron이 다음 정각에 실행될 때까지 기다리거나, 수동으로 트리거:

```sql
SELECT trigger_plaid_sync_v2();
```

---

## 롤백 절차

### Edge Function 롤백

이전 버전으로 롤백은 직접 지원되지 않으므로, 이전 커밋의 코드를 재배포:

```bash
# 이전 커밋으로 이동
git checkout <previous-commit-hash>

# 재배포
supabase functions deploy plaid-sync
supabase functions deploy plaid-webhook

# 다시 최신으로 복귀
git checkout master
```

### 데이터베이스 롤백

```bash
# 특정 마이그레이션까지 롤백
supabase db reset --version <migration-version>
```

**주의**: 프로덕션 DB 롤백은 데이터 손실 위험이 있으므로 백업 필수!

---

## 일반적인 배포 이슈

### 1. Function 배포 실패

**증상**: `supabase functions deploy` 실패

**해결**:
```bash
# 로그인 상태 확인
supabase status

# 재로그인
supabase login

# 프로젝트 재연결
supabase link --project-ref <your-project-ref>
```

### 2. Secrets 적용 안 됨

**증상**: Function에서 환경변수를 읽을 수 없음

**해결**:
```bash
# Secrets 재설정
supabase secrets set KEY=VALUE

# Function 재배포
supabase functions deploy plaid-sync
```

### 3. pg_cron이 실행 안 됨

**증상**: 스케줄 등록했는데 실행 안 됨

**확인**:
```sql
-- job 활성화 여부 확인
SELECT jobid, jobname, schedule, command, active
FROM cron.job
WHERE jobname = 'plaid-hourly-sync';

-- active가 false면 재활성화
UPDATE cron.job
SET active = true
WHERE jobname = 'plaid-hourly-sync';
```

### 4. Plaid API 오류

**증상**: `ITEM_LOGIN_REQUIRED` 또는 `ACCESS_TOKEN_INVALID`

**해결**:
- Plaid Dashboard에서 Item 상태 확인
- 필요시 re-authentication
- `PLAID_ACCESS_TOKEN` secret 업데이트

### 5. 주간 경계 오류 (타임존 버그)

**증상**: Slack 알림의 주간 예산이 이상함

**해결**: [bugfix-timezone.md](./bugfix-timezone.md) 참고

---

## 배포 체크리스트

배포 전 확인 사항:

- [ ] 로컬에서 테스트 완료 (`make sync-notify`)
- [ ] git commit 완료
- [ ] 공유 로직 변경 시 두 함수 모두 배포 예정
- [ ] Secrets 설정 확인
- [ ] DB 마이그레이션 필요 여부 확인
- [ ] 배포 후 롤백 계획 수립

배포 후 확인 사항:

- [ ] Edge Function 로그 확인 (오류 없음)
- [ ] 수동 동기화 테스트 성공
- [ ] DB 데이터 정상
- [ ] Slack 알림 정상
- [ ] pg_cron 다음 실행 시 정상 동작 확인

---

## 긴급 대응

### 알림 일시 중지

```sql
-- pg_cron 스케줄 비활성화
SELECT cron.unschedule('plaid-hourly-sync');
```

### 수동 동기화 (알림 없이)

```bash
make sync  # 알림 없이 DB만 업데이트
```

### Edge Function 비활성화

Supabase Dashboard > Edge Functions > 해당 Function > Pause

---

**작성일**: 2026-07-31
**버전**: 1.0
