// deno-lint-ignore-file no-import-prefix require-await
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import type {
  SesAssemblerInputV1,
  SesPhysicalReportProof,
  SesPortalCapture,
  SesPrepareRequest,
} from "./ses_docket_envelope.ts";
import {
  SES_ASSEMBLER_VERSION,
  SES_INPUT_CONTRACT_VERSION,
} from "./ses_docket_envelope.ts";
import {
  isSesPhysicalShapedFamily,
  MLB_SOUTH_WEST_SUBURBS,
  resolveSesFamilyMatrixRow,
  SES_EMERGENCY_SERVICE_FAMILIES,
  SES_FAMILY_MATRIX,
  SES_FAMILY_MATRIX_VERSION,
  SES_PHYSICAL_SHAPED_FAMILIES,
  type SesFamilyMatrixRow,
} from "./ses_family_matrix.ts";
import {
  createSesDocketPersistenceAdapter,
  type SesDocketPersistenceClient,
} from "./ses_docket_persistence.ts";
import { mlbPhysicalUsesOrdinaryMailSendFallback } from "./ses_mlb_thread_reply.ts";
import {
  prepare_ses_docket_revision as prepareSesDocketRevision,
  SES_ASSESSMENT_RECIPE_VERSION,
  SES_DOCKET_REVIEW_SPEC_VERSION,
  SES_PHYSICAL_FAMILY_RECIPE_VERSION,
  type SesPersistPayload,
  type SesPrepareDependencies,
} from "./ses_prepare_docket_revision.ts";

const FIXED_HASH =
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const FIXED_CAPTURE_HASH =
  "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const FIXED_TIME = new Date("2026-07-27T01:00:00.000Z");
