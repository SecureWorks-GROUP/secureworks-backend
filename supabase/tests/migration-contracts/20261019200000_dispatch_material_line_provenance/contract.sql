-- Contract: 20261019200000_dispatch_material_line_provenance. Four nullable columns, a wider
-- source list, the kind and shape checks, one source line once per job and revision, existing
-- lines untouched, and a down migration that refuses while any line has recorded provenance.
\set ON_ERROR_STOP on
CREATE OR REPLACE FUNCTION pg_temp.mp_assert(ok boolean, message text) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN IF NOT coalesce(ok, false) THEN
 RAISE EXCEPTION 'material line provenance contract: %', message; END IF; END $$;

-- The SQLSTATE an insert answers, or 'ok'.
CREATE OR REPLACE FUNCTION pg_temp.mp_try(p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
BEGIN
 EXECUTE p_sql;
 RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
 RETURN SQLSTATE;
END $$;

SELECT pg_temp.mp_assert((SELECT count(*) FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'job_material_lines' AND is_nullable = 'YES'
    AND column_default IS NULL
    AND (column_name, data_type) IN (('source_kind', 'text'), ('source_version_id', 'uuid'),
                                     ('source_version', 'text'), ('source_line_id', 'text'))) = 4,
 'job_material_lines must carry the four nullable provenance columns with no default');
SELECT pg_temp.mp_assert((SELECT count(*) FROM pg_constraint
  WHERE conrelid = 'public.job_material_lines'::regclass
    AND conname IN ('job_material_lines_source_valid', 'job_material_lines_source_kind_valid',
                    'job_material_lines_source_shape')) = 3,
 'the source, kind and shape checks must exist');
SELECT pg_temp.mp_assert((SELECT indisunique AND pg_get_expr(indpred, indrelid) LIKE '%source_line_id IS NOT NULL%'
  FROM pg_index WHERE indexrelid = 'public.job_material_lines_source_line_once'::regclass),
 'job_material_lines_source_line_once must be a partial unique index on a recorded line');

BEGIN;
INSERT INTO public.jobs (id, org_id, status, type)
VALUES ('9f000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000001', 'accepted', 'fencing');
INSERT INTO public.suppliers (id, name) VALUES ('9f100000-0000-4000-8000-000000000001', 'Example Steel');
INSERT INTO public.job_material_suppliers (org_id, job_id, supplier_id, supplier_name, position)
VALUES ('00000000-0000-0000-0000-000000000001', '9f000000-0000-4000-8000-000000000001',
        '9f100000-0000-4000-8000-000000000001', 'Example Steel', 1);

CREATE TEMP TABLE mp_case (name text, expect text, statement text);
INSERT INTO mp_case (name, expect, statement)
SELECT name, expect, format(
 'INSERT INTO public.job_material_lines (id, org_id, job_id, supplier_id, description, position, source, source_kind, source_version_id, source_version, source_line_id) VALUES (gen_random_uuid(), %L, %L, %L, %L, 1, %L, %L, %L, %L, %L)',
 '00000000-0000-0000-0000-000000000001', '9f000000-0000-4000-8000-000000000001',
 '9f100000-0000-4000-8000-000000000001', name, source, kind, version_id, version, line_id)
FROM (VALUES
 -- name, expect, source, kind, version_id, version, line_id
 ('manual plain', 'ok', 'manual', NULL, NULL, NULL, NULL),
 ('manual with a kind', '23514', 'manual', 'fence_scope_revision', '9f200000-0000-4000-8000-000000000001', '3', NULL),
 ('scope taken before the migration', 'ok', 'scope', NULL, NULL, NULL, NULL),
 ('scope fence recorded', 'ok', 'scope', 'fence_scope_revision', '9f200000-0000-4000-8000-000000000001', '3', 'm:kit|panels'),
 ('scope fence same material again', '23505', 'scope', 'fence_scope_revision', '9f200000-0000-4000-8000-000000000001', '3', 'm:kit|panels'),
 ('scope same material, later revision', 'ok', 'scope', 'fence_scope_revision', '9f200000-0000-4000-8000-000000000002', '5', 'm:kit|panels'),
 ('scope patio recorded', 'ok', 'scope', 'patio_scope_revision', '9f200000-0000-4000-8000-000000000003', '1', 'm:posts|'),
 ('scope naming a quote builder version', '23514', 'scope', 'quote_builder_version', '9f200000-0000-4000-8000-000000000004', '1', 'x'),
 ('quote builder recorded', 'ok', 'quote_builder', 'quote_builder_version', '9f200000-0000-4000-8000-000000000004', '1', 'x'),
 ('quote builder with no line', '23514', 'quote_builder', 'quote_builder_version', '9f200000-0000-4000-8000-000000000004', '1', NULL),
 ('quote builder with no kind', '23514', 'quote_builder', NULL, NULL, NULL, NULL),
 ('a kind with no revision', '23514', 'scope', 'fence_scope_revision', NULL, NULL, NULL),
 ('a revision with no kind', '23514', 'scope', NULL, '9f200000-0000-4000-8000-000000000001', NULL, NULL),
 ('an empty line id', '23514', 'scope', 'fence_scope_revision', '9f200000-0000-4000-8000-000000000001', '3', ''),
 ('a 101 character line id', '23514', 'scope', 'fence_scope_revision', '9f200000-0000-4000-8000-000000000001', '3', repeat('x', 101)),
 ('a 100 character line id', 'ok', 'scope', 'fence_scope_revision', '9f200000-0000-4000-8000-000000000001', '3', repeat('x', 100)),
 ('a 51 character version', '23514', 'scope', 'fence_scope_revision', '9f200000-0000-4000-8000-000000000001', repeat('9', 51), NULL),
 ('an unknown kind', '23514', 'scope', 'other', '9f200000-0000-4000-8000-000000000001', '3', NULL),
 ('an unknown source', '23514', 'variation', NULL, NULL, NULL, NULL)
) AS c(name, expect, source, kind, version_id, version, line_id);

DO $$
DECLARE c record; got text;
BEGIN
 FOR c IN SELECT * FROM mp_case LOOP
  got := pg_temp.mp_try(c.statement);
  PERFORM pg_temp.mp_assert(got = c.expect, format('%s: expected %s, got %s', c.name, c.expect, got));
 END LOOP;
END $$;

-- The down migration refuses while a line has recorded provenance, and changes nothing.
SAVEPOINT before_down;
\set ON_ERROR_STOP off
\ir ../../../rollbacks/20261019200000_dispatch_material_line_provenance_down.sql
\set down_failed :ERROR
\set ON_ERROR_STOP on
ROLLBACK TO SAVEPOINT before_down;
SELECT pg_temp.mp_assert(:'down_failed' = 'true',
 'the down migration must refuse while a line has recorded provenance');
SELECT pg_temp.mp_assert((SELECT count(*) FROM public.job_material_lines
  WHERE job_id = '9f000000-0000-4000-8000-000000000001' AND source_kind IS NOT NULL) = 5,
 'the refused down migration must leave every recorded line in place');
ROLLBACK;
