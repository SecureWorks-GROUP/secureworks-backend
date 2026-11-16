/**
 * How a trade invoices a job (trade_invoice_mode.ts, Marnin 11 Nov 2026):
 *   1. the owner's rule in order (group, per-metre trade, patio, fencing,
 *      everything else hourly), with repair family read first,
 *   2. can_claim_commission through the one extra-line rule list,
 *   3. the loader: company scope, read errors never degrade,
 *   4. my_hours stamps every card and degrades to null on a failed read,
 *   5. trade_invoice_job_modes through the REAL request handler (front door,
 *      outer and inner dispatch lists), and self_allocate_for_invoice passing
 *      the front door for a plain trade.
 *   6. The agreed work-order amount (Marnin, 12 Nov 2026): a work-order job
 *      with an approved job work order says its agreed labour, and the pure
 *      refusal generate_trade_invoice applies.
 * Every name, number and id below is made up.
 */
// deno-lint-ignore-file no-explicit-any
import "./trade_app_visibility_rules_test_env.ts";
import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import {
  _jobVertical,
  _normalizeManagedVerticals,
  _opsApiRequestHandlerForTest,
  myHours,
} from "./index.ts";
import {
  decideTradeInvoiceMode,
  isWorkOrderInvoiceItem,
  loadTradeInvoiceJobModes,
  parseTradeInvoiceJobModeIds,
  TRADE_INVOICE_JOB_MODES_MAX,
  TradeInvoiceJobModesRequestError,
  TradeInvoiceModeReadError,
  workOrderAmountRefusal,
} from "./trade_invoice_mode.ts";

const TRADE = "7a1e0a52-0000-4000-8000-00000000aa01";
const OTHER = "7a1e0a52-0000-4000-8000-00000000aa02";
const ORG = "00000000-0000-0000-0000-000000000001";
const OTHER_ORG = "00000000-0000-0000-0000-000000000099";
const FENCE = "7a1e0a52-0000-4000-8000-00000000b001";
const PATIO = "7a1e0a52-0000-4000-8000-00000000b002";
const MAKESAFE = "7a1e0a52-0000-4000-8000-00000000b003";
const REPAIR_FAMILY_FENCE = "7a1e0a52-0000-4000-8000-00000000b004";
const GROUPED_FENCE = "7a1e0a52-0000-4000-8000-00000000b005";
const VOID_GROUP_PATIO = "7a1e0a52-0000-4000-8000-00000000b006";
const CREATED_MAKESAFE = "7a1e0a52-0000-4000-8000-00000000b007";
const FOREIGN = "7a1e0a52-0000-4000-8000-00000000b008";
const SWMS_NUMBERED = "7a1e0a52-0000-4000-8000-00000000b009";
const RESTO_AGREED = "7a1e0a52-0000-4000-8000-00000000b00a";
const RESTO_HOURLY = "7a1e0a52-0000-4000-8000-00000000b00b";

const job = (id: string, type: string, over: Record<string, unknown> = {}) => ({
  id,
  org_id: ORG,
  type,
  job_number: "ZZ-" + id.slice(-4),
  metadata: {},
  created_by: OTHER,
  ...over,
});

const JOBS = [
  job(FENCE, "fencing"),
  job(PATIO, "patio"),
  job(MAKESAFE, "makesafe"),
  job(REPAIR_FAMILY_FENCE, "fencing", { metadata: { ses_family: "repair" } }),
  job(GROUPED_FENCE, "fencing"),
  job(VOID_GROUP_PATIO, "patio"),
  job(CREATED_MAKESAFE, "makesafe", { created_by: TRADE }),
  job(FOREIGN, "fencing", { org_id: OTHER_ORG, created_by: TRADE }),
  job(SWMS_NUMBERED, "general", { job_number: "SWMS-1234" }),
  job(RESTO_AGREED, "makesafe", { job_number: "SWRESTO-261718", metadata: { makesafe_job_family: "restoration" } }),
  job(RESTO_HOURLY, "makesafe", { job_number: "SWRESTO-261719", metadata: { makesafe_job_family: "restoration" } }),
];

const GROUPS = [
  { job_id: GROUPED_FENCE, status: "open" },
  { job_id: VOID_GROUP_PATIO, status: "void" },
];

