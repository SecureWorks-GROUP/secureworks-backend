// Slice EM1: the set_monitored_mailbox door. Behaviour on the module (body
// rules, RPC arguments, refusal mapping)
// and on the real ops-api front door (staff-only, never agent-read or a
// trade) plus the in-route owner-level gate.
// deno-lint-ignore-file no-import-prefix no-explicit-any
import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  canChangeMonitoredMailboxes,
  MonitoredMailboxError,
  parseSetMonitoredMailboxBody,
  setMonitoredMailbox,
} from "./monitored_mailboxes.ts";
import {
  _authorizeOpsApiAction,
  _opsApiActionNeedsStaffRole,
  AGENT_READ_ALLOWED_ACTIONS,
} from "./index.ts";

const ORG = "00000000-0000-0000-0000-000000000001";
const ACTION = "set_monitored_mailbox";

function fakeRpc(data: unknown, error: unknown = null) {
  const calls: { fn: string; args: unknown }[] = [];
  return {
    calls,
    client: {
      rpc: (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn, args });
        return Promise.resolve({ data, error });
      },
    },
  };
}

Deno.test("disabling a source passes the change and the actor to the one writer", async () => {
  const f = fakeRpc({
    outcome: "updated",
    email: "khairo@secureworkswa.com.au",
    enabled: false,
    status: "active",
  });
  const result = await setMonitoredMailbox(
    f.client,
    {
      email: " Khairo@SecureWorksWA.com.au ",
      enabled: false,
      reason: "private matter this week",
    },
    "user:u1",
  );
  assertEquals(result.outcome, "updated");
  assertEquals(f.calls, [{
    fn: "set_monitored_mailbox",
    args: {
      p_email: "khairo@secureworkswa.com.au",
      p_enabled: false,
      p_status: null,
      p_reason: "private matter this week",
      p_actor: "user:u1",
    },
  }]);
});

Deno.test("a located source is marked active and enabled in one call", async () => {
  const f = fakeRpc({ outcome: "updated" });
  await setMonitoredMailbox(
    f.client,
    {
      email: "plans@secureworkswa.com.au",
      enabled: true,
      status: "active",
      reason: "located: delivers to approvals@",
    },
    "actor_missing",
  );
  assertEquals((f.calls[0].args as any).p_enabled, true);
  assertEquals((f.calls[0].args as any).p_status, "active");
  assertEquals((f.calls[0].args as any).p_actor, "actor_missing");
});

Deno.test("the body is refused before any database call when it is malformed", () => {
  const cases: unknown[] = [
    null,
    [],
    "text",
    {
      email: "khairo@secureworkswa.com.au",
      enabled: false,
      reason: "ok reason",
      extra: 1,
    },
    { email: "not an address", enabled: false, reason: "ok reason" },
    {
      email: "khairo@secureworkswa.com.au",
      enabled: "false",
      reason: "ok reason",
    },
    {
      email: "khairo@secureworkswa.com.au",
      status: "paused",
      reason: "ok reason",
    },
    { email: "khairo@secureworkswa.com.au", reason: "ok reason" },
    { email: "khairo@secureworkswa.com.au", enabled: false },
    { email: "khairo@secureworkswa.com.au", enabled: false, reason: "no" },
    {
      email: "khairo@secureworkswa.com.au",
      enabled: false,
      reason: "two\nlines",
    },
    {
      email: "khairo@secureworkswa.com.au",
      enabled: false,
      reason: "x".repeat(301),
    },
  ];
  for (const body of cases) {
    const e = assertThrows(
      () => parseSetMonitoredMailboxBody(body),
      MonitoredMailboxError,
    );
    assertEquals(
      [e.code, e.status],
      ["monitored_mailbox_request_invalid", 400],
      JSON.stringify(body),
    );
  }
});

Deno.test("writer refusals map to their own status and code; any other fault is 503 with no detail", async () => {
  const body = {
    email: "info@secureworkswa.com.au",
    enabled: true,
    reason: "turn it on",
  };
  for (
    const [message, status] of [
      ["monitored_mailbox_unknown", 404],
      ["monitored_mailbox_enable_requires_active", 409],
      ["monitored_mailbox_kind_unknown", 409],
      ["monitored_mailbox_actor_invalid", 400],
    ] as const
  ) {
    const f = fakeRpc(null, { code: "P0001", message });
    const e = await assertRejects(
      () => setMonitoredMailbox(f.client, body, "workflow:test"),
      MonitoredMailboxError,
    );
    assertEquals([e.code, e.status], [message, status]);
  }
  const f = fakeRpc(null, {
    code: "57014",
    message: "canceling statement due to statement timeout",
  });
  const e = await assertRejects(
    () => setMonitoredMailbox(f.client, body, "workflow:test"),
    MonitoredMailboxError,
  );
  assertEquals([e.code, e.status], ["monitored_mailbox_unavailable", 503]);
  assertEquals(e.message.includes("timeout"), false);
});

Deno.test("only the server key or a company admin or owner may change the list", () => {
  assertEquals(canChangeMonitoredMailboxes("api_key", null, ORG), true);
  assertEquals(
    canChangeMonitoredMailboxes("jwt", { role: "owner", orgId: ORG }, ORG),
    true,
  );
  assertEquals(
    canChangeMonitoredMailboxes("jwt", { role: "Admin", orgId: ORG }, ORG),
    true,
  );
  // Staff but not owner-level: choosing whose mail is read is an owner decision.
  assertEquals(
    canChangeMonitoredMailboxes(
      "jwt",
      { role: "ops_manager", orgId: ORG },
      ORG,
    ),
    false,
  );
  assertEquals(
    canChangeMonitoredMailboxes(
      "jwt",
      { role: "admin", orgId: "another-org" },
      ORG,
    ),
    false,
  );
  assertEquals(
    canChangeMonitoredMailboxes(
      "jwt",
      { role: "lead_installer", orgId: ORG },
      ORG,
    ),
    false,
  );
  assertEquals(canChangeMonitoredMailboxes("jwt", null, ORG), false);
  assertEquals(canChangeMonitoredMailboxes("routine", null, ORG), false);
  assertEquals(canChangeMonitoredMailboxes("agent_read", null, ORG), false);
  assertEquals(canChangeMonitoredMailboxes("none", null, ORG), false);
});

Deno.test("front door: staff-only, never agent-read, trades and bare shared keys refused", () => {
  const url = new URL(`https://x/ops-api?action=${ACTION}`);
  assertEquals(_opsApiActionNeedsStaffRole(url), true);
  assertEquals(AGENT_READ_ALLOWED_ACTIONS.has(ACTION), false);
  const trade = _authorizeOpsApiAction({
    url,
    authMode: "jwt",
    authUser: { role: "installer" } as any,
  });
  assertEquals(trade.ok ? null : [trade.status, trade.code], [
    403,
    "operator_access_required",
  ]);
  const sharedKey = _authorizeOpsApiAction({
    url,
    authMode: "api_key",
    serverSecretPresented: false,
  });
  assertEquals(sharedKey.ok ? null : [sharedKey.status, sharedKey.code], [
    401,
    "user_jwt_required",
  ]);
});
