// deno-lint-ignore-file no-import-prefix
/**
 * Intake work-order reference parse — conservative typed-field fill.
 *
 * What these tests establish:
 * - The sealed builder/PO grammars extract the live Clements WO shape
 *   (filename + labelled PDF text) into builder_claim_ref / builder_po_number
 *   with parse provenance.
 * - Ambiguous multi-candidate documents, and filename-vs-body disagreement,
 *   write NOTHING (empty identity) rather than first-match guessing.
 * - Already-set typed fields are never overwritten.
 * - Approval correlation can consume PDF text (not only attachment names) and
 *   still refuses multi-key ambiguity.
 *
 * What these tests do NOT establish:
 * - Live PostgREST / production job mint (ops-api tests mock the database).
 * - That any historical card (including SWMS-26804) is backfilled — out of
 *   scope; only forward intake is covered.
 * - That update_job_field can write builder_po_number (it cannot and must not
 *   be widened for this fix).
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  applyParsedWorkOrderReferenceToExtraction,
  parseWorkOrderReferenceFromEvidence,
} from "./makesafe_builder_work_order_identity.ts";
import { correlateIntakeApprovalIdentity } from "./makesafe_intake_approval_identity.ts";

/** Labelled identity lines from the live Clements SWMS-26804 work-order PDF
 *  (pdftotext of the public job-documents object, 2026-08-04). Client PII is
 *  deliberately omitted — only business reference rows. */
const CLEMENTS_WO_PDF_TEXT = `
Work Order
Work Order Assigned                      Secureworks Group Pty Ltd     Work Order Number        MLB-26012PO-54537
Job Number                               MLB-26012                     Date                     25/06/2026
Additional                              Allocation Work Order
Notes/Instructions:
MLB-26012PO-54537
Makesafe/Emergency Repairs
Make Safe
Please attend site, dismantle shed and stack on site
By accepting this Offer "Purchase order" you are aware to the terms outlined as below are accepted
`.trim();

const CLEMENTS_FILENAME =
  "work_order_MLB-26012PO-54537_Secureworks_Group_Pty_Ltd.pdf";

Deno.test("Clements WO filename alone fills typed claim + PO with parse provenance", () => {
  const parse = parseWorkOrderReferenceFromEvidence({
    attachmentNames: [CLEMENTS_FILENAME],
  });
  assertEquals(parse.action, "filled");
  if (parse.action !== "filled") return;
  assertEquals(parse.identity.builder_claim_ref, "MLB-26012");
  assertEquals(parse.identity.builder_po_number, "PO-54537");
  assertEquals(
    parse.identity.builder_work_order_number,
    "MLB-26012PO-54537",
  );
  assertEquals(parse.identity.evidence_sources, ["attachment_name"]);

  const extraction = applyParsedWorkOrderReferenceToExtraction({}, parse);
  assertEquals(extraction.builder_claim_ref, "MLB-26012");
  assertEquals(extraction.builder_po_number, "PO-54537");
  assertEquals(extraction.builder_po_number_source, "parsed_work_order_evidence");
  assertEquals(
    extraction.builder_claim_ref_source,
    "parsed_work_order_evidence",
  );
  assertEquals(
    extraction.builder_work_order_identity_sources,
    ["attachment_name"],
  );
});

Deno.test("Clements WO labelled PDF text alone fills the same typed identity", () => {
  const parse = parseWorkOrderReferenceFromEvidence({
    documentTexts: [CLEMENTS_WO_PDF_TEXT],
  });
  assertEquals(parse.action, "filled");
  if (parse.action !== "filled") return;
  assertEquals(parse.identity.builder_claim_ref, "MLB-26012");
  assertEquals(parse.identity.builder_po_number, "PO-54537");
  assertEquals(parse.identity.evidence_sources, ["work_order_pdf_text"]);
});

Deno.test("Clements filename + PDF text agree and fill once (no conflict)", () => {
  const parse = parseWorkOrderReferenceFromEvidence({
    attachmentNames: [CLEMENTS_FILENAME],
    documentTexts: [CLEMENTS_WO_PDF_TEXT],
    externalRef: "MLB-26012",
    requestingCompanySlug: "mlb",
  });
  assertEquals(parse.action, "filled");
  if (parse.action !== "filled") return;
  assertEquals(parse.identity.builder_claim_ref, "MLB-26012");
  assertEquals(parse.identity.builder_po_number, "PO-54537");
  assertEquals(
    new Set(parse.identity.evidence_sources),
    new Set(["attachment_name", "work_order_pdf_text", "external_ref"]),
  );
});

