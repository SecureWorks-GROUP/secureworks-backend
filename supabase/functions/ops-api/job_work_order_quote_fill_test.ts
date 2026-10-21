// deno-lint-ignore-file no-explicit-any no-import-prefix require-await
// Filling a job work order draft from the accepted quote
// (docs/quote-work-order-lines-v1.md). Customer details are left out.
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  fillJobWorkOrderDraftFromQuote,
  jobWorkOrderDraftIsUntouched,
  previewQuoteWorkOrderLines,
  QuoteFillError,
} from "./job_work_order_quote_fill.ts";
import {
  autoIssueJobWorkOrderForJob,
  autoIssueJobWorkOrders,
  backfillJobWorkOrders,
  createJobWorkOrder,
  readJobWorkOrder,
  tradeJobWorkOrderRead,
} from "./job_work_orders.ts";
import { tradeJobWorkOrderRedaction } from "./index.ts";

const ORG = "00000000-0000-0000-0000-000000000001";
const JOB = "11111111-1111-4111-8111-111111111111";
const DRAFT = "33333333-3333-4333-8333-333333333333";
const REV_ACCEPTED = "55555555-5555-4555-8555-555555555551";
const REV_NEWER = "55555555-5555-4555-8555-555555555552";

// ── A small in-memory PostgREST stand-in (the job_work_orders_test shape) ────

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
  private lim: number | null = null;
  private sorts: Array<{ col: string; ascending: boolean }> = [];
  constructor(private db: FakeDb, private table: string) {}
  select(_cols?: string) {
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
  neq(col: string, val: any) {
    this.filters.push((r) => get(r, col) !== val);
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
  gte(col: string, val: any) {
    this.filters.push((r) => get(r, col) != null && get(r, col) >= val);
    return this;
  }
  lte(col: string, val: any) {
    // Like SQL, a missing value never satisfies the comparison.
    this.filters.push((r) => get(r, col) != null && get(r, col) <= val);
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }) {
    this.sorts.push({ col, ascending: opts?.ascending !== false });
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
    this.db.calls.push(`${this.op}:${this.table}`);
    if (this.db.failOn.has(`${this.op}:${this.table}`)) {
      return { data: null, error: { message: "boom", code: "XX000" } };
    }
    if (this.op === "insert") {
      const list = Array.isArray(this.payload) ? this.payload : [this.payload];
      const out = list.map((raw: any) => ({ id: crypto.randomUUID(), ...raw }));
      rows.push(...out);
      return this.finish(out);
    }
    if (this.op === "update") this.db.beforeUpdate?.(this.table);
    const matched = rows.filter((r) => this.filters.every((f) => f(r)));
    for (const { col, ascending } of [...this.sorts].reverse()) {
      matched.sort((a, b) => {
        const x = get(a, col), y = get(b, col);
        if (x === y) return 0;
        return (x < y ? -1 : 1) * (ascending ? 1 : -1);
      });
    }
    if (this.op === "update") {
      for (const r of matched) {
        Object.assign(r, this.payload, {
          updated_at: `updated-${++this.db.saves}`,
        });
      }
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
  failOn = new Set<string>();
  calls: string[] = [];
  saves = 0;
  beforeUpdate: ((table: string) => void) | null = null;
  rpcImpl: (fn: string, args: any) => { data: any; error: any } = () => ({
    data: null,
    error: null,
  });
  constructor(public tables: Tables) {}
  from(table: string) {
    return new Query(this, table);
  }
  rpc(fn: string, args: any) {
    return Promise.resolve(this.rpcImpl(fn, args));
  }
  writes() {
    return this.calls.filter((c) => !c.startsWith("select:"));
  }
}

// SWF-261527 shape: 18.5 m, 12 plinths, Colorbond removal, 2 hrs root removal.
const ACCEPTED_PRICING = {
  line_items: [
    {
      unit: "m",
      category: "fencing",
      quantity: 18.5,
      description: "8× Ridgeside (18.5m total)",
    },
    {
      unit: "each",
      category: "materials",
      quantity: 12,
      cost_price: 41,
      description: "Retaining plinths (150mm COLORBOND)",
    },
    {
      unit: "m",
      category: "removal",
      quantity: 18.5,
      description: "Remove Colorbond fence",
    },
    {
      kind: "material",
      unit: "hrs",
      category: "custom",
      quantity: 2,
      cost_price: 80,
      sell_price: 130,
      description: "Root removal / hard digging ",
    },
  ],
  labourCostEstimate: 767.5,
};
// The quote's own labour figure (labourCostEstimate), never re-priced.
const ACCEPTED_AGREED = 767.5;
// The job was accepted after its revision was frozen (5 Oct) and before the
// re-quote below (10 Oct).
const ACCEPTED_AT = "2026-10-09T04:05:03Z";

// A re-quote frozen after acceptance: 5 m, labour 175. Never the work order's.
function laterRevision() {
  return {
    id: REV_NEWER,
    job_id: JOB,
    revision_number: 2,
    status: "frozen",
    frozen_at: "2026-10-10T00:00:00Z",
    pricing_canonical_text: JSON.stringify({
      line_items: [{
        unit: "m",
        category: "fencing",
        quantity: 5,
        description: "2× Ridgeside (5.0m total)",
      }],
      labourCostEstimate: 175,
    }),
  };
}

function costTableRows() {
  return [
    ["base-labour", "35.00"],
    ["plinth-install", "10.00"],
    ["gate-labour-pedestrian", "250.00"],
    ["gate-labour-double", "500.00"],
    ["remove-colorbond-cost", "15.00"],
    ["remove-hardie-cost", "12.50"],
    ["remove-timber-cost", "20.00"],
    ["remove-asbestos-cost", "65.00"],
    ["veg-clear-cost", "150.00"],
    ["base-labour-sell", "85.00"],
  ].map(([item_key, default_cost_rate]) => ({
    org_id: ORG,
    scope_tool: "fence-designer",
    item_key,
    default_cost_rate,
    // Set before the accepted revision was frozen (5 Oct).
    last_updated_at: "2026-09-01T00:00:00+00:00",
  }));
}

function draftRow(extra: Record<string, unknown> = {}) {
  return {
    id: DRAFT,
    org_id: ORG,
    job_id: JOB,
    wo_number: "WO-SWF-261527",
    kind: "job",
    status: "draft",
    scope_items: [],
    special_instructions: null,
    agreed_labour_ex: null,
    origin: "job_approved",
    created_at: "2026-10-09T04:05:04Z",
    updated_at: "2026-10-09T04:05:04Z",
    ...extra,
  };
}

function baseDb(extra: Partial<Tables> = {}) {
  return new FakeDb({
    jobs: [{
      id: JOB,
      org_id: ORG,
      job_number: "SWF-261527",
      client_name: "Client",
      type: "fencing",
      status: "order_materials",
      site_address: "1 Test St",
      site_suburb: "Suburb",
      work_order_id: DRAFT,
      expected_costs: { scope_revision_id: REV_ACCEPTED },
      pricing_json: { line_items: [], labourCostEstimate: 0 },
    }],
    work_orders: [draftRow()],
    scope_revisions: [{
      id: REV_ACCEPTED,
      job_id: JOB,
      revision_number: 1,
      status: "frozen",
      frozen_at: "2026-10-05T08:55:20Z",
      pricing_canonical_text: JSON.stringify(ACCEPTED_PRICING),
    }],
    scope_tool_defaults: costTableRows(),
    trade_invoice_lines: [],
    work_order_variations: [],
    job_events: [],
    ...extra,
  });
}

Deno.test("an untouched draft is filled from the accepted quote on the staff read, and the read returns it filled", async () => {
  const db = baseDb();
  const r: any = await readJobWorkOrder(db, {
    jobId: JOB,
    fillFromQuote: true,
  });
  assertEquals(r.quote_fill.filled, true);
  assertEquals(r.quote_fill.reason, "filled");
  assertEquals(r.quote_fill.scope_revision_id, REV_ACCEPTED);
  const wo = r.work_order;
  assertEquals(wo.id, DRAFT);
  assertEquals(wo.status, "draft");
  assertEquals(wo.agreed_labour_ex, ACCEPTED_AGREED);
  const roots = wo.scope_items.find((i: any) =>
    /hard digging/.test(i.description)
  );
  // The 2 hours come through; the quote's labour figure does not include
  // them, so they are kept uncounted and flagged for the approver.
  assertEquals([
    roots.qty,
    roots.unit,
    roots.hours,
    roots.rate,
    roots.total,
    roots.counted,
    roots.needs_review,
  ], [2, "hrs", 2, 80, 160, false, true]);
  assert(roots.flags.includes("outside_quote_labour"));
  assert(wo.scope_items.every((i: any) => i.source === "quote"));
  // Stored, so the next read is a plain read.
  assertEquals(db.tables.work_orders[0].agreed_labour_ex, ACCEPTED_AGREED);
  const again: any = await readJobWorkOrder(db, {
    jobId: JOB,
    fillFromQuote: true,
  });
  assertEquals(again.quote_fill, null);
  // The event carries ids and counts only: job_events is readable by trades.
  const events = db.tables.job_events.filter((e) =>
    e.event_type === "job_work_order_draft_filled_from_quote"
  );
  assertEquals(events.length, 1);
  const detail = JSON.stringify(events[0].detail_json);
  for (const leak of [String(ACCEPTED_AGREED), "160", "80", "647.5"]) {
    assert(!detail.includes(leak), `event leaked ${leak}: ${detail}`);
  }
  assertEquals(events[0].detail_json.work_order_id, DRAFT);
});

Deno.test("an approved work order is never filled or written", async () => {
  const db = baseDb({
    work_orders: [
      draftRow({ status: "approved", approved_at: "2026-10-10T00:00:00Z" }),
    ],
  });
  const r: any = await readJobWorkOrder(db, {
    jobId: JOB,
    fillFromQuote: true,
  });
  assertEquals(r.quote_fill, null);
  const direct = await fillJobWorkOrderDraftFromQuote(db, JOB);
  assertEquals(direct.reason, "sealed");
  assertEquals(db.writes(), []);
  assertEquals(db.tables.work_orders[0].scope_items, []);
});

Deno.test("a draft someone has written into is left alone", async () => {
  for (
    const typed of [
      { scope_items: [{ description: "Typed by Shaun" }] },
      { agreed_labour_ex: 900 },
    ]
  ) {
    const db = baseDb({ work_orders: [draftRow(typed)] });
    const r: any = await readJobWorkOrder(db, {
      jobId: JOB,
      fillFromQuote: true,
    });
    assertEquals(r.quote_fill, null);
    const direct = await fillJobWorkOrderDraftFromQuote(db, JOB);
    assertEquals(direct.reason, "draft_already_has_lines");
    assertEquals(db.writes(), []);
  }
  assert(
    jobWorkOrderDraftIsUntouched(
      draftRow({ special_instructions: "Rear gate first" }),
    ),
  );
});

Deno.test("a save that lands between the read and the fill wins; the fill writes nothing", async () => {
  const db = baseDb();
  db.beforeUpdate = (table) => {
    if (table !== "work_orders") return;
    Object.assign(db.tables.work_orders[0], {
      scope_items: [{ description: "Saved by staff" }],
      updated_at: "2026-10-09T05:00:00Z",
    });
    db.beforeUpdate = null;
  };
  const outcome = await fillJobWorkOrderDraftFromQuote(db, JOB);
  assertEquals(outcome.filled, false);
  assertEquals(outcome.reason, "draft_changed");
  assertEquals(db.tables.work_orders[0].scope_items, [{
    description: "Saved by staff",
  }]);
  assertEquals(db.tables.work_orders[0].agreed_labour_ex, null);
});

Deno.test("the quote used is the accepted revision, even once a later revision superseded it", async () => {
  const db = baseDb();
  // A re-quote after acceptance freezes a newer revision and supersedes the
  // accepted one.
  db.tables.scope_revisions[0].status = "superseded";
  db.tables.scope_revisions.push(laterRevision());
  const p = await previewQuoteWorkOrderLines(db, JOB);
  assertEquals([p.quote.source, p.quote.scope_revision_id, p.quote.flags], [
    "accepted_revision",
    REV_ACCEPTED,
    [],
  ]);
  assertEquals(p.result.agreed_labour_ex, ACCEPTED_AGREED);
  const r: any = await readJobWorkOrder(db, {
    jobId: JOB,
    fillFromQuote: true,
  });
  assertEquals(r.quote_fill.scope_revision_id, REV_ACCEPTED);
  assertEquals(r.work_order.agreed_labour_ex, ACCEPTED_AGREED);
});

Deno.test("with no revision recorded at acceptance, the revision frozen at or before acceptance is used, never a later one", async () => {
  const db = baseDb();
  db.tables.jobs[0].expected_costs = null;
  db.tables.jobs[0].accepted_at = ACCEPTED_AT;
  db.tables.scope_revisions[0].status = "superseded";
  db.tables.scope_revisions.push(laterRevision());
  const p = await previewQuoteWorkOrderLines(db, JOB);
  assertEquals([p.quote.source, p.quote.scope_revision_id, p.quote.flags], [
    "revision_at_acceptance",
    REV_ACCEPTED,
    [],
  ]);
  assertEquals(p.result.agreed_labour_ex, ACCEPTED_AGREED);
});

Deno.test("no accepted revision: the draft is not filled, from a later revision or from live pricing", async () => {
  const cases: Array<[string, (db: FakeDb) => void]> = [
    ["only a revision frozen after acceptance", (db) => {
      db.tables.jobs[0].accepted_at = "2026-10-01T00:00:00Z";
    }],
    ["no acceptance time and no current frozen quote", (db) => {
      db.tables.jobs[0].accepted_at = null;
      db.tables.scope_revisions[0].status = "superseded";
    }],
    ["no revision at all", (db) => {
      db.tables.scope_revisions = [];
    }],
  ];
  for (const [label, arrange] of cases) {
    const db = baseDb();
    db.tables.jobs[0].expected_costs = null;
    db.tables.jobs[0].accepted_at = ACCEPTED_AT;
    db.tables.jobs[0].pricing_json = ACCEPTED_PRICING;
    arrange(db);
    const p = await previewQuoteWorkOrderLines(db, JOB);
    assertEquals(
      [p.quote.source, p.quote.flags],
      [null, ["no_accepted_quote"]],
      label,
    );
    assertEquals(p.result.lines, [], label);
    const r: any = await readJobWorkOrder(db, {
      jobId: JOB,
      fillFromQuote: true,
    });
    assertEquals([r.quote_fill.filled, r.quote_fill.reason], [
      false,
      "no_accepted_quote",
    ], label);
    assertEquals(db.tables.work_orders[0].scope_items, [], label);
    assertEquals(db.tables.work_orders[0].agreed_labour_ex, null, label);
    assertEquals(db.writes(), [], label);
  }
});

Deno.test("an unreadable accepted revision is never replaced by another one", async () => {
  const db = baseDb();
  db.tables.jobs[0].accepted_at = ACCEPTED_AT;
  db.tables.scope_revisions[0].pricing_canonical_text = "{not json";
  db.tables.scope_revisions.push(laterRevision());
  const p = await previewQuoteWorkOrderLines(db, JOB);
  assertEquals([p.quote.source, p.quote.flags], [null, [
    "frozen_quote_unreadable",
    "no_accepted_quote",
  ]]);
  const outcome = await fillJobWorkOrderDraftFromQuote(db, JOB);
  assertEquals(outcome.reason, "no_accepted_quote");
  assertEquals(db.writes(), []);
});

Deno.test("review flags are kept on each flagged line in the stored draft", async () => {
  const flaggedPricing = {
    ...ACCEPTED_PRICING,
    line_items: [
      ...ACCEPTED_PRICING.line_items,
      {
        kind: "material",
        unit: "job",
        category: "custom",
        quantity: 1,
        cost_price: 250,
        description: "Root removal  ",
      },
    ],
  };
  const db = baseDb();
  db.tables.scope_revisions[0].pricing_canonical_text = JSON.stringify(
    flaggedPricing,
  );
  // Today's install rate no longer rebuilds the quote's labour figure.
  db.tables.scope_tool_defaults.find((r) => r.item_key === "base-labour")!
    .default_cost_rate = "40.00";
  const r: any = await readJobWorkOrder(db, {
    jobId: JOB,
    fillFromQuote: true,
  });
  assertEquals([r.quote_fill.filled, r.quote_fill.needs_review], [true, true]);
  const stored = db.tables.work_orders[0].scope_items;
  const roots = stored.find((l: any) => l.description === "Root removal");
  assert(roots.flags.includes("labour_or_material_unknown"));
  assertEquals(roots.counted, false);
  // Every line priced from the cost table carries the flag and is in review;
  // the quote's own custom lines do not carry it.
  for (const line of stored) {
    const rateLine = line.basis.startsWith("fence_") ||
      line.basis === "removal";
    assertEquals(
      line.flags.includes("labour_differs_from_quote"),
      rateLine,
      line.line_key,
    );
    assertEquals(line.needs_review, true, line.line_key);
  }
  // The agreed labour is still the quote's own figure.
  assertEquals(db.tables.work_orders[0].agreed_labour_ex, ACCEPTED_AGREED);
  // A later read does not fill again, and every flag is still on the draft.
  const again: any = await readJobWorkOrder(db, {
    jobId: JOB,
    fillFromQuote: true,
  });
  assertEquals(again.quote_fill, null);
  assertEquals(again.work_order.scope_items, stored);
});

Deno.test("a cost table row changed after the quote was frozen puts its lines in review; the agreed labour stays the quote's", async () => {
  for (const updated of ["2026-10-06T00:00:00+00:00", null]) {
    const db = baseDb();
    db.tables.scope_tool_defaults.find((r) =>
      r.item_key === "remove-colorbond-cost"
    )!.last_updated_at = updated;
    const r: any = await readJobWorkOrder(db, {
      jobId: JOB,
      fillFromQuote: true,
    });
    assertEquals(r.quote_fill.filled, true, String(updated));
    const stored = db.tables.work_orders[0].scope_items;
    const removal = stored.find((l: any) => l.basis === "removal");
    assertEquals([removal.counted, removal.needs_review], [false, true]);
    assert(removal.flags.includes("rates_changed_since_quote"));
    // Only remove-colorbond-cost changed: no other line is marked by it.
    for (const line of stored.filter((l: any) => l.basis !== "removal")) {
      assert(
        !line.flags.includes("rates_changed_since_quote"),
        line.line_key,
      );
    }
    for (const key of ["install:0", "plinths"]) {
      const line = stored.find((l: any) => l.line_key === key);
      assertEquals([line.counted, line.needs_review, line.flags], [
        true,
        false,
        [],
      ], key);
    }
    const roots = stored.find((l: any) => /hard digging/.test(l.description));
    assertEquals(roots.flags, ["saved_as_material", "outside_quote_labour"]);
    assertEquals(r.quote_fill.needs_review, true);
    assertEquals(db.tables.work_orders[0].agreed_labour_ex, ACCEPTED_AGREED);
  }
});

Deno.test("a read that does not ask to fill writes nothing (the routine key's read)", async () => {
  const db = baseDb();
  for (const params of [{ jobId: JOB }, { jobId: JOB, fillFromQuote: false }]) {
    const r: any = await readJobWorkOrder(db, params);
    assertEquals(r.quote_fill, null);
    assertEquals(r.work_order.scope_items, []);
  }
  assertEquals(db.writes(), []);
  assertEquals(db.tables.work_orders[0].agreed_labour_ex, null);
});

Deno.test("preview: a job id only, writes nothing; an unknown job is a 404", async () => {
  const db = baseDb();
  const p = await previewQuoteWorkOrderLines(db, JOB);
  assertEquals(p.job.id, JOB);
  assertEquals(p.result.schema, "quote-work-order-lines.v1");
  assertEquals(db.writes(), []);
  await assertRejects(
    () =>
      previewQuoteWorkOrderLines(db, "22222222-2222-4222-8222-222222222222"),
    QuoteFillError,
    "not found",
  );
  // A missing job id or a job number is refused before any query.
  const before = db.calls.length;
  for (const ref of ["", "SWF-261527", "swf-261527"]) {
    await assertRejects(
      () => previewQuoteWorkOrderLines(db, ref),
      QuoteFillError,
      "job_id required",
    );
  }
  assertEquals(db.calls.length, before);
});

Deno.test("an unreadable cost table never fills on wrong figures and never fails the read", async () => {
  const db = baseDb();
  db.failOn.add("select:scope_tool_defaults");
  const r: any = await readJobWorkOrder(db, {
    jobId: JOB,
    fillFromQuote: true,
  });
  assertEquals(r.quote_fill.filled, false);
  assertEquals(r.quote_fill.reason, "fill_failed");
  assertEquals(r.quote_fill.code, "cost_table_unreadable");
  assertEquals(r.work_order.scope_items, []);
  assertEquals(db.writes(), []);
});

Deno.test("a job with no quote lines keeps its empty draft", async () => {
  const db = baseDb();
  db.tables.scope_revisions[0].pricing_canonical_text = JSON.stringify({
    line_items: [{
      category: "delivery",
      quantity: 1,
      description: "Delivery",
    }],
  });
  const r: any = await readJobWorkOrder(db, {
    jobId: JOB,
    fillFromQuote: true,
  });
  assertEquals(r.quote_fill.reason, "no_quote_lines");
  assertEquals(db.tables.work_orders[0].scope_items, []);
  assertEquals(db.tables.work_orders[0].agreed_labour_ex, null);
});

Deno.test("opening the draft fills it, unless the call brought its own lines or agreed amount", async () => {
  const opened = () => {
    const db = baseDb({ work_orders: [] });
    db.rpcImpl = (fn) => {
      if (fn !== "ensure_job_work_order_draft") {
        return { data: null, error: null };
      }
      db.tables.work_orders.push(draftRow());
      return { data: DRAFT, error: null };
    };
    return db;
  };
  let db = opened();
  let r: any = await createJobWorkOrder(db, { job_id: JOB, kind: "job" });
  assertEquals(r.created, true);
  assertEquals(r.quote_fill.filled, true);
  assertEquals(r.work_order.agreed_labour_ex, ACCEPTED_AGREED);

  db = opened();
  r = await createJobWorkOrder(db, {
    job_id: JOB,
    kind: "job",
    scope_items: [{ description: "Typed" }],
  });
  assertEquals(r.quote_fill, null);
  assertEquals(r.work_order.scope_items, [{ description: "Typed" }]);
});

Deno.test("backfill: a dry run counts untouched drafts; apply fills them in batches and says what remains", async () => {
  const JOB2 = "11111111-1111-4111-8111-111111111112";
  const DRAFT2 = "33333333-3333-4333-8333-333333333334";
  const db = baseDb();
  db.tables.jobs.push({
    ...db.tables.jobs[0],
    id: JOB2,
    job_number: "SWF-261528",
    work_order_id: DRAFT2,
  });
  db.tables.scope_revisions.push({
    ...db.tables.scope_revisions[0],
    id: crypto.randomUUID(),
    job_id: JOB2,
  });
  // Its accepted revision is found by the acceptance time.
  db.tables.jobs[1].expected_costs = null;
  db.tables.jobs[1].accepted_at = ACCEPTED_AT;
  db.tables.work_orders.push(
    draftRow({ id: DRAFT2, job_id: JOB2, created_at: "2026-10-10T00:00:00Z" }),
  );
  db.tables.work_orders.push(
    draftRow({
      id: crypto.randomUUID(),
      job_id: "x",
      scope_items: [{ description: "Typed" }],
    }),
  );
  let applied = false;
  db.rpcImpl = (_fn, args) => {
    if (args.p_apply) applied = true;
    return {
      data: { dry_run: !args.p_apply, candidates: 0, opened: 0, job_ids: [] },
      error: null,
    };
  };

  const dry: any = await backfillJobWorkOrders(db, {});
  assertEquals(dry.quote_fill, { dry_run: true, untouched_drafts: 2 });
  assertEquals(db.writes(), []);

  const first: any = await backfillJobWorkOrders(db, {
    apply: true,
    fill_limit: 1,
  });
  assert(applied);
  assertEquals(first.quote_fill, {
    dry_run: false,
    untouched_drafts: 2,
    attempted: 1,
    filled: 1,
    not_filled: {},
    remaining: 1,
  });
  const second: any = await backfillJobWorkOrders(db, { apply: true });
  assertEquals(second.quote_fill.filled, 1);
  assertEquals(second.quote_fill.remaining, 0);
  assertEquals(
    db.tables.work_orders.find((w) => w.id === DRAFT2).agreed_labour_ex,
    ACCEPTED_AGREED,
  );
  // The typed draft was never a candidate.
  assertEquals(db.tables.work_orders[2].scope_items, [{
    description: "Typed",
  }]);
});

Deno.test("backfill: switched off refuses before anything is filled", async () => {
  const db = baseDb();
  db.rpcImpl = () => ({
    data: null,
    error: { code: "42501", message: "switched off" },
  });
  await assertRejects(
    () => backfillJobWorkOrders(db, { apply: true }),
    Error,
    "switched off",
  );
  assertEquals(db.writes(), []);
});

Deno.test("front door: the preview is a staff read; a trade session is refused", async () => {
  const {
    _authorizeOpsApiAction,
    _opsApiActionNeedsStaffRole,
    AGENT_READ_ALLOWED_ACTIONS,
    LEAD_INSTALLER_READ_ACTIONS,
  } = await import("./index.ts");
  const url = new URL(
    `https://x.invalid/ops-api?action=quote_work_order_lines&job_id=${JOB}`,
  );
  assertEquals(_opsApiActionNeedsStaffRole(url), true);
  for (const role of ["admin", "owner", "ops_manager"]) {
    assertEquals(
      _authorizeOpsApiAction({ url, authMode: "jwt", authUser: { role } }),
      { ok: true },
    );
  }
  for (
    const authUser of [{ role: "installer" }, {
      role: "lead_installer",
      managedVerticals: ["fencing"],
    }]
  ) {
    const refused: any = _authorizeOpsApiAction({
      url,
      authMode: "jwt",
      authUser,
    });
    assertEquals([refused.ok, refused.status, refused.code], [
      false,
      403,
      "operator_access_required",
    ]);
  }
  assert(!LEAD_INSTALLER_READ_ACTIONS.has("quote_work_order_lines"));
  assert(!AGENT_READ_ALLOWED_ACTIONS.has("quote_work_order_lines"));
});

// ── Automatic issue (job_work_order_auto_issue_v1) ───────────────────────────

const AUTO_FLAG = "job_work_order_auto_issue_v1";

function autoIssueOn(db: FakeDb) {
  db.tables.feature_flags = [{ flag_name: AUTO_FLAG, enabled: true }];
}

/** auto_issue_job_work_order as the database answers it
 *  (20261016120000_job_work_order_auto_issue.sql). */
function autoIssueDoor(db: FakeDb) {
  const calls: any[] = [];
  db.rpcImpl = (fn, args) => {
    calls.push({ fn, args });
    if (fn !== "auto_issue_job_work_order") return { data: null, error: null };
    const on = (db.tables.feature_flags || []).some((f) =>
      f.flag_name === AUTO_FLAG && f.enabled === true
    );
    if (!on) {
      return { data: null, error: { code: "42501", message: "switched off" } };
    }
    const wo = db.tables.work_orders.find((w) => w.id === args.p_work_order_id);
    if (!wo || wo.status !== "draft") {
      return { data: null, error: { code: "23514", message: "not draft" } };
    }
    if (wo.updated_at !== args.p_expected_updated_at) {
      return { data: null, error: { code: "WO409", message: "changed" } };
    }
    if (!wo.quote_filled_at || wo.hand_edited_at) {
      return { data: null, error: { code: "WO423", message: "not issuable" } };
    }
    Object.assign(wo, {
      status: "approved",
      approved_by: null,
      approved_via: "auto",
      approved_at: "2026-10-14T00:00:00Z",
      sealed_content_hash: "h".repeat(64),
    });
    return { data: { ...wo }, error: null };
  };
  return calls;
}

Deno.test("auto issue: switched off, nothing is filled, issued or written, even on a status change", async () => {
  const db = baseDb();
  const calls = autoIssueDoor(db);
  const r = await autoIssueJobWorkOrderForJob(db, JOB);
  assertEquals(r.issued, false);
  assertEquals(r.reason, "switched_off");
  assertEquals(calls, []);
  assertEquals(db.writes(), []);
  assertEquals(db.tables.work_orders[0].scope_items, []);
});

Deno.test("auto issue: the draft is filled from the accepted quote and goes to the trades with no human approval", async () => {
  const db = baseDb();
  autoIssueOn(db);
  const calls = autoIssueDoor(db);
  const r = await autoIssueJobWorkOrderForJob(db, JOB);
  assertEquals(r.reason, "issued");
  assertEquals(r.issued, true);
  assertEquals(r.quote_fill?.filled, true);
  const wo = db.tables.work_orders[0];
  assertEquals(wo.status, "approved");
  assertEquals(wo.approved_via, "auto");
  assertEquals(wo.approved_by, null);
  assertEquals(wo.agreed_labour_ex, ACCEPTED_AGREED);
  assert(wo.quote_filled_at, "the fill stamps the draft as its own");
  // The system seals only the draft as the fill wrote it.
  assertEquals(calls.length, 1);
  assertEquals(calls[0].args.p_work_order_id, DRAFT);
  assertEquals(calls[0].args.p_expected_updated_at, "updated-1");
  // Ids and counts only on the job's events.
  const issued = db.tables.job_events.filter((e) =>
    e.event_type === "job_work_order_auto_issued"
  );
  assertEquals(issued.length, 1);
  assertEquals(issued[0].user_id, null);
  const detail = JSON.stringify(issued[0].detail_json);
  for (const leak of [String(ACCEPTED_AGREED), "160", "80", "647.5"]) {
    assert(!detail.includes(leak), `event leaked ${leak}: ${detail}`);
  }
});

Deno.test("auto issue: a line flagged for review does not hold the work order; the office sees it as needs checking, the trades never do", async () => {
  const db = baseDb();
  // An old-style extra saved with no hours ("Root removal, 1 job"): the
  // fill cannot tell labour from material, so it is flagged.
  const pricing = JSON.parse(
    db.tables.scope_revisions[0].pricing_canonical_text,
  );
  pricing.line_items.push({
    unit: "each",
    category: "custom",
    quantity: 1,
    cost_price: 120,
    description: "Root removal",
  });
  db.tables.scope_revisions[0].pricing_canonical_text = JSON.stringify(
    pricing,
  );
  autoIssueOn(db);
  autoIssueDoor(db);
  const r = await autoIssueJobWorkOrderForJob(db, JOB);
  assertEquals(r.reason, "issued");
  assert(r.needs_checking_lines >= 2, JSON.stringify(r));

  const staff: any = await readJobWorkOrder(db, { jobId: JOB });
  const note = staff.needs_checking;
  assertEquals(note.needs_checking, true);
  assertEquals(note.issued_automatically, true);
  assertEquals(note.held, null);
  const extra = note.lines.find((l: any) => l.description === "Root removal");
  assert(extra.flags.includes("labour_or_material_unknown"));
  assert(/went to the trades as it is/.test(note.message));

  // The trade read: hours and quantities only, no flag, note or amount.
  const trade = await tradeJobWorkOrderRead(
    db,
    JOB,
    "trade-1",
    tradeJobWorkOrderRedaction,
  );
  const text = JSON.stringify(trade);
  for (
    const leak of [
      "needs_review",
      "needs_checking",
      "flags",
      "labour_or_material_unknown",
      "outside_quote_labour",
      "quote_cost_ex",
      "rate",
      "total",
      "counted",
      "agreed",
      "approved_via",
      "auto",
      String(ACCEPTED_AGREED),
      "120",
      "160",
    ]
  ) {
    assert(!text.includes(leak), `trade read leaked ${leak}: ${text}`);
  }
  const lines = (trade.work_order as any).scope_items;
  assert(lines.some((l: any) => l.description === "Root removal"));
  for (const line of lines) {
    for (const key of Object.keys(line)) {
      assert(
        ["description", "qty", "unit", "hours"].includes(key),
        `trade line carries ${key}`,
      );
    }
  }
});

Deno.test("auto issue: a draft someone edited by hand waits for the approver", async () => {
  const db = baseDb({
    work_orders: [draftRow({
      scope_items: [{ description: "Typed by the office" }],
      agreed_labour_ex: 900,
      hand_edited_at: "2026-10-13T00:00:00Z",
    })],
  });
  autoIssueOn(db);
  const calls = autoIssueDoor(db);
  const r = await autoIssueJobWorkOrderForJob(db, JOB);
  assertEquals(r.reason, "hand_edited");
  assertEquals(calls, []);
  assertEquals(db.tables.work_orders[0].status, "draft");
  const staff: any = await readJobWorkOrder(db, { jobId: JOB });
  assertEquals(staff.needs_checking.held.reason, "hand_edited");
  assertEquals(staff.needs_checking.needs_checking, true);
});

Deno.test("auto issue: a draft edited by hand before the fill is filled without the fill's stamp and is not issued", async () => {
  const db = baseDb({
    work_orders: [draftRow({
      special_instructions: "Dog on site",
      hand_edited_at: "2026-10-13T00:00:00Z",
    })],
  });
  autoIssueOn(db);
  const calls = autoIssueDoor(db);
  const r = await autoIssueJobWorkOrderForJob(db, JOB);
  assertEquals(r.reason, "hand_edited");
  assertEquals(calls, []);
  // This door does not fill a draft someone has written into; a staff read
  // or the backfill still fills it, without the fill's stamp.
  assertEquals(db.tables.work_orders[0].scope_items, []);
  const filled = await fillJobWorkOrderDraftFromQuote(db, JOB);
  assertEquals(filled.filled, true);
  assertEquals(db.tables.work_orders[0].quote_filled_at, undefined);
});

Deno.test("auto issue: a quote with no labour figure fills the lines and waits for the agreed labour", async () => {
  const db = baseDb();
  const pricing = JSON.parse(
    db.tables.scope_revisions[0].pricing_canonical_text,
  );
  delete pricing.labourCostEstimate;
  db.tables.scope_revisions[0].pricing_canonical_text = JSON.stringify(
    pricing,
  );
  autoIssueOn(db);
  const calls = autoIssueDoor(db);
  const r = await autoIssueJobWorkOrderForJob(db, JOB);
  assertEquals(r.reason, "agreed_labour_missing");
  assertEquals(calls, []);
  const wo = db.tables.work_orders[0];
  assertEquals(wo.status, "draft");
  assert(wo.scope_items.length > 0);
  const staff: any = await readJobWorkOrder(db, { jobId: JOB });
  assertEquals(staff.needs_checking.held.reason, "agreed_labour_missing");
});

Deno.test("auto issue: no accepted quote leaves the draft empty for the office", async () => {
  const db = baseDb({ scope_revisions: [] });
  autoIssueOn(db);
  const calls = autoIssueDoor(db);
  const r = await autoIssueJobWorkOrderForJob(db, JOB);
  assertEquals(r.reason, "not_filled");
  assertEquals(r.quote_fill?.reason, "no_accepted_quote");
  assertEquals(calls, []);
  const staff: any = await readJobWorkOrder(db, { jobId: JOB });
  assertEquals(staff.needs_checking.held.reason, "not_filled");
});

Deno.test("auto issue: an approved work order and a job that is not open are never touched", async () => {
  const sealed = baseDb({
    work_orders: [draftRow({
      status: "approved",
      approved_via: "session",
      approved_at: "2026-10-10T00:00:00Z",
    })],
  });
  autoIssueOn(sealed);
  autoIssueDoor(sealed);
  const a = await autoIssueJobWorkOrderForJob(sealed, JOB);
  assertEquals(a.reason, "already_approved");
  assertEquals(sealed.writes(), []);

  const closed = baseDb();
  closed.tables.jobs[0].status = "complete";
  autoIssueOn(closed);
  const calls = autoIssueDoor(closed);
  const b = await autoIssueJobWorkOrderForJob(closed, JOB);
  assertEquals(b.reason, "job_not_open");
  assertEquals(calls, []);
  assertEquals(closed.writes(), []);
});

Deno.test("auto issue: a save that lands after the system read is not sealed", async () => {
  const db = baseDb({
    work_orders: [draftRow({
      scope_items: [{ description: "x", source: "quote" }],
      agreed_labour_ex: 500,
      quote_filled_at: "2026-10-13T00:00:00Z",
    })],
  });
  autoIssueOn(db);
  autoIssueDoor(db);
  const inner = db.rpcImpl;
  db.rpcImpl = (fn, args) => {
    // A save between the read and the issue moves updated_at.
    db.tables.work_orders[0].updated_at = "saved-later";
    return inner(fn, args);
  };
  const r = await autoIssueJobWorkOrderForJob(db, JOB);
  assertEquals(r.reason, "draft_changed");
  assertEquals(db.tables.work_orders[0].status, "draft");
  assertEquals(
    db.tables.job_events.filter((e) =>
      e.event_type === "job_work_order_auto_issued"
    ),
    [],
  );
});

Deno.test("auto issue sweep: switched off writes nothing; on, it issues filled and fresh drafts and leaves old empty or hand-edited ones", async () => {
  const NOW = new Date("2026-10-14T00:00:00Z");
  const jobs: any[] = [];
  const work_orders: any[] = [];
  const add = (n: number, wo: Record<string, unknown>) => {
    const jobId = `11111111-1111-4111-8111-1111111110${n}`;
    jobs.push({
      id: jobId,
      org_id: ORG,
      job_number: `SWF-${n}`,
      type: "fencing",
      status: "scheduled",
      expected_costs: { scope_revision_id: REV_ACCEPTED },
    });
    work_orders.push(draftRow({
      id: `33333333-3333-4333-8333-3333333330${n}`,
      job_id: jobId,
      jobs: { type: "fencing", status: "scheduled" },
      ...wo,
    }));
    return jobId;
  };
  const filledJob = add(10, {
    scope_items: [{ description: "Install", source: "quote" }],
    agreed_labour_ex: 500,
    quote_filled_at: "2026-10-01T00:00:00Z",
    created_at: "2026-10-01T00:00:00Z",
  });
  const freshJob = add(11, { created_at: "2026-10-13T12:00:00Z" });
  const oldEmptyJob = add(12, { created_at: "2026-10-01T00:00:00Z" });
  const editedJob = add(13, {
    scope_items: [{ description: "Typed" }],
    agreed_labour_ex: 500,
    hand_edited_at: "2026-10-02T00:00:00Z",
    created_at: "2026-10-01T00:00:00Z",
  });
  const db = baseDb({
    jobs,
    work_orders,
    scope_revisions: [11].map(() => ({
      id: REV_ACCEPTED,
      job_id: freshJob,
      revision_number: 1,
      status: "frozen",
      frozen_at: "2026-10-05T08:55:20Z",
      pricing_canonical_text: JSON.stringify(ACCEPTED_PRICING),
    })),
  });
  autoIssueDoor(db);

  const off: any = await autoIssueJobWorkOrders(db, {}, NOW);
  assertEquals(off.switched_on, false);
  assertEquals(db.writes(), []);

  autoIssueOn(db);
  const on: any = await autoIssueJobWorkOrders(db, {}, NOW);
  assertEquals(on.switched_on, true);
  assertEquals(on.issued, 2);
  const status = (jobId: string) =>
    db.tables.work_orders.find((w) => w.job_id === jobId).status;
  assertEquals(status(filledJob), "approved");
  assertEquals(status(freshJob), "approved");
  assertEquals(status(oldEmptyJob), "draft");
  assertEquals(status(editedJob), "draft");
  assert(
    !on.results.some((x: any) =>
      x.job_id === oldEmptyJob || x.job_id === editedJob
    ),
  );
});

Deno.test("backfill: while automatic issue is on, every draft it fills goes to the trades", async () => {
  const db = baseDb();
  autoIssueOn(db);
  const calls = autoIssueDoor(db);
  const inner = db.rpcImpl;
  db.rpcImpl = (fn, args) =>
    fn === "backfill_job_work_order_drafts"
      ? {
        data: { dry_run: !args.p_apply, candidates: 0, opened: 0, job_ids: [] },
        error: null,
      }
      : inner(fn, args);

  const dry: any = await backfillJobWorkOrders(db, {});
  assertEquals(dry.auto_issue, { dry_run: true, switched_on: true });
  assertEquals(db.writes(), []);

  const applied: any = await backfillJobWorkOrders(db, { apply: true });
  assertEquals(applied.quote_fill.filled, 1);
  assertEquals(applied.auto_issue, {
    switched_on: true,
    issued: 1,
    not_issued: {},
  });
  assertEquals(db.tables.work_orders[0].approved_via, "auto");
  assertEquals(
    calls.filter((c) => c.fn === "auto_issue_job_work_order").length,
    1,
  );
});

// ── A job moved past quoted with no recorded acceptance (captain, 16 Oct) ────

/** The SWP-261550 shape: moved straight to an open status by an Ops status
 *  change, so no acceptance time and no revision recorded at acceptance. Its
 *  one tool quote (5 Oct) is still frozen. */
function movedPastQuotedDb() {
  const db = baseDb();
  Object.assign(db.tables.jobs[0], {
    status: "scheduled",
    accepted_at: null,
    expected_costs: null,
    pricing_json: { line_items: [], labourCostEstimate: 999 },
  });
  return db;
}

/** Moved on, then re-quoted: the first quote superseded, the re-quote frozen. */
function requotedDb() {
  const db = movedPastQuotedDb();
  db.tables.scope_revisions[0].status = "superseded";
  db.tables.scope_revisions.push(laterRevision());
  return db;
}

Deno.test("moved past quoted: the job counts as accepted at its latest frozen quote, never live pricing", async () => {
  const db = movedPastQuotedDb();
  const p = await previewQuoteWorkOrderLines(db, JOB);
  assertEquals([p.quote.source, p.quote.scope_revision_id, p.quote.flags], [
    "latest_frozen_revision",
    REV_ACCEPTED,
    [],
  ]);
  assertEquals(p.result.agreed_labour_ex, ACCEPTED_AGREED);
  // Counting it as accepted adds no review flag of its own.
  const outcome = await fillJobWorkOrderDraftFromQuote(db, JOB);
  assertEquals([outcome.filled, outcome.reason, outcome.scope_revision_id], [
    true,
    "filled",
    REV_ACCEPTED,
  ]);
  assertEquals(db.tables.work_orders[0].agreed_labour_ex, ACCEPTED_AGREED);
  const event = db.tables.job_events.find((e) =>
    e.event_type === "job_work_order_draft_filled_from_quote"
  );
  assertEquals(event.detail_json.quote_source, "latest_frozen_revision");
  // Nothing is written to the job: no acceptance time is invented.
  assertEquals(db.tables.jobs[0].accepted_at, null);
  assert(!db.writes().includes("update:jobs"));
});

Deno.test("moved past quoted: a re-quote fills from the current frozen revision, never the superseded one", async () => {
  const db = requotedDb();
  const p = await previewQuoteWorkOrderLines(db, JOB);
  assertEquals([p.quote.source, p.quote.scope_revision_id], [
    "latest_frozen_revision",
    REV_NEWER,
  ]);
  const outcome = await fillJobWorkOrderDraftFromQuote(db, JOB);
  assertEquals([outcome.filled, outcome.scope_revision_id], [true, REV_NEWER]);
  const wo = db.tables.work_orders[0];
  assertEquals(wo.agreed_labour_ex, 175);
  assert(
    !JSON.stringify(wo.scope_items).includes("18.5"),
    "a superseded quote's lines reached the draft",
  );
});

Deno.test("moved past quoted: a quote frozen after the job first left quoted still fills", async () => {
  const db = movedPastQuotedDb();
  db.tables.job_events = [{
    id: "ev-left",
    job_id: JOB,
    event_type: "status_changed",
    detail_json: { new_status: "scheduled", source: "ops_dashboard" },
    created_at: "2026-10-01T00:00:00Z",
  }];
  const outcome = await fillJobWorkOrderDraftFromQuote(db, JOB);
  assertEquals([outcome.filled, outcome.scope_revision_id], [
    true,
    REV_ACCEPTED,
  ]);
  assertEquals(db.tables.work_orders[0].agreed_labour_ex, ACCEPTED_AGREED);
});

Deno.test("moved past quoted: a recorded revision or acceptance time is never overridden by the latest frozen quote", async () => {
  const recorded = requotedDb();
  recorded.tables.jobs[0].expected_costs = { scope_revision_id: REV_ACCEPTED };
  const byRevision = await previewQuoteWorkOrderLines(recorded, JOB);
  assertEquals([byRevision.quote.source, byRevision.quote.scope_revision_id], [
    "accepted_revision",
    REV_ACCEPTED,
  ]);
  const timed = requotedDb();
  timed.tables.jobs[0].accepted_at = ACCEPTED_AT;
  const byTime = await previewQuoteWorkOrderLines(timed, JOB);
  assertEquals([byTime.quote.source, byTime.quote.scope_revision_id], [
    "revision_at_acceptance",
    REV_ACCEPTED,
  ]);
});

Deno.test("moved past quoted: with nothing to fill from the draft stays with the office", async () => {
  const cases: Array<[string, (db: FakeDb) => void]> = [
    ["only superseded revisions", (db) => {
      db.tables.scope_revisions[0].status = "superseded";
    }],
    ["no frozen quote at all", (db) => {
      db.tables.scope_revisions = [];
    }],
    ["a draft revision is not a frozen quote", (db) => {
      db.tables.scope_revisions[0].status = "draft";
    }],
    ["the job is not in an open status now", (db) => {
      db.tables.jobs[0].status = "quoted";
    }],
    ["the job is lost", (db) => {
      db.tables.jobs[0].status = "lost";
    }],
    ["an acceptance time with no revision by then is not overridden", (db) => {
      db.tables.jobs[0].accepted_at = "2026-10-01T00:00:00Z";
    }],
    ["a recorded revision that cannot be found is not overridden", (db) => {
      db.tables.jobs[0].expected_costs = {
        scope_revision_id: "55555555-5555-4555-8555-555555555599",
      };
    }],
  ];
  for (const [label, arrange] of cases) {
    const db = movedPastQuotedDb();
    arrange(db);
    const p = await previewQuoteWorkOrderLines(db, JOB);
    assertEquals(
      [p.quote.source, p.quote.flags],
      [null, ["no_accepted_quote"]],
      label,
    );
    const outcome = await fillJobWorkOrderDraftFromQuote(db, JOB);
    assertEquals(outcome.reason, "no_accepted_quote", label);
    assertEquals(db.tables.work_orders[0].scope_items, [], label);
    assertEquals(db.writes(), [], label);
  }
});

Deno.test("auto issue: a job moved past quoted with a frozen tool quote goes to the trades like any other, with no amount, rate or allocation", async () => {
  const db = movedPastQuotedDb();
  autoIssueOn(db);
  const calls = autoIssueDoor(db);
  const r = await autoIssueJobWorkOrderForJob(db, JOB);
  assertEquals([r.issued, r.reason], [true, "issued"]);
  assertEquals(r.quote_fill?.scope_revision_id, REV_ACCEPTED);
  assertEquals(calls.length, 1);
  const wo = db.tables.work_orders[0];
  assertEquals([wo.status, wo.approved_via, wo.approved_by], [
    "approved",
    "auto",
    null,
  ]);
  assertEquals(wo.agreed_labour_ex, ACCEPTED_AGREED);

  const trade = await tradeJobWorkOrderRead(
    db,
    JOB,
    "trade-1",
    tradeJobWorkOrderRedaction,
  );
  const text = JSON.stringify(trade);
  for (
    const leak of [
      "needs_review",
      "needs_checking",
      "flags",
      "quote_cost_ex",
      "rate",
      "total",
      "counted",
      "agreed",
      "allocation",
      "approved_via",
      "latest_frozen_revision",
      "$",
      String(ACCEPTED_AGREED),
      "175",
      "999",
      "160",
    ]
  ) {
    assert(!text.includes(leak), `trade read leaked ${leak}: ${text}`);
  }
  const lines = (trade.work_order as any).scope_items;
  assert(lines.length > 0);
  for (const line of lines) {
    for (const key of Object.keys(line)) {
      assert(
        ["description", "qty", "unit", "hours"].includes(key),
        `trade line carries ${key}`,
      );
    }
  }
});
