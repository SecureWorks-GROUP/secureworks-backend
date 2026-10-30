-- Contract for 20261029180000_scope_revisions_superseded_lock (JP-24).
-- Synthetic rows only; everything rolls back.
--
-- Proves, on the real stack:
--   * the four real writers still work (insert frozen, insert draft,
--     draft -> frozen, frozen -> superseded with both supersession columns);
--   * a frozen row's contract columns stay locked (unchanged rule);
--   * a superseded row's scope_hash + scope_canonical_text, pricing_hash,
--     job_id and supersession link can no longer change, and it can never go
--     back to frozen;
--   * draft -> superseded and INSERT as superseded are refused;
--   * what is left as before: spine_event_id NULL -> NOT NULL on a superseded
--     row, and INSERT as frozen without frozen_at.

\set ON_ERROR_STOP on

BEGIN;

INSERT INTO public.jobs (id, org_id, status, type, job_number) VALUES
  ('5c100000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'complete', 'fencing', 'SRL-J1'),
  ('5c100000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000001', 'complete', 'fencing', 'SRL-J2');

DO $$
DECLARE
  j1 constant uuid := '5c100000-0000-4000-8000-000000000001';
  j2 constant uuid := '5c100000-0000-4000-8000-000000000002';
  a  constant uuid := '5c110000-0000-4000-8000-000000000001';  -- frozen, then superseded
  c  constant uuid := '5c110000-0000-4000-8000-000000000003';  -- draft, then frozen
  d  constant uuid := '5c110000-0000-4000-8000-000000000004';  -- a draft that tries to skip frozen
  n  integer;
  msg text;
  refused boolean;
BEGIN
  -- Writer 1, insertFreshFrozenRow: INSERT as frozen with frozen_at.
  INSERT INTO public.scope_revisions (id, job_id, revision_number, tool_kind, status,
         scope_canonical_text, scope_hash, pricing_canonical_text, pricing_hash,
         renderer_version, tool_version, frozen_at)
  VALUES (a, j1, 1, 'fencing', 'frozen', '{"a":1}', repeat('a', 64), '{"p":1}', repeat('b', 64),
          'r1', 't1', '2031-01-01T00:00:00Z');
  -- Writer 2, cloneScopeForEdit: INSERT as draft.
  INSERT INTO public.scope_revisions (id, job_id, revision_number, tool_kind, status,
         scope_canonical_text, scope_hash, pricing_canonical_text, pricing_hash,
         renderer_version, tool_version)
  VALUES (c, j1, 2, 'fencing', 'draft', '{"a":2}', repeat('c', 64), '{"p":2}', repeat('d', 64), 'r1', 't1');
  -- A draft may still be edited.
  UPDATE public.scope_revisions SET scope_hash = repeat('e', 64), scope_canonical_text = '{"a":3}' WHERE id = c;
  -- Writer 3, promoteDraftToFrozen: draft -> frozen with frozen_at.
  UPDATE public.scope_revisions SET status = 'frozen', frozen_at = '2031-01-02T00:00:00Z' WHERE id = c AND status = 'draft';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'superseded lock: draft -> frozen was refused'; END IF;
  -- Writer 4, healFrozenInvariant: frozen -> superseded with both columns.
  UPDATE public.scope_revisions
     SET status = 'superseded', superseded_at = '2031-01-02T00:00:01Z', superseded_by_scope_revision_id = c
   WHERE id = a AND status = 'frozen';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'superseded lock: frozen -> superseded was refused'; END IF;

  -- Unchanged rule: a frozen row's contract columns are locked.
  refused := false;
  BEGIN
    UPDATE public.scope_revisions SET scope_hash = repeat('f', 64) WHERE id = c;
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    refused := msg LIKE '%is frozen; only supersession + spine_event_id may change%';
  END;
  IF NOT refused THEN RAISE EXCEPTION 'superseded lock: a frozen row edit was accepted'; END IF;

  -- A superseded row: every contract column edit is refused.
  refused := false;
  BEGIN
    UPDATE public.scope_revisions SET scope_hash = repeat('9', 64), scope_canonical_text = '{"forged":1}' WHERE id = a;
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    refused := msg LIKE '%is superseded; only supersession + spine_event_id may change%';
  END;
  IF NOT refused THEN RAISE EXCEPTION 'superseded lock: a superseded row scope edit was accepted'; END IF;

  refused := false;
  BEGIN
    UPDATE public.scope_revisions SET pricing_hash = repeat('8', 64) WHERE id = a;
  EXCEPTION WHEN check_violation THEN refused := true;
  END;
  IF NOT refused THEN RAISE EXCEPTION 'superseded lock: a superseded row pricing edit was accepted'; END IF;

  refused := false;
  BEGIN
    UPDATE public.scope_revisions SET job_id = j2 WHERE id = a;
  EXCEPTION WHEN check_violation THEN refused := true;
  END;
  IF NOT refused THEN RAISE EXCEPTION 'superseded lock: a superseded row was moved to another job'; END IF;

  refused := false;
  BEGIN
    UPDATE public.scope_revisions SET superseded_by_scope_revision_id = a WHERE id = a;
  EXCEPTION WHEN check_violation THEN refused := true;
  END;
  IF NOT refused THEN RAISE EXCEPTION 'superseded lock: a superseded row link was rewritten'; END IF;

  refused := false;
  BEGIN
    UPDATE public.scope_revisions SET status = 'frozen' WHERE id = a;
  EXCEPTION WHEN check_violation THEN refused := true;
  END;
  IF NOT refused THEN RAISE EXCEPTION 'superseded lock: a superseded row went back to frozen'; END IF;

  -- Left as before: spine_event_id may be filled once on a superseded row.
  UPDATE public.scope_revisions SET spine_event_id = '5c120000-0000-4000-8000-000000000001' WHERE id = a;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'superseded lock: spine_event_id could not be filled on a superseded row'; END IF;

  -- Draft -> superseded is refused, with or without supersession columns.
  INSERT INTO public.scope_revisions (id, job_id, revision_number, tool_kind, status,
         scope_canonical_text, scope_hash, pricing_canonical_text, pricing_hash,
         renderer_version, tool_version)
  VALUES (d, j2, 1, 'fencing', 'draft', '{"a":4}', repeat('1', 64), '{"p":4}', repeat('2', 64), 'r1', 't1');
  refused := false;
  BEGIN
    UPDATE public.scope_revisions SET status = 'superseded' WHERE id = d;
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    refused := msg LIKE '%only a frozen row may be superseded%';
  END;
  IF NOT refused THEN RAISE EXCEPTION 'superseded lock: draft -> superseded was accepted'; END IF;
  refused := false;
  BEGIN
    UPDATE public.scope_revisions
       SET status = 'superseded', superseded_at = now(), superseded_by_scope_revision_id = c
     WHERE id = d;
  EXCEPTION WHEN check_violation THEN refused := true;
  END;
  IF NOT refused THEN RAISE EXCEPTION 'superseded lock: draft -> superseded with a link was accepted'; END IF;

  -- INSERT as superseded is refused.
  refused := false;
  BEGIN
    INSERT INTO public.scope_revisions (job_id, revision_number, tool_kind, status,
           scope_canonical_text, scope_hash, pricing_canonical_text, pricing_hash,
           renderer_version, tool_version, frozen_at, superseded_at, superseded_by_scope_revision_id)
    VALUES (j2, 2, 'fencing', 'superseded', '{"a":5}', repeat('3', 64), '{"p":5}', repeat('4', 64),
            'r1', 't1', now(), now(), c);
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    refused := msg LIKE '%cannot be inserted as superseded%';
  END;
  IF NOT refused THEN RAISE EXCEPTION 'superseded lock: INSERT as superseded was accepted'; END IF;

  -- Left as before: INSERT as frozen without frozen_at is accepted.
  INSERT INTO public.scope_revisions (job_id, revision_number, tool_kind, status,
         scope_canonical_text, scope_hash, pricing_canonical_text, pricing_hash,
         renderer_version, tool_version)
  VALUES (j2, 3, 'fencing', 'frozen', '{"a":6}', repeat('5', 64), '{"p":6}', repeat('6', 64), 'r1', 't1');

  -- Read back: the superseded row still holds what was frozen.
  IF NOT EXISTS (SELECT 1 FROM public.scope_revisions
                  WHERE id = a AND job_id = j1 AND status = 'superseded'
                    AND scope_hash = repeat('a', 64) AND scope_canonical_text = '{"a":1}'
                    AND pricing_hash = repeat('b', 64) AND superseded_by_scope_revision_id = c) THEN
    RAISE EXCEPTION 'superseded lock: the superseded row changed';
  END IF;

  -- The lock is the migration's body and both triggers are in place.
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.scope_revisions_controlled_immutable()'::regprocedure)
     <> 'b5275b79eb979c9215db5b46315685f7' THEN
    RAISE EXCEPTION 'superseded lock: scope_revisions_controlled_immutable is not the 20261029180000 body';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.scope_revisions'::regclass
                  AND tgname = 'trg_scope_revisions_controlled_immutable' AND NOT tgisinternal)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.scope_revisions'::regclass
                  AND tgname = 'trg_scope_revisions_insert_lifecycle' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'superseded lock: a scope_revisions trigger is missing';
  END IF;
END $$;

ROLLBACK;
