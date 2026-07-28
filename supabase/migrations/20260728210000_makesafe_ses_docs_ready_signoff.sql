-- SES Docs Ready: audit-grade pack review and exact-content signoff.
--
-- The docket revisions remain append-only. This ledger records whether the
-- current exact revision needs review or has been signed off, who made the
-- decision, and the assembler/family/content versions that decision covered.
-- It creates no invoice and sends no communication.

CREATE TABLE IF NOT EXISTS public.ses_docket_review_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  org_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE RESTRICT,
  docket_revision_id uuid NOT NULL
    REFERENCES public.makesafe_docket_revisions(id) ON DELETE RESTRICT,
  docket_output_content_hash text NOT NULL
    CHECK (docket_output_content_hash ~ '^sha256:[0-9a-f]{64}$'),
  assembler_version text NOT NULL CHECK (length(btrim(assembler_version)) > 0),
  family_matrix_version text NOT NULL
    CHECK (length(btrim(family_matrix_version)) > 0),
  docket_stage text NOT NULL CHECK (docket_stage IN ('pre_xero', 'invoice_bound')),
  review_state text NOT NULL CHECK (
    review_state IN ('needs_review', 'signed_off')
  ),
  event_kind text NOT NULL CHECK (
    event_kind IN ('prepared', 'content_changed', 'signed_off', 'revoked')
  ),
  previous_event_id uuid
    REFERENCES public.ses_docket_review_events(id) ON DELETE RESTRICT,
  invalidated_signoff_event_id uuid
    REFERENCES public.ses_docket_review_events(id) ON DELETE RESTRICT,
  actor_user_id uuid,
  actor_identity text NOT NULL CHECK (length(btrim(actor_identity)) > 0),
  reason text,
  signed_off_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT ses_docket_review_event_shape CHECK (
    (
      event_kind IN ('prepared', 'content_changed', 'revoked')
      AND review_state = 'needs_review'
      AND signed_off_at IS NULL
    )
    OR (
      event_kind = 'signed_off'
      AND review_state = 'signed_off'
      AND actor_user_id IS NOT NULL
      AND signed_off_at IS NOT NULL
    )
  ),
  CONSTRAINT ses_docket_review_revoke_reason CHECK (
    event_kind <> 'revoked' OR length(btrim(COALESCE(reason, ''))) > 0
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ses_docket_review_initial
  ON public.ses_docket_review_events (docket_revision_id)
  WHERE event_kind IN ('prepared', 'content_changed');
CREATE INDEX IF NOT EXISTS idx_ses_docket_review_events_revision
  ON public.ses_docket_review_events (
    docket_revision_id,
    event_sequence DESC
  );
CREATE INDEX IF NOT EXISTS idx_ses_docket_review_events_job
  ON public.ses_docket_review_events (job_id, event_sequence DESC);
CREATE INDEX IF NOT EXISTS idx_ses_docket_review_events_needs_review
  ON public.ses_docket_review_events (event_sequence, job_id)
  WHERE review_state = 'needs_review';
CREATE INDEX IF NOT EXISTS idx_ses_docket_review_events_previous
  ON public.ses_docket_review_events (previous_event_id)
  WHERE previous_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ses_docket_review_events_invalidated
  ON public.ses_docket_review_events (invalidated_signoff_event_id)
  WHERE invalidated_signoff_event_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.reject_ses_docket_review_event_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'ses_docket_review_events is append-only; % is not allowed', TG_OP
    USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS trg_ses_docket_review_events_append_only
  ON public.ses_docket_review_events;
CREATE TRIGGER trg_ses_docket_review_events_append_only
  BEFORE UPDATE OR DELETE ON public.ses_docket_review_events
  FOR EACH ROW EXECUTE FUNCTION public.reject_ses_docket_review_event_change();

CREATE OR REPLACE VIEW public.ses_docket_review_current
WITH (security_invoker = true)
AS
SELECT
  docket.org_id,
  docket.job_id,
  docket.id AS docket_revision_id,
  docket.output_content_hash AS docket_output_content_hash,
  docket.assembler_version,
  docket.family_matrix_version,
  docket.stage AS docket_stage,
  docket.committed_at AS docket_committed_at,
  event.id AS review_event_id,
  event.event_sequence AS review_event_sequence,
  event.review_state,
  event.event_kind,
  event.actor_user_id,
  event.actor_identity,
  event.reason,
  event.signed_off_at,
  event.created_at AS review_state_changed_at,
  event.invalidated_signoff_event_id
FROM public.makesafe_docket_revisions_current docket
JOIN LATERAL (
  SELECT candidate.*
  FROM public.ses_docket_review_events candidate
  WHERE candidate.docket_revision_id = docket.id
  ORDER BY candidate.event_sequence DESC
  LIMIT 1
) event ON true;

CREATE OR REPLACE FUNCTION public.record_ses_docket_review_state_v1(
  p_event jsonb
)
RETURNS public.ses_docket_review_events
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  target public.makesafe_docket_revisions%ROWTYPE;
  current_event public.ses_docket_review_events%ROWTYPE;
  prior_event public.ses_docket_review_events%ROWTYPE;
  inserted public.ses_docket_review_events%ROWTYPE;
  requested_kind text := btrim(COALESCE(p_event->>'event_kind', ''));
  effective_kind text := requested_kind;
  expected_hash text := btrim(COALESCE(
    p_event->>'expected_output_content_hash',
    ''
  ));
  target_actor uuid := NULLIF(p_event->>'actor_user_id', '')::uuid;
  target_identity text := btrim(COALESCE(p_event->>'actor_identity', ''));
  target_reason text := NULLIF(btrim(COALESCE(p_event->>'reason', '')), '');
  invalidated_signoff uuid;
BEGIN
  IF jsonb_typeof(p_event) IS DISTINCT FROM 'object'
     OR requested_kind NOT IN ('prepared', 'signed_off', 'revoked')
     OR target_identity = '' THEN
    RAISE EXCEPTION 'docket revision, event kind, expected hash and actor are required'
      USING ERRCODE = '22023';
  END IF;

  SELECT *
  INTO target
  FROM public.makesafe_docket_revisions
  WHERE id = (p_event->>'docket_revision_id')::uuid
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the reviewable docket revision no longer exists'
      USING ERRCODE = 'P0002';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('ses-docs-ready:' || target.job_id::text, 0)
  );

  IF NOT EXISTS (
    SELECT 1
    FROM public.makesafe_docket_revisions_current current_docket
    WHERE current_docket.job_id = target.job_id
      AND current_docket.id = target.id
  ) THEN
    RAISE EXCEPTION 'new docket content exists; review the current exact revision'
      USING ERRCODE = '40001';
  END IF;
  IF expected_hash = ''
     OR expected_hash IS DISTINCT FROM target.output_content_hash THEN
    RAISE EXCEPTION 'the displayed pack hash does not match the current exact bytes'
      USING ERRCODE = '40001';
  END IF;

  -- Reuse the assembler's own family recipe verdict and typed blocker set.
  -- The invoice-bound stage additionally reuses U6's existing AUTHORISED-PDF
  -- contract; this function does not define a second pack recipe.
  IF target.state <> 'ready'
     OR NOT target.pre_xero_docs_ready
     OR jsonb_array_length(target.blockers) <> 0
     OR (
       target.stage = 'invoice_bound'
       AND (
         target.xero_binding->>'status' IS DISTINCT FROM 'AUTHORISED'
         OR NOT EXISTS (
           SELECT 1
           FROM public.makesafe_docket_artifacts artifact
           WHERE artifact.revision_id = target.id
             AND artifact.role = 'xero_invoice_pdf'
             AND artifact.content_hash ~ '^sha256:[0-9a-f]{64}$'
         )
       )
     ) THEN
    RAISE EXCEPTION 'the assembler pack is incomplete; keep its typed blockers and do not queue it for review'
      USING ERRCODE = '23514';
  END IF;

  SELECT *
  INTO current_event
  FROM public.ses_docket_review_events
  WHERE docket_revision_id = target.id
  ORDER BY event_sequence DESC
  LIMIT 1
  FOR SHARE;

  IF requested_kind = 'prepared' THEN
    SELECT *
    INTO inserted
    FROM public.ses_docket_review_events
    WHERE docket_revision_id = target.id
      AND event_kind IN ('prepared', 'content_changed')
    LIMIT 1;
    IF FOUND THEN
      RETURN inserted;
    END IF;

    SELECT *
    INTO prior_event
    FROM public.ses_docket_review_events
    WHERE job_id = target.job_id
      AND docket_revision_id <> target.id
    ORDER BY event_sequence DESC
    LIMIT 1;
    IF FOUND AND prior_event.review_state = 'signed_off' THEN
      effective_kind := 'content_changed';
      invalidated_signoff := prior_event.id;
    END IF;
  ELSIF requested_kind = 'signed_off' THEN
    IF target_actor IS NULL THEN
      RAISE EXCEPTION 'an identified Captain or admin-owner is required to sign off'
        USING ERRCODE = '42501';
    END IF;
    IF current_event.review_state = 'signed_off' THEN
      RETURN current_event;
    END IF;
    IF current_event.review_state IS DISTINCT FROM 'needs_review' THEN
      RAISE EXCEPTION 'the exact docket is not waiting for review'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    IF current_event.review_state IS DISTINCT FROM 'signed_off' THEN
      RAISE EXCEPTION 'the exact docket is not signed off'
        USING ERRCODE = '23514';
    END IF;
    IF target_reason IS NULL THEN
      RAISE EXCEPTION 'a concrete revocation reason is required'
        USING ERRCODE = '22023';
    END IF;
    invalidated_signoff := current_event.id;
  END IF;

  INSERT INTO public.ses_docket_review_events (
    org_id,
    job_id,
    docket_revision_id,
    docket_output_content_hash,
    assembler_version,
    family_matrix_version,
    docket_stage,
    review_state,
    event_kind,
    previous_event_id,
    invalidated_signoff_event_id,
    actor_user_id,
    actor_identity,
    reason,
    signed_off_at
  ) VALUES (
    target.org_id,
    target.job_id,
    target.id,
    target.output_content_hash,
    target.assembler_version,
    target.family_matrix_version,
    target.stage,
    CASE WHEN requested_kind = 'signed_off' THEN 'signed_off' ELSE 'needs_review' END,
    effective_kind,
    COALESCE(current_event.id, prior_event.id),
    invalidated_signoff,
    target_actor,
    target_identity,
    target_reason,
    CASE WHEN requested_kind = 'signed_off' THEN clock_timestamp() ELSE NULL END
  )
  RETURNING * INTO inserted;
  RETURN inserted;
