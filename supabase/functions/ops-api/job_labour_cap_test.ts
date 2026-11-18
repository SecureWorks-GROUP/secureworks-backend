// deno-lint-ignore-file no-explicit-any no-import-prefix require-await
// Ruling 17 step 4: how the crew is paid comes from the job budget, and a job
// paid hourly up to a maximum holds every trade to it
// (docs/job-budget-v1.md, "Labour: pay mode and the hourly cap (step 4)").
// Ruling 17c: the refusal is the one work order cap guard's; its hourly cases
// are in work_order_total_cap_test.ts. The last cases here drive the guard
// itself (_assertWithinWorkOrderTotal, index.ts) on an in-memory client.
import "./trade_app_visibility_rules_test_env.ts";
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { _assertWithinWorkOrderTotal, ApiError } from "./index.ts";
import {
  budgetAgreedLabour,
  budgetLabourPay,
  hourlyLimitFromState,
  JOB_LABOUR_BUDGET_FLAG,
  jobLabourCapAction,
  JobLabourPayReadError,
  raiseJobLabourCapAction,
  readHourlyCappedJobs,
  readHourlyLabourLimits,
  readNewestJobBudgetLabour,
} from "./job_labour_cap.ts";
import { decideTradeInvoiceMode, loadTradeInvoiceJobModes, TradeInvoiceModeReadError } from "./trade_invoice_mode.ts";
import { patioBase } from "../_shared/job_budget/budget_examples.ts";
import { budgetAddedUp, checkBudget } from "../_shared/job_budget/budget_v1.ts";

const ORG = "00000000-0000-0000-0000-000000000001";
const JOB_A = "11111111-1111-4111-8111-11111111111a";
const JOB_B = "11111111-1111-4111-8111-11111111111b";
const BUDGET = "22222222-2222-4222-8222-222222222222";
const TRADE = "33333333-3333-4333-8333-333333333333";
const APPROVER = "44444444-4444-4444-8444-444444444444";

// A small PostgREST stand-in: eq / in / not / order / limit / range /
// maybeSingle, a table that can be made to return an error (fail) or to throw
// (throwOn, a rejected read), and an rpc hook that can throw too.
class Q {
  private f: Array<(r: any) => boolean> = [];
  private lim: number | null = null;
  private sort: { col: string; asc: boolean } | null = null;
  private one = false;
  constructor(private db: Fake, private table: string) {}
  select() {
    return this;
  }
  eq(c: string, v: any) {
    this.f.push((r) => r[c] === v);
    return this;
  }
  in(c: string, v: any[]) {
    this.f.push((r) => v.includes(r[c]));
    return this;
  }
  order(c: string, o?: { ascending?: boolean }) {
    this.sort = { col: c, asc: o?.ascending !== false };
    return this;
  }
  limit(n: number) {
    this.lim = n;
    return this;
  }
  not() {
    return this;
  }
  range() {
    return this;
  }
  maybeSingle() {
    this.one = true;
    return this;
  }
  then(res: any, rej: any) {
    return this.run().then(res, rej);
  }
  private async run() {
    this.db.reads.push(this.table);
    if (this.db.throwOn.has(this.table)) throw new TypeError("fetch failed");
    if (this.db.fail.has(this.table)) return { data: null, error: { message: "boom" } };
    let rows = (this.db.tables[this.table] || []).filter((r) => this.f.every((g) => g(r)));
    if (this.sort) {
      const { col, asc } = this.sort;
      rows = [...rows].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1));
    }
    if (this.lim !== null) rows = rows.slice(0, this.lim);
    if (this.one) return { data: rows[0] ?? null, error: null };
    return { data: rows, error: null };
  }
}

class Fake {
  fail = new Set<string>();
  throwOn = new Set<string>();
  rpcThrows = false;
  reads: string[] = [];
  rpcs: Array<{ fn: string; args: any }> = [];
  rpcAnswer: { data: any; error: any } | ((args: any) => { data: any; error: any }) = { data: null, error: null };
  constructor(public tables: Record<string, any[]>) {}
  from(t: string) {
    return new Q(this, t);
  }
  rpc(fn: string, args: any) {
    this.rpcs.push({ fn, args });
    if (this.rpcThrows) return Promise.reject(new TypeError("fetch failed"));
    return Promise.resolve(typeof this.rpcAnswer === "function" ? this.rpcAnswer(args) : this.rpcAnswer);
  }
}

