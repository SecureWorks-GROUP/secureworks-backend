// deno-lint-ignore-file no-explicit-any no-import-prefix
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _parseSesDraftForTest,
  assertSesDocketsSignedOffForSend,
  docketArtifactPackRelativePath,
  executeSesReleaseRevisionAction,
  getSesReviewablePackAction,
  inspectSesSupportingReportProof,
  listSesDocsReadyReviewsAction,
  querySesReviewCockpitAction,
  resolveDocketRoutes,
  SesActionError,
  sesDocketReleaseCaveats,
  signOffSesDocketAction,
} from "./ses_reporting_actions.ts";
import {
  MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_SHA256,
  MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_VERSION,
  MAKESAFE_REPORT_AUTHORITATIVE_SOURCE_REVISION,
  MAKESAFE_REPORT_CONTRACT_VERSION,
} from "./makesafe_report_render.ts";
import { sesSha256Bytes } from "./ses_docket_envelope.ts";
import {
  MAKESAFE_REPORT_RENDERER_AUTHORITY_REGISTER,
  makesafeRendererAuthorityVersion,
} from "./makesafe_report_renderer_authority.ts";

Deno.test("persisted named-card findings stay visible caveats outside the hard blocker column", () => {
  const caveats = sesDocketReleaseCaveats({
    blockers: [],
    review_spec: {
      cards: [{
        review_assumption_codes: [
          "canonical_draft_pack_output_missing",
          "canonical_draft_pack_output_incomplete",
          "curated_source_missing",
          "independent_source_kind_missing",
        ],
        review_assumptions: [
          "No Maverick DraftPack was supplied.",
          "The Maverick DraftPack is incomplete.",
          "No independent curated source is bound.",
          "The persisted artifact has no independent source kind.",
        ],
        commercial_review_codes: [
          "pricing_evidence_missing",
          "materials_charge_figure_required",
        ],
        commercial_reviews: [
          "Trade hours were not evidenced; sealed floor proposed.",
          "Materials need one ex-GST figure.",
        ],
      }],
    },
  });

  assertEquals(caveats.map((caveat) => caveat.code), [
    "canonical_draft_pack_output_missing",
    "canonical_draft_pack_output_incomplete",
    "curated_source_missing",
    "independent_source_kind_missing",
    "pricing_evidence_missing",
    "materials_charge_figure_required",
  ]);
  assertEquals(caveats.every((caveat) => caveat.state === "caveat"), true);
  const commercial = caveats.filter((caveat) =>
    caveat.evidence?.issue_class === "commercial_review"
  );
  assertEquals(commercial.map((caveat) => caveat.code), [
    "pricing_evidence_missing",
    "materials_charge_figure_required",
  ]);
});

async function rawSha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer),
  );
  return Array.from(digest).map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function reviewPackClient(
  artifact: Record<string, unknown>,
  bytes: Uint8Array,
  options: {
    jobEvents?: Array<Record<string, unknown>>;
    jobEventsError?: Record<string, unknown>;
    /**
     * Fault ONLY the trail of this job. `jobEventsError` faults every
     * `job_events` read, which cannot distinguish the docket job's own trail
     * from a sibling's - and a test that faults both never reaches the sibling
     * branch at all, so it proves nothing about it.
     */
    jobEventsErrorForJob?: { job_id: string; error: Record<string, unknown> };
    boundDocument?: Record<string, unknown> | null;
    /** Envelope-level docs-ready flag, as `prepare_ses_docket_revision` writes it. */
    preXeroDocsReady?: boolean;
    /**
     * Pack bind pointers. Every ready pack requires resolved report + invoice
     * artifacts; omit / null reproduces the SWMS-261015/SWMS-26980 false green.
     * Defaults are exact bound artifacts so pre-existing ready fixtures stay ready.
     */
    packRow?: Record<string, unknown> | null;
    packDocuments?: Array<Record<string, unknown>>;
    family?: string;
    jobRow?: Record<string, unknown> | null;
    detailRow?: Record<string, unknown> | null;
    portalCaptures?: Array<Record<string, unknown>>;
    serviceReports?: Array<Record<string, unknown>>;
    pricingDisposition?: string;
    artifactReadErrors?: Partial<
      Record<"job_documents" | "job_service_reports", Record<string, unknown>>
    >;
  } = {},
) {
  const signedPaths: string[] = [];
  const rpcCalls: string[] = [];
  const artifactMetadata = (artifact.metadata || {}) as Record<string, any>;
  const document = options.boundDocument === undefined
    ? {
      id: String(
        artifactMetadata.report_document_id ||
          artifactMetadata.source_document_id || "source-document",
      ),
      data_snapshot_json: {
        report_render_hash: String(artifactMetadata.expected_raw_sha256 || "")
          .replace(/^sha256:/, ""),
      },
    }
    : options.boundDocument;
  const review = {
    docket_revision_id: "docket-fixture",
    docket_output_content_hash: `sha256:${"e".repeat(64)}`,
    assembler_version: "ses-pack-assembler/v1",
    family_matrix_version: "family-matrix-fixture",
    review_state: "needs_review",
  };
  const family = options.family || "physical_makesafe";
  const docket = {
    id: "docket-fixture",
    org_id: "org-fixture",
    job_id: "job-fixture",
    output_content_hash: review.docket_output_content_hash,
    assembler_version: review.assembler_version,
    family_matrix_version: review.family_matrix_version,
    stage: "pre_xero",
    invoice_obligation_revision_id: options.pricingDisposition
      ? "obligation-fixture"
      : null,
    committed_at: "2026-08-04T00:00:00.000Z",
    envelope: {
      v2: { classification: { family } },
      pre_xero_docs_ready: options.preXeroDocsReady === true,
    },
    blockers: [],
    email_drafts: {},
    review_spec: {},
    local_invoice_proposal: null,
    xero_binding: null,
    artifact_count: 1,
    artifact_size_bytes: bytes.byteLength,
  };
  const defaultPackRow = {
    id: "pack-fixture",
    job_id: "job-fixture",
    pack_kind: "main",
    status: "drafted",
    report_doc_id: "doc-report-bound",
    invoice_doc_id: "doc-invoice-bound",
    swms_doc_id: null,
    sent_at: null,
  };
  const packRow = options.packRow === undefined
    ? defaultPackRow
    : options.packRow;
  const jobRow = options.jobRow === undefined
    ? {
      id: "job-fixture",
      type: "makesafe",
      status: "in_progress",
      metadata: {},
    }
    : options.jobRow;
  const detailRow = options.detailRow === undefined
    ? {
      job_id: "job-fixture",
      report_type: null,
      substatus: "admin_to_send_report",
      external_ref: "AJBR-70000",
      external_links: [],
      attendance_cycle_id: null,
      cycle_number: 1,
      requesting_company_slug: "aj",
      requesting_company_name: "AJS",
    }
    : options.detailRow;
  const rows: Record<string, unknown> = {
    ses_docket_review_current: review,
    makesafe_docket_revisions: docket,
    makesafe_docket_artifacts: [artifact],
    ses_docket_review_events: [],
    job_events: options.jobEvents || [],
    job_documents: [
      ...(document ? [document] : []),
      ...(options.packDocuments || [
        {
          id: "doc-report-bound",
          type: "makesafe_report",
          file_name: "Make Safe Report - fixture.pdf",
          storage_url: "https://documents.example/report-fixture.pdf",
        },
        {
          id: "doc-invoice-bound",
          type: "invoice",
          file_name: "Draft Xero Invoice - fixture.pdf",
          storage_url: "https://documents.example/invoice-fixture.pdf",
        },
      ]),
    ],
    makesafe_report_packs: packRow ? [packRow] : [],
    jobs: jobRow ? [jobRow] : [],
    makesafe_job_details: detailRow ? [detailRow] : [],
    makesafe_portal_capture_revisions: options.portalCaptures || [],
    job_service_reports: options.serviceReports || [{
      id: "service-report-current",
      job_id: "job-fixture",
      status: "submitted",
      submitted_at: "2026-08-04T00:00:00.000Z",
      created_at: "2026-08-04T00:00:00.000Z",
      cycle_number: 1,
      attendance_cycle_id: null,
      cycle_attribution: null,
    }],
    makesafe_invoice_obligation_revisions: options.pricingDisposition
      ? [{
        id: "obligation-fixture",
        job_id: "job-fixture",
        pricing_disposition: options.pricingDisposition,
      }]
      : [],
    makesafe_invoice_obligation_revisions_current: options.pricingDisposition
      ? [{
        id: "obligation-fixture",
        job_id: "job-fixture",
        pricing_disposition: options.pricingDisposition,
      }]
      : [],
  };
  const client = {
    rpc(name: string) {
      rpcCalls.push(name);
      return Promise.resolve({ data: {}, error: null });
    },
    storage: {
      from() {
        return {
          download: () =>
            Promise.resolve({
              data: new Blob([new Uint8Array(bytes).buffer]),
              error: null,
            }),
          createSignedUrl: (path: string) => {
            signedPaths.push(path);
            return Promise.resolve({
              data: { signedUrl: `https://signed.example.test/${path}` },
              error: null,
            });
          },
        };
      },
    },
    from(table: string) {
      let single = false;
      let columns = "";
      const project = (value: unknown) => {
        // These reads are column-projected in production, so a column the
        // caller forgets to select is genuinely absent here too.
        const projected = table === "makesafe_docket_artifacts" ||
          table === "makesafe_portal_capture_revisions";
        if (!projected || !columns) return value;
        const keys = columns.split(",").map((key) => key.trim());
        return (value as Array<Record<string, unknown>>).map((row) =>
          Object.fromEntries(
            keys.filter((key) => key in row).map((key) => [key, row[key]]),
          )
        );
      };
      const filters: Array<[string, unknown]> = [];
      const query: any = {
        select: (cols?: string) => {
          columns = String(cols || "");
          return query;
        },
        eq: (column: string, value: unknown) => {
          filters.push([column, value]);
          return query;
        },
        order: () => query,
        limit: () => query,
        maybeSingle: () => {
          single = true;
          return query;
        },
        then: (resolve: (value: unknown) => unknown) => {
          if (table === "job_events" && options.jobEventsError) {
            return Promise.resolve({
              data: null,
              error: options.jobEventsError,
            }).then(resolve);
          }
          const faultFor = options.jobEventsErrorForJob;
          if (
            table === "job_events" && faultFor &&
            filters.some(([column, value]) =>
              column === "job_id" && value === faultFor.job_id
            )
          ) {
            return Promise.resolve({ data: null, error: faultFor.error }).then(
              resolve,
            );
          }
          const artifactReadError = options.artifactReadErrors?.[
            table as "job_documents" | "job_service_reports"
          ];
          const isArtifactTruthRead = table === "job_service_reports" ||
            (table === "job_documents" && columns.includes("file_name"));
          if (artifactReadError && isArtifactTruthRead) {
            return Promise.resolve({ data: null, error: artifactReadError })
              .then(
                resolve,
              );
          }
          // Curated-bind events are read per job, so a fixture row that names
          // its own job is honoured here - a sibling's trail must not answer a
          // read scoped to the docket's job, or the test proves nothing.
          const scoped = table === "job_events"
            ? (rows[table] as Array<Record<string, unknown>>).filter((row) =>
              row.job_id === undefined ||
              filters.every(([column, value]) =>
                column !== "job_id" || row.job_id === value
              )
            )
            : rows[table];
          const value = project(scoped);
          return Promise.resolve({
            data: single && Array.isArray(value) ? value[0] || null : value,
            error: null,
          }).then(resolve);
        },
      };
      return query;
    },
  } as any;
  return { client, signedPaths, rpcCalls, review };
}

const SUPERSEDED_RAW = `sha256:${"1".repeat(64)}`;
const CORRECTED_RAW = `sha256:${"2".repeat(64)}`;
const SUPERSEDED_INPUT = `sha256:${"3".repeat(64)}`;
const CORRECTED_INPUT = `sha256:${"4".repeat(64)}`;
const SUPERSEDED_IDENTITY =
  "curation-revision:asbestos-misstatement/artifact:asbestos-misstatement";
const CORRECTED_IDENTITY =
  "curation-revision:hardie-correction/artifact:hardie-correction";

function supersessionEvent() {
  return {
    created_at: "2026-08-04T01:00:00.000Z",
    detail_json: {
      document_id: "source-document",
      supersedes_prior_bind: true,
      source_identity: CORRECTED_IDENTITY,
      expected_raw_sha256: CORRECTED_RAW,
      report_input_hash: CORRECTED_INPUT,
      prior_source_identity: SUPERSEDED_IDENTITY,
      prior_expected_raw_sha256: SUPERSEDED_RAW,
      prior_report_input_hash: SUPERSEDED_INPUT,
    },
  };
}

async function curatedReportArtifact(
  bytes: Uint8Array,
  stamp: {
    source_identity: string;
    expected_raw_sha256: string;
    report_input_hash: string;
  },
) {
  const contentHash = await sesSha256Bytes(bytes);
  const rawHash = await rawSha256(bytes);
  const [revisionId, artifactId] = stamp.source_identity
    .replace("curation-revision:", "").split("/artifact:");
  return {
    role: "supporting_report_pdf",
    object_key: "makesafe-docket-artifacts/docket-fixture/report.pdf",
    media_type: "application/pdf",
    content_hash: contentHash,
    size_bytes: bytes.byteLength,
    metadata: {
      source_kind: "durable_curated_revision",
      source_identity: stamp.source_identity,
      source_document_id: "source-document",
      source_revision_id: revisionId,
      source_artifact_id: artifactId,
      source_artifact_content_hash: contentHash,
      expected_raw_sha256: `sha256:${rawHash}`,
      output_sha256: `sha256:${rawHash}`,
      render_hash: rawHash,
      evidence_source: "current_cycle_curated_makesafe_report",
      report_contract_version: MAKESAFE_REPORT_CONTRACT_VERSION,
      report_input_hash: stamp.report_input_hash,
      report_renderer_version: MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_VERSION,
      report_renderer_source_revision:
        MAKESAFE_REPORT_AUTHORITATIVE_SOURCE_REVISION,
      report_renderer_script_sha256:
        MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_SHA256,
    },
  };
}

