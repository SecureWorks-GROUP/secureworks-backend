// deno-lint-ignore-file no-import-prefix no-explicit-any
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _makesafeDocBooleansForTest as docBooleans,
  _makesafeSentToBuilder as sentToBuilder,
  _enrichMakesafeBoardJobForTest as enrich,
} from "./index.ts";

// ─────────────────────────────────────────────────────────────────────────
// F5 — SENT chip truth. The SENT chip must reflect a REAL send record (a
// MAKESAFE_PACK_SENT marker OR a durable pack sent-status), never the
// completed/archive column proxy. Fail-closed: unknown -> not sent.
// ─────────────────────────────────────────────────────────────────────────

Deno.test("F5 sent-with-marker: packSent marker -> sent_to_builder true", () => {
  assertEquals(sentToBuilder(true, null), true);
  assertEquals(sentToBuilder(true, { status: "authorised_not_sent" }), true);
});

Deno.test("F5 sent-with-durable-pack-status: pack.status in sent-set -> true", () => {
  for (const status of ["sent", "sent_marker_failed", "sent_not_closed", "close_failed"]) {
    assertEquals(sentToBuilder(false, { status }), true, `pack.status=${status}`);
    assertEquals(sentToBuilder(undefined, { status }), true, `undefined marker, pack.status=${status}`);
  }
});

Deno.test("F5 not-sent: no marker + non-sent pack status -> false (fail-closed)", () => {
  assertEquals(sentToBuilder(false, null), false);
  assertEquals(sentToBuilder(undefined, undefined), false);
  // report_sent_at is stamped at ready_to_invoice, NOT at send — it must NOT
  // green the chip. It is not even an input here.
  assertEquals(sentToBuilder(false, { status: "authorised_not_sent" }), false);
  assertEquals(sentToBuilder(false, { status: "drafted" }), false);
});

Deno.test("F5 completed-without-marker: completed card, no send record -> sent_to_builder false", () => {
  // Mirrors SWMS-26438/26864: reaches completed/archive (active AUTHORISED
  // invoice + close-out docs attached) but has NO pack-sent marker and no pack.
  const job = { id: "j1", status: "invoiced", created_at: "2026-07-03T00:00:00Z" };
  const detail = { substatus: "complete", external_ref: "AJBR 66923" };
  const invoice = { status: "AUTHORISED", invoice_date: "2026-07-03T00:00:00Z" };
  const docs = [
    { type: "invoice", file_name: "INV-0776.pdf" },
    { type: "makesafe_report", file_name: "26438 make safe report.pdf" },
  ];
  const enriched = enrich(job, detail, [], null, invoice, docs, false, null);
  assert(
    enriched.board_stage === "completed" || enriched.board_stage === "archive",
    `expected completed/archive, got ${enriched.board_stage}`,
  );
  assertEquals(enriched.sent_to_builder, false);
});

Deno.test("F5 completed-with-marker: same card WITH pack-sent marker -> sent_to_builder true", () => {
  const job = { id: "j2", status: "invoiced", created_at: "2026-07-03T00:00:00Z" };
  const detail = { substatus: "complete", external_ref: "MLB-25919" };
  const invoice = { status: "AUTHORISED", invoice_date: "2026-07-03T00:00:00Z" };
  const docs = [
    { type: "invoice", file_name: "INV-0757.pdf" },
    { type: "makesafe_report", file_name: "make safe report.pdf" },
    { type: "swms", file_name: "SWMS method statement.pdf" },
  ];
  const enriched = enrich(job, detail, [], null, invoice, docs, true, { status: "sent" });
  assertEquals(enriched.sent_to_builder, true);
});

// ─────────────────────────────────────────────────────────────────────────
// F6 — close-out doc chips PREFER job_documents.type, fall back to filename only
// when the type is absent/'general'.
// ─────────────────────────────────────────────────────────────────────────

Deno.test("F6 invoice-by-type: type='invoice' named INV-xxxx.pdf -> has_invoice_doc true", () => {
  // The 8 MLB regression: filename 'INV-0776.pdf' has no 'invoice' substring, so
  // the old filename match read the invoice as MISSING. Type wins now.
  const flags = docBooleans([{ type: "invoice", file_name: "INV-0776.pdf" }]);
  assertEquals(flags.has_invoice_doc, true);
});

Deno.test("F6 invoice-by-filename-fallback: untyped/'general' file named '...invoice...' -> true", () => {
  assertEquals(docBooleans([{ type: "general", file_name: "Tax Invoice 0776.pdf" }]).has_invoice_doc, true);
  assertEquals(docBooleans([{ type: "", file_name: "invoice-0776.pdf" }]).has_invoice_doc, true);
  assertEquals(docBooleans([{ file_name: "invoice.pdf" }]).has_invoice_doc, true); // type absent
});

Deno.test("F6 type wins: a meaningful non-invoice type is NOT spoofed by an 'invoice' filename", () => {
  // A makesafe_report typed doc whose filename contains 'invoice' must NOT count
  // as an invoice — type is authoritative for meaningful types.
  const flags = docBooleans([{ type: "makesafe_report", file_name: "make safe report - invoice appendix.pdf" }]);
  assertEquals(flags.has_invoice_doc, false);
  assertEquals(flags.has_report_doc, true);
});

Deno.test("F6 report-by-type and filename-fallback", () => {
  assertEquals(docBooleans([{ type: "makesafe_report", file_name: "REP-26438.pdf" }]).has_report_doc, true);
  assertEquals(docBooleans([{ type: "general", file_name: "SWMS-26438 Make Safe Report.pdf" }]).has_report_doc, true);
  assertEquals(docBooleans([{ type: "invoice", file_name: "INV.pdf" }]).has_report_doc, false);
});

Deno.test("F6 swms-by-type and job-number-prefix not matched by fallback", () => {
  assertEquals(docBooleans([{ type: "swms", file_name: "site-safety.pdf" }]).has_swms_doc, true);
  // job-number prefix 'SWMS-26438' on a general file must NOT count as a SWMS doc.
  assertEquals(docBooleans([{ type: "general", file_name: "SWMS-26438 make safe report.pdf" }]).has_swms_doc, false);
  // genuine SWMS filename on a general file DOES count via fallback.
  assertEquals(docBooleans([{ type: "general", file_name: "SWMS method statement.pdf" }]).has_swms_doc, true);
});

Deno.test("F6 no-docs: empty / null rows -> all false, no crash (fail-closed)", () => {
  for (const rows of [[], null, undefined]) {
    const flags = docBooleans(rows as any);
    assertEquals(flags.has_wo, false);
    assertEquals(flags.has_report_doc, false);
    assertEquals(flags.has_invoice_doc, false);
    assertEquals(flags.has_swms_doc, false);
  }
});

Deno.test("F6 has_wo stays type-only: a 'work order' filename on a general file does NOT count", () => {
  assertEquals(docBooleans([{ type: "work_order", file_name: "PO-55049.pdf" }]).has_wo, true);
  assertEquals(
    docBooleans([{ type: "work_order", file_name: "work-order-SWMS-26998.pdf" }]).has_wo,
    false,
  );
  assertEquals(docBooleans([{ type: "general", file_name: "work order.pdf" }]).has_wo, false);
});
