// deno-lint-ignore-file no-import-prefix no-explicit-any
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  checkWorkOrderTotalCap,
  countsAgainstWorkOrder,
  incomingLabourByJob,
  isHourlyCappedMode,
  readBilledOnJobs,
  readWorkOrderCapFacts,
  WORK_ORDER_CAP_WORDS,
  withWorkOrderCaps,
  WorkOrderTotalCapReadError,
  workOrderTotalCapRefusal,
} from "./work_order_total_cap.ts";

const JOB = "00000000-0000-4000-8000-000000000001";
const WO = "00000000-0000-4000-8000-0000000000a1";

Deno.test("cap: within the work order passes, to the cent", () => {
  const jobs = [{ jobId: JOB, ref: "SWF-1", allowedEx: 2160 }];
  assertEquals(
    workOrderTotalCapRefusal({
      jobs,
      billedEx: new Map([[JOB, 400]]),
      incomingEx: new Map([[JOB, 1760]]),
    }),
    null,
  );
  assertEquals(
    workOrderTotalCapRefusal({
      jobs,
      billedEx: new Map(),
      incomingEx: new Map([[JOB, 2160]]),
    }),
    null,
  );
});

Deno.test("cap: one cent over refuses, and says the most this invoice may bill", () => {
  const jobs = [{ jobId: JOB, ref: "SWF-1", allowedEx: 2160 }];
  const r = workOrderTotalCapRefusal({
    jobs,
    billedEx: new Map([[JOB, 400]]),
    incomingEx: new Map([[JOB, 1760.01]]),
  });
  assert(r);
  assertEquals(r.code, "work_order_total_over_agreed");
  assertEquals(r.jobs, [{
    job: "SWF-1",
    job_id: JOB,
    most_this_invoice_ex: 1760,
  }]);
  assertStringIncludes(
    r.message,
    "Job SWF-1: this invoice can bill at most $1,760.00",
  );
  assertEquals(
    r.message.includes("400"),
    false,
    "never says what anyone else billed",
  );
});

Deno.test("cap: a second full bill on the same work order is refused as billed in full", () => {
  const jobs = [{ jobId: JOB, ref: "SWF-1", allowedEx: 2160 }];
  const r = workOrderTotalCapRefusal({
    jobs,
    billedEx: new Map([[JOB, 2160]]),
    incomingEx: new Map([[JOB, 2160]]),
  });
  assert(r);
  assertEquals(r.jobs[0].most_this_invoice_ex, 0);
  assertStringIncludes(r.message, "billed in full");
});

Deno.test("cap: a job with no labour on this invoice, or not capped, is never refused", () => {
  const jobs = [{ jobId: JOB, ref: "SWF-1", allowedEx: 100 }];
  assertEquals(
    workOrderTotalCapRefusal({
      jobs,
      billedEx: new Map([[JOB, 500]]),
      incomingEx: new Map(),
    }),
    null,
  );
  assertEquals(
    workOrderTotalCapRefusal({
      jobs: [],
      billedEx: new Map(),
      incomingEx: new Map([[JOB, 999]]),
    }),
    null,
  );
});

Deno.test("incoming: every line but commission counts per job; deductions come off", () => {
  const out = incomingLabourByJob([
    { job_id: JOB, line_type: "work order", line_total_ex: 2160 },
    {
      job_id: JOB,
      line_type: "crew_work_order_deduction",
      line_total_ex: -400,
    },
    { job_id: JOB, line_type: "materials", line_total_ex: 300 },
    { job_id: JOB, line_type: "commission", line_total_ex: 500 },
    { job_id: JOB, line_type: "Travel", line_total_ex: 50 },
    { job_id: "", line_type: "labour", line_total_ex: 80 },
    { job_id: JOB, line_type: "decking", line_total_ex: 40 },
    {
      job_id: JOB,
      line_type: "travel_logistics_deduction",
      line_total_ex: -10,
    },
    { job_id: JOB, line_total_ex: 5 },
  ]);
  assertEquals(
    out.get(JOB),
    2145,
    "travel and materials count against the work order",
  );
  assertEquals(out.size, 1);
  assert(countsAgainstWorkOrder("Labour"));
  assert(countsAgainstWorkOrder("other"));
  assert(countsAgainstWorkOrder(null));
  assert(countsAgainstWorkOrder(" Materials "));
  assert(!countsAgainstWorkOrder("commission"));
  assert(countsAgainstWorkOrder("Travel"));
});

