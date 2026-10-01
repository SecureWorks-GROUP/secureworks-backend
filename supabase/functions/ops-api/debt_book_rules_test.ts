// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifyDebtBookInvoice,
  DEBT_BOOK_CHECK_FIRST,
  DEBT_BOOK_CORRECTIONS,
  DEBT_BOOK_PAYERS,
  type DebtBookInvoice,
  type DebtBookJobContext,
  diffDebtBookCopy,
  normaliseXeroInvoice,
  perthDate,
  resolvePayer,
  summariseDebtBook,
} from "./debt_book_rules.ts";
import {
  DEBT_BOOK_FIXTURE_2026_09_29 as FIXTURE,
  DEBT_BOOK_FIXTURE_PERTH_DATE,
  DEBT_BOOK_FIXTURE_READ_AT,
  debtBookFixtureInvoiceId,
  type DebtBookFixtureRow,
} from "./debt_book_fixture_2026_09_29.ts";

const PERTH = "2026-09-29";

function inv(extra: Partial<DebtBookInvoice> = {}): DebtBookInvoice {
  return {
    xero_invoice_id: "00000000-0000-4000-8000-000000000001",
    invoice_number: "INV-9001",
    type: "ACCREC",
    status: "AUTHORISED",
    contact_id: null,
    contact_name: "A Homeowner",
    reference: "SWF-26001-FINBAL",
    line_descriptions: [],
    invoice_date: "2026-09-01",
    due_date: "2026-09-20",
    total: 1000,
    amount_due: 1000,
    amount_paid: 0,
    amount_credited: 0,
    ...extra,
  };
}

function job(extra: Partial<DebtBookJobContext> = {}): DebtBookJobContext {
  return {
    job_number: "SWF-26001",
    job_status: "invoiced",
    first_payment: true,
    link_source: "copy_job_id",
    desk_class: null,
    ...extra,
  };
}

function classify(
  i: Partial<DebtBookInvoice> = {},
  j: Partial<DebtBookJobContext> = {},
  perth = PERTH,
) {
  return classifyDebtBookInvoice(inv(i), job(j), { perthDate: perth });
}

function fixtureInvoice(row: DebtBookFixtureRow): DebtBookInvoice {
  return inv({
    xero_invoice_id: debtBookFixtureInvoiceId(row.invoice_number),
    invoice_number: row.invoice_number,
    contact_name: row.contact_name,
    reference: row.reference,
    line_descriptions: row.line_descriptions,
    invoice_date: null,
    due_date: row.due_date,
    total: null,
    amount_due: row.amount_due,
    amount_paid: null,
    amount_credited: null,
  });
}

function fixtureJob(row: DebtBookFixtureRow): DebtBookJobContext {
  return {
    job_number: row.job_number,
    job_status: row.job_status,
    first_payment: row.job_first_payment,
    link_source: row.job_number ? "copy_job_id" : null,
    desk_class: row.copy_class,
  };
}

function fixtureBook() {
  return FIXTURE.map((row) => {
    const invoice = fixtureInvoice(row);
    return {
      invoice,
      classification: classifyDebtBookInvoice(invoice, fixtureJob(row), {
        perthDate: DEBT_BOOK_FIXTURE_PERTH_DATE,
      }),
    };
  });
}

const money = (n: number) => Math.round(n * 100) / 100;

// ── Acceptance: the 29 Sep book under the captain's final rulings (PLAN.md section 2) ──

Deno.test("acceptance: 29 Sep book gives 97 invoices / $89,049.43, 68 overdue / $57,903.22", () => {
  assertEquals(FIXTURE.length, 112);
  const s = summariseDebtBook(fixtureBook());
  assertEquals(s.open_in_xero, { count: 112, amount: 111526.08 });
  assertEquals({ count: s.debt.count, amount: s.debt.amount }, {
    count: 97,
    amount: 89049.43,
  });
  assertEquals({ count: s.debt.overdue_count, amount: s.debt.overdue_amount }, {
    count: 68,
    amount: 57903.22,
  });
  assertEquals({ count: s.not_debt.count, amount: s.not_debt.amount }, {
    count: 15,
    amount: 22476.65,
  });
  assertEquals(s.debt.no_due_date, { count: 0, amount: 0 });
});

