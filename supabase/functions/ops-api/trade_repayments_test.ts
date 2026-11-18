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

Deno.test("ZZTEST repayment list refuses a server key before reading people", async () => {
  const client = { from() { throw new Error("ZZTEST unexpected people read"); } };
  const out = await tradeRepaymentsAction(client, "list_trade_repayments", "GET", {},
    { staff: true, userId: null, orgId: "ZZTEST-org" });
  assertEquals(out.status, 403);
});

function listClient(settings: any) {
  const reads: string[] = [];
  const client: any = {
    rpc: () => ({ data: 40, error: null }),
    from(table: string) {
      reads.push(table);
      const q: any = { select: () => q, eq: () => q, in: () => q, order: () => q, maybeSingle: () => q,
        then(resolve: any) {
          resolve(table === "trade_pay_settings" ? settings
            : table === "users" ? { error: null, data: [{ id: "ZZTEST-trade", name: "ZZTEST trade" }] }
            : { error: null, data: [{ id: "ZZTEST-rule", user_id: "ZZTEST-trade", label: "ZZTEST label",
              amount: 10, balance_total: 50, set_by: "ZZTEST-approver-a" }] });
        } };
      return q;
    },
  };
  return { client, reads };
}
const approvers = { error: null, data: { pay_run_approver_user_ids: ["ZZTEST-approver-a", "ZZTEST-approver-b"] } };
const list = (client: any, userId: string | null) =>
  tradeRepaymentsAction(client, "list_trade_repayments", "GET", {}, { staff: true, userId, orgId: "ZZTEST-org" });

Deno.test("ZZTEST repayment list refuses a non-approver office user before reading any repayment or person", async () => {
  const { client, reads } = listClient(approvers);
  const out = await list(client, "ZZTEST-admin-not-approver");
  assertEquals(out.status, 403);
  assertEquals((out.body as any).code, "repayment_not_approver");
  assertEquals("repayments" in out.body, false);
  assertEquals(JSON.stringify(out.body).includes("ZZTEST trade"), false);
  assertEquals(JSON.stringify(out.body).includes("ZZTEST label"), false);
  assertEquals(reads, ["trade_pay_settings"]);
});

Deno.test("ZZTEST repayment list refuses when the approver setting cannot be read or is empty", async () => {
  for (const settings of [{ error: { message: "ZZTEST down" }, data: null }, { error: null, data: null },
    { error: null, data: { pay_run_approver_user_ids: null } }]) {
    const { client, reads } = listClient(settings);
    const out = await list(client, "ZZTEST-approver-a");
    assertEquals(out.status, 403);
    assertEquals(reads, ["trade_pay_settings"]);
  }
});

Deno.test("ZZTEST each named approver reads the repayment list", async () => {
  for (const userId of ["ZZTEST-approver-a", "ZZTEST-approver-b"]) {
    const { client, reads } = listClient(approvers);
    const out = await list(client, userId);
    assertEquals(out.status, 200);
    const rows = (out.body as any).repayments;
    assertEquals(rows.length, 1);
    assertEquals(rows[0].trade_name, "ZZTEST trade");
    assertEquals(rows[0].balance_left, 40);
    assertEquals(reads, ["trade_pay_settings", "users", "trade_recurring_deductions"]);
  }
});

Deno.test("ZZTEST repayment list refuses a server key and a non-staff caller with no read at all", async () => {
  for (const caller of [{ staff: true, userId: null, orgId: "ZZTEST-org" },
    { staff: false, userId: "ZZTEST-approver-a", orgId: "ZZTEST-org" }]) {
    const { client, reads } = listClient(approvers);
    const out = await tradeRepaymentsAction(client, "list_trade_repayments", "GET", {}, caller);
    assertEquals(out.status, 403);
    assertEquals(reads, []);
  }
});
