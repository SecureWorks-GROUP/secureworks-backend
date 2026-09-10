// deno-lint-ignore-file no-import-prefix require-await

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildOwnRoofSupersessionAudit,
  inspectOwnRoofReportArtifactTrust,
  rawSha256Bytes,
  resolveOwnRoofReportArtifact,
  validateOwnRoofReportBind,
  type OwnRoofReportDocumentRow,
  type OwnRoofReportDraftRow,
} from "./ses_roof_report_artifact.ts";

const JOB_ID = "52af3a87-14a0-47b2-a209-720cd9a7b01c";
const CYCLE_ID = "5f9d8f83-2f9d-4d14-a04f-1d7a8d4b5b70";
const OLD_DOCUMENT_ID = "eca01792-1574-41e7-9d3b-0d2ff6670844";
const REVIEWED_DOCUMENT_ID = "c23f2cff-af3f-4b31-8fb4-f7b1b9f0247f";
const REVIEWED_BYTES = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55]);
const REVIEWED_SHA = "sha256:86edbaa24831badfa0a8b04bb410141e2ee4182b6d0014493fe262a7a331c20b";

function draft(
  overrides: Partial<OwnRoofReportDraftRow> = {},
): OwnRoofReportDraftRow {
  return {
    id: "7cb7733a-b5a1-4941-9d2e-2810da207f27",
    job_id: JOB_ID,
    status: "submitted",
    submitted_cycle: 1,
    report_doc_id: OLD_DOCUMENT_ID,
    updated_at: "2026-09-10T08:00:00.000Z",
    ...overrides,
  };
}

function document(
  overrides: Partial<OwnRoofReportDocumentRow> = {},
): OwnRoofReportDocumentRow {
  return {
    id: REVIEWED_DOCUMENT_ID,
    job_id: JOB_ID,
    type: "roof_report",
    visible_to_trades: true,
    file_name: "Roof Report - SWMS-261313 - Scarborough.pdf",
    pdf_url: "https://documents.example.test/roof-reviewed.pdf",
    ...overrides,
  };
}

Deno.test("own roof resolver consumes the exact submitted-cycle pointer bytes", async () => {
  const result = await resolveOwnRoofReportArtifact({
    job_id: JOB_ID,
    current_cycle_number: 1,
    current_attendance_cycle_id: CYCLE_ID,
    draft: draft({ report_doc_id: REVIEWED_DOCUMENT_ID }),
    documents: [
      document(),
      document({
        id: "newer-unselected-roof-document",
        file_name: "newer-roof.pdf",
        pdf_url: "https://documents.example.test/newer-roof.pdf",
      }),
    ],
    download: async () => REVIEWED_BYTES,
  });

  assert(result.ok);
  assertEquals(result.artifact.bytes, REVIEWED_BYTES);
  assertEquals(result.artifact.provenance.source_document_id, REVIEWED_DOCUMENT_ID);
  assertEquals(result.artifact.provenance.source_job_id, JOB_ID);
  assertEquals(result.artifact.provenance.source_cycle_number, 1);
  assertEquals(result.artifact.provenance.source_raw_size_bytes, REVIEWED_BYTES.byteLength);
  assertEquals(result.artifact.provenance.source_raw_sha256, await result.raw_sha256);
  assertEquals(result.artifact.render_hash, undefined);
});

