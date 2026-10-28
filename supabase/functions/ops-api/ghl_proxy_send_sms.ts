// deno-lint-ignore-file no-explicit-any
// One POST to ghl-proxy send_sms for the ops-api customer texts that pass a
// GHL contact id: the client update (calendar reschedule, trade job complete),
// the payment link, the booking-confirmation text and council texts.
//
// ghl-proxy refuses any request with no login (401 missing_auth), and these
// four sent none, so every one of them failed silently from the day it was
// built. The service-role bearer goes on here, the way the make-safe arrival
// texts already send it, so no caller can leave it off again.
//
// A text counts as sent only when ghl-proxy answers HTTP 2xx with
// success:true: it reports a GHL failure as HTTP 200 { success:false, error }.
// Otherwise `reason` carries ghl-proxy's own error text (or the HTTP status)
// so the operator sees why. A network failure is thrown, as fetch throws it;
// each caller already decides what that means for its own action.

export type GhlProxySendSmsResult = {
  sent: boolean;
  status: number;
  body: any;
  reason: string | null;
};

export function ghlProxySendSmsFailureReason(
  status: number,
  body: any,
): string {
  const text = String(body?.error || body?.message || body?.code || "").trim();
  const ok = status >= 200 && status < 300;
  if (!text) return ok ? "Text not accepted by GHL" : `HTTP ${status}`;
  return (ok ? text : `${text} (HTTP ${status})`).slice(0, 500);
}

export async function postGhlProxySendSms(args: {
  supabaseUrl: string;
  serviceKey: string;
  payload: Record<string, unknown>;
  fetchFn?: typeof fetch;
}): Promise<GhlProxySendSmsResult> {
  const fetchFn = args.fetchFn ?? fetch;
  const resp = await fetchFn(
    `${args.supabaseUrl}/functions/v1/ghl-proxy?action=send_sms`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${args.serviceKey}`,
      },
      body: JSON.stringify(args.payload),
    },
  );
  const body = await resp.json().catch(() => null);
  const sent = resp.ok && body?.success === true;
  return {
    sent,
    status: resp.status,
    body,
    reason: sent ? null : ghlProxySendSmsFailureReason(resp.status, body),
  };
}
