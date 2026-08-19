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
  currentCuratedReportDocument,
  missingCaptureSignal,
  normalizeSesPrepareRequest,
  physicalReportRenderJob,
  selectPhysicalReportProofForCycle,
  SesAssemblerAdapterError,
  type SesAssemblerLiveSnapshot,
  summarizeSesPrepareResponseForHttp,
} from "./ses_assembler_input_adapter.ts";
import {
  canonicalSesJson,
  SES_ASSEMBLER_VERSION,
  SES_INPUT_CONTRACT_VERSION,
  sesSha256,
  sesSha256Bytes,
} from "./ses_docket_envelope.ts";
import { SES_FAMILY_MATRIX_VERSION } from "./ses_family_matrix.ts";
import {
  MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_SHA256,
  MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_VERSION,
  MAKESAFE_REPORT_AUTHORITATIVE_SOURCE_REVISION,
  MAKESAFE_REPORT_CONTRACT_VERSION,
  MAKESAFE_REPORT_RENDERER_VERSION,
  renderMakesafeReportPdf,
} from "./makesafe_report_render.ts";
import { buildSesSwmsGenerationPlan } from "./ses_swms_template.ts";
import { renderSesSwmsPdf, sesSwmsRenderHash } from "./ses_swms_render.ts";
import {
  prepare_ses_docket_revision,
  SES_ASSESSMENT_RECIPE_VERSION,
} from "./ses_prepare_docket_revision.ts";
import {
  rawSesPortalCaptureSha256,
  SES_PORTAL_CAPTURE_BUCKET,
  SES_PORTAL_CAPTURE_PRODUCER,
  type SesPortalCaptureRevisionContent,
  sesPortalCaptureRevisionHash,
} from "./ses_portal_capture_contract.ts";
import {
  PACK_PHOTO_ORDER_EXPECTED_IDS,
  PACK_PHOTO_ORDER_MEDIA,
} from "./ses_pack_photo_order_test_fixture.ts";

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

