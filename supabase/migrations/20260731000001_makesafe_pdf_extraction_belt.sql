-- ════════════════════════════════════════════════════════════
-- MAKE-SAFE PDF EXTRACTION BELT
-- Mission: the belt to the board (2026-07-31)
--
-- The intake scanner remains deliberately bounded. PDF text extraction moves to
-- a durable, one document per invocation lane so a burst of old mail cannot use
-- the standing scan's edge CPU/memory budget and starve a fresh work order.
-- ════════════════════════════════════════════════════════════

ALTER TABLE public.email_attachments
  ADD COLUMN IF NOT EXISTS pdf_extraction_status text NOT NULL DEFAULT 'not_applicable',
  ADD COLUMN IF NOT EXISTS pdf_extraction_text text,
  ADD COLUMN IF NOT EXISTS pdf_extraction_char_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pdf_extraction_page_count integer,
  ADD COLUMN IF NOT EXISTS pdf_extraction_extractor text,
  ADD COLUMN IF NOT EXISTS pdf_extraction_truncated boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pdf_extraction_reason text,
  ADD COLUMN IF NOT EXISTS pdf_extraction_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pdf_extraction_claim_token uuid,
  ADD COLUMN IF NOT EXISTS pdf_extraction_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS pdf_extraction_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS pdf_extraction_next_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS pdf_handoff_status text NOT NULL DEFAULT 'not_required',
  ADD COLUMN IF NOT EXISTS pdf_handoff_reason text,
  ADD COLUMN IF NOT EXISTS pdf_handoff_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pdf_handoff_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS pdf_handoff_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS pdf_handoff_next_attempt_at timestamptz;

ALTER TABLE public.email_attachments
  DROP CONSTRAINT IF EXISTS email_attachments_pdf_extraction_status_check;
ALTER TABLE public.email_attachments
  ADD CONSTRAINT email_attachments_pdf_extraction_status_check
  CHECK (pdf_extraction_status IN (
    'not_applicable', 'pending', 'processing', 'extracted', 'quarantined', 'failed'
  ));

ALTER TABLE public.email_attachments
  DROP CONSTRAINT IF EXISTS email_attachments_pdf_handoff_status_check;
ALTER TABLE public.email_attachments
  ADD CONSTRAINT email_attachments_pdf_handoff_status_check
  CHECK (pdf_handoff_status IN (
    'not_required', 'pending', 'processing', 'completed', 'failed'
  ));

CREATE OR REPLACE FUNCTION public.enqueue_makesafe_pdf_extraction()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  should_enqueue boolean := false;
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
    NEW.pdf_extraction_status := 'pending';
    NEW.pdf_extraction_reason := NULL;
    NEW.pdf_extraction_claim_token := NULL;
    NEW.pdf_extraction_started_at := NULL;
    NEW.pdf_extraction_completed_at := NULL;
    NEW.pdf_extraction_next_attempt_at := NULL;
    NEW.pdf_handoff_status := 'not_required';
    NEW.pdf_handoff_reason := NULL;
    NEW.pdf_handoff_started_at := NULL;
    NEW.pdf_handoff_completed_at := NULL;
    NEW.pdf_handoff_next_attempt_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enqueue_makesafe_pdf_extraction
  ON public.email_attachments;
CREATE TRIGGER trg_enqueue_makesafe_pdf_extraction
BEFORE INSERT OR UPDATE OF status, sha256
ON public.email_attachments
FOR EACH ROW
EXECUTE FUNCTION public.enqueue_makesafe_pdf_extraction();

-- Existing uploaded rows are validated PDFs. Non-uploaded rows remain outside the
-- extraction belt and therefore do not create false backlog or health signals.
UPDATE public.email_attachments
   SET pdf_extraction_status = 'pending',
       pdf_extraction_next_attempt_at = NULL,
       updated_at = now()
 WHERE status = 'uploaded'
   AND pdf_extraction_status = 'not_applicable';

