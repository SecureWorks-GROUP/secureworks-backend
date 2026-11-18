BEGIN;
SET LOCAL statement_timeout = '120s';

-- Rule 17: restore prerequisites only if an earlier contract removed them, then
-- re-apply this migration twice to prove idempotency.
SELECT to_regclass('public.reconcile_items') IS NULL AS p4_01_6_needs_tables \gset
\if :p4_01_6_needs_tables
\ir ../20261118060051_reconcile_tables/main_lines_reader.sql
\ir ../../../migrations/20261118060051_reconcile_tables.sql
\endif
SELECT to_regprocedure('public.reconcile_item_org(text,text,uuid[])') IS NULL
   OR to_regprocedure('public.reconcile_item_withdraw(text,text,text,text)') IS NULL
   OR to_regprocedure('public.reconcile_item_raise(text,text,text,uuid[],jsonb,jsonb,text)') IS NULL
   AS p4_01_6_needs_raise \gset
\if :p4_01_6_needs_raise
\ir ../../../migrations/20261118073218_reconcile_item_raise.sql
\endif
\ir ../../../migrations/20261118124439_context_reconcile_raise.sql
SET LOCAL statement_timeout = '120s';

CREATE FUNCTION pg_temp.expect_failure(
  command text,
  expected text,
  forbid_detail text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql AS $expect$
DECLARE
  failed boolean := false;
  v_detail text;
/* block */ BEGIN
  BEGIN
    EXECUTE command;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
    IF position(expected IN SQLERRM) = 0 THEN
      RAISE;
    END IF;
    IF forbid_detail IS NOT NULL
       AND (position(forbid_detail IN coalesce(v_detail, '')) > 0
            OR position(forbid_detail IN coalesce(SQLERRM, '')) > 0) THEN
      RAISE EXCEPTION 'exception leaked forbidden text in message or detail';
    END IF;
    failed := true;
  END;
  IF NOT failed THEN
    RAISE EXCEPTION 'expected refusal: %', expected;
  END IF;
END $expect$;

-- (a) All four Phase 4 kinds are in reconcile_item_kinds with exact shape, and
-- running the migration body twice leaves the four rows unchanged.
DO $kinds_before$
DECLARE c int;
/* block */ BEGIN
  SELECT count(*) INTO c
  FROM public.reconcile_item_kinds k
  WHERE (k.kind, k.tab, k.words, k.card) IN (
    ('message_no_job', 'messages', 'Message on no job', 'generic'),
    ('open_item_check', 'other', 'Open item to check', 'generic'),
    ('agent_money_proposal', 'other', 'Money step proposed by an agent', 'generic'),
    ('ai_job_failed', 'other', 'An AI job failed', 'generic')
  );
  IF c <> 4 THEN
    RAISE EXCEPTION 'P4-01.6 expected 4 allow-list kinds before re-apply, got %', c;
  END IF;
END $kinds_before$;

\ir ../../../migrations/20261118124439_context_reconcile_raise.sql
SET LOCAL statement_timeout = '120s';

DO $kinds_after$
DECLARE c int;
/* block */ BEGIN
  SELECT count(*) INTO c
  FROM public.reconcile_item_kinds k
  WHERE k.kind IN ('message_no_job', 'open_item_check', 'agent_money_proposal', 'ai_job_failed');
  IF c <> 4 THEN
    RAISE EXCEPTION 'P4-01.6 re-applying migration must leave 4 Phase 4 kinds, got %', c;
  END IF;
  -- Add NO column to the four subject tables (director ruling 11:34).
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    WHERE a.attrelid IN (
      'public.business_events'::regclass,
      'public.context_ledger_items'::regclass,
      'public.agent_action_proposals'::regclass,
      'public.context_ai_calls'::regclass
    ) AND a.attname = 'org_id' AND NOT a.attisdropped
  ) THEN
    RAISE EXCEPTION 'P4-01.6 must not add org_id to the four Phase 4 tables';
  END IF;
END $kinds_after$;

-- Fixtures: org A (...00a1), org B (...00b1), ZZTEST jobs and subject rows.
-- Seeded under replica role so capture/job triggers do not rewrite fixture ids.
SET LOCAL session_replication_role = replica;
DO $seed_orgs$
/* block */ BEGIN
  IF to_regclass('public.organisations') IS NOT NULL THEN
    INSERT INTO public.organisations (id, name) VALUES
      ('00000000-0000-0000-0000-0000000000a1', 'ZZTEST Org A'),
      ('00000000-0000-0000-0000-0000000000b1', 'ZZTEST Org B')
    ON CONFLICT DO NOTHING;
  END IF;
END $seed_orgs$;

