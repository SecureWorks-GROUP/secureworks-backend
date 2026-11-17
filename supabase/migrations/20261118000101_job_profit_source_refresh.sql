-- P0-09.4, Scope A: source marks and daily date-hold refresh only.
-- No existing function is replaced. No trigger/schedule is installed on merge.
-- job_profit_refresh_v1 is seeded OFF. Read views/book belong to another lane.
-- Install requires the bounded refill functions of FU21 (partner change).
SET LOCAL lock_timeout = '5s';
INSERT INTO public.feature_flags(flag_name,enabled,description)
VALUES ('job_profit_refresh_v1',false,'Explicitly installed stored-profit source marks and bounded daily refresh')
ON CONFLICT(flag_name) DO NOTHING;

-- Source transactions append only. Neither the folder nor refresher locks a row
-- a source writer updates. No FK back to jobs: deletion must remain non-blocking.
-- Trim: each refresh tick deletes at most 200 exact queue ids after folding them.
CREATE TABLE IF NOT EXISTS public.job_profit_change_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 job_id uuid NOT NULL,
 reason text NOT NULL
);
ALTER TABLE public.job_profit_change_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.job_profit_change_events FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,DELETE ON public.job_profit_change_events TO service_role;
REVOKE ALL ON SEQUENCE public.job_profit_change_events_id_seq FROM PUBLIC,anon,authenticated;
GRANT USAGE ON SEQUENCE public.job_profit_change_events_id_seq TO service_role;

-- One bounded cursor, overwritten, never an accumulating run history.
CREATE TABLE IF NOT EXISTS public.job_profit_daily_cursor (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 sweep_day date NOT NULL,
 after_job_id uuid,
 done boolean NOT NULL DEFAULT false
);
ALTER TABLE public.job_profit_daily_cursor ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.job_profit_daily_cursor FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.job_profit_daily_cursor TO service_role;

CREATE OR REPLACE FUNCTION public.job_profit_source_changed(p_table text,p_old jsonb,p_new jsonb,p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET lock_timeout='25ms' AS $fn$
DECLARE row_data jsonb; job_ids uuid[]:='{}'; ids uuid[]; job uuid; tokens text[];
/* block */ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.feature_flags WHERE flag_name='job_profit_refresh_v1' AND enabled) THEN RETURN; END IF;
 IF p_old IS NOT NULL AND p_new IS NOT NULL THEN
  IF p_table='xero_invoices' AND p_old-'synced_at'-'updated_at'=p_new-'synced_at'-'updated_at' THEN RETURN; END IF;
  IF p_table<>'jobs' AND p_old=p_new THEN RETURN; END IF;
 END IF;
 FOREACH row_data IN ARRAY ARRAY[p_old,p_new] LOOP
  CONTINUE WHEN row_data IS NULL;
  job_ids:=array_append(job_ids,(row_data->>CASE WHEN p_table='jobs' THEN 'id' ELSE 'job_id' END)::uuid);
  IF p_table='trade_invoices' THEN
   -- idx_inv_lines_invoice (trade_invoice_id). Cascade child deletes also mark
   -- their own OLD.job_id, even after the header is no longer visible.
   SELECT array_agg(DISTINCT l.job_id) INTO ids FROM public.trade_invoice_lines l
    WHERE l.trade_invoice_id=(row_data->>'id')::uuid;
   job_ids:=job_ids||coalesce(ids,'{}');
  ELSIF p_table='group_work_order_shares' THEN
   -- group_work_orders_pkey. Parent deletes/relinks have their own trigger.
   SELECT ARRAY[g.job_id] INTO ids FROM public.group_work_orders g WHERE g.id=(row_data->>'group_id')::uuid;
   job_ids:=job_ids||coalesce(ids,'{}');
  ELSIF p_table='xero_supplier_credit_note_allocations' THEN
   -- xero_invoices_xero_invoice_id_idx, job_materials_facts_invoice_idx.
   SELECT array_agg(job_id) INTO ids FROM (
    SELECT x.job_id FROM public.xero_invoices x WHERE x.xero_invoice_id=row_data->>'xero_invoice_id'
    UNION SELECT f.job_id FROM public.job_materials_facts f WHERE f.xero_invoice_id=row_data->>'xero_invoice_id'
   ) linked;
   job_ids:=job_ids||coalesce(ids,'{}');
  ELSIF p_table='xero_invoices' THEN
   SELECT array_agg(DISTINCT upper(m[1])) INTO tokens FROM regexp_matches(
    coalesce(row_data->>'reference','')||' '||coalesce(row_data->>'invoice_number','')||' '||coalesce(row_data->>'line_items',''),
    '(SW[A-Z]{0,5}-[0-9]{3,6})','gi') m;
   -- jobs_context_job_number_upper, exact token lookup, never a scan per job.
   SELECT array_agg(j.id) INTO ids FROM public.jobs j WHERE upper(j.job_number)=ANY(tokens);
   job_ids:=job_ids||coalesce(ids,'{}');
  END IF;
 END LOOP;
 FOR job IN SELECT DISTINCT j FROM unnest(job_ids) j WHERE j IS NOT NULL ORDER BY j LOOP
  INSERT INTO public.job_profit_change_events(job_id,reason) VALUES(job,p_reason);
  IF to_regprocedure('public.job_mark_changed(uuid,text)') IS NOT NULL THEN
   PERFORM public.job_mark_changed(job,p_reason);
  END IF;
 END LOOP;
