// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  auditShapedCohort,
  billJobNumberFields,
  classifyJobNumberMatch,
  extractJobNumberTokens,
  isTradeMirrorBill,
  jobProfitBillQueueCallerAllowed,
  jobProfitLinkBillAction,
  jobProfitUnmatchedBillsAction,
  summariseSupplierBills,
} from "./job_profit_bill_match.ts";

const JOB = "a7600000-0000-4000-8000-000000000001";
const OTHER = "a7600000-0000-4000-8000-000000000002";
const BILL = "a7610000-0000-4000-8000-000000000001";

function known(numbers: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  numbers.forEach((number, i) => {
    map.set(number, [`00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`]);
  });
  return map;
}

Deno.test("job numbers match only the exact pattern", () => {
  assertEquals(extractJobNumberTokens("Materials for SWF-261308 thanks"), ["SWF-261308"]);
  assertEquals(extractJobNumberTokens("ref swf-261308"), ["SWF-261308"]);
  assertEquals(extractJobNumberTokens("SWMS-261114 roof"), ["SWMS-261114"]);
  assertEquals(extractJobNumberTokens("SWP-261247 and SWF-261305"), ["SWP-261247", "SWF-261305"]);

  for (const text of [
    "PO-54000",
    "INV-0850",
    "SWF-PDF-BUCKET",
    "SWF-2613081",
    "SW - FENCING",
    "Business Unit",
    "XSWF-261308",
    "see SWF-261",
    "",
  ]) {
    assertEquals(extractJobNumberTokens(text), [], text);
  }
});

Deno.test("a bill is exact from line text, reference or tracking", () => {
  const jobs = known(["SWF-261308", "SWP-261247"]);
  const fromLine = billJobNumberFields({
    reference: "PO-54000",
    line_items: [{ Description: "Timber SWF-261308", Tracking: [{ Name: "Business Unit", Option: "SW - FENCING" }] }],
  });
  assertEquals(fromLine.lines, ["SWF-261308"]);
  assertEquals(fromLine.reference, []);
  assertEquals(fromLine.tracking, []);
  assertEquals(classifyJobNumberMatch(fromLine.all, jobs).outcome, "exact");
  assertEquals(classifyJobNumberMatch(fromLine.all, jobs).job_number, "SWF-261308");

  const fromRef = billJobNumberFields({ reference: "SWP-261247", line_items: [] });
  assertEquals(fromRef.reference, ["SWP-261247"]);
  assertEquals(classifyJobNumberMatch(fromRef.all, jobs).outcome, "exact");

  const fromTrack = billJobNumberFields({
    reference: null,
    line_items: [{ description: "Sheets", tracking: [{ name: "Job", option: "swf-261308" }] }],
  });
  assertEquals(fromTrack.tracking, ["SWF-261308"]);
  assertEquals(classifyJobNumberMatch(fromTrack.all, jobs).job_number, "SWF-261308");
});

Deno.test("two real job numbers are ambiguous and an unknown token is not a guess", () => {
  const jobs = known(["SWF-261041", "SWF-261042", "SWF-261308"]);
  const both = classifyJobNumberMatch(
    extractJobNumberTokens("SWF-261042 then SWF-261041"),
    jobs,
  );
  assertEquals(both.outcome, "ambiguous");
  assertEquals(both.job_id, null);
  assertEquals(both.real_job_numbers, ["SWF-261041", "SWF-261042"]);

  const unknown = classifyJobNumberMatch(["SWF-999001"], jobs);
  assertEquals(unknown.outcome, "unmatched");
  assertEquals(unknown.job_id, null);

  const oneReal = classifyJobNumberMatch(["SWF-261308", "SWF-999001"], jobs);
  assertEquals(oneReal.outcome, "exact");
  assertEquals(oneReal.job_number, "SWF-261308");

  const doubled = new Map(jobs);
  doubled.set("SWF-261308", ["id-a", "id-b"]);
  const multi = classifyJobNumberMatch(["SWF-261308"], doubled);
  assertEquals(multi.outcome, "ambiguous");
  assertEquals(multi.job_id, null);

  const none = classifyJobNumberMatch(
    extractJobNumberTokens("PO-54000 SW - FENCING INV-0850"),
    jobs,
  );
  assertEquals(none.outcome, "unmatched");
  assertEquals(none.tokens, []);
});

Deno.test("a trade mirror is excluded and a make-safe number is not read as SW-", () => {
  assertEquals(
    extractJobNumberTokens("report SWMS-261114"),
    ["SWMS-261114"],
  );
  assert(!extractJobNumberTokens("report SWMS-261114").includes("SW-261114"));
  const tradeIds = new Set(["BILL-T1"]);
  assert(isTradeMirrorBill("BILL-T1", [], tradeIds));
  assert(isTradeMirrorBill("BILL-S1", [{ Description: "JP-FENCE | SW - FENCING\nLabour" }], new Set()));
  assert(!isTradeMirrorBill("BILL-S1", [{ Description: "Sheets SWF-261308", Tracking: [{ Option: "SW - FENCING" }] }], new Set()));
});

