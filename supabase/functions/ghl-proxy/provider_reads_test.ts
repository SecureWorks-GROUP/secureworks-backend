// Match this Deno repository's existing pinned standard-library test imports.
// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  assertGhlProviderReadCaller,
  type GhlProviderReadAction,
  GhlProviderReadError,
  isDedicatedGhlReadServerKey,
  readGhlProvider,
} from "./provider_reads.ts";

const locationId = "loc_secureworks";
const contactId = "contact_a";
const conversationId = "conversation_a";
const contact = { id: contactId, locationId, email: "payer@example.test" };
const conversation = { id: conversationId, locationId, contactId };
const msg = (id = "message_a", other: Record<string, unknown> = {}) => ({
  id,
  locationId,
  contactId,
  conversationId,
  body: "Original terms and reply",
  direction: "inbound",
  dateAdded: "2026-09-09T00:00:00Z",
  messageType: "SMS",
  status: "delivered",
  attachments: ["https://example.test/evidence.pdf"],
  ...other,
});
type Reply = {
  path: string;
  body: unknown;
  status?: number;
  headers?: Record<string, string>;
};
function fixture(replies: Reply[]) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fetchFn = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const reply = replies[calls.length];
    calls.push({ url, init: init || {} });
    assert(reply, `Unexpected provider request ${url}`);
    assertEquals(url.origin, "https://services.leadconnectorhq.com");
    assertEquals(url.pathname, reply.path);
    assertEquals(init?.method, "GET");
    assertEquals(init?.body, undefined);
    assertEquals(init?.redirect, "error");
    assertEquals(
      new Headers(init?.headers).get("authorization"),
      "Bearer fixture-only",
    );
    return Promise.resolve(
      new Response(JSON.stringify(reply.body), {
        status: reply.status || 200,
        headers: reply.headers,
      }),
    );
  }) as typeof fetch;
  return {
    calls,
    run: (action: GhlProviderReadAction, args: Record<string, string> = {}) =>
      readGhlProvider(action, new URLSearchParams(args), {
        locationId,
        token: "fixture-only",
        fetchFn,
        now: () => new Date("2026-09-09T01:00:00Z"),
      }),
    done: () => assertEquals(calls.length, replies.length),
  };
}
const contactReply = () => ({
  path: `/contacts/${contactId}`,
  body: { contact },
});
const conversationReply = () => ({
  path: `/conversations/${conversationId}`,
  body: conversation,
});

Deno.test("full provider reads require an inside pass or same-org owner/admin and GET", () => {
  const base = {
    method: "GET",
    mode: "service_role",
    configuredOrgId: "org_a",
    testMode: false,
  };
  assertGhlProviderReadCaller(base);
  assertGhlProviderReadCaller({
    ...base,
    mode: "user_jwt",
    role: "owner",
    orgId: "org_a",
  });
  for (
    const input of [
      { ...base, mode: "shared_key" },
      { ...base, method: "POST" },
      { ...base, testMode: true },
      { ...base, mode: "user_jwt", role: "trade", orgId: "org_a" },
      { ...base, mode: "user_jwt", role: "admin", orgId: "another_org" },
    ]
  ) {
    assertThrows(
      () => assertGhlProviderReadCaller(input),
      GhlProviderReadError,
    );
  }
});

Deno.test("dedicated agent pass is distinct and only admits the additive read actions", () => {
  const args = {
    action: "list_ghl_contacts",
    xApiKey: "inside",
    agentServerKey: "inside",
    sharedKey: "public",
    routineKey: "routine",
    serviceKey: "service",
  };
  assert(isDedicatedGhlReadServerKey(args));
  assert(
    isDedicatedGhlReadServerKey({
      ...args,
      xApiKey: undefined,
      bearerToken: "inside",
    }),
  );
  for (
    const other of [
      { action: "send_sms" },
      { action: "get_profile" },
      { xApiKey: "public" },
      { sharedKey: "inside" },
      { routineKey: "inside" },
      { serviceKey: "inside" },
      { agentServerKey: "" },
    ]
  ) assertEquals(isDedicatedGhlReadServerKey({ ...args, ...other }), false);
});

