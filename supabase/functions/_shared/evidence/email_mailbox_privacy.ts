export type EmailMailboxPrivacy = "restricted_pii" | "staff_only";

const PERSONAL_MAILBOXES = new Set([
  "marnin@secureworkswa.com.au",
  "jan@secureworkswa.com.au",
]);

export function emailMailboxPrivacy(
  mailbox: unknown,
): EmailMailboxPrivacy | null {
  if (typeof mailbox !== "string" || !mailbox) return null;
  return PERSONAL_MAILBOXES.has(mailbox) ? "restricted_pii" : "staff_only";
}
