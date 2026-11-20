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
Deno.test("ZZTEST work order change: the server key acts only for a named staff person", async () => {
  const STAFF = "7a000000-0000-4000-8000-000000000001";
  const TRADE = "7a000000-0000-4000-8000-000000000002";
  const OTHER_ORG_STAFF = "7a000000-0000-4000-8000-000000000003";
  const people: Record<string, any> = {
    [STAFF]: { id: STAFF, org_id: "ZZTEST-org", role: "ops_manager" },
    [TRADE]: { id: TRADE, org_id: "ZZTEST-org", role: "crew" },
    [OTHER_ORG_STAFF]: { id: OTHER_ORG_STAFF, org_id: "ZZTEST-other", role: "admin" },
  };
  const rpcArgs: any[] = [];
  const client: any = {
    rpc: (_name: string, args: any) => { rpcArgs.push(args); return { data: { delta_ex: -615 }, error: null }; },
    from(table: string) {
      let id = "";
      const q: any = { select: () => q, eq: (col: string, v: string) => { if (col === "id") id = v; return q; },
        maybeSingle: () => q, then: (resolve: any) => resolve({ error: null,
          data: table === "feature_flags" ? { enabled: true } : people[id] ?? null }) };
      return q;
    },
  };
  const server = { staff: true, userId: null, orgId: "ZZTEST-org", serverKey: true };
  const body = { work_order_id: "ZZTEST-wo", to_ex: 3385, reason: "ZZTEST owner corrected the work order" };
  const call = (b: any, c: any = server) => workOrderAmountChangeAction(client, "change_work_order_amount", "POST", b, c);
  // No name, a bad name, a trade, another company's staff: refused, nothing written.
  assertEquals((await call(body)).body.code, "named_person_required");
  assertEquals((await call({ ...body, actor_user_id: "ZZTEST" })).body.code, "named_person_required");
  assertEquals((await call({ ...body, actor_user_id: TRADE })).body.code, "actor_not_staff");
  assertEquals((await call({ ...body, actor_user_id: OTHER_ORG_STAFF })).body.code, "actor_not_staff");
  // The shared browser key (no server secret) cannot name anyone.
  assertEquals((await call({ ...body, actor_user_id: STAFF }, { ...server, serverKey: false })).body.code, "named_person_required");
  // A trade session is not staff, whatever it names.
  assertEquals((await call({ ...body, actor_user_id: STAFF }, { staff: false, userId: TRADE, orgId: "ZZTEST-org" })).status, 403);
  assertEquals(rpcArgs.length, 0);
  // The reason rule still applies to the agent.
  assertEquals((await call({ ...body, reason: "", actor_user_id: STAFF })).status, 400);
  const ok = await call({ ...body, actor_user_id: STAFF });
  assertEquals(ok.status, 200);
  assertEquals(rpcArgs.map((a) => [a.p_actor, a.p_to_ex, a.p_org_id]), [[STAFF, 3385, "ZZTEST-org"]]);
  // A staff session is always itself: a named id is ignored.
  await call({ ...body, actor_user_id: STAFF }, { staff: true, userId: "ZZTEST-self", orgId: "ZZTEST-org", serverKey: false });
  assertEquals(rpcArgs[1].p_actor, "ZZTEST-self");
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
