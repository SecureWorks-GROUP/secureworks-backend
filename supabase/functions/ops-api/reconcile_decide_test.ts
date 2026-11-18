// deno-lint-ignore-file no-explicit-any
// P2-03.7: the Reconcile decide door (decide only). Fake client only; made-up
// amounts; roles only.
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  RECONCILE_DECIDE_FLAG,
  RECONCILE_DECIDE_WORDS,
  reconcileDecide,
  ReconcileDecideError,
} from "./reconcile_decide.ts";

const STAFF = "11111111-1111-4111-8111-111111111111";
const ITEM = "22222222-2222-4222-8222-222222222222";
const JOB_A = "33333333-3333-4333-8333-333333333333";
const JOB_B = "44444444-4444-4444-8444-444444444444";
const LINE = "55555555-5555-4555-8555-555555555555";

type World = {
  flag?: boolean | "missing" | "fail";
  kind?: string | null;
  rpcError?: Record<string, unknown>;
  rpcs: Array<{ fn: string; args: any }>;
  reads: string[];
};

function fake(w: World) {
  const q = (table: string) => {
    w.reads.push(table);
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: () =>
        Promise.resolve(
          table === "reconcile_items"
            ? { data: w.kind ? { id: ITEM, kind: w.kind } : null, error: null }
            : { data: null, error: null },
        ),
      then: (res: any, rej: any) =>
        Promise.resolve(
          table === "feature_flags"
            ? w.flag === "fail"
              ? { data: null, error: { message: "x" } }
              : w.flag === "missing"
              ? { data: [], error: null }
              : { data: [{ enabled: w.flag === true }], error: null }
            : { data: [], error: null },
        ).then(res, rej),
    };
    return chain;
  };
  return {
    from: q,
    rpc(fn: string, args: any) {
      w.rpcs.push({ fn, args });
      if (w.rpcError) return Promise.resolve({ data: null, error: w.rpcError });
      return Promise.resolve({
        data: { decision_id: 7, item_status: "decided", lines: [{ line_id: LINE, state: "on_job" }] },
        error: null,
      });
    },
  };
}

const world = (over: Partial<World> = {}): World => ({
  flag: true,
  kind: "bill",
  rpcs: [],
  reads: [],
  ...over,
});
const staff = { authMode: "jwt", userId: STAFF, isStaff: true };
const place = {
  item_id: ITEM,
  shown_hash: "abc",
  action: "place",
  parts: [{ job_id: JOB_A }],
  operator_email: "ops@example.invalid",
};

async function refused(p: Promise<unknown>): Promise<ReconcileDecideError> {
  return await assertRejects(() => p, ReconcileDecideError) as ReconcileDecideError;
}

Deno.test("door: a server key, the routine and an agent get 403 before the switch or the body is read", async () => {
  for (const authMode of ["api_key", "routine", "agent_read", "none"]) {
    const w = world();
    const err = await refused(
      reconcileDecide(fake(w) as any, place, { authMode, userId: null, isStaff: false }),
    );
    assertEquals([err.status, err.code], [403, "person_session_required"]);
    assertEquals(w.reads, [], `${authMode}: nothing read`);
    assertEquals(w.rpcs, [], `${authMode}: nothing called`);
  }
  // A body naming an actor does not make a server key a person.
  const err = await refused(
    reconcileDecide(fake(world()) as any, { ...place, actor: STAFF }, {
      authMode: "api_key",
      userId: STAFF,
      isStaff: true,
    }),
  );
  assertEquals(err.code, "person_session_required");
});

Deno.test("door: a signed-in person who is not staff gets 403", async () => {
  const w = world();
  const err = await refused(
    reconcileDecide(fake(w) as any, place, { authMode: "jwt", userId: STAFF, isStaff: false }),
  );
  assertEquals([err.status, err.code], [403, "operator_access_required"]);
  assertEquals(w.rpcs, []);
});

