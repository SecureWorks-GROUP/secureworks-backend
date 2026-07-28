// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  adaptDeterministicSource,
  buildDeterministicIntakePlan,
  DETERMINISTIC_ADAPTER_REGISTRY,
  type DeterministicCompanyProfile,
  deterministicModeAllowsAiFallback,
  type DeterministicSourceItem,
  measureDeterministicIntakeQuality,
  selectIntakeMode,
} from "./makesafe_deterministic_intake.ts";
import {
  loadDeterministicIntakeMode,
} from "./makesafe_deterministic_intake_runtime.ts";

const PROFILES: DeterministicCompanyProfile[] = [
  {
    id: "11111111-1111-1111-1111-111111111111",
    slug: "mlb",
    name: "MLB",
    senderPatterns: ["mlb.test"],
  },
  {
    id: "22222222-2222-2222-2222-222222222222",
    slug: "aj",
    name: "AJS / AJBR",
    senderPatterns: ["ajs.test", "ajbr.test"],
  },
  {
    id: "33333333-3333-3333-3333-333333333333",
    slug: "prime",
    name: "Prime",
    senderPatterns: ["prime.test"],
  },
  {
    id: "44444444-4444-4444-4444-444444444444",
    slug: "rapid",
    name: "RAPID Repair",
    senderPatterns: ["rapid.test"],
  },
  {
    id: "55555555-5555-5555-5555-555555555555",
    slug: "bw",
    name: "Builderwest",
    senderPatterns: ["builderwest.test", "primeeco.test"],
  },
  {
    id: "66666666-6666-6666-6666-666666666666",
    slug: "wb",
    name: "Western Building",
    senderPatterns: ["western.test"],
  },
  {
    id: "00000000-0000-0000-0000-000000000099",
    slug: "synthetic-livefire",
    name: "SecureWorks Synthetic Live-Fire Builder (TEST ONLY)",
    senderPatterns: [],
  },
];

function source(
  input: Partial<DeterministicSourceItem> & { postId: string },
): DeterministicSourceItem {
  return {
    postId: input.postId,
    fromEmail: input.fromEmail ?? "dispatch@mlb.test",
    fromName: input.fromName ?? null,
    subject: input.subject ?? "",
    body: input.body ?? "",
    receivedAt: input.receivedAt ?? "2026-07-20T00:00:00.000Z",
    attachments: input.attachments ?? [],
    links: input.links ?? [],
    pdfDocuments: input.pdfDocuments ?? [],
    conversationId: input.conversationId ?? null,
    threadId: input.threadId ?? null,
    replyToPostId: input.replyToPostId ?? null,
    relatedPostIds: input.relatedPostIds ?? [],
    siblingPostIds: input.siblingPostIds ?? [],
    direction: input.direction,
    syntheticLivefireMarker: input.syntheticLivefireMarker ?? null,
  };
}

function pdf(postId: string, id = `${postId}-pdf`) {
  return {
    id,
    sourcePostId: postId,
    name: "Work Order.pdf",
    contentType: "application/pdf",
    storagePath: `${postId}/wo.pdf`,
    status: "uploaded",
    sizeBytes: 1200,
  };
}

Deno.test("registry keeps specific builder adapters ahead of shared Prime transport", () => {
  assertEquals(DETERMINISTIC_ADAPTER_REGISTRY.map((a) => a.id), [
    "synthetic_livefire",
    "mlb",
    "ajs_ajbr",
    "western",
    "builderwest",
    "prime",
    "rapid",
    "chatter",
  ]);
});

Deno.test("authorized synthetic adapter wins first and preserves the cleanup marker", () => {
  const marker = "SWG-SES-LIVEFIRE-TEST-ONLY-RUN-20260727-001";
  const item = source({
    postId: "synthetic-livefire-1",
    fromEmail: "marnin@secureworkswa.com.au",
    subject:
      `${marker} NEW WORK ORDER Work Order: SYNTHLIVE-0123456789AB-001 PO: 990001`,
    body:
      "Client: Synthetic Test Client\nSite Address: 1 Test Lab Road, Perth\nScope: Install temporary roof tarp.",
    attachments: [pdf("synthetic-livefire-1")],
    direction: "inbound",
    syntheticLivefireMarker: marker,
  });
  const adapted = adaptDeterministicSource(item, PROFILES);
  assertEquals(adapted.adapterId, "synthetic_livefire");
  assertEquals(adapted.identity.builderSlug, "synthetic-livefire");
  assertEquals(
    adapted.identity.externalRefCanonical,
    "SYNTHLIVE-0123456789AB-001",
  );
  assertEquals(
    adapted.identity.builderWoCanonical,
    "SYNTHLIVE-0123456789AB-001",
  );
  assertEquals(adapted.identity.builderPoCanonical, "PO-990001");
  assertEquals(adapted.identity.syntheticLivefireMarker, marker);
});

Deno.test("signed synthetic correction fixture is a revision, not correction-token chatter", () => {
  const marker = "SWG-SES-LIVEFIRE-TEST-ONLY-RUN-20260727-002";
  const original = source({
    postId: "synthetic-roof-original",
    fromEmail: "marnin@secureworkswa.com.au",
    subject:
      `${marker} [FIXTURE:ROOF] NEW WORK ORDER Work Order: SYNTHLIVE-0123456789AB-002 Roof Report`,
    body:
      "Client: Synthetic Test Client\nSite Address: 2 Test Lab Road, Perth\nRoof Report: https://synthetic.invalid/roof",
    attachments: [pdf("synthetic-roof-original")],
    direction: "inbound",
    syntheticLivefireMarker: marker,
  });
  const correction = source({
    postId: "synthetic-roof-correction",
    fromEmail: "marnin@secureworkswa.com.au",
    subject:
      `${marker} [FIXTURE:CORRECTION] REVISED WORK ORDER Work Order: SYNTHLIVE-0123456789AB-002 Roof Report`,
    body:
      "This revised work order supersedes the earlier instruction.\nClient: Synthetic Test Client\nSite Address: 2 Test Lab Road, Perth\nRoof Report: https://synthetic.invalid/roof-revised",
    receivedAt: "2026-07-20T00:01:00.000Z",
    attachments: [pdf("synthetic-roof-correction")],
    direction: "inbound",
    syntheticLivefireMarker: marker,
  });
  assertEquals(
    adaptDeterministicSource(correction, PROFILES).intent,
    "revision",
  );
  const plan = buildDeterministicIntakePlan(
    [original, correction],
    PROFILES,
  );
  const revision = plan.cases.find((intakeCase) =>
    intakeCase.sourcePostIds.includes("synthetic-roof-correction")
  );
  assert(revision);
  assertEquals(revision.parentRelation, "revision_of");
  assertNotEquals(revision.state, "accounted_non_wo");
});