Deno.test("acceptance: debt by payer matches PLAN.md section 2", () => {
  const s = summariseDebtBook(fixtureBook());
  const table = Object.fromEntries(
    s.by_payer.map((
      r,
    ) => [r.payer, {
      count: r.count,
      amount: r.amount,
      overdue: r.overdue_amount,
    }]),
  );
  assertEquals(table, {
    client: { count: 21, amount: 38811.99, overdue: 22471.78 },
    mlb: { count: 63, amount: 43316.90, overdue: 29122.50 },
    aj: { count: 5, amount: 2146.10, overdue: 1534.50 },
    other_builder: { count: 8, amount: 4774.44, overdue: 4774.44 },
  });
  assertEquals(s.by_payer.map((r) => r.payer), [
    "client",
    "mlb",
    "aj",
    "other_builder",
  ]);
});

Deno.test("acceptance: debt by age (Perth date) matches PLAN.md section 2", () => {
  const s = summariseDebtBook(fixtureBook());
  const amounts = (bucket: string) => {
    const row = s.by_age.find((r) => r.bucket === bucket)!;
    return [
      row.by_payer.client.amount,
      row.by_payer.mlb.amount,
      row.by_payer.aj.amount,
      row.by_payer.other_builder.amount,
      row.all.amount,
    ];
  };
  assertEquals(s.by_age.map((r) => r.bucket), [
    "not_due",
    "1_30",
    "31_60",
    "61_90",
    "90_plus",
    "no_due_date",
  ]);
  assertEquals(amounts("not_due"), [16340.21, 14194.40, 611.60, 0, 31146.21]);
  assertEquals(amounts("1_30"), [10839.68, 26391.20, 528.00, 0, 37758.88]);
  assertEquals(amounts("31_60"), [3497.24, 1332.10, 0, 0, 4829.34]);
  assertEquals(amounts("61_90"), [4740.68, 838.20, 0, 0, 5578.88]);
  assertEquals(amounts("90_plus"), [
    3394.18,
    561.00,
    1006.50,
    4774.44,
    9736.12,
  ]);
  assertEquals(amounts("no_due_date"), [0, 0, 0, 0, 0]);
});

Deno.test("acceptance: the 15 not-debt invoices split as PLAN.md section 2 says", () => {
  const s = summariseDebtBook(fixtureBook());
  const by = s.not_debt.by_reason;
  assertEquals({ count: by.deposit.count, amount: by.deposit.amount }, {
    count: 10,
    amount: 19662.15,
  });
  assertEquals(
    by.deposit.invoices.sort(),
    [
      "INV-0560",
      "INV-1010",
      "INV-1011",
      "INV-1119",
      "INV-1374",
      "INV-1477",
      "INV-1571",
      "INV-1597",
      "INV-1601",
      "INV-1602",
      "INV-1603",
    ].filter((n) => n !== "INV-1011"),
  );
  assertEquals({
    count: by.not_chased.count,
    amount: by.not_chased.amount,
    invoices: by.not_chased.invoices.sort(),
  }, { count: 2, amount: 610.50, invoices: ["INV-1050", "INV-1391"] });
  assertEquals({
    count: by.test_invoice.count,
    amount: by.test_invoice.amount,
    invoices: by.test_invoice.invoices,
  }, { count: 1, amount: 352, invoices: ["INV-1240"] });
  assertEquals({
    count: by.left_aside.count,
    amount: by.left_aside.amount,
    invoices: by.left_aside.invoices.sort(),
  }, { count: 2, amount: 1852, invoices: ["INV-0177", "INV-1486"] });
  for (
    const empty of [
      "before_first_payment",
      "plan_fee",
      "unclear",
      "out_of_scope",
    ] as const
  ) assertEquals(by[empty].count, 0, empty);
});

