-- Fence quote options: alternatives on one customer decision, and closing the
-- options not taken when one is accepted (ticket SQ-23).
--
-- Why: the fence scoping tool mints a separate job for each alternative quote
-- (the lead picker save always makes a new GHL opportunity, and "new job for
-- existing client" cannot say "another option"), and the options not taken
-- stay live. Context then cannot tell which job a text belongs to. Design:
-- ~/Projects/quote-tool/verify/evidence/2026-10-19-sq23-quote-option-jobs/DESIGN.md,
-- with the CIO (Context) decisions of 19 Oct 2026 (receipt 067f70f).
--
-- What, all additive:
--   1. jobs.quote_option_group_id: the first job of an option group (set on
--      that job too). Only link_fence_quote_option writes it, and only when the
--      scoper says the new job is another option of an existing quote. A
--      deliberate repeat job is never in a group, so genuine repeat work stays
--      distinct by construction, not by inference.
--   2. jobs.quote_option_label, superseded_by_job_id, superseded_at. The
--      pointer is current state only. The job_events log is the history: a
--      job is not live from each quote_option_superseded event to the next
--      quote_option_unsuperseded event for it, and live outside those.
--   3. When a grouped job moves into a won status, an AFTER UPDATE trigger
--      marks the other open options superseded (pointer, time, one event
--      each). It never changes a status, so no status side effect fires.
--        - Two or more options won at once: nothing is superseded, any marks
--          in the group are cleared (each with an unsuperseded event), and
--          one review event is written. Every option stays live.
--        - The accepted job goes back to draft or quoted (acceptance
--          reversed): the options it superseded are cleared, each with an
--          unsuperseded event.
--        - The accepted job goes anywhere else not won (lost, cancelled):
--          the marks are kept and a review event is written.
--        - A sibling crewed or invoiced is left alone with a review event;
--          one another transaction holds is skipped with one too.
--      If the trigger's own work fails, it alone is rolled back and a
--      quote_option_review_needed event records the failure; the status
--      change stands. Every run first writes a row to
--      quote_option_settle_runs and marks it settled only when its work
--      commits, so a failed run is recorded before its work starts. The
--      residual: if that first insert, the work and the review event all
--      fail, the status change commits with only warnings (see section
--      "Residual" in DESIGN.md). Closing it means failing the status change,
--      which send-quote's split write would turn into an accepted quote with
--      an unaccepted job: an owner decision, not made here.
--   4. Switch fence_same_site_guard_v1, seeded OFF: ghl-proxy's route A
--      refusal (choose_existing_or_option) stays off until every fencing
--      caller shows the chooser.
--   5. Switch quote_option_supersede_v1, seeded OFF: the trigger does nothing
--      until the owner turns it on. Linking works with the switch off. It
--      stays off until every reader that acts on "quoted" skips superseded
--      jobs (DESIGN.md section 9).
--
-- Locking: one advisory lock per group (fence_quote_option_lock_key) is taken
-- first by both the link function and the trigger. While holding it, neither
-- ever waits on a row: the link refuses with quote_option_busy and the trigger
-- skips the row. So neither can deadlock. The trigger waits for the group
-- lock for about 2 seconds at most, then records the failure for review.
--
-- Nothing here changes what a customer is sent or how they accept. Existing
-- jobs are not grouped or changed: the 25 duplicate sets found on 19 Oct 2026
-- are listed for a separate cleanup decision.
--
-- Rollback: supabase/rollbacks/20261019210000_fence_quote_option_jobs_down.sql.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS quote_option_group_id uuid NULL
    REFERENCES public.jobs(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS quote_option_label text NULL,
  ADD COLUMN IF NOT EXISTS superseded_by_job_id uuid NULL
    REFERENCES public.jobs(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS superseded_at timestamptz NULL;

ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_superseded_shape;
-- NOT VALID: every existing row has both columns NULL, so it holds, and
-- skipping the validation scan keeps the ACCESS EXCLUSIVE lock short on a
-- large table (2,851 rows, 385 MB on 19 Oct 2026). New writes are checked.
ALTER TABLE public.jobs ADD CONSTRAINT jobs_superseded_shape CHECK (
  (superseded_by_job_id IS NULL) = (superseded_at IS NULL)
  AND (superseded_by_job_id IS NULL OR superseded_by_job_id <> id)
) NOT VALID;

-- The trigger and link function look a group up by this. jobs had 2,851
-- rows on 19 Oct 2026 and every value is NULL, so the build is short. It
-- shares the transaction (and the ACCESS EXCLUSIVE lock) of the ALTER above,
-- bounded by the 5s lock and 30s statement timeouts (build time on the live
-- table not measured). To build it apart, the release owner splits it into a
-- later CREATE INDEX CONCURRENTLY step after the columns exist.
CREATE INDEX IF NOT EXISTS idx_jobs_quote_option_group
  ON public.jobs (quote_option_group_id)
  WHERE quote_option_group_id IS NOT NULL;

COMMENT ON COLUMN public.jobs.quote_option_group_id IS
  'Fence quote options (SQ-23): the first job of the group, on every job in it. Written only by link_fence_quote_option. A deliberate repeat job is never in a group.';
COMMENT ON COLUMN public.jobs.superseded_by_job_id IS
  'Current state only: set with superseded_at when another option of this job''s quote_option_group was accepted, cleared on undo. The job''s status is not changed. History is the quote_option_superseded and quote_option_unsuperseded job_events.';

INSERT INTO public.feature_flags (flag_name, enabled, description)
SELECT 'quote_option_supersede_v1', false,
  'Fence quote options (SQ-23): when on, accepting one job of a quote option group marks its other open options superseded (superseded_by_job_id, superseded_at, a job_event). Off: nothing is superseded; grouping still records. Turn on only on the owner''s word.'
WHERE NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'quote_option_supersede_v1');

INSERT INTO public.feature_flags (flag_name, enabled, description)
SELECT 'fence_same_site_guard_v1', false,
  'Fence quote options (SQ-23): when on, ghl-proxy create_job and create_contact_and_opportunity refuse a fencing save beside an open fence job of the same contact at the same address (409 choose_existing_or_option) unless repeatConfirmed. Off: no refusal. Turn on only once every fencing caller shows the chooser.'
WHERE NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'fence_same_site_guard_v1');

-- The statuses that mean the client took this option: an explicit list, not
-- "anything but draft or quoted". It includes the post-acceptance pipeline
-- stages, so a direct move from quoted to one of them still counts.
-- partially_accepted is left out on purpose: one party of a shared fence
-- accepting does not decide between options.
CREATE OR REPLACE FUNCTION public.fence_quote_option_status_won(p_status text)
RETURNS boolean
LANGUAGE sql IMMUTABLE
AS $$
  SELECT coalesce(p_status, '') IN ('accepted', 'awaiting_deposit', 'deposit', 'approvals',
    'order_materials', 'order_confirmed', 'schedule_install', 'processing', 'awaiting_supplier',
    'scheduled', 'in_progress', 'rectification', 'final_payment', 'invoiced', 'complete', 'get_review')
$$;

-- One advisory lock key per option group, shared by the link function and
-- the trigger.
CREATE OR REPLACE FUNCTION public.fence_quote_option_lock_key(p_group uuid)
RETURNS bigint
LANGUAGE sql IMMUTABLE
AS $$
  SELECT hashtextextended('fence_quote_option_group:' || p_group::text, 0)
$$;

-- One row per trigger run with the switch on, written before any of the
-- trigger's work and marked settled_at at the end of that work, in the same
-- subtransaction. If the work fails, settled_at stays NULL: the record of the
-- failure exists before the work starts (the insert itself can still fail;
-- see the header). No triggers and no RLS on
-- this table; only the trigger (as owner) inserts. The service role reads
-- it and fills resolved_at and resolved_by; nothing is deleted.
CREATE TABLE public.quote_option_settle_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id uuid NOT NULL,
  quote_option_group_id uuid NOT NULL,
  status text,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  sqlstate text,
  error text,
  review_sqlstate text,
  resolved_at timestamptz,
  resolved_by uuid
);
ALTER TABLE public.quote_option_settle_runs NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.quote_option_settle_runs DISABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.quote_option_settle_runs FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, UPDATE (resolved_at, resolved_by) ON public.quote_option_settle_runs TO service_role;
CREATE INDEX idx_quote_option_settle_runs_unsettled
  ON public.quote_option_settle_runs (created_at) WHERE settled_at IS NULL AND resolved_at IS NULL;
