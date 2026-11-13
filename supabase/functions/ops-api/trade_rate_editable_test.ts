// deno-lint-ignore-file no-explicit-any no-import-prefix
// A trade types their hourly rate on a job card of the weekly invoice
// (Marnin, 13 Nov 2026; flag trade_rate_editable_v1, seeded off).
// Contract: docs/trade-open-access-v1.md, and the trade app's
// secureworks-ux trade-app.md "Rate and description".
//
// The trade app posts `rate` on EVERY job card and says in `rate_source`
// whether the trade changed it. Only `client_entered` is a typed rate.
//
//   switch off   the rate on a card is ignored, exactly as before;
//   switch on    a typed rate prices the line, is marked trade-entered, and is
//                held for office review when it is above the limit.
//
// Driven through the REAL request handler against a PostgREST-shaped fetch
// stub, so the line that is saved is the line under test.
import "./trade_app_visibility_rules_test_env.ts";
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { _opsApiRequestHandlerForTest } from "./index.ts";
import { calculateTradeInvoiceMoney } from "./trade_invoice_money.ts";
import {
  type ExtraRateRules,
  jobCardTypedRateHold,
  typedJobCardRate,
} from "./trade_invoice_extra_rate_rule.ts";
import { TRADE_RATE_EDITABLE_FLAG } from "./trade_open_access.ts";

// ── 1. The rules ────────────────────────────────────────────────────────────

Deno.test("typed rate: only a positive number posted as client_entered", () => {
  assertEquals(typedJobCardRate({ rate: 72.5, rate_source: "client_entered" }), 72.5);
  assertEquals(typedJobCardRate({ rate: "65", rate_source: "client_entered" }), 65);
  assertEquals(typedJobCardRate({ rate: 72.456, rate_source: "client_entered" }), 72.46);
  for (
    const card of [
      { rate: 72.5, rate_source: "server_resolved" },
      { rate: 72.5 },
      { rate: 0, rate_source: "client_entered" },
      { rate: -5, rate_source: "client_entered" },
      { rate: "abc", rate_source: "client_entered" },
      { rate: "", rate_source: "client_entered" },
      { rate: null, rate_source: "client_entered" },
      { rate: Infinity, rate_source: "client_entered" },
      { rate: true, rate_source: "client_entered" },
      { rate_source: "client_entered" },
      null,
    ]
  ) {
    assertEquals(typedJobCardRate(card as any), null, JSON.stringify(card));
  }
});

Deno.test("typed rate hold: never at or below the trade's own rate; above it the office limit decides; no office rate is always held", () => {
  const none: ExtraRateRules = { ok: true, rules: [] };
  const labour90: ExtraRateRules = { ok: true, rules: [{ line_type: "labour", max_unit_rate_ex: 90 }] };
  const star60: ExtraRateRules = { ok: true, rules: [{ line_type: "*", max_unit_rate_ex: 60 }] };
  const labour40: ExtraRateRules = { ok: true, rules: [{ line_type: "labour", max_unit_rate_ex: 40 }] };
  const hold = (rate: number, rules: ExtraRateRules, own: number | null) =>
    jobCardTypedRateHold({ rate, rules, tradeHourlyRate: own })?.source ?? null;

  // No office rule: the trade's own rate is the limit.
  assertEquals(hold(45, none, 50), null);
  assertEquals(hold(50, none, 50), null);
  assertEquals(hold(50.01, none, 50), "trade_rate");
  // The office's labour row, else its * row.
  assertEquals(hold(70, labour90, 50), null);
  assertEquals(hold(95, labour90, 50), "office_rule");
  assertEquals(hold(55, star60, 50), null);
  assertEquals(hold(65, star60, 50), "office_default");
  // At or below their own rate is never held, even under a lower office row.
  assertEquals(hold(45, labour40, 50), null);
  assertEquals(hold(55, labour40, 50), "office_rule");
  // The limits could not be read: every changed rate above their own is held.
  assertEquals(hold(55, { ok: false }, 50), "rules_unreadable");
  assertEquals(hold(45, { ok: false }, 50), null);
  // No office rate on file: always held.
  assertEquals(hold(30, none, null), "no_trade_rate");
  assertEquals(hold(30, labour90, null), "no_trade_rate");
  assertEquals(hold(95, labour90, null), "office_rule");
});

// ── 2. Through the request handler ──────────────────────────────────────────