INSERT INTO public.jobs (id, org_id, job_number, type, status) VALUES
  ('41060000-0000-4000-8000-0000000000a1', '00000000-0000-0000-0000-0000000000a1', 'ZZTEST-4106-A1', 'fencing', 'accepted'),
  ('41060000-0000-4000-8000-0000000000a2', '00000000-0000-0000-0000-0000000000a1', 'ZZTEST-4106-A2', 'patio', 'accepted'),
  ('41060000-0000-4000-8000-0000000000b1', '00000000-0000-0000-0000-0000000000b1', 'ZZTEST-4106-B1', 'fencing', 'accepted');

INSERT INTO public.context_ledger_generations (id, job_id, kind, status, reader, promoted_at) VALUES
  ('41060000-0000-4000-8000-0000000001a1', '41060000-0000-4000-8000-0000000000a1', 'rebuild', 'live', 'zztest', now()),
  ('41060000-0000-4000-8000-0000000001b1', '41060000-0000-4000-8000-0000000000b1', 'rebuild', 'live', 'zztest', now());

INSERT INTO public.context_ledger_items (
  id, generation_id, job_id, item_key, item_type, status, from_role, what,
  opened_at, opened_by, closes_on, written_by
) VALUES
  ('41060000-0000-4000-8000-0000000002a1', '41060000-0000-4000-8000-0000000001a1',
   '41060000-0000-4000-8000-0000000000a1', 'request:zztest:a1', 'request', 'open', 'customer',
   'Quote requested.', '2026-11-10T09:00:00+08',
   '[{"table":"job_events","id":"41060000-0000-4000-8000-000000000901","excerpt":"Quote requested."}]'::jsonb,
   'quote_sent', 'model:zztest'),
  ('41060000-0000-4000-8000-0000000002b1', '41060000-0000-4000-8000-0000000001b1',
   '41060000-0000-4000-8000-0000000000b1', 'request:zztest:b1', 'request', 'open', 'customer',
   'Quote requested.', '2026-11-10T09:00:00+08',
   '[{"table":"job_events","id":"41060000-0000-4000-8000-000000000902","excerpt":"Quote requested."}]'::jsonb,
   'quote_sent', 'model:zztest');

INSERT INTO public.agent_action_proposals (
  id, actor, auth_mode, action, params, params_sha256, job_id, kind, summary, status
) VALUES
  ('41060000-0000-4000-8000-0000000003a1', 'agent:zztest', 'service', 'create_deposit_invoice',
   '{}'::jsonb, repeat('a', 64), '41060000-0000-4000-8000-0000000000a1', 'customer_invoice',
   'Draft customer invoice.', 'pending'),
  ('41060000-0000-4000-8000-000000000300', 'agent:zztest', 'service', 'xero_approve',
   '{}'::jsonb, repeat('b', 64), NULL, 'xero_approve',
   'Approve bill with no job.', 'pending'),
  ('41060000-0000-4000-8000-00000003dead', 'agent:zztest', 'service', 'create_deposit_invoice',
   '{}'::jsonb, repeat('c', 64), '41060000-0000-4000-8000-00000000dead', 'customer_invoice',
   'Proposal pointing at missing job.', 'pending');

INSERT INTO public.business_events (
  id, event_type, source, entity_type, entity_id, job_id, candidate_job_ids
) VALUES
  ('41060000-0000-4000-8000-0000000004a1', 'client.sms_in', 'zztest', 'message', 'zz-m1',
   NULL, ARRAY['41060000-0000-4000-8000-0000000000a1', '41060000-0000-4000-8000-0000000000a2']::uuid[]),
  ('41060000-0000-4000-8000-000000000400', 'client.sms_in', 'zztest', 'message', 'zz-m2',
   NULL, NULL),
  ('41060000-0000-4000-8000-0000000004ab', 'client.sms_in', 'zztest', 'message', 'zz-m3',
   NULL, ARRAY['41060000-0000-4000-8000-0000000000a1', '41060000-0000-4000-8000-0000000000b1']::uuid[]),
  ('41060000-0000-4000-8000-0000000004de', 'client.sms_in', 'zztest', 'message', 'zz-m4',
   NULL, ARRAY['41060000-0000-4000-8000-0000000000a1', '41060000-0000-4000-8000-00000000dead']::uuid[]);
SET LOCAL session_replication_role = origin;

-- Stand-in contract assertions (ticket cases b through g against the explicit
-- 7-argument raise stand-in and 4-argument withdraw stand-in, inside a savepoint
-- so the real list functions remain intact for the end-to-end assertions below).
SAVEPOINT standin_cases;
DROP FUNCTION public.reconcile_item_raise(text,text,text,uuid[],jsonb,jsonb,text,uuid);
CREATE TEMP TABLE zztest_standin_raises (
  kind text,
  subject_table text,
  subject_id text,
  job_ids uuid[],
  suggestion jsonb,
  evidence jsonb,
  raised_by text
);
CREATE TEMP TABLE zztest_standin_withdraws (
  kind text,
  subject_table text,
  subject_id text,
  reason text
);
CREATE OR REPLACE FUNCTION public.reconcile_item_raise(
  text, text, text, uuid[], jsonb, jsonb, text)
