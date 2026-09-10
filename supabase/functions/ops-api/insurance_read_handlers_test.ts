import {
  INSURANCE_READ_DEFAULT_ORG,
  insuranceReadAction,
  type InsuranceReadAuth,
  type InsuranceReadDeps,
  type InsuranceReadQuery,
} from "./insurance_read_handlers.ts";

const ORG = INSURANCE_READ_DEFAULT_ORG;
const OTHER_ORG = "00000000-0000-0000-0000-000000000002";
const JOB = "11111111-1111-4111-8111-111111111111";
const OTHER_JOB = "22222222-2222-4222-8222-222222222222";
const REPORT_1 = "11111111-1111-4111-8111-111111111112";
const REPORT_2 = "11111111-1111-4111-8111-111111111113";
const DOC = "33333333-3333-4333-8333-333333333333";
const ROOF_DRAFT = "44444444-4444-4444-8444-444444444444";
const ROOF_DOC = "55555555-5555-4555-8555-555555555555";
const PROJECT = "https://kevgrhcjxspbxgovpmfl.supabase.co";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      message + "\nexpected: " + JSON.stringify(expected) + "\nactual: " +
        JSON.stringify(actual),
    );
  }
}

type TableRows = Record<string, Record<string, unknown>[]>;

function fakeClient(
  tables: TableRows,
  options: {
    errors?: Record<string, unknown>;
    calls?: Array<Record<string, unknown>>;
  } = {},
) {
  const calls = options.calls || [];
  const client = {
    from(table: string): InsuranceReadQuery {
      const state: {
        columns: string;
        filters: Array<[string, unknown]>;
        greater: Array<[string, unknown]>;
        order?: [string, boolean];
        limit?: number;
      } = { columns: "", filters: [], greater: [] };
      const builder: InsuranceReadQuery = {
        select(columns: string) {
          state.columns = columns;
          return builder;
        },
        eq(column: string, value: unknown) {
          state.filters.push([column, value]);
          return builder;
        },
        gt(column: string, value: unknown) {
          state.greater.push([column, value]);
          return builder;
        },
        order(column: string, opts?: { ascending?: boolean }) {
          state.order = [column, opts?.ascending !== false];
          return builder;
        },
        limit(count: number) {
          state.limit = count;
          return builder;
        },
        then(resolve, reject) {
          calls.push({
            table,
            columns: state.columns,
            filters: state.filters,
            greater: state.greater,
            order: state.order,
            limit: state.limit,
          });
          try {
            const error = options.errors?.[table] || null;
            let rows = (tables[table] || []).map((row) => ({ ...row }));
            rows = rows.filter((row) =>
              state.filters.every(([column, value]) =>
                String(row[column] ?? "").toLowerCase() ===
                  String(value ?? "").toLowerCase()
              )
            );
            rows = rows.filter((row) =>
              state.greater.every(([column, value]) =>
                String(row[column] ?? "").toLowerCase() >
                  String(value ?? "").toLowerCase()
              )
            );
            if (state.order) {
              const [column, ascending] = state.order;
              rows.sort((left, right) =>
                (String(left[column] || "").localeCompare(
                  String(right[column] || ""),
                )) * (ascending ? 1 : -1)
              );
            }
            if (state.limit !== undefined) rows = rows.slice(0, state.limit);
            if (state.columns) {
              const columns = state.columns.split(",").map((column) =>
                column.trim()
              );
              rows = rows.map((row) =>
                Object.fromEntries(
                  columns.filter((column) => column in row).map((column) => [
                    column,
                    row[column],
                  ]),
                )
              );
            }
            return Promise.resolve({ data: error ? null : rows, error }).then(
              resolve,
              reject,
            );
          } catch (error) {
            return Promise.reject(error).then(resolve, reject);
          }
        },
      } as InsuranceReadQuery;
      return builder;
    },
  };
  return { client, calls };
}