Deno.test("a docket revision built from superseded curated content stops being served", async () => {
  const bytes = new TextEncoder().encode("%PDF-1.7\nsuperseded fixture");
  const artifact = await curatedReportArtifact(bytes, {
    source_identity: SUPERSEDED_IDENTITY,
    expected_raw_sha256: SUPERSEDED_RAW,
    report_input_hash: SUPERSEDED_INPUT,
  });
  // The artifact self-verifies against its own stored copy: only the curated
  // bind ledger knows these bytes were superseded.
  const event = supersessionEvent();
  event.detail_json.prior_expected_raw_sha256 = String(
    artifact.metadata.expected_raw_sha256,
  );
  const { client, signedPaths, rpcCalls, review } = reviewPackClient(
    artifact,
    bytes,
    { jobEvents: [event] },
  );
  const pack = await getSesReviewablePackAction(
    client,
    { mode: "api_key", user: null },
    "docket-fixture",
  );
  assertEquals(pack.artifacts, []);
  assertEquals(pack.suppressed_artifacts[0].signed_url, null);
  assertEquals(
    pack.suppressed_artifacts[0].suppression_reason,
    "curated_source_superseded",
  );
  assertEquals(pack.blockers[0].code, "curated_source_missing");
  assertStringIncludes(
    String(pack.blockers[0].recovery_action || ""),
    "prepare_ses_docket_revision",
  );
  assertEquals(signedPaths, []);

  const error = await assertRejects(
    () =>
      signOffSesDocketAction(
        client,
        {
          mode: "jwt",
          user: { id: "captain-fixture", email: "", role: "owner" },
        },
        {
          docket_revision_id: "docket-fixture",
          expected_output_content_hash: review.docket_output_content_hash,
        },
      ),
    SesActionError,
    "superseded by a corrected curated bind",
  );
  assertEquals((error as SesActionError).status, 409);
  assertEquals(rpcCalls, []);
});

Deno.test("the corrected curated content stays served, and an unreadable bind ledger does not", async () => {
  const bytes = new TextEncoder().encode("%PDF-1.7\ncorrected fixture");
  const artifact = await curatedReportArtifact(bytes, {
    source_identity: CORRECTED_IDENTITY,
    expected_raw_sha256: CORRECTED_RAW,
    report_input_hash: CORRECTED_INPUT,
  });
  const event = supersessionEvent();
  event.detail_json.expected_raw_sha256 = String(
    artifact.metadata.expected_raw_sha256,
  );
  const current = reviewPackClient(artifact, bytes, { jobEvents: [event] });
  const pack = await getSesReviewablePackAction(
    current.client,
    { mode: "api_key", user: null },
    "docket-fixture",
  );
  assertEquals(pack.artifacts.length, 1);
  assertEquals(pack.suppressed_artifacts, []);
  assertEquals(pack.blockers, []);
  assertEquals(current.signedPaths, ["docket-fixture/report.pdf"]);

  const unreadable = reviewPackClient(artifact, bytes, {
    jobEventsError: { message: "curated bind ledger unavailable" },
  });
  const degraded = await getSesReviewablePackAction(
    unreadable.client,
    { mode: "api_key", user: null },
    "docket-fixture",
  );
  assertEquals(degraded.artifacts, []);
  assertEquals(
    degraded.suppressed_artifacts[0].suppression_reason,
    "curated_source_supersession_unreadable",
  );
  assertEquals(unreadable.signedPaths, []);
});

Deno.test("get_ses_reviewable_pack presents refused / ready / incomplete as three distinct states", async () => {
  // 1. Refused — a read-time trust refusal must name its reason instead of
  //    green-ticking, and must not read as a send-pipeline failure.
  const supersededBytes = new TextEncoder().encode("%PDF-1.7\nsuperseded");
  const supersededArtifact = await curatedReportArtifact(supersededBytes, {
    source_identity: SUPERSEDED_IDENTITY,
    expected_raw_sha256: SUPERSEDED_RAW,
    report_input_hash: SUPERSEDED_INPUT,
  });
  const supersededMark = supersessionEvent();
  supersededMark.detail_json.prior_expected_raw_sha256 = String(
    supersededArtifact.metadata.expected_raw_sha256,
  );
  const refused = await getSesReviewablePackAction(
    reviewPackClient(supersededArtifact, supersededBytes, {
      jobEvents: [supersededMark],
      // Even a docs-ready docket is refused once the served report is untrusted.
      preXeroDocsReady: true,
    }).client,
    { mode: "api_key", user: null },
    "docket-fixture",
  );
  assertEquals(refused.presentation.kind, "refused");
  assertEquals(refused.presentation.state, "refused");
  assertEquals(refused.presentation.review_state, "U4_BLOCKED");
  assertEquals(refused.presentation.pre_xero_docs_ready, false);
  assertEquals(refused.presentation.docket_revision_id, "docket-fixture");
  assertStringIncludes(String(refused.presentation.reason || ""), "curated");
  // A refusal is an honest stop: never the legacy send-pipeline "failed" word.
  assertEquals(refused.presentation.state === "failed", false);
  // Every named refusal reaches the operator with a fact and a recovery action.
  assertEquals(refused.blockers.length, 1);
  assertEquals(refused.blockers[0].state, "refused");
  assertStringIncludes(String(refused.blockers[0].fact || ""), "curated");

  // 2. Ready — trusted pack on a docs-ready docket. No invented blocker.
  const goodBytes = new TextEncoder().encode("%PDF-1.7\ncorrected");
  const goodArtifact = await curatedReportArtifact(goodBytes, {
    source_identity: CORRECTED_IDENTITY,
    expected_raw_sha256: CORRECTED_RAW,
    report_input_hash: CORRECTED_INPUT,
  });
  const goodMark = supersessionEvent();
  goodMark.detail_json.expected_raw_sha256 = String(
    goodArtifact.metadata.expected_raw_sha256,
  );
  const ready = await getSesReviewablePackAction(
    reviewPackClient(goodArtifact, goodBytes, {
      jobEvents: [goodMark],
      preXeroDocsReady: true,
    }).client,
    { mode: "api_key", user: null },
    "docket-fixture",
  );
  assertEquals(ready.presentation.kind, "ready");
  assertEquals(ready.presentation.state, "drafted");
  assertEquals(ready.presentation.review_state, "READY");
  assertEquals(ready.presentation.pre_xero_docs_ready, true);
  assertEquals(ready.presentation.reason, null);
  assertEquals(ready.blockers, []);

  // 3. Incomplete — same trusted pack, docket not yet docs-ready and naming no
  //    refusal. Still assembling is not a refusal and not a green ready.
  const incomplete = await getSesReviewablePackAction(
    reviewPackClient(goodArtifact, goodBytes, {
      jobEvents: [goodMark],
      preXeroDocsReady: false,
    }).client,
    { mode: "api_key", user: null },
    "docket-fixture",
  );
  assertEquals(incomplete.presentation.kind, "incomplete");
  assertEquals(incomplete.presentation.pre_xero_docs_ready, false);
  assertStringIncludes(
    String(incomplete.presentation.reason || ""),
    "still assembling",
  );
  assertEquals(incomplete.blockers, []);

  assertEquals(
    new Set([
      refused.presentation.kind,
      ready.presentation.kind,
      incomplete.presentation.kind,
    ]).size,
    3,
  );
});

Deno.test("get_ses_reviewable_pack: ready-stamped physical pack without report_doc_id is incomplete (261015)", async () => {
  // Board already refused this class after #725/#726; the review pack still
  // greened it because presentSesPackHonesty was called without bind-floor
  // inputs. A ready stamp + attached report artifact is not a bind.
  const bytes = new TextEncoder().encode("%PDF-1.7\nno-bind");
  const artifact = await curatedReportArtifact(bytes, {
    source_identity: CORRECTED_IDENTITY,
    expected_raw_sha256: CORRECTED_RAW,
    report_input_hash: CORRECTED_INPUT,
  });
  const mark = supersessionEvent();
  mark.detail_json.expected_raw_sha256 = String(
    artifact.metadata.expected_raw_sha256,
  );
  const unbound = await getSesReviewablePackAction(
    reviewPackClient(artifact, bytes, {
      jobEvents: [mark],
      preXeroDocsReady: true,
      packRow: {
        id: "pack-unbound",
        job_id: "job-fixture",
        pack_kind: "main",
        status: "drafted",
        report_doc_id: null,
        invoice_doc_id: null,
        swms_doc_id: null,
        sent_at: null,
      },
    }).client,
    { mode: "api_key", user: null },
    "docket-fixture",
  );
  assertEquals(unbound.presentation.kind, "incomplete");
  assertEquals(unbound.presentation.pre_xero_docs_ready, false);
  assertEquals(unbound.presentation.review_state, "U4_BLOCKED");
  assertStringIncludes(
    String(unbound.presentation.reason || ""),
    "report_doc_id",
  );
  assertEquals(unbound.caveats[0].state, "caveat");
  assertEquals(unbound.caveats[0].code, "required_pack_artifact_missing");
  assertEquals(unbound.artifact_truth.missing_required, ["report", "invoice"]);
});

Deno.test("Captain signoff records a reviewed pack while preserving its missing-artifact caveat", async () => {
  const bytes = new TextEncoder().encode("%PDF-1.7\nmissing-bind-signoff");
  const artifact = await curatedReportArtifact(bytes, {
    source_identity: CORRECTED_IDENTITY,
    expected_raw_sha256: CORRECTED_RAW,
    report_input_hash: CORRECTED_INPUT,
  });
  const mark = supersessionEvent();
  mark.detail_json.expected_raw_sha256 = String(
    artifact.metadata.expected_raw_sha256,
  );
  const fixture = reviewPackClient(artifact, bytes, {
    jobEvents: [mark],
    preXeroDocsReady: true,
    packRow: {
      id: "pack-signoff-unbound",
      job_id: "job-fixture",
      pack_kind: "main",
      status: "drafted",
      report_doc_id: null,
      invoice_doc_id: "doc-invoice-bound",
      swms_doc_id: null,
      sent_at: null,
    },
  });

  const result = await signOffSesDocketAction(
    fixture.client,
    {
      mode: "jwt",
      user: { id: "captain-fixture", email: "", role: "owner" },
    },
    {
      docket_revision_id: "docket-fixture",
      expected_output_content_hash: fixture.review.docket_output_content_hash,
    },
  );
  assertEquals(fixture.rpcCalls, ["record_ses_docket_review_state_v1"]);
  assertEquals(result.caveats[0].code, "required_pack_artifact_missing");
  assertEquals(result.artifact_truth.missing_required, ["report"]);
});

Deno.test("artifact read faults stay non-blocking at review and Captain signoff while known MLB requirements remain visible", async () => {
  const bytes = new TextEncoder().encode("%PDF-1.7\nunreadable-artifacts");
  const artifact = await curatedReportArtifact(bytes, {
    source_identity: CORRECTED_IDENTITY,
    expected_raw_sha256: CORRECTED_RAW,
    report_input_hash: CORRECTED_INPUT,
  });
  const mark = supersessionEvent();
  mark.detail_json.expected_raw_sha256 = String(
    artifact.metadata.expected_raw_sha256,
  );
  const fixture = reviewPackClient(artifact, bytes, {
    jobEvents: [mark],
    preXeroDocsReady: true,
    family: "physical_makesafe",
    pricingDisposition: "priced_from_canon",
    jobRow: {
      id: "job-fixture",
      type: "makesafe",
      status: "in_progress",
      metadata: { makesafe_job_family: "physical_makesafe" },
    },
    detailRow: {
      job_id: "job-fixture",
      report_type: null,
      substatus: "admin_to_send_report",
      external_ref: "MLB-70000",
      external_links: [],
      attendance_cycle_id: "cycle-fixture",
      cycle_number: 1,
      requesting_company_slug: "mlb",
      requesting_company_name: "ML Builders",
    },
    packRow: {
      id: "pack-unreadable",
      job_id: "job-fixture",
      pack_kind: "main",
      status: "drafted",
      report_doc_id: "doc-report-bound",
      invoice_doc_id: "doc-invoice-bound",
      swms_doc_id: "doc-swms-bound",
      sent_at: null,
    },
    packDocuments: [{
      id: "doc-report-bound",
      type: "makesafe_report",
      file_name: "Make Safe Report.pdf",
      storage_url: "https://documents.example/report.pdf",
    }, {
      id: "doc-invoice-bound",
      type: "invoice",
      file_name: "Invoice.pdf",
      storage_url: "https://documents.example/invoice.pdf",
    }, {
      id: "doc-swms-bound",
      type: "swms",
      file_name: "Safe Work Method Statement.pdf",
      storage_url: "https://documents.example/swms.pdf",
    }],
    artifactReadErrors: {
      job_service_reports: { message: "trade reports unavailable" },
    },
  });

  const pack = await getSesReviewablePackAction(
    fixture.client,
    { mode: "api_key", user: null },
    "docket-fixture",
  );
  assertEquals(pack.presentation.kind, "incomplete");
  assertEquals(pack.blockers, []);
  assertEquals(pack.caveats.at(-1)?.code, "pack_artifact_truth_unreadable");
  assertEquals(pack.artifact_truth.read_state, "unreadable");
  assertEquals(pack.artifact_truth.required_documents, {
    report: true,
    invoice: true,
    swms: true,
  });
  assertEquals(pack.artifact_truth.document_resolution, {
    report: null,
    invoice: null,
    swms: null,
  });
  assertEquals(pack.artifact_truth.unresolved_required, [
    "report",
    "invoice",
    "swms",
  ]);
  assertEquals(pack.artifact_truth.document_ids, {
    report: "doc-report-bound",
    invoice: "doc-invoice-bound",
    swms: "doc-swms-bound",
  });

  const signedOff = await signOffSesDocketAction(
    fixture.client,
    {
      mode: "jwt",
      user: { id: "captain-fixture", email: "", role: "owner" },
    },
    {
      docket_revision_id: "docket-fixture",
      expected_output_content_hash: fixture.review.docket_output_content_hash,
    },
  );
  assertEquals(fixture.rpcCalls, ["record_ses_docket_review_state_v1"]);
  assertEquals(
    signedOff.caveats.at(-1)?.code,
    "pack_artifact_truth_unreadable",
  );
});