function fakeClient(
  opts: { lines?: any[]; lanes?: any[]; variations?: any[]; changes?: any[]; fail?: string },
) {
  return {
    from(table: string) {
      const rows = table === "trade_invoice_lines"
        ? opts.lines || []
        : table === "v_trade_charge_resolved"
        ? opts.lanes || []
        : table === "work_order_customer_variations"
        ? opts.variations || []
        : table === "work_order_amount_changes" ? opts.changes || [] : [];
      const q: any = {
        select: () => q,
        in: () => q,
        eq: () => q,
        not: () => q,
        order: () => q,
        range: () =>
          Promise.resolve(
            opts.fail === table
              ? { data: null, error: { message: "x" } }
              : { data: rows, error: null },
          ),
        then: (res: any, rej: any) =>
          Promise.resolve(
            opts.fail === table
              ? { data: null, error: { message: "x" } }
              : { data: rows, error: null },
          )
            .then(res, rej),
      };
      return q;
    },
  };
}

function line(id: string, status: string, type: string, amount: number) {
  return {
    id,
    trade_invoice_id: "inv-" + id,
    job_id: JOB,
    job_work_order_id: null,
    line_type: type,
    line_total_ex: amount,
    override_amount: null,
    trade_invoices: { id: "inv-" + id, user_id: "u", status },
  };
}

Deno.test("facts: billed labour counts live invoices only; approved customer variations add to the allowance", async () => {
  const lines = [
    line("1", "pushed_to_xero", "work order", 1000),
    line("2", "paid", "labour", 200),
    line("3", "draft", "work order", 5000),
    line("4", "ops-reject", "work order", 5000),
    line("5", "approved", "materials", 300),
    line("6", "approved", "decking", 50),
    line("7", "approved", "commission", 400),
  ];
  const lanes = lines.map((l) => ({
    line_id: l.id,
    cost_lane: l.line_type === "materials"
      ? "materials"
      : l.line_type === "decking"
      ? "unclassified"
      : l.line_type === "commission"
      ? "commission"
      : "labour",
  }));
  const variations = [
    {
      job_id: JOB,
      work_order_id: WO,
      status: "approved",
      trade_allocation_ex: 150,
    },
    {
      job_id: JOB,
      work_order_id: WO,
      status: "draft",
      trade_allocation_ex: 999,
    },
    {
      job_id: JOB,
      work_order_id: "other",
      status: "approved",
      trade_allocation_ex: 999,
    },
  ];
  const facts = await readWorkOrderCapFacts(
    fakeClient({ lines, lanes, variations }),
    [
      { jobId: JOB, ref: "SWF-1", agreedEx: 2000, workOrderId: WO },
    ],
  );
  assertEquals(
    facts.billedEx.get(JOB),
    1550,
    "every type but commission counts",
  );
  assertEquals(facts.jobs, [{ jobId: JOB, ref: "SWF-1", allowedEx: 2150 }]);
});

Deno.test("wiring: every door that saves or changes a trade line checks the cap before it writes", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const CALL = "await _assertWithinWorkOrderTotal(client, tradeUser, ";

  // generate_trade_invoice: after the M0 guard, before the invoice row.
  const m0 = src.indexOf("// ── END M0 GUARD");
  const genCap = src.indexOf(CALL, m0);
  const insert = src.indexOf("const invoicePayload = {", m0);
  assert(
    m0 > 0 && genCap > m0 && genCap < insert,
    "generate_trade_invoice checks before it writes",
  );

  // submit_work_order_invoice: before the claim that saves the invoice.
  const door = src.indexOf("case 'submit_work_order_invoice': {");
  const doorCap = src.indexOf(CALL + "workOrderLines)", door);
  const claim = src.indexOf("_claimWorkOrderInvoiceBeforeXero(", door);
  assert(
    door > 0 && doorCap > door && doorCap < claim,
    "the crew work order door checks before it saves",
  );

  // review_crew_charge adjust: the new amount replaces the old, before the update.
  const review = src.indexOf("case 'review_crew_charge': {");
  const adjust = src.indexOf("reviewAction === 'adjust'", review);
  const adjustCap = src.indexOf(CALL, adjust);
  const update = src.indexOf(
    ".from('trade_invoice_lines').update(updates)",
    review,
  );
  assert(
    adjust > 0 && adjustCap > adjust && adjustCap < update,
    "a lead's adjust checks before it writes",
  );
  assertStringIncludes(
    src.slice(adjustCap, update),
    "[String(line_id)], true)",
  );
  assertStringIncludes(src.slice(adjust, adjustCap), "> oldAmount");

  // The guard: 409 over, 503 unreadable, nothing saved either way.
  const guardAt = src.indexOf(
    "export async function _assertWithinWorkOrderTotal(",
  );
  assert(guardAt > 0);
  const guard = src.slice(
    guardAt,
    src.indexOf("\nexport async function ", guardAt + 10),
  );
  assertStringIncludes(guard, "throw new ApiError(refusal.message, 409, {");
  assertStringIncludes(guard, "saved: false");
  assertStringIncludes(guard, "'work_order_cap_unavailable'");
});