Deno.test("MLB adapter builds a confirmed identity without AI", () => {
  const item = source({
    postId: "mlb-1",
    subject: "NEW WORK ORDER MLB-27037 Work Order: WO#27037 PO: 9182",
    body:
      "Client: Test Client\nSite Address: 10 Test Street, Perth\nPhone: 0400000000",
    attachments: [pdf("mlb-1")],
  });
  const adapted = adaptDeterministicSource(item, PROFILES);
  assertEquals(adapted.adapterId, "mlb");
  assertEquals(adapted.identity.builderWoCanonical, "WO-27037");
  assertEquals(adapted.identity.builderPoCanonical, "PO-9182");
  const plan = buildDeterministicIntakePlan([item], PROFILES);
  assertEquals(plan.cases[0].state, "confirmed_live_job");
  assertEquals(plan.aiCalls, 0);
});

Deno.test("PDF text gap-fills an email-only shell and retains field provenance", () => {
  const item = source({
    postId: "mlb-pdf-fill",
    subject: "NEW WORK ORDER",
    body: "Please attend as instructed. The work order is attached.",
    attachments: [pdf("mlb-pdf-fill", "pdf-fill-attachment")],
    pdfDocuments: [{
      sourcePostId: "mlb-pdf-fill",
      attachmentId: "pdf-fill-attachment",
      attachmentName: "MLB Work Order.pdf",
      status: "extracted",
      text: `Work Order Number
MLB-26770PO-55296
Policyholders Name
Amanda Parker
Mobile: 0422 636 182
Site Address
8 Syrinx Pl, Mullaloo, WA 6027
Scope of Works
Install temporary roof tarps and make the storm-damaged property safe.
Notes
Contact the supervisor after attendance.`,
      charCount: 300,
      pageCount: 1,
      extractor: "unpdf@1.6.2",
      truncated: false,
      reason: null,
    }],
  });
  const plan = buildDeterministicIntakePlan([item], PROFILES);
  const intakeCase = plan.cases[0];
  assertEquals(plan.aiCalls, 0);
  assertEquals(intakeCase.state, "confirmed_live_job");
  assertEquals(intakeCase.identity.externalRefCanonical, "MLB-26770");
  assertEquals(intakeCase.identity.clientName, "Amanda Parker");
  assertEquals(intakeCase.identity.clientPhone, "0422636182");
  assertEquals(
    intakeCase.identity.siteAddress,
    "8 Syrinx Pl, Mullaloo, WA 6027",
  );
  assertEquals(intakeCase.identity.siteSuburb, "Mullaloo");
  assertEquals(
    intakeCase.identity.description,
    "Install temporary roof tarps and make the storm-damaged property safe.",
  );
  assertEquals(
    intakeCase.fieldProvenance.client_name?.attachmentId,
    "pdf-fill-attachment",
  );
  assertEquals(
    intakeCase.fieldProvenance.external_ref?.source,
    "work_order_pdf_text",
  );
  assertEquals(
    intakeCase.pdfDocuments[0].text?.includes("Amanda Parker"),
    true,
  );
});

Deno.test("every known builder can source labelled customer fields from work-order PDF text", () => {
  const builders = [
    {
      postId: "mlb-pdf-source",
      fromEmail: "dispatch@mlb.test",
      subject: "NEW WORK ORDER MLB-27101 Work Order: 27101",
      expectedAdapter: "mlb",
    },
    {
      postId: "ajs-pdf-source",
      fromEmail: "dispatch@ajs.test",
      subject: "Make Safe - Dianella - Job No 70101",
      expectedAdapter: "ajs_ajbr",
    },
    {
      postId: "bw-pdf-source",
      fromEmail: "dispatch@builderwest.test",
      subject: "70101 - BWCWA70101 - PDF Client - Dianella",
      expectedAdapter: "builderwest",
    },
    {
      postId: "wb-pdf-source",
      fromEmail: "dispatch@western.test",
      subject: "Make Safe Work Order: WB70101 | PDF Client | Dianella",
      expectedAdapter: "western",
    },
  ] as const;
  for (const builder of builders) {
    const attachment = pdf(builder.postId, `${builder.postId}-attachment`);
    const item = source({
      postId: builder.postId,
      fromEmail: builder.fromEmail,
      subject: builder.subject,
      body: "The work order is attached.",
      attachments: [attachment],
      pdfDocuments: [{
        sourcePostId: builder.postId,
        attachmentId: attachment.id,
        attachmentName: attachment.name,
        status: "extracted",
        text: `Policyholders Name
PDF Client & Mr PDF Client
Mobile
0400 123 456
Site Address
17 PDF Street, Dianella, WA 6059
Scope of Works
Make safe the storm damage.`,
        charCount: 180,
        pageCount: 1,
        extractor: "unpdf@1.6.2",
        truncated: false,
        reason: null,
      }],
    });
    const adapted = adaptDeterministicSource(item, PROFILES);
    assertEquals(adapted.adapterId, builder.expectedAdapter);
    assertEquals(adapted.identity.clientName, "PDF Client & Mr PDF Client");
    assertEquals(adapted.identity.clientPhone, "0400123456");
    assert(
      adapted.identity.description?.includes("Make safe the storm damage"),
    );
    assertEquals(
      adapted.pdfFieldProvenance.client_name?.source,
      "work_order_pdf_text",
    );
    assertEquals(
      adapted.pdfFieldProvenance.description?.source,
      "work_order_pdf_text",
    );
  }
});

