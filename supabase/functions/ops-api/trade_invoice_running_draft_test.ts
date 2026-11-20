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
  applyOwnerCommand,
  getRunningInvoiceDraft,
  keepAgentCardsOnTradeSave,
  mergeApproved,
  requireRunningDraftAgentCaller,
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
    trade_pay_settings: [],
  };
  rpcs: Array<{ name: string; args: Record<string, unknown> }> = [];
  ghostColumnMissing = false;
  newIdEverySave = false;
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
    // Production replaces the draft row with a new id on every save;
    // newIdEverySave models that. Older cases keep the id.
    const id = (!this.newIdEverySave && prior) ||
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
      gst: invoice.gst,
      subtotal_ex: invoice.subtotal_ex,
      gross_earned: invoice.gross_earned,
      net_pay: invoice.net_pay,
      super_rate: invoice.super_rate,
      super_amount: invoice.super_amount,
      super_basis: invoice.super_basis ?? null,
      super_base_ex: invoice.super_base_ex ?? null,
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

Deno.test("running invoice draft is on unless the profile says exactly false", () => {
  assertEquals(runningInvoiceDraftEnabled(null), true);
  assertEquals(runningInvoiceDraftEnabled(undefined), true);
  assertEquals(runningInvoiceDraftEnabled({}), true);
  assertEquals(runningInvoiceDraftEnabled({ runningInvoiceDraft: true }), true);
  assertEquals(runningInvoiceDraftEnabled({ runningInvoiceDraft: "true" }), true);
  assertEquals(runningInvoiceDraftEnabled({ runningInvoiceDraft: null }), true);
  assertEquals(
    runningInvoiceDraftEnabled({ runningInvoiceDraft: false }),
    false,
  );
  // Only the literal false switches it off.
  assertEquals(
    runningInvoiceDraftEnabled({ runningInvoiceDraft: "false" }),
    true,
  );
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
  const body = saveBody();
  body.draft_builder.groupIds = ["33333333-3333-4333-8333-333333333333"];
  const saved = await saveRunningInvoiceDraft(db, USER, body, "staff");
  assertEquals(saved.ok, true);
  assertEquals(saved.status, "draft");
  assertEquals(saved.xero, false);
  assertEquals(saved.submitted, false);
  assertEquals(saved.created_by_agent, false);
  assertEquals(saved.draft_origin, "staff");
  assertEquals(saved.pay_rules, "unchanged_until_submit");
  assertEquals(saved.added, ["wo:" + WO_READY]);

  const builder = saved.draft_builder as Row;
  assertEquals(builder.groupIds, ["33333333-3333-4333-8333-333333333333"]);
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

Deno.test("an unset flag saves (on by default)", async () => {
  const db = baseDb();
  db.tables.users[0] = user({});
  await saveRunningInvoiceDraft(db, USER, saveBody(), "agent");
  assertEquals(db.rpcs.length, 1);
});

Deno.test("the flag switched off (false) refuses the save and writes nothing", async () => {
  const db = baseDb();
  db.tables.users[0] = user({ runningInvoiceDraft: false });
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

// P1-01.3 money review: a draft already priced keeps the rule it was priced
// under when saved again, whichever way the switch moved; only a new or
// unpriced draft reads the switch (resolveTradePayBasis). The same rows run
// over the ordinary draft save and the weekly submit in
// trade_pay_rule_handler_test.ts.
// 2 h x $50 = $100. Inclusive: the fund gets 100 x 12/112 = 10.71, the
// person 89.29. Old rule: super 12.00, the person 94.00 (6% withheld).
const RUNNING_RE_SAVE_CASES = [
  {
    name: "stored inclusive draft, switch off",
    first: true,
    second: false,
    expected: ["inclusive_12_112_v1", 100, 10.71, 89.29],
  },
  {
    name: "stored old-rule draft, switch on from its week",
    first: false,
    second: true,
    expected: [null, 100, 12, 94],
  },
];

for (const row of RUNNING_RE_SAVE_CASES) {
  Deno.test(`running draft saved again over a ${row.name}: basis and split unchanged`, async () => {
    const db = baseDb();
    db.tables.feature_flags.push({
      flag_name: "trade_pay_inclusive_super_v1",
      enabled: row.first,
    });
    db.tables.trade_pay_settings.push({ id: 1, inclusive_super_from: WEEK });
    const first = await saveRunningInvoiceDraft(db, USER, saveBody(), "staff");
    const header = (invoice: Row) =>
      [invoice.super_basis ?? null, invoice.gross_earned, invoice.super_amount, invoice.net_pay];
    assertEquals(header(lastRpc(db).args.p_invoice as Row), row.expected);

    db.tables.feature_flags[0].enabled = row.second;
    const second = await saveRunningInvoiceDraft(
      db,
      USER,
      saveBody({ draft_id: first.draft_id, notes: "Saved again" }),
      "staff",
    );
    assertEquals(second.draft_id, first.draft_id);
    assertEquals(header(lastRpc(db).args.p_invoice as Row), row.expected);
    const stored = db.tables.trade_invoices.find((r) => r.id === first.draft_id)!;
    assertEquals(header(stored), row.expected);
    // The fake does not project by the select, so pin the columns read.
    assert(/super_basis, super_base_ex/.test(MODULE_SRC.slice(
      MODULE_SRC.indexOf("async function loadWeekDrafts("),
      MODULE_SRC.indexOf("async function loadWeekDrafts(") + 900,
    )));
  });
}

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
  assert(!profile.includes("agent_get_running_invoice_draft"));

  const outer = INDEX_SRC.match(
    /case 'my_jobs':[\s\S]*?case 'submit_makesafe_report': \{/,
  );
  assert(outer);
  assert(outer[0].includes("case 'save_running_invoice_draft':"));
  assert(outer[0].includes("case 'get_running_invoice_draft':"));
  assert(outer[0].includes("case 'sync_running_invoice_draft':"));
  assert(!outer[0].includes("agent_save_running_invoice_draft"));
  assert(!outer[0].includes("agent_get_running_invoice_draft"));

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
  assert(!agentRead.includes("agent_get_running_invoice_draft"));
  assert(!routine.includes("agent_get_running_invoice_draft"));

  const agentCase = INDEX_SRC.slice(
    INDEX_SRC.indexOf("case 'agent_save_running_invoice_draft'"),
    INDEX_SRC.indexOf("case 'agent_save_running_invoice_draft'") + 900,
  );
  assert(agentCase.includes("authMode === 'api_key'"));
  assert(agentCase.includes("saveRunningInvoiceDraft"));
  assert(agentCase.includes("'agent'"));
  assert(!agentCase.includes("authModeLegacy"));
  assert(!agentCase.includes("generate_trade_invoice"));

  const getCase = INDEX_SRC.slice(
    INDEX_SRC.indexOf("case 'agent_get_running_invoice_draft'"),
    INDEX_SRC.indexOf("case 'agent_get_running_invoice_draft'") + 900,
  );
  assert(getCase.includes("requireRunningDraftAgentCaller"));
  assert(getCase.includes("serverSecretPresented"));
  assert(getCase.includes("getRunningInvoiceDraft"));
  assert(!getCase.includes("authMode === 'api_key'"));
  assert(!getCase.includes("generate_trade_invoice"));
  assert(!getCase.includes("saveRunningInvoiceDraft"));

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

Deno.test("the owner can delete an auto line, and a rebuild does not put it back or overwrite an edit", async () => {
  const db = baseDb();
  db.tables.job_assignments.push(assignment({ id: AS_HOURS, job_id: JOB }));
  db.tables.job_assignments.push(assignment({
    id: AS_PLAIN,
    job_id: JOB_B,
    jobs: jobEmbed(JOB_B),
  }));
  const first = await saveRunningInvoiceDraft(db, USER, saveBody(), "staff");
  assertEquals(
    keysOf((first.draft_builder as Row).jobCards as Row[]).includes(
      "as:" + AS_HOURS,
    ),
    true,
  );

  const removed = await saveRunningInvoiceDraft(
    db,
    USER,
    saveBody({
      draft_id: first.draft_id,
      draft_builder: {
        ...saveBody().draft_builder as Row,
        manualLock: true,
        dismissedKeys: ["as:" + AS_HOURS],
        jobCards: [hoursCard({
          assignment_id: AS_PLAIN,
          job_id: JOB_B,
          description: "Hugo changed the auto line",
          hours: 4,
          rate: 55,
          owner_edited: true,
        })],
      },
    }),
    "staff",
  );
  const removedCards = (removed.draft_builder as Row).jobCards as Row[];
  assertEquals(keysOf(removedCards).includes("as:" + AS_HOURS), false);
  assertEquals(
    ((removed.draft_builder as Row).dismissedKeys as string[]).includes(
      "as:" + AS_HOURS,
    ),
    true,
  );
  assertEquals(removedCards[0].description, "Hugo changed the auto line");
  assertEquals((removed.draft_builder as Row).manualLock, true);
  assertEquals(
    (lastRpc(db).args.p_lines as Row[]).some((line) =>
      line.description === "Hugo changed the auto line"
    ),
    true,
  );
  assertEquals((lastRpc(db).args.p_invoice as Row).xero_bill_id, undefined);

  const rebuilt = await saveRunningInvoiceDraft(
    db,
    USER,
    {
      action: "sync_running_invoice_draft",
      week_start: WEEK,
      draft_builder: {
        version: 1,
        jobCards: [hoursCard({ description: "Auto rebuilt this line", hours: 9 })],
        dismissedKeys: [],
        weekStart: WEEK,
        weekEnd: WEEK_END,
      },
    },
    "auto",
  );
  const rebuiltCards = (rebuilt.draft_builder as Row).jobCards as Row[];
  assertEquals(keysOf(rebuiltCards).includes("as:" + AS_HOURS), false);
  const kept = rebuiltCards.find((card) => card.assignment_id === AS_PLAIN);
  assertEquals(kept?.description, "Hugo changed the auto line");
  assertEquals(kept?.hours, 4);
  assertEquals((rebuilt.draft_builder as Row).manualLock, true);
  assertEquals(
    keysOf(rebuiltCards).includes("as:" + AS_PLAIN),
    true,
  );
});

Deno.test("an agent can delete and edit a line already on the owner's draft, and cannot do that to a send", async () => {
  const db = baseDb();
  db.tables.job_assignments.push(assignment({ id: AS_HOURS }));
  await saveRunningInvoiceDraft(db, USER, saveBody(), "staff");
  const saved = await saveRunningInvoiceDraft(
    db,
    USER,
    {
      action: "agent_save_running_invoice_draft",
      week_start: WEEK,
      agent_label: "grok",
      remove: ["as:" + AS_HOURS],
      edits: [],
      lines: [{
        update: true,
        assignment_id: AS_HOURS,
        description: "too late",
      }, {
        job_id: JOB_B,
        scheduled_date: "2026-10-22",
        hours: 1,
        rate: 40,
        description: "Agent line",
      }],
    },
    "agent",
  );
  assertEquals(saved.status, "draft");
  assertEquals(saved.submitted, false);
  assertEquals(saved.xero, false);
  assertEquals(saved.removed, ["as:" + AS_HOURS]);
  const cards = (saved.draft_builder as Row).jobCards as Row[];
  assertEquals(keysOf(cards).includes("as:" + AS_HOURS), false);
  assertEquals(
    cards.some((card) => card.description === "Agent line"),
    true,
  );
  assertEquals((saved.draft_builder as Row).manualLock, true);

  const again = await saveRunningInvoiceDraft(
    db,
    USER,
    { action: "sync_running_invoice_draft", week_start: WEEK },
    "auto",
  );
  assertEquals(
    keysOf((again.draft_builder as Row).jobCards as Row[]).includes(
      "as:" + AS_HOURS,
    ),
    false,
  );

  const restored = await saveRunningInvoiceDraft(
    db,
    USER,
    {
      action: "agent_save_running_invoice_draft",
      week_start: WEEK,
      resync: true,
      restore_removed: true,
    },
    "agent",
  );
  assertEquals(
    keysOf((restored.draft_builder as Row).jobCards as Row[]).includes(
      "as:" + AS_HOURS,
    ),
    true,
  );
  assertEquals(restored.xero, false);

  const edited = applyOwnerCommand({
    cards: [hoursCard()],
    dismissed: [],
    edits: [{
      assignment_id: AS_HOURS,
      description: "Assistant edited this",
      amount: 60,
    }],
  });
  assertEquals(edited.edited, ["as:" + AS_HOURS]);
  assertEquals(edited.cards[0].description, "Assistant edited this");
  assertEquals(edited.cards[0].rate, 60);
  assertEquals(edited.cards[0].owner_edited, true);
  const notReplaced = mergeApproved({
    cards: edited.cards,
    dismissed: edited.dismissed,
    claimed: [],
    suggested: [{
      assignment_id: AS_HOURS,
      description: "Auto rebuilt this line",
      hours: 9,
    }],
  });
  assertEquals(notReplaced.added, []);
  assertEquals(notReplaced.cards[0].description, "Assistant edited this");
  assertEquals(notReplaced.cards[0].hours, 2);
});

Deno.test("an agent edit or delete does not need a lines array, and it stays a draft", async () => {
  const db = baseDb();
  db.tables.job_assignments.push(assignment({ id: AS_HOURS }));
  db.tables.job_assignments.push(assignment({
    id: AS_PLAIN,
    job_id: JOB_B,
    jobs: jobEmbed(JOB_B),
  }));
  await saveRunningInvoiceDraft(db, USER, saveBody(), "staff");

  const edited = await saveRunningInvoiceDraft(
    db,
    USER,
    {
      action: "agent_save_running_invoice_draft",
      week_start: WEEK,
      edits: [{
        assignment_id: AS_HOURS,
        description: "Edited without lines",
        hours: 3,
      }],
    },
    "agent",
  );
  assertEquals(edited.status, "draft");
  assertEquals(edited.submitted, false);
  assertEquals(edited.xero, false);
  assertEquals(edited.edited, ["as:" + AS_HOURS]);
  assertEquals("lines" in (edited as Row), false);
  const editedCard = ((edited.draft_builder as Row).jobCards as Row[])
    .find((card) => card.assignment_id === AS_HOURS);
  assertEquals(editedCard?.description, "Edited without lines");
  assertEquals(editedCard?.hours, 3);
  assertEquals((lastRpc(db).args.p_invoice as Row).status, "draft");
  assertEquals((lastRpc(db).args.p_invoice as Row).xero_bill_id, undefined);

  const removed = await saveRunningInvoiceDraft(
    db,
    USER,
    {
      action: "agent_save_running_invoice_draft",
      week_start: WEEK,
      remove: ["as:" + AS_HOURS, { assignment_id: AS_PLAIN }],
    },
    "agent",
  );
  assertEquals(removed.status, "draft");
  assertEquals(removed.submitted, false);
  assertEquals(removed.xero, false);
  assertEquals(removed.removed, ["as:" + AS_HOURS, "as:" + AS_PLAIN]);
  assertEquals(
    keysOf((removed.draft_builder as Row).jobCards as Row[]).includes(
      "as:" + AS_HOURS,
    ),
    false,
  );
  assertEquals(
    keysOf((removed.draft_builder as Row).jobCards as Row[]).includes(
      "as:" + AS_PLAIN,
    ),
    false,
  );
  assertEquals((lastRpc(db).args.p_invoice as Row).xero_bill_id, undefined);
});

Deno.test("agent_get_running_invoice_draft allows only a server-secret agent actor", () => {
  assertEquals(
    requireRunningDraftAgentCaller({
      authMode: "api_key",
      serverSecretPresented: true,
      actor: { actor: "agent:jarvis-mcp", source: "header" },
    }).actor,
    "agent:jarvis-mcp",
  );
  const refused = [
    {
      authMode: "api_key",
      serverSecretPresented: false,
      actor: { actor: "agent:jarvis-mcp", source: "header" },
    },
    {
      authMode: "jwt",
      serverSecretPresented: false,
      actor: { actor: "agent:jarvis-mcp", source: "header" },
    },
    {
      authMode: "routine",
      serverSecretPresented: false,
      actor: { actor: "agent:jarvis-mcp", source: "header" },
    },
    {
      authMode: "api_key",
      serverSecretPresented: true,
      actor: { actor: "user:" + USER, source: "header" },
    },
    {
      authMode: "api_key",
      serverSecretPresented: true,
      actor: null,
    },
  ];
  for (const input of refused) {
    let code = "";
    let status = 0;
    try {
      requireRunningDraftAgentCaller(input);
    } catch (error) {
      if (error instanceof RunningDraftError) {
        code = error.code;
        status = error.status;
      }
    }
    assertEquals(code, "agent_actor_required");
    assertEquals(status, 403);
  }
});

Deno.test("an agent draft is what the Trade App opens, and a sync does not drop the lines", async () => {
  const db = baseDb();
  db.tables.job_assignments.push(assignment({ id: AS_HOURS }));
  const saved = await saveRunningInvoiceDraft(db, USER, {
    action: "agent_save_running_invoice_draft",
    week_start: WEEK,
    agent_label: "Jarvis",
    gst_on: false,
    lines: [{
      assignment_id: AS_HOURS,
      job_id: JOB,
      job_number: "SW-3331",
      client_name: "Ada Quartermain",
      site_suburb: "Fremantle",
      scheduled_date: "2026-10-20",
      start_time: "07:00",
      finish_time: "09:00",
      break_minutes: 0,
      hours: 2,
      rate: 50,
      description: "Bot filled the fence",
    }, {
      job_id: JOB_B,
      job_number: "SW-3332",
      client_name: "Ada Quartermain",
      scheduled_date: "2026-10-22",
      start_time: "10:00",
      finish_time: "12:00",
      break_minutes: 0,
      hours: 2,
      rate: 40,
      description: "Bot added a searched job",
    }],
  }, "agent");

  const cards = (saved.draft_builder as Row).jobCards as Row[];
  const fence = cards.find((card) => card.assignment_id === AS_HOURS);
  assertEquals(fence?.description, "Bot filled the fence");
  assertEquals(fence?.start_time, "07:00");
  assertEquals(fence?.finish_time, "09:00");
  assertEquals(fence?.work_date, "2026-10-20");
  assertEquals(fence?.hours, 2);
  assertEquals(fence?.rate, 50);
  assertEquals(fence?.added_by_agent, true);
  assertEquals(fence?.added_by_label, "Jarvis");
  assertEquals(fence?.auto, false);
  assertEquals(
    keysOf(cards).filter((key) => key === "as:" + AS_HOURS).length,
    1,
  );
  const searched = cards.find((card) =>
    card.description === "Bot added a searched job"
  );
  assertEquals(searched?.added_by_agent, true);
  assertEquals(searched?.added_by_label, "Jarvis");
  assertEquals(searched?.hours, 2);
  assertEquals(saved.status, "draft");
  assertEquals(saved.submitted, false);
  assertEquals(saved.xero, false);
  assertEquals((saved.draft_builder as Row).manualLock, true);

  const expected = calculateTradeInvoiceMoney({
    grossEarned: 180,
    gstOn: false,
    earningsDate: WEEK_END,
  });
  const invoice = lastRpc(db).args.p_invoice as Row;
  assertEquals(invoice.status, "draft");
  assertEquals(invoice.gross_earned, expected.gross_earned);
  assertEquals(invoice.super_rate, expected.super_rate);
  assertEquals(invoice.super_amount, expected.super_amount);
  assertEquals(invoice.gst, expected.gst_amount);
  assertEquals(invoice.net_pay, expected.net_pay);
  assertEquals(invoice.total_inc, expected.total_inc);
  assertEquals("recurring_deduction_amount" in invoice, false);
  assertEquals(invoice.xero_bill_id, undefined);

  const loaded = await getRunningInvoiceDraft(db, USER, WEEK);
  assertEquals(loaded.draft_id, saved.draft_id);
  assertEquals(loaded.created_by_agent, true);
  assertEquals(loaded.draft_origin, "agent");
  assertEquals(loaded.agent_label, "Jarvis");
  assertEquals(loaded.xero, false);
  assertEquals(loaded.status, "draft");
  assertEquals(loaded.draft_builder, saved.draft_builder);
  const money = loaded.money as Row;
  assertEquals(money.gross_earned, expected.gross_earned);
  assertEquals(money.gst_on, false);
  assertEquals(money.gst, expected.gst_amount);
  assertEquals(money.super_rate, expected.super_rate);
  assertEquals(money.super_amount, expected.super_amount);
  assertEquals(money.net_pay, expected.net_pay);
  assertEquals(money.total_inc, expected.total_inc);
  assertEquals(money.recurring_deduction, null);
  assertEquals(money.pay_unconfirmed, true);

  const synced = await saveRunningInvoiceDraft(db, USER, {
    action: "sync_running_invoice_draft",
    week_start: WEEK,
    draft_builder: {
      version: 1,
      jobCards: [],
      dismissedKeys: [],
      notes: "",
      gst_on: false,
      weekStart: WEEK,
      weekEnd: WEEK_END,
    },
  }, "auto");
  const syncedCards = (synced.draft_builder as Row).jobCards as Row[];
  assertEquals(
    syncedCards.find((card) => card.assignment_id === AS_HOURS)?.description,
    "Bot filled the fence",
  );
  assertEquals(
    syncedCards.find((card) => card.assignment_id === AS_HOURS)?.finish_time,
    "09:00",
  );
  assertEquals(
    syncedCards.find((card) => card.assignment_id === AS_HOURS)
      ?.added_by_label,
    "Jarvis",
  );
  assertEquals(
    syncedCards.some((card) => card.description === "Bot added a searched job"),
    true,
  );
  assertEquals(synced.created_by_agent, true);
  assertEquals(synced.submitted, false);
  assertEquals(synced.xero, false);
  const syncedInvoice = lastRpc(db).args.p_invoice as Row;
  assertEquals(syncedInvoice.status, "draft");
  assertEquals(syncedInvoice.gross_earned, expected.gross_earned);
  assertEquals(syncedInvoice.xero_bill_id, undefined);

  const rebuilt = await saveRunningInvoiceDraft(db, USER, {
    action: "sync_running_invoice_draft",
    week_start: WEEK,
    resync: true,
    draft_builder: {
      version: 1,
      jobCards: [],
      dismissedKeys: [],
      gst_on: false,
      weekStart: WEEK,
      weekEnd: WEEK_END,
    },
  }, "auto");
  const rebuiltCards = (rebuilt.draft_builder as Row).jobCards as Row[];
  assertEquals(
    rebuiltCards.find((card) => card.assignment_id === AS_HOURS)?.description,
    "Bot filled the fence",
  );
  assertEquals(
    rebuiltCards.find((card) => card.assignment_id === AS_HOURS)?.start_time,
    "07:00",
  );
  assertEquals(
    rebuiltCards.find((card) => card.assignment_id === AS_HOURS)?.finish_time,
    "09:00",
  );
  assertEquals(
    rebuiltCards.some((card) => card.description === "Bot added a searched job"),
    true,
  );

  const staff = await saveRunningInvoiceDraft(db, USER, {
    action: "save_running_invoice_draft",
    week_start: WEEK,
    gst_on: false,
    draft_builder: rebuilt.draft_builder,
  }, "staff");
  assertEquals(staff.created_by_agent, true);
  assertEquals(staff.draft_origin, "agent");
  assertEquals(staff.submitted, false);
  assertEquals(staff.xero, false);
  assertEquals(
    ((staff.draft_builder as Row).jobCards as Row[]).find((card) =>
      card.assignment_id === AS_HOURS
    )?.added_by_label,
    "Jarvis",
  );
  const again = await getRunningInvoiceDraft(db, USER, WEEK);
  assertEquals(
    ((again.draft_builder as Row).jobCards as Row[]).map((card) =>
      card.description
    ).sort(),
    ["Bot added a searched job", "Bot filled the fence"],
  );
  assertEquals((again.money as Row).gross_earned, expected.gross_earned);
  assertEquals((again.money as Row).recurring_deduction, null);
});

// ── A trade save keeps the agent's lines (the owner's texted hours) ──────────
// The Trade App and the Crew app post their whole local copy on every save.
// Production gives the draft a new id on every save and refuses a save that
// names any other id (draft_replaced), so a save naming the current id was
// built on the draft holding every agent line. Only a save naming no id (an
// old cached client, or a phone that opened the week before any draft) can
// be missing lines it never saw.

const AGENT_DAY_A = "2026-10-20";
const AGENT_DAY_B = "2026-10-22";

const AGENT_LINE_A: Row = {
  assignment_id: AS_HOURS,
  job_id: JOB,
  job_number: "SW-3331",
  client_name: "Ada Quartermain",
  site_suburb: "Fremantle",
  scheduled_date: AGENT_DAY_A,
  start_time: "07:00",
  finish_time: "11:00",
  break_minutes: 0,
  rate: 50,
  description: "Texted: fence A",
};

const AGENT_LINE_B: Row = {
  job_id: JOB_B,
  job_number: "SW-3332",
  client_name: "Ada Quartermain",
  scheduled_date: AGENT_DAY_B,
  start_time: "10:00",
  finish_time: "12:00",
  break_minutes: 0,
  rate: 40,
  description: "Texted: job B",
};

const KEY_A = "as:" + AS_HOURS;
const KEY_B = `job:${JOB_B}:${AGENT_DAY_B}`;

// The agent saves the given lines (A and B by default) on a database that
// gives every save a new draft id, as production does.
async function agentSavedWeek(
  lines: Row[] = [AGENT_LINE_A, AGENT_LINE_B],
): Promise<{ db: FakeDb; draftId: string }> {
  const db = baseDb();
  db.newIdEverySave = true;
  db.tables.job_assignments.push(assignment({ id: AS_HOURS }));
  const saved = await saveRunningInvoiceDraft(db, USER, {
    action: "agent_save_running_invoice_draft",
    week_start: WEEK,
    agent_label: "Jarvis",
    gst_on: false,
    lines,
  }, "agent");
  return { db, draftId: String(saved.draft_id) };
}

// What a phone that opened the week before the agent saved still holds: the
// server's suggestion for the booking, untouched, and nothing for B.
function staleSuggestionForA(): Row {
  return {
    assignment_id: AS_HOURS,
    job_id: JOB,
    job_number: "SW-3331",
    client_name: "Ada Quartermain",
    site_suburb: "Fremantle",
    job_type: "fencing",
    scheduled_date: AGENT_DAY_A,
    included: true,
    auto: true,
  };
}

// draftId null: the save names no draft (an old client, or a phone that
// opened the week before there was one).
function phoneSave(
  draftId: string | null,
  jobCards: unknown[],
  dismissedKeys: string[] = [],
  over: Row = {},
): Row {
  return {
    action: "save_running_invoice_draft",
    week_start: WEEK,
    ...(draftId ? { draft_id: draftId } : {}),
    gst_on: false,
    notes: "",
    draft_builder: {
      version: 1,
      jobCards,
      invRows: [],
      invLumpLines: [],
      dismissedKeys,
      notes: "",
      gst_on: false,
      weekStart: WEEK,
      weekEnd: WEEK_END,
    },
    dismissed_source_keys: dismissedKeys,
    ...over,
  };
}

function jobCardsOf(result: Record<string, unknown>): Row[] {
  return (result.draft_builder as Row).jobCards as Row[];
}

function cardByKey(
  result: Record<string, unknown>,
  key: string,
): Row | undefined {
  return jobCardsOf(result).find((card) => sourceKey(card) === key);
}

function savedLines(db: FakeDb): Row[] {
  return (lastRpc(db).args.p_lines as Row[]) || [];
}

function hoursOn(db: FakeDb, jobId: string): number {
  return savedLines(db)
    .filter((line) => line.job_id === jobId)
    .reduce((sum, line) => sum + Number(line.total_hours || 0), 0);
}

Deno.test("a phone saving an older copy (no draft id) keeps the agent's lines A and B", async () => {
  const { db } = await agentSavedWeek();
  const saved = await saveRunningInvoiceDraft(
    db,
    USER,
    phoneSave(null, [staleSuggestionForA()]),
    "staff",
  );
  const a = cardByKey(saved, KEY_A);
  const b = cardByKey(saved, KEY_B);
  assertEquals(a?.added_by_agent, true);
  assertEquals(a?.hours, 4);
  assertEquals(a?.description, "Texted: fence A");
  assertEquals(b?.added_by_agent, true);
  assertEquals(b?.hours, 2);
  const keys = keysOf(jobCardsOf(saved));
  assertEquals(keys.filter((key) => key === KEY_A).length, 1);
  assertEquals(keys.filter((key) => key === KEY_B).length, 1);
  assertEquals(savedLines(db).length, 2);
  assertEquals(hoursOn(db, JOB), 4);
  assertEquals(hoursOn(db, JOB_B), 2);
  assertEquals(saved.submitted, false);
  assertEquals(saved.xero, false);

  // A phone that holds no cards at all loses nothing either.
  const empty = await saveRunningInvoiceDraft(
    db,
    USER,
    phoneSave(null, []),
    "staff",
  );
  assertEquals(cardByKey(empty, KEY_A)?.hours, 4);
  assertEquals(cardByKey(empty, KEY_B)?.hours, 2);
  assertEquals(savedLines(db).length, 2);
});

Deno.test("a line the phone dismissed stays gone; the other agent line is kept", async () => {
  const { db } = await agentSavedWeek();
  const saved = await saveRunningInvoiceDraft(
    db,
    USER,
    phoneSave(null, [], [KEY_A]),
    "staff",
  );
  assertEquals(cardByKey(saved, KEY_A), undefined);
  assertEquals(cardByKey(saved, KEY_B)?.hours, 2);
  assertEquals(
    ((saved.draft_builder as Row).dismissedKeys as string[]).includes(KEY_A),
    true,
  );
  assertEquals(savedLines(db).length, 1);
  assertEquals(savedLines(db)[0].job_id, JOB_B);

  // body.remove is a removal too.
  const removed = await saveRunningInvoiceDraft(
    db,
    USER,
    phoneSave(null, [], [KEY_A], { remove: [KEY_B] }),
    "staff",
  );
  assertEquals(cardByKey(removed, KEY_B), undefined);
  assertEquals(savedLines(db).length, 0);
});

// Review defect 2: the Crew app removes a line with no booking by leaving it
// out, without dismissing it. A save built on the current draft is believed.
Deno.test("a line left out of a save built on the current draft stays removed", async () => {
  const { db, draftId } = await agentSavedWeek();
  const opened = await getRunningInvoiceDraft(db, USER, WEEK);
  assertEquals(opened.draft_id, draftId);
  const withoutB = jobCardsOf(opened as Record<string, unknown>).filter((
    card,
  ) => sourceKey(card) !== KEY_B);
  const saved = await saveRunningInvoiceDraft(
    db,
    USER,
    phoneSave(draftId, withoutB),
    "staff",
  );
  assertEquals(cardByKey(saved, KEY_B), undefined);
  assertEquals(cardByKey(saved, KEY_A)?.hours, 4);
  assertEquals(hoursOn(db, JOB_B), 0);
  assertEquals(hoursOn(db, JOB), 4);
});

Deno.test("each way a phone reaches the save: stale id refused, re-read believed, no id restored", async () => {
  const { db, draftId: agentDraft } = await agentSavedWeek([AGENT_LINE_A]);
  // The phone read the week, then the agent saved B: the draft has a new id.
  const before = await getRunningInvoiceDraft(db, USER, WEEK);
  assertEquals(before.draft_id, agentDraft);
  const second = await saveRunningInvoiceDraft(db, USER, {
    action: "agent_save_running_invoice_draft",
    week_start: WEEK,
    agent_label: "Jarvis",
    lines: [AGENT_LINE_B],
  }, "agent");
  assert(second.draft_id !== agentDraft);

  // 1. A save on the id it read is refused, and names the current draft.
  const staleCards = jobCardsOf(before as Record<string, unknown>);
  const refused = await assertRejects(
    () =>
      saveRunningInvoiceDraft(
        db,
        USER,
        phoneSave(agentDraft, staleCards),
        "staff",
      ),
    RunningDraftError,
  );
  assertEquals(refused.code, "draft_replaced");
  assertEquals(refused.details, {
    current_draft_id: second.draft_id,
    week_start: WEEK,
  });
  assertEquals(cardByKey(second, KEY_B)?.hours, 2);

  // 2. A save naming no id never saw B, so B is put back.
  const noId = await saveRunningInvoiceDraft(
    db,
    USER,
    phoneSave(null, staleCards),
    "staff",
  );
  assertEquals(cardByKey(noId, KEY_B)?.hours, 2);
  assertEquals(cardByKey(noId, KEY_A)?.hours, 4);

  // 3. After re-reading, a save without B on the current id removes B.
  const reread = await getRunningInvoiceDraft(db, USER, WEEK);
  assertEquals(reread.draft_id, noId.draft_id);
  const removed = await saveRunningInvoiceDraft(
    db,
    USER,
    phoneSave(
      String(reread.draft_id),
      jobCardsOf(reread as Record<string, unknown>).filter((card) =>
        sourceKey(card) !== KEY_B
      ),
    ),
    "staff",
  );
  assertEquals(cardByKey(removed, KEY_B), undefined);
  assertEquals(hoursOn(db, JOB_B), 0);
});

Deno.test("the phone's edit to an agent line wins", async () => {
  const { db, draftId } = await agentSavedWeek();
  const opened = await getRunningInvoiceDraft(db, USER, WEEK);
  const cards = JSON.parse(
    JSON.stringify((opened.draft_builder as Row).jobCards),
  ) as Row[];
  const b = cards.find((card) => sourceKey(card) === KEY_B)!;
  b.start_time = "08:00";
  b.finish_time = "13:00";
  b.hours = 5;
  b.owner_edited = true;
  const saved = await saveRunningInvoiceDraft(
    db,
    USER,
    phoneSave(draftId, cards),
    "staff",
  );
  assertEquals(cardByKey(saved, KEY_B)?.hours, 5);
  assertEquals(cardByKey(saved, KEY_B)?.finish_time, "13:00");
  assertEquals(cardByKey(saved, KEY_A)?.hours, 4);
  assertEquals(hoursOn(db, JOB_B), 5);

  // A card the phone turned off stays off.
  const off = JSON.parse(JSON.stringify(cards)) as Row[];
  off.find((card) => sourceKey(card) === KEY_A)!.included = false;
  const turnedOff = await saveRunningInvoiceDraft(
    db,
    USER,
    phoneSave(String(saved.draft_id), off),
    "staff",
  );
  assertEquals(cardByKey(turnedOff, KEY_A)?.included, false);
  assertEquals(hoursOn(db, JOB), 0);
});

Deno.test("hours the trade typed on the booking win over the agent's line for it", async () => {
  const { db } = await agentSavedWeek();
  const typed = {
    ...staleSuggestionForA(),
    auto: false,
    start_time: "06:00",
    finish_time: "07:00",
    break_minutes: 0,
    hours: 1,
    rate: 50,
    hours_user_edited: true,
  };
  const saved = await saveRunningInvoiceDraft(
    db,
    USER,
    phoneSave(null, [typed]),
    "staff",
  );
  assertEquals(cardByKey(saved, KEY_A)?.hours, 1);
  assertEquals(cardByKey(saved, KEY_A)?.added_by_agent, undefined);
  assertEquals(hoursOn(db, JOB), 1);
  assertEquals(cardByKey(saved, KEY_B)?.hours, 2);
});

// Review defect 1: the agent saved the day by job id (job:<job>:<day>) and
// the phone typed the same day on its booking card (as:<assignment>).
Deno.test("the same job and day under another key is never billed twice", async () => {
  const byJob: Row = {
    job_id: JOB,
    job_number: "SW-3331",
    scheduled_date: AGENT_DAY_A,
    start_time: "07:00",
    finish_time: "11:00",
    break_minutes: 0,
    rate: 50,
    description: "Texted by job",
  };
  const keyByJob = `job:${JOB}:${AGENT_DAY_A}`;
  const { db } = await agentSavedWeek([byJob, AGENT_LINE_B]);
  const typed = {
    ...staleSuggestionForA(),
    auto: false,
    work_date: AGENT_DAY_A,
    start_time: "07:00",
    finish_time: "11:00",
    break_minutes: 0,
    hours: 4,
    rate: 50,
  };
  const saved = await saveRunningInvoiceDraft(
    db,
    USER,
    phoneSave(null, [typed]),
    "staff",
  );
  assertEquals(cardByKey(saved, keyByJob), undefined);
  assertEquals(hoursOn(db, JOB), 4);
  assertEquals(hoursOn(db, JOB_B), 2);

  // A line the trade added by search for the same job and day, under its own
  // key, wins the same way.
  const searched = {
    source_key: "search:abc",
    job_id: JOB_B,
    job_number: "SW-3332",
    work_date: AGENT_DAY_B,
    start_time: "09:00",
    finish_time: "12:00",
    break_minutes: 0,
    hours: 3,
    rate: 40,
  };
  const again = await saveRunningInvoiceDraft(
    db,
    USER,
    phoneSave(null, [typed, searched]),
    "staff",
  );
  assertEquals(cardByKey(again, KEY_B), undefined);
  assertEquals(hoursOn(db, JOB_B), 3);

  // An untouched booking card for that day bills nothing, so the agent's
  // line for the day is still put back.
  const { db: db2 } = await agentSavedWeek([byJob]);
  const kept = await saveRunningInvoiceDraft(
    db2,
    USER,
    phoneSave(null, [staleSuggestionForA()]),
    "staff",
  );
  assertEquals(cardByKey(kept, keyByJob)?.hours, 4);
  assertEquals(hoursOn(db2, JOB), 4);
});

Deno.test("a Crew app line re-dated by the trade replaces the agent line, not a second copy", async () => {
  const { db } = await agentSavedWeek();
  // Crew app: a job with no booking is rebuilt with no source_key and
  // crew_key "add:<the key it was read under>".
  const moved: Row = {
    assignment_id: null,
    manually_added: true,
    job_id: JOB_B,
    job_number: "SW-3332",
    client_name: "Ada Quartermain",
    scheduled_date: "2026-10-23",
    work_date: "2026-10-23",
    start_time: "10:00",
    finish_time: "12:00",
    break_minutes: 0,
    hours: 2,
    rate: 40,
    included: true,
    crew_key: "add:" + KEY_B,
  };
  const saved = await saveRunningInvoiceDraft(
    db,
    USER,
    phoneSave(null, [moved]),
    "staff",
  );
  const jobB = jobCardsOf(saved).filter((card) => card.job_id === JOB_B);
  assertEquals(jobB.length, 1);
  assertEquals(sourceKey(jobB[0]), `job:${JOB_B}:2026-10-23`);
  assertEquals(hoursOn(db, JOB_B), 2);
  assertEquals(cardByKey(saved, KEY_A)?.hours, 4);
});

// Review defect 3: a work-order amount, work-order mode, or a card turned off
// is the trade's own mark, so the agent's hours do not replace it.
Deno.test("a work-order entry or a card turned off on the booking wins over the agent's hours", async () => {
  const shapes: Row[] = [
    { wo_mode: true, wo_allocated: 800 },
    { wo_allocated: 800 },
    { wo_mode: true },
    { included: false },
    { enabled: false },
    { wo_mode: true, included: false },
  ];
  for (const shape of shapes) {
    const { db } = await agentSavedWeek();
    const card = { ...staleSuggestionForA(), ...shape };
    const saved = await saveRunningInvoiceDraft(
      db,
      USER,
      phoneSave(null, [card]),
      "staff",
    );
    const a = cardByKey(saved, KEY_A);
    assertEquals(a?.added_by_agent, undefined, JSON.stringify(shape));
    assertEquals(a?.hours, undefined, JSON.stringify(shape));
    assertEquals(hoursOn(db, JOB), 0, JSON.stringify(shape));
    if (shape.wo_allocated) assertEquals(a?.wo_allocated, 800);
    assertEquals(cardByKey(saved, KEY_B)?.hours, 2);
  }
});

// Review defect 4: a week with no agent lines saves exactly what main saved.
// (A null card already fails the save further on, on main too; this pins the
// rule itself.)
Deno.test("a save with no agent lines keeps the phone's cards as they are", async () => {
  // No agent lines: the phone's cards come back as the very same list.
  const phone = [null, hoursCard(), "x"];
  assert(keepAgentCardsOnTradeSave(phone, [hoursCard()], [], false) === phone);

  // A save with no agent lines stores the cards exactly as main did.
  const db = baseDb();
  db.newIdEverySave = true;
  const saved = await saveRunningInvoiceDraft(
    db,
    USER,
    phoneSave(null, [hoursCard()]),
    "staff",
  );
  assertEquals((saved.draft_builder as Row).jobCards, [hoursCard()]);

  // With agent lines to put back, a non-card entry is still left alone.
  const kept = keepAgentCardsOnTradeSave(
    [null, "x"],
    [{ ...AGENT_LINE_B, added_by_agent: true }],
    [],
    false,
  );
  assertEquals(kept[0], null);
  assertEquals(kept[1], "x");
  assertEquals(kept.length, 3);
  const unchanged = [null, { a: 1 }];
  assertEquals(keepAgentCardsOnTradeSave(unchanged, [], [], false), unchanged);
  assert(keepAgentCardsOnTradeSave(unchanged, [], [], false) === unchanged);
});

Deno.test("draft_replaced names the week's draft now", async () => {
  const { db, draftId } = await agentSavedWeek();
  const stale = await assertRejects(
    () =>
      saveRunningInvoiceDraft(
        db,
        USER,
        phoneSave("99999999-9999-4999-8999-999999999999", []),
        "staff",
      ),
    RunningDraftError,
  );
  assertEquals(stale.code, "draft_replaced");
  assertEquals(stale.status, 409);
  assertEquals(stale.details, { current_draft_id: draftId, week_start: WEEK });

  const none = baseDb();
  const empty = await assertRejects(
    () => saveRunningInvoiceDraft(none, USER, phoneSave(draftId, []), "staff"),
    RunningDraftError,
  );
  assertEquals(empty.code, "draft_replaced");
  assertEquals(empty.details, { current_draft_id: null, week_start: WEEK });

  // The database refused because another save replaced it first: re-read.
  const raced = await agentSavedWeek();
  const replacement = "99999999-9999-4999-8999-000000000001";
  raced.db.rpc = (name: string, args: Record<string, unknown>) => {
    raced.db.rpcs.push({ name, args });
    raced.db.tables.trade_invoices = raced.db.tables.trade_invoices.map((
      row,
    ) => row.week_start === WEEK ? { ...row, id: replacement } : row);
    return Promise.resolve({
      data: null,
      error: { message: "running draft is no longer replaceable" },
    });
  };
  const race = await assertRejects(
    () =>
      saveRunningInvoiceDraft(
        raced.db,
        USER,
        phoneSave(raced.draftId, []),
        "staff",
      ),
    RunningDraftError,
  );
  assertEquals(race.code, "draft_replaced");
  assertEquals(race.details, {
    current_draft_id: replacement,
    week_start: WEEK,
  });

  // ops-api puts these fields on the 409 body.
  const at = INDEX_SRC.indexOf("function runningDraftApiError");
  assert(at >= 0);
  assert(INDEX_SRC.slice(at, at + 400).includes("...(error.details || {})"));
});