Deno.test("acceptance: holds keep invoices in the figure; named check-first list is 8 / $4,169.44, fix-first is 5 / $6,923.62", () => {
  const book = fixtureBook();
  const named = book.filter((r) =>
    r.classification.hold?.reasons.some((x) => x.code === "named_doubt")
  );
  assertEquals(named.map((r) => r.invoice.invoice_number).sort(), [
    "INV-0080",
    "INV-0597",
    "INV-0702",
    "INV-0938",
    "INV-1424",
    "INV-1456",
    "INV-1481",
    "INV-1829",
  ]);
  assertEquals(
    money(named.reduce((a, r) => a + r.invoice.amount_due, 0)),
    4169.44,
  );
  assert(
    named.every((r) =>
      r.classification.counts_as_debt &&
      r.classification.hold?.kind === "check_first"
    ),
  );

  const fix = book.filter((r) => r.classification.hold?.kind === "fix_first");
  assertEquals(fix.map((r) => r.invoice.invoice_number).sort(), [
    "INV-0894",
    "INV-1011",
    "INV-1236",
    "INV-1237",
    "INV-1332",
  ]);
  assertEquals(
    money(fix.reduce((a, r) => a + r.invoice.amount_due, 0)),
    6923.62,
  );

  // The five finals the desk classed "blocked by us" outside rectification: check first, $6,703.75.
  const blockedFinals = book.filter((r) =>
    r.classification.kind === "final" &&
    r.classification.hold?.kind === "check_first"
  );
  assertEquals(blockedFinals.map((r) => r.invoice.invoice_number).sort(), [
    "INV-0524",
    "INV-0937",
    "INV-1190",
    "INV-1191",
    "INV-1483",
  ]);
  assertEquals(
    money(blockedFinals.reduce((a, r) => a + r.invoice.amount_due, 0)),
    6703.75,
  );

  const s = summariseDebtBook(book);
  assertEquals(s.holds.fix_first.count, 5);
  assertEquals(s.holds.fix_first.amount, 6923.62);
  assertEquals(
    s.holds.check_first.count + s.holds.fix_first.count +
      s.debt.chaseable_count,
    s.debt.count,
  );
});

Deno.test("acceptance: first morning-list homeowner finals are the 4 due 29 Sep plus 4 overdue unheld finals", () => {
  const s = summariseDebtBook(fixtureBook());
  const finals = fixtureBook().filter((r) =>
    r.classification.kind === "final" && !r.classification.hold &&
    !r.classification.start_step
  );
  assertEquals(finals.map((r) => r.invoice.invoice_number).sort(), [
    "INV-0290",
    "INV-1069",
    "INV-1435",
    "INV-1578",
    "INV-1606",
    "INV-1607",
    "INV-1608",
    "INV-1609",
  ]);
  assertEquals(
    money(finals.reduce((a, r) => a + r.invoice.amount_due, 0)),
    23379.94,
  );
  assert(s.debt.chaseable_count > 0);
});

Deno.test('acceptance: the two old "50% of quote" invoices start at the Jan step', () => {
  const book = fixtureBook();
  const jan = book.filter((r) => r.classification.start_step === "jan").map((
    r,
  ) => r.invoice.invoice_number).sort();
  assertEquals(jan, ["INV-0034", "INV-0267"]);
  for (const r of book.filter((x) => jan.includes(x.invoice.invoice_number))) {
    assert(r.classification.counts_as_debt);
  }
});

Deno.test("acceptance: every invoice carries a reason, and client kinds agree with the baseline reading", () => {
  const baselineKind: Record<string, string> = {
    final: "final",
    deposit: "deposit",
    "progress claim": "progress_claim",
    variation: "variation",
  };
  for (const { invoice, classification } of fixtureBook()) {
    assert(classification.reasons.length >= 3, invoice.invoice_number);
    assert(
      classification.reasons.every((r) =>
        typeof r === "string" && r.length > 0
      ),
    );
    const row = FIXTURE.find((r) =>
      r.invoice_number === invoice.invoice_number
    )!;
    if (classification.corrections.length) continue;
    if (row.baseline_class.startsWith("builder")) {
      assertEquals(
        classification.kind,
        row.baseline_class.includes("test") ? "test" : "builder",
        invoice.invoice_number,
      );
    } else if (baselineKind[row.baseline_class]) {
      assertEquals(
        classification.kind,
        baselineKind[row.baseline_class],
        invoice.invoice_number,
      );
    }
  }
});

Deno.test("acceptance: overdue days agree with the baseline reading for every invoice", () => {
  for (const { invoice, classification } of fixtureBook()) {
    const row = FIXTURE.find((r) =>
      r.invoice_number === invoice.invoice_number
    )!;
    assertEquals(
      Math.max(0, classification.days_overdue ?? 0),
      row.baseline_days_over,
      invoice.invoice_number,
    );
  }
});