function deps(
  tables: TableRows,
  options: {
    errors?: Record<string, unknown>;
    calls?: Array<Record<string, unknown>>;
    fetchImpl?: typeof fetch;
    documentFetchTimeoutMs?: number;
  } = {},
): InsuranceReadDeps {
  const f = fakeClient(tables, options);
  return {
    from: f.client.from,
    storageProjectUrl: PROJECT,
    storageBearerToken: "server-secret-fixture",
    fetchImpl: options.fetchImpl,
    documentFetchTimeoutMs: options.documentFetchTimeoutMs,
    now: () => new Date("2026-09-10T00:00:00.000Z"),
  };
}

const owner: InsuranceReadAuth = {
  mode: "jwt",
  role: "owner",
  orgId: ORG,
};

function jobRow(id = JOB, orgId = ORG) {
  return { id, org_id: orgId };
}

function reportRow(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    job_id: JOB,
    submitted_by: "66666666-6666-4666-8666-666666666666",
    checklist_json: { work_done: true, access_token: "hidden-report-token" },
    notes: "completed",
    status: "submitted",
    submitted_at: "2026-09-10T01:00:00Z",
    created_at: "2026-09-10T00:00:00Z",
    updated_at: "2026-09-10T01:00:00Z",
    start_time: "09:00",
    end_time: "11:00",
    cycle_number: 2,
    attendance_cycle_id: "77777777-7777-4777-8777-777777777777",
    cycle_attribution: "bound",
    makesafe_fact_version: 1,
    makesafe_content_hash: "hash",
    share_token: "must-not-be-selected",
    ...extra,
  };
}

function docRow(extra: Record<string, unknown> = {}) {
  return {
    id: DOC,
    job_id: JOB,
    type: "roof_report",
    version: 2,
    pdf_url: null,
    storage_url: "makesafe-deterministic/1002ddc7/report.pdf",
    file_name: "report.pdf",
    data_snapshot_json: {
      source: "stored",
      auth: { token: "redacted-snapshot-token" },
    },
    metadata: {
      source_message_id: "message-1",
      share_token: "omitted-from-projection",
    },
    trade_pack_json: { content: "kept-and-sanitized" },
    created_at: "2026-09-10T00:00:00Z",
    share_token: "must-not-be-selected",
    send_claim_token: "must-not-be-selected",
    send_resend_idempotency_key: "must-not-be-selected",
    ...extra,
  };
}

function baseTables(): TableRows {
  return {
    jobs: [jobRow()],
    job_service_reports: [],
    makesafe_roof_report_drafts: [],
    job_documents: [],
  };
}

Deno.test("auth refuses non-operator JWT and caller org override", async () => {
  const tables = baseTables();
  const denied = await insuranceReadAction(
    deps(tables),
    new URLSearchParams({
      action: "list_job_service_reports",
      job_id: JOB,
    }),
    "GET",
    { mode: "jwt", role: "lead_installer", orgId: ORG },
  );
  assertEqual(denied.status, 403, "non-operator JWT must be refused");
  const override = await insuranceReadAction(
    deps(tables),
    new URLSearchParams({
      action: "list_job_service_reports",
      job_id: JOB,
      org_id: OTHER_ORG,
    }),
    "GET",
    owner,
  );
  assertEqual(override.status, 400, "caller org override must be refused");
  const wrongOrg = await insuranceReadAction(
    deps(tables),
    new URLSearchParams({
      action: "list_job_service_reports",
      job_id: JOB,
    }),
    "GET",
    { mode: "jwt", role: "owner", orgId: OTHER_ORG },
  );
  assertEqual(wrongOrg.status, 404, "wrong JWT org must not see the job");
});

