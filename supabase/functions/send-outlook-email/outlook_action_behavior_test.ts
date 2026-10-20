// deno-lint-ignore-file no-explicit-any no-import-prefix
import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifyOutlookRoute,
  composeSignedHtml,
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
  SIGNATURE_LOGO_CID,
  splitRecipientInput,
  validateInlineAttachment,
  withSignatureLogo,
} from "./index.ts";
import { bodyEndsWithSignOff } from "./index.ts";
import { statementHtml } from "../ops-api/debt_ws_rules.ts";
import {
  DEBT_WS_STATEMENT_FROM,
  DEBT_WS_STATEMENT_SIGNATURE,
} from "../ops-api/debt_ws_actions.ts";
import {
  buildVariationEmails,
  WORK_ORDER_VARIATION_SENDER_MAILBOX,
} from "../ops-api/job_work_orders.ts";

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
  const marnin = getSignature("marnin@secureworkswa.com.au");
  assertEquals(marnin.includes("Marnin Stobbe"), true);
  assertEquals(marnin.includes("Director"), true);
  assertEquals(marnin.includes("Operations Manager"), false);
  assertEquals(marnin.includes("Kind regards,"), true);
  assertEquals(
    marnin.includes(
      'href="tel:0404777984" style="color:rgb(76,106,124); text-decoration:none; margin-top:0px; margin-bottom:0px">0404 777 984</a>',
    ),
    true,
  );
  assertEquals(getSignature("hugo@secureworkswa.com.au"), "");
  const company = getSignature("admin@secureworkswa.com.au");
  assertEquals(company.includes('data-secureworks-signature="secureworks"'), true);
  assertEquals(company.includes("<b>SecureWorks Group</b>"), true);
  assertEquals(company.includes("Maverick"), false);
  assertEquals(company.includes("Shaun Lee"), false);
  assertEquals(company.includes(">Operations</span></p>"), true);
  assertEquals(company.includes("admin@secureworkswa.com.au"), true);
  assertEquals(
    company.includes(
      'href="tel:0489267771" style="color:rgb(76,106,124); text-decoration:none; margin-top:0px; margin-bottom:0px">0489 267 771</a>',
    ),
    true,
  );
  assertEquals(company.includes("+61"), false);
  assertEquals(company.includes(`cid:${SIGNATURE_LOGO_CID}`), true);
  assertEquals(company.includes("ses@secureworkswa.com.au"), false);
  assertEquals(company.includes("data:image"), false);
  const shaun = getSignature("shaun@secureworkswa.com.au");
  assertEquals(shaun.includes("Shaun Lee"), true);
  assertEquals(shaun.includes("Operations Coordinator"), true);
  assertEquals(shaun.includes("mailto:shaun@secureworkswa.com.au"), true);
  assertEquals(
    shaun.includes(
      'href="tel:0489267771" style="color:rgb(76,106,124); text-decoration:none; margin-top:0px; margin-bottom:0px">0489 267 771</a>',
    ),
    true,
  );
  assertEquals(shaun.includes("admin@secureworkswa.com.au"), false);
  assertEquals(shaun.includes("Operations Manager"), false);
  assertEquals(shaun.includes("ses@"), false);
  const jan = getSignature("jan@secureworkswa.com.au");
  assertEquals(jan.includes("Jan Cloete"), true);
  assertEquals(jan.includes("Jan Stobbe"), false);
  assertEquals(jan.includes("Director"), true);
  assertEquals(jan.includes("0417 976 471"), true);
  assertEquals(jan.includes("tel:0417976471"), true);
  assertEquals(jan.includes("jan@secureworkswa.com.au"), true);
  for (const html of [marnin, company, shaun, jan]) {
    // Values copied from Marnin's phone signature (20 Oct 2026 12:43 AWST).
    assertEquals(html.includes("font-family:Aptos,Aptos_MSFontService,-apple-system,Roboto,Arial,Helvetica,sans-serif; font-size:12pt; color:rgb(0,0,0)"), true);
    assertEquals(html.includes("line-height:1.6; text-transform:none; margin-top:24px\"><span style=\"font-family:Calibri,Helvetica,sans-serif; font-size:11pt; color:rgb(41,60,70)\">Kind regards,</span>"), true);
    assertEquals(html.includes("margin-top:28px; padding-top:20px; border-top:2px solid rgb(241,90,41); max-width:400px"), true);
    assertEquals(html.includes("padding:20px"), false);
    assertEquals(html.includes("margin:0px 0px 2px; font-size:14px; color:rgb(41,60,70)\"><span style=\"font-family:Helvetica,Arial,sans-serif\"><b>"), true);
    assertEquals(html.includes("margin:0px 0px 10px; font-size:12px; color:rgb(76,106,124)"), true);
    assertEquals(html.includes("margin:0px 0px 10px; letter-spacing:1.5px; font-size:10px; font-weight:600; color:rgb(41,60,70)\"><span style=\"letter-spacing:1.5px; font-family:Helvetica,Arial,sans-serif\">EXCELLENCE &nbsp;|&nbsp; INTEGRITY &nbsp;|&nbsp; SERVICE</span>"), true);
    assertEquals(html.includes("EXCELLENCE | INTEGRITY | SERVICE"), false);
    assertEquals(html.includes("line-height:20px; text-transform:none; margin:0px; font-size:12px; color:rgb(76,106,124)"), true);
    assertEquals(html.includes("line-height:1.3; font-family:Calibri,sans-serif; font-size:12pt; color:black\"><br></div>"), true);
    assertEquals(html.includes("text-decoration:underline"), false);
    assertEquals(html.includes(`width="180"`), true);
    assertEquals(html.includes(`cid:${SIGNATURE_LOGO_CID}`), true);
  }
});

