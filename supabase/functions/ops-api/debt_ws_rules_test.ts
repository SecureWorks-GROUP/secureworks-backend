// deno-lint-ignore-file no-import-prefix
// Debt Workshop rules (debt_ws_rules.ts): every branch of spec sections 2 to 6. All names,
// addresses and amounts here are synthetic.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  addDays,
  categoryFor,
  classifyInvoice,
  clientTextProblem,
  daysBetween,
  dayZeroFor,
  dueDateFor,
  escapeHtml,
  firstNameOf,
  historyLine,
  inScope,
  invoiceKindOf,
  isIsoDate,
  isNotChased,
  isWeekend,
  janListText,
  ladderFor,
  type LadderInput,
  laneFor,
  latestReachedStep,
  longDate,
  looksLikeCompany,
  mondayOf,
  money,
  nameTokens,
  nextMonday,
  onJanList,
  ordinal,
  parseReference,
  payerLabel,
  perthDate,
  perthDateOf,
  possiblePayments,
  replyTemplateText,
  shareLabel,
  shiftWeekend,
  statementHtml,
  statementSubject,
  stepDate,
  stepTemplateText,
  streetOf,
  styleProblem,
  type TemplateVars,
  weekday,
  workOf,
  type WsInvoice,
  type WsJob,
} from "./debt_ws_rules.ts";

function inv(over: Partial<WsInvoice> = {}): WsInvoice {
  return {
    xero_invoice_id: "10000000-0000-4000-8000-000000000001",
    xero_contact_id: "c0000000-0000-4000-8000-000000000001",
    contact_name: "Alex Sample",
    invoice_number: "INV-1001",
    invoice_type: "ACCREC",
    status: "AUTHORISED",
    reference: "SWF-90001-FINBAL",
    total: 1000,
    amount_due: 1000,
    invoice_date: "2026-10-01",
    due_date: "2026-10-15",
    fully_paid_on: null,
    job_id: "20000000-0000-4000-8000-000000000001",
    first_description: "Balance (50% of $2,000)",
    ...over,
  };
}

function job(over: Partial<WsJob> = {}): WsJob {
  return {
    id: "20000000-0000-4000-8000-000000000001",
    status: "final_payment",
    type: "fencing",
    job_number: "SWF-90001",
    client_name: "Alex Sample",
    client_phone: "0400 000 001",
    client_email: "alex@example.test",
    site_address: "12 Example Street, Testville WA 6000",
    site_suburb: "Testville",
    ghl_contact_id: "ghlcontact0000000001",
    ...over,
  };
}

// ── Dates ──

Deno.test("dates: Perth calendar, weekends, Mondays and the long form", () => {
  assertEquals(perthDate(new Date("2026-10-07T16:30:00Z")), "2026-10-08");
  assertEquals(perthDate(new Date("2026-10-07T15:59:00Z")), "2026-10-07");
  assertEquals(perthDateOf("2026-10-07T16:30:00Z"), "2026-10-08");
  assertEquals(perthDateOf("2026-10-07"), "2026-10-07");
  assertEquals(perthDateOf("nonsense"), null);
  assertEquals(perthDateOf(null), null);
  assertEquals(addDays("2026-10-30", 3), "2026-11-02");
  assertEquals(daysBetween("2026-10-01", "2026-10-08"), 7);
  assertEquals(daysBetween("2026-10-08", "2026-10-01"), -7);
  assertEquals(weekday("2026-10-08"), 4);
  assert(isWeekend("2026-10-10") && isWeekend("2026-10-11"));
  assert(!isWeekend("2026-10-09"));
  assertEquals(shiftWeekend("2026-10-10"), "2026-10-12");
  assertEquals(shiftWeekend("2026-10-11"), "2026-10-12");
  assertEquals(shiftWeekend("2026-10-09"), "2026-10-09");
  assertEquals(mondayOf("2026-10-08"), "2026-10-05");
  assertEquals(mondayOf("2026-10-05"), "2026-10-05");
  assertEquals(mondayOf("2026-10-11"), "2026-10-05");
  assertEquals(nextMonday("2026-10-08"), "2026-10-12");
  assertEquals(nextMonday("2026-10-12"), "2026-10-19");
  assertEquals(nextMonday("2026-10-11"), "2026-10-12");
  assertEquals(longDate("2026-10-17"), "Saturday the 17th of October");
  assertEquals(longDate("2026-10-01"), "Thursday the 1st of October");
  assertEquals(
    [1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 31, 101, 111].map(ordinal),
    [
      "1st",
      "2nd",
      "3rd",
      "4th",
      "11th",
      "12th",
      "13th",
      "21st",
      "22nd",
      "23rd",
      "31st",
      "101st",
      "111th",
    ],
  );
  assert(isIsoDate("2026-02-28"));
  assert(!isIsoDate("2026-02-30"));
  assert(!isIsoDate("2026-1-01"));
  assert(!isIsoDate(20261001));
});