Deno.test("facts: an unreadable read refuses, never reads as nothing billed", async () => {
  for (
    const table of [
      "trade_invoice_lines",
      "v_trade_charge_resolved",
      "work_order_customer_variations",
    ]
  ) {
    await assertRejects(
      () =>
        readWorkOrderCapFacts(
          fakeClient({
            fail: table,
            lines: [line("1", "approved", "work order", 100)],
          }),
          [
            { jobId: JOB, ref: "SWF-1", agreedEx: 2000, workOrderId: WO },
          ],
        ),
      WorkOrderTotalCapReadError,
    );
  }
});

const MODE = {
  job_id: JOB,
  invoice_mode: "work_order",
  work_order_agreed_ex: 2000,
  job_work_order_id: WO,
};
const refs = () => Promise.resolve(new Map([[JOB, "SWF-1"]]));

Deno.test("check: a new line over what is left is refused; a hourly job is never read", async () => {
  const client = fakeClient({
    lines: [line("1", "approved", "work order", 1500)],
  });
  const over = await checkWorkOrderTotalCap(client, {
    viewerId: "u",
    lines: [{ job_id: JOB, line_type: "decking", line_total_ex: 600 }],
    loadModes: () => Promise.resolve([MODE]),
    jobRefs: refs,
  });
  assertEquals(over?.jobs, [{
    job: "SWF-1",
    job_id: JOB,
    most_this_invoice_ex: 500,
  }]);
  const hourly = await checkWorkOrderTotalCap(client, {
    viewerId: "u",
    lines: [{ job_id: JOB, line_type: "labour", line_total_ex: 9999 }],
    loadModes: () => Promise.resolve([{ ...MODE, invoice_mode: "hourly" }]),
    jobRefs: refs,
  });
  assertEquals(hourly, null);
  let read = false;
  await checkWorkOrderTotalCap(client, {
    viewerId: "u",
    lines: [{ job_id: JOB, line_type: "commission", line_total_ex: 9999 }],
    loadModes: () => {
      read = true;
      return Promise.resolve([MODE]);
    },
    jobRefs: refs,
  });
  assertEquals(read, false, "commission alone never reads the work order");
});

Deno.test("check: a lead's adjust replaces the line's old amount, never adds to it", async () => {
  const client = fakeClient({
    lines: [
      line("lead", "approved", "work order", 1600),
      line("crew", "pending_acknowledgment", "labour", 400),
    ],
  });
  const same = await checkWorkOrderTotalCap(client, {
    viewerId: "u",
    lines: [{ job_id: JOB, line_type: "labour", line_total_ex: 400 }],
    loadModes: () => Promise.resolve([MODE]),
    jobRefs: refs,
    excludeLineIds: ["crew"],
  });
  assertEquals(same, null);
  const raised = await checkWorkOrderTotalCap(client, {
    viewerId: "u",
    lines: [{ job_id: JOB, line_type: "labour", line_total_ex: 5000 }],
    loadModes: () => Promise.resolve([MODE]),
    jobRefs: refs,
    excludeLineIds: ["crew"],
  });
  assertEquals(raised?.jobs[0].most_this_invoice_ex, 400);
});

Deno.test("check: a deduction raised to 0 is checked; without force it would slip through", async () => {
  const client = fakeClient({
    lines: [
      line("lead", "approved", "work order", 2000),
      line("crew", "approved", "labour", 400),
      line("ded", "approved", "crew_work_order_deduction", -400),
    ],
  });
  const raised = {
    lines: [{
      job_id: JOB,
      line_type: "crew_work_order_deduction",
      line_total_ex: 0,
    }],
    loadModes: () => Promise.resolve([MODE]),
    jobRefs: refs,
    excludeLineIds: ["ded"],
  };
  assertEquals(
    await checkWorkOrderTotalCap(client, raised),
    null,
    "unforced: 0 is never checked",
  );
  const forced = await checkWorkOrderTotalCap(client, {
    viewerId: "u",
    ...raised,
    force: true,
  });
  assertEquals(forced?.code, "work_order_total_over_agreed");
  assertEquals(forced?.jobs[0].most_this_invoice_ex, 0);
});