Deno.test("the audit-shaped cohort matches the audit's figures and writes none of the ambiguous bills", () => {
  const { bills, jobsByNumber } = auditShapedCohort();
  const summary = summariseSupplierBills(bills, jobsByNumber);
  assertEquals(summary.scanned, 653);
  assertEquals(summary.trade_mirrors_excluded, 4);
  assertEquals(summary.already_linked, 33);
  assertEquals(summary.already_linked + summary.exact_unique + summary.ambiguous + summary.unmatched, 649);
  assertEquals(summary.line_text_hits, 53);
  assertEquals(summary.reference_hits, 0);
  assertEquals(summary.tracking_hits, 0);
  assertEquals(summary.exact_unique, 40);
  assertEquals(summary.ambiguous, 8);
  assertEquals(summary.unmatched, 568);
  assertEquals(summary.apply_count, 40);
  assert(summary.apply_count <= summary.line_text_hits);
});

type Call = { table: string; op: string };

function queueFake(tables: Record<string, any[]>, errors: Record<string, string> = {}) {
  const calls: Call[] = [];
  const client = {
    calls,
    from(table: string) {
      let rows = [...(tables[table] ?? [])];
      let window: [number, number] | null = null;
      const builder: any = {
        select: () => builder,
        order: () => builder,
        limit: (n: number) => {
          rows = rows.slice(0, n);
          return builder;
        },
        gte: (col: string, val: unknown) => {
          rows = rows.filter((row) => row[col] != null && String(row[col]) >= String(val));
          return builder;
        },
        eq: (col: string, val: unknown) => {
          rows = rows.filter((row) => row[col] === val);
          return builder;
        },
        in: (col: string, vals: unknown[]) => {
          rows = rows.filter((row) => vals.includes(row[col]));
          return builder;
        },
        is: (col: string, val: unknown) => {
          rows = rows.filter((row) => val === null ? row[col] == null : row[col] === val);
          return builder;
        },
        range: (from: number, to: number) => {
          window = [from, to];
          return builder;
        },
        update: () => {
          calls.push({ table, op: "update" });
          return builder;
        },
        insert: () => {
          calls.push({ table, op: "insert" });
          return builder;
        },
        then: (resolve: (value: unknown) => unknown) => {
          calls.push({ table, op: "select" });
          if (errors[table]) {
            return resolve({ data: null, error: { message: errors[table] } });
          }
          const data = window ? rows.slice(window[0], window[1] + 1) : rows;
          return resolve({ data, error: null });
        },
      };
      return builder;
    },
  };
  return client;
}

Deno.test("the unmatched queue is a read and classifies exact, ambiguous and unmatched", async () => {
  const client = queueFake({
    xero_invoices: [
      {
        id: "b1",
        xero_invoice_id: "X1",
        invoice_number: "S-1",
        reference: "PO-54000",
        contact_name: "Supplies",
        sub_total: 100,
        status: "AUTHORISED",
        invoice_type: "ACCPAY",
        invoice_date: "2026-10-01",
        job_id: null,
        line_items: [{ Description: "Timber SWF-261308" }],
      },
      {
        id: "b2",
        xero_invoice_id: "X2",
        invoice_number: "S-2",
        reference: null,
        contact_name: "Supplies",
        sub_total: 80,
        status: "PAID",
        invoice_type: "ACCPAY",
        invoice_date: "2026-10-02",
        job_id: null,
        line_items: [{ Description: "SWF-261041 SWF-261042" }],
      },
      {
        id: "b3",
        xero_invoice_id: "X3",
        invoice_number: "S-3",
        reference: "PO-1",
        contact_name: "Supplies",
        sub_total: 40,
        status: "AUTHORISED",
        invoice_type: "ACCPAY",
        invoice_date: "2026-10-03",
        job_id: null,
        line_items: [{ Description: "Nails", Tracking: [{ Option: "SW - FENCING" }] }],
      },
      {
        id: "b4",
        xero_invoice_id: "X4",
        invoice_number: "T-1",
        reference: null,
        contact_name: "Trade",
        sub_total: 20,
        status: "PAID",
        invoice_type: "ACCPAY",
        invoice_date: "2026-10-04",
        job_id: null,
        line_items: [{ Description: "Labour | SW - FENCING" }],
      },
    ],
    jobs: [
      { id: JOB, job_number: "SWF-261308" },
      { id: OTHER, job_number: "SWF-261041" },
      { id: "a7600000-0000-4000-8000-000000000003", job_number: "SWF-261042" },
    ],
    trade_invoices: [],
  });
  const out = await jobProfitUnmatchedBillsAction(
    client,
    new URLSearchParams("days=90&limit=10&offset=0"),
    new Date("2026-10-21T00:00:00Z"),
  );
  assertEquals(out.status, 200);
  const bills = (out.body as any).bills;
  const byId = Object.fromEntries(bills.map((bill: any) => [bill.invoice_id, bill]));
  assertEquals(bills.length, 3);
  assertEquals(byId.b1.outcome, "exact");
  assertEquals(byId.b1.suggested_job_number, "SWF-261308");
  assertEquals(byId.b1.suggested_job_id, JOB);
  assertEquals(byId.b2.outcome, "ambiguous");
  assertEquals(byId.b2.suggested_job_id, null);
  assertEquals(byId.b3.outcome, "unmatched");
  assertEquals((out.body as any).has_more, false);
  assertEquals(client.calls.filter((call) => call.op === "update" || call.op === "insert"), []);
});

