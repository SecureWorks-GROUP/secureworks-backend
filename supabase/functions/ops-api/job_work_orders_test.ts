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
  correctWorkOrderVariation,
  createJobWorkOrder,
  JobWorkOrderError,
  jobWorkOrderNeedsChecking,
  listJobWorkOrders,
  projectTradeJobWorkOrder,
  readJobWorkOrder,
  redactJobDetailWorkOrderForTrade,
  reportWorkOrderVariation,
  resendWorkOrderVariationEmails,
  resolveWorkOrderApprover,
  sendOutlookVariationEmail,
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
        const held = rows.find((r) => key.every((k) => r[k] === raw[k]));
        if (held) {
          if (this.upsertOpts?.ignoreDuplicates === false) {
            Object.assign(held, raw);
            out.push(held);
          }
          continue;
        }
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
      (this.lim === null ? matched : matched.slice(0, this.lim)).map((r) => ({
        ...r,
      })),
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
    // The cost lane of each line, as v_trade_charge_resolved answers it.
    v_trade_charge_resolved: [
      { line_id: "l1", cost_lane: "labour" },
      { line_id: "l2", cost_lane: "commission" },
      { line_id: "l3", cost_lane: "labour" },
    ],
    work_order_settings: [{ id: 1, approver_user_ids: [SHAUN] }],
    feature_flags: [],
    job_events: [],
    ...extra,
  });
}

// ── Approver identity ────────────────────────────────────────────────────────

Deno.test("all-types flag: a make-safe is listed and read only while the flag is on", async () => {
  const db = baseDb();
  db.tables.jobs[0].type = "makesafe";
  db.tables.work_orders[0].status = "draft";
  db.tables.work_orders[0].agreed_labour_ex = null;
  db.tables.work_orders[0].jobs = {
    type: "makesafe",
    job_number: "SWMS-1",
    client_name: "Client",
    status: "scheduled",
    site_suburb: "Subiaco",
  };

  const refused = await assertRejects(
    () => listJobWorkOrders(db, new URLSearchParams({ type: "makesafe" })),
    JobWorkOrderError,
  ) as JobWorkOrderError;
  assertEquals(refused.code, "invalid_type");

  const off = await readJobWorkOrder(db, { jobId: JOB, fillFromQuote: true });
  assertEquals(off.eligible, false);
  assertEquals(off.quote_fill, null);

  db.tables.feature_flags.push({
    flag_name: "job_work_order_all_types_v1",
    enabled: true,
  });
  const listed = await listJobWorkOrders(
    db,
    new URLSearchParams({ type: "makesafe" }),
  );
  assertEquals(listed.total, 1);
  assertEquals(listed.work_orders[0].job_type, "makesafe");

  const on = await readJobWorkOrder(db, { jobId: JOB, fillFromQuote: true });
  assertEquals(on.eligible, true);
  assertEquals(on.quote_fill, null);
  assertEquals(on.work_order?.status, "draft");
});

Deno.test("job detail redaction drops the sealed labour allowance", () => {
  const block = redactJobDetailWorkOrderForTrade({
    work_order: { id: "wo", status: "approved", agreed_labour_ex: 400, wo_number: "WO-1" },
    figures: { agreed_ex: 400, remaining_ex: 100 },
    addenda: [{ id: "a", trade_allocation_ex: 80, customer_price_ex: 120, title: "Extra" }],
    invoice_count: 1,
  });
  assertEquals(block.work_order.agreed_labour_ex, undefined);
  assertEquals(block.work_order.wo_number, "WO-1");
  assertEquals(block.figures, null);
  assertEquals(block.addenda, [{ id: "a", title: "Extra" }]);
  assertEquals(block.invoice_count, 1);
  assertEquals(
    redactJobDetailWorkOrderForTrade({ unreadable: true }),
    { unreadable: true },
  );
});

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
    variations: [{
      amount_ex: 150,
      work_order_id: WO,
      counted: true,
    }],
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

