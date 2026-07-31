CREATE TABLE IF NOT EXISTS public.makesafe_pdf_extraction_coordinates (
  coordinate text PRIMARY KEY,
  sha256 text,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  claim_token uuid,
  started_at timestamptz,
  completed_at timestamptz,
  next_attempt_at timestamptz,
  extracted_text text,
  char_count integer NOT NULL DEFAULT 0,
  page_count integer,
  extractor text,
  truncated boolean NOT NULL DEFAULT false,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT makesafe_pdf_extraction_coordinates_status_check
    CHECK (status IN ('pending', 'processing', 'extracted', 'quarantined', 'failed')),
  CONSTRAINT makesafe_pdf_extraction_coordinates_attempts_check
    CHECK (attempts BETWEEN 0 AND 3)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_makesafe_pdf_extraction_coordinates_sha
  ON public.makesafe_pdf_extraction_coordinates (sha256)
  WHERE sha256 IS NOT NULL;

ALTER TABLE public.makesafe_pdf_extraction_coordinates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.makesafe_pdf_extraction_coordinates
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.makesafe_pdf_extraction_coordinates TO service_role;

DROP POLICY IF EXISTS service_role_all_makesafe_pdf_extraction_coordinates
  ON public.makesafe_pdf_extraction_coordinates;
CREATE POLICY service_role_all_makesafe_pdf_extraction_coordinates
  ON public.makesafe_pdf_extraction_coordinates
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.purge_makesafe_pdf_extraction_coordinate_text()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  coordinate_key text;
BEGIN
  IF OLD.pdf_extraction_text IS NOT NULL AND NEW.pdf_extraction_text IS NULL THEN
    coordinate_key := CASE
      WHEN NULLIF(NEW.sha256, '') IS NULL THEN 'id:' || NEW.id::text
      ELSE 'sha:' || NEW.sha256
    END;
    IF NOT EXISTS (
      SELECT 1
      FROM public.email_attachments a
      WHERE a.id <> NEW.id
        AND a.pdf_extraction_text IS NOT NULL
        AND coordinate_key = CASE
          WHEN NULLIF(a.sha256, '') IS NULL THEN 'id:' || a.id::text
          ELSE 'sha:' || a.sha256
        END
    ) THEN
      UPDATE public.makesafe_pdf_extraction_coordinates
      SET extracted_text = NULL,
          updated_at = now()
      WHERE coordinate = coordinate_key;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_purge_makesafe_pdf_extraction_coordinate_text
  ON public.email_attachments;
CREATE TRIGGER trg_purge_makesafe_pdf_extraction_coordinate_text
AFTER UPDATE OF pdf_extraction_text
ON public.email_attachments
FOR EACH ROW
EXECUTE FUNCTION public.purge_makesafe_pdf_extraction_coordinate_text();

WITH ranked AS (
  SELECT
    CASE
      WHEN NULLIF(a.sha256, '') IS NULL THEN 'id:' || a.id::text
      ELSE 'sha:' || a.sha256
    END AS coordinate,
    NULLIF(a.sha256, '') AS sha256,
    a.pdf_extraction_status AS status,
    a.pdf_extraction_attempts AS attempts,
    a.pdf_extraction_claim_token AS claim_token,
    a.pdf_extraction_started_at AS started_at,
    a.pdf_extraction_completed_at AS completed_at,
    a.pdf_extraction_next_attempt_at AS next_attempt_at,
    a.pdf_extraction_text AS extracted_text,
    a.pdf_extraction_char_count AS char_count,
    a.pdf_extraction_page_count AS page_count,
    a.pdf_extraction_extractor AS extractor,
    a.pdf_extraction_truncated AS truncated,
    a.pdf_extraction_reason AS reason,
    ROW_NUMBER() OVER (
      PARTITION BY CASE
        WHEN NULLIF(a.sha256, '') IS NULL THEN 'id:' || a.id::text
        ELSE 'sha:' || a.sha256
      END
      ORDER BY
        CASE a.pdf_extraction_status
          WHEN 'extracted' THEN 0
          WHEN 'quarantined' THEN 1
          WHEN 'processing' THEN 2
          WHEN 'failed' THEN 3
          ELSE 4
        END,
        a.pdf_extraction_attempts DESC,
        a.pdf_extraction_completed_at DESC NULLS LAST,
        a.created_at,
        a.id
    ) AS rank
  FROM public.email_attachments a
  WHERE a.status = 'uploaded'
)
INSERT INTO public.makesafe_pdf_extraction_coordinates (
  coordinate, sha256, status, attempts, claim_token, started_at, completed_at,
  next_attempt_at, extracted_text, char_count, page_count, extractor, truncated,
  reason
)
SELECT
  coordinate, sha256, status, LEAST(attempts, 3), claim_token, started_at,
  completed_at, next_attempt_at, extracted_text, char_count, page_count,
  extractor, truncated, reason
FROM ranked
WHERE rank = 1
ON CONFLICT (coordinate) DO NOTHING;

CREATE OR REPLACE FUNCTION public.enqueue_makesafe_pdf_extraction()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  should_enqueue boolean := false;
  coordinate_key text;
BEGIN
  IF NEW.status = 'uploaded' THEN
    IF TG_OP = 'INSERT' THEN
      should_enqueue := true;
    ELSE
      should_enqueue :=
        OLD.status IS DISTINCT FROM 'uploaded'
        OR OLD.sha256 IS DISTINCT FROM NEW.sha256
        OR NEW.pdf_extraction_status = 'not_applicable';
    END IF;
  END IF;
  IF should_enqueue THEN
    coordinate_key := CASE
      WHEN NULLIF(NEW.sha256, '') IS NULL THEN 'id:' || NEW.id::text
      ELSE 'sha:' || NEW.sha256
    END;
    INSERT INTO public.makesafe_pdf_extraction_coordinates (
      coordinate, sha256, status
    )
    VALUES (coordinate_key, NULLIF(NEW.sha256, ''), 'pending')
    ON CONFLICT (coordinate) DO NOTHING;

    SELECT
      status, extracted_text, char_count, page_count, extractor, truncated,
      reason, attempts, claim_token, started_at, completed_at, next_attempt_at
    INTO
      NEW.pdf_extraction_status, NEW.pdf_extraction_text,
      NEW.pdf_extraction_char_count, NEW.pdf_extraction_page_count,
      NEW.pdf_extraction_extractor, NEW.pdf_extraction_truncated,
      NEW.pdf_extraction_reason, NEW.pdf_extraction_attempts,
      NEW.pdf_extraction_claim_token, NEW.pdf_extraction_started_at,
      NEW.pdf_extraction_completed_at, NEW.pdf_extraction_next_attempt_at
    FROM public.makesafe_pdf_extraction_coordinates
    WHERE coordinate = coordinate_key;

    NEW.pdf_handoff_status := CASE
      WHEN NEW.pdf_extraction_status IN ('extracted', 'quarantined')
        THEN 'pending'
      ELSE 'not_required'
    END;
    NEW.pdf_handoff_reason := NULL;
    NEW.pdf_handoff_started_at := NULL;
    NEW.pdf_handoff_completed_at := NULL;
    NEW.pdf_handoff_next_attempt_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_makesafe_pdf_extraction(
  p_attachment_id uuid DEFAULT NULL,
  p_fresh_only boolean DEFAULT false
)
RETURNS SETOF public.email_attachments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  selected_coordinate text;
  selected_id uuid;
  selected_work text;
  new_claim_token uuid := gen_random_uuid();
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('makesafe_pdf_extraction_coordinate', 0)
  );

  INSERT INTO public.makesafe_pdf_extraction_coordinates (
    coordinate, sha256, status
  )
  SELECT DISTINCT ON (
    CASE
      WHEN NULLIF(a.sha256, '') IS NULL THEN 'id:' || a.id::text
      ELSE 'sha:' || a.sha256
    END
  )
    CASE
      WHEN NULLIF(a.sha256, '') IS NULL THEN 'id:' || a.id::text
      ELSE 'sha:' || a.sha256
    END,
    NULLIF(a.sha256, ''),
    'pending'
  FROM public.email_attachments a
  WHERE a.status = 'uploaded'
  ON CONFLICT (coordinate) DO NOTHING;

  UPDATE public.makesafe_pdf_extraction_coordinates c
     SET status = CASE WHEN c.attempts >= 3 THEN 'quarantined' ELSE 'failed' END,
         reason = CASE
           WHEN c.attempts >= 3 THEN 'retry_exhausted:processing_lease_expired'
           ELSE 'processing_lease_expired'
         END,
         claim_token = NULL,
         started_at = NULL,
         completed_at = CASE WHEN c.attempts >= 3 THEN now() ELSE NULL END,
         next_attempt_at = CASE WHEN c.attempts >= 3 THEN NULL ELSE now() END,
         updated_at = now()
   WHERE c.status = 'processing'
     AND c.started_at < now() - interval '2 minutes';

  UPDATE public.email_attachments a
     SET pdf_extraction_status = c.status,
         pdf_extraction_text = c.extracted_text,
         pdf_extraction_char_count = c.char_count,
         pdf_extraction_page_count = c.page_count,
         pdf_extraction_extractor = c.extractor,
         pdf_extraction_truncated = c.truncated,
         pdf_extraction_reason = c.reason,
         pdf_extraction_attempts = c.attempts,
         pdf_extraction_claim_token = c.claim_token,
         pdf_extraction_started_at = c.started_at,
         pdf_extraction_completed_at = c.completed_at,
         pdf_extraction_next_attempt_at = c.next_attempt_at,
         pdf_handoff_status = CASE
           WHEN c.status IN ('extracted', 'quarantined')
             AND a.pdf_handoff_status = 'not_required' THEN 'pending'
           ELSE a.pdf_handoff_status
         END,
         updated_at = now()
    FROM public.makesafe_pdf_extraction_coordinates c
   WHERE a.status = 'uploaded'
     AND c.coordinate = CASE
       WHEN NULLIF(a.sha256, '') IS NULL THEN 'id:' || a.id::text
       ELSE 'sha:' || a.sha256
     END
     AND (
       a.pdf_extraction_status IS DISTINCT FROM c.status
       OR a.pdf_extraction_attempts IS DISTINCT FROM c.attempts
       OR a.pdf_extraction_claim_token IS DISTINCT FROM c.claim_token
     );

  SELECT c.coordinate, a.id, 'extract'
    INTO selected_coordinate, selected_id, selected_work
    FROM public.makesafe_pdf_extraction_coordinates c
    JOIN LATERAL (
      SELECT candidate.id, e.received_at, candidate.created_at
      FROM public.email_attachments candidate
      JOIN public.emails e ON e.post_id = candidate.email_id
      WHERE candidate.status = 'uploaded'
        AND c.coordinate = CASE
          WHEN NULLIF(candidate.sha256, '') IS NULL
            THEN 'id:' || candidate.id::text
          ELSE 'sha:' || candidate.sha256
        END
        AND (p_attachment_id IS NULL OR candidate.id = p_attachment_id)
      ORDER BY
        CASE WHEN p_fresh_only THEN e.received_at END DESC NULLS LAST,
        e.received_at,
        candidate.created_at,
        candidate.id
      LIMIT 1
    ) a ON true
   WHERE c.status IN ('pending', 'failed')
     AND c.attempts < 3
     AND (c.next_attempt_at IS NULL OR c.next_attempt_at <= now())
   ORDER BY
     CASE WHEN p_fresh_only THEN a.received_at END DESC NULLS LAST,
     CASE WHEN c.attempts = 0 THEN 0 ELSE 1 END,
     a.received_at,
     a.created_at,
     c.coordinate
   FOR UPDATE OF c SKIP LOCKED
   LIMIT 1;

  IF selected_coordinate IS NOT NULL THEN
    UPDATE public.makesafe_pdf_extraction_coordinates
       SET status = 'processing',
           attempts = attempts + 1,
           claim_token = new_claim_token,
           started_at = now(),
           completed_at = NULL,
           next_attempt_at = NULL,
           updated_at = now()
     WHERE coordinate = selected_coordinate;

    UPDATE public.email_attachments a
       SET pdf_extraction_status = 'processing',
           pdf_extraction_attempts = c.attempts,
           pdf_extraction_claim_token = c.claim_token,
           pdf_extraction_started_at = c.started_at,
           pdf_extraction_completed_at = NULL,
           pdf_extraction_next_attempt_at = NULL,
           updated_at = now()
      FROM public.makesafe_pdf_extraction_coordinates c
     WHERE c.coordinate = selected_coordinate
       AND a.status = 'uploaded'
       AND c.coordinate = CASE
         WHEN NULLIF(a.sha256, '') IS NULL THEN 'id:' || a.id::text
         ELSE 'sha:' || a.sha256
       END;

    RETURN QUERY
      SELECT a.*
      FROM public.email_attachments a
      WHERE a.id = selected_id
        AND a.pdf_extraction_claim_token = new_claim_token;
    RETURN;
  END IF;

  SELECT a.id, 'handoff'
    INTO selected_id, selected_work
    FROM public.email_attachments a
    JOIN public.emails e ON e.post_id = a.email_id
   WHERE a.status = 'uploaded'
     AND a.pdf_extraction_status IN ('extracted', 'quarantined')
     AND (
       a.pdf_handoff_status = 'pending'
       OR (
         a.pdf_handoff_status = 'failed'
         AND (
           a.pdf_handoff_next_attempt_at IS NULL
           OR a.pdf_handoff_next_attempt_at <= now()
         )
       )
       OR (
         a.pdf_handoff_status = 'processing'
         AND a.pdf_handoff_started_at < now() - interval '2 minutes'
       )
     )
     AND (p_attachment_id IS NULL OR a.id = p_attachment_id)
   ORDER BY
     CASE WHEN p_fresh_only THEN e.received_at END DESC NULLS LAST,
     e.received_at,
     a.created_at,
     a.id
   FOR UPDATE OF a SKIP LOCKED
   LIMIT 1;

  IF selected_id IS NULL THEN
    RETURN;
  END IF;

  UPDATE public.email_attachments
     SET pdf_extraction_claim_token = new_claim_token,
         pdf_handoff_status = 'processing',
         pdf_handoff_started_at = now(),
         pdf_handoff_completed_at = NULL,
         pdf_handoff_attempts = pdf_handoff_attempts + 1,
         updated_at = now()
   WHERE id = selected_id;

  RETURN QUERY
    SELECT a.*
    FROM public.email_attachments a
    WHERE a.id = selected_id
      AND a.pdf_extraction_claim_token = new_claim_token;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_makesafe_pdf_extraction(uuid, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_makesafe_pdf_extraction(uuid, boolean)
  TO service_role, postgres;

CREATE OR REPLACE FUNCTION public.complete_makesafe_pdf_extraction(
  p_attachment_id uuid,
  p_claim_token uuid,
  p_outcome text,
  p_reason text DEFAULT NULL,
  p_text text DEFAULT NULL,
  p_char_count integer DEFAULT 0,
  p_page_count integer DEFAULT NULL,
  p_extractor text DEFAULT NULL,
  p_truncated boolean DEFAULT false,
  p_completed_at timestamptz DEFAULT now(),
  p_next_attempt_at timestamptz DEFAULT NULL
)
RETURNS SETOF public.email_attachments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  coordinate_key text;
  settled_outcome text;
  settled_reason text;
BEGIN
  IF p_outcome NOT IN ('extracted', 'quarantined', 'failed') THEN
    RAISE EXCEPTION 'invalid PDF extraction outcome %', p_outcome;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('makesafe_pdf_extraction_coordinate', 0)
  );

  SELECT CASE
      WHEN NULLIF(a.sha256, '') IS NULL THEN 'id:' || a.id::text
      ELSE 'sha:' || a.sha256
    END
    INTO coordinate_key
    FROM public.email_attachments a
   WHERE a.id = p_attachment_id
   FOR UPDATE;

  IF coordinate_key IS NULL THEN
    RAISE EXCEPTION 'PDF extraction attachment % not found', p_attachment_id;
  END IF;

  SELECT CASE
      WHEN p_outcome = 'failed' AND c.attempts >= 3 THEN 'quarantined'
      ELSE p_outcome
    END,
    CASE
      WHEN p_outcome = 'failed' AND c.attempts >= 3
        THEN left('retry_exhausted:' || COALESCE(p_reason, 'unknown'), 500)
      ELSE p_reason
    END
    INTO settled_outcome, settled_reason
    FROM public.makesafe_pdf_extraction_coordinates c
   WHERE c.coordinate = coordinate_key
     AND c.status = 'processing'
     AND c.claim_token = p_claim_token
   FOR UPDATE;

  IF settled_outcome IS NULL THEN
    RAISE EXCEPTION 'PDF extraction claim fence lost for %', p_attachment_id;
  END IF;

  UPDATE public.makesafe_pdf_extraction_coordinates
     SET status = settled_outcome,
         extracted_text = p_text,
         char_count = COALESCE(p_char_count, 0),
         page_count = p_page_count,
         extractor = p_extractor,
         truncated = COALESCE(p_truncated, false),
         reason = settled_reason,
         claim_token = NULL,
         started_at = NULL,
         completed_at = CASE
           WHEN settled_outcome = 'failed' THEN NULL
           ELSE p_completed_at
         END,
         next_attempt_at = CASE
           WHEN settled_outcome = 'failed' THEN p_next_attempt_at
           ELSE NULL
         END,
         updated_at = p_completed_at
   WHERE coordinate = coordinate_key;

  UPDATE public.email_attachments a
     SET pdf_extraction_status = c.status,
         pdf_extraction_text = c.extracted_text,
         pdf_extraction_char_count = c.char_count,
         pdf_extraction_page_count = c.page_count,
         pdf_extraction_extractor = c.extractor,
         pdf_extraction_truncated = c.truncated,
         pdf_extraction_reason = c.reason,
         pdf_extraction_attempts = c.attempts,
         pdf_extraction_claim_token = p_claim_token,
         pdf_extraction_started_at = NULL,
         pdf_extraction_completed_at = c.completed_at,
         pdf_extraction_next_attempt_at = c.next_attempt_at,
         pdf_handoff_status = CASE
           WHEN c.status = 'failed' THEN 'not_required'
           ELSE 'pending'
         END,
         pdf_handoff_reason = NULL,
         pdf_handoff_started_at = NULL,
         pdf_handoff_completed_at = NULL,
         pdf_handoff_next_attempt_at = NULL,
         updated_at = p_completed_at
    FROM public.makesafe_pdf_extraction_coordinates c
   WHERE c.coordinate = coordinate_key
     AND a.status = 'uploaded'
     AND c.coordinate = CASE
       WHEN NULLIF(a.sha256, '') IS NULL THEN 'id:' || a.id::text
       ELSE 'sha:' || a.sha256
     END;

  RETURN QUERY
    SELECT a.*
    FROM public.email_attachments a
    WHERE a.status = 'uploaded'
      AND a.pdf_extraction_claim_token = p_claim_token
      AND coordinate_key = CASE
        WHEN NULLIF(a.sha256, '') IS NULL THEN 'id:' || a.id::text
        ELSE 'sha:' || a.sha256
      END;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_makesafe_pdf_extraction(
  uuid, uuid, text, text, text, integer, integer, text, boolean, timestamptz,
  timestamptz
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_makesafe_pdf_extraction(
  uuid, uuid, text, text, text, integer, integer, text, boolean, timestamptz,
  timestamptz
) TO service_role, postgres;

CREATE OR REPLACE FUNCTION public.makesafe_pdf_extraction_backlog_estimate()
RETURNS TABLE (
  remaining_coordinates bigint,
  estimated_minutes bigint
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COUNT(*)::bigint,
         COALESCE(SUM(
           GREATEST(1, 3 - c.attempts)
           + GREATEST(0, 2 - c.attempts) * 2
         ), 0)::bigint
  FROM public.makesafe_pdf_extraction_coordinates c
  WHERE c.status IN ('pending', 'failed', 'processing')
    AND c.attempts < 3
    AND EXISTS (
      SELECT 1
      FROM public.email_attachments a
      WHERE a.status = 'uploaded'
        AND c.coordinate = CASE
          WHEN NULLIF(a.sha256, '') IS NULL THEN 'id:' || a.id::text
          ELSE 'sha:' || a.sha256
        END
    );
$$;

CREATE TABLE IF NOT EXISTS public.makesafe_intake_job_mints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organisations(id) ON DELETE RESTRICT,
  draft_id uuid NOT NULL REFERENCES public.makesafe_intake_drafts(id) ON DELETE RESTRICT,
  mint_role text NOT NULL,
  case_id uuid,
  source_post_ids text[] NOT NULL DEFAULT '{}',
  job_id uuid REFERENCES public.jobs(id) ON DELETE RESTRICT,
  state text NOT NULL DEFAULT 'reserved',
  evidence_attached_at timestamptz,
  board_observed_at timestamptz,
  notification_accepted_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT makesafe_intake_job_mints_role_unique
    UNIQUE (org_id, draft_id, mint_role),
  CONSTRAINT makesafe_intake_job_mints_job_unique
    UNIQUE (org_id, job_id),
  CONSTRAINT makesafe_intake_job_mints_case_fk
    FOREIGN KEY (org_id, case_id)
    REFERENCES public.makesafe_intake_cases(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT makesafe_intake_job_mints_state_check
    CHECK (state IN ('reserved', 'minted', 'settlement_failed', 'settled')),
  CONSTRAINT makesafe_intake_job_mints_sources_check
    CHECK (array_position(source_post_ids, NULL) IS NULL)
);

ALTER TABLE public.makesafe_intake_job_mints ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.makesafe_intake_job_mints
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.makesafe_intake_job_mints TO service_role;

DROP POLICY IF EXISTS service_role_all_makesafe_intake_job_mints
  ON public.makesafe_intake_job_mints;
CREATE POLICY service_role_all_makesafe_intake_job_mints
  ON public.makesafe_intake_job_mints
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.reserve_makesafe_intake_job_mint(
  p_org_id uuid,
  p_draft_id uuid,
  p_mint_role text,
  p_case_id uuid DEFAULT NULL,
  p_source_post_ids text[] DEFAULT '{}'
)
RETURNS SETOF public.makesafe_intake_job_mints
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NULLIF(trim(p_mint_role), '') IS NULL THEN
    RAISE EXCEPTION 'mint role required';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.makesafe_intake_drafts d
    WHERE d.id = p_draft_id
      AND d.org_id = p_org_id
  ) THEN
    RAISE EXCEPTION 'draft % is not owned by organisation %', p_draft_id, p_org_id;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.makesafe_intake_job_mints m
    WHERE m.org_id = p_org_id
      AND m.draft_id = p_draft_id
      AND m.mint_role = trim(p_mint_role)
      AND (
        (
          m.case_id IS NOT NULL
          AND p_case_id IS NOT NULL
          AND m.case_id <> p_case_id
        )
        OR (
          cardinality(m.source_post_ids) > 0
          AND cardinality(COALESCE(p_source_post_ids, '{}')) > 0
          AND m.source_post_ids <> p_source_post_ids
        )
      )
  ) THEN
    RAISE EXCEPTION 'intake mint authority conflict for draft % role %',
      p_draft_id, p_mint_role;
  END IF;
  INSERT INTO public.makesafe_intake_job_mints (
    org_id, draft_id, mint_role, case_id, source_post_ids
  )
  VALUES (
    p_org_id, p_draft_id, trim(p_mint_role), p_case_id,
    COALESCE(p_source_post_ids, '{}')
  )
  ON CONFLICT (org_id, draft_id, mint_role)
  DO UPDATE SET
    case_id = COALESCE(
      public.makesafe_intake_job_mints.case_id,
      EXCLUDED.case_id
    ),
    source_post_ids = CASE
      WHEN cardinality(public.makesafe_intake_job_mints.source_post_ids) = 0
        THEN EXCLUDED.source_post_ids
      ELSE public.makesafe_intake_job_mints.source_post_ids
    END,
    updated_at = now();

  RETURN QUERY
    SELECT m.*
    FROM public.makesafe_intake_job_mints m
    WHERE m.org_id = p_org_id
      AND m.draft_id = p_draft_id
      AND m.mint_role = trim(p_mint_role);
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_makesafe_intake_job_mint(
  p_mint_id uuid,
  p_job_id uuid
)
RETURNS SETOF public.makesafe_intake_job_mints
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  mint_row public.makesafe_intake_job_mints%ROWTYPE;
BEGIN
  SELECT *
  INTO mint_row
  FROM public.makesafe_intake_job_mints
  WHERE id = p_mint_id
  FOR UPDATE;

  IF mint_row.id IS NULL THEN
    RAISE EXCEPTION 'intake mint % not found', p_mint_id;
  END IF;
  IF mint_row.job_id IS NOT NULL AND mint_row.job_id <> p_job_id THEN
    RAISE EXCEPTION 'intake mint % already bound to another job', p_mint_id;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.jobs j
    WHERE j.id = p_job_id
      AND j.org_id = mint_row.org_id
  ) THEN
    RAISE EXCEPTION 'job % is not owned by mint organisation', p_job_id;
  END IF;

  UPDATE public.makesafe_intake_job_mints
     SET job_id = p_job_id,
         state = CASE WHEN state = 'settled' THEN state ELSE 'minted' END,
         last_error = NULL,
         updated_at = now()
   WHERE id = p_mint_id;

  IF mint_row.mint_role = 'primary' THEN
    UPDATE public.makesafe_intake_drafts
       SET approved_job_id = p_job_id,
           updated_at = now()
     WHERE id = mint_row.draft_id
       AND org_id = mint_row.org_id
       AND (approved_job_id IS NULL OR approved_job_id = p_job_id);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'draft mint linkage conflict for %', mint_row.draft_id;
    END IF;
  END IF;

  RETURN QUERY
    SELECT m.*
    FROM public.makesafe_intake_job_mints m
    WHERE m.id = p_mint_id;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_makesafe_intake_job_mint(
  uuid, uuid, text, uuid, text[]
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_makesafe_intake_job_mint(
  uuid, uuid, text, uuid, text[]
) TO service_role, postgres;
REVOKE ALL ON FUNCTION public.complete_makesafe_intake_job_mint(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_makesafe_intake_job_mint(uuid, uuid)
  TO service_role, postgres;

CREATE TABLE IF NOT EXISTS public.makesafe_intake_hugo_notification_duplicates (
  notification_id uuid PRIMARY KEY,
  retained_notification_id uuid NOT NULL,
  snapshot jsonb NOT NULL,
  archived_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.makesafe_intake_hugo_notification_duplicates
  ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.makesafe_intake_hugo_notification_duplicates
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.makesafe_intake_hugo_notification_duplicates
  TO service_role;

DROP POLICY IF EXISTS service_role_all_makesafe_intake_hugo_notification_duplicates
  ON public.makesafe_intake_hugo_notification_duplicates;
CREATE POLICY service_role_all_makesafe_intake_hugo_notification_duplicates
  ON public.makesafe_intake_hugo_notification_duplicates
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

WITH ranked AS (
  SELECT
    h.id,
    FIRST_VALUE(h.id) OVER (
      PARTITION BY h.org_id, h.job_id
      ORDER BY
        CASE h.state WHEN 'accepted' THEN 0 WHEN 'attempting' THEN 1 ELSE 2 END,
        h.provider_accepted_at ASC NULLS LAST,
        h.attempted_at,
        h.id
    ) AS retained_id,
    ROW_NUMBER() OVER (
      PARTITION BY h.org_id, h.job_id
      ORDER BY
        CASE h.state WHEN 'accepted' THEN 0 WHEN 'attempting' THEN 1 ELSE 2 END,
        h.provider_accepted_at ASC NULLS LAST,
        h.attempted_at,
        h.id
    ) AS rank
  FROM public.makesafe_intake_hugo_notifications h
),
archived AS (
  INSERT INTO public.makesafe_intake_hugo_notification_duplicates (
    notification_id, retained_notification_id, snapshot
  )
  SELECT r.id, r.retained_id, to_jsonb(h)
  FROM ranked r
  JOIN public.makesafe_intake_hugo_notifications h ON h.id = r.id
  WHERE r.rank > 1
  ON CONFLICT (notification_id) DO NOTHING
  RETURNING notification_id
)
DELETE FROM public.makesafe_intake_hugo_notifications h
USING archived a
WHERE h.id = a.notification_id;

ALTER TABLE public.makesafe_intake_hugo_notifications
  DROP CONSTRAINT IF EXISTS makesafe_intake_hugo_notifications_once;
ALTER TABLE public.makesafe_intake_hugo_notifications
  ADD CONSTRAINT makesafe_intake_hugo_notifications_once
  UNIQUE (org_id, job_id);

COMMENT ON TABLE public.makesafe_intake_job_mints IS
  'Explicit draft-keyed authority for newly minted intake jobs and their evidence, board, and notification settlement.';
COMMENT ON TABLE public.makesafe_intake_hugo_notification_duplicates IS
  'Immutable archive of older case-scoped Hugo audit duplicates removed before enforcing one notification coordinate per job.';
COMMENT ON TABLE public.makesafe_intake_hugo_notifications IS
  'Once-per-job audit for newly minted SES intake work after canonical board proof.';