RETURNS uuid LANGUAGE plpgsql AS $s$
/* block */ BEGIN
  INSERT INTO pg_temp.zztest_standin_raises VALUES ($1, $2, $3, $4, $5, $6, $7);
  RETURN '41060000-0000-4000-8000-00000000f1ed'::uuid;
END $s$;
CREATE OR REPLACE FUNCTION public.reconcile_item_withdraw(
  p_kind text, p_subject_table text, p_subject_id text, p_reason text)
RETURNS boolean LANGUAGE plpgsql AS $s$
/* block */ BEGIN
  INSERT INTO pg_temp.zztest_standin_withdraws VALUES (p_kind, p_subject_table, p_subject_id, p_reason);
  RETURN true;
END $s$;

-- (b) Unknown kind raises context_reconcile_raise_bad_kind.
SELECT pg_temp.expect_failure(
  $q$SELECT public.context_reconcile_raise('bill', NULL, 'zz-1', 'Plain sentence.')$q$,
  'context_reconcile_raise_bad_kind'
);
SELECT pg_temp.expect_failure(
  $q$SELECT public.context_reconcile_withdraw('bill', 'zz-1', 'settled')$q$,
  'context_reconcile_raise_bad_kind'
);

-- (c) Summary holding "$100" raises context_reconcile_raise_money and leaks no
-- amount or summary text into exception detail (Rule 21c).
SELECT pg_temp.expect_failure(
  $q$SELECT public.context_reconcile_raise('open_item_check', '41060000-0000-4000-8000-0000000000a1',
     '41060000-0000-4000-8000-0000000002a1', 'Customer owes $100 on the gate.')$q$,
  'context_reconcile_raise_money',
  '$100'
);
SELECT pg_temp.expect_failure(
  $q$SELECT public.context_reconcile_raise('open_item_check', '41060000-0000-4000-8000-0000000000a1',
     '41060000-0000-4000-8000-0000000002a1', 'Amount $ 5 mentioned.')$q$,
  'context_reconcile_raise_money',
  '$ 5'
);

-- (d) open_item_check with a job and two records passes the exact envelope.
DO $case_d$
DECLARE
  v_ret uuid;
  r pg_temp.zztest_standin_raises%ROWTYPE;
  v_recs jsonb := '[{"table":"job_documents","id":"q-1","label":"Quote 1 was sent on Thu 5 Nov."},{"table":"job_documents","id":"q-2","label":"Quote 2 was sent on Fri 6 Nov."}]'::jsonb;
/* block */ BEGIN
  v_ret := public.context_reconcile_raise(
    'open_item_check',
    '41060000-0000-4000-8000-0000000000a1',
    '41060000-0000-4000-8000-0000000002a1',
    'An open note may already be settled: more than one record fits.',
    v_recs
  );
  IF v_ret <> '41060000-0000-4000-8000-00000000f1ed'::uuid THEN
    RAISE EXCEPTION 'P4-01.6 (d) expected fixed stand-in uuid, got %', v_ret;
  END IF;
  SELECT * INTO r FROM pg_temp.zztest_standin_raises;
  IF r.kind <> 'open_item_check'
     OR r.subject_table <> 'context_ledger_items'
     OR r.subject_id <> '41060000-0000-4000-8000-0000000002a1'
     OR r.job_ids <> ARRAY['41060000-0000-4000-8000-0000000000a1']::uuid[]
     OR jsonb_array_length(r.suggestion -> 'candidates') <> 2
     OR r.evidence ->> 'reason' <> 'more_than_one_record'
     OR r.evidence #>> '{summary,text}' <> 'An open note may already be settled: more than one record fits.'
     OR r.evidence #>> '{summary,job_number}' <> 'ZZTEST-4106-A1'
     OR r.evidence #> '{summary,records}' <> v_recs
     OR r.raised_by <> 'phase4:context' THEN
    RAISE EXCEPTION 'P4-01.6 (d) unexpected stand-in row: %', row_to_json(r);
  END IF;
END $case_d$;

-- (e) message_no_job with null job and no records: empty array, null suggestion,
-- evidence still has default reason ai_none_of_these.
TRUNCATE pg_temp.zztest_standin_raises;
DO $case_e$
DECLARE
  r pg_temp.zztest_standin_raises%ROWTYPE;
