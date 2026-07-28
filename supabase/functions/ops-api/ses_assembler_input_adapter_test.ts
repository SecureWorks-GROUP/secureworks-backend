// deno-lint-ignore-file no-import-prefix require-await
import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import fixture from "./fixtures/ses_u4_swms_26980_live_snapshot.json" with {
  type: "json",
};
import {
  buildSesAssemblerInput,
  createSesAssemblerRuntimeDependencies,
  normalizeSesPrepareRequest,
  physicalReportRenderJob,
  SesAssemblerAdapterError,
  type SesAssemblerLiveSnapshot,
  summarizeSesPrepareResponseForHttp,
} from "./ses_assembler_input_adapter.ts";
import {
  SES_ASSEMBLER_VERSION,
  SES_INPUT_CONTRACT_VERSION,
  sesSha256,
} from "./ses_docket_envelope.ts";
import { SES_FAMILY_MATRIX_VERSION } from "./ses_family_matrix.ts";
import {
  prepare_ses_docket_revision,
  SES_ASSESSMENT_RECIPE_VERSION,
} from "./ses_prepare_docket_revision.ts";

function snapshot(): SesAssemblerLiveSnapshot {
  const { captured_from: _capturedFrom, ...liveSnapshot } = structuredClone(
    fixture,
  );
  return liveSnapshot as SesAssemblerLiveSnapshot;
}

function sourceResolver(input: ReturnType<typeof buildSesAssemblerInput>) {
  return input.source.attachment_pointers.map((source_pointer) => ({
    source_pointer,
    file_name: "MLB-26567PO-56164-work-order.pdf",
    media_type: "application/pdf",
    bytes: new Uint8Array([37, 80, 68, 70, 1]),
  }));
}

function blockerCodes(result: { blockers: Array<{ reason_code: string }> }) {
  return result.blockers.map((item) => item.reason_code);
}

function changedPaths(
  before: unknown,
  after: unknown,
  path = "",
): string[] {
  if (Object.is(before, after)) return [];
  if (
    before &&
    after &&
    typeof before === "object" &&
    typeof after === "object"
  ) {
    if (Array.isArray(before) && Array.isArray(after)) {
      const paths = before.flatMap((value, index) =>
        changedPaths(value, after[index], `${path}[${index}]`)
      );
      return before.length === after.length
        ? paths
        : [...paths, `${path}.length`];
    }
    if (!Array.isArray(before) && !Array.isArray(after)) {
      const keys = [
        ...new Set([
          ...Object.keys(before),
          ...Object.keys(after),
        ]),
      ].sort();
      return keys.flatMap((key) =>
        changedPaths(
          (before as Record<string, unknown>)[key],
          (after as Record<string, unknown>)[key],
          path ? `${path}.${key}` : key,
        )
      );
    }
  }
  return [path];
}

function sanitizedAssessmentSnapshot(args: {
  jobNumber: string;
  reportType: string | null;
  photoLinkKind: "photos" | "photo_schedule";
}): SesAssemblerLiveSnapshot {
  const suffix = args.jobNumber.toLowerCase().replaceAll("-", "");
  const jobId = `sanitized-job-${suffix}`;
  const cycleId = `sanitized-cycle-${suffix}`;
  return {
    job: {
      id: jobId,
      job_number: args.jobNumber,
      type: "makesafe",
      client_name: "Sanitized client",
      site_address: "Sanitized address",
      site_suburb: "Sanitized suburb",
      metadata: {
        makesafe_job_family: "assessment_report_quote",
      },
    },
    detail: {
      job_id: jobId,
      requesting_company_slug: "mlb",
      requesting_company_name: "ML Builders",
      external_ref: "SANITIZED-BUILDER-REFERENCE",
      report_type: args.reportType,
      attendance_cycle_id: cycleId,
      cycle_attribution: "bound",
      external_links: [
        {
          kind: "assessment_report",
          label: "Assessment report",
          source: "sanitized",
          url: `https://portal.example.test/${suffix}/assessment`,
        },
        {
          kind: args.photoLinkKind,
          label: "Photos",
          source: "sanitized",
          url: `https://portal.example.test/${suffix}/photos`,
        },
        {
          kind: "quote",
          label: "Quote",
          source: "sanitized",
          url: `https://portal.example.test/${suffix}/quote`,
        },
      ],
      makesafe_companies: {
        slug: "mlb",
        name: "ML Builders",
        report_recipient: "reports@example.test",
      },
    },
    identity_revision: null,
    cases: [],
    cycles: [{ id: cycleId, job_id: jobId, cycle_number: 1 }],
    reports: [],
    assignments: [
      { id: `sanitized-assignment-a-${suffix}`, job_id: jobId },
      { id: `sanitized-assignment-b-${suffix}`, job_id: jobId },
    ],
    media: [],
    documents: [{
      id: `sanitized-work-order-${suffix}`,
      job_id: jobId,
      type: "work_order",
    }],
    roof_draft: null,
    readiness: null,
    legacy_packs: [],
    portal_captures: [],
  };
}

function liveSnapshotClient(live: SesAssemblerLiveSnapshot) {
  const rows: Record<string, unknown> = {
    jobs: [live.job],
    makesafe_job_details: [live.detail],
    makesafe_intake_cases: live.cases,
    makesafe_attendance_cycles: live.cycles,
    job_service_reports: live.reports,
    job_assignments: live.assignments,
    job_media: live.media,
    job_documents: live.documents,
    makesafe_roof_report_drafts: live.roof_draft ? [live.roof_draft] : [],
    makesafe_readiness_current: live.readiness ? [live.readiness] : [],
    makesafe_report_packs: live.legacy_packs,
    job_events: live.events || [],
    makesafe_sibling_bundle_binding_revisions: live.bundle_bindings || [],
    makesafe_sibling_evidence_claims: live.bundle_claims || [],
    xero_invoices: live.bundle_invoices || [],
    emails: live.bundle_emails || [],
  };
  return {
    from(table: string) {
      let single = false;
      const query = {
        select() {
          return query;
        },
        eq() {
          return query;
        },
        neq() {
          return query;
        },
        in() {
          return query;
        },
        order() {
          return query;
        },
        limit() {
          return query;
        },
        maybeSingle() {
          single = true;
          return query;
        },
        then(
          resolve: (value: { data: unknown; error: null }) => unknown,
        ) {
          const data = rows[table] ?? [];
          return Promise.resolve({
            data: single && Array.isArray(data) && data.length === 1
              ? data[0]
              : single
              ? null
              : data,
            error: null,
          }).then(resolve);
        },
      };
      return query;
    },
  };
}