const TRADE_ID = "7d4f0a52-0000-4000-8000-00000000ee01";
const ORG_ID = "00000000-0000-0000-0000-000000000001";
const JOB_A = "7d4f0a52-0000-4000-8000-00000000ee11";
const JOB_B = "7d4f0a52-0000-4000-8000-00000000ee12";
const CARD_A = "7d4f0a52-0000-4000-8000-00000000ee21";
const CARD_A2 = "7d4f0a52-0000-4000-8000-00000000ee22";
const CARD_B = "7d4f0a52-0000-4000-8000-00000000ee23";
const NEW_INVOICE = "7d4f0a52-0000-4000-8000-00000000ee31";
const WEEK_START = "2026-08-24";
const OFFICE_RATE = 50;

const CARDS = [
  { id: CARD_A, job_id: JOB_A, user_id: TRADE_ID, scheduled_date: "2026-08-25", status: "complete", invoiced_in: null },
  { id: CARD_A2, job_id: JOB_A, user_id: TRADE_ID, scheduled_date: "2026-08-26", status: "complete", invoiced_in: null },
  { id: CARD_B, job_id: JOB_B, user_id: TRADE_ID, scheduled_date: "2026-08-26", status: "complete", invoiced_in: null },
];
const JOBS = [
  { id: JOB_A, job_number: "SWR-RATE-1", client_name: "Client A", type: "repair", status: "complete", site_address: "1 First St", site_suburb: "Perth", metadata: {} },
  { id: JOB_B, job_number: "SWR-RATE-2", client_name: "Client B", type: "repair", status: "complete", site_address: "2 Second St", site_suburb: "Perth", metadata: {} },
];

type Stub = {
  flagOn: boolean;
  officeRate?: number | null;
  rules?: Array<{ line_type: string; max_unit_rate_ex: number }>;
};

type Captured = {
  status: number;
  body: any;
  lineRows: any[];
  invoice: any;
  events: any[];
  flagsRead: string[];
  tables: string[];
};

