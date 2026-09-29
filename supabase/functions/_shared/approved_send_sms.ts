// deno-lint-ignore-file no-explicit-any
// Approved SMS: send the one text an owner approval names, to its exact mobile,
// from its named SecureWorks line (+61489267771 Group Admin by default, per
// _shared/sms_from_number.ts). No CRM contact is needed from the caller: GHL
// can only text a contact, so the number is resolved to its GHL contact (found
// by phone, or created with only that phone, the same find-or-create the
// ghl-proxy send_sms phone path uses), and the contact's stored phone must
// equal the approved mobile exactly before anything is claimed or sent.
//
// Approval checks, the claim and the audit are owned by approved_send.ts.

import {
  ApprovedSendRefusal,
  claimApprovedSend,
  finishApprovedSend,
  normalizeMobile,
  prepareApprovedSend,
  type SendDeps,
  type SmsPayload,
} from "./approved_send.ts";

export const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_TIMEOUT_MS = 20_000;

export class GhlCallError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** True when GHL may have acted (timeout, network, 5xx). */
    readonly outcomeUnknown: boolean,
  ) {
    super(message);
    this.name = "GhlCallError";
  }
}

export type GhlCall = (path: string, init?: RequestInit) => Promise<any>;

export function makeGhlCall(
  token: string,
  fetchImpl: typeof fetch = fetch,
): GhlCall {
  return async (path, init = {}) => {
    let response: Response;
    try {
      response = await fetchImpl(`${GHL_BASE}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          Version: "2021-07-28",
          "Content-Type": "application/json",
          ...(init.headers || {}),
        },
        signal: AbortSignal.timeout(GHL_TIMEOUT_MS),
      });
    } catch (error) {
      throw new GhlCallError(0, `GHL request failed: ${(error as Error).message}`, true);
    }
    const body = await response.text();
    if (!response.ok) {
      throw new GhlCallError(
        response.status,
        `GHL ${response.status}: ${body.slice(0, 500)}`,
        response.status >= 500,
      );
    }
    try {
      return body ? JSON.parse(body) : {};
    } catch {
      throw new GhlCallError(response.status, "GHL response was not JSON", true);
    }
  };
}

function phoneOf(contact: any): string | null {
  const raw = contact?.phone;
  if (!raw) return null;
  try {
    return normalizeMobile(raw);
  } catch {
    return null;
  }
}

/** Find the GHL contact for exactly this mobile, creating it if absent. */
export async function resolveContactForMobile(
  ghl: GhlCall,
  locationId: string,
  mobile: string,
): Promise<string> {
  if (!locationId) {
    throw new ApprovedSendRefusal(503, "sms_provider_unconfigured", "The SMS provider location is not configured.");
  }
  let contactId: string | null = null;
  try {
    const found = await ghl("/contacts/search/duplicate", {
      method: "POST",
      body: JSON.stringify({ locationId, phone: mobile }),
    });
    contactId = found?.contact?.id || null;
  } catch (error) {
    throw new ApprovedSendRefusal(503, "sms_contact_lookup_failed",
      `The SMS contact lookup failed, so nothing was sent (${(error as Error).message}).`);
  }
  if (!contactId) {
    try {
      const created = await ghl("/contacts/", {
        method: "POST",
        body: JSON.stringify({ locationId, phone: mobile }),
      });
      contactId = created?.contact?.id || null;
    } catch (error) {
      const match = String((error as Error).message || "").match(/"contactId"\s*:\s*"([^"]+)"/);
      if (match?.[1]) contactId = match[1];
      else {
        throw new ApprovedSendRefusal(503, "sms_contact_create_failed",
          `The SMS contact could not be created, so nothing was sent (${(error as Error).message}).`);
      }
    }
  }
  if (!contactId) {
    throw new ApprovedSendRefusal(503, "sms_contact_unresolved", "No SMS contact could be resolved for this mobile.");
  }
  let contact: any;
  try {
    contact = (await ghl(`/contacts/${encodeURIComponent(contactId)}`))?.contact;
  } catch (error) {
    throw new ApprovedSendRefusal(503, "sms_contact_lookup_failed",
      `The SMS contact could not be read back, so nothing was sent (${(error as Error).message}).`);
  }
  if (phoneOf(contact) !== mobile) {
    throw new ApprovedSendRefusal(409, "sms_contact_phone_mismatch",
      "The provider contact's phone is not the approved mobile, so nothing was sent.",
      { contact_id: contactId });
  }
  return contactId;
}

export interface ApprovedSmsDeps extends SendDeps {
  ghl: GhlCall;
  locationId: string;
}

export interface Caller {
  actor: string | null;
  credentialClass: string | null;
}

/**
 * Send one approved SMS. Refusals before the claim leave the approval unused;
 * once claimed the approval is consumed whatever happens, and the outcome
 * (sent, failed, outcome_unknown) is written to the approval and the audit.
 */
export async function sendApprovedSms(
  deps: ApprovedSmsDeps,
  approvalId: string,
  caller: Caller,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const prepared = await prepareApprovedSend(deps, approvalId, "sms");
  const payload = prepared.payload as SmsPayload;
  const contactId = await resolveContactForMobile(deps.ghl, deps.locationId, payload.to_mobile);
  const claimed = await claimApprovedSend(deps, prepared, caller);

  let messageId: string | null = null;
  let conversationId: string | null = null;
  try {
    const result = await deps.ghl("/conversations/messages", {
      method: "POST",
      body: JSON.stringify({
        type: "SMS",
        contactId,
        message: payload.message,
        fromNumber: payload.from_line,
      }),
    });
    messageId = String(result?.messageId || result?.id || "") || null;
    conversationId = String(result?.conversationId || "") || null;
  } catch (error) {
    const unknown = !(error instanceof GhlCallError) || error.outcomeUnknown;
    const status = unknown ? "outcome_unknown" : "failed";
    const code = unknown ? "provider_outcome_unknown" : "provider_rejected";
    const recorded = await finishApprovedSend(deps, claimed, {
      status,
      code,
      provider_message_id: null,
      detail: {
        contact_id: contactId,
        to_mobile: payload.to_mobile,
        from_line: payload.from_line,
        error: (error as Error).message,
      },
    }, caller);
    return {
      status: 502,
      body: {
        state: status,
        code,
        approval_id: approvalId,
        error: (error as Error).message,
        retry_safe: false,
        recovery_action: unknown
          ? "Check the provider inbox for this text before anything else; this approval is used and is never resent."
          : "The provider refused the text. This approval is used; record a new approval to try again.",
        ...recorded,
      },
    };
  }
  const recorded = await finishApprovedSend(deps, claimed, {
    status: "sent",
    code: null,
    provider_message_id: messageId,
    detail: {
      contact_id: contactId,
      conversation_id: conversationId,
      to_mobile: payload.to_mobile,
      from_line: payload.from_line,
    },
  }, caller);
  return {
    status: 200,
    body: {
      success: true,
      state: "sent",
      approval_id: approvalId,
      channel: "sms",
      to_mobile: payload.to_mobile,
      from_line: payload.from_line,
      provider_message_id: messageId,
      payload_hash: claimed.row.payload_hash,
      ...recorded,
    },
  };
}
