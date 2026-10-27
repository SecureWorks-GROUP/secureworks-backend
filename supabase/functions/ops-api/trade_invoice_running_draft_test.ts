// Running weekly invoice draft. No network. No production database.
// Save stores one hourly draft per person per week. It does not submit,
// and an agent cannot turn that save into a send or a Xero bill.
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { calculateTradeInvoiceMoney } from "./trade_invoice_money.ts";
import { RETIRE_CREW_WORK_ORDERS_FLAG } from "./crew_invoice_job_work_order.ts";
import {
  getRunningInvoiceDraft,
  mergeApproved,
  RunningDraftError,
  runningInvoiceDraftEnabled,
  saveRunningInvoiceDraft,
  sourceKey,
} from "./trade_invoice_running_draft.ts";

const USER = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const JOB = "33333333-3333-4333-8333-333333333331";
const JOB_B = "33333333-3333-4333-8333-333333333332";
const JOB_GROUP = "33333333-3333-4333-8333-333333333333";
const AS_HOURS = "44444444-4444-4444-8444-444444444441";
const AS_CLAIMED = "44444444-4444-4444-8444-444444444442";
const AS_GHOST = "44444444-4444-4444-8444-444444444443";
const AS_GROUP = "44444444-4444-4444-8444-444444444444";
const AS_PLAIN = "44444444-4444-4444-8444-444444444445";
const WO_READY = "55555555-5555-4555-8555-555555555551";
const WO_JOB_KIND = "55555555-5555-4555-8555-555555555552";
const WO_OPEN = "55555555-5555-4555-8555-555555555553";
const WO_OLD = "55555555-5555-4555-8555-555555555554";
const WO_CREW = "55555555-5555-4555-8555-555555555555";
const WO_QUOTE = "55555555-5555-4555-8555-555555555556";
const WO_CLAIMED = "55555555-5555-4555-8555-555555555557";
const WO_GROUP = "55555555-5555-4555-8555-555555555558";
const SENT = "66666666-6666-4666-8666-666666666661";
const QUOTE_VERSION = "77777777-7777-4777-8777-777777777771";
const WEEK = "2026-10-19";
const WEEK_END = "2026-10-25";

type Row = Record<string, unknown>;

class Query {
  private filters: Array<(row: Row) => boolean> = [];
  private limitN: number | null = null;
  private single = false;
  private orderBy: { column: string; ascending: boolean } | null = null;
  private failGhost = false;
  private dropGhost = false;

  constructor(private db: FakeDb, private table: string) {}

  select(columns: string) {
    if (
      this.table === "job_assignments" && columns.includes("is_ghost") &&
      this.db.ghostColumnMissing
    ) {
      this.failGhost = true;
    }
    if (this.table === "job_assignments" && !columns.includes("is_ghost")) {
      this.dropGhost = true;
    }
    return this;
  }

  eq(column: string, value: unknown) {
    this.filters.push((row) => row[column] === value);
    return this;
  }

  gte(column: string, value: unknown) {
    this.filters.push((row) => String(row[column] ?? "") >= String(value));
    return this;
  }

  lte(column: string, value: unknown) {
    this.filters.push((row) => String(row[column] ?? "") <= String(value));
    return this;
  }

  in(column: string, values: unknown[]) {
    const allowed = new Set(values.map((value) => String(value)));
    this.filters.push((row) => allowed.has(String(row[column] ?? "")));
    return this;
  }

  not(column: string, operator: string, value: unknown) {
    if (operator === "in") {
      const banned = new Set(
        String(value).replace(/^\(|\)$/g, "").split(","),
      );
      this.filters.push((row) => !banned.has(String(row[column] ?? "")));
    }
    return this;
  }

  // The handler decides the Perth day itself. This only has to be chainable.
  or(_expression: string) {
    return this;
  }

  order(column: string, options?: { ascending?: boolean }) {
    this.orderBy = {
      column,
      ascending: options?.ascending !== false,
    };
    return this;
  }

  limit(count: number) {
    this.limitN = count;
    return this;
  }