Deno.test("report list returns full checklist/notes/time/cycle fields and bounded cursor", async () => {
  const tables = baseTables();
  tables.job_service_reports = [reportRow(REPORT_1), reportRow(REPORT_2)];
  const first = await insuranceReadAction(
    deps(tables),
    new URLSearchParams({
      action: "list_job_service_reports",
      job_id: JOB,
      page_size: "1",
    }),
    "GET",
    owner,
  );
  assertEqual(first.status, 200, "first report page should succeed");
  const firstBody = first.body as {
    rows: Record<string, unknown>[];
    pagination: { has_more: boolean; next_cursor: string };
  };
  assertEqual(firstBody.rows.length, 1, "page size must be honoured");
  assertEqual(firstBody.pagination.has_more, true, "second row must paginate");
  assert(
    !("share_token" in firstBody.rows[0]),
    "share_token must not be selected",
  );
  assertEqual(firstBody.rows[0].cycle_number, 2, "cycle must be preserved");
  assertEqual(
    (firstBody.rows[0].checklist_json as Record<string, unknown>).work_done,
    true,
    "checklist must be preserved",
  );
  assert(
    JSON.stringify(firstBody).includes("credential_content_redacted"),
    "credential redaction provenance must be visible",
  );
  const cursor = firstBody.pagination.next_cursor;
  const second = await insuranceReadAction(
    deps(tables),
    new URLSearchParams({
      action: "list_job_service_reports",
      job_id: JOB,
      page_size: "1",
      cursor,
    }),
    "GET",
    owner,
  );
  assertEqual(second.status, 200, "cursor page should succeed");
  assertEqual(
    (second.body as { rows: Record<string, unknown>[] }).rows[0].id,
    REPORT_2,
    "cursor must use id keyset",
  );
  const reused = await insuranceReadAction(
    deps(tables),
    new URLSearchParams({
      action: "list_job_documents",
      job_id: JOB,
      cursor,
    }),
    "GET",
    owner,
  );
  assertEqual(reused.status, 400, "cursor must be bound to action");
});

Deno.test("roof report pointer is checked by exact document/job/type without foreign data", async () => {
  const tables = baseTables();
  tables.makesafe_roof_report_drafts = [{
    id: ROOF_DRAFT,
    org_id: ORG,
    job_id: JOB,
    fields_json: { roof: "tile" },
    template_version: 4,
    report_doc_id: ROOF_DOC,
    status: "draft",
  }];
  tables.job_documents = [{
    id: ROOF_DOC,
    job_id: JOB,
    type: "roof_report",
  }, {
    id: "66666666-6666-4666-8666-666666666667",
    job_id: OTHER_JOB,
    type: "roof_report",
  }];
  const result = await insuranceReadAction(
    deps(tables),
    new URLSearchParams({
      action: "list_job_roof_report_drafts",
      job_id: JOB,
    }),
    "GET",
    owner,
  );
  assertEqual(result.status, 200, "roof draft read should succeed");
  const row = (result.body as { rows: Record<string, unknown>[] }).rows[0];
  assertEqual(row.report_pointer_status, "verified", "pointer must verify");
  assert(
    !("data_snapshot_json" in row),
    "pointer validation must not return foreign document data",
  );
});

Deno.test("wrong job/document pair fails before storage bytes are fetched", async () => {
  const tables = baseTables();
  tables.jobs.push(jobRow(OTHER_JOB));
  tables.job_documents = [docRow()];
  let fetchCount = 0;
  const result = await insuranceReadAction(
    deps(tables, {
      fetchImpl: () => {
        fetchCount++;
        return Promise.resolve(
          new Response("%PDF-1.7\nwrong-pair", {
            headers: { "content-type": "application/pdf" },
          }),
        );
      },
    }),
    new URLSearchParams({
      action: "get_job_document",
      job_id: OTHER_JOB,
      document_id: DOC,
    }),
    "GET",
    owner,
  );
  assertEqual(result.status, 404, "wrong pair must be hidden");
  assertEqual(fetchCount, 0, "wrong pair must not fetch storage");
});