const switchOn = [{ flag_name: JOB_LABOUR_BUDGET_FLAG, enabled: true }];

// A budget row as the pay read's projection returns it (pay:budget->labour->>pay).
const payRow = (job: string, version: number, pay: string) => ({ job_id: job, version, pay });

Deno.test("mode: an hourly-capped budget makes the job hourly, after a live group work order only", () => {
  assertEquals(
    decideTradeInvoiceMode({ hasLiveGroupWorkOrder: false, tradeInvoiceType: "per_metre", jobVertical: "fencing", hourlyCapped: true }),
    { invoice_mode: "hourly", invoice_mode_reason: "hourly_capped" },
  );
  assertEquals(
    decideTradeInvoiceMode({ hasLiveGroupWorkOrder: true, tradeInvoiceType: null, jobVertical: "patio", hourlyCapped: true }),
    { invoice_mode: "group_work_order", invoice_mode_reason: "live_group_work_order" },
  );
  assertEquals(
    decideTradeInvoiceMode({ hasLiveGroupWorkOrder: false, tradeInvoiceType: null, jobVertical: "fencing" }),
    { invoice_mode: "work_order", invoice_mode_reason: "fencing_job" },
  );
});

Deno.test("pay read: the switch off reads no budget; on, the newest version decides", async () => {
  const budgets = [payRow(JOB_A, 1, "group_work_order"), payRow(JOB_A, 2, "hourly_capped"), payRow(JOB_B, 3, "group_work_order"), payRow(JOB_B, 1, "hourly_capped")];
  const off = new Fake({ job_budgets: budgets });
  assertEquals([...(await readHourlyCappedJobs(off, [JOB_A, JOB_B]))], []);
  assert(!off.reads.includes("job_budgets"));
  const on = new Fake({ feature_flags: switchOn, job_budgets: budgets });
  assertEquals([...(await readHourlyCappedJobs(on, [JOB_A, JOB_B]))], [JOB_A]);
});

Deno.test("pay read: an unreadable budget or switch throws, never reads as no cap; a missing switch is off", async () => {
  const broken = new Fake({ feature_flags: switchOn, job_budgets: [] });
  broken.fail.add("job_budgets");
  await assertRejects(() => readHourlyCappedJobs(broken, [JOB_A]), JobLabourPayReadError);
  const noSwitch = new Fake({ job_budgets: [payRow(JOB_A, 1, "hourly_capped")] });
  noSwitch.fail.add("feature_flags");
  await assertRejects(() => readHourlyCappedJobs(noSwitch, [JOB_A]), JobLabourPayReadError);
  // A read that throws (a rejected promise) is the same fault as one that
  // returns an error: JobLabourPayReadError, never a bare error.
  const thrown = new Fake({ feature_flags: switchOn, job_budgets: [payRow(JOB_A, 1, "hourly_capped")] });
  thrown.throwOn.add("job_budgets");
  await assertRejects(() => readHourlyCappedJobs(thrown, [JOB_A]), JobLabourPayReadError);
  const thrownSwitch = new Fake({ feature_flags: switchOn, job_budgets: [payRow(JOB_A, 1, "hourly_capped")] });
  thrownSwitch.throwOn.add("feature_flags");
  await assertRejects(() => readHourlyCappedJobs(thrownSwitch, [JOB_A]), JobLabourPayReadError);
  assertEquals((await readNewestJobBudgetLabour(thrown, JOB_A)).state, "unreadable");
  const missing = new Fake({ feature_flags: [], job_budgets: [payRow(JOB_A, 1, "hourly_capped")] });
  assertEquals((await readHourlyCappedJobs(missing, [JOB_A])).size, 0);
  assert(!missing.reads.includes("job_budgets"));
  // The work order fill holds the draft on an unreadable switch, never reads it as off.
  assertEquals((await readNewestJobBudgetLabour(noSwitch, JOB_A)).state, "unreadable");
  assertEquals((await readNewestJobBudgetLabour(missing, JOB_A)).state, "off");
});

