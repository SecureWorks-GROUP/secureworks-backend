-- Xero evidence (gap plan B-4, 5 Oct 2026): every live job carries its
-- invoices' raised, authorised and paid evidence; an invoice evidence row sits
-- on the invoice's own job, or on the one job its reference names uniquely;
-- and one paid event counts once per invoice.
--
-- Why. The scorecard's Xero and quotes lane (row 3) read 82.0% on a job over
-- 30 days after the L1e relink. What stays off a job is evidence about an
-- invoice: the payment trigger's invoice.paid row for an invoice with no job
-- (xero_invoices.job_id null, about 142 live, mostly SES cards the money seal
-- will not link), and rows about an invoice that has a job but whose writer
-- named none (ops-api invoice.voided, invoice.deleted and
-- invoice.manually_marked_paid; xero-sync invoice.auto_linked by contact
-- name; trigger rows whose invoice was linked after the payment). And row 4
-- has no Xero history at all: invoices raised or authorised outside the app
-- leave no evidence, and the app's own invoice.created write never landed
-- (ops-api passed the job number as job_id, a uuid column).
--
-- New, all service role only, none replaces an existing body:
--   context_xero_event_invoice(e)          the ACCREC invoice (xero_invoices.id)
--                                          an evidence row is about: entity
--                                          invoice or xero_invoice whose id is
--                                          the mirror row id or Xero's InvoiceID;
--                                          null when none or more than one.
--   context_xero_paid_event_key(e)         one key per invoice for its paid
--                                          events (the trigger's invoice.paid,
--                                          xero-sync's invoice.payment_received,
--                                          ops-api's invoice.manually_marked_paid,
--                                          this backfill's paid row):
--                                          xero:invoice:<InvoiceID>:paid, the key
--                                          xero-sync already writes. A count of
--                                          paid events counts distinct keys. No
--                                          row is changed for this: the reader
--                                          already reads one of each pair (the
--                                          trigger row has no words).
--   context_xero_evidence_backfill_plan()  the missing rows: for each ACCREC
--                                          invoice (not voided or deleted) on a
--                                          live job (the scorecard's live set),
--                                          raised (every status), authorised
--                                          (AUTHORISED or PAID) and paid (PAID),
--                                          each only when no row for that invoice
--                                          and kind exists (by key, or by event
--                                          type on the invoice's entity rows).
--                                          Raised is event type invoice.raised,
--                                          not invoice.created: the daily
--                                          digest counts invoice.created by
--                                          write time as office decisions.
--   context_xero_evidence_backfill(dry, limit)  writes the plan through
--                                          capture_business_event: source
--                                          xero-history, the invoice's job with
--                                          match_method direct_job_id, keyed
--                                          xero:invoice:<InvoiceID>:raised,
--                                          :authorised, :paid, capture_mode
--                                          backfill, source time from the
--                                          mirror (invoice_date, fully_paid_on)
--                                          and stated in metadata. Dry run (the
--                                          default) writes nothing.
--   context_xero_evidence_place(plan, dry, since, limit)  places invoice
--                                          evidence rows with no job:
--                                          the invoice has a job -> that job
--                                          (direct_job_id, rule xero_invoice_job);
--                                          the invoice has none and the plan's
--                                          matches name it -> that job
--                                          (direct_reference, rule
--                                          xero_reference_unique); the plan's
--                                          candidates name it -> the row stays
--                                          off a job, in the review queue
--                                          (unplaced) with those candidate jobs.
--                                          The plan is built ONLY by the unique
--                                          reference matcher
--                                          (ops-api/makesafe_invoice_reference_match.ts,
--                                          through _shared/evidence/
--                                          xero_invoice_evidence_plan.ts); SQL
--                                          never re-derives it. A holding job
--                                          is skipped. xero_invoices is never
--                                          written: the money seal's linked verb
--                                          is not touched, only evidence moves.
--   context_xero_evidence_request_reads(dry, limit)  lists the jobs these two
--                                          writers touched on the catch-up list
--                                          with the backlog writer's rule
--                                          (20261004100000), as the GHL history
--                                          hand-over does.
--   context_xero_evidence_undo(dry)        puts every placed or queued row back
--                                          exactly and removes the backfill's
--                                          rows (those already read are
--                                          retracted instead, so no read loses
--                                          its source).
-- Every write function takes one advisory lock, locks rows with SKIP LOCKED,
-- re-checks under the lock and counts what it skipped.
--
-- Not changed: the ladder, the insert trigger, capture_business_event,
-- fn_payment_detected, the readers, the catch-up writers, xero_invoices.
-- No existing row is written by this migration; the writes run from the
-- reviewed data files (dry run first, exact-count guard, undo).
--
-- Rollback: supabase/rollbacks/20261005230000_context_xero_evidence_down.sql
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 0. Pre-image guard. Reports every problem at once.
DO $guard$
DECLARE problems text[]:='{}'; live text; x record;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  -- New: absent, or already this migration's.
  ('public.context_xero_event_invoice(public.business_events)',ARRAY['e10753cc0a55962f00897ab0daa9dda5'],true),
  ('public.context_xero_paid_event_key(public.business_events)',ARRAY['689b60123b81312a722b47d4056376d4'],true),
  ('public.context_xero_evidence_backfill_plan()',ARRAY['805f818bffd9af3b0ead62f5b5fb80ff'],true),
  ('public.context_xero_evidence_backfill(boolean,integer)',ARRAY['eb9a51fc91bb4341e4a56b4e65552aae'],true),
  ('public.context_xero_evidence_place(jsonb,boolean,timestamp with time zone,integer)',ARRAY['90950950f0b3b31ea09aa5106ddfb117'],true),
  ('public.context_xero_evidence_request_reads(boolean,integer)',ARRAY['1ec556309a42774ef87c8023b40c6cdd'],true),
  ('public.context_xero_evidence_undo(boolean)',ARRAY['f0895bd3ed4638df1fdaa44b8ebceccf'],true),
  -- Read, not replaced.
  ('public.capture_business_event(jsonb)',ARRAY['4819869e6dcc40d5cd19a7eba295392c'],false)
 ) AS t(sig,accepted,may_be_absent) LOOP
  live:=NULL;
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid=to_regprocedure(x.sig);
  IF live IS NULL AND x.may_be_absent THEN CONTINUE; END IF;
  IF live IS NULL OR NOT live=ANY(x.accepted) THEN problems:=problems||format('%s md5 %s',x.sig,coalesce(live,'<missing>')); END IF;
 END LOOP;
 FOR x IN SELECT * FROM (VALUES
  ('public.automation_lane_enabled(text)'),('public.context_event_text(public.business_events)'),
  ('public.context_linked_status(text)'),('public.context_unread_rows(uuid[])'),
  ('public.context_catchup_eligible_rows(uuid[])'),('public.context_catchup_pending_rows(uuid[])')
 ) AS f(sig) LOOP
  IF to_regprocedure(x.sig) IS NULL THEN problems:=problems||format('%s is missing',x.sig); END IF;
 END LOOP;
 FOR x IN SELECT * FROM (VALUES
  ('jobs','id','uuid'),('jobs','job_number','text'),('jobs','metadata','jsonb'),
  ('xero_invoices','id','uuid'),('xero_invoices','xero_invoice_id','text'),('xero_invoices','invoice_type','text'),
  ('xero_invoices','status','text'),('xero_invoices','job_id','uuid'),('xero_invoices','invoice_number','text'),
  ('xero_invoices','total','numeric'),('xero_invoices','amount_due','numeric'),
  ('xero_invoices','amount_paid','numeric'),('xero_invoices','invoice_date','date'),
  ('xero_invoices','due_date','date'),('xero_invoices','fully_paid_on','date'),
  ('xero_invoices','created_at','timestamp with time zone'),('xero_invoices','updated_at','timestamp with time zone'),
  ('business_events','id','uuid'),('business_events','job_id','uuid'),('business_events','entity_type','text'),
  ('business_events','entity_id','text'),('business_events','event_type','text'),('business_events','source','text'),
  ('business_events','provider_message_id','text'),('business_events','event_at','timestamp with time zone'),
  ('business_events','recorded_at','timestamp with time zone'),('business_events','payload','jsonb'),
  ('business_events','metadata','jsonb'),('business_events','attribution_status','text'),
  ('business_events','candidate_job_ids','uuid[]'),('business_events','match_method','text'),
  ('business_events','match_status','text'),
  ('context_catchup_jobs','mode','text'),('context_catchup_jobs','scope','text'),
  ('context_extraction_event_receipts','event_id','uuid')
 ) AS c(tbl,col,typ) LOOP
  live:=NULL;
  SELECT format_type(a.atttypid,NULL) INTO live FROM pg_attribute a
  WHERE a.attrelid=to_regclass('public.'||x.tbl) AND a.attname=x.col AND a.attnum>0 AND NOT a.attisdropped;
  IF live IS DISTINCT FROM x.typ THEN problems:=problems||format('%s.%s is %s, expected %s',x.tbl,x.col,coalesce(live,'<missing>'),x.typ); END IF;
 END LOOP;
 IF cardinality(problems)>0 THEN
  RAISE EXCEPTION 'context_xero_evidence_preimage_mismatch: %; read the live definitions before replacing them',array_to_string(problems,'; ');
 END IF;
END $guard$;

-- 1. The ACCREC invoice a row is about, or null.
CREATE OR REPLACE FUNCTION public.context_xero_event_invoice(e public.business_events) RETURNS uuid
LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN count(*)=1 THEN min(x.id::text)::uuid END
 FROM public.xero_invoices x
 WHERE e.entity_type IN ('invoice','xero_invoice')
  AND nullif(btrim(e.entity_id),'') IS NOT NULL
  AND x.invoice_type='ACCREC'
  AND (x.xero_invoice_id=e.entity_id OR x.id::text=lower(e.entity_id))
$$;
COMMENT ON FUNCTION public.context_xero_event_invoice(public.business_events) IS
 'Xero evidence (20261005230000): the ACCREC xero_invoices row an invoice evidence row is about (entity_type invoice or xero_invoice; entity_id is the mirror row id, as the payment trigger writes, or Xero''s InvoiceID, as xero-sync and ops-api write); null when none or more than one. Private.';

-- 2. One key per invoice for its paid events.
CREATE OR REPLACE FUNCTION public.context_xero_paid_event_key(e public.business_events) RETURNS text
LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN e.event_type IN ('invoice.paid','invoice.payment_received','invoice.manually_marked_paid') THEN
  'xero:invoice:'||lower(coalesce(
   nullif(btrim(e.payload->>'xero_invoice_id'),''),
   (SELECT x.xero_invoice_id FROM public.xero_invoices x WHERE x.id=public.context_xero_event_invoice(e)),
   CASE WHEN e.event_type<>'invoice.paid' AND e.entity_type IN ('invoice','xero_invoice') THEN nullif(btrim(e.entity_id),'') END))||':paid'
 END
$$;
COMMENT ON FUNCTION public.context_xero_paid_event_key(public.business_events) IS
 'Xero evidence (20261005230000): xero:invoice:<InvoiceID>:paid for any paid event of an invoice (invoice.paid from the payment trigger, invoice.payment_received from xero-sync or the history backfill, invoice.manually_marked_paid from ops-api); null for other rows or when the invoice cannot be read. Count paid events as distinct keys so one payment counts once. Writes nothing.';

-- 3. The missing raised, authorised and paid rows of live jobs' invoices.
CREATE OR REPLACE FUNCTION public.context_xero_evidence_backfill_plan()
RETURNS TABLE(invoice_id uuid, job_id uuid, job_number text, kind text, provider_message_id text, row_json jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH inv AS (
  SELECT x.id, x.xero_invoice_id, x.invoice_number, upper(x.status) AS status, x.total, x.amount_due, x.amount_paid,
   x.invoice_date, x.due_date, x.fully_paid_on, x.created_at, x.updated_at, x.job_id, j.job_number
  FROM public.xero_invoices x JOIN public.jobs j ON j.id=x.job_id
  WHERE x.invoice_type='ACCREC'
   AND upper(coalesce(x.status,'')) IN ('DRAFT','SUBMITTED','AUTHORISED','PAID')
   AND nullif(btrim(x.xero_invoice_id),'') IS NOT NULL
   AND j.status::text NOT IN ('cancelled','draft','archived','complete','completed','lost')
 ), k AS (
  SELECT i.*, v.kind, v.event_type,
   'xero:invoice:'||i.xero_invoice_id||':'||v.kind AS pkey,
   CASE WHEN v.kind='paid' AND i.fully_paid_on IS NOT NULL THEN (i.fully_paid_on::timestamp AT TIME ZONE 'Australia/Perth')
        WHEN v.kind='paid' THEN i.updated_at
        WHEN i.invoice_date IS NOT NULL THEN (i.invoice_date::timestamp AT TIME ZONE 'Australia/Perth')
        ELSE i.created_at END AS at,
   CASE WHEN v.kind='paid' AND i.fully_paid_on IS NOT NULL THEN 'fully_paid_on'
        WHEN v.kind='paid' THEN 'mirror_updated_at'
        WHEN i.invoice_date IS NOT NULL THEN 'invoice_date'
        ELSE 'mirror_created_at' END AS basis,
   coalesce(i.invoice_number,'with no number') AS num
  FROM inv i CROSS JOIN LATERAL (VALUES
   ('raised','invoice.raised',ARRAY['invoice.created','invoice.raised']),
   ('authorised','invoice.authorised',ARRAY['invoice.authorised']),
   ('paid','invoice.payment_received',ARRAY['invoice.paid','invoice.payment_received','invoice.manually_marked_paid'])
  ) v(kind,event_type,covers)
  WHERE (v.kind='raised'
    OR (v.kind='authorised' AND i.status IN ('AUTHORISED','PAID'))
    OR (v.kind='paid' AND i.status='PAID'))
   AND NOT EXISTS(SELECT 1 FROM public.business_events b WHERE b.provider_message_id IN
    ('xero:invoice:'||i.xero_invoice_id||':'||v.kind,'xero:invoice:'||lower(i.xero_invoice_id)||':'||v.kind))
   AND NOT EXISTS(SELECT 1 FROM public.business_events b WHERE b.entity_type IN ('invoice','xero_invoice')
    AND b.entity_id IN (i.xero_invoice_id,lower(i.xero_invoice_id),i.id::text) AND b.event_type=ANY(v.covers))
 )
 SELECT k.id, k.job_id, k.job_number, k.kind, k.pkey,
  jsonb_build_object(
   'event_type',k.event_type,'source','xero-history','entity_type','invoice','entity_id',k.xero_invoice_id,
   'job_id',k.job_id,'match_method','direct_job_id','channel','invoice','direction','internal',
   'event_at',k.at,'provider_message_id',k.pkey,
   'body_preview',CASE k.kind
     WHEN 'raised' THEN 'Xero invoice '||k.num||' raised'||CASE WHEN k.status='DRAFT' THEN ' as a draft' ELSE '' END
      ||coalesce(': total $'||to_char(k.total,'FM999,999,990.00')||' inc GST','')||'.'
     WHEN 'authorised' THEN 'Xero invoice '||k.num||' authorised for payment'
      ||coalesce(': total $'||to_char(k.total,'FM999,999,990.00')||' inc GST','')
      ||coalesce(', due '||to_char(k.due_date,'FMDD Mon YYYY'),'')||'.'
     ELSE 'Xero invoice '||k.num||' paid in full'||coalesce(' on '||to_char(k.fully_paid_on,'FMDD Mon YYYY'),'')
      ||coalesce(': $'||to_char(coalesce(nullif(k.amount_paid,0),k.total),'FM999,999,990.00'),'')||'.'
    END,
   'payload',jsonb_build_object('xero_invoice_id',k.xero_invoice_id,'invoice_number',k.invoice_number,'invoice_status',k.status,
    'total',k.total,'amount_due',k.amount_due,'amount_paid',k.amount_paid,'invoice_date',k.invoice_date,'due_date',k.due_date,
    'fully_paid_on',k.fully_paid_on),
   'metadata',jsonb_build_object('capture_mode','backfill',
    'xero_backfill',jsonb_build_object('by','context_xero_evidence_backfill','migration','20261005230000','kind',k.kind,
     'event_time_basis',k.basis,'invoice_id',k.id)))
 FROM k
 ORDER BY k.job_number, k.invoice_number, k.id, array_position(ARRAY['raised','authorised','paid'],k.kind)
$$;
COMMENT ON FUNCTION public.context_xero_evidence_backfill_plan() IS
 'Xero evidence (20261005230000): the raised, authorised and paid evidence rows missing for ACCREC invoices (DRAFT, SUBMITTED, AUTHORISED or PAID) on live jobs (status not cancelled, draft, archived, complete, completed or lost), one row per invoice and kind, each with the capture_business_event row it would write. A kind is missing when no row carries its key and no invoice entity row has its event type (raised: invoice.created or invoice.raised; authorised: invoice.authorised; paid: invoice.paid, invoice.payment_received or invoice.manually_marked_paid). Backfilled raised rows are invoice.raised so the digest''s invoice.created count stays office decisions. Read only. Service role only.';

-- 4. Write the plan through the one evidence writer.
CREATE OR REPLACE FUNCTION public.context_xero_evidence_backfill(p_dry_run boolean DEFAULT true, p_limit integer DEFAULT 1000)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE dry boolean:=coalesce(p_dry_run,true); lim integer:=coalesce(p_limit,1000);
 r record; res jsonb; n_plan integer:=0; n_ins integer:=0; n_dup integer:=0; n_err integer:=0;
 errs jsonb:='{}'::jsonb; by_kind jsonb; jobs integer;
BEGIN
 IF lim NOT BETWEEN 1 AND 5000 THEN RAISE EXCEPTION 'xero_evidence_backfill_limit_invalid: limit must be 1 to 5000'; END IF;
 IF NOT dry AND NOT public.automation_lane_enabled('capture') THEN
  RAISE EXCEPTION 'xero_evidence_backfill_capture_off: the capture lane is off; nothing written';
 END IF;
 PERFORM pg_advisory_xact_lock(20261005,23);
 SELECT count(*), count(DISTINCT p.job_id),
  jsonb_build_object('raised',count(*) FILTER (WHERE p.kind='raised'),'authorised',count(*) FILTER (WHERE p.kind='authorised'),
   'paid',count(*) FILTER (WHERE p.kind='paid'))
 INTO n_plan, jobs, by_kind FROM public.context_xero_evidence_backfill_plan() p;
 IF NOT dry THEN
  FOR r IN SELECT p.* FROM public.context_xero_evidence_backfill_plan() p LIMIT lim LOOP
   res:=public.capture_business_event(r.row_json);
   CASE res->>'outcome'
    WHEN 'inserted' THEN n_ins:=n_ins+1;
    WHEN 'duplicate' THEN n_dup:=n_dup+1;
    ELSE n_err:=n_err+1;
     errs:=errs||jsonb_build_object(coalesce(res->>'code',res->>'outcome','unknown'),
      coalesce((errs->>coalesce(res->>'code',res->>'outcome','unknown'))::integer,0)+1);
   END CASE;
  END LOOP;
 END IF;
 RETURN jsonb_build_object('dry_run',dry,'as_of',now(),'limit',lim,
  'missing_rows',n_plan,'missing_by_kind',by_kind,'jobs',jobs,
  'more',n_plan>lim,
  'written',CASE WHEN dry THEN NULL ELSE jsonb_build_object('inserted',n_ins,'duplicate',n_dup,'errors',n_err,'error_codes',errs) END);
END $$;
COMMENT ON FUNCTION public.context_xero_evidence_backfill(boolean,integer) IS
 'Xero evidence (20261005230000): writes up to p_limit rows of context_xero_evidence_backfill_plan() through capture_business_event (source xero-history, capture_mode backfill, the invoice''s job, direct_job_id). Dry run (the default) writes nothing and reports the missing rows by kind. Refuses a real run while the capture lane is off. Call again while more is true. Service role only.';

-- 5. Place invoice evidence rows that sit on no job.
CREATE OR REPLACE FUNCTION public.context_xero_evidence_place(p_plan jsonb DEFAULT '{}'::jsonb, p_dry_run boolean DEFAULT true,
 p_since timestamptz DEFAULT NULL, p_limit integer DEFAULT 2000)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE dry boolean:=coalesce(p_dry_run,true); lim integer:=coalesce(p_limit,2000); plan jsonb:=coalesce(p_plan,'{}'::jsonb);
 v_now timestamptz:=clock_timestamp(); r record; e public.business_events; v_prior jsonb; words boolean;
 n_place integer:=0; n_queue integer:=0; n_busy integer:=0; n_changed integer:=0; judged jsonb; bad text;
 v_rule text; v_method text;
BEGIN
 IF lim NOT BETWEEN 1 AND 10000 THEN RAISE EXCEPTION 'xero_evidence_place_limit_invalid: limit must be 1 to 10000'; END IF;
 IF jsonb_typeof(plan)<>'object'
  OR (plan ? 'matches' AND jsonb_typeof(plan->'matches')<>'array')
  OR (plan ? 'candidates' AND jsonb_typeof(plan->'candidates')<>'array') THEN
  RAISE EXCEPTION 'xero_evidence_place_plan_invalid: the plan must be an object whose matches and candidates are arrays';
 END IF;
 -- Every plan entry names a mirror row id and a job id (or job ids); each invoice once.
 SELECT string_agg(DISTINCT reason,', ') INTO bad FROM (
  SELECT 'match without invoice_id or job_id' AS reason FROM jsonb_array_elements(coalesce(plan->'matches','[]')) m
  WHERE jsonb_typeof(m)<>'object'
   OR coalesce(m->>'invoice_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   OR coalesce(m->>'job_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  UNION ALL
  SELECT 'candidate without invoice_id or job_ids' FROM jsonb_array_elements(coalesce(plan->'candidates','[]')) c
  WHERE jsonb_typeof(c)<>'object'
   OR coalesce(c->>'invoice_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   OR jsonb_typeof(c->'job_ids') IS DISTINCT FROM 'array' OR jsonb_array_length(c->'job_ids')=0
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(c->'job_ids') j
    WHERE jsonb_typeof(j)<>'string' OR j#>>'{}' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  UNION ALL
  SELECT 'invoice named more than once' FROM (
   SELECT lower(x->>'invoice_id') i FROM jsonb_array_elements(coalesce(plan->'matches','[]')||coalesce(plan->'candidates','[]')) x
   WHERE jsonb_typeof(x)='object' GROUP BY 1 HAVING count(*)>1) d
 ) z;
 IF bad IS NOT NULL THEN RAISE EXCEPTION 'xero_evidence_place_plan_invalid: %',bad; END IF;
 IF NOT dry AND NOT public.automation_lane_enabled('attribution') THEN
  RAISE EXCEPTION 'xero_evidence_place_attribution_off: the attribution lane is off; nothing written';
 END IF;
 PERFORM pg_advisory_xact_lock(20261005,23);

 WITH m AS (
  SELECT lower(x->>'invoice_id')::uuid AS invoice_id, lower(x->>'job_id')::uuid AS job_id, x->'digits' AS digits
  FROM jsonb_array_elements(coalesce(plan->'matches','[]')) x
 ), c AS (
  SELECT lower(x->>'invoice_id')::uuid AS invoice_id,
   ARRAY(SELECT DISTINCT lower(j)::uuid FROM jsonb_array_elements_text(x->'job_ids') j ORDER BY 1) AS job_ids
  FROM jsonb_array_elements(coalesce(plan->'candidates','[]')) x
 ), ev AS (
  SELECT b.id, public.context_xero_event_invoice(b) AS invoice_id, b.candidate_job_ids,
   coalesce(b.metadata,'{}'::jsonb) ? 'xero_review' AS queued
  FROM public.business_events b
  WHERE b.job_id IS NULL
   AND b.entity_type IN ('invoice','xero_invoice')
   AND (p_since IS NULL OR b.recorded_at>=p_since)
   AND coalesce(b.metadata->>'written_as','service_role')='service_role'
   AND NOT (coalesce(b.metadata,'{}'::jsonb) ? 'recipient_role')
   AND b.metadata->>'retracted_at' IS NULL AND coalesce(b.metadata->>'retracted','')<>'true'
 ), cls AS (
  SELECT ev.id, ev.invoice_id, x.invoice_number,
   CASE
    WHEN ev.invoice_id IS NULL THEN 'invoice_unknown'
    WHEN x.job_id IS NOT NULL AND jx.id IS NULL THEN 'invoice_job_not_found'
    WHEN x.job_id IS NOT NULL AND coalesce(jx.metadata->>'do_not_schedule','') IN ('true','1') THEN 'holding_job_skipped'
    WHEN x.job_id IS NOT NULL THEN 'invoice_job'
    WHEN m.job_id IS NOT NULL AND jm.id IS NULL THEN 'match_job_not_found'
    WHEN m.job_id IS NOT NULL AND coalesce(jm.metadata->>'do_not_schedule','') IN ('true','1') THEN 'holding_job_skipped'
    WHEN m.job_id IS NOT NULL THEN 'reference_unique'
    WHEN cardinality(c.job_ids)>0 AND ev.queued AND ev.candidate_job_ids=c.job_ids THEN 'already_queued'
    WHEN cardinality(c.job_ids)>0 THEN 'review_candidates'
    ELSE 'no_candidate'
   END AS class,
   CASE WHEN x.job_id IS NOT NULL THEN jx.id ELSE jm.id END AS target,
   c.job_ids AS candidates, m.digits
  FROM ev
  LEFT JOIN public.xero_invoices x ON x.id=ev.invoice_id
  LEFT JOIN public.jobs jx ON jx.id=x.job_id
  LEFT JOIN m ON m.invoice_id=ev.invoice_id AND x.job_id IS NULL
  LEFT JOIN public.jobs jm ON jm.id=m.job_id
  LEFT JOIN c ON c.invoice_id=ev.invoice_id AND x.job_id IS NULL
 )
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',cls.id,'invoice_id',cls.invoice_id,'invoice_number',cls.invoice_number,
   'class',cls.class,'target',cls.target,'candidates',to_jsonb(cls.candidates),'digits',cls.digits) ORDER BY cls.id),'[]'::jsonb)
 INTO judged FROM cls;

 IF NOT dry THEN
  FOR r IN SELECT (x->>'id')::uuid AS id, (x->>'invoice_id')::uuid AS invoice_id, x->>'invoice_number' AS invoice_number,
    x->>'class' AS class, (x->>'target')::uuid AS target, x->'digits' AS digits,
    CASE WHEN jsonb_typeof(x->'candidates')='array' THEN ARRAY(SELECT y::uuid FROM jsonb_array_elements_text(x->'candidates') y) END AS candidates
   FROM jsonb_array_elements(judged) x
   WHERE x->>'class' IN ('invoice_job','reference_unique','review_candidates')
   ORDER BY x->>'id' LIMIT lim LOOP
   SELECT * INTO e FROM public.business_events b WHERE b.id=r.id FOR UPDATE SKIP LOCKED;
   IF NOT FOUND THEN n_busy:=n_busy+1; CONTINUE; END IF;
   -- Re-check under the lock: still no job, still about that invoice, and the
   -- invoice's own link is still what the class was judged on.
   IF e.job_id IS NOT NULL OR public.context_xero_event_invoice(e) IS DISTINCT FROM r.invoice_id
    OR NOT EXISTS(SELECT 1 FROM public.xero_invoices x WHERE x.id=r.invoice_id
     AND x.job_id IS NOT DISTINCT FROM CASE WHEN r.class='invoice_job' THEN r.target END) THEN
    n_changed:=n_changed+1; CONTINUE;
   END IF;
   words:=btrim(public.context_event_text(e))<>'';
   SELECT coalesce(jsonb_object_agg(kk,e.metadata->kk),'{}'::jsonb) INTO v_prior
   FROM unnest(ARRAY['source_job_binding','placement_rule','capture_mode','capture_mode_before','xero_review']) kk
   WHERE coalesce(e.metadata,'{}'::jsonb) ? kk;
   IF r.class='review_candidates' THEN
    UPDATE public.business_events SET
     candidate_job_ids=r.candidates,
     attribution_status=CASE WHEN e.attribution_status IS NULL OR e.attribution_status IN ('empty','automated') THEN 'unplaced' ELSE e.attribution_status END,
     attribution_checked_at=v_now,
     metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('xero_review',jsonb_build_object(
      'reason','no_unique_reference_match','by','context_xero_evidence_place','at',v_now,'invoice_id',r.invoice_id,
      'invoice_number',r.invoice_number,'candidate_job_ids',to_jsonb(r.candidates),
      'from_status',e.attribution_status,'from_candidates',to_jsonb(e.candidate_job_ids),'from_checked_at',e.attribution_checked_at,
      'prior_metadata',v_prior))
    WHERE id=e.id;
    n_queue:=n_queue+1;
   ELSE
    v_rule:=CASE WHEN r.class='invoice_job' THEN 'xero_invoice_job' ELSE 'xero_reference_unique' END;
    v_method:=CASE WHEN r.class='invoice_job' THEN 'direct_job_id' ELSE 'direct_reference' END;
    UPDATE public.business_events SET
     job_id=r.target,
     attribution_status=CASE WHEN words THEN 'direct' WHEN e.attribution_status='automated' THEN 'automated' ELSE 'empty' END,
     attribution_step=CASE WHEN words THEN 1 ELSE e.attribution_step END,
     attribution_confidence=CASE WHEN words THEN 1 ELSE e.attribution_confidence END,
     attributed_at=CASE WHEN words THEN v_now ELSE e.attributed_at END,
     attribution_checked_at=v_now,
     match_status='matched', match_method=v_method, match_confidence=1,
     metadata=(coalesce(metadata,'{}'::jsonb)-'xero_review')||jsonb_build_object(
      'source_job_binding',jsonb_build_object('job_id',r.target,'match_method',v_method,'via',v_rule),
      'placement_rule',v_rule,
      'capture_mode','relink',
      'capture_mode_before',coalesce(metadata->'capture_mode_before',to_jsonb(coalesce(metadata->>'capture_mode','live'))),
      'placement_repaired',jsonb_build_object('rule',v_rule,'by','context_xero_evidence_place','at',v_now,
       'invoice_id',r.invoice_id,'invoice_number',r.invoice_number,'matched_digits',r.digits,'to_job_id',r.target,
       'from_job_id',e.job_id,'from_status',e.attribution_status,'from_step',e.attribution_step,
       'from_confidence',e.attribution_confidence,'from_attributed_at',e.attributed_at,'from_checked_at',e.attribution_checked_at,
       'from_match_status',e.match_status,'from_match_method',e.match_method,'from_match_confidence',e.match_confidence,
       'prior_metadata',v_prior))
    WHERE id=e.id;
    n_place:=n_place+1;
   END IF;
  END LOOP;
 END IF;

 RETURN jsonb_build_object('dry_run',dry,'as_of',now(),'since',p_since,'limit',lim,
  'rows_without_job',jsonb_array_length(judged),
  'by_class',(SELECT coalesce(jsonb_object_agg(k,n),'{}'::jsonb) FROM (
   SELECT x->>'class' k, count(*) n FROM jsonb_array_elements(judged) x GROUP BY 1) s),
  'to_write',(SELECT count(*) FROM jsonb_array_elements(judged) x WHERE x->>'class' IN ('invoice_job','reference_unique','review_candidates')),
  'unlinked_invoices',(SELECT coalesce(jsonb_agg(DISTINCT x->>'invoice_id'),'[]'::jsonb) FROM jsonb_array_elements(judged) x
   WHERE x->>'class' IN ('reference_unique','review_candidates','no_candidate','match_job_not_found')),
  'matches_in_plan',jsonb_array_length(coalesce(plan->'matches','[]')),
  'candidates_in_plan',jsonb_array_length(coalesce(plan->'candidates','[]')),
  'written',CASE WHEN dry THEN NULL ELSE jsonb_build_object('placed',n_place,'queued_with_candidates',n_queue,
   'skipped_busy',n_busy,'changed_meanwhile',n_changed) END);
END $$;
COMMENT ON FUNCTION public.context_xero_evidence_place(jsonb,boolean,timestamptz,integer) IS
 'Xero evidence (20261005230000): for invoice evidence rows with no job (recorded since p_since when given; service-role writers only; never crew or staff marked or retracted rows): the invoice''s own job when xero_invoices.job_id is set (direct_job_id, placement_rule xero_invoice_job); otherwise the job p_plan.matches names for that invoice (direct_reference, xero_reference_unique); otherwise, when p_plan.candidates names jobs, the row stays off a job as unplaced with those candidate_job_ids. p_plan comes only from the unique reference matcher (makesafe_invoice_reference_match.ts via xero_invoice_evidence_plan.ts). Holding jobs are skipped. A worded row placed becomes direct (read); a row with no words keeps empty (never read). Every replaced value is kept in metadata.placement_repaired or metadata.xero_review for the undo. Never writes xero_invoices. Dry run (the default) writes nothing. Service role only.';

-- 6. Hand the touched jobs to the reader: the backlog writer's per-job rule.
CREATE OR REPLACE FUNCTION public.context_xero_evidence_request_reads(p_dry_run boolean DEFAULT true, p_limit integer DEFAULT 500)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE dry boolean:=coalesce(p_dry_run,true); lim integer:=coalesce(p_limit,500); judged jsonb;
 added integer:=0; reopened integer:=0; raised integer:=0;
BEGIN
 IF lim NOT BETWEEN 1 AND 5000 THEN RAISE EXCEPTION 'xero_evidence_reads_limit_invalid: limit must be 1 to 5000'; END IF;
 PERFORM pg_advisory_xact_lock(20260924,22);
 WITH touched AS (
  SELECT DISTINCT b.job_id FROM public.business_events b
  WHERE b.job_id IS NOT NULL
   AND (b.metadata->'xero_backfill'->>'by'='context_xero_evidence_backfill'
    OR b.metadata->'placement_repaired'->>'by'='context_xero_evidence_place')
 ), member AS (
  SELECT j.id, j.job_number,
   CASE
    WHEN EXISTS(SELECT 1 FROM public.xero_invoices x WHERE x.job_id=j.id AND x.invoice_type='ACCREC'
      AND x.status IN ('AUTHORISED','SUBMITTED') AND x.amount_due>0)
     OR EXISTS(SELECT 1 FROM public.business_events b WHERE b.job_id=j.id AND b.metadata ? 'placement_repaired') THEN 1
    WHEN j.status::text IN ('accepted','partially_accepted','scheduled','in_progress','processing','approvals','order_materials',
     'schedule_install','awaiting_supplier','awaiting_deposit','final_payment','rectification','invoiced','get_review') THEN 2
    WHEN j.status::text IN ('quoted','draft') THEN 3
    WHEN j.status::text IN ('complete','completed') THEN 4
    ELSE 5 END AS tier,
   (SELECT max(r.finished_at) FROM public.context_extraction_runs r
    WHERE r.job_id=j.id AND r.phase='extraction' AND r.status='done') AS last_read
  FROM public.jobs j JOIN touched t ON t.job_id=j.id
  WHERE coalesce(j.metadata->>'do_not_schedule','') NOT IN ('true','1')
  ORDER BY j.job_number, j.id
  LIMIT lim
 ), el AS (
  SELECT e.job_id, count(*) AS eligible_n,
   count(*) FILTER (WHERE NOT EXISTS(SELECT 1 FROM public.context_catchup_reads r WHERE r.job_id=e.job_id AND r.event_id=e.id)) AS full_n
  FROM public.context_catchup_eligible_rows(ARRAY(SELECT m.id FROM member m)) e GROUP BY e.job_id
 ), un AS (
  SELECT u.job_id, count(*) AS unread_n FROM public.context_unread_rows(ARRAY(SELECT m.id FROM member m)) u
  WHERE NOT EXISTS(SELECT 1 FROM public.context_catchup_reads r WHERE r.job_id=u.job_id AND r.event_id=u.id)
  GROUP BY u.job_id
 ), pe AS (
  SELECT p.job_id, count(*) AS pending_n FROM public.context_catchup_pending_rows(ARRAY(SELECT m.id FROM member m)) p GROUP BY p.job_id
 ), base AS (
  SELECT m.*, coalesce(el.eligible_n,0) AS eligible_n, coalesce(el.full_n,0) AS full_n, coalesce(un.unread_n,0) AS unread_n,
   coalesce(pe.pending_n,0) AS listed_pending_n, c.job_id IS NOT NULL AS listed, c.done_at IS NOT NULL AS was_done,
   c.priority AS old_priority, c.mode AS old_mode
  FROM member m LEFT JOIN el ON el.job_id=m.id LEFT JOIN un ON un.job_id=m.id LEFT JOIN pe ON pe.job_id=m.id
  LEFT JOIN public.context_catchup_jobs c ON c.job_id=m.id
 ), moded AS (
  SELECT b.*,
   CASE WHEN b.listed AND NOT b.was_done THEN b.old_mode WHEN b.last_read IS NULL AND NOT b.listed THEN 'full' ELSE 'unread' END AS mode,
   CASE WHEN b.listed AND NOT b.was_done THEN b.listed_pending_n WHEN b.last_read IS NULL AND NOT b.listed THEN b.full_n ELSE b.unread_n END AS pending_n
  FROM base b
 )
 SELECT coalesce(jsonb_agg(jsonb_build_object('job_id',d.id,'job_number',d.job_number,'tier',d.tier,
   'mode',d.mode,'pending_rows',d.pending_n,'action',CASE
   WHEN d.eligible_n=0 THEN 'no_evidence'
   WHEN d.listed AND NOT d.was_done AND d.tier<d.old_priority THEN 'raise'
   WHEN d.listed AND NOT d.was_done THEN 'already_listed'
   WHEN d.pending_n=0 THEN 'nothing_unread'
   WHEN d.listed THEN 'reopen'
   ELSE 'add' END) ORDER BY d.job_number, d.id),'[]'::jsonb)
 INTO judged FROM moded d;

 IF NOT dry THEN
  WITH src AS (SELECT (x->>'job_id')::uuid AS job_id, x->>'action' AS action, x->>'mode' AS mode, (x->>'tier')::integer AS tier
   FROM jsonb_array_elements(judged) x),
  ins AS (INSERT INTO public.context_catchup_jobs(job_id,job_number,priority,mode,scope)
   SELECT s.job_id, coalesce(j.job_number,''), s.tier, s.mode, 'backlog' FROM src s JOIN public.jobs j ON j.id=s.job_id WHERE s.action='add'
   ON CONFLICT (job_id) DO NOTHING RETURNING job_id),
  reo AS (UPDATE public.context_catchup_jobs c SET done_at=NULL,done_run_id=NULL,requested_at=now(),mode='unread',scope='backlog',priority=s.tier
   FROM src s WHERE c.job_id=s.job_id AND s.action='reopen' AND c.done_at IS NOT NULL RETURNING c.job_id),
  rai AS (UPDATE public.context_catchup_jobs c SET priority=s.tier
   FROM src s WHERE c.job_id=s.job_id AND s.action='raise' AND c.done_at IS NULL AND c.priority>s.tier RETURNING c.job_id)
  SELECT (SELECT count(*) FROM ins),(SELECT count(*) FROM reo),(SELECT count(*) FROM rai) INTO added, reopened, raised;
 END IF;

 RETURN jsonb_build_object('dry_run',dry,'as_of',now(),'limit',lim,
  'jobs_considered',jsonb_array_length(judged),
  'jobs_listed',(SELECT count(*) FROM jsonb_array_elements(judged) x WHERE x->>'action' IN ('add','reopen','raise')),
  'by_action',(SELECT coalesce(jsonb_object_agg(a,n),'{}'::jsonb) FROM (
   SELECT x->>'action' a, count(*) n FROM jsonb_array_elements(judged) x GROUP BY 1) s),
  'jobs',judged,
  'written',CASE WHEN dry THEN NULL ELSE jsonb_build_object('added',added,'reopened',reopened,'priority_raised',raised) END);
END $$;
COMMENT ON FUNCTION public.context_xero_evidence_request_reads(boolean,integer) IS
 'Xero evidence (20261005230000): lists the jobs holding a row the Xero backfill wrote or the Xero placement moved on the catch-up list (scope backlog) with the backlog writer''s rule: tier 1 open money or a relinked row, 2 work in hand, 3 sales, 4 complete, 5 else; never read and not listed reads in full, otherwise only unread rows; a pending row is never lowered; a done row re-opens only with unread rows; nothing to read, no row; holding jobs left out. Dry run (the default) writes nothing. The reader takes the jobs under its unchanged caps. Service role only.';

-- 7. Undo: every placed or queued row back exactly; the backfill's rows
-- removed, or retracted when already read.
CREATE OR REPLACE FUNCTION public.context_xero_evidence_undo(p_dry_run boolean DEFAULT true)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE dry boolean:=coalesce(p_dry_run,true); e public.business_events; p jsonb;
 n_unplace integer:=0; n_unqueue integer:=0; n_delete integer:=0; n_retract integer:=0; n_left integer:=0; v_now timestamptz:=clock_timestamp();
BEGIN
 PERFORM pg_advisory_xact_lock(20261005,23);
 IF dry THEN
  RETURN jsonb_build_object('dry_run',true,'as_of',now(),
   'placed_rows',(SELECT count(*) FROM public.business_events b WHERE b.metadata->'placement_repaired'->>'by'='context_xero_evidence_place'),
   'queued_rows',(SELECT count(*) FROM public.business_events b WHERE b.metadata->'xero_review'->>'by'='context_xero_evidence_place'),
   'backfill_rows',(SELECT count(*) FROM public.business_events b WHERE b.metadata->'xero_backfill'->>'by'='context_xero_evidence_backfill'
    AND coalesce(b.metadata->>'retracted','')<>'true'),
   'backfill_rows_read',(SELECT count(*) FROM public.business_events b WHERE b.metadata->'xero_backfill'->>'by'='context_xero_evidence_backfill'
    AND coalesce(b.metadata->>'retracted','')<>'true'
    AND EXISTS(SELECT 1 FROM public.context_extraction_event_receipts r WHERE r.event_id=b.id)));
 END IF;
 FOR e IN SELECT * FROM public.business_events b
  WHERE b.metadata->'placement_repaired'->>'by'='context_xero_evidence_place' ORDER BY b.id FOR UPDATE SKIP LOCKED LOOP
  p:=e.metadata->'placement_repaired';
  IF e.job_id IS DISTINCT FROM (p->>'to_job_id')::uuid THEN n_left:=n_left+1; CONTINUE; END IF;
  UPDATE public.business_events SET
   job_id=(p->>'from_job_id')::uuid, attribution_status=p->>'from_status', attribution_step=(p->>'from_step')::smallint,
   attribution_confidence=(p->>'from_confidence')::numeric, attributed_at=(p->>'from_attributed_at')::timestamptz,
   attribution_checked_at=(p->>'from_checked_at')::timestamptz, match_status=p->>'from_match_status',
   match_method=p->>'from_match_method', match_confidence=(p->>'from_match_confidence')::numeric,
   metadata=(metadata-'source_job_binding'-'placement_rule'-'capture_mode'-'capture_mode_before'-'placement_repaired'-'xero_review')
    ||coalesce(p->'prior_metadata','{}'::jsonb)
  WHERE id=e.id;
  n_unplace:=n_unplace+1;
 END LOOP;
 FOR e IN SELECT * FROM public.business_events b
  WHERE b.metadata->'xero_review'->>'by'='context_xero_evidence_place' ORDER BY b.id FOR UPDATE SKIP LOCKED LOOP
  p:=e.metadata->'xero_review';
  IF e.job_id IS NOT NULL THEN n_left:=n_left+1; CONTINUE; END IF;
  UPDATE public.business_events SET
   attribution_status=p->>'from_status',
   candidate_job_ids=CASE WHEN jsonb_typeof(p->'from_candidates')='array'
    THEN ARRAY(SELECT x::uuid FROM jsonb_array_elements_text(p->'from_candidates') x) END,
   attribution_checked_at=(p->>'from_checked_at')::timestamptz,
   metadata=(metadata-'xero_review')||coalesce(p->'prior_metadata','{}'::jsonb)
  WHERE id=e.id;
  n_unqueue:=n_unqueue+1;
 END LOOP;
 -- Backfill rows: a row a read already used is retracted (the revision store
 -- refuses retracted sources from then on); the rest are removed.
 WITH r AS (
  UPDATE public.business_events b SET metadata=b.metadata||jsonb_build_object('retracted',true,'retracted_at',v_now,
   'retracted_by','context_xero_evidence_undo')
  WHERE b.metadata->'xero_backfill'->>'by'='context_xero_evidence_backfill' AND coalesce(b.metadata->>'retracted','')<>'true'
   AND EXISTS(SELECT 1 FROM public.context_extraction_event_receipts x WHERE x.event_id=b.id)
  RETURNING 1)
 SELECT count(*) INTO n_retract FROM r;
 WITH d AS (
  DELETE FROM public.business_events b
  WHERE b.metadata->'xero_backfill'->>'by'='context_xero_evidence_backfill'
   AND b.provider_message_id LIKE 'xero:invoice:%' AND coalesce(b.metadata->>'retracted','')<>'true'
   AND NOT EXISTS(SELECT 1 FROM public.context_extraction_event_receipts x WHERE x.event_id=b.id)
  RETURNING 1)
 SELECT count(*) INTO n_delete FROM d;
 RETURN jsonb_build_object('dry_run',false,'as_of',now(),'unplaced',n_unplace,'unqueued',n_unqueue,
  'backfill_removed',n_delete,'backfill_retracted',n_retract,'left_alone_changed_since',n_left);
END $$;
COMMENT ON FUNCTION public.context_xero_evidence_undo(boolean) IS
 'Xero evidence (20261005230000): undoes context_xero_evidence_place (every placed or queued row back exactly, from metadata.placement_repaired or metadata.xero_review; a row moved since by someone else is left and counted) and context_xero_evidence_backfill (its rows removed; a row a read already used is retracted instead). Dry run (the default) only counts. Service role only.';

-- 8. Grants: service role only.
REVOKE ALL ON FUNCTION
 public.context_xero_event_invoice(public.business_events),
 public.context_xero_paid_event_key(public.business_events),
 public.context_xero_evidence_backfill_plan(),
 public.context_xero_evidence_backfill(boolean,integer),
 public.context_xero_evidence_place(jsonb,boolean,timestamptz,integer),
 public.context_xero_evidence_request_reads(boolean,integer),
 public.context_xero_evidence_undo(boolean)
FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION
 public.context_xero_event_invoice(public.business_events),
 public.context_xero_paid_event_key(public.business_events),
 public.context_xero_evidence_backfill_plan(),
 public.context_xero_evidence_backfill(boolean,integer),
 public.context_xero_evidence_place(jsonb,boolean,timestamptz,integer),
 public.context_xero_evidence_request_reads(boolean,integer),
 public.context_xero_evidence_undo(boolean)
TO service_role;
