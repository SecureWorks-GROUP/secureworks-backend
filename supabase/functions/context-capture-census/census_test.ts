// Finish line row C7: the capture census counts what the sources hold, by the
// reader's own keys, and never writes, sends or returns mail words.
// deno-lint-ignore-file no-import-prefix require-await
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type CensusReads,
  CensusRefusal,
  folderOf,
  ghlKind,
  readerKey,
  runCensus,
} from "./census.ts";
import {
  COMPANY_ORG_ID,
  handleCensus,
  serverCredentialCheck,
} from "./handler.ts";
import { liveCensusReads } from "./reads.ts";

const NOW = Date.parse("2026-11-03T12:00:00Z");
const FROM = "2026-10-26T16:00:00.000Z"; // 27 Oct 00:00 Perth
const TO = "2026-11-03T12:00:00.000Z";
const FOLDERS = {
  inbox: "F-IN",
  sent: "F-SENT",
  deleted: "F-DEL",
  archive: "F-ARCH",
  junk: "F-JUNK",
  drafts: "F-DRAFT",
  outbox: "F-OUT",
};
const SOURCES = [
  {
    email: "admin@secureworkswa.com.au",
    source_key: "admin",
    kind: "user",
    scope_label: "admin",
    owner_privacy: false,
  },
  {
    email: "fencing@secureworkswa.com.au",
    source_key: "fencing",
    kind: "group",
    scope_label: "fencing",
    owner_privacy: false,
  },
];

function fakeReads(over: Partial<CensusReads> = {}): CensusReads {
  const none = async () => {
    throw new Error("not in this test");
  };
  return {
    now: () => NOW,
    sources: async () => SOURCES,
    folderIds: async () => FOLDERS,
    listMail: none,
    resolveGroupId: async () => "G1",
    listGroupConversations: none,
    listGroupThreads: none,
    listGroupPosts: none,
    mailItem: none,
    postItem: none,
    explainContext: async () => ({
      supplierDomains: new Set<string>(),
      jobClientEmails: new Set<string>(),
      prefixes: [],
    }),
    ghlConversations: none,
    ghlMessages: none,
    ...over,
  };
}

Deno.test("the reader's key: internet id lower case without brackets, else the mailbox and graph id", () => {
  assertEquals(
    readerKey("Admin@X.au", "AAMk1", "<ABC@mail.example>"),
    "email:abc@mail.example",
  );
  assertEquals(
    readerKey("Admin@X.au", "AAMk1", null),
    "graph:admin@x.au:AAMk1",
  );
});

Deno.test("folders: the reader's skipped folders and drafts are named, the rest are read", () => {
  const m = (parentFolderId: string | null, isDraft = false) => ({
    id: "x",
    internetMessageId: null,
    parentFolderId,
    receivedDateTime: FROM,
    isDraft,
  });
  assertEquals(folderOf(m("F-JUNK"), FOLDERS), "junk");
  assertEquals(folderOf(m("F-IN", true), FOLDERS), "drafts");
  assertEquals(folderOf(m("F-SENT"), FOLDERS), "sent");
  assertEquals(folderOf(m("F-CUSTOM"), FOLDERS), "other");
  assertEquals(ghlKind("TYPE_CUSTOM_SMS"), "CUSTOMSMS");
  assertEquals(ghlKind("TYPE_CALL"), "CALL");
});