const WO_FENCE = "7a1e0a52-0000-4000-8000-00000000c001";
// Job work orders: FENCE has an approved one with its agreed labour; PATIO
// has an approved one but is a group job (no agreed amount for the trade);
// GROUPED_FENCE's is still a draft; a crew work order on FENCE is not a job
// work order and is never read as one.
const WORK_ORDERS = [
  { id: WO_FENCE, org_id: ORG, job_id: FENCE, kind: "job", status: "approved", agreed_labour_ex: "1850.50" },
  { id: "7a1e0a52-0000-4000-8000-00000000c002", org_id: ORG, job_id: PATIO, kind: "job", status: "approved", agreed_labour_ex: 900 },
  { id: "7a1e0a52-0000-4000-8000-00000000c003", org_id: ORG, job_id: GROUPED_FENCE, kind: "job", status: "draft", agreed_labour_ex: 700 },
  { id: "7a1e0a52-0000-4000-8000-00000000c004", org_id: ORG, job_id: FENCE, kind: "crew", status: "accepted", agreed_labour_ex: null },
  { id: "7a1e0a52-0000-4000-8000-00000000c005", org_id: ORG, job_id: RESTO_AGREED, kind: "job", status: "approved", agreed_labour_ex: 160 },
  { id: "7a1e0a52-0000-4000-8000-00000000c006", org_id: ORG, job_id: RESTO_HOURLY, kind: "job", status: "draft", agreed_labour_ex: 80 },
];

type World = {
  invoiceType?: string;
  managedVerticals?: string[];
  invoiceAnyJob?: unknown;
  userOrg?: string;
  fail?: "users" | "jobs" | "group_work_orders" | "work_orders" | "v_job_commission";
  workOrders?: any[];
  commissions?: any[];
};

function fakeClient(world: World = {}) {
  const reads: Array<{ table: string; filters: Array<[string, string, unknown]> }> = [];
  const client = {
    reads,
    from(table: string) {
      const filters: Array<[string, string, unknown]> = [];
      const rows = (): any[] => {
        if (table === "users") {
          return [{
            id: TRADE,
            org_id: world.userOrg ?? ORG,
            invoice_type: world.invoiceType ?? "hourly",
            managed_verticals: world.managedVerticals ?? [],
            invoice_any_job: world.invoiceAnyJob ?? null,
          }];
        }
        if (table === "jobs") return JOBS;
        if (table === "group_work_orders") return GROUPS;
        if (table === "work_orders") return world.workOrders ?? WORK_ORDERS;
        if (table === "v_job_commission") return world.commissions ?? [];
        return [];
      };
      const matching = () =>
        rows().filter((row) =>
          filters.every(([op, col, val]) =>
            op === "eq"
              ? String(row[col]) === String(val)
              : (val as unknown[]).map(String).includes(String(row[col]))
          )
        );
      const result = () => {
        reads.push({ table, filters: [...filters] });
        if (world.fail === table) return { data: null, error: { message: "boom" } };
        return { data: matching(), error: null };
      };
      const builder: any = {
        select: () => builder,
        eq(col: string, val: unknown) {
          filters.push(["eq", col, val]);
          return builder;
        },
        in(col: string, val: unknown[]) {
          filters.push(["in", col, val]);
          return builder;
        },
        maybeSingle() {
          const r = result();
          return Promise.resolve(r.error ? r : { data: r.data?.[0] ?? null, error: null });
        },
        then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
          return Promise.resolve(result()).then(resolve, reject);
        },
      };
      return builder;
    },
  };
  return client;
}

const load = (client: any, jobIds: string[], orgId?: string) =>
  loadTradeInvoiceJobModes(client, {
    tradeId: TRADE,
    orgId,
    jobIds,
    jobVertical: _jobVertical,
    normaliseManagedVerticals: _normalizeManagedVerticals,
  });

// ── 1. The rule ─────────────────────────────────────────────────────────────

