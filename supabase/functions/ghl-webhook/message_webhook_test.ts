// Slice C1c: ghl-webhook no longer writes text messages. A message post is
// answered before the raw webhook_log write and never reaches the
// form-submission fallback; ghl-webhook-receiver is the one message door.
import {
  assert,
  assertEquals,
  assertFalse,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { type GhlWebhookDeps, handleGhlWebhook } from "./handler.ts";
import { isMessageWebhook, messageWebhookAnswer } from "./message_webhook.ts";

const SECRET = "test-webhook-secret";

function postMessage(type: string): Request {
  return new Request("http://ghl-webhook.test/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Webhook-Secret": SECRET,
    },
    body: JSON.stringify({
      type,
      body: "hello",
      first_name: "form",
      email: "x@example.test",
    }),
  });
}

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

Deno.test("authenticated message posts are answered without a client or the form path", async () => {
  let clientCreated = 0;
  const deps: GhlWebhookDeps = {
    env: (name) => name === "GHL_WEBHOOK_SECRET" ? SECRET : undefined,
    createSupabase: () => {
      clientCreated += 1;
      throw new Error("form-submission path reached");
    },
  };

  for (const type of ["InboundMessage", "OutboundMessage"]) {
    const res = await handleGhlWebhook(postMessage(type), deps);
    assertEquals(res.status, 200);
    assertEquals(await res.json(), messageWebhookAnswer());
    assertEquals(res.headers.get("content-type"), "application/json");
  }
  assertEquals(clientCreated, 0);
});
