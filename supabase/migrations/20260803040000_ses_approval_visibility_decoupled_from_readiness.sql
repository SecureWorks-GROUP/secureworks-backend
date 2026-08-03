-- SES: decouple approval VISIBILITY from readiness.
--
-- Captain's decision date: 2026-08-03 ("approval visibility must not depend on
-- readiness; readiness stays visible as information, never a gate"), extending
-- the #511 ruling line (20260803010000 invoice-obligation path, 20260803020000
-- approval path, 20260803030000 send path) to the last readiness gate standing
-- on the execution paths: the `makesafe_revision_approvals_current_v2` view.
--
-- Read 20260803010000's header first for the full diagnosis of why
-- `makesafe_readiness_current.ready` can never become true (Phase 1 shipped the
-- compare-only shadow and its invalidator; the Phase 2 producer that would
-- commit the first READY revision was never built; measured read-only against
-- production on 2026-08-03: 191 readiness rows, ZERO ready, ZERO rows in
-- `makesafe_readiness_revisions`).
--
-- WHY THE VIEW IS A GATE AT ALL
-- -----------------------------
-- The view (20260728020000, lines 449-459) filters approvals through
-- `makesafe_readiness_current_v2` twice over:
--
--   * `WHERE readiness.ready = true` -- the same unsatisfiable test the ruling
--     removed from all three function gates. No row on the board has ever had
--     ready = true, so the view has never returned a row.
--   * `JOIN ... ON readiness.readiness_revision = approval.readiness_revision`
--     -- NULL-unsafe. Every approval recorded under the 2026-08-03 rulings
--     carries a NULL readiness_revision (the honest record of "no certified
--     readiness revision exists"), and NULL never satisfies `=` in a join, so
--     even a hypothetical ready row could not make those approvals visible.
--
-- The effect: an operator can press APPROVE INVOICE or SEND IT and have the
-- decision durably recorded (20260803020000 delivered that), yet every
-- execution path still refuses, because each one consults this view for
-- approval visibility and the view admits nothing.
--
-- CONSUMER CENSUS (repo-wide, 2026-08-03)
-- ---------------------------------------
-- Every reader of the view, and what it actually relies on:
--
--   1. `begin_ses_invoice_execution_v1` (effective body: 20260728020000) --
--      SELECT * filtered by action, job, the EXACT
--      invoice_obligation_revision_id being executed and the exact
--      approval_content_hash, latest first; freshness is then enforced
--      IN-FUNCTION by the verbatim concurrency check on the approval's
--      readiness_revision / dependency_generation against the current
--      readiness row.
--   2. `begin_ses_release_execution_v1` (effective body: 20260803030000) --
--      PERFORM 1 filtered by action, the EXACT release_revision_id, job and
--      content hash; freshness is enforced IN-FUNCTION by the verbatim
--      per-member binding check against the current readiness row.
--   3. ops-api `currentInvoiceApproval` (ses_reporting_actions.ts) -- select *
--      by action and the EXACT obligation revision id, latest first; freshness
--      is then enforced at application level by comparing the approval's
--      readiness_revision / dependency_generation / docket_revision_id against
--      the live cockpit read, and by recomputing the approval_content_hash
--      from the current cockpit state.
--   4. ops-api release double-check in `executeSesReleaseRevisionAction`
--      (ses_reporting_actions.ts) -- select id, approval_content_hash by
--      action, the EXACT release revision id and job, and requires the
--      approval's content hash to equal the release revision's content hash.
--
-- Plus one test double keyed by the view name
-- (sealed_ses_money_fence_test.ts). NO consumer -- execution path, reporting
-- query, or cockpit read -- legitimately needs the readiness filter: every
-- consumer matches the approval's OWN revision reference exactly, and every
-- consumer's freshness semantics are carried by the concurrency checks the
-- ruling keeps verbatim, not by the view's join.
--
-- DESIGN CHOICE: REPLACE v2 IN PLACE, NOT A NEW v3
-- ------------------------------------------------
-- The census is what authorises this: with no consumer that needs the
-- readiness filter, a parallel v3 would buy nothing -- it would force
-- view-name-only edits to two function bodies, two ops-api reads and a test
-- double, and it would leave behind a permanently-empty view named "current"
-- as a trap for the next reader. This repo already redefines this exact view
-- in place across migrations (20260728000001 created it; 20260728020000
-- re-created it), and CREATE OR REPLACE VIEW preserves the column list and
-- grants, so no consumer changes at all.
--
-- The corrected semantics are exactly `decision = 'approved'`. Currency is NOT
-- re-encoded in the view: the approval's own revision reference
-- (invoice_obligation_revision_id / release_revision_id / docket_revision_id)
-- is matched exactly by every consumer, and new-evidence freshness stays where
-- the ruling put it -- in the verbatim concurrency checks enumerated above.
-- Readiness is carried as INFORMATION nowhere in this view, for a structural
-- reason: consumer (1) does `SELECT * INTO` a
-- `makesafe_revision_approvals%ROWTYPE` record, so the view must return
-- exactly the base table's columns; adding informational readiness columns
-- would break that function, which this ruling does not touch. Readiness
-- remains visible as information through `makesafe_readiness_current_v2`,
-- which is untouched.
--
-- WHAT THIS DOES, AND DELIBERATELY DOES NOT DO
-- --------------------------------------------
-- It removes the readiness gate from approval VISIBILITY. It does NOT assert
-- readiness (nothing here writes `ready`, and the view reads no readiness
-- table at all anymore), and it does NOT weaken any freshness check: the
-- in-function and application-level concurrency checks listed above are
-- byte-for-byte untouched and remain the mechanism that refuses a stale
-- approval.
--
-- NOT TOUCHED by this migration, and not authorised by the ruling:
--   * the money seal (`jobs.ses_money_sealed_at`) and its fence;
--   * the human APPROVE INVOICE / SEND IT gates in `ses_reporting_actions.ts`
--     (`operatorAuth.mode == 'jwt'` AND `auth.user`);
--   * both execution function bodies -- they read the view by name and their
--     text is unchanged, including every concurrency check;
--   * `record_ses_revision_approval_v1` and the
--     `makesafe_revision_approvals.readiness_revision IS NULL`-admitting
--     column contract from 20260803020000;
--   * the readiness tables, `makesafe_readiness_current_v2`, the invalidator,
--     and all readiness recording behaviour -- readiness stays visible as
--     information, never a gate;
--   * the SES release allowlist, the mechanically-clean requirement, and the
--     Captain-override authority tests.
--
-- HOW TO RESTORE THE GATE
-- -----------------------
-- supabase/rollbacks/20260803040000_..._down.sql restores the exact
-- pre-existing view definition. Restore it once, and only once, a Phase-2
-- readiness producer can legitimately commit a READY readiness revision
-- without a caller asserting one; until then the restored view returns zero
-- rows and both execution paths refuse every approval on the board.
--
-- This migration writes ZERO rows. It replaces one view definition.

CREATE OR REPLACE VIEW public.makesafe_revision_approvals_current_v2
WITH (security_invoker = true)
AS
SELECT approval.*
FROM public.makesafe_revision_approvals approval
WHERE approval.decision = 'approved';

-- Grants are unchanged by CREATE OR REPLACE, but restated so a fresh
-- migration-provisioned database that somehow replays only this file still
-- lands on the same closed boundary as 20260728000001.
REVOKE ALL ON public.makesafe_revision_approvals_current_v2
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.makesafe_revision_approvals_current_v2 TO service_role;

COMMENT ON VIEW public.makesafe_revision_approvals_current_v2 IS
  'Approved SES revision decisions, visible regardless of readiness. Captain '
  'ruling 2026-08-03 (extending #511): approval visibility must not depend on '
  'readiness -- the previous definition filtered through '
  'makesafe_readiness_current_v2 with ready = true plus a NULL-unsafe '
  'readiness_revision join, so no approval recorded under the 2026-08-03 '
  'rulings could ever appear. Freshness is enforced by the unchanged '
  'concurrency checks on the execution paths, not by this view. Readiness '
  'stays visible as information in makesafe_readiness_current_v2, never a '
  'gate here.';