Deno.test("AJS Contact label captures ampersand-separated policyholders", () => {
  const item = source({
    postId: "ajs-contact-name",
    fromEmail: "dispatch@ajs.test",
    subject: "Make Safe - Stirling - Job No 70102",
    body: [
      "Contact: Laura Audino & Mr Anthony Audino",
      "Site Address: 23 Plover Way, Stirling",
      "Mobile: 0412 345 678",
    ].join("\n"),
    attachments: [pdf("ajs-contact-name")],
  });
  const adapted = adaptDeterministicSource(item, PROFILES);
  assertEquals(adapted.adapterId, "ajs_ajbr");
  assertEquals(
    adapted.identity.clientName,
    "Laura Audino & Mr Anthony Audino",
  );
});

Deno.test("builder office contacts are denied before customer contact selection", () => {
  const cases = [
    source({
      postId: "mlb-office-contact",
      fromEmail: "dispatch@mlb.test",
      subject: "NEW WORK ORDER MLB-27103 Work Order: 27103",
      body: [
        "Client: MLB Customer",
        "Site Address: 10 Customer Street, Perth",
        "Office: 08 6263 0940",
        "Mobile: 0401 222 333",
        "Email: admin@mlbuilders.com.au",
        "Customer Email: mlb.customer@example.com",
      ].join("\n"),
      attachments: [pdf("mlb-office-contact")],
    }),
    source({
      postId: "ajs-office-contact",
      fromEmail: "dispatch@ajs.test",
      subject: "Make Safe - Perth - Job No 70104",
      body: [
        "Contact: AJS Customer",
        "Site Address: 11 Customer Street, Perth",
        "Office: 1300 257 253",
        "Mobile: 0402 333 444",
      ].join("\n"),
      attachments: [pdf("ajs-office-contact")],
    }),
    source({
      postId: "bw-office-contact",
      fromEmail: "dispatch@builderwest.test",
      subject: "70105 - BWCWA70105 - BW Customer - 12 Customer Street, Perth",
      body: [
        "Office: 08 9421 1163",
        "Mobile: 0403 444 555",
      ].join("\n"),
      attachments: [pdf("bw-office-contact")],
    }),
  ];
  const [mlb, ajs, bw] = cases.map((item) =>
    adaptDeterministicSource(item, PROFILES)
  );
  assertEquals(mlb.identity.clientPhone, "0401 222 333");
  assertEquals(mlb.identity.clientEmail, "mlb.customer@example.com");
  assertEquals(ajs.identity.clientPhone, "0402 333 444");
  assertEquals(bw.identity.clientPhone, "0403 444 555");
});

Deno.test("work-order PDF scope decides temp fence, roof report, and AJS make-safe family", () => {
  const tempFence = source({
    postId: "mlb-pdf-temp-fence",
    subject: "NEW WORK ORDER MLB-27106 Work Order: 27106",
    body:
      "Client: Fence Client\nSite Address: 13 Fence Street, Perth\nMobile: 0404 555 666",
    attachments: [pdf("mlb-pdf-temp-fence", "mlb-pdf-temp-fence-a")],
    pdfDocuments: [{
      sourcePostId: "mlb-pdf-temp-fence",
      attachmentId: "mlb-pdf-temp-fence-a",
      attachmentName: "Work Order.pdf",
      status: "extracted",
      text:
        "Scope of Works\nSupply and install temporary fencing to the damaged boundary.",
      charCount: 85,
      pageCount: 1,
      extractor: "unpdf@1.6.2",
      truncated: false,
      reason: null,
    }],
  });
  const roofReport = source({
    postId: "mlb-pdf-roof-report",
    subject: "NEW WORK ORDER MLB-27107 Work Order: 27107",
    body:
      "Client: Report Client\nSite Address: 14 Report Street, Perth\nMobile: 0405 666 777\nhttps://portal.prime.test/r/27107",
    attachments: [pdf("mlb-pdf-roof-report", "mlb-pdf-roof-report-a")],
    links: [{
      url: "https://portal.prime.test/r/27107",
      sourcePostId: "mlb-pdf-roof-report",
    }],
    pdfDocuments: [{
      sourcePostId: "mlb-pdf-roof-report",
      attachmentId: "mlb-pdf-roof-report-a",
      attachmentName: "Work Order.pdf",
      status: "extracted",
      text: "Scope of Works\nComplete a roof inspection report in the portal.",
      charCount: 70,
      pageCount: 1,
      extractor: "unpdf@1.6.2",
      truncated: false,
      reason: null,
    }],
  });
  const ajsTarp = source({
    postId: "ajs-70062-pdf-scope",
    fromEmail: "dispatch@ajs.test",
    subject: "Make Safe - Dianella - Job No 70062",
    body:
      "Contact: AJS Customer\nSite Address: 15 Tarp Street, Dianella\nMobile: 0406 777 888",
    attachments: [pdf("ajs-70062-pdf-scope", "ajs-70062-a")],
    pdfDocuments: [{
      sourcePostId: "ajs-70062-pdf-scope",
      attachmentId: "ajs-70062-a",
      attachmentName: "Work Order.pdf",
      status: "extracted",
      text:
        "Scope of Works\nPlease reattend the property to conduct Make Safe- Tarp the affected areas of water leaking",
      charCount: 115,
      pageCount: 1,
      extractor: "unpdf@1.6.2",
      truncated: false,
      reason: null,
    }],
  });
  assertEquals(
    adaptDeterministicSource(tempFence, PROFILES).identity.jobFamily,
    "temp_fence_makesafe",
  );
  assertEquals(
    adaptDeterministicSource(roofReport, PROFILES).identity.jobFamily,
    "roof_report",
  );
  assertEquals(
    adaptDeterministicSource(ajsTarp, PROFILES).identity.jobFamily,
    "general_makesafe",
  );
});

