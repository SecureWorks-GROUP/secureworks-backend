-- P2-10.2. A sent Dispatch order shows as committed (or ordered, cost not known)
-- on its job until a counted cost line naming it is allocated to that job. Only
-- the cost-line reader
-- changes; v_job_cost_events still reads legacy until the switch and cutover.
-- No trigger, schedule or switch change on merge: the order trigger is installed
-- by install_dispatch_order_commitment() after proof on a ZZTEST job.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- Built from main's reader (P2-01.7 plus P2-03.1). Every existing arm stays
-- byte-identical: one arm is appended. A purchase order already closes when
-- v_job_orders.matched is true: the job_cost_lines CHECK makes state IS NOT
-- NULL the same test as not_counted_reason IS NULL.
-- c98dd14a: main after P2-03.1 (live read d8ccd9fe was taken before it merged).
-- 799c11c9: this migration's own result, so a re-apply changes nothing.
-- A Dispatch order closes only when a counted line naming it has a nonzero part
-- on the order's own job (the cost the actual arm adds). v_job_orders.matched
-- alone is not enough: a needs_person line matches but puts no cost on the job,
-- and a split that puts 0 on the job adds no cost there either.
-- job_cost_lines_order_idx finds the lines; job_cost_line_parts is read by its
-- (line_id, part_no) unique index.
DO $view$
DECLARE d text;
/* block */ BEGIN
 d:=pg_get_viewdef('public.v_job_cost_events_lines'::regclass,true);
 IF md5(d)='c98dd14a51e982b78493c3385b25c9d9' THEN
  d:=rtrim(rtrim(d),';')||$arm$
 UNION ALL
 SELECT o.job_id,o.sent_on,'materials'::text,'purchase_order'::text,'supplier'::text,
  NULL::text,COALESCE(NULLIF(btrim(o.party_name),''::text),'Unnamed supplier'::text),
  o.cost_ex,
  CASE WHEN o.cost_ex IS NULL THEN 'po_ordered'::text ELSE 'po_committed'::text END,
  o.order_id,o.order_id,NULL::text,'sent'::text,false,NULL::date,
  CASE WHEN o.cost_ex IS NULL THEN 'ordered_not_billed'::text ELSE 'committed'::text END,
  false,NULL::text,NULL::numeric,NULL::text,NULL::text,'dispatch_order.job_id'::text,false,
  NULL::uuid,NULL::text
 FROM public.v_job_orders o
 WHERE o.order_kind='dispatch_order' AND o.job_id IS NOT NULL AND o.job_live
  AND NOT EXISTS(SELECT 1 FROM public.job_cost_lines l
   JOIN public.job_cost_line_parts p ON p.line_id=l.id
   WHERE l.order_kind=o.order_kind AND l.order_id=o.order_id AND l.state IS NOT NULL
    AND p.target='job' AND p.job_id=o.job_id AND p.amount_ex<>0)$arm$;
  EXECUTE 'CREATE OR REPLACE VIEW public.v_job_cost_events_lines AS '||d;
 ELSIF md5(d)<>'799c11c9580df8050043872a43b993c9' THEN
  RAISE EXCEPTION 'P2-10.2: cost line reader pre-image differs';
 END IF;
END $view$;
REVOKE ALL ON public.v_job_cost_events_lines FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.v_job_cost_events_lines TO service_role;

-- Each function is created when absent, left alone when it already holds this
-- body (a re-apply), and refused when it holds any other body.

-- Open bill items of one supplier, for a re-match after its order is sent.
-- reconcile_items_list_idx (status,kind) reads the open bill list; each item's
-- lines come through job_cost_lines_document_idx (document_kind,document_id).
-- Bounded by the open bill list, never by the supplier's whole history.
DO $g$
/* block */ BEGIN
 IF to_regprocedure('public.dispatch_order_rematch_subjects(uuid,text,text)') IS NULL THEN
  EXECUTE $create$CREATE FUNCTION public.dispatch_order_rematch_subjects(p_org_id uuid,p_party_id text,p_name_key text)
RETURNS SETOF text LANGUAGE sql STABLE AS $fn$
 SELECT DISTINCT ri.subject_id
 FROM public.reconcile_items ri
 JOIN public.job_cost_lines l
  ON l.document_kind=split_part(ri.subject_id,':',1)
  AND l.document_id=substr(ri.subject_id,strpos(ri.subject_id,':')+1)
  AND l.org_id=ri.org_id
 WHERE ri.status='open' AND ri.kind='bill' AND ri.subject_table='cost_document'
  AND ri.org_id=p_org_id AND strpos(ri.subject_id,':')>0
  AND ((p_party_id IS NOT NULL AND p_party_id<>'' AND l.party_id=p_party_id)
   OR (p_name_key<>'' AND public.supplier_name_key(l.party_name)=p_name_key))
