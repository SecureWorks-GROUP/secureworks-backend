-- P2-13.2. Only the director's install connects the measurement to a refresh.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';


DO $guard$
/* block */ BEGIN
  IF EXISTS (
    SELECT FROM (VALUES
    ('public.job_cost_part_proven(uuid,integer,uuid)','a5f3149a42478f7f4c8b167b715ff85c'),
    ('public.job_cost_proven_share(uuid[])','317bbcbdc920b45a9752ba25d07d413f'),
    ('public.job_profit_store_proven_share(uuid[])','72a8fbd89744351d172f7552d2bc7d3f'),
    ('public.job_profit_reconcile_item_changed()','f0b068100821cb547fe836fd58ead5f5'),
    ('public.job_profit_configure_proven_share(boolean)','1dfc3c18a1810918ec9c656499b56024'),
    ('public.job_profit_install_proven_share()','f92a95200b9b19cfa85247891099d603'),
    ('public.job_profit_remove_proven_share()','52226c9691e9b83dc07bcef219bc892f')
    ) expected(sig,digest) JOIN pg_proc p ON p.oid=to_regprocedure(expected.sig)
    WHERE md5(p.prosrc)<>expected.digest
  ) THEN RAISE EXCEPTION 'job_profit_share_object_drift'; END IF;
END $guard$;

ALTER TABLE public.job_profit_stored
  ADD COLUMN IF NOT EXISTS cost_proven_ex numeric(12,2),
  ADD COLUMN IF NOT EXISTS cost_on_clues_ex numeric(12,2),
  ADD COLUMN IF NOT EXISTS cost_unknown_ex numeric(12,2),
  ADD COLUMN IF NOT EXISTS cost_unknown_items integer,
  ADD COLUMN IF NOT EXISTS proven_share_pct numeric(5,2),
  ADD COLUMN IF NOT EXISTS proven_share_reason text;

INSERT INTO public.reconcile_item_kinds(kind,tab,words,card)
VALUES ('job_cost_share','other','Check the job cost share','generic')
ON CONFLICT (kind) DO NOTHING;

