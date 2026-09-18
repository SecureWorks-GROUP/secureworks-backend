// deno-lint-ignore-file no-import-prefix no-explicit-any
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _assembleJobDossierActionForTest,
  _getJobContextFactsForTest,
  _jobDetailActionForTest,
} from "./index.ts";

const ORG_A = "00000000-0000-0000-0000-00000000000a";
const ORG_B = "00000000-0000-0000-0000-00000000000b";
const JOB_A = "10000000-0000-4000-8000-00000000000a";

type Tables = Record<string, any[]>;

function makeClient(tables: Tables, calls: any[] = []) {
  function builder(table: string) {
    const predicates: Array<(row: any) => boolean> = [];
    const filters: any[] = [];
    let limitN: number | null = null;
    const run = () => {
      calls.push({ table, filters: [...filters] });
      let rows = (tables[table] || []).filter((row) =>
        predicates.every((predicate) => predicate(row))
      );
      if (limitN != null) rows = rows.slice(0, limitN);
      return { data: rows, error: null, count: rows.length };
    };
    const api: any = {
      select() {
        return api;
      },
      order() {
        return api;
      },
      limit(n: number) {
        limitN = n;
        return api;
      },
      eq(column: string, value: unknown) {
        filters.push(["eq", column, value]);
        predicates.push((row) => String(row?.[column] ?? "") === String(value));
        return api;
      },
      neq(column: string, value: unknown) {
        filters.push(["neq", column, value]);
        predicates.push((row) => String(row?.[column] ?? "") !== String(value));
        return api;
      },
      ilike(column: string, value: string) {
        filters.push(["ilike", column, value]);
        const needle = String(value).replaceAll("%", "").toLowerCase();
        predicates.push((row) =>
          String(row?.[column] ?? "").toLowerCase().includes(needle)
        );
        return api;
      },
      in(column: string, values: unknown[]) {
        filters.push(["in", column, values]);
        predicates.push((row) =>
          values.map(String).includes(String(row?.[column] ?? ""))
        );
        return api;
      },
      is(column: string, value: unknown) {
        filters.push(["is", column, value]);
        predicates.push((row) => (row?.[column] ?? null) === value);
        return api;
      },
      gte(column: string, value: unknown) {
        filters.push(["gte", column, value]);
        return api;
      },
      gt(column: string, value: unknown) {
        filters.push(["gt", column, value]);
        return api;
      },
      single() {
        const result = run();
        return Promise.resolve({ ...result, data: result.data[0] ?? null });
      },
      maybeSingle() {
        const result = run();
        return Promise.resolve({ ...result, data: result.data[0] ?? null });
      },
      insert(row: any) {
        (tables[table] ||= []).push({ ...row });
        return Promise.resolve({ data: row, error: null });
      },
      then(resolve: any, reject: any) {
        return Promise.resolve(run()).then(resolve, reject);
      },
    };
    return api;
  }
  return { from: builder };
}

function seed(): Tables {
  return {
    jobs: [{
      id: JOB_A,
      org_id: ORG_A,
      status: "accepted",
      job_number: "SWF-261000",
      client_name: null,
      pricing_json: {},
      scope_json: {},
      metadata: {},
    }],
    job_assignments: [],
    job_documents: [],
    job_events: [],
    job_media: [],
    purchase_orders: [],
    work_orders: [],
    xero_projects: [],
    job_contacts: [],
    business_events: [{
      id: "event-dispatch",
      event_type: "dispatch.reviewed",
      source: "dispatch/workbench",
      entity_type: "dispatch_plan",
      entity_id: JOB_A,
      job_id: JOB_A,
      payload: {
        draft_body: "Send supplier commitment to protected recipient",
        recipients: ["supplier@example.invalid"],
        attachment_urls: ["https://storage.example.invalid/protected.pdf"],
      },
      metadata: { provenance: { derivation: { owner: "dispatch" } } },
      occurred_at: "2026-09-12T12:00:00Z",
    }],
    job_service_reports: [],
    xero_invoices: [],
    ai_annotations: [],
    makesafe_job_details: [],
  };
}

