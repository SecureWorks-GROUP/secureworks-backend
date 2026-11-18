// deno-lint-ignore-file no-explicit-any
// FU49 9(a) option A: office confirm list and one-press confirm. Made-up
// amounts, ZZTEST job numbers, roles only. The database half (lock, re-read,
// append-only record) is the migration contract
// 20261118153001_job_work_order_labour_confirm.
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  confirmJobWorkOrderLabour,
  JOB_WORK_ORDER_LABOUR_CONFIRM_FLAG,
  LABOUR_CONFIRM_PAGE_MAX,
  labourProposalFor,
  listJobWorkOrderLabourConfirm,
} from "./job_work_order_labour_confirm.ts";
import { JobWorkOrderOfficeError } from "./job_work_order_office.ts";

const ORG = "00000000-0000-4000-8000-0000000000a0";
const OFFICE = { staff: true, userId: "00000000-0000-4000-8000-0000000000u1", orgId: ORG };
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

type Tables = Record<string, any[]>;

function getPath(row: any, path: string): any {
  return path.split(".").reduce((v, k) => (v == null ? v : v[k]), row);
}

/** A small PostgREST stand-in: eq / is / in / order / range / limit over
 *  in-memory rows, a nested jobs join, and a stateful confirm RPC. */
function fakeClient(tables: Tables, opts: {
  flagOn?: boolean;
  failTable?: string;
  rpcError?: boolean;
} = {}) {
  const calls: { table?: string; rpc?: string; args?: any }[] = [];
  const confirmed = new Map<string, any>();
  const client: any = {
    calls,
    confirmed,
    from(table: string) {
      calls.push({ table });
      const filters: ((r: any) => boolean)[] = [];
      let range: [number, number] | null = null;
      let lim: number | null = null;
      const orders: [string, boolean][] = [];
      const q: any = {
        select() { return q; },
        eq(col: string, v: any) { filters.push((r) => getPath(r, col) === v); return q; },
        is(col: string, v: any) { filters.push((r) => (getPath(r, col) ?? null) === v); return q; },
        in(col: string, vs: any[]) { filters.push((r) => vs.includes(getPath(r, col))); return q; },
        order(col: string, o?: any) { orders.push([col, o?.ascending !== false]); return q; },
        range(a: number, b: number) { range = [a, b]; return q; },
        limit(n: number) { lim = n; return q; },
        then(resolve: any, reject: any) {
          if (opts.failTable === table) {
            return Promise.resolve({ data: null, error: { message: "boom" } }).then(resolve, reject);
          }
          if (table === "feature_flags") {
            const enabled = opts.flagOn === true;
            return Promise.resolve({
              data: [{ flag_name: JOB_WORK_ORDER_LABOUR_CONFIRM_FLAG, enabled }],
              error: null,
            }).then(resolve, reject);
          }
          let rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
          rows = [...rows].sort((x, y) => {
            for (const [c, asc] of orders) {
              const a = getPath(x, c), b = getPath(y, c);
              if (a === b) continue;
              return (a < b ? -1 : 1) * (asc ? 1 : -1);
            }
            return 0;
          });
          if (range) rows = rows.slice(range[0], range[1] + 1);
          if (lim !== null) rows = rows.slice(0, lim);
          return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
        },
      };
      return q;
    },
    rpc(name: string, args: any) {
      calls.push({ rpc: name, args });
      if (opts.rpcError) return Promise.resolve({ data: null, error: { message: "boom" } });
      const wo = (tables.work_orders ?? []).find((w) => w.id === args.p_work_order_id);
      const done = confirmed.get(args.p_work_order_id);
      if (done) return Promise.resolve({ data: { ...done, state: "already_confirmed" }, error: null });
      if (!wo) return Promise.resolve({ data: { state: "refused", code: "work_order_not_found" }, error: null });
      if (wo.agreed_labour_ex != null) {
        return Promise.resolve({ data: { state: "refused", code: "work_order_has_amount" }, error: null });
      }
      const budget = (tables.job_budgets ?? []).find((b) => b.id === args.p_job_budget_id);
      if (!budget || budget.work_order_amount == null) {
        return Promise.resolve({ data: { state: "refused", code: "no_amount_in_sealed_quote" }, error: null });
      }
      if (budget.work_order_amount !== args.p_expected_ex) {
        return Promise.resolve({ data: { state: "refused", code: "proposal_changed" }, error: null });
      }
      wo.agreed_labour_ex = budget.work_order_amount;
      const row = {
        work_order_id: wo.id,
        job_id: wo.job_id,
        job_budget_id: budget.id,
        scope_revision_id: budget.scope_revision_id,
        agreed_labour_ex: budget.work_order_amount,
        confirmed_by: args.p_actor,
        confirmed_at: "2026-01-02T00:00:00Z",
      };
      confirmed.set(wo.id, row);
      return Promise.resolve({ data: { ...row, state: "confirmed" }, error: null });
    },
  };
  return client;
}