Deno.test("money formats with commas and cents", () => {
  assertEquals(money(1234.5), "$1,234.50");
  assertEquals(money(0), "$0.00");
  assertEquals(money(1000000), "$1,000,000.00");
  assertEquals(money(-12.3), "-$12.30");
});

// ── Section 2: scope and lane ──

Deno.test("scope: ACCREC, AUTHORISED, amount due above zero, no SAMPLE- reference", () => {
  assert(inScope(inv()));
  assert(!inScope(inv({ invoice_type: "ACCPAY" })));
  assert(!inScope(inv({ status: "PAID" })));
  assert(!inScope(inv({ status: "DRAFT" })));
  assert(!inScope(inv({ amount_due: 0 })));
  assert(!inScope(inv({ amount_due: null })));
  assert(!inScope(inv({ reference: "SAMPLE-123-FINBAL" })));
  assert(!inScope(inv({ reference: "swf-sample-1" })));
});

Deno.test("lane: fencing and patio are homeowner; make-safe, repair, roof report and insurance are account", () => {
  assertEquals(laneFor(job({ type: "fencing" }), null).lane, "homeowner");
  assertEquals(laneFor(job({ type: "Patio" }), null).lane, "homeowner");
  for (
    const type of [
      "makesafe",
      "repair",
      "roof_report",
      "roof report",
      "insurance",
    ]
  ) {
    assertEquals(laneFor(job({ type }), null).lane, "account", type);
  }
  assertEquals(laneFor(job({ type: "decking" }), null), {
    lane: "needs_a_look",
    reason: "unknown job type",
  });
  assertEquals(laneFor(job({ type: null }), null).lane, "needs_a_look");
});

Deno.test("lane: no linked job is account for a company-looking contact, else needs a look", () => {
  for (
    const name of [
      "Sample Builders",
      "Example Pty Ltd",
      "Test Restoration Co",
      "Somewhere Strata",
      "An Insurance Group",
      "City Council",
      "Department of Examples",
      "Example Construction",
      "Family Trust",
      "Housing Services",
      "Example Building",
    ]
  ) {
    assert(looksLikeCompany(name), name);
    assertEquals(laneFor(null, name).lane, "account", name);
  }
  assertEquals(laneFor(null, "Jordan Sample"), {
    lane: "needs_a_look",
    reason: "not linked to a job",
  });
  assertEquals(laneFor(null, null).lane, "needs_a_look");
  assert(!looksLikeCompany("Pattie Groupman"));
});

// ── Section 2: kind ──

Deno.test("reference parsing: neighbour letter and ending", () => {
  assertEquals(parseReference("SWF-26091-A-FINBAL"), {
    letter: "A",
    ending: "FINBAL",
  });
  assertEquals(parseReference("SWF-26091-FINBAL"), {
    letter: null,
    ending: "FINBAL",
  });
  assertEquals(parseReference("SWF-26091-FINBAL-B"), {
    letter: "B",
    ending: "FINBAL",
  });
  assertEquals(parseReference("swf-26091-dep50 "), {
    letter: null,
    ending: "DEP50",
  });
  assertEquals(parseReference("SWMS-1-PRIVATE Some Name"), {
    letter: null,
    ending: "PRIVATE",
  });
  assertEquals(parseReference(null), { letter: null, ending: null });
  assertEquals(parseReference("A"), { letter: null, ending: "A" });
});

Deno.test("kind: every final ending with Balance or Remaining is final", () => {
  for (const ending of ["FINBAL", "FINBAL50", "BAL", "FINAL", "PRIVATE"]) {
    assertEquals(
      invoiceKindOf(`SWF-1-${ending}`, "Balance (50% of $100)").kind,
      "final",
      ending,
    );
    assertEquals(
      invoiceKindOf(`SWF-1-${ending}`, "remaining amount").kind,
      "final",
      ending,
    );
  }
});

Deno.test("kind: every not-final ending with its matching description", () => {
  const cases: Array<[string, string, string]> = [
    ["DEP", "Deposit", "deposit"],
    ["DEP20", "Deposit (20%)", "deposit"],
    ["DEP25", "Deposit ($1,000)", "deposit"],
    ["DEP50", "Deposit (50% of $2)", "deposit"],
    ["PLAN", "Planning Fee", "planning fee"],
    ["MAT", "Materials", "materials"],
    ["MAT50", "Materials (50%)", "materials"],
    ["PROG", "Progress claim 1", "progress"],
    ["VAR", "Extra Labour: gate", "extra labour"],
  ];
  for (const [ending, desc, stage] of cases) {
    assertEquals(invoiceKindOf(`SWP-1-${ending}`, desc), {
      kind: "not_final",
      stage,
    }, ending);
  }
});