/* block */ BEGIN
  PERFORM public.context_reconcile_raise(
    'message_no_job',
    NULL,
    '41060000-0000-4000-8000-000000000400',
    'The AI says this message belongs to none of the listed jobs.'
  );
  SELECT * INTO r FROM pg_temp.zztest_standin_raises;
  IF r.kind <> 'message_no_job'
     OR r.subject_table <> 'business_events'
     OR r.job_ids <> '{}'::uuid[]
     OR r.suggestion IS NOT NULL
     OR r.evidence ->> 'reason' <> 'ai_none_of_these'
     OR (r.evidence #> '{summary,job_number}') <> 'null'::jsonb
     OR (r.evidence #> '{summary,records}') <> '[]'::jsonb
     OR r.raised_by <> 'phase4:context' THEN
    RAISE EXCEPTION 'P4-01.6 (e) unexpected stand-in row: %', row_to_json(r);
  END IF;
END $case_e$;

-- (f) With the stand-in raise function dropped, context_reconcile_raise returns
-- NULL and raises no error.
DROP FUNCTION public.reconcile_item_raise(text,text,text,uuid[],jsonb,jsonb,text);
DO $case_f$
/* block */ BEGIN
  IF public.context_reconcile_raise(
    'open_item_check',
    '41060000-0000-4000-8000-0000000000a1',
    '41060000-0000-4000-8000-0000000002a1',
    'An open note may already be settled.'
  ) IS NOT NULL THEN
    RAISE EXCEPTION 'P4-01.6 (f) expected NULL when reconcile_item_raise is absent';
  END IF;
END $case_f$;

-- (g) Withdraw passes kind, subject_table, subject, reason in order, and returns
-- false when no withdraw function exists.
DO $case_g$
DECLARE
  w pg_temp.zztest_standin_withdraws%ROWTYPE;
/* block */ BEGIN
  IF NOT public.context_reconcile_withdraw(
    'agent_money_proposal',
    '41060000-0000-4000-8000-0000000003a1',
    'proposal_declined'
  ) THEN
    RAISE EXCEPTION 'P4-01.6 (g) expected true from stand-in withdraw';
  END IF;
  SELECT * INTO w FROM pg_temp.zztest_standin_withdraws;
  IF (w.kind, w.subject_table, w.subject_id, w.reason) IS DISTINCT FROM
     ('agent_money_proposal', 'agent_action_proposals', '41060000-0000-4000-8000-0000000003a1', 'proposal_declined') THEN
    RAISE EXCEPTION 'P4-01.6 (g) unexpected withdraw arguments: %', row_to_json(w);
  END IF;
END $case_g$;

DROP FUNCTION public.reconcile_item_withdraw(text,text,text,text);
DO $case_g_absent$
/* block */ BEGIN
  IF public.context_reconcile_withdraw(
    'agent_money_proposal',
    '41060000-0000-4000-8000-0000000003a1',
    'proposal_declined'
  ) THEN
    RAISE EXCEPTION 'P4-01.6 (g) expected false when reconcile_item_withdraw is absent';
  END IF;
END $case_g_absent$;
ROLLBACK TO standin_cases;

-- End-to-end assertions against the real Phase 2 Reconcile list (P2-03.1/P2-03.2)
-- and Director ruling 11:34.
DO $real_list$
DECLARE
  v_ai_call_id bigint;
  v_ai_nojob_id bigint;
  v_open_id uuid;
  v_prop_id uuid;
  v_ai_item_id uuid;
  v_msg_id uuid;
  v_item public.reconcile_items%ROWTYPE;
  v_hash text;
/* block */ BEGIN
  INSERT INTO public.context_ai_calls (
    ai_job, spec_id, spec_version, engine, model, job_id, outcome, duration_ms
  ) VALUES
    ('read-notes', 'read-notes', 1, 'codex', 'zztest', '41060000-0000-4000-8000-0000000000a1', 'failed', 120)
  RETURNING id INTO v_ai_call_id;

  INSERT INTO public.context_ai_calls (
    ai_job, spec_id, spec_version, engine, model, job_id, outcome, duration_ms
  ) VALUES
    ('place-message', 'place-message', 1, 'codex', 'zztest', NULL, 'failed', 80)
  RETURNING id INTO v_ai_nojob_id;

  -- 1. open_item_check on ZZTEST job lands on reconcile_items with subject's job org.
  v_open_id := public.context_reconcile_raise(
    'open_item_check',
    '41060000-0000-4000-8000-0000000000a1',
    '41060000-0000-4000-8000-0000000002a1',
    'An open note may already be settled: more than one record fits.',
    '[{"table":"job_documents","id":"q-1","label":"Quote 1 was sent on Thu 5 Nov."}]'::jsonb
  );
  SELECT * INTO v_item FROM public.reconcile_items WHERE id = v_open_id;
  IF v_open_id IS NULL
     OR v_item.org_id <> '00000000-0000-0000-0000-0000000000a1'
     OR v_item.kind <> 'open_item_check'
     OR v_item.subject_table <> 'context_ledger_items'
     OR v_item.job_ids <> ARRAY['41060000-0000-4000-8000-0000000000a1']::uuid[]
     OR v_item.reason <> 'more_than_one_record'
     OR v_item.summary ->> 'job_number' <> 'ZZTEST-4106-A1'
     OR v_item.raised_by <> 'phase4:context'
     OR v_item.status <> 'open' THEN
    RAISE EXCEPTION 'P4-01.6 open_item_check must land on reconcile_items: %', row_to_json(v_item);
  END IF;

  -- 2. agent_money_proposal with a job lands on reconcile_items.
  v_prop_id := public.context_reconcile_raise(
    'agent_money_proposal',
    '41060000-0000-4000-8000-0000000000a1',
    '41060000-0000-4000-8000-0000000003a1',
    'An agent asked for a money action.',
    '[{"kind":"customer_invoice","action":"create_deposit_invoice"}]'::jsonb
  );
  IF (SELECT org_id = '00000000-0000-0000-0000-0000000000a1' AND reason = 'waiting_for_press'
      FROM public.reconcile_items WHERE id = v_prop_id) IS NOT TRUE THEN
    RAISE EXCEPTION 'P4-01.6 agent_money_proposal must land with waiting_for_press';
  END IF;

  -- 3. ai_job_failed with bigint id and a job lands on reconcile_items.
  v_ai_item_id := public.context_reconcile_raise(
    'ai_job_failed',
    '41060000-0000-4000-8000-0000000000a1',
    v_ai_call_id::text,
    'An AI read failed for this job.',
    'null'::jsonb,
    'custom_ai_reason'
  );
  IF (SELECT org_id = '00000000-0000-0000-0000-0000000000a1'
         AND reason = 'custom_ai_reason'
         AND suggestion IS NULL
      FROM public.reconcile_items WHERE id = v_ai_item_id) IS NOT TRUE THEN
    RAISE EXCEPTION 'P4-01.6 ai_job_failed must land with custom reason and null suggestion';
  END IF;

  -- 4. message_no_job with NULL p_job_id and single-org candidate_job_ids on
  -- business_events resolves that organisation and lands with empty job_ids.
  v_msg_id := public.context_reconcile_raise(
    'message_no_job',
    NULL,
    '41060000-0000-4000-8000-0000000004a1',
    'The AI says this message belongs to none of the listed jobs.'
  );
  IF (SELECT org_id = '00000000-0000-0000-0000-0000000000a1'
         AND job_ids = '{}'::uuid[]
         AND reason = 'ai_none_of_these'
      FROM public.reconcile_items WHERE id = v_msg_id) IS NOT TRUE THEN
    RAISE EXCEPTION 'P4-01.6 message_no_job with single-org candidates must land';
  END IF;

  -- 5. Withdraw through context_reconcile_withdraw closes the open item once.
  IF NOT public.context_reconcile_withdraw(
    'agent_money_proposal',
    '41060000-0000-4000-8000-0000000003a1',
    'proposal_declined'
  ) THEN
    RAISE EXCEPTION 'P4-01.6 real withdraw must close open item';
  END IF;
  IF public.context_reconcile_withdraw(
    'agent_money_proposal',
    '41060000-0000-4000-8000-0000000003a1',
    'proposal_declined'
  ) THEN
    RAISE EXCEPTION 'P4-01.6 second real withdraw must return false';
  END IF;

  -- 6. Office person decision on the same evidence keeps re-raises off; changed
  -- evidence opens a new item.
  SELECT evidence_hash INTO v_hash FROM public.reconcile_items WHERE id = v_open_id;
  UPDATE public.reconcile_items SET status = 'decided', closed_at = now() WHERE id = v_open_id;
  INSERT INTO public.reconcile_decisions (org_id, item_id, subject_kind, subject_id, action, shown_hash, "by")
  VALUES (
    '00000000-0000-0000-0000-0000000000a1',
    v_open_id,
    'context_ledger_items',
    '41060000-0000-4000-8000-0000000002a1',
    'resolve',
    v_hash,
    'person:00000000-0000-4000-8000-000000000001'
  );
  IF public.context_reconcile_raise(
    'open_item_check',
    '41060000-0000-4000-8000-0000000000a1',
    '41060000-0000-4000-8000-0000000002a1',
    'An open note may already be settled: more than one record fits.',
    '[{"table":"job_documents","id":"q-1","label":"Quote 1 was sent on Thu 5 Nov."}]'::jsonb
  ) IS NOT NULL THEN
    RAISE EXCEPTION 'P4-01.6 office decision on same evidence must not reopen item';
  END IF;

  -- 7. Plain refusals when there is no job (no ZZTEST fallback rule), missing
  -- subject, missing job, or cross-org conflict; nothing is written on refusal.
  PERFORM pg_temp.expect_failure(
    format($f$SELECT public.context_reconcile_raise('ai_job_failed', NULL, %L, 'AI read failed.')$f$, v_ai_nojob_id::text),
    'reconcile_org_unknown'
  );
END $real_list$;

CREATE TEMP TABLE p4_01_6_before_refusals AS
  SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.id), '[]'::jsonb) AS list
  FROM public.reconcile_items i;

