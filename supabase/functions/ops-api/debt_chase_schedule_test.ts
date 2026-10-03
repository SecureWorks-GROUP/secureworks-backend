// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  DEBT_CHASE_GROUP_ORDER,
  DEBT_CHASE_NO_REMINDER,
  DEBT_CHASE_SCHEDULES,
  DEBT_CHASE_STEPS,
  type DebtChaseBookInvoice,
  type DebtChaseEvent,
  debtChaseEventFromLogRow,
  planDebtMorningList,
} from "./debt_chase_schedule.ts";

// Thursday 2026-10-01 is the first morning; Monday 2026-10-05 is the first statement day.
const THU = "2026-10-01";
const MON = "2026-10-05";

let seq = 0;
function inv(over: Partial<DebtChaseBookInvoice> = {}): DebtChaseBookInvoice {
  seq += 1;
  const n = String(seq).padStart(4, "0");
  return {
    xero_invoice_id: `inv-${n}`,
    invoice_number: `INV-${n}`,
    contact_id: "contact-a",
    contact_name: "Client A",
    payer: "client",
    kind: "final",
    is_debt: true,
    not_debt_reason: null,
    hold: null,
    hold_reason: null,
    invoice_date: "2026-09-01",
    due_date: "2026-09-30",
    amount_due: 1000,
    days_overdue: 1,
    start_step: null,
    job_id: null,
    ...over,
  };
}

/** A desk row on the chase log, as the adapter reads it. `at` is a Perth-date morning. */
function ev(
  invoice: DebtChaseBookInvoice,
  perthDay: string,
  over: Partial<DebtChaseEvent> = {},
): DebtChaseEvent {
  return {
    xero_invoice_id: invoice.xero_invoice_id,
    at: `${perthDay}T01:00:00.000Z`, // 09:00 Perth
    step: null,
    outcome: null,
    promised_amount: null,
    promised_date: null,
    amount_due_at_promise: null,
    covers: null,
    by: "Shaun",
    ...over,
  };
}

function plan(
  invoices: DebtChaseBookInvoice[],
  events: DebtChaseEvent[] = [],
  perthDate = THU,
) {
  return planDebtMorningList(invoices, events, { perthDate });
}

// ── The schedules are data ──

Deno.test("schedule data: the captain's ladders, word for word in numbers", () => {
  assertEquals(
    DEBT_CHASE_SCHEDULES.homeowner.ladder.map((s) => [s.step, s.day]),
    [["friendly_text", 1], ["firm_text", 2], ["call", 3], ["jan_visit", 7]],
  );
  assertEquals(DEBT_CHASE_SCHEDULES.builder.statement_after_invoice_days, 14);
  assertEquals(DEBT_CHASE_SCHEDULES.builder.statement_weekday, "monday");
  assertEquals(DEBT_CHASE_SCHEDULES.builder.call_at_days_overdue, 30);
  assertEquals(DEBT_CHASE_SCHEDULES.deposit.reminders, 1);
  assertEquals(DEBT_CHASE_SCHEDULES.deposit.cancel_list_after_days, 60);
  assertEquals(DEBT_CHASE_GROUP_ORDER, [
    "broken_promise",
    "jan",
    "call",
    "text",
    "statement",
    "deposit_reminder",
  ]);
  assertEquals(
    DEBT_CHASE_STEPS.firm_text.label,
    "Day 2: firm text with the pay link",
  );
  assertEquals(DEBT_CHASE_STEPS.firm_text.group, "text");
  assertEquals(DEBT_CHASE_STEPS.call.group, "call");
  assertEquals(DEBT_CHASE_STEPS.builder_call.group, "call");
  assertEquals(DEBT_CHASE_STEPS.jan_visit.group, "jan");
  for (const schedule of Object.values(DEBT_CHASE_SCHEDULES)) {
    assert(schedule.decision.length > 0, "every schedule names its ruling");
  }
});

// ── Homeowners ──

Deno.test("homeowner: day 1 after due is the friendly text", () => {
  const a = inv({ days_overdue: 1 });
  const out = plan([a]);
  assertEquals(out.items.length, 1);
  const item = out.items[0];
  assertEquals([item.group, item.step, item.step_label], [
    "text",
    "friendly_text",
    "Day 1: friendly text",
  ]);
  assertEquals(item.payer_key, "contact-a");
  assertEquals(item.payer_name, "Client A");
  assertEquals(item.invoices.map((i) => i.invoice_number), [a.invoice_number]);
  assertEquals(item.hold, null);
  assertEquals(item.draft, null);
  assertEquals(item.promise, null);
  assertEquals(item.last_outcome, null);
  assertEquals(item.id, `${THU}:contact-a:text:friendly_text`);
});

Deno.test("homeowner: not yet due and no due date are not chased, and say why", () => {
  const notDue = inv({
    days_overdue: 0,
    contact_id: "c-1",
    contact_name: "One",
  });
  const noDue = inv({
    days_overdue: null,
    due_date: null,
    contact_id: "c-2",
    contact_name: "Two",
  });
  const out = plan([notDue, noDue]);
  assertEquals(out.items, []);
  assertEquals(
    out.waiting.map((w) => [w.payer_name, w.reason]).sort(),
    [["One", "not_due"], ["Two", "no_due_date"]],
  );
});

Deno.test("launch backlog: an old debt with no desk history starts at the friendly text", () => {
  const out = plan([inv({ days_overdue: 40 })]);
  assertEquals(out.items.map((i) => i.step), ["friendly_text"]);
});

Deno.test("one step a day: the day after the friendly text is the firm text, never two in a day", () => {
  const a = inv({ days_overdue: 40 });
  const yesterday = plan([a], [ev(a, "2026-09-30", { step: "friendly_text" })]);
  assertEquals(yesterday.items.map((i) => i.step), ["firm_text"]);

  const today = plan([a], [ev(a, THU, { step: "friendly_text" })]);
  assertEquals(today.items, []);
  assertEquals(today.waiting.map((w) => w.reason), ["done_today"]);
});