  maybeSingle() {
    this.single = true;
    return this.execute();
  }

  then(
    resolve: (
      value: { data: unknown; error: { message: string } | null },
    ) => unknown,
    reject?: (reason: unknown) => unknown,
  ) {
    return this.execute().then(resolve, reject);
  }

  private execute(): Promise<
    { data: unknown; error: { message: string } | null }
  > {
    if (this.failGhost) {
      return Promise.resolve({
        data: null,
        error: { message: "column job_assignments.is_ghost does not exist" },
      });
    }
    let rows = (this.db.tables[this.table] || []).filter((row) =>
      this.filters.every((filter) => filter(row))
    );
    if (this.orderBy) {
      const { column, ascending } = this.orderBy;
      rows = [...rows].sort((left, right) =>
        String(left[column] ?? "").localeCompare(String(right[column] ?? "")) *
        (ascending ? 1 : -1)
      );
    }
    if (this.limitN != null) rows = rows.slice(0, this.limitN);
    if (this.dropGhost) {
      rows = rows.map((row) => {
        const copy = { ...row };
        delete copy.is_ghost;
        return copy;
      });
    }
    if (this.single) {
      return Promise.resolve({ data: rows[0] || null, error: null });
    }
    return Promise.resolve({ data: rows, error: null });
  }
}

class FakeDb {
  tables: Record<string, Row[]> = {
    users: [],
    trade_invoices: [],
    trade_invoice_lines: [],
    job_assignments: [],
    work_orders: [],
    group_work_orders: [],
    feature_flags: [],
  };
  rpcs: Array<{ name: string; args: Record<string, unknown> }> = [];
  ghostColumnMissing = false;
  private draftSeq = 1;

  from(table: string) {
    return new Query(this, table);
  }

  rpc(name: string, args: Record<string, unknown>) {
    this.rpcs.push({ name, args });
    if (name !== "persist_running_trade_invoice_draft_v1") {
      return Promise.resolve({
        data: null,
        error: { message: "unexpected rpc " + name },
      });
    }
    const invoice = args.p_invoice as Row;
    const prior = args.p_requested_prior_draft_id
      ? String(args.p_requested_prior_draft_id)
      : "";
    if (prior) {
      this.tables.trade_invoices = this.tables.trade_invoices.filter((row) =>
        row.id !== prior
      );
      this.tables.trade_invoice_lines = this.tables.trade_invoice_lines.filter(
        (row) => row.trade_invoice_id !== prior,
      );
    }
    const id = prior ||
      `88888888-8888-4888-8888-${String(this.draftSeq++).padStart(12, "0")}`;
    this.tables.trade_invoices.push({
      id,
      user_id: invoice.user_id,
      org_id: invoice.org_id,
      week_start: invoice.week_start,
      status: invoice.status,
      invoice_source: invoice.invoice_source,
      created_by_agent: args.p_created_by_agent,
      draft_builder: args.p_builder,
      draft_origin: args.p_origin,
      agent_label: args.p_agent_label,
      dismissed_source_keys: args.p_dismissed,
      notes: invoice.notes,
      gst_on: invoice.gst_on,
      subtotal_ex: invoice.subtotal_ex,
      gross_earned: invoice.gross_earned,
      net_pay: invoice.net_pay,
      super_rate: invoice.super_rate,
      super_amount: invoice.super_amount,
      total_inc: invoice.total_inc,
      created_at: "2026-10-20T01:00:00Z",
      xero_bill_id: invoice.xero_bill_id ?? null,
    });
    for (const line of (args.p_lines as Row[]) || []) {
      this.tables.trade_invoice_lines.push({
        ...line,
        trade_invoice_id: id,
      });
    }
    return Promise.resolve({ data: id, error: null });
  }
}

function user(
  tradeDetails: Record<string, unknown> = { runningInvoiceDraft: true },
) {
  return {
    id: USER,
    org_id: ORG,
    role: "trade",
    invoice_type: "hourly",
    trade_details: tradeDetails,
  };
}