-- No job on subject, missing subject, malformed subject, null job org, missing
-- job, cross-org p_job_id, cross-org candidate_job_ids, blank summary, bad
-- suggestions, and existing 7-arg caller parity.
SELECT pg_temp.expect_failure(cmd, expected)
FROM (VALUES
  -- Subject has no job (no ZZTEST fallback rule), with or without p_job_id.
  ($q$SELECT public.context_reconcile_raise('message_no_job', NULL, '41060000-0000-4000-8000-000000000400', 'Message on no job.')$q$, 'reconcile_org_unknown'),
  ($q$SELECT public.context_reconcile_raise('message_no_job', '41060000-0000-4000-8000-0000000000a1', '41060000-0000-4000-8000-000000000400', 'Message on no job.')$q$, 'reconcile_org_unknown'),
  ($q$SELECT public.context_reconcile_raise('agent_money_proposal', NULL, '41060000-0000-4000-8000-000000000300', 'Proposal on no job.')$q$, 'reconcile_org_unknown'),
  ($q$SELECT public.context_reconcile_raise('agent_money_proposal', '41060000-0000-4000-8000-0000000000a1', '41060000-0000-4000-8000-000000000300', 'Proposal on no job.')$q$, 'reconcile_org_unknown'),
  -- Missing or malformed subject row, even when p_job_id is a valid job.
  ($q$SELECT public.context_reconcile_raise('open_item_check', '41060000-0000-4000-8000-0000000000a1', '41060000-0000-4000-8000-00000000beef', 'Missing note.')$q$, 'reconcile_org_unknown'),
  ($q$SELECT public.context_reconcile_raise('open_item_check', '41060000-0000-4000-8000-0000000000a1', 'not-a-uuid', 'Malformed note id.')$q$, 'reconcile_org_unknown'),
  ($q$SELECT public.context_reconcile_raise('ai_job_failed', '41060000-0000-4000-8000-0000000000a1', 'not-a-bigint', 'Malformed call id.')$q$, 'reconcile_org_unknown'),
  -- Missing job on subject or in p_job_id or in candidate_job_ids.
  ($q$SELECT public.context_reconcile_raise('agent_money_proposal', NULL, '41060000-0000-4000-8000-00000003dead', 'Dangling subject job.')$q$, 'reconcile_job_unknown'),
  ($q$SELECT public.context_reconcile_raise('open_item_check', '41060000-0000-4000-8000-00000000dead', '41060000-0000-4000-8000-0000000002a1', 'Missing passed job.')$q$, 'reconcile_job_unknown'),
  ($q$SELECT public.context_reconcile_raise('message_no_job', NULL, '41060000-0000-4000-8000-0000000004de', 'Missing candidate job.')$q$, 'reconcile_job_unknown'),
  -- Cross-org conflict between subject's job and p_job_id, or across candidate_job_ids.
  ($q$SELECT public.context_reconcile_raise('open_item_check', '41060000-0000-4000-8000-0000000000a1', '41060000-0000-4000-8000-0000000002b1', 'Wrong org job passed.')$q$, 'reconcile_org_ambiguous'),
  ($q$SELECT public.context_reconcile_raise('message_no_job', NULL, '41060000-0000-4000-8000-0000000004ab', 'Two org candidates.')$q$, 'reconcile_org_ambiguous'),
  -- Summary and suggestions validation.
  ($q$SELECT public.context_reconcile_raise('open_item_check', '41060000-0000-4000-8000-0000000000a1', '41060000-0000-4000-8000-0000000002a1', '   ')$q$, 'context_reconcile_raise_summary_required'),
  ($q$SELECT public.context_reconcile_raise('open_item_check', '41060000-0000-4000-8000-0000000000a1', '41060000-0000-4000-8000-0000000002a1', 'Valid sentence.', '{"not":"an array"}'::jsonb)$q$, 'context_reconcile_raise_suggestions_invalid'),
  -- Existing 7-argument reconcile_item_raise caller stays unchanged (no implicit org).
  ($q$SELECT public.reconcile_item_raise('open_item_check', 'context_ledger_items', '41060000-0000-4000-8000-0000000002a1', ARRAY['41060000-0000-4000-8000-0000000000a1']::uuid[], NULL, '{"reason":"zz"}'::jsonb, 'phase4:context')$q$, 'reconcile_org_unknown'),
  -- Explicit 8th argument: must equal given job's org, and nonexistent tables still refuse.
  ($q$SELECT public.reconcile_item_raise('open_item_check', 'context_ledger_items', '41060000-0000-4000-8000-0000000002a1', ARRAY['41060000-0000-4000-8000-0000000000a1']::uuid[], NULL, '{"reason":"zz"}'::jsonb, 'phase4:context', '00000000-0000-0000-0000-0000000000b1'::uuid)$q$, 'reconcile_org_ambiguous'),
  ($q$SELECT public.reconcile_item_raise('open_item_check', 'zztest_no_such_table', '1', NULL, NULL, '{"reason":"zz"}'::jsonb, 'phase4:context', '00000000-0000-0000-0000-0000000000a1'::uuid)$q$, 'reconcile_org_unknown')
) AS t(cmd, expected);