Deno.test("loader: an hourly-capped fencing job is invoiced by the hour; an unreadable budget fails the read", async () => {
  const tables = () => ({
    users: [{ id: TRADE, org_id: ORG, invoice_type: null, managed_verticals: [], invoice_any_job: false }],
    jobs: [
      { id: JOB_A, org_id: ORG, type: "fencing", metadata: {}, created_by: null },
      { id: JOB_B, org_id: ORG, type: "fencing", metadata: {}, created_by: null },
    ],
    group_work_orders: [],
    work_orders: [],
    feature_flags: switchOn,
    job_budgets: [payRow(JOB_A, 1, "hourly_capped"), payRow(JOB_B, 1, "group_work_order")],
  });
  const input = {
    tradeId: TRADE,
    jobIds: [JOB_A, JOB_B],
    jobVertical: (j: any) => String(j.type),
    normaliseManagedVerticals: () => [],
  };
  const out = await loadTradeInvoiceJobModes(new Fake(tables()), input);
  const byJob = Object.fromEntries(out.jobs.map((j) => [j.job_id, j.invoice_mode_reason]));
  assertEquals(byJob, { [JOB_A]: "hourly_capped", [JOB_B]: "fencing_job" });
  const broken = new Fake(tables());
  broken.fail.add("job_budgets");
  await assertRejects(() => loadTradeInvoiceJobModes(broken, input), TradeInvoiceModeReadError);
});

Deno.test("budget readers: pay and work order amount, nothing invented", () => {
  assertEquals(budgetLabourPay({ labour: { pay: "hourly_capped" } }), "hourly_capped");
  assertEquals(budgetLabourPay({ labour: { pay: "operator_share" } }), null);
  assertEquals(budgetAgreedLabour({ labour: { work_order_amount_ex_gst: 1234.567 } }), 1234.57);
  assertEquals(budgetAgreedLabour({ labour: {} }), null);
  assertEquals(budgetAgreedLabour({ labour: { work_order_amount_ex_gst: -1 } }), null);
});

Deno.test("limits: each hourly job's limit is the database's one read; anything else throws, never no limit", async () => {
  const capped = (cap: unknown, state = "capped") => ({ data: { state, cap_ex_gst: cap }, error: null });
  assertEquals(hourlyLimitFromState({ state: "capped", cap_ex_gst: 3050 }), 3050);
  assertEquals(hourlyLimitFromState({ state: "capped_unreadable", cap_ex_gst: 0 }), null);
  assertEquals(hourlyLimitFromState({ state: "capped", cap_ex_gst: "800" }), null);
  assertEquals(hourlyLimitFromState({ state: "capped", cap_ex_gst: -1 }), null);
  assertEquals(hourlyLimitFromState(null), null);

  const tables = () => ({
    feature_flags: switchOn,
    job_budgets: [payRow(JOB_A, 1, "hourly_capped"), payRow(JOB_B, 1, "group_work_order")],
  });
  const db = new Fake(tables());
  db.rpcAnswer = (args) => args.p_job === JOB_A ? capped(900) : capped(1);
  const limits = await readHourlyLabourLimits(db, [JOB_A, JOB_B]);
  assertEquals([...limits], [[JOB_A, 900]], "only the hourly job, at its read limit");
  assertEquals(db.rpcs.map((r) => [r.fn, r.args.p_job]), [["job_labour_cap_state", JOB_A]]);

  for (
    const answer of [
      capped(0, "capped_unreadable"),
      capped(null),
      { data: { state: "not_capped" }, error: null },
      { data: null, error: { message: "boom" } },
    ]
  ) {
    const bad = new Fake(tables());
    bad.rpcAnswer = answer;
    await assertRejects(() => readHourlyLabourLimits(bad, [JOB_A, JOB_B]), JobLabourPayReadError, undefined, JSON.stringify(answer));
  }
  const off = new Fake({ ...tables(), feature_flags: [] });
  assertEquals((await readHourlyLabourLimits(off, [JOB_A])).size, 0);
  assertEquals(off.rpcs.length, 0);
});

