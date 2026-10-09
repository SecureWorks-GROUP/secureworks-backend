// deno-lint-ignore-file no-import-prefix
//
// Ambrose Construct Group intake: adapter selection, the 8-2 purchase-order
// identity grain, make-safe vs repair routing, and the customer fields read off
// its purchase-order PDF. Fixtures are anonymised
// (makesafe_ambrose_intake_fixtures.ts).
import {
  assert,
  assertEquals,
  assertNotEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  adaptDeterministicSource,
  buildDeterministicIntakePlan,
  DETERMINISTIC_ADAPTER_REGISTRY,
  type DeterministicCompanyProfile,
} from "./makesafe_deterministic_intake.ts";
import { deterministicPlanNeedsSupervisedRepairReview } from "./makesafe_deterministic_intake_runtime.ts";
import {
  builderInstructionKey,
  extractBuilderWorkOrderIdentity,
  normaliseAmbroseIdentityText,
} from "./makesafe_builder_work_order_identity.ts";
import { correlateIntakeApprovalIdentity } from "./makesafe_intake_approval_identity.ts";
import {
  ambroseSubjectSiteAddress,
  ambroseSuburbFromAddress,
  readAmbroseWorkOrderFields,
} from "./makesafe_ambrose_work_order.ts";
import { canonicalObligationPoCore } from "../_shared/makesafe_refs.ts";
import {
  AMBROSE_TEST_COMPANY_ID,
  ambroseAcceptancePrompt,
  ambrosePdfText,
  type AmbrosePurchaseOrderFixture,
  ambroseSource,
  ambroseSubject,
} from "./makesafe_ambrose_intake_fixtures.ts";

const PROFILES: DeterministicCompanyProfile[] = [
  {
    id: "11111111-1111-1111-1111-111111111111",
    slug: "mlb",
    name: "ML Builders",
    senderPatterns: ["mlb.test"],
  },
  {
    id: AMBROSE_TEST_COMPANY_ID,
    slug: "acg",
    name: "Ambrose Construct Group",
    senderPatterns: ["ambrose.test"],
  },
];

const MAKE_SAFE: AmbrosePurchaseOrderFixture = {
  job: "20999101",
  sequence: "02",
  address: "12 Example Street Testville WA 6000",
  kind: "make_safe",
};
const REPAIR: AmbrosePurchaseOrderFixture = {
  job: "20999202",
  sequence: "05",
  address: "4/7 Sample Road Demo Park WA 6010",
  kind: "repair",
  updated: true,
};

function onlyCase(postId: string, fixture: AmbrosePurchaseOrderFixture) {
  const plan = buildDeterministicIntakePlan(
    [ambroseSource(postId, fixture)],
    PROFILES,
  );
  assertEquals(plan.cases.length, 1);
  return plan.cases[0];
}

Deno.test("Ambrose is selected by its sender domain or its own subject, ahead of the reference adapters", () => {
  assertEquals(DETERMINISTIC_ADAPTER_REGISTRY.map((a) => a.id).slice(0, 3), [
    "synthetic_livefire",
    "ambrose",
    "mlb",
  ]);
  const bySender = adaptDeterministicSource(
    ambroseSource("by-sender", MAKE_SAFE, {
      subject: "Site access for tomorrow",
    }),
    PROFILES,
  );
  assertEquals(bySender.adapterId, "ambrose");
  const bySubject = adaptDeterministicSource(
    ambroseSource("by-subject", MAKE_SAFE, {
      fromEmail: "relay@forwarder.test",
    }),
    PROFILES,
  );
  assertEquals(bySubject.adapterId, "ambrose");
  assertEquals(bySubject.identity.builderSlug, "acg");
  assertEquals(bySubject.identity.companyId, AMBROSE_TEST_COMPANY_ID);
});

