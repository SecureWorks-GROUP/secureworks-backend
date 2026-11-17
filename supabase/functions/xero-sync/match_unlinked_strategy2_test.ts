import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import * as sync from "./index.ts";

type Row = Record<string, any>;
type Call = { table: string; mode: string; filters: [string, string, any][]; columns?: string; row?: Row };
const ORG = "00000000-0000-0000-0000-000000000001";
const NOW = new Date("2026-11-17T06:00:00Z");
const invoice = (id = "invoice-1", extra: Row = {}) => ({
  id, xero_invoice_id: id, invoice_number: id, invoice_type: "ACCREC",
  status: "AUTHORISED", job_id: null, contact_name: "customer_role", ...extra,
});
const job = (id = "job-1", extra: Row = {}) => ({
  id, job_number: "SWF-260001", client_name: "customer_role", type: "fencing",
  status: "accepted", legacy: false, org_id: ORG, created_at: "2026-11-01T00:00:00Z", ...extra,
});

function makeClient(opts: {
  unlinked?: Row[]; jobs?: Row[]; annotations?: Row[]; jobsError?: boolean;
  annotationsError?: boolean; capture?: boolean; linkWrite?: "lost" | "error";
  enabled?: boolean; cursor?: string; builderRows?: Row[];
} = {}) {
  const calls: Call[] = [];
  const invoices = structuredClone(opts.unlinked ?? []);
  const annotations = structuredClone(opts.annotations ?? []);
  const events: Row[] = [];
  let cursor = opts.cursor;
  function query(table: string) {
    const call: Call = { table, mode: "select", filters: [] };
    let range: [number, number] | undefined;
    let limit = Infinity;
    let ordering: [string, boolean] | undefined;
    const b: any = {
      select(columns: string) { call.columns = columns; return b; },
      update(row: Row) { call.mode = "update"; call.row = row; return b; },
      insert(row: Row) { call.mode = "insert"; call.row = row; return b; },
      upsert(row: Row) { call.mode = "upsert"; call.row = row; return b; },
      order(key: string, options?: Row) { ordering = [key, options?.ascending !== false]; return b; },
      limit(n: number) { limit = n; return b; },
      range(start: number, end: number) { range = [start, end]; return b; },
      maybeSingle() { return execute(true); },
      then(resolve: any, reject: any) { return execute(false).then(resolve, reject); },
    };
    for (const op of ["eq", "is", "not", "like", "ilike"]) {
      b[op] = (key: string, value: any, third?: any) => {
        call.filters.push([op, key, op === "not" ? third : value]); return b;
      };
    }
    function matches(row: Row) {
      return call.filters.every(([op, key, value]) => {
        if (op === "eq" || op === "is") return (row[key] ?? null) === value;
        if (op === "not") return !String(value).replace(/[()\"]/g, "").split(",").includes(row[key]);
        const pattern = String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".");
        return new RegExp(`^${pattern}$`, op === "ilike" ? "i" : "").test(String(row[key] ?? ""));
      });
    }
    async function execute(single: boolean) {
      calls.push(call);
      if (table === "feature_flags") return { data: single ? { enabled: opts.enabled === true } : [{ enabled: opts.enabled === true }], error: null };
      if (table === "xero_sync_state") {
        if (call.mode === "upsert") cursor = call.row?.cursor_at;
        return { data: cursor ? { cursor_at: cursor } : null, error: null };
      }
      if ((table === "jobs" && opts.jobsError) || (table === "ai_annotations" && opts.annotationsError)) {
        return { data: null, error: { code: "42703", message: "read failed" } };
      }
      const rows = table === "jobs" ? (opts.jobs ?? []) : table === "xero_invoices" ? invoices : table === "ai_annotations" ? annotations : events;
      if (call.mode === "insert") { rows.push(table === "ai_annotations" ? { status: "active", ...call.row } : call.row!); return { data: null, error: null }; }
      let selected = rows.filter(matches);
      if (call.mode === "update") {
        if (table === "xero_invoices" && opts.linkWrite) return { data: [], error: opts.linkWrite === "error" ? { message: "write failed" } : null };
        selected.forEach((row) => Object.assign(row, call.row));
        return { data: call.columns ? selected.map((row) => ({ id: row.id })) : null, error: null };
      }
      if (ordering) { const [key, asc] = ordering; selected = [...selected].sort((a, z) => String(a[key]).localeCompare(String(z[key])) * (asc ? 1 : -1)); }
      if (range) selected = selected.slice(range[0], range[1] + 1);
      selected = selected.slice(0, limit);
      return { data: single ? selected.length === 1 ? selected[0] : null : selected, error: null };
    }
    return b;
  }
  return {
    client: { from: query, rpc: (fn: string) => Promise.resolve({ data: fn === "xero_builder_reference_candidates" ? opts.builderRows ?? [] : opts.capture ?? false, error: null }) },
    calls, invoices, annotations, events,
  };
}

Deno.test("250 unlinked invoices use one jobs page and one annotations page, with no single lookups", async () => {
  const f = makeClient({ unlinked: Array.from({ length: 250 }, (_, i) => invoice(String(i), { invoice_type: i < 150 ? "ACCREC" : "ACCPAY" })) });
  const result = await sync.matchUnlinkedInvoices(f.client);
  assertEquals(result.matched, 0);
  assertEquals(result.flagged, 0);
  assertEquals(f.calls.filter((c) => c.table === "jobs" && c.mode === "select").length, 1);
  assertEquals(f.calls.filter((c) => c.table === "ai_annotations" && c.mode === "select").length, 1);
  assertEquals(f.calls.filter((c) => ["jobs", "ai_annotations"].includes(c.table) && c.mode === "select" && c.filters.some(([op]) => op === "eq" || op === "ilike")).length, 0);
});

Deno.test("reference links exactly one job, preserves money and records its evidence", async () => {
  const f = makeClient({ unlinked: [invoice(undefined, { reference: "SWF-260001", contact_name: null })], jobs: [job()], capture: true });
  assertEquals((await sync.matchUnlinkedInvoices(f.client)).matched, 1);
  assertEquals(f.invoices[0].job_id, "job-1");
  const writes = f.calls.filter((c) => c.table === "xero_invoices" && c.mode === "update");
  assertEquals(Object.keys(writes[0].row!).sort(), ["job_id", "updated_at"]);
  assert(writes[0].filters.some(([op, key, value]) => op === "is" && key === "job_id" && value === null));
  assertEquals(f.events[0].payload.method, "reference_match");
});

Deno.test("duplicate job numbers never select a reference winner", async () => {
  const f = makeClient({ unlinked: [invoice(undefined, { reference: "SWF-260001", contact_name: null })], jobs: [job(), job("job-2")] });
  assertEquals((await sync.matchUnlinkedInvoices(f.client)).matched, 0);
  assertEquals(f.invoices[0].job_id, null);
});

Deno.test("one live exact name links, excluding draft, legacy, cancelled, lost and other organisation jobs", async () => {
  const f = makeClient({ unlinked: [invoice()], jobs: [job(), job("draft", { status: "draft" }), job("legacy", { legacy: true }), job("cancelled", { status: "cancelled" }), job("lost", { status: "lost" }), job("other", { org_id: "other-org" })] });
  assertEquals((await sync.matchUnlinkedInvoices(f.client)).matched, 1);
  assertEquals(f.invoices[0].job_id, "job-1");
  assertEquals(f.events.length, 0);
});

Deno.test("two name candidates flag once across runs and never link", async () => {
  const f = makeClient({ unlinked: [invoice()], jobs: [job(), job("job-2", { job_number: "SWF-260002" })] });
  assertEquals((await sync.matchUnlinkedInvoices(f.client)).flagged, 1);
  assertEquals((await sync.matchUnlinkedInvoices(f.client)).flagged, 1);
  assertEquals(f.annotations.length, 1);
  assertEquals(f.invoices[0].job_id, null);
});

for (const failure of ["jobsError", "annotationsError"] as const) {
  Deno.test(`${failure} refuses every link, including an explicit reference`, async () => {
    const f = makeClient({ unlinked: [invoice(undefined, { reference: "SWF-260001" })], jobs: [job()], [failure]: true });
    const result = await sync.matchUnlinkedInvoices(f.client);
    assertEquals(result.matched, 0);
    assert(result.error);
    assertEquals(f.invoices[0].job_id, null);
    assertEquals(f.events.length, 0);
  });
}

Deno.test("percent and underscore in a contact name match literal characters only", async () => {
  const f = makeClient({ unlinked: [invoice(undefined, { contact_name: "customer%_role" })], jobs: [job("literal", { client_name: "customer%_role" }), job("wildcard", { client_name: "customerXXrole" })] });
  assertEquals((await sync.matchUnlinkedInvoices(f.client)).matched, 1);
  assertEquals(f.invoices[0].job_id, "literal");
});

Deno.test("lost or failed guarded writes count nothing and record no evidence", async () => {
  for (const linkWrite of ["lost", "error"] as const) {
    const f = makeClient({ unlinked: [invoice()], jobs: [job()], capture: true, linkWrite });
    assertEquals((await sync.matchUnlinkedInvoices(f.client)).matched, 0);
    assertEquals(f.invoices[0].job_id, null);
    assertEquals(f.events.length, 0);
  }
});

Deno.test("INT-14: only invoices with no job are candidates for a link", async () => {
  const f = makeClient({ unlinked: [] });
  await sync.matchUnlinkedInvoices(f.client);
  const reads = f.calls.filter((c) => c.table === "xero_invoices" && c.mode === "select");
  assert(reads.length >= 1);
  for (const read of reads) {
    assert(
      read.filters.some(([op, key, value]) => op === "is" && key === "job_id" && value === null),
      "candidate read must be job_id is null",
    );
  }
});

Deno.test("INT-14: every automatic invoice→job link write is guarded by job_id is null", async () => {
  const files = ["./index.ts", "../reporting-api/index.ts"];
  for (const file of files) {
    const source = await Deno.readTextFile(new URL(file, import.meta.url));
    const pattern = /\.update\(\{ job_id: [^}]*\}\)([\s\S]{0,160})/g;
    let count = 0;
    for (const match of source.matchAll(pattern)) {
      count++;
      assert(
        match[1].includes(".is('job_id', null)"),
        `${file}: unguarded job link write near: ${match[0].slice(0, 120)}`,
      );
    }
    assert(count > 0, `${file}: expected job link writes`);
  }
});