COMMENT ON TABLE public.quote_option_settle_runs IS
  'Fence quote options (SQ-23): one row per supersede-trigger run with the switch on. settled_at NULL means the run''s work failed and was rolled back (marks as they were before it); the status change stood. Unsettled, unresolved rows need a person.';

-- Link p_job_id as another option of p_option_of_job_id's quote. Idempotent.
-- Both must be fencing jobs of one organisation and one GHL contact, neither
-- superseded, both still draft or quoted, p_job_id in no other group, and no
-- option of the group already won. Returns the group id. Lock order: the
-- group's advisory lock, then every row involved in one id-ordered NOWAIT
-- statement. Anything busy is refused with quote_option_busy (55P03), which
-- the caller retries. It never waits on a row, so it cannot deadlock.
CREATE OR REPLACE FUNCTION public.link_fence_quote_option(
  p_job_id uuid,
  p_option_of_job_id uuid,
  p_label text,
  p_actor_id uuid
) RETURNS uuid
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_new public.jobs%ROWTYPE;
  v_of public.jobs%ROWTYPE;
  v_group uuid;
BEGIN
  IF p_job_id IS NULL OR p_option_of_job_id IS NULL OR p_job_id = p_option_of_job_id THEN
    RAISE EXCEPTION 'quote_option_invalid' USING ERRCODE = '22023';
  END IF;
  -- Unlocked read, only to find the group; everything is re-read under lock.
  SELECT * INTO v_of FROM public.jobs WHERE id = p_option_of_job_id;
  IF v_of.id IS NULL THEN
    RAISE EXCEPTION 'quote_option_job_missing' USING ERRCODE = '22023';
  END IF;
  v_group := coalesce(v_of.quote_option_group_id, v_of.id);
  IF NOT pg_try_advisory_xact_lock(public.fence_quote_option_lock_key(v_group)) THEN
    RAISE EXCEPTION 'quote_option_busy' USING ERRCODE = '55P03';
  END IF;
  BEGIN
    PERFORM 1 FROM public.jobs
     WHERE id IN (p_job_id, p_option_of_job_id, v_group) OR quote_option_group_id = v_group
     ORDER BY id FOR UPDATE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'quote_option_busy' USING ERRCODE = '55P03';
  END;
  SELECT * INTO v_new FROM public.jobs WHERE id = p_job_id;
  SELECT * INTO v_of FROM public.jobs WHERE id = p_option_of_job_id;
  IF v_new.id IS NULL OR v_of.id IS NULL THEN
    RAISE EXCEPTION 'quote_option_job_missing' USING ERRCODE = '22023';
  END IF;
  IF coalesce(v_of.quote_option_group_id, v_of.id) <> v_group THEN
    -- The earlier job joined another group between the read and the lock.
    RAISE EXCEPTION 'quote_option_busy' USING ERRCODE = '55P03';
  END IF;
  IF v_new.type <> 'fencing' OR v_of.type <> 'fencing' OR v_new.org_id <> v_of.org_id
     OR v_new.ghl_contact_id IS NULL OR v_new.ghl_contact_id IS DISTINCT FROM v_of.ghl_contact_id THEN
    RAISE EXCEPTION 'quote_option_not_same_customer' USING ERRCODE = '22023';
  END IF;
  IF v_new.quote_option_group_id IS NOT NULL THEN
    IF v_new.quote_option_group_id = v_group THEN
      RETURN v_group; -- already linked
    END IF;
    RAISE EXCEPTION 'quote_option_other_group' USING ERRCODE = '22023';
  END IF;
  IF v_new.superseded_at IS NOT NULL OR v_of.superseded_at IS NOT NULL
     OR coalesce(v_of.status, 'draft') NOT IN ('draft', 'quoted')
     OR coalesce(v_new.status, 'draft') NOT IN ('draft', 'quoted') THEN
    RAISE EXCEPTION 'quote_option_not_open' USING ERRCODE = '22023';
  END IF;
  -- A group that already has a won option takes no new options.
  IF EXISTS (SELECT 1 FROM public.jobs g
              WHERE (g.quote_option_group_id = v_group OR g.id = v_group)
                AND public.fence_quote_option_status_won(g.status)) THEN
    RAISE EXCEPTION 'quote_option_group_decided' USING ERRCODE = '22023';
  END IF;
  UPDATE public.jobs SET quote_option_group_id = v_group
   WHERE id = v_group AND quote_option_group_id IS NULL;
  UPDATE public.jobs SET quote_option_group_id = v_group,
         quote_option_label = nullif(left(trim(coalesce(p_label, '')), 120), '')
   WHERE id = p_job_id;
  INSERT INTO public.job_events (job_id, user_id, event_type, detail_json)
  VALUES (p_job_id, p_actor_id, 'quote_option_linked',
          jsonb_build_object('quote_option_group_id', v_group, 'option_of_job_id', p_option_of_job_id));
  RETURN v_group;
