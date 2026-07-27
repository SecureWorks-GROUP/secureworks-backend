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
  SES_ASSESSMENT_RECIPE_PENDING,
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
      strata: row.family === "own_template_roof",
      own_template_requested: row.family === "own_template_roof",
      workflow: "active",
      lineage_kind: "none",
      family_matrix_version: SES_FAMILY_MATRIX_VERSION,
      assessment_outbound_recipe_version: row.family === "assessment_quote"
        ? SES_ASSESSMENT_RECIPE_PENDING
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
    capturePortal: async (captureRequest): Promise<SesPortalCapture> => ({
      status: "done",
      role: captureRequest.role,
      url: captureRequest.url,
      docket_id: captureRequest.docket_id,
      job_id: captureRequest.job_id,
      builder_reference: captureRequest.builder_reference,
      captured_at: FIXED_TIME.toISOString(),
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
    resolveSwmsArtifact: async () => ({
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
  assertEquals(SES_FAMILY_MATRIX.length, 11);
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

Deno.test("every shippable matrix row has a ready golden and an intentional negative golden", async () => {
  for (
    const row of SES_FAMILY_MATRIX.filter((candidate) =>
      candidate.family !== "assessment_quote"
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
  const response = await prepareSesDocketRevision(
    request(input.identity.job_id),
    dependencies(input),
  );
  assertEquals(response.results[0].state, "blocked");
  assert(
    blockerCodes(response.results[0]).includes(
      "ajs_misclassified_as_roof_report",
    ),
  );
  assertEquals(response.results[0].invoice_proposal, null);
  assertEquals(response.results[0].email_drafts, {});
  assertEquals(
    response.results[0].artifacts.some((artifact) =>
      artifact.role === "supporting_report_pdf" ||
      artifact.role === "completion_photo"
    ),
    false,
  );
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

Deno.test("physical docket copies every current-cycle photo and blocks an incomplete recovery", async () => {
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
      artifact.role === "completion_photo"
    ).length,
    2,
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
      resolvePhotoArtifacts: async (resolvedInput) => [{
        photo_id: resolvedInput.cycle_facts.photos[0].id,
        source_pointer: resolvedInput.cycle_facts.photos[0].path_or_key,
        file_name: "001.jpg",
        media_type: "image/jpeg",
        bytes: new Uint8Array([255, 216, 255]),
      }],
    }),
  );
  assertEquals(incomplete.results[0].state, "blocked");
  assert(
    blockerCodes(incomplete.results[0]).includes("trade_evidence_missing"),
  );
});

Deno.test("assessment triad is captured but the unsealed outbound recipe blocks all drafts", async () => {
  const row = SES_FAMILY_MATRIX.find((candidate) =>
    candidate.family === "assessment_quote"
  )!;
  const input = fixtureInput(row);
  const response = await prepareSesDocketRevision(
    request(input.identity.job_id),
    dependencies(input),
  );
  const result = response.results[0];
  assertEquals(result.state, "blocked");
  assertEquals(result.portal_evidence.length, 3);
  assertEquals(result.email_drafts, {});
  assert(
    blockerCodes(result).includes("assessment_recipe_unapproved"),
  );
  assertEquals(
    result.envelope.v2.items.draft_invoice_bundle_email.state,
    "blocked",
  );
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
  assert(
    blockerCodes(response.results[0]).includes("pricing_evidence_missing"),
  );
});

Deno.test("HRCW source terms force a real SWMS despite a builder waiver", async () => {
  const row = SES_FAMILY_MATRIX.find((candidate) =>
    candidate.builder_key === "AJS" &&
    candidate.family === "physical_makesafe"
  )!;
  const input = fixtureInput(row);
  input.hrcw.source_hazard_terms = ["asbestos"];
  const response = await prepareSesDocketRevision(
    request(input.identity.job_id),
    dependencies(input, { resolveSwmsArtifact: async () => null }),
  );
  assertEquals(response.results[0].state, "blocked");
  assert(blockerCodes(response.results[0]).includes("hrcw_swms_missing"));
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
    request(input.identity.job_id),
    dependencies(input),
  )).results[0];
  const calls: Array<{ kind: string; name: string }> = [];
  let rpcArgs: Record<string, unknown> | null = null;
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
      rpcArgs = args;
      return {
        data: { committed_at: "2026-07-27T01:00:01.000Z" },
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
  assertEquals(calls.at(-1), {
    kind: "rpc",
    name: "commit_makesafe_docket_revision_v1",
  });
  assert(rpcArgs);
  const revisionPayload = (rpcArgs as Record<string, unknown>)
    .p_revision as Record<string, unknown>;
  assertEquals(revisionPayload.pre_xero_docs_ready, true);
  assertEquals(
    (revisionPayload.release_payload as Record<string, unknown>)
      .create_invoice,
    false,
  );

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
