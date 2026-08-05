// deno-lint-ignore-file no-explicit-any
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  createSesGraphMailGateway,
  filterMessagesByOperationToken,
  headersHaveOperationToken,
  messageHasOperationToken,
  SES_ADMIN_HTML_SIGNATURE,
  SES_OPERATION_HEADER,
  SES_RELEASE_MAILBOX,
  sesOperationInternetMessageHeaders,
  sesOperationSubject,
  sesOptionalThreadingHeaders,
  sesReleaseHtmlBody,
  subjectHasOperationToken,
  toSesRouteSendResults,
} from "./ses_graph_mail_gateway.ts";

const TOKEN = "SES-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

Deno.test("builder-facing subject never carries the SES operation token", () => {
  assertEquals(sesOperationSubject("Report pack", TOKEN), "Report pack");
  assertEquals(
    sesOperationSubject(`Report pack [${TOKEN}]`, TOKEN),
    "Report pack",
  );
  assertEquals(
    sesOperationSubject(`AJBR-70488 [${TOKEN}]`, TOKEN),
    "AJBR-70488",
  );
  assertEquals(subjectHasOperationToken(`x [${TOKEN}]`, TOKEN), true);
  assertEquals(subjectHasOperationToken("nope", TOKEN), false);
});

Deno.test("operation header is the non-visible carrier", () => {
  const headers = sesOperationInternetMessageHeaders(TOKEN);
  assertEquals(headers, [{ name: SES_OPERATION_HEADER, value: TOKEN }]);
  assert(headersHaveOperationToken(headers, TOKEN));
  assertEquals(headersHaveOperationToken(headers, "SES-other"), false);
  assertEquals(headersHaveOperationToken([], TOKEN), false);
});

Deno.test("html body escapes text, appends Maverick signature, never injects token", () => {
  const html = sesReleaseHtmlBody("Hello <builder>\n\nLine two");
  assertStringIncludes(html, "Hello &lt;builder&gt;");
  assertStringIncludes(html, SES_ADMIN_HTML_SIGNATURE);
  assertStringIncludes(html, "Maverick");
  assertEquals(html.includes("SES-"), false);
});

Deno.test("token match prefers header; legacy subject still matches for cutover", () => {
  const headerMsg = {
    id: "1",
    subject: "Clean pack",
    internetMessageHeaders: [{ name: SES_OPERATION_HEADER, value: TOKEN }],
  };
  const legacyMsg = {
    id: "2",
    subject: `Pack [${TOKEN}]`,
  };
  const other = { id: "3", subject: "Other" };
  assert(messageHasOperationToken(headerMsg, TOKEN));
  assert(messageHasOperationToken(legacyMsg, TOKEN));
  assertEquals(messageHasOperationToken(other, TOKEN), false);
  assertEquals(
    filterMessagesByOperationToken([headerMsg, legacyMsg, other], TOKEN).map(
      (m) => m.id,
    ),
    ["1", "2"],
  );
  assertEquals(toSesRouteSendResults([headerMsg, legacyMsg, other], TOKEN).length, 2);
});

Deno.test("createDraftAndSend stamps header only, not subject/body, and proves via Sent Items", async () => {
  const token = "SES-proof-token";
  const calls: Array<{ url: string; method: string; body?: any }> = [];
  let draftSent = false;
  const graphJson = async (
    url: string,
    init: RequestInit,
    expected: number[],
  ) => {
    const method = String(init.method || "GET").toUpperCase();
    const parsedBody = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body: parsedBody });
    if (method === "POST" && url.endsWith("/messages") && !url.includes("/send")) {
      assert(expected.includes(201));
      const body = parsedBody;
      assertEquals(body.body.contentType, "HTML");
      assertStringIncludes(body.body.content, "Maverick");
      // Proof half 1: builder-facing fields have no SES token.
      assertEquals(String(body.subject).includes(token), false);
      assertEquals(String(body.body.content).includes(token), false);
      assertEquals(String(body.subject).includes("SES-"), false);
      // Proof half 2 carrier: non-visible header is set.
      assertEquals(body.internetMessageHeaders, [{
        name: SES_OPERATION_HEADER,
        value: token,
      }]);
      return { id: "draft-1" };
    }
    if (method === "POST" && url.endsWith("/send")) {
      draftSent = true;
      assert(expected.includes(202));
      return null;
    }
    if (method === "GET" && url.includes("mailFolders/sentitems")) {
      // Proof path must not use OData contains — list then filter client-side.
      assertEquals(url.includes("contains("), false);
      assertStringIncludes(url, "internetMessageHeaders");
      if (!draftSent) return { value: [] };
      return {
        value: [{
          id: "sent-1",
          internetMessageId: "<mid@example>",
          // Clean subject — token lives only on the header.
          subject: "Report",
          internetMessageHeaders: [{
            name: SES_OPERATION_HEADER,
            value: token,
          }],
        }],
      };
    }
    if (method === "GET" && url.includes("mailFolders/drafts")) {
      return { value: [] };
    }
    throw new Error(`unexpected graph call ${method} ${url}`);
  };

  const gateway = createSesGraphMailGateway({
    graphJson,
    loadAttachments: async () => [],
    checkpointDraft: async () => {},
    uploadAttachment: async () => {},
    sentPollAttempts: 3,
    sentPollDelayMs: 1,
  });

  const sent = await gateway.createDraftAndSend(
    {
      subject: "Report",
      body: "Body text",
      recipients: ["workorders@ajs.build"],
      cc: ["ses@secureworkswa.com.au"],
      attachment_hashes: [],
    },
    { external_token: token, operation_key: "op-1" },
  );
  assertEquals(sent.message_id, "sent-1");
  assertEquals(sent.operation_token, token);
  assert(calls.some((c) => c.method === "POST" && c.url.includes("/send")));
  assertEquals(SES_RELEASE_MAILBOX, "admin@secureworkswa.com.au");
});

