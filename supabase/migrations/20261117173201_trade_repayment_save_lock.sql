-- P1-09.1 Follow-up 9. The director installs the save guard before switch-on.
-- Balance reads use this index, not a scan of every invoice.
CREATE INDEX IF NOT EXISTS trade_invoices_repayment_balance_idx
ON public.trade_invoices(recurring_deduction_id) INCLUDE(recurring_deduction_amount)
WHERE status NOT IN ('draft','ops-reject');

CREATE OR REPLACE FUNCTION public.trade_repayment_save_lock()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE rule public.trade_recurring_deductions%ROWTYPE; left_ex numeric; BEGIN
  IF NEW.recurring_deduction_id IS NULL OR NEW.status IN ('draft','ops-reject')
    OR NOT EXISTS(SELECT 1 FROM public.feature_flags WHERE flag_name='trade_repayments_v1' AND enabled) THEN
    RETURN NEW;
  END IF;
  -- Primary-key lookup. Different weeks share this lock until their save commits.
  SELECT * INTO rule FROM public.trade_recurring_deductions
  WHERE id=NEW.recurring_deduction_id AND kind='repayment' FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF;
  -- A separate statement after the lock sees the preceding save's committed amount.
  -- Exclude this invoice when a saved draft or submitted invoice is updated.
  SELECT greatest(0,rule.balance_total-coalesce(sum(i.recurring_deduction_amount),0))
  INTO left_ex FROM public.trade_invoices i
  WHERE i.recurring_deduction_id=rule.id AND i.id IS DISTINCT FROM NEW.id
    AND i.status NOT IN ('draft','ops-reject');
  IF NOT rule.active OR rule.user_id IS DISTINCT FROM NEW.user_id THEN left_ex:=0; END IF;
  NEW.recurring_deduction_amount:=least(NEW.recurring_deduction_amount,rule.amount,left_ex);
  IF NEW.recurring_deduction_amount <= 0 THEN
    NEW.recurring_deduction_id:=NULL;
    NEW.recurring_deduction_label:=NULL;
    NEW.recurring_deduction_amount:=NULL;
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- A failed optional deduction must never fail the trade's invoice save.
  -- Taking nothing is safe; taking an unchecked instalment could over-collect.
  RAISE WARNING 'trade_repayment_save_lock skipped deduction: %',SQLSTATE;
  NEW.recurring_deduction_id:=NULL;
  NEW.recurring_deduction_label:=NULL;
  NEW.recurring_deduction_amount:=NULL;
  NEW.recurring_deduction_note:='The repayment could not be checked. The office will check it.';
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.install_trade_repayment_save_lock()
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN
  DROP TRIGGER IF EXISTS trade_repayment_save_lock ON public.trade_invoices;
  CREATE TRIGGER trade_repayment_save_lock
  BEFORE INSERT OR UPDATE OF recurring_deduction_id,recurring_deduction_amount,status ON public.trade_invoices
  FOR EACH ROW EXECUTE FUNCTION public.trade_repayment_save_lock();
END $$;
CREATE OR REPLACE FUNCTION public.remove_trade_repayment_save_lock()
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN
  DROP TRIGGER IF EXISTS trade_repayment_save_lock ON public.trade_invoices;
END $$;
REVOKE ALL ON FUNCTION public.trade_repayment_save_lock(),public.install_trade_repayment_save_lock(),public.remove_trade_repayment_save_lock() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.trade_repayment_save_lock(),public.install_trade_repayment_save_lock(),public.remove_trade_repayment_save_lock() TO service_role;
