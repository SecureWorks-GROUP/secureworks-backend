// deno-lint-ignore-file no-explicit-any no-import-prefix
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _parseSesDraftForTest,
  getSesReviewablePackAction,
  inspectSesSupportingReportProof,
  listSesDocsReadyReviewsAction,
  querySesReviewCockpitAction,
  resolveDocketRoutes,
  SesActionError,
  signOffSesDocketAction,
} from "./ses_reporting_actions.ts";
import {
  MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_SHA256,
  MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_VERSION,
  MAKESAFE_REPORT_AUTHORITATIVE_SOURCE_REVISION,
  MAKESAFE_REPORT_CONTRACT_VERSION,
} from "./makesafe_report_render.ts";
import { sesSha256Bytes } from "./ses_docket_envelope.ts";

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
  } = {},
) {
  const signedPaths: string[] = [];
  const rpcCalls: string[] = [];
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
          if (table === "job_events" && options.jobEventsError) {
            return Promise.resolve({
              data: null,
              error: options.jobEventsError,
            }).then(resolve);
          }
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

Deno.test("review pack keeps a byte-verified previously committed report visible", async () => {
  const bytes = new TextEncoder().encode("%PDF-1.7\ntrusted fixture");
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
  assertEquals(pack.suppressed_artifacts, []);
  assertEquals(pack.blockers, []);
  assertEquals(signedPaths, ["docket-fixture/report.pdf"]);
});

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
