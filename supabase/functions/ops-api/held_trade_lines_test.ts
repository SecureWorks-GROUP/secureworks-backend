import { assertEquals, assertRejects, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  decideHeldTradeLine,
  HELD_LINE_REFUSAL_STATUS,
  HELD_LINE_REFUSAL_WORDS,
  HeldTradeLineError,
  listHeldTradeLines,
} from "./held_trade_lines.ts";

// Roles only and made-up amounts.
const ORG = "00000000-0000-4000-8000-000000000001";
const OTHER_ORG = "00000000-0000-4000-8000-000000000002";
const OFFICE = "00000000-0000-4000-8000-0000000000a1";
const TRADE = "00000000-0000-4000-8000-0000000000b1";
const LINE = "00000000-0000-4000-8000-0000000000c1";

const held = (id: string, invoice: string, extra: Record<string, unknown> = {}) => ({
  id, trade_invoice_id: invoice, job_id: null, job_number: "SWF-1", line_type: "labour",
  description: "Made-up work", work_date: "2026-11-17", total_hours: 4, hourly_rate: 50,
  line_total_ex: 200, sent_amount_ex: 200, hold_reason: "no_work_order",
  office_review_status: "awaiting", office_review_note: null, ...extra,
});
const invoice = (id: string, extra: Record<string, unknown> = {}) => ({
  id, org_id: ORG, user_id: TRADE, invoice_number: `TI-${id}`, week_start: "2026-11-16",
  week_end: "2026-11-22", invoice_kind: "held", status: "pending_ops_review",
  pay_run_id: null, xero_bill_id: null, ...extra,
});

function listDeps(opts: { staff?: boolean; on?: boolean; fail?: string } = {}) {
  const lines = [
    held("l1", "i1"),
    held("l2", "i2"), // another company's invoice
    held("l3", "i3"), // not a holding invoice
    held("l4", "i4"), // already in a pay run
    held("l5", "i5"), // already a Xero bill
  ];
  const invoices = [
    invoice("i1"),
    invoice("i2", { org_id: OTHER_ORG }),
    invoice("i3", { invoice_kind: "weekly" }),
    invoice("i4", { pay_run_id: "run" }),
    invoice("i5", { xero_bill_id: "bill" }),
  ];
  return {
    switchOn: () => Promise.resolve(opts.on ?? false),
    heldLines: () => opts.fail === "lines" ? Promise.reject(new HeldTradeLineError("held_lines_unreadable", "x", 503)) : Promise.resolve(lines),
    invoicesById: (ids: string[]) => Promise.resolve(invoices.filter((i) => ids.includes(i.id))),
    staff: () => Promise.resolve(opts.staff ?? true),
    namesById: () => Promise.resolve(new Map([[TRADE, "Trade A"]])),
  };
}

Deno.test("held lines list: only this company's lines a decision can still reach, with enabled from the switch", async () => {
  const out = await listHeldTradeLines(listDeps({ on: true }), { orgId: ORG, actorUserId: OFFICE }) as any;
  assertEquals(out.enabled, true);
  assertEquals(out.count, 1);
  assertEquals(out.lines.map((l: any) => [l.id, l.invoice_number, l.trade_name, l.hold_reason, l.line_total_ex]), [
    ["l1", "TI-i1", "Trade A", "no_work_order", 200],
  ]);
  assertEquals((await listHeldTradeLines(listDeps(), { orgId: ORG, actorUserId: OFFICE }) as any).enabled, false);
});

Deno.test("held lines list: the server key, a non-staff person and a missing company are refused before any line is read", async () => {
  for (const [opts, code] of [
    [{ orgId: ORG, actorUserId: null }, "held_line_person_required"],
    [{ orgId: "", actorUserId: OFFICE }, "held_line_no_org"],
  ] as const) {
    const err = await assertRejects(() => listHeldTradeLines(listDeps({ fail: "lines" }), opts), HeldTradeLineError);
    assertEquals([err.code, err.status], [code, 403]);
  }
  const err = await assertRejects(
    () => listHeldTradeLines(listDeps({ staff: false, fail: "lines" }), { orgId: ORG, actorUserId: OFFICE }),
    HeldTradeLineError,
  );
  assertEquals([err.code, err.status], ["held_line_staff_required", 403]);
});

Deno.test("held lines list: an unreadable read is refused, never an empty list", async () => {
  const err = await assertRejects(
    () => listHeldTradeLines(listDeps({ fail: "lines" }), { orgId: ORG, actorUserId: OFFICE }),
    HeldTradeLineError,
  );
  assertEquals(err.status, 503);
});

