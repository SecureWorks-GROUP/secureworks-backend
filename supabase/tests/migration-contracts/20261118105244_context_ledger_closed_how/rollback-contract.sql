DO $rollback_check$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.context_ledger_transitions'::regclass
      AND tgname = 'context_ledger_transitions_closed_how'
      AND NOT tgisinternal
  )
  OR to_regprocedure('public.context_ledger_closed_how_install()') IS NOT NULL
  OR to_regprocedure('public.context_ledger_closed_how_remove()') IS NOT NULL
  OR to_regprocedure('public.context_ledger_closed_how_backfill()') IS NOT NULL
  OR to_regprocedure('public.context_ledger_transitions_closed_how_trg()') IS NOT NULL
  OR to_regprocedure('public.context_ledger_word_closes_mark(uuid,text[],text,text,text)') IS NOT NULL
  OR to_regprocedure('public.context_ledger_closed_how_stamp(uuid)') IS NOT NULL
  OR to_regclass('public.context_ledger_word_closes') IS NOT NULL THEN
    RAISE EXCEPTION 'ZZTEST closed_how rollback left trigger, function, or word_closes table';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.context_ledger_items'::regclass
      AND attname = 'closed_how'
      AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'ZZTEST closed_how rollback dropped closed_how column';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.context_ledger_items
    WHERE id = '00000000-0000-4000-8000-000000010429'
      AND closed_how IS DISTINCT FROM 'record'
  ) THEN
    RAISE EXCEPTION 'ZZTEST closed_how rollback lost recorded closed_how history';
  END IF;
END $rollback_check$;

DELETE FROM public.jobs WHERE id = '00000000-0000-4000-8000-000000000429';
SELECT 'PASS: P4-02.10 rollback dropped trigger, functions, and word_closes while preserving closed_how history' AS result;
