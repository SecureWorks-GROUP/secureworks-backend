-- P4-02.10: record on each closed or declined ledger note how it was closed.
-- Merge adds the nullable column, the agreed word-closes table, and functions only.
-- No business-table trigger, schedule, switch change, or historical row write runs on merge;
-- context_ledger_closed_how_install() installs the trigger and runs the set-based backfill.
-- All six functions are new on main, so plain CREATE FUNCTION refuses an unexpected body.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

ALTER TABLE public.context_ledger_items
  ADD COLUMN IF NOT EXISTS closed_how text;

DO $closed_how_check$ /* constraint block */ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.context_ledger_items'::regclass
      AND conname = 'context_ledger_items_closed_how_check'
  ) THEN
    ALTER TABLE public.context_ledger_items
      ADD CONSTRAINT context_ledger_items_closed_how_check
      CHECK (closed_how IS NULL OR closed_how IN ('record', 'words_two_models', 'words_one_model', 'person'));
  END IF;
END $closed_how_check$;

COMMENT ON COLUMN public.context_ledger_items.closed_how IS
  'How a closed or declined note was closed (P4-02.10): record, words_two_models, words_one_model, or person; NULL while open, disputed, superseded, or info.';

CREATE TABLE IF NOT EXISTS public.context_ledger_word_closes (
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  item_key text NOT NULL,
  reader text NOT NULL,
  reader_model text NOT NULL,
  checker_model text NOT NULL,
  agreed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, item_key)
);

COMMENT ON TABLE public.context_ledger_word_closes IS
  'Closes on words agreed by two different models (P4-02.10). Keyed by (job_id, item_key) so agreement survives a job re-read; deleted on job delete or when a person reopens the note. Service role only.';

ALTER TABLE public.context_ledger_word_closes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.context_ledger_word_closes FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.context_ledger_word_closes TO service_role;
DROP POLICY IF EXISTS context_ledger_word_closes_service ON public.context_ledger_word_closes;
CREATE POLICY context_ledger_word_closes_service ON public.context_ledger_word_closes
  TO service_role USING (true) WITH CHECK (true);

-- Indexes serving context_ledger_closed_how_stamp(p_job_id):
-- jobs_pkey, context_ledger_generations_job_created, context_ledger_items_generation,
-- context_ledger_items_pkey, context_ledger_transitions_job, context_ledger_word_closes_pkey.
CREATE FUNCTION public.context_ledger_closed_how_stamp(p_job_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $stamp$
DECLARE
  v_changed integer := 0;
/* stamp block */ BEGIN
  IF p_job_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.jobs WHERE id = p_job_id) THEN
    RAISE EXCEPTION 'closed_how_job_not_found'
      USING ERRCODE = '22023', DETAIL = coalesce(p_job_id::text, 'null');
  END IF;

  WITH latest_close AS (
    SELECT DISTINCT ON (ti.item_key)
      ti.item_key,
      t.by
    FROM public.context_ledger_transitions AS t
    JOIN public.context_ledger_items AS ti
      ON ti.id = t.item_id
     AND ti.job_id = p_job_id
    WHERE t.job_id = p_job_id
      AND t.to_status IN ('closed', 'declined')
      AND t.by NOT IN ('rule:carry_forward', 'rule:rebuild_seed')
    ORDER BY ti.item_key, t.at DESC, t.id DESC
  ),
  desired AS (
    SELECT
      i.id,
      CASE
        WHEN i.status NOT IN ('closed', 'declined') THEN NULL
        WHEN lc.by = 'rule:record_close_v1' THEN 'record'
        WHEN lc.by LIKE 'person:%'
          OR (lc.by IS NULL AND i.written_by LIKE 'person:%') THEN 'person'
        WHEN lc.by LIKE 'model:%' THEN
          CASE WHEN wc.item_key IS NOT NULL THEN 'words_two_models' ELSE 'words_one_model' END
        ELSE NULL
      END AS next_closed_how
    FROM public.context_ledger_generations AS g
    JOIN public.context_ledger_items AS i
      ON i.generation_id = g.id
     AND i.job_id = p_job_id
    LEFT JOIN latest_close AS lc
      ON lc.item_key = i.item_key
    LEFT JOIN public.context_ledger_word_closes AS wc
      ON wc.job_id = p_job_id
     AND wc.item_key = i.item_key
    WHERE g.job_id = p_job_id
      AND g.status IN ('live', 'shadow', 'building')
  ),
  locked AS (
    SELECT i.id, d.next_closed_how
    FROM public.context_ledger_items AS i
    JOIN desired AS d ON d.id = i.id
    WHERE i.closed_how IS DISTINCT FROM d.next_closed_how
    ORDER BY i.id
    FOR UPDATE OF i
  )
  UPDATE public.context_ledger_items AS target
  SET closed_how = locked.next_closed_how
  FROM locked
  WHERE target.id = locked.id
    AND target.closed_how IS DISTINCT FROM locked.next_closed_how;

  GET DIAGNOSTICS v_changed = ROW_COUNT;
  RETURN v_changed;