Deno.test("kind: an unknown ending or a disagreeing description cannot be told", () => {
  const none = { kind: null, stage: null };
  assertEquals(invoiceKindOf("SWF-1-FINBAL", "Deposit (50%)"), none);
  assertEquals(invoiceKindOf("SWF-1-DEP50", "Balance (50%)"), none);
  assertEquals(invoiceKindOf("SWF-1-FIN25", "Balance (25%)"), none);
  assertEquals(invoiceKindOf("SWF-1-DEP10", "Deposit (10%)"), none);
  assertEquals(invoiceKindOf("SWF-1-FINBAL", "Remainder (50%)"), none);
  assertEquals(invoiceKindOf("SWF-1-FINBAL", ""), none);
  assertEquals(invoiceKindOf(null, "Balance"), none);
  assertEquals(invoiceKindOf("SWF-1-PLAN", "Materials"), none);
});

Deno.test("share label: job number plus neighbour letter, or main", () => {
  assertEquals(shareLabel("SWF-26091", "SWF-26091-A-FINBAL"), {
    share: "SWF-26091/A",
    letter: "A",
  });
  assertEquals(shareLabel("SWF-26091", "SWF-26091-FINBAL"), {
    share: "SWF-26091/main",
    letter: "main",
  });
  assertEquals(shareLabel(null, "SWF-26091-FINBAL").share, null);
});

// ── Section 2: the debt rule ──

const DEP = (
  id: string,
  date: string,
  status = "PAID",
  over: Partial<WsInvoice> = {},
) =>
  inv({
    xero_invoice_id: id,
    invoice_number: `INV-${id.slice(-4)}`,
    reference: "SWF-90001-DEP50",
    first_description: "Deposit (50%)",
    invoice_date: date,
    status,
    ...over,
  });

Deno.test("debt rule: a final is always debt", () => {
  const c = classifyInvoice(inv(), job(), [inv()]);
  assertEquals(c.status, "debt");
  if (c.status === "debt") {
    assertEquals(c.kind, "final");
    assertEquals(c.share, "SWF-90001/main");
  }
});

Deno.test("debt rule: the first not-final in a share is the go-ahead, later ones are progress", () => {
  const first = DEP(
    "10000000-0000-4000-8000-000000000010",
    "2026-09-01",
    "AUTHORISED",
  );
  const second = inv({
    xero_invoice_id: "10000000-0000-4000-8000-000000000011",
    invoice_number: "INV-0011",
    reference: "SWF-90001-MAT50",
    first_description: "Materials (50%)",
    invoice_date: "2026-09-20",
  });
  const history = [first, second];
  assertEquals(classifyInvoice(first, job(), history).status, "go_ahead");
  const c = classifyInvoice(second, job(), history);
  assertEquals(c.status, "debt");
  if (c.status === "debt") {
    assertEquals(c.kind, "progress");
    assertEquals(c.stage, "materials");
  }
});

Deno.test("debt rule: share order is invoice date then invoice number, counting AUTHORISED and PAID only", () => {
  const a = DEP(
    "10000000-0000-4000-8000-000000000021",
    "2026-09-01",
    "AUTHORISED",
    {
      invoice_number: "INV-0010",
    },
  );
  const b = DEP(
    "10000000-0000-4000-8000-000000000022",
    "2026-09-01",
    "AUTHORISED",
    {
      invoice_number: "INV-0009",
    },
  );
  // INV-0009 sorts before INV-0010 on the same date (numeric order).
  assertEquals(classifyInvoice(b, job(), [a, b]).status, "go_ahead");
  assertEquals(classifyInvoice(a, job(), [a, b]).status, "debt");
  // A voided earlier deposit does not count: the open one is the go-ahead.
  const voided = DEP(
    "10000000-0000-4000-8000-000000000023",
    "2026-08-01",
    "VOIDED",
  );
  assertEquals(classifyInvoice(a, job(), [voided, a]).status, "go_ahead");
  // The subject is counted even when the history read missed it.
  assertEquals(classifyInvoice(a, job(), []).status, "go_ahead");
});

Deno.test("debt rule: each neighbour letter is its own share", () => {
  const mainDep = DEP("10000000-0000-4000-8000-000000000031", "2026-09-01");
  const neighbourDep = DEP(
    "10000000-0000-4000-8000-000000000032",
    "2026-09-10",
    "AUTHORISED",
    {
      reference: "SWF-90001-B-DEP50",
    },
  );
  assertEquals(
    classifyInvoice(neighbourDep, job(), [mainDep, neighbourDep]).status,
    "go_ahead",
  );
});

Deno.test("debt rule: account invoices are always debt, linked or not", () => {
  const c = classifyInvoice(
    inv({ reference: "WO-1", first_description: "Make safe" }),
    job({ type: "makesafe" }),
    [],
  );
  assertEquals(c.status === "debt" && c.kind, "account");
  const u = classifyInvoice(
    inv({ job_id: null, contact_name: "Example Builders" }),
    null,
    [],
  );
  assertEquals(u.status === "debt" && u.kind, "account");
});

