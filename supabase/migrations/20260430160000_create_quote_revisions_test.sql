-- Trigger regression gate for 20260430160000_create_quote_revisions.sql.
--
-- 6 mandatory cases. The trigger has THREE refusal branches, plus a separate
-- no-delete trigger. Cases 3, 4, 5 cover each refusal branch in turn:
--
--   branch 1: OLD.sent_at IS NOT NULL  -> 'rows are immutable once sent_at is set'
--   branch 2: NEW.sent_at IS NULL      -> 'cannot UPDATE while leaving sent_at NULL'
--   branch 3: any non-sent_at column DISTINCT FROM old -> 'only sent_at may transition'
--
-- Run as a manual or CI step against a Supabase BRANCH (NOT production) AFTER
-- mcp__supabase__apply_migration installs the new migration on the branch. The
-- script wraps everything in BEGIN ... ROLLBACK so test data is automatically
-- discarded on completion (released quote_revisions rows are normally immutable,
-- but ROLLBACK discards the whole transaction). Expected trigger failures are
-- caught inside savepoints; unexpected failures abort the transaction and (with
-- ON_ERROR_STOP on) stop psql with a non-zero exit code so CI fails hard.
--
-- To run from psql against a branch DB:
--   psql "<branch_db_connection_string>" -v ON_ERROR_STOP=on -f 20260430160000_create_quote_revisions_test.sql
--
-- All 6 cases must pass before the migration ships to production. A pass
-- looks like four `TEST PASS case N` notices (cases 3, 4, 5, 6); cases 1 and
-- 2 succeed silently. The final NOTICE block reports `TEST SUMMARY: 6/6 ...`.

\set ON_ERROR_STOP on

BEGIN;

DO $top$
DECLARE
  org_uuid uuid := '00000000-0000-0000-0000-000000000001';
  job_a uuid;
  doc_a uuid;
  job_b uuid;
  doc_b uuid;
  pass_count integer := 0;