Deno.test("document bytes use canonical storage path, stream limit, hash, MIME, and sanitized metadata", async () => {
  const tables = baseTables();
  tables.job_documents = [docRow()];
  const source = new TextEncoder().encode("%PDF-1.7\noriginal-bytes");
  let seenUrl = "";
  let seenAuth = "";
  const result = await insuranceReadAction(
    deps(tables, {
      fetchImpl: (input, init) => {
        seenUrl = String(input);
        seenAuth = String(
          (init?.headers as Record<string, string>)?.Authorization,
        );
        return Promise.resolve(
          new Response(source, {
            headers: { "content-type": "application/pdf; charset=binary" },
          }),
        );
      },
    }),
    new URLSearchParams({
      action: "get_job_document",
      job_id: JOB,
      document_id: DOC,
    }),
    "GET",
    owner,
  );
  assertEqual(result.status, 200, "document bytes should succeed");
  assertEqual(
    seenUrl,
    PROJECT + "/storage/v1/object/authenticated/job-documents/" +
      "makesafe-deterministic/1002ddc7/report.pdf",
    "storage fetch must use configured bucket and path",
  );
  assertEqual(
    seenAuth,
    "Bearer server-secret-fixture",
    "server auth is injected",
  );
  const body = result.body as {
    document: Record<string, unknown>;
    content: Record<string, unknown>;
    provenance: Record<string, unknown>;
  };
  assertEqual(body.content.byte_size, source.byteLength, "size must be exact");
  assertEqual(
    body.content.mime_type,
    "application/pdf",
    "MIME must be detected",
  );
  assertEqual(
    body.content.sha256,
    "2c45114debd6cdcf743d0a1e6a67037c9b5f3c1071b8cfaa4b041ab7e0703b51",
    "SHA256 must cover returned original bytes",
  );
  assertEqual(body.content.original_bytes, true, "bytes must be original");
  assertEqual(body.content.transformed, false, "reader must not render");
  assert(
    !JSON.stringify(body).includes("redacted-snapshot-token"),
    "snapshot credentials must not escape",
  );
  assert(
    !("share_token" in body.document) &&
      !("send_claim_token" in body.document),
    "sensitive token fields must be omitted",
  );
  assert(
    Array.isArray(body.provenance.redacted_paths),
    "redaction paths must be visible",
  );
});

Deno.test("storage SSRF, traversal, ambiguity, MIME mismatch, and oversize errors are explicit", async () => {
  const failureCases = [
    {
      storage_url: "https://evil.example/object.pdf",
      code: "DOCUMENT_STORAGE_REFERENCE_INVALID",
    },
    {
      storage_url: "../private.pdf",
      code: "DOCUMENT_STORAGE_REFERENCE_INVALID",
    },
    {
      storage_url: "makesafe-deterministic/one.pdf",
      pdf_url: "makesafe-deterministic/two.pdf",
      code: "DOCUMENT_STORAGE_REFERENCE_AMBIGUOUS",
    },
  ];
  for (const override of failureCases) {
    let fetchCount = 0;
    const tables = baseTables();
    tables.job_documents = [docRow(override)];
    const result = await insuranceReadAction(
      deps(tables, {
        fetchImpl: () => {
          fetchCount++;
          return Promise.resolve(new Response("%PDF-1.7\nunexpected"));
        },
      }),
      new URLSearchParams({
        action: "get_job_document",
        job_id: JOB,
        document_id: DOC,
      }),
      "GET",
      owner,
    );
    assertEqual(result.status, 502, "unsafe storage ref must fail");
    assertEqual(
      (result.body as { code: string }).code,
      override.code,
      "unsafe storage error code must be explicit",
    );
    assertEqual(fetchCount, 0, "unsafe storage ref must not fetch");
  }
  const tables = baseTables();
  tables.job_documents = [docRow()];
  const oversize = await insuranceReadAction(
    deps(tables, {
      fetchImpl: () =>
        Promise.resolve(
          new Response(new Uint8Array(32).fill(0x41), {
            headers: { "content-type": "application/octet-stream" },
          }),
        ),
    }),
    new URLSearchParams({
      action: "get_job_document",
      job_id: JOB,
      document_id: DOC,
      max_bytes: "8",
    }),
    "GET",
    owner,
  );
  assertEqual(oversize.status, 413, "stream must stop at max_bytes");
  const mismatch = await insuranceReadAction(
    deps(tables, {
      fetchImpl: () =>
        Promise.resolve(
          new Response("not-a-pdf", {
            headers: { "content-type": "application/pdf" },
          }),
        ),
    }),
    new URLSearchParams({
      action: "get_job_document",
      job_id: JOB,
      document_id: DOC,
    }),
    "GET",
    owner,
  );
  assertEqual(mismatch.status, 502, "MIME mismatch must fail closed");
  assertEqual(
    (mismatch.body as { code: string }).code,
    "DOCUMENT_MIME_MISMATCH",
    "MIME mismatch error must be explicit",
  );
});