function roofPortalSnapshot(
  jobId = "3ffaf0e2-3080-44eb-bbdc-d2dd812d8b2a",
  jobNumber = "SWMS-261019",
): SesAssemblerLiveSnapshot {
  // The job id/number, current cycle, reference and typed Prime link are the
  // read-only production values for SWMS-261019 captured on 2026-07-28.
  const live = snapshot();
  live.job.id = jobId;
  live.job.job_number = jobNumber;
  live.job.metadata.makesafe_job_family = "roof_report";
  live.job.client_name = "Ordinary insured";
  live.job.metadata.external_ref = "MLB-27037PO-56395";
  live.detail!.job_id = jobId;
  live.detail!.report_type = null;
  live.detail!.external_ref = "MLB-27037";
  live.detail!.attendance_cycle_id = "e805ffd2-539f-4266-82ac-1eaa1d869bda";
  live.detail!.external_links = [{
    kind: "builder_portal",
    label: "Builder portal link",
    url: "https://primeeco.tech/share/d2ff4956-1302-4ef8-a49e-c9d29061ef4b",
  }];
  live.cycles[0].id = live.detail!.attendance_cycle_id;
  for (
    const rows of [
      live.cycles,
      live.reports,
      live.assignments,
      live.media,
      live.documents,
    ]
  ) {
    for (const row of rows) {
      row.job_id = jobId;
      if ("attendance_cycle_id" in row) {
        row.attendance_cycle_id = live.detail!.attendance_cycle_id;
      }
    }
  }
  live.identity_revision = {
    authority_kind: "legacy_job_record",
    source_instruction_id: `legacy-job:${jobId}`,
    source_version: 1,
    source_content_hash: `sha256:${"a".repeat(64)}`,
    lineage_id: jobId,
    effective_case_id: null,
  };
  return live;
}
Deno.test(
  "SWMS-26980 live fixture builds canonical v1 input without inventing U1 spine facts",
  () => {
    const input = buildSesAssemblerInput(snapshot());
    assertEquals(input.contract_version, SES_INPUT_CONTRACT_VERSION);
    assertEquals(input.identity.job_id, "5383e3c4-eb32-41cf-8e3c-63a754c16d05");
    assertEquals(input.identity.job_number, "SWMS-26980");
    assertEquals(input.identity.source_instruction_id, "");
    assertEquals(input.identity.lineage_id, "");
    assertEquals(input.attendance, {
      attendance_cycle_ids: ["c7f8f100-3120-4534-880b-bd4bb58928fa"],
      current_attendance_cycle_id: "c7f8f100-3120-4534-880b-bd4bb58928fa",
      cycle_number: 1,
      attribution: "bound",
    });
    assertEquals(input.classification.builder_key, "MLB");
    assertEquals(input.classification.family, "own_template_roof");
    assertEquals(
      input.classification.delivery_render_route,
      "secureworks_own_letterhead",
    );
    assertEquals(
      input.classification.delivery_render_route_reason_code,
      "client_relationship_requires_own_letterhead",
    );
    assertEquals(input.classification.delivery_render_route_evidence, [
      "jobs.client_name#relationship:strata",
    ]);
    assertEquals(input.source.builder_reference, "");
    assertEquals(input.source.po_or_external_ref, null);
    assertEquals(input.source.deliverables, []);
    assertEquals(input.source.portal_links, [
      {
        role: "assessment",
        url: "https://primeeco.tech/share/2ef11c67-8f63-48cb-9ff4-61bf71848f17",
        source: "job_detail",
      },
    ]);
    assertEquals(input.source.attachment_pointers, [
      "job_document:205d0d18-a40f-4617-9e41-0fa0934a112b",
    ]);
    assertEquals(Object.hasOwn(input, "sibling_bundle_evidence"), false);
  },
);

Deno.test(
  "public U4 request defaults sealed versions but requires explicit dry-run and one selector",
  () => {
    assertEquals(
      normalizeSesPrepareRequest({
        selection: { mode: "job_number", job_number: "SWMS-26980" },
        idempotency_key: "proof-swms-26980-20260727",
        dry_run: true,
      }),
      {
        selection: { mode: "job_number", job_number: "SWMS-26980" },
        idempotency_key: "proof-swms-26980-20260727",
        assembler_version: SES_ASSEMBLER_VERSION,
        dry_run: true,
        force_refresh: false,
      },
    );
    for (
      const invalid of [
        {
          selection: { mode: "job_number", job_number: "SWMS-26980" },
          idempotency_key: "key",
        },
        {
          selection: {
            mode: "job_number",
            job_number: "SWMS-26980",
            job_id: "also-present",
          },
          idempotency_key: "key",
          dry_run: true,
        },
      ]
    ) {
      try {
        normalizeSesPrepareRequest(invalid);
        throw new Error("expected request rejection");
      } catch (error) {
        assert(error instanceof SesAssemblerAdapterError);
        assertEquals(error.status, 400);
      }
    }
  },
);

Deno.test(
  "SWMS-26980 production-shape dry-run is HTTP-envelope ready, write-free and specifically blocked",
  async () => {
    const input = buildSesAssemblerInput(snapshot());
    let persistCalls = 0;
    const response = await prepare_ses_docket_revision(
      {
        selection: {
          mode: "job_id",
          job_id: "5383e3c4-eb32-41cf-8e3c-63a754c16d05",
        },
        idempotency_key: "proof-swms-26980-20260727",
        assembler_version: SES_ASSEMBLER_VERSION,
        dry_run: true,
        force_refresh: true,
      },
      {
        resolveInput: async () => input,
        resolveSourceArtifacts: async () => sourceResolver(input),
        persist: async () => {
          persistCalls++;
          return { committed_at: "2026-07-27T08:00:00.000Z" };
        },
        now: () => new Date("2026-07-27T08:00:00.000Z"),
      },
    );
    assertEquals(response.action, "prepare_ses_docket_revision");
    assertEquals(response.dry_run, true);
    assertEquals(response.results.length, 1);
    const result = response.results[0];
    assertEquals(result.state, "blocked");
    assertEquals(result.persisted, false);
    assertEquals(persistCalls, 0);
    const codes = blockerCodes(result);
    assert(codes.includes("spine_missing_source"));
    assert(codes.includes("spine_missing_lineage"));
    assert(codes.includes("trade_evidence_missing"));
    assert(!codes.includes("family_unknown"));
    assert(!codes.includes("delivery_route_unroutable"));
    assert(!codes.some((code) => code.startsWith("portal_")));
    assert(!codes.includes("capability_portal_degraded"));
    assertEquals(
      result.envelope.v2.classification.delivery_render_route,
      "secureworks_own_letterhead",
    );
    assertEquals(
      result.envelope.v2.classification.delivery_render_route_reason_code,
      "client_relationship_requires_own_letterhead",
    );
    assert(!codes.includes("recovery-not-run"));
  },
);

Deno.test(
  "legacy bundle note without a durable binding emits the suspected-sibling blocker",
  async () => {
    const live = snapshot();
    live.events = [{
      event_type: "note",
      detail_json: {
        text:
          "BUNDLED into SWMS-26837 temp-fence make-safe; labour+report+SWMS covered under INV-0835.",
      },
    }];
    const input = buildSesAssemblerInput(live);
    assertEquals(input.sibling_bundle_evidence, {
      status: "binding_missing",
      suspected_sibling_job_id: null,
      suspected_sibling_job_number: "SWMS-26837",
      suspected_invoice_number: "INV-0835",
      bundle_id: null,
      binding_revision_id: null,
      reverse_binding_revision_id: null,
      coverage_failures: ["claiming_direction_not_bound"],
    });
    const result = (await prepare_ses_docket_revision(
      {
        selection: { mode: "job_id", job_id: input.identity.job_id },
        idempotency_key: "bundle-missing-test",
        assembler_version: SES_ASSEMBLER_VERSION,
        dry_run: true,
        force_refresh: true,
      },
      {
        resolveInput: async () => input,
        now: () => new Date("2026-07-28T04:00:00Z"),
      },
    )).results[0];
    const blocker = result.blockers.find((item) =>
      item.reason_code === "sibling_evidence_bundle_missing"
    );
    assert(blocker);
    assertEquals(blocker.facts?.suspected_sibling_job_number, "SWMS-26837");
    assertEquals(blocker.facts?.suspected_invoice_number, "INV-0835");
  },
);

Deno.test(
  "a one-way sibling binding remains rejected and cannot unlock evidence sharing",
  async () => {
    const live = snapshot();
    live.events = [{
      event_type: "note",
      detail_json: {
        text:
          "BUNDLED into SWMS-26837 temp-fence make-safe; labour+report+SWMS covered under INV-0835.",
      },
    }];
    live.bundle_jobs = [{
      id: "02f614a4-09a7-422e-9381-c89a44aceccd",
      job_number: "SWMS-26837",
    }];
    live.bundle_bindings = [{
      id: "forward-revision",
      bundle_id: "bundle-1",
      org_id: "org-1",
      job_id: live.job.id,
      sibling_job_id: "02f614a4-09a7-422e-9381-c89a44aceccd",
      state: "bound",
      recorded_by: "operator",
      recorded_via: "test",
      provenance: { reason: "reviewed" },
      recorded_at: "2026-07-28T04:00:00Z",
    }];
    const input = buildSesAssemblerInput(live);
    assertEquals(
      input.sibling_bundle_evidence?.status,
      "binding_not_bidirectional",
    );
    const result = (await prepare_ses_docket_revision(
      {
        selection: { mode: "job_id", job_id: input.identity.job_id },
        idempotency_key: "bundle-one-way-test",
        assembler_version: SES_ASSEMBLER_VERSION,
        dry_run: true,
        force_refresh: true,
      },
      {
        resolveInput: async () => input,
        now: () => new Date("2026-07-28T04:00:00Z"),
      },
    )).results[0];
    assert(
      blockerCodes(result).includes(
        "sibling_evidence_bundle_not_bidirectional",
      ),
    );
    assert(
      !result.artifacts.some((artifact) =>
        artifact.role === "sibling_bundle_evidence"
      ),
    );
  },
);

