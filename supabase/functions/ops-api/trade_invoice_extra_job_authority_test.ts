/**
 * Who may bill a job on an ordinary extra line of their own trade invoice
 * (trade_invoice_extra_job_authority.ts).
 *
 * Driven through the REAL request handler against a PostgREST-shaped fetch
 * stub that honours the company, user and job filters, so a read that drops
 * its company filter, or a lane that stops calling the check, fails here.
 * Every name, number and id below is made up.
 */
// deno-lint-ignore-file no-explicit-any no-import-prefix
import "./trade_app_visibility_rules_test_env.ts";
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { _opsApiRequestHandlerForTest } from "./index.ts";
import {
  EXTRA_JOB_BILLING_RULES,
  extraJobBillingRule,
} from "./trade_invoice_extra_job_authority.ts";

const TRADE_ID = "5e1f0a52-0000-4000-8000-00000000aa01";
const OTHER_USER = "5e1f0a52-0000-4000-8000-00000000aa02";
const ORG_ID = "00000000-0000-0000-0000-000000000001";
const OTHER_ORG = "00000000-0000-0000-0000-000000000099";
const BOOKED = "5e1f0a52-0000-4000-8000-00000000b001";
const NOT_BOOKED = "5e1f0a52-0000-4000-8000-00000000b002";
const CREATED = "5e1f0a52-0000-4000-8000-00000000b003";
const MAKESAFE = "5e1f0a52-0000-4000-8000-00000000b004";
const FOREIGN = "5e1f0a52-0000-4000-8000-00000000b005";
const TWIN_A = "5e1f0a52-0000-4000-8000-00000000b006";
const TWIN_B = "5e1f0a52-0000-4000-8000-00000000b007";
const CANCELLED_CARD_JOB = "5e1f0a52-0000-4000-8000-00000000b008";
const GHOST_JOB = "5e1f0a52-0000-4000-8000-00000000b009";
const WEEK_START = "2026-08-24"; // a Monday

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
  job(BOOKED, "ZZF-1001"),
  job(NOT_BOOKED, "ZZF-1002"),
  job(CREATED, "ZZF-1003", { created_by: TRADE_ID }),
  job(MAKESAFE, "ZZMS-1004", { type: "makesafe" }),
  job(FOREIGN, "ZZF-1005", { org_id: OTHER_ORG }),
  job(TWIN_A, "ZZF-TWIN"),
  job(TWIN_B, "ZZF-TWIN"),
  job(CANCELLED_CARD_JOB, "ZZF-1008"),
  job(GHOST_JOB, "ZZF-1009"),
];

const ASSIGNMENTS = [
  { id: "c1", job_id: BOOKED, user_id: TRADE_ID, status: "complete", is_ghost: false },
  { id: "c2", job_id: NOT_BOOKED, user_id: OTHER_USER, status: "complete", is_ghost: false },
  { id: "c3", job_id: CANCELLED_CARD_JOB, user_id: TRADE_ID, status: "cancelled", is_ghost: false },
  { id: "c4", job_id: GHOST_JOB, user_id: TRADE_ID, status: null, is_ghost: true },
];

type World = {
  invoiceAnyJob?: unknown;
  managedVerticals?: string[];
  externalRefs?: Array<{ job_id: string; external_ref: string }>;
};

type Captured = { status: number; body: any; writes: string[]; reads: string[]; lineRows: any[] };