Deno.test("own roof resolver refuses wrong job, type, cycle, URL, PDF and hash", async () => {
  const cases: Array<[string, Partial<OwnRoofReportDraftRow>, Partial<OwnRoofReportDocumentRow>, number]> = [
    ["wrong job", {}, { job_id: "foreign-job" }, 1],
    ["wrong type", {}, { type: "makesafe_report" }, 1],
    ["cycle mismatch", { submitted_cycle: 2 }, {}, 1],
    ["non-PDF", {}, {}, 1],
  ];
  for (const [label, draftOverrides, documentOverrides, cycle] of cases) {
    const result = await resolveOwnRoofReportArtifact({
      job_id: JOB_ID,
      current_cycle_number: cycle,
      current_attendance_cycle_id: CYCLE_ID,
      draft: draft({ ...draftOverrides, report_doc_id: REVIEWED_DOCUMENT_ID }),
      documents: [document(documentOverrides)],
      download: async () => label === "non-PDF"
        ? new Uint8Array([78, 79, 84, 80, 68, 70])
        : REVIEWED_BYTES,
    });
    assert(!result.ok, label);
  }

  const hashMismatch = await resolveOwnRoofReportArtifact({
    job_id: JOB_ID,
    current_cycle_number: 1,
    current_attendance_cycle_id: CYCLE_ID,
    draft: draft({ report_doc_id: REVIEWED_DOCUMENT_ID }),
    documents: [document()],
    expected_raw_sha256: "sha256:" + "0".repeat(64),
    expected_raw_size_bytes: REVIEWED_BYTES.byteLength,
    download: async () => REVIEWED_BYTES,
  });
  assert(!hashMismatch.ok);
  assertEquals(hashMismatch.code, "own_roof_report_source_hash_mismatch");
});

Deno.test("own roof bind accepts explicit old-pointer supersession and preserves audit identity", async () => {
  const request = {
    job_id: JOB_ID,
    document_id: REVIEWED_DOCUMENT_ID,
    expected_current_document_id: OLD_DOCUMENT_ID,
    expected_draft_updated_at: draft().updated_at,
    expected_current_cycle: 1,
    expected_raw_sha256: REVIEWED_SHA,
    expected_raw_size_bytes: REVIEWED_BYTES.byteLength,
  };
  const checked = validateOwnRoofReportBind({
    request,
    draft: draft(),
    current_cycle_number: 1,
    document: document(),
  });
  assert(checked.ok);
  const audit = buildOwnRoofSupersessionAudit({
    request,
    draft: draft(),
    document: document(),
    source_raw_sha256: REVIEWED_SHA,
    source_raw_size_bytes: REVIEWED_BYTES.byteLength,
    actor: "captain@example.test",
    reason: "Attach reviewed Scarborough roof PDF",
  });
  assertEquals(audit.supersedes_prior_bind, true);
  assertEquals(audit.prior_document_id, OLD_DOCUMENT_ID);
  assertEquals(audit.document_id, REVIEWED_DOCUMENT_ID);
  assertEquals(audit.prior_draft_updated_at, draft().updated_at);
  assertEquals(audit.source_raw_sha256, REVIEWED_SHA);
});

Deno.test("own roof bind refuses stale expected pointer/version/cycle and wrong document", () => {
  const base = {
    job_id: JOB_ID,
    document_id: REVIEWED_DOCUMENT_ID,
    expected_current_document_id: OLD_DOCUMENT_ID,
    expected_draft_updated_at: draft().updated_at,
    expected_current_cycle: 1,
    expected_raw_sha256: REVIEWED_SHA,
    expected_raw_size_bytes: REVIEWED_BYTES.byteLength,
  };
  for (const [label, requestOverrides, draftOverrides, cycle, documentOverrides] of [
    ["stale pointer", { expected_current_document_id: "another-document" }, {}, 1, {}],
    ["stale version", { expected_draft_updated_at: "2026-09-10T09:00:00.000Z" }, {}, 1, {}],
    ["stale cycle", {}, {}, 2, {}],
    ["wrong document", {}, {}, 1, { job_id: "foreign-job" }],
  ] as const) {
    const checked = validateOwnRoofReportBind({
      request: { ...base, ...requestOverrides },
      draft: draft(draftOverrides),
      current_cycle_number: cycle,
      document: document(documentOverrides),
    });
    assert(!checked.ok, label);
  }
});

Deno.test("renderer input hash cannot stand in for own roof raw PDF hash", async () => {
  const result = await resolveOwnRoofReportArtifact({
    job_id: JOB_ID,
    current_cycle_number: 1,
    current_attendance_cycle_id: CYCLE_ID,
    draft: draft({ report_doc_id: REVIEWED_DOCUMENT_ID, last_render_hash: "renderer-input-hash" }),
    documents: [document()],
    download: async () => REVIEWED_BYTES,
  });
  assert(result.ok);
  assertEquals(result.artifact.render_hash, undefined);
  assertEquals(result.artifact.provenance.source_raw_sha256, await result.raw_sha256);
  assertEquals(result.artifact.provenance.source_raw_sha256, REVIEWED_SHA);
});

