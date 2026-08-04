// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _deriveMakesafeBoardStage,
  _deriveMakesafeSurfacing,
  _isMakesafeCompletedThisWeek,
  _normalizeMakesafeSubstatus,
} from "./index.ts";

Deno.test("MakeSafe board normalizes legacy pending_allocation to company_contact_required", () => {
  assertEquals(
    _normalizeMakesafeSubstatus("pending_allocation"),
    "company_contact_required",
  );
});

Deno.test("MakeSafe board: admin_to_send_report with NO draft artifacts -> trade_report_in", () => {
  // Board V2: a trade report came in (sub=admin_to_send_report) but the close-out
  // pack has not been drafted yet (no rendered report doc, no draft invoice). It
  // now sits in the new Trade Report In column, not Report Ready. (Was report_ready
  // pre-V2; this is the intended behaviour change — see T2(d).)
  const job = { status: "complete" };
  const detail = {
    substatus: "admin_to_send_report",
    report_received_at: "2026-06-07T01:00:00Z",
  };
  const report = { status: "submitted" };

  assertEquals(
    _deriveMakesafeBoardStage(job, detail, [], report, null),
    "trade_report_in",
  );
});

Deno.test("MakeSafe board: legacy ready_to_invoice with report evidence but no DRAFT -> trade_report_in", () => {
  // ready_to_invoice counts as a submitted report; with report_sent_at set this
  // job is sentClosed -> it falls through to the close-out path. Here report_sent_at
  // means the pack went out, so it must NOT re-surface as a fresh draft.
  const job = { status: "complete" };
  const detail = {
    substatus: "ready_to_invoice",
    report_received_at: "2026-06-07T01:00:00Z",
    report_sent_at: "2026-06-07T02:00:00Z",
  };
  // sentClosed (report_sent_at) -> NOT trade_report_in / report_ready as a fresh
  // surface. The shared invoice gate now forbids report_ready; the existing
  // report-in stage remains the honest actionable destination.
  assertEquals(_deriveMakesafeBoardStage(job, detail), "trade_report_in");
});

Deno.test("MakeSafe board uses New, Allocated, Report Ready, Completed This Week, Archive", () => {
  assertEquals(
    _deriveMakesafeBoardStage({ status: "accepted" }, {
      substatus: "company_contact_required",
    }),
    "new",
  );
  assertEquals(
    _deriveMakesafeBoardStage({ status: "accepted" }, {
      substatus: "company_contact_done",
    }),
    "allocated",
  );
  assertEquals(
    _deriveMakesafeBoardStage({ status: "scheduled" }, {
      substatus: "waiting_on_trade_report",
    }, [{ user_id: "u1" }]),
    "allocated",
  );
  assertEquals(
    _deriveMakesafeBoardStage(
      { status: "invoiced", completed_at: "2026-06-09T02:00:00Z" },
      { substatus: "complete" },
      [],
      null,
      { status: "AUTHORISED", invoice_date: "2026-06-09" },
      "2026-06-09T03:00:00Z",
    ),
    "completed",
  );
  assertEquals(
    _deriveMakesafeBoardStage(
      { status: "invoiced", completed_at: "2026-06-01T02:00:00Z" },
      { substatus: "complete" },
      [],
      null,
      { status: "AUTHORISED", invoice_date: "2026-06-01" },
      "2026-06-09T03:00:00Z",
    ),
    "archive",
  );
});

Deno.test("MakeSafe completed-this-week uses Perth calendar week", () => {
  assertEquals(
    _isMakesafeCompletedThisWeek(
      "2026-06-08T00:30:00Z",
      "2026-06-09T03:00:00Z",
    ),
    true,
  );
  assertEquals(
    _isMakesafeCompletedThisWeek(
      "2026-06-07T16:00:00Z",
      "2026-06-09T03:00:00Z",
    ),
    true,
  ); // Monday 8 June in Perth
  assertEquals(
    _isMakesafeCompletedThisWeek(
      "2026-06-07T14:30:00Z",
      "2026-06-09T03:00:00Z",
    ),
    false,
  ); // Sunday 7 June in Perth
});

// ════════════════════════════════════════════════════════════════════════════
// Board V2 — drafted-not-sent surfacing (T2). Fixes Ferndale; never re-surfaces
// a SENT job. Crafted inputs through _deriveMakesafeBoardStage prove each path.
// ════════════════════════════════════════════════════════════════════════════
const DOCS_REPORT_PRESENT = {
  has_invoice_doc: true,
  has_report_doc: true,
  has_swms_doc: false,
};
const NOW = "2026-06-17T03:00:00Z";

