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
--   3. When a job in a group moves from draft or quoted into a won status, an
--      AFTER UPDATE trigger marks every other open option of that group
--      superseded (superseded_by_job_id, superseded_at) and writes one
--      job_event each, in the same transaction. It never changes a sibling's
--      status (so no status trigger or sync fires), and never touches a
--      sibling that is past quoted, already superseded, has a crew assignment
--      or a Xero invoice that is not deleted or voided: those are left for a
--      person.
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
ALTER TABLE public.jobs ADD CONSTRAINT jobs_superseded_shape CHECK (
  (superseded_by_job_id IS NULL) = (superseded_at IS NULL)
  AND (superseded_by_job_id IS NULL OR superseded_by_job_id <> id)
);

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
     OR coalesce(v_of.status, 'draft') NOT IN ('draft', 'quoted') THEN
    RAISE EXCEPTION 'quote_option_not_open' USING ERRCODE = '22023';
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
  FOR v_sibling IN
    SELECT j.id FROM public.jobs j
     WHERE j.quote_option_group_id = NEW.quote_option_group_id
       AND j.id <> NEW.id
       AND j.superseded_at IS NULL
       AND coalesce(j.status, 'draft') IN ('draft', 'quoted')
       AND NOT EXISTS (SELECT 1 FROM public.job_assignments a WHERE a.job_id = j.id)
       AND NOT EXISTS (SELECT 1 FROM public.xero_invoices x WHERE x.job_id = j.id
                        AND upper(coalesce(x.status, '')) NOT IN ('DELETED', 'VOIDED'))
     ORDER BY j.id
     FOR UPDATE
  LOOP
    UPDATE public.jobs SET superseded_by_job_id = NEW.id, superseded_at = now()
     WHERE id = v_sibling.id AND superseded_at IS NULL;
    INSERT INTO public.job_events (job_id, event_type, detail_json)
    VALUES (v_sibling.id, 'quote_option_superseded',
            jsonb_build_object('superseded_by_job_id', NEW.id,
                               'quote_option_group_id', NEW.quote_option_group_id,
                               'accepted_status', NEW.status));
  END LOOP;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_jobs_quote_option_supersede ON public.jobs;
CREATE TRIGGER trg_jobs_quote_option_supersede
  AFTER UPDATE OF status ON public.jobs
  FOR EACH ROW
  WHEN (NEW.quote_option_group_id IS NOT NULL
        AND NEW.superseded_at IS NULL
        AND coalesce(OLD.status, 'draft') IN ('draft', 'quoted')
        AND NEW.status IS NOT NULL
        AND NEW.status NOT IN ('draft', 'quoted', 'lost', 'cancelled', 'archived'))
  EXECUTE FUNCTION public.jobs_quote_option_supersede();
