// deno-lint-ignore-file no-import-prefix
//
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
// The same defect then repeated one seam later, on the same two cards. The
// ladder was fixed but the card's PRESENTATION fields (`invoice_raw_status` /
// `invoice_date` / `invoice_created_at`) still ran `allowCloseoutFromEvidence`
// on their own, so the board derived `report_ready` from the DRAFT while the
// same row served no invoice status, no invoice date and no created-at. The
// cockpit had nothing to bind an approve control to and the Captain could not
// action a card the board had already called ready. Both now read the single
// `invoiceForStage` binding, so placement and presentation cannot disagree.
//
// v7 then closed the OTHER half of the same conflation. v6 reached cycle
// attribution only through the DRAFT qualifier, so a reattend card's own
// current-cycle AUTHORISED invoice — money already committed and payable —
// reported `wrong_status` and was blanked exactly as prior-cycle money is.
// Four cards that had been sent with route proofs and billed (SWMS-26953,
// SWMS-26902, SWMS-261128, SWMS-261131) therefore sat in Trade Report In with
// the ladder holding no invoice at all. The cycle boundary is unchanged; only
// the lifecycle statuses it is applied to widen, from DRAFT to DRAFT-or-raised.
//
// The set below is the whole contract:
//   - REGRESSION: a reattend card whose DRAFT the qualifier certifies as
//     current-cycle reaches Docs Ready AND presents that DRAFT.
//   - REGRESSION: a reattend card's own current-cycle RAISED invoice does the
//     same, rather than being blanked as though it were an earlier visit's.
//   - CONTROL: a reattend card whose invoice predates the reattend boundary is
//     refused at every status and STAYS OUT. Prior-cycle commercial evidence
//     must never place a card the Captain could approve.
//   - CONTROL: a current-cycle raised invoice does not CLOSE a card on its own.
//     The close-out doc gate, send proof and 7-day clock all still apply.
//   - CONTROL: first-attendance cards are untouched.
//
// Pure derivation only. No network, no Supabase, no Xero, no money write.

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { _enrichMakesafeBoardJobForTest } from "./index.ts";
import {
  makesafeInvoiceIsCurrentAttendanceReceivable,
  qualifyMakesafeCurrentDraftInvoice,
} from "./makesafe_docs_ready_invoice.ts";

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

  // PRESENTATION: the card must serve the DRAFT it was placed by. A board that
  // derives `report_ready` from an invoice while presenting no invoice at all
  // is internally contradictory, and the cockpit cannot offer an approve
  // control against nulls. These are the exact three fields that came back null
  // on the served White Gum Valley card while Mindarie (identical but
  // first-attendance) served all three.
  assertEquals(row.invoice_raw_status, "DRAFT");
  assertEquals(row.invoice_date, "2026-08-06");
  assertEquals(row.invoice_created_at, AFTER_BOUNDARY);
});

Deno.test("presentation and placement read one binding, so they cannot disagree", () => {
  // The defect's signature was a single row asserting both "this DRAFT places
  // the card" and "this card has no invoice". Pin the implication itself rather
  // than the two values independently: any future re-split of the binding
  // reproduces the contradiction and fails here regardless of which side moved.
  for (
    const [label, inv] of [
      ["current-cycle draft", invoice("DRAFT", AFTER_BOUNDARY)],
      ["prior-cycle draft", invoice("DRAFT", BEFORE_BOUNDARY)],
      ["authorised", invoice("AUTHORISED", AFTER_BOUNDARY)],
      ["no invoice", null],
    ] as const
  ) {
    const row = enrich(inv);
    if (row.invoice_qualifies_as_current_draft === true) {
      assertEquals(
        row.invoice_raw_status,
        "DRAFT",
        `${label}: placed by a qualifying draft but presented none`,
      );
    }
  }
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

  // PRESENTATION, and the sharper half of this control. Widening presentation
  // to a certified current-cycle DRAFT must NOT leak an earlier visit's money
  // onto the card. A card showing a prior cycle's invoice as though it were
  // this attendance's is worse than the blanking bug it replaced: the Captain
  // would approve against a figure that does not belong to the work in front of
  // him. The qualifier is the only gate, and it said `prior_cycle_commercial`,
  // so all three fields stay null even though a DRAFT row exists and is linked.
  assertEquals(row.invoice_raw_status, null);
  assertEquals(row.invoice_date, null);
  assertEquals(row.invoice_created_at, null);
});

