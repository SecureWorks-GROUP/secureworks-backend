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
  bertramProtectedReportRepairPlan,
  canonicalMakesafeReportJob,
} from "./index.ts";
import {
  canonicalCurrentWikiReportHashPayload,
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
  return `sha256:${await sha(new TextEncoder().encode(canonicalSesJson(
    canonicalCurrentWikiReportHashPayload(job),
  )))}`;
}

Deno.test("current-wiki input hash binds photo bytes, not temp paths", async () => {
  const contentHash = "a".repeat(64);
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
    photos: [{ ...apply.photos[0], content_sha256: "b".repeat(64) }],
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