Deno.test("large list snapshot is refused instead of truncated", async () => {
  const tables = baseTables();
  tables.job_documents = [docRow({
    data_snapshot_json: { text: "x".repeat(4 * 1024 * 1024) },
  })];
  const result = await insuranceReadAction(
    deps(tables),
    new URLSearchParams({
      action: "list_job_documents",
      job_id: JOB,
    }),
    "GET",
    owner,
  );
  assertEqual(result.status, 413, "large JSON list must be refused");
  assertEqual(
    (result.body as { code: string }).code,
    "RESPONSE_TOO_LARGE",
    "large JSON error must be explicit",
  );
});

Deno.test("empty and failed child reads remain explicit", async () => {
  const empty = await insuranceReadAction(
    deps(baseTables()),
    new URLSearchParams({
      action: "list_job_documents",
      job_id: JOB,
    }),
    "GET",
    owner,
  );
  assertEqual(empty.status, 200, "an empty child collection is a valid read");
  assertEqual(
    (empty.body as { rows: unknown[] }).rows,
    [],
    "empty rows must stay empty",
  );
  const failed = await insuranceReadAction(
    deps(baseTables(), { errors: { job_documents: { message: "hidden" } } }),
    new URLSearchParams({
      action: "list_job_documents",
      job_id: JOB,
    }),
    "GET",
    owner,
  );
  assertEqual(failed.status, 502, "child read errors must be visible");
  assertEqual(
    (failed.body as { code: string }).code,
    "READ_FAILED",
    "child read error must be generic",
  );
});

Deno.test("document response status, encoding, length and redirect checks are strict", async () => {
  const cases = [
    {
      response: () => new Response(null, { status: 204 }),
      code: "DOCUMENT_FETCH_FAILED",
    },
    {
      response: () =>
        new Response("%PDF-1.7\nok", {
          headers: {
            "content-type": "application/pdf",
            "content-encoding": "gzip",
          },
        }),
      code: "DOCUMENT_ENCODING_UNSUPPORTED",
    },
    {
      response: () =>
        new Response("%PDF-1.7\nok", {
          headers: {
            "content-type": "application/pdf",
            "content-length": "99999999",
          },
        }),
      code: "DOCUMENT_TOO_LARGE",
    },
    {
      response: () =>
        new Response("%PDF-1.7\nok", {
          headers: {
            "content-type": "application/pdf",
            "content-length": "99",
          },
        }),
      code: "DOCUMENT_LENGTH_MISMATCH",
    },
    {
      response: () =>
        new Response(new Uint8Array(0), {
          headers: { "content-type": "application/pdf" },
        }),
      code: "DOCUMENT_BYTES_EMPTY",
    },
  ];
  for (const testCase of cases) {
    const tables = baseTables();
    tables.job_documents = [docRow()];
    const result = await insuranceReadAction(
      deps(tables, {
        fetchImpl: () => Promise.resolve(testCase.response()),
      }),
      new URLSearchParams({
        action: "get_job_document",
        job_id: JOB,
        document_id: DOC,
        max_bytes: testCase.code === "DOCUMENT_TOO_LARGE" ? "8" : "1000",
      }),
      "GET",
      owner,
    );
    assert(
      result.status === 413 || result.status === 502,
      "strict response checks must fail",
    );
    assertEqual(
      (result.body as { code: string }).code,
      testCase.code,
      "strict response error must identify the failed check",
    );
  }
  const tables = baseTables();
  tables.job_documents = [docRow()];
  const foreignUrl = new Response("%PDF-1.7\nok", {
    headers: { "content-type": "application/pdf" },
  });
  Object.defineProperty(foreignUrl, "url", {
    value: "https://foreign.example/object.pdf",
  });
  const result = await insuranceReadAction(
    deps(tables, { fetchImpl: () => Promise.resolve(foreignUrl) }),
    new URLSearchParams({
      action: "get_job_document",
      job_id: JOB,
      document_id: DOC,
    }),
    "GET",
    owner,
  );
  assertEqual(
    (result.body as { code: string }).code,
    "DOCUMENT_FETCH_FAILED",
    "foreign response URL must be rejected",
  );
});