Deno.test("homeowner ladder on schedule: text, firm text, call, then Jan on day 7", () => {
  const a = inv();
  const at = (days: number) => ({ ...a, days_overdue: days });
  assertEquals(
    plan([at(2)], [ev(a, "2026-09-30", { step: "friendly_text" })]).items[0]
      .step,
    "firm_text",
  );
  assertEquals(
    plan([at(3)], [
      ev(a, "2026-09-29", { step: "friendly_text" }),
      ev(a, "2026-09-30", { step: "firm_text" }),
    ]).items[0].step,
    "call",
  );

  const afterCall = [
    ev(a, "2026-09-28", { step: "friendly_text" }),
    ev(a, "2026-09-29", { step: "firm_text" }),
    ev(a, "2026-09-30", { step: "call", outcome: "no_answer" }),
  ];
  const day4 = plan([at(4)], afterCall);
  assertEquals(day4.items, []);
  assertEquals(day4.waiting.map((w) => [w.reason, w.next_step, w.next_date]), [
    ["next_step_later", "jan_visit", "2026-10-04"],
  ]);
  const day7 = plan([at(7)], afterCall);
  assertEquals(day7.items.map((i) => [i.group, i.step]), [[
    "jan",
    "jan_visit",
  ]]);
  assertEquals(day7.items[0].last_outcome, {
    code: "no_answer",
    label: "No answer",
    at: "2026-09-30T01:00:00.000Z",
    by: "Shaun",
  });
});

Deno.test("after Jan's visit the payer stays on Jan's list, one visit a day", () => {
  const a = inv({ days_overdue: 9 });
  const visited = [ev(a, "2026-09-30", { step: "jan_visit" })];
  assertEquals(plan([a], visited).items.map((i) => i.step), ["jan_visit"]);
  assertEquals(plan([a], [ev(a, THU, { step: "jan_visit" })]).items, []);
});

Deno.test("the captain's Jan-list invoices start at the Jan step", () => {
  const a = inv({ days_overdue: 300, start_step: "jan" });
  assertEquals(plan([a]).items.map((i) => [i.group, i.step]), [[
    "jan",
    "jan_visit",
  ]]);
});

Deno.test("a payer with several invoices is one item: amount summed, oldest age", () => {
  const a = inv({ amount_due: 1200.5, days_overdue: 5 });
  const b = inv({ amount_due: 300.25, days_overdue: 12, kind: "variation" });
  const out = plan([a, b]);
  assertEquals(out.items.length, 1);
  assertEquals(out.items[0].amount, 1500.75);
  assertEquals(out.items[0].days_overdue, 12);
  assertEquals(out.items[0].invoices.map((i) => i.invoice_number), [
    a.invoice_number,
    b.invoice_number,
  ]);
});

// ── Outcomes and promises ──

Deno.test("a promise pauses chasing until its date, and the date itself is still open", () => {
  const a = inv({ days_overdue: 10 });
  const promised = [
    ev(a, "2026-09-30", {
      step: "call",
      outcome: "promised",
      promised_amount: 500,
      promised_date: THU,
    }),
  ];
  const out = plan([a], promised);
  assertEquals(out.items, []);
  assertEquals(out.paused.length, 1);
  assertEquals(out.paused[0].promise, {
    amount: 500,
    date: THU,
    status: "open",
  });
  assertEquals(out.paused[0].resumes_on, "2026-10-02");
});

Deno.test("a missed promise returns at the top the next morning, at the next step, marked promise broken", () => {
  const a = inv({ days_overdue: 10, amount_due: 50 });
  const b = inv({
    days_overdue: 60,
    amount_due: 9000,
    contact_id: "contact-b",
    contact_name: "Client B",
  });
  const events = [
    ev(a, "2026-09-28", { step: "friendly_text" }),
    ev(a, "2026-09-29", {
      step: "firm_text",
    }),
    ev(a, "2026-09-29", {
      outcome: "promised",
      promised_amount: 50,
      promised_date: "2026-09-30",
    }),
  ];
  const out = plan([a, b], events);
  assertEquals(out.items.map((i) => [i.payer_name, i.group, i.step]), [
    ["Client A", "broken_promise", "call"],
    ["Client B", "text", "friendly_text"],
  ]);
  assertEquals(out.items[0].step_label, "Promise broken: Day 3: Shaun calls");
  assertEquals(out.items[0].promise, {
    amount: 50,
    date: "2026-09-30",
    status: "broken",
  });
});

Deno.test("homeowner: a promise paid in part as promised is kept, not broken; short or unrecorded is broken", () => {
  const events = (a: DebtChaseBookInvoice, atPromise: number | null) => [
    ev(a, "2026-09-28", { step: "friendly_text" }),
    ev(a, "2026-09-29", { step: "firm_text" }),
    ev(a, "2026-09-29", {
      outcome: "promised",
      promised_amount: 500,
      promised_date: "2026-09-30",
      amount_due_at_promise: atPromise,
    }),
  ];
  // Promised $500 of $1,000 and paid it: $500 still due, so still open, but the promise held.
  const paid = inv({ days_overdue: 10, amount_due: 500 });
  const kept = plan([paid], events(paid, 1000));
  assertEquals(kept.items.map((i) => [i.group, i.step, i.step_label]), [[
    "call",
    "call",
    "Day 3: Shaun calls",
  ]]);
  assertEquals(kept.items[0].promise, {
    amount: 500,
    date: "2026-09-30",
    status: "kept",
  });

  const shortPaid = inv({ days_overdue: 10, amount_due: 700 });
  const short = plan([shortPaid], events(shortPaid, 1000));
  assertEquals(short.items.map((i) => [i.group, i.step, i.promise?.status]), [
    ["broken_promise", "call", "broken"],
  ]);

  // An older promise row never recorded the amount due: still open after the date is broken.
  const unrecorded = inv({ days_overdue: 10, amount_due: 500 });
  const fallback = plan([unrecorded], events(unrecorded, null));
  assertEquals(
    fallback.items.map((i) => [i.group, i.step, i.promise?.status]),
    [["broken_promise", "call", "broken"]],
  );
});

Deno.test("a step logged after a promise clears it: the ladder carries on", () => {
  const a = inv({ days_overdue: 10 });
  const events = [
    ev(a, "2026-09-27", {
      outcome: "promised",
      promised_amount: 1,
      promised_date: "2026-09-28",
    }),
    ev(a, "2026-09-29", { step: "friendly_text" }),
  ];
  const out = plan([a], events);
  assertEquals(out.items.map((i) => [i.group, i.step, i.promise]), [[
    "text",
    "firm_text",
    null,
  ]]);
});

Deno.test("no answer and spoke do not resolve the step; disputed and says paid hold it for a check", () => {
  const a = inv({ days_overdue: 10 });
  const spoke = plan([a], [
    ev(a, "2026-09-29", { step: "friendly_text" }),
    ev(a, "2026-09-30", { step: "firm_text", outcome: "spoke" }),
  ]);
  assertEquals(spoke.items.map((i) => i.step), ["call"]);

  for (const outcome of ["disputed", "says_paid"] as const) {
    const out = plan([a], [ev(a, "2026-09-30", { step: "call", outcome })]);
    assertEquals(out.items.length, 1);
    const item = out.items[0];
    assertEquals([item.group, item.step, item.hold], [
      "hold",
      null,
      "check_first",
    ]);
    assert(
      item.hold_reason!.includes(
        outcome === "disputed" ? "disputed" : "says paid",
      ),
    );
  }
});

