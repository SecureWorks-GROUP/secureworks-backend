import {
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  applyMlbThreadReplyToRoute,
  isMlbBuilderKey,
  isMlbPhysicalReleaseShape,
  mlbRouteRequiresIntakeThreadReply,
  pickIntakeThreadCoordinates,
  pickIntakeThreadFromApprovedDraft,
  resolveIntakeThreadCoordinates,
  routingIntakeThread,
} from "./ses_mlb_thread_reply.ts";
import {
  isAjsBuilderKey,
  sesReleaseRouteOrder,
  SES_AJS_ROUTE_ORDER,
  SES_UNIVERSAL_ROUTE_ORDER,
} from "./ses_release_route_shape.ts";
import { resolveDocketRoutes } from "./ses_reporting_actions.ts";
import {
  MAKESAFE_CC,
  MAKESAFE_FINANCE_CC,
} from "./makesafe_send_pack.ts";

Deno.test("MLB physical shape detection leaves AJS alone", () => {
  assertEquals(isMlbBuilderKey("MLB"), true);
  assertEquals(isMlbBuilderKey("mlb"), true);
  assertEquals(isMlbBuilderKey("AJS"), false);
  assertEquals(isAjsBuilderKey("AJS"), true);
  assertEquals(
    isMlbPhysicalReleaseShape({
      builder_key: "MLB",
      family: "physical_makesafe",
    }),
    true,
  );
  assertEquals(
    isMlbPhysicalReleaseShape({ builder_key: "MLB", family: "repair" }),
    true,
  );
  assertEquals(
    isMlbPhysicalReleaseShape({
      builder_key: "MLB",
      family: "assessment_quote",
    }),
    false,
  );
  assertEquals(
    isMlbPhysicalReleaseShape({
      builder_key: "AJS",
      family: "physical_makesafe",
    }),
    false,
  );
  // Route order unchanged: AJS two, MLB three.
  assertEquals(sesReleaseRouteOrder("AJS"), SES_AJS_ROUTE_ORDER);
  assertEquals(sesReleaseRouteOrder("MLB"), SES_UNIVERSAL_ROUTE_ORDER);
});

Deno.test("pickIntakeThreadCoordinates prefers primary case earliest thread_id", () => {
  const coords = pickIntakeThreadCoordinates(
    [
      {
        case_id: "case-b",
        post_id: "post-late",
        thread_id: "thread-other",
        received_at: "2026-08-01T12:00:00Z",
      },
      {
        case_id: "case-a",
        post_id: "post-late",
        thread_id: "thread-a",
        received_at: "2026-08-02T12:00:00Z",
      },
      {
        case_id: "case-a",
        post_id: "post-early",
        thread_id: "thread-a",
        received_at: "2026-08-01T08:00:00Z",
      },
      {
        case_id: "case-a",
        post_id: "post-no-thread",
        thread_id: null,
        received_at: "2026-07-01T00:00:00Z",
      },
    ],
    "case-a",
  );
  assertEquals(coords?.thread_id, "thread-a");
  assertEquals(coords?.post_id, "post-early");
});

Deno.test("pickIntakeThreadCoordinates returns null when no thread_id exists", () => {
  assertEquals(
    pickIntakeThreadCoordinates([
      { case_id: "c1", post_id: "p1", thread_id: null },
      { case_id: "c1", post_id: "p2", thread_id: "   " },
    ]),
    null,
  );
});

const MAYLANDS_JOB = "1e05db49-cc42-477b-9689-cbdceed649da";
const MAYLANDS_POST =
  "AAMkADA3OWRlMzg2LTAyNzQtNGI4Ni05ODkyLWNiOGY1YTQ1MWNjOABGAAAAAABXcqgbD6QKT47mlZIoOe32BwD6HiEwBbb9SIm64hKZ9RyzAAAAAAEMAAD6HiEwBbb9SIm64hKZ9RyzAAApJdqPAAA=";
