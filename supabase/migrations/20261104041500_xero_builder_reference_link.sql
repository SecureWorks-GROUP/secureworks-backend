-- Builder invoices raised straight in Xero land on their job at arrival (finish line B3, 3 Nov 2026).
--
-- Found by context-system/verify/scripts/b3_same_day.py (Perth days 27 Oct to 2 Nov): INV-1772, INV-1775, INV-1787
-- and INV-1805 carry only the builder's claim and PO (MLB-26303PO-58097) and no job number of ours, so xero-sync never
-- linked them and only Bookkeeping's ledger placed them, 3 to 4.8 days later.
--
-- Two objects for xero-sync's unlinked-invoice matcher (builder_reference_match.ts decides; this only reads):
--   xero_builder_reference_candidates(keys)  every job whose own builder fields carry one of the claim or PO digit
--       runs (makesafe_job_details.external_ref; metadata external_ref, builder_claim_ref, mlb_ref,
--       builder_work_order_number, builder_po_number, purchase_order_number), plus every job at the same site as one
--       of those (context_address_key, the context placer's key), with what the rule needs to judge each.
--   xero_invoices.job_linked_at  the time job_id was first set, stamped by a trigger (never by a caller), so B3 has a
--       stored link time. NULL: never linked, or linked before this column existed (no backfill: no stored truth).
--
-- Nothing else moves: no data write, no link, no change to any view or existing function.
-- Guards: context_address_key must be the definition read live on 3 Nov 2026 (md5 below); a function or trigger of
-- the same name must be this migration's own definition; job_linked_at, if present, must be timestamptz.
-- Rehearsed on production inside one rolled-back transaction (context-system evidence 20261103-b3-rule).
-- Rollback: supabase/rollbacks/20261104041500_xero_builder_reference_link_down.sql.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $guard$
DECLARE
  v_type text;
  v_cand regprocedure := to_regprocedure('public.xero_builder_reference_candidates(text[])');
  v_stamp regprocedure := to_regprocedure('public.xero_invoices_stamp_job_linked_at()');
BEGIN
  IF md5(pg_get_functiondef('public.context_address_key(text)'::regprocedure)) <> '442cadbf919c40846792ef45088b42c0' THEN
    RAISE EXCEPTION 'context_address_key is not the definition this was written against (md5 %)',
      md5(pg_get_functiondef('public.context_address_key(text)'::regprocedure));
  END IF;
  IF v_cand IS NOT NULL AND md5(pg_get_functiondef(v_cand)) <> 'b3173d9cd7d30c3a08890064739e605c' THEN
    RAISE EXCEPTION 'xero_builder_reference_candidates exists with another definition (md5 %); refusing', md5(pg_get_functiondef(v_cand));
  END IF;
  IF v_stamp IS NOT NULL AND md5(pg_get_functiondef(v_stamp)) <> '8f76bf889243dd5597ea8ebd82defd70' THEN
    RAISE EXCEPTION 'xero_invoices_stamp_job_linked_at exists with another definition (md5 %); refusing', md5(pg_get_functiondef(v_stamp));
  END IF;
  SELECT data_type INTO v_type FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'xero_invoices' AND column_name = 'job_linked_at';
  IF v_type IS NOT NULL AND v_type <> 'timestamp with time zone' THEN
    RAISE EXCEPTION 'xero_invoices.job_linked_at exists as %; refusing', v_type;
  END IF;
END
$guard$;

-- 1. The candidate read. Keys are digit runs of 5 or more; anything else is ignored. A job is a reference candidate
--    when a whole digit run of its own builder fields equals a key; a site candidate when its site has the same
--    context_address_key as a reference candidate. The street-name prefilter runs first (materialized: the key is a
--    plpgsql call, 0.3 ms a job) and is a necessary condition of the key, so it never drops a job with the same key.
--    The decision (trade, status, uniqueness) is made in builder_reference_match.ts.
CREATE OR REPLACE FUNCTION public.xero_builder_reference_candidates(p_keys text[])
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $fn$
WITH k AS (
  SELECT coalesce(array_agg(DISTINCT x), '{}'::text[]) AS keys
  FROM unnest(coalesce(p_keys, '{}'::text[])) AS x
  WHERE x ~ '^[0-9]{5,}$'
), j AS (
  SELECT jb.id, jb.job_number, jb.type, jb.status, jb.legacy, jb.created_at, jb.client_name, jb.ghl_contact_id,
         jb.site_address, jb.quoted_value, jb.metadata, d.external_ref AS details_external_ref, d.requesting_company_slug,
         concat_ws(' ', d.external_ref, jb.metadata->>'external_ref', jb.metadata->>'builder_claim_ref',
                   jb.metadata->>'mlb_ref', jb.metadata->>'builder_work_order_number',
                   jb.metadata->>'builder_po_number', jb.metadata->>'purchase_order_number') AS id_text
  FROM public.jobs jb
  LEFT JOIN public.makesafe_job_details d ON d.job_id = jb.id
  WHERE jb.org_id = '00000000-0000-0000-0000-000000000001'::uuid
), direct AS (
  SELECT j.* FROM j, k
  WHERE cardinality(k.keys) > 0
    AND j.id_text ~ '[0-9]{5}'
    AND EXISTS (SELECT 1 FROM regexp_matches(j.id_text, '[0-9]{5,}', 'g') AS m WHERE m[1] = ANY (k.keys))
), anchors AS (
  SELECT DISTINCT a.site_key, replace(regexp_replace(a.site_key, '^\S+ (.+) \S+$', '\1'), ' ', '') AS name_key
  FROM (SELECT public.context_address_key(direct.site_address) AS site_key FROM direct) a
  WHERE a.site_key IS NOT NULL
), site_named AS MATERIALIZED (
  SELECT j.*, a.site_key AS anchor_key FROM j
  JOIN anchors a ON strpos(regexp_replace(lower(coalesce(j.site_address, '')), '[^a-z0-9]+', '', 'g'), a.name_key) > 0
  WHERE j.id NOT IN (SELECT direct.id FROM direct)
), site AS (
  SELECT DISTINCT s.id, s.job_number, s.type, s.status, s.legacy, s.created_at, s.client_name, s.ghl_contact_id,
         s.site_address, s.quoted_value, s.metadata, s.details_external_ref, s.requesting_company_slug, s.id_text
  FROM site_named s
  WHERE public.context_address_key(s.site_address) = s.anchor_key
), c AS (
  SELECT * FROM direct
  UNION
  SELECT * FROM site
)
SELECT coalesce(jsonb_agg(jsonb_build_object(
  'id', c.id,
  'job_number', c.job_number,
  'type', c.type,
  'status', c.status,
  'legacy', c.legacy,
  'created_at', c.created_at,
  'client_name', c.client_name,
  'ghl_contact_id', c.ghl_contact_id,
  'site_key', public.context_address_key(c.site_address),
  'builder', lower(nullif(btrim(coalesce(c.requesting_company_slug, c.metadata->'requesting_company'->>'slug')), '')),
  'quoted_value', c.quoted_value,
  'work_order_value_ex_gst', coalesce(c.metadata->>'builder_work_order_value_ex_gst', c.metadata->>'builder_wo_value_ex_gst'),
  'do_not_schedule', coalesce(c.metadata->>'do_not_schedule', '') IN ('true', '1'),
  'refs', jsonb_build_object(
    'details_external_ref', c.details_external_ref,
    'external_ref', c.metadata->>'external_ref',
    'builder_claim_ref', c.metadata->>'builder_claim_ref',
    'mlb_ref', c.metadata->>'mlb_ref',
    'builder_work_order_number', c.metadata->>'builder_work_order_number',
    'builder_po_number', c.metadata->>'builder_po_number',
    'purchase_order_number', c.metadata->>'purchase_order_number'),
  'invoices', (
    SELECT coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'invoice_number', x.invoice_number, 'total', x.total,
                                                 'status', x.status, 'created_at', x.created_at) ORDER BY x.created_at), '[]'::jsonb)
    FROM public.xero_invoices x
    WHERE x.job_id = c.id AND x.invoice_type = 'ACCREC' AND coalesce(x.status, '') NOT IN ('VOIDED', 'DELETED'))
) ORDER BY c.job_number, c.id), '[]'::jsonb)
FROM c
$fn$;

