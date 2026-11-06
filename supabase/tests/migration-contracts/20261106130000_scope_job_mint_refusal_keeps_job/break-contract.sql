-- Put back the 20261106081500 bind body (the settlement refusal is returned
-- after the job write, so the write stays): the contract must then fail.
\ir ../../../migrations/20261106081500_scope_job_mint_reuse_open_job.sql