Deno.test("job_detail refuses a foreign-tenant JWT before reading business events", async () => {
  const calls: any[] = [];
  const response = await _jobDetailActionForTest(
    makeClient(seed(), calls),
    new URLSearchParams({ job_id: JOB_A }),
    "GET",
    "jwt",
    { orgId: ORG_B },
  );

  assertEquals(response.status, 404);
  assertEquals((await response.json()).code, "job_not_found");
  assertEquals(calls.map((call) => call.table), ["jobs"]);
  assertEquals(calls[0].filters, [
    ["eq", "id", JOB_A],
    ["eq", "org_id", ORG_B],
  ]);
});

Deno.test("job_detail refuses a JWT with no profile organisation before data reads", async () => {
  const calls: any[] = [];
  const response = await _jobDetailActionForTest(
    makeClient(seed(), calls),
    new URLSearchParams({ job_id: JOB_A }),
    "GET",
    "jwt",
    { orgId: "" },
  );

  assertEquals(response.status, 403);
  assertEquals(await response.json(), {
    error: "An authorised operator session is required.",
  });
  assertEquals(calls, []);
});

Deno.test("job_detail job-number lookup stays tenant scoped", async () => {
  const calls: any[] = [];
  const response = await _jobDetailActionForTest(
    makeClient(seed(), calls),
    new URLSearchParams({ jobId: "SWF-261000" }),
    "GET",
    "jwt",
    { orgId: ORG_B },
  );

  assertEquals(response.status, 404);
  assertEquals(calls.map((call) => call.table), ["jobs", "jobs"]);
  assertEquals(
    calls.every((call) =>
      call.filters.some((filter: any[]) =>
        filter[0] === "eq" && filter[1] === "org_id" && filter[2] === ORG_B
      )
    ),
    true,
  );
});

Deno.test("job_detail returns dispatch business events for the owning tenant", async () => {
  const calls: any[] = [];
  const response = await _jobDetailActionForTest(
    makeClient(seed(), calls),
    new URLSearchParams({ job_id: JOB_A }),
    "GET",
    "jwt",
    { orgId: ORG_A },
  );

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.job.id, JOB_A);
  assertEquals(body.business_events.length, 1);
  assertEquals(
    body.business_events[0].payload.draft_body,
    "Send supplier commitment to protected recipient",
  );
  assertEquals(calls[0].table, "jobs");
  assertEquals(
    calls.some((call) =>
      call.table === "business_events" &&
      call.filters.some((filter: any[]) =>
        filter[0] === "eq" && filter[1] === "job_id" && filter[2] === JOB_A
      )
    ),
    true,
  );
});

Deno.test("dossier and brain shared handler refuses foreign IDs and numbers before event reads", async () => {
  for (
    const body of [{ job_id: JOB_A }, { job_number: "SWF-261000" }, {
      job_id: JOB_A,
      org_id: ORG_A,
    }]
  ) {
    const calls: any[] = [];
    const response = await _assembleJobDossierActionForTest(
      makeClient(seed(), calls),
      body,
      "jwt",
      { orgId: ORG_B },
    );
    assertEquals(response.status, 404);
    assertEquals(calls.map((call) => call.table), ["jobs"]);
  }
});
Deno.test("dossier shared handler retains owning JWT and privileged service access", async () => {
  for (const mode of ["jwt", "api_key"] as const) {
    const response = await _assembleJobDossierActionForTest(
      makeClient(seed()),
      { job_id: JOB_A },
      mode,
      mode === "jwt" ? { orgId: ORG_A } : null,
    );
    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body.job.id, JOB_A);
    assertEquals(
      body.events[0].payload.draft_body,
      "Send supplier commitment to protected recipient",
    );
  }
});
Deno.test("shared context cannot return another tenant's projected Dispatch state", async () => {
  const data = seed();
  data.current_job_context_facts = [{
    id: "projection",
    job_id: JOB_A,
    kind: "note",
    value: { state: "private" },
  }];
  const calls: any[] = [];
  const result = await _getJobContextFactsForTest(makeClient(data, calls), {
    job_uuids: [JOB_A],
  }, { access: { orgId: ORG_B } });
  assertEquals(result.rows, []);
  assertEquals(calls.map((call) => call.table), ["jobs"]);
  const own = await _getJobContextFactsForTest(makeClient(data), {
    job_uuids: [JOB_A],
  }, { access: { orgId: ORG_A } });
  assertEquals(own.rows[0].value.state, "private");
});
