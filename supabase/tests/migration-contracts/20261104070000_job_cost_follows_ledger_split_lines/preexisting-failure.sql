-- A v_job_cost_events that is not production's 20261103224500 definition: the stack's own one, kept by setup.sql.
-- The migration must refuse rather than edit a definition it was not written against.
\ir restore-preimage.sql
