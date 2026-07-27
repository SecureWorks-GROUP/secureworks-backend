// deno-lint-ignore-file no-import-prefix no-explicit-any

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { _makesafeIntakeExceptionReadActionForTest } from "./index.ts";
import {
  buildIntakeExceptionProjection,
  honestIntakeReason,
  intakeExceptionBoardPayload,
  type IntakeExceptionCaseRow,
  type IntakeExceptionProjectionInput,
} from "./makesafe_intake_exception_cards.ts";
import type { IntakeOperationalFact } from "./makesafe_intake_operational_facts.ts";

const ORG = "00000000-0000-0000-0000-000000000001";
const NOW = "2026-07-27T08:00:00.000Z";
const HISTORICAL_AJBR_REFS = [
  "AJBR-66871",
  "AJBR-66901",
  "AJBR-66938",
  "AJBR-67009",
  "AJBR-67031",
  "AJBR-67040",
  "AJBR-67084",
  "AJBR-67094",
  "AJBR-67109",
  "AJBR-67124",
  "AJBR-67134",
  "AJBR-67135",
  "AJBR-67154",
  "AJBR-67201",
  "AJBR-67208",
  "AJBR-67248",
  "AJBR-67249",
  "AJBR-67251",
  "AJBR-67272",
  "AJBR-67380",
  "AJBR-67381",
  "AJBR-67766",
  "AJBR-68554",
  "AJBR-68756",
  "AJBR-68779",
  "AJBR-68872",
] as const;
const RECENT_AJBR_REFS = new Set([
  "AJBR-68554",
  "AJBR-68756",
  "AJBR-68779",
  "AJBR-68872",
]);

function exceptionCase(
  id: string,
  externalRef: string,
  overrides: Partial<IntakeExceptionCaseRow> = {},
): IntakeExceptionCaseRow {
  return {
    id,
    company_id: "company-aj",
    company_slug_raw: "aj",
    external_ref_raw: externalRef,
    external_ref_canonical: externalRef,
    builder_wo_canonical: externalRef,
    builder_po_canonical: null,
    wo_po_identity_key: `wo:${externalRef}`,
    raw_identity_json: {},
    story_json: [],
    evidence_map: {},
    state: "exception",
    reason_code: "adapter_parse_failure",
    missing_fields: ["client_name"],
    conflicting_fields: {},
    parent_case_id: null,
    parent_relation: null,
    target_relation: null,
    job_id: null,
    target_job_id: null,
    client_name: null,
    client_phone: null,
    client_email: null,
    site_address: null,
    site_suburb: null,
    received_at: "2026-07-20T00:00:00.000Z",
    ...overrides,
  };
}

function source(caseId: string, postId = `post-${caseId}`) {
  return {
    case_id: caseId,
    post_id: postId,
    role: "primary",
    received_at: "2026-07-01T00:00:00.000Z",
    attachment_refs: [],
  };
}

function sourceIssueFact(
  postId: string,
  overrides: Partial<IntakeOperationalFact> = {},
): IntakeOperationalFact {
  return {
    item_id: `source:${postId}`,
    source_instruction_id: postId,
    source_received_at: "2026-07-27T07:59:00.000Z",
    age_seconds: 60,
    case_id: null,
    instruction_key: null,
    lineage_id: null,
    parent_case_id: null,
    parent_relation: null,
    job_id: null,
    target_relation: null,
    target_job_id: null,
    fate: "open_source_issue",
    reason_code: "pdf_attachment_limit",
    blocked_reasons: [],
    cancellation_job_status: null,
    provenance_complete: false,
    attachment_issue_codes: ["pdf_attachment_limit"],
    next_action_code: "retry_bounded_pdf_extraction",
    severity: "warning",
    ...overrides,
  };
}

function projectionInput(
  overrides: Partial<IntakeExceptionProjectionInput> = {},
): IntakeExceptionProjectionInput {
  return {
    orgId: ORG,
    generatedAt: NOW,
    facts: [],
    cases: [],
    sources: [],
    sourceCorrections: [],
    sourceSupersessions: [],
    caseCorrections: [],
    companies: [{ id: "company-aj", slug: "aj", name: "AJ Builder" }],
    jobs: [],
    emails: [],
    attachments: [],
    excludedPostIds: [],
    refPrefixes: ["AJBR", "MLB", "BWCWA"],
    ...overrides,
  };
}