Deno.test("one refusal path: no database labour guard, no second refusal code; the one guard reads the hourly limit", async () => {
  const read = (rel: string) => Deno.readTextFile(new URL(rel, import.meta.url));
  const migration = await read("../../migrations/20261114030000_job_labour_cap.sql");
  for (const gone of ["CREATE CONSTRAINT TRIGGER", "job_labour_cap_check_invoice", "job_labour_cap_exceeded", "job_labour_cap_unreadable", "billed_ex_gst"]) {
    assert(!migration.includes(gone), `the migration still carries ${gone}`);
  }
  const index = await read("./index.ts");
  for (const gone of ["jobLabourCapRefusal", "job_labour_cap_exceeded"]) {
    assert(!index.includes(gone), `index.ts still carries ${gone}`);
  }
  const at = index.indexOf("export async function _assertWithinWorkOrderTotal(");
  const guard = index.slice(at, index.indexOf("\nexport async function ", at + 10));
  assert(guard.includes("readHourlyCappedJobs(client, jobIds)"), "the guard finds the hourly jobs");
  assert(guard.includes("readHourlyLabourLimits(client, jobIds)"), "the guard reads their limits");
  assert(guard.includes("'work_order_cap_unavailable'"), "an unreadable limit is the guard's 503");
});

Deno.test("raise: a signed-in person, a whole-cent amount and a reason, before the database is asked", async () => {
  const db = new Fake({});
  const actor = { userId: APPROVER, email: "approver@example.test", orgId: ORG };
  const good = { job_id: JOB_A, budget_id: BUDGET, amount_ex_gst: 250, reason: "Extra post holes in rock" };
  await assertRejects(() => raiseJobLabourCapAction(db, good, { ...actor, userId: null }), Error, "signed-in");
  await assertRejects(() => raiseJobLabourCapAction(db, { ...good, amount_ex_gst: 0 }, actor), Error, "above zero");
  await assertRejects(() => raiseJobLabourCapAction(db, { ...good, amount_ex_gst: 10.005 }, actor), Error, "two decimals");
  await assertRejects(() => raiseJobLabourCapAction(db, { ...good, reason: "  x " }, actor), Error, "reason");
  await assertRejects(() => raiseJobLabourCapAction(db, { ...good, budget_id: "nope" }, actor), Error, "budget");
  assertEquals(db.rpcs.length, 0);
  db.rpcAnswer = { data: { raise_id: "r1", authority: "owner", cap: {} }, error: null };
  const ok = await raiseJobLabourCapAction(db, good, actor);
  assertEquals(ok.raise_id, "r1");
  assertEquals(db.rpcs[0].fn, "raise_job_labour_cap");
  assertEquals(db.rpcs[0].args, {
    p_job: JOB_A,
    p_budget_id: BUDGET,
    p_actor: APPROVER,
    p_actor_email: "approver@example.test",
    p_org_id: ORG,
    p_amount: 250,
    p_reason: "Extra post holes in rock",
  });
});

Deno.test("raise: each database refusal keeps its own code; anything else is a plain 503", async () => {
  const body = { job_id: JOB_A, budget_id: BUDGET, amount_ex_gst: 100, reason: "Rock" };
  const cases: Array<[string, number, string]> = [
    ["job_labour_cap_not_approver", 403, "not_approver"],
    ["job_labour_cap_wrong_company", 403, "wrong_company"],
    ["job_labour_cap_budget_changed", 409, "budget_changed"],
    ["job_labour_cap_not_hourly", 409, "not_hourly"],
    ["job_labour_cap_no_budget", 409, "no_budget"],
    ["connection reset", 503, "labour_cap_unwritable"],
  ];
  for (const [message, status, code] of cases) {
    const db = new Fake({});
    db.rpcAnswer = { data: null, error: { message } };
    const out = await jobLabourCapAction(db, "raise_job_labour_cap", "POST", body, {
      staff: true,
      signedIn: true,
      orgId: ORG,
      userId: APPROVER,
      email: null,
    }, () => Promise.reject(new Error("no billed read on a raise")));
    assertEquals([out.status, out.body.code], [status, code], message);
  }
});

