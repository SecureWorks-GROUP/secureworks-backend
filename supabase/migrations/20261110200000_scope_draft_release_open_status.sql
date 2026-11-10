-- TK-S28: acceptance releases the scope draft work order whatever open
-- status the acceptance left the job in.
--
-- Until now the release ran only while jobs.status was exactly 'accepted'.
-- A job the office moved straight from quoted to Deposit or Scheduled, or one
-- whose release was held at acceptance and then moved on by the deposit
-- (accepted -> awaiting_deposit -> order_materials), could never be released:
-- its work order could not be approved (guard_scope_draft_work_order), no
-- group could form and the local payment stages never got quote_accepted.
-- The job work order and its quote fill already treat every open status as
-- accepted (job_work_order_open_statuses). The release now does the same,
-- except partial acceptance. Everything else in the body is unchanged
-- (20261109040000): the accepted revision must match the prepared one, the
-- release happens once, a repeat replays and creates nothing.
--
-- Function body only. No table, row, flag or switch changes; no backfill.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION public.release_scope_job_drafts(p_job_id uuid, p_scope_revision_id uuid, p_legacy boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s public.scope_job_draft_sets%ROWTYPE; j public.jobs%ROWTYPE; v_first boolean; v_issue jsonb;
BEGIN
  SELECT * INTO j FROM public.jobs WHERE id = p_job_id FOR UPDATE;
  -- An accepted job is any open status past acceptance, the rule the job
  -- work order already follows (job_work_order_open_statuses). Partial
  -- acceptance never releases.
  IF NOT FOUND OR j.status = 'partially_accepted'
    OR NOT (j.status = ANY (public.job_work_order_open_statuses())) THEN
    RAISE EXCEPTION 'scope_drafts_acceptance_required' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO s FROM public.scope_job_draft_sets WHERE job_id = j.id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('released', false, 'reason', 'no_drafts'); END IF;
  IF s.scope_revision_id IS DISTINCT FROM p_scope_revision_id THEN
    RAISE EXCEPTION 'scope_drafts_accepted_revision_mismatch' USING ERRCODE = '23514';
  END IF;
  IF s.released_at IS NOT NULL THEN
    IF NOT public.owner_approval_required() THEN
      RETURN jsonb_build_object('released', true, 'replayed', true);
    END IF;
    RETURN jsonb_build_object('released', true, 'replayed', true,
      'issue', public.scope_job_draft_issue_state(j.id));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.scope_revisions r JOIN public.work_orders w ON w.id = s.work_order_id
    WHERE r.id = s.scope_revision_id AND r.job_id = j.id AND r.status IN ('frozen', 'superseded')
      AND w.scope_revision_id = r.id AND w.scope_items = s.labour_lines
      AND w.agreed_labour_ex IS NOT DISTINCT FROM s.labour_total_cents / 100.0
      AND (NOT p_legacy OR r.status = 'frozen' AND NOT EXISTS (
        SELECT 1 FROM public.scope_revisions n WHERE n.job_id = j.id AND n.revision_number > r.revision_number))) THEN
    RAISE EXCEPTION 'scope_drafts_source_changed' USING ERRCODE = '23514';
  END IF;
  -- Switch off: the release exactly as before. Last, best effort: the
  -- acceptance time and what the switch would have waited for.
  IF NOT public.owner_approval_required() THEN
    UPDATE public.scope_job_draft_sets SET released_at = now() WHERE job_id = j.id AND released_at IS NULL;
    INSERT INTO public.job_events(job_id, event_type, detail_json) VALUES
      (j.id, 'scope_job_draft_work_order_released', jsonb_build_object('work_order_id', s.work_order_id, 'scope_revision_id', s.scope_revision_id));
    PERFORM public.owner_unapproved_queue(jsonb_build_object('kind', 'released', 'job_id', j.id,
      'legacy', COALESCE(p_legacy, false)));
    PERFORM public.flush_owner_unapproved();
    RETURN jsonb_build_object('released', true, 'replayed', false);
  END IF;
  v_first := s.acceptance_recorded_at IS NULL OR s.acceptance_scope_revision_id IS DISTINCT FROM s.scope_revision_id;
  IF v_first THEN
    UPDATE public.scope_job_draft_sets
      SET acceptance_recorded_at = now(), acceptance_scope_revision_id = s.scope_revision_id,
          acceptance_legacy = COALESCE(p_legacy, false)
      WHERE job_id = j.id;
  END IF;
  v_issue := public.issue_owner_approved_job_work_order(s.work_order_id);
  IF (v_issue->>'issued')::boolean THEN
    RETURN jsonb_build_object('released', true, 'replayed', false,
      'issue', public.scope_job_draft_issue_state(j.id));
  END IF;
  IF v_first THEN
    INSERT INTO public.job_events(job_id, event_type, detail_json) VALUES
      (j.id, 'scope_job_draft_issue_held', jsonb_build_object('work_order_id', s.work_order_id,
        'scope_revision_id', s.scope_revision_id, 'missing', v_issue->'missing'));
  END IF;
  RETURN jsonb_build_object('released', false, 'held', true, 'reason', 'owner_approval_required',
    'acceptance_recorded', true, 'missing', v_issue->'missing',
    'issue', public.scope_job_draft_issue_state(j.id));
END $$;


REVOKE ALL ON FUNCTION public.release_scope_job_drafts(uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_scope_job_drafts(uuid, uuid, boolean) TO service_role;
