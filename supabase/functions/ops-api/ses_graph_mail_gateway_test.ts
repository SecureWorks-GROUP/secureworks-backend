// deno-lint-ignore-file no-explicit-any
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  createSesGraphMailGateway,
  filterMessagesByOperationToken,
  sesOperationSubject,
  sesReleaseHtmlBody,
  SES_ADMIN_HTML_SIGNATURE,
  SES_RELEASE_MAILBOX,
  subjectHasOperationToken,
  toSesRouteSendResults,
} from "./ses_graph_mail_gateway.ts";

Deno.test("operation subject stamps the SES token once", () => {
  const token = "SES-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  assertEquals(
    sesOperationSubject("Report pack", token),
    `Report pack [${token}]`,
  );
  assertEquals(
    sesOperationSubject(`Report pack [${token}]`, token),
    `Report pack [${token}]`,
  );
  assert(subjectHasOperationToken(`x [${token}]`, token));
  assertEquals(subjectHasOperationToken("nope", token), false);
});

Deno.test("html body escapes text and appends Maverick signature", () => {
  const html = sesReleaseHtmlBody("Hello <builder>\n\nLine two");
  assertStringIncludes(html, "Hello &lt;builder&gt;");
  assertStringIncludes(html, SES_ADMIN_HTML_SIGNATURE);
  assertStringIncludes(html, "Maverick");
});

Deno.test("token match is client-side — no OData contains dependency", () => {
  const token = "SES-token-1";
  const messages = [
    { id: "1", subject: `Pack [${token}]` },
    { id: "2", subject: "Other" },
    { id: "3", subject: `Again ${token}` },
  ];
  assertEquals(filterMessagesByOperationToken(messages, token).map((m) => m.id), [
    "1",
    "3",
  ]);
  assertEquals(toSesRouteSendResults(messages, token).length, 2);
});

Deno.test("createDraftAndSend creates HTML draft, sends, and proves via Sent Items list", async () => {
  const token = "SES-proof-token";
  const calls: Array<{ url: string; method: string }> = [];
  let draftSent = false;
  const graphJson = async (
    url: string,
    init: RequestInit,
    expected: number[],
  ) => {
    const method = String(init.method || "GET").toUpperCase();
    calls.push({ url, method });
    if (method === "POST" && url.endsWith("/messages") && !url.includes("/send")) {
      assert(expected.includes(201));
      const body = JSON.parse(String(init.body || "{}"));
      assertEquals(body.body.contentType, "HTML");
      assertStringIncludes(body.body.content, "Maverick");
      assertStringIncludes(body.subject, token);
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
      if (!draftSent) return { value: [] };
      return {
        value: [{
          id: "sent-1",
          internetMessageId: "<mid@example>",
          subject: `Report [${token}]`,
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

Deno.test("reconcileSent resends a single matching draft then proves Sent Items", async () => {
  const token = "SES-reconcile-token";
  let phase: "draft" | "sent" = "draft";
  const graphJson = async (url: string, init: RequestInit) => {
    const method = String(init.method || "GET").toUpperCase();
    if (method === "GET" && url.includes("sentitems")) {
      if (phase === "sent") {
        return {
          value: [{ id: "sent-9", subject: `x [${token}]` }],
        };
      }
      return { value: [] };
    }
    if (method === "GET" && url.includes("drafts")) {
      return {
        value: [{ id: "draft-9", subject: `x [${token}]` }],
      };
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
