// Context reconciliation (CTX-R1): the recon_daily_list and
// recon_record_decision doors. Behaviour on the module (body contract, the
// person from the session, which SQL writer, refusal mapping) and on the real
// ops-api front door (staff only; not a trade, routine or agent-read action).
// The SQL writers' own behaviour is in the migration contracts
// 20261020140000_context_reconciliation_decisions and
// 20261020160000_context_recon_daily_list.
// deno-lint-ignore-file no-import-prefix no-explicit-any
import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  reconDailyList,
  reconDailyListArgs,
  ReconDecisionError,
  reconLeftOut,
  reconDecisionUser,
  reconRecordDecision,
  reconRecordDecisionCall,
} from "./recon_decisions.ts";
import {
  _authorizeOpsApiAction,
  _opsApiActionNeedsStaffRole,
  AGENT_READ_ALLOWED_ACTIONS,
} from "./index.ts";

const EVENT = "7c200000-0000-4000-8000-000000000001";
const INVOICE = "7d200000-0000-4000-8000-000000000001";
const JOB_A = "6f0a1c2e-0000-4000-8000-00000000a001";
const JOB_B = "6f0a1c2e-0000-4000-8000-00000000b002";
const STAFF = "5b0e0000-0000-4000-8000-000000000001";
const OTHER = "5b0e0000-0000-4000-8000-000000000002";
const HASH = "0123456789abcdef0123456789abcdef";

function fakeRpc(data: unknown, error: unknown = null) {
  const calls: { fn: string; args: any }[] = [];
  return {
    calls,
    rpc(fn: string, args?: Record<string, unknown>) {
      calls.push({ fn, args });
      return Promise.resolve({ data, error });
    },
  };
}

const staffCaller = { authMode: "jwt", userId: STAFF };

function body(over: Record<string, unknown> = {}) {
  return {
    subject_kind: "event",
    subject_id: EVENT,
    shown_hash: HASH,
    action: "confirm",
    job_ids: [JOB_A],
    cause: "ambiguity:several_candidates",
    ...over,
  };
}

Deno.test("an event decision reaches the event writer with the session user", async () => {
  const client = fakeRpc(41);
  const out = await reconRecordDecision(client, body(), staffCaller);
  assertEquals(out, { recorded: true, decision_id: 41 });
  assertEquals(client.calls, [{
    fn: "context_recon_record_decision",
    args: {
      p_event: EVENT,
      p_shown_hash: HASH,
      p_action: "confirm",
      p_job_ids: [JOB_A],
      p_cause: "ambiguity:several_candidates",
      p_user_id: STAFF,
      p_escalate_to: null,
    },
  }]);
});

Deno.test("an invoice decision reaches the invoice writer", async () => {
  const client = fakeRpc(7);
  await reconRecordDecision(
    client,
    body({ subject_kind: "invoice", subject_id: INVOICE, action: "correct", cause: "ambiguity:invoice_no_job" }),
    staffCaller,
  );
  assertEquals(client.calls[0].fn, "context_recon_record_invoice_decision");
  assertEquals(client.calls[0].args.p_invoice, INVOICE);
  assertEquals(client.calls[0].args.p_user_id, STAFF);
});

Deno.test("escalate carries who it goes to; other actions refuse it", () => {
  const call = reconRecordDecisionCall(
    body({ subject_kind: "invoice", subject_id: INVOICE, action: "escalate", job_ids: [], escalate_to: "finance", cause: "ambiguity:invoice_no_job" }),
    STAFF,
  );
  assertEquals(call.args.p_escalate_to, "finance");
  assertThrows(() => reconRecordDecisionCall(body({ escalate_to: "finance" }), STAFF), ReconDecisionError);
  assertThrows(
    () => reconRecordDecisionCall(body({ action: "escalate", job_ids: [], escalate_to: "marnin" }), STAFF),
    ReconDecisionError,
  );
});

Deno.test("a body cannot name the person", () => {
  assertThrows(() => reconRecordDecisionCall({ ...body(), user_id: OTHER }, STAFF), ReconDecisionError, "unknown field user_id");
  assertThrows(() => reconRecordDecisionCall({ ...body(), by: "person:" + OTHER }, STAFF), ReconDecisionError);
});

Deno.test("the ops screen's operator_email is ignored; the person stays the session user", () => {
  const call = reconRecordDecisionCall({ ...body(), operator_email: "someone@example.test" }, STAFF);
  assertEquals(call.args.p_user_id, STAFF);
  assertEquals(Object.values(call.args).includes("someone@example.test"), false);
});