Deno.test("review pack routes unreadable document rows through the shared caveat", async () => {
  const bytes = new TextEncoder().encode("%PDF-1.7\nunreadable-documents");
  const artifact = await curatedReportArtifact(bytes, {
    source_identity: CORRECTED_IDENTITY,
    expected_raw_sha256: CORRECTED_RAW,
    report_input_hash: CORRECTED_INPUT,
  });
  const mark = supersessionEvent();
  mark.detail_json.expected_raw_sha256 = String(
    artifact.metadata.expected_raw_sha256,
  );
  const pack = await getSesReviewablePackAction(
    reviewPackClient(artifact, bytes, {
      jobEvents: [mark],
      preXeroDocsReady: true,
      artifactReadErrors: {
        job_documents: { message: "document index unavailable" },
      },
    }).client,
    { mode: "api_key", user: null },
    "docket-fixture",
  );

  assertEquals(pack.presentation.kind, "incomplete");
  assertEquals(pack.blockers, []);
  assertEquals(pack.caveats.at(-1)?.code, "pack_artifact_truth_unreadable");
  assertEquals(pack.artifact_truth.document_resolution.report, null);
});

Deno.test("get_ses_reviewable_pack: physical pack with bound report and invoice stays ready (261241)", async () => {
  const bytes = new TextEncoder().encode("%PDF-1.7\nbound-ready");
  const artifact = await curatedReportArtifact(bytes, {
    source_identity: CORRECTED_IDENTITY,
    expected_raw_sha256: CORRECTED_RAW,
    report_input_hash: CORRECTED_INPUT,
  });
  const mark = supersessionEvent();
  mark.detail_json.expected_raw_sha256 = String(
    artifact.metadata.expected_raw_sha256,
  );
  const bound = await getSesReviewablePackAction(
    reviewPackClient(artifact, bytes, {
      jobEvents: [mark],
      preXeroDocsReady: true,
      packRow: {
        id: "pack-bound",
        job_id: "job-fixture",
        pack_kind: "main",
        status: "drafted",
        report_doc_id: "doc-physical-report",
        invoice_doc_id: "doc-physical-invoice",
        swms_doc_id: null,
        sent_at: null,
      },
      packDocuments: [
        {
          id: "doc-physical-report",
          type: "makesafe_report",
          file_name: "Make Safe Report - SWMS-261241.pdf",
          storage_url: "https://documents.example/SWMS-261241-report.pdf",
        },
        {
          id: "doc-physical-invoice",
          type: "invoice",
          file_name: "Draft Xero Invoice - SWMS-261241.pdf",
          storage_url: "https://documents.example/SWMS-261241-invoice.pdf",
        },
      ],
    }).client,
    { mode: "api_key", user: null },
    "docket-fixture",
  );
  assertEquals(bound.presentation.kind, "ready");
  assertEquals(bound.presentation.pre_xero_docs_ready, true);
  assertEquals(bound.presentation.review_state, "READY");
  assertEquals(bound.presentation.reason, null);
});

Deno.test("get_ses_reviewable_pack: bound physical report without a selected current-cycle trade report is incomplete", async () => {
  const bytes = new TextEncoder().encode("%PDF-1.7\nno-selected-report");
  const artifact = await curatedReportArtifact(bytes, {
    source_identity: CORRECTED_IDENTITY,
    expected_raw_sha256: CORRECTED_RAW,
    report_input_hash: CORRECTED_INPUT,
  });
  const mark = supersessionEvent();
  mark.detail_json.expected_raw_sha256 = String(
    artifact.metadata.expected_raw_sha256,
  );
  const result = await getSesReviewablePackAction(
    reviewPackClient(artifact, bytes, {
      jobEvents: [mark],
      preXeroDocsReady: true,
      detailRow: {
        job_id: "job-fixture",
        report_type: null,
        substatus: "admin_to_send_report",
        external_ref: "AJBR-70000",
        external_links: [],
        attendance_cycle_id: "cycle-current",
        cycle_number: 2,
        reattend_count: 1,
        requesting_company_slug: "aj",
        requesting_company_name: "AJS",
      },
      serviceReports: [{
        id: "service-report-prior-cycle",
        job_id: "job-fixture",
        status: "submitted",
        submitted_at: "2026-08-03T00:00:00.000Z",
        created_at: "2026-08-03T00:00:00.000Z",
        cycle_number: 1,
        attendance_cycle_id: "cycle-prior",
        cycle_attribution: "bound",
      }],
    }).client,
    { mode: "api_key", user: null },
    "docket-fixture",
  );

  assertEquals(result.presentation.kind, "incomplete");
  assertEquals(result.presentation.pre_xero_docs_ready, false);
  assertStringIncludes(
    String(result.presentation.reason || ""),
    "selected current-cycle trade report",
  );
});

Deno.test("get_ses_reviewable_pack: roof card with portal proof and bound artifacts is ready", async () => {
  // A screenshot-bearing ledger capture must satisfy the report-only family
  // floor here exactly as it does on the board (validLedgerScreenshot reads
  // signal + screenshot_media_type/_content_hash/_size_bytes off the select).
  const bytes = new TextEncoder().encode("%PDF-1.7\nroof-capture");
  const artifact = await curatedReportArtifact(bytes, {
    source_identity: CORRECTED_IDENTITY,
    expected_raw_sha256: CORRECTED_RAW,
    report_input_hash: CORRECTED_INPUT,
  });
  const mark = supersessionEvent();
  mark.detail_json.expected_raw_sha256 = String(
    artifact.metadata.expected_raw_sha256,
  );
  const portalUrl = "https://portal.primeeco.tech/share/roof-261234";
  const result = await getSesReviewablePackAction(
    reviewPackClient(artifact, bytes, {
      jobEvents: [mark],
      preXeroDocsReady: true,
      family: "ordinary_roof_portal",
      packRow: {
        id: "pack-roof",
        job_id: "job-fixture",
        pack_kind: "main",
        status: "drafted",
        report_doc_id: "doc-roof-report",
        invoice_doc_id: "doc-roof-invoice",
        swms_doc_id: null,
        sent_at: null,
      },
      packDocuments: [
        {
          id: "doc-roof-report",
          type: "roof_report",
          file_name: "Roof Report - SWMS-261234.pdf",
          storage_url: "https://documents.example/SWMS-261234-roof.pdf",
        },
        {
          id: "doc-roof-invoice",
          type: "invoice",
          file_name: "Draft Xero Invoice - SWMS-261234.pdf",
          storage_url: "https://documents.example/SWMS-261234-invoice.pdf",
        },
      ],
      detailRow: {
        job_id: "job-fixture",
        report_type: "roof_report",
        substatus: "allocated",
        external_ref: "MLB-26000",
        external_links: [{ url: portalUrl, kind: "roof_report" }],
        attendance_cycle_id: "cycle-1",
        cycle_number: 1,
        portal_verified_at: null,
        portal_verified_cycle: null,
        portal_verified_signal: null,
        requesting_company_slug: "mlb",
        requesting_company_name: "MLB",
      },
      portalCaptures: [{
        id: "capture-roof-done",
        job_id: "job-fixture",
        attendance_cycle_id: "cycle-1",
        role: "roof_report",
        source_url: portalUrl,
        capture_result: "done",
        status: "verified",
        capture_producer: "capture_portal_evidence.py/v1",
        captured_by: "portal-observer",
        captured_at: "2026-08-04T00:30:00.000Z",
        builder_reference: "",
        source_content_hash: `sha256:${"5".repeat(64)}`,
        signal: "form locked/submitted",
        screenshot_object_key:
          "makesafe-docket-artifacts/portal-captures/job-fixture/cycle-1/roof_report/abc.png",
        screenshot_media_type: "image/png",
        screenshot_content_hash: `sha256:${"6".repeat(64)}`,
        screenshot_size_bytes: 4096,
        makesafe_fact_version: 1,
      }],
    }).client,
    { mode: "api_key", user: null },
    "docket-fixture",
  );
  assertEquals(result.presentation.kind, "ready");
  assertEquals(result.presentation.pre_xero_docs_ready, true);
  assertEquals(result.presentation.review_state, "READY");
});

Deno.test("get_ses_reviewable_pack: roof portal proof without bound artifacts is incomplete", async () => {
  // Legacy report-only cards carry their proof in portal_verified_signal JSON
  // (skill-recorded captures with screenshot paths) rather than the ledger.
  // The board projects those via projectMakesafePortalCaptures; this surface
  // must agree even when the card has no attendance_cycle_id to read the
  // ledger with.
  const bytes = new TextEncoder().encode("%PDF-1.7\nroof-signal");
  const artifact = await curatedReportArtifact(bytes, {
    source_identity: CORRECTED_IDENTITY,
    expected_raw_sha256: CORRECTED_RAW,
    report_input_hash: CORRECTED_INPUT,
  });
  const mark = supersessionEvent();
  mark.detail_json.expected_raw_sha256 = String(
    artifact.metadata.expected_raw_sha256,
  );
  const portalUrl = "https://portal.primeeco.tech/share/roof-260900";
  const result = await getSesReviewablePackAction(
    reviewPackClient(artifact, bytes, {
      jobEvents: [mark],
      preXeroDocsReady: true,
      family: "ordinary_roof_portal",
      packRow: {
        id: "pack-roof-signal",
        job_id: "job-fixture",
        pack_kind: "main",
        status: "drafted",
        report_doc_id: null,
        invoice_doc_id: null,
        swms_doc_id: null,
        sent_at: null,
      },
      detailRow: {
        job_id: "job-fixture",
        report_type: "roof_report",
        substatus: "allocated",
        external_ref: "MLB-26001",
        external_links: [{ url: portalUrl, kind: "roof_report" }],
        attendance_cycle_id: null,
        cycle_number: 1,
        portal_verified_at: "2026-08-01T02:00:00.000Z",
        portal_verified_cycle: 1,
        portal_verified_signal: JSON.stringify([{
          status: "done",
          role: "roof_report",
          cycle_number: 1,
          url: portalUrl,
          locked: true,
          screenshot: "portal-captures/legacy-roof.png",
        }]),
        requesting_company_slug: "mlb",
        requesting_company_name: "MLB",
      },
      portalCaptures: [],
    }).client,
    { mode: "api_key", user: null },
    "docket-fixture",
  );
  assertEquals(result.presentation.kind, "incomplete");
  assertEquals(result.presentation.pre_xero_docs_ready, false);
  assertEquals(result.presentation.review_state, "U4_BLOCKED");
  assertStringIncludes(
    String(result.presentation.reason || ""),
    "report_doc_id",
  );
});

Deno.test("get_ses_reviewable_pack: assessment portal triad needs invoice but no local report pointer", async () => {
  const bytes = new TextEncoder().encode("%PDF-1.7\nassessment");
  const artifact = await curatedReportArtifact(bytes, {
    source_identity: CORRECTED_IDENTITY,
    expected_raw_sha256: CORRECTED_RAW,
    report_input_hash: CORRECTED_INPUT,
  });
  const links = [
    {
      role: "assessment_report",
      url: "https://portal.primeeco.tech/share/assessment-1",
    },
    {
      role: "photos",
      url: "https://portal.primeeco.tech/share/assessment-photos",
    },
    {
      role: "quote",
      url: "https://portal.primeeco.tech/share/assessment-quote",
    },
  ];
  const portalCaptures = links.map(
    ({ role, url }, index) => ({
      id: `capture-assessment-${role}`,
      job_id: "job-fixture",
      attendance_cycle_id: "cycle-1",
      role,
      source_url: url,
      capture_result: "done",
      status: "verified",
      capture_producer: "capture_portal_evidence.py/v1",
      captured_by: "portal-observer",
      captured_at: "2026-08-04T00:30:00.000Z",
      builder_reference: "",
      source_content_hash: `sha256:${String(index + 1).repeat(64)}`,
      signal: "form locked/submitted",
      screenshot_object_key: `portal/assessment-${role}.png`,
      screenshot_media_type: "image/png",
      screenshot_content_hash: `sha256:${String(index + 4).repeat(64)}`,
      screenshot_size_bytes: 4096,
      makesafe_fact_version: 1,
    }),
  );
  const result = await getSesReviewablePackAction(
    reviewPackClient(artifact, bytes, {
      preXeroDocsReady: true,
      family: "assessment_quote",
      packRow: {
        id: "pack-assessment",
        job_id: "job-fixture",
        pack_kind: "main",
        status: "drafted",
        report_doc_id: null,
        invoice_doc_id: "doc-assessment-invoice",
        swms_doc_id: null,
        sent_at: null,
      },
      packDocuments: [{
        id: "doc-assessment-invoice",
        type: "invoice",
        file_name: "Draft Xero Invoice - assessment.pdf",
        storage_url: "https://documents.example/assessment-invoice.pdf",
      }],
      detailRow: {
        job_id: "job-fixture",
        report_type: "assessment_report",
        substatus: "admin_to_send_report",
        external_ref: "MLB-ASSESSMENT-1",
        external_links: links,
        attendance_cycle_id: null,
        cycle_number: 1,
        portal_verified_at: "2026-08-04T00:30:00.000Z",
        portal_verified_cycle: 1,
        portal_verified_signal: JSON.stringify(
          links.map(({ role, url }) => ({
            status: "done",
            role,
            url,
            locked: true,
            screenshot: `assessment-${role}.png`,
            cycle_number: 1,
          })),
        ),
        requesting_company_slug: "mlb",
        requesting_company_name: "MLB",
      },
      portalCaptures,
    }).client,
    { mode: "api_key", user: null },
    "docket-fixture",
  );
  assertEquals(
    result.presentation.kind,
    "ready",
    JSON.stringify(result.presentation),
  );
  assertEquals(result.presentation.pre_xero_docs_ready, true);
});

