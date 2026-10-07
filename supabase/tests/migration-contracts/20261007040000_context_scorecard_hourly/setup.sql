-- Prerequisites for 20261007040000_context_scorecard_hourly: the scorecard it
-- runs comes from an earlier registered case (20261006032000); the backend's
-- ops alert table it reports into is not created by any earlier case, so it is
-- created here with the live columns and defaults (production, 7 Oct 2026).
DO $$
BEGIN
 IF to_regprocedure('public.context_scorecard(timestamptz)') IS NULL THEN
  RAISE EXCEPTION 'hourly setup: public.context_scorecard(timestamptz) is missing from the registered stack';
 END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.ai_alerts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'::uuid,
 job_id uuid,
 alert_type text NOT NULL,
 severity text NOT NULL,
 message text NOT NULL,
 recommended_action text,
 financial_impact numeric,
 detail_json jsonb DEFAULT '{}'::jsonb,
 created_at timestamptz DEFAULT now(),
 dismissed_at timestamptz,
 dismissed_by uuid,
 resolved_at timestamptz,
 resolved_by uuid
);
