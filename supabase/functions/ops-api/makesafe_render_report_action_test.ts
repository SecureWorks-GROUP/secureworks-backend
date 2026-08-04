// deno-lint-ignore-file no-explicit-any no-import-prefix
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _attachCurrentWikiCuratedReportForTest,
  _bindCurrentCycleCuratedMakesafeReportForTest,
  _makesafeRenderReportForTest,
  ApiError,
  bertramProtectedReportRepairPlan,
  canonicalMakesafeReportJob,
  CURATED_BIND_JOB_MEDIA_COLUMNS,
} from "./index.ts";
import {
  canonicalCurrentWikiReportHashPayload,
  MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_SHA256,
  MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_VERSION,
  MAKESAFE_REPORT_AUTHORITATIVE_SOURCE_REVISION,
  renderMakesafeReportPdf,
} from "./makesafe_report_render.ts";
import { canonicalSesJson, sesSha256Bytes } from "./ses_docket_envelope.ts";

const FIXTURE_ACTOR = { id: "ops-test", auth_mode: "api_key" as const };
const SERVICE_REPORT_ID = "service-report-fixture";

function makeClientStub() {
  return {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => ({
            data: table === "makesafe_job_details"
              ? { report_type: null, attendance_cycle_id: "cycle-fixture" }
              : table === "jobs"
              ? { client_name: "Canonical site contact" }
              : null,
            error: null,
          }),
        }),
      }),
    }),
  };
}

Deno.test("stale TS report action refuses before rendering or attachment", async () => {
  const error = await assertRejects(
    () =>
      _makesafeRenderReportForTest(makeClientStub(), {
        job_id: "job-fixture",
        job: {
          ref: "REF-001",
          address: "Privacy-safe test property",
          crew: "1 trade",
          scope: "Stabilise the damaged boundary.",
          findings: "The boundary fence was unstable.",
          works: "2 trades completed 3 hours billed at $480.",
          materials: "Star pickets x 20.",
          photos: [],
        },
      }),
    ApiError,
    "guarded current-wiki",
  );
  assertEquals((error as ApiError).status, 410);
});

async function sha(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(bytes).buffer,
  );
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0")).join("");
}

function currentReportJob(overrides: Record<string, unknown> = {}) {
  return {
    ref: "REF-001",
    address: "Privacy-safe test property",
    contact: "Canonical site contact",
    crew: "1 trade",
    scope: "Stabilise the affected building element.",
    findings: "The affected element required immediate stabilisation.",
    works: "The affected element was secured pending permanent repair.",
    materials: "No materials recorded.",
    materials_evidence: { state: "none_recorded", items: [] },
    photos: [],
    photo_evidence: {
      source_revision: `job_service_report:${SERVICE_REPORT_ID}`,
      completeness_verified: true,
      source_count: 0,
      applicable_count: 0,
      selected_count: 0,
      applicable_ids: [],
      selected_ids: [],
      excluded: [],
      rejected: [],
    },
    ...overrides,
  };
}

async function inputHash(job: Record<string, unknown>): Promise<string> {
  return `sha256:${await sha(new TextEncoder().encode(canonicalSesJson(
    canonicalCurrentWikiReportHashPayload(job),
  )))}`;
}

function pdfBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function bindClient(
  bytes: Uint8Array,
  options: {
    cycleId?: string | null;
    prior?: Record<string, unknown>;
    otherDocuments?: Array<Record<string, unknown>>;
    jobType?: string;
    documentJobId?: string;
    documentType?: string;
    visibleToTrades?: boolean;
    documentCycleId?: string | null;
    documentCycleAttribution?: string | null;
    serviceReport?: Record<string, unknown> | null;
    media?: Array<Record<string, unknown>>;
    eventInsertError?: Record<string, unknown>;
  } = {},
) {
  const mutations: Array<{ table: string; values: Record<string, unknown> }> =
    [];
  const document = {
    id: "document-fixture",
    job_id: options.documentJobId || "job-fixture",
    type: options.documentType || "makesafe_report",
    file_name: "privacy-safe-report.pdf",
    pdf_url: "https://storage.example.test/privacy-safe-report.pdf",
    storage_url: null,
    visible_to_trades: options.visibleToTrades ?? true,
    attendance_cycle_id: options.documentCycleId === undefined
      ? "cycle-fixture"
      : options.documentCycleId,
    cycle_attribution: options.documentCycleAttribution === undefined
      ? "bound"
      : options.documentCycleAttribution,
    uploaded_by: "reporting-workflow",
    data_snapshot_json: options.prior || {},
    version: 1,
  };
  const serviceReport = options.serviceReport === null
    ? null
    : options.serviceReport || {
      id: SERVICE_REPORT_ID,
      status: "submitted",
      checklist_json: { materials_used: [] },
      attendance_cycle_id: options.cycleId === undefined
        ? "cycle-fixture"
        : options.cycleId,
      cycle_attribution: "bound",
      cycle_number: 1,
    };
  const media = options.media || [];
  const detailCycle = options.cycleId === undefined
    ? "cycle-fixture"
    : options.cycleId;
  const rows: Record<string, unknown> = {
    jobs: {
      id: "job-fixture",
      job_number: "SWMS-TEST",
      type: options.jobType || "makesafe",
      client_name: "Canonical site contact",
      metadata: { makesafe_job_family: "general_makesafe" },
    },
    makesafe_job_details: {
      report_type: null,
      attendance_cycle_id: detailCycle,
      cycle_number: 1,
      reattend_count: 0,
      external_ref: "REF-001",
    },
    job_documents: document,
  };
  const client = {
    from(table: string) {
      let mutation: Record<string, unknown> | null = null;
      let responseError: Record<string, unknown> | null = null;
      const filters: Record<string, unknown> = {};
      const query: any = {
        select: () => query,
        eq: (column: string, value: unknown) => {
          filters[column] = value;
          return query;
        },
        order: () => query,
        maybeSingle: () => {
          if (table === "job_documents" && filters.id) {
            return Promise.resolve({
              data: document.id === filters.id ? document : null,
              error: null,
            });
          }
          return Promise.resolve({ data: rows[table] || null, error: null });
        },
        insert: (values: Record<string, unknown>) => {
          mutation = values;
          mutations.push({ table, values });
          if (table === "job_events" && options.eventInsertError) {
            responseError = options.eventInsertError;
          }
          return query;
        },
        update: (values: Record<string, unknown>) => {
          mutation = values;
          mutations.push({ table, values });
          if (table === "job_documents") {
            if ("data_snapshot_json" in values) {
              document.data_snapshot_json = values.data_snapshot_json as Record<
                string,
                unknown
              >;
            }
            if ("version" in values) {
              document.version = Number(values.version);
            }
            if ("attendance_cycle_id" in values) {
              document.attendance_cycle_id = values.attendance_cycle_id as
                | string
                | null;
            }
            if ("cycle_attribution" in values) {
              document.cycle_attribution = values.cycle_attribution as
                | string
                | null;
            }
          }
          return query;
        },
        delete: () => {
          mutations.push({ table, values: { deleted: true } });
          return query;
        },
        then: (resolve: (value: unknown) => unknown) => {
          if (table === "job_documents" && !mutation) {
            const list = [document, ...(options.otherDocuments || [])]
              .filter((row) => {
                if (filters.type && row.type && row.type !== filters.type) {
                  return false;
                }
                if (
                  filters.attendance_cycle_id &&
                  String(row.attendance_cycle_id || "") !==
                    String(filters.attendance_cycle_id)
                ) {
                  return false;
                }
                return true;
              });
            return Promise.resolve({ data: list, error: responseError }).then(
              resolve,
            );
          }
          if (table === "job_service_reports") {
            return Promise.resolve({
              data: serviceReport ? [serviceReport] : [],
              error: responseError,
            }).then(resolve);
          }
          if (table === "job_media") {
            return Promise.resolve({ data: media, error: responseError }).then(
              resolve,
            );
          }
          return Promise.resolve({ data: null, error: responseError }).then(
            resolve,
          );
        },
      };
      return query;
    },
  } as any;
  return { client, document, mutations, bytes };
}