Deno.test("a failed bill read is an error, not an empty queue", async () => {
  const client = queueFake({ xero_invoices: [] }, { xero_invoices: "down" });
  const out = await jobProfitUnmatchedBillsAction(client, new URLSearchParams());
  assertEquals(out.status, 500);
  assertEquals((out.body as any).code, "bills_unreadable");
});

Deno.test("only an office session or the ops key may use the bill queue", () => {
  assert(jobProfitBillQueueCallerAllowed("api_key", null));
  for (const role of ["admin", "owner", "ops_manager", "Owner"]) {
    assert(jobProfitBillQueueCallerAllowed("jwt", role), role);
  }
  for (const role of ["trade", "lead_installer", "", null]) {
    assert(!jobProfitBillQueueCallerAllowed("jwt", role), `jwt ${role}`);
  }
  assert(!jobProfitBillQueueCallerAllowed("routine", "admin"));
  assert(!jobProfitBillQueueCallerAllowed("agent_read", "admin"));
  assert(!jobProfitBillQueueCallerAllowed("none", "owner"));
});

Deno.test("the queue actions are wired once and are not on the routine or agent lists", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  for (const action of ["job_profit_unmatched_bills", "job_profit_link_bill"]) {
    assertEquals(src.split(action).length - 1, 1, action);
  }
});

const ACTOR = { user_id: "a7100000-0000-4000-8000-000000000001", email: "office@secureworkswa.com.au" };

function linkFake(options: {
  invoice?: Record<string, unknown> | null;
  job?: Record<string, unknown> | null;
  trade?: boolean;
  eventError?: boolean;
  raceSameJob?: boolean;
}) {
  const calls: Call[] = [];
  let reads = 0;
  let updateResolved = false;
  const invoice = options.invoice === undefined
    ? {
      id: BILL,
      xero_invoice_id: "X1",
      invoice_number: "S-1",
      reference: "PO-1",
      contact_name: "Supplies",
      sub_total: 100,
      status: "AUTHORISED",
      invoice_type: "ACCPAY",
      invoice_date: "2026-10-01",
      job_id: null,
      line_items: [{ Description: "Timber" }],
    }
    : options.invoice;
  const client = {
    calls,
    from(table: string) {
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        in: () => builder,
        is: () => builder,
        limit: () => builder,
        order: () => builder,
        gte: () => builder,
        range: () => builder,
        update: () => {
          calls.push({ table, op: "update" });
          return builder;
        },
        insert: () => {
          calls.push({ table, op: "insert" });
          return builder;
        },
        then: (resolve: (value: unknown) => unknown) => {
          if (table === "job_events") {
            return resolve(options.eventError
              ? { data: null, error: { message: "event down" } }
              : { data: [{ id: "e1" }], error: null });
          }
          if (table === "trade_invoices") {
            return resolve({
              data: options.trade ? [{ xero_bill_id: "X1" }] : [],
              error: null,
            });
          }
          if (table === "jobs") {
            return resolve({ data: options.job ? [options.job] : [], error: null });
          }
          if (table === "xero_invoices") {
            const updatePending = calls.some((call) => call.table === "xero_invoices" && call.op === "update") &&
              !updateResolved;
            if (updatePending) {
              updateResolved = true;
              return resolve(options.raceSameJob ? { data: [], error: null } : { data: [{ id: BILL }], error: null });
            }
            reads += 1;
            if (!invoice) return resolve({ data: [], error: null });
            if (options.raceSameJob && reads > 1) {
              return resolve({ data: [{ ...invoice, job_id: JOB }], error: null });
            }
            return resolve({ data: [invoice], error: null });
          }
          return resolve({ data: [], error: null });
        },
      };
      return builder;
    },
  };
  return client;
}