Deno.test("classification isolates labelled PDF scope from contract boilerplate", () => {
  const item = source({
    postId: "mlb-scope-before-terms",
    subject: "NEW WORK ORDER MLB-27115 Work Order: 27115",
    body:
      "Client: Report Client\nSite Address: 19 Report Street, Perth\nMobile: 0410 123 456",
    attachments: [pdf("mlb-scope-before-terms", "mlb-scope-terms-a")],
    pdfDocuments: [{
      sourcePostId: "mlb-scope-before-terms",
      attachmentId: "mlb-scope-terms-a",
      attachmentName: "Work Order.pdf",
      status: "extracted",
      text: [
        "Notes/Instructions:",
        "Complete a roof inspection report.",
        "WORK ORDER TERMS AND CONDITIONS",
        "Temporary fencing contractors must hold current insurance.",
      ].join("\n"),
      charCount: 150,
      pageCount: 1,
      extractor: "unpdf@1.6.2",
      truncated: false,
      reason: null,
    }],
  });
  const adapted = adaptDeterministicSource(item, PROFILES);
  assertEquals(adapted.identity.jobFamily, "roof_report");
  assertEquals(
    adapted.identity.description,
    "Complete a roof inspection report.",
  );
});

Deno.test("PDFs without a scope heading remain ambiguous despite boilerplate", () => {
  const item = source({
    postId: "mlb-boilerplate-only-scope",
    subject: "NEW WORK ORDER MLB-27116 Work Order: 27116",
    body:
      "Client: Unknown Scope Client\nSite Address: 20 Unknown Street, Perth\nMobile: 0410 123 457",
    attachments: [pdf("mlb-boilerplate-only-scope", "mlb-boilerplate-a")],
    pdfDocuments: [{
      sourcePostId: "mlb-boilerplate-only-scope",
      attachmentId: "mlb-boilerplate-a",
      attachmentName: "Work Order.pdf",
      status: "extracted",
      text: "Temporary fencing contractors must hold current insurance.",
      charCount: 59,
      pageCount: 1,
      extractor: "unpdf@1.6.2",
      truncated: false,
      reason: null,
    }],
  });
  const plan = buildDeterministicIntakePlan([item], PROFILES);
  assertEquals(plan.cases[0].identity.jobFamily, "unclassified");
  assertEquals(plan.cases[0].reasonCode, "ambiguous_scope");
});

Deno.test("AJS hard floor refuses report-only classification", () => {
  const item = source({
    postId: "ajs-report-wording",
    fromEmail: "dispatch@ajs.test",
    subject: "Roof report - Job No 70108",
    body:
      "Contact: AJS Customer\nSite Address: 16 Roof Street, Perth\nMobile: 0407 888 999\nPlease complete the roof report.",
    attachments: [pdf("ajs-report-wording")],
  });
  assertEquals(
    adaptDeterministicSource(item, PROFILES).identity.jobFamily,
    "general_makesafe",
  );
});

Deno.test("unsettled scope becomes an ambiguous_scope exception instead of a guessed family", () => {
  const item = source({
    postId: "mlb-ambiguous-scope",
    subject: "MLB-27109",
    body:
      "Client: Ambiguous Client\nSite Address: 17 Unknown Street, Perth\nMobile: 0408 999 000",
    attachments: [pdf("mlb-ambiguous-scope")],
  });
  const plan = buildDeterministicIntakePlan([item], PROFILES);
  assertEquals(plan.cases[0].identity.jobFamily, "unclassified");
  assertEquals(plan.cases[0].state, "exception");
  assertEquals(plan.cases[0].reasonCode, "ambiguous_scope");
});

Deno.test("BWCWA identity routes to Builderwest company rather than MLB", () => {
  const item = source({
    postId: "bwcwa-routing",
    fromEmail: "notification@primeeco.test",
    subject:
      "70110 - BWCWA70110 - Builderwest Client - 18 Builderwest Street, Perth",
    body: "Mobile: 0409 000 111\nMake safe the damaged property.",
    attachments: [pdf("bwcwa-routing")],
  });
  const adapted = adaptDeterministicSource(item, PROFILES);
  assertEquals(adapted.adapterId, "builderwest");
  assertEquals(adapted.identity.builderSlug, "bw");
  assertEquals(adapted.identity.companyId, PROFILES[4].id);
  assertNotEquals(adapted.identity.companyId, PROFILES[0].id);
});

