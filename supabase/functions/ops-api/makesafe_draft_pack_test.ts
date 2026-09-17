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
  verifyDraftPackOutput,
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

Deno.test("system and user prompts demand short explanatory report paragraphs", () => {
  const system = buildDraftPackSystemPrompt();
  const user = buildDraftPackUserPrompt({});
  for (const prompt of [system, user]) {
    assertStringIncludes(prompt, "short explanatory paragraphs");
    assertStringIncludes(prompt, "Never invent");
    assertStringIncludes(prompt, "No em dashes");
    assertStringIncludes(prompt, "write less");
  }
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
  assertStringIncludes(prompt, "AJS / AJ Building & Restoration / AJBR");
  assertStringIncludes(prompt, "$80 ex/hr");
  assertStringIncludes(prompt, "default to labour/travel only");
  assertStringIncludes(prompt, "panels to AJS at $59");
  assertStringIncludes(prompt, "cement bases/blocks at $28");
  assertStringIncludes(prompt, "Counts alone are not sale evidence");
  assertStringIncludes(prompt, "Never charge AJS cable ties");
  assertStringIncludes(prompt, "existing fence");
  assertStringIncludes(prompt, "$13.50 ex each");
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

Deno.test("feedback overrides understand no-mention wording and scrub report terms", () => {
  const output = normaliseDraftPackOutput({
    report: {
      ref: "MLB-25767",
      address: "170 Hampden Road",
      billing_note: "1 trade x 3 hours",
      scope:
        "Ceiling and mould make-safe. Temporary fencing was installed near the carport.",
      findings: "Mould noted. Temp fencing was not part of the ceiling works.",
      works: "Temporary fence checked and ceiling cleaned.",
      materials: "Mould killer and temp fence materials.",
    },
    invoice: {
      reference: "MLB-25767",
      contact_name: "Major Loss Builders",
      line_items: [{
        description: "Make-safe labour",
        quantity: 3,
        unit_price: 85,
      }, {
        description: "Mould killer",
        quantity: 1,
        unit_price: 25,
      }],
    },
    change_summary: "Draft revised.",
  });

  const revised = applyDraftPackFeedbackOverrides(output, {
    detail: {
      external_ref: "MLB-25767",
      requesting_company_name: "Major Loss Builders",
    },
    feedback_notes: [{
      role: "human",
      body:
        "there should be no mention of temp fencing or anything outside of the ceiling and mould makesafe and roof inspection",
    }],
  });

  assertEquals(
    JSON.stringify(revised.report).toLowerCase().includes("temp fencing"),
    false,
  );
  assertEquals(
    JSON.stringify(revised.report).toLowerCase().includes("temporary fencing"),
    false,
  );
  const verification = verifyDraftPackOutput(revised, {
    detail: {
      external_ref: "MLB-25767",
      requesting_company_name: "Major Loss Builders",
    },
    feedback_notes: [{
      role: "human",
      body:
        "there should be no mention of temp fencing or anything outside of the ceiling and mould makesafe and roof inspection",
    }],
  });
  assertEquals(verification.ok, true);
  assertEquals(
    verification.applied_rule_ids.includes("REPORT_FEEDBACK_TERM_REMOVAL"),
    true,
  );
});

Deno.test("draft verifier blocks rule violations before Xero/render", () => {
  const ajsWrongRate = normaliseDraftPackOutput({
    report: {
      ref: "AJBR-67996",
      address: "23 James Cook Avenue",
      billing_note: "2 trades x 2 hours",
      works: "Temporary fencing make-safe completed.",
    },
    invoice: {
      reference: "AJBR-67996",
      contact_name: "AJ Building & Restoration",
      line_items: [{
        description: "Make-safe labour",
        quantity: 4,
        unit_price: 85,
      }],
    },
    change_summary: "Draft revised.",
  });
  const ajsVerification = verifyDraftPackOutput(ajsWrongRate, {
    detail: {
      external_ref: "AJBR-67996",
      requesting_company_name: "AJ Building & Restoration",
    },
  });
  assertEquals(ajsVerification.ok, false);
  assertStringIncludes(ajsVerification.blockers.join("; "), "AJS/AJBR labour");

  const mlbUnderMinimum = normaliseDraftPackOutput({
    report: {
      ref: "MLB-26003",
      address: "25 Kimbara Street",
      billing_note: "1 trade x 2 hours",
      works: "Make-safe attendance completed.",
    },
    invoice: {
      reference: "MLB-26003",
      contact_name: "Major Loss Builders",
      line_items: [{
        description: "Make-safe labour",
        quantity: 2,
        unit_price: 85,
      }],
    },
    change_summary: "Draft revised.",
  });
  const mlbVerification = verifyDraftPackOutput(mlbUnderMinimum, {
    detail: {
      external_ref: "MLB-26003",
      requesting_company_name: "Major Loss Builders",
    },
  });
  assertEquals(mlbVerification.ok, false);
  assertStringIncludes(mlbVerification.blockers.join("; "), "below 3 hours");

  const mlbNoLabour = normaliseDraftPackOutput({
    report: {
      ref: "MLB-26003",
      address: "25 Kimbara Street",
      billing_note: "materials only",
      works: "Make-safe attendance completed.",
    },
    invoice: {
      reference: "MLB-26003",
      contact_name: "Major Loss Builders",
      line_items: [{
        description: "Materials - consumables",
        quantity: 1,
        unit_price: 25,
      }],
    },
    change_summary: "Draft revised.",
  });
  const noLabourVerification = verifyDraftPackOutput(mlbNoLabour, {
    detail: {
      external_ref: "MLB-26003",
      requesting_company_name: "Major Loss Builders",
    },
  });
  assertEquals(noLabourVerification.ok, false);
  assertStringIncludes(
    noLabourVerification.blockers.join("; "),
    "must include a labour line",
  );

  const ajsBadTempFenceMaterials = normaliseDraftPackOutput({
    report: {
      ref: "AJBR-67996",
      address: "23 James Cook Avenue",
      billing_note: "2 trades x 3 hours",
      works: "Temporary fencing make-safe completed.",
    },
    invoice: {
      reference: "AJBR-67996",
      contact_name: "AJ Building & Restoration",
      line_items: [{
        description: "Make-safe labour",
        quantity: 6,
        unit_price: 80,
      }, {
        description: "Cable ties and small consumables for temporary fencing",
        quantity: 1,
        unit_price: 25,
      }],
    },
    change_summary: "Draft revised.",
  });
  const ajsMaterialVerification = verifyDraftPackOutput(
    ajsBadTempFenceMaterials,
    {
      detail: {
        external_ref: "AJBR-67996",
        requesting_company_name: "AJ Building & Restoration",
      },
    },
  );
  assertEquals(ajsMaterialVerification.ok, false);
  assertStringIncludes(
    ajsMaterialVerification.blockers.join("; "),
    "must not charge cable ties",
  );

  const mlbBadTempFenceHire = normaliseDraftPackOutput({
    report: {
      ref: "MLB-24732",
      address: "Noranda",
      billing_note: "2 trades x 5 hours",
      works: "Temporary fencing installed.",
    },
    invoice: {
      reference: "MLB-24732",
      contact_name: "Major Loss Builders",
      line_items: [{
        description: "Make-safe labour",
        quantity: 10,
        unit_price: 85,
      }, {
        description: "Temporary fence panels supplied",
        quantity: 7,
        unit_price: 59,
      }],
    },
    change_summary: "Draft revised.",
  });
  const mlbTempFenceVerification = verifyDraftPackOutput(
    mlbBadTempFenceHire,
    {
      detail: {
        external_ref: "MLB-24732",
        requesting_company_name: "Major Loss Builders",
      },
      source_docs: [{
        type: "trade_report",
        text: "Temporary fencing panels x 7 installed and retrieval required.",
      }],
    },
  );
  assertEquals(mlbTempFenceVerification.ok, false);
  assertStringIncludes(
    mlbTempFenceVerification.blockers.join("; "),
    "must be hire lines",
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
      }, {
        description:
          "Temporary fence panel hire - 3 panels - rate needs pricing review",
        quantity: 36,
        unit_price: 5,
      }, {
        description: "Temporary fence base/foot hire - 3 units",
        quantity: 3,
        unit_price: 8,
      }, {
        description: "Fixings and consumables",
        quantity: 1,
        unit_price: 25,
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
  assertEquals(lines.length, 5);
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

Deno.test("MLB temp-fence placeholder removal applies hire card from evidence", () => {
  const output = normaliseDraftPackOutput({
    report: {
      ref: "SWMS-26655 / MLB-25096",
      address: "7 Broughton St",
      billing_note: "2 trades x 3 hours",
      scope: "Temporary fencing make-safe.",
      works:
        "Put up 1 temp fence panel to close gap and secured it with 2 star pickets.",
      materials: "Temp fence panels x 1, Star picket x 2",
    },
    invoice: {
      reference: "SWMS-26655 / MLB-25096",
      contact_name: "ML Builders",
      line_items: [{
        description: "Make-safe labour",
        quantity: 6,
        unit_price: 85,
      }, {
        description:
          "Materials placeholder - temp fence panel and star pickets",
        quantity: 1,
        unit_price: 1,
      }],
    },
    change_summary: "Removed the $1 placeholder.",
  });

  const revised = applyDraftPackFeedbackOverrides(output, {
    job: { site_suburb: "Balcatta" },
    detail: {
      external_ref: "MLB-25096",
      requesting_company_name: "ML Builders",
    },
    service_report: {
      checklist_json: {
        job_type: "Temporary fencing",
        materials_used: ["Temp fence panels x 1", "Star picket x 2"],
      },
    },
    feedback_notes: [{
      role: "human",
      body: "shouldnt be that $1 on the invoice. remove that and we good to go",
    }],
  });

  assertEquals(
    revised.invoice.line_items.some((line) => line.unit_price <= 1.01),
    false,
  );
  assertEquals(revised.invoice.line_items.length, 5);
  assertEquals(
    revised.invoice.line_items.some((line) =>
      /retrieval/.test(line.description) && line.quantity === 2 &&
      line.unit_price === 90
    ),
    true,
  );
  assertEquals(
    revised.invoice.line_items.some((line) =>
      /temporary fence hire/i.test(line.description) &&
      line.quantity === 12 && line.unit_price === 5
    ),
    true,
  );
  assertEquals(
    revised.invoice.line_items.some((line) =>
      /star pickets/i.test(line.description) && line.quantity === 2 &&
      line.unit_price === 13.5
    ),
    true,
  );
  const verification = verifyDraftPackOutput(revised, {
    job: { site_suburb: "Balcatta" },
    detail: {
      external_ref: "MLB-25096",
      requesting_company_name: "ML Builders",
    },
    service_report: {
      checklist_json: {
        job_type: "Temporary fencing",
        materials_used: ["Temp fence panels x 1", "Star picket x 2"],
      },
    },
    feedback_notes: [{
      role: "human",
      body: "shouldnt be that $1 on the invoice. remove that and we good to go",
    }],
  });
  assertEquals(verification.ok, true);
});

Deno.test("AJS temp-fence defaults to labour-only unless sale evidence is explicit", () => {
  const output = normaliseDraftPackOutput({
    report: {
      ref: "AJBR-66949",
      address: "Greenfields",
      billing_note: "2 trades x 3 hours",
      works:
        "Removed fallen Hardie panels and installed temporary fence panels with cement bases.",
      materials: "4x temp fence panels, 5x cement bases, 3x cable ties.",
    },
    invoice: {
      reference: "AJBR-66949",
      contact_name: "AJ Building & Restoration",
      line_items: [{
        description: "Make-safe labour",
        quantity: 6,
        unit_price: 85,
      }, {
        description: "Temporary fence panels supplied",
        quantity: 4,
        unit_price: 1,
      }, {
        description: "Cement bases for temporary fencing",
        quantity: 5,
        unit_price: 1,
      }, {
        description: "Cable ties and small consumables",
        quantity: 1,
        unit_price: 25,
      }],
    },
    change_summary:
      "Materials line unit_price is a placeholder and needs pricing review.",
  });

  const revised = applyDraftPackFeedbackOverrides(output, {
    job: { site_suburb: "Greenfields" },
    detail: {
      external_ref: "AJBR-66949",
      requesting_company_name: "AJ Building & Restoration",
    },
    service_report: {
      invoice_notes: "3hrs x 2 trades + 4 temp panels + 5 bases",
      materials_used: [
        "4x temp fence panels",
        "5x cement bases",
        "3x cable ties",
      ],
    },
    feedback_notes: [{
      role: "human",
      body:
        "apply the AJS/AJBR makesafe reporting skill rates from the wiki and remove the $1 placeholders",
    }],
  });

  const lines = revised.invoice.line_items;
  const labour = lines.find((line) => /labou?r/i.test(line.description));
  const panels = lines.find((line) => /panels/i.test(line.description));
  const bases = lines.find((line) => /bases/i.test(line.description));

  assertEquals(lines.length, 1);
  assertEquals(labour?.quantity, 6);
  assertEquals(labour?.unit_price, 80);
  assertEquals(panels, undefined);
  assertEquals(bases, undefined);
  assertEquals(
    lines.some((line) => /cable\s*ties?|consumables/i.test(line.description)),
    false,
  );
  assertEquals(JSON.stringify(lines).includes("$1"), false);
  assertEquals(
    /placeholder|pricing review/i.test(revised.change_summary),
    false,
  );
  assertStringIncludes(
    revised.change_summary,
    "no explicit SecureWorks sale/supply evidence",
  );
});

Deno.test("AJS existing-fence star pickets are retained at the standing sale rate", () => {
  const output = normaliseDraftPackOutput({
    report: {
      ref: "AJBR-70271",
      address: "Privacy-safe test property",
      billing_note: "2 trades x 3 hours",
      findings: "Make-safe type: Temporary fencing",
      works:
        "Propped up the existing Hardie fence using 20 star pickets to secure it upright until replacement.",
      materials: "Star pickets x 20.",
    },
    invoice: {
      reference: "AJBR-70271",
      contact_name: "AJ Building & Restoration",
      line_items: [{
        description:
          "Make-safe labour to install star pickets - 2 trades x 3 hours",
        quantity: 6,
        unit_price: 80,
      }, {
        description: "Star pickets x 20",
        quantity: 20,
        unit_price: 13.5,
      }, {
        description: "Fixings supplied",
        quantity: 1,
        unit_price: 25,
      }],
    },
    change_summary: "Draft revised.",
  });
  const ctx = {
    job: {
      id: "208450c0-7161-4b30-9514-66226b054609",
      metadata: { makesafe_job_family: "general_makesafe" },
    },
    detail: {
      external_ref: "AJBR-70271",
      requesting_company_name: "AJ Building & Restoration",
    },
    service_report: {
      checklist_json: {
        job_type: "Temporary fencing",
        damage_description: "Make-safe type: Temporary fencing",
        work_done:
          "Propped up hardy fence using 20 star pickets to secure upright until fence replaced.",
        materials_used: [
          "Star pickets x 20",
          "Bases / feet",
          "Tarps / roof materials",
          "Fixings / consumables",
          "Other / none",
        ],
      },
    },
  };

  const revised = applyDraftPackFeedbackOverrides(output, ctx);
  const pickets = revised.invoice.line_items.filter((line) =>
    /star\s+pickets/i.test(line.description) && line.unit_price === 13.5
  );
  assertEquals(pickets.length, 1);
  assertEquals(pickets[0].quantity, 20);
  assertEquals(pickets[0].unit_price, 13.5);
  const labour = revised.invoice.line_items.find((line) =>
    /labou?r/i.test(line.description)
  );
  assertEquals(labour?.quantity, 6);
  assertEquals(labour?.unit_price, 80);
  const subtotalEx = revised.invoice.line_items.reduce(
    (sum, line) => sum + Number(line.quantity) * Number(line.unit_price),
    0,
  );
  assertEquals(subtotalEx, 750);
  assertEquals(Math.round(subtotalEx * 1.1 * 100) / 100, 825);
  assertEquals(
    revised.invoice.line_items.some((line) =>
      /fixings?|consumables?/i.test(line.description)
    ),
    false,
  );
  const verification = verifyDraftPackOutput(revised, ctx);
  assertEquals(verification.blockers, []);

  const duplicated = structuredClone(revised);
  duplicated.invoice.line_items.push({ ...pickets[0] });
  assertStringIncludes(
    verifyDraftPackOutput(duplicated, ctx).blockers.join("; "),
    "exactly one canonical",
  );

  const genericPicket = structuredClone(revised);
  genericPicket.invoice.line_items.push({
    description: "Fence pickets supplied",
    quantity: 20,
    unit_price: 13.5,
  });
  assertStringIncludes(
    verifyDraftPackOutput(genericPicket, ctx).blockers.join("; "),
    "must not charge pickets unless",
  );
  assertEquals(
    applyDraftPackFeedbackOverrides(genericPicket, ctx).invoice.line_items.some(
      (line) => /fence pickets supplied/i.test(line.description),
    ),
    false,
  );

  const classifiedTempFence = structuredClone(ctx);
  classifiedTempFence.job.metadata.makesafe_job_family = "temp_fence_makesafe";
  const tempFenceVerification = verifyDraftPackOutput(
    revised,
    classifiedTempFence,
  );
  assertEquals(tempFenceVerification.ok, false);
  assertStringIncludes(
    tempFenceVerification.blockers.join("; "),
    "temp-fence",
  );
});

Deno.test("existing-fence wording cannot launder a genuine AJS temporary-fence kit", () => {
  const output = normaliseDraftPackOutput({
    report: {
      ref: "AJBR-70271",
      billing_note: "2 trades x 3 hours",
      works: "Used star pickets to support an existing boundary fence.",
      materials: "Star pickets x 20, temporary fence panels x 4.",
    },
    invoice: {
      reference: "AJBR-70271",
      contact_name: "AJ Building & Restoration",
      line_items: [{
        description: "Make-safe labour - 2 trades x 3 hours",
        quantity: 6,
        unit_price: 80,
      }, {
        description: "Star pickets supplied to support existing fence",
        quantity: 20,
        unit_price: 13.5,
      }, {
        description: "Temporary fence panels supplied",
        quantity: 4,
        unit_price: 59,
      }],
    },
    change_summary: "Draft revised.",
  });
  const verification = verifyDraftPackOutput(output, {
    detail: {
      external_ref: "AJBR-70271",
      requesting_company_name: "AJ Building & Restoration",
    },
    service_report: {
      checklist_json: {
        work_done: "Used star pickets to support an existing boundary fence.",
        materials_used: [
          "Star pickets x 20",
          "Temporary fence panels x 4",
        ],
      },
    },
  });
  assertEquals(verification.ok, false);
  assertStringIncludes(
    verification.blockers.join("; "),
    "temp-fence",
  );
});

Deno.test("AJS explicit SecureWorks-supplied temp-fence sale uses panel/base rates", () => {
  const output = normaliseDraftPackOutput({
    report: {
      ref: "AJBR-66949",
      address: "Greenfields",
      billing_note: "2 trades x 3 hours",
      works:
        "Removed fallen Hardie panels and installed temporary fence panels with cement bases.",
      materials: "4x temp fence panels, 5x cement bases, 3x cable ties.",
    },
    invoice: {
      reference: "AJBR-66949",
      contact_name: "AJ Building & Restoration",
      line_items: [{
        description: "Make-safe labour",
        quantity: 6,
        unit_price: 85,
      }, {
        description: "Temporary fence panels supplied",
        quantity: 4,
        unit_price: 1,
      }, {
        description: "Cement bases for temporary fencing",
        quantity: 5,
        unit_price: 1,
      }, {
        description: "Cable ties and small consumables",
        quantity: 1,
        unit_price: 25,
      }],
    },
    change_summary:
      "Materials line unit_price is a placeholder and needs pricing review.",
  });

  const revised = applyDraftPackFeedbackOverrides(output, {
    job: { site_suburb: "Greenfields" },
    detail: {
      external_ref: "AJBR-66949",
      requesting_company_name: "AJ Building & Restoration",
    },
    service_report: {
      invoice_notes:
        "3hrs x 2 trades + SecureWorks supplied/sold 4 temp panels and 5 bases to AJS",
      materials_used: [
        "4x temp fence panels supplied by SecureWorks",
        "5x cement bases supplied by SecureWorks",
        "3x cable ties",
      ],
    },
    feedback_notes: [{
      role: "human",
      body:
        "apply the AJS/AJBR makesafe reporting skill rates from the wiki and remove the $1 placeholders",
    }],
  });

  const lines = revised.invoice.line_items;
  const labour = lines.find((line) => /labou?r/i.test(line.description));
  const panels = lines.find((line) => /panels/i.test(line.description));
  const bases = lines.find((line) => /bases/i.test(line.description));

  assertEquals(lines.length, 3);
  assertEquals(labour?.quantity, 6);
  assertEquals(labour?.unit_price, 80);
  assertEquals(panels?.quantity, 4);
  assertEquals(panels?.unit_price, 59);
  assertEquals(bases?.quantity, 5);
  assertEquals(bases?.unit_price, 28);
  assertEquals(
    lines.some((line) => /cable\s*ties?|consumables/i.test(line.description)),
    false,
  );
  assertEquals(JSON.stringify(lines).includes("$1"), false);
  assertEquals(
    /placeholder|pricing review/i.test(revised.change_summary),
    false,
  );
});

Deno.test("AJS generic $1 placeholder is removed when Ops says remove it", () => {
  const output = normaliseDraftPackOutput({
    report: {
      ref: "AJBR-67217-R",
      address: "Mount Richon",
      billing_note: "2 trades x 3 hours",
      works: "Attendance and roof make-safe review completed.",
    },
    invoice: {
      reference: "AJBR-67217-R",
      contact_name: "AJ Building & Restoration",
      line_items: [{
        description: "Make-safe labour",
        quantity: 6,
        unit_price: 80,
      }, {
        description:
          "Materials placeholder for temporary fence panels, bases/feet, tarps/roof materials, fixings and consumables",
        quantity: 1,
        unit_price: 1,
      }],
    },
    change_summary:
      "Materials line unit_price is a placeholder at $1 and needs pricing review.",
  });

  const revised = applyDraftPackFeedbackOverrides(output, {
    detail: {
      external_ref: "AJBR-67217-R",
      requesting_company_name: "AJ Building & Restoration",
    },
    feedback_notes: [{
      role: "human",
      body:
        "remove the $1 material placeholder; no material charge unless actual cost evidence",
    }],
  });

  assertEquals(revised.invoice.line_items.length, 1);
  assertEquals(revised.invoice.line_items[0].quantity, 6);
  assertEquals(revised.invoice.line_items[0].unit_price, 80);
  assertEquals(JSON.stringify(revised.invoice).includes("placeholder"), false);
  assertEquals(
    /placeholder|pricing review/i.test(revised.change_summary),
    false,
  );
});

Deno.test("draft validation rejects unresolved $1 material placeholders", () => {
  const output = normaliseDraftPackOutput({
    report: { ref: "MLB-1", address: "Unknown" },
    invoice: {
      reference: "MLB-1",
      contact_name: "Major Loss Builders",
      line_items: [{
        description: "Make-safe labour",
        quantity: 4,
        unit_price: 85,
      }, {
        description: "Materials placeholder to confirm",
        quantity: 1,
        unit_price: 1,
      }],
    },
    change_summary: "Needs pricing review.",
  });

  assertThrows(
    () =>
      applyDraftPackFeedbackOverrides(output, {
        detail: {
          external_ref: "MLB-1",
          requesting_company_name: "Major Loss Builders",
        },
        feedback_notes: [],
      }),
    Error,
    "$1 placeholder",
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

// --- Labour-only MLB temporary-fence verifier -------------------------------
//
// The builder put his own fencing up, so there is no SecureWorks hire to bill.
// The verifier accepts attendance labour on its own, but ONLY when the trade
// report itself proves it: no SecureWorks materials, and trade-recorded wording
// that says the fencing was client supplied. Draft wording never counts.

const MLB_LABOUR_ONLY_INVOICE = {
  reference: "MLB-26310",
  contact_name: "Major Loss Builders",
  line_items: [{
    description: "Make-safe attendance labour",
    quantity: 8,
    unit_price: 85,
  }],
};

const MLB_LABOUR_ONLY_REPORT = {
  ref: "MLB-26310",
  address: "12 Marangaroo Dr",
  billing_note: "2 trades x 4 hours",
  scope: "Temporary fencing make-safe.",
  works: "Attended site and made the temporary fencing safe.",
};

Deno.test("MLB labour-only temp-fence pack is accepted when the trade report records client-supplied fencing", () => {
  const output = normaliseDraftPackOutput({
    report: MLB_LABOUR_ONLY_REPORT,
    invoice: MLB_LABOUR_ONLY_INVOICE,
    change_summary: "Billed attendance labour only.",
  });

  const verification = verifyDraftPackOutput(output, {
    job: { site_suburb: "Marangaroo" },
    detail: {
      external_ref: "MLB-26310",
      requesting_company_name: "Major Loss Builders",
    },
    service_report: {
      checklist_json: {
        job_type: "Temporary fencing",
        materials_used: [". x .", "", ". x ."],
        work_done:
          "Temp fencing was on site already, client supplied. We attended and made it safe.",
      },
    },
  });

  assertEquals(verification.ok, true);
  assertEquals(verification.blockers, []);
  assert(
    verification.applied_rule_ids.includes(
      "MLB_TEMP_FENCE_CLIENT_SUPPLIED_LABOUR_ONLY",
    ),
  );
  const assumptions = verification.review_assumptions ?? [];
  assertEquals(assumptions.length, 1);
  assertEquals(
    assumptions[0].reason_code,
    "temporary_fence_hire_withheld_client_supplied",
  );
  assertStringIncludes(assumptions[0].reason, "client-supplied");
});

Deno.test("MLB labour-only temp-fence pack is still refused when the trade report lacks client-supplied wording", () => {
  const output = normaliseDraftPackOutput({
    report: MLB_LABOUR_ONLY_REPORT,
    invoice: MLB_LABOUR_ONLY_INVOICE,
    change_summary: "Billed attendance labour only.",
  });

  const verification = verifyDraftPackOutput(output, {
    job: { site_suburb: "Marangaroo" },
    detail: {
      external_ref: "MLB-26310",
      requesting_company_name: "Major Loss Builders",
    },
    service_report: {
      checklist_json: {
        job_type: "Temporary fencing",
        materials_used: [". x .", "", ". x ."],
        work_done:
          "Attended site and made the temporary fencing safe. All secure on departure.",
      },
    },
  });

  assertEquals(verification.ok, false);
  assert(
    verification.blockers.some((blocker) =>
      /retrieval allowance/i.test(blocker)
    ),
    `expected a retrieval-allowance blocker, got ${
      JSON.stringify(verification.blockers)
    }`,
  );
  assertEquals(verification.review_assumptions, undefined);
  assertEquals(
    verification.applied_rule_ids.includes(
      "MLB_TEMP_FENCE_CLIENT_SUPPLIED_LABOUR_ONLY",
    ),
    false,
  );
});

Deno.test("client-supplied wording in the draft's own text cannot launder away the MLB hire card", () => {
  // The model wrote "client supplied" into the report and the invoice line. The
  // trade evidence says nothing of the sort, so the hire card still stands.
  const output = normaliseDraftPackOutput({
    report: {
      ...MLB_LABOUR_ONLY_REPORT,
      works:
        "Attended site. Temporary fencing was client supplied, so no hire has been charged.",
      materials: "Nil - client supplied fencing, client's own panels.",
    },
    invoice: {
      ...MLB_LABOUR_ONLY_INVOICE,
      line_items: [{
        description: "Make-safe attendance labour - client supplied fencing",
        quantity: 8,
        unit_price: 85,
      }],
    },
    change_summary: "Billed attendance labour only, customer supplied fencing.",
  });

  const verification = verifyDraftPackOutput(output, {
    job: { site_suburb: "Marangaroo" },
    detail: {
      external_ref: "MLB-26310",
      requesting_company_name: "Major Loss Builders",
    },
    service_report: {
      checklist_json: {
        job_type: "Temporary fencing",
        materials_used: [". x .", "", ". x ."],
        work_done: "Attended site and made the temporary fencing safe.",
      },
    },
  });

  assertEquals(verification.ok, false);
  assert(
    verification.blockers.some((blocker) =>
      /retrieval allowance/i.test(blocker)
    ),
    `expected a retrieval-allowance blocker, got ${
      JSON.stringify(verification.blockers)
    }`,
  );
  assertEquals(verification.review_assumptions, undefined);
  assertEquals(
    verification.applied_rule_ids.includes(
      "MLB_TEMP_FENCE_CLIENT_SUPPLIED_LABOUR_ONLY",
    ),
    false,
  );
});

// --- Review round 1: whose supplies, what shape, which floors ---------------

function mlbLabourOnlyVerification(
  workDone: string,
  overrides: {
    materials_used?: unknown;
    labour_quantity?: number;
    labour_unit_price?: number;
  } = {},
) {
  const output = normaliseDraftPackOutput({
    report: MLB_LABOUR_ONLY_REPORT,
    invoice: {
      ...MLB_LABOUR_ONLY_INVOICE,
      line_items: [{
        description: "Make-safe attendance labour",
        quantity: overrides.labour_quantity ?? 8,
        unit_price: overrides.labour_unit_price ?? 85,
      }],
    },
    change_summary: "Billed attendance labour only.",
  });
  return verifyDraftPackOutput(output, {
    job: { site_suburb: "Marangaroo" },
    detail: {
      external_ref: "MLB-26310",
      requesting_company_name: "Major Loss Builders",
    },
    service_report: {
      checklist_json: {
        job_type: "Temporary fencing",
        materials_used: "materials_used" in overrides
          ? overrides.materials_used
          : [". x .", "", ". x ."],
        work_done: workDone,
      },
    },
  });
}

function assertHireCardStillDemanded(
  verification: ReturnType<typeof verifyDraftPackOutput>,
) {
  assertEquals(verification.ok, false);
  assert(
    verification.blockers.some((blocker) =>
      /retrieval allowance/i.test(blocker)
    ),
    `expected a retrieval-allowance blocker, got ${
      JSON.stringify(verification.blockers)
    }`,
  );
  assertEquals(
    verification.applied_rule_ids.includes(
      "MLB_TEMP_FENCE_CLIENT_SUPPLIED_LABOUR_ONLY",
    ),
    false,
  );
}

Deno.test("'used our own supplies' is SecureWorks-supplied and never unlocks the labour-only path", () => {
  // The old bare "own supplies" phrase matched this, which inverted the gate:
  // the trade is saying WE supplied the fencing, so the builder owes the hire.
  assertHireCardStillDemanded(
    mlbLabourOnlyVerification(
      "Put the temp fencing up, used our own supplies. Made safe on departure.",
    ),
  );
});

Deno.test("a SecureWorks-supplied mention outranks a client phrase in the same report", () => {
  // Ambiguity must fall back to billing the hire card, not withholding it.
  assertHireCardStillDemanded(
    mlbLabourOnlyVerification(
      "Client supplied some of it but we supplied the panels and pickets.",
    ),
  );
});

Deno.test("'client used own supplies' names whose supplies they were and unlocks the labour-only path", () => {
  const verification = mlbLabourOnlyVerification(
    "Client used own supplies for the temp fencing. We attended and made it safe.",
  );

  assertEquals(verification.ok, true);
  assertEquals(verification.blockers, []);
  assert(
    verification.applied_rule_ids.includes(
      "MLB_TEMP_FENCE_CLIENT_SUPPLIED_LABOUR_ONLY",
    ),
  );
  assertEquals(
    verification.review_assumptions?.[0].reason_code,
    "temporary_fence_hire_withheld_client_supplied",
  );
});

Deno.test("the hyphenated 'client-supplied' form matches the spaced phrase list", () => {
  const verification = mlbLabourOnlyVerification(
    "Temp fencing was client-supplied. Attended and made safe.",
  );

  assertEquals(verification.ok, true);
  assert(
    verification.applied_rule_ids.includes(
      "MLB_TEMP_FENCE_CLIENT_SUPPLIED_LABOUR_ONLY",
    ),
  );
});

Deno.test("a materials_used that is present but not a list is unknown, not empty", () => {
  // Trade-app schema drift to an object shape recorded real quantities. Unknown
  // materials must keep the hire card rather than read as "none supplied".
  assertHireCardStillDemanded(
    mlbLabourOnlyVerification(
      "Client's own supplies used for the temp fencing.",
      {
        materials_used: {
          "Temp fence panels": 3,
          "Star picket": 11,
        },
      },
    ),
  );

  // A string shape is equally unreadable and equally refused.
  assertHireCardStillDemanded(
    mlbLabourOnlyVerification(
      "Client's own supplies used for the temp fencing.",
      { materials_used: "Temp fence panels x 3, Star picket x 11" },
    ),
  );
});

Deno.test("the 4-hour solo floor still blocks a client-supplied labour-only draft", () => {
  // The whole safety claim is that no existing gate was weakened. This pins it.
  const verification = mlbLabourOnlyVerification(
    "Client's own supplies used for the temp fencing. Attended and made safe.",
    { labour_quantity: 2 },
  );

  assertEquals(verification.ok, false);
  assert(
    verification.blockers.some((blocker) => /at least 4 hours/i.test(blocker)),
    `expected the solo 4-hour floor to fire, got ${
      JSON.stringify(verification.blockers)
    }`,
  );
  assert(
    verification.blockers.some((blocker) =>
      /not be below 3 hours/i.test(blocker)
    ),
    `expected the 3-hour floor to fire, got ${
      JSON.stringify(verification.blockers)
    }`,
  );
});

Deno.test("the sealed $85 rate is still enforced on the client-supplied labour-only path", () => {
  const verification = mlbLabourOnlyVerification(
    "Client's own supplies used for the temp fencing. Attended and made safe.",
    { labour_unit_price: 95 },
  );

  assertEquals(verification.ok, false);
  assert(
    verification.blockers.some((blocker) => /\$85 ex\/hr/i.test(blocker)),
    `expected the sealed $85 rate to fire, got ${
      JSON.stringify(verification.blockers)
    }`,
  );
});

// --- Review round 2: the phrase must name the supplier ---------------------

Deno.test("an unattributed 'their own supplies' does not unlock the labour-only path", () => {
  // Whose supplies? The pronoun can point at our own crew just as easily as at
  // the builder, so it is not evidence that the client supplied the fence.
  assertHireCardStillDemanded(
    mlbLabourOnlyVerification(
      "Temp fencing was already up, they used their own supplies. Made safe.",
    ),
  );
});

Deno.test("an unattributed possessive 'his own supplies' does not unlock the labour-only path", () => {
  assertHireCardStillDemanded(
    mlbLabourOnlyVerification(
      "Fencing was on site when we arrived, he used his own supplies.",
    ),
  );
});

Deno.test('a bare "client\'s own" without naming the supplies does not unlock the labour-only path', () => {
  assertHireCardStillDemanded(
    mlbLabourOnlyVerification(
      "Attended the client's own property and made the temporary fencing safe.",
    ),
  );
});

Deno.test("'client used their own supplies' names the client and unlocks the labour-only path", () => {
  const verification = mlbLabourOnlyVerification(
    "Client used their own supplies for the temp fencing. We attended and made it safe.",
  );

  assertEquals(verification.ok, true);
  assertEquals(verification.blockers, []);
  assert(
    verification.applied_rule_ids.includes(
      "MLB_TEMP_FENCE_CLIENT_SUPPLIED_LABOUR_ONLY",
    ),
  );
  assertEquals(
    verification.review_assumptions?.[0].reason_code,
    "temporary_fence_hire_withheld_client_supplied",
  );
});

Deno.test("'insured supplied' and 'owner supplied' name the supplier and unlock the labour-only path", () => {
  for (
    const wording of [
      "Temp fencing insured supplied, already standing. Attended and made safe.",
      "Owner supplied the temporary fencing. We attended and made it safe.",
      "Owner's own supplies used for the temp fencing.",
    ]
  ) {
    const verification = mlbLabourOnlyVerification(wording);
    assertEquals(
      verification.ok,
      true,
      `expected ${wording} to unlock, got ${
        JSON.stringify(verification.blockers)
      }`,
    );
    assert(
      verification.applied_rule_ids.includes(
        "MLB_TEMP_FENCE_CLIENT_SUPPLIED_LABOUR_ONLY",
      ),
    );
  }
});

Deno.test("the SecureWorks-supplied guard still outranks a named client phrase", () => {
  // Round 1 behaviour, re-pinned against the tightened phrase list.
  assertHireCardStillDemanded(
    mlbLabourOnlyVerification(
      "Client used their own supplies for some of it, we supplied the rest.",
    ),
  );
});

// --- Real-report check, 11 Sep: the four placeholder shapes ----------------
//
// PHRASE-CHECK-2026-09-11.md read 22 live trade service reports and found
// materials_used placeholders in four shapes: ". x .", ". x 1", "1 x 1" and
// blanks. The old rule only recognised the first and the last, so a real
// client-supplied card carrying ". x 1" or "1 x 1" was read as having recorded
// SecureWorks materials and kept the hire card it did not owe.

Deno.test("every placeholder shape the real-report check found reads as no materials", () => {
  for (
    const materials of [
      [". x ."],
      [". x 1"],
      ["1 x 1"],
      [""],
      [". x .", ". x 1", "1 x 1", ""],
    ]
  ) {
    const verification = mlbLabourOnlyVerification(
      "Client used own supplies for the temp fencing. Attended and made safe.",
      { materials_used: materials },
    );
    assertEquals(
      verification.ok,
      true,
      `expected ${JSON.stringify(materials)} to read as placeholders, got ${
        JSON.stringify(verification.blockers)
      }`,
    );
    assert(
      verification.applied_rule_ids.includes(
        "MLB_TEMP_FENCE_CLIENT_SUPPLIED_LABOUR_ONLY",
      ),
    );
  }
});

Deno.test("a named material is never a placeholder, however short its quantity", () => {
  // "Screws x 20" is the coordinator's case. The other three are verbatim from
  // the real-report check and must all stay on the SecureWorks side.
  for (
    const materials of [
      ["Screws x 20"],
      ["Flashing tape x 1.5m"],
      ["Pollyweave x 45m2"],
      ["starpicket x 4"],
    ]
  ) {
    assertHireCardStillDemanded(
      mlbLabourOnlyVerification(
        "Client used own supplies for the temp fencing. Attended and made safe.",
        { materials_used: materials },
      ),
    );
  }
});

Deno.test("one real material among placeholders still keeps the hire card", () => {
  assertHireCardStillDemanded(
    mlbLabourOnlyVerification(
      "Client used own supplies for the temp fencing. Attended and made safe.",
      { materials_used: [". x .", "Star pickets x 2", "1 x 1"] },
    ),
  );
});

Deno.test("SWMS-261403 verbatim: the one genuine client-supplied card in the corpus", () => {
  // work_done and materials_used copied exactly from the real-report check.
  const verification = mlbLabourOnlyVerification(
    "Stacked up hardy neatly in a pile, client used own supplies to put up temporary fence",
    { materials_used: [". x ."] },
  );

  assertEquals(verification.ok, true);
  assertEquals(verification.blockers, []);
  assert(
    verification.applied_rule_ids.includes(
      "MLB_TEMP_FENCE_CLIENT_SUPPLIED_LABOUR_ONLY",
    ),
  );
  assertEquals(
    verification.review_assumptions?.[0].reason_code,
    "temporary_fence_hire_withheld_client_supplied",
  );
});

Deno.test("SWMS-26508 verbatim: a retrieval attendance keeps the hire card", () => {
  // "picked up temp fencing" with the "1 x 1" placeholder. The placeholder now
  // reads as no materials, but no phrase names a client supplier, so the gate
  // stays locked and the retrieval allowance is still demanded. Generalising
  // the placeholder rule must not open this card.
  assertHireCardStillDemanded(
    mlbLabourOnlyVerification("picked up temp fencing", {
      materials_used: ["1 x 1"],
    }),
  );
});

Deno.test("SWMS-261285 verbatim: 'Photos supplied' never unlocks the labour-only path", () => {
  // A bare "supplied" test would unlock a card where SecureWorks drove seven of
  // its own star pickets. The phrase list requires a named supplier, so it does
  // not, and the recorded star pickets keep the hire card independently.
  assertHireCardStillDemanded(
    mlbLabourOnlyVerification(
      "Stood and secured the existing storm-damaged Colorabond fence. Drove seven star pickets to prop and support the existing fence. Photos supplied from WhatsApp folder.",
      { materials_used: ["Star pickets x 7"] },
    ),
  );
});

Deno.test("SWMS-26585 verbatim: 'Client wanted more protection' never unlocks the labour-only path", () => {
  // A bare "client" test would unlock a three-attendance job where SecureWorks
  // supplied 5 panels, 5 bases, 2 star pickets and 40 zip ties.
  assertHireCardStillDemanded(
    mlbLabourOnlyVerification(
      "3rd attendance, Client wanted more protection, added 4 temporary fence panels creating triangles.",
      {
        materials_used: [
          "fence panels x 5",
          "base x 5",
          "starpicket x 2",
          "zipties x 40",
        ],
      },
    ),
  );
});