Deno.test("T2(a) Ferndale: invoiced + admin_to_send_report + DRAFT invoice + report doc + NO sent marker -> report_ready", () => {
  // status=invoiced and a DRAFT invoice would short-circuit to completed/archive
  // pre-V2 (DRAFT counts as an active invoice). It must instead surface for the
  // human to send.
  const job = {
    id: "job-ferndale",
    job_number: "SWMS-TEST-FERNDALE",
    status: "invoiced",
    completed_at: NOW,
  };
  const detail = {
    substatus: "admin_to_send_report",
    external_ref: "MLB-TEST-1",
    report_received_at: "2026-06-16T01:00:00Z",
  };
  const report = { status: "submitted" };
  const invoice = {
    job_id: "job-ferndale",
    invoice_type: "ACCREC",
    status: "DRAFT",
    reference: "MLB-TEST-1",
    invoice_date: "2026-06-16",
  };
  const pack = { status: "drafted", report_doc_id: "doc-report-1" };
  assertEquals(
    _deriveMakesafeBoardStage(
      job,
      detail,
      [],
      report,
      invoice,
      NOW,
      DOCS_REPORT_PRESENT,
      false,
      pack,
    ),
    "report_ready",
  );
});

Deno.test("T2(b) sent-but-stale via pack_sent marker + AUTHORISED invoice -> completed (NOT report_ready)", () => {
  // Tapping/Bassendean class: the pack went out (marker present, invoice
  // authorised) but the substatus lagged at admin_to_send_report. Must resolve to
  // completed/archive, never re-surface as ready-to-send.
  const job = { status: "invoiced", completed_at: NOW };
  const detail = { substatus: "admin_to_send_report" };
  const report = { status: "submitted" };
  const invoice = { status: "AUTHORISED", invoice_date: "2026-06-16" };
  const pack = { status: "sent", report_doc_id: "doc-report-1" };
  assertEquals(
    _deriveMakesafeBoardStage(
      job,
      detail,
      [],
      report,
      invoice,
      NOW,
      DOCS_REPORT_PRESENT,
      true,
      pack,
    ),
    "completed",
  );
});

Deno.test("T2(b2) sent-but-stale via detail.report_sent_at -> completed (NOT report_ready)", () => {
  const job = { status: "invoiced", completed_at: NOW };
  const detail = {
    substatus: "admin_to_send_report",
    report_sent_at: "2026-06-16T05:00:00Z",
  };
  const report = { status: "submitted" };
  const invoice = { status: "AUTHORISED", invoice_date: "2026-06-16" };
  assertEquals(
    _deriveMakesafeBoardStage(
      job,
      detail,
      [],
      report,
      invoice,
      NOW,
      DOCS_REPORT_PRESENT,
      false,
      null,
    ),
    "completed",
  );
});

Deno.test("T2(c) sent_not_closed resume -> stays completed/archive (NOT report_ready as a fresh send)", () => {
  // The pack was sent but the close (substatus=complete) failed. sentClosed is
  // true (pack.status in the sent set) so the surfacing block is skipped and the
  // doc-gate is softened -> completed/archive, never a fresh ready-to-send.
  const job = { status: "invoiced", completed_at: NOW };
  const detail = { substatus: "admin_to_send_report" };
  const report = { status: "submitted" };
  const invoice = { status: "AUTHORISED", invoice_date: "2026-06-16" };
  const pack = { status: "sent_not_closed", report_doc_id: "doc-report-1" };
  const stage = _deriveMakesafeBoardStage(
    job,
    detail,
    [],
    report,
    invoice,
    NOW,
    DOCS_REPORT_PRESENT,
    false,
    pack,
  );
  assert(
    stage === "completed" || stage === "archive",
    `sent_not_closed must be completed/archive, got ${stage}`,
  );
});

Deno.test("T2(d) report received, admin_to_send_report, NO pack row + NO draft invoice -> trade_report_in", () => {
  const job = { status: "scheduled" };
  const detail = {
    substatus: "admin_to_send_report",
    report_received_at: "2026-06-16T01:00:00Z",
  };
  const report = { status: "submitted" };
  assertEquals(
    _deriveMakesafeBoardStage(
      job,
      detail,
      [],
      report,
      null,
      NOW,
      undefined,
      false,
      null,
    ),
    "trade_report_in",
  );
});

Deno.test("T2(e) drafted job: pack row + DRAFT invoice + admin_to_send_report + not sent -> report_ready", () => {
  const job = {
    id: "job-drafted",
    job_number: "SWMS-TEST-DRAFTED",
    status: "scheduled",
  };
  const detail = {
    substatus: "admin_to_send_report",
    external_ref: "MLB-TEST-2",
    report_received_at: "2026-06-16T01:00:00Z",
  };
  const report = { status: "submitted" };
  const invoice = {
    job_id: "job-drafted",
    invoice_type: "ACCREC",
    status: "DRAFT",
    reference: "MLB-TEST-2",
    invoice_date: "2026-06-16",
  };
  const pack = { status: "drafted", report_doc_id: "doc-report-1" };
  assertEquals(
    _deriveMakesafeBoardStage(
      job,
      detail,
      [],
      report,
      invoice,
      NOW,
      DOCS_REPORT_PRESENT,
      false,
      pack,
    ),
    "report_ready",
  );
});