const MAYLANDS_THREAD =
  "AAQkADA3OWRlMzg2LTAyNzQtNGI4Ni05ODkyLWNiOGY1YTQ1MWNjOAMkABAADnAYXK0wJkmwUunYT4ZGvBAAKOYU_og240GZQy_7BGb1kA==";

function maylandsDraftCandidate(overrides: Record<string, unknown> = {}) {
  return {
    draft_id: "6960c405-50b5-4008-9513-e05c0a25c0b3",
    status: "approved",
    approved_job_id: MAYLANDS_JOB,
    graph_message_id: MAYLANDS_POST,
    approved_at: "2026-07-20T07:00:00Z",
    email_post_id: MAYLANDS_POST,
    email_thread_id: MAYLANDS_THREAD,
    email_conversation_id: null,
    email_received_at: "2026-07-20T06:45:07Z",
    ...overrides,
  };
}

Deno.test("pickIntakeThreadFromApprovedDraft recovers Maylands-shaped coordinates", () => {
  const coords = pickIntakeThreadFromApprovedDraft(MAYLANDS_JOB, [
    maylandsDraftCandidate(),
  ]);
  assertEquals(coords?.thread_id, MAYLANDS_THREAD);
  assertEquals(coords?.post_id, MAYLANDS_POST);
  assertEquals(coords?.recovery_source, "approved_draft_emails");
  assertEquals(coords?.case_id, null);
});

Deno.test("pickIntakeThreadFromApprovedDraft refuses wrong job (no guess)", () => {
  assertEquals(
    pickIntakeThreadFromApprovedDraft("other-job-id", [
      maylandsDraftCandidate(),
    ]),
    null,
  );
  assertEquals(
    pickIntakeThreadFromApprovedDraft(MAYLANDS_JOB, [
      maylandsDraftCandidate({ approved_job_id: "stranger-job" }),
    ]),
    null,
  );
});

Deno.test("pickIntakeThreadFromApprovedDraft refuses unproven joins", () => {
  assertEquals(
    pickIntakeThreadFromApprovedDraft(MAYLANDS_JOB, [
      maylandsDraftCandidate({ status: "pending" }),
    ]),
    null,
  );
  assertEquals(
    pickIntakeThreadFromApprovedDraft(MAYLANDS_JOB, [
      maylandsDraftCandidate({ email_post_id: "different-post" }),
    ]),
    null,
  );
  assertEquals(
    pickIntakeThreadFromApprovedDraft(MAYLANDS_JOB, [
      maylandsDraftCandidate({ email_thread_id: null }),
    ]),
    null,
  );
  assertEquals(
    pickIntakeThreadFromApprovedDraft(MAYLANDS_JOB, [
      maylandsDraftCandidate({
        graph_message_id: null,
        email_post_id: null,
      }),
    ]),
    null,
  );
  assertEquals(
    pickIntakeThreadFromApprovedDraft(MAYLANDS_JOB, []),
    null,
  );
});

const OLDER_DRAFT = maylandsDraftCandidate({
  draft_id: "older",
  approved_at: "2026-07-16T00:00:00Z",
  graph_message_id: "post-old",
  email_post_id: "post-old",
  email_thread_id: "thread-old",
  email_received_at: "2026-07-16T00:00:00Z",
});

const NEWER_DRAFT = maylandsDraftCandidate({
  draft_id: "newer",
  approved_at: "2026-07-20T07:00:00Z",
  graph_message_id: MAYLANDS_POST,
  email_post_id: MAYLANDS_POST,
  email_thread_id: MAYLANDS_THREAD,
});