END;
$$;

CREATE OR REPLACE FUNCTION public.assert_ses_dockets_signed_off_v1(
  p_docket_revision_ids uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  target_id uuid;
  docket public.makesafe_docket_revisions%ROWTYPE;
  review record;
  checked integer := 0;
BEGIN
  IF COALESCE(cardinality(p_docket_revision_ids), 0) = 0 THEN
    RAISE EXCEPTION 'at least one exact docket revision is required'
      USING ERRCODE = '22023';
  END IF;

  FOREACH target_id IN ARRAY p_docket_revision_ids
  LOOP
    SELECT *
    INTO docket
    FROM public.makesafe_docket_revisions_current
    WHERE id = target_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Docs Ready signoff missing: a release member is not the current exact docket revision'
        USING ERRCODE = '40001';
    END IF;

    SELECT *
    INTO review
    FROM public.ses_docket_review_current
    WHERE docket_revision_id = target_id;
    IF NOT FOUND
       OR review.review_state IS DISTINCT FROM 'signed_off'
       OR review.docket_output_content_hash IS DISTINCT FROM docket.output_content_hash
       OR review.assembler_version IS DISTINCT FROM docket.assembler_version
       OR review.family_matrix_version IS DISTINCT FROM docket.family_matrix_version THEN
      RAISE EXCEPTION 'Docs Ready signoff missing: Captain must tick the current exact pack bytes'
        USING ERRCODE = '42501';
    END IF;
    checked := checked + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'state', 'signed_off',
    'docket_revision_ids', p_docket_revision_ids,
    'checked', checked
  );