END $$;

REVOKE ALL ON FUNCTION public.link_fence_quote_option(uuid, uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.link_fence_quote_option(uuid, uuid, text, uuid) TO service_role;

-- The normal rule, for one won option p_winner: mark each open, uncrewed,
-- uninvoiced candidate superseded (pointer, time, one event each). The
-- caller holds the group's advisory lock and every candidate's row lock, so
-- each candidate is read here in its current, locked state. Never changes a
-- status. A candidate crewed or invoiced, or in a status other than draft,
-- quoted, lost or cancelled, gets a review event instead.
CREATE OR REPLACE FUNCTION public.fence_quote_option_mark_options(
  p_winner uuid,
  p_winner_status text,
  p_group uuid,
  p_candidates uuid[]
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row public.jobs%ROWTYPE;
  v_reason text;
BEGIN
  FOR v_row IN SELECT * FROM public.jobs j
                WHERE j.id = ANY (p_candidates) AND j.id <> p_winner ORDER BY j.id LOOP
    CONTINUE WHEN v_row.superseded_at IS NOT NULL
               OR public.fence_quote_option_status_won(v_row.status)
               OR coalesce(v_row.status, '') IN ('lost', 'cancelled');
    v_reason := CASE
      WHEN coalesce(v_row.status, 'draft') NOT IN ('draft', 'quoted') THEN 'sibling_' || v_row.status
      WHEN EXISTS (SELECT 1 FROM public.job_assignments a WHERE a.job_id = v_row.id) THEN 'crewed'
      WHEN EXISTS (SELECT 1 FROM public.xero_invoices x WHERE x.job_id = v_row.id
                    AND upper(coalesce(x.status, '')) NOT IN ('DELETED', 'VOIDED')) THEN 'invoiced'
    END;
    IF v_reason IS NOT NULL THEN
      INSERT INTO public.job_events (job_id, event_type, detail_json)
      VALUES (v_row.id, 'quote_option_review_needed',
              jsonb_build_object('reason', v_reason, 'accepted_job_id', p_winner,
                                 'quote_option_group_id', p_group));
    ELSE
      UPDATE public.jobs SET superseded_by_job_id = p_winner, superseded_at = now() WHERE id = v_row.id;
      INSERT INTO public.job_events (job_id, event_type, detail_json)
      VALUES (v_row.id, 'quote_option_superseded',
              jsonb_build_object('superseded_by_job_id', p_winner,
                                 'quote_option_group_id', p_group,
                                 'accepted_status', p_winner_status));
    END IF;
  END LOOP;
END $$;

-- Clear one job's superseded mark and close its interval with an event.
CREATE OR REPLACE FUNCTION public.fence_quote_option_clear_mark(
  p_job_id uuid,
  p_reason text,
  p_trigger_job_id uuid,
  p_group uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_was uuid;
BEGIN
  SELECT superseded_by_job_id INTO v_was FROM public.jobs
   WHERE id = p_job_id AND superseded_at IS NOT NULL;
  IF FOUND THEN
    UPDATE public.jobs SET superseded_by_job_id = NULL, superseded_at = NULL WHERE id = p_job_id;
    INSERT INTO public.job_events (job_id, event_type, detail_json)
    VALUES (p_job_id, 'quote_option_unsuperseded',
            jsonb_build_object('reason', p_reason, 'was_superseded_by_job_id', v_was,
                               'trigger_job_id', p_trigger_job_id, 'quote_option_group_id', p_group));
  END IF;
END $$;

-- The helpers and the trigger function run as their owner (SECURITY DEFINER,
-- fixed search_path): whoever changes a job's status, through any role, the
-- trigger's reads, locks and job_events writes behave the same and are not
-- refused by RLS or grants. Nobody calls the helpers directly.
REVOKE ALL ON FUNCTION public.fence_quote_option_mark_options(uuid, text, uuid, uuid[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fence_quote_option_clear_mark(uuid, text, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

-- Fires when a grouped job moves into or out of a won status (see the
-- header). The trigger's own work runs in its own block. If it fails, that
-- work is rolled back and a quote_option_review_needed event (reason
-- supersede_failed) is written in its place, and the status change stands.
-- A timeout or cancel during that work is caught the same way. The run's
-- row in quote_option_settle_runs is written first and stays unsettled when
-- the work fails, so the failure is on record even if the review event
-- cannot be written. The status change stands (send-quote's legacy path
-- commits the customer's acceptance before the job status). Only if the
-- first, plain insert into that trigger-less table and the review event both
-- fail is a run unrecorded; a warning is then logged, unless the atomic
-- acceptance marker or quote_option_strict_record_v1 asks for a raise
-- (20261019230000; both off by default). A timeout elsewhere in the
-- status change's statement still fails it, as before.
CREATE OR REPLACE FUNCTION public.jobs_quote_option_supersede()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_group uuid := NEW.quote_option_group_id;
  v_tries integer := 0;
  v_id uuid;
  v_locked uuid[] := '{}';
  v_busy uuid[] := '{}';
  v_won uuid[];
  v_won_status text;
  v_err_state text;
  v_err_msg text;
  v_review_state text;
  v_flag_on boolean;
  v_run bigint;
  v_strict boolean := false;
BEGIN
  -- The switch fails closed: off, missing or unreadable (a cancel, a
  -- timeout, a permission error, an assert failure, anything) means the trigger writes
  -- nothing at all, not even its run record. Only a readable true turns it
  -- on. (Ops V check of reader PR 1091, 19 Oct 2026.)
  BEGIN
    v_flag_on := coalesce((SELECT enabled FROM public.feature_flags
                            WHERE flag_name = 'quote_option_supersede_v1'), false) IS TRUE;
  EXCEPTION WHEN query_canceled OR assert_failure OR OTHERS THEN
    v_flag_on := false;
    RAISE WARNING 'jobs_quote_option_supersede: switch unreadable (%), treated as off', SQLSTATE;
  END;
  IF NOT v_flag_on THEN
    RETURN NULL;
  END IF;
  -- The run's record comes first, before any of the work. This insert can
  -- itself fail (a lock timeout or a cancel on this table); the work still
  -- runs, and the review event below is then the only failure record.
  BEGIN
    INSERT INTO public.quote_option_settle_runs (job_id, quote_option_group_id, status)
    VALUES (NEW.id, v_group, NEW.status) RETURNING id INTO v_run;
  EXCEPTION WHEN query_canceled OR assert_failure OR OTHERS THEN
    v_run := NULL;
    RAISE WARNING 'jobs_quote_option_supersede: run record not written (%)', SQLSTATE;
  END;
  BEGIN
    -- One group at a time. Bounded: about 2 seconds, then review.
    WHILE NOT pg_try_advisory_xact_lock(public.fence_quote_option_lock_key(v_group)) LOOP
      v_tries := v_tries + 1;
      IF v_tries >= 40 THEN
        RAISE EXCEPTION 'quote_option_group_busy' USING ERRCODE = '55P03';
      END IF;
      PERFORM pg_sleep(0.05);
    END LOOP;
    -- Lock every other member in id order without waiting. Each is then read
    -- again under its lock; one another transaction holds is busy.
    FOR v_id IN SELECT j.id FROM public.jobs j
                 WHERE j.quote_option_group_id = v_group AND j.id <> NEW.id ORDER BY j.id LOOP
      PERFORM 1 FROM public.jobs j WHERE j.id = v_id FOR UPDATE SKIP LOCKED;
      IF FOUND THEN
        v_locked := v_locked || v_id;
      ELSE
        v_busy := v_busy || v_id;
      END IF;
    END LOOP;
    -- Winners: locked members as just read, and busy members by their last
    -- committed status (a busy row is "unknown", never "not won"). A busy
    -- member being accepted right now runs this trigger after we commit and
    -- sees this job as a second winner.
    SELECT coalesce(array_agg(j.id ORDER BY j.id), '{}'::uuid[]) INTO v_won
      FROM public.jobs j
     WHERE (j.id = ANY (v_locked) OR j.id = ANY (v_busy))
       AND public.fence_quote_option_status_won(j.status);

    IF public.fence_quote_option_status_won(NEW.status) THEN
      IF cardinality(v_won) > 0 THEN
        -- More than one option won: no single winner, so every option stays
        -- live and a person decides.
        FOR v_id IN SELECT j.id FROM public.jobs j
                     WHERE (j.id = ANY (v_locked) OR j.id = NEW.id) AND j.superseded_at IS NOT NULL
                     ORDER BY j.id LOOP
          PERFORM public.fence_quote_option_clear_mark(v_id, 'more_than_one_option_won', NEW.id, v_group);
        END LOOP;
        INSERT INTO public.job_events (job_id, event_type, detail_json)
        VALUES (NEW.id, 'quote_option_review_needed',
                jsonb_build_object('reason', 'more_than_one_option_won',
                                   'won_job_ids', to_jsonb(v_won || NEW.id),
                                   'quote_option_group_id', v_group));
      ELSE
        IF NEW.superseded_at IS NOT NULL THEN
          -- The client accepted an option already marked superseded (its
          -- superseder is no longer won). It is the winner now.
          PERFORM public.fence_quote_option_clear_mark(NEW.id, 'accepted_after_superseded', NEW.id, v_group);
          INSERT INTO public.job_events (job_id, event_type, detail_json)
          VALUES (NEW.id, 'quote_option_review_needed',
                  jsonb_build_object('reason', 'accepted_after_superseded',
                                     'was_superseded_by_job_id', NEW.superseded_by_job_id,
                                     'quote_option_group_id', v_group));
        END IF;
        PERFORM public.fence_quote_option_mark_options(NEW.id, NEW.status, v_group, v_locked);
      END IF;
    ELSE
      -- The job left a won status.
      IF coalesce(NEW.status, 'draft') IN ('draft', 'quoted') THEN
        -- Acceptance reversed: the options it superseded are live again.
        FOR v_id IN SELECT j.id FROM public.jobs j
                     WHERE j.id = ANY (v_locked) AND j.superseded_by_job_id = NEW.id ORDER BY j.id LOOP
          PERFORM public.fence_quote_option_clear_mark(v_id, 'acceptance_reversed', NEW.id, v_group);
        END LOOP;
      ELSIF EXISTS (SELECT 1 FROM public.jobs j
                     WHERE j.id = ANY (v_locked) AND j.superseded_by_job_id = NEW.id) THEN
        -- Lost, cancelled or anything else: the options are not revived.
        INSERT INTO public.job_events (job_id, event_type, detail_json)
        VALUES (NEW.id, 'quote_option_review_needed',
                jsonb_build_object('reason', 'accepted_job_' || coalesce(NEW.status, 'unknown'),
                                   'quote_option_group_id', v_group));
      END IF;
      -- Exactly one option is still won: the normal rule applies to it,
      -- including to this job if it is open again.
      IF cardinality(v_won) = 1 AND cardinality(v_busy) = 0 THEN
        SELECT j.status INTO v_won_status FROM public.jobs j WHERE j.id = v_won[1];
        PERFORM public.fence_quote_option_mark_options(v_won[1], v_won_status, v_group, v_locked || NEW.id);
      END IF;
    END IF;

    IF cardinality(v_busy) > 0 THEN
      INSERT INTO public.job_events (job_id, event_type, detail_json)
      VALUES (NEW.id, 'quote_option_review_needed',
              jsonb_build_object('reason', 'sibling_busy', 'sibling_job_ids', to_jsonb(v_busy),
                                 'quote_option_group_id', v_group));
    END IF;
    -- Settled: in the same subtransaction as the work, so it rolls back
    -- with it.
    UPDATE public.quote_option_settle_runs SET settled_at = now() WHERE id = v_run;
  EXCEPTION WHEN query_canceled OR assert_failure OR OTHERS THEN
    GET STACKED DIAGNOSTICS v_err_state = RETURNED_SQLSTATE, v_err_msg = MESSAGE_TEXT;
  END;
  IF v_err_state IS NOT NULL THEN
    BEGIN
      INSERT INTO public.job_events (job_id, event_type, detail_json)
      VALUES (NEW.id, 'quote_option_review_needed',
              jsonb_build_object('reason', 'supersede_failed', 'sqlstate', v_err_state,
                                 'error', left(coalesce(v_err_msg, ''), 200),
                                 'status', NEW.status, 'quote_option_group_id', v_group));
    EXCEPTION WHEN query_canceled OR assert_failure OR OTHERS THEN
      GET STACKED DIAGNOSTICS v_review_state = RETURNED_SQLSTATE;
    END;
    -- The run's row already says the work did not settle; add why.
    BEGIN
      UPDATE public.quote_option_settle_runs
         SET sqlstate = v_err_state, error = left(coalesce(v_err_msg, ''), 200), review_sqlstate = v_review_state
       WHERE id = v_run;
    EXCEPTION WHEN query_canceled OR assert_failure OR OTHERS THEN
      NULL;
    END;
    IF v_run IS NULL AND v_review_state IS NOT NULL THEN
      -- Nothing could be recorded. By default the status change is kept
      -- with a warning (today's behaviour). Two opt-in contexts raise
      -- instead, so the whole transaction rolls back (20261019230000):
      --   * the atomic acceptance RPC's transaction-local marker
      --     sw.quote_accept_atomic = 'on' (a cooperative marker, not proof
      --     of origin; only reached when quote_accept_atomic_v1 is on);
      --   * the switch quote_option_strict_record_v1, for any writer, and
      --     only while quote_accept_atomic_v1 also reads true: both rows
      --     are read in one statement, and strict takes effect only if both
      --     are present and true (strict-after-atomic, enforced here rather
      --     than by a written rule). Seeded off; an owning-review decision.
      -- This raise is outside every swallowing block, so it propagates.
      -- The marker is read on its own, first, so an unreadable switch can
      -- never cancel the atomic path's raise.
      v_strict := coalesce(current_setting('sw.quote_accept_atomic', true), '') = 'on';
      -- send-quote's legacy status write marks its own transaction
      -- (quote_accept_legacy_set_status, 20261019230000): its document has
      -- already committed in an earlier request, so no switch read here may
      -- refuse its status (C4). The atomic marker, read first, still wins.
      IF NOT v_strict AND coalesce(current_setting('sw.quote_accept_legacy', true), '') <> 'on' THEN
        BEGIN
          v_strict := coalesce((SELECT count(DISTINCT f.flag_name) = 2 AND bool_and(f.enabled IS TRUE)
                                  FROM public.feature_flags f
                                 WHERE f.flag_name IN ('quote_option_strict_record_v1', 'quote_accept_atomic_v1')),
                               false);
        EXCEPTION WHEN query_canceled OR assert_failure OR OTHERS THEN
          -- Unreadable is off, like missing: the status change is kept, as
          -- today, with its own warning, and the gap read lists the status
          -- (won_without_acceptance_event; won_with_open_sibling while
          -- supersede reads true). Refusing instead was rejected (design 3):
          -- an unreadable switch row means quote_accept_atomic_v1 is not
          -- reliably on either, so send-quote is on the split writes, whose
          -- document acceptance has already committed; refusing its status
          -- would create the split state (accepted document, job not won)
          -- and block staff status changes during the same fault.
          v_strict := false;
          RAISE WARNING 'jobs_quote_option_supersede: strict or atomic switch unreadable (%), strict treated as off', SQLSTATE;
        END;
      END IF;
      IF v_strict THEN
        RAISE EXCEPTION 'quote_option_unrecorded'
          USING DETAIL = format('work %s, review event %s, no run record', v_err_state, v_review_state),
                HINT = 'status change refused: nothing about the supersede run could be recorded';
      END IF;
      RAISE WARNING 'jobs_quote_option_supersede: % (%), review event failed (%) and no run record; status change kept',
        v_err_msg, v_err_state, v_review_state;
    END IF;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_jobs_quote_option_supersede ON public.jobs;
CREATE TRIGGER trg_jobs_quote_option_supersede
  AFTER UPDATE OF status ON public.jobs
  FOR EACH ROW
  WHEN (NEW.quote_option_group_id IS NOT NULL
        AND public.fence_quote_option_status_won(OLD.status)
            IS DISTINCT FROM public.fence_quote_option_status_won(NEW.status))
  EXECUTE FUNCTION public.jobs_quote_option_supersede();
