// deno-lint-ignore-file no-import-prefix no-explicit-any
// Made-up figures and ZZTEST job numbers only.
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  listOverbilledJobWorkOrders,
  OVERBILLED_MAX_JOBS,
  OverbilledReadError,
  overbilledFromCappedListing,
  overbilledWindowDays,
} from "./work_order_overbilled.ts";

// The clock every test reads by. A weekly invoice defaults to a week that
// ended three days before it; a window of 90 days starts on 2026-08-20.
const NOW = new Date("2026-11-18T00:00:00Z");

const J1 = "00000000-0000-4000-8000-000000000001";
const J2 = "00000000-0000-4000-8000-000000000002";
const J3 = "00000000-0000-4000-8000-000000000003";
const J4 = "00000000-0000-4000-8000-000000000004";
const WO1 = "00000000-0000-4000-8000-0000000000a1";
const WO2 = "00000000-0000-4000-8000-0000000000a2";
const WO3 = "00000000-0000-4000-8000-0000000000a3";
const WO4 = "00000000-0000-4000-8000-0000000000a4";

function wo(id: string, jobId: string, ref: string, agreed: number | null) {
  return { id, job_id: jobId, status: "approved", agreed_labour_ex: agreed, ref };
}

let lineSeq = 0;
/** One line on its own invoice. `inv` overrides the invoice: `week_end: null`
 *  with `submitted_at` makes a work order invoice (no week). */
function line(
  jobId: string,
  status: string,
  type: string,
  amount: number,
  override: number | null = null,
  inv: Record<string, unknown> = {},
) {
  lineSeq += 1;
  const id = `line-${String(lineSeq).padStart(7, "0")}`;
  const invoiceId = String(inv.id ?? `inv-${String(lineSeq).padStart(7, "0")}`);
  return {
    id,
    trade_invoice_id: invoiceId,
    job_id: jobId,
    job_work_order_id: null,
    line_type: type,
    description: "made-up work",
    total_hours: 7,
    work_order_hours: null,
    line_total_ex: amount,
    override_amount: override,
    trade_invoices: {
      user_id: "trade-role",
      invoice_number: `ZZTEST-INV-${lineSeq}`,
      status,
      invoice_kind: "standard",
      week_end: "2026-11-15",
      submitted_at: null,
      created_at: "2026-11-10T00:00:00Z",
      users: { name: "Trade Role" },
      ...inv,
      id: invoiceId,
    },
  };
}

type Read = { table: string; filters: Array<[string, string, unknown]> };
type Fake = {
  workOrders?: any[];
  lines?: any[];
  variations?: any[];
  changes?: any[];
  /** Jobs with no work order (a job with one gets its row from the order). */
  jobs?: any[];
  users?: any[];
  fail?: string;
  /** Fail one particular read, by table and its filters. */
  failWhen?: (read: Read) => boolean;
  calls?: string[];
  reads?: Read[];
};

/**
 * An in-memory PostgREST stand-in that APPLIES every filter and honours
 * `range`, so a read that asks for the wrong rows, or stops at a full page,
 * shows up as a wrong answer here.
 */