Deno.test("mode rule: the owner's order", () => {
  const d = (hasLiveGroupWorkOrder: boolean, tradeInvoiceType: string, jobVertical: string) =>
    decideTradeInvoiceMode({ hasLiveGroupWorkOrder, tradeInvoiceType, jobVertical });
  // A live group wins over everything, even a per-metre trade on a make-safe.
  assertEquals(d(true, "per_metre", "makesafe"), {
    invoice_mode: "group_work_order",
    invoice_mode_reason: "live_group_work_order",
  });
  assertEquals(d(true, "hourly", "fencing").invoice_mode, "group_work_order");
  // A per-metre trade invoices a work order, whatever the job.
  assertEquals(d(false, "per_metre", "patio"), {
    invoice_mode: "work_order",
    invoice_mode_reason: "per_metre_trade",
  });
  assertEquals(d(false, "per_metre", "makesafe").invoice_mode, "work_order");
  assertEquals(d(false, "hourly", "patio"), {
    invoice_mode: "group_work_order",
    invoice_mode_reason: "patio_job",
  });
  assertEquals(d(false, "hourly", "fencing"), {
    invoice_mode: "work_order",
    invoice_mode_reason: "fencing_job",
  });
  for (const vertical of ["makesafe", "repair", "decking", "general", ""]) {
    assertEquals(d(false, "hourly", vertical), {
      invoice_mode: "hourly",
      invoice_mode_reason: "other_job",
    });
  }
  // Unknown or missing invoice type is not per metre.
  assertEquals(
    decideTradeInvoiceMode({ hasLiveGroupWorkOrder: false, tradeInvoiceType: null, jobVertical: "fencing" })
      .invoice_mode,
    "work_order",
  );
  assertEquals(d(false, " PER_METRE ", "makesafe").invoice_mode, "work_order");
});

// ── 2, 3. The loader ────────────────────────────────────────────────────────

Deno.test("loader: each job decided once, repair family first, void groups ignored", async () => {
  const out = await load(fakeClient(), [
    FENCE,
    PATIO,
    MAKESAFE,
    REPAIR_FAMILY_FENCE,
    GROUPED_FENCE,
    VOID_GROUP_PATIO,
    SWMS_NUMBERED,
    FENCE, // duplicate, asked once
  ]);
  const mode = Object.fromEntries(out.jobs.map((j) => [j.job_id, j.invoice_mode]));
  assertEquals(mode, {
    [FENCE]: "work_order",
    [PATIO]: "group_work_order",
    [MAKESAFE]: "hourly",
    // Typed fencing, but the family says repair: hourly, never a work order.
    [REPAIR_FAMILY_FENCE]: "hourly",
    [GROUPED_FENCE]: "group_work_order",
    // A void group holds nothing: patio by type.
    [VOID_GROUP_PATIO]: "group_work_order",
    // An SWMS- number is a make-safe the way the rest of ops-api reads it.
    [SWMS_NUMBERED]: "hourly",
  });
  assertEquals(
    out.jobs.find((j) => j.job_id === GROUPED_FENCE)?.invoice_mode_reason,
    "live_group_work_order",
  );
  assertEquals(
    out.jobs.find((j) => j.job_id === VOID_GROUP_PATIO)?.invoice_mode_reason,
    "patio_job",
  );
  assertEquals(out.not_found, []);
});

Deno.test("loader: a per-metre trade invoices a work order unless the job has a live group", async () => {
  const out = await load(fakeClient({ invoiceType: "per_metre" }), [MAKESAFE, PATIO, GROUPED_FENCE]);
  assertEquals(out.jobs.map((j) => [j.job_id, j.invoice_mode]), [
    [MAKESAFE, "work_order"],
    [PATIO, "work_order"],
    [GROUPED_FENCE, "group_work_order"],
  ]);
});

Deno.test("loader: another company's job is not decided, and every jobs read is the trade's company", async () => {
  const client = fakeClient();
  const out = await load(client, [FENCE, FOREIGN]);
  assertEquals(out.jobs.map((j) => j.job_id), [FENCE]);
  assertEquals(out.not_found, [FOREIGN]);
  for (const read of client.reads.filter((r) => r.table === "jobs")) {
    assert(read.filters.some(([op, col, val]) => op === "eq" && col === "org_id" && val === ORG));
  }
});

