-- Weekly invoice persistence has an explicit INSERT projection that predates
-- office_review_status. Protect the stored row, including drafts, regardless
-- of that projection or the general office-review rollout flag.
CREATE OR REPLACE FUNCTION public.trade_invoice_lines_group_review_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF lower(btrim(COALESCE(NEW.line_type, ''))) = 'group share'
     OR NEW.group_share_id IS NOT NULL THEN
    NEW.office_review_status := 'awaiting';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_trade_invoice_lines_group_review_insert
  ON public.trade_invoice_lines;
CREATE TRIGGER trg_trade_invoice_lines_group_review_insert
  BEFORE INSERT ON public.trade_invoice_lines
  FOR EACH ROW EXECUTE FUNCTION public.trade_invoice_lines_group_review_insert();

REVOKE ALL ON FUNCTION public.trade_invoice_lines_group_review_insert()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trade_invoice_lines_group_review_insert()
  TO service_role;
-- Deliberately INSERT-only: authorised office approval UPDATEs must survive.