Deno.test("list: an approved work order with its amount carries the cap the doors refuse by; others carry null", async () => {
  const lines = [
    line("1", "pushed_to_xero", "work order", 1000),
    line("2", "approved", "travel", 300),
    line("3", "approved", "commission", 400),
    line("4", "draft", "work order", 900),
  ];
  const lanes = lines.map((l) => ({ line_id: l.id, cost_lane: "labour" }));
  const variations = [
    {
      job_id: JOB,
      work_order_id: WO,
      status: "approved",
      trade_allocation_ex: 100,
    },
  ];
  const out = await withWorkOrderCaps(
    fakeClient({ lines, lanes, variations }),
    {
      schema: "job-work-orders.v1",
      work_orders: [
        {
          id: WO,
          job_id: JOB,
          job_number: "SWF-1",
          status: "approved",
          agreed_labour_ex: 1200,
        },
        {
          id: "draft-wo",
          job_id: "j2",
          status: "draft",
          agreed_labour_ex: null,
        },
      ],
    },
  );
  assertEquals(out.cap_read, "ok");
  assertEquals(out.work_orders[0].cap, {
    allowed_ex: 1300,
    billed_ex: 1300,
    remaining_ex: 0,
    billed_in_full: true,
    over: false,
  });
  assertEquals(out.work_orders[1].cap, null);
  assertEquals(out.schema, "job-work-orders.v1");
});

Deno.test("list: over the work order says so, with a negative remainder", async () => {
  const lines = [line("1", "paid", "work order", 1500)];
  const lanes = [{ line_id: "1", cost_lane: "labour" }];
  const out = await withWorkOrderCaps(fakeClient({ lines, lanes }), {
    work_orders: [{
      id: WO,
      job_id: JOB,
      status: "approved",
      agreed_labour_ex: 1000,
    }],
  });
  assertEquals(out.work_orders[0].cap.over, true);
  assertEquals(out.work_orders[0].cap.remaining_ex, -500);
});

Deno.test("list: a failed read never reads as nothing billed", async () => {
  const out = await withWorkOrderCaps(
    fakeClient({
      lines: [line("1", "paid", "work order", 1)],
      fail: "trade_invoice_lines",
    }),
    {
      work_orders: [{
        id: WO,
        job_id: JOB,
        status: "approved",
        agreed_labour_ex: 1000,
      }],
    },
  );
  assertEquals(out.cap_read, "failed");
  assertEquals(out.work_orders[0].cap, null);
});

// Ruling 17c: a job paid hourly up to the maximum its job budget seals is
// capped by this same guard, counted the same way, with the same codes.
const HOURLY = {
  job_id: JOB,
  invoice_mode: "hourly",
  invoice_mode_reason: "hourly_capped",
  work_order_agreed_ex: null,
  job_work_order_id: null,
};
const limitsOf = (limit: number) => (ids: string[]) =>
  Promise.resolve(new Map(ids.map((id) => [id, limit] as [string, number])));

Deno.test("hourly: within the sealed maximum passes; one cent over is refused by the work order cap's code, naming the hourly maximum", async () => {
  // 10 hours at $80 sealed = $800, plus a $100 raise = $900.
  const client = fakeClient({
    lines: [
      line("1", "approved", "labour", 500),
      line("2", "draft", "labour", 5000),
      line("3", "approved", "commission", 999),
    ],
  });
  const ok = await checkWorkOrderTotalCap(client, {
    viewerId: "u",
    lines: [{ job_id: JOB, line_type: "labour", line_total_ex: 400 }],
    loadModes: () => Promise.resolve([HOURLY]),
    loadHourlyLimits: limitsOf(900),
    jobRefs: refs,
  });
  assertEquals(ok, null, "a draft and commission hold nothing");
  const over = await checkWorkOrderTotalCap(client, {
    viewerId: "u",
    lines: [{ job_id: JOB, line_type: "labour", line_total_ex: 400.01 }],
    loadModes: () => Promise.resolve([HOURLY]),
    loadHourlyLimits: limitsOf(900),
    jobRefs: refs,
  });
  assert(over);
  assertEquals(over.code, "work_order_total_over_agreed");
  assertEquals(over.jobs, [{
    job: "SWF-1",
    job_id: JOB,
    most_this_invoice_ex: 400,
    limit: "hourly_maximum",
    hourly_maximum_ex: 900,
  }]);
  assertStringIncludes(over.message, "paid by the hour, and its work order pays the crew at most $900.00");
  assertStringIncludes(over.message, "can bill at most $400.00 more");
  assertStringIncludes(over.message, "A higher hourly rate does not raise");
  assertEquals(
    over.message.includes("500"),
    false,
    "never names what others billed",
  );
});

Deno.test("hourly: a trade's own higher rate never raises the maximum; hours over at any rate are refused by dollars", async () => {
  // Sealed 10 hours at $80 = $800; the trade bills 9 hours at $95 = $855.
  const r = await checkWorkOrderTotalCap(fakeClient({ lines: [] }), {
    viewerId: "u",
    lines: [{ job_id: JOB, line_type: "labour", line_total_ex: 9 * 95 }],
    loadModes: () => Promise.resolve([HOURLY]),
    loadHourlyLimits: limitsOf(800),
    jobRefs: refs,
  });
  assertEquals(r?.jobs[0].most_this_invoice_ex, 800);
});