Deno.test("an undated promise does not pause chasing", () => {
  const a = inv({ days_overdue: 4 });
  const out = plan([a], [
    ev(a, "2026-09-30", { outcome: "promised", promised_amount: 100 }),
  ]);
  assertEquals(out.items.map((i) => i.step), ["friendly_text"]);
  assertEquals(out.items[0].last_outcome?.code, "promised");
});

// ── Holds ──

Deno.test("held_step: a held homeowner shows the ladder step they would be on, from the log, the Jan start and the ladder end", () => {
  const disputed = inv({ days_overdue: 10 });
  const afterCall = plan([disputed], [
    ev(disputed, "2026-09-28", { step: "friendly_text" }),
    ev(disputed, "2026-09-29", { step: "firm_text" }),
    ev(disputed, "2026-09-30", { step: "call", outcome: "disputed" }),
  ]);
  assertEquals(
    afterCall.items.map((i) => [i.group, i.step, i.hold, i.held_step]),
    [["hold", null, "check_first", "jan_visit"]],
  );

  const fresh = plan([inv({ days_overdue: 5, hold: "fix_first" })]);
  assertEquals(fresh.items.map((i) => [i.step, i.hold, i.held_step]), [
    [null, "fix_first", "friendly_text"],
  ]);

  const jan = plan([
    inv({ days_overdue: 5, hold: "check_first", start_step: "jan" }),
  ]);
  assertEquals(jan.items.map((i) => i.held_step), ["jan_visit"]);

  const visited = inv({ days_overdue: 20, hold: "check_first" });
  const end = plan([visited], [
    ev(visited, "2026-09-25", { step: "jan_visit" }),
  ]);
  assertEquals(end.items.map((i) => i.held_step), ["jan_visit"]);

  const notDue = plan([
    inv({ days_overdue: -3, hold: "check_first" }),
    inv({
      days_overdue: null,
      due_date: null,
      hold: "check_first",
      contact_id: "contact-b",
      contact_name: "Client B",
    }),
  ]);
  assertEquals(notDue.items.map((i) => [i.hold, i.held_step]), [
    ["check_first", null],
    ["check_first", null],
  ]);
});

Deno.test("held_step: a held builder is on the call at 30 days overdue until called, else the statement", () => {
  const old = builder({
    invoice_date: "2026-08-01",
    days_overdue: 40,
    hold: "check_first",
    hold_reason: "in dispute",
  });
  assertEquals(plan([old], [], MON).items.map((i) => [i.step, i.held_step]), [
    [null, "builder_call"],
  ]);
  const called = plan(
    [old],
    [ev(old, "2026-09-28", { step: "builder_call" })],
    MON,
  );
  assertEquals(called.items.map((i) => i.held_step), ["statement"]);

  const young = builder({ days_overdue: 5 });
  const says = plan([young], [
    ev(young, "2026-09-30", { outcome: "says_paid" }),
  ]);
  assertEquals(says.items.map((i) => [i.group, i.step, i.held_step]), [
    ["hold", null, "statement"],
  ]);
});

Deno.test("held_step: a held deposit is on its reminder only while overdue and not yet reminded", () => {
  const d = inv({
    kind: "deposit",
    is_debt: false,
    not_debt_reason: "deposit",
    days_overdue: 3,
  });
  const held = plan([d], [ev(d, "2026-09-30", { outcome: "disputed" })]);
  assertEquals(held.items.map((i) => [i.group, i.step, i.held_step]), [
    ["hold", null, "deposit_reminder"],
  ]);
  const reminded = plan([d], [
    ev(d, "2026-09-29", { step: "deposit_reminder" }),
    ev(d, "2026-09-30", { outcome: "disputed" }),
  ]);
  assertEquals(reminded.items.map((i) => [i.group, i.held_step]), [
    ["hold", null],
  ]);
});

Deno.test("held_step is null on every item that is not a hold", () => {
  const a = inv({ days_overdue: 4 });
  const out = plan(
    [
      a,
      builder({ invoice_date: "2026-08-01", days_overdue: 40 }),
    ],
    [],
    MON,
  );
  assert(out.items.length > 1);
  assert(out.items.every((i) => i.hold === null && i.held_step === null));
});

Deno.test("holds show with their reason and no step: check first and fix first", () => {
  const check = inv({
    days_overdue: 20,
    hold: "check_first",
    hold_reason: "the Clear Debt desk marks it bad debt",
    contact_id: "c-check",
    contact_name: "Check",
  });
  const fix = inv({
    days_overdue: 20,
    hold: "fix_first",
    hold_reason: "the job is in rectification",
    contact_id: "c-fix",
    contact_name: "Fix",
  });
  const out = plan([check, fix]);
  assertEquals(
    out.items.map((
      i,
    ) => [i.payer_name, i.group, i.step, i.hold, i.hold_reason]),
    [
      [
        "Check",
        "hold",
        null,
        "check_first",
        "the Clear Debt desk marks it bad debt",
      ],
      ["Fix", "hold", null, "fix_first", "the job is in rectification"],
    ],
  );
  assertEquals(
    out.items[0].step_label,
    "Check first: the Clear Debt desk marks it bad debt",
  );
  assertEquals(
    out.items[1].step_label,
    "Fix first: the job is in rectification",
  );
});

Deno.test("several held invoices on one payer: each reason names its invoice", () => {
  const a = inv({
    days_overdue: 20,
    hold: "check_first",
    hold_reason: "rejected",
  });
  const b = inv({
    days_overdue: 30,
    hold: "check_first",
    hold_reason: "duplicate",
  });
  const out = plan([b, a]);
  assertEquals(out.items.map((i) => i.hold_reason), [
    `${a.invoice_number}: rejected; ${b.invoice_number}: duplicate`,
  ]);
});

