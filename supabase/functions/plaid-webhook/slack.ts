import type { BudgetSummary, PlaidTransaction } from './budget.ts';
import { displayMerchant } from './budget.ts';
import type { NotifyKind } from './transaction-store.ts';

const SLACK_WEBHOOK_URL = Deno.env.get('SLACK_WEBHOOK_URL')!;

function formatDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-');
  return `${m}/${d}/${y}`;
}

function formatAmount(amount: number): string {
  return `$${Math.abs(amount).toFixed(2)}`;
}

function headerForKind(kind: NotifyKind): string {
  switch (kind) {
    case 'pending':
      return '💸 새 거래 (승인 대기)';
    case 'posted_confirm':
      return '✅ 거래 확정 (금액/가맹점 변경)';
    case 'posted_new':
      return '💸 새 거래 발생';
  }
}

export async function sendSlackMessage(
  tx: PlaidTransaction,
  budget: BudgetSummary,
  kind: NotifyKind = 'posted_new',
  prior?: { amount: number; merchant: string },
): Promise<void> {
  const isSpend = tx.amount > 0;
  const txLabel = isSpend ? '지출' : '입금';
  const merchant = displayMerchant(tx);
  const category = tx.category?.[0] ?? 'N/A';

  const { weeklyBudget, carryover, totalBudget, spent, remaining, weekRange } = budget;

  const carryoverLine = carryover > 0
    ? `Carryover: ${formatAmount(carryover)}`
    : 'Carryover: $0.00';

  let budgetLine: string;
  if (remaining < 0) {
    budgetLine = `*Remaining*\n🔴 ${formatAmount(remaining)} over budget`;
  } else if (remaining <= 50) {
    budgetLine = `*Remaining*\n🟡 ${formatAmount(remaining)} left`;
  } else {
    budgetLine = `*Remaining*\n${formatAmount(remaining)} left`;
  }

  const amountFields = [{ type: 'mrkdwn', text: `*Amount*\n${txLabel} ${formatAmount(tx.amount)}` }];

  if (kind === 'posted_confirm' && prior) {
    amountFields.push({
      type: 'mrkdwn',
      text: `*이전 (pending)*\n${formatAmount(prior.amount)}`,
    });
  }

  const merchantFields = [{ type: 'mrkdwn', text: `*Merchant*\n${merchant}` }];
  if (kind === 'posted_confirm' && prior && prior.merchant !== merchant) {
    merchantFields.push({ type: 'mrkdwn', text: `*이전 (pending)*\n${prior.merchant}` });
  }

  const statusNote = kind === 'pending'
    ? '_예산에 반영됨 (승인 대기 — 확정 시 금액 변경만 재알림)_'
    : '';

  const blocks: Record<string, unknown>[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: headerForKind(kind) },
    },
    {
      type: 'section',
      fields: [
        ...amountFields,
        ...merchantFields,
        { type: 'mrkdwn', text: `*Date*\n${formatDate(tx.date)}` },
        { type: 'mrkdwn', text: `*Category*\n${category}` },
      ],
    },
  ];

  if (statusNote) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: statusNote }],
    });
  }

  blocks.push(
    {
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: `*This Week (${weekRange.label})*\nWeekly: ${formatAmount(weeklyBudget)}\n${carryoverLine}\nTotal: ${formatAmount(totalBudget)}`,
        },
        {
          type: 'mrkdwn',
          text: `*Spent This Week*\n${formatAmount(spent)} / ${formatAmount(totalBudget)}`,
        },
      ],
    },
    {
      type: 'section',
      fields: [{ type: 'mrkdwn', text: budgetLine }],
    },
    { type: 'divider' },
  );

  const res = await fetch(SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blocks }),
  });

  if (!res.ok) {
    throw new Error(`Slack 전송 실패: ${res.status}`);
  }
}
