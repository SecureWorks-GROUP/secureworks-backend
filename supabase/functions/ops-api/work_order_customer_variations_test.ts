// deno-lint-ignore-file no-explicit-any no-import-prefix require-await
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  computeWorkOrderFigures,
  customerVariationAddenda,
  customerVariationLabel,
  customerVariationLines,
  JobWorkOrderError,
  readJobWorkOrder,
  tradeJobWorkOrderRead,
} from "./job_work_orders.ts";
import {
  approveCustomerVariation,
  buildCustomerVariationInvoiceLine,
  cancelCustomerVariation,
  createCustomerVariation,
  createCustomerVariationXeroDraft,
  CUSTOMER_VARIATION_CREATING_STALE_AFTER_MS,
  listCustomerVariations,
  prepareCustomerVariationInvoiceLine,
  reconcileCustomerVariationXeroDraft,
  updateCustomerVariation,
  validateCustomerVariationFields,
} from "./work_order_customer_variations.ts";

const SHAUN = "9913309f-35ae-4a71-8e1f-f704ecc526ea";
const ESTHER = "b353f39a-b3cc-495d-a016-50ebf4a8497d";
const TRADE = "aaaaaaaa-0000-4000-8000-00000000000a";
const ORG = "00000000-0000-0000-0000-000000000001";
const JOB = "11111111-1111-4111-8111-111111111111";
const WO = "22222222-2222-4222-8222-222222222222";
const VAR = "55555555-5555-4555-8555-555555555555";
const XERO_CONTACT = "66666666-6666-4666-8666-666666666666";
const STAMP = "2026-10-13T02:00:00.123456+00:00";
const APPROVED_AT = "2026-10-13T03:30:00+00:00";
const ESTHER_ACTOR = { actor: `user:${ESTHER}`, missing: false };
const NOBODY = { actor: "actor_missing", missing: true };

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
  private op: "select" | "insert" | "update" = "select";
  private payload: any = null;
  private mode: "one" | "maybe" | null = null;
  constructor(private db: FakeDb, private table: string) {}
  select(cols?: string) {
    if (this.op === "select") {
      this.db.selects.push({ table: this.table, cols: cols || "*" });
    }
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
  eq(col: string, val: any) {
    this.filters.push((r) => get(r, col) === val);
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
  limit() {
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
      const row = {
        id: crypto.randomUUID(),
        created_at: this.db.tick(),
        updated_at: this.db.tick(),
        status: this.table === "work_order_customer_variation_invoices"
          ? "prepared"
          : "draft",
        ...this.payload,
      };
      if (
        this.table === "work_order_customer_variation_invoices" &&
        rows.some((r) => r.variation_id === row.variation_id)
      ) {
        return { data: null, error: { code: "23505", message: "duplicate" } };
      }
      rows.push(row);
      return this.finish([row]);
    }
    const matched = rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.op === "update") {
      for (const r of matched) {
        Object.assign(r, this.payload, { updated_at: this.db.tick() });
      }
      return this.finish(matched.map((r) => ({ ...r })));
    }
    return this.finish(matched.map((r) => ({ ...r })));
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
  selects: Array<{ table: string; cols: string }> = [];
  failOn = new Set<string>();
  rpcCalls: Array<{ fn: string; args: any }> = [];
  private n = 0;
  constructor(public tables: Tables) {}
  tick() {
    this.n++;
    return `2026-10-13T02:00:${String(this.n).padStart(2, "0")}.000001+00:00`;
  }
  from(table: string) {
    return new Query(this, table);
  }
  // The approval as approve_work_order_customer_variation does it.
  rpc(fn: string, args: any) {
    this.rpcCalls.push({ fn, args });
    if (fn !== "approve_work_order_customer_variation") {
      return Promise.resolve({ data: null, error: { code: "42883" } });
    }
    const v = this.tables.work_order_customer_variations.find((r) =>
      r.id === args.p_variation_id
    );
    if (!v) return Promise.resolve({ data: null, error: { code: "P0002" } });
    if (v.updated_at !== args.p_expected_updated_at) {
      return Promise.resolve({
        data: null,
        error: { code: "WO409", message: "changed" },
      });
    }
    const wo = this.tables.work_orders.find((w) =>
      w.job_id === v.job_id && w.kind === "job" && w.status === "approved"
    );
    if (!wo) {
      return Promise.resolve({
        data: null,
        error: { code: "WO422", message: "approve the work order first" },
      });
    }
    const n = Math.max(
      0,
      ...this.tables.work_order_customer_variations
        .filter((r) => r.work_order_id === wo.id)
        .map((r) => r.variation_number),
    ) + 1;
    Object.assign(v, {
      status: "approved",
      work_order_id: wo.id,
      variation_number: n,
      approved_by: args.p_approver,
      approved_via: args.p_via,
      approved_at: APPROVED_AT,
      updated_at: this.tick(),
    });
    return Promise.resolve({ data: { ...v }, error: null });
  }
}

function variationRow(patch: Record<string, unknown> = {}) {
  return {
    id: VAR,
    org_id: ORG,
    job_id: JOB,
    work_order_id: null,
    variation_number: null,
    status: "draft",
    description: "Extra works as discussed",
    tasks: [
      {
        description: "Remove the tree roots between 378/1 and 378/2",
        hours: 3,
      },
      { description: "Extend the fence", hours: 2, qty: 6, unit: "m" },
    ],
    trade_allocation_ex: 450,
    customer_price_ex: 921.6,
    created_by: `user:${ESTHER}`,
    approved_at: null,
    approved_by: null,
    approved_via: null,
    created_at: STAMP,
    updated_at: STAMP,
    ...patch,
  };
}

function db(extra: Partial<Tables> = {}) {
  return new FakeDb({
    jobs: [{
      id: JOB,
      org_id: ORG,
      job_number: "SWF-26904",
      client_name: "Client",
      type: "fencing",
      status: "in_progress",
      site_address: "378/2 The Strand",
      site_suburb: "Dianella",
      work_order_id: WO,
    }],
    work_orders: [{
      id: WO,
      org_id: ORG,
      job_id: JOB,
      wo_number: "WO-SWF-26904",
      kind: "job",
      status: "approved",
      scope_items: [{
        line_key: "install:0",
        source: "quote",
        description: "Install Ridgeside fence",
        qty: 37.6,
        unit: "m",
        hours: null,
        rate: 35,
        total: 1316,
        quote_cost_ex: 1316,
      }, {
        line_key: "extra:3",
        source: "quote",
        description: "Root removal / hard digging",
        qty: 2,
        unit: "hrs",
        hours: 2,
        rate: 80,
        total: 160,
      }],
      special_instructions: "Rear gate first",
      agreed_labour_ex: 1526,
      approved_at: "2026-10-06T00:00:00Z",
      updated_at: "2026-10-06T00:00:00Z",
    }],
    work_order_customer_variations: [variationRow()],
    work_order_customer_variation_invoices: [],
    trade_invoices: [],
    trade_invoice_lines: [],
    work_order_variations: [],
    v_trade_charge_resolved: [],
    work_order_settings: [{ id: 1, approver_user_ids: [SHAUN] }],
    feature_flags: [],
    job_events: [],
    ...extra,
  });
}

