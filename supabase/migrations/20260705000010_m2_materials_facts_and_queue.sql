-- ════════════════════════════════════════════════════════════
-- M2 (profit-materials-actuals) · U3 — materials-actual FACTS + reconciliation QUEUE
--
-- Every supplier dollar lands on a job (job_materials_facts) or on a visible
-- worklist (materials_reconciliation_queue). Both tables are DERIVED, keyed by
-- xero_invoice_id (UNIQUE) so each write is idempotent on re-sync and reversible
-- by delete. Source tables (xero_invoices, trade_invoices) are NEVER mutated —
-- this is CP1 Option A (Supabase-side linking, zero new Xero objects).
--
-- Precision contract (CP2): a FACT is only written on a deterministic-unique
-- signal (reference→job, or exactly one open PO in tolerance+window). Everything
-- ambiguous is a QUEUE row. Trade-invoice MIRRORS (xero_invoice_id present in
-- trade_invoices.xero_bill_id) never produce a fact — enforced in the ingester.
--
-- M3 handoff: M3 will formalise v_job_money_facts. Its materials lane MUST source
-- from job_materials_facts (this table), NOT from xero_invoices.job_id, to avoid
-- double-counting bills that the legacy sync-time linker also stamped.
--
-- NOT AUTO-APPLIED: written as a migration file only (mission bans prod DDL).
-- Additive + idempotent (safe to re-run).
-- ════════════════════════════════════════════════════════════

-- ── 1. LANDED FACTS ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.job_materials_facts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  xero_invoice_id   text NOT NULL,                       -- source doc id (reversibility/idempotency key)
  invoice_number    text,                                -- supplier invoice number (2nd half of source_ref)
  xero_contact_id   text,
  contact_name      text,
  job_id            uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  job_number        text,
  lane              text NOT NULL DEFAULT 'materials',
  kind              text NOT NULL DEFAULT 'actual',
  amount_ex_gst     numeric NOT NULL,                    -- bill sub_total (the money fact)
  amount_inc_gst    numeric,
  confidence        text NOT NULL,
  automation_source text NOT NULL,
  matched_po_id     uuid REFERENCES public.purchase_orders(id) ON DELETE SET NULL,
  match_reason      text,
  fact_date         date,                                -- bill invoice_date (money-fact timestamp)
  assigned_by       text,                                -- NULL for auto; actor when manual_queue
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT job_materials_facts_confidence_chk
    CHECK (confidence IN ('high','medium','high_manual')),
  CONSTRAINT job_materials_facts_source_chk
    CHECK (automation_source IN ('xero_ref_link','po_deterministic','manual_queue'))
);

CREATE UNIQUE INDEX IF NOT EXISTS job_materials_facts_invoice_uidx
  ON public.job_materials_facts (xero_invoice_id);
CREATE INDEX IF NOT EXISTS job_materials_facts_job_idx
  ON public.job_materials_facts (job_id);
CREATE INDEX IF NOT EXISTS job_materials_facts_lane_idx
  ON public.job_materials_facts (org_id, lane, kind);

COMMENT ON TABLE public.job_materials_facts IS
  'M2/U3 derived materials-actual facts, one per non-mirror ACCPAY bill, keyed by xero_invoice_id. Reversible by delete; xero_invoices is never mutated. confidence: high=reference match, medium=deterministic-unique PO, high_manual=human queue accept. M3 v_job_money_facts sources materials from HERE.';

-- ── 2. RECONCILIATION QUEUE ──────────────────────────────────
CREATE TABLE IF NOT EXISTS public.materials_reconciliation_queue (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  xero_invoice_id       text NOT NULL,
  xero_contact_id       text,
  contact_name          text,
  invoice_number        text,
  sub_total             numeric,
  total                 numeric,
  invoice_date          date,
  suggested_job_id      uuid REFERENCES public.jobs(id) ON DELETE SET NULL,   -- ADVISORY ONLY
  suggested_job_number  text,
  suggestion_confidence text,
  suggestion_reason     text,
  status                text NOT NULL DEFAULT 'open',
  assigned_job_id       uuid REFERENCES public.jobs(id) ON DELETE SET NULL,   -- set by U4 on accept
  assigned_by           text,
  assigned_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT materials_recon_status_chk
    CHECK (status IN ('open','assigned','not_job_related')),
  CONSTRAINT materials_recon_suggestion_conf_chk
    CHECK (suggestion_confidence IS NULL OR suggestion_confidence IN ('low','medium'))
);

CREATE UNIQUE INDEX IF NOT EXISTS materials_recon_invoice_uidx
  ON public.materials_reconciliation_queue (xero_invoice_id);
CREATE INDEX IF NOT EXISTS materials_recon_status_idx
  ON public.materials_reconciliation_queue (org_id, status);

COMMENT ON TABLE public.materials_reconciliation_queue IS
  'M2/U3 reconciliation worklist: one row per unmatched non-mirror ACCPAY bill. suggested_job_id is advisory only (never a fact). U4 owns the accept/assign/not-job-related transitions; U3 only writes/refreshes status=open rows at ingest time (a human-touched row is never re-opened). suggestion_confidence is never high — a high-confidence signal is a fact, not a suggestion.';

-- ── 3. RLS — service_role only (matches every other backend table) ───
ALTER TABLE public.job_materials_facts ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.job_materials_facts TO service_role;
DROP POLICY IF EXISTS service_role_all ON public.job_materials_facts;
CREATE POLICY service_role_all ON public.job_materials_facts
  FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.materials_reconciliation_queue ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.materials_reconciliation_queue TO service_role;
DROP POLICY IF EXISTS service_role_all ON public.materials_reconciliation_queue;
CREATE POLICY service_role_all ON public.materials_reconciliation_queue
  FOR ALL TO service_role USING (true) WITH CHECK (true);