Deno.test("email fields outrank older PDF-derived values across a case", () => {
  const pdfSource = source({
    postId: "mlb-pdf-older",
    receivedAt: "2026-07-20T00:00:00.000Z",
    subject: "NEW WORK ORDER MLB-26770 Work Order: 26770",
    body: "The work order is attached.",
    attachments: [pdf("mlb-pdf-older", "pdf-older-attachment")],
    pdfDocuments: [{
      sourcePostId: "mlb-pdf-older",
      attachmentId: "pdf-older-attachment",
      attachmentName: "MLB Work Order.pdf",
      status: "extracted",
      text: `Work Order Number
MLB-26770
Policyholders Name
PDF Person
Mobile: 0400 000 001
Site Address
1 PDF Road, Perth, WA 6000`,
      charCount: 200,
      pageCount: 1,
      extractor: "unpdf@1.6.2",
      truncated: false,
      reason: null,
    }],
  });
  const emailSource = source({
    postId: "mlb-email-newer",
    receivedAt: "2026-07-20T01:00:00.000Z",
    subject: "NEW WORK ORDER MLB-26770 Work Order: 26770",
    body:
      "Client: Email Person\nPhone: 0400 000 002\nSite Address: 2 Email Road, Perth, WA 6000",
    attachments: [pdf("mlb-email-newer")],
  });
  const plan = buildDeterministicIntakePlan(
    [pdfSource, emailSource],
    PROFILES,
  );
  const intakeCase = plan.cases[0];
  assertEquals(intakeCase.identity.clientName, "Email Person");
  assertEquals(intakeCase.identity.clientPhone, "0400 000 002");
  assertEquals(
    intakeCase.identity.siteAddress,
    "2 Email Road, Perth, WA 6000",
  );
  assertEquals(intakeCase.fieldProvenance.client_name?.source, "email_text");
  assertEquals(intakeCase.fieldProvenance.client_phone?.source, "email_text");
  assertEquals(intakeCase.fieldProvenance.site_address?.source, "email_text");
});

Deno.test("AJS and AJBR aliases resolve to one company adapter", () => {
  for (
    const [postId, prefix, sender] of [
      ["ajs-1", "AJS", "dispatch@ajs.test"],
      ["ajbr-1", "AJBR", "dispatch@ajbr.test"],
    ]
  ) {
    const adapted = adaptDeterministicSource(
      source({
        postId,
        fromEmail: sender,
        subject: `Make Safe ${prefix}-67200 Job No 67200 Work Order: 67200`,
        body: "Client: Example Person\nAddress: 20 Alpha Road, Perth",
        attachments: [pdf(postId)],
      }),
      PROFILES,
    );
    assertEquals(adapted.adapterId, "ajs_ajbr");
    assertEquals(adapted.identity.builderSlug, "aj");
    assertEquals(adapted.identity.companyId, PROFILES[1].id);
  }
});

Deno.test("AJ Job No subjects resolve to one isolated AJBR obligation", () => {
  const items = ["aj-70062-graph", "aj-70062-mailbox"].map((postId) =>
    source({
      postId,
      fromEmail: "workorders@ajs.test",
      subject: "Make Safe - Dianella - Job No 70062",
      body:
        "Client: Emma Clingan\nPhone: 0400 000 062\nAddress: 12 Railton Place, Dianella WA 6059",
      attachments: [pdf(postId)],
    })
  );
  const plan = buildDeterministicIntakePlan(items, PROFILES);
  assertEquals(plan.cases.length, 1);
  assertEquals(plan.cases[0].identity.externalRefCanonical, "AJBR-70062");
  assertEquals(plan.cases[0].identity.builderWoCanonical, "AJBR-70062");
  assertEquals(plan.cases[0].identity.builderPoCanonical, null);
  assertEquals(plan.cases[0].identity.jobFamily, "general_makesafe");
  assertEquals(plan.cases[0].sourcePostIds, [
    "aj-70062-graph",
    "aj-70062-mailbox",
  ]);
});

Deno.test("Prime wrapper adapter deterministically captures portal report work", () => {
  const item = source({
    postId: "prime-1",
    fromEmail: "notification@prime.test",
    fromName: "Prime Notification Centre",
    subject: "Roof report work order Work Order: 445566",
    body:
      "Client: Roof Client\nSite Address: 30 Beta Avenue, Perth\nMobile: 0411 111 111\nComplete roof report https://portal.prime.test/r/1",
    links: [{ url: "https://portal.prime.test/r/1", sourcePostId: "prime-1" }],
  });
  const adapted = adaptDeterministicSource(item, PROFILES);
  assertEquals(adapted.adapterId, "prime");
  assertEquals(adapted.identity.jobFamily, "roof_report");
  const plan = buildDeterministicIntakePlan([item], PROFILES);
  assertEquals(plan.cases[0].evidenceMap.portal_link.status, "satisfied");
  assertEquals(
    plan.cases[0].evidenceMap.portal_capture.status,
    "recovery_staged",
  );
  assertEquals(plan.cases[0].state, "blocked_live_job");
  assertEquals(plan.cases[0].reasonCode, null);
  assertEquals(plan.cases[0].blockedReasons, ["missing:portal_capture"]);
});

Deno.test("RAPID adapter is pure and reaches confirmed state on complete evidence", () => {
  const item = source({
    postId: "rapid-1",
    fromEmail: "dispatch@rapid.test",
    subject: "RAPID Repair NEW WORK ORDER RAPID-88001 Work Order: RR#88001",
    body:
      "Insured: Rapid Client\nRisk Address: 40 Gamma Drive, Perth\nPhone: 0411111111",
    attachments: [pdf("rapid-1")],
  });
  assertEquals(adaptDeterministicSource(item, PROFILES).adapterId, "rapid");
  assertEquals(
    buildDeterministicIntakePlan([item], PROFILES).cases[0].state,
    "confirmed_live_job",
  );
});

Deno.test("chatter is accounted exactly once rather than dropped", () => {
  const item = source({
    postId: "chat-1",
    fromEmail: "person@example.test",
    subject: "Thanks, noted",
    body: "Thank you",
  });
  const plan = buildDeterministicIntakePlan([item], PROFILES);
  assertEquals(plan.sourceClassifications, [{
    postId: "chat-1",
    outcome: "accounted_non_work",
    instructionKey: plan.cases[0].instructionKey,
    reasonCode: "non_makesafe",
  }]);
  assertEquals(plan.totals.unaccounted, 0);
});