Deno.test("figures: a variation counts only while its invoice is billed", async () => {
  const f = computeWorkOrderFigures({
    agreedEx: 1000,
    approved: true,
    lines: [{ amount_ex: 700, counted: true, work_order_id: WO }],
    variations: [
      { amount_ex: 300, work_order_id: WO, counted: false },
      { amount_ex: 300, work_order_id: WO, counted: true },
    ],
  });
  assertEquals(f.variations_ex, 300);
  assertEquals(f.variation_count, 1);
  assertEquals(f.billed_within_agreed_scope_ex, 400);

  // The rejected invoice's variation, then the same variation on the resubmit.
  const db = baseDb({
    work_order_variations: [
      {
        id: "v-rejected",
        job_id: JOB,
        work_order_id: WO,
        trade_invoice_id: "rejected",
        amount_ex: 300,
        trade_invoices: { status: "ops-reject" },
      },
      {
        id: "v-live",
        job_id: JOB,
        work_order_id: WO,
        trade_invoice_id: INV,
        amount_ex: 300,
        trade_invoices: { status: "pending_acknowledgment" },
      },
    ],
  });
  const r = await readJobWorkOrder(db, { jobId: JOB });
  assertEquals(r.figures.variations_ex, 300);
  assertEquals(r.figures.variation_count, 1);
  assertEquals(r.figures.billed_within_agreed_scope_ex, 340);
  assertEquals(r.variations.map((v) => [v.id, v.counted]), [
    ["v-rejected", false],
    ["v-live", true],
  ]);
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
  assertEquals(
    validateJobWorkOrderDraftPatch({
      agreedLabourEx: 5,
      scopeItems: [{ description: "x" }],
      specialInstructions: "x",
    }),
    {},
  );
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

Deno.test("update and list: a job work order is a draft or approved, there is no cancel", async () => {
  const db = draftDb();
  const err = await assertRejects(
    () => updateJobWorkOrderDraft(db, { id: DRAFT, status: "cancelled" }),
    JobWorkOrderError,
  ) as JobWorkOrderError;
  assertEquals([err.status, err.code], [400, "invalid_status"]);
  assertEquals(db.tables.work_orders[0].status, "draft");
  assertEquals(db.tables.jobs[0].work_order_id, WO);
  assertEquals(db.tables.job_events.length, 0);

  const listErr = await assertRejects(
    () => listJobWorkOrders(db, new URLSearchParams({ status: "cancelled" })),
    JobWorkOrderError,
  ) as JobWorkOrderError;
  assertEquals([listErr.status, listErr.code], [400, "invalid_status"]);
});

Deno.test("create: once the job's work order is approved there is no second one", async () => {
  const db = baseDb();
  const err = await assertRejects(
    () =>
      createJobWorkOrder(db, {
        kind: "job",
        job_id: JOB,
        agreed_labour_ex: 5000,
      }),
    JobWorkOrderError,
  ) as JobWorkOrderError;
  assertEquals([err.status, err.code], [409, "work_order_sealed"]);
  assertEquals(db.tables.work_orders.length, 1);
  assertEquals(db.rpcCalls.length, 0);
});

Deno.test("create: edits the job's open draft instead of opening another", async () => {
  const db = draftDb();
  const out = await createJobWorkOrder(db, {
    kind: "job",
    job_id: JOB,
    agreed_labour_ex: 1500,
  });
  assertEquals(out.created, false);
  assertEquals(out.work_order.id, DRAFT);
  assertEquals(db.tables.work_orders.length, 1);
  assertEquals(db.tables.work_orders[0].agreed_labour_ex, 1500);
});

// ── Approve ──────────────────────────────────────────────────────────────────

const READ_AT = "2026-10-06T01:00:00.123456+00:00";

function draftDb(extra: Partial<Tables> = {}) {
  const db = baseDb({
    work_orders: [{
      id: DRAFT,
      org_id: ORG,
      job_id: JOB,
      wo_number: "WO-SWF-26123",
      kind: "job",
      status: "draft",
      agreed_labour_ex: 1200,
      scope_items: [{ description: "x" }],
      updated_at: READ_AT,
    }],
    ...extra,
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
  const out = await approveJobWorkOrder(db, {
    work_order_id: DRAFT,
    expected_updated_at: READ_AT,
  }, {
    userId: SHAUN,
    via: "session",
  });
  assertEquals(out.work_order.status, "approved");
  assertEquals(db.rpcCalls[0], {
    fn: "approve_job_work_order",
    args: {
      p_work_order_id: DRAFT,
      p_approver: SHAUN,
      p_via: "session",
      p_expected_updated_at: READ_AT,
    },
  });
  const event = db.tables.job_events.at(-1);
  assertEquals(event.event_type, "job_work_order_approved");
  assertEquals(event.detail_json, {
    work_order_id: DRAFT,
    wo_number: "WO-SWF-26123",
    approved_by: SHAUN,
    via: "session",
  });
});

Deno.test("events: what this module writes to job_events carries no price, amount or seal hash", async () => {
  const approved = draftDb();
  approved.rpcImpl = (_fn, args) => ({
    data: {
      id: args.p_work_order_id,
      status: "approved",
      agreed_labour_ex: 1234.56,
      sealed_content_hash: "feedfacefeedface",
    },
    error: null,
  });
  approved.tables.work_orders[0].agreed_labour_ex = 1234.56;
  await createJobWorkOrder(approved, {
    kind: "job",
    job_id: JOB,
    agreed_labour_ex: 1234.56,
  });
  await approveJobWorkOrder(approved, {
    work_order_id: DRAFT,
    expected_updated_at: READ_AT,
  }, {
    userId: SHAUN,
    via: "session",
  });

  const reported = baseDb();
  await reportWorkOrderVariation(
    reported,
    {
      trade_invoice_id: INV,
      job_id: JOB,
      description: "Extra post",
      amount_ex: 612.34,
    },
    { id: TRADE, orgId: ORG },
    { sendEmail: async () => ({ ok: true as const }) },
  );

  const events = [...approved.tables.job_events, ...reported.tables.job_events];
  assertEquals(events.map((e) => e.event_type), [
    "job_work_order_draft_updated",
    "job_work_order_approved",
    "work_order_variation_reported",
  ]);
  for (const event of events) {
    const text = JSON.stringify(event);
    for (
      const leak of [
        "1234.56",
        "612.34",
        "feedface",
        "agreed",
        "amount",
        "hash",
      ]
    ) {
      assert(
        !text.includes(leak),
        `${event.event_type} leaked ${leak}: ${text}`,
      );
    }
  }
});

Deno.test("approve: a header-named terminal approver is refused until its flag is on", async () => {
  const terminal = { userId: SHAUN, via: "terminal" as const };
  for (
    const flags of [
      [],
      [{ flag_name: "work_order_terminal_approval_v1", enabled: false }],
    ]
  ) {
    const off = draftDb({ feature_flags: flags });
    const err = await assertRejects(
      () => approveJobWorkOrder(off, { work_order_id: DRAFT }, terminal),
      JobWorkOrderError,
    ) as JobWorkOrderError;
    assertEquals([err.status, err.code], [
      403,
      "terminal_approval_switched_off",
    ]);
    assertEquals(off.rpcCalls.length, 0);
    assertEquals(off.tables.job_events.length, 0);
  }

  const unreadable = draftDb({
    feature_flags: [{
      flag_name: "work_order_terminal_approval_v1",
      enabled: true,
    }],
  });
  unreadable.failOn.add("select:feature_flags");
  assertEquals(
    (await assertRejects(
      () => approveJobWorkOrder(unreadable, { work_order_id: DRAFT }, terminal),
      JobWorkOrderError,
    ) as JobWorkOrderError).code,
    "terminal_approval_switched_off",
  );

  const on = draftDb({
    feature_flags: [{
      flag_name: "work_order_terminal_approval_v1",
      enabled: true,
    }],
  });
  const out = await approveJobWorkOrder(on, {
    work_order_id: DRAFT,
    expected_updated_at: READ_AT,
  }, terminal);
  assertEquals(out.work_order.status, "approved");
  assertEquals(on.rpcCalls[0].args.p_via, "terminal");
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
  stale.rpcImpl = () => ({
    data: null,
    error: {
      code: "WO409",
      message:
        "The draft changed after it was read. Read it again before approving.",
    },
  });
  const staleErr = await assertRejects(
    () =>
      approveJobWorkOrder(stale, {
        work_order_id: DRAFT,
        expected_updated_at: "2026-10-06T00:30:00+00:00",
      }, { userId: SHAUN, via: "session" }),
    JobWorkOrderError,
  ) as JobWorkOrderError;
  assertEquals([staleErr.status, staleErr.code], [409, "stale_review"]);
  assert(staleErr.message.includes("Read it again"));
  assertEquals(stale.tables.job_events.length, 0);

  const notReady = draftDb();
  notReady.rpcImpl = () => ({
    data: null,
    error: { code: "23514", message: "add the scope before approving" },
  });
  const err = await assertRejects(
    () =>
      approveJobWorkOrder(notReady, {
        work_order_id: DRAFT,
        expected_updated_at: READ_AT,
      }, {
        userId: SHAUN,
        via: "session",
      }),
    JobWorkOrderError,
  ) as JobWorkOrderError;
  assertEquals([err.status, err.code], [422, "work_order_not_ready"]);
});

Deno.test("approve: Shaun must send the stamp of the draft he read, and it reaches the database as he read it", async () => {
  const shaun = { userId: SHAUN, via: "session" as const };
  for (
    const body of [
      { work_order_id: DRAFT },
      { work_order_id: DRAFT, expected_updated_at: null },
      { work_order_id: DRAFT, expected_updated_at: "" },
      { work_order_id: DRAFT, expected_updated_at: "yesterday" },
      { work_order_id: DRAFT, expected_updated_at: 1791234567 },
    ]
  ) {
    const db = draftDb();
    const err = await assertRejects(
      () => approveJobWorkOrder(db, body, shaun),
      JobWorkOrderError,
    ) as JobWorkOrderError;
    assertEquals([err.status, err.code], [400, "expected_updated_at_required"]);
    assert(err.message.includes("Read the draft again"));
    assertEquals(db.rpcCalls.length, 0);
    assertEquals(db.tables.work_orders[0].status, "draft");
    assertEquals(db.tables.job_events.length, 0);
  }

  // Shaun read the draft at 2,000. Someone else saved 3,000 since. The
  // database decides under its row lock, so it must be handed the stamp Shaun
  // read, never the one the row carries now.
  const db = draftDb();
  db.tables.work_orders[0].agreed_labour_ex = 2000;
  await updateJobWorkOrderDraft(db, { id: DRAFT, agreed_labour_ex: 3000 });
  db.tables.work_orders[0].updated_at = "2026-10-06T01:05:00.654321+00:00";
  db.rpcImpl = (_fn, args) =>
    args.p_expected_updated_at === db.tables.work_orders[0].updated_at
      ? { data: { id: DRAFT, status: "approved" }, error: null }
      : {
        data: null,
        error: { code: "WO409", message: "The draft changed. Read it again." },
      };
  const err = await assertRejects(
    () =>
      approveJobWorkOrder(db, {
        work_order_id: DRAFT,
        expected_updated_at: READ_AT,
      }, shaun),
    JobWorkOrderError,
  ) as JobWorkOrderError;
  assertEquals([err.status, err.code], [409, "stale_review"]);
  assertEquals(db.rpcCalls[0].args.p_expected_updated_at, READ_AT);
  assertEquals(db.tables.job_events.length, 0);
});

// ── Staff read ───────────────────────────────────────────────────────────────

Deno.test("staff read: live figures, invoices, and labour from before approval kept apart", async () => {
  const r = await readJobWorkOrder(baseDb(), { jobId: JOB });
  assertEquals(r.work_order?.id, WO);
  assertEquals(r.figures.billed_to_date_ex, 640);
  assertEquals(r.figures.remaining_ex, 360);
  assertEquals(r.invoices.length, 1);
  assertEquals(r.invoices[0].amount_ex, 640);
  assertEquals(
    r.lines.map((l) => [l.trade_invoice_line_id, l.cost_lane, l.counted]),
    [["l1", "labour", true], ["l2", "commission", false]],
  );
  assertEquals(r.labour_before_approval.amount_ex, 200);
});

Deno.test("staff read: 1,900 labour plus 400 materials is 1,900 against the agreed labour", async () => {
  const invoice = {
    id: INV,
    user_id: TRADE,
    invoice_number: "TI-1",
    status: "pending_acknowledgment",
    submitted_at: "2026-10-06T01:00:00Z",
    users: { name: "Trade One" },
  };
  const line = (id: string, line_type: string, amount: number) => ({
    id,
    trade_invoice_id: INV,
    job_id: JOB,
    job_work_order_id: WO,
    line_type,
    total_hours: line_type === "labour" ? 8 : null,
    line_total_ex: amount,
    override_amount: null,
    trade_invoices: invoice,
  });
  const db = baseDb({
    trade_invoice_lines: [
      line("lab", "labour", 1900),
      line("mat", "materials", 400),
      line("trv", "travel", 60),
    ],
    v_trade_charge_resolved: [
      { line_id: "lab", cost_lane: "labour" },
      { line_id: "mat", cost_lane: "materials" },
      { line_id: "trv", cost_lane: "other" },
    ],
  });
  db.tables.work_orders[0].agreed_labour_ex = 2000;

  const r = await readJobWorkOrder(db, { jobId: JOB });
  assertEquals(r.figures.billed_to_date_ex, 1900);
  assertEquals(r.figures.remaining_ex, 100);
  assertEquals(r.figures.over_agreed, false);
  assertEquals(r.figures.rules.map((rule) => rule.key), ["near_agreed"]);
  assertEquals(
    r.lines.map((l) => [l.trade_invoice_line_id, l.cost_lane, l.counted]),
    [
      ["lab", "labour", true],
      ["mat", "materials", false],
      ["trv", "other", false],
    ],
  );
  assertEquals(r.invoices.map((i) => [i.amount_ex, i.hours]), [[1900, 8]]);

  const listed = await listJobWorkOrders(db, new URLSearchParams());
  assertEquals(listed.work_orders[0].figures?.billed_to_date_ex, 1900);
  assertEquals(listed.work_orders[0].figures?.over_agreed, false);

  db.failOn.add("select:v_trade_charge_resolved");
  const err = await assertRejects(
    () => readJobWorkOrder(db, { jobId: JOB }),
    JobWorkOrderError,
  ) as JobWorkOrderError;
  assertEquals(err.code, "labour_unreadable");
});

Deno.test("staff read: a 2,000 Work Order pay line is labour, billed 2,000 against the agreed 2,000", async () => {
  // The trade app stores the type lower-cased ('work order'); the shared lane
  // view does not classify it yet, so it answers 'unclassified' for the line.
  for (const workOrderType of ["work order", "work_order"]) {
    const line = (id: string, line_type: string, amount: number) => ({
      id,
      trade_invoice_id: INV,
      job_id: JOB,
      job_work_order_id: WO,
      line_type,
      total_hours: null,
      line_total_ex: amount,
      override_amount: null,
      trade_invoices: {
        id: INV,
        user_id: TRADE,
        invoice_number: "TI-1",
        status: "pending_acknowledgment",
        submitted_at: "2026-10-06T01:00:00Z",
        users: { name: "Trade One" },
      },
    });
    const db = baseDb({
      trade_invoice_lines: [
        line("wo", workOrderType, 2000),
        line("mat", "materials", 400),
        line("trv", "travel", 60),
      ],
      v_trade_charge_resolved: [
        { line_id: "wo", cost_lane: "unclassified" },
        { line_id: "mat", cost_lane: "materials" },
        { line_id: "trv", cost_lane: "other" },
      ],
    });
    db.tables.work_orders[0].agreed_labour_ex = 2000;

    const r = await readJobWorkOrder(db, { jobId: JOB });
    assertEquals(r.figures.billed_to_date_ex, 2000, workOrderType);
    assertEquals(r.figures.remaining_ex, 0, workOrderType);
    assertEquals(r.figures.over_agreed, false, workOrderType);
    assertEquals(
      r.lines.map((l) => [l.trade_invoice_line_id, l.counted]),
      [["wo", true], ["mat", false], ["trv", false]],
      workOrderType,
    );
    assertEquals(r.invoices.map((i) => i.amount_ex), [2000], workOrderType);

    const listed = await listJobWorkOrders(db, new URLSearchParams());
    assertEquals(
      listed.work_orders[0].figures?.billed_to_date_ex,
      2000,
      workOrderType,
    );

    db.tables.trade_invoice_lines.push(line("wo2", workOrderType, 1));
    db.tables.v_trade_charge_resolved.push({
      line_id: "wo2",
      cost_lane: "unclassified",
    });
    const over = await readJobWorkOrder(db, { jobId: JOB });
    assertEquals(over.figures.over_agreed, true, workOrderType);
  }
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
  scopeTextKey: (key: string) => key === "description",
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

Deno.test("trade read: a work order issued automatically shows no amount, rate, allocation or review note either", async () => {
  const db = baseDb();
  Object.assign(db.tables.work_orders[0], {
    approved_by: null,
    approved_via: "auto",
    quote_filled_at: "2026-10-06T00:00:00Z",
    scope_items: [{
      line_key: "extra:3",
      source: "quote",
      basis: "custom",
      description: "Root removal",
      qty: 1,
      unit: "each",
      hours: null,
      rate: null,
      total: null,
      counted: false,
      flags: ["labour_or_material_unknown"],
      needs_review: true,
      quote_cost_ex: 120,
    }],
  });
  const r = await tradeJobWorkOrderRead(db, JOB, TRADE, redact);
  const text = JSON.stringify(r);
  for (
    const leak of [
      "agreed_labour_ex",
      "1000",
      "120",
      "quote_cost_ex",
      "needs_review",
      "labour_or_material_unknown",
      "flags",
      "counted",
      "approved_via",
      "auto",
      "figures",
    ]
  ) {
    assert(!text.includes(leak), `trade read leaked ${leak}: ${text}`);
  }
  assertEquals((r.work_order as any).scope_items, [{
    description: "Root removal",
    qty: 1,
    unit: "each",
  }]);
});

Deno.test("needs checking: why a draft has not gone to the trades, and which lines to check", () => {
  const filled = {
    kind: "job",
    status: "draft",
    scope_items: [{ description: "Install", needs_review: false }],
    agreed_labour_ex: 500,
    quote_filled_at: "2026-10-14T00:00:00Z",
    hand_edited_at: null,
  };
  const held = (wo: any, on: boolean | null) =>
    jobWorkOrderNeedsChecking(wo, on)?.held?.reason;
  assertEquals(held(filled, true), "awaiting_auto_issue");
  assertEquals(held(filled, false), "auto_issue_switched_off");
  assertEquals(
    held({ ...filled, quote_filled_at: null }, true),
    "filled_before_auto_issue",
  );
  assertEquals(
    held({ ...filled, hand_edited_at: "2026-10-14T01:00:00Z" }, true),
    "hand_edited",
  );
  assertEquals(
    held({ ...filled, agreed_labour_ex: null }, true),
    "agreed_labour_missing",
  );
  assertEquals(held({ ...filled, scope_items: [] }, true), "not_filled");
  // Waiting on the switch or the next sweep is not the office's to do.
  assertEquals(jobWorkOrderNeedsChecking(filled, true)?.needs_checking, false);

  const issued = jobWorkOrderNeedsChecking({
    ...filled,
    status: "approved",
    approved_via: "auto",
    scope_items: [
      { line_key: "install:0", description: "Install", needs_review: false },
      {
        line_key: "extra:3",
        description: "Root removal",
        needs_review: true,
        flags: ["labour_or_material_unknown"],
      },
    ],
  }, true)!;
  assertEquals(issued.held, null);
  assertEquals(issued.issued_automatically, true);
  assertEquals(issued.needs_checking, true);
  assertEquals(issued.lines, [{
    line_key: "extra:3",
    description: "Root removal",
    flags: ["labour_or_material_unknown"],
  }]);
  assertEquals(jobWorkOrderNeedsChecking(null, true), null);
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
    "addenda",
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
  assertEquals(again.emails.map((e: any) => e.status), ["sent", "sent"]);
  assertEquals(sent.length, 2);
});

Deno.test("variation: after its draft invoice was replaced, a repeat report on the new invoice sends nothing again", async () => {
  const SUBMITTED = "55555555-5555-4555-8555-555555555555";
  // The database carried the variation, with its sent emails, from the
  // replaced draft to the submitted invoice (carry_work_order_variations).
  const db = baseDb({
    feature_flags: [{
      flag_name: "work_order_variation_emails_v1",
      enabled: true,
    }],
    trade_invoices: [{
      id: SUBMITTED,
      org_id: ORG,
      user_id: TRADE,
      status: "pending_acknowledgment",
      invoice_number: "TI-2",
    }],
    trade_invoice_lines: [{
      id: "s1",
      trade_invoice_id: SUBMITTED,
      job_id: JOB,
      job_work_order_id: WO,
      line_type: "labour",
      line_total_ex: 640,
      override_amount: null,
    }],
    work_order_variations: [{
      id: "v1",
      org_id: ORG,
      job_id: JOB,
      work_order_id: WO,
      trade_invoice_id: SUBMITTED,
      reported_by: TRADE,
      description: "Extra post",
      amount_ex: null,
    }],
    work_order_variation_emails: [
      {
        id: "e1",
        variation_id: "v1",
        recipient_role: "finance",
        status: "sent",
      },
      { id: "e2", variation_id: "v1", recipient_role: "admin", status: "sent" },
    ],
  });
  let sends = 0;
  const out = await reportWorkOrderVariation(
    db,
    { trade_invoice_id: SUBMITTED, job_id: JOB, description: "Extra post" },
    { id: TRADE, orgId: ORG },
    {
      sendEmail: async () => {
        sends++;
        return { ok: true };
      },
    },
  );
  assertEquals(out.duplicate, true);
  assertEquals(out.variation.id, "v1");
  assertEquals(out.emails.map((e: any) => e.status), ["sent", "sent"]);
  assertEquals(sends, 0);
  assertEquals(db.tables.work_order_variations.length, 1);
  assertEquals(db.tables.work_order_variation_emails.length, 2);
});

Deno.test("variation emails: the send request names no job, so the body with the figures is never filed on the job", async () => {
  const db = baseDb({
    feature_flags: [{
      flag_name: "work_order_variation_emails_v1",
      enabled: true,
    }],
    work_order_variations: [],
  });
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl = ((input: unknown, init?: { body?: unknown }) => {
    requests.push({
      url: String(input),
      body: JSON.parse(String(init?.body)),
    });
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as typeof fetch;

  const out = await reportWorkOrderVariation(
    db,
    { trade_invoice_id: INV, job_id: JOB, description: "Extra post" },
    { id: TRADE, orgId: ORG },
    {
      sendEmail: sendOutlookVariationEmail(
        "https://x.invalid",
        "service-key",
        fetchImpl,
      ),
    },
  );
  assertEquals(out.emails.map((e: any) => e.status), ["sent", "sent"]);
  assertEquals(requests.map((r) => [r.url, r.body.to]), [
    [
      "https://x.invalid/functions/v1/send-outlook-email",
      WORK_ORDER_VARIATION_FINANCE_EMAIL,
    ],
    [
      "https://x.invalid/functions/v1/send-outlook-email",
      WORK_ORDER_VARIATION_ADMIN_EMAIL,
    ],
  ]);
  for (const request of requests) {
    assertEquals(Object.keys(request.body).sort(), [
      "htmlBody",
      "mailbox",
      "subject",
      "to",
    ]);
    assert(String(request.body.htmlBody).includes("Agreed labour"));
    assert(!JSON.stringify(request.body).includes(JOB));
    assertEquals(
      request.body.subject,
      "Work order variation on SWF-26123 (Duncraig)",
    );
  }
});

const EMAILS_ON = [{
  flag_name: "work_order_variation_emails_v1",
  enabled: true,
}];
const T0 = Date.parse("2026-10-06T02:00:00Z");
const MINUTE = 60 * 1000;

function emailRow(role: "finance" | "admin", patch: Record<string, unknown>) {
  return {
    id: `e-${role}`,
    variation_id: "v1",
    recipient_role: role,
    recipient: role === "finance"
      ? WORK_ORDER_VARIATION_FINANCE_EMAIL
      : WORK_ORDER_VARIATION_ADMIN_EMAIL,
    subject: "Work order variation on SWF-26123 (Duncraig)",
    body_text: "stored text",
    body_html: "<p>stored html</p>",
    status: "recorded",
    sending_started_at: null,
    ...patch,
  };
}

function variationRow() {
  return {
    id: "v1",
    org_id: ORG,
    job_id: JOB,
    work_order_id: WO,
    trade_invoice_id: INV,
    reported_by: TRADE,
    description: "Extra post",
    amount_ex: null,
  };
}

Deno.test("variation retry: records and sends what the variation still owes, never a sent or in-flight email", async () => {
  const report = (db: FakeDb, sent: string[]) =>
    reportWorkOrderVariation(
      db,
      { trade_invoice_id: INV, job_id: JOB, description: "Extra post" },
      { id: TRADE, orgId: ORG },
      {
        now: () => T0,
        sendEmail: async (e) => {
          sent.push(`${e.recipient_role}:${e.body_html}`);
          return { ok: true };
        },
      },
    );

  // The first call saved the variation and died before any email was written.
  const none = baseDb({
    feature_flags: EMAILS_ON,
    work_order_variations: [variationRow()],
  });
  const sentNone: string[] = [];
  const first = await report(none, sentNone);
  assertEquals(first.duplicate, true);
  assertEquals(first.emails.map((e: any) => e.status), ["sent", "sent"]);
  assertEquals(sentNone.length, 2);
  assertEquals(
    none.tables.work_order_variation_emails.map((e) => e.status),
    ["sent", "sent"],
  );
  assertEquals(none.tables.job_events.length, 0);

  // Finance went out, admin failed: only admin is sent again, from its stored row.
  const partial = baseDb({
    feature_flags: EMAILS_ON,
    work_order_variations: [variationRow()],
    work_order_variation_emails: [
      emailRow("finance", { status: "sent" }),
      emailRow("admin", { status: "failed", send_error: "boom" }),
    ],
  });
  const sentPartial: string[] = [];
  const second = await report(partial, sentPartial);
  assertEquals(second.emails.map((e: any) => e.status), ["sent", "sent"]);
  assertEquals(sentPartial, ["admin:<p>stored html</p>"]);
  assertEquals(partial.tables.work_order_variation_emails.length, 2);

  // In flight a minute ago is left alone; abandoned eleven minutes ago is sent.
  const inFlight = baseDb({
    feature_flags: EMAILS_ON,
    work_order_variations: [variationRow()],
    work_order_variation_emails: [
      emailRow("finance", {
        status: "sending",
        sending_started_at: new Date(T0 - MINUTE).toISOString(),
      }),
      emailRow("admin", {
        status: "sending",
        sending_started_at: new Date(T0 - 11 * MINUTE).toISOString(),
      }),
    ],
  });
  const sentInFlight: string[] = [];
  const third = await report(inFlight, sentInFlight);
  assertEquals(third.emails.map((e: any) => e.status), ["sending", "sent"]);
  assertEquals(sentInFlight, ["admin:<p>stored html</p>"]);

  // Flag off: the retry records the missing rows and sends nothing.
  const off = baseDb({ work_order_variations: [variationRow()] });
  const sentOff: string[] = [];
  const fourth = await report(off, sentOff);
  assertEquals(fourth.emails.map((e: any) => e.status), [
    "recorded",
    "recorded",
  ]);
  assertEquals(sentOff, []);
});

Deno.test("resend: failed and abandoned emails go once; sent, in-flight and recorded ones never do", async () => {
  const rows = () => [
    emailRow("finance", { id: "e-failed", status: "failed", send_error: "x" }),
    emailRow("admin", {
      id: "e-stale",
      status: "sending",
      sending_started_at: new Date(T0 - 11 * MINUTE).toISOString(),
    }),
    emailRow("finance", {
      id: "e-fresh",
      variation_id: "v2",
      status: "sending",
      sending_started_at: new Date(T0 - MINUTE).toISOString(),
    }),
    emailRow("admin", { id: "e-sent", variation_id: "v2", status: "sent" }),
    emailRow("finance", { id: "e-recorded", variation_id: "v3" }),
  ];
  const variations = [
    variationRow(),
    { ...variationRow(), id: "v2" },
    { ...variationRow(), id: "v3" },
  ];

  const off = baseDb({
    work_order_variations: variations,
    work_order_variation_emails: rows(),
  });
  const sentOff: string[] = [];
  const dormant = await resendWorkOrderVariationEmails(off, {
    now: () => T0,
    sendEmail: async (e) => {
      sentOff.push(e.recipient);
      return { ok: true };
    },
  });
  assertEquals(dormant, { sending_on: false, emails: [] });
  assertEquals(sentOff, []);
  assertEquals(
    off.tables.work_order_variation_emails.map((e) => e.status),
    ["failed", "sending", "sending", "sent", "recorded"],
  );

  const db = baseDb({
    feature_flags: EMAILS_ON,
    work_order_variations: variations,
    work_order_variation_emails: rows(),
  });
  const sent: string[] = [];
  const deps = {
    now: () => T0,
    sendEmail: async (e: any) => {
      sent.push(e.recipient_role);
      return { ok: true as const };
    },
  };
  const out = await resendWorkOrderVariationEmails(db, deps);
  assertEquals(out.emails.map((e) => [e.id, e.status]), [
    ["e-failed", "sent"],
    ["e-stale", "sent"],
  ]);
  assertEquals(sent, ["finance", "admin"]);
  assertEquals(
    db.tables.work_order_variation_emails.map((e) => e.status),
    ["sent", "sent", "sending", "sent", "recorded"],
  );

  const again = await resendWorkOrderVariationEmails(db, deps);
  assertEquals(again, { sending_on: true, emails: [] });
  assertEquals(sent.length, 2);
});

Deno.test("resend: a failed send stays failed, and an email another call claimed is not sent again", async () => {
  const db = baseDb({
    feature_flags: EMAILS_ON,
    work_order_variations: [variationRow()],
    work_order_variation_emails: [
      emailRow("finance", { status: "failed" }),
      emailRow("admin", { status: "failed" }),
    ],
  });
  const sent: string[] = [];
  const out = await resendWorkOrderVariationEmails(db, {
    now: () => T0,
    sendEmail: async (e) => {
      sent.push(e.recipient_role);
      // While finance is sending, another call claims admin.
      Object.assign(db.tables.work_order_variation_emails[1], {
        status: "sending",
        sending_started_at: new Date(T0).toISOString(),
      });
      return { ok: false, error: "graph 503" };
    },
  });
  assertEquals(sent, ["finance"]);
  assertEquals(out.emails.map((e) => e.status), [
    "failed",
    "claimed_elsewhere",
  ]);
  assertEquals(
    db.tables.work_order_variation_emails[0].send_error,
    "graph 503",
  );
  assertEquals(db.tables.work_order_variation_emails[1].status, "sending");
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

// The stored variation as PostgREST embeds its reporter and its invoice.
function embedVariationRelations(db: FakeDb) {
  for (const row of db.tables.work_order_variations) {
    row.users = { name: "Trade One" };
    row.trade_invoices = {
      invoice_number: "TI-1",
      status: "pending_acknowledgment",
    };
  }
}

Deno.test("variation: an amount over what the invoice bills on the job is refused", async () => {
  const noSend = { sendEmail: async () => ({ ok: true as const }) };
  const trade = { id: TRADE, orgId: ORG };
  // The invoice bills 500 on the job; the trade types 800 instead of 80.
  const db = baseDb();
  db.tables.trade_invoice_lines = db.tables.trade_invoice_lines
    .filter((l) => l.id !== "l2")
    .map((l) => l.id === "l1" ? { ...l, line_total_ex: 500 } : l);
  const err = await assertRejects(
    () =>
      reportWorkOrderVariation(
        db,
        {
          trade_invoice_id: INV,
          job_id: JOB,
          description: "Extra post",
          amount_ex: 800,
        },
        trade,
        noSend,
      ),
    JobWorkOrderError,
  ) as JobWorkOrderError;
  assertEquals([err.status, err.code], [422, "variation_over_invoice"]);
  assert(err.message.includes("$500.00"));
  assert(!/[\u2013\u2014]/.test(err.message));
  assertEquals(db.tables.work_order_variations.length, 0);
  assertEquals(db.tables.work_order_variation_emails.length, 0);
  assertEquals(db.tables.job_events.length, 0);

  const ok = await reportWorkOrderVariation(
    db,
    {
      trade_invoice_id: INV,
      job_id: JOB,
      description: "Extra post",
      amount_ex: 80,
    },
    trade,
    noSend,
  );
  assertEquals(ok.variation.amount_ex, 80);
  embedVariationRelations(db);
  const read = await readJobWorkOrder(db, { jobId: JOB });
  assertEquals(read.figures.variations_ex, 80);
  assertEquals(read.figures.billed_within_agreed_scope_ex, 420);

  // Only labour counts: 300 labour plus 400 materials on the job refuses 650.
  const mixed = baseDb();
  mixed.tables.trade_invoice_lines = mixed.tables.trade_invoice_lines.map(
    (l) =>
      l.id === "l1"
        ? { ...l, line_total_ex: 300 }
        : l.id === "l2"
        ? { ...l, line_type: "materials", line_total_ex: 400 }
        : l,
  );
  mixed.tables.v_trade_charge_resolved = [
    { line_id: "l1", cost_lane: "labour" },
    { line_id: "l2", cost_lane: "materials" },
    { line_id: "l3", cost_lane: "labour" },
  ];
  const overLabour = await assertRejects(
    () =>
      reportWorkOrderVariation(
        mixed,
        {
          trade_invoice_id: INV,
          job_id: JOB,
          description: "Extra post",
          amount_ex: 650,
        },
        trade,
        noSend,
      ),
    JobWorkOrderError,
  ) as JobWorkOrderError;
  assertEquals([overLabour.status, overLabour.code], [
    422,
    "variation_over_invoice",
  ]);
  assert(overLabour.message.includes("$300.00"));
  assertEquals(mixed.tables.work_order_variations.length, 0);
  const within = await reportWorkOrderVariation(
    mixed,
    {
      trade_invoice_id: INV,
      job_id: JOB,
      description: "Extra post",
      amount_ex: 65,
    },
    trade,
    noSend,
  );
  assertEquals(within.variation.amount_ex, 65);
  embedVariationRelations(mixed);
  const mixedRead = await readJobWorkOrder(mixed, { jobId: JOB });
  assertEquals(mixedRead.figures.billed_within_agreed_scope_ex, 235);
  assertEquals(mixedRead.variations[0].over_invoice_labour, false);

  // A Work Order pay line is labour for the cap, as it is for the totals.
  const payLine = baseDb();
  payLine.tables.trade_invoice_lines = payLine.tables.trade_invoice_lines.map(
    (l) => l.id === "l1" ? { ...l, line_type: "work order" } : l,
  );
  payLine.tables.v_trade_charge_resolved = [
    { line_id: "l1", cost_lane: "unclassified" },
    { line_id: "l2", cost_lane: "commission" },
    { line_id: "l3", cost_lane: "labour" },
  ];
  assertEquals(
    (await reportWorkOrderVariation(
      payLine,
      {
        trade_invoice_id: INV,
        job_id: JOB,
        description: "Extra post",
        amount_ex: 640,
      },
      trade,
      noSend,
    )).variation.amount_ex,
    640,
  );

  // An override is what the line bills.
  const overridden = baseDb();
  overridden.tables.trade_invoice_lines[0].override_amount = 100;
  overridden.tables.trade_invoice_lines[1].line_total_ex = 0;
  assertEquals(
    (await assertRejects(
      () =>
        reportWorkOrderVariation(
          overridden,
          {
            trade_invoice_id: INV,
            job_id: JOB,
            description: "Extra post",
            amount_ex: 120,
          },
          trade,
          noSend,
        ),
      JobWorkOrderError,
    ) as JobWorkOrderError).code,
    "variation_over_invoice",
  );
});

Deno.test("variation: one carried to a draft that bills less labour is kept and reads flagged for staff", async () => {
  const REPLACED = "66666666-6666-4666-8666-666666666666";
  const CARRIED = "77777777-7777-4777-8777-777777777777";
  const WITHIN = "88888888-8888-4888-8888-888888888888";
  // The trade raised 400 on a draft billing 500 labour, then saved the draft
  // again billing 100. The database moved the variation to the replacing row
  // (carry_work_order_variations) and changed nothing on it.
  const db = baseDb({
    work_order_variations: [
      {
        id: CARRIED,
        org_id: ORG,
        job_id: JOB,
        work_order_id: WO,
        trade_invoice_id: REPLACED,
        reported_by: TRADE,
        description: "Extra post",
        amount_ex: 400,
        users: { name: "Trade One" },
        trade_invoices: { invoice_number: null, status: "draft" },
      },
      {
        id: WITHIN,
        org_id: ORG,
        job_id: JOB,
        work_order_id: WO,
        trade_invoice_id: INV,
        reported_by: TRADE,
        description: "Second gate",
        amount_ex: 120,
        users: { name: "Trade One" },
        trade_invoices: {
          invoice_number: "TI-1",
          status: "pending_acknowledgment",
        },
      },
    ],
  });
  db.tables.trade_invoices.push({
    id: REPLACED,
    org_id: ORG,
    user_id: TRADE,
    status: "draft",
    invoice_number: null,
  });
  db.tables.trade_invoice_lines.push(
    {
      id: "d1",
      trade_invoice_id: REPLACED,
      job_id: JOB,
      job_work_order_id: null,
      line_type: "labour",
      line_total_ex: 100,
      override_amount: null,
      trade_invoices: { id: REPLACED, user_id: TRADE, status: "draft" },
    },
    {
      id: "d2",
      trade_invoice_id: REPLACED,
      job_id: JOB,
      job_work_order_id: null,
      line_type: "materials",
      line_total_ex: 900,
      override_amount: null,
      trade_invoices: { id: REPLACED, user_id: TRADE, status: "draft" },
    },
  );
  db.tables.v_trade_charge_resolved.push(
    { line_id: "d1", cost_lane: "labour" },
    { line_id: "d2", cost_lane: "materials" },
  );

  const read = await readJobWorkOrder(db, { jobId: JOB });
  assertEquals(
    read.variations.map((
      v: any,
    ) => [v.id, v.amount_ex, v.over_invoice_labour]),
    [[CARRIED, 400, true], [WITHIN, 120, false]],
  );
  assertEquals(db.tables.work_order_variations[0].amount_ex, 400);
  assertEquals(db.tables.work_order_variations[0].corrected_at ?? null, null);

  // Staff clear it with the existing correction, held to the same labour.
  const deps = { sendEmail: async () => ({ ok: true as const }) };
  assertEquals(
    (await assertRejects(
      () =>
        correctWorkOrderVariation(
          db,
          { variation_id: CARRIED, amount_ex: 150 },
          { actor: `user:${HUGO}`, missing: false },
          deps,
        ),
      JobWorkOrderError,
    ) as JobWorkOrderError).code,
    "variation_over_invoice",
  );
  const corrected = await correctWorkOrderVariation(
    db,
    { variation_id: CARRIED, amount_ex: 100 },
    { actor: `user:${HUGO}`, missing: false },
    deps,
  );
  assertEquals(corrected.variation.over_invoice_labour, false);
  assertEquals(corrected.variation.original_amount_ex, 400);
  const after = await readJobWorkOrder(db, { jobId: JOB });
  assertEquals(
    after.variations.map((v: any) => v.over_invoice_labour),
    [false, false],
  );
});

// ── Staff correction of a variation ──────────────────────────────────────────

const HUGO_ACTOR = { actor: `user:${HUGO}`, missing: false };

async function reportedDb(flags: any[] = []) {
  const db = baseDb({ feature_flags: flags });
  const sent: Array<{ recipient: string; subject: string; body: string }> = [];
  const deps = {
    sendEmail: async (e: any) => {
      sent.push({
        recipient: e.recipient,
        subject: e.subject,
        body: e.body_text,
      });
      return { ok: true as const };
    },
    now: () => T0,
  };
  const out = await reportWorkOrderVariation(
    db,
    {
      trade_invoice_id: INV,
      job_id: JOB,
      description: "Extra psot",
      amount_ex: 600,
    },
    { id: TRADE, orgId: ORG, name: "Trade One" },
    deps,
  );
  embedVariationRelations(db);
  return { db, sent, deps, variationId: out.variation.id as string };
}

Deno.test("correction: staff correct the amount and description; the figures follow and the original is kept", async () => {
  const { db, sent, deps, variationId } = await reportedDb();
  assertEquals(
    (await readJobWorkOrder(db, { jobId: JOB })).figures.variations_ex,
    600,
  );

  const out = await correctWorkOrderVariation(
    db,
    {
      variation_id: variationId,
      description: "Extra post",
      amount_ex: 80,
    },
    HUGO_ACTOR,
    deps,
  );
  assertEquals(out.variation.description, "Extra post");
  assertEquals(out.variation.amount_ex, 80);
  assertEquals(out.variation.original_description, "Extra psot");
  assertEquals(out.variation.original_amount_ex, 600);
  assertEquals(out.variation.corrected_by, `user:${HUGO}`);
  assertEquals(out.variation.corrected_at, new Date(T0).toISOString());

  const read = await readJobWorkOrder(db, { jobId: JOB });
  assertEquals(read.figures.variations_ex, 80);
  assertEquals(read.figures.billed_within_agreed_scope_ex, 560);
  assertEquals(read.variations[0].original_amount_ex, 600);
  assertEquals(read.variations[0].corrected_by, `user:${HUGO}`);

  // A second correction never rewrites what the trade first reported.
  const again = await correctWorkOrderVariation(
    db,
    {
      variation_id: variationId,
      amount_ex: 90,
    },
    { actor: `user:${SHAUN}`, missing: false },
    deps,
  );
  assertEquals(again.variation.description, "Extra post");
  assertEquals(again.variation.amount_ex, 90);
  assertEquals(again.variation.original_description, "Extra psot");
  assertEquals(again.variation.original_amount_ex, 600);
  assertEquals(again.variation.corrected_by, `user:${SHAUN}`);

  // The email flag is off: nothing is sent, and the ledger holds the corrected
  // email, so the 600 one can never go out later.
  assertEquals(sent.length, 0);
  assertEquals(again.emails.map((e: any) => e.status), [
    "recorded",
    "recorded",
  ]);
  for (const row of db.tables.work_order_variation_emails) {
    assert(row.subject.startsWith("Correction: "));
    assert(row.body_text.includes("$90.00"));
    assert(!row.body_text.includes("$600.00"));
  }
  assertEquals(db.tables.work_order_variation_emails.length, 2);

  // The job_events row carries ids only, like every other one.
  const event = db.tables.job_events.at(-1);
  assertEquals(event.event_type, "work_order_variation_corrected");
  assertEquals(event.user_id, SHAUN);
  assertEquals(Object.keys(event.detail_json).sort(), [
    "trade_invoice_id",
    "variation_id",
    "work_order_id",
  ]);
});

Deno.test("correction: with the email flag on, finance and admin each get one email marked as a correction", async () => {
  const { db, sent, deps, variationId } = await reportedDb(EMAILS_ON);
  assertEquals(sent.length, 2);
  sent.length = 0;

  const out = await correctWorkOrderVariation(
    db,
    {
      variation_id: variationId,
      description: "Extra post",
      amount_ex: 80,
    },
    HUGO_ACTOR,
    deps,
  );
  assertEquals(out.emails, [
    { recipient_role: "finance", status: "sent" },
    { recipient_role: "admin", status: "sent" },
  ]);
  assertEquals(sent.map((e) => e.recipient), [
    WORK_ORDER_VARIATION_FINANCE_EMAIL,
    WORK_ORDER_VARIATION_ADMIN_EMAIL,
  ]);
  for (const email of sent) {
    assertEquals(
      email.subject,
      "Correction: work order variation on SWF-26123 (Duncraig)",
    );
    assert(email.body.startsWith("Correction: "));
    assert(email.body.includes("Variation: Extra post"));
    assert(email.body.includes("Variation amount (ex GST): $80.00"));
    assert(email.body.includes("Variation was: Extra psot"));
    assert(email.body.includes("Variation amount was (ex GST): $600.00"));
    assert(!/[\u2013\u2014]/.test(email.subject + email.body));
  }

  // The sweep has nothing left to send for it.
  const sweep = await resendWorkOrderVariationEmails(db, deps);
  assertEquals(sweep.emails, []);
  assertEquals(sent.length, 2);
});

Deno.test("correction: refused above the invoice, with nothing to change, for an unknown variation, or with nobody named", async () => {
  const { db, sent, deps, variationId } = await reportedDb(EMAILS_ON);
  sent.length = 0;
  const refused = async (
    body: any,
    corrector = HUGO_ACTOR,
  ) => (await assertRejects(
    () => correctWorkOrderVariation(db, body, corrector, deps),
    JobWorkOrderError,
  ) as JobWorkOrderError);

  const over = await refused({ variation_id: variationId, amount_ex: 641 });
  assertEquals([over.status, over.code], [422, "variation_over_invoice"]);
  assertEquals(
    (await refused({
      variation_id: variationId,
      description: "Extra psot",
      amount_ex: 600,
    })).code,
    "nothing_to_correct",
  );
  assertEquals(
    (await refused({ variation_id: variationId })).code,
    "nothing_to_correct",
  );
  assertEquals(
    (await refused({ variation_id: crypto.randomUUID(), amount_ex: 80 }))
      .status,
    404,
  );
  const nobody = await refused(
    { variation_id: variationId, amount_ex: 80 },
    { actor: "actor_missing", missing: true },
  );
  assertEquals([nobody.status, nobody.code], [
    403,
    "corrector_identity_missing",
  ]);

  const row = db.tables.work_order_variations[0];
  assertEquals([row.description, row.amount_ex], ["Extra psot", 600]);
  assertEquals(row.corrected_at ?? null, null);
  assertEquals(sent.length, 0);
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
      "resend_work_order_variation_emails",
      "correct_work_order_variation",
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

Deno.test("front door: a trade session cannot call the variation correction; office staff can", async () => {
  const { _authorizeOpsApiAction } = await import("./index.ts");
  const url = new URL(
    "https://x.invalid/ops-api?action=correct_work_order_variation",
  );
  for (const role of ["crew", "trade", "lead_installer", "subcontractor"]) {
    const refused = _authorizeOpsApiAction({
      url,
      authMode: "jwt",
      authUser: { role, managedVerticals: ["fencing", "patio"] },
    });
    assertEquals(
      refused.ok === false && [refused.status, refused.code],
      [403, "operator_access_required"],
      role,
    );
  }
  assertEquals(
    _authorizeOpsApiAction({ url, authMode: "api_key" }).ok,
    false,
  );
  for (const role of ["admin", "owner", "ops_manager"]) {
    assertEquals(
      _authorizeOpsApiAction({ url, authMode: "jwt", authUser: { role } }).ok,
      true,
      role,
    );
  }
});

Deno.test("old work order list: crew work orders only, never the job's own work order", async () => {
  const { listWorkOrders } = await import("./index.ts");
  const db = baseDb();
  db.tables.work_orders.push(
    {
      id: "crew-1",
      org_id: ORG,
      job_id: JOB,
      wo_number: "WO-111111",
      kind: "crew",
      status: "sent",
    },
    {
      id: "crew-cancelled",
      org_id: ORG,
      job_id: JOB,
      wo_number: "WO-222222",
      kind: "crew",
      status: "cancelled",
    },
  );
  const out = await listWorkOrders(db, new URLSearchParams({ job_id: JOB }));
  assertEquals(out.work_orders.map((w: any) => w.id), ["crew-1"]);

  db.tables.work_orders[0].status = "draft";
  const withDraft = await listWorkOrders(
    db,
    new URLSearchParams({ job_id: JOB }),
  );
  assertEquals(withDraft.work_orders.map((w: any) => w.id), ["crew-1"]);
});