Deno.test("hourly: counted like the work order cap; every line but commission, deductions off, a replaced line excluded", async () => {
  const client = fakeClient({
    lines: [
      line("a", "pushed_to_xero", "labour", 600),
      line("b", "approved", "travel", 100),
      line("c", "approved", "crew_work_order_deduction", -50),
      line("d", "ops-reject", "labour", 900),
      line("e", "approved", "labour", 200),
    ],
  });
  assertEquals(
    (await readBilledOnJobs(client, [JOB], { excludeLineIds: ["e"] })).get(JOB),
    650,
  );
  const adjust = await checkWorkOrderTotalCap(client, {
    viewerId: "u",
    lines: [{ job_id: JOB, line_type: "labour", line_total_ex: 250 }],
    loadModes: () => Promise.resolve([HOURLY]),
    loadHourlyLimits: limitsOf(900),
    jobRefs: refs,
    excludeLineIds: ["e"],
  });
  assertEquals(
    adjust,
    null,
    "650 billed plus the changed line's 250 is the 900 maximum",
  );
  const raisedDeduction = await checkWorkOrderTotalCap(client, {
    viewerId: "u",
    lines: [{
      job_id: JOB,
      line_type: "crew_work_order_deduction",
      line_total_ex: 0,
    }],
    loadModes: () => Promise.resolve([HOURLY]),
    loadHourlyLimits: limitsOf(650),
    jobRefs: refs,
    excludeLineIds: ["c"],
    force: true,
  });
  assertEquals(raisedDeduction?.jobs[0].most_this_invoice_ex, 0);
});

Deno.test("hourly: an unreadable maximum or billed read refuses as unreadable, never lets labour through", async () => {
  const lines = [{ job_id: JOB, line_type: "labour", line_total_ex: 1 }];
  const base = {
    lines,
    loadModes: () => Promise.resolve([HOURLY]),
    jobRefs: refs,
  };
  const client = fakeClient({ lines: [] });
  await assertRejects(
    () => checkWorkOrderTotalCap(client, base),
    WorkOrderTotalCapReadError,
    undefined,
    "no limit reader",
  );
  await assertRejects(
    () =>
      checkWorkOrderTotalCap(client, {
    viewerId: "u",
        ...base,
        loadHourlyLimits: () => Promise.resolve(new Map()),
      }),
    WorkOrderTotalCapReadError,
    undefined,
    "a capped job with no limit",
  );
  for (const bad of [NaN, -1, Infinity]) {
    await assertRejects(
      () =>
        checkWorkOrderTotalCap(client, {
    viewerId: "u",
          ...base,
          loadHourlyLimits: limitsOf(bad),
        }),
      WorkOrderTotalCapReadError,
    );
  }
  await assertRejects(
    () =>
      checkWorkOrderTotalCap(client, {
    viewerId: "u",
        ...base,
        loadHourlyLimits: () =>
          Promise.reject(new WorkOrderTotalCapReadError()),
      }),
    WorkOrderTotalCapReadError,
  );
  await assertRejects(
    () =>
      checkWorkOrderTotalCap(fakeClient({ fail: "trade_invoice_lines" }), {
    viewerId: "u",
        ...base,
        loadHourlyLimits: limitsOf(900),
      }),
    WorkOrderTotalCapReadError,
  );
});

Deno.test("hourly: only the hourly_capped reason is capped; a plain hourly job reads no limit", async () => {
  assert(isHourlyCappedMode(HOURLY));
  assert(!isHourlyCappedMode({ ...HOURLY, invoice_mode_reason: "other_job" }));
  assert(!isHourlyCappedMode({ ...HOURLY, invoice_mode: "work_order" }));
  let asked = false;
  const r = await checkWorkOrderTotalCap(fakeClient({ lines: [] }), {
    viewerId: "u",
    lines: [{ job_id: JOB, line_type: "labour", line_total_ex: 99999 }],
    loadModes: () =>
      Promise.resolve([{ ...HOURLY, invoice_mode_reason: "other_job" }]),
    loadHourlyLimits: () => {
      asked = true;
      return Promise.resolve(new Map());
    },
    jobRefs: refs,
  });
  assertEquals([r, asked], [null, false]);
});

Deno.test("hourly: a work order job beside it keeps the work order's own limit and message", async () => {
  const JOB2 = "00000000-0000-4000-8000-000000000002";
  const client = fakeClient({ lines: [] });
  const r = await checkWorkOrderTotalCap(client, {
    viewerId: "u",
    lines: [
      { job_id: JOB, line_type: "work order", line_total_ex: 2001 },
      { job_id: JOB2, line_type: "labour", line_total_ex: 801 },
    ],
    loadModes: () => Promise.resolve([MODE, { ...HOURLY, job_id: JOB2 }]),
    loadHourlyLimits: limitsOf(800),
    jobRefs: () => Promise.resolve(new Map([[JOB, "SWF-1"], [JOB2, "SWF-2"]])),
  });
  assertEquals(r?.jobs, [
    { job: "SWF-1", job_id: JOB, most_this_invoice_ex: 2000 },
    {
      job: "SWF-2",
      job_id: JOB2,
      most_this_invoice_ex: 800,
      limit: "hourly_maximum",
      hourly_maximum_ex: 800,
    },
  ]);
  assertStringIncludes(
    r!.message,
    "Job SWF-1: this invoice can bill at most $2,000.00 on its work order.",
  );
  assertStringIncludes(r!.message, "Job SWF-2: it is paid by the hour");
});

