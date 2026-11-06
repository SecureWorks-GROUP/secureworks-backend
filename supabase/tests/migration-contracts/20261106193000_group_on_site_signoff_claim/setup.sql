-- Uses the registered sign-off stack, never a second schema definition.
DO $$ BEGIN
  IF to_regclass('public.job_client_signoffs') IS NULL
    OR to_regclass('public.job_media') IS NULL
    OR to_regclass('public.job_client_signoffs_capture_request_key') IS NULL
  THEN
    RAISE EXCEPTION 'on-site sign-off claim prerequisites are missing';
  END IF;
END $$;

-- Live job_media has uploaded_by (20250301000001_schema.sql); the registered
-- stack's minimal job_media does not. The function writes it, so mirror it.
ALTER TABLE public.job_media ADD COLUMN IF NOT EXISTS uploaded_by uuid;