Deno.test("item ids are unique: a payer's call beside its broken-promise call, and several holds", () => {
  const b1 = inv({
    payer: "mlb",
    kind: "builder",
    contact_name: "Major Loss Builders",
    days_overdue: 40,
  });
  const b2 = inv({
    payer: "mlb",
    kind: "builder",
    contact_name: "Major Loss Builders",
    days_overdue: 45,
  });
  const b3 = inv({
    payer: "mlb",
    kind: "builder",
    contact_name: "Major Loss Builders",
    days_overdue: 50,
  });
  const b4 = inv({
    payer: "mlb",
    kind: "builder",
    contact_name: "Major Loss Builders",
    days_overdue: 50,
    hold: "check_first",
    hold_reason: "doubt",
  });
  const out = plan([b1, b2, b3, b4], [
    ev(b2, "2026-09-28", {
      outcome: "promised",
      promised_amount: 1,
      promised_date: "2026-09-29",
    }),
    ev(b3, "2026-09-29", { outcome: "disputed" }),
  ]);
  assertEquals(out.items.map((i) => [i.group, i.step]), [
    ["broken_promise", "builder_call"],
    ["call", "builder_call"],
    ["hold", null],
    ["hold", null],
  ]);
  assertEquals(new Set(out.items.map((i) => i.id)).size, out.items.length);
});

Deno.test("a held invoice does not stop the payer's other invoices being chased", () => {
  const held = inv({
    days_overdue: 20,
    hold: "check_first",
    hold_reason: "doubt",
  });
  const clean = inv({ days_overdue: 3 });
  const out = plan([held, clean]);
  assertEquals(
    out.items.map((i) => [i.group, i.invoices.map((x) => x.invoice_number)]),
    [
      ["text", [clean.invoice_number]],
      ["hold", [held.invoice_number]],
    ],
  );
});

Deno.test("not debt and not chased never reach the list", () => {
  const out = plan([
    inv({
      payer: "not_chased",
      kind: "builder",
      is_debt: false,
      not_debt_reason: "not_chased",
      contact_name: "ML Builders",
    }),
    inv({
      kind: "unclear",
      is_debt: false,
      not_debt_reason: "left_aside",
      days_overdue: 400,
    }),
    inv({
      payer: "mlb",
      kind: "test",
      is_debt: false,
      not_debt_reason: "test_invoice",
      contact_name: "AJ Building & Restoration",
    }),
  ]);
  assertEquals(out.items, []);
  assertEquals(out.paused, []);
});

// ── Builders ──

function builder(over: Partial<DebtChaseBookInvoice> = {}) {
  return inv({
    payer: "mlb",
    kind: "builder",
    contact_id: "mlb-contact",
    contact_name: "Major Loss Builders",
    ...over,
  });
}

Deno.test("builders: onto the Monday statement 14 days after the invoice date, never another day", () => {
  const old = builder({
    invoice_date: "2026-09-21",
    days_overdue: -5,
    due_date: "2026-10-10",
  });
  const young = builder({ invoice_date: "2026-09-22", days_overdue: -6 });
  const monday = plan([old, young], [], MON);
  assertEquals(
    monday.items.map((i) => [i.payer_key, i.payer_name, i.group, i.step]),
    [
      ["mlb", "MLB", "statement", "statement"],
    ],
  );
  assertEquals(monday.items[0].invoices.map((i) => i.invoice_number), [
    old.invoice_number,
  ]);
  assertEquals(monday.items[0].step_label, "Monday statement");

  const thursday = plan([old, young]);
  assertEquals(thursday.items, []);
  assertEquals(thursday.next_statement_date, MON);
});

Deno.test("builders: one statement a Monday, and every Monday while unpaid", () => {
  const a = builder({ invoice_date: "2026-08-01", days_overdue: 5 });
  assertEquals(plan([a], [ev(a, MON, { step: "statement" })], MON).items, []);
  assertEquals(
    plan([a], [ev(a, "2026-09-28", { step: "statement" })], MON).items.map((
      i,
    ) => i.step),
    ["statement"],
  );
});

Deno.test("builders: Shaun calls at 30 days overdue, once per invoice, beside the statement", () => {
  const late = builder({
    invoice_date: "2026-08-01",
    days_overdue: 30,
    amount_due: 500,
  });
  const early = builder({
    invoice_date: "2026-08-20",
    days_overdue: 29,
    amount_due: 700,
  });
  const out = plan([late, early], [], MON);
  assertEquals(
    out.items.map((i) => [
      i.group,
      i.step,
      i.invoices.map((x) => x.invoice_number),
    ]),
    [
      ["call", "builder_call", [late.invoice_number]],
      [
        "statement",
        "statement",
        [late.invoice_number, early.invoice_number].sort(),
      ],
    ],
  );
  assertEquals(out.items[0].step_label, "30 days overdue: Shaun calls");
  const called = plan([late, early], [
    ev(late, THU, { step: "builder_call" }),
  ]);
  assertEquals(called.items, []);
});

Deno.test("builders: AJ's two contacts are one payer, and each other builder is its own payer", () => {
  const out = plan([
    builder({
      payer: "aj",
      contact_id: "aj-1",
      contact_name: "AJ Building & Restoration",
      days_overdue: 40,
    }),
    builder({
      payer: "aj",
      contact_id: "aj-2",
      contact_name: "Insurebuild Pty Ltd WA (AJ Building & Restoration)",
      days_overdue: 31,
    }),
    builder({
      payer: "other_builder",
      contact_id: "bw-1",
      contact_name: "Builderwest Pty Ltd",
      days_overdue: 90,
    }),
    builder({
      payer: "other_builder",
      contact_id: "wb-1",
      contact_name: "Western Building Pty Ltd",
      days_overdue: 90,
    }),
  ]);
  assertEquals(
    out.items.map((i) => [i.payer_key, i.payer_name, i.invoices.length]).sort(),
    [
      ["aj", "AJ", 2],
      ["other_builder:Builderwest", "Builderwest", 1],
      ["other_builder:Western Building", "Western Building", 1],
    ],
  );
});

Deno.test("builders: an open promise pauses the invoice; a broken one comes back as a call", () => {
  const a = builder({ invoice_date: "2026-08-01", days_overdue: 40 });
  const open = plan([a], [
    ev(a, "2026-09-30", {
      outcome: "promised",
      promised_amount: 100,
      promised_date: "2026-10-03",
    }),
  ], MON.replace("05", "02"));
  assertEquals(open.items, []);
  assertEquals(open.paused.length, 1);
  const broken = plan([a], [
    ev(a, "2026-09-28", {
      step: "builder_call",
      outcome: "promised",
      promised_amount: 100,
      promised_date: "2026-09-30",
    }),
  ], MON);
  assertEquals(broken.items.map((i) => [i.group, i.step]), [
    ["broken_promise", "builder_call"],
    ["statement", "statement"],
  ]);
});

