// deno-lint-ignore-file no-explicit-any no-import-prefix require-await
// Ruling 17 step 4: how the crew is paid comes from the job budget, and a job
// paid hourly up to a maximum holds every trade to it
// (docs/job-budget-v1.md, "Labour: pay mode and the hourly cap (step 4)").
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  budgetAgreedLabour,
  budgetLabourPay,
  JOB_LABOUR_BUDGET_FLAG,
  JOB_LABOUR_CAP_EXCEEDED,
  JOB_LABOUR_CAP_UNREADABLE,
  jobLabourCapAction,
  jobLabourCapRefusal,
  JobLabourPayReadError,
  raiseJobLabourCapAction,
  readHourlyCappedJobs,
} from "./job_labour_cap.ts";
import { decideTradeInvoiceMode, loadTradeInvoiceJobModes, TradeInvoiceModeReadError } from "./trade_invoice_mode.ts";
import { tradeInvoiceRefusal } from "./trade_invoice_refusal.ts";

const ORG = "00000000-0000-0000-0000-000000000001";
const JOB_A = "11111111-1111-4111-8111-11111111111a";
const JOB_B = "11111111-1111-4111-8111-11111111111b";
const BUDGET = "22222222-2222-4222-8222-222222222222";
const TRADE = "33333333-3333-4333-8333-333333333333";
const APPROVER = "44444444-4444-4444-8444-444444444444";

// A small PostgREST stand-in: eq / in / order / limit / maybeSingle, a table
// that can be made to fail, and an rpc hook.
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
  maybeSingle() {
    this.one = true;
    return this;
  }
  then(res: any, rej: any) {
    return this.run().then(res, rej);
  }
  private async run() {
    this.db.reads.push(this.table);
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
  reads: string[] = [];
  rpcs: Array<{ fn: string; args: any }> = [];
  rpcAnswer: { data: any; error: any } = { data: null, error: null };
  constructor(public tables: Record<string, any[]>) {}
  from(t: string) {
    return new Q(this, t);
  }
  rpc(fn: string, args: any) {
    this.rpcs.push({ fn, args });
    return Promise.resolve(this.rpcAnswer);
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

Deno.test("pay read: an unreadable budget throws, never reads as no cap; an unreadable switch is off", async () => {
  const broken = new Fake({ feature_flags: switchOn, job_budgets: [] });
  broken.fail.add("job_budgets");
  await assertRejects(() => readHourlyCappedJobs(broken, [JOB_A]), JobLabourPayReadError);
  const noSwitch = new Fake({ job_budgets: [payRow(JOB_A, 1, "hourly_capped")] });
  noSwitch.fail.add("feature_flags");
  assertEquals((await readHourlyCappedJobs(noSwitch, [JOB_A])).size, 0);
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

Deno.test("refusal: the cap is a 409 with no figure, on the trade doors and anywhere else", () => {
  const raw = { message: `job_labour_cap_exceeded`, code: "23514", details: JOB_A };
  const r = jobLabourCapRefusal(raw);
  assertEquals(r?.status, 409);
  assertEquals(r?.code, JOB_LABOUR_CAP_EXCEEDED);
  assert(!/\d/.test(String(r?.message)));
  const trade = tradeInvoiceRefusal(new Error("Failed to persist weekly/hourly draft invoice: job_labour_cap_exceeded"));
  assertEquals([trade.status, trade.body.code], [409, JOB_LABOUR_CAP_EXCEEDED]);
  assertEquals(jobLabourCapRefusal(new Error("something else")), null);
});

Deno.test("refusal: an unreadable cap is its own 409, never read as no cap", () => {
  const r = jobLabourCapRefusal({ message: "job_labour_cap_unreadable", code: "23514", details: JOB_A });
  assertEquals([r?.status, r?.code], [409, JOB_LABOUR_CAP_UNREADABLE]);
  assert(!/\d/.test(String(r?.message)));
  const trade = tradeInvoiceRefusal(new Error("Failed to persist weekly/hourly draft invoice: job_labour_cap_unreadable"));
  assertEquals([trade.status, trade.body.code], [409, JOB_LABOUR_CAP_UNREADABLE]);
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
    });
    assertEquals([out.status, out.body.code], [status, code], message);
  }
});

Deno.test("doors: the read is staff in the job's company; the raise needs a signed-in person", async () => {
  const db = new Fake({ jobs: [{ id: JOB_A, org_id: ORG }] });
  db.rpcAnswer = { data: { state: "capped", cap_ex_gst: 1 }, error: null };
  const staff = { staff: true, signedIn: true, orgId: ORG, userId: APPROVER, email: null };
  assertEquals((await jobLabourCapAction(db, "job_labour_cap", "GET", { job_id: JOB_A }, { ...staff, staff: false })).status, 403);
  assertEquals((await jobLabourCapAction(db, "job_labour_cap", "GET", { job_id: JOB_A }, { ...staff, orgId: "00000000-0000-0000-0000-000000000009" })).status, 404);
  const read = await jobLabourCapAction(db, "job_labour_cap", "GET", { job_id: JOB_A }, staff);
  assertEquals([read.status, (read.body.cap as any).state], [200, "capped"]);
  const key = await jobLabourCapAction(db, "raise_job_labour_cap", "POST", { job_id: JOB_A }, { ...staff, signedIn: false, userId: null });
  assertEquals([key.status, key.body.code], [403, "named_person_required"]);
  assertEquals((await jobLabourCapAction(db, "raise_job_labour_cap", "GET", {}, staff)).status, 405);
});