Deno.test("get_ses_reviewable_pack: no-additional-charge release needs no invoice pointer", async () => {
  const bytes = new TextEncoder().encode("%PDF-1.7\nno-charge");
  const artifact = await curatedReportArtifact(bytes, {
    source_identity: CORRECTED_IDENTITY,
    expected_raw_sha256: CORRECTED_RAW,
    report_input_hash: CORRECTED_INPUT,
  });
  const mark = supersessionEvent();
  mark.detail_json.expected_raw_sha256 = String(
    artifact.metadata.expected_raw_sha256,
  );
  const result = await getSesReviewablePackAction(
    reviewPackClient(artifact, bytes, {
      jobEvents: [mark],
      preXeroDocsReady: true,
      pricingDisposition: "no_additional_charge",
      packRow: {
        id: "pack-no-charge",
        job_id: "job-fixture",
        pack_kind: "main",
        status: "drafted",
        report_doc_id: "doc-no-charge-report",
        invoice_doc_id: null,
        swms_doc_id: null,
        sent_at: null,
      },
      packDocuments: [{
        id: "doc-no-charge-report",
        type: "makesafe_report",
        file_name: "Make Safe Report - no charge.pdf",
        storage_url: "https://documents.example/no-charge-report.pdf",
      }],
    }).client,
    { mode: "api_key", user: null },
    "docket-fixture",
  );
  assertEquals(
    result.presentation.kind,
    "ready",
    JSON.stringify(result.presentation),
  );
  assertEquals(result.presentation.pre_xero_docs_ready, true);
});

Deno.test("retired commercial and self-consistent raw provenance remain untrusted without job-specific code", () => {
  const retiredCommercial = inspectSesSupportingReportProof({
    role: "supporting_report_pdf",
    media_type: "application/pdf",
    content_hash: `sha256:${"a".repeat(64)}`,
    size_bytes: 100,
    metadata: {
      evidence_source: "current_cycle_curated_makesafe_report",
      report_renderer_version: "secureworks.ops-api-jspdf/retired",
      render_hash: "b".repeat(64),
    },
  });
  assertEquals(retiredCommercial, {
    trusted: false,
    reason: "independent_source_kind_missing",
  });

  const selfConsistentRaw = inspectSesSupportingReportProof({
    role: "supporting_report_pdf",
    media_type: "application/pdf",
    content_hash: `sha256:${"c".repeat(64)}`,
    size_bytes: 100,
    metadata: {
      source_kind: "durable_curated_revision",
      source_identity: "document-raw-fixture",
      source_document_id: "document-raw-fixture",
      source_revision_id: "revision-raw-fixture",
      source_artifact_id: "artifact-raw-fixture",
      source_artifact_content_hash: `sha256:${"c".repeat(64)}`,
      expected_raw_sha256: `sha256:${"d".repeat(64)}`,
      output_sha256: `sha256:${"d".repeat(64)}`,
      render_hash: "d".repeat(64),
      evidence_source: "current_cycle_curated_makesafe_report",
      report_contract_version: MAKESAFE_REPORT_CONTRACT_VERSION,
    },
  });
  assertEquals(selfConsistentRaw, {
    trusted: false,
    reason: "source_identity_self_reference",
  });
});

Deno.test(
  "Tuart-style previously_committed pack cannot self-certify completeness without report_input_hash",
  () => {
    // Concrete instance: SWMS-261015 restored bytes 933d83bd... with
    // previously_committed_pdf provenance but no bind-time report_input_hash.
    // Being restorable must not equal being complete (check 8).
    const tuartStyle = inspectSesSupportingReportProof({
      id: "artifact-current-tuart-style",
      role: "supporting_report_pdf",
      media_type: "application/pdf",
      content_hash: `sha256:${"e".repeat(64)}`,
      size_bytes: 100,
      metadata: {
        source_kind: "previously_committed_pdf",
        source_identity:
          "docket-revision:541cc3e5-acd7-5d1b-8e39-f359016f5cf7/artifact:2b6bb5a0-faa3-4d94-810e-41fa65f1ba26",
        source_document_id: "f41f9f35-f7ab-469b-9511-e656bd8a21aa",
        source_revision_id: "541cc3e5-acd7-5d1b-8e39-f359016f5cf7",
        source_artifact_id: "2b6bb5a0-faa3-4d94-810e-41fa65f1ba26",
        source_artifact_content_hash: `sha256:${"e".repeat(64)}`,
        expected_raw_sha256: `sha256:${"f".repeat(64)}`,
        output_sha256: `sha256:${"f".repeat(64)}`,
        render_hash: "f".repeat(64),
        evidence_source: "current_cycle_curated_makesafe_report",
        report_contract_version: MAKESAFE_REPORT_CONTRACT_VERSION,
        // deliberately no report_input_hash — the incompleteness self-vouch
      },
    });
    assertEquals(tuartStyle, {
      trusted: false,
      reason: "independent_completeness_proof_missing",
    });

    const selfPointingArtifact = inspectSesSupportingReportProof({
      id: "artifact-self",
      role: "supporting_report_pdf",
      media_type: "application/pdf",
      content_hash: `sha256:${"e".repeat(64)}`,
      size_bytes: 100,
      metadata: {
        source_kind: "previously_committed_pdf",
        source_identity: "docket-revision:revision-self/artifact:artifact-self",
        source_document_id: "document-other",
        source_revision_id: "revision-self",
        source_artifact_id: "artifact-self",
        source_artifact_content_hash: `sha256:${"e".repeat(64)}`,
        expected_raw_sha256: `sha256:${"f".repeat(64)}`,
        output_sha256: `sha256:${"f".repeat(64)}`,
        render_hash: "f".repeat(64),
        report_input_hash: `sha256:${"a".repeat(64)}`,
        evidence_source: "current_cycle_curated_makesafe_report",
        report_contract_version: MAKESAFE_REPORT_CONTRACT_VERSION,
      },
    });
    assertEquals(selfPointingArtifact, {
      trusted: false,
      reason: "source_identity_self_reference",
    });
  },
);

Deno.test("review pack serves unproved report bytes with a visible caveat", async () => {
  const bytes = new TextEncoder().encode("%PDF-1.7\nlegacy fixture");
  const artifact = {
    role: "supporting_report_pdf",
    object_key: "makesafe-docket-artifacts/docket-fixture/report.pdf",
    media_type: "application/pdf",
    content_hash: await sesSha256Bytes(bytes),
    size_bytes: bytes.byteLength,
    metadata: {
      evidence_source: "current_cycle_curated_makesafe_report",
      report_renderer_version: "secureworks.ops-api-jspdf/retired",
      render_hash: await rawSha256(bytes),
    },
  };
  const { client, signedPaths } = reviewPackClient(artifact, bytes, {
    preXeroDocsReady: true,
  });
  const pack = await getSesReviewablePackAction(
    client,
    { mode: "api_key", user: null },
    "docket-fixture",
  );
  assertEquals(pack.artifacts.length, 1);
  assertEquals(pack.artifacts[0].trust_state, "caveat");
  assertEquals(pack.suppressed_artifacts, []);
  assertEquals(
    pack.caveats[0].code,
    "curated_source_missing",
  );
  assertEquals(pack.blockers, []);
  assertEquals(pack.presentation.kind, "ready");
  assertEquals(pack.presentation.pre_xero_docs_ready, true);
  assertEquals(
    (pack.caveats[0] as any).evidence.suppression_reason,
    "independent_source_kind_missing",
  );
  assertEquals(signedPaths, ["docket-fixture/report.pdf"]);
});

Deno.test("Captain signoff remains reachable with a report-source caveat", async () => {
  const bytes = new TextEncoder().encode("%PDF-1.7\nlegacy fixture");
  const artifact = {
    role: "supporting_report_pdf",
    object_key: "makesafe-docket-artifacts/docket-fixture/report.pdf",
    media_type: "application/pdf",
    content_hash: await sesSha256Bytes(bytes),
    size_bytes: bytes.byteLength,
    metadata: {
      evidence_source: "current_cycle_curated_makesafe_report",
      report_renderer_version: "secureworks.ops-api-jspdf/retired",
      render_hash: await rawSha256(bytes),
    },
  };
  const { client, rpcCalls, review } = reviewPackClient(artifact, bytes, {
    preXeroDocsReady: true,
  });
  await signOffSesDocketAction(
    client,
    {
      mode: "jwt",
      user: {
        id: "captain-fixture",
        email: "",
        role: "owner",
      },
    },
    {
      docket_revision_id: "docket-fixture",
      expected_output_content_hash: review.docket_output_content_hash,
    },
  );
  assertEquals(rpcCalls, ["record_ses_docket_review_state_v1"]);
});

Deno.test(
  "review pack serves Tuart-style report with missing completeness proof as a caveat",
  async () => {
    // Old code trusted this shape (byte-verified previously_committed without
    // report_input_hash). That is the self-vouch gate this task closes.
    const bytes = new TextEncoder().encode(
      "%PDF-1.7\ntuart incomplete fixture",
    );
    const contentHash = await sesSha256Bytes(bytes);
    const rawHash = await rawSha256(bytes);
    const artifact = {
      role: "supporting_report_pdf",
      object_key: "makesafe-docket-artifacts/docket-fixture/report.pdf",
      media_type: "application/pdf",
      content_hash: contentHash,
      size_bytes: bytes.byteLength,
      metadata: {
        source_kind: "previously_committed_pdf",
        source_identity:
          "docket-revision:source-revision/artifact:source-artifact",
        source_document_id: "source-document",
        source_revision_id: "source-revision",
        source_artifact_id: "source-artifact",
        source_artifact_content_hash: contentHash,
        expected_raw_sha256: `sha256:${rawHash}`,
        output_sha256: `sha256:${rawHash}`,
        render_hash: rawHash,
        evidence_source: "current_cycle_curated_makesafe_report",
        report_contract_version: MAKESAFE_REPORT_CONTRACT_VERSION,
      },
    };
    const { client, signedPaths } = reviewPackClient(artifact, bytes);
    const pack = await getSesReviewablePackAction(
      client,
      { mode: "api_key", user: null },
      "docket-fixture",
    );
    assertEquals(pack.artifacts.length, 1);
    assertEquals(pack.artifacts[0].trust_state, "caveat");
    assertEquals(pack.suppressed_artifacts, []);
    assertEquals(
      pack.caveats[0].code,
      "curated_source_missing",
    );
    assertEquals(pack.blockers, []);
    assertEquals(
      (pack.caveats[0] as any).evidence.suppression_reason,
      "independent_completeness_proof_missing",
    );
    assertEquals(signedPaths, ["docket-fixture/report.pdf"]);
  },
);

Deno.test(
  "review pack keeps a previously committed report only when completeness proof is bound",
  async () => {
    const bytes = new TextEncoder().encode(
      "%PDF-1.7\ntrusted complete fixture",
    );
    const contentHash = await sesSha256Bytes(bytes);
    const rawHash = await rawSha256(bytes);
    const artifact = {
      role: "supporting_report_pdf",
      object_key: "makesafe-docket-artifacts/docket-fixture/report.pdf",
      media_type: "application/pdf",
      content_hash: contentHash,
      size_bytes: bytes.byteLength,
      metadata: {
        source_kind: "previously_committed_pdf",
        source_identity:
          "docket-revision:source-revision/artifact:source-artifact",
        source_document_id: "source-document",
        source_revision_id: "source-revision",
        source_artifact_id: "source-artifact",
        source_artifact_content_hash: contentHash,
        expected_raw_sha256: `sha256:${rawHash}`,
        output_sha256: `sha256:${rawHash}`,
        render_hash: rawHash,
        report_input_hash: `sha256:${"a".repeat(64)}`,
        evidence_source: "current_cycle_curated_makesafe_report",
        report_contract_version: MAKESAFE_REPORT_CONTRACT_VERSION,
      },
    };
    const { client, signedPaths } = reviewPackClient(artifact, bytes);
    const pack = await getSesReviewablePackAction(
      client,
      { mode: "api_key", user: null },
      "docket-fixture",
    );
    assertEquals(pack.artifacts.length, 1);
    assertEquals(pack.suppressed_artifacts, []);
    assertEquals(pack.blockers, []);
    assertEquals(signedPaths, ["docket-fixture/report.pdf"]);
  },
);

