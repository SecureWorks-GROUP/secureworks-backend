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
  assertEquals(marnin.includes("0404 777 984"), true);
  assertEquals(getSignature("hugo@secureworkswa.com.au"), "");
  const company = getSignature("admin@secureworkswa.com.au");
  assertEquals(company.includes('data-secureworks-signature="secureworks"'), true);
  assertEquals(company.includes(">SecureWorks Group</p>"), true);
  assertEquals(company.includes("Maverick"), false);
  assertEquals(company.includes("Shaun Lee"), false);
  assertEquals(company.includes("admin@secureworkswa.com.au"), true);
  assertEquals(company.includes("+61 489 267 771"), true);
  assertEquals(company.includes(`cid:${SIGNATURE_LOGO_CID}`), true);
  assertEquals(company.includes("ses@secureworkswa.com.au"), false);
  assertEquals(company.includes("data:image"), false);
  const shaun = getSignature("shaun@secureworkswa.com.au");
  assertEquals(shaun.includes("Shaun Lee"), true);
  assertEquals(shaun.includes("Operations Coordinator"), true);
  assertEquals(shaun.includes("mailto:shaun@secureworkswa.com.au"), true);
  assertEquals(shaun.includes("+61 489 267 771"), false);
  assertEquals(shaun.includes(">P:</b>"), false);
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
    assertEquals(html.includes("border-top:2px solid #F15A29"), true);
    assertEquals(html.includes("EXCELLENCE"), true);
    assertEquals(html.includes(`cid:${SIGNATURE_LOGO_CID}`), true);
  }
});

Deno.test("a chosen signature replaces the mailbox default and none suppresses it", () => {
  const admin = "admin@secureworkswa.com.au";
  const asShaun = composeSignedHtml("<p>Hi</p>", admin, "shaun");
  assertEquals(asShaun.includes("Shaun Lee"), true);
  assertEquals(asShaun.includes("Operations Coordinator"), true);
  assertEquals(asShaun.includes("mailto:admin@secureworkswa.com.au"), true);
  assertEquals(asShaun.includes("+61 489 267 771"), true);
  assertEquals(asShaun.includes("Maverick"), false);
  assertEquals(asShaun.includes('data-secureworks-signature="shaun"'), true);
  assertEquals(
    (asShaun.match(/data-secureworks-signature=/g) || []).length,
    1,
  );
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
    "Choose shaun, maverick, none.",
  );
  assertEquals(unknown.code, "invalid_signature");
  assertEquals(unknown.message.includes("captain"), false);
  const refused = [
    ["marnin@secureworkswa.com.au", "shaun", "Choose marnin, none."],
    ["shaun@secureworkswa.com.au", "maverick", "Choose shaun, none."],
    ["hugo@secureworkswa.com.au", "marnin", "Choose none."],
    ["admin@secureworkswa.com.au", "secureworks", "Choose shaun, maverick, none."],
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
    assertEquals(html.includes("+61 489 267 771"), true);
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
    assertEquals(shaunHtml.includes("+61 489 267 771"), true);
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
      "Choose shaun, maverick, none.",
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
    assertEquals(html.includes("+61 489 267 771"), true);
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