Deno.test("builders: a promise paid as promised is kept and the statement carries on; short or unrecorded is broken", () => {
  const events = (a: DebtChaseBookInvoice, atPromise: number | null) => [
    ev(a, "2026-09-28", {
      step: "builder_call",
      outcome: "promised",
      promised_amount: 100,
      promised_date: "2026-09-30",
      amount_due_at_promise: atPromise,
    }),
  ];
  const paid = builder({
    invoice_date: "2026-08-01",
    days_overdue: 40,
    amount_due: 100,
  });
  const kept = plan([paid], events(paid, 200), MON);
  assertEquals(kept.items.map((i) => [i.group, i.step, i.promise?.status]), [
    ["statement", "statement", "kept"],
  ]);

  const shortPaid = builder({
    invoice_date: "2026-08-01",
    days_overdue: 40,
    amount_due: 150,
  });
  const short = plan([shortPaid], events(shortPaid, 200), MON);
  assertEquals(short.items.map((i) => [i.group, i.step, i.promise?.status]), [
    ["broken_promise", "builder_call", "broken"],
    ["statement", "statement", "broken"],
  ]);

  const unrecorded = builder({
    invoice_date: "2026-08-01",
    days_overdue: 40,
    amount_due: 100,
  });
  const fallback = plan([unrecorded], events(unrecorded, null), MON);
  assertEquals(
    fallback.items.map((i) => [i.group, i.step, i.promise?.status]),
    [
      ["broken_promise", "builder_call", "broken"],
      ["statement", "statement", "broken"],
    ],
  );
});

Deno.test("builders: an open promise stays on the Monday statement, marked promised by its date, and pauses the call", () => {
  const promised = builder({
    invoice_date: "2026-08-01",
    days_overdue: 40,
    amount_due: 300,
  });
  const other = builder({
    invoice_date: "2026-08-01",
    days_overdue: 10,
    amount_due: 200,
  });
  const young = builder({ invoice_date: "2026-09-30", days_overdue: -5 });
  const promiseRow = ev(promised, "2026-10-02", {
    outcome: "promised",
    promised_amount: 300,
    promised_date: "2026-10-09",
    amount_due_at_promise: 300,
  });
  const youngPromise = ev(young, "2026-10-02", {
    outcome: "promised",
    promised_amount: 1000,
    promised_date: "2026-10-09",
  });
  const out = plan([promised, other, young], [promiseRow, youngPromise], MON);
  assertEquals(out.items.map((i) => [i.group, i.step]), [
    ["statement", "statement"],
  ]);
  const open = { amount: 300, date: "2026-10-09", status: "open" as const };
  assertEquals(
    out.items[0].invoices.map((x) => [x.invoice_number, x.promise]),
    [[promised.invoice_number, open], [other.invoice_number, null]],
  );
  assertEquals(
    out.paused.map((p) => p.invoices.map((x) => x.invoice_number)),
    [[promised.invoice_number], [young.invoice_number]],
  );
  assertEquals(out.waiting, []);

  // Logging the statement against every invoice it covers keeps the promise open.
  const nextMon = "2026-10-12";
  const sent = [promised, other].map((i) => ev(i, MON, { step: "statement" }));
  const after = plan(
    [promised, other],
    [promiseRow, ...sent],
    "2026-10-07",
  );
  assertEquals(after.paused.map((p) => p.promise.status), ["open"]);
  assertEquals(after.items, []);
  assertEquals(
    plan([promised, other], [promiseRow, ...sent], nextMon).items.map((i) => [
      i.group,
      i.invoices.map((x) => [x.invoice_number, x.promise?.status ?? null]),
    ]),
    [
      ["broken_promise", [[promised.invoice_number, "broken"]]],
      ["statement", [[promised.invoice_number, "broken"], [
        other.invoice_number,
        null,
      ]]],
    ],
  );
});

Deno.test("builders: a broken promise stays on the Monday statement, marked broken, beside its broken-promise call", () => {
  const a = builder({ invoice_date: "2026-09-01", days_overdue: 5 });
  const b2 = builder({ invoice_date: "2026-09-01", days_overdue: 5 });
  const out = plan([a, b2], [
    ev(a, "2026-09-28", {
      outcome: "promised",
      promised_amount: 1000,
      promised_date: "2026-10-02",
      amount_due_at_promise: 1000,
    }),
  ], MON);
  assertEquals(
    out.items.map((i) => [
      i.group,
      i.step,
      i.invoices.map((x) => [x.invoice_number, x.promise?.status ?? null]),
    ]),
    [
      ["broken_promise", "builder_call", [[a.invoice_number, "broken"]]],
      ["statement", "statement", [[a.invoice_number, "broken"], [
        b2.invoice_number,
        null,
      ]]],
    ],
  );
  assertEquals(out.items[1].invoices[0].promise, {
    amount: 1000,
    date: "2026-10-02",
    status: "broken",
  });
  assertEquals(out.paused, []);

  // Not Monday: the broken promise is still called; the statement waits for Monday.
  const tue = plan([a, b2], [
    ev(a, "2026-09-28", {
      outcome: "promised",
      promised_amount: 1000,
      promised_date: "2026-10-02",
      amount_due_at_promise: 1000,
    }),
  ], "2026-10-06");
  assertEquals(tue.items.map((i) => i.group), ["broken_promise"]);
  assertEquals(
    tue.waiting.map((w) => [w.reason, w.invoice_numbers, w.next_date]),
    [[
      "statement_not_due",
      [a.invoice_number, b2.invoice_number].sort(),
      "2026-10-12",
    ]],
  );
});

// ── Deposits and before-work invoices ──

function deposit(over: Partial<DebtChaseBookInvoice> = {}) {
  return inv({
    kind: "deposit",
    is_debt: false,
    not_debt_reason: "deposit",
    ...over,
  });
}

Deno.test("deposits: one friendly reminder once overdue, then nothing more", () => {
  const d = deposit({ days_overdue: 3 });
  const out = plan([d]);
  assertEquals(out.items.map((i) => [i.group, i.step, i.step_label]), [
    [
      "deposit_reminder",
      "deposit_reminder",
      "One friendly reminder about the job",
    ],
  ]);
  assertEquals(
    plan([d], [ev(d, "2026-09-20", { step: "deposit_reminder" })]).items,
    [],
  );
  assertEquals(plan([deposit({ days_overdue: 0 })]).items, []);
});

Deno.test("deposits: a progress claim before the first payment is a before-work reminder too", () => {
  const p = inv({
    kind: "progress_claim",
    is_debt: false,
    not_debt_reason: "before_first_payment",
    days_overdue: 2,
  });
  assertEquals(plan([p]).items.map((i) => i.step), ["deposit_reminder"]);
});

