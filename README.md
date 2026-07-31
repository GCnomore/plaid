# Plaid Weekly Budget Alerts

Plaid 거래를 주기적으로 동기화하고, 주간 예산을 추적한 뒤  qualifying 거래를 Slack으로 알린다.

---

## 📚 문서

- **[시스템 개요](docs/overview.md)**: 전체 아키텍처, 데이터 흐름, 예산 시스템 상세 설명
- **[배포 가이드](docs/deployment-guide.md)**: Edge Functions 배포, DB 마이그레이션, pg_cron 설정
- **[예산 조정 가이드](scripts/README.md)**: 수동 예산 조정 스크립트 사용법

### 버그 수정 내역
- **[타임존 버그](docs/bugfix-timezone.md)**: 주간 경계 계산 타임존 버그 (2026-07-31)
- **[중복 Ledger 버그](docs/bug-duplicate-ledger.md)**: Pending → Posted 중복 계산 버그 (2026-07-31)

---

## Architecture (현재)

원래는 **Plaid webhook**을 기다렸다가 `plaid-webhook` Edge Function이 동기화·알림을 수행했다.  
실제로는 webhook이 **하루 한 번 정도만** 와서 알림이 너무 늦어졌다.

그래서 지금은 **1시간마다 Plaid API를 폴링**하는 방식으로 바꿨다.

```
pg_cron (매시간)
  → DB function: trigger_plaid_sync_v2()
    → pg_net.http_post
      → Edge Function: plaid-sync
        → Plaid /transactions/sync
        → DB 적재 (ledger / transactions)
        → Slack (조건 충족 시)
```

### Supabase 스케줄

| 구성요소 | 역할 |
|----------|------|
| **pg_cron** | 매시간 `trigger_plaid_sync_v2()` 호출 |
| **`trigger_plaid_sync_v2`** | `pg_net`으로 Edge Function에 비동기 HTTP POST |
| **`plaid-sync`** | 실제 sync + (필요 시) Slack 발송 |

프로덕션 URL:

```
https://hqhmkdkipqhanqgdldjm.supabase.co/functions/v1/plaid-sync
```

`trigger_plaid_sync_v2` 본문 (참고용):

```sql
declare
  request_id bigint;
  function_url text;
begin
  function_url := 'https://hqhmkdkipqhanqgdldjm.supabase.co/functions/v1/plaid-sync';

  select into request_id net.http_post(
    url := function_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );

  raise notice 'Plaid sync triggered at %, request_id: %', now(), request_id;
  return 'Request ID: ' || request_id::text;
exception
  when others then
    raise notice 'Error triggering plaid sync: %', SQLERRM;
    return 'Error: ' || SQLERRM;
end;
```

> **소스 구조:** 공통 로직은 `supabase/functions/_shared/` (spent 부호 포함 합산, Slack, ledger).  
> 엔트리포인트: `plaid-sync` (시간당 폴링), `plaid-webhook` (레거시). 로컬 수동 실행은 `scripts/sync.ts`.

### (레거시) Webhook 경로

`plaid-webhook`은 여전히 Plaid `TRANSACTIONS` / `SYNC_UPDATES_AVAILABLE` webhook을 받을 수 있다.  
다만 알림의 주 경로가 아니며, 빈 cursor / `?bootstrap=1` 일 때는 Slack 없이 bootstrap만 한다.

**배포:** 공통 로직을 바꾼 뒤에는 `plaid-sync`와 `plaid-webhook` 둘 다 다시 배포해야 한다.

```bash
supabase functions deploy plaid-sync
supabase functions deploy plaid-webhook
```

---

## Slack 알림이 나가려면

전송 수단: Slack **Incoming Webhook** (`SLACK_WEBHOOK_URL`).

### 1. 환경

- Edge Function / 스크립트에 `SLACK_WEBHOOK_URL`이 설정되어 있어야 한다.
- `update-budget`만 URL이 없으면 조용히 스킵한다. 거래 알림 경로는 URL 없으면 전송 실패.

### 2. Sync가 notify를 켠 상태로 돌아야 함

