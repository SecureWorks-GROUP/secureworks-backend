// deno-lint-ignore-file no-explicit-any no-import-prefix
/**
 * Release-boundary proofs for the own-template roof source contract.
 *
 * These tests exercise the real Captain signoff and SEND IT preflight paths.
 * A current draft/document identity is accepted; an already-approved docket
 * whose artifact points at the superseded document is refused before signoff
 * or Graph dispatch. Missing ordinary pack documents remain caveats.
 */
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  executeSesReleaseRevisionAction,
  SesActionError,
  signOffSesDocketAction,
} from "./ses_reporting_actions.ts";
import { sesSha256Bytes } from "./ses_docket_envelope.ts";

const JOB_ID = "job-roof-release";
const DOCKET_ID = "docket-roof-release";
const RELEASE_ID = "release-roof-release";
const DRAFT_ID = "draft-roof-release";
const CURRENT_DOCUMENT_ID = "roof-document-current";
const OLD_DOCUMENT_ID = "roof-document-old";
const CYCLE_ID = "cycle-roof-current";
const OUTPUT_HASH = `sha256:${"e".repeat(64)}`;

type RoofFixture = Awaited<ReturnType<typeof makeRoofFixture>>;

async function rawSha256(bytes: Uint8Array): Promise<string> {
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", owned));
  return `sha256:${Array.from(digest).map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")}`;
}