Deno.test("pickIntakeThreadFromApprovedDraft refuses ambiguity instead of guessing recency", () => {
  // Neither newest nor earliest is evidence: two proven drafts with no story
  // corroboration must refuse rather than target a builder-visible thread.
  assertEquals(
    pickIntakeThreadFromApprovedDraft(MAYLANDS_JOB, [
      OLDER_DRAFT,
      NEWER_DRAFT,
    ]),
    null,
  );
  // A story that names both candidates is still ambiguous.
  assertEquals(
    pickIntakeThreadFromApprovedDraft(
      MAYLANDS_JOB,
      [OLDER_DRAFT, NEWER_DRAFT],
      ["post-old", MAYLANDS_POST],
    ),
    null,
  );
  // A story that names neither candidate is likewise a refuse.
  assertEquals(
    pickIntakeThreadFromApprovedDraft(
      MAYLANDS_JOB,
      [OLDER_DRAFT, NEWER_DRAFT],
      ["post-unrelated"],
    ),
    null,
  );
});

Deno.test("pickIntakeThreadFromApprovedDraft: story sourcePostId breaks a multi-draft tie", () => {
  const newerByStory = pickIntakeThreadFromApprovedDraft(
    MAYLANDS_JOB,
    [OLDER_DRAFT, NEWER_DRAFT],
    [MAYLANDS_POST],
  );
  assertEquals(newerByStory?.thread_id, MAYLANDS_THREAD);
  assertEquals(newerByStory?.post_id, MAYLANDS_POST);

  // Story authority is not recency: the older post wins when the story names it.
  const olderByStory = pickIntakeThreadFromApprovedDraft(
    MAYLANDS_JOB,
    [OLDER_DRAFT, NEWER_DRAFT],
    "post-old",
  );
  assertEquals(olderByStory?.thread_id, "thread-old");
  assertEquals(olderByStory?.post_id, "post-old");
});

Deno.test("pickIntakeThreadFromApprovedDraft: duplicate rows of one coordinate are one answer", () => {
  const coords = pickIntakeThreadFromApprovedDraft(MAYLANDS_JOB, [
    maylandsDraftCandidate({ draft_id: "a" }),
    maylandsDraftCandidate({ draft_id: "b", approved_at: "2026-07-21T00:00:00Z" }),
  ]);
  assertEquals(coords?.thread_id, MAYLANDS_THREAD);
  assertEquals(coords?.post_id, MAYLANDS_POST);
});

Deno.test("resolveIntakeThreadCoordinates: case_sources outrank draft fallback", () => {
  const fromSources = resolveIntakeThreadCoordinates({
    caseSources: [
      {
        case_id: "case-live",
        post_id: "post-source",
        thread_id: "thread-from-sources",
        received_at: "2026-07-01T00:00:00Z",
      },
    ],
    preferredCaseId: "case-live",
    jobId: MAYLANDS_JOB,
    approvedDraftCandidates: [maylandsDraftCandidate()],
  });
  assertEquals(fromSources?.thread_id, "thread-from-sources");
  assertEquals(fromSources?.recovery_source, "case_sources");
});

Deno.test("resolveIntakeThreadCoordinates: non-empty sources without thread do NOT fall through", () => {
  // Real case_sources rows stay authoritative: missing thread is a refuse,
  // not a silent draft override.
  assertEquals(
    resolveIntakeThreadCoordinates({
      caseSources: [
        {
          case_id: "case-live",
          post_id: "post-no-thread",
          thread_id: null,
        },
      ],
      preferredCaseId: "case-live",
      jobId: MAYLANDS_JOB,
      approvedDraftCandidates: [maylandsDraftCandidate()],
    }),
    null,
  );
});

Deno.test("resolveIntakeThreadCoordinates: empty sources use approved draft", () => {
  const coords = resolveIntakeThreadCoordinates({
    caseSources: [],
    preferredCaseId: "ad6b6a2e-206f-49af-9d8f-e41ea2504081",
    jobId: MAYLANDS_JOB,
    approvedDraftCandidates: [maylandsDraftCandidate()],
  });
  assertEquals(coords?.thread_id, MAYLANDS_THREAD);
  assertEquals(coords?.post_id, MAYLANDS_POST);
  assertEquals(coords?.recovery_source, "approved_draft_emails");
});