Deno.test("linking a bill writes the job id once and records the office action", async () => {
  const client = linkFake({ job: { id: JOB, job_number: "SWF-261308", ses_money_sealed_at: null } });
  const out = await jobProfitLinkBillAction(client, { invoice_id: BILL, job_id: JOB }, ACTOR);
  assertEquals(out.status, 200);
  assertEquals((out.body as any).audit_written, true);
  assertEquals(client.calls.filter((call) => call.op === "update").length, 1);
  assertEquals(client.calls.filter((call) => call.op === "insert" && call.table === "job_events").length, 1);
});

Deno.test("linking the same job again does not write a second event", async () => {
  const client = linkFake({
    invoice: {
      id: BILL,
      xero_invoice_id: "X1",
      status: "PAID",
      invoice_type: "ACCPAY",
      job_id: JOB,
      line_items: [],
    },
    job: { id: JOB, ses_money_sealed_at: null },
  });
  const out = await jobProfitLinkBillAction(client, { invoice_id: BILL, job_id: JOB }, ACTOR);
  assertEquals(out.status, 200);
  assertEquals((out.body as any).already_linked, true);
  assertEquals((out.body as any).audit_written, false);
  assertEquals(client.calls.filter((call) => call.op === "update" || call.op === "insert"), []);
});

Deno.test("a link is refused when the bill, the job or the seal says no", async () => {
  const cases: Array<{ name: string; options: Parameters<typeof linkFake>[0]; body?: Record<string, unknown>; status: number; code: string }> = [
    {
      name: "other job",
      options: {
        invoice: { id: BILL, xero_invoice_id: "X1", status: "AUTHORISED", invoice_type: "ACCPAY", job_id: OTHER, line_items: [] },
        job: { id: JOB, ses_money_sealed_at: null },
      },
      status: 409,
      code: "bill_already_linked",
    },
    {
      name: "draft",
      options: {
        invoice: { id: BILL, xero_invoice_id: "X1", status: "DRAFT", invoice_type: "ACCPAY", job_id: null, line_items: [] },
        job: { id: JOB, ses_money_sealed_at: null },
      },
      status: 409,
      code: "bill_not_linkable",
    },
    {
      name: "sales invoice",
      options: {
        invoice: { id: BILL, xero_invoice_id: "X1", status: "AUTHORISED", invoice_type: "ACCREC", job_id: null, line_items: [] },
        job: { id: JOB, ses_money_sealed_at: null },
      },
      status: 409,
      code: "bill_not_linkable",
    },
    {
      name: "trade mirror",
      options: { trade: true, job: { id: JOB, ses_money_sealed_at: null } },
      status: 409,
      code: "trade_mirror_bill",
    },
    {
      name: "missing job",
      options: { job: null },
      status: 404,
      code: "job_not_found",
    },
    {
      name: "missing bill",
      options: { invoice: null, job: { id: JOB, ses_money_sealed_at: null } },
      status: 404,
      code: "bill_not_found",
    },
    {
      name: "sealed",
      options: { job: { id: JOB, ses_money_sealed_at: "2026-08-01T00:00:00Z" } },
      status: 409,
      code: "sealed_ses_release_required",
    },
  ];
  for (const item of cases) {
    const client = linkFake(item.options);
    const out = await jobProfitLinkBillAction(
      client,
      item.body ?? { invoice_id: BILL, job_id: JOB },
      ACTOR,
    );
    assertEquals(out.status, item.status, item.name);
    assertEquals((out.body as any).code, item.code, item.name);
  }

  const bad = await jobProfitLinkBillAction(linkFake({}), { invoice_id: "nope", job_id: JOB }, ACTOR);
  assertEquals(bad.status, 400);
  assertEquals((bad.body as any).code, "bad_link");
});

Deno.test("a failed audit row still reports the link, and a lost race that landed on the same job is idempotent", async () => {
  const failedEvent = linkFake({
    job: { id: JOB, ses_money_sealed_at: null },
    eventError: true,
  });
  const written = await jobProfitLinkBillAction(failedEvent, { invoice_id: BILL, job_id: JOB }, ACTOR);
  assertEquals(written.status, 200);
  assertEquals((written.body as any).audit_written, false);
  assertEquals((written.body as any).already_linked, false);

  const race = linkFake({
    job: { id: JOB, ses_money_sealed_at: null },
    raceSameJob: true,
  });
  const again = await jobProfitLinkBillAction(race, { invoice_id: BILL, job_id: JOB }, ACTOR);
  assertEquals(again.status, 200);
  assertEquals((again.body as any).already_linked, true);
  assertEquals((again.body as any).audit_written, false);
});
