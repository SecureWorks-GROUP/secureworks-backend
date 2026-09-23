/** Execution-time authority of one `sales_booking_approvals` row.
 *
 * Shared by the ops-api booking executor (`sales_booking_book` /
 * `sales_booking_send`) and the ghl-proxy appointment writer, so no caller can
 * book around the executor and both read an approval the same way.
 * Pure: no clock, no network, no env. Contract:
 * docs/sales-booking-executor.md.
 */

// deno-lint-ignore no-explicit-any
type Obj = Record<string, any>;
const obj = (v: unknown): v is Obj =>
  !!v && typeof v === "object" && !Array.isArray(v);

export const BOOKING_APPROVAL_TTL_MS = 15 * 60_000;
export const DEFAULT_SALES_BOOKING_CAPTAIN_EMAIL =
  "marnin@secureworkswa.com.au";

/** Comma-separated, case-insensitive. Unset or blank -> default captain email. */
export function parseSalesBookingCaptainEmails(
  raw: string | undefined | null,
): string[] {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return [DEFAULT_SALES_BOOKING_CAPTAIN_EMAIL];
  const emails = [
    ...new Set(
      text.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean),
    ),
  ];
  return emails.length > 0 ? emails : [DEFAULT_SALES_BOOKING_CAPTAIN_EMAIL];
}

/** Key order independent; string bytes (including whitespace) are untouched. */
export function canonicalBookingJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalBookingJson).join(",")}]`;
  }
  if (obj(value)) {
    return `{${
      Object.keys(value).sort().map((key) =>
        `${JSON.stringify(key)}:${canonicalBookingJson(value[key])}`
      ).join(",")
    }}`;
  }
  return JSON.stringify(value) ?? "null";
}

export async function bookingHash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalBookingJson(value)),
  );
  return Array.from(
    new Uint8Array(digest),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}

/** content_hash covers the whole snapshot except the content_hash field. */
export function bookingContentHash(snapshot: Obj): Promise<string> {
  const { content_hash: _ignored, ...binding } = snapshot;
  return bookingHash(binding);
}

export function bookingInstant(value: unknown): number {
  if (typeof value !== "string" || !/(Z|[+-]\d\d:\d\d)$/.test(value)) {
    return NaN;
  }
  return Date.parse(value);
}

export const APPROVAL_ID_PATTERN = /^[a-f0-9]{64}$/;

export interface ExecutableApprovalRecord {
  binding_hash: string;
  step: string;
  state: string;
  snapshot: unknown;
  approved_by_email: string;
  approved_at: string;
  expires_at: string;
}

export type ApprovalGateRefusal =
  | "approval_step_mismatch"
  | "approval_not_approved"
  | "approval_not_by_captain"
  | "content_hash_mismatch"
  | "approval_expired";

/**
 * Null when the row is a live, captain-made, untampered approval of `step`.
 * Order is deliberate and every caller reports the first failed check.
 */
export async function approvalGateRefusal(
  record: ExecutableApprovalRecord,
  step: "calendar" | "message",
  now: Date,
  captainEmails: string[],
): Promise<ApprovalGateRefusal | null> {
  const snapshot = record.snapshot;
  if (
    record.step !== step || !obj(snapshot) || snapshot.step !== step
  ) return "approval_step_mismatch";
  if (record.state !== "approved") return "approval_not_approved";
  const email = String(record.approved_by_email || "").trim().toLowerCase();
  if (!email || !captainEmails.includes(email)) {
    return "approval_not_by_captain";
  }
  if (
    !APPROVAL_ID_PATTERN.test(String(record.binding_hash)) ||
    await bookingHash(snapshot) !== record.binding_hash ||
    typeof snapshot.content_hash !== "string" ||
    await bookingContentHash(snapshot) !== snapshot.content_hash
  ) return "content_hash_mismatch";
  const recorded = bookingInstant(record.approved_at);
  const expires = bookingInstant(record.expires_at);
  if (!Number.isFinite(recorded) || !Number.isFinite(expires)) {
    return "approval_expired";
  }
  const latest = Math.min(expires, recorded + BOOKING_APPROVAL_TTL_MS);
  if (!(now.getTime() >= recorded && now.getTime() < latest)) {
    return "approval_expired";
  }
  return null;
}

export interface ApprovedAppointment {
  calendarId: string;
  assignedUserId: string;
  contactId: string;
  startTime: string;
  endTime: string;
  title: string;
  address: string;
}

/** The exact GHL appointment an approved calendar snapshot authorises. */
export function appointmentFromCalendarApproval(
  snapshot: unknown,
): ApprovedAppointment | null {
  if (!obj(snapshot) || snapshot.step !== "calendar") return null;
  const c = snapshot.content;
  if (!obj(c) || c.provider !== "ghl") return null;
  const fields = [
    c.calendar_id,
    c.assigned_user_id,
    snapshot.contact_id,
    c.start_iso,
    c.end_iso,
    c.title,
    c.address,
  ];
  if (fields.some((v) => typeof v !== "string" || !v)) return null;
  return {
    calendarId: c.calendar_id,
    assignedUserId: c.assigned_user_id,
    contactId: snapshot.contact_id,
    startTime: c.start_iso,
    endTime: c.end_iso,
    title: c.title,
    address: c.address,
  };
}

/** Exact field equality; instants must name the same moment AND bytes. */
export function appointmentMatchesApproval(
  input: ApprovedAppointment,
  approved: ApprovedAppointment,
): boolean {
  return (Object.keys(approved) as (keyof ApprovedAppointment)[]).every((
    key,
  ) => input[key] === approved[key]);
}
