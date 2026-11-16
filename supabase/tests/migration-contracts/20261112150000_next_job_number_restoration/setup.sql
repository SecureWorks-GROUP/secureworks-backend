-- Prerequisites for 20261112150000_next_job_number_restoration.
-- next_job_number and job_number_counters are stood up by the earlier
-- registered cases (20260826000001_repair_job_type, 20261028031500); nothing
-- more is needed here.
CREATE TABLE IF NOT EXISTS public.job_number_counters (year smallint PRIMARY KEY, last_seq int NOT NULL);
