/**
 * office_generate_trade_invoice (office_trade_invoice.ts), driven through the
 * REAL ops-api request handler against a PostgREST-shaped fetch stub (harness
 * from trade_pay_rule_handler_test.ts):
 *
 *  - the office's submit stores byte-identical invoice and line rows to the
 *    trade's own submit of the same body, by a staff session or the server key
 *    naming a staff person, and records one office_submitted event;
 *  - a trade session, a missing reason, an unknown trade, a server key naming
 *    no staff person: refused before any write;
 *  - the trade path's own refusals still apply (work_order_amount_not_agreed).
 *
 * Every name, number and id below is made up.
 */
// deno-lint-ignore-file no-explicit-any
import "./trade_app_visibility_rules_test_env.ts";
import { assert, assertEquals } from "jsr:@std/assert@1";
import { _opsApiRequestHandlerForTest } from "./index.ts";
import {
  officeTradeInvoiceReason,
  resolveOfficeTradeInvoiceRequest,
  stripOfficeTradeInvoiceKeys,
} from "./office_trade_invoice.ts";

const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TRADE_ID = "6c2f0a52-0000-4000-8000-00000000ea01";
const STAFF_ID = "6c2f0a52-0000-4000-8000-00000000ea02";
const OTHER_TRADE = "6c2f0a52-0000-4000-8000-00000000ea03";
const UNKNOWN_ID = "6c2f0a52-0000-4000-8000-00000000ea09";
const ORG_ID = "00000000-0000-0000-0000-000000000001";
const AGREED_JOB = "6c2f0a52-0000-4000-8000-00000000eb01";
const JOB_WO = "6c2f0a52-0000-4000-8000-00000000ec01";
const WEEK_START = "2026-11-02"; // a Monday
const INVOICE_ID = "6c2f0a52-0000-4000-8000-00000000ed01";
const REASON = "ZZTEST the work order was corrected; the trade's invoice is redone";

const PEOPLE: Record<string, any> = {
  [TRADE_ID]: { role: "lead_installer", name: "Fixture Trade" },
  [STAFF_ID]: { role: "ops_manager", name: "Fixture Office" },
  [OTHER_TRADE]: { role: "crew", name: "Other Trade" },
};
const TOKENS: Record<string, string> = {
  "trade-jwt": TRADE_ID,
  "office-jwt": STAFF_ID,
  "other-trade-jwt": OTHER_TRADE,
};

const JOBS = [{
  id: AGREED_JOB,
  org_id: ORG_ID,
  job_number: "ZZF-3001",
  client_name: "Fixture Client",
  type: "fencing",
  status: "in_progress",
  site_address: "1 Fixture St",
  site_suburb: "Testville",
  metadata: {},
  created_by: STAFF_ID,
}];
const ASSIGNMENTS = [
  { id: "a1", job_id: AGREED_JOB, user_id: TRADE_ID, status: "confirmed", is_ghost: false },
];
const WORK_ORDERS = [
  { id: JOB_WO, org_id: ORG_ID, job_id: AGREED_JOB, kind: "job", status: "approved", agreed_labour_ex: 4480 },
];