BEGIN
  -- ── Fixture jobs + docs (CAP0 TEST naming so isTestRecord auto-hides) ──
  INSERT INTO public.jobs (org_id, status, type, client_name)
    VALUES (org_uuid, 'draft', 'patio',
            'CAP0 TEST quote_revisions trigger gate (job A)')
    RETURNING id INTO job_a;
  INSERT INTO public.job_documents (job_id, type, version)
    VALUES (job_a, 'quote', 1)
    RETURNING id INTO doc_a;

  INSERT INTO public.jobs (org_id, status, type, client_name)
    VALUES (org_uuid, 'draft', 'patio',
            'CAP0 TEST quote_revisions trigger gate (job B)')
    RETURNING id INTO job_b;
  INSERT INTO public.job_documents (job_id, type, version)
    VALUES (job_b, 'quote', 1)
    RETURNING id INTO doc_b;

  -- ── Case 1 — INSERT staged (sent_at NULL) succeeds ──
  -- Inserts a row for job_a. Will be released in case 2.
  INSERT INTO public.quote_revisions (
    job_id, job_document_id, version, recipient_email,
    scope_snapshot_json, pricing_snapshot_json, totals_snapshot_json,
    manifest_url, manifest_hash, pdf_url,
    build_kind, released_via, sent_at
  ) VALUES (
    job_a, doc_a, 1, 'marnin@secureworkswa.com.au',
    '{"client_name":"X"}'::jsonb,
    '{"totalIncGST":5500}'::jsonb,
    '{"total_inc_gst":5500}'::jsonb,
    'https://example.com/manifest.json',
    'deadbeef0000000000000000000000000000000000000000000000000000feed',
    'https://example.com/quote.pdf',
    'patio', 'send-quote/send', NULL
  );
  -- expect: succeeds silently (1 row inserted, sent_at NULL)

  -- ── Case 2 — UPDATE flipping ONLY sent_at NULL -> timestamp succeeds ──
  -- Releases the job_a row. After this, sent_at IS NOT NULL on that row.
  UPDATE public.quote_revisions
  SET sent_at = now()
  WHERE job_id = job_a;
  -- expect: succeeds silently (sent_at non-null, row is now released-immutable)

  -- ── Case 3 — UPDATE attempting to release + change non-sent_at column refused ──
  -- Insert a fresh staged row for job_b (case 3, 5, 6 will each touch this row).
  INSERT INTO public.quote_revisions (
    job_id, job_document_id, version, recipient_email,
    scope_snapshot_json, pricing_snapshot_json, totals_snapshot_json,
    manifest_url, manifest_hash, pdf_url,
    build_kind, released_via, sent_at
  ) VALUES (
    job_b, doc_b, 1, 'marnin@secureworkswa.com.au',
    '{"client_name":"X"}'::jsonb,
    '{"totalIncGST":5500}'::jsonb,
    '{"total_inc_gst":5500}'::jsonb,
    'https://example.com/manifest.json',
    'deadbeef0000000000000000000000000000000000000000000000000000beef',
    'https://example.com/quote.pdf',
    'patio', 'send-quote/send', NULL
  );

  -- Hits BRANCH 3: 'only sent_at may transition NULL -> NOT NULL on UPDATE'.
  -- OLD.sent_at IS NULL (skips branch 1), NEW.sent_at IS NOT NULL (skips
  -- branch 2), but scope_snapshot_json IS DISTINCT FROM old -> branch 3 fires.
  BEGIN
    UPDATE public.quote_revisions
    SET sent_at = now(), scope_snapshot_json = '{"client_name":"MUTATED"}'::jsonb
    WHERE job_id = job_b;
    RAISE EXCEPTION 'TEST FAIL: case 3 should have been refused but UPDATE succeeded';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'TEST PASS case 3 (branch 3 — only sent_at may transition): UPDATE refused as expected (% / %)', SQLSTATE, SQLERRM;
    pass_count := pass_count + 1;
  END;

  -- ── Case 4 — Released-row reversal: SET sent_at = NULL on a released row ──
  -- The job_a row is released (sent_at IS NOT NULL from case 2). Hits BRANCH 1:
  -- 'rows are immutable once sent_at is set'. Branch 1 fires before branch 2,
  -- so even though NEW.sent_at would also be NULL (which would also trip
  -- branch 2 on a staged row), branch 1's "released-immutable" check wins here.
  -- This is the canonical "cannot un-release a quote revision" guarantee.
  BEGIN
    UPDATE public.quote_revisions
    SET sent_at = NULL
    WHERE job_id = job_a;
    RAISE EXCEPTION 'TEST FAIL: case 4 should have been refused but UPDATE succeeded';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'TEST PASS case 4 (branch 1 — released->NULL reversal): UPDATE refused as expected (% / %)', SQLSTATE, SQLERRM;
    pass_count := pass_count + 1;
  END;

  -- ── Case 5 — Staged row, UPDATE that leaves sent_at NULL refused ──
  -- The job_b row is still staged (case 3's UPDATE was refused inside a
  -- savepoint, so the row is unchanged). Attempt a non-sent_at UPDATE:
  -- OLD.sent_at IS NULL (skips branch 1), NEW.sent_at IS NULL because we
  -- don't touch sent_at -> BRANCH 2 fires:
  -- 'cannot UPDATE while leaving sent_at NULL'.
  -- This is the "stuck staged" guarantee: a staged row cannot be edited in
  -- place; the only allowed UPDATE is the release flip (sent_at NULL -> non-NULL).
  BEGIN
    UPDATE public.quote_revisions
    SET margin_pct = 25
    WHERE job_id = job_b;
    RAISE EXCEPTION 'TEST FAIL: case 5 should have been refused but UPDATE succeeded';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'TEST PASS case 5 (branch 2 — leaving sent_at NULL): UPDATE refused as expected (% / %)', SQLSTATE, SQLERRM;
    pass_count := pass_count + 1;
  END;

  -- ── Case 6 — DELETE refused (no_delete trigger) ──
  BEGIN
    DELETE FROM public.quote_revisions WHERE job_id IN (job_a, job_b);
    RAISE EXCEPTION 'TEST FAIL: case 6 should have been refused but DELETE succeeded';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'TEST PASS case 6 (no_delete trigger): DELETE refused as expected (% / %)', SQLSTATE, SQLERRM;
    pass_count := pass_count + 1;
  END;

  -- ── Final summary ──
  -- Cases 1 and 2 silently succeed (no exception = no notice). Cases 3-6
  -- raise a NOTICE on success (their refusal). pass_count tracks those four.
  -- Cases 1 and 2 are accounted for by the absence of any unexpected error
  -- reaching this point (would have aborted the DO block).
  IF pass_count = 4 THEN
    RAISE NOTICE 'TEST SUMMARY: 6/6 trigger regression cases passed (cases 1,2 succeeded silently; cases 3,4,5,6 raised expected check_violation, covering branches 3, 1, 2 + no_delete)';
  ELSE
    RAISE EXCEPTION 'TEST SUMMARY: only % of expected 4 refusal-cases passed; check NOTICEs above', pass_count;
  END IF;
END$top$;

-- Cleanup: roll back so the test fixture data does not persist on the branch.
-- Released quote_revisions rows are normally immutable, but ROLLBACK simply
-- discards the entire transaction, including the trigger-protected rows.
ROLLBACK;

\echo 'Trigger regression suite completed. Confirm 4 TEST PASS notices and a 6/6 TEST SUMMARY above. Any other error means the gate failed.'
