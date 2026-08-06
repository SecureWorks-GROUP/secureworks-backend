// Regression + control for the reattend Docs Ready placement defect.
//
// White Gum Valley (SWMS-261114, cycle 2) and Koondoola (SWMS-261025, cycle 4)
// each carried a rendered current-cycle pack (`pre_xero_docs_ready`), zero
// blockers, and a Xero DRAFT ACCREC correctly linked to the card at the
// Captain's own figure — and both rendered in `trade_report_in` instead of Docs
// Ready, so he could not see them to approve.
//
// The cause was NOT the invoice link. `enrichMakesafeBoardJob` blanked the
// invoice before the ladder ran whenever `allowCloseoutFromEvidence` was false,
// and that flag is a blunt `!hasReattendBoundary(detail)` — true for ANY
// reattend, saying nothing about this invoice. The per-invoice cycle answer
// already exists in the shared qualifier (`invoiceBelongsToCurrentAttendance`),
// so the cycle guard ran twice and the crude pass destroyed the precise one:
// the ladder saw no invoice, `readyForReview` could never be true, and the card
// fell through to `trade_report_in`.
//
// The pair below is the whole contract:
//   - REGRESSION: a reattend card whose DRAFT the qualifier certifies as
//     current-cycle reaches Docs Ready.
//   - CONTROL: a reattend card whose DRAFT predates the reattend boundary is
//     `prior_cycle_commercial` and STAYS OUT. Prior-cycle commercial evidence
//     must never place a card the Captain could approve.
//   - CONTROL: closeout stays suppressed on reattend — an AUTHORISED invoice on
//     a reattend card still cannot complete/archive it. That is what the
//     suppressed line exists for, and it is untouched.
//
// Pure derivation only. No network, no Supabase, no Xero, no money write.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { _enrichMakesafeBoardJobForTest } from "./index.ts";
import { qualifyMakesafeCurrentDraftInvoice } from "./makesafe_docs_ready_invoice.ts";

const REATTEND_BOUNDARY = "2026-08-03T13:37:52.648+00:00";
/** After the boundary — the current attendance's own commercial evidence. */
const AFTER_BOUNDARY = "2026-08-06T04:16:40.763+00:00";
/** Before it — an earlier visit's draft, which must never place the card. */
const BEFORE_BOUNDARY = "2026-08-01T09:00:00.000+00:00";

/** White Gum Valley's shape: cycle 2, trade report in, pack rendered. */
function reattendJob() {
  return {
    id: "job-wgv",
    job_number: "SWMS-261114",
    status: "accepted",
    created_at: "2026-07-31T01:01:10.008+00:00",
    metadata: {},
  };
}

function reattendDetail() {
  return {
    substatus: "admin_to_send_report",
    external_ref: "RR-26836",
    reattend_count: 1,
    last_reattend_at: REATTEND_BOUNDARY,
    attendance_cycle_id: "cycle-2",
    cycle_number: 2,
    report_type: "roof",
  };
}

/** The current-cycle service report the trade submitted after the reattend. */
const CURRENT_REPORT = {
  id: "report-2",
  status: "submitted",
  submitted_at: "2026-08-06T00:28:16.293+00:00",
  attendance_cycle_id: "cycle-2",
  cycle_number: 2,
};

/** A U4 docket that assembled clean: `pre_xero_docs_ready`, bound to the cycle. */
const READY_PACK = {
  id: "pack-1",
  status: "drafted",
  report_doc_id: null,
  pre_xero_docs_ready: true,
  cycle_attribution: "bound",
  docket_revision_id: "rev-1",
};

function invoice(status: string, createdAt: string) {
  return {
    id: "inv-1149",
    job_id: "job-wgv",
    invoice_number: "INV-1149",
    invoice_type: "ACCREC",
    status,
    reference: "RR-26836",
    total: 330,
    invoice_date: "2026-08-06",
    created_at: createdAt,
  };
}

function enrich(inv: unknown) {
  return _enrichMakesafeBoardJobForTest(
    reattendJob(),
    reattendDetail(),
    [],
    CURRENT_REPORT,
    inv,
    [],
    false,
    READY_PACK,
  );
}

// ── REGRESSION ─────────────────────────────────────────────────────────────

