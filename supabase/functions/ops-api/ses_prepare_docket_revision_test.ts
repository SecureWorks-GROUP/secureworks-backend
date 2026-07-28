// deno-lint-ignore-file no-import-prefix require-await
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import type {
  SesAssemblerInputV1,
  SesPortalCapture,
  SesPrepareRequest,
} from "./ses_docket_envelope.ts";
import {
  SES_ASSEMBLER_VERSION,
  SES_INPUT_CONTRACT_VERSION,
} from "./ses_docket_envelope.ts";
import {
  resolveSesFamilyMatrixRow,
  SES_EMERGENCY_SERVICE_FAMILIES,
  SES_FAMILY_MATRIX,
  SES_FAMILY_MATRIX_VERSION,
  type SesFamilyMatrixRow,
} from "./ses_family_matrix.ts";
import {
  createSesDocketPersistenceAdapter,
  type SesDocketPersistenceClient,
} from "./ses_docket_persistence.ts";
import {
  prepare_ses_docket_revision as prepareSesDocketRevision,
  SES_ASSESSMENT_RECIPE_VERSION,
  type SesPersistPayload,
  type SesPrepareDependencies,
} from "./ses_prepare_docket_revision.ts";

const FIXED_HASH =
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const FIXED_CAPTURE_HASH =
  "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const FIXED_TIME = new Date("2026-07-27T01:00:00.000Z");

function fixtureInput(
  row: SesFamilyMatrixRow,
  overrides: Partial<SesAssemblerInputV1> = {},
): SesAssemblerInputV1 {
  const physical = row.job_type === "physical_makesafe";
  const portals = row.required_portal_roles.map((role) => ({
    role,
    url: `https://portal.example.test/${role}/REF-70062`,
    source: "intake" as const,
  }));
  const canonicalRate = row.builder_key === "AJS" ||
      row.builder_key === "AJBR"
    ? 80
    : 85;
  const input: SesAssemblerInputV1 = {
    contract_version: SES_INPUT_CONTRACT_VERSION,
    identity: {
      source_instruction_id: "source:ajs-70062",
      source_version: "1",
      source_content_hash: FIXED_HASH,
      lineage_id: "lineage:ajs-70062",
      case_id: "case-70062",
      job_id: `job-${row.builder_key.toLowerCase()}-${row.family}`,
      job_number: "SWMS-270062",
      card_id: "card-70062",
      property_id: "property-70062",
    },
    attendance: {
      attendance_cycle_ids: ["cycle-70062"],
      current_attendance_cycle_id: "cycle-70062",
      cycle_number: 1,
      attribution: "bound",
    },
    classification: {
      builder_key: row.builder_key,
      builder_label: row.builder_key === "MLB"
        ? "ML Builders"
        : row.builder_key,
      family: row.family,
      subtype: row.subtype,
      report_only: row.report_only,
      report_delivery: row.report_delivery,
      delivery_render_route: row.family === "ordinary_roof_portal" ||
          row.family === "assessment_quote"
        ? "builder_portal"
        : row.family === "own_template_roof"
        ? "secureworks_own_letterhead"
        : "not_applicable",
      delivery_render_route_reason_code: row.family === "ordinary_roof_portal"
        ? "portal_builder_family"
        : row.family === "assessment_quote"
        ? "assessment_portal_recipe"
        : row.family === "own_template_roof"
        ? "explicit_own_letterhead_route"
        : "non_roof_family",
      delivery_render_route_reason: row.family === "ordinary_roof_portal" ||
          row.family === "assessment_quote"
        ? "Fixture uses the builder portal route."
        : row.family === "own_template_roof"
        ? "Fixture uses the SecureWorks own-letterhead route."
        : "Fixture family has no roof delivery/render route.",
      delivery_render_route_evidence: [
        `fixture:${row.builder_key}/${row.family}`,
      ],
      strata: row.family === "own_template_roof",
      own_template_requested: row.family === "own_template_roof",
      workflow: "active",
      lineage_kind: "none",
      family_matrix_version: SES_FAMILY_MATRIX_VERSION,
      assessment_outbound_recipe_version: row.family === "assessment_quote"
        ? SES_ASSESSMENT_RECIPE_VERSION
        : null,
    },
    source: {
      work_order_sender: "workorders@example-builder.test",
      builder_reference: row.builder_key === "AJS" ? "AJS 70062" : "REF-70062",
      po_or_external_ref: "PO-70062",
      site_address: "62 Example Street",
      site_suburb: "Perth",
      instruction_text: row.builder_key === "AJS"
        ? "Tarp affected areas of water leaking"
        : "Fixture instruction",
      deliverables: [{ id: "deliverable-1", kind: row.family }],
      attachment_pointers: ["SOURCE/work-order.pdf"],
      portal_links: portals,
    },
    cycle_facts: {
      trade_report: physical ? { summary: "Work completed safely." } : null,
      photos: physical
        ? [
          {
            id: "photo-1",
            path_or_key: "ARTIFACTS/photos/01.jpg",
            caption: "Completed barrier",
            order: 1,
          },
        ]
        : [],
      roof_report_fields: row.family === "own_template_roof"
        ? { storeys: "Single Storey", finding: "Fixture" }
        : null,
      hours_and_materials: row.family === "ordinary_roof_portal" ||
          row.family === "own_template_roof"
        ? { storeys: "Single Storey" }
        : row.family === "assessment_quote"
        ? { fence_only: false }
        : {
          trades: 1,
          hours_per_trade: row.family === "temporary_fencing" ? 4 : 3,
          rate_ex_gst: canonicalRate,
          materials: [],
          ...(row.family === "temporary_fencing"
            ? {
              panel_count: 8,
              base_count: 8,
              star_picket_count: 0,
            }
            : {}),
        },
      prior_release: {
        released: false,
        release_revision_id: null,
        cycle_set_hash: null,
      },
    },
    hrcw: {
      hrcw: false,
      categories: [],
      source_hazard_terms: [],
    },
    routing_seed: {
      report_to: "workorders@example-builder.test",
      invoice_to: null,
    },
    readiness: {
      readiness_revision: null,
      dependency_generation: 1,
    },
  };
  return {
    ...input,
    ...overrides,
  };
}

function request(
  jobId = "job-fixture",
  dryRun = true,
): SesPrepareRequest {
  return {
    selection: { mode: "job_id", job_id: jobId },
    idempotency_key: "fixture-intent-1",
    assembler_version: SES_ASSEMBLER_VERSION,
    dry_run: dryRun,
    force_refresh: true,
  };
}

