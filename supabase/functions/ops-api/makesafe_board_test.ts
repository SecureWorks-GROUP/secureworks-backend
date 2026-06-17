import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _deriveMakesafeBoardStage,
  _deriveMakesafeSurfacing,
  _normalizeMakesafeSubstatus,
  _isMakesafeCompletedThisWeek,
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

Deno.test("MakeSafe board: legacy ready_to_invoice with no draft artifacts -> trade_report_in (report received, not drafted)", () => {
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
  // surface. With no invoice + no docs supplied it falls to the legacy
  // report_ready completion fallback (hasSubmittedReport && jobStatus complete).
  assertEquals(_deriveMakesafeBoardStage(job, detail), "report_ready");
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
  assertEquals(_isMakesafeCompletedThisWeek("2026-06-08T00:30:00Z", "2026-06-09T03:00:00Z"), true);
  assertEquals(_isMakesafeCompletedThisWeek("2026-06-07T16:00:00Z", "2026-06-09T03:00:00Z"), true); // Monday 8 June in Perth
  assertEquals(_isMakesafeCompletedThisWeek("2026-06-07T14:30:00Z", "2026-06-09T03:00:00Z"), false); // Sunday 7 June in Perth
});

// ════════════════════════════════════════════════════════════════════════════
// Board V2 — drafted-not-sent surfacing (T2). Fixes Ferndale; never re-surfaces
// a SENT job. Crafted inputs through _deriveMakesafeBoardStage prove each path.
// ════════════════════════════════════════════════════════════════════════════
const DOCS_REPORT_PRESENT = { has_invoice_doc: true, has_report_doc: true, has_swms_doc: false };
const NOW = "2026-06-17T03:00:00Z";

Deno.test("T2(a) Ferndale: invoiced + admin_to_send_report + DRAFT invoice + report doc + NO sent marker -> report_ready", () => {
  // status=invoiced and a DRAFT invoice would short-circuit to completed/archive
  // pre-V2 (DRAFT counts as an active invoice). It must instead surface for the
  // human to send.
  const job = { status: "invoiced", completed_at: NOW };
  const detail = { substatus: "admin_to_send_report", report_received_at: "2026-06-16T01:00:00Z" };
  const report = { status: "submitted" };
  const invoice = { status: "DRAFT", invoice_date: "2026-06-16" };
  const pack = { status: "drafted", report_doc_id: "doc-report-1" };
  assertEquals(
    _deriveMakesafeBoardStage(job, detail, [], report, invoice, NOW, DOCS_REPORT_PRESENT, false, pack),
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
    _deriveMakesafeBoardStage(job, detail, [], report, invoice, NOW, DOCS_REPORT_PRESENT, true, pack),
    "completed",
  );
});

Deno.test("T2(b2) sent-but-stale via detail.report_sent_at -> completed (NOT report_ready)", () => {
  const job = { status: "invoiced", completed_at: NOW };
  const detail = { substatus: "admin_to_send_report", report_sent_at: "2026-06-16T05:00:00Z" };
  const report = { status: "submitted" };
  const invoice = { status: "AUTHORISED", invoice_date: "2026-06-16" };
  assertEquals(
    _deriveMakesafeBoardStage(job, detail, [], report, invoice, NOW, DOCS_REPORT_PRESENT, false, null),
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
  const stage = _deriveMakesafeBoardStage(job, detail, [], report, invoice, NOW, DOCS_REPORT_PRESENT, false, pack);
  assert(stage === "completed" || stage === "archive", `sent_not_closed must be completed/archive, got ${stage}`);
  assert(stage !== "report_ready", "sent_not_closed must NOT re-surface as report_ready");
});

Deno.test("T2(d) report received, admin_to_send_report, NO pack row + NO draft invoice -> trade_report_in", () => {
  const job = { status: "scheduled" };
  const detail = { substatus: "admin_to_send_report", report_received_at: "2026-06-16T01:00:00Z" };
  const report = { status: "submitted" };
  assertEquals(
    _deriveMakesafeBoardStage(job, detail, [], report, null, NOW, undefined, false, null),
    "trade_report_in",
  );
});

Deno.test("T2(e) drafted job: pack row + DRAFT invoice + admin_to_send_report + not sent -> report_ready", () => {
  const job = { status: "scheduled" };
  const detail = { substatus: "admin_to_send_report", report_received_at: "2026-06-16T01:00:00Z" };
  const report = { status: "submitted" };
  const invoice = { status: "DRAFT", invoice_date: "2026-06-16" };
  const pack = { status: "drafted", report_doc_id: "doc-report-1" };
  assertEquals(
    _deriveMakesafeBoardStage(job, detail, [], report, invoice, NOW, DOCS_REPORT_PRESENT, false, pack),
    "report_ready",
  );
});

Deno.test("T2 resumeNotSent: authorised_not_sent pack + AUTHORISED invoice -> report_ready (a resume, never re-send)", () => {
  const job = { status: "invoiced", completed_at: NOW };
  const detail = { substatus: "admin_to_send_report" };
  const report = { status: "submitted" };
  const invoice = { status: "AUTHORISED", invoice_date: "2026-06-16" };
  const pack = { status: "authorised_not_sent", report_doc_id: "doc-report-1" };
  assertEquals(
    _deriveMakesafeBoardStage(job, detail, [], report, invoice, NOW, DOCS_REPORT_PRESENT, false, pack),
    "report_ready",
  );
});

// ── Shared predicate direct assertions (single source of truth) ──
Deno.test("_deriveMakesafeSurfacing: Ferndale shape is readyForReview, not sentClosed", () => {
  const detail = { substatus: "admin_to_send_report", report_received_at: "2026-06-16T01:00:00Z" };
  const surf = _deriveMakesafeSurfacing(
    { status: "invoiced" }, detail, { status: "submitted" },
    { status: "DRAFT" }, DOCS_REPORT_PRESENT, false, { status: "drafted", report_doc_id: "d1" },
  );
  assertEquals(surf.readyForReview, true);
  assertEquals(surf.sentClosed, false);
  assertEquals(surf.invoiceIsDraft, true);
  assertEquals(surf.hasReportDoc, true);
});

Deno.test("_deriveMakesafeSurfacing: a sent pack is sentClosed and NOT readyForReview", () => {
  const detail = { substatus: "admin_to_send_report" };
  const surf = _deriveMakesafeSurfacing(
    { status: "invoiced" }, detail, { status: "submitted" },
    { status: "AUTHORISED" }, DOCS_REPORT_PRESENT, true, { status: "sent", report_doc_id: "d1" },
  );
  assertEquals(surf.sentClosed, true);
  assertEquals(surf.readyForReview, false);
});

Deno.test("_deriveMakesafeSurfacing: report in, nothing drafted -> tradeReportIn", () => {
  const detail = { substatus: "admin_to_send_report", report_received_at: "2026-06-16T01:00:00Z" };
  const surf = _deriveMakesafeSurfacing(
    { status: "scheduled" }, detail, { status: "submitted" },
    null, undefined, false, null,
  );
  assertEquals(surf.tradeReportIn, true);
  assertEquals(surf.readyForReview, false);
  assertEquals(surf.sentClosed, false);
});