Deno.test("acceptance: copy-vs-Xero diff finds the six rows the copy marks DELETED ($3,583.48)", () => {
  const book = fixtureBook();
  const copy = FIXTURE.map((row) => ({
    xero_invoice_id: debtBookFixtureInvoiceId(row.invoice_number),
    invoice_number: row.invoice_number,
    status: row.copy_status,
    amount_due: row.copy_status === "DELETED" ? 0 : row.amount_due,
    due_date: row.due_date,
    synced_at: "2026-09-29T07:19:39.000Z",
  }));
  const diff = diffDebtBookCopy(book.map((r) => r.invoice), copy, {
    readAt: DEBT_BOOK_FIXTURE_READ_AT,
  });
  assertEquals(diff.xero_open, { count: 112, amount: 111526.08 });
  assertEquals(diff.copy_open, { count: 106, amount: 107942.60 });
  assertEquals(diff.matches, false);
  assertEquals(diff.differing_count, 6);
  assertEquals(diff.differing_amount, 3583.48);
  assertEquals(diff.copy_not_open.map((r) => r.invoice_number).sort(), [
    "INV-0034",
    "INV-0080",
    "INV-0177",
    "INV-0352",
    "INV-0704",
    "INV-0938",
  ]);
  assert(diff.copy_not_open.every((r) => r.copy_status === "DELETED"));
  assertEquals(diff.missing_from_copy, []);
  assertEquals(diff.copy_open_not_in_xero, []);
  assertEquals(diff.amount_differs, []);
  assertEquals(diff.due_date_differs, []);
  assertEquals(diff.stamp, "Differs by $3,583.48 on 6 invoices");
});

// ── Rule 1: scope ──

Deno.test("scope: only AUTHORISED ACCREC with AmountDue > 0 is in the book", () => {
  for (
    const extra of [
      { status: "DRAFT" },
      { status: "PAID" },
      { status: "SUBMITTED" },
      { type: "ACCPAY" },
      { amount_due: 0 },
      { amount_due: -5 },
    ]
  ) {
    const c = classify(extra);
    assertEquals(c.in_scope, false, JSON.stringify(extra));
    assertEquals(c.counts_as_debt, false);
    assertEquals(c.not_debt_reason, "out_of_scope");
  }
  const s = summariseDebtBook([{
    invoice: inv({ status: "PAID" }),
    classification: classify({ status: "PAID" }),
  }]);
  assertEquals(s.open_in_xero.count, 0);
  assertEquals(s.not_debt.by_reason.out_of_scope.count, 1);
});

// ── Rule 2: payer, as a data table ──

Deno.test("payer: MLB is the Major Loss Builders contact only; ML Builders is listed apart and never chased", () => {
  assertEquals(resolvePayer("Major Loss Builders").key, "mlb");
  assertEquals(resolvePayer("  major loss   builders ").key, "mlb");
  const ml = classify({
    contact_name: "ML Builders",
    reference: "MLB-27129PO-56730",
  });
  assertEquals(ml.payer.key, "not_chased");
  assertEquals(ml.counts_as_debt, false);
  assertEquals(ml.not_debt_reason, "not_chased");
  assertEquals(ml.hold, null);
});

Deno.test("payer: AJ has two contacts, other builders are ETS, both Builderwest contacts and Western Building, everyone else is a client", () => {
  assertEquals(resolvePayer("AJ Building & Restoration").key, "aj");
  assertEquals(
    resolvePayer("Insurebuild Pty Ltd WA (AJ Building & Restoration)").key,
    "aj",
  );
  for (
    const n of [
      "Emergency Trade Services",
      "Builderwest Pty Ltd",
      "Builderwest Pty Ltd ATF Builderwest Unit Trust",
      "Western Building Pty Ltd",
    ]
  ) {
    assertEquals(resolvePayer(n).key, "other_builder", n);
  }
  for (
    const n of [
      "Perth Zoo",
      "Foundation Housing",
      "Major Loss Builders Pty",
      "",
    ]
  ) assertEquals(resolvePayer(n).key, "client", n);
});

Deno.test("payer: the table is data, one entry per contact, each naming the ruling it came from", () => {
  const names = DEBT_BOOK_PAYERS.map((p) => p.contact_name.toLowerCase());
  assertEquals(new Set(names).size, names.length);
  assert(DEBT_BOOK_PAYERS.every((p) => p.decision.length > 0));
});

// ── Rule 3: builder invoices ──

Deno.test("builder: every builder invoice is debt except SAMPLE- test invoices", () => {
  const b = classify({
    contact_name: "Major Loss Builders",
    reference: "MLB-1PO-2",
  }, { job_status: "processing", first_payment: null });
  assertEquals(b.kind, "builder");
  assertEquals(b.builder_work, "make_safe");
  assertEquals(b.counts_as_debt, true);
  const t = classify({
    contact_name: "AJ Building & Restoration",
    reference: "SAMPLE-AJS-WALK-1",
  });
  assertEquals(t.kind, "test");
  assertEquals(t.counts_as_debt, false);
  assertEquals(t.not_debt_reason, "test_invoice");
});

