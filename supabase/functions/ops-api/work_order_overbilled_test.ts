// deno-lint-ignore-file no-import-prefix no-explicit-any
// Made-up figures and ZZTEST job numbers only.
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  listOverbilledJobWorkOrders,
  OverbilledReadError,
  overbilledFromCappedListing,
} from "./work_order_overbilled.ts";

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
function line(
  jobId: string,
  status: string,
  type: string,
  amount: number,
  override: number | null = null,
) {
  lineSeq += 1;
  const id = `line-${lineSeq}`;
  return {
    id,
    trade_invoice_id: `inv-${lineSeq}`,
    job_id: jobId,
    job_work_order_id: null,
    line_type: type,
    description: "made-up work",
    total_hours: 7,
    work_order_hours: null,
    line_total_ex: amount,
    override_amount: override,
    trade_invoices: {
      id: `inv-${lineSeq}`,
      user_id: "trade-role",
      invoice_number: `ZZTEST-INV-${lineSeq}`,
      status,
      submitted_at: null,
      users: { name: "Trade Role" },
    },
  };
}

type Fake = {
  workOrders?: any[];
  lines?: any[];
  variations?: any[];
  changes?: any[];
  fail?: string;
  calls?: string[];
};

function fakeClient(opts: Fake) {
  return {
    from(table: string) {
      opts.calls?.push(table);
      const rows = table === "work_orders"
        ? (opts.workOrders || []).map(({ ref: _ref, ...w }) => w)
        : table === "jobs"
        ? (opts.workOrders || []).map((w) => ({ id: w.job_id, job_number: w.ref }))
        : table === "trade_invoice_lines"
        ? opts.lines || []
        : table === "work_order_customer_variations"
        ? opts.variations || []
        : table === "work_order_amount_changes"
        ? opts.changes || []
        : [];
      const answer = () =>
        Promise.resolve(
          opts.fail === table
            ? { data: null, error: { message: "x" } }
            : { data: rows, error: null },
        );
      const q: any = {
        select: () => q,
        in: () => q,
        eq: () => q,
        not: () => q,
        order: () => q,
        range: answer,
        then: (res: any, rej: any) => answer().then(res, rej),
      };
      return q;
    },
    rpc() {
      return Promise.resolve({ data: null, error: { message: "unused" } });
    },
  };
}

const GET = { method: "GET", isStaff: true };

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
    checked_work_orders: 0,
    count: 0,
    total_gap_ex: 0,
    jobs: [],
  });
});

for (const table of [
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
        { method: "GET", isStaff: false },
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
