// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  approveInvoiceDisabledReason,
  buildSesCockpitView,
  buildSesReleaseRevision,
  canRecordSesApproval,
  describeSesSendItPlan,
  evaluateSesMechanicalClean,
  SES_REVIEW_SECTION_ORDER,
  sesRouteKindsOnPack,
  type SesCleanInput,
  type SesCockpitDocket,
} from "./ses_review_cockpit.ts";

function cleanInput(
  overrides: Partial<SesCleanInput> = {},
): SesCleanInput {
  return {
    pre_xero_docs_ready: true,
    readiness_ready: true,
    readiness_blockers: [],
    pricing_disposition: "priced_from_canon",
    line_overrides_audited: true,
    duplicate_allows_create: true,
    invoice_already_bound: false,
    duplicate_ambiguity: "none",
    money_blocker_codes: [],
    post_release_disposition_outstanding: false,
    family: "physical_makesafe",
    family_matrix_version: "matrix@sealed",
    assessment_recipe_version: null,
    portal_required: false,
    portal_capture_status: "not_applicable",
    own_document_exemption: false,
    physical_media_complete: true,
    completed_work_photo_proven: true,
    obligation_revision_count: 1,
    routes: ["report", "photo", "invoice"].map((route_kind) => ({
      route_kind: route_kind as "report" | "photo" | "invoice",
      recipients: [`${route_kind}@builder.example`],
      subject: `${route_kind} subject`,
      body: `${route_kind} body`,
      attachment_hashes: [
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ],
      ready: true,
    })),
    type_check_hold: false,
    story_unverified: false,
    trade_report_submitted: true,
    roof_report_required: false,
    roof_report_filled: false,
    report_only: false,
    ...overrides,
  };
}

Deno.test("mechanical clean is exactly C1-C12 and grants Shaun clean band", () => {
  const result = evaluateSesMechanicalClean(cleanInput());
  assertEquals(result.checks.map((item) => item.id), [
    "C1",
    "C2",
    "C3",
    "C4",
    "C5",
    "C6",
    "C7",
    "C8",
    "C9",
    "C10",
    "C11",
    "C12",
  ]);
  assert(result.clean);
  assertEquals(result.approval_band, "shaun_clean");
  assertEquals(
    canRecordSesApproval({
      mode: "jwt",
      user_id: "shaun",
      role: "user",
      operator_class: "shaun_clean",
    }, result).allowed,
    true,
  );
});

Deno.test(
  "C2 ignores the unsatisfiable readiness.ready flag when blockers are empty",
  () => {
    const result = evaluateSesMechanicalClean(cleanInput({
      readiness_ready: false,
      readiness_blockers: [],
    }));
    const c2 = result.checks.find((item) => item.id === "C2");
    assertEquals(c2?.passed, true);
    assert(result.clean);
  },
);

Deno.test("API and routine keys cannot record human approvals", () => {
  const clean = evaluateSesMechanicalClean(cleanInput());
  for (const mode of ["api_key", "routine"] as const) {
    const result = canRecordSesApproval({ mode }, clean);
    assertEquals(result.allowed, false);
    assertStringIncludes(result.refusal || "", "Human approval");
  }
});

Deno.test("sealed assessment has no recipe or report-only decision blocker", () => {
  const result = evaluateSesMechanicalClean(cleanInput({
    family: "assessment_quote",
    assessment_recipe_version: "assessment-triad-invoice-only/2026-07-27",
    report_only: true,
    portal_required: true,
    portal_capture_status: "done",
  }));
  assertEquals(
    result.blockers.map((blocker) => blocker.decision_key).filter(Boolean),
    [],
  );
});

Deno.test("real-world missing facts are spoken plainly", () => {
  const result = evaluateSesMechanicalClean(cleanInput({
    trade_report_submitted: false,
    roof_report_required: true,
    roof_report_filled: false,
  }));
  const facts = result.blockers.map((blocker) => blocker.fact);
  assert(
    facts.includes("No trade report was submitted for the current attendance."),
  );
  assert(
    facts.includes("The SecureWorks roof report has not been filled out."),
  );
});

