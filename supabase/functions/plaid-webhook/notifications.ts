import type { SupabaseClient } from '@supabase/supabase-js';

import { resolveCarryover } from './budget-state.ts';
import {
  buildBudgetSummaryFromSpent,
  BUDGET_TIMEZONE,
  getWeekDateRange,
} from './budget.ts';
import { getWeekSpentFromLedger } from './budget-ledger.ts';
import { sendSlackMessage } from './slack.ts';
import type { NotifyRequest } from './transaction-store.ts';

export interface SendNotificationOptions {
  /** 0이면 알림 순서대로 spent 누적 (resend/backfill). 미설정 시 ledger 기준 배치 시작 spent 사용 */
  startingSpent?: number;
  delayMs?: number;
}

export function notificationSpentDelta(n: NotifyRequest): number {
  if (n.tx.amount <= 0) return 0;
  if (n.kind === 'posted_confirm' && n.priorAmount !== undefined) {
    return n.tx.amount - n.priorAmount;
  }
  return n.tx.amount;
}

function sortNotifications(notifications: NotifyRequest[]): NotifyRequest[] {
  return [...notifications].sort((a, b) => {
    const byDate = a.tx.date.localeCompare(b.tx.date);
    if (byDate !== 0) return byDate;
    return a.tx.transaction_id.localeCompare(b.tx.transaction_id);
  });
}

export async function sendNotificationBatch(
  supabase: SupabaseClient,
  notifications: NotifyRequest[],
  options: SendNotificationOptions = {},
): Promise<number> {
  if (notifications.length === 0) return 0;

  const carryover = await resolveCarryover(supabase);
  const weekRange = getWeekDateRange(BUDGET_TIMEZONE);
  const ordered = sortNotifications(notifications);

  const batchDelta = ordered.reduce((sum, n) => sum + notificationSpentDelta(n), 0);
  const totalSpent = await getWeekSpentFromLedger(supabase, weekRange.monday, weekRange.sunday);

  let runningSpent = options.startingSpent !== undefined
    ? options.startingSpent
    : totalSpent - batchDelta;

  const delayMs = options.delayMs ?? 0;
  let sent = 0;

  for (const { tx, kind, priorAmount, priorMerchant } of ordered) {
    runningSpent += notificationSpentDelta({ tx, kind, priorAmount, priorMerchant });
    const budget = buildBudgetSummaryFromSpent(weekRange, carryover, runningSpent);
    const prior = priorAmount !== undefined && priorMerchant !== undefined
      ? { amount: priorAmount, merchant: priorMerchant }
      : undefined;
    await sendSlackMessage(tx, budget, kind, prior);
    sent++;
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }

  return sent;
}