async function bindBody(bytes: Uint8Array) {
  const job = currentReportJob();
  return {
    job_id: "job-fixture",
    document_id: "document-fixture",
    pdf_base64: pdfBase64(bytes),
    pdf_sha256: `sha256:${await sha(bytes)}`,
    report_job: job,
    curation_revision_id: "curation-revision-fixture",
    curation_artifact_id: "curation-artifact-fixture",
  };
}

async function withStoredPdf<T>(bytes: Uint8Array, run: () => Promise<T>) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(new Response(new Uint8Array(bytes).buffer));
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function expectedSuccessShape(
  bytes: Uint8Array,
  reportJob: Record<string, unknown>,
  opts: { skipped: boolean; writes: number; documentVersion: number },
) {
  return {
    success: true,
    skipped: opts.skipped,
    document_id: "document-fixture",
    document_version: opts.documentVersion,
    attendance_cycle_id: "cycle-fixture",
    cycle_attribution: "bound",
    source_kind: "durable_curated_revision",
    source_identity:
      "curation-revision:curation-revision-fixture/artifact:curation-artifact-fixture",
    source_revision_id: "curation-revision-fixture",
    source_artifact_id: "curation-artifact-fixture",
    source_artifact_content_hash: await sesSha256Bytes(bytes),
    expected_raw_sha256: `sha256:${await sha(bytes)}`,
    report_input_hash: await inputHash(reportJob),
    renderer_source_revision: MAKESAFE_REPORT_AUTHORITATIVE_SOURCE_REVISION,
    renderer_script_sha256:
      `sha256:${MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_SHA256}`,
    renderer_version: MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_VERSION,
    writes: opts.writes,
  };
}

Deno.test("byte-bound current-cycle curated report bind writes stable independent source proof", async () => {
  const bytes = new TextEncoder().encode("%PDF-1.7\nprivacy-safe fixture");
  const { client, document, mutations } = bindClient(bytes);
  const body = await bindBody(bytes);
  const result = await withStoredPdf(
    bytes,
    () =>
      _bindCurrentCycleCuratedMakesafeReportForTest(
        client,
        body,
        FIXTURE_ACTOR,
      ),
  );
  assertEquals(
    result,
    await expectedSuccessShape(
      bytes,
      body.report_job as Record<string, unknown>,
      {
        skipped: false,
        writes: 2,
        documentVersion: 2,
      },
    ),
  );
  assertEquals(mutations.map((item) => item.table), [
    "job_events",
    "job_documents",
  ]);
  assertEquals(
    document.data_snapshot_json.curated_source_identity,
    result.source_identity,
  );
  assertEquals(document.version, 2);
  assertEquals(document.attendance_cycle_id, "cycle-fixture");
  assertEquals(document.cycle_attribution, "bound");
  assertEquals(
    document.data_snapshot_json.curated_source_authority,
    "privileged_ops_curated_bind",
  );

  const replay = await withStoredPdf(
    bytes,
    () =>
      _bindCurrentCycleCuratedMakesafeReportForTest(
        client,
        body,
        FIXTURE_ACTOR,
      ),
  );
  assertEquals(replay.skipped, true);
  assertEquals(replay.writes, 0);
  assertEquals(mutations.length, 2);
});