COMMENT ON FUNCTION public.xero_builder_reference_candidates(text[]) IS
 'B3: jobs whose own builder fields carry one of the claim or PO digit runs, plus jobs at the same site (context_address_key), with what xero-sync builder_reference_match.ts needs to decide. Read only.';
REVOKE ALL ON FUNCTION public.xero_builder_reference_candidates(text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.xero_builder_reference_candidates(text[]) TO service_role, postgres;

-- 2. The stored link time. Set only here: on insert when the row arrives with a job, on update the first time job_id
--    goes from empty to a job. A caller cannot write or move it.
ALTER TABLE public.xero_invoices ADD COLUMN IF NOT EXISTS job_linked_at timestamptz;
COMMENT ON COLUMN public.xero_invoices.job_linked_at IS
 'B3: when job_id was first set (trigger xero_invoices_job_linked_at). NULL: never linked, or linked before 4 Nov 2026 (not backfilled).';

CREATE OR REPLACE FUNCTION public.xero_invoices_stamp_job_linked_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.job_linked_at := CASE WHEN NEW.job_id IS NOT NULL THEN now() END;
  ELSE
    NEW.job_linked_at := OLD.job_linked_at;
    IF NEW.job_linked_at IS NULL AND OLD.job_id IS NULL AND NEW.job_id IS NOT NULL THEN
      NEW.job_linked_at := now();
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.xero_invoices_stamp_job_linked_at() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS xero_invoices_job_linked_at ON public.xero_invoices;
CREATE TRIGGER xero_invoices_job_linked_at
  BEFORE INSERT OR UPDATE OF job_id, job_linked_at ON public.xero_invoices
  FOR EACH ROW EXECUTE FUNCTION public.xero_invoices_stamp_job_linked_at();

DO $after$
BEGIN
  IF md5(pg_get_functiondef('public.xero_builder_reference_candidates(text[])'::regprocedure)) <> 'b3173d9cd7d30c3a08890064739e605c' THEN
    RAISE EXCEPTION 'xero_builder_reference_candidates is not the rehearsed definition (md5 %)',
      md5(pg_get_functiondef('public.xero_builder_reference_candidates(text[])'::regprocedure));
  END IF;
  IF md5(pg_get_functiondef('public.xero_invoices_stamp_job_linked_at()'::regprocedure)) <> '8f76bf889243dd5597ea8ebd82defd70' THEN
    RAISE EXCEPTION 'xero_invoices_stamp_job_linked_at is not the rehearsed definition (md5 %)',
      md5(pg_get_functiondef('public.xero_invoices_stamp_job_linked_at()'::regprocedure));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.xero_invoices'::regclass
                 AND tgname = 'xero_invoices_job_linked_at' AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'trigger xero_invoices_job_linked_at is missing or not enabled';
  END IF;
END
$after$;
