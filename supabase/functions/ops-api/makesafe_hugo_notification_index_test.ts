// deno-lint-ignore-file no-explicit-any no-import-prefix

import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _loadHugoNotificationConfigForTest,
  _loadRepairNotificationConfigForTest,
  _sendSmsViaGhlWithReceiptForTest,
} from "./index.ts";

function configClient(users: any[], settings: any = {
  notify_enabled: true,
  from_number: "+61000000000",
  arrival_general_phones: ["+61000000001"],
}) {
  return {
    from(table: string) {
      if (table === "makesafe_notify_settings") {
        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          maybeSingle: () => Promise.resolve({ data: settings, error: null }),
        };
      }
      if (table === "users") {
        return {
          select() {
            return this;
          },
          contains() {
            return this;
          },
          not: () => Promise.resolve({ data: users, error: null }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

Deno.test("Hugo recipient resolves from the one configured make-safe manager, not a code phone", async () => {
  const result = await _loadHugoNotificationConfigForTest(
    configClient([
      {
        id: "hugo-user",
        name: "Configured manager",
        phone: "+61000000001",
        role: "manager",
        managed_verticals: ["makesafe"],
      },
      {
        id: "dispatcher",
        name: "Dispatcher",
        phone: "+61000000002",
        role: "ops_manager",
        managed_verticals: ["makesafe"],
      },
    ]),
  );

  assertEquals(result, {
    enabled: true,
    fromNumber: "+61000000000",
    recipient: {
      userId: "hugo-user",
      name: "Configured manager",
      phone: "+61000000001",
    },
    failureReason: null,
  });
});

Deno.test("Hugo recipient ambiguity fails closed for durable audit instead of fan-out", async () => {
  const result = await _loadHugoNotificationConfigForTest(
    configClient([
      {
        id: "manager-a",
        name: "A",
        phone: "+61000000001",
        role: "manager",
        managed_verticals: ["makesafe"],
      },
      {
        id: "manager-b",
        name: "B",
        phone: "+61000000001",
        role: "manager",
        managed_verticals: ["makesafe"],
      },
    ]),
  );

  assertEquals(result.recipient, null);
  assertEquals(result.failureReason, "hugo_staff_contact_ambiguous");
});

Deno.test("GHL receipt adapter requires provider acceptance and message id without sending a client job id", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: any }> = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body || "{}")),
    });
    return Promise.resolve(
      new Response(
        JSON.stringify({ success: true, messageId: "ghl-provider-id" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  }) as typeof fetch;
  try {
    const result = await _sendSmsViaGhlWithReceiptForTest(
      "+61000000001",
      "Mocked Hugo message",
      "+61000000000",
    );
    assertEquals(result, {
      accepted: true,
      messageId: "ghl-provider-id",
      failureReason: null,
    });
    assertEquals(calls.length, 1);
    assertStringIncludes(calls[0].url, "action=send_sms");
    // Every text through this adapter goes to our own people: marked staff by default.
    assertEquals(calls[0].body, {
      phone: "+61000000001",
      message: "Mocked Hugo message",
      fromNumber: "+61000000000",
      recipientRole: "staff",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("GHL receipt adapter treats HTTP-200 provider rejection as failure", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(
        JSON.stringify({ success: false, error: "dedup blocked" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    )) as typeof fetch;
  try {
    const result = await _sendSmsViaGhlWithReceiptForTest(
      "+61000000001",
      "Mocked Hugo message",
      "+61000000000",
    );
    assertEquals(result.accepted, false);
    assertEquals(result.messageId, null);
    assertEquals(result.failureReason, "ghl_rejected:dedup blocked");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── The repair recipient: a named user, never a role and never a code phone ──

function repairConfigClient(input: {
  settings?: any;
  users?: any[];
  settingsError?: any;
  usersError?: any;
}) {
  const reads: Array<{ table: string; select: string; ids?: unknown[] }> = [];
  return {
    reads,
    client: {
      from(table: string) {
        if (table === "makesafe_notify_settings") {
          const read = { table, select: "" };
          reads.push(read);
          const query: any = {
            select(columns: string) {
              read.select = columns;
              return query;
            },
            eq() {
              return query;
            },
            maybeSingle: () =>
              Promise.resolve({
                data: input.settingsError ? null : input.settings ?? null,
                error: input.settingsError || null,
              }),
          };
          return query;
        }
        if (table === "users") {
          const read: { table: string; select: string; ids?: unknown[] } = {
            table,
            select: "",
          };
          reads.push(read);
          const query: any = {
            select(columns: string) {
              read.select = columns;
              return query;
            },
            in(column: string, ids: unknown[]) {
              assertEquals(column, "id");
              read.ids = ids;
              return Promise.resolve({
                data: input.usersError
                  ? null
                  : (input.users || []).filter((user) => ids.includes(user.id)),
                error: input.usersError || null,
              });
            },
          };
          return query;
        }
        throw new Error(`unexpected table ${table}`);
      },
    },
  };
}

const REPAIR_USER_ID = "55555555-5555-5555-5555-555555555555";
const STAFF = [
  {
    id: REPAIR_USER_ID,
    name: "Repair recipient",
    phone: " +61000000005 ",
    role: "ops_manager",
    managed_verticals: [],
  },
  {
    id: "77777777-7777-7777-7777-777777777777",
    name: "Another ops manager",
    phone: "+61000000007",
    role: "ops_manager",
    managed_verticals: ["makesafe"],
  },
  {
    id: "88888888-8888-8888-8888-888888888888",
    name: "Make-safe manager",
    phone: "+61000000001",
    role: "crew",
    managed_verticals: ["makesafe"],
  },
];

Deno.test("the repair recipient is the one user the setting names, with the phone read from that user's row", async () => {
  const db = repairConfigClient({
    settings: {
      notify_enabled: true,
      from_number: "+61000000000",
      repair_new_job_user_ids: [REPAIR_USER_ID],
    },
    users: STAFF,
  });
  const result = await _loadRepairNotificationConfigForTest(db.client);

  assertEquals(result, {
    enabled: true,
    fromNumber: "+61000000000",
    recipient: {
      userId: REPAIR_USER_ID,
      name: "Repair recipient",
      phone: "+61000000005",
    },
    failureReason: null,
  });
  // Named by id only: no role or vertical lookup, and the make-safe phone list
  // is never selected.
  assertEquals(db.reads, [
    {
      table: "makesafe_notify_settings",
      select: "notify_enabled, from_number, repair_new_job_user_ids",
    },
    { table: "users", select: "id, name, phone", ids: [REPAIR_USER_ID] },
  ]);
});

Deno.test("an empty repair recipient list names nobody: no role fallback and no make-safe fallback", async () => {
  for (const list of [[], null, undefined, ["", "  "]]) {
    const db = repairConfigClient({
      settings: {
        notify_enabled: true,
        from_number: "+61000000000",
        repair_new_job_user_ids: list,
        arrival_general_phones: ["+61000000001"],
      },
      users: STAFF,
    });
    const result = await _loadRepairNotificationConfigForTest(db.client);
    assertEquals(result.recipient, null);
    assertEquals(result.failureReason, "repair_recipient_not_configured");
    assertEquals(db.reads.map((read) => read.table), [
      "makesafe_notify_settings",
    ]);
  }
});

Deno.test("a repair recipient list that cannot name exactly one reachable user fails closed with its reason", async () => {
  const cases: Array<[unknown[], any[], string]> = [
    [
      [REPAIR_USER_ID, "77777777-7777-7777-7777-777777777777"],
      STAFF,
      "repair_recipient_config_ambiguous",
    ],
    [
      ["99999999-9999-9999-9999-999999999999"],
      STAFF,
      "repair_recipient_user_missing",
    ],
    [
      [REPAIR_USER_ID],
      [{ ...STAFF[0], phone: null }],
      "repair_recipient_phone_missing",
    ],
    [
      [REPAIR_USER_ID],
      [{ ...STAFF[0], phone: "   " }],
      "repair_recipient_phone_missing",
    ],
  ];
  for (const [list, users, reason] of cases) {
    const result = await _loadRepairNotificationConfigForTest(
      repairConfigClient({
        settings: {
          notify_enabled: true,
          from_number: "+61000000000",
          repair_new_job_user_ids: list,
        },
        users,
      }).client,
    );
    assertEquals(result.recipient, null, reason);
    assertEquals(result.failureReason, reason);
  }
  // The same user named twice is one user.
  const twice = await _loadRepairNotificationConfigForTest(
    repairConfigClient({
      settings: {
        notify_enabled: true,
        from_number: "+61000000000",
        repair_new_job_user_ids: [REPAIR_USER_ID, REPAIR_USER_ID],
      },
      users: STAFF,
    }).client,
  );
  assertEquals(twice.recipient?.userId, REPAIR_USER_ID);
});

Deno.test("an unreadable repair recipient setting or staff row throws, so the notifier records a read failure", async () => {
  await assertRejects(
    () =>
      _loadRepairNotificationConfigForTest(
        repairConfigClient({
          settingsError: {
            code: "42703",
            message: "column repair_new_job_user_ids does not exist",
          },
        }).client,
      ),
    Error,
    "Repair notification settings read failed",
  );
  await assertRejects(
    () =>
      _loadRepairNotificationConfigForTest(
        repairConfigClient({
          settings: {
            notify_enabled: true,
            from_number: "+61000000000",
            repair_new_job_user_ids: [REPAIR_USER_ID],
          },
          usersError: { message: "users read failed" },
        }).client,
      ),
    Error,
    "Repair notification staff read failed",
  );
});

Deno.test("the notify kill switch and the sending number are read for the repair text from the same settings row", async () => {
  const result = await _loadRepairNotificationConfigForTest(
    repairConfigClient({
      settings: {
        notify_enabled: false,
        from_number: "  ",
        repair_new_job_user_ids: [REPAIR_USER_ID],
      },
      users: STAFF,
    }).client,
  );
  assertEquals(result.enabled, false);
  assertEquals(result.fromNumber, null);
  assertEquals(result.recipient?.userId, REPAIR_USER_ID);
});
