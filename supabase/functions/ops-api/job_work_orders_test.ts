// deno-lint-ignore-file no-explicit-any no-import-prefix require-await
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  approveJobWorkOrder,
  buildVariationEmails,
  computeWorkOrderFigures,
  JOB_WORK_ORDER_BILLED_INVOICE_STATUSES,
  JOB_WORK_ORDER_OPEN_STATUSES,
  JobWorkOrderError,
  projectTradeJobWorkOrder,
  readJobWorkOrder,
  reportWorkOrderVariation,
  resolveWorkOrderApprover,
  tradeJobWorkOrderRead,
  updateJobWorkOrderDraft,
  validateJobWorkOrderDraftPatch,
  WORK_ORDER_VARIATION_ADMIN_EMAIL,
  WORK_ORDER_VARIATION_FINANCE_EMAIL,
} from "./job_work_orders.ts";

const SHAUN = "9913309f-35ae-4a71-8e1f-f704ecc526ea";
const HUGO = "b353f39a-b3cc-495d-a016-50ebf4a8497d";
const TRADE = "aaaaaaaa-0000-4000-8000-00000000000a";
const OTHER_TRADE = "bbbbbbbb-0000-4000-8000-00000000000b";
const ORG = "00000000-0000-0000-0000-000000000001";
const JOB = "11111111-1111-4111-8111-111111111111";
const WO = "22222222-2222-4222-8222-222222222222";
const DRAFT = "33333333-3333-4333-8333-333333333333";
const INV = "44444444-4444-4444-8444-444444444444";

// ── A small in-memory PostgREST stand-in ─────────────────────────────────────

type Tables = Record<string, any[]>;

function get(row: any, path: string) {
  return path.split(".").reduce(
    (v, k) => (v == null ? v : (Array.isArray(v) ? v[0] : v)[k]),
    row,
  );
}

class Query {
  private filters: Array<(r: any) => boolean> = [];
  private op: "select" | "insert" | "update" | "upsert" = "select";
  private payload: any = null;
  private mode: "one" | "maybe" | null = null;
  private lim: number | null = null;
  private returnRows = false;
  private upsertOpts: any = null;
  constructor(private db: FakeDb, private table: string) {}
  select(_cols?: string) {
    if (this.op !== "select") this.returnRows = true;
    return this;
  }
  insert(payload: any) {
    this.op = "insert";
    this.payload = payload;
    return this;
  }
  update(payload: any) {
    this.op = "update";
    this.payload = payload;
    return this;
  }
  upsert(payload: any, opts: any) {
    this.op = "upsert";
    this.payload = payload;
    this.upsertOpts = opts;
    return this;
  }
  eq(col: string, val: any) {
    this.filters.push((r) => get(r, col) === val);
    return this;
  }
  neq(col: string, val: any) {
    this.filters.push((r) => get(r, col) !== val);
    return this;
  }
  in(col: string, vals: any[]) {
    this.filters.push((r) => vals.includes(get(r, col)));
    return this;
  }
  is(col: string, val: any) {
    this.filters.push((r) => (get(r, col) ?? null) === val);
    return this;
  }
  not(col: string, _op: string, val: any) {
    this.filters.push((r) => (get(r, col) ?? null) !== val);
    return this;
  }
  order() {
    return this;
  }
  range() {
    return this;
  }
  limit(n: number) {
    this.lim = n;
    return this;
  }
  maybeSingle() {
    this.mode = "maybe";
    return this;
  }
  single() {
    this.mode = "one";
    return this;
  }
  then(resolve: any, reject: any) {
    return this.run().then(resolve, reject);
  }
  private async run(): Promise<any> {
    const rows = this.db.tables[this.table] ||= [];
    if (this.db.failOn.has(`${this.op}:${this.table}`)) {
      return { data: null, error: { message: "boom", code: "XX000" } };
    }
    if (this.op === "insert") {
      const list = Array.isArray(this.payload) ? this.payload : [this.payload];
      const out: any[] = [];
      for (const raw of list) {
        const row = {
          id: crypto.randomUUID(),
          status: "reported",
          created_at: new Date().toISOString(),
          ...raw,
        };
        const key = this.db.unique[this.table];
        if (key && rows.some((r) => key.every((k) => r[k] === row[k]))) {
          return { data: null, error: { code: "23505", message: "duplicate" } };
        }
        rows.push(row);
        out.push(row);
      }
      return this.finish(out);
    }
    if (this.op === "upsert") {
      const key = String(this.upsertOpts?.onConflict || "").split(",");
      const out: any[] = [];
      for (const raw of this.payload) {
        if (rows.some((r) => key.every((k) => r[k] === raw[k]))) continue;
        const row = { id: crypto.randomUUID(), status: "recorded", ...raw };
        rows.push(row);
        out.push(row);
      }
      return { data: out, error: null };
    }
    const matched = rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.op === "update") {
      for (const r of matched) Object.assign(r, this.payload);
      return this.finish(matched);
    }
    return this.finish(
      this.lim === null ? matched : matched.slice(0, this.lim),
    );
  }
  private finish(rows: any[]) {
    if (this.mode === "maybe") return { data: rows[0] ?? null, error: null };
    if (this.mode === "one") {
      return rows.length === 1
        ? { data: rows[0], error: null }
        : { data: null, error: { message: "not one" } };
    }
    return { data: rows, error: null };
  }
}

