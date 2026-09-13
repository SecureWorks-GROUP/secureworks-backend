-- Debt-owned Refresh source and assess command table.
-- Lands on CIO SHA 5f03d6fd (debt_source_v1). Does not register on 12da8360.
-- Does not write xero_invoices amounts, does not send, does not apply cache repair.

ALTER TABLE public.xero_invoices ADD COLUMN IF NOT EXISTS synced_at timestamptz;
ALTER TABLE public.xero_invoices ADD COLUMN IF NOT EXISTS job_id uuid;
ALTER TABLE public.xero_invoices ADD COLUMN IF NOT EXISTS debt_classification text;
ALTER TABLE public.xero_invoices ADD COLUMN IF NOT EXISTS debt_blocker text;
ALTER TABLE public.xero_invoices ADD COLUMN IF NOT EXISTS debt_as_of timestamptz;
ALTER TABLE public.xero_invoices ADD COLUMN IF NOT EXISTS debt_brief jsonb;

CREATE TABLE IF NOT EXISTS public.debt_assess_commands (
  request_id uuid NOT NULL,
  org_id uuid NOT NULL,
  xero_invoice_id uuid,
  command text NOT NULL CHECK (command = 'assess'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, request_id)
);

ALTER TABLE public.debt_assess_commands ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS debt_assess_commands_service ON public.debt_assess_commands;
CREATE POLICY debt_assess_commands_service ON public.debt_assess_commands
  FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON public.debt_assess_commands FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.debt_assess_commands TO service_role;

CREATE OR REPLACE FUNCTION public.debt_source_last_client(p_job_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog
AS $$
DECLARE
  payload jsonb;
BEGIN
  IF p_job_id IS NULL OR to_regclass('public.business_events') IS NULL THEN
    RETURN NULL;
  END IF;
  BEGIN
    EXECUTE $q$
      SELECT jsonb_build_object(
        'source_system', e.source,
        'source_ref', e.id::text,
        'at', COALESCE(e.event_at, e.created_at)
      )
      FROM public.business_events e
      WHERE e.job_id = $1::text
        AND e.event_type LIKE 'client.%'
      ORDER BY COALESCE(e.event_at, e.created_at) DESC NULLS LAST, e.id DESC
      LIMIT 1
    $q$ INTO payload USING p_job_id;
  EXCEPTION WHEN OTHERS THEN
    payload := NULL;
  END;
  RETURN payload;
END
$$;

CREATE OR REPLACE FUNCTION public.debt_source_invoice_payload(x public.xero_invoices)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT jsonb_build_object(
    'id', x.id,
    'xero_invoice_id', x.xero_invoice_id,
    'status', x.status,
    'amount_due', x.amount_due,
    'amount_paid', x.amount_paid,
    'synced_at', x.synced_at,
    'debt_classification', x.debt_classification,
    'debt_blocker', x.debt_blocker,
    'debt_as_of', x.debt_as_of,
    'notes_digest', x.debt_brief->>'notes_digest',
    'job_linked', (x.job_id IS NOT NULL),
    'last_client', public.debt_source_last_client(x.job_id)
  );
$$;

CREATE OR REPLACE FUNCTION public.debt_source_version(p_org uuid, p_invoice uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  payload jsonb;
  digest text;
  row_x public.xero_invoices;
  book_scope constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
BEGIN
  IF p_org IS NULL OR p_invoice IS NULL THEN
    RAISE EXCEPTION 'workflow_refresh_source_unavailable';
  END IF;

  IF p_invoice = book_scope THEN
    SELECT coalesce(
             jsonb_agg(public.debt_source_invoice_payload(x) ORDER BY x.id),
             '[]'::jsonb
           )
      INTO payload
      FROM public.xero_invoices x
     WHERE x.org_id = p_org
       AND x.invoice_type = 'ACCREC'
       AND x.status IN ('AUTHORISED','SUBMITTED');
  ELSE
    SELECT x.* INTO row_x
      FROM public.xero_invoices x
     WHERE x.org_id = p_org
       AND (x.id = p_invoice OR x.xero_invoice_id = p_invoice::text)
     ORDER BY (x.id = p_invoice) DESC, x.id
     LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'workflow_refresh_source_unavailable';
    END IF;
    payload := public.debt_source_invoice_payload(row_x);
  END IF;

  digest := md5(payload::text);
  IF nullif(btrim(digest), '') IS NULL THEN
    RAISE EXCEPTION 'workflow_refresh_source_unavailable';
  END IF;
  RETURN digest;
END
$$;

CREATE OR REPLACE FUNCTION public.debt_assess_commit(
  p_org_id uuid,
  p_request_id uuid,
  p_xero_invoice_id uuid,
  p_result jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  expected_version text;
  invoice_id uuid;
  book_scope constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
BEGIN
  IF p_org_id IS NULL OR p_request_id IS NULL OR jsonb_typeof(p_result) IS DISTINCT FROM 'object'
  THEN RAISE EXCEPTION 'debt_assess_invalid'; END IF;

  IF p_result->>'mode' IS DISTINCT FROM 'assess'
     OR p_result->>'writes' IS DISTINCT FROM 'false'
     OR p_result->>'sends' IS DISTINCT FROM 'false'
     OR p_result->>'live_actions_enabled' IS DISTINCT FROM 'false'
  THEN RAISE EXCEPTION 'debt_assess_live_actions_forbidden'; END IF;

  invoice_id := coalesce(p_xero_invoice_id, book_scope);
  expected_version := public.debt_source_version(p_org_id, invoice_id);
  IF p_result->>'source_version' IS DISTINCT FROM expected_version
  THEN RAISE EXCEPTION 'workflow_refresh_source_changed'; END IF;

  INSERT INTO public.debt_assess_commands(
    request_id, org_id, xero_invoice_id, command, result
  ) VALUES (
    p_request_id, p_org_id, p_xero_invoice_id, 'assess', p_result
  );

  RETURN p_result;
END
$$;

REVOKE ALL ON FUNCTION public.debt_source_last_client(uuid),
  public.debt_source_invoice_payload(public.xero_invoices),
  public.debt_source_version(uuid,uuid),
  public.debt_assess_commit(uuid,uuid,uuid,jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.debt_source_last_client(uuid),
  public.debt_source_invoice_payload(public.xero_invoices),
  public.debt_source_version(uuid,uuid),
  public.debt_assess_commit(uuid,uuid,uuid,jsonb)
  TO service_role;

DO $$
DECLARE registered jsonb;
BEGIN
  registered := public.register_workflow_refresh_driver(
    'debt','debt-collection','debt_refresh/v1','debt-source-v1','registered'
  );
  IF registered->>'validator_key' IS DISTINCT FROM 'debt_source_v1'
     OR registered->>'capability' IS DISTINCT FROM 'registered'
  THEN RAISE EXCEPTION 'debt_refresh_register_failed'; END IF;
END $$;
