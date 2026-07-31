// deno-lint-ignore-file no-import-prefix
// Track A deploy-gate fixture: sealed deliverable BWCWA6781 (confirmed live job
// in the sealed truth set) replays as below_identity_floor.
//
// The exact production shape this pins:
//   - job ref `BWCWA6781` appears ONLY in the email subject,
//   - PO number `PO20877` appears ONLY in the attachment filename
//     `work_order_PO20877_Secure_Works_WA.pdf`,
//   - the WO PDF text carries the declared type header.
//
// Writing this fixture DISPROVED the PDF-budget hypothesis: the case files
// below_identity_floor even when the PDF text IS extracted. The mechanism is
// the PO grammar's `\b` word boundaries in makesafe_builder_work_order_identity
// (PO_RE): underscore is a word character, so `PO20877` inside
// `work_order_PO20877_Secure_Works_WA.pdf` has no boundary on either side and
// never matches. The filename PO is invisible, identity stays claim-only
// (subject ref without WO/PO), and the deliverable can never mint. The control
// test below proves the space-separated spelling of the SAME fixture mints
// confirmed_live_job, so the underscore grammar is the entire gap.
//
// The sealed-truth expectation for the exact underscore shape is committed as
// an ignored test pending the fix-scope ruling (needs-decision raised
// 2026-07-31); un-ignore it when the PO grammar fix lands.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildDeterministicIntakePlan,
  type DeterministicCompanyProfile,
  type DeterministicPdfDocument,
  type DeterministicSourceItem,
} from "./makesafe_deterministic_intake.ts";
import { extractBuilderWorkOrderIdentity } from "./makesafe_builder_work_order_identity.ts";

const PROFILES: DeterministicCompanyProfile[] = [
  {
    id: "55555555-5555-5555-5555-555555555555",
    slug: "bw",
    name: "Builderwest",
    senderPatterns: ["builderwest.test"],
  },
];

const POST_ID = "bwcwa-6781-fixture";
const UNDERSCORE_NAME = "work_order_PO20877_Secure_Works_WA.pdf";
const SHA = "bb".repeat(32);

// Mirrors the live BWCWA WO PDF text layer: declared type header up top, then
// the labelled client rows. Deliberately NO ref and NO PO in the text — the
// fixture isolates subject-ref + filename-PO identity.
const WO_PDF_TEXT = [
  "Work Order",
  "Makesafe/Emergency Repairs",
  "Make Safe",
  "Policyholders Name",
  "Fixture Client",
  "Mobile",
  "0400 111 222",
  "Site Address",
  "5 Fixture Street, Perth, WA 6000",
  "Scope of Works",
  "Please attend and make safe the storm damaged ceiling.",
].join("\n");

function fixture(
  options: { extracted: boolean; attachmentName?: string },
): DeterministicSourceItem {
  const name = options.attachmentName ?? UNDERSCORE_NAME;
  const pdfDocument: DeterministicPdfDocument = options.extracted
    ? {
      sourcePostId: POST_ID,
      attachmentId: `${POST_ID}-att`,
      attachmentName: name,
      status: "extracted",
      text: WO_PDF_TEXT,
      charCount: WO_PDF_TEXT.length,
      pageCount: 1,
      extractor: "unpdf",
      truncated: false,
      reason: null,
      sha256: SHA,
    }
    : {
      sourcePostId: POST_ID,
      attachmentId: `${POST_ID}-att`,
      attachmentName: name,
      status: "deferred",
      text: null,
      charCount: 0,
      pageCount: 0,
      extractor: null,
      truncated: false,
      reason: "extraction_budget_exhausted",
      sha256: SHA,
    };
  return {
    postId: POST_ID,
    fromEmail: "dispatch@builderwest.test",
    fromName: null,
    subject:
      "New Make Safe and Report Request - BWCWA6781 - 5 Fixture Street, Perth",
    body: "Please find the work order attached.",
    receivedAt: "2026-07-20T00:00:00.000Z",
    attachments: [{
      id: `${POST_ID}-att`,
      sourcePostId: POST_ID,
      name,
      contentType: "application/pdf",
      storagePath: `${POST_ID}/wo.pdf`,
      status: "uploaded",
      sizeBytes: 64_000,
      sha256: SHA,
    }],
    links: [],
    pdfDocuments: [pdfDocument],
    conversationId: null,
    threadId: null,
    replyToPostId: null,
    relatedPostIds: [],
    siblingPostIds: [],
    direction: "inbound",
    syntheticLivefireMarker: null,
  };
}