function makeRoofFixture(stale = false) {
  const currentBytes = new TextEncoder().encode(
    "%PDF-1.7\ncurrent reviewed typed roof report",
  );
  const oldBytes = new TextEncoder().encode(
    "%PDF-1.7\nold superseded typed roof report",
  );
  const artifactBytes = stale ? oldBytes : currentBytes;
  const artifactRawHashPromise = rawSha256(artifactBytes);
  const documentId = stale ? OLD_DOCUMENT_ID : CURRENT_DOCUMENT_ID;

  const state = {
    currentBytes,
    oldBytes,
    artifactBytes,
    artifactRawHashPromise,
    documentId,
    stale,
    graphCalls: [] as any[],
    rpcCalls: [] as string[],
    effects: new Map<string, any>(),
  };

  const currentDocument = {
    id: CURRENT_DOCUMENT_ID,
    job_id: JOB_ID,
    type: "roof_report",
    file_name: "Scarborough SWMS-261313 current typed roof report.pdf",
    pdf_url: "https://documents.example/roof-current.pdf",
    storage_url: "https://documents.example/roof-current.pdf",
    visible_to_trades: true,
    attendance_cycle_id: CYCLE_ID,
    cycle_attribution: "1",
    data_snapshot_json: {},
  };
  const oldDocument = {
    id: OLD_DOCUMENT_ID,
    job_id: JOB_ID,
    type: "roof_report",
    file_name: "Scarborough SWMS-261313 old typed roof report.pdf",
    pdf_url: "https://documents.example/roof-old.pdf",
    storage_url: "https://documents.example/roof-old.pdf",
    visible_to_trades: true,
    attendance_cycle_id: CYCLE_ID,
    cycle_attribution: "1",
    data_snapshot_json: {},
  };
  const invoiceDocument = {
    id: "invoice-document-roof",
    job_id: JOB_ID,
    type: "invoice",
    file_name: "Invoice.pdf",
    storage_url: "https://documents.example/invoice.pdf",
  };
  const draft = {
    id: DRAFT_ID,
    job_id: JOB_ID,
    pack_kind: "roof",
    status: "submitted",
    submitted_cycle: 1,
    report_doc_id: stale ? CURRENT_DOCUMENT_ID : CURRENT_DOCUMENT_ID,
    updated_at: "2026-09-10T01:00:00.000Z",
  };
  const detail = {
    job_id: JOB_ID,
    report_type: "roof_report",
    substatus: "admin_to_send_report",
    external_ref: "SWMS-261313",
    external_links: [],
    attendance_cycle_id: CYCLE_ID,
    cycle_number: 1,
    requesting_company_slug: "mlb",
    requesting_company_name: "ML Builders",
  };

  return Promise.resolve(artifactRawHashPromise).then(async (rawHash) => {
    const artifactContentHash = await sesSha256Bytes(artifactBytes);
    const sourceDocument = stale ? oldDocument : currentDocument;
    sourceDocument.data_snapshot_json = {
      own_roof_source_raw_sha256: rawHash,
      own_roof_source_raw_size_bytes: artifactBytes.byteLength,
    };
    const artifact = {
      id: "roof-artifact-release",
      revision_id: DOCKET_ID,
      role: "supporting_report_pdf",
      object_key: `makesafe-docket-artifacts/${DOCKET_ID}/roof-report.pdf`,
      media_type: "application/pdf",
      content_hash: artifactContentHash,
      size_bytes: artifactBytes.byteLength,
      metadata: {
        source_kind: "submitted_roof_report_document",
        evidence_source: "current_cycle_own_template_roof_report",
        source_job_id: JOB_ID,
        source_draft_id: DRAFT_ID,
        source_document_id: documentId,
        source_attendance_cycle_id: CYCLE_ID,
        source_cycle_number: 1,
        source_identity:
          `own-roof:job:${JOB_ID}/cycle:${CYCLE_ID}/draft:${DRAFT_ID}/document:${documentId}`,
        source_raw_sha256: rawHash,
        source_raw_size_bytes: artifactBytes.byteLength,
        output_content_hash: artifactContentHash,
      },
    };
    const invoiceArtifact = {
      id: "invoice-artifact-release",
      revision_id: DOCKET_ID,
      role: "invoice_pdf",
      object_key: `makesafe-docket-artifacts/${DOCKET_ID}/invoice.pdf`,
      media_type: "application/pdf",
      content_hash: `sha256:${"3".repeat(64)}`,
      size_bytes: 300_000,
      metadata: {},
    };

    const rows: Record<string, any> = {
      ses_docket_review_current: {
        docket_revision_id: DOCKET_ID,
        docket_output_content_hash: OUTPUT_HASH,
        assembler_version: "ses-pack-assembler/v1",
        family_matrix_version: "family-matrix/v1",
        review_state: "needs_review",
      },
      makesafe_docket_revisions: {
        id: DOCKET_ID,
        org_id: "org-roof",
        job_id: JOB_ID,
        output_content_hash: OUTPUT_HASH,
        assembler_version: "ses-pack-assembler/v1",
        family_matrix_version: "family-matrix/v1",
        state: "drafted",
        stage: "invoice_bound",
        pre_xero_docs_ready: true,
        envelope: {
          v2: {
            classification: {
              builder_key: "MLB",
              family: "own_template_roof",
              report_only: true,
            },
            routing: { invoice_to: "makesafes@mlbuilders.com.au" },
          },
          pre_xero_docs_ready: true,
        },
        blockers: [],
        email_drafts: {},
        review_spec: {},
        local_invoice_proposal: null,
        xero_binding: {
          status: "AUTHORISED",
          xero_invoice_id: "xero-roof-release",
        },
        artifact_count: 2,
        artifact_size_bytes: artifactBytes.byteLength + 300_000,
        invoice_obligation_revision_id: null,
        attendance_cycle_ids: [CYCLE_ID],
      },
      makesafe_docket_artifacts: [artifact, invoiceArtifact],
      makesafe_report_packs: {
        id: "pack-roof-release",
        job_id: JOB_ID,
        pack_kind: "main",
        status: "drafted",
        report_doc_id: CURRENT_DOCUMENT_ID,
        invoice_doc_id: invoiceDocument.id,
        swms_doc_id: null,
        sent_at: null,
      },
      jobs: {
        id: JOB_ID,
        type: "makesafe",
        status: "in_progress",
        metadata: { makesafe_job_family: "own_template_roof" },
      },
      makesafe_job_details: detail,
      makesafe_roof_report_drafts: draft,
      job_documents: [sourceDocument, ...(stale ? [currentDocument] : []), invoiceDocument],
      job_assignments: [],
      job_service_reports: [],
      makesafe_portal_capture_revisions: [],
      ses_docket_review_events: [],
      job_events: [],
      makesafe_invoice_obligation_revisions_current: [],
      makesafe_invoice_obligation_revisions: [],
      makesafe_release_revisions: {
        id: RELEASE_ID,
        content_hash: OUTPUT_HASH,
        state: "approved",
        created_at: "2026-09-10T02:00:00.000Z",
        updated_at: "2026-09-10T02:00:00.000Z",
        readiness_bindings: [],
      },
      makesafe_release_revision_members: {
        ordinal: 1,
        release_revision_id: RELEASE_ID,
        job_id: JOB_ID,
        docket_revision_id: DOCKET_ID,
        invoice_obligation_revision_id: null,
      },
      makesafe_release_revision_routes: [
        {
          release_revision_id: RELEASE_ID,
          ordinal: 0,
          route_kind: "report",
          recipients: ["makesafes@mlbuilders.com.au"],
          cc: [],
          subject: "SWMS-261313 report",
          body: "Please find attached the roof report.",
          body_hash: `sha256:${"1".repeat(64)}`,
          attachment_hashes: [artifactContentHash],
        },
        {
          release_revision_id: RELEASE_ID,
          ordinal: 1,
          route_kind: "invoice",
          recipients: ["makesafes@mlbuilders.com.au"],
          cc: [],
          subject: "SWMS-261313 invoice",
          body: "Please find attached the invoice.",
          body_hash: `sha256:${"2".repeat(64)}`,
          attachment_hashes: [artifactContentHash, invoiceArtifact.content_hash],
        },
      ],
      ses_external_effects: [],
      makesafe_closeout_revisions: null,
      makesafe_revision_approvals_current_v2: {
        id: "release-approval-roof",
        action: "release",
        release_revision_id: RELEASE_ID,
        job_id: JOB_ID,
        approval_content_hash: OUTPUT_HASH,
      },
      makesafe_revision_approvals: [],
      makesafe_readiness_current_v2: null,
    };

    const client = {
      from(table: string) {
        let filters: Array<[string, unknown]> = [];
        let inFilters: Array<[string, unknown[]]> = [];
        let single = false;
        const execute = () => {
          const source = rows[table];
          const values = Array.isArray(source)
            ? source
            : source == null
            ? []
            : [source];
          const filtered = values.filter((row) =>
            filters.every(([column, value]) => row?.[column] === value) &&
            inFilters.every(([column, valuesIn]) => valuesIn.includes(row?.[column]))
          );
          return {
            data: single ? filtered[0] || null : filtered,
            error: null,
          };
        };
        const builder: any = {
          select: () => builder,
          eq: (column: string, value: unknown) => {
            filters = [...filters, [column, value]];
            return builder;
          },
          in: (column: string, valuesIn: unknown[]) => {
            inFilters = [...inFilters, [column, valuesIn]];
            return builder;
          },
          order: () => builder,
          limit: () => builder,
          maybeSingle: () => {
            single = true;
            return Promise.resolve(execute());
          },
          then: (resolve: any, reject: any) =>
            Promise.resolve(execute()).then(resolve, reject),
        };
        return builder;
      },
      rpc(name: string, args: Record<string, any>) {
        state.rpcCalls.push(name);
        if (name === "assert_ses_dockets_signed_off_v1") {
          return Promise.resolve({ data: true, error: null });
        }
        if (name === "begin_ses_release_execution_v1") {
          return Promise.resolve({ data: { reserved: true }, error: null });
        }
        if (name === "claim_ses_external_effect_v1") {
          const effect = { ...args.p_effect, state: "reserved" };
          state.effects.set(String(effect.operation_key), effect);
          return Promise.resolve({
            data: { claim_mode: "reserved", effect },
            error: null,
          });
        }
        if (name === "transition_ses_external_effect_v1") {
          const effect = state.effects.get(String(args.p_operation_key)) || {
            operation_key: String(args.p_operation_key),
            external_token: "",
            effect_kind: "route_send",
          };
          return Promise.resolve({
            data: { ...effect, state: args.p_to_state },
            error: null,
          });
        }
        if (name === "confirm_ses_release_route_v1") {
          return Promise.resolve({
            data: { proof_hash: args.p_proof_hash },
            error: null,
          });
        }
        if (name === "commit_ses_release_closeout_v1") {
          const closeout = { ...(args.p_closeout || {}), verified: true };
          rows.makesafe_closeout_revisions = closeout;
          return Promise.resolve({ data: closeout, error: null });
        }
        return Promise.resolve({ data: {}, error: null });
      },
      storage: {
        from: () => ({
          createSignedUrl: () => Promise.resolve({
            data: { signedUrl: "https://signed.example/roof.pdf" },
            error: null,
          }),
          download: () => Promise.resolve({
            data: new Blob([state.artifactBytes]),
            error: null,
          }),
          upload: () => Promise.resolve({ data: null, error: null }),
        }),
      },
    } as any;
    return { client, state, artifact, rows };
  });
}

