CREATE OR REPLACE FUNCTION public.reject_trade_invoice_v1(p_invoice_id uuid,p_note text)
RETURNS uuid LANGUAGE sql AS 'SELECT $1';
