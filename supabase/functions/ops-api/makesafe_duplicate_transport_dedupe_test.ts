// deno-lint-ignore-file no-import-prefix
// Track A D8 fixtures: duplicate email transport rows.
// Dual capture stores one physical message twice (a Graph group post and a
// mailbox message under a `mailbox_<sha>` post id) with byte-identical
// attachments under distinct attachment rows. Both transport rows stay
// persisted for audit, but the planner must treat sha-identical content as ONE
// document and the pair as ONE deliverable: one case, one PDF evidence entry,
// one staged artifact, one extraction-budget spend.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildDeterministicIntakePlan,
  type DeterministicAttachment,
  type DeterministicCompanyProfile,
  type DeterministicPdfDocument,
  type DeterministicSourceItem,
} from "./makesafe_deterministic_intake.ts";
import { enrichSourcesWithPdfText } from "./makesafe_deterministic_intake_runtime.ts";

const PROFILES: DeterministicCompanyProfile[] = [
  {
    id: "11111111-1111-1111-1111-111111111111",
    slug: "mlb",
    name: "MLB",
    senderPatterns: ["mlb.test"],
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

const TWIN_SHA =
  "08046080bb8a9876ff17bc05b85026de6afcc8db6e0b8ab5a3692bb5fec01e9e";

function woAttachment(
  postId: string,
  overrides: Partial<DeterministicAttachment> = {},
): DeterministicAttachment {
  return {
    id: `${postId}-att`,
    sourcePostId: postId,
    name: "work_order_MLB-26219PO-53996_Secureworks_Group_Pty_Ltd.pdf",
    contentType: "application/pdf",
    storagePath: `${postId}/wo.pdf`,
    status: "uploaded",
    sizeBytes: 64_000,
    sha256: TWIN_SHA,
    ...overrides,
  };
}

function extractedDoc(
  postId: string,
  overrides: Partial<DeterministicPdfDocument> = {},
): DeterministicPdfDocument {
  return {
    sourcePostId: postId,
    attachmentId: `${postId}-att`,
    attachmentName:
      "work_order_MLB-26219PO-53996_Secureworks_Group_Pty_Ltd.pdf",
    status: "extracted",
    text:
      "Work Order: MLB-26219\nPO: 53996\nClient: Twin Client\nSite Address: 12 Duplicate Loop, Belmont\nScope: Make safe fence panel.",
    charCount: 120,
    pageCount: 1,
    extractor: "unpdf",
    truncated: false,
    reason: null,
    sha256: TWIN_SHA,
    ...overrides,
  };
}

// The real production pair shape: the same MLB work order captured as a Graph
// group post and as its mailbox twin seconds later. One deliverable results.
Deno.test("dual-capture twin pair plans one case with one PDF evidence entry", () => {
  const graphTwin = source({
    postId: "AAMk-twin-graph",
    subject: "NEW WORK ORDER - MLB-26219 - Belmont Make Safe",
    body: "Please find attached work order.",
    attachments: [woAttachment("AAMk-twin-graph")],
    pdfDocuments: [extractedDoc("AAMk-twin-graph")],
  });
  const mailboxTwin = source({
    postId: "mailbox_twin",
    subject: "NEW WORK ORDER - MLB-26219 - Belmont Make Safe",
    body: "Please find attached work order.",
    receivedAt: "2026-07-20T00:00:01.000Z",
    attachments: [woAttachment("mailbox_twin")],
    pdfDocuments: [extractedDoc("mailbox_twin")],
  });

  const plan = buildDeterministicIntakePlan([graphTwin, mailboxTwin], PROFILES);

  assertEquals(plan.cases.length, 1);
  assertEquals(plan.cases[0].sourcePostIds, [
    "AAMk-twin-graph",
    "mailbox_twin",
  ]);
  assertEquals(plan.cases[0].identity.builderPoCanonical, "PO-53996");
  assertEquals(plan.cases[0].pdfDocuments.length, 1);
  assertEquals(plan.cases[0].recoveryCursor.sideEffectKeys.pdfs.length, 1);
  assertEquals(plan.totals.unaccounted, 0);
});

// The structural failure the sha edge closes: twins share no thread coordinate
// and only one twin's PDF made the extraction budget, so all identity lives on
// one side. Without the content-hash union the budget-starved twin becomes a
// second case; with it, one deliverable results and the extracted copy wins.
Deno.test("sha union folds a budget-starved twin into the extracted twin's case", () => {
  const noRefName = "Works Order.pdf";
  const extracted = source({
    postId: "AAMk-starved-graph",
    subject: "New Work Order - Make Safe",
    body: "Please find attached work order.",
    attachments: [
      woAttachment("AAMk-starved-graph", { name: noRefName }),
    ],
    pdfDocuments: [
      extractedDoc("AAMk-starved-graph", { attachmentName: noRefName }),
    ],
  });
  const starved = source({
    postId: "mailbox_starved",
    subject: "New Work Order - Make Safe",
    body: "Please find attached work order.",
    receivedAt: "2026-07-20T00:00:01.000Z",
    attachments: [woAttachment("mailbox_starved", { name: noRefName })],
    pdfDocuments: [
      extractedDoc("mailbox_starved", {
        attachmentName: noRefName,
        status: "deferred",
        text: null,
        charCount: 0,
        pageCount: null,
        extractor: null,
        reason: "pdf_extraction_cap",
      }),
    ],
  });

  const plan = buildDeterministicIntakePlan([extracted, starved], PROFILES);
  assertEquals(plan.cases.length, 1);
  assertEquals(plan.cases[0].sourcePostIds, [
    "AAMk-starved-graph",
    "mailbox_starved",
  ]);
  assertEquals(plan.cases[0].pdfDocuments.length, 1);
  assertEquals(plan.cases[0].pdfDocuments[0].status, "extracted");

  // Counterfactual: identical fixtures with no content hash cannot union, so
  // the pair splits into two cases. This is the pre-fix defect shape.
  const stripSha = (item: DeterministicSourceItem) => ({
    ...item,
    attachments: item.attachments.map((attachment) => ({
      ...attachment,
      sha256: null,
    })),
    pdfDocuments: (item.pdfDocuments || []).map((document) => ({
      ...document,
      sha256: null,
    })),
  });
  const withoutHash = buildDeterministicIntakePlan(
    [stripSha(extracted), stripSha(starved)],
    PROFILES,
  );
  assertEquals(withoutHash.cases.length, 2);
});

// When BOTH twins are identity-less (nothing extracted anywhere), the shared
// document is still one source of work: the pair keys by content, not by
// transport row, and lands as one reviewable exception.
Deno.test("identity-less sha twins share one content-keyed instruction", () => {
  const bare = (postId: string, receivedAt: string) =>
    source({
      postId,
      subject: "New Work Order - Make Safe",
      body: "Please find attached work order.",
      receivedAt,
      attachments: [woAttachment(postId, { name: "Works Order.pdf" })],
    });
  const plan = buildDeterministicIntakePlan(
    [
      bare("AAMk-bare-graph", "2026-07-20T00:00:00.000Z"),
      bare("mailbox_bare", "2026-07-20T00:00:01.000Z"),
    ],
    PROFILES,
  );

  assertEquals(plan.cases.length, 1);
  assertEquals(plan.cases[0].sourcePostIds, [
    "AAMk-bare-graph",
    "mailbox_bare",
  ]);
  assertEquals(plan.cases[0].state, "exception");
});

// Non-divergence guard: one WO carrying two POs is two deliverables. Distinct
// content hashes must never collapse.
Deno.test("distinct multi-PO documents keep separate cases and artifacts", () => {
  const first = source({
    postId: "multi-po-1",
    subject: "NEW WORK ORDER - MLB-25400 - Two Pane Fence",
    attachments: [
      woAttachment("multi-po-1", {
        name: "work_order_MLB-25400PO-11111_Secureworks_Group_Pty_Ltd.pdf",
        sha256: "a".repeat(64),
      }),
    ],
  });
  const second = source({
    postId: "multi-po-2",
    subject: "NEW WORK ORDER - MLB-25400 - Two Pane Fence",
    receivedAt: "2026-07-20T00:05:00.000Z",
    attachments: [
      woAttachment("multi-po-2", {
        name: "work_order_MLB-25400PO-22222_Secureworks_Group_Pty_Ltd.pdf",
        sha256: "b".repeat(64),
      }),
    ],
  });

  const plan = buildDeterministicIntakePlan([first, second], PROFILES);
  assertEquals(plan.cases.length, 2);
  const poNumbers = plan.cases.map((intakeCase) =>
    intakeCase.identity.builderPoCanonical
  ).sort();
  assertEquals(poNumbers, ["PO-11111", "PO-22222"]);
});

// The extraction budget is spent once per content hash: the twin reuses the
// first carrier's deterministic outcome under its own attachment identity.
Deno.test("enrichSourcesWithPdfText downloads sha-identical twins once", async () => {
  const downloads: string[] = [];
  const client = {
    storage: {
      from: (_bucket: string) => ({
        download: (path: string) => {
          downloads.push(path);
          return Promise.resolve({
            data: new Blob([new TextEncoder().encode("garbage-not-a-pdf")]),
            error: null,
          });
        },
      }),
    },
  };
  const twins = [
    source({
      postId: "AAMk-enrich-graph",
      attachments: [woAttachment("AAMk-enrich-graph")],
    }),
    source({
      postId: "mailbox_enrich",
      receivedAt: "2026-07-20T00:00:01.000Z",
      attachments: [woAttachment("mailbox_enrich")],
    }),
  ];

  const enriched = await enrichSourcesWithPdfText(client, twins);

  assertEquals(downloads.length, 1);
  const graphDoc = enriched[0].pdfDocuments?.[0];
  const twinDoc = enriched[1].pdfDocuments?.[0];
  assert(graphDoc && twinDoc);
  assertEquals(graphDoc.status, "quarantined");
  assertEquals(twinDoc.status, "quarantined");
  assertEquals(twinDoc.reason, graphDoc.reason);
  // The shared outcome must not leak the first carrier's identity.
  assertEquals(twinDoc.sourcePostId, "mailbox_enrich");
  assertEquals(twinDoc.attachmentId, "mailbox_enrich-att");
  assertEquals(twinDoc.sha256, TWIN_SHA);
});