Deno.test("a reattend card with a qualifying current-cycle DRAFT renders in Docs Ready", () => {
  const inv = invoice("DRAFT", AFTER_BOUNDARY);

  // The shared qualifier is the authority on whether this draft is current, and
  // it already said yes on production. Pin that first so a later change to the
  // qualifier cannot make this test pass for the wrong reason.
  assertEquals(
    qualifyMakesafeCurrentDraftInvoice(reattendJob(), reattendDetail(), inv),
    { qualifies: true, reason: "qualifying_draft" },
  );

  const row = enrich(inv);
  assertEquals(row.board_stage, "report_ready");
  assertEquals(row.invoice_qualifies_as_current_draft, true);
  assertEquals(row.invoice_draft_qualification_reason, "qualifying_draft");

  // The commercial warning is honest and STAYS: this is still a reattend, and
  // the card is placed by its current-cycle draft, not by closing the cycle.
  assert(
    (row.cycle_attribution_flags ?? []).includes("commercial_from_prior_cycle"),
  );
});

// ── CONTROL: a prior-cycle draft must not place the card ───────────────────

Deno.test("a reattend card whose DRAFT predates the boundary stays out of Docs Ready", () => {
  const inv = invoice("DRAFT", BEFORE_BOUNDARY);

  assertEquals(
    qualifyMakesafeCurrentDraftInvoice(reattendJob(), reattendDetail(), inv),
    { qualifies: false, reason: "prior_cycle_commercial" },
  );

  const row = enrich(inv);
  assertEquals(row.board_stage, "trade_report_in");
  assertEquals(row.invoice_qualifies_as_current_draft, false);
});

Deno.test("a reattend card with no invoice at all stays out of Docs Ready", () => {
  const row = enrich(null);
  assertEquals(row.board_stage, "trade_report_in");
  assertEquals(row.invoice_draft_qualification_reason, "missing_invoice");
});

// ── CONTROL: closeout suppression on reattend is untouched ─────────────────

Deno.test("an AUTHORISED invoice on a reattend card still cannot close it", () => {
  // This is what blanking the invoice existed to prevent, and it must survive:
  // prior-cycle money may not complete/archive the current attendance. The
  // qualifier refuses a non-DRAFT (`wrong_status`), so the pass-through added
  // for the DRAFT case can never reach a raised invoice.
  const inv = invoice("AUTHORISED", AFTER_BOUNDARY);
  assertEquals(
    qualifyMakesafeCurrentDraftInvoice(reattendJob(), reattendDetail(), inv)
      .reason,
    "wrong_status",
  );

  const row = enrich(inv);
  assert(
    row.board_stage !== "completed" && row.board_stage !== "archive",
    `reattend closeout suppression broken: derived ${row.board_stage}`,
  );
  // The completion-time inputs stay suppressed on reattend — this fix does not
  // touch them.
  assertEquals(row.invoice_raw_status, null);
  assertEquals(row.invoice_created_at, null);
});

// ── CONTROL: first-attendance cards are completely unaffected ──────────────

Deno.test("a first-attendance card behaves exactly as before", () => {
  const detail = {
    substatus: "admin_to_send_report",
    external_ref: "MLB-27482",
    reattend_count: 0,
    last_reattend_at: null,
    attendance_cycle_id: "cycle-1",
    cycle_number: 1,
  };
  const job = {
    id: "job-mp",
    job_number: "SWMS-261147",
    status: "processing",
    created_at: "2026-08-05T08:05:06.244+00:00",
    metadata: {},
  };
  const inv = {
    id: "inv-1147",
    job_id: "job-mp",
    invoice_number: "INV-1147",
    invoice_type: "ACCREC",
    status: "DRAFT",
    reference: "MLB-27482",
    total: 885.5,
    invoice_date: "2026-08-06",
    created_at: "2026-08-06T01:40:11.160+00:00",
  };
  const row = _enrichMakesafeBoardJobForTest(
    job,
    detail,
    [],
    { id: "r1", status: "submitted", submitted_at: "2026-08-05T12:08:49.473+00:00" },
    inv,
    [],
    false,
    READY_PACK,
  );
  assertEquals(row.board_stage, "report_ready");
  // Closeout evidence is allowed on a first attendance, so the completion-time
  // inputs are populated — the branch this fix did not enter.
  assertEquals(row.invoice_raw_status, "DRAFT");
  assertEquals(row.commercial_warning, null);
});
