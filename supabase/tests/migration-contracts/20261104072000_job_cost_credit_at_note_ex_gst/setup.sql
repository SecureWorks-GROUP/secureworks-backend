-- Prerequisites for 20261104072000_job_cost_credit_at_note_ex_gst: the A6 cost rules before it, applied by the registered walk.
DO $$
BEGIN
  IF to_regclass('public.v_bookkeeping_line_parts_current') IS NULL THEN
    RAISE EXCEPTION 'A6 cost rules: 20261104070000 is not applied before 20261104072000';
  END IF;
END $$;