function decideDeps(answer: { data?: any; error?: any }) {
  const calls: any[] = [];
  return {
    calls,
    deps: { decide: (p: any) => (calls.push(p), Promise.resolve({ data: answer.data ?? null, error: answer.error ?? null })) },
  };
}

Deno.test("decide: one call as the signed-in person in their own company; the answer passes through", async () => {
  const { deps, calls } = decideDeps({ data: { line: { id: LINE, office_review_status: "approved" }, follow_on_invoice_id: "f1" } });
  const out = await decideHeldTradeLine(deps, {
    orgId: ORG, actorUserId: OFFICE, lineId: LINE, decision: "approve", reason: "Checked with the job",
    changes: { line_total_ex: 150 },
  });
  assertEquals(calls, [{ p_line_id: LINE, p_decision: "approve", p_actor: OFFICE, p_org_id: ORG, p_changes: { line_total_ex: 150 }, p_reason: "Checked with the job" }]);
  assertEquals(out, { ok: true, line: { id: LINE, office_review_status: "approved" }, follow_on_invoice_id: "f1" });
});

Deno.test("decide: the server key, a bad line id and a non-object change are refused with no call", async () => {
  for (const [opts, code, status] of [
    [{ orgId: ORG, actorUserId: null, lineId: LINE }, "held_line_person_required", 403],
    [{ orgId: ORG, actorUserId: OFFICE, lineId: "nope" }, "held_line_not_found", 404],
    [{ orgId: ORG, actorUserId: OFFICE, lineId: LINE, changes: [1] }, "held_line_invalid_decision", 400],
  ] as const) {
    const { deps, calls } = decideDeps({});
    const err = await assertRejects(() => decideHeldTradeLine(deps, { ...opts, decision: "approve", reason: "abc" }), HeldTradeLineError);
    assertEquals([err.code, err.status], [code, status]);
    assertEquals(calls.length, 0);
  }
});

Deno.test("decide: every refusal the function raises reads its code, status and plain words; anything else is 503", async () => {
  for (const code of Object.keys(HELD_LINE_REFUSAL_STATUS)) {
    const { deps } = decideDeps({ error: { message: code } });
    const err = await assertRejects(() => decideHeldTradeLine(deps, { orgId: ORG, actorUserId: OFFICE, lineId: LINE, decision: "query", reason: "abc" }), HeldTradeLineError);
    assertEquals([err.code, err.status, err.message], [code, HELD_LINE_REFUSAL_STATUS[code], HELD_LINE_REFUSAL_WORDS[code]]);
  }
  for (const answer of [{ error: { message: "connection reset" } }, { data: null }]) {
    const { deps } = decideDeps(answer);
    const err = await assertRejects(() => decideHeldTradeLine(deps, { orgId: ORG, actorUserId: OFFICE, lineId: LINE, decision: "query", reason: "abc" }), HeldTradeLineError);
    assertEquals([err.code, err.status], ["held_line_decision_unreadable", 503]);
  }
});

Deno.test("decide: every code the function can raise has a status and words", async () => {
  const sql = await Deno.readTextFile(new URL("../../migrations/20261119091000_decide_held_trade_line.sql", import.meta.url));
  const raised = new Set([...sql.matchAll(/RAISE EXCEPTION '([a-z_]+)'/g)].map((m) => m[1]));
  for (const code of raised) {
    assertEquals(Object.hasOwn(HELD_LINE_REFUSAL_STATUS, code), true, code);
    assertEquals(Object.hasOwn(HELD_LINE_REFUSAL_WORDS, code), true, code);
  }
});

Deno.test("wiring: pay_run answers enabled and the run's super_marked_paid_at; the held line doors use the session only", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const payRun = src.slice(src.indexOf("case 'pay_run': {"), src.indexOf("case 'held_trade_lines':"));
  assertStringIncludes(payRun, "enabled: (await readFlag(client, PAY_RUN_SWITCH)) === true");
  const run = await Deno.readTextFile(new URL("./trade_pay_run.ts", import.meta.url));
  assertStringIncludes(run, "total_pays, super_total, status, super_marked_paid_at\"");
  const door = src.slice(src.indexOf("case 'held_trade_lines':"), src.indexOf("// Approve the weekly pay run in one press"));
  assertStringIncludes(door, "case 'decide_held_trade_line':");
  assertStringIncludes(door, "await client.rpc('decide_held_trade_line', params)");
  assertStringIncludes(door, "actorUserId: requestActor.source === 'jwt' && authMode === 'jwt' ? (authUser?.id || null) : null");
  assertEquals(door.includes("body?.actor") || door.includes("body?.org_id"), false);
});