function wo(n: number, job: number, extra: Record<string, unknown> = {}) {
  return {
    id: id(n),
    job_id: id(job),
    org_id: ORG,
    wo_number: `ZZTEST-WO-${n}`,
    kind: "job",
    status: "draft",
    agreed_labour_ex: null,
    quote_filled_scope_revision_id: null,
    created_at: `2026-01-${String(n % 28 + 1).padStart(2, "0")}T00:00:00Z`,
    updated_at: "2026-01-01T00:00:00Z",
    jobs: { id: id(job), job_number: `ZZTEST-${job}`, type: "patio", status: "scheduled", org_id: ORG },
    ...extra,
  };
}

function budget(n: number, job: number, amount: unknown, version = 1, rev = id(900 + job)) {
  return { id: id(n), job_id: id(job), version, scope_revision_id: rev, work_order_amount: amount };
}

function fixture(): Tables {
  return {
    work_orders: [
      wo(101, 1), // sealed amount
      wo(102, 2), // sealed budget, no labour amount
      wo(103, 3, { agreed_labour_ex: 500 }), // already agreed: never listed
      wo(104, 4), // no sealed budget at all
      wo(105, 5, { status: "approved", agreed_labour_ex: 700 }), // approved: never listed
      wo(106, 6, { jobs: { id: id(6), job_number: "ZZTEST-6", type: "patio", status: "complete", org_id: ORG } }),
    ],
    job_budgets: [
      budget(201, 1, 1000, 1),
      budget(202, 1, 1234.5, 2), // newer version wins
      budget(203, 2, null),
    ],
  };
}

Deno.test("labour confirm list: a sealed labour amount is proposed, the newest budget wins", async () => {
  const client = fakeClient(fixture(), { flagOn: true });
  const out: any = await listJobWorkOrderLabourConfirm(client, new URLSearchParams(), OFFICE);
  assertEquals(out.enabled, true);
  assertEquals(out.press, "fill_draft");
  const row = out.jobs.find((r: any) => r.job_id === id(1));
  assertEquals(row.reason, "sealed_amount");
  assertEquals(row.proposal, {
    agreed_labour_ex: 1234.5,
    job_budget_id: id(202),
    scope_revision_id: id(901),
  });
});

Deno.test("labour confirm list: a sealed budget with no labour amount proposes nothing", async () => {
  const client = fakeClient(fixture(), { flagOn: true });
  const out: any = await listJobWorkOrderLabourConfirm(client, null, OFFICE);
  const noAmount = out.jobs.find((r: any) => r.job_id === id(2));
  assertEquals(noAmount.reason, "no_amount_in_sealed_quote");
  assertEquals(noAmount.proposal, null);
  const noBudget = out.jobs.find((r: any) => r.job_id === id(4));
  assertEquals(noBudget.reason, "no_sealed_quote");
  assertEquals(noBudget.proposal, null);
});

Deno.test("labour confirm list: an agreed, approved or closed job is not listed", async () => {
  const client = fakeClient(fixture(), { flagOn: true });
  const out: any = await listJobWorkOrderLabourConfirm(client, null, OFFICE);
  const listed = out.jobs.map((r: any) => r.job_id).sort();
  assertEquals(listed, [id(1), id(2), id(4)]);
  assertEquals(out.more, false);
});