Deno.test(
  "the adapter accepts only reciprocal bindings with exact positive invoice and delivery scope",
  () => {
    const live = snapshot();
    const siblingId = "02f614a4-09a7-422e-9381-c89a44aceccd";
    live.events = [{
      event_type: "note",
      detail_json: {
        text:
          "BUNDLED into SWMS-26837 temp-fence make-safe; labour+report+SWMS covered under INV-0835.",
      },
    }];
    live.bundle_jobs = [{ id: siblingId, job_number: "SWMS-26837" }];
    live.bundle_bindings = [
      {
        id: "forward-revision",
        bundle_id: "bundle-1",
        org_id: "org-1",
        job_id: live.job.id,
        sibling_job_id: siblingId,
        state: "bound",
        recorded_by: "operator",
        recorded_via: "reviewed_migration",
        provenance: { reason: "reviewed" },
        recorded_at: "2026-07-28T04:00:00Z",
      },
      {
        id: "reverse-revision",
        bundle_id: "bundle-1",
        org_id: "org-1",
        job_id: siblingId,
        sibling_job_id: live.job.id,
        state: "bound",
        recorded_by: "operator",
        recorded_via: "reviewed_migration",
        provenance: { reason: "reciprocal" },
        recorded_at: "2026-07-28T04:00:00Z",
      },
    ];
    live.bundle_claims = [{
      binding_revision_id: "forward-revision",
      invoice_id: "invoice-0835",
      invoice_line_item_id: "line-0835",
      invoice_scope_phrase: "Hardie panel stacking",
      delivery_email_post_id: "mail-0835",
      delivery_email_content_sha256:
        "0be5b5d7d6c7d921a3976a5332b326989e83cf36cb2653b6c349ac68ef4bceba",
      delivery_scope_phrase: "displaced Hardie panels stacked safely",
      photo_scope_phrase: "displaced Hardie panels stacked safely",
      photo_media_id: "photo-26837",
      photo_content_hash:
        "sha256:f46202099887565a5738073440de40efa1b0793bfb13576ff69b7d5d56667f60",
      report_document_id: "report-26837",
      swms_document_id: "swms-26837",
    }];
    live.bundle_invoices = [{
      id: "invoice-0835",
      job_id: siblingId,
      invoice_number: "INV-0835",
      status: "AUTHORISED",
      line_items: [{
        LineItemID: "line-0835",
        Description:
          "Temporary fence make-safe incl Hardie panel stacking - 2 trades x 3 hours",
      }],
    }];
    live.bundle_emails = [{
      post_id: "mail-0835",
      subject: "MLB-26393 - 71 Peppermint Way",
      body_preview:
        "Temporary fencing installed plus displaced Hardie panels stacked safely on site.",
      has_attachments: true,
      content_sha256:
        "0be5b5d7d6c7d921a3976a5332b326989e83cf36cb2653b6c349ac68ef4bceba",
    }];
    live.bundle_documents = [
      {
        id: "report-26837",
        job_id: siblingId,
        type: "makesafe_report",
      },
      { id: "swms-26837", job_id: siblingId, type: "swms" },
    ];
    live.bundle_media = [{
      id: "photo-26837",
      job_id: siblingId,
      type: "photo",
      label: "Displaced Hardie panels stacked safely",
      notes: "",
      makesafe_content_hash:
        "sha256:f46202099887565a5738073440de40efa1b0793bfb13576ff69b7d5d56667f60",
    }];
    const input = buildSesAssemblerInput(live);
    assertEquals(input.sibling_bundle_evidence?.status, "accepted");
    if (input.sibling_bundle_evidence?.status !== "accepted") {
      throw new Error("expected accepted bundle");
    }
    assertEquals(
      input.sibling_bundle_evidence.coverage.invoice.line_item_id,
      "line-0835",
    );
    assertEquals(
      input.sibling_bundle_evidence.coverage.delivery.email_post_id,
      "mail-0835",
    );

    live.bundle_invoices[0].line_items[0].Description =
      "Temporary fencing installed on sibling card only";
    const rejected = buildSesAssemblerInput(live);
    assertEquals(
      rejected.sibling_bundle_evidence?.status,
      "scope_evidence_missing",
    );
    if (rejected.sibling_bundle_evidence?.status !== "scope_evidence_missing") {
      throw new Error("expected scope blocker");
    }
    assert(
      rejected.sibling_bundle_evidence.coverage_failures.includes(
        "invoice_line_scope_not_covered",
      ),
    );
  },
);

Deno.test(
  "a reciprocal relationship without a directional claim does not change that card",
  () => {
    const live = snapshot();
    live.bundle_bindings = [{
      id: "reverse-only-for-this-card",
      bundle_id: "bundle-1",
      org_id: "org-1",
      job_id: live.job.id,
      sibling_job_id: "sibling-job",
      state: "bound",
      recorded_by: "operator",
      recorded_via: "reviewed_migration",
      provenance: { reason: "reciprocal relationship only" },
      recorded_at: "2026-07-28T04:00:00Z",
    }];
    live.bundle_jobs = [{
      id: "sibling-job",
      job_number: "SWMS-26832",
    }];
    assertEquals(
      Object.hasOwn(buildSesAssemblerInput(live), "sibling_bundle_evidence"),
      false,
    );
  },
);

type SeedGuardFixture = {
  jobs: string[];
  invoice: boolean;
  delivery: boolean;
  documents: number;
  media: number;
};

function seedGuardOutcome(
  fixture: SeedGuardFixture,
): "skip" | "binding_only" | "seed_claim" {
  const hasFootprint = fixture.jobs.length > 0 || fixture.invoice ||
    fixture.delivery || fixture.documents > 0 || fixture.media > 0;
  if (!hasFootprint) return "skip";
  const bindingFootprintComplete = fixture.jobs.includes("claiming") &&
    fixture.jobs.includes("sibling") && fixture.invoice && fixture.delivery &&
    fixture.documents === 2;
  if (!bindingFootprintComplete) {
    throw new Error(
      "reviewed sibling evidence seed refused: partial or drifted production footprint",
    );
  }
  if (fixture.media === 0) return "binding_only";
  if (fixture.media === 1) return "seed_claim";
  throw new Error(
    "reviewed sibling evidence claim refused: multiple reviewed photo artifacts matched",
  );
}