Deno.test(
  "review pack suppresses a thin artifact whose document names different report bytes",
  async () => {
    // Maylands shape: a legacy revision carrying a borrowed report_input_hash
    // over bytes the bound document does not describe must not be signed off.
    const bytes = new TextEncoder().encode("%PDF-1.7\nthin borrowed fixture");
    const contentHash = await sesSha256Bytes(bytes);
    const rawHash = await rawSha256(bytes);
    const artifact = {
      id: "artifact-thin",
      role: "supporting_report_pdf",
      object_key: "makesafe-docket-artifacts/docket-fixture/report.pdf",
      media_type: "application/pdf",
      content_hash: contentHash,
      size_bytes: bytes.byteLength,
      metadata: {
        source_kind: "previously_committed_pdf",
        source_identity:
          "docket-revision:source-revision/artifact:source-artifact",
        source_document_id: "source-document",
        report_document_id: "source-document",
        source_revision_id: "source-revision",
        source_artifact_id: "source-artifact",
        source_artifact_content_hash: contentHash,
        expected_raw_sha256: `sha256:${rawHash}`,
        output_sha256: `sha256:${rawHash}`,
        render_hash: rawHash,
        report_input_hash: `sha256:${"a".repeat(64)}`,
        evidence_source: "current_cycle_curated_makesafe_report",
        report_contract_version: MAKESAFE_REPORT_CONTRACT_VERSION,
      },
    };
    const { client, signedPaths } = reviewPackClient(artifact, bytes, {
      boundDocument: {
        id: "source-document",
        data_snapshot_json: { report_render_hash: "b".repeat(64) },
      },
    });
    const pack = await getSesReviewablePackAction(
      client,
      { mode: "api_key", user: null },
      "docket-fixture",
    );
    assertEquals(pack.artifacts, []);
    assertEquals(
      pack.suppressed_artifacts[0].suppression_reason,
      "source_document_bytes_diverged",
    );
    assertEquals(pack.blockers[0].code, "curated_source_missing");
    assertEquals(signedPaths, []);
  },
);

Deno.test(
  "review pack reads the artifact id so a self-pointing source is suppressed where bytes are served",
  async () => {
    const bytes = new TextEncoder().encode("%PDF-1.7\nself pointing fixture");
    const contentHash = await sesSha256Bytes(bytes);
    const rawHash = await rawSha256(bytes);
    const artifact = {
      id: "artifact-self",
      role: "supporting_report_pdf",
      object_key: "makesafe-docket-artifacts/docket-fixture/report.pdf",
      media_type: "application/pdf",
      content_hash: contentHash,
      size_bytes: bytes.byteLength,
      metadata: {
        source_kind: "previously_committed_pdf",
        source_identity:
          "docket-revision:source-revision/artifact:artifact-self",
        source_document_id: "source-document",
        source_revision_id: "source-revision",
        source_artifact_id: "artifact-self",
        source_artifact_content_hash: contentHash,
        expected_raw_sha256: `sha256:${rawHash}`,
        output_sha256: `sha256:${rawHash}`,
        render_hash: rawHash,
        report_input_hash: `sha256:${"a".repeat(64)}`,
        evidence_source: "current_cycle_curated_makesafe_report",
        report_contract_version: MAKESAFE_REPORT_CONTRACT_VERSION,
      },
    };
    const { client, signedPaths } = reviewPackClient(artifact, bytes);
    const pack = await getSesReviewablePackAction(
      client,
      { mode: "api_key", user: null },
      "docket-fixture",
    );
    assertEquals(pack.artifacts, []);
    assertEquals(
      pack.suppressed_artifacts[0].suppression_reason,
      "source_identity_self_reference",
    );
    assertEquals(pack.blockers[0].code, "curated_source_missing");
    assertEquals(signedPaths, []);
  },
);

Deno.test("review pack keeps an independently proved sibling bundle report visible", async () => {
  const bytes = new TextEncoder().encode("%PDF-1.7\ntrusted sibling fixture");
  const contentHash = await sesSha256Bytes(bytes);
  const rawHash = await rawSha256(bytes);
  const artifact = {
    role: "supporting_report_pdf",
    object_key: "makesafe-docket-artifacts/docket-fixture/report.pdf",
    media_type: "application/pdf",
    content_hash: contentHash,
    size_bytes: bytes.byteLength,
    metadata: {
      source_kind: "previously_committed_pdf",
      source_identity:
        "docket-revision:source-revision/artifact:source-artifact",
      source_document_id: "source-document",
      source_revision_id: "source-revision",
      source_artifact_id: "source-artifact",
      source_artifact_content_hash: contentHash,
      expected_raw_sha256: `sha256:${rawHash}`,
      output_sha256: `sha256:${rawHash}`,
      render_hash: rawHash,
      evidence_source: "explicit_sibling_bundle",
      report_contract_version: MAKESAFE_REPORT_CONTRACT_VERSION,
      bundle_id: "bundle-fixture",
      sibling_job_id: "sibling-job-fixture",
      binding_revision_id: "binding-revision-fixture",
    },
  };
  const { client, signedPaths } = reviewPackClient(artifact, bytes);
  const pack = await getSesReviewablePackAction(
    client,
    { mode: "api_key", user: null },
    "docket-fixture",
  );
  assertEquals(pack.artifacts.length, 1);
  assertEquals(pack.suppressed_artifacts, []);
  assertEquals(pack.blockers, []);
  assertEquals(signedPaths, ["docket-fixture/report.pdf"]);
});

Deno.test(
  "review pack judges a sibling bundle's renderer against the sibling's own bind instant",
  async () => {
    const bytes = new TextEncoder().encode("%PDF-1.7\nsibling curated fixture");
    const contentHash = await sesSha256Bytes(bytes);
    const rawHash = await rawSha256(bytes);
    // The identity authorised before the 2026-08-07 re-pin, on a bind made
    // inside its window. The docket job has no bind event of its own, so only
    // the sibling job's trail can supply the instant.
    const superseded = MAKESAFE_REPORT_RENDERER_AUTHORITY_REGISTER[1];
    const artifact = {
      role: "supporting_report_pdf",
      object_key: "makesafe-docket-artifacts/docket-fixture/report.pdf",
      media_type: "application/pdf",
      content_hash: contentHash,
      size_bytes: bytes.byteLength,
      metadata: {
        source_kind: "durable_curated_revision",
        source_identity:
          "curation-revision:source-revision/artifact:source-artifact",
        source_document_id: "sibling-document",
        report_document_id: "sibling-document",
        source_revision_id: "source-revision",
        source_artifact_id: "source-artifact",
        source_artifact_content_hash: contentHash,
        expected_raw_sha256: `sha256:${rawHash}`,
        output_sha256: `sha256:${rawHash}`,
        render_hash: rawHash,
        report_input_hash: `sha256:${"a".repeat(64)}`,
        evidence_source: "explicit_sibling_bundle",
        report_contract_version: MAKESAFE_REPORT_CONTRACT_VERSION,
        bundle_id: "bundle-fixture",
        sibling_job_id: "sibling-job-fixture",
        binding_revision_id: "binding-revision-fixture",
        report_renderer_version: makesafeRendererAuthorityVersion(superseded),
        report_renderer_source_revision: superseded.source_revision,
        report_renderer_script_sha256: superseded.script_sha256,
      },
    };
    const bindEvent = {
      job_id: "sibling-job-fixture",
      created_at: "2026-08-05T00:00:00.000Z",
      detail_json: { document_id: "sibling-document" },
    };
    const { client, signedPaths } = reviewPackClient(artifact, bytes, {
      jobEvents: [bindEvent],
    });
    const pack = await getSesReviewablePackAction(
      client,
      { mode: "api_key", user: null },
      "docket-fixture",
    );
    assertEquals(pack.suppressed_artifacts, []);
    assertEquals(pack.artifacts.length, 1);
    assertEquals(pack.blockers, []);
    assertEquals(signedPaths, ["docket-fixture/report.pdf"]);

    // Same artifact, sibling bind event missing: the renderer finding remains
    // visible, but it is review context rather than a HOLD wall.
    const unbound = reviewPackClient(artifact, bytes, { jobEvents: [] });
    const refused = await getSesReviewablePackAction(
      unbound.client,
      { mode: "api_key", user: null },
      "docket-fixture",
    );
    assertEquals(refused.artifacts.length, 1);
    assertEquals(refused.artifacts[0].trust_state, "caveat");
    assertEquals(refused.suppressed_artifacts, []);
    assertEquals(
      String(refused.caveats[0].evidence?.suppression_reason || ""),
      "active_renderer_input_binding_missing",
    );
  },
);

Deno.test(
  "sibling renderer-window findings remain caveats while unreadable audit stays hard",
  async () => {
    // Reaching into another job's audit trail is the one place bind-time
    // validity crosses a job boundary, so it is the one place a permissive read
    // would let a bundle in on evidence a same-job bind would be refused for.
    // Each case below is a genuinely invalid sibling bind, broken deliberately.
    const bytes = new TextEncoder().encode("%PDF-1.7\nsibling fence fixture");
    const contentHash = await sesSha256Bytes(bytes);
    const rawHash = await rawSha256(bytes);
    const superseded = MAKESAFE_REPORT_RENDERER_AUTHORITY_REGISTER[1];
    const artifact = {
      role: "supporting_report_pdf",
      object_key: "makesafe-docket-artifacts/docket-fixture/report.pdf",
      media_type: "application/pdf",
      content_hash: contentHash,
      size_bytes: bytes.byteLength,
      metadata: {
        source_kind: "durable_curated_revision",
        source_identity:
          "curation-revision:source-revision/artifact:source-artifact",
        source_document_id: "sibling-document",
        report_document_id: "sibling-document",
        source_revision_id: "source-revision",
        source_artifact_id: "source-artifact",
        source_artifact_content_hash: contentHash,
        expected_raw_sha256: `sha256:${rawHash}`,
        output_sha256: `sha256:${rawHash}`,
        render_hash: rawHash,
        report_input_hash: `sha256:${"a".repeat(64)}`,
        evidence_source: "explicit_sibling_bundle",
        report_contract_version: MAKESAFE_REPORT_CONTRACT_VERSION,
        bundle_id: "bundle-fixture",
        sibling_job_id: "sibling-job-fixture",
        binding_revision_id: "binding-revision-fixture",
        report_renderer_version: makesafeRendererAuthorityVersion(superseded),
        report_renderer_source_revision: superseded.source_revision,
        report_renderer_script_sha256: superseded.script_sha256,
      },
    };
    const siblingBindAt = (createdAt: string) => ({
      job_id: "sibling-job-fixture",
      created_at: createdAt,
      detail_json: { document_id: "sibling-document" },
    });

    // 1. The forward fence, unchanged across a job boundary. The sibling's
    //    newest bind was made AFTER the re-pin closed this identity's window, so
    //    the stamp claims a renderer that was no longer authoritative when the
    //    bind was made. Crossing jobs must not buy a bundle past that.
    const afterRepin = reviewPackClient(artifact, bytes, {
      jobEvents: [siblingBindAt("2026-08-07T12:00:00.000Z")],
    });
    const fenced = await getSesReviewablePackAction(
      afterRepin.client,
      { mode: "api_key", user: null },
      "docket-fixture",
    );
    assertEquals(fenced.artifacts.length, 1);
    assertEquals(fenced.suppressed_artifacts, []);
    assertEquals(
      String(fenced.caveats[0].evidence?.suppression_reason || ""),
      "active_renderer_input_binding_missing",
    );
    assertEquals(afterRepin.signedPaths, ["docket-fixture/report.pdf"]);

    // 2. A sibling bind made BEFORE this identity's window opened is equally not
    //    authoritative. The window is a window, not a ceiling.
    const beforeWindow = reviewPackClient(artifact, bytes, {
      jobEvents: [siblingBindAt("2026-08-01T00:00:00.000Z")],
    });
    const early = await getSesReviewablePackAction(
      beforeWindow.client,
      { mode: "api_key", user: null },
      "docket-fixture",
    );
    assertEquals(early.artifacts.length, 1);
    assertEquals(early.suppressed_artifacts, []);
    assertEquals(
      String(early.caveats[0].evidence?.suppression_reason || ""),
      "active_renderer_input_binding_missing",
    );

    // 3. The sibling's newest bind decides. An in-window bind must not be
    //    resurrected by a later one that moved the document past the window -
    //    picking the friendliest event is how a cross-job read goes wrong.
    const reBound = reviewPackClient(artifact, bytes, {
      jobEvents: [
        siblingBindAt("2026-08-05T00:00:00.000Z"),
        siblingBindAt("2026-08-07T12:00:00.000Z"),
      ],
    });
    const stale = await getSesReviewablePackAction(
      reBound.client,
      { mode: "api_key", user: null },
      "docket-fixture",
    );
    assertEquals(stale.artifacts.length, 1);
    assertEquals(stale.suppressed_artifacts, []);
    assertEquals(
      String(stale.caveats[0].evidence?.suppression_reason || ""),
      "active_renderer_input_binding_missing",
    );

    // 4. An unreadable SIBLING trail is a READ FAULT, and must report as one.
    //    Calling it a renderer-provenance failure sends an operator to re-bind a
    //    card whose bind is fine - the same lie this whole change removes, and
    //    the same reason code the own-job path already uses. It still refuses.
    //    Only the sibling's trail faults here: faulting both would stop at the
    //    docket job's own audit and never exercise the sibling branch.
    const unreadable = reviewPackClient(artifact, bytes, {
      jobEventsErrorForJob: {
        job_id: "sibling-job-fixture",
        error: { message: "sibling curated bind ledger unavailable" },
      },
    });
    const faulted = await getSesReviewablePackAction(
      unreadable.client,
      { mode: "api_key", user: null },
      "docket-fixture",
    );
    assertEquals(faulted.artifacts, []);
    assertEquals(
      faulted.suppressed_artifacts[0].suppression_reason,
      "curated_source_supersession_unreadable",
    );
    assertEquals(unreadable.signedPaths, []);
  },
);

