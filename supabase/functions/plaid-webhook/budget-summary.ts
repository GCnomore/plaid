import type { SupabaseClient } from '@supabase/supabase-js';

import { addDaysToIsoDate, WEEKLY_BUDGET } from './budget.ts';
import { getWeekSpentFromLedger } from './budget-ledger.ts';

export type BudgetOutcome = 'under_budget' | 'over_budget' | 'on_budget';

export interface WeekSummaryInput {
  weekStart: string;
  weekEnd: string;
  carryoverIn: number;
  spent: number;
}

export interface WeekSummaryRecord extends WeekSummaryInput {
  weeklyBudget: number;
  totalBudget: number;
  balance: number;
  outcome: BudgetOutcome;
  carryoverOut: number;
}

function deriveOutcome(balance: number): BudgetOutcome {
  if (balance > 0.001) return 'under_budget';
  if (balance < -0.001) return 'over_budget';
  return 'on_budget';
}

export function buildWeekSummary(input: WeekSummaryInput): WeekSummaryRecord {
  const totalBudget = WEEKLY_BUDGET + input.carryoverIn;
  const balance = totalBudget - input.spent;
  const carryoverOut = Math.max(0, balance);

  return {
    ...input,
    weeklyBudget: WEEKLY_BUDGET,
    totalBudget,
    balance,
    outcome: deriveOutcome(balance),
    carryoverOut,
  };
}

export async function saveWeekSummary(
  supabase: SupabaseClient,
  summary: WeekSummaryRecord,
): Promise<void> {
  const { error } = await supabase
    .from('plaid_weekly_budget_summaries')
    .upsert(
      {
        week_start: summary.weekStart,
        week_end: summary.weekEnd,
        weekly_budget: summary.weeklyBudget,
        carryover_in: summary.carryoverIn,
        total_budget: summary.totalBudget,
        spent: summary.spent,
        balance: summary.balance,
        outcome: summary.outcome,
        carryover_out: summary.carryoverOut,
      },
      { onConflict: 'week_start', ignoreDuplicates: true },
    );

  if (error) throw new Error(`주간 budget summary 저장 실패: ${error.message}`);
}

export async function closeWeekAndGetCarryover(
  supabase: SupabaseClient,
  weekStart: string,
  carryoverIn: number,
): Promise<number> {
  const weekEnd = addDaysToIsoDate(weekStart, 6);
  const spent = await getWeekSpentFromLedger(supabase, weekStart, weekEnd);
  const summary = buildWeekSummary({ weekStart, weekEnd, carryoverIn, spent });

  await saveWeekSummary(supabase, summary);
  console.log(
    `[Budget] 주간 마감 ${weekStart}~${weekEnd}: spent $${spent.toFixed(2)}, ` +
      `balance $${summary.balance.toFixed(2)} (${summary.outcome}), ` +
      `carryover $${summary.carryoverOut.toFixed(2)}`,
  );

  return summary.carryoverOut;
}
