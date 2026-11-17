-- An invoker view cannot silently bypass a missing source-table permission.
REVOKE SELECT ON public.context_ledger_transitions FROM service_role;