Deno.test("needs a look: unlinked person, unknown type, unknown kind, duplicate", () => {
  const notLinked = classifyInvoice(inv({ job_id: null }), null, []);
  assertEquals(
    notLinked.status === "needs_a_look" && notLinked.reason,
    "not linked to a job",
  );
  const unknownType = classifyInvoice(inv(), job({ type: "decking" }), []);
  assertEquals(
    unknownType.status === "needs_a_look" && unknownType.reason,
    "unknown job type",
  );
  const unknownKind = classifyInvoice(
    inv({ reference: "SWF-90001-FIN25" }),
    job(),
    [],
  );
  assertEquals(
    unknownKind.status === "needs_a_look" && unknownKind.reason,
    "can't tell what this invoice is",
  );
  const paidTwin = inv({
    xero_invoice_id: "10000000-0000-4000-8000-000000000099",
    status: "PAID",
    amount_due: 0,
  });
  const dup = classifyInvoice(inv(), job(), [paidTwin, inv()]);
  assertEquals(
    dup.status === "needs_a_look" && dup.reason,
    "looks like a duplicate",
  );
  // A twin on another share, with another total, or not paid is no duplicate.
  for (
    const other of [
      { ...paidTwin, reference: "SWF-90001-A-FINBAL" },
      { ...paidTwin, total: 999 },
      { ...paidTwin, status: "AUTHORISED" },
    ]
  ) {
    assertEquals(classifyInvoice(inv(), job(), [other, inv()]).status, "debt");
  }
});

Deno.test("not chased: whole words of a listed contact, any case", () => {
  const list = ["Emergency Trade Services", "Builderwest"];
  assert(isNotChased("Emergency Trade Services", list));
  assert(isNotChased("Builderwest Pty Ltd", list));
  assert(isNotChased("Builderwest Pty Ltd ATF Builderwest Unit Trust", list));
  assert(isNotChased("BUILDERWEST", list));
  assert(!isNotChased("Builderwesterly Homes", list));
  assert(!isNotChased("Major Loss Builders", list));
  assert(!isNotChased(null, list));
  assert(!isNotChased("Anyone", []));
});

// ── Section 3 ──

Deno.test("due dates: final on the invoice date, progress +7, account +10", () => {
  assertEquals(dueDateFor("final", "2026-10-01"), "2026-10-01");
  assertEquals(dueDateFor("progress", "2026-10-01"), "2026-10-08");
  assertEquals(dueDateFor("account", "2026-10-01"), "2026-10-11");
});

Deno.test("day 0: a final restarts when the job left rectification after the due date", () => {
  assertEquals(dayZeroFor("final", "2026-10-01", "2026-10-05"), "2026-10-05");
  assertEquals(dayZeroFor("final", "2026-10-01", "2026-09-20"), "2026-10-01");
  assertEquals(dayZeroFor("final", "2026-10-01", null), "2026-10-01");
  assertEquals(
    dayZeroFor("progress", "2026-10-08", "2026-10-20"),
    "2026-10-08",
  );
  assertEquals(dayZeroFor("account", "2026-10-11", "2026-10-20"), "2026-10-11");
});

Deno.test("category: first match wins", () => {
  const c = (day: number, saysPaid = false, jobStatus: string | null = null) =>
    categoryFor({ day, saysPaid, jobStatus });
  assertEquals(c(30, true, "rectification"), "says_paid");
  assertEquals(c(30, false, "rectification"), "rectification");
  assertEquals(c(-2, false, "Rectification"), "rectification");
  assertEquals(c(0), null);
  assertEquals(c(-5), null);
  assertEquals(c(1), "active");
  assertEquals(c(7), "active");
  assertEquals(c(8), "escalating");
  assertEquals(c(20), "escalating");
  assertEquals(c(21), "bad_debt");
  assertEquals(c(400), "bad_debt");
});

Deno.test("neighbour label: a letter or a different payer shows who they neighbour", () => {
  assertEquals(payerLabel("Alex Sample", "Alex Sample", "main"), {
    label: "Alex Sample",
    neighbourOf: null,
  });
  assertEquals(
    payerLabel("alex  sample", "Alex Sample", "main").neighbourOf,
    null,
  );
  assertEquals(payerLabel("Robin Next", "Alex Sample", "main"), {
    label: "Robin Next (neighbour of Alex Sample)",
    neighbourOf: "Alex Sample",
  });
  assertEquals(
    payerLabel("Alex Sample", "Alex Sample", "B").label,
    "Alex Sample (neighbour of Alex Sample)",
  );
  // A job named by first name only is the same payer, not a neighbour.
  assertEquals(payerLabel("Alex Sample", "Alex", "main").neighbourOf, null);
  assertEquals(payerLabel("Alex", "Alex Sample", "main").neighbourOf, null);
  assertEquals(
    payerLabel("Alex Other", "Alex Sample", "main").neighbourOf,
    "Alex Sample",
  );
  assertEquals(payerLabel(null, "Alex Sample", "main").label, "Alex Sample");
  assertEquals(payerLabel("Robin Next", null, "A").label, "Robin Next");
  assertEquals(payerLabel(null, null, "main").label, "Unknown payer");
});