Deno.test("deposits: the ones already paid by transfer, duplicated or leftover cents get no reminder", () => {
  const listed = DEBT_CHASE_NO_REMINDER.map((x) => x.invoice_number).sort();
  assertEquals(listed, [
    "INV-0560",
    "INV-1119",
    "INV-1601",
    "INV-1602",
    "INV-1603",
  ]);
  const out = plan([deposit({ invoice_number: "INV-1601", days_overdue: 30 })]);
  assertEquals(out.items, []);
  assertEquals(out.not_chased.map((n) => n.invoice_number), ["INV-1601"]);
  assert(out.not_chased[0].reason.includes("bank transfer"));
});

// ── Order ──

Deno.test("order: broken promises, Jan, calls, texts, statements, deposit reminders; then amount, then age; holds last", () => {
  const mk = (name: string, over: Partial<DebtChaseBookInvoice>) =>
    inv({ contact_id: name, contact_name: name, ...over });
  const broken = mk("broken", { days_overdue: 20, amount_due: 10 });
  const jan = mk("jan", {
    days_overdue: 300,
    start_step: "jan",
    amount_due: 10,
  });
  const call = mk("call", { days_overdue: 20, amount_due: 10 });
  const textSmallOld = mk("text-small-old", {
    days_overdue: 50,
    amount_due: 100,
  });
  const textBigYoung = mk("text-big-young", {
    days_overdue: 1,
    amount_due: 5000,
  });
  const textSameOld = mk("text-same-old", { days_overdue: 9, amount_due: 100 });
  const stmt = builder({
    invoice_date: "2026-09-01",
    days_overdue: 2,
    amount_due: 99999,
  });
  const dep = deposit({
    contact_id: "dep",
    contact_name: "dep",
    days_overdue: 5,
    amount_due: 99999,
  });
  const held = mk("held", {
    days_overdue: 5,
    hold: "check_first",
    hold_reason: "x",
    amount_due: 99999,
  });
  const events = [
    ev(broken, "2026-09-29", {
      outcome: "promised",
      promised_amount: 1,
      promised_date: "2026-09-30",
    }),
    ev(call, "2026-09-29", { step: "friendly_text" }),
    ev(call, "2026-09-30", { step: "firm_text" }),
  ];
  const out = plan(
    [
      dep,
      stmt,
      textSmallOld,
      textSameOld,
      textBigYoung,
      call,
      jan,
      broken,
      held,
    ],
    events,
    MON,
  );
  assertEquals(out.items.map((i) => i.payer_name), [
    "broken",
    "jan",
    "call",
    "text-big-young",
    "text-small-old",
    "text-same-old",
    "MLB",
    "dep",
    "held",
  ]);
});

// ── Reading the chase log ──

Deno.test("chase log: only the desk's own rows drive the schedule; older rows are history", () => {
  // A legacy row (manual SMS, a note tagged promised) carries no schedule step or outcome code.
  assertEquals(
    debtChaseEventFromLogRow({
      xero_invoice_id: "ABC",
      method: "sms",
      outcome: "promised",
      follow_up_date: "2026-09-01",
      chased_by: "ops@x",
      created_at: "2026-09-01T00:00:00Z",
    }),
    null,
  );
  assertEquals(
    debtChaseEventFromLogRow({
      xero_invoice_id: "ABC",
      method: "call",
      outcome: "Promised to pay Friday",
      notes: "x",
      chased_by: "Shaun",
      created_at: "2026-09-30T01:00:00Z",
      schedule_step: "call",
      outcome_code: "promised",
      promised_amount: "250.50",
      promised_date: "2026-10-03",
      amount_due_at_promise: "1000.00",
      approved_by_user_id: "user-1",
    }),
    {
      xero_invoice_id: "abc",
      at: "2026-09-30T01:00:00Z",
      step: "call",
      outcome: "promised",
      promised_amount: 250.5,
      promised_date: "2026-10-03",
      amount_due_at_promise: 1000,
      covers: null,
      by: "Shaun",
    },
  );
  // Unknown step or outcome codes are not guessed at.
  assertEquals(
    debtChaseEventFromLogRow({
      xero_invoice_id: "abc",
      method: "note",
      created_at: "2026-09-30T01:00:00Z",
      schedule_step: "carrier_pigeon",
      outcome_code: "maybe",
    }),
    null,
  );
});

Deno.test("builders: a statement's promise is per invoice; the item's is set only when every line agrees", () => {
  const a = builder({
    invoice_date: "2026-08-01",
    days_overdue: 10,
    amount_due: 300,
  });
  const b2 = builder({
    invoice_date: "2026-08-01",
    days_overdue: 10,
    amount_due: 200,
  });
  const promiseRow = ev(a, "2026-10-02", {
    outcome: "promised",
    promised_amount: 300,
    promised_date: "2026-10-09",
    amount_due_at_promise: 300,
  });
  const open = { amount: 300, date: "2026-10-09", status: "open" as const };

  // One line promised, the other not: the whole statement is not promised.
  const one = plan([a, b2], [promiseRow], MON);
  assertEquals(one.items.map((i) => [i.group, i.amount]), [["statement", 500]]);
  assertEquals(one.items[0].promise, null);
  assertEquals(one.items[0].invoices.map((x) => x.promise), [open, null]);
  assertEquals(one.items[0].last_outcome?.code, "promised");

  // A call logged on the other invoice after the promise does not clear this one's.
  const called = plan([a, b2], [
    promiseRow,
    ev(b2, "2026-10-03", { step: "builder_call" }),
  ], MON);
  assertEquals(called.items[0].promise, null);
  assertEquals(called.items[0].invoices.map((x) => x.promise), [open, null]);
  assertEquals(called.paused.map((p) => p.promise), [open]);

  // Both lines promised alike: the item carries that promise.
  const both = plan([a, b2], [
    promiseRow,
    ev(b2, "2026-10-02", {
      outcome: "promised",
      promised_amount: 300,
      promised_date: "2026-10-09",
      amount_due_at_promise: 200,
    }),
  ], MON);
  assertEquals(both.items[0].promise, open);
});