Deno.test("labour confirm list: paged with a hard cap and an explicit 'more than N'", async () => {
  const tables: Tables = {
    work_orders: Array.from({ length: 60 }, (_, i) => wo(300 + i, 300 + i)),
    job_budgets: [],
  };
  const client = fakeClient(tables, { flagOn: true });
  const out: any = await listJobWorkOrderLabourConfirm(client, { limit: 500 }, OFFICE);
  assertEquals(out.limit, LABOUR_CONFIRM_PAGE_MAX);
  assertEquals(out.jobs.length, LABOUR_CONFIRM_PAGE_MAX);
  assertEquals(out.more, true);
  assertEquals(out.more_than, LABOUR_CONFIRM_PAGE_MAX);
  const last: any = await listJobWorkOrderLabourConfirm(client, { limit: 50, offset: 50 }, OFFICE);
  assertEquals(last.jobs.length, 10);
  assertEquals(last.more, false);
  assertEquals("more_than" in last, false);
});

Deno.test("labour confirm list: a failed budget read refuses, never 'no amount'", async () => {
  const client = fakeClient(fixture(), { flagOn: true, failTable: "job_budgets" });
  const err = await assertRejects(
    () => listJobWorkOrderLabourConfirm(client, null, OFFICE),
    JobWorkOrderOfficeError,
  );
  assertEquals((err as JobWorkOrderOfficeError).status, 503);
  assertEquals((err as JobWorkOrderOfficeError).code, "labour_confirm_budget_unreadable");
});

Deno.test("labour confirm list: a failed list read refuses, never an empty list", async () => {
  const client = fakeClient(fixture(), { flagOn: true, failTable: "work_orders" });
  const err = await assertRejects(
    () => listJobWorkOrderLabourConfirm(client, null, OFFICE),
    JobWorkOrderOfficeError,
  );
  assertEquals((err as JobWorkOrderOfficeError).code, "labour_confirm_list_unreadable");
});

Deno.test("labour confirm list: switch off reads nothing past the switch", async () => {
  const client = fakeClient(fixture(), { flagOn: false });
  const out: any = await listJobWorkOrderLabourConfirm(client, null, OFFICE);
  assertEquals(out, { enabled: false, press: "fill_draft", jobs: [], more: false });
  assertEquals(client.calls.filter((c: any) => c.table && c.table !== "feature_flags").length, 0);
});

Deno.test("labour confirm: a draft filled from another revision proposes nothing", () => {
  const out = labourProposalFor(
    { quote_filled_scope_revision_id: id(999) },
    { id: id(1), scope_revision_id: id(998), work_order_amount: 100 },
  );
  assertEquals(out, { reason: "revision_differs", proposal: null });
});

Deno.test("labour confirm press: writes the sealed amount once; a double press is idempotent", async () => {
  const tables = fixture();
  const client = fakeClient(tables, { flagOn: true });
  const body = { work_order_id: id(101), job_budget_id: id(202), agreed_labour_ex: 1234.5 };
  const first: any = await confirmJobWorkOrderLabour(client, body, OFFICE);
  assertEquals(first.state, "confirmed");
  assertEquals(first.agreed_labour_ex, 1234.5);
  assertEquals(first.confirmed_by, OFFICE.userId);
  assert(first.confirmed_at);
  const second: any = await confirmJobWorkOrderLabour(client, body, OFFICE);
  assertEquals(second.state, "already_confirmed");
  assertEquals(second.agreed_labour_ex, 1234.5);
  assertEquals(client.confirmed.size, 1);
  const rpc = client.calls.find((c: any) => c.rpc);
  assertEquals(rpc.args.p_actor, OFFICE.userId);
  assertEquals(rpc.args.p_org_id, ORG);
  // Now agreed, the job leaves the list.
  const out: any = await listJobWorkOrderLabourConfirm(client, null, OFFICE);
  assertEquals(out.jobs.some((r: any) => r.job_id === id(1)), false);
});