Deno.test("list: an hourly job's row shows the limit the doors refuse by; a failed limit read fails the cap column", async () => {
  const lines = [line("1", "approved", "labour", 300)];
  const listing = () => ({
    work_orders: [{
      id: WO,
      job_id: JOB,
      status: "approved",
      agreed_labour_ex: 1000,
    }],
  });
  const out = await withWorkOrderCaps(fakeClient({ lines }), listing(), {
    hourlyLimits: limitsOf(900),
  });
  assertEquals(out.work_orders[0].cap, {
    allowed_ex: 900,
    billed_ex: 300,
    remaining_ex: 600,
    billed_in_full: false,
    over: false,
    limit: "hourly_maximum",
  });
  const notHourly = await withWorkOrderCaps(fakeClient({ lines }), listing(), {
    hourlyLimits: () => Promise.resolve(new Map()),
  });
  assertEquals(notHourly.work_orders[0].cap.allowed_ex, 1000);
  assertEquals("limit" in notHourly.work_orders[0].cap, false);
  const failed = await withWorkOrderCaps(fakeClient({ lines }), listing(), {
    hourlyLimits: () => Promise.reject(new Error("x")),
  });
  assertEquals([failed.cap_read, failed.work_orders[0].cap], ["failed", null]);
});

Deno.test("ZZTEST reimbursement is outside an exhausted job cap", () => {
  const incomingEx = incomingLabourByJob([{ job_id: JOB, line_type: "reimbursement", line_total_ex: 80 }]);
  assertEquals(workOrderTotalCapRefusal({ jobs: [{ jobId: JOB, ref: "ZZTEST-01", allowedEx: 1120 }], billedEx: new Map([[JOB, 1120]]), incomingEx }), null);
});

Deno.test("ZZTEST changed work order: cap follows the change to the cent and read failures refuse", async () => {
  const client = fakeClient({ changes: [{ work_order_id: WO, delta_ex: 224 }],
    lines: [line("ZZTEST-line", "approved", "labour", 1120)] });
  const check = (amount: number) => checkWorkOrderTotalCap(client, {
    viewerId: "u",
    lines: [{ job_id: JOB, line_type: "labour", line_total_ex: amount }],
    loadModes: async () => [{ job_id: JOB, invoice_mode: "work_order", work_order_agreed_ex: 1120, job_work_order_id: WO }],
    jobRefs: async () => new Map([[JOB, "ZZTEST-P2"]]),
  });
  assertEquals(await check(224), null);
  assertEquals((await check(224.01))?.jobs[0].most_this_invoice_ex, 224);
  await assertRejects(() => readWorkOrderCapFacts(fakeClient({ fail: "work_order_amount_changes" }),
    [{ jobId: JOB, ref: "ZZTEST-P2", agreedEx: 1120, workOrderId: WO }]), WorkOrderTotalCapReadError);
});

Deno.test("hold switch uses the database guard's billed total and excludes an edited line", async () => {
  const replaced = "00000000-0000-4000-8000-0000000000b1";
  const client = {
    from(table: string) {
      if (table !== "feature_flags") return fakeClient({}).from(table);
      return { select: () => ({ eq: (key: string, value: string) => {
        assertEquals([key, value], ["flag_name", "trade_line_hold_v1"]);
        return { data: [{ enabled: true }] };
      } }) };
    },
    rpc(name: string, args: unknown) {
      assertEquals(name, "work_order_backed_billed");
      assertEquals(args, { p_job_ids: [JOB], p_exclude_line_ids: [replaced] });
      return { data: [{ job_id: JOB, billed_ex: 3.25 }] };
    },
  };
  const check = (amount: number) => checkWorkOrderTotalCap(client, {
    viewerId: "u",
    loadModes: async () => [{ ...MODE, work_order_agreed_ex: 5 }],
    jobRefs: refs,
    lines: [{ job_id: JOB, line_type: "labour", line_total_ex: amount }],
    excludeLineIds: [replaced],
  });
  assertEquals(await check(1.75), null);
  assertEquals((await check(1.76))?.code, "work_order_total_over_agreed");

  for (const result of [
    { data: [] }, { data: [{ job_id: JOB, billed_ex: null }] },
    { data: [{ job_id: WO, billed_ex: 0 }] }, { data: null, error: { code: "XX000" } },
  ]) {
    await assertRejects(() => readBilledOnJobs({ ...client, rpc: () => result }, [JOB]),
      WorkOrderTotalCapReadError);
  }
  await assertRejects(() => readBilledOnJobs({
    from: () => ({ select: () => ({ eq: () => ({ error: { code: "XX000" } }) }) }),
  }, [JOB]), WorkOrderTotalCapReadError);
});

