// MakeSafe Draft Pack pure-helper tests.
//
// These tests pin the Claude draft-pack contract: structured JSON only, current
// model ID, draft-only wording, invoice-line normalisation, selected-photo prompt
// context. No network, no Supabase, no Xero.
//
// Run:
//   deno test --no-check --allow-env --allow-net=127.0.0.1 \
//     supabase/functions/ops-api/makesafe_draft_pack_test.ts

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  assertDraftOnlyText,
  buildDraftPackSystemPrompt,
  buildDraftPackUserPrompt,
  cleanDraftReviewSummary,
  MAKESAFE_DRAFT_PACK_MODEL,
  normaliseDraftPackOutput,
  parseDraftPackResponse,
  selectDraftPackDueJobIds,
} from "./makesafe_draft_pack.ts";

Deno.test("Draft Pack model is pinned to current high-quality Claude Sonnet", () => {
  assertEquals(MAKESAFE_DRAFT_PACK_MODEL, "claude-sonnet-4-6");
});

Deno.test("system prompt states draft-only boundaries", () => {
  const prompt = buildDraftPackSystemPrompt();
  assertStringIncludes(prompt, "Return JSON only");
  assertStringIncludes(prompt, "must not claim");
  assertStringIncludes(prompt, "sent");
  assertStringIncludes(prompt, "authorised");
});

Deno.test("user prompt carries selected photo urls and feedback notes", () => {
  const prompt = buildDraftPackUserPrompt({
    job: { job_number: "SWF-1" },
    detail: { external_ref: "AJBR-1" },
    feedback_notes: [{ body: "exclude the hallway photo", role: "human" }],
    selected_photo_urls: ["https://example.com/a.jpg"],
  });
  assertStringIncludes(prompt, "selected_photo_urls");
  assertStringIncludes(prompt, "https://example.com/a.jpg");
  assertStringIncludes(prompt, "exclude the hallway photo");
  assertStringIncludes(prompt, "unit_price > 0");
  assertStringIncludes(prompt, "Never output a $0 placeholder line");
  assertStringIncludes(prompt, "Major Loss Builders");
  assertStringIncludes(prompt, "1 trade x 3 hours");
  assertStringIncludes(prompt, "Do not reduce below 3 labour hours");
  assertStringIncludes(prompt, "report.billing_note must be terse");
});

Deno.test("user prompt schema does not teach Claude to emit zero-priced invoice lines", () => {
  const prompt = buildDraftPackUserPrompt({});
  const schema = JSON.parse(prompt).output_schema;
  assertEquals(schema.invoice.line_items[0].unit_price > 0, true);
});

Deno.test("parseDraftPackResponse strips code fences and normalises invoice lines", () => {
  const parsed = parseDraftPackResponse(`\`\`\`json
{
  "report": {
    "ref": "AJBR-67713",
    "address": "14 Preview Street",
    "works": "Ceiling area made safe"
  },
  "invoice": {
    "reference": "AJBR-67713",
    "contact_name": "AJS Group",
    "line_items": [
      { "Description": "Emergency make safe attendance", "Quantity": "1", "UnitAmount": "420" }
    ]
  },
  "change_summary": "Draft pack refreshed for human review."
}
\`\`\``);
  assertEquals(parsed.report.ref, "AJBR-67713");
  assertEquals(parsed.invoice.line_items.length, 1);
  assertEquals(
    parsed.invoice.line_items[0].description,
    "Emergency make safe attendance",
  );
  assertEquals(parsed.invoice.line_items[0].quantity, 1);
  assertEquals(parsed.invoice.line_items[0].unit_price, 420);
  assertEquals(parsed.invoice.line_items[0].account_code, "210");
});

Deno.test("normaliseDraftPackOutput rejects missing invoice line items", () => {
  assertThrows(
    () => normaliseDraftPackOutput({ report: {}, invoice: { line_items: [] } }),
    Error,
    "at least one invoice line item",
  );
});

Deno.test("normaliseDraftPackOutput rejects zero-priced invoice lines", () => {
  assertThrows(
    () =>
      normaliseDraftPackOutput({
        report: { ref: "AJBR-67996", address: "23 James Cook Avenue" },
        invoice: {
          reference: "AJBR-67996",
          contact_name: "AJ Building & Restoration",
          line_items: [{
            description: "Make-safe labour",
            quantity: 4,
            unit_price: 0,
          }],
        },
      }),
    Error,
    "$0/invalid unit_price",
  );
});

