-- Rollback for P4-02.10 (context_ledger_closed_how).
-- Leave public.context_ledger_items.closed_how in place: dropping the column would lose history.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DROP TRIGGER IF EXISTS context_ledger_transitions_closed_how ON public.context_ledger_transitions;

DROP FUNCTION IF EXISTS public.context_ledger_closed_how_install();
DROP FUNCTION IF EXISTS public.context_ledger_closed_how_remove();
DROP FUNCTION IF EXISTS public.context_ledger_closed_how_backfill();
DROP FUNCTION IF EXISTS public.context_ledger_transitions_closed_how_trg();
DROP FUNCTION IF EXISTS public.context_ledger_word_closes_mark(uuid, text[], text, text, text);
DROP FUNCTION IF EXISTS public.context_ledger_closed_how_stamp(uuid);

DROP TABLE IF EXISTS public.context_ledger_word_closes;
