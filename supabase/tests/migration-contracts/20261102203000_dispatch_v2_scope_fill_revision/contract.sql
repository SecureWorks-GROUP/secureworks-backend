-- Contract for 20261102203000_dispatch_v2_scope_fill_revision.sql (T20).
-- Fixture writes roll back.

-- 1. The column: uuid, nullable, no default, a foreign key to scope_revisions(id)
--    with ON DELETE RESTRICT, and no column-level grant.
DO $$
DECLARE
  col record;
  fk record;
BEGIN
  SELECT a.atttypid::regtype::text AS type, a.attnotnull, a.atthasdef, a.attacl
    INTO col
  FROM pg_attribute a
  WHERE a.attrelid = 'public.dispatch_v2_scope_fills'::regclass
    AND a.attname = 'scope_revision_id' AND NOT a.attisdropped;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'scope fill revision contract: dispatch_v2_scope_fills.scope_revision_id is missing';
  END IF;
  IF col.type <> 'uuid' THEN
    RAISE EXCEPTION 'scope fill revision contract: scope_revision_id is %, not uuid', col.type;
  END IF;
  IF col.attnotnull THEN
    RAISE EXCEPTION 'scope fill revision contract: scope_revision_id must be nullable (null = a fill before T20)';
  END IF;
  IF col.atthasdef THEN
    RAISE EXCEPTION 'scope fill revision contract: scope_revision_id must have no default';
  END IF;
  IF col.attacl IS NOT NULL THEN
    RAISE EXCEPTION 'scope fill revision contract: scope_revision_id carries a column-level grant';
  END IF;

  SELECT c.confrelid::regclass::text AS target, c.confdeltype,
         (SELECT array_agg(att.attname ORDER BY att.attname) FROM pg_attribute att
           WHERE att.attrelid = c.confrelid AND att.attnum = ANY (c.confkey)) AS target_cols,
         (SELECT array_agg(att.attname ORDER BY att.attname) FROM pg_attribute att
           WHERE att.attrelid = c.conrelid AND att.attnum = ANY (c.conkey)) AS own_cols
    INTO fk
  FROM pg_constraint c
  WHERE c.conname = 'dispatch_v2_scope_fills_scope_revision_id_fkey'
    AND c.conrelid = 'public.dispatch_v2_scope_fills'::regclass
    AND c.contype = 'f';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'scope fill revision contract: the scope_revisions foreign key is missing';
  END IF;
  IF fk.target <> 'scope_revisions' OR fk.target_cols <> ARRAY['id']::name[] OR fk.own_cols <> ARRAY['scope_revision_id']::name[] THEN
    RAISE EXCEPTION 'scope fill revision contract: the foreign key is % % -> %, not scope_revision_id -> scope_revisions(id)',
      fk.own_cols, fk.target, fk.target_cols;
  END IF;
  IF fk.confdeltype <> 'r' THEN
    RAISE EXCEPTION 'scope fill revision contract: the foreign key must be ON DELETE RESTRICT, got %', fk.confdeltype;
  END IF;
END $$;

-- 2. Behaviour: a fill naming a real scope revision and a fill with none are
--    accepted; a fill naming a revision that does not exist is refused; a
--    revision a fill names cannot be deleted.
BEGIN;
DO $$
DECLARE
  cols text;
  vals text;
  extra record;
BEGIN
  -- Two jobs rows whatever earlier setups made NOT NULL.
  FOR i IN 1..2 LOOP
    cols := 'id'; vals := quote_literal('7200000' || i || '-0000-4000-8000-000000000001');
    FOR extra IN
      SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS t
      FROM pg_attribute a
      WHERE a.attrelid = 'public.jobs'::regclass AND a.attnum > 0 AND NOT a.attisdropped
        AND a.attnotnull AND NOT a.atthasdef AND a.attname <> 'id' AND a.attgenerated = ''
    LOOP
      cols := cols || ', ' || quote_ident(extra.attname);
      vals := vals || ', ' || CASE
        WHEN extra.attname = 'job_number' THEN quote_literal('T20-FILL-' || i)
        WHEN extra.attname = 'status' THEN quote_literal('order_materials')
        WHEN extra.attname = 'type' THEN quote_literal('fencing')
        WHEN extra.t = 'uuid' THEN quote_literal('00000000-0000-0000-0000-000000000001')
        WHEN extra.t IN ('jsonb', 'json') THEN quote_literal('{}')
        WHEN extra.t = 'boolean' THEN 'false'
        WHEN extra.t LIKE 'timestamp%' THEN quote_literal('2026-11-02T00:00:00Z')
        WHEN extra.t IN ('integer', 'bigint', 'numeric', 'smallint') THEN '0'
        ELSE quote_literal('x')
      END;
    END LOOP;
    EXECUTE format('INSERT INTO public.jobs (%s) VALUES (%s)', cols, vals);
  END LOOP;
END $$;

INSERT INTO public.scope_revisions (id, job_id, revision_number, scope_hash, pricing_hash, status) VALUES
  ('72010000-0000-4000-8000-000000000001', '72000001-0000-4000-8000-000000000001', 1,
   repeat('a', 64), repeat('b', 64), 'frozen');

INSERT INTO public.dispatch_v2_scope_fills (job_id, org_id, auto, lines_added, scope_revision_id) VALUES
  ('72000001-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', true, 2,
   '72010000-0000-4000-8000-000000000001'),
  ('72000002-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', false, 1, NULL);

DO $$
BEGIN
  IF (SELECT scope_revision_id FROM public.dispatch_v2_scope_fills
       WHERE job_id = '72000001-0000-4000-8000-000000000001')
     IS DISTINCT FROM '72010000-0000-4000-8000-000000000001'::uuid THEN
    RAISE EXCEPTION 'scope fill revision contract: the stored revision did not read back';
  END IF;
  IF (SELECT scope_revision_id FROM public.dispatch_v2_scope_fills
       WHERE job_id = '72000002-0000-4000-8000-000000000001') IS NOT NULL THEN
    RAISE EXCEPTION 'scope fill revision contract: a fill with no revision did not stay null';
  END IF;

  BEGIN
    UPDATE public.dispatch_v2_scope_fills SET scope_revision_id = '7201ffff-0000-4000-8000-000000000009'
    WHERE job_id = '72000002-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'scope fill revision contract: a fill naming a missing scope revision was accepted';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;

  BEGIN
    DELETE FROM public.scope_revisions WHERE id = '72010000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'scope fill revision contract: a scope revision a fill names could be deleted';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;
END $$;
ROLLBACK;

-- 3. Re-apply is a no-op: the migration runs again cleanly and leaves one
--    column and one foreign key.
BEGIN;
\ir ../../../migrations/20261102203000_dispatch_v2_scope_fill_revision.sql
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.dispatch_v2_scope_fills'::regclass
        AND conname LIKE 'dispatch_v2_scope_fills_scope_revision_id%') <> 1 THEN
    RAISE EXCEPTION 'scope fill revision contract: re-apply added a second foreign key';
  END IF;
END $$;
ROLLBACK;
