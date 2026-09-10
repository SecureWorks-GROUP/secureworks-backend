// deno-lint-ignore-file no-explicit-any no-import-prefix
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _bindCurrentCycleOwnRoofReportForTest,
  ApiError,
} from "./index.ts";
import { rawSha256Bytes } from "./ses_roof_report_artifact.ts";

const JOB_ID = "job-roof-bind-fixture";
const CYCLE_ID = "cycle-roof-bind-fixture";
const OLD_DOCUMENT_ID = "old-roof-document";
const NEW_DOCUMENT_ID = "reviewed-roof-document";
const DRAFT_ID = "roof-draft-fixture";
const BYTES = new TextEncoder().encode("%PDF-1.7\nreviewed roof bytes");

function bindClient(options: {
  packCasFail?: boolean;
  documentResponseError?: boolean;
  afterPackWrite?: () => void;
} = {}) {
  const oldSnapshot = {
    own_roof_source_identity: "own-roof:old-source",
    own_roof_source_raw_sha256: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    own_roof_source_raw_size_bytes: 1,
  };
  const oldDocument = {
    id: OLD_DOCUMENT_ID,
    job_id: JOB_ID,
    type: "roof_report",
    data_snapshot_json: oldSnapshot,
    version: 4,
  };
  const document: any = {
    id: NEW_DOCUMENT_ID,
    job_id: JOB_ID,
    type: "roof_report",
    file_name: "Roof Report - reviewed.pdf",
    pdf_url: "https://documents.example.test/reviewed-roof.pdf",
    storage_url: null,
    url: null,
    visible_to_trades: true,
    attendance_cycle_id: CYCLE_ID,
    cycle_attribution: null,
    data_snapshot_json: {},
    version: 1,
  };
  const draft: any = {
    id: DRAFT_ID,
    job_id: JOB_ID,
    pack_kind: "roof",
    status: "submitted",
    submitted_cycle: 1,
    report_doc_id: OLD_DOCUMENT_ID,
    updated_at: "2026-09-10T08:00:00.000Z",
    last_render_hash: "renderer-input-hash",
  };
  const pack: any = {
    id: "main-pack-fixture",
    status: "drafted",
    report_doc_id: OLD_DOCUMENT_ID,
    sent_at: null,
    send_started_at: null,
  };
  const mutations: Array<{ table: string; values: any }> = [];
  const rows: Record<string, any> = {
    jobs: { id: JOB_ID, type: "makesafe", job_number: "SWMS-261313" },
    makesafe_job_details: {
      job_id: JOB_ID,
      attendance_cycle_id: CYCLE_ID,
      cycle_number: 1,
      report_type: "roof_report",
    },
  };
  const client = {
    from(table: string) {
      const filters: Record<string, any> = {};
      const isFilters: Record<string, any> = {};
      const inFilters: Record<string, any[]> = {};
      let mutation: any = null;
      const query: any = {
        select: () => query,
        eq: (column: string, value: any) => {
          filters[column] = value;
          return query;
        },
        is: (column: string, value: any) => {
          isFilters[column] = value;
          return query;
        },
        in: (column: string, value: any[]) => {
          inFilters[column] = value;
          return query;
        },
        maybeSingle: () => Promise.resolve({
          data: table === "jobs"
            ? rows.jobs
            : table === "makesafe_job_details"
            ? rows.makesafe_job_details
            : table === "makesafe_roof_report_drafts"
            ? draft
            : table === "makesafe_report_packs"
            ? pack
            : table === "job_documents"
            ? filters.id === OLD_DOCUMENT_ID ? oldDocument
            : filters.id === NEW_DOCUMENT_ID ? document
            : null
            : null,
          error: null,
        }),
        insert: (values: any) => {
          mutations.push({ table, values });
          return Promise.resolve({ data: values, error: null });
        },
        update: (values: any) => {
          mutation = values;
          mutations.push({ table, values });
          if (table === "job_documents") Object.assign(document, values);
          if (table === "makesafe_roof_report_drafts") Object.assign(draft, values);
          return query;
        },
        delete: () => query,
        then: (resolve: (value: unknown) => unknown) => {
          if (!mutation) return Promise.resolve({ data: [], error: null }).then(resolve);
          const matches = table === "job_documents"
            ? filters.id === NEW_DOCUMENT_ID && filters.version === 1
            : table === "makesafe_roof_report_drafts"
            ? filters.id === DRAFT_ID && filters.updated_at === "2026-09-10T08:00:00.000Z" &&
              filters.report_doc_id === OLD_DOCUMENT_ID
            : table === "makesafe_report_packs"
            ? !options.packCasFail && filters.id === pack.id && (filters.report_doc_id !== undefined
              ? pack.report_doc_id === filters.report_doc_id
              : isFilters.report_doc_id === undefined
              ? pack.report_doc_id === null
              : pack.report_doc_id === isFilters.report_doc_id) &&
              pack.sent_at === null && pack.send_started_at === null &&
              inFilters.status?.includes(pack.status)
            : false;
          if (matches && table === "makesafe_report_packs") {
            Object.assign(pack, mutation);
            options.afterPackWrite?.();
          }
          if (table === "job_documents" && options.documentResponseError) {
            return Promise.resolve({ data: [], error: { message: "response lost after commit" } }).then(resolve);
          }
          return Promise.resolve({ data: matches ? [{ id: filters.id }] : [], error: null }).then(resolve);
        },
      };
      return query;
    },
  } as any;
  return {
    client,
    document,
    draft,
    pack,
    oldDocument,
    detail: rows.makesafe_job_details,
    mutations,
  };
}

