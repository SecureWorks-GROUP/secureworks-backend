-- A v_job_cost_events that is not the A4 V8 definition: production's 20261103224500 one, before A4 V8, by that
-- migration's down. The migration must refuse rather than edit a definition it was not written against.
\ir ../../../rollbacks/20261104063000_job_cost_bill_line_job_number_down.sql
