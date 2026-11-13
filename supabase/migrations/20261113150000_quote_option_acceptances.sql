-- Ruling 14 step 1 (13 Nov 2026): optional extras on a quote, ticked by the customer
-- when accepting (or by staff accepting by phone). The quote tool seals the options
-- and every tickable combination in pricing_json.optional_extras; send-quote picks the
-- ticked combination, checks it and writes this record.
--
--   quote_option_acceptances: one row per accepted whole-quote document whose released
--   revision offered options. It keeps every offered option (id, name, line, price ex
--   GST, GST, price inc GST, where it goes), the ticked ids, the base total and the
--   accepted totals and deposit. Not taken = offered minus taken ("offered, not taken"
--   on the job's record). Written once by send-quote (quote_options_store.ts) and never
--   changed; no browser role can read or write it.
--
-- A quote with no options writes no row and accepts exactly as before.
-- Rollback: supabase/rollbacks/20261113150000_quote_option_acceptances_down.sql.

CREATE TABLE IF NOT EXISTS public.quote_option_acceptances (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                   uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  job_document_id          uuid NOT NULL REFERENCES public.job_documents(id) ON DELETE CASCADE,
  quote_revision_id        uuid NOT NULL REFERENCES public.quote_revisions(id),
  accepted_via             text NOT NULL CHECK (accepted_via IN ('public_link', 'staff_phone')),
  accepted_by              uuid,
  offered                  jsonb NOT NULL CHECK (
    jsonb_typeof(offered) = 'array'
    AND jsonb_array_length(offered) BETWEEN 1 AND 6
  ),
  taken_option_ids         text[] NOT NULL DEFAULT '{}'::text[] CHECK (cardinality(taken_option_ids) <= 6),
  base_total_inc_gst       numeric(12,2) NOT NULL CHECK (base_total_inc_gst >= 0),
  accepted_total_ex_gst    numeric(12,2) NOT NULL CHECK (accepted_total_ex_gst >= 0),
  accepted_gst             numeric(12,2) NOT NULL CHECK (accepted_gst >= 0),
  accepted_total_inc_gst   numeric(12,2) NOT NULL,
  accepted_deposit_inc_gst numeric(12,2) NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT quote_option_acceptances_one_per_document UNIQUE (job_document_id),
  CONSTRAINT quote_option_acceptances_total_adds_up
    CHECK (accepted_total_inc_gst = accepted_total_ex_gst + accepted_gst),
  CONSTRAINT quote_option_acceptances_total_not_below_base
    CHECK (accepted_total_inc_gst >= base_total_inc_gst),
  CONSTRAINT quote_option_acceptances_staff_named
    CHECK (accepted_via <> 'staff_phone' OR accepted_by IS NOT NULL),
  CONSTRAINT quote_option_acceptances_deposit_within_total
    CHECK (accepted_deposit_inc_gst >= 0 AND accepted_deposit_inc_gst <= accepted_total_inc_gst)
);
CREATE INDEX IF NOT EXISTS quote_option_acceptances_job_idx
  ON public.quote_option_acceptances (job_id);

COMMENT ON TABLE public.quote_option_acceptances IS
  'Ruling 14 step 1 (20261113150000): the options a customer (accepted_via public_link) or staff on the phone (staff_phone, accepted_by the staff user) ticked when accepting a whole-quote document whose released revision (quote_revision_id) carried pricing_json.optional_extras. offered: every option offered, [{id, name, line, sell_ex_gst, gst, sell_inc_gst, goes}]; taken_option_ids: the ticked ids; not taken = offered minus taken. The accepted totals and deposit are the tool''s precomputed combination for the ticked set, never worked out here. One row per document, written once by send-quote quote_options_store.ts; an update is refused.';

-- Written once: an acceptance record never changes.
CREATE OR REPLACE FUNCTION public.quote_option_acceptances_write_once()
RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'quote_option_acceptances is written once and never changed'
    USING ERRCODE = 'restrict_violation';
END $$;
REVOKE ALL ON FUNCTION public.quote_option_acceptances_write_once() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS quote_option_acceptances_write_once ON public.quote_option_acceptances;
CREATE TRIGGER quote_option_acceptances_write_once
  BEFORE UPDATE ON public.quote_option_acceptances
  FOR EACH ROW EXECUTE FUNCTION public.quote_option_acceptances_write_once();

ALTER TABLE public.quote_option_acceptances ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.quote_option_acceptances FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.quote_option_acceptances TO service_role;
DROP POLICY IF EXISTS quote_option_acceptances_service_role_all ON public.quote_option_acceptances;
CREATE POLICY quote_option_acceptances_service_role_all ON public.quote_option_acceptances
  FOR ALL TO service_role USING (true) WITH CHECK (true);
