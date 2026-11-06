// deno-lint-ignore-file no-explicit-any no-import-prefix
/**
 * Trade invoicing fixes, November 2026:
 * - every database refusal on a trade invoice route is a plain answer;
 * - the Work Order Invoice door never offers what its database refuses, and
 *   points the trade at a week they can bill their hours in;
 * - a patio job paid through a group is never an ordinary hours card;
 * - the office's reason shows on a sent-back invoice, and the reopened week
 *   starts from what the trade sent;
 * - invoices with no week always reach Trade Bills.
 */
import "./trade_app_visibility_rules_test_env.ts";
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { mergeTradeBillRows, myHours } from "./index.ts";
import {
  TradeInvoiceStoreError,
  tradeInvoiceRefusal,
} from "./trade_invoice_refusal.ts";
import {
  invoiceWeekEndingOf,
  unbilledBookingWeekEnding,
  workOrderDirectInvoiceBlock,
} from "./trade_invoice_weekly.ts";
import {
  officeSentBackNote,
  tradeInvoiceOfficeNote,
} from "./trade_invoice_office_note.ts";
import {
  groupRouteNextStep,
  priorPayClaimHoldsHoursRoute,
} from "./group_work_order.ts";

// ── Plain refusals ─────────────────────────────────────────────────────────

Deno.test("a work-order guard refusal is a plain 409 with the way on, never the database text", () => {
  const out = tradeInvoiceRefusal(
    new TradeInvoiceStoreError(
      "Failed to persist work-order invoice: work-order invoice source is no longer complete in the selected business date",
      "P0001",
    ),
  );
  assertEquals(out.status, 409);
  assertEquals(out.body.code, "work_order_not_complete");
  assertEquals(/selected business date|persist/i.test(out.body.error), false);
  assertEquals(/Weekly Invoice/.test(out.body.error), true);
});

Deno.test("a database refusal code with unknown text is a plain 409", () => {
  const out = tradeInvoiceRefusal({ code: "23505", message: "duplicate key value violates unique constraint x" });
  assertEquals(out.status, 409);
  assertEquals(out.body.code, "trade_invoice_refused");
  assertEquals(/duplicate key|constraint/.test(out.body.error), false);
});

Deno.test("a serialization conflict is a busy answer", () => {
  const out = tradeInvoiceRefusal(new TradeInvoiceStoreError("could not serialize access", "40001"));
  assertEquals(out.status, 409);
  assertEquals(out.body.code, "trade_invoice_busy");
});

Deno.test("a sentence written for the trade keeps its words as a 400", () => {
  const out = tradeInvoiceRefusal(new Error("You are not assigned to this job"));
  assertEquals(out.status, 400);
  assertEquals(out.body.error, "You are not assigned to this job");
});

Deno.test("internal text and program faults are a plain 500 that carries none of it", () => {
  for (const err of [
    new Error("Failed to load trade invoice: column trade_invoices.foo does not exist"),
    new TypeError("Cannot read properties of undefined (reading 'id')"),
  ]) {
    const out = tradeInvoiceRefusal(err);
    assertEquals(out.status, 500);
    assertEquals(out.body.code, "trade_invoice_error");
    assertEquals(/column|undefined|Cannot read/.test(out.body.error), false);
  }
});

// ── The Work Order Invoice door ────────────────────────────────────────────

Deno.test("the direct door takes only a complete work order with a finish day", () => {
  assertEquals(workOrderDirectInvoiceBlock({ status: "complete", completed_at: "2026-07-02T03:00:00Z" }), null);
  assertEquals(workOrderDirectInvoiceBlock({ status: "complete", scheduled_date: "2026-07-01" }), null);
  assertEquals(workOrderDirectInvoiceBlock({ status: "sent", completed_at: null })?.code, "work_order_not_complete");
  assertEquals(workOrderDirectInvoiceBlock({ status: "accepted" })?.code, "work_order_not_complete");
  assertEquals(workOrderDirectInvoiceBlock({ status: "complete" })?.code, "work_order_no_finish_date");
});

Deno.test("an invoice week ends on the Sunday", () => {
  assertEquals(invoiceWeekEndingOf("2026-04-21"), "2026-04-26");
  assertEquals(invoiceWeekEndingOf("2026-04-26"), "2026-04-26");
  assertEquals(invoiceWeekEndingOf("2026-04-27"), "2026-05-03");
  assertEquals(invoiceWeekEndingOf("not a day"), null);
});

Deno.test("the hours week is the latest live booking not yet billed", () => {
  assertEquals(unbilledBookingWeekEnding([
    { scheduled_date: "2026-04-21", status: "complete" },
    { scheduled_date: "2026-05-11", status: "cancelled" },
    { scheduled_date: "2026-05-18", status: "complete", is_ghost: true },
    { scheduled_date: "2026-06-01", status: "complete", invoiced_in: "inv-1" },
  ]), "2026-04-26");
  assertEquals(unbilledBookingWeekEnding([{ scheduled_date: "2026-06-01", status: "complete", invoiced_in: "inv-1" }]), null);
  assertEquals(unbilledBookingWeekEnding([]), null);
});