Deno.test("reconcileSent finds message by header when subject is clean", async () => {
  const token = "SES-reconcile-token";
  let phase: "draft" | "sent" = "draft";
  const graphJson = async (url: string, init: RequestInit) => {
    const method = String(init.method || "GET").toUpperCase();
    const headerRow = {
      id: phase === "sent" ? "sent-9" : "draft-9",
      subject: "AJBR-70488 - report and invoice",
      internetMessageHeaders: [{
        name: SES_OPERATION_HEADER,
        value: token,
      }],
    };
    if (method === "GET" && url.includes("sentitems")) {
      if (phase === "sent") return { value: [headerRow] };
      return { value: [] };
    }
    if (method === "GET" && url.includes("drafts")) {
      return { value: [headerRow] };
    }
    if (method === "POST" && url.endsWith("/send")) {
      phase = "sent";
      return null;
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  const gateway = createSesGraphMailGateway({
    graphJson: graphJson as any,
    loadAttachments: async () => [],
    checkpointDraft: async () => {},
    uploadAttachment: async () => {},
    sentPollAttempts: 3,
    sentPollDelayMs: 1,
  });
  const rows = await gateway.reconcileSent(token);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].message_id, "sent-9");
});

Deno.test("reconcileSent hydrates headers when list omits internetMessageHeaders", async () => {
  const token = "SES-hydrate-token";
  const graphJson = async (url: string, init: RequestInit) => {
    const method = String(init.method || "GET").toUpperCase();
    if (method === "GET" && url.includes("mailFolders/sentitems")) {
      // List without headers (tenant variance).
      return {
        value: [{
          id: "sent-hydrate",
          subject: "Clean subject",
        }],
      };
    }
    if (
      method === "GET" &&
      url.includes("/messages/sent-hydrate") &&
      url.includes("internetMessageHeaders")
    ) {
      return {
        id: "sent-hydrate",
        subject: "Clean subject",
        internetMessageHeaders: [{
          name: SES_OPERATION_HEADER,
          value: token,
        }],
      };
    }
    if (method === "GET" && url.includes("mailFolders/drafts")) {
      return { value: [] };
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  const gateway = createSesGraphMailGateway({
    graphJson: graphJson as any,
    loadAttachments: async () => [],
    checkpointDraft: async () => {},
    uploadAttachment: async () => {},
    sentPollAttempts: 1,
    sentPollDelayMs: 1,
  });
  const rows = await gateway.reconcileSent(token);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].message_id, "sent-hydrate");
});

Deno.test("reconcileSent still finds legacy subject-stamped messages", async () => {
  const token = "SES-legacy-token";
  const graphJson = async (url: string, init: RequestInit) => {
    const method = String(init.method || "GET").toUpperCase();
    if (method === "GET" && url.includes("sentitems")) {
      return {
        value: [{ id: "sent-legacy", subject: `x [${token}]` }],
      };
    }
    if (method === "GET" && url.includes("drafts")) {
      return { value: [] };
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  const gateway = createSesGraphMailGateway({
    graphJson: graphJson as any,
    loadAttachments: async () => [],
    checkpointDraft: async () => {},
    uploadAttachment: async () => {},
    sentPollAttempts: 1,
    sentPollDelayMs: 1,
  });
  const rows = await gateway.reconcileSent(token);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].message_id, "sent-legacy");
});