class FakeDb {
  tables: Tables;
  unique: Record<string, string[]> = {
    work_order_variations: ["trade_invoice_id", "job_id"],
  };
  failOn = new Set<string>();
  rpcCalls: Array<{ fn: string; args: any }> = [];
  rpcImpl: (fn: string, args: any) => { data: any; error: any } = () => ({
    data: null,
    error: null,
  });
  constructor(tables: Tables) {
    this.tables = tables;
  }
  from(table: string) {
    return new Query(this, table);
  }
  rpc(fn: string, args: any) {
    this.rpcCalls.push({ fn, args });
    return Promise.resolve(this.rpcImpl(fn, args));
  }
}

function baseDb(extra: Partial<Tables> = {}) {
  return new FakeDb({
    jobs: [{
      id: JOB,
      org_id: ORG,
      job_number: "SWF-26123",
      client_name: "Client",
      type: "fencing",
      status: "scheduled",
      site_address: "1 Test St",
      site_suburb: "Duncraig",
      work_order_id: WO,
    }],
    work_orders: [{
      id: WO,
      org_id: ORG,
      job_id: JOB,
      wo_number: "WO-SWF-26123",
      kind: "job",
      status: "approved",
      scope_items: [{
        description: "Install 20 m Colorbond",
        qty: 20,
        unit: "m",
        price: 90,
        rate: 90,
        total: 1800,
      }],
      special_instructions: "Rear gate first",
      agreed_labour_ex: 1000,
      approved_at: "2026-10-06T00:00:00Z",
      superseded_at: null,
      updated_at: "2026-10-06T00:00:00Z",
    }],
    trade_invoices: [{
      id: INV,
      org_id: ORG,
      user_id: TRADE,
      status: "pending_acknowledgment",
      invoice_number: "TI-1",
    }],
    trade_invoice_lines: [
      {
        id: "l1",
        trade_invoice_id: INV,
        job_id: JOB,
        job_work_order_id: WO,
        line_type: "labour",
        total_hours: 8,
        line_total_ex: 640,
        override_amount: null,
        trade_invoices: {
          id: INV,
          user_id: TRADE,
          invoice_number: "TI-1",
          status: "pending_acknowledgment",
          submitted_at: "2026-10-06T01:00:00Z",
          users: { name: "Trade One" },
        },
      },
      {
        id: "l2",
        trade_invoice_id: INV,
        job_id: JOB,
        job_work_order_id: WO,
        line_type: "commission",
        line_total_ex: 300,
        override_amount: null,
        trade_invoices: {
          id: INV,
          user_id: TRADE,
          invoice_number: "TI-1",
          status: "pending_acknowledgment",
          submitted_at: "2026-10-06T01:00:00Z",
          users: { name: "Trade One" },
        },
      },
      {
        id: "l3",
        trade_invoice_id: "old",
        job_id: JOB,
        job_work_order_id: null,
        line_type: "labour",
        line_total_ex: 200,
        override_amount: null,
        trade_invoices: {
          id: "old",
          user_id: TRADE,
          invoice_number: "TI-0",
          status: "paid",
          submitted_at: "2026-09-01T01:00:00Z",
          users: { name: "Trade One" },
        },
      },
    ],
    work_order_variations: [],
    work_order_variation_emails: [],
    work_order_settings: [{ id: 1, approver_user_ids: [SHAUN] }],
    feature_flags: [],
    job_events: [],
    ...extra,
  });
}

