-- JP-24 slice 1: record, on each sent quote, which frozen scope revision it was
-- sent from.
--
-- One nullable column on quote_revisions, pointing at scope_revisions(id):
--
--   scope_revision_id  the job's single current frozen scope_revisions row,
--                      stored at send only when BOTH its scope_hash and its
--                      pricing_hash equal canonicalJsonAndHash of the job's
--                      current jobs.scope_json and jobs.pricing_json (the
--                      function freeze_scope hashes with). Null otherwise.
--
-- Null means unknown, never "no revision": a save after the last freeze, no
-- frozen row, several frozen rows or a failed read all store null. There is no
-- backfill. Every row written before this migration stays null (unknown), on
-- purpose: an old send's scope at the moment it left cannot be re-proved now.
--
-- Writers: send-quote recordReleasedQuoteRevision (/send, /send-runs) and the
-- ops-api quick-quote copy (send_quick_quote_email), through the one rule in
-- supabase/functions/_shared/scope_freeze/quote_scope_revision_link.ts. The
-- lookup never blocks or changes a customer send.
-- Reader: Job Profit revision acceptance (job_profit_revision_binding.ts), which
-- reads a missing column or a null as unknown.
--
-- Immutability: today's writers INSERT every row with sent_at already set, and
-- quote_revisions_controlled_immutable() refuses every UPDATE of a row whose
-- sent_at is set, so the link can never change after the send. That trigger is
-- not replaced here.
--
-- Access: no grant, policy or RLS change. quote_revisions keeps RLS on with no
-- policies (service role only); the new column takes the table's privileges and
-- has no column-level grant.
--
-- ON DELETE RESTRICT mirrors quote_revisions' other references and
-- scope_revisions' own; scope_revisions rows are never deleted.
--
-- Order: apply this BEFORE the matching send-quote and ops-api (both INSERT the
-- column; scripts/edge-function-schema-requirements.txt holds them back).
-- Rollback: supabase/rollbacks/20261029123500_quote_revisions_scope_revision_link_down.sql.

ALTER TABLE public.quote_revisions
  ADD COLUMN IF NOT EXISTS scope_revision_id uuid NULL
    CONSTRAINT quote_revisions_scope_revision_id_fkey
    REFERENCES public.scope_revisions(id) ON DELETE RESTRICT;

COMMENT ON COLUMN public.quote_revisions.scope_revision_id IS
  'JP-24 slice 1. The frozen scope_revisions row this quote was sent from, stored at send only when both its scope_hash and pricing_hash equal canonicalJsonAndHash of the job''s current jobs.scope_json and jobs.pricing_json. NULL = unknown (mismatch, no or several frozen rows, failed read, or a row written before 20261029123500). Never backfilled.';