Deno.test("poisoned stopped-sweep snapshot is superseded after full evidence gates pass", async () => {
  const bytes = new TextEncoder().encode("%PDF-1.7\ncurated munster fixture");
  const poisonedPrior = {
    evidence_source: "raw_trade_report_fields",
    source_document_id: "document-fixture",
    report_renderer_version: "retired-renderer",
    uploaded_by: "guarded_current_wiki_rerender_sweep",
  };
  const { client, document, mutations } = bindClient(bytes, {
    prior: poisonedPrior,
  });
  const body = await bindBody(bytes);
  const result = await withStoredPdf(
    bytes,
    () =>
      _bindCurrentCycleCuratedMakesafeReportForTest(
        client,
        body,
        FIXTURE_ACTOR,
      ),
  );
  assertEquals(result.success, true);
  assertEquals(result.skipped, false);
  assertEquals(result.writes, 2);
  assertEquals(
    document.data_snapshot_json.evidence_source,
    "current_cycle_curated_makesafe_report",
  );
  assertEquals(
    document.data_snapshot_json.curated_source_kind,
    "durable_curated_revision",
  );
  // Prior poison is not merged forward; it is retained only on the audit event.
  assertEquals(document.data_snapshot_json.source_document_id, undefined);
  const event = mutations.find((item) => item.table === "job_events");
  assertEquals(
    (event?.values.detail_json as any)?.prior_data_snapshot_json,
    poisonedPrior,
  );
});

Deno.test("bind establishes current-cycle attribution on a newly attached visible report", async () => {
  const bytes = new TextEncoder().encode("%PDF-1.7\nfresh attach fixture");
  const { client, document, mutations } = bindClient(bytes, {
    documentCycleId: null,
    documentCycleAttribution: null,
    prior: {},
  });
  const body = await bindBody(bytes);
  const result = await withStoredPdf(
    bytes,
    () =>
      _bindCurrentCycleCuratedMakesafeReportForTest(
        client,
        body,
        FIXTURE_ACTOR,
      ),
  );
  assertEquals(result.success, true);
  assertEquals(result.attendance_cycle_id, "cycle-fixture");
  assertEquals(result.cycle_attribution, "bound");
  assertEquals(document.attendance_cycle_id, "cycle-fixture");
  assertEquals(document.cycle_attribution, "bound");
  assertEquals(mutations.map((item) => item.table), [
    "job_events",
    "job_documents",
  ]);
});

Deno.test(
  "trusted content supersession rebinds when all gates pass and snapshot differs",
  async () => {
    // First bind seals a durable curated identity on the document.
    const priorBytes = new TextEncoder().encode(
      "%PDF-1.7\nprior asbestos misstatement fixture",
    );
    const first = bindClient(priorBytes);
    const sealedBody = {
      ...(await bindBody(priorBytes)),
      curation_revision_id: "ses-curated-report:fixture:prior",
      curation_artifact_id: "ses-curated-report-artifact:prior",
    };
    await withStoredPdf(
      priorBytes,
      () =>
        _bindCurrentCycleCuratedMakesafeReportForTest(
          first.client,
          sealedBody,
          FIXTURE_ACTOR,
        ),
    );
    const trustedPrior = {
      ...(first.document.data_snapshot_json as Record<string, unknown>),
    };
    assertEquals(
      trustedPrior.curated_source_kind,
      "durable_curated_revision",
    );

    // Corrected artifact on the same document: all gates still pass; snapshot
    // differs (material correction). Prior durable identity is archived on the
    // audit event, not merged forward.
    const correctedBytes = new TextEncoder().encode(
      "%PDF-1.7\ncorrected hardie fibre cement fixture",
    );
    const correctedJob = currentReportJob({
      findings:
        "Storm and wind cracked the Hardie fibre cement (non-asbestos) boundary fencing.",
      works:
        "We propped up the Hardie fibre cement fence using star pickets pending replacement.",
    });
    const { client, document, mutations } = bindClient(correctedBytes, {
      prior: trustedPrior,
      documentCycleId: "cycle-fixture",
      documentCycleAttribution: "bound",
    });
    document.version = 2;
    const correctedBody = {
      job_id: "job-fixture",
      document_id: "document-fixture",
      pdf_base64: pdfBase64(correctedBytes),
      pdf_sha256: `sha256:${await sha(correctedBytes)}`,
      report_job: correctedJob,
      curation_revision_id: "ses-curated-report:fixture:hardie-correction",
      curation_artifact_id: "ses-curated-report-artifact:hardie-correction",
    };
    const result = await withStoredPdf(
      correctedBytes,
      () =>
        _bindCurrentCycleCuratedMakesafeReportForTest(
          client,
          correctedBody,
          FIXTURE_ACTOR,
        ),
    );
    assertEquals(result.success, true);
    assertEquals(result.skipped, false);
    assertEquals(result.writes, 2);
    assertEquals((result as any).supersedes_prior_bind, true);
    assertEquals(
      document.data_snapshot_json.curated_source_kind,
      "durable_curated_revision",
    );
    assertEquals(
      document.data_snapshot_json.curated_source_revision_id,
      "ses-curated-report:fixture:hardie-correction",
    );
    assertEquals(
      document.data_snapshot_json.report_render_hash,
      await sha(correctedBytes),
    );
    assertStringIncludes(
      String(
        (document.data_snapshot_json.report_scope_narratives as string[])[1] ||
          "",
      ),
      "Hardie fibre cement",
    );
    const event = mutations.find((item) => item.table === "job_events");
    assertEquals(
      (event?.values.detail_json as any)?.supersedes_prior_bind,
      true,
    );
    assertEquals(
      (event?.values.detail_json as any)?.prior_data_snapshot_json,
      trustedPrior,
    );
    // Idempotent replay of the same corrected snapshot skips.
    const replay = await withStoredPdf(
      correctedBytes,
      () =>
        _bindCurrentCycleCuratedMakesafeReportForTest(
          client,
          correctedBody,
          FIXTURE_ACTOR,
        ),
    );
    assertEquals(replay.skipped, true);
    assertEquals(replay.writes, 0);
  },
);

