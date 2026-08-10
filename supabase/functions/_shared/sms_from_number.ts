// Outbound SMS sender-number policy — single source of truth.
//
// Company rule (wiki OPS.md): every ops outbound SMS originates from
// +61489267771 (SecureWorks Group Admin). Replies land in the thread of the
// sending number, so a send from any other line loses the client's reply
// into that line's inbox. Captain decision on record (2026-07-31, wiki
// coding/work/requests/2026-07-30-sw-send-sms-cannot-set-sender-number.md):
// default every ops send to +61489267771, allow explicit overrides
// constrained to the known SecureWorks numbers below.
//
// Used by ghl-proxy `send_sms` (the choke point every proxied SMS flows
// through) and by ops-api `sendCommsMessageAction` (the one path that POSTs
// to the GHL conversations API directly).

export const SMS_DEFAULT_FROM_NUMBER = '+61489267771' // SecureWorks Group Admin

export const SMS_ALLOWED_FROM_NUMBERS = [
  '+61489267771', // SecureWorks Group Admin (ops default)
  '+61489267772', // SecureWorks Fencing Sales
  '+61489267774', // SecureWorks Patios (GHL location default)
  '+61489267776', // SecureWorks Group Ops
  '+61489267778', // SecureWorks Fencing Mgmt
] as const

export type ResolvedSmsFromNumber =
  | { ok: true; fromNumber: string }
  | { ok: false; error: string }

// Resolve the sender for one outbound SMS. No caller-supplied number (or a
// blank one) lands on the +61489267771 default; an explicit number must be
// on the allowlist — a typo or a foreign number would otherwise be silently
// rejected by GHL.
export function resolveSmsFromNumber(raw: unknown): ResolvedSmsFromNumber {
  const normalized = String(raw ?? '').trim()
  if (!normalized) return { ok: true, fromNumber: SMS_DEFAULT_FROM_NUMBER }
  if (!(SMS_ALLOWED_FROM_NUMBERS as readonly string[]).includes(normalized)) {
    return {
      ok: false,
      error:
        `Invalid fromNumber: ${normalized}. Must be a SecureWorks number in E.164 form (e.g. +61489267776).`,
    }
  }
  return { ok: true, fromNumber: normalized }
}