Deno.test("builders: several broken promises are one call, each line keeping its own promise", () => {
  const a = builder({ invoice_date: "2026-08-01", days_overdue: 10 });
  const b2 = builder({ invoice_date: "2026-08-01", days_overdue: 10 });
  const out = plan([a, b2], [
    ev(a, "2026-09-25", {
      outcome: "promised",
      promised_amount: 1000,
      promised_date: "2026-09-26",
    }),
    ev(b2, "2026-09-27", {
      outcome: "promised",
      promised_amount: 1000,
      promised_date: "2026-09-28",
    }),
  ], "2026-10-06");
  const broken = out.items.find((i) => i.group === "broken_promise")!;
  assertEquals(
    broken.invoices.map((x) => [x.promise?.date, x.promise?.status]),
    [
      ["2026-09-26", "broken"],
      ["2026-09-28", "broken"],
    ],
  );
  assertEquals(broken.promise, null);
  assertEquals(broken.last_outcome?.at, "2026-09-27T01:00:00.000Z");
});

Deno.test("deposits: a reminder item's promise is per invoice, never merged", () => {
  const dep = (over: Partial<DebtChaseBookInvoice> = {}) =>
    inv({
      is_debt: false,
      kind: "deposit",
      not_debt_reason: "deposit",
      ...over,
    });
  const a = dep({ amount_due: 500 });
  const b2 = dep();
  const out = plan([a, b2], [
    ev(a, "2026-09-25", {
      outcome: "promised",
      promised_amount: 500,
      promised_date: "2026-09-26",
      amount_due_at_promise: 1000,
    }),
    ev(b2, "2026-09-29", { step: "friendly_text" }),
  ]);
  const reminder = out.items.find((i) => i.group === "deposit_reminder")!;
  assertEquals(reminder.invoices.map((x) => x.promise?.status ?? null), [
    "kept",
    null,
  ]);
  assertEquals(reminder.promise, null);
});

Deno.test("deposits: a missed promise returns at the top as a broken-promise reminder, sent or not", () => {
  const notYet = deposit({ days_overdue: 6 });
  const sent = deposit({ contact_id: "contact-b", contact_name: "Client B" });
  const openOne = deposit({
    contact_id: "contact-c",
    contact_name: "Client C",
  });
  const promised = (d: DebtChaseBookInvoice, date: string) =>
    ev(d, "2026-09-26", {
      outcome: "promised",
      promised_amount: 1000,
      promised_date: date,
      amount_due_at_promise: 1000,
    });
  const debt = inv({ contact_id: "contact-d", contact_name: "Client D" });
  const out = plan([notYet, sent, openOne, debt], [
    promised(notYet, "2026-09-28"),
    ev(sent, "2026-09-25", { step: "deposit_reminder" }),
    promised(sent, "2026-09-29"),
    promised(openOne, "2026-10-02"),
  ]);
  assertEquals(
    out.items.map((i) => [
      i.group,
      i.step,
      i.step_label,
      i.invoices.map((x) => x.invoice_number),
    ]),
    [
      [
        "broken_promise",
        "deposit_reminder",
        "Promise broken: One friendly reminder about the job",
        [notYet.invoice_number],
      ],
      [
        "broken_promise",
        "deposit_reminder",
        "Promise broken: One friendly reminder about the job",
        [sent.invoice_number],
      ],
      ["text", "friendly_text", "Day 1: friendly text", [debt.invoice_number]],
    ],
  );
  assertEquals(out.items[0].promise?.status, "broken");
  assertEquals(out.paused.map((p) => p.invoices[0].invoice_number), [
    openOne.invoice_number,
  ]);
  assertEquals(out.waiting, []);

  // Once the broken-promise reminder is logged, it is the one reminder: nothing more.
  const after = plan([sent], [
    ev(sent, "2026-09-25", { step: "deposit_reminder" }),
    promised(sent, "2026-09-29"),
    ev(sent, THU, { step: "deposit_reminder" }),
  ], "2026-10-02");
  assertEquals(after.items, []);
  assertEquals(after.waiting.map((w) => w.reason), ["reminder_sent"]);
});

Deno.test("builders: a call logged before 30 days overdue (a broken-promise call) is not the 30-day call", () => {
  const brokenAt5 = builder({ invoice_date: "2026-08-01", days_overdue: 5 });
  const events = [
    ev(brokenAt5, "2026-09-20", {
      outcome: "promised",
      promised_amount: 1000,
      promised_date: "2026-09-24",
      amount_due_at_promise: 1000,
    }),
    ev(brokenAt5, "2026-09-26", { step: "builder_call" }),
  ];
  assertEquals(plan([brokenAt5], events).items, []);

  // It reached 30 days overdue on Monday 10-26; on the Tuesday the earlier call does not count.
  const at30 = { ...brokenAt5, days_overdue: 31 };
  const day30 = "2026-10-27";
  assertEquals(
    plan([at30], events, day30).items.map((i) => [i.group, i.step]),
    [["call", "builder_call"]],
  );
  assertEquals(
    plan(
      [{ ...at30, hold: "check_first", hold_reason: "doubt" }],
      events,
      day30,
    )
      .items.map((i) => i.held_step),
    ["builder_call"],
  );
  // A call on the day it reached 30 days overdue, or after, is the 30-day call.
  const calledOn30 = [
    ...events,
    ev(at30, "2026-10-26", { step: "builder_call" }),
  ];
  assertEquals(plan([at30], calledOn30, day30).items, []);
  assertEquals(
    plan([{ ...at30, days_overdue: 33 }], calledOn30, "2026-10-29").items,
    [],
  );
});

// ── Plan step 3: desk decision rows and promises over several invoices ──

Deno.test("chase log: a draft's approval, skip or refused send never moves the ladder; its send does", () => {
  const row = (over: Record<string, unknown>) =>
    debtChaseEventFromLogRow({
      xero_invoice_id: "ABC",
      method: "sms",
      created_at: "2026-09-30T01:00:00Z",
      chased_by: "shaun@example.test",
      schedule_step: "friendly_text",
      draft_id: "2026-09-30:contact-a:text:friendly_text|100000",
      ...over,
    });
  // Approved, not sent (sending is off): not a step.
  assertEquals(
    row({ outcome_code: null, approved_by_user_id: "user-1" }),
    null,
  );
  assertEquals(row({ outcome_code: "skipped" }), null);
  assertEquals(
    row({ outcome_code: "failed", outcome: "refused: sending_off" }),
    null,
  );
  // The send stamps the step; "sent" is not a call outcome.
  const sent = row({
    outcome_code: "sent",
    provider_message_id: "msg-1",
    covers_invoice_ids: ["ABC", "DEF"],
  });
  assertEquals(sent?.step, "friendly_text");
  assertEquals(sent?.outcome, null);
  assertEquals(sent?.covers, ["abc", "def"]);
  // A step row from before drafts (no draft id, no outcome code) still counts.
  assertEquals(row({ draft_id: null })?.step, "friendly_text");

  const a = inv({ days_overdue: 2 });
  const approvedOnly = plan(
    [a],
    [
      debtChaseEventFromLogRow({
        xero_invoice_id: a.xero_invoice_id,
        method: "sms",
        created_at: "2026-09-30T01:00:00Z",
        schedule_step: "friendly_text",
        draft_id: "d1",
        approved_by_user_id: "user-1",
      }),
    ].filter((e): e is DebtChaseEvent => e !== null),
  );
  assertEquals(approvedOnly.items.map((i) => i.step), ["friendly_text"]);
  const sentYesterday = plan([a], [
    ev(a, "2026-09-30", { step: "friendly_text" }),
  ]);
  assertEquals(sentYesterday.items.map((i) => i.step), ["firm_text"]);
});