Deno.test("group thread reply posts on intake thread and never opens a new message", async () => {
  const token = "SES-thread-token";
  const calls: Array<{ url: string; method: string; body?: any }> = [];
  let replied = false;
  const htmlProbe = sesReleaseHtmlBody("Report on thread");
  const graphJson = async (
    url: string,
    init: RequestInit,
    expected: number[],
  ) => {
    const method = String(init.method || "GET").toUpperCase();
    const parsedBody = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body: parsedBody });
    if (method === "POST" && url.includes("/threads/thread-1/reply")) {
      assert(expected.includes(202));
      assertEquals(parsedBody.post.body.contentType, "HTML");
      assertStringIncludes(parsedBody.post.body.content, "Maverick");
      assertEquals(
        String(parsedBody.post.body.content).includes(token),
        false,
      );
      replied = true;
      return null;
    }
    if (method === "GET" && url.includes("/threads/thread-1/posts")) {
      if (!replied) return { value: [] };
      return {
        value: [{
          id: "post-reply-1",
          body: { contentType: "HTML", content: htmlProbe },
          createdDateTime: "2026-08-05T00:00:00Z",
        }],
      };
    }
    throw new Error(`unexpected graph call ${method} ${url}`);
  };

  const gateway = createSesGraphMailGateway({
    graphJson,
    loadAttachments: async () => [{
      name: "report.pdf",
      contentType: "application/pdf",
      bytes: new Uint8Array([1, 2, 3]),
    }],
    checkpointDraft: async () => {},
    uploadAttachment: async () => {
      throw new Error("uploadAttachment must not run for group thread reply");
    },
    resolveIntakeGroupId: async () => "group-1",
    sentPollAttempts: 3,
    sentPollDelayMs: 1,
  });

  const sent = await gateway.createDraftAndSend(
    {
      subject: "Report",
      body: "Report on thread",
      recipients: ["site@mlb.example"],
      cc: [],
      attachment_hashes: ["h1"],
      reply_to_thread_id: "thread-1",
      requires_thread_reply: true,
    },
    { external_token: token, operation_key: "op-thread-1" },
  );
  assertEquals(sent.message_id, "post-reply-1");
  assertEquals(sent.operation_token, token);
  assert(
    calls.some((c) =>
      c.method === "POST" && c.url.includes("/threads/thread-1/reply")
    ),
  );
  assertEquals(
    calls.some((c) =>
      c.method === "POST" &&
      c.url.endsWith("/messages") &&
      !c.url.includes("createReply")
    ),
    false,
  );
});

Deno.test("requires_thread_reply without thread id refuses rather than new thread", async () => {
  let called = false;
  const gateway = createSesGraphMailGateway({
    graphJson: async () => {
      called = true;
      throw new Error("graph must not be called");
    },
    loadAttachments: async () => [],
    checkpointDraft: async () => {},
    uploadAttachment: async () => {},
  });
  let failed = false;
  try {
    await gateway.createDraftAndSend(
      {
        subject: "Report",
        body: "Body",
        recipients: ["site@mlb.example"],
        attachment_hashes: [],
        requires_thread_reply: true,
      },
      { external_token: "SES-x", operation_key: "op-x" },
    );
  } catch (err) {
    failed = true;
    assertStringIncludes(String((err as Error).message), "refusing to open a new thread");
  }
  assertEquals(failed, true);
  assertEquals(called, false);
});