Deno.test("a chosen signature replaces the mailbox default and none suppresses it", () => {
  const admin = "admin@secureworkswa.com.au";
  const asShaun = composeSignedHtml("<p>Hi</p>", admin, "shaun");
  assertEquals(asShaun.includes("Shaun Lee"), true);
  assertEquals(asShaun.includes("Operations Coordinator"), true);
  assertEquals(asShaun.includes("mailto:admin@secureworkswa.com.au"), true);
  assertEquals(asShaun.includes("0489 267 771"), true);
  assertEquals(asShaun.includes("Maverick"), false);
  assertEquals(asShaun.includes('data-secureworks-signature="shaun"'), true);
  assertEquals(
    (asShaun.match(/data-secureworks-signature=/g) || []).length,
    1,
  );
  const asCompany = composeSignedHtml("<p>Hi</p>", admin, "secureworks");
  assertEquals(asCompany.includes('data-secureworks-signature="secureworks"'), true);
  assertEquals(asCompany.includes("<b>SecureWorks Group</b>"), true);
  assertEquals(asCompany, composeSignedHtml("<p>Hi</p>", admin, undefined));
  const asMaverick = composeSignedHtml("<p>Hi</p>", admin, "maverick");
  assertEquals(asMaverick.includes("Maverick"), true);
  assertEquals(asMaverick.includes("Operations Assist"), true);
  assertEquals(asMaverick.includes("Shaun Lee"), false);
  const cased = composeSignedHtml(
    "<p>Hi</p>",
    "Admin@SecureWorksWA.com.au",
    "Shaun",
  );
  assertEquals(cased.includes("Shaun Lee"), true);
  assertEquals(cased.includes("mailto:admin@secureworkswa.com.au"), true);
  assertEquals(
    composeSignedHtml("<p>Hi</p>", "hugo@secureworkswa.com.au", "none"),
    "<p>Hi</p>",
  );
  const marked = "<p>Hi</p><!-- suppress-auto-appended-default-signature -->";
  assertEquals(composeSignedHtml(marked, admin, undefined), marked);
  assertEquals(composeSignedHtml(marked, admin, "   "), marked);
  assertEquals(
    composeSignedHtml("<p>Hi</p>", "marnin@secureworkswa.com.au", "none"),
    "<p>Hi</p>",
  );
  assertEquals(
    composeSignedHtml("<p>Hi</p>", "marnin@secureworkswa.com.au", "suppress"),
    "<p>Hi</p>",
  );
  const namedOverMarker = composeSignedHtml(marked, admin, "shaun");
  assertEquals(namedOverMarker.includes("Shaun Lee"), true);
  assertEquals(namedOverMarker.includes("Maverick"), false);
  const fencing = getSignature("fencing@secureworkswa.com.au");
  assertEquals(fencing.includes("08 6102 2796"), true);
  assertEquals(fencing.includes("fencing@secureworkswa.com.au"), true);
  const unknown = assertThrows(
    () => composeSignedHtml("<p>Hi</p>", admin, "captain"),
    OutlookInputError,
    "Choose secureworks, shaun, maverick, none.",
  );
  assertEquals(unknown.code, "invalid_signature");
  assertEquals(unknown.message.includes("captain"), false);
  const asJan = composeSignedHtml("<p>Hi</p>", "jan@secureworkswa.com.au", "jan");
  assertEquals(asJan.includes("Jan Cloete"), true);
  assertEquals(asJan.includes("0417 976 471"), true);
  assertEquals(asJan.includes("jan@secureworkswa.com.au"), true);
  const refused = [
    ["marnin@secureworkswa.com.au", "shaun", "Choose marnin, none."],
    ["jan@secureworkswa.com.au", "marnin", "Choose jan, none."],
    ["shaun@secureworkswa.com.au", "maverick", "Choose shaun, none."],
    ["fencing@secureworkswa.com.au", "patios", "Choose fencing, none."],
    ["patios@secureworkswa.com.au", "fencing", "Choose patios, none."],
    ["hugo@secureworkswa.com.au", "marnin", "Choose none."],
    ["admin@secureworkswa.com.au", "marnin", "Choose secureworks, shaun, maverick, none."],
  ] as const;
  for (const [mailbox, signature, hint] of refused) {
    const error = assertThrows(
      () => composeSignedHtml("<p>Hi</p>", mailbox, signature),
      OutlookInputError,
      hint,
    );
    assertEquals(error.code, "invalid_signature");
    assertEquals(error.message.toLowerCase().includes(signature), false);
  }
  const notString = assertThrows(
    () => composeSignedHtml("<p>Hi</p>", admin, 1),
    OutlookInputError,
    "signature must be a string",
  );
  assertEquals(notString.code, "invalid_signature");
});