Deno.test("builder: work type comes from the line text (and reference): roof report, assessment report, repair, else make-safe", () => {
  const work = (lines: string[], reference = "MLB-1") =>
    classify({
      contact_name: "Major Loss Builders",
      reference,
      line_descriptions: lines,
    }).builder_work;
  assertEquals(work(["Roof report - single storey"]), "roof_report");
  assertEquals(work([], "MLB-25897 - Roof Report"), "roof_report");
  assertEquals(work(["Assessment report"]), "assessment_report");
  assertEquals(
    work(["Supply and install new polycarbonate roof sheets"]),
    "repair",
  );
  assertEquals(work(["Remove, dispose and replace fence panels"]), "repair");
  assertEquals(work(["Colorbond Fencing Installation"]), "repair");
  assertEquals(
    work(["Attendance - make safe", "Temporary fencing hire"]),
    "make_safe",
  );
  assertEquals(work([]), "make_safe");
});

// ── Rule 4: client invoices, first rule that matches wins ──

Deno.test("client: progress claim and materials invoices count only after the job has had its first payment", () => {
  for (
    const reference of [
      "SWP-26001-PROG",
      "SWP-26001-MAT",
      "MAT50",
      "SWP-26001-MAT50",
    ]
  ) {
    const paid = classify({ reference }, { first_payment: true });
    assertEquals(paid.counts_as_debt, true, reference);
    const unpaid = classify({ reference }, { first_payment: false });
    assertEquals(unpaid.counts_as_debt, false, reference);
    assertEquals(unpaid.not_debt_reason, "before_first_payment");
    const unknown = classify({ reference }, {
      first_payment: null,
      job_number: null,
      link_source: null,
    });
    assertEquals(unknown.counts_as_debt, false, reference);
    assertEquals(unknown.not_debt_reason, "before_first_payment");
    assert(unknown.reasons.some((r) => /first payment/i.test(r)));
  }
  assertEquals(
    classify({ reference: "SWP-26001-PROG" }).kind,
    "progress_claim",
  );
  assertEquals(classify({ reference: "SWP-26001-MAT" }).kind, "materials");
});

Deno.test('client: variations are debt, by VAR or the "Extra Labour and Material" line with no reference', () => {
  assertEquals(classify({ reference: "SWF-26001-VAR" }).kind, "variation");
  assertEquals(classify({ reference: "SWF-26001-VAR2" }).counts_as_debt, true);
  const line = classify({
    reference: "",
    line_descriptions: ["Extra Labour and Material"],
  }, { job_status: "cancelled" });
  assertEquals(line.kind, "variation");
  assertEquals(line.counts_as_debt, true);
  assertEquals(line.hold, null);
});

Deno.test('client: deposits are never debt, by DEP token or a line starting "Deposit"', () => {
  for (
    const reference of [
      "SWF-26001-DEP50",
      "JOB-DEP",
      "DEP50",
      "SWP-26992-DEP20",
    ]
  ) {
    const c = classify({ reference });
    assertEquals(c.kind, "deposit", reference);
    assertEquals(c.counts_as_debt, false);
    assertEquals(c.not_debt_reason, "deposit");
  }
  assertEquals(
    classify({
      reference: "",
      line_descriptions: ["Deposit 50% of quote QT-1"],
    }).kind,
    "deposit",
  );
  // DEPOT is not a DEP token.
  assertEquals(
    classify({ reference: "DEPOT-1", line_descriptions: [] }).kind,
    "unclear",
  );
});

Deno.test('client: finals by FINBAL, FINAL, -BAL, PRIVATE or a "Balance" / "Remaining quote amount" line', () => {
  for (
    const reference of [
      "SWF-1-FINBAL",
      "SWF-1-FINBAL50",
      "SWF-1-FINAL",
      "SWF-26624-B-BAL",
      "PRIVATE [client]",
    ]
  ) {
    const c = classify({ reference });
    assertEquals(c.kind, "final", reference);
    assertEquals(c.counts_as_debt, true);
  }
  assertEquals(
    classify({
      reference: "F-FD-R",
      line_descriptions: ["Remaining quote amount"],
    }).kind,
    "final",
  );
  assertEquals(
    classify({ reference: "", line_descriptions: ["Balance of quote QT-1"] })
      .kind,
    "final",
  );
});