Deno.test("the recent window surfaces current AJBR work without resurrecting the archive", () => {
  const cases = HISTORICAL_AJBR_REFS.flatMap((ref) => {
    const attempts = ref === "AJBR-68554" ? 3 : 1;
    return Array.from(
      { length: attempts },
      (_, index) =>
        exceptionCase(`${ref}-case-${index + 1}`, ref, {
          missing_fields: index === 1
            ? [
              "client_name",
              "client_phone",
              "site_address",
              "work_order_attachment",
            ]
            : ["client_name"],
          received_at: RECENT_AJBR_REFS.has(ref)
            ? `2026-07-${String(20 + index).padStart(2, "0")}T00:00:00.000Z`
            : "2026-06-30T00:00:00.000Z",
        }),
    );
  });
  const sources = cases.map((row) => source(row.id));
  const emails = sources.map((row) => ({
    post_id: row.post_id,
    subject: `NEW WORK ORDER ${row.case_id.split("-case-")[0]}`,
    from_email: "workorders@example.invalid",
    from_name: "AJ Builder",
    received_at: row.received_at,
  }));
  const attachments = sources.map((row) => ({
    id: `attachment-${row.post_id}`,
    email_id: row.post_id,
    name: `${row.post_id}.pdf`,
    content_type: "application/pdf",
    status: "available",
    size_bytes: 1234,
  }));

  const projection = buildIntakeExceptionProjection(
    projectionInput({ cases, sources, emails, attachments }),
  );

  assertEquals(cases.length, 28);
  assertEquals(projection.totals, {
    exception_case_rows: 28,
    recent_exception_case_rows: 6,
    out_of_window_exception_case_rows: 22,
    recent_accounted_non_work_rows: 0,
    recent_deterministic_non_work_exception_rows: 0,
    actionable_case_rows: 6,
    cards: 4,
    source_alarms: 0,
  });
  assertEquals(
    projection.cards.map((card) => card.external_ref).sort(),
    [...RECENT_AJBR_REFS].sort(),
  );
  const multiAttempt = projection.cards.find((card) =>
    card.external_ref === "AJBR-68554"
  )!;
  assertEquals(multiAttempt.case_ids.length, 3);
  assertEquals(multiAttempt.evidence_sources.length, 3);
  assertEquals(multiAttempt.attachment_pointers.length, 3);
  assertEquals(multiAttempt.needed_information, [
    "client name",
    "client phone",
    "site address",
  ]);
  assertEquals(
    multiAttempt.blocker_sentence,
    "Add client name, client phone, and site address before approving this work order.",
  );
  assertEquals(multiAttempt.next_action, {
    verb: "fill gap",
    route: "makesafe_gap_fill_queue",
    case_ids: multiAttempt.case_ids,
  });
  assertEquals(
    projection.cards.every((card) =>
      card.status === "source-backed, no job - needs review" &&
      card.job_id === null &&
      card.human_review_required &&
      card.human_approval_required &&
      !card.auto_create_job &&
      !card.auto_create_draft
    ),
    true,
  );
  assertEquals(projection.summary, {
    visible_actionable_cards: 4,
    resolved_from_existing_evidence: 0,
    accounted_silently: 22,
    outside_three: 0,
  });
});

