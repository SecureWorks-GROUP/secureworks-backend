-- Rule 17: restore objects only if an earlier contract dropped them, so break-contract.sql still takes effect.
SELECT to_regprocedure('public.context_ledger_closed_how_stamp(uuid)') IS NULL
  OR to_regprocedure('public.context_ledger_word_closes_mark(uuid,text[],text,text,text)') IS NULL
  OR to_regprocedure('public.context_ledger_closed_how_install()') IS NULL
  OR to_regclass('public.context_ledger_word_closes') IS NULL AS closed_how_needs_reapply \gset
\if :closed_how_needs_reapply
\ir ../../../rollbacks/20261118105244_context_ledger_closed_how_down.sql
\ir ../../../migrations/20261118105244_context_ledger_closed_how.sql
\endif

BEGIN;
SET LOCAL statement_timeout = '120s';

CREATE FUNCTION pg_temp.zztest_assert(p_ok boolean, p_msg text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_ok IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'ZZTEST closed_how: %', p_msg;
  END IF;
END $$;

-- 1. Merge safety: migration itself must not install a trigger on context_ledger_transitions.
SELECT pg_temp.zztest_assert(
  NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.context_ledger_transitions'::regclass
      AND tgname = 'context_ledger_transitions_closed_how'
      AND NOT tgisinternal
  ),
  'migration installed trigger on merge'
);

