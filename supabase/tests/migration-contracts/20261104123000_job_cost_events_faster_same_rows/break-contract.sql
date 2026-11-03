-- Break: the cost view and the allocations go back to scanning the crew list and the credit list per line (this
-- migration's down). The contract must catch it.
\ir ../../../rollbacks/20261104123000_job_cost_events_faster_same_rows_down.sql