END $stamp$;

CREATE FUNCTION public.context_ledger_transitions_closed_how_trg()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $trg$
DECLARE
  v_job_id uuid;
/* trigger block */ BEGIN
  FOR v_job_id IN
    SELECT DISTINCT nr.job_id
    FROM new_rows AS nr
    WHERE nr.job_id IS NOT NULL
    ORDER BY nr.job_id
  LOOP
    /* per-job isolation */ BEGIN
      -- Reopening by a person clears any two-model word-close agreement so a later close starts clean.
      -- Indexes: context_ledger_items_pkey and context_ledger_word_closes_pkey.
      DELETE FROM public.context_ledger_word_closes AS wc
      USING new_rows AS nr
      JOIN public.context_ledger_items AS i
        ON i.id = nr.item_id
       AND i.job_id = nr.job_id
      WHERE nr.job_id = v_job_id
        AND nr.to_status IN ('open', 'disputed')
        AND nr.by LIKE 'person:%'
        AND wc.job_id = v_job_id
        AND wc.item_key = i.item_key;

      PERFORM public.context_ledger_closed_how_stamp(v_job_id);
    EXCEPTION WHEN OTHERS THEN
      -- Codes and ids only; never customer text or amounts, and never fail the business write.
      RAISE WARNING 'context_ledger_closed_how_trigger_failed job_id=% sqlstate=%', v_job_id, SQLSTATE;
    END;
  END LOOP;
  RETURN NULL;
END $trg$;

CREATE FUNCTION public.context_ledger_word_closes_mark(
  p_job_id uuid,
  p_item_keys text[],
  p_reader text,
  p_reader_model text,
  p_checker_model text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $mark$
DECLARE
  v_keys integer := 0;
/* mark block */ BEGIN
  IF p_reader_model IS NULL OR btrim(p_reader_model) = ''
     OR p_checker_model IS NULL OR btrim(p_checker_model) = '' THEN
    RAISE EXCEPTION 'word_closes_model_required' USING ERRCODE = '22023';
  END IF;

  IF lower(btrim(p_reader_model)) = lower(btrim(p_checker_model)) THEN
    RAISE EXCEPTION 'word_closes_same_model' USING ERRCODE = '22023';
  END IF;

  IF p_reader IS NULL OR btrim(p_reader) = '' THEN
    RAISE EXCEPTION 'word_closes_reader_required' USING ERRCODE = '22023';
  END IF;

  IF p_item_keys IS NULL THEN
    RAISE EXCEPTION 'word_closes_keys_required' USING ERRCODE = '22023';
  END IF;

  IF p_job_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.jobs WHERE id = p_job_id) THEN
    RAISE EXCEPTION 'word_closes_job_not_found'
      USING ERRCODE = '22023', DETAIL = coalesce(p_job_id::text, 'null');
  END IF;

  IF EXISTS (
    SELECT 1 FROM unnest(p_item_keys) AS u(k)
    WHERE u.k IS NULL OR btrim(u.k) = ''
  ) THEN
    RAISE EXCEPTION 'word_closes_bad_key' USING ERRCODE = '22023';
  END IF;

  IF cardinality(p_item_keys) > 0 THEN
    INSERT INTO public.context_ledger_word_closes (
      job_id, item_key, reader, reader_model, checker_model, agreed_at
    )
    SELECT
      p_job_id,
      k.item_key,
      btrim(p_reader),
      btrim(p_reader_model),
      btrim(p_checker_model),
      clock_timestamp()
    FROM (
      SELECT DISTINCT btrim(u.k) AS item_key
      FROM unnest(p_item_keys) AS u(k)
      ORDER BY 1
    ) AS k
    ON CONFLICT (job_id, item_key) DO UPDATE SET
      reader = EXCLUDED.reader,
      reader_model = EXCLUDED.reader_model,
      checker_model = EXCLUDED.checker_model,
      agreed_at = EXCLUDED.agreed_at;

    GET DIAGNOSTICS v_keys = ROW_COUNT;
  END IF;

  PERFORM public.context_ledger_closed_how_stamp(p_job_id);
  RETURN v_keys;
