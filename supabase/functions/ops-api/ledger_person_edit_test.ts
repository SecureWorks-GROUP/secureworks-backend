// Job story v1: the ledger_person_edit door. Behaviour on the module (body
// contract, the person from the session, RPC arguments, refusal mapping) and
// on the real ops-api front door (staff only; not a trade, routine or
// agent-read action). The SQL writer's own behaviour is in the migration
// contract supabase/tests/migration-contracts/20261006013000_context_ledger_store.
// deno-lint-ignore-file no-import-prefix no-explicit-any
import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ledgerPersonEdit,
  ledgerPersonEditArgs,
  LedgerPersonEditError,
  ledgerPersonEditUser,
} from "./ledger_person_edit.ts";
import {
  _authorizeOpsApiAction,
  _opsApiActionNeedsStaffRole,
  AGENT_READ_ALLOWED_ACTIONS,
} from "./index.ts";

const JOB = "6f0a1c2e-0000-4000-8000-00000000a001";
const STAFF = "5b0e0000-0000-4000-8000-000000000001";
const OTHER = "5b0e0000-0000-4000-8000-000000000002";
const KEY = "request:quote:rest-of-fence:0123456789ab";

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

Deno.test("a close reaches the SQL writer with the session user, never a body user", async () => {
  const rpc = fakeRpc({
    outcome: "edited",
    action: "close",
    item_key: KEY,
    status: "closed",
  });
  const out = await ledgerPersonEdit(rpc, {
    job_id: JOB,
    action: "close",
    item_key: KEY,
    note: "  Quote sent by email on Monday.  ",
  }, staffCaller);
  assertEquals(out.status, "closed");
  assertEquals(rpc.calls, [{
    fn: "context_ledger_person_edit",
    args: {
      p_job_id: JOB,
      p_user_id: STAFF,
      p_action: "close",
      p_item_key: KEY,
      p_note: "Quote sent by email on Monday.",
      p_item: null,
    },
  }]);
});

Deno.test("a body cannot name the person", () => {
  for (const field of ["user_id", "p_user_id", "userId", "operator_email"]) {
    assertThrows(
      () =>
        ledgerPersonEditArgs({
          job_id: JOB,
          action: "close",
          item_key: KEY,
          note: "x",
          [field]: OTHER,
        }, STAFF),
      LedgerPersonEditError,
      `unknown field ${field}`,
    );
  }
});

Deno.test("a server key, routine or missing session has no person and is refused", async () => {
  for (
    const caller of [
      { authMode: "api_key", userId: null },
      { authMode: "api_key", userId: STAFF },
      { authMode: "routine", userId: null },
      { authMode: "agent_read", userId: null },
      { authMode: "jwt", userId: null },
      { authMode: "jwt", userId: "not-a-uuid" },
    ]
  ) {
    const rpc = fakeRpc({ outcome: "edited" });
    const err = await assertRejects(
      () =>
        ledgerPersonEdit(rpc, {
          job_id: JOB,
          action: "close",
          item_key: KEY,
          note: "x",
        }, caller),
      LedgerPersonEditError,
    );
    assertEquals([err.code, err.status], ["person_session_required", 403]);
    assertEquals(rpc.calls.length, 0);
  }
  assertEquals(ledgerPersonEditUser(staffCaller), STAFF);
});

Deno.test("the body contract", () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ action: "close", item_key: KEY, note: "x" }, "job_id must be a uuid"],
    [
      { job_id: JOB, action: "delete", item_key: KEY, note: "x" },
      "action must be one of",
    ],
    [{ job_id: JOB, action: "close", item_key: KEY }, "note is required"],
    [
      { job_id: JOB, action: "close", item_key: KEY, note: "   " },
      "note is required",
    ],
    [
      { job_id: JOB, action: "close", item_key: KEY, note: "x".repeat(601) },
      "at most 600",
    ],
    [{ job_id: JOB, action: "close", note: "x" }, "item_key is required"],
    [{
      job_id: JOB,
      action: "reopen",
      item_key: KEY,
      note: "x",
      item: { what: "y" },
    }, "item is only used when adding"],
    [{ job_id: JOB, action: "add", note: "x" }, "item must be a JSON object"],
    [
      { job_id: JOB, action: "add", note: "x", item: [] },
      "item must be a JSON object",
    ],
    [
      { job_id: JOB, action: "add", item_key: KEY, note: "x", item: {} },
      "item_key is not used",
    ],
  ];
  for (const [body, message] of cases) {
    assertThrows(
      () => ledgerPersonEditArgs(body, STAFF),
      LedgerPersonEditError,
      message,
    );
  }
  assertThrows(
    () => ledgerPersonEditArgs([], STAFF),
    LedgerPersonEditError,
    "JSON object",
  );
});

