-- Stand the historical mark/build contract back up; the successor has its own proofs.
\ir ../../../rollbacks/20261117172503_job_pages_queue_safety_down.sql
-- Remove the promised behaviour: a mark after the page is done no longer starts a new run of changes, so the
-- contract's step (c) must fail.
CREATE OR REPLACE FUNCTION public.job_mark_changed(p_job_id uuid, p_source text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_src text := coalesce(nullif(btrim(p_source), ''), 'unknown');
BEGIN
 IF p_job_id IS NULL THEN RETURN; END IF;
 INSERT INTO public.job_change_marks AS m (job_id, sources) VALUES (p_job_id, ARRAY[v_src])
 ON CONFLICT (job_id) DO UPDATE SET
  sources = CASE WHEN v_src = ANY(m.sources) THEN m.sources ELSE m.sources || v_src END,
  last_marked_at = clock_timestamp();
EXCEPTION WHEN foreign_key_violation THEN RETURN;
END $fn$;
