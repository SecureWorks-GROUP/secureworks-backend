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
    ev(late, "2026-09-30", { step: "builder_call" }),
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
  assertEquals(broken.items.map((i) => [i.group, i.step]), [[
    "broken_promise",
    "builder_call",
  ]]);
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
      approved_by_user_id: "user-1",
    }),
    {
      xero_invoice_id: "abc",
      at: "2026-09-30T01:00:00Z",
      step: "call",
      outcome: "promised",
      promised_amount: 250.5,
      promised_date: "2026-10-03",
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