Deno.test("normaliseDraftPackOutput caps report photo limit to eight", () => {
  const parsed = normaliseDraftPackOutput({
    report: {
      ref: "AJBR-67996",
      address: "23 James Cook Avenue",
      photo_limit: 12,
    },
    invoice: {
      reference: "AJBR-67996",
      contact_name: "AJ Building & Restoration",
      line_items: [{
        description: "Make-safe labour",
        quantity: 4,
        unit_price: 80,
      }],
    },
  });
  assertEquals(parsed.report.photo_limit, 8);
});

Deno.test("draft-only guard rejects irreversible send markers/claims", () => {
  assertThrows(
    () => assertDraftOnlyText("MAKESAFE_PACK_SENT | main | INV-1"),
    Error,
    "forbidden irreversible wording",
  );
  assertThrows(
    () => assertDraftOnlyText("The pack was sent and the job is closed"),
    Error,
    "forbidden irreversible wording",
  );
});

Deno.test("parseDraftPackResponse rejects irreversible claims in Claude JSON", () => {
  assertThrows(
    () =>
      parseDraftPackResponse(JSON.stringify({
        report: { ref: "AJBR-1", address: "Site", works: "Pack was sent" },
        invoice: {
          reference: "AJBR-1",
          contact_name: "AJS",
          line_items: [{
            description: "Attendance",
            quantity: 1,
            unit_price: 1,
          }],
        },
        change_summary: "Pack was sent to builder",
      })),
    Error,
    "forbidden irreversible wording",
  );
});

Deno.test("parseDraftPackResponse sanitises review-summary authorise wording before the draft-only guard", () => {
  const parsed = parseDraftPackResponse(JSON.stringify({
    report: {
      ref: "AJBR-1",
      address: "Site",
      works: "Temporary works complete",
    },
    invoice: {
      reference: "AJBR-1",
      contact_name: "AJS",
      line_items: [{
        description: "Attendance",
        quantity: 1,
        unit_price: 1,
      }],
    },
    change_summary:
      "Human to confirm pricing before authorise. Draft invoice not approved.",
  }));

  assertEquals(
    parsed.change_summary,
    "Human to confirm pricing before finalise. Draft invoice not reviewed.",
  );
  assertDraftOnlyText(JSON.stringify(parsed));
});

Deno.test("cleanDraftReviewSummary keeps the summary in review/finalise language", () => {
  assertEquals(
    cleanDraftReviewSummary(
      "Do not send email; authorising is later after approval.",
    ),
    "Do not prepare email; finalising is later after approval.",
  );
});

Deno.test("selectDraftPackDueJobIds only returns safe first-draft candidates", () => {
  const details = [
    {
      job_id: "fresh",
      substatus: "admin_to_send_report",
      report_received_at: "2026-06-19T01:00:00Z",
    },
    { job_id: "drafted-incomplete", substatus: "admin_to_send_report" },
    { job_id: "already-ready", substatus: "admin_to_send_report" },
    {
      job_id: "already-sent",
      substatus: "admin_to_send_report",
      report_sent_at: "2026-06-19T02:00:00Z",
    },
    {
      job_id: "report-family",
      substatus: "admin_to_send_report",
      report_type: "roof_report",
    },
    { job_id: "waiting", substatus: "waiting_on_trade_report" },
    { job_id: "failed", substatus: "admin_to_send_report" },
    { job_id: "in-flight", substatus: "admin_to_send_report" },
  ];
  const packs = [
    {
      job_id: "drafted-incomplete",
      pack_kind: "main",
      status: "drafted",
      report_doc_id: null,
      xero_invoice_id: null,
    },
    {
      job_id: "already-ready",
      pack_kind: "main",
      status: "admin_to_send_report",
      report_doc_id: "doc-1",
      xero_invoice_id: "xero-1",
    },
    {
      job_id: "failed",
      pack_kind: "main",
      status: "failed",
      report_doc_id: null,
      xero_invoice_id: null,
    },
    {
      job_id: "in-flight",
      pack_kind: "main",
      status: "sending",
      report_doc_id: null,
      xero_invoice_id: null,
    },
  ];

  assertEquals(selectDraftPackDueJobIds(details, packs, 10), [
    "fresh",
    "drafted-incomplete",
  ]);
});

Deno.test("selectDraftPackDueJobIds honours the batch limit", () => {
  const details = [
    { job_id: "a", substatus: "admin_to_send_report" },
    { job_id: "b", substatus: "admin_to_send_report" },
    { job_id: "c", substatus: "admin_to_send_report" },
  ];
  assertEquals(selectDraftPackDueJobIds(details, [], 2), ["a", "b"]);
});

// Keeps Deno happy if this file is accidentally run with --fail-fast and imports
// assertRejects unused by an older local Deno lint pass.
Deno.test("assertRejects import smoke", async () => {
  await assertRejects(() => Promise.reject(new Error("ok")), Error, "ok");
  assert(true);
});