function fakeClient(opts: Fake) {
  const invoices = new Map<string, any>();
  for (const l of opts.lines || []) {
    invoices.set(l.trade_invoices.id, l.trade_invoices);
  }
  const tables: Record<string, any[]> = {
    users: opts.users || [{ id: "trade-role" }],
    work_orders: (opts.workOrders || []).map(({ ref: _ref, ...w }) => ({
      kind: "job",
      ...w,
    })),
    jobs: [
      ...(opts.workOrders || []).map((w) => ({ id: w.job_id, job_number: w.ref })),
      ...(opts.jobs || []),
    ],
    trade_invoices: [...invoices.values()],
    trade_invoice_lines: opts.lines || [],
    work_order_customer_variations: opts.variations || [],
    work_order_amount_changes: opts.changes || [],
  };
  return {
    from(table: string) {
      opts.calls?.push(table);
      const read: Read = { table, filters: [] };
      opts.reads?.push(read);
      const matching = () =>
        (tables[table] || []).filter((row) =>
          read.filters.every(([op, col, value]) => {
            const cell = row[col];
            if (op === "in") return (value as unknown[]).map(String).includes(String(cell));
            if (op === "eq") return String(cell) === String(value);
            if (op === "gte") return cell != null && String(cell) >= String(value);
            if (op === "is") return cell == null;
            if (op === "not") return cell != null;
            return true;
          })
        ).sort((x, y) => String(x.id ?? "").localeCompare(String(y.id ?? "")));
      const answer = (from = 0, to = Number.MAX_SAFE_INTEGER) =>
        Promise.resolve(
          opts.fail === table || opts.failWhen?.(read)
            ? { data: null, error: { message: "x" } }
            : { data: matching().slice(from, to + 1), error: null },
        );
      const q: any = {
        select: () => q,
        in: (col: string, value: unknown[]) => (read.filters.push(["in", col, value]), q),
        eq: (col: string, value: unknown) => (read.filters.push(["eq", col, value]), q),
        gte: (col: string, value: unknown) => (read.filters.push(["gte", col, value]), q),
        is: (col: string, value: unknown) => (read.filters.push(["is", col, value]), q),
        not: (col: string, _op: string, value: unknown) => (read.filters.push(["not", col, value]), q),
        order: () => q,
        range: (from: number, to: number) => answer(from, to),
        then: (res: any, rej: any) => answer().then(res, rej),
      };
      return q;
    },
    rpc() {
      return Promise.resolve({ data: null, error: { message: "unused" } });
    },
  };
}

/** The ids a table was asked for through `.in(col, ...)`, read by read. */
function asked(reads: Read[], table: string, col: string): string[][] {
  return reads.filter((r) => r.table === table).flatMap((r) =>
    r.filters.filter(([op, c]) => op === "in" && c === col).map(([, , v]) =>
      (v as unknown[]).map(String)
    )
  );
}