Deno.test(
  "two supersessions of the same bytes reserve distinct audit ids",
  async () => {
    const priorBytes = new TextEncoder().encode(
      "%PDF-1.7\nsupersession reservation fixture prior",
    );
    const first = bindClient(priorBytes);
    const sealedBody = {
      ...(await bindBody(priorBytes)),
      curation_revision_id: "ses-curated-report:fixture:reservation-a",
      curation_artifact_id: "ses-curated-report-artifact:reservation-a",
    };
    await withStoredPdf(
      priorBytes,
      () =>
        _bindCurrentCycleCuratedMakesafeReportForTest(
          first.client,
          sealedBody,
          FIXTURE_ACTOR,
        ),
    );
    const trustedPrior = {
      ...(first.document.data_snapshot_json as Record<string, unknown>),
    };

    const correctedBytes = new TextEncoder().encode(
      "%PDF-1.7\nsupersession reservation fixture corrected",
    );
    const { client, document, mutations } = bindClient(correctedBytes, {
      prior: trustedPrior,
      documentCycleId: "cycle-fixture",
      documentCycleAttribution: "bound",
    });
    document.version = 2;
    const correctedBody = {
      job_id: "job-fixture",
      document_id: "document-fixture",
      pdf_base64: pdfBase64(correctedBytes),
      pdf_sha256: `sha256:${await sha(correctedBytes)}`,
      report_job: currentReportJob(),
      curation_revision_id: "ses-curated-report:fixture:reservation-b",
      curation_artifact_id: "ses-curated-report-artifact:reservation-b",
    };
    await withStoredPdf(
      correctedBytes,
      () =>
        _bindCurrentCycleCuratedMakesafeReportForTest(
          client,
          correctedBody,
          FIXTURE_ACTOR,
        ),
    );
    // Same corrected PDF bytes, re-curated under a new curation identity: a
    // genuinely distinct supersession that a bytes-only reservation key would
    // refuse forever as a duplicate.
    const recuratedBody = {
      ...correctedBody,
      curation_revision_id: "ses-curated-report:fixture:reservation-c",
      curation_artifact_id: "ses-curated-report-artifact:reservation-c",
    };
    const recurated = await withStoredPdf(
      correctedBytes,
      () =>
        _bindCurrentCycleCuratedMakesafeReportForTest(
          client,
          recuratedBody,
          FIXTURE_ACTOR,
        ),
    );
    assertEquals(recurated.success, true);
    assertEquals((recurated as any).supersedes_prior_bind, true);
    assertEquals(
      document.data_snapshot_json.curated_source_revision_id,
      "ses-curated-report:fixture:reservation-c",
    );
    const eventIds = mutations.filter((item) => item.table === "job_events")
      .map((item) => String(item.values.id));
    assertEquals(eventIds.length, 2);
    assertEquals(new Set(eventIds).size, 2);

    // Same bytes and same curation identity, differing canonical input hash:
    // still a distinct reservation, so the key cannot be bytes-scoped either.
    const restatedBody = {
      ...recuratedBody,
      report_job: currentReportJob({
        findings:
          "The affected element was restated after the Captain's correction.",
      }),
    };
    await withStoredPdf(
      correctedBytes,
      () =>
        _bindCurrentCycleCuratedMakesafeReportForTest(
          client,
          restatedBody,
          FIXTURE_ACTOR,
        ),
    );
    const allEventIds = mutations.filter((item) => item.table === "job_events")
      .map((item) => String(item.values.id));
    assertEquals(allEventIds.length, 3);
    assertEquals(new Set(allEventIds).size, 3);
  },
);

Deno.test(
  "a genuinely duplicate content supersession refuses as its own reservation",
  async () => {
    const priorBytes = new TextEncoder().encode(
      "%PDF-1.7\nsupersession duplicate fixture prior",
    );
    const first = bindClient(priorBytes);
    const sealedBody = {
      ...(await bindBody(priorBytes)),
      curation_revision_id: "ses-curated-report:fixture:duplicate-prior",
      curation_artifact_id: "ses-curated-report-artifact:duplicate-prior",
    };
    await withStoredPdf(
      priorBytes,
      () =>
        _bindCurrentCycleCuratedMakesafeReportForTest(
          first.client,
          sealedBody,
          FIXTURE_ACTOR,
        ),
    );
    const correctedBytes = new TextEncoder().encode(
      "%PDF-1.7\nsupersession duplicate fixture corrected",
    );
    const { client, document, mutations } = bindClient(correctedBytes, {
      prior: {
        ...(first.document.data_snapshot_json as Record<string, unknown>),
      },
      documentCycleId: "cycle-fixture",
      documentCycleAttribution: "bound",
      eventInsertError: { code: "23505", message: "duplicate reservation" },
    });
    document.version = 2;
    const correctedBody = {
      job_id: "job-fixture",
      document_id: "document-fixture",
      pdf_base64: pdfBase64(correctedBytes),
      pdf_sha256: `sha256:${await sha(correctedBytes)}`,
      report_job: currentReportJob(),
      curation_revision_id: "ses-curated-report:fixture:duplicate-corrected",
      curation_artifact_id: "ses-curated-report-artifact:duplicate-corrected",
    };
    const error = await assertRejects(
      () =>
        withStoredPdf(
          correctedBytes,
          () =>
            _bindCurrentCycleCuratedMakesafeReportForTest(
              client,
              correctedBody,
              FIXTURE_ACTOR,
            ),
        ),
      ApiError,
      "this content supersession is already reserved or completed",
    );
    assertEquals((error as ApiError).status, 409);
    assertEquals(
      mutations.some((mutation) => mutation.table === "job_documents"),
      false,
    );
  },
);

Deno.test("exact trusted snapshot with drifted cycle columns repairs cycle only", async () => {
  const bytes = new TextEncoder().encode("%PDF-1.7\ncycle repair fixture");
  const body = await bindBody(bytes);
  const first = bindClient(bytes);
  await withStoredPdf(
    bytes,
    () =>
      _bindCurrentCycleCuratedMakesafeReportForTest(
        first.client,
        body,
        FIXTURE_ACTOR,
      ),
  );
  const trusted = first.document.data_snapshot_json as Record<string, unknown>;
  const { client, document, mutations } = bindClient(bytes, {
    prior: trusted,
    documentCycleId: null,
    documentCycleAttribution: null,
  });
  const result = await withStoredPdf(
    bytes,
    () =>
      _bindCurrentCycleCuratedMakesafeReportForTest(
        client,
        body,
        FIXTURE_ACTOR,
      ),
  );
  assertEquals(result.success, true);
  assertEquals(result.skipped, false);
  assertEquals(result.writes, 1);
  assertEquals((result as any).cycle_repair, true);
  assertEquals(document.attendance_cycle_id, "cycle-fixture");
  assertEquals(document.cycle_attribution, "bound");
  assertEquals(document.data_snapshot_json, trusted);
  assertEquals(
    mutations.every((item) => item.table === "job_documents"),
    true,
  );
});