function jobEmbed(id: string, status = "scheduled") {
  return {
    id,
    job_number: "SW-" + id.slice(-4),
    client_name: "Ada Quartermain",
    site_suburb: "Fremantle",
    type: "fencing",
    status,
  };
}

function assignment(over: Row = {}): Row {
  return {
    id: AS_PLAIN,
    user_id: USER,
    job_id: JOB,
    scheduled_date: "2026-10-20",
    status: "complete",
    is_ghost: false,
    invoiced_in: null,
    jobs: jobEmbed(JOB),
    ...over,
  };
}

function workOrder(over: Row = {}): Row {
  return {
    id: WO_READY,
    assigned_user_id: USER,
    job_id: JOB,
    status: "complete",
    kind: "crew",
    quote_builder_version_id: null,
    scheduled_date: "2026-10-21",
    completed_at: null,
    jobs: jobEmbed(JOB, "in_progress"),
    ...over,
  };
}

function baseDb(): FakeDb {
  const db = new FakeDb();
  db.tables.users.push(user());
  return db;
}

function hoursCard(over: Row = {}): Row {
  return {
    assignment_id: AS_HOURS,
    job_id: JOB,
    job_number: "SW-3331",
    client_name: "Ada Quartermain",
    site_suburb: "Fremantle",
    scheduled_date: "2026-10-20",
    hours: 2,
    rate: 50,
    description: "Fence labour",
    start_time: "07:00",
    finish_time: "09:00",
    break_minutes: 0,
    included: true,
    ...over,
  };
}

function saveBody(over: Row = {}): Row {
  return {
    action: "save_running_invoice_draft",
    week_start: WEEK,
    notes: "Gate was locked",
    gst_on: false,
    draft_builder: {
      version: 1,
      jobCards: [hoursCard()],
      invRows: [{ id: "extra-1", description: "Tip fee", amount: 40 }],
      invLumpLines: [{ id: "lump-1", description: "Call out" }],
      dismissedKeys: [],
      notes: "Gate was locked",
      gst_on: false,
      weekStart: WEEK,
      weekEnd: WEEK_END,
    },
    ...over,
  };
}

function lastRpc(db: FakeDb) {
  const call = db.rpcs.at(-1);
  if (!call) throw new Error("no rpc");
  return call;
}

function keysOf(cards: Array<Record<string, unknown>>) {
  return cards.map((card) => sourceKey(card));
}

Deno.test("running invoice draft flag defaults off", () => {
  assertEquals(runningInvoiceDraftEnabled(null), false);
  assertEquals(runningInvoiceDraftEnabled({}), false);
  assertEquals(
    runningInvoiceDraftEnabled({ runningInvoiceDraft: false }),
    false,
  );
  assertEquals(
    runningInvoiceDraftEnabled({ runningInvoiceDraft: "true" }),
    false,
  );
  assertEquals(runningInvoiceDraftEnabled({ runningInvoiceDraft: true }), true);
});

Deno.test("source key prefers an explicit key, then work order, assignment, job day", () => {
  assertEquals(sourceKey({ source_key: "kept", work_order_id: "wo" }), "kept");
  assertEquals(sourceKey({ work_order_id: WO_READY }), "wo:" + WO_READY);
  assertEquals(sourceKey({ assignment_id: AS_HOURS }), "as:" + AS_HOURS);
  assertEquals(
    sourceKey({ job_id: JOB, scheduled_date: "2026-10-20T08:00:00Z" }),
    "job:" + JOB + ":2026-10-20",
  );
  assertEquals(sourceKey({ job_id: JOB }), "");
});