const VISIBLE_PARKED_REASONS = [
  "below_identity_floor",
  "wo_ref_without_pdf_pending_review",
  "adapter_parse_failure",
];

// Behaviour 2: extraction budget exhausted -> the source parks VISIBLY as a
// reason-coded exception on the subject ref, never a silent misfile and never
// a live job. Reason tolerance covers the parked spellings before and after
// the PO-grammar fix; the load-bearing claims are the visible exception state
// and full source accounting.
Deno.test("BWCWA6781: unextracted WO PDF parks visibly, never silently", () => {
  const plan = buildDeterministicIntakePlan(
    [fixture({ extracted: false })],
    PROFILES,
  );

  assertEquals(plan.cases.length, 1);
  const parked = plan.cases[0];
  assertEquals(parked.state, "exception");
  assert(
    parked.reasonCode !== null &&
      VISIBLE_PARKED_REASONS.includes(parked.reasonCode),
    `expected a visible parked reason, got ${parked.reasonCode}`,
  );
  // The subject ref survives as the reviewable identity anchor.
  assertEquals(parked.identity.externalRefCanonical, "BWCWA-6781");
  // Full accounting: the source is classified as a reason-coded exception, not
  // dropped.
  assertEquals(plan.totals.unaccounted, 0);
  const classification = plan.sourceClassifications.find((c) =>
    c.postId === POST_ID
  );
  assertEquals(classification?.outcome, "reason_coded_exception");
  assertEquals(classification?.reasonCode, parked.reasonCode);
});

// Mechanism control: the identical fixture with the filename's underscores as
// spaces mints confirmed_live_job from subject ref + filename PO. This is the
// grammar-to-mint path working end to end, proving the underscore spelling is
// the entire gap (and that the PDF budget is NOT the mechanism).
Deno.test("BWCWA6781 control: space-separated filename PO mints the live job", () => {
  const plan = buildDeterministicIntakePlan(
    [fixture({
      extracted: true,
      attachmentName: "work order PO20877 Secure Works WA.pdf",
    })],
    PROFILES,
  );

  assertEquals(plan.cases.length, 1);
  const minted = plan.cases[0];
  assertEquals(minted.state, "confirmed_live_job");
  assertEquals(minted.reasonCode, null);
  assertEquals(minted.identity.externalRefCanonical, "BWCWA-6781");
  assertEquals(minted.identity.builderPoCanonical, "PO-20877");
  assertEquals(minted.identity.builderWoCanonical, "BWCWA-6781PO-20877");
  assertEquals(
    minted.identity.woPoIdentityKey,
    "wo:BWCWA-6781PO-20877/po:PO-20877",
  );
  assertEquals(minted.identity.jobFamily, "general_makesafe");
});

// Behaviour 1 (sealed truth, EXACT underscore shape): extracted WO PDF ->
// deliverable mints, identity resolved from subject ref + filename PO.
// CURRENTLY FAILS: PO_RE's `\b` cannot match `PO20877` between underscores, so
// builder_po_number stays null and the case files below_identity_floor even
// with extraction present. Ignored pending the fix-scope ruling; un-ignore
// alongside the PO grammar fix.
Deno.test({
  name:
    "BWCWA6781 sealed truth: extracted WO PDF mints from subject ref + underscore filename PO",
  ignore: true,
  fn() {
    const plan = buildDeterministicIntakePlan(
      [fixture({ extracted: true })],
      PROFILES,
    );

    assertEquals(plan.cases.length, 1);
    const minted = plan.cases[0];
    assertEquals(minted.state, "confirmed_live_job");
    assertEquals(minted.identity.externalRefCanonical, "BWCWA-6781");
    assertEquals(minted.identity.builderPoCanonical, "PO-20877");

    // The unit-level mechanism the fix must close: the shared identity
    // extractor reads the PO out of the underscore-separated filename.
    const identity = extractBuilderWorkOrderIdentity({
      subject:
        "New Make Safe and Report Request - BWCWA6781 - 5 Fixture Street, Perth",
      attachmentNames: [UNDERSCORE_NAME],
      bodyText: null,
      externalRef: null,
    });
    assertEquals(identity.builder_claim_ref, "BWCWA-6781");
    assertEquals(identity.builder_po_number, "PO-20877");
  },
});
