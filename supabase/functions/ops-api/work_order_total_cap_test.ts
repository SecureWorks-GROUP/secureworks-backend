// deno-lint-ignore-file no-import-prefix no-explicit-any
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  incomingLabourByJob,
  isWorkOrderLabourLineType,
  readWorkOrderCapFacts,
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

Deno.test("incoming: labour lane lines add up per job, crew deductions come off", () => {
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
  ]);
  assertEquals(out.get(JOB), 1760);
  assertEquals(out.size, 1);
  assert(isWorkOrderLabourLineType("Labour"));
  assert(!isWorkOrderLabourLineType("group share"));
});

function fakeClient(
  opts: { lines?: any[]; lanes?: any[]; variations?: any[]; fail?: string },
) {
  return {
    from(table: string) {
      const rows = table === "trade_invoice_lines"
        ? opts.lines || []
        : table === "v_trade_charge_resolved"
        ? opts.lanes || []
        : table === "work_order_customer_variations"
        ? opts.variations || []
        : [];
      const q: any = {
        select: () => q,
        in: () => q,
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
  ];
  const lanes = lines.map((l) => ({
    line_id: l.id,
    cost_lane: l.line_type === "materials" ? "materials" : "labour",
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
  assertEquals(facts.billedEx.get(JOB), 1200);
  assertEquals(facts.jobs, [{ jobId: JOB, ref: "SWF-1", allowedEx: 2150 }]);
});

Deno.test("wiring: generate_trade_invoice checks the cap after the M0 guard and before anything is saved", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const m0 = src.indexOf("// ── END M0 GUARD");
  const cap = src.indexOf("const capRefusal = workOrderTotalCapRefusal(", m0);
  const insert = src.indexOf("const invoicePayload = {", m0);
  assert(m0 > 0 && cap > m0, "the cap must sit after the M0 guard");
  assert(insert > cap, "the cap must refuse before the invoice is written");
  const block = src.slice(m0, insert);
  assertStringIncludes(block, "throw new ApiError(capRefusal.message, 409, {");
  assertStringIncludes(block, "saved: false");
  assertStringIncludes(block, "'work_order_cap_unavailable'");
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