const DEFAULT_PHYSICAL_REPORT_PROOF: SesPhysicalReportProof = {
  source_kind: "previously_committed_pdf",
  source_identity:
    "docket-revision:fixture-source-revision/artifact:fixture-source-artifact",
  source_document_id: "fixture-source-document",
  source_revision_id: "fixture-source-revision",
  source_artifact_id: "fixture-source-artifact",
  expected_raw_sha256:
    "sha256:a0716166bb20b36120b2c5693fb679dd2a3f18e942eaf3e073753bcbc525daf2",
  source_artifact_content_hash:
    "sha256:2bff3da80f0931657b35b9053e25f9e88b93f7dd709ad353a0dba233dc85aaa0",
};

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
      site_suburb: row.routing_rule === "mlb-south-west-routing"
        ? "Bunbury"
        : "Perth",
      instruction_text: row.builder_key === "AJS"
        ? "Tarp affected areas of water leaking"
        : "Fixture instruction",
      deliverables: [{ id: "deliverable-1", kind: row.family }],
      attachment_pointers: ["SOURCE/work-order.pdf"],
      portal_links: portals,
    },
    cycle_facts: {
      trade_report: physical
        ? {
          id: "trade-report-fixture",
          submitted_at: "2026-07-27T01:00:00.000Z",
          checklist_json: {
            works_completed: "Work completed safely.",
            attendance_date: "2026-07-27",
            arrival_time: "08:30",
            crew_name: "Field crew",
            site_contact: "Site representative",
          },
        }
        : null,
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
    resolvePhysicalReportProof: async () => DEFAULT_PHYSICAL_REPORT_PROOF,
    renderPhysicalReport: async () => ({
      file_name: "Make Safe Report - REF-70062.pdf",
      media_type: "application/pdf",
      bytes: new Uint8Array([37, 80, 68, 70, 1]),
      render_hash: DEFAULT_PHYSICAL_REPORT_PROOF.expected_raw_sha256,
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

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function reviewCard(result: {
  review_spec: Record<string, unknown>;
}): Record<string, unknown> {
  const cards = Array.isArray(result.review_spec.cards)
    ? result.review_spec.cards
    : [];
  return object(cards[0]);
}

Deno.test("family matrix is a closed executable set with the AJS report guard", () => {
  assertEquals(SES_EMERGENCY_SERVICE_FAMILIES, [
    "roof",
    "assessment",
    "makesafe",
    "restoration",
  ]);
  // 20 historical rows + 10 repair/restoration (MLB×2, AJS, AJBR, WESTERN each)
  // + 2 synthetic repair/restoration.
  assertEquals(SES_FAMILY_MATRIX.length, 32);
  for (const row of SES_FAMILY_MATRIX) {
    const resolved = resolveSesFamilyMatrixRow({
      builder_key: row.builder_key,
      family: row.family,
      strata: row.family === "own_template_roof",
      own_template_requested: row.family === "own_template_roof",
      site_suburb: row.routing_rule === "mlb-south-west-routing"
        ? "Bunbury"
        : "Perth",
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

Deno.test(
  "persisted physical docket serves curated PDF bytes while review spec preserves raw trade evidence",
  async () => {
    const row = SES_FAMILY_MATRIX.find((candidate) =>
      candidate.builder_key === "AJBR" &&
      candidate.family === "physical_makesafe"
    )!;
    const input = fixtureInput(row);
    input.source.site_address = "Privacy-safe test property";
    input.source.site_suburb = "Test suburb";
    input.cycle_facts.trade_report = {
      id: "immutable-trade-report",
      submitted_at: "2026-08-03T01:00:00.000Z",
      notes: "RAW TRADE NARRATIVE MUST NOT LEAK",
      checklist_json: {
        damage_description: "RAW DAMAGE DESCRIPTION MUST NOT LEAK",
        damage_cause: "RAW DAMAGE CAUSE MUST NOT LEAK",
        work_done: "RAW WORK DONE MUST NOT LEAK",
        materials_used: ["RAW CHECKBOX MATERIAL MUST NOT LEAK"],
        invoice_notes: "RAW INVOICE NOTE MUST NOT LEAK",
        labour_hours: 3,
        trade_count: 2,
      },
    };
    const curatedPdf = new TextEncoder().encode(
      "%PDF-1.4\nCURATED WORKS NARRATIVE\nStar pickets x 20\n%%EOF",
    );
    let recoveryCalls = 0;
    const result = (await prepareSesDocketRevision(
      request(input.identity.job_id, false),
      dependencies(input, {
        resolvePhysicalReportProof: async () => ({
          ...DEFAULT_PHYSICAL_REPORT_PROOF,
          source_identity:
            "docket-revision:tuart-style-revision/artifact:tuart-style-artifact",
          source_revision_id: "tuart-style-revision",
          source_artifact_id: "tuart-style-artifact",
          expected_raw_sha256:
            "sha256:b8cf7717bc535242e7f71dc3c058edfc27e59159038530c461472bbe3c36d156",
          source_artifact_content_hash:
            "sha256:6fba11403c0440435650d4496d07b905df6c4244ed516e931c6c06c7d32a044b",
        }),
        renderPhysicalReport: async () => {
          recoveryCalls++;
          return {
            file_name: "Make Safe Report - REF-70062.pdf",
            media_type: "application/pdf",
            bytes: curatedPdf,
            render_hash:
              "b8cf7717bc535242e7f71dc3c058edfc27e59159038530c461472bbe3c36d156",
            provenance: {
              evidence_source: "current_cycle_curated_makesafe_report",
              report_contract_version:
                "secureworks.makesafe-report/curated-2026-08-03",
            },
          };
        },
      }),
    )).results[0];

    assertEquals(recoveryCalls, 1);
    const reportArtifact = result.artifacts.find((artifact) =>
      artifact.role === "supporting_report_pdf"
    )!;
    assertEquals(reportArtifact.bytes, curatedPdf);
    const servedText = new TextDecoder().decode(reportArtifact.bytes);
    assertStringIncludes(servedText, "CURATED WORKS NARRATIVE");
    assertStringIncludes(servedText, "Star pickets x 20");
    assert(!servedText.includes("RAW "));
    assertEquals(
      reportArtifact.metadata.evidence_source,
      "current_cycle_curated_makesafe_report",
    );
    assertEquals(
      reportArtifact.metadata.source_identity,
      "docket-revision:tuart-style-revision/artifact:tuart-style-artifact",
    );
    assertEquals(
      reportArtifact.metadata.expected_raw_sha256,
      "sha256:b8cf7717bc535242e7f71dc3c058edfc27e59159038530c461472bbe3c36d156",
    );
    assertEquals(
      reportArtifact.metadata.source_artifact_content_hash,
      "sha256:6fba11403c0440435650d4496d07b905df6c4244ed516e931c6c06c7d32a044b",
    );
    assertEquals(result.review_spec.version, SES_DOCKET_REVIEW_SPEC_VERSION);
    const reviewTradeEvidence = object(reviewCard(result).trade_report);
    assertEquals(
      object(reviewTradeEvidence.asserted_written_narrative).work_done,
      "RAW WORK DONE MUST NOT LEAK",
    );
    assertEquals(
      object(reviewTradeEvidence.asserted_written_narrative).notes,
      "RAW TRADE NARRATIVE MUST NOT LEAK",
    );
    assertEquals(
      object(object(reviewTradeEvidence.raw_source_evidence).checklist_json)
        .materials_used,
      ["RAW CHECKBOX MATERIAL MUST NOT LEAK"],
    );
  },
);

Deno.test("persistent physical preparation refuses a raw PDF SHA-256 mismatch before persistence", async () => {
  const row = SES_FAMILY_MATRIX.find((candidate) =>
    candidate.builder_key === "AJBR" &&
    candidate.family === "physical_makesafe"
  )!;
  const input = fixtureInput(row);
  let persistCalls = 0;
  const result = (await prepareSesDocketRevision(
    request(input.identity.job_id, false),
    dependencies(input, {
      resolvePhysicalReportProof: async () => ({
        ...DEFAULT_PHYSICAL_REPORT_PROOF,
        expected_raw_sha256:
          "sha256:9999999999999999999999999999999999999999999999999999999999999999",
      }),
      persist: async () => {
        persistCalls++;
        return { committed_at: FIXED_TIME.toISOString() };
      },
    }),
  )).results[0];

  assertEquals(
    blockerCodes(result).includes("curated_report_hash_mismatch"),
    true,
  );
  assertEquals(
    result.artifacts.some((artifact) =>
      artifact.role === "supporting_report_pdf"
    ),
    false,
  );
  assertEquals(persistCalls, 0);
  assertEquals(result.persisted, false);
});

Deno.test("persistent physical preparation refuses a missing curated source before persistence", async () => {
  const row = SES_FAMILY_MATRIX.find((candidate) =>
    candidate.builder_key === "AJBR" &&
    candidate.family === "physical_makesafe"
  )!;
  const input = fixtureInput(row);
  let persistCalls = 0;
  const result = (await prepareSesDocketRevision(
    request(input.identity.job_id, false),
    dependencies(input, {
      resolvePhysicalReportProof: async () => null,
      persist: async () => {
        persistCalls++;
        return { committed_at: FIXED_TIME.toISOString() };
      },
    }),
  )).results[0];

  assertEquals(blockerCodes(result).includes("curated_source_missing"), true);
  assertEquals(
    result.artifacts.some((artifact) =>
      artifact.role === "supporting_report_pdf"
    ),
    false,
  );
  assertEquals(persistCalls, 0);
  assertEquals(result.persisted, false);
});

Deno.test("persistent physical preparation refuses an artifact content-hash mismatch before persistence", async () => {
  const row = SES_FAMILY_MATRIX.find((candidate) =>
    candidate.builder_key === "AJBR" &&
    candidate.family === "physical_makesafe"
  )!;
  const input = fixtureInput(row);
  let persistCalls = 0;
  const result = (await prepareSesDocketRevision(
    request(input.identity.job_id, false),
    dependencies(input, {
      resolvePhysicalReportProof: async () => ({
        ...DEFAULT_PHYSICAL_REPORT_PROOF,
        source_artifact_content_hash:
          "sha256:9999999999999999999999999999999999999999999999999999999999999999",
      }),
      persist: async () => {
        persistCalls++;
        return { committed_at: FIXED_TIME.toISOString() };
      },
    }),
  )).results[0];

  assertEquals(
    blockerCodes(result).includes("curated_report_hash_mismatch"),
    true,
  );
  assertEquals(
    result.artifacts.some((artifact) =>
      artifact.role === "supporting_report_pdf"
    ),
    false,
  );
  assertEquals(persistCalls, 0);
  assertEquals(result.persisted, false);
});

Deno.test("sweep-only persistence guard never commits a blocked revision while normal prepare semantics remain unchanged", async () => {
  const row = SES_FAMILY_MATRIX.find((candidate) =>
    candidate.builder_key === "AJBR" &&
    candidate.family === "physical_makesafe"
  )!;
  const input = fixtureInput(row);
  input.cycle_facts.hours_and_materials = null;
  let guardedPersistCalls = 0;
  const guarded = (await prepareSesDocketRevision(
    {
      ...request(input.identity.job_id, false),
      require_ready_for_persistence: true,
    },
    dependencies(input, {
      persist: async () => {
        guardedPersistCalls++;
        return { committed_at: FIXED_TIME.toISOString() };
      },
    }),
  )).results[0];
  assertEquals(guarded.state, "blocked");
  assertEquals(guardedPersistCalls, 0);
  assertEquals(guarded.persisted, false);

  let normalPersistCalls = 0;
  const normal = (await prepareSesDocketRevision(
    request(input.identity.job_id, false),
    dependencies(input, {
      persist: async () => {
        normalPersistCalls++;
        return { committed_at: FIXED_TIME.toISOString() };
      },
    }),
  )).results[0];
  assertEquals(normal.state, "blocked");
  assertEquals(normalPersistCalls, 1);
  assertEquals(normal.persisted, true);
});

Deno.test("MLB South-West suburbs select the Bunbury route while Perth stays on the metro route", () => {
  for (const suburb of MLB_SOUTH_WEST_SUBURBS) {
    const resolved = resolveSesFamilyMatrixRow({
      builder_key: "MLB",
      family: "physical_makesafe",
      site_suburb: suburb,
    });
    assert(resolved.ok, suburb);
    assertEquals(resolved.row.routing_rule, "mlb-south-west-routing", suburb);
    assertEquals(resolved.row.invoice_to, "bunbury@mlbuilders.com.au", suburb);
  }
  const perth = resolveSesFamilyMatrixRow({
    builder_key: "MLB",
    family: "physical_makesafe",
    site_suburb: "Perth",
  });
  assert(perth.ok);
  assertEquals(perth.row.routing_rule, "mlb-perth-routing");
  assertEquals(perth.row.invoice_to, "makesafes@mlbuilders.com.au");
});

Deno.test("restoration and repair select the sealed physical labour/materials recipe", async () => {
  for (const family of ["restoration", "repair"] as const) {
    const row = SES_FAMILY_MATRIX.find((candidate) =>
      candidate.builder_key === "MLB" &&
      candidate.family === family &&
      candidate.routing_rule === "mlb-perth-routing"
    )!;
    assertEquals(row.job_type, "physical_makesafe");
    assertEquals(row.report_only, false);
    assertEquals(row.photo_route, "work_order_sender");
    assertEquals(row.required_portal_roles, []);
    assertEquals(row.invoice_basis, "standard_labour_materials");

    // Full fixture evidence → ready pack (recipe is no longer a hard-stop).
    const readyInput = fixtureInput(row);
    readyInput.identity.job_number = family === "restoration"
      ? "SWMS-261134"
      : "SWMS-261029";
    let portalCaptureCalls = 0;
    const ready = (await prepareSesDocketRevision(
      request(readyInput.identity.job_id),
      dependencies(readyInput, {
        capturePortal: async () => {
          portalCaptureCalls++;
          throw new Error(`${family} must not run a portal recipe`);
        },
      }),
    )).results[0];
    assertEquals(ready.state, "ready", family);
    assertEquals(ready.envelope.v2.classification.family, family);
    assertEquals(
      ready.envelope.v2.classification.job_type,
      "physical_makesafe",
    );
    assertEquals(ready.envelope.v2.classification.recipe_selected, true);
    assertEquals(portalCaptureCalls, 0, family);
    assert(
      !blockerCodes(ready).includes("restoration_recipe_unsealed"),
      family,
    );
    assert(!blockerCodes(ready).includes("repair_recipe_unsealed"), family);

    // Missing trade report/photos → physical evidence blockers, not unsealed.
    const thinInput = fixtureInput(row);
    thinInput.cycle_facts.trade_report = null;
    thinInput.cycle_facts.photos = [];
    thinInput.cycle_facts.hours_and_materials = null;
    const thin = (await prepareSesDocketRevision(
      request(thinInput.identity.job_id),
      dependencies(thinInput),
    )).results[0];
    assertEquals(thin.state, "blocked", family);
    assertEquals(thin.envelope.v2.classification.recipe_selected, true, family);
    assert(!blockerCodes(thin).includes("restoration_recipe_unsealed"), family);
    assert(!blockerCodes(thin).includes("repair_recipe_unsealed"), family);

    // A sealed physical-shaped docket carries the recipe version that produced
    // it, the same way an assessment docket carries its own.
    assertEquals(
      ready.envelope.v2.classification.physical_family_recipe_version,
      SES_PHYSICAL_FAMILY_RECIPE_VERSION,
      family,
    );
    assertEquals(
      ready.envelope.v2.classification.assessment_outbound_recipe_version,
      undefined,
      family,
    );
  }
});

// One predicate owns "assembles on the physical labour/materials pack path", so
// the picket EVIDENCE gate in the adapter can never be narrower than the PRICING
// gate here. Pin it against the matrix rows the pricing branch actually reads.
Deno.test("the physical-shaped family set is exactly the AJS labour/materials matrix rows", () => {
  const fromMatrix = new Set(
    SES_FAMILY_MATRIX
      .filter((row) =>
        (row.builder_key === "AJS" || row.builder_key === "AJBR") &&
        row.invoice_basis === "ajs_labour_materials"
      )
      .map((row) => row.family),
  );
  assertEquals(
    [...fromMatrix].sort(),
    [...SES_PHYSICAL_SHAPED_FAMILIES].sort(),
  );
  for (const family of SES_PHYSICAL_SHAPED_FAMILIES) {
    assert(isSesPhysicalShapedFamily(family), family);
  }
  for (
    const family of [
      "temporary_fencing",
      "ordinary_roof_portal",
      "own_template_roof",
      "assessment_quote",
      "unknown",
    ] as const
  ) {
    assert(!isSesPhysicalShapedFamily(family), family);
  }
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
      "repair",
      "restoration",
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
  // Captain 2026-08-04: AJS/AJBR emit combined report+invoice, then photos.
  assertEquals(Object.keys(result.email_drafts).sort(), [
    "PHOTO_EMAIL_DRAFT",
    "REPORT_EMAIL_DRAFT",
  ]);
});

// The two-email route drops INVOICE_EMAIL_DRAFT entirely, so the invoice-bundle
// obligation has to be satisfied from the COMBINED report draft. Without that,
// `draft_invoice_bundle_email` stays blocked at its `recovery-not-run` default
// and every AJS/AJBR card is permanently un-Docs-Ready.
Deno.test("the AJS/AJBR two-email shape reaches pre-Xero Docs Ready without a third draft", async () => {
  for (const builderKey of ["AJS", "AJBR"] as const) {
    const row = SES_FAMILY_MATRIX.find((candidate) =>
      candidate.builder_key === builderKey &&
      candidate.family === "physical_makesafe"
    )!;
    const input = fixtureInput(row);
    const result = (await prepareSesDocketRevision(
      request(input.identity.job_id),
      dependencies(input),
    )).results[0];

    assertEquals(result.state, "ready", builderKey);
    assertEquals(result.envelope.pre_xero_docs_ready, true, builderKey);
    assertEquals(
      result.blockers.map((item) => item.reason_code),
      [],
      builderKey,
    );
    assertEquals(Object.keys(result.email_drafts).sort(), [
      "PHOTO_EMAIL_DRAFT",
      "REPORT_EMAIL_DRAFT",
    ], builderKey);
    assertEquals(
      result.email_drafts.INVOICE_EMAIL_DRAFT,
      undefined,
      builderKey,
    );
    const items = result.envelope.v2.items;
    assertEquals(items.draft_builder_report_email.state, "ready", builderKey);
    assertEquals(items.draft_photo_evidence_email.state, "ready", builderKey);
    assertEquals(items.draft_invoice_bundle_email.state, "ready", builderKey);
    // The invoice-bundle obligation must point at the combined draft it was
    // actually satisfied from, never at a file the route never wrote.
    assertEquals(
      object(items.draft_invoice_bundle_email).evidence,
      "file:DRAFTS/REPORT_EMAIL_DRAFT.txt",
      builderKey,
    );
  }
});

Deno.test("MLB keeps the three-email split and its own invoice-bundle draft", async () => {
  const row = SES_FAMILY_MATRIX.find((candidate) =>
    candidate.builder_key === "MLB" &&
    candidate.family === "physical_makesafe" &&
    candidate.routing_rule === "mlb-perth-routing"
  )!;
  const result = (await prepareSesDocketRevision(
    request(fixtureInput(row).identity.job_id),
    dependencies(fixtureInput(row)),
  )).results[0];
  assertEquals(result.state, "ready");
  assert(result.email_drafts.INVOICE_EMAIL_DRAFT);
  assertEquals(
    object(result.envelope.v2.items.draft_invoice_bundle_email).evidence,
    "file:DRAFTS/INVOICE_EMAIL_DRAFT.txt",
  );
});

Deno.test(
  "MLB ordinary-mail report/photo drafts use exact original WO subject; invoice does not",
  async () => {
    // Inbox grouping only — not real threading. In-process wiring; no Graph.
    const row = SES_FAMILY_MATRIX.find((candidate) =>
      candidate.builder_key === "MLB" &&
      candidate.family === "physical_makesafe" &&
      candidate.routing_rule === "mlb-perth-routing"
    )!;
    const original =
      "NEW WORK ORDER - MLB-26267 U24/ 28 Peninsula Road, Maylands, WA 6051";
    const input = fixtureInput(row);
    input.source.builder_reference = "MLB-26267";
    input.source.intake_email_subject = original;
    input.source.intake_email_subject_source = "emails_subject";
    const result = (await prepareSesDocketRevision(
      request(input.identity.job_id),
      dependencies(input),
    )).results[0];
    assertEquals(result.state, "ready");
    assertEquals(result.envelope.v2.routing.intake_email_subject, original);
    assertEquals(
      result.envelope.v2.routing.intake_email_subject_source,
      "emails_subject",
    );
    assertStringIncludes(
      result.email_drafts.REPORT_EMAIL_DRAFT,
      `Subject: ${original}`,
    );
    assertStringIncludes(
      result.email_drafts.PHOTO_EMAIL_DRAFT,
      `Subject: ${original}`,
    );
    // Invoice keeps the generated billing subject.
    assertStringIncludes(
      result.email_drafts.INVOICE_EMAIL_DRAFT,
      "Subject: MLB-26267 - billing pack",
    );
    assertEquals(
      result.email_drafts.INVOICE_EMAIL_DRAFT.includes(original),
      false,
    );
  },
);

Deno.test(
  "MLB ordinary-mail drafts fall back to generated subject when original WO subject is missing",
  async () => {
    const row = SES_FAMILY_MATRIX.find((candidate) =>
      candidate.builder_key === "MLB" &&
      candidate.family === "physical_makesafe" &&
      candidate.routing_rule === "mlb-perth-routing"
    )!;
    const input = fixtureInput(row);
    input.source.builder_reference = "MLB-26267";
    // No intake_email_subject — must not block prepare.
    const result = (await prepareSesDocketRevision(
      request(input.identity.job_id),
      dependencies(input),
    )).results[0];
    assertEquals(result.state, "ready");
    assertStringIncludes(
      result.email_drafts.REPORT_EMAIL_DRAFT,
      "Subject: MLB-26267 - physical makesafe",
    );
    assertStringIncludes(
      result.email_drafts.PHOTO_EMAIL_DRAFT,
      "Subject: Photo Evidence - MLB-26267",
    );
  },
);

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

Deno.test("typed roof sibling selection is stable and remains write-free", async () => {
  const row = SES_FAMILY_MATRIX.find((candidate) =>
    candidate.family === "ordinary_roof_portal"
  )!;
  const candidates = [
    {
      role: "assessment" as const,
      url: "https://primeeco.tech/share/assessment-candidate",
      source: "job_detail" as const,
    },
    {
      role: "photos" as const,
      url: "https://primeeco.tech/share/photos-candidate",
      source: "job_detail" as const,
    },
    {
      role: "scope" as const,
      url: "https://primeeco.tech/share/scope-candidate",
      source: "job_detail" as const,
    },
    {
      role: "roof_report" as const,
      url: "https://primeeco.tech/share/roof-candidate",
      source: "job_detail" as const,
    },
  ];
  for (const links of [candidates, candidates.slice().reverse()]) {
    const input = fixtureInput(row);
    input.source.portal_links = links;
    const captured: string[] = [];
    const base = dependencies(input);
    const result = (await prepareSesDocketRevision(
      request(input.identity.job_id),
      {
        ...base,
        capturePortal: async (captureRequest) => {
          captured.push(captureRequest.url);
          return await base.capturePortal!(captureRequest);
        },
      },
    )).results[0];
    assertEquals(captured, ["https://primeeco.tech/share/roof-candidate"]);
    assertEquals(
      blockerCodes(result).includes("portal_wrong_reference"),
      false,
    );
    assertEquals(result.persisted, false);
  }
});

Deno.test("incomplete sibling correlation stays blocked before portal capture", async () => {
  const row = SES_FAMILY_MATRIX.find((candidate) =>
    candidate.family === "ordinary_roof_portal"
  )!;
  const input = fixtureInput(row);
  input.identity.source_instruction_id = "";
  input.identity.lineage_id = "";
  input.source.builder_reference = "";
  input.source.portal_links = [
    {
      role: "assessment",
      url: "https://primeeco.tech/share/assessment-candidate",
      source: "job_detail",
    },
    {
      role: "photos",
      url: "https://primeeco.tech/share/photos-candidate",
      source: "job_detail",
    },
    {
      role: "scope",
      url: "https://primeeco.tech/share/scope-candidate",
      source: "job_detail",
    },
    {
      role: "roof_report",
      url: "https://primeeco.tech/share/roof-candidate",
      source: "job_detail",
    },
  ];
  let captureCalls = 0;
  const result = (await prepareSesDocketRevision(
    request(input.identity.job_id),
    dependencies(input, {
      capturePortal: async () => {
        captureCalls++;
        throw new Error("incomplete correlation must not choose a candidate");
      },
    }),
  )).results[0];
  const blocker = result.blockers.find((item) =>
    item.reason_code === "portal_wrong_reference"
  );
  assert(blocker);
  assertStringIncludes(blocker.reason, "correlation spine is incomplete");
  assertEquals(captureCalls, 0);
  assertEquals(result.portal_evidence, []);
  assertEquals(result.persisted, false);
});

Deno.test("equally credible roof siblings stay blocked with order-stable detail", async () => {
  const row = SES_FAMILY_MATRIX.find((candidate) =>
    candidate.family === "ordinary_roof_portal"
  )!;
  const candidates = [
    {
      role: "roof_report" as const,
      url: "https://primeeco.tech/share/roof-candidate-b",
      source: "job_detail" as const,
    },
    {
      role: "roof_report" as const,
      url: "https://primeeco.tech/share/roof-candidate-a",
      source: "job_detail" as const,
    },
  ];
  const rejectionSets: string[][] = [];
  for (const links of [candidates, candidates.slice().reverse()]) {
    const input = fixtureInput(row);
    input.source.portal_links = links;
    let captureCalls = 0;
    const result = (await prepareSesDocketRevision(
      request(input.identity.job_id),
      dependencies(input, {
        capturePortal: async () => {
          captureCalls++;
          throw new Error("tied candidates must not be captured");
        },
      }),
    )).results[0];
    const blocker = result.blockers.find((item) =>
      item.reason_code === "portal_wrong_reference"
    );
    assert(blocker);
    rejectionSets.push(blocker.rejected_candidates);
    assertEquals(captureCalls, 0);
    assertEquals(result.portal_evidence, []);
    assertEquals(result.persisted, false);
  }
  assertEquals(rejectionSets[0], [
    "https://primeeco.tech/share/roof-candidate-a",
    "https://primeeco.tech/share/roof-candidate-b",
  ]);
  assertEquals(rejectionSets[1], rejectionSets[0]);
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
    false,
  );
  assertStringIncludes(
    result.email_drafts.INVOICE_EMAIL_DRAFT,
    "Attachments: ",
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
      resolvePhysicalReportProof: async () => null,
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
  input.cycle_facts.swms_fact_context = {
    evidence_kind: "sibling_bundle",
    evidence_job_id: "02f614a4-09a7-422e-9381-c89a44aceccd",
    evidence_job_number: "SWMS-26837",
    trade_report: {
      id: "trade-report-26837",
      submitted_at: "2026-07-20T06:35:00.000Z",
      checklist_json: {
        works_completed:
          "Stacked displaced Hardie panels safely and isolated the area.",
        arrival_time: "14:05",
      },
    },
    job_client_name: "Sibling site contact",
    assignment: {
      id: "assignment-26837",
      crew_name: "Sibling field crew",
      assigned_user_name: null,
      scheduled_date: "2026-07-20",
      arrived_at: "2026-07-20T14:05:00.000Z",
    },
  };
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
      resolveBundledPhysicalReportProof: async () =>
        DEFAULT_PHYSICAL_REPORT_PROOF,
      renderBundledPhysicalReport: async () => ({
        file_name: "SWMS-26837 Make Safe Report.pdf",
        media_type: "application/pdf",
        bytes: new Uint8Array([37, 80, 68, 70, 1]),
        render_hash: DEFAULT_PHYSICAL_REPORT_PROOF.expected_raw_sha256,
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
  const swmsPlan = result.artifacts.find((artifact) =>
    artifact.role === "swms_generation_plan"
  );
  assertEquals(swmsPlan?.metadata?.evidence_job_number, "SWMS-26837");
  assertEquals(swmsPlan?.metadata?.evidence_kind, "sibling_bundle");
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
    result.email_drafts.INVOICE_EMAIL_DRAFT.includes("invoice_proposal.json"),
    false,
  );
  assertStringIncludes(
    result.email_drafts.INVOICE_EMAIL_DRAFT,
    "no invoice is attached",
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
  const fenceBlocker = missingFenceResult.blockers.find((blocker) =>
    blocker.reason_code === "pricing_evidence_missing"
  )!;
  assertStringIncludes(fenceBlocker.reason.toLowerCase(), "fence-only");
  assert(!fenceBlocker.reason.includes("fence_only"));
  assert(!fenceBlocker.recovery_action.includes("fence_only"));

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
    // WESTERN is not an MLB physical card: the intake-thread coordinates are
    // always emitted and must stay empty here (no thread reply, no recovery).
    intake_thread_id: "",
    intake_post_id: "",
    intake_conversation_id: "",
    intake_email_subject: "",
    intake_email_subject_source: "",
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
  const blocker = response.results[0].blockers.find((item) =>
    item.reason_code === "pricing_evidence_missing"
  )!;
  assertStringIncludes(blocker.reason.toLowerCase(), "panels");
  assertStringIncludes(blocker.reason.toLowerCase(), "bases");
  assert(!blocker.reason.includes("panel_count"));
  assert(!blocker.reason.includes("base_count"));
  assert(!blocker.recovery_action.includes("panel_count"));
  assert(!blocker.recovery_action.includes("base_count"));
});

Deno.test("labour pricing blocks on missing field-report labour facts without naming storage fields", async () => {
  const row = SES_FAMILY_MATRIX.find((candidate) =>
    candidate.builder_key === "AJS" &&
    candidate.family === "physical_makesafe"
  )!;
  const input = fixtureInput(row);
  input.cycle_facts.hours_and_materials = {
    trades: 2,
  };
  const result = (await prepareSesDocketRevision(
    request(input.identity.job_id),
    dependencies(input),
  )).results[0];
  const blocker = result.blockers.find((item) =>
    item.reason_code === "pricing_evidence_missing"
  )!;
  // The missing fact is the trade's ATTENDED hours (the cost fact). Billable hours are never
  // recovered from the field report - they come from the sealed schedule - so the blocker must
  // not ask staff for them.
  assertStringIncludes(blocker.reason.toLowerCase(), "attended hours");
  assertStringIncludes(blocker.recovery_action.toLowerCase(), "field report");
  assert(!blocker.reason.toLowerCase().includes("billable hours"));
  assert(!blocker.reason.includes("hours_per_trade"));
  assert(!blocker.recovery_action.includes("hours_per_trade"));
  assert(!blocker.reason.includes("labour_hours"));
  assert(!blocker.recovery_action.includes("labour_hours"));
});

// Two hours in, three hours out (Captain ruling 2026-08-02). The trade bills us 2, we bill the
// builder the 3-hour MLB minimum. A short attendance is exactly the case the minimum exists for,
// so it must price, not block.
async function labourProposal(
  builderKey: string,
  family: string,
  hoursAndMaterials: Record<string, unknown>,
) {
  const row = SES_FAMILY_MATRIX.find((candidate) =>
    candidate.builder_key === builderKey && candidate.family === family
  )!;
  const input = fixtureInput(row);
  input.cycle_facts.hours_and_materials = hoursAndMaterials;
  const result = (await prepareSesDocketRevision(
    request(input.identity.job_id),
    dependencies(input),
  )).results[0];
  return result;
}

Deno.test("a two-hour MLB trade report prices at the sealed three-hour floor instead of blocking", async () => {
  const result = await labourProposal("MLB", "physical_makesafe", {
    trades: 2,
    hours_per_trade: 2,
    rate_ex_gst: 85,
    materials: [],
  });
  assertEquals(
    result.blockers.filter((item) =>
      item.reason_code === "pricing_evidence_missing"
    ),
    [],
  );
  const proposal = result.invoice_proposal as Record<string, unknown>;
  assert(proposal, "expected an invoice proposal for a two-hour MLB report");
  // The trade's cost fact survives verbatim beside the billable revenue fact.
  assertEquals(proposal.reported_hours_per_trade, 2);
  assertEquals(proposal.billable_hours_per_trade, 3);
  assertEquals(proposal.billable_hours_floor, 3);
  assertEquals(proposal.billable_hours_raised_to_floor, true);
  const lines = proposal.line_items as Array<Record<string, unknown>>;
  // The line the money guard parses must state the BILLABLE hours and quantity: 2 x 3 = 6.
  assertStringIncludes(String(lines[0].description), "2 trades x 3 hours");
  assertEquals(lines[0].quantity, 6);
  assertEquals(lines[0].unit_price_ex_gst ?? lines[0].unit_price, 85);
  assertEquals(proposal.subtotal_ex_gst, 510);
});

Deno.test("Bertram AJS existing-fence pickets price through the sealed docket proposal", async () => {
  const result = await labourProposal("AJS", "physical_makesafe", {
    trades: 2,
    hours_per_trade: 3,
    existing_fence_star_picket_count: 20,
    existing_fence_star_picket_evidence: {
      source: "job_service_reports.checklist_json.materials_used",
      report_id: "bertram-trade-report",
    },
  });
  assertEquals(
    result.blockers.filter((item) =>
      item.reason_code === "pricing_evidence_missing"
    ),
    [],
  );
  assertEquals(result.state, "ready");
  assertEquals(result.blockers.map((item) => item.reason_code), []);
  // AJBR uses the combined report+invoice draft (Captain 2026-08-04).
  assertEquals(Object.keys(result.email_drafts).sort(), [
    "PHOTO_EMAIL_DRAFT",
    "REPORT_EMAIL_DRAFT",
  ]);
  const proposal = result.invoice_proposal as Record<string, unknown>;
  const lines = proposal.line_items as Array<Record<string, unknown>>;
  assertEquals(lines.length, 2);
  assertEquals(lines[0].quantity, 6);
  assertEquals(lines[0].unit_price_ex_gst, 80);
  assertStringIncludes(String(lines[1].description), "existing fence");
  assertStringIncludes(String(lines[1].description), "Star pickets");
  assertEquals(lines[1].quantity, 20);
  assertEquals(lines[1].unit_price_ex_gst, 13.5);
  assertEquals(proposal.subtotal_ex_gst, 750);
  assertEquals(proposal.gst, 75);
  assertEquals(proposal.total_inc_gst, 825);
});

// The invoice lines are copied VERBATIM into the Xero DRAFT, so a sealed repair
// or restoration card must not tell the builder it was billed for a make-safe.
Deno.test("sealed repair and restoration invoice lines name their own family", async () => {
  for (
    const [family, expected] of [
      ["repair", "repair attendance"],
      ["restoration", "restoration attendance"],
    ] as const
  ) {
    const result = await labourProposal("MLB", family, {
      trades: 2,
      hours_per_trade: 3,
      rate_ex_gst: 85,
      materials: [],
    });
    const proposal = result.invoice_proposal as Record<string, unknown>;
    assert(proposal, `expected a ${family} invoice proposal`);
    const description = String(
      (proposal.line_items as Array<Record<string, unknown>>)[0].description,
    );
    assertStringIncludes(description, expected);
    assert(
      !description.toLowerCase().includes("make-safe"),
      `${family} invoice line must not describe the work as a make-safe: ${description}`,
    );
  }
});

// The AJS existing-fence carve-out follows the PACK PATH, not one family name.
// Repair and restoration assemble on the same physical labour/materials row, so
// omitting the picket line for them would silently under-bill the builder.
Deno.test("AJS/AJBR repair and restoration price the existing-fence pickets like any physical card", async () => {
  for (const builderKey of ["AJS", "AJBR"] as const) {
    for (const family of ["repair", "restoration"] as const) {
      const label = `${builderKey}/${family}`;
      const result = await labourProposal(builderKey, family, {
        trades: 2,
        hours_per_trade: 3,
        existing_fence_star_picket_count: 20,
        existing_fence_star_picket_evidence: {
          source: "job_service_reports.checklist_json.materials_used",
          report_id: "fixture-trade-report",
        },
      });
      assertEquals(
        result.blockers.map((item) => item.reason_code),
        [],
        label,
      );
      const proposal = result.invoice_proposal as Record<string, unknown>;
      const lines = proposal.line_items as Array<Record<string, unknown>>;
      assertEquals(lines.length, 2, label);
      assertStringIncludes(String(lines[1].description), "Star pickets");
      assertEquals(lines[1].quantity, 20, label);
      assertEquals(lines[1].unit_price_ex_gst, 13.5, label);
      assertEquals(proposal.subtotal_ex_gst, 750, label);

      // The refusal side of the carve-out must reach them too.
      const refused = await labourProposal(builderKey, family, {
        trades: 2,
        hours_per_trade: 3,
        existing_fence_star_picket_refusal: "genuine_temporary_fence_signal",
      });
      assertEquals(refused.invoice_proposal, null, label);
      assertStringIncludes(
        refused.blockers.find((item) =>
          item.reason_code === "pricing_evidence_missing"
        )!.reason,
        "temporary-fence kit",
      );
    }
  }
});

Deno.test("a genuine AJS temporary-fence kit stays hard-refused", async () => {
  const result = await labourProposal("AJS", "physical_makesafe", {
    trades: 2,
    hours_per_trade: 3,
    existing_fence_star_picket_refusal: "genuine_temporary_fence_signal",
  });
  assertEquals(result.invoice_proposal, null);
  const blocker = result.blockers.find((item) =>
    item.reason_code === "pricing_evidence_missing"
  )!;
  assertStringIncludes(blocker.reason, "temporary-fence kit");
});

Deno.test("generic material facts cannot bypass the AJS picket evidence gate", async () => {
  const unsupported = await labourProposal("AJS", "physical_makesafe", {
    trades: 2,
    hours_per_trade: 3,
    materials: [{
      description: "Star pickets",
      quantity: 20,
      unit_price_ex_gst: 13.5,
    }],
  });
  assertEquals(unsupported.invoice_proposal, null);
  assertStringIncludes(
    unsupported.blockers.find((item) =>
      item.reason_code === "pricing_evidence_missing"
    )!.reason,
    "cannot bypass",
  );

  const canonical = await labourProposal("AJS", "physical_makesafe", {
    trades: 2,
    hours_per_trade: 3,
    existing_fence_star_picket_count: 20,
    materials: [{
      description: "Star pickets",
      quantity: 20,
      unit_price_ex_gst: 13.5,
    }],
  });
  const proposal = canonical.invoice_proposal as Record<string, unknown>;
  assertEquals(
    (proposal.line_items as Array<Record<string, unknown>>).length,
    2,
  );
  assertEquals(proposal.subtotal_ex_gst, 750);
});

Deno.test("the old AJS consumables refusal cannot pass through typed materials", async () => {
  for (
    const description of [
      "Cable ties",
      "Fence clips",
      "Fixings",
      "Small consumables",
    ]
  ) {
    const result = await labourProposal("AJBR", "physical_makesafe", {
      trades: 2,
      hours_per_trade: 3,
      materials: [{ description, quantity: 1, unit_price_ex_gst: 25 }],
    });
    assertEquals(result.invoice_proposal, null, description);
    assertStringIncludes(
      result.blockers.find((item) =>
        item.reason_code === "pricing_evidence_missing"
      )!.reason,
      "remain non-billable",
    );
  }
});

Deno.test("a longer attendance is never reduced to the floor", async () => {
  const result = await labourProposal("MLB", "physical_makesafe", {
    trades: 1,
    hours_per_trade: 5.5,
    rate_ex_gst: 85,
    materials: [],
  });
  const proposal = result.invoice_proposal as Record<string, unknown>;
  assertEquals(proposal.reported_hours_per_trade, 5.5);
  assertEquals(proposal.billable_hours_per_trade, 5.5);
  assertEquals(proposal.billable_hours_raised_to_floor, false);
  const lines = proposal.line_items as Array<Record<string, unknown>>;
  assertStringIncludes(String(lines[0].description), "1 trade x 5.5 hours");
  assertEquals(lines[0].quantity, 5.5);
});

Deno.test("the sealed floor still binds: no proposal can leave below its company minimum", async () => {
  for (
    const [builderKey, family, reported, floor] of [
      ["MLB", "physical_makesafe", 0.25, 3],
      ["MLB", "physical_makesafe", 2, 3],
      ["AJS", "physical_makesafe", 1, 2],
      ["MLB", "temporary_fencing", 1, 4],
    ] as Array<[string, string, number, number]>
  ) {
    const result = await labourProposal(builderKey, family, {
      trades: 1,
      hours_per_trade: reported,
      panel_count: 8,
      base_count: 8,
      star_picket_count: 0,
      materials: [],
    });
    const proposal = result.invoice_proposal as Record<string, unknown>;
    assert(
      proposal,
      `${builderKey}/${family} at ${reported}h produced no proposal`,
    );
    assertEquals(
      proposal.billable_hours_floor,
      floor,
      `${builderKey}/${family} floor`,
    );
    assertEquals(
      proposal.billable_hours_per_trade,
      floor,
      `${builderKey}/${family} billable hours must sit on the floor`,
    );
    assert(
      (proposal.billable_hours_per_trade as number) >= floor,
      "a proposal must never leave below the sealed floor",
    );
  }
});

Deno.test("absent attended hours still block: the floor is not a substitute for evidence", async () => {
  const result = await labourProposal("MLB", "physical_makesafe", {
    trades: 2,
    rate_ex_gst: 85,
    materials: [],
  });
  const blocker = result.blockers.find((item) =>
    item.reason_code === "pricing_evidence_missing"
  )!;
  assert(blocker, "missing attended hours must still block");
  assertEquals(result.invoice_proposal ?? null, null);
});

Deno.test("a non-positive attended-hours fact blocks rather than silently becoming the floor", async () => {
  for (const bad of [0, -2, "two", null]) {
    const result = await labourProposal("MLB", "physical_makesafe", {
      trades: 1,
      hours_per_trade: bad,
      rate_ex_gst: 85,
      materials: [],
    });
    assert(
      result.blockers.some((item) =>
        item.reason_code === "pricing_evidence_missing"
      ),
      `hours_per_trade=${JSON.stringify(bad)} must block`,
    );
    assertEquals(result.invoice_proposal ?? null, null);
  }
});

Deno.test("raising cost hours to the floor does not touch the rate check", async () => {
  const result = await labourProposal("MLB", "physical_makesafe", {
    trades: 1,
    hours_per_trade: 2,
    rate_ex_gst: 70,
    materials: [],
  });
  const blocker = result.blockers.find((item) =>
    item.reason_code === "pricing_evidence_missing"
  )!;
  assert(blocker, "an off-schedule rate must still block");
  assertStringIncludes(blocker.reason, "85");
});

Deno.test("hire-card pricing blocks on a missing star-picket fact without naming its storage field", async () => {
  const row = SES_FAMILY_MATRIX.find((candidate) =>
    candidate.builder_key === "MLB" &&
    candidate.family === "temporary_fencing" &&
    candidate.routing_rule === "mlb-perth-routing"
  )!;
  const input = fixtureInput(row);
  input.cycle_facts.hours_and_materials = {
    trades: 1,
    hours_per_trade: 4,
    panel_count: 8,
    base_count: 8,
  };
  const result = (await prepareSesDocketRevision(
    request(input.identity.job_id),
    dependencies(input),
  )).results[0];
  const blocker = result.blockers.find((item) =>
    item.reason_code === "pricing_evidence_missing"
  )!;
  assertStringIncludes(blocker.reason.toLowerCase(), "star pickets");
  assertStringIncludes(blocker.recovery_action.toLowerCase(), "work order");
  assert(!blocker.reason.includes("star_picket_count"));
  assert(!blocker.recovery_action.includes("star_picket_count"));
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
      arrival_time: "08:30",
    },
  };
  input.cycle_facts.swms_fact_context = {
    evidence_kind: "current_card",
    evidence_job_id: input.identity.job_id,
    evidence_job_number: input.identity.job_number,
    trade_report: null,
    job_client_name: "Site representative",
    assignment: {
      id: "assignment-70062",
      crew_name: "Field crew",
      assigned_user_name: null,
      scheduled_date: "2026-07-27",
      arrived_at: "2026-07-27T08:30:00.000Z",
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
        assertEquals(plan.provenance.evidence_kind, "current_card");
        assertEquals(
          plan.provenance.job_fact_sources.site_contact,
          "jobs.client_name",
        );
        assertEquals(
          plan.provenance.job_fact_sources.crew,
          "job_assignments.crew_name",
        );
        assertEquals(
          plan.provenance.job_fact_sources.works_date,
          "job_assignments.scheduled_date",
        );
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

// The board resolves crew via assignments[].users.name (index.ts makesafeCrew). U4 read only
// crew_name, so a job whose crew is recorded solely as an assigned user looked crewless to the
// SWMS generator while the board displayed the name. These two tests pin both halves: the fourth
// source resolves, and a job with genuinely no crew anywhere still blocks.
function mlbPhysicalRow() {
  return SES_FAMILY_MATRIX.find((candidate) =>
    candidate.builder_key === "MLB" &&
    candidate.family === "physical_makesafe" &&
    candidate.routing_rule === "mlb-perth-routing"
  )!;
}

function inputWithCrewOnlyOnTheAssignedUser(assignedUserName: string | null) {
  const input = fixtureInput(mlbPhysicalRow());
  input.cycle_facts.trade_report = {
    id: "trade-report-crew-source",
    submitted_at: "2026-07-27T01:00:00.000Z",
    checklist_json: {
      works_completed: "Made the storm damaged area safe.",
      attendance_date: "2026-07-27",
      arrival_time: "08:30",
      site_contact: "Site representative",
      // deliberately NO crew_name and NO crew
    },
  };
  input.cycle_facts.swms_fact_context = {
    evidence_kind: "current_card",
    evidence_job_id: input.identity.job_id,
    evidence_job_number: input.identity.job_number,
    trade_report: {
      works_completed: "Made the storm damaged area safe.",
      attendance_date: "2026-07-27",
      arrival_time: "08:30",
      site_contact: "Site representative",
    },
    job_client_name: "Site representative",
    assignment: {
      id: "assignment-1",
      crew_name: null,
      assigned_user_name: assignedUserName,
      scheduled_date: "2026-07-27",
      arrived_at: null,
    },
  };
  return input;
}

Deno.test("crew resolves from the user joined to the assignment when crew_name is absent", async () => {
  const input = inputWithCrewOnlyOnTheAssignedUser("Recorded Attendee");
  const result = (await prepareSesDocketRevision(
    request(input.identity.job_id),
    dependencies(input),
  )).results[0];
  assertEquals(
    result.blockers.filter((item) =>
      item.reason_code === "swms_generation_facts_missing"
    ),
    [],
    "the crew is recorded on the assignment's user record, so SWMS must not block",
  );
});

Deno.test("control: a job with no crew in any source still blocks", async () => {
  // Same shape, but nothing anywhere holds a crew. The fourth source must be a fourth PLACE TO
  // LOOK, never a fallback that invents an answer.
  for (const emptyValue of [null, "", "   "]) {
    const input = inputWithCrewOnlyOnTheAssignedUser(
      emptyValue as string | null,
    );
    const result = (await prepareSesDocketRevision(
      request(input.identity.job_id),
      dependencies(input),
    )).results[0];
    const blocker = result.blockers.find((item) =>
      item.reason_code === "swms_generation_facts_missing"
    );
    assert(
      blocker,
      `assigned_user_name=${JSON.stringify(emptyValue)} must still block`,
    );
    assertStringIncludes(blocker!.reason.toLowerCase(), "crew");
    assert(
      !blocker!.reason.includes("assigned_user_name"),
      "the blocker must not leak an internal field name",
    );
  }
});

Deno.test("an explicit crew_name still wins over the assigned user", async () => {
  // The fourth source is last in precedence: it never overrides a crew the trade actually recorded.
  const input = inputWithCrewOnlyOnTheAssignedUser("Assigned User");
  input.cycle_facts.swms_fact_context!.assignment!.crew_name = "Recorded Crew";
  const result = (await prepareSesDocketRevision(
    request(input.identity.job_id),
    dependencies(input),
  )).results[0];
  assertEquals(
    result.blockers.filter((item) =>
      item.reason_code === "swms_generation_facts_missing"
    ),
    [],
  );
});

Deno.test("SWMS blocks only on genuinely absent real-world facts and never exposes internal field names", async () => {
  const row = SES_FAMILY_MATRIX.find((candidate) =>
    candidate.builder_key === "MLB" &&
    candidate.family === "physical_makesafe" &&
    candidate.routing_rule === "mlb-perth-routing"
  )!;
  const input = fixtureInput(row);
  input.cycle_facts.trade_report = {
    id: "trade-report-missing-facts",
    submitted_at: null,
    checklist_json: {
      works_completed: "Installed temporary fencing and made the area safe.",
    },
  };
  input.cycle_facts.swms_fact_context = {
    evidence_kind: "current_card",
    evidence_job_id: input.identity.job_id,
    evidence_job_number: input.identity.job_number,
    trade_report: null,
    job_client_name: null,
    assignment: null,
  };
  const result = (await prepareSesDocketRevision(
    request(input.identity.job_id),
    dependencies(input),
  )).results[0];
  const blocker = result.blockers.find((item) =>
    item.reason_code === "swms_generation_facts_missing"
  )!;
  assertStringIncludes(blocker.reason.toLowerCase(), "crew");
  assertStringIncludes(blocker.reason.toLowerCase(), "site contact");
  assertStringIncludes(blocker.reason.toLowerCase(), "arrival time");
  assertStringIncludes(blocker.reason.toLowerCase(), "works date");
  assertStringIncludes(
    blocker.reason.toLowerCase(),
    "trade report submission time",
  );
  assert(!blocker.reason.includes("works_date"));
  assert(!blocker.reason.includes("site_contact"));
  assert(!blocker.recovery_action.includes("trade-report facts"));
});

Deno.test("roof pricing blocks only when the work order states no storey classification", async () => {
  const row = SES_FAMILY_MATRIX.find((candidate) =>
    candidate.builder_key === "MLB" &&
    candidate.family === "ordinary_roof_portal" &&
    candidate.routing_rule === "mlb-perth-routing"
  )!;
  const input = fixtureInput(row);
  input.cycle_facts.hours_and_materials = {};
  const result = (await prepareSesDocketRevision(
    request(input.identity.job_id),
    dependencies(input),
  )).results[0];
  const blocker = result.blockers.find((item) =>
    item.reason_code === "pricing_evidence_missing"
  )!;
  assertStringIncludes(blocker.reason.toLowerCase(), "single/double storey");
  assert(!blocker.reason.includes("storeys"));
  assert(!blocker.recovery_action.includes("storeys"));
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

Deno.test("review spec v2 carries provenance-bound written trade context while preserving noisy raw selections", async () => {
  const row = SES_FAMILY_MATRIX.find((candidate) =>
    candidate.builder_key === "AJS" &&
    candidate.family === "physical_makesafe"
  )!;
  const input = fixtureInput(row);
  input.identity.job_id = "job-bertram-pattern";
  input.identity.job_number = "SWMS-261109";
  input.source.builder_reference = "AJBR-70271";
  input.source.site_address = null;
  input.source.site_suburb = "Bertram";
  input.attendance.attendance_cycle_ids = ["cycle-current"];
  input.attendance.current_attendance_cycle_id = "cycle-current";
  input.attendance.cycle_number = 2;
  const noisySelections = [
    { key: "tarp", selected: true },
    { key: "timber", selected: true },
    { key: "roof_screws", selected: true },
    { key: "silicone", selected: true },
  ];
  input.cycle_facts.trade_report = {
    id: "report-current",
    status: "submitted",
    submitted_at: "2026-08-03T00:30:00.000Z",
    checklist_json: {
      works_completed:
        "Installed temporary weather protection and secured the affected area.",
      findings: "Temporary protection was required at the affected section.",
      damage_description: "The exposed section required weather protection.",
      damage_cause: "Storm impact.",
      materials: noisySelections,
      materials_used: "One weatherproof sheet and fixings were installed.",
    },
    notes: "Area was left weatherproof and safe for follow-up.",
  };
  input.cycle_facts.hours_and_materials = {
    trades: 1,
    hours_per_trade: 2,
    rate_ex_gst: 80,
    materials: noisySelections,
  };

  const result = (await prepareSesDocketRevision(
    request(input.identity.job_id),
    dependencies(input),
  )).results[0];
  const card = reviewCard(result);
  const tradeReport = object(card.trade_report);
  const source = object(tradeReport.source);
  const narrative = object(tradeReport.asserted_written_narrative);
  const raw = object(tradeReport.raw_source_evidence);
  const rawChecklist = object(raw.checklist_json);

  assertEquals(result.review_spec.version, SES_DOCKET_REVIEW_SPEC_VERSION);
  assertEquals(source, {
    relation: "job_service_reports",
    id: "report-current",
    status: "submitted",
    submitted_at: "2026-08-03T00:30:00.000Z",
    job_id: "job-bertram-pattern",
    attendance_cycle_id: "cycle-current",
    cycle_number: 2,
    selection: "current_attendance_cycle",
  });
  assertEquals(
    narrative.works_completed,
    "Installed temporary weather protection and secured the affected area.",
  );
  assertEquals(
    narrative.materials_used,
    "One weatherproof sheet and fixings were installed.",
  );
  assertEquals(
    narrative.notes,
    "Area was left weatherproof and safe for follow-up.",
  );
  assertEquals(
    narrative.materials,
    null,
    "structured checklist selections are source evidence, not asserted prose",
  );
  assertEquals(rawChecklist.materials, noisySelections);
  assertEquals(
    object(raw.checklist_json).materials_used,
    "One weatherproof sheet and fixings were installed.",
  );
  assert(
    result.blockers.some((item) =>
      item.reason_code === "pricing_evidence_missing"
    ),
    "the existing pricing contradiction remains blocking",
  );
  assert(
    Array.isArray(card.blocker_codes) &&
      card.blocker_codes.includes("pricing_evidence_missing"),
    "reviewers still see the genuine blocker beside the added narrative",
  );
  assertEquals(result.invoice_proposal, null);
});

Deno.test("review spec keeps a missing current report null and never borrows sibling narrative", async () => {
  const row = SES_FAMILY_MATRIX.find((candidate) =>
    candidate.builder_key === "AJS" &&
    candidate.family === "physical_makesafe"
  )!;
  const input = fixtureInput(row);
  input.cycle_facts.trade_report = null;
  input.cycle_facts.swms_fact_context = {
    evidence_kind: "sibling_bundle",
    evidence_job_id: "job-sibling",
    evidence_job_number: "SWMS-SIBLING",
    trade_report: {
      id: "report-sibling",
      status: "submitted",
      submitted_at: "2026-08-02T00:30:00.000Z",
      checklist_json: {
        works_completed: "Sibling narrative must not bind to this card.",
      },
      notes: null,
    },
    job_client_name: null,
    assignment: null,
  };

  const result = (await prepareSesDocketRevision(
    request(input.identity.job_id),
    dependencies(input),
  )).results[0];

  assertEquals(result.review_spec.version, SES_DOCKET_REVIEW_SPEC_VERSION);
  assertEquals(reviewCard(result).trade_report, null);
  assert(
    result.blockers.some((item) =>
      item.reason_code === "trade_evidence_missing"
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

Deno.test("written trade content deterministically invalidates the review artifact and output hash", async () => {
  const row = SES_FAMILY_MATRIX.find((candidate) =>
    candidate.builder_key === "AJS" &&
    candidate.family === "physical_makesafe"
  )!;
  const beforeInput = fixtureInput(row);
  const afterInput = structuredClone(beforeInput);
  object(afterInput.cycle_facts.trade_report?.checklist_json).works_completed =
    "Installed a different temporary weather protection method.";

  const before = (await prepareSesDocketRevision(
    request(beforeInput.identity.job_id),
    dependencies(beforeInput),
  )).results[0];
  const after = (await prepareSesDocketRevision(
    request(afterInput.identity.job_id),
    dependencies(afterInput),
  )).results[0];
  const reviewHash = (result: typeof before) =>
    result.artifacts.find((artifact) => artifact.role === "review_spec")
      ?.content_hash;

  assert(reviewHash(before));
  assert(reviewHash(after));
  assert(
    reviewHash(before) !== reviewHash(after),
    "written report changes must change review_spec.json bytes",
  );
  assert(
    before.output_content_hash !== after.output_content_hash,
    "written report changes must invalidate the assembled output hash",
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
  // AJS combined report+invoice draft carries the no-Xero-invoice language.
  assertStringIncludes(
    response.results[0].email_drafts.REPORT_EMAIL_DRAFT,
    "The real Xero invoice PDF attaches when authorised",
  );
  assertEquals(
    response.results[0].email_drafts.INVOICE_EMAIL_DRAFT,
    undefined,
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

// Photo-mail volume guard at PREPARE: a pack that cannot fit one Graph message
// must block the docket before it can claim Docs Ready, and it must never be
// shortened. Wiring lives in `prepareOne`; the pure guard is proved separately
// in ses_photo_mail_volume_guard_test.ts.
function photoHeavyInput(
  row: SesFamilyMatrixRow,
  count: number,
): SesAssemblerInputV1 {
  const input = fixtureInput(row);
  input.cycle_facts.photos = Array.from({ length: count }, (_, index) => ({
    id: `photo-${index + 1}`,
    path_or_key: `ARTIFACTS/photos/${String(index + 1).padStart(2, "0")}.jpg`,
    caption: `Completed barrier ${index + 1}`,
    order: index + 1,
  }));
  return input;
}

function photoBytesDependencies(
  _input: SesAssemblerInputV1,
  sizeBytes: number,
  persistCalls: { count: number },
): Partial<SesPrepareDependencies> {
  return {
    resolvePhotoArtifacts: async (resolvedInput) =>
      resolvedInput.cycle_facts.photos.map((photo, index) => {
        const bytes = new Uint8Array(sizeBytes);
        bytes[0] = 255;
        bytes[1] = 216;
        bytes[2] = 255;
        bytes[3] = index;
        return {
          photo_id: photo.id,
          source_pointer: photo.path_or_key,
          file_name: `${String(index + 1).padStart(3, "0")}.jpg`,
          media_type: "image/jpeg" as const,
          bytes,
        };
      }),
    persist: async () => {
      persistCalls.count++;
      return { committed_at: FIXED_TIME.toISOString() };
    },
  };
}

Deno.test("prepare blocks an AJS photo pack over the Exchange message ceiling and never trims it", async () => {
  const row = SES_FAMILY_MATRIX.find((candidate) =>
    candidate.builder_key === "AJS" &&
    candidate.family === "physical_makesafe"
  )!;
  const input = photoHeavyInput(row, 2);
  const persistCalls = { count: 0 };
  const result = (await prepareSesDocketRevision(
    request(input.identity.job_id, false),
    dependencies(
      input,
      photoBytesDependencies(input, 18 * 1024 * 1024, persistCalls),
    ),
  )).results[0];

  const blocker = result.blockers.find((item) =>
    item.reason_code === "photo_mail_volume_exceeds_graph_limit"
  )!;
  assert(blocker, "expected the named photo-mail volume blocker");
  assertStringIncludes(blocker.reason, "36.00 MiB");
  // The message-total term compares the base64-encoded wire size.
  assertStringIncludes(blocker.reason, "48.00 MiB");
  assertStringIncludes(blocker.reason, "35.00 MiB");
  assertStringIncludes(blocker.reason, "not culled");
  assertEquals(object(blocker.facts).transport, "user_mailbox");
  assertEquals(object(blocker.facts).total_base64_bytes, 48 * 1024 * 1024);
  assertEquals(object(blocker.facts).exceeded, "message_total");
  assertEquals(object(blocker.facts).attachment_count, 2);
  assertEquals(object(blocker.facts).photo_cull, false);
  // Every original photo survives the refusal; nothing is dropped or resized.
  assertEquals(
    result.artifacts.filter((artifact) => artifact.role === "completion_photo")
      .length,
    2,
  );
  assertEquals(
    result.artifacts
      .filter((artifact) => artifact.role === "completion_photo")
      .map((artifact) => artifact.size_bytes),
    [18 * 1024 * 1024, 18 * 1024 * 1024],
  );
  // A blocked pack never reaches Docs Ready and never drafts a builder email.
  // The revision itself is still persisted so the blocker is visible to the
  // operator (normal prepare semantics for a blocked revision).
  assertEquals(result.state, "blocked");
  assertEquals(result.envelope.pre_xero_docs_ready, false);
  assertEquals(Object.keys(result.email_drafts).length, 0);
  assertEquals(persistCalls.count, 1);
});

Deno.test("prepare allows the same AJS pack once it fits, proving the guard is size-driven", async () => {
  const row = SES_FAMILY_MATRIX.find((candidate) =>
    candidate.builder_key === "AJS" &&
    candidate.family === "physical_makesafe"
  )!;
  const input = photoHeavyInput(row, 2);
  const persistCalls = { count: 0 };
  const result = (await prepareSesDocketRevision(
    request(input.identity.job_id, false),
    dependencies(
      input,
      photoBytesDependencies(input, 8 * 1024 * 1024, persistCalls),
    ),
  )).results[0];

  assertEquals(
    blockerCodes(result).includes("photo_mail_volume_exceeds_graph_limit"),
    false,
  );
  assertEquals(result.envelope.pre_xero_docs_ready, true);
  assertEquals(Object.keys(result.email_drafts).sort(), [
    "PHOTO_EMAIL_DRAFT",
    "REPORT_EMAIL_DRAFT",
  ]);
});

Deno.test("prepare prices an MLB photo against the transport it will actually send on", async () => {
  const row = SES_FAMILY_MATRIX.find((candidate) =>
    candidate.builder_key === "MLB" &&
    candidate.family === "physical_makesafe" &&
    candidate.routing_rule === "mlb-perth-routing"
  )!;
  const input = photoHeavyInput(row, 1);
  const persistCalls = { count: 0 };
  const result = (await prepareSesDocketRevision(
    request(input.identity.job_id, false),
    dependencies(
      input,
      photoBytesDependencies(input, 4 * 1024 * 1024, persistCalls),
    ),
  )).results[0];

  const blocker = result.blockers.find((item) =>
    item.reason_code === "photo_mail_volume_exceeds_graph_limit"
  );
  if (mlbPhysicalUsesOrdinaryMailSendFallback()) {
    // Temporary Captain exception: MLB report/photo ride admin@ Mail.Send, so
    // the 3 MiB group-post ceiling must NOT be applied — a 4 MiB photo goes by
    // upload session. Blocking here would be a blocker the send path disagrees
    // with. The group-post ceiling itself stays pinned in the guard's own
    // suite (ses_photo_mail_volume_guard_test.ts).
    assertEquals(blocker, undefined);
    assertEquals(result.envelope.pre_xero_docs_ready, true);
  } else {
    assert(blocker, "expected the named photo-mail volume blocker");
    assertEquals(object(blocker.facts).transport, "group_thread_reply");
    assertEquals(
      object(blocker.facts).exceeded,
      "group_post_no_upload_session",
    );
    assertEquals(
      object(blocker.facts).per_attachment_limit_bytes,
      3 * 1024 * 1024,
    );
    assertStringIncludes(blocker.reason, "4.00 MiB");
    assertStringIncludes(blocker.reason, "group-post");
    assertEquals(result.state, "blocked");
    assertEquals(Object.keys(result.email_drafts).length, 0);
  }
  // Either way the single 4 MiB photo is retained in full, never downscaled.
  assertEquals(
    result.artifacts
      .filter((artifact) => artifact.role === "completion_photo")
      .map((artifact) => artifact.size_bytes),
    [4 * 1024 * 1024],
  );
});