Deno.test("cockpit uses fixed Stage D order and split invoice/send controls", () => {
  const input = cleanInput();
  const preXero = buildSesCockpitView({
    job_id: "job-1",
    job_number: "SWMS-1",
    docket_revision_id: "docket-1",
    readiness_revision:
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    dependency_generation: 3,
    invoice_obligation_revision_id: "obligation-revision-1",
    attendance_cycle_ids: ["cycle-1"],
    xero_binding: null,
    local_invoice_proposal: { total: 352 },
    work_order: { state: "ready" },
    family_evidence: {},
    swms: {},
    routes: input.routes,
    crew_and_trade_visits: [],
    clean_input: input,
  });
  assertEquals(preXero.section_order, SES_REVIEW_SECTION_ORDER);
  // Option B: no Xero DRAFT yet → APPROVE INVOICE disabled (mint is separate).
  assertEquals(preXero.controls.approve_invoice.enabled, false);
  assertEquals(preXero.controls.send_it.enabled, false);

  const draftReadyDocket: SesCockpitDocket = {
    job_id: "job-1",
    job_number: "SWMS-1",
    docket_revision_id: "docket-1b",
    readiness_revision:
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    dependency_generation: 3,
    invoice_obligation_revision_id: "obligation-revision-1",
    attendance_cycle_ids: ["cycle-1"],
    xero_binding: {
      xero_invoice_id: "xero-draft-1",
      invoice_number: "INV-DRAFT-1",
      status: "DRAFT",
      total: 737,
    },
    local_invoice_proposal: { total: 352 },
    work_order: { state: "ready" },
    family_evidence: {},
    swms: {},
    routes: input.routes,
    crew_and_trade_visits: [],
    clean_input: input,
  };
  const draftReady = buildSesCockpitView(draftReadyDocket);
  assert(draftReady.controls.approve_invoice.enabled);
  assertEquals(draftReady.controls.send_it.enabled, false);
  assertEquals(draftReady.status, "INVOICE_CREATE_READY");
  assertEquals(
    (draftReady.sections.money as { bound_invoice: Record<string, unknown> })
      .bound_invoice,
    {
      xero_invoice_id: "xero-draft-1",
      invoice_number: "INV-DRAFT-1",
      status: "DRAFT",
      total: 737,
      pdf_content_hash: null,
      pdf_available: false,
    },
  );

  // A stored pointer is not a document: availability is the artifact/live-fetch
  // projection, so a stamped hash alone must not claim a showable PDF, and a
  // proved projection must claim one even when no hash was ever stamped.
  const hashWithoutDocument = buildSesCockpitView({
    ...draftReadyDocket,
    xero_binding: {
      ...draftReadyDocket.xero_binding!,
      pdf_content_hash: `sha256:${"c".repeat(64)}`,
    },
  });
  assertEquals(
    (hashWithoutDocument.sections.money as {
      bound_invoice: Record<string, unknown>;
    }).bound_invoice.pdf_available,
    false,
  );
  const provedProjection = buildSesCockpitView({
    ...draftReadyDocket,
    xero_invoice_pdf_available: true,
  });
  assertEquals(
    (provedProjection.sections.money as {
      bound_invoice: Record<string, unknown>;
    }).bound_invoice,
    {
      xero_invoice_id: "xero-draft-1",
      invoice_number: "INV-DRAFT-1",
      status: "DRAFT",
      total: 737,
      pdf_content_hash: null,
      pdf_available: true,
    },
  );

  const sendReady = buildSesCockpitView({
    job_id: "job-1",
    job_number: "SWMS-1",
    docket_revision_id: "docket-2",
    readiness_revision:
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    dependency_generation: 4,
    invoice_obligation_revision_id: "obligation-revision-1",
    attendance_cycle_ids: ["cycle-1"],
    xero_binding: {
      xero_invoice_id: "xero-1",
      invoice_number: "INV-1",
      status: "AUTHORISED",
    },
    local_invoice_proposal: { total: 352 },
    work_order: { state: "ready" },
    family_evidence: {},
    swms: {},
    routes: input.routes,
    crew_and_trade_visits: [],
    clean_input: {
      ...input,
      invoice_already_bound: true,
      duplicate_allows_create: false,
    },
  });
  assertEquals(sendReady.controls.approve_invoice.enabled, false);
  assert(sendReady.controls.send_it.enabled);
});

