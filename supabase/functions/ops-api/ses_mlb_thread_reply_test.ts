import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  applyMlbOrdinaryMailSubjectToRoute,
  applyMlbThreadReplyToRoute,
  isMlbBuilderKey,
  isMlbPhysicalReleaseShape,
  MLB_ORDINARY_MAIL_SEND_TRANSPORT,
  MLB_PHYSICAL_ORDINARY_MAIL_SEND_FALLBACK_V1,
  mlbOrdinaryMailSendEffectPayloadFields,
  mlbOrdinaryMailSubject,
  mlbPhysicalUsesOrdinaryMailSendFallback,
  mlbRouteRequiresIntakeThreadReply,
  pickIntakeThreadCoordinates,
  pickIntakeThreadFromApprovedDraft,
  pickIntakeWorkOrderEmailSubject,
  resolveIntakeThreadCoordinates,
  routingIntakeThread,
} from "./ses_mlb_thread_reply.ts";
import {
  isAjsBuilderKey,
  MLB_PRIME_MAILER,
  SES_AJS_ROUTE_ORDER,
  SES_UNIVERSAL_ROUTE_ORDER,
  sesReleaseRouteOrder,
} from "./ses_release_route_shape.ts";
import { resolveDocketRoutes } from "./ses_reporting_actions.ts";
import { MAKESAFE_CC, MAKESAFE_FINANCE_CC } from "./makesafe_send_pack.ts";

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

Deno.test("pickIntakeThreadFromApprovedDraft: one thread with two posts is corroborated, not ambiguous", () => {
  // A builder follow-up posted into the SAME intake conversation and approved
  // onto the same job. Graph reply needs only thread_id, and it is unanimous.
  const followUp = maylandsDraftCandidate({
    draft_id: "follow-up",
    approved_at: "2026-07-24T02:00:00Z",
    graph_message_id: "post-follow-up",
    email_post_id: "post-follow-up",
    email_thread_id: MAYLANDS_THREAD,
  });
  const coords = pickIntakeThreadFromApprovedDraft(MAYLANDS_JOB, [
    NEWER_DRAFT,
    followUp,
  ]);
  assertEquals(coords?.thread_id, MAYLANDS_THREAD);
  // Two posts on that one thread prove no single audit anchor.
  assertEquals(coords?.post_id, null);

  // The story naming exactly one of them restores the anchor.
  const anchored = pickIntakeThreadFromApprovedDraft(
    MAYLANDS_JOB,
    [NEWER_DRAFT, followUp],
    [MAYLANDS_POST],
  );
  assertEquals(anchored?.thread_id, MAYLANDS_THREAD);
  assertEquals(anchored?.post_id, MAYLANDS_POST);

  // A second DISTINCT thread is still ambiguity, and still refuses.
  assertEquals(
    pickIntakeThreadFromApprovedDraft(MAYLANDS_JOB, [
      NEWER_DRAFT,
      followUp,
      OLDER_DRAFT,
    ]),
    null,
  );
});

