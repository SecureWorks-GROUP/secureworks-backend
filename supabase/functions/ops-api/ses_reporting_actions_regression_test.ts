// deno-lint-ignore-file no-explicit-any no-import-prefix
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _parseSesDraftForTest,
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

Deno.test("persisted named-card caveats remain release holds outside the hard blocker column", () => {
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
      }],
    },
  });

  assertEquals(caveats.map((caveat) => caveat.code), [
    "canonical_draft_pack_output_missing",
    "canonical_draft_pack_output_incomplete",
    "curated_source_missing",
    "independent_source_kind_missing",
  ]);
  assertEquals(caveats.every((caveat) => caveat.state === "refused"), true);
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
  };
  const docket = {
    id: "docket-fixture",
    org_id: "org-fixture",
    job_id: "job-fixture",
    output_content_hash: review.docket_output_content_hash,
    assembler_version: review.assembler_version,
    family_matrix_version: review.family_matrix_version,
    stage: "pre_xero",
    committed_at: "2026-08-04T00:00:00.000Z",
    envelope: {
      v2: { classification: { family: "physical_makesafe" } },
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
  const rows: Record<string, unknown> = {
    ses_docket_review_current: review,
    makesafe_docket_revisions: docket,
    makesafe_docket_artifacts: [artifact],
    ses_docket_review_events: [],
    job_events: options.jobEvents || [],
    job_documents: document ? [document] : [],
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
        // The artifact read is column-projected in production, so a column the
        // caller forgets to select is genuinely absent here too.
        if (table !== "makesafe_docket_artifacts" || !columns) return value;
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

Deno.test("review pack suppresses unproved report bytes and exposes curated_source_missing", async () => {
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
  const { client, signedPaths } = reviewPackClient(artifact, bytes);
  const pack = await getSesReviewablePackAction(
    client,
    { mode: "api_key", user: null },
    "docket-fixture",
  );
  assertEquals(pack.artifacts, []);
  assertEquals(pack.suppressed_artifacts[0].signed_url, null);
  assertEquals(
    pack.suppressed_artifacts[0].blocker_code,
    "curated_source_missing",
  );
  assertEquals(pack.blockers[0].code, "curated_source_missing");
  assertEquals(
    (pack.blockers[0] as any).evidence.suppression_reason,
    "independent_source_kind_missing",
  );
  assertEquals(signedPaths, []);
});

Deno.test("Captain signoff refuses a report suppressed by the same read contract", async () => {
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
  const { client, rpcCalls, review } = reviewPackClient(artifact, bytes);
  const error = await assertRejects(
    () =>
      signOffSesDocketAction(
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
      ),
    SesActionError,
    "lacks an independently byte-bound",
  );
  assertEquals((error as SesActionError).status, 409);
  const refusal = (error as SesActionError).refusal as Record<string, unknown>;
  assertStringIncludes(
    String(refusal.recovery_action || ""),
    "bind_current_cycle_curated_makesafe_report",
  );
  assertEquals(rpcCalls, []);
});

Deno.test(
  "review pack suppresses Tuart-style previously_committed report that lacks completeness proof",
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
    assertEquals(pack.artifacts, []);
    assertEquals(pack.suppressed_artifacts[0].signed_url, null);
    assertEquals(
      pack.suppressed_artifacts[0].blocker_code,
      "curated_source_missing",
    );
    assertEquals(pack.blockers[0].code, "curated_source_missing");
    assertEquals(
      (pack.blockers[0] as any).evidence.suppression_reason,
      "independent_completeness_proof_missing",
    );
    assertEquals(signedPaths, []);
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

    // Same artifact, sibling bind event missing: the current pin is then the
    // only acceptable stamp, so the superseded identity still refuses.
    const unbound = reviewPackClient(artifact, bytes, { jobEvents: [] });
    const refused = await getSesReviewablePackAction(
      unbound.client,
      { mode: "api_key", user: null },
      "docket-fixture",
    );
    assertEquals(refused.artifacts, []);
    assertEquals(
      refused.suppressed_artifacts[0].suppression_reason,
      "active_renderer_input_binding_missing",
    );
  },
);

Deno.test(
  "the sibling bind read cannot admit a bundle whose sibling bind is invalid",
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
    assertEquals(fenced.artifacts, []);
    assertEquals(
      fenced.suppressed_artifacts[0].suppression_reason,
      "active_renderer_input_binding_missing",
    );
    assertEquals(afterRepin.signedPaths, []);

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
    assertEquals(early.artifacts, []);
    assertEquals(
      early.suppressed_artifacts[0].suppression_reason,
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
    assertEquals(stale.artifacts, []);
    assertEquals(
      stale.suppressed_artifacts[0].suppression_reason,
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
): any {
  const rows: Record<string, unknown> = {
    ...extraRows,
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

Deno.test("named-card review caveats keep SEND IT held after Docs Ready persistence", async () => {
  const cockpit = await querySesReviewCockpitAction(
    roofPortalCockpitClient(
      "not_applicable",
      {},
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

  assertEquals(cockpit.status, "HOLD");
  assertEquals(cockpit.controls.send_it.enabled, false);
  assertEquals(
    cockpit.verdict.blockers.some((blocker) =>
      blocker.code === "canonical_draft_pack_output_missing"
    ),
    true,
  );
});

Deno.test("cockpit response converts missing independent report proof into a visible HOLD", async () => {
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
  assertEquals(blocker?.code, "curated_source_missing");
  assertEquals(
    (blocker as any).evidence.suppression_reason,
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
  "bound Xero DRAFT makes invoice route ready without PDF and stops claiming no invoice",
  () => {
    const attachments = [
      "ARTIFACTS/invoice_proposal.json",
      "ARTIFACTS/report.pdf",
      "ARTIFACTS/swms.pdf",
    ];
    // Option B mint binds the DRAFT on the obligation while the docket stays
    // pre_xero with a stored draft that still says "No Xero invoice exists".
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
        },
      },
    )[0];
    assertEquals(draft.ready, true);
    assertStringIncludes(draft.subject, "INV-TEST-1");
    assertStringIncludes(draft.body, "DRAFT");
    assertStringIncludes(draft.body, "INV-TEST-1");
    assertEquals(draft.body.includes("No Xero invoice exists"), false);
    assertEquals(draft.attachment_hashes, ["report-hash", "swms-hash"]);

    // Same truth when the DRAFT is already on the docket binding.
    const onDocket = resolveDocketRoutes(
      invoiceDocket("invoice_bound", attachments, {
        status: "DRAFT",
        xero_invoice_id: "xero-invoice-test-1",
        invoice_number: "INV-TEST-1",
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
});

Deno.test("SEND IT still refuses a non-AJS release missing routes it owes", async () => {
  const sentSubjects: string[] = [];
  const error = await assertRejects(
    () =>
      executeSesReleaseRevisionAction(
        releaseExecuteClient([
          {
            ...INVOICE_ONLY_ROUTE,
            ordinal: 1,
            route_kind: "report",
          },
          { ...INVOICE_ONLY_ROUTE, ordinal: 2 },
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