Deno.test(
  "sibling evidence migration keeps the reviewed binding but never invents a missing photo claim",
  async () => {
    const migration = await Deno.readTextFile(
      new URL(
        "../../migrations/20260728730000_makesafe_sibling_evidence_bundle_u7.sql",
        import.meta.url,
      ),
    );
    for (
      const required of [
        "makesafe_sibling_bundle_binding_revisions",
        "makesafe_sibling_evidence_claims",
        "trg_makesafe_sibling_bundle_binding_validate",
        "trg_makesafe_sibling_evidence_claim_validate",
        "c3afc061-0d4a-43ff-8309-0b8b512e307a",
        "02f614a4-09a7-422e-9381-c89a44aceccd",
        "3be46700-4d5d-4b91-b96e-8baf43ac9d7c",
        "edcaa56c-84d5-4a12-be0d-032bd1d422f3",
        "Hardie panel stacking",
        "displaced Hardie panels stacked safely",
        "reviewed sibling evidence seed refused: partial or drifted production footprint",
        "reviewed sibling evidence binding retained without an evidence claim",
      ]
    ) {
      assertStringIncludes(migration, required);
    }
    assert(
      migration.indexOf("IF NOT EXISTS (\n    SELECT 1\n    FROM public.jobs") <
        migration.indexOf(
          "INSERT INTO public.makesafe_sibling_bundle_binding_revisions",
        ),
    );
    assertStringIncludes(
      migration,
      "AND NOT EXISTS (\n    SELECT 1\n    FROM public.xero_invoices",
    );
    assertStringIncludes(migration, "v_photo_match_count > 1");
    assertStringIncludes(migration, "IF v_photo_match_count = 0 THEN");
    assertEquals(
      migration.includes("expected exactly one reviewed photo artifact"),
      false,
    );
    assert(
      migration.indexOf(
        "INSERT INTO public.makesafe_sibling_bundle_binding_revisions",
      ) <
        migration.indexOf("IF v_photo_match_count = 0 THEN"),
    );
    assert(
      migration.indexOf("IF v_photo_match_count = 0 THEN") <
        migration.indexOf(
          "INSERT INTO public.makesafe_sibling_evidence_claims",
        ),
    );
    for (
      const forbidden of [
        "UPDATE public.jobs",
        "UPDATE public.makesafe_job_details",
        "INSERT INTO public.xero_invoices",
        "INSERT INTO public.job_documents",
        "INSERT INTO public.job_events",
      ]
    ) {
      assertEquals(
        migration.toUpperCase().includes(forbidden.toUpperCase()),
        false,
      );
    }
  },
);

Deno.test("sibling evidence seed guard executes empty, binding-only, claimed, ambiguous, and partial branches", () => {
  assertEquals(
    seedGuardOutcome({
      jobs: [],
      invoice: false,
      delivery: false,
      documents: 0,
      media: 0,
    }),
    "skip",
  );
  assertEquals(
    seedGuardOutcome({
      jobs: ["claiming", "sibling"],
      invoice: true,
      delivery: true,
      documents: 2,
      media: 0,
    }),
    "binding_only",
  );
  assertEquals(
    seedGuardOutcome({
      jobs: ["claiming", "sibling"],
      invoice: true,
      delivery: true,
      documents: 2,
      media: 1,
    }),
    "seed_claim",
  );
  assertThrows(
    () =>
      seedGuardOutcome({
        jobs: ["claiming", "sibling"],
        invoice: true,
        delivery: true,
        documents: 2,
        media: 2,
      }),
    Error,
    "multiple reviewed photo artifacts matched",
  );
  assertThrows(
    () =>
      seedGuardOutcome({
        jobs: ["claiming"],
        invoice: true,
        delivery: true,
        documents: 2,
        media: 1,
      }),
    Error,
    "partial or drifted production footprint",
  );
});

Deno.test(
  "SWMS-261019 U4 dry-run binds persisted capture resolution and names the exact missing capture",
  async () => {
    const live = roofPortalSnapshot();
    const input = buildSesAssemblerInput(live);
    const dependencies = createSesAssemblerRuntimeDependencies(
      liveSnapshotClient(live),
      { org_id: live.job.org_id, created_by: "u4-regression" },
    );
    const response = await prepare_ses_docket_revision(
      {
        selection: { mode: "job_id", job_id: live.job.id },
        idempotency_key: "swms-261019-persisted-capture-missing",
        assembler_version: SES_ASSEMBLER_VERSION,
        dry_run: true,
        force_refresh: true,
      },
      {
        ...dependencies,
        resolveSourceArtifacts: async () => sourceResolver(input),
        now: () => new Date("2026-07-28T08:00:00.000Z"),
      },
    );

    const result = response.results[0];
    const codes = blockerCodes(result);
    assert(codes.includes("portal_capture_missing"));
    assert(!codes.includes("capability_portal_degraded"));
    const blocker = result.blockers.find((item) =>
      item.reason_code === "portal_capture_missing"
    );
    assert(blocker);
    assert(blocker.reason.includes(`job_id=${live.job.id}`));
    assert(
      blocker.reason.includes(
        `attendance_cycle_id=${live.detail!.attendance_cycle_id}`,
      ),
    );
    assert(blocker.reason.includes("role=roof_report"));
    assert(
      blocker.reason.includes(
        "source_url=https://primeeco.tech/share/d2ff4956-1302-4ef8-a49e-c9d29061ef4b",
      ),
    );
  },
);

Deno.test(
  "U4 accepts hash-verified current-cycle persisted portal evidence with provenance",
  async () => {
    const live = roofPortalSnapshot();
    const input = buildSesAssemblerInput(live);
    const sourceUrl = input.source.portal_links[0].url;
    const screenshotBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const screenshotHash = await rawSesPortalCaptureSha256(screenshotBytes);
    const storagePath = [
      "portal-captures",
      live.job.id,
      live.detail!.attendance_cycle_id,
      "roof_report",
      `${screenshotHash.slice("sha256:".length)}.png`,
    ].join("/");
    const content: SesPortalCaptureRevisionContent = {
      job_id: live.job.id,
      attendance_cycle_id: live.detail!.attendance_cycle_id,
      role: "roof_report",
      capture_result: "done",
      source_url: sourceUrl,
      source_content_hash: `sha256:${"b".repeat(64)}`,
      builder_reference: input.source.builder_reference,
      captured_at: "2026-07-28T07:55:00.000Z",
      captured_by: "chrome-agent@secureworks.test",
      capture_producer: SES_PORTAL_CAPTURE_PRODUCER,
      capture_idempotency_key: "capture-swms-261019-roof-v1",
      signal: "submitted-and-locked",
      screenshot_object_key: `${SES_PORTAL_CAPTURE_BUCKET}/${storagePath}`,
      screenshot_media_type: "image/png",
      screenshot_content_hash: screenshotHash,
      screenshot_size_bytes: screenshotBytes.byteLength,
    };
    live.portal_captures = [{
      id: "9de05ac0-c55f-4f42-a506-acdebad8a1a1",
      org_id: live.job.org_id,
      ...content,
      status: "verified",
      makesafe_fact_version: 1,
      makesafe_content_hash: await sesPortalCaptureRevisionHash(content),
      evidence_refs: [],
      created_at: "2026-07-28T07:56:00.000Z",
      created_by: "ops-api:api_key",
    }];
    const dependencies = createSesAssemblerRuntimeDependencies(
      liveSnapshotClient(live, { [storagePath]: screenshotBytes }),
      { org_id: live.job.org_id, created_by: "u4-regression" },
    );
    const response = await prepare_ses_docket_revision(
      {
        selection: { mode: "job_id", job_id: live.job.id },
        idempotency_key: "swms-261019-persisted-capture-present",
        assembler_version: SES_ASSEMBLER_VERSION,
        dry_run: true,
        force_refresh: true,
      },
      {
        ...dependencies,
        resolveSourceArtifacts: async () => sourceResolver(input),
        now: () => new Date("2026-07-28T08:00:00.000Z"),
      },
    );

    const result = response.results[0];
    const codes = blockerCodes(result);
    assert(!codes.includes("portal_capture_missing"));
    assert(!codes.includes("portal_capture_invalid"));
    assert(!codes.includes("capability_portal_degraded"));
    const evidence = result.artifacts.find((artifact) =>
      artifact.path === "EVIDENCE/portal_roof_report.json"
    );
    assert(evidence);
    const persisted = JSON.parse(new TextDecoder().decode(evidence.bytes));
    assertEquals(persisted.captured_by, content.captured_by);
    assertEquals(persisted.capture_producer, content.capture_producer);
    assertEquals(
      persisted.evidence_revision_id,
      live.portal_captures[0].id,
    );
  },
);

