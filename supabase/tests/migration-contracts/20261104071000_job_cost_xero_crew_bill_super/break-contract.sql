-- Break: the cost view goes back to carrying no company super on a crew bill raised in Xero (this migration's down,
-- after the later credit rule's down). The contract must catch the missing super.
\ir ../../../rollbacks/20261104072000_job_cost_credit_at_note_ex_gst_down.sql
\ir ../../../rollbacks/20261104071000_job_cost_xero_crew_bill_super_down.sql
