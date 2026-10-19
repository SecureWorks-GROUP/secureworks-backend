-- Fence quote options: alternatives on one customer decision, and closing the
-- options not taken when one is accepted (ticket SQ-23).
--
-- Why: the fence scoping tool mints a separate job for each alternative quote
-- (the lead picker save always makes a new GHL opportunity, and "new job for
-- existing client" cannot say "another option"), and the options not taken
-- stay live. Context then cannot tell which job a text belongs to. Design:
-- ~/Projects/quote-tool/verify/evidence/2026-10-19-sq23-quote-option-jobs/DESIGN.md.
--
-- What, all additive:
--   1. jobs.quote_option_group_id: the first job of an option group (set on
--      that job too). Only link_fence_quote_option writes it, and only when the
--      scoper says the new job is another option of an existing quote. A
--      deliberate repeat job is never in a group, so genuine repeat work stays
--      distinct by construction, not by inference.
--   2. jobs.quote_option_label, superseded_by_job_id, superseded_at.
--   3. When a job in a group moves into a won status (an explicit list), an
--      AFTER UPDATE trigger marks every other open option of that group
--      superseded (superseded_by_job_id, superseded_at) and writes one
--      job_event each. It never changes a sibling's status (so no status
--      trigger or sync fires), never waits on a lock and never fails the
--      acceptance. A sibling that was also won, is crewed or invoiced, or is
--      held by another transaction gets a quote_option_review_needed event
--      for a person instead. A superseded option the client accepts anyway is
--      won: its mark is cleared and the group flagged for review. Acceptance
--      itself is never refused.
--   4. Switch quote_option_supersede_v1, seeded OFF: the trigger does nothing
--      until the owner turns it on. Linking works with the switch off.
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

-- The supersede trigger looks a group up by this. A plain build reads the
-- table once under a SHARE lock (writes wait) within the 30s statement and
-- 5s lock timeouts above; the release owner may build it CONCURRENTLY first
-- instead, and this IF NOT EXISTS then skips it.
CREATE INDEX IF NOT EXISTS idx_jobs_quote_option_group
  ON public.jobs (quote_option_group_id)
  WHERE quote_option_group_id IS NOT NULL;

COMMENT ON COLUMN public.jobs.quote_option_group_id IS
  'Fence quote options (SQ-23): the first job of the group, on every job in it. Written only by link_fence_quote_option. A deliberate repeat job is never in a group.';
COMMENT ON COLUMN public.jobs.superseded_by_job_id IS
  'Set with superseded_at when another option of this job''s quote_option_group was accepted. The job''s status is not changed.';

INSERT INTO public.feature_flags (flag_name, enabled, description)
SELECT 'quote_option_supersede_v1', false,
  'Fence quote options (SQ-23): when on, accepting one job of a quote option group marks its other open options superseded (superseded_by_job_id, superseded_at, a job_event). Off: nothing is superseded; grouping still records. Turn on only on the owner''s word.'
WHERE NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'quote_option_supersede_v1');

-- The statuses that mean the client took this option: an explicit list, not
-- "anything but draft or quoted". partially_accepted is left out on purpose:
-- one party of a shared fence accepting does not decide between options.
CREATE OR REPLACE FUNCTION public.fence_quote_option_status_won(p_status text)
RETURNS boolean
LANGUAGE sql IMMUTABLE
AS $$
  SELECT coalesce(p_status, '') IN ('accepted', 'processing', 'awaiting_supplier', 'scheduled',
    'in_progress', 'rectification', 'final_payment', 'invoiced', 'complete', 'get_review')
$$;

-- Link p_job_id as another option of p_option_of_job_id's quote. Idempotent.
-- Both must be fencing jobs of one organisation and one GHL contact, neither
-- superseded, the earlier one still draft or quoted, and p_job_id in no other
-- group. Returns the group id.
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
  -- Lock both rows in id order so two links at once cannot interleave.
  PERFORM 1 FROM public.jobs WHERE id IN (p_job_id, p_option_of_job_id) ORDER BY id FOR UPDATE;
  SELECT * INTO v_new FROM public.jobs WHERE id = p_job_id;
  SELECT * INTO v_of FROM public.jobs WHERE id = p_option_of_job_id;
  IF v_new.id IS NULL OR v_of.id IS NULL THEN
    RAISE EXCEPTION 'quote_option_job_missing' USING ERRCODE = '22023';
  END IF;
  IF v_new.type <> 'fencing' OR v_of.type <> 'fencing' OR v_new.org_id <> v_of.org_id
     OR v_new.ghl_contact_id IS NULL OR v_new.ghl_contact_id IS DISTINCT FROM v_of.ghl_contact_id THEN
    RAISE EXCEPTION 'quote_option_not_same_customer' USING ERRCODE = '22023';
  END IF;
  v_group := coalesce(v_of.quote_option_group_id, v_of.id);
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
  -- Lock the whole group (id order) so an acceptance in flight is waited for
  -- and seen. The supersede trigger never waits on a lock, so this cannot
  -- deadlock with it.
  PERFORM 1 FROM public.jobs WHERE quote_option_group_id = v_group OR id = v_group ORDER BY id FOR UPDATE;
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

