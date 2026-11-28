/**
 * Two owner decisions on the trade invoice (Marnin, 12 Nov 2026), driven
 * through the REAL generate_trade_invoice handler against a PostgREST-shaped
 * fetch stub:
 *
 *   A. A work-order job with an approved job work order. Owner, 28 Nov 2026
 *      (replacing the 12 Nov exact-amount rule ON PURPOSE): the trade types
 *      what they bill this time, more than $0 and up to what is left on the
 *      work order after every trade's billing, in as many bills as it takes.
 *      Over what is left is refused before anything is written
 *      (work_order_amount_over_left), naming the most. Labour lines still
 *      come off it; hourly lines on the job stay allowed.
 *   B. No super on commission: the invoice saved carries super on the gross
 *      less its commission lines, and stores that super base.
 *
 * Every name, number and id below is made up.
 */
// deno-lint-ignore-file no-explicit-any
import "./trade_app_visibility_rules_test_env.ts";
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { _opsApiRequestHandlerForTest } from "./index.ts";

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

// A line already billed on a job by someone (an approved invoice, so it
// counts against the work order). Made-up figures and names.
const billedLine = (id: string, jobId: string, userId: string, type: string, amount: number) => ({
  id: `6c2f0a52-0000-4000-8000-0000000e${id.padStart(4, "0")}`,
  trade_invoice_id: `6c2f0a52-0000-4000-8000-0000000f${id.padStart(4, "0")}`,
  job_id: jobId,
  job_work_order_id: null,
  line_type: type,
  description: `${type} already billed`,
  total_hours: null,
  work_order_hours: null,
  line_total_ex: amount,
  override_amount: null,
  trade_invoices: {
    id: `6c2f0a52-0000-4000-8000-0000000f${id.padStart(4, "0")}`,
    user_id: userId,
    invoice_number: `ZZTEST-${id}`,
    status: "approved",
    invoice_kind: "standard",
    submitted_at: "2026-11-01T00:00:00Z",
    users: { name: userId === TRADE_ID ? "Fixture Trade" : "ZZTEST Helper" },
  },
});

