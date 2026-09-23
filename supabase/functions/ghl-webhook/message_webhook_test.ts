// Slice C1c: ghl-webhook no longer writes text messages. A message post is
// answered before the raw webhook_log write and never reaches the
// form-submission fallback; ghl-webhook-receiver is the one message door.
import {
  assert,
  assertEquals,
  assertFalse,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isMessageWebhook, messageWebhookAnswer } from "./message_webhook.ts";

Deno.test("InboundMessage and OutboundMessage are message webhooks; stage changes and forms are not", () => {
  assert(isMessageWebhook({ type: "InboundMessage", body: "hello" }));
  assert(isMessageWebhook({ type: "OutboundMessage" }));
  assertFalse(isMessageWebhook({ type: "OpportunityStageUpdate" }));
  assertFalse(
    isMessageWebhook({ first_name: "form", email: "x@example.test" }),
  );
  assertFalse(isMessageWebhook(null));
  assertEquals(messageWebhookAnswer().captured, false);
});

Deno.test("index.ts answers a message post before any write and has no message insert left", async () => {
  const source = await Deno.readTextFile(
    new URL("./index.ts", import.meta.url),
  );
  const answer = source.indexOf(
    "if (isMessageWebhook(body)) return jsonResponse(messageWebhookAnswer())",
  );
  const rawLog = source.indexOf("from('webhook_log').insert");
  const client = source.indexOf("const sb = createClient(");
  assert(answer > 0, "message posts are answered by the moved-capture reply");
  assert(
    answer < rawLog && answer < client,
    "answered before the client and the raw webhook_log write",
  );
  assertFalse(
    source.includes("from('business_events').insert"),
    "no business_events write left in ghl-webhook",
  );
  assertFalse(
    /esm\.sh\/@supabase\/supabase-js@2['"]/.test(source),
    "supabase-js is pinned to an exact version",
  );
});