-- Never blocks or fails the acceptance that fired it, and never waits on a
-- lock: a sibling another transaction holds (for example being accepted at
-- the same moment) is skipped and recorded for review, so two acceptances in
-- one group cannot deadlock. Any error inside is caught and recorded; the
-- acceptance stands. What the client is sent or accepts is not touched.
CREATE OR REPLACE FUNCTION public.jobs_quote_option_supersede()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_sibling record;
BEGIN
  IF NOT coalesce((SELECT enabled FROM public.feature_flags WHERE flag_name = 'quote_option_supersede_v1'), false) THEN
    RETURN NULL;
  END IF;
  BEGIN
    -- This job had been marked superseded by another option and the client
    -- accepted it anyway: it is won now. Clear its mark and flag the group for
    -- a person; nothing else is changed.
    IF NEW.superseded_at IS NOT NULL THEN
      UPDATE public.jobs SET superseded_by_job_id = NULL, superseded_at = NULL WHERE id = NEW.id;
      INSERT INTO public.job_events (job_id, event_type, detail_json)
      VALUES (NEW.id, 'quote_option_review_needed',
              jsonb_build_object('reason', 'accepted_after_superseded',
                                 'was_superseded_by_job_id', NEW.superseded_by_job_id,
                                 'quote_option_group_id', NEW.quote_option_group_id));
      RETURN NULL;
    END IF;
    FOR v_sibling IN
      SELECT j.id,
             EXISTS (SELECT 1 FROM public.job_assignments a WHERE a.job_id = j.id) AS crewed,
             EXISTS (SELECT 1 FROM public.xero_invoices x WHERE x.job_id = j.id
                      AND upper(coalesce(x.status, '')) NOT IN ('DELETED', 'VOIDED')) AS invoiced,
             public.fence_quote_option_status_won(j.status) AS won,
             coalesce(j.status, 'draft') IN ('draft', 'quoted') AS open
        FROM public.jobs j
       WHERE j.quote_option_group_id = NEW.quote_option_group_id
         AND j.id <> NEW.id
         AND j.superseded_at IS NULL
       ORDER BY j.id
    LOOP
      IF v_sibling.won OR v_sibling.crewed OR v_sibling.invoiced THEN
        -- Another option was also won, crewed or invoiced: a person decides.
        INSERT INTO public.job_events (job_id, event_type, detail_json)
        VALUES (v_sibling.id, 'quote_option_review_needed',
                jsonb_build_object('reason', CASE WHEN v_sibling.won THEN 'another_option_won'
                                                  WHEN v_sibling.crewed THEN 'crewed' ELSE 'invoiced' END,
                                   'accepted_job_id', NEW.id,
                                   'quote_option_group_id', NEW.quote_option_group_id));
      ELSIF v_sibling.open THEN
        UPDATE public.jobs j SET superseded_by_job_id = NEW.id, superseded_at = now()
         WHERE j.id = (SELECT x.id FROM public.jobs x WHERE x.id = v_sibling.id
                         AND x.superseded_at IS NULL FOR UPDATE SKIP LOCKED);
        IF FOUND THEN
          INSERT INTO public.job_events (job_id, event_type, detail_json)
          VALUES (v_sibling.id, 'quote_option_superseded',
                  jsonb_build_object('superseded_by_job_id', NEW.id,
                                     'quote_option_group_id', NEW.quote_option_group_id,
                                     'accepted_status', NEW.status));
        ELSE
          -- Held by another transaction (perhaps being accepted now): skip it.
          INSERT INTO public.job_events (job_id, event_type, detail_json)
          VALUES (NEW.id, 'quote_option_review_needed',
                  jsonb_build_object('reason', 'sibling_busy', 'sibling_job_id', v_sibling.id,
                                     'quote_option_group_id', NEW.quote_option_group_id));
        END IF;
      END IF;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'jobs_quote_option_supersede: % (%), acceptance kept', SQLERRM, SQLSTATE;
  END;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_jobs_quote_option_supersede ON public.jobs;
CREATE TRIGGER trg_jobs_quote_option_supersede
  AFTER UPDATE OF status ON public.jobs
  FOR EACH ROW
  WHEN (NEW.quote_option_group_id IS NOT NULL
        AND NOT public.fence_quote_option_status_won(OLD.status)
        AND public.fence_quote_option_status_won(NEW.status))
  EXECUTE FUNCTION public.jobs_quote_option_supersede();
