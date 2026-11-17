-- Undo 20261117161100_job_change_marks: drop the two functions, then the marks table (its indexes go with it).
-- Nothing else was changed. Run only after the P0-02.2 triggers are rolled back, since they call job_mark_changed.
SET LOCAL lock_timeout = '5s';
DROP FUNCTION IF EXISTS public.job_marks_notes_seen(timestamptz);
DROP FUNCTION IF EXISTS public.job_mark_changed(uuid, text);
DROP TABLE IF EXISTS public.job_change_marks;
