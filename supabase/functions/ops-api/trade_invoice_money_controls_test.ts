// Trade invoice money controls (6 Nov 2026): line acknowledgement (B12), the
// way out of pending acknowledgment (B5), the existing-bill check before a
// Xero create (B13), the extras rate rule (B14), the invoice number picker
// and the one-live-no-week-claim rule (B16).
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { XeroCooldownError } from "../_shared/xero_cooldown.ts";
import { FakeDb } from "./trade_invoice_controls_test_fakes.ts";
import {
  acknowledgeTradeInvoiceLine,
  TradeInvoiceLineAckError,
} from "./trade_invoice_line_ack.ts";
import {
  markTradeInvoiceReadyForXero,
  resolveStuckTradeInvoice,
  StuckTradeInvoiceError,
} from "./trade_invoice_stuck.ts";
import {
  createOrReuseTradeXeroBill,
  existingTradeBillWhere,
  findLiveTradeBillsByNumber,
  TradeXeroBillSearchError,
} from "./trade_invoice_xero_existing_bill.ts";
import {
  ExtraRateRuleError,
  extraLineRateCap,
  extraLineRateHold,
  loadExtraRateRules,
  setExtraRateRule,
} from "./trade_invoice_extra_rate_rule.ts";
import {
  formatTradeInvoiceNumber,
  isTradeInvoiceNumberCollision,
  nextTradeInvoiceNumber,
  tradeInvoiceInitials,
} from "./trade_invoice_number.ts";
import {
  findNoWeekClaimConflict,
  isNoWeekClaimRefusal,
  noWeekClaimKey,
} from "./trade_invoice_no_week_claim.ts";

type Row = Record<string, any>;

