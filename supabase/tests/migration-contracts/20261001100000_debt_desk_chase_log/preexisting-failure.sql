-- A live row whose method is in no repo definition (live drift). Widening the
-- CHECK must not silently drop that value: re-adding the constraint fails, and
-- the migration stops. This database is discarded after the proof.
ALTER TABLE public.payment_chase_logs DROP CONSTRAINT payment_chase_logs_method_check;
INSERT INTO public.payment_chase_logs (xero_invoice_id, method, notes)
VALUES ('drift-invoice', 'fax', 'a method no repo migration lists');
