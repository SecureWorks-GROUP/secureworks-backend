// Slice EM2: the Graph reads are reads. Every call is a GET to Graph with
// immutable ids and text bodies; no send, reply, move, delete or mark-read
// endpoint is ever reached, and errors carry codes only.
// deno-lint-ignore-file no-import-prefix require-await
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import * as graph from "./graph.ts";

function recorder(respond: (url: string) => Response) {
  const calls: Array<{ url: string; method: string; prefer: string | null }> =
    [];
  const deps: graph.GraphDeps = {
    token: async () => "tok",
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method ?? "GET",
        prefer: new Headers(init?.headers).get("prefer"),
      });
      return respond(url);
    }) as typeof fetch,
  };
  return { deps, calls };
}

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200 });

Deno.test("every read is a GET to Graph asking for immutable ids and text bodies", async () => {
  const { deps, calls } = recorder((url) => {
    if (url.includes("/mailFolders/")) return ok({ id: "F" });
    if (url.includes("/attachments/") && url.endsWith("/$value")) {
      return new Response(new Uint8Array([1]), { status: 200 });
    }
    if (url.includes("/attachments")) {
      return ok({
        value: [{ id: "a", "@odata.type": "#microsoft.graph.itemAttachment" }],
      });
    }
    if (url.includes("/groups?")) return ok({ value: [{ id: "G" }] });
    if (url.includes("/conversations?")) {
      return ok({
        value: [{ id: "C", lastDeliveredDateTime: "2026-10-01T00:00:00Z" }],
      });
    }
    if (url.includes("/threads?")) {
      return ok({ value: [{ id: "T", topic: "Topic" }] });
    }
    if (url.includes("/posts?")) {
      return ok({
        value: [{
          id: "P",
          from: { emailAddress: { address: "a@b.example" } },
          receivedDateTime: "2026-10-01T00:00:00Z",
          body: { contentType: "text", content: "hi" },
          singleValueExtendedProperties: [{
            id: "String 0x1035",
            value: "<p1@x.example>",
          }],
        }],
      });
    }
    return ok({ value: [], uniqueBody: { contentType: "text", content: "x" } });
  });
  await graph.folderIds(deps, "n@secureworkswa.com.au");
  await graph.listMessages(deps, "n@secureworkswa.com.au", {
    fromIso: "2026-10-01T00:00:00Z",
    top: 25,
  });
  await graph.listMessages(deps, "n@secureworkswa.com.au", {
    fromIso: "2026-10-01T00:00:00Z",
    top: 25,
    lean: true,
  });
  await graph.messageDetail(deps, "n@secureworkswa.com.au", "id");
  assertEquals(
    await graph.resolveGroupId(deps, "patios@secureworkswa.com.au"),
    "G",
  );
  await graph.listGroupConversations(deps, "G");
  await graph.listGroupThreads(deps, "G", "C");
  const posts = await graph.listGroupPosts(deps, "G", "T", "Topic");
  assertEquals(posts[0].internetMessageId, "<p1@x.example>");
  assertEquals(posts[0].folderKind, "group");
  const atts = await graph.listAttachments(deps, {
    kind: "message",
    mailbox: "n@secureworkswa.com.au",
    messageId: "M",
  });
  assertEquals(atts[0].kind, "item");
  await graph.listAttachments(deps, {
    kind: "post",
    groupId: "G",
    threadId: "T",
    postId: "P",
  });
  await graph.attachmentBytes(
    deps,
    { kind: "message", mailbox: "n@secureworkswa.com.au", messageId: "M" },
    { id: "a" },
    10,
  );
  assert(calls.length >= 15);
  for (const c of calls) {
    assertEquals(c.method, "GET");
    assert(c.url.startsWith("https://graph.microsoft.com/v1.0/"), c.url);
    assert(
      !/\/(send|reply|replyAll|forward|move|copy|createReply)\b/i.test(c.url),
      c.url,
    );
  }
  for (const c of calls.filter((c) => !c.url.endsWith("/$value"))) {
    assert(c.prefer?.includes('IdType="ImmutableId"'), c.url);
    assert(c.prefer?.includes('outlook.body-content-type="text"'), c.url);
  }
  // Full list selects the new words and headers; lean leaves them to messageDetail.
  const lists = calls.filter((c) => c.url.includes("/messages?"));
  assert(decodeURIComponent(lists[0].url).includes("uniqueBody"));
  assert(!decodeURIComponent(lists[1].url).includes("uniqueBody"));
  assert(
    decodeURIComponent(lists[0].url).includes(
      "receivedDateTime ge 2026-10-01T00:00:00Z",
    ),
  );
});

Deno.test("the token request is the only POST, to Microsoft's login endpoint", async () => {
  const calls: string[] = [];
  const source = graph.graphTokenSource(
    (n) =>
      ({
        MICROSOFT_TENANT_ID: "t",
        MICROSOFT_CLIENT_ID: "c",
        MICROSOFT_CLIENT_SECRET: "s",
      } as Record<string, string>)[n],
    (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method} ${String(input)}`);
      return ok({ access_token: "tok", expires_in: 3600 });
    }) as typeof fetch,
  );
  assertEquals(await source(), "tok");
  assertEquals(await source(), "tok");
  assertEquals(calls, [
    "POST https://login.microsoftonline.com/t/oauth2/v2.0/token",
  ]);
  const missing = graph.graphTokenSource(() => undefined, fetch);
  const e = await assertRejects(() => missing());
  assertEquals((e as graph.GraphReadError).code, "graph_credentials_missing");
});

// Lanes health (6 Oct 2026): Microsoft refuses a group post's own attachments
// address to an app-only login, so finance@, patios@, fencing@ and ses@ saved
// no file at all. The post is read with $expand=attachments instead (the route
// monitor-ses-makesafes already uses for ses@), and the file bytes come with it.
const POST = {
  kind: "post" as const,
  groupId: "G",
  threadId: "T",
  postId: "P",
};