Deno.test("merge does not add a line already on the draft, dismissed, or claimed", () => {
  const merged = mergeApproved({
    cards: [{ assignment_id: AS_HOURS, hours: 2, rate: 50 }],
    dismissed: ["wo:" + WO_READY],
    claimed: ["as:" + AS_CLAIMED, "job:" + JOB_B + ":2026-10-20"],
    suggested: [
      { assignment_id: AS_HOURS, hours: 9 },
      { work_order_id: WO_READY },
      { assignment_id: AS_CLAIMED },
      { job_id: JOB_B, scheduled_date: "2026-10-20", hours: 4, rate: 80 },
      { assignment_id: AS_PLAIN },
      { client_name: "no key" },
    ],
  });
  assertEquals(merged.added, ["as:" + AS_PLAIN]);
  assertEquals(keysOf(merged.cards), ["as:" + AS_HOURS, "as:" + AS_PLAIN]);
  assertEquals(merged.cards[0].hours, 2);
  assertEquals(merged.cards[1].auto, true);
  assertEquals(merged.cards[1].included, true);
  assertEquals(merged.cards[1].source_key, "as:" + AS_PLAIN);
});

Deno.test("save then reload returns the same draft, still unsent", async () => {
  const db = baseDb();
  db.tables.job_assignments.push(assignment({ id: AS_HOURS }));
  db.tables.work_orders.push(workOrder());
  const saved = await saveRunningInvoiceDraft(db, USER, saveBody(), "staff");
  assertEquals(saved.ok, true);
  assertEquals(saved.status, "draft");
  assertEquals(saved.xero, false);
  assertEquals(saved.submitted, false);
  assertEquals(saved.created_by_agent, false);
  assertEquals(saved.draft_origin, "staff");
  assertEquals(saved.pay_rules, "unchanged_until_submit");
  assertEquals(saved.added, ["wo:" + WO_READY]);

  const builder = saved.draft_builder as Row;
  assertEquals(builder.notes, "Gate was locked");
  assertEquals(builder.gst_on, false);
  assertEquals(builder.weekStart, WEEK);
  assertEquals(builder.weekEnd, WEEK_END);
  assertEquals((builder.invRows as Row[])[0].description, "Tip fee");
  assertEquals((builder.invLumpLines as Row[])[0].description, "Call out");
  const cards = builder.jobCards as Row[];
  assertEquals(cards.length, 2);
  assertEquals(cards[0].hours, 2);
  assertEquals(cards[0].description, "Fence labour");
  assertEquals(sourceKey(cards[1]), "wo:" + WO_READY);
  assertEquals(cards[1].hours, undefined);

  const call = lastRpc(db);
  assertEquals(call.name, "persist_running_trade_invoice_draft_v1");
  const invoice = call.args.p_invoice as Row;
  const lines = call.args.p_lines as Row[];
  assertEquals(lines.length, 1);
  assertEquals(lines[0].description, "Fence labour");
  assertEquals(lines[0].assignment_ids, [AS_HOURS]);
  assertEquals(lines[0].line_date, "2026-10-20");
  assertEquals(lines[0].work_date, "2026-10-20");
  assertEquals(lines[0].start_time, "07:00");
  assertEquals(lines[0].finish_time, "09:00");
  assertEquals(invoice.status, "draft");
  assertEquals(invoice.invoice_source, "hourly");
  assertEquals(invoice.xero_bill_id, undefined);
  assertEquals("recurring_deduction_amount" in invoice, false);
  assertEquals(call.args.p_pay_unconfirmed, true);
  assertEquals(
    db.rpcs.every((row) =>
      row.name === "persist_running_trade_invoice_draft_v1"
    ),
    true,
  );

  const loaded = await getRunningInvoiceDraft(db, USER, WEEK);
  assertEquals(loaded.draft_id, saved.draft_id);
  assertEquals(loaded.status, "draft");
  assertEquals(loaded.xero, false);
  assertEquals(loaded.draft_builder, saved.draft_builder);
  assertEquals(loaded.created_by_agent, false);
});