async function refused(
  fn: () => Promise<unknown>,
  status: number,
  code: string,
) {
  const e = await assertRejects(fn, JobWorkOrderError);
  assertEquals([e.status, e.code], [status, code], e.message);
}

// ── Recording and editing ────────────────────────────────────────────────────

Deno.test("create: the office records a draft with tasks and hours, the allocation and the price", async () => {
  const d = db({ work_order_customer_variations: [] });
  const r = await createCustomerVariation(d, {
    job_id: JOB,
    description: "Extra works as discussed",
    tasks: [{ description: "Remove tree roots", hours: 3 }],
    trade_allocation_ex: 135,
    customer_price_ex: 320,
  }, ESTHER_ACTOR);
  const v = r.customer_variation;
  assertEquals(v.status, "draft");
  assertEquals(v.tasks, [{ description: "Remove tree roots", hours: 3 }]);
  assertEquals(v.hours_total, 3);
  assertEquals([v.trade_allocation_ex, v.customer_price_ex], [135, 320]);
  assertEquals(v.work_order_id, null);
  assertEquals(v.variation_number, null);
  assertEquals(
    d.tables.work_order_customer_variations[0].created_by,
    `user:${ESTHER}`,
  );
  assertEquals(d.tables.job_events.map((e) => e.event_type), [
    "customer_variation_recorded",
  ]);
});

Deno.test("create: every task needs its hours; prices stay out of the words; fencing and patio only; someone is named", async () => {
  const d = db({ work_order_customer_variations: [] });
  const base = { job_id: JOB, description: "Extra works" };
  await refused(
    () =>
      createCustomerVariation(d, {
        ...base,
        tasks: [{ description: "Root removal" }],
      }, ESTHER_ACTOR),
    400,
    "invalid_tasks",
  );
  await refused(
    () =>
      createCustomerVariation(d, {
        ...base,
        tasks: [{ description: "Root removal", hours: 0 }],
      }, ESTHER_ACTOR),
    400,
    "invalid_tasks",
  );
  await refused(
    () =>
      createCustomerVariation(d, {
        ...base,
        tasks: [{ description: "Root removal", hours: 2, qty: 1 }],
      }, ESTHER_ACTOR),
    400,
    "invalid_tasks",
  );
  await refused(
    () =>
      createCustomerVariation(d, {
        ...base,
        tasks: [{ description: "Root removal $160", hours: 2 }],
      }, ESTHER_ACTOR),
    400,
    "money_in_text",
  );
  await refused(
    () =>
      createCustomerVariation(d, {
        job_id: JOB,
        description: "Variation $320",
      }, ESTHER_ACTOR),
    400,
    "money_in_text",
  );
  await refused(
    () =>
      createCustomerVariation(
        d,
        { ...base, customer_price_ex: "320" },
        ESTHER_ACTOR,
      ),
    400,
    "invalid_customer_price_ex",
  );
  await refused(
    () => createCustomerVariation(d, base, NOBODY),
    403,
    "actor_identity_missing",
  );
  d.tables.jobs[0].type = "makesafe";
  await refused(
    () => createCustomerVariation(d, base, ESTHER_ACTOR),
    422,
    "job_type_not_eligible",
  );
  assertEquals(d.tables.work_order_customer_variations.length, 0);
});

Deno.test("validation: a quantity task keeps its unit and its hours; unknown keys are not stored", () => {
  const out = validateCustomerVariationFields({
    description: "Extend the fence",
    tasks: [{
      description: "Extra panels",
      hours: 2.5,
      qty: 6,
      unit: "m",
      rate: 45,
      total: 112.5,
    }],
  }, { create: true });
  assertEquals(out.tasks, [{
    description: "Extra panels",
    hours: 2.5,
    qty: 6,
    unit: "m",
  }]);
});

Deno.test("update: edits a draft only as it was read", async () => {
  const d = db();
  const r = await updateCustomerVariation(d, {
    variation_id: VAR,
    expected_updated_at: STAMP,
    customer_price_ex: 1013.76,
  }, ESTHER_ACTOR);
  assertEquals(r.customer_variation.customer_price_ex, 1013.76);
  // The stamp moved: the same read cannot write again.
  await refused(
    () =>
      updateCustomerVariation(d, {
        variation_id: VAR,
        expected_updated_at: STAMP,
        customer_price_ex: 1,
      }, ESTHER_ACTOR),
    409,
    "stale_review",
  );
  await refused(
    () =>
      updateCustomerVariation(
        d,
        { variation_id: VAR, customer_price_ex: 1 },
        ESTHER_ACTOR,
      ),
    400,
    "expected_updated_at_required",
  );
  await refused(
    () =>
      updateCustomerVariation(d, {
        variation_id: VAR,
        expected_updated_at: r.customer_variation.updated_at,
      }, ESTHER_ACTOR),
    400,
    "nothing_to_update",
  );
  assertEquals(
    d.tables.work_order_customer_variations[0].customer_price_ex,
    1013.76,
  );
});

Deno.test("update and cancel: an approved variation is sealed", async () => {
  const d = db({
    work_order_customer_variations: [variationRow({
      status: "approved",
      work_order_id: WO,
      variation_number: 1,
      approved_at: APPROVED_AT,
      approved_by: SHAUN,
    })],
  });
  await refused(
    () =>
      updateCustomerVariation(d, {
        variation_id: VAR,
        expected_updated_at: STAMP,
        description: "Changed",
      }, ESTHER_ACTOR),
    409,
    "variation_sealed",
  );
  await refused(
    () =>
      cancelCustomerVariation(d, {
        variation_id: VAR,
        expected_updated_at: STAMP,
      }, ESTHER_ACTOR),
    409,
    "variation_sealed",
  );
  assertEquals(d.tables.work_order_customer_variations[0].status, "approved");
});

Deno.test("cancel: a draft is cancelled with who and why, and never joins the work order", async () => {
  const d = db();
  const r = await cancelCustomerVariation(d, {
    variation_id: VAR,
    expected_updated_at: STAMP,
    reason: "Customer declined",
  }, ESTHER_ACTOR);
  assertEquals(r.customer_variation.status, "cancelled");
  assertEquals(r.customer_variation.cancelled_by, `user:${ESTHER}`);
  assertEquals(r.customer_variation.cancel_reason, "Customer declined");
  const read = await readJobWorkOrder(d, { jobId: JOB });
  assertEquals(read.addenda, []);
  assertEquals(read.figures.agreed_total_ex, 1526);
});

