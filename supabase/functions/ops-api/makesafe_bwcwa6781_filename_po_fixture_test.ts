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
// Writing this fixture DISPROVED the PDF-budget hypothesis: the case filed
// below_identity_floor even when the PDF text WAS extracted. The mechanism is
// the PO grammar's `\b` word boundaries in makesafe_builder_work_order_identity
// (PO_RE): underscore is a word character, so `PO20877` inside
// `work_order_PO20877_Secure_Works_WA.pdf` had no boundary on either side and
// never matched. The filename PO was invisible, identity stayed claim-only
// (subject ref without WO/PO), and the deliverable could never mint.
//
// Fixed under the 2026-07-31 ruling by normalising underscores to spaces for
// attachment NAMES only (attachmentNameScanText). The scope boundary is itself
// pinned below: the same token in body text still yields no PO.
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
const SUBJECT =
  "New Make Safe and Report Request - BWCWA6781 - 5 Fixture Street, Perth";
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
    subject: SUBJECT,
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

// The space-separated filename spelling parsed correctly before the fix and
// must still parse after it: normalisation rewrites underscores into exactly
// this shape, so this is the guard that the rewrite target stays valid.
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
Deno.test("BWCWA6781 sealed truth: extracted WO PDF mints from subject ref + underscore filename PO", () => {
  const plan = buildDeterministicIntakePlan(
    [fixture({ extracted: true })],
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
  assertEquals(
    plan.sourceClassifications.find((c) => c.postId === POST_ID)?.outcome,
    "confirmed_canonical_input",
  );

  // The unit-level mechanism the fix closes: the shared identity extractor
  // reads the PO out of the underscore-separated filename.
  const identity = extractBuilderWorkOrderIdentity({
    subject: SUBJECT,
    attachmentNames: [UNDERSCORE_NAME],
    bodyText: null,
    externalRef: null,
  });
  assertEquals(identity.builder_claim_ref, "BWCWA-6781");
  assertEquals(identity.builder_po_number, "PO-20877");
  assertEquals(identity.builder_work_order_number, "BWCWA-6781PO-20877");
});

// The deliberate scope boundary of the fix (option (a), ruled 2026-07-31):
// underscore separation is normalised for attachment NAMES only. The same token
// in body/PDF text still yields no PO, because the verified Track A replay fates
// were computed under the current text-matching behaviour and a grammar-wide
// boundary relaxation could move fates beyond this one sealed row. If that wider
// change is ever ruled in, this test is the one that must be revisited.
Deno.test("underscored PO in BODY text stays unparsed: the fix is filename-scoped", () => {
  const fromBody = extractBuilderWorkOrderIdentity({
    subject: SUBJECT,
    attachmentNames: [],
    // A labelled line, so the body scan genuinely reaches this text and the
    // null PO is the grammar's answer rather than the line filter's.
    bodyText: ["Work Order attached", UNDERSCORE_NAME].join("\n"),
    externalRef: null,
  });
  assertEquals(fromBody.builder_claim_ref, "BWCWA-6781");
  assertEquals(fromBody.builder_po_number, null);
  assertEquals(fromBody.builder_work_order_number, null);

  // Same bytes, now as the attachment name: the PO resolves. One input differs.
  const fromName = extractBuilderWorkOrderIdentity({
    subject: SUBJECT,
    attachmentNames: [UNDERSCORE_NAME],
    bodyText: null,
    externalRef: null,
  });
  assertEquals(fromName.builder_po_number, "PO-20877");
});

// A PO-shaped postal address must not become identity just because filename
// underscores now separate words: "PO Box 1234" still carries no PO number.
Deno.test("filename normalisation does not turn PO Box into a purchase order", () => {
  const identity = extractBuilderWorkOrderIdentity({
    subject: SUBJECT,
    attachmentNames: ["remittance_PO_Box_1234_Secure_Works_WA.pdf"],
    bodyText: null,
    externalRef: null,
  });
  assertEquals(identity.builder_po_number, null);
});
