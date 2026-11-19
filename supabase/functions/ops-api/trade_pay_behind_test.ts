import { assertEquals, assertRejects, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  behindAsOfParam,
  behindWeekStarts,
  behindWeeksParam,
  bookingDays,
  groupStuckStep,
  type PayBehindReads,
  readWhoIsBehind,
  realBooking,
  weekInvoiceSummary,
} from "./trade_pay_behind.ts";
import { TradePayRunError } from "./trade_pay_run.ts";

const ORG = "00000000-0000-4000-8000-000000000001";
const APPROVER = "00000000-0000-4000-8000-0000000000a1";
const TRADE_A = "00000000-0000-4000-8000-0000000000b1";
const TRADE_B = "00000000-0000-4000-8000-0000000000b2";
const TRADE_C = "00000000-0000-4000-8000-0000000000b3";
const OTHER_ORG_TRADE = "00000000-0000-4000-8000-0000000000c1";
const GROUP = "00000000-0000-4000-8000-0000000000d1";
const JOB = "00000000-0000-4000-8000-0000000000e1";
// Thursday 19 Nov 2026 (Perth). Last full week: Mon 9 to Sun 15 Nov.
const NOW = new Date("2026-11-19T02:00:00Z");

type Calls = string[];

function reads(overrides: Partial<PayBehindReads> = {}, calls: Calls = []): PayBehindReads {
  const base: PayBehindReads = {
    async approvers() {
      calls.push("approvers");
      return [APPROVER];
    },
    async bookings() {
      calls.push("bookings");
      return [
        { user_id: TRADE_A, scheduled_date: "2026-11-10", scheduled_end: "2026-11-11", status: "scheduled", role: "lead_installer", is_ghost: false },
        { user_id: TRADE_A, scheduled_date: "2026-11-03", status: null, role: null, is_ghost: false },
        { user_id: TRADE_B, scheduled_date: "2026-11-12", status: "scheduled", is_ghost: false },
        { user_id: TRADE_C, scheduled_date: "2026-11-12", status: "scheduled", is_ghost: false },
        // Not crew work: a ghost watcher, an observer, a cancelled day.
        { user_id: TRADE_C, scheduled_date: "2026-11-02", is_ghost: true },
        { user_id: TRADE_C, scheduled_date: "2026-11-03", role: "observer" },
        { user_id: TRADE_C, scheduled_date: "2026-11-04", status: "cancelled" },
        { user_id: OTHER_ORG_TRADE, scheduled_date: "2026-11-12", status: "scheduled" },
      ];
    },
    async users(ids) {
      calls.push("users");
      const all = [
        { id: TRADE_A, name: "ZZTEST Trade A", org_id: ORG },
        { id: TRADE_B, name: "ZZTEST Trade B", org_id: ORG },
        { id: TRADE_C, name: "ZZTEST Trade C", org_id: ORG },
        { id: OTHER_ORG_TRADE, name: "ZZTEST Elsewhere", org_id: "00000000-0000-4000-8000-000000000009" },
      ];
      return all.filter((u) => ids.includes(u.id));
    },
    async invoices() {
      calls.push("invoices");
      return [
        { id: "inv-a-draft", user_id: TRADE_A, week_start: "2026-11-09", status: "draft", invoice_kind: "standard" },
        { id: "inv-b", user_id: TRADE_B, week_start: "2026-11-09", status: "pending_ops_review", invoice_kind: "standard" },
        { id: "inv-c", user_id: TRADE_C, week_start: "2026-11-09", status: "paid", invoice_kind: "standard" },
      ];
    },
    async lines() {
      calls.push("lines");
      return [
        { id: "l1", trade_invoice_id: "inv-a-draft", work_date: "2026-11-10" },
        { id: "l2", trade_invoice_id: "inv-a-draft", work_date: "2026-11-11" },
        { id: "l3", trade_invoice_id: "inv-b", work_date: "2026-11-12", hold_reason: "no_amount", office_review_status: "awaiting" },
      ];
    },
    async openGroups() {
      calls.push("openGroups");
      return [{ id: GROUP, job_id: JOB, status: "open", claim_state: "waiting_hours", created_at: "2026-11-10T00:00:00Z", hours_changed_at: "2026-11-15T02:00:00Z" }];
    },
    async participants() {
      calls.push("participants");
      return [
        { group_id: GROUP, user_id: TRADE_A },
        { group_id: GROUP, user_id: TRADE_B },
        { group_id: GROUP, user_id: TRADE_C },
      ];
    },
    async entries() {
      calls.push("entries");
      return [
        { group_id: GROUP, user_id: TRADE_A, hours: 8 },
        { group_id: GROUP, user_id: TRADE_B, hours: 7.5, entered_by_office: true, disputed_at: "2026-11-16T00:00:00Z", dispute_resolved_at: null },
      ];
    },
    async jobs() {
      calls.push("jobs");
      return [{ id: JOB, job_number: "ZZTEST-G3", site_suburb: "ZZTEST Suburb" }];
    },
  };
  return { ...base, ...overrides };
}

