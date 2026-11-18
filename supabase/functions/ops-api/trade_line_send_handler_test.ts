/**
 * P1-05.8 (spec tests 11, 13 and 48 to 52): a send never fails on a work
 * order, cap or commission refusal. Driven through the REAL
 * generate_trade_invoice handler against a PostgREST-shaped fetch stub
 * (harness from trade_pay_rule_handler_test.ts).
 *
 * Every name, number and id below is made up.
 */
// deno-lint-ignore-file no-explicit-any
import "./trade_app_visibility_rules_test_env.ts";
import "./trade_line_send_handler_test_env.ts";
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { _opsApiRequestHandlerForTest } from "./index.ts";

const TRADE_ID = "6c2f0a52-0000-4000-8000-0000000fa001";
const OTHER_USER = "6c2f0a52-0000-4000-8000-0000000fa002";
const ORG_ID = "00000000-0000-0000-0000-000000000001";
const BACKED_JOB = "6c2f0a52-0000-4000-8000-0000000fb001";
const NO_WO_JOB = "6c2f0a52-0000-4000-8000-0000000fb002";
const COMM_JOB = "6c2f0a52-0000-4000-8000-0000000fb003";
const BACKED_WO = "6c2f0a52-0000-4000-8000-0000000fc001";
const WEEK_START = "2026-11-16"; // a Monday

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
  job(BACKED_JOB, "ZZF-5001"),
  job(NO_WO_JOB, "ZZF-5002"),
  job(COMM_JOB, "ZZF-5003", { created_by: TRADE_ID }),
  job("6c2f0a52-0000-4000-8000-0000000fb004", "ZZM-5004", { type: "miscellaneous" }),
  job("6c2f0a52-0000-4000-8000-0000000fb005", "ZZM-5005", { type: "miscellaneous" }),
];
const MISC_JOB = JOBS[3].id;
const MISC_JOB_2 = JOBS[4].id;

type World = {
  lineHold?: boolean;
  agreed?: number;
  billedBefore?: number;
  commission?: Record<string, unknown> | null;
  guardFailures?: number;
  raiseFails?: boolean;
  facts503?: boolean;
  // The crew work-order door (submit_work_order_invoice).
  crewWo?: Record<string, unknown>;
  // The job whose job work order is approved at `agreed` (default the backed job).
  agreedJob?: string;
  // trade_week_autofill_v1 (main's P1-16.3), on together with the hold switch.
  autofill?: boolean;
  // A weekly work-order send (work_order_blocks) of these crew work orders.
  weeklyWo?: Record<string, unknown> | Array<Record<string, unknown>>;
};