Deno.test("switch: off, missing or unreadable refuses and calls nothing", async () => {
  for (const flag of [false, "missing"] as const) {
    const w = world({ flag });
    const err = await refused(reconcileDecide(fake(w) as any, place, staff));
    assertEquals([err.status, err.code], [409, "reconcile_decide_off"]);
    assertEquals(w.rpcs, []);
  }
  const w = world({ flag: "fail" });
  const err = await refused(reconcileDecide(fake(w) as any, place, staff));
  assertEquals([err.status, err.code], [503, "reconcile_switch_unreadable"]);
  assertEquals(w.rpcs, []);
  assertEquals(RECONCILE_DECIDE_FLAG, "reconcile_decide_v1");
});

Deno.test("place: a staff session calls reconcile_decide with the session user, never a body actor", async () => {
  const w = world();
  const out = await reconcileDecide(fake(w) as any, place, staff);
  assertEquals(w.rpcs[0], {
    fn: "reconcile_decide",
    args: {
      p_item_id: ITEM,
      p_shown_hash: "abc",
      p_action: "place",
      p_parts: [{ job_id: JOB_A }],
      p_note: null,
      p_accepted_suggestion: false,
      p_user_id: STAFF,
    },
  });
  // No Job Profit refresh in the request: the database marks the job and the
  // timers refresh it under their own switch and lock.
  assertEquals(w.rpcs.length, 1);
  assertEquals([out.decided, out.decision_id, out.item_status], [true, 7, "decided"]);
});

Deno.test("split across two jobs and filed as not a job cost reach the database as sent", async () => {
  const w = world();
  const parts = [
    { line_id: LINE, target: "job", job_id: JOB_A, amount_ex: 600 },
    { line_id: LINE, target: "job", job_id: JOB_B, amount_ex: 300 },
    { line_id: LINE, target: "overhead", amount_ex: 100 },
  ];
  await reconcileDecide(fake(w) as any, { ...place, action: "split", parts, accepted_suggestion: true }, staff);
  assertEquals([w.rpcs[0].args.p_action, w.rpcs[0].args.p_parts, w.rpcs[0].args.p_accepted_suggestion], ["split", parts, true]);
  const o = world();
  await reconcileDecide(fake(o) as any, { item_id: ITEM, shown_hash: "abc", action: "overhead" }, staff);
  assertEquals([o.rpcs[0].fn, o.rpcs[0].args.p_action, o.rpcs[0].args.p_parts], ["reconcile_decide", "overhead", null]);
});

Deno.test("kind switch: a message item calls reconcile_decide_message", async () => {
  const w = world({ kind: "message" });
  await reconcileDecide(fake(w) as any, {
    item_id: ITEM,
    shown_hash: "abc",
    action: "confirm",
    job_ids: [JOB_A],
    cause: "ambiguity:two_jobs",
  }, staff);
  assertEquals(w.rpcs[0], {
    fn: "reconcile_decide_message",
    args: {
      p_item_id: ITEM,
      p_shown_hash: "abc",
      p_action: "confirm",
      p_job_ids: [JOB_A],
      p_cause: "ambiguity:two_jobs",
      p_escalate_to: null,
      p_user_id: STAFF,
    },
  });
  // Not installed yet on main (P2-03.5): a plain 503, nothing changed.
  const missing = world({ kind: "message", rpcError: { code: "PGRST202", message: "Could not find the function" } });
  const err = await refused(reconcileDecide(fake(missing) as any, { item_id: ITEM, shown_hash: "abc", action: "confirm" }, staff));
  assertEquals([err.status, err.code], [503, "reconcile_function_missing"]);
});

