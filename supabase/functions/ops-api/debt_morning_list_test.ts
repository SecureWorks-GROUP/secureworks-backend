// deno-lint-ignore-file no-import-prefix no-explicit-any
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type DebtBookCopyRecord,
  DebtBookError,
  type DebtBookJobRecord,
  type DebtBookStore,
} from "./debt_book.ts";
import {
  DEBT_BOOK_FIXTURE_2026_09_29 as FIXTURE,
  debtBookFixtureInvoiceId,
} from "./debt_book_fixture_2026_09_29.ts";
import { DEBT_CHASE_GROUP_ORDER } from "./debt_chase_schedule.ts";
import {
  DEBT_DRAFT_STEPS,
  type DebtDraftStep,
  debtDraftText,
} from "./debt_draft_templates.ts";
import {
  createSupabaseDebtChaseLogStore,
  type DebtChaseLogStore,
  type DebtMorningListDeps,
  readDebtMorningList,
} from "./debt_morning_list.ts";

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
/** 07:00 Perth on Thursday 2026-10-01, the first morning. */
const THURSDAY_7AM = "2026-09-30T23:00:00Z";
/** 07:00 Perth on Monday 2026-10-05, the first statement day. */
const MONDAY_7AM = "2026-10-04T23:00:00Z";

function xeroDeps(raws: unknown[], now: string) {
  const sorted = [...raws].sort((a: any, b: any) =>
    a.InvoiceID.localeCompare(b.InvoiceID)
  );
  const writes: string[] = [];
  return {
    writes,
    deps: {
      getToken: () =>
        Promise.resolve({
          accessToken: "fixture-only-token",
          tenantId: TENANT,
        }),
      xeroGet: (
        _path: string,
        _token: string,
        _tenant: string,
        params?: Record<string, string>,
      ) => {
        const page = Number(params?.page);
        return Promise.resolve({
          data: { Invoices: sorted.slice((page - 1) * 100, page * 100) },
          metadata: META,
        });
      },
      now: () => new Date(now),
    },
  };
}

function bookStore(overrides: Partial<DebtBookStore> = {}): DebtBookStore {
  return {
    copyRowsByXeroIds: () => Promise.resolve([]),
    openCopyRows: () => Promise.resolve([]),
    jobsByIds: () => Promise.resolve([]),
    jobsByNumbers: () => Promise.resolve([]),
    paidJobIds: () => Promise.resolve([]),
    ...overrides,
  };
}

function logStore(
  rows: Record<string, unknown>[] = [],
  contacts: Array<
    { id: string; client_phone: string | null; client_email: string | null }
  > = [],
  seen: { ids?: string[]; jobIds?: string[] } = {},
): DebtChaseLogStore {
  return {
    chaseLogRows: (ids) => {
      seen.ids = ids;
      return Promise.resolve(
        rows.filter((r) => ids.includes(String(r.xero_invoice_id))),
      );
    },
    jobContacts: (jobIds) => {
      seen.jobIds = jobIds;
      return Promise.resolve(contacts.filter((c) => jobIds.includes(c.id)));
    },
  };
}

// ── The 29 Sep book on Thursday morning ──

function fixtureRaws() {
  return FIXTURE.map((row) => ({
    InvoiceID: debtBookFixtureInvoiceId(row.invoice_number),
    InvoiceNumber: row.invoice_number,
    Type: "ACCREC",
    Status: "AUTHORISED",
    // One contact per (pseudonymised) name, so each client is its own payer.
    Contact: {
      ContactID: `contact-${row.contact_name}`,
      Name: row.contact_name,
    },
    Reference: row.reference,
    DueDateString: `${row.due_date}T00:00:00`,
    AmountDue: row.amount_due,
    LineItems: row.line_descriptions.map((Description) => ({ Description })),
  }));
}

