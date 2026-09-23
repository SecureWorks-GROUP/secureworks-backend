// GHL message webhooks are no longer handled by this function (context build
// slice C1c; design sms.md §11 "at M1"). Texts and emails are saved only by
// ghl-webhook-receiver, through the one row builder and the one writer
// capture_business_event. A message post that still arrives here is answered
// with 200 and written nowhere: no evidence row, no raw webhook_log body, and
// never the form-submission fallback (which would treat a text as a lead).

const MESSAGE_TYPES: ReadonlySet<string> = new Set([
  "InboundMessage",
  "OutboundMessage",
]);

export function isMessageWebhook(body: unknown): boolean {
  const type = body && typeof body === "object"
    ? (body as { type?: unknown }).type
    : null;
  return typeof type === "string" && MESSAGE_TYPES.has(type);
}

/** The answer to a message post: received, not captured here, retried nowhere. */
export function messageWebhookAnswer(): {
  received: true;
  captured: false;
  reason: "message_capture_moved_to_ghl_webhook_receiver";
} {
  return {
    received: true,
    captured: false,
    reason: "message_capture_moved_to_ghl_webhook_receiver",
  };
}