CREATE INDEX IF NOT EXISTS idx_email_attachments_pdf_extraction_queue
  ON public.email_attachments (pdf_extraction_status, pdf_extraction_next_attempt_at, pdf_extraction_attempts, created_at, id)
  WHERE status = 'uploaded'
    AND (
      pdf_extraction_status IN ('pending', 'failed', 'processing')
      OR pdf_handoff_status IN ('pending', 'failed', 'processing')
    );

COMMENT ON COLUMN public.email_attachments.pdf_extraction_text IS
  'Deterministic text-layer PDF extraction only. Private PII; purged with attachment bytes at the normal retention boundary.';
COMMENT ON COLUMN public.email_attachments.pdf_extraction_status IS
  'Durable extraction state, separate from attachment byte-ingest status. One worker invocation claims one PDF.';

-- Atomically claim one queued PDF. FOR UPDATE SKIP LOCKED makes concurrent cron,
-- arrival, and retry workers converge without double-reading the same document.
-- A stale processing claim is recovered inside the five-minute arrival law. SHA
-- twins share one extraction claim; their classifier handoffs remain source-scoped.
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
  selected_id uuid;
  selected_sha text;
  selected_work text;
  claim_token uuid := gen_random_uuid();
  claimed_rows integer := 0;
BEGIN
  UPDATE public.email_attachments
     SET pdf_extraction_status = 'quarantined',
         pdf_extraction_reason = 'retry_exhausted:processing_lease_expired',
         pdf_extraction_claim_token = NULL,
         pdf_extraction_started_at = NULL,
         pdf_extraction_completed_at = now(),
         pdf_extraction_next_attempt_at = NULL,
         pdf_handoff_status = 'pending',
         pdf_handoff_reason = NULL,
         pdf_handoff_next_attempt_at = NULL,
         updated_at = now()
   WHERE status = 'uploaded'
     AND pdf_extraction_status = 'processing'
     AND pdf_extraction_attempts >= 3
     AND pdf_extraction_started_at < now() - interval '2 minutes';

  SELECT a.id, NULLIF(a.sha256, ''),
         CASE
           WHEN a.pdf_extraction_status IN ('pending', 'failed', 'processing')
             THEN 'extract'
           ELSE 'handoff'
         END
    INTO selected_id, selected_sha, selected_work
    FROM public.email_attachments a
    JOIN public.emails e ON e.post_id = a.email_id
   WHERE a.status = 'uploaded'
     AND (
       (
         (
           a.pdf_extraction_status IN ('pending', 'failed')
           AND a.pdf_extraction_attempts < 3
           AND (
             a.pdf_extraction_next_attempt_at IS NULL
             OR a.pdf_extraction_next_attempt_at <= now()
           )
         )
         OR (
           a.pdf_extraction_status = 'processing'
           AND a.pdf_extraction_attempts < 3
           AND a.pdf_extraction_started_at < now() - interval '2 minutes'
         )
       )
       OR (
         a.pdf_extraction_status IN ('extracted', 'quarantined')
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
       )
     )
     AND (p_attachment_id IS NULL OR a.id = p_attachment_id)
   ORDER BY
     CASE WHEN p_fresh_only THEN e.received_at END DESC NULLS LAST,
     CASE
       WHEN a.pdf_extraction_status = 'pending'
         AND a.pdf_extraction_attempts = 0 THEN 0
       WHEN a.pdf_extraction_status = 'pending' THEN 1
       WHEN a.pdf_extraction_status IN ('failed', 'processing') THEN 2
       ELSE 3
     END,
     e.received_at ASC NULLS LAST,
     a.created_at ASC,
     a.id ASC
   FOR UPDATE OF a SKIP LOCKED
   LIMIT 1;

  IF selected_id IS NULL THEN
    RETURN;
  END IF;

  IF selected_work = 'extract' THEN
    UPDATE public.email_attachments a
       SET pdf_extraction_status = 'processing',
           pdf_extraction_claim_token = claim_token,
           pdf_extraction_started_at = now(),
           pdf_extraction_completed_at = NULL,
           pdf_extraction_attempts = a.pdf_extraction_attempts + 1,
           updated_at = now()
     WHERE a.status = 'uploaded'
       AND (
         (selected_sha IS NOT NULL AND NULLIF(a.sha256, '') = selected_sha)
         OR (selected_sha IS NULL AND a.id = selected_id)
       )
       AND (
         (
           a.pdf_extraction_status IN ('pending', 'failed')
           AND a.pdf_extraction_attempts < 3
           AND (
             a.pdf_extraction_next_attempt_at IS NULL
             OR a.pdf_extraction_next_attempt_at <= now()
           )
         )
         OR (
           a.pdf_extraction_status = 'processing'
           AND a.pdf_extraction_attempts < 3
           AND a.pdf_extraction_started_at < now() - interval '2 minutes'
         )
       );
  ELSE
    UPDATE public.email_attachments a
       SET pdf_extraction_claim_token = claim_token,
           pdf_handoff_status = 'processing',
           pdf_handoff_started_at = now(),
           pdf_handoff_completed_at = NULL,
           pdf_handoff_attempts = a.pdf_handoff_attempts + 1,
           updated_at = now()
     WHERE a.id = selected_id
       AND a.pdf_extraction_status IN ('extracted', 'quarantined')
       AND a.pdf_handoff_status IN ('pending', 'failed', 'processing');
  END IF;

  GET DIAGNOSTICS claimed_rows = ROW_COUNT;
  IF claimed_rows = 0 THEN
    RETURN;
  END IF;

  RETURN QUERY
    SELECT a.*
      FROM public.email_attachments a
     WHERE a.id = selected_id
       AND a.pdf_extraction_claim_token = claim_token;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_makesafe_pdf_extraction(uuid, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_makesafe_pdf_extraction(uuid, boolean)
  TO service_role, postgres;

CREATE OR REPLACE FUNCTION public.makesafe_pdf_extraction_backlog_estimate()
RETURNS TABLE (
  remaining_coordinates bigint,
  estimated_minutes bigint
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH coordinates AS (
    SELECT COALESCE(NULLIF(a.sha256, ''), 'id:' || a.id::text) AS coordinate,
           GREATEST(
             CASE WHEN BOOL_OR(a.pdf_extraction_status = 'processing') THEN 1 ELSE 0 END,
             3 - MAX(a.pdf_extraction_attempts)
           )::bigint AS attempts_left
      FROM public.email_attachments a
     WHERE a.status = 'uploaded'
       AND a.pdf_extraction_status IN ('pending', 'failed', 'processing')
       AND a.pdf_extraction_attempts < 3
     GROUP BY 1
  )
  SELECT COUNT(*)::bigint,
         COALESCE(SUM(
           attempts_left + GREATEST(0, attempts_left - 1) * 2
         ), 0)::bigint
    FROM coordinates;
$$;

REVOKE ALL ON FUNCTION public.makesafe_pdf_extraction_backlog_estimate()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.makesafe_pdf_extraction_backlog_estimate()
  TO service_role, postgres;

-- The extraction text is PII just like the original PDF bytes. Keep the existing
-- tombstone shape and extend it rather than creating a second retention policy.
CREATE OR REPLACE FUNCTION public.purge_makesafe_email_pii(retention_days integer DEFAULT 90)
RETURNS jsonb AS $$
DECLARE
  eff_days      integer := LEAST(GREATEST(COALESCE(retention_days, 90), 30), 365);
  cutoff        timestamptz := now() - make_interval(days => eff_days);
  emails_n      integer := 0;
  attach_n      integer := 0;
  storage_n     integer := 0;
BEGIN
  UPDATE public.emails
     SET subject       = NULL,
         body_preview  = NULL,
         body_content  = NULL,
         from_email    = NULL,
         from_name     = NULL,
         to_recipients = NULL,
         pii_purged_at = now(),
         updated_at    = now()
   WHERE received_at < cutoff
     AND pii_purged_at IS NULL;
  GET DIAGNOSTICS emails_n = ROW_COUNT;

  WITH aged AS (
    SELECT a.id, a.storage_path
      FROM public.email_attachments a
      JOIN public.emails e ON e.post_id = a.email_id
     WHERE e.received_at < cutoff
       AND a.pii_purged_at IS NULL
  ),
  del_storage AS (
    DELETE FROM storage.objects o
     USING aged
     WHERE o.bucket_id = 'makesafe-emails'
       AND o.name = aged.storage_path
    RETURNING 1
  )
  SELECT count(*) INTO storage_n FROM del_storage;

  UPDATE public.email_attachments a
     SET storage_path = NULL,
         name = NULL,
         content_type = NULL,
         last_error = NULL,
         pdf_extraction_text = NULL,
         pdf_extraction_char_count = 0,
         pdf_extraction_page_count = NULL,
         pdf_extraction_extractor = NULL,
         pdf_extraction_reason = NULL,
         pdf_extraction_claim_token = NULL,
         pdf_extraction_started_at = NULL,
         pdf_extraction_completed_at = NULL,
         pdf_extraction_next_attempt_at = NULL,
         pdf_handoff_reason = NULL,
         pdf_handoff_started_at = NULL,
         pdf_handoff_completed_at = NULL,
         pdf_handoff_next_attempt_at = NULL,
         pii_purged_at = now(),
         status = 'purged',
         pdf_extraction_status = 'not_applicable',
         pdf_handoff_status = 'not_required',
         updated_at = now()
    FROM public.emails e
   WHERE e.post_id = a.email_id
     AND e.received_at < cutoff
     AND a.pii_purged_at IS NULL;
  GET DIAGNOSTICS attach_n = ROW_COUNT;

  RAISE NOTICE 'purge_makesafe_email_pii: cutoff=% (eff_days=%) emails=% attachments=% storage_objects=%',
    cutoff, eff_days, emails_n, attach_n, storage_n;

  RETURN jsonb_build_object(
    'cutoff', cutoff,
    'effective_retention_days', eff_days,
    'emails_tombstoned', emails_n,
    'attachments_tombstoned', attach_n,
    'storage_objects_deleted', storage_n
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = public, pg_temp;

COMMENT ON FUNCTION public.purge_makesafe_email_pii IS
  'Make-safe email-sync PII purge. Tombstones email, attachment metadata, extracted PDF text and private-bucket bytes at the clamped retention boundary.';

-- One PDF per invocation keeps the extraction isolate bounded. The arrival path
-- calls the same action immediately; this schedule is the historical oldest-first
-- drain and retry safety net. At one document per minute, N queued PDFs take
-- ceil(N) minutes; the edge action returns the exact drain_eta_at timestamp.
CREATE OR REPLACE FUNCTION public.trigger_makesafe_pdf_extraction_drain() RETURNS void AS $$
BEGIN
  IF NOT public.makesafe_cron_enabled() THEN
    RAISE NOTICE 'trigger_makesafe_pdf_extraction_drain: cron gate disabled; skipping drain';
    RETURN;
  END IF;
  PERFORM net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/ops-api?action=makesafe_pdf_extraction_drain',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || public.sw_service_key(),
      'Content-Type', 'application/json'
    ),
    body := '{"max_items":1,"lane":"historical"}'::jsonb
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.trigger_makesafe_pdf_extraction_drain()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trigger_makesafe_pdf_extraction_drain()
  TO service_role, postgres;

DO $$
BEGIN
  PERFORM cron.unschedule('makesafe-pdf-extraction-drain')
    FROM cron.job WHERE jobname = 'makesafe-pdf-extraction-drain';
END $$;

SELECT cron.schedule(
  'makesafe-pdf-extraction-drain',
  '* * * * *',
  $$SELECT public.trigger_makesafe_pdf_extraction_drain()$$
);