Deno.test("labour confirm press: no sealed amount writes nothing", async () => {
  const tables = fixture();
  const client = fakeClient(tables, { flagOn: true });
  const err = await assertRejects(
    () => confirmJobWorkOrderLabour(client, { work_order_id: id(102), job_budget_id: id(203), agreed_labour_ex: 0 }, OFFICE),
    JobWorkOrderOfficeError,
  );
  assertEquals((err as JobWorkOrderOfficeError).code, "no_amount_in_sealed_quote");
  assertEquals(tables.work_orders.find((w) => w.id === id(102))!.agreed_labour_ex, null);
});

Deno.test("labour confirm press: an already agreed draft is refused and left alone", async () => {
  const tables = fixture();
  const client = fakeClient(tables, { flagOn: true });
  const err = await assertRejects(
    () => confirmJobWorkOrderLabour(client, { work_order_id: id(103), job_budget_id: id(202), agreed_labour_ex: 1234.5 }, OFFICE),
    JobWorkOrderOfficeError,
  );
  assertEquals((err as JobWorkOrderOfficeError).code, "work_order_has_amount");
  assertEquals(tables.work_orders.find((w) => w.id === id(103))!.agreed_labour_ex, 500);
});

Deno.test("labour confirm: a non-office token is refused before any read", async () => {
  const client = fakeClient(fixture(), { flagOn: true });
  const trade = { staff: false, userId: id(77), orgId: ORG };
  for (const call of [
    () => listJobWorkOrderLabourConfirm(client, null, trade),
    () => confirmJobWorkOrderLabour(client, { work_order_id: id(101), job_budget_id: id(202), agreed_labour_ex: 1234.5 }, trade),
  ]) {
    const err = await assertRejects(call, JobWorkOrderOfficeError);
    assertEquals((err as JobWorkOrderOfficeError).status, 403);
    assertEquals((err as JobWorkOrderOfficeError).code, "operator_access_required");
  }
  assertEquals(client.calls.length, 0);
});

Deno.test("labour confirm press: the server key alone is refused (no person to record)", async () => {
  const client = fakeClient(fixture(), { flagOn: true });
  const err = await assertRejects(
    () => confirmJobWorkOrderLabour(client, { work_order_id: id(101), job_budget_id: id(202), agreed_labour_ex: 1234.5 }, { staff: true, userId: null, orgId: ORG }),
    JobWorkOrderOfficeError,
  );
  assertEquals((err as JobWorkOrderOfficeError).code, "signed_in_person_required");
  assertEquals(client.calls.length, 0);
});

Deno.test("labour confirm press: switch off, bad input or a failed write never saves", async () => {
  const off = fakeClient(fixture(), { flagOn: false });
  const body = { work_order_id: id(101), job_budget_id: id(202), agreed_labour_ex: 1234.5 };
  const e1 = await assertRejects(() => confirmJobWorkOrderLabour(off, body, OFFICE), JobWorkOrderOfficeError);
  assertEquals((e1 as JobWorkOrderOfficeError).code, "labour_confirm_off");
  assertEquals(off.calls.some((c: any) => c.rpc), false);

  const on = fakeClient(fixture(), { flagOn: true });
  const e2 = await assertRejects(
    () => confirmJobWorkOrderLabour(on, { ...body, agreed_labour_ex: "" }, OFFICE),
    JobWorkOrderOfficeError,
  );
  assertEquals((e2 as JobWorkOrderOfficeError).code, "confirm_input_required");

  const broken = fakeClient(fixture(), { flagOn: true, rpcError: true });
  const e3 = await assertRejects(() => confirmJobWorkOrderLabour(broken, body, OFFICE), JobWorkOrderOfficeError);
  assertEquals((e3 as JobWorkOrderOfficeError).status, 503);
  assertEquals((e3 as JobWorkOrderOfficeError).code, "labour_confirm_failed");
});

Deno.test("labour confirm press: a stale proposal is refused", async () => {
  const client = fakeClient(fixture(), { flagOn: true });
  const err = await assertRejects(
    () => confirmJobWorkOrderLabour(client, { work_order_id: id(101), job_budget_id: id(202), agreed_labour_ex: 999 }, OFFICE),
    JobWorkOrderOfficeError,
  );
  assertEquals((err as JobWorkOrderOfficeError).code, "proposal_changed");
});
