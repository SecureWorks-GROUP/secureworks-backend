// deno-lint-ignore-file no-explicit-any
// P2-03.4: the Reconcile undo door. Fake client only; made-up ids; roles only.
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { RECONCILE_DECIDE_FLAG, RECONCILE_DECIDE_WORDS, ReconcileDecideError } from "./reconcile_decide.ts";
import { reconcileUndo, reconcileUndoInput } from "./reconcile_undo.ts";

const STAFF = "11111111-1111-4111-8111-111111111111";
const ITEM = "22222222-2222-4222-8222-222222222222";

type World = {
  flag?: boolean | "missing" | "fail";
  rpcError?: Record<string, unknown>;
  rpcThrows?: boolean;
  rpcData?: unknown;
  rpcs: Array<{ fn: string; args: any }>;
  reads: Array<{ table: string; filters: Record<string, unknown> }>;
};

function fake(w: World) {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const chain: any = {
        select: () => chain,
        eq: (k: string, v: unknown) => ((filters[k] = v), chain),
        then: (res: any, rej: any) => {
          w.reads.push({ table, filters });
          return Promise.resolve(
            w.flag === "fail"
              ? { data: null, error: { message: "x" } }
              : w.flag === "missing"
              ? { data: [], error: null }
              : { data: [{ enabled: w.flag === true }], error: null },
          ).then(res, rej);
        },
      };
      return chain;
    },
    rpc(fn: string, args: any) {
      w.rpcs.push({ fn, args });
      if (w.rpcThrows) return Promise.reject(new Error("network"));
      if (w.rpcError) return Promise.resolve({ data: null, error: w.rpcError });
      return Promise.resolve({
        data: w.rpcData === undefined ? { decision_id: 42, restored_item_id: ITEM } : w.rpcData,
        error: null,
      });
    },
  };
}

const world = (over: Partial<World> = {}): World => ({ flag: true, rpcs: [], reads: [], ...over });
const staff = { authMode: "jwt", userId: STAFF, isStaff: true };

async function refused(p: Promise<unknown>): Promise<ReconcileDecideError> {
  return await assertRejects(() => p, ReconcileDecideError) as ReconcileDecideError;
}

Deno.test("undo door: a server key, the routine and an agent get 403 before the switch or the body is read", async () => {
  for (const authMode of ["api_key", "routine", "agent_read", "none"]) {
    const w = world();
    const err = await refused(reconcileUndo(fake(w) as any, { decision_id: 7 }, { authMode, userId: null, isStaff: false }));
    assertEquals([err.status, err.code], [403, "person_session_required"]);
    assertEquals([w.reads.length, w.rpcs.length], [0, 0], authMode);
  }
});

Deno.test("undo door: a signed-in person who is not staff gets 403, nothing read", async () => {
  const w = world();
  const err = await refused(reconcileUndo(fake(w) as any, { decision_id: 7 }, { authMode: "jwt", userId: STAFF, isStaff: false }));
  assertEquals([err.status, err.code], [403, "operator_access_required"]);
  assertEquals([w.reads.length, w.rpcs.length], [0, 0]);
});

Deno.test("undo switch: the decide switch; off, missing or unreadable refuses and calls nothing", async () => {
  for (const [flag, status, code] of [
    [false, 409, "reconcile_decide_off"],
    ["missing", 409, "reconcile_decide_off"],
    ["fail", 503, "reconcile_switch_unreadable"],
  ] as const) {
    const w = world({ flag });
    const err = await refused(reconcileUndo(fake(w) as any, { decision_id: 7 }, staff));
    assertEquals([err.status, err.code], [status, code]);
    assertEquals(w.rpcs.length, 0);
    assertEquals(w.reads[0].filters.flag_name, RECONCILE_DECIDE_FLAG);
  }
});

Deno.test("undo: a staff session calls reconcile_undo with the session user, never a body actor; answer shape", async () => {
  const w = world();
  const out = await reconcileUndo(fake(w) as any, { decision_id: 7, operator_email: "ops@example.invalid" }, staff);
  assertEquals(w.rpcs, [{ fn: "reconcile_undo", args: { p_decision_id: "7", p_user_id: STAFF } }]);
  assertEquals(out, { ok: true, undone: true, decision_id: 42, restored_item_id: ITEM });
  // A decision that closed no item.
  const w2 = world({ rpcData: { decision_id: 43, restored_item_id: null } });
  assertEquals(await reconcileUndo(fake(w2) as any, { decision_id: "8" }, staff),
    { ok: true, undone: true, decision_id: 43, restored_item_id: null });
  assertEquals(w2.rpcs[0].args.p_decision_id, "8");
});