// ── Section 4: steps ──

// Day 0 is Thursday 1 October 2026: d1 Fri 2nd, d3 Sun 4th shown Mon 5th, d7 Thu 8th,
// d12 Tue 13th, d17 Sun 18th shown Mon 19th, d21 Thu 22nd.
const D0 = "2026-10-01";

function ladder(over: Partial<LadderInput> = {}) {
  return ladderFor({
    kind: "final",
    dayZero: D0,
    today: "2026-10-08",
    category: "active",
    pausedUntil: null,
    notChased: false,
    sent: new Set(),
    skipped: new Set(),
    ...over,
  });
}

Deno.test("steps: dates shift off the weekend to Monday", () => {
  assertEquals(stepDate(D0, "d1"), "2026-10-02");
  assertEquals(stepDate(D0, "d3"), "2026-10-05");
  assertEquals(stepDate(D0, "d7"), "2026-10-08");
  assertEquals(stepDate(D0, "d12"), "2026-10-13");
  assertEquals(stepDate(D0, "d17"), "2026-10-19");
  assertEquals(stepDate(D0, "d21"), "2026-10-22");
  assertEquals(latestReachedStep(D0, "2026-10-01"), null);
  assertEquals(latestReachedStep(D0, "2026-10-04"), "d1");
  assertEquals(latestReachedStep(D0, "2026-10-05"), "d3");
  assertEquals(latestReachedStep(D0, "2026-11-30"), "d21");
});

Deno.test("steps: only the latest due step is offered, never an earlier one", () => {
  assertEquals(ladder().step_due, { step: "d7", label: "Day 7 call and text" });
  // Found at day 30: d21, never d1.
  assertEquals(ladder({ today: "2026-10-31" }).step_due?.step, undefined);
  assertEquals(
    ladder({ today: "2026-10-30", category: "bad_debt" }).step_due?.step,
    "d21",
  );
  const l = ladder({ today: "2026-10-30", category: "bad_debt" });
  assertEquals(l.ladder.map((s) => s.status), [
    "not_applicable",
    "not_applicable",
    "not_applicable",
    "not_applicable",
    "not_applicable",
    "due",
  ]);
});

Deno.test("steps: a sent or skipped latest step leaves nothing due until the next", () => {
  const sent = ladder({ sent: new Set(["d7"]) });
  assertEquals(sent.step_due, null);
  assertEquals(sent.next_step, { step: "d12", date: "2026-10-13" });
  assertEquals(sent.ladder.find((s) => s.step === "d7")?.status, "done");
  const skipped = ladder({ skipped: new Set(["d7"]) });
  assertEquals(skipped.step_due, null);
  assertEquals(skipped.ladder.find((s) => s.step === "d7")?.status, "skipped");
  // An earlier step not done is not offered once a later one is reachable.
  assertEquals(ladder({ sent: new Set(["d1"]) }).step_due?.step, "d7");
  assertEquals(ladder().ladder.map((s) => s.status), [
    "not_applicable",
    "not_applicable",
    "due",
    "upcoming",
    "upcoming",
    "upcoming",
  ]);
});

Deno.test("steps: none on a weekend; the weekend step shows on Monday", () => {
  // Saturday 3 Oct: d1 reached, but no step is due on a weekend.
  assertEquals(ladder({ today: "2026-10-03" }).step_due, null);
  assertEquals(ladder({ today: "2026-10-04" }).step_due, null);
  assertEquals(ladder({ today: "2026-10-05" }).step_due?.step, "d3");
});

Deno.test("steps: paused, says paid, rectification, not due and not chased hold the steps", () => {
  const paused = ladder({ pausedUntil: "2026-10-10" });
  assertEquals(paused.step_due, null);
  assert(paused.paused);
  assertEquals(paused.next_step, { step: "d12", date: "2026-10-13" });
  const longPause = ladder({ pausedUntil: "2026-10-15" });
  assertEquals(longPause.next_step, { step: "d12", date: "2026-10-16" });
  const weekendPause = ladder({ pausedUntil: "2026-10-16" });
  assertEquals(weekendPause.next_step?.date, "2026-10-19");
  // A promise for today is not in the future: the step is offered.
  assertEquals(ladder({ pausedUntil: "2026-10-08" }).step_due?.step, "d7");
  assertEquals(ladder({ category: "says_paid" }).step_due, null);
  assertEquals(ladder({ category: "says_paid" }).next_step, null);
  assertEquals(ladder({ category: "rectification" }).step_due, null);
  assertEquals(ladder({ category: null, today: "2026-10-01" }).step_due, null);
  assertEquals(ladder({ category: null, today: "2026-10-01" }).next_step, {
    step: "d1",
    date: "2026-10-02",
  });
  assertEquals(ladder({ notChased: true }).step_due, null);
  assertEquals(ladder({ notChased: true }).next_step, null);
});

