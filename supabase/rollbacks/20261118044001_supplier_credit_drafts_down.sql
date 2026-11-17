-- Explicit rollback only. Never removes rows from Xero's supplier credit mirror.
DROP TABLE IF EXISTS public.supplier_credit_drafts;
DELETE FROM public.feature_flags WHERE flag_name='supplier_credit_drafts_v1';