Deno.test("authority ledgers suppress AJBR-70062 and stale shadows before carding", () => {
  const bound = exceptionCase("bound-case", "AJBR-70062");
  const legacy = exceptionCase("legacy-case", "AJBR-69998");
  const effective = exceptionCase("effective-case", "AJBR-69998");
  const residue = exceptionCase("residue-case", "AJBR-69999");
  const projection = buildIntakeExceptionProjection(projectionInput({
    cases: [bound, legacy, effective, residue],
    sources: [
      source("bound-case", "post-70062"),
      source("legacy-case", "post-superseded"),
      source("residue-case", "post-residue"),
    ],
    sourceCorrections: [
      {
        id: "correction-70062",
        source_post_id: "post-70062",
        legacy_case_id: "bound-case",
        effective_case_id: null,
        target_job_id: "SWMS-261055",
      },
      {
        id: "correction-superseded",
        source_post_id: "post-superseded",
        legacy_case_id: "legacy-case",
        effective_case_id: "middle-case",
        target_job_id: null,
      },
    ],
    sourceSupersessions: [{
      source_post_id: "post-superseded",
      superseded_correction_id: "correction-superseded",
      prior_authority_case_id: "middle-case",
      effective_case_id: "effective-case",
    }],
    caseCorrections: [{
      legacy_case_id: "residue-case",
      effective_case_id: null,
    }],
    jobs: [{
      job_id: "SWMS-261055",
      external_ref: "AJBR-70062",
      requesting_company_slug: "aj",
      requesting_company_name: "AJ Builder",
      report_type: null,
      jobs: {
        id: "SWMS-261055",
        status: "scheduled",
        site_address: null,
        type: "makesafe",
        metadata: {},
      },
    }],
  }));

  assertEquals(projection.cards.map((card) => card.external_ref), [
    "AJBR-69998",
  ]);
  assertEquals(
    projection.dispositions.find((row) => row.case_id === "legacy-case")
      ?.disposition,
    "duplicate_shadow",
  );
  assertEquals(
    projection.dispositions.find((row) => row.case_id === "bound-case"),
    {
      case_id: "bound-case",
      external_ref: "AJBR-70062",
      disposition: "existing_job_follow_up",
      display_reason_code: "missing_client_name",
      related_job_id: "SWMS-261055",
      card_id: null,
    },
  );
  assertEquals(
    projection.dispositions.find((row) => row.case_id === "effective-case")
      ?.disposition,
    "visible_review_card",
  );
  assertEquals(
    projection.dispositions.find((row) => row.case_id === "residue-case")
      ?.disposition,
    "correction_residue",
  );
});

Deno.test("one-to-many case corrections never override exact source authority", () => {
  const legacy = exceptionCase("legacy", "MLB-26950");
  const first = exceptionCase("first", "MLB-26951");
  const second = exceptionCase("second", "MLB-26952");
  const projection = buildIntakeExceptionProjection(projectionInput({
    cases: [legacy, first, second],
    sources: [
      source("legacy", "post-first"),
      source("legacy", "post-second"),
    ],
    sourceCorrections: [
      {
        id: "correction-first",
        source_post_id: "post-first",
        legacy_case_id: "legacy",
        effective_case_id: "first",
        target_job_id: null,
      },
      {
        id: "correction-second",
        source_post_id: "post-second",
        legacy_case_id: "legacy",
        effective_case_id: "second",
        target_job_id: null,
      },
    ],
    caseCorrections: [
      { legacy_case_id: "legacy", effective_case_id: "first" },
      { legacy_case_id: "legacy", effective_case_id: "second" },
    ],
  }));

  assertEquals(
    projection.cards.map((card) => [
      card.external_ref,
      card.evidence_sources.map((source) => source.post_id),
    ]),
    [
      ["MLB-26951", ["post-first"]],
      ["MLB-26952", ["post-second"]],
    ],
  );
  assertEquals(
    projection.dispositions.find((row) => row.case_id === "legacy")
      ?.disposition,
    "duplicate_shadow",
  );
});

Deno.test("live obligations and lineage are accounted silently; dead jobs do not hide fresh work", () => {
  const followUp = exceptionCase("follow-up", "AJBR-68000", {
    reason_code: "revision",
  });
  const deadReissue = exceptionCase("dead-reissue", "AJBR-68001");
  const lineage = exceptionCase("revision", "AJBR-68002", {
    parent_case_id: "parent",
    parent_relation: "revision_of",
    builder_wo_canonical: null,
    wo_po_identity_key: null,
  });
  const projection = buildIntakeExceptionProjection(projectionInput({
    cases: [followUp, deadReissue, lineage],
    sources: [source("follow-up"), source("dead-reissue"), source("revision")],
    jobs: [
      {
        job_id: "live-job",
        external_ref: "AJBR-68000",
        requesting_company_slug: "aj",
        requesting_company_name: "AJ Builder",
        report_type: null,
        jobs: {
          id: "live-job",
          status: "scheduled",
          site_address: null,
          type: "makesafe",
          metadata: {},
        },
      },
      {
        job_id: "dead-job",
        external_ref: "AJBR-68001",
        requesting_company_slug: "aj",
        requesting_company_name: "AJ Builder",
        report_type: null,
        jobs: {
          id: "dead-job",
          status: "cancelled",
          site_address: null,
          type: "makesafe",
          metadata: {},
        },
      },
    ],
  }));

  assertEquals(
    projection.dispositions.find((row) => row.case_id === "follow-up"),
    {
      case_id: "follow-up",
      external_ref: "AJBR-68000",
      disposition: "existing_job_follow_up",
      display_reason_code: "missing_client_name",
      related_job_id: "live-job",
      card_id: null,
    },
  );
  assertEquals(
    projection.dispositions.find((row) => row.case_id === "revision")
      ?.disposition,
    "lineage_update",
  );
  assertEquals(projection.cards.map((card) => card.external_ref), [
    "AJBR-68001",
  ]);
});