Deno.test("email_messages: every page in the window, ids and folders only, cut answers carry next", async () => {
  const pages: Record<string, { items: unknown[]; next: string | null }> = {
    first: {
      items: [
        {
          id: "m1",
          internetMessageId: "<A@x>",
          parentFolderId: "F-IN",
          receivedDateTime: "2026-10-27T01:00:00Z",
          isDraft: false,
        },
        {
          id: "m2",
          internetMessageId: null,
          parentFolderId: "F-JUNK",
          receivedDateTime: "2026-10-27T02:00:00Z",
          isDraft: false,
        },
      ],
      next: "https://graph.microsoft.com/v1.0/next1",
    },
    "https://graph.microsoft.com/v1.0/next1": {
      items: [
        {
          id: "m3",
          internetMessageId: "<b@x>",
          parentFolderId: "F-SENT",
          receivedDateTime: "2026-11-02T01:00:00Z",
          isDraft: false,
        },
        // Outside the window (Graph would not send it; dropped anyway).
        {
          id: "m4",
          internetMessageId: "<c@x>",
          parentFolderId: "F-IN",
          receivedDateTime: "2026-10-20T01:00:00Z",
          isDraft: false,
        },
      ],
      next: null,
    },
  };
  const asked: Array<string | null> = [];
  const reads = fakeReads({
    listMail: async (_m, a) => {
      asked.push(a.next);
      return pages[a.next ?? "first"] as never;
    },
  });
  const r = await runCensus(reads, {
    lane: "email_messages",
    mailbox: "ADMIN@secureworkswa.com.au",
    from: FROM,
    to: TO,
  });
  assertEquals(r.complete, true);
  assertEquals(r.next, null);
  assertEquals(asked, [null, "https://graph.microsoft.com/v1.0/next1"]);
  assertEquals(r.items, [
    {
      id: "m1",
      key: "email:a@x",
      at: "2026-10-27T01:00:00Z",
      folder: "inbox",
      read_by_capture: true,
    },
    {
      id: "m2",
      key: "graph:admin@secureworkswa.com.au:m2",
      at: "2026-10-27T02:00:00Z",
      folder: "junk",
      read_by_capture: false,
    },
    {
      id: "m3",
      key: "email:b@x",
      at: "2026-11-02T01:00:00Z",
      folder: "sent",
      read_by_capture: true,
    },
  ]);

  // Past the time budget after the first page: the answer is cut and says where to go on.
  let t = NOW;
  const slow = fakeReads({
    now: () => (t += 60_000),
    listMail: async (_m, a) => pages[a.next ?? "first"] as never,
  });
  const cut = await runCensus(slow, {
    lane: "email_messages",
    mailbox: "admin@secureworkswa.com.au",
    from: FROM,
    to: "2026-11-03T11:00:00Z",
  });
  assertEquals(cut.complete, false);
  assertEquals(cut.next, "https://graph.microsoft.com/v1.0/next1");
});

Deno.test("refusals: unmonitored mailbox, wrong kind, bad window, unknown lane, oversized batch", async () => {
  const reads = fakeReads();
  const refused = async (
    req: Parameters<typeof runCensus>[1],
    code: string,
  ) => {
    const e = await assertRejects(() => runCensus(reads, req), CensusRefusal);
    assertEquals(e.code, code);
  };
  await refused({
    lane: "email_messages",
    mailbox: "someone@else.com",
    from: FROM,
    to: TO,
  }, "mailbox_not_monitored");
  await refused({
    lane: "email_messages",
    mailbox: "fencing@secureworkswa.com.au",
    from: FROM,
    to: TO,
  }, "mailbox_not_user");
  await refused({
    lane: "email_messages",
    mailbox: "admin@secureworkswa.com.au",
    from: TO,
    to: FROM,
  }, "window_invalid");
  await refused({
    lane: "email_messages",
    mailbox: "admin@secureworkswa.com.au",
    from: "2026-09-01T00:00:00Z",
    to: "2026-09-02T00:00:00Z",
  }, "window_too_old");
  await refused({ lane: "nope" as never, from: FROM, to: TO }, "lane_invalid");
  await refused({
    lane: "ghl_messages",
    from: FROM,
    to: TO,
    conversations: Array.from({ length: 26 }, (_, i) => `c${i}`),
  }, "batch_too_large");
});

