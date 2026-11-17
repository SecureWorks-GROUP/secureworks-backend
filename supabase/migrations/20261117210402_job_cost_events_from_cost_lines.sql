-- P2-01.7. Cutover-gated reader, off by default. No business trigger or schedule installs.
-- Reference: job_profit_views_live.sql, derived from migrations, not observed live.
-- v_job_profit is never replaced. Its consumed literals stay on the source lines.
-- Version is main's newest plus one second, beyond the assigned 4201-4299 block.
SET LOCAL lock_timeout = '5s';
SET LOCAL TimeZone = 'UTC';

-- Fail before replacing an unexpected definition. The derived reference's guard
-- must be reconciled by the director if live differs, never silently adopted.
DO $legacy$
DECLARE d text;
/* block */ BEGIN
 IF to_regclass('public.v_job_cost_events_legacy') IS NOT NULL THEN
  d:=pg_get_viewdef('public.v_job_cost_events_legacy'::regclass,true);
 ELSE
  d:=pg_get_viewdef('public.v_job_cost_events'::regclass,true);
 END IF;
 IF md5(d)<>'b48997c55913ce3c90e3a3c947533fd3' THEN
  RAISE EXCEPTION 'P2-01.7: legacy cost events pre-image differs';
 END IF;
 IF to_regclass('public.v_job_cost_events_legacy') IS NULL THEN
  EXECUTE 'CREATE VIEW public.v_job_cost_events_legacy AS '||d;
 END IF;
END $legacy$;

