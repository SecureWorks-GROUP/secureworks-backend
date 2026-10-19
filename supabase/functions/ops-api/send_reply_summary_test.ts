import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { summariseSendReply } from "./send_reply_summary.ts";

Deno.test("send reply summary: keeps status and identifier fields only", () => {
  assertEquals(
    summariseSendReply(502, JSON.stringify({
      state: "outcome_unknown",
      code: "provider_outcome_unknown",
      retry_safe: false,
      error: "Graph request failed: 503 someone@example.com mailbox busy",
      detail: "raw provider text",
    })),
    "send-outlook-email 502 code=provider_outcome_unknown state=outcome_unknown retry_safe=false",
  );
});

Deno.test("send reply summary: free text under a machine field name reads 'unrecognised'", () => {
  const out = summariseSendReply(400, JSON.stringify({ code: "bad address someone@example.com", retry_safe: true }));
  assertEquals(out, "send-outlook-email 400 code=unrecognised retry_safe=true");
});

Deno.test("send reply summary: code and state come from closed sets", () => {
  const out = summariseSendReply(409, JSON.stringify({ code: "made_up_code", state: "mystery", retry_safe: false }));
  assertEquals(out, "send-outlook-email 409 code=unrecognised state=unrecognised retry_safe=false");
});

Deno.test("send reply summary: keeps a safe provider_status and provider_code", () => {
  const out = summariseSendReply(502, JSON.stringify({
    error: "Graph API error",
    status: 503,
    provider_status: 503,
    provider_code: "ErrorMailboxBusy",
    retry_safe: true,
  }));
  assertEquals(out, "send-outlook-email 502 retry_safe=true provider_status=503 provider_code=ErrorMailboxBusy");
});

Deno.test("send reply summary: an unsafe provider_status or provider_code is dropped", () => {
  const sentinel = "raw provider text that must not be echoed someone@example.com";
  for (const reply of [
    { provider_status: 99, provider_code: sentinel },
    { provider_status: 600, provider_code: "a@b" },
    { provider_status: "503", provider_code: "x".repeat(65) },
    { provider_status: 503.5, provider_code: 42 },
  ]) {
    const out = summariseSendReply(502, JSON.stringify(reply));
    assertEquals(out, "send-outlook-email 502");
  }
});

Deno.test("send reply summary: a non-JSON or missing body never echoes the body", () => {
  assertEquals(summariseSendReply(502, "<html>someone@example.com</html>"), "send-outlook-email 502 reply not JSON");
  assertEquals(summariseSendReply(null, null), "send-outlook-email no reply");
  assertEquals(summariseSendReply(500, ""), "send-outlook-email 500");
});
