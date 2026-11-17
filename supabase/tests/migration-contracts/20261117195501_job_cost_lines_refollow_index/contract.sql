BEGIN;
-- All figures and identities are synthetic. The test runs the real state writer.
INSERT INTO public.job_cost_lines
  (id,org_id,document_kind,document_id,line_key,line_no,kind,lane,amount_ex,state,
   not_counted_reason,decided_by_kind,source_hash)
SELECT ('90000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  CASE WHEN n=4 THEN '90000000-0000-4000-8001-000000000002'::uuid
    ELSE '90000000-0000-4000-8001-000000000001'::uuid END,
  'xero_bill', CASE WHEN n IN (1,2,4) THEN 'ZZTEST-FU11-parent' ELSE 'ZZTEST-FU11-other' END,
  n::text,n,'supplier_bill','materials',CASE WHEN n=1 THEN 3 ELSE 1 END,
  CASE WHEN n=2 THEN NULL ELSE 'overhead' END,
  CASE WHEN n=2 THEN 'line_removed' ELSE NULL END,'source','ZZTEST-FU11'
FROM generate_series(1,4) n;
INSERT INTO public.job_cost_line_parts(line_id,part_no,target,lane,amount_ex)
SELECT id,1,'overhead','materials',amount_ex FROM public.job_cost_lines
WHERE source_hash='ZZTEST-FU11' AND state='overhead';

INSERT INTO public.job_cost_lines
  (id,org_id,document_kind,document_id,line_key,line_no,kind,lane,amount_ex,state,
   not_counted_reason,decided_by_kind,source_hash,follows_line_id,follows_document_kind,follows_document_id)
SELECT ('90000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  '90000000-0000-4000-8001-000000000001'::uuid,
  'xero_credit_note','ZZTEST-FU11-follower-'||n,'1',1,'supplier_credit','materials',-1,
  CASE WHEN n=15 THEN NULL ELSE 'needs_person' END,
  CASE WHEN n=15 THEN 'document_not_live' ELSE NULL END,
  CASE WHEN n=14 THEN 'person' ELSE 'source' END,'ZZTEST-FU11',
  CASE WHEN n=11 THEN NULL
    WHEN n=13 THEN '90000000-0000-4000-8000-000000000003'::uuid
    WHEN n=16 THEN '90000000-0000-4000-8000-000000000004'::uuid
    ELSE '90000000-0000-4000-8000-000000000001'::uuid END,
  CASE WHEN n IN (11,12,13) THEN 'xero_bill' ELSE NULL END,
  CASE WHEN n IN (11,12,13) THEN 'ZZTEST-FU11-parent' ELSE NULL END
FROM generate_series(10,16) n;
-- Record updates, so baseline parity also asserts the row-processing order.
CREATE TEMP TABLE fu11_updates(seq bigserial, line_id uuid);
CREATE FUNCTION pg_temp.fu11_record_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  INSERT INTO fu11_updates(line_id) VALUES(NEW.id); RETURN NEW;
END $$;
CREATE TRIGGER fu11_update AFTER UPDATE ON public.job_cost_lines
  FOR EACH ROW EXECUTE FUNCTION pg_temp.fu11_record_update();
CREATE TEMP TABLE fu11_before AS SELECT * FROM public.job_cost_lines WHERE source_hash='ZZTEST-FU11';
CREATE TEMP TABLE fu11_before_parts AS SELECT p.* FROM public.job_cost_line_parts p
  JOIN fu11_before l ON l.id=p.line_id;
CREATE TEMP TABLE fu11_expected(result int, lines jsonb, parts jsonb, order_ids uuid[]);
DO $$ DECLARE result int; BEGIN
  result := fu11_proof.previous_refollow('xero_bill','ZZTEST-FU11-parent');
  INSERT INTO fu11_expected SELECT result,
    (SELECT jsonb_agg(to_jsonb(l)-'updated_at'-'state_changed_at' ORDER BY id)
      FROM public.job_cost_lines l WHERE source_hash='ZZTEST-FU11'),
    (SELECT jsonb_agg(to_jsonb(p)-'id' ORDER BY line_id,part_no) FROM public.job_cost_line_parts p
      WHERE line_id IN (SELECT id FROM fu11_before)),
    (SELECT array_agg(line_id ORDER BY seq) FROM fu11_updates);
END $$;
-- Restore the fixture without changing its identity, then run the new function.
DELETE FROM public.job_cost_line_parts WHERE line_id IN (SELECT id FROM fu11_before);
DELETE FROM public.job_cost_lines WHERE id IN (SELECT id FROM fu11_before WHERE document_kind='xero_credit_note');
DELETE FROM public.job_cost_lines WHERE id IN (SELECT id FROM fu11_before);
INSERT INTO public.job_cost_lines SELECT * FROM fu11_before;
INSERT INTO public.job_cost_line_parts SELECT * FROM fu11_before_parts;
TRUNCATE fu11_updates;
DO $$ DECLARE result int; e record; lines jsonb; parts jsonb; order_ids uuid[]; BEGIN
  result := public.job_cost_lines_refollow('xero_bill','ZZTEST-FU11-parent');
  SELECT * INTO STRICT e FROM fu11_expected;
  SELECT jsonb_agg(to_jsonb(l)-'updated_at'-'state_changed_at' ORDER BY id) INTO lines
    FROM public.job_cost_lines l WHERE source_hash='ZZTEST-FU11';
  SELECT jsonb_agg(to_jsonb(p)-'id' ORDER BY line_id,part_no) INTO parts FROM public.job_cost_line_parts p
    WHERE line_id IN (SELECT id FROM fu11_before);
  SELECT array_agg(line_id ORDER BY seq) INTO order_ids FROM fu11_updates;
  IF result <> 4 OR result IS DISTINCT FROM e.result OR lines IS DISTINCT FROM e.lines
    OR parts IS DISTINCT FROM e.parts OR order_ids IS DISTINCT FROM e.order_ids THEN
    RAISE EXCEPTION 'FU11: refollow outcomes or processing order differ from main';
  END IF;
  IF public.job_cost_lines_refollow('xero_bill','ZZTEST-FU11-parent') <> 0 THEN
    RAISE EXCEPTION 'FU11: identical refollow rewrote parts';
  END IF;
  IF has_function_privilege('anon','public.job_cost_lines_refollow(text,text)','EXECUTE')
    OR has_function_privilege('authenticated','public.job_cost_lines_refollow(text,text)','EXECUTE') THEN
    RAISE EXCEPTION 'FU11: browser privileges widened';
  END IF;
END $$;
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;

\ir explain.sql

-- Re-application is safe and preserves the existing function's access rights.
BEGIN;
\ir ../../../migrations/20261117195501_job_cost_lines_refollow_index.sql
\ir ../../../migrations/20261117195501_job_cost_lines_refollow_index.sql
ROLLBACK;