EXCEPTION WHEN OTHERS THEN
 -- Failed marks never fail a business write. The whole helper subtransaction
 -- rolls back, and the daily sweep is the recovery net. No row content is logged.
 RAISE WARNING 'job_profit_source_mark_failed table=% code=%',p_table,SQLSTATE;
END $fn$;

CREATE OR REPLACE FUNCTION public.job_profit_job_materials_facts_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$ BEGIN
 PERFORM public.job_profit_source_changed('job_materials_facts',
  CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) END,
  CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) END,'materials_fact');
 RETURN NULL;
END $fn$;

CREATE OR REPLACE FUNCTION public.job_profit_trade_invoice_lines_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$ BEGIN
 PERFORM public.job_profit_source_changed('trade_invoice_lines',
  CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) END,
  CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) END,'crew_line');
 RETURN NULL;
END $fn$;

CREATE OR REPLACE FUNCTION public.job_profit_trade_invoices_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$ BEGIN
 PERFORM public.job_profit_source_changed('trade_invoices',
  CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) END,
  CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) END,'crew_invoice');
 RETURN NULL;
END $fn$;

CREATE OR REPLACE FUNCTION public.job_profit_purchase_orders_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$ BEGIN
 PERFORM public.job_profit_source_changed('purchase_orders',
  CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) END,
  CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) END,'order');
 RETURN NULL;
END $fn$;

CREATE OR REPLACE FUNCTION public.job_profit_job_budgets_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$ BEGIN
 PERFORM public.job_profit_source_changed('job_budgets',
  CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) END,
  CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) END,'budget');
 RETURN NULL;
END $fn$;

CREATE OR REPLACE FUNCTION public.job_profit_xero_invoices_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$ BEGIN
 PERFORM public.job_profit_source_changed('xero_invoices',
  CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) END,
  CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) END,'xero_invoice');
 RETURN NULL;
END $fn$;

CREATE OR REPLACE FUNCTION public.job_profit_xero_supplier_credit_note_allocations_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$ BEGIN
 PERFORM public.job_profit_source_changed('xero_supplier_credit_note_allocations',
  CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) END,
  CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) END,'credit');
 RETURN NULL;
END $fn$;

CREATE OR REPLACE FUNCTION public.job_profit_jobs_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$ BEGIN
 -- Do not to_jsonb a jobs row: that would detoast unrelated scope/media blobs.
 IF TG_OP='UPDATE' AND ROW(OLD.id,OLD.org_id,OLD.job_number,OLD.client_name,OLD.type,OLD.status,OLD.metadata,OLD.expected_costs,OLD.pricing_json,OLD.completed_at,OLD.created_at,OLD.legacy) IS NOT DISTINCT FROM ROW(NEW.id,NEW.org_id,NEW.job_number,NEW.client_name,NEW.type,NEW.status,NEW.metadata,NEW.expected_costs,NEW.pricing_json,NEW.completed_at,NEW.created_at,NEW.legacy) THEN RETURN NULL; END IF;
 PERFORM public.job_profit_source_changed('jobs',
  CASE WHEN TG_OP<>'INSERT' THEN jsonb_build_object('id',OLD.id) END,
  CASE WHEN TG_OP<>'DELETE' THEN jsonb_build_object('id',NEW.id) END,'job');
 RETURN NULL;
END $fn$;

CREATE OR REPLACE FUNCTION public.job_profit_work_orders_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$ BEGIN
 PERFORM public.job_profit_source_changed('work_orders',
  CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) END,
  CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) END,'work_order');
 RETURN NULL;
END $fn$;

CREATE OR REPLACE FUNCTION public.job_profit_group_work_order_shares_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$ BEGIN
 PERFORM public.job_profit_source_changed('group_work_order_shares',
  CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) END,
  CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) END,'group_share');
 RETURN NULL;