Deno.test("resolveIntakeThreadCoordinates: story post ids reach the draft tier", () => {
  const args = {
    caseSources: [],
    preferredCaseId: "ad6b6a2e-206f-49af-9d8f-e41ea2504081",
    jobId: MAYLANDS_JOB,
    approvedDraftCandidates: [OLDER_DRAFT, NEWER_DRAFT],
  };
  assertEquals(resolveIntakeThreadCoordinates(args), null);
  assertEquals(
    resolveIntakeThreadCoordinates({
      ...args,
      preferredStorySourcePostId: [MAYLANDS_POST],
    })?.thread_id,
    MAYLANDS_THREAD,
  );
});

Deno.test("resolveIntakeThreadCoordinates: empty sources and no draft still refuse", () => {
  assertEquals(
    resolveIntakeThreadCoordinates({
      caseSources: [],
      jobId: MAYLANDS_JOB,
      approvedDraftCandidates: [],
    }),
    null,
  );
});

Deno.test("applyMlbThreadReplyToRoute refuses ready without thread", () => {
  const report = applyMlbThreadReplyToRoute(
    {
      route_kind: "report",
      ready: true,
      recipients: ["site@mlb.example"],
      subject: "R",
      body: "B",
      attachment_hashes: ["h1"],
    } as any,
    { builder_key: "MLB", family: "physical_makesafe" },
    null,
  );
  assertEquals(report.requires_thread_reply, true);
  assertEquals(report.ready, false);
  assertEquals(report.reply_to_thread_id, null);

  const stamped = applyMlbThreadReplyToRoute(
    {
      route_kind: "photo",
      ready: true,
      recipients: ["site@mlb.example"],
      subject: "P",
      body: "B",
      attachment_hashes: ["h2"],
    } as any,
    { builder_key: "MLB", family: "physical_makesafe" },
    { thread_id: "thread-1", post_id: "post-1", conversation_id: null, case_id: "c1" },
  );
  assertEquals(stamped.ready, true);
  assertEquals(stamped.reply_to_thread_id, "thread-1");
  assertEquals(stamped.reply_to_graph_message_id, "post-1");
});

Deno.test("invoice and AJS routes do not require intake-thread reply", () => {
  assertEquals(
    mlbRouteRequiresIntakeThreadReply("invoice", {
      builder_key: "MLB",
      family: "physical_makesafe",
    }),
    false,
  );
  assertEquals(
    mlbRouteRequiresIntakeThreadReply("report", {
      builder_key: "AJS",
      family: "physical_makesafe",
    }),
    false,
  );
  const invoice = applyMlbThreadReplyToRoute(
    {
      route_kind: "invoice",
      ready: true,
      recipients: ["makesafes@mlbuilders.com.au"],
      subject: "I",
      body: "B",
      attachment_hashes: ["h"],
    } as any,
    { builder_key: "MLB", family: "physical_makesafe" },
    null,
  );
  assertEquals(invoice.requires_thread_reply, false);
  assertEquals(invoice.ready, true);
});

function mlbPhysicalDocket(threadId: string | null) {
  return {
    id: "docket-mlb",
    stage: "invoice_bound",
    envelope: {
      v2: {
        classification: {
          builder_key: "MLB",
          family: "physical_makesafe",
        },
        routing: {
          report_to: "site.manager@mlb.example",
          photo_to: "site.manager@mlb.example",
          invoice_to: "makesafes@mlbuilders.com.au",
          intake_thread_id: threadId || "",
          intake_post_id: threadId ? "post-root" : "",
        },
      },
    },
    local_invoice_proposal: { builder_reference: "MLB-PO-54000" },
    xero_binding: {
      status: "AUTHORISED",
      xero_invoice_id: "xero-mlb-1",
      invoice_number: "INV-9001",
    },
    email_drafts: {
      REPORT_EMAIL_DRAFT: [
        "To: site.manager@mlb.example",
        "Cc:",
        "Subject: MLB-PO-54000 - physical makesafe",
        "Attachments: ARTIFACTS/report.pdf",
        "",
        "Report body",
      ].join("\n"),
      PHOTO_EMAIL_DRAFT: [
        "To: site.manager@mlb.example",
        "Cc:",
        "Subject: Photo Evidence - MLB-PO-54000",
        "Attachments: ARTIFACTS/photo1.jpg",
        "",
        "Photos body",
      ].join("\n"),
      INVOICE_EMAIL_DRAFT: [
        "To: makesafes@mlbuilders.com.au",
        "Cc: finance@secureworkswa.com.au",
        "Subject: MLB-PO-54000 - billing pack",
        "Attachments: ARTIFACTS/report.pdf, ARTIFACTS/swms.pdf",
        "",
        "Billing body",
      ].join("\n"),
    },
  };
}