Deno.test("inputs: weeks clamps to 1..8, as_of defaults to Perth today and refuses a bad date", () => {
  assertEquals(behindWeeksParam(null), 4);
  assertEquals(behindWeeksParam("0"), 1);
  assertEquals(behindWeeksParam("99"), 8);
  assertEquals(behindWeeksParam("3"), 3);
  assertEquals(behindAsOfParam(null, NOW), "2026-11-19");
  let code = "";
  try {
    behindAsOfParam("2026-02-30", NOW);
  } catch (e) {
    code = (e as TradePayRunError).code;
  }
  assertEquals(code, "pay_run_as_of_invalid");
  // Full weeks only, oldest first. A Sunday's week is still running.
  assertEquals(behindWeekStarts("2026-11-19", 2), ["2026-11-02", "2026-11-09"]);
  assertEquals(behindWeekStarts("2026-11-22", 1), ["2026-11-09"]);
  assertEquals(behindWeekStarts("2026-11-23", 1), ["2026-11-16"]);
});

Deno.test("bookings: ghost, observer and cancelled are not crew days; a span counts each day", () => {
  assertEquals(realBooking({ user_id: "u", scheduled_date: "2026-11-10", is_ghost: true }), false);
  assertEquals(realBooking({ user_id: "u", scheduled_date: "2026-11-10", role: "observer" }), false);
  assertEquals(realBooking({ user_id: "u", scheduled_date: "2026-11-10", status: "cancelled" }), false);
  assertEquals(realBooking({ user_id: "u", scheduled_date: "2026-11-10", status: null }), true);
  assertEquals(bookingDays({ scheduled_date: "2026-11-10", scheduled_end: "2026-11-12" }), ["2026-11-10", "2026-11-11", "2026-11-12"]);
  assertEquals(bookingDays({ scheduled_date: "2026-11-10", scheduled_end: "2026-11-01" }), ["2026-11-10"]);
});

Deno.test("week status: rejected is missing, the best progress wins, a line with the office is held", () => {
  const none = new Map();
  assertEquals(weekInvoiceSummary([], none).invoice_status, "missing");
  assertEquals(weekInvoiceSummary([{ id: "x", status: "ops-reject" }], none).invoice_status, "missing");
  assertEquals(weekInvoiceSummary([{ id: "x", status: "draft" }], none).invoice_status, "draft");
  assertEquals(weekInvoiceSummary([{ id: "x", status: "acknowledged" }], none).invoice_status, "submitted");
  assertEquals(weekInvoiceSummary([{ id: "x", status: "pushed_to_xero" }], none).invoice_status, "approved");
  assertEquals(weekInvoiceSummary([{ id: "x", status: "draft" }, { id: "y", status: "paid" }], none).invoice_status, "paid");
  const held = new Map([["x", [{ hold_reason: "no_work_order", office_review_status: "queried" }, { hold_reason: "rate_above_rule", office_review_status: "awaiting" }, { hold_reason: "no_amount", office_review_status: "approved" }]]]);
  const summary = weekInvoiceSummary([{ id: "x", status: "approved" }], held);
  assertEquals(summary, { invoice_status: "held", draft_lines_count: 0, held_lines_count: 2, unpriced_wo_lines_count: 1 });
  assertEquals(weekInvoiceSummary([{ id: "h", status: "pending_ops_review", invoice_kind: "held" }], none).invoice_status, "held");
});

Deno.test("stuck step: dispute first, then nobody's hours, then someone missing, then a long wait", () => {
  const base = { claimState: "waiting_hours", crewTotal: 3, crewWithHours: 2, openDispute: false, waitingHours: 1 };
  assertEquals(groupStuckStep({ ...base, openDispute: true }), "disputed");
  assertEquals(groupStuckStep({ ...base, crewWithHours: 0 }), "needs_hours");
  assertEquals(groupStuckStep(base), "awaiting_others");
  assertEquals(groupStuckStep({ ...base, crewWithHours: 3, claimState: "waiting_approval" }), null);
  assertEquals(groupStuckStep({ ...base, crewWithHours: 3, claimState: "waiting_approval", waitingHours: 30 }), "awaiting_crew_approval");
  assertEquals(groupStuckStep({ ...base, crewWithHours: 3, claimState: null, waitingHours: 300 }), null);
});

