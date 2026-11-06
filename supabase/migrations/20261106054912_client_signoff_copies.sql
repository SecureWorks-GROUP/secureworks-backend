-- Client confirmation entered by the office, with its real evidence source.
-- Existing frozen groups keep their historical authority. Reopening requires
-- a fresh client confirmation. No existing job, group, sign-off or money row
-- is rewritten, and nothing sends.
BEGIN;
CREATE TABLE IF NOT EXISTS public.group_client_signoff_policy (
  id smallint PRIMARY KEY CHECK (id = 1),
  client_confirmation_since timestamptz NOT NULL DEFAULT '2026-11-06T05:55:58Z'
);
-- Fixed at the owner's ruling, never at a deploy or re-apply clock.
INSERT INTO public.group_client_signoff_policy(id,client_confirmation_since)
VALUES (1,'2026-11-06T05:55:58Z') ON CONFLICT (id) DO NOTHING;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.group_client_signoff_policy
    WHERE id=1 AND client_confirmation_since='2026-11-06T05:55:58Z'::timestamptz) THEN
    RAISE EXCEPTION 'client confirmation policy changed; review before applying';
  END IF;
END $$;
ALTER TABLE public.group_client_signoff_policy ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.group_client_signoff_policy FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.group_client_signoff_policy TO service_role;

ALTER TABLE public.group_work_orders ADD COLUMN IF NOT EXISTS signoff_required_after timestamptz;
ALTER TABLE public.job_client_signoffs
  ADD COLUMN IF NOT EXISTS capture_auth_source text,
  ADD COLUMN IF NOT EXISTS capture_request_id uuid,
  ADD COLUMN IF NOT EXISTS capture_payload_hash text,
  ADD COLUMN IF NOT EXISTS confirmation_kind text,
  ADD COLUMN IF NOT EXISTS confirmation_reference text,
  ADD COLUMN IF NOT EXISTS signed_copy_path text,
  ADD COLUMN IF NOT EXISTS signed_copy_sha256 text,
  ADD COLUMN IF NOT EXISTS signed_copy_type text,
  ADD COLUMN IF NOT EXISTS signed_copy_name text,
  ADD COLUMN IF NOT EXISTS client_confirmed_on date,
  ADD COLUMN IF NOT EXISTS work_done text,
  ADD COLUMN IF NOT EXISTS outstanding_items text;
ALTER TABLE public.job_client_signoffs DROP CONSTRAINT IF EXISTS job_client_signoffs_method_check;
ALTER TABLE public.job_client_signoffs ADD CONSTRAINT job_client_signoffs_method_check
  CHECK (method IN ('on_site','share_link','office_waiver','revoked','office_on_behalf'));
ALTER TABLE public.job_client_signoffs DROP CONSTRAINT IF EXISTS job_client_signoffs_office_confirmation_check;
ALTER TABLE public.job_client_signoffs ADD CONSTRAINT job_client_signoffs_office_confirmation_check CHECK (
  method <> 'office_on_behalf' OR coalesce((
    org_id IS NOT NULL AND captured_by IS NOT NULL AND capture_auth_source = 'jwt'
    AND captured_by_actor = 'user:' || captured_by::text
    AND capture_request_id IS NOT NULL AND capture_payload_hash ~ '^sha256:[0-9a-f]{64}$'
    AND signature_media_id IS NULL AND waiver_reason IS NULL AND happy IS NOT NULL
    AND char_length(btrim(coalesce(signed_name,''))) BETWEEN 1 AND 120
    AND client_confirmed_on IS NOT NULL
    AND char_length(btrim(coalesce(work_done,''))) BETWEEN 1 AND 10000
    AND coalesce(char_length(outstanding_items),0) <= 10000
    AND (
      (confirmation_kind = 'signed_copy'
       AND signed_copy_sha256 ~ '^sha256:[0-9a-f]{64}$'
       AND signed_copy_type IN ('application/pdf','image/png','image/jpeg')
       AND signed_copy_path = org_id::text || '/' || job_id::text || '/' || capture_request_id::text ||
         CASE signed_copy_type WHEN 'application/pdf' THEN '.pdf' WHEN 'image/png' THEN '.png' ELSE '.jpg' END
       AND char_length(btrim(coalesce(signed_copy_name,''))) BETWEEN 1 AND 184)
      OR
      (confirmation_kind = 'written_confirmation'
       AND char_length(btrim(coalesce(confirmation_reference,''))) BETWEEN 5 AND 2000
       AND signed_copy_path IS NULL AND signed_copy_sha256 IS NULL AND signed_copy_type IS NULL)
    )
  ),false)
);
CREATE UNIQUE INDEX IF NOT EXISTS job_client_signoffs_capture_request_key
  ON public.job_client_signoffs(capture_request_id) WHERE capture_request_id IS NOT NULL;

INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
VALUES ('client-signoff-copies','client-signoff-copies',false,8388608,ARRAY['application/pdf','image/png','image/jpeg'])
ON CONFLICT (id) DO NOTHING;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id='client-signoff-copies' AND public=false) THEN
    RAISE EXCEPTION 'signed client copies require a private bucket';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.group_reopen_requires_client_confirmation()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF OLD.split_frozen_at IS NOT NULL AND NEW.split_frozen_at IS NULL THEN
    NEW.signoff_required_after := clock_timestamp();
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_group_reopen_client_confirmation ON public.group_work_orders;
CREATE TRIGGER trg_group_reopen_client_confirmation BEFORE UPDATE OF split_frozen_at ON public.group_work_orders
  FOR EACH ROW EXECUTE FUNCTION public.group_reopen_requires_client_confirmation();
REVOKE ALL ON FUNCTION public.group_reopen_requires_client_confirmation() FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.office_client_confirmation_group_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE v_frozen timestamptz;
BEGIN
  IF NEW.method = 'office_on_behalf' THEN
    SELECT g.split_frozen_at INTO v_frozen FROM public.group_work_orders g
      WHERE g.job_id=NEW.job_id AND g.status<>'void' FOR UPDATE;
    IF v_frozen IS NOT NULL THEN
      RAISE EXCEPTION 'group_split_frozen: reopen before recording a new client confirmation' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_office_client_confirmation_group_guard ON public.job_client_signoffs;
CREATE TRIGGER trg_office_client_confirmation_group_guard BEFORE INSERT ON public.job_client_signoffs
  FOR EACH ROW EXECUTE FUNCTION public.office_client_confirmation_group_guard();
REVOKE ALL ON FUNCTION public.office_client_confirmation_group_guard() FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.group_client_signoff_counts(p_job uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=public,pg_temp AS $$
DECLARE s public.job_client_signoffs%ROWTYPE; v_min smallint; v_latest timestamptz;
  v_frozen timestamptz; v_since timestamptz;
BEGIN
  SELECT * INTO s FROM public.job_client_signoffs WHERE job_id=p_job
    ORDER BY created_at DESC,id::text COLLATE "C" DESC LIMIT 1;
  IF NOT FOUND OR s.method='revoked' THEN RETURN false; END IF;
  IF s.method='office_waiver' THEN
    SELECT g.split_frozen_at INTO v_frozen FROM public.group_work_orders g WHERE g.job_id=p_job AND g.status<>'void';
    SELECT client_confirmation_since INTO v_since FROM public.group_client_signoff_policy WHERE id=1;
    IF v_frozen IS NULL OR v_since IS NULL OR v_frozen >= v_since THEN RETURN false; END IF;
    IF length(btrim(coalesce(s.waiver_reason,'')))<3 OR btrim(coalesce(s.captured_by_actor,''))='' THEN RETURN false; END IF;
  ELSE
    IF s.method='office_on_behalf' THEN
      -- The table check binds the evidence, job and identified office actor.
      IF s.happy IS DISTINCT FROM true OR s.capture_request_id IS NULL THEN RETURN false; END IF;
    ELSIF s.method NOT IN ('on_site','share_link') OR s.signature_media_id IS NULL THEN RETURN false;
    END IF;
    SELECT min_happy_rating INTO v_min FROM public.client_signoff_settings WHERE id=1;
    IF v_min IS NULL THEN v_min:=4; END IF;
    IF s.happy IS FALSE OR (s.satisfaction_rating IS NOT NULL AND s.satisfaction_rating<v_min) THEN RETURN false; END IF;
  END IF;
  SELECT max(stamp) INTO v_latest FROM (
    SELECT max(GREATEST(e.created_at,coalesce(e.updated_at,e.created_at))) AS stamp
      FROM public.group_work_order_time_entries e JOIN public.group_work_orders g ON g.id=e.group_id
      WHERE g.job_id=p_job AND g.status<>'void'
    UNION ALL SELECT max(g.hours_changed_at) FROM public.group_work_orders g WHERE g.job_id=p_job AND g.status<>'void'
    UNION ALL SELECT max(g.signoff_required_after) FROM public.group_work_orders g WHERE g.job_id=p_job AND g.status<>'void'
  ) instants;
  RETURN v_latest IS NULL OR s.created_at>v_latest;
END $$;
-- Extend the existing release label without replacing a sibling owner's body.
DO $$ DECLARE body text; before_text text := $old$WHEN s2.method IN ('on_site', 'share_link') THEN 'client'$old$;
  after_text text := $new$WHEN s2.method IN ('on_site', 'share_link', 'office_on_behalf') THEN 'client'$new$;
BEGIN
  body := pg_get_functiondef('public.group_work_order_release_state(uuid)'::regprocedure);
  IF strpos(body,after_text)=0 THEN
    IF strpos(body,before_text)=0 THEN RAISE EXCEPTION 'group release sign-off label changed; review before applying'; END IF;
    EXECUTE replace(body,before_text,after_text);
  END IF;
END $$;
COMMIT;
