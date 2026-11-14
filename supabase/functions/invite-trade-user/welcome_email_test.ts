// deno-lint-ignore-file no-import-prefix

import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildTradeWelcomeEmail,
  sendTradeWelcomeEmail,
  TRADE_APP_URL,
  TRADE_WELCOME_PAGE_URL,
  TRADE_WELCOME_SENDER_MAILBOX,
  tradeFirstName,
} from "./welcome_email.ts";

Deno.test("greets by first name, and greets nobody by a handle", () => {
  assertEquals(tradeFirstName("james spackman"), "James");
  assertEquals(tradeFirstName("  Ruan  "), "Ruan");
  assertEquals(tradeFirstName("jonathan.482"), "");
  assertEquals(tradeFirstName("someone@example.com"), "");
  assertEquals(tradeFirstName(null), "");
  assertStringIncludes(
    buildTradeWelcomeEmail({ name: "James Spackman" }).htmlBody,
    "<p>Hi James,</p>",
  );
  assertStringIncludes(
    buildTradeWelcomeEmail({ name: "jonathan.482" }).htmlBody,
    "<p>Hi,</p>",
  );
});

Deno.test("carries the video link, the app link, the steps and the amount box warning", () => {
  const email = buildTradeWelcomeEmail({ name: "Sam Sample" });
  assertEquals(
    email.subject,
    "Welcome to SecureWorks: getting started with the trade app",
  );
  assertStringIncludes(email.htmlBody, `href="${TRADE_WELCOME_PAGE_URL}"`);
  assertStringIncludes(email.htmlBody, `href="${TRADE_APP_URL}"`);
  assertEquals((email.htmlBody.match(/<li>/g) ?? []).length, 6);
  assertStringIncludes(email.htmlBody, "Pay, then Weekly Invoice");
  assertStringIncludes(email.htmlBody, "No details, no pay.");
  assertStringIncludes(
    email.htmlBody,
    "takes money <strong>off</strong> your invoice",
  );
  // The email never states a pay rate or any amount of money.
  assert(!/\$\s?\d/.test(email.htmlBody));
  // send-outlook-email adds the one sign-off; the body carries none.
  assert(!/regards|cheers/i.test(email.htmlBody));
});

Deno.test("a name cannot inject markup into the email", () => {
  const email = buildTradeWelcomeEmail({ name: "<b>Bob</b> Smith" });
  assert(!email.htmlBody.includes("<b>Bob</b>"));
  assertStringIncludes(email.htmlBody, "&lt;b&gt;Bob&lt;/b&gt;");
});

Deno.test("sends once from admin@ through send-outlook-email with the service key", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchStub = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as unknown as typeof fetch;
  const result = await sendTradeWelcomeEmail(
    "https://example.supabase.co",
    "service-key",
    "new.trade@example.com",
    "Sam Sample",
    fetchStub,
  );
  assertEquals(result, { ok: true });
  assertEquals(calls.length, 1);
  assertEquals(
    calls[0].url,
    "https://example.supabase.co/functions/v1/send-outlook-email",
  );
  const headers = calls[0].init.headers as Record<string, string>;
  assertEquals(headers.Authorization, "Bearer service-key");
  assertEquals(headers.apikey, "service-key");
  const body = JSON.parse(String(calls[0].init.body));
  assertEquals(body.mailbox, TRADE_WELCOME_SENDER_MAILBOX);
  assertEquals(body.to, "new.trade@example.com");
  assertStringIncludes(body.htmlBody, "Hi Sam,");
});

Deno.test("a refused or failed send is reported, never thrown", async () => {
  const refused = await sendTradeWelcomeEmail(
    "https://example.supabase.co",
    "service-key",
    "new.trade@example.com",
    "Sam",
    (() =>
      Promise.resolve(
        new Response("mailbox not verified", { status: 403 }),
      )) as unknown as typeof fetch,
  );
  assertEquals(refused, {
    ok: false,
    error: "send-outlook-email 403: mailbox not verified",
  });
  const down = await sendTradeWelcomeEmail(
    "https://example.supabase.co",
    "service-key",
    "new.trade@example.com",
    "Sam",
    (() => Promise.reject(new Error("network down"))) as unknown as typeof fetch,
  );
  assertEquals(down, {
    ok: false,
    error: "send-outlook-email failed: network down",
  });
});
