/**
 * One super rule (P1-01.3), driven through the REAL generate_trade_invoice
 * handler against a PostgREST-shaped fetch stub (harness copied from
 * trade_invoice_agreed_work_order_test.ts):
 *
 *   spec test 7: the pay week decides the rule; a week before the start date
 *                is priced and stored on the old rule, a week on or after on
 *                inclusive_12_112_v1.
 *   spec test 8: an unreadable switch or start date refuses the submit with
 *                503 pay_rule_unreadable and writes no invoice.
 *   cap:         an agreed work order on the new rule bills exactly its total;
 *                super comes out of it, nothing is paid on top, and any other
 *                amount is still refused.
 *
 * Every name, number and id below is made up.
 */
// deno-lint-ignore-file no-explicit-any
import "./trade_app_visibility_rules_test_env.ts";
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { calculateTradeInvoiceMoney } from "./trade_invoice_money.ts";
import { FakeTime } from "https://deno.land/std@0.224.0/testing/time.ts";
import { _opsApiRequestHandlerForTest } from "./index.ts";
import { perthToday } from "./group_work_order.ts";
import { tradePayBasisFor } from "./trade_pay_rule.ts";

const TRADE_ID = "6c2f0a52-0000-4000-8000-00000000aa01";
const OTHER_USER = "6c2f0a52-0000-4000-8000-00000000aa02";
const ORG_ID = "00000000-0000-0000-0000-000000000001";
const AGREED_JOB = "6c2f0a52-0000-4000-8000-00000000b001";
const OPEN_JOB = "6c2f0a52-0000-4000-8000-00000000b002";
const CREATED_JOB = "6c2f0a52-0000-4000-8000-00000000b003";
const JOB_WO = "6c2f0a52-0000-4000-8000-00000000c001";
const WEEK_START = "2026-11-02"; // a Monday

const job = (id: string, job_number: string, over: Record<string, unknown> = {}) => ({
  id,
  org_id: ORG_ID,
  job_number,
  client_name: "Fixture Client",
  type: "fencing",
  status: "scheduled",
  site_address: "1 Fixture St",
  site_suburb: "Testville",
  metadata: {},
  created_by: OTHER_USER,
  ...over,
});

const JOBS = [
  job(AGREED_JOB, "ZZF-2001"),
  job(OPEN_JOB, "ZZF-2002"),
  job(CREATED_JOB, "ZZM-2003", { type: "makesafe", created_by: TRADE_ID }),
];

const ASSIGNMENTS = [
  { id: "c1", job_id: AGREED_JOB, user_id: TRADE_ID, status: "complete", is_ghost: false },
  { id: "c2", job_id: OPEN_JOB, user_id: TRADE_ID, status: "complete", is_ghost: false },
  { id: "c3", job_id: CREATED_JOB, user_id: TRADE_ID, status: "complete", is_ghost: false },
];

const WORK_ORDERS = [
  { id: JOB_WO, org_id: ORG_ID, job_id: AGREED_JOB, kind: "job", status: "approved", agreed_labour_ex: 1850.5 },
  { id: "6c2f0a52-0000-4000-8000-00000000c002", org_id: ORG_ID, job_id: OPEN_JOB, kind: "job", status: "draft", agreed_labour_ex: 500 },
];

type Captured = {
  status: number;
  body: any;
  writes: string[];
  invoiceRows: any[];
  lineRows: any[];
  rpcArgs: Array<{ name: string; args: any }>;
};