Deno.test("steps: progress payments hold at day 21; accounts have no steps", () => {
  const progress = ladder({
    kind: "progress",
    today: "2026-10-30",
    category: "bad_debt",
  });
  assertEquals(progress.step_due, null);
  assertEquals(progress.next_step, null);
  assertEquals(progress.ladder[5].status, "not_applicable");
  const progressEarly = ladder({
    kind: "progress",
    today: "2026-10-20",
    category: "escalating",
  });
  assertEquals(progressEarly.step_due?.step, "d17");
  assertEquals(progressEarly.next_step, null);
  const account = ladder({ kind: "account" });
  assertEquals(account.step_due, null);
  assertEquals(account.next_step, null);
  assert(account.ladder.every((s) => s.status === "not_applicable"));
});

Deno.test("Jan's list: finals at day 21+, not paused, says-paid, rectification, not chased or removed", () => {
  const base = {
    kind: "final" as const,
    reached: "d21" as const,
    paused: false,
    category: "bad_debt" as const,
    notChased: false,
    removed: false,
  };
  assert(onJanList(base));
  assert(!onJanList({ ...base, kind: "progress" }));
  assert(!onJanList({ ...base, reached: "d17" }));
  assert(!onJanList({ ...base, paused: true }));
  assert(!onJanList({ ...base, category: "says_paid" }));
  assert(!onJanList({ ...base, category: "rectification" }));
  assert(!onJanList({ ...base, notChased: true }));
  assert(!onJanList({ ...base, removed: true }));
});

// ── Section 5: templates ──

const VARS: TemplateVars = {
  name: "Alex",
  street: "Example Street",
  work: "fence",
  amount: 1234.5,
  pay_link: "https://in.xero.com/example",
  date17: "Monday the 19th of October",
  date21: "Thursday the 22nd of October",
  overdue_days: 12,
};

Deno.test("templates: the five step texts keep the bones and fill every blank", () => {
  const d1 = stepTemplateText("d1", "final", null, VARS);
  assertEquals(
    d1,
    "Hi Alex,\n\nHope you're well! Hope you're enjoying the new fence at Example Street.\n\nI've sent through the final invoice by email. If you could get that sorted when you get a chance, that would be great.\n\nLet us know if you have any questions.\n\nCheers,\nShaun",
  );
  const d3 = stepTemplateText("d3", "final", null, VARS);
  assert(
    d3.endsWith(
      "If not, you can pay here: https://in.xero.com/example\n\nCheers,\nShaun",
    ),
  );
  const d7 = stepTemplateText("d7", "final", null, VARS);
  assert(d7.includes("There's $1,234.50 still outstanding."));
  assert(d7.includes("that would be great: https://in.xero.com/example"));
  const d12 = stepTemplateText("d12", "final", null, VARS);
  assert(d12.includes("The $1,234.50 is now 12 days overdue."));
  assert(
    d12.includes(
      "Please get this paid by Monday the 19th of October: https://in.xero.com/example",
    ),
  );
  const d17 = stepTemplateText("d17", "final", null, VARS);
  assert(
    d17.includes(
      "If it's not paid by Thursday the 22nd of October, one of our team will come by your home",
    ),
  );
  for (const text of [d1, d3, d7, d12, d17]) {
    assertEquals(clientTextProblem(text), null);
    assert(text.endsWith("Cheers,\nShaun"));
  }
});

Deno.test("templates: no pay link drops the line to 'the link is in the invoice email'", () => {
  const vars = { ...VARS, pay_link: null };
  for (const step of ["d3", "d7", "d12", "d17"] as const) {
    const text = stepTemplateText(step, "final", null, vars);
    assert(/[Tt]he link is in the invoice email/.test(text), step);
    assert(!text.includes("http"), step);
    assertEquals(clientTextProblem(text), null, step);
  }
  assertEquals(
    stepTemplateText("d1", "final", null, vars),
    stepTemplateText("d1", "final", null, VARS),
  );
});

Deno.test("templates: progress payments name the stage; a missing street reads 'your place'", () => {
  const text = stepTemplateText("d3", "progress", "materials", VARS);
  assert(text.includes("the materials invoice for Example Street"));
  assert(!text.includes("final invoice"));
  assert(
    stepTemplateText("d1", "progress", null, VARS).includes("progress invoice"),
  );
  assert(
    stepTemplateText("d1", "final", null, { ...VARS, street: null }).includes(
      "at your place.",
    ),
  );
});