Deno.test("CONTROL: an MLB work order is not taken by the Ambrose adapter", () => {
  const adapted = adaptDeterministicSource(
    ambroseSource("mlb-control", MAKE_SAFE, {
      fromEmail: "dispatch@mlb.test",
      subject: "NEW WORK ORDER - MLB-26499 18 Example Rise, Testville",
      body: "Work Order: MLB-26499PO-56236\nClient: Alex Example",
      attachments: [],
      pdfDocuments: [],
    }),
    PROFILES,
  );
  assertEquals(adapted.adapterId, "mlb");
});

Deno.test("an Ambrose make-safe purchase order becomes a live make-safe with the PO as its instruction", () => {
  const plan = onlyCase("ms-1", MAKE_SAFE);
  assertEquals(plan.state, "confirmed_live_job");
  assertEquals(plan.reasonCode, null);
  assertEquals(plan.identity.jobFamily, "general_makesafe");
  assertEquals(plan.identity.builderSlug, "acg");
  assertEquals(plan.identity.externalRefCanonical, "ACG-20999101");
  assertEquals(plan.identity.builderPoCanonical, "PO-2099910102");
  assertEquals(plan.identity.builderWoCanonical, "ACG-20999101PO-2099910102");
  assertEquals(
    deterministicPlanNeedsSupervisedRepairReview({
      makesafe_job_family: plan.identity.jobFamily,
    }),
    false,
  );
});

Deno.test("an Ambrose repair purchase order becomes a repair, held for a human tick", () => {
  const plan = onlyCase("rp-1", REPAIR);
  assertEquals(plan.state, "confirmed_live_job");
  assertEquals(plan.identity.jobFamily, "repair");
  assertEquals(plan.identity.externalRefCanonical, "ACG-20999202");
  assertEquals(plan.identity.builderPoCanonical, "PO-2099920205");
  // The 2026-08-28 supervised-repair brake still applies: the deterministic
  // lane writes the draft and stops; an operator approval mints the SWR- card.
  assertEquals(
    deterministicPlanNeedsSupervisedRepairReview({
      makesafe_job_family: plan.identity.jobFamily,
    }),
    true,
  );
});

Deno.test("make safe vs repair follows what Ambrose declares, not scope words", () => {
  // A declared make safe whose scope reads like repair work stays a make safe.
  const declaredMakeSafe = onlyCase("ms-replace", {
    ...MAKE_SAFE,
    job: "20999111",
  });
  assertEquals(declaredMakeSafe.identity.jobFamily, "general_makesafe");
  // A repair PO stays repair even when its PDF notes mention a make safe.
  const repairSource = ambroseSource("rp-notes", {
    ...REPAIR,
    job: "20999212",
  });
  const notes = repairSource.pdfDocuments![0];
  const repairPlan = buildDeterministicIntakePlan([{
    ...repairSource,
    pdfDocuments: [{
      ...notes,
      text: `${notes.text}\nMake safe completed by others last week.`,
    }],
  }], PROFILES);
  assertEquals(repairPlan.cases[0].identity.jobFamily, "repair");
});

Deno.test("two purchase orders on one Ambrose job are two instructions", () => {
  const first = onlyCase("po-03", { ...REPAIR, sequence: "03" });
  const second = onlyCase("po-08", { ...REPAIR, sequence: "08" });
  assertEquals(first.identity.externalRefCanonical, "ACG-20999202");
  assertEquals(second.identity.externalRefCanonical, "ACG-20999202");
  assertNotEquals(first.instructionKey, second.instructionKey);
  assertNotEquals(
    canonicalObligationPoCore(first.identity.builderPoCanonical),
    canonicalObligationPoCore(second.identity.builderPoCanonical),
  );
  const key = (po: string | null) =>
    builderInstructionKey(
      extractBuilderWorkOrderIdentity({
        externalRef: po,
        requestingCompanySlug: "acg",
      }),
      { requestingCompanySlug: "acg", family: "repair" },
    );
  assertEquals(key(first.identity.builderWoCanonical), "ACG:PO-2099920203");
  assertEquals(key(second.identity.builderWoCanonical), "ACG:PO-2099920208");

  // Both arriving in one scan stay separate cases.
  const plan = buildDeterministicIntakePlan([
    ambroseSource("both-03", { ...REPAIR, sequence: "03" }),
    ambroseSource("both-08", { ...REPAIR, sequence: "08" }),
  ], PROFILES);
  assertEquals(
    plan.cases.filter((c) => c.state === "confirmed_live_job").length,
    2,
  );
});

