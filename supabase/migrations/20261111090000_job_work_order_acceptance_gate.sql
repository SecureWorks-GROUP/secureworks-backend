-- RQ-19.a: a fencing or patio job's work order and its crew group do not go
-- into operations until the customer has accepted the job.
--
-- TK-S28 (20261110200000) holds a scope draft work order until acceptance,
-- but only on a job whose drafts the Scope Engine prepared
-- (scope_job_draft_sets). Any other fencing or patio job work order could be
-- approved by the office or the terminal while the job was still quoted, and
-- a crew group could then open on it and split its labour. Nothing in the
-- database looked at the job's status.
--
-- One rule now covers every path: a job is not accepted yet while it is a
-- fencing or patio job in draft, quoted, partially_accepted or lost
-- (job_not_yet_accepted). While that holds:
--   * a job work order is never issued (inserted or moved to 'approved'):
--     WO412 job_work_order_job_not_accepted;
--   * a crew group never opens on the job: WO412 group_job_not_accepted.
-- Every later status counts as accepted, so a work order approved late on a
-- finished job (complete, invoiced, archived) still issues, as today.
-- Partial acceptance is not acceptance (the rule TK-S28's release follows).
--
-- Additive: one helper, two trigger functions, two triggers. No table, row,
-- flag or switch changes; no backfill. Live on 11 Nov 2026, read only: no
-- fencing or patio job in those four statuses holds an approved job work
-- order or a group, so nothing already issued is affected.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION public.job_not_yet_accepted(p_type text, p_status text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT coalesce(p_type, '') IN ('fencing', 'patio')
     AND coalesce(p_status, '') IN ('draft', 'quoted', 'partially_accepted', 'lost')
$$;

CREATE OR REPLACE FUNCTION public.work_orders_issue_needs_acceptance()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  j record;
BEGIN
  IF NEW.kind IS DISTINCT FROM 'job' OR NEW.status IS DISTINCT FROM 'approved' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'approved' THEN
    RETURN NEW;
  END IF;
  SELECT type, status INTO j FROM public.jobs WHERE id = NEW.job_id;
  IF FOUND AND public.job_not_yet_accepted(j.type, j.status) THEN
    RAISE EXCEPTION 'job_work_order_job_not_accepted: the job is %, so its work order is issued once the customer accepts', j.status
      USING ERRCODE = 'WO412';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_work_orders_issue_needs_acceptance ON public.work_orders;
CREATE TRIGGER trg_work_orders_issue_needs_acceptance
  BEFORE INSERT OR UPDATE OF status ON public.work_orders
  FOR EACH ROW EXECUTE FUNCTION public.work_orders_issue_needs_acceptance();

CREATE OR REPLACE FUNCTION public.group_work_orders_open_needs_acceptance()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  j record;
BEGIN
  SELECT type, status INTO j FROM public.jobs WHERE id = NEW.job_id;
  IF FOUND AND public.job_not_yet_accepted(j.type, j.status) THEN
    RAISE EXCEPTION 'group_job_not_accepted: the job is %, so no crew group opens before the customer accepts', j.status
      USING ERRCODE = 'WO412';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_group_work_orders_open_needs_acceptance ON public.group_work_orders;
CREATE TRIGGER trg_group_work_orders_open_needs_acceptance
  BEFORE INSERT ON public.group_work_orders
  FOR EACH ROW EXECUTE FUNCTION public.group_work_orders_open_needs_acceptance();

REVOKE ALL ON FUNCTION public.job_not_yet_accepted(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_not_yet_accepted(text, text) TO service_role;
REVOKE ALL ON FUNCTION public.work_orders_issue_needs_acceptance() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.group_work_orders_open_needs_acceptance() FROM PUBLIC, anon, authenticated;