Deno.test("templates: the replies", () => {
  assertEquals(
    replyTemplateText("says_paid", { name: "Alex" }),
    "Thanks Alex! It hasn't shown up our end yet. Could you send through a screenshot of the payment so we can match it up?\n\nCheers,\nShaun",
  );
  assert(
    replyTemplateText("promise", { name: "Alex", promise_date: "2026-10-16" })
      .includes("on Friday the 16th of October."),
  );
  assert(
    replyTemplateText("promise", { name: "Alex", promise_date: "Friday" })
      .includes("on Friday."),
  );
  assert(
    replyTemplateText("problem", { name: "Alex", issue: "gate latch" })
      .includes(
        "sort the gate latch and",
      ),
  );
  const fixed = replyTemplateText("problem_fixed", {
    name: "Alex",
    issue: "gate latch",
    installer: "Sam",
    street: "Example Street",
  });
  assert(
    fixed.includes(
      "Sam sorted the gate latch today. I've resent the final invoice for Example Street.",
    ),
  );
  assertEquals(clientTextProblem(fixed), null);
});

Deno.test("template helpers: first name, street, work", () => {
  assertEquals(firstNameOf("ALEX SAMPLE"), "Alex");
  assertEquals(firstNameOf("alex sample"), "Alex");
  assertEquals(firstNameOf("McAlex Sample"), "McAlex");
  assertEquals(firstNameOf(""), "there");
  assertEquals(firstNameOf("123"), "there");
  assertEquals(
    streetOf("12 Example Street, Testville WA 6000"),
    "Example Street",
  );
  assertEquals(streetOf("Unit 3/45 Sample Road"), "Sample Road");
  assertEquals(streetOf("12A EXAMPLE ST TESTVILLE WA 6000"), "Example St");
  assertEquals(streetOf("Lot 5 Some Crescent Testville"), "Some Crescent");
  assertEquals(streetOf("7 Blue Gum Way"), "Blue Gum Way");
  assertEquals(streetOf("Somewhere Unusual"), "Somewhere Unusual");
  assertEquals(streetOf(""), null);
  assertEquals(streetOf("12"), null);
  assertEquals(workOf("fencing"), "fence");
  assertEquals(workOf("patio"), "patio");
  assertEquals(workOf("other"), "work");
});

Deno.test("text guard: no dashes, emojis, blanks, legal or credit talk", () => {
  assertEquals(clientTextProblem("Hi there,\n\nCheers,\nShaun"), null);
  assert(clientTextProblem("") !== null);
  assert(clientTextProblem(null) !== null);
  assert(clientTextProblem("x".repeat(1601)) !== null);
  assert(clientTextProblem("Hi \u2014 there") !== null);
  assert(clientTextProblem("Hi \u2013 there") !== null);
  assert(clientTextProblem("Hi \u{1F600}") !== null);
  assert(clientTextProblem("Hi {name}") !== null);
  for (
    const phrase of [
      "we will take legal action",
      "our lawyer",
      "a debt collector",
      "debt collection agency",
      "your credit rating",
      "credit reporting bureau",
      "small claims",
      "we will sue",
      "the magistrates court",
      "the tribunal",
    ]
  ) {
    assert(clientTextProblem(`Hi, ${phrase}.`) !== null, phrase);
  }
  // A street called Court is fine.
  assertEquals(clientTextProblem("The fence at Example Court"), null);
  assertEquals(styleProblem("plain"), null);
});

// ── Section 6: the bank-feed check ──

const TX = (over: Record<string, unknown> = {}) => ({
  bank_transaction_id: "b0000000-0000-4000-8000-000000000001",
  type: "RECEIVE",
  date: "2026-10-05T00:00:00",
  total: 1000,
  reference: null,
  contact_name: null,
  line_item_descriptions: [] as string[],
  ...over,
});

Deno.test("possible payment: receive money within $1 of amount due or total", () => {
  const invoice = {
    invoice_number: "INV-1001",
    amount_due: 500,
    total: 1000,
    invoice_date: "2026-10-01",
  };
  const names = ["Alex Sample", "Alex Sample"];
  assertEquals(
    possiblePayments(invoice, names, [TX({ total: 500.99 })]).length,
    1,
  );
  assertEquals(
    possiblePayments(invoice, names, [TX({ total: 999.01 })]).length,
    1,
  );
  assertEquals(
    possiblePayments(invoice, names, [TX({ total: 501.01 })]).length,
    0,
  );
  assertEquals(
    possiblePayments(invoice, names, [TX({ type: "SPEND" })]).length,
    0,
  );
  assertEquals(
    possiblePayments(invoice, names, [TX({ type: "RECEIVE-OVERPAYMENT" })])
      .length,
    1,
  );
  assertEquals(
    possiblePayments(invoice, names, [TX({ total: null })]).length,
    0,
  );
  // From the invoice date minus one day.
  assertEquals(
    possiblePayments(invoice, names, [TX({ date: "2026-09-30" })]).length,
    1,
  );
  assertEquals(
    possiblePayments(invoice, names, [TX({ date: "2026-09-29" })]).length,
    0,
  );
});

