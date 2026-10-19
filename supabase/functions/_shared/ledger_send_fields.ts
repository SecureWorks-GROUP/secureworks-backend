// Typed values the ledger link copies. No new recipient column: the address
// already lives on email_events.recipient or job_events.detail_json.to. A
// contact id is stored beside that address only when this send path already
// knows it.

export function singleEmailAddress(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const trimmed = raw.trim()
  if (!trimmed || /[,;\s<>]/.test(trimmed)) return null
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return null
  return trimmed
}

export function knownContactId(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const trimmed = raw.trim()
  if (!trimmed || trimmed.includes("@")) return null
  return trimmed
}

// The customer id only when this address is that job's client email.
export function customerContactForAddress(
  toAddress: unknown,
  clientEmail: unknown,
  contactId: unknown,
): string | null {
  const to = singleEmailAddress(toAddress)
  const client = singleEmailAddress(clientEmail)
  if (!to || !client || to.toLowerCase() !== client.toLowerCase()) return null
  return knownContactId(contactId)
}

// several_recipients is explicit. One address across to, cc and bcc is false.
// Any other count is true. Zero addresses, with nothing unreadable, omits the
// flag. contact_id is added only on that single address.
export function sendRecipientMetadata(input: {
  recipients?: readonly unknown[]
  cc?: readonly unknown[]
  bcc?: readonly unknown[]
  contactId?: unknown
  clientEmail?: unknown
  matchCustomer?: boolean
  uncertainExtra?: boolean
}): Record<string, string | boolean | string[]> {
  const to = input.recipients ?? []
  const cc = (input.cc ?? []).filter((value): value is string => typeof value === "string")
  const bcc = (input.bcc ?? []).filter((value): value is string => typeof value === "string")
  const count = to.length + cc.length + bcc.length
  if (count === 0 && !input.uncertainExtra) return {}
  const several = input.uncertainExtra === true || count !== 1
  const meta: Record<string, string | boolean | string[]> = { several_recipients: several }
  if (cc.length) meta.cc_emails = cc
  if (bcc.length) meta.bcc_emails = bcc
  if (several) return meta
  const contact = input.matchCustomer
    ? customerContactForAddress(to[0], input.clientEmail, input.contactId)
    : knownContactId(input.contactId)
  if (contact) meta.contact_id = contact
  return meta
}
