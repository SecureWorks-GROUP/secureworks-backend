// One delivery identity for an email, whichever door sends it.
//
// The approved-send door and the plain send-outlook-email door hold the same
// email_content:<sha256> key for the same message, so an approved send and a
// plain send of one email cannot both go out, and an unconfirmed send through
// either door holds the other. Every door builds the key here, from what will
// actually be delivered:
//   - the mailbox it is sent from;
//   - new or reply, and the message replied to (an approved "reply" is the
//     provider's createReply, as on the plain door; createReplyAll is the
//     same reply, since the recipients below say who it goes to);
//   - To, CC and BCC, each lowercased and sorted (order never matters);
//   - the subject, for a new email only. A reply's subject is not part of
//     its identity: the plain door sends the provider's own reply subject,
//     which it cannot know before the claim, while the approved door sets
//     its stored subject. Leaving it out means one reply holds the other
//     whatever either door would title it;
//   - the HTML body as sent (signature included);
//   - each attachment as { sha256, name, contentType } of the bytes sent.
// Bare attachment hashes are never used: the same bytes with and without a
// name are two different keys, so every door describes files the same way.
//
// A plain request that names an invoice also holds invoice:<id> in the same
// attempt (plainDoorInvoiceKeys), so it waits behind an unconfirmed invoice
// send from any other door.

import {
  bytesSha256Hex,
  type EmailContentAttachment,
  emailContentKey,
  invoiceSendKey,
} from "./outbound_send_claim.ts";

export type EmailDelivery = {
  mailbox: string;
  /** "new", "reply" (= createReply), "createReply", "createReplyAll", "forward" or "group_forward". */
  mode?: string | null;
  replyTo?: string | null;
  to?: unknown;
  cc?: unknown;
  bcc?: unknown;
  subject?: string | null;
  html?: string | null;
  attachments?: EmailContentAttachment[];
};

function deliveryMode(mode: string | null | undefined): string {
  const value = String(mode ?? "").trim();
  if (!value) return "new";
  return value === "reply" || value === "createReplyAll" ? "createReply" : value;
}

/** The email_content:<sha256> key every door holds for one delivered email. */
export function emailDeliveryKey(input: EmailDelivery): Promise<string> {
  const mode = deliveryMode(input.mode);
  return emailContentKey({
    mailbox: input.mailbox,
    mode,
    replyTo: mode === "new" ? "" : String(input.replyTo ?? ""),
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: mode === "createReply" ? "" : input.subject ?? "",
    html: input.html ?? "",
    attachments: input.attachments ?? [],
  });
}

/** An attachment as sent: its bytes' sha256, file name and content type. */
export async function describeAttachment(
  bytes: Uint8Array,
  name: string | null | undefined,
  contentType: string | null | undefined,
): Promise<EmailContentAttachment> {
  return { sha256: await bytesSha256Hex(bytes), name: name ?? null, contentType: contentType ?? null };
}

function base64ToBytes(value: string): Uint8Array {
  const raw = atob(value);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** Graph fileAttachments ({ name, contentType, contentBytes }) described for the key. */
export async function describeGraphAttachments(
  attachments: ReadonlyArray<{ name?: string | null; contentType?: string | null; contentBytes: string }>,
): Promise<EmailContentAttachment[]> {
  const described: EmailContentAttachment[] = [];
  for (const attachment of attachments) {
    described.push(await describeAttachment(base64ToBytes(attachment.contentBytes), attachment.name, attachment.contentType));
  }
  return described;
}

/**
 * The plain door's invoice anchor: the body's xero_invoice_id and each
 * attachment's xero_invoice_id, the same fields its PDF fence reads.
 */
export const PLAIN_DOOR_INVOICE_FIELD = "xero_invoice_id";

/** invoice:<id> for every invoice a plain send-outlook-email body names, sorted. */
export function plainDoorInvoiceKeys(body: Record<string, unknown>): string[] {
  const ids: string[] = [];
  const add = (value: unknown) => {
    const id = typeof value === "string" ? value.trim() : "";
    if (id) ids.push(id);
  };
  add(body[PLAIN_DOOR_INVOICE_FIELD]);
  for (const attachment of Array.isArray(body.attachments) ? body.attachments : []) {
    if (attachment && typeof attachment === "object") add((attachment as Record<string, unknown>)[PLAIN_DOOR_INVOICE_FIELD]);
  }
  return [...new Set(ids.map(invoiceSendKey))].sort();
}