Deno.test("T2 authorisedAwaitingSend: AUTHORISED not-sent stays in Docs Ready (no regression)", () => {
  const job = { status: "processing", completed_at: NOW };
  const detail = {
    substatus: "admin_to_send_report",
    report_received_at: "2026-06-16T01:00:00Z",
  };
  const report = { status: "submitted" };
  const invoice = { status: "AUTHORISED", invoice_date: "2026-06-16" };
  // Durable authorised_not_sent pack: previously trade_report_in via resumeNotSent.
  assertEquals(
    _deriveMakesafeBoardStage(
      job,
      detail,
      [],
      report,
      invoice,
      NOW,
      DOCS_REPORT_PRESENT,
      false,
      { status: "authorised_not_sent", report_doc_id: "doc-report-1" },
    ),
    "report_ready",
  );
  // Re-prepare after approve (drafted pack, money already AUTHORISED, invoice
  // PDF not yet on the job): must not fall back to trade_report_in.
  assertEquals(
    _deriveMakesafeBoardStage(
      job,
      detail,
      [],
      report,
      invoice,
      NOW,
      { has_invoice_doc: false, has_report_doc: true, has_swms_doc: false },
      false,
      { status: "drafted", report_doc_id: "doc-report-1", pre_xero_docs_ready: true },
    ),
    "report_ready",
  );
});

// ── Shared predicate direct assertions (single source of truth) ──
Deno.test("_deriveMakesafeSurfacing: Ferndale shape is readyForReview, not sentClosed", () => {
  const detail = {
    substatus: "admin_to_send_report",
    report_received_at: "2026-06-16T01:00:00Z",
  };
  const surf = _deriveMakesafeSurfacing(
    {
      id: "job-ferndale",
      job_number: "SWMS-TEST-FERNDALE",
      status: "invoiced",
    },
    { ...detail, external_ref: "MLB-TEST-1" },
    { status: "submitted" },
    {
      job_id: "job-ferndale",
      invoice_type: "ACCREC",
      status: "DRAFT",
      reference: "MLB-TEST-1",
    },
    DOCS_REPORT_PRESENT,
    false,
    { status: "drafted", report_doc_id: "d1" },
  );
  assertEquals(surf.readyForReview, true);
  assertEquals(surf.sentClosed, false);
  assertEquals(surf.invoiceIsDraft, true);
  assertEquals(surf.hasReportDoc, true);
});

Deno.test("_deriveMakesafeSurfacing: a sent pack is sentClosed and NOT readyForReview", () => {
  const detail = { substatus: "admin_to_send_report" };
  const surf = _deriveMakesafeSurfacing(
    { status: "invoiced" },
    detail,
    { status: "submitted" },
    { status: "AUTHORISED" },
    DOCS_REPORT_PRESENT,
    true,
    { status: "sent", report_doc_id: "d1" },
  );
  assertEquals(surf.sentClosed, true);
  assertEquals(surf.readyForReview, false);
});

Deno.test("_deriveMakesafeSurfacing: report in, nothing drafted -> tradeReportIn", () => {
  const detail = {
    substatus: "admin_to_send_report",
    report_received_at: "2026-06-16T01:00:00Z",
  };
  const surf = _deriveMakesafeSurfacing(
    { status: "scheduled" },
    detail,
    { status: "submitted" },
    null,
    undefined,
    false,
    null,
  );
  assertEquals(surf.tradeReportIn, true);
  assertEquals(surf.readyForReview, false);
  assertEquals(surf.sentClosed, false);
});

Deno.test("_deriveMakesafeSurfacing: U4 pre-Xero docket still requires a current DRAFT", () => {
  const detail = {
    substatus: "admin_to_send_report",
    report_received_at: "2026-07-27T01:00:00Z",
  };
  const surf = _deriveMakesafeSurfacing(
    { status: "processing" },
    detail,
    { status: "submitted" },
    null,
    undefined,
    false,
    {
      status: "drafted",
      docket_revision_id: "revision-u4-1",
      pre_xero_docs_ready: true,
    },
  );
  assertEquals(surf.readyForReview, false);
  assertEquals(surf.tradeReportIn, true);
  assertEquals(surf.invoiceIsDraft, false);
  assertEquals(surf.sentClosed, false);
});

Deno.test("_deriveMakesafeSurfacing: blocked U4 docket stays Trade Report In", () => {
  const detail = {
    substatus: "admin_to_send_report",
    report_received_at: "2026-07-27T01:00:00Z",
  };
  const surf = _deriveMakesafeSurfacing(
    { status: "processing" },
    detail,
    { status: "submitted" },
    null,
    undefined,
    false,
    {
      status: "drafted",
      docket_revision_id: "revision-u4-blocked",
      pre_xero_docs_ready: false,
      blockers: [{ reason_code: "spine_missing_source" }],
    },
  );
  assertEquals(surf.readyForReview, false);
  assertEquals(surf.tradeReportIn, true);
});
