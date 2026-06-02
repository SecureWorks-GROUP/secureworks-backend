-- MakeSafe Email Intake -- draft queue for SES work-order emails.
--
-- Purpose:
--   Store Microsoft Graph email extractions and downloaded work-order PDF
--   references before any live make-safe job is created. Approval remains a
--   separate explicit action.
--
-- Safety:
--   This migration is additive only. It does not create jobs, send messages,
--   issue invoices, or alter existing make-safe state.

CREATE TABLE IF NOT EXISTS public.makesafe_intake_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',

  mailbox text NOT NULL,
  graph_message_id text NOT NULL,
  internet_message_id text,
  conversation_id text,
  received_at timestamptz,
  from_email text,
  from_name text,
  subject text,
  body_preview text,

  requesting_company_slug text,
  requesting_company_name text,
  external_ref text,
  client_name text,
  client_phone text,
  client_email text,
  site_address text,
  site_suburb text,
  description text,
  safety_requirements text,
  special_instructions text,

  confidence text NOT NULL DEFAULT 'low'
    CHECK (confidence IN ('high', 'medium', 'low')),
  missing_fields text[] NOT NULL DEFAULT '{}',
  extraction_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  attachments_json jsonb NOT NULL DEFAULT '[]'::jsonb,

  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'needs_review', 'approved', 'rejected', 'superseded')),
  approved_job_id uuid REFERENCES public.jobs(id) ON DELETE SET NULL,
  approved_at timestamptz,
  approved_by text,
  rejected_at timestamptz,
  rejected_by text,
  review_notes text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (org_id, graph_message_id)
);

CREATE INDEX IF NOT EXISTS idx_makesafe_intake_drafts_status
  ON public.makesafe_intake_drafts (org_id, status, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_makesafe_intake_drafts_external_ref
  ON public.makesafe_intake_drafts (org_id, external_ref)
  WHERE external_ref IS NOT NULL;

ALTER TABLE public.makesafe_intake_drafts ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'makesafe_intake_drafts'
      AND policyname = 'service_role_all_makesafe_intake_drafts'
  ) THEN
    CREATE POLICY "service_role_all_makesafe_intake_drafts"
      ON public.makesafe_intake_drafts FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END$$;

COMMENT ON TABLE public.makesafe_intake_drafts IS
  'Draft queue for MakeSafe SES mailbox intake. Rows are extracted from Microsoft Graph emails and require explicit approval before live job creation.';
