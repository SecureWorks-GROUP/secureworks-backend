-- Approve one of the two proposals, then hold the transaction open for
-- :hold seconds so the other session races it.
BEGIN;
SELECT set_config('pb10.proposal', :'proposal', true);
DO $$
BEGIN
  PERFORM public.price_book_decide_proposal(
    (SELECT id FROM public.price_book_proposals WHERE evidence_ref = current_setting('pb10.proposal')),
    'approved', 'pb10-approver');
  RAISE NOTICE 'OUTCOME APPROVED';
EXCEPTION WHEN others THEN
  IF SQLERRM LIKE 'price_book_proposal_stale%' THEN
    RAISE NOTICE 'OUTCOME STALE';
  ELSE
    RAISE;
  END IF;
END $$;
SELECT pg_sleep(:hold);
COMMIT;