Deno.test("possible payment: the reason says why, and an amount match alone counts", () => {
  const invoice = {
    invoice_number: "INV-1001",
    amount_due: 1000,
    total: 1000,
    invoice_date: "2026-10-01",
  };
  const names = ["Alex Sample"];
  const [byNumber] = possiblePayments(invoice, names, [
    TX({ reference: "inv-1001 fence" }),
  ]);
  assertEquals(byNumber.reason, "amount and invoice number match");
  const [byDescription] = possiblePayments(invoice, names, [
    TX({ line_item_descriptions: ["Payment INV-1001"] }),
  ]);
  assertEquals(byDescription.reason, "amount and invoice number match");
  const [byName] = possiblePayments(invoice, names, [
    TX({ contact_name: "A SAMPLE" }),
  ]);
  assertEquals(byName.reason, "amount and name match");
  assertEquals(byName.payer_text, "A SAMPLE");
  const [amountOnly] = possiblePayments(invoice, names, [
    TX({ reference: "Transfer" }),
  ]);
  assertEquals(amountOnly.reason, "amount matches, name unclear");
  assertEquals(amountOnly.payer_text, "Transfer");
  assertEquals(amountOnly.amount, 1000);
  assertEquals(amountOnly.date, "2026-10-05");
});

Deno.test("name tokens: 3+ letters, no stop words", () => {
  assertEquals(nameTokens(["Mr Al Sample-Jones", "The Sample Family Trust"]), [
    "sample",
    "jones",
  ]);
  assertEquals(nameTokens([null, undefined, ""]), []);
});

// ── Jan's text and the statement ──

Deno.test("Jan's text: one line per visit with the history", () => {
  const history = historyLine([
    { kind: "text_sent", created_at: "2026-10-02T01:00:00Z" },
    { kind: "text_sent", created_at: "2026-10-05T01:00:00Z" },
    { kind: "call", created_at: "2026-10-08T02:00:00Z" },
    { kind: "note", created_at: "2026-10-09T02:00:00Z" },
  ]);
  assertEquals(history, "Texted 2nd, 5th · called 8th");
  assertEquals(historyLine([]), "No texts or calls logged");
  const text = janListText("2026-10-26", [{
    share_key: "s",
    xero_invoice_id: "s",
    invoice_number: "INV-1",
    name: "Alex Sample",
    site_address: "12 Example Street, Testville",
    phone: "0400 000 001",
    amount: 1500,
    history,
  }, {
    share_key: "t",
    xero_invoice_id: "t",
    invoice_number: "INV-2",
    name: "Robin Next",
    site_address: null,
    phone: null,
    amount: 20,
    history: "No texts or calls logged",
  }]);
  assert(
    text.startsWith(
      "Hi Jan,\n\nHere's the visit list for Monday the 26th of October:",
    ),
  );
  assert(
    text.includes(
      "1. Alex Sample, 12 Example Street, Testville, 0400 000 001, $1,500.00. Texted 2nd, 5th",
    ),
  );
  assert(text.includes("2. Robin Next, address not set, no phone, $20.00."));
  assert(text.endsWith("Cheers,\nShaun"));
  assertEquals(styleProblem(text), null);
});

Deno.test("statement: a table with links, days overdue and the total; escaped", () => {
  const html = statementHtml({
    company_name: "Example <Builders>",
    week_start: "2026-10-05",
    lines: [
      {
        xero_invoice_id: "x1",
        invoice_number: "INV-1",
        job_ref: "SWMS-1, 1 Example Road",
        invoice_date: "2026-09-01",
        amount: 300,
        days_overdue: 27,
        pay_link: "https://in.xero.com/a?b=1&c=2",
      },
      {
        xero_invoice_id: "x2",
        invoice_number: "INV-2",
        job_ref: null,
        invoice_date: null,
        amount: 200.5,
        days_overdue: 3,
        pay_link: null,
      },
    ],
  });
  assert(html.includes("Example &lt;Builders&gt;"));
  assert(html.includes('href="https://in.xero.com/a?b=1&amp;c=2"'));
  assert(html.includes("Link to follow"));
  assert(html.includes("$500.50"));
  assert(html.includes(">27<"));
  assert(!html.includes("<script"));
  assertEquals(styleProblem(html), null);
  assertEquals(
    statementSubject("Example Builders", "2026-10-05"),
    "Example Builders: statement of overdue invoices, week of Monday the 5th of October",
  );
  assertEquals(
    escapeHtml(`<a href="x">'&'</a>`),
    "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;",
  );
});