Deno.test("materials evidence trims whitespace before source compare", async () => {
  const bytes = new TextEncoder().encode("%PDF-1.7\nmaterials trim fixture");
  const { client, mutations } = bindClient(bytes, {
    serviceReport: {
      id: SERVICE_REPORT_ID,
      status: "submitted",
      checklist_json: { materials_used: ["star picket x 4  "] },
      attendance_cycle_id: "cycle-fixture",
      cycle_attribution: "bound",
      cycle_number: 1,
    },
  });
  const body: Record<string, unknown> = await bindBody(bytes);
  body.report_job = {
    ...(body.report_job as Record<string, unknown>),
    materials: "star picket x 4",
    materials_evidence: {
      state: "recorded_used",
      items: ["  star picket x 4"] as string[],
    },
  };
  const result = await withStoredPdf(
    bytes,
    () =>
      _bindCurrentCycleCuratedMakesafeReportForTest(
        client,
        body,
        FIXTURE_ACTOR,
      ),
  );
  assertEquals(result.success, true);
  assertEquals(mutations.length > 0, true);
});

Deno.test("curated bind rejects wrong contact, hash, cycle, self-reference and conflicts before trust", async () => {
  const bytes = new TextEncoder().encode("%PDF-1.7\nprivacy-safe fixture");
  const baseline = await bindBody(bytes);
  const cases: Array<{
    label: string;
    body: Record<string, unknown>;
    clientOptions?: Parameters<typeof bindClient>[1];
    message: string;
  }> = [
    {
      label: "wrong canonical contact",
      body: {
        ...baseline,
        report_job: {
          ...baseline.report_job as Record<string, unknown>,
          contact: "Caller supplied contact must not win",
        },
      },
      message: "canonical jobs.client_name",
    },
    {
      label: "commercial report input",
      body: {
        ...baseline,
        report_job: {
          ...baseline.report_job as Record<string, unknown>,
          works: "Two trades completed three hours billed at a fixture rate.",
        },
      },
      message: "commercial content is not allowed",
    },
    {
      label: "sha256 format invalid",
      body: { ...baseline, pdf_sha256: "0".repeat(64) },
      message: "must use sha256:<64 lowercase hex>",
    },
    {
      label: "bad raw hash",
      body: { ...baseline, pdf_sha256: `sha256:${"0".repeat(64)}` },
      message: "raw SHA-256 mismatch",
    },
    {
      label: "document on other cycle",
      body: baseline,
      clientOptions: { cycleId: "other-cycle" },
      message: "another or inconsistent attendance cycle",
    },
    {
      label: "missing current cycle",
      body: baseline,
      clientOptions: {
        cycleId: null,
        documentCycleId: null,
        documentCycleAttribution: null,
      },
      message: "no verified current attendance cycle",
    },
    {
      label: "self reference",
      body: {
        ...baseline,
        curation_revision_id: "document-fixture",
      },
      message: "cannot self-reference",
    },
    {
      label: "wrong physical job type",
      body: baseline,
      clientOptions: { jobType: "fencing" },
      message: "only a physical make-safe job",
    },
    {
      label: "wrong document job",
      body: baseline,
      clientOptions: { documentJobId: "other-job" },
      message: "not a visible same-job",
    },
    {
      label: "wrong document type",
      body: baseline,
      clientOptions: { documentType: "work_order" },
      message: "not a visible same-job",
    },
    {
      label: "invisible report",
      body: baseline,
      clientOptions: { visibleToTrades: false },
      message: "not a visible same-job",
    },
    {
      label: "second conflicting bind",
      body: baseline,
      clientOptions: {
        otherDocuments: [{
          id: "other-document",
          type: "makesafe_report",
          attendance_cycle_id: "cycle-fixture",
          data_snapshot_json: {
            curated_source_kind: "durable_curated_revision",
          },
        }],
      },
      message: "already has a conflicting curated source bind",
    },
    {
      label: "source report mismatch",
      body: {
        ...baseline,
        report_job: {
          ...baseline.report_job as Record<string, unknown>,
          photo_evidence: {
            ...(baseline.report_job as any).photo_evidence,
            source_revision: "job_service_report:wrong-report",
          },
        },
      },
      message: "selected current-cycle service report",
    },
  ];
  for (const testCase of cases) {
    const { client, mutations } = bindClient(bytes, testCase.clientOptions);
    const error = await assertRejects(
      () =>
        withStoredPdf(
          bytes,
          () =>
            _bindCurrentCycleCuratedMakesafeReportForTest(
              client,
              testCase.body,
              FIXTURE_ACTOR,
            ),
        ),
      ApiError,
      testCase.message,
    );
    assertEquals((error as ApiError).status >= 400, true, testCase.label);
    assertEquals(mutations, [], testCase.label);
  }
});

Deno.test("same curation identity with different bytes is served-byte drift, not a second bind", async () => {
  const firstBytes = new TextEncoder().encode("%PDF-1.7\nfirst fixture");
  const changedBytes = new TextEncoder().encode("%PDF-1.7\nchanged fixture");
  const { client, mutations } = bindClient(firstBytes);
  const firstBody = await bindBody(firstBytes);
  await withStoredPdf(
    firstBytes,
    () =>
      _bindCurrentCycleCuratedMakesafeReportForTest(
        client,
        firstBody,
        FIXTURE_ACTOR,
      ),
  );
  const changedBody = await bindBody(changedBytes);
  const error = await assertRejects(
    () =>
      withStoredPdf(
        // served bytes remain the original; caller-supplied PDF diverges
        firstBytes,
        () =>
          _bindCurrentCycleCuratedMakesafeReportForTest(
            client,
            changedBody,
            FIXTURE_ACTOR,
          ),
      ),
    ApiError,
    "bytes drift from the curated artifact",
  );
  assertEquals((error as ApiError).status, 409);
  assertEquals(mutations.length, 2);
});

