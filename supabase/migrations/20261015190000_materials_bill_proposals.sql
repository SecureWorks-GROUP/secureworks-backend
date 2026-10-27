-- ════════════════════════════════════════════════════════════
-- Bill pre-match: the agent's proposals for Bills to place (owner call JP-06,
-- 15 Oct 2026: "agent should be able to work it out based off job numbers on
-- the PO sheet ... otherwise intelligently worked out through the context
-- system").
--
-- 1. materials_bill_proposals: one live proposal per open supplier bill, written
--    by xero-sync's materials step (xero-sync/bill_prematch_run.ts). It lives
--    beside materials_reconciliation_queue on purpose: every sync re-upserts the
--    queue's suggestion columns with null, so a proposal kept there would be
--    wiped. Nothing here is ever wiped by the sync: a changed proposal marks the
--    old row superseded and inserts a new one.
--      proposal_kind  job | not_job_related | review (several candidates or a
--                     disagreement; nothing picked)
--      confidence     high (a job number on the bill or its PO names one live
--                     job and nothing disagrees) | medium (context signals agree
--                     on one job; not job related) | low (review)
--      outcome        assigned (the agent placed it, the same landing a staff
--                     press makes) | queued_for_review | superseded
-- 2. job_materials_facts.automation_source gains 'agent_prematch' so an agent
--    placement is traceable and reversible by deleting that one fact.
-- 3. materials_reconciliation_queue.status gains 'void_in_xero' (with
--    closed_reason) so a bill voided or deleted in Xero leaves the list.
--
-- Access: row security on, revoked from the browser roles, service role only.
-- Staff read it through ops-api materials_recon_queue (staff door).
-- Additive and idempotent. Down: supabase/rollbacks/20261015190000_materials_bill_proposals_down.sql
-- ════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.materials_bill_proposals (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  xero_invoice_id     text NOT NULL,
  queue_id            uuid REFERENCES public.materials_reconciliation_queue(id) ON DELETE SET NULL,
  invoice_number      text,
  proposal_kind       text NOT NULL,
  proposed_job_id     uuid REFERENCES public.jobs(id) ON DELETE SET NULL,
  proposed_job_number text,
  confidence          text NOT NULL,
  rule                text NOT NULL,
  reason              text NOT NULL,
  candidates          jsonb NOT NULL DEFAULT '[]'::jsonb,
  signals             jsonb NOT NULL DEFAULT '{}'::jsonb,
  input_hash          text NOT NULL,
  outcome             text NOT NULL,
  outcome_reason      text,
  auto_assigned_at    timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT materials_bill_proposals_kind_chk
    CHECK (proposal_kind IN ('job', 'not_job_related', 'review')),
  CONSTRAINT materials_bill_proposals_confidence_chk
    CHECK (confidence IN ('high', 'medium', 'low')),
  CONSTRAINT materials_bill_proposals_outcome_chk
    CHECK (outcome IN ('assigned', 'queued_for_review', 'superseded')),
  CONSTRAINT materials_bill_proposals_job_shape_chk
    CHECK ((proposal_kind = 'job') = (proposed_job_number IS NOT NULL)),
  CONSTRAINT materials_bill_proposals_candidates_array_chk
    CHECK (jsonb_typeof(candidates) = 'array'),
  CONSTRAINT materials_bill_proposals_assigned_chk
    CHECK (outcome <> 'assigned' OR (proposal_kind = 'job' AND confidence = 'high' AND auto_assigned_at IS NOT NULL))
);

-- One live proposal per bill; superseded rows are kept as history.
CREATE UNIQUE INDEX IF NOT EXISTS materials_bill_proposals_live_uidx
  ON public.materials_bill_proposals (xero_invoice_id)
  WHERE outcome <> 'superseded';
CREATE INDEX IF NOT EXISTS materials_bill_proposals_invoice_idx
  ON public.materials_bill_proposals (xero_invoice_id, created_at DESC);
CREATE INDEX IF NOT EXISTS materials_bill_proposals_queue_idx
  ON public.materials_bill_proposals (queue_id);

COMMENT ON TABLE public.materials_bill_proposals IS
  'Bill pre-match (JP-06, 15 Oct 2026): the agent''s proposal for each open Bills to place row. One live row per bill (outcome <> superseded); history kept. Written only by xero-sync bill_prematch_run.ts; read by ops-api materials_recon_queue. outcome=assigned means the agent placed it with automation_source agent_prematch on job_materials_facts.';

ALTER TABLE public.materials_bill_proposals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.materials_bill_proposals FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.materials_bill_proposals TO service_role;
DROP POLICY IF EXISTS service_role_all ON public.materials_bill_proposals;
CREATE POLICY service_role_all ON public.materials_bill_proposals
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- An agent placement is its own traceable source.
ALTER TABLE public.job_materials_facts
  DROP CONSTRAINT IF EXISTS job_materials_facts_source_chk;
ALTER TABLE public.job_materials_facts
  ADD CONSTRAINT job_materials_facts_source_chk
  CHECK (automation_source IN ('xero_ref_link', 'po_deterministic', 'manual_queue', 'agent_prematch'));

-- A bill voided or deleted in Xero leaves the list, with the reason kept.
ALTER TABLE public.materials_reconciliation_queue
  ADD COLUMN IF NOT EXISTS closed_reason text;
ALTER TABLE public.materials_reconciliation_queue
  DROP CONSTRAINT IF EXISTS materials_recon_status_chk;
ALTER TABLE public.materials_reconciliation_queue
  ADD CONSTRAINT materials_recon_status_chk
  CHECK (status IN ('open', 'assigned', 'not_job_related', 'void_in_xero'));
