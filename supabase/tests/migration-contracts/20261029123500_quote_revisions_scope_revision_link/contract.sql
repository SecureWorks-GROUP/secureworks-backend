-- Contract for 20261029123500_quote_revisions_scope_revision_link.sql (JP-24 slice 1).
-- Fixture writes roll back.

-- 1. The column: uuid, nullable, no default, a foreign key to scope_revisions(id)
--    with ON DELETE RESTRICT, and no column-level grant or policy.
DO $$
DECLARE
  col record;
  fk record;
BEGIN
  SELECT a.atttypid::regtype::text AS type, a.attnotnull, a.atthasdef, a.attacl
    INTO col
  FROM pg_attribute a
  WHERE a.attrelid = 'public.quote_revisions'::regclass
    AND a.attname = 'scope_revision_id' AND NOT a.attisdropped;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'scope revision link contract: quote_revisions.scope_revision_id is missing';
  END IF;
  IF col.type <> 'uuid' THEN
    RAISE EXCEPTION 'scope revision link contract: scope_revision_id is %, not uuid', col.type;
  END IF;
  IF col.attnotnull THEN
    RAISE EXCEPTION 'scope revision link contract: scope_revision_id must be nullable (null = unknown)';
  END IF;
  IF col.atthasdef THEN
    RAISE EXCEPTION 'scope revision link contract: scope_revision_id must have no default';
  END IF;
  IF col.attacl IS NOT NULL THEN
    RAISE EXCEPTION 'scope revision link contract: scope_revision_id carries a column-level grant';
  END IF;

  SELECT c.confrelid::regclass::text AS target, c.confdeltype,
         (SELECT array_agg(att.attname ORDER BY att.attname) FROM pg_attribute att
           WHERE att.attrelid = c.confrelid AND att.attnum = ANY (c.confkey)) AS target_cols,
         (SELECT array_agg(att.attname ORDER BY att.attname) FROM pg_attribute att
           WHERE att.attrelid = c.conrelid AND att.attnum = ANY (c.conkey)) AS own_cols
    INTO fk
  FROM pg_constraint c
  WHERE c.conname = 'quote_revisions_scope_revision_id_fkey'
    AND c.conrelid = 'public.quote_revisions'::regclass
    AND c.contype = 'f';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'scope revision link contract: the scope_revisions foreign key is missing';
  END IF;
  IF fk.target <> 'scope_revisions' OR fk.target_cols <> ARRAY['id']::name[] OR fk.own_cols <> ARRAY['scope_revision_id']::name[] THEN
    RAISE EXCEPTION 'scope revision link contract: the foreign key is % % -> %, not scope_revision_id -> scope_revisions(id)',
      fk.own_cols, fk.target, fk.target_cols;
  END IF;
  IF fk.confdeltype <> 'r' THEN
    RAISE EXCEPTION 'scope revision link contract: the foreign key must be ON DELETE RESTRICT, got %', fk.confdeltype;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'quote_revisions') THEN
    RAISE EXCEPTION 'scope revision link contract: a policy exists on quote_revisions (it is service role only)';
  END IF;
END $$;

-- 2. Behaviour: a link to a real scope revision and a null are accepted; a link
--    to a revision that does not exist is refused.
BEGIN;
DO $$
DECLARE
  cols text;
  vals text;
  extra record;
BEGIN
  -- Build one jobs row whatever earlier setups made NOT NULL.
  cols := 'id'; vals := quote_literal('51e00000-0000-4000-8000-000000000001');
  FOR extra IN
    SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS t
    FROM pg_attribute a
    WHERE a.attrelid = 'public.jobs'::regclass AND a.attnum > 0 AND NOT a.attisdropped
      AND a.attnotnull AND NOT a.atthasdef AND a.attname <> 'id' AND a.attgenerated = ''
  LOOP
    cols := cols || ', ' || quote_ident(extra.attname);
    vals := vals || ', ' || CASE
      WHEN extra.attname = 'job_number' THEN quote_literal('JP24-SLICE1')
      WHEN extra.attname = 'status' THEN quote_literal('quoted')
      WHEN extra.attname = 'type' THEN quote_literal('patio')
      WHEN extra.t = 'uuid' THEN quote_literal('00000000-0000-0000-0000-000000000001')
      WHEN extra.t IN ('jsonb', 'json') THEN quote_literal('{}')
      WHEN extra.t = 'boolean' THEN 'false'
      WHEN extra.t LIKE 'timestamp%' THEN quote_literal('2026-10-29T00:00:00Z')
      WHEN extra.t IN ('integer', 'bigint', 'numeric', 'smallint') THEN '0'
      ELSE quote_literal('x')
    END;
  END LOOP;
  EXECUTE format('INSERT INTO public.jobs (%s) VALUES (%s)', cols, vals);
