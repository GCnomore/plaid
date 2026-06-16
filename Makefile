DENO := deno
DENO_RUN := $(DENO) run --config scripts/deno.json --env-file=.env --allow-net --allow-env

.PHONY: help sync sync-notify

help:
	@echo "Usage:"
	@echo "  make sync         refresh + sync → DB 저장 (Slack 없음)"
	@echo "  make sync-notify  refresh + sync → DB 저장 + Slack 알림"

sync:
	$(DENO_RUN) scripts/sync.ts

sync-notify:
	$(DENO_RUN) scripts/sync.ts --notify