function dependencies(
  input: SesAssemblerInputV1,
  overrides: Partial<SesPrepareDependencies> = {},
): SesPrepareDependencies {
  return {
    resolveInput: async () => structuredClone(input),
    resolveSourceArtifacts: async (resolvedInput) =>
      resolvedInput.source.attachment_pointers.map((source_pointer, index) => ({
        source_pointer,
        file_name: index === 0
          ? "work-order.pdf"
          : `source-attachment-${index + 1}.bin`,
        media_type: index === 0
          ? "application/pdf"
          : "application/octet-stream",
        bytes: new Uint8Array([37, 80, 68, 70, index]),
      })),
    resolvePhotoArtifacts: async (resolvedInput) =>
      resolvedInput.cycle_facts.photos.map((photo, index) => ({
        photo_id: photo.id,
        source_pointer: photo.path_or_key,
        file_name: `${String(index + 1).padStart(3, "0")}.jpg`,
        media_type: "image/jpeg" as const,
        bytes: new Uint8Array([255, 216, 255, index]),
      })),
    resolvePhotoProofs: async (resolvedInput) =>
      resolvedInput.cycle_facts.photos.map((photo, index) => ({
        photo_id: photo.id,
        source_pointer: photo.path_or_key,
        file_name: `${String(index + 1).padStart(3, "0")}.jpg`,
        media_type: "image/jpeg" as const,
        content_hash: FIXED_CAPTURE_HASH,
        size_bytes: 500_000 + index,
      })),
    capturePortal: async (captureRequest): Promise<SesPortalCapture> => ({
      status: "done",
      role: captureRequest.role,
      url: captureRequest.url,
      docket_id: captureRequest.docket_id,
      job_id: captureRequest.job_id,
      builder_reference: captureRequest.builder_reference,
      captured_at: FIXED_TIME.toISOString(),
      captured_by: "fixture-capture@example.test",
      capture_producer: "capture_portal_evidence.py/v1",
      evidence_revision_id: "fixture-capture-revision",
      content_fingerprint: FIXED_CAPTURE_HASH,
      idempotency_key: captureRequest.idempotency_key,
      signal: "submitted-and-locked",
      screenshot_bytes: new Uint8Array([1, 2, 3]),
    }),
    renderPhysicalReport: async () => ({
      file_name: "Make Safe Report - REF-70062.pdf",
      media_type: "application/pdf",
      bytes: new Uint8Array([37, 80, 68, 70, 1]),
      render_hash: "physical-render-v1",
    }),
    renderOwnRoofReport: async () => ({
      file_name: "Roof Report - REF-70062.pdf",
      media_type: "application/pdf",
      bytes: new Uint8Array([37, 80, 68, 70, 2]),
      render_hash: "roof-render-v1",
    }),
    renderSwmsArtifact: async () => ({
      file_name: "SWMS - REF-70062.pdf",
      media_type: "application/pdf",
      bytes: new Uint8Array([37, 80, 68, 70, 3]),
      render_hash: "swms-render-v1",
    }),
    now: () => FIXED_TIME,
    ...overrides,
  };
}

function blockerCodes(result: {
  blockers: Array<{ reason_code: string }>;
}): string[] {
  return result.blockers.map((item) => item.reason_code);
}

Deno.test("family matrix is a closed executable set with the AJS report guard", () => {
  assertEquals(SES_EMERGENCY_SERVICE_FAMILIES, [
    "roof",
    "assessment",
    "makesafe",
    "restoration",
  ]);
  assertEquals(SES_FAMILY_MATRIX.length, 15);
  for (const row of SES_FAMILY_MATRIX) {
    const resolved = resolveSesFamilyMatrixRow({
      builder_key: row.builder_key,
      family: row.family,
      strata: row.family === "own_template_roof",
      own_template_requested: row.family === "own_template_roof",
    });
    assert(resolved.ok);
    assertEquals(resolved.row, row);
  }
  for (
    const family of [
      "ordinary_roof_portal",
      "own_template_roof",
      "assessment_quote",
    ] as const
  ) {
    const rejected = resolveSesFamilyMatrixRow({
      builder_key: "AJS",
      family,
      strata: family === "own_template_roof",
      own_template_requested: family === "own_template_roof",
    });
    assert(!rejected.ok);
    assertEquals(rejected.failure.code, "ajs_misclassified_as_roof_report");
  }
});

Deno.test("restoration is typed but hard-stops before any unsealed recipe work", async () => {
  const physicalRow = SES_FAMILY_MATRIX.find((candidate) =>
    candidate.builder_key === "MLB" &&
    candidate.family === "physical_makesafe"
  )!;
  const input = fixtureInput(physicalRow);
  input.identity.job_id = "7dea664a-e0d7-4263-ab0c-bacea9e1d65d";
  input.identity.job_number = "SWMS-26936";
  input.identity.card_id = "7dea664a-e0d7-4263-ab0c-bacea9e1d65d";
  input.identity.source_instruction_id = "legacy-job:SWMS-26936";
  input.classification.family = "restoration";
  input.classification.subtype = null;
  input.classification.report_only = false;
  input.classification.report_delivery = null;
  input.source.builder_reference = "MLB-MW-26873";
  input.source.site_address = "Real restoration card address";
  input.source.site_suburb = "Perth";
  input.source.deliverables = [];
  input.cycle_facts.trade_report = null;
  input.cycle_facts.photos = [];
  input.cycle_facts.hours_and_materials = null;

  let sourceRecoveryCalls = 0;
  let portalCaptureCalls = 0;
  let physicalRenderCalls = 0;
  let roofRenderCalls = 0;
  let swmsCalls = 0;
  const result = (await prepareSesDocketRevision(
    request(input.identity.job_id),
    dependencies(input, {
      resolveSourceArtifacts: async () => {
        sourceRecoveryCalls++;
        return [];
      },
      capturePortal: async () => {
        portalCaptureCalls++;
        throw new Error("restoration portal recipe must not run");
      },
      renderPhysicalReport: async () => {
        physicalRenderCalls++;
        throw new Error("physical recipe must not run");
      },
      renderOwnRoofReport: async () => {
        roofRenderCalls++;
        throw new Error("roof recipe must not run");
      },
      renderSwmsArtifact: async () => {
        swmsCalls++;
        return null;
      },
    }),
  )).results[0];

  const codes = blockerCodes(result);
  assertEquals(result.state, "blocked");
  assert(codes.includes("restoration_recipe_unsealed"));
  assert(!codes.includes("family_unknown"));
  assertEquals(result.envelope.v2.classification.family, "restoration");
  assertEquals(result.envelope.v2.classification.job_type, "restoration");
  assertEquals(result.envelope.v2.classification.recipe_selected, false);
  const restorationBlocker = result.blockers.find((blocker) =>
    blocker.reason_code === "restoration_recipe_unsealed"
  )!;
  assertEquals(restorationBlocker.facts, {
    job_id: "7dea664a-e0d7-4263-ab0c-bacea9e1d65d",
    job_number: "SWMS-26936",
    card_id: "7dea664a-e0d7-4263-ab0c-bacea9e1d65d",
    builder_reference: "MLB-MW-26873",
    site_address: "Real restoration card address",
    site_suburb: "Perth",
    builder_key: "MLB",
    family: "restoration",
    subtype: null,
    workflow: "active",
    source_instruction_id: "legacy-job:SWMS-26936",
    current_attendance_cycle_id: "cycle-70062",
    cycle_number: 1,
  });
  assertEquals(result.invoice_proposal, null);
  assertEquals(result.email_drafts, {});
  assertEquals(sourceRecoveryCalls, 0);
  assertEquals(portalCaptureCalls, 0);
  assertEquals(physicalRenderCalls, 0);
  assertEquals(roofRenderCalls, 0);
  assertEquals(swmsCalls, 0);
});