// ── Approval ─────────────────────────────────────────────────────────────────

Deno.test("approve: only the work order approver, from a session, with the stamp as read", async () => {
  const d = db();
  await refused(
    () =>
      approveCustomerVariation(d, {
        variation_id: VAR,
        expected_updated_at: STAMP,
      }, null),
    403,
    "approver_identity_missing",
  );
  await refused(
    () =>
      approveCustomerVariation(d, {
        variation_id: VAR,
        expected_updated_at: STAMP,
      }, {
        userId: ESTHER,
        via: "session",
      }),
    403,
    "approver_required",
  );
  await refused(
    () =>
      approveCustomerVariation(d, {
        variation_id: VAR,
        expected_updated_at: STAMP,
      }, {
        userId: SHAUN,
        via: "terminal",
      }),
    403,
    "terminal_approval_switched_off",
  );
  await refused(
    () =>
      approveCustomerVariation(d, { variation_id: VAR }, {
        userId: SHAUN,
        via: "session",
      }),
    400,
    "expected_updated_at_required",
  );
  await refused(
    () =>
      approveCustomerVariation(d, {
        variation_id: VAR,
        expected_updated_at: "2026-10-13T01:00:00Z",
      }, { userId: SHAUN, via: "session" }),
    409,
    "stale_review",
  );
  assertEquals(d.tables.work_order_customer_variations[0].status, "draft");

  const r = await approveCustomerVariation(d, {
    variation_id: VAR,
    expected_updated_at: STAMP,
  }, { userId: SHAUN, via: "session" });
  assertEquals(r.customer_variation.status, "approved");
  assertEquals(r.customer_variation.work_order_id, WO);
  assertEquals(r.customer_variation.variation_number, 1);
  assertEquals(
    r.customer_variation.label,
    "Variation 1 - approved 13 Oct 2026",
  );
  assertEquals(d.rpcCalls[d.rpcCalls.length - 1].args, {
    p_variation_id: VAR,
    p_approver: SHAUN,
    p_via: "session",
    p_expected_updated_at: STAMP,
  });
  await refused(
    () =>
      approveCustomerVariation(d, {
        variation_id: VAR,
        expected_updated_at: STAMP,
      }, {
        userId: SHAUN,
        via: "session",
      }),
    409,
    "not_a_draft",
  );
});

Deno.test("approve: the job's work order must be approved first", async () => {
  const d = db();
  d.tables.work_orders[0].status = "draft";
  await refused(
    () =>
      approveCustomerVariation(d, {
        variation_id: VAR,
        expected_updated_at: STAMP,
      }, {
        userId: SHAUN,
        via: "session",
      }),
    409,
    "work_order_not_approved",
  );
});

Deno.test("events: customer variation events carry ids only, never an amount", async () => {
  const d = db({ work_order_customer_variations: [] });
  const { customer_variation: v } = await createCustomerVariation(d, {
    job_id: JOB,
    description: "Extra works",
    tasks: [{ description: "Remove roots", hours: 3 }],
    trade_allocation_ex: 135.55,
    customer_price_ex: 320.15,
  }, ESTHER_ACTOR);
  const { customer_variation: edited } = await updateCustomerVariation(d, {
    variation_id: v.id,
    expected_updated_at: v.updated_at,
    trade_allocation_ex: 140.45,
  }, ESTHER_ACTOR);
  await approveCustomerVariation(d, {
    variation_id: v.id,
    expected_updated_at: edited.updated_at,
  }, { userId: SHAUN, via: "session" });
  await prepareCustomerVariationInvoiceLine(
    d,
    { variation_id: v.id },
    ESTHER_ACTOR,
    {
      accountCodeForJob: () => "207",
    },
  );
  const text = JSON.stringify(d.tables.job_events);
  // Amounts with cents: a uuid (hex and dashes) can never contain one.
  for (
    const leak of [
      "135.55",
      "140.45",
      "320.15",
      "price",
      "allocation",
      "amount",
    ]
  ) {
    assert(!text.includes(leak), `job_events leaked ${leak}: ${text}`);
  }
  assertEquals(d.tables.job_events.map((e) => e.event_type), [
    "customer_variation_recorded",
    "customer_variation_updated",
    "customer_variation_approved",
    "customer_variation_invoice_line_prepared",
  ]);
});

// ── The addendum on the work order and the figures ───────────────────────────

Deno.test("addenda: a variation's tasks become marked lines with their hours", () => {
  assertEquals(customerVariationLines(2, variationRow().tasks), [
    {
      line_key: "variation:2:0",
      source: "variation",
      is_variation: true,
      variation_number: 2,
      description: "Remove the tree roots between 378/1 and 378/2",
      qty: 3,
      unit: "hrs",
      hours: 3,
    },
    {
      line_key: "variation:2:1",
      source: "variation",
      is_variation: true,
      variation_number: 2,
      description: "Extend the fence",
      qty: 6,
      unit: "m",
      hours: 2,
    },
  ]);
  // The approval day is Perth's: 31 Oct 17:00 UTC is 1 Nov in Perth.
  assertEquals(
    customerVariationLabel(3, "2026-10-31T17:00:00Z"),
    "Variation 3 - approved 1 Nov 2026",
  );
  const rows = [
    variationRow({
      id: "a",
      status: "approved",
      work_order_id: WO,
      variation_number: 2,
      approved_at: APPROVED_AT,
    }),
    variationRow({
      id: "b",
      status: "approved",
      work_order_id: WO,
      variation_number: 1,
      approved_at: APPROVED_AT,
    }),
    variationRow({ id: "c" }),
    variationRow({ id: "d", status: "cancelled" }),
  ];
  assertEquals(customerVariationAddenda(rows, WO).map((a) => a.id), ["b", "a"]);
  assertEquals(customerVariationAddenda(rows, null), []);
});