Deno.test('client: planning fees, "N% of quote" lines and unrecognised invoices are not debt by default', () => {
  const plan = classify({
    reference: "SWP-261377-PLAN",
    invoice_number: "INV-9002",
  });
  assertEquals(plan.kind, "plan_fee");
  assertEquals(plan.not_debt_reason, "plan_fee");
  const pct = classify({
    reference: "",
    line_descriptions: ["50% of quote QT-2231"],
  });
  assertEquals(pct.kind, "unclear");
  assertEquals(pct.counts_as_debt, false);
  assertEquals(pct.not_debt_reason, "unclear");
  const none = classify({ reference: "F-FD-Q1", line_descriptions: [] });
  assertEquals(none.kind, "unclear");
  assertEquals(none.counts_as_debt, false);
});

Deno.test("client: the first matching rule wins (PROG before DEP before FINBAL)", () => {
  assertEquals(
    classify({ reference: "SWP-1-PROG", line_descriptions: ["Deposit"] }).kind,
    "progress_claim",
  );
  assertEquals(classify({ reference: "SWP-1-DEP-FINBAL" }).kind, "deposit");
  assertEquals(
    classify({ reference: "SWP-1-VAR", line_descriptions: ["Balance"] }).kind,
    "variation",
  );
});

// ── Corrections: the captain's named rulings, each with its reason and decision ──

Deno.test("corrections: INV-1011 is a part payment (debt), INV-1477 is a deposit whatever its label", () => {
  const pp = classify({
    invoice_number: "INV-1011",
    reference: "SWP-26354-DEP25",
  }, { job_status: "rectification" });
  assertEquals(pp.kind, "part_payment");
  assertEquals(pp.counts_as_debt, true);
  assertEquals(pp.corrections.map((c) => c.invoice_number), ["INV-1011"]);
  assertEquals(pp.hold?.kind, "fix_first");
  const zoo = classify({
    invoice_number: "INV-1477",
    reference: "SWP-261247-PROG",
  }, { first_payment: true });
  assertEquals(zoo.kind, "deposit");
  assertEquals(zoo.counts_as_debt, false);
  assert(zoo.reasons.some((r) => r.includes("round 4")));
});

Deno.test("corrections: INV-0177 and INV-1486 are left aside, INV-0034 and INV-0267 are debt from the Jan step", () => {
  for (const n of ["INV-0177", "INV-1486"]) {
    const c = classify({ invoice_number: n, reference: "" });
    assertEquals(c.counts_as_debt, false, n);
    assertEquals(c.not_debt_reason, "left_aside");
  }
  for (const n of ["INV-0034", "INV-0267"]) {
    const c = classify({ invoice_number: n, reference: "" }, {
      job_status: "complete",
    });
    assertEquals(c.counts_as_debt, true, n);
    assertEquals(c.start_step, "jan");
  }
});

Deno.test("corrections: every entry names its reason and the decision it came from", () => {
  assert(DEBT_BOOK_CORRECTIONS.length >= 6);
  for (const c of DEBT_BOOK_CORRECTIONS) {
    assert(/^INV-\d+$/.test(c.invoice_number));
    assert(c.reason.length > 10 && c.decision.length > 3, c.invoice_number);
  }
  for (const c of DEBT_BOOK_CHECK_FIRST) {
    assert(c.reason.length > 10 && c.decision.length > 3, c.invoice_number);
  }
});

Deno.test("corrections match the invoice number exactly, not a prefix", () => {
  const c = classify({ invoice_number: "INV-10110", reference: "SWP-1-DEP25" });
  assertEquals(c.kind, "deposit");
  assertEquals(c.corrections, []);
});

// ── Rule 5: finished job ──

Deno.test("finished job: a final on an unfinished or unlinked job is check first, not dropped", () => {
  for (const status of ["complete", "invoiced", "final_payment", "archived"]) {
    const c = classify({}, { job_status: status });
    assertEquals(c.hold, null, status);
  }
  const unfinished = classify({}, { job_status: "scheduled" });
  assertEquals(unfinished.counts_as_debt, true);
  assertEquals(unfinished.hold?.kind, "check_first");
  assertEquals(unfinished.hold?.reasons.map((r) => r.code), [
    "final_on_unfinished_job",
  ]);
  const unlinked = classify({}, {
    job_status: null,
    job_number: null,
    link_source: null,
  });
  assertEquals(unlinked.counts_as_debt, true);
  assertEquals(unlinked.hold?.kind, "check_first");
});

