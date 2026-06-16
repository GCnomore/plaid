import type { SupabaseClient } from '@supabase/supabase-js';

import {
  addDaysToIsoDate,
  BUDGET_TIMEZONE,
  getWeekDateRange,
} from './budget.ts';
import { closeWeekAndGetCarryover } from './budget-summary.ts';

interface BudgetStateRow {
  carryover: number;
  week_monday: string | null;
}

async function readBudgetState(supabase: SupabaseClient): Promise<BudgetStateRow> {
  const { data, error } = await supabase
    .from('plaid_sync_state')
    .select('carryover, week_monday')
    .eq('id', 1)
    .single();

  if (error) throw new Error(`budget state 읽기 실패: ${error.message}`);
  return {
    carryover: Number(data.carryover ?? 0),
    week_monday: data.week_monday ?? null,
  };
}

async function saveBudgetState(
  supabase: SupabaseClient,
  carryover: number,
  weekMonday: string,
): Promise<void> {
  const { error } = await supabase
    .from('plaid_sync_state')
    .update({
      carryover,
      week_monday: weekMonday,
      updated_at: new Date().toISOString(),
    })
    .eq('id', 1);

  if (error) throw new Error(`budget state 저장 실패: ${error.message}`);
}

export async function resolveCarryover(supabase: SupabaseClient): Promise<number> {
  const weekRange = getWeekDateRange(BUDGET_TIMEZONE);
  const state = await readBudgetState(supabase);

  if (!state.week_monday) {
    await saveBudgetState(supabase, 0, weekRange.monday);
    return 0;
  }

  if (state.week_monday === weekRange.monday) {
    return state.carryover;
  }

  let carryover = state.carryover;
  let closingMonday = state.week_monday;

  while (closingMonday < weekRange.monday) {
    carryover = await closeWeekAndGetCarryover(supabase, closingMonday, carryover);
    closingMonday = addDaysToIsoDate(closingMonday, 7);
  }

  await saveBudgetState(supabase, carryover, weekRange.monday);

  return carryover;
}
