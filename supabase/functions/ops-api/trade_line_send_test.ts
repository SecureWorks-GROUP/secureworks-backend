/**
 * P1-05.8: the send helpers (trade_line_send.ts) and the weekly rebuild
 * (rebuildWeeklyInvoiceForHold). Every name, number and id is made up.
 */
// deno-lint-ignore-file no-explicit-any
import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import {
  guardedJobs,
  holdWholeJob,
  isKeptDeduction,
  jobAmountGuardJob,
  raiseHeldLines,
  sendAnswer,
  stampHeldBookings,
  type SortedSend,
} from "./trade_line_send.ts";
import { rebuildWeeklyInvoiceForHold, WeeklyInvoiceError, type WeeklyInvoiceLine } from "./trade_invoice_weekly.ts";
import type { LineHoldFacts } from "./trade_line_hold.ts";

const JOB_A = "6c2f0a52-0000-4000-8000-0000000aa001";
const JOB_B = "6c2f0a52-0000-4000-8000-0000000aa002";

const facts = (jobs: Record<string, any>): LineHoldFacts => ({
  userId: "zz-user",
  jobs,
  receipts: {},
  notJobTypes: {},
  commissions: {},
  rateRules: { ok: true, rules: [] } as any,
  tradeRates: [],
  split_group_ids: [],
});

Deno.test("jobAmountGuardJob reads the job from the guard's detail, and nothing else", () => {
  assertEquals(jobAmountGuardJob({ message: "job_amount_guard", details: JOB_A }), JOB_A);
  assertEquals(jobAmountGuardJob({ message: "job_amount_guard" }), null);
  assertEquals(jobAmountGuardJob({ message: "duplicate key" }), undefined);
  assertEquals(jobAmountGuardJob(null), undefined);
});

Deno.test("isKeptDeduction: deduction types and any negative line stay with the pay", () => {
  assertEquals(isKeptDeduction({ line_type: "final_payout_deduction", line_total_ex: -10 }), true);
  assertEquals(isKeptDeduction({ line_type: "labour", line_total_ex: -5 }), true);
  assertEquals(isKeptDeduction({ line_type: "labour", line_total_ex: 5 }), false);
});

Deno.test("holdWholeJob moves that job's backed lines to the office and rejoins a split", () => {
  const sorted: SortedSend = {
    backed: [
      { job_id: JOB_A, line_type: "labour", line_total_ex: 400, sent_amount_ex: 400, total_hours: 8, quantity: 8, split_group_id: "g1" },
      { job_id: JOB_B, line_type: "materials", line_total_ex: 50, sent_amount_ex: 50 },
      { job_id: JOB_A, line_type: "final_payout_deduction", line_total_ex: -20 },
    ],
    held: [{ job_id: JOB_A, line_type: "labour", line_total_ex: 400, sent_amount_ex: 400, total_hours: 8, quantity: 8, split_group_id: "g1", hold_reason: "over_amount" } as any],
    skipped: [],
  } as any;
  const out = holdWholeJob(sorted, JOB_A);
  assertEquals(out.backed.map((r) => [r.job_id, r.line_type]), [[JOB_B, "materials"], [JOB_A, "final_payout_deduction"]]);
  assertEquals(out.held.length, 1);
  const whole = out.held[0];
  assertEquals([whole.hold_reason, whole.line_total_ex, whole.sent_amount_ex, whole.total_hours, whole.split_group_id], ["over_amount", 800, 800, 16, undefined]);
});

Deno.test("guardedJobs names only jobs paid against an approved amount", () => {
  const sorted = { backed: [{ job_id: JOB_A, line_total_ex: 10 }, { job_id: JOB_B, line_total_ex: 10 }, { job_id: JOB_A, line_total_ex: -5 }], held: [], skipped: [] } as any;
  const f = facts({ [JOB_A]: { workOrder: { status: "approved" } }, [JOB_B]: { workOrder: { status: "draft" } } });
  assertEquals(guardedJobs(sorted, f), [JOB_A]);
  assertEquals(guardedJobs(sorted, null), []);
});

Deno.test("sendAnswer: sent equals pay plus the office's part, with the trade's words", () => {
  const out = sendAnswer(
    "zz-send",
    [{ line_total_ex: 200, sent_amount_ex: 200 }],
    [{ id: "zz-l1", row: { job_number: "ZZF-1", hold_reason: "no_work_order", words: "With the office", line_total_ex: 300, sent_amount_ex: 300 } as any }],
    [],
  );
  assertEquals(out.send, { send_id: "zz-send", sent_ex: 500, in_pay_ex: 200, held_ex: 300, declined_ex: 0 });
  assertEquals(out.send_words, "Sent. $200.00 is in this week's pay. $300.00 is with the office.");
  assertEquals(out.held_lines, [{ line_id: "zz-l1", job_number: "ZZF-1", reason: "no_work_order", words: "With the office", amount_ex: 300 }]);
});

