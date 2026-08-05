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
