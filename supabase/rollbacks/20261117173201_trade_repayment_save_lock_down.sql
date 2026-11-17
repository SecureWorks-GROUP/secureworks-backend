SELECT public.remove_trade_repayment_save_lock();
DROP FUNCTION public.install_trade_repayment_save_lock();
DROP FUNCTION public.remove_trade_repayment_save_lock();
DROP FUNCTION public.trade_repayment_save_lock();
DROP INDEX public.trade_invoices_repayment_balance_idx;
