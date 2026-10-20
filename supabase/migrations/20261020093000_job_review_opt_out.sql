-- Per-job review switch for the paid close-out review text (captain, 20 Oct 2026).
--
-- The paid close-out sender (supabase/functions/ops-api/job_closeout.ts, migration
-- 20261013150000_job_closeout_review_archive.sql) texts every paying owner of a fully
-- paid fencing or patio job once its card reaches Get Review. The captain wants that text
-- always sent, with a small per-job switch on the card from Complete onwards to stop it.
--
--   jobs.review_opt_out     false (the default): the review text goes out as before.
--                           true: the automatic sender (the Get Review hook and the
--                           24-hour sweep) sends nothing and claims nothing for this
--                           job; the card still archives. A manual Send review still
--                           sends.
--   jobs.review_opt_out_at  when the switch last changed.
--   jobs.review_opt_out_by  who last changed it (the signed-in person's email, else the
--                           operator email the screen stamps).
--
-- Written only by ops-api set_review_opt_out, which refuses once the job has a review
-- claim. Every existing job reads false, so nothing changes for any job until a person
-- switches one off. Rollback: supabase/rollbacks/20261020093000_job_review_opt_out_down.sql.

ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS review_opt_out boolean NOT NULL DEFAULT false;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS review_opt_out_at timestamptz;
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS review_opt_out_by text;

COMMENT ON COLUMN public.jobs.review_opt_out IS
  'Paid close-out review switch (20261020093000): true stops the automatic review text for this fencing or patio job (no text, no claim; the card still archives). Default false: the text is sent. Written only by ops-api set_review_opt_out, refused once a review claim exists.';
COMMENT ON COLUMN public.jobs.review_opt_out_at IS
  'Paid close-out review switch (20261020093000): when review_opt_out last changed.';
COMMENT ON COLUMN public.jobs.review_opt_out_by IS
  'Paid close-out review switch (20261020093000): who last changed review_opt_out.';