function executableSql(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
    .replace(/--[^\n]*/g, "");
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
          url: `https://portal.example.test/share/${suffix}/assessment`,
        },
        {
          kind: args.photoLinkKind,
          label: "Photos",
          source: "sanitized",
          url: `https://portal.example.test/share/${suffix}/photos`,
        },
        {
          kind: "quote",
          label: "Quote",
          source: "sanitized",
          url: `https://portal.example.test/share/${suffix}/quote`,
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

function liveSnapshotClient(
  live: SesAssemblerLiveSnapshot,
  storageObjects: Record<string, Uint8Array> = {},
) {
  const rows: Record<string, unknown> = {
    jobs: [live.job],
    makesafe_job_details: [live.detail],
    makesafe_state_identity_current_v2: live.identity_revision
      ? [live.identity_revision]
      : [],
    makesafe_intake_cases: live.cases,
    makesafe_attendance_cycles: live.cycles,
    job_service_reports: live.reports,
    job_assignments: live.assignments,
    job_media: live.media,
    job_documents: live.documents,
    makesafe_roof_report_drafts: live.roof_draft ? [live.roof_draft] : [],
    makesafe_readiness_current: live.readiness ? [live.readiness] : [],
    makesafe_portal_capture_revisions: live.portal_captures,
    makesafe_report_packs: live.legacy_packs,
    job_events: live.events || [],
    makesafe_sibling_bundle_binding_revisions: live.bundle_bindings || [],
    makesafe_sibling_evidence_claims: live.bundle_claims || [],
    xero_invoices: live.bundle_invoices || [],
    emails: live.bundle_emails || [],
  };
  return {
    storage: {
      from(bucket: string) {
        return {
          async download(path: string) {
            const bytes = bucket === SES_PORTAL_CAPTURE_BUCKET
              ? storageObjects[path]
              : undefined;
            if (!bytes) {
              return { data: null, error: { message: "not found" } };
            }
            const owned = new Uint8Array(bytes.byteLength);
            owned.set(bytes);
            return { data: new Blob([owned.buffer]), error: null };
          },
        };
      },
    },
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
        role: "roof_report",
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
  "assembler orders pack photos by created_at then id with nulls last",
  () => {
    const live = snapshot();
    live.job.metadata.makesafe_job_family = "general_makesafe";
    live.detail!.report_type = null;
    live.detail!.external_links = [];
    live.media = PACK_PHOTO_ORDER_MEDIA.map((row) => ({
      ...row,
      job_id: live.job.id,
      attendance_cycle_id: live.detail!.attendance_cycle_id,
      cycle_attribution: "bound",
    }));

    const photos = buildSesAssemblerInput(live).cycle_facts.photos;
    assertEquals(
      photos.map((photo) => photo.id),
      [...PACK_PHOTO_ORDER_EXPECTED_IDS],
    );
    assertEquals(
      photos.map((photo) => photo.order),
      PACK_PHOTO_ORDER_EXPECTED_IDS.map((_, index) => index + 1),
    );
    assertEquals(
      canonicalSesJson(photos.map((photo) => photo.id)) ===
        canonicalSesJson(
          PACK_PHOTO_ORDER_MEDIA.map((row) => row.id).toSorted(),
        ),
      false,
      "chronological order must not collapse to lexicographic photo ID order",
    );
  },
);

Deno.test(
  "an omitted materials_charge and a present null are different answers",
  () => {
    const base = {
      selection: { mode: "job_number", job_number: "SWMS-26980" },
      idempotency_key: "materials-charge-request-shape",
      dry_run: true,
    };
    const omitted = normalizeSesPrepareRequest({ ...base });
    assertEquals(Object.hasOwn(omitted, "materials_charge"), false);
    assertEquals(Object.hasOwn(omitted, "materials_charge_cleared"), false);

    const cleared = normalizeSesPrepareRequest({
      ...base,
      materials_charge: null,
    });
    assertEquals(cleared.materials_charge_cleared, {
      cleared_by: null,
      cleared_at: null,
      decision_key: null,
      reason: null,
    });
    assertEquals(Object.hasOwn(cleared, "materials_charge"), false);

    // An attributed zero is the same NONE decision, carrying who decided it.
    const attributedClear = normalizeSesPrepareRequest({
      ...base,
      materials_charge: {
        schema: "secureworks.makesafe.materials-charge-figure/v1",
        amount_ex_gst: 0,
        authorised_by: "captain@secureworksgroup.app",
        authorised_at: "2026-08-05T03:00:00.000Z",
        decision_key: "materials-none-2026-08-05",
        reason: "No materials charge on this card.",
      },
    });
    assertEquals(
      attributedClear.materials_charge_cleared?.cleared_by,
      "captain@secureworksgroup.app",
    );

    const charged = normalizeSesPrepareRequest({
      ...base,
      materials_charge: {
        schema: "secureworks.makesafe.materials-charge-figure/v1",
        amount_ex_gst: 65,
        authorised_by: "captain@secureworksgroup.app",
        authorised_at: "2026-08-05T02:00:00.000Z",
        decision_key: "materials-figure-2026-08-05",
        reason: "Operator commercial materials figure.",
      },
    });
    assertEquals(charged.materials_charge?.amount_ex_gst, 65);
    assertEquals(Object.hasOwn(charged, "materials_charge_cleared"), false);

    // A withdrawal names one card, exactly like the figure it withdraws.
    try {
      normalizeSesPrepareRequest({
        selection: { mode: "board_batch", limit: 5 },
        idempotency_key: "materials-charge-batch-clear",
        dry_run: true,
        materials_charge: null,
      });
      throw new Error("expected batch clear rejection");
    } catch (error) {
      assert(error instanceof SesAssemblerAdapterError);
      assertEquals(error.status, 400);
    }
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
    assertEquals(
      normalizeSesPrepareRequest({
        selection: { mode: "job_number", job_number: "SWMS-26980" },
        idempotency_key: "proof-swms-26980-sweep-guard",
        dry_run: false,
        require_ready_for_persistence: true,
      }).require_ready_for_persistence,
      true,
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

Deno.test("canonical intake case publishes builder reference without borrowing the board row", () => {
  const live = snapshot();
  live.detail!.external_ref = "BOARD-ROW-CANDIDATE";
  live.cases = [{
    id: "case-canonical-builder-reference",
    state: "confirmed_live_job",
    job_id: live.job.id,
    target_job_id: null,
    instruction_key: "builder:generic/po:one",
    lineage_id: "lineage-generic-one",
    source_content_hash: `sha256:${"f".repeat(64)}`,
    builder_wo_canonical: "BUILDER-CANONICAL-ONE",
    builder_po_canonical: "PO-CANONICAL-ONE",
    external_ref_canonical: "BUILDER-CANONICAL-ONE",
  }];
  live.identity_revision = null;

  const input = buildSesAssemblerInput(live);
  assertEquals(input.source.builder_reference, "BUILDER-CANONICAL-ONE");
  assertEquals(
    input.source.builder_reference === live.detail!.external_ref,
    false,
  );
});

Deno.test("effective intake authority cannot publish a builder reference from the board row alone", () => {
  const live = snapshot();
  live.detail!.external_ref = "BOARD-ROW-ONLY";
  live.cases = [];
  live.identity_revision = {
    authority_kind: "effective_intake_case",
    source_instruction_id: "instruction-authority-only",
    source_version: 1,
    source_content_hash: `sha256:${"e".repeat(64)}`,
    lineage_id: "lineage-authority-only",
    effective_case_id: "case-without-canonical-reference",
  };

  const input = buildSesAssemblerInput(live);
  assertEquals(input.source.builder_reference, "");
});

Deno.test(
  "SWMS-26980 production-shape dry-run is HTTP-envelope ready, write-free and review-visible",
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
    // Missing builder reference is identity_safety_hard (Captain 2026-08-19
    // identity fence): pack stays review-visible but blocked for Docs Ready.
    assertEquals(result.state, "blocked");
    assertEquals(result.envelope.pre_xero_docs_ready, false);
    assertEquals(result.persisted, false);
    assertEquals(persistCalls, 0);
    const codes = blockerCodes(result);
    assert(codes.includes("invoice_reference_missing"));
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
    live.bundle_jobs = [{
      id: siblingId,
      job_number: "SWMS-26837",
      client_name: "Sibling site contact",
    }];
    live.bundle_details = [{
      job_id: siblingId,
      attendance_cycle_id: "sibling-cycle-1",
      cycle_number: 1,
      reattend_count: 0,
    }];
    live.bundle_reports = [{
      id: "trade-report-26837",
      job_id: siblingId,
      status: "submitted",
      submitted_at: "2026-07-20T06:35:00.000Z",
      attendance_cycle_id: "sibling-cycle-1",
      cycle_attribution: "bound",
      checklist_json: {
        works_completed:
          "Stacked displaced Hardie panels safely and isolated the area.",
        arrival_time: "14:05",
      },
    }];
    live.bundle_assignments = [{
      id: "assignment-26837",
      job_id: siblingId,
      status: "complete",
      attendance_cycle_id: "sibling-cycle-1",
      cycle_attribution: "bound",
      crew_name: "Sibling field crew",
      scheduled_date: "2026-07-20",
      arrived_at: "2026-07-20T14:05:00.000Z",
    }];
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
      delivery_scope_phrase: "Temporary fencing installed",
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
    assertEquals(input.cycle_facts.swms_fact_context, {
      evidence_kind: "sibling_bundle",
      evidence_job_id: siblingId,
      evidence_job_number: "SWMS-26837",
      trade_report: {
        id: "trade-report-26837",
        status: "submitted",
        submitted_at: "2026-07-20T06:35:00.000Z",
        checklist_json: {
          works_completed:
            "Stacked displaced Hardie panels safely and isolated the area.",
          arrival_time: "14:05",
        },
        notes: null,
      },
      job_client_name: "Sibling site contact",
      assignment: {
        id: "assignment-26837",
        crew_name: "Sibling field crew",
        assigned_user_name: null,
        scheduled_date: "2026-07-20",
        arrived_at: "2026-07-20T14:05:00.000Z",
      },
    });

    const acceptedInvoiceDescription =
      live.bundle_invoices[0].line_items[0].Description;
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

    live.bundle_invoices[0].line_items[0].Description =
      acceptedInvoiceDescription;
    const beforeDeliveryDelta = structuredClone(live);
    live.bundle_emails[0].body_preview =
      "Photos show displaced Hardie panels stacked safely.";
    assertEquals(changedPaths(beforeDeliveryDelta, live), [
      "bundle_emails[0].body_preview",
    ]);
    const deliveryRejected = buildSesAssemblerInput(live);
    assertEquals(
      deliveryRejected.sibling_bundle_evidence?.status,
      "scope_evidence_missing",
    );
    if (
      deliveryRejected.sibling_bundle_evidence?.status !==
        "scope_evidence_missing"
    ) {
      throw new Error("expected delivery-scope blocker");
    }
    assertEquals(
      deliveryRejected.sibling_bundle_evidence.coverage_failures,
      ["delivery_scope_not_covered"],
    );
  },
);

Deno.test(
  "a reciprocal relationship without a directional claim emits a fail-closed blocker",
  () => {
    const live = snapshot();
    live.bundle_bindings = [{
      id: "forward-only-claimless",
      bundle_id: "bundle-1",
      org_id: "org-1",
      job_id: live.job.id,
      sibling_job_id: "sibling-job",
      state: "bound",
      recorded_by: "operator",
      recorded_via: "reviewed_migration",
      provenance: { reason: "reciprocal relationship only" },
      recorded_at: "2026-07-28T04:00:00Z",
    }, {
      id: "reverse-only-claimless",
      bundle_id: "bundle-1",
      org_id: "org-1",
      job_id: "sibling-job",
      sibling_job_id: live.job.id,
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
    const input = buildSesAssemblerInput(live);
    assertEquals(
      input.sibling_bundle_evidence?.status,
      "scope_evidence_missing",
    );
    if (input.sibling_bundle_evidence?.status !== "scope_evidence_missing") {
      throw new Error("expected a fail-closed sibling evidence blocker");
    }
    assert(
      input.sibling_bundle_evidence.coverage_failures.includes(
        "positive_scope_claim_missing",
      ),
    );
  },
);

type SeedGuardFixture = {
  jobs: string[];
  invoice: boolean;
  delivery: boolean;
  documents: Array<{ id: string; type: string }>;
  media: number;
};

function seedGuardOutcome(
  fixture: SeedGuardFixture,
): "skip" | "binding_only" | "seed_claim" {
  const hasFootprint = fixture.jobs.length > 0 || fixture.invoice ||
    fixture.delivery || fixture.documents.length > 0 || fixture.media > 0;
  if (!hasFootprint) return "skip";
  const bindingFootprintComplete = fixture.jobs.includes("claiming") &&
    fixture.jobs.includes("sibling") && fixture.invoice && fixture.delivery &&
    fixture.documents.some((document) =>
      document.id === "report" &&
      ["report", "makesafe_report"].includes(document.type.toLowerCase())
    ) &&
    fixture.documents.some((document) =>
      document.id === "swms" && document.type.toLowerCase() === "swms"
    );
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
    const executable = executableSql(migration);
    assert(
      /\bINSERT\s+INTO\s+public\.makesafe_sibling_bundle_binding_revisions\s*\([\s\S]*?\)\s*VALUES\s*\([\s\S]*?'c3afc061-0d4a-43ff-8309-0b8b512e307a'[\s\S]*?'02f614a4-09a7-422e-9381-c89a44aceccd'[\s\S]*?\);/i
        .test(executable),
      "the reviewed reciprocal binding must be an executable INSERT, not a comment or prose token",
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
      executable.indexOf(
        "IF NOT EXISTS (\n    SELECT 1\n    FROM public.jobs",
      ) <
        executable.indexOf(
          "INSERT INTO public.makesafe_sibling_bundle_binding_revisions",
        ),
    );
    assertStringIncludes(
      migration,
      "AND NOT EXISTS (\n    SELECT 1\n    FROM public.xero_invoices",
    );
    assertStringIncludes(migration, "AND invoice.org_id = claiming.org_id");
    assertStringIncludes(migration, "v_photo_match_count > 1");
    assertStringIncludes(migration, "IF v_photo_match_count = 0 THEN");
    assertEquals(
      migration.includes("expected exactly one reviewed photo artifact"),
      false,
    );
    assert(
      executable.indexOf(
        "INSERT INTO public.makesafe_sibling_bundle_binding_revisions",
      ) <
        executable.indexOf("IF v_photo_match_count = 0 THEN"),
    );
    assert(
      executable.indexOf("IF v_photo_match_count = 0 THEN") <
        executable.indexOf(
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
      documents: [],
      media: 0,
    }),
    "skip",
  );
  assertEquals(
    seedGuardOutcome({
      jobs: ["claiming", "sibling"],
      invoice: true,
      delivery: true,
      documents: [
        { id: "report", type: "makesafe_report" },
        { id: "swms", type: "swms" },
      ],
      media: 0,
    }),
    "binding_only",
  );
  assertEquals(
    seedGuardOutcome({
      jobs: ["claiming", "sibling"],
      invoice: true,
      delivery: true,
      documents: [
        { id: "report", type: "makesafe_report" },
        { id: "swms", type: "swms" },
      ],
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
        documents: [
          { id: "report", type: "makesafe_report" },
          { id: "swms", type: "swms" },
        ],
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
        documents: [
          { id: "report", type: "makesafe_report" },
          { id: "swms", type: "swms" },
        ],
        media: 1,
      }),
    Error,
    "partial or drifted production footprint",
  );
  for (
    const documents of [
      [{ id: "report", type: "swms" }, { id: "swms", type: "swms" }],
      [{ id: "report", type: "makesafe_report" }, {
        id: "swms",
        type: "report",
      }],
    ]
  ) {
    assertThrows(
      () =>
        seedGuardOutcome({
          jobs: ["claiming", "sibling"],
          invoice: true,
          delivery: true,
          documents,
          media: 0,
        }),
      Error,
      "partial or drifted production footprint",
    );
  }
});

Deno.test(
  "one genuine roof share plus four historical image assets binds only the share and leaves capture missing",
  async () => {
    const live = roofPortalSnapshot();
    live.detail!.external_links.push(
      {
        kind: "builder_portal",
        label: "Builder portal",
        url: "https://documents.primeeco.tech/assets/builder-logo.png",
      },
      {
        kind: "builder_portal",
        label: "Builder portal",
        url: "https://cdn.example.test/assets/company-brand.jpg",
      },
      {
        kind: "builder_portal",
        label: "Builder portal",
        url: "https://documents.primeeco.tech/assets/signature-one.png",
      },
      {
        kind: "builder_portal",
        label: "Builder portal",
        url: "https://documents.primeeco.tech/assets/signature-two.png",
      },
    );
    const input = buildSesAssemblerInput(live);
    assertEquals(input.source.portal_links, [{
      role: "roof_report",
      url: "https://primeeco.tech/share/d2ff4956-1302-4ef8-a49e-c9d29061ef4b",
      source: "job_detail",
    }]);
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
  "ordinary roof candidates preserve explicit roles independent of array order",
  () => {
    const rawLinks = [
      {
        kind: "assessment_report",
        label: "Assessment report",
        url: "https://primeeco.tech/share/assessment-candidate",
      },
      {
        kind: "photos",
        label: "Photos",
        url: "https://primeeco.tech/share/photos-candidate",
      },
      {
        kind: "quote",
        label: "Quote",
        url: "https://primeeco.tech/share/quote-candidate",
      },
      {
        kind: "roof_report",
        label: "Roof report",
        url: "https://primeeco.tech/share/roof-candidate",
      },
    ];
    for (const links of [rawLinks, rawLinks.slice().reverse()]) {
      const live = roofPortalSnapshot();
      live.detail!.external_links = links;
      const input = buildSesAssemblerInput(live);
      assertEquals(
        input.source.portal_links.map((link) => [link.role, link.url]).sort(),
        [
          [
            "assessment",
            "https://primeeco.tech/share/assessment-candidate",
          ],
          ["photos", "https://primeeco.tech/share/photos-candidate"],
          ["roof_report", "https://primeeco.tech/share/roof-candidate"],
          ["scope", "https://primeeco.tech/share/quote-candidate"],
        ],
      );
      assertEquals(
        input.source.portal_links.filter((link) => link.role === "roof_report")
          .length,
        1,
      );
    }
  },
);

Deno.test(
  "ordinary roof generic portal fallback remains available only without an explicit roof role",
  () => {
    const live = roofPortalSnapshot();
    live.detail!.external_links = [
      {
        kind: "builder_portal",
        label: "Builder portal",
        url: "https://primeeco.tech/share/generic-roof-candidate",
      },
      {
        kind: "photos",
        label: "Photos",
        url: "https://primeeco.tech/share/photos-candidate",
      },
    ];
    assertEquals(buildSesAssemblerInput(live).source.portal_links, [
      {
        role: "roof_report",
        url: "https://primeeco.tech/share/generic-roof-candidate",
        source: "job_detail",
      },
      {
        role: "photos",
        url: "https://primeeco.tech/share/photos-candidate",
        source: "job_detail",
      },
    ]);

    live.detail!.external_links.push({
      kind: "roof_report",
      label: "Roof report",
      url: "https://primeeco.tech/share/typed-roof-candidate",
    });
    assertEquals(
      buildSesAssemblerInput(live).source.portal_links.map((link) => link.role),
      ["builder_portal", "photos", "roof_report"],
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
    assert(!codes.includes("portal_capture_missing"), codes.join(","));
    assert(!codes.includes("portal_capture_invalid"), codes.join(","));
    assert(!codes.includes("capability_portal_degraded"), codes.join(","));
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

    const captureRequest = {
      job_id: live.job.id,
      docket_id: "docket-hash-cycle-controls",
      builder_reference: input.source.builder_reference,
      role: "roof_report" as const,
      url: sourceUrl,
      idempotency_key: "capture-hash-cycle-controls",
    };
    const hashMismatchLive = structuredClone(live);
    hashMismatchLive.portal_captures[0].makesafe_content_hash = `sha256:${
      "c".repeat(64)
    }`;
    assertEquals(
      changedPaths(
        live.portal_captures[0],
        hashMismatchLive.portal_captures[0],
      ),
      ["makesafe_content_hash"],
    );
    const hashMismatchDependencies = createSesAssemblerRuntimeDependencies(
      liveSnapshotClient(hashMismatchLive, {
        [storagePath]: screenshotBytes,
      }),
      { org_id: live.job.org_id, created_by: "u4-regression" },
    );
    assert(hashMismatchDependencies.capturePortal);
    await hashMismatchDependencies.resolveInput({
      mode: "job_id",
      job_id: live.job.id,
    });
    const hashMismatch = await hashMismatchDependencies.capturePortal(
      captureRequest,
    );
    assertEquals(hashMismatch.status, "invalid");
    assertStringIncludes(
      hashMismatch.signal,
      "failed its aggregate content-hash check",
    );

    const staleCycleLive = structuredClone(live);
    const staleCycleContent: SesPortalCaptureRevisionContent = {
      ...content,
      attendance_cycle_id: "stale-cycle",
    };
    staleCycleLive.portal_captures[0].attendance_cycle_id =
      staleCycleContent.attendance_cycle_id;
    staleCycleLive.portal_captures[0].makesafe_content_hash =
      await sesPortalCaptureRevisionHash(staleCycleContent);
    assertEquals(
      changedPaths(live.portal_captures[0], staleCycleLive.portal_captures[0]),
      ["attendance_cycle_id", "makesafe_content_hash"],
    );
    const staleCycleDependencies = createSesAssemblerRuntimeDependencies(
      liveSnapshotClient(staleCycleLive, { [storagePath]: screenshotBytes }),
      { org_id: live.job.org_id, created_by: "u4-regression" },
    );
    assert(staleCycleDependencies.capturePortal);
    await staleCycleDependencies.resolveInput({
      mode: "job_id",
      job_id: live.job.id,
    });
    const staleCycle = await staleCycleDependencies.capturePortal(
      captureRequest,
    );
    assertEquals(staleCycle.status, "missing");
    assertStringIncludes(staleCycle.signal, "attendance_cycle_id=");
  },
);

Deno.test(
  "a newer trade attestation never shadows the reader capture U4 needs",
  async () => {
    // The trade tick (captain, 2026-08-02) is a second producer on the SAME
    // ledger and carries no screenshot, so it cannot supply the docket's
    // EVIDENCE artifact. It is excluded at the CANDIDATE step: were it merely
    // rejected at validation, a newer attestation would out-rank a perfectly
    // good reader capture by fact version and turn a valid docket invalid.
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
    const readerContent: SesPortalCaptureRevisionContent = {
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
    live.portal_captures = [
      {
        id: "b1b1b1b1-0000-4000-8000-000000000002",
        org_id: live.job.org_id,
        job_id: live.job.id,
        attendance_cycle_id: live.detail!.attendance_cycle_id,
        role: "roof_report",
        capture_result: "done",
        source_url: sourceUrl,
        source_content_hash: `sha256:${"e".repeat(64)}`,
        builder_reference: input.source.builder_reference,
        captured_at: "2026-08-02T04:00:00.000Z",
        captured_by: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        capture_producer: "trade_portal_confirmation/v1",
        capture_idempotency_key: "trade-portal-confirmation:v1:cycle",
        signal: "Trade confirmed the builder roof report is complete.",
        screenshot_object_key: null,
        screenshot_media_type: null,
        screenshot_content_hash: null,
        screenshot_size_bytes: null,
        status: "verified",
        // Deliberately NEWER than the reader capture below.
        makesafe_fact_version: 2,
        makesafe_content_hash: `sha256:${"f".repeat(64)}`,
        evidence_refs: [],
        created_at: "2026-08-02T04:00:01.000Z",
        created_by: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      },
      {
        id: "b1b1b1b1-0000-4000-8000-000000000001",
        org_id: live.job.org_id,
        ...readerContent,
        status: "verified",
        makesafe_fact_version: 1,
        makesafe_content_hash: await sesPortalCaptureRevisionHash(
          readerContent,
        ),
        evidence_refs: [],
        created_at: "2026-07-28T07:56:00.000Z",
        created_by: "ops-api:api_key",
      },
    ];
    const dependencies = createSesAssemblerRuntimeDependencies(
      liveSnapshotClient(live, { [storagePath]: screenshotBytes }),
      { org_id: live.job.org_id, created_by: "u4-regression" },
    );
    const response = await prepare_ses_docket_revision(
      {
        selection: { mode: "job_id", job_id: live.job.id },
        idempotency_key: "swms-261019-attestation-does-not-shadow",
        assembler_version: SES_ASSEMBLER_VERSION,
        dry_run: true,
        force_refresh: true,
      },
      {
        ...dependencies,
        resolveSourceArtifacts: async () => sourceResolver(input),
        now: () => new Date("2026-08-02T08:00:00.000Z"),
      },
    );

    const result = response.results[0];
    const codes = blockerCodes(result);
    assert(!codes.includes("portal_capture_invalid"), codes.join(","));
    assert(!codes.includes("portal_capture_missing"), codes.join(","));
    const evidence = result.artifacts.find((artifact) =>
      artifact.path === "EVIDENCE/portal_roof_report.json"
    );
    assert(evidence);
    const persisted = JSON.parse(new TextDecoder().decode(evidence.bytes));
    assertEquals(persisted.capture_producer, SES_PORTAL_CAPTURE_PRODUCER);
    assertEquals(persisted.evidence_revision_id, live.portal_captures[1].id);
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
    assert(codes.includes("portal_capture_invalid"), codes.join(","));
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
  "raw trade checklist fields cannot become a served report payload",
  () => {
    const live = snapshot();
    live.job.client_name = "Privacy-safe client";
    live.job.site_address = "Privacy-safe test property";
    live.job.site_suburb = "Test suburb";
    live.job.metadata.makesafe_job_family = "general_makesafe";
    live.detail!.report_type = null;
    live.detail!.external_links = [];
    live.reports[0].submitted_at = "2026-07-22T04:00:00.000Z";
    live.reports[0].notes = "Raw submitted narrative";
    live.assignments[0].crew_name = "Named field crew";
    live.assignments[0].scheduled_date = "2026-07-20";
    live.assignments[0].arrived_at = "2026-07-20T14:09:00.000Z";
    live.reports[0].checklist_json = {
      arrival_time: "2026-07-20 14:09",
      damage_description: "RAW DAMAGE DESCRIPTION MUST NOT LEAK",
      damage_cause: "RAW DAMAGE CAUSE MUST NOT LEAK",
      work_done: "RAW WORK DONE MUST NOT LEAK",
      materials: [],
      materials_used: ["RAW CHECKBOX MATERIAL MUST NOT LEAK"],
      labour_hours: 2,
      trade_count: 2,
      access_issues: "RAW ACCESS NOTE MUST NOT LEAK",
      follow_up_required: true,
      invoice_notes: "RAW INVOICE NOTE MUST NOT LEAK",
    };

    const input = buildSesAssemblerInput(live);
    assertEquals(input.cycle_facts.hours_and_materials, {
      trades: 2,
      hours_per_trade: 2,
      // materials_used is surfaced for the invoice materials-charge guard so a
      // labour-only proposal cannot silently drop trade-recorded materials.
      // MLB physical prices on standard_labour_materials, which is the only
      // basis that consumes it.
      materials_used: ["RAW CHECKBOX MATERIAL MUST NOT LEAK"],
    });
    assertEquals(input.cycle_facts.swms_fact_context, {
      evidence_kind: "current_card",
      evidence_job_id: live.job.id,
      evidence_job_number: live.job.job_number,
      trade_report: null,
      job_client_name: "Privacy-safe client",
      assignment: {
        id: live.assignments[0].id,
        crew_name: "Named field crew",
        assigned_user_name: null,
        scheduled_date: "2026-07-20",
        arrived_at: "2026-07-20T14:09:00.000Z",
      },
    });
    assertThrows(
      () => physicalReportRenderJob(live, input),
      SesAssemblerAdapterError,
      "Raw trade-report fields are immutable evidence",
    );
    assertEquals(
      Object.hasOwn(input.cycle_facts.hours_and_materials || {}, "materials"),
      false,
    );
  },
);

Deno.test(
  "Bertram trade evidence publishes only the existing-fence star-picket money fact",
  () => {
    const live = snapshot();
    live.job.id = "208450c0-7161-4b30-9514-66226b054609";
    live.job.job_number = "SWMS-261109";
    live.job.metadata.makesafe_job_family = "general_makesafe";
    live.detail!.job_id = live.job.id;
    live.detail!.requesting_company_slug = "aj";
    live.detail!.requesting_company_name = "AJ Building & Restoration";
    live.detail!.external_ref = "AJBR-70271";
    live.detail!.report_type = null;
    live.detail!.external_links = [];
    live.reports[0].job_id = live.job.id;
    live.reports[0].checklist_json = {
      job_type: "Temporary fencing",
      work_done:
        "Propped up hardy fence using 20 star pickets to secure upright until fence replaced.",
      labour_hours: 3,
      trade_count: 2,
      materials_used: [
        "Star pickets x 20",
        "Bases / feet",
        "Tarps / roof materials",
        "Fixings / consumables",
        "Other / none",
      ],
    };
    live.documents.push({
      id: "bertram-curated-report",
      job_id: live.job.id,
      type: "makesafe_report",
      visible_to_trades: true,
      attendance_cycle_id: live.detail!.attendance_cycle_id,
      cycle_attribution: "bound",
      version: 1,
      data_snapshot_json: {
        report_contract_version: MAKESAFE_REPORT_CONTRACT_VERSION,
        report_renderer_version: MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_VERSION,
        report_renderer_source_revision:
          MAKESAFE_REPORT_AUTHORITATIVE_SOURCE_REVISION,
        report_renderer_script_sha256:
          MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_SHA256,
        report_render_hash: "e".repeat(64),
        evidence_source: "current_cycle_curated_makesafe_report",
        curated_source_kind: "durable_curated_revision",
        curated_source_identity:
          "curation-revision:curation-fixture/artifact:artifact-fixture",
        curated_source_revision_id: "curation-fixture",
        curated_source_artifact_id: "artifact-fixture",
        curated_source_artifact_content_hash: `sha256:${"d".repeat(64)}`,
        curated_source_expected_raw_sha256: `sha256:${"e".repeat(64)}`,
        report_input_hash: `sha256:${"f".repeat(64)}`,
        report_scope_narratives: [
          "20 star pickets installed to prop and secure the existing fence line. Fence materials left in place on site pending permanent repair.",
        ],
      },
    });
    live.docket_revisions = [{
      id: "bertram-docket-revision",
      current_attendance_cycle_id: live.detail!.attendance_cycle_id,
      committed_at: "2026-08-01T00:00:00.000Z",
    }];
    live.docket_artifacts = [{
      id: "bertram-report-artifact",
      revision_id: "bertram-docket-revision",
      role: "supporting_report_pdf",
      media_type: "application/pdf",
      object_key: "makesafe-docket-artifacts/privacy-safe-fixture.pdf",
      content_hash: `sha256:${"d".repeat(64)}`,
      size_bytes: 100,
      metadata: {
        report_document_id: "bertram-curated-report",
        render_hash: "e".repeat(64),
      },
    }];

    const input = buildSesAssemblerInput(live);
    assertEquals(input.classification.builder_key, "AJBR");
    assertEquals(input.classification.family, "physical_makesafe");
    // AJS/AJBR price on ajs_labour_materials, which has no materials-charge
    // guard, so materials_used is deliberately NOT surfaced here: adding it
    // would re-key every AJS docket revision and drop its Docs Ready signoff
    // for no pricing effect.
    assertEquals(input.cycle_facts.hours_and_materials, {
      trades: 2,
      hours_per_trade: 3,
      existing_fence_star_picket_count: 20,
      existing_fence_star_picket_evidence: {
        source: "job_service_reports.checklist_json.materials_used",
        report_id: live.reports[0].id,
      },
    });
    assertEquals(
      Object.hasOwn(input.cycle_facts.hours_and_materials || {}, "materials"),
      false,
    );
  },
);

// Repair and restoration assemble on the same AJS labour/materials pack path, so
// the picket carve-out must reach them. A family-narrow evidence gate would drop
// the material line with no blocker, which is silent under-billing.
Deno.test(
  "AJS repair and restoration publish the existing-fence picket fact like any physical card",
  () => {
    for (const family of ["repair", "restoration"] as const) {
      const live = snapshot();
      live.job.metadata.makesafe_job_family = family;
      live.detail!.requesting_company_slug = "aj";
      live.detail!.requesting_company_name = "AJ Building & Restoration";
      live.detail!.report_type = null;
      live.detail!.external_links = [];
      live.reports[0].checklist_json = {
        work_done:
          "Propped up the existing hardy fence until it can be replaced.",
        labour_hours: 3,
        trade_count: 2,
        materials_used: ["Star pickets x 20"],
      };
      live.documents.push({
        id: `${family}-curated-report`,
        job_id: live.job.id,
        type: "makesafe_report",
        visible_to_trades: true,
        attendance_cycle_id: live.detail!.attendance_cycle_id,
        cycle_attribution: "bound",
        version: 1,
        data_snapshot_json: {
          report_contract_version: MAKESAFE_REPORT_CONTRACT_VERSION,
          report_renderer_version:
            MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_VERSION,
          report_renderer_source_revision:
            MAKESAFE_REPORT_AUTHORITATIVE_SOURCE_REVISION,
          report_renderer_script_sha256:
            MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_SHA256,
          report_render_hash: "e".repeat(64),
          evidence_source: "current_cycle_curated_makesafe_report",
          curated_source_kind: "durable_curated_revision",
          curated_source_identity:
            "curation-revision:curation-fixture/artifact:artifact-fixture",
          curated_source_revision_id: "curation-fixture",
          curated_source_artifact_id: "artifact-fixture",
          curated_source_artifact_content_hash: `sha256:${"d".repeat(64)}`,
          curated_source_expected_raw_sha256: `sha256:${"e".repeat(64)}`,
          report_input_hash: `sha256:${"f".repeat(64)}`,
          report_scope_narratives: [
            "20 star pickets installed to prop and secure the existing fence line pending permanent repair.",
          ],
        },
      });
      live.docket_revisions = [{
        id: `${family}-docket-revision`,
        current_attendance_cycle_id: live.detail!.attendance_cycle_id,
        committed_at: "2026-08-01T00:00:00.000Z",
      }];
      live.docket_artifacts = [{
        id: `${family}-report-artifact`,
        revision_id: `${family}-docket-revision`,
        role: "supporting_report_pdf",
        media_type: "application/pdf",
        object_key: "makesafe-docket-artifacts/privacy-safe-fixture.pdf",
        content_hash: `sha256:${"d".repeat(64)}`,
        size_bytes: 100,
        metadata: {
          report_document_id: `${family}-curated-report`,
          render_hash: "e".repeat(64),
        },
      }];

      const input = buildSesAssemblerInput(live);
      assertEquals(input.classification.family, family);
      assertEquals(input.classification.builder_key, "AJS");
      const facts = input.cycle_facts.hours_and_materials!;
      assertEquals(facts.existing_fence_star_picket_count, 20, family);
      assertEquals(facts.existing_fence_star_picket_refusal, undefined, family);
    }
  },
);

Deno.test(
  "AJS repair keeps the temporary-fence-kit picket refusal",
  () => {
    const live = snapshot();
    live.job.metadata.makesafe_job_family = "repair";
    live.detail!.requesting_company_slug = "aj";
    live.detail!.requesting_company_name = "AJ Building & Restoration";
    live.detail!.report_type = null;
    live.detail!.external_links = [];
    live.reports[0].checklist_json = {
      work_done:
        "Used star pickets to support an existing boundary fence pending replacement.",
      labour_hours: 3,
      trade_count: 2,
      materials_used: [
        "Star pickets x 20",
        "Temporary fence panels x 4",
        "Bases x 4",
      ],
    };

    const facts = buildSesAssemblerInput(live).cycle_facts.hours_and_materials!;
    assertEquals(facts.existing_fence_star_picket_count, undefined);
    assertEquals(
      facts.existing_fence_star_picket_refusal,
      "genuine_temporary_fence_signal",
    );
  },
);

Deno.test(
  "an evidenced temporary-fence kit cannot launder AJS pickets through the physical family",
  () => {
    const live = snapshot();
    live.job.metadata.makesafe_job_family = "general_makesafe";
    live.detail!.requesting_company_slug = "aj";
    live.detail!.requesting_company_name = "AJ Building & Restoration";
    live.detail!.report_type = null;
    live.detail!.external_links = [];
    live.reports[0].checklist_json = {
      work_done:
        "Used star pickets to support an existing boundary fence pending replacement.",
      labour_hours: 3,
      trade_count: 2,
      materials_used: [
        "Star pickets x 20",
        "Temporary fence panels x 4",
        "Bases x 4",
      ],
    };

    const facts = buildSesAssemblerInput(live).cycle_facts.hours_and_materials!;
    assertEquals(facts.existing_fence_star_picket_count, undefined);
    assertEquals(
      facts.existing_fence_star_picket_refusal,
      "genuine_temporary_fence_signal",
    );
  },
);

Deno.test(
  "raw checklist fence prose cannot support the existing-fence picket carve-out",
  () => {
    const live = snapshot();
    live.job.metadata.makesafe_job_family = "general_makesafe";
    live.detail!.requesting_company_slug = "aj";
    live.detail!.requesting_company_name = "AJ Building & Restoration";
    live.detail!.report_type = null;
    live.detail!.external_links = [];
    live.documents = live.documents.filter((row) =>
      String(row.type || "").toLowerCase() !== "makesafe_report"
    );
    live.reports[0].checklist_json = {
      work_done: "Used 20 star pickets to secure the existing fence line.",
      materials_used: ["Star pickets x 20"],
    };

    const facts = buildSesAssemblerInput(live).cycle_facts
      .hours_and_materials!;
    assertEquals(facts.existing_fence_star_picket_count, undefined);
    assertEquals(
      facts.existing_fence_star_picket_refusal,
      "existing_fence_scope_missing",
    );
  },
);

Deno.test(
  "structured panel and base counts defeat the physical-family picket carve-out",
  () => {
    const live = snapshot();
    live.job.metadata.makesafe_job_family = "general_makesafe";
    live.detail!.requesting_company_slug = "aj";
    live.detail!.requesting_company_name = "AJ Building & Restoration";
    live.detail!.report_type = null;
    live.detail!.external_links = [];
    live.reports[0].checklist_json = {
      work_done:
        "Used star pickets to support an existing boundary fence pending replacement.",
      labour_hours: 3,
      trade_count: 2,
      panel_count: 4,
      base_count: 4,
      materials_used: ["Star pickets x 20"],
    };

    const facts = buildSesAssemblerInput(live).cycle_facts
      .hours_and_materials!;
    assertEquals(facts.existing_fence_star_picket_count, undefined);
    assertEquals(
      facts.existing_fence_star_picket_refusal,
      "genuine_temporary_fence_signal",
    );
  },
);

Deno.test(
  "curated report selection requires committed same-cycle bytes and rejects self-attested sweep provenance",
  () => {
    const live = snapshot();
    const input = buildSesAssemblerInput(live);
    const cycleId = input.attendance.current_attendance_cycle_id;
    live.documents = [{
      id: "committed-report",
      type: "makesafe_report",
      visible_to_trades: true,
      file_name: "committed.pdf",
      attendance_cycle_id: cycleId,
      cycle_attribution: "bound",
      data_snapshot_json: {
        report_contract_version: MAKESAFE_REPORT_CONTRACT_VERSION,
        report_renderer_version: MAKESAFE_REPORT_RENDERER_VERSION,
        report_render_hash: "a".repeat(64),
      },
    }, {
      id: "guarded-sweep-report",
      type: "makesafe_report",
      visible_to_trades: true,
      uploaded_by: "guarded-current-wiki-rerender-sweep",
      file_name: "guarded.pdf",
      attendance_cycle_id: cycleId,
      cycle_attribution: "bound",
      data_snapshot_json: {
        evidence_source: "current_cycle_curated_makesafe_report",
        source_document_id: "guarded-sweep-report",
        report_contract_version: MAKESAFE_REPORT_CONTRACT_VERSION,
        report_renderer_version: MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_VERSION,
        report_render_hash: "b".repeat(64),
        report_scope_narratives: [
          "Temporary fence panels were installed as a privacy-safe false-claim fixture.",
        ],
      },
    }];
    assertEquals(currentCuratedReportDocument(live, input), null);

    live.docket_revisions = [{
      id: "revision-committed",
      current_attendance_cycle_id: cycleId,
      committed_at: "2026-08-01T00:00:00.000Z",
    }, {
      id: "revision-sweep",
      current_attendance_cycle_id: cycleId,
      committed_at: "2026-08-02T00:00:00.000Z",
    }];
    live.docket_artifacts = [{
      id: "artifact-committed",
      revision_id: "revision-committed",
      role: "supporting_report_pdf",
      media_type: "application/pdf",
      object_key: "makesafe-docket-artifacts/committed.pdf",
      content_hash: `sha256:${"c".repeat(64)}`,
      size_bytes: 100,
      metadata: {
        report_document_id: "committed-report",
        source_kind: "previously_committed_pdf",
        source_identity:
          "docket-revision:trusted-source-revision/artifact:trusted-source-artifact",
        source_document_id: "committed-report",
        source_revision_id: "trusted-source-revision",
        source_artifact_id: "trusted-source-artifact",
        source_artifact_content_hash: `sha256:${"c".repeat(64)}`,
        expected_raw_sha256: `sha256:${"a".repeat(64)}`,
        output_sha256: `sha256:${"a".repeat(64)}`,
        render_hash: "a".repeat(64),
        report_input_hash: `sha256:${"a".repeat(64)}`,
        evidence_source: "current_cycle_curated_makesafe_report",
        report_contract_version: MAKESAFE_REPORT_CONTRACT_VERSION,
      },
    }, {
      id: "artifact-sweep",
      revision_id: "revision-sweep",
      role: "supporting_report_pdf",
      media_type: "application/pdf",
      object_key: "makesafe-docket-artifacts/guarded.pdf",
      content_hash: `sha256:${"d".repeat(64)}`,
      size_bytes: 100,
      metadata: {
        report_document_id: "guarded-sweep-report",
        source_kind: "durable_curated_revision",
        source_identity: "guarded-sweep-report",
        source_document_id: "guarded-sweep-report",
        source_revision_id: "raw-source-revision",
        source_artifact_id: "raw-source-artifact",
        source_artifact_content_hash: `sha256:${"d".repeat(64)}`,
        expected_raw_sha256: `sha256:${"b".repeat(64)}`,
        output_sha256: `sha256:${"b".repeat(64)}`,
        render_hash: "b".repeat(64),
        evidence_source: "current_cycle_curated_makesafe_report",
        report_contract_version: MAKESAFE_REPORT_CONTRACT_VERSION,
      },
    }];
    assertEquals(
      currentCuratedReportDocument(live, input)?.id,
      "committed-report",
    );
    assertEquals(
      selectPhysicalReportProofForCycle(live, cycleId),
      {
        source_kind: "previously_committed_pdf",
        source_identity:
          "docket-revision:revision-committed/artifact:artifact-committed",
        source_document_id: "committed-report",
        source_revision_id: "revision-committed",
        source_artifact_id: "artifact-committed",
        source_artifact_content_hash: `sha256:${"c".repeat(64)}`,
        expected_raw_sha256: `sha256:${"a".repeat(64)}`,
        report_input_hash: `sha256:${"a".repeat(64)}`,
      },
    );

    // Tuart-style: previously_committed shape without independent completeness
    // proof must not select. Being restorable is not being complete.
    live.docket_artifacts = [{
      id: "artifact-tuart-incomplete",
      revision_id: "revision-committed",
      role: "supporting_report_pdf",
      media_type: "application/pdf",
      object_key: "makesafe-docket-artifacts/tuart.pdf",
      content_hash: `sha256:${"c".repeat(64)}`,
      size_bytes: 100,
      metadata: {
        report_document_id: "committed-report",
        source_kind: "previously_committed_pdf",
        source_identity:
          "docket-revision:trusted-source-revision/artifact:trusted-source-artifact",
        source_document_id: "committed-report",
        source_revision_id: "trusted-source-revision",
        source_artifact_id: "trusted-source-artifact",
        source_artifact_content_hash: `sha256:${"c".repeat(64)}`,
        expected_raw_sha256: `sha256:${"a".repeat(64)}`,
        output_sha256: `sha256:${"a".repeat(64)}`,
        render_hash: "a".repeat(64),
        evidence_source: "current_cycle_curated_makesafe_report",
        report_contract_version: MAKESAFE_REPORT_CONTRACT_VERSION,
      },
    }];
    assertEquals(selectPhysicalReportProofForCycle(live, cycleId), null);

    live.docket_artifacts = [{
      id: "artifact-sweep",
      revision_id: "revision-sweep",
      role: "supporting_report_pdf",
      media_type: "application/pdf",
      object_key: "makesafe-docket-artifacts/guarded.pdf",
      content_hash: `sha256:${"d".repeat(64)}`,
      size_bytes: 100,
      metadata: {
        report_document_id: "guarded-sweep-report",
        source_kind: "durable_curated_revision",
        source_identity: "guarded-sweep-report",
        source_document_id: "guarded-sweep-report",
        source_revision_id: "raw-source-revision",
        source_artifact_id: "raw-source-artifact",
        source_artifact_content_hash: `sha256:${"d".repeat(64)}`,
        expected_raw_sha256: `sha256:${"b".repeat(64)}`,
        output_sha256: `sha256:${"b".repeat(64)}`,
        render_hash: "b".repeat(64),
        evidence_source: "current_cycle_curated_makesafe_report",
        report_contract_version: MAKESAFE_REPORT_CONTRACT_VERSION,
      },
    }];
    assertEquals(selectPhysicalReportProofForCycle(live, cycleId), null);
  },
);

Deno.test(
  "completeness coordinate is refused unless the document's own raw hash names these artifact bytes",
  () => {
    const live = snapshot();
    const input = buildSesAssemblerInput(live);
    const cycleId = input.attendance.current_attendance_cycle_id;
    live.documents = [{
      id: "committed-report",
      type: "makesafe_report",
      visible_to_trades: true,
      file_name: "committed.pdf",
      attendance_cycle_id: cycleId,
      cycle_attribution: "bound",
      data_snapshot_json: {
        report_contract_version: MAKESAFE_REPORT_CONTRACT_VERSION,
        report_renderer_version: MAKESAFE_REPORT_RENDERER_VERSION,
        report_render_hash: "a".repeat(64),
        report_input_hash: `sha256:${"e".repeat(64)}`,
      },
    }];
    live.docket_revisions = [{
      id: "revision-committed",
      current_attendance_cycle_id: cycleId,
      committed_at: "2026-08-01T00:00:00.000Z",
    }];
    const committedArtifact = (
      id: string,
      rawHash: string,
      metadata: Record<string, unknown>,
      overrides: Record<string, unknown> = {},
    ) => ({
      id,
      revision_id: "revision-committed",
      role: "supporting_report_pdf",
      media_type: "application/pdf",
      object_key: `makesafe-docket-artifacts/${id}.pdf`,
      content_hash: `sha256:${"c".repeat(64)}`,
      size_bytes: 100,
      ...overrides,
      metadata: {
        source_kind: "previously_committed_pdf",
        source_identity:
          "docket-revision:trusted-source-revision/artifact:trusted-source-artifact",
        source_revision_id: "trusted-source-revision",
        source_artifact_id: "trusted-source-artifact",
        source_artifact_content_hash: `sha256:${"c".repeat(64)}`,
        expected_raw_sha256: `sha256:${rawHash}`,
        output_sha256: `sha256:${rawHash}`,
        render_hash: rawHash,
        report_contract_version: MAKESAFE_REPORT_CONTRACT_VERSION,
        ...metadata,
      },
    });

    // Document-sourced completeness recovery: the document hash may only vouch
    // for bytes it actually describes.
    const curatedMetadata = {
      report_document_id: "committed-report",
      source_document_id: "committed-report",
      evidence_source: "current_cycle_curated_makesafe_report",
    };
    live.docket_artifacts = [
      committedArtifact("artifact-doc-bound", "a".repeat(64), curatedMetadata),
    ];
    assertEquals(selectPhysicalReportProofForCycle(live, cycleId), {
      source_kind: "previously_committed_pdf",
      source_identity:
        "docket-revision:revision-committed/artifact:artifact-doc-bound",
      source_document_id: "committed-report",
      source_revision_id: "revision-committed",
      source_artifact_id: "artifact-doc-bound",
      source_artifact_content_hash: `sha256:${"c".repeat(64)}`,
      expected_raw_sha256: `sha256:${"a".repeat(64)}`,
      report_input_hash: `sha256:${"e".repeat(64)}`,
    });

    // Maylands-style: a thin artifact whose raw bytes are not the document's
    // rendered report cannot borrow that document's completeness coordinate.
    live.docket_artifacts = [
      committedArtifact(
        "artifact-doc-unbound",
        "b".repeat(64),
        curatedMetadata,
      ),
    ];
    assertEquals(selectPhysicalReportProofForCycle(live, cycleId), null);

    // A coordinate already stamped into artifact metadata is the same claim
    // about the same bytes, so it is refused on the same divergence.
    live.docket_artifacts = [
      committedArtifact("artifact-metadata-unbound", "b".repeat(64), {
        ...curatedMetadata,
        report_input_hash: `sha256:${"e".repeat(64)}`,
      }),
    ];
    assertEquals(selectPhysicalReportProofForCycle(live, cycleId), null);

    live.docket_artifacts = [
      committedArtifact("artifact-metadata-bound", "a".repeat(64), {
        ...curatedMetadata,
        report_input_hash: `sha256:${"e".repeat(64)}`,
      }),
    ];
    assertEquals(
      selectPhysicalReportProofForCycle(live, cycleId)?.source_artifact_id,
      "artifact-metadata-bound",
    );

    // The completeness refusal is raised before the size budget, so selection
    // bounds the size itself instead of inheriting an unchecked artifact.
    live.docket_artifacts = [
      committedArtifact("artifact-oversize", "a".repeat(64), curatedMetadata, {
        size_bytes: 8 * 1024 * 1024 + 1,
      }),
    ];
    assertEquals(selectPhysicalReportProofForCycle(live, cycleId), null);
  },
);

Deno.test(
  "first durable curated bind is re-hashed into a served report without a prior docket artifact",
  async () => {
    const live = mlbPhysicalSwmsSnapshot({ crew: "assigned_user" });
    const rendered = await renderMakesafeReportPdf({
      ref: "REF-PRIVATE-SAFE",
      address: "Privacy-safe test property",
      contact: "Canonical site contact",
      scope: "Stabilise the affected building element.",
      findings: "The affected element required immediate stabilisation.",
      works: "The affected element was secured pending permanent repair.",
      materials: "No materials recorded.",
      photos: [],
    });
    const rawDigest = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new Uint8Array(rendered.bytes).buffer,
      ),
    );
    const rawHash = Array.from(rawDigest).map((byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("");
    const contentHash = await sesSha256Bytes(rendered.bytes);
    const cycleId = String(live.detail!.attendance_cycle_id);
    live.documents = [{
      id: "document-curated-fixture",
      job_id: live.job.id,
      type: "makesafe_report",
      file_name: "privacy-safe-curated-report.pdf",
      pdf_url: "https://storage.example.test/curated-report.pdf",
      visible_to_trades: true,
      attendance_cycle_id: cycleId,
      cycle_attribution: "bound",
      version: 1,
      data_snapshot_json: {
        evidence_source: "current_cycle_curated_makesafe_report",
        report_contract_version: MAKESAFE_REPORT_CONTRACT_VERSION,
        report_renderer_version: MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_VERSION,
        report_renderer_source_revision:
          MAKESAFE_REPORT_AUTHORITATIVE_SOURCE_REVISION,
        report_renderer_script_sha256:
          MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_SHA256,
        report_render_hash: rawHash,
        report_input_hash: `sha256:${"1".repeat(64)}`,
        curated_source_kind: "durable_curated_revision",
        curated_source_identity:
          "curation-revision:curation-revision-fixture/artifact:curation-artifact-fixture",
        curated_source_revision_id: "curation-revision-fixture",
        curated_source_artifact_id: "curation-artifact-fixture",
        curated_source_artifact_content_hash: contentHash,
        curated_source_expected_raw_sha256: `sha256:${rawHash}`,
      },
    }];
    live.docket_revisions = [];
    live.docket_artifacts = [];
    const input = buildSesAssemblerInput(live);
    const dependencies = createSesAssemblerRuntimeDependencies(
      liveSnapshotClient(live),
      { org_id: live.job.org_id, created_by: "curated-bind-regression" },
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () =>
      Promise.resolve(new Response(new Uint8Array(rendered.bytes).buffer));
    try {
      const response = await prepare_ses_docket_revision(
        {
          selection: { mode: "job_id", job_id: live.job.id },
          idempotency_key: "first-durable-curated-source",
          assembler_version: SES_ASSEMBLER_VERSION,
          dry_run: false,
          force_refresh: true,
        },
        {
          ...dependencies,
          resolveSourceArtifacts: async () => sourceResolver(input),
          resolvePhotoArtifacts: async () =>
            input.cycle_facts.photos.map((photo) => ({
              photo_id: photo.id,
              source_pointer: photo.path_or_key,
              file_name: `${photo.id}.jpg`,
              media_type: "image/jpeg" as const,
              bytes: new Uint8Array([255, 216, 255, 224]),
            })),
          persist: async () => ({
            committed_at: "2026-08-04T00:00:00.000Z",
          }),
          now: () => new Date("2026-08-04T00:00:00.000Z"),
        },
      );
      const report = response.results[0].artifacts.find((artifact) =>
        artifact.role === "supporting_report_pdf"
      );
      assert(
        report,
        `the first trusted docket must serve the bound PDF: ${
          JSON.stringify({
            blockers: response.results[0].blockers,
            artifacts: response.results[0].artifacts.map((item) => item.role),
          })
        }`,
      );
      assertEquals(report.bytes, rendered.bytes);
      assertEquals(report.content_hash, contentHash);
      assertEquals(
        report.metadata.source_identity,
        "curation-revision:curation-revision-fixture/artifact:curation-artifact-fixture",
      );
      assertEquals(
        report.metadata.report_renderer_source_revision,
        MAKESAFE_REPORT_AUTHORITATIVE_SOURCE_REVISION,
      );
      assertStringIncludes(
        new TextDecoder("latin1").decode(report.bytes),
        "Canonical site contact",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

Deno.test(
  "a durable-bound sibling report recovers from its document without an empty artifact path",
  async () => {
    const live = mlbPhysicalSwmsSnapshot({ crew: "assigned_user" });
    const bytes = new TextEncoder().encode("%PDF-1.7\ntrusted sibling fixture");
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer),
    );
    const rawHash = Array.from(digest).map((byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("");
    const contentHash = await sesSha256Bytes(bytes);
    const reportDocumentId = "sibling-durable-report";
    live.documents = [{
      id: reportDocumentId,
      job_id: "sibling-job-fixture",
      type: "makesafe_report",
      file_name: "trusted-sibling.pdf",
      pdf_url: "https://storage.example.test/trusted-sibling.pdf",
      visible_to_trades: true,
      attendance_cycle_id: live.detail!.attendance_cycle_id,
      cycle_attribution: "bound",
      version: 1,
      data_snapshot_json: {
        evidence_source: "current_cycle_curated_makesafe_report",
        report_contract_version: MAKESAFE_REPORT_CONTRACT_VERSION,
        report_renderer_version: MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_VERSION,
        report_renderer_source_revision:
          MAKESAFE_REPORT_AUTHORITATIVE_SOURCE_REVISION,
        report_renderer_script_sha256:
          MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_SHA256,
        report_render_hash: rawHash,
        report_input_hash: `sha256:${"1".repeat(64)}`,
        curated_source_kind: "durable_curated_revision",
        curated_source_identity:
          "curation-revision:sibling-curation-revision/artifact:sibling-curation-artifact",
        curated_source_revision_id: "sibling-curation-revision",
        curated_source_artifact_id: "sibling-curation-artifact",
        curated_source_artifact_content_hash: contentHash,
        curated_source_expected_raw_sha256: `sha256:${rawHash}`,
      },
    }];
    live.docket_revisions = [];
    live.docket_artifacts = [];
    const input = buildSesAssemblerInput(live);
    input.sibling_bundle_evidence = {
      status: "accepted",
      bundle_id: "bundle-fixture",
      claiming_binding: {
        revision_id: "binding-forward",
        recorded_by: "operator-fixture",
        recorded_via: "test",
        provenance: { source: "test" },
      },
      reverse_binding: {
        revision_id: "binding-reverse",
        recorded_by: "operator-fixture",
        recorded_via: "test",
        provenance: { source: "test" },
      },
      sibling: {
        job_id: "sibling-job-fixture",
        job_number: "SWMS-SIBLING",
      },
      coverage: {
        invoice: {
          invoice_id: "invoice-fixture",
          invoice_number: "INV-FIXTURE",
          line_item_id: "line-fixture",
          scope_phrase: "secured building element",
        },
        delivery: {
          email_post_id: "delivery-fixture",
          content_sha256: "2".repeat(64),
          scope_phrase: "secured building element",
        },
        photo: {
          email_post_id: "delivery-fixture",
          content_sha256: "2".repeat(64),
          scope_phrase: "secured building element",
          media_id: "photo-fixture",
          content_hash: `sha256:${"3".repeat(64)}`,
        },
        report_document_id: reportDocumentId,
        swms_document_id: "swms-fixture",
      },
    };
    const dependencies = createSesAssemblerRuntimeDependencies(
      liveSnapshotClient(live),
      { org_id: live.job.org_id, created_by: "sibling-bind-regression" },
    );
    await dependencies.resolveInput({
      mode: "job_id",
      job_id: live.job.id,
    });
    assert(dependencies.resolveBundledPhysicalReportProof);
    assert(dependencies.renderBundledPhysicalReport);
    const proof = await dependencies.resolveBundledPhysicalReportProof(input);
    assert(proof);
    assertEquals(proof.source_kind, "durable_curated_revision");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () =>
      Promise.resolve(new Response(new Uint8Array(bytes).buffer));
    try {
      const recovered = await dependencies.renderBundledPhysicalReport(
        input,
        proof,
      );
      assert(recovered);
      assertEquals(recovered.bytes, bytes);
      assertEquals(
        recovered.provenance?.evidence_source,
        "explicit_sibling_bundle",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

Deno.test(
  "live adapter resolves pricing only from the sanctioned trade report and structured work-order scope facts",
  async () => {
    const temporaryFence = snapshot();
    temporaryFence.job.metadata.makesafe_job_family = "temp_fence_makesafe";
    temporaryFence.job.scope_json = {
      work_order_facts: {
        temporary_fencing: {
          panel_count: 8,
          base_count: 4,
          star_picket_count: 6,
        },
      },
    };
    temporaryFence.detail!.report_type = null;
    temporaryFence.detail!.external_links = [];
    temporaryFence.identity_revision = {
      authority_kind: "legacy_job_record",
      source_instruction_id: `legacy-job:${temporaryFence.job.id}`,
      source_version: 1,
      source_content_hash: `sha256:${"a".repeat(64)}`,
      lineage_id: temporaryFence.job.id,
      effective_case_id: null,
    };
    temporaryFence.detail!.external_ref = "MLB-27062";
    temporaryFence.reports[0].checklist_json = {
      works_completed: "Installed the temporary fence.",
      arrival_time: "08:30",
      labour_hours: 4,
      trade_count: 1,
    };
    const temporaryFenceInput = buildSesAssemblerInput(temporaryFence);
    assertEquals(temporaryFenceInput.cycle_facts.hours_and_materials, {
      trades: 1,
      hours_per_trade: 4,
      panel_count: 8,
      base_count: 4,
      star_picket_count: 6,
    });

    const assessment = sanitizedAssessmentSnapshot({
      jobNumber: "SWMS-27063",
      reportType: "assessment_report",
      photoLinkKind: "photos",
    });
    assessment.job.scope_json = {
      work_order_facts: {
        assessment: { fence_only: true },
      },
    };
    assertEquals(
      buildSesAssemblerInput(assessment).cycle_facts.hours_and_materials,
      { fence_only: true },
    );

    const roof = roofPortalSnapshot();
    roof.job.scope_json = {
      work_order_facts: {
        roof_report: { number_of_storeys: "Double Storey" },
      },
    };
    roof.roof_draft = null;
    const roofInput = buildSesAssemblerInput(roof);
    assertEquals(roofInput.cycle_facts.hours_and_materials, {
      storeys: "Double Storey",
    });
    const roofResult = (await prepare_ses_docket_revision(
      {
        selection: { mode: "job_id", job_id: roofInput.identity.job_id },
        idempotency_key: "roof-work-order-storey",
        assembler_version: SES_ASSEMBLER_VERSION,
        dry_run: true,
        force_refresh: true,
        draft_pack_output: {
          report: {
            ref: roofInput.source.builder_reference,
            scope: "Roof report scope is recorded.",
            findings: "Roof condition is recorded.",
            works: "Roof report completed.",
            materials: "No materials used.",
          },
          invoice: {
            reference: roofInput.source.builder_reference,
            line_items: [{
              // This validates the DraftPackOutput against its own MLB labour
              // contract. The roof fixed-price proposal is independently
              // derived from the typed work-order storey fact below.
              description: "Roof report attendance labour",
              quantity: 3,
              unit_price: 85,
            }],
          },
          change_summary: "Canonical roof draft fixture.",
        },
      },
      {
        resolveInput: async () => roofInput,
        resolveSourceArtifacts: async () => sourceResolver(roofInput),
        now: () => new Date("2026-07-28T08:00:00.000Z"),
      },
    )).results[0];
    // The reference-matching DraftPackOutput is valid; this fixture omits only
    // the headless portal capability. Named-card caveat mode keeps that
    // ordinary evidence gap review-visible without destroying the typed fixed
    // price; it may persist to Docs Ready but can never cross the send fence.
    assertEquals(roofResult.blockers.map((blocker) => blocker.reason_code), [
      "capability_portal_degraded",
    ]);
    assertEquals(roofResult.invoice_proposal?.subtotal_ex_gst, 300);
    assertEquals(roofResult.envelope.pre_xero_docs_ready, true);
    assertEquals(roofResult.envelope.invoice_create_approved, false);
    assertEquals(roofResult.envelope.client_send_approved, false);
    assertEquals(roofResult.release_payload.send_email, false);

    const cleanPricingBoundary = snapshot();
    cleanPricingBoundary.job.metadata.makesafe_job_family =
      "temp_fence_makesafe";
    cleanPricingBoundary.job.scope_json = {};
    cleanPricingBoundary.detail!.scope_json = {};
    cleanPricingBoundary.detail!.report_type = null;
    cleanPricingBoundary.detail!.external_links = [];
    cleanPricingBoundary.reports[0].checklist_json = {
      works_completed: "Installed temporary fencing.",
    };
    assertEquals(
      buildSesAssemblerInput(cleanPricingBoundary).cycle_facts
        .hours_and_materials,
      null,
    );
    const forbiddenPricing = structuredClone(cleanPricingBoundary);
    forbiddenPricing.job.pricing_json = {
      quote: { panel_count: 99 },
    };
    assertEquals(changedPaths(cleanPricingBoundary, forbiddenPricing), [
      "job.pricing_json",
    ]);
    assertEquals(
      buildSesAssemblerInput(forbiddenPricing).cycle_facts.hours_and_materials,
      null,
      "unsanctioned pricing_json must not become a structured work-order fact",
    );
  },
);

Deno.test(
  "live adapter selects the MLB South-West route from the canonical job suburb",
  () => {
    const live = snapshot();
    live.job.metadata.makesafe_job_family = "general_makesafe";
    live.job.site_suburb = "Dunsborough";
    live.detail!.report_type = null;
    live.detail!.external_links = [];
    const input = buildSesAssemblerInput(live);
    assertEquals(
      input.routing_seed.invoice_to,
      "bunbury@mlbuilders.com.au",
    );

    const perth = structuredClone(live);
    perth.job.site_suburb = "Perth";
    assertEquals(changedPaths(live, perth), ["job.site_suburb"]);
    const perthInput = buildSesAssemblerInput(perth);
    assert(
      perthInput.routing_seed.invoice_to !== input.routing_seed.invoice_to,
      "a non-South-West suburb must not inherit the South-West invoice route",
    );
  },
);

Deno.test(
  "physical U4 isolates a missing canonical builder reference from an otherwise valid input spine",
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
    live.identity_revision = {
      authority_kind: "legacy_job_record",
      source_instruction_id: `legacy-job:${live.job.id}`,
      source_version: 1,
      source_content_hash: `sha256:${"a".repeat(64)}`,
      lineage_id: live.job.id,
      effective_case_id: null,
    };
    const validInput = buildSesAssemblerInput(live);
    assert(validInput.source.builder_reference);
    const missingReferenceInput = structuredClone(validInput);
    missingReferenceInput.source.builder_reference = "";
    assertEquals(changedPaths(validInput, missingReferenceInput), [
      "source.builder_reference",
    ]);
    let renderCalls = 0;
    const run = async (
      input: ReturnType<typeof buildSesAssemblerInput>,
      idempotencyKey: string,
    ) =>
      await prepare_ses_docket_revision(
        {
          selection: { mode: "job_id", job_id: input.identity.job_id },
          idempotency_key: idempotencyKey,
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
            throw new Error("dry-run must not render the physical report");
          },
          renderSwmsArtifact: async () => ({
            file_name: "SWMS.pdf",
            media_type: "application/pdf",
            bytes: new Uint8Array([37, 80, 68, 70]),
          }),
          now: () => new Date("2026-07-27T08:00:00.000Z"),
        },
      );

    const valid = await run(validInput, "physical-reference-positive-control");
    const missing = await run(
      missingReferenceInput,
      "physical-missing-reference",
    );
    const referenceReason =
      "Builder reference is absent from the canonical source instruction.";
    assertEquals(
      valid.results[0].blockers.some((blocker) =>
        blocker.reason === referenceReason
      ),
      false,
    );
    assertEquals(missing.results[0].state, "blocked");
    assertEquals(missing.results[0].envelope.pre_xero_docs_ready, false);
    assertEquals(renderCalls, 0);
    assertEquals(
      missing.results[0].blockers.filter((blocker) =>
        blocker.reason === referenceReason ||
        blocker.reason_code === "invoice_reference_missing"
      ).length >= 1,
      true,
    );
  },
);

Deno.test(
  "artifact fetch failures surface typed source and photo degradation instead of clean absence",
  async () => {
    const live = snapshot();
    live.job.metadata.makesafe_job_family = "general_makesafe";
    live.detail!.report_type = null;
    live.detail!.external_links = [];
    live.identity_revision = {
      authority_kind: "legacy_job_record",
      source_instruction_id: `legacy-job:${live.job.id}`,
      source_version: 1,
      source_content_hash: `sha256:${"a".repeat(64)}`,
      lineage_id: live.job.id,
      effective_case_id: null,
    };
    live.reports[0].checklist_json = {
      damage_description: "Patio roof damage",
      work_done: "Removed loose material",
      labour_hours: 2,
      trade_count: 2,
    };
    live.media = [{
      id: "degradation-photo-1",
      job_id: live.job.id,
      type: "photo",
      phase: "completion",
      attendance_cycle_id: live.detail!.attendance_cycle_id,
      cycle_attribution: "bound",
      storage_url: "https://storage.example.test/degradation-photo-1.jpg",
    }];
    const input = buildSesAssemblerInput(live);
    const dependencies = createSesAssemblerRuntimeDependencies(
      liveSnapshotClient(live),
      { org_id: live.job.org_id, created_by: "u4-degradation-test" },
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.reject(new Error("storage unavailable"));
    try {
      const response = await prepare_ses_docket_revision(
        {
          selection: { mode: "job_id", job_id: input.identity.job_id },
          idempotency_key: "artifact-fetch-degradation",
          assembler_version: SES_ASSEMBLER_VERSION,
          dry_run: true,
          force_refresh: true,
        },
        dependencies,
      );
      const result = response.results[0];
      assertEquals(result.state, "ready");
      assertEquals(result.envelope.pre_xero_docs_ready, true);
      assert(
        result.blockers.some((blocker) =>
          blocker.reason_code === "spine_missing_source" &&
          blocker.reason.includes(
            "Canonical source recovery did not return 1 referenced attachment",
          )
        ),
      );
      assert(
        result.blockers.some((blocker) =>
          blocker.reason_code === "trade_evidence_missing" &&
          blocker.reason.includes(
            "did not resolve to one safe, non-empty current-cycle proof",
          )
        ),
      );
      assertEquals(
        result.artifacts.some((artifact) =>
          artifact.role === "source_attachment" ||
          artifact.role === "completion_photo_proof"
        ),
        false,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

Deno.test(
  "bundled report and photo fetch failures surface their typed unrecoverable blockers",
  async () => {
    const live = snapshot();
    live.job.metadata.makesafe_job_family = "general_makesafe";
    live.detail!.report_type = null;
    live.detail!.external_links = [];
    live.identity_revision = {
      authority_kind: "legacy_job_record",
      source_instruction_id: `legacy-job:${live.job.id}`,
      source_version: 1,
      source_content_hash: `sha256:${"a".repeat(64)}`,
      lineage_id: live.job.id,
      effective_case_id: null,
    };
    const siblingJobId = "sibling-job-degradation";
    const reportDocumentId = "sibling-report-degradation";
    const swmsDocumentId = "sibling-swms-degradation";
    const photoId = "sibling-photo-degradation";
    const photoHash = `sha256:${"b".repeat(64)}` as const;
    live.bundle_documents = [{
      id: reportDocumentId,
      job_id: siblingJobId,
      type: "makesafe_report",
      file_url: "https://storage.example.test/sibling-report.pdf",
    }, {
      id: swmsDocumentId,
      job_id: siblingJobId,
      type: "swms",
      file_url: "https://storage.example.test/sibling-swms.pdf",
    }];
    live.bundle_media = [{
      id: photoId,
      job_id: siblingJobId,
      type: "photo",
      label: "Completed temporary fencing",
      notes: "",
      makesafe_content_hash: photoHash,
      storage_url: "https://storage.example.test/sibling-photo.jpg",
    }];
    const input = buildSesAssemblerInput(live);
    input.cycle_facts.trade_report = null;
    input.cycle_facts.photos = [];
    input.sibling_bundle_evidence = {
      status: "accepted",
      bundle_id: "bundle-degradation",
      claiming_binding: {
        revision_id: "binding-forward",
        recorded_by: "operator",
        recorded_via: "test",
        provenance: { source: "test" },
      },
      reverse_binding: {
        revision_id: "binding-reverse",
        recorded_by: "operator",
        recorded_via: "test",
        provenance: { source: "test" },
      },
      sibling: {
        job_id: siblingJobId,
        job_number: "SWMS-SIBLING",
      },
      coverage: {
        invoice: {
          invoice_id: "invoice-degradation",
          invoice_number: "INV-DEGRADATION",
          line_item_id: "line-degradation",
          scope_phrase: "temporary fencing",
        },
        delivery: {
          email_post_id: "mail-degradation",
          content_sha256: "b".repeat(64),
          scope_phrase: "temporary fencing",
        },
        photo: {
          email_post_id: "mail-degradation",
          content_sha256: "b".repeat(64),
          scope_phrase: "temporary fencing",
          media_id: photoId,
          content_hash: photoHash,
        },
        report_document_id: reportDocumentId,
        swms_document_id: swmsDocumentId,
      },
    };
    const dependencies = createSesAssemblerRuntimeDependencies(
      liveSnapshotClient(live),
      { org_id: live.job.org_id, created_by: "u4-degradation-test" },
    );
    await dependencies.resolveInput({
      mode: "job_id",
      job_id: live.job.id,
    });
    assert(dependencies.resolveBundledReportArtifact);
    assert(dependencies.resolveBundledPhotoArtifacts);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.reject(new Error("storage unavailable"));
    try {
      assertEquals(
        await dependencies.resolveBundledReportArtifact(input),
        null,
      );
      assertEquals(
        await dependencies.resolveBundledPhotoArtifacts(input),
        [],
      );
      const request = {
        selection: { mode: "job_id" as const, job_id: input.identity.job_id },
        assembler_version: SES_ASSEMBLER_VERSION,
        dry_run: true,
        force_refresh: true,
      } as const;
      const reportFailure = await prepare_ses_docket_revision(
        {
          ...request,
          idempotency_key: "bundled-report-fetch-degradation",
        },
        {
          ...dependencies,
          resolveInput: async () => input,
          resolveSourceArtifacts: async () => sourceResolver(input),
        },
      );
      assert(
        blockerCodes(reportFailure.results[0]).includes(
          "sibling_evidence_artifact_unrecoverable",
        ),
      );

      const photoFailure = await prepare_ses_docket_revision(
        {
          ...request,
          idempotency_key: "bundled-photo-fetch-degradation",
        },
        {
          ...dependencies,
          resolveInput: async () => input,
          resolveSourceArtifacts: async () => sourceResolver(input),
          resolveBundledReportArtifact: async () => ({
            file_name: "sibling-report.pdf",
            media_type: "application/pdf",
            bytes: new Uint8Array([37, 80, 68, 70]),
          }),
        },
      );
      const photoFailureCodes = blockerCodes(photoFailure.results[0]);
      assert(
        photoFailureCodes.includes(
          "sibling_evidence_photo_artifact_unrecoverable",
        ) ||
          photoFailureCodes.includes("sibling_evidence_artifact_unrecoverable"),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

Deno.test(
  "DEFECT DOCUMENTATION: stored-but-unrecoverable SWMS is indistinguishable from absent SWMS",
  async () => {
    // This pins a known defect, not correct behavior. resolveSwmsArtifact is
    // unconsumed by prepare_ses_docket_revision, so neither null result can
    // become explicit degradation evidence until a product tranche fixes it.
    const stored = snapshot();
    stored.documents.push({
      id: "stored-swms",
      job_id: stored.job.id,
      type: "swms",
      file_url: "https://storage.example.test/stored-swms.pdf",
    });
    const storedInput = buildSesAssemblerInput(stored);
    const storedDependencies = createSesAssemblerRuntimeDependencies(
      liveSnapshotClient(stored),
      { org_id: stored.job.org_id, created_by: "u4-defect-test" },
    );
    await storedDependencies.resolveInput({
      mode: "job_id",
      job_id: stored.job.id,
    });
    assert(storedDependencies.resolveSwmsArtifact);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.reject(new Error("storage unavailable"));
    let unrecoverable: Awaited<
      ReturnType<NonNullable<typeof storedDependencies.resolveSwmsArtifact>>
    >;
    try {
      unrecoverable = await storedDependencies.resolveSwmsArtifact(storedInput);
    } finally {
      globalThis.fetch = originalFetch;
    }

    const absent = structuredClone(stored);
    absent.documents = absent.documents.filter((row) => row.type !== "swms");
    const absentInput = buildSesAssemblerInput(absent);
    const absentDependencies = createSesAssemblerRuntimeDependencies(
      liveSnapshotClient(absent),
      { org_id: absent.job.org_id, created_by: "u4-defect-test" },
    );
    await absentDependencies.resolveInput({
      mode: "job_id",
      job_id: absent.job.id,
    });
    assert(absentDependencies.resolveSwmsArtifact);
    const genuinelyAbsent = await absentDependencies.resolveSwmsArtifact(
      absentInput,
    );
    assertEquals(unrecoverable, null);
    assertEquals(genuinelyAbsent, null);
    assertEquals(unrecoverable, genuinelyAbsent);
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
      delete live.detail!.report_delivery;
      delete live.job.metadata.report_delivery;
      delete live.job.metadata.own_template_requested;
      delete live.job.metadata.strata;
      live.roof_draft = null;
      live.job.client_name = "Ordinary insured client";
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
  assertEquals(
    input.source.builder_reference,
    live.detail!.external_ref,
    "an explicit legacy_job_record revision, not the board row alone, authorizes the historical fallback",
  );
});

Deno.test("legacy job authority repairs a blank lineage id from the bound job", () => {
  const live = snapshot();
  live.identity_revision = {
    authority_kind: "legacy_job_record",
    source_instruction_id: `legacy-job:${live.job.id}`,
    source_version: 1,
    source_content_hash: `sha256:${"a".repeat(64)}`,
    lineage_id: "",
    effective_case_id: null,
  };

  const input = buildSesAssemblerInput(live);
  assertEquals(input.identity.lineage_id, live.job.id);
});

Deno.test(
  "real restoration card shape selects the sealed physical recipe then evidence-blocks",
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
    assertEquals(result.envelope.v2.classification.family, "restoration");
    assertEquals(
      result.envelope.v2.classification.job_type,
      "physical_makesafe",
    );
    assertEquals(result.envelope.v2.classification.recipe_selected, true);
    assert(!codes.includes("restoration_recipe_unsealed"));
    assert(!codes.includes("family_unknown"));
    // No trade report / photos on this fixture — physical evidence remains in
    // the complete review pack without suppressing Docs Ready.
    assertEquals(result.state, "ready");
    assertEquals(result.envelope.pre_xero_docs_ready, true);
    assert(
      codes.some((code) =>
        code === "trade_evidence_missing" ||
        code === "curated_source_missing" ||
        code === "photo_evidence_missing" ||
        code === "spine_missing_source" ||
        code === "spine_missing_lineage" ||
        code === "spine_missing_deliverables" ||
        code === "pricing_evidence_missing"
      ),
      `expected physical-path evidence blocker, got ${codes.join(",")}`,
    );
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
      // invoice_reference_missing is identity_safety_hard and leads the list.
      assertEquals(result.state, "blocked", shape.jobNumber);
      assertEquals(result.envelope.pre_xero_docs_ready, false, shape.jobNumber);
      assertEquals(
        blockerCodes(result),
        [
          "invoice_reference_missing",
          "spine_missing_source",
          "spine_missing_lineage",
          "spine_missing_source",
          "spine_missing_deliverables",
          "canonical_draft_pack_output_missing",
          "capability_portal_degraded",
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
      delete live.detail!.report_delivery;
      delete live.detail!.roof_report_mode;
      delete live.job.metadata.report_delivery;
      delete live.job.metadata.roof_report_mode;
      delete live.job.metadata.makesafe_roof_report_mode;
      delete live.job.metadata.own_template_requested;
      delete live.job.metadata.strata;
      live.roof_draft = null;
      live.job.client_name = "Ordinary insured client";
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
      "ses-builder-family-matrix/2026-08-13.1",
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

// The ops-api runtime, not a stub, must supply the deterministic SWMS renderer.
// #432 built `renderSesSwmsPdf` and added its import here, but never bound
// `renderSwmsArtifact` in `createSesAssemblerRuntimeDependencies`; #433's lint
// pass then removed the now-unused import. Every preparer test stubs that
// dependency (see the `dependencies()` helper in the preparer suite), so the
// whole suite stayed green while production refused every SWMS-required card
// with `swms_generation_capability_unavailable`. These two tests exercise the
// real factory instead: the first proves the runtime renders, the second proves
// a card whose crew is genuinely unrecorded still blocks.
function mlbPhysicalSwmsSnapshot(
  options: { crew: "assigned_user" | "none" },
): SesAssemblerLiveSnapshot {
  const live = snapshot();
  live.job.metadata.makesafe_job_family = "general_makesafe";
  live.detail!.report_type = null;
  live.detail!.external_links = [];
  // Seeded authority, exactly as the spine test builds it: without it the
  // builder reference resolves empty and the card blocks on identity long
  // before the SWMS branch is reached.
  live.identity_revision = {
    authority_kind: "legacy_job_record",
    source_instruction_id: "legacy-job:5383e3c4-eb32-41cf-8e3c-63a754c16d05",
    source_version: 1,
    source_content_hash: `sha256:${"a".repeat(64)}`,
    lineage_id: "5383e3c4-eb32-41cf-8e3c-63a754c16d05",
    effective_case_id: null,
  };
  live.reports[0].submitted_at = "2026-07-27T01:00:00.000Z";
  live.reports[0].checklist_json = {
    works_completed: "Made the storm damaged patio area safe.",
    attendance_date: "2026-07-27",
    arrival_time: "08:30",
    site_contact: "Site representative",
    labour_hours: 3,
    trade_count: 1,
    // Deliberately no crew_name and no crew: these live cards record the
    // attending trade only as the assigned user, exactly like the board.
  };
  live.assignments[0].crew_name = null;
  live.assignments[0].scheduled_date = "2026-07-27";
  live.assignments[0].arrived_at = "2026-07-27T08:30:00.000Z";
  live.assignments[0].users = options.crew === "assigned_user"
    ? { name: "Field crew" }
    : null;
  live.media = [{
    id: "6a2f1b4c-9d3e-4f10-8b57-000000000001",
    job_id: live.job.id,
    type: "photo",
    phase: "completion",
    attendance_cycle_id: live.detail!.attendance_cycle_id,
    cycle_attribution: "bound",
    label: "Completion photo 1",
    size: 1024,
    storage_url: "https://storage.example.test/completion-1.jpg",
  }];
  return live;
}

function swmsPreparationDependencies(live: SesAssemblerLiveSnapshot) {
  const input = buildSesAssemblerInput(live);
  // Only the network-bound dependencies are replaced. `renderSwmsArtifact` is
  // deliberately NOT overridden: whatever the factory supplies is what runs.
  return {
    input,
    overrides: {
      resolveSourceArtifacts: async () => sourceResolver(input),
      resolvePhotoArtifacts: async () =>
        input.cycle_facts.photos.map((photo) => ({
          photo_id: photo.id,
          source_pointer: photo.path_or_key,
          file_name: `${photo.id}.jpg`,
          media_type: "image/jpeg" as const,
          bytes: new Uint8Array([255, 216, 255, 224]),
        })),
      renderPhysicalReport: async () => ({
        file_name: "Make Safe Report.pdf",
        media_type: "application/pdf" as const,
        bytes: new Uint8Array([37, 80, 68, 70, 1]),
        render_hash: "physical-render-v1",
      }),
      persist: async () => ({ committed_at: "2026-07-27T02:00:00.000Z" }),
      now: () => new Date("2026-07-27T02:00:00.000Z"),
    },
  };
}

Deno.test(
  "ops-api runtime dependencies supply the deterministic SWMS renderer",
  async () => {
    const live = mlbPhysicalSwmsSnapshot({ crew: "assigned_user" });
    const dependencies = createSesAssemblerRuntimeDependencies(
      liveSnapshotClient(live),
      { org_id: "org-test", created_by: "u4-swms-runtime" },
    );
    // The binding itself. On the pre-fix shape this is `undefined` and the
    // preparer emits `swms_generation_capability_unavailable`.
    assert(
      dependencies.renderSwmsArtifact,
      "createSesAssemblerRuntimeDependencies must supply renderSwmsArtifact",
    );

    const { input, overrides } = swmsPreparationDependencies(live);
    const response = await prepare_ses_docket_revision(
      {
        selection: { mode: "job_id", job_id: live.job.id },
        idempotency_key: "u4-swms-runtime-renderer",
        assembler_version: SES_ASSEMBLER_VERSION,
        dry_run: false,
        force_refresh: true,
      },
      { ...dependencies, ...overrides },
    );
    const result = response.results[0];
    assert(
      !blockerCodes(result).includes("swms_generation_capability_unavailable"),
      `renderer must be available, got: ${blockerCodes(result).join(", ")}`,
    );

    const artifact = result.artifacts.find((item) =>
      item.role === "swms_artifact"
    );
    assert(artifact, "a SWMS-required card must bind a generated SWMS");
    const swmsState = result.envelope.v2.items.swms_artifact;
    assertEquals(swmsState.state, "ready");
    if (swmsState.state !== "ready") throw new Error("SWMS must be ready");
    assertStringIncludes(swmsState.evidence, "generated:ARTIFACTS/SWMS");

    // The docket must bind the renderer's own bytes, hashed by the renderer's
    // own contract - not a re-render and not a staff-attached PDF.
    const planned = buildSesSwmsGenerationPlan(input);
    assert(planned.ok, "fixture must produce a complete generation plan");
    assertEquals(
      artifact.metadata.render_hash,
      await sesSwmsRenderHash(planned.plan),
    );
    const rendered = await renderSesSwmsPdf(planned.plan);
    assertEquals(artifact.bytes, rendered.bytes);
    assertEquals(artifact.content_hash, await sesSha256Bytes(rendered.bytes));

    // A SWMS is a safety document: it must name the crew actually recorded
    // against this attendance, sourced from the assignment's own user record.
    assertEquals(planned.plan.job.crew, "Field crew");
    assertEquals(
      planned.plan.provenance.job_fact_sources.crew,
      "job_assignments.users.name",
    );
    const pdfText = new TextDecoder("latin1").decode(rendered.bytes);
    assertEquals([...pdfText.matchAll(/\/Type\s*\/Page\b/g)].length, 4);
  },
);

Deno.test(
  "CONTROL: a card with genuinely no recorded crew still blocks, renderer or not",
  async () => {
    const live = mlbPhysicalSwmsSnapshot({ crew: "none" });
    const dependencies = createSesAssemblerRuntimeDependencies(
      liveSnapshotClient(live),
      { org_id: "org-test", created_by: "u4-swms-control" },
    );
    const { input, overrides } = swmsPreparationDependencies(live);

    // The fact gate refuses before the renderer is ever reached, so this holds
    // identically on the pre-fix and post-fix shapes. That is the point of a
    // control: wiring the renderer must not manufacture a crew.
    const planned = buildSesSwmsGenerationPlan(input);
    assertEquals(planned.ok, false);
    if (planned.ok) throw new Error("crewless card must not produce a plan");
    assertEquals(planned.reason_code, "swms_generation_facts_missing");
    assert((planned.facts.missing_facts as string[]).includes("crew"));

    const response = await prepare_ses_docket_revision(
      {
        selection: { mode: "job_id", job_id: live.job.id },
        idempotency_key: "u4-swms-runtime-control",
        assembler_version: SES_ASSEMBLER_VERSION,
        dry_run: false,
        force_refresh: true,
      },
      { ...dependencies, ...overrides },
    );
    const result = response.results[0];
    assert(blockerCodes(result).includes("swms_generation_facts_missing"));
    assertEquals(
      result.artifacts.find((item) => item.role === "swms_artifact"),
      undefined,
    );
    assertEquals(result.envelope.v2.items.swms_artifact.state, "blocked");
  },
);

// --- Original work-order email subject recovery (MLB ordinary-mail inbox
// grouping only, never real threading). The pick helper is unit-tested in
// ses_mlb_thread_reply_test.ts; these pin the adapter side: WHICH stored post
// ids may supply emails.subject, and that a lower tier only speaks when the
// tier above it is genuinely empty.

const WO_EMAIL_SUBJECT =
  "NEW WORK ORDER - MLB-26267 U24/ 28 Peninsula Road, Maylands, WA 6051";

function intakeSubjectSnapshot(args: {
  emailSubjectsByPostId?: Record<string, string>;
  draftSubjects?: string[];
  metadataSubject?: string;
  storyPostIds?: string[];
  caseSourcesHaveThread?: boolean;
}): SesAssemblerLiveSnapshot {
  const live = snapshot();
  live.cases = [{
    id: "case-subject",
    state: "confirmed_live_job",
    story_json: (args.storyPostIds || []).map((sourcePostId) => ({
      sourcePostId,
    })),
  }];
  live.case_sources = [
    {
      case_id: "case-subject",
      post_id: "post-work-order",
      thread_id: args.caseSourcesHaveThread === false ? "" : "thread-intake",
      conversation_id: "conversation-intake",
      received_at: "2026-08-01T01:00:00.000Z",
    },
    {
      case_id: "case-subject",
      post_id: "post-later-chatter",
      thread_id: args.caseSourcesHaveThread === false ? "" : "thread-intake",
      conversation_id: "conversation-intake",
      received_at: "2026-08-02T01:00:00.000Z",
    },
  ];
  live.intake_email_subjects_by_post_id = args.emailSubjectsByPostId || {};
  live.approved_draft_subjects = args.draftSubjects || [];
  live.job = {
    ...live.job,
    metadata: {
      ...record(live.job.metadata),
      ...(args.metadataSubject === undefined
        ? {}
        : { builder_email_subject: args.metadataSubject }),
    },
  };
  return live;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

Deno.test(
  "intake subject recovery reads emails.subject only for the proven intake post id",
  () => {
    // The resolved thread anchor is post-work-order. A later chatter post on
    // the same thread is NOT the work order, so its subject must never be a
    // candidate — grouping builder mail under the wrong string is worse than
    // not grouping it.
    const input = buildSesAssemblerInput(intakeSubjectSnapshot({
      emailSubjectsByPostId: {
        "post-work-order": WO_EMAIL_SUBJECT,
        "post-later-chatter": "RE: unrelated site chatter",
      },
      draftSubjects: ["draft copy that must not win"],
      metadataSubject: "metadata copy that must not win",
    }));
    assertEquals(input.source.intake_post_id, "post-work-order");
    assertEquals(input.source.intake_email_subject, WO_EMAIL_SUBJECT);
    assertEquals(input.source.intake_email_subject_source, "emails_subject");
  },
);

Deno.test(
  "intake subject falls back draft -> metadata, and ambiguity yields no subject",
  () => {
    const draftFallback = buildSesAssemblerInput(intakeSubjectSnapshot({
      emailSubjectsByPostId: {},
      draftSubjects: ["  NEW WORK ORDER - MLB-26267 stored on the draft  "],
      metadataSubject: "metadata copy that must not win",
    }));
    assertEquals(
      draftFallback.source.intake_email_subject,
      "NEW WORK ORDER - MLB-26267 stored on the draft",
    );
    assertEquals(
      draftFallback.source.intake_email_subject_source,
      "intake_draft_subject",
    );

    const metadataFallback = buildSesAssemblerInput(intakeSubjectSnapshot({
      metadataSubject: "NEW WORK ORDER - MLB-26267 stamped at mint",
    }));
    assertEquals(
      metadataFallback.source.intake_email_subject,
      "NEW WORK ORDER - MLB-26267 stamped at mint",
    );
    assertEquals(
      metadataFallback.source.intake_email_subject_source,
      "job_metadata_builder_email_subject",
    );

    // Two distinct story-source posts each carrying a different stored subject
    // is ambiguity, not a race to the newest: refuse, and let the route ride
    // the generated pack subject rather than guess a work order.
    const ambiguous = buildSesAssemblerInput(intakeSubjectSnapshot({
      caseSourcesHaveThread: false,
      storyPostIds: ["post-work-order", "post-later-chatter"],
      emailSubjectsByPostId: {
        "post-work-order": WO_EMAIL_SUBJECT,
        "post-later-chatter": "NEW WORK ORDER - MLB-26999 12 Other Street",
      },
      draftSubjects: ["draft copy that must not rescue an ambiguous tier"],
    }));
    assertEquals(ambiguous.source.intake_post_id, null);
    assertEquals(ambiguous.source.intake_email_subject, null);
    assertEquals(ambiguous.source.intake_email_subject_source, null);

    // No stored subject anywhere: null, never a reconstructed string.
    const none = buildSesAssemblerInput(intakeSubjectSnapshot({}));
    assertEquals(none.source.intake_email_subject, null);
    assertEquals(none.source.intake_email_subject_source, null);
  },
);

// ---------------------------------------------------------------------------
// A rejected portal capture must name the coordinate that rejected it.
//
// The selection filter compares five coordinates; the signal named four. A
// capture rejected on `builder_reference` alone therefore read as "no capture
// was ever taken", whose apparent cure is to capture again - producing another
// row rejected the same way, invisibly. Measured on 2026-08-07: 21 of the 28
// persisted capture rows, across 8 caseless cards, carry an EMPTY
// `builder_reference`.
//
// These pin DIAGNOSIS ONLY. The verdict stays `missing` and no capture is
// admitted, so nothing becomes more sendable.
// ---------------------------------------------------------------------------

const captureRequest = {
  job_id: "job-1",
  docket_id: "docket-1",
  builder_reference: "MLB-25777",
  role: "roof_report" as const,
  url: "https://documents.primeeco.tech/share/abc",
  idempotency_key: "idem-1",
};

function capturedRow(builderReference: string) {
  return { builder_reference: builderReference } as never;
}

Deno.test("missing capture signal is unchanged when nothing was rejected", () => {
  // Byte-identical to the pre-existing wording, so every card that is NOT hit
  // by this defect produces the same docket output it produced before.
  assertEquals(
    missingCaptureSignal(captureRequest, "cycle-1", []),
    "No persisted portal capture matches job_id=job-1, attendance_cycle_id=cycle-1, " +
      "role=roof_report, source_url=https://documents.primeeco.tech/share/abc.",
  );
});

Deno.test("a reference-rejected capture is named, and re-capturing is ruled out", () => {
  const signal = missingCaptureSignal(captureRequest, "cycle-1", [
    capturedRow(""),
    capturedRow(""),
    capturedRow(""),
  ]);
  assertStringIncludes(signal, "3 captures for this job, cycle, role and URL");
  assertStringIncludes(signal, "rejected on builder_reference alone");
  assertStringIncludes(signal, "stored (empty)");
  assertStringIncludes(signal, "this card is MLB-25777");
  assertStringIncludes(signal, "Re-capturing will not change this");
});

Deno.test("the reference-rejected signal reports each distinct stored value once", () => {
  const signal = missingCaptureSignal(captureRequest, "cycle-1", [
    capturedRow("MLB-26111"),
    capturedRow("MLB-26111"),
  ]);
  assertStringIncludes(signal, "2 captures");
  assertStringIncludes(signal, "stored MLB-26111,");
  assert(
    !signal.includes("MLB-26111, MLB-26111"),
    "a repeated stored reference must be de-duplicated",
  );
});

Deno.test("an empty card reference is reported as (empty), never as blank", () => {
  // The caseless direction: the card itself derives no reference, so an
  // operator reading the signal must still be able to see that.
  const signal = missingCaptureSignal(
    { ...captureRequest, builder_reference: "" },
    "cycle-1",
    [capturedRow("MLB-26111")],
  );
  assertStringIncludes(signal, "this card is (empty)");
});