Deno.test("a strong fresh sibling remains a review card", () => {
  const projection = buildIntakeExceptionProjection(projectionInput({
    cases: [exceptionCase("fresh-sibling", "AJBR-68010", {
      parent_case_id: "older-case",
      parent_relation: "sibling_of",
    })],
    sources: [source("fresh-sibling")],
  }));

  assertEquals(projection.cards.map((card) => card.external_ref), [
    "AJBR-68010",
  ]);
  assertEquals(projection.dispositions[0].disposition, "visible_review_card");
});

Deno.test("live-job binding ambiguity stays visible and names every candidate job", () => {
  const ambiguous = exceptionCase("binding-ambiguity", "MLB-25897", {
    company_id: "company-mlb",
    company_slug_raw: "mlb",
    site_address: "4 Shared Claim Road Perth WA 6000",
    missing_fields: [],
    reason_code: "conflicting_fields",
    conflicting_fields: {
      live_job_binding: ["SWMS-1001", "SWMS-1002"],
    },
  });
  const projection = buildIntakeExceptionProjection(projectionInput({
    cases: [ambiguous],
    sources: [source("binding-ambiguity")],
    companies: [{ id: "company-mlb", slug: "mlb", name: "MLB" }],
    jobs: [
      {
        job_id: "job-1",
        external_ref: "MLB-25897",
        requesting_company_slug: "mlb",
        requesting_company_name: "MLB",
        report_type: null,
        jobs: {
          id: "job-1",
          status: "accepted",
          site_address: "4 Shared Claim Road Perth WA 6000",
          type: "makesafe",
          metadata: { builder_work_order_number: "MLB-25897" },
        },
      },
      {
        job_id: "job-2",
        external_ref: "MLB-25897",
        requesting_company_slug: "mlb",
        requesting_company_name: "MLB",
        report_type: null,
        jobs: {
          id: "job-2",
          status: "scheduled",
          site_address: "4 Shared Claim Road Perth WA 6000",
          type: "makesafe",
          metadata: { builder_work_order_number: "MLB-25897" },
        },
      },
    ],
  }));

  assertEquals(projection.cards.length, 1);
  assertEquals(projection.dispositions[0].disposition, "visible_review_card");
  assertEquals(
    projection.cards[0].blocker_sentence,
    "This instruction MLB-25897 matches 2 live jobs (SWMS-1001 and SWMS-1002) - needs human binding.",
  );
  assertEquals(projection.cards[0].human_review_required, true);
  assertEquals(projection.cards[0].auto_create_job, false);

  const correctedTarget = buildIntakeExceptionProjection(projectionInput({
    cases: [exceptionCase("corrected-target", "MLB-26190", {
      missing_fields: [],
      reason_code: "conflicting_fields",
      conflicting_fields: {
        corrected_target_job_binding: ["SWMS-2001", "SWMS-2002"],
      },
    })],
    sources: [source("corrected-target")],
  }));
  assertEquals(correctedTarget.cards.length, 1);
  assertEquals(
    correctedTarget.cards[0].blocker_sentence,
    "This instruction MLB-26190 has a corrected-target mismatch across 2 candidate jobs (SWMS-2001 and SWMS-2002) - needs human binding.",
  );
});