Deno.test(
  "ordinary Mail.Send ignores bare reply_to_thread_id without requires_thread_reply",
  async () => {
    // Captain exception path: intended_intake_thread_id may be known for audit,
    // but must not force conversationThread:reply (app-only 403).
    const token = "SES-ordinary-fallback";
    const calls: Array<{ url: string; method: string; body?: any }> = [];
    let draftSent = false;
    const graphJson = async (
      url: string,
      init: RequestInit,
      expected: number[],
    ) => {
      const method = String(init.method || "GET").toUpperCase();
      const parsedBody = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body: parsedBody });
      if (url.includes("/threads/") && url.includes("/reply")) {
        throw new Error("group-thread reply must not run on ordinary fallback");
      }
      if (
        method === "POST" && url.endsWith("/messages") && !url.includes("/send")
      ) {
        assert(expected.includes(201));
        assertEquals(
          parsedBody.internetMessageHeaders.some(
            (h: any) =>
              h.name === SES_OPERATION_HEADER && h.value === token,
          ),
          true,
        );
        // Captain: In-Reply-To must never be stamped on draft create (Graph
        // rejects non-x- headers and would 400 the whole send). Message-ID
        // present or missing must not block ordinary Mail.Send.
        assertEquals(
          (parsedBody.internetMessageHeaders || []).some(
            (h: any) =>
              String(h.name || "").toLowerCase() === "in-reply-to" ||
              String(h.name || "").toLowerCase() === "references",
          ),
          false,
        );
        return { id: "draft-ordinary-1" };
      }
      if (method === "POST" && url.endsWith("/send")) {
        draftSent = true;
        return null;
      }
      if (method === "GET" && url.includes("mailFolders/sentitems")) {
        if (!draftSent) return { value: [] };
        return {
          value: [{
            id: "sent-ordinary-1",
            internetMessageId: "<sent@sw>",
            subject: "Report",
            internetMessageHeaders: [{
              name: SES_OPERATION_HEADER,
              value: token,
            }],
          }],
        };
      }
      if (method === "GET" && url.includes("mailFolders/drafts")) {
        return { value: [] };
      }
      throw new Error(`unexpected graph call ${method} ${url}`);
    };

    const gateway = createSesGraphMailGateway({
      graphJson,
      loadAttachments: async () => [],
      checkpointDraft: async () => {},
      uploadAttachment: async () => {},
      sentPollAttempts: 3,
      sentPollDelayMs: 1,
    });

    const sent = await gateway.createDraftAndSend(
      {
        subject: "Report",
        body: "Body",
        recipients: ["makesafes@mlbuilders.com.au"],
        cc: [],
        attachment_hashes: [],
        // Deliberately present but requires_thread_reply false — ordinary path.
        reply_to_thread_id: "thread-must-be-ignored",
        requires_thread_reply: false,
        in_reply_to_internet_message_id: "mid@mlb.example",
        mlb_transport: "ordinary_mail_send_captain_exception_v1",
      },
      { external_token: token, operation_key: "op-ordinary-1" },
    );
    assertEquals(sent.message_id, "sent-ordinary-1");
    assertEquals(sent.operation_token, token);
    assert(
      calls.some((c) =>
        c.method === "POST" &&
        c.url.includes("/users/") &&
        c.url.endsWith("/messages")
      ),
    );
    assertEquals(
      calls.some((c) => c.url.includes("/threads/") && c.url.includes("/reply")),
      false,
    );
  },
);

Deno.test("sesOptionalThreadingHeaders normalizes angle brackets but is not used on draft create", () => {
  assertEquals(sesOptionalThreadingHeaders(null), []);
  assertEquals(sesOptionalThreadingHeaders(""), []);
  assertEquals(sesOptionalThreadingHeaders("mid@ex"), [
    { name: "In-Reply-To", value: "<mid@ex>" },
    { name: "References", value: "<mid@ex>" },
  ]);
  assertEquals(sesOptionalThreadingHeaders("<mid@ex>"), [
    { name: "In-Reply-To", value: "<mid@ex>" },
    { name: "References", value: "<mid@ex>" },
  ]);
});

Deno.test(
  "ordinary Mail.Send never blocks when Message-ID is missing (no threading headers required)",
  async () => {
    const token = "SES-no-mid";
    let draftSent = false;
    const graphJson = async (
      url: string,
      init: RequestInit,
      expected: number[],
    ) => {
      const method = String(init.method || "GET").toUpperCase();
      const parsedBody = init.body ? JSON.parse(String(init.body)) : undefined;
      if (
        method === "POST" && url.endsWith("/messages") && !url.includes("/send")
      ) {
        assert(expected.includes(201));
        // Only the SES operation header — no In-Reply-To required or present.
        assertEquals(parsedBody.internetMessageHeaders, [{
          name: SES_OPERATION_HEADER,
          value: token,
        }]);
        return { id: "draft-no-mid" };
      }
      if (method === "POST" && url.endsWith("/send")) {
        draftSent = true;
        return null;
      }
      if (method === "GET" && url.includes("mailFolders/sentitems")) {
        if (!draftSent) return { value: [] };
        return {
          value: [{
            id: "sent-no-mid",
            subject: "Report",
            internetMessageHeaders: [{
              name: SES_OPERATION_HEADER,
              value: token,
            }],
          }],
        };
      }
      if (method === "GET" && url.includes("mailFolders/drafts")) {
        return { value: [] };
      }
      throw new Error(`unexpected ${method} ${url}`);
    };
    const gateway = createSesGraphMailGateway({
      graphJson: graphJson as any,
      loadAttachments: async () => [],
      checkpointDraft: async () => {},
      uploadAttachment: async () => {},
      sentPollAttempts: 3,
      sentPollDelayMs: 1,
    });
    const sent = await gateway.createDraftAndSend(
      {
        subject: "Report",
        body: "Body",
        recipients: ["makesafes@mlbuilders.com.au"],
        attachment_hashes: [],
        // No Message-ID — must still send.
        in_reply_to_internet_message_id: null,
      },
      { external_token: token, operation_key: "op-no-mid" },
    );
    assertEquals(sent.message_id, "sent-no-mid");
  },
);
