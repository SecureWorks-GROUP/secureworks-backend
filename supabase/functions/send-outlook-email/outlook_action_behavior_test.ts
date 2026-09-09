// deno-lint-ignore-file no-explicit-any no-import-prefix
import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifyOutlookRoute,
  fetchAttachment,
  getSignature,
  getGraphToken,
  GraphProviderError,
  graphRequest,
  handleDraft,
  handleReply,
  OutlookInputError,
  prepareAttachments,
  resetGraphTokenCache,
  splitRecipientInput,
  validateInlineAttachment,
} from "./index.ts";

Deno.test("Outlook route classification rejects group send fallthrough and preserves exact mailbox", () => {
  assertEquals(classifyOutlookRoute({ from: "admin@secureworkswa.com.au" }), {
    kind: "mailbox",
    mailbox: "admin@secureworkswa.com.au",
  });
  assertEquals(
    classifyOutlookRoute({
      action: "forward",
      group: "ses@secureworkswa.com.au",
    }),
    {
      kind: "group",
      group: "ses@secureworkswa.com.au",
      reason: "forward_group_source",
    },
  );
  assertEquals(
    classifyOutlookRoute({ from: "ses@secureworkswa.com.au" }).kind,
    "group",
  );
  assertEquals(
    classifyOutlookRoute({
      from: "ses@secureworkswa.com.au",
      to: "client@example.com",
    }),
    {
      kind: "group",
      group: "ses@secureworkswa.com.au",
      reason: "known_group_sender_requires_group_action",
    },
  );
  assertThrows(
    () => classifyOutlookRoute({ action: "forward", message_id: "source" }),
    OutlookInputError,
  );
  assertThrows(
    () =>
      classifyOutlookRoute({
        action: "forward",
        mailbox: "admin@secureworkswa.com.au",
        from: "admin@secureworkswa.com.au",
      }),
    OutlookInputError,
  );
});

Deno.test("signatures never invent Marnin as the sender", () => {
  assertEquals(
    getSignature("marnin@secureworkswa.com.au").includes("Marnin Stobbe"),
    true,
  );
  assertEquals(getSignature("hugo@secureworkswa.com.au"), "");
  assertEquals(
    getSignature("admin@secureworkswa.com.au").includes("Maverick"),
    true,
  );
});

Deno.test("recipient and inline attachment inputs are strict and never silently dropped", async () => {
  assertEquals(
    splitRecipientInput(
      ["a@example.com", "b@example.com,c@example.com"],
      "to",
      true,
    ),
    [
      "a@example.com",
      "b@example.com",
      "c@example.com",
    ],
  );
  assertThrows(
    () => splitRecipientInput(["not-an-address"], "to", true),
    OutlookInputError,
  );
  assertThrows(
    () =>
      validateInlineAttachment({ name: "bad.bin", contentBytes: "not-base64" }),
    OutlookInputError,
  );
  await assertRejects(
    () => prepareAttachments([{ name: "missing.pdf" }]),
    OutlookInputError,
    "no contentBytes",
  );
});

Deno.test("URL attachment reads enforce approved hosts, redirect bounds, and decoded byte caps", async () => {
  const calls: string[] = [];
  const fetchImpl = async (
    input: string | URL | Request,
  ): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/redirect")) {
      return new Response(null, {
        status: 302,
        headers: { location: "https://fixtures.test/file.pdf" },
      });
    }
    return new Response(new Uint8Array([0, 1, 2, 3]), { status: 200 });
  };
  const result = await fetchAttachment(
    "https://fixtures.test/redirect",
    "file.pdf",
    {
      fetchImpl,
      allowedHosts: ["fixtures.test"],
    },
  );
  assertEquals(result.contentBytes, "AAECAw==");
  assertEquals(calls, [
    "https://fixtures.test/redirect",
    "https://fixtures.test/file.pdf",
  ]);
  await assertRejects(
    () =>
      fetchAttachment("https://unapproved.test/file.pdf", "file.pdf", {
        fetchImpl,
      }),
    OutlookInputError,
    "approved HTTPS storage",
  );
  const oversizedFetch = async (): Promise<Response> =>
    new Response(null, {
      status: 200,
      headers: { "content-length": String(8 * 1024 * 1024 + 1) },
    });
  await assertRejects(
    () =>
      fetchAttachment("https://fixtures.test/large.pdf", "large.pdf", {
        fetchImpl: oversizedFetch,
        allowedHosts: ["fixtures.test"],
      }),
    OutlookInputError,
    "exceeds",
  );
  await assertRejects(
    () =>
      fetchAttachment("https://storage.googleapis.com/bucket/file.pdf", "file.pdf", {
        fetchImpl,
      }),
    OutlookInputError,
    "approved HTTPS storage",
  );
  await assertRejects(
    () =>
      fetchAttachment("https://fixtures.test/no-stream.pdf", "file.pdf", {
        fetchImpl: async () => new Response(null, { status: 200 }),
        allowedHosts: ["fixtures.test"],
      }),
    OutlookInputError,
    "bounded body stream",
  );
});