Deno.test("pickIntakeThreadFromApprovedDraft: duplicate rows of one coordinate are one answer", () => {
  const coords = pickIntakeThreadFromApprovedDraft(MAYLANDS_JOB, [
    maylandsDraftCandidate({ draft_id: "a" }),
    maylandsDraftCandidate({
      draft_id: "b",
      approved_at: "2026-07-21T00:00:00Z",
    }),
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

Deno.test(
  "Captain ordinary-mail exception is visible and active for tonight's path",
  () => {
    // The locked design remains group-thread reply; this flag is the stopgap.
    assertEquals(MLB_PHYSICAL_ORDINARY_MAIL_SEND_FALLBACK_V1, true);
    assertEquals(mlbPhysicalUsesOrdinaryMailSendFallback(), true);
  },
);

Deno.test(
  "applyMlbThreadReplyToRoute under Captain exception uses ordinary Mail.Send",
  () => {
    assertEquals(mlbPhysicalUsesOrdinaryMailSendFallback(), true);

    // Missing thread no longer blocks readiness under the exception.
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
    assertEquals(report.requires_thread_reply, false);
    assertEquals(report.ready, true);
    assertEquals(report.reply_to_thread_id, null);
    assertEquals(report.reply_to_graph_message_id, null);
    assertEquals(report.mlb_transport, MLB_ORDINARY_MAIL_SEND_TRANSPORT);
    assertEquals(report.intended_intake_thread_id, null);

    // Known thread is audit-only — never forces group-thread reply.
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
      {
        thread_id: "thread-1",
        post_id: "post-1",
        conversation_id: null,
        case_id: "c1",
        internet_message_id: "mid@mlb.example",
      },
    );
    assertEquals(stamped.ready, true);
    assertEquals(stamped.requires_thread_reply, false);
    assertEquals(stamped.reply_to_thread_id, null);
    assertEquals(stamped.reply_to_graph_message_id, null);
    assertEquals(stamped.intended_intake_thread_id, "thread-1");
    assertEquals(stamped.intended_intake_post_id, "post-1");
    assertEquals(stamped.in_reply_to_internet_message_id, "mid@mlb.example");
    assertEquals(stamped.mlb_transport, MLB_ORDINARY_MAIL_SEND_TRANSPORT);
  },
);

Deno.test(
  "applyMlbThreadReplyToRoute locked shape still requires the intake thread",
  () => {
    // The exception is temporary and restores by flipping the module flag, so
    // the locked branch must stay provable while the exception is live.
    const stamped = applyMlbThreadReplyToRoute(
      {
        route_kind: "report",
        ready: true,
        recipients: ["site@mlb.example"],
        subject: "R",
        body: "B",
        attachment_hashes: ["h1"],
      } as any,
      { builder_key: "MLB", family: "physical_makesafe" },
      {
        thread_id: "thread-1",
        post_id: "post-1",
        conversation_id: null,
        case_id: "c1",
        internet_message_id: "mid@mlb.example",
      },
      false,
    );
    assertEquals(stamped.requires_thread_reply, true);
    assertEquals(stamped.reply_to_thread_id, "thread-1");
    assertEquals(stamped.reply_to_graph_message_id, "post-1");
    assertEquals(stamped.mlb_transport, "group_thread_reply");
    assertEquals(stamped.in_reply_to_internet_message_id, null);
    assertEquals(stamped.ready, true);

    // No thread id is not ready under the locked shape — never a quiet new thread.
    const unready = applyMlbThreadReplyToRoute(
      {
        route_kind: "photo",
        ready: true,
        recipients: ["site@mlb.example"],
        subject: "P",
        body: "B",
        attachment_hashes: ["h2"],
      } as any,
      { builder_key: "MLB", family: "physical_makesafe" },
      null,
      false,
    );
    assertEquals(unready.ready, false);
    assertEquals(unready.requires_thread_reply, true);
    assertEquals(unready.reply_to_thread_id, null);
  },
);

Deno.test(
  "route_send effect payload gains the exception keys only under the exception",
  () => {
    // Canonical JSON serialises explicit nulls, so an extra null key changes
    // payload_hash and claim_ses_external_effect_v1 refuses the existing
    // operation_key before it can confirm or reconcile. AJS/AJBR, the MLB
    // invoice route and the locked shape must therefore hash unchanged.
    assertEquals(mlbOrdinaryMailSendEffectPayloadFields(null), {});
    assertEquals(mlbOrdinaryMailSendEffectPayloadFields({}), {});
    assertEquals(
      mlbOrdinaryMailSendEffectPayloadFields({ mlb_transport: null }),
      {},
    );
    assertEquals(
      mlbOrdinaryMailSendEffectPayloadFields({
        mlb_transport: "group_thread_reply",
        intended_intake_thread_id: "thread-1",
      }),
      {},
    );
    assertEquals(
      mlbOrdinaryMailSendEffectPayloadFields({
        mlb_transport: MLB_ORDINARY_MAIL_SEND_TRANSPORT,
        intended_intake_thread_id: "thread-1",
        in_reply_to_internet_message_id: "mid@mlb.example",
      }),
      {
        in_reply_to_internet_message_id: "mid@mlb.example",
        mlb_transport: MLB_ORDINARY_MAIL_SEND_TRANSPORT,
        intended_intake_thread_id: "thread-1",
      },
    );
    assertEquals(
      mlbOrdinaryMailSendEffectPayloadFields({
        mlb_transport: MLB_ORDINARY_MAIL_SEND_TRANSPORT,
      }),
      {
        in_reply_to_internet_message_id: null,
        mlb_transport: MLB_ORDINARY_MAIL_SEND_TRANSPORT,
        intended_intake_thread_id: null,
      },
    );
  },
);

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

function mlbPhysicalDocket(
  threadId: string | null,
  opts?: {
    intake_email_subject?: string;
    intake_email_subject_source?: string;
  },
) {
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
          intake_email_subject: opts?.intake_email_subject || "",
          intake_email_subject_source: opts?.intake_email_subject_source || "",
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

// Maylands live coordinate from data/maylands-graph-403-reconcile-v1/report.md
const MAYLANDS_WO_SUBJECT =
  "NEW WORK ORDER - MLB-26267 U24/ 28 Peninsula Road, Maylands, WA 6051";

Deno.test(
  "pickIntakeWorkOrderEmailSubject prefers emails.subject verbatim, then draft, then metadata",
  () => {
    assertEquals(
      pickIntakeWorkOrderEmailSubject({
        emailsSubjects: [MAYLANDS_WO_SUBJECT],
        draftSubjects: ["draft copy"],
        jobMetadataSubject: "meta copy",
      }),
      {
        subject: MAYLANDS_WO_SUBJECT,
        subject_source: "emails_subject",
        ambiguous: false,
      },
    );
    assertEquals(
      pickIntakeWorkOrderEmailSubject({
        emailsSubjects: ["  ", null],
        draftSubjects: ["  Draft Subject From Intake  "],
        jobMetadataSubject: "meta",
      }),
      {
        subject: "Draft Subject From Intake",
        subject_source: "intake_draft_subject",
        ambiguous: false,
      },
    );
    // Repeats of the SAME stored string are one candidate, not ambiguity.
    assertEquals(
      pickIntakeWorkOrderEmailSubject({
        draftSubjects: [
          "  Draft Subject From Intake  ",
          "Draft Subject From Intake",
        ],
      }),
      {
        subject: "Draft Subject From Intake",
        subject_source: "intake_draft_subject",
        ambiguous: false,
      },
    );
    assertEquals(
      pickIntakeWorkOrderEmailSubject({
        jobMetadataSubject: "Builder meta subject",
      }),
      {
        subject: "Builder meta subject",
        subject_source: "job_metadata_builder_email_subject",
        ambiguous: false,
      },
    );
    assertEquals(
      pickIntakeWorkOrderEmailSubject({}),
      { subject: null, subject_source: null, ambiguous: false },
    );
  },
);

Deno.test(
  "pickIntakeWorkOrderEmailSubject refuses to guess between distinct candidates",
  () => {
    // Two approved drafts on one job: the newest is NOT evidence. A wrong WO
    // subject groups builder mail into another property's conversation.
    assertEquals(
      pickIntakeWorkOrderEmailSubject({
        draftSubjects: [
          "NEW WORK ORDER - MLB-26267 U24/ 28 Peninsula Road",
          "NEW WORK ORDER - MLB-26999 12 Other Street",
        ],
        jobMetadataSubject: "Builder meta subject",
      }),
      { subject: null, subject_source: null, ambiguous: true },
    );
    // Ambiguity in a tier refuses outright — a lower tier never rescues it.
    assertEquals(
      pickIntakeWorkOrderEmailSubject({
        emailsSubjects: ["Subject A", "Subject B"],
        draftSubjects: ["Draft only one"],
        jobMetadataSubject: "meta",
      }),
      { subject: null, subject_source: null, ambiguous: true },
    );
  },
);

Deno.test(
  "mlbOrdinaryMailSubject is exact match; never adds or strips Re:; missing falls back visibly",
  () => {
    // Exact — including when the stored WO already had Re: (do not strip).
    const withRe = mlbOrdinaryMailSubject(
      "Re: NEW WORK ORDER - MLB-1",
      "MLB-1 - physical makesafe",
      "emails_subject",
    );
    assertEquals(withRe.subject, "Re: NEW WORK ORDER - MLB-1");
    assertEquals(withRe.subject_source, "emails_subject");
    assertEquals(withRe.original_subject, "Re: NEW WORK ORDER - MLB-1");

    // Exact — do not ADD Re: either (Captain: exact original WO subject).
    const bare = mlbOrdinaryMailSubject(
      MAYLANDS_WO_SUBJECT,
      "MLB-26267 - physical makesafe",
      "emails_subject",
    );
    assertEquals(bare.subject, MAYLANDS_WO_SUBJECT);
    assertEquals(bare.subject.startsWith("Re:"), false);

    // Visible fallback — never blocks; generated subject kept.
    const fallback = mlbOrdinaryMailSubject(
      null,
      "MLB-26267 - physical makesafe",
    );
    assertEquals(fallback.subject, "MLB-26267 - physical makesafe");
    assertEquals(fallback.subject_source, "generated_fallback");
    assertEquals(fallback.original_subject, null);

    // Unknown provenance is left unknown — never upgraded to emails_subject.
    const unknownSource = mlbOrdinaryMailSubject(
      MAYLANDS_WO_SUBJECT,
      "MLB-26267 - physical makesafe",
    );
    assertEquals(unknownSource.subject, MAYLANDS_WO_SUBJECT);
    assertEquals(unknownSource.subject_source, null);
    assertEquals(unknownSource.original_subject, MAYLANDS_WO_SUBJECT);
  },
);

Deno.test(
  "applyMlbOrdinaryMailSubjectToRoute only rewrites MLB report/photo under ordinary mail",
  () => {
    const report = applyMlbOrdinaryMailSubjectToRoute(
      {
        route_kind: "report",
        subject: "MLB-PO-54000 - physical makesafe",
      },
      {
        ordinaryMailSend: true,
        requiresMlbReportPhotoSubject: true,
        originalSubject: MAYLANDS_WO_SUBJECT,
        originalSubjectSource: "emails_subject",
      },
    );
    assertEquals(report.subject, MAYLANDS_WO_SUBJECT);
    assertEquals((report as any).subject_source, "emails_subject");
    assertEquals(
      (report as any).original_work_order_subject,
      MAYLANDS_WO_SUBJECT,
    );

    const invoice = applyMlbOrdinaryMailSubjectToRoute(
      {
        route_kind: "invoice",
        subject: "MLB-PO-54000 - Xero invoice INV-1",
      },
      {
        ordinaryMailSend: true,
        requiresMlbReportPhotoSubject: true,
        originalSubject: MAYLANDS_WO_SUBJECT,
        originalSubjectSource: "emails_subject",
      },
    );
    // Invoice billing pack keeps its own subject.
    assertEquals(invoice.subject, "MLB-PO-54000 - Xero invoice INV-1");
    assertEquals((invoice as any).subject_source, undefined);

    const missing = applyMlbOrdinaryMailSubjectToRoute(
      {
        route_kind: "photo",
        subject: "Photo Evidence - MLB-PO-54000",
      },
      {
        ordinaryMailSend: true,
        requiresMlbReportPhotoSubject: true,
        originalSubject: null,
      },
    );
    assertEquals(missing.subject, "Photo Evidence - MLB-PO-54000");
    assertEquals((missing as any).subject_source, "generated_fallback");
    assertEquals((missing as any).original_work_order_subject, null);
  },
);

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
  "MLB physical resolveDocketRoutes: three routes, billing pack, ordinary-mail exception on report/photo",
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
    // Captain exception: ordinary Mail.Send, not group-thread reply.
    assertEquals(report.requires_thread_reply, false);
    assertEquals(report.reply_to_thread_id, null);
    assertEquals(report.reply_to_graph_message_id, null);
    assertEquals((report as any).intended_intake_thread_id, "thread-intake-1");
    assertEquals(
      (report as any).mlb_transport,
      MLB_ORDINARY_MAIL_SEND_TRANSPORT,
    );
    // No original subject on routing → visible generated fallback; still ready.
    assertEquals((report as any).subject_source, "generated_fallback");
    assertEquals(report.subject, "MLB-PO-54000 - physical makesafe");
    assertEquals(report.attachment_hashes, ["report-hash"]);
    // MLB report recipients are unchanged: report still CCs ses@.
    assertEquals(report.cc || [], [MAKESAFE_CC]);
    // Captain 2026-08-06: report goes to the Prime mailer, report only. The
    // fixture drafts address site.manager@mlb.example, so this also proves the
    // resolved route is SET here rather than inherited from a stale draft.
    assertEquals(report.recipients, [MLB_PRIME_MAILER]);
    assertEquals(report.attachment_hashes.includes("xero-hash"), false);
    assertEquals(report.attachment_hashes.includes("swms-hash"), false);

    const photo = routes.find((r) => r.route_kind === "photo")!;
    assertEquals(photo.ready, true);
    assertEquals(photo.requires_thread_reply, false);
    assertEquals(photo.reply_to_thread_id, null);
    assertEquals(
      (photo as any).mlb_transport,
      MLB_ORDINARY_MAIL_SEND_TRANSPORT,
    );
    assertEquals((photo as any).subject_source, "generated_fallback");
    assertEquals(photo.attachment_hashes, ["photo-hash-1"]);
    // Photos only, to the Prime mailer — no report, no invoice.
    assertEquals(photo.recipients, [MLB_PRIME_MAILER]);
    assertEquals(photo.attachment_hashes.includes("xero-hash"), false);
    assertEquals(photo.attachment_hashes.includes("report-hash"), false);

    const invoice = routes.find((r) => r.route_kind === "invoice")!;
    assertEquals(invoice.ready, true);
    assertEquals(invoice.requires_thread_reply, false);
    assertEquals(invoice.recipients, ["makesafes@mlbuilders.com.au"]);
    assertEquals(invoice.recipients.includes(MLB_PRIME_MAILER), false);
    assertEquals(invoice.cc, [MAKESAFE_FINANCE_CC]);
    // Billing pack: AUTHORISED invoice + report + SWMS support.
    assertEquals(invoice.attachment_hashes.includes("xero-hash"), true);
    assertEquals(invoice.attachment_hashes.includes("report-hash"), true);
    assertEquals(invoice.attachment_hashes.includes("swms-hash"), true);
    // Invoice subject is never the WO subject.
    assertEquals(
      String(invoice.subject).includes("NEW WORK ORDER"),
      false,
    );
  },
);

Deno.test(
  "MLB ordinary-mail report/photo use exact original WO subject from routing (inbox grouping only)",
  () => {
    // In-process wiring proof only — zero Graph calls. A green suite proves
    // the subject is stamped onto routes, not that any mailbox groups them.
    const routes = resolveDocketRoutes(
      mlbPhysicalDocket("thread-intake-1", {
        intake_email_subject: MAYLANDS_WO_SUBJECT,
        intake_email_subject_source: "emails_subject",
      }),
      MLB_ARTIFACTS,
      null,
    );
    const report = routes.find((r) => r.route_kind === "report")!;
    const photo = routes.find((r) => r.route_kind === "photo")!;
    const invoice = routes.find((r) => r.route_kind === "invoice")!;

    assertEquals(report.subject, MAYLANDS_WO_SUBJECT);
    assertEquals(photo.subject, MAYLANDS_WO_SUBJECT);
    assertEquals((report as any).subject_source, "emails_subject");
    assertEquals((photo as any).subject_source, "emails_subject");
    assertEquals(
      (report as any).original_work_order_subject,
      MAYLANDS_WO_SUBJECT,
    );
    // Not a reconstructed/templated near-match.
    assertEquals(report.subject.includes("physical makesafe"), false);
    assertEquals(photo.subject.startsWith("Photo Evidence"), false);
    // Invoice stays on its own billing subject.
    assertEquals(invoice.subject.includes("INV-9001"), true);
    assertEquals(invoice.subject, "MLB-PO-54000 - Xero invoice INV-9001");
    // Still ordinary mail, still ready, still no group-thread path.
    assertEquals(
      (report as any).mlb_transport,
      MLB_ORDINARY_MAIL_SEND_TRANSPORT,
    );
    assertEquals(report.requires_thread_reply, false);
    assertEquals(report.reply_to_thread_id, null);
    assertEquals(report.ready, true);
    assertEquals(photo.ready, true);
  },
);

Deno.test(
  "MLB physical report/photo remain ready without intake_thread_id under ordinary-mail exception",
  () => {
    const routes = resolveDocketRoutes(
      mlbPhysicalDocket(null),
      MLB_ARTIFACTS,
      null,
    );
    const report = routes.find((r) => r.route_kind === "report")!;
    const photo = routes.find((r) => r.route_kind === "photo")!;
    const invoice = routes.find((r) => r.route_kind === "invoice")!;
    assertEquals(report.ready, true);
    assertEquals(photo.ready, true);
    assertEquals(report.requires_thread_reply, false);
    assertEquals(
      (report as any).mlb_transport,
      MLB_ORDINARY_MAIL_SEND_TRANSPORT,
    );
    assertEquals(invoice.ready, true);
    assertEquals(invoice.requires_thread_reply, false);
  },
);

Deno.test(
  "MLB physical resolveDocketRoutes locked shape: report/photo reply on the intake thread",
  () => {
    const routes = resolveDocketRoutes(
      mlbPhysicalDocket("thread-intake-1"),
      MLB_ARTIFACTS,
      null,
      { mlbOrdinaryMailSendFallback: false },
    );
    const report = routes.find((r) => r.route_kind === "report")!;
    const photo = routes.find((r) => r.route_kind === "photo")!;
    const invoice = routes.find((r) => r.route_kind === "invoice")!;
    assertEquals(report.ready, true);
    assertEquals(report.requires_thread_reply, true);
    assertEquals(report.reply_to_thread_id, "thread-intake-1");
    assertEquals(report.reply_to_graph_message_id, "post-root");
    assertEquals((report as any).mlb_transport, "group_thread_reply");
    assertEquals(photo.requires_thread_reply, true);
    assertEquals(photo.reply_to_thread_id, "thread-intake-1");
    // Billing stays an ordinary makesafes@ message under both transports.
    assertEquals(invoice.requires_thread_reply, false);
    assertEquals(invoice.ready, true);
  },
);

Deno.test(
  "MLB physical resolveDocketRoutes locked shape: not ready when intake_thread_id missing",
  () => {
    const routes = resolveDocketRoutes(
      mlbPhysicalDocket(null),
      MLB_ARTIFACTS,
      null,
      { mlbOrdinaryMailSendFallback: false },
    );
    const report = routes.find((r) => r.route_kind === "report")!;
    const photo = routes.find((r) => r.route_kind === "photo")!;
    const invoice = routes.find((r) => r.route_kind === "invoice")!;
    assertEquals(report.ready, false);
    assertEquals(photo.ready, false);
    assertEquals(report.requires_thread_reply, true);
    assertEquals(report.reply_to_thread_id, null);
    assertEquals(invoice.ready, true);
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
    // Permanent AJS pack CCs (Captain 2026-08-06): ses@ + vanessa@ + mandi@.
    const ajsPackCc = [
      MAKESAFE_CC,
      "vanessa@ajs.build",
      "mandi@ajs.build",
    ];
    assertEquals(routes[0].cc, ajsPackCc);
    assertEquals(routes[0].requires_thread_reply, undefined);
    // Captain 2026-08-24: every photo route has no CC.
    assertEquals(routes[1].cc, []);
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
      internet_message_id: null,
    },
  );
  assertEquals(
    routingIntakeThread({
      intake_thread_id: "t1",
      internet_message_id: "mid@example",
    }),
    {
      thread_id: "t1",
      post_id: null,
      conversation_id: null,
      case_id: null,
      internet_message_id: "mid@example",
    },
  );
  assertEquals(routingIntakeThread({ report_to: "x@y.com" }), null);
});