-- The PO branch is copied from the reference, changing only its close test.
-- job_cost_lines_order_idx serves that correlated order_kind/order_id probe.
CREATE OR REPLACE VIEW public.v_job_cost_events_lines AS
 WITH po_base AS (
         SELECT p.id,
            p.job_id,
            p.po_number,
            p.supplier_name,
            p.status,
            p.notes,
            p.delivery_date,
            p.created_at,
            p.invoice_received_at,
                CASE
                    WHEN p.subtotal > 0::numeric THEN p.subtotal
                    WHEN p.total > 0::numeric THEN p.total / 1.1
                    ELSE NULL::numeric
                END AS po_amount_ex,
            NOT (COALESCE(p.subtotal, 0::numeric) > 0::numeric OR COALESCE(p.total, 0::numeric) > 0::numeric) AS unpriced,
            COALESCE(( SELECT min(oe.sent_at) AS min
                   FROM job_order_emails oe
                  WHERE oe.purchase_order_id = p.id AND oe.status = 'sent'::text AND oe.sent_at IS NOT NULL), p.last_sent_at, p.created_at) AS ordered_at
           FROM purchase_orders p
          WHERE p.job_id IS NOT NULL AND p.xero_bill_id IS NULL AND NOT (EXISTS ( SELECT 1
                   FROM public.job_cost_lines f
                  WHERE f.order_kind = 'purchase_order'::text AND f.order_id = p.id::text AND f.state IS NOT NULL)) AND (lower(COALESCE(p.status, ''::text)) <> ALL (ARRAY['draft'::text, 'billed'::text, 'cancelled'::text, 'canceled'::text, 'void'::text, 'voided'::text, 'deleted'::text]))
        ), po_state AS (
         SELECT b.id,
            b.job_id,
            b.po_number,
            b.supplier_name,
            b.status,
            b.notes,
            b.delivery_date,
            b.created_at,
            b.invoice_received_at,
            b.po_amount_ex,
            b.unpriced,
            b.ordered_at,
                CASE
                    WHEN b.invoice_received_at IS NOT NULL THEN 'po_invoice_emailed'::text
                    WHEN b.unpriced THEN 'po_ordered'::text
                    ELSE 'po_committed'::text
                END AS state
           FROM po_base b
        ), po AS (
         SELECT s.job_id,
                CASE s.state
                    WHEN 'po_invoice_emailed'::text THEN (s.invoice_received_at AT TIME ZONE 'Australia/Perth'::text)::date
                    WHEN 'po_ordered'::text THEN (s.ordered_at AT TIME ZONE 'Australia/Perth'::text)::date
                    ELSE COALESCE(s.delivery_date, s.created_at::date)
                END AS event_date,
            'materials'::text AS lane,
            'purchase_order'::text AS lane_detail,
            'supplier'::text AS party_kind,
            NULL::text AS party_id,
            COALESCE(NULLIF(btrim(s.supplier_name), ''::text), 'Unnamed supplier'::text) AS party,
                CASE
                    WHEN s.unpriced THEN NULL::numeric
                    ELSE s.po_amount_ex
                END AS amount_ex,
            s.state AS source,
            s.id::text AS source_id,
            s.id::text AS document_id,
            s.po_number AS document_number,
            s.status AS document_status,
            false AS paid,
            NULL::date AS paid_on,
                CASE s.state
                    WHEN 'po_invoice_emailed'::text THEN 'invoice_emailed'::text
                    WHEN 'po_ordered'::text THEN 'ordered_not_billed'::text
                    ELSE 'committed'::text
                END AS confidence,
            false AS is_actual,
            s.notes AS description,
            NULL::numeric AS hours,
            NULL::text AS account_code,
            NULL::text AS business_unit,
            'purchase_orders.job_id'::text AS match_method,
            false AS incomplete_invoice
           FROM po_state s
        )
 SELECT p.job_id,l.document_date AS event_date,p.lane,l.event_lane_detail AS lane_detail,
 l.party_kind,l.party_id,l.party_name AS party,p.amount_ex,l.event_source AS source,
 coalesce(l.event_source_id,l.id::text) || CASE WHEN
  (SELECT count(*) FROM public.job_cost_line_parts s WHERE s.line_id=l.id)>1
  THEN ':part'||p.part_no::text ELSE '' END AS source_id,
 l.document_id,l.document_number,l.document_status,l.paid,l.paid_on,
 l.event_confidence AS confidence,l.is_actual,l.description,l.hours,l.account_code,
 l.business_unit,l.event_match_method AS match_method,l.incomplete_invoice,
 l.id AS cost_line_id,l.kind AS cost_kind
 FROM public.job_cost_line_parts p JOIN public.job_cost_lines l ON l.id=p.line_id
 WHERE p.target='job' AND l.state IS NOT NULL
 UNION ALL
 -- P2-03.1 replaces this typed, empty suggestion stand-in. No reconcile store
 -- exists yet; never invent a job for an installer bill awaiting a person.
 SELECT s.job_id,l.document_date,l.lane,l.event_lane_detail,
 l.party_kind,l.party_id,l.party_name,l.amount_ex,'installer_bill_unconfirmed'::text,
 coalesce(l.event_source_id,l.id::text),l.document_id,l.document_number,l.document_status,
 l.paid,l.paid_on,l.event_confidence,false,l.description,l.hours,l.account_code,
 l.business_unit,l.event_match_method,l.incomplete_invoice,l.id,l.kind
 FROM public.job_cost_lines l JOIN
 (SELECT NULL::text document_id,NULL::uuid job_id WHERE false) s ON s.document_id=l.document_id
 WHERE l.kind='installer_bill' AND l.state='needs_person'
 UNION ALL SELECT po.*,NULL::uuid,NULL::text FROM po;

REVOKE ALL ON public.v_job_cost_events_legacy,public.v_job_cost_events_lines FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.v_job_cost_events_legacy,public.v_job_cost_events_lines TO service_role;
INSERT INTO public.feature_flags(flag_name,enabled,description)
VALUES('job_cost_events_from_cost_lines_v1',false,'Read Job Profit cost events from counted cost line parts')
ON CONFLICT(flag_name) DO NOTHING;

