// Quote v2 stage 3: which delivery adapter a send uses. PROGRAM BRANCH ONLY.
//
// The default adapter is CAPTURE: the send writes the would-be email and SMS
// to quote_v2_outbox and nothing delivers them, ever (the database refuses a
// delivery record for a captured row).
//
// The LIVE adapter (Resend email, GHL SMS) is present but off. It is allowed
// only when ALL of these hold, and nothing in this program sets them:
//   QUOTE_V2_ENVIRONMENT  = "staging"
//   QUOTE_V2_LIVE_DELIVERY = "staging-only-enabled"
//   SUPABASE_URL is not the production project
// A preview records its adapter, so the owner's stamp says whether messages
// will be delivered; a live preview is refused when the gate is shut.

import { resolveSmsFromNumber } from "../_shared/sms_from_number.ts";

export const PRODUCTION_PROJECT_REF = "kevgrhcjxspbxgovpmfl";
export const LIVE_DELIVERY_FLAG_VALUE = "staging-only-enabled";

export interface LiveGate {
  allowed: boolean;
  reason: string;
}

export function liveDeliveryGate(
  env: (name: string) => string | undefined,
): LiveGate {
  if (env("QUOTE_V2_ENVIRONMENT") !== "staging") {
    return { allowed: false, reason: "not a staging environment" };
  }
  if (env("QUOTE_V2_LIVE_DELIVERY") !== LIVE_DELIVERY_FLAG_VALUE) {
    return { allowed: false, reason: "the staging-only delivery flag is off" };
  }
  const url = env("SUPABASE_URL") ?? "";
  if (!url || url.includes(PRODUCTION_PROJECT_REF)) {
    return { allowed: false, reason: "this is the production project" };
  }
  return { allowed: true, reason: "staging delivery enabled" };
}

/** One live outbox row, as quote_v2_live_outbox_pending returns it. */
export interface LiveOutboxRow {
  id: string;
  channel: "email" | "sms";
  to_address: string;
  to_name: string | null;
  subject: string | null;
  body_text: string;
  body_html: string | null;
  ghl_contact_id: string | null;
}

export type DeliveryOutcome = {
  outcome: "delivered" | "failed" | "unknown";
  provider_message_id?: string | null;
  detail?: string | null;
};

export interface LiveDeliveryDeps {
  env: (name: string) => string | undefined;
  fetch: typeof fetch;
}

/** A provider refusal is `failed`; a provider 5xx may still have delivered,
 * so it is `unknown`. */
function refused(what: string, status: number): DeliveryOutcome {
  return {
    outcome: status >= 500 ? "unknown" : "failed",
    detail: `${what} provider ${status}`,
  };
}

/** Deliver one claimed live row once. A thrown, timed-out or 5xx call is
 * `unknown`; no outcome is retried automatically (the email carries an
 * idempotency key, the SMS cannot). Only reached when liveDeliveryGate allowed
 * the preview and the row was claimed. */
export async function deliverLiveRow(
  row: LiveOutboxRow,
  deps: LiveDeliveryDeps,
): Promise<DeliveryOutcome> {
  if (!liveDeliveryGate(deps.env).allowed) {
    return { outcome: "failed", detail: "live delivery is not enabled here" };
  }
  try {
    if (row.channel === "email") {
      const key = deps.env("RESEND_API_KEY");
      if (!key) return { outcome: "failed", detail: "no email provider key" };
      const res = await deps.fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "Idempotency-Key": `quote-v2:${row.id}`,
        },
        body: JSON.stringify({
          from: `SecureWorks Group <${
            deps.env("FROM_EMAIL") || "quotes@secureworksgroup.app"
          }>`,
          to: row.to_address,
          subject: row.subject,
          html: row.body_html,
          text: row.body_text,
        }),
      });
      if (!res.ok) return refused("email", res.status);
      const body = await res.json().catch(() => ({}));
      return { outcome: "delivered", provider_message_id: body?.id ?? null };
    }
    const token = deps.env("GHL_API_TOKEN");
    if (!token) return { outcome: "failed", detail: "no SMS provider key" };
    if (!row.ghl_contact_id) {
      return { outcome: "failed", detail: "the party has no GHL contact" };
    }
    const from = resolveSmsFromNumber(deps.env("QUOTE_V2_SMS_FROM_NUMBER"));
    if (!from.ok) return { outcome: "failed", detail: from.error };
    const res = await deps.fetch(
      "https://services.leadconnectorhq.com/conversations/messages",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Version: "2021-04-15",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: "SMS",
          contactId: row.ghl_contact_id,
          message: row.body_text,
          fromNumber: from.fromNumber,
        }),
      },
    );
    if (!res.ok) return refused("SMS", res.status);
    const body = await res.json().catch(() => ({}));
    return {
      outcome: "delivered",
      provider_message_id: body?.messageId ?? body?.id ?? null,
    };
  } catch (e) {
    return {
      outcome: "unknown",
      detail: `provider call did not complete: ${(e as Error).message}`
        .slice(0, 200),
    };
  }
}