async function refusal<E extends Error & { code: string; status: number }>(
  run: () => Promise<unknown>,
  type: new (...args: any[]) => E,
): Promise<E> {
  try {
    await run();
  } catch (error) {
    if (error instanceof type) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

// ── B12: acknowledgement ────────────────────────────────────────────────

function ackDb(invoice: Row = {}, lines: Row[] = []): FakeDb {
  const inv = {
    id: "inv-1",
    user_id: "trade-a",
    status: "pending_acknowledgment",
    xero_bill_id: null,
    ...invoice,
  };
  const rows = lines.length ? lines : [{ id: "line-1" }];
  return new FakeDb({
    trade_invoices: [inv],
    trade_invoice_lines: rows.map((row) => ({
      trade_invoice_id: "inv-1",
      line_type: "labour",
      group_share_id: null,
      office_review_status: null,
      acknowledgment_status: "pending",
      trade_invoices: inv,
      ...row,
    })),
  });
}

Deno.test("ack: a trade acknowledges their own line and the invoice moves on once every line is done", async () => {
  const db = ackDb({}, [{ id: "line-1" }, { id: "line-2", acknowledgment_status: "acknowledged" }]);
  const result = await acknowledgeTradeInvoiceLine(db.client(), { line_id: "line-1" }, {
    staff: false,
    userId: "trade-a",
  });
  assertEquals(result.invoice_promoted, true);
  assertEquals(db.rows("trade_invoices")[0].status, "acknowledged");
  assertEquals(db.rows("trade_invoice_lines")[0].acknowledged_by, "trade-a");
});

Deno.test("ack: someone else's line reads as not found and nothing is written", async () => {
  const db = ackDb();
  const error = await refusal(
    () => acknowledgeTradeInvoiceLine(db.client(), { line_id: "line-1" }, { staff: false, userId: "trade-b" }),
    TradeInvoiceLineAckError,
  );
  assertEquals([error.status, error.code], [404, "line_not_found"]);
  assertEquals(db.writes.length, 0);
});

Deno.test("ack: no session and no staff key is refused", async () => {
  const db = ackDb();
  const error = await refusal(
    () => acknowledgeTradeInvoiceLine(db.client(), { line_id: "line-1" }, { staff: false, userId: null }),
    TradeInvoiceLineAckError,
  );
  assertEquals(error.status, 403);
});

for (const status of ["ops-reject", "draft", "failed", "approved", "pushed_to_xero", "acknowledged", "paid"]) {
  Deno.test(`ack: an invoice in ${status} cannot be acknowledged back into life`, async () => {
    const db = ackDb({ status });
    const error = await refusal(
      () => acknowledgeTradeInvoiceLine(db.client(), { line_id: "line-1" }, { staff: false, userId: "trade-a" }),
      TradeInvoiceLineAckError,
    );
    assertEquals(error.code, "invoice_not_awaiting_acknowledgment");
    assertEquals(db.rows("trade_invoices")[0].status, status);
    assertEquals(db.writes.length, 0);
  });
}

Deno.test("ack: an invoice already in Xero, a group share line and a rejected line are refused", async () => {
  for (const [invoice, line, code] of [
    [{ xero_bill_id: "bill" }, {}, "invoice_already_in_xero"],
    [{}, { group_share_id: "share" }, "group_share_line"],
    [{}, { office_review_status: "rejected" }, "line_rejected"],
  ] as const) {
    const db = ackDb(invoice, [{ id: "line-1", ...line }]);
    const error = await refusal(
      () => acknowledgeTradeInvoiceLine(db.client(), { line_id: "line-1" }, { staff: false, userId: "trade-a" }),
      TradeInvoiceLineAckError,
    );
    assertEquals(error.code, code);
    assertEquals(db.writes.length, 0);
  }
});

Deno.test("ack: a line awaiting office review is saved but the invoice is not promoted", async () => {
  const db = ackDb({}, [{ id: "line-1", office_review_status: "awaiting" }]);
  const result = await acknowledgeTradeInvoiceLine(db.client(), { line_id: "line-1" }, {
    staff: false,
    userId: "trade-a",
  });
  assertEquals(result.invoice_promoted, false);
  assertEquals(db.rows("trade_invoices")[0].status, "pending_acknowledgment");
});

Deno.test("ack: a query keeps the invoice waiting", async () => {
  const db = ackDb();
  const result = await acknowledgeTradeInvoiceLine(db.client(), {
    line_id: "line-1",
    acknowledged: false,
    query_note: "hours look wrong",
  }, { staff: false, userId: "trade-a" });
  assertEquals(result.acknowledgment_status, "queried");
  assertEquals(db.rows("trade_invoices")[0].status, "pending_acknowledgment");
});

Deno.test("ack: staff may acknowledge any trade's line, still only while it waits", async () => {
  const db = ackDb();
  const result = await acknowledgeTradeInvoiceLine(db.client(), { line_id: "line-1" }, {
    staff: true,
    userId: null,
  });
  assertEquals(result.invoice_promoted, true);
});

// ── B5: out of pending acknowledgment ────────────────────────────────────

function stuckDb(invoice: Row = {}, lines: Row[] = [{ id: "line-1" }]): FakeDb {
  return new FakeDb({
    trade_invoices: [{
      id: "inv-1",
      user_id: "trade-a",
      status: "pending_acknowledgment",
      xero_bill_id: null,
      query_note: null,
      invoice_number: "SW-INV-T-000000-001",
      ...invoice,
    }],
    trade_invoice_lines: lines.map((line) => ({
      trade_invoice_id: "inv-1",
      line_type: "labour",
      group_share_id: null,
      office_review_status: null,
      ...line,
    })),
  });
}
const office = { staff: true, userId: "office-1", label: "user:office-1" };
/** Xero searched and no live bill found. */
const noBills = { findLiveBills: () => Promise.resolve([] as Row[]) };

Deno.test("stuck: release frees the week with the reason kept and one audit event", async () => {
  const db = stuckDb();
  const result = await resolveStuckTradeInvoice(db.client(), {
    invoice_id: "inv-1",
    decision: "release",
    reason: "checked in Xero, no bill",
  }, office, noBills);
  assertEquals(result.status, "ops-reject");
  const row = db.rows("trade_invoices")[0];
  assert(String(row.query_note).includes("checked in Xero, no bill"));
  const events = db.rows("trade_invoice_events");
  assertEquals(events.length, 1);
  assertEquals(events[0].event_type, "stuck_invoice_resolved");
  assertEquals(events[0].detail.decision, "release");
});

Deno.test("stuck: send_to_xero moves it to approved, the state the push takes", async () => {
  const db = stuckDb();
  const result = await resolveStuckTradeInvoice(db.client(), {
    invoice_id: "inv-1",
    decision: "send_to_xero",
    reason: "lines are right",
  }, office, {
    findLiveBills: () => Promise.reject(new Error("send_to_xero must not search here")),
  });
  assertEquals(result.status, "approved");
});

Deno.test("stuck: refusals leave the invoice where it was", async () => {
  const cases: [Row, Row, Row[] | undefined, string][] = [
    [{ decision: "release", reason: "ok reason" }, { staff: false, userId: "x", label: "x" }, undefined, "operator_access_required"],
    [{ decision: "release", reason: "" }, office, undefined, "reason_required"],
    [{ decision: "delete", reason: "ok reason" }, office, undefined, "invalid_decision"],
    [{ decision: "release", reason: "ok reason" }, { ...office, userId: "trade-a" }, undefined, "self_resolution_forbidden"],
    [{ decision: "release", reason: "ok reason" }, office, [{ id: "l", group_share_id: "s" }], "group_invoice_uses_group_release"],
    [{ decision: "send", reason: "ok reason" }, office, [{ id: "l", office_review_status: "awaiting" }], "lines_awaiting_office_review"],
  ];
  for (const [body, actor, lines, code] of cases) {
    const db = stuckDb({}, lines);
    const error = await refusal(
      () => resolveStuckTradeInvoice(db.client(), { invoice_id: "inv-1", ...body }, actor as any, noBills),
      StuckTradeInvoiceError,
    );
    assertEquals(error.code, code);
    assertEquals(db.rows("trade_invoices")[0].status, "pending_acknowledgment");
  }
  for (const [invoice, code] of [
    [{ status: "approved" }, "invoice_not_stuck"],
    [{ xero_bill_id: "bill" }, "invoice_already_in_xero"],
  ] as const) {
    const db = stuckDb(invoice);
    const error = await refusal(
      () => resolveStuckTradeInvoice(db.client(), { invoice_id: "inv-1", decision: "release", reason: "ok reason" }, office, noBills),
      StuckTradeInvoiceError,
    );
    assertEquals(error.code, code);
  }
});

Deno.test("stuck: a concurrent change writes nothing", async () => {
  const db = stuckDb();
  db.beforeUpdate = () => {
    db.rows("trade_invoices")[0].status = "approved";
  };
  const error = await refusal(
    () => resolveStuckTradeInvoice(db.client(), { invoice_id: "inv-1", decision: "release", reason: "ok reason" }, office, noBills),
    StuckTradeInvoiceError,
  );
  assertEquals(error.code, "invoice_changed");
  assertEquals(db.rows("trade_invoice_events").length, 0);
});

Deno.test("stuck: a release is refused when Xero already holds a bill for this number (lost create reply)", async () => {
  const db = stuckDb();
  const searched: string[] = [];
  const error = await refusal(
    () =>
      resolveStuckTradeInvoice(db.client(), { invoice_id: "inv-1", decision: "release", reason: "ok reason" }, office, {
        findLiveBills: (number) => {
          searched.push(number);
          return Promise.resolve([{ InvoiceID: "bill-x", Status: "DRAFT" }]);
        },
      }),
    StuckTradeInvoiceError,
  );
  assertEquals([error.status, error.code], [409, "xero_bill_exists_for_invoice"]);
  assertEquals(searched, ["SW-INV-T-000000-001"]);
  assertEquals(db.rows("trade_invoices")[0].status, "pending_acknowledgment");
  assertEquals(db.writes.length, 0);
});

Deno.test("stuck: a release is refused when Xero cannot be searched, or the invoice has no number", async () => {
  for (const [invoice, find, status, code] of [
    [{}, () => Promise.reject(new Error("timeout")), 503, "xero_existing_bill_search_failed"],
    [{}, () => Promise.reject(new XeroCooldownError("cooling", 429, "xero_rate_limited")), 503, "xero_existing_bill_search_failed"],
    [{ invoice_number: null }, () => Promise.resolve([]), 409, "xero_bill_number_missing"],
  ] as [Row, () => Promise<Row[]>, number, string][]) {
    const db = stuckDb(invoice);
    const error = await refusal(
      () =>
        resolveStuckTradeInvoice(db.client(), { invoice_id: "inv-1", decision: "release", reason: "ok reason" }, office, {
          findLiveBills: find,
        }),
      StuckTradeInvoiceError,
    );
    assertEquals([error.status, error.code], [status, code]);
    assertEquals(db.writes.length, 0);
  }
});

Deno.test("stuck: the release lookup finds a bill by number or by reference, only live ACCPAY bills", async () => {
  const wheres: string[] = [];
  const bills = await findLiveTradeBillsByNumber(
    (_path, _at, _ti, params) => {
      wheres.push(String(params?.where));
      return Promise.resolve({
        Invoices: [
          { Type: "ACCPAY", InvoiceID: "a", Status: "DRAFT", InvoiceNumber: "N-1" },
          { Type: "ACCPAY", InvoiceID: "b", Status: "AUTHORISED", Reference: "Trade | N-1 | job" },
          { Type: "ACCPAY", InvoiceID: "c", Status: "VOIDED", InvoiceNumber: "N-1" },
          { Type: "ACCREC", InvoiceID: "d", Status: "DRAFT", InvoiceNumber: "N-1" },
          { Type: "ACCPAY", InvoiceID: "e", Status: "DRAFT", InvoiceNumber: "N-2" },
        ],
      });
    },
    { accessToken: "t", tenantId: "x" },
    "N-1",
  );
  assertEquals(bills.map((bill) => bill.InvoiceID).sort(), ["a", "b"]);
  assertEquals(wheres.length, 2);
  assert(wheres[1].includes('Reference!=null AND Reference.Contains("N-1")'));
  await assertRejects(
    () => findLiveTradeBillsByNumber(() => Promise.resolve({}), { accessToken: "t", tenantId: "x" }, "N-1"),
    TradeXeroBillSearchError,
  );
});

Deno.test("stuck: a new invoice with no hold leaves pending acknowledgment before the push", async () => {
  const db = stuckDb();
  assertEquals(await markTradeInvoiceReadyForXero(db.client(), "inv-1"), true);
  assertEquals(db.rows("trade_invoices")[0].status, "approved");
  // Already moved, or holding a bill: left alone.
  assertEquals(await markTradeInvoiceReadyForXero(db.client(), "inv-1"), false);
  const withBill = stuckDb({ xero_bill_id: "bill" });
  assertEquals(await markTradeInvoiceReadyForXero(withBill.client(), "inv-1"), false);
  assertEquals(withBill.rows("trade_invoices")[0].status, "pending_acknowledgment");
});

// ── B13: never a second draft bill ───────────────────────────────────────

const payload = {
  Invoices: [{
    Type: "ACCPAY",
    InvoiceNumber: "SW-INV-T-000000-001",
    Contact: { ContactID: "contact-1" },
  }],
};
const liveBill = (extra: Row = {}): Row => ({
  InvoiceID: "bill-1",
  Type: "ACCPAY",
  InvoiceNumber: "SW-INV-T-000000-001",
  Status: "DRAFT",
  Contact: { ContactID: "contact-1" },
  ...extra,
});

function xeroStub(list: Row[] | Error, full?: Row | Error) {
  const calls: { path: string; params?: Record<string, string> }[] = [];
  const xeroGet = (path: string, _a: string, _t: string, params?: Record<string, string>) => {
    calls.push({ path, params });
    if (path === "/Invoices") {
      if (list instanceof Error) return Promise.reject(list);
      return Promise.resolve({ Invoices: list });
    }
    if (full instanceof Error) return Promise.reject(full);
    return Promise.resolve({ Invoices: full ? [full] : [] });
  };
  return { xeroGet, calls };
}

function putCounter() {
  const puts: string[] = [];
  return {
    puts,
    putBill: (_payload: Row, key: string) => {
      puts.push(key);
      return Promise.resolve({ Invoices: [liveBill({ InvoiceID: "bill-new" })] });
    },
  };
}

const createArgs = {
  accessToken: "token",
  tenantId: "tenant",
  tradeInvoiceId: "inv-1",
  payload,
  idempotencyKey: "trade-inv-inv-1",
  actor: "test",
};

Deno.test("existing bill: the search is by exact number and ACCPAY, live statuses only", () => {
  assertEquals(
    existingTradeBillWhere('SW-INV-"X"-1'),
    'Type=="ACCPAY" AND InvoiceNumber=="SW-INV-\\"X\\"-1"',
  );
});

Deno.test("existing bill: none found creates once", async () => {
  const db = new FakeDb({ trade_invoices: [] });
  const { xeroGet, calls } = xeroStub([]);
  const put = putCounter();
  const out = await createOrReuseTradeXeroBill(db.client(), { xeroGet, putBill: put.putBill }, createArgs);
  assertEquals(out.reused, false);
  assertEquals(put.puts, ["trade-inv-inv-1"]);
  assertEquals(calls[0].params?.Statuses, "DRAFT,SUBMITTED,AUTHORISED,PAID");
});

Deno.test("existing bill: a retry after a lost reply reuses the bill and creates nothing", async () => {
  const db = new FakeDb({ trade_invoices: [{ id: "inv-1", xero_bill_id: null }] });
  const { xeroGet } = xeroStub([liveBill()], liveBill({ LineItems: [] }));
  const put = putCounter();
  const first = await createOrReuseTradeXeroBill(db.client(), { xeroGet, putBill: put.putBill }, createArgs);
  const second = await createOrReuseTradeXeroBill(db.client(), { xeroGet, putBill: put.putBill }, createArgs);
  assertEquals([first.reused, second.reused], [true, true]);
  assertEquals(first.result.Invoices[0].InvoiceID, "bill-1");
  assertEquals(put.puts.length, 0);
  const events = db.rows("trade_invoice_events");
  assertEquals(events.map((e) => e.event_type), ["xero_bill_reused", "xero_bill_reused"]);
});

Deno.test("existing bill: a bill stored on this same invoice is reused", async () => {
  const db = new FakeDb({ trade_invoices: [{ id: "inv-1", xero_bill_id: "bill-1" }] });
  const { xeroGet } = xeroStub([liveBill()], liveBill());
  const put = putCounter();
  const out = await createOrReuseTradeXeroBill(db.client(), { xeroGet, putBill: put.putBill }, createArgs);
  assertEquals(out.reused, true);
  assertEquals(put.puts.length, 0);
});

Deno.test("existing bill: a bill already stored on another invoice does not block and is not reused", async () => {
  const db = new FakeDb({ trade_invoices: [{ id: "inv-other", xero_bill_id: "bill-1" }] });
  const { xeroGet } = xeroStub([liveBill()]);
  const put = putCounter();
  const out = await createOrReuseTradeXeroBill(db.client(), { xeroGet, putBill: put.putBill }, createArgs);
  assertEquals(out.reused, false);
  assertEquals(put.puts.length, 1);
});

Deno.test("existing bill: finished, other-number and receivable rows are ignored", async () => {
  const db = new FakeDb({ trade_invoices: [] });
  const { xeroGet } = xeroStub([
    liveBill({ Status: "VOIDED" }),
    liveBill({ InvoiceNumber: "SW-INV-T-000000-0011" }),
    liveBill({ Type: "ACCREC" }),
  ]);
  const put = putCounter();
  const out = await createOrReuseTradeXeroBill(db.client(), { xeroGet, putBill: put.putBill }, createArgs);
  assertEquals(out.reused, false);
});

Deno.test("existing bill: two live matches or another supplier refuse with no create", async () => {
  for (const [list, code] of [
    [[liveBill(), liveBill({ InvoiceID: "bill-2" })], "xero_existing_bill_ambiguous"],
    [[liveBill({ Contact: { ContactID: "contact-2" } })], "xero_existing_bill_other_supplier"],
  ] as const) {
    const db = new FakeDb({ trade_invoices: [] });
    const { xeroGet } = xeroStub([...list]);
    const put = putCounter();
    const error = await refusal(
      () => createOrReuseTradeXeroBill(db.client(), { xeroGet, putBill: put.putBill }, createArgs),
      TradeXeroBillSearchError,
    );
    assertEquals([error.status, error.code], [409, code]);
    assertEquals(put.puts.length, 0);
  }
});

Deno.test("existing bill: a failed search, a failed stored-bill read or an unreadable match creates nothing", async () => {
  const runs: [FakeDb, ReturnType<typeof xeroStub>][] = [
    [new FakeDb({ trade_invoices: [] }), xeroStub(new Error("timeout"))],
    [new FakeDb({ trade_invoices: [] }), xeroStub([liveBill()], new Error("timeout"))],
  ];
  const badRead = new FakeDb({ trade_invoices: [] });
  badRead.failOn = (table) => table === "trade_invoices" ? { message: "down" } : null;
  runs.push([badRead, xeroStub([liveBill()], liveBill())]);
  for (const [db, stub] of runs) {
    const put = putCounter();
    const error = await refusal(
      () => createOrReuseTradeXeroBill(db.client(), { xeroGet: stub.xeroGet, putBill: put.putBill }, createArgs),
      TradeXeroBillSearchError,
    );
    assertEquals(error.status, 503);
    assertEquals(put.puts.length, 0);
  }
});

Deno.test("existing bill: a rate limit is passed up, not turned into a refusal", async () => {
  const db = new FakeDb({ trade_invoices: [] });
  const { xeroGet } = xeroStub(new XeroCooldownError("cooling", 429, "xero_rate_limited"));
  const put = putCounter();
  await assertRejects(
    () => createOrReuseTradeXeroBill(db.client(), { xeroGet, putBill: put.putBill }, createArgs),
    XeroCooldownError,
  );
  assertEquals(put.puts.length, 0);
});

Deno.test("existing bill: a bill with no number is never created blind", async () => {
  const db = new FakeDb({ trade_invoices: [] });
  const { xeroGet } = xeroStub([]);
  const put = putCounter();
  const error = await refusal(
    () =>
      createOrReuseTradeXeroBill(db.client(), { xeroGet, putBill: put.putBill }, {
        ...createArgs,
        payload: { Invoices: [{ InvoiceNumber: "" }] },
      }),
    TradeXeroBillSearchError,
  );
  assertEquals(error.code, "xero_bill_number_missing");
  assertEquals(put.puts.length, 0);
});

// ── B14: the extras rate rule ────────────────────────────────────────────

const rules = (list: { line_type: string; max_unit_rate_ex: number }[]) => ({ ok: true as const, rules: list });

Deno.test("rate rule: the office row wins, then the office default, then the trade's own rate for hours", () => {
  const set = [{ line_type: "materials", max_unit_rate_ex: 200 }, { line_type: "*", max_unit_rate_ex: 150 }];
  assertEquals(extraLineRateCap("Materials", set, 60), { cap: 200, source: "office_rule" });
  assertEquals(extraLineRateCap("other", set, 60), { cap: 150, source: "office_default" });
  assertEquals(extraLineRateCap("labour", [], 60)?.source, "trade_rate");
  assertEquals(extraLineRateCap("materials", [], 60), null);
  assertEquals(extraLineRateCap("labour", [], null), null);
});

Deno.test("rate rule: a typed rate above the limit is held; at or below it is not", () => {
  const set = rules([{ line_type: "*", max_unit_rate_ex: 100 }]);
  const base = { lineType: "other", serverResolved: false, rules: set, tradeHourlyRate: null };
  assertEquals(extraLineRateHold({ ...base, rate: 100 }), null);
  assertEquals(extraLineRateHold({ ...base, rate: 100.004 }), null);
  const held = extraLineRateHold({ ...base, rate: 100.01 });
  assertEquals(held?.held, true);
  assertEquals(held?.source, "office_default");
  assert(!/\d/.test(held!.note), "the hold note carries no amounts");
});

Deno.test("rate rule: a line the server priced, a deduction or a zero rate is never held", () => {
  const set = rules([{ line_type: "*", max_unit_rate_ex: 1 }]);
  const base = { lineType: "other", rules: set, tradeHourlyRate: null };
  assertEquals(extraLineRateHold({ ...base, rate: 500, serverResolved: true }), null);
  assertEquals(extraLineRateHold({ ...base, rate: -50, serverResolved: false }), null);
  assertEquals(extraLineRateHold({ ...base, rate: 0, serverResolved: false }), null);
});

Deno.test("rate rule: hours above the trade's own pay rate are held when the office set nothing", () => {
  const held = extraLineRateHold({
    lineType: "labour",
    rate: 61,
    serverResolved: false,
    rules: rules([]),
    tradeHourlyRate: 60,
  });
  assertEquals(held?.source, "trade_rate");
});

Deno.test("rate rule: unreadable office limits hold every typed rate", async () => {
  const db = new FakeDb();
  db.failOn = (table) => table === "trade_invoice_extra_rate_rules" ? { message: "down" } : null;
  const loaded = await loadExtraRateRules(db.client());
  assertEquals(loaded.ok, false);
  const held = extraLineRateHold({ lineType: "other", rate: 1, serverResolved: false, rules: loaded, tradeHourlyRate: null });
  assertEquals(held?.source, "rules_unreadable");
});

Deno.test("rate rule: only staff set a limit, which must be above 0; null removes it", async () => {
  const db = new FakeDb({ trade_invoice_extra_rate_rules: [] });
  const trade = await refusal(
    () => setExtraRateRule(db.client(), { line_type: "other", max_unit_rate_ex: 50 }, { staff: false, userId: "t" }),
    ExtraRateRuleError,
  );
  assertEquals(trade.status, 403);
  const zero = await refusal(
    () => setExtraRateRule(db.client(), { line_type: "other", max_unit_rate_ex: 0 }, { staff: true, userId: "o" }),
    ExtraRateRuleError,
  );
  assertEquals(zero.code, "invalid_rate");
  await setExtraRateRule(db.client(), { line_type: " Other ", max_unit_rate_ex: 50.555 }, { staff: true, userId: "o" });
  assertEquals(db.rows("trade_invoice_extra_rate_rules")[0].line_type, "other");
  assertEquals(db.rows("trade_invoice_extra_rate_rules")[0].max_unit_rate_ex, 50.56);
  const loaded = await loadExtraRateRules(db.client());
  assertEquals(loaded.ok && loaded.rules.length, 1);
  await setExtraRateRule(db.client(), { line_type: "other", max_unit_rate_ex: null }, { staff: true, userId: "o" });
  assertEquals(db.rows("trade_invoice_extra_rate_rules").length, 0);
});

// ── Invoice numbers ──────────────────────────────────────────────────────

Deno.test("number: the old count rule carries on when the slot is free", async () => {
  const db = new FakeDb({ trade_invoices: [{ id: "a", user_id: "u", invoice_number: "SW-INV-AB-260101-001" }] });
  assertEquals(
    await nextTradeInvoiceNumber(db.client(), { userId: "u", initials: "AB", day: "260102" }),
    "SW-INV-AB-260102-002",
  );
});

Deno.test("number: a taken slot (deleted row, or another trade with the same initials) moves to the next free one", async () => {
  const db = new FakeDb({
    trade_invoices: [
      { id: "a", user_id: "u", invoice_number: "SW-INV-AB-260102-001" },
      { id: "b", user_id: "other", invoice_number: "SW-INV-AB-260102-002" },
      { id: "c", user_id: "other", invoice_number: "SW-INV-AB-260102-003" },
    ],
  });
  assertEquals(
    await nextTradeInvoiceNumber(db.client(), { userId: "u", initials: "AB", day: "260102" }),
    "SW-INV-AB-260102-004",
  );
  assertEquals(
    await nextTradeInvoiceNumber(db.client(), { userId: "u", initials: "AB", day: "260102", skip: 3 }),
    "SW-INV-AB-260102-005",
  );
});

Deno.test("number: formatting, initials and collision detection", () => {
  assertEquals(formatTradeInvoiceNumber("AB", "260102", 7), "SW-INV-AB-260102-007");
  assertEquals(tradeInvoiceInitials("ann bee cee dee"), "ABC");
  // The old rule: no name reads as "X". Kept so numbering carries on.
  assertEquals(tradeInvoiceInitials(""), "X");
  assert(isTradeInvoiceNumberCollision({ code: "23505", message: 'duplicate key ... "trade_invoices_invoice_number_key"' }));
  assert(isTradeInvoiceNumberCollision(new Error('Failed to create invoice: duplicate key value violates unique constraint "trade_invoices_invoice_number_key"')));
  assert(!isTradeInvoiceNumberCollision({ code: "23505", message: "duplicate key on another index" }));
  assert(!isTradeInvoiceNumberCollision(new Error("timeout")));
});

// ── B16: one live no-week claim ──────────────────────────────────────────

Deno.test("no-week: the claim key matches the database rule", () => {
  assertEquals(
    noWeekClaimKey({ job_id: "j", source_work_order_id: "w", line_type: " Work Order ", line_total_ex: 10 }),
    "wo:w|work order",
  );
  for (const line of [
    // A line naming no work order is not a claim: a second materials line
    // on the same job is never refused.
    { job_id: "j", line_type: "labour", line_total_ex: 10 },
    { job_id: "j", source_work_order_id: "w", line_type: "travel", line_total_ex: 10 },
    { job_id: "j", source_work_order_id: "w", line_type: "group share", line_total_ex: 10 },
    { job_id: "j", source_work_order_id: "w", group_share_id: "s", line_type: "labour", line_total_ex: 10 },
    { job_id: "j", source_work_order_id: "w", line_type: "final_payout_deduction", line_total_ex: -10 },
  ]) {
    assertEquals(noWeekClaimKey(line), null);
  }
});

function claimDb(status: string, week_start: string | null = null): FakeDb {
  return new FakeDb({
    trade_invoices: [{ id: "inv-old", user_id: "u", invoice_number: "SW-INV-AB-260101-001", status, week_start }],
    trade_invoice_lines: [{
      trade_invoice_id: "inv-old",
      job_id: "j",
      line_type: "work order",
      line_total_ex: 100,
      source_work_order_id: "w",
      group_share_id: null,
    }],
  });
}
const claimLine = { job_id: "j", line_type: "Work Order", line_total_ex: 100, source_work_order_id: "w" };

Deno.test("no-week: a second live claim is found and named", async () => {
  for (const status of ["pending_acknowledgment", "approved", "pushed_to_xero", "paid", "queried"]) {
    const found = await findNoWeekClaimConflict(claimDb(status).client(), "u", [claimLine]);
    assertEquals(found, { ok: true, conflict: { invoice_id: "inv-old", invoice_number: "SW-INV-AB-260101-001" } });
  }
});

Deno.test("no-week: a released invoice, a weekly one, another person or another claim does not block", async () => {
  for (const status of ["draft", "failed", "ops-reject"]) {
    assertEquals((await findNoWeekClaimConflict(claimDb(status).client(), "u", [claimLine])), { ok: true, conflict: null });
  }
  assertEquals(
    await findNoWeekClaimConflict(claimDb("approved", "2026-01-05").client(), "u", [claimLine]),
    { ok: true, conflict: null },
  );
  assertEquals(await findNoWeekClaimConflict(claimDb("approved").client(), "v", [claimLine]), { ok: true, conflict: null });
  assertEquals(
    await findNoWeekClaimConflict(claimDb("approved").client(), "u", [{ ...claimLine, line_type: "materials" }]),
    { ok: true, conflict: null },
  );
  assertEquals(
    await findNoWeekClaimConflict(claimDb("approved").client(), "u", [{ ...claimLine, line_type: "travel" }]),
    { ok: true, conflict: null },
  );
  assertEquals(
    await findNoWeekClaimConflict(claimDb("approved").client(), "u", [{ ...claimLine, source_work_order_id: "w2" }]),
    { ok: true, conflict: null },
  );
});

Deno.test("no-week: an unreadable check fails closed; the database refusal is recognised", async () => {
  const db = claimDb("approved");
  db.failOn = (table) => table === "trade_invoice_lines" ? { message: "down" } : null;
  assertEquals(await findNoWeekClaimConflict(db.client(), "u", [claimLine]), { ok: false });
  assert(isNoWeekClaimRefusal(new Error("Failed to save invoice line items: no_week_claim_already_invoiced: ...")));
  assert(!isNoWeekClaimRefusal(new Error("timeout")));
});
