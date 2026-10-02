-- Ship the attachment ledger readable by signed-in logins. The contract's
-- access check must catch it.
GRANT SELECT ON public.context_email_attachments TO authenticated;