Deno.test("case-wide recovery finds a late PDF before declaring it missing", () => {
  const instruction = source({
    postId: "case-1",
    threadId: "thread-1",
    subject: "NEW WORK ORDER MLB-27040 Work Order: WO 27040",
    body: "Client: Case Client\nAddress: 50 Delta Street, Perth",
  });
  const latePdf = source({
    postId: "case-2",
    threadId: "thread-1",
    subject: "Requested attachment",
    body: "Attached as requested",
    receivedAt: "2026-07-20T01:00:00.000Z",
    attachments: [pdf("case-2")],
  });
  const plan = buildDeterministicIntakePlan([instruction, latePdf], PROFILES);
  assertEquals(plan.cases.length, 1);
  assertEquals(
    plan.cases[0].evidenceMap.work_order_attachment.status,
    "satisfied",
  );
  assertEquals(plan.cases[0].state, "blocked_live_job");
  assertEquals(plan.cases[0].blockedReasons, ["missing:client_phone"]);
  assertEquals(
    plan.cases[0].evidenceMap.work_order_attachment.searchedSourcePostIds,
    ["case-1", "case-2"],
  );
  assertEquals(plan.cases[0].sourcePostIds, ["case-1", "case-2"]);
  assertEquals(plan.totals.unaccounted, 0);
});

Deno.test("a portal link in a sibling source repairs the report manifest case-wide", () => {
  const first = source({
    postId: "report-1",
    threadId: "report-thread",
    subject: "Roof report Work Order: 76543",
    body: "Client: Report Client\nAddress: 60 Epsilon Road, Perth",
    fromEmail: "notification@prime.test",
  });
  const link = source({
    postId: "report-2",
    threadId: "report-thread",
    subject: "Portal link",
    body: "Use https://portal.prime.test/report/76543",
    fromEmail: "notification@prime.test",
    receivedAt: "2026-07-20T02:00:00.000Z",
  });
  const plan = buildDeterministicIntakePlan([first, link], PROFILES);
  assertEquals(plan.cases.length, 1);
  assertEquals(plan.cases[0].evidenceMap.portal_link.status, "satisfied");
  assertEquals(
    plan.cases[0].evidenceMap.portal_capture.nextRecoveryAction,
    "capture_portal_evidence_headless_with_idempotency_key",
  );
});

Deno.test("address-only evidence never merges distinct work orders", () => {
  const a = source({
    postId: "address-a",
    subject: "NEW WORK ORDER MLB-30001 Work Order: WO-30001",
    body: "Client: Shared Client\nAddress: 70 Same Street, Perth",
    attachments: [pdf("address-a")],
  });
  const b = source({
    postId: "address-b",
    subject: "NEW WORK ORDER MLB-30002 Work Order: WO-30002",
    body: "Client: Shared Client\nAddress: 70 Same Street, Perth",
    attachments: [pdf("address-b")],
  });
  const plan = buildDeterministicIntakePlan([a, b], PROFILES);
  assertEquals(plan.cases.length, 2);
  assertNotEquals(
    plan.cases[0].lineageClusterKey,
    plan.cases[1].lineageClusterKey,
  );
});

Deno.test("distinct POs remain distinct sibling instructions", () => {
  const a = source({
    postId: "po-a",
    subject: "NEW WORK ORDER MLB-27037 Work Order: WO-27037 PO: 91821",
    body: "Client: PO Client\nAddress: 80 Zeta Close, Perth",
    attachments: [pdf("po-a")],
  });
  const b = source({
    postId: "po-b",
    subject: "NEW WORK ORDER MLB-27037 Work Order: WO-27037 PO: 91822",
    body: "Client: PO Client\nAddress: 80 Zeta Close, Perth",
    attachments: [pdf("po-b")],
  });
  const plan = buildDeterministicIntakePlan([a, b], PROFILES);
  assertEquals(plan.cases.length, 2);
  assertEquals(new Set(plan.cases.map((c) => c.lineageClusterKey)).size, 1);
  assertEquals(
    new Set(plan.cases.map((c) => c.identity.builderPoCanonical)).size,
    2,
  );
  assert(plan.cases.some((c) => c.parentRelation === "sibling_of"));
});

Deno.test("ordinary WO punctuation and canonical numeric PO spellings converge", () => {
  const make = (postId: string, wo: string, poLabel: string) =>
    source({
      postId,
      subject: `NEW WORK ORDER MLB-31000 Work Order: ${wo} ${poLabel}`,
      body: "Client: Format Client\nAddress: 90 Eta Way, Perth",
      attachments: [pdf(postId)],
    });
  const woPlan = buildDeterministicIntakePlan([
    make("wo-hash", "WO#31000", "PO: 9182"),
    make("wo-dot", "WO.31000", "Purchase Order 9182"),
  ], PROFILES);
  assertEquals(woPlan.cases.length, 1);
  assertEquals(
    woPlan.cases[0].identity.builderPoCanonical,
    "PO-9182",
  );
});

Deno.test("postal PO Box footers never become purchase-order identity or cross-claim edges", () => {
  const sources = ["26947", "26948", "26949", "26950"].map((claim) =>
    source({
      postId: `postal-${claim}`,
      subject: `Our Ref: MLB-${claim} - Make Safe`,
      body:
        `Client: Claim ${claim}\nAddress: ${claim} Separate Way, Perth\nMLB postal address: PO Box 2143, Malaga WA 6944`,
      attachments: [{
        ...pdf(`postal-${claim}`),
        name: "Supporting report.pdf",
      }],
    })
  );
  const plan = buildDeterministicIntakePlan(sources, PROFILES);
  assertEquals(plan.cases.length, 4);
  assert(
    plan.cases.every((item) => item.identity.builderPoCanonical === null),
  );
  assert(
    plan.cases.every((item) => !item.instructionKey.includes("po%3ABOX")),
  );
  assertEquals(
    new Set(plan.cases.map((item) => item.lineageClusterKey)).size,
    4,
  );
});