async function submit(
  extra_items: any[],
  world: { failWorkOrders?: boolean; billed?: any[]; failBilled?: boolean } = {},
): Promise<Captured> {
  const writes: string[] = [];
  const invoiceRows: any[] = [];
  const lineRows: any[] = [];
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
      writes.push("RPC " + url.pathname.slice("/rest/v1/rpc/".length));
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
    if (table === "trade_invoice_lines" && method === "GET" && (world.billed || world.failBilled)) {
      if (world.failBilled) return Promise.resolve(Response.json({ code: "XX000", message: "boom" }, { status: 500 }));
      const jobs = filterValues(url, "job_id");
      const select = url.searchParams.get("select") || "";
      // Only the work order's billed read embeds the invoice; other reads
      // of the table see nothing, as before.
      if (!select.includes("trade_invoices!inner")) return reply([]);
      return reply(world.billed!.filter((row) => !jobs || jobs.includes(row.job_id)));
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
    if (table === "trade_rates") return reply([{ hourly_rate: 50, effective_from: "2026-01-01" }]);
    if (table === "trade_invoices") {
      if (method === "POST") {
        invoiceRows.push(...posted());
        return reply([{ id: "6c2f0a52-0000-4000-8000-00000000d001" }]);
      }
      if (method === "PATCH" || method === "DELETE") {
        return reply([{ id: "6c2f0a52-0000-4000-8000-00000000d001" }]);
      }
      return reply([]);
    }
    return reply([]);
  }) as typeof fetch;
  try {
    const url = new URL("https://example.invalid/ops-api");
    url.searchParams.set("action", "generate_trade_invoice");
    const res = await _opsApiRequestHandlerForTest(new Request(url, {
      method: "POST",
      headers: { authorization: "Bearer trade-jwt", "content-type": "application/json" },
      body: JSON.stringify({ week_start: WEEK_START, gst_on: false, extra_items }),
    }));
    const text = await res.text();
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
    return { status: res.status, body: parsed, writes, invoiceRows, lineRows };
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

function assertOverLeft(out: Captured, jobNumber: string, most: string) {
  assertEquals(out.status, 409, JSON.stringify(out.body));
  assertEquals(out.body.code, "work_order_amount_over_left");
  assertEquals(out.body.saved, false);
  assertEquals(
    out.body.userMessage,
    `Job ${jobNumber}: up to ${most} is left on its work order. Bill at most that this time, or ask the office.`,
  );
  assertEquals(out.writes, [], "nothing is written");
}

// ── A. Up to what is left on the work order ─────────────────────────────────

handlerTest("work order: billed at the whole amount, with nothing billed yet, is saved", async () => {
  const out = await submit([woRow(AGREED_JOB, "ZZF-2001", 1850.5)]);
  assertSaved(out);
  const line = out.lineRows.find((l) => l.job_id === AGREED_JOB);
  assertEquals([line?.wo_allocated, line?.line_total_ex], [1850.5, 1850.5]);
});

handlerTest("work order: labour still comes off the amount billed", async () => {
  const out = await submit([woRow(AGREED_JOB, "ZZF-2001", 1850.5, [{ hours: 4, rate: 50 }, { hours: 2, rate: 40 }])]);
  assertSaved(out);
  const line = out.lineRows.find((l) => l.job_id === AGREED_JOB);
  assertEquals([line?.wo_allocated, line?.wo_labour_deduction, line?.line_total_ex], [1850.5, 280, 1570.5]);
});

// Worked example 1: one trade alone, two progress bills.
handlerTest("work order: one trade bills it in two progress bills, each within what is left", async () => {
  const first = await submit([woRow(AGREED_JOB, "ZZF-2001", 1000)]);
  assertSaved(first);
  assertEquals(first.lineRows.find((l) => l.job_id === AGREED_JOB)?.line_total_ex, 1000);
  const already = [billedLine("1", AGREED_JOB, TRADE_ID, "Work Order", 1000)];
  const second = await submit([woRow(AGREED_JOB, "ZZF-2001", 850.5)], { billed: already });
  assertSaved(second);
  assertEquals(second.lineRows.find((l) => l.job_id === AGREED_JOB)?.line_total_ex, 850.5);
  // One cent past what is left is refused, naming the most.
  assertOverLeft(await submit([woRow(AGREED_JOB, "ZZF-2001", 850.51)], { billed: already }), "ZZF-2001", "$850.50");
  // Billed in full: any amount is refused.
  const full = await submit([woRow(AGREED_JOB, "ZZF-2001", 1)], {
    billed: [...already, billedLine("2", AGREED_JOB, TRADE_ID, "Work Order", 850.5)],
  });
  assertEquals(full.status, 409, JSON.stringify(full.body));
  assertEquals(full.body.userMessage, "Job ZZF-2001: its work order has been billed in full. Ask the office if it needs changing.");
  assertEquals(full.writes, []);
});

// Worked example 2: a lead and a helper.
handlerTest("work order: a helper's billing comes off what the lead may bill", async () => {
  const helper = [billedLine("3", AGREED_JOB, OTHER_USER, "Labour", 400)];
  // Left: 1,850.50 less the helper's 400 = 1,450.50.
  const ok = await submit([woRow(AGREED_JOB, "ZZF-2001", 1450.5)], { billed: helper });
  assertSaved(ok);
  assertOverLeft(await submit([woRow(AGREED_JOB, "ZZF-2001", 1850.5)], { billed: helper }), "ZZF-2001", "$1,450.50");
  const refused = await submit([woRow(AGREED_JOB, "ZZF-2001", 1850.5)], { billed: helper });
  assertEquals(refused.body.jobs, [{
    job: "ZZF-2001", job_id: AGREED_JOB, agreed_ex: 1850.5, billed_ex: 1850.5,
    code: "work_order_amount_over_left", most_now_ex: 1450.5,
  }]);
});

handlerTest("work order: nothing typed, $0, a second line on one job, or one bad line among good ones is refused before any write", async () => {
  for (const allocated of [0, -10]) {
    const out = await submit([woRow(AGREED_JOB, "ZZF-2001", allocated)]);
    assertEquals(out.status, 409, JSON.stringify(out.body));
    assertEquals(out.body.code, "work_order_amount_required");
    assertEquals(out.writes, []);
  }
  // Review item 7: a line typed as a work order with no work order amount is
  // checked by what it bills (quantity x rate), never let through or refused
  // for a missing field. Within what is left it is saved.
  assertSaved(await submit([plainLine(AGREED_JOB, "ZZF-2001", "Work Order", 1, 1850.5)]));
  // A small wo_allocated beside a big rate does not hide the bill.
  const hidden = await submit([{ ...plainLine(AGREED_JOB, "ZZF-2001", "Work Order", 1, 5000), wo_allocated: 100 }]);
  assertEquals(hidden.body.code, "work_order_amount_over_left", JSON.stringify(hidden.body));
  assertEquals(hidden.writes, []);
  // Billing the work order on two lines on one invoice is refused.
  const twice = await submit([woRow(AGREED_JOB, "ZZF-2001", 500), woRow(AGREED_JOB, "ZZF-2001", 500)]);
  assertEquals(twice.body.code, "work_order_line_twice", JSON.stringify(twice.body));
  assertEquals(twice.writes, []);
  // One wrong line refuses the whole invoice, good lines included.
  assertOverLeft(
    await submit([plainLine(OPEN_JOB, "ZZF-2002", "Materials", 2, 10), woRow(AGREED_JOB, "ZZF-2001", 1999)]),
    "ZZF-2001",
    "$1,850.50",
  );
});

handlerTest("work order: what is left that cannot be read refuses 503, never guesses", async () => {
  const out = await submit([woRow(AGREED_JOB, "ZZF-2001", 100)], { failBilled: true });
  assertEquals(out.status, 503, JSON.stringify(out.body));
  assertEquals(out.body.code, "work_order_cap_unavailable");
  assertEquals(out.body.saved, false);
  assertEquals(out.writes, []);
});

handlerTest("agreed work order: hourly lines on the job stay allowed (helpers)", async () => {
  const out = await submit([plainLine(AGREED_JOB, "ZZF-2001", "Labour", 6, 50)]);
  assertSaved(out);
});

handlerTest("agreed work order: a job whose work order is not approved keeps the trade's figure", async () => {
  const out = await submit([woRow(OPEN_JOB, "ZZF-2002", 777)]);
  assertSaved(out);
});

handlerTest("agreed work order: an unreadable work order refuses, never guesses", async () => {
  const out = await submit([woRow(AGREED_JOB, "ZZF-2001", 1850.5)], { failWorkOrders: true });
  assertEquals(out.status, 503, JSON.stringify(out.body));
  assertEquals(out.body.code, "invoice_mode_unavailable");
  assertEquals(out.body.saved, false);
  assertEquals(out.writes, []);
});

// ── B. No super on commission ───────────────────────────────────────────────

handlerTest("commission: $1,000 of work and $200 commission saves super 120, withhold 60, net 1,140", async () => {
  const out = await submit([
    plainLine(OPEN_JOB, "ZZF-2002", "Materials", 20, 50),
    { ...plainLine(CREATED_JOB, "ZZM-2003", "Commission", 1, 200), row_type: "commission" },
  ]);
  assertSaved(out);
  const inv = out.invoiceRows[0];
  assertEquals(
    [inv.gross_earned, inv.subtotal_ex, inv.super_base_ex, inv.super_amount, inv.net_pay, inv.gst, inv.total_inc],
    [1200, 1200, 1000, 120, 1140, 0, 1200],
  );
  assertEquals(out.lineRows.find((l) => l.job_id === CREATED_JOB)?.line_type, "commission");
});

handlerTest("commission: an invoice without commission saves exactly as before (no super base)", async () => {
  const out = await submit([plainLine(OPEN_JOB, "ZZF-2002", "Materials", 20, 50)]);
  assertSaved(out);
  const inv = out.invoiceRows[0];
  assertEquals([inv.gross_earned, inv.super_amount, inv.net_pay], [1000, 120, 940]);
  assert(!("super_base_ex" in inv), JSON.stringify(inv));
});