// ── Group pay routes ───────────────────────────────────────────────────────

Deno.test("a draft, rejected or failed claim never puts a patio job on the hours route", () => {
  for (const status of ["draft", "ops-reject", "failed", "", null]) {
    assertEquals(priorPayClaimHoldsHoursRoute(status), false, String(status));
  }
  for (const status of ["pending_ops_review", "approved", "pushed_to_xero", "paid"]) {
    assertEquals(priorPayClaimHoldsHoursRoute(status), true, status);
  }
});

Deno.test("each group route names one plain next step", () => {
  const base = { job_id: "j", group_id: null } as any;
  assertEquals(/Create the crew group/.test(groupRouteNextStep({ ...base, route: "group_setup_required", discovery: { state: "create" } })), true);
  assertEquals(/Join the crew group/.test(groupRouteNextStep({ ...base, route: "group", discovery: { state: "join" } })), true);
  assertEquals(
    groupRouteNextStep({ ...base, route: "group_setup_required", discovery: { state: "setup_required", message: "The office needs to approve the job work order before the crew group can be created." } }),
    "The office needs to approve the job work order before the crew group can be created.",
  );
  assertEquals(/office needs to set/.test(groupRouteNextStep({ ...base, route: "group_setup_required", setup_reason: "allowance_missing" })), true);
  assertEquals(/could not check/.test(groupRouteNextStep(null)), true);
});

// ── Office notes ───────────────────────────────────────────────────────────

Deno.test("a sent-back invoice shows the office's words and none of the system notes", () => {
  const stored = officeSentBackNote("Wrong day on Tuesday");
  assertEquals(
    tradeInvoiceOfficeNote({ status: "ops-reject", query_note: stored }),
    "Wrong day on Tuesday",
  );
  assertEquals(
    tradeInvoiceOfficeNote({
      status: "ops-reject",
      query_note: "Validated invoice awaiting Xero ACCPAY creation. | A line was rejected. Fix it and send the invoice again.",
    }, [{ office_review_status: "rejected", office_review_note: "Break not taken off", description: "Install day" }]),
    "A line was rejected. Fix it and send the invoice again.\nInstall day: Break not taken off",
  );
  assertEquals(
    tradeInvoiceOfficeNote({ status: "ops-reject", query_note: "Validated invoice awaiting Xero ACCPAY creation." }),
    null,
  );
  // An older reject stored the reason alone.
  assertEquals(tradeInvoiceOfficeNote({ status: "ops-reject", query_note: "Hours too high" }), "Hours too high");
  // A live invoice never shows its query_note.
  assertEquals(tradeInvoiceOfficeNote({ status: "pending_ops_review", query_note: "Hours too high" }), null);
  assertEquals(officeSentBackNote(""), "Sent back by the office. Fix it and send it again.");
  assertEquals(
    tradeInvoiceOfficeNote({ status: "ops-reject", query_note: "Xero bill voided and unpaid. Released for a corrected submission: wrong rate" }),
    "The Xero bill was voided. Send a corrected invoice. Reason: wrong rate",
  );
});

// ── Trade Bills ────────────────────────────────────────────────────────────

Deno.test("invoices with no week sit among the weekly ones by the day they were made", () => {
  const merged = mergeTradeBillRows(
    [
      { id: "w1", week_start: "2026-10-26", created_at: "2026-11-01T00:00:00Z" },
      { id: "w2", week_start: "2026-10-12", created_at: "2026-10-18T00:00:00Z" },
    ],
    [
      { id: "n1", week_start: null, created_at: "2026-10-20T00:00:00Z" },
      { id: "w1", week_start: "2026-10-26", created_at: "2026-11-01T00:00:00Z" },
    ],
  );
  assertEquals(merged.map((row) => row.id), ["w1", "n1", "w2"]);
});

// ── my_hours ───────────────────────────────────────────────────────────────

const TRADE = "7d4f0a52-0000-4000-8000-00000000bb01";
const ORG = "00000000-0000-0000-0000-000000000001";
const WEEK_END = "2026-08-30";

