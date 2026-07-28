// deno-lint-ignore-file no-explicit-any no-import-prefix

import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _loadHugoNotificationConfigForTest,
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
    assertEquals(calls[0].body, {
      phone: "+61000000001",
      message: "Mocked Hugo message",
      fromNumber: "+61000000000",
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