Deno.test("approvers only: refused 403 before any other read, the server key included", async () => {
  for (const actor of [null, "", TRADE_A]) {
    const calls: Calls = [];
    const err = await assertRejects(
      () => readWhoIsBehind(reads({}, calls), { orgId: ORG, actorUserId: actor, now: NOW }),
      TradePayRunError,
    );
    assertEquals((err as TradePayRunError).code, "pay_run_approver_only");
    assertEquals((err as TradePayRunError).status, 403);
    assertEquals(calls, ["approvers"]);
  }
  const err = await assertRejects(
    () => readWhoIsBehind(reads(), { orgId: "", actorUserId: APPROVER, now: NOW }),
    TradePayRunError,
  );
  assertEquals((err as TradePayRunError).code, "pay_run_no_org");
});

Deno.test("who is behind: per trade per week, only the caller's company, stuck group names who is missing", async () => {
  const out = await readWhoIsBehind(reads(), { orgId: ORG, actorUserId: APPROVER, weeks: "2", now: NOW }) as any;
  assertEquals(out.weeks, ["2026-11-02", "2026-11-09"]);
  const byUser = new Map(out.behind_trades.map((t: any) => [t.user_id, t]));
  // Trade C paid its week and its other days were not crew work.
  assertEquals(byUser.has(TRADE_C), false);
  assertEquals(byUser.has(OTHER_ORG_TRADE), false);
  const a: any = byUser.get(TRADE_A);
  assertEquals(a.display_name, "ZZTEST Trade A");
  assertEquals(a.weeks, [
    { week_start: "2026-11-02", scheduled_days: 1, invoice_status: "missing", draft_lines_count: 0, held_lines_count: 0, unpriced_wo_lines_count: 0 },
    { week_start: "2026-11-09", scheduled_days: 2, invoice_status: "draft", draft_lines_count: 2, held_lines_count: 0, unpriced_wo_lines_count: 0 },
  ]);
  assertEquals([a.missing_weeks_count, a.unsent_draft_count, a.held_count], [1, 1, 0]);
  const b: any = byUser.get(TRADE_B);
  assertEquals(b.weeks[0].invoice_status, "held");
  assertEquals([b.missing_weeks_count, b.held_count], [0, 1]);

  assertEquals(out.stuck_groups.length, 1);
  const g = out.stuck_groups[0];
  assertEquals(g.stuck_step, "disputed");
  assertEquals(g.job_number, "ZZTEST-G3");
  assertEquals(g.crew_total_count, 3);
  assertEquals(g.days_stuck, 4);
  assertEquals(g.crew_missing.map((m: any) => [m.user_id, m.hours_entered, m.office_entered, m.disputed]), [
    [TRADE_B, 7.5, true, true],
    [TRADE_C, 0, false, false],
  ]);
});

Deno.test("no pay is read or shown: no rate, amount or total key anywhere in the answer", async () => {
  const out = await readWhoIsBehind(reads(), { orgId: ORG, actorUserId: APPROVER, now: NOW });
  const text = JSON.stringify(out);
  for (const word of ["rate", "amount", "total_inc", "subtotal", "share_ex", "_ex\"", "hourly"]) {
    assertEquals(text.includes(word), false, word);
  }
  const src = (await Deno.readTextFile(new URL("./trade_pay_behind.ts", import.meta.url)))
    .split("\n").filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*")).join("\n");
  for (const banned of ["hourly_rate", "total_inc", "subtotal_ex", ".insert(", ".update(", ".upsert(", ".delete(", ".rpc(", "xeroPost", "api.xero.com", "xero_bill"]) {
    assertEquals(src.toLowerCase().includes(banned.toLowerCase()), false, banned);
  }
});

Deno.test("a failed read is 503, never a shorter list", async () => {
  const err = await assertRejects(
    () =>
      readWhoIsBehind(reads({ openGroups: () => Promise.reject(new TradePayRunError("pay_run_unreadable", "x", 503)) }), {
        orgId: ORG,
        actorUserId: APPROVER,
        now: NOW,
      }),
    TradePayRunError,
  );
  assertEquals((err as TradePayRunError).status, 503);
});

Deno.test("wiring: the door is GET, approver-checked through the session, and reads nothing on the body", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const at = src.indexOf("case 'pay_run_who_is_behind': {");
  const door = src.slice(at, src.indexOf("case 'office_enter_group_hours': {", at));
  assertStringIncludes(door, "readWhoIsBehind(payBehindReadsFromClient(client)");
  assertStringIncludes(door, "actorUserId: authMode === 'jwt' ? (authUser?.id || null) : null");
  assertEquals(door.includes("body"), false);
});