Deno.test("reply attachment limits are checked before createReply", async () => {
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = (async () => {
    providerCalls++;
    return new Response("provider must not be called", { status: 500 });
  }) as typeof fetch;
  try {
    const oversizedBase64 = "A".repeat(4 * 1024 * 1024 + 4);
    await assertRejects(
      () =>
        handleReply({
          action: "reply",
          mailbox: "admin@secureworkswa.com.au",
          message_id: "source-message-large",
          job_id: "job-large",
          htmlBody: "<p>Reviewed reply</p>",
          content_reviewed: true,
          expected_to: ["client@example.com"],
          expected_cc: [],
          attachments: [{ name: "large.bin", contentBytes: oversizedBase64 }],
        }),
      OutlookInputError,
      "exceeds",
    );
    assertEquals(providerCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("Graph refreshes after 401 without replaying a mutation", async () => {
  Deno.env.set("MICROSOFT_TENANT_ID", "tenant-fixture");
  Deno.env.set("MICROSOFT_CLIENT_ID", "client-fixture");
  Deno.env.set("MICROSOFT_CLIENT_SECRET", "secret-fixture");
  resetGraphTokenCache();
  let tokenCalls = 0;
  let graphCalls = 0;
  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    if (url.includes("/oauth2/v2.0/token")) {
      tokenCalls++;
      return Response.json({
        access_token: `opaque-token-${tokenCalls}`,
        expires_in: 3600,
      });
    }
    graphCalls++;
    assertEquals(init?.method, "POST");
    if (graphCalls === 1) return new Response("expired", { status: 401 });
    return new Response(null, { status: 202 });
  };
  const unauthorized = await assertRejects(
    () =>
      graphRequest("/users/admin/sendMail", {
        method: "POST",
        body: "{}",
      }, { fetchImpl, timeoutMs: 1000, mutating: true }),
    GraphProviderError,
  );
  assertEquals(unauthorized.status, 401);
  assertEquals(unauthorized.outcomeUnknown, false);
  assertEquals(unauthorized.context, {
    token_refreshed: true,
    retry_safe: false,
  });
  assertEquals({ tokenCalls, graphCalls }, { tokenCalls: 2, graphCalls: 1 });

  resetGraphTokenCache();
  let readTokenCalls = 0;
  let readGraphCalls = 0;
  const readFetch = async (
    input: string | URL | Request,
  ): Promise<Response> => {
    const url = String(input);
    if (url.includes("/oauth2/v2.0/token")) {
      readTokenCalls++;
      return Response.json({
        access_token: `read-token-${readTokenCalls}`,
        expires_in: 3600,
      });
    }
    readGraphCalls++;
    return readGraphCalls === 1
      ? new Response("expired", { status: 401 })
      : Response.json({ id: "mailbox-1" });
  };
  const readResponse = await graphRequest(
    "/users/admin/mailFolders/inbox",
    {},
    { fetchImpl: readFetch, timeoutMs: 1000, mutating: false },
  );
  assertEquals(readResponse.status, 200);
  assertEquals(
    { readTokenCalls, readGraphCalls },
    { readTokenCalls: 2, readGraphCalls: 2 },
  );

  resetGraphTokenCache();
  let failedGraphCalls = 0;
  const failingFetch = async (
    input: string | URL | Request,
  ): Promise<Response> => {
    if (String(input).includes("/oauth2/v2.0/token")) {
      return Response.json({ access_token: "opaque-token", expires_in: 3600 });
    }
    failedGraphCalls++;
    return new Response("upstream failure", { status: 503 });
  };
  const outcomeUnknown = await assertRejects(
    () =>
      graphRequest("/users/admin/sendMail", { method: "POST", body: "{}" }, {
        fetchImpl: failingFetch,
        mutating: true,
      }),
    GraphProviderError,
  );
  assertEquals(outcomeUnknown.outcomeUnknown, true);
  assertEquals(failedGraphCalls, 1);
});

Deno.test("draft handler creates a draft and never sends it", async () => {
  Deno.env.set("MICROSOFT_TENANT_ID", "tenant-draft-fixture");
  Deno.env.set("MICROSOFT_CLIENT_ID", "client-draft-fixture");
  Deno.env.set("MICROSOFT_CLIENT_SECRET", "secret-draft-fixture");
  resetGraphTokenCache();
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch =
    (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method || "GET"} ${url}`);
      if (url.includes("/oauth2/v2.0/token")) {
        return Response.json({ access_token: "draft-token", expires_in: 3600 });
      }
      if (url.endsWith("/messages")) {
        return Response.json({ id: "draft-1", changeKey: "ck-1" }, {
          status: 201,
        });
      }
      return new Response("unexpected provider call", { status: 500 });
    }) as typeof fetch;
  try {
    const response = await handleDraft({
      action: "draft",
      mailbox: "admin@secureworkswa.com.au",
      from: "admin@secureworkswa.com.au",
      to: ["client@example.com"],
      subject: "Reviewed draft",
      htmlBody: "<p>Hello</p>",
      content_reviewed: true,
    });
    assertEquals(response.status, 202);
    const body = await response.json();
    assertEquals(body.outcome, "draft_created_not_sent");
    assertEquals(body.draft_id, "draft-1");
    assertEquals(body.changeKey, "ck-1");
    assertEquals(calls.filter((call) => call.includes("/messages")).length, 1);
    assertEquals(
      calls.some((call) => call.includes("sendMail") || call.endsWith("/send")),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
    resetGraphTokenCache();
  }
});

Deno.test("reply handler preserves native recipients and sends only after exact check", async () => {
  Deno.env.set("MICROSOFT_TENANT_ID", "tenant-reply-fixture");
  Deno.env.set("MICROSOFT_CLIENT_ID", "client-reply-fixture");
  Deno.env.set("MICROSOFT_CLIENT_SECRET", "secret-reply-fixture");
  resetGraphTokenCache();
  const calls: { url: string; body?: string }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch =
    (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      if (url.includes("/oauth2/v2.0/token")) {
        return Response.json({ access_token: "reply-token", expires_in: 3600 });
      }
      if (url.endsWith("/createReply")) {
        return Response.json({
          id: "reply-draft-1",
          toRecipients: [{ emailAddress: { address: "client@example.com" } }],
          ccRecipients: [],
        }, { status: 201 });
      }
      if (url.endsWith("/reply-draft-1/attachments")) {
        return Response.json({ id: "attachment-1" }, { status: 201 });
      }
      if (url.endsWith("/reply-draft-1/send")) {
        return new Response(null, { status: 202 });
      }
      return new Response("unexpected provider call", { status: 500 });
    }) as typeof fetch;
  try {
    const response = await handleReply({
      action: "reply",
      mailbox: "admin@secureworkswa.com.au",
      message_id: "source-message-1",
      job_id: "job-1",
      htmlBody: "<p>Reviewed reply</p>",
      content_reviewed: true,
      expected_to: ["client@example.com"],
      expected_cc: [],
      attachments: [{
        name: "review.txt",
        contentType: "text/plain",
        contentBytes: "AA==",
      }],
    });
    assertEquals(response.status, 202);
    assertEquals((await response.json()).draft_id, "reply-draft-1");
    assertEquals(
      calls.filter((call) => call.url.endsWith("/createReply")).length,
      1,
    );
    assertEquals(
      calls.filter((call) => call.url.endsWith("/reply-draft-1/send")).length,
      1,
    );
    assertEquals(
      calls.filter((call) => call.url.endsWith("/reply-draft-1/attachments")).length,
      1,
    );
    const createBody = JSON.parse(
      calls.find((call) => call.url.endsWith("/createReply"))!.body!,
    );
    assertEquals(createBody.message.toRecipients, undefined);
    assertEquals(createBody.message.ccRecipients, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    resetGraphTokenCache();
  }
});

Deno.test("reply recipient mismatch leaves the native draft and does not send", async () => {
  Deno.env.set("MICROSOFT_TENANT_ID", "tenant-mismatch-fixture");
  Deno.env.set("MICROSOFT_CLIENT_ID", "client-mismatch-fixture");
  Deno.env.set("MICROSOFT_CLIENT_SECRET", "secret-mismatch-fixture");
  resetGraphTokenCache();
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch =
    (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method || "GET"} ${url}`);
      if (url.includes("/oauth2/v2.0/token")) {
        return Response.json({
          access_token: "mismatch-token",
          expires_in: 3600,
        });
      }
      return Response.json({
        id: "reply-draft-mismatch",
        toRecipients: [{ emailAddress: { address: "other@example.com" } }],
        ccRecipients: [],
      }, { status: 201 });
    }) as typeof fetch;
  try {
    const error = await assertRejects(
      () =>
        handleReply({
          action: "reply",
          mailbox: "admin@secureworkswa.com.au",
          message_id: "source-message-2",
          job_id: "job-2",
          htmlBody: "<p>Reviewed reply</p>",
          content_reviewed: true,
          expected_to: ["client@example.com"],
          expected_cc: [],
        }),
      GraphProviderError,
    );
    assertEquals(error.outcomeUnknown, true);
    assertEquals(error.context.draft_id, "reply-draft-mismatch");
    assertEquals(calls.some((call) => call.endsWith("/send")), false);
  } finally {
    globalThis.fetch = originalFetch;
    resetGraphTokenCache();
  }
});
