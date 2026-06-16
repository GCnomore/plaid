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
  'online transfer',
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
  return transactions
    .filter((tx) => tx.amount > 0 && !isExcluded(tx))
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
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const todayStr = formatter.format(now); // 'YYYY-MM-DD'

  const [y, m, d] = todayStr.split('-').map(Number);
  const todayLocal = new Date(y, m - 1, d);

  // JS getDay(): 0=Sun, 1=Mon, ..., 6=Sat. We need Mon=0 offset.
  const dayOfWeek = todayLocal.getDay(); // 0=Sun
  const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;

  const monday = new Date(todayLocal);
  monday.setDate(todayLocal.getDate() - daysFromMonday);

  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  const toIsoDate = (dt: Date): string => {
    const yy = dt.getFullYear();
    const mm = String(dt.getMonth() + 1).padStart(2, '0');
    const dd = String(dt.getDate()).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
  };

  const monStr = toIsoDate(monday);
  const sunStr = toIsoDate(sunday);

  const labelFormatter = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: timezone,
  });
  const label = `Mon ${labelFormatter.format(monday)} - Sun ${labelFormatter.format(sunday)}`;

  return { monday: monStr, sunday: sunStr, label };
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