// ── Approver identity ────────────────────────────────────────────────────────

Deno.test("approver: a staff session is the signed-in user", () => {
  assertEquals(
    resolveWorkOrderApprover({
      authMode: "jwt",
      authUserId: SHAUN,
      serverSecretPresented: false,
    }),
    { userId: SHAUN, via: "session" },
  );
});

Deno.test("approver: the terminal names the user through a trusted x-sw-actor on a server-secret call", () => {
  assertEquals(
    resolveWorkOrderApprover({
      authMode: "api_key",
      serverSecretPresented: true,
      actor: { actor: `user:${SHAUN}`, source: "header" },
    }),
    { userId: SHAUN, via: "terminal" },
  );
});

Deno.test("approver: the shared browser key, an untrusted header or a seat name is nobody", () => {
  assertEquals(
    resolveWorkOrderApprover({
      authMode: "api_key",
      serverSecretPresented: false,
      actor: { actor: `user:${SHAUN}`, source: "header" },
    }),
    null,
  );
  assertEquals(
    resolveWorkOrderApprover({
      authMode: "api_key",
      serverSecretPresented: true,
      actor: { actor: "actor_missing", source: "header_untrusted" },
    }),
    null,
  );
  assertEquals(
    resolveWorkOrderApprover({
      authMode: "api_key",
      serverSecretPresented: true,
      actor: { actor: "seat:rayleigh", source: "header" },
    }),
    null,
  );
  assertEquals(
    resolveWorkOrderApprover({
      authMode: "routine",
      serverSecretPresented: false,
    }),
    null,
  );
});

// ── Figures and rules ────────────────────────────────────────────────────────

Deno.test("figures: only counted lines on an approved work order are billed; over_agreed fires", () => {
  const f = computeWorkOrderFigures({
    agreedEx: 1000,
    approved: true,
    lines: [
      { amount_ex: 700, counted: true, work_order_id: WO },
      { amount_ex: 400, counted: true, work_order_id: WO },
      { amount_ex: 999, counted: false, work_order_id: WO },
      { amount_ex: 999, counted: true, work_order_id: null },
    ],
    variations: [{ amount_ex: 150, status: "reported", work_order_id: WO }],
  });
  assertEquals(f.billed_to_date_ex, 1100);
  assertEquals(f.variations_ex, 150);
  assertEquals(f.billed_within_agreed_scope_ex, 950);
  assertEquals(f.remaining_ex, -100);
  assertEquals(f.over_agreed, true);
  assertEquals(f.rules.map((r) => r.key), ["over_agreed", "has_variations"]);
});

Deno.test("figures: near_agreed at 90 percent, nothing counts before approval", () => {
  const near = computeWorkOrderFigures({
    agreedEx: 1000,
    approved: true,
    lines: [{ amount_ex: 900, counted: true, work_order_id: WO }],
    variations: [],
  });
  assertEquals(near.rules.map((r) => r.key), ["near_agreed"]);
  const draft = computeWorkOrderFigures({
    agreedEx: 1000,
    approved: false,
    lines: [],
    variations: [],
  });
  assertEquals(draft.agreed_ex, null);
  assertEquals(draft.rules.map((r) => r.key), ["no_approved_work_order"]);
});