Deno.test("group lanes: conversations stop at the window floor; posts keep their window and the reader's key", async () => {
  const reads = fakeReads({
    listGroupConversations: async (_g, next) =>
      next === null
        ? {
          items: [
            { id: "c1", lastDeliveredDateTime: "2026-11-03T01:00:00Z" },
            { id: "c2", lastDeliveredDateTime: null },
          ],
          next: "https://graph.microsoft.com/v1.0/conv2",
        }
        : {
          items: [
            { id: "c3", lastDeliveredDateTime: "2026-10-30T01:00:00Z" },
            { id: "c4", lastDeliveredDateTime: "2026-10-01T01:00:00Z" },
            { id: "c5", lastDeliveredDateTime: "2026-09-01T01:00:00Z" },
          ],
          next: "https://graph.microsoft.com/v1.0/conv3",
        },
    listGroupThreads: async (_g, c) => ({
      items: [{ id: `${c}-t1` }],
      next: null,
    }),
    listGroupPosts: async (_g, t) => ({
      items: [
        {
          id: `${t}-p1`,
          internetMessageId: "<P1@X>",
          receivedDateTime: "2026-10-31T01:00:00Z",
        },
        {
          id: `${t}-p0`,
          internetMessageId: null,
          receivedDateTime: "2026-10-01T01:00:00Z",
        },
        {
          id: `${t}-p2`,
          internetMessageId: null,
          receivedDateTime: "2026-11-01T01:00:00Z",
        },
      ],
      next: null,
    }),
  });
  const convs = await runCensus(reads, {
    lane: "email_group_conversations",
    mailbox: "fencing@secureworkswa.com.au",
    from: FROM,
    to: TO,
  });
  assertEquals(convs.complete, true);
  assertEquals((convs.items as Array<{ id: string }>).map((c) => c.id), [
    "c1",
    "c2",
    "c3",
  ]);
  assertEquals(convs.undated, 1);
  const posts = await runCensus(reads, {
    lane: "email_group_posts",
    mailbox: "fencing@secureworkswa.com.au",
    from: FROM,
    to: TO,
    conversations: ["c1"],
  });
  assertEquals(posts.complete, true);
  assertEquals(posts.done, ["c1"]);
  assertEquals((posts.items as Array<{ key: string }>).map((p) => p.key), [
    "email:p1@x",
    "graph:fencing@secureworkswa.com.au:c1-t1-p2",
  ]);
});

Deno.test("ghl lanes: conversations newest first to the floor with tie-safe cursor; messages by window, all types named", async () => {
  const startAfter: Array<number | null> = [];
  const day = (d: string) => Date.parse(d);
  const reads = fakeReads({
    ghlConversations: async ({ limit, startAfterMs }) => {
      startAfter.push(startAfterMs);
      if (startAfterMs === null) {
        return Array.from({ length: limit }, (_, i) => ({
          id: `k${i}`,
          contactId: "ct",
          lastMessageMs: day("2026-11-03T00:00:00Z") - i * 60_000,
        }));
      }
      return [
        {
          id: "k99",
          contactId: "ct",
          lastMessageMs: day("2026-11-03T00:00:00Z") - 99 * 60_000,
        },
        {
          id: "old",
          contactId: "ct",
          lastMessageMs: day("2026-10-01T00:00:00Z"),
        },
      ];
    },
    ghlMessages: async (_c, { lastMessageId }) =>
      lastMessageId === null
        ? {
          items: [
            {
              id: "s1",
              conversationId: "k1",
              contactId: "ct",
              messageType: "TYPE_SMS",
              direction: "inbound",
              dateAdded: "2026-11-02T00:00:00Z",
              status: "delivered",
            },
            {
              id: "c1",
              conversationId: "k1",
              contactId: "ct",
              messageType: "TYPE_CALL",
              direction: "outbound",
              dateAdded: "2026-11-01T00:00:00Z",
              status: "completed",
            },
          ],
          nextPage: true,
          lastMessageId: "c1",
        }
        : {
          items: [
            {
              id: "a1",
              conversationId: "k1",
              contactId: null,
              messageType: "TYPE_ACTIVITY_OPPORTUNITY",
              direction: null,
              dateAdded: "2026-10-28T00:00:00Z",
              status: null,
            },
            {
              id: "s0",
              conversationId: "k1",
              contactId: "ct",
              messageType: "TYPE_SMS",
              direction: "inbound",
              dateAdded: "2026-10-20T00:00:00Z",
              status: null,
            },
          ],
          nextPage: true,
          lastMessageId: "s0",
        },
  });
  const convs = await runCensus(reads, {
    lane: "ghl_conversations",
    from: FROM,
    to: TO,
  });
  assertEquals(convs.complete, true);
  // The second page starts one millisecond past the first page's oldest, so a tie is re-listed.
  assertEquals(startAfter, [
    null,
    day("2026-11-03T00:00:00Z") - 99 * 60_000 + 1,
  ]);
  assertEquals((convs.items as unknown[]).length, 101);
  const msgs = await runCensus(reads, {
    lane: "ghl_messages",
    from: FROM,
    to: TO,
    conversations: ["k1"],
  });
  assertEquals(msgs.complete, true);
  assertEquals(
    (msgs.items as Array<{ id: string; kind: string; contact: boolean }>).map((
      m,
    ) => [m.id, m.kind, m.contact]),
    [["s1", "SMS", true], ["c1", "CALL", true], [
      "a1",
      "ACTIVITYOPPORTUNITY",
      false,
    ]],
  );
  // Nothing in an answer carries words.
  assert(!JSON.stringify(msgs).includes("body"));
});

