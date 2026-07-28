-- Audited deterministic-intake notification to the configured make-safe manager.
--
-- The deterministic runtime inserts one claim before calling GHL. The unique
-- case/job grain is the at-most-one dispatch boundary: an ambiguous provider
-- result is visible and is never retried automatically.

CREATE TABLE IF NOT EXISTS public.makesafe_intake_hugo_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'
    REFERENCES public.organisations(id) ON DELETE RESTRICT,
  case_id uuid NOT NULL,
  source_post_ids text[] NOT NULL,
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE RESTRICT,
  job_number text,
  board_stage text,
  board_observed_at timestamptz,
  attempted_at timestamptz NOT NULL,
  provider_message_id text,
  provider_accepted_at timestamptz,
  recipient_set jsonb NOT NULL DEFAULT '[]'::jsonb,
  deep_link text NOT NULL,
  message text,
  state text NOT NULL,
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT makesafe_intake_hugo_notifications_case_fk
    FOREIGN KEY (org_id, case_id)
    REFERENCES public.makesafe_intake_cases(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT makesafe_intake_hugo_notifications_once
    UNIQUE (org_id, case_id, job_id),
  CONSTRAINT makesafe_intake_hugo_notifications_sources_check
    CHECK (
      array_position(source_post_ids, NULL) IS NULL
      AND (state = 'failed' OR cardinality(source_post_ids) > 0)
    ),
  CONSTRAINT makesafe_intake_hugo_notifications_state_check
    CHECK (state IN ('attempting', 'accepted', 'failed')),
  CONSTRAINT makesafe_intake_hugo_notifications_recipient_shape_check
    CHECK (jsonb_typeof(recipient_set) = 'array'),
  CONSTRAINT makesafe_intake_hugo_notifications_result_check
    CHECK (
      (
        state = 'accepted'
        AND provider_message_id IS NOT NULL
        AND provider_accepted_at IS NOT NULL
        AND failure_reason IS NULL
      )
      OR (
        state IN ('attempting', 'failed')
        AND provider_message_id IS NULL
        AND provider_accepted_at IS NULL
        AND failure_reason IS NOT NULL
      )
    )
);

CREATE INDEX IF NOT EXISTS idx_makesafe_intake_hugo_notifications_attempted
  ON public.makesafe_intake_hugo_notifications
  (org_id, attempted_at DESC);

CREATE INDEX IF NOT EXISTS idx_makesafe_intake_hugo_notifications_failures
  ON public.makesafe_intake_hugo_notifications
  (org_id, attempted_at DESC)
  WHERE state <> 'accepted';

ALTER TABLE public.makesafe_intake_hugo_notifications
  ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.makesafe_intake_hugo_notifications
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.makesafe_intake_hugo_notifications TO service_role;

DROP POLICY IF EXISTS service_role_all_makesafe_intake_hugo_notifications
  ON public.makesafe_intake_hugo_notifications;
CREATE POLICY service_role_all_makesafe_intake_hugo_notifications
  ON public.makesafe_intake_hugo_notifications
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

COMMENT ON TABLE public.makesafe_intake_hugo_notifications IS
  'Once-per-case/job audit for deterministic physical make-safe notification. The pre-send claim records lineage, canonical board proof, configured staff recipient, provider acceptance, or a durable failure.';
COMMENT ON COLUMN public.makesafe_intake_hugo_notifications.failure_reason IS
  'Non-null while attempting or failed. provider_result_not_recorded is deliberately durable if GHL accepts but the final audit update cannot be committed.';