Deno.test("lists mirror the migration's SQL lists", async () => {
  const sql = await Deno.readTextFile(
    new URL(
      "../../migrations/20261012090000_job_work_orders.sql",
      import.meta.url,
    ),
  );
  for (const s of JOB_WORK_ORDER_OPEN_STATUSES) {
    assert(sql.includes(`'${s}'`), s);
  }
  for (const s of JOB_WORK_ORDER_BILLED_INVOICE_STATUSES) {
    assert(sql.includes(`'${s}'`), s);
  }
  assert(!JOB_WORK_ORDER_OPEN_STATUSES.includes("complete"));
});

// ── Draft edits and the seal ─────────────────────────────────────────────────

Deno.test("draft patch: validates and keeps only editable fields", () => {
  const p = validateJobWorkOrderDraftPatch({
    agreed_labour_ex: "1234.567",
    scope_items: [{ description: "x" }],
    status: "approved",
    approved_by: SHAUN,
  });
  assertEquals(p, {
    agreed_labour_ex: 1234.57,
    scope_items: [{ description: "x" }],
  });
  let err: any;
  try {
    validateJobWorkOrderDraftPatch({ agreed_labour_ex: -1 });
  } catch (e) {
    err = e;
  }
  assert(err instanceof JobWorkOrderError && err.status === 400);
});

Deno.test("update: an approved work order is sealed", async () => {
  const db = baseDb();
  const err = await assertRejects(
    () => updateJobWorkOrderDraft(db, { id: WO, agreed_labour_ex: 5000 }),
    JobWorkOrderError,
  );
  assertEquals((err as JobWorkOrderError).code, "work_order_sealed");
  assertEquals(db.tables.work_orders[0].agreed_labour_ex, 1000);
});

// ── Approve ──────────────────────────────────────────────────────────────────

function draftDb() {
  const db = baseDb();
  db.tables.work_orders.push({
    id: DRAFT,
    org_id: ORG,
    job_id: JOB,
    wo_number: "WO-SWF-26123-R2",
    kind: "job",
    status: "draft",
    agreed_labour_ex: 1200,
    scope_items: [{ description: "x" }],
    supersedes_work_order_id: WO,
    updated_at: "t1",
  });
  db.rpcImpl = (fn, args) =>
    fn === "approve_job_work_order"
      ? {
        data: {
          id: args.p_work_order_id,
          status: "approved",
          sealed_content_hash: "h",
        },
        error: null,
      }
      : { data: null, error: null };
  return db;
}

Deno.test("approve: only Shaun, and only with a named identity", async () => {
  const db = draftDb();
  assertEquals(
    (await assertRejects(
      () => approveJobWorkOrder(db, { work_order_id: DRAFT }, null),
      JobWorkOrderError,
    ) as JobWorkOrderError).code,
    "approver_identity_missing",
  );
  assertEquals(
    (await assertRejects(
      () =>
        approveJobWorkOrder(db, { work_order_id: DRAFT }, {
          userId: HUGO,
          via: "session",
        }),
      JobWorkOrderError,
    ) as JobWorkOrderError).status,
    403,
  );
  assertEquals(db.rpcCalls.length, 0);
  const out = await approveJobWorkOrder(db, { work_order_id: DRAFT }, {
    userId: SHAUN,
    via: "terminal",
  });
  assertEquals(out.work_order.status, "approved");
  assertEquals(db.rpcCalls[0], {
    fn: "approve_job_work_order",
    args: { p_work_order_id: DRAFT, p_approver: SHAUN, p_via: "terminal" },
  });
  assertEquals(
    db.tables.job_events.at(-1).event_type,
    "job_work_order_approved",
  );
});