Deno.test("double encoded traversal and query delimiters are rejected before fetch", async () => {
  const references = [
    "makesafe-deterministic/a/%252e%252e/secret.pdf",
    "makesafe-deterministic/a/%2525252e%2525252e/secret.pdf",
    "makesafe-deterministic/report.pdf%253Ftoken%253Dabc",
    "makesafe-deterministic/report.pdf%2525253Ftoken%2525253Dabc",
    PROJECT + "/storage/v1/object/public/job-documents/a/../secret.pdf",
    PROJECT + "/storage/v1/object/public/job-documents/a/%252e%252e/secret.pdf",
  ];
  for (const reference of references) {
    const tables = baseTables();
    tables.job_documents = [docRow({ storage_url: reference, pdf_url: null })];
    let fetchCount = 0;
    const result = await insuranceReadAction(
      deps(tables, {
        fetchImpl: () => {
          fetchCount++;
          return Promise.resolve(new Response("%PDF-1.7\nunexpected"));
        },
      }),
      new URLSearchParams({
        action: "get_job_document",
        job_id: JOB,
        document_id: DOC,
      }),
      "GET",
      owner,
    );
    assertEqual(
      (result.body as { code: string }).code,
      "DOCUMENT_STORAGE_REFERENCE_INVALID",
      "encoded unsafe reference must fail closed",
    );
    assertEqual(fetchCount, 0, "unsafe reference must not fetch");
  }
});

Deno.test("slow body is deadline bounded and cancellation is fire-and-forget", async () => {
  const tables = baseTables();
  tables.job_documents = [docRow()];
  let cancelCalled = false;
  const result = await insuranceReadAction(
    deps(tables, {
      documentFetchTimeoutMs: 10,
      fetchImpl: () =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              pull: () => new Promise<void>(() => {}),
              cancel: () => {
                cancelCalled = true;
              },
            }),
            { headers: { "content-type": "application/pdf" } },
          ),
        ),
    }),
    new URLSearchParams({
      action: "get_job_document",
      job_id: JOB,
      document_id: DOC,
    }),
    "GET",
    { ...owner },
  );
  assertEqual(result.status, 504, "slow body must time out");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assertEqual(cancelCalled, true, "slow body reader must be cancelled");
});

Deno.test("document byte reads require the injected server storage credential", async () => {
  const tables = baseTables();
  tables.job_documents = [docRow()];
  let fetchCount = 0;
  const missingCredential = deps(tables, {
    fetchImpl: () => {
      fetchCount++;
      return Promise.resolve(new Response("%PDF-1.7\nunexpected"));
    },
  });
  missingCredential.storageBearerToken = undefined;
  const result = await insuranceReadAction(
    missingCredential,
    new URLSearchParams({
      action: "get_job_document",
      job_id: JOB,
      document_id: DOC,
    }),
    "GET",
    owner,
  );
  assertEqual(result.status, 503, "missing storage credential must fail");
  assertEqual(
    (result.body as { code: string }).code,
    "DOCUMENT_STORAGE_AUTH_UNAVAILABLE",
    "missing credential failure must be explicit",
  );
  assertEqual(fetchCount, 0, "missing credential must not trigger fetch");
});

Deno.test("credential-shaped storage paths are redacted in returned metadata", async () => {
  const tables = baseTables();
  tables.job_documents = [docRow({
    storage_url: "makesafe-deterministic/share/path-secret/report.pdf",
    pdf_url: null,
  })];
  let privateFetchUrl = "";
  const result = await insuranceReadAction(
    deps(tables, {
      fetchImpl: (input) => {
        privateFetchUrl = String(input);
        return Promise.resolve(
          new Response("%PDF-1.7\nredacted-path", {
            headers: { "content-type": "application/pdf" },
          }),
        );
      },
    }),
    new URLSearchParams({
      action: "get_job_document",
      job_id: JOB,
      document_id: DOC,
    }),
    "GET",
    owner,
  );
  assertEqual(result.status, 200, "private fetch may use the stored path");
  assert(
    privateFetchUrl.includes("path-secret"),
    "the server may use the raw path privately",
  );
  assert(
    !JSON.stringify(result.body).includes("path-secret"),
    "returned metadata must not reintroduce a credential path",
  );
  assert(
    JSON.stringify(result.body).includes("credential_content_redacted"),
    "path redaction must be recorded",
  );
});
