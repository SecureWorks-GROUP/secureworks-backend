-- Remove the promised behaviour: put the four earlier bodies back and drop the column, so the
-- contract's first check must fail where context_ledger_items.person_review should store a review.
\ir ../../../rollbacks/20261019120000_context_ledger_person_review_down.sql