Deno.test(
  "U4 rejects malformed not_done screenshot evidence as portal_capture_invalid",
  async () => {
    const live = roofPortalSnapshot();
    const input = buildSesAssemblerInput(live);
    const sourceUrl = input.source.portal_links[0].url;
    const screenshotBytes = new Uint8Array([1, 2, 3]);
    const screenshotHash = await rawSesPortalCaptureSha256(screenshotBytes);
    const storagePath = [
      "portal-captures",
      live.job.id,
      live.detail!.attendance_cycle_id,
      "roof_report",
      `${screenshotHash.slice("sha256:".length)}.png`,
    ].join("/");
    const content: SesPortalCaptureRevisionContent = {
      job_id: live.job.id,
      attendance_cycle_id: live.detail!.attendance_cycle_id,
      role: "roof_report",
      capture_result: "not_done",
      source_url: sourceUrl,
      source_content_hash: `sha256:${"b".repeat(64)}`,
      builder_reference: input.source.builder_reference,
      captured_at: "2026-07-28T07:55:00.000Z",
      captured_by: "chrome-agent@secureworks.test",
      capture_producer: SES_PORTAL_CAPTURE_PRODUCER,
      capture_idempotency_key: "capture-swms-261019-roof-not-done-v1",
      signal: "portal-not-submitted",
      screenshot_object_key: `${SES_PORTAL_CAPTURE_BUCKET}/${storagePath}`,
      screenshot_media_type: "image/png",
      screenshot_content_hash: screenshotHash,
      screenshot_size_bytes: screenshotBytes.byteLength,
    };
    live.portal_captures = [{
      id: "9de05ac0-c55f-4f42-a506-acdebad8a1a2",
      org_id: live.job.org_id,
      ...content,
      status: "captured",
      makesafe_fact_version: 1,
      makesafe_content_hash: await sesPortalCaptureRevisionHash(content),
      evidence_refs: [],
      created_at: "2026-07-28T07:56:00.000Z",
      created_by: "ops-api:api_key",
    }];
    const dependencies = createSesAssemblerRuntimeDependencies(
      liveSnapshotClient(live, { [storagePath]: screenshotBytes }),
      { org_id: live.job.org_id, created_by: "u4-regression" },
    );
    const response = await prepare_ses_docket_revision(
      {
        selection: { mode: "job_id", job_id: live.job.id },
        idempotency_key: "swms-261019-not-done-capture-invalid",
        assembler_version: SES_ASSEMBLER_VERSION,
        dry_run: true,
        force_refresh: true,
      },
      {
        ...dependencies,
        resolveSourceArtifacts: async () => sourceResolver(input),
        now: () => new Date("2026-07-28T08:00:00.000Z"),
      },
    );

    const codes = blockerCodes(response.results[0]);
    assert(codes.includes("portal_capture_invalid"));
    assert(!codes.includes("portal_not_submitted"));
  },
);

Deno.test(
  "live adapter maps the canonical board family without an AJS physical shortcut",
  () => {
    const live = snapshot();
    live.detail!.requesting_company_slug = "aj";
    live.detail!.requesting_company_name = "AJS";
    live.detail!.report_type = null;
    live.job.metadata.requesting_company = { slug: "aj", name: "AJS" };
    live.job.metadata.makesafe_job_family = "temp_fence_makesafe";
    const input = buildSesAssemblerInput(live);
    assertEquals(input.classification.builder_key, "AJS");
    assertEquals(input.classification.family, "temporary_fencing");
    assertEquals(input.classification.report_only, false);
  },
);

Deno.test(
  "live adapter consumes the trade checklist keys written by submit_makesafe_report",
  () => {
    const live = snapshot();
    live.job.client_name = "The Owners of Tranby Villas";
    live.job.site_address = "U24/28 Peninsula Road";
    live.job.site_suburb = "Maylands";
    live.job.metadata.makesafe_job_family = "general_makesafe";
    live.detail!.report_type = null;
    live.detail!.external_links = [];
    live.reports[0].submitted_at = "2026-07-22T04:00:00.000Z";
    live.reports[0].notes = "Trade completion note";
    live.reports[0].checklist_json = {
      arrival_time: "2026-07-20 14:09",
      damage_description:
        "Unsecured bricks on the patio roof and broken plastic sheeting.",
      damage_cause: "Storm / wind",
      work_done:
        "Removed unsecured broken sheeting and screws, then moved the bricks to ground.",
      materials: [],
      materials_used: ["Tarps / roof materials", "Fixings / consumables"],
      labour_hours: 2,
      trade_count: 2,
      access_issues: "Gate code did not work on arrival.",
      follow_up_required: true,
      invoice_notes: "Two trades attended for two hours each.",
    };

    const input = buildSesAssemblerInput(live);
    assertEquals(input.cycle_facts.hours_and_materials, {
      trades: 2,
    });
    const renderJob = physicalReportRenderJob(live, input);
    assertEquals(renderJob, {
      ref: "",
      address: "U24/28 Peninsula Road",
      contact: "The Owners of Tranby Villas",
      date: "2026-07-20",
      arrival: "14:09",
      crew: "2 trades",
      billing_note: "Two trades attended for two hours each.",
      scope: "Unsecured bricks on the patio roof and broken plastic sheeting.",
      findings: "Storm / wind",
      works:
        "Removed unsecured broken sheeting and screws, then moved the bricks to ground.",
      materials: "Tarps / roof materials, Fixings / consumables",
      access_issues: "Gate code did not work on arrival.",
      follow_up_required: "Follow-up required.",
      photos: [],
    });
    assertEquals(
      Object.hasOwn(input.cycle_facts.hours_and_materials || {}, "materials"),
      false,
    );
    assertEquals(
      Object.hasOwn(
        input.cycle_facts.hours_and_materials || {},
        "hours_per_trade",
      ),
      false,
    );
    const renderJobWithPhoto = physicalReportRenderJob(live, input, [
      {
        photo_id: input.cycle_facts.photos[0]?.id || "photo-1",
        source_pointer: input.cycle_facts.photos[0]?.path_or_key ||
          "job_media:photo-1",
        file_name: "completion.jpg",
        media_type: "image/jpeg",
        bytes: new Uint8Array([65, 66]),
      },
    ]);
    assertEquals(renderJobWithPhoto.photos, [
      {
        bytesBase64: "QUI=",
        contentType: "image/jpeg",
        caption: undefined,
      },
    ]);

    live.reports[0].checklist_json.invoice_notes = "";
    assertEquals(
      physicalReportRenderJob(live, buildSesAssemblerInput(live)).billing_note,
      "Trade submission recorded 2 labour hours and 2 trades.",
    );
    live.reports[0].checklist_json.access_issues = "";
    live.reports[0].checklist_json.follow_up_required = false;
    const negativeFacts = physicalReportRenderJob(
      live,
      buildSesAssemblerInput(live),
    );
    assertEquals(negativeFacts.access_issues, "No access issues reported.");
    assertEquals(
      negativeFacts.follow_up_required,
      "No further works required.",
    );
    delete live.reports[0].checklist_json.access_issues;
    delete live.reports[0].checklist_json.follow_up_required;
    const unknownFacts = physicalReportRenderJob(
      live,
      buildSesAssemblerInput(live),
    );
    assertEquals(
      unknownFacts.access_issues,
      "Access constraints: not recorded in trade submission.",
    );
    assertEquals(
      unknownFacts.follow_up_required,
      "Follow-up status: not recorded in trade submission.",
    );
  },
);

