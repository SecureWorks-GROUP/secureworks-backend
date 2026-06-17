// Wave 2 - makesafe_report_drafts (READ endpoint) reimplement-pure tests.
//
// MONEY/COMMS-adjacent: the cockpit this feeds has an approve button that fires
// a live authorise+send via makesafe_send_pack. The single most important
// invariant proven here is the GATE ANTIDOTE: the DEFAULT SUBJECT this endpoint
// composes can NEVER contain a review/test marker, so the human's edited-or-
// accepted subject passes checkClientSendGate. We assert that by running the
// composed subject through the real checkClientSendGate from makesafe_send_pack.
//
// All tests are pure + mocked: NO network, NO Supabase, NO Xero, NO jsPDF.
//
// Run: deno test --no-check --allow-env --allow-net=127.0.0.1 \
//        supabase/functions/ops-api/makesafe_report_drafts_test.ts
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  composeDefaultSubject,
  composeDefaultHtmlBody,
  normaliseLineItems,
  computeInvoiceTotals,
  resolveRecipientEmail,
  stripReviewMarkers,
  REPORT_DRAFT_READY_SUBSTATUS,
} from "./makesafe_report_drafts.ts";
import {
  checkClientSendGate,
  hasReviewMarker,
  REVIEW_MARKERS,
  MAKESAFE_ADMIN_FROM,
  MAKESAFE_CC,
} from "./makesafe_send_pack.ts";

// ─────────────────────────────────────────────────────────────────
// 0. The substatus contract: report-draft-ready == admin_to_send_report.
// ─────────────────────────────────────────────────────────────────
Deno.test("report-draft-ready substatus is admin_to_send_report", () => {
  assertEquals(REPORT_DRAFT_READY_SUBSTATUS, "admin_to_send_report");
});

// ─────────────────────────────────────────────────────────────────
// 1. GATE ANTIDOTE - the default subject can never carry a review marker.
//    This is the whole reason send can fail-closed. We test the composer
//    against EVERY marker token embedded in the inputs, then confirm the
//    real gate accepts the resulting subject.
// ─────────────────────────────────────────────────────────────────
Deno.test("default subject never contains a review marker (per-token)", () => {
  for (const marker of REVIEW_MARKERS) {
    const subject = composeDefaultSubject({
      externalRef: `MLB-${marker}-25248`,
      siteAddress: `12 ${marker} Street, ${marker}ville`,
      siteSuburb: marker,
    });
    assertEquals(
      hasReviewMarker(subject),
      null,
      `subject leaked marker '${marker}': ${subject}`,
    );
  }
});

Deno.test("composed default subject PASSES the real client-send gate", () => {
  // A minimally complete gate payload whose only varying part is the subject.
  // attachments mirror what makesafe_send_pack assembles server-side.
  const buildPayload = (subject: string) => ({
    from: MAKESAFE_ADMIN_FROM,
    to: "builder@example.com",
    cc: MAKESAFE_CC,
    subject,
    htmlBody: "<p>hello</p>",
    attachments: [
      { name: "Make Safe Report - MLB-25248.pdf" },
      { name: "Xero Invoice - INV-1234.pdf" },
    ],
  });

  // Even when every input is hostile (stuffed with markers), the subject passes.
  const hostile = composeDefaultSubject({
    externalRef: "TEST-DRAFT-REVIEW-001",
    siteAddress: "1 PREVIEW Rd, INTERNAL ROUND",
    siteSuburb: "PREVIEW",
  });
  assertEquals(checkClientSendGate(buildPayload(hostile)), []);

  // A normal job also passes.
  const normal = composeDefaultSubject({
    externalRef: "MLB-25248",
    siteAddress: "12 Smith Street, Joondalup",
  });
  assertEquals(checkClientSendGate(buildPayload(normal)), []);
});

Deno.test("default subject is never empty (gate rejects empty subjects)", () => {
  const subject = composeDefaultSubject({ externalRef: null, siteAddress: null, siteSuburb: null });
  assert(subject.trim().length > 0, "subject must not be empty");
  assertEquals(subject, "Make Safe Completion");
});

Deno.test("default subject includes ref + address when present, no em dash", () => {
  const subject = composeDefaultSubject({
    externalRef: "MLB-25248",
    siteAddress: "12 Smith Street, Joondalup",
  });
  assertEquals(subject, "Make Safe Completion - MLB-25248 - 12 Smith Street, Joondalup");
  assert(!subject.includes("—"), "subject must not contain an em dash");
});