Deno.test("undo body: only decision_id (and the ignored operator_email); anything else is 400 before any call", async () => {
  for (const body of [
    null, [], {}, { decision_id: 0 }, { decision_id: -1 }, { decision_id: 1.5 }, { decision_id: "07" },
    { decision_id: "abc" }, { decision_id: "1".repeat(19) }, { decision_id: 2 ** 60 },
    { decision_id: 7, actor: STAFF }, { decision_id: 7, user_id: STAFF }, { decision_id: 7, item_id: ITEM },
  ]) {
    const w = world();
    const err = await refused(reconcileUndo(fake(w) as any, body, staff));
    assertEquals([err.status, err.code], [400, "invalid_request"], JSON.stringify(body));
    assertEquals(w.rpcs.length, 0);
  }
  assertEquals(reconcileUndoInput({ decision_id: "123456789012345678" }).decisionId, "123456789012345678");
});

Deno.test("undo: database refusals map to their words, 409 (403 for not staff); unknown is 500 and says nothing internal", async () => {
  const cases: Array<[string, number]> = [
    ["reconcile_not_latest", 409],
    ["reconcile_snapshot_missing", 409],
    ["reconcile_item_changed", 409],
    ["reconcile_item_kind_unknown", 409],
    ["reconcile_document_changed", 409],
    ["reconcile_match_evidence_missing", 409],
    ["reconcile_restore_invalid", 409],
    ["reconcile_not_staff", 403],
  ];
  for (const [code, status] of cases) {
    const w = world({ rpcError: { code: "P0001", message: code } });
    const err = await refused(reconcileUndo(fake(w) as any, { decision_id: 7 }, staff));
    assertEquals([err.status, err.code, err.message], [status, code, RECONCILE_DECIDE_WORDS[code][1]]);
    assertEquals(w.rpcs.length, 1);
  }
  const missing = await refused(reconcileUndo(fake(world({ rpcError: { code: "PGRST202", message: "x" } })) as any, { decision_id: 7 }, staff));
  assertEquals([missing.status, missing.code], [503, "reconcile_function_missing"]);
  const unknown = await refused(reconcileUndo(fake(world({ rpcError: { code: "XX000", message: "internal 123.45" } })) as any, { decision_id: 7 }, staff));
  assertEquals([unknown.status, unknown.code], [500, "reconcile_failed"]);
  assert(!unknown.message.includes("123.45"));
  const threw = await refused(reconcileUndo(fake(world({ rpcThrows: true })) as any, { decision_id: 7 }, staff));
  assertEquals([threw.status, threw.code], [500, "reconcile_failed"]);
});

Deno.test("undo words: plain, with no code, underscore, dollar or em dash", () => {
  for (const code of Object.keys(RECONCILE_DECIDE_WORDS)) {
    const words = RECONCILE_DECIDE_WORDS[code][1];
    assert(!/[_$—]/.test(words) && !words.includes(code), code);
  }
});

Deno.test("undo route: ops-api routes reconcile_undo through the decide door's caller rule, org check and POST check", () => {
  const src = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));
  const at = src.indexOf("case 'reconcile_undo':");
  assert(at > 0, "routed");
  const block = src.slice(src.lastIndexOf("case 'reconcile_decide':", at), src.indexOf("// ── Invoice context door", at));
  assert(block.includes("_opsApiStaffOperatorRole(authUser?.role)"), "staff set");
  assert(block.includes("userId: authMode === 'jwt' ? authUser?.id : null"), "session user only");
  assert(block.includes("operator_org_required") && block.includes("method_not_allowed"), "org and POST");
  assert(block.includes("reconcileUndo(client, body, reconcileCaller)"), "undo door");
  const listed = Deno.readTextFileSync(new URL("../../../scripts/_ops-api-required-actions.txt", import.meta.url));
  assert(/^reconcile_undo # probe=source-only$/m.test(listed));
});

Deno.test("undo switch in the database: a refusal raised by reconcile_undo itself is the door's 409 words", async () => {
  const w = world({ rpcError: { code: "55000", message: "reconcile_decide_off" } });
  const err = await refused(reconcileUndo(fake(w) as any, { decision_id: 7 }, staff));
  assertEquals(
    [err.status, err.code, err.message],
    [409, "reconcile_decide_off", RECONCILE_DECIDE_WORDS.reconcile_decide_off[1]],
  );
  assertEquals(w.rpcs.length, 1, "one call, nothing after the refusal");
});