Deno.test("approve: an empty approver list means nobody, a stale review refuses, database refusals map", async () => {
  const empty = draftDb();
  empty.tables.work_order_settings = [{ id: 1, approver_user_ids: [] }];
  assertEquals(
    (await assertRejects(
      () =>
        approveJobWorkOrder(empty, { work_order_id: DRAFT }, {
          userId: SHAUN,
          via: "session",
        }),
      JobWorkOrderError,
    ) as JobWorkOrderError).code,
    "approver_not_set",
  );

  const stale = draftDb();
  assertEquals(
    (await assertRejects(
      () =>
        approveJobWorkOrder(stale, {
          work_order_id: DRAFT,
          expected_updated_at: "t0",
        }, { userId: SHAUN, via: "session" }),
      JobWorkOrderError,
    ) as JobWorkOrderError).code,
    "stale_review",
  );

  const notReady = draftDb();
  notReady.rpcImpl = () => ({
    data: null,
    error: { code: "23514", message: "add the scope before approving" },
  });
  const err = await assertRejects(
    () =>
      approveJobWorkOrder(notReady, { work_order_id: DRAFT }, {
        userId: SHAUN,
        via: "session",
      }),
    JobWorkOrderError,
  ) as JobWorkOrderError;
  assertEquals([err.status, err.code], [422, "work_order_not_ready"]);
});

// ── Staff read ───────────────────────────────────────────────────────────────

Deno.test("staff read: live figures, invoices, and labour from before approval kept apart", async () => {
  const r = await readJobWorkOrder(baseDb(), { jobId: JOB });
  assertEquals(r.work_order?.id, WO);
  assertEquals(r.figures.billed_to_date_ex, 640);
  assertEquals(r.figures.remaining_ex, 360);
  assertEquals(r.invoices.length, 1);
  assertEquals(r.invoices[0].amount_ex, 640);
  assertEquals(r.labour_lines.map((l) => l.trade_invoice_line_id), ["l1"]);
  assertEquals(r.labour_before_approval.amount_ex, 200);
});

// ── Trade read: no prices, allowances or margins ─────────────────────────────

const redact = {
  scopeItems: (items: any) =>
    (items as any[]).map((i) => ({
      description: i.description,
      qty: i.qty,
      unit: i.unit,
    })),
  text: (v: string) => v,
};

Deno.test("trade read: scope and agreed details only, never agreed labour or prices", async () => {
  const r = await tradeJobWorkOrderRead(baseDb(), JOB, TRADE, redact);
  const text = JSON.stringify(r);
  for (
    const leak of [
      "agreed_labour_ex",
      "1000",
      "price",
      "rate",
      "1800",
      "figures",
      "billed",
      "sealed_content_hash",
    ]
  ) {
    assert(!text.includes(leak), `trade read leaked ${leak}: ${text}`);
  }
  assertEquals((r.work_order as any).scope_items, [{
    description: "Install 20 m Colorbond",
    qty: 20,
    unit: "m",
  }]);
  assertEquals((r.work_order as any).special_instructions, "Rear gate first");
});

Deno.test("trade read: a draft is never shown", async () => {
  const db = baseDb();
  db.tables.work_orders[0].status = "draft";
  const r = await tradeJobWorkOrderRead(db, JOB, TRADE, redact);
  assertEquals(r.work_order, null);
  assertEquals(r.reason, "no_approved_work_order");
});

Deno.test("trade projection is an allowlist", () => {
  const out = projectTradeJobWorkOrder(
    {
      id: WO,
      agreed_labour_ex: 1,
      margin: 2,
      sealed_content_hash: "h",
      scope_items: [],
    },
    {},
    redact,
  );
  assertEquals(Object.keys(out).sort(), [
    "approved_at",
    "id",
    "job_id",
    "job_number",
    "job_type",
    "scheduled_date",
    "scope_items",
    "site_address",
    "special_instructions",
    "status",
    "wo_number",
  ]);
});

// ── Variations and the two emails ────────────────────────────────────────────

Deno.test("emails: one to finance and a separate one to admin, no dashes", () => {
  const emails = buildVariationEmails({
    jobNumber: "SWF-26123",
    siteSuburb: "Duncraig",
    woNumber: "WO-SWF-26123",
    tradeName: "Trade One",
    invoiceNumber: "TI-1",
    description: "Extra post — rock found",
    amountEx: 120,
    figures: null,
  });
  assertEquals(emails.map((e) => [e.recipient_role, e.recipient]), [[
    "finance",
    WORK_ORDER_VARIATION_FINANCE_EMAIL,
  ], ["admin", WORK_ORDER_VARIATION_ADMIN_EMAIL]]);
  for (const e of emails) {
    assert(!/[–—]/.test(e.subject + e.body_text + e.body_html));
    assert(e.body_text.includes("Extra post - rock found"));
  }
});

