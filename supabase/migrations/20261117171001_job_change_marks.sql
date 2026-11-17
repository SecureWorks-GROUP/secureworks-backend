-- Changed-job marks (ticket P0-02.1, 17 Nov 2026). One row per job that says "this job changed at this time",
-- written only through public.job_mark_changed(job, source). A consumer (the stored job page, the notes reader,
-- the story writer) is due when last_marked_at is newer than its own done column, and sets that column to the
-- last_marked_at it read before it started, so a change that lands while it works keeps the job due.
-- This migration adds the table and its two functions only: the triggers that call job_mark_changed come in
-- P0-02.2, and nothing reads the table yet. Stored Job Profit (P0-09) keeps its own job_profit_dirty table and calls
-- job_mark_changed(<job>, 'profit'), so any source text is accepted.
-- Rollback: supabase/rollbacks/20261117171001_job_change_marks_down.sql.
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.job_change_marks (
  job_id uuid PRIMARY KEY REFERENCES public.jobs(id) ON DELETE CASCADE,
  first_marked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_marked_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  sources text[] NOT NULL DEFAULT '{}',
  page_done_at timestamptz,
  notes_done_at timestamptz,
  story_done_at timestamptz
);
CREATE INDEX IF NOT EXISTS job_change_marks_page_due ON public.job_change_marks (first_marked_at)
  WHERE page_done_at IS NULL OR last_marked_at > page_done_at;
CREATE INDEX IF NOT EXISTS job_change_marks_notes_due ON public.job_change_marks (last_marked_at)
  WHERE notes_done_at IS NULL OR last_marked_at > notes_done_at;

ALTER TABLE public.job_change_marks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.job_change_marks FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.job_change_marks TO service_role;

COMMENT ON TABLE public.job_change_marks IS
  'One row per job that changed. A consumer (page, notes, story) is due when last_marked_at is newer than its own done column. A consumer sets its done column to the last_marked_at it read before it started.';

-- Mark a job changed. A job whose page was done since its last mark starts a new run of changes (first_marked_at and
-- sources start again); otherwise the source is added once and last_marked_at moves on. A null job, or a job that
-- does not exist, is a no-op and raises nothing, so a caller's own write never fails because of a mark.
CREATE OR REPLACE FUNCTION public.job_mark_changed(p_job_id uuid, p_source text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_src text := coalesce(nullif(btrim(p_source), ''), 'unknown');
BEGIN
 IF p_job_id IS NULL THEN RETURN; END IF;
 INSERT INTO public.job_change_marks AS m (job_id, sources) VALUES (p_job_id, ARRAY[v_src])
 ON CONFLICT (job_id) DO UPDATE SET
  first_marked_at = CASE WHEN m.page_done_at IS NOT NULL AND m.page_done_at >= m.last_marked_at
                         THEN clock_timestamp() ELSE m.first_marked_at END,
  sources = CASE WHEN m.page_done_at IS NOT NULL AND m.page_done_at >= m.last_marked_at THEN ARRAY[v_src]
                 WHEN v_src = ANY(m.sources) THEN m.sources ELSE m.sources || v_src END,
  last_marked_at = clock_timestamp();
EXCEPTION WHEN foreign_key_violation THEN RETURN;
END $fn$;

REVOKE ALL ON FUNCTION public.job_mark_changed(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_mark_changed(uuid, text) TO service_role;

-- The notes reader has read every mark up to p_until: set its done column to each such row's last_marked_at.
-- Returns how many rows it moved.
CREATE OR REPLACE FUNCTION public.job_marks_notes_seen(p_until timestamptz) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_count integer;
BEGIN
 UPDATE public.job_change_marks SET notes_done_at = last_marked_at
  WHERE last_marked_at <= p_until AND (notes_done_at IS NULL OR last_marked_at > notes_done_at);
 GET DIAGNOSTICS v_count = ROW_COUNT;
 RETURN v_count;
END $fn$;

REVOKE ALL ON FUNCTION public.job_marks_notes_seen(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_marks_notes_seen(timestamptz) TO service_role;