-- 2. RLS and role privileges: service_role only; browser roles denied.
SELECT pg_temp.zztest_assert(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.context_ledger_word_closes'::regclass)
  AND NOT has_table_privilege('anon', 'public.context_ledger_word_closes', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.context_ledger_word_closes', 'SELECT')
  AND has_table_privilege('service_role', 'public.context_ledger_word_closes', 'SELECT, INSERT, UPDATE, DELETE')
  AND NOT has_function_privilege('anon', 'public.context_ledger_word_closes_mark(uuid,text[],text,text,text)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.context_ledger_word_closes_mark(uuid,text[],text,text,text)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.context_ledger_closed_how_stamp(uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.context_ledger_closed_how_install()', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.context_ledger_word_closes_mark(uuid,text[],text,text,text)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.context_ledger_closed_how_stamp(uuid)', 'EXECUTE'),
  'permissions exposed to browser role or missing from service_role'
);

-- Seed ZZTEST jobs without firing unrelated business triggers.
SET LOCAL session_replication_role = replica;
INSERT INTO public.jobs (id, org_id, type, status, job_number, created_at)
SELECT
  ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  '00000000-0000-0000-0000-000000000001',
  'fencing',
  'accepted',
  'ZZTEST-' || n,
  '2026-10-01T00:00:00+08'
FROM generate_series(420, 428) AS n
ON CONFLICT (id) DO NOTHING;
SET LOCAL session_replication_role = origin;

-- Pre-install parity: transition writes before install leave closed_how untouched (NULL).
INSERT INTO public.context_ledger_generations (id, job_id, kind, status, reader, promoted_at)
VALUES
  ('00000000-0000-4000-8000-000000000420', '00000000-0000-4000-8000-000000000420', 'rebuild', 'live', 'luna-ledger:v8', '2026-11-01T10:00:00+08'),
  ('00000000-0000-4000-8000-000000001420', '00000000-0000-4000-8000-000000000420', 'backfill', 'retired', 'luna-ledger:v8', '2026-10-15T10:00:00+08');

INSERT INTO public.context_ledger_items (
  id, generation_id, job_id, item_key, item_type, status, from_role, what,
  opened_at, opened_by, closed_at, closed_by, written_by, person_locked, updated_at
) VALUES
  ('00000000-0000-4000-8000-000000010420', '00000000-0000-4000-8000-000000000420', '00000000-0000-4000-8000-000000000420',
   'item:backfill:record', 'request', 'closed', 'customer', 'Quote requested.',
   '2026-11-01T09:00:00+08', '[{"table":"job_events","id":"fixture-1"}]', '2026-11-02T09:00:00+08', '[{"table":"job_documents","id":"fixture-doc"}]', 'model:luna-ledger:v8', false, '2026-11-02T09:00:00+08'),
  ('00000000-0000-4000-8000-000000020420', '00000000-0000-4000-8000-000000000420', '00000000-0000-4000-8000-000000000420',
   'item:backfill:words', 'request', 'closed', 'customer', 'Question asked.',
   '2026-11-01T09:00:00+08', '[{"table":"business_events","id":"fixture-2"}]', '2026-11-02T10:00:00+08', '[{"table":"business_events","id":"fixture-3"}]', 'model:luna-ledger:v8', false, '2026-11-02T10:00:00+08'),
  ('00000000-0000-4000-8000-000000030420', '00000000-0000-4000-8000-000000000420', '00000000-0000-4000-8000-000000000420',
   'item:backfill:person_tr', 'issue', 'declined', 'customer', 'Declined request.',
   '2026-11-01T09:00:00+08', '[{"table":"business_events","id":"fixture-4"}]', '2026-11-02T11:00:00+08', '[{"table":"person","id":"fixture-user"}]', 'model:luna-ledger:v8', true, '2026-11-02T11:00:00+08'),
  ('00000000-0000-4000-8000-000000040420', '00000000-0000-4000-8000-000000000420', '00000000-0000-4000-8000-000000000420',
   'item:backfill:person_written', 'agreement', 'closed', 'us', 'Office recorded note.',
   '2026-11-01T09:00:00+08', '[{"table":"person","id":"fixture-user"}]', '2026-11-02T11:30:00+08', NULL, 'person:00000000-0000-4000-8000-000000000901', true, '2026-11-02T11:30:00+08'),
  ('00000000-0000-4000-8000-000000050420', '00000000-0000-4000-8000-000000000420', '00000000-0000-4000-8000-000000000420',
   'item:backfill:other_rule', 'request', 'closed', 'us', 'Other rule closed.',
   '2026-11-01T09:00:00+08', '[{"table":"job_events","id":"fixture-5"}]', '2026-11-02T12:00:00+08', '[{"table":"job_events","id":"fixture-6"}]', 'rule:other_import', false, '2026-11-02T12:00:00+08'),
  ('00000000-0000-4000-8000-000000060420', '00000000-0000-4000-8000-000000000420', '00000000-0000-4000-8000-000000000420',
   'item:backfill:open', 'request', 'open', 'customer', 'Still open.',
   '2026-11-01T09:00:00+08', '[{"table":"business_events","id":"fixture-7"}]', NULL, NULL, 'model:luna-ledger:v8', false, '2026-11-01T09:00:00+08'),
  ('00000000-0000-4000-8000-000000070420', '00000000-0000-4000-8000-000000001420', '00000000-0000-4000-8000-000000000420',
   'item:retired:words', 'request', 'closed', 'customer', 'Retired item.',
   '2026-10-15T09:00:00+08', '[{"table":"business_events","id":"fixture-8"}]', '2026-10-15T10:00:00+08', '[{"table":"business_events","id":"fixture-9"}]', 'model:luna-ledger:v8', false, '2026-10-15T10:00:00+08');

INSERT INTO public.context_ledger_transitions (item_id, generation_id, job_id, from_status, to_status, at, by, evidence, reason)
VALUES
  ('00000000-0000-4000-8000-000000010420', '00000000-0000-4000-8000-000000000420', '00000000-0000-4000-8000-000000000420', 'open', 'closed', '2026-11-02T09:00:00+08', 'rule:record_close_v1', '[{"table":"job_documents","id":"fixture-doc"}]', 'Quote sent.'),
  ('00000000-0000-4000-8000-000000020420', '00000000-0000-4000-8000-000000000420', '00000000-0000-4000-8000-000000000420', 'open', 'closed', '2026-11-02T10:00:00+08', 'model:luna-ledger:v8', '[{"table":"business_events","id":"fixture-3"}]', 'Answered.'),
  ('00000000-0000-4000-8000-000000030420', '00000000-0000-4000-8000-000000000420', '00000000-0000-4000-8000-000000000420', 'open', 'declined', '2026-11-02T11:00:00+08', 'person:00000000-0000-4000-8000-000000000901', '[{"table":"person","id":"fixture-user"}]', 'Declined by staff.'),
  ('00000000-0000-4000-8000-000000050420', '00000000-0000-4000-8000-000000000420', '00000000-0000-4000-8000-000000000420', 'open', 'closed', '2026-11-02T12:00:00+08', 'rule:other_import', '[{"table":"job_events","id":"fixture-6"}]', 'Imported.'),
  ('00000000-0000-4000-8000-000000070420', '00000000-0000-4000-8000-000000001420', '00000000-0000-4000-8000-000000000420', 'open', 'closed', '2026-10-15T10:00:00+08', 'model:luna-ledger:v8', '[{"table":"business_events","id":"fixture-9"}]', 'Retired close.');

SELECT pg_temp.zztest_assert(
  NOT EXISTS (
    SELECT 1 FROM public.context_ledger_items
    WHERE job_id = '00000000-0000-4000-8000-000000000420' AND closed_how IS NOT NULL
  ),
  'pre-install transition wrote closed_how'
);

-- 3. Install and set-based backfill (Step 7) + idempotency.
DO $backfill_proof$
DECLARE
  v_first integer;
  v_second integer;
BEGIN
  v_first := public.context_ledger_closed_how_install();
  v_second := public.context_ledger_closed_how_install();
  PERFORM pg_temp.zztest_assert(v_first >= 4, 'backfill expected at least 4 live items updated');
  PERFORM pg_temp.zztest_assert(v_second = 0, 'second install must update 0 items');
  PERFORM pg_temp.zztest_assert(public.context_ledger_closed_how_backfill() = 0, 'repeat backfill must update 0 items');

  PERFORM pg_temp.zztest_assert(
    (SELECT closed_how FROM public.context_ledger_items WHERE id = '00000000-0000-4000-8000-000000010420') = 'record'
    AND (SELECT closed_how FROM public.context_ledger_items WHERE id = '00000000-0000-4000-8000-000000020420') = 'words_one_model'
    AND (SELECT closed_how FROM public.context_ledger_items WHERE id = '00000000-0000-4000-8000-000000030420') = 'person'
    AND (SELECT closed_how FROM public.context_ledger_items WHERE id = '00000000-0000-4000-8000-000000040420') = 'person'
    AND (SELECT closed_how FROM public.context_ledger_items WHERE id = '00000000-0000-4000-8000-000000050420') IS NULL
    AND (SELECT closed_how FROM public.context_ledger_items WHERE id = '00000000-0000-4000-8000-000000060420') IS NULL
    AND (SELECT closed_how FROM public.context_ledger_items WHERE id = '00000000-0000-4000-8000-000000070420') IS NULL,
    'backfill classification mismatch'
  );
END $backfill_proof$;

-- 4. Cases (a), (b), (c), (d), (e), (f), (g) on ZZTEST-421..425.
INSERT INTO public.context_ledger_generations (id, job_id, kind, status, reader, promoted_at)
VALUES
  ('00000000-0000-4000-8000-000000000421', '00000000-0000-4000-8000-000000000421', 'rebuild', 'live', 'luna-ledger:v9-words1', '2026-11-03T10:00:00+08'),
  ('00000000-0000-4000-8000-000000002421', '00000000-0000-4000-8000-000000000421', 'rebuild', 'shadow', 'luna-ledger:v9-words1', NULL);

INSERT INTO public.context_ledger_items (
  id, generation_id, job_id, item_key, item_type, status, from_role, what,
  opened_at, opened_by, closed_at, closed_by, written_by, person_locked, updated_at
) VALUES
  -- (a) record close
  ('00000000-0000-4000-8000-000000010421', '00000000-0000-4000-8000-000000000421', '00000000-0000-4000-8000-000000000421',
   'item:a:record', 'request', 'closed', 'customer', 'Invoice requested.',
   '2026-11-03T09:00:00+08', '[{"table":"business_events","id":"ev-a"}]', '2026-11-04T09:00:00+08', '[{"table":"xero_invoices","id":"inv-a"}]', 'model:luna-ledger:v9-words1', false, '2026-11-04T09:00:00+08'),
  -- (b) words close
  ('00000000-0000-4000-8000-000000020421', '00000000-0000-4000-8000-000000000421', '00000000-0000-4000-8000-000000000421',
   'item:b:words', 'issue', 'closed', 'customer', 'Gate latch issue.',
   '2026-11-03T09:00:00+08', '[{"table":"business_events","id":"ev-b1"}]', '2026-11-04T10:00:00+08', '[{"table":"business_events","id":"ev-b2"}]', 'model:luna-ledger:v9-words1', false, '2026-11-04T10:00:00+08'),
  -- shadow twin of (b)
  ('00000000-0000-4000-8000-000000022421', '00000000-0000-4000-8000-000000002421', '00000000-0000-4000-8000-000000000421',
   'item:b:words', 'issue', 'closed', 'customer', 'Gate latch issue.',
   '2026-11-03T09:00:00+08', '[{"table":"business_events","id":"ev-b1"}]', '2026-11-04T10:00:00+08', '[{"table":"business_events","id":"ev-b2"}]', 'model:luna-ledger:v9-words1', false, '2026-11-04T10:00:00+08'),
  -- (c) person close
  ('00000000-0000-4000-8000-000000030421', '00000000-0000-4000-8000-000000000421', '00000000-0000-4000-8000-000000000421',
   'item:c:person', 'request', 'closed', 'customer', 'Call requested.',
   '2026-11-03T09:00:00+08', '[{"table":"business_events","id":"ev-c1"}]', '2026-11-04T11:00:00+08', '[{"table":"person","id":"user-c"}]', 'model:luna-ledger:v9-words1', true, '2026-11-04T11:00:00+08'),
  -- (g) open item whose status/timestamps must never be altered by stamp
  ('00000000-0000-4000-8000-000000040421', '00000000-0000-4000-8000-000000000421', '00000000-0000-4000-8000-000000000421',
   'item:g:open', 'commitment', 'open', 'us', 'Send schedule confirmation.',
   '2026-11-03T09:00:00+08', '[{"table":"business_events","id":"ev-g1"}]', NULL, NULL, 'model:luna-ledger:v9-words1', false, '2026-11-03T09:00:00+08');

-- Statement-level trigger stamps (a), (b) + shadow twin, and (c) in one multi-row insert.
INSERT INTO public.context_ledger_transitions (item_id, generation_id, job_id, from_status, to_status, at, by, evidence, reason)
VALUES
  ('00000000-0000-4000-8000-000000010421', '00000000-0000-4000-8000-000000000421', '00000000-0000-4000-8000-000000000421',
   'open', 'closed', '2026-11-04T09:00:00+08', 'rule:record_close_v1', '[{"table":"xero_invoices","id":"inv-a"}]', 'Invoice issued.'),
  ('00000000-0000-4000-8000-000000020421', '00000000-0000-4000-8000-000000000421', '00000000-0000-4000-8000-000000000421',
   'open', 'closed', '2026-11-04T10:00:00+08', 'model:luna-ledger:v9-words1', '[{"table":"business_events","id":"ev-b2"}]', 'Customer confirmed fixed.'),
  ('00000000-0000-4000-8000-000000030421', '00000000-0000-4000-8000-000000000421', '00000000-0000-4000-8000-000000000421',
   'open', 'closed', '2026-11-04T11:00:00+08', 'person:00000000-0000-4000-8000-000000000902', '[{"table":"person","id":"user-c"}]', 'Closed by staff.');

DO $cases_abc_fg$
DECLARE
  v_marked integer;
  v_agreed_1 timestamptz;
  v_agreed_2 timestamptz;
BEGIN
  -- (a), (b) before mark, (c), (g)
  PERFORM pg_temp.zztest_assert(
    (SELECT closed_how FROM public.context_ledger_items WHERE id = '00000000-0000-4000-8000-000000010421') = 'record',
    'case (a): rule:record_close_v1 did not stamp record'
  );
  PERFORM pg_temp.zztest_assert(
    (SELECT closed_how FROM public.context_ledger_items WHERE id = '00000000-0000-4000-8000-000000020421') = 'words_one_model'
    AND (SELECT closed_how FROM public.context_ledger_items WHERE id = '00000000-0000-4000-8000-000000022421') = 'words_one_model',
    'case (b): model close before mark did not stamp words_one_model'
  );
  PERFORM pg_temp.zztest_assert(
    (SELECT closed_how FROM public.context_ledger_items WHERE id = '00000000-0000-4000-8000-000000030421') = 'person',
    'case (c): person close did not stamp person'
  );
  PERFORM pg_temp.zztest_assert(
    (SELECT status FROM public.context_ledger_items WHERE id = '00000000-0000-4000-8000-000000040421') = 'open'
    AND (SELECT closed_how FROM public.context_ledger_items WHERE id = '00000000-0000-4000-8000-000000040421') IS NULL
    AND (SELECT updated_at FROM public.context_ledger_items WHERE id = '00000000-0000-4000-8000-000000010421') = '2026-11-04T09:00:00+08'::timestamptz,
    'case (g): stamp altered status or updated_at'
  );
  PERFORM pg_temp.zztest_assert(
    public.context_ledger_closed_how_stamp('00000000-0000-4000-8000-000000000421') = 0,
    'unchanged stamp must return 0'
  );

  -- (f) equal model names must raise word_closes_same_model and write nothing.
  BEGIN
    PERFORM public.context_ledger_word_closes_mark(
      '00000000-0000-4000-8000-000000000421',
      ARRAY['item:b:words'],
      'luna-ledger:v9-words1',
      'gpt-6-luna',
      'GPT-6-LUNA'
    );
    RAISE EXCEPTION 'ZZTEST closed_how: expected word_closes_same_model';
  EXCEPTION WHEN invalid_parameter_value THEN
    IF SQLERRM <> 'word_closes_same_model' THEN RAISE; END IF;
  END;
  PERFORM pg_temp.zztest_assert(
    NOT EXISTS (SELECT 1 FROM public.context_ledger_word_closes WHERE job_id = '00000000-0000-4000-8000-000000000421'),
    'case (f): failed mark inserted a word_closes row'
  );

  -- (b) after context_ledger_word_closes_mark (including retry after refusal), closed_how becomes words_two_models.
  v_marked := public.context_ledger_word_closes_mark(
    '00000000-0000-4000-8000-000000000421',
    ARRAY['item:b:words'],
    'luna-ledger:v9-words1',
    'gpt-6-luna',
    'claude-sonnet-4-6'
  );
  SELECT agreed_at INTO v_agreed_1
  FROM public.context_ledger_word_closes
  WHERE job_id = '00000000-0000-4000-8000-000000000421' AND item_key = 'item:b:words';

  PERFORM pg_temp.zztest_assert(
    v_marked = 1
    AND v_agreed_1 IS NOT NULL
    AND (SELECT closed_how FROM public.context_ledger_items WHERE id = '00000000-0000-4000-8000-000000020421') = 'words_two_models'
    AND (SELECT closed_how FROM public.context_ledger_items WHERE id = '00000000-0000-4000-8000-000000022421') = 'words_two_models',
    'case (b): mark did not update closed_how to words_two_models'
  );

  -- Conflict upsert replaces models and agreed_at, and deduplicates repeated keys cleanly.
  UPDATE public.context_ledger_word_closes
  SET agreed_at = '2026-11-04T00:00:00+08'
  WHERE job_id = '00000000-0000-4000-8000-000000000421' AND item_key = 'item:b:words';

  v_marked := public.context_ledger_word_closes_mark(
    '00000000-0000-4000-8000-000000000421',
    ARRAY['item:b:words', 'item:b:words'],
    'luna-ledger:v9-words1',
    'gpt-6-luna',
    'claude-opus-4-6'
  );
  SELECT agreed_at INTO v_agreed_2
  FROM public.context_ledger_word_closes
  WHERE job_id = '00000000-0000-4000-8000-000000000421'
    AND item_key = 'item:b:words'
    AND checker_model = 'claude-opus-4-6';

  PERFORM pg_temp.zztest_assert(
    v_marked = 1 AND v_agreed_2 > '2026-11-04T00:00:00+08'::timestamptz,
    'conflict upsert did not replace checker_model and agreed_at'
  );
END $cases_abc_fg$;

-- 5. Case (e): a new live reading with a new item row of the same key, already closed,
--    is stamped words_two_models after any transition insert for the job;
--    also carry-forward of a person-closed note keeps person.
UPDATE public.context_ledger_generations
SET status = 'retired', retired_at = '2026-11-05T08:00:00+08'
WHERE id IN ('00000000-0000-4000-8000-000000000421', '00000000-0000-4000-8000-000000002421');

INSERT INTO public.context_ledger_generations (id, job_id, kind, status, reader, promoted_at)
VALUES ('00000000-0000-4000-8000-000000003421', '00000000-0000-4000-8000-000000000421', 'rebuild', 'live', 'luna-ledger:v9-words1', '2026-11-05T08:01:00+08');

INSERT INTO public.context_ledger_items (
  id, generation_id, job_id, item_key, item_type, status, from_role, what,
  opened_at, opened_by, closed_at, closed_by, written_by, person_locked
) VALUES
  -- New row for item:b:words, already closed, closed_how initially NULL, no transition on this item_id
  ('00000000-0000-4000-8000-000000050421', '00000000-0000-4000-8000-000000003421', '00000000-0000-4000-8000-000000000421',
   'item:b:words', 'issue', 'closed', 'customer', 'Gate latch issue.',
   '2026-11-03T09:00:00+08', '[{"table":"business_events","id":"ev-b1"}]', '2026-11-04T10:00:00+08', '[{"table":"business_events","id":"ev-b2"}]', 'model:luna-ledger:v9-words1', false),
  -- Carried-forward person-locked closed item (written_by originally model:)
  ('00000000-0000-4000-8000-000000060421', '00000000-0000-4000-8000-000000003421', '00000000-0000-4000-8000-000000000421',
   'item:c:person', 'request', 'closed', 'customer', 'Call requested.',
   '2026-11-03T09:00:00+08', '[{"table":"business_events","id":"ev-c1"}]', '2026-11-04T11:00:00+08', '[{"table":"person","id":"user-c"}]', 'model:luna-ledger:v9-words1', true),
  -- Unrelated item on the new live generation whose transition triggers the job stamp
  ('00000000-0000-4000-8000-000000070421', '00000000-0000-4000-8000-000000003421', '00000000-0000-4000-8000-000000000421',
   'item:e:other', 'commitment', 'open', 'us', 'Confirm post colour.',
   '2026-11-05T08:00:00+08', '[{"table":"business_events","id":"ev-e1"}]', NULL, NULL, 'model:luna-ledger:v9-words1', false);

INSERT INTO public.context_ledger_transitions (item_id, generation_id, job_id, from_status, to_status, at, by, evidence, reason)
VALUES
  ('00000000-0000-4000-8000-000000060421', '00000000-0000-4000-8000-000000003421', '00000000-0000-4000-8000-000000000421',
   NULL, 'closed', '2026-11-05T08:01:00+08', 'rule:carry_forward', NULL, 'carried forward from generation 00000000-0000-4000-8000-000000000421'),
  ('00000000-0000-4000-8000-000000070421', '00000000-0000-4000-8000-000000003421', '00000000-0000-4000-8000-000000000421',
   NULL, 'open', '2026-11-05T08:01:01+08', 'model:luna-ledger:v9-words1', '[{"table":"business_events","id":"ev-e1"}]', 'written');

SELECT pg_temp.zztest_assert(
  (SELECT closed_how FROM public.context_ledger_items WHERE id = '00000000-0000-4000-8000-000000050421') = 'words_two_models'
  AND (SELECT closed_how FROM public.context_ledger_items WHERE id = '00000000-0000-4000-8000-000000060421') = 'person'
  AND (SELECT status FROM public.context_ledger_items WHERE id = '00000000-0000-4000-8000-000000070421') = 'open'
  AND (SELECT closed_how FROM public.context_ledger_items WHERE id = '00000000-0000-4000-8000-000000070421') IS NULL,
  'case (e): new live reading item was not stamped words_two_models or carry_forward lost person'
);

-- 6. Case (d): reopening by a person sets closed_how NULL and removes the word_closes row,
--    so a subsequent single-model close starts clean at words_one_model.
UPDATE public.context_ledger_items
SET status = 'open', closed_at = NULL, closed_by = NULL, person_locked = true
WHERE id = '00000000-0000-4000-8000-000000050421';

INSERT INTO public.context_ledger_transitions (item_id, generation_id, job_id, from_status, to_status, at, by, evidence, reason)
VALUES (
  '00000000-0000-4000-8000-000000050421',
  '00000000-0000-4000-8000-000000003421',
  '00000000-0000-4000-8000-000000000421',
  'closed',
  'open',
  '2026-11-05T09:00:00+08',
  'person:00000000-0000-4000-8000-000000000903',
  '[{"table":"person","id":"user-reopen"}]',
  'Reopened by staff.'
);

SELECT pg_temp.zztest_assert(
  (SELECT closed_how FROM public.context_ledger_items WHERE id = '00000000-0000-4000-8000-000000050421') IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.context_ledger_word_closes
    WHERE job_id = '00000000-0000-4000-8000-000000000421' AND item_key = 'item:b:words'
  ),
  'case (d): person reopen did not clear closed_how and delete word_closes row'
);

-- Also verify disputed by person clears word_closes, and a later single-model close gets words_one_model.
SELECT pg_temp.zztest_assert(
  public.context_ledger_word_closes_mark(
    '00000000-0000-4000-8000-000000000421',
    ARRAY['item:e:other'],
    'luna-ledger:v9-words1',
    'gpt-6-luna',
    'claude-sonnet-4-6'
  ) = 1,
  'mark item:e:other failed'
);
UPDATE public.context_ledger_items SET status = 'disputed', person_locked = true WHERE id = '00000000-0000-4000-8000-000000070421';
INSERT INTO public.context_ledger_transitions (item_id, generation_id, job_id, from_status, to_status, at, by, evidence, reason)
VALUES (
  '00000000-0000-4000-8000-000000070421',
  '00000000-0000-4000-8000-000000003421',
  '00000000-0000-4000-8000-000000000421',
  'open',
  'disputed',
  '2026-11-05T09:10:00+08',
  'person:00000000-0000-4000-8000-000000000903',
  '[{"table":"person","id":"user-dispute"}]',
  'Marked disputed.'
);
SELECT pg_temp.zztest_assert(
  NOT EXISTS (
    SELECT 1 FROM public.context_ledger_word_closes
    WHERE job_id = '00000000-0000-4000-8000-000000000421' AND item_key = 'item:e:other'
  ),
  'person dispute did not delete word_closes row'
);

UPDATE public.context_ledger_items
SET status = 'closed', closed_at = '2026-11-05T10:00:00+08', closed_by = '[{"table":"business_events","id":"ev-b3"}]', person_locked = false
WHERE id = '00000000-0000-4000-8000-000000050421';
INSERT INTO public.context_ledger_transitions (item_id, generation_id, job_id, from_status, to_status, at, by, evidence, reason)
VALUES (
  '00000000-0000-4000-8000-000000050421',
  '00000000-0000-4000-8000-000000003421',
  '00000000-0000-4000-8000-000000000421',
  'open',
  'closed',
  '2026-11-05T10:00:00+08',
  'model:luna-ledger:v9-words1',
  '[{"table":"business_events","id":"ev-b3"}]',
  'Closed again by one reader.'
);
SELECT pg_temp.zztest_assert(
  (SELECT closed_how FROM public.context_ledger_items WHERE id = '00000000-0000-4000-8000-000000050421') = 'words_one_model',
  'later close after person reopen did not start clean at words_one_model'
);

-- 7. Check constraint, missing/bad input refusals (Rule 21d), and trigger fault isolation (Merge-safety 4 & 14).
DO $bad_paths$
BEGIN
  BEGIN
    UPDATE public.context_ledger_items SET closed_how = 'guessed' WHERE id = '00000000-0000-4000-8000-000000050421';
    RAISE EXCEPTION 'ZZTEST closed_how: check constraint accepted invalid value';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    PERFORM public.context_ledger_closed_how_stamp('00000000-0000-4000-8000-000000999999');
    RAISE EXCEPTION 'ZZTEST closed_how: stamp accepted unknown job';
  EXCEPTION WHEN invalid_parameter_value THEN
    IF SQLERRM <> 'closed_how_job_not_found' THEN RAISE; END IF;
  END;

  BEGIN
    PERFORM public.context_ledger_word_closes_mark(
      '00000000-0000-4000-8000-000000999999',
      ARRAY['item:b:words'],
      'luna-ledger:v9-words1',
      'gpt-6-luna',
      'claude-sonnet-4-6'
    );
    RAISE EXCEPTION 'ZZTEST closed_how: mark accepted unknown job';
  EXCEPTION WHEN invalid_parameter_value THEN
    IF SQLERRM <> 'word_closes_job_not_found' THEN RAISE; END IF;
  END;

  BEGIN
    PERFORM public.context_ledger_word_closes_mark(
      '00000000-0000-4000-8000-000000000421',
      NULL,
      'luna-ledger:v9-words1',
      'gpt-6-luna',
      'claude-sonnet-4-6'
    );
    RAISE EXCEPTION 'ZZTEST closed_how: mark accepted null keys';
  EXCEPTION WHEN invalid_parameter_value THEN
    IF SQLERRM <> 'word_closes_keys_required' THEN RAISE; END IF;
  END;
END $bad_paths$;

SAVEPOINT before_trigger_fault;
CREATE OR REPLACE FUNCTION public.context_ledger_closed_how_stamp(p_job_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fault$
BEGIN
  RAISE EXCEPTION 'simulated_stamp_failure';
END $fault$;

INSERT INTO public.context_ledger_transitions (item_id, generation_id, job_id, from_status, to_status, at, by, evidence, reason)
VALUES (
  '00000000-0000-4000-8000-000000050421',
  '00000000-0000-4000-8000-000000003421',
  '00000000-0000-4000-8000-000000000421',
  'closed',
  'closed',
  '2026-11-05T10:05:00+08',
  'model:luna-ledger:v9-words1',
  '[{"table":"business_events","id":"ev-b4"}]',
  'Trigger fault must never fail transition insert.'
);
ROLLBACK TO SAVEPOINT before_trigger_fault;

-- Remove and re-install functions work cleanly.
SELECT public.context_ledger_closed_how_remove();
SELECT pg_temp.zztest_assert(
  NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.context_ledger_transitions'::regclass
      AND tgname = 'context_ledger_transitions_closed_how'
      AND NOT tgisinternal
  ),
  'remove function left trigger installed'
);
SELECT pg_temp.zztest_assert(public.context_ledger_closed_how_install() >= 0, 're-install failed');

-- 8. Rule 16: prove index plans on 3,000 unrelated rows (no Seq Scan, index scan on each table).
SET LOCAL session_replication_role = replica;
INSERT INTO public.jobs (id, org_id, type, status, job_number, created_at)
SELECT
  ('10000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  '00000000-0000-0000-0000-000000000001',
  'fencing',
  'accepted',
  'ZZTEST-BULK-' || n,
  '2026-10-01T00:00:00+08'
FROM generate_series(1, 3000) AS n;

INSERT INTO public.context_ledger_generations (id, job_id, kind, status, reader, promoted_at, retired_at)
SELECT
  ('10000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  ('10000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  'rebuild',
  CASE WHEN n <= 10 THEN 'live' ELSE 'retired' END,
  'luna-ledger:v8',
  '2026-10-02T00:00:00+08',
  CASE WHEN n <= 10 THEN NULL ELSE '2026-10-03T00:00:00+08'::timestamptz END
FROM generate_series(1, 3000) AS n;

INSERT INTO public.context_ledger_items (
  id, generation_id, job_id, item_key, item_type, status, from_role, what,
  opened_at, opened_by, closed_at, closed_by, written_by
)
SELECT
  ('20000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  ('10000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  ('10000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  'item:bulk:' || n,
  'request',
  'closed',
  'customer',
  'Bulk fixture item.',
  '2026-10-01T09:00:00+08',
  '[{"table":"job_events","id":"bulk-open"}]',
  '2026-10-02T09:00:00+08',
  '[{"table":"job_events","id":"bulk-close"}]',
  'model:luna-ledger:v8'
FROM generate_series(1, 3000) AS n;

INSERT INTO public.context_ledger_transitions (item_id, generation_id, job_id, from_status, to_status, at, by, evidence, reason)
SELECT
  ('20000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  ('10000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  ('10000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  'open',
  'closed',
  '2026-10-02T09:00:00+08',
  'model:luna-ledger:v8',
  '[{"table":"job_events","id":"bulk-close"}]',
  'Bulk close.'
FROM generate_series(1, 3000) AS n;

INSERT INTO public.context_ledger_word_closes (job_id, item_key, reader, reader_model, checker_model, agreed_at)
SELECT
  ('10000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  'item:bulk:' || n,
  'luna-ledger:v9-words1',
  'gpt-6-luna',
  'claude-sonnet-4-6',
  '2026-10-02T09:01:00+08'
FROM generate_series(1, 3000) AS n;
SET LOCAL session_replication_role = origin;

ANALYZE public.context_ledger_generations;
ANALYZE public.context_ledger_items;
ANALYZE public.context_ledger_transitions;
ANALYZE public.context_ledger_word_closes;

CREATE FUNCTION pg_temp.zztest_explain_stamp()
RETURNS SETOF text LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY EXECUTE $ex$
    EXPLAIN (ANALYZE, FORMAT TEXT)
    WITH latest_close AS (
      SELECT DISTINCT ON (ti.item_key)
        ti.item_key,
        t.by
      FROM public.context_ledger_transitions AS t
      JOIN public.context_ledger_items AS ti
        ON ti.id = t.item_id
       AND ti.job_id = '00000000-0000-4000-8000-000000000421'::uuid
      WHERE t.job_id = '00000000-0000-4000-8000-000000000421'::uuid
        AND t.to_status IN ('closed', 'declined')
        AND t.by NOT IN ('rule:carry_forward', 'rule:rebuild_seed')
      ORDER BY ti.item_key, t.at DESC, t.id DESC
    )
    SELECT
      i.id,
      lc.by,
      wc.item_key
    FROM public.context_ledger_generations AS g
    JOIN public.context_ledger_items AS i
      ON i.generation_id = g.id
     AND i.job_id = '00000000-0000-4000-8000-000000000421'::uuid
    LEFT JOIN latest_close AS lc
      ON lc.item_key = i.item_key
    LEFT JOIN public.context_ledger_word_closes AS wc
      ON wc.job_id = '00000000-0000-4000-8000-000000000421'::uuid
     AND wc.item_key = i.item_key
    WHERE g.job_id = '00000000-0000-4000-8000-000000000421'::uuid
      AND g.status IN ('live', 'shadow', 'building')
  $ex$;
END $$;

CREATE FUNCTION pg_temp.zztest_explain_reopen_delete()
RETURNS SETOF text LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY EXECUTE $ex$
    EXPLAIN (ANALYZE, FORMAT TEXT)
    SELECT wc.job_id, wc.item_key
    FROM (VALUES ('00000000-0000-4000-8000-000000050421'::uuid, '00000000-0000-4000-8000-000000000421'::uuid, 'open'::text, 'person:00000000-0000-4000-8000-000000000903'::text)) AS nr(item_id, job_id, to_status, by)
    JOIN public.context_ledger_items AS i
      ON i.id = nr.item_id
     AND i.job_id = nr.job_id
    JOIN public.context_ledger_word_closes AS wc
      ON wc.job_id = nr.job_id
     AND wc.item_key = i.item_key
    WHERE nr.to_status IN ('open', 'disputed')
      AND nr.by LIKE 'person:%'
  $ex$;
END $$;

CREATE FUNCTION pg_temp.zztest_explain_backfill()
RETURNS SETOF text LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY EXECUTE $ex$
    EXPLAIN (ANALYZE, FORMAT TEXT)
    SELECT
      i.id,
      lc.by,
      wc.item_key
    FROM public.context_ledger_generations AS g
    JOIN public.context_ledger_items AS i
      ON i.generation_id = g.id
     AND i.job_id = g.job_id
    LEFT JOIN LATERAL (
      SELECT t.by
      FROM public.context_ledger_transitions AS t
      JOIN public.context_ledger_items AS ti
        ON ti.id = t.item_id
       AND ti.job_id = i.job_id
       AND ti.item_key = i.item_key
      WHERE t.job_id = i.job_id
        AND t.to_status IN ('closed', 'declined')
        AND t.by NOT IN ('rule:carry_forward', 'rule:rebuild_seed')
      ORDER BY t.at DESC, t.id DESC
      LIMIT 1
    ) AS lc ON true
    LEFT JOIN public.context_ledger_word_closes AS wc
      ON wc.job_id = i.job_id
     AND wc.item_key = i.item_key
    WHERE g.status = 'live'
      AND i.status IN ('closed', 'declined')
  $ex$;
END $$;

DO $verify_plans$
DECLARE
  v_stamp_plan text;
  v_reopen_plan text;
  v_backfill_plan text;
BEGIN
  SELECT string_agg(line, E'\n') INTO v_stamp_plan FROM pg_temp.zztest_explain_stamp() AS line;
  SELECT string_agg(line, E'\n') INTO v_reopen_plan FROM pg_temp.zztest_explain_reopen_delete() AS line;
  SELECT string_agg(line, E'\n') INTO v_backfill_plan FROM pg_temp.zztest_explain_backfill() AS line;

  IF v_stamp_plan LIKE '%Seq Scan%' THEN
    RAISE EXCEPTION 'ZZTEST closed_how: stamp plan used Seq Scan: %', v_stamp_plan;
  END IF;
  IF v_stamp_plan NOT LIKE '%Index%' THEN
    RAISE EXCEPTION 'ZZTEST closed_how: stamp plan missing index scan: %', v_stamp_plan;
  END IF;
  IF v_reopen_plan LIKE '%Seq Scan%' THEN
    RAISE EXCEPTION 'ZZTEST closed_how: reopen delete plan used Seq Scan: %', v_reopen_plan;
  END IF;
  IF v_reopen_plan NOT LIKE '%Index%' THEN
    RAISE EXCEPTION 'ZZTEST closed_how: reopen delete plan missing index scan: %', v_reopen_plan;
  END IF;
  IF v_backfill_plan LIKE '%Seq Scan%' THEN
    RAISE EXCEPTION 'ZZTEST closed_how: backfill plan used Seq Scan: %', v_backfill_plan;
  END IF;
  IF v_backfill_plan NOT LIKE '%Index%' THEN
    RAISE EXCEPTION 'ZZTEST closed_how: backfill plan missing index scan: %', v_backfill_plan;
  END IF;
END $verify_plans$;

SELECT 'PASS: P4-02.10 closed_how stamp, two-model word closes, person reopen reset, backfill, fault isolation, and index plans' AS result;
ROLLBACK;