type Captured = {
  status: number;
  body: any;
  invoices: Array<{ id: string; row: any }>;
  lines: Array<{ invoiceId: string; row: any }>;
  raises: any[];
  guardHits: number;
  xero: Array<{ method: string; path: string; body: string | null }>;
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

async function send(extra_items: any[], world: World = {}): Promise<Captured> {
  const invoices: Captured["invoices"] = [];
  const lines: Captured["lines"] = [];
  const raises: any[] = [];
  const xero: Captured["xero"] = [];
  let guardLeft = world.guardFailures ?? 0;
  let guardHits = 0;
  let nextInvoice = 0;
  let nextLine = 0;
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
    const fail = () => Promise.resolve(Response.json({ code: "XX000", message: "ZZTEST unreadable" }, { status: 500 }));
    // Xero is answered here so a test sees exactly what Xero would receive.
    if (url.hostname.endsWith("xero.com")) {
      xero.push({ method, path: url.pathname + url.search, body: typeof init?.body === "string" ? init.body : null });
      if (url.pathname.includes("/Attachments")) return Promise.resolve(Response.json({ Attachments: [{ AttachmentID: "zz-att" }] }));
      if (url.pathname.includes("Contacts")) return Promise.resolve(Response.json({ Contacts: [{ ContactID: "zz-contact", Name: "Fixture Trade" }] }));
      if (method === "PUT" || method === "POST") {
        const sent = typeof init?.body === "string" ? JSON.parse(init.body) : {};
        const list = Array.isArray(sent.Invoices) ? sent.Invoices : [sent];
        return Promise.resolve(Response.json({
          Invoices: list.map((inv: any) => ({
            ...inv,
            InvoiceID: "zz-bill",
            InvoiceNumber: "ZZ-1",
            Status: "DRAFT",
            LineItems: (inv.LineItems || []).map((li: any, i: number) => ({ ...li, LineItemID: `zz-li-${i}`, LineAmount: Math.round(Number(li.Quantity) * Number(li.UnitAmount) * 100) / 100 })),
          })),
        }));
      }
      return Promise.resolve(Response.json({ Invoices: [] }));
    }
    if (url.pathname === "/rest/v1/xero_tokens") {
      const row = { org_id: ORG_ID, access_token: "zz", tenant_id: "zz", expires_at: "2099-01-01T00:00:00Z" };
      return Promise.resolve(Response.json(accept.includes("vnd.pgrst.object") ? row : [row]));
    }
    if (url.pathname === "/rest/v1/org_config") {
      if (method === "GET") return Promise.resolve(accept.includes("vnd.pgrst.object") ? Response.json(null) : Response.json([]));
      const raw = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      const row = Array.isArray(raw) ? raw[0] : raw;
      return Promise.resolve(Response.json(accept.includes("vnd.pgrst.object") ? { config_value: row.config_value } : [{ config_value: row.config_value }]));
    }
    if (url.pathname.startsWith("/auth/v1/user")) {
      return Promise.resolve(Response.json({ id: TRADE_ID, email: "", aud: "authenticated" }));
    }
    if (url.pathname.startsWith("/rest/v1/rpc/")) {
      const name = url.pathname.slice("/rest/v1/rpc/".length);
      if (name === "reconcile_item_raise_named") {
        raises.push(typeof init?.body === "string" ? JSON.parse(init.body) : null);
        if (world.raiseFails) return fail();
        return Promise.resolve(Response.json("6c2f0a52-0000-4000-8000-0000000fd999"));
      }
      if (name === "trade_is_off_job_crew") return Promise.resolve(Response.json(false));
      if (name === "persist_trade_work_order_invoice_v1" || name.startsWith("persist_weekly_trade_invoice_v")) {
        const args = typeof init?.body === "string" ? JSON.parse(init.body) : {};
        const id = `6c2f0a52-0000-4000-8000-0000000fe${String(++nextInvoice).padStart(3, "0")}`;
        invoices.push({ id, row: args.p_invoice });
        for (const row of args.p_lines || []) lines.push({ invoiceId: id, row });
        return Promise.resolve(Response.json(id));
      }
      return Promise.resolve(Response.json(null));
    }
    const table = url.pathname.match(/^\/rest\/v1\/(.+)$/)?.[1] || "";
    const posted = () => {
      const raw = typeof init?.body === "string" ? JSON.parse(init.body) : [];
      return Array.isArray(raw) ? raw : [raw];
    };
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
      return reply(JOBS.filter((row) => (!ids || ids.includes(row.id)) && (!numbers || numbers.includes(row.job_number))));
    }
    if (table === "job_assignments" && method === "GET") {
      const jobs = filterValues(url, "job_id");
      return reply(JOBS.map((j, i) => ({ id: `zz-asg-${i}`, job_id: j.id, user_id: TRADE_ID, status: "complete", is_ghost: false, invoiced_in: null }))
        .filter((row) => !jobs || jobs.includes(row.job_id)));
    }
    if (table === "work_orders" && world.crewWo && filterValues(url, "id")?.includes(String(world.crewWo.id))) {
      return reply([world.crewWo]);
    }
    const weeklyWos = world.weeklyWo ? [world.weeklyWo].flat() : [];
    if (table === "work_orders" && weeklyWos.length > 0 && filterValues(url, "id")?.some((id) => weeklyWos.some((wo) => wo.id === id))) {
      const ids = filterValues(url, "id")!;
      return reply(weeklyWos.filter((wo) => ids.includes(String(wo.id))));
    }
    if (table === "work_orders") {
      const jobs = filterValues(url, "job_id");
      const rows = world.agreed === undefined ? [] : [{
        id: BACKED_WO, org_id: ORG_ID, job_id: world.agreedJob ?? BACKED_JOB, kind: "job", status: "approved", agreed_labour_ex: world.agreed,
      }];
      return reply(rows.filter((row) => !jobs || jobs.includes(row.job_id)));
    }
    if (table === "v_job_commission") {
      return reply(world.commission ? [{ job_id: COMM_JOB, ...world.commission }] : []);
    }
    if (table === "trade_rates") {
      if (world.facts503) return fail();
      return reply([{ id: "zz-rate", hourly_rate: 50, effective_from: "2026-01-01", effective_to: null }]);
    }
    if (table === "feature_flags") {
      const names = filterValues(url, "flag_name") || [];
      return reply(names.map((name) => ({
        flag_name: name,
        enabled: name === "trade_pay_inclusive_super_v1" || (name === "trade_line_hold_v1" && world.lineHold === true) ||
          (name === "trade_week_autofill_v1" && world.autofill === true),
      })));
    }
    if (table === "trade_pay_settings") return reply([{ inclusive_super_from: WEEK_START }]);
    if (table === "trade_invoice_lines") {
      if (method === "POST") {
        const rows = posted();
        const guarded = rows.find((row) => !row.hold_reason && row.job_id === BACKED_JOB);
        if (guarded && guardLeft > 0) {
          guardLeft--;
          guardHits++;
          return Promise.resolve(Response.json(
            { code: "23514", message: "job_amount_guard", details: BACKED_JOB },
            { status: 400 },
          ));
        }
        const invoiceId = String(rows[0]?.trade_invoice_id ?? "");
        const saved = rows.map((row) => ({ ...row, id: `zz-line-${++nextLine}` }));
        for (const row of saved) lines.push({ invoiceId, row });
        return reply(saved.map((row) => ({ id: row.id, line_position: row.line_position })));
      }
      if (method === "GET" && world.billedBefore) {
        const jobs = filterValues(url, "job_id");
        if (jobs?.includes(BACKED_JOB)) {
          return reply([{
            id: "zz-billed", job_id: BACKED_JOB, line_type: "labour", line_total_ex: world.billedBefore, override_amount: null,
            trade_invoices: { status: "pushed_to_xero", invoice_kind: "standard" },
          }]);
        }
      }
      return reply([]);
    }
    if (table === "trade_invoices") {
      if (method === "POST") {
        const rows = posted();
        const saved = rows.map((row) => ({ ...row, id: `6c2f0a52-0000-4000-8000-0000000fe${String(++nextInvoice).padStart(3, "0")}` }));
        for (const row of saved) invoices.push({ id: row.id, row });
        return reply(saved.map((row) => ({ id: row.id })));
      }
      if (method === "PATCH" || method === "DELETE") {
        const ids = filterValues(url, "id");
        return reply((ids || []).map((id) => ({ id })));
      }
      return reply([]);
    }
    return reply([]);
  }) as typeof fetch;
  try {
    const url = new URL("https://example.invalid/ops-api");
    url.searchParams.set("action", world.crewWo ? "submit_work_order_invoice" : "generate_trade_invoice");
    const res = await _opsApiRequestHandlerForTest(new Request(url, {
      method: "POST",
      headers: { authorization: "Bearer trade-jwt", "content-type": "application/json" },
      body: JSON.stringify(world.crewWo
        ? { work_order_id: world.crewWo.id, gst_on: false, extra_items }
        : world.weeklyWo
        ? { week_start: WEEK_START, gst_on: false, work_order_blocks: [world.weeklyWo].flat().map((wo) => ({ work_order_id: wo.id })) }
        : { week_start: WEEK_START, gst_on: false, extra_items }),
    }));
    const text = await res.text();
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
    return { status: res.status, body, invoices, lines, raises, guardHits, xero };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const line = (jobId: string | null, jobNumber: string | null, type: string, quantity: number, rate: number, extra: Record<string, unknown> = {}) => ({
  type,
  description: `${type} ZZTEST`,
  quantity,
  unit: type === "Labour" ? "hrs" : "ea",
  rate,
  date: "2026-11-17",
  job_id: jobId,
  job_number: jobNumber,
  ...extra,
});

const CREW_WO = (over: Record<string, unknown> = {}) => ({
  id: "6c2f0a52-0000-4000-8000-0000000fc777",
  org_id: ORG_ID,
  job_id: MISC_JOB,
  wo_number: "ZZWO-1",
  kind: "crew",
  status: "complete",
  completed_at: "2026-11-18T00:00:00Z",
  scheduled_date: "2026-11-17",
  site_address: "1 Fixture St",
  assigned_user_id: TRADE_ID,
  scope_items: [{ item: "Fence panels", qty: 10, rate: 30 }],
  jobs: JOBS[3],
  ...over,
});

const handlerTest = (name: string, fn: () => Promise<void>) =>
  Deno.test({ name, fn, sanitizeOps: false, sanitizeResources: false });

const kind = (inv: { row: any }) => inv.row.invoice_kind ?? "standard";
const linesOf = (out: Captured, invoiceId: string) => out.lines.filter((l) => l.invoiceId === invoiceId).map((l) => l.row);

handlerTest("line hold 11: one backed job and one job with no work order save two invoices", async () => {
  const out = await send([
    line(BACKED_JOB, "ZZF-5001", "Materials", 4, 50),
    line(NO_WO_JOB, "ZZF-5002", "Materials", 6, 50),
  ], { lineHold: true, agreed: 4000 });
  assertEquals(out.status, 200, JSON.stringify(out.body));
  assertEquals(out.invoices.map(kind), ["standard", "held"]);
  const [standard, holding] = out.invoices;
  assertEquals(standard.row.subtotal_ex, 200, "the standard invoice is priced on the backed line only");
  assertEquals(linesOf(out, standard.id).map((l) => l.job_id), [BACKED_JOB]);
  const held = linesOf(out, holding.id);
  assertEquals(held.map((l) => [l.job_id, l.hold_reason, l.line_total_ex]), [[NO_WO_JOB, "no_work_order", 300]]);
  assertEquals(holding.row.follows_invoice_id, standard.id);
  assertEquals(holding.row.send_id, out.body.send.send_id);
  // trade_send_totals: what was sent equals pay plus the office's part.
  assertEquals(out.body.send, { send_id: out.body.send.send_id, sent_ex: 500, in_pay_ex: 200, held_ex: 300, declined_ex: 0 });
  assertEquals(out.body.held_invoice_id, holding.id);
  assertStringIncludes(out.body.send_words, "$200.00 is in this week's pay. $300.00 is with the office.");
});

handlerTest("line hold 13: every line held saves only the holding invoice and still answers Sent", async () => {
  const out = await send([line(NO_WO_JOB, "ZZF-5002", "Materials", 6, 50)], { lineHold: true });
  assertEquals(out.status, 200, JSON.stringify(out.body));
  assertEquals(out.invoices.map(kind), ["held"]);
  assertEquals(out.body.invoice_id, null);
  assertEquals(out.invoices[0].row.follows_invoice_id, null);
  assertStringIncludes(out.body.send_words, "Sent.");
  assertEquals(out.body.send.in_pay_ex, 0);
  assertEquals(out.body.send.held_ex, 300);
});

handlerTest("line hold 48: one pay_line_held raise per held line and one invoice_no_work_order for the job", async () => {
  const out = await send([
    line(NO_WO_JOB, "ZZF-5002", "Materials", 2, 50),
    line(NO_WO_JOB, "ZZF-5002", "Travel", 1, 30),
  ], { lineHold: true });
  assertEquals(out.status, 200, JSON.stringify(out.body));
  const held = out.raises.filter((r) => r.p_kind === "pay_line_held");
  assertEquals(held.length, 2);
  for (const raise of held) {
    assertEquals(raise.p_evidence.reason, "no_work_order");
    assertEquals(raise.p_job_ids, [NO_WO_JOB]);
    assertEquals(raise.p_raised_by, "phase1:work_order_gate");
  }
  const job = out.raises.filter((r) => r.p_kind === "invoice_no_work_order");
  assertEquals(job.map((r) => [r.p_subject_table, r.p_subject_id, r.p_evidence.amount_ex]), [["jobs", NO_WO_JOB, 130]]);
});

handlerTest("line hold 49: an over-the-amount line carries the four figures", async () => {
  const out = await send([line(BACKED_JOB, "ZZF-5001", "Labour", 16, 50)], { lineHold: true, agreed: 4000, billedBefore: 3600 });
  assertEquals(out.status, 200, JSON.stringify(out.body));
  const [standard, holding] = out.invoices;
  assertEquals(linesOf(out, standard.id).map((l) => l.line_total_ex), [400]);
  assertEquals(linesOf(out, holding.id).map((l) => [l.hold_reason, l.line_total_ex]), [["over_amount", 400]]);
  const raise = out.raises.find((r) => r.p_kind === "pay_line_held");
  assertEquals(
    [raise.p_evidence.work_order_amount_ex, raise.p_evidence.claimed_so_far_ex, raise.p_evidence.line_amount_ex, raise.p_evidence.over_by_ex],
    [4000, 3600, 800, 400],
  );
  assertEquals(out.raises.filter((r) => r.p_kind === "invoice_no_work_order").length, 0);
});

handlerTest("line hold 50: a raise that throws does not fail the send", async () => {
  const out = await send([line(NO_WO_JOB, "ZZF-5002", "Materials", 6, 50)], { lineHold: true, raiseFails: true });
  assertEquals(out.status, 200, JSON.stringify(out.body));
  assert(out.raises.length >= 1);
  assertEquals(out.invoices.map(kind), ["held"]);
});

handlerTest("line hold 51: a guard error leads to one retry, then the job's line is held", async () => {
  const out = await send([
    line(BACKED_JOB, "ZZF-5001", "Materials", 4, 50),
    line(COMM_JOB, "ZZF-5003", "Travel", 1, 30),
  ], { lineHold: true, agreed: 4000, guardFailures: 2 });
  assertEquals(out.status, 200, JSON.stringify(out.body));
  assertEquals(out.guardHits, 2);
  const held = out.lines.filter((l) => l.row.hold_reason).map((l) => [l.row.job_id, l.row.hold_reason]);
  assert(held.some(([jobId, reason]) => jobId === BACKED_JOB && reason === "over_amount"), JSON.stringify(held));
});

handlerTest("line hold 51b: one guard error is retried and the line is paid", async () => {
  const out = await send([line(BACKED_JOB, "ZZF-5001", "Materials", 4, 50)], { lineHold: true, agreed: 4000, guardFailures: 1 });
  assertEquals(out.status, 200, JSON.stringify(out.body));
  assertEquals(out.guardHits, 1);
  // The refused attempt's invoice was deleted by the replace; a second one was saved.
  assertEquals(out.invoices.map(kind), ["standard", "standard"]);
  assertEquals(out.lines.map((l) => [l.invoiceId, l.row.job_id]), [[out.invoices[1].id, BACKED_JOB]]);
  assertEquals(out.body.send.held_ex, 0);
});

handlerTest("line hold 52: commission with no figure is held at 0.00 and the rest is sent", async () => {
  const out = await send([
    line(BACKED_JOB, "ZZF-5001", "Materials", 4, 50),
    { ...line(COMM_JOB, "ZZF-5003", "Commission", 1, 500), row_type: "commission" },
  ], { lineHold: true, agreed: 4000 });
  assertEquals(out.status, 200, JSON.stringify(out.body));
  const held = out.lines.filter((l) => l.row.hold_reason);
  assertEquals(held.map((l) => [l.row.hold_reason, l.row.line_total_ex]), [["commission_no_figure", 0]]);
  assertEquals(out.body.send.in_pay_ex, 200);
});

handlerTest("line hold 52b: commission from someone who is not the salesperson is skipped and the rest is sent", async () => {
  const out = await send([
    line(BACKED_JOB, "ZZF-5001", "Materials", 4, 50),
    { ...line(COMM_JOB, "ZZF-5003", "Commission", 1, 500), row_type: "commission" },
  ], {
    lineHold: true,
    agreed: 4000,
    commission: {
      commission_id: "zz-c", budget_id: "zz-b", version: 1, state: "named", salesperson_user_id: OTHER_USER,
      rule_id: "zz-r", percent: 10, expected_amount_ex_gst: 500, claimed_ex_gst: 0, remaining_ex_gst: 500,
    },
  });
  assertEquals(out.status, 200, JSON.stringify(out.body));
  assertEquals(out.body.skipped_items.map((s: any) => s.code), ["commission_not_salesperson"]);
  assertEquals(out.invoices.map(kind), ["standard"]);
  assertEquals(out.body.send.in_pay_ex, 200);
});

handlerTest("line hold: unreadable facts refuse with nothing saved", async () => {
  const out = await send([line(NO_WO_JOB, "ZZF-5002", "Materials", 6, 50)], { lineHold: true, facts503: true });
  assertEquals(out.status, 503, JSON.stringify(out.body));
  assertEquals(out.body.code, "line_hold_unreadable");
  assertEquals(out.invoices, []);
});

handlerTest("line hold switch off: a line over the job's amount is refused as today, nothing saved, no hold fields", async () => {
  const out = await send([line(BACKED_JOB, "ZZF-5001", "Labour", 16, 50)], { lineHold: false, agreed: 4000, billedBefore: 3600 });
  assert(out.status >= 400, JSON.stringify(out.body));
  assertEquals(out.invoices, []);
  assertEquals(out.raises, []);
  assert(!("send" in out.body) && !("held_lines" in out.body), JSON.stringify(out.body));
});

handlerTest("line hold switch off: a backed send answers exactly as today", async () => {
  const out = await send([line(BACKED_JOB, "ZZF-5001", "Materials", 4, 50)], { lineHold: false, agreed: 4000 });
  assertEquals(out.status, 200, JSON.stringify(out.body));
  assertEquals(out.invoices.length, 1);
  for (const key of ["send", "held_lines", "send_words", "held_invoice_id", "left_out"]) {
    assert(!(key in out.body), key);
  }
  assert(!("invoice_kind" in out.invoices[0].row) && !("send_id" in out.invoices[0].row));
  for (const l of out.lines) assert(!("hold_reason" in l.row) && !("sent_amount_ex" in l.row), JSON.stringify(l.row));
});

async function officeAction(action: string, invoice: Record<string, unknown>) {
  const writes: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = String(init?.method ?? "GET").toUpperCase();
    const accept = new Headers(init?.headers).get("accept") || "";
    const table = url.pathname.match(/^\/rest\/v1\/(.+)$/)?.[1] || "";
    if (method !== "GET" && method !== "HEAD") writes.push(`${method} ${table}`);
    const rows = table === "trade_invoices" ? [invoice] : [];
    if (accept.includes("vnd.pgrst.object")) return Promise.resolve(Response.json(rows[0] ?? null));
    return Promise.resolve(Response.json(rows));
  }) as typeof fetch;
  try {
    const url = new URL("https://example.invalid/ops-api");
    url.searchParams.set("action", action);
    const res = await _opsApiRequestHandlerForTest(new Request(url, {
      method: "POST",
      headers: { authorization: "Bearer test-service-role-key", "content-type": "application/json" },
      body: JSON.stringify({ invoice_id: invoice.id }),
    }));
    return { status: res.status, body: await res.json(), writes };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const HOLDING = { id: "6c2f0a52-0000-4000-8000-0000000fe777", status: "pending_ops_review", invoice_kind: "held", xero_bill_id: null, user: { id: TRADE_ID, name: "Fixture Trade" } };

handlerTest("line hold: pushing the holding invoice to Xero is refused before any write", async () => {
  const out = await officeAction("push_trade_invoice_to_xero", HOLDING);
  assertEquals(out.status, 409, JSON.stringify(out.body));
  assertEquals(out.body.code, "holding_invoice_not_pushed");
  assertEquals(out.writes, []);
});

handlerTest("line hold: approving the holding invoice for pay is refused before any write", async () => {
  const out = await officeAction("approve_trade_invoice", HOLDING);
  assertEquals(out.status, 409, JSON.stringify(out.body));
  assertEquals(out.body.code, "holding_invoice_not_pushed");
  assertEquals(out.writes, []);
});


handlerTest("work-order door, switch off: saves as today with no hold fields", async () => {
  const out = await send([], { lineHold: false, crewWo: CREW_WO() });
  assertEquals(out.status, 200, JSON.stringify(out.body));
  assertEquals(out.invoices.length, 1);
  assert(!("hold_lines" in out.invoices[0].row), JSON.stringify(out.invoices[0].row));
  for (const key of ["send", "held_lines", "send_words", "held_invoice_id"]) assert(!(key in out.body), key);
  assert(out.xero.some((x) => x.method === "PUT" && x.path.endsWith("/Invoices")), "the bill reaches Xero");
});

handlerTest("work-order door, switch on: a job with no work order holds every line and answers Sent", async () => {
  const out = await send([], { lineHold: true, crewWo: CREW_WO() });
  assertEquals(out.status, 200, JSON.stringify(out.body));
  assertEquals(out.invoices.map(kind), ["held"]);
  // The fixture's job is invoiced by the hour, so its reason is the hourly one.
  assertEquals(out.lines.map((l) => [l.row.hold_reason, l.row.line_total_ex]), [["hourly_no_maximum", 300]]);
  assertEquals(out.xero, [], "a holding invoice never reaches Xero");
  assertStringIncludes(out.body.send_words, "Sent.");
});

handlerTest("work-order door, switch on: a scope line over the job's amount is held whole, never split", async () => {
  const out = await send([], { lineHold: true, crewWo: CREW_WO(), agreed: 100, agreedJob: MISC_JOB });
  assertEquals(out.status, 200, JSON.stringify(out.body));
  assertEquals(out.invoices.map(kind), ["held"]);
  assertEquals(out.lines.map((l) => [l.row.hold_reason, l.row.line_total_ex, l.row.split_group_id ?? null]), [["over_amount", 300, null]]);
});

handlerTest("work-order door, switch on: a backed work order is paid, its Xero bill unchanged from switch off", async () => {
  const off = await send([], { lineHold: false, crewWo: CREW_WO(), agreed: 4000, agreedJob: MISC_JOB });
  const on = await send([], { lineHold: true, crewWo: CREW_WO(), agreed: 4000, agreedJob: MISC_JOB });
  assertEquals(on.status, 200, JSON.stringify(on.body));
  assertEquals(on.invoices.map(kind), ["standard"]);
  const bill = (out: Captured) => out.xero.filter((x) => x.method === "PUT").map((x) => JSON.parse(x.body || "{}"));
  assertEquals(bill(on), bill(off));
  assertEquals(on.body.send.held_ex, 0);
});

handlerTest("hold 1590: a mixed work-order send (200 backed, 300 held) bills and files the backed lines only", async () => {
  const wo = CREW_WO({ scope_items: [{ item: "Fence panels", qty: 1, rate: 200 }, { item: "Gate", qty: 1, rate: 300 }] });
  const out = await send([], { lineHold: true, crewWo: wo, agreed: 200, agreedJob: MISC_JOB });
  assertEquals(out.status, 200, JSON.stringify(out.body));
  assertEquals(out.invoices.map(kind), ["standard", "held"]);
  const [standard, holding] = out.invoices;
  assertEquals(standard.row.subtotal_ex, 200);
  assertEquals(linesOf(out, holding.id).map((l) => [l.hold_reason, l.line_total_ex]), [["over_amount", 300]]);
  const puts = out.xero.filter((x) => x.method === "PUT" && x.path.endsWith("/Invoices"));
  assertEquals(puts.length, 1, "one bill");
  const gross = JSON.parse(puts[0].body || "{}").Invoices[0].LineItems
    .filter((li: any) => Number(li.UnitAmount) > 0)
    .reduce((sum: number, li: any) => sum + Number(li.Quantity) * Number(li.UnitAmount), 0);
  assertEquals(Math.round(gross * 100) / 100, 200, "Xero gets the backed line only");
  // The audit PDF is built from the same backed lines, so it files instead of
  // failing after Xero has created the bill.
  assert(out.xero.some((x) => x.path.includes("/Attachments")), "the audit PDF reaches the bill");
  assertEquals(out.body.pdf_attached, true, JSON.stringify(out.body));
  assertEquals([out.body.send.in_pay_ex, out.body.send.held_ex], [200, 300]);
});

handlerTest("line hold: an extra line with no job number is still refused at entry, as today", async () => {
  // Input checks are not work order, cap or commission refusals (spec step 2:
  // "build the lines as today"); nothing is saved and nothing is raised.
  const out = await send([line(BACKED_JOB, "ZZF-5001", "Materials", 4, 50), line(null, null, "Travel", 1, 30)], { lineHold: true, agreed: 4000 });
  assertEquals(out.status, 422, JSON.stringify(out.body));
  assertEquals(out.invoices, []);
  assertEquals(out.raises, []);
});

// Both switches on: main's autofill save (trade_week_autofill_v1) with the hold.
handlerTest("hold and autofill both on: a plain week still splits into pay and the office", async () => {
  const out = await send([
    line(BACKED_JOB, "ZZF-5001", "Materials", 4, 50),
    line(NO_WO_JOB, "ZZF-5002", "Materials", 6, 50),
  ], { lineHold: true, autofill: true, agreed: 4000 });
  assertEquals(out.status, 200, JSON.stringify(out.body));
  const standard = out.invoices.filter((i) => (i.row.invoice_kind ?? "standard") === "standard");
  const held = out.invoices.filter((i) => i.row.invoice_kind === "held");
  assertEquals([standard.length, held.length], [1, 1]);
  assertEquals(out.lines.filter((l) => l.invoiceId === standard[0].id).map((l) => Number(l.row.line_total_ex)), [200]);
  assertEquals(out.lines.filter((l) => l.row.hold_reason).map((l) => [l.row.hold_reason, Number(l.row.line_total_ex)]), [["no_work_order", 300]]);
  assertEquals([out.body.send.in_pay_ex, out.body.send.held_ex], [200, 300]);
});

for (const autofill of [false, true]) {
  handlerTest(`weekly work-order send, autofill ${autofill ? "on" : "off"}: a backed block is saved through the weekly persist`, async () => {
    const out = await send([], { lineHold: true, autofill, weeklyWo: CREW_WO(), agreed: 4000, agreedJob: MISC_JOB });
    assertEquals(out.status, 200, JSON.stringify(out.body));
    assertEquals(out.invoices.map((i) => i.row.invoice_kind ?? "standard"), ["standard"]);
    assertEquals(out.lines.filter((l) => l.row.hold_reason).length, 0);
  });
  handlerTest(`weekly work-order send, autofill ${autofill ? "on" : "off"}: a block over the amount goes to the office and the send answers Sent`, async () => {
    const out = await send([], { lineHold: true, autofill, weeklyWo: CREW_WO(), agreed: 100, agreedJob: MISC_JOB });
    assertEquals(out.status, 200, JSON.stringify(out.body));
    assertEquals(out.lines.filter((l) => l.row.hold_reason).map((l) => l.row.hold_reason).length > 0, true);
    assertEquals(out.body.send.sent_ex, roundSent(out.body.send.in_pay_ex + out.body.send.held_ex));
  });
}
const roundSent = (n: number) => Math.round(n * 100) / 100;

for (const autofill of [false, true]) {
  handlerTest(`weekly work-order send, autofill ${autofill ? "on" : "off"}: one block paid, one held, the persist checks both as sent`, async () => {
    const second = CREW_WO({ id: "6c2f0a52-0000-4000-8000-0000000fc778", wo_number: "ZZWO-2", job_id: MISC_JOB_2, jobs: JOBS[4] });
    const out = await send([], { lineHold: true, autofill, weeklyWo: [CREW_WO(), second], agreed: 4000, agreedJob: MISC_JOB });
    assertEquals(out.status, 200, JSON.stringify(out.body));
    const standard = out.invoices.filter((i) => (i.row.invoice_kind ?? "standard") === "standard");
    const held = out.invoices.filter((i) => i.row.invoice_kind === "held");
    assertEquals([standard.length, held.length], [1, 1]);
    // The standard save carries the held line so its source checks see the week as sent.
    assertEquals(standard[0].row.hold_lines.map((l: any) => [l.hold_reason, l.job_id, Number(l.line_total_ex)]), [["hourly_no_maximum", MISC_JOB_2, 300]]);
    assertEquals(out.lines.filter((l) => l.invoiceId === standard[0].id).map((l) => [l.row.job_id, l.row.line_position]), [[MISC_JOB, 0]]);
    assertEquals(out.lines.filter((l) => l.row.hold_reason).map((l) => [l.row.hold_reason, l.row.job_id]), [["hourly_no_maximum", MISC_JOB_2]]);
    assertEquals([out.body.send.in_pay_ex, out.body.send.held_ex, out.body.send.sent_ex], [300, 300, 600]);
  });
}