Deno.test("inline attachment metadata is kept and normalised", async () => {
  const inline = validateInlineAttachment({
    name: "logo.png",
    contentType: "image/png",
    contentBytes: "AA==",
    isInline: true,
    contentId: "cid:<logo@secureworkswa.com.au>",
  });
  assertEquals(inline.isInline, true);
  assertEquals(inline.contentId, "logo@secureworkswa.com.au");
  const implied = validateInlineAttachment({
    name: "logo.png",
    contentType: "image/png",
    contentBytes: "AA==",
    contentId: "logo@secureworkswa.com.au",
  });
  assertEquals(implied.isInline, true);
  assertEquals(implied.contentId, "logo@secureworkswa.com.au");
  const explicitOff = validateInlineAttachment({
    name: "file.txt",
    contentBytes: "AA==",
    isInline: false,
    contentId: "file@secureworkswa.com.au",
  });
  assertEquals(explicitOff.isInline, false);
  assertEquals(explicitOff.contentId, "file@secureworkswa.com.au");
  assertThrows(
    () =>
      validateInlineAttachment({
        name: "logo.png",
        contentBytes: "AA==",
        isInline: true,
      }),
    OutlookInputError,
    "requires contentId",
  );
  assertThrows(
    () =>
      validateInlineAttachment({
        name: "logo.png",
        contentBytes: "AA==",
        isInline: "yes",
        contentId: "logo@secureworkswa.com.au",
      }),
    OutlookInputError,
    "must be a boolean",
  );
  assertThrows(
    () =>
      validateInlineAttachment({
        name: "logo.png",
        contentBytes: "AA==",
        isInline: true,
        contentId: "not a token",
      }),
    OutlookInputError,
    "not a valid token",
  );
  const fetchImpl = async (): Promise<Response> =>
    new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
  const fromUrl = await prepareAttachments([{
    url: "https://fixtures.test/logo.png",
    name: "logo.png",
    isInline: true,
    contentId: "cid:<fetched@secureworkswa.com.au>",
  }], {
    fetchImpl,
    allowedHosts: ["fixtures.test"],
  });
  assertEquals(fromUrl[0].contentType, "image/png");
  assertEquals(fromUrl[0].isInline, true);
  assertEquals(fromUrl[0].contentId, "fetched@secureworkswa.com.au");
  assertEquals(fromUrl[0].contentBytes, "AQIDBA==");
  const jpeg = validateInlineAttachment({
    name: "photo.jpg",
    contentType: "image/jpeg",
    contentBytes: "AA==",
    isInline: true,
    contentId: "photo@secureworkswa.com.au",
  });
  assertEquals(jpeg.isInline, true);
  assertThrows(
    () =>
      validateInlineAttachment({
        name: "note.txt",
        contentType: "text/plain",
        contentBytes: "AA==",
        isInline: true,
        contentId: "note@secureworkswa.com.au",
      }),
    OutlookInputError,
    "only allowed for an image",
  );
  assertThrows(
    () =>
      validateInlineAttachment({
        name: "file.pdf",
        contentType: "application/pdf",
        contentBytes: "AA==",
        isInline: true,
        contentId: "file@secureworkswa.com.au",
      }),
    OutlookInputError,
    "only allowed for an image",
  );
  const reserved = assertThrows(
    () =>
      validateInlineAttachment({
        name: "logo.png",
        contentType: "image/png",
        contentBytes: "AA==",
        isInline: true,
        contentId: `cid:<${SIGNATURE_LOGO_CID}>`,
      }),
    OutlookInputError,
    "reserved signature logo content id",
  );
  assertEquals(reserved.code, "invalid_attachment");
  assertEquals(reserved.message.includes(SIGNATURE_LOGO_CID), false);
  await assertRejects(
    () =>
      prepareAttachments([{
        url: "https://fixtures.test/file.pdf",
        name: "file.pdf",
        isInline: true,
        contentId: "file@secureworkswa.com.au",
      }], { fetchImpl, allowedHosts: ["fixtures.test"] }),
    OutlookInputError,
    "only allowed for an image",
  );
});

