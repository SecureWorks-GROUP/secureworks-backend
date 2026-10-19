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

Deno.test("send reply summary: free text under a machine field name is dropped", () => {
  const out = summariseSendReply(400, JSON.stringify({ code: "bad address someone@example.com", retry_safe: true }));
  assertEquals(out, "send-outlook-email 400 retry_safe=true");
});

Deno.test("send reply summary: a non-JSON or missing body never echoes the body", () => {
  assertEquals(summariseSendReply(502, "<html>someone@example.com</html>"), "send-outlook-email 502 reply not JSON");
  assertEquals(summariseSendReply(null, null), "send-outlook-email no reply");
  assertEquals(summariseSendReply(500, ""), "send-outlook-email 500");
});