Deno.test("variation: flag off records both emails and sends nothing", async () => {
  const db = baseDb();
  let sends = 0;
  const out = await reportWorkOrderVariation(
    db,
    {
      trade_invoice_id: INV,
      job_id: JOB,
      description: "Extra post",
      amount_ex: 120,
    },
    { id: TRADE, orgId: ORG, name: "Trade One" },
    {
      sendEmail: async () => {
        sends++;
        return { ok: true };
      },
    },
  );
  assertEquals(sends, 0);
  assertEquals(out.variation.work_order_id, WO);
  assertEquals(out.emails.map((e: any) => e.status), ["recorded", "recorded"]);
  assertEquals(db.tables.work_order_variation_emails.map((e) => e.recipient), [
    WORK_ORDER_VARIATION_FINANCE_EMAIL,
    WORK_ORDER_VARIATION_ADMIN_EMAIL,
  ]);
});

Deno.test("variation: flag on sends each email once", async () => {
  const db = baseDb({
    feature_flags: [{
      flag_name: "work_order_variation_emails_v1",
      enabled: true,
    }],
  });
  const sent: string[] = [];
  const out = await reportWorkOrderVariation(
    db,
    { trade_invoice_id: INV, job_id: JOB, description: "Extra post" },
    { id: TRADE, orgId: ORG },
    {
      sendEmail: async (e) => {
        sent.push(e.recipient);
        return { ok: true };
      },
    },
  );
  assertEquals(sent, [
    WORK_ORDER_VARIATION_FINANCE_EMAIL,
    WORK_ORDER_VARIATION_ADMIN_EMAIL,
  ]);
  assertEquals(out.emails.map((e: any) => e.status), ["sent", "sent"]);
  const again = await reportWorkOrderVariation(
    db,
    { trade_invoice_id: INV, job_id: JOB, description: "Extra post" },
    { id: TRADE, orgId: ORG },
    {
      sendEmail: async (e) => {
        sent.push(e.recipient);
        return { ok: true };
      },
    },
  );
  assertEquals(again.duplicate, true);
  assertEquals(sent.length, 2);
});

Deno.test("variation: only on the trade's own invoice, and only for a job on it", async () => {
  const noSend = { sendEmail: async () => ({ ok: true as const }) };
  const foreign = await assertRejects(
    () =>
      reportWorkOrderVariation(
        baseDb(),
        { trade_invoice_id: INV, job_id: JOB, description: "x" },
        { id: OTHER_TRADE, orgId: ORG },
        noSend,
      ),
    JobWorkOrderError,
  ) as JobWorkOrderError;
  assertEquals(foreign.status, 404);
  const db = baseDb();
  db.tables.trade_invoice_lines = [];
  const offInvoice = await assertRejects(
    () =>
      reportWorkOrderVariation(
        db,
        { trade_invoice_id: INV, job_id: JOB, description: "x" },
        { id: TRADE, orgId: ORG },
        noSend,
      ),
    JobWorkOrderError,
  ) as JobWorkOrderError;
  assertEquals(offInvoice.code, "job_not_on_invoice");
});

// ── Front door: staff doors stay staff, trade doors are profile-scoped ───────

Deno.test("front door: work order staff actions need a staff role, the trade doors do not", async () => {
  const { _opsApiActionNeedsStaffRole } = await import("./index.ts");
  const url = (action: string) =>
    new URL(`https://x.invalid/ops-api?action=${action}`);
  for (
    const staff of [
      "job_work_order",
      "approve_work_order",
      "backfill_job_work_orders",
      "create_work_order",
      "update_work_order",
    ]
  ) {
    assertEquals(_opsApiActionNeedsStaffRole(url(staff)), true, staff);
  }
  for (const trade of ["my_job_work_order", "report_work_order_variation"]) {
    assertEquals(_opsApiActionNeedsStaffRole(url(trade)), false, trade);
  }
});
