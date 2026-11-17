-- P1-13.3: dormant claim records. No existing caller or split rule changes.
INSERT INTO public.feature_flags(flag_name, enabled, description) VALUES
  ('group_claim_flow_v1', false, 'Group claim: the first person names the crew, everyone approves the split, the server issues the invoices, 48 hours then the office.'),
  ('group_claim_all_jobs_v1', false, 'Every job with an agreed work order amount that is not hourly is claimed through the group claim.')
ON CONFLICT (flag_name) DO NOTHING;

ALTER TABLE public.group_work_orders
  ADD COLUMN IF NOT EXISTS claim_state text
    CHECK (claim_state IS NULL OR claim_state IN ('waiting_hours','waiting_approval','disputed','with_office','invoiced')),
  ADD COLUMN IF NOT EXISTS claim_started_by uuid,
  ADD COLUMN IF NOT EXISTS claim_deadline_at timestamptz;
CREATE INDEX IF NOT EXISTS group_work_orders_claim_due_idx
  ON public.group_work_orders(claim_deadline_at)
  WHERE claim_state IN ('waiting_hours','waiting_approval','disputed');
ALTER TABLE public.group_work_order_participants
  ADD COLUMN IF NOT EXISTS named_by uuid,
  ADD COLUMN IF NOT EXISTS named_at timestamptz;

CREATE TABLE IF NOT EXISTS public.group_work_order_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES public.group_work_orders(id),
  user_id uuid NOT NULL REFERENCES public.users(id),
  split_hash text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approve','dispute')),
  reason text CHECK (decision <> 'dispute' OR
    (reason IS NOT NULL AND char_length(btrim(reason)) BETWEEN 3 AND 500)),
  via text NOT NULL DEFAULT 'self' CHECK (via IN ('self','office')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (group_id,user_id,split_hash,decision)
);
ALTER TABLE public.group_work_order_approvals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.group_work_order_approvals FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.group_work_order_approvals TO service_role;
CREATE POLICY group_claim_approvals_service_select ON public.group_work_order_approvals
  FOR SELECT TO service_role USING (true);
CREATE POLICY group_claim_approvals_service_insert ON public.group_work_order_approvals
  FOR INSERT TO service_role WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.group_claim_approvals_append_only()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $function$ BEGIN
  RAISE EXCEPTION 'group_claim_approval_append_only' USING ERRCODE = '55000';
END; $function$;
REVOKE ALL ON FUNCTION public.group_claim_approvals_append_only() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER group_claim_approvals_append_only
  BEFORE UPDATE OR DELETE ON public.group_work_order_approvals
  FOR EACH ROW EXECUTE FUNCTION public.group_claim_approvals_append_only();

ALTER TABLE public.group_work_order_time_entries
  ADD COLUMN IF NOT EXISTS suggested jsonb,
  ADD COLUMN IF NOT EXISTS changed_from_suggestion boolean;

-- Preserve every action from 20261106170000_group_office_removal_wins.
DO $migration$ DECLARE
  prior text;
  expected text := $check$CHECK ((action = ANY (ARRAY['freeze'::text, 'unfreeze'::text, 'revoke_signoff'::text, 'void_group'::text, 'rekey'::text, 'remove_participant'::text, 'approve_budget'::text, 'amend_pay_basis'::text, 'release'::text, 'office_issue_invoices'::text, 'office_approve_hours'::text, 'restore_participant'::text])))$check$; BEGIN
  SELECT pg_get_constraintdef(oid) INTO prior FROM pg_constraint
    WHERE conrelid = 'public.group_work_order_events'::regclass
      AND conname = 'group_work_order_events_action_check';
  IF prior IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'group_claim_event_actions_changed';
  END IF;
  ALTER TABLE public.group_work_order_events DROP CONSTRAINT group_work_order_events_action_check;
  ALTER TABLE public.group_work_order_events ADD CONSTRAINT group_work_order_events_action_check
    CHECK (action IN ('freeze','unfreeze','revoke_signoff','void_group','rekey','remove_participant',
      'approve_budget','amend_pay_basis','release','office_issue_invoices','office_approve_hours',
      'restore_participant','name_crew','leave_claim','confirm_hours','approve_split','dispute_split',
      'escalate','issue_invoices','office_settle'));
END; $migration$;

CREATE OR REPLACE FUNCTION public.group_claim_split_hash(p_group_id uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $function$ DECLARE
  projected jsonb;
  coordinates text; BEGIN
  -- Consume the existing projection, including its pot deductions and cent
  -- allocation. It uses temporary working rows but never freezes or invoices.
  projected := public.project_group_work_order_split(p_group_id);
  IF jsonb_array_length(projected->'shares') = 0 THEN RETURN NULL; END IF;
  SELECT round((projected->'shares'->0->>'pot_ex')::numeric * 100)::bigint::text
    || '|' || string_agg(
      (s->>'user_id') || '|' || round((s->>'hours')::numeric * 100)::bigint::text
        || '|' || round((s->>'share_ex')::numeric * 100)::bigint::text,
      '|' ORDER BY (s->>'user_id') COLLATE "C")
    INTO coordinates FROM jsonb_array_elements(projected->'shares') s;
  RETURN md5(coordinates);
EXCEPTION WHEN check_violation THEN
  IF SQLERRM LIKE 'group_split_needs_hours:%'
     OR SQLERRM LIKE 'group_share_rate_missing:%'
     OR SQLERRM LIKE 'group_participant_needs_rate:%'
     OR SQLERRM = 'group_share_hours_missing' THEN
    RETURN NULL;
  END IF;
  RAISE;
END; $function$;
REVOKE ALL ON FUNCTION public.group_claim_split_hash(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.group_claim_split_hash(uuid) TO service_role;
