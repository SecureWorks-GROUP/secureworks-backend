-- Rollback of 20261006080000_context_jev_decisions (Jev in shadow).
--
-- Drops the agreement and calls-today reads, then the log, and removes the
-- context_jev_shadow_v1 flag row (a missing row reads as off, so the worker
-- asks Jev nothing). The log holds only Jev's shadow answers beside today's;
-- no decision, business row or other flag depended on it. Nothing else was
-- created or changed by the forward migration.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DROP FUNCTION IF EXISTS public.context_jev_agreement(timestamptz, timestamptz);
DROP FUNCTION IF EXISTS public.context_jev_calls_today();
DROP TABLE IF EXISTS public.context_jev_decisions;
DELETE FROM public.feature_flags WHERE flag_name = 'context_jev_shadow_v1';
