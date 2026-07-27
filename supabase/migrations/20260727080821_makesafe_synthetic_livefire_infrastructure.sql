-- Synthetic SES live-fire infrastructure.
--
-- This migration creates a deliberately unmistakable requesting-company profile
-- and a marker-scoped terminal-accounting ledger for production live-fire tests.
-- It does not send, create a job, mutate an intake case, or bypass any append-only
-- trigger. The matching runtime accepts the profile only for a cryptographically
-- authorised reserved marker; sender_patterns stays empty so ordinary own-domain mail
-- cannot classify as this company.

INSERT INTO public.makesafe_companies (
  org_id,
  slug,
  name,
  sender_patterns,
  invoice_email,
  report_recipient,
  special_instructions,
  safety_requirements,
  external_links,
  parsing_rules,
  billing_rules,
  active,
  updated_at
)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'synthetic-livefire',
  'SYNTHETIC LIVE-FIRE BUILDER - TEST ONLY',
  ARRAY[]::text[],
  'marnin@secureworkswa.com.au',
  'marnin@secureworkswa.com.au',
  'TEST ONLY. No outbound email, SMS, CRM mutation, invoice, sign-off, or release.',
  'TEST ONLY. Synthetic fixtures must remain unreleased and terminally accounted.',
  '[]'::jsonb,
  jsonb_build_object(
    'version', 1,
    'template_first', true,
    'confidence', 'high',
    'required', jsonb_build_array(
      'external_ref',
      'client_name',
      'site_address'
    ),
    'synthetic_livefire', true,
    'marker_prefix', 'SWG-SES-LIVEFIRE-TEST-ONLY-',
    'sender_authority', 'signed_marker_only',
    'fields', jsonb_build_object(
      'external_ref', jsonb_build_object(
        'regex', '\b(SYNTHLIVE-[A-Z0-9][A-Z0-9-]{0,63})\b',
        'source', 'all',
        'group', 1,
        'transform', 'upper'
      ),
      'client_name', jsonb_build_object(
        'regex', '(?:client|insured|customer|home\s*owner|homeowner|owner)\s*(?:name)?\s*[:\-]\s*([A-Za-z][A-Za-z''\-\. ]{1,60})',
        'source', 'all',
        'group', 1,
        'transform', 'collapse_ws'
      ),
      'client_phone', jsonb_build_object(
        'regex', '(?:phone|mobile|contact|ph|tel)\s*(?:no\.?|number)?\s*[:\-]\s*(\+?[0-9][0-9 ()\-]{6,})',
        'source', 'all',
        'group', 1,
        'transform', 'collapse_ws'
      ),
      'site_address', jsonb_build_object(
        'regex', '(?:site\s*address|risk\s*address|property\s*address|address|property|site)\s*[:\-]\s*([0-9][^\n\r]{4,80})',
        'source', 'all',
        'group', 1,
        'transform', 'collapse_ws'
      )
    )
  ),
  jsonb_build_object(
    'synthetic_livefire', true,
    'outbound_disabled', true,
    'invoicing_disabled', true
  ),
  true,
  now()
)
ON CONFLICT (slug) DO UPDATE
SET
  org_id = EXCLUDED.org_id,
  name = EXCLUDED.name,
  sender_patterns = EXCLUDED.sender_patterns,
  invoice_email = EXCLUDED.invoice_email,
  report_recipient = EXCLUDED.report_recipient,
  special_instructions = EXCLUDED.special_instructions,
  safety_requirements = EXCLUDED.safety_requirements,
  external_links = EXCLUDED.external_links,
  parsing_rules = EXCLUDED.parsing_rules,
  billing_rules = EXCLUDED.billing_rules,
  active = EXCLUDED.active,
  updated_at = now();

ALTER TABLE public.makesafe_companies
  DROP CONSTRAINT IF EXISTS makesafe_companies_synthetic_livefire_fixed;