Deno.test("P1-05.8: the cap reader ignores a holding invoice's lines; standard and follow_on count", async () => {
  const held = line("h1", "pending_ops_review", "labour", 700);
  (held.trade_invoices as any).invoice_kind = "held";
  const standard = line("s1", "pending_acknowledgment", "labour", 300);
  (standard.trade_invoices as any).invoice_kind = "standard";
  const followOn = line("f1", "approved", "labour", 50);
  (followOn.trade_invoices as any).invoice_kind = "follow_on";
  const lines = [held, standard, followOn];
  const lanes = lines.map((l) => ({ line_id: l.id, cost_lane: "labour" }));
  const facts = await readWorkOrderCapFacts(
    fakeClient({ lines, lanes, variations: [] }),
    [{ jobId: JOB, ref: "SWF-1", agreedEx: 2000, workOrderId: WO }],
  );
  assertEquals(facts.billedEx.get(JOB), 350);
  const billed = await readBilledOnJobs(
    fakeClient({ lines, lanes, variations: [] }),
    [JOB],
  );
  assertEquals(billed.get(JOB), 350);
});

// FU49-9b: with the held-line switch on, the office list says whether each job is under the
// cap at all (work_order_cap_scope). Off, the answer is exactly as before, with no scope read.
Deno.test("list: in_cap_scope only with the hold switch on; off reads no scope; a failed scope read fails the cap column", async () => {
  const OTHER = "00000000-0000-4000-8000-0000000000c2";
  const listing = () => ({
    work_orders: [
      { id: WO, job_id: JOB, status: "approved", agreed_labour_ex: 1000 },
      { id: "wo-2", job_id: OTHER, status: "approved", agreed_labour_ex: 500 },
    ],
  });
  const lines = [line("1", "paid", "work order", 100)];
  const lanes = [{ line_id: "1", cost_lane: "labour" }];
  const withSwitch = (on: boolean, scope: (ids: string[]) => any, calls: string[][]) => {
    const base = fakeClient({ lines, lanes });
    return {
      from(table: string) {
        if (table !== "feature_flags") return base.from(table);
        return { select: () => ({ eq: () => Promise.resolve({ data: [{ enabled: on }], error: null }) }) };
      },
      rpc(name: string, args: any) {
        if (name === "work_order_cap_scope") {
          calls.push(args.p_job_ids);
          return Promise.resolve(scope(args.p_job_ids));
        }
        if (name === "work_order_backed_billed") {
          return Promise.resolve({ data: args.p_job_ids.map((job_id: string) => ({ job_id, billed_ex: job_id === JOB ? 100 : 0 })), error: null });
        }
        throw new Error(`ZZTEST unexpected rpc ${name}`);
      },
    };
  };
  const answer = (ids: string[]) => ({ data: ids.map((job_id) => ({ job_id, in_scope: job_id === JOB })), error: null });

  const offCalls: string[][] = [];
  const off = await withWorkOrderCaps(withSwitch(false, answer, offCalls), listing());
  const before = await withWorkOrderCaps(fakeClient({ lines, lanes }), listing());
  assertEquals(offCalls, []);
  assertEquals(off, before);
  assertEquals(off.work_orders.map((w: any) => "in_cap_scope" in w.cap), [false, false]);

  const onCalls: string[][] = [];
  const on = await withWorkOrderCaps(withSwitch(true, answer, onCalls), listing());
  assertEquals(on.cap_read, "ok");
  assertEquals(onCalls.length, 1);
  assertEquals(on.work_orders.map((w: any) => w.cap.in_cap_scope), [true, false]);
  // The figures themselves are unchanged; only the marker is added.
  assertEquals(on.work_orders.map((w: any) => w.cap.allowed_ex), [1000, 500]);

  for (const bad of [() => ({ data: null, error: { message: "ZZTEST" } }), () => ({ data: [], error: null })]) {
    const failed = await withWorkOrderCaps(withSwitch(true, bad, []), listing());
    assertEquals(failed.cap_read, "failed");
    assertEquals(failed.work_orders.map((w: any) => w.cap), [null, null]);
  }
  const flagFails = {
    ...withSwitch(true, answer, []),
    from(table: string) {
      if (table !== "feature_flags") return fakeClient({ lines, lanes }).from(table);
      return { select: () => ({ eq: () => Promise.resolve({ data: null, error: { message: "ZZTEST" } }) }) };
    },
  };
  assertEquals((await withWorkOrderCaps(flagFails, listing())).cap_read, "failed");
});

