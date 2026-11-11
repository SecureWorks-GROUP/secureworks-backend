// A refused or failed trade invoice submit leaves one trade_invoice_events
// row (11 Nov 2026, migration 20261111194500): who, which door, which week,
// and the code and message the trade was shown. It never holds what the trade
// posted or any money figure. Made-up ids throughout.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { FakeDb } from "./trade_invoice_controls_test_fakes.ts";
import {
  recordTradeSubmitRefused,
  TRADE_SUBMIT_ACTIONS,
  tradeSubmitRefusedEvent,
} from "./trade_invoice_events.ts";

const TRADE = "0a1e0000-0000-4000-8000-00000000aa01";
const LIVE_INVOICE = "0a1e0000-0000-4000-8000-00000000d001";
const DRAFT = "0a1e0000-0000-4000-8000-00000000d002";

// What a trade posts: his lines, hours and extras. None of it may be copied.
const POSTED = {
  week_start: "2026-11-09",
  gst_on: true,
  draft_id: DRAFT,
  manual_assignments: [{ assignment_id: "card-1", hours: 8, rate: 999 }],
  extra_items: [{ type: "Materials", description: "posted extra", rate: 123.45 }],
  notes: "posted note",
  // Made-up digits, only so the test can look for them.
  bsb: "987-654",
  accountNo: "13572468",
};

// The server's answer when the week already has an invoice: it carries that
// invoice's money, which must not reach the record.
const WEEK_TAKEN = {
  ok: false,
  success: false,
  code: "WEEK_ALREADY_INVOICED",
  invoice_id: LIVE_INVOICE,
  invoice_number: "SW-INV-T-000000-001",
  gross_earned: 400,
  net_pay: 376,
  gst: 40,
  total_inc: 440,
  trade_payable: 416,
  userMessage:
    "You already have an invoice for the week 2026-11-09 to 2026-11-15. This submission was NOT saved.",
};

Deno.test("the two submit doors are the only ones recorded", () => {
  assertEquals([...TRADE_SUBMIT_ACTIONS].sort(), [
    "generate_trade_invoice",
    "submit_trade_invoice",
  ]);
  for (const action of ["save_trade_invoice_draft", "my_hours", "", "update_trade_profile"]) {
    assertEquals(
      tradeSubmitRefusedEvent({ action, userId: TRADE, status: 409 }),
      null,
      action,
    );
  }
});

Deno.test("a refused submit records who, which door, which week, the code and the message", () => {
  const event = tradeSubmitRefusedEvent({
    action: "generate_trade_invoice",
    userId: TRADE,
    status: 409,
    requestBody: POSTED,
    responseBody: WEEK_TAKEN,
  });
  assertEquals(event, {
    trade_invoice_id: LIVE_INVOICE,
    event_type: "submit_refused",
    actor: `trade:${TRADE}`,
    reason: "WEEK_ALREADY_INVOICED",
    detail: {
      action: "generate_trade_invoice",
      user_id: TRADE,
      http_status: 409,
      code: "WEEK_ALREADY_INVOICED",
      message: WEEK_TAKEN.userMessage,
      week_start: "2026-11-09",
      draft_id: DRAFT,
    },
  });
});

Deno.test("nothing the trade posted and no money figure reaches the record", () => {
  const event = tradeSubmitRefusedEvent({
    action: "generate_trade_invoice",
    userId: TRADE,
    status: 409,
    requestBody: POSTED,
    responseBody: WEEK_TAKEN,
  });
  const text = JSON.stringify(event);
  for (
    const leaked of [
      "987-654",
      "13572468",
      "posted extra",
      "posted note",
      "123.45",
      "999",
      "manual_assignments",
      "extra_items",
      "gross_earned",
      "net_pay",
      "trade_payable",
      "total_inc",
      "376",
      "416",
      "440",
      "SW-INV-T-000000-001",
    ]
  ) {
    assert(!text.includes(leaked), leaked);
  }
});