Deno.test("loader: commission only on a job they created, a division they manage, or with the grant", async () => {
  const plain = await load(fakeClient(), [CREATED_MAKESAFE, MAKESAFE, FENCE]);
  assertEquals(plain.jobs.map((j) => [j.job_id, j.can_claim_commission]), [
    [CREATED_MAKESAFE, true],
    [MAKESAFE, false],
    [FENCE, false],
  ]);
  const manager = await load(fakeClient({ managedVerticals: ["fencing"] }), [MAKESAFE, FENCE]);
  assertEquals(manager.jobs.map((j) => j.can_claim_commission), [false, true]);
  const makesafeManager = await load(fakeClient({ managedVerticals: ["makesafe"] }), [MAKESAFE, FENCE]);
  assertEquals(makesafeManager.jobs.map((j) => j.can_claim_commission), [true, false]);
  // The grant is literal true only.
  for (const grant of ["true", 1, null]) {
    const out = await load(fakeClient({ invoiceAnyJob: grant }), [FENCE]);
    assertEquals(out.jobs[0].can_claim_commission, false, JSON.stringify(grant));
  }
  const granted = await load(fakeClient({ invoiceAnyJob: true }), [FENCE, MAKESAFE]);
  assertEquals(granted.jobs.map((j) => j.can_claim_commission), [true, true]);
});

Deno.test("loader: a job with a commission record opens commission to its named salesperson only (ruling 17 step 2)", async () => {
  const OTHER = "7a1e0a52-0000-4000-8000-0000000000ff";
  const commissions = [
    { job_id: CREATED_MAKESAFE, salesperson_user_id: OTHER, state: "named" },
    { job_id: FENCE, salesperson_user_id: TRADE, state: "named" },
    { job_id: MAKESAFE, salesperson_user_id: null, state: "no_salesperson" },
  ];
  // The creator of CREATED_MAKESAFE is not its salesperson; FENCE names this
  // trade though they neither created nor manage it; nobody claims MAKESAFE.
  const plain = await load(fakeClient({ commissions }), [CREATED_MAKESAFE, FENCE, MAKESAFE, PATIO]);
  assertEquals(plain.jobs.map((j) => [j.job_id, j.can_claim_commission]), [
    [CREATED_MAKESAFE, false],
    [FENCE, true],
    [MAKESAFE, false],
    [PATIO, false],
  ]);
  // A manager or the grant does not open a job with a record; jobs without one keep their rules.
  const granted = await load(fakeClient({ commissions, invoiceAnyJob: true, managedVerticals: ["makesafe"] }), [CREATED_MAKESAFE, MAKESAFE, PATIO]);
  assertEquals(granted.jobs.map((j) => j.can_claim_commission), [false, false, true]);
});

Deno.test("loader: a failed read throws, never reads as no group or hourly", async () => {
  for (const fail of ["users", "jobs", "group_work_orders", "work_orders", "v_job_commission"] as const) {
    await assertRejects(() => load(fakeClient({ fail }), [FENCE]), TradeInvoiceModeReadError);
  }
  // The caller's company must be the trade's own.
  await assertRejects(() => load(fakeClient(), [FENCE], OTHER_ORG), TradeInvoiceModeReadError);
  assertEquals((await load(fakeClient(), [FENCE], ORG)).jobs.length, 1);
  // Nothing to ask: no read at all.
  const client = fakeClient();
  assertEquals(await load(client, []), { jobs: [], not_found: [] });
  assertEquals(client.reads, []);
});

Deno.test("job_ids: 1 to 50 uuids, deduplicated", () => {
  assertEquals(parseTradeInvoiceJobModeIds(` ${FENCE}, ${PATIO},${FENCE},, `), [FENCE, PATIO]);
  for (const raw of [null, "", " , "]) {
    const e = assertThrows(() => parseTradeInvoiceJobModeIds(raw), TradeInvoiceJobModesRequestError);
    assertEquals(e.code, "job_ids_required");
  }
  const bad = assertThrows(() => parseTradeInvoiceJobModeIds("SWF-1001"), TradeInvoiceJobModesRequestError);
  assertEquals(bad.code, "job_ids_invalid");
  const many = Array.from(
    { length: TRADE_INVOICE_JOB_MODES_MAX + 1 },
    (_, i) => `7a1e0a52-0000-4000-8000-${String(i).padStart(12, "0")}`,
  );
  assertEquals(parseTradeInvoiceJobModeIds(many.slice(0, 50).join(",")).length, 50);
  const tooMany = assertThrows(() => parseTradeInvoiceJobModeIds(many.join(",")), TradeInvoiceJobModesRequestError);
  assertEquals(tooMany.code, "too_many_job_ids");
});