Deno.test("stale readiness disables both controls", () => {
  const input = cleanInput();
  const view = buildSesCockpitView({
    job_id: "job-1",
    job_number: "SWMS-1",
    docket_revision_id: "docket-1",
    readiness_revision:
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    dependency_generation: 4,
    invoice_obligation_revision_id: "obligation-revision-1",
    attendance_cycle_ids: ["cycle-1"],
    xero_binding: null,
    local_invoice_proposal: {},
    work_order: {},
    family_evidence: {},
    swms: {},
    routes: input.routes,
    crew_and_trade_visits: [],
    clean_input: input,
  }, {
    readiness_revision:
      "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    dependency_generation: 3,
  });
  assert(view.stale);
  assertEquals(view.controls.approve_invoice.enabled, false);
  assertEquals(view.controls.send_it.enabled, false);
});

Deno.test("document-only reattendance skips invoice approval and enables SEND IT", () => {
  const input = cleanInput({
    pricing_disposition: "no_additional_charge",
    duplicate_allows_create: false,
    invoice_already_bound: false,
  });
  const view = buildSesCockpitView({
    job_id: "job-1",
    job_number: "SWMS-1",
    docket_revision_id: "docket-doc-only",
    readiness_revision:
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    dependency_generation: 5,
    invoice_obligation_revision_id: "obligation-doc-only",
    attendance_cycle_ids: ["cycle-2"],
    xero_binding: null,
    local_invoice_proposal: {
      pricing_disposition: "no_additional_charge",
      lines: [],
    },
    work_order: { state: "ready" },
    family_evidence: {},
    swms: {},
    routes: input.routes,
    crew_and_trade_visits: [],
    clean_input: input,
  });
  assertEquals(view.status, "SEND_READY");
  assertEquals(view.controls.approve_invoice.enabled, false);
  assertEquals(view.controls.send_it.enabled, true);
});

Deno.test("release identity changes when route content or order changes", async () => {
  const member = {
    job_id: "job-1",
    docket_revision_id: "docket-1",
    invoice_obligation_revision_id: "obligation-1",
    attendance_cycle_ids: ["cycle-1"],
    readiness_revision:
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    dependency_generation: 1,
  };
  const routes = cleanInput().routes;
  const first = await buildSesReleaseRevision({
    org_id: "org-1",
    members: [member],
    routes,
    created_by: "operator",
  });
  const changed = await buildSesReleaseRevision({
    org_id: "org-1",
    members: [member],
    routes: routes.map((route) =>
      route.route_kind === "photo"
        ? { ...route, body: `${route.body} changed` }
        : route
    ),
    created_by: "operator",
  });
  assert(first.release.id !== changed.release.id);
  assertEquals(
    first.routes.map((route) => route.route_kind),
    ["report", "photo", "invoice"],
  );
});

Deno.test("release construction rejects subject prose in Cc", async () => {
  const routes = cleanInput().routes.map((route) =>
    route.route_kind === "report"
      ? { ...route, cc: ["Generic report subject"] }
      : route
  );
  await assertRejects(
    () =>
      buildSesReleaseRevision({
        org_id: "org-1",
        members: [{
          job_id: "job-1",
          docket_revision_id: "docket-1",
          invoice_obligation_revision_id: "obligation-1",
          attendance_cycle_ids: ["cycle-1"],
          readiness_revision: `sha256:${"a".repeat(64)}`,
          dependency_generation: 1,
        }],
        routes,
        created_by: "operator",
      }),
    TypeError,
    "non-email recipient",
  );
});

/*
 * Cockpit honesty (mission S5). The Captain reads three things off this payload
 * and each was lying in a different way: the SEND IT copy always narrated three
 * emails, a disabled APPROVE INVOICE gave no reason, and a missing photo draft
 * produced a generic "builder email draft" remedy.
 */

Deno.test("SEND IT copy is generated from the real route list, not hardcoded to three", () => {
  assertStringIncludes(
    describeSesSendItPlan(cleanInput().routes),
    "report, photo and invoice routes (3)",
  );
  // The AJS two-email shape must narrate two, the moment the pack carries two.
  const twoRoutes = cleanInput().routes.filter((route) =>
    route.route_kind !== "photo"
  );
  const twoPlan = describeSesSendItPlan(twoRoutes);
  assertStringIncludes(twoPlan, "report and invoice routes (2)");
  assert(!twoPlan.includes("photo"));
  // One route reads as a route, not "1 routes".
  assertStringIncludes(
    describeSesSendItPlan(twoRoutes.slice(0, 1)),
    "report route (1)",
  );
  assertStringIncludes(describeSesSendItPlan([]), "nothing to send");
});

