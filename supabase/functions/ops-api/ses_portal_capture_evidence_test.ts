// deno-lint-ignore-file no-import-prefix require-await
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { _authorizeOpsApiAction } from "./index.ts";
import fixture from "./fixtures/ses_u4_swms_26980_live_snapshot.json" with {
  type: "json",
};
import {
  rawSesPortalCaptureSha256,
  SES_PORTAL_CAPTURE_BUCKET,
  SES_PORTAL_CAPTURE_PRODUCER,
} from "./ses_portal_capture_contract.ts";
import {
  recordSesPortalCaptureEvidence,
  SesPortalCaptureEvidenceError,
} from "./ses_portal_capture_evidence.ts";

type Row = Record<string, unknown>;

const INDEX = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

function routeSlice(startMarker: string, endMarker: string): string {
  const start = INDEX.indexOf(startMarker);
  const end = INDEX.indexOf(endMarker, start);
  assert(start >= 0 && end > start, `${startMarker} route slice must exist`);
  return INDEX.slice(start, end);
}

function captureFixture() {
  const live = structuredClone(fixture) as unknown as Record<string, unknown>;
  const job = live.job as Row;
  const detail = live.detail as Row;
  const metadata = job.metadata as Row;
  metadata.makesafe_job_family = "roof_report";
  job.client_name = "Ordinary insured";
  detail.report_type = null;
  live.identity_revision = {
    authority_kind: "legacy_job_record",
    source_instruction_id: `legacy-job:${job.id}`,
    source_version: 1,
    source_content_hash: `sha256:${"a".repeat(64)}`,
    lineage_id: job.id,
    effective_case_id: null,
  };
  return live;
}