// ── 4. my_hours ─────────────────────────────────────────────────────────────

const WEEK_END = "2026-11-08";

function hoursClient(world: { failJobs?: boolean } = {}) {
  const card = (id: string, jobId: string, type: string) => ({
    id,
    scheduled_date: "2026-11-04",
    status: "complete",
    hours_worked: 4,
    invoiced_in: null,
    jobs: { id: jobId, type, job_number: "ZZ-" + jobId.slice(-4), client_name: "Client", site_suburb: "Perth" },
  });
  const tables: Record<string, any[]> = {
    users: [{
      id: TRADE,
      org_id: ORG,
      invoice_type: "hourly",
      trade_details: {},
      managed_verticals: [],
      invoice_any_job: null,
    }],
    job_assignments: [
      card("card-fence", FENCE, "fencing"),
      card("card-makesafe", CREATED_MAKESAFE, "makesafe"),
      card("card-grouped", GROUPED_FENCE, "fencing"),
    ],
    jobs: JOBS,
    group_work_orders: [{ id: "group-1", ...GROUPS[0] }],
    work_orders: WORK_ORDERS,
    trade_rates: [{ hourly_rate: 50, effective_from: "2026-01-01" }],
  };
  return {
    from(table: string) {
      const filters: Array<[string, string, unknown]> = [];
      const result = () => {
        if (world.failJobs && table === "jobs") return { data: null, error: { message: "boom" } };
        const rows = (tables[table] || []).filter((row) =>
          filters.every(([op, col, val]) =>
            op === "eq"
              ? String(row[col]) === String(val)
              : (val as unknown[]).map(String).includes(String(row[col]))
          )
        );
        return { data: rows, error: null };
      };
      const builder: any = {
        select: () => builder,
        eq(col: string, val: unknown) {
          if (table !== "job_assignments") filters.push(["eq", col, val]);
          return builder;
        },
        in(col: string, val: unknown[]) {
          if (table !== "job_assignments") filters.push(["in", col, val]);
          return builder;
        },
        gte: () => builder,
        lte: () => builder,
        or: () => builder,
        not: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle() {
          const r = result();
          return Promise.resolve(r.error ? r : { data: r.data?.[0] ?? null, error: null });
        },
        then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
          return Promise.resolve(result()).then(resolve, reject);
        },
      };
      return builder;
    },
  };
}

Deno.test("my_hours: every card and group job says how it is invoiced and whether commission is open", async () => {
  const out: any = await myHours(hoursClient(), TRADE, new URLSearchParams({ week_ending: WEEK_END }));
  assertEquals(out.invoice_mode_unavailable, false);
  const cards = Object.fromEntries(out.assignments.map((a: any) => [a.id, a]));
  assertEquals(
    [cards["card-fence"].invoice_mode, cards["card-fence"].invoice_mode_reason, cards["card-fence"].can_claim_commission],
    ["work_order", "fencing_job", false],
  );
  assertEquals(
    [cards["card-makesafe"].invoice_mode, cards["card-makesafe"].can_claim_commission],
    ["hourly", true],
  );
  // The fencing job's approved job work order: the trade's own agreed pay.
  assertEquals(
    [cards["card-fence"].work_order_agreed_ex, cards["card-fence"].job_work_order_id],
    [1850.5, WO_FENCE],
  );
  assertEquals(
    [cards["card-makesafe"].work_order_agreed_ex, cards["card-makesafe"].job_work_order_id],
    [null, null],
  );
  // The grouped job is a group route, not an hours card, and says so too.
  assert(!cards["card-grouped"]);
  const route = out.group_route_jobs.find((r: any) => r.job_id === GROUPED_FENCE);
  assertEquals([route.invoice_mode, route.invoice_mode_reason], ["group_work_order", "live_group_work_order"]);
});

Deno.test("my_hours: a failed mode read never fails the hours view and never guesses", async () => {
  const out: any = await myHours(hoursClient({ failJobs: true }), TRADE, new URLSearchParams({ week_ending: WEEK_END }));
  assertEquals(out.invoice_mode_unavailable, true);
  assert(out.assignments.length > 0);
  for (const a of out.assignments) {
    assertEquals([a.invoice_mode, a.invoice_mode_reason, a.can_claim_commission], [null, null, null]);
    assertEquals([a.work_order_agreed_ex, a.job_work_order_id], [null, null]);
  }
  assertEquals(out.total_hours, 8);
});

