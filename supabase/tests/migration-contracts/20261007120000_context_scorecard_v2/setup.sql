-- Prerequisites for 20261007120000_context_scorecard_v2: nothing new. Every
-- table and function the scorecard v2 reads is created by an earlier registered
-- case: W11's scorecard (20261006032000) it replaces, the lead rule
-- (20261007010000), the hourly run (20261007040000), the CRM history read and
-- the Xero top-up (20261007050000), the party roles read (20261007060000), the
-- placement grades (20261007070000), the email reach (20261007080000) and the
-- grades (20261007090000). This check fails early, and by name, if one is missing.
DO $$
DECLARE f text;
BEGIN
 FOREACH f IN ARRAY ARRAY['public.context_scorecard(timestamptz)', 'public.context_scorecard_jobs(uuid,integer,timestamptz)',
   'public.context_scorecard_policy()', 'public.context_lead_monitored_jobs(uuid[],timestamptz)',
   'public.context_scorecard_run_status(timestamptz)', 'public.context_history_crm_summary()', 'public.context_history_crm_jobs(uuid[])',
   'public.context_history_xero_daily_status()', 'public.context_party_roles_lanes(timestamptz,integer)',
   'public.context_placement_grades_newest(timestamptz,text)', 'public.context_placement_misfile_counts(timestamptz)',
   'public.context_email_history_reach(timestamptz)', 'public.context_email_history_reach_jobs(uuid[],timestamptz)',
   'public.context_item_kinds()', 'public.context_grades_newest(timestamptz)', 'public.context_ledger_evidence_rows(uuid[],timestamptz)'] LOOP
  IF to_regprocedure(f) IS NULL THEN RAISE EXCEPTION 'scorecard v2 setup: % is missing from the registered stack', f; END IF;
 END LOOP;
END $$;