ALTER TABLE public.makesafe_companies
  ADD CONSTRAINT makesafe_companies_synthetic_livefire_fixed CHECK (
    slug <> 'synthetic-livefire'
    OR (
      org_id = '00000000-0000-0000-0000-000000000001'
      AND name = 'SYNTHETIC LIVE-FIRE BUILDER - TEST ONLY'
      AND active
      AND cardinality(sender_patterns) = 0
      AND lower(COALESCE(invoice_email, '')) = 'marnin@secureworkswa.com.au'
      AND lower(COALESCE(report_recipient, '')) = 'marnin@secureworkswa.com.au'
      AND external_links = '[]'::jsonb
      AND COALESCE(parsing_rules->>'synthetic_livefire', 'false') = 'true'
      AND COALESCE(parsing_rules->>'template_first', 'false') = 'true'
      AND parsing_rules->>'marker_prefix' =
        'SWG-SES-LIVEFIRE-TEST-ONLY-'
      AND parsing_rules->>'sender_authority' = 'signed_marker_only'
      AND COALESCE(billing_rules->>'outbound_disabled', 'false') = 'true'
      AND COALESCE(billing_rules->>'invoicing_disabled', 'false') = 'true'
    )
  );

COMMENT ON CONSTRAINT makesafe_companies_synthetic_livefire_fixed
  ON public.makesafe_companies IS
  'The live-fire company is inert unless the runtime validates its signed reserved marker. It cannot acquire a sender pattern or a non-SecureWorks route.';

ALTER TABLE public.makesafe_intake_cases
  DROP CONSTRAINT IF EXISTS makesafe_intake_cases_deterministic_shapes_check;
ALTER TABLE public.makesafe_intake_cases
  ADD CONSTRAINT makesafe_intake_cases_deterministic_shapes_check CHECK (
    (
      adapter_id IS NULL
      OR adapter_id IN (
        'mlb',
        'ajs_ajbr',
        'prime',
        'rapid',
        'builderwest',
        'western',
        'chatter',
        'synthetic_livefire'
      )
    )
    AND jsonb_typeof(story_json) = 'array'
    AND jsonb_typeof(evidence_map) = 'object'
    AND jsonb_typeof(recovery_cursor) = 'object'
    AND (
      adapter_id IS NULL
      OR (
        btrim(adapter_version) <> ''
        AND btrim(manifest_version) <> ''
        AND btrim(source_fingerprint) <> ''
        AND recovery_cursor ? 'version'
        AND recovery_cursor ? 'searchedSourcePostIds'
        AND recovery_cursor ? 'sideEffectKeys'
      )
    )
  );

-- One row is the terminal accounting authority for one UUID-bound live-fire run.
-- The source/case/job arrays identify append-only or group evidence that remains
-- physically present. Readers exclude those entities only after the row reaches
-- terminal with both cleanup and projection-exclusion proof.
CREATE TABLE IF NOT EXISTS public.ses_synthetic_livefire_runs (
  marker text PRIMARY KEY,
  run_id uuid NOT NULL UNIQUE,
  state text NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'cleanup_complete', 'terminal')),
  source_post_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  case_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  job_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  baseline jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  terminal_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ses_synthetic_livefire_runs_marker_check CHECK (
    marker = 'SWG-SES-LIVEFIRE-TEST-ONLY-' || upper(run_id::text)
  ),
  CONSTRAINT ses_synthetic_livefire_runs_json_shapes_check CHECK (
    jsonb_typeof(source_post_ids) = 'array'
    AND jsonb_typeof(case_ids) = 'array'
    AND jsonb_typeof(job_ids) = 'array'
    AND jsonb_typeof(baseline) = 'object'
    AND jsonb_typeof(evidence) = 'object'
  ),
  CONSTRAINT ses_synthetic_livefire_runs_terminal_shape_check CHECK (
    (
      state = 'active'
      AND terminal_at IS NULL
    )
    OR (
      state = 'cleanup_complete'
      AND terminal_at IS NULL
      AND evidence @> '{"deletable_store_cleanup_verified":true}'::jsonb
    )
    OR (
      state = 'terminal'
      AND terminal_at IS NOT NULL
      AND evidence @> '{"deletable_store_cleanup_verified":true}'::jsonb
      AND evidence @> '{"projection_exclusion_verified":true}'::jsonb
    )
  )
);

ALTER TABLE public.ses_synthetic_livefire_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ses_synthetic_livefire_runs
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.ses_synthetic_livefire_runs
  TO service_role, postgres;

DROP POLICY IF EXISTS service_role_all_ses_synthetic_livefire_runs
  ON public.ses_synthetic_livefire_runs;