Deno.test("a promise covering several invoices is judged on their total, not one invoice", () => {
  const a = inv({ days_overdue: 10, amount_due: 500 });
  const b = inv({ days_overdue: 10, amount_due: 1000 });
  const promise = (x: DebtChaseBookInvoice) =>
    ev(x, "2026-09-29", {
      outcome: "promised",
      promised_amount: 500,
      promised_date: "2026-09-30",
      amount_due_at_promise: 1500,
      covers: [a.xero_invoice_id, b.xero_invoice_id],
    });
  // Nothing paid on either: broken, even though one invoice alone is below the total.
  const unpaid = plan([a, b], [promise(a), promise(b)]);
  assertEquals(unpaid.items.map((i) => [i.group, i.promise?.status]), [
    ["broken_promise", "broken"],
  ]);
  // $200 off one and $300 off the other covers the $500 promised: kept.
  const a2 = { ...a, amount_due: 300 };
  const b2 = { ...b, amount_due: 700 };
  const paid = plan([a2, b2], [promise(a2), promise(b2)]);
  assertEquals(paid.items.map((i) => [i.group, i.promise?.status]), [
    ["text", "kept"],
  ]);
  // One covered invoice paid off and gone from the book counts as nothing owing on it.
  const gone = plan([b], [promise(b)]);
  assertEquals(gone.items.map((i) => [i.group, i.promise?.status]), [
    ["text", "kept"],
  ]);
});

// ── Plan step 5: Jan's visit outcomes and one row per promise ──

Deno.test("Jan's visit outcomes move the ladder like a call: no one home comes back tomorrow", () => {
  const a = inv({ days_overdue: 9 });
  const visit = (outcome: DebtChaseEvent["outcome"], over = {}) => [
    ev(a, THU, { step: "jan_visit", outcome, ...over }),
  ];
  // No one home: done for today, back on Jan's list tomorrow, worded as Jan reported it.
  assertEquals(plan([a], visit("no_answer")).items, []);
  const tomorrow = plan(
    [{ ...a, days_overdue: 10 }],
    visit("no_answer"),
    "2026-10-02",
  );
  assertEquals(tomorrow.items.map((i) => [i.group, i.step]), [[
    "jan",
    "jan_visit",
  ]]);
  assertEquals(tomorrow.items[0].last_outcome?.label, "No one home");
  // Promised to Jan: paused until the date, then back at the top at Jan's step if broken.
  const promised = visit("promised", {
    promised_amount: 1000,
    promised_date: "2026-10-03",
    amount_due_at_promise: 1000,
  });
  assertEquals(plan([a], promised, "2026-10-02").paused.length, 1);
  const broken = plan([{ ...a, days_overdue: 13 }], promised, "2026-10-04");
  assertEquals(broken.items.map((i) => [i.group, i.step, i.step_label]), [[
    "broken_promise",
    "jan_visit",
    "Promise broken: Day 7: Jan visits",
  ]]);
  assertEquals(broken.items[0].last_outcome?.label, "Visited: promised");
  // Paid and disputed hold the invoice for a check, in Jan's words.
  const paid = plan([a], visit("says_paid"), "2026-10-02").items[0];
  assertEquals([paid.hold, paid.hold_reason?.split(" (")[0]], [
    "check_first",
    "Jan reports paid: check Xero first",
  ]);
  assertEquals(paid.held_step, "jan_visit");
  const disputed = plan([a], visit("disputed"), "2026-10-02").items[0];
  assertEquals(
    disputed.hold_reason?.split(" (")[0],
    "the payer disputed it with Jan",
  );
});

Deno.test("one promise covering several builder invoices pauses as one row, never once per invoice", () => {
  const a = builder({
    invoice_date: "2026-08-01",
    days_overdue: 40,
    amount_due: 300,
  });
  const b2 = builder({
    invoice_date: "2026-08-02",
    days_overdue: 39,
    amount_due: 200,
  });
  const c = builder({
    invoice_date: "2026-08-03",
    days_overdue: 38,
    amount_due: 100,
  });
  const promise = {
    outcome: "promised" as const,
    promised_amount: 500,
    promised_date: "2026-10-03",
    amount_due_at_promise: 500,
    covers: [a.xero_invoice_id, b2.xero_invoice_id],
  };
  const out = plan([a, b2, c], [
    ev(a, "2026-09-30", promise),
    ev(b2, "2026-09-30", promise),
    ev(c, "2026-09-30", {
      outcome: "promised",
      promised_amount: 100,
      promised_date: "2026-10-03",
      amount_due_at_promise: 100,
      covers: [c.xero_invoice_id],
    }),
  ]);
  assertEquals(
    out.paused.map((
      p,
    ) => [p.invoices.map((i) => i.invoice_number), p.amount, p.promise.amount]),
    [
      [[a.invoice_number, b2.invoice_number], 500, 500],
      [[c.invoice_number], 100, 100],
    ],
  );
});

Deno.test("one promise covering several deposits pauses as one row", () => {
  const dep = (over: Partial<DebtChaseBookInvoice> = {}) =>
    inv({
      is_debt: false,
      kind: "deposit",
      not_debt_reason: "deposit",
      ...over,
    });
  const a = dep({ amount_due: 400 });
  const b2 = dep({ amount_due: 600 });
  const promise = {
    outcome: "promised" as const,
    promised_amount: 1000,
    promised_date: "2026-10-03",
    amount_due_at_promise: 1000,
    covers: [a.xero_invoice_id, b2.xero_invoice_id],
  };
  const out = plan([a, b2], [
    ev(a, "2026-09-30", promise),
    ev(b2, "2026-09-30", promise),
  ]);
  assertEquals(out.items, []);
  assertEquals(out.paused.length, 1);
  assertEquals(out.paused[0].amount, 1000);
  assertEquals(out.paused[0].invoices.length, 2);
});