Deno.test("cycle reservation collision refuses before a concurrent trusted marker write", async () => {
  const bytes = new TextEncoder().encode("%PDF-1.7\nprivacy-safe fixture");
  const { client, mutations } = bindClient(bytes, {
    eventInsertError: { code: "23505", message: "duplicate reservation" },
  });
  const body = await bindBody(bytes);
  const error = await assertRejects(
    () =>
      withStoredPdf(
        bytes,
        () =>
          _bindCurrentCycleCuratedMakesafeReportForTest(
            client,
            body,
            FIXTURE_ACTOR,
          ),
      ),
    ApiError,
    "bind in progress or completed",
  );
  assertEquals((error as ApiError).status, 409);
  assertEquals(
    mutations.some((mutation) => mutation.table === "job_documents"),
    false,
  );
});

Deno.test("current-wiki input hash binds photo bytes, not temp paths", async () => {
  const contentHash = `sha256:${"a".repeat(64)}`;
  const photoEvidence = {
    source_revision: "fixture-source-1",
    completeness_verified: true,
    source_count: 1,
    applicable_count: 1,
    selected_count: 1,
    applicable_ids: ["photo-1"],
    selected_ids: ["photo-1"],
    excluded: [],
    rejected: [],
  };
  const base = {
    ...currentReportJob(),
    photo_evidence: photoEvidence,
  };
  const reviewed = {
    ...base,
    photos: [{
      evidence_id: "photo-1",
      caption: "Completion evidence",
      content_sha256: contentHash,
      file: "/private/tmp/review/photo-1.jpg",
    }],
  };
  const apply = {
    ...base,
    photos: [{
      evidence_id: "photo-1",
      caption: "Completion evidence",
      content_sha256: contentHash,
      file: "/private/tmp/apply/photo-1.jpg",
    }],
  };
  assertEquals(await inputHash(reviewed), await inputHash(apply));
  const changedBytes = {
    ...apply,
    photos: [{
      ...apply.photos[0],
      content_sha256: `sha256:${"b".repeat(64)}`,
    }],
  };
  if (await inputHash(reviewed) === await inputHash(changedBytes)) {
    throw new Error("photo content SHA-256 must move the report input hash");
  }
});

function attachClient(
  jobNumber: string,
  documentFacts: Record<string, unknown>,
) {
  const mutations: string[] = [];
  const updates: Record<string, unknown>[] = [];
  const rows: Record<string, unknown> = {
    jobs: {
      id: "job-fixture",
      job_number: jobNumber,
      client_name: "Canonical site contact",
      site_suburb: "Sampleton",
    },
    makesafe_job_details: {
      report_type: null,
      attendance_cycle_id: "cycle-fixture",
      external_ref: "REF-001",
    },
    job_documents: [{
      id: "document-fixture",
      file_name: "existing.pdf",
      data_snapshot_json: documentFacts,
    }],
  };
  const client = {
    from(table: string) {
      const query: any = {
        select: () => query,
        eq: () => query,
        maybeSingle: () => Promise.resolve({ data: rows[table], error: null }),
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve({ data: rows[table], error: null }).then(resolve),
        insert: () => {
          mutations.push(`insert:${table}`);
          return query;
        },
        update: (values: Record<string, unknown>) => {
          mutations.push(`update:${table}`);
          updates.push(values);
          if (table === "job_documents") {
            rows.job_documents =
              (rows.job_documents as Record<string, unknown>[]).map((row) => ({
                ...row,
                ...values,
              }));
          }
          return query;
        },
      };
      return query;
    },
  } as any;
  return { client, mutations, updates };
}

Deno.test("current-wiki attachment is retired before every mutation", async () => {
  const { client, mutations } = attachClient("SWMS-TEST", {});
  const error = await assertRejects(
    () =>
      _attachCurrentWikiCuratedReportForTest(client, {
        job_id: "job-fixture",
      }),
    ApiError,
    "is retired",
  );
  assertEquals((error as ApiError).status, 410);
  assertEquals(mutations, []);
});

Deno.test("Bertram repair authority admits only the exact reviewed candidate and source", () => {
  const accepted = bertramProtectedReportRepairPlan({
    job_id: "208450c0-7161-4b30-9514-66226b054609",
    job_number: "SWMS-261109",
    candidate_raw_sha256:
      "5c0dfc02488907f9e4ac1196a1dee6d390ba61a38afd0fb3b20e37139c6f13f8",
    authority: "bertram-provenance-repair-v1",
  });
  assertEquals(
    accepted?.source_document_id,
    "1378390d-4d88-4ab8-99ea-b8d937782c76",
  );
  assertEquals(accepted?.source_document_version, 3);
  assertEquals(
    accepted?.source_raw_sha256,
    "3e2ee3b9ac47fc2d21fd58144ce7152a97b01c46eedc10485c0e5bda3d5d97ad",
  );
  assertEquals(
    bertramProtectedReportRepairPlan({
      job_id: "208450c0-7161-4b30-9514-66226b054609",
      job_number: "SWMS-261109",
      candidate_raw_sha256: "0".repeat(64),
      authority: "bertram-provenance-repair-v1",
    }),
    null,
  );
});

Deno.test("canonical report adapter owns jobs.client_name -> contact", async () => {
  const canonical = canonicalMakesafeReportJob({
    ref: "REF-001",
    address: "Privacy-safe test property",
    contact: "Caller supplied contact must not win",
    crew: "1 trade",
    scope: "Stabilise the damaged boundary.",
    findings: "The boundary fence was unstable.",
    works: "Secured the affected span pending permanent repair.",
    materials: "No materials recorded.",
    photos: [],
  }, "Canonical site contact");
  assertEquals(canonical.contact, "Canonical site contact");
  const rendered = await renderMakesafeReportPdf(canonical);
  const pdf = new TextDecoder("latin1").decode(rendered.bytes);
  assertStringIncludes(pdf, "Canonical site contact");

  const absent = canonicalMakesafeReportJob(
    { ref: "REF-002", address: "" },
    null,
  );
  assertEquals(absent.contact, "");
});

