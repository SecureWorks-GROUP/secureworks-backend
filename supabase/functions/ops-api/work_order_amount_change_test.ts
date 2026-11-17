// deno-lint-ignore-file no-explicit-any
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { workOrderAmountChangeAction, recordWorkOrderPeopleChange } from "./work_order_amount_change.ts";
Deno.test("ZZTEST work order change: staff identity, reason, switch, RPC refusal and newest list", async () => {
  let enabled = true; let calls = 0; let rpcError: any = null;
  const changes = [{ id: "ZZTEST-new", changed_at: "2099-01-02" }, { id: "ZZTEST-old", changed_at: "2099-01-01" }];
  const client: any = { rpc: () => { calls++; return { data: { delta_ex: 224 }, error: rpcError }; }, from(table: string) {
    const q: any = { select: () => q, eq: () => q, lt: () => q, limit: () => q,
      order: () => q, maybeSingle: () => q, then: (resolve: any) => resolve({ error: null,
        data: table === "feature_flags" ? { enabled } : changes }) }; return q;
  } };
  const actor = { staff: true, userId: "ZZTEST-staff", orgId: "ZZTEST-org" };
  const body = { work_order_id: "ZZTEST-wo", to_ex: 1344, reason: "ZZTEST extra work" };
  const call = (b = body, a = actor) => workOrderAmountChangeAction(client, "change_work_order_amount", "POST", b, a);
  assertEquals((await call(body, { ...actor, staff: false })).status, 403);
  assertEquals((await call(body, { ...actor, userId: null })).status, 403);
  assertEquals((await call({ ...body, reason: " " })).status, 400);
  assertEquals(calls, 0);
  enabled = false; assertEquals((await call()).status, 409); assertEquals(calls, 0);
  enabled = true; assertEquals((await call()).status, 200); assertEquals(calls, 1);
  for (const code of ["work_order_split_locked", "work_order_change_below_billed", "work_order_not_approved"]) {
    rpcError = { message: code }; const result = await call(); assertEquals(result.status, 409); assertEquals(result.body.code, code);
  }
  const list = await workOrderAmountChangeAction(client, "work_order_changes", "GET", {}, actor);
  assertEquals(list.body.changes.map((row: any) => row.id), ["ZZTEST-new", "ZZTEST-old"]);
});
Deno.test("ZZTEST people change: price-free row and best effort failure", async () => {
  let written: any;
  const client = { from: () => ({ insert: (row: any) => { written = row; return { error: null }; } }) };
  await recordWorkOrderPeopleChange(client, { orgId: "ZZTEST-org", workOrderId: "ZZTEST-wo", jobId: "ZZTEST-job",
    actorUserId: "ZZTEST-staff", reason: "ZZTEST remove", detail: { action: "remove" } });
  assertEquals([written.kind, written.delta_ex, written.from_ex, written.to_ex], ["people", 0, null, null]);
  await recordWorkOrderPeopleChange({ from: () => { throw new Error("ZZTEST failure"); } }, {
    orgId: "ZZTEST-org", workOrderId: "ZZTEST-wo", jobId: "ZZTEST-job", actorUserId: "ZZTEST-staff",
    reason: "ZZTEST restore", detail: { action: "restore" } });
});