Deno.test("every shippable matrix row has a ready golden and an intentional negative golden", async () => {
  for (
    const row of SES_FAMILY_MATRIX.filter((candidate) =>
      candidate.family !== "assessment_quote" &&
      candidate.builder_key !== "SYNTHETIC"
    )
  ) {
    const input = fixtureInput(row);
    const positive = await prepareSesDocketRevision(
      request(input.identity.job_id),
      dependencies(input),
    );
    assertEquals(
      positive.results[0].state,
      "ready",
      `${row.builder_key}/${row.family} positive`,
    );
    assertEquals(positive.results[0].envelope.pre_xero_docs_ready, true);

    const negativeInput = fixtureInput(row);
    negativeInput.classification.family_matrix_version = "stale-matrix";
    const negative = await prepareSesDocketRevision(
      request(negativeInput.identity.job_id),
      dependencies(negativeInput),
    );
    assertEquals(negative.results[0].state, "blocked");
    assert(
      blockerCodes(negative.results[0]).includes("input_hash_conflict"),
      `${row.builder_key}/${row.family} negative`,
    );
  }
});

Deno.test("synthetic matrix rows are internal-only and always release-blocked after full evidence validation", async () => {
  const rows = SES_FAMILY_MATRIX.filter((candidate) =>
    candidate.builder_key === "SYNTHETIC"
  );
  assertEquals(
    rows.map((row) => row.family),
    [
      "physical_makesafe",
      "temporary_fencing",
      "ordinary_roof_portal",
      "assessment_quote",
    ],
  );
  for (const row of rows) {
    assertEquals(row.routing_rule, "synthetic-internal-routing");
    assertEquals(row.invoice_to, "marnin@secureworkswa.com.au");
    const input = fixtureInput(row);
    input.source.work_order_sender = "marnin@secureworkswa.com.au";
    input.routing_seed.report_to = "marnin@secureworkswa.com.au";
    input.routing_seed.invoice_to = "marnin@secureworkswa.com.au";
    const result = (await prepareSesDocketRevision(
      request(input.identity.job_id),
      dependencies(input),
    )).results[0];
    assertEquals(result.state, "blocked", row.family);
    assertEquals(result.envelope.pre_xero_docs_ready, false, row.family);
    assertEquals(result.envelope.invoice_create_approved, false, row.family);
    assertEquals(result.envelope.client_send_approved, false, row.family);
    assertEquals(result.email_drafts, {}, row.family);
    assert(
      blockerCodes(result).includes(
        "synthetic_livefire_release_forbidden",
      ),
      row.family,
    );
    assertEquals(
      result.release_payload,
      {
        version: "ses-inert-release-proposal/v1",
        job_id: input.identity.job_id,
        invoice_create_approved: false,
        client_send_approved: false,
        send_email: false,
        send_sms: false,
        create_invoice: false,
        authorise_invoice: false,
        close_job: false,
        portal_evidence: result.portal_evidence,
      },
      row.family,
    );
    if (row.required_portal_roles.length) {
      assertEquals(
        result.portal_evidence.map((evidence) => evidence.role),
        row.required_portal_roles,
        row.family,
      );
    }
    if (row.family === "assessment_quote") {
      assertEquals(result.portal_evidence.length, 3);
      assert(
        !blockerCodes(result).includes("assessment_recipe_unapproved"),
        "the fixture carries the current sealed assessment recipe",
      );
    }
  }

  const assessmentRow = rows.find((row) => row.family === "assessment_quote")!;
  const incompleteAssessment = fixtureInput(assessmentRow);
  incompleteAssessment.source.work_order_sender = "marnin@secureworkswa.com.au";
  incompleteAssessment.source.portal_links = incompleteAssessment.source
    .portal_links.filter((link) => link.role !== "scope");
  const incompleteResult = (await prepareSesDocketRevision(
    request(incompleteAssessment.identity.job_id),
    dependencies(incompleteAssessment),
  )).results[0];
  assert(
    blockerCodes(incompleteResult).includes("portal_link_absent"),
  );
  assert(
    blockerCodes(incompleteResult).includes(
      "synthetic_livefire_release_forbidden",
    ),
  );
  assert(
    !blockerCodes(incompleteResult).includes("assessment_recipe_unapproved"),
    "the fixture carries the current sealed assessment recipe",
  );
  assertEquals(incompleteResult.portal_evidence.length, 2);
});

Deno.test("AJS 70062 roof wording assembles the physical make-safe pack", async () => {
  const row = SES_FAMILY_MATRIX.find((candidate) =>
    candidate.builder_key === "AJS" &&
    candidate.family === "physical_makesafe"
  )!;
  const input = fixtureInput(row);
  const response = await prepareSesDocketRevision(
    request(input.identity.job_id),
    dependencies(input),
  );
  const result = response.results[0];
  assertEquals(result.state, "ready");
  assertEquals(
    result.envelope.v2.classification.job_type,
    "physical_makesafe",
  );
  assertEquals(
    result.envelope.v2.items.physical_reporting_evidence.state,
    "ready",
  );
  assertEquals(
    result.envelope.v2.items.supporting_portal_links.state,
    "not_applicable",
  );
  assertEquals(Object.keys(result.email_drafts).sort(), [
    "INVOICE_EMAIL_DRAFT",
    "PHOTO_EMAIL_DRAFT",
    "REPORT_EMAIL_DRAFT",
  ]);
});

Deno.test("AJS report-only input is rejected instead of silently rerouted", async () => {
  const row = SES_FAMILY_MATRIX.find((candidate) =>
    candidate.builder_key === "MLB" &&
    candidate.family === "ordinary_roof_portal"
  )!;
  const input = fixtureInput(row);
  input.classification.builder_key = "AJS";
  input.classification.builder_label = "AJS";
  input.source.builder_reference = "AJS 70062";
  let sourceRecoveryCalls = 0;
  let portalCaptureCalls = 0;
  let swmsCalls = 0;
  const deps = dependencies(input);
  const response = await prepareSesDocketRevision(
    request(input.identity.job_id),
    {
      ...deps,
      resolveSourceArtifacts: async () => {
        sourceRecoveryCalls += 1;
        return [];
      },
      capturePortal: async (captureRequest) => {
        portalCaptureCalls += 1;
        return deps.capturePortal!(captureRequest);
      },
      renderSwmsArtifact: async () => {
        swmsCalls += 1;
        return null;
      },
    },
  );
  const result = response.results[0];
  assertEquals(result.state, "blocked");
  assert(
    blockerCodes(result).includes(
      "ajs_misclassified_as_roof_report",
    ),
  );
  assertEquals(result.envelope.v2.classification.job_type, "unknown");
  assertEquals(result.envelope.v2.routing, {
    builder: "AJS",
    report_to: "",
    photo_to: "",
    invoice_to: "",
  });
  assertEquals(
    Object.values(result.envelope.v2.items).some((item) =>
      item.state === "ready"
    ),
    false,
  );
  assertEquals(result.invoice_proposal, null);
  assertEquals(result.email_drafts, {});
  assertEquals(
    result.artifacts.some((artifact) =>
      artifact.role === "supporting_report_pdf" ||
      artifact.role === "completion_photo" ||
      artifact.role === "source_attachment" ||
      artifact.role === "case_story"
    ),
    false,
  );
  assertEquals(sourceRecoveryCalls, 0);
  assertEquals(portalCaptureCalls, 0);
  assertEquals(swmsCalls, 0);
});

