-- Remove the no-split refusal: hourly pay with no super record then reads as
-- 0 super and the inclusive group's pot is passed on a guess. The contract
-- must catch it.
\ir no_refusal_company_super.sql
