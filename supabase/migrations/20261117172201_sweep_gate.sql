-- P0-05.3: run-on-change tokens. No schedule or trigger is installed here.
CREATE TABLE IF NOT EXISTS public.sweep_gate_state (
  name text PRIMARY KEY,
  confirmed_token text,
  confirmed_at timestamptz,
  last_token text,
  last_posted_at timestamptz
);
ALTER TABLE public.sweep_gate_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sweep_gate_state FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.sweep_gate_tables_token(p_tables text[])
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT md5(coalesce(string_agg(t.relname || ':' || (t.n_tup_ins + t.n_tup_upd + t.n_tup_del)::text,
                                '|' ORDER BY t.relname), ''))
  FROM pg_stat_user_tables t
  WHERE t.schemaname = 'public' AND t.relname = ANY (p_tables)
$$;

CREATE OR REPLACE FUNCTION public.sweep_gate_should_post(p_name text, p_token text, p_heartbeat interval)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s public.sweep_gate_state%ROWTYPE; go boolean; BEGIN
  IF NOT COALESCE((SELECT f.enabled FROM public.feature_flags f
                   WHERE f.flag_name = 'sweep_gate_v1' LIMIT 1), false) THEN
    RETURN true;
  END IF;
  SELECT * INTO s FROM public.sweep_gate_state WHERE name = p_name;
  go := s.name IS NULL OR s.confirmed_at IS NULL
        OR s.confirmed_token IS DISTINCT FROM p_token
        OR s.confirmed_at < now() - p_heartbeat;
  IF go THEN
    INSERT INTO public.sweep_gate_state (name, last_token, last_posted_at)
    VALUES (p_name, p_token, now())
    ON CONFLICT (name) DO UPDATE SET last_token = excluded.last_token, last_posted_at = excluded.last_posted_at;
  END IF;
  RETURN go;
END $$;

CREATE OR REPLACE FUNCTION public.sweep_gate_confirm(p_name text, p_token text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO public.sweep_gate_state (name, confirmed_token, confirmed_at)
  VALUES (p_name, p_token, now())
  ON CONFLICT (name) DO UPDATE SET confirmed_token = excluded.confirmed_token, confirmed_at = excluded.confirmed_at
$$;

CREATE OR REPLACE FUNCTION public.materials_ingest_change_parts(p_org_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'bills', (SELECT jsonb_build_object('count', count(*), 'newest_updated_at', max(i.updated_at)::text)
              FROM public.xero_invoices i
              WHERE i.org_id = p_org_id AND i.invoice_type = 'ACCPAY'
                AND NOT EXISTS (SELECT 1 FROM public.trade_invoices ti WHERE ti.xero_bill_id = i.xero_invoice_id)),
    'orders', (SELECT md5(string_agg(concat_ws(',', id, po_number, xero_contact_id, status,
                        subtotal, total, job_id, xero_bill_id, delivery_date), ';' ORDER BY id))
               FROM public.purchase_orders),
    'mirrors', (SELECT count(*) FROM public.trade_invoices WHERE xero_bill_id IS NOT NULL),
    'ours', public.sweep_gate_tables_token(ARRAY['job_materials_facts','materials_reconciliation_queue'])
  )
$$;

CREATE OR REPLACE FUNCTION public.materials_ingest_change_token(p_org_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT md5(public.materials_ingest_change_parts(p_org_id)::text)
$$;

CREATE OR REPLACE FUNCTION public.bill_prematch_change_token(p_org_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT md5(public.materials_ingest_change_token(p_org_id) || '|' ||
    public.sweep_gate_tables_token(ARRAY['materials_bill_proposals']) || '|' ||
    (SELECT count(*)::text FROM public.context_email_attachments))
$$;

CREATE OR REPLACE FUNCTION public.trigger_xero_sync_action_gated(
  p_action text, p_gate text, p_token text, p_heartbeat interval
) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$ BEGIN
  IF p_action IS NULL OR p_action NOT IN ('ingest_materials_recent', 'bill_prematch') THEN
    RAISE EXCEPTION 'xero_sync_action_not_gated: %', p_action;
  END IF;
  IF NOT public.sweep_gate_should_post(p_gate, p_token, p_heartbeat) THEN RETURN NULL; END IF;
  RETURN net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/xero-sync?action=' || p_action ||
           '&gate=' || p_gate || '&gate_token=' || p_token,
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'Authorization', 'Bearer ' || public.sw_service_key(),
                                  'x-sw-actor', 'xero-sync-tail-cron'),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000);
END $$;

REVOKE ALL ON FUNCTION public.sweep_gate_tables_token(text[]),
  public.sweep_gate_should_post(text, text, interval), public.sweep_gate_confirm(text, text),
  public.materials_ingest_change_parts(uuid), public.materials_ingest_change_token(uuid),
  public.bill_prematch_change_token(uuid), public.trigger_xero_sync_action_gated(text, text, text, interval)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sweep_gate_tables_token(text[]),
  public.sweep_gate_should_post(text, text, interval), public.sweep_gate_confirm(text, text),
  public.materials_ingest_change_parts(uuid), public.materials_ingest_change_token(uuid),
  public.bill_prematch_change_token(uuid), public.trigger_xero_sync_action_gated(text, text, text, interval)
  TO service_role, postgres;

INSERT INTO public.feature_flags (flag_name, enabled, description)
VALUES ('sweep_gate_v1', false, 'Timers post only when their tables changed or the heartbeat is due')
ON CONFLICT (flag_name) DO NOTHING;