END $$;

INSERT INTO public.scope_revisions (id, job_id, revision_number, scope_hash, pricing_hash, status) VALUES
  ('51e10000-0000-4000-8000-000000000001', '51e00000-0000-4000-8000-000000000001', 1,
   repeat('a', 64), repeat('b', 64), 'frozen');

DO $$
DECLARE
  cols text;
  vals text;
  extra record;
  linked uuid;
BEGIN
  -- A quote_revisions row whatever earlier setups made NOT NULL, built twice:
  -- once naming the real revision, once with a null link.
  FOR i IN 1..2 LOOP
    cols := 'id, job_id, version, scope_revision_id';
    vals := quote_literal('51e20000-0000-4000-8000-00000000000' || i) || ', '
         || quote_literal('51e00000-0000-4000-8000-000000000001') || ', ' || i || ', '
         || CASE WHEN i = 1 THEN quote_literal('51e10000-0000-4000-8000-000000000001') ELSE 'NULL' END;
    FOR extra IN
      SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS t
      FROM pg_attribute a
      WHERE a.attrelid = 'public.quote_revisions'::regclass AND a.attnum > 0 AND NOT a.attisdropped
        AND a.attnotnull AND NOT a.atthasdef AND a.attgenerated = ''
        AND a.attname NOT IN ('id', 'job_id', 'version', 'scope_revision_id')
    LOOP
      cols := cols || ', ' || quote_ident(extra.attname);
      vals := vals || ', ' || CASE
        WHEN extra.attname = 'released_via' THEN quote_literal('send-quote/send')
        WHEN extra.t IN ('jsonb', 'json') THEN quote_literal('{}')
        WHEN extra.t = 'uuid' THEN quote_literal('00000000-0000-0000-0000-000000000001')
        WHEN extra.t = 'boolean' THEN 'false'
        WHEN extra.t LIKE 'timestamp%' THEN quote_literal('2026-10-29T00:00:00Z')
        WHEN extra.t IN ('integer', 'bigint', 'numeric', 'smallint') THEN '0'
        ELSE quote_literal('x')
      END;
    END LOOP;
    EXECUTE format('INSERT INTO public.quote_revisions (%s) VALUES (%s)', cols, vals);
  END LOOP;

  SELECT scope_revision_id INTO linked FROM public.quote_revisions WHERE id = '51e20000-0000-4000-8000-000000000001';
  IF linked IS DISTINCT FROM '51e10000-0000-4000-8000-000000000001'::uuid THEN
    RAISE EXCEPTION 'scope revision link contract: the stored link did not read back';
  END IF;
  IF (SELECT scope_revision_id FROM public.quote_revisions WHERE id = '51e20000-0000-4000-8000-000000000002') IS NOT NULL THEN
    RAISE EXCEPTION 'scope revision link contract: a null link did not stay null';
  END IF;

  BEGIN
    UPDATE public.quote_revisions SET scope_revision_id = '51e1ffff-0000-4000-8000-000000000009'
    WHERE id = '51e20000-0000-4000-8000-000000000002';
    RAISE EXCEPTION 'scope revision link contract: a link to a missing scope revision was accepted';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;

  -- A linked scope revision cannot be deleted out from under the send.
  BEGIN
    DELETE FROM public.scope_revisions WHERE id = '51e10000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'scope revision link contract: a linked scope revision could be deleted';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;
END $$;
ROLLBACK;

-- 3. Re-apply is a no-op: the migration runs again cleanly and leaves one
--    column and one foreign key.
BEGIN;
\ir ../../../migrations/20261029123500_quote_revisions_scope_revision_link.sql
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.quote_revisions'::regclass
        AND conname LIKE 'quote_revisions_scope_revision_id%') <> 1 THEN
    RAISE EXCEPTION 'scope revision link contract: re-apply added a second foreign key';
  END IF;
END $$;
ROLLBACK;