const MLB_ARTIFACTS = [
  {
    role: "supporting_report_pdf",
    object_key: "bucket/docket-mlb/ARTIFACTS/report.pdf",
    media_type: "application/pdf",
    content_hash: "report-hash",
  },
  {
    role: "swms_artifact",
    object_key: "bucket/docket-mlb/ARTIFACTS/swms.pdf",
    media_type: "application/pdf",
    content_hash: "swms-hash",
  },
  {
    role: "xero_invoice_pdf",
    object_key: "bucket/docket-mlb/ARTIFACTS/xero-invoice.pdf",
    media_type: "application/pdf",
    content_hash: "xero-hash",
    metadata: {
      xero_invoice_id: "xero-mlb-1",
      invoice_number: "INV-9001",
    },
  },
  {
    role: "completion_photo",
    object_key: "bucket/docket-mlb/ARTIFACTS/photo1.jpg",
    media_type: "image/jpeg",
    content_hash: "photo-hash-1",
  },
];

Deno.test(
  "MLB physical resolveDocketRoutes: three routes, billing pack, thread on report/photo",
  () => {
    const routes = resolveDocketRoutes(
      mlbPhysicalDocket("thread-intake-1"),
      MLB_ARTIFACTS,
      null,
    );
    assertEquals(routes.map((r) => r.route_kind), [
      "report",
      "photo",
      "invoice",
    ]);

    const report = routes.find((r) => r.route_kind === "report")!;
    assertEquals(report.ready, true);
    assertEquals(report.requires_thread_reply, true);
    assertEquals(report.reply_to_thread_id, "thread-intake-1");
    assertEquals(report.reply_to_graph_message_id, "post-root");
    assertEquals(report.attachment_hashes, ["report-hash"]);
    assertEquals(report.cc || [], []);

    const photo = routes.find((r) => r.route_kind === "photo")!;
    assertEquals(photo.ready, true);
    assertEquals(photo.requires_thread_reply, true);
    assertEquals(photo.reply_to_thread_id, "thread-intake-1");
    assertEquals(photo.attachment_hashes, ["photo-hash-1"]);

    const invoice = routes.find((r) => r.route_kind === "invoice")!;
    assertEquals(invoice.ready, true);
    assertEquals(invoice.requires_thread_reply, false);
    assertEquals(invoice.recipients[0], "makesafes@mlbuilders.com.au");
    assertEquals(invoice.cc, [MAKESAFE_FINANCE_CC]);
    // Billing pack: AUTHORISED invoice + report + SWMS support.
    assertEquals(invoice.attachment_hashes.includes("xero-hash"), true);
    assertEquals(invoice.attachment_hashes.includes("report-hash"), true);
    assertEquals(invoice.attachment_hashes.includes("swms-hash"), true);
  },
);