Deno.test("figures: approved customer variations raise the agreed total that billed and remaining are measured against", () => {
  const lines = [{ amount_ex: 1800, counted: true, work_order_id: WO }];
  const without = computeWorkOrderFigures({
    agreedEx: 1526,
    approved: true,
    lines,
    variations: [],
  });
  assertEquals(without.over_agreed, true);
  assertEquals(without.agreed_total_ex, 1526);
  const withVariation = computeWorkOrderFigures({
    agreedEx: 1526,
    approved: true,
    lines,
    variations: [],
    customerVariations: [
      {
        status: "approved",
        work_order_id: WO,
        trade_allocation_ex: 450,
        customer_price_ex: 921.6,
      },
      {
        status: "draft",
        work_order_id: null,
        trade_allocation_ex: 999,
        customer_price_ex: 999,
      },
      {
        status: "cancelled",
        work_order_id: null,
        trade_allocation_ex: 999,
        customer_price_ex: 999,
      },
    ],
  });
  assertEquals(withVariation.agreed_ex, 1526);
  assertEquals(withVariation.customer_variations_ex, 450);
  assertEquals(withVariation.customer_variations_price_ex, 921.6);
  assertEquals(withVariation.customer_variation_count, 1);
  assertEquals(withVariation.agreed_total_ex, 1976);
  assertEquals(withVariation.remaining_ex, 176);
  assertEquals(withVariation.over_agreed, false);
  assertEquals(
    withVariation.rules.map((r) => r.key),
    ["near_agreed", "has_customer_variations"],
  );
  // Before the work order is approved nothing counts, variations included.
  const unapproved = computeWorkOrderFigures({
    agreedEx: 1526,
    approved: false,
    lines,
    variations: [],
    customerVariations: [
      {
        status: "approved",
        work_order_id: WO,
        trade_allocation_ex: 450,
        customer_price_ex: 921.6,
      },
    ],
  });
  assertEquals(unapproved.customer_variations_ex, 0);
  assertEquals(unapproved.agreed_total_ex, null);
});

Deno.test("staff read: the work order keeps its sealed lines and returns the addenda and the agreed total", async () => {
  const d = db({
    work_order_customer_variations: [
      variationRow({
        status: "approved",
        work_order_id: WO,
        variation_number: 1,
        approved_at: APPROVED_AT,
        approved_by: SHAUN,
      }),
      variationRow({ id: "draft-2", description: "Not agreed yet" }),
    ],
  });
  const sealedLines = JSON.stringify(d.tables.work_orders[0].scope_items);
  const r = await readJobWorkOrder(d, { jobId: JOB });
  assertEquals(JSON.stringify(r.work_order.scope_items), sealedLines);
  assertEquals(r.addenda.length, 1);
  assertEquals(r.addenda[0].label, "Variation 1 - approved 13 Oct 2026");
  assertEquals(r.addenda[0].hours_total, 5);
  assertEquals(r.addenda[0].trade_allocation_ex, 450);
  assertEquals(r.addenda[0].customer_price_ex, 921.6);
  assertEquals(r.addenda[0].lines.map((l) => l.line_key), [
    "variation:1:0",
    "variation:1:1",
  ]);
  assertEquals(r.figures.agreed_total_ex, 1976);
  assertEquals(r.figures.remaining_ex, 1976);
  assertEquals(r.customer_variations.map((v) => v.status), [
    "approved",
    "draft",
  ]);
});

// ── The trade's view: hours and marked variation lines, never money ──────────

const MONEY_KEYS = [
  "trade_allocation_ex",
  "customer_price_ex",
  "customer_variations_ex",
  "customer_variations_price_ex",
  "agreed_labour_ex",
  "agreed_total_ex",
  "agreed_ex",
  "remaining_ex",
  "billed_to_date_ex",
  "figures",
  "rate",
  "total",
  "price",
  "quote_cost_ex",
  "unit_price",
  "amount",
  "amount_ex",
  "cost",
  "sealed_content_hash",
];

function assertNoMoney(value: unknown) {
  const text = JSON.stringify(value);
  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        assert(!MONEY_KEYS.includes(k), `trade view carries ${k}: ${text}`);
        walk(v);
      }
    }
  };
  walk(value);
  for (const figure of ["$", "450", "921", "1526", "1316", "1976", "1013"]) {
    assert(!text.includes(figure), `trade view carries ${figure}: ${text}`);
  }
}

Deno.test("trade view: every trade, the lead trade included, sees hours and marked variation lines and no dollar amount", async () => {
  const { tradeJobWorkOrderRedaction } = await import("./index.ts");
  const d = db({
    work_order_customer_variations: [
      variationRow({
        status: "approved",
        work_order_id: WO,
        variation_number: 1,
        approved_at: APPROVED_AT,
        approved_by: SHAUN,
        sealed_content_hash: "deadbeef",
        // A task saved with money keys never reaches the trade either.
        tasks: [
          {
            description: "Remove the tree roots between the two units",
            hours: 3,
            rate: 45,
            total: 135,
            cost_price: 45,
          },
        ],
      }),
      variationRow({ id: "draft-2", description: "Draft never shown" }),
    ],
  });
  // my_job_work_order has one view for every trade: the lead trade reads the
  // same response as the crew.
  const r = await tradeJobWorkOrderRead(
    d,
    JOB,
    TRADE,
    tradeJobWorkOrderRedaction,
  );
  assertNoMoney(r);
  const wo = r.work_order as any;
  assertEquals(wo.scope_items, [
    {
      description: "Install Ridgeside fence",
      qty: 37.6,
      unit: "m",
      hours: null,
    },
    {
      description: "Root removal / hard digging",
      qty: 2,
      unit: "hrs",
      hours: 2,
    },
  ]);
  assertEquals(wo.addenda, [{
    variation_number: 1,
    label: "Variation 1 - approved 13 Oct 2026",
    approved_at: APPROVED_AT,
    description: "Extra works as discussed",
    scope_items: [{
      description: "Remove the tree roots between the two units",
      qty: 3,
      unit: "hrs",
      hours: 3,
      is_variation: true,
      variation_number: 1,
    }],
  }]);
  assert(!JSON.stringify(r).includes("Draft never shown"));
  // The read itself never asks the database for a money column.
  const select = d.selects.find((s) =>
    s.table === "work_order_customer_variations"
  );
  assert(select, "the trade read reads the addenda");
  for (
    const col of [
      "trade_allocation_ex",
      "customer_price_ex",
      "sealed_content_hash",
    ]
  ) {
    assert(!select!.cols.includes(col), `trade read selects ${col}`);
  }
});

Deno.test("trade view: a variation written with money words reads as withheld, its amount never shown", async () => {
  const { tradeJobWorkOrderRedaction } = await import("./index.ts");
  const d = db({
    work_order_customer_variations: [variationRow({
      status: "approved",
      work_order_id: WO,
      variation_number: 1,
      approved_at: APPROVED_AT,
      description: "Extra works, call-out fee included",
      tasks: [{ description: "Dig out roots, fee 921.60", hours: 3 }],
    })],
  });
  const r = await tradeJobWorkOrderRead(
    d,
    JOB,
    TRADE,
    tradeJobWorkOrderRedaction,
  );
  assertNoMoney(r);
  const addendum = (r.work_order as any).addenda[0];
  assertEquals(
    addendum.description,
    "Line withheld. Ask the office for this detail.",
  );
  assertEquals(
    addendum.scope_items[0].description,
    "Line withheld. Ask the office for this detail.",
  );
  assertEquals(addendum.scope_items[0].hours, 3);
});