-- Explicit 8th argument is ignored when reconcile_item_org CAN resolve an org
-- (used ONLY when reconcile_item_org cannot resolve one).
DO $explicit_org_precedence$
DECLARE v_id uuid;
/* block */ BEGIN
  IF (SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.id), '[]'::jsonb) FROM public.reconcile_items i)
     IS DISTINCT FROM (SELECT list FROM p4_01_6_before_refusals) THEN
    RAISE EXCEPTION 'P4-01.6 refused raises must leave reconcile_items unchanged';
  END IF;

  -- Retry of a refusal on an open item leaves that open item byte-identical.
  PERFORM pg_temp.expect_failure(
    $q$SELECT public.context_reconcile_raise('message_no_job', '41060000-0000-4000-8000-0000000000b1',
       '41060000-0000-4000-8000-0000000004a1', 'Retry with wrong org job.')$q$,
    'reconcile_org_ambiguous'
  );
  IF (SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.id), '[]'::jsonb) FROM public.reconcile_items i)
     IS DISTINCT FROM (SELECT list FROM p4_01_6_before_refusals) THEN
    RAISE EXCEPTION 'P4-01.6 refused retry on open item must leave it unchanged';
  END IF;

  v_id := public.reconcile_item_raise(
    'open_item_check',
    'jobs',
    '41060000-0000-4000-8000-0000000000b1',
    NULL,
    NULL,
    '{"reason":"zz_jobs_org"}'::jsonb,
    'migration',
    '00000000-0000-0000-0000-0000000000a1'::uuid
  );
  IF (SELECT org_id FROM public.reconcile_items WHERE id = v_id)
     IS DISTINCT FROM '00000000-0000-0000-0000-0000000000b1' THEN
    RAISE EXCEPTION 'P4-01.6 explicit org must not override reconcile_item_org when subject resolves';
  END IF;