END;
$$;

ALTER TABLE public.ses_docket_review_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ses_docket_review_events_service_role_only
  ON public.ses_docket_review_events;
CREATE POLICY ses_docket_review_events_service_role_only
  ON public.ses_docket_review_events
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

REVOKE ALL ON public.ses_docket_review_events
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.ses_docket_review_current
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reject_ses_docket_review_event_change()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_ses_docket_review_state_v1(jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.assert_ses_dockets_signed_off_v1(uuid[])
  FROM PUBLIC, anon, authenticated;

REVOKE INSERT, UPDATE, DELETE ON public.ses_docket_review_events
  FROM service_role;
GRANT SELECT ON public.ses_docket_review_events TO service_role;
GRANT SELECT ON public.ses_docket_review_current TO service_role;
GRANT EXECUTE ON FUNCTION public.record_ses_docket_review_state_v1(jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.assert_ses_dockets_signed_off_v1(uuid[])
  TO service_role;

COMMENT ON TABLE public.ses_docket_review_events IS
  'Append-only needs_review/signed_off audit ledger bound to exact docket bytes and assembler/family versions.';
COMMENT ON FUNCTION public.assert_ses_dockets_signed_off_v1(uuid[]) IS
  'Hard SES release wall: every current exact docket member must have a current signed_off event.';