$fn$$create$;
 ELSIF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.dispatch_order_rematch_subjects(uuid,text,text)'::regprocedure)<>'891a48e6e9f70519c8f327776246575e' THEN
  RAISE EXCEPTION 'P2-10.2: dispatch_order_rematch_subjects pre-image differs';
 END IF;
END $g$;

-- Never waits on a lock and never fails the order write: each step has its
-- own 1ms lock wait and its own exception block, and only warns.
DO $g$
/* block */ BEGIN
 IF to_regprocedure('public.dispatch_order_commitment_trg()') IS NULL THEN
  EXECUTE $create$CREATE FUNCTION public.dispatch_order_commitment_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE prior_timeout text:=current_setting('lock_timeout'); v_party text;
/* block */ BEGIN
 IF TG_OP='UPDATE' AND OLD.status IS NOT DISTINCT FROM NEW.status
  AND OLD.order_cost IS NOT DISTINCT FROM NEW.order_cost THEN RETURN NULL; END IF;
 PERFORM set_config('lock_timeout','1ms',true);
 /* subblock */ BEGIN
  PERFORM public.job_profit_mark(NEW.job_id,'order');
 EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'order profit mark unavailable: %',SQLSTATE;
 END;
 IF NEW.status='sent' AND (TG_OP='INSERT' OR OLD.status IS DISTINCT FROM 'sent') THEN
  /* subblock */ BEGIN
   SELECT s.xero_contact_id INTO v_party FROM public.suppliers s WHERE s.id=NEW.supplier_id;
   INSERT INTO public.match_queue(subject_kind,subject_id,reason)
   SELECT 'cost_document',m.subject_id,'order_sent'
   FROM public.dispatch_order_rematch_subjects(NEW.org_id,v_party,
    coalesce(public.supplier_name_key(NEW.supplier_name),'')) m(subject_id)
   ON CONFLICT (subject_kind,subject_id) DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
   RAISE WARNING 'order re-match queue unavailable: %',SQLSTATE;
  END;
 END IF;
 PERFORM set_config('lock_timeout',prior_timeout,true);
 RETURN NULL;
EXCEPTION WHEN OTHERS THEN
 RAISE WARNING 'order commitment invalidation unavailable: %',SQLSTATE;
 RETURN NULL;
END $fn$$create$;
 ELSIF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.dispatch_order_commitment_trg()'::regprocedure)<>'f47705471224b19d50576d859ea99f72' THEN
  RAISE EXCEPTION 'P2-10.2: dispatch_order_commitment_trg pre-image differs';
 END IF;
END $g$;

DO $g$
/* block */ BEGIN
 IF to_regprocedure('public.install_dispatch_order_commitment()') IS NULL THEN
  EXECUTE $create$CREATE FUNCTION public.install_dispatch_order_commitment() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
/* block */ BEGIN
 DROP TRIGGER IF EXISTS dispatch_order_commitment ON public.dispatch_supplier_order_emails;
 CREATE TRIGGER dispatch_order_commitment
 AFTER INSERT OR UPDATE OF status,order_cost ON public.dispatch_supplier_order_emails
 FOR EACH ROW EXECUTE FUNCTION public.dispatch_order_commitment_trg();
END $fn$$create$;
 ELSIF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.install_dispatch_order_commitment()'::regprocedure)<>'d3d6722d28e811a05c89d6dd57c723b0' THEN
  RAISE EXCEPTION 'P2-10.2: install_dispatch_order_commitment pre-image differs';
 END IF;
END $g$;
DO $g$
/* block */ BEGIN
 IF to_regprocedure('public.remove_dispatch_order_commitment()') IS NULL THEN
  EXECUTE $create$CREATE FUNCTION public.remove_dispatch_order_commitment() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
/* block */ BEGIN
 DROP TRIGGER IF EXISTS dispatch_order_commitment ON public.dispatch_supplier_order_emails;
END $fn$$create$;
 ELSIF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.remove_dispatch_order_commitment()'::regprocedure)<>'d8c52f4c0a4e82417ecd5ecc03143d23' THEN
  RAISE EXCEPTION 'P2-10.2: remove_dispatch_order_commitment pre-image differs';
 END IF;
END $g$;

REVOKE ALL ON FUNCTION public.dispatch_order_rematch_subjects(uuid,text,text),
 public.dispatch_order_commitment_trg(),public.install_dispatch_order_commitment(),
 public.remove_dispatch_order_commitment() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_order_rematch_subjects(uuid,text,text),
 public.dispatch_order_commitment_trg(),public.install_dispatch_order_commitment(),
 public.remove_dispatch_order_commitment() TO service_role;
