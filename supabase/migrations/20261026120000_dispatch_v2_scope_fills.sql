-- Dispatch v2: the scope fill's record (Shaun, 26 Oct 2026).
--
-- A fencing job's draft list now fills itself from the fence scope the first
-- time the job is opened in Dispatch, straight into the box of the supplier
-- the scope names. This table holds one row per job, written the first time
-- its list is filled from the scope (on its own or by the Fill from the scope
-- button), so a list cleared by hand is never filled again on its own. The
-- auto fill inserts its row first as a claim: two screens never both fill.
-- Staff only, through ops-api.

CREATE TABLE IF NOT EXISTS public.dispatch_v2_scope_fills (
  job_id uuid PRIMARY KEY REFERENCES public.jobs(id) ON DELETE CASCADE,
  org_id uuid NOT NULL,
  -- true = filled on its own when the job was opened; false = the button.
  auto boolean NOT NULL,
  lines_added integer NOT NULL,
  -- The box the lines went into (empty = the draft list).
  supplier_id uuid NULL,
  -- The supplier as the scope typed it, e.g. 'RNR'.
  scope_supplier text NULL,
  filled_at timestamptz NOT NULL DEFAULT now(),
  filled_by uuid NULL,
  filled_by_email text NULL,
  CONSTRAINT dispatch_v2_scope_fills_lines_added_valid CHECK (lines_added >= 0)
);

COMMENT ON TABLE public.dispatch_v2_scope_fills IS
  'Dispatch v2: one row per job whose draft list was filled from the scope. The auto fill never runs on a job with a row. Staff only, through ops-api.';

ALTER TABLE public.dispatch_v2_scope_fills ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.dispatch_v2_scope_fills FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.dispatch_v2_scope_fills TO service_role;