function uuid(prefix: string, n: number): string {
  return `${prefix}0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

const GET = { method: "GET", isStaff: true, now: NOW };

Deno.test("overbilled: lists only jobs billed over agreed labour, gap first", async () => {
  const out = await listOverbilledJobWorkOrders(
    fakeClient({
      workOrders: [
        wo(WO1, J1, "ZZTEST-1", 1000),
        wo(WO2, J2, "ZZTEST-2", 500),
        wo(WO3, J3, "ZZTEST-3", 800),
        wo(WO4, J4, "ZZTEST-4", 300),
      ],
      lines: [
        // ZZTEST-1: 1200 billed against 1000, gap 200.
        line(J1, "pushed_to_xero", "work order", 1000),
        line(J1, "paid", "labour", 200),
        // ZZTEST-2: exactly at the agreed amount, not listed.
        line(J2, "approved", "work order", 500),
        // ZZTEST-3: one cent over.
        line(J3, "acknowledged", "work order", 800.01),
        // ZZTEST-4: 900 billed against 300, gap 600, largest first.
        line(J4, "approved", "materials", 900),
      ],
    }),
    GET,
  );
  assertEquals(out.ok, true);
  assertEquals(out.rule, "billed_over_agreed_labour");
  assertEquals(out.checked_work_orders, 4);
  assertEquals(out.count, 3);
  assertEquals(out.jobs.map((j) => j.job_number), [
    "ZZTEST-4",
    "ZZTEST-1",
    "ZZTEST-3",
  ]);
  assertEquals(out.jobs[1].gap_ex, 200);
  assertEquals(out.jobs[2].gap_ex, 0.01);
  assertEquals(out.total_gap_ex, 800.01);
});

Deno.test("overbilled: a row carries job-level figures only, no trade, rate, hours, invoice or line", async () => {
  const out = await listOverbilledJobWorkOrders(
    fakeClient({
      workOrders: [wo(WO1, J1, "ZZTEST-1", 1000)],
      lines: [line(J1, "approved", "labour", 1500)],
    }),
    GET,
  );
  assertEquals(out.jobs.length, 1);
  assertEquals(Object.keys(out.jobs[0]).sort(), [
    "agreed_labour_ex",
    "allowed_ex",
    "billed_ex",
    "gap_ex",
    "job_id",
    "job_number",
    "limit",
    "over_allowed_ex",
    "within_allowed",
    "work_order_id",
  ]);
  assertEquals(out.jobs[0], {
    job_id: J1,
    job_number: "ZZTEST-1",
    work_order_id: WO1,
    agreed_labour_ex: 1000,
    billed_ex: 1500,
    gap_ex: 500,
    allowed_ex: 1000,
    over_allowed_ex: 500,
    within_allowed: false,
    limit: null,
  });
  const text = JSON.stringify(out);
  for (const word of ["Trade Role", "trade-role", "ZZTEST-INV", "hours", "line_type", "user_id"]) {
    assert(!text.includes(word), `${word} must not leave the action`);
  }
});

Deno.test("overbilled: draft, rejected and voided invoices hold nothing; commission and reimbursement never count", async () => {
  const out = await listOverbilledJobWorkOrders(
    fakeClient({
      workOrders: [wo(WO1, J1, "ZZTEST-1", 1000)],
      lines: [
        line(J1, "approved", "work order", 1000),
        line(J1, "draft", "work order", 5000),
        line(J1, "ops-reject", "work order", 5000),
        line(J1, "voided", "labour", 5000),
        line(J1, "approved", "commission", 400),
        line(J1, "paid", "reimbursement", 90),
      ],
    }),
    GET,
  );
  assertEquals(out.count, 0, "billed equals agreed once only counted lines are summed");
});

Deno.test("overbilled: the office override counts before the line total, a zero override included", async () => {
  const out = await listOverbilledJobWorkOrders(
    fakeClient({
      workOrders: [wo(WO1, J1, "ZZTEST-1", 1000), wo(WO2, J2, "ZZTEST-2", 1000)],
      lines: [
        // Billed 2000, cut by the office to 0: nothing over.
        line(J1, "approved", "work order", 2000, 0),
        // Billed 900, raised by the office to 1100: 100 over.
        line(J2, "approved", "work order", 900, 1100),
      ],
    }),
    GET,
  );
  assertEquals(out.jobs.map((j) => [j.job_number, j.billed_ex, j.gap_ex]), [
    ["ZZTEST-2", 1100, 100],
  ]);
});

Deno.test("overbilled: an approved customer variation and an office change are shown as allowed, the gap stays against agreed", async () => {
  const out = await listOverbilledJobWorkOrders(
    fakeClient({
      workOrders: [wo(WO1, J1, "ZZTEST-1", 1000)],
      lines: [line(J1, "approved", "work order", 1300)],
      variations: [
        { job_id: J1, work_order_id: WO1, status: "approved", trade_allocation_ex: 200 },
        { job_id: J1, work_order_id: WO1, status: "draft", trade_allocation_ex: 900 },
      ],
      changes: [{ id: "c1", work_order_id: WO1, delta_ex: 150 }],
    }),
    GET,
  );
  assertEquals(out.jobs[0].gap_ex, 300);
  assertEquals(out.jobs[0].allowed_ex, 1350);
  assertEquals(out.jobs[0].over_allowed_ex, 0);
  assertEquals(out.jobs[0].within_allowed, true);
});

Deno.test("overbilled: a job paid hourly up to a sealed maximum shows that maximum as allowed", async () => {
  const out = await listOverbilledJobWorkOrders(
    fakeClient({
      workOrders: [wo(WO1, J1, "ZZTEST-1", 1000)],
      lines: [line(J1, "approved", "labour", 1400)],
    }),
    { ...GET, hourlyLimits: () => Promise.resolve(new Map([[J1, 1200]])) },
  );
  assertEquals(out.jobs[0].allowed_ex, 1200);
  assertEquals(out.jobs[0].over_allowed_ex, 200);
  assertEquals(out.jobs[0].limit, "hourly_maximum");
});

Deno.test("overbilled: no approved work orders answers an empty list, not a failure", async () => {
  const out = await listOverbilledJobWorkOrders(fakeClient({}), GET);
  assertEquals(out, {
    ok: true,
    rule: "billed_over_agreed_labour",
    window_days: 90,
    window_from: "2026-08-20",
    max_jobs: OVERBILLED_MAX_JOBS,
    billed_jobs: 0,
    checked_work_orders: 0,
    count: 0,
    total_gap_ex: 0,
    jobs: [],
    no_agreed_amount_count: 0,
    no_agreed_amount: [],
  });
});

for (const table of [
  "users",
  "trade_invoices",
  "work_orders",
  "jobs",
  "trade_invoice_lines",
  "work_order_customer_variations",
  "work_order_amount_changes",
]) {
  Deno.test(`overbilled: a failed ${table} read refuses 503, never an empty list`, async () => {
    const err = await assertRejects(
      () =>
        listOverbilledJobWorkOrders(
          fakeClient({
            fail: table,
            workOrders: [wo(WO1, J1, "ZZTEST-1", 1000)],
            lines: [line(J1, "approved", "labour", 1500)],
          }),
          GET,
        ),
      OverbilledReadError,
    );
    assertEquals(err.status, 503);
    assertEquals(err.code, "overbilled_unreadable");
    assert(!/\d{3,}/.test(err.message), "the refusal carries no figure");
  });
}

Deno.test("overbilled: an unreadable hourly maximum refuses 503", async () => {
  const err = await assertRejects(
    () =>
      listOverbilledJobWorkOrders(
        fakeClient({
          workOrders: [wo(WO1, J1, "ZZTEST-1", 1000)],
          lines: [line(J1, "approved", "labour", 1500)],
        }),
        { ...GET, hourlyLimits: () => Promise.reject(new Error("x")) },
      ),
    OverbilledReadError,
  );
  assertEquals(err.status, 503);
});

Deno.test("overbilled: a non-staff caller is refused 403 before any read", async () => {
  const calls: string[] = [];
  const err = await assertRejects(
    () =>
      listOverbilledJobWorkOrders(
        fakeClient({ calls, workOrders: [wo(WO1, J1, "ZZTEST-1", 1000)] }),
        { method: "GET", isStaff: false, now: NOW },
      ),
    OverbilledReadError,
  );
  assertEquals(err.status, 403);
  assertEquals(err.code, "operator_access_required");
  assertEquals(calls, []);
});

Deno.test("overbilled: POST is refused 405 before any read", async () => {
  const calls: string[] = [];
  const err = await assertRejects(
    () =>
      listOverbilledJobWorkOrders(fakeClient({ calls }), {
        method: "POST",
        isStaff: true,
      }),
    OverbilledReadError,
  );
  assertEquals(err.status, 405);
  assertEquals(calls, []);
});

Deno.test("overbilled (pure): a capped row with an unreadable figure refuses; rows with no cap are skipped", () => {
  assertEquals(
    overbilledFromCappedListing([
      { id: WO1, job_id: J1, agreed_labour_ex: 100, cap: null },
      { id: WO2, job_id: J2, agreed_labour_ex: 100 },
    ]),
    [],
  );
  let caught: unknown = null;
  try {
    overbilledFromCappedListing([
      { id: WO1, job_id: J1, agreed_labour_ex: 100, cap: { billed_ex: "x", allowed_ex: 100 } },
    ]);
  } catch (e) {
    caught = e;
  }
  assert(caught instanceof OverbilledReadError);
  assertEquals((caught as OverbilledReadError).status, 503);
});

// ---- Director hold 18 Nov 14:54: the list is driven by the jobs billed in a
// window, read for those jobs only, capped in words, never cut short. ----

Deno.test("overbilled: an approved work order on a job with no bill in the window is never read or counted", async () => {
  const reads: Read[] = [];
  const fixture = {
    workOrders: [wo(WO1, J1, "ZZTEST-1", 1000), wo(WO2, J2, "ZZTEST-2", 1000), wo(WO3, J3, "ZZTEST-3", 1000)],
    lines: [
      line(J1, "approved", "work order", 1500),
      // ZZTEST-2 was overbilled, but its week ended long before the window.
      line(J2, "paid", "work order", 1900, null, { week_end: "2026-03-01" }),
      // ZZTEST-3 has an approved work order and no bill at all.
    ],
  };
  const out = await listOverbilledJobWorkOrders(fakeClient({ ...fixture, reads }), GET);
  assertEquals(out.billed_jobs, 1);
  assertEquals(out.checked_work_orders, 1);
  assertEquals(out.jobs.map((j) => j.job_number), ["ZZTEST-1"]);
  assertEquals(asked(reads, "work_orders", "job_id"), [[J1]], "work orders are read for the billed jobs only");
  for (const ids of [...asked(reads, "trade_invoice_lines", "job_id"), ...asked(reads, "work_order_amount_changes", "work_order_id")]) {
    assert(!ids.includes(J2) && !ids.includes(J3) && !ids.includes(WO2) && !ids.includes(WO3));
  }
  assert(
    reads.filter((r) => r.table === "work_orders").every((r) => r.filters.some(([op, col]) => op === "in" && col === "job_id")),
    "no read of work orders without a job list",
  );
  // The window is a parameter: a year back finds the older job too.
  const wide = await listOverbilledJobWorkOrders(fakeClient(fixture), { ...GET, days: "366" });
  assertEquals(wide.window_days, 366);
  assertEquals(wide.jobs.map((j) => j.job_number), ["ZZTEST-2", "ZZTEST-1"]);
  const narrow = await listOverbilledJobWorkOrders(fakeClient(fixture), { ...GET, days: "2" });
  assertEquals([narrow.window_from, narrow.billed_jobs, narrow.count], ["2026-11-16", 0, 0]);
});

Deno.test("overbilled: a work order invoice has no week; it is placed by when it was sent, else created", async () => {
  const noWeek = { week_end: null };
  const out = await listOverbilledJobWorkOrders(
    fakeClient({
      workOrders: [
        wo(WO1, J1, "ZZTEST-1", 1000),
        wo(WO2, J2, "ZZTEST-2", 1000),
        wo(WO3, J3, "ZZTEST-3", 1000),
        wo(WO4, J4, "ZZTEST-4", 1000),
      ],
      lines: [
        // Sent inside the window, created long before it.
        line(J1, "approved", "work order", 1100, null, { ...noWeek, submitted_at: "2026-11-01T02:00:00Z", created_at: "2026-01-01T00:00:00Z" }),
        // Sent before the window.
        line(J2, "paid", "work order", 1200, null, { ...noWeek, submitted_at: "2026-05-01T02:00:00Z" }),
        // Never stamped as sent: its created time places it, inside.
        line(J3, "approved", "work order", 1300, null, { ...noWeek, created_at: "2026-10-01T00:00:00Z" }),
        // Never stamped as sent, created before the window.
        line(J4, "approved", "work order", 1400, null, { ...noWeek, created_at: "2026-02-01T00:00:00Z" }),
      ],
    }),
    GET,
  );
  assertEquals(out.jobs.map((j) => j.job_number), ["ZZTEST-3", "ZZTEST-1"]);
  assertEquals(out.billed_jobs, 2);
});

Deno.test("overbilled: a holding invoice, an unbilled status, commission and reimbursement do not put a job in the window", async () => {
  const out = await listOverbilledJobWorkOrders(
    fakeClient({
      workOrders: [wo(WO1, J1, "ZZTEST-1", 100), wo(WO2, J2, "ZZTEST-2", 100), wo(WO3, J3, "ZZTEST-3", 100)],
      jobs: [{ id: J4, job_number: "ZZTEST-4" }],
      lines: [
        line(J1, "pending_ops_review", "labour", 900, null, { invoice_kind: "held" }),
        line(J2, "draft", "labour", 900),
        line(J3, "approved", "commission", 900),
        line(J4, "approved", "reimbursement", 900),
      ],
    }),
    GET,
  );
  assertEquals([out.billed_jobs, out.checked_work_orders, out.count, out.no_agreed_amount_count], [0, 0, 0, 0]);
});

Deno.test("overbilled: jobs billed in the window with no agreed amount are listed apart, with why", async () => {
  const out = await listOverbilledJobWorkOrders(
    fakeClient({
      workOrders: [
        wo(WO1, J1, "ZZTEST-1", 1000),
        { ...wo(WO2, J2, "ZZTEST-2", 700), status: "draft" },
        wo(WO3, J3, "ZZTEST-3", null),
      ],
      jobs: [{ id: J4, job_number: "ZZTEST-4" }],
      lines: [
        line(J1, "approved", "work order", 1500),
        line(J2, "approved", "labour", 900),
        line(J3, "approved", "labour", 900),
        line(J4, "approved", "labour", 900),
      ],
    }),
    GET,
  );
  assertEquals(out.billed_jobs, 4);
  assertEquals(out.checked_work_orders, 1);
  assertEquals(out.jobs.map((j) => j.job_number), ["ZZTEST-1"]);
  assertEquals(out.no_agreed_amount_count, 3);
  assertEquals(out.no_agreed_amount, [
    { job_id: J2, job_number: "ZZTEST-2", work_order: "not_approved" },
    { job_id: J3, job_number: "ZZTEST-3", work_order: "no_amount" },
    { job_id: J4, job_number: "ZZTEST-4", work_order: "none" },
  ]);
  assert(!JSON.stringify(out.no_agreed_amount).includes("900"), "no figure on a job that cannot be judged");
});

function manyJobs(n: number) {
  const workOrders: any[] = [];
  const lines: any[] = [];
  for (let i = 1; i <= n; i++) {
    const job = uuid("b", i);
    workOrders.push(wo(uuid("c", i), job, `ZZTEST-M${String(i).padStart(4, "0")}`, 1000));
    // Every third job is billed 10 over; the rest exactly at the agreed amount.
    lines.push(line(job, "approved", "work order", i % 3 === 0 ? 1010 : 1000));
  }
  return { workOrders, lines };
}

Deno.test("overbilled: 300 jobs billed in the window are all checked, 25 at a time, none dropped", async () => {
  const reads: Read[] = [];
  const out = await listOverbilledJobWorkOrders(fakeClient({ ...manyJobs(300), reads }), GET);
  assertEquals(out.billed_jobs, 300);
  assertEquals(out.checked_work_orders, 300);
  assertEquals(out.count, 100);
  assertEquals(out.total_gap_ex, 1000);
  assertEquals(new Set(out.jobs.map((j) => j.job_id)).size, 100);
  assert(out.jobs.every((j) => j.gap_ex === 10 && j.billed_ex === 1010));
  // The cap reader never sees more than the 25 it was planned for.
  const capBatches = asked(reads, "work_order_amount_changes", "work_order_id");
  assertEquals(capBatches.length, 12);
  assert(capBatches.every((ids) => ids.length <= 25));
  assert(asked(reads, "trade_invoice_lines", "job_id").every((ids) => ids.length <= 25));
  assert(asked(reads, "work_orders", "job_id").every((ids) => ids.length <= 100));
  assertEquals(new Set(capBatches.flat()).size, 300, "every work order reached the cap reader once");
});

Deno.test("overbilled: one job past the cap is refused in words, never cut short; exactly the cap is answered whole", async () => {
  const calls: string[] = [];
  const err = await assertRejects(
    () => listOverbilledJobWorkOrders(fakeClient({ ...manyJobs(OVERBILLED_MAX_JOBS + 1), calls }), GET),
    OverbilledReadError,
  );
  assertEquals(err.status, 422);
  assertEquals(err.code, "overbilled_window_too_wide");
  assert(err.message.includes(`More than ${OVERBILLED_MAX_JOBS} jobs`) && err.message.includes("Narrow the window"));
  assert(!calls.includes("work_orders"), "refused before any work order or cap read");

  const whole = await listOverbilledJobWorkOrders(fakeClient(manyJobs(OVERBILLED_MAX_JOBS)), GET);
  assertEquals(whole.billed_jobs, OVERBILLED_MAX_JOBS);
  assertEquals(whole.checked_work_orders, OVERBILLED_MAX_JOBS);
  assertEquals(whole.count, Math.floor(OVERBILLED_MAX_JOBS / 3));
});

Deno.test("overbilled: a job outside the window does not count toward the cap, so a narrower window always helps", async () => {
  const many = manyJobs(OVERBILLED_MAX_JOBS + 1);
  // The last job's only bill is a work order invoice sent before the window.
  many.lines[OVERBILLED_MAX_JOBS].trade_invoices.week_end = null;
  many.lines[OVERBILLED_MAX_JOBS].trade_invoices.submitted_at = "2026-01-05T00:00:00Z";
  const out = await listOverbilledJobWorkOrders(fakeClient(many), GET);
  assertEquals(out.billed_jobs, OVERBILLED_MAX_JOBS);
});

Deno.test("overbilled: a full page of 1,000 rows is followed by the next page, never read as the end", async () => {
  // 1,001 lines of 1.00 on one invoice against 1,000 agreed: the last line is
  // on the second page of both the window read and the cap's own read.
  const invoice = { id: "inv-paged" };
  const lines = Array.from({ length: 1001 }, () => line(J1, "approved", "labour", 1, null, invoice));
  const out = await listOverbilledJobWorkOrders(
    fakeClient({ workOrders: [wo(WO1, J1, "ZZTEST-1", 1000)], lines }),
    GET,
  );
  assertEquals(out.jobs.map((j) => [j.billed_ex, j.gap_ex]), [[1001, 1]]);

  // The window read's own paging: 1,000 lines for one job fill the first page
  // of an invoice's lines, and a second job's only line is on the next page.
  const shared = { id: "inv-paged-two" };
  const firstPage = Array.from({ length: 1000 }, () => line(J1, "approved", "labour", 1, null, shared));
  const two = await listOverbilledJobWorkOrders(
    fakeClient({
      workOrders: [wo(WO1, J1, "ZZTEST-1", 5000), wo(WO2, J2, "ZZTEST-2", 100)],
      lines: [...firstPage, line(J2, "approved", "labour", 150, null, shared)],
    }),
    GET,
  );
  assertEquals(two.billed_jobs, 2);
  assertEquals(two.jobs.map((j) => [j.job_number, j.gap_ex]), [["ZZTEST-2", 50]]);
});

Deno.test("overbilled: a later cap batch that cannot be read refuses the whole answer, never a short list", async () => {
  const many = manyJobs(60);
  const inThirdBatch = many.workOrders[55].job_id;
  const err = await assertRejects(
    () =>
      listOverbilledJobWorkOrders(
        fakeClient({
          ...many,
          // Only the cap's own read of lines by job fails, and only for one batch.
          failWhen: (r) =>
            r.table === "trade_invoice_lines" &&
            r.filters.some(([op, col, v]) => op === "in" && col === "job_id" && (v as string[]).includes(inThirdBatch)),
        }),
        GET,
      ),
    OverbilledReadError,
  );
  assertEquals([err.status, err.code], [503, "overbilled_unreadable"]);
});

Deno.test("overbilled: days is a whole number from 1 to 366; a bad one is refused 400 before any read", async () => {
  assertEquals(overbilledWindowDays(null), 90);
  assertEquals(overbilledWindowDays(""), 90);
  assertEquals(overbilledWindowDays("30"), 30);
  assertEquals(overbilledWindowDays("366"), 366);
  for (const bad of ["0", "367", "-5", "1.5", "abc", "90 days", "1e2"]) {
    const calls: string[] = [];
    const err = await assertRejects(
      () => listOverbilledJobWorkOrders(fakeClient({ calls }), { ...GET, days: bad }),
      OverbilledReadError,
    );
    assertEquals([err.status, err.code, calls.length], [400, "invalid_days", 0], bad);
  }
});