Deno.test("unknown family hard-stops before any matrix recipe is selected", async () => {
  const row = SES_FAMILY_MATRIX.find((candidate) =>
    candidate.builder_key === "MLB" &&
    candidate.family === "physical_makesafe"
  )!;
  const input = fixtureInput(row);
  input.classification.builder_key = "UNKNOWN";
  input.classification.builder_label = "Unknown Builder";
  input.classification.family = "unknown";
  input.classification.subtype = null;
  input.classification.report_only = false;
  input.classification.report_delivery = null;
  let sourceRecoveryCalls = 0;
  let reportRenderCalls = 0;
  let swmsCalls = 0;
  const result = (await prepareSesDocketRevision(
    request(input.identity.job_id),
    dependencies(input, {
      resolveSourceArtifacts: async () => {
        sourceRecoveryCalls += 1;
        return [];
      },
      renderPhysicalReport: async () => {
        reportRenderCalls += 1;
        throw new Error("physical recipe must not run");
      },
      renderSwmsArtifact: async () => {
        swmsCalls += 1;
        return null;
      },
    }),
  )).results[0];
  assertEquals(result.state, "blocked");
  assert(blockerCodes(result).includes("family_unknown"));
  assertEquals(result.envelope.v2.classification.job_type, "unknown");
  assertEquals(result.envelope.v2.classification.family, "unknown");
  assertEquals(result.envelope.v2.classification.recipe_selected, false);
  assertEquals(result.envelope.v2.routing, {
    builder: "Unknown Builder",
    report_to: "",
    photo_to: "",
    invoice_to: "",
  });
  assertEquals(
    Object.values(result.envelope.v2.items).some((item) =>
      item.state === "ready"
    ),
    false,
  );
  assertEquals(result.invoice_proposal, null);
  assertEquals(result.email_drafts, {});
  assertEquals(sourceRecoveryCalls, 0);
  assertEquals(reportRenderCalls, 0);
  assertEquals(swmsCalls, 0);
});

Deno.test("portal state is read through the capture adapter and fails closed", async () => {
  const row = SES_FAMILY_MATRIX.find((candidate) =>
    candidate.family === "ordinary_roof_portal"
  )!;
  for (
    const [status, code] of [
      ["not_done", "portal_not_submitted"],
      ["unreachable", "portal_unreachable"],
      ["done", "portal_unreachable"],
    ] as const
  ) {
    const input = fixtureInput(row);
    const base = dependencies(input);
    const response = await prepareSesDocketRevision(
      request(input.identity.job_id),
      {
        ...base,
        capturePortal: async (captureRequest) => ({
          status,
          role: captureRequest.role,
          url: captureRequest.url,
          docket_id: captureRequest.docket_id,
          job_id: captureRequest.job_id,
          builder_reference: captureRequest.builder_reference,
          captured_at: FIXED_TIME.toISOString(),
          captured_by: "fixture-capture@example.test",
          capture_producer: "capture_portal_evidence.py/v1",
          evidence_revision_id: "fixture-capture-revision",
          content_fingerprint: FIXED_CAPTURE_HASH,
          idempotency_key: captureRequest.idempotency_key,
          signal: status === "not_done" ? "form outstanding" : "timeout",
        }),
      },
    );
    assertEquals(response.results[0].state, "blocked");
    assert(blockerCodes(response.results[0]).includes(code));
  }
});

Deno.test("portal done requires a valid content fingerprint", async () => {
  const row = SES_FAMILY_MATRIX.find((candidate) =>
    candidate.family === "ordinary_roof_portal"
  )!;
  const input = fixtureInput(row);
  const base = dependencies(input);
  const response = await prepareSesDocketRevision(
    request(input.identity.job_id),
    {
      ...base,
      capturePortal: async (captureRequest) => ({
        status: "done" as const,
        role: captureRequest.role,
        url: captureRequest.url,
        docket_id: captureRequest.docket_id,
        job_id: captureRequest.job_id,
        builder_reference: captureRequest.builder_reference,
        captured_at: FIXED_TIME.toISOString(),
        captured_by: "fixture-capture@example.test",
        capture_producer: "capture_portal_evidence.py/v1",
        evidence_revision_id: "fixture-capture-revision",
        content_fingerprint: "" as SesPortalCapture["content_fingerprint"],
        idempotency_key: captureRequest.idempotency_key,
        signal: "submitted-and-locked",
        screenshot_bytes: new Uint8Array([1, 2, 3]),
      }),
    },
  );
  assertEquals(response.results[0].state, "blocked");
  assert(blockerCodes(response.results[0]).includes("portal_capture_invalid"));
  assertEquals(
    response.results[0].envelope.v2.items.roof_report_capture.state,
    "blocked",
  );
});

Deno.test("ordinary portal roofs draft the invoice without inventing a report PDF", async () => {
  const row = SES_FAMILY_MATRIX.find((candidate) =>
    candidate.family === "ordinary_roof_portal"
  )!;
  const input = fixtureInput(row);
  const result = (await prepareSesDocketRevision(
    request(input.identity.job_id),
    dependencies(input),
  )).results[0];
  assertEquals(result.state, "ready");
  assertEquals(Object.keys(result.email_drafts), ["INVOICE_EMAIL_DRAFT"]);
  assertEquals(
    result.envelope.v2.items.draft_builder_report_email.state,
    "not_applicable",
  );
  assertEquals(
    result.envelope.v2.items.draft_invoice_bundle_email.state,
    "ready",
  );
  assertEquals(
    result.email_drafts.INVOICE_EMAIL_DRAFT.includes(
      "ARTIFACTS/invoice_proposal.json",
    ),
    true,
  );
});

Deno.test("blocked non-assessment packs do not expose email drafts", async () => {
  const row = SES_FAMILY_MATRIX.find((candidate) =>
    candidate.builder_key === "AJS" && candidate.family === "physical_makesafe"
  )!;
  const input = fixtureInput(row);
  const response = await prepareSesDocketRevision(
    request(input.identity.job_id),
    {
      ...dependencies(input),
      renderPhysicalReport: undefined,
    },
  );
  const result = response.results[0];
  assertEquals(result.state, "blocked");
  assertEquals(result.email_drafts, {});
  assertEquals(
    result.envelope.v2.items.draft_builder_report_email.state,
    "blocked",
  );
  assertEquals(
    result.envelope.v2.items.draft_invoice_bundle_email.state,
    "blocked",
  );
});