// ── The customer invoice line ────────────────────────────────────────────────

const approvedDb = () =>
  db({
    work_order_customer_variations: [variationRow({
      status: "approved",
      work_order_id: WO,
      variation_number: 1,
      approved_at: APPROVED_AT,
      approved_by: SHAUN,
    })],
  });
const accounts = {
  accountCodeForJob: (t: string) => (t === "fencing" ? "207" : "200"),
};

Deno.test("invoice line: built from the approved record, one line at the customer price, no hours or allocation", () => {
  const line = buildCustomerVariationInvoiceLine(
    variationRow({ variation_number: 1, approved_at: APPROVED_AT }),
    "207",
  );
  assertEquals(line, {
    description:
      "Variation 1 - approved 13 Oct 2026: Extra works as discussed\n" +
      "- Remove the tree roots between 378/1 and 378/2\n- Extend the fence",
    quantity: 1,
    unit_price: 921.6,
    account_code: "207",
  });
});

Deno.test("invoice line: prepared only from an approved variation that charges something, kept once, nothing sent to Xero", async () => {
  await refused(
    () =>
      prepareCustomerVariationInvoiceLine(
        db(),
        { variation_id: VAR },
        ESTHER_ACTOR,
        accounts,
      ),
    409,
    "variation_not_approved",
  );
  const free = approvedDb();
  free.tables.work_order_customer_variations[0].customer_price_ex = 0;
  await refused(
    () =>
      prepareCustomerVariationInvoiceLine(
        free,
        { variation_id: VAR },
        ESTHER_ACTOR,
        accounts,
      ),
    422,
    "no_customer_charge",
  );

  const d = approvedDb();
  const r = await prepareCustomerVariationInvoiceLine(
    d,
    { variation_id: VAR },
    ESTHER_ACTOR,
    accounts,
  );
  assertEquals(r.line.unit_price, 921.6);
  assertEquals(r.invoice?.status, "prepared");
  assertEquals(r.xero_draft_switched_on, false);
  assertEquals(r.create_invoice_draft, {
    job_id: JOB,
    line_items: [r.line],
    reference: "SWF-26904 Variation 1",
  });
  await prepareCustomerVariationInvoiceLine(
    d,
    { variation_id: VAR },
    ESTHER_ACTOR,
    accounts,
  );
  assertEquals(d.tables.work_order_customer_variation_invoices.length, 1);
  assertEquals(d.rpcCalls, []);

  const listed = await listCustomerVariations(d, JOB);
  assertEquals(listed.customer_variations[0].invoice?.status, "prepared");
});

Deno.test("Xero draft: switched off by default, and nothing is called", async () => {
  const d = approvedDb();
  let calls = 0;
  await refused(
    () =>
      createCustomerVariationXeroDraft(
        d,
        { variation_id: VAR, xero_contact_id: XERO_CONTACT },
        ESTHER_ACTOR,
        {
          ...accounts,
          createDraft: async () => {
            calls++;
            return { ok: true };
          },
        },
      ),
    403,
    "xero_draft_switched_off",
  );
  assertEquals(calls, 0);
  assertEquals(d.tables.work_order_customer_variation_invoices.length, 0);
});

const flagOn = [{
  flag_name: "customer_variation_xero_draft_v1",
  enabled: true,
}];

Deno.test("Xero draft: with the flag on, one confirmed DRAFT per variation through create_invoice_draft", async () => {
  const d = approvedDb();
  d.tables.feature_flags = flagOn;
  const payloads: any[] = [];
  const deps = {
    ...accounts,
    createDraft: async (payload: any) => {
      payloads.push(payload);
      return {
        ok: true,
        status: "DRAFT",
        xero_invoice_id: "77777777-7777-4777-8777-777777777777",
        invoice_number: "INV-2001",
      };
    },
  };
  const r = await createCustomerVariationXeroDraft(
    d,
    {
      variation_id: VAR,
      xero_contact_id: XERO_CONTACT,
    },
    ESTHER_ACTOR,
    deps,
  );
  assertEquals(r.duplicate, false);
  assertEquals(r.invoice?.status, "xero_draft_created");
  assertEquals(r.invoice?.invoice_number, "INV-2001");
  assertEquals(payloads, [{
    job_id: JOB,
    line_items: [r.line],
    reference: "SWF-26904 Variation 1",
    xero_contact_id: XERO_CONTACT,
  }]);
  const again = await createCustomerVariationXeroDraft(
    d,
    {
      variation_id: VAR,
      xero_contact_id: XERO_CONTACT,
    },
    ESTHER_ACTOR,
    deps,
  );
  assertEquals(again.duplicate, true);
  assertEquals(payloads.length, 1);
});

Deno.test("Xero draft: a refusal before Xero releases the line; an unconfirmed outcome is never retried", async () => {
  const d = approvedDb();
  d.tables.feature_flags = flagOn;
  await refused(
    () =>
      createCustomerVariationXeroDraft(
        d,
        { variation_id: VAR, xero_contact_id: XERO_CONTACT },
        ESTHER_ACTOR,
        {
          ...accounts,
          createDraft: async () => ({
            ok: false,
            code: "JOB_CONTACT_MISMATCH",
            error: "job_contact_id must belong to job_id",
          }),
        },
      ),
    422,
    "xero_draft_refused",
  );
  assertEquals(
    d.tables.work_order_customer_variation_invoices[0].status,
    "prepared",
  );

  let calls = 0;
  const unconfirmed = {
    ...accounts,
    createDraft: async () => {
      calls++;
      return {
        ok: false,
        code: "INVOICE_DRAFT_OUTCOME_UNCONFIRMED",
        error: "not confirmed",
      };
    },
  };
  await refused(
    () =>
      createCustomerVariationXeroDraft(
        d,
        { variation_id: VAR, xero_contact_id: XERO_CONTACT },
        ESTHER_ACTOR,
        unconfirmed,
      ),
    502,
    "xero_outcome_unknown",
  );
  assertEquals(
    d.tables.work_order_customer_variation_invoices[0].status,
    "unknown",
  );
  await refused(
    () =>
      createCustomerVariationXeroDraft(
        d,
        { variation_id: VAR, xero_contact_id: XERO_CONTACT },
        ESTHER_ACTOR,
        unconfirmed,
      ),
    409,
    "xero_outcome_unknown",
  );
  assertEquals(calls, 1);

  // A throw is an unknown outcome too, unless it is the preflight refusal.
  const thrown = approvedDb();
  thrown.tables.feature_flags = flagOn;
  await refused(
    () =>
      createCustomerVariationXeroDraft(
        thrown,
        { variation_id: VAR, xero_contact_id: XERO_CONTACT },
        ESTHER_ACTOR,
        {
          ...accounts,
          createDraft: async () => {
            throw Object.assign(new Error("Invoice preflight failed"), {
              code: "PREFLIGHT_FAILED",
            });
          },
        },
      ),
    422,
    "xero_draft_refused",
  );
  assertEquals(
    thrown.tables.work_order_customer_variation_invoices[0].status,
    "prepared",
  );
  await refused(
    () =>
      createCustomerVariationXeroDraft(
        thrown,
        { variation_id: VAR, xero_contact_id: XERO_CONTACT },
        ESTHER_ACTOR,
        {
          ...accounts,
          createDraft: async () => {
            throw new Error("socket closed");
          },
        },
      ),
    502,
    "xero_outcome_unknown",
  );
  assertEquals(
    thrown.tables.work_order_customer_variation_invoices[0].status,
    "unknown",
  );
});