Deno.test("AJS report_invoice + photo pack narrates two routes in send order", () => {
  const routes = [
    {
      route_kind: "report_invoice" as const,
      recipients: ["workorders@ajs.build"],
      subject: "s",
      body: "b",
      attachment_hashes: ["sha256:aa"],
      ready: true,
    },
    ...cleanInput().routes.filter((route) => route.route_kind === "photo"),
  ];
  assertEquals(sesRouteKindsOnPack(routes), ["report_invoice", "photo"]);
  assertStringIncludes(
    describeSesSendItPlan(routes),
    "report invoice and photo routes (2)",
  );
});

Deno.test("a route kind the send order does not know is still narrated, never dropped", () => {
  const routes = [
    {
      route_kind: "future_route" as unknown as "report",
      recipients: ["ops@example.com"],
      subject: "s",
      body: "b",
      attachment_hashes: ["sha256:aa"],
      ready: true,
    },
    ...cleanInput().routes.filter((route) => route.route_kind === "photo"),
  ];
  assertEquals(sesRouteKindsOnPack(routes), ["photo", "future_route"]);
  assertStringIncludes(
    describeSesSendItPlan(routes),
    "photo and future route routes (2)",
  );
});

Deno.test("APPROVE INVOICE states why it is unavailable once money is committed", () => {
  const reason = approveInvoiceDisabledReason(
    { xero_binding: { status: "AUTHORISED", invoice_number: "INV-1102" } },
    { stale: false, xeroAuthorised: true, noAdditionalCharge: false },
  );
  assertStringIncludes(reason, "already authorised");
  assertStringIncludes(reason, "INV-1102");
  assertStringIncludes(reason, "SEND IT");
  // Not merely grey: the other closed doors each name themselves too.
  assertStringIncludes(
    approveInvoiceDisabledReason(
      { xero_binding: {} },
      { stale: false, xeroAuthorised: false, noAdditionalCharge: false },
    ),
    "No Xero DRAFT invoice is bound",
  );
  assertStringIncludes(
    approveInvoiceDisabledReason(
      { xero_binding: { status: "DRAFT" } },
      { stale: true, xeroAuthorised: false, noAdditionalCharge: false },
    ),
    "older docket revision",
  );
});

Deno.test("a missing photo draft names the PHOTO email and the real cause", () => {
  const noAttachments = cleanInput({
    routes: cleanInput().routes.map((route) =>
      route.route_kind === "photo"
        ? { ...route, attachment_hashes: [], ready: false }
        : route
    ),
  });
  const blocker = evaluateSesMechanicalClean(noAttachments).blockers.find(
    (item) => item.code === "route_draft_missing",
  );
  assert(blocker, "expected a route_draft_missing blocker");
  assertStringIncludes(blocker!.recovery_action, "photo email");
  assertStringIncludes(blocker!.recovery_action, "no attachments");
  assert(!blocker!.recovery_action.includes("builder email draft"));
  assertEquals(blocker!.evidence?.attachment_count, 0);
});

Deno.test("a family whose matrix routes no photo email is not held for one", () => {
  const withoutPhoto = cleanInput({
    routes: cleanInput().routes.filter((route) => route.route_kind !== "photo"),
  });
  // Matrix says photo_route: work_order_sender → still required.
  assert(
    evaluateSesMechanicalClean({ ...withoutPhoto, photo_route_applicable: true })
      .blockers.some((item) => item.code === "route_draft_missing"),
  );
  // Matrix says photo_route: not_applicable → demanding one is unsatisfiable.
  assert(
    !evaluateSesMechanicalClean({
      ...withoutPhoto,
      photo_route_applicable: false,
    }).blockers.some((item) => item.code === "route_draft_missing"),
  );
  // An absent field can only ever be stricter, never looser.
  assert(
    evaluateSesMechanicalClean(withoutPhoto).blockers.some((item) =>
      item.code === "route_draft_missing"
    ),
  );
});
