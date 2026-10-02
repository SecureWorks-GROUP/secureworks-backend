-- Reopen the TRUNCATE hole the live read found (gate G-SITES-GRANTS): the
-- contract must catch it.
GRANT TRUNCATE ON TABLE public.job_contacts TO anon;