Deno.test("Xero draft: every refusal create_invoice_draft throws before Xero releases the line", async () => {
  const beforeXero: Array<[string, any]> = [
    ["no line items", new Error("line_items required")],
    ["no contact", new Error("contact_name or xero_contact_id required")],
    [
      "synthetic live-fire job",
      Object.assign(
        new Error(
          "synthetic_livefire_release_forbidden: create_invoice cannot prepare, approve, execute, invoice, send, sign off, or close a synthetic live-fire job.",
        ),
        { status: 409 },
      ),
    ],
    [
      "synthetic live-fire gate unreadable",
      Object.assign(
        new Error(
          "The create_invoice synthetic live-fire safety gate could not verify its jobs (timeout).",
        ),
        { status: 503 },
      ),
    ],
    [
      "preflight",
      Object.assign(new Error("Invoice preflight failed: site_address"), {
        code: "PREFLIGHT_FAILED",
      }),
    ],
    [
      "no Xero token",
      new Error("No Xero token available. Ensure token_refresh is running."),
    ],
    ["Xero token refresh", new Error("Xero token refresh failed: 401")],
  ];
  for (const [name, error] of beforeXero) {
    const d = approvedDb();
    d.tables.feature_flags = flagOn;
    let calls = 0;
    const deps = {
      ...accounts,
      createDraft: async () => {
        calls++;
        if (calls === 1) throw error;
        return {
          ok: true,
          xero_invoice_id: "77777777-7777-4777-8777-777777777777",
          invoice_number: "INV-2002",
        };
      },
    };
    await refused(
      () =>
        createCustomerVariationXeroDraft(
          d,
          { variation_id: VAR, xero_contact_id: XERO_CONTACT },
          ESTHER_ACTOR,
          deps,
        ),
      422,
      "xero_draft_refused",
    );
    const row = d.tables.work_order_customer_variation_invoices[0];
    assertEquals(row.status, "prepared", name);
    assertEquals(row.failure, error.message, name);
    const again = await createCustomerVariationXeroDraft(
      d,
      { variation_id: VAR, xero_contact_id: XERO_CONTACT },
      ESTHER_ACTOR,
      deps,
    );
    assertEquals(again.invoice?.status, "xero_draft_created", name);
    assertEquals(calls, 2, name);
  }
});

Deno.test("Xero draft: a confirmed draft whose outcome is not saved fails naming the Xero invoice", async () => {
  const XERO_INVOICE = "77777777-7777-4777-8777-777777777777";
  for (const how of ["error", "no row"]) {
    const d = approvedDb();
    d.tables.feature_flags = flagOn;
    const err = await assertRejects(
      () =>
        createCustomerVariationXeroDraft(
          d,
          { variation_id: VAR, xero_contact_id: XERO_CONTACT },
          ESTHER_ACTOR,
          {
            ...accounts,
            createDraft: async () => {
              if (how === "error") {
                d.failOn.add("update:work_order_customer_variation_invoices");
              } else {
                d.tables.work_order_customer_variation_invoices[0].status =
                  "prepared";
              }
              return {
                ok: true,
                xero_invoice_id: XERO_INVOICE,
                invoice_number: "INV-2003",
              };
            },
          },
        ),
      JobWorkOrderError,
    );
    assertEquals(
      [err.status, err.code],
      [502, "xero_draft_outcome_not_saved"],
      how,
    );
    assert(err.message.includes(XERO_INVOICE), how);
    assert(err.message.includes("INV-2003"), how);
    assertEquals(
      d.tables.job_events.filter((e: any) =>
        e.event_type === "customer_variation_xero_draft_created"
      ).map((e: any) => e.detail_json.xero_invoice_id),
      [XERO_INVOICE],
      how,
    );
  }
});

// ── Answering for a stuck Xero draft record ──────────────────────────────────

const XERO_INVOICE = "77777777-7777-4777-8777-777777777777";
const REQUESTED_AT = "2026-10-13T04:00:00.000Z";
const REQUESTED_MS = Date.parse(REQUESTED_AT);
const STALE_NOW = () =>
  REQUESTED_MS + CUSTOMER_VARIATION_CREATING_STALE_AFTER_MS + 1000;
const SHAUN_SESSION = { userId: SHAUN, via: "session" as const };

/** An approved variation whose Xero draft record is stuck in `status`. */
function stuckDb(status: "unknown" | "creating", patch: any = {}) {
  const d = approvedDb();
  d.tables.feature_flags = [...flagOn];
  d.tables.work_order_customer_variation_invoices = [{
    id: "88888888-8888-4888-8888-888888888888",
    variation_id: VAR,
    job_id: JOB,
    line: {
      description: "Variation 1",
      quantity: 1,
      unit_price: 921.6,
      account_code: "207",
    },
    status,
    prepared_by: `user:${ESTHER}`,
    prepared_at: STAMP,
    xero_contact_id: XERO_CONTACT,
    job_contact_id: null,
    xero_requested_by: `user:${ESTHER}`,
    xero_requested_at: REQUESTED_AT,
    xero_invoice_id: null,
    invoice_number: null,
    xero_created_at: null,
    failure: status === "unknown" ? "socket closed" : null,
    updated_at: STAMP,
    ...patch,
  }];
  return d;
}

const invoiceRow = (d: FakeDb) =>
  d.tables.work_order_customer_variation_invoices[0];

