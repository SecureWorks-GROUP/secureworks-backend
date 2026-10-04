-- Ship the ladder without the two rules (L1b's bodies, as before this
-- migration): a crew assignment text is placed on the customer's job by its
-- job number. The contract must catch it.
\ir ../../../rollbacks/20261004200000_context_ladder_non_customer_text_down.sql