Deno.test("location read preserves provider payload and source timestamp", async () => {
  const payload = {
    location: {
      id: locationId,
      name: "SecureWorks",
      timezone: "Australia/Perth",
    },
  };
  const f = fixture([{ path: `/locations/${locationId}`, body: payload }]);
  const result = await f.run("read_ghl_location");
  assertEquals(result.data, payload);
  assertEquals(result.retrieved_at, "2026-09-09T01:00:00.000Z");
  assertEquals(result.pagination, null);
  f.done();
});

Deno.test("contacts return all provider fields and repeatable cursor without cache", async () => {
  const payload = {
    contacts: [contact],
    meta: { nextPage: 2, startAfter: 1780000000000, startAfterId: contactId },
    extra: "preserved",
  };
  const f = fixture([{ path: "/contacts/", body: payload }]);
  const result = await f.run("list_ghl_contacts", {
    limit: "1",
    query: "payer",
    start_after: "1770000000000",
    start_after_id: "previous",
  });
  assertEquals(result.data, payload);
  assertEquals(result.pagination?.has_more, true);
  assertEquals(result.pagination?.next_cursor, {
    start_after: "1780000000000",
    start_after_id: contactId,
  });
  assertEquals(f.calls[0].url.searchParams.get("startAfterId"), "previous");
  assertEquals(f.calls[0].url.searchParams.get("locationId"), locationId);
  assertEquals(
    new Headers(f.calls[0].init.headers).get("Version"),
    "2023-02-21",
  );
  f.done();
});

Deno.test("full contacts page with no cursor never claims completeness", async () => {
  const f = fixture([{
    path: "/contacts/",
    body: { contacts: [contact], count: 1000 },
  }]);
  const result = await f.run("list_ghl_contacts", { limit: "1" });
  assertEquals(result.pagination?.has_more, null);
  assertEquals(result.pagination?.complete, false);
  assertEquals(
    result.pagination?.warning,
    "provider_did_not_supply_a_usable_next_cursor",
  );
});

Deno.test("arbitrary Roof Repair pipeline is verified by provider membership", async () => {
  const pipelineId = "repair-pipeline";
  const opportunity = {
    id: "opp_a",
    locationId,
    pipelineId,
    contact: { id: contactId },
    pipelineStageId: "stage_actual",
    monetaryValue: 123,
  };
  const f = fixture([
    {
      path: "/opportunities/pipelines",
      body: { pipelines: [{ id: pipelineId, name: "Roof Repair" }] },
    },
    contactReply(),
    {
      path: "/opportunities/search",
      body: { opportunities: [opportunity], meta: { nextPage: 2 } },
    },
  ]);
  const result = await f.run("list_ghl_opportunities", {
    pipeline_id: pipelineId,
    contact_id: contactId,
    limit: "1",
  });
  assertEquals(result.data.opportunities, [opportunity]);
  assertEquals(result.pagination?.next_cursor, { page: 2 });
  assertEquals(f.calls[2].url.searchParams.get("pipelineId"), pipelineId);
  assertEquals(f.calls[2].url.searchParams.get("locationId"), locationId);
  assertEquals(f.calls[2].url.searchParams.get("contactId"), contactId);
  for (const removed of ["pipeline_id", "location_id", "contact_id"]) {
    assertEquals(f.calls[2].url.searchParams.has(removed), false);
  }
  assertEquals(new Headers(f.calls[2].init.headers).get("Version"), "v3");
  assertEquals(new Headers(f.calls[0].init.headers).get("Version"), "v3");
  assertEquals(f.calls[2].url.searchParams.get("status"), "all");
  f.done();
});