Deno.test("header money is the existing GST and super split, not a zero super rate", async () => {
  const off = baseDb();
  await saveRunningInvoiceDraft(off, USER, saveBody(), "staff");
  const offInvoice = lastRpc(off).args.p_invoice as Row;
  const offLines = lastRpc(off).args.p_lines as Row[];
  const offMoney = calculateTradeInvoiceMoney({
    grossEarned: 100,
    gstOn: false,
    earningsDate: WEEK_END,
  });
  assertEquals(offLines[0].line_total_ex, 100);
  assertEquals(offInvoice.subtotal_ex, offMoney.gross_earned);
  assertEquals(offInvoice.gross_earned, offMoney.gross_earned);
  assertEquals(offInvoice.super_rate, offMoney.super_rate);
  assertEquals(offInvoice.super_amount, offMoney.super_amount);
  assertEquals(offInvoice.net_pay, offMoney.net_pay);
  assertEquals(offInvoice.gst, offMoney.gst_amount);
  assertEquals(offInvoice.total_inc, offMoney.total_inc);
  assertEquals(offInvoice.super_rate, 0.12);
  assert(offInvoice.super_rate !== 0);

  const on = baseDb();
  await saveRunningInvoiceDraft(
    on,
    USER,
    saveBody({
      gst_on: true,
      draft_builder: {
        ...saveBody().draft_builder as Row,
        gst_on: true,
        jobCards: [hoursCard({ hours: 2.5, rate: 80 })],
      },
    }),
    "staff",
  );
  const onInvoice = lastRpc(on).args.p_invoice as Row;
  const onMoney = calculateTradeInvoiceMoney({
    grossEarned: 200,
    gstOn: true,
    earningsDate: WEEK_END,
  });
  assertEquals(onInvoice.gross_earned, onMoney.gross_earned);
  assertEquals(onInvoice.super_amount, onMoney.super_amount);
  assertEquals(onInvoice.net_pay, onMoney.net_pay);
  assertEquals(onInvoice.gst, onMoney.gst_amount);
  assertEquals(onInvoice.total_inc, onMoney.total_inc);
  assertEquals(onInvoice.gst_on, true);
});

Deno.test("a claimed, dismissed, or already-saved card is not a second invoice line", async () => {
  const db = baseDb();
  db.tables.trade_invoices.push({
    id: SENT,
    user_id: USER,
    org_id: ORG,
    status: "submitted",
    week_start: "2026-10-12",
    invoice_source: "hourly",
    work_order_id: WO_CLAIMED,
    created_at: "2026-10-13T00:00:00Z",
  });
  db.tables.trade_invoice_lines.push({
    trade_invoice_id: SENT,
    job_id: JOB_B,
    line_date: "2026-10-20",
    assignment_ids: [AS_CLAIMED],
    source_work_order_id: WO_CLAIMED,
  });
  db.tables.job_assignments.push(
    assignment({ id: AS_HOURS }),
    assignment({
      id: AS_CLAIMED,
      job_id: JOB_B,
      invoiced_in: SENT,
      jobs: jobEmbed(JOB_B),
    }),
  );
  db.tables.work_orders.push(
    workOrder({ id: WO_READY, job_id: JOB }),
    workOrder({ id: WO_CLAIMED, job_id: JOB_B, jobs: jobEmbed(JOB_B) }),
  );
  const saved = await saveRunningInvoiceDraft(
    db,
    USER,
    saveBody({
      dismissed_source_keys: ["wo:" + WO_READY],
      draft_builder: {
        ...saveBody().draft_builder as Row,
        dismissedKeys: ["wo:" + WO_READY],
        jobCards: [
          hoursCard(),
          hoursCard({
            assignment_id: AS_CLAIMED,
            job_id: JOB_B,
            hours: 8,
            rate: 90,
            description: "Already sent",
          }),
        ],
      },
    }),
    "staff",
  );
  const cards = (saved.draft_builder as Row).jobCards as Row[];
  assertEquals(saved.added, []);
  assertEquals(keysOf(cards).includes("wo:" + WO_READY), false);
  assertEquals(keysOf(cards).includes("wo:" + WO_CLAIMED), false);
  assertEquals(keysOf(cards).includes("as:" + AS_CLAIMED), true);
  assertEquals(
    keysOf(cards).filter((key) => key === "as:" + AS_HOURS).length,
    1,
  );
  const lines = lastRpc(db).args.p_lines as Row[];
  assertEquals(lines.map((line) => line.description), ["Fence labour"]);
  assertEquals(
    lines.some((line) => line.description === "Already sent"),
    false,
  );
});