Deno.test("doors: the read is staff in the job's company; the raise needs a signed-in person", async () => {
  const db = new Fake({ jobs: [{ id: JOB_A, org_id: ORG }] });
  db.rpcAnswer = { data: { state: "capped", cap_ex_gst: 900 }, error: null };
  const staff = { staff: true, signedIn: true, orgId: ORG, userId: APPROVER, email: null };
  const billed = async (_c: any, ids: readonly string[]) => new Map(ids.map((id) => [id, 650.5] as [string, number]));
  const get = (ctx: typeof staff, readBilled = billed) => jobLabourCapAction(db, "job_labour_cap", "GET", { job_id: JOB_A }, ctx, readBilled);
  assertEquals((await get({ ...staff, staff: false })).status, 403);
  assertEquals((await get({ ...staff, orgId: "00000000-0000-0000-0000-000000000009" })).status, 404);
  const read = await get(staff);
  assertEquals([read.status, (read.body.cap as any).state], [200, "capped"]);
  // Billed is the guard's own count, so the office sees what the doors refuse by.
  assertEquals([(read.body.cap as any).billed_ex_gst, (read.body.cap as any).remaining_ex_gst], [650.5, 249.5]);
  const failed = await get(staff, async () => {
    throw new Error("x");
  });
  assertEquals([failed.status, failed.body.code], [503, "labour_cap_unreadable"]);
  // A limit read that throws, or returns an error, is the same 503.
  db.rpcThrows = true;
  const rejected = await get(staff);
  assertEquals([rejected.status, rejected.body.code], [503, "labour_cap_unreadable"]);
  db.rpcThrows = false;
  db.rpcAnswer = { data: null, error: { message: "boom" } };
  const errored = await get(staff);
  assertEquals([errored.status, errored.body.code], [503, "labour_cap_unreadable"]);
  // A maximum that cannot be read is named in the read, with its reason.
  db.rpcAnswer = { data: { state: "capped_unreadable", unreadable_reason: "labour_hourly_mismatch", cap_ex_gst: 0 }, error: null };
  const named = await get(staff);
  assertEquals(
    [named.status, (named.body.cap as any).state, (named.body.cap as any).unreadable_reason],
    [200, "capped_unreadable", "labour_hourly_mismatch"],
  );
  db.rpcAnswer = { data: { state: "capped", cap_ex_gst: 900 }, error: null };
  const key = await jobLabourCapAction(db, "raise_job_labour_cap", "POST", { job_id: JOB_A }, { ...staff, signedIn: false, userId: null }, billed);
  assertEquals([key.status, key.body.code], [403, "named_person_required"]);
  assertEquals((await jobLabourCapAction(db, "raise_job_labour_cap", "GET", {}, staff, billed)).status, 405);
});

// ── The guard itself (_assertWithinWorkOrderTotal, index.ts) ──────────────────
// One hourly-capped fencing job with a 900 limit and nothing billed yet. Every
// fault in reading the switch, the budgets or the limit, whether returned as an
// error or thrown, is the one 503 work_order_cap_unavailable; a limit the
// database names unreadable (rate x hours not the maximum) is the same 503.

const guardTables = () => ({
  users: [{ id: TRADE, org_id: ORG, invoice_type: null, managed_verticals: [], invoice_any_job: false }],
  jobs: [{ id: JOB_A, org_id: ORG, type: "fencing", metadata: {}, created_by: null, job_number: "ZZTEST-1" }],
  group_work_orders: [],
  work_orders: [],
  feature_flags: switchOn,
  job_budgets: [payRow(JOB_A, 1, "hourly_capped")],
  trade_invoice_lines: [],
});
const labourLine = (ex: number) => [{ job_id: JOB_A, line_type: "labour", line_total_ex: ex }];
const guard = (db: Fake, ex: number) => _assertWithinWorkOrderTotal(db, { id: TRADE, orgId: ORG }, labourLine(ex));
const guardDb = (edit: (db: Fake) => void = () => {}) => {
  const db = new Fake(guardTables());
  db.rpcAnswer = { data: { state: "capped", unreadable_reason: null, cap_ex_gst: 900 }, error: null };
  edit(db);
  return db;
};

Deno.test("guard: an hourly job within its limit passes; one cent over is the work order cap's 409 naming the hourly maximum", async () => {
  await guard(guardDb(), 900);
  const err: any = await assertRejects(() => guard(guardDb(), 900.01), ApiError);
  assertEquals([err.status, err.body?.code, err.body?.jobs?.[0]?.limit], [409, "work_order_total_over_agreed", "hourly_maximum"]);
});