function roofPortalCockpitClient(
  draftBuilderReportEmailState: string,
  extraRows: Record<string, unknown> = {},
  reviewSpec: Record<string, unknown> = {
    cards: [{ family: "ordinary_roof_portal" }],
  },
  readErrors: Record<string, Record<string, unknown>> = {},
): any {
  const rows: Record<string, unknown> = {
    makesafe_docket_revisions_current: {
      id: "docket-fixture",
      job_id: "job-fixture",
      family_matrix_version: "family-matrix-fixture",
      invoice_obligation_revision_id: null,
      attendance_cycle_ids: ["cycle-fixture"],
      stage: "pre_xero",
      pre_xero_docs_ready: true,
      envelope: {
        v2: {
          classification: {
            family: "ordinary_roof_portal",
            job_number: "SWMS-TEST",
            report_only: true,
            builder_key: "MLB",
          },
          routing: { invoice_to: "makesafes@builder.example" },
          items: {
            draft_builder_report_email: {
              state: draftBuilderReportEmailState,
            },
          },
        },
      },
      blockers: [],
      review_spec: reviewSpec,
      email_drafts: {
        INVOICE_EMAIL_DRAFT:
          "To: makesafes@builder.example\nSubject: Invoice\nAttachments: invoice-hash\n\nBody",
      },
    },
    makesafe_readiness_current_v2: {
      readiness_revision: "readiness-fixture",
      dependency_generation: 1,
      ready: true,
      blockers: [],
    },
    makesafe_invoice_obligation_revisions_current: {
      id: "obligation-fixture",
      pricing_disposition: "no_additional_charge",
      blockers: [],
      duplicate_probe: { allows_create: true, ambiguity: "none" },
    },
    makesafe_docket_artifacts: [],
    job_assignments: [],
    job_service_reports: [],
    ...extraRows,
  };
  return {
    storage: {
      from() {
        return {
          download: () => Promise.resolve({ data: new Blob([]), error: null }),
        };
      },
    },
    from(table: string) {
      let single = false;
      const query: any = {
        select: () => query,
        eq: () => query,
        order: () => query,
        limit: () => query,
        maybeSingle: () => {
          single = true;
          return query;
        },
        then: (resolve: (value: unknown) => unknown) => {
          if (readErrors[table]) {
            return Promise.resolve({
              data: null,
              error: readErrors[table],
            }).then(resolve);
          }
          const value = rows[table];
          return Promise.resolve({
            data: single && Array.isArray(value) ? value[0] || null : value,
            error: null,
          }).then(resolve);
        },
      };
      return query;
    },
  } as any;
}

Deno.test("cockpit reads the portal-is-the-report manifest declaration and drops the report email requirement", async () => {
  // Producer seam for the 2026-08-06 ruling: the manifest's own
  // draft_builder_report_email: not_applicable stamp (not `report_only`) is what
  // flows into report_route_applicable, so a live roof-portal card with one
  // invoice draft is no longer held for a report email nobody may fabricate.
  const cockpit = await querySesReviewCockpitAction(
    roofPortalCockpitClient("not_applicable"),
    "job-fixture",
  );
  const codes = cockpit.verdict.blockers.map((item: any) => item.code);
  assertEquals(
    codes.filter((code: string) =>
      code === "report_only_email_applicability_parked"
    ),
    [],
  );
  assertEquals(
    cockpit.verdict.blockers
      .filter((item: any) => item.code === "route_draft_missing")
      .filter((item: any) => String(item.fact).includes("report email")),
    [],
  );
});

Deno.test("cockpit shows recipients, attachments, and missing artifact truth without turning it into a send blocker", async () => {
  const cockpit = await querySesReviewCockpitAction(
    roofPortalCockpitClient("not_applicable", {
      makesafe_report_packs: {
        id: "pack-fixture",
        pack_kind: "main",
        status: "drafted",
        report_doc_id: null,
        invoice_doc_id: null,
        swms_doc_id: null,
        sent_at: null,
      },
      jobs: {
        id: "job-fixture",
        type: "makesafe",
        status: "active",
        metadata: {},
      },
      makesafe_job_details: {
        job_id: "job-fixture",
        report_type: "roof_report",
        attendance_cycle_id: "cycle-fixture",
        cycle_number: 1,
        reattend_count: 0,
        external_links: [],
      },
      job_documents: [],
      job_service_reports: [{
        id: "report-fixture",
        job_id: "job-fixture",
        status: "submitted",
        submitted_at: "2026-08-21T00:00:00.000Z",
        created_at: "2026-08-21T00:00:00.000Z",
        cycle_number: 1,
        attendance_cycle_id: "cycle-fixture",
        cycle_attribution: "exact",
      }],
      makesafe_portal_capture_revisions: [],
    }),
    "job-fixture",
  );

  assertEquals(
    cockpit.verdict.blockers.some((blocker) =>
      blocker.code === "required_pack_artifact_missing"
    ),
    false,
  );
  assertEquals(
    cockpit.caveats.some((caveat) =>
      caveat.code === "required_pack_artifact_missing"
    ),
    true,
  );
  assertEquals(
    (cockpit.sections.artifact_truth as any).missing_required,
    ["report"],
  );
  assertEquals((cockpit.sections.send_preview as any).routes, [{
    route_kind: "invoice",
    recipients: ["makesafes@builder.example"],
    cc: [],
    subject: "Make-safe - no additional charge",
    attachment_hashes: [],
    attachment_count: 0,
  }]);
});

Deno.test("cockpit approval preview keeps an unreadable trade-report history as an honesty caveat", async () => {
  const cockpit = await querySesReviewCockpitAction(
    roofPortalCockpitClient(
      "not_applicable",
      {
        makesafe_report_packs: {
          id: "pack-fixture",
          pack_kind: "main",
          status: "drafted",
          report_doc_id: "roof-report-bound",
          invoice_doc_id: null,
          swms_doc_id: null,
          sent_at: null,
        },
        jobs: {
          id: "job-fixture",
          type: "makesafe",
          status: "active",
          metadata: {},
        },
        makesafe_job_details: {
          job_id: "job-fixture",
          report_type: "roof_report",
          attendance_cycle_id: "cycle-fixture",
          cycle_number: 1,
          reattend_count: 0,
          external_links: [],
        },
        job_documents: [{
          id: "roof-report-bound",
          type: "roof_report",
          file_name: "Roof Report - SWMS-TEST.pdf",
          storage_url: "https://documents.example/roof-report.pdf",
        }],
        makesafe_portal_capture_revisions: [],
      },
      { cards: [{ family: "ordinary_roof_portal" }] },
      {
        job_service_reports: { message: "trade report history unavailable" },
      },
    ),
    "job-fixture",
  );

  assertEquals(
    cockpit.caveats.some((caveat) =>
      caveat.code === "pack_artifact_truth_unreadable"
    ),
    true,
  );
  const truth = cockpit.sections.artifact_truth as any;
  assertEquals(truth.read_state, "unreadable");
  assertEquals(truth.required_documents, {
    report: true,
    invoice: false,
    swms: false,
  });
  assertEquals(truth.document_resolution, {
    report: null,
    invoice: null,
    swms: null,
  });
  assertEquals(truth.unresolved_required, ["report"]);
});

Deno.test("cockpit still demands the report email when the manifest does not declare not_applicable", async () => {
  // Fail-strict control: any other manifest state (here the initial "blocked")
  // keeps the report route required, so a family that owes a report email and
  // failed to build one is still held honestly.
  const cockpit = await querySesReviewCockpitAction(
    roofPortalCockpitClient("blocked"),
    "job-fixture",
  );
  const held = cockpit.verdict.blockers.find((item: any) =>
    item.code === "route_draft_missing" &&
    String(item.fact).includes("report email")
  );
  assertEquals(Boolean(held), true);
  assertEquals(cockpit.status, "HOLD");
});

Deno.test("named-card review caveats stay visible without locking DRAFT approval", async () => {
  const cockpit = await querySesReviewCockpitAction(
    roofPortalCockpitClient(
      "not_applicable",
      {
        makesafe_invoice_obligation_revisions_current: {
          id: "obligation-fixture",
          pricing_disposition: "priced_from_canon",
          blockers: [],
          duplicate_probe: { allows_create: true, ambiguity: "none" },
          xero_binding: {
            xero_invoice_id: "xero-draft-fixture",
            invoice_number: "INV-1201",
            status: "DRAFT",
          },
        },
      },
      {
        cards: [{
          family: "ordinary_roof_portal",
          review_assumption_codes: [
            "canonical_draft_pack_output_missing",
          ],
          review_assumptions: [
            "No Maverick DraftPack was supplied for this card.",
          ],
        }],
      },
    ),
    "job-fixture",
  );

  assertEquals(cockpit.controls.approve_invoice.enabled, true);
  assertEquals(
    cockpit.verdict.blockers.some((blocker) =>
      blocker.code === "canonical_draft_pack_output_missing"
    ),
    false,
  );
  assertEquals(cockpit.caveats[0].code, "canonical_draft_pack_output_missing");
});

Deno.test("cockpit keeps missing independent report proof as a visible caveat", async () => {
  const bytes = new TextEncoder().encode("%PDF-1.7\nlegacy fixture");
  const reportHash = await sesSha256Bytes(bytes);
  const rows: Record<string, unknown> = {
    makesafe_docket_revisions_current: {
      id: "docket-fixture",
      job_id: "job-fixture",
      family_matrix_version: "family-matrix-fixture",
      invoice_obligation_revision_id: null,
      attendance_cycle_ids: ["cycle-fixture"],
      stage: "pre_xero",
      pre_xero_docs_ready: true,
      envelope: {
        v2: {
          classification: {
            family: "physical_makesafe",
            job_number: "SWMS-TEST",
          },
          items: {
            physical_reporting_evidence: { state: "ready" },
            supporting_report_pdf: { state: "ready" },
            swms_current_cycle: { state: "ready" },
          },
        },
      },
      blockers: [],
      review_spec: { cards: [{ family: "physical_makesafe" }] },
      email_drafts: {
        REPORT_EMAIL_DRAFT:
          `To: reports@builder.example\nSubject: Report\nAttachments: ${reportHash}\n\nBody`,
      },
    },
    makesafe_readiness_current_v2: {
      readiness_revision: "readiness-fixture",
      dependency_generation: 1,
      ready: true,
      blockers: [],
    },
    makesafe_invoice_obligation_revisions_current: {
      id: "obligation-fixture",
      pricing_disposition: "no_additional_charge",
      blockers: [],
      duplicate_probe: { allows_create: true, ambiguity: "none" },
    },
    makesafe_docket_artifacts: [{
      role: "supporting_report_pdf",
      object_key: "makesafe-docket-artifacts/docket-fixture/report.pdf",
      media_type: "application/pdf",
      content_hash: reportHash,
      size_bytes: bytes.byteLength,
      metadata: {
        evidence_source: "current_cycle_curated_makesafe_report",
        report_renderer_version: "secureworks.ops-api-jspdf/retired",
        render_hash: await rawSha256(bytes),
      },
    }],
    job_assignments: [],
    job_service_reports: [],
  };
  const client = {
    storage: {
      from() {
        return {
          download: () =>
            Promise.resolve({
              data: new Blob([new Uint8Array(bytes).buffer]),
              error: null,
            }),
        };
      },
    },
    from(table: string) {
      let single = false;
      const query: any = {
        select: () => query,
        eq: () => query,
        order: () => query,
        limit: () => query,
        maybeSingle: () => {
          single = true;
          return query;
        },
        then: (resolve: (value: unknown) => unknown) => {
          const value = rows[table];
          return Promise.resolve({
            data: single && Array.isArray(value) ? value[0] || null : value,
            error: null,
          }).then(resolve);
        },
      };
      return query;
    },
  } as any;
  const cockpit = await querySesReviewCockpitAction(client, "job-fixture");
  assertEquals(cockpit.status, "HOLD");
  assertEquals(cockpit.controls.send_it.enabled, false);
  const blocker = cockpit.verdict.blockers.find((item) =>
    item.code === "curated_source_missing"
  );
  assertEquals(blocker, undefined);
  const caveat = cockpit.caveats.find((item) =>
    item.code === "curated_source_missing"
  );
  assertEquals(caveat?.code, "curated_source_missing");
  assertEquals(
    (caveat as any).evidence.suppression_reason,
    "independent_source_kind_missing",
  );
});

Deno.test("blank Cc cannot consume the following Subject header", () => {
  const report = _parseSesDraftForTest(
    "report",
    [
      "To: reports@builder.example",
      "Cc:",
      "Subject: Generic report subject",
      "Attachments: report-hash",
      "",
      "Generic report body.",
    ].join("\n"),
  );
  assertEquals(report?.cc, []);
  assertEquals(report?.subject, "Generic report subject");
  assertEquals(report?.ready, true);

  const invoice = _parseSesDraftForTest(
    "invoice",
    [
      "To: invoices@builder.example",
      "Cc: finance@builder.example",
      "Subject: Generic invoice subject",
      "Attachments: invoice-hash",
      "",
      "Generic invoice body.",
    ].join("\n"),
  );
  assertEquals(invoice?.cc, ["finance@builder.example"]);
  assertEquals(invoice?.subject, "Generic invoice subject");
});

Deno.test("non-email Cc is never exposed as a typed review recipient", () => {
  const route = _parseSesDraftForTest(
    "photo",
    "To: photos@builder.example\nCc: Generic photo subject\nSubject: Generic photo subject\n\nBody",
  );
  assertEquals(route?.cc, []);
  assertEquals(route?.ready, false);
});

function invoiceDocket(
  stage: "pre_xero" | "invoice_bound",
  attachments: string[],
  xero: Record<string, unknown> | null = null,
) {
  return {
    id: "docket-fixture",
    stage,
    local_invoice_proposal: { builder_reference: "REF-TEST-1" },
    xero_binding: xero,
    email_drafts: {
      INVOICE_EMAIL_DRAFT: [
        "To: invoices@builder.example",
        "Cc:",
        "Subject: Privacy-safe invoice fixture",
        `Attachments: ${attachments.join(", ")}`,
        "",
        "Fixture body.",
      ].join("\n"),
    },
  };
}