Deno.test("stripReviewMarkers removes only whole-token markers, not substrings", () => {
  // 'PROTESTING' contains 'TEST' as a substring but not as a whole token.
  assertEquals(stripReviewMarkers("PROTESTING site works"), "PROTESTING site works");
  // Standalone tokens are stripped.
  assertEquals(stripReviewMarkers("REVIEW the TEST job"), "the job");
  // Adjacent markers both stripped.
  assertEquals(stripReviewMarkers("DRAFT REVIEW"), "");
});

// ─────────────────────────────────────────────────────────────────
// 2. Default html body - present, branded-ish, no review marker, no em dash.
// ─────────────────────────────────────────────────────────────────
Deno.test("default html body is non-empty, branded, marker-free, em-dash-free", () => {
  const html = composeDefaultHtmlBody({
    builderName: "MLB Constructions",
    externalRef: "MLB-25248",
    clientName: "Jane Homeowner",
    siteAddress: "12 Smith Street, Joondalup",
    invoiceNumber: "INV-1234",
    totalIncGst: 1234.5,
  });
  assert(html.trim().length > 0, "html body must not be empty");
  assert(html.includes("SecureWorks Group"), "html should be branded");
  assert(html.includes("MLB Constructions"), "html should greet the builder");
  assert(html.includes("$1,234.50"), "html should show the inc-GST total");
  assertEquals(hasReviewMarker(html), null, "html body must not carry a review marker token");
  assert(!html.includes("—"), "html must not contain an em dash");
});

Deno.test("default html body escapes interpolated job data", () => {
  const html = composeDefaultHtmlBody({
    builderName: "<script>alert(1)</script>",
    externalRef: "A&B",
  });
  assert(!html.includes("<script>"), "raw script tag must be escaped");
  assert(html.includes("&lt;script&gt;"), "script tag should be html-escaped");
  assert(html.includes("A&amp;B"), "ampersand should be escaped");
});

// S2 professional template assertions.
Deno.test("S2 html body: bold lead sentence present", () => {
  const html = composeDefaultHtmlBody({
    builderName: "MLB Constructions",
    externalRef: "MLB-25248",
    siteAddress: "12 Smith Street, Joondalup",
    invoiceNumber: "INV-1234",
    totalIncGst: 1234.5,
  });
  // The lead line must be wrapped in a bold/strong tag.
  assert(
    html.includes("<strong>Please find attached our make safe completion report"),
    "bold lead sentence must be present",
  );
});

Deno.test("S2 html body: orange accent element present (brand colour #F15A29)", () => {
  const html = composeDefaultHtmlBody({ builderName: "Test Builder" });
  assert(html.includes("#F15A29"), "orange accent colour must appear in the html body");
});

Deno.test("S2 html body: detail table contains reference and address when provided", () => {
  const html = composeDefaultHtmlBody({
    externalRef: "MLB-25248",
    siteAddress: "12 Smith Street, Joondalup",
    invoiceNumber: "INV-5678",
    totalIncGst: 990,
  });
  assert(html.includes("MLB-25248"), "reference must be present in detail table");
  assert(html.includes("12 Smith Street, Joondalup"), "site address must be present in detail table");
  assert(html.includes("INV-5678"), "invoice number must be present in detail table");
  assert(html.includes("$990.00"), "total must be present in detail table");
});

Deno.test("S2 html body: no em dash anywhere in generated output", () => {
  const html = composeDefaultHtmlBody({
    builderName: "AJS Constructions",
    externalRef: "AJS-10001",
    clientName: "Bob Owner",
    siteAddress: "7 Builder Lane, Balga",
    invoiceNumber: "INV-9999",
    totalIncGst: 2500,
  });
  // U+2014 is the em dash character. Must not appear in any outbound email content.
  assert(!html.includes("\u2014"), "html body must contain no em dash (Rule 1)");
});

Deno.test("S2 html body: passes checkClientSendGate body constraint (non-empty, no review marker)", () => {
  const html = composeDefaultHtmlBody({
    builderName: "MLB Constructions",
    externalRef: "MLB-25248",
    siteAddress: "12 Smith Street, Joondalup",
    invoiceNumber: "INV-1234",
    totalIncGst: 1234.5,
  });
  // The gate checks: html body is non-empty and has no standalone review marker.
  assert(html.trim().length > 0, "html body must be non-empty for gate");
  assertEquals(hasReviewMarker(html), null, "html body must carry no review marker for gate");
  // Verify the full gate also passes when wired up with a valid surrounding payload.
  const gateResult = checkClientSendGate({
    from: MAKESAFE_ADMIN_FROM,
    to: "builder@example.com",
    cc: MAKESAFE_CC,
    subject: "Make Safe Completion - MLB-25248 - 12 Smith Street, Joondalup",
    htmlBody: html,
    attachments: [
      { name: "Make Safe Report - MLB-25248.pdf" },
      { name: "Xero Invoice - INV-1234.pdf" },
    ],
  });
  assertEquals(gateResult, [], `gate must pass with the S2 html body; got: ${JSON.stringify(gateResult)}`);
});