Deno.test("email_explain: the reader's own builder decides; only the verdict leaves", async () => {
  const reads = fakeReads({
    mailItem: async (_m, id) => ({
      graphId: id,
      internetMessageId: `<${id}@x>`,
      subject: "Your statement",
      from: id === "auto" ? "no-reply@platform.example" : "jo@customer.example",
      to: ["admin@secureworkswa.com.au"],
      cc: [],
      receivedAt: "2026-11-02T00:00:00Z",
      bodyText: "private words",
      headers:
        (id === "auto" ? { "auto-submitted": "auto-generated" } : {}) as Record<
          string,
          string
        >,
      folderKind: "inbox",
    }),
  });
  const r = await runCensus(reads, {
    lane: "email_explain",
    items: [
      { mailbox: "admin@secureworkswa.com.au", id: "auto" },
      { mailbox: "admin@secureworkswa.com.au", id: "cust" },
    ],
  });
  const items = r.items as Array<Record<string, unknown>>;
  assertEquals(items[0].verdict, "skipped_noise");
  assertEquals(items[1].verdict, "row");
  assertEquals(items[1].key, "email:cust@x");
  const text = JSON.stringify(r);
  assert(
    !text.includes("private words") && !text.includes("statement") &&
      !text.includes("customer.example"),
  );
});