function fixtureBookStore(): DebtBookStore {
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
  return bookStore({
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

Deno.test("debt_morning_list: Thursday's first list from the 29 Sep book matches the plan's estimate", async () => {
  const x = xeroDeps(fixtureRaws(), THURSDAY_7AM);
  const list = await readDebtMorningList(
    {},
    new URLSearchParams({ action: "debt_morning_list" }),
    {
      ...x.deps,
      store: fixtureBookStore(),
      chaseLog: logStore(),
    } as unknown as DebtMorningListDeps,
  );
  assertEquals(list.version, "debt-morning/v1");
  assertEquals(list.generated_at, "2026-10-01T07:00:00+08:00");
  assertEquals(list.perth_date, "2026-10-01");
  assertEquals(list.book.summary.debt.count, 97);
  assertEquals(
    list.book.copy_check.stamp,
    "Differs by $3,583.48 on 6 invoices",
  );

  // PLAN.md section 2: "The first morning list will hold 8 homeowner finals, about $23,380",
  // INV-0034 and INV-0267 start at the Jan step. The launch backlog starts everyone else at
  // the friendly text. INV-1069 shares a payer with INV-0267, so it goes with Jan.
  const homeowner = list.items.filter((i) =>
    i.payer === "client" && (i.group === "text" || i.group === "jan")
  );
  const finals = homeowner.flatMap((i) => i.invoices);
  assertEquals(finals.map((i) => i.invoice_number).sort(), [
    "INV-0034",
    "INV-0267",
    "INV-0290",
    "INV-1069",
    "INV-1435",
    "INV-1578",
    "INV-1606",
    "INV-1607",
    "INV-1608",
    "INV-1609",
  ]);
  const cents = (xs: Array<{ amount_due: number }>) =>
    Math.round(xs.reduce((a, i) => a + i.amount_due * 100, 0)) / 100;
  assertEquals(
    cents(
      finals.filter((i) =>
        !["INV-0034", "INV-0267"].includes(i.invoice_number)
      ),
    ),
    23379.94,
  );
  assertEquals(
    list.items.filter((i) => i.group === "jan").flatMap((i) =>
      i.invoices.map((x) => x.invoice_number)
    ).sort(),
    ["INV-0034", "INV-0267", "INV-1069"],
  );
  assert(
    homeowner.filter((i) => i.group === "text").every((i) =>
      i.step === "friendly_text"
    ),
  );

  // Thursday is not a statement day; builders 30 days overdue get Shaun's call.
  assertEquals(list.items.filter((i) => i.group === "statement"), []);
  assertEquals(list.next_statement_date, "2026-10-05");
  assertEquals(
    list.items.filter((i) => i.step === "builder_call").map((i) => i.payer_key)
      .sort(),
    ["aj", "mlb", "other_builder:Western Building"],
  );

  // Holds show with their reason and no step; nothing is drafted in this step.
  const holds = list.items.filter((i) => i.hold);
  assertEquals(holds.length, list.summary.held);
  assert(
    holds.every((i) =>
      i.step === null && i.group === "hold" && !!i.hold_reason
    ),
  );
  assertEquals(
    holds.flatMap((i) => i.invoices.map((x) => x.invoice_number)).includes(
      "INV-1456",
    ),
    true,
  );
  // Each hold names the step its payer would be on if not held; no other item carries one.
  const heldStep = (n: string) =>
    holds.find((i) => i.invoices.some((x) => x.invoice_number === n))!
      .held_step;
  assertEquals(
    ["INV-1456", "INV-1481", "INV-0597", "INV-1236", "INV-0080"].map(heldStep),
    [
      "statement",
      "builder_call",
      "builder_call",
      "friendly_text",
      "friendly_text",
    ],
  );
  assert(list.items.every((i) => i.hold ? true : i.held_step === null));
  // Drafts (plan step 3): every chaseable text, Jan visit and deposit reminder carries a
  // pending draft in the standard wording; calls, statements and holds carry none.
  for (const i of list.items) {
    const drafted = !i.hold &&
      DEBT_DRAFT_STEPS.includes(i.step as DebtDraftStep);
    assertEquals(!!i.draft, drafted, `${i.id} draft`);
    if (!i.draft) continue;
    assertEquals(i.draft.status, "pending");
    assertEquals(i.draft.channel, "sms");
    assertEquals(i.draft.to, i.step === "jan_visit" ? "jan" : "client");
    assertEquals(i.draft.text, i.draft.template_text);
    assert(i.draft.id.startsWith(`${i.id}|`));
    assertEquals(i.draft_problem, null);
  }
  assert(list.items.some((i) => i.draft?.to === "jan"));
  assertEquals(
    list.items.filter((i) => i.group === "text").every((i) =>
      i.draft?.text?.startsWith("Hi ") &&
      i.draft.text?.includes(i.invoices[0].invoice_number)
    ),
    true,
  );
  assertEquals(new Set(list.items.map((i) => i.id)).size, list.items.length);

  // Group order, then amount.
  const rank = (g: string) => {
    const r = DEBT_CHASE_GROUP_ORDER.indexOf(g as never);
    return r === -1 ? 99 : r;
  };
  for (let k = 1; k < list.items.length; k++) {
    const [a, b] = [list.items[k - 1], list.items[k]];
    assert(
      rank(a.group) < rank(b.group) ||
        (rank(a.group) === rank(b.group) && a.amount >= b.amount),
    );
  }

  // Deposits: the three genuinely unpaid overdue ones get their one reminder; the named ones none.
  assertEquals(
    list.items.filter((i) => i.group === "deposit_reminder").flatMap((i) =>
      i.invoices.map((x) => x.invoice_number)
    ).sort(),
    ["INV-1010", "INV-1374", "INV-1477"],
  );
  assertEquals(list.not_chased.map((n) => n.invoice_number).sort(), [
    "INV-0560",
    "INV-1119",
    "INV-1601",
    "INV-1602",
    "INV-1603",
  ]);
  assertEquals(list.chase_log, { rows_read: 0, desk_rows: 0 });
});

// ── Small books ──

function raw(n: number, extra: Record<string, unknown> = {}) {
  return {
    InvoiceID: `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    InvoiceNumber: `INV-${n}`,
    Type: "ACCREC",
    Status: "AUTHORISED",
    Contact: {
      ContactID: `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
      Name: `Client ${n}`,
    },
    Reference: `SWF-2600${n}-VAR1`,
    DateString: "2026-09-01T00:00:00",
    DueDateString: "2026-09-20T00:00:00",
    Total: 100,
    AmountDue: 100,
    LineItems: [{ Description: "Extra work" }],
    ...extra,
  };
}
const idOf = (n: number) => raw(n).InvoiceID;

Deno.test("debt_morning_list: the desk's log rows move the ladder, legacy rows do not; contacts come from the job", async () => {
  const x = xeroDeps([raw(1)], THURSDAY_7AM);
  const store = bookStore({
    copyRowsByXeroIds: () =>
      Promise.resolve([{
        xero_invoice_id: idOf(1),
        invoice_number: "INV-1",
        status: "AUTHORISED",
        amount_due: 100,
        due_date: "2026-09-20",
        synced_at: null,
        job_id: "j1",
        debt_classification: "genuine_debt",
      }]),
    jobsByIds: () =>
      Promise.resolve([{
        id: "j1",
        job_number: "SWF-26001",
        status: "complete",
        deposit_at: "2026-08-01",
      }]),
  });
  const rows = [
    {
      id: "l1",
      xero_invoice_id: idOf(1),
      method: "sms",
      outcome: "promised",
      follow_up_date: "2026-09-01",
      created_at: "2026-09-01T01:00:00Z",
    },
    {
      id: "l2",
      xero_invoice_id: idOf(1),
      method: "sms",
      created_at: "2026-09-30T01:00:00Z",
      schedule_step: "friendly_text",
      chased_by: "Shaun",
    },
  ];
  const list = await readDebtMorningList({}, {}, {
    ...x.deps,
    store,
    chaseLog: logStore(rows, [{
      id: "j1",
      client_phone: " 0400 000 000 ",
      client_email: "a@example.com",
    }]),
  } as unknown as DebtMorningListDeps);
  assertEquals(list.items.map((i) => [i.group, i.step, i.phone, i.email]), [
    ["text", "firm_text", "0400 000 000", "a@example.com"],
  ]);
  assertEquals(list.chase_log, { rows_read: 2, desk_rows: 1 });
});

Deno.test("debt_morning_list: reads the log only for invoices it can chase", async () => {
  const x = xeroDeps([
    raw(1),
    raw(2, {
      Contact: { ContactID: "ml", Name: "ML Builders" },
      Reference: "MLB-1",
    }),
    raw(3, { Reference: "SWF-26003-PLAN" }),
    raw(4, { Reference: "SWF-26004-DEP50" }),
  ], THURSDAY_7AM);
  const seen: { ids?: string[]; jobIds?: string[] } = {};
  await readDebtMorningList({}, {}, {
    ...x.deps,
    store: bookStore(),
    chaseLog: logStore([], [], seen),
  } as unknown as DebtMorningListDeps);
  assertEquals(seen.ids?.sort(), [idOf(1), idOf(4)].sort());
});

Deno.test("debt_morning_list: on Monday each builder gets one statement of invoices 14 days from their invoice date", async () => {
  const mlb = { ContactID: "mlb", Name: "Major Loss Builders" };
  const x = xeroDeps([
    raw(1, {
      Contact: mlb,
      Reference: "MLB-1",
      DateString: "2026-09-21T00:00:00",
      DueDateString: "2026-10-21T00:00:00",
    }),
    raw(2, {
      Contact: mlb,
      Reference: "MLB-2",
      DateString: "2026-09-22T00:00:00",
      DueDateString: "2026-10-22T00:00:00",
    }),
  ], MONDAY_7AM);
  const list = await readDebtMorningList({}, {}, {
    ...x.deps,
    store: bookStore(),
    chaseLog: logStore(),
  } as unknown as DebtMorningListDeps);
  assertEquals(list.is_statement_day, true);
  assertEquals(
    list.items.map((i) => [
      i.payer_key,
      i.step,
      i.invoices.map((v) => v.invoice_number),
    ]),
    [
      ["mlb", "statement", ["INV-1"]],
    ],
  );
});

Deno.test("debt_morning_list refuses unknown parameters", async () => {
  const x = xeroDeps([], THURSDAY_7AM);
  const error = await assertRejects(
    () =>
      readDebtMorningList(
        {},
        new URLSearchParams({ action: "debt_morning_list", send: "1" }),
        {
          ...x.deps,
          store: bookStore(),
          chaseLog: logStore(),
        } as unknown as DebtMorningListDeps,
      ),
    DebtBookError,
  );
  assertEquals([error.status, error.code], [
    400,
    "debt_morning_list_bad_request",
  ]);
});

// ── The Supabase chase-log store: reads only, and a failed read stops the list ──

function fakeSupabase(
  answer: (
    table: string,
    filters: Array<[string, unknown[]]>,
  ) => { data: unknown; error: unknown },
) {
  const used: string[] = [];
  const calls: Array<{ table: string; filters: Array<[string, unknown[]]> }> =
    [];
  const client = {
    from(table: string) {
      const filters: Array<[string, unknown[]]> = [];
      const q: any = {};
      for (const m of ["select", "eq", "in", "gt", "order", "range"]) {
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
      ) => {
        calls.push({ table, filters });
        return Promise.resolve(answer(table, filters)).then(resolve, reject);
      };
      return q;
    },
  };
  return { client, used, calls };
}

Deno.test("chase-log store: every column, org-scoped, chunked by 50 ids and paged by 1000 rows, never a write", async () => {
  const ids = Array.from({ length: 51 }, (_, k) => `id-${k}`);
  const { client, used, calls } = fakeSupabase((table, filters) => {
    const range = filters.find(([m]) => m === "range")?.[1] as
      | number[]
      | undefined;
    if (
      table === "payment_chase_logs" && range?.[0] === 0 &&
      (filters.find(([m]) => m === "in")?.[1][1] as string[]).length === 50
    ) {
      return {
        data: Array.from({ length: 1000 }, (_, k) => ({ id: `r${k}` })),
        error: null,
      };
    }
    if (table === "payment_chase_logs") {
      return { data: [{ id: "last" }], error: null };
    }
    return {
      data: [{ id: "j1", client_phone: "04", client_email: null }],
      error: null,
    };
  });
  const store = createSupabaseDebtChaseLogStore(client, ORG);
  const rows = await store.chaseLogRows(ids);
  assertEquals(rows.length, 1002);
  const logCalls = calls.filter((c) => c.table === "payment_chase_logs");
  assertEquals(logCalls.length, 3);
  for (const c of logCalls) {
    assert(c.filters.some(([m, a]) => m === "select" && a[0] === "*"));
    assert(
      c.filters.some(([m, a]) =>
        m === "eq" && a[0] === "org_id" && a[1] === ORG
      ),
    );
    assert(c.filters.some(([m, a]) => m === "order" && a[0] === "created_at"));
  }
  assertEquals(
    logCalls.map((c) => c.filters.find(([m]) => m === "range")?.[1]),
    [[0, 999], [1000, 1999], [0, 999]],
  );

  assertEquals(await store.jobContacts(["j1"]), [{
    id: "j1",
    client_phone: "04",
    client_email: null,
  }]);
  const jobCall = calls.find((c) => c.table === "jobs")!;
  assertEquals(jobCall.filters.find(([m]) => m === "select")?.[1], [
    "id, client_phone, client_email, site_address, site_suburb",
  ]);
  assert(
    used.every((m) => ["select", "eq", "in", "order", "range"].includes(m)),
  );
});

Deno.test("debt_morning_list stops, rather than restarting every ladder, when the chase log cannot be read", async () => {
  for (const failing of ["payment_chase_logs", "jobs"]) {
    const x = xeroDeps([raw(1)], THURSDAY_7AM);
    const store = bookStore({
      copyRowsByXeroIds: () =>
        Promise.resolve([{
          xero_invoice_id: idOf(1),
          invoice_number: "INV-1",
          status: "AUTHORISED",
          amount_due: 100,
          due_date: "2026-09-20",
          synced_at: null,
          job_id: "j1",
          debt_classification: null,
        }]),
      jobsByIds: () =>
        Promise.resolve([{
          id: "j1",
          job_number: "SWF-26001",
          status: "complete",
          deposit_at: null,
        }]),
    });
    const { client } = fakeSupabase((table) =>
      table === failing
        ? {
          data: null,
          error: { code: "42P01", message: "relation does not exist" },
        }
        : { data: [], error: null }
    );
    const error = await assertRejects(
      () =>
        readDebtMorningList({}, {}, {
          ...x.deps,
          store,
          chaseLog: createSupabaseDebtChaseLogStore(client, ORG),
        } as unknown as DebtMorningListDeps),
      DebtBookError,
    );
    assertEquals(
      [error.status, error.code],
      [502, "debt_book_read_failed"],
      failing,
    );
  }
});

// ── Drafts (plan step 3) ──

function oneClientBook(n = 1, amount = 100) {
  const x = xeroDeps(
    [raw(n, { AmountDue: amount, Total: amount })],
    THURSDAY_7AM,
  );
  const store = bookStore({
    copyRowsByXeroIds: () =>
      Promise.resolve([{
        xero_invoice_id: idOf(n),
        invoice_number: `INV-${n}`,
        status: "AUTHORISED",
        amount_due: amount,
        due_date: "2026-09-20",
        synced_at: null,
        job_id: "j1",
        debt_classification: "genuine_debt",
      }]),
    jobsByIds: () =>
      Promise.resolve([{
        id: "j1",
        job_number: "SWF-26001",
        status: "complete",
        deposit_at: "2026-08-01",
      }]),
  });
  return { x, store };
}
const sentYesterday = (n: number, step = "friendly_text") => ({
  id: `sent-${n}-${step}`,
  xero_invoice_id: idOf(n),
  method: "sms",
  created_at: "2026-09-30T01:00:00Z",
  schedule_step: step,
  outcome_code: "sent",
  draft_id: `2026-09-30:x:text:${step}|10000`,
  chased_by: "shaun@example.test",
});

Deno.test("drafts: a firm text carries each invoice's Xero pay link, read once per invoice", async () => {
  const { x, store } = oneClientBook();
  const asked: string[] = [];
  const list = await readDebtMorningList({}, {}, {
    ...x.deps,
    store,
    chaseLog: logStore([sentYesterday(1)]),
    payLinkCache: new Map(),
    payLink: (id: string) => {
      asked.push(id);
      return Promise.resolve(`https://in.xero.com/pay-${id.slice(-4)}`);
    },
  } as unknown as DebtMorningListDeps);
  assertEquals(list.items.map((i) => i.step), ["firm_text"]);
  const item = list.items[0];
  assertEquals(asked, [idOf(1)]);
  assertEquals(item.draft?.pay_links, [{
    xero_invoice_id: idOf(1),
    invoice_number: "INV-1",
    url: "https://in.xero.com/pay-0001",
  }]);
  assertEquals(
    item.draft?.text,
    debtDraftText({
      step: "firm_text",
      payer_name: "Client 1",
      invoices: item.invoices,
      pay_links: { [idOf(1)]: "https://in.xero.com/pay-0001" },
    }),
  );
  assertEquals(item.draft?.id, `${item.id}|10000`);
});

Deno.test("drafts: a firm text with no pay link has no draft, and says why", async () => {
  for (
    const [payLink, why] of [
      [undefined, "No Xero pay link reader"],
      [
        () => Promise.reject(new Error("429 rate limited")),
        "could not be read",
      ],
    ] as const
  ) {
    const { x, store } = oneClientBook();
    const list = await readDebtMorningList({}, {}, {
      ...x.deps,
      store,
      chaseLog: logStore([sentYesterday(1)]),
      payLink,
      payLinkCache: new Map(),
    } as unknown as DebtMorningListDeps);
    assertEquals(list.items[0].draft, null);
    assert(
      list.items[0].draft_problem?.includes(why),
      list.items[0].draft_problem!,
    );
  }
});

Deno.test("drafts: pay links are read one at a time, at most the limit per list", async () => {
  const raws = [1, 2, 3].map((n) => raw(n));
  const x = xeroDeps(raws, THURSDAY_7AM);
  let inFlight = 0;
  let most = 0;
  const list = await readDebtMorningList({}, {}, {
    ...x.deps,
    store: bookStore(),
    chaseLog: logStore([1, 2, 3].map((n) => sentYesterday(n))),
    payLinkLimit: 2,
    payLinkCache: new Map(),
    payLink: async (id: string) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      return `https://in.xero.com/${id.slice(-1)}`;
    },
  } as unknown as DebtMorningListDeps);
  assertEquals(most, 1);
  assertEquals(list.items.filter((i) => i.draft).length, 2);
  const capped = list.items.filter((i) => !i.draft);
  assertEquals(capped.length, 1);
  assert(capped[0].draft_problem?.includes("at most 2 pay links"));
});

Deno.test("drafts: a pay link read once is kept for the Perth day, and read again the next day", async () => {
  const { x, store } = oneClientBook();
  const asked: string[] = [];
  const cache = new Map<string, string>();
  const read = () =>
    readDebtMorningList({}, {}, {
      ...x.deps,
      store,
      chaseLog: logStore([sentYesterday(1)]),
      payLinkCache: cache,
      payLink: (id: string) => {
        asked.push(id);
        return Promise.resolve(`https://in.xero.com/pay-${asked.length}`);
      },
    } as unknown as DebtMorningListDeps);
  const first = await read();
  const second = await read();
  assertEquals(asked, [idOf(1)]);
  assertEquals(second.drafts.pay_links_read, 0);
  assertEquals(second.items[0].draft?.text, first.items[0].draft?.text);

  // A link kept from an earlier day is dropped, so it is read again.
  cache.clear();
  cache.set(`2026-09-30|${idOf(1)}`, "https://in.xero.com/yesterday");
  const next = await read();
  assertEquals(asked, [idOf(1), idOf(1)]);
  assert(next.items[0].draft?.text?.includes("https://in.xero.com/pay-2"));
  assertEquals([...cache.keys()], [`2026-10-01|${idOf(1)}`]);
});

Deno.test("drafts: a decided firm text keeps its text, and its standard wording is not claimed", async () => {
  const { x, store } = oneClientBook();
  const first = await readDebtMorningList({}, {}, {
    ...x.deps,
    store,
    chaseLog: logStore([sentYesterday(1)]),
    payLinkCache: new Map(),
    payLink: () => Promise.resolve("https://in.xero.com/pay"),
  } as unknown as DebtMorningListDeps);
  const draft = first.items[0].draft!;
  const approved = {
    id: "a1",
    xero_invoice_id: idOf(1),
    method: "sms",
    schedule_step: "firm_text",
    draft_id: draft.id,
    created_at: "2026-09-30T23:10:00Z",
    approved_by_user_id: "20000000-0000-4000-8000-0000000000aa",
    outcome: "approved",
    notes:
      "Hi Client, an edited firm text https://in.xero.com/pay. Thanks, SecureWorks",
    chased_by: "shaun@example.test",
  };
  const asked: string[] = [];
  const list = await readDebtMorningList({}, {}, {
    ...x.deps,
    store,
    chaseLog: logStore([sentYesterday(1), approved]),
    payLinkCache: new Map(),
    payLink: (id: string) => {
      asked.push(id);
      return Promise.resolve("https://in.xero.com/pay");
    },
  } as unknown as DebtMorningListDeps);
  const d = list.items[0].draft!;
  assertEquals(asked, []);
  assertEquals([d.status, d.text, d.template_text, d.edited], [
    "approved",
    approved.notes,
    null,
    null,
  ]);
});

Deno.test("drafts: a skipped firm text spends no live Xero read, and still shows its wording when it can", async () => {
  const { x, store } = oneClientBook();
  const firstCache = new Map<string, string>();
  const first = await readDebtMorningList({}, {}, {
    ...x.deps,
    store,
    chaseLog: logStore([sentYesterday(1)]),
    payLinkCache: firstCache,
    payLink: () => Promise.resolve("https://in.xero.com/pay"),
  } as unknown as DebtMorningListDeps);
  const pending = first.items[0].draft!;
  const row = (over: Record<string, unknown>): Record<string, unknown> => ({
    xero_invoice_id: idOf(1),
    method: "sms",
    schedule_step: "firm_text",
    draft_id: pending.id,
    chased_by: "shaun@example.test",
    ...over,
  });
  const skipped = row({
    id: "k1",
    created_at: "2026-09-30T23:10:00Z",
    outcome_code: "skipped",
    outcome: "skipped",
    notes: null,
  });
  const approved = row({
    id: "a1",
    created_at: "2026-09-30T23:05:00Z",
    approved_by_user_id: "20000000-0000-4000-8000-0000000000aa",
    outcome: "approved",
    notes:
      "Hi Client, the approved firm text https://in.xero.com/pay. Thanks, SecureWorks",
  });
  const asked: string[] = [];
  const read = (rows: Record<string, unknown>[], cache: Map<string, string>) =>
    readDebtMorningList({}, {}, {
      ...x.deps,
      store,
      chaseLog: logStore([sentYesterday(1), ...rows]),
      payLinkCache: cache,
      payLink: (id: string) => {
        asked.push(id);
        return Promise.resolve("https://in.xero.com/pay");
      },
    } as unknown as DebtMorningListDeps);

  // Links already read today: the standard wording, from the cache only.
  const cached = (await read([skipped], firstCache)).items[0].draft!;
  assertEquals([cached.status, cached.text, cached.template_text], [
    "skipped",
    pending.template_text,
    pending.template_text,
  ]);
  assertEquals(cached.pay_links, pending.pay_links);

  // Nothing cached: the earlier approval's text, else nothing.
  const reapproved = (await read([approved, skipped], new Map())).items[0]
    .draft!;
  assertEquals([reapproved.status, reapproved.text, reapproved.pay_links], [
    "skipped",
    approved.notes,
    null,
  ]);
  const bare = await read([skipped], new Map());
  const d = bare.items[0].draft!;
  assertEquals([d.status, d.text, d.template_text, d.edited, d.pay_links], [
    "skipped",
    null,
    null,
    false,
    null,
  ]);
  assertEquals(asked, []);
  assertEquals(bare.drafts.pay_links_read, 0);
});

Deno.test("drafts: a claimed send shows as sending, never as re-sendable, and does not move the ladder", async () => {
  const { x, store } = oneClientBook();
  const first = await readDebtMorningList({}, {}, {
    ...x.deps,
    store,
    chaseLog: logStore(),
  } as unknown as DebtMorningListDeps);
  const item = first.items[0];
  const claim = {
    id: "c1",
    xero_invoice_id: idOf(1),
    method: "sms",
    schedule_step: "friendly_text",
    draft_id: item.draft!.id,
    created_at: "2026-09-30T23:40:00Z",
    outcome_code: "sending",
    outcome: "send not confirmed: SMS send failed",
    notes: "Hi Client, the approved text. Thanks, SecureWorks",
    approved_by_user_id: "20000000-0000-4000-8000-0000000000aa",
    chased_by: "shaun@example.test",
  };
  const list = await readDebtMorningList({}, {}, {
    ...x.deps,
    store,
    chaseLog: logStore([claim]),
  } as unknown as DebtMorningListDeps);
  assertEquals(list.items.map((i) => i.step), ["friendly_text"]);
  const d = list.items[0].draft!;
  assertEquals([d.status, d.text], ["sending", claim.notes]);
  assertEquals(d.last_send, {
    at: claim.created_at,
    outcome: "not_confirmed",
    reason: "send not confirmed: SMS send failed",
  });
  assertEquals(list.sent_today, []);
});

Deno.test("drafts: an approval, a skip and a refused send read back from the chase log", async () => {
  const { x, store } = oneClientBook();
  const first = await readDebtMorningList({}, {}, {
    ...x.deps,
    store,
    chaseLog: logStore(),
  } as unknown as DebtMorningListDeps);
  const draftId = first.items[0].draft!.id;
  assertEquals(first.items[0].draft?.status, "pending");

  const decision = (over: Record<string, unknown>) => ({
    xero_invoice_id: idOf(1),
    method: "sms",
    schedule_step: "friendly_text",
    draft_id: draftId,
    chased_by: "shaun@example.test",
    ...over,
  });
  const approved = decision({
    id: "a1",
    created_at: "2026-09-30T23:10:00Z",
    approved_by_user_id: "20000000-0000-4000-8000-0000000000aa",
    outcome: "approved",
    notes: "Hi Client, edited by Shaun. Thanks, SecureWorks",
  });
  const refused = decision({
    id: "f1",
    created_at: "2026-09-30T23:20:00Z",
    outcome_code: "failed",
    outcome: "refused: sending_off",
    notes: "Sending is off until Shaun says start sending",
  });
  const skipped = decision({
    id: "s1",
    created_at: "2026-09-30T23:30:00Z",
    outcome_code: "skipped",
    outcome: "skipped",
  });
  const read = (rows: Record<string, unknown>[]) =>
    readDebtMorningList({}, {}, {
      ...x.deps,
      store,
      chaseLog: logStore(rows),
    } as unknown as DebtMorningListDeps);

  const a = (await read([approved, refused])).items[0];
  assertEquals(a.step, "friendly_text"); // approval and refusal never move the ladder
  assertEquals(a.draft?.status, "approved");
  assertEquals(
    a.draft?.text,
    "Hi Client, edited by Shaun. Thanks, SecureWorks",
  );
  assertEquals(a.draft?.approved_by, "shaun@example.test");
  assertEquals(a.draft?.edited, true);
  assertEquals(a.draft?.last_send, {
    at: "2026-09-30T23:20:00Z",
    outcome: "failed",
    reason: "Sending is off until Shaun says start sending",
  });

  const s = (await read([approved, refused, skipped])).items[0];
  assertEquals(s.draft?.status, "skipped");
  assertEquals(s.draft?.text, s.draft?.template_text);

  // An approval of a different amount is a different draft: today's is still pending.
  const stale =
    (await read([{ ...approved, draft_id: `${first.items[0].id}|9999` }]))
      .items[0];
  assertEquals(stale.draft?.status, "pending");
});

Deno.test("drafts: a draft sent today leaves the list and shows under sent_today", async () => {
  const { x, store } = oneClientBook();
  const first = await readDebtMorningList({}, {}, {
    ...x.deps,
    store,
    chaseLog: logStore(),
  } as unknown as DebtMorningListDeps);
  const item = first.items[0];
  const sent = {
    id: "s1",
    xero_invoice_id: idOf(1),
    method: "sms",
    schedule_step: "friendly_text",
    outcome_code: "sent",
    draft_id: item.draft!.id,
    covers_invoice_ids: [idOf(1)],
    provider_message_id: "msg-1",
    approved_by_user_id: "20000000-0000-4000-8000-0000000000aa",
    notes: "Hi Client, the approved text. Thanks, SecureWorks",
    chased_by: "shaun@example.test",
    created_at: "2026-09-30T23:40:00Z", // 07:40 Perth, Thursday
  };
  const yesterday = {
    ...sent,
    id: "s0",
    draft_id: "2026-09-30:x:text:friendly_text|10000",
    created_at: "2026-09-29T23:40:00Z",
  };
  const list = await readDebtMorningList({}, {}, {
    ...x.deps,
    store,
    chaseLog: logStore([yesterday, sent]),
  } as unknown as DebtMorningListDeps);
  assertEquals(list.items, []);
  assertEquals(list.sent_today, [{
    draft_id: item.draft!.id,
    payer_name: "Client 1",
    invoice_numbers: ["INV-1"],
    step: "friendly_text",
    text: "Hi Client, the approved text. Thanks, SecureWorks",
    at: "2026-09-30T23:40:00Z",
    by: "shaun@example.test",
    provider_message_id: "msg-1",
  }]);
});

Deno.test("debt_morning_list carries the desk owner state it is given, else null", async () => {
  const { x, store } = oneClientBook();
  const base = { ...x.deps, store, chaseLog: logStore() };
  const without = await readDebtMorningList(
    {},
    {},
    base as unknown as DebtMorningListDeps,
  );
  assertEquals(without.desk, null);
  const state = {
    owner_set: false,
    viewer_is_owner: false,
    sending_enabled: false,
    note: "Desk owner not set: nobody can approve or send",
  };
  const withDesk = await readDebtMorningList({}, {}, {
    ...base,
    desk: () => Promise.resolve(state),
  } as unknown as DebtMorningListDeps);
  assertEquals(withDesk.desk, state);
});
