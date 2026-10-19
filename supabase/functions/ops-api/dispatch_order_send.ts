// deno-lint-ignore-file no-explicit-any
// Dispatch slice 5: the supplier email as Resend receives it, and what Resend's
// answer means. Contract: docs/dispatch-slice-5-contract.md, section "Sending".
//
// The transport is passed in, so tests stub it and nothing here can reach the
// network on its own. One address only; no CC, no BCC.
//
// Resend's own documentation (read 14 Oct 2026,
// resend.com/docs/dashboard/emails/idempotency-keys): an `Idempotency-Key`
// header of 1 to 256 characters is kept 24 hours; a repeat with the same key
// and the same payload answers the first answer and sends nothing; the same
// key with a different payload is 409 `invalid_idempotent_request`; a repeat
// while the first is still running is 409 `concurrent_idempotent_requests`.
// Both 409s mean the first may have gone, so they read as "not confirmed",
// never as refused. The draft claim (dispatch_orders_store.ts) is the
// guarantee either way; the key only makes a person's retry safe.

import { poEmailReferenceBanner } from "../_shared/po_reference.ts";
import { ClientInputError } from "./client_input_error.ts";

export const DISPATCH_ORDERS_ADDRESS = "orders@secureworksgroup.app";
export const DISPATCH_ORDERS_FROM =
  `SecureWorks Group <${DISPATCH_ORDERS_ADDRESS}>`;
export const DISPATCH_RESEND_URL = "https://api.resend.com/emails";
export const DISPATCH_SEND_TIMEOUT_MS = 20_000;

