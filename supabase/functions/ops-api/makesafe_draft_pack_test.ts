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
  applyDraftPackFeedbackOverrides,
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

Deno.test("parseDraftPackResponse rejects irreversible send markers in Claude JSON", () => {
  assertThrows(
    () =>
      parseDraftPackResponse(JSON.stringify({
        report: {
          ref: "AJBR-1",
          address: "Site",
          works: "MAKESAFE_PACK_SENT | main",
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

Deno.test("feedback overrides keep prior labour instruction while removing $1 placeholder and report terms", () => {
  const output = normaliseDraftPackOutput({
    report: {
      ref: "AJBR-67996",
      address: "23 James Cook Avenue",
      billing_note: "2 trades x 2 hours",
      scope:
        "Make-safe tarp and roofing works completed. Temporary fencing collected from yard.",
      findings: "Tarp was noted near the damaged roofing.",
      works:
        "Temporary fencing placed. Roofing materials removed from hazard area.",
      materials: "Tarp and roofing sheets.",
    },
    invoice: {
      reference: "AJBR-67996",
      contact_name: "AJ Building & Restoration",
      line_items: [
        { description: "Make-safe labour", quantity: 4, unit_price: 80 },
        {
          description: "Materials placeholder to confirm",
          quantity: 1,
          unit_price: 1,
        },
      ],
    },
    change_summary:
      "Draft ready for review. Materials line unit_price is a placeholder at $1 and needs pricing review.",
  });

  const revised = applyDraftPackFeedbackOverrides(output, {
    detail: {
      external_ref: "AJBR-67996",
      requesting_company_name: "AJ Building & Restoration",
    },
    feedback_notes: [
      {
        role: "human",
        body:
          "invoice should read, 2 trades 3 hours each at $80 per hour. thats it. includes getting temp fencing from yard. and remove all mentions of tarp and roofing from the report",
      },
      {
        role: "human",
        body:
          "shouldnt be that $1 on the invoice. remove that and we good to go",
      },
    ],
  });

  assertEquals(revised.invoice.line_items.length, 1);
  assertEquals(revised.invoice.line_items[0].quantity, 6);
  assertEquals(revised.invoice.line_items[0].unit_price, 80);
  assertEquals(
    revised.report.billing_note,
    "2 trades x 3 hours (6 labour hours total).",
  );
  assertEquals(JSON.stringify(revised.invoice).includes("$1"), false);
  assertEquals(JSON.stringify(revised.invoice).includes("placeholder"), false);
  assertEquals(
    JSON.stringify(revised.report).toLowerCase().includes("tarp"),
    false,
  );
  assertEquals(
    JSON.stringify(revised.report).toLowerCase().includes("roofing"),
    false,
  );
  assertEquals(
    /placeholder|pricing review/i.test(revised.change_summary),
    false,
  );
});

Deno.test("feedback override sanitises draft review language instead of blocking harmless authorise wording", () => {
  const output = normaliseDraftPackOutput({
    report: {
      ref: "MLB-25096",
      address: "7 Broughton St",
      works: "Draft is ready to authorise after review.",
    },
    invoice: {
      reference: "MLB-25096",
      contact_name: "Major Loss Builders",
      line_items: [{
        description: "Make-safe labour",
        quantity: 6,
        unit_price: 85,
      }],
    },
    change_summary: "Human should authorise after confirming pricing.",
  });

  const revised = applyDraftPackFeedbackOverrides(output, {
    detail: {
      external_ref: "MLB-25096",
      requesting_company_name: "Major Loss Builders",
    },
    feedback_notes: [{
      role: "human",
      body: "try again with the same draft please",
    }],
  });

  assertEquals(
    JSON.stringify(revised).toLowerCase().includes("authorise"),
    false,
  );
  assertDraftOnlyText(JSON.stringify(revised));
});

Deno.test("MLB temp-fence feedback applies hire card and keeps revised labour", () => {
  const output = normaliseDraftPackOutput({
    report: {
      ref: "MLB-25457",
      address: "46 Hillwater Prom",
      billing_note: "1 trade x 2 hours",
      scope:
        "Temporary fencing panels x3 installed with star pickets x11 and fence bases x3.",
      works: "Temp fencing made safe.",
    },
    invoice: {
      reference: "MLB-25457",
      contact_name: "Major Loss Builders",
      line_items: [{
        description: "Make-safe labour",
        quantity: 2,
        unit_price: 85,
      }],
    },
    change_summary:
      "Unit prices for hire lines are placeholder estimates only and MUST be reviewed and updated by Ops against the pricing schedule.",
  });

  const revised = applyDraftPackFeedbackOverrides(output, {
    job: { site_suburb: "Bennett Springs" },
    detail: {
      external_ref: "MLB-25457",
      requesting_company_name: "Major Loss Builders",
    },
    feedback_notes: [
      {
        role: "human",
        body:
          "need to put explicitly that the client wanted the extra temporary fencing panels. charge 1 trade 3 hours. instead of 2 hours. otherwise good",
      },
      {
        role: "human",
        body:
          "we need to charge hire fee for temp fencing, star pickets and retrieval fee as per the skill because this is mlb not ajs. so we hire the fencing out to them",
      },
    ],
  });

  const lines = revised.invoice.line_items;
  const labour = lines.find((line) => /labou?r/i.test(line.description));
  const retrieval = lines.find((line) => /retrieval/i.test(line.description));
  const panels = lines.find((line) =>
    /temporary fence hire/i.test(line.description)
  );
  const pickets = lines.find((line) => /star pickets/i.test(line.description));
  const consumables = lines.find((line) =>
    /consumables/i.test(line.description)
  );

  assertEquals(labour?.quantity, 3);
  assertEquals(labour?.unit_price, 85);
  assertEquals(retrieval?.quantity, 2);
  assertEquals(retrieval?.unit_price, 90);
  assertEquals(panels?.quantity, 12);
  assertEquals(panels?.unit_price, 15);
  assertEquals(pickets?.quantity, 11);
  assertEquals(pickets?.unit_price, 13.5);
  assertEquals(consumables?.quantity, 1);
  assertEquals(consumables?.unit_price, 25);
  assertEquals(
    lines.some((line) => /base|feet/i.test(line.description)),
    false,
  );
  assertEquals(
    /placeholder|pricing review|must be reviewed|pricing schedule/i.test(
      revised.change_summary,
    ),
    false,
  );
  assertStringIncludes(revised.change_summary, "2 hours x $90");
  assertStringIncludes(revised.change_summary, "11 x $13.50");
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
