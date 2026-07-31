-- Add UNIQUE constraint on pending_transaction_id for posted records
-- This prevents duplicate posted records with the same pending_transaction_id
-- Provides DB-level safety against the duplicate ledger bug

CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_posted_pending
  ON public.plaid_budget_ledger (pending_transaction_id)
  WHERE status = 'posted' AND pending_transaction_id IS NOT NULL;

-- Add comment explaining the constraint
COMMENT ON INDEX public.idx_unique_posted_pending IS
  'Prevents duplicate posted records with the same pending_transaction_id.
   Ensures idempotency when finalizePendingLedger() fails to find the pending record.';
