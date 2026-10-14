-- Deliberately put the earlier bodies back (this migration's own rollback: 20261007150000's packet
-- and 20261011120000's story read, the two helpers dropped). contract.sql must then fail on its
-- first check: the helpers are gone.
-- The later story-card read changes are reversed only inside this contract's transaction.
SELECT to_regprocedure('public.context_job_story_payment_terms(jsonb)') IS NOT NULL AS story_card_causes_live \gset
\if :story_card_causes_live
\ir ../../../rollbacks/20261014120000_context_story_card_causes_down.sql
\endif
\ir ../../../rollbacks/20261012100000_context_held_messages_down.sql