Deno.test("the door: server credential or company admin/owner only; ops staff refused; unknown fields refused", async () => {
  const deps = (
    server: boolean,
    role: string | null,
    orgId = COMPANY_ORG_ID,
  ) => ({
    isServer: async () => server,
    userProfile: async () => (role ? { role, orgId } : null),
    reads: () => fakeReads({ ghlConversations: async () => [] }),
  });
  const post = (body: unknown, auth = "Bearer user-jwt") =>
    new Request("https://x/functions/v1/context-capture-census", {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const ok = {
    lane: "ghl_conversations",
    from: FROM,
    to: "2026-11-03T11:00:00.000Z",
  };
  assertEquals(
    (await handleCensus(post(ok), deps(false, "ops_manager"))).status,
    403,
  );
  assertEquals(
    (await handleCensus(post(ok), deps(false, "admin", "other-org"))).status,
    403,
  );
  assertEquals(
    (await handleCensus(post(ok, ""), deps(false, null))).status,
    403,
  );
  assertEquals(
    (await handleCensus(post(ok), deps(false, "owner"))).status,
    200,
  );
  assertEquals((await handleCensus(post(ok), deps(true, null))).status, 200);
  assertEquals(
    (await handleCensus(post({ ...ok, wait: true }), deps(true, null))).status,
    400,
  );
  assertEquals(
    (await handleCensus(
      new Request("https://x", { method: "GET" }),
      deps(true, null),
    )).status,
    405,
  );
});

Deno.test("the live reads only GET Graph and GHL, with immutable ids, and never call a database writer", async () => {
  const calls: Array<{ url: string; method: string; prefer: string | null }> =
    [];
  const fetchFn =
    (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method ?? "GET",
        prefer: new Headers(init?.headers).get("prefer"),
      });
      if (url.includes("login.microsoftonline.com")) {
        return new Response(
          JSON.stringify({ access_token: "t", expires_in: 3600 }),
        );
      }
      if (url.includes("/mailFolders/")) {
        return new Response(JSON.stringify({ id: "F" }));
      }
      if (url.includes("/conversations/search")) {
        return new Response(
          JSON.stringify({
            conversations: [{
              id: "k1",
              contactId: "ct",
              lastMessageDate: Date.parse("2026-11-03T01:00:00Z"),
              locationId: "L1",
            }],
          }),
        );
      }
      if (url.includes("leadconnectorhq.com/conversations/")) {
        return new Response(
          JSON.stringify({
            messages: {
              messages: [{
                id: "s1",
                messageType: "TYPE_SMS",
                dateAdded: "2026-11-02T00:00:00Z",
                locationId: "L1",
              }],
              nextPage: false,
              lastMessageId: "s1",
            },
          }),
        );
      }
      return new Response(JSON.stringify({ value: [] }));
    }) as typeof fetch;
  const env: Record<string, string> = {
    MICROSOFT_TENANT_ID: "t",
    MICROSOFT_CLIENT_ID: "c",
    MICROSOFT_CLIENT_SECRET: "s",
    GHL_API_TOKEN: "g",
    GHL_LOCATION_ID: "L1",
  };
  const supabase = {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({ order: async () => ({ data: SOURCES, error: null }) }),
        }),
      }),
    }),
    rpc: () => {
      throw new Error("no rpc in this test");
    },
  };
  const reads = liveCensusReads({
    env: (n) => env[n],
    fetch: fetchFn,
    supabase,
    now: () => NOW,
  });
  await runCensus(reads, {
    lane: "email_messages",
    mailbox: "admin@secureworkswa.com.au",
    from: FROM,
    to: TO,
  });
  await runCensus(reads, { lane: "ghl_conversations", from: FROM, to: TO });
  await runCensus(reads, {
    lane: "ghl_messages",
    from: FROM,
    to: TO,
    conversations: ["k1"],
  });
  for (const c of calls) {
    if (c.url.includes("login.microsoftonline.com")) {
      assertEquals(c.method, "POST");
      continue;
    }
    assertEquals(c.method, "GET", c.url);
    assert(
      c.url.startsWith("https://graph.microsoft.com/v1.0/") ||
        c.url.startsWith("https://services.leadconnectorhq.com/"),
      c.url,
    );
    if (c.url.startsWith("https://graph.microsoft.com/")) {
      assert(c.prefer?.includes('IdType="ImmutableId"'));
    }
  }
  assert(
    calls.some((c) =>
      c.url.includes("/users/admin%40secureworkswa.com.au/messages?")
    ),
  );
  assert(
    calls.some((c) => c.url.includes("/conversations/k1/messages?limit=100")),
  );
});

Deno.test("server check: a service-role key the platform honours is accepted even when it differs from the injected key; a refused or unknown claim is not", async () => {
  const b64 = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(
      /\//g,
      "_",
    );
  const held = `${b64({ alg: "HS256" })}.${b64({ role: "service_role" })}.sig`;
  const anon = `${b64({ alg: "HS256" })}.${b64({ role: "anon" })}.sig`;
  const env = (name: string) =>
    name === "SUPABASE_SERVICE_ROLE_KEY" ? "the-injected-key" : undefined;
  const headers = (token: string) =>
    new Headers({ apikey: token, authorization: `Bearer ${token}` });
  assertEquals(
    await serverCredentialCheck(env, async () => "accepted")(headers(held)),
    true,
  );
  assertEquals(
    await serverCredentialCheck(env, async () => "rejected")(headers(held)),
    false,
  );
  assertEquals(
    await serverCredentialCheck(env, async () => "unknown")(headers(held)),
    false,
  );
  assertEquals(
    await serverCredentialCheck(env, async () => "accepted")(headers(anon)),
    false,
  );
  assertEquals(
    await serverCredentialCheck(env, async () => "accepted")(new Headers()),
    false,
  );
});