Deno.test(
  "MLB physical resolves the Captain's three-destination shape from one card",
  () => {
    // Wiring proof only: the mail gateway is mocked throughout this suite, so a
    // green result proves the routes RESOLVE this way, never that a message
    // reached makesafes@ or the Prime mailer.
    const routes = resolveDocketRoutes(
      mlbPhysicalDocket("thread-intake-1", {
        intake_email_subject: MAYLANDS_WO_SUBJECT,
        intake_email_subject_source: "emails_subject",
      }),
      MLB_ARTIFACTS,
      null,
    );
    const shape = routes.map((route) => ({
      route_kind: route.route_kind,
      recipients: route.recipients,
      attachments: [...route.attachment_hashes].sort(),
    }));
    assertEquals(shape, [
      {
        route_kind: "report",
        recipients: [MLB_PRIME_MAILER],
        attachments: ["report-hash"],
      },
      {
        route_kind: "photo",
        recipients: [MLB_PRIME_MAILER],
        attachments: ["photo-hash-1"],
      },
      {
        // Route 1 of the ruling: invoice + SWMS + report together.
        route_kind: "invoice",
        recipients: ["makesafes@mlbuilders.com.au"],
        attachments: ["report-hash", "swms-hash", "xero-hash"],
      },
    ]);
    // Route 2 still carries the verbatim work-order subject (PR 591 path).
    assertEquals(
      routes.find((r) => r.route_kind === "report")!.subject,
      MAYLANDS_WO_SUBJECT,
    );
  },
);