Deno.test(
  "physical U4 dry-run blocks instead of rendering without a canonical builder reference",
  async () => {
    const live = snapshot();
    live.job.metadata.makesafe_job_family = "general_makesafe";
    live.detail!.report_type = null;
    live.detail!.external_links = [];
    live.reports[0].checklist_json = {
      damage_description: "Patio roof damage",
      work_done: "Removed loose material",
      labour_hours: 2,
      trade_count: 2,
    };
    live.media = [
      {
        id: "30ad0e72-351c-4f2b-8987-e490c9ffb774",
        job_id: live.job.id,
        type: "photo",
        phase: "completion",
        attendance_cycle_id: live.detail!.attendance_cycle_id,
        cycle_attribution: "bound",
      },
    ];
    const input = buildSesAssemblerInput(live);
    let renderCalls = 0;
    const response = await prepare_ses_docket_revision(
      {
        selection: { mode: "job_id", job_id: input.identity.job_id },
        idempotency_key: "physical-missing-reference",
        assembler_version: SES_ASSEMBLER_VERSION,
        dry_run: true,
        force_refresh: true,
      },
      {
        resolveInput: async () => input,
        resolveSourceArtifacts: async () => sourceResolver(input),
        resolvePhotoProofs: async () => [
          {
            photo_id: input.cycle_facts.photos[0].id,
            source_pointer: input.cycle_facts.photos[0].path_or_key,
            file_name: "completion.jpg",
            media_type: "image/jpeg",
            content_hash:
              "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            size_bytes: 3,
          },
        ],
        renderPhysicalReport: async () => {
          renderCalls++;
          throw new Error(
            "must not render without a canonical builder reference",
          );
        },
        renderSwmsArtifact: async () => ({
          file_name: "SWMS.pdf",
          media_type: "application/pdf",
          bytes: new Uint8Array([37, 80, 68, 70]),
        }),
        now: () => new Date("2026-07-27T08:00:00.000Z"),
      },
    );

    assertEquals(response.results[0].state, "blocked");
    assertEquals(renderCalls, 0);
    assert(blockerCodes(response.results[0]).includes("spine_missing_source"));
  },
);