Deno.test("explicit SES invoice binding still refuses reference auto-link", async () => {
  const f = makeClient({ unlinked: [invoice(undefined, { reference: "SWF-260001", invoice_obligation_revision_id: "bound-revision" })], jobs: [job()] });
  assertEquals((await sync.matchUnlinkedInvoices(f.client)).refused, 1);
  assertEquals(f.invoices[0].job_id, null);
});

Deno.test("bills stay outside the SES sales-invoice binding fence", async () => {
  assertEquals(await sync.sealedSesXeroLinkRefusal({}, { invoice_type: "ACCPAY", invoice_obligation_revision_id: "bound-revision" }, job(), "test"), null);
});

Deno.test("on-change gate skips unchanged recent runs, and runs for changes, missing state or an expired hour", async () => {
  const run = (sync as any).matchUnlinkedInvoicesOnChange;
  assertEquals(typeof run, "function");
  for (const [enabled, changed, cursor, expectedRuns] of [
    [false, 0, NOW.toISOString(), 1], [true, 0, NOW.toISOString(), 0],
    [true, 1, NOW.toISOString(), 1], [true, 0, undefined, 1],
    [true, 0, "2026-11-17T04:59:59Z", 1], [true, 0, "2026-11-17T05:00:00Z", 0],
  ] as const) {
    const f = makeClient({ enabled, cursor });
    const result = await run(f.client, changed, NOW);
    assertEquals(f.calls.filter((c) => c.table === "feature_flags").length, 1);
    assertEquals(f.calls.filter((c) => c.table === "xero_invoices" && c.mode === "select").length, expectedRuns * 2);
    assertEquals(f.calls.filter((c) => c.table === "xero_sync_state" && c.mode === "upsert").length, expectedRuns);
    if (!expectedRuns) assertEquals(result, { matched: 0, flagged: 0, skipped: "no_change" });
    else assertEquals(f.calls.find((c) => c.table === "xero_sync_state" && c.mode === "upsert")?.row?.cursor_at, NOW.toISOString());
  }
});

Deno.test("a failed on-change matcher run remains due on the next unchanged sync", async () => {
  for (const failure of ["jobsError", "annotationsError"] as const) {
    const f = makeClient({ enabled: true, unlinked: [invoice()], [failure]: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await sync.matchUnlinkedInvoicesOnChange(f.client, 0, NOW);
      assert(result.error);
    }
    assertEquals(f.calls.filter((c) => c.table === "xero_invoices" && c.mode === "select").length, 4);
    assertEquals(f.calls.filter((c) => c.table === "xero_sync_state" && c.mode === "upsert").length, 0);
  }
});
