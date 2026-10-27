// deno-lint-ignore-file no-explicit-any no-import-prefix
// The opt-in send that keeps the sent message's ids (capture_thread_ids:true),
// used by Dispatch supplier order emails. Every Graph call is a fake: nothing
// here reaches Microsoft.
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  GraphProviderError,
  resetGraphTokenCache,
  sendCapturingThreadIds,
} from "./index.ts";

type Call = { method: string; url: string; body?: string };

function withFakeGraph(
  answer: (call: Call) => Response | null,
): { calls: Call[]; restore: () => void } {
  Deno.env.set("MICROSOFT_TENANT_ID", "tenant-capture-fixture");
  Deno.env.set("MICROSOFT_CLIENT_ID", "client-capture-fixture");
  Deno.env.set("MICROSOFT_CLIENT_SECRET", "secret-capture-fixture");
  resetGraphTokenCache();
  const calls: Call[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch =
    (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const call = {
        method: init?.method || "GET",
        url,
        body: typeof init?.body === "string" ? init.body : undefined,
      };
      if (url.includes("/oauth2/v2.0/token")) {
        return Response.json({ access_token: "capture-token", expires_in: 3600 });
      }
      calls.push(call);
      return answer(call) ??
        new Response("unexpected provider call", { status: 500 });
    }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
      resetGraphTokenCache();
    },
  };
}

const MAILBOX = "admin@secureworkswa.com.au";
const MESSAGE = {
  subject: "Material Order Ref SWF-261600",
  body: { contentType: "HTML", content: "<p>Hi Team</p>" },
  toRecipients: [{ emailAddress: { address: "tradewa@example.com" } }],
};
const PHOTO = {
  "@odata.type": "#microsoft.graph.fileAttachment",
  name: "list.jpg",
  contentType: "image/jpeg",
  contentBytes: "AAAA",
} as any;

function draftCreated(): Response {
  return Response.json({
    id: "graph-msg-1",
    internetMessageId: "<abc@example.outlook.com>",
    conversationId: "conv-1",
  }, { status: 201 });
}

Deno.test("capture send makes a draft, adds files one by one, sends it and returns the ids", async () => {
  const fake = withFakeGraph((call) => {
    if (call.method === "POST" && call.url.endsWith("/messages")) {
      return draftCreated();
    }
    if (call.url.endsWith("/attachments")) {
      return Response.json({ id: "att" }, { status: 201 });
    }
    if (call.url.endsWith("/send")) return new Response(null, { status: 202 });
    return null;
  });
  try {
    const ids = await sendCapturingThreadIds(MAILBOX, MESSAGE, [PHOTO, PHOTO]);
    assertEquals(ids, {
      graph_message_id: "graph-msg-1",
      internet_message_id: "<abc@example.outlook.com>",
      conversation_id: "conv-1",
    });
    assertEquals(fake.calls.map((c) => `${c.method} ${c.url.split("/v1.0")[1]}`), [
      "POST /users/admin%40secureworkswa.com.au/messages",
      "POST /users/admin%40secureworkswa.com.au/messages/graph-msg-1/attachments",
      "POST /users/admin%40secureworkswa.com.au/messages/graph-msg-1/attachments",
      "POST /users/admin%40secureworkswa.com.au/messages/graph-msg-1/send",
    ]);
    // The draft itself carries no files (they go one at a time, each under
    // Graph's 3 MB limit) and nothing goes through /sendMail.
    const created = JSON.parse(fake.calls[0].body || "{}");
    assertEquals(created.attachments, undefined);
    assertEquals(created.subject, "Material Order Ref SWF-261600");
    assertEquals(fake.calls.some((c) => c.url.includes("sendMail")), false);
  } finally {
    fake.restore();
  }
});

Deno.test("a failed file add sends nothing, removes the draft and says retry is safe", async () => {
  const fake = withFakeGraph((call) => {
    if (call.method === "POST" && call.url.endsWith("/messages")) {
      return draftCreated();
    }
    if (call.url.endsWith("/attachments")) {
      return new Response("too big", { status: 413 });
    }
    if (call.method === "DELETE") return new Response(null, { status: 204 });
    return null;
  });
  try {
    const error = await assertRejects(
      () => sendCapturingThreadIds(MAILBOX, MESSAGE, [PHOTO]),
      GraphProviderError,
    ) as GraphProviderError;
    assertEquals(error.outcomeUnknown, false);
    assertEquals(error.context.sent, false);
    assertEquals(error.context.retry_safe, true);
    assertEquals(error.context.stage, "attachments");
    assert(fake.calls.some((c) => c.method === "DELETE"));
    assertEquals(fake.calls.some((c) => c.url.endsWith("/send")), false);
  } finally {
    fake.restore();
  }
});

Deno.test("a failed draft create sends nothing and says retry is safe", async () => {
  const fake = withFakeGraph((call) => {
    if (call.method === "POST" && call.url.endsWith("/messages")) {
      return new Response("mailbox busy", { status: 503 });
    }
    return null;
  });
  try {
    const error = await assertRejects(
      () => sendCapturingThreadIds(MAILBOX, MESSAGE, []),
      GraphProviderError,
    ) as GraphProviderError;
    assertEquals(error.outcomeUnknown, false);
    assertEquals(error.context.sent, false);
    assertEquals(error.context.stage, "draft");
    assertEquals(fake.calls.some((c) => c.url.endsWith("/send")), false);
  } finally {
    fake.restore();
  }
});

Deno.test("a send with no clear answer is outcome unknown and still carries the ids", async () => {
  const fake = withFakeGraph((call) => {
    if (call.method === "POST" && call.url.endsWith("/messages")) {
      return draftCreated();
    }
    if (call.url.endsWith("/send")) {
      return new Response("gateway timeout", { status: 504 });
    }
    return null;
  });
  try {
    const error = await assertRejects(
      () => sendCapturingThreadIds(MAILBOX, MESSAGE, []),
      GraphProviderError,
    ) as GraphProviderError;
    assertEquals(error.outcomeUnknown, true);
    assertEquals(error.context.stage, "send");
    assertEquals(error.context.sent, null);
    assertEquals(error.context.internet_message_id, "<abc@example.outlook.com>");
    assertEquals(error.context.conversation_id, "conv-1");
  } finally {
    fake.restore();
  }
});

Deno.test("a send Graph refuses outright is not sent and carries the ids", async () => {
  const fake = withFakeGraph((call) => {
    if (call.method === "POST" && call.url.endsWith("/messages")) {
      return draftCreated();
    }
    if (call.url.endsWith("/send")) {
      return new Response("bad recipient", { status: 400 });
    }
    return null;
  });
  try {
    const error = await assertRejects(
      () => sendCapturingThreadIds(MAILBOX, MESSAGE, []),
      GraphProviderError,
    ) as GraphProviderError;
    assertEquals(error.outcomeUnknown, false);
    assertEquals(error.context.sent, false);
    assertEquals(error.context.graph_message_id, "graph-msg-1");
  } finally {
    fake.restore();
  }
});
