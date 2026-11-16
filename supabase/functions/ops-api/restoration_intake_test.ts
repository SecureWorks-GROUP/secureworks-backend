// deno-lint-ignore-file no-import-prefix
//
// Restoration intake (owner's word 12 Nov 2026: restoration work is accepted
// through ses@). The fixture mirrors the text layer of ML Builders' live
// restoration work orders (MLR-41228 PO-64545 and MLB-40707 PO-64727, read
// 12 Nov 2026) with invented people and addresses.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  adaptDeterministicSource,
  buildDeterministicIntakePlan,
  type DeterministicCompanyProfile,
  type DeterministicSourceItem,
} from "./makesafe_deterministic_intake.ts";
import {
  builderInstructionKey,
  extractBuilderWorkOrderIdentity,
} from "./makesafe_builder_work_order_identity.ts";
import { canonicalMakesafeInvoiceContactName } from "./makesafe_invoice_contact.ts";

const PROFILES: DeterministicCompanyProfile[] = [
  {
    id: "11111111-1111-1111-1111-111111111111",
    slug: "mlb",
    name: "ML Builders",
    senderPatterns: ["mlb.mailer@primeeco.tech"],
  },
  {
    id: "33333333-3333-3333-3333-333333333333",
    slug: "prime",
    name: "Prime",
    senderPatterns: ["prime.test"],
  },
];

const EMAIL_BODY = [
  "Hi Team,",
  "You've been assigned the above work order for Job MLR-40001, for site 1 EXAMPLE WAY, Lynwood, WA 6147.",
  "Please contact the main contact as soon as possible to schedule the required works.",
  "Upon completion of the works, the following documents must be submitted:",
  "Before and after photos",
  "Safe Work Method Statement (SWMS)",
  "Tax Invoice",
  "Kind regards,",
  "Example Coordinator",
  "Restoration Co-Ordinator",
].join("\n");

function workOrderPdfText(input: {
  workOrder: string;
  job: string;
  scope: string[];
}): string {
  return [
    "Work Order",
    `Work Order Assigned Secureworks Group Pty Ltd Work Order Number ${input.workOrder}`,
    `Job Number ${input.job} Date 09/11/2026`,
    "Supervisor Name Example Supervisor Supervisor Contact 08 6263 0940",
    "Admin Name Example Admin Office Contact 08 6263 0940",
    "Policyholders Name JORDAN EXAMPLE",
    "Policyholders Contact Mobile: 0400111222 Home: Email:",
    "jordan.example@example.com",
    "Insurer Name Example Insurance Pty Ltd",
    "Site Address 1 EXAMPLE WAY, Lynwood, WA 6147",
    "Other Contact Details",
    "(Tenant)",
    "Name Contact",
    "Additional",
    "Notes/Instructions:",
    "Allocation Work Order",
    input.workOrder,
    "Restoration",
    "Restoration",
    ...input.scope,
    "Totals Totals",
    "Subtotal $0.00",
    "GST N/A",
    "Total $0.00",
    "Major LB Pty Ltd",
    "PLEASE NOTE",
    "By accepting this Offer “Purchase order” you are aware to the terms outlined as below are accepted.",
  ].join("\n");
}

function restorationSource(input: {
  postId: string;
  job: string;
  po: string;
  scope: string[];
}): DeterministicSourceItem {
  const workOrder = `${input.job}PO-${input.po}`;
  const attachmentName =
    `work_order_${workOrder}_Secureworks_Group_Pty_Ltd.pdf`;
  return {
    postId: input.postId,
    fromEmail: "mlb.mailer@primeeco.tech",
    fromName: "ML Builders",
    subject:
      `NEW WORK ORDER - ${input.job} | 1 EXAMPLE WAY, Lynwood, WA 6147`,
    body: EMAIL_BODY.replace("MLR-40001", input.job),
    receivedAt: "2026-11-09T05:44:57.000Z",
    attachments: [{
      id: `${input.postId}-pdf`,
      sourcePostId: input.postId,
      name: attachmentName,
      contentType: "application/pdf",
      storagePath: `${input.postId}/wo.pdf`,
      status: "uploaded",
      sizeBytes: 153403,
    }],
    links: [],
    pdfDocuments: [{
      sourcePostId: input.postId,
      attachmentId: `${input.postId}-pdf`,
      attachmentName,
      status: "extracted",
      text: workOrderPdfText({
        workOrder,
        job: input.job,
        scope: input.scope,
      }),
      charCount: 9000,
      pageCount: 3,
      extractor: "unpdf@1.6.2",
      truncated: false,
      reason: null,
    }],
    conversationId: null,
    threadId: null,
    replyToPostId: null,
    relatedPostIds: [],
    siblingPostIds: [],
    syntheticLivefireMarker: null,
  };
}