Deno.test("a server key or missing session has no person and is refused", async () => {
  for (const caller of [{ authMode: "api_key", userId: STAFF }, { authMode: "jwt", userId: null }, { authMode: "jwt", userId: "x" }]) {
    const e = assertThrows(() => reconDecisionUser(caller), ReconDecisionError);
    assertEquals([e.code, e.status], ["person_session_required", 403]);
  }
  const client = fakeRpc(1);
  await assertRejects(() => reconRecordDecision(client, body(), { authMode: "api_key", userId: null }), ReconDecisionError);
  assertEquals(client.calls.length, 0);
});

Deno.test("the body contract: jobs fit the action, invoice actions are narrower", () => {
  const cases: Record<string, unknown>[] = [
    { action: "confirm", job_ids: [] },
    { action: "correct", job_ids: [JOB_A, JOB_B] },
    { action: "split", job_ids: [JOB_A] },
    { action: "unrelated", job_ids: [JOB_A] },
    { action: "close" },
    { subject_kind: "job" },
    { subject_id: "nope" },
    { shown_hash: "abc" },
    { cause: "because" },
    { job_ids: [JOB_A, JOB_A], action: "split" },
    { job_ids: "x" },
    { subject_kind: "invoice", action: "confirm" },
    { subject_kind: "invoice", action: "split", job_ids: [JOB_A, JOB_B] },
  ];
  for (const over of cases) {
    assertThrows(() => reconRecordDecisionCall(body(over), STAFF), ReconDecisionError);
  }
  assertThrows(() => reconRecordDecisionCall(null, STAFF), ReconDecisionError);
  assertThrows(() => reconRecordDecisionCall([], STAFF), ReconDecisionError);
  assertEquals(reconRecordDecisionCall(body({ action: "split", job_ids: [JOB_A, JOB_B] }), STAFF).args.p_job_ids, [JOB_A, JOB_B]);
  assertEquals(reconRecordDecisionCall(body({ action: "unresolved", job_ids: [] }), STAFF).args.p_job_ids, []);
});

Deno.test("SQL refusals map to plain answers; anything else is not recorded", async () => {
  const map: [string, string, number][] = [
    ["recon_not_staff", "not_staff", 403],
    ["recon_evidence_changed_since_shown", "evidence_changed", 409],
    ["recon_subject_not_found", "subject_not_found", 404],
    ["recon_job_not_found", "job_not_found", 404],
    ["recon_confirm_needs_offered_job", "job_not_offered", 422],
    ["recon_invoice_action_not_allowed", "action_not_allowed", 422],
  ];
  for (const [message, code, status] of map) {
    const e = await assertRejects(() => reconRecordDecision(fakeRpc(null, { message }), body(), staffCaller), ReconDecisionError);
    assertEquals([e.code, e.status], [code, status]);
  }
  const e = await assertRejects(
    () => reconRecordDecision(fakeRpc(null, { message: "new row violates check constraint" }), body(), staffCaller),
    ReconDecisionError,
  );
  assertEquals([e.code, e.status], ["decision_not_recorded", 502]);
});

Deno.test("the daily list reads with a bounded limit and reports a failed read", async () => {
  const now = new Date("2026-10-20T00:00:00Z");
  assertEquals(reconDailyListArgs(new URLSearchParams("action=recon_daily_list"), now), { p_as_of: "2026-10-20T00:00:00.000Z", p_limit: 50 });
  assertEquals(reconDailyListArgs(new URLSearchParams("limit=15"), now).p_limit, 15);
  for (const bad of ["0", "201", "-1", "x", "1.5"]) {
    assertThrows(() => reconDailyListArgs(new URLSearchParams("limit=" + bad), now), ReconDecisionError);
  }
  const client = fakeRpc([{ band: 1, subject_kind: "invoice" }]);
  const out = await reconDailyList(client, new URLSearchParams(""), now);
  assertEquals(out.count, 1);
  assertEquals(client.calls[0].fn, "context_recon_daily_list");
  const e = await assertRejects(() => reconDailyList(fakeRpc(null, { message: "boom" }), new URLSearchParams(""), now), ReconDecisionError);
  assertEquals([e.code, e.status], ["daily_list_unreadable", 502]);
});

Deno.test("the daily list asks one more than its page and says more only when it was cut", async () => {
  const now = new Date("2026-10-20T00:00:00Z");
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ band: 1, subject_id: `s${i}` }));
  const full = fakeRpc(rows(3));
  const exact = await reconDailyList(full, new URLSearchParams("limit=3"), now);
  assertEquals(full.calls[0].args.p_limit, 4);
  assertEquals([exact.count, exact.more, exact.limit], [3, false, 3]);
  const cut = await reconDailyList(fakeRpc(rows(4)), new URLSearchParams("limit=3"), now);
  assertEquals([cut.count, cut.more, (cut.items as unknown[]).length], [3, true, 3]);
  const top = fakeRpc(rows(201));
  const big = await reconDailyList(top, new URLSearchParams("limit=200"), now);
  assertEquals([top.calls[0].args.p_limit, big.count, big.more], [201, 200, true]);
  const none = await reconDailyList(fakeRpc([]), new URLSearchParams(""), now);
  assertEquals([none.count, none.more], [0, false]);
});