// The tagged reply address receive-po-email parses back to the order and job.
export function dispatchReplyToAddress(
  poNumber: string,
  jobNumber: string | null,
): string {
  const tag = jobNumber ? `${poNumber}-${jobNumber}` : poNumber;
  return `orders+${tag}@secureworksgroup.app`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// The message as paragraphs, after the reference banner, with the signature
// block and the order and job references.
export function dispatchEmailHtml(input: {
  bodyText: string;
  poNumber: string | null;
  jobNumber: string | null;
}): string {
  const paragraphs = input.bodyText.split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) =>
      `<p style="margin:0 0 12px 0;">${
        escapeHtml(block).replace(/\n/g, "<br>")
      }</p>`
    )
    .join("\n");
  const refs = [
    input.poNumber ? `Purchase order ${escapeHtml(input.poNumber)}` : null,
    input.jobNumber ? `Job ${escapeHtml(input.jobNumber)}` : null,
  ].filter(Boolean).join(" · ");
  const banner = input.jobNumber ? poEmailReferenceBanner(input.jobNumber) : "";
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#293C46;line-height:1.5;">
${banner}
${paragraphs}
<div style="border-top:1px solid #D9E1E6;margin-top:16px;padding-top:10px;font-size:12px;color:#4C6A7C;">
<strong>SecureWorks Group</strong><br>${refs}
</div>
</div>`;
}

// A Message-ID is `<...@...>`. Resend's own email id is not one, so it is
// never put in In-Reply-To or References.
export function isRfcMessageId(value: unknown): value is string {
  return typeof value === "string" &&
    /^<?[^<>\s@]+@[^<>\s@]+>?$/.test(value.trim());
}

function asMessageId(value: string): string {
  const v = value.trim();
  return v.startsWith("<") ? v : `<${v}>`;
}

export type DispatchEmailPayload = {
  from: string;
  to: [string];
  reply_to: string;
  subject: string;
  html: string;
  text: string;
  attachments?: Array<{ filename: string; content: string }>;
  headers?: Record<string, string>;
};

// The one payload. Deterministic: the same draft gives the same payload, so a
// retry under the same idempotency key is the same request.
export function buildDispatchEmail(input: {
  to: string;
  subject: string;
  bodyText: string;
  // Null for a reply on a supplier thread no order is linked to: the reply
  // then carries the plain orders address, since a tag needs an order number.
  poNumber: string | null;
  jobNumber: string | null;
  pdf?: { fileName: string; base64: string } | null;
  inReplyTo?: string | null;
}): DispatchEmailPayload {
  const payload: DispatchEmailPayload = {
    from: DISPATCH_ORDERS_FROM,
    to: [input.to],
    reply_to: input.poNumber
      ? dispatchReplyToAddress(input.poNumber, input.jobNumber)
      : DISPATCH_ORDERS_ADDRESS,
    subject: input.subject,
    html: dispatchEmailHtml({
      bodyText: input.bodyText,
      poNumber: input.poNumber,
      jobNumber: input.jobNumber,
    }),
    text: input.bodyText,
  };
  if (input.pdf) {
    payload.attachments = [{
      filename: input.pdf.fileName,
      content: input.pdf.base64,
    }];
  }
  if (isRfcMessageId(input.inReplyTo)) {
    const id = asMessageId(input.inReplyTo);
    payload.headers = { "In-Reply-To": id, "References": id };
  }
  return payload;
}

export type DispatchTransportAnswer = { status: number; body: any };
export type DispatchMailTransport = (request: {
  payload: DispatchEmailPayload;
  idempotencyKey: string;
}) => Promise<DispatchTransportAnswer>;

export type DispatchSendOutcome =
  | { kind: "sent"; id: string | null }
  | { kind: "refused"; reason: string }
  | { kind: "unknown"; reason: string };

function reasonFrom(body: any, status: number): string {
  const message = typeof body?.message === "string"
    ? body.message
    : typeof body?.error === "string"
    ? body.error
    : typeof body?.name === "string"
    ? body.name
    : "";
  return (message || `HTTP ${status}`).slice(0, 500);
}

// What Resend's answer means. 2xx: it went. 409 (an idempotency clash): the
// first may have gone, so unknown. Any other 4xx: refused, nothing went. 5xx:
// unknown.
export function classifyDispatchSend(
  answer: DispatchTransportAnswer,
): DispatchSendOutcome {
  const { status, body } = answer;
  if (status >= 200 && status < 300) {
    return { kind: "sent", id: typeof body?.id === "string" ? body.id : null };
  }
  if (status === 409) {
    return { kind: "unknown", reason: reasonFrom(body, status) };
  }
  if (status >= 400 && status < 500) {
    return { kind: "refused", reason: reasonFrom(body, status) };
  }
  return { kind: "unknown", reason: reasonFrom(body, status) };
}

// The transport, the outcome, and never a throw: a timeout or a network
// failure is a send whose result is unknown.
export async function runDispatchSend(
  transport: DispatchMailTransport,
  request: { payload: DispatchEmailPayload; idempotencyKey: string },
): Promise<DispatchSendOutcome> {
  try {
    return classifyDispatchSend(await transport(request));
  } catch (error) {
    return {
      kind: "unknown",
      reason: String((error as Error)?.message || error).slice(0, 500),
    };
  }
}

// The real transport: one POST to Resend, with the idempotency key.
export function resendDispatchTransport(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): DispatchMailTransport {
  return async ({ payload, idempotencyKey }) => {
    if (!apiKey) throw new ClientInputError("RESEND_API_KEY not configured");
    const response = await fetchImpl(DISPATCH_RESEND_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(DISPATCH_SEND_TIMEOUT_MS),
    });
    let body: any = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { status: response.status, body };
  };
}

export function dispatchBytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// One key per send attempt of a draft. A retry after an unknown result keeps
// the attempt (and so the key); only a refusal, where nothing went, moves on.
export function dispatchDraftIdempotencyKey(
  draftId: string,
  attempt = 1,
): string {
  return attempt > 1
    ? `dispatch-draft-${draftId}-a${attempt}`
    : `dispatch-draft-${draftId}`;
}

export function dispatchReplyIdempotencyKey(
  replyToMessageId: string,
  bodySha: string,
): string {
  return `dispatch-reply-${replyToMessageId}-${bodySha}`;
}

export function dispatchReplySubject(subject: unknown): string {
  const s = typeof subject === "string" ? subject.trim() : "";
  if (!s) return "Re: your email";
  return /^re:/i.test(s) ? s.slice(0, 300) : `Re: ${s}`.slice(0, 300);
}