Deno.test(
  "MLB physical report/photo not ready when intake_thread_id missing",
  () => {
    const routes = resolveDocketRoutes(
      mlbPhysicalDocket(null),
      MLB_ARTIFACTS,
      null,
    );
    const report = routes.find((r) => r.route_kind === "report")!;
    const photo = routes.find((r) => r.route_kind === "photo")!;
    const invoice = routes.find((r) => r.route_kind === "invoice")!;
    assertEquals(report.ready, false);
    assertEquals(photo.ready, false);
    assertEquals(report.requires_thread_reply, true);
    assertEquals(invoice.ready, true);
    assertEquals(invoice.requires_thread_reply, false);
  },
);

Deno.test(
  "AJS resolveDocketRoutes still emits report_invoice + photo only (untouched)",
  () => {
    const docket = {
      id: "docket-ajs",
      stage: "invoice_bound",
      envelope: {
        v2: {
          classification: { builder_key: "AJS", family: "physical_makesafe" },
          routing: {
            report_to: "site.manager@ajs.build",
            photo_to: "site.manager@ajs.build",
            invoice_to: "workorders@ajs.build",
            // Even if a thread id is present, AJS shape must not gain MLB reply rules.
            intake_thread_id: "thread-should-not-apply",
          },
        },
      },
      local_invoice_proposal: { builder_reference: "AJBR-70100" },
      xero_binding: {
        status: "AUTHORISED",
        xero_invoice_id: "xero-1",
        invoice_number: "INV-1",
      },
      email_drafts: {
        REPORT_EMAIL_DRAFT: [
          "To: site.manager@ajs.build",
          "Cc:",
          "Subject: AJBR-70100 - physical makesafe",
          "Attachments: ARTIFACTS/report.pdf",
          "",
          "Report body",
        ].join("\n"),
        PHOTO_EMAIL_DRAFT: [
          "To: site.manager@ajs.build",
          "Cc:",
          "Subject: Photo Evidence - AJBR-70100",
          "Attachments: ARTIFACTS/photo1.jpg",
          "",
          "Photos body",
        ].join("\n"),
        INVOICE_EMAIL_DRAFT: [
          "To: workorders@ajs.build",
          "Cc: finance@secureworkswa.com.au",
          "Subject: AJBR-70100 - invoice",
          "Attachments: ARTIFACTS/invoice_proposal.json, ARTIFACTS/report.pdf",
          "",
          "Invoice body",
        ].join("\n"),
      },
    };
    const artifacts = [
      {
        role: "supporting_report_pdf",
        object_key: "bucket/docket-ajs/ARTIFACTS/report.pdf",
        media_type: "application/pdf",
        content_hash: "report-hash",
      },
      {
        role: "xero_invoice_pdf",
        object_key: "bucket/docket-ajs/ARTIFACTS/xero-invoice.pdf",
        media_type: "application/pdf",
        content_hash: "xero-hash",
        metadata: {
          xero_invoice_id: "xero-1",
          invoice_number: "INV-1",
        },
      },
      {
        role: "completion_photo",
        object_key: "bucket/docket-ajs/ARTIFACTS/photo1.jpg",
        media_type: "image/jpeg",
        content_hash: "photo-hash-1",
      },
    ];
    const routes = resolveDocketRoutes(docket, artifacts, null);
    assertEquals(routes.map((r) => r.route_kind), ["report_invoice", "photo"]);
    assertEquals(routes[0].cc, [MAKESAFE_CC]);
    assertEquals(routes[0].requires_thread_reply, undefined);
    assertEquals(routes[1].cc, [MAKESAFE_CC]);
    // AJS does not stamp MLB thread reply fields.
    assertEquals(routes[0].reply_to_thread_id, undefined);
  },
);

Deno.test("routingIntakeThread reads envelope routing fields", () => {
  assertEquals(
    routingIntakeThread({
      intake_thread_id: "t1",
      intake_post_id: "p1",
      intake_conversation_id: "c1",
    }),
    {
      thread_id: "t1",
      post_id: "p1",
      conversation_id: "c1",
      case_id: null,
    },
  );
  assertEquals(routingIntakeThread({ report_to: "x@y.com" }), null);
});