Deno.test("database refusals map to their words; evidence changed is 409", async () => {
  const cases: Array<[string, number]> = [
    ["reconcile_evidence_changed", 409],
    ["reconcile_item_closed", 409],
    ["reconcile_parts_do_not_add_up", 409],
    ["reconcile_job_not_live", 409],
    ["reconcile_division_unknown", 409],
    ["reconcile_not_staff", 403],
  ];
  for (const [code, status] of cases) {
    const w = world({ rpcError: { code: "P0001", message: code } });
    const err = await refused(reconcileDecide(fake(w) as any, place, staff));
    assertEquals([err.status, err.code, err.message], [status, code, RECONCILE_DECIDE_WORDS[code][1]]);
    assertEquals(w.rpcs.length, 1, "one call, nothing after a refusal");
  }
  assertEquals(
    RECONCILE_DECIDE_WORDS.reconcile_evidence_changed[1],
    "This changed while you were looking. The list has been read again, please choose again.",
  );
  const unknown = world({ rpcError: { code: "XX000", message: "some internal text with 123.45" } });
  const err = await refused(reconcileDecide(fake(unknown) as any, place, staff));
  assertEquals([err.status, err.code], [500, "reconcile_failed"]);
  assert(!/\d/.test(err.message));
});

Deno.test("body: an unknown field such as actor is 400; a missing item is 404; an unknown action is refused before any write", async () => {
  for (const body of [
    { ...place, actor: "person:x" },
    { ...place, user_id: STAFF },
    { ...place, item_id: "not-a-uuid" },
    { ...place, shown_hash: "" },
    { ...place, parts: "x" },
    { ...place, accepted_suggestion: "yes" },
    null,
  ]) {
    const w = world();
    const err = await refused(reconcileDecide(fake(w) as any, body, staff));
    assertEquals([err.status, err.code], [400, "invalid_request"]);
    assertEquals(w.rpcs, []);
  }
  const gone = world({ kind: null });
  assertEquals((await refused(reconcileDecide(fake(gone) as any, place, staff))).status, 404);
  const odd = world();
  const err = await refused(reconcileDecide(fake(odd) as any, { ...place, action: "undo" }, staff));
  assertEquals(err.code, "reconcile_action_unknown");
  assertEquals(odd.rpcs, []);
});

Deno.test("words: every message is plain, with no code, underscore, dollar or em dash", () => {
  for (const [code, [status, words]] of Object.entries(RECONCILE_DECIDE_WORDS)) {
    assert([400, 403, 404, 405, 409, 500, 503].includes(status), code);
    assert(!/[_$]|\u2014/.test(words), `${code}: ${words}`);
    assert(!words.includes("reconcile"), code);
  }
});

Deno.test("credit notes: a credit item is decided like a bill, negative parts sent as they are", async () => {
  // A supplier credit waiting on an undecided bill: the person places it
  // directly; reconcile_decide records it on the credit's own lines.
  const placed = world({ kind: "credit" });
  await reconcileDecide(fake(placed) as any, { ...place, accepted_suggestion: false }, staff);
  assertEquals([placed.rpcs[0].fn, placed.rpcs[0].args.p_action], ["reconcile_decide", "place"]);
  const split = world({ kind: "credit" });
  const parts = [
    { line_id: LINE, target: "job", job_id: JOB_A, amount_ex: -60 },
    { line_id: LINE, target: "job", job_id: JOB_B, amount_ex: -40 },
  ];
  await reconcileDecide(fake(split) as any, { ...place, action: "split", parts }, staff);
  assertEquals(split.rpcs[0].args.p_parts, parts);
  const filed = world({ kind: "credit" });
  await reconcileDecide(fake(filed) as any, { item_id: ITEM, shown_hash: "abc", action: "overhead" }, staff);
  assertEquals(filed.rpcs[0].args.p_action, "overhead");
  // A part of the wrong sign is the database's refusal, in plain words.
  const wrong = world({ kind: "credit", rpcError: { code: "P0001", message: "reconcile_parts_do_not_add_up" } });
  const err = await refused(reconcileDecide(fake(wrong) as any, { ...place, action: "split", parts }, staff));
  assertEquals([err.status, err.message], [409, "The parts do not add up to the line."]);
});