const ROUTE_ARTIFACTS = [{
  role: "invoice_proposal",
  object_key: "bucket/docket-fixture/ARTIFACTS/invoice_proposal.json",
  media_type: "application/json",
  content_hash: "proposal-hash",
}, {
  role: "supporting_report_pdf",
  object_key: "bucket/docket-fixture/ARTIFACTS/report.pdf",
  media_type: "application/pdf",
  content_hash: "report-hash",
}, {
  role: "swms_artifact",
  object_key: "bucket/docket-fixture/ARTIFACTS/swms.pdf",
  media_type: "application/pdf",
  content_hash: "swms-hash",
}, {
  role: "xero_invoice_pdf",
  object_key: "bucket/docket-fixture/ARTIFACTS/xero-invoice.pdf",
  media_type: "application/pdf",
  content_hash: "xero-hash",
  metadata: {
    xero_invoice_id: "xero-invoice-test-1",
    invoice_number: "INV-TEST-1",
  },
}];

Deno.test("docketArtifactPackRelativePath keeps nested ARTIFACTS/photos under parent revision keys", () => {
  const bound = "ecfcbd8e-81d5-55d8-a9d4-9d5ad89f8916";
  const parent = "6a55da20-1624-5096-ae29-5549c7f9dc66";
  const nested =
    `makesafe-docket-artifacts/job/${parent}/ARTIFACTS/photos/001-abc.jpg`;
  const flatReport =
    `makesafe-docket-artifacts/job/${parent}/ARTIFACTS/report.pdf`;
  const boundInvoice =
    `makesafe-docket-artifacts/job/${bound}/ARTIFACTS/Xero Invoice - INV-1102.pdf`;
  // Old last-two-segments fallback would yield photos/001-abc.jpg and miss the draft path.
  assertEquals(
    docketArtifactPackRelativePath(nested, bound, parent),
    "ARTIFACTS/photos/001-abc.jpg",
  );
  assertEquals(
    docketArtifactPackRelativePath(flatReport, bound, parent),
    "ARTIFACTS/report.pdf",
  );
  assertEquals(
    docketArtifactPackRelativePath(boundInvoice, bound, parent),
    "ARTIFACTS/Xero Invoice - INV-1102.pdf",
  );
  // Current-id marker still wins when present.
  assertEquals(
    docketArtifactPackRelativePath(
      `makesafe-docket-artifacts/job/${bound}/ARTIFACTS/photos/002.jpg`,
      bound,
      parent,
    ),
    "ARTIFACTS/photos/002.jpg",
  );
});

Deno.test("assessment and physical pre-Xero invoice routes hide proposal state and remain non-sendable", () => {
  const assessment = resolveDocketRoutes(
    invoiceDocket("pre_xero", ["ARTIFACTS/invoice_proposal.json"]),
    ROUTE_ARTIFACTS,
    null,
  )[0];
  assertEquals(assessment.attachment_hashes, []);
  assertEquals(assessment.ready, false);

  const physical = resolveDocketRoutes(
    invoiceDocket("pre_xero", [
      "ARTIFACTS/invoice_proposal.json",
      "ARTIFACTS/report.pdf",
      "ARTIFACTS/swms.pdf",
    ]),
    ROUTE_ARTIFACTS,
    null,
  )[0];
  assertEquals(physical.attachment_hashes, ["report-hash", "swms-hash"]);
  assertEquals(physical.ready, false);
});

Deno.test("invoice-bound route requires the authorised Xero PDF and keeps approved support", () => {
  const attachments = [
    "ARTIFACTS/invoice_proposal.json",
    "ARTIFACTS/report.pdf",
    "ARTIFACTS/swms.pdf",
  ];
  const authorised = resolveDocketRoutes(
    invoiceDocket("invoice_bound", attachments, {
      status: "AUTHORISED",
      xero_invoice_id: "xero-invoice-test-1",
      invoice_number: "INV-TEST-1",
    }),
    ROUTE_ARTIFACTS,
    null,
  )[0];
  assertEquals(authorised.attachment_hashes, [
    "xero-hash",
    "report-hash",
    "swms-hash",
  ]);
  assertEquals(authorised.ready, true);

  // AUTHORISED without a matching PDF remains non-ready (send gate).
  const authorisedNoPdf = resolveDocketRoutes(
    invoiceDocket("invoice_bound", attachments, {
      status: "AUTHORISED",
      xero_invoice_id: "xero-invoice-missing-pdf",
      invoice_number: "INV-MISSING",
    }),
    ROUTE_ARTIFACTS,
    null,
  )[0];
  assertEquals(authorisedNoPdf.ready, false);
});

Deno.test(
  "bound Xero DRAFT requires its exact PDF hash and stops claiming no invoice",
  () => {
    const attachments = [
      "ARTIFACTS/invoice_proposal.json",
      "ARTIFACTS/report.pdf",
      "ARTIFACTS/swms.pdf",
    ];
    // Option B mint binds the DRAFT on the obligation while the docket stays
    // pre_xero with a stored draft that still says "No Xero invoice exists".
    const missingPdf = resolveDocketRoutes(
      invoiceDocket("pre_xero", attachments, null),
      ROUTE_ARTIFACTS,
      {
        pricing_disposition: "priced_from_canon",
        xero_binding: {
          status: "DRAFT",
          xero_invoice_id: "xero-invoice-test-1",
          invoice_number: "INV-TEST-1",
          total: 737,
        },
      },
    )[0];
    assertEquals(missingPdf.ready, false);

    const draft = resolveDocketRoutes(
      invoiceDocket("pre_xero", attachments, null),
      ROUTE_ARTIFACTS,
      {
        pricing_disposition: "priced_from_canon",
        xero_binding: {
          status: "DRAFT",
          xero_invoice_id: "xero-invoice-test-1",
          invoice_number: "INV-TEST-1",
          total: 737,
          pdf_content_hash: "draft-pdf-hash",
        },
      },
    )[0];
    assertEquals(draft.ready, true);
    // The Xero draft identity lives on the SUBJECT; the body is builder-facing
    // plain English and carries no bind-state wording at all (SWMS-261161 body
    // leak: outbound bodies must never explain internal invoice state).
    assertStringIncludes(draft.subject, "INV-TEST-1");
    assertStringIncludes(
      draft.body,
      "Please find attached the invoice and supporting documents for REF-TEST-1.",
    );
    assertEquals(draft.body.includes("No Xero invoice exists"), false);
    assertEquals(draft.body.includes("DRAFT"), false);
    assertEquals(draft.attachment_hashes, [
      "draft-pdf-hash",
      "report-hash",
      "swms-hash",
    ]);

    // Same truth when the DRAFT is already on the docket binding.
    const onDocket = resolveDocketRoutes(
      invoiceDocket("invoice_bound", attachments, {
        status: "DRAFT",
        xero_invoice_id: "xero-invoice-test-1",
        invoice_number: "INV-TEST-1",
        pdf_content_hash: "draft-pdf-hash",
      }),
      ROUTE_ARTIFACTS,
      null,
    )[0];
    assertEquals(onDocket.ready, true);
    assertEquals(onDocket.body.includes("No Xero invoice exists"), false);
  },
);