Deno.test("prior-cycle money never reaches the Captain's approve list", () => {
  // The approve control needs BOTH a Docs Ready placement and something to bind
  // to. Pin the conjunction directly: no invoice the cycle boundary refuses, and
  // no dead invoice, may produce a card that is both placed for approval and
  // presenting a figure. Asserting the two halves separately would let a future
  // change satisfy each in a different test while a real card became approvable
  // on an earlier visit's money.
  //
  // `authorised this cycle` was in this list until v7 and is NOT any more — see
  // the dedicated test below for why that case is a different fact, and note
  // that BOTH prior-cycle rows here are unchanged. The invariant this control
  // names is the cycle boundary, and the cycle boundary is what v7 left alone.
  for (
    const [label, inv] of [
      ["prior-cycle draft", invoice("DRAFT", BEFORE_BOUNDARY)],
      ["prior-cycle authorised", invoice("AUTHORISED", BEFORE_BOUNDARY)],
      ["prior-cycle paid", invoice("PAID", BEFORE_BOUNDARY)],
      ["voided", invoice("VOIDED", AFTER_BOUNDARY)],
      ["deleted", invoice("DELETED", AFTER_BOUNDARY)],
      ["another card's invoice", {
        ...invoice("AUTHORISED", AFTER_BOUNDARY),
        job_id: "job-someone-else",
      }],
      ["foreign reference", {
        ...invoice("AUTHORISED", AFTER_BOUNDARY),
        reference: "MLB-99999",
      }],
      ["payable, not receivable", {
        ...invoice("AUTHORISED", AFTER_BOUNDARY),
        invoice_type: "ACCPAY",
      }],
    ] as const
  ) {
    const row = enrich(inv);
    const approvable = row.board_stage === "report_ready" &&
      row.invoice_raw_status != null;
    assert(
      !approvable,
      `${label}: card became approvable on money the qualifier refused ` +
        `(stage=${row.board_stage}, presented=${row.invoice_raw_status}, ` +
        `reason=${row.invoice_draft_qualification_reason})`,
    );
  }
});

Deno.test("a reattend card's own current-cycle RAISED invoice places and presents", () => {
  // v7. This case used to sit inside the control above, and moving it out is the
  // one behaviour this release changes, so the argument is recorded here rather
  // than in a commit message.
  //
  // The control's stated invariant is "prior-cycle money must not place a card
  // the Captain could approve". Its fixture for this row was
  // `invoice("AUTHORISED", AFTER_BOUNDARY)` — money created AFTER the reattend
  // boundary, which by the module's own predicate
  // (`invoiceBelongsToCurrentAttendance`) is THIS attendance's money, not an
  // earlier visit's. The row was there because v6 reached cycle attribution only
  // through the DRAFT qualifier, so "not a DRAFT" and "not this cycle" were the
  // same answer; the label `authorised this cycle` in a test named
  // `prior-cycle money` is that conflation showing through.
  //
  // Separating them is not a relaxation. The cycle boundary is byte-for-byte
  // unchanged and still refuses every prior-cycle shape above. What widens is
  // only WHICH lifecycle statuses that unchanged boundary is applied to, and it
  // widens toward the STRONGER fact: an AUTHORISED invoice is money already
  // committed and payable, where a DRAFT — already admitted by v6 — is money
  // still being drafted.
  //
  // The cost of the conflation was measured, not hypothetical: SWMS-26953,
  // SWMS-26902, SWMS-261128 and SWMS-261131 had all been sent with route proofs
  // and billed with AUTHORISED current-cycle invoices, and all four sat in Trade
  // Report In because the ladder was handed no invoice at all.
  for (const status of ["AUTHORISED", "SUBMITTED", "PAID"] as const) {
    const row = enrich(invoice(status, AFTER_BOUNDARY));
    assertEquals(
      row.board_stage,
      "report_ready",
      `${status}: a sent-and-billed reattend card must not sit in Trade Report In`,
    );
    // Placement and presentation read the one `invoiceForStage` binding, so a
    // card the board places on an invoice always shows which invoice that was.
    assertEquals(row.invoice_raw_status, status);
    assertEquals(row.invoice_date, "2026-08-06");
    assertEquals(row.invoice_created_at, AFTER_BOUNDARY);
    // The DRAFT qualifier still reports `wrong_status`, and that stays accurate:
    // its question is "is this a current-cycle DRAFT", and the answer is no. The
    // presented raw status is what explains the placement.
    assertEquals(row.invoice_draft_qualification_reason, "wrong_status");
    assertEquals(row.invoice_qualifies_as_current_draft, false);
  }
});

