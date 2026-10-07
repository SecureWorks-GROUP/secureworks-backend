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

Deno.test("errors carry the status code, never the response text", async () => {
  const { deps } = recorder(() =>
    new Response("secret mail words", { status: 403 })
  );
  const e = await assertRejects(() =>
    graph.folderIds(deps, "khairo@secureworkswa.com.au")
  );
  assertEquals((e as graph.GraphReadError).code, "graph_403");
  assert(!String((e as Error).message).includes("secret"));
});

Deno.test("a missing well-known folder reads as none; other folder errors stop the source", async () => {
  const { deps } = recorder((url) =>
    url.includes("junkemail")
      ? new Response("", { status: 404 })
      : ok({ id: "F" })
  );
  const f = await graph.folderIds(deps, "n@secureworkswa.com.au");
  assertEquals(f.junk, null);
  assertEquals(f.sent, "F");
});

Deno.test("an attachment larger than the limit is refused before or after download", async () => {
  const big = recorder(() =>
    new Response(new Uint8Array(20), {
      status: 200,
      headers: { "content-length": "20" },
    })
  );
  const home = {
    kind: "message" as const,
    mailbox: "n@secureworkswa.com.au",
    messageId: "M",
  };
  const e = await assertRejects(() =>
    graph.attachmentBytes(big.deps, home, { id: "a" }, 10)
  );
  assertEquals((e as graph.GraphReadError).code, "attachment_too_large");
  const lying = recorder(() =>
    new Response(new Uint8Array(20), { status: 200 })
  );
  const e2 = await assertRejects(() =>
    graph.attachmentBytes(lying.deps, home, { id: "a" }, 10)
  );
  assertEquals((e2 as graph.GraphReadError).code, "attachment_too_large");
});

Deno.test("a next link that is not Graph is refused", async () => {
  const { deps, calls } = recorder(() => ok({ value: [] }));
  const e = await assertRejects(() =>
    graph.listMessages(deps, "n@secureworkswa.com.au", {
      fromIso: "2026-10-01T00:00:00Z",
      top: 25,
      next: "https://evil.example/x",
    })
  );
  assertEquals((e as graph.GraphReadError).code, "graph_bad_url");
  assertEquals(calls.length, 0);
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
const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));

function groupGraph(attachments: unknown[]) {
  return recorder((url) => {
    const path = new URL(url).pathname;
    // What Microsoft does today for an app login: the post's own attachments
    // address is refused.
    if (/\/posts\/[^/]+\/attachments/.test(path)) {
      return new Response("refused", { status: 403 });
    }
    if (path.endsWith("/groups/G/threads/T/posts/P")) {
      return ok({ id: "P", attachments });
    }
    return new Response("unexpected", { status: 404 });
  });
}

Deno.test("a group post's attachments are read with the post through $expand=attachments, never the refused attachments address", async () => {
  const { deps, calls } = groupGraph([
    {
      "@odata.type": "#microsoft.graph.fileAttachment",
      id: "A1",
      name: "invoice.pdf",
      contentType: "application/pdf",
      size: 3,
      isInline: false,
      contentBytes: b64([37, 80, 68]),
    },
    {
      "@odata.type": "#microsoft.graph.itemAttachment",
      id: "A2",
      name: "fwd",
      size: 10,
    },
  ]);
  const listed = await graph.listAttachments(deps, POST);
  assertEquals(listed.map((a) => [a.id, a.kind, a.name]), [
    ["A1", "file", "invoice.pdf"],
    ["A2", "item", "fwd"],
  ]);
  const bytes = await graph.attachmentBytes(deps, POST, listed[0], 10);
  assertEquals([...bytes], [37, 80, 68]);
  assertEquals(calls.length, 1); // one read of the post; the bytes came with it
  assertEquals(
    decodeURIComponent(calls[0].url),
    "https://graph.microsoft.com/v1.0/groups/G/threads/T/posts/P?$expand=attachments",
  );
  assertEquals(calls[0].method, "GET");
  assert(calls[0].prefer?.includes('IdType="ImmutableId"'));
  for (const c of calls) {
    assert(!/\/posts\/[^/?]+\/attachments/.test(c.url), c.url);
  }
});

Deno.test("a group attachment sent without its bytes, or larger than the limit, is refused with a code; nothing is fetched again", async () => {
  const { deps, calls } = groupGraph([
    {
      "@odata.type": "#microsoft.graph.fileAttachment",
      id: "BIG",
      name: "plans.pdf",
      contentType: "application/pdf",
      size: 9_000_000,
      isInline: false,
    },
    {
      "@odata.type": "#microsoft.graph.fileAttachment",
      id: "TWENTY",
      name: "photo.jpg",
      contentType: "image/jpeg",
      size: 20,
      isInline: false,
      contentBytes: b64(Array.from({ length: 20 }, (_, i) => i)),
    },
    {
      "@odata.type": "#microsoft.graph.fileAttachment",
      id: "BAD",
      name: "broken.pdf",
      contentType: "application/pdf",
      size: 3,
      isInline: false,
      contentBytes: "%%% not base64 %%%",
    },
  ]);
  const [big, twenty, bad] = await graph.listAttachments(deps, POST);
  const e1 = await assertRejects(() =>
    graph.attachmentBytes(deps, POST, big, 15 * 1024 * 1024)
  );
  assertEquals((e1 as graph.GraphReadError).code, "attachment_no_content");
  const e2 = await assertRejects(() =>
    graph.attachmentBytes(deps, POST, twenty, 10)
  );
  assertEquals((e2 as graph.GraphReadError).code, "attachment_too_large");
  const e3 = await assertRejects(() =>
    graph.attachmentBytes(deps, POST, bad, 10)
  );
  assertEquals((e3 as graph.GraphReadError).code, "attachment_bad_content");
  assertEquals(calls.length, 1);
});

Deno.test("a group post read larger than the read limit is refused with a code, before it is all held in memory", async () => {
  let sent = 0;
  const { deps } = recorder(() =>
    new Response(
      new ReadableStream({
        pull(c) {
          // 60 MB in 1 MB chunks, no content-length header.
          if (sent++ >= 60) return c.close();
          c.enqueue(new Uint8Array(1024 * 1024).fill(97));
        },
      }),
      { status: 200 },
    )
  );
  const e = await assertRejects(() => graph.listAttachments(deps, POST));
  assertEquals((e as graph.GraphReadError).code, "attachment_post_too_large");
  assert(sent < 60, `read ${sent} MB before refusing`);
});