END $fn$;

CREATE OR REPLACE FUNCTION public.job_profit_group_work_orders_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$ BEGIN
 PERFORM public.job_profit_source_changed('group_work_orders',
  CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) END,
  CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) END,'group_work_order');
 RETURN NULL;
END $fn$;

-- Timer entry point: at most 200 appended changes folded, 200 jobs refreshed.
-- It takes no business-table lock. The advisory lock is background-only.
CREATE OR REPLACE FUNCTION public.job_profit_refresh_due() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET lock_timeout='5s' AS $fn$
DECLARE event_ids bigint[]; job_ids uuid[]; job uuid; result jsonb; tail_ids uuid[];
/* block */ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.feature_flags WHERE flag_name='job_profit_refresh_v1' AND enabled) THEN RETURN '{"state":"off"}'; END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('job_profit_refresh_worker_v1',0)) THEN RETURN '{"state":"busy"}'; END IF;
 -- job_profit_change_events_pkey serves this bounded queue page. Source writers
 -- only insert NEW rows and cannot wait on these FOR UPDATE locks.
 WITH picked AS MATERIALIZED (
  SELECT id,job_id FROM public.job_profit_change_events ORDER BY id LIMIT 200 FOR UPDATE SKIP LOCKED
 ) SELECT array_agg(id),array_agg(DISTINCT job_id ORDER BY job_id) INTO event_ids,job_ids FROM picked;
 FOREACH job IN ARRAY coalesce(job_ids,'{}') LOOP
  PERFORM public.job_profit_mark(job,'source_change');
 END LOOP;
 DELETE FROM public.job_profit_change_events WHERE id=ANY(event_ids);
 -- Source changes go first, so the daily net cannot delay fresh money behind
 -- its backlog. Fill spare capacity through job_profit_dirty_oldest_idx.
 SELECT array_agg(job_id ORDER BY marked_at,job_id) INTO tail_ids FROM (
  SELECT job_id,marked_at FROM public.job_profit_dirty
  WHERE NOT(job_id=ANY(coalesce(job_ids,'{}')))
  ORDER BY marked_at,job_id LIMIT (200-coalesce(cardinality(job_ids),0))
 ) oldest;
 -- One existing authoritative writer call. No full dirty-table count on a timer.
 -- A failure rolls back fold/deletion too, leaving an exact retry next tick.
 result:=public.job_profit_refresh_many(coalesce(job_ids,'{}')||coalesce(tail_ids,'{}'));
 RETURN result||jsonb_build_object('folded',coalesce(cardinality(event_ids),0));
END $fn$;

-- Daily net: all jobs, including closed jobs with date-based holds, in keyset
-- pages of 500. Starts at 01:20 Perth, continues on later minute ticks until done.
-- This replaces the unbounded nightly refresh-all loop, not its money logic.
CREATE OR REPLACE FUNCTION public.job_profit_daily_mark() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET lock_timeout='5s' AS $fn$
DECLARE day_now date; local_now timestamp; cursor_row public.job_profit_daily_cursor; job_ids uuid[]; job uuid;
/* block */ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.feature_flags WHERE flag_name='job_profit_refresh_v1' AND enabled) THEN RETURN '{"state":"off"}'; END IF;
 local_now:=clock_timestamp() AT TIME ZONE 'Australia/Perth';
 day_now:=(local_now-interval '80 minutes')::date;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('job_profit_refresh_worker_v1',0)) THEN RETURN '{"state":"busy"}'; END IF;
 SELECT * INTO cursor_row FROM public.job_profit_daily_cursor WHERE singleton;
 IF cursor_row.sweep_day=day_now AND cursor_row.done THEN RETURN '{"state":"done","marked":0}'; END IF;
 IF cursor_row.sweep_day IS DISTINCT FROM day_now THEN cursor_row.after_job_id:=NULL; END IF;
 -- jobs_pkey, separate first/continuation branches so both are index range reads.
 IF cursor_row.after_job_id IS NULL THEN
  SELECT array_agg(id ORDER BY id) INTO job_ids FROM (SELECT id FROM public.jobs ORDER BY id LIMIT 500) page;
 ELSE
  SELECT array_agg(id ORDER BY id) INTO job_ids FROM (SELECT id FROM public.jobs WHERE id>cursor_row.after_job_id ORDER BY id LIMIT 500) page;
 END IF;
 FOREACH job IN ARRAY coalesce(job_ids,'{}') LOOP
  PERFORM public.job_profit_mark(job,'daily_date_hold');
 END LOOP;
 INSERT INTO public.job_profit_daily_cursor(singleton,sweep_day,after_job_id,done)
 VALUES(true,day_now,coalesce(job_ids[cardinality(job_ids)],cursor_row.after_job_id),coalesce(cardinality(job_ids),0)<500)
 ON CONFLICT(singleton) DO UPDATE SET sweep_day=EXCLUDED.sweep_day,after_job_id=EXCLUDED.after_job_id,done=EXCLUDED.done;
 RETURN jsonb_build_object('marked',coalesce(cardinality(job_ids),0),'done',coalesce(cardinality(job_ids),0)<500);
