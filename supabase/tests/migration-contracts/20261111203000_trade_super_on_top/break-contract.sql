-- Remove the tie between an invoice and its own trade's setting: another
-- trade's setting must then be accepted.
ALTER TABLE public.trade_invoices DROP CONSTRAINT trade_invoices_super_basis_setting_fkey;
