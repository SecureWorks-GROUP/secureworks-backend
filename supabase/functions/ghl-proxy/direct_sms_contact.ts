/**
 * Plain GHL contact for a SecureSuite text to a raw Australian number.
 *
 * sw_send_sms sets directSms. ghl-proxy then finds a contact by that phone
 * or creates one tagged "direct-sms". It never opens a sales opportunity.
 * An existing contact is reused as it is: a customer is not retagged.
 *
 * The same Australian-number rule lives in secureworks-jarvis src/direct-sms.ts.
 * Keep the two copies in step.
 */

export const DIRECT_SMS_TAG = "direct-sms";

export const AU_PHONE_ERROR =
  "Phone number must be an Australian mobile or landline. Use 04, 02, 03, 07, 08 or +61.";

export type AuE164Result =
  | { ok: true; e164: string }
  | { ok: false; error: string };

/** "+61 412 345 678", "0412 345 678" and "412345678" all become "+61412345678". */
export function toAuE164(raw: unknown): AuE164Result {
  if (typeof raw !== "string") return { ok: false, error: AU_PHONE_ERROR };
  const compact = raw.trim().replace(/[\s\-().]/g, "");
  if (!compact || !/^\+?\d+$/.test(compact)) return { ok: false, error: AU_PHONE_ERROR };
  let digits = compact.startsWith("+") ? compact.slice(1) : compact;
  if (digits.length === 10 && digits.startsWith("0")) digits = `61${digits.slice(1)}`;
  else if (digits.length === 9 && digits.startsWith("4")) digits = `61${digits}`;
  if (!/^61[23478]\d{8}$/.test(digits)) return { ok: false, error: AU_PHONE_ERROR };
  return { ok: true, e164: `+${digits}` };
}

/** National 0-prefix first (how older contacts were stored), then E.164. */
export function duplicateSearchPhones(e164: string): string[] {
  return [`0${e164.slice(3)}`, e164];
}

export function plainContactName(raw: unknown): { firstName?: string; lastName?: string } {
  if (typeof raw !== "string") return {};
  const name = raw.trim().replace(/\s+/g, " ").slice(0, 120);
  if (!name) return {};
  const space = name.indexOf(" ");
  if (space < 0) return { firstName: name };
  const lastName = name.slice(space + 1).trim();
  return lastName ? { firstName: name.slice(0, space), lastName } : { firstName: name.slice(0, space) };
}

/**
 * Body for POST /contacts/. Phone, optional name, location, and the
 * direct-sms tag. No pipeline, no opportunity, no job.
 */
export function plainContactCreateBody(
  e164: string,
  name: unknown,
  locationId: string,
): Record<string, unknown> {
  return {
    ...plainContactName(name),
    phone: e164,
    locationId,
    tags: [DIRECT_SMS_TAG],
  };
}

/** GHL's duplicate-contact error includes the existing contact id. */
export function contactIdFromDuplicateError(message: string): string | null {
  const dupMatch = message.match(/"contactId"\s*:\s*"([^"]+)"/);
  return dupMatch?.[1] ?? null;
}