// ─────────────────────────────────────────────────────────────────
// 3. Line item normalisation - Xero native shape + snake_case + derived totals.
// ─────────────────────────────────────────────────────────────────
Deno.test("normaliseLineItems reads Xero native LineItems shape", () => {
  const lines = normaliseLineItems([
    { Description: "Temp fence hire", Quantity: 2, UnitAmount: 50, LineAmount: 100 },
    { Description: "Labour", Quantity: 1.5, UnitAmount: 80, LineAmount: 120 },
  ]);
  assertEquals(lines.length, 2);
  assertEquals(lines[0], { description: "Temp fence hire", quantity: 2, unit_price: 50, line_total: 100 });
  assertEquals(lines[1], { description: "Labour", quantity: 1.5, unit_price: 80, line_total: 120 });
});

Deno.test("normaliseLineItems derives line_total when LineAmount absent", () => {
  const lines = normaliseLineItems([{ description: "x", quantity: 3, unit_price: 10 }]);
  assertEquals(lines[0].line_total, 30);
});

Deno.test("normaliseLineItems tolerates null / non-array (lines unavailable)", () => {
  assertEquals(normaliseLineItems(null), []);
  assertEquals(normaliseLineItems(undefined), []);
  assertEquals(normaliseLineItems("not an array"), []);
  assertEquals(normaliseLineItems([]), []);
});

// ─────────────────────────────────────────────────────────────────
// 4. Totals - prefer the stored header (sub_total ex GST, total inc GST),
//    fall back to summing local lines and grossing up by 1.1.
// ─────────────────────────────────────────────────────────────────
Deno.test("computeInvoiceTotals prefers the stored header totals", () => {
  const t = computeInvoiceTotals({ subTotal: 100, total: 110, lines: [] });
  assertEquals(t, { total_ex_gst: 100, total_inc_gst: 110, source: "header" });
});

Deno.test("computeInvoiceTotals derives inc from ex header when total missing", () => {
  const t = computeInvoiceTotals({ subTotal: 200, total: null, lines: [] });
  assertEquals(t, { total_ex_gst: 200, total_inc_gst: 220, source: "header" });
});

Deno.test("computeInvoiceTotals falls back to lines when header absent", () => {
  const lines = normaliseLineItems([
    { Description: "a", Quantity: 1, UnitAmount: 100, LineAmount: 100 },
    { Description: "b", Quantity: 1, UnitAmount: 50, LineAmount: 50 },
  ]);
  const t = computeInvoiceTotals({ subTotal: null, total: null, lines });
  assertEquals(t, { total_ex_gst: 150, total_inc_gst: 165, source: "lines" });
});

// ─────────────────────────────────────────────────────────────────
// 5. Recipient email (BLOCKER C) - the To is the work-orders inbox
//    (report_recipient) ONLY. It is NEVER the billing contact (invoice_email =
//    vanessa@ajs.build for AJS). Null when no report_recipient is configured ->
//    the cockpit warns. NO fallback to invoice_email.
// ─────────────────────────────────────────────────────────────────
Deno.test("resolveRecipientEmail uses the company report_recipient (work-orders inbox)", () => {
  assertEquals(
    resolveRecipientEmail({
      companyReportRecipient: "workorders@ajs.build",
      companyInvoiceEmail: "vanessa@ajs.build",
      detailInvoiceEmail: null,
    }),
    "workorders@ajs.build",
  );
});

Deno.test("resolveRecipientEmail NEVER falls back to invoice_email (vanessa must not be the To)", () => {
  // report_recipient absent + invoice_email present -> still null (no fallback).
  assertEquals(
    resolveRecipientEmail({
      companyReportRecipient: null,
      companyInvoiceEmail: "vanessa@ajs.build",
      detailInvoiceEmail: "vanessa@ajs.build",
    }),
    null,
  );
});

Deno.test("resolveRecipientEmail returns null when no work-orders inbox is configured (UI warns)", () => {
  assertEquals(resolveRecipientEmail({ companyReportRecipient: null, companyInvoiceEmail: null, detailInvoiceEmail: null }), null);
  assertEquals(resolveRecipientEmail({ companyReportRecipient: "   ", companyInvoiceEmail: "x@y.com", detailInvoiceEmail: "" }), null);
});