Deno.test(
  "MLB destinations are the same under the locked group-thread shape",
  () => {
    // Flipping MLB_PHYSICAL_ORDINARY_MAIL_SEND_FALLBACK_V1 back must not move
    // the recipients — the transport exception and the destinations are
    // independent decisions.
    const routes = resolveDocketRoutes(
      mlbPhysicalDocket("thread-intake-1"),
      MLB_ARTIFACTS,
      null,
      { mlbOrdinaryMailSendFallback: false },
    );
    assertEquals(
      routes.find((r) => r.route_kind === "report")!.recipients,
      [MLB_PRIME_MAILER],
    );
    assertEquals(
      routes.find((r) => r.route_kind === "photo")!.recipients,
      [MLB_PRIME_MAILER],
    );
    assertEquals(
      routes.find((r) => r.route_kind === "invoice")!.recipients,
      ["makesafes@mlbuilders.com.au"],
    );
  },
);

Deno.test(
  "MLB report-only families keep the legacy work-order-sender destination",
  () => {
    // The Captain's ruling is about the MLB make-safe send. A roof/assessment
    // report-only card is not on the physical release shape and must not be
    // silently re-pointed at the Prime mailer by this change.
    const docket = mlbPhysicalDocket("thread-intake-1");
    docket.envelope.v2.classification.family = "ordinary_roof_portal";
    const routes = resolveDocketRoutes(docket, MLB_ARTIFACTS, null);
    assertEquals(
      routes.find((r) => r.route_kind === "report")!.recipients,
      ["site.manager@mlb.example"],
    );
  },
);

Deno.test(
  "a legacy MLB envelope with no declared billing mailbox keeps its prepared invoice recipient",
  () => {
    const docket = mlbPhysicalDocket("thread-intake-1");
    docket.envelope.v2.routing.invoice_to = "";
    const routes = resolveDocketRoutes(docket, MLB_ARTIFACTS, null);
    const invoice = routes.find((r) => r.route_kind === "invoice")!;
    // Emptying a money route would be worse than leaving it as drafted.
    assertEquals(invoice.recipients, ["makesafes@mlbuilders.com.au"]);
    assertEquals(invoice.ready, true);
    // The mailer routes are unaffected by the missing declaration.
    assertEquals(
      routes.find((r) => r.route_kind === "photo")!.recipients,
      [MLB_PRIME_MAILER],
    );
  },
);