Deno.test("the deterministic floor never guesses weak or accounted non-work into cards", () => {
  const weak = exceptionCase("weak-case", "BWCWA-6648", {
    company_id: null,
    company_slug_raw: "bwcwa",
    builder_wo_canonical: null,
    wo_po_identity_key: null,
    missing_fields: [
      "builder_work_order",
      "client_name",
      "site_address",
      "work_order_attachment",
    ],
  });
  const nonWork = exceptionCase("invoice-case", "AJBR-68003", {
    state: "accounted_non_wo",
    reason_code: "supplier_invoice",
  });
  const projection = buildIntakeExceptionProjection(projectionInput({
    cases: [weak, nonWork],
    sources: [source("weak-case"), source("invoice-case")],
  }));

  assertEquals(projection.cards, []);
  assertEquals(projection.totals.exception_case_rows, 1);
  assertEquals(projection.dispositions, [{
    case_id: "weak-case",
    external_ref: "BWCWA-6648",
    disposition: "ambiguous_for_reporting",
    display_reason_code: "missing_required_fields",
    related_job_id: null,
    card_id: null,
  }]);
});

Deno.test("deterministic non-work reasons never become fresh-work cards", () => {
  const reasons = [
    "cancellation",
    "cancellation_target_not_found",
    "duplicate",
    "revision",
    "non_makesafe",
  ];
  const cases = reasons.map((reason, index) =>
    exceptionCase(`non-work-${index}`, `AJBR-${68100 + index}`, {
      reason_code: reason,
    })
  );
  const projection = buildIntakeExceptionProjection(projectionInput({
    cases,
    sources: cases.map((row) => source(row.id)),
  }));

  assertEquals(projection.cards, []);
  assertEquals(
    projection.dispositions.map((row) => row.disposition),
    reasons.map(() => "deterministic_non_work"),
  );
  assertEquals(
    projection.totals.recent_deterministic_non_work_exception_rows,
    reasons.length,
  );
});

Deno.test("known missing fields replace false adapter failure reasons", () => {
  for (
    const [caseId, externalRef] of [
      ["c9df46b1-254b-4f1f-8d51-5e296a530d89", "MLB-24333"],
      ["95ca84e6-6970-4c48-a881-249a2f586dfd", "MLB-26123"],
    ]
  ) {
    assertEquals(
      honestIntakeReason(exceptionCase(caseId, externalRef, {
        missing_fields: ["portal_capture"],
      })),
      "missing_portal_capture",
    );
  }
  assertEquals(
    honestIntakeReason(exceptionCase("not-a-crash", "AJBR-1", {
      missing_fields: [],
    })),
    "source_needs_review",
  );
  assertEquals(
    honestIntakeReason(exceptionCase("real-crash", "AJBR-2", {
      missing_fields: [],
      raw_identity_json: { adapter_crashed: true },
    })),
    "adapter_parse_failure",
  );

  const projection = buildIntakeExceptionProjection(projectionInput({
    cases: [
      exceptionCase(
        "c9df46b1-254b-4f1f-8d51-5e296a530d89",
        "MLB-24333",
        {
          missing_fields: ["portal_capture"],
          received_at: "2026-06-19T08:15:00.000Z",
        },
      ),
      exceptionCase(
        "95ca84e6-6970-4c48-a881-249a2f586dfd",
        "MLB-26123",
        {
          missing_fields: ["portal_capture"],
          received_at: "2026-06-19T04:00:00.000Z",
        },
      ),
      exceptionCase("recent-portal", "MLB-27000", {
        missing_fields: ["portal_capture"],
      }),
    ],
    sources: [
      source("c9df46b1-254b-4f1f-8d51-5e296a530d89"),
      source("95ca84e6-6970-4c48-a881-249a2f586dfd"),
      source("recent-portal"),
    ],
  }));
  assertEquals(
    projection.dispositions
      .filter((row) =>
        ["MLB-24333", "MLB-26123"].includes(
          row.external_ref || "",
        )
      )
      .map((row) => [row.disposition, row.display_reason_code]),
    [
      ["out_of_window", "missing_portal_capture"],
      ["out_of_window", "missing_portal_capture"],
    ],
  );
  assertEquals(projection.cards.length, 1);
  assertEquals(
    projection.cards[0].blocker_sentence,
    "Capture the builder portal details before approving this work order.",
  );
  assertEquals(projection.cards[0].next_action.verb, "chase portal");
});