CREATE POLICY service_role_all_ses_synthetic_livefire_runs
  ON public.ses_synthetic_livefire_runs
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.enforce_ses_synthetic_livefire_run_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'ses_synthetic_livefire_runs is terminal accounting; DELETE is not allowed';
  END IF;

  IF OLD.state = 'terminal' THEN
    RAISE EXCEPTION
      'terminal synthetic live-fire run % is immutable',
      OLD.marker;
  END IF;

  IF NEW.marker IS DISTINCT FROM OLD.marker
    OR NEW.run_id IS DISTINCT FROM OLD.run_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'synthetic live-fire marker identity is immutable';
  END IF;

  IF NEW.state NOT IN ('active', 'cleanup_complete', 'terminal') THEN
    RAISE EXCEPTION
      'synthetic live-fire run state must remain active, become cleanup_complete, or become terminal';
  END IF;

  IF OLD.state = 'active' AND NEW.state = 'terminal' THEN
    RAISE EXCEPTION
      'synthetic live-fire run must prove deletable cleanup before terminal projection proof';
  END IF;

  IF OLD.state = 'cleanup_complete' AND NEW.state = 'active' THEN
    RAISE EXCEPTION
      'synthetic live-fire cleanup cannot be reversed';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_ses_synthetic_livefire_run_change()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_ses_synthetic_livefire_run_change()
  TO service_role, postgres;

DROP TRIGGER IF EXISTS trg_ses_synthetic_livefire_runs_change
  ON public.ses_synthetic_livefire_runs;
CREATE TRIGGER trg_ses_synthetic_livefire_runs_change
  BEFORE UPDATE OR DELETE
  ON public.ses_synthetic_livefire_runs
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_ses_synthetic_livefire_run_change();

CREATE OR REPLACE FUNCTION public.ses_synthetic_livefire_marker_is_terminal(
  p_marker text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.ses_synthetic_livefire_runs run
    WHERE run.marker = p_marker
      AND run.state = 'terminal'
  );
$$;

REVOKE ALL ON FUNCTION public.ses_synthetic_livefire_marker_is_terminal(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE
  ON FUNCTION public.ses_synthetic_livefire_marker_is_terminal(text)
  TO service_role, postgres;

COMMENT ON TABLE public.ses_synthetic_livefire_runs IS
  'Marker-scoped terminal accounting for synthetic SES live-fire runs. Append-only/group evidence remains physically present and is excluded from live projections only after cleanup and exclusion proof are recorded.';
COMMENT ON FUNCTION public.ses_synthetic_livefire_marker_is_terminal(text) IS
  'Read-only service-role helper for excluding a terminally accounted synthetic live-fire run from live projections and health counts.';

CREATE OR REPLACE FUNCTION public.prevent_makesafe_attendance_cycle_identity_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  purge_marker text := current_setting('app.synthetic_livefire_purge_marker', true);
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF purge_marker ~ '^SWG-SES-LIVEFIRE-TEST-ONLY-[0-9A-F]{8}-[0-9A-F]{4}-[1-8][0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$'
       AND purge_marker = (
         SELECT j.metadata->>'synthetic_livefire_marker'
         FROM public.jobs j
         WHERE j.id = OLD.job_id
       )
    THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'makesafe attendance cycle identities are immutable';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.job_id IS DISTINCT FROM OLD.job_id
    OR NEW.cycle_number IS DISTINCT FROM OLD.cycle_number THEN
    RAISE EXCEPTION 'makesafe attendance cycle identities are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.purge_synthetic_livefire_attendance_cycles(
  p_marker text
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  deleted_count bigint;
BEGIN
  IF p_marker !~ '^SWG-SES-LIVEFIRE-TEST-ONLY-[0-9A-F]{8}-[0-9A-F]{4}-[1-8][0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$' THEN
    RAISE EXCEPTION 'invalid synthetic live-fire marker';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.ses_synthetic_livefire_runs run
    WHERE run.marker = p_marker
      AND run.state IN ('active', 'cleanup_complete')
  ) THEN
    RAISE EXCEPTION 'synthetic live-fire run is not purgeable';
  END IF;

  PERFORM set_config('app.synthetic_livefire_purge_marker', p_marker, true);
  DELETE FROM public.makesafe_attendance_cycles cycle
  USING public.jobs job
  WHERE cycle.job_id = job.id
    AND job.metadata->>'synthetic_livefire_marker' = p_marker
    AND EXISTS (
      SELECT 1
      FROM public.ses_synthetic_livefire_runs run
      WHERE run.marker = p_marker
        AND run.job_ids ? cycle.job_id::text
    );
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_synthetic_livefire_attendance_cycles(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_synthetic_livefire_attendance_cycles(text)
  TO service_role, postgres;

CREATE OR REPLACE FUNCTION public.register_synthetic_livefire_job(
  p_marker text,
  p_job_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_marker !~ '^SWG-SES-LIVEFIRE-TEST-ONLY-[0-9A-F]{8}-[0-9A-F]{4}-[1-8][0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$' THEN
    RAISE EXCEPTION 'invalid synthetic live-fire marker';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.ses_synthetic_livefire_runs
    WHERE marker = p_marker AND state = 'active'
  ) THEN
    RAISE EXCEPTION 'synthetic live-fire run is not active';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.jobs
    WHERE id = p_job_id
      AND metadata->>'synthetic_livefire_marker' = p_marker
  ) THEN
    RAISE EXCEPTION 'job is not bound to the synthetic live-fire marker';
  END IF;
  UPDATE public.ses_synthetic_livefire_runs
  SET job_ids = (
    SELECT jsonb_agg(DISTINCT value ORDER BY value)
    FROM jsonb_array_elements(job_ids || jsonb_build_array(p_job_id::text)) AS job_value(value)
  )
  WHERE marker = p_marker AND state = 'active';