// ── Rule 6: overdue by Perth date ──

Deno.test("overdue uses the Perth calendar date and the due date itself is not overdue", () => {
  assertEquals(perthDate(new Date("2026-09-29T15:59:59Z")), "2026-09-29");
  assertEquals(perthDate(new Date("2026-09-29T16:00:00Z")), "2026-09-30");
  const today = classify({ due_date: "2026-09-29" });
  assertEquals(today.overdue, false);
  assertEquals(today.age_bucket, "not_due");
  const tomorrowUtcEvening = classify(
    { due_date: "2026-09-29" },
    {},
    perthDate(new Date("2026-09-29T17:00:00Z")),
  );
  assertEquals(tomorrowUtcEvening.overdue, true);
  assertEquals(tomorrowUtcEvening.days_overdue, 1);
});

Deno.test("age buckets: 1-30, 31-60, 61-90, 90+ with exact boundaries", () => {
  const bucket = (due: string) =>
    classify({ due_date: due }, {}, "2026-12-31").age_bucket;
  assertEquals(bucket("2026-12-30"), "1_30"); // 1
  assertEquals(bucket("2026-12-01"), "1_30"); // 30
  assertEquals(bucket("2026-11-30"), "31_60"); // 31
  assertEquals(bucket("2026-11-01"), "31_60"); // 60
  assertEquals(bucket("2026-10-31"), "61_90"); // 61
  assertEquals(bucket("2026-10-02"), "61_90"); // 90
  assertEquals(bucket("2026-10-01"), "90_plus"); // 91
});

Deno.test('no due date is its own bucket: never "not due", never 90+, never overdue', () => {
  const c = classify({ due_date: null });
  assertEquals(c.age_bucket, "no_due_date");
  assertEquals(c.overdue, false);
  assertEquals(c.days_overdue, null);
  const s = summariseDebtBook([{
    invoice: inv({ due_date: null }),
    classification: c,
  }]);
  assertEquals(s.debt.no_due_date, { count: 1, amount: 1000 });
  assertEquals(s.debt.overdue_count, 0);
});

// ── Rule 7: holds ──

Deno.test("holds: desk classes in_dispute / not_owed / blocked_by_us / bad_debt are check first; rectification is fix first", () => {
  for (const desk of ["in_dispute", "not_owed", "blocked_by_us", "bad_debt"]) {
    const c = classify({}, { desk_class: desk });
    assertEquals(c.counts_as_debt, true, desk);
    assertEquals(c.hold?.kind, "check_first");
  }
  assertEquals(classify({}, { desk_class: "genuine_debt" }).hold, null);
  assertEquals(
    classify({}, { desk_class: "bad_debt" }).hold?.reasons[0].reason,
    "the Clear Debt desk marks it bad debt",
  );
  const rect = classify({}, {
    job_status: "rectification",
    desk_class: "blocked_by_us",
  });
  assertEquals(rect.hold?.kind, "fix_first");
  assertEquals(rect.hold?.reasons.map((r) => r.code).sort(), [
    "desk_class",
    "rectification",
  ]);
});

Deno.test("holds: a named doubt outranks fix first; not-debt invoices carry no hold", () => {
  const named = classify({
    invoice_number: "INV-0080",
    reference: "",
    line_descriptions: ["Extra Labour and Material"],
  }, { job_status: "rectification" });
  assertEquals(named.hold?.kind, "check_first");
  const dep = classify({ reference: "SWF-1-DEP50" }, {
    desk_class: "blocked_by_us",
  });
  assertEquals(dep.hold, null);
});

Deno.test("summary: overdue chaseable excludes holds; overdue includes them", () => {
  const rows = [
    {
      invoice: inv({ invoice_number: "INV-1", amount_due: 100 }),
      classification: classify({ invoice_number: "INV-1", amount_due: 100 }),
    },
    {
      invoice: inv({ invoice_number: "INV-2", amount_due: 50 }),
      classification: classify({ invoice_number: "INV-2", amount_due: 50 }, {
        job_status: "rectification",
      }),
    },
  ];
  const s = summariseDebtBook(rows);
  assertEquals([s.debt.overdue_count, s.debt.overdue_amount], [2, 150]);
  assertEquals([
    s.debt.overdue_chaseable_count,
    s.debt.overdue_chaseable_amount,
  ], [1, 100]);
});

// ── Xero normalisation (server-side trim) ──