-- Follow-up 25: the flag alone never abandons legacy costs. P2-01.8 must
-- finish ALL three historical document backfills and install the trade hooks
-- before its future completion writer may set completed_at. This migration
-- seeds only an unset marker and supplies no completion writer.
-- A singleton is bounded forever; no trim or growing progress ledger is needed.
CREATE TABLE IF NOT EXISTS public.job_cost_events_cutover (
 singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
 bills_backfilled_at timestamptz,
 credits_backfilled_at timestamptz,
 trade_backfilled_at timestamptz,
 trade_triggers_installed_at timestamptz,
 completed_at timestamptz,
 CHECK (completed_at IS NULL OR
  (bills_backfilled_at IS NOT NULL AND credits_backfilled_at IS NOT NULL
   AND trade_backfilled_at IS NOT NULL AND trade_triggers_installed_at IS NOT NULL))
);
ALTER TABLE public.job_cost_events_cutover ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.job_cost_events_cutover FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.job_cost_events_cutover TO service_role;
DROP POLICY IF EXISTS job_cost_events_cutover_read ON public.job_cost_events_cutover;
CREATE POLICY job_cost_events_cutover_read ON public.job_cost_events_cutover FOR SELECT TO service_role USING (true);
INSERT INTO public.job_cost_events_cutover(singleton) VALUES(true) ON CONFLICT DO NOTHING;

CREATE OR REPLACE VIEW public.v_job_cost_events AS
 WITH cutover AS MATERIALIZED (
  SELECT EXISTS(SELECT 1 FROM public.feature_flags ff
   WHERE ff.flag_name='job_cost_events_from_cost_lines_v1' AND ff.enabled)
   AND EXISTS(SELECT 1 FROM public.job_cost_events_cutover c
    WHERE c.singleton AND c.completed_at IS NOT NULL) AS ready
 )
 SELECT l.* FROM public.v_job_cost_events_lines l WHERE (SELECT ready FROM cutover)
 UNION ALL
 SELECT g.*,NULL::uuid cost_line_id,NULL::text cost_kind FROM public.v_job_cost_events_legacy g
 WHERE NOT (SELECT ready FROM cutover);

ALTER TABLE public.job_cost_events_stored ADD COLUMN IF NOT EXISTS cost_line_id uuid,
 ADD COLUMN IF NOT EXISTS cost_kind text;