function body(hash: string, size: number) {
  return {
    job_id: JOB_ID,
    document_id: NEW_DOCUMENT_ID,
    expected_current_document_id: OLD_DOCUMENT_ID,
    expected_current_pack_document_id: OLD_DOCUMENT_ID,
    expected_draft_updated_at: "2026-09-10T08:00:00.000Z",
    expected_current_cycle: 1,
    expected_raw_sha256: hash,
    expected_raw_size_bytes: size,
  };
}

async function withSource(run: () => Promise<unknown>, afterRead?: () => void) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    afterRead?.();
    return Promise.resolve(new Response(BYTES));
  };
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

Deno.test("own roof bind explicitly supersedes old draft/pack pointers and preserves renderer hash", async () => {
  const fixture = bindClient();
  const hash = await rawSha256Bytes(BYTES);
  const result: any = await withSource(() =>
    _bindCurrentCycleOwnRoofReportForTest(
      fixture.client,
      body(hash, BYTES.byteLength),
      { id: "captain@example.test", auth_mode: "api_key" },
    ));
  assertEquals(result.source_raw_sha256, hash);
  assertEquals(fixture.draft.report_doc_id, NEW_DOCUMENT_ID);
  assertEquals(fixture.draft.last_render_hash, "renderer-input-hash");
  assertEquals(fixture.pack.report_doc_id, NEW_DOCUMENT_ID);
  assertEquals(fixture.document.data_snapshot_json.own_roof_source_raw_sha256, hash);
  assertEquals(fixture.document.data_snapshot_json.own_roof_source_raw_size_bytes, BYTES.byteLength);
  const audit = fixture.mutations.find((item) => item.table === "job_events");
  assert(audit);
  assertEquals(audit.values.detail_json.prior_document_id, OLD_DOCUMENT_ID);
  assertEquals(audit.values.detail_json.prior_source_identity, oldSourceIdentity(fixture));
});

function oldSourceIdentity(fixture: ReturnType<typeof bindClient>) {
  return fixture.oldDocument.data_snapshot_json.own_roof_source_identity;
}