Deno.test("ambiguous multi-PO document parses to NOTHING (not first-match)", () => {
  const ambiguous = `
Work Order Number: MLB-26012PO-54537
Job Number: MLB-26012
Work Order Number: MLB-99999PO-11111
Job Number: MLB-99999
`.trim();
  const parse = parseWorkOrderReferenceFromEvidence({
    documentTexts: [ambiguous],
  });
  assertEquals(parse.action, "empty");
  if (parse.action !== "empty") return;
  assertEquals(
    parse.reason === "ambiguous_claim" ||
      parse.reason === "ambiguous_po" ||
      parse.reason === "source_disagreement",
    true,
  );
  assertEquals(parse.identity.builder_claim_ref, null);
  assertEquals(parse.identity.builder_po_number, null);
  assertEquals(parse.identity.builder_work_order_number, null);

  const extraction = applyParsedWorkOrderReferenceToExtraction(
    { external_ref: null },
    parse,
  );
  assertEquals(extraction.builder_claim_ref, undefined);
  assertEquals(extraction.builder_po_number, undefined);
  assertEquals(extraction.builder_work_order_identity_parse_reason, parse.reason);
});

Deno.test("filename vs labelled body disagreement writes NOTHING", () => {
  const parse = parseWorkOrderReferenceFromEvidence({
    attachmentNames: [CLEMENTS_FILENAME],
    documentTexts: [
      "Work Order Number: MLB-99999PO-11111\nJob Number: MLB-99999",
    ],
  });
  assertEquals(parse.action, "empty");
  if (parse.action !== "empty") return;
  assertEquals(parse.reason, "source_disagreement");
  assertEquals(parse.identity.builder_po_number, null);
  assertEquals(parse.po_candidates.sort(), ["PO-11111", "PO-54537"]);
});

Deno.test("already-set typed PO is never overwritten by a parse", () => {
  const parse = parseWorkOrderReferenceFromEvidence({
    attachmentNames: [CLEMENTS_FILENAME],
  });
  assertEquals(parse.action, "filled");
  const extraction = applyParsedWorkOrderReferenceToExtraction(
    {
      builder_claim_ref: "MLB-HUMAN",
      builder_po_number: "PO-HUMAN",
      builder_work_order_number: "MLB-HUMANPO-HUMAN",
      builder_po_number_source: "human_review",
    },
    parse,
  );
  assertEquals(extraction.builder_claim_ref, "MLB-HUMAN");
  assertEquals(extraction.builder_po_number, "PO-HUMAN");
  assertEquals(extraction.builder_work_order_number, "MLB-HUMANPO-HUMAN");
  assertEquals(extraction.builder_po_number_source, "human_review");
});

Deno.test("approval correlation fills typed PO from Clements PDF text without a named attachment", () => {
  const decision = correlateIntakeApprovalIdentity({
    extraction: { external_ref: "MLB-26012" },
    approved_external_ref: "MLB-26012",
    requesting_company_slug: "mlb",
    family: "general_makesafe",
    // Attachment present but identity-free name — PDF text must carry the PO.
    attachment_names: ["WorkOrder.pdf"],
    document_texts: [CLEMENTS_WO_PDF_TEXT],
  });
  assertEquals(decision.action, "ready");
  if (decision.action !== "ready") return;
  assertEquals(decision.identity_completed, true);
  assertEquals(decision.instruction_key, "MLB:PO-54537");
  assertEquals(decision.extraction.builder_claim_ref, "MLB-26012");
  assertEquals(decision.extraction.builder_po_number, "PO-54537");
  assertEquals(
    decision.extraction.builder_po_number_source,
    "parsed_work_order_evidence",
  );
});

Deno.test("approval correlation refuses when PDF text is deliberately ambiguous", () => {
  const decision = correlateIntakeApprovalIdentity({
    extraction: {},
    approved_external_ref: "MLB-26012",
    requesting_company_slug: "mlb",
    family: "general_makesafe",
    attachment_names: ["WorkOrder.pdf"],
    document_texts: [
      "Work Order Number: MLB-26012PO-54537\nWork Order Number: MLB-26012PO-99999",
    ],
  });
  assertEquals(decision.action, "refuse");
  if (decision.action !== "refuse") return;
  assertEquals(
    decision.reason === "multiple_instruction_keys" ||
      decision.reason === "source_identity_conflict" ||
      decision.reason === "typed_identity_not_persistable",
    true,
  );
});