END $mark$;

-- One set-based UPDATE for currently closed or declined items of live readings (Step 7).
-- Indexes: context_ledger_generations_one_live, context_ledger_items_generation,
-- context_ledger_transitions_job, context_ledger_items_pkey, context_ledger_word_closes_pkey.
CREATE FUNCTION public.context_ledger_closed_how_backfill()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $backfill$
DECLARE
  v_updated integer := 0;
/* backfill block */ BEGIN
  WITH desired AS (
    SELECT
      i.id,
      CASE
        WHEN lc.by = 'rule:record_close_v1' THEN 'record'
        WHEN lc.by LIKE 'person:%'
          OR (lc.by IS NULL AND i.written_by LIKE 'person:%') THEN 'person'
        WHEN lc.by LIKE 'model:%' THEN
          CASE WHEN wc.item_key IS NOT NULL THEN 'words_two_models' ELSE 'words_one_model' END
        ELSE NULL
      END AS next_closed_how
    FROM public.context_ledger_generations AS g
    JOIN public.context_ledger_items AS i
      ON i.generation_id = g.id
     AND i.job_id = g.job_id
    LEFT JOIN LATERAL (
      SELECT t.by
      FROM public.context_ledger_transitions AS t
      JOIN public.context_ledger_items AS ti
        ON ti.id = t.item_id
       AND ti.job_id = i.job_id
       AND ti.item_key = i.item_key
      WHERE t.job_id = i.job_id
        AND t.to_status IN ('closed', 'declined')
        AND t.by NOT IN ('rule:carry_forward', 'rule:rebuild_seed')
      ORDER BY t.at DESC, t.id DESC
      LIMIT 1
    ) AS lc ON true
    LEFT JOIN public.context_ledger_word_closes AS wc
      ON wc.job_id = i.job_id
     AND wc.item_key = i.item_key
    WHERE g.status = 'live'
      AND i.status IN ('closed', 'declined')
  ),
  locked AS (
    SELECT i.id, d.next_closed_how
    FROM public.context_ledger_items AS i
    JOIN desired AS d ON d.id = i.id
    WHERE i.closed_how IS DISTINCT FROM d.next_closed_how
    ORDER BY i.id
    FOR UPDATE OF i
  )
  UPDATE public.context_ledger_items AS target
  SET closed_how = locked.next_closed_how
  FROM locked
  WHERE target.id = locked.id
    AND target.closed_how IS DISTINCT FROM locked.next_closed_how;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END $backfill$;

-- Explicit director activation after ZZTEST proof: installs the statement trigger
-- and runs the idempotent set-based backfill so no closed live note is missed.
CREATE FUNCTION public.context_ledger_closed_how_install()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $install$ /* install block */ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.context_ledger_transitions'::regclass
      AND tgname = 'context_ledger_transitions_closed_how'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER context_ledger_transitions_closed_how
      AFTER INSERT ON public.context_ledger_transitions
      REFERENCING NEW TABLE AS new_rows
      FOR EACH STATEMENT
      EXECUTE FUNCTION public.context_ledger_transitions_closed_how_trg();
  END IF;
  RETURN public.context_ledger_closed_how_backfill();
END $install$;

CREATE FUNCTION public.context_ledger_closed_how_remove()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $remove$ /* remove block */ BEGIN
  IF to_regclass('public.context_ledger_transitions') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS context_ledger_transitions_closed_how ON public.context_ledger_transitions;
  END IF;
END $remove$;

REVOKE ALL ON FUNCTION
  public.context_ledger_closed_how_stamp(uuid),
  public.context_ledger_transitions_closed_how_trg(),
  public.context_ledger_word_closes_mark(uuid, text[], text, text, text),
  public.context_ledger_closed_how_backfill(),
  public.context_ledger_closed_how_install(),
  public.context_ledger_closed_how_remove()
FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.context_ledger_closed_how_stamp(uuid),
  public.context_ledger_transitions_closed_how_trg(),
  public.context_ledger_word_closes_mark(uuid, text[], text, text, text),
  public.context_ledger_closed_how_backfill(),
  public.context_ledger_closed_how_install(),
  public.context_ledger_closed_how_remove()
TO service_role;
