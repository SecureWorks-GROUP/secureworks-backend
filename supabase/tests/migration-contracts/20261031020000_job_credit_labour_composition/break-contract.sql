-- 20261104070000 to 20261104072000 (A6 cost rules) moved v_job_cost_events on to production's definition and then
-- their own: unwind them first, back to the stack's own definition.
SELECT md5(pg_get_viewdef('public.v_job_cost_events'::regclass, true))='25143b7d28aae47cd44a16323fa99389' AS test_has_a6_cost_rules \gset
\if :test_has_a6_cost_rules
\ir ../../../rollbacks/20261104072000_job_cost_credit_at_note_ex_gst_down.sql
\ir ../../../rollbacks/20261104071000_job_cost_xero_crew_bill_super_down.sql
\ir ../../../rollbacks/20261104070000_job_cost_follows_ledger_split_lines_down.sql
\ir ../20261104070000_job_cost_follows_ledger_split_lines/restore-preimage.sql
\endif
\ir ../../../rollbacks/20261031020000_job_credit_labour_composition_down.sql
