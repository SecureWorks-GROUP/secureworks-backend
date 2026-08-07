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
  classifySesReleaseSendProgress,
  describeSesSendItPlan,
  evaluateSesMechanicalClean,
  requiredSesRouteKinds,
  sendItDisabledReason,
  SES_REVIEW_SECTION_ORDER,
  type SesCleanInput,
  type SesCockpitDocket,
  sesFailedChecks,
  type SesReviewRoute,
  sesRouteKindsOnPack,
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
  // Ticket 11 follow-up: a fresh page load must be able to fetch the
  // byte-exact pack for ANY card (signed-off ones drop out of the
  // needs_review list), so job_story carries the revision identity.
  const preXeroStory = preXero.sections.job_story as Record<string, unknown>;
  assertEquals(preXeroStory.docket_revision_id, "docket-1");
  assertEquals(preXeroStory.docket_output_content_hash, null);
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

Deno.test("classifySesReleaseSendProgress: production AJBR shapes", () => {
  // 70488: both proofs + closeout verified → released
  assertEquals(
    classifySesReleaseSendProgress({
      release_revision_id: "e8a410e8-f155-5c9e-9cf3-c7a6d9d938bd",
      release_state: "released",
      required_route_kinds: ["report_invoice", "photo"],
      proved_route_kinds: ["photo", "report_invoice"],
      closeout_verified: true,
    }).kind,
    "released",
  );
  // 70487: both proofs, dispatching, no closeout → closeout_pending
  assertEquals(
    classifySesReleaseSendProgress({
      release_revision_id: "5d94726e-b854-57ac-8108-f9d4d984d3dc",
      release_state: "dispatching",
      required_route_kinds: ["report_invoice", "photo"],
      proved_route_kinds: ["report_invoice", "photo"],
      closeout_verified: false,
    }).kind,
    "closeout_pending",
  );
  // Genuine partial: only photo proved
  const partial = classifySesReleaseSendProgress({
    release_revision_id: "partial-release",
    release_state: "dispatching",
    required_route_kinds: ["report_invoice", "photo"],
    proved_route_kinds: ["photo"],
    closeout_verified: false,
  });
  assertEquals(partial.kind, "partially_released");
  if (partial.kind === "partially_released") {
    assertEquals(partial.missing_route_kinds, ["report_invoice"]);
  }
  // No proofs → none (SEND still possible)
  assertEquals(
    classifySesReleaseSendProgress({
      release_revision_id: "approved-only",
      release_state: "approved",
      required_route_kinds: ["report_invoice", "photo"],
      proved_route_kinds: [],
    }).kind,
    "none",
  );
});