Deno.test("a daily list answer that is not a list is a failed read, never an empty list", async () => {
  const now = new Date("2026-10-20T00:00:00Z");
  for (const data of [null, undefined, {}, { items: [] }, "x", 0]) {
    const e = await assertRejects(() => reconDailyList(fakeRpc(data), new URLSearchParams(""), now), ReconDecisionError);
    assertEquals([e.code, e.status], ["daily_list_unreadable", 502]);
  }
});

Deno.test("front door: staff only, never a trade, the shared key or agent-read", () => {
  for (const action of ["recon_daily_list", "recon_record_decision"]) {
    const url = new URL(`https://x.test/ops-api?action=${action}`);
    assertEquals(_opsApiActionNeedsStaffRole(url), true);
    assertEquals(AGENT_READ_ALLOWED_ACTIONS.has(action), false);
    for (const role of ["admin", "owner", "ops_manager"]) {
      assertEquals(_authorizeOpsApiAction({ url, authMode: "jwt", authUser: { role } }).ok, true);
    }
    const trade = _authorizeOpsApiAction({ url, authMode: "jwt", authUser: { role: "lead_installer", managedVerticals: ["fencing"] } });
    assertEquals(trade.ok ? null : [trade.status, trade.code], [403, "operator_access_required"]);
    const shared = _authorizeOpsApiAction({ url, authMode: "api_key", serverSecretPresented: false });
    assertEquals(shared.ok ? null : [shared.status, shared.code], [401, "user_jwt_required"]);
  }
});

Deno.test("source: both actions are dispatched, on no routine list, the person from the session", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assertEquals(src.includes("case 'recon_daily_list':"), true);
  assertEquals(src.includes("case 'recon_record_decision':"), true);
  const start = src.indexOf("const ROUTINE_ALLOWED_ACTIONS = new Set([");
  const end = src.indexOf("])", start);
  assertEquals(start > 0 && end > start, true);
  assertEquals(src.slice(start, end).includes("recon_"), false);
  assertEquals(
    src.includes("reconRecordDecision(client, body, { authMode, userId: authMode === 'jwt' ? authUser?.id : null })"),
    true,
  );
});

Deno.test("the daily list says what it left out, and an unread count is never zero", async () => {
  const now = new Date("2026-10-20T00:00:00Z");
  const counts = { no_identity: 3, never_asked: 1, not_ranked: 2, backlog: 40 };
  const calls: { fn: string; args: any }[] = [];
  const client = {
    rpc(fn: string, args?: Record<string, unknown>) {
      calls.push({ fn, args });
      return Promise.resolve(fn === "context_recon_daily_left_out"
        ? { data: counts, error: null }
        : { data: [], error: null });
    },
  };
  const out = await reconDailyList(client, new URLSearchParams(""), now);
  assertEquals(calls.map((c) => c.fn), ["context_recon_daily_list", "context_recon_daily_left_out"]);
  assertEquals(calls[1].args, { p_as_of: "2026-10-20T00:00:00.000Z" });
  assertEquals([out.count, out.left_out, out.left_out_unreadable], [0, counts, false]);
  // A failed, list-shaped, partial or non-integer count answers null, never zeros.
  assertEquals(reconLeftOut({ data: null, error: { message: "boom" } }), null);
  assertEquals(reconLeftOut({ data: [counts], error: null }), null);
  assertEquals(reconLeftOut({ data: { ...counts, backlog: undefined }, error: null }), null);
  assertEquals(reconLeftOut({ data: { ...counts, not_ranked: 1.5 }, error: null }), null);
  assertEquals(reconLeftOut({ data: { ...counts, never_asked: -1 }, error: null }), null);
  assertEquals(reconLeftOut({ data: { ...counts, extra: 9 }, error: null }), counts);
  // The list still answers when only the count read failed.
  const half = {
    rpc(fn: string) {
      return Promise.resolve(fn === "context_recon_daily_left_out"
        ? { data: null, error: { message: "boom" } }
        : { data: [{ band: 1 }], error: null });
    },
  };
  const partial = await reconDailyList(half, new URLSearchParams(""), now);
  assertEquals([partial.count, partial.left_out, partial.left_out_unreadable], [1, null, true]);
});