Deno.test("own roof bind refuses stale old pointer before reading source bytes", async () => {
  const fixture = bindClient();
  const hash = await rawSha256Bytes(BYTES);
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    fetchCalls++;
    return Promise.resolve(new Response(BYTES));
  };
  try {
    fixture.draft.report_doc_id = "different-current-document";
    const error = await assertRejects(
      () => _bindCurrentCycleOwnRoofReportForTest(
        fixture.client,
        body(hash, BYTES.byteLength),
        { id: "captain@example.test", auth_mode: "api_key" },
      ),
      ApiError,
    );
    assertEquals(error.body.code, "own_roof_report_bind_stale_pointer");
    assertEquals(fetchCalls, 0);
    assertEquals(fixture.mutations.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("own roof bind keeps partial-write audit when the independent pack CAS loses a race", async () => {
  const fixture = bindClient({ packCasFail: true });
  const hash = await rawSha256Bytes(BYTES);
  const error = await withSource(() =>
    assertRejects(
      () => _bindCurrentCycleOwnRoofReportForTest(
        fixture.client,
        body(hash, BYTES.byteLength),
        { id: "captain@example.test", auth_mode: "api_key" },
      ),
      ApiError,
    ));
  assertEquals(error.body.code, "own_roof_report_bind_pack_compare_and_swap_drift");
  assertEquals(fixture.document.version, 2);
  assertEquals(fixture.draft.report_doc_id, NEW_DOCUMENT_ID);
  assertEquals(fixture.pack.report_doc_id, OLD_DOCUMENT_ID);
  assert(fixture.mutations.some((item) => item.table === "job_events" && item.values.detail_json?.partial_failure === true));
  assertEquals(fixture.mutations.some((item) => item.values.deleted === true), false);
});

Deno.test("own roof bind rereads the current cycle after source recovery before any row write", async () => {
  const fixture = bindClient();
  const hash = await rawSha256Bytes(BYTES);
  const error = await withSource(
    () => assertRejects(
      () => _bindCurrentCycleOwnRoofReportForTest(
        fixture.client,
        body(hash, BYTES.byteLength),
        { id: "captain@example.test", auth_mode: "api_key" },
      ),
      ApiError,
    ),
    () => {
      fixture.detail.cycle_number = 2;
    },
  );
  assertEquals(error.body.code, "own_roof_report_bind_compare_and_swap_drift");
  assertEquals(fixture.document.version, 1);
  assertEquals(fixture.draft.report_doc_id, OLD_DOCUMENT_ID);
  assertEquals(
    fixture.mutations.filter((item) => item.table === "job_documents").length,
    0,
  );
  assertEquals(
    fixture.mutations.filter((item) => item.table === "makesafe_roof_report_drafts").length,
    0,
  );
});

Deno.test("own roof bind retains audit when document write response is lost after commit", async () => {
  const fixture = bindClient({ documentResponseError: true });
  const hash = await rawSha256Bytes(BYTES);
  const error = await withSource(() =>
    assertRejects(
      () => _bindCurrentCycleOwnRoofReportForTest(
        fixture.client,
        body(hash, BYTES.byteLength),
        { id: "captain@example.test", auth_mode: "api_key" },
      ),
      ApiError,
    ));
  assertEquals(error.body.code, "own_roof_report_bind_document_compare_and_swap_drift");
  assertEquals(fixture.document.version, 2);
  assertEquals(fixture.draft.report_doc_id, OLD_DOCUMENT_ID);
  const retained = fixture.mutations.filter((item) => item.table === "job_events").at(-1);
  assert(retained);
  assertEquals(retained.values.detail_json.partial_failure, true);
  assertEquals(retained.values.detail_json.writes_attempted.document, true);
  assertEquals(retained.values.detail_json.completed_writes.document, false);
  assertEquals(retained.values.detail_json.unknown_write_outcomes.document, true);
  assertEquals(retained.values.detail_json.prior_document_id, OLD_DOCUMENT_ID);
  assertEquals(fixture.mutations.some((item) => item.values.deleted === true), false);
});

Deno.test("own roof bind refuses a cycle change observed by the final completion read", async () => {
  const fixture = bindClient({
    afterPackWrite: () => {
      fixture.detail.cycle_number = 2;
    },
  });
  const hash = await rawSha256Bytes(BYTES);
  const error = await withSource(() =>
    assertRejects(
      () => _bindCurrentCycleOwnRoofReportForTest(
        fixture.client,
        body(hash, BYTES.byteLength),
        { id: "captain@example.test", auth_mode: "api_key" },
      ),
      ApiError,
    ));
  assertEquals(error.body.code, "own_roof_report_bind_final_read_drift");
  assertEquals(fixture.document.version, 2);
  assertEquals(fixture.draft.report_doc_id, NEW_DOCUMENT_ID);
  assertEquals(fixture.pack.report_doc_id, NEW_DOCUMENT_ID);
  const retained = fixture.mutations.filter((item) => item.table === "job_events").at(-1);
  assert(retained);
  assertEquals(retained.values.detail_json.partial_failure, true);
  assertEquals(retained.values.detail_json.completed_writes, {
    document: true,
    draft: true,
    pack: true,
  });
});