Deno.test("a reattend card with no invoice at all stays out of Docs Ready", () => {
  const row = enrich(null);
  assertEquals(row.board_stage, "trade_report_in");
  assertEquals(row.invoice_draft_qualification_reason, "missing_invoice");
});

// ── CONTROL: closeout suppression on reattend is untouched ─────────────────

Deno.test("a PRIOR-cycle AUTHORISED invoice on a reattend card still cannot close it", () => {
  // This is what blanking the invoice existed to prevent, and it must survive:
  // an earlier visit's money may not complete/archive the current attendance.
  // The cycle boundary refuses it (`prior_cycle_commercial`), so neither the
  // DRAFT pass-through added in v6 nor the raised pass-through added in v7 can
  // reach it.
  const inv = invoice("AUTHORISED", BEFORE_BOUNDARY);
  assertEquals(
    qualifyMakesafeCurrentDraftInvoice(reattendJob(), reattendDetail(), inv)
      .reason,
    "wrong_status",
  );
  assertEquals(
    makesafeInvoiceIsCurrentAttendanceReceivable(
      reattendJob(),
      reattendDetail(),
      inv,
    ),
    false,
    "an invoice created before the reattend boundary is never current-cycle",
  );

  const row = enrich(inv);
  assert(
    row.board_stage !== "completed" && row.board_stage !== "archive",
    `reattend closeout suppression broken: derived ${row.board_stage}`,
  );
  // Prior-cycle commercial evidence is not presented either: the shared binding
  // is null, so the completion-time inputs stay suppressed.
  assertEquals(row.invoice_raw_status, null);
  assertEquals(row.invoice_date, null);
  assertEquals(row.invoice_created_at, null);
});

Deno.test("a current-cycle RAISED invoice does not close a card on its own", () => {
  // v7 widens WHICH invoice the ladder is handed. It does not widen what closing
  // a card takes. The fixture here is a live reattend card with current-cycle
  // AUTHORISED money and a rendered pack that has NOT been sent and carries no
  // close-out documents, so every downstream closeout requirement is still
  // unmet: the card must reach Docs Ready and stop there.
  //
  // Without this, "the invoice is visible again" and "the card closes" would be
  // indistinguishable, and a reattend card could complete on money alone.
  const row = enrich(invoice("AUTHORISED", AFTER_BOUNDARY));
  assert(
    row.board_stage !== "completed" && row.board_stage !== "archive",
    `a raised invoice closed a card with no send proof and no docs: ${row.board_stage}`,
  );
  assertEquals(row.board_stage, "report_ready");
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
    {
      id: "r1",
      status: "submitted",
      submitted_at: "2026-08-05T12:08:49.473+00:00",
    },
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
