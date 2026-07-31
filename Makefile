DENO := deno
DENO_RUN := $(DENO) run --config scripts/deno.json --env-file=.env --allow-net --allow-env

.PHONY: help sync sync-notify backfill-notify resend-ledger-notify update-budget check-budget

help:
	@echo "Usage:"
	@echo "  make sync                  refresh + sync → DB 저장 (Slack 없음)"
	@echo "  make sync-notify           refresh + sync → DB 저장 + Slack 알림"
	@echo "  make backfill-notify       [ONE-TIME] cursor 리셋 + 전체 sync + Slack"
	@echo "  make resend-ledger-notify  이번 주 ledger 기준 Slack 재전송"
	@echo "  make update-budget         버젯(이월 금액) 수동 수정"
	@echo "  make check-budget          현재 주간 예산 상태 확인 + Slack 알림"

sync:
	$(DENO_RUN) scripts/sync.ts

sync-notify:
	$(DENO_RUN) scripts/sync.ts --notify

backfill-notify:
	$(DENO_RUN) scripts/backfill-notify.ts

resend-ledger-notify:
	$(DENO_RUN) scripts/resend-ledger-notify.ts

update-budget:
	node scripts/update-budget.js

check-budget:
	$(DENO_RUN) scripts/check-budget.ts