-- Calls use the line/part unique index and the dirty queue's job primary key.
-- No background lock is acquired. An already-locked dirty row is skipped with
-- a warning rather than waiting on a refresh or failing the business write.
CREATE OR REPLACE FUNCTION public.job_cost_events_mark_job(p_job_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE prior_timeout text:=current_setting('lock_timeout');
/* block */ BEGIN
 IF p_job_id IS NULL THEN RETURN; END IF;
 PERFORM set_config('lock_timeout','1ms',true);
 /* subblock */ BEGIN
  PERFORM public.job_profit_mark(p_job_id,'cost_line');
 EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'cost_line profit mark unavailable: %',SQLSTATE;
 END;
 /* subblock */ BEGIN
  IF to_regprocedure('public.job_mark_changed(uuid,text)') IS NOT NULL THEN
   EXECUTE 'SELECT public.job_mark_changed($1,$2)' USING p_job_id,'cost_line';
  END IF;
 EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'cost_line page mark unavailable: %',SQLSTATE;
 END;
 PERFORM set_config('lock_timeout',prior_timeout,true);
END $fn$;

CREATE OR REPLACE FUNCTION public.job_cost_events_dirty_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE line_ids uuid[]:='{}'; job_ids uuid[]:='{}'; j uuid;
/* block */ BEGIN
 IF TG_TABLE_NAME='job_cost_line_parts' THEN
  IF TG_OP<>'INSERT' THEN
   line_ids:=array_append(line_ids,OLD.line_id); job_ids:=array_append(job_ids,OLD.job_id);
  END IF;
  IF TG_OP<>'DELETE' THEN
   line_ids:=array_append(line_ids,NEW.line_id); job_ids:=array_append(job_ids,NEW.job_id);
  END IF;
 ELSE
  line_ids:=ARRAY[OLD.id,NEW.id];
 END IF;
 -- (line_id,part_no) unique index bounds each line's old/new allocation read.
 FOR j IN SELECT p.job_id FROM public.job_cost_line_parts p WHERE p.line_id=ANY(line_ids) AND p.job_id IS NOT NULL
 UNION SELECT unnest(job_ids) LOOP
  PERFORM public.job_cost_events_mark_job(j);
 END LOOP;
 RETURN NULL;
EXCEPTION WHEN OTHERS THEN
 RAISE WARNING 'cost_line invalidation unavailable: %',SQLSTATE;
 RETURN NULL;
END $fn$;

CREATE OR REPLACE FUNCTION public.job_cost_events_switch_dirty_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE prior_timeout text:=current_setting('lock_timeout');
/* block */ BEGIN
 IF TG_TABLE_NAME='feature_flags' THEN
  IF OLD.enabled IS NOT DISTINCT FROM NEW.enabled THEN RETURN NULL; END IF;
 ELSE
  IF OLD.completed_at IS NOT DISTINCT FROM NEW.completed_at THEN RETURN NULL; END IF;
 END IF;
 PERFORM set_config('lock_timeout','1ms',true);
 /* subblock */ BEGIN
  -- Intentional one-time whole jobs_pkey scan on an explicit switch change.
  -- job_profit_dirty is one row per job, consumed by job_profit_refresh_marked.
  INSERT INTO public.job_profit_dirty(job_id,reason,marked_at)
  SELECT j.id,'switch',clock_timestamp() FROM public.jobs j WHERE true
  ON CONFLICT(job_id) DO UPDATE SET reason='switch',marked_at=EXCLUDED.marked_at;
 EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'cost events switch invalidation unavailable: %',SQLSTATE;
 END;
 PERFORM set_config('lock_timeout',prior_timeout,true);
 RETURN NULL;
END $fn$;

CREATE OR REPLACE FUNCTION public.install_job_cost_events_from_cost_lines() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
/* block */ BEGIN
 DROP TRIGGER IF EXISTS job_cost_events_parts_dirty ON public.job_cost_line_parts;
 CREATE TRIGGER job_cost_events_parts_dirty AFTER INSERT OR UPDATE OR DELETE ON public.job_cost_line_parts
 FOR EACH ROW EXECUTE FUNCTION public.job_cost_events_dirty_trg();
 DROP TRIGGER IF EXISTS job_cost_events_lines_dirty ON public.job_cost_lines;
 CREATE TRIGGER job_cost_events_lines_dirty AFTER UPDATE OF state,amount_ex,document_status,is_actual ON public.job_cost_lines
 FOR EACH ROW EXECUTE FUNCTION public.job_cost_events_dirty_trg();
 DROP TRIGGER IF EXISTS job_cost_events_cutover_dirty ON public.job_cost_events_cutover;
 CREATE TRIGGER job_cost_events_cutover_dirty AFTER UPDATE OF completed_at ON public.job_cost_events_cutover
 FOR EACH ROW EXECUTE FUNCTION public.job_cost_events_switch_dirty_trg();
 DROP TRIGGER IF EXISTS job_cost_events_switch_dirty ON public.feature_flags;
 CREATE TRIGGER job_cost_events_switch_dirty AFTER UPDATE OF enabled ON public.feature_flags
 FOR EACH ROW WHEN (NEW.flag_name IN ('job_cost_events_from_cost_lines_v1','job_profit_expected_from_job_budget'))
 EXECUTE FUNCTION public.job_cost_events_switch_dirty_trg();
END $fn$;
CREATE OR REPLACE FUNCTION public.remove_job_cost_events_from_cost_lines() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
/* block */ BEGIN
 DROP TRIGGER IF EXISTS job_cost_events_parts_dirty ON public.job_cost_line_parts;
 DROP TRIGGER IF EXISTS job_cost_events_lines_dirty ON public.job_cost_lines;
 DROP TRIGGER IF EXISTS job_cost_events_switch_dirty ON public.feature_flags;
 DROP TRIGGER IF EXISTS job_cost_events_cutover_dirty ON public.job_cost_events_cutover;
END $fn$;
REVOKE ALL ON FUNCTION public.job_cost_events_mark_job(uuid),public.job_cost_events_dirty_trg(),
 public.job_cost_events_switch_dirty_trg(),public.install_job_cost_events_from_cost_lines(),
 public.remove_job_cost_events_from_cost_lines() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.job_cost_events_mark_job(uuid),public.job_cost_events_dirty_trg(),
 public.job_cost_events_switch_dirty_trg(),public.install_job_cost_events_from_cost_lines(),
 public.remove_job_cost_events_from_cost_lines() TO service_role;
