import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { _ingestMaterialsActualsForTest } from "./index.ts";

type Row = Record<string, any>;
type Filter = { op: string; args: any[] };
type Call = { table: string; mode: string; filters: Filter[] };

const ORG = "00000000-0000-0000-0000-000000000001";

function makeClient(seed: Record<string, Row[]>) {
  const tables = structuredClone(seed);
  // The one set of people accounts, as migrated, unless a test seeds its own.
  tables.people_account_codes ??= [{ account_code: "301" }, { account_code: "306" }, { account_code: "475" }];
  const calls: Call[] = [];

  function matches(row: Row, filter: Filter): boolean {
    const [key, value, other] = filter.args;
    switch (filter.op) {
      case "eq": return row[key] === value;
      case "is": return (row[key] ?? null) === value;
      case "in": return value.includes(row[key]);
      case "gte": return row[key] >= value;
      case "like": {
        const pattern = String(value).split("%").map((part) =>
          part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        ).join(".*");
        return new RegExp(`^${pattern}$`).test(String(row[key]));
      }
      case "not": {
        if (value === "is") return (row[key] ?? null) !== other;
        if (value === "in") return !JSON.parse(`[${String(other).slice(1, -1)}]`).includes(row[key]);
        throw new Error(`Unsupported not operator: ${value}`);
      }
      case "or":
        return String(key).split(",").some((term) => {
          const [column, op, ...rest] = term.split(".");
          const expected = rest.join(".");
          if (op === "is") return (row[column] ?? null) === (expected === "null" ? null : expected);
          if (op === "eq") return String(row[column]) === expected;
          throw new Error(`Unsupported or term: ${term}`);
        });
      default: throw new Error(`Unsupported filter: ${filter.op}`);
    }
  }

  function builder(table: string) {
    const call: Call = { table, mode: "select", filters: [] };
    const ordering: Array<{ column: string; ascending: boolean }> = [];
    let span: [number, number] | null = null;
    let cap: number | null = null;
    let payload: Row[] = [];
    let conflictKeys: string[] = [];
    let ignoreDuplicates = false;
    const b: any = {
      select: () => b,
      order: (column: string, opts: { ascending?: boolean } = {}) => {
        ordering.push({ column, ascending: opts.ascending !== false });
        return b;
      },
      range: (from: number, to: number) => { span = [from, to]; return b; },
      limit: (count: number) => { cap = count; return b; },
      delete: () => { call.mode = "delete"; return b; },
      then: (resolve: any, reject: any) => {
        calls.push(structuredClone(call));
        const stored = tables[table] ??= [];
        let selected = stored.filter((row) => call.filters.every((f) => matches(row, f)));
        selected.sort((a, z) => {
          for (const { column, ascending } of ordering) {
            const comparison = a[column] < z[column] ? -1 : a[column] > z[column] ? 1 : 0;
            if (comparison) return ascending ? comparison : -comparison;
          }
          return 0;
        });
        if (span) selected = selected.slice(span[0], span[1] + 1);
        if (cap !== null) selected = selected.slice(0, cap);
        if (call.mode === "update") {
          selected.forEach((row) => Object.assign(row, payload[0]));
        } else if (call.mode === "delete") {
          tables[table] = stored.filter((row) => !selected.includes(row));
        } else if (call.mode === "insert" || call.mode === "upsert") {
          selected = [];
          for (const row of payload) {
            const existing = call.mode === "upsert" && conflictKeys.length
              ? stored.find((candidate) => conflictKeys.every((key) => candidate[key] === row[key]))
              : undefined;
            if (existing && ignoreDuplicates) continue;
            if (existing) Object.assign(existing, row);
            else stored.push(structuredClone(row));
            selected.push(existing || row);
          }
        }
        return Promise.resolve({ data: structuredClone(selected), error: null }).then(resolve, reject);
      },
    };
    for (const op of ["eq", "not", "is", "in", "like", "or", "gte"]) {
      b[op] = (...args: any[]) => { call.filters.push({ op, args }); return b; };
    }
    for (const mode of ["update", "insert", "upsert"]) {
      b[mode] = (rows: Row | Row[], opts: { onConflict?: string; ignoreDuplicates?: boolean } = {}) => {
        call.mode = mode;
        payload = Array.isArray(rows) ? rows : [rows];
        conflictKeys = opts.onConflict?.split(",") ?? [];
        ignoreDuplicates = opts.ignoreDuplicates ?? false;
        return b;
      };
    }
    return b;
  }

  return {
    tables,
    calls,
    client: {
      from: builder,
      rpc: (name: string, args: Row = {}) => {
        calls.push({ table: name, mode: "rpc", filters: [{ op: "args", args: [args] }] });
        return Promise.resolve({ data: 0, error: null });
      },
    },
  };
}

function job(id: string, job_number: string): Row {
  return { id, job_number, org_id: ORG, status: "accepted", do_not_schedule: false };
}

function bill(xero_invoice_id: string, reference: string): Row {
  return {
    xero_invoice_id,
    org_id: ORG,
    invoice_number: xero_invoice_id,
    reference,
    invoice_type: "ACCPAY",
    status: "AUTHORISED",
    invoice_date: new Date().toISOString().slice(0, 10),
    sub_total: 0,
    total: 0,
    line_items: [],
  };
}

Deno.test("materials ingest resolves references from the run job list without per-bill jobs like reads", async () => {
  const { client, tables, calls } = makeClient({
    jobs: [job("job-fencing", "SWF-260001"), job("job-patio", "SWP-260002")],
    xero_invoices: [
      bill("bill-fencing", "SWF-260001"),
      bill("bill-patio", "SWP-260002"),
      bill("bill-unknown", "SWF-269999"),
    ],
  });

  const result = await _ingestMaterialsActualsForTest(client, { prematch: false });

  assertEquals(result.success, true);
  assertEquals(result.scanned, 3);
  assertEquals(result.facts, 2);
  assertEquals(result.queued, 1);
  assertEquals(calls.filter((c) => c.table === "jobs" && c.filters.some((f) => f.op === "like")).length, 0);
  assertEquals(calls.filter((c) => c.table === "jobs").length, 1);
  assertEquals(tables.job_materials_facts.map((row) => [row.xero_invoice_id, row.job_id]), [
    ["bill-fencing", "job-fencing"],
    ["bill-patio", "job-patio"],
  ]);
  assertEquals(tables.materials_reconciliation_queue.map((row) => [row.xero_invoice_id, row.suggested_job_id]), [
    ["bill-unknown", null],
  ]);
});

Deno.test("materials ingest leaves a reference with shared job digits unplaced", async () => {
  const { client, tables, calls } = makeClient({
    jobs: [job("job-fencing", "SWF-26328"), job("job-patio", "SWP-26328")],
    xero_invoices: [bill("bill-shared", "SWF-26328")],
  });

  const result = await _ingestMaterialsActualsForTest(client, { prematch: false });

  assertEquals(result.success, true);
  assertEquals(result.facts, 0);
  assertEquals(result.queued, 1);
  assertEquals(tables.job_materials_facts, []);
  assertEquals(tables.materials_reconciliation_queue.map((row) => [row.xero_invoice_id, row.suggested_job_id]), [
    ["bill-shared", null],
  ]);
  assertEquals(calls.filter((c) => c.table === "jobs" && c.filters.some((f) => f.op === "like")).length, 0);
});