Deno.test("pipeline outside configured location never reaches opportunity search", async () => {
  const f = fixture([{
    path: "/opportunities/pipelines",
    body: { pipelines: [{ id: "other" }] },
  }]);
  await assertRejects(
    () => f.run("list_ghl_opportunities", { pipeline_id: "foreign" }),
    GhlProviderReadError,
    "Pipeline is not",
  );
  f.done();
});

Deno.test("opportunity pages can advance using the documented page parameter", async () => {
  const f = fixture([{
    path: "/opportunities/search",
    body: { opportunities: [{ id: "opp_a", locationId }], meta: {} },
  }]);
  const result = await f.run("list_ghl_opportunities", {
    page: "7",
    limit: "1",
  });
  assertEquals(result.pagination?.next_cursor, { page: 8 });
  assertEquals(result.pagination?.complete, false);
});

Deno.test("conversation list returns every matching row and exposes date cursor", async () => {
  const conversations = [{ ...conversation, lastMessageDate: 1780000000000 }, {
    ...conversation,
    id: "conversation_b",
    lastMessageDate: 1770000000000,
  }];
  const f = fixture([contactReply(), {
    path: "/conversations/search",
    body: { conversations, total: 3 },
  }]);
  const result = await f.run("list_ghl_conversations", {
    contact_id: contactId,
    limit: "2",
  });
  assertEquals(result.data.conversations, conversations);
  assertEquals(result.pagination?.next_cursor, {
    start_after_date: "1770000000000",
  });
  assertEquals(result.pagination?.complete, false);
  f.done();
});

Deno.test("messages page includes all channels, inbound/outbound bodies and attachments", async () => {
  const payload = {
    messages: {
      messages: [
        msg(),
        msg("message_b", { messageType: "FACEBOOK", direction: "outbound" }),
      ],
      nextPage: true,
      lastMessageId: "message_b",
    },
  };
  const f = fixture([contactReply(), conversationReply(), {
    path: `/conversations/${conversationId}/messages`,
    body: payload,
  }]);
  const result = await f.run("list_ghl_messages", {
    contact_id: contactId,
    conversation_id: conversationId,
  });
  assertEquals(result.data, payload);
  assertEquals(result.pagination?.next_cursor, {
    last_message_id: "message_b",
  });
  assertEquals(result.pagination?.has_more, true);
  assertEquals(f.calls[2].url.searchParams.has("type"), false);
  f.done();
});

Deno.test("second message page checks cursor relationship then proves exhaustion", async () => {
  const f = fixture([contactReply(), conversationReply(), {
    path: "/conversations/messages/message_b",
    body: msg("message_b"),
  }, {
    path: `/conversations/${conversationId}/messages`,
    body: {
      messages: {
        messages: [msg("older")],
        nextPage: false,
        lastMessageId: "older",
      },
    },
  }]);
  const result = await f.run("list_ghl_messages", {
    contact_id: contactId,
    conversation_id: conversationId,
    last_message_id: "message_b",
  });
  assertEquals(result.pagination?.complete, true);
  assertEquals(result.pagination?.next_cursor, null);
  assertEquals(f.calls[3].url.searchParams.get("lastMessageId"), "message_b");
  f.done();
});

Deno.test("another contact's conversation is refused before message content fetch", async () => {
  const f = fixture([contactReply(), {
    path: `/conversations/${conversationId}`,
    body: { ...conversation, contactId: "another" },
  }]);
  await assertRejects(
    () =>
      f.run("list_ghl_messages", {
        contact_id: contactId,
        conversation_id: conversationId,
      }),
    GhlProviderReadError,
    "requested contact",
  );
  f.done();
});

Deno.test("cross-location and ignored contact filters fail closed", async () => {
  const f = fixture([{
    path: "/contacts/",
    body: { contacts: [{ ...contact, locationId: "foreign" }] },
  }]);
  await assertRejects(
    () => f.run("list_ghl_contacts"),
    GhlProviderReadError,
    "configured location",
  );
  const g = fixture([contactReply(), {
    path: "/opportunities/search",
    body: { opportunities: [{ locationId, contactId: "another" }] },
  }]);
  await assertRejects(
    () => g.run("list_ghl_opportunities", { contact_id: contactId }),
    GhlProviderReadError,
    "requested contact",
  );
});