function filterValues(url: URL, column: string): string[] | null {
  const raw = url.searchParams.get(column);
  if (raw === null) return null;
  const eq = /^eq\.(.*)$/.exec(raw);
  if (eq) return [eq[1]];
  const inList = /^in\.\((.*)\)$/.exec(raw);
  if (inList) return inList[1].split(",").map((v) => v.replace(/"/g, "").trim());
  return null;
}

type World = {
  historyInvoices?: Record<string, unknown>[];
  failRepaymentRead?: "rules" | "balance";
  failWorkOrders?: boolean;
  payRuleOn?: boolean;
  payRuleFrom?: string | null;
  failPaySettings?: boolean;
  // Present and undefined: the request carries no week (an undated invoice).
  weekStart?: string;
  // The stored draft a save replaces (returned for a draft lookup).
  priorDraft?: Record<string, unknown>;
  action?: string;
  draftId?: string;
  failDraftRead?: boolean;
};

async function submit(extra_items: any[], world: World = {}): Promise<Captured> {
  const writes: string[] = [];
  const invoiceRows: any[] = [];
  const lineRows: any[] = [];
  const rpcArgs: Array<{ name: string; args: any }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = String(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const accept = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get("accept") || "";
    const reply = (rows: any[]) => {
      if (!accept.includes("vnd.pgrst.object")) return Promise.resolve(Response.json(rows));
      if (rows.length === 1) return Promise.resolve(Response.json(rows[0]));
      if (rows.length === 0 && accept.includes("nulls=stripped")) return Promise.resolve(Response.json(null));
      return Promise.resolve(Response.json({ code: "PGRST116", message: "no rows" }, { status: 406 }));
    };
    if (url.pathname.startsWith("/auth/v1/user")) {
      return Promise.resolve(Response.json({ id: TRADE_ID, email: "", aud: "authenticated" }));
    }
    if (url.pathname.startsWith("/rest/v1/rpc/")) {
      const name = url.pathname.slice("/rest/v1/rpc/".length);
      if (name === "trade_repayment_balance" && world.failRepaymentRead === "balance") {
        return Promise.resolve(Response.json({ code: "XX000", message: "ZZTEST balance unavailable" }, { status: 500 }));
      }
      writes.push("RPC " + name);
      rpcArgs.push({ name, args: typeof init?.body === "string" ? JSON.parse(init.body) : null });
      return Promise.resolve(Response.json("6c2f0a52-0000-4000-8000-00000000d001"));
    }
    const table = url.pathname.match(/^\/rest\/v1\/(.+)$/)?.[1] || "";
    if (method !== "GET" && method !== "HEAD") writes.push(`${method} ${table}`);
    const posted = () => {
      const raw = typeof init?.body === "string" ? JSON.parse(init.body) : [];
      return Array.isArray(raw) ? raw : [raw];
    };
    if (table === "trade_invoice_lines" && method === "POST") {
      lineRows.push(...posted());
      return reply([]);
    }
    if (table === "users") {
      return reply([{
        id: TRADE_ID,
        org_id: ORG_ID,
        role: "lead_installer",
        name: "Fixture Trade",
        managed_verticals: [],
        trade_sees_all_jobs: false,
        default_hourly_rate: null,
        xero_contact_id: null,
        invoice_type: "hourly",
        trade_details: {},
        invoice_any_job: null,
      }]);
    }
    if (table === "jobs") {
      const ids = filterValues(url, "id");
      const numbers = filterValues(url, "job_number");
      const orgs = filterValues(url, "org_id");
      return reply(JOBS.filter((row) =>
        (!ids || ids.includes(row.id)) &&
        (!numbers || numbers.includes(row.job_number)) &&
        (!orgs || orgs.includes(row.org_id))
      ));
    }
    if (table === "job_assignments") {
      const users = filterValues(url, "user_id");
      const jobs = filterValues(url, "job_id");
      return reply(ASSIGNMENTS.filter((row) =>
        (!users || users.includes(row.user_id)) && (!jobs || jobs.includes(row.job_id))
      ));
    }
    if (table === "work_orders") {
      if (world.failWorkOrders) {
        return Promise.resolve(Response.json({ code: "XX000", message: "boom" }, { status: 500 }));
      }
      const jobs = filterValues(url, "job_id");
      const kinds = filterValues(url, "kind");
      const statuses = filterValues(url, "status");
      return reply(WORK_ORDERS.filter((row) =>
        (!jobs || jobs.includes(row.job_id)) && (!kinds || kinds.includes(row.kind)) &&
        (!statuses || statuses.includes(row.status))
      ));
    }
    if (table === "trade_recurring_deductions" && world.failRepaymentRead) {
      return world.failRepaymentRead === "rules"
        ? Promise.resolve(Response.json({ code: "XX000", message: "ZZTEST rules unavailable" }, { status: 500 }))
        : reply([{ id: "ZZTEST-rule", kind: "repayment" }]);
    }
    if (table === "trade_rates") return reply([{ hourly_rate: 50, effective_from: "2026-01-01" }]);
    if (table === "feature_flags") {
      const names = filterValues(url, "flag_name");
      if (names?.includes("trade_pay_inclusive_super_v1")) {
        return reply([{ enabled: world.payRuleOn === true }]);
      }
      return reply([]);
    }
    if (table === "trade_pay_settings") {
      if (world.failPaySettings) {
        return Promise.resolve(Response.json({ code: "XX000", message: "boom" }, { status: 500 }));
      }
      return reply([{ inclusive_super_from: world.payRuleFrom ?? null }]);
    }
    if (table === "trade_invoices") {
      if (method === "POST") {
        invoiceRows.push(...posted());
        return reply([{ id: "6c2f0a52-0000-4000-8000-00000000d001" }]);
      }
      if (method === "PATCH" || method === "DELETE") {
        return reply([{ id: "6c2f0a52-0000-4000-8000-00000000d001" }]);
      }
      if (world.historyInvoices) return reply(world.historyInvoices);
      const statuses = filterValues(url, "status");
      const selectedIds = filterValues(url, "id");
      if (world.failDraftRead && selectedIds?.includes(PRIOR_ID)) {
        return Promise.resolve(Response.json({ code: "XX000", message: "draft unreadable" }, { status: 500 }));
      }
      if (world.priorDraft && (statuses?.includes("draft") || selectedIds?.includes(PRIOR_ID))) {
        const columns = (url.searchParams.get("select") || "*").split(",").map((key) => key.trim());
        return reply([Object.fromEntries(Object.entries(world.priorDraft).filter(([key]) => columns.includes("*") || columns.includes(key)))]);
      }
      return reply([]);
    }
    return reply([]);
  }) as typeof fetch;
  try {
    const url = new URL("https://example.invalid/ops-api");
    url.searchParams.set("action", world.action ?? "generate_trade_invoice");
    const res = await _opsApiRequestHandlerForTest(new Request(url, {
      method: "POST",
      headers: { authorization: "Bearer trade-jwt", "content-type": "application/json" },
      body: JSON.stringify({ week_start: "weekStart" in world ? world.weekStart : WEEK_START, draft_id: world.draftId, gst_on: false, extra_items }),
    }));
    const text = await res.text();
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
    return { status: res.status, body: parsed, writes, invoiceRows, lineRows, rpcArgs };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// The Pay tab's work-order row: the work order's amount, the named labour
// that comes off it, and the holder's net as the rate.
const woRow = (jobId: string, jobNumber: string, allocated: number, labour: Array<{ hours: number; rate: number }> = []) => {
  const labourSum = labour.reduce((s, l) => s + l.hours * l.rate, 0);
  return {
    type: "Work Order",
    row_type: "work_order",
    description: "Work order",
    quantity: 1,
    unit: "ea",
    rate: Math.round((allocated - labourSum) * 100) / 100,
    wo_allocated: allocated,
    wo_labour_lines: labour.map((l, i) => ({ trade_name: `Helper ${i + 1}`, ...l })),
    date: "2026-11-03",
    job_id: jobId,
    job_number: jobNumber,
  };
};

const plainLine = (jobId: string, jobNumber: string, type: string, quantity: number, rate: number) => ({
  type,
  description: `${type} on ${jobNumber}`,
  quantity,
  unit: "ea",
  rate,
  date: "2026-11-03",
  job_id: jobId,
  job_number: jobNumber,
});

const handlerTest = (name: string, fn: () => Promise<void>) =>
  Deno.test({ name, fn, sanitizeOps: false, sanitizeResources: false });

function assertSaved(out: Captured) {
  assert(out.status === 200, `status ${out.status}: ${JSON.stringify(out.body)}`);
  assert(out.writes.some((w) => w.includes("trade_invoice")), out.writes.join(", "));
}

// deno-lint-ignore no-unused-vars
function assertNotAgreed(out: Captured, jobNumber: string) {
  assertEquals(out.status, 409, JSON.stringify(out.body));
  assertEquals(out.body.code, "work_order_amount_not_agreed");
  assertEquals(out.body.saved, false);
  assertStringIncludes(out.body.userMessage, `Job ${jobNumber} has an agreed work order of $1,850.50.`);
  assertStringIncludes(out.body.userMessage, "Bill it at that amount, or ask the office.");
  assertEquals(out.writes, [], "nothing is written");
}

// ── spec test 7: the week decides ───────────────────────────────────────────

const ON_FROM = { payRuleOn: true, payRuleFrom: "2026-11-02" }; // WEEK_START, a Monday

handlerTest("pay rule: a week on or after the start date is priced inclusive", async () => {
  const out = await submit([plainLine(OPEN_JOB, "ZZF-2002", "Materials", 20, 56)], ON_FROM);
  assertSaved(out);
  const inv = out.invoiceRows[0];
  assertEquals(out.body.pay_view, {
    basis: "inclusive_12_112_v1", total_inc_super: 1120, paid_to_super: 120,
    paid_to_you: 1000, reimbursements: 0, gst: 0, repayment: null,
    into_bank: 1000, tax_set_aside: null, gst_set_aside: 0,
  });
  assertEquals(
    [inv.super_basis, inv.gross_earned, inv.super_amount, inv.net_pay, inv.gst, inv.total_inc],
    ["inclusive_12_112_v1", 1120, 120, 1000, 0, 1120],
  );
  assert(!("super_base_ex" in inv), JSON.stringify(inv));
});

handlerTest("pay rule: a week before the start date is priced and stored on the old rule", async () => {
  const out = await submit([plainLine(OPEN_JOB, "ZZF-2002", "Materials", 20, 50)], { payRuleOn: true, payRuleFrom: "2026-11-09" });
  assertSaved(out);
  const inv = out.invoiceRows[0];
  assertEquals([inv.gross_earned, inv.super_amount, inv.net_pay], [1000, 120, 940]);
  assert(!inv.super_basis, JSON.stringify(inv));
});

handlerTest("pay rule: switch off, or no start date, prices every week on the old rule", async () => {
  for (const world of [{ payRuleOn: false, payRuleFrom: "2026-11-02" }, { payRuleOn: true, payRuleFrom: null }]) {
    const out = await submit([plainLine(OPEN_JOB, "ZZF-2002", "Materials", 20, 50)], world);
    assertSaved(out);
    const inv = out.invoiceRows[0];
    assertEquals([inv.super_amount, inv.net_pay], [120, 940]);
    assert(!inv.super_basis, JSON.stringify(inv));
  }
});

handlerTest("pay rule: commission is in the base on the new rule", async () => {
  const out = await submit([
    plainLine(OPEN_JOB, "ZZF-2002", "Materials", 10, 56),
    { ...plainLine(CREATED_JOB, "ZZM-2003", "Commission", 1, 560), row_type: "commission" },
  ], ON_FROM);
  assertSaved(out);
  const inv = out.invoiceRows[0];
  assertEquals([inv.super_basis, inv.gross_earned, inv.super_amount, inv.net_pay], ["inclusive_12_112_v1", 1120, 120, 1000]);
  assert(!("super_base_ex" in inv), JSON.stringify(inv));
});

// ── spec test 8: unreadable refuses ─────────────────────────────────────────

handlerTest("pay rule: an unreadable start date refuses the submit and writes no invoice", async () => {
  const out = await submit([plainLine(OPEN_JOB, "ZZF-2002", "Materials", 20, 56)], { payRuleOn: true, failPaySettings: true });
  assertEquals(out.status, 503, JSON.stringify(out.body));
  assertEquals(out.body.code, "pay_rule_unreadable");
  assertEquals(out.body.saved, false);
  assertEquals(out.body.userMessage, "Could not check the pay rule. Nothing was saved. Try again in a minute.");
  assertEquals(out.invoiceRows, []);
  assertEquals(out.lineRows, []);
  assert(!out.writes.some((w) => w.includes("trade_invoice") || w.startsWith("RPC ")), out.writes.join(", "));
});

handlerTest("pay rule: switch off and the start date unreadable still saves on the old rule", async () => {
  const out = await submit([plainLine(OPEN_JOB, "ZZF-2002", "Labour", 20, 50)], { payRuleOn: false, failPaySettings: true });
  assertSaved(out);
  const inv = out.invoiceRows[0];
  assertEquals([inv.gross_earned, inv.super_amount, inv.net_pay], [1000, 120, 940]);
  assert(!inv.super_basis, JSON.stringify(inv));
});

// ── no trade paid above a work order total ──────────────────────────────────

handlerTest("pay rule: an agreed work order on the new rule bills its total, super inside it", async () => {
  const out = await submit([woRow(AGREED_JOB, "ZZF-2001", 1850.5)], ON_FROM);
  assertSaved(out);
  const inv = out.invoiceRows[0];
  // 1,850.50 x 12/112 = 198.267...: super 198.27, paid 1,652.23. Nothing on top.
  assertEquals(
    [inv.super_basis, inv.gross_earned, inv.super_amount, inv.net_pay, inv.total_inc],
    ["inclusive_12_112_v1", 1850.5, 198.27, 1652.23, 1850.5],
  );
  assert(Math.round(inv.net_pay * 100) + Math.round(inv.super_amount * 100) <= 185050);
  // One cent over is caught by the work order cap; any other amount by the
  // agreed-amount check. Either way nothing is saved.
  for (
    const [allocated, code] of [
      [1850.51, "work_order_total_over_agreed"],
      [2000, "work_order_amount_not_agreed"],
    ] as const
  ) {
    const refused = await submit([woRow(AGREED_JOB, "ZZF-2001", allocated)], ON_FROM);
    assertEquals(refused.status, 409, JSON.stringify(refused.body));
    assertEquals(refused.body.code, code);
    assertEquals(refused.invoiceRows, []);
  }
});

// ── a saved invoice keeps the rule it was priced under (money review) ───────
//
// Every door that replaces a stored draft takes the stored basis when the
// draft is priced, and the current rule only for a new or unpriced one. One
// table over the doors that re-save: the ordinary draft save and the weekly
// submit (this harness, the real handler). The running weekly draft runs the
// same rows in trade_invoice_running_draft_test.ts; the work order retry is
// pinned to the same helper below.
//
// 20 x 56 = 1,120. Inclusive: the fund gets 1,120 x 12/112 = 120, the person
// 1,000. Old rule: super 134.40 (12%), the person 1,052.80 (6% withheld).

const PRIOR_ID = "6c2f0a52-0000-4000-8000-00000000e001";
const INCLUSIVE_SPLIT = ["inclusive_12_112_v1", 1120, 120, 1000];
const OLD_SPLIT = [null, 1120, 134.4, 1052.8];

const priorDraft = (superBasis: string | null) => ({
  id: PRIOR_ID,
  status: "draft",
  week_start: WEEK_START,
  xero_bill_id: null,
  xero_pushed_at: null,
  gross_earned: 1120,
  super_basis: superBasis,
  super_base_ex: null,
});

// The invoice header each door saved.
const savedHeader: Record<string, (out: Captured) => any> = {
  save_trade_invoice_draft: (out) =>
    out.rpcArgs.find((call) => call.name === "persist_weekly_trade_invoice_v3")?.args?.p_invoice,
  generate_trade_invoice: (out) => out.invoiceRows[0],
};

const RE_SAVE_CASES = [
  {
    name: "stored inclusive draft, switch off",
    prior: priorDraft("inclusive_12_112_v1"),
    world: { payRuleOn: false, payRuleFrom: WEEK_START },
    expected: INCLUSIVE_SPLIT,
  },
  {
    name: "stored old-rule draft, switch on from its week",
    prior: priorDraft(null),
    world: ON_FROM,
    expected: OLD_SPLIT,
  },
  {
    name: "unpriced stored draft, switch on: the current rule",
    prior: { ...priorDraft(null), gross_earned: null },
    world: ON_FROM,
    expected: INCLUSIVE_SPLIT,
  },
];

for (const action of ["save_trade_invoice_draft", "generate_trade_invoice"]) {
  for (const row of RE_SAVE_CASES) {
    handlerTest(`pay rule: ${action} over a ${row.name}: basis and split as stored`, async () => {
      const out = await submit(
        [plainLine(OPEN_JOB, "ZZF-2002", "Materials", 20, 56)],
        { ...row.world, priorDraft: row.prior, action },
      );
      assert(out.status === 200, `status ${out.status}: ${JSON.stringify(out.body)}`);
      const inv = savedHeader[action](out);
      assert(inv, `no saved header: ${out.writes.join(", ")}`);
      assertEquals(
        [inv.super_basis ?? null, inv.gross_earned, inv.super_amount, inv.net_pay],
        row.expected,
      );
    });
  }
}

handlerTest("pay rule: every save door and the work order retry use the one decision", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  // Nothing in ops-api reads the current rule except through the helper.
  assertEquals(src.match(/resolveTradePayBasis\(/g)?.length, 1);
  assertEquals(src.match(/tradePayBasisForSave\(/g)?.length, 5); // definition + three save doors + switched-on receipt list
  assertStringIncludes(src, "tradePayBasisForSave(client, retryDrafts[0] ?? null, woInvoiceDate)");
  assertStringIncludes(src, "tradePayBasisForSave(client, existingDraft, draftWeekStart || draftWeekEnd)");
  assertStringIncludes(src, "tradePayBasisForSave(client, priorDraft, week_start || weekEnd || perthToday(), paySettingsRead)");
  assert(src.includes("const draftSuperBasis = resolvedShares.length > 0\n              ? null"), "group shares retain their existing draft pricing");
  assertStringIncludes(src, ".select(`id, user_id, status, ${TRADE_PAY_PRIOR_INVOICE_COLUMNS}`)");
});

for (const failRepaymentRead of ["rules", "balance"] as const) {
  handlerTest(`ZZTEST-P1 HOLD: invoice list survives unavailable repayment ${failRepaymentRead}`, async () => {
    const split = calculateTradeInvoiceMoney({
      grossEarned: 1120, gstOn: false, superBasis: "inclusive_12_112_v1", earningsDate: "2026-12-07",
    });
    const invoice = {
      ...split, id: "ZZTEST-invoice", status: "paid", week_start: "2026-12-07", gst: 0,
      subtotal_ex: 1120, recurring_deduction_id: "ZZTEST-rule",
      recurring_deduction_label: "ZZTEST repayment", recurring_deduction_amount: 10,
    };
    const out = await submit([], { action: "my_trade_invoices", historyInvoices: [invoice], failRepaymentRead });
    assertEquals(out.status, 200, JSON.stringify(out.body));
    assertEquals(out.body.invoices.length, 1);
    assertEquals(out.body.invoices[0].id, invoice.id);
    assertEquals(out.body.invoices[0].pay_view.repayment, { label: "ZZTEST repayment", amount: 10 });
    assertEquals(out.body.invoices[0].pay_view.into_bank, 990);
    assertEquals(out.writes, []);
  });
}

// An undated draft's provisional split is not a dated invoice's pay rule.
for (const weekStart of ["2026-11-16", "2026-11-23", "2026-11-30"]) {
  handlerTest(`pay rule: undated draft sent for ${weekStart} takes that date's rule`, async () => {
    const out = await submit([plainLine(OPEN_JOB, "ZZF-2002", "Materials", 20, 56)], {
      payRuleOn: true, payRuleFrom: "2026-11-23", weekStart, draftId: PRIOR_ID,
      priorDraft: { ...priorDraft(null), invoice_source: "hourly", week_start: null, week_end: null },
    });
    assertSaved(out);
    const inv = out.invoiceRows[0];
    assertEquals([inv.super_basis ?? null, inv.gross_earned, inv.super_amount, inv.net_pay],
      weekStart < "2026-11-23" ? OLD_SPLIT : INCLUSIVE_SPLIT);
  });
}

handlerTest("pay rule: office-dated pre-change draft keeps its rule when sent later", async () => {
  const out = await submit([plainLine(OPEN_JOB, "ZZF-2002", "Materials", 20, 56)], {
    payRuleOn: true, payRuleFrom: "2026-11-23", weekStart: "2026-11-23", draftId: PRIOR_ID,
    priorDraft: { ...priorDraft(null), week_start: "2026-11-16", week_end: "2026-11-22" },
  });
  assertSaved(out);
  const inv = out.invoiceRows[0];
  assertEquals([inv.super_basis ?? null, inv.gross_earned, inv.super_amount, inv.net_pay], OLD_SPLIT);
});

handlerTest("pay rule: unreadable selected draft saves nothing; retry reads the undated draft afresh", async () => {
  const world = {
    payRuleOn: true, payRuleFrom: "2026-11-23", weekStart: "2026-11-23", draftId: PRIOR_ID,
    priorDraft: { ...priorDraft(null), invoice_source: "hourly", week_start: null, week_end: null },
  };
  const refused = await submit([plainLine(OPEN_JOB, "ZZF-2002", "Materials", 20, 56)], { ...world, failDraftRead: true });
  assertEquals(refused.status, 500);
  assertEquals(refused.invoiceRows, []);
  assertEquals(refused.lineRows, []);
  assertEquals(refused.writes.filter((write) => write.includes("trade_invoice")), []);
  const retried = await submit([plainLine(OPEN_JOB, "ZZF-2002", "Materials", 20, 56)], world);
  assertSaved(retried);
  assertEquals(retried.invoiceRows[0].super_basis, "inclusive_12_112_v1");
});

handlerTest("pay rule: dating an undated draft with switch off preserves main's stored split", async () => {
  for (const [basis, expected] of [[null, OLD_SPLIT], ["inclusive_12_112_v1", INCLUSIVE_SPLIT]] as const) {
    const out = await submit([plainLine(OPEN_JOB, "ZZF-2002", "Materials", 20, 56)], {
      payRuleOn: false, failPaySettings: true, weekStart: "2026-11-23", draftId: PRIOR_ID,
      priorDraft: { ...priorDraft(basis), invoice_source: "hourly", week_start: null, week_end: null },
    });
    assertSaved(out);
    const inv = out.invoiceRows[0];
    assertEquals([inv.super_basis ?? null, inv.gross_earned, inv.super_amount, inv.net_pay], expected);
  }
});

handlerTest("pay rule: dating an undated draft with unreadable start refuses without replacing it", async () => {
  const out = await submit([plainLine(OPEN_JOB, "ZZF-2002", "Materials", 20, 56)], {
    payRuleOn: true, failPaySettings: true, weekStart: "2026-11-23", draftId: PRIOR_ID,
    priorDraft: { ...priorDraft(null), invoice_source: "hourly", week_start: null, week_end: null },
  });
  assertEquals(out.status, 503);
  assertEquals(out.body.code, "pay_rule_unreadable");
  assertEquals(out.body.saved, false);
  assertEquals(out.invoiceRows, []);
  assertEquals(out.lineRows, []);
  assertEquals(out.writes.filter((write) => write.includes("trade_invoice") || write.startsWith("RPC ")), []);
});

// ── The start day is a Perth day ────────────────────────────────────────────
// The edge clock is UTC: its date is still Sunday until 8am Perth on Monday.
// A pay day with no week of its own is today in Perth, so the rule starts at
// midnight Perth on its start day, never at 8am. Clock injected (FakeTime);
// the start day is a made-up Monday.

const PERTH_START = "2026-11-23";
const PERTH_INSTANTS = [
  { label: "Sun 22 Nov 23:59 Perth", utc: "2026-11-22T15:59:00Z", basis: null },
  { label: "Mon 23 Nov 00:30 Perth", utc: "2026-11-22T16:30:00Z", basis: "inclusive_12_112_v1" },
  { label: "Mon 23 Nov 07:59 Perth", utc: "2026-11-22T23:59:00Z", basis: "inclusive_12_112_v1" },
];

for (const at of PERTH_INSTANTS) {
  handlerTest(`pay day is Perth's: the rule's decision at ${at.label}`, () => {
    using _time = new FakeTime(at.utc);
    assertEquals(perthToday(), at.utc.startsWith("2026-11-22T15") ? "2026-11-22" : "2026-11-23");
    assertEquals(tradePayBasisFor({ on: true, from: PERTH_START }, perthToday()), at.basis);
    // The UTC date was still Sunday at every one of these instants.
    assertEquals(new Date().toISOString().slice(0, 10), "2026-11-22");
    return Promise.resolve();
  });

  for (const action of ["save_trade_invoice_draft", "generate_trade_invoice"]) {
    handlerTest(`pay day is Perth's: an undated ${action} at ${at.label}`, async () => {
      using _time = new FakeTime(at.utc);
      const out = await submit([plainLine(OPEN_JOB, "ZZF-2002", "Materials", 20, 56)], {
        payRuleOn: true, payRuleFrom: PERTH_START, weekStart: undefined, action,
      });
      assert(out.status === 200, `status ${out.status}: ${JSON.stringify(out.body)}`);
      // An undated draft is a plain insert, not the weekly persist RPC.
      const inv = out.invoiceRows[0];
      assert(inv, `no saved header: ${out.writes.join(", ")}`);
      assertEquals(inv.week_start ?? null, null, "an undated invoice");
      assertEquals(inv.super_basis ?? null, at.basis);
    });
  }
}

handlerTest("pay day is Perth's: no pay door reads the UTC date", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assertStringIncludes(src, "const woInvoiceDate = perthToday()");
  assertStringIncludes(src, "lineHoldSendApplies(client, week_start || weekEnd || perthToday(), paySettingsRead, true)");
  assertStringIncludes(src, "tradePayBasisForSave(client, null, perthToday()))");
  assert(/const draftWeekEnd = draftWeekStart\n[^\n]*\n\s*: perthToday\(\)/.test(src), "an undated draft's pay day");
  // No call into the pay rule carries a UTC date.
  for (const call of src.matchAll(/(tradePayBasisForSave|lineHoldSendApplies|resolveTradePayBasisForPreview)\([^\n]*/g)) {
    assert(!call[0].includes("toISOString"), call[0]);
  }
});