const ASSESS_SCOPE = [
  "Please attend to inspect damage to the bedroom - Water started coming from under the carpet in a bedroom.",
  "Please provide a quote for structural drying (expected to be carpet removal/disposal, wall scrapes & drying equipment). Please cap drying equipment at 5 days.",
  "DAL (designated authority limit) - $1k for initial attendance.",
];
const DO_AND_CHARGE_SCOPE = [
  "Please attend to remove the activity room cabinetry that is situated against a wet wall. If you can salvage it, please leave it on site. If it is damaged, please dispose",
  "of it.",
];

Deno.test("restoration intake: the MLR job-number series is ML Builders' own identity", () => {
  const identity = extractBuilderWorkOrderIdentity({
    attachmentNames: ["work_order_MLR-40001PO-60001_Secureworks_Group_Pty_Ltd.pdf"],
    subject: "NEW WORK ORDER - MLR-40001 | 1 EXAMPLE WAY, Lynwood, WA 6147",
    bodyText: "Job MLR-40001",
  });
  assertEquals(identity.builder_claim_ref, "MLR-40001");
  assertEquals(identity.builder_po_number, "PO-60001");
  assertEquals(identity.builder_work_order_number, "MLR-40001PO-60001");
  // One scope with MLB: the purchase order is the key, the claim is the group.
  assertEquals(
    builderInstructionKey(identity),
    "MLB:PO-60001",
  );
  assertEquals(
    canonicalMakesafeInvoiceContactName("MLR-40001PO-60001", "mlb"),
    "Major Loss Builders",
  );
});

Deno.test("restoration intake: an MLR assess-and-quote work order plans a live restoration job", () => {
  const item = restorationSource({
    postId: "mlr-assess",
    job: "MLR-40001",
    po: "60001",
    scope: ASSESS_SCOPE,
  });
  const adapted = adaptDeterministicSource(item, PROFILES);
  assertEquals(adapted.adapterId, "mlb");
  assertEquals(adapted.identity.externalRefCanonical, "MLR-40001");
  assertEquals(adapted.identity.builderPoCanonical, "PO-60001");
  const plan = buildDeterministicIntakePlan([item], PROFILES);
  const intakeCase = plan.cases[0];
  assertEquals(plan.aiCalls, 0);
  assertEquals(intakeCase.identity.jobFamily, "restoration");
  assertEquals(intakeCase.identity.clientName, "JORDAN EXAMPLE");
  assertEquals(intakeCase.identity.clientPhone, "0400111222");
  assertEquals(intakeCase.state, "confirmed_live_job");
  assertEquals(intakeCase.reasonCode, null);
});

Deno.test("restoration intake: an MLB-numbered restoration work order is restoration too", () => {
  const item = restorationSource({
    postId: "mlb-do-and-charge",
    job: "MLB-40002",
    po: "60002",
    scope: DO_AND_CHARGE_SCOPE,
  });
  const plan = buildDeterministicIntakePlan([item], PROFILES);
  const intakeCase = plan.cases[0];
  assertEquals(intakeCase.adapterId, "mlb");
  assertEquals(intakeCase.identity.externalRefCanonical, "MLB-40002");
  assertEquals(intakeCase.identity.jobFamily, "restoration");
  assertEquals(intakeCase.state, "confirmed_live_job");
});