END $explicit_org_precedence$;

-- Grants: service_role only for all four functions.
DO $grants$
/* block */ BEGIN
  IF has_function_privilege('anon', 'public.context_reconcile_raise(text,uuid,text,text,jsonb,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.context_reconcile_raise(text,uuid,text,text,jsonb,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.context_reconcile_withdraw(text,text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.context_reconcile_withdraw(text,text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.reconcile_item_raise(text,text,text,uuid[],jsonb,jsonb,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.reconcile_item_raise(text,text,text,uuid[],jsonb,jsonb,text,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.context_reconcile_raise(text,uuid,text,text,jsonb,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.context_reconcile_withdraw(text,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.reconcile_item_raise(text,text,text,uuid[],jsonb,jsonb,text,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'P4-01.6 functions must be executable by service_role only';
  END IF;
END $grants$;

-- Rule 16: every subject-table and job lookup added by context_reconcile_raise
-- is index-bound on populated tables (no Seq Scan, <= 2 rows read).
SAVEPOINT plan_fixture;
SET LOCAL session_replication_role = replica;
INSERT INTO public.business_events (id, event_type, source, entity_type, entity_id, job_id)
SELECT ('41061000-0000-4000-8000-' || lpad(to_hex(g), 12, '0'))::uuid,
       'client.sms_in', 'zztest', 'message', 'zz-plan-' || g,
       '41060000-0000-4000-8000-0000000000a1'::uuid
FROM generate_series(1, 4000) g;

INSERT INTO public.context_ledger_items (
  id, generation_id, job_id, item_key, item_type, status, from_role, what,
  opened_at, opened_by, closes_on, written_by
)
SELECT ('41062000-0000-4000-8000-' || lpad(to_hex(g), 12, '0'))::uuid,
       '41060000-0000-4000-8000-0000000001a1'::uuid,
       '41060000-0000-4000-8000-0000000000a1'::uuid,
       'request:plan:' || g, 'request', 'open', 'customer', 'Plan fixture.',
       '2026-11-10T09:00:00+08',
       '[{"table":"job_events","id":"41060000-0000-4000-8000-000000000909","excerpt":"Plan fixture."}]'::jsonb,
       'quote_sent', 'model:zztest'
FROM generate_series(1, 4000) g;

INSERT INTO public.agent_action_proposals (
  id, actor, auth_mode, action, params, params_sha256, job_id, kind, summary, status
)
SELECT ('41063000-0000-4000-8000-' || lpad(to_hex(g), 12, '0'))::uuid,
       'agent:zztest', 'service', 'create_deposit_invoice', '{}'::jsonb,
       lpad(to_hex(g), 64, '0'), '41060000-0000-4000-8000-0000000000a1'::uuid,
       'customer_invoice', 'Plan fixture.', 'observed'
FROM generate_series(1, 4000) g;

INSERT INTO public.context_ai_calls (
  ai_job, spec_id, spec_version, engine, model, job_id, outcome, duration_ms
)
SELECT 'read-notes', 'read-notes', 1, 'codex', 'zztest',
       '41060000-0000-4000-8000-0000000000a1'::uuid, 'answered', 50
FROM generate_series(1, 4000) g;
SET LOCAL session_replication_role = origin;

ANALYZE public.business_events, public.context_ledger_items,
        public.agent_action_proposals, public.context_ai_calls;

DO $plan$
DECLARE
  plan jsonb;
  q text;
  rel text;
  v_sample_ai_id bigint;
/* block */ BEGIN
  SELECT max(id) INTO v_sample_ai_id FROM public.context_ai_calls;
  FOR rel, q IN VALUES
    ('business_events',
     $q$SELECT t.job_id, t.candidate_job_ids FROM public.business_events t
        WHERE t.id = '41061000-0000-4000-8000-000000000010'::uuid$q$),
    ('context_ledger_items',
     $q$SELECT t.job_id FROM public.context_ledger_items t
        WHERE t.id = '41062000-0000-4000-8000-000000000010'::uuid$q$),
    ('agent_action_proposals',
     $q$SELECT t.job_id FROM public.agent_action_proposals t
        WHERE t.id = '41063000-0000-4000-8000-000000000010'::uuid$q$),
    ('context_ai_calls',
     format($q$SELECT t.job_id FROM public.context_ai_calls t WHERE t.id = %s::bigint$q$, v_sample_ai_id))
  LOOP
    EXECUTE 'EXPLAIN (ANALYZE, FORMAT JSON) ' || q INTO plan;
    IF EXISTS (
      SELECT 1 FROM jsonb_path_query(plan, 'strict $.**') node
      WHERE node ->> 'Relation Name' = rel AND node ->> 'Node Type' = 'Seq Scan'
    )
    OR NOT EXISTS (
      SELECT 1 FROM jsonb_path_query(plan, 'strict $.**') node
      WHERE node ->> 'Relation Name' = rel
        AND node ->> 'Node Type' IN ('Index Scan', 'Index Only Scan', 'Bitmap Heap Scan')
    )
    OR EXISTS (
      SELECT 1 FROM jsonb_path_query(plan, 'strict $.**') node
      WHERE node ->> 'Relation Name' = rel
        AND coalesce((node ->> 'Actual Rows')::numeric, 0)
            + coalesce((node ->> 'Rows Removed by Filter')::numeric, 0) > 2
    ) THEN
      RAISE EXCEPTION 'P4-01.6 % read must be bounded and indexed: %', rel, plan;
    END IF;
  END LOOP;

  SET LOCAL enable_seqscan = off;
  EXECUTE $q$EXPLAIN (FORMAT JSON)
    SELECT j.org_id, j.job_number FROM public.jobs j
    WHERE j.id = '41060000-0000-4000-8000-0000000000a1'::uuid$q$ INTO plan;
  IF EXISTS (
    SELECT 1 FROM jsonb_path_query(plan, 'strict $.**') node
    WHERE node ->> 'Relation Name' = 'jobs' AND node ->> 'Node Type' = 'Seq Scan'
  ) THEN
    RAISE EXCEPTION 'P4-01.6 jobs read must be served by an index: %', plan;
  END IF;
  RESET enable_seqscan;
END $plan$;
ROLLBACK TO plan_fixture;

SELECT 'PASS P4-01.6: four kinds seeded idempotently, stand-in and live Reconcile list raise/withdraw, organisation from subject job only, jobless and mismatched subjects refused without writes, 7-arg callers unchanged, indexed reads';
ROLLBACK;