Deno.test("physical dry-run proves every current-cycle photo without copying bytes and blocks an incomplete proof", async () => {
  const row = SES_FAMILY_MATRIX.find((candidate) =>
    candidate.builder_key === "AJS" &&
    candidate.family === "physical_makesafe"
  )!;
  const input = fixtureInput(row);
  input.cycle_facts.photos.push({
    id: "photo-2",
    path_or_key: "ARTIFACTS/photos/02.jpg",
    caption: "Completed tarp",
    order: 2,
  });
  const complete = await prepareSesDocketRevision(
    request(input.identity.job_id),
    dependencies(input),
  );
  assertEquals(
    complete.results[0].artifacts.filter((artifact) =>
      artifact.role === "completion_photo_proof"
    ).length,
    2,
  );
  assertEquals(
    complete.results[0].artifacts.some((artifact) =>
      artifact.role === "completion_photo" ||
      artifact.role === "supporting_report_pdf"
    ),
    false,
  );
  assertEquals(
    complete.results[0].email_drafts.PHOTO_EMAIL_DRAFT.includes(
      "ARTIFACTS/photos/002-002.jpg",
    ),
    true,
  );

  const incomplete = await prepareSesDocketRevision(
    request(input.identity.job_id),
    dependencies(input, {
      resolvePhotoProofs: async (resolvedInput) => [{
        photo_id: resolvedInput.cycle_facts.photos[0].id,
        source_pointer: resolvedInput.cycle_facts.photos[0].path_or_key,
        file_name: "001.jpg",
        media_type: "image/jpeg",
        content_hash: FIXED_CAPTURE_HASH,
        size_bytes: 500_000,
      }],
    }),
  );
  assertEquals(incomplete.results[0].state, "blocked");
  assert(
    blockerCodes(incomplete.results[0]).includes("trade_evidence_missing"),
  );
});

Deno.test("bidirectional positive-scope bundle evidence clears the card-local physical and SWMS blockers", async () => {
  const row = SES_FAMILY_MATRIX.find((candidate) =>
    candidate.builder_key === "MLB" &&
    candidate.family === "physical_makesafe"
  )!;
  const input = fixtureInput(row);
  input.identity.job_id = "c3afc061-0d4a-43ff-8309-0b8b512e307a";
  input.identity.job_number = "SWMS-26832";
  input.identity.card_id = input.identity.job_id;
  input.source.builder_reference = "MLB-26393";
  input.cycle_facts.trade_report = null;
  input.cycle_facts.photos = [];
  input.sibling_bundle_evidence = {
    status: "accepted",
    bundle_id: "1cd35292-1eb7-438f-bf6e-8dbcdf3fb135",
    claiming_binding: {
      revision_id: "7dcf8954-5f8c-412b-898e-bc92987e44fc",
      recorded_by: "ses-sibling-evidence-v1",
      recorded_via: "reviewed_migration:20260728730000",
      provenance: { source: "ses-u7-whole-board-sweep-v1" },
    },
    reverse_binding: {
      revision_id: "a2ebb22e-6f46-463d-87c8-7e7ec71cd399",
      recorded_by: "ses-sibling-evidence-v1",
      recorded_via: "reviewed_migration:20260728730000",
      provenance: { source: "ses-u7-whole-board-sweep-v1" },
    },
    sibling: {
      job_id: "02f614a4-09a7-422e-9381-c89a44aceccd",
      job_number: "SWMS-26837",
    },
    coverage: {
      invoice: {
        invoice_id: "3be46700-4d5d-4b91-b96e-8baf43ac9d7c",
        invoice_number: "INV-0835",
        line_item_id: "edcaa56c-84d5-4a12-be0d-032bd1d422f3",
        scope_phrase: "Hardie panel stacking",
      },
      delivery: {
        email_post_id: "mail-0835",
        content_sha256:
          "0be5b5d7d6c7d921a3976a5332b326989e83cf36cb2653b6c349ac68ef4bceba",
        scope_phrase: "displaced Hardie panels stacked safely",
      },
      photo: {
        email_post_id: "mail-0835",
        content_sha256:
          "0be5b5d7d6c7d921a3976a5332b326989e83cf36cb2653b6c349ac68ef4bceba",
        scope_phrase: "displaced Hardie panels stacked safely",
        media_id: "photo-26837",
        content_hash:
          "sha256:f46202099887565a5738073440de40efa1b0793bfb13576ff69b7d5d56667f60",
      },
      report_document_id: "513cb62a-4f9f-4fd5-ae5c-66b0ce053448",
      swms_document_id: "878641fc-99ba-4f5f-a0a6-d64708394b6a",
    },
  };
  const result = (await prepareSesDocketRevision(
    request(input.identity.job_id),
    dependencies(input, {
      resolveBundledReportArtifact: async () => ({
        file_name: "SWMS-26837 Make Safe Report.pdf",
        media_type: "application/pdf",
        bytes: new Uint8Array([37, 80, 68, 70, 37]),
      }),
      resolveBundledPhotoArtifacts: async () => [{
        photo_id: "photo-26837",
        source_pointer: "job_media:photo-26837",
        file_name: "SWMS-26837-photo.jpg",
        media_type: "image/jpeg",
        bytes: new Uint8Array([255, 216, 255, 4]),
      }],
    }),
  )).results[0];
  const codes = blockerCodes(result);
  assert(!codes.includes("trade_evidence_missing"));
  assert(!codes.includes("hrcw_swms_missing"));
  assert(!codes.some((code) => code.startsWith("sibling_evidence_")));
  assertEquals(
    result.envelope.v2.items.physical_reporting_evidence.state,
    "ready",
  );
  assertEquals(result.envelope.v2.items.supporting_report_pdf.state, "ready");
  assertEquals(result.envelope.v2.items.swms_artifact.state, "ready");
  assert(
    result.artifacts.some((artifact) =>
      artifact.path === "PROOF/sibling_bundle_evidence.json"
    ),
  );
  assert(
    result.artifacts.some((artifact) =>
      artifact.role === "supporting_report_pdf" &&
      artifact.metadata?.bundle_id ===
        "1cd35292-1eb7-438f-bf6e-8dbcdf3fb135"
    ),
  );
});

Deno.test("assessment triad produces an invoice-only draft at the sealed price", async () => {
  const row = SES_FAMILY_MATRIX.find((candidate) =>
    candidate.family === "assessment_quote"
  )!;
  const input = fixtureInput(row);
  input.hrcw = {
    hrcw: true,
    categories: ["asbestos"],
    source_hazard_terms: ["asbestos"],
  };
  const response = await prepareSesDocketRevision(
    request(input.identity.job_id),
    dependencies(input),
  );
  const result = response.results[0];
  assertEquals(result.state, "ready");
  assertEquals(result.portal_evidence.length, 3);
  assertEquals(Object.keys(result.email_drafts), ["INVOICE_EMAIL_DRAFT"]);
  assertStringIncludes(
    result.email_drafts.INVOICE_EMAIL_DRAFT,
    "assessment, photo schedule and quote",
  );
  assertEquals(
    result.envelope.v2.items.draft_invoice_bundle_email.state,
    "ready",
  );
  assertEquals(result.invoice_proposal?.subtotal_ex_gst, 150);
  assertEquals(result.invoice_proposal?.total_inc_gst, 165);
  assertEquals(result.envelope.v2.items.swms_artifact.state, "not_applicable");

  const fenceOnly = fixtureInput(row);
  fenceOnly.cycle_facts.hours_and_materials = { fence_only: true };
  const fenceResult = (await prepareSesDocketRevision(
    request(fenceOnly.identity.job_id),
    dependencies(fenceOnly),
  )).results[0];
  assertEquals(fenceResult.invoice_proposal?.subtotal_ex_gst, 130);
  assertEquals(fenceResult.invoice_proposal?.total_inc_gst, 143);
});