Deno.test("equal numeric PO cannot merge different explicit claims without the same WO", () => {
  const make = (claim: string) =>
    source({
      postId: `shared-po-${claim}`,
      subject: `Our Ref: MLB-${claim} - PO: 4477`,
      body:
        `Client: Shared Client\nAddress: 90 Shared Way, Perth\nPurchase Order 4477`,
      attachments: [{
        ...pdf(`shared-po-${claim}`),
        name: "Supporting report.pdf",
      }],
    });
  const plan = buildDeterministicIntakePlan(
    [make("41001"), make("41002")],
    PROFILES,
  );
  assertEquals(plan.cases.length, 2);
  assert(
    plan.cases.every((item) => item.identity.builderPoCanonical === "PO-4477"),
  );
  assertEquals(
    new Set(plan.cases.map((item) => item.lineageClusterKey)).size,
    2,
  );
});

Deno.test("claim-only evidence cannot enter confirmed-live state", () => {
  const item = source({
    postId: "claim-only",
    subject: "NEW WORK ORDER MLB-32000",
    body: "Client: Claim Client\nAddress: 100 Theta Circuit, Perth",
    attachments: [{
      ...pdf("claim-only"),
      name: "Supporting document.pdf",
    }],
  });
  const plan = buildDeterministicIntakePlan([item], PROFILES);
  assertEquals(plan.cases[0].identity.woPoIdentityKey, null);
  assertEquals(plan.cases[0].identity.externalRefCanonical, "MLB-32000");
  assertEquals(plan.cases[0].state, "exception");
  assertEquals(plan.cases[0].reasonCode, "below_identity_floor");
});

Deno.test("WO ref without PDF or client name lands in review maybe-box", () => {
  // Simulates the "Our Ref: MLB-25876 - 48 Doriot Way, Carine" format:
  // the MLB ref is in the subject, the address is in the subject, but there
  // is no WO PDF and no labelled client name in the body. This is the grey
  // area that should be parked for human/AI review, not silently dropped.
  const item = source({
    postId: "wo-no-pdf",
    subject: "Our Ref: MLB-25876 - 48 Doriot Way, Carine - Client Ref: 13345234",
    body: "Please see attached site photos for this make safe job.",
    attachments: [],
  });
  const plan = buildDeterministicIntakePlan([item], PROFILES);
  assertEquals(plan.cases[0].identity.externalRefCanonical, "MLB-25876");
  assertEquals(plan.cases[0].state, "exception");
  assertEquals(
    plan.cases[0].reasonCode,
    "wo_ref_without_pdf_pending_review",
  );
});

Deno.test("WO ref with client name from body stays below_identity_floor", () => {
  // When the body DOES supply a client name (e.g. "Client: John Smith"), the
  // identity shortfall is about the missing WO/PO key, not about a missing
  // PDF. This stays as below_identity_floor, not the maybe-box code.
  const item = source({
    postId: "wo-with-client",
    subject: "NEW WORK ORDER MLB-32000",
    body: "Client: Claim Client\nAddress: 100 Theta Circuit, Perth",
    attachments: [{
      ...pdf("wo-with-client"),
      name: "Supporting document.pdf",
    }],
  });
  const plan = buildDeterministicIntakePlan([item], PROFILES);
  assertEquals(plan.cases[0].state, "exception");
  assertEquals(plan.cases[0].reasonCode, "below_identity_floor");
});

Deno.test("revision and reopen cycles remain separate ordered lineage cases", () => {
  const original = source({
    postId: "cycle-1",
    threadId: "cycle-thread",
    subject: "NEW WORK ORDER MLB-33000 Work Order: WO-33000",
    body: "Client: Cycle Client\nAddress: 110 Iota Loop, Perth",
    attachments: [pdf("cycle-1")],
  });
  const revision = source({
    postId: "cycle-2",
    threadId: "cycle-thread",
    subject: "REVISED WORK ORDER MLB-33000 Work Order: WO-33000",
    body:
      "Client: Cycle Client\nAddress: 110 Iota Loop, Perth\nUpdated instruction",
    receivedAt: "2026-07-20T03:00:00.000Z",
    attachments: [pdf("cycle-2")],
  });
  const reopen = source({
    postId: "cycle-3",
    threadId: "cycle-thread",
    subject: "Re-attend MLB-33000 Work Order: WO-33000",
    body: "Client: Cycle Client\nAddress: 110 Iota Loop, Perth\nReturn to site",
    receivedAt: "2026-07-20T04:00:00.000Z",
    attachments: [pdf("cycle-3")],
  });
  const plan = buildDeterministicIntakePlan(
    [original, revision, reopen],
    PROFILES,
  );
  assertEquals(plan.cases.length, 3);
  assert(plan.cases.some((c) => c.parentRelation === "revision_of"));
  assert(
    plan.cases.some((c) => c.parentRelation === "reopen_of" && c.cycle === 2),
  );
  assert(
    plan.cases.every((c) =>
      c.correlatedStory.some((event) => event.sourcePostId === "cycle-1")
    ),
  );
  // Each case's own story stays scoped to its instruction, so received_at and
  // lineage inference cannot be driven by a sibling instruction's events.
  for (const intakeCase of plan.cases) {
    for (const event of intakeCase.story) {
      assert(intakeCase.sourcePostIds.includes(event.sourcePostId));
    }
  }
});

Deno.test("replay is deterministic, idempotent, and every source has exactly one outcome", () => {
  const inputs = [
    source({
      postId: "replay-1",
      subject: "NEW WORK ORDER MLB-34000 Work Order: WO-34000",
      body: "Client: Replay Client\nAddress: 120 Kappa Street, Perth",
      attachments: [pdf("replay-1")],
    }),
    source({
      postId: "replay-chat",
      fromEmail: "person@example.test",
      subject: "Thanks",
      body: "Noted",
    }),
  ];
  const first = buildDeterministicIntakePlan(inputs, PROFILES);
  const second = buildDeterministicIntakePlan(inputs, PROFILES);
  assertEquals(first, second);
  assertEquals(
    new Set(first.sourceClassifications.map((c) => c.postId)).size,
    inputs.length,
  );
  assertEquals(first.totals.unaccounted, 0);
  assertEquals(
    first.cases.flatMap((c) => c.recoveryCursor.sideEffectKeys.invoices),
    [],
  );
  assertEquals(
    first.cases.flatMap((c) =>
      c.recoveryCursor.sideEffectKeys.outboundMessages
    ),
    [],
  );
});