| 경로 | Slack |
|------|--------|
| 매시간 `plaid-sync` (cron) | ✅ (프로덕션 메인) |
| `make sync-notify` / `npm run sync:notify` | ✅ |
| `make backfill-notify` | ✅ (일회성) |
| `make resend-ledger-notify` | ✅ (이번 주 ledger 재전송) |
| `make update-budget` | ✅ (예산 조정 알림, URL 있을 때). ledger에 음수 amount를 넣어 spent를 줄임 |
| `make sync` (notify 없음) | ❌ |
| webhook bootstrap / 빈 cursor | ❌ |

### 3. 거래가 NotifyRequest로  qualifying 해야 함

공통: `isExcluded(tx)`면 DB만 기록하고 Slack 없음.

**제외 키워드** (merchant / name / description / counterparties 부분 문자열):

`zelle`, `vzwrlss`, `check`, `sterling`, `arco`, `apple.com`, `cosmic fuel`, `frontier`, `google one`, `google`, `online transfer`, `chevron`, `oil`, `shell`, `payroll`, `robinhood`

**나가는 경우**

| 상황 | 메시지 kind |
|------|-------------|
| 새 pending 거래 | `pending` |
| 이전 pending 없이 바로 posted | `posted_new` |
| pending → posted 인데 **금액 또는 가맹점 변경** | `posted_confirm` |

**안 나가는 경우**

- 제외 키워드
- 이미 DB에 있는 거래 재추가
- pending 상태에서의 수정만 (확정 전)
- pending → posted인데 금액·가맹점 동일
- 이미 posted된 거래의 추가 수정
- removed 처리

금액 하한 없음. 지출(`amount > 0`)·입금(`amount ≤ 0`) 모두 대상이 될 수 있다.

관련 코드: `supabase/functions/_shared/transaction-store.ts`, `budget.ts`, `slack.ts`, `notifications.ts`  
엔트리: `supabase/functions/plaid-sync/`, `supabase/functions/plaid-webhook/`


---

## 로컬 / 수동 명령

```bash
make sync                  # refresh + sync → DB만
make sync-notify           # 위 + Slack
make backfill-notify       # [ONE-TIME] cursor 리셋 + 전체 sync + Slack
make resend-ledger-notify  # 이번 주 ledger 기준 Slack 재전송
make update-budget         # adjustment transaction으로 예산 수동 조정
```

예산 조정 상세: [`scripts/README.md`](scripts/README.md)

---

## 환경 변수

`.env.example` 기준:

| 변수 | 용도 |
|------|------|
| `PLAID_CLIENT_ID` / `PLAID_SECRET` / `PLAID_ACCESS_TOKEN` | Plaid API |
| `PLAID_ENV` | 기본 `production` |
| `SUPABASE_URL` | Supabase 프로젝트 URL |
| `SUPABASE_SECRET_KEYS` | `{"default":"<service_role_key>"}` |
| `WEEKLY_BUDGET` | 주간 기본 예산 (기본 350) |
| `BUDGET_TIMEZONE` | 주 경계 타임존 (기본 `America/Los_Angeles`) |
| `SLACK_WEBHOOK_URL` | Slack Incoming Webhook |
| `REFRESH_WAIT_MS` / `SYNC_RETRY_*` | 수동 sync 튜닝 (선택) |
| `SLACK_DELAY_MS` | backfill/resend 시 메시지 간격 (선택, 기본 300) |

Edge Function secrets에도 동일하게 Plaid / Supabase / Slack / budget 값을 넣어야 프로덕션 폴링이 동작한다.

---

## DB 테이블 (개요)

| 테이블 | 역할 |
|--------|------|
| `plaid_sync_state` | sync cursor, carryover |
| `plaid_budget_transactions` | Plaid 거래 미러 |
| `plaid_budget_ledger` | 주간 지출/알림 기준 ledger (pending/posted/adjustment) |
| `plaid_weekly_budget_summaries` | 주간 요약 |
| `plaid_webhook_logs` | (레거시) webhook payload 로그 |

마이그레이션: `supabase/migrations/`

---

## 빠른 점검 체크리스트

Slack이 안 올 때:

1. pg_cron이 돌고 있는지 / `trigger_plaid_sync_v2` notice·`net.http_post` request_id
2. `plaid-sync` Edge Function 로그 (sync 성공 여부)
3. `SLACK_WEBHOOK_URL` secret
4. 거래가 제외 키워드인지
5. pending → posted인데 금액·가맹점이 그대로인지 (이 경우 의도적으로 무음)
)