-- Follow each allocated part back to its placement. A document credit can
-- inherit different decisions on different parts, including on the same job.
CREATE OR REPLACE FUNCTION public.job_cost_part_proven(p_line uuid, p_part integer, p_job uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $f$
DECLARE
  l public.job_cost_lines%ROWTYPE;
  seen uuid[] := '{}';
  parent record;
/* block */ BEGIN
  LOOP
    IF p_line = ANY(seen) THEN RETURN false; END IF;
    SELECT * INTO STRICT l FROM public.job_cost_lines WHERE id=p_line;
    IF l.state IS NULL OR l.state='needs_person' THEN RETURN false; END IF;
    IF l.decided_by_kind='person' THEN RETURN true; END IF;
    IF l.follows_line_id IS NULL AND l.follows_document_id IS NULL THEN
      IF l.decided_by_kind='matcher' THEN
        RETURN EXISTS (
          SELECT FROM public.reconcile_decisions d
          WHERE d.id=l.decision_id AND d.org_id=l.org_id
            AND d.subject_kind='cost_document' AND d.subject_id=l.document_kind||':'||l.document_id
            AND cardinality(d.clue_ids)=2
            AND (SELECT count(*) FROM public.match_clues c
                 WHERE c.id=ANY(d.clue_ids) AND c.class='key' AND c.org_id=d.org_id
                   AND c.subject_kind=d.subject_kind AND c.subject_id=d.subject_id
                   AND c.outcome='job' AND c.job_id=p_job)=2
        );
      END IF;
      RETURN l.decided_by_kind IS NOT DISTINCT FROM 'source' AND l.document_kind='trade_invoice';
    END IF;
    seen:=array_append(seen,l.id);
    IF l.follows_line_id IS NOT NULL THEN
      SELECT p.line_id,p.part_no,p.job_id INTO parent
        FROM public.job_cost_line_parts p JOIN public.job_cost_lines s ON s.id=p.line_id
        WHERE p.line_id=l.follows_line_id AND p.part_no=p_part AND s.org_id=l.org_id;
    ELSE
      -- Same ordering used by job_cost_lines_refollow when it writes the parts.
      SELECT p.line_id,p.part_no,p.job_id INTO parent
        FROM public.job_cost_lines s JOIN public.job_cost_line_parts p ON p.line_id=s.id
        WHERE s.org_id=l.org_id AND s.document_kind=l.follows_document_kind
          AND s.document_id=l.follows_document_id AND s.not_counted_reason IS DISTINCT FROM 'line_removed'
        ORDER BY s.line_no,s.line_key COLLATE "C",p.part_no OFFSET (p_part-1) LIMIT 1;
    END IF;
    IF NOT FOUND OR parent.job_id IS DISTINCT FROM p_job THEN RETURN false; END IF;
    p_line:=parent.line_id;
    p_part:=parent.part_no;
  END LOOP;
END $f$;

CREATE OR REPLACE FUNCTION public.job_cost_proven_share(p_job_ids uuid[])
RETURNS TABLE(job_id uuid,cost_proven_ex numeric,cost_on_clues_ex numeric,
              cost_unknown_ex numeric,cost_unknown_items integer,proven_share_pct numeric,
              proven_share_reason text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $f$
WITH requested AS MATERIALIZED (
  SELECT j.id,j.org_id FROM public.jobs j WHERE j.id=ANY(p_job_ids)
), parts AS MATERIALIZED (
  SELECT p.job_id,p.amount_ex,public.job_cost_part_proven(l.id,p.part_no,p.job_id) AS proven
  FROM requested r JOIN public.job_cost_line_parts p ON p.job_id=r.id
  JOIN public.job_cost_lines l ON l.id=p.line_id
  WHERE l.org_id=r.org_id AND p.target='job' AND l.state IN ('on_job','split') AND l.is_actual
), placed AS (
  SELECT p.job_id,sum(p.amount_ex) FILTER (WHERE p.proven) AS proven,
         sum(p.amount_ex) FILTER (WHERE NOT p.proven) AS clues
  FROM parts p GROUP BY p.job_id
), items AS MATERIALIZED (
  SELECT r.id AS job,i.id AS item,i.org_id,
         split_part(i.subject_id,':',1) AS kind,
         substr(i.subject_id,strpos(i.subject_id,':')+1) AS doc
  FROM requested r JOIN public.reconcile_items i ON i.job_ids @> ARRAY[r.id]
  WHERE i.org_id=r.org_id AND i.status='open' AND i.subject_table='cost_document' AND strpos(i.subject_id,':')>1
), pending AS MATERIALIZED (
  SELECT i.job,i.item,l.id,l.amount_ex
  FROM items i JOIN public.job_cost_lines l
    ON l.org_id=i.org_id AND l.document_kind=i.kind AND l.document_id=i.doc
  WHERE l.state='needs_person' AND l.is_actual
), pending_items AS (
  SELECT job,count(DISTINCT item)::integer AS n FROM pending GROUP BY job
), pending_amounts AS (
  -- Two open review kinds on the same document are two items but one cost.
  SELECT job,sum(amount_ex) AS amount,bool_and(amount_ex IS NOT NULL) AS complete
  FROM (SELECT DISTINCT job,id,amount_ex FROM pending) lines GROUP BY job
), costs AS (
  SELECT r.id,coalesce(p.proven,0) AS proven,coalesce(p.clues,0) AS clues,
         CASE WHEN i.n IS NULL THEN 0 ELSE a.amount END AS pending,coalesce(i.n,0) AS n,
         coalesce(a.complete,true) AS complete
  FROM requested r LEFT JOIN placed p ON p.job_id=r.id
  LEFT JOIN pending_items i ON i.job=r.id LEFT JOIN pending_amounts a ON a.job=r.id
), totals AS (
  SELECT c.*,c.proven+c.clues+c.pending AS total FROM costs c
)
SELECT id,proven,clues,pending,n,
       CASE WHEN complete AND total>0 AND proven BETWEEN 0 AND total
            THEN round(proven*100/total,2) END,
       CASE WHEN complete AND (total<=0 OR proven<0 OR proven>total) THEN 'share_unknown_credit_open'
            WHEN NOT complete THEN 'share_amount_unknown' END
FROM totals
$f$;

CREATE OR REPLACE FUNCTION public.job_profit_store_proven_share(p_job_ids uuid[])
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $f$
DECLARE row_to_review record;
/* block */ BEGIN
  FOR row_to_review IN
    WITH stored AS (
      UPDATE public.job_profit_stored s SET
        (cost_proven_ex,cost_on_clues_ex,cost_unknown_ex,cost_unknown_items,proven_share_pct,proven_share_reason)=
        (p.cost_proven_ex,p.cost_on_clues_ex,p.cost_unknown_ex,p.cost_unknown_items,p.proven_share_pct,p.proven_share_reason)
      FROM public.job_cost_proven_share(p_job_ids) p WHERE s.job_id=p.job_id
      RETURNING s.job_id,s.proven_share_reason,
        md5(ROW(s.cost_proven_ex,s.cost_on_clues_ex,s.cost_unknown_ex,s.cost_unknown_items)::text) AS facts
    )
    SELECT s.* FROM stored s WHERE s.proven_share_reason='share_unknown_credit_open'
      OR EXISTS (SELECT FROM public.reconcile_items i WHERE i.kind='job_cost_share'
                 AND i.subject_table='jobs' AND i.subject_id=s.job_id::text AND i.status='open')
    ORDER BY s.job_id
  LOOP
    IF row_to_review.proven_share_reason='share_unknown_credit_open' THEN
      PERFORM public.reconcile_item_raise('job_cost_share','jobs',row_to_review.job_id::text,
        ARRAY[row_to_review.job_id],NULL,jsonb_build_object('reason','share_unknown_credit_open',
        'facts_hash',row_to_review.facts),'job_profit');
    ELSE
      PERFORM public.reconcile_item_withdraw('job_cost_share','jobs',row_to_review.job_id::text,'share_recomputed');
    END IF;
  END LOOP;
END $f$;

CREATE OR REPLACE FUNCTION public.job_profit_reconcile_item_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='25ms' AS $f$
DECLARE job uuid;
/* block */ BEGIN
  IF NOT EXISTS (SELECT FROM public.feature_flags WHERE flag_name='job_profit_refresh_v1' AND enabled) THEN
    RETURN NULL;
  END IF;
  FOR job IN
    SELECT DISTINCT j FROM unnest(
      (CASE WHEN TG_OP<>'INSERT' THEN OLD.job_ids ELSE '{}'::uuid[] END) ||
      (CASE WHEN TG_OP<>'DELETE' THEN NEW.job_ids ELSE '{}'::uuid[] END)) j
    WHERE j IS NOT NULL ORDER BY j
  LOOP
    PERFORM public.job_profit_mark(job,'reconcile_item');
  END LOOP;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'job_profit_reconcile_mark_failed code=%',SQLSTATE;
  RETURN NULL;
END $f$;


-- Director install and removal. Copy main's definitions at install, splicing
-- one step into each after checking their exact bodies. The normal refresh
-- still compares the complete stored row and honours no-page-mark.
CREATE OR REPLACE FUNCTION public.job_profit_configure_proven_share(p_install boolean)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path='' SET lock_timeout='5s' AS $f$
DECLARE
  spec record;
  original text;
  installed text;
  definition text;
  actual text;
/* block */ BEGIN
  PERFORM pg_advisory_xact_lock(20261118,132);
  FOR spec IN SELECT * FROM (VALUES
    ('public.job_profit_refresh_many(uuid[])'::regprocedure,'5bf1ad820296062f851290ae4d750426','cbbcdf64bb4417db320e0ee2327e21d9',$anchor$ -- Compare both sides, including a job that disappeared from the checking view.$anchor$,$step$ PERFORM public.job_profit_store_proven_share(v_ids);
$step$),
    ('public.job_profit_mark(uuid,text)'::regprocedure,'3f3c3d56c36b1721a3c7f808ccfac958','66a531d15d49e0c05c3b5e92c75397f7',$anchor$ INSERT INTO public.job_profit_dirty$anchor$,$step$ -- This source may run inside a Reconcile write. The existing bounded worker
 -- folds the new event; dirty-row locks belong to that worker alone.
 IF p_reason='reconcile_item' THEN
  INSERT INTO public.job_profit_change_events(job_id,reason) VALUES(p_job_id,p_reason);
  RETURN;
 END IF;
$step$)
  ) AS entries(proc,prior_hash,installed_hash,anchor,step)
  LOOP
    SELECT md5(prosrc),pg_get_functiondef(oid) INTO STRICT actual,definition
    FROM pg_catalog.pg_proc WHERE oid=spec.proc;
    IF actual NOT IN (spec.prior_hash,spec.installed_hash) THEN
      RAISE EXCEPTION 'job_profit_share_preimage_mismatch' USING DETAIL=spec.proc::text;
    END IF;
    IF (p_install AND actual=spec.prior_hash) OR (NOT p_install AND actual=spec.installed_hash) THEN
      original:=spec.anchor;
      installed:=spec.step||spec.anchor;
      EXECUTE CASE WHEN p_install THEN replace(definition,original,installed)
                   ELSE replace(definition,installed,original) END;
      IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=spec.proc) <>
        (CASE WHEN p_install THEN spec.installed_hash ELSE spec.prior_hash END) THEN
        RAISE EXCEPTION 'job_profit_share_definition_mismatch';
      END IF;
    END IF;
  END LOOP;
  DROP TRIGGER IF EXISTS job_profit_reconcile_item_changed ON public.reconcile_items;
  IF p_install THEN
    CREATE TRIGGER job_profit_reconcile_item_changed AFTER INSERT OR UPDATE OR DELETE ON public.reconcile_items
      FOR EACH ROW EXECUTE FUNCTION public.job_profit_reconcile_item_changed();
  END IF;
END $f$;

CREATE OR REPLACE FUNCTION public.job_profit_install_proven_share() RETURNS void
LANGUAGE sql SECURITY INVOKER SET search_path='' AS $f$
SELECT public.job_profit_configure_proven_share(true)
$f$;
CREATE OR REPLACE FUNCTION public.job_profit_remove_proven_share() RETURNS void
LANGUAGE sql SECURITY INVOKER SET search_path='' AS $f$
SELECT public.job_profit_configure_proven_share(false)
$f$;

REVOKE ALL ON FUNCTION
  public.job_cost_part_proven(uuid,integer,uuid),
  public.job_cost_proven_share(uuid[]),
  public.job_profit_store_proven_share(uuid[]),
  public.job_profit_reconcile_item_changed(),
  public.job_profit_configure_proven_share(boolean),
  public.job_profit_install_proven_share(),
  public.job_profit_remove_proven_share()
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.job_cost_proven_share(uuid[]) TO service_role;