// Director ruling, 18 Nov 2026: the remainder is the allowance less what every
// trade billed, so it is shown only on a job where every billed line is the
// trade's own. Made-up amounts; roles only.
function tradeLine(id: string, userId: string, amount: number) {
  return { ...line(id, "approved", "labour", amount), trade_invoices: { id: "inv-" + id, user_id: userId, status: "approved" } };
}

Deno.test("shared job: the figure shows only when every billed line is the trade's own", async () => {
  const send = (lines: any[], viewerId: string | undefined) =>
    checkWorkOrderTotalCap(fakeClient({ lines }), {
      viewerId,
      lines: [{ job_id: JOB, line_type: "labour", line_total_ex: 900 }],
      loadModes: () => Promise.resolve([MODE]),
      jobRefs: refs,
    });
  // Two trades on one job. Trade A billed alone so far: A sees the figure.
  const own = await send([tradeLine("a1", "trade-a", 1500)], "trade-a");
  assertEquals(own?.jobs, [{ job: "SWF-1", job_id: JOB, most_this_invoice_ex: 500 }]);
  assert(own?.message.includes("$500.00"));
  // Trade B billed on it too: neither trade sees a figure.
  const lines = [tradeLine("a1", "trade-a", 1000), tradeLine("b1", "trade-b", 500)];
  for (const viewer of ["trade-a", "trade-b"]) {
    const shared = await send(lines, viewer);
    assertEquals(shared?.code, "work_order_total_over_agreed");
    assertEquals(shared?.jobs, [{ job: "SWF-1", job_id: JOB, amount_hidden: true }]);
    assertEquals(shared?.message, "This invoice is more than the agreed work order total. Ask the office.");
    assert(!/\$|\d/.test(shared?.message ?? ""), "no figure in the words");
  }
  // A draft or rejected invoice of another trade holds nothing and hides nothing.
  const draftOther = await send([
    tradeLine("a1", "trade-a", 1500),
    { ...line("b1", "draft", "labour", 500), trade_invoices: { id: "inv-b1", user_id: "trade-b", status: "draft" } },
  ], "trade-a");
  assertEquals(draftOther?.jobs[0].most_this_invoice_ex, 500);
  // Nothing billed yet and within the allowance: no refusal at all.
  assertEquals(await send([], "trade-a"), null);
  // No viewer named: never a figure.
  assertEquals((await send([tradeLine("a1", "trade-a", 1500)], undefined))?.jobs[0].amount_hidden, true);
});

Deno.test("shared job: an unreadable owner read hides the figure, never shows it on a guess", async () => {
  let calls = 0;
  const base = fakeClient({ lines: [tradeLine("a1", "trade-a", 1500)] });
  const flaky = {
    from(table: string) {
      if (table === "trade_invoice_lines" && ++calls > 1) {
        return fakeClient({ fail: "trade_invoice_lines" }).from(table);
      }
      return base.from(table);
    },
  };
  const r = await checkWorkOrderTotalCap(flaky, {
    viewerId: "trade-a",
    lines: [{ job_id: JOB, line_type: "labour", line_total_ex: 900 }],
    loadModes: () => Promise.resolve([MODE]),
    jobRefs: refs,
  });
  assertEquals(r?.jobs, [{ job: "SWF-1", job_id: JOB, amount_hidden: true }]);
});

Deno.test("words: one label table; the shared-job words carry no figure, no code, no name", () => {
  assertEquals(WORK_ORDER_CAP_WORDS.shared_job, "This invoice is more than the agreed work order total. Ask the office.");
  for (const words of [
    WORK_ORDER_CAP_WORDS.shared_job,
    WORK_ORDER_CAP_WORDS.room("SWF-1", "$1.00"),
    WORK_ORDER_CAP_WORDS.billed_in_full("SWF-1"),
    WORK_ORDER_CAP_WORDS.hourly_room("SWF-1", "$2.00", "$1.00"),
    WORK_ORDER_CAP_WORDS.hourly_billed_in_full("SWF-1", "$2.00"),
  ]) {
    assert(!/_|\u2014/.test(words), words);
  }
  // Two hidden jobs say the figureless sentence once.
  const r = workOrderTotalCapRefusal({
    jobs: [
      { jobId: "j1", ref: "SWF-1", allowedEx: 100 },
      { jobId: "j2", ref: "SWF-2", allowedEx: 100 },
    ],
    billedEx: new Map([["j1", 100], ["j2", 100]]),
    incomingEx: new Map([["j1", 10], ["j2", 10]]),
    amountShown: () => false,
  });
  assertEquals(r?.message, WORK_ORDER_CAP_WORDS.shared_job);
});
