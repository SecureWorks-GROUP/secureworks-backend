// deno-lint-ignore-file no-explicit-any no-import-prefix
// FU49 item 4: with trade_line_hold_v1 on, a send's lines reach the database
// in job id order, so two sends on the same jobs cannot deadlock on the job
// amount guard. With the switch off, every row and payload is as on main.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { linesInJobOrder, tradeLineHoldFlagOn } from "./trade_line_send.ts";
import {
  _persistTradeInvoiceWeekDraft,
  _persistWeeklyTradeInvoice,
  tradeInvoiceLinesForInsert,
} from "./index.ts";

const JOB_A = "0a000000-0000-4000-8000-00000000000a";
const JOB_B = "0B000000-0000-4000-8000-00000000000b"; // upper case on purpose
const JOB_C = "0c000000-0000-4000-8000-00000000000c";

// The order a trade sent: C, none, A, B, A.
const sent = () => [
  { job_id: JOB_C, description: "ZZTEST 1", line_total_ex: 10 },
  { job_id: null, description: "ZZTEST 2", line_total_ex: 20 },
  { job_id: JOB_A, description: "ZZTEST 3", line_total_ex: 30 },
  { job_id: JOB_B, description: "ZZTEST 4", line_total_ex: 40 },
  { job_id: JOB_A, description: "ZZTEST 5", line_total_ex: 50 },
];
const descriptions = (rows: any[]) => rows.map((row) => row.description);

Deno.test("FU49 item 4: lines go in job id order, stable, no job last, input untouched", () => {
  const rows = sent();
  const before = JSON.stringify(rows);
  const sorted = linesInJobOrder(rows);
  assertEquals(descriptions(sorted), ["ZZTEST 3", "ZZTEST 5", "ZZTEST 4", "ZZTEST 1", "ZZTEST 2"]);
  assertEquals(JSON.stringify(rows), before);
  // Every row is the same object, fields unchanged.
  for (const row of sorted) assertEquals(rows.includes(row), true);
  // Job ids compare as the database orders a uuid: lower-case text.
  const ids = sorted.map((row) => row.job_id).filter(Boolean).map((id) => String(id).toLowerCase());
  assertEquals(ids, [...ids].sort());
  // Two sends naming the same jobs in opposite orders reach the guard in one order.
  const first = linesInJobOrder([{ job_id: JOB_B }, { job_id: JOB_A }]);
  const second = linesInJobOrder([{ job_id: JOB_A }, { job_id: JOB_B }]);
  assertEquals(first.map((r) => r.job_id), second.map((r) => r.job_id));
});

Deno.test("FU49 item 4: switch off, the insert rows are exactly as given", () => {
  const rows = sent();
  assertEquals(tradeInvoiceLinesForInsert(rows), rows);
  assertEquals(tradeInvoiceLinesForInsert(rows, { jobOrder: false }), rows);
  assertEquals(descriptions(tradeInvoiceLinesForInsert(rows, { jobOrder: true })), [
    "ZZTEST 3",
    "ZZTEST 5",
    "ZZTEST 4",
    "ZZTEST 1",
    "ZZTEST 2",
  ]);
});

function rpcClient() {
  const calls: Array<{ name: string; args: any }> = [];
  return {
    calls,
    rpc(name: string, args: any) {
      calls.push({ name, args });
      return Promise.resolve({ data: "00000000-0000-4000-8000-000000000900", error: null });
    },
  };
}

Deno.test("FU49 item 4: the weekly persist sends p_lines in job order with the sent positions, and as main when off", async () => {
  const on = rpcClient();
  await _persistTradeInvoiceWeekDraft(on, { status: "pending_ops_review" }, sent(), null, { jobOrder: true });
  const onLines = on.calls[0].args.p_lines;
  assertEquals(descriptions(onLines), ["ZZTEST 3", "ZZTEST 5", "ZZTEST 4", "ZZTEST 1", "ZZTEST 2"]);
  // Positions are the order the trade sent, fixed before the sort.
  assertEquals(onLines.map((row: any) => row.line_position), [2, 4, 3, 0, 1]);

  const off = rpcClient();
  await _persistTradeInvoiceWeekDraft(off, { status: "pending_ops_review" }, sent(), null);
  assertEquals(off.calls[0].args.p_lines, sent().map((row, line_position) => ({ ...row, line_position })));
  // Same rows either way: only the order differs.
  const byPosition = (rows: any[]) => [...rows].sort((a, b) => a.line_position - b.line_position);
  assertEquals(byPosition(onLines), off.calls[0].args.p_lines);
});

Deno.test("FU49 item 4: the weekly work-order persist keeps its own positions and sorts only when on", async () => {
  const invoice: any = {
    grand_total: 150,
    final_deductions_total: 0,
    to_be_paid: 150,
    lines: sent(),
  };
  const on = rpcClient();
  await _persistWeeklyTradeInvoice(on, { status: "pending_ops_review" }, invoice, null, { jobOrder: true });
  assertEquals(on.calls[0].args.p_lines.map((row: any) => [row.description, row.line_position]), [
    ["ZZTEST 3", 2],
    ["ZZTEST 5", 4],
    ["ZZTEST 4", 3],
    ["ZZTEST 1", 0],
    ["ZZTEST 2", 1],
  ]);
  const off = rpcClient();
  await _persistWeeklyTradeInvoice(off, { status: "pending_ops_review" }, invoice, null);
  assertEquals(off.calls[0].args.p_lines.map((row: any) => [row.description, row.line_position]), [
    ["ZZTEST 1", 0],
    ["ZZTEST 2", 1],
    ["ZZTEST 3", 2],
    ["ZZTEST 4", 3],
    ["ZZTEST 5", 4],
  ]);
});

Deno.test("FU49 item 4: the switch read is off when unreadable, which is main", async () => {
  const flagClient = (result: any) => ({
    from: () => {
      const q: any = { select: () => q, eq: () => q, limit: () => Promise.resolve(result) };
      return q;
    },
  });
  assertEquals(await tradeLineHoldFlagOn(flagClient({ data: [{ enabled: true }], error: null })), true);
  assertEquals(await tradeLineHoldFlagOn(flagClient({ data: [{ enabled: false }], error: null })), false);
  assertEquals(await tradeLineHoldFlagOn(flagClient({ data: [], error: null })), false);
  assertEquals(await tradeLineHoldFlagOn(flagClient({ data: null, error: { code: "ZZTEST" } })), false);
  assertEquals(await tradeLineHoldFlagOn({ from: () => { throw new Error("ZZTEST"); } }), false);
});