Deno.test("the signature logo is one CID attachment and only when the HTML asks for it", () => {
  const plain = withSignatureLogo("<p>Hi</p>", []);
  assertEquals(plain, []);
  const once = withSignatureLogo(`<img src="cid:${SIGNATURE_LOGO_CID}">`, []);
  assertEquals(once.length, 1);
  assertEquals(once[0].isInline, true);
  assertEquals(once[0].contentId, SIGNATURE_LOGO_CID);
  assertEquals(once[0].contentType, "image/png");
  assertEquals(once[0].name, "secureworks-logo.png");
  const again = withSignatureLogo(
    `cid:${SIGNATURE_LOGO_CID}`,
    once,
  );
  assertEquals(again.length, 1);
  assertEquals(again[0].contentId, SIGNATURE_LOGO_CID);
  const replaced = withSignatureLogo(`cid:${SIGNATURE_LOGO_CID}`, [{
    "@odata.type": "#microsoft.graph.fileAttachment",
    name: "caller-logo.png",
    contentType: "image/png",
    contentBytes: "AAAA",
    isInline: true,
    contentId: SIGNATURE_LOGO_CID.toUpperCase(),
  }]);
  assertEquals(replaced.length, 1);
  assertEquals(replaced[0].contentBytes, once[0].contentBytes);
  assertEquals(replaced[0].contentBytes === "AAAA", false);
  assertEquals(withSignatureLogo("<p>Hi</p>", replaced), []);
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
    const attachmentCalls = calls.filter((call) =>
      call.url.endsWith("/reply-draft-1/attachments")
    );
    assertEquals(attachmentCalls.length, 2);
    const logo = JSON.parse(attachmentCalls[0].body!);
    const review = JSON.parse(attachmentCalls[1].body!);
    assertEquals(logo.name, "secureworks-logo.png");
    assertEquals(logo.isInline, true);
    assertEquals(logo.contentId, SIGNATURE_LOGO_CID);
    assertEquals(review.name, "review.txt");
    assertEquals(review.isInline, undefined);
    const createBody = JSON.parse(
      calls.find((call) => call.url.endsWith("/createReply"))!.body!,
    );
    assertEquals(createBody.message.toRecipients, undefined);
    assertEquals(createBody.message.ccRecipients, undefined);
    const html = createBody.message.body.content as string;
    assertEquals(html.includes('data-secureworks-signature="secureworks"'), true);
    assertEquals(html.includes("Maverick"), false);
    assertEquals(html.includes("Shaun Lee"), false);
    assertEquals(html.includes("admin@secureworkswa.com.au"), true);
    assertEquals(html.includes("0489 267 771"), true);
    assertEquals(html.includes(`cid:${SIGNATURE_LOGO_CID}`), true);
    assertEquals(html.includes("ses@secureworkswa.com.au"), false);
    assertEquals(html.includes("data:image"), false);
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

Deno.test("reply signature shaun replaces Maverick and none sends no logo", async () => {
  Deno.env.set("MICROSOFT_TENANT_ID", "tenant-sig-fixture");
  Deno.env.set("MICROSOFT_CLIENT_ID", "client-sig-fixture");
  Deno.env.set("MICROSOFT_CLIENT_SECRET", "secret-sig-fixture");
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
        return Response.json({ access_token: "sig-token", expires_in: 3600 });
      }
      if (url.endsWith("/createReply")) {
        return Response.json({
          id: "reply-draft-sig",
          toRecipients: [{ emailAddress: { address: "client@example.com" } }],
          ccRecipients: [],
        }, { status: 201 });
      }
      if (url.endsWith("/attachments")) {
        return Response.json({ id: "attachment-sig" }, { status: 201 });
      }
      if (url.endsWith("/send")) return new Response(null, { status: 202 });
      return new Response("unexpected provider call", { status: 500 });
    }) as typeof fetch;
  const base = {
    action: "reply",
    mailbox: "admin@secureworkswa.com.au",
    message_id: "source-message-sig",
    job_id: "job-sig",
    htmlBody: "<p>Reviewed reply</p>",
    content_reviewed: true,
    expected_to: ["client@example.com"],
    expected_cc: [],
  };
  try {
    await handleReply({ ...base, signature: "shaun" });
    const shaunHtml = JSON.parse(
      calls.find((call) => call.url.endsWith("/createReply"))!.body!,
    ).message.body.content as string;
    assertEquals(shaunHtml.includes("Shaun Lee"), true);
    assertEquals(shaunHtml.includes("mailto:admin@secureworkswa.com.au"), true);
    assertEquals(shaunHtml.includes("0489 267 771"), true);
    assertEquals(shaunHtml.includes("Maverick"), false);
    assertEquals(
      calls.filter((call) => call.url.endsWith("/attachments")).length,
      1,
    );
    calls.length = 0;
    await handleReply({
      ...base,
      htmlBody:
        "<p>Reviewed reply</p><!-- suppress-auto-appended-default-signature -->",
    });
    const suppressed = JSON.parse(
      calls.find((call) => call.url.endsWith("/createReply"))!.body!,
    ).message.body.content as string;
    assertEquals(suppressed.includes("data-secureworks-signature"), false);
    assertEquals(
      calls.filter((call) => call.url.endsWith("/attachments")).length,
      0,
    );
    calls.length = 0;
    await handleReply({ ...base, signature: "none" });
    assertEquals(
      calls.filter((call) => call.url.endsWith("/attachments")).length,
      0,
    );
  } finally {
    globalThis.fetch = originalFetch;
    resetGraphTokenCache();
  }
});

