-- Rollback for 20261001100000_debt_desk_chase_log.sql.
--
-- Restores payment_chase_logs as 20260911120000_debt_picture.sql left it: the
-- nine-value method CHECK, no desk columns, no row-level security.
--
-- Fail-closed: it refuses while any row uses a new method (visit, statement,
-- letter) or carries desk data, so a rollback never silently discards a logged
-- send, approval, outcome or promise. Move or delete those rows first, on
-- purpose. Re-running it is a no-op.

DO $$
DECLARE
  v_desk_columns boolean := EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'payment_chase_logs'
       AND column_name = 'outcome_code');
  v_rows bigint;
BEGIN
  SELECT count(*) INTO v_rows FROM public.payment_chase_logs
   WHERE method IN ('visit', 'statement', 'letter');
  IF v_rows > 0 THEN
    RAISE EXCEPTION 'rollback refused: % chase-log rows use visit, statement or letter', v_rows;
  END IF;
  IF v_desk_columns THEN
    EXECUTE $q$
      SELECT count(*) FROM public.payment_chase_logs
       WHERE direction IS NOT NULL OR outcome_code IS NOT NULL
          OR promised_amount IS NOT NULL OR promised_date IS NOT NULL
          OR amount_due_at_promise IS NOT NULL OR schedule_step IS NOT NULL
          OR approved_by_user_id IS NOT NULL OR automated
          OR provider_message_id IS NOT NULL OR covers_invoice_ids IS NOT NULL
          OR draft_id IS NOT NULL OR draft_amount IS NOT NULL
    $q$ INTO v_rows;
    IF v_rows > 0 THEN
      RAISE EXCEPTION 'rollback refused: % chase-log rows carry desk data', v_rows;
    END IF;
  END IF;
END $$;

DROP POLICY IF EXISTS payment_chase_logs_service_role_all ON public.payment_chase_logs;
ALTER TABLE public.payment_chase_logs DISABLE ROW LEVEL SECURITY;

DROP INDEX IF EXISTS public.idx_chase_logs_draft;
DROP INDEX IF EXISTS public.idx_chase_logs_draft_send_claim;
ALTER TABLE public.payment_chase_logs
  DROP CONSTRAINT IF EXISTS payment_chase_logs_direction_check,
  DROP CONSTRAINT IF EXISTS payment_chase_logs_outcome_code_check,
  DROP CONSTRAINT IF EXISTS payment_chase_logs_schedule_step_check,
  DROP CONSTRAINT IF EXISTS payment_chase_logs_promise_check;
ALTER TABLE public.payment_chase_logs
  DROP COLUMN IF EXISTS direction,
  DROP COLUMN IF EXISTS outcome_code,
  DROP COLUMN IF EXISTS promised_amount,
  DROP COLUMN IF EXISTS promised_date,
  DROP COLUMN IF EXISTS amount_due_at_promise,
  DROP COLUMN IF EXISTS schedule_step,
  DROP COLUMN IF EXISTS approved_by_user_id,
  DROP COLUMN IF EXISTS automated,
  DROP COLUMN IF EXISTS provider_message_id,
  DROP COLUMN IF EXISTS covers_invoice_ids,
  DROP COLUMN IF EXISTS draft_id,
  DROP COLUMN IF EXISTS draft_amount;

ALTER TABLE public.payment_chase_logs DROP CONSTRAINT IF EXISTS payment_chase_logs_method_check;
ALTER TABLE public.payment_chase_logs ADD CONSTRAINT payment_chase_logs_method_check
  CHECK (method IN ('call','sms','auto_sms','email','note','status_change','personality_note','classification','proposal'));
COMMENT ON COLUMN public.payment_chase_logs.method IS
  'call=phone call, sms=manual SMS, auto_sms=GHL workflow SMS, email=email, note=internal note, status_change=classification change.';