Deno.test("assessment invoice requires an explicit fence-only fact and a non-empty builder reference", async () => {
  const row = SES_FAMILY_MATRIX.find((candidate) =>
    candidate.family === "assessment_quote"
  )!;

  const missingFenceOnly = fixtureInput(row);
  missingFenceOnly.cycle_facts.hours_and_materials = {};
  const missingFenceResult = (await prepareSesDocketRevision(
    request(missingFenceOnly.identity.job_id),
    dependencies(missingFenceOnly),
  )).results[0];
  assertEquals(missingFenceResult.invoice_proposal, null);
  assert(
    blockerCodes(missingFenceResult).includes("pricing_evidence_missing"),
  );

  const missingReference = fixtureInput(row);
  missingReference.source.builder_reference = "";
  const missingReferenceResult = (await prepareSesDocketRevision(
    request(missingReference.identity.job_id),
    dependencies(missingReference),
  )).results[0];
  assertEquals(missingReferenceResult.invoice_proposal, null);
  assert(
    blockerCodes(missingReferenceResult).includes(
      "invoice_reference_missing",
    ),
  );
  assertEquals(
    missingReferenceResult.artifacts.some((artifact) =>
      artifact.role === "invoice_proposal"
    ),
    false,
  );
  assertEquals(
    missingReferenceResult.envelope.local_invoice_proposal.state,
    "blocked",
  );
});

Deno.test("spine-derived manifest items stay blocked until every named evidence fact and source byte exists", async () => {
  const row = SES_FAMILY_MATRIX.find((candidate) =>
    candidate.builder_key === "MLB" &&
    candidate.family === "physical_makesafe"
  )!;
  const input = fixtureInput(row);
  input.identity.source_instruction_id = "";
  input.identity.lineage_id = "";
  input.identity.source_content_hash = "" as SesAssemblerInputV1["identity"][
    "source_content_hash"
  ];
  input.source.builder_reference = "";
  input.source.deliverables = [];
  const result = (await prepareSesDocketRevision(
    request(input.identity.job_id),
    dependencies(input),
  )).results[0];
  for (
    const item of [
      "source_work_order_retrieval",
      "source_work_order_identity",
      "source_work_order_attachment",
      "instruction_deliverables",
      "case_story_recovery",
      "hrcw_assessment",
      "swms_requirement",
    ]
  ) {
    assertEquals(
      result.envelope.v2.items[item].state,
      "blocked",
      `${item} must not contradict a missing-spine blocker`,
    );
  }
});

Deno.test("builder routing uses only company/matrix evidence and blocks when the company route is absent", async () => {
  const row = SES_FAMILY_MATRIX.find((candidate) =>
    candidate.builder_key === "WESTERN" &&
    candidate.family === "temporary_fencing"
  )!;
  const input = fixtureInput(row);
  input.source.work_order_sender = null;
  input.routing_seed.report_to = "invented-fallback@example.test";
  input.routing_seed.invoice_to = "invented-fallback@example.test";
  const result = (await prepareSesDocketRevision(
    request(input.identity.job_id),
    dependencies(input),
  )).results[0];
  assert(blockerCodes(result).includes("routing_evidence_missing"));
  assertEquals(result.envelope.v2.items.builder_routing.state, "blocked");
  assertEquals(result.envelope.v2.routing, {
    builder: "WESTERN",
    report_to: "",
    photo_to: "",
    invoice_to: "accounts@westernbuild.com.au",
  });
  assertEquals(result.email_drafts, {});
});

Deno.test("temporary fencing rejects missing typed panel/base evidence", async () => {
  const row = SES_FAMILY_MATRIX.find((candidate) =>
    candidate.builder_key === "AJS" &&
    candidate.family === "temporary_fencing"
  )!;
  const input = fixtureInput(row);
  input.cycle_facts.hours_and_materials = {
    trades: 1,
    hours_per_trade: 4,
    rate_ex_gst: 80,
  };
  const response = await prepareSesDocketRevision(
    request(input.identity.job_id),
    dependencies(input),
  );
  assertEquals(response.results[0].state, "blocked");
  assertEquals(
    response.results[0].envelope.v2.classification.family,
    "temporary_fencing",
  );
  assertEquals(
    response.results[0].envelope.v2.classification.subtype,
    "temporary_fencing",
  );
  assert(
    blockerCodes(response.results[0]).includes("pricing_evidence_missing"),
  );
});

Deno.test("SWMS-required job with work order and trade report generates a provenance-bound artifact", async () => {
  const row = SES_FAMILY_MATRIX.find((candidate) =>
    candidate.builder_key === "MLB" &&
    candidate.family === "physical_makesafe"
  )!;
  const input = fixtureInput(row);
  input.cycle_facts.trade_report = {
    id: "trade-report-70062",
    submitted_at: "2026-07-27T01:00:00.000Z",
    checklist_json: {
      works_completed: "Installed temporary fencing and made the area safe.",
      attendance_date: "2026-07-27",
      arrival_time: "08:30",
      crew_name: "Field crew",
      site_contact: "Site representative",
    },
  };
  let generated = 0;
  const result = (await prepareSesDocketRevision(
    request(input.identity.job_id, false),
    dependencies(input, {
      renderSwmsArtifact: async (plan) => {
        generated++;
        assertEquals(plan.template.kind, "general_makesafe");
        assertEquals(plan.provenance.trade_report_id, "trade-report-70062");
        return {
          file_name: plan.output_file_name,
          media_type: "application/pdf",
          bytes: new Uint8Array([37, 80, 68, 70, 3]),
          render_hash: "generated-swms-v1",
          provenance: {
            template_version: plan.template_version,
            trade_report_id: plan.provenance.trade_report_id,
          },
        };
      },
      persist: async () => ({
        committed_at: "2026-07-27T01:00:01.000Z",
      }),
    }),
  )).results[0];

  assertEquals(generated, 1);
  assertEquals(result.state, "ready");
  const artifact = result.artifacts.find((item) =>
    item.role === "swms_artifact"
  );
  assert(artifact);
  assertEquals(artifact.metadata.render_hash, "generated-swms-v1");
  assertEquals(artifact.metadata.provenance, {
    template_version: "secureworks.swms-template/2026-06-30-v1",
    trade_report_id: "trade-report-70062",
  });
  const swmsState = result.envelope.v2.items.swms_artifact;
  assertEquals(swmsState.state, "ready");
  if (swmsState.state !== "ready") {
    throw new Error("generated SWMS must be ready");
  }
  assertStringIncludes(swmsState.evidence, "generated:ARTIFACTS/SWMS");
});