function clientFor(
  live: Record<string, unknown>,
  calls: {
    upload?: { bucket: string; path: string; bytes: Uint8Array };
    rpc?: { name: string; args: Record<string, unknown> };
  },
) {
  const rows: Record<string, unknown> = {
    jobs: [live.job],
    makesafe_job_details: [live.detail],
    makesafe_state_identity_current_v2: [live.identity_revision],
    makesafe_intake_cases: live.cases,
    makesafe_attendance_cycles: live.cycles,
    job_service_reports: live.reports,
    job_assignments: live.assignments,
    job_media: live.media,
    job_documents: live.documents,
    makesafe_roof_report_drafts: [],
    makesafe_readiness_current: [],
    makesafe_portal_capture_revisions: [],
    makesafe_report_packs: [],
  };
  return {
    storage: {
      from(bucket: string) {
        return {
          async upload(
            path: string,
            bytes: Uint8Array,
          ) {
            calls.upload = { bucket, path, bytes };
            return { data: { path }, error: null };
          },
          async download() {
            return { data: null, error: { message: "not found" } };
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
        in() {
          return query;
        },
        neq() {
          return query;
        },
        order() {
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
    async rpc(name: string, args: Record<string, unknown>) {
      calls.rpc = { name, args };
      return {
        data: {
          id: "a2fc8aa8-02c2-5eb2-be87-0ed88266543b",
          ...(args.p_capture as Row),
        },
        error: null,
      };
    },
  };
}

async function validBody(
  live: Record<string, unknown>,
  screenshotBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
) {
  const job = live.job as Row;
  const detail = live.detail as Row;
  const screenshotHash = await rawSesPortalCaptureSha256(screenshotBytes);
  let binary = "";
  for (const byte of screenshotBytes) binary += String.fromCharCode(byte);
  return {
    job_id: job.id,
    attendance_cycle_id: detail.attendance_cycle_id,
    role: "roof_report",
    capture_result: "done",
    source_url:
      "https://primeeco.tech/share/2ef11c67-8f63-48cb-9ff4-61bf71848f17",
    source_content_hash: `sha256:${"b".repeat(64)}`,
    builder_reference: detail.external_ref,
    captured_at: new Date(Date.now() - 60_000).toISOString(),
    captured_by: "chrome-agent@secureworks.test",
    capture_producer: SES_PORTAL_CAPTURE_PRODUCER,
    capture_idempotency_key: "capture-swms-26980-roof-v1",
    signal: "submitted-and-locked",
    screenshot: {
      media_type: "image/png",
      content_hash: screenshotHash,
      bytes_base64: btoa(binary),
    },
  };
}

Deno.test(
  "routine record_ses_portal_capture_evidence reaches the handler and persists screenshot-backed evidence",
  async () => {
    const routineAllowlist = routeSlice(
      "const ROUTINE_ALLOWED_ACTIONS = new Set([",
      "if (authMode === 'routine'",
    );
    const captureHandler = routeSlice(
      "case 'record_ses_portal_capture_evidence':",
      "case 'scan_ses_makesafes':",
    );
    assertStringIncludes(
      routineAllowlist,
      "'record_ses_portal_capture_evidence'",
    );
    assertStringIncludes(captureHandler, "authMode === 'routine'");

    const live = captureFixture();
    const calls: {
      upload?: { bucket: string; path: string; bytes: Uint8Array };
      rpc?: { name: string; args: Record<string, unknown> };
    } = {};
    const body = await validBody(live);
    const result = await recordSesPortalCaptureEvidence(
      clientFor(live, calls),
      body,
      "ops-api:routine",
    );

    assert(calls.upload);
    assertEquals(calls.upload.bucket, SES_PORTAL_CAPTURE_BUCKET);
    const screenshotHash = body.screenshot.content_hash;
    const expectedPath = [
      "portal-captures",
      body.job_id,
      body.attendance_cycle_id,
      body.role,
      `${screenshotHash.slice("sha256:".length)}.png`,
    ].join("/");
    assertEquals(calls.upload.path, expectedPath);
    assertEquals(
      calls.upload.bytes,
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    assertEquals(calls.rpc?.name, "commit_makesafe_portal_capture_v1");
    const capture = calls.rpc?.args.p_capture as Row;
    assertEquals(capture.captured_by, body.captured_by);
    assertEquals(capture.captured_at, body.captured_at);
    assertEquals(capture.source_url, body.source_url);
    assertEquals(capture.source_content_hash, body.source_content_hash);
    assertEquals(capture.capture_producer, SES_PORTAL_CAPTURE_PRODUCER);
    assertEquals(capture.created_by, "ops-api:routine");
    assertEquals(result.id, "a2fc8aa8-02c2-5eb2-be87-0ed88266543b");

    const changedBytes = new Uint8Array([
      137,
      80,
      78,
      71,
      13,
      10,
      26,
      10,
      0,
    ]);
    const changedBody = await validBody(live, changedBytes);
    const changedCalls: {
      upload?: { bucket: string; path: string; bytes: Uint8Array };
      rpc?: { name: string; args: Record<string, unknown> };
    } = {};
    await recordSesPortalCaptureEvidence(
      clientFor(live, changedCalls),
      changedBody,
      "ops-api:routine",
    );
    assert(changedCalls.upload);
    assertEquals(
      changedCalls.upload.path.endsWith(
        `${changedBody.screenshot.content_hash.slice("sha256:".length)}.png`,
      ),
      true,
    );
    assert(
      changedCalls.upload.path !== calls.upload.path,
      "changing screenshot content must change its storage address",
    );
  },
);

Deno.test(
  "anonymous callers remain denied and the capture handler retains its 403 guard",
  () => {
    const decision = _authorizeOpsApiAction({
      url: new URL(
        "https://example.invalid/ops-api?action=record_ses_portal_capture_evidence",
      ),
      authMode: "none",
    });
    assertEquals(decision.ok, false);
    if (!decision.ok) assertEquals(decision.status, 401);

    const captureHandler = routeSlice(
      "case 'record_ses_portal_capture_evidence':",
      "case 'scan_ses_makesafes':",
    );
    assertStringIncludes(captureHandler, "if (!captureIsPrivileged)");
    assertStringIncludes(captureHandler, "}, 403)");
  },
);

Deno.test(
  "routine capture still rejects untrusted producers and non-PNG evidence",
  async () => {
    const live = captureFixture();

    const untrustedBody = await validBody(live) as Record<string, unknown>;
    untrustedBody.capture_producer = "untrusted-observer/v1";
    const producerError = await assertRejects(
      () =>
        recordSesPortalCaptureEvidence(
          clientFor(live, {}),
          untrustedBody,
          "ops-api:routine",
        ),
      SesPortalCaptureEvidenceError,
      "capture_producer must be",
    );
    assertEquals(producerError.code, "ses_portal_capture_producer_unapproved");

    const nonPngBody = await validBody(
      live,
      new Uint8Array([1, 2, 3, 4]),
    );
    const pngError = await assertRejects(
      () =>
        recordSesPortalCaptureEvidence(
          clientFor(live, {}),
          nonPngBody,
          "ops-api:routine",
        ),
      SesPortalCaptureEvidenceError,
      "must contain PNG bytes",
    );
    assertEquals(pngError.code, "ses_portal_capture_invalid");
  },
);

Deno.test(
  "routine capture still rejects screenshot bytes that do not match their claimed hash",
  async () => {
    const live = captureFixture();
    const body = await validBody(live);
    body.screenshot.content_hash = `sha256:${"c".repeat(64)}`;
    const error = await assertRejects(
      () =>
        recordSesPortalCaptureEvidence(
          clientFor(live, {}),
          body,
          "ops-api:routine",
        ),
      SesPortalCaptureEvidenceError,
      "screenshot.content_hash does not match",
    );
    assertEquals(error.code, "ses_portal_capture_hash_mismatch");
  },
);

Deno.test(
  "scan_ses_makesafes remains forbidden to the routine key",
  () => {
    const routineAllowlist = routeSlice(
      "const ROUTINE_ALLOWED_ACTIONS = new Set([",
      "if (authMode === 'routine'",
    );
    assert(
      !routineAllowlist.includes("'scan_ses_makesafes'"),
      "routine envelope must keep scan_ses_makesafes default-denied",
    );

    const scanHandler = routeSlice(
      "case 'scan_ses_makesafes':",
      "case 'makesafe_pdf_extraction_drain':",
    );
    assert(!scanHandler.includes("authMode === 'routine'"));
    assertStringIncludes(scanHandler, "if (!scanIsPrivileged)");
    assertStringIncludes(scanHandler, "}, 403)");
  },
);

Deno.test(
  "capture evidence can persist while a separate builder-reference spine fact is missing",
  async () => {
    const live = captureFixture();
    const detail = live.detail as Row;
    const job = live.job as Row;
    detail.external_ref = "";
    (job.metadata as Row).external_ref = "";
    const body = await validBody(live);
    body.builder_reference = "";
    const calls: {
      upload?: { bucket: string; path: string; bytes: Uint8Array };
      rpc?: { name: string; args: Record<string, unknown> };
    } = {};

    await recordSesPortalCaptureEvidence(
      clientFor(live, calls),
      body,
      "ops-api:api_key",
    );

    assertEquals(
      (calls.rpc?.args.p_capture as Row).builder_reference,
      "",
    );
  },
);
