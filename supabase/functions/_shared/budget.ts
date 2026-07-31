export const WEEKLY_BUDGET = parseFloat(Deno.env.get('WEEKLY_BUDGET') ?? '350');
export const BUDGET_TIMEZONE = Deno.env.get('BUDGET_TIMEZONE') ?? 'America/Los_Angeles';

export const EXCLUSION_KEYWORDS = [
  'zelle',
  'vzwrlss',
  'check',
  'sterling',
  'arco',
  'apple.com',
  'cosmic fuel',
  'frontier',
  'google one',
  'google',
  'online transfer',
  'chevron',
  'oil',
  'shell',
  'payroll',
  'robinhood',
];

export interface PlaidTransaction {
  transaction_id: string;
  account_id: string;
  amount: number;
  merchant_name?: string | null;
  name?: string | null;
  original_description?: string | null;
  counterparties?: { name?: string | null }[] | null;
  pending_transaction_id?: string | null;
  date: string;
  category?: string[] | null;
  pending: boolean;
}

export function displayMerchant(tx: PlaidTransaction): string {
  return (tx.merchant_name || tx.name || 'Unknown').trim();
}

export interface WeekDateRange {
  monday: string;
  sunday: string;
  label: string;
}

export interface BudgetSummary {
  weeklyBudget: number;
  carryover: number;
  totalBudget: number;
  spent: number;
  remaining: number;
  weekRange: WeekDateRange;
}

export function addDaysToIsoDate(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

export function calculateSpent(transactions: PlaidTransaction[]): number {
  // 부호 포함 합산: 양수=지출, 음수=입금/adjustment → spent 감소
  return transactions
    .filter((tx) => !isExcluded(tx))
    .reduce((sum, tx) => sum + tx.amount, 0);
}

export function isExcluded(tx: PlaidTransaction): boolean {
  const counterpartyNames = (tx.counterparties ?? [])
    .map((c) => c.name ?? '')
    .join(' ');
  const haystack = [
    tx.merchant_name,
    tx.name,
    tx.original_description,
    counterpartyNames,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return EXCLUSION_KEYWORDS.some((kw) => haystack.includes(kw));
}

export function getWeekDateRange(timezone: string): WeekDateRange {
  const now = new Date();

  // Get the current date parts in the target timezone
  const dateFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const todayStr = dateFormatter.format(now); // 'YYYY-MM-DD'

  // Get the weekday in the target timezone (CRITICAL: must use timezone-aware weekday)
  const weekdayFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'long',
  });
  const weekdayStr = weekdayFormatter.format(now);

  // Map weekday to days from Monday
  const weekdayMap: Record<string, number> = {
    'Monday': 0,
    'Tuesday': 1,
    'Wednesday': 2,
    'Thursday': 3,
    'Friday': 4,
    'Saturday': 5,
    'Sunday': 6,
  };
  const daysFromMonday = weekdayMap[weekdayStr];

  // Perform date arithmetic using UTC to avoid timezone shifts
  const [y, m, d] = todayStr.split('-').map(Number);
  const todayDate = new Date(Date.UTC(y, m - 1, d));

  const mondayDate = new Date(todayDate);
  mondayDate.setUTCDate(todayDate.getUTCDate() - daysFromMonday);

  const sundayDate = new Date(mondayDate);
  sundayDate.setUTCDate(mondayDate.getUTCDate() + 6);

  const toIsoDate = (dt: Date): string => {
    const yy = dt.getUTCFullYear();
    const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(dt.getUTCDate()).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
  };

  const monStr = toIsoDate(mondayDate);
  const sunStr = toIsoDate(sundayDate);

  const labelFormatter = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: timezone,
  });
  const label = `Mon ${labelFormatter.format(mondayDate)} - Sun ${labelFormatter.format(sundayDate)}`;

  return { monday: monStr, sunday: sunStr, label };
}

export function buildBudgetSummaryFromSpent(
  weekRange: WeekDateRange,
  carryover: number,
  spent: number,
): BudgetSummary {
  const totalBudget = WEEKLY_BUDGET + carryover;
  return {
    weeklyBudget: WEEKLY_BUDGET,
    carryover,
    totalBudget,
    spent,
    remaining: totalBudget - spent,
    weekRange,
  };
}

export function calculateBudgetSummary(
  weekTransactions: PlaidTransaction[],
  weekRange: WeekDateRange,
  carryover: number,
): BudgetSummary {
  const spent = calculateSpent(weekTransactions);
  const totalBudget = WEEKLY_BUDGET + carryover;
  const remaining = totalBudget - spent;

  return {
    weeklyBudget: WEEKLY_BUDGET,
    carryover,
    totalBudget,
    spent,
    remaining,
    weekRange,
  };
}