Deno.test("message detail verifies contact and conversation; call media remains uninspected", async () => {
  const f = fixture([contactReply(), {
    path: "/conversations/messages/message_a",
    body: msg("message_a", { messageType: "CALL", attachments: [] }),
  }, conversationReply()]);
  const result = await f.run("get_ghl_message", {
    message_id: "message_a",
    contact_id: contactId,
  });
  assertEquals(
    result.data,
    msg("message_a", { messageType: "CALL", attachments: [] }),
  );
  assertEquals((result as Record<string, unknown>).media_coverage, {
    recording: "not_returned_in_message",
    transcript: "not_returned_in_message",
    attachments: "provider_metadata_only_content_not_downloaded",
    dedicated_recording_and_transcript_endpoints: "not_requested",
    email_details: "separate_email_details_not_requested",
  });
  f.done();
});

Deno.test("email detail follows only provider references and preserves full envelope", async () => {
  const email = {
    id: "email_a",
    locationId,
    contactId,
    conversationId,
    from: "finance@example.test",
    to: ["payer@example.test"],
    cc: ["admin@example.test"],
    subject: "Invoice",
    body: "<p>Full content</p>",
    attachments: ["https://example.test/file.pdf"],
  };
  const f = fixture([contactReply(), conversationReply(), {
    path: "/conversations/messages/message_a",
    body: msg("message_a", {
      meta: { email: { email: { messageIds: ["email_a", "email_a"] } } },
    }),
  }, { path: "/conversations/messages/email/email_a", body: email }]);
  const result = await f.run("get_ghl_email", {
    message_id: "message_a",
    contact_id: contactId,
    conversation_id: conversationId,
  });
  assertEquals(result.data.emails, [email]);
  assertEquals(
    (result as Record<string, unknown>).email_details_complete,
    true,
  );
  f.done();
});

Deno.test("missing email references are explicit unavailable, never guessed IDs", async () => {
  const f = fixture([contactReply(), conversationReply(), {
    path: "/conversations/messages/message_a",
    body: msg(),
  }]);
  await assertRejects(
    () =>
      f.run("get_ghl_email", {
        message_id: "message_a",
        contact_id: contactId,
        conversation_id: conversationId,
      }),
    GhlProviderReadError,
    "no provider email IDs",
  );
  f.done();
});

Deno.test("unsafe inputs and unscoped message IDs fail before provider reads", async () => {
  for (
    const [action, args] of [
      ["read_ghl_location", { location_id: "foreign" }],
      ["list_ghl_contacts", { limit: "1000" }],
      ["list_ghl_contacts", { start_after: "123" }],
      ["list_ghl_messages", {
        contact_id: "../foreign",
        conversation_id: conversationId,
      }],
      ["get_ghl_message", { message_id: "message_a" }],
      ["get_ghl_email", { message_id: "message_a", contact_id: contactId }],
    ] as [GhlProviderReadAction, Record<string, string>][]
  ) {
    const f = fixture([]);
    await assertRejects(() => f.run(action, args), GhlProviderReadError);
    f.done();
  }
});

Deno.test("provider 429 and malformed responses never look like empty successful history", async () => {
  const f = fixture([{
    path: `/locations/${locationId}`,
    body: { token: "never echo provider body" },
    status: 429,
    headers: { "retry-after": "30" },
  }]);
  const error = await assertRejects(
    () => f.run("read_ghl_location"),
    GhlProviderReadError,
  );
  assertEquals(error.status, 429);
  assertEquals(error.providerStatus, 429);
  assertEquals(error.retryAfter, "30");
  assertEquals(error.message.includes("never echo"), false);
  const g = fixture([{
    path: "/contacts/",
    body: { message: "Not the expected shape" },
  }]);
  await assertRejects(
    () => g.run("list_ghl_contacts"),
    GhlProviderReadError,
    "omitted",
  );
});
