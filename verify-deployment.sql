-- 배포 후 검증 쿼리
-- Supabase Dashboard > SQL Editor에서 실행

-- ========================================
-- 1. 인덱스 생성 확인
-- ========================================
SELECT
  schemaname,
  tablename,
  indexname,
  indexdef
FROM pg_indexes
WHERE tablename = 'plaid_budget_ledger'
  AND indexname = 'idx_unique_posted_pending';
-- 기대: 1 row 반환

-- ========================================
-- 2. week_monday 값 확인
-- ========================================
SELECT
  id,
  carryover,
  week_monday,
  updated_at,
  EXTRACT(DOW FROM week_monday::date) as day_of_week  -- 1=Monday
FROM plaid_sync_state
WHERE id = 1;
-- day_of_week가 1이어야 함 (월요일)

-- ========================================
-- 3. 중복 레코드 확인
-- ========================================
SELECT
  pending_transaction_id,
  COUNT(*) as count,
  STRING_AGG(budget_key, ', ') as budget_keys,
  STRING_AGG(status, ', ') as statuses
FROM plaid_budget_ledger
WHERE pending_transaction_id IS NOT NULL
  AND status IN ('pending', 'posted')
GROUP BY pending_transaction_id
HAVING COUNT(*) > 1;
-- 기대: 0 rows (중복 없음)

-- ========================================
-- 4. 이번 주 지출 확인
-- ========================================
SELECT
  COUNT(DISTINCT COALESCE(posted_transaction_id, pending_transaction_id)) as unique_transactions,
  COUNT(*) as ledger_records,
  SUM(amount) as total_spent
FROM plaid_budget_ledger
WHERE status IN ('pending', 'posted')
  AND transaction_date >= DATE_TRUNC('week', CURRENT_DATE - INTERVAL '1 day')::date + 1  -- 이번 주 월요일
  AND transaction_date <= DATE_TRUNC('week', CURRENT_DATE - INTERVAL '1 day')::date + 7; -- 이번 주 일요일
-- unique_transactions == ledger_records 여야 함

-- ========================================
-- 5. 최근 거래 확인
-- ========================================
SELECT
  transaction_date,
  status,
  amount,
  merchant_name,
  budget_key,
  pending_transaction_id,
  posted_transaction_id
FROM plaid_budget_ledger
WHERE status IN ('pending', 'posted')
ORDER BY transaction_date DESC, id DESC
LIMIT 10;
-- 데이터가 정상적으로 보여야 함
