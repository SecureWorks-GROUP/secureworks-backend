// A phone that already belongs to a different person must not be reused and must not
// change that contact. Email match still reuses: that is the same address.

export type ContactReuseDecision =
  | { action: "reuse" }
  | {
    action: "choose";
    message: string;
    existingName: string;
    existingEmail: string;
  };

function tidy(value: string | null | undefined): string {
  return (value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function personName(
  first: string | null | undefined,
  last: string | null | undefined,
  full: string | null | undefined,
): string {
  const joined = (full || "").trim() || [first, last].filter((part) => (part || "").trim()).join(" ");
  return tidy(joined);
}

/**
 * Phone match whose name or email differs: do not link, do not change the contact.
 * Email match reuses. A blank name or a blank email is not a difference.
 */
export function contactReuseDecision(o: {
  matchedBy: "email" | "phone";
  wantedFirst?: string | null;
  wantedLast?: string | null;
  wantedEmail?: string | null;
  existingFirst?: string | null;
  existingLast?: string | null;
  existingName?: string | null;
  existingEmail?: string | null;
}): ContactReuseDecision {
  if (o.matchedBy === "email") return { action: "reuse" };
  const wantedEmail = tidy(o.wantedEmail);
  const existingEmail = tidy(o.existingEmail);
  const wantedName = personName(o.wantedFirst, o.wantedLast, null);
  const existingName = personName(o.existingFirst, o.existingLast, o.existingName);
  const emailDiffers = !!wantedEmail && !!existingEmail && wantedEmail !== existingEmail;
  const nameDiffers = !!wantedName && !!existingName && wantedName !== existingName;
  if (!emailDiffers && !nameDiffers) return { action: "reuse" };
  const who = existingName || "another contact";
  return {
    action: "choose",
    existingName,
    existingEmail,
    message: `This phone is already on ${who}. That contact was not changed, and this job was not linked to it. Choose which contact this job belongs to.`,
  };
}