Deno.test("guard: a budget, switch or limit read that fails, returned or thrown, is 503 work_order_cap_unavailable", async () => {
  const unreadable = (reason: string) => ({ data: { state: "capped_unreadable", unreadable_reason: reason, cap_ex_gst: 0 }, error: null });
  const cases: Array<[string, (db: Fake) => void]> = [
    ["budget read returns an error", (db) => db.fail.add("job_budgets")],
    ["budget read throws", (db) => db.throwOn.add("job_budgets")],
    ["switch read returns an error", (db) => db.fail.add("feature_flags")],
    ["switch read throws", (db) => db.throwOn.add("feature_flags")],
    ["limit read returns an error", (db) => (db.rpcAnswer = { data: null, error: { message: "boom" } })],
    ["limit read throws", (db) => (db.rpcThrows = true)],
    ["rate x hours is not the maximum", (db) => (db.rpcAnswer = unreadable("labour_hourly_mismatch"))],
    ["an hourly field missing", (db) => (db.rpcAnswer = unreadable("labour_hourly_invalid"))],
  ];
  for (const [label, edit] of cases) {
    // A small line, well inside any limit: only the fault can refuse it.
    const err: any = await assertRejects(() => guard(guardDb(edit), 1), ApiError, undefined, label);
    assertEquals([err.status, err.body?.code], [503, "work_order_cap_unavailable"], label);
  }
});

// Ruling 18 B: the patio money14 named. 70 x 40 = 2800 by the hour, plus a
// 250 removal the crew does (removal lane, paid to the crew), added up the way
// the tool's finish does.
function hourlyPatioWithRemoval(): any {
  const base = patioBase() as any;
  base.labour.pay = "hourly_capped";
  base.labour.hourly = { rate_ex_gst: 70, max_hours: 40, max_ex_gst: 2800 };
  base.other.push({
    lane: "removal",
    lines: [{ key: "r1", description: "Remove old patio", quantity: 1, unit: "job", cost_ex_gst: 250, in_total: true, paid_to: "crew", supplier: null }],
    total_ex_gst: 250,
  });
  const added = budgetAddedUp(base);
  if (!added.ok) throw new Error(JSON.stringify(added));
  const checked = checkBudget(added.budget);
  if (!checked.ok) throw new Error(JSON.stringify(checked));
  return added.budget;
}

Deno.test("guard: ruling 18 B, an hourly patio with a crew removal: work order, fill and cap agree at 3050", async () => {
  const budget = hourlyPatioWithRemoval();
  assertEquals(
    [budget.labour.amount_ex_gst, budget.labour.work_order_amount_ex_gst, budget.labour.hourly],
    [2800, 3050, { rate_ex_gst: 70, max_hours: 40, max_ex_gst: 2800 }],
    "the work order is the maximum plus the crew removal; the rate and hours are untouched",
  );
  // The fill's figure (agreed_labour_ex) for this budget.
  assertEquals(budgetAgreedLabour(budget), 3050);
  // The limit read's answer for this budget: its work order amount plus no
  // raises (job_labour_cap_state; the migration contract's removal case runs
  // the SQL on this labour and removal lane).
  const state = {
    state: "capped",
    unreadable_reason: null,
    rate_ex_gst: 70,
    max_hours: 40,
    max_ex_gst: 2800,
    crew_options_ex_gst: 0,
    crew_lines_ex_gst: 250,
    work_order_ex_gst: budget.labour.work_order_amount_ex_gst,
    raised_ex_gst: 0,
    cap_ex_gst: budget.labour.work_order_amount_ex_gst,
  };
  const db = () => guardDb((d) => (d.rpcAnswer = { data: state, error: null }));
  const lines = (removal: number) => [
    { job_id: JOB_A, line_type: "labour", line_total_ex: 2800 },
    { job_id: JOB_A, line_type: "other", description: "Remove old patio", line_total_ex: removal },
  ];
  // The agreed 2800 of hours and the 250 removal: allowed.
  await _assertWithinWorkOrderTotal(db(), { id: TRADE, orgId: ORG }, lines(250));
  // One cent over: the one cap's 409, naming the work order's 3050.
  const err: any = await assertRejects(() => _assertWithinWorkOrderTotal(db(), { id: TRADE, orgId: ORG }, lines(250.01)), ApiError);
  assertEquals([err.status, err.body?.code, err.body?.jobs?.[0]?.hourly_maximum_ex], [409, "work_order_total_over_agreed", 3050]);
  assert(String(err.message).includes("pays the crew at most $3,050.00"), err.message);
});

// ── Follow-up 49 item 9(b): the code cap reads the cap's scope ────────────────
// With trade_line_hold_v1 off (no row, as seeded) the guard caps every job and
// never asks for the scope. On, a job work_order_cap_scope leaves out of the
// cap is not capped; one it keeps is capped exactly as before; a scope read
// that fails, returned, thrown, short or malformed, is the guard's 503.