Deno.test("suggestions skip ghosts, job work orders, unfinished sent orders, other weeks, and group jobs", async () => {
  const db = baseDb();
  db.tables.job_assignments.push(
    assignment({ id: AS_GHOST, is_ghost: true }),
    assignment({ id: AS_GROUP, job_id: JOB_GROUP, jobs: jobEmbed(JOB_GROUP) }),
    assignment({ id: AS_PLAIN }),
  );
  db.tables.group_work_orders.push(
    { job_id: JOB_GROUP, status: "active" },
    { job_id: JOB, status: "void" },
  );
  db.tables.work_orders.push(
    workOrder({ id: WO_JOB_KIND, kind: "job" }),
    workOrder({
      id: WO_OPEN,
      status: "sent",
      jobs: jobEmbed(JOB, "scheduled"),
    }),
    workOrder({ id: WO_OLD, scheduled_date: "2026-09-01" }),
    workOrder({ id: WO_GROUP, job_id: JOB_GROUP, jobs: jobEmbed(JOB_GROUP) }),
    workOrder({ id: WO_READY }),
  );
  const saved = await saveRunningInvoiceDraft(
    db,
    USER,
    saveBody({
      draft_builder: {
        ...saveBody().draft_builder as Row,
        jobCards: [],
      },
    }),
    "auto",
  );
  assertEquals(saved.draft_origin, "auto");
  const keys = keysOf((saved.draft_builder as Row).jobCards as Row[]);
  assertEquals(keys.includes("as:" + AS_GHOST), false);
  assertEquals(keys.includes("as:" + AS_GROUP), false);
  assertEquals(keys.includes("as:" + AS_PLAIN), true);
  assertEquals(keys.includes("wo:" + WO_JOB_KIND), false);
  assertEquals(keys.includes("wo:" + WO_OPEN), false);
  assertEquals(keys.includes("wo:" + WO_OLD), false);
  assertEquals(keys.includes("wo:" + WO_GROUP), false);
  assertEquals(keys.includes("wo:" + WO_READY), true);
  assertEquals((lastRpc(db).args.p_lines as Row[]).length, 0);
});

Deno.test("a retired crew work order is not suggested; a quote-builder crew row still is", async () => {
  const db = baseDb();
  db.tables.feature_flags.push({
    flag_name: RETIRE_CREW_WORK_ORDERS_FLAG,
    enabled: true,
  });
  db.tables.work_orders.push(
    workOrder({ id: WO_CREW, kind: "crew" }),
    workOrder({
      id: WO_QUOTE,
      kind: "crew",
      quote_builder_version_id: QUOTE_VERSION,
      scheduled_date: "2026-10-22",
    }),
  );
  const saved = await saveRunningInvoiceDraft(
    db,
    USER,
    saveBody({
      draft_builder: { ...saveBody().draft_builder as Row, jobCards: [] },
    }),
    "staff",
  );
  const keys = keysOf((saved.draft_builder as Row).jobCards as Row[]);
  assertEquals(keys.includes("wo:" + WO_CREW), false);
  assertEquals(keys.includes("wo:" + WO_QUOTE), true);
});

Deno.test("a missing is_ghost column retries and still returns the ordinary job", async () => {
  const db = baseDb();
  db.ghostColumnMissing = true;
  db.tables.job_assignments.push(assignment({ id: AS_PLAIN, is_ghost: true }));
  const saved = await saveRunningInvoiceDraft(
    db,
    USER,
    saveBody({
      draft_builder: { ...saveBody().draft_builder as Row, jobCards: [] },
    }),
    "staff",
  );
  const keys = keysOf((saved.draft_builder as Row).jobCards as Row[]);
  assertEquals(keys, ["as:" + AS_PLAIN]);
});

