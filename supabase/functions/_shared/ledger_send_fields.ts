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

export function sendRecipientMetadata(input: {
  recipients: readonly unknown[]
  contactId?: unknown
  clientEmail?: unknown
  matchCustomer?: boolean
}): Record<string, string | boolean> {
  const recipients = input.recipients ?? []
  if (recipients.length !== 1) {
    return recipients.length > 1 ? { several_recipients: true } : {}
  }
  const contact = input.matchCustomer
    ? customerContactForAddress(recipients[0], input.clientEmail, input.contactId)
    : knownContactId(input.contactId)
  return contact ? { contact_id: contact } : {}
}