function filterValues(url: URL, column: string): string[] | null {
  const raw = url.searchParams.get(column);
  if (raw === null) return null;
  const eq = /^eq\.(.*)$/.exec(raw);
  if (eq) return [eq[1]];
  const inList = /^in\.\((.*)\)$/.exec(raw);
  if (inList) return inList[1].split(",").map((v) => v.replace(/"/g, "").trim());
  return null;
}

type Captured = {
  status: number;
  body: any;
  writes: string[];
  invoiceRows: any[];
  lineRows: any[];
  events: any[];
};

let failEvents = false;

async function send(action: string, token: string, body: Record<string, unknown>): Promise<Captured> {
  const writes: string[] = [];
  const invoiceRows: any[] = [];
  const lineRows: any[] = [];
  const events: any[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = String(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const accept = headers.get("accept") || "";
    const reply = (rows: any[]) => {
      if (!accept.includes("vnd.pgrst.object")) return Promise.resolve(Response.json(rows));
      if (rows.length === 1) return Promise.resolve(Response.json(rows[0]));
      if (rows.length === 0 && accept.includes("nulls=stripped")) return Promise.resolve(Response.json(null));
      return Promise.resolve(Response.json({ code: "PGRST116", message: "no rows" }, { status: 406 }));
    };
    if (url.pathname.startsWith("/auth/v1/user")) {
      const bearer = (headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      const id = TOKENS[bearer];
      if (!id) return Promise.resolve(Response.json({ message: "bad jwt" }, { status: 401 }));
      return Promise.resolve(Response.json({ id, email: "", aud: "authenticated" }));
    }
    if (url.pathname.startsWith("/rest/v1/rpc/")) {
      writes.push("RPC " + url.pathname.slice("/rest/v1/rpc/".length));
      return Promise.resolve(Response.json(INVOICE_ID));
    }
    const table = url.pathname.match(/^\/rest\/v1\/(.+)$/)?.[1] || "";
    if (method !== "GET" && method !== "HEAD") writes.push(`${method} ${table}`);
    const posted = () => {
      const raw = typeof init?.body === "string" ? JSON.parse(init.body) : [];
      return Array.isArray(raw) ? raw : [raw];
    };
    if (table === "trade_invoice_events" && method === "POST") {
      events.push(...posted());
      if (failEvents) return Promise.resolve(Response.json({ code: "XX000", message: "ZZTEST down" }, { status: 500 }));
      return reply([]);
    }
    if (table === "trade_invoice_lines" && method === "POST") {
      lineRows.push(...posted());
      return reply([]);
    }
    if (table === "users") {
      const ids = filterValues(url, "id");
      const rows = Object.entries(PEOPLE)
        .filter(([id]) => !ids || ids.includes(id))
        .map(([id, p]) => ({
          id,
          org_id: ORG_ID,
          email: "",
          role: p.role,
          name: p.name,
          managed_verticals: [],
          trade_sees_all_jobs: false,
          default_hourly_rate: null,
          xero_contact_id: null,
          invoice_type: "hourly",
          trade_details: {},
          invoice_any_job: null,
        }));
      return reply(rows);
    }
    if (table === "jobs") {
      const ids = filterValues(url, "id");
      const numbers = filterValues(url, "job_number");
      return reply(JOBS.filter((row) => (!ids || ids.includes(row.id)) && (!numbers || numbers.includes(row.job_number))));
    }
    if (table === "job_assignments") {
      const users = filterValues(url, "user_id");
      const jobs = filterValues(url, "job_id");
      return reply(ASSIGNMENTS.filter((row) => (!users || users.includes(row.user_id)) && (!jobs || jobs.includes(row.job_id))));
    }
    if (table === "work_orders") {
      const jobs = filterValues(url, "job_id");
      const kinds = filterValues(url, "kind");
      const statuses = filterValues(url, "status");
      return reply(WORK_ORDERS.filter((row) =>
        (!jobs || jobs.includes(row.job_id)) && (!kinds || kinds.includes(row.kind)) &&
        (!statuses || statuses.includes(row.status))
      ));
    }
    if (table === "trade_rates") return reply([{ hourly_rate: 50, effective_from: "2026-01-01" }]);
    if (table === "feature_flags") return reply([]);
    if (table === "trade_invoices") {
      if (method === "POST") {
        invoiceRows.push(...posted());
        return reply([{ id: INVOICE_ID }]);
      }
      if (method === "PATCH" || method === "DELETE") return reply([{ id: INVOICE_ID }]);
      return reply([]);
    }
    return reply([]);
  }) as typeof fetch;
  try {
    const url = new URL("https://example.invalid/ops-api");
    url.searchParams.set("action", action);
    const res = await _opsApiRequestHandlerForTest(new Request(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }));
    const text = await res.text();
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
    return { status: res.status, body: parsed, writes, invoiceRows, lineRows, events };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// The Pay tab's work-order row with named labour coming off it.
const woRow = (allocated: number, labour: Array<{ trade_name: string; hours: number; rate: number }>) => {
  const labourSum = labour.reduce((s, l) => s + l.hours * l.rate, 0);
  return {
    type: "work order",
    row_type: "work_order",
    description: "Work order ZZF-3001",
    quantity: 1,
    unit: "ea",
    rate: Math.round((allocated - labourSum) * 100) / 100,
    wo_allocated: allocated,
    wo_labour_lines: labour,
    date: "2026-11-03",
    job_id: AGREED_JOB,
    job_number: "ZZF-3001",
  };
};
const LABOUR = [
  { trade_name: "Helper One", hours: 12, rate: 34 },
  { trade_name: "Helper Two", hours: 20, rate: 28 },
  { trade_name: "Runs", hours: 4, rate: 45 },
];
const tradeBody = (allocated = 4480) => ({
  week_start: WEEK_START,
  gst_on: false,
  extra_items: [woRow(allocated, LABOUR)],
});

const handlerTest = (name: string, fn: () => Promise<void>) =>
  Deno.test({ name, fn, sanitizeOps: false, sanitizeResources: false });

function assertSaved(out: Captured) {
  assert(out.status === 200, `status ${out.status}: ${JSON.stringify(out.body)}`);
  assertEquals(out.invoiceRows.length, 1, out.writes.join(", "));
}

// The clock is the only thing that may differ between two submits.
const CLOCK_KEYS = new Set(["submitted_at", "created_at", "updated_at"]);
function withoutClock(rows: any[]): any[] {
  return rows.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => !CLOCK_KEYS.has(key))));
}

function assertNothingWritten(out: Captured) {
  assertEquals(out.writes, [], "nothing is written");
}

handlerTest("office invoice: a staff session stores exactly what the trade's own submit stores", async () => {
  const trade = await send("generate_trade_invoice", "trade-jwt", tradeBody());
  assertSaved(trade);
  assertEquals(trade.events, [], "a trade's own submit records no office event");
  const office = await send("office_generate_trade_invoice", "office-jwt", {
    ...tradeBody(),
    trade_user_id: TRADE_ID,
    reason: REASON,
  });
  assertSaved(office);
  assertEquals(withoutClock(office.invoiceRows), withoutClock(trade.invoiceRows));
  assertEquals(withoutClock(office.lineRows), withoutClock(trade.lineRows));
  assert(trade.lineRows.length > 0, "the trade's submit wrote lines");
  assertEquals(office.body.invoice_number, trade.body.invoice_number);
  assertEquals(office.invoiceRows[0].user_id, TRADE_ID);
  assertEquals(office.invoiceRows[0].status, trade.invoiceRows[0].status);
  assertEquals(office.events, [{
    trade_invoice_id: INVOICE_ID,
    event_type: "office_submitted",
    actor: `user:${STAFF_ID}`,
    reason: REASON,
    detail: { trade_user_id: TRADE_ID, via: "staff_session" },
  }]);
});

handlerTest("office invoice: the server key naming a staff person stores the same, stamped with that person", async () => {
  const trade = await send("generate_trade_invoice", "trade-jwt", tradeBody());
  const office = await send("office_generate_trade_invoice", SERVICE_KEY, {
    ...tradeBody(),
    trade_user_id: TRADE_ID,
    actor_user_id: STAFF_ID,
    reason: REASON,
  });
  assertSaved(office);
  assertEquals(withoutClock(office.invoiceRows), withoutClock(trade.invoiceRows));
  assertEquals(withoutClock(office.lineRows), withoutClock(trade.lineRows));
  assertEquals(office.events.map((e) => [e.event_type, e.actor, e.detail.via]), [
    ["office_submitted", `user:${STAFF_ID}`, "server_key"],
  ]);
});

handlerTest("office invoice: a redo shaped like the PR's redo body stores the corrected net", async () => {
  // A $4,480 work order less six crew members and 4 hours of runs at $45.
  const labour = [
    { trade_name: "Crew A", hours: 10, rate: 32 },
    { trade_name: "Crew B", hours: 18, rate: 29 },
    { trade_name: "Crew C", hours: 12, rate: 33 },
    { trade_name: "Crew D", hours: 11, rate: 21 },
    { trade_name: "Crew E", hours: 6, rate: 26 },
    { trade_name: "Crew F", hours: 7.5, rate: 24 },
    { trade_name: "Travel and tip runs", hours: 4, rate: 45 },
  ];
  const row = { ...woRow(4480, labour), rate: 2495 };
  const out = await send("office_generate_trade_invoice", SERVICE_KEY, {
    trade_user_id: TRADE_ID,
    actor_user_id: STAFF_ID,
    reason: REASON,
    week_start: WEEK_START,
    gst_on: false,
    extra_items: [row],
  });
  assertSaved(out);
  assertEquals(out.lineRows.length, 1, JSON.stringify(out.lineRows));
  const line = out.lineRows[0];
  assertEquals(
    [line.unit_rate, line.wo_allocated, line.wo_labour_deduction, line.line_total_ex],
    [2495, 4480, 1985, 2495],
  );
  assertEquals(out.invoiceRows[0].subtotal_ex, 2495);
});

handlerTest("office invoice: a failed event write never undoes the saved invoice", async () => {
  failEvents = true;
  try {
    const out = await send("office_generate_trade_invoice", "office-jwt", {
      ...tradeBody(),
      trade_user_id: TRADE_ID,
      reason: REASON,
    });
    assertSaved(out);
    assertEquals(out.events.length, 2, "the write is tried twice");
  } finally {
    failEvents = false;
  }
});

handlerTest("office invoice: a trade's session is refused, for itself or anyone", async () => {
  for (const target of [TRADE_ID, OTHER_TRADE]) {
    const out = await send("office_generate_trade_invoice", "trade-jwt", {
      ...tradeBody(),
      trade_user_id: target,
      reason: REASON,
    });
    assertEquals(out.status, 403, JSON.stringify(out.body));
    assertNothingWritten(out);
  }
});

handlerTest("office invoice: no reason, no trade, an unknown trade or an unnamed actor is refused", async () => {
  const cases: Array<[string, Record<string, unknown>, number, string]> = [
    ["office-jwt", { trade_user_id: TRADE_ID }, 400, "office_reason_required"],
    ["office-jwt", { trade_user_id: TRADE_ID, reason: "  " }, 400, "office_reason_required"],
    ["office-jwt", { reason: REASON }, 400, "office_trade_required"],
    ["office-jwt", { trade_user_id: UNKNOWN_ID, reason: REASON }, 404, "office_trade_not_found"],
    ["office-jwt", { trade_user_id: TRADE_ID, reason: REASON, actor_user_id: OTHER_TRADE }, 403, "office_actor_not_caller"],
    [SERVICE_KEY, { trade_user_id: TRADE_ID, reason: REASON }, 400, "office_actor_required"],
    [SERVICE_KEY, { trade_user_id: TRADE_ID, reason: REASON, actor_user_id: OTHER_TRADE }, 403, "office_actor_not_staff"],
    [SERVICE_KEY, { trade_user_id: TRADE_ID, reason: REASON, actor_user_id: UNKNOWN_ID }, 403, "office_actor_not_staff"],
  ];
  for (const [token, extra, status, code] of cases) {
    const out = await send("office_generate_trade_invoice", token, { ...tradeBody(), ...extra });
    assertEquals([out.status, out.body.code], [status, code], JSON.stringify(extra));
    assertNothingWritten(out);
  }
});

handlerTest("office invoice: the trade's refusals still apply (an amount that is not the agreed work order)", async () => {
  const trade = await send("generate_trade_invoice", "trade-jwt", tradeBody(5100));
  const office = await send("office_generate_trade_invoice", "office-jwt", {
    ...tradeBody(5100),
    trade_user_id: TRADE_ID,
    reason: REASON,
  });
  for (const out of [trade, office]) {
    assertEquals(out.status, 409, JSON.stringify(out.body));
    assertEquals(out.body.code, "work_order_amount_not_agreed");
    assertNothingWritten(out);
  }
  assertEquals(office.body, trade.body);
});

Deno.test("office invoice: the reason rule and the keys taken off the body", async () => {
  assertEquals(officeTradeInvoiceReason("  ok  "), null);
  assertEquals(officeTradeInvoiceReason(" fixed "), "fixed");
  assertEquals(officeTradeInvoiceReason("x".repeat(501)), null);
  assertEquals(officeTradeInvoiceReason(42), null);
  const body: Record<string, unknown> = { trade_user_id: "a", actor_user_id: "b", reason: "c", week_start: WEEK_START };
  stripOfficeTradeInvoiceKeys(body);
  assertEquals(body, { week_start: WEEK_START });
  // The shared browser key (no server secret) is not the server key.
  let refused = "";
  try {
    await resolveOfficeTradeInvoiceRequest({}, { authMode: "api_key", serverSecretPresented: false, sessionUser: null }, {
      trade_user_id: TRADE_ID,
      actor_user_id: STAFF_ID,
      reason: REASON,
    });
  } catch (error) {
    refused = (error as any).code;
  }
  assertEquals(refused, "office_staff_only");
});