async function callTrade(
  action: string,
  method: "GET" | "POST",
  body: Record<string, unknown> | null,
  stub: Stub,
  params: Record<string, string> = {},
): Promise<Captured> {
  const lineRows: any[] = [];
  const events: any[] = [];
  const flagsRead: string[] = [];
  const tables: string[] = [];
  let invoice: any = null;
  const officeRate = stub.officeRate === undefined ? OFFICE_RATE : stub.officeRate;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const reqMethod = String(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const accept = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get("accept") || "";
    const reply = (rows: any[]) => {
      if (!accept.includes("vnd.pgrst.object")) return Promise.resolve(Response.json(rows));
      if (rows.length === 1) return Promise.resolve(Response.json(rows[0]));
      return Promise.resolve(Response.json({
        code: "PGRST116",
        details: `The result contains ${rows.length} rows`,
        hint: null,
        message: "JSON object requested, multiple (or no) rows returned",
      }, { status: 406 }));
    };
    const payload = () => {
      const raw = init?.body;
      return typeof raw === "string" && raw ? JSON.parse(raw) : raw;
    };
    const idsIn = (column: string): string[] | null => {
      const filter = url.searchParams.get(column) || "";
      const one = /^eq\.(.*)$/.exec(filter);
      if (one) return [one[1]];
      const match = /^in\.\((.*)\)$/.exec(filter);
      return match ? match[1].split(",").map((id) => id.replace(/"/g, "").trim()) : null;
    };
    if (url.pathname.startsWith("/auth/v1/user")) {
      return Promise.resolve(Response.json({ id: TRADE_ID, email: "", aud: "authenticated" }));
    }
    if (/^\/rest\/v1\/rpc\//.test(url.pathname)) return Promise.resolve(Response.json(NEW_INVOICE));
    const table = url.pathname.match(/^\/rest\/v1\/(.+)$/)?.[1] || "";
    if (table) tables.push(table);
    if (table === "users") {
      return reply([{
        id: TRADE_ID,
        org_id: ORG_ID,
        role: "trade",
        name: "Tess Trade",
        managed_verticals: [],
        trade_sees_all_jobs: false,
        default_hourly_rate: null,
        xero_contact_id: null,
        invoice_type: "hourly",
        trade_details: {},
      }]);
    }
    if (table === "feature_flags") {
      const name = (url.searchParams.get("flag_name") || "").replace(/^eq\./, "");
      flagsRead.push(name);
      return reply(name === TRADE_RATE_EDITABLE_FLAG && stub.flagOn ? [{ enabled: true }] : []);
    }
    if (table === "trade_rates") {
      return reply(officeRate ? [{ hourly_rate: officeRate, effective_from: "2026-01-01" }] : []);
    }
    if (table === "trade_invoice_extra_rate_rules") return reply(stub.rules ?? []);
    if (table === "job_assignments" && url.searchParams.has("is_ghost")) {
      const jobIds = idsIn("job_id");
      return reply(JOBS.filter((job) => !jobIds || jobIds.includes(job.id)).map((job) => ({ job_id: job.id })));
    }
    if (table === "job_assignments") {
      const ids = idsIn("id");
      return reply(CARDS.filter((card) => !ids || ids.includes(card.id)));
    }
    if (table === "jobs") {
      const ids = idsIn("id");
      return reply(JOBS.filter((job) => !ids || ids.includes(job.id)));
    }
    if (table === "trade_invoices") {
      if (reqMethod === "POST") {
        invoice = payload();
        return reply([{ id: NEW_INVOICE }]);
      }
      if (reqMethod === "PATCH" || reqMethod === "DELETE") return reply([{ id: NEW_INVOICE }]);
      return reply([]);
    }
    if (table === "trade_invoice_lines") {
      if (reqMethod === "POST") {
        const rows = payload();
        lineRows.push(...(Array.isArray(rows) ? rows : [rows]));
        return reply([]);
      }
      // The office review hold is read back from the saved lines.
      return reply(lineRows.map((row, i) => ({ id: `line-${i}`, ...row })));
    }
    if (table === "trade_invoice_events" && reqMethod === "POST") {
      events.push(payload());
      return reply([]);
    }
    return reply([]);
  }) as typeof fetch;
  try {
    const url = new URL("https://example.invalid/ops-api");
    url.searchParams.set("action", action);
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
    const res = await _opsApiRequestHandlerForTest(
      new Request(url, {
        method,
        headers: { authorization: "Bearer trade-jwt", "content-type": "application/json" },
        body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
      }),
    );
    const text = await res.text();
    let parsed: any = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
    return { status: res.status, body: parsed, lineRows, invoice, events, flagsRead, tables };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const handlerTest = (name: string, fn: () => Promise<void>) =>
  Deno.test({ name, fn, sanitizeOps: false, sanitizeResources: false });

const submit = (cards: any[], stub: Stub) =>
  callTrade("generate_trade_invoice", "POST", { week_start: WEEK_START, gst_on: false, manual_assignments: cards }, stub);

const card = (over: Record<string, unknown> = {}) => ({
  assignment_id: CARD_A,
  hours: 8,
  description: "Repair works",
  rate: OFFICE_RATE,
  rate_source: "server_resolved",
  ...over,
});

const lineOf = (row: any) => ({
  job_id: row.job_id,
  total_hours: row.total_hours,
  hourly_rate: row.hourly_rate,
  line_total_ex: row.line_total_ex,
  office_review_status: row.office_review_status ?? null,
});

handlerTest("my_hours: trade_rate_editable is true only while the switch is on, and absent otherwise", async () => {
  const off = await callTrade("my_hours", "GET", null, { flagOn: false }, { week_ending: "2026-08-30" });
  assertEquals(off.status, 200, JSON.stringify(off.body));
  assertEquals("trade_rate_editable" in off.body, false);
  assertEquals([off.body.rate, off.body.rate_resolved], [OFFICE_RATE, true]);

  const on = await callTrade("my_hours", "GET", null, { flagOn: true }, { week_ending: "2026-08-30" });
  assertEquals(on.status, 200, JSON.stringify(on.body));
  assertEquals(on.body.trade_rate_editable, true);
  // Nothing else in the reply moves with the switch.
  const { trade_rate_editable: _editable, ...rest } = on.body;
  assertEquals(JSON.stringify(rest), JSON.stringify(off.body));
});

handlerTest("switch off: a rate typed on a job card is ignored and the office rate is billed, as before", async () => {
  const out = await submit([card({ rate: 80, rate_source: "client_entered" })], { flagOn: false });
  assertEquals(out.status, 200, JSON.stringify(out.body));
  assertEquals(out.lineRows.map(lineOf), [
    { job_id: JOB_A, total_hours: 8, hourly_rate: OFFICE_RATE, line_total_ex: 400, office_review_status: null },
  ]);
  assertEquals(out.lineRows[0].query_note, "Server-resolved rate from trade_rates.");
  assertEquals(out.invoice.subtotal_ex, 400);
  assertEquals(out.body.office_review, undefined);
  assertEquals(out.events.filter((e) => e.event_type === "extra_rate_held"), []);
});

handlerTest("the switch is read only when a card carries a typed rate", async () => {
  const plain = await submit([card()], { flagOn: true });
  assertEquals(plain.status, 200, JSON.stringify(plain.body));
  assertEquals(plain.flagsRead.includes(TRADE_RATE_EDITABLE_FLAG), false);
  assertEquals(plain.tables.includes("trade_invoice_extra_rate_rules"), false);
  assertEquals(plain.lineRows.map(lineOf)[0].hourly_rate, OFFICE_RATE);
  const typed = await submit([card({ rate: 45, rate_source: "client_entered" })], { flagOn: true });
  assertEquals(typed.flagsRead.filter((f) => f === TRADE_RATE_EDITABLE_FLAG).length, 1, "read once");
});

handlerTest("switch on: a typed rate at or below the trade's own rate prices the line, is marked trade-entered and is not held", async () => {
  const out = await submit([card({ rate: 45, rate_source: "client_entered" })], { flagOn: true });
  assertEquals(out.status, 200, JSON.stringify(out.body));
  assertEquals(out.lineRows.map(lineOf), [
    { job_id: JOB_A, total_hours: 8, hourly_rate: 45, line_total_ex: 360, office_review_status: null },
  ]);
  assertStringIncludes(out.lineRows[0].query_note, "Client-entered rate: $45/hr. Ops must verify before approval.");
  assertEquals(out.body.office_review, undefined, "not held");
  assertEquals(out.events.filter((e) => e.event_type === "extra_rate_held"), []);

  // The money is worked out from the new subtotal by the one money module.
  const money = calculateTradeInvoiceMoney({ grossEarned: 360, gstOn: false, earningsDate: "2026-08-30" });
  assertEquals(out.invoice.subtotal_ex, 360);
  assertEquals(
    [out.invoice.gross_earned, out.invoice.super_amount, out.invoice.net_pay, out.invoice.total_inc],
    [money.gross_earned, money.super_amount, money.net_pay, money.total_inc],
  );
  assertEquals([out.body.gross_earned, out.body.net_pay], [money.gross_earned, money.net_pay]);
});

handlerTest("switch on: a typed rate above the trade's own rate is saved, held for office review, and the invoice stays out of Xero", async () => {
  const out = await submit([card({ rate: 70, rate_source: "client_entered" })], { flagOn: true });
  assertEquals(out.status, 200, JSON.stringify(out.body));
  assertEquals(out.lineRows.map(lineOf), [
    { job_id: JOB_A, total_hours: 8, hourly_rate: 70, line_total_ex: 560, office_review_status: "awaiting" },
  ]);
  assertStringIncludes(out.lineRows[0].query_note, "Client-entered rate: $70/hr.");
  assertStringIncludes(out.lineRows[0].query_note, "Typed rate is above this trade's pay rate. Held for office review.");
  assertEquals(out.invoice.subtotal_ex, 560);
  assertEquals([out.body.success, out.body.office_review, out.body.code], [true, "held", "lines_awaiting_office_review"]);
  assertEquals(out.body.xero_bill_id ?? null, null);
  const held = out.events.filter((e) => e.event_type === "extra_rate_held");
  assertEquals(held.length, 1);
  assertEquals(held[0].detail.cap_source, "trade_rate");
  assertEquals(held[0].detail.job_id, JOB_A);
});

handlerTest("switch on: the office's labour limit decides above the trade's own rate", async () => {
  const rules = [{ line_type: "labour", max_unit_rate_ex: 90 }];
  const within = await submit([card({ rate: 70, rate_source: "client_entered" })], { flagOn: true, rules });
  assertEquals(within.lineRows.map(lineOf)[0], { job_id: JOB_A, total_hours: 8, hourly_rate: 70, line_total_ex: 560, office_review_status: null });
  assertEquals(within.body.office_review, undefined);
  const over = await submit([card({ rate: 95, rate_source: "client_entered" })], { flagOn: true, rules });
  assertEquals(over.lineRows.map(lineOf)[0].office_review_status, "awaiting");
  assertEquals(over.body.office_review, "held");
  assertEquals(over.events.find((e) => e.event_type === "extra_rate_held")?.detail.cap_source, "office_rule");
});

handlerTest("switch on: a rate the trade did not change, or one that is not a positive number, is billed at the office rate", async () => {
  for (
    const over of [
      { rate: 80, rate_source: "server_resolved" },
      { rate: 80 },
      { rate: 0, rate_source: "client_entered" },
      { rate: "abc", rate_source: "client_entered" },
      { rate: -20, rate_source: "client_entered" },
      { rate: OFFICE_RATE, rate_source: "client_entered" },
    ]
  ) {
    const out = await submit([{ assignment_id: CARD_A, hours: 8, description: "Repair works", ...over }], { flagOn: true });
    assertEquals(out.status, 200, JSON.stringify(out.body));
    assertEquals(
      out.lineRows.map(lineOf),
      [{ job_id: JOB_A, total_hours: 8, hourly_rate: OFFICE_RATE, line_total_ex: 400, office_review_status: null }],
      JSON.stringify(over),
    );
    assertEquals(out.lineRows[0].query_note, "Server-resolved rate from trade_rates.", JSON.stringify(over));
  }
});

handlerTest("switch on: two cards on one job at different rates are two lines, each at its own rate", async () => {
  const out = await submit([
    card({ assignment_id: CARD_A, hours: 8, rate: 45, rate_source: "client_entered" }),
    card({ assignment_id: CARD_A2, hours: 4 }),
    card({ assignment_id: CARD_B, hours: 2, rate: 60, rate_source: "client_entered" }),
  ], { flagOn: true });
  assertEquals(out.status, 200, JSON.stringify(out.body));
  assertEquals(
    out.lineRows.map(lineOf).sort((a, b) => a.hourly_rate - b.hourly_rate),
    [
      { job_id: JOB_A, total_hours: 8, hourly_rate: 45, line_total_ex: 360, office_review_status: null },
      { job_id: JOB_A, total_hours: 4, hourly_rate: 50, line_total_ex: 200, office_review_status: null },
      { job_id: JOB_B, total_hours: 2, hourly_rate: 60, line_total_ex: 120, office_review_status: "awaiting" },
    ],
  );
  assertEquals(out.invoice.subtotal_ex, 680);
  assertEquals(out.body.office_review, "held", "one held line holds the invoice");
});

handlerTest("no office rate: switch off refuses RATE_NOT_CONFIGURED; switch on accepts only when every card has a typed rate, and holds it", async () => {
  const typed = [card({ rate: 55, rate_source: "client_entered" })];
  const off = await submit(typed, { flagOn: false, officeRate: null });
  assertEquals([off.status, off.body.code], [422, "RATE_NOT_CONFIGURED"]);
  assertEquals(off.lineRows, []);

  const mixed = await submit([...typed, card({ assignment_id: CARD_B, hours: 2, rate: 0 })], { flagOn: true, officeRate: null });
  assertEquals([mixed.status, mixed.body.code], [422, "RATE_NOT_CONFIGURED"]);
  assertEquals(mixed.lineRows, []);

  const on = await submit(typed, { flagOn: true, officeRate: null });
  assertEquals(on.status, 200, JSON.stringify(on.body));
  assertEquals(on.lineRows.map(lineOf), [
    { job_id: JOB_A, total_hours: 8, hourly_rate: 55, line_total_ex: 440, office_review_status: "awaiting" },
  ]);
  assertEquals(on.body.office_review, "held");
  assertEquals(on.events.find((e) => e.event_type === "extra_rate_held")?.detail.cap_source, "no_trade_rate");
});

handlerTest("a line that says when it was worked keeps its times at a typed rate", async () => {
  const out = await submit([
    card({ rate: 45, rate_source: "client_entered", hours: undefined, work_date: "2026-08-25", start_time: "07:00", finish_time: "15:30", break_minutes: 30 }),
  ], { flagOn: true });
  assertEquals(out.status, 200, JSON.stringify(out.body));
  assert(out.lineRows.length === 1);
  assertEquals(
    [out.lineRows[0].work_date, out.lineRows[0].start_time, out.lineRows[0].finish_time, out.lineRows[0].total_hours, out.lineRows[0].hourly_rate, out.lineRows[0].line_total_ex],
    ["2026-08-25", "07:00", "15:30", 8, 45, 360],
  );
});
