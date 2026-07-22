-- SecureWorks own-letterhead Roof Report (Wave 3) -- durable FILL-state table for
-- the trade-filled roof report. One row per (job_id, pack_kind='roof').
--
-- Purpose:
--   Hold the trade's roof-report field bag so a partial fill is draft-safe and
--   resumable, and a submit is idempotent. The trade app writes a draft as the
--   inspector fills the form, then submits; ops-api renders OUR letterhead PDF
--   from this row and advances the make-safe reporting checklist
--   (makesafe_job_details.substatus). This table holds the FILL only; the board
--   stage stays driven off makesafe_job_details.substatus exactly as before.
--
-- Idempotency:
--   UNIQUE (job_id, pack_kind). A save upserts on that key; a submit flips
--   status to 'submitted' and is a no-op on repeat.
--
-- Safety:
--   Additive only. Creates no jobs, sends nothing, authorises no invoice, and
--   alters no existing make-safe state. RLS: service_role only (edge function
--   writes with the service key; clients never touch this table directly).

CREATE TABLE IF NOT EXISTS public.makesafe_roof_report_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',

  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  -- pack_kind is the idempotency dimension alongside job_id. 'roof' is the roof
  -- inspection report fill; the shape leaves room for future report kinds on the
  -- same job without colliding.
  pack_kind text NOT NULL DEFAULT 'roof',

  -- The template version this fill was captured under (roof_report_template.ts
  -- ROOF_REPORT_TEMPLATE_VERSION). Lets a later render know which field set
  -- produced the bag.
  template_version int NOT NULL DEFAULT 1,

  -- The trade-filled field bag (template keys only; photos are stored/attached
  -- separately as job_media / job_documents, not inlined here).
  fields_json jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- The storey answer, denormalised for pricing/reporting queries. 'single' or
  -- 'double' once known; null while a draft has not answered it yet.
  storey text,

  -- Fill lifecycle:
  --   draft     -- being filled; safe to overwrite on the next save
  --   submitted -- final; PDF rendered + reporting checklist advanced
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'submitted')),

  -- The rendered roof-report document (job_documents.id) and its render hash, so
  -- a re-submit with unchanged content can skip a redundant re-render.
  report_doc_id uuid,
  last_render_hash text,

  submitted_by uuid,
  submitted_at timestamptz,
  created_by uuid,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (job_id, pack_kind)
);

CREATE INDEX IF NOT EXISTS idx_makesafe_roof_report_drafts_org_status
  ON public.makesafe_roof_report_drafts (org_id, status);

CREATE INDEX IF NOT EXISTS idx_makesafe_roof_report_drafts_job
  ON public.makesafe_roof_report_drafts (job_id);

ALTER TABLE public.makesafe_roof_report_drafts ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'makesafe_roof_report_drafts'
      AND policyname = 'service_role_all_makesafe_roof_report_drafts'
  ) THEN
    CREATE POLICY "service_role_all_makesafe_roof_report_drafts"
      ON public.makesafe_roof_report_drafts FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END$$;

COMMENT ON TABLE public.makesafe_roof_report_drafts IS
  'Trade-filled roof-report FILL state for the SecureWorks own-letterhead roof report. One row per (job_id, pack_kind). Draft-safe + idempotent submit; ops-api renders our letterhead PDF from this row and advances makesafe_job_details.substatus. Additive, RLS service_role only, never mutated by clients directly.';
