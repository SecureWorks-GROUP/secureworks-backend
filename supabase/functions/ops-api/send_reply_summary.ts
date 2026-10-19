// A redacted one-line summary of a failed send-outlook-email reply.
//
// A reply body can carry provider text: Graph's error message, recipient
// addresses, an exception message. None of it may reach an error response or a
// stored error column. The summary keeps only the status and the reply's own
// machine fields: `code` and `state` from their closed sets (anything else
// reads 'unrecognised'), `retry_safe`, and the provider's `provider_status`
// (an HTTP status) and `provider_code` (a short identifier), so free text can
// never ride along under one of those names.

import { safeHttpStatus, safeIdentifier, sendReplyCode, sendReplyState } from "../_shared/safe_identifier.ts";

export function summariseSendReply(status: number | null, bodyText: string | null): string {
  let reply: Record<string, unknown> | null = null;
  if (bodyText) {
    try {
      const parsed = JSON.parse(bodyText);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) reply = parsed as Record<string, unknown>;
    } catch {
      reply = null;
    }
  }
  const parts = [`send-outlook-email ${status ?? "no reply"}`];
  const code = sendReplyCode(reply?.code);
  const state = sendReplyState(reply?.state);
  const providerStatus = safeHttpStatus(reply?.provider_status);
  const providerCode = safeIdentifier(reply?.provider_code);
  if (code) parts.push(`code=${code}`);
  if (state) parts.push(`state=${state}`);
  if (typeof reply?.retry_safe === "boolean") parts.push(`retry_safe=${reply.retry_safe}`);
  if (providerStatus !== null) parts.push(`provider_status=${providerStatus}`);
  if (providerCode) parts.push(`provider_code=${providerCode}`);
  if (!reply && bodyText) parts.push("reply not JSON");
  return parts.join(" ");
}