function mailGateway(state: RoofFixture["state"]) {
  const sentByToken = new Map<string, any>();
  return {
    createDraftAndSend: (payload: any, context: any) => {
      const result = {
        message_id: `graph-roof-${state.graphCalls.length}`,
        internet_message_id: `<roof-${state.graphCalls.length}@graph>`,
        state: "sent" as const,
        operation_token: context.external_token,
      };
      state.graphCalls.push({ payload, context });
      sentByToken.set(String(context.external_token), result);
      return Promise.resolve(result);
    },
    reconcileSent: (token: string) => {
      const result = sentByToken.get(String(token));
      return Promise.resolve(result ? [result] : []);
    },
  };
}

async function withRoofFetch<T>(fixture: RoofFixture, run: () => Promise<T>) {
  const previous = globalThis.fetch;
  globalThis.fetch = (input: RequestInfo | URL) => {
    const url = String(input);
    const bytes = url.includes("roof-old")
      ? fixture.state.oldBytes
      : fixture.state.currentBytes;
    return Promise.resolve(new Response(bytes, { status: 200 }));
  };
  try {
    return await run();
  } finally {
    globalThis.fetch = previous;
  }
}

Deno.test("signoff refuses a stale own-roof artifact before recording signoff", async () => {
  const fixture = await makeRoofFixture(true);
  const error = await withRoofFetch(fixture, () =>
    assertRejects(
      () =>
        signOffSesDocketAction(
          fixture.client,
          {
            mode: "jwt",
            user: { id: "captain-roof", email: "", role: "owner" },
          },
          {
            docket_revision_id: DOCKET_ID,
            expected_output_content_hash: OUTPUT_HASH,
          },
        ),
      SesActionError,
    )
  );
  assertEquals(error.status, 409);
  assertEquals((error.refusal as any).code, "own_roof_source_missing");
  assertEquals(
    fixture.state.rpcCalls.includes("record_ses_docket_review_state_v1"),
    false,
  );
});

