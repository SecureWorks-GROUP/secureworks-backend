// deno-lint-ignore-file no-explicit-any no-import-prefix
// The request ops-api's client update text posts to ghl-proxy send_sms must
// carry ops-api's service login, and a refused send must say why. ghl-proxy
// refuses every request with no login (401 missing_auth); the calendar
// reschedule text sent none and failed silently. The fake below refuses a
// request with no login exactly as ghl-proxy does. Every send goes to an
// injected fetch: nothing reaches a live channel.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ghlProxySendSmsFailureReason,
  postGhlProxySendSms,
} from "./ghl_proxy_send_sms.ts";

type Call = { url: string; init?: any };
type Answer = { status: number; body: any } | Error;

function hasServiceLogin(init: any, bearer: string): boolean {
  const raw = init?.headers?.Authorization ?? init?.headers?.authorization;
  return typeof raw === "string" && raw === bearer;
}

function fakeGhlProxy(answer: Answer, bearer: string) {
  const calls: Call[] = [];
  const fetchFn = ((input: any, init?: any) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, init });
    if (url.includes("ghl-proxy") && !hasServiceLogin(init, bearer)) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            error: "Authentication required",
            code: "missing_auth",
          }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve(
      new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }) as typeof fetch;
  return { calls, fetchFn };
}

const SENT: Answer = { status: 200, body: { success: true, messageId: "m1" } };
const GHL_REFUSED: Answer = {
  status: 200,
  body: { success: false, error: "GHL API error" },
};

Deno.test("postGhlProxySendSms sends the service-role bearer and the payload", async () => {
  const { calls, fetchFn } = fakeGhlProxy(SENT, "Bearer svc-key");
  const res = await postGhlProxySendSms({
    supabaseUrl: "https://example.supabase.co",
    serviceKey: "svc-key",
    payload: { contactId: "ghl-1", message: "hi" },
    fetchFn,
  });
  assertEquals(res.sent, true);
  assertEquals(res.reason, null);
  assertEquals(calls.length, 1);
  assertEquals(
    calls[0].url,
    "https://example.supabase.co/functions/v1/ghl-proxy?action=send_sms",
  );
  assertEquals(calls[0].init.method, "POST");
  assertEquals(calls[0].init.headers.Authorization, "Bearer svc-key");
  assertEquals(JSON.parse(calls[0].init.body), {
    contactId: "ghl-1",
    message: "hi",
  });
});

Deno.test("postGhlProxySendSms: a refused login is not sent and names the refusal", async () => {
  const { fetchFn } = fakeGhlProxy(SENT, "Bearer the-real-key");
  const res = await postGhlProxySendSms({
    supabaseUrl: "https://example.supabase.co",
    serviceKey: "wrong-key",
    payload: { contactId: "ghl-1", message: "hi" },
    fetchFn,
  });
  assertEquals(res.sent, false);
  assertEquals(res.status, 401);
  assertEquals(res.reason, "Authentication required (HTTP 401)");
});

Deno.test("postGhlProxySendSms: an in-band GHL failure (HTTP 200 success:false) is not sent", async () => {
  const { fetchFn } = fakeGhlProxy(GHL_REFUSED, "Bearer k");
  const res = await postGhlProxySendSms({
    supabaseUrl: "https://x",
    serviceKey: "k",
    payload: { contactId: "c", message: "m" },
    fetchFn,
  });
  assertEquals(res.sent, false);
  assertEquals(res.reason, "GHL API error");
});

Deno.test("ghlProxySendSmsFailureReason falls back to the HTTP status", () => {
  assertEquals(ghlProxySendSmsFailureReason(502, null), "HTTP 502");
  assertEquals(
    ghlProxySendSmsFailureReason(409, { code: "contact_job_mismatch" }),
    "contact_job_mismatch (HTTP 409)",
  );
  assertEquals(
    ghlProxySendSmsFailureReason(200, {}),
    "Text not accepted by GHL",
  );
});
