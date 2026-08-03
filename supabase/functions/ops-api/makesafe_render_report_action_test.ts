// deno-lint-ignore-file no-explicit-any no-import-prefix
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _attachCurrentWikiCuratedReportForTest,
  _makesafeRenderReportForTest,
  ApiError,
  canonicalMakesafeReportJob,
} from "./index.ts";
import {
  MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_SHA256,
  MAKESAFE_REPORT_AUTHORITATIVE_SOURCE_REVISION,
  MAKESAFE_REPORT_CONTRACT_VERSION,
  renderMakesafeReportPdf,
} from "./makesafe_report_render.ts";
import { canonicalSesJson } from "./ses_docket_envelope.ts";

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

function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function currentReportJob() {
  return {
    ref: "REF-001",
    address: "Privacy-safe test property",
    contact: "Canonical site contact",
    materials_evidence: { state: "none_recorded", items: [] },
    photos: [],
    photo_evidence: {
      source_revision: "fixture-source-1",
      completeness_verified: true,
      source_count: 0,
      applicable_count: 0,
      selected_count: 0,
      applicable_ids: [],
      selected_ids: [],
      excluded: [],
      rejected: [],
    },
  };
}

async function inputHash(job: Record<string, unknown>): Promise<string> {
  return `sha256:${await sha(new TextEncoder().encode(canonicalSesJson(job)))}`;
}

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

Deno.test("current-wiki attach retries identical bytes without writes", async () => {
  const pdf = new TextEncoder().encode("%PDF-fixture");
  const rawHash = await sha(pdf);
  const reportJob = currentReportJob();
  const reportInputHash = await inputHash(reportJob);
  const { client, mutations } = attachClient("SWMS-TEST", {
    report_contract_version: MAKESAFE_REPORT_CONTRACT_VERSION,
    report_renderer_source_revision:
      MAKESAFE_REPORT_AUTHORITATIVE_SOURCE_REVISION,
    report_renderer_script_sha256:
      MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_SHA256,
    report_render_hash: rawHash,
    report_input_hash: reportInputHash,
    report_renderer_version:
      `secureworks.wiki-python/${MAKESAFE_REPORT_AUTHORITATIVE_SOURCE_REVISION}`,
    evidence_source: "current_cycle_curated_makesafe_report",
    source_document_id: "document-fixture",
  });
  const result: any = await _attachCurrentWikiCuratedReportForTest(client, {
    job_id: "job-fixture",
    renderer_source_revision: MAKESAFE_REPORT_AUTHORITATIVE_SOURCE_REVISION,
    renderer_script_sha256: MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_SHA256,
    pdf_base64: base64(pdf),
    pdf_sha256: rawHash,
    report_input_hash: reportInputHash,
    report_job: reportJob,
  });
  assertEquals(result.writes, 0);
  assertEquals(result.skipped, true);
  assertEquals(mutations, []);
});

Deno.test("identical current-wiki attachment repairs provenance once", async () => {
  const pdf = new TextEncoder().encode("%PDF-fixture");
  const rawHash = await sha(pdf);
  const reportJob = currentReportJob();
  const { client, mutations, updates } = attachClient("SWMS-TEST", {
    report_contract_version: MAKESAFE_REPORT_CONTRACT_VERSION,
    report_render_hash: rawHash,
    report_renderer_version:
      `secureworks.wiki-python/${MAKESAFE_REPORT_AUTHORITATIVE_SOURCE_REVISION}`,
  });
  const body = {
    job_id: "job-fixture",
    renderer_source_revision: MAKESAFE_REPORT_AUTHORITATIVE_SOURCE_REVISION,
    renderer_script_sha256: MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_SHA256,
    pdf_base64: base64(pdf),
    pdf_sha256: rawHash,
    report_input_hash: await inputHash(reportJob),
    report_job: reportJob,
  };
  const first: any = await _attachCurrentWikiCuratedReportForTest(client, body);
  const second: any = await _attachCurrentWikiCuratedReportForTest(
    client,
    body,
  );
  assertEquals(first.writes, 1);
  assertEquals(second.writes, 0);
  assertEquals(mutations, ["update:job_documents"]);
  const snapshot = updates[0].data_snapshot_json as Record<string, unknown>;
  assertEquals(
    snapshot.report_contract_version,
    MAKESAFE_REPORT_CONTRACT_VERSION,
  );
  assertEquals(
    snapshot.report_renderer_version,
    `secureworks.wiki-python/${MAKESAFE_REPORT_AUTHORITATIVE_SOURCE_REVISION}`,
  );
  assertEquals(snapshot.report_render_hash, rawHash);
  assertEquals(
    snapshot.report_renderer_source_revision,
    MAKESAFE_REPORT_AUTHORITATIVE_SOURCE_REVISION,
  );
  assertEquals(
    snapshot.report_renderer_script_sha256,
    MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_SHA256,
  );
  assertEquals(snapshot.report_input_hash, await inputHash(reportJob));
  assertEquals(
    snapshot.evidence_source,
    "current_cycle_curated_makesafe_report",
  );
  assertEquals(snapshot.source_document_id, "document-fixture");
});

Deno.test("captain-corrected report refuses before attachment mutation", async () => {
  const pdf = new TextEncoder().encode("%PDF-different-fixture");
  const rawHash = await sha(pdf);
  const reportJob = currentReportJob();
  const reportInputHash = await inputHash(reportJob);
  const { client, mutations } = attachClient("SWMS-261109", {});
  const error = await assertRejects(
    () =>
      _attachCurrentWikiCuratedReportForTest(client, {
        job_id: "job-fixture",
        renderer_source_revision: MAKESAFE_REPORT_AUTHORITATIVE_SOURCE_REVISION,
        renderer_script_sha256: MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_SHA256,
        pdf_base64: base64(pdf),
        pdf_sha256: rawHash,
        report_input_hash: reportInputHash,
        report_job: reportJob,
      }),
    ApiError,
    "mutation-excluded",
  );
  assertEquals((error as ApiError).status, 409);
  assertEquals(mutations, []);
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