function filterValues(url: URL, column: string): string[] | null {
  const raw = url.searchParams.get(column);
  if (raw === null) return null;
  const eq = /^eq\.(.*)$/.exec(raw);
  if (eq) return [eq[1]];
  const inList = /^in\.\((.*)\)$/.exec(raw);
  if (inList) return inList[1].split(",").map((v) => v.replace(/"/g, "").trim());
  return null;
}

async function submit(extra_items: any[], world: World = {}, body: Record<string, unknown> = {}): Promise<Captured> {
  const writes: string[] = [];
  const reads: string[] = [];
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
      return Promise.resolve(Response.json("5e1f0a52-0000-4000-8000-00000000d001"));
    }
    const table = url.pathname.match(/^\/rest\/v1\/(.+)$/)?.[1] || "";
    // The record a refused or failed submit leaves (trade_invoice_events,
    // submit_refused) is not an invoice write: `writes` stays what it was.
    if (table === "trade_invoice_events" && method === "POST") return reply([]);
    if (method !== "GET" && method !== "HEAD") writes.push(`${method} ${table}`);
    if (table === "trade_invoice_lines" && method === "POST") {
      const raw = typeof init?.body === "string" ? JSON.parse(init.body) : [];
      lineRows.push(...(Array.isArray(raw) ? raw : [raw]));
      return reply([]);
    }
    else reads.push(`${table}?${url.searchParams.toString()}`);
    if (table === "users") {
      return reply([{
        id: TRADE_ID,
        org_id: ORG_ID,
        role: "lead_installer",
        name: "Fixture Trade",
        managed_verticals: world.managedVerticals ?? [],
        trade_sees_all_jobs: false,
        default_hourly_rate: null,
        xero_contact_id: null,
        trade_details: { invoiceAnyJob: world.invoiceAnyJob },
        invoice_any_job: world.invoiceAnyJob ?? null,
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
      const ids = filterValues(url, "id");
      const ghost = url.searchParams.get("is_ghost");
      const live = (url.searchParams.get("or") || "").includes("status.neq.cancelled");
      return reply(ASSIGNMENTS.filter((row) =>
        (!users || users.includes(row.user_id)) &&
        (!jobs || jobs.includes(row.job_id)) &&
        (!ids || ids.includes(row.id)) &&
        (ghost !== "eq.false" || row.is_ghost === false) &&
        (!live || row.status === null || row.status !== "cancelled")
      ));
    }
    if (table === "makesafe_job_details") return reply(world.externalRefs ?? []);
    if (table === "trade_rates") return reply([{ hourly_rate: 50, effective_from: "2026-01-01" }]);
    if (table === "trade_invoices") {
      if (method === "POST" || method === "PATCH" || method === "DELETE") {
        return reply([{ id: "5e1f0a52-0000-4000-8000-00000000d001" }]);
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
      body: JSON.stringify({ week_start: WEEK_START, gst_on: false, extra_items, ...body }),
    }));
    const text = await res.text();
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
    return { status: res.status, body: parsed, writes, reads, lineRows };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const line = (ref: { job_id?: string; job_number?: string }, type = "Materials") => ({
  type,
  description: "Fixture work",
  quantity: 2,
  unit: "ea",
  rate: 10,
  date: "2026-08-25",
  ...ref,
});

const handlerTest = (name: string, fn: () => Promise<void>) =>
  Deno.test({ name, fn, sanitizeOps: false, sanitizeResources: false });

function assertRefused(out: Captured, code: string, jobRef: string) {
  assertEquals(out.status, 403, JSON.stringify(out.body));
  assertEquals(out.body.code, code);
  assertEquals(out.body.saved, false);
  assertStringIncludes(out.body.userMessage, jobRef);
  assertStringIncludes(out.body.userMessage.toLowerCase(), "ask the office to add you");
  assertEquals(out.writes, [], "nothing is written");
}

function assertAccepted(out: Captured) {
  assert(out.status === 200, `status ${out.status}: ${JSON.stringify(out.body)}`);
  assert(out.writes.some((w) => w.includes("trade_invoice")), out.writes.join(", "));
}

// ── The rules ───────────────────────────────────────────────────────────────

Deno.test("extra job rules: four named rules, in order", () => {
  assertEquals(EXTRA_JOB_BILLING_RULES.map((rule) => rule.name), [
    "booked_on_job",
    "commission_on_job_they_created",
    "manages_job_division",
    "invoice_any_job_grant",
  ]);
  const trade = { id: TRADE_ID, orgId: ORG_ID, managedVerticals: [], isMakesafeManager: false, invoiceAnyJob: false };
  const base = { id: NOT_BOOKED, createdBy: OTHER_USER, vertical: "fencing", bookedOn: false };
  assertEquals(extraJobBillingRule({ lineType: "labour", job: base, trade }), null);
  assertEquals(extraJobBillingRule({ lineType: "labour", job: { ...base, bookedOn: true }, trade }), "booked_on_job");
  assertEquals(extraJobBillingRule({ lineType: "commission", job: { ...base, createdBy: TRADE_ID }, trade }), "commission_on_job_they_created");
  // A job they created allows a commission line only.
  assertEquals(extraJobBillingRule({ lineType: "labour", job: { ...base, createdBy: TRADE_ID }, trade }), null);
  assertEquals(extraJobBillingRule({ lineType: "commission", job: { ...base, createdBy: null }, trade: { ...trade, id: "" } }), null);
  assertEquals(extraJobBillingRule({ lineType: "labour", job: base, trade: { ...trade, managedVerticals: ["fencing"] } }), "manages_job_division");
  assertEquals(extraJobBillingRule({ lineType: "labour", job: { ...base, vertical: "makesafe" }, trade: { ...trade, isMakesafeManager: true } }), "manages_job_division");
  assertEquals(extraJobBillingRule({ lineType: "labour", job: base, trade: { ...trade, isMakesafeManager: true } }), null);
  assertEquals(extraJobBillingRule({ lineType: "labour", job: base, trade: { ...trade, invoiceAnyJob: true } }), "invoice_any_job_grant");
});

// ── Through the real handler ────────────────────────────────────────────────

for (const grant of [undefined, false, "true", 1]) {
  handlerTest(`extra job: grant ${JSON.stringify(grant)} and a job they are not booked on is refused before any write`, async () => {
    const out = await submit([line({ job_id: NOT_BOOKED, job_number: "ZZF-1002" })], { invoiceAnyJob: grant });
    assertRefused(out, "extra_job_not_allowed", "ZZF-1002");
    assertEquals(out.body.jobs, ["ZZF-1002"]);
  });
}

handlerTest("extra job: a job they are booked on is accepted", async () => {
  assertAccepted(await submit([line({ job_id: BOOKED, job_number: "ZZF-1001" })]));
  // By job number alone too.
  assertAccepted(await submit([line({ job_number: "ZZF-1001" })]));
});

handlerTest("extra job: a cancelled card or a ghost watcher row is not a booking", async () => {
  assertRefused(await submit([line({ job_id: CANCELLED_CARD_JOB })]), "extra_job_not_allowed", "ZZF-1008");
  assertRefused(await submit([line({ job_id: GHOST_JOB })]), "extra_job_not_allowed", "ZZF-1009");
});

handlerTest("extra job: commission on a job they created is accepted; other lines on it are not", async () => {
  assertAccepted(await submit([line({ job_id: CREATED }, "Commission")]));
  assertRefused(await submit([line({ job_id: CREATED }, "Labour")]), "extra_job_not_allowed", "ZZF-1003");
  // Commission on a job somebody else created, not booked: refused.
  assertRefused(await submit([line({ job_id: NOT_BOOKED }, "Commission")]), "extra_job_not_allowed", "ZZF-1002");
});

handlerTest("extra job: a job in a division they manage is accepted", async () => {
  assertAccepted(await submit([line({ job_id: NOT_BOOKED })], { managedVerticals: ["fencing"] }));
  assertAccepted(await submit([line({ job_id: MAKESAFE })], { managedVerticals: ["makesafe"] }));
  // A make-safe manager does not manage a fencing job.
  assertRefused(await submit([line({ job_id: NOT_BOOKED })], { managedVerticals: ["makesafe"] }), "extra_job_not_allowed", "ZZF-1002");
});

handlerTest("extra job: the invoice-any-job grant (literal true) allows any job in their company", async () => {
  assertAccepted(await submit([
    line({ job_id: NOT_BOOKED }),
    line({ job_id: MAKESAFE }),
    line({ job_id: CREATED }, "Labour"),
  ], { invoiceAnyJob: true }));
});

handlerTest("extra job: another company's job is refused by id, number and external reference, even with the grant", async () => {
  for (const ref of [{ job_id: FOREIGN }, { job_number: "ZZF-1005" }]) {
    const out = await submit([line(ref)], { invoiceAnyJob: true });
    assertRefused(out, "extra_job_not_found", ref.job_id || ref.job_number!);
  }
  const viaRef = await submit([line({ job_number: "ZZB55501" })], {
    invoiceAnyJob: true,
    externalRefs: [{ job_id: FOREIGN, external_ref: "ZZB-55501" }],
  });
  assertRefused(viaRef, "extra_job_not_found", "ZZB55501");
  // Every jobs read that looked up the line's job was the caller's company
  // only: by number, and by id after the external reference matched.
  const jobReads = viaRef.reads.filter((r) =>
    r.startsWith("jobs?") && (r.includes("job_number=") || r.includes(FOREIGN))
  );
  assert(jobReads.some((r) => r.includes(FOREIGN)), "the external reference matched");
  for (const read of jobReads) assertStringIncludes(read, `org_id=eq.${ORG_ID}`);
});

handlerTest("extra job: a job number that matches two jobs is refused, never guessed", async () => {
  const out = await submit([line({ job_number: "ZZF-TWIN" })], { invoiceAnyJob: true });
  assertRefused(out, "extra_job_not_found", "ZZF-TWIN");
});

handlerTest("extra job: an unknown job is refused before any write", async () => {
  assertRefused(await submit([line({ job_number: "ZZF-NOPE" })], { invoiceAnyJob: true }), "extra_job_not_found", "ZZF-NOPE");
});

handlerTest("extra job: one refused line refuses the whole batch", async () => {
  const out = await submit([
    line({ job_id: BOOKED }),
    line({ job_id: CREATED }, "Commission"),
    line({ job_id: NOT_BOOKED }),
  ]);
  assertRefused(out, "extra_job_not_allowed", "ZZF-1002");
  assertEquals(out.body.jobs, ["ZZF-1002"]);
});

handlerTest("extra job: a line that names no job is not a job claim and is not checked", async () => {
  // No week: a one-off invoice with a jobless adjustment line.
  const out = await submit([line({}, "Adjustment")], {}, { week_start: undefined });
  assertAccepted(out);
  assert(!out.reads.some((r) => r.startsWith("job_assignments?") && r.includes("is_ghost")));
});

handlerTest("extra job: an invoice of only their own job cards never runs the extra-job check", async () => {
  const out = await submit([], {}, { manual_assignments: [{ assignment_id: "c1", hours: 2 }] });
  assert(!out.reads.some((r) => r.startsWith("users?") && r.includes("invoice_any_job")));
  assert(!out.reads.some((r) => r.startsWith("job_assignments?") && r.includes("is_ghost")));
});

// ── One line type, one set of job references (review F1, F2) ────────────────

handlerTest("extra job: a client line_type with no type never grants the commission rule", async () => {
  // Direct request: line_type says commission, type is absent. The line
  // would be saved as "other", so it is checked as "other" and refused.
  const raw = { job_id: CREATED, line_type: "commission", description: "Fixture work", quantity: 1, rate: 10, date: "2026-08-25" };
  assertRefused(await submit([raw]), "extra_job_not_allowed", "ZZF-1003");
});

handlerTest("extra job: a padded commission type is checked and saved as the same commission", async () => {
  const out = await submit([line({ job_id: CREATED }, " Commission ")]);
  assertAccepted(out);
  assertEquals(out.lineRows.map((row) => row.line_type), ["commission"]);
  // Padded, on a job they did not create: refused, not read as something else.
  assertRefused(await submit([line({ job_id: NOT_BOOKED }, " Commission ")]), "extra_job_not_allowed", "ZZF-1002");
});

handlerTest("extra job: a whitespace job number on a no-week ordinary line is refused, nothing written", async () => {
  for (const job_number of [" ", "   ", "\t"]) {
    const out = await submit(
      [{ type: "Materials", job_number, description: "Fixture materials", quantity: 1, rate: 10, date: "2026-08-25" }],
      {},
      { week_start: undefined },
    );
    assertEquals(out.status, 422, JSON.stringify(out.body));
    assertStringIncludes(String(out.body.error), "missing job attribution");
    assertEquals(out.writes, [], "nothing is written");
  }
  // A whitespace job id is no reference either.
  const byId = await submit([{ ...line({}), job_id: "  " }], {}, { week_start: undefined });
  assertEquals(byId.status, 422, JSON.stringify(byId.body));
  assertEquals(byId.writes, []);
});

handlerTest("extra job: a padded valid job number is checked, resolved and saved trimmed", async () => {
  const out = await submit([line({ job_number: "  ZZF-1001  " })]);
  assertAccepted(out);
  assertEquals(out.lineRows.map((row) => [row.job_id, row.job_number]), [[BOOKED, "ZZF-1001"]]);
  const noWeek = await submit([line({ job_number: " ZZF-1001 " })], {}, { week_start: undefined });
  assertAccepted(noWeek);
  assertEquals(noWeek.lineRows.map((row) => [row.job_id, row.job_number]), [[BOOKED, "ZZF-1001"]]);
  // Padded, on a job they are not booked on: refused, named trimmed.
  const refused = await submit([line({ job_number: " ZZF-1002 " })], {}, { week_start: undefined });
  assertRefused(refused, "extra_job_not_allowed", "ZZF-1002");
  assertEquals(refused.body.jobs, ["ZZF-1002"]);
});