// ── job_media schema/order regressions ──────────────────────────────────────
// A mocked client answers any select, so the suite could not see that the bind
// asked job_media for `cycle_number`, `sort_order` and `order_index` — none of
// which exist on that table. PostgREST answered 42703 and every production bind
// refused `curated_bind_source_evidence_read_failed`. These three tests pin the
// column set, prove a schema-faithful client still binds, and pin the order.

/**
 * The LIVE public.job_media columns, read from information_schema on
 * 2026-08-04. Deliberately duplicated here so the test fails when the bind
 * asks for a column the database does not have.
 */
const LIVE_JOB_MEDIA_COLUMNS = [
  "attendance_cycle_id",
  "created_at",
  "cycle_attribution",
  "id",
  "job_id",
  "label",
  "lat",
  "lng",
  "makesafe_content_hash",
  "makesafe_fact_version",
  "notes",
  "phase",
  "po_id",
  "storage_url",
  "taken_at",
  "thumbnail_url",
  "type",
  "uploaded_by",
];

Deno.test("curated bind job_media select names only real columns", () => {
  const selected = CURATED_BIND_JOB_MEDIA_COLUMNS.split(",").map((name) =>
    name.trim()
  );
  assertEquals(selected.length > 0, true);
  const phantom = selected.filter((name) =>
    !LIVE_JOB_MEDIA_COLUMNS.includes(name)
  );
  assertEquals(
    phantom,
    [],
    `job_media select names columns that do not exist: ${phantom.join(", ")}`,
  );
  // The exact three that took production down — named so a reviewer sees why.
  for (const absent of ["cycle_number", "sort_order", "order_index"]) {
    assertEquals(
      selected.includes(absent),
      false,
      `job_media has no ${absent}; selecting it is a PostgREST 42703`,
    );
  }
});

Deno.test("curated bind survives a client that rejects unknown job_media columns", async () => {
  const bytes = new TextEncoder().encode("%PDF-1.7\nschema faithful fixture");
  const { client } = bindClient(bytes);
  // Wrap the stub so job_media behaves like PostgREST: an unknown column is a
  // 42703 error, not a silently answered row.
  const inner = client.from.bind(client);
  const rejected: string[] = [];
  client.from = (table: string) => {
    const query = inner(table);
    if (table !== "job_media") return query;
    const select = query.select.bind(query);
    query.select = (columns?: string) => {
      for (const name of String(columns || "").split(",")) {
        const column = name.trim();
        if (
          column && column !== "*" && !LIVE_JOB_MEDIA_COLUMNS.includes(column)
        ) {
          rejected.push(column);
        }
      }
      return select(columns);
    };
    const then = query.then.bind(query);
    query.then = (resolve: (value: unknown) => unknown) =>
      rejected.length
        ? Promise.resolve({
          data: null,
          error: {
            code: "42703",
            message: `column job_media.${rejected[0]} does not exist`,
          },
        }).then(resolve)
        : then(resolve);
    return query;
  };
  const body = await bindBody(bytes);
  const result = await withStoredPdf(
    bytes,
    () =>
      _bindCurrentCycleCuratedMakesafeReportForTest(
        client,
        body,
        FIXTURE_ACTOR,
      ),
  );
  assertEquals(rejected, []);
  assertEquals(result.success, true);
  assertEquals(result.cycle_attribution, "bound");
});