Deno.test("non-required report-only family does not plan or generate a SWMS", async () => {
  const row = SES_FAMILY_MATRIX.find((candidate) =>
    candidate.builder_key === "MLB" &&
    candidate.family === "assessment_quote"
  )!;
  const input = fixtureInput(row);
  let generated = 0;
  const result = (await prepareSesDocketRevision(
    request(input.identity.job_id),
    dependencies(input, {
      renderSwmsArtifact: async () => {
        generated++;
        throw new Error("report-only family must not generate a SWMS");
      },
    }),
  )).results[0];

  assertEquals(generated, 0);
  assertEquals(result.envelope.v2.items.swms_artifact.state, "not_applicable");
  assertEquals(
    result.artifacts.some((artifact) =>
      artifact.role === "swms_artifact" ||
      artifact.role === "swms_generation_plan"
    ),
    false,
  );
});

Deno.test("missing trade report blocks SWMS generation without instructing staff to attach one", async () => {
  const row = SES_FAMILY_MATRIX.find((candidate) =>
    candidate.builder_key === "MLB" &&
    candidate.family === "physical_makesafe"
  )!;
  const input = fixtureInput(row);
  input.cycle_facts.trade_report = null;
  const result = (await prepareSesDocketRevision(
    request(input.identity.job_id),
    dependencies(input),
  )).results[0];
  const blocker = result.blockers.find((candidate) =>
    candidate.reason_code === "swms_generation_trade_report_missing"
  );

  assert(blocker);
  assertStringIncludes(blocker.reason, "field trade report");
  assertStringIncludes(blocker.recovery_action, "U4");
  assertStringIncludes(blocker.recovery_action, "do not need to attach a SWMS");
  assertEquals(
    result.blockers.some((candidate) =>
      candidate.reason_code === "hrcw_swms_missing"
    ),
    false,
  );
});

Deno.test("unsupported HRCW combination blocks for a sealed-template decision", async () => {
  const row = SES_FAMILY_MATRIX.find((candidate) =>
    candidate.builder_key === "AJS" &&
    candidate.family === "physical_makesafe"
  )!;
  const input = fixtureInput(row);
  input.cycle_facts.trade_report = {
    id: "trade-report-unsupported-hrcw",
    submitted_at: "2026-07-27T01:00:00.000Z",
    checklist_json: {
      works_completed: "Installed temporary structural support.",
      attendance_date: "2026-07-27",
      arrival_time: "08:30",
      crew_name: "Field crew",
      site_contact: "Site representative",
    },
  };
  input.hrcw.categories = ["structural"];
  input.hrcw.source_hazard_terms = ["temporary load-bearing support"];
  const response = await prepareSesDocketRevision(
    request(input.identity.job_id),
    dependencies(input),
  );
  assertEquals(response.results[0].state, "blocked");
  assert(
    blockerCodes(response.results[0]).includes(
      "swms_generation_template_unavailable",
    ),
  );
});

Deno.test("same input and intent produce stable revision and output hashes", async () => {
  const row = SES_FAMILY_MATRIX.find((candidate) =>
    candidate.builder_key === "AJS" &&
    candidate.family === "physical_makesafe"
  )!;
  const input = fixtureInput(row);
  const first = await prepareSesDocketRevision(
    request(input.identity.job_id),
    dependencies(input),
  );
  const second = await prepareSesDocketRevision(
    request(input.identity.job_id),
    dependencies(input),
  );
  assertEquals(
    first.results[0].docket_revision_id,
    second.results[0].docket_revision_id,
  );
  assertEquals(
    first.results[0].output_content_hash,
    second.results[0].output_content_hash,
  );
  assertEquals(
    first.results[0].artifacts.map((artifact) => [
      artifact.path,
      artifact.content_hash,
    ]),
    second.results[0].artifacts.map((artifact) => [
      artifact.path,
      artifact.content_hash,
    ]),
  );
});

Deno.test("draft-only wall exposes no money/send dependency and emits an inert release proposal", async () => {
  const source = await Deno.readTextFile(
    new URL("./ses_prepare_docket_revision.ts", import.meta.url),
  );
  for (
    const forbidden of [
      "createInvoice(",
      "create_makesafe_draft_invoice",
      "draft_makesafe_report_pack",
      "makesafe_send_pack",
      "send_makesafe_email",
    ]
  ) {
    assertEquals(source.includes(forbidden), false, forbidden);
  }
  const row = SES_FAMILY_MATRIX.find((candidate) =>
    candidate.builder_key === "AJS" &&
    candidate.family === "physical_makesafe"
  )!;
  const input = fixtureInput(row);
  const response = await prepareSesDocketRevision(
    request(input.identity.job_id),
    dependencies(input),
  );
  assertEquals(response.results[0].release_payload, {
    version: "ses-inert-release-proposal/v1",
    job_id: input.identity.job_id,
    invoice_create_approved: false,
    client_send_approved: false,
    send_email: false,
    send_sms: false,
    create_invoice: false,
    authorise_invoice: false,
    close_job: false,
    portal_evidence: [],
  });
  assertStringIncludes(
    response.results[0].email_drafts.INVOICE_EMAIL_DRAFT,
    "No Xero object exists",
  );
});

Deno.test("persistence migration is append-only, service-role-only, and enforces the draft wall", async () => {
  const migration = await Deno.readTextFile(
    new URL(
      "../../migrations/20260728010000_makesafe_docket_revisions_u4.sql",
      import.meta.url,
    ),
  );
  for (
    const required of [
      "CREATE TABLE IF NOT EXISTS public.makesafe_docket_revisions",
      "CREATE TABLE IF NOT EXISTS public.makesafe_docket_artifacts",
      "CREATE OR REPLACE VIEW public.makesafe_docket_revisions_current",
      "CREATE OR REPLACE FUNCTION public.commit_makesafe_docket_revision_v1",
      "is append-only",
      "makesafe_docket_revisions_draft_wall",
      "invoice_create_approved",
      "client_send_approved",
      "create_invoice",
      "authorise_invoice",
      "send_email",
      "send_sms",
      "close_job",
      "duration_ms integer NOT NULL",
      "within_five_minutes boolean NOT NULL",
      "sla_breach jsonb NOT NULL",
      "ses_revision_sla_breach",
      "TO service_role",
      "FROM PUBLIC, anon, authenticated",
      "'makesafe-docket-artifacts'",
    ]
  ) {
    assertStringIncludes(migration, required);
  }
  for (
    const forbidden of [
      "CREATE EXTENSION",
      "cron.schedule",
      "UPDATE public.jobs",
      "UPDATE public.makesafe_job_details",
      "INSERT INTO public.xero_invoices",
    ]
  ) {
    assertEquals(
      migration.toUpperCase().includes(forbidden.toUpperCase()),
      false,
    );
  }
});