Deno.test(
  "11-photo U4 dry-run stays bounded, lists proof metadata and never resolves or renders binary photos",
  async () => {
    const live = snapshot();
    live.job.metadata.makesafe_job_family = "general_makesafe";
    live.detail!.report_type = null;
    live.detail!.external_links = [];
    live.reports[0].checklist_json = {
      damage_description: "Patio roof damage",
      work_done: "Removed loose material",
      access_issues: "",
      follow_up_required: false,
      labour_hours: 2,
      trade_count: 2,
    };
    const realPhotoSizes = [
      649_349,
      532_950,
      528_799,
      499_275,
      898_197,
      286_155,
      298_089,
      554_457,
      537_395,
      522_251,
      442_430,
    ];
    live.media = realPhotoSizes.map((size, index) => ({
      id: `30ad0e72-351c-4f2b-8987-${String(index).padStart(12, "0")}`,
      job_id: live.job.id,
      type: "photo",
      phase: "completion",
      attendance_cycle_id: live.detail!.attendance_cycle_id,
      cycle_attribution: "bound",
      label: `Completion photo ${index + 1}`,
      size,
      storage_url: `https://storage.example.test/photo-${index + 1}.jpg`,
    }));
    const input = buildSesAssemblerInput(live);
    const client = liveSnapshotClient(live);
    const dependencies = createSesAssemblerRuntimeDependencies(client, {
      org_id: "org-test",
      created_by: "user-test",
    });
    const originalFetch = globalThis.fetch;
    let activeFetches = 0;
    let maxActiveFetches = 0;
    const fetchedSizes: number[] = [];
    const expectedPhotoHashes: string[] = [];
    globalThis.fetch = async () => {
      activeFetches++;
      maxActiveFetches = Math.max(maxActiveFetches, activeFetches);
      const index = fetchedSizes.length;
      const bytes = new Uint8Array(realPhotoSizes[index]);
      bytes.fill(index + 1);
      fetchedSizes.push(bytes.byteLength);
      const digest = new Uint8Array(
        await crypto.subtle.digest("SHA-256", bytes),
      );
      expectedPhotoHashes.push(
        `sha256:${
          Array.from(digest).map((byte) => byte.toString(16).padStart(2, "0"))
            .join("")
        }`,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      activeFetches--;
      return new Response(bytes.buffer, {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    };
    let renderCalls = 0;
    try {
      const started = performance.now();
      const response = await prepare_ses_docket_revision(
        {
          selection: { mode: "job_id", job_id: input.identity.job_id },
          idempotency_key: "physical-http-artifact-summary",
          assembler_version: SES_ASSEMBLER_VERSION,
          dry_run: true,
          force_refresh: true,
        },
        {
          ...dependencies,
          resolveSourceArtifacts: async () => sourceResolver(input),
          resolvePhotoArtifacts: async () => {
            throw new Error("dry-run must not resolve retained photo bytes");
          },
          renderPhysicalReport: async () => {
            renderCalls++;
            throw new Error("dry-run must not render the report PDF");
          },
          renderSwmsArtifact: async () => null,
        },
      );
      const elapsedMs = performance.now() - started;
      const proofs = response.results[0].artifacts.filter((artifact) =>
        artifact.role === "completion_photo_proof"
      );
      assertEquals(fetchedSizes, realPhotoSizes);
      assertEquals(maxActiveFetches, 1);
      assertEquals(renderCalls, 0);
      assertEquals(proofs.length, 11);
      assertEquals(
        proofs.map((proof) => ({
          photo_id: proof.metadata.photo_id,
          caption: proof.metadata.caption,
          content_hash: proof.metadata.content_hash,
          size_bytes: proof.metadata.size_bytes,
        })),
        input.cycle_facts.photos.map((photo, index) => ({
          photo_id: photo.id,
          caption: photo.caption || null,
          content_hash: expectedPhotoHashes[index],
          size_bytes: realPhotoSizes[index],
        })),
      );
      assertEquals(
        response.results[0].artifacts.some((artifact) =>
          artifact.role === "completion_photo" ||
          artifact.role === "supporting_report_pdf"
        ),
        false,
      );
      const httpResponse = summarizeSesPrepareResponseForHttp(response);
      assert(!JSON.stringify(httpResponse).includes('"bytes"'));
      assert(JSON.stringify(httpResponse).length < 100_000);
      assert(
        elapsedMs < 5_000,
        `11-photo dry-run took ${elapsedMs.toFixed(1)}ms`,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

Deno.test(
  "live adapter maps every canonical board family token exactly",
  () => {
    for (
      const [signal, expected] of [
        ["general_makesafe", "physical_makesafe"],
        ["temp_fence_makesafe", "temporary_fencing"],
        ["assessment_report_quote", "assessment_quote"],
        ["restoration", "restoration"],
      ] as const
    ) {
      const live = snapshot();
      live.detail!.report_type = null;
      live.job.metadata.makesafe_job_family = signal;
      const input = buildSesAssemblerInput(live);
      assertEquals(input.classification.family, expected, signal);
    }

    const portalRoof = snapshot();
    portalRoof.detail!.report_type = null;
    portalRoof.job.metadata.makesafe_job_family = "roof_report";
    portalRoof.job.client_name = "Ordinary insured";
    const portalInput = buildSesAssemblerInput(portalRoof);
    assertEquals(
      portalInput.classification.family,
      "ordinary_roof_portal",
    );
    assertEquals(
      portalInput.classification.delivery_render_route,
      "builder_portal",
    );
    assertEquals(
      portalInput.classification.delivery_render_route_reason_code,
      "portal_builder_family",
    );
    const ownTemplateRoof = snapshot();
    ownTemplateRoof.detail!.report_type = null;
    ownTemplateRoof.detail!.external_links = [];
    ownTemplateRoof.job.metadata.makesafe_job_family = "roof_report";
    ownTemplateRoof.job.metadata.report_delivery = "own_document";
    assertEquals(
      buildSesAssemblerInput(ownTemplateRoof).classification.family,
      "own_template_roof",
    );
  },
);

Deno.test(
  "unsupported roof builder is typed unroutable before any portal capture",
  async () => {
    const live = snapshot();
    live.job.client_name = "Ordinary insured";
    live.job.metadata = {
      makesafe_job_family: "roof_report",
      requesting_company: {
        slug: "unsealed-builder",
        name: "Unsealed Builder",
      },
    };
    live.detail!.requesting_company_slug = "unsealed-builder";
    live.detail!.requesting_company_name = "Unsealed Builder";
    live.detail!.external_ref = "REF-UNSEALED";
    live.detail!.report_type = null;
    live.detail!.makesafe_companies = {
      slug: "unsealed-builder",
      name: "Unsealed Builder",
      report_recipient: "reports@unsealed-builder.test",
    };
    const input = buildSesAssemblerInput(live);
    assertEquals(input.classification.family, "ordinary_roof_portal");
    assertEquals(input.classification.delivery_render_route, "unroutable");
    assertEquals(
      input.classification.delivery_render_route_reason_code,
      "roof_builder_family_unsealed",
    );

    let captureCalls = 0;
    const result = (await prepare_ses_docket_revision(
      {
        selection: { mode: "job_id", job_id: live.job.id },
        idempotency_key: "unroutable-roof-proof",
        assembler_version: SES_ASSEMBLER_VERSION,
        dry_run: true,
        force_refresh: true,
      },
      {
        resolveInput: async () => input,
        capturePortal: async () => {
          captureCalls++;
          throw new Error("unroutable card must not capture a portal");
        },
        now: () => new Date("2026-07-28T08:00:00.000Z"),
      },
    )).results[0];

    const routeBlocker = result.blockers.find((blocker) =>
      blocker.reason_code === "delivery_route_unroutable"
    );
    assert(routeBlocker);
    assert(routeBlocker.reason.includes("Builder UNKNOWN"));
    assertEquals(
      routeBlocker.facts?.route_reason_code,
      "roof_builder_family_unsealed",
    );
    assertEquals(captureCalls, 0);
  },
);

Deno.test(
  "conflicting persisted roof delivery facts fail closed before route selection",
  () => {
    const live = snapshot();
    live.detail!.report_type = null;
    live.job.metadata.makesafe_job_family = "roof_report";
    live.job.metadata.report_delivery = "own_document";
    live.detail!.report_delivery = "portal";
    const input = buildSesAssemblerInput(live);
    assertEquals(input.classification.delivery_render_route, "unroutable");
    assertEquals(
      input.classification.delivery_render_route_reason_code,
      "conflicting_roof_delivery_facts",
    );
    assertEquals(input.classification.delivery_render_route_evidence, [
      "jobs.metadata.report_delivery=own_document",
      "makesafe_job_details.report_delivery=portal",
    ]);
  },
);

Deno.test(
  "conflicting persisted roof modes fail closed before route selection",
  () => {
    const live = snapshot();
    live.detail!.report_type = null;
    live.job.metadata.makesafe_job_family = "roof_report";
    live.job.metadata.roof_report_mode = "builder_portal";
    live.detail!.roof_report_mode = "own_template";
    const input = buildSesAssemblerInput(live);
    assertEquals(input.classification.delivery_render_route, "unroutable");
    assertEquals(
      input.classification.delivery_render_route_reason_code,
      "conflicting_roof_delivery_facts",
    );
    assertEquals(input.classification.delivery_render_route_evidence, [
      "jobs.metadata.roof_report_mode=builder_portal",
      "makesafe_job_details.roof_report_mode=own_template",
    ]);
  },
);

Deno.test(
  "unsupported persisted report delivery fails closed with field evidence",
  () => {
    const live = snapshot();
    live.detail!.report_type = null;
    live.job.metadata.makesafe_job_family = "roof_report";
    live.job.metadata.report_delivery = "email";
    const input = buildSesAssemblerInput(live);
    assertEquals(input.classification.delivery_render_route, "unroutable");
    assertEquals(
      input.classification.delivery_render_route_reason_code,
      "delivery_route_unroutable",
    );
    assertEquals(input.classification.delivery_render_route_evidence, [
      "jobs.metadata.report_delivery=email",
    ]);
  },
);

Deno.test(
  "own-template roof preserves legacy portal-link role binding",
  () => {
    const live = snapshot();
    live.detail!.report_type = null;
    live.job.metadata.makesafe_job_family = "roof_report";
    live.detail!.external_links = [{
      kind: "photos",
      label: "Prime photos",
      url: "https://primeeco.tech/share/photos",
    }];
    const input = buildSesAssemblerInput(live);
    assertEquals(input.classification.family, "own_template_roof");
    assertEquals(input.source.portal_links, [{
      role: "photos",
      url: "https://primeeco.tech/share/photos",
      source: "job_detail",
    }]);
  },
);

Deno.test("SWMS-26980 seeded authority preserves the identity spine in U4", () => {
  const live = snapshot();
  live.identity_revision = {
    authority_kind: "legacy_job_record",
    source_instruction_id: "legacy-job:5383e3c4-eb32-41cf-8e3c-63a754c16d05",
    source_version: 1,
    source_content_hash: `sha256:${"a".repeat(64)}`,
    lineage_id: "5383e3c4-eb32-41cf-8e3c-63a754c16d05",
    effective_case_id: null,
  };
  const input = buildSesAssemblerInput(live);
  assertEquals(
    input.identity.source_instruction_id,
    live.identity_revision.source_instruction_id,
  );
  assertEquals(input.identity.source_version, "1");
  assertEquals(input.identity.lineage_id, live.identity_revision.lineage_id);
});

Deno.test(
  "real restoration card shape dry-runs to the typed unsealed-recipe blocker",
  async () => {
    const live = snapshot();
    live.job.id = "7dea664a-e0d7-4263-ab0c-bacea9e1d65d";
    live.job.job_number = "SWMS-26936";
    live.job.type = "insurance";
    live.job.status = "accepted";
    live.job.metadata = {
      ...live.job.metadata,
      insurance_job_type: "restoration",
      insurance_job_type_label: "Restoration Insurance Work",
      // The real converted card still carries this stale compatibility token.
      // Insurance restoration authority must win.
      makesafe_job_family: "general_makesafe",
      external_ref: "MLB-MW-26873",
    };
    live.detail!.job_id = live.job.id;
    live.detail!.external_ref = "MLB-MW-26873";
    live.detail!.substatus = "company_contact_required";
    live.detail!.report_type = null;
    live.identity_revision = {
      authority_kind: "legacy_job_record",
      source_instruction_id: `legacy-job:${live.job.id}`,
      source_version: 1,
      source_content_hash: `sha256:${"c".repeat(64)}`,
      lineage_id: live.job.id,
      effective_case_id: null,
    };
    live.cycles = [];
    live.reports = [];
    live.media = [];

    const client = liveSnapshotClient(live);
    const deps = createSesAssemblerRuntimeDependencies(client, {
      org_id: "org-test",
      created_by: "user-test",
    });
    const response = await prepare_ses_docket_revision(
      {
        selection: { mode: "job_number", job_number: "SWMS-26936" },
        idempotency_key: "restoration-real-card-proof-20260728",
        assembler_version: SES_ASSEMBLER_VERSION,
        dry_run: true,
        force_refresh: true,
      },
      deps,
    );
    const ownTemplateRoof = snapshot();
    ownTemplateRoof.detail!.report_type = null;
    ownTemplateRoof.detail!.external_links = [];
    ownTemplateRoof.job.metadata.makesafe_job_family = "roof_report";
    ownTemplateRoof.job.metadata.report_delivery = "own_document";
    assertEquals(
      buildSesAssemblerInput(ownTemplateRoof).classification.family,
      "own_template_roof",
    );
    const result = response.results[0];
    const codes = blockerCodes(result);
    assertEquals(result.state, "blocked");
    assert(codes.includes("restoration_recipe_unsealed"));
    assert(!codes.includes("family_unknown"));
    assertEquals(result.envelope.v2.classification.family, "restoration");
    assertEquals(result.envelope.v2.classification.job_type, "restoration");
    assertEquals(result.envelope.v2.classification.recipe_selected, false);
    assertEquals(
      result.blockers.find((blocker) =>
        blocker.reason_code === "restoration_recipe_unsealed"
      )?.facts?.job_number,
      "SWMS-26936",
    );
    assertEquals(result.invoice_proposal, null);
    assertEquals(result.email_drafts, {});
  },
);

Deno.test(
  "live adapter leaves an unmapped canonical family unknown without falling through to prose or legacy fields",
  () => {
    const live = snapshot();
    live.job.metadata.makesafe_job_family = "unsealed_new_family";
    live.job.metadata.job_family = "roof_report";
    live.detail!.report_type = "roof_report";
    const input = buildSesAssemblerInput(live);
    assertEquals(input.classification.family, "unknown");
  },
);

Deno.test(
  "live adapter ignores legacy family fields when the canonical family is absent",
  () => {
    const live = snapshot();
    live.job.metadata = { report_delivery: "own_document" };
    live.detail!.report_type = "roof_report";
    const input = buildSesAssemblerInput(live);
    assertEquals(input.classification.family, "unknown");
  },
);

Deno.test(
  "live adapter keeps canonical roof family ordinary unless typed own-template evidence is present",
  () => {
    const live = snapshot();
    live.job.metadata.makesafe_job_family = "roof_report";
    live.detail!.report_type = "assessment_report";
    live.detail!.report_delivery = "own_document";
    const input = buildSesAssemblerInput(live);
    assertEquals(input.classification.family, "own_template_roof");
  },
);

Deno.test(
  "live adapter leaves an unclassified non-AJS card explicitly unknown",
  () => {
    const live = snapshot();
    live.detail!.requesting_company_slug = "unsealed-builder";
    live.detail!.requesting_company_name = "Unsealed Builder";
    live.detail!.report_type = null;
    live.job.metadata = {};
    const input = buildSesAssemblerInput(live);
    assertEquals(input.classification.family, "unknown");
    assertEquals(input.source.builder_reference, "");
    assertEquals(input.source.deliverables, []);
  },
);

Deno.test(
  "four sanitized production assessment shapes conform to the sealed matrix and hash the corrected input",
  async () => {
    const shapes = [
      {
        jobNumber: "SWMS-26732",
        reportType: null,
        photoLinkKind: "photos",
      },
      {
        jobNumber: "SWMS-26740",
        reportType: "assessment_report",
        photoLinkKind: "photos",
      },
      {
        jobNumber: "SWMS-26748",
        reportType: "assessment_report",
        photoLinkKind: "photos",
      },
      {
        jobNumber: "SWMS-26791",
        reportType: "assessment_report",
        photoLinkKind: "photo_schedule",
      },
    ] as const;

    for (const shape of shapes) {
      const input = buildSesAssemblerInput(sanitizedAssessmentSnapshot(shape));
      assertEquals(input.classification.family, "assessment_quote");
      assertEquals(input.classification.report_only, true);
      assertEquals(input.classification.report_delivery, "portal");
      assertEquals(input.classification.subtype, null);
      assertEquals(
        input.classification.family_matrix_version,
        SES_FAMILY_MATRIX_VERSION,
      );
      assertEquals(
        input.source.portal_links.map((link) => link.role),
        ["assessment", "photos", "scope"],
      );
      assertEquals(
        input.classification.assessment_outbound_recipe_version,
        SES_ASSESSMENT_RECIPE_VERSION,
      );
      const expectedInputHash = await sesSha256(input);
      const response = await prepare_ses_docket_revision(
        {
          selection: { mode: "job_id", job_id: input.identity.job_id },
          idempotency_key: `assessment-sanitized-${shape.jobNumber}`,
          assembler_version: SES_ASSEMBLER_VERSION,
          dry_run: true,
          force_refresh: true,
        },
        {
          resolveInput: async () => input,
          resolveSourceArtifacts: async () => sourceResolver(input),
          now: () => new Date("2026-07-28T08:00:00.000Z"),
        },
      );
      const result = response.results[0];
      assertEquals(result.input_content_hash, expectedInputHash);
      assertEquals(result.envelope.input_content_hash, expectedInputHash);
      assertEquals(
        result.envelope.family_matrix_version,
        SES_FAMILY_MATRIX_VERSION,
      );
      assertEquals(
        blockerCodes(result),
        [
          "spine_missing_source",
          "spine_missing_lineage",
          "spine_missing_source",
          "spine_missing_deliverables",
          "capability_portal_degraded",
          "invoice_reference_missing",
        ],
        shape.jobNumber,
      );
    }
  },
);

Deno.test(
  "matrix-derived classification leaves roof, make-safe and restoration delivery fields unchanged",
  () => {
    for (
      const [signal, expected] of [
        [
          "general_makesafe",
          ["physical_makesafe", null, false, null],
        ],
        [
          "temp_fence_makesafe",
          ["temporary_fencing", "temporary_fencing", false, null],
        ],
        [
          "roof_report",
          ["ordinary_roof_portal", null, true, "portal"],
        ],
        [
          "restoration",
          ["restoration", null, false, null],
        ],
      ] as const
    ) {
      const live = snapshot();
      live.detail!.report_type = null;
      live.job.metadata.makesafe_job_family = signal;
      const classification = buildSesAssemblerInput(live).classification;
      assertEquals<string>(classification.family, expected[0], signal);
      assertEquals<string | null>(classification.subtype, expected[1], signal);
      assertEquals<boolean>(classification.report_only, expected[2], signal);
      assertEquals<string | null>(
        classification.report_delivery,
        expected[3],
        signal,
      );
    }
  },
);

Deno.test(
  "assessment hash evidence distinguishes stale versioning from content drift",
  async () => {
    assertEquals(
      SES_FAMILY_MATRIX_VERSION,
      "ses-builder-family-matrix/2026-07-28.4",
    );
    const shapes = [
      ["SWMS-26732", null, "photos"],
      ["SWMS-26740", "assessment_report", "photos"],
      ["SWMS-26748", "assessment_report", "photos"],
      ["SWMS-26791", "assessment_report", "photo_schedule"],
    ] as const;
    for (const [jobNumber, reportType, photoLinkKind] of shapes) {
      const corrected = buildSesAssemblerInput(
        sanitizedAssessmentSnapshot({ jobNumber, reportType, photoLinkKind }),
      );
      const preFix = structuredClone(corrected);
      preFix.classification.report_delivery = null;
      const deployedV3 = structuredClone(preFix);
      deployedV3.classification.family_matrix_version =
        "ses-builder-family-matrix/2026-07-27.3";

      assertEquals(
        changedPaths(deployedV3, preFix),
        ["classification.family_matrix_version"],
        jobNumber,
      );
      assertEquals(
        changedPaths(preFix, corrected),
        ["classification.report_delivery"],
        jobNumber,
      );
      const firstHash = await sesSha256(deployedV3);
      assertEquals(await sesSha256(deployedV3), firstHash, jobNumber);
      assert(firstHash !== await sesSha256(preFix), jobNumber);
      assert(await sesSha256(preFix) !== await sesSha256(corrected), jobNumber);
    }
  },
);
Deno.test("live adapter resolves only the exact synthetic-livefire company profile", () => {
  const exact = snapshot();
  exact.detail!.requesting_company_slug = "synthetic-livefire";
  exact.detail!.requesting_company_name =
    "SecureWorks Synthetic Live-Fire Builder";
  exact.detail!.makesafe_companies = {
    slug: "synthetic-livefire",
    name: "SecureWorks Synthetic Live-Fire Builder",
    report_recipient: "marnin@secureworkswa.com.au",
  };
  exact.job.metadata.job_family = "roof_report";
  assertEquals(
    buildSesAssemblerInput(exact).classification.builder_key,
    "SYNTHETIC",
  );

  const lookalike = snapshot();
  lookalike.detail!.requesting_company_slug = "synthetic-livefire-lookalike";
  lookalike.detail!.requesting_company_name = "synthetic-livefire";
  lookalike.detail!.external_ref = null;
  lookalike.detail!.makesafe_companies = {
    slug: "not-synthetic-livefire",
    name: "synthetic-livefire",
    report_recipient: "marnin@secureworkswa.com.au",
  };
  lookalike.job.metadata.requesting_company = {
    slug: "synthetic-livefire",
    name: "synthetic-livefire",
  };
  assertEquals(
    buildSesAssemblerInput(lookalike).classification.builder_key,
    "UNKNOWN",
  );
});