END $fn$;

CREATE OR REPLACE FUNCTION public.job_profit_refresh_install() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$ BEGIN
 IF to_regprocedure('public.job_profit_refresh_all(uuid,integer)') IS NULL THEN
  RAISE EXCEPTION 'job_profit_bounded_refill_required';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_cron') THEN RAISE EXCEPTION 'job_profit_pg_cron_required'; END IF;
 DROP TRIGGER IF EXISTS job_profit_changed ON public.job_materials_facts;
 CREATE TRIGGER job_profit_changed AFTER INSERT OR UPDATE OR DELETE ON public.job_materials_facts FOR EACH ROW EXECUTE FUNCTION public.job_profit_job_materials_facts_trg();
 DROP TRIGGER IF EXISTS job_profit_changed ON public.trade_invoice_lines;
 CREATE TRIGGER job_profit_changed AFTER INSERT OR UPDATE OR DELETE ON public.trade_invoice_lines FOR EACH ROW EXECUTE FUNCTION public.job_profit_trade_invoice_lines_trg();
 DROP TRIGGER IF EXISTS job_profit_changed ON public.trade_invoices;
 CREATE TRIGGER job_profit_changed AFTER INSERT OR UPDATE OR DELETE ON public.trade_invoices FOR EACH ROW EXECUTE FUNCTION public.job_profit_trade_invoices_trg();
 DROP TRIGGER IF EXISTS job_profit_changed ON public.purchase_orders;
 CREATE TRIGGER job_profit_changed AFTER INSERT OR UPDATE OR DELETE ON public.purchase_orders FOR EACH ROW EXECUTE FUNCTION public.job_profit_purchase_orders_trg();
 DROP TRIGGER IF EXISTS job_profit_changed ON public.job_budgets;
 CREATE TRIGGER job_profit_changed AFTER INSERT OR UPDATE OR DELETE ON public.job_budgets FOR EACH ROW EXECUTE FUNCTION public.job_profit_job_budgets_trg();
 DROP TRIGGER IF EXISTS job_profit_changed ON public.xero_invoices;
 CREATE TRIGGER job_profit_changed AFTER INSERT OR UPDATE OR DELETE ON public.xero_invoices FOR EACH ROW EXECUTE FUNCTION public.job_profit_xero_invoices_trg();
 DROP TRIGGER IF EXISTS job_profit_changed ON public.xero_supplier_credit_note_allocations;
 CREATE TRIGGER job_profit_changed AFTER INSERT OR UPDATE OR DELETE ON public.xero_supplier_credit_note_allocations FOR EACH ROW EXECUTE FUNCTION public.job_profit_xero_supplier_credit_note_allocations_trg();
 DROP TRIGGER IF EXISTS job_profit_changed ON public.jobs;
 CREATE TRIGGER job_profit_changed AFTER INSERT OR UPDATE OF id,org_id,job_number,client_name,type,status,metadata,expected_costs,pricing_json,completed_at,created_at,legacy OR DELETE ON public.jobs FOR EACH ROW EXECUTE FUNCTION public.job_profit_jobs_trg();
 DROP TRIGGER IF EXISTS job_profit_changed ON public.work_orders;
 CREATE TRIGGER job_profit_changed AFTER INSERT OR UPDATE OR DELETE ON public.work_orders FOR EACH ROW EXECUTE FUNCTION public.job_profit_work_orders_trg();
 DROP TRIGGER IF EXISTS job_profit_changed ON public.group_work_order_shares;
 CREATE TRIGGER job_profit_changed AFTER INSERT OR UPDATE OR DELETE ON public.group_work_order_shares FOR EACH ROW EXECUTE FUNCTION public.job_profit_group_work_order_shares_trg();
 DROP TRIGGER IF EXISTS job_profit_changed ON public.group_work_orders;
 CREATE TRIGGER job_profit_changed AFTER INSERT OR UPDATE OR DELETE ON public.group_work_orders FOR EACH ROW EXECUTE FUNCTION public.job_profit_group_work_orders_trg();
 -- The deadline is set BEFORE either statement starts (FU21's admission).
 PERFORM cron.schedule('job-profit-refresh-marked','* * * * *',
  $cron$SET statement_timeout='120s'; SELECT public.job_profit_refresh_due();$cron$);
 PERFORM cron.schedule('job-profit-refresh-daily','* * * * *',
  $cron$SET statement_timeout='120s'; SELECT public.job_profit_daily_mark();$cron$);
 -- Does not turn on the worker or reader switches. Director activates separately.
END $fn$;

CREATE OR REPLACE FUNCTION public.job_profit_refresh_remove() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$ BEGIN
 DROP TRIGGER IF EXISTS job_profit_changed ON public.job_materials_facts;
 DROP TRIGGER IF EXISTS job_profit_changed ON public.trade_invoice_lines;
 DROP TRIGGER IF EXISTS job_profit_changed ON public.trade_invoices;
 DROP TRIGGER IF EXISTS job_profit_changed ON public.purchase_orders;
 DROP TRIGGER IF EXISTS job_profit_changed ON public.job_budgets;
 DROP TRIGGER IF EXISTS job_profit_changed ON public.xero_invoices;
 DROP TRIGGER IF EXISTS job_profit_changed ON public.xero_supplier_credit_note_allocations;
 DROP TRIGGER IF EXISTS job_profit_changed ON public.jobs;
 DROP TRIGGER IF EXISTS job_profit_changed ON public.work_orders;
 DROP TRIGGER IF EXISTS job_profit_changed ON public.group_work_order_shares;
 DROP TRIGGER IF EXISTS job_profit_changed ON public.group_work_orders;
 IF EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_cron') THEN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname IN('job-profit-refresh-marked','job-profit-refresh-daily');
 END IF;
 -- Queued work, dirty marks, stored figures and the daily cursor are retained.
END $fn$;

-- Not covered by a trigger, caught by the nightly refresh:
-- feature_flags, job_client_signoffs, job_cost_crew_super_rulings, job_documents,
-- job_order_emails, job_variations, makesafe_job_details, materials_reconciliation_queue,
-- quote_revisions, users, work_order_customer_variations, xero_projects,
-- xero_supplier_credit_notes, and base tables behind the bookkeeping evidence views.
-- Changing budget/patio/cost-policy switches still needs the director's full refill.
REVOKE ALL ON FUNCTION public.job_profit_source_changed(text,jsonb,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.job_profit_source_changed(text,jsonb,jsonb,text) TO service_role;
REVOKE ALL ON FUNCTION public.job_profit_refresh_due() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.job_profit_refresh_due() TO service_role;
REVOKE ALL ON FUNCTION public.job_profit_daily_mark() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.job_profit_daily_mark() TO service_role;
REVOKE ALL ON FUNCTION public.job_profit_refresh_install() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.job_profit_refresh_install() TO service_role;
REVOKE ALL ON FUNCTION public.job_profit_refresh_remove() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.job_profit_refresh_remove() TO service_role;
REVOKE ALL ON FUNCTION public.job_profit_job_materials_facts_trg() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.job_profit_job_materials_facts_trg() TO service_role;
REVOKE ALL ON FUNCTION public.job_profit_trade_invoice_lines_trg() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.job_profit_trade_invoice_lines_trg() TO service_role;
REVOKE ALL ON FUNCTION public.job_profit_trade_invoices_trg() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.job_profit_trade_invoices_trg() TO service_role;
REVOKE ALL ON FUNCTION public.job_profit_purchase_orders_trg() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.job_profit_purchase_orders_trg() TO service_role;
REVOKE ALL ON FUNCTION public.job_profit_job_budgets_trg() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.job_profit_job_budgets_trg() TO service_role;
REVOKE ALL ON FUNCTION public.job_profit_xero_invoices_trg() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.job_profit_xero_invoices_trg() TO service_role;
REVOKE ALL ON FUNCTION public.job_profit_xero_supplier_credit_note_allocations_trg() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.job_profit_xero_supplier_credit_note_allocations_trg() TO service_role;
REVOKE ALL ON FUNCTION public.job_profit_jobs_trg() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.job_profit_jobs_trg() TO service_role;
REVOKE ALL ON FUNCTION public.job_profit_work_orders_trg() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.job_profit_work_orders_trg() TO service_role;
REVOKE ALL ON FUNCTION public.job_profit_group_work_order_shares_trg() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.job_profit_group_work_order_shares_trg() TO service_role;
REVOKE ALL ON FUNCTION public.job_profit_group_work_orders_trg() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.job_profit_group_work_orders_trg() TO service_role;
