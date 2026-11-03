-- Break: the cost view goes back to recomputing a credit from the inc-GST totals (this migration's down). The contract
-- must catch the cent.
\ir ../../../rollbacks/20261104091000_job_revenue_credit_division_down.sql
\ir ../../../rollbacks/20261104090000_job_cost_crew_and_placement_division_down.sql
\ir ../../../rollbacks/20261104072000_job_cost_credit_at_note_ex_gst_down.sql