Deno.test("the acceptance prompt is accounted as non-work, so it cannot open a PDF-less case", () => {
  const plan = buildDeterministicIntakePlan(
    [ambroseAcceptancePrompt("accept-1", REPAIR)],
    PROFILES,
  );
  assertEquals(plan.cases.length, 1);
  assertEquals(plan.cases[0].state, "accounted_non_wo");
  assertEquals(plan.cases[0].reasonCode, "non_makesafe");
});

Deno.test("an Ambrose email with a job number but no purchase order never becomes live", () => {
  const plan = buildDeterministicIntakePlan([
    ambroseSource("claim-only", MAKE_SAFE, {
      subject: "Ambrose job 20999101 site photos",
      body: "Job Number: 20999101\nPhotos attached.",
      pdfDocuments: [],
      attachments: [],
    }),
  ], PROFILES);
  assertEquals(plan.cases.length, 1);
  assertNotEquals(plan.cases[0].state, "confirmed_live_job");
  assertNotEquals(plan.cases[0].state, "blocked_live_job");
});

Deno.test("customer fields come from the insured's blocks, never our details or the supervisor's", () => {
  const plan = onlyCase("fields-1", REPAIR);
  assertEquals(plan.identity.clientName, "Alex Example");
  assertEquals(plan.identity.clientPhone, "0400000001");
  assertEquals(plan.identity.clientEmail, "alex.example@example.test");
  assertEquals(plan.identity.siteAddress, "4/7 Sample Road Demo Park WA 6010");
  assertEquals(plan.identity.siteSuburb, "Demo Park");
  assert(
    plan.identity.description?.includes("Replace the damaged fascia board"),
  );
  assert(
    !plan.identity.description?.includes("$"),
    "PO price stays off the card",
  );
  assertEquals(
    plan.fieldProvenance.client_phone?.rule,
    "ambrose_purchase_order_pdf:client_phone",
  );
});

Deno.test("the field reader returns null rather than guessing when a block is missing", () => {
  const withoutContacts = ambrosePdfText(MAKE_SAFE)
    .replace(/BEST CONTACT DETAILS[\s\S]*?JOB DETAILS/, "JOB DETAILS");
  const read = readAmbroseWorkOrderFields(withoutContacts);
  assertEquals(read.client_name, "Alex Example");
  assertEquals(read.client_phone, null);
  assertEquals(read.client_email, null);
  assertEquals(read.site_address, "12 Example Street Testville WA 6000");
  assertEquals(readAmbroseWorkOrderFields("").client_name, null);
});

Deno.test("subject address and suburb parsing", () => {
  assertEquals(
    ambroseSubjectSiteAddress(ambroseSubject(MAKE_SAFE)),
    "12 Example Street Testville WA 6000",
  );
  assertEquals(
    ambroseSuburbFromAddress("25 Example Bend Testville Waters WA 6112"),
    "Testville Waters",
  );
  assertEquals(
    ambroseSuburbFromAddress("4/46 Example Street Demo Park WA 6012"),
    "Demo Park",
  );
  assertEquals(
    ambroseSuburbFromAddress("1 Example Place Testvale WA 6171"),
    "Testvale",
  );
  // No street type, or nothing after it: no suburb (the backstop flags it).
  assertEquals(ambroseSuburbFromAddress("Lot 9 Testvale WA 6171"), null);
  assertEquals(ambroseSuburbFromAddress("12 Example Street WA 6000"), null);
  assertEquals(ambroseSuburbFromAddress("12 Example Street, Testville"), null);
});

