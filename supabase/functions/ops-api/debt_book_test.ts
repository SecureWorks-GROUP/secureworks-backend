// deno-lint-ignore-file no-import-prefix no-explicit-any
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  createSupabaseDebtBookStore,
  type DebtBookCopyRecord,
  type DebtBookDeps,
  DebtBookError,
  type DebtBookJobRecord,
  type DebtBookStore,
  logDebtDeskFailure,
  readDebtBook,
} from "./debt_book.ts";
import {
  DEBT_BOOK_FIXTURE_2026_09_29 as FIXTURE,
  DEBT_BOOK_FIXTURE_READ_AT,
  debtBookFixtureInvoiceId,
} from "./debt_book_fixture_2026_09_29.ts";

const TENANT = "10000000-0000-4000-8000-000000000001";
const ORG = "00000000-0000-0000-0000-000000000001";
const META = {
  shared_cooldown: null,
  request_id: null,
  quota: {
    minute_remaining: "58",
    day_remaining: "2167",
    app_minute_remaining: null,
    limit_problem: null,
  },
};

function rawInvoice(n: number, extra: Record<string, unknown> = {}) {
  return {
    InvoiceID: `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    InvoiceNumber: `INV-${n}`,
    Type: "ACCREC",
    Status: "AUTHORISED",
    Contact: {
      ContactID: "30000000-0000-4000-8000-000000000001",
      Name: "Major Loss Builders",
    },
    Reference: `MLB-${n}`,
    DueDateString: "2026-09-20T00:00:00",
    Total: 100,
    AmountDue: 100,
    AmountPaid: 0,
    AmountCredited: 0,
    LineItems: [{ Description: "Attendance - make safe" }],
    ...extra,
  };
}

/** Fake Xero: answers each page from `pages` (1-based) and records every request. */
function xero(pages: (page: number) => unknown[]) {
  const calls: Array<
    { path: string; params: Record<string, string> | undefined }
  > = [];
  const deps = {
    getToken: () =>
      Promise.resolve({ accessToken: "fixture-only-token", tenantId: TENANT }),
    xeroGet: (
      path: string,
      _token: string,
      _tenant: string,
      params?: Record<string, string>,
    ) => {
      calls.push({ path, params });
      return Promise.resolve({
        data: { Invoices: pages(Number(params?.page)) },
        metadata: META,
      });
    },
    now: () => new Date(DEBT_BOOK_FIXTURE_READ_AT),
  };
  return { deps, calls };
}

function emptyStore(overrides: Partial<DebtBookStore> = {}): DebtBookStore {
  return {
    copyRowsByXeroIds: () => Promise.resolve([]),
    openCopyRows: () => Promise.resolve([]),
    jobsByIds: () => Promise.resolve([]),
    jobsByNumbers: () => Promise.resolve([]),
    paidJobIds: () => Promise.resolve([]),
    ...overrides,
  };
}

function withStore(
  x: ReturnType<typeof xero>,
  store: DebtBookStore,
): DebtBookDeps {
  return { ...x.deps, store } as unknown as DebtBookDeps;
}

// ── The 29 Sep book, end to end through the action ──

function fixtureXeroPages() {
  const raws = FIXTURE.map((row) => ({
    InvoiceID: debtBookFixtureInvoiceId(row.invoice_number),
    InvoiceNumber: row.invoice_number,
    Type: "ACCREC",
    Status: "AUTHORISED",
    Contact: {
      ContactID: "30000000-0000-4000-8000-000000000009",
      Name: row.contact_name,
    },
    Reference: row.reference,
    DueDateString: `${row.due_date}T00:00:00`,
    AmountDue: row.amount_due,
    LineItems: row.line_descriptions.map((Description) => ({
      Description,
      Tracking: [{ Name: "Division" }],
    })),
  })).sort((a, b) => a.InvoiceID.localeCompare(b.InvoiceID));
  return (page: number) => raws.slice((page - 1) * 100, page * 100);
}

function fixtureStore(): DebtBookStore {
  const jobId = (n: string) => `job-${n}`;
  const copy: DebtBookCopyRecord[] = FIXTURE.map((row) => ({
    xero_invoice_id: debtBookFixtureInvoiceId(row.invoice_number),
    invoice_number: row.invoice_number,
    status: row.copy_status,
    amount_due: row.copy_status === "DELETED" ? 0 : row.amount_due,
    due_date: row.due_date,
    synced_at: "2026-09-29T07:19:39.000Z",
    job_id: row.job_status ? jobId(row.invoice_number) : null,
    debt_classification: row.copy_class,
  }));
  const jobs: DebtBookJobRecord[] = FIXTURE.filter((r) => r.job_status).map((
    row,
  ) => ({
    id: jobId(row.invoice_number),
    job_number: row.job_number,
    status: row.job_status,
    deposit_at: null,
  }));
  return emptyStore({
    copyRowsByXeroIds: (ids) =>
      Promise.resolve(copy.filter((r) => ids.includes(r.xero_invoice_id))),
    openCopyRows: () =>
      Promise.resolve(
        copy.filter((r) =>
          r.status === "AUTHORISED" && Number(r.amount_due) > 0
        ),
      ),
    jobsByIds: (ids) => Promise.resolve(jobs.filter((j) => ids.includes(j.id))),
  });
}

Deno.test("debt_book reads the 29 Sep book live from two Xero pages and gives the captain's figures", async () => {
  const x = xero(fixtureXeroPages());
  const book = await readDebtBook(
    {},
    new URLSearchParams({ action: "debt_book" }),
    withStore(x, fixtureStore()),
  );
  assertEquals(x.calls.map((c) => c.params?.page), ["1", "2", "1"]);
  assertEquals(
    [book.read_stable, book.read_warning, book.source.read_attempts],
    [true, null, 1],
  );
  assertEquals(x.calls[0].path, "/Invoices");
  assertEquals(
    x.calls[0].params?.where,
    'Type=="ACCREC" AND Status=="AUTHORISED" AND AmountDue>0',
  );
  assertEquals(x.calls[0].params?.pageSize, "100");
  assertEquals(book.version, "debt-book/v1");
  assertEquals(book.read_at, "2026-09-29T15:19:40+08:00");
  assertEquals(book.perth_date, "2026-09-29");
  assertEquals(book.source.invoice_count, 112);
  assertEquals(book.source.pages.length, 2);
  assertEquals(book.source.cache_used, false);
  assertEquals(book.summary.open_in_xero, { count: 112, amount: 111526.08 });
  assertEquals([book.summary.debt.count, book.summary.debt.amount], [
    97,
    89049.43,
  ]);
  assertEquals([
    book.summary.debt.overdue_count,
    book.summary.debt.overdue_amount,
  ], [68, 57903.22]);
  assertEquals({
    matches: book.copy_check.matches,
    differs_by: book.copy_check.differs_by,
    invoice_count: book.copy_check.invoice_count,
  }, { matches: false, differs_by: 3583.48, invoice_count: 6 });
  assertEquals(book.copy_check.stamp, "Differs by $3,583.48 on 6 invoices");

  // The screen sums its header from invoices[]; the same figures must come out.
  const debt = book.invoices.filter((i) => i.is_debt);
  assertEquals(debt.length, 97);
  assertEquals(
    Math.round(debt.reduce((a, i) => a + i.amount_due, 0) * 100) / 100,
    89049.43,
  );
  const bigOverdue = debt.filter((i) =>
    i.due_date && i.due_date < book.perth_date && !i.hold
  );
  assertEquals(bigOverdue.length, book.summary.debt.overdue_chaseable_count);
});

Deno.test("debt_book invoices carry the screen contract fields", async () => {
  const book = await readDebtBook(
    {},
    {},
    withStore(xero(fixtureXeroPages()), fixtureStore()),
  );
  const zoo = book.invoices.find((i) => i.invoice_number === "INV-1477")!;
  for (
    const key of [
      "xero_invoice_id",
      "invoice_number",
      "reference",
      "contact_id",
      "contact_name",
      "payer",
      "kind",
      "is_debt",
      "reason",
      "hold",
      "hold_reason",
      "invoice_date",
      "due_date",
      "total",
      "amount_due",
      "job_id",
      "job_number",
      "job_status",
    ]
  ) {
    assert(key in zoo, key);
  }
  assertEquals([zoo.payer, zoo.kind, zoo.is_debt, zoo.hold], [
    "client",
    "deposit",
    false,
    null,
  ]);
  assert(zoo.reason.startsWith("Not debt"));
  const ml = book.invoices.find((i) => i.invoice_number === "INV-1050")!;
  assertEquals([ml.payer, ml.is_debt], ["not_chased", false]);
  const bw = book.invoices.find((i) => i.invoice_number === "INV-0597")!;
  assertEquals([bw.payer, bw.is_debt, bw.hold], [
    "other_builder",
    true,
    "check_first",
  ]);
  assert(bw.hold_reason!.includes("Builderwest rejected"));
  const rect = book.invoices.find((i) => i.invoice_number === "INV-1236")!;
  assertEquals([rect.hold, rect.job_status], ["fix_first", "rectification"]);
  for (const i of book.invoices) {
    assert(
      ["client", "mlb", "aj", "other_builder", "not_chased"].includes(i.payer),
      i.invoice_number,
    );
    assert(
      [
        "final",
        "variation",
        "part_payment",
        "progress_claim",
        "materials",
        "builder",
        "deposit",
        "plan_fee",
        "unclear",
        "test",
      ].includes(i.kind),
      i.invoice_number,
    );
    assert(i.reason.length > 0 && i.reasons.length >= 3);
  }
});

// ── Traversal: stop on end of results, de-duplicate by InvoiceID, trim ──

Deno.test("debt_book follows full pages until Xero shows the end, and de-duplicates by InvoiceID", async () => {
  const page1 = Array.from({ length: 100 }, (_, i) => rawInvoice(i + 1));
  const page2 = [rawInvoice(100, { AmountDue: 120 }), rawInvoice(101)];
  const x = xero((p) => (p === 1 ? page1 : p === 2 ? page2 : []));
  const book = await readDebtBook({}, {}, withStore(x, emptyStore()));
  assertEquals(x.calls.length, 3);
  assertEquals(book.source.invoice_count, 101);
  assertEquals(book.source.duplicates_dropped, 1);
  // The later read of a duplicated invoice wins.
  assertEquals(
    book.invoices.find((i) => i.invoice_number === "INV-100")!.amount_due,
    120,
  );
});

Deno.test("debt_book reads one more page when the last page is exactly full, and stops on the empty one", async () => {
  const x = xero((
    p,
  ) => (p === 1
    ? Array.from({ length: 100 }, (_, i) => rawInvoice(i + 1))
    : [])
  );
  const book = await readDebtBook({}, {}, withStore(x, emptyStore()));
  assertEquals(x.calls.map((c) => c.params?.page), ["1", "2", "1"]);
  assertEquals(book.source.invoice_count, 100);
});

/** A live open book of invoices 1..`size`; `afterCall(n)` returns invoice numbers paid once the n-th read has answered. */
function liveBook(size: number, afterCall: (call: number) => number[]) {
  const paid = new Set<number>();
  let call = 0;
  return xero((page) => {
    const open = Array.from({ length: size }, (_, i) => i + 1).filter((n) =>
      !paid.has(n)
    );
    const answer = open.slice((page - 1) * 100, page * 100).map((n) =>
      rawInvoice(n)
    );
    for (const n of afterCall(++call)) paid.add(n);
    return answer;
  });
}

Deno.test("debt_book checks a stable two-page book with one extra page-1 read and does not flag it", async () => {
  const x = liveBook(102, () => []);
  const book = await readDebtBook({}, {}, withStore(x, emptyStore()));
  assertEquals(x.calls.map((c) => c.params?.page), ["1", "2", "1"]);
  assertEquals(
    [book.read_stable, book.read_warning, book.source.read_attempts],
    [true, null, 1],
  );
  assertEquals(book.source.invoice_count, 102);
});

Deno.test("debt_book re-reads the book once when an invoice on page 1 is paid mid-read, so the shifted invoice is not lost", async () => {
  // INV-5 is paid after page 1 is read: INV-101 moves up onto page 1 and the first pass never sees it.
  const x = liveBook(102, (call) => (call === 1 ? [5] : []));
  const book = await readDebtBook({}, {}, withStore(x, emptyStore()));
  assertEquals(x.calls.map((c) => c.params?.page), [
    "1",
    "2",
    "1",
    "1",
    "2",
    "1",
  ]);
  assertEquals(
    [book.read_stable, book.read_warning, book.source.read_attempts],
    [true, null, 2],
  );
  const numbers = book.invoices.map((i) => i.invoice_number);
  assert(numbers.includes("INV-101"));
  assertEquals(numbers.includes("INV-5"), false);
  assertEquals(book.source.invoice_count, 101);
});

Deno.test("debt_book flags, rather than hides or refuses, a book Xero keeps changing during both reads", async () => {
  // Every page-2 read is followed by a payment on page 1.
  let paidSoFar = 0;
  const x = liveBook(102, (call) => (call % 3 === 2 ? [++paidSoFar] : []));
  const book = await readDebtBook({}, {}, withStore(x, emptyStore()));
  assertEquals(x.calls.map((c) => c.params?.page), [
    "1",
    "2",
    "1",
    "1",
    "2",
    "1",
  ]);
  assertEquals(book.ok, true);
  assertEquals(
    [book.read_stable, book.read_warning, book.source.read_attempts],
    [false, "Xero changed during the read, retrying next run", 2],
  );
  assertEquals(book.source.invoice_count, 101);
});

Deno.test("debt_book refuses a book it could not read to the end", async () => {
  let n = 0;
  const x = xero(() => Array.from({ length: 100 }, () => rawInvoice(++n)));
  const error = await assertRejects(
    () => readDebtBook({}, {}, withStore(x, emptyStore())),
    DebtBookError,
  );
  assertEquals(error.code, "debt_book_traversal_incomplete");
  assertEquals(x.calls.length, 10);
});

Deno.test("debt_book trims line items server-side", async () => {
  const lines = Array.from(
    { length: 40 },
    (_, i) => ({
      Description: `Line ${i} ` + "x".repeat(900),
      Tracking: [{ Name: "Division", Option: "Roofing" }],
      ItemCode: "X",
    }),
  );
  const x = xero((
    p,
  ) => (p === 1
    ? [
      rawInvoice(1, {
        LineItems: lines,
        Payments: [{ big: "y".repeat(5000) }],
      }),
    ]
    : [])
  );
  const book = await readDebtBook({}, {}, withStore(x, emptyStore()));
  const i = book.invoices[0] as Record<string, unknown>;
  assertEquals((i.line_descriptions as string[]).length, 5);
  assert((i.line_descriptions as string[]).every((d) => d.length <= 200));
  assertEquals(i.line_count, 40);
  assertEquals("LineItems" in i || "Payments" in i, false);
  assert(JSON.stringify(book.invoices).length < 4000);
});

Deno.test("debt_book refuses unknown parameters", async () => {
  const error = await assertRejects(
    () =>
      readDebtBook(
        {},
        { action: "debt_book", live: "false" },
        withStore(xero(() => []), emptyStore()),
      ),
    DebtBookError,
  );
  assertEquals([error.status, error.code], [400, "debt_book_bad_request"]);
});

// ── Job links and first payment ──

Deno.test("debt_book links a job by the one job number in the reference when the copy has none; first payment from deposit_at or a PAID invoice", async () => {
  const client = (n: number, ref: string) =>
    rawInvoice(n, {
      Contact: {
        ContactID: "30000000-0000-4000-8000-000000000002",
        Name: "A Client",
      },
      Reference: ref,
    });
  const x = xero((
    p,
  ) => (p === 1
    ? [
      client(1, "SWP-26001-PROG"),
      client(2, "SWP-26002-PROG"),
      client(3, "SWP-26003-PROG"),
      client(4, "SWF-26004-FINBAL"),
    ]
    : [])
  );
  const jobs: DebtBookJobRecord[] = [
    {
      id: "j1",
      job_number: "SWP-26001",
      status: "processing",
      deposit_at: "2026-08-01T00:00:00Z",
    },
    {
      id: "j2",
      job_number: "SWP-26002",
      status: "processing",
      deposit_at: null,
    },
    {
      id: "j3",
      job_number: "SWP-26003",
      status: "processing",
      deposit_at: null,
    },
    {
      id: "j4a",
      job_number: "SWF-26004",
      status: "complete",
      deposit_at: null,
    },
    {
      id: "j4b",
      job_number: "SWF-26004",
      status: "complete",
      deposit_at: null,
    },
  ];
  const asked: string[][] = [];
  const store = emptyStore({
    jobsByNumbers: (numbers) => {
      asked.push([...numbers].sort());
      return Promise.resolve(
        jobs.filter((j) => numbers.includes(String(j.job_number))),
      );
    },
    paidJobIds: (ids) => Promise.resolve(ids.filter((id) => id === "j2")),
  });
  const book = await readDebtBook({}, {}, withStore(x, store));
  assertEquals(asked, [["SWF-26004", "SWP-26001", "SWP-26002", "SWP-26003"]]);
  const by = (n: string) => book.invoices.find((i) => i.invoice_number === n)!;
  assertEquals([by("INV-1").job_link, by("INV-1").is_debt], [
    "reference_job_number",
    true,
  ]); // deposit_at
  assertEquals([by("INV-2").job_first_payment, by("INV-2").is_debt], [
    true,
    true,
  ]); // PAID invoice
  assertEquals([
    by("INV-3").job_first_payment,
    by("INV-3").is_debt,
    by("INV-3").not_debt_reason,
  ], [false, false, "before_first_payment"]);
  // Two jobs share the number: no link is guessed, so the final is held "check first".
  assertEquals([by("INV-4").job_link, by("INV-4").is_debt, by("INV-4").hold], [
    null,
    true,
    "check_first",
  ]);
});

Deno.test("debt_book: any money received on the job is a first payment, live from Xero (the INV-1601..1603 pattern)", async () => {
  const client = (
    n: number,
    ref: string,
    extra: Record<string, unknown> = {},
  ) =>
    rawInvoice(n, {
      Contact: {
        ContactID: "30000000-0000-4000-8000-000000000003",
        Name: "A Client",
      },
      Reference: ref,
      ...extra,
    });
  const x = xero((
    p,
  ) => (p === 1
    ? [
      // A deposit raised late to match a bank transfer: still AUTHORISED, nothing paid on it.
      client(7001, "SWP-26010-DEP"),
      // A materials invoice already part-paid in Xero.
      client(7002, "SWP-26010-MAT50", {
        Total: 500,
        AmountDue: 300,
        AmountPaid: 200,
      }),
      // A job whose part-paid deposit is the only money: its materials invoice is debt too.
      client(7003, "SWP-26011-DEP", { AmountDue: 50, AmountPaid: 50 }),
      client(7004, "SWP-26011-MAT50"),
      // No money anywhere on this job: before the first payment.
      client(7005, "SWP-26012-MAT50"),
    ]
    : [])
  );
  const jobs: DebtBookJobRecord[] = ["SWP-26010", "SWP-26011", "SWP-26012"]
    .map((job_number) => ({
      id: `j-${job_number}`,
      job_number,
      status: "processing",
      deposit_at: null,
    }));
  const store = emptyStore({
    jobsByNumbers: (numbers) =>
      Promise.resolve(
        jobs.filter((j) => numbers.includes(String(j.job_number))),
      ),
  });
  const book = await readDebtBook({}, {}, withStore(x, store));
  const by = (n: string) => book.invoices.find((i) => i.invoice_number === n)!;
  assertEquals(
    ["INV-7002", "INV-7004", "INV-7005"].map((n) => [
      n,
      by(n).kind,
      by(n).job_first_payment,
      by(n).is_debt,
      by(n).not_debt_reason,
    ]),
    [
      ["INV-7002", "materials", true, true, null],
      ["INV-7004", "materials", true, true, null],
      ["INV-7005", "materials", false, false, "before_first_payment"],
    ],
  );
  assertEquals([by("INV-7001").kind, by("INV-7001").is_debt], [
    "deposit",
    false,
  ]);
});

// ── The Supabase store: reads only, and a failed read stops the book ──

function fakeSupabase(
  answer: (
    table: string,
    filters: Array<[string, unknown[]]>,
  ) => { data: unknown; error: unknown },
) {
  const used: string[] = [];
  const client = {
    from(table: string) {
      const filters: Array<[string, unknown[]]> = [];
      const q: any = {};
      for (const m of ["select", "eq", "in", "gt", "or", "order", "range"]) {
        q[m] = (...args: unknown[]) => {
          used.push(m);
          filters.push([m, args]);
          return q;
        };
      }
      for (const m of ["insert", "update", "upsert", "delete", "rpc"]) {
        q[m] = () => {
          throw new Error(`write attempted: ${m}`);
        };
      }
      q.then = (
        resolve: (v: unknown) => unknown,
        reject: (e: unknown) => unknown,
      ) => Promise.resolve(answer(table, filters)).then(resolve, reject);
      return q;
    },
  };
  return { client, used };
}

Deno.test("debt_book through the Supabase store reads only, scoped to the org and ACCREC", async () => {
  const x = xero((
    p,
  ) => (p === 1
    ? [
      rawInvoice(1, {
        Contact: { Name: "A Client" },
        Reference: "SWF-26001-FINBAL",
      }),
    ]
    : [])
  );
  const seen: Array<{ table: string; filters: Array<[string, unknown[]]> }> =
    [];
  const { client, used } = fakeSupabase((table, filters) => {
    seen.push({ table, filters });
    if (
      table === "xero_invoices" &&
      filters.some(([m, a]) => m === "in" && a[0] === "xero_invoice_id")
    ) {
      return {
        data: [{
          xero_invoice_id: "20000000-0000-4000-8000-000000000001",
          invoice_number: "INV-1",
          status: "AUTHORISED",
          amount_due: 100,
          due_date: "2026-09-20",
          synced_at: null,
          job_id: "j1",
          debt_classification: "genuine_debt",
        }],
        error: null,
      };
    }
    if (table === "jobs") {
      return {
        data: [{
          id: "j1",
          job_number: "SWF-26001",
          status: "invoiced",
          deposit_at: null,
        }],
        error: null,
      };
    }
    return { data: [], error: null };
  });
  const book = await readDebtBook(
    client,
    {},
    {
      ...x.deps,
      store: createSupabaseDebtBookStore(client, ORG),
    } as unknown as DebtBookDeps,
  );
  assertEquals(book.invoices[0].job_status, "invoiced");
  assertEquals(book.invoices[0].desk_class, "genuine_debt");
  assert(
    used.every((m) =>
      ["select", "eq", "in", "gt", "or", "order", "range"].includes(m)
    ),
  );
  for (const s of seen.filter((s) => s.table === "xero_invoices")) {
    assert(
      s.filters.some(([m, a]) =>
        m === "eq" && a[0] === "org_id" && a[1] === ORG
      ),
    );
    assert(
      s.filters.some(([m, a]) =>
        m === "eq" && a[0] === "invoice_type" && a[1] === "ACCREC"
      ),
    );
  }
});

Deno.test("debt_book through the Supabase store: a part-paid sibling invoice in our copy is a first payment", async () => {
  const x = xero((
    p,
  ) => (p === 1
    ? [
      rawInvoice(1, {
        Contact: { Name: "A Client" },
        Reference: "SWP-26001-MAT50",
      }),
    ]
    : [])
  );
  const { client } = fakeSupabase((table, filters) => {
    if (table === "jobs") {
      return {
        data: [{
          id: "j1",
          job_number: "SWP-26001",
          status: "processing",
          deposit_at: null,
        }],
        error: null,
      };
    }
    // Our copy holds an AUTHORISED deposit on j1 with money paid on it, and no PAID invoice.
    const paidOrPartPaid = filters.some(([m, a]) =>
      m === "or" && String(a[0]).split(",").includes("amount_paid.gt.0")
    );
    if (
      table === "xero_invoices" && paidOrPartPaid &&
      filters.some(([m, a]) => m === "in" && a[0] === "job_id")
    ) {
      return { data: [{ job_id: "j1" }], error: null };
    }
    return { data: [], error: null };
  });
  const book = await readDebtBook(
    client,
    {},
    {
      ...x.deps,
      store: createSupabaseDebtBookStore(client, ORG),
    } as unknown as DebtBookDeps,
  );
  assertEquals(
    [
      book.invoices[0].kind,
      book.invoices[0].job_first_payment,
      book.invoices[0].is_debt,
    ],
    ["materials", true, true],
  );
});

Deno.test("an unexpected debt desk failure is logged by name and stack frame, never by its message", () => {
  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => logged.push(args);
  try {
    const error = new TypeError("provider body: secret-token-value");
    logDebtDeskFailure("debt_book", error);
    logDebtDeskFailure("debt_morning_list", "not an error");
  } finally {
    console.error = original;
  }
  assertEquals(logged.length, 2);
  const [first, second] = logged.map((args) => args.map(String).join(" "));
  assert(first.startsWith("[debt_book] unexpected failure TypeError at "));
  assert(!first.includes("secret-token-value"));
  assertEquals(second, "[debt_morning_list] unexpected failure string ");
});

Deno.test("debt_book stops, rather than guessing, when a copy or job read returns an error", async () => {
  for (const failing of ["xero_invoices", "jobs"]) {
    const x = xero((
      p,
    ) => (p === 1
      ? [
        rawInvoice(1, {
          Contact: { Name: "A Client" },
          Reference: "SWF-26001-FINBAL",
        }),
      ]
      : [])
    );
    const { client } = fakeSupabase((table, filters) => {
      if (table === failing) {
        return {
          data: null,
          error: { code: "42703", message: "column does not exist" },
        };
      }
      if (
        table === "xero_invoices" &&
        filters.some(([m, a]) => m === "in" && a[0] === "xero_invoice_id")
      ) {
        return {
          data: [{
            xero_invoice_id: "20000000-0000-4000-8000-000000000001",
            invoice_number: "INV-1",
            status: "AUTHORISED",
            amount_due: 100,
            due_date: null,
            synced_at: null,
            job_id: "j1",
            debt_classification: null,
          }],
          error: null,
        };
      }
      return { data: [], error: null };
    });
    const error = await assertRejects(
      () =>
        readDebtBook(
          client,
          {},
          {
            ...x.deps,
            store: createSupabaseDebtBookStore(client, ORG),
          } as unknown as DebtBookDeps,
        ),
      DebtBookError,
    );
    assertEquals(error.code, "debt_book_read_failed", failing);
  }
});