function listClient(options: { proposalError?: boolean } = {}) {
  const calls: string[] = [];
  const client = {
    from(table: string) {
      calls.push(table);
      if (table === "ses_docket_review_current") {
        const query: any = {
          select: () => query,
          eq: () => query,
          order: () => query,
          limit: () =>
            Promise.resolve({
              data: [{
                org_id: "org-1",
                job_id: "job-1",
                docket_revision_id: "docket-1",
                review_state: "needs_review",
              }],
              error: null,
            }),
        };
        return query;
      }
      if (table === "makesafe_docket_revisions") {
        const query: any = {
          select: () => query,
          in: () =>
            Promise.resolve(
              options.proposalError
                ? { data: null, error: { message: "summary unavailable" } }
                : {
                  data: [{
                    id: "docket-1",
                    local_invoice_proposal: {
                      subtotal_ex_gst: 123,
                      total_inc_gst: 135.3,
                    },
                  }],
                  error: null,
                },
            ),
        };
        return query;
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as any;
  return { client, calls };
}

Deno.test("Docs Ready list hydrates the exact docket proposal shape", async () => {
  const { client, calls } = listClient();
  const result = await listSesDocsReadyReviewsAction(
    client,
    { mode: "api_key", user: null },
  );
  assertEquals(result.dockets[0].local_invoice_proposal, {
    subtotal_ex_gst: 123,
    total_inc_gst: 135.3,
  });
  assertEquals(calls, [
    "ses_docket_review_current",
    "makesafe_docket_revisions",
  ]);
});

Deno.test("Docs Ready list refuses rather than masking proposal hydration failure", async () => {
  const { client } = listClient({ proposalError: true });
  const error = await assertRejects(
    () =>
      listSesDocsReadyReviewsAction(
        client,
        { mode: "api_key", user: null },
      ),
    SesActionError,
  );
  assertEquals(error.status, 503);
});

// ─── Ruled invoice-only release shape at the cockpit read and SEND IT ───
//
// Captain 2026-08-06: a roof-report card sends ONE email, to the group inbox,
// carrying the invoice. Prepare and approve now build that release as a single
// invoice route, so the two later consumers of the stored route set — the
// cockpit's composite-release read and SEND IT execute — must recognise the
// same shape. Without these, the Captain clears the cockpit, AUTHORISES real
// money, approves the release, and is only then refused: money committed
// before the refusal appears, the exact outcome the Captain rejected.

function releaseFixtureRows(
  memberJobId: string,
  routes: Array<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    makesafe_release_revisions: {
      id: "release-fixture",
      content_hash: "sha256:" + "e".repeat(64),
      state: "approved",
      readiness_bindings: [],
    },
    makesafe_release_revision_members: [{
      ordinal: 1,
      job_id: memberJobId,
      docket_revision_id: "docket-fixture",
      invoice_obligation_revision_id: "obligation-fixture",
    }],
    makesafe_release_revision_routes: routes,
  };
}

const INVOICE_ONLY_ROUTE = {
  ordinal: 1,
  route_kind: "invoice",
  recipients: ["makesafes@mlbuilders.com.au"],
  cc: ["finance@mlbuilders.com.au"],
  subject: "Invoice",
  body: "Invoice body",
  body_hash: "sha256:" + "1".repeat(64),
  attachment_hashes: ["sha256:" + "3".repeat(64)],
};

Deno.test("cockpit read accepts the ruled one-route invoice-only release", async () => {
  const cockpit: any = await querySesReviewCockpitAction(
    roofPortalCockpitClient(
      "not_applicable",
      releaseFixtureRows("job-fixture", [INVOICE_ONLY_ROUTE]),
    ),
    "job-fixture",
    undefined,
    "release-fixture",
  );
  assertEquals(cockpit.release_revision.id, "release-fixture");
  assertEquals(
    cockpit.release_revision.routes.map((route: any) => route.route_kind),
    ["invoice"],
  );
});

Deno.test("cockpit read still refuses a release that does not contain this job", async () => {
  const error = await assertRejects(
    () =>
      querySesReviewCockpitAction(
        roofPortalCockpitClient(
          "not_applicable",
          releaseFixtureRows("some-other-job", [INVOICE_ONLY_ROUTE]),
        ),
        "job-fixture",
        undefined,
        "release-fixture",
      ),
    SesActionError,
  );
  assertEquals(error.status, 409);
  assertStringIncludes(
    String((error.refusal as any).fact),
    "does not contain this job",
  );
});

function releaseExecuteClient(routes: Array<Record<string, unknown>>): any {
  const effects = new Map<string, any>();
  return {
    from(table: string) {
      const result = (() => {
        switch (table) {
          case "makesafe_release_revisions":
            return {
              data: {
                id: "release-fixture",
                content_hash: "sha256:" + "e".repeat(64),
              },
              error: null,
            };
          case "makesafe_release_revision_members":
            return {
              data: [{
                ordinal: 1,
                job_id: "job-fixture",
                docket_revision_id: "docket-fixture",
                invoice_obligation_revision_id: "obligation-fixture",
              }],
              error: null,
            };
          case "makesafe_release_revision_routes":
            return { data: routes, error: null };
          case "makesafe_docket_revisions":
            return {
              data: {
                id: "docket-fixture",
                job_id: "job-fixture",
                xero_binding: {
                  status: "AUTHORISED",
                  xero_invoice_id: "xero-invoice-1",
                },
                invoice_obligation_revision_id: "obligation-fixture",
                envelope: {
                  v2: {
                    classification: {
                      builder_key: "MLB",
                      family: "ordinary_roof_portal",
                      report_only: true,
                    },
                    routing: {},
                  },
                },
                review_spec: {},
              },
              error: null,
            };
          case "makesafe_docket_artifacts":
            return {
              data: [{
                content_hash: "sha256:" + "3".repeat(64),
                size_bytes: 500_000,
                object_key: "dockets/docket-fixture/invoice.pdf",
                media_type: "application/pdf",
              }, {
                content_hash: "sha256:" + "4".repeat(64),
                size_bytes: 400_000,
                object_key: "dockets/docket-fixture/report.pdf",
                media_type: "application/pdf",
              }],
              error: null,
            };
          case "makesafe_closeout_revisions":
            return { data: effects.get("closeout") || null, error: null };
          case "makesafe_revision_approvals_current_v2":
            return {
              data: {
                id: "approval-1",
                approval_content_hash: "sha256:" + "e".repeat(64),
              },
              error: null,
            };
          default:
            return { data: null, error: null };
        }
      })();
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        in: () => builder,
        order: () => Promise.resolve(result),
        limit: () => builder,
        maybeSingle: () => Promise.resolve(result),
        then: (resolve: any, reject: any) =>
          Promise.resolve(result).then(resolve, reject),
      };
      return builder;
    },
    rpc(name: string, rpcArgs: Record<string, any>) {
      if (name === "assert_ses_dockets_signed_off_v1") {
        return Promise.resolve({ data: true, error: null });
      }
      if (name === "begin_ses_release_execution_v1") {
        return Promise.resolve({ data: { reserved: true }, error: null });
      }
      if (name === "claim_ses_external_effect_v1") {
        const effect = { ...rpcArgs.p_effect, state: "reserved" };
        effects.set(String(effect.operation_key), effect);
        return Promise.resolve({
          data: { claim_mode: "reserved", effect },
          error: null,
        });
      }
      if (name === "transition_ses_external_effect_v1") {
        const effect = effects.get(String(rpcArgs.p_operation_key)) || {
          operation_key: String(rpcArgs.p_operation_key),
          external_token: "",
          effect_kind: "route_send",
        };
        return Promise.resolve({
          data: { ...effect, state: rpcArgs.p_to_state },
          error: null,
        });
      }
      if (name === "confirm_ses_release_route_v1") {
        return Promise.resolve({
          data: { proof_hash: rpcArgs.p_proof_hash },
          error: null,
        });
      }
      if (name === "commit_ses_release_closeout_v1") {
        const closeout = { ...(rpcArgs.p_closeout || {}), verified: true };
        effects.set("closeout", closeout);
        return Promise.resolve({ data: closeout, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
    storage: {
      from: () => ({
        upload: () => Promise.resolve({ data: null, error: null }),
        createSignedUrl: () => Promise.resolve({ data: null, error: null }),
        download: () => Promise.resolve({ data: null, error: null }),
      }),
    },
  };
}

function releaseExecuteMailGateway(sentSubjects: string[]): any {
  const sentByToken = new Map<string, any>();
  return {
    createDraftAndSend: (payload: any, context: any) => {
      sentSubjects.push(String(payload.subject));
      const result = {
        message_id: `graph-message-${sentSubjects.length}`,
        internet_message_id: `<msg-${sentSubjects.length}@graph>`,
        operation_token: context.external_token,
      };
      sentByToken.set(String(context.external_token), result);
      return Promise.resolve(result);
    },
    reconcileSent: (token: string) =>
      Promise.resolve(
        sentByToken.has(String(token)) ? [sentByToken.get(String(token))] : [],
      ),
  };
}

Deno.test("SEND IT executes a sealed one-route invoice-only release", async () => {
  const sentSubjects: string[] = [];
  const result: any = await executeSesReleaseRevisionAction(
    releaseExecuteClient([INVOICE_ONLY_ROUTE]),
    { mode: "api_key", user: null },
    {
      org_id: "org-1",
      release_revision_id: "release-fixture",
      actor: "captain",
    },
    releaseExecuteMailGateway(sentSubjects),
    { readAuthorised: () => Promise.resolve(true) } as any,
  );
  assertEquals(result.state, "released");
  assertEquals(sentSubjects, ["Invoice"]);
  assertEquals(result.dispatch_previews[0].recipients, [
    "makesafes@mlbuilders.com.au",
  ]);
  assertEquals(result.dispatch_previews[0].attachment_hashes, [
    "sha256:" + "3".repeat(64),
  ]);
  assertEquals(
    result.dispatch_previews[0].members[0].artifact_truth.missing_required,
    ["report", "invoice"],
  );
  assertEquals(
    result.dispatch_previews[0].members[0].caveats[0].code,
    "required_pack_artifact_missing",
  );
});

const OWN_LETTERHEAD_REPORT_ROUTE = {
  ordinal: 0,
  route_kind: "report",
  recipients: ["makesafes@mlbuilders.com.au"],
  cc: ["ses@secureworkswa.com.au"],
  subject: "Report",
  body: "Report body",
  body_hash: "sha256:" + "2".repeat(64),
  attachment_hashes: ["sha256:" + "4".repeat(64)],
};

Deno.test("SEND IT executes a sealed own-letterhead report then invoice release", async () => {
  const sentSubjects: string[] = [];
  const result: any = await executeSesReleaseRevisionAction(
    releaseExecuteClient([
      OWN_LETTERHEAD_REPORT_ROUTE,
      { ...INVOICE_ONLY_ROUTE, ordinal: 1 },
    ]),
    { mode: "api_key", user: null },
    {
      org_id: "org-1",
      release_revision_id: "release-fixture",
      actor: "captain",
    },
    releaseExecuteMailGateway(sentSubjects),
    { readAuthorised: () => Promise.resolve(true) } as any,
  );
  assertEquals(result.state, "released");
  assertEquals(sentSubjects, ["Report", "Invoice"]);
  assertEquals(
    result.dispatch_previews.map((preview: any) => preview.route_kind),
    ["report", "invoice"],
  );
});

Deno.test("SEND IT still refuses a non-AJS release missing routes it owes", async () => {
  const sentSubjects: string[] = [];
  const error = await assertRejects(
    () =>
      executeSesReleaseRevisionAction(
        releaseExecuteClient([
          {
            ...INVOICE_ONLY_ROUTE,
            ordinal: 0,
            route_kind: "photo",
            subject: "Photos",
          },
          { ...INVOICE_ONLY_ROUTE, ordinal: 1 },
        ]),
        { mode: "api_key", user: null },
        {
          org_id: "org-1",
          release_revision_id: "release-fixture",
          actor: "captain",
        },
        releaseExecuteMailGateway(sentSubjects),
        { readAuthorised: () => Promise.resolve(true) } as any,
      ),
    SesActionError,
  );
  assertEquals(error.status, 409);
  assertStringIncludes(
    String((error.refusal as any).fact),
    "all three required routes",
  );
  assertEquals(sentSubjects, []);
});

Deno.test("SEND IT still refuses a one-route release whose single route is not the invoice", async () => {
  const sentSubjects: string[] = [];
  const error = await assertRejects(
    () =>
      executeSesReleaseRevisionAction(
        releaseExecuteClient([{ ...INVOICE_ONLY_ROUTE, route_kind: "report" }]),
        { mode: "api_key", user: null },
        {
          org_id: "org-1",
          release_revision_id: "release-fixture",
          actor: "captain",
        },
        releaseExecuteMailGateway(sentSubjects),
        { readAuthorised: () => Promise.resolve(true) } as any,
      ),
    SesActionError,
  );
  assertEquals(error.status, 409);
  assertEquals(sentSubjects, []);
});

Deno.test(
  "a sibling bundle superseded on its OWN job is suppressed, not served",
  async () => {
    // A bundle's report document belongs to the sibling job, so the correction
    // that supersedes it is recorded on THAT job's trail. Reading supersessions
    // from the docket job filters by the sibling's document id against events
    // that can never carry it, so the answer is always "not superseded" and the
    // superseded report reaches the builder - the one outcome the supersession
    // ledger exists to prevent.
    const bytes = new TextEncoder().encode("%PDF-1.7\nsuperseded sibling");
    const contentHash = await sesSha256Bytes(bytes);
    const rawHash = await rawSha256(bytes);
    const superseded = MAKESAFE_REPORT_RENDERER_AUTHORITY_REGISTER[1];
    const artifact = {
      role: "supporting_report_pdf",
      object_key: "makesafe-docket-artifacts/docket-fixture/report.pdf",
      media_type: "application/pdf",
      content_hash: contentHash,
      size_bytes: bytes.byteLength,
      metadata: {
        source_kind: "durable_curated_revision",
        source_identity: SUPERSEDED_IDENTITY,
        source_document_id: "sibling-document",
        report_document_id: "sibling-document",
        source_revision_id: "asbestos-misstatement",
        source_artifact_id: "asbestos-misstatement",
        source_artifact_content_hash: contentHash,
        expected_raw_sha256: `sha256:${rawHash}`,
        output_sha256: `sha256:${rawHash}`,
        render_hash: rawHash,
        report_input_hash: SUPERSEDED_INPUT,
        evidence_source: "explicit_sibling_bundle",
        report_contract_version: MAKESAFE_REPORT_CONTRACT_VERSION,
        bundle_id: "bundle-fixture",
        sibling_job_id: "sibling-job-fixture",
        binding_revision_id: "binding-revision-fixture",
        report_renderer_version: makesafeRendererAuthorityVersion(superseded),
        report_renderer_source_revision: superseded.source_revision,
        report_renderer_script_sha256: superseded.script_sha256,
      },
    };
    // Both events live on the SIBLING job: the bind that supplies the instant,
    // and the correction that supersedes the bytes this artifact carries.
    const siblingBind = {
      job_id: "sibling-job-fixture",
      created_at: "2026-08-05T00:00:00.000Z",
      detail_json: { document_id: "sibling-document" },
    };
    const siblingSupersession = {
      job_id: "sibling-job-fixture",
      created_at: "2026-08-05T01:00:00.000Z",
      detail_json: {
        document_id: "sibling-document",
        supersedes_prior_bind: true,
        source_identity: CORRECTED_IDENTITY,
        expected_raw_sha256: CORRECTED_RAW,
        report_input_hash: CORRECTED_INPUT,
        prior_source_identity: SUPERSEDED_IDENTITY,
        prior_expected_raw_sha256: `sha256:${rawHash}`,
        prior_report_input_hash: SUPERSEDED_INPUT,
      },
    };
    const { client, signedPaths } = reviewPackClient(artifact, bytes, {
      jobEvents: [siblingBind, siblingSupersession],
    });
    const pack = await getSesReviewablePackAction(
      client,
      { mode: "api_key", user: null },
      "docket-fixture",
    );
    assertEquals(pack.artifacts, []);
    assertEquals(
      pack.suppressed_artifacts[0].suppression_reason,
      "curated_source_superseded",
    );
    // Suppressed means suppressed: no signed URL is ever handed out for it.
    assertEquals(signedPaths, []);
  },
);

/**
 * A sibling bundle whose bind AND supersession both live on the sibling job's
 * own trail - the shape the docket job's events can never describe.
 */
async function supersededSiblingBundleFixture() {
  const bytes = new TextEncoder().encode("%PDF-1.7\nsuperseded sibling send");
  const contentHash = await sesSha256Bytes(bytes);
  const rawHash = await rawSha256(bytes);
  const superseded = MAKESAFE_REPORT_RENDERER_AUTHORITY_REGISTER[1];
  const artifact = {
    role: "supporting_report_pdf",
    object_key: "makesafe-docket-artifacts/docket-fixture/report.pdf",
    media_type: "application/pdf",
    content_hash: contentHash,
    size_bytes: bytes.byteLength,
    metadata: {
      source_kind: "durable_curated_revision",
      source_identity: SUPERSEDED_IDENTITY,
      source_document_id: "sibling-document",
      report_document_id: "sibling-document",
      source_revision_id: "asbestos-misstatement",
      source_artifact_id: "asbestos-misstatement",
      source_artifact_content_hash: contentHash,
      expected_raw_sha256: `sha256:${rawHash}`,
      output_sha256: `sha256:${rawHash}`,
      render_hash: rawHash,
      report_input_hash: SUPERSEDED_INPUT,
      evidence_source: "explicit_sibling_bundle",
      report_contract_version: MAKESAFE_REPORT_CONTRACT_VERSION,
      bundle_id: "bundle-fixture",
      sibling_job_id: "sibling-job-fixture",
      binding_revision_id: "binding-revision-fixture",
      report_renderer_version: makesafeRendererAuthorityVersion(superseded),
      report_renderer_source_revision: superseded.source_revision,
      report_renderer_script_sha256: superseded.script_sha256,
    },
  };
  const siblingEvents = [
    {
      job_id: "sibling-job-fixture",
      created_at: "2026-08-05T00:00:00.000Z",
      detail_json: { document_id: "sibling-document" },
    },
    {
      job_id: "sibling-job-fixture",
      created_at: "2026-08-05T01:00:00.000Z",
      detail_json: {
        document_id: "sibling-document",
        supersedes_prior_bind: true,
        source_identity: CORRECTED_IDENTITY,
        expected_raw_sha256: CORRECTED_RAW,
        report_input_hash: CORRECTED_INPUT,
        prior_source_identity: SUPERSEDED_IDENTITY,
        prior_expected_raw_sha256: `sha256:${rawHash}`,
        prior_report_input_hash: SUPERSEDED_INPUT,
      },
    },
  ];
  return { artifact, bytes, siblingEvents };
}

Deno.test(
  "SEND IT refuses a release whose sibling bundle was superseded on the SIBLING job",
  async () => {
    // The send wall is the stronger surface: pack display only hides the
    // artifact, this stops the superseded report being mailed to the builder.
    // Scoping the supersession read to the DOCKET job filters by the sibling's
    // document id against events that can never carry it, so the wall would
    // always answer "not superseded" and the send would proceed.
    const { artifact, bytes, siblingEvents } =
      await supersededSiblingBundleFixture();
    const { client } = reviewPackClient(artifact, bytes, {
      jobEvents: siblingEvents,
    });
    const error = await assertRejects(
      () => assertSesDocketsSignedOffForSend(client, ["docket-fixture"]),
      SesActionError,
    );
    assertEquals(error.status, 409);
    assertEquals(
      (error.refusal as any).evidence.suppression_reason,
      "curated_source_superseded",
    );
  },
);

Deno.test(
  "SEND IT refuses when only the SIBLING job's supersession trail is unreadable",
  async () => {
    // An unreadable sibling trail is untrusted exactly like an unreadable
    // docket trail - never "no supersession", never a silently skipped
    // artifact. The docket job's own trail reads cleanly here, so the refusal
    // can only come from the sibling read.
    const { artifact, bytes } = await supersededSiblingBundleFixture();
    const { client } = reviewPackClient(artifact, bytes, {
      jobEvents: [],
      jobEventsErrorForJob: {
        job_id: "sibling-job-fixture",
        error: { message: "sibling trail unreadable" },
      },
    });
    const error = await assertRejects(
      () => assertSesDocketsSignedOffForSend(client, ["docket-fixture"]),
      SesActionError,
    );
    assertEquals(error.status, 409);
    assertEquals(
      (error.refusal as any).evidence.suppression_reason,
      "curated_source_supersession_unreadable",
    );
  },
);