Deno.test("reconcile: an approver who found no draft in Xero releases an unknown record, and the line can go again", async () => {
  const d = stuckDb("unknown");
  const r = await reconcileCustomerVariationXeroDraft(
    d,
    {
      variation_id: VAR,
      expected_updated_at: STAMP,
      outcome: "no_draft",
    },
    SHAUN_SESSION,
    { now: STALE_NOW },
  );
  assertEquals(r.duplicate, false);
  assertEquals(r.invoice?.status, "prepared");
  const row = invoiceRow(d);
  assertEquals(row.status, "prepared");
  assertEquals(row.xero_invoice_id, null);
  assertEquals(row.failure, "socket closed");
  const event = d.tables.job_events.find((e: any) =>
    e.event_type === "customer_variation_xero_draft_reconciled"
  );
  assertEquals(event?.user_id, SHAUN);
  assertEquals(event?.detail_json, {
    customer_variation_id: VAR,
    outcome: "no_draft",
    from_status: "unknown",
    xero_invoice_id: null,
    reconciled_by: SHAUN,
    via: "session",
  });
  assertEquals(d.rpcCalls, []);

  // Released: the next request makes the draft.
  let calls = 0;
  const again = await createCustomerVariationXeroDraft(
    d,
    { variation_id: VAR, xero_contact_id: XERO_CONTACT },
    ESTHER_ACTOR,
    {
      ...accounts,
      createDraft: async () => {
        calls++;
        return {
          ok: true,
          xero_invoice_id: XERO_INVOICE,
          invoice_number: "INV-2010",
        };
      },
    },
  );
  assertEquals(calls, 1);
  assertEquals(again.invoice?.status, "xero_draft_created");
});

Deno.test("reconcile: an approver records the draft found in Xero; nothing is sent to Xero again", async () => {
  const d = stuckDb("unknown");
  d.tables.feature_flags.push({
    flag_name: "work_order_terminal_approval_v1",
    enabled: true,
  });
  const body = {
    variation_id: VAR,
    expected_updated_at: STAMP,
    outcome: "draft_exists",
    xero_invoice_id: XERO_INVOICE.toUpperCase(),
    invoice_number: " INV-2011 ",
  };
  const terminal = { userId: SHAUN, via: "terminal" as const };
  const r = await reconcileCustomerVariationXeroDraft(d, body, terminal, {
    now: STALE_NOW,
  });
  assertEquals(r.duplicate, false);
  const row = invoiceRow(d);
  assertEquals(
    [row.status, row.xero_invoice_id, row.invoice_number],
    ["xero_draft_created", XERO_INVOICE, "INV-2011"],
  );
  assertEquals(row.xero_created_at, new Date(STALE_NOW()).toISOString());
  assertEquals(
    d.tables.job_events.find((e: any) =>
      e.event_type === "customer_variation_xero_draft_reconciled"
    )?.detail_json,
    {
      customer_variation_id: VAR,
      outcome: "draft_exists",
      from_status: "unknown",
      xero_invoice_id: XERO_INVOICE,
      reconciled_by: SHAUN,
      via: "terminal",
    },
  );

  // The same answer again is a duplicate; a different invoice is refused.
  const same = await reconcileCustomerVariationXeroDraft(
    d,
    { ...body, expected_updated_at: row.updated_at },
    terminal,
    { now: STALE_NOW },
  );
  assertEquals(same.duplicate, true);
  await refused(
    () =>
      reconcileCustomerVariationXeroDraft(
        d,
        {
          ...body,
          expected_updated_at: row.updated_at,
          xero_invoice_id: "99999999-9999-4999-8999-999999999999",
        },
        terminal,
        { now: STALE_NOW },
      ),
    409,
    "xero_draft_already_recorded",
  );

  // The variation now holds its draft: a create call is a duplicate, not a
  // second draft.
  let calls = 0;
  const create = await createCustomerVariationXeroDraft(
    d,
    { variation_id: VAR, xero_contact_id: XERO_CONTACT },
    ESTHER_ACTOR,
    {
      ...accounts,
      createDraft: async () => {
        calls++;
        return { ok: true, xero_invoice_id: XERO_INVOICE };
      },
    },
  );
  assertEquals([create.duplicate, calls], [true, 0]);
});

Deno.test("reconcile: a creating claim is answered for only once it is too old to be in flight", async () => {
  const fresh = stuckDb("creating");
  const body = {
    variation_id: VAR,
    expected_updated_at: STAMP,
    outcome: "no_draft",
  };
  await refused(
    () =>
      reconcileCustomerVariationXeroDraft(fresh, body, SHAUN_SESSION, {
        now: () =>
          REQUESTED_MS + CUSTOMER_VARIATION_CREATING_STALE_AFTER_MS - 1000,
      }),
    409,
    "xero_draft_in_progress",
  );
  assertEquals(invoiceRow(fresh).status, "creating");
  assertEquals(fresh.tables.job_events, []);

  const stale = stuckDb("creating");
  const r = await reconcileCustomerVariationXeroDraft(
    stale,
    body,
    SHAUN_SESSION,
    { now: STALE_NOW },
  );
  assertEquals(r.invoice?.status, "prepared");

  // A new claim made after the read (its own xero_requested_at) is left alone.
  const reclaimed = stuckDb("creating");
  const original = reclaimed.from.bind(reclaimed);
  (reclaimed as any).from = (table: string) => {
    const q = original(table);
    const update = q.update.bind(q);
    (q as any).update = (payload: any) => {
      // Released and claimed again by someone else between read and write;
      // the record's updated_at is left as read so only the claim differs.
      invoiceRow(reclaimed).xero_requested_at = new Date(STALE_NOW())
        .toISOString();
      return update(payload);
    };
    return q;
  };
  await refused(
    () =>
      reconcileCustomerVariationXeroDraft(reclaimed, body, SHAUN_SESSION, {
        now: STALE_NOW,
      }),
    409,
    "stale_review",
  );
  assertEquals(invoiceRow(reclaimed).status, "creating");
});

Deno.test("reconcile: a confirmed draft whose outcome was not saved is recorded once its claim is stale", async () => {
  const d = approvedDb();
  d.tables.feature_flags = [...flagOn];
  await assertRejects(
    () =>
      createCustomerVariationXeroDraft(
        d,
        { variation_id: VAR, xero_contact_id: XERO_CONTACT },
        ESTHER_ACTOR,
        {
          ...accounts,
          createDraft: async () => {
            d.failOn.add("update:work_order_customer_variation_invoices");
            return {
              ok: true,
              xero_invoice_id: XERO_INVOICE,
              invoice_number: "INV-2003",
            };
          },
        },
      ),
    JobWorkOrderError,
  );
  d.failOn.clear();
  const row = invoiceRow(d);
  assertEquals(row.status, "creating");
  const requested = Date.parse(row.xero_requested_at);
  const r = await reconcileCustomerVariationXeroDraft(
    d,
    {
      variation_id: VAR,
      expected_updated_at: row.updated_at,
      outcome: "draft_exists",
      xero_invoice_id: XERO_INVOICE,
      invoice_number: "INV-2003",
    },
    SHAUN_SESSION,
    {
      now: () => requested + CUSTOMER_VARIATION_CREATING_STALE_AFTER_MS,
    },
  );
  assertEquals(r.invoice?.status, "xero_draft_created");
  assertEquals(r.invoice?.invoice_number, "INV-2003");
});