Deno.test("signoff accepts the exact current-cycle own-roof artifact while retaining ordinary missing-doc caveats", async () => {
  const fixture = await makeRoofFixture(false);
  const result = await withRoofFetch(fixture, () =>
    signOffSesDocketAction(
      fixture.client,
      {
        mode: "jwt",
        user: { id: "captain-roof", email: "", role: "owner" },
      },
      {
        docket_revision_id: DOCKET_ID,
        expected_output_content_hash: OUTPUT_HASH,
      },
    )
  );
  assertEquals(
    fixture.state.rpcCalls.includes("record_ses_docket_review_state_v1"),
    true,
  );
  assertEquals(result.artifact_truth.closeout_documents.report, false);
  assertEquals(result.caveats.some((caveat: any) =>
    caveat.code === "required_pack_artifact_missing"), true);
  assertEquals(result.caveats.some((caveat: any) =>
    caveat.code === "own_roof_source_missing"), false);
});

Deno.test("SEND IT refuses stale own-roof bytes before any Graph dispatch", async () => {
  const fixture = await makeRoofFixture(true);
  const error = await withRoofFetch(fixture, () =>
    assertRejects(
      () =>
        executeSesReleaseRevisionAction(
          fixture.client,
          { mode: "api_key", user: null },
          {
            org_id: "org-roof",
            release_revision_id: RELEASE_ID,
            actor: "captain-roof",
          },
          mailGateway(fixture.state),
          { readAuthorised: () => Promise.resolve(true) },
        ),
      SesActionError,
    )
  );
  assertEquals(error.status, 409);
  assertEquals((error.refusal as any).code, "own_roof_source_missing");
  assertEquals(fixture.state.graphCalls, []);
  assertEquals(
    fixture.state.rpcCalls.includes("begin_ses_release_execution_v1"),
    false,
  );
});

Deno.test("SEND IT accepts the exact current-cycle own-roof source and dispatches its route", async () => {
  const fixture = await makeRoofFixture(false);
  const result = await withRoofFetch(fixture, () =>
    executeSesReleaseRevisionAction(
      fixture.client,
      { mode: "api_key", user: null },
      {
        org_id: "org-roof",
        release_revision_id: RELEASE_ID,
        actor: "captain-roof",
      },
      mailGateway(fixture.state),
      { readAuthorised: () => Promise.resolve(true) },
    )
  );
  assertEquals(result.state, "released");
  assertEquals(fixture.state.graphCalls.length, 2);
  assert(
    fixture.state.graphCalls.some((call: any) =>
      call.payload.route_kind === "report"
    ),
  );
  assertStringIncludes(
    String(fixture.state.graphCalls.find((call: any) =>
      call.payload.route_kind === "report"
    )?.payload.body || ""),
    "roof report",
  );
});
