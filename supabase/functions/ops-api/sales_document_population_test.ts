import {
  INSURANCE_READ_DEFAULT_ORG,
  insuranceReadAction,
  type InsuranceReadDeps,
} from "./insurance_read_handlers.ts";
const ORG = INSURANCE_READ_DEFAULT_ORG,
  OTHER = "00000000-0000-0000-0000-000000000002";
const from = "2026-09-06T16:00:00.000Z", to = "2026-09-13T16:00:00.000Z";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const assert = (value: unknown, message: string) => {
  if (!value) throw new Error(message);
};
type FixtureRow = Record<string, unknown> & {
  id: string;
  jobs?: Record<string, unknown>;
};
type FixtureResult = {
  data: FixtureRow[] | null;
  error: { message: string } | null;
};
interface FixtureQuery {
  select(columns: string): FixtureQuery;
  eq(key: string, val: unknown): FixtureQuery;
  gte(key: string, val: string): FixtureQuery;
  lt(key: string, val: string): FixtureQuery;
  gt(key: string, val: string): FixtureQuery;
  order(): FixtureQuery;
  limit(n: number): FixtureQuery;
  then(resolve: (result: FixtureResult) => unknown): Promise<unknown>;
}
function fixture() {
  const jobs = [
    {
      id: id(900),
      org_id: ORG,
      job_number: "FIXTURE-FENCE",
      type: "fencing",
      pricing_total_inc_gst: 1234.56,
    },
    { id: id(901), org_id: OTHER, job_number: "OTHER", type: "fencing" },
    { id: id(902), org_id: ORG, job_number: "PATIO", type: "patio" },
  ];
  const documents = Array.from(
    { length: 237 },
    (_, i) => ({
      id: id(i + 1),
      job_id: id(900),
      type: "quote",
      sent_at: i === 0 ? from : "2026-09-10T00:00:00.000Z",
      snapshot_total_inc_gst: i === 1 ? 0 : null,
    }),
  );
  documents.push({
    id: id(300),
    job_id: id(901),
    type: "quote",
    sent_at: from,
    snapshot_total_inc_gst: null,
  }, {
    id: id(301),
    job_id: id(902),
    type: "quote",
    sent_at: from,
    snapshot_total_inc_gst: null,
  }, {
    id: id(302),
    job_id: id(900),
    type: "quote",
    sent_at: to,
    snapshot_total_inc_gst: null,
  }, {
    id: id(303),
    job_id: id(900),
    type: "invoice",
    sent_at: from,
    snapshot_total_inc_gst: null,
  });
  let failure = false;
  const calls: Array<{ table: string; columns: string; limit: number }> = [];
  const deps = {
    defaultOrgId: ORG,
    storageProjectUrl: "https://fixture.invalid",
    from(table: string) {
      const state = {
        filters: [] as Array<(r: FixtureRow) => boolean>,
        columns: "",
        limit: 1000,
      };
      const q: FixtureQuery = {
        select(columns: string) {
          state.columns = columns;
          return q;
        },
        eq(key: string, val: unknown) {
          state.filters.push((r) =>
            key.startsWith("jobs.")
              ? r.jobs?.[key.slice(5)] === val
              : r[key] === val
          );
          return q;
        },
        gte(key: string, val: string) {
          state.filters.push((r) => (r[key] as string) >= val);
          return q;
        },
        lt(key: string, val: string) {
          state.filters.push((r) => (r[key] as string) < val);
          return q;
        },
        gt(key: string, val: string) {
          state.filters.push((r) => (r[key] as string) > val);
          return q;
        },
        order() {
          return q;
        },
        limit(n: number) {
          state.limit = n;
          return q;
        },
        then(resolve: (result: FixtureResult) => unknown) {
          calls.push({ table, ...state });
          const source = table === "jobs" ? jobs : documents.map((d) => ({
            ...d,
            jobs: jobs.find((j) => j.id === d.job_id),
          }));
          const data = source.filter((r) => state.filters.every((f) => f(r)))
            .sort((a, b) => a.id.localeCompare(b.id)).slice(0, state.limit);
          return Promise.resolve({
            data: failure ? null : data,
            error: failure ? { message: "offline" } : null,
          }).then(resolve);
        },
      };
      return q;
    },
  } as unknown as InsuranceReadDeps;
  return {
    deps,
    calls,
    fail: () => {
      failure = true;
    },
  };
}
function params(extra: Record<string, string> = {}) {
  return new URLSearchParams({
    action: "list_job_documents",
    scope: "all_jobs",
    type: "quote",
    job_type: "fencing",
    sent_at_from: from,
    sent_at_to: to,
    page_size: "100",
    ...extra,
  });
}
const auth = { mode: "api_key" as const, serverSecretPresented: true };
Deno.test("all 237 quotes traverse deterministic pages with scoped joins and half-open Perth week", async () => {
  const f = fixture();
  let cursor = "";
  const seen: string[] = [];
  let pages = 0;
  do {
    const result = await insuranceReadAction(
      f.deps,
      params(cursor ? { cursor } : {}),
      "GET",
      auth,
    );
    assert(result.status === 200, JSON.stringify(result.body));
    const rows = result.body.rows as Array<{
      id: string;
      snapshot_total_inc_gst: number | null;
    }>;
    seen.push(...rows.map((r) => r.id));
    const page = result.body.pagination as { next_cursor: string | null };
    cursor = page.next_cursor || "";
    pages++;
    assert(result.body.job_id === null, "not an exact-job population");
    assert(
      rows.every((r) =>
        r.snapshot_total_inc_gst === (r.id === id(2) ? 0 : null)
      ),
      "missing value was zero-filled",
    );
  } while (cursor);
  assert(
    pages === 3 && seen.length === 237 && new Set(seen).size === 237,
    "full population not traversed",
  );
  assert(seen.includes(id(1)) && !seen.includes(id(302)), "boundary mismatch");
  assert(
    f.calls.every((c) => !c.columns.split(",").includes("scope_json")),
    "bulk scope requested",
  );
});
Deno.test("cursor is bound to org and exact filters", async () => {
  const f = fixture();
  const first = await insuranceReadAction(f.deps, params(), "GET", auth);
  const cursor = (first.body.pagination as { next_cursor: string }).next_cursor;
  const changed = await insuranceReadAction(
    f.deps,
    params({ cursor, job_type: "patio" }),
    "GET",
    auth,
  );
  assert(changed.status === 400, "filter-swapped cursor accepted");
  const other = await insuranceReadAction(f.deps, params({ cursor }), "GET", {
    mode: "jwt",
    role: "ops_manager",
    orgId: OTHER,
  });
  assert(other.status === 400, "tenant-swapped cursor accepted");
});
Deno.test("public keys and trades cannot read all jobs; exact-job route keeps requiring job_id", async () => {
  const f = fixture();
  for (
    const denied of [
      { mode: "api_key" as const, serverSecretPresented: false },
      { mode: "jwt" as const, role: "trade", orgId: ORG },
    ]
  ) {
    assert(
      (await insuranceReadAction(f.deps, params(), "GET", denied)).status ===
        403,
      "unauthorized population",
    );
  }
  assert(
    (await insuranceReadAction(
      f.deps,
      new URLSearchParams({ action: "list_job_documents" }),
      "GET",
      auth,
    )).status === 400,
    "exact-job selector weakened",
  );
  assert(
    (await insuranceReadAction(
      f.deps,
      params({ job_id: id(900) }),
      "GET",
      auth,
    )).status === 400,
    "mixed scope accepted",
  );
});
Deno.test("failed or malformed reads are unknown, never zero population", async () => {
  const f = fixture();
  f.fail();
  const result = await insuranceReadAction(f.deps, params(), "GET", auth);
  assert(result.status === 502, "failed source returned success");
  assert(!("rows" in result.body), "failure became empty rows");
  for (
    const invalid of ([{ sent_at_to: from }, { sent_at_from: "2026-09-07" }, {
      sent_at_from: "2026-02-31T00:00:00Z",
    }, {
      org_id: OTHER,
    }] as Record<string, string>[])
  ) {
    assert(
      (await insuranceReadAction(f.deps, params(invalid), "GET", auth))
        .status === 400,
      "invalid filter admitted",
    );
  }
});