Deno.test("normal roof resolution refuses conflicting stamped size while bind supersession may replace it", async () => {
  const stamped = document({
    data_snapshot_json: {
      own_roof_source_raw_sha256: REVIEWED_SHA,
      own_roof_source_raw_size_bytes: REVIEWED_BYTES.byteLength + 1,
    },
  });
  const normal = await resolveOwnRoofReportArtifact({
    job_id: JOB_ID,
    current_cycle_number: 1,
    current_attendance_cycle_id: CYCLE_ID,
    draft: draft({ report_doc_id: REVIEWED_DOCUMENT_ID }),
    documents: [stamped],
    expected_raw_sha256: REVIEWED_SHA,
    expected_raw_size_bytes: REVIEWED_BYTES.byteLength,
    download: async () => REVIEWED_BYTES,
  });
  assert(!normal.ok);
  assertEquals(normal.code, "own_roof_report_source_size_conflict");

  const superseded = await resolveOwnRoofReportArtifact({
    job_id: JOB_ID,
    current_cycle_number: 1,
    current_attendance_cycle_id: CYCLE_ID,
    draft: draft({ report_doc_id: REVIEWED_DOCUMENT_ID }),
    documents: [stamped],
    expected_raw_sha256: REVIEWED_SHA,
    expected_raw_size_bytes: REVIEWED_BYTES.byteLength,
    allow_expected_hash_supersession: true,
    download: async () => REVIEWED_BYTES,
  });
  assert(superseded.ok);
});

Deno.test("own roof read trust rejects a stale superseded artifact and accepts the exact current one", async () => {
  const rawHash = await rawSha256Bytes(REVIEWED_BYTES);
  const currentDocument = document({
    data_snapshot_json: {
      own_roof_source_raw_sha256: rawHash,
      own_roof_source_raw_size_bytes: REVIEWED_BYTES.byteLength,
    },
    attendance_cycle_id: CYCLE_ID,
  });
  const currentDraft = draft({
    report_doc_id: REVIEWED_DOCUMENT_ID,
    updated_at: "2026-09-10T09:00:00.000Z",
  });
  const artifact = {
    role: "supporting_report_pdf",
    media_type: "application/pdf",
    size_bytes: REVIEWED_BYTES.byteLength,
    content_hash: "sha256:output-content-hash",
    metadata: {
      source_kind: "submitted_roof_report_document",
      source_identity:
        `own-roof:job:${JOB_ID}/cycle:${CYCLE_ID}/draft:${currentDraft.id}/document:${REVIEWED_DOCUMENT_ID}`,
      source_job_id: JOB_ID,
      source_draft_id: currentDraft.id,
      source_document_id: REVIEWED_DOCUMENT_ID,
      source_attendance_cycle_id: CYCLE_ID,
      source_cycle_number: 1,
      source_raw_sha256: rawHash,
      source_raw_size_bytes: REVIEWED_BYTES.byteLength,
      output_content_hash: "sha256:output-content-hash",
    },
  };
  const stale = inspectOwnRoofReportArtifactTrust({
    artifact: {
      ...artifact,
      metadata: {
        ...artifact.metadata,
        source_document_id: OLD_DOCUMENT_ID,
      },
    },
    job_id: JOB_ID,
    current_cycle_number: 1,
    current_attendance_cycle_id: CYCLE_ID,
    draft: currentDraft,
    document: currentDocument,
    served_raw_sha256: rawHash,
    served_raw_size_bytes: REVIEWED_BYTES.byteLength,
    served_content_hash: "sha256:output-content-hash",
  });
  assert(!stale.ok);
  assertEquals(stale.code, "own_roof_report_artifact_identity_stale");
  const trusted = inspectOwnRoofReportArtifactTrust({
    artifact,
    job_id: JOB_ID,
    current_cycle_number: 1,
    current_attendance_cycle_id: CYCLE_ID,
    draft: currentDraft,
    document: currentDocument,
    served_raw_sha256: rawHash,
    served_raw_size_bytes: REVIEWED_BYTES.byteLength,
    served_content_hash: "sha256:output-content-hash",
  });
  assertEquals(trusted, { ok: true });
});