Deno.test("a dollar amount in the message is taken out", () => {
  const event = tradeSubmitRefusedEvent({
    action: "generate_trade_invoice",
    userId: TRADE,
    status: 422,
    requestBody: { week_start: "2026-11-09" },
    responseBody: {
      error: "Line total $1,234.50 does not match   $ 35 an hour.",
    },
  });
  assertEquals(
    event?.detail?.message,
    "Line total [amount] does not match [amount] an hour.",
  );
  assertEquals(event?.reason, "http_422");
});

Deno.test("a failure with no code is recorded by its status, with no invoice", () => {
  const event = tradeSubmitRefusedEvent({
    action: "submit_trade_invoice",
    userId: TRADE,
    status: 500,
    requestBody: { week_ending: "2026-11-15", week_start: "not a date", draft_id: "nope" },
    responseBody: null,
  });
  assertEquals(event, {
    trade_invoice_id: null,
    event_type: "submit_refused",
    actor: `trade:${TRADE}`,
    reason: "http_500",
    detail: {
      action: "submit_trade_invoice",
      user_id: TRADE,
      http_status: 500,
      code: "http_500",
      week_end: "2026-11-15",
    },
  });
});

Deno.test("a code that is not a plain code, and an id that is not an id, are not copied", () => {
  const event = tradeSubmitRefusedEvent({
    action: "generate_trade_invoice",
    userId: TRADE,
    status: 409,
    responseBody: { code: "rate was $35 for Sam", invoice_id: "12345", error: "   " },
  });
  assertEquals(event?.reason, "http_409");
  assertEquals(event?.trade_invoice_id, null);
  assertEquals("message" in (event?.detail ?? {}), false);
});

Deno.test("a submit that went through, or with nobody signed in, records nothing", () => {
  for (const status of [200, 201, 302, 399, NaN]) {
    assertEquals(
      tradeSubmitRefusedEvent({ action: "generate_trade_invoice", userId: TRADE, status }),
      null,
      String(status),
    );
  }
  assertEquals(
    tradeSubmitRefusedEvent({ action: "generate_trade_invoice", userId: "  ", status: 401 }),
    null,
  );
});

Deno.test("the record is one row through the one event writer", async () => {
  const db = new FakeDb();
  const recorded = await recordTradeSubmitRefused(db.client(), {
    action: "generate_trade_invoice",
    userId: TRADE,
    status: 422,
    requestBody: POSTED,
    responseBody: { ok: false, code: "RATE_NOT_CONFIGURED", userMessage: "No pay rate is set for you this week." },
  });
  assertEquals(recorded, true);
  const rows = db.rows("trade_invoice_events");
  assertEquals(rows.length, 1);
  assertEquals(rows[0].event_type, "submit_refused");
  assertEquals(rows[0].trade_invoice_id, null);
  assertEquals(rows[0].actor, `trade:${TRADE}`);
  assertEquals(rows[0].reason, "RATE_NOT_CONFIGURED");
  assertEquals(rows[0].detail.week_start, "2026-11-09");
  assertEquals(db.writes.map((write) => `${write.kind} ${write.table}`), [
    "insert trade_invoice_events",
  ]);
});

Deno.test("a submit that went through writes no row", async () => {
  const db = new FakeDb();
  const recorded = await recordTradeSubmitRefused(db.client(), {
    action: "generate_trade_invoice",
    userId: TRADE,
    status: 200,
    requestBody: POSTED,
    responseBody: { success: true },
  });
  assertEquals(recorded, false);
  assertEquals(db.writes, []);
});

Deno.test("a record the database refuses never throws: the trade's answer is already decided", async () => {
  const refusing = new FakeDb();
  refusing.insertGuard = () => ({ message: "check violation", code: "23514" });
  assertEquals(
    await recordTradeSubmitRefused(refusing.client(), {
      action: "generate_trade_invoice",
      userId: TRADE,
      status: 409,
      responseBody: WEEK_TAKEN,
    }),
    false,
  );
  const broken = { from: () => { throw new Error("client is down"); } };
  assertEquals(
    await recordTradeSubmitRefused(broken, {
      action: "submit_trade_invoice",
      userId: TRADE,
      status: 500,
    }),
    false,
  );
});