Deno.test("normalise: reads DueDateString, falls back to /Date()/, trims line items server-side", () => {
  const long = "x".repeat(500);
  const n = normaliseXeroInvoice({
    InvoiceID: "AAAAAAAA-0000-4000-8000-000000000001",
    InvoiceNumber: "INV-1",
    Type: "ACCREC",
    Status: "AUTHORISED",
    Contact: {
      ContactID: "c",
      Name: " Major Loss Builders ",
      Addresses: [{ big: true }],
    },
    Reference: "MLB-1",
    DateString: "2026-09-01T00:00:00",
    DueDateString: "2026-09-15T00:00:00",
    Total: 110,
    AmountDue: 110,
    AmountPaid: 0,
    AmountCredited: 0,
    LineItems: Array.from(
      { length: 12 },
      (_, i) => ({
        Description: i === 0 ? long : `line ${i}`,
        Tracking: [{ big: true }],
      }),
    ),
  });
  assertEquals(n.xero_invoice_id, "aaaaaaaa-0000-4000-8000-000000000001");
  assertEquals(n.contact_name, "Major Loss Builders");
  assertEquals(n.due_date, "2026-09-15");
  assertEquals(n.invoice_date, "2026-09-01");
  assertEquals(n.line_descriptions.length, 5);
  assertEquals(n.line_descriptions[0].length, 200);
  assertEquals(n.line_count, 12);
  const d = normaliseXeroInvoice({
    InvoiceID: "b",
    Type: "ACCREC",
    Status: "AUTHORISED",
    AmountDue: 1,
    DueDate: "/Date(1790640000000+0000)/",
    Date: "/Date(1788134400000+0000)/",
  });
  assertEquals(d.due_date, "2026-09-29");
  assertEquals(d.invoice_date, "2026-08-31");
  assertEquals(
    normaliseXeroInvoice({ InvoiceID: "c", AmountDue: 1 }).due_date,
    null,
  );
});

// ── Copy diff ──

Deno.test('copy diff: matching copy stamps "Matches Xero, read HH:MM" in Perth time', () => {
  const x = inv();
  const d = diffDebtBookCopy([x], [{
    xero_invoice_id: x.xero_invoice_id,
    invoice_number: x.invoice_number,
    status: "AUTHORISED",
    amount_due: 1000,
    due_date: x.due_date,
    synced_at: null,
  }], { readAt: "2026-09-29T23:05:00Z" });
  assertEquals(d.matches, true);
  assertEquals(d.stamp, "Matches Xero, read 07:05");
});

Deno.test("copy diff: reports missing rows, stale open rows, amount and due-date differences", () => {
  const a = inv({
    xero_invoice_id: "a",
    invoice_number: "INV-A",
    amount_due: 100,
  });
  const b = inv({
    xero_invoice_id: "b",
    invoice_number: "INV-B",
    amount_due: 200,
    due_date: "2026-09-01",
  });
  const c = inv({
    xero_invoice_id: "c",
    invoice_number: "INV-C",
    amount_due: 300,
  });
  const copy = [
    {
      xero_invoice_id: "b",
      invoice_number: "INV-B",
      status: "AUTHORISED",
      amount_due: 150,
      due_date: "2026-09-02",
      synced_at: null,
    },
    {
      xero_invoice_id: "c",
      invoice_number: "INV-C",
      status: "AUTHORISED",
      amount_due: 300,
      due_date: c.due_date,
      synced_at: null,
    },
    {
      xero_invoice_id: "d",
      invoice_number: "INV-D",
      status: "AUTHORISED",
      amount_due: 40,
      due_date: null,
      synced_at: null,
    },
  ];
  const d = diffDebtBookCopy([a, b, c], copy, {
    readAt: "2026-09-29T00:00:00Z",
  });
  assertEquals(d.missing_from_copy.map((r) => r.invoice_number), ["INV-A"]);
  assertEquals(
    d.amount_differs.map((
      r,
    ) => [r.invoice_number, r.xero_amount_due, r.copy_amount_due]),
    [["INV-B", 200, 150]],
  );
  assertEquals(d.due_date_differs.map((r) => r.invoice_number), ["INV-B"]);
  assertEquals(d.copy_open_not_in_xero.map((r) => r.invoice_number), ["INV-D"]);
  assertEquals(d.differing_count, 3);
  assertEquals(d.differing_amount, 190); // 100 missing + 50 short + 40 stale
  assertEquals(d.stamp, "Differs by $190.00 on 3 invoices");
});