Deno.test("persistence adapter writes only private docket artifacts and the append-only commit RPC", async () => {
  const row = SES_FAMILY_MATRIX.find((candidate) =>
    candidate.builder_key === "AJS" &&
    candidate.family === "physical_makesafe"
  )!;
  const input = fixtureInput(row);
  input.identity.job_id = "00000000-0000-0000-0000-000000007062";
  input.attendance.attendance_cycle_ids = [
    "00000000-0000-0000-0000-000000000062",
  ];
  input.attendance.current_attendance_cycle_id =
    "00000000-0000-0000-0000-000000000062";
  const prepared = (await prepareSesDocketRevision(
    request(input.identity.job_id, false),
    dependencies(input, {
      persist: async () => ({
        committed_at: "2026-07-27T01:00:00.500Z",
      }),
    }),
  )).results[0];
  assert(
    prepared.artifacts.some((artifact) => artifact.role === "completion_photo"),
  );
  assert(
    prepared.artifacts.some((artifact) =>
      artifact.role === "supporting_report_pdf"
    ),
  );
  assertEquals(
    prepared.artifacts.some((artifact) =>
      artifact.role === "completion_photo_proof"
    ),
    false,
  );
  const calls: Array<{ kind: string; name: string }> = [];
  const rpcCalls: Array<{
    name: string;
    args: Record<string, unknown>;
  }> = [];
  const client = {
    storage: {
      from: (bucket: string) => ({
        upload: async () => {
          calls.push({ kind: "storage", name: bucket });
          return { data: {}, error: null };
        },
        download: async () => ({
          data: null,
          error: { message: "unexpected download" },
        }),
      }),
    },
    from: (table: string) => {
      calls.push({ kind: "table", name: table });
      throw new Error("unexpected duplicate lookup");
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ kind: "rpc", name });
      rpcCalls.push({ name, args });
      return {
        data: name === "commit_makesafe_docket_revision_v1"
          ? { committed_at: "2026-07-27T01:00:01.000Z" }
          : { review_state: "needs_review" },
        error: null,
      };
    },
  } as unknown as SesDocketPersistenceClient;
  const persist = createSesDocketPersistenceAdapter({
    client,
    org_id: "00000000-0000-0000-0000-000000000001",
    created_by: "ses-u4-test",
  });
  const persistPayload: SesPersistPayload = {
    revision: {
      state: prepared.state,
      docket_revision_id: prepared.docket_revision_id,
      input_content_hash: prepared.input_content_hash,
      output_content_hash: prepared.output_content_hash,
      envelope: prepared.envelope,
      blockers: prepared.blockers,
      portal_evidence: prepared.portal_evidence,
      invoice_proposal: prepared.invoice_proposal,
      email_drafts: prepared.email_drafts,
      review_spec: prepared.review_spec,
      release_payload: prepared.release_payload,
    },
    artifacts: prepared.artifacts,
    idempotency_key: "fixture-intent-1",
    assembler_version: SES_ASSEMBLER_VERSION,
    family_matrix_version: SES_FAMILY_MATRIX_VERSION,
    accepted_at: "2026-07-27T01:00:00.000Z",
    stage_durations_ms: prepared.timing.stages_ms,
  };
  const committed = await persist(persistPayload);
  assertEquals(committed.committed_at, "2026-07-27T01:00:01.000Z");
  assert(
    calls.filter((call) => call.kind === "storage").every((call) =>
      call.name === "makesafe-docket-artifacts"
    ),
  );
  assertEquals(calls.filter((call) => call.kind === "table"), []);
  assertEquals(
    calls.filter((call) => call.kind === "rpc"),
    [
      { kind: "rpc", name: "commit_makesafe_docket_revision_v1" },
      { kind: "rpc", name: "record_ses_docket_review_state_v1" },
    ],
  );
  const revisionPayload = rpcCalls[0].args
    .p_revision as Record<string, unknown>;
  assertEquals(revisionPayload.pre_xero_docs_ready, true);
  assertEquals(
    (revisionPayload.release_payload as Record<string, unknown>)
      .create_invoice,
    false,
  );
  assertEquals(rpcCalls[1].args, {
    p_event: {
      docket_revision_id: prepared.docket_revision_id,
      event_kind: "prepared",
      expected_output_content_hash: prepared.output_content_hash,
      actor_identity: "ses-u4-test",
      reason: "The assembler completed the audit-grade family pack.",
    },
  });

  let orphanDownloads = 0;
  const orphanArtifact = prepared.artifacts[0];
  const orphanClient = {
    storage: {
      from: () => ({
        upload: async () => ({
          data: null,
          error: { message: "already exists", statusCode: "409" },
        }),
        download: async () => {
          orphanDownloads += 1;
          return {
            data: new Blob([
              Uint8Array.from(orphanArtifact.bytes).buffer as ArrayBuffer,
            ]),
            error: null,
          };
        },
      }),
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: null, error: null }),
        }),
      }),
    }),
    rpc: async () => ({
      data: { committed_at: "2026-07-27T01:00:02.000Z" },
      error: null,
    }),
  } as unknown as SesDocketPersistenceClient;
  const orphanPersist = createSesDocketPersistenceAdapter({
    client: orphanClient,
    org_id: "00000000-0000-0000-0000-000000000001",
    created_by: "ses-u4-test",
  });
  await orphanPersist({
    ...persistPayload,
    artifacts: [orphanArtifact],
  });
  assertEquals(orphanDownloads, 1);
});

Deno.test("five-minute clock stops at committed ready/blocked and reports max/P95", async () => {
  const row = SES_FAMILY_MATRIX.find((candidate) =>
    candidate.builder_key === "AJS" &&
    candidate.family === "physical_makesafe"
  )!;
  const base = fixtureInput(row);
  let clock = 0;
  const response = await prepareSesDocketRevision(
    {
      ...request(base.identity.job_id, false),
      selection: { mode: "board_batch", limit: 20 },
    },
    dependencies(base, {
      listBoardJobs: async () =>
        Array.from(
          { length: 20 },
          (_, index) => ({ mode: "job_id" as const, job_id: `job-${index}` }),
        ),
      resolveInput: async (selection) => {
        const input = structuredClone(base);
        input.identity.job_id = selection.mode === "job_id"
          ? String(selection.job_id)
          : base.identity.job_id;
        return input;
      },
      persist: async () => ({
        committed_at: new Date(clock).toISOString(),
      }),
      now: () => {
        const value = new Date(clock);
        clock += 1_000;
        return value;
      },
    }),
  );
  assertEquals(response.results.length, 20);
  assertEquals(response.timing_summary.count, 20);
  assertEquals(response.timing_summary.all_within_five_minutes, true);
  assert(response.timing_summary.max_ms >= 250_000);
  assert(response.timing_summary.max_ms <= 300_000);
  assert(response.timing_summary.p95_ms >= 250_000);
  assert(response.timing_summary.p95_ms <= response.timing_summary.max_ms);
  assert(response.results.every((result) => result.persisted));
  assert(
    response.results.every((result) =>
      result.timing.accepted_at && result.timing.committed_at
    ),
  );
});
