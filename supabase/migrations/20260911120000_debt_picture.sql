-- ════════════════════════════════════════════════════════════
-- Debt picture: the fields the Clear Debt screen needs, on the invoice row.
-- Design: secureworks-wiki coding/work/campaigns/ceo-ops/lanes/DEBT_COLLECTION/DESIGN-clear-debt-2026-09-11.md
-- Accepted by Marnin 11 Sep 2026 15:05 Perth. Add-only, backward compatible.
--
-- Adds to xero_invoices:
--   not_owed as a sixth debt_classification value
--   debt_type       what kind of money (from the invoice reference code)
--   debt_blocker    what stops the money when blocked_by_us or unclassified
--   debt_owner      whose move
--   debt_next_action, debt_next_action_at
--   debt_void_proposed, debt_void_decision, debt_void_decided_at
--   debt_handoff_ref, debt_handoff_at
--   debt_source     where the class came from (curated, rule, note, card)
--   debt_as_of      when the refresh last confirmed the row
--   debt_brief      the four-line "where this stands" with its sources
--   debt_proposal_* the pending text or email draft and its approval
-- Adds to payment_chase_logs.method: classification, proposal
-- ════════════════════════════════════════════════════════════

-- 1. Class: add not_owed
ALTER TABLE xero_invoices DROP CONSTRAINT IF EXISTS xero_invoices_debt_classification_check;
ALTER TABLE xero_invoices ADD CONSTRAINT xero_invoices_debt_classification_check
  CHECK (debt_classification IN ('unclassified','genuine_debt','blocked_by_us','in_dispute','bad_debt','not_owed'));

-- 2. Type of debt (sub-kind inside chase now / not yet due), from the reference code
ALTER TABLE xero_invoices ADD COLUMN IF NOT EXISTS debt_type text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'xero_invoices_debt_type_check') THEN
    ALTER TABLE xero_invoices ADD CONSTRAINT xero_invoices_debt_type_check
      CHECK (debt_type IS NULL OR debt_type IN ('deposit','final_balance','progress_claim','variation','plan_fee','work_order','job_invoice','no_reference'));
  END IF;
END $$;

-- 3. Blocker and owner
ALTER TABLE xero_invoices ADD COLUMN IF NOT EXISTS debt_blocker text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'xero_invoices_debt_blocker_check') THEN
    ALTER TABLE xero_invoices ADD CONSTRAINT xero_invoices_debt_blocker_check
      CHECK (debt_blocker IS NULL OR debt_blocker IN ('paid_unallocated','payment_claimed','rectification','pack_missing','invoice_wrong','no_job_linked','job_link_ambiguous','context_pending'));
  END IF;
END $$;
ALTER TABLE xero_invoices ADD COLUMN IF NOT EXISTS debt_owner text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'xero_invoices_debt_owner_check') THEN
    ALTER TABLE xero_invoices ADD CONSTRAINT xero_invoices_debt_owner_check
      CHECK (debt_owner IS NULL OR debt_owner IN ('DEBT','BOOKKEEPING','OPERATIONS','INSURANCE','FENCING_SALES','PATIO_SALES','MARNIN','CIO'));
  END IF;
END $$;

-- 4. Next action, void proposal, handoff, provenance, as-of
ALTER TABLE xero_invoices ADD COLUMN IF NOT EXISTS debt_next_action text;
ALTER TABLE xero_invoices ADD COLUMN IF NOT EXISTS debt_next_action_at date;
ALTER TABLE xero_invoices ADD COLUMN IF NOT EXISTS debt_void_proposed boolean NOT NULL DEFAULT false;
ALTER TABLE xero_invoices ADD COLUMN IF NOT EXISTS debt_void_decision text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'xero_invoices_debt_void_decision_check') THEN
    ALTER TABLE xero_invoices ADD CONSTRAINT xero_invoices_debt_void_decision_check
      CHECK (debt_void_decision IS NULL OR debt_void_decision IN ('yes','no'));
  END IF;
END $$;
ALTER TABLE xero_invoices ADD COLUMN IF NOT EXISTS debt_void_decided_at timestamptz;
ALTER TABLE xero_invoices ADD COLUMN IF NOT EXISTS debt_handoff_ref text;
ALTER TABLE xero_invoices ADD COLUMN IF NOT EXISTS debt_handoff_at date;
ALTER TABLE xero_invoices ADD COLUMN IF NOT EXISTS debt_source text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'xero_invoices_debt_source_check') THEN
    ALTER TABLE xero_invoices ADD CONSTRAINT xero_invoices_debt_source_check
      CHECK (debt_source IS NULL OR debt_source IN ('curated','rule','note','card','button'));
  END IF;
END $$;
ALTER TABLE xero_invoices ADD COLUMN IF NOT EXISTS debt_as_of timestamptz;

-- 5. Where this stands: four lines with their sources
ALTER TABLE xero_invoices ADD COLUMN IF NOT EXISTS debt_brief jsonb;
COMMENT ON COLUMN xero_invoices.debt_brief IS 'Where this stands: {promised, delivered, client_says, our_side, evidence:[{label, kind, source_table, source_id}]}. Written by secureworks-debt-live from door facts plus the desk decision; the screen reads, never writes.';

-- 6. Pending proposal (text or email draft) and its approval
ALTER TABLE xero_invoices ADD COLUMN IF NOT EXISTS debt_proposal_kind text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'xero_invoices_debt_proposal_kind_check') THEN
    ALTER TABLE xero_invoices ADD CONSTRAINT xero_invoices_debt_proposal_kind_check
      CHECK (debt_proposal_kind IS NULL OR debt_proposal_kind IN ('sms','email','statement'));
  END IF;
END $$;
ALTER TABLE xero_invoices ADD COLUMN IF NOT EXISTS debt_proposal_text text;
ALTER TABLE xero_invoices ADD COLUMN IF NOT EXISTS debt_proposal_to text;
ALTER TABLE xero_invoices ADD COLUMN IF NOT EXISTS debt_proposal_at timestamptz;
ALTER TABLE xero_invoices ADD COLUMN IF NOT EXISTS debt_proposal_status text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'xero_invoices_debt_proposal_status_check') THEN
    ALTER TABLE xero_invoices ADD CONSTRAINT xero_invoices_debt_proposal_status_check
      CHECK (debt_proposal_status IS NULL OR debt_proposal_status IN ('pending','approved','sent','declined','expired'));
  END IF;
END $$;
ALTER TABLE xero_invoices ADD COLUMN IF NOT EXISTS debt_proposal_approved_by text;
ALTER TABLE xero_invoices ADD COLUMN IF NOT EXISTS debt_proposal_approved_at timestamptz;
ALTER TABLE xero_invoices ADD COLUMN IF NOT EXISTS debt_proposal_sent_ref text;

-- 7. Chase log methods for classification changes and proposal events
ALTER TABLE payment_chase_logs DROP CONSTRAINT IF EXISTS payment_chase_logs_method_check;
ALTER TABLE payment_chase_logs ADD CONSTRAINT payment_chase_logs_method_check
  CHECK (method IN ('call','sms','auto_sms','email','note','status_change','personality_note','classification','proposal'));

COMMENT ON COLUMN xero_invoices.debt_source IS 'curated = desk decision, rule = classifier default, note = a note directive applied by the refresh, card = edited on the screen, button = the old classify button.';
COMMENT ON COLUMN xero_invoices.debt_as_of IS 'When secureworks-debt-live last confirmed this row. Rows older than 7 days show grey on the screen.';