Deno.test("an added item passes through whole for the writer to check", async () => {
  const item = {
    item_type: "constraint",
    status: "open",
    from_role: "customer",
    what: "No noise before 8am",
    about_key: "access:start-time",
  };
  const rpc = fakeRpc({
    outcome: "edited",
    action: "add",
    item_key: "constraint:access:start-time:abcdefabcdef",
    status: "open",
  });
  await ledgerPersonEdit(rpc, {
    job_id: JOB,
    action: "add",
    note: "Told me by phone.",
    item,
  }, staffCaller);
  assertEquals(rpc.calls[0].args.p_item, item);
  assertEquals(rpc.calls[0].args.p_item_key, null);
  assertEquals(rpc.calls[0].args.p_action, "add");
});

Deno.test("the writer's refusals map to HTTP statuses with their code", async () => {
  const expected: [string, number][] = [
    ["not_staff", 403],
    ["note_required", 400],
    ["no_live_ledger", 409],
    ["unknown_item", 404],
    ["duplicate_item", 409],
    ["excerpt_not_verbatim", 422],
    ["invalid_shape", 422],
  ];
  for (const [code, status] of expected) {
    const rpc = fakeRpc({ outcome: "refused", code, detail: "why" });
    const err = await assertRejects(
      () =>
        ledgerPersonEdit(rpc, {
          job_id: JOB,
          action: "close",
          item_key: KEY,
          note: "x",
        }, staffCaller),
      LedgerPersonEditError,
    );
    assertEquals([err.code, err.status, err.detail.detail], [
      code,
      status,
      "why",
    ]);
  }
});

Deno.test("no_change is an answer, not an error; a database fault is 503", async () => {
  const same = fakeRpc({
    outcome: "no_change",
    item_key: KEY,
    status: "closed",
  });
  assertEquals(
    (await ledgerPersonEdit(same, {
      job_id: JOB,
      action: "close",
      item_key: KEY,
      note: "x",
    }, staffCaller)).outcome,
    "no_change",
  );
  const invalid = fakeRpc(null, {
    message: "context_ledger_person_edit_invalid",
  });
  const e1 = await assertRejects(
    () =>
      ledgerPersonEdit(invalid, {
        job_id: JOB,
        action: "close",
        item_key: KEY,
        note: "x",
      }, staffCaller),
    LedgerPersonEditError,
  );
  assertEquals([e1.code, e1.status], ["invalid_request", 400]);
  const down = fakeRpc(null, { message: "connection reset" });
  const e2 = await assertRejects(
    () =>
      ledgerPersonEdit(down, {
        job_id: JOB,
        action: "close",
        item_key: KEY,
        note: "x",
      }, staffCaller),
    LedgerPersonEditError,
  );
  assertEquals([e2.code, e2.status], ["ledger_edit_failed", 503]);
  const empty = fakeRpc(null);
  const e3 = await assertRejects(
    () =>
      ledgerPersonEdit(empty, {
        job_id: JOB,
        action: "close",
        item_key: KEY,
        note: "x",
      }, staffCaller),
    LedgerPersonEditError,
  );
  assertEquals(e3.status, 503);
});

Deno.test("front door: staff only, never a trade, the shared key or agent-read", () => {
  const url = new URL("https://x.test/ops-api?action=ledger_person_edit");
  assertEquals(_opsApiActionNeedsStaffRole(url), true);
  assertEquals(AGENT_READ_ALLOWED_ACTIONS.has("ledger_person_edit"), false);
  for (const role of ["admin", "owner", "ops_manager"]) {
    assertEquals(
      _authorizeOpsApiAction({ url, authMode: "jwt", authUser: { role } }).ok,
      true,
    );
  }
  const trade = _authorizeOpsApiAction({
    url,
    authMode: "jwt",
    authUser: { role: "lead_installer", managedVerticals: ["fencing"] },
  });
  assertEquals(trade.ok ? null : [trade.status, trade.code], [
    403,
    "operator_access_required",
  ]);
  const shared = _authorizeOpsApiAction({
    url,
    authMode: "api_key",
    serverSecretPresented: false,
  });
  assertEquals(shared.ok ? null : [shared.status, shared.code], [
    401,
    "user_jwt_required",
  ]);
});

Deno.test("source: the action is dispatched and on no routine allow-list", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assertEquals(src.includes("case 'ledger_person_edit':"), true);
  const start = src.indexOf("const ROUTINE_ALLOWED_ACTIONS = new Set([");
  const end = src.indexOf("])", start);
  assertEquals(start > 0 && end > start, true);
  assertEquals(src.slice(start, end).includes("ledger_person_edit"), false);
  // The person comes only from the verified session.
  assertEquals(
    src.includes(
      "ledgerPersonEdit(client, body, { authMode, userId: authMode === 'jwt' ? authUser?.id : null })",
    ),
    true,
  );
});