Deno.test("reconcile: only a work order approver answers, and nothing changes when refused", async () => {
  const body = {
    variation_id: VAR,
    expected_updated_at: STAMP,
    outcome: "no_draft",
  };
  const cases: Array<[string, any, number, string]> = [
    ["no identity", null, 403, "approver_identity_missing"],
    [
      "not the approver",
      { userId: ESTHER, via: "session" },
      403,
      "approver_required",
    ],
    [
      "terminal switched off",
      { userId: SHAUN, via: "terminal" },
      403,
      "terminal_approval_switched_off",
    ],
  ];
  for (const [name, approver, status, code] of cases) {
    const d = stuckDb("unknown");
    await refused(
      () =>
        reconcileCustomerVariationXeroDraft(d, body, approver, {
          now: STALE_NOW,
        }),
      status,
      code,
    );
    assertEquals(invoiceRow(d).status, "unknown", name);
    assertEquals(d.tables.job_events, [], name);
  }
  const unnamed = stuckDb("unknown");
  unnamed.tables.work_order_settings = [{ id: 1, approver_user_ids: [] }];
  await refused(
    () =>
      reconcileCustomerVariationXeroDraft(unnamed, body, SHAUN_SESSION, {
        now: STALE_NOW,
      }),
    403,
    "approver_not_set",
  );
});

Deno.test("reconcile: the answer and the record are checked before anything is written", async () => {
  const base = {
    variation_id: VAR,
    expected_updated_at: STAMP,
  };
  const run = (d: FakeDb, body: any) => () =>
    reconcileCustomerVariationXeroDraft(d, body, SHAUN_SESSION, {
      now: STALE_NOW,
    });
  const d = stuckDb("unknown");
  await refused(run(d, { ...base, outcome: "maybe" }), 400, "invalid_outcome");
  await refused(
    run(d, { ...base, outcome: "draft_exists" }),
    400,
    "invalid_request",
  );
  await refused(
    run(d, { ...base, outcome: "draft_exists", xero_invoice_id: "INV-2001" }),
    400,
    "invalid_request",
  );
  await refused(
    run(d, {
      ...base,
      outcome: "draft_exists",
      xero_invoice_id: XERO_INVOICE,
      invoice_number: "",
    }),
    400,
    "invalid_invoice_number",
  );
  await refused(
    run(d, { ...base, outcome: "no_draft", xero_invoice_id: XERO_INVOICE }),
    400,
    "invalid_request",
  );
  const missing = await assertRejects(
    run(d, { variation_id: VAR, outcome: "no_draft" }),
    JobWorkOrderError,
  );
  assertEquals(
    [missing.status, missing.code],
    [400, "expected_updated_at_required"],
  );
  assert(missing.message.includes("invoice.updated_at"), missing.message);
  const stale = await assertRejects(
    run(d, {
      ...base,
      expected_updated_at: "2026-10-13T01:00:00+00:00",
      outcome: "no_draft",
    }),
    JobWorkOrderError,
  );
  assertEquals([stale.status, stale.code], [409, "stale_review"]);
  assert(stale.message.includes("invoice.updated_at"), stale.message);
  assertEquals(invoiceRow(d).status, "unknown");

  const prepared = stuckDb("unknown", { status: "prepared" });
  await refused(
    run(prepared, { ...base, outcome: "no_draft" }),
    409,
    "nothing_to_reconcile",
  );
  const none = approvedDb();
  await refused(
    run(none, { ...base, outcome: "no_draft" }),
    404,
    "invoice_line_not_found",
  );

  // One Xero invoice belongs to one variation.
  const taken = stuckDb("unknown");
  taken.tables.work_order_customer_variation_invoices.push({
    id: "99999999-0000-4000-8000-000000000009",
    variation_id: "55555555-5555-4555-8555-000000000002",
    job_id: JOB,
    status: "xero_draft_created",
    xero_invoice_id: XERO_INVOICE,
    updated_at: STAMP,
  });
  await refused(
    run(taken, {
      ...base,
      outcome: "draft_exists",
      xero_invoice_id: XERO_INVOICE,
    }),
    409,
    "xero_invoice_already_recorded",
  );
  assertEquals(invoiceRow(taken).status, "unknown");
  assertEquals(taken.tables.job_events, []);
});

// ── The front door ───────────────────────────────────────────────────────────

const STAFF_ACTIONS = [
  "customer_variations",
  "create_customer_variation",
  "update_customer_variation",
  "approve_customer_variation",
  "cancel_customer_variation",
  "prepare_customer_variation_invoice_line",
  "create_customer_variation_xero_draft",
  "reconcile_customer_variation_xero_draft",
];

Deno.test("front door: customer variation actions are staff only, never a trade or routine door", async () => {
  const {
    _authorizeOpsApiAction,
    _opsApiActionNeedsStaffRole,
    AGENT_READ_ALLOWED_ACTIONS,
    LEAD_INSTALLER_READ_ACTIONS,
  } = await import("./index.ts");
  for (const action of STAFF_ACTIONS) {
    const url = new URL(`https://x.invalid/ops-api?action=${action}`);
    assertEquals(_opsApiActionNeedsStaffRole(url), true, action);
    assert(!LEAD_INSTALLER_READ_ACTIONS.has(action), action);
    assert(!AGENT_READ_ALLOWED_ACTIONS.has(action), action);
    for (const role of ["crew", "trade", "lead_installer", "subcontractor"]) {
      const out = _authorizeOpsApiAction({
        url,
        authMode: "jwt",
        authUser: { role, managedVerticals: ["fencing", "patio"] },
      });
      assertEquals(
        out.ok === false && [out.status, out.code],
        [403, "operator_access_required"],
        `${action} ${role}`,
      );
    }
    for (const role of ["admin", "owner", "ops_manager"]) {
      assertEquals(
        _authorizeOpsApiAction({ url, authMode: "jwt", authUser: { role } }).ok,
        true,
        `${action} ${role}`,
      );
    }
  }
});

Deno.test("required actions: every customer variation action is listed for the deploy gate", async () => {
  const text = await Deno.readTextFile(
    new URL("../../../scripts/_ops-api-required-actions.txt", import.meta.url),
  );
  const listed = new Set(
    text.split("\n").map((l) => l.replace(/#.*/, "").trim()).filter(Boolean),
  );
  for (const action of STAFF_ACTIONS) assert(listed.has(action), action);
});