Deno.test("curated bind photo accounting orders by created_at, then id", async () => {
  const bytes = new TextEncoder().encode("%PDF-1.7\nordered photo fixture");
  // Deliberately adversarial: id order and created_at order fully disagree, and
  // two rows share a timestamp so the id tiebreak is exercised as well.
  //   created_at: zzz, bbb, mmm, ppp, fff, aaa, nnn   id: aaa, bbb, fff, mmm, nnn, ppp, zzz
  //
  // ppp/fff differ ONLY by a fractional-seconds component, which Postgres omits
  // when microseconds are exactly zero. A string comparator orders them the
  // wrong way round (ICU weights '.' below 'Z'), so they pin chronological
  // comparison. nnn carries a null created_at and must sort LAST, as PostgREST
  // returns nulls last rather than first.
  const media = [
    {
      id: "aaa",
      type: "photo",
      phase: "completion",
      created_at: "2026-07-30T02:24:07Z",
      storage_url: "https://storage.example.test/a.jpg",
    },
    {
      id: "zzz",
      type: "photo",
      phase: "completion",
      created_at: "2026-07-30T02:23:53Z",
      storage_url: "https://storage.example.test/z.jpg",
    },
    {
      id: "mmm",
      type: "photo",
      phase: "completion",
      created_at: "2026-07-30T02:24:01Z",
      storage_url: "https://storage.example.test/m.jpg",
    },
    {
      id: "bbb",
      type: "photo",
      phase: "completion",
      created_at: "2026-07-30T02:24:01Z",
      storage_url: "https://storage.example.test/b.jpg",
    },
    {
      id: "fff",
      type: "photo",
      phase: "completion",
      created_at: "2026-07-30T02:24:03.500Z",
      storage_url: "https://storage.example.test/f.jpg",
    },
    {
      id: "ppp",
      type: "photo",
      phase: "completion",
      created_at: "2026-07-30T02:24:03Z",
      storage_url: "https://storage.example.test/p.jpg",
    },
    {
      id: "nnn",
      type: "photo",
      phase: "completion",
      created_at: null,
      storage_url: "https://storage.example.test/n.jpg",
    },
  ];
  // Guard the fixture itself: a string comparator genuinely disagrees with
  // chronology on this pair, so the assertions below cannot pass by accident.
  assertEquals(
    String(media[5].created_at).localeCompare(String(media[4].created_at)) > 0,
    true,
  );
  const expected = ["zzz", "bbb", "mmm", "ppp", "fff", "aaa", "nnn"];
  const photoBytes = new TextEncoder().encode("photo-bytes");
  const contentHash = `sha256:${await sha(photoBytes)}`;
  const { client } = bindClient(bytes, {
    media,
    serviceReport: {
      id: SERVICE_REPORT_ID,
      status: "submitted",
      checklist_json: { materials_used: [] },
      attendance_cycle_id: "cycle-fixture",
      cycle_attribution: "bound",
      cycle_number: 1,
    },
  });
  const job = {
    ...currentReportJob(),
    photos: expected.map((id) => ({
      evidence_id: id,
      caption: `Site photo ${id}`,
      content_sha256: contentHash,
    })),
    photo_evidence: {
      source_revision: `job_service_report:${SERVICE_REPORT_ID}`,
      completeness_verified: true,
      source_count: media.length,
      applicable_count: media.length,
      selected_count: media.length,
      applicable_ids: expected,
      selected_ids: expected,
      excluded: [],
      rejected: [],
    },
  };
  const body = {
    ...(await bindBody(bytes)),
    report_job: job,
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input: any) =>
    Promise.resolve(
      new Response(
        String(input).endsWith(".pdf") ? bytes : photoBytes,
        { status: 200 },
      ),
    ) as any;
  try {
    const result = await _bindCurrentCycleCuratedMakesafeReportForTest(
      client,
      body,
      FIXTURE_ACTOR,
    );
    assertEquals(result.success, true);
  } finally {
    globalThis.fetch = originalFetch;
  }

  // The id-only comparator this replaced would have demanded id order. That
  // payload is internally self-consistent, so only the source-order comparison
  // can catch it — it must now be refused.
  const idOrdered = ["aaa", "bbb", "fff", "mmm", "nnn", "ppp", "zzz"];
  assertEquals(
    canonicalSesJson(idOrdered) === canonicalSesJson(expected),
    false,
  );
  const { client: second } = bindClient(bytes, {
    media,
    serviceReport: {
      id: SERVICE_REPORT_ID,
      status: "submitted",
      checklist_json: { materials_used: [] },
      attendance_cycle_id: "cycle-fixture",
      cycle_attribution: "bound",
      cycle_number: 1,
    },
  });
  globalThis.fetch = (input: any) =>
    Promise.resolve(
      new Response(
        String(input).endsWith(".pdf") ? bytes : photoBytes,
        { status: 200 },
      ),
    ) as any;
  try {
    const error = await assertRejects(
      () =>
        _bindCurrentCycleCuratedMakesafeReportForTest(second, {
          ...body,
          report_job: {
            ...job,
            photos: idOrdered.map((id) => ({
              evidence_id: id,
              caption: `Site photo ${id}`,
              content_sha256: contentHash,
            })),
            photo_evidence: {
              ...job.photo_evidence,
              applicable_ids: idOrdered,
              selected_ids: idOrdered,
            },
          },
        }, FIXTURE_ACTOR),
      ApiError,
    );
    assertStringIncludes(
      String((error as ApiError).message),
      "photo_evidence does not completely account",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("curated bind photo accounting keeps sub-millisecond created_at order", async () => {
  const bytes = new TextEncoder().encode("%PDF-1.7\nmicrosecond photo fixture");
  // Both rows land inside the same millisecond, so `Date.parse` alone reports
  // them as simultaneous and the id tiebreak inverts them. Postgres orders by
  // true chronology, so the comparator has to as well.
  const media = [
    {
      id: "aaa",
      type: "photo",
      phase: "completion",
      created_at: "2026-07-30T02:24:01.123999+00:00",
      storage_url: "https://storage.example.test/a.jpg",
    },
    {
      id: "bbb",
      type: "photo",
      phase: "completion",
      created_at: "2026-07-30T02:24:01.123456+00:00",
      storage_url: "https://storage.example.test/b.jpg",
    },
  ];
  assertEquals(
    Date.parse(String(media[0].created_at)) ===
      Date.parse(String(media[1].created_at)),
    true,
  );
  const chronological = ["bbb", "aaa"];
  const idOrdered = ["aaa", "bbb"];
  const photoBytes = new TextEncoder().encode("photo-bytes");
  const contentHash = `sha256:${await sha(photoBytes)}`;
  const photoEvidence = (ids: string[]) => ({
    source_revision: `job_service_report:${SERVICE_REPORT_ID}`,
    completeness_verified: true,
    source_count: media.length,
    applicable_count: media.length,
    selected_count: media.length,
    applicable_ids: ids,
    selected_ids: ids,
    excluded: [],
    rejected: [],
  });
  const reportJob = (ids: string[]) => ({
    ...currentReportJob(),
    photos: ids.map((id) => ({
      evidence_id: id,
      caption: `Site photo ${id}`,
      content_sha256: contentHash,
    })),
    photo_evidence: photoEvidence(ids),
  });
  const base = await bindBody(bytes);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input: any) =>
    Promise.resolve(
      new Response(
        String(input).endsWith(".pdf") ? bytes : photoBytes,
        { status: 200 },
      ),
    ) as any;
  try {
    const { client } = bindClient(bytes, { media });
    const result = await _bindCurrentCycleCuratedMakesafeReportForTest(
      client,
      { ...base, report_job: reportJob(chronological) },
      FIXTURE_ACTOR,
    );
    assertEquals(result.success, true);

    // The same IDs in id order are complete but out of sequence, and the
    // refusal must say so rather than pointing at completeness.
    const { client: second } = bindClient(bytes, { media });
    const error = await assertRejects(
      () =>
        _bindCurrentCycleCuratedMakesafeReportForTest(
          second,
          { ...base, report_job: reportJob(idOrdered) },
          FIXTURE_ACTOR,
        ),
      ApiError,
    );
    assertStringIncludes(
      String((error as ApiError).message),
      "applicable_ids carries the current-cycle IDs in the wrong sequence",
    );
    assertStringIncludes(
      String((error as ApiError).message),
      "created_at ascending, then id",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