const holdOn = [...switchOn, { flag_name: "trade_line_hold_v1", enabled: true }];
const limitState = { data: { state: "capped", unreadable_reason: null, cap_ex_gst: 900 }, error: null };
const scopeDb = (scope: (args: any) => { data: any; error: any }, flags = holdOn) => {
  const db = new Fake({ ...guardTables(), feature_flags: flags });
  db.rpcAnswer = (args: any) =>
    isScopeCall(args)
      ? scope(args)
      // With the switch on, the billed total is the database's one sum.
      : "p_exclude_line_ids" in args
      ? { data: args.p_job_ids.map((id: string) => ({ job_id: id, billed_ex: 0 })), error: null }
      : limitState;
  return db;
};
const isScopeCall = (args: any) => "p_job_ids" in args && !("p_exclude_line_ids" in args);
const scopeRpcs = (db: Fake) => db.rpcs.filter((r) => r.fn === "work_order_cap_scope").length;

Deno.test("guard, cap scope: switch off caps every job and never reads the scope", async () => {
  const db = scopeDb(() => ({ data: [{ job_id: JOB_A, in_scope: false }], error: null }), switchOn);
  const err: any = await assertRejects(() => guard(db, 900.01), ApiError);
  assertEquals([err.status, err.body?.code], [409, "work_order_total_over_agreed"]);
  assertEquals(scopeRpcs(db), 0);
});

Deno.test("guard, cap scope: switch on, a job outside the scope is not capped; one inside is capped as before", async () => {
  const outside = scopeDb((a) => ({ data: a.p_job_ids.map((id: string) => ({ job_id: id, in_scope: false })), error: null }));
  await guard(outside, 5000);
  assertEquals(scopeRpcs(outside), 1);
  assertEquals(outside.rpcs.filter((r) => "p_job" in r.args).length, 0, "an uncapped job reads no limit");
  const inside = scopeDb((a) => ({ data: a.p_job_ids.map((id: string) => ({ job_id: id, in_scope: true })), error: null }));
  await guard(inside, 900);
  const err: any = await assertRejects(() => guard(scopeDb((a) => ({ data: a.p_job_ids.map((id: string) => ({ job_id: id, in_scope: true })), error: null })), 900.01), ApiError);
  assertEquals([err.status, err.body?.code, err.body?.jobs?.[0]?.limit], [409, "work_order_total_over_agreed", "hourly_maximum"]);
});

Deno.test("guard, cap scope: a failed scope read is 503 work_order_cap_unavailable, never capped or uncapped", async () => {
  const cases: Array<[string, Fake]> = [
    ["returns an error", scopeDb(() => ({ data: null, error: { message: "boom" } }))],
    ["short answer", scopeDb(() => ({ data: [], error: null }))],
    ["not a boolean", scopeDb((a) => ({ data: a.p_job_ids.map((id: string) => ({ job_id: id, in_scope: "yes" })), error: null }))],
    ["another job", scopeDb(() => ({ data: [{ job_id: JOB_B, in_scope: false }], error: null }))],
  ];
  const thrown = scopeDb(() => ({ data: [], error: null }));
  const rpc = thrown.rpc.bind(thrown);
  thrown.rpc = (fn: string, args: any) => (isScopeCall(args) ? Promise.reject(new TypeError("fetch failed")) : rpc(fn, args));
  cases.push(["throws", thrown]);
  for (const [label, db] of cases) {
    const err: any = await assertRejects(() => guard(db, 1), ApiError, undefined, label);
    assertEquals([err.status, err.body?.code], [503, "work_order_cap_unavailable"], label);
  }
});

Deno.test("guard, cap scope: a job with an approved job work order is scoped the same way", async () => {
  const woDb = (inScope: boolean) => {
    const db = scopeDb((a) => ({ data: a.p_job_ids.map((id: string) => ({ job_id: id, in_scope: inScope })), error: null }));
    db.tables.job_budgets = [];
    db.tables.work_order_customer_variations = [];
    db.tables.work_orders = [{ id: BUDGET, org_id: ORG, job_id: JOB_A, kind: "job", status: "approved", agreed_labour_ex: 500 }];
    return db;
  };
  const err: any = await assertRejects(() => guard(woDb(true), 500.01), ApiError);
  assertEquals([err.status, err.body?.code], [409, "work_order_total_over_agreed"]);
  await guard(woDb(true), 500);
  await guard(woDb(false), 5000);
});