END;
$$;

REVOKE ALL ON FUNCTION public.register_synthetic_livefire_job(text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_synthetic_livefire_job(text, uuid)
  TO service_role, postgres;

ALTER TABLE public.job_events
  ALTER COLUMN job_id DROP NOT NULL;
ALTER TABLE public.job_events
  DROP CONSTRAINT IF EXISTS job_events_job_id_fkey;
ALTER TABLE public.job_events
  ADD CONSTRAINT job_events_job_id_fkey
  FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE SET NULL;

ALTER TABLE public.makesafe_intake_cases
  DROP CONSTRAINT IF EXISTS makesafe_intake_cases_job_id_fkey;
ALTER TABLE public.makesafe_intake_cases
  ADD CONSTRAINT makesafe_intake_cases_job_id_fkey
  FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE SET NULL;

-- Fresh-source health must not let retained group evidence move work-coverage
-- timestamps or counts after cleanup. cleanup_complete is the short proof window:
-- storage/rows are clean, the runner can now observe the exclusion live, and only
-- then may it transition the immutable run to terminal.
CREATE OR REPLACE FUNCTION public.makesafe_intake_fresh_source_health(
  p_org_id uuid,
  p_mailbox text,
  p_since timestamptz,
  p_now timestamptz DEFAULT now()
)
RETURNS TABLE (
  latest_ingested_received_at timestamptz,
  latest_final_fate_received_at timestamptz,
  unfated_source_count bigint,
  oldest_unfated_received_at timestamptz,
  fresh_source_lag_seconds bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH eligible AS MATERIALIZED (
    SELECT
      email.post_id,
      email.received_at,
      (
        (
          SELECT count(*)
          FROM public.makesafe_intake_case_sources source
          WHERE source.org_id = p_org_id
            AND source.post_id = email.post_id
        )
        +
        CASE
          WHEN EXISTS (
            SELECT 1
            FROM public.email_classifier_exclusions exclusion
            WHERE exclusion.mailbox = p_mailbox
              AND exclusion.post_id = email.post_id
          )
          OR EXISTS (
            SELECT 1
            FROM public.email_events_raw event
            WHERE event.org_id = p_org_id
              AND event.post_id = email.post_id
              AND event.change_type = 'excluded'
          )
          THEN 1
          ELSE 0
        END
      ) = 1 AS final_fate
    FROM public.emails email
    WHERE email.mailbox = p_mailbox
      AND email.received_at >= p_since
      AND NOT EXISTS (
        SELECT 1
        FROM public.ses_synthetic_livefire_runs run
        WHERE run.state = 'terminal'
          AND run.source_post_ids ? email.post_id
      )
  ),
  aggregate AS (
    SELECT
      max(received_at) FILTER (WHERE final_fate)
        AS latest_final_fate_received_at,
      count(*) FILTER (WHERE NOT final_fate)
        AS unfated_source_count,
      min(received_at) FILTER (WHERE NOT final_fate)
        AS oldest_unfated_received_at
    FROM eligible
  )
  SELECT
    (
      SELECT cursor.last_completed_max
      FROM public.mail_sync_cursors cursor
      WHERE cursor.mailbox = p_mailbox
    ) AS latest_ingested_received_at,
    aggregate.latest_final_fate_received_at,
    aggregate.unfated_source_count,
    aggregate.oldest_unfated_received_at,
    CASE
      WHEN aggregate.oldest_unfated_received_at IS NULL THEN 0::bigint
      ELSE greatest(
        0::bigint,
        floor(
          extract(epoch FROM (p_now - aggregate.oldest_unfated_received_at))
        )::bigint
      )
    END AS fresh_source_lag_seconds
  FROM aggregate;
$$;

REVOKE ALL ON FUNCTION public.makesafe_intake_fresh_source_health(
  uuid,
  text,
  timestamptz,
  timestamptz
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.makesafe_intake_fresh_source_health(
  uuid,
  text,
  timestamptz,
  timestamptz
) TO service_role, postgres;

CREATE OR REPLACE FUNCTION public.makesafe_synthetic_livefire_source_health(
  p_org_id uuid,
  p_mailbox text,
  p_since timestamptz,
  p_source_post_ids jsonb,
  p_terminal_override boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH requested AS (
    SELECT value AS post_id
    FROM jsonb_array_elements_text(p_source_post_ids)
  ),
  source_state AS (
    SELECT
      requested.post_id,
      EXISTS (
        SELECT 1
        FROM public.emails email
        WHERE email.post_id = requested.post_id
          AND email.mailbox = p_mailbox
          AND email.received_at >= p_since
      ) AS source_present,
      (
        (
          SELECT count(*)
          FROM public.makesafe_intake_case_sources source
          WHERE source.org_id = p_org_id
            AND source.post_id = requested.post_id
        )
        +
        CASE
          WHEN EXISTS (
            SELECT 1
            FROM public.email_classifier_exclusions exclusion
            WHERE exclusion.mailbox = p_mailbox
              AND exclusion.post_id = requested.post_id
          )
          OR EXISTS (
            SELECT 1
            FROM public.email_events_raw event
            WHERE event.org_id = p_org_id
              AND event.post_id = requested.post_id
              AND event.change_type = 'excluded'
          )
          THEN 1
          ELSE 0
        END
      ) = 1 AS final_fate,
      p_terminal_override OR EXISTS (
        SELECT 1
        FROM public.ses_synthetic_livefire_runs run
        WHERE run.state = 'terminal'
          AND run.source_post_ids ? requested.post_id
      ) AS excluded
    FROM requested
  )
  SELECT jsonb_build_object(
    'sources', COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'post_id', source_state.post_id,
          'source_present', source_state.source_present,
          'final_fate', source_state.final_fate,
          'excluded', source_state.excluded,
          'eligible', source_state.source_present AND NOT source_state.excluded
        )
        ORDER BY source_state.post_id
      ),
      '[]'::jsonb
    ),
    'source_count', count(*)::bigint,
    'eligible_count', count(*) FILTER (
      WHERE source_state.source_present AND NOT source_state.excluded
    )::bigint,
    'excluded_count', count(*) FILTER (WHERE source_state.excluded)::bigint
  )
  FROM source_state;
$$;

REVOKE ALL ON FUNCTION public.makesafe_synthetic_livefire_source_health(
  uuid,
  text,
  timestamptz,
  jsonb,
  boolean
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.makesafe_synthetic_livefire_source_health(
  uuid,
  text,
  timestamptz,
  jsonb,
  boolean
) TO service_role, postgres;

CREATE OR REPLACE FUNCTION public.terminalize_synthetic_livefire_run(
  p_marker text,
  p_org_id uuid,
  p_mailbox text,
  p_since timestamptz,
  p_source_post_ids jsonb,
  p_case_ids jsonb,
  p_job_ids jsonb,
  p_evidence jsonb,
  p_terminal_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  source_health jsonb;
BEGIN
  IF current_setting('request.jwt.claim.role', true) <> 'service_role' THEN
    RAISE EXCEPTION 'synthetic live-fire terminalization requires service_role';
  END IF;
  IF p_marker !~ '^SWG-SES-LIVEFIRE-TEST-ONLY-[0-9A-F]{8}-[0-9A-F]{4}-[1-8][0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$' THEN
    RAISE EXCEPTION 'invalid synthetic live-fire marker';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.ses_synthetic_livefire_runs run
    WHERE run.marker = p_marker
      AND run.state = 'cleanup_complete'
  ) THEN
    RAISE EXCEPTION 'synthetic live-fire run is not ready for terminalization';
  END IF;

  source_health := public.makesafe_synthetic_livefire_source_health(
    p_org_id,
    p_mailbox,
    p_since,
    p_source_post_ids,
    true
  );
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(source_health->'sources') source
    WHERE NOT COALESCE((source->>'source_present')::boolean, false)
      OR NOT COALESCE((source->>'excluded')::boolean, false)
  ) THEN
    RAISE EXCEPTION 'synthetic live-fire source exclusion proof failed';
  END IF;

  UPDATE public.ses_synthetic_livefire_runs
  SET state = 'terminal',
      source_post_ids = p_source_post_ids,
      case_ids = p_case_ids,
      job_ids = p_job_ids,
      evidence = p_evidence || jsonb_build_object(
        'synthetic_health_sources_excluded', true,
        'fresh_source_health_after_terminal_sources', source_health
      ),
      terminal_at = p_terminal_at
  WHERE marker = p_marker;

  RETURN source_health;
END;
$$;

REVOKE ALL ON FUNCTION public.terminalize_synthetic_livefire_run(
  text,
  uuid,
  text,
  timestamptz,
  jsonb,
  jsonb,
  jsonb,
  jsonb,
  timestamptz
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.terminalize_synthetic_livefire_run(
  text,
  uuid,
  text,
  timestamptz,
  jsonb,
  jsonb,
  jsonb,
  jsonb,
  timestamptz
) TO service_role, postgres;

-- Captain unblock: own-mail chatter already accounted before this kit existed
-- remains immutable group/case evidence. Bind that exact safe shape to one
-- terminal marker so fresh-source health excludes it without altering a source,
-- case, event, job, message, or attachment row.
WITH legacy_own_chatter AS (
  SELECT DISTINCT
    email.post_id,
    intake_case.id AS case_id
  FROM public.emails email
  JOIN public.makesafe_intake_case_sources source
    ON source.post_id = email.post_id
   AND source.org_id = '00000000-0000-0000-0000-000000000001'
  JOIN public.makesafe_intake_cases intake_case
    ON intake_case.id = source.case_id
   AND intake_case.org_id = source.org_id
  WHERE email.mailbox = 'ses@secureworkswa.com.au'
    AND lower(COALESCE(email.from_email, '')) =
      'marnin@secureworkswa.com.au'
    AND COALESCE(email.subject, '') NOT ILIKE
      '%SWG-SES-LIVEFIRE-TEST-ONLY-%'
    AND intake_case.state = 'accounted_non_wo'
    AND intake_case.reason_code = 'non_makesafe'
    AND intake_case.adapter_id = 'chatter'
    AND intake_case.job_id IS NULL
),
legacy_rollup AS (
  SELECT
    jsonb_agg(post_id ORDER BY post_id) AS source_post_ids,
    jsonb_agg(case_id ORDER BY case_id) AS case_ids,
    count(*) AS source_count
  FROM legacy_own_chatter
)
INSERT INTO public.ses_synthetic_livefire_runs (
  marker,
  run_id,
  state,
  source_post_ids,
  case_ids,
  job_ids,
  baseline,
  evidence,
  terminal_at
)
SELECT
  'SWG-SES-LIVEFIRE-TEST-ONLY-00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000001',
  'terminal',
  source_post_ids,
  case_ids,
  '[]'::jsonb,
  '{}'::jsonb,
  jsonb_build_object(
    'kind', 'legacy_own_mail_chatter',
    'captain_unblock', true,
    'source_count', source_count,
    'selection', 'exact own sender + SES mailbox + chatter adapter + accounted_non_wo + non_makesafe + no job',
    'deletable_store_cleanup_verified', true,
    'projection_exclusion_verified', true
  ),
  now()
FROM legacy_rollup
WHERE source_count > 0
ON CONFLICT (marker) DO NOTHING;