Deno.test("held source evidence clears stale named gaps before card display", () => {
  const stale = exceptionCase("stale", "AJBR-69000", {
    missing_fields: [
      "client_name",
      "site_address",
      "work_order_attachment",
    ],
  });
  const found = exceptionCase("found", "AJBR-69000", {
    client_name: "Held Client",
    site_address: "1 Already Held Street",
    evidence_map: {
      client_name: { status: "satisfied", source: "email_body" },
      site_address: { status: "satisfied", source: "email_body" },
    },
    missing_fields: [],
  });
  const projection = buildIntakeExceptionProjection(projectionInput({
    cases: [stale, found],
    sources: [source("stale"), source("found")],
    attachments: [{
      id: "held-pdf",
      email_id: "post-found",
      name: "work-order.pdf",
      content_type: "application/pdf",
      status: "available",
      size_bytes: 1234,
    }],
  }));

  assertEquals(projection.cards.length, 1);
  assertEquals(projection.cards[0].case_ids, ["found", "stale"]);
  assertEquals(projection.cards[0].needed_information, []);
  assertEquals(
    projection.cards[0].blocker_sentence,
    "Review and approve this source-backed work order before a job can be created.",
  );
  assertEquals(projection.cards[0].next_action.verb, "review source");
});

Deno.test("unfated source issues remain visible alarms until case or exclusion accounting exists", () => {
  const projection = buildIntakeExceptionProjection(projectionInput({
    facts: [
      sourceIssueFact("post-open"),
      sourceIssueFact("post-has-case"),
      sourceIssueFact("post-excluded"),
    ],
    sources: [source("accounted-case", "post-has-case")],
    excludedPostIds: ["post-excluded"],
    emails: [{
      post_id: "post-open",
      subject: "NEW WORK ORDER - unreadable attachment",
      from_email: "builder@example.invalid",
      from_name: "Builder",
      received_at: "2026-07-27T07:59:00.000Z",
    }],
    attachments: [{
      id: "attachment-open",
      email_id: "post-open",
      name: "work-order.pdf",
      content_type: "application/pdf",
      status: "failed",
      size_bytes: 900,
    }],
  }));

  assertEquals(projection.source_alarms, [{
    id: "intake-source-alarm:post-open",
    kind: "intake_source_alarm",
    source_post_id: "post-open",
    received_at: "2026-07-27T07:59:00.000Z",
    blocker_sentence:
      "The work order attachment could not be fully read within the intake limit.",
    next_action: "Review the attachment and retry bounded PDF extraction.",
    severity: "warning",
    subject: "NEW WORK ORDER - unreadable attachment",
    attachments: [{
      attachment_id: "attachment-open",
      name: "work-order.pdf",
      content_type: "application/pdf",
      status: "failed",
      size_bytes: 900,
      is_pdf: true,
    }],
  }]);
});

Deno.test("board payload hides accounting detail while ops list and detail stay readable", async () => {
  const projection = buildIntakeExceptionProjection(projectionInput({
    cases: [exceptionCase("case-1", "AJBR-68004")],
    sources: [source("case-1")],
  }));
  assertEquals(
    "dispositions" in intakeExceptionBoardPayload(projection),
    false,
  );
  assertEquals(
    "disposition_counts" in intakeExceptionBoardPayload(projection),
    false,
  );

  const loader = () => Promise.resolve(projection);
  const listResponse = await _makesafeIntakeExceptionReadActionForTest(
    {},
    "routine",
    null,
    null,
    NOW,
    loader,
  );
  assertEquals(listResponse.status, 200);
  const list = await listResponse.json();
  assertEquals(list.cards.length, 1);
  assertEquals("dispositions" in list, false);
  assertEquals("disposition_counts" in list, false);

  const detailResponse = await _makesafeIntakeExceptionReadActionForTest(
    {},
    "jwt",
    { role: "ops_manager" } as any,
    { caseId: "case-1" },
    NOW,
    loader,
  );
  assertEquals(detailResponse.status, 200);
  const detail = await detailResponse.json();
  assertEquals(detail.card.id, "intake-exception:case-1");
  assertEquals("disposition" in detail, false);

  for (
    const [mode, user] of [
      ["none", null],
      ["jwt", { role: "trade" }],
    ] as const
  ) {
    const denied = await _makesafeIntakeExceptionReadActionForTest(
      {},
      mode,
      user as any,
      null,
      NOW,
      () =>
        Promise.reject(
          new Error("denied calls must not touch the projection"),
        ),
    );
    assertEquals(denied.status, 403);
  }
  assert(
    projection.cards[0].available_actions.some((action) =>
      action.route === "makesafe_gap_fill_queue"
    ),
  );
});
