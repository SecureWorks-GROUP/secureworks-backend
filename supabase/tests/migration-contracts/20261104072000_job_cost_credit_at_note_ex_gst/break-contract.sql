-- Break: the cost view goes back to recomputing a credit from the inc-GST totals (this migration's down). The contract
-- must catch the cent.
-- 20261104123000 (C3 one-job speed-up) sits on the A3 division definitions: unwind it first.
\ir ../../../rollbacks/20261104123000_job_cost_events_faster_same_rows_down.sql
\ir ../../../rollbacks/20261104091000_job_revenue_credit_division_down.sql
\ir ../../../rollbacks/20261104090000_job_cost_crew_and_placement_division_down.sql
\ir ../../../rollbacks/20261104072000_job_cost_credit_at_note_ex_gst_down.sql
