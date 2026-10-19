// A redacted one-line summary of a failed send-outlook-email reply.
//
// A reply body can carry provider text: Graph's error message, recipient
// addresses, an exception message. None of it may reach an error response or a
// stored error column. The summary keeps only the status and the reply's own
// machine fields (`code`, `state`, `retry_safe`), and only when each is a short
// identifier, so free text can never ride along under one of those names.

const IDENTIFIER = /^[A-Za-z0-9_.:-]{1,64}$/;

function identifierOrNull(value: unknown): string | null {
  return typeof value === "string" && IDENTIFIER.test(value) ? value : null;
}

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
  const code = identifierOrNull(reply?.code);
  const state = identifierOrNull(reply?.state);
  if (code) parts.push(`code=${code}`);
  if (state) parts.push(`state=${state}`);
  if (typeof reply?.retry_safe === "boolean") parts.push(`retry_safe=${reply.retry_safe}`);
  if (!reply && bodyText) parts.push("reply not JSON");
  return parts.join(" ");
}