// ── 5. Through the real handler ─────────────────────────────────────────────

async function call(
  action: string,
  init: { method?: string; query?: Record<string, string>; body?: unknown; role?: string } = {},
): Promise<{ status: number; body: any; tables: string[] }> {
  const tables: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: Request | URL | string, reqInit?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(reqInit?.headers ?? (input instanceof Request ? input.headers : undefined));
    const accept = headers.get("accept") || "";
    const reply = (rows: any[]) => {
      if (!accept.includes("vnd.pgrst.object")) return Promise.resolve(Response.json(rows));
      if (rows.length === 1) return Promise.resolve(Response.json(rows[0]));
      if (rows.length === 0 && accept.includes("nulls=stripped")) return Promise.resolve(Response.json(null));
      return Promise.resolve(Response.json({ code: "PGRST116", message: "no rows" }, { status: 406 }));
    };
    if (url.pathname.startsWith("/auth/v1/user")) {
      return Promise.resolve(Response.json({ id: TRADE, email: "", aud: "authenticated" }));
    }
    const table = url.pathname.match(/^\/rest\/v1\/(.+)$/)?.[1] || "";
    tables.push(table);
    const values = (column: string): string[] | null => {
      const raw = url.searchParams.get(column);
      if (raw === null) return null;
      const eq = /^eq\.(.*)$/.exec(raw);
      if (eq) return [eq[1]];
      const inList = /^in\.\((.*)\)$/.exec(raw);
      if (inList) return inList[1].split(",").map((v) => v.replace(/"/g, "").trim());
      return null;
    };
    if (table === "users") {
      return reply([{
        id: TRADE,
        org_id: ORG,
        role: init.role ?? "lead_installer",
        name: "Fixture Trade",
        managed_verticals: [],
        trade_sees_all_jobs: false,
        invoice_type: "hourly",
        trade_details: {},
        invoice_any_job: null,
      }]);
    }
    if (table === "jobs") {
      const ids = values("id");
      const orgs = values("org_id");
      return reply(JOBS.filter((row) =>
        (!ids || ids.includes(row.id)) && (!orgs || orgs.includes(row.org_id))
      ));
    }
    if (table === "group_work_orders") {
      const jobs = values("job_id");
      return reply(GROUPS.filter((row) => !jobs || jobs.includes(row.job_id)));
    }
    if (table === "work_orders") {
      const jobs = values("job_id");
      const kind = values("kind");
      const status = values("status");
      return reply(WORK_ORDERS.filter((row) =>
        (!jobs || jobs.includes(row.job_id)) && (!kind || kind.includes(row.kind)) &&
        (!status || status.includes(row.status))
      ));
    }
    return reply([]);
  }) as typeof fetch;
  try {
    const url = new URL("https://example.invalid/ops-api");
    url.searchParams.set("action", action);
    for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v);
    const method = init.method ?? "GET";
    const res = await _opsApiRequestHandlerForTest(new Request(url, {
      method,
      headers: { authorization: "Bearer trade-jwt", "content-type": "application/json" },
      body: method === "GET" ? undefined : JSON.stringify(init.body ?? {}),
    }));
    const text = await res.text();
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
    return { status: res.status, body, tables };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const handlerTest = (name: string, fn: () => Promise<void>) =>
  Deno.test({ name, fn, sanitizeOps: false, sanitizeResources: false });

handlerTest("trade_invoice_job_modes: a plain trade gets each job's mode; another company's job is not decided", async () => {
  for (const role of ["lead_installer", "installer"]) {
    const out = await call("trade_invoice_job_modes", {
      role,
      query: { job_ids: [FENCE, PATIO, CREATED_MAKESAFE, FOREIGN].join(",") },
    });
    assertEquals(out.status, 200, JSON.stringify(out.body));
    assertEquals(out.body.ok, true);
    assertEquals(out.body.jobs, [
      {
        job_id: FENCE,
        invoice_mode: "work_order",
        invoice_mode_reason: "fencing_job",
        can_claim_commission: false,
        work_order_agreed_ex: 1850.5,
        job_work_order_id: WO_FENCE,
      },
      {
        job_id: PATIO,
        invoice_mode: "group_work_order",
        invoice_mode_reason: "patio_job",
        can_claim_commission: false,
        work_order_agreed_ex: null,
        job_work_order_id: null,
      },
      {
        job_id: CREATED_MAKESAFE,
        invoice_mode: "hourly",
        invoice_mode_reason: "other_job",
        can_claim_commission: true,
        work_order_agreed_ex: null,
        job_work_order_id: null,
      },
    ]);
    assertEquals(out.body.not_found, [FOREIGN]);
  }
});

handlerTest("trade_invoice_job_modes: bad job_ids answer 400 before any job is read; GET only", async () => {
  const none = await call("trade_invoice_job_modes", { query: {} });
  assertEquals(none.status, 400, JSON.stringify(none.body));
  assertEquals(none.body.code, "job_ids_required");
  assert(!none.tables.includes("jobs"));
  const bad = await call("trade_invoice_job_modes", { query: { job_ids: "SWF-1001" } });
  assertEquals(bad.status, 400);
  assertEquals(bad.body.code, "job_ids_invalid");
  const post = await call("trade_invoice_job_modes", { method: "POST", query: { job_ids: FENCE } });
  assertEquals(post.status, 405);
});

handlerTest("self_allocate_for_invoice: a plain trade passes the front door (the route decides)", async () => {
  const out = await call("self_allocate_for_invoice", {
    method: "POST",
    role: "installer",
    body: { job_id: FOREIGN, work_date: "2026-11-10" },
  });
  // Never the staff-role refusal: the route itself answers (the job is
  // another company's, so it is not found).
  assert(out.body.code !== "operator_access_required", JSON.stringify(out.body));
  assertEquals(out.status, 404, JSON.stringify(out.body));
  assertEquals(out.body.code, "self_allocate_job_not_found");
});

handlerTest("submit_trade_invoice: retired, 410 use_weekly_invoice", async () => {
  const out = await call("submit_trade_invoice", {
    method: "POST",
    body: { week_ending: WEEK_END, gst_on: false },
  });
  assertEquals(out.status, 410, JSON.stringify(out.body));
  assertEquals(out.body.code, "use_weekly_invoice");
  assertEquals(out.body.error, "Send your invoice from the Weekly Invoice in the Trade App.");
});

// ── 6. The agreed work-order amount ─────────────────────────────────────────

Deno.test("loader: a work-order job with an approved job work order says its agreed labour", async () => {
  const client = fakeClient();
  const out = await load(client, [FENCE, PATIO, GROUPED_FENCE, MAKESAFE]);
  const byJob = Object.fromEntries(out.jobs.map((j) => [j.job_id, [j.work_order_agreed_ex, j.job_work_order_id]]));
  assertEquals(byJob, {
    [FENCE]: [1850.5, WO_FENCE],
    // A group job: the agreed labour is the group's pot, never one trade's.
    [PATIO]: [null, null],
    // A draft work order agrees nothing.
    [GROUPED_FENCE]: [null, null],
    [MAKESAFE]: [null, null],
  });
  // Only work-order jobs are asked about, only approved job work orders, in
  // the trade's company.
  const woReads = client.reads.filter((r) => r.table === "work_orders");
  assertEquals(woReads.length, 1);
  const filters = woReads[0].filters;
  assert(filters.some(([op, col, val]) => op === "eq" && col === "kind" && val === "job"));
  assert(filters.some(([op, col, val]) => op === "eq" && col === "status" && val === "approved"));
  assert(filters.some(([op, col, val]) => op === "eq" && col === "org_id" && val === ORG));
  assertEquals(filters.find(([op, col]) => op === "in" && col === "job_id")?.[2], [FENCE]);
  // No work-order job: the work orders are not read at all.
  const hourlyOnly = fakeClient();
  await load(hourlyOnly, [MAKESAFE]);
  assertEquals(hourlyOnly.reads.filter((r) => r.table === "work_orders"), []);
});

Deno.test("loader: a per-metre trade on a job with an approved job work order bills its agreed labour", async () => {
  const out = await load(fakeClient({ invoiceType: "per_metre" }), [FENCE]);
  assertEquals([out.jobs[0].invoice_mode, out.jobs[0].work_order_agreed_ex], ["work_order", 1850.5]);
});

Deno.test("loader: two approved job work orders on one job are never guessed between", async () => {
  const twice = [
    ...WORK_ORDERS,
    { id: "7a1e0a52-0000-4000-8000-00000000c009", org_id: ORG, job_id: FENCE, kind: "job", status: "approved", agreed_labour_ex: 10 },
  ];
  await assertRejects(() => load(fakeClient({ workOrders: twice }), [FENCE]), TradeInvoiceModeReadError);
});

Deno.test("work-order line: a work-order row, labour lines or a work-order type; nothing else", () => {
  assert(isWorkOrderInvoiceItem({ row_type: "work_order", type: "Work Order" }));
  assert(isWorkOrderInvoiceItem({ type: "Labour", wo_labour_lines: [{ trade_name: "A", hours: 1, rate: 1 }] }));
  assert(isWorkOrderInvoiceItem({ type: " Work Order " }));
  assert(isWorkOrderInvoiceItem({ type: "work_order" }));
  for (const item of [{ type: "Labour" }, { type: "Commission", row_type: "commission" }, { type: "Travel" }, { wo_labour_lines: [] }, null]) {
    assert(!isWorkOrderInvoiceItem(item), JSON.stringify(item));
  }
});

Deno.test("agreed amount: billed at the agreed figure passes, any other figure is refused by job", () => {
  const modes = new Map([
    [FENCE, { work_order_agreed_ex: 1850.5 }],
    [MAKESAFE, { work_order_agreed_ex: null }],
  ]);
  assertEquals(workOrderAmountRefusal([{ ref: "SWF-123", jobId: FENCE, woAllocated: 1850.5 }], modes), null);
  assertEquals(workOrderAmountRefusal([{ ref: "SWF-123", jobId: FENCE, woAllocated: "1850.495" }], modes), null);
  // No agreed work order: the trade's figure stands, as before.
  assertEquals(workOrderAmountRefusal([{ ref: "ZZ-1", jobId: MAKESAFE, woAllocated: 99 }], modes), null);
  const over = workOrderAmountRefusal([{ ref: "SWF-123", jobId: FENCE, woAllocated: 2000 }], modes);
  assertEquals(over?.code, "work_order_amount_not_agreed");
  assertEquals(
    over?.message,
    "Job SWF-123 has an agreed work order of $1,850.50. Bill it at that amount, or ask the office.",
  );
  assertEquals(over?.jobs, [{ job: "SWF-123", job_id: FENCE, agreed_ex: 1850.5, billed_ex: 2000 }]);
  // Missing amount, and a second work-order line on the same job.
  assertEquals(workOrderAmountRefusal([{ ref: "SWF-123", jobId: FENCE, woAllocated: null }], modes)?.jobs[0].billed_ex, null);
  const twice = workOrderAmountRefusal([
    { ref: "SWF-123", jobId: FENCE, woAllocated: 1850.5 },
    { ref: "SWF-123", jobId: FENCE, woAllocated: 1850.5 },
  ], modes);
  assertEquals(twice?.jobs.length, 1);
});

Deno.test("mode rule: a restoration job with an agreed work order is billed as that work order; without one it is hourly", async () => {
  assertEquals(
    decideTradeInvoiceMode({ hasLiveGroupWorkOrder: false, tradeInvoiceType: "hourly", jobVertical: "makesafe", restorationWorkOrder: true }),
    { invoice_mode: "work_order", invoice_mode_reason: "restoration_work_order" },
  );
  const { jobs } = await load(fakeClient(), [RESTO_AGREED, RESTO_HOURLY]);
  const agreed = jobs.find((j) => j.job_id === RESTO_AGREED)!;
  assertEquals(
    [agreed.invoice_mode, agreed.invoice_mode_reason, agreed.work_order_agreed_ex, agreed.job_work_order_id],
    ["work_order", "restoration_work_order", 160, "7a1e0a52-0000-4000-8000-00000000c005"],
  );
  // A draft work order agrees nothing: the job stays hourly.
  const hourly = jobs.find((j) => j.job_id === RESTO_HOURLY)!;
  assertEquals([hourly.invoice_mode, hourly.work_order_agreed_ex], ["hourly", null]);
});