Deno.test("another kind of draft already on the week is left alone", async () => {
  const db = baseDb();
  db.tables.trade_invoices.push({
    id: "99999999-9999-4999-8999-999999999991",
    user_id: USER,
    org_id: ORG,
    week_start: WEEK,
    status: "draft",
    invoice_source: "weekly_work_order",
    created_at: "2026-10-20T00:00:00Z",
  });
  const error = await assertRejects(
    () => saveRunningInvoiceDraft(db, USER, saveBody(), "staff"),
    RunningDraftError,
  );
  assertEquals(error.status, 409);
  assertEquals(error.code, "week_draft_occupied");
  assertEquals(db.rpcs.length, 0);
  const loaded = await assertRejects(
    () => getRunningInvoiceDraft(db, USER, WEEK),
    RunningDraftError,
  );
  assertEquals(loaded.code, "week_draft_occupied");
});

Deno.test("the flag off refuses the save and writes nothing", async () => {
  const db = baseDb();
  db.tables.users[0] = user({});
  const error = await assertRejects(
    () => saveRunningInvoiceDraft(db, USER, saveBody(), "agent"),
    RunningDraftError,
  );
  assertEquals(error.status, 403);
  assertEquals(error.code, "running_draft_off");
  assertEquals(db.rpcs.length, 0);
});

Deno.test("an agent save stays a draft and cannot submit, authorise, pay, or create a Xero bill", async () => {
  const blocked = [
    { submit: true },
    { send: true },
    { authorise: true },
    { authorize: true },
    { pay: true },
    { xero: true },
    { xero_bill_id: "INV-1" },
    { xero_status: "AUTHORISED" },
    { create_xero: true },
    { status: "submitted" },
    { status: "approved" },
    { action: "generate_trade_invoice" },
    { action: "submit_trade_invoice" },
    { action: "submit_work_order_invoice" },
  ];
  for (const extra of blocked) {
    const db = baseDb();
    const error = await assertRejects(
      () => saveRunningInvoiceDraft(db, USER, saveBody(extra), "agent"),
      RunningDraftError,
      undefined,
      JSON.stringify(extra),
    );
    assertEquals(error.status, 403, JSON.stringify(extra));
    assertEquals(error.code, "agent_draft_only", JSON.stringify(extra));
    assertEquals(db.rpcs.length, 0, JSON.stringify(extra));
  }

  const db = baseDb();
  const saved = await saveRunningInvoiceDraft(
    db,
    USER,
    saveBody({
      action: "agent_save_running_invoice_draft",
      agent_label: "Grok " + "x".repeat(200),
      status: "draft",
      lines: [{
        job_id: JOB_B,
        scheduled_date: "2026-10-22",
        hours: 1,
        rate: 40,
        description: "Agent line",
      }],
    }),
    "agent",
  );
  assertEquals(saved.status, "draft");
  assertEquals(saved.created_by_agent, true);
  assertEquals(saved.draft_origin, "agent");
  assertEquals(saved.submitted, false);
  assertEquals(saved.xero, false);
  assertEquals(saved.agent_label?.length, 80);
  const call = lastRpc(db);
  assertEquals(call.name, "persist_running_trade_invoice_draft_v1");
  assertEquals(call.args.p_created_by_agent, true);
  assertEquals(call.args.p_origin, "agent");
  assertEquals(call.args.p_pay_unconfirmed, true);
  const invoice = call.args.p_invoice as Row;
  assertEquals(invoice.status, "draft");
  assertEquals(invoice.invoice_source, "hourly");
  assertEquals(invoice.xero_bill_id, undefined);
  assertEquals(invoice.submitted_at, undefined);
  assertEquals("recurring_deduction_id" in invoice, false);
  const lines = call.args.p_lines as Row[];
  assertEquals(lines.map((line) => line.description).sort(), [
    "Agent line",
    "Fence labour",
  ]);
  assertEquals(
    lines.find((line) => line.description === "Agent line")?.job_id,
    JOB_B,
  );
});

Deno.test("a staff re-save keeps an agent draft marked as agent-created", async () => {
  const db = baseDb();
  const first = await saveRunningInvoiceDraft(db, USER, saveBody(), "agent");
  assertEquals(first.created_by_agent, true);
  const second = await saveRunningInvoiceDraft(
    db,
    USER,
    saveBody({ draft_id: first.draft_id, notes: "Person edited" }),
    "staff",
  );
  assertEquals(second.draft_id, first.draft_id);
  assertEquals(second.created_by_agent, true);
  assertEquals(second.draft_origin, "agent");
  assertEquals((second.draft_builder as Row).notes, "Person edited");
  assertEquals(db.rpcs.length, 2);
  assertEquals(
    db.tables.trade_invoices.filter((row) => row.week_start === WEEK).length,
    1,
  );
});