Deno.test("an unknown reply signature refuses before any provider call", async () => {
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = (async () => {
    providerCalls++;
    return new Response("provider must not be called", { status: 500 });
  }) as typeof fetch;
  try {
    const error = await assertRejects(
      () =>
        handleReply({
          action: "reply",
          mailbox: "admin@secureworkswa.com.au",
          message_id: "source-message-bad-sig",
          htmlBody: "<p>Reviewed reply</p>",
          content_reviewed: true,
          expected_to: ["client@example.com"],
          expected_cc: [],
          signature: "not-a-person",
        }),
      OutlookInputError,
      "Choose secureworks, shaun, maverick, none.",
    );
    assertEquals((error as OutlookInputError).code, "invalid_signature");
    assertEquals(providerCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("a draft from admin as shaun carries Shaun's block and the inline logo", async () => {
  Deno.env.set("MICROSOFT_TENANT_ID", "tenant-draft-shaun");
  Deno.env.set("MICROSOFT_CLIENT_ID", "client-draft-shaun");
  Deno.env.set("MICROSOFT_CLIENT_SECRET", "secret-draft-shaun");
  resetGraphTokenCache();
  let posted = "";
  const originalFetch = globalThis.fetch;
  globalThis.fetch =
    (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/oauth2/v2.0/token")) {
        return Response.json({
          access_token: "draft-shaun-token",
          expires_in: 3600,
        });
      }
      if (url.endsWith("/messages")) {
        posted = typeof init?.body === "string" ? init.body : "";
        return Response.json({ id: "draft-shaun", changeKey: "ck-shaun" }, {
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
      subject: "From Shaun",
      htmlBody: "<p>Hello</p>",
      content_reviewed: true,
      signature: "shaun",
    });
    assertEquals(response.status, 202);
    const message = JSON.parse(posted);
    const html = message.body.content as string;
    assertEquals(html.includes("Shaun Lee"), true);
    assertEquals(html.includes("Operations Coordinator"), true);
    assertEquals(html.includes("mailto:admin@secureworkswa.com.au"), true);
    assertEquals(html.includes("0489 267 771"), true);
    assertEquals(html.includes("Maverick"), false);
    assertEquals(message.attachments.length, 1);
    assertEquals(message.attachments[0].isInline, true);
    assertEquals(message.attachments[0].contentId, SIGNATURE_LOGO_CID);
    assertEquals(message.attachments[0].contentType, "image/png");
  } finally {
    globalThis.fetch = originalFetch;
    resetGraphTokenCache();
  }
});

// ── One sign-off per email ──────────────────────────────────────────────────

const SIGN_OFF_COUNT_RE =
  /\b(?:kind(?:est)? regards|warm regards|best regards|regards|cheers|many thanks)\b/gi;

function signOffCount(html: string): number {
  const text = html.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ");
  return (text.match(SIGN_OFF_COUNT_RE) || []).length;
}

Deno.test("a body that already signs off gets the card without another Kind regards", () => {
  const admin = "admin@secureworkswa.com.au";
  const signedBodies = [
    "<p>Hi Alex,</p><p>All booked in.</p><p>Cheers,<br>Shaun</p>",
    "<p>Hi Alex,</p><p>All booked in.</p><p>Cheers, Shaun</p>",
    "<p>All booked.</p><p>Kind regards,</p><p>Marnin Stobbe</p><p>SecureWorks Group</p>",
    "<div>All booked.<br><br>kind regards,<br>Marnin</div>",
    "<p>All booked.</p><p>Thanks!</p>",
    "<p>All booked.</p><p>Many thanks,</p>",
    "<p>All booked.</p><p>Warm regards,<br>The SecureWorks Group Team</p>",
    "<p>All booked.</p><p>Best,<br>Jan</p>",
    "<p>All booked.</p><p>Regards, Planning</p>",
    "All booked.\n\nThank you,\nShaun Lee\nSecureWorks Group",
    "<p>All booked.</p><p>Cheers,&nbsp;<br>Shaun</p><!-- note -->",
  ];
  for (const body of signedBodies) {
    assertEquals(bodyEndsWithSignOff(body), true, body);
    for (const signature of [undefined, "shaun", "maverick", "secureworks"]) {
      const html = composeSignedHtml(body, admin, signature);
      assertEquals(html.includes("Kind regards,</span>"), false, body);
      assertEquals(html.includes("data-secureworks-signature="), true);
      assertEquals(html.includes("EXCELLENCE &nbsp;|&nbsp; INTEGRITY"), true);
    }
  }
});

Deno.test("a plain body gets exactly one Kind regards from the card", () => {
  const plainBodies = [
    "<p>Hi Alex,</p><p>All booked in for Tuesday.</p>",
    "<p>Thanks for your help today.</p>",
    "<p>Thank you for your business</p>",
    "<p>Hi Alex,</p><p>Thanks Alex!</p>",
    "<p>Thanks, see you on Monday.</p>",
    "<p>Best price we can do is $500.</p>",
    "<p>Regards to the team, we start Monday.</p><p>Please confirm</p>",
    "",
  ];
  for (const body of plainBodies) {
    assertEquals(bodyEndsWithSignOff(body), false, body);
    for (
      const mailbox of [
        "admin@secureworkswa.com.au",
        "marnin@secureworkswa.com.au",
        "shaun@secureworkswa.com.au",
      ]
    ) {
      const html = composeSignedHtml(body, mailbox, undefined);
      assertEquals(
        (html.match(/Kind regards,<\/span>/g) || []).length,
        1,
        body,
      );
    }
  }
  // The v2 card itself is unchanged apart from the optional sign-off line.
  const full = getSignature("marnin@secureworkswa.com.au");
  const bare = composeSignedHtml(
    "<p>x</p><p>Cheers,<br>Marnin</p>",
    "marnin@secureworkswa.com.au",
    undefined,
  ).slice("<p>x</p><p>Cheers,<br>Marnin</p>".length);
  const signOffBlock =
    `<div style="max-width:680px"><p style="text-align:left; text-indent:0px; line-height:1.6; text-transform:none; margin-top:24px"><span style="font-family:Calibri,Helvetica,sans-serif; font-size:11pt; color:rgb(41,60,70)">Kind regards,</span></p></div>`;
  assertEquals(full.replace(signOffBlock, ""), bare);
});

Deno.test("a company statement email has exactly one sign-off, signed by Shaun", () => {
  const html = statementHtml({
    company_name: "Example Builders",
    week_start: "2026-10-05",
    lines: [{
      xero_invoice_id: "x1",
      invoice_number: "INV-1",
      job_ref: "SWMS-1, 1 Example Road",
      invoice_date: "2026-09-01",
      amount: 300,
      days_overdue: 27,
      pay_link: "https://in.xero.com/a",
    }],
  });
  assertEquals(signOffCount(html), 0);
  const sent = composeSignedHtml(
    html,
    DEBT_WS_STATEMENT_FROM,
    DEBT_WS_STATEMENT_SIGNATURE,
  );
  assertEquals(signOffCount(sent), 1);
  assertEquals(sent.includes("<b>Shaun Lee</b>"), true);
  assertEquals(sent.includes("mailto:admin@secureworkswa.com.au"), true);
  assertEquals(sent.includes("Maverick"), false);
});

Deno.test("work order variation emails have exactly one sign-off", () => {
  const emails = buildVariationEmails({
    jobNumber: "SWF-26123",
    siteSuburb: "Duncraig",
    woNumber: "WO-SWF-26123",
    tradeName: "Trade One",
    invoiceNumber: "TI-1",
    description: "Extra post, rock found",
    amountEx: 120,
    figures: null,
  });
  assertEquals(emails.length, 2);
  for (const email of emails) {
    const sent = composeSignedHtml(
      email.body_html,
      WORK_ORDER_VARIATION_SENDER_MAILBOX,
      undefined,
    );
    assertEquals(signOffCount(sent), 1);
    assertEquals(
      (sent.match(/SecureWorks Group/g) || []).length,
      2, // the card name and the logo alt text, no closing line in the body
    );
  }
});