function tableClient(tables: Record<string, any[]>) {
  const from = (table: string) => {
    const preds: Array<(row: any) => boolean> = [];
    let limitN: number | null = null;
    let range: [number, number] | null = null;
    const run = () => {
      let rows = (tables[table] || []).filter((row) => preds.every((p) => p(row)));
      if (range) rows = rows.slice(range[0], range[1] + 1);
      if (limitN != null) rows = rows.slice(0, limitN);
      return { data: rows, error: null };
    };
    const one = () => {
      const out = run();
      return Promise.resolve({ data: out.data[0] ?? null, error: null });
    };
    const api: any = {
      select: () => api,
      order: () => api,
      or: () => api,
      not: () => api,
      limit(n: number) {
        limitN = n;
        return api;
      },
      range(a: number, b: number) {
        range = [a, b];
        return api;
      },
      eq(column: string, value: unknown) {
        preds.push((row) => String(row?.[column] ?? "") === String(value));
        return api;
      },
      neq(column: string, value: unknown) {
        preds.push((row) => String(row?.[column] ?? "") !== String(value));
        return api;
      },
      is(column: string, value: unknown) {
        preds.push((row) => (row?.[column] ?? null) === value);
        return api;
      },
      in(column: string, values: unknown[]) {
        preds.push((row) => values.map(String).includes(String(row?.[column] ?? "")));
        return api;
      },
      gte(column: string, value: unknown) {
        preds.push((row) => String(row?.[column] ?? "") >= String(value));
        return api;
      },
      lte(column: string, value: unknown) {
        preds.push((row) => String(row?.[column] ?? "") <= String(value));
        return api;
      },
      single: one,
      maybeSingle: one,
      then: (resolve: any, reject: any) => Promise.resolve(run()).then(resolve, reject),
    };
    return api;
  };
  return { from, rpc: () => Promise.resolve({ data: null, error: null }) };
}

function hoursTables(patioFlag: boolean): Record<string, any[]> {
  const card = (id: string, jobId: string, type: string, day: string, extra: Record<string, unknown> = {}) => ({
    id,
    user_id: TRADE,
    job_id: jobId,
    status: "complete",
    role: "installer",
    scheduled_date: day,
    hours_worked: 8,
    invoiced_in: null,
    is_ghost: false,
    jobs: { id: jobId, type, job_number: `${type}-${id}`, client_name: "Client", site_suburb: "Perth" },
    ...extra,
  });
  return {
    users: [{ id: TRADE, org_id: ORG, invoice_type: "hourly", trade_details: {} }],
    feature_flags: [{ flag_name: "patio_pay_group_only_v1", enabled: patioFlag }],
    jobs: [
      { id: "job-fence", org_id: ORG, type: "fencing", work_order_id: null },
      { id: "job-patio", org_id: ORG, type: "patio", work_order_id: null },
      { id: "job-grouped", org_id: ORG, type: "patio", work_order_id: null },
    ],
    group_work_orders: [{ id: "group-1", job_id: "job-grouped", status: "open" }],
    job_assignments: [
      card("card-fence", "job-fence", "fencing", "2026-08-25", { invoiced_in: "inv-sent-back" }),
      card("card-patio", "job-patio", "patio", "2026-08-26"),
      card("card-grouped", "job-grouped", "patio", "2026-08-27"),
    ],
    trade_invoices: [{
      id: "inv-sent-back",
      user_id: TRADE,
      status: "ops-reject",
      invoice_number: "TI-TEST",
      query_note: officeSentBackNote("Start time was wrong"),
    }],
    trade_invoice_lines: [{
      trade_invoice_id: "inv-sent-back",
      assignment_ids: ["card-fence"],
      work_date: "2026-08-25",
      start_time: "07:00",
      finish_time: "15:30",
      break_minutes: 30,
      description: "Fence install",
      total_hours: 8,
    }],
    trade_rates: [{ user_id: TRADE, hourly_rate: 50, effective_from: "2026-01-01" }],
  };
}

Deno.test("my_hours: a patio job paid through a group is never an ordinary hours card", async () => {
  const out: any = await myHours(tableClient(hoursTables(true)), TRADE, new URLSearchParams({ week_ending: WEEK_END }));
  assertEquals(out.assignments.map((a: any) => a.id), ["card-fence"]);
  const routes = Object.fromEntries(out.group_route_jobs.map((r: any) => [r.job_id, r]));
  assertEquals(routes["job-patio"].route, "group_setup_required");
  assertEquals(routes["job-patio"].booked_dates, ["2026-08-26"]);
  assertEquals(typeof routes["job-patio"].next_step, "string");
  assertEquals(routes["job-grouped"].route, "group");
  assertEquals(routes["job-grouped"].group_id, "group-1");
  assertEquals(routes["job-grouped"].booked_dates, ["2026-08-27"]);
  assertEquals(out.total_hours, 8);
});

Deno.test("my_hours: with the patio rule off a patio job stays an hours card", async () => {
  const out: any = await myHours(tableClient(hoursTables(false)), TRADE, new URLSearchParams({ week_ending: WEEK_END }));
  assertEquals(out.assignments.map((a: any) => a.id).sort(), ["card-fence", "card-patio"]);
  assertEquals(out.group_route_jobs.map((r: any) => r.job_id), ["job-grouped"]);
});

Deno.test("my_hours: a sent-back card starts from what the trade sent, with the office's reason", async () => {
  const out: any = await myHours(tableClient(hoursTables(true)), TRADE, new URLSearchParams({ week_ending: WEEK_END }));
  const fence = out.assignments.find((a: any) => a.id === "card-fence");
  assertEquals(fence.previous_entry, {
    invoice_id: "inv-sent-back",
    invoice_number: "TI-TEST",
    office_note: "Start time was wrong",
    work_date: "2026-08-25",
    start_time: "07:00",
    finish_time: "15:30",
    break_minutes: 30,
    description: "Fence install",
    hours: 8,
  });
});