Deno.test("the Ambrose PO rewrite touches only 8-2 PO-labelled tokens and is idempotent", () => {
  const text = [
    "Purchase Order P.O. No: 20999101-02",
    "Please see attached PO #20999101-02 regarding repairs",
    "Ambrose Construct Group Purchase Order Make Safe: 20999101-02 -  1 X St",
    "Job Number: 20999101",
    "Work Order: MLB-26499PO-56236",
    "PO 56236",
    "TOTAL Purchase Order Price (ex GST) $100.00",
    "P.O. No: 2099910-02",
  ].join("\n");
  const once = normaliseAmbroseIdentityText(text);
  assertEquals(once.split("\n"), [
    "Purchase Order PO ACG-20999101PO-2099910102",
    "Please see attached PO ACG-20999101PO-2099910102 regarding repairs",
    "Ambrose Construct Group PO ACG-20999101PO-2099910102 -  1 X St",
    "Job Number: 20999101",
    "Work Order: MLB-26499PO-56236",
    "PO 56236",
    "TOTAL Purchase Order Price (ex GST) $100.00",
    "P.O. No: 2099910-02",
  ]);
  assertEquals(normaliseAmbroseIdentityText(once), once);
});

Deno.test("CONTROL: without the Ambrose company the shared grammar is unchanged", () => {
  // Read generically, an Ambrose PO keeps only its job number. That collapse is
  // exactly why the rewrite is scoped to slug 'acg'; every other builder sees
  // the grammar it saw before.
  const generic = extractBuilderWorkOrderIdentity({
    subject: "Ambrose Construct Group Purchase Order: 20999202-05 -  1 X St",
  });
  assertEquals(generic.builder_po_number, "PO-20999202");
  const mlb = extractBuilderWorkOrderIdentity({
    requestingCompanySlug: "mlb",
    subject: "NEW WORK ORDER - MLB-26499PO-56236",
  });
  assertEquals(mlb.builder_claim_ref, "MLB-26499");
  assertEquals(mlb.builder_po_number, "PO-56236");
});

Deno.test("approval correlates a runtime-shaped Ambrose draft to one PO-grain key", () => {
  for (
    const [fixture, family] of [[MAKE_SAFE, "general_makesafe"], [
      REPAIR,
      "repair",
    ]] as const
  ) {
    const plan = onlyCase(`approval-${fixture.job}`, fixture);
    // The same fields ensureDraftAndJob writes onto the draft.
    const extraction = {
      builder_claim_ref: plan.identity.externalRefCanonical,
      builder_work_order_number: plan.identity.builderWoCanonical,
      builder_po_number: plan.identity.builderPoCanonical,
      builder_email_subject: ambroseSubject(fixture),
    };
    const decision = correlateIntakeApprovalIdentity({
      extraction,
      approved_external_ref: plan.identity.builderWoCanonical,
      requesting_company_slug: "acg",
      family,
      attachment_names: ["Purchase Order.pdf"],
      document_texts: [ambrosePdfText(fixture)],
    });
    assertEquals(
      decision.action,
      "ready",
      `${family}: ${JSON.stringify(decision)}`,
    );
    if (decision.action !== "ready") continue;
    assertEquals(
      decision.instruction_key,
      `ACG:PO-${fixture.job}${fixture.sequence}`,
    );
  }
});

Deno.test("approval refuses an Ambrose draft whose PDF names a different PO", () => {
  const plan = onlyCase("approval-mismatch", MAKE_SAFE);
  const decision = correlateIntakeApprovalIdentity({
    extraction: {
      builder_claim_ref: plan.identity.externalRefCanonical,
      builder_work_order_number: plan.identity.builderWoCanonical,
      builder_po_number: plan.identity.builderPoCanonical,
    },
    approved_external_ref: plan.identity.builderWoCanonical,
    requesting_company_slug: "acg",
    family: "general_makesafe",
    attachment_names: ["Purchase Order.pdf"],
    document_texts: [ambrosePdfText({ ...MAKE_SAFE, sequence: "07" })],
  });
  assertEquals(decision.action, "refuse");
});