const INDEX_SRC = await Deno.readTextFile(
  new URL("./index.ts", import.meta.url),
);
const MODULE_SRC = await Deno.readTextFile(
  new URL("./trade_invoice_running_draft.ts", import.meta.url),
);
const MIGRATION_SRC = await Deno.readTextFile(
  new URL(
    "../../migrations/20261024120000_trade_invoice_running_draft.sql",
    import.meta.url,
  ),
);

function setBody(source: string, marker: string): string {
  const start = source.indexOf(marker);
  assert(start >= 0, marker);
  const end = source.indexOf("])", start);
  assert(end > start, marker);
  return source.slice(start, end);
}

Deno.test("ops-api wires the three trade actions and keeps the agent action off the read lists", () => {
  const profile = setBody(
    INDEX_SRC,
    "const OPS_API_PROFILE_SCOPED_JWT_ACTIONS = new Set([",
  );
  assert(profile.includes("'save_running_invoice_draft'"));
  assert(profile.includes("'get_running_invoice_draft'"));
  assert(profile.includes("'sync_running_invoice_draft'"));
  assert(!profile.includes("agent_save_running_invoice_draft"));

  const outer = INDEX_SRC.match(
    /case 'my_jobs':[\s\S]*?case 'submit_makesafe_report': \{/,
  );
  assert(outer);
  assert(outer[0].includes("case 'save_running_invoice_draft':"));
  assert(outer[0].includes("case 'get_running_invoice_draft':"));
  assert(outer[0].includes("case 'sync_running_invoice_draft':"));
  assert(!outer[0].includes("agent_save_running_invoice_draft"));

  const agentRead = setBody(
    INDEX_SRC,
    "export const AGENT_READ_ALLOWED_ACTIONS = new Set([",
  );
  const routine = setBody(
    INDEX_SRC,
    "const ROUTINE_ALLOWED_ACTIONS = new Set([",
  );
  assert(!agentRead.includes("running_invoice_draft"));
  assert(!routine.includes("running_invoice_draft"));

  const agentCase = INDEX_SRC.slice(
    INDEX_SRC.indexOf("case 'agent_save_running_invoice_draft'"),
    INDEX_SRC.indexOf("case 'agent_save_running_invoice_draft'") + 900,
  );
  assert(agentCase.includes("authMode === 'api_key'"));
  assert(agentCase.includes("saveRunningInvoiceDraft"));
  assert(agentCase.includes("'agent'"));
  assert(!agentCase.includes("authModeLegacy"));
  assert(!agentCase.includes("generate_trade_invoice"));

  assert(INDEX_SRC.includes(
    "running_invoice_draft: runningInvoiceDraftEnabled(userRow?.trade_details)",
  ));
  assert(!MODULE_SRC.includes("applyTradeRecurringDeduction"));
  assert(MODULE_SRC.includes("calculateTradeInvoiceMoney"));
  assert(
    MODULE_SRC.includes('rpc(\n    "persist_running_trade_invoice_draft_v1"'),
  );
  assert(MIGRATION_SRC.includes("persist_running_trade_invoice_draft_v1"));
  assert(MIGRATION_SRC.includes("persist_weekly_trade_invoice_v3"));
  assert(
    !MIGRATION_SRC.includes(
      "CREATE OR REPLACE FUNCTION public.persist_weekly_trade_invoice_v1",
    ),
  );
  assert(
    !MIGRATION_SRC.includes(
      "CREATE OR REPLACE FUNCTION public.persist_weekly_trade_invoice_v3",
    ),
  );
  assert(
    MIGRATION_SRC.includes(
      "GRANT EXECUTE ON FUNCTION public.persist_running_trade_invoice_draft_v1",
    ),
  );
});
