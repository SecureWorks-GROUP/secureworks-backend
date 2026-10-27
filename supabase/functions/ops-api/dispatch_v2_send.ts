// deno-lint-ignore-file no-explicit-any
// Dispatch v2: the production sender for supplier order emails. It posts the
// email to this project's send-outlook-email function, the same Outlook send
// the make-safe packs use, from admin@secureworkswa.com.au, and reads back
// what happened. Contract: docs/dispatch-v2-emails-contract.md.
//
// Only dispatch_v2_send_email calls this, once per press. Tests never call
// it: they pass a fake sender instead.
//
// The request never carries a job_id: send-outlook-email files a job_id send
// as a client email, which a supplier order is not. The order itself is the
// record (dispatch_supplier_order_emails).

import type {
  DispatchV2OutlookPayload,
  DispatchV2Sender,
  DispatchV2SendOutcome,
  DispatchV2SentIds,
} from "./dispatch_v2_store.ts";

const SEND_TIMEOUT_MS = 60_000;

function idsFrom(body: any): DispatchV2SentIds | null {
  if (!body || typeof body !== "object") return null;
  const pick = (key: string) =>
    typeof body[key] === "string" && body[key] ? body[key] : null;
  const ids = {
    graph_message_id: pick("graph_message_id"),
    internet_message_id: pick("internet_message_id"),
    conversation_id: pick("conversation_id"),
  };
  return ids.graph_message_id || ids.internet_message_id || ids.conversation_id
    ? ids
    : null;
}

// What send-outlook-email's answer means:
//   202 with the ids              sent
//   retry_safe: true / sent:false not sent (input refused, fence refused,
//                                 Graph refused before sending)
//   state outcome_unknown, a 5xx  unknown: it may have gone
//   with no retry_safe, a timeout
//   or no answer at all
export function readDispatchV2SendAnswer(
  status: number,
  body: any,
): DispatchV2SendOutcome {
  const reason = String(body?.detail || body?.error || `status ${status}`)
    .slice(0, 500);
  if (status === 202 || (status >= 200 && status < 300)) {
    const ids = idsFrom(body);
    if (body?.accepted === true || body?.success === true) {
      return {
        kind: "sent",
        ids: ids ?? {
          graph_message_id: null,
          internet_message_id: null,
          conversation_id: null,
        },
      };
    }
    return { kind: "unknown", reason: "Outlook answered with no result", ids };
  }
  if (body?.state === "outcome_unknown") {
    return { kind: "unknown", reason, ids: idsFrom(body) };
  }
  if (body?.retry_safe === true || body?.sent === false) {
    return { kind: "refused", reason };
  }
  // A fence refusal (409 / 503 with state refused) never reached Outlook.
  if (body?.state === "refused" || status === 400 || status === 401) {
    return { kind: "refused", reason };
  }
  return { kind: "unknown", reason, ids: idsFrom(body) };
}

export function outlookDispatchV2Sender(options: {
  supabaseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}): DispatchV2Sender {
  const doFetch = options.fetchImpl ?? fetch;
  return async (payload: DispatchV2OutlookPayload) => {
    if (!options.supabaseUrl || !options.apiKey) {
      return {
        kind: "refused",
        reason: "The Outlook send is not set up on this server",
      };
    }
    let response: Response;
    try {
      response = await doFetch(
        `${options.supabaseUrl}/functions/v1/send-outlook-email`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": options.apiKey,
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        },
      );
    } catch (error) {
      // No answer: the request may or may not have reached Outlook.
      return {
        kind: "unknown",
        reason: `No answer from the Outlook send: ${
          (error as Error)?.message || error
        }`,
        ids: null,
      };
    }
    let body: any = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return readDispatchV2SendAnswer(response.status, body);
  };
}
