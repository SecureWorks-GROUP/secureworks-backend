-- T7 Loop 1 — Optional spine_event_id backrefs on high-traffic source tables (DRAFT — NOT YET APPLIED)
--
-- Status: draft only. Apply only after explicit user approval naming this
-- migration ("apply 20260502000005_spine_backref.sql"). Apply in Loop 2.
--
-- Roadmap: cio/operations/2026-05-02-t7-evidence-capture-spine-roadmap.md (Section 8 — backref hygiene)
--
-- Why:
-- The spine envelope (20260502000001) adds (source_table, source_id) so a
-- spine row can point back at its source. This migration adds the reverse
-- pointer on the highest-traffic source tables so a dossier query can go
-- either direction without scanning JSON payloads.
--
-- Tables touched (each adds nullable spine_event_id):
--   - inbox_events
--   - email_events
--   - job_events
--   - xero_invoices
--
-- All adds are nullable. Existing rows are unaffected. recordEvidence
-- writes the backref after the spine insert succeeds.
--
-- purchase_orders is intentionally excluded for now: a PO has multiple
-- spine rows over its lifetime (po.created, po.sent, po.confirmed, etc.)
-- so a single spine_event_id column is the wrong shape. The (source_table,
-- source_id) index on business_events is sufficient to recover the full
-- lifecycle from the spine side.
--
-- Rollback:
--   ALTER TABLE public.inbox_events    DROP COLUMN IF EXISTS spine_event_id;
--   ALTER TABLE public.email_events    DROP COLUMN IF EXISTS spine_event_id;
--   ALTER TABLE public.job_events      DROP COLUMN IF EXISTS spine_event_id;
--   ALTER TABLE public.xero_invoices   DROP COLUMN IF EXISTS spine_event_id;
--   DROP INDEX IF EXISTS idx_inbox_events_spine;
--   DROP INDEX IF EXISTS idx_email_events_spine;
--   DROP INDEX IF EXISTS idx_job_events_spine;
--   DROP INDEX IF EXISTS idx_xero_invoices_spine;
--   Time-to-revert: <2s. Columns are additive nullable; no constraint depends on them.
--
-- Downstream impact:
--   None until Loop 3-5 writers begin populating the column. Reads from
--   these tables continue to ignore the new column.

BEGIN;

ALTER TABLE public.inbox_events
  ADD COLUMN IF NOT EXISTS spine_event_id uuid;

ALTER TABLE public.email_events
  ADD COLUMN IF NOT EXISTS spine_event_id uuid;

ALTER TABLE public.job_events
  ADD COLUMN IF NOT EXISTS spine_event_id uuid;

ALTER TABLE public.xero_invoices
  ADD COLUMN IF NOT EXISTS spine_event_id uuid;

CREATE INDEX IF NOT EXISTS idx_inbox_events_spine
  ON public.inbox_events(spine_event_id) WHERE spine_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_events_spine
  ON public.email_events(spine_event_id) WHERE spine_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_job_events_spine
  ON public.job_events(spine_event_id) WHERE spine_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_xero_invoices_spine
  ON public.xero_invoices(spine_event_id) WHERE spine_event_id IS NOT NULL;

COMMENT ON COLUMN public.inbox_events.spine_event_id IS
  'T7 backref: business_events.id of the spine row this inbox event produced via recordEvidence.';
COMMENT ON COLUMN public.email_events.spine_event_id IS
  'T7 backref: business_events.id of the spine row this email_events row produced via recordEvidence.';
COMMENT ON COLUMN public.job_events.spine_event_id IS
  'T7 backref: business_events.id of the spine row this job_events row produced via recordEvidence (when dual-written).';
COMMENT ON COLUMN public.xero_invoices.spine_event_id IS
  'T7 backref: business_events.id of the spine row for the most recent invoice.* event on this row. Updated by recordEvidence on each lifecycle event.';

COMMIT;
