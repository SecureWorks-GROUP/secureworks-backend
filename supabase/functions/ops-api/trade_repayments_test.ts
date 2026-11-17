// deno-lint-ignore-file no-explicit-any
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { tradeRepaymentsAction } from "./trade_repayments.ts";
Deno.test("ZZTEST repayment administration: named approver only, valid non-overlapping row, stop", async () => {
  const writes: any[] = [];
  let overlap = false;
  const client: any = { rpc: () => ({ data: 50 }), from(table: string) {
    let write: any; const q: any = { select: () => q, eq: () => q, in: () => q,
      lte: () => q, or: () => q, order: () => q, single: () => q, maybeSingle: () => q,
      insert: (row: any) => { write = row; writes.push(row); return q; },
      update: (row: any) => { write = row; writes.push(row); return q; },
      then(resolve: any) { resolve({ error: null, data: write ? { id: "ZZTEST-rule", ...write }
        : table === "trade_pay_settings" ? { pay_run_approver_user_ids: ["ZZTEST-approver"] }
        : table === "users" ? { id: "ZZTEST-trade", name: "ZZTEST trade" }
        : overlap ? [{ id: "ZZTEST-overlap" }] : { id: "ZZTEST-rule", note: "ZZTEST note" } }); } }; return q;
  } };
  const approver = { staff: true, userId: "ZZTEST-approver", orgId: "ZZTEST-org" };
  const body = { user_id: "ZZTEST-trade", label: "ZZTEST repayment", amount: 100,
    balance_total: 250, first_week_start: "2099-01-05", xero_account_code: "ZZTEST-account", note: "ZZTEST" };
  const call = (action: string, value = body, caller = approver) => tradeRepaymentsAction(client, action, "POST", value, caller);
  assertEquals((await call("set_trade_repayment", body, { ...approver, userId: null })).status, 403);
  assertEquals((await call("set_trade_repayment", body, { ...approver, userId: "ZZTEST-staff" })).status, 403);
  assertEquals((await call("set_trade_repayment", body, { ...approver, staff: false })).status, 403);
  for (const invalid of [{ label: "" }, { amount: 0 }, { balance_total: 99 },
    { first_week_start: "2000-01-03" }, { first_week_start: "2099-01-06" }, { xero_account_code: "" }]) {
    assertEquals((await call("set_trade_repayment", { ...body, ...invalid })).status, 400);
  }
  overlap = true;
  assertEquals((await call("set_trade_repayment")).status, 409);
  overlap = false;
  assertEquals((await call("set_trade_repayment")).status, 200);
  assertEquals(writes[0].kind, "repayment");
  assertEquals(writes[0].set_by, "ZZTEST-approver");
  assertEquals((await call("stop_trade_repayment", { id: "ZZTEST-rule", reason: "ZZTEST stop" } as any)).status, 200);
  assertEquals(writes[1].active, false);
  assertEquals(writes[1].note.includes("ZZTEST stop"), true);
});