Deno.test("canonical historical twin and resend fixtures converge with AI disabled", () => {
  const twinBase = {
    subject: "NEW WORK ORDER MLB-26567 Work Order: WO-26567 PO: 44001",
    body: "Client: Twin Client\nAddress: 130 Lambda Road, Perth",
    attachments: [pdf("twin-a", "shared-attachment")],
  };
  const twins = [
    source({ postId: "AAMk-MLB-26567", ...twinBase }),
    source({
      postId: "mailbox-MLB-26567-twin",
      ...twinBase,
      attachments: [pdf("mailbox-MLB-26567-twin", "shared-attachment")],
    }),
  ];
  const twinPlan = buildDeterministicIntakePlan(twins, PROFILES);
  assertEquals(twinPlan.cases.length, 1);
  assertEquals(twinPlan.cases[0].sourcePostIds.length, 2);

  const resendBase = {
    subject: "NEW WORK ORDER MLB-26118 Work Order: WO-26118 PO: 55118",
    body: "Client: Resend Client\nAddress: 140 Mu Street, Perth",
  };
  const resends = Array.from({ length: 4 }, (_, index) =>
    source({
      postId: `MLB-26118-resend-${index + 1}`,
      ...resendBase,
      attachments: [pdf(`MLB-26118-resend-${index + 1}`, "same-wo")],
    }));
  const resendPlan = buildDeterministicIntakePlan(resends, PROFILES);
  assertEquals(resendPlan.cases.length, 1);
  assertEquals(resendPlan.sourceClassifications.length, 4);
  assertEquals(resendPlan.aiCalls, 0);
  assertEquals(resendPlan.totals.unaccounted, 0);
});

Deno.test("cancellation and unknown-builder work remain visible exceptions", () => {
  const cancellation = source({
    postId: "MLB-25769-cancel",
    subject: "CANCELLED WORK ORDER MLB-25769 Work Order: WO-25769",
    body: "Cancel this work order",
  });
  const unknown = source({
    postId: "unknown-builder",
    fromEmail: "dispatch@new-builder.test",
    subject: "NEW WORK ORDER Work Order: NEW-9911",
    body: "Client: Unknown Client\nAddress: 150 Nu Avenue, Perth",
    attachments: [pdf("unknown-builder")],
  });
  const plan = buildDeterministicIntakePlan([cancellation, unknown], PROFILES);
  assertEquals(plan.cases.length, 2);
  assert(
    plan.cases.some((c) =>
      c.reasonCode === "cancellation_target_not_found" &&
      c.targetRelation === "cancellation_of"
    ),
  );
  assert(plan.cases.some((c) => c.reasonCode === "unknown_builder"));
  assertEquals(plan.totals.unaccounted, 0);
});

Deno.test("deterministic authority is the standing default and has no AI fallback", async () => {
  assertEquals(selectIntakeMode("deterministic"), "deterministic");
  assertEquals(selectIntakeMode("anything-else"), "deterministic");
  assertEquals(selectIntakeMode("legacy"), "legacy");
  assertEquals(deterministicModeAllowsAiFallback(), false);

  const client = (result: unknown) => {
    const query = {
      select() {
        return this;
      },
      eq() {
        return this;
      },
      maybeSingle() {
        return Promise.resolve(result);
      },
    };
    return {
      from() {
        return query;
      },
    };
  };
  assertEquals(
    await loadDeterministicIntakeMode(client({
      data: { intake_mode: "deterministic" },
      error: null,
    })),
    "deterministic",
  );
  assertEquals(
    await loadDeterministicIntakeMode(client({
      data: null,
      error: { code: "42703", message: "column intake_mode does not exist" },
    })),
    "deterministic",
  );
  await assertRejects(
    () =>
      loadDeterministicIntakeMode(client({
        data: null,
        error: { code: "57014", message: "statement timeout" },
      })),
    Error,
    "intake mode read failed",
  );
});

Deno.test("quality measurement is per-builder and excludes accounted non-work", () => {
  const plan = buildDeterministicIntakePlan([
    source({
      postId: "measure-mlb",
      subject: "NEW WORK ORDER MLB-27120 Work Order: 27120",
      body:
        "Client: Measured MLB\nSite Address: 20 Measure Street, Perth\nMobile: 0410 111 222\nMake safe the storm damage.",
      attachments: [pdf("measure-mlb")],
    }),
    source({
      postId: "measure-ajs",
      fromEmail: "dispatch@ajs.test",
      subject: "Make Safe - Perth - Job No 70120",
      body: "Contact: Measured AJS\nSite Address: 21 Measure Street, Perth",
      attachments: [pdf("measure-ajs")],
    }),
    source({
      postId: "measure-nonwork",
      subject: "Thanks, noted",
      body: "Thank you",
    }),
  ], PROFILES);
  const measured = measureDeterministicIntakeQuality(plan);
  assertEquals(measured.unit, "canonical_instruction");
  assertEquals(measured.instructions, 2);
  assertEquals(measured.confirmed_without_human, 1);
  assertEquals(measured.confirmed_without_human_percentage, 50);
  assertEquals(measured.by_builder.mlb.fields.client_name, {
    filled: 1,
    total: 1,
    percentage: 100,
  });
  assertEquals(measured.by_builder.aj.blocked_live_job, 1);
  assertEquals(measured.by_builder.aj.fields.client_phone, {
    filled: 0,
    total: 1,
    percentage: 0,
  });
  assertEquals(measured.by_builder.unknown, undefined);
});