Deno.test("released card leaves SEND_READY and disables SEND IT", () => {
  const input = cleanInput({
    invoice_already_bound: true,
    duplicate_allows_create: false,
  });
  const base: SesCockpitDocket = {
    job_id: "job-70488",
    job_number: "SWMS-261130",
    docket_revision_id: "docket-released",
    readiness_revision:
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    dependency_generation: 4,
    invoice_obligation_revision_id: "obligation-1",
    attendance_cycle_ids: ["cycle-1"],
    xero_binding: {
      xero_invoice_id: "xero-1",
      invoice_number: "INV-1110",
      status: "AUTHORISED",
    },
    local_invoice_proposal: { total: 269.5 },
    work_order: { state: "ready" },
    family_evidence: {},
    swms: {},
    routes: input.routes,
    crew_and_trade_visits: [],
    clean_input: input,
  };
  const released = buildSesCockpitView({
    ...base,
    release_send_progress: {
      kind: "released",
      release_revision_id: "e8a410e8-f155-5c9e-9cf3-c7a6d9d938bd",
      release_state: "released",
      proved_route_kinds: ["photo", "report_invoice"],
      required_route_kinds: ["photo", "report_invoice"],
    },
  });
  assertEquals(released.status, "RELEASED");
  assertEquals(released.controls.send_it.enabled, false);
  assertStringIncludes(
    String(released.controls.send_it.disabled_reason || ""),
    "already complete",
  );

  const pending = buildSesCockpitView({
    ...base,
    job_id: "job-70487",
    job_number: "SWMS-261131",
    release_send_progress: {
      kind: "closeout_pending",
      release_revision_id: "5d94726e-b854-57ac-8108-f9d4d984d3dc",
      release_state: "dispatching",
      proved_route_kinds: ["photo", "report_invoice"],
      required_route_kinds: ["photo", "report_invoice"],
    },
  });
  assertEquals(pending.status, "CLOSEOUT_PENDING");
  assertEquals(pending.controls.send_it.enabled, false);
  assertStringIncludes(
    String(pending.controls.send_it.disabled_reason || ""),
    "already proved",
  );

  const partial = buildSesCockpitView({
    ...base,
    release_send_progress: {
      kind: "partially_released",
      release_revision_id: "partial-release",
      release_state: "dispatching",
      proved_route_kinds: ["photo"],
      required_route_kinds: ["photo", "report_invoice"],
      missing_route_kinds: ["report_invoice"],
    },
  });
  assertEquals(partial.status, "PARTIALLY_RELEASED");
  assertEquals(partial.controls.send_it.enabled, false);
  assertStringIncludes(
    String(partial.controls.send_it.disabled_reason || ""),
    "part-proved",
  );
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

Deno.test("the send path honours the same route ruling as the approve path", async () => {
  // The gap this closes: a roof-report card could clear the cockpit, have its
  // invoice AUTHORISED, and only THEN be refused here — committed money with no
  // send path. Approve and send must require the same routes.
  const member = {
    job_id: "job-1",
    docket_revision_id: "docket-1",
    invoice_obligation_revision_id: "obligation-1",
    attendance_cycle_ids: ["cycle-1"],
    readiness_revision:
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    dependency_generation: 1,
  };
  const invoiceOnly = cleanInput().routes.filter((route) =>
    route.route_kind === "invoice"
  );

  // Ruled roof-report card: one invoice route IS the whole release.
  const plan = await buildSesReleaseRevision({
    org_id: "org-1",
    members: [member],
    routes: invoiceOnly,
    created_by: "operator",
    builder_key: "MLB",
    family: "ordinary_roof_portal",
    photo_route_applicable: false,
    report_route_applicable: false,
  });
  assertEquals(plan.routes.map((route) => route.route_kind), ["invoice"]);

  // Strict by default: a caller that has not been taught the new fields gets
  // exactly the old universal-three behaviour.
  await assertRejects(
    () =>
      buildSesReleaseRevision({
        org_id: "org-1",
        members: [member],
        routes: invoiceOnly,
        created_by: "operator",
        builder_key: "MLB",
      }),
    TypeError,
  );
});

Deno.test("physical make-safe still owes three routes at send", async () => {
  const member = {
    job_id: "job-1",
    docket_revision_id: "docket-1",
    invoice_obligation_revision_id: "obligation-1",
    attendance_cycle_ids: ["cycle-1"],
    readiness_revision:
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    dependency_generation: 1,
  };
  // Physical make-safe never declares either route inapplicable, so even with
  // the new fields present and honest it still owes report, photo and invoice.
  const error = await assertRejects(
    () =>
      buildSesReleaseRevision({
        org_id: "org-1",
        members: [member],
        routes: cleanInput().routes.filter((route) =>
          route.route_kind !== "report"
        ),
        created_by: "operator",
        builder_key: "MLB",
        family: "physical_makesafe",
        photo_route_applicable: true,
        report_route_applicable: true,
      }),
    TypeError,
  );
  // The message names what is actually missing, not a fixed three-route recital.
  assertStringIncludes(error.message, "missing the report route");
  assertStringIncludes(error.message, "report, photo and invoice");
});

Deno.test("an exempt card is still refused when the route it DOES owe is absent", async () => {
  // Honesty, not green: dropping report and photo from the required set does
  // not stop the invoice route being required.
  const member = {
    job_id: "job-1",
    docket_revision_id: "docket-1",
    invoice_obligation_revision_id: "obligation-1",
    attendance_cycle_ids: ["cycle-1"],
    readiness_revision:
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    dependency_generation: 1,
  };
  const error = await assertRejects(
    () =>
      buildSesReleaseRevision({
        org_id: "org-1",
        members: [member],
        routes: cleanInput().routes.filter((route) =>
          route.route_kind === "report"
        ),
        created_by: "operator",
        builder_key: "MLB",
        family: "ordinary_roof_portal",
        photo_route_applicable: false,
        report_route_applicable: false,
      }),
    TypeError,
  );
  assertStringIncludes(error.message, "missing the invoice route");
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
  // The FACT itself must name the photo email and what is wrong with it, so it
  // stands alone in a consumer that renders nothing but the fact.
  assertStringIncludes(blocker!.fact, "photo email");
  assertStringIncludes(blocker!.fact, "no attachments");
  assert(!blocker!.fact.includes("A required builder email draft is missing"));
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
    evaluateSesMechanicalClean({
      ...withoutPhoto,
      photo_route_applicable: true,
    })
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

Deno.test("a family whose report lives in the portal is not held for a report email", () => {
  // The live White Gum Valley / Mindarie shape: roof-report card, one invoice
  // route, no REPORT_EMAIL_DRAFT because the portal IS the report.
  const portalReport = cleanInput({
    report_only: true,
    routes: cleanInput().routes.filter((route) =>
      route.route_kind === "invoice"
    ),
    photo_route_applicable: false,
  });
  // Manifest says draft_builder_report_email is a real obligation → required.
  assert(
    evaluateSesMechanicalClean({
      ...portalReport,
      report_route_applicable: true,
    }).blockers.some((item) => item.code === "route_draft_missing"),
  );
  // Manifest says not_applicable ("portal-is-the-report") → demanding one is
  // unsatisfiable, and the Captain ruled the exemption on 2026-08-06.
  const ruled = evaluateSesMechanicalClean({
    ...portalReport,
    report_route_applicable: false,
  });
  assertEquals(
    ruled.blockers.map((blocker) => blocker.code),
    [],
  );
  assert(ruled.clean, "one invoice route is a complete roof-report pack");
  assertEquals(ruled.approval_band, "shaun_clean");
  // An absent field can only ever be stricter, never looser.
  assert(
    evaluateSesMechanicalClean(portalReport).blockers.some((item) =>
      item.code === "route_draft_missing"
    ),
  );
});

Deno.test("the ruled report-only question no longer parks any card", () => {
  // `report-only-email-applicability` was decided on 2026-08-06. A decided
  // question must stop holding cards: no blocker may carry that decision key,
  // and a report-only card must not be decision_blocked for it.
  const result = evaluateSesMechanicalClean(cleanInput({
    report_only: true,
    report_route_applicable: false,
    photo_route_applicable: false,
    routes: cleanInput().routes.filter((route) =>
      route.route_kind === "invoice"
    ),
  }));
  assertEquals(
    result.blockers.map((blocker) => blocker.decision_key).filter(Boolean),
    [],
  );
  assert(result.approval_band !== "decision_blocked");
});

Deno.test("physical make-safe still owes its report email after the ruling", () => {
  // The ruling covers report-only portal cards ONLY. Ordinary physical
  // make-safe keeps all three destinations, so a missing report route is still
  // an honest hold — and no producer may exempt it by leaving the field unset.
  const noReport = cleanInput({
    family: "physical_makesafe",
    report_only: false,
    routes: cleanInput().routes.filter((route) =>
      route.route_kind !== "report"
    ),
  });
  for (
    const input of [noReport, { ...noReport, report_route_applicable: true }]
  ) {
    const blocker = evaluateSesMechanicalClean(input).blockers.find(
      (item) => item.code === "route_draft_missing",
    );
    assert(
      blocker,
      "physical make-safe must still be held for its report email",
    );
    assertStringIncludes(blocker!.fact, "report email");
  }
  // The report route is required, and dropping the photo email does not drop it.
  assertEquals(
    requiredSesRouteKinds("physical_makesafe", false, "MLB", true),
    ["report", "invoice"],
  );
  assertEquals(
    requiredSesRouteKinds("physical_makesafe", true, "MLB"),
    ["report", "photo", "invoice"],
  );
});

Deno.test("a ruled roof-report card requires exactly the one invoice route", () => {
  assertEquals(
    requiredSesRouteKinds("ordinary_roof_portal", false, "MLB", false),
    ["invoice"],
  );
  // Honesty, not green: an unready invoice route on that same card still holds.
  const unreadyInvoice = evaluateSesMechanicalClean(cleanInput({
    report_only: true,
    report_route_applicable: false,
    photo_route_applicable: false,
    routes: cleanInput().routes
      .filter((route) => route.route_kind === "invoice")
      .map((route) => ({ ...route, ready: false })),
  }));
  const blocker = unreadyInvoice.blockers.find(
    (item) => item.code === "route_draft_missing",
  );
  assert(blocker, "an unready invoice route must still be named");
  assertStringIncludes(blocker!.fact, "invoice email");
});

Deno.test("SEND IT states the real cause, quoting the blocker's own fact", () => {
  // The live Bertram case: report and invoice fine, photo drafted with zero
  // attachments. SEND must say THAT, not "locked by the hold above".
  const noAttachments = cleanInput({
    routes: cleanInput().routes.map((route) =>
      route.route_kind === "photo"
        ? { ...route, attachment_hashes: [], ready: false }
        : route
    ),
  });
  const verdict = evaluateSesMechanicalClean(noAttachments);
  const reason = sendItDisabledReason(verdict, {
    stale: false,
    xeroAuthorised: true,
    noAdditionalCharge: false,
  });
  assertStringIncludes(reason, "photo email");
  assertStringIncludes(reason, "no attachments");
  assert(!reason.includes("locked by the hold"));

  // Money not yet authorised names the actual Xero status.
  assertStringIncludes(
    sendItDisabledReason(evaluateSesMechanicalClean(cleanInput()), {
      stale: false,
      xeroAuthorised: false,
      noAdditionalCharge: false,
      xeroStatus: "DRAFT",
    }),
    "is DRAFT, not AUTHORISED",
  );

  // A stale view is named as stale rather than blamed on the pack.
  assertStringIncludes(
    sendItDisabledReason(evaluateSesMechanicalClean(cleanInput()), {
      stale: true,
      xeroAuthorised: true,
      noAdditionalCharge: false,
    }),
    "older docket revision",
  );
});

Deno.test("SEND IT carries a disabled_reason whenever it is locked, and none when enabled", () => {
  const input = cleanInput({
    routes: cleanInput().routes.filter((r) => r.route_kind !== "photo"),
  });
  const locked = buildSesCockpitView({
    job_id: "job-1",
    job_number: "SWMS-1",
    docket_revision_id: "docket-1",
    readiness_revision:
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    dependency_generation: 3,
    invoice_obligation_revision_id: "obligation-revision-1",
    attendance_cycle_ids: ["cycle-1"],
    xero_binding: {
      xero_invoice_id: "xero-inv-1102",
      invoice_number: "INV-1102",
      status: "AUTHORISED",
      total: 825,
    },
    local_invoice_proposal: { total: 825 },
    work_order: { state: "ready" },
    family_evidence: {},
    swms: {},
    routes: input.routes,
    crew_and_trade_visits: [],
    clean_input: input,
  });
  assertEquals(locked.controls.send_it.enabled, false);
  assert(
    typeof locked.controls.send_it.disabled_reason === "string" &&
      locked.controls.send_it.disabled_reason.length > 0,
    "a locked SEND IT must say why",
  );
  assertStringIncludes(locked.controls.send_it.disabled_reason!, "photo email");
  assertEquals(locked.controls.send_it.failed_checks.map((c) => c.id), ["C11"]);
});

Deno.test("a not-clean verdict with NO blockers asserts nothing and passes the facts through", () => {
  // A card with no invoice obligation row: C3 and C10 fail and push nothing,
  // so the blocker list is legitimately empty. Citing blockers here would be
  // the exact inversion of the false hold this surface exists to remove, and
  // inventing a negative money sentence would be an unproven money claim.
  const verdict = evaluateSesMechanicalClean(cleanInput({
    pricing_disposition: "money_review_required",
    obligation_revision_count: 0,
  }));
  assertEquals(verdict.clean, false);
  assertEquals(verdict.blockers.length, 0);

  const reason = sendItDisabledReason(verdict, {
    stale: false,
    xeroAuthorised: true,
    noAdditionalCharge: false,
  });
  assertEquals(reason, "This pack is not ready to send yet.");
  assert(
    !reason.toLowerCase().includes("blocker"),
    `must not claim blockers that do not exist: ${reason}`,
  );
  assert(!/\bmint/i.test(reason));

  // The cause rides as structured data carrying the EXISTING affirmative facts,
  // byte for byte as evaluateSesMechanicalClean wrote them — never re-worded
  // into a negative on the way out.
  const failed = sesFailedChecks(verdict);
  assertEquals(failed.map((item) => item.id), ["C3", "C10"]);
  for (const item of failed) {
    assertEquals(
      item.fact,
      verdict.checks.find((check) => check.id === item.id)?.fact,
    );
  }
  assertEquals(
    failed[1].fact,
    "Exactly one non-ambiguous obligation revision owns this work.",
  );

  // Nothing failed, nothing named: the consumer still shows the honest generic.
  assertEquals(
    sesFailedChecks(evaluateSesMechanicalClean(cleanInput())),
    [],
  );
  assertEquals(
    sendItDisabledReason(
      { clean: false, checks: [], blockers: [], approval_band: "captain_only" },
      { stale: false, xeroAuthorised: true, noAdditionalCharge: false },
    ),
    "This pack is not ready to send yet.",
  );
});

Deno.test("the route fact and remedy classify one defect, never two", () => {
  // One classifier, two sentences: the fact states what IS, the remedy states
  // what clears it, and they must always be about the SAME defect.
  const cases: Array<[Partial<SesReviewRoute> | null, string, string]> = [
    [null, "has no draft", "carries no photo email draft at all"],
    [
      { attachment_hashes: [], ready: false },
      "carries no attachments",
      "no attachments",
    ],
    [{ subject: "  " }, "has no subject", "missing its subject"],
    [{ body: "  " }, "has no body", "missing its body"],
    [{ ready: false }, "not marked ready", "not marked ready"],
  ];
  for (const [override, factMarker, remedyMarker] of cases) {
    const routes = cleanInput().routes.flatMap((route) => {
      if (route.route_kind !== "photo") return [route];
      return override === null ? [] : [{ ...route, ...override }];
    });
    const verdict = evaluateSesMechanicalClean(cleanInput({ routes }));
    const blocker = verdict.blockers.find((item) =>
      item.code === "route_draft_missing"
    );
    assert(blocker, `expected a route_draft_missing blocker for ${factMarker}`);
    assertStringIncludes(blocker!.fact, "photo email");
    assertStringIncludes(blocker!.fact, factMarker);
    assertStringIncludes(blocker!.recovery_action, remedyMarker);
  }
});