Deno.test("raiseHeldLines: the four over-the-amount figures add up; a failing raise is counted, never thrown", async () => {
  const calls: any[] = [];
  let fail = false;
  const client = { rpc: (_name: string, args: any) => { calls.push(args); return Promise.resolve(fail ? { error: { message: "zz" } } : { error: null }); } };
  const f = facts({ [JOB_A]: { job_number: "ZZF-1", workOrder: { status: "approved" }, allowed_ex: 4000, backed_billed_ex: 3600 } });
  const paid = { job_id: JOB_A, line_type: "labour", line_total_ex: 400, sent_amount_ex: 400, split_group_id: "g1" };
  const held = { id: "zz-h1", row: { job_id: JOB_A, line_type: "labour", line_total_ex: 400, sent_amount_ex: 400, split_group_id: "g1", hold_reason: "over_amount" } as any };
  const ctx = { tradeUserId: "zz-user", tradeName: null, tradeRole: "lead_installer", weekStart: "2026-11-16", facts: f, backed: [paid] };
  assertEquals(await raiseHeldLines(client, [held], ctx), { raised: 1, failed: 0 });
  const e = calls[0].p_evidence;
  assertEquals([e.work_order_amount_ex, e.claimed_so_far_ex, e.line_amount_ex, e.over_by_ex], [4000, 3600, 800, 400]);
  fail = true;
  assertEquals(await raiseHeldLines(client, [held], ctx), { raised: 0, failed: 1 });
});

function bookingsClient(assignments: any[], invoices: any[], opts: { readError?: boolean } = {}) {
  const updates: any[] = [];
  const client = {
    from(table: string) {
      const q: any = {
        _filters: [] as any[],
        select() { return q; },
        eq() { return q; },
        in(col: string, vals: any[]) { q._filters.push([col, vals]); return q; },
        or(expr: string) { q._or = expr; return q; },
        update(values: any) { q._update = values; return q; },
        then(resolve: any) {
          if (q._update) {
            updates.push({ table, values: q._update, ids: q._filters.find((f: any) => f[0] === "id")?.[1], or: q._or });
            return resolve({ error: null });
          }
          if (opts.readError) return resolve({ data: null, error: { message: "zz" } });
          const ids = q._filters.find((f: any) => f[0] === "id")?.[1] || [];
          const rows = (table === "job_assignments" ? assignments : invoices).filter((r) => ids.includes(r.id));
          return resolve({ data: rows, error: null });
        },
      };
      return q;
    },
  };
  return { client, updates };
}

Deno.test("stampHeldBookings claims free bookings and ones on a released draft, never a live invoice's", async () => {
  const { client, updates } = bookingsClient(
    [{ id: "a1", invoiced_in: null }, { id: "a2", invoiced_in: "inv-draft" }, { id: "a3", invoiced_in: "inv-live" }],
    [{ id: "inv-draft", status: "draft" }, { id: "inv-live", status: "pending_ops_review" }],
  );
  await stampHeldBookings(client, "zz-user", "hold-1", ["a1", "a2", "a3", "a1"], new Set(["draft", "ops-reject"]));
  assertEquals(updates.length, 1);
  assertEquals(updates[0].values, { invoiced_in: "hold-1" });
  assertEquals(updates[0].ids, ["a1", "a2"]);
  assertEquals(updates[0].or, "invoiced_in.is.null,invoiced_in.in.(inv-draft)");
});

Deno.test("stampHeldBookings: nothing to stamp writes nothing; an unreadable booking throws", async () => {
  const empty = bookingsClient([], []);
  await stampHeldBookings(empty.client, "zz-user", "hold-1", [], new Set());
  assertEquals(empty.updates, []);
  const bad = bookingsClient([], [], { readError: true });
  await assertRejects(() => stampHeldBookings(bad.client, "zz-user", "hold-1", ["a1"], new Set()), Error, "held_bookings_unreadable");
});

const wl = (over: Partial<WeeklyInvoiceLine>): WeeklyInvoiceLine => ({
  line_type: "work order",
  description: "ZZTEST",
  quantity: 1,
  unit: "ea",
  unit_rate: 0,
  line_total_ex: 0,
  job_id: JOB_A,
  job_number: "ZZF-1",
  client_name: null,
  site_address: null,
  line_date: "2026-11-17",
  division: null,
  source_work_order_id: "wo-a",
  source_trade_invoice_line_id: null,
  deduction_user_id: null,
  deduction_assignment_id: null,
  deduction_trade_rate_id: null,
  ...over,
});

Deno.test("rebuildWeeklyInvoiceForHold keeps a work order with its deductions and totals", () => {
  const pay = wl({ line_total_ex: 500, unit_rate: 500 });
  const helper = wl({ line_type: "crew_labour_deduction", line_total_ex: -100 });
  const { invoice, left_out } = rebuildWeeklyInvoiceForHold([pay, helper]);
  assertEquals(left_out, []);
  assertEquals([invoice!.grand_total, invoice!.to_be_paid, invoice!.lines.length], [400, 400, 2]);
});

Deno.test("rebuildWeeklyInvoiceForHold leaves out a block whose pay line was held", () => {
  const helperA = wl({ line_type: "crew_labour_deduction", line_total_ex: -100 });
  const payB = wl({ job_id: JOB_B, source_work_order_id: "wo-b", line_total_ex: 300 });
  const { invoice, left_out } = rebuildWeeklyInvoiceForHold([helperA, payB]);
  assertEquals(left_out, [helperA]);
  assertEquals(invoice!.to_be_paid, 300);
});

Deno.test("rebuildWeeklyInvoiceForHold: nothing left is null; a final deduction with no pay is refused", () => {
  assertEquals(rebuildWeeklyInvoiceForHold([wl({ line_type: "crew_labour_deduction", line_total_ex: -50 })]).invoice, null);
  assertThrows(
    () => rebuildWeeklyInvoiceForHold([wl({ line_type: "final_payout_deduction", source_work_order_id: null, line_total_ex: -50 })]),
    WeeklyInvoiceError,
  );
});
