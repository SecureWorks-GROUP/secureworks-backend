/** Owner-authored booking approvals: no engine publish needed.
 *
 * Marnin's Stratco leads take a text or a visit under the Stratco rulebook.
 * Nithin's and Khairo's leads take a text only (no offered slot, no visit):
 * their visits are not booked here. Every text goes from the visit person's
 * own line (sales_booking_sender.ts).
 *
 * The owner writes or edits a text, or picks a visit (day, arrival window,
 * visit end), on the booking screen. `sales_booking_approval_write` with an
 * `owner_input` body builds the exact snapshot here from server truth (GHL
 * contact, the Stratco rulebook, the visit person's own line), checks it on the server at
 * the moment of the press, and records it in the same `sales_booking_approvals`
 * table the engine path uses. The executor (`sales_booking_book` /
 * `sales_booking_send`) reads either kind the same way and re-checks at its
 * own press. This module records approvals only: it never books or sends.
 * Contract: docs/sales-booking-confirmation-api.md "Owner-authored approvals".
 */
import {
  BOOKING_APPROVAL_TTL_MS,
  bookingContentHash,
  bookingHash,
  bookingInstant,
  canonicalBookingJson,
} from "../_shared/booking_approval_gate.ts";
import {
  assertSalesBookingStampWriteAuth,
  type SalesBookingEnvGet,
  type SalesBookingPackAuth,
} from "./sales_booking_pack.ts";
import {
  isPhoneLikeName,
  messageDirection,
  SALES_BOOKING_NOT_GIVEN,
  type SalesBookingCase,
  salesBookingLeadBelongsTo,
  type SalesBookingMessage,
  type SalesBookingReadResponse,
} from "./sales_booking_read.ts";
import type {
  BookingApprovalRecord,
  BookingApprovalStore,
  BookingObject,
  BookingStep,
} from "./sales_booking_confirmation.ts";
import { outlookClashes, type OutlookRead } from "./sales_booking_execute.ts";
import {
  SALES_BOOKING_SENDER_LINES,
  salesBookingSenderFor,
} from "./sales_booking_sender.ts";

export const OWNER_APPROVAL_VERSION = "owner-authored-v1";
const SCHEMA = "scope-booking-approval.v1";
const PERTH_OFFSET_MS = 8 * 60 * 60_000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MAX_TEXT = 1600;
/** A calendar claim not settled within this long is over (writer refuses
 * claims older than two minutes). Same bound as the execution read. */
const IN_FLIGHT_MS = 2 * 60_000;
/** Open offers older than this are outside the census read window. */
export const OWNER_OFFER_CENSUS_DAYS = 21;

/** The Stratco rulebook. Values are the engine's own profile JSON (wiki
 * `harness/ops/skills/secureworks-scope-booking/profiles/fencing-stratco-marnin.json`,
 * commit 55421112) and the calendar target the owner confirmed in that
 * skill's GO-LIVE.md. The Python engine is no longer a runtime; this is its
 * rulebook. Change both together. */
export const STRATCO_BOOKING_RULEBOOK = Object.freeze({
  profile: "fencing-stratco-marnin",
  resource: "marnin",
  source:
    "secureworks-wiki harness/ops/skills/secureworks-scope-booking/profiles/fencing-stratco-marnin.json@55421112 + GO-LIVE.md",
  timezone: "Australia/Perth",
  utc_offset: "+08:00",
  days: Object.freeze(["Tue", "Fri"]),
  day_start: "08:00",
  day_end: "16:30",
  /** Arrival window length the customer is offered. */
  window_min_minutes: 60,
  window_max_minutes: 90,
  /** Visit length after latest arrival; the visit ends at or after this. */
  visit_minutes: 60,
  travel_buffer_minutes: 30,
  max_per_day: 6,
  protected_bands: Object.freeze([
    Object.freeze({
      weekday: "Tue",
      start: "13:00",
      end: "15:30",
      label: "Stratco / Canning Vale",
    }),
  ]),
  /** Marnin's own line; the one table is sales_booking_sender.ts. */
  sender: SALES_BOOKING_SENDER_LINES.marnin.line,
  calendar: Object.freeze({
    provider: "ghl",
    calendar_id: "dEQKVKHthsjSYaen1fiE",
    calendar_name: "STRATCO FENCING",
    assigned_user_id: "3S20LGVTjsVYy9vTJ9wM",
    scoper_email: "marnin@secureworkswa.com.au",
  }),
});
const RULES = STRATCO_BOOKING_RULEBOOK;

/** A named refusal. `detail` goes back to the screen beside the reason.
 * Extends Error, not SalesBookingPackError: sales_booking_pack imports the
 * confirmation module, which imports this one, so a base class from there
 * would not be initialised yet when this module loads. */
export class OwnerApprovalRefusal extends Error {
  constructor(
    reason: string,
    readonly detail: BookingObject | null = null,
    readonly status = 409,
  ) {
    super(reason);
    this.name = "OwnerApprovalRefusal";
  }
}
function refuse(
  reason: string,
  detail: BookingObject | null = null,
  status = 409,
): never {
  throw new OwnerApprovalRefusal(reason, detail, status);
}

const obj = (v: unknown): v is BookingObject =>
  !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown) => typeof v === "string" ? v.trim() : "";
const overlaps = (a0: number, a1: number, b0: number, b1: number) =>
  a0 < b1 && b0 < a1;

// ── Perth time ─────────────────────────────────────────────────────────────

const PERTH_ISO =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.0+)?\+08:00$/;

/** Exact Perth instant, canonical `YYYY-MM-DDTHH:MM:00+08:00`, or null. */
export function perthInstant(
  value: unknown,
): { ms: number; iso: string } | null {
  const m = typeof value === "string" ? PERTH_ISO.exec(value) : null;
  if (!m || (m[6] !== undefined && m[6] !== "00")) return null;
  const [, y, mo, d, h, mi] = m;
  if (Number(h) > 23 || Number(mi) > 59) return null;
  const ms = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:00+08:00`);
  if (!Number.isFinite(ms)) return null;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:00+08:00`;
  // Rolled dates (Feb 30) do not round-trip.
  if (perthIso(ms) !== iso) return null;
  return { ms, iso };
}
export function perthIso(ms: number): string {
  const local = new Date(ms + PERTH_OFFSET_MS).toISOString();
  return `${local.slice(0, 16)}:00+08:00`;
}
const perthDate = (ms: number) => perthIso(ms).slice(0, 10);
const perthWeekday = (ms: number) =>
  WEEKDAYS[new Date(ms + PERTH_OFFSET_MS).getUTCDay()];
const atPerth = (date: string, hhmm: string) =>
  Date.parse(`${date}T${hhmm}:00+08:00`);

export interface OwnerVisit {
  window_start_iso: string;
  window_end_iso: string;
  end_iso: string;
}
type CheckedVisit = OwnerVisit & {
  start: number;
  windowEnd: number;
  end: number;
  occupiedStart: number;
  occupiedEnd: number;
  date: string;
};

/** Rulebook-only checks, in the order a refusal is reported. No reads. */
export function checkOwnerVisitRules(
  visit: unknown,
  now: Date,
): CheckedVisit {
  if (!obj(visit)) refuse("owner_visit_required", null, 400);
  const start = perthInstant(visit.window_start_iso);
  const windowEnd = perthInstant(visit.window_end_iso);
  const end = perthInstant(visit.end_iso);
  if (!start || !windowEnd || !end) {
    refuse("owner_visit_times_invalid", {
      expected: "YYYY-MM-DDTHH:MM:00+08:00 for window_start_iso, " +
        "window_end_iso and end_iso",
    }, 400);
  }
  if (!(start.ms > now.getTime())) {
    refuse("owner_visit_not_future", { window_start_iso: start.iso });
  }
  const date = perthDate(start.ms);
  if (perthDate(end.ms) !== date || perthDate(windowEnd.ms) !== date) {
    refuse("owner_visit_spans_days");
  }
  const day = perthWeekday(start.ms);
  if (!RULES.days.includes(day)) {
    refuse("owner_visit_day_not_permitted", { day, days: [...RULES.days] });
  }
  const windowMinutes = (windowEnd.ms - start.ms) / 60_000;
  if (
    windowMinutes < RULES.window_min_minutes ||
    windowMinutes > RULES.window_max_minutes
  ) {
    refuse("owner_visit_window_length", {
      minutes: windowMinutes,
      min: RULES.window_min_minutes,
      max: RULES.window_max_minutes,
    });
  }
  if (!(end.ms > windowEnd.ms)) {
    refuse("owner_visit_window_not_inside_visit");
  }
  if (end.ms - windowEnd.ms < RULES.visit_minutes * 60_000) {
    refuse("owner_visit_too_short", {
      visit_minutes_after_latest_arrival: RULES.visit_minutes,
    });
  }
  if (
    start.ms < atPerth(date, RULES.day_start) ||
    end.ms > atPerth(date, RULES.day_end)
  ) {
    refuse("owner_visit_outside_hours", {
      day_start: RULES.day_start,
      day_end: RULES.day_end,
    });
  }
  const gap = RULES.travel_buffer_minutes * 60_000;
  const occupiedStart = start.ms - gap, occupiedEnd = end.ms + gap;
  for (const band of RULES.protected_bands) {
    if (band.weekday !== day) continue;
    if (
      overlaps(
        occupiedStart,
        occupiedEnd,
        atPerth(date, band.start),
        atPerth(date, band.end),
      )
    ) refuse("owner_visit_protected_band", { band: { ...band } });
  }
  return {
    window_start_iso: start.iso,
    window_end_iso: windowEnd.iso,
    end_iso: end.iso,
    start: start.ms,
    windowEnd: windowEnd.ms,
    end: end.ms,
    occupiedStart,
    occupiedEnd,
    date,
  };
}

// ── Open offers made through this system ───────────────────────────────────

export interface SystemOffer {
  contact_id: string;
  start_iso: string;
  end_iso: string;
  source: "system_text" | "booking_in_flight" | "owner_approval";
  binding_hash: string;
}
export interface SystemOfferCensus {
  offers: SystemOffer[];
  /** Texts this system sent whose record names no machine-readable slot. */
  unverified_texts: Array<
    { contact_id: string; binding_hash: string; reason: string }
  >;
  /** Contacts with a message press that may or may not have reached them. */
  unsettled_messages: string[];
  /** Contacts whose visit this system has booked (appointment ids). */
  booked: Record<string, string[]>;
}

/** A live owner-authored row still holds its offer or visit until it
 * expires or that lead is booked. Same liveness as the read's approval list. */
function ownerApprovalOffer(
  approval: BookingObject,
  now: Date,
): SystemOffer | null {
  if (approval.state !== "approved") return null;
  const snap = obj(approval.snapshot) ? approval.snapshot : null;
  if (!snap || snap.source !== "owner") return null;
  const recorded = bookingInstant(approval.approved_at);
  const expires = bookingInstant(approval.expires_at);
  if (!Number.isFinite(recorded) || !Number.isFinite(expires)) return null;
  const latest = Math.min(expires, recorded + BOOKING_APPROVAL_TTL_MS);
  if (!(now.getTime() >= recorded && now.getTime() < latest)) return null;
  const contactId = text(snap.contact_id);
  if (!contactId) return null;
  const content = obj(snap.content) ? snap.content : null;
  if (!content) return null;
  const step = approval.step === "message" || snap.step === "message"
    ? "message"
    : approval.step === "calendar" || snap.step === "calendar"
    ? "calendar"
    : null;
  let start: ReturnType<typeof perthInstant> = null;
  let finish: ReturnType<typeof perthInstant> = null;
  if (step === "message") {
    const offer = obj(content.offer) ? content.offer : null;
    if (!offer) return null;
    start = perthInstant(offer.window_start_iso);
    finish = perthInstant(offer.end_iso);
  } else if (step === "calendar") {
    start = perthInstant(content.window_start_iso) ??
      perthInstant(content.start_iso);
    finish = perthInstant(content.end_iso);
  } else {
    return null;
  }
  if (!start || !finish || !(finish.ms > start.ms)) return null;
  if (finish.ms <= now.getTime()) return null;
  return {
    contact_id: contactId,
    start_iso: start.iso,
    end_iso: finish.iso,
    source: "owner_approval",
    binding_hash: String(approval.binding_hash),
  };
}

/** Pure: executor press rows joined to the approvals they executed, plus
 * live unexpired owner-authored rows that already name a slot. */
export function systemOfferCensus(
  executions: BookingObject[],
  approvals: BookingObject[],
  now: Date,
): SystemOfferCensus {
  const byHash = new Map(approvals.map((a) => [a.binding_hash, a]));
  const booked: Record<string, string[]> = {};
  for (const e of executions) {
    if (e.step === "calendar" && e.state === "booked") {
      (booked[e.contact_id] ??= []).push(String(e.appointment_id));
    }
  }
  const census: SystemOfferCensus = {
    offers: [],
    unverified_texts: [],
    unsettled_messages: [],
    booked,
  };
  for (const e of executions) {
    const approval = byHash.get(e.binding_hash);
    const content = obj(approval?.snapshot?.content)
      ? approval!.snapshot.content
      : null;
    if (e.step === "message") {
      if (!["sent", "sending", "unknown"].includes(e.state)) continue;
      if (e.state !== "sent") census.unsettled_messages.push(e.contact_id);
      if (booked[e.contact_id]) continue; // the booking now holds the slot
      const offer = obj(content?.offer) ? content!.offer : null;
      if (!offer) {
        census.unverified_texts.push({
          contact_id: e.contact_id,
          binding_hash: e.binding_hash,
          reason: !approval
            ? "approval_record_missing"
            : "text_names_no_machine_readable_slot",
        });
        continue;
      }
      const s = perthInstant(offer.window_start_iso),
        f = perthInstant(offer.end_iso);
      if (!s || !f || !(f.ms > s.ms)) {
        census.unverified_texts.push({
          contact_id: e.contact_id,
          binding_hash: e.binding_hash,
          reason: "offer_slot_malformed",
        });
        continue;
      }
      if (f.ms <= now.getTime()) continue;
      census.offers.push({
        contact_id: e.contact_id,
        start_iso: s.iso,
        end_iso: f.iso,
        source: "system_text",
        binding_hash: e.binding_hash,
      });
    } else if (e.step === "calendar" && e.state === "claimed") {
      const claimed = bookingInstant(e.claimed_at);
      if (!(now.getTime() - claimed < IN_FLIGHT_MS)) continue;
      const s = bookingInstant(content?.start_iso),
        f = bookingInstant(content?.end_iso);
      if (!Number.isFinite(s) || !Number.isFinite(f)) continue;
      census.offers.push({
        contact_id: e.contact_id,
        start_iso: String(content!.start_iso),
        end_iso: String(content!.end_iso),
        source: "booking_in_flight",
        binding_hash: e.binding_hash,
      });
    }
  }
  const seen = new Set(census.offers.map((o) => o.binding_hash));
  for (const approval of approvals) {
    if (seen.has(approval.binding_hash)) continue;
    const offer = ownerApprovalOffer(approval, now);
    if (!offer || booked[offer.contact_id]) continue;
    seen.add(offer.binding_hash);
    census.offers.push(offer);
  }
  return census;
}

// ── GHL calendar and assignee ──────────────────────────────────────────────

export interface GhlDirectory {
  calendars: Array<{
    id: string;
    is_active: boolean | null;
    assigned_user_ids: string[];
    assignments_returned: boolean;
  }>;
  users: Array<{ id: string; email: string | null }>;
}

/** The rulebook target must be a live, active GHL calendar that holds the
 * owner's own GHL user, and that user must be his roster entry. */
export function checkOwnerCalendarTarget(directory: GhlDirectory): string[] {
  const target = RULES.calendar;
  const calendar = directory.calendars.find((c) => c.id === target.calendar_id);
  const roster = directory.users.filter((u) => u.email === target.scoper_email);
  if (
    !calendar || calendar.is_active !== true ||
    !calendar.assignments_returned ||
    !calendar.assigned_user_ids.includes(target.assigned_user_id) ||
    roster.length !== 1 || roster[0].id !== target.assigned_user_id
  ) {
    refuse("owner_calendar_unknown", {
      calendar_id: target.calendar_id,
      assigned_user_id: target.assigned_user_id,
    });
  }
  // Every calendar the owner is assigned to can hold one of his bookings.
  return directory.calendars.filter((c) =>
    c.assigned_user_ids.includes(target.assigned_user_id)
  ).map((c) => c.id);
}

/** GHL events that hold the owner's time on the visit's day. Same filter as
 * the appointment writer: other assignees and cancelled rows do not block. */
export function ghlBusyEvents(events: BookingObject[]): BookingObject[] {
  const seen = new Set<string>();
  const out: BookingObject[] = [];
  for (const event of events) {
    if (
      event.assignedUserId &&
      event.assignedUserId !== RULES.calendar.assigned_user_id
    ) continue;
    if (["cancelled", "invalid"].includes(String(event.appointmentStatus))) {
      continue;
    }
    const id = text(event.id);
    if (id) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    const s = bookingInstant(event.startTime),
      f = bookingInstant(event.endTime);
    if (!Number.isFinite(s) || !Number.isFinite(f) || f <= s) {
      refuse("ghl_calendar_unreadable", { reason: "event_times_malformed" });
    }
    out.push(event);
  }
  return out;
}

// ── Contact ───────────────────────────────────────────────────────────────

/** E.164 for an AU mobile/landline as GHL stores it, or null. */
export function e164(raw: unknown): string | null {
  const t = text(raw).replace(/[\s()-]/g, "");
  const v = t.startsWith("0") ? `+61${t.slice(1)}` : t;
  return /^\+[1-9]\d{7,14}$/.test(v) ? v : null;
}

export function ownerClientName(contact: BookingObject): string | null {
  const candidates = [
    [text(contact.firstName), text(contact.lastName)].filter(Boolean).join(
      " ",
    ),
    text(contact.name),
    text(contact.contactName),
  ];
  return candidates.find((n) => n && !isPhoneLikeName(n)) ?? null;
}

/** A street line carries a house or unit number; "Bassendean" alone is a
 * suburb, not a street. Unit/Apt/Shop and a leading comma may precede the
 * number (`Unit 5/12 Smith St`, `Apt 3, 20 Smith St`). */
export function ownerStreetLine(value: unknown): string | null {
  const street = text(value);
  return /^(?:(?:unit|apt|shop)\s*,?\s*|(?:,\s*))?(?:[A-Za-z]?\d+[A-Za-z]?\/)?(?:lot\s+)?\d/i
      .test(street)
    ? street
    : null;
}

/** The visit address: the GHL contact's street, else the recorded job
 * site's, plus the suburb the booking read publishes, never duplicated. */
export function ownerSiteAddress(
  contact: BookingObject,
  suburb: string,
  jobSite: { address?: unknown } | null = null,
): { address: string; street_source: "ghl_contact" | "job_site" } | null {
  const fromContact = ownerStreetLine(contact.address1);
  const street = fromContact ?? ownerStreetLine(jobSite?.address);
  if (!street || !suburb || suburb === SALES_BOOKING_NOT_GIVEN) return null;
  return {
    address: street.toLowerCase().includes(suburb.toLowerCase())
      ? street
      : `${street}, ${suburb}`,
    street_source: fromContact ? "ghl_contact" : "job_site",
  };
}

// ── Action ────────────────────────────────────────────────────────────────

export interface OwnerApprovalDeps {
  store: BookingApprovalStore;
  readWorkspace(
    resource: string,
    week: string,
  ): Promise<SalesBookingReadResponse>;
  /** GHL contact (id and location checked) plus the published suburb. The
   * executor reads the same pair at its press. */
  readLead(
    args: { contactId: string; opportunityId: string },
  ): Promise<{
    contact: BookingObject;
    suburb: string;
    job_site?: { address?: unknown; suburb?: unknown } | null;
  }>;
  readThread(contactId: string): Promise<SalesBookingMessage[]>;
  /** The opportunity's current GHL assignee, read live; throws when unread. */
  readOpportunityAssignee(opportunityId: string): Promise<string | null>;
  /** Throws when either the calendars or the users read is incomplete. */
  readGhlDirectory(): Promise<GhlDirectory>;
  /** One complete GHL window read; throws when incomplete. */
  readGhlEvents(
    selector: { userId: string } | { calendarId: string },
    startIso: string,
    endIso: string,
  ): Promise<BookingObject[]>;
  readOutlook(
    resource: string,
    startIso: string,
    endIso: string,
  ): Promise<OutlookRead>;
  /** Executor rows claimed since `sinceIso`, plus the approvals they ran. */
  readSystemOfferRecords(sinceIso: string): Promise<{
    executions: BookingObject[];
    approvals: BookingObject[];
  }>;
  envGet?: SalesBookingEnvGet;
  now?: () => Date;
}

export const HAND_SENT_TEXTS_NOTE =
  "Texts sent by hand outside this system cannot be checked by the machine. " +
  "Read the lead's thread for any time you offered by hand before approving.";

type OwnerInput = {
  /** Booking person whose lead this is; Marnin (Stratco) when omitted. */
  resource: string;
  step: BookingStep;
  case_id: string;
  contact_id: string;
  week_start: string;
  prepared_at: string | null;
  text?: string;
  visit?: unknown;
  offer?: unknown;
};

function parseOwnerInput(raw: unknown): OwnerInput {
  if (
    !obj(raw) || !["calendar", "message"].includes(raw.step) ||
    !text(raw.case_id) || !text(raw.contact_id) || !text(raw.week_start)
  ) refuse("invalid_owner_input", null, 400);
  const resource = raw.resource === undefined ? RULES.resource : raw.resource;
  if (
    typeof resource !== "string" ||
    !Object.hasOwn(SALES_BOOKING_SENDER_LINES, resource)
  ) refuse("booking_profile_required", null, 400);
  // Visits and offered slots follow the Stratco rulebook only.
  if (
    resource !== RULES.resource &&
    (raw.step !== "message" || raw.offer != null)
  ) refuse("stratco_profile_required", null, 400);
  if (raw.prepared_at != null && typeof raw.prepared_at !== "string") {
    refuse("invalid_owner_input", null, 400);
  }
  return {
    resource,
    step: raw.step,
    case_id: raw.case_id,
    contact_id: raw.contact_id,
    week_start: raw.week_start,
    prepared_at: raw.prepared_at ?? null,
    text: raw.text,
    visit: raw.visit,
    offer: raw.offer,
  };
}

export type OwnerApprovalResult =
  | {
    ok: true;
    dry_run: true;
    source: "owner";
    snapshot: BookingObject;
    content_hash: string;
    approval_id: string;
    checks: BookingObject;
  }
  | {
    ok: true;
    dry_run?: false;
    source: "owner";
    approval: BookingApprovalRecord;
    approval_id: string;
    checks: BookingObject;
  };

/** POST sales_booking_approval_write with `owner_input` (see the contract). */
export async function salesBookingOwnerApprovalAction(args: {
  auth: SalesBookingPackAuth;
  body: BookingObject;
  method: string;
  deps: OwnerApprovalDeps;
}): Promise<OwnerApprovalResult> {
  const { deps, body } = args;
  if (args.method !== "POST") {
    refuse("sales_booking_approval_write requires POST", null, 405);
  }
  if ("dry_run" in body && typeof body.dry_run !== "boolean") {
    refuse("invalid_dry_run", null, 400);
  }
  const dryRun = body.dry_run === true;
  // A preview reads and writes nothing, so a desk API key may run one. A
  // decision is the captain's signed session only.
  let email = "ops-api:api_key";
  if (!(dryRun && args.auth.mode === "api_key")) {
    email = assertSalesBookingStampWriteAuth(args.auth, deps.envGet);
    if (!args.auth.userId) refuse("approval_actor_required", null, 403);
  }
  const input = parseOwnerInput(body.owner_input);
  const decision = body.decision;
  if (!dryRun) {
    if (!["approved", "refused"].includes(decision)) {
      refuse("invalid_independent_approval", null, 400);
    }
    if (
      decision === "refused" &&
      (!text(body.reason) || String(body.reason).length > 1000)
    ) refuse("refusal_reason_required", null, 400);
    if (!input.prepared_at) refuse("owner_prepared_at_required", null, 400);
    if (typeof body.content_hash !== "string") {
      refuse("owner_content_hash_required", null, 400);
    }
  }

  const response = await deps.readWorkspace(input.resource, input.week_start);
  const now = (deps.now ?? (() => new Date()))(); // after slow reads
  if (response.resource.resource_id !== input.resource) {
    refuse("booking_profile_required", null, 400);
  }
  const profile = SALES_BOOKING_SENDER_LINES[input.resource].profile;
  const matches = response.cases.filter((r) =>
    r.contact_id === input.contact_id
  );
  const row: SalesBookingCase | undefined = matches[0];
  if (
    matches.length !== 1 || !row || row.id !== input.case_id ||
    row.resource_id !== input.resource
  ) refuse("booking_case_identity_ambiguous");

  const preparedAt = input.prepared_at ?? now.toISOString();
  const prepared = bookingInstant(preparedAt);
  if (
    !Number.isFinite(prepared) || prepared > now.getTime() ||
    now.getTime() - prepared >= BOOKING_APPROVAL_TTL_MS
  ) refuse("owner_preview_expired", { prepared_at: preparedAt });

  let lead: Awaited<ReturnType<OwnerApprovalDeps["readLead"]>>;
  try {
    lead = await deps.readLead({
      contactId: input.contact_id,
      opportunityId: row.id,
    });
  } catch {
    refuse("contact_unreadable");
  }
  if (text(lead.contact.id) && lead.contact.id !== input.contact_id) {
    refuse("booking_case_identity_ambiguous");
  }

  const checks: BookingObject = {
    rulebook: RULES.source,
    hand_sent_texts: "not_machine_checked",
    hand_sent_texts_note: HAND_SENT_TEXTS_NOTE,
  };
  const approving = dryRun || decision === "approved";
  // Whose lead is it, read live: a lead assigned to someone else never takes
  // this person's path or line.
  if (approving) {
    let assignee: string | null;
    try {
      if (!row.opportunity_id) throw new Error("no opportunity");
      assignee = await deps.readOpportunityAssignee(row.opportunity_id);
    } catch {
      refuse("opportunity_assignment_unreadable");
    }
    if (!salesBookingLeadBelongsTo(assignee, input.resource)) {
      refuse("lead_assigned_to_someone_else", {
        resource: input.resource,
        current_assignee: assignee,
      });
    }
  }

  // Build the exact content. Identity and route come from server truth only.
  let content: BookingObject;
  let visit: CheckedVisit | null = null;
  if (input.step === "message") {
    const t = input.text;
    if (typeof t !== "string" || !t.trim() || t.length > MAX_TEXT) {
      refuse("owner_message_text_required", { max_characters: MAX_TEXT }, 400);
    }
    // Company rule: no em or en dashes in outbound client text.
    if (/[\u2013\u2014]/.test(t)) {
      refuse("owner_message_text_has_dash", null, 400);
    }
    const recipient = e164(lead.contact.phone);
    if (!recipient) refuse("contact_phone_missing");
    // The text goes from the line of the person doing the visit; no fallback.
    const who = salesBookingSenderFor({
      scoper_user_id: response.resource.scoper_user_id,
      resource: response.resource.resource_id,
      profile,
    });
    if (!who.ok) refuse(who.reason, who.detail);
    checks.sender = {
      line: who.sender.line,
      person: who.sender.person,
      name: who.sender.name,
    };
    if (input.offer != null) visit = checkOwnerVisitRules(input.offer, now);
    content = {
      text: t,
      sender: who.sender.line,
      recipient,
      variant: "owner",
      offer: visit
        ? {
          window_start_iso: visit.window_start_iso,
          window_end_iso: visit.window_end_iso,
          end_iso: visit.end_iso,
        }
        : null,
    };
  } else {
    visit = checkOwnerVisitRules(input.visit, now);
    const name = ownerClientName(lead.contact);
    if (!name) refuse("contact_name_missing");
    if (
      !ownerStreetLine(lead.contact.address1) &&
      !ownerStreetLine(lead.job_site?.address)
    ) {
      refuse("contact_street_missing", {
        ghl_address1: text(lead.contact.address1) || null,
      });
    }
    const site = ownerSiteAddress(lead.contact, lead.suburb, lead.job_site);
    if (!site) refuse("contact_suburb_missing");
    const address = site.address;
    checks.address_street_source = site.street_source;
    content = {
      provider: "ghl",
      calendar_id: RULES.calendar.calendar_id,
      assigned_user_id: RULES.calendar.assigned_user_id,
      start_iso: visit.window_start_iso,
      end_iso: visit.end_iso,
      window_start_iso: visit.window_start_iso,
      window_end_iso: visit.window_end_iso,
      title: `Scope visit: ${name}`,
      address,
    };
  }
  const snapshot: BookingObject = {
    schema: SCHEMA,
    source: "owner",
    version: OWNER_APPROVAL_VERSION,
    step: input.step,
    case_id: row.id,
    contact_id: row.contact_id,
    resource: response.resource.resource_id,
    scoper_user_id: response.resource.scoper_user_id,
    week_start: response.week_start,
    id: `opp:${row.opportunity_id}`,
    profile,
    pack_revision: null,
    prepared_at: preparedAt,
    content_hash: null,
    content,
  };
  snapshot.content_hash = await bookingContentHash(snapshot);
  if (!dryRun && body.content_hash !== snapshot.content_hash) {
    refuse("owner_snapshot_changed", { snapshot });
  }

  if (approving) {
    let census: SystemOfferCensus;
    try {
      const since = new Date(
        now.getTime() - OWNER_OFFER_CENSUS_DAYS * 86_400_000,
      ).toISOString();
      const records = await deps.readSystemOfferRecords(since);
      census = systemOfferCensus(records.executions, records.approvals, now);
    } catch {
      refuse("system_offers_unreadable");
    }
    // A new text while an earlier one may or may not have reached the lead
    // risks a double text; a booking while one is mid-press risks a double
    // booking. Neither blocks the other step.
    if (
      input.step === "message" &&
      census.unsettled_messages.includes(row.contact_id!)
    ) {
      refuse("booking_step_requires_reconciliation", {
        reason: "a_text_to_this_lead_may_or_may_not_have_been_sent",
      });
    }
    if (
      input.step === "calendar" &&
      census.offers.some((o) =>
        o.contact_id === row.contact_id && o.source === "booking_in_flight"
      )
    ) {
      refuse("booking_step_requires_reconciliation", {
        reason: "a_booking_for_this_lead_is_mid_press",
      });
    }
    checks.system_offers = {
      open_offers: census.offers.length,
      unverified_texts: census.unverified_texts,
      census_days: OWNER_OFFER_CENSUS_DAYS,
    };
    if (census.booked[row.contact_id!]) {
      checks.contact_prior_system_bookings = census.booked[row.contact_id!];
    }
    if (input.step === "message") {
      let messages: SalesBookingMessage[];
      try {
        messages = await deps.readThread(row.contact_id!);
      } catch {
        refuse("thread_unreadable");
      }
      if (
        messages.some((m) =>
          messageDirection(m) === "outbound" && m.body === content.text
        )
      ) refuse("text_already_in_thread");
      checks.thread = { read: true, messages: messages.length };
    }
    if (visit) {
      Object.assign(
        checks,
        await checkOwnerVisitAvailability(visit, row, census, deps),
      );
    }
  }

  const approvalId = await bookingHash(snapshot);
  if (dryRun) {
    return {
      ok: true,
      dry_run: true,
      source: "owner",
      snapshot,
      content_hash: snapshot.content_hash,
      approval_id: approvalId,
      checks,
    };
  }
  const record: BookingApprovalRecord = {
    binding_hash: approvalId,
    step: input.step,
    resource: response.resource.resource_id,
    week_start: response.week_start,
    state: decision,
    reason: decision === "refused" ? body.reason : null,
    snapshot,
    approved_by_user_id: args.auth.userId!,
    approved_by_email: email,
    approved_at: now.toISOString(),
    expires_at: new Date(now.getTime() + BOOKING_APPROVAL_TTL_MS)
      .toISOString(),
  };
  const written = await deps.store.insert(record);
  if (
    written.state !== record.state || written.reason !== record.reason ||
    canonicalBookingJson(written.snapshot) !==
      canonicalBookingJson(record.snapshot)
  ) refuse("approval_decision_already_recorded");
  if (!(bookingInstant(written.expires_at) > now.getTime())) {
    refuse("approval_expired_requires_new_proposal");
  }
  return {
    ok: true,
    source: "owner",
    approval: written,
    approval_id: written.binding_hash,
    checks,
  };
}

/** GHL diary + every calendar the owner is on, his Outlook, and this
 * system's open offers, all on the visit's day. Any failed read refuses. */
async function checkOwnerVisitAvailability(
  visit: CheckedVisit,
  row: SalesBookingCase,
  census: SystemOfferCensus,
  deps: OwnerApprovalDeps,
): Promise<BookingObject> {
  let directory: GhlDirectory;
  try {
    directory = await deps.readGhlDirectory();
  } catch {
    refuse("owner_calendar_unreadable");
  }
  const calendarIds = checkOwnerCalendarTarget(directory);
  const dayStart = `${visit.date}T00:00:00+08:00`;
  const dayEnd = perthIso(Date.parse(dayStart) + 86_400_000);
  const batches: BookingObject[][] = [];
  try {
    batches.push(
      await deps.readGhlEvents(
        { userId: RULES.calendar.assigned_user_id },
        dayStart,
        dayEnd,
      ),
    );
    for (const calendarId of calendarIds) {
      batches.push(
        await deps.readGhlEvents({ calendarId }, dayStart, dayEnd),
      );
    }
  } catch {
    refuse("ghl_calendar_unreadable");
  }
  const events = ghlBusyEvents(batches.flat());
  const own = events.filter((e) => e.contactId === row.contact_id);
  if (own.length) {
    refuse("contact_already_booked_that_day", {
      events: own.map(eventSummary),
    });
  }
  const ghlClashes = events.filter((e) =>
    overlaps(
      visit.occupiedStart,
      visit.occupiedEnd,
      bookingInstant(e.startTime),
      bookingInstant(e.endTime),
    )
  );
  if (ghlClashes.length) {
    refuse("ghl_calendar_clash", {
      travel_buffer_minutes: RULES.travel_buffer_minutes,
      events: ghlClashes.map(eventSummary),
    });
  }
  let outlook: OutlookRead;
  try {
    outlook = await deps.readOutlook(RULES.resource, dayStart, dayEnd);
  } catch {
    outlook = { ok: false, reason: "outlook_read_failed" };
  }
  if (!outlook.ok) refuse("outlook_unreadable", { reason: outlook.reason });
  const outlookHits = outlookClashes(
    outlook.events,
    new Date(visit.occupiedStart).toISOString(),
    new Date(visit.occupiedEnd).toISOString(),
  );
  if (outlookHits.length) {
    refuse("outlook_calendar_clash", {
      mailbox: outlook.mailbox,
      travel_buffer_minutes: RULES.travel_buffer_minutes,
      events: outlookHits.map((e) => ({
        subject: e.subject,
        start: e.start,
        end: e.end,
      })),
    });
  }
  const others = census.offers.filter((o) => {
    if (o.contact_id !== row.contact_id) return true;
    if (o.source !== "owner_approval") return false;
    return o.start_iso !== visit.window_start_iso ||
      o.end_iso !== visit.end_iso;
  });
  const offerClashes = others.filter((o) =>
    overlaps(
      visit.occupiedStart,
      visit.occupiedEnd,
      bookingInstant(o.start_iso),
      bookingInstant(o.end_iso),
    )
  );
  if (offerClashes.length) {
    refuse("system_offer_clash", {
      offers: offerClashes.map((
        { contact_id, start_iso, end_iso, source },
      ) => ({
        contact_id,
        start_iso,
        end_iso,
        source,
      })),
    });
  }
  const offeredThatDay = new Set(
    others.filter((o) => perthDate(bookingInstant(o.start_iso)) === visit.date)
      .map((o) => o.contact_id),
  );
  const dayCount = events.length + offeredThatDay.size + 1;
  if (dayCount > RULES.max_per_day) {
    refuse("daily_capacity_reached", {
      ghl_events: events.length,
      open_offers: offeredThatDay.size,
      max_per_day: RULES.max_per_day,
    });
  }
  return {
    ghl: {
      calendar_id: RULES.calendar.calendar_id,
      assigned_user_id: RULES.calendar.assigned_user_id,
      calendars_read: calendarIds,
      events_that_day: events.length,
      clashes: 0,
    },
    outlook: { mailbox: outlook.mailbox, clashes: 0 },
    occupied: {
      start_iso: perthIso(visit.occupiedStart),
      end_iso: perthIso(visit.occupiedEnd),
      travel_buffer_minutes: RULES.travel_buffer_minutes,
    },
    day_count_with_this_visit: dayCount,
    offer_clashes: 0,
  };
}

function eventSummary(e: BookingObject) {
  return {
    id: e.id ?? null,
    title: e.title ?? null,
    start: e.startTime ?? null,
    end: e.endTime ?? null,
    calendar_id: e.calendarId ?? null,
  };
}

// ── Read composition ──────────────────────────────────────────────────────

/** Next permitted visit dates (Perth), for the owner's day choice. */
export function ownerBookableDates(now: Date, horizonDays = 14): string[] {
  const out: string[] = [];
  const today = perthDate(now.getTime());
  for (let i = 0; i < horizonDays; i++) {
    const noon = Date.parse(`${today}T12:00:00+08:00`) + i * 86_400_000;
    const date = perthDate(noon);
    if (!RULES.days.includes(perthWeekday(noon))) continue;
    // A day whose last possible arrival has passed is not offered.
    const lastArrival = atPerth(date, RULES.day_end) -
      RULES.visit_minutes * 60_000;
    if (lastArrival > now.getTime()) out.push(date);
  }
  return out;
}

export function ownerRulebookView(now: Date): BookingObject {
  return {
    profile: RULES.profile,
    source: RULES.source,
    timezone: RULES.timezone,
    utc_offset: RULES.utc_offset,
    days: [...RULES.days],
    bookable_dates: ownerBookableDates(now),
    day_start: RULES.day_start,
    day_end: RULES.day_end,
    window_min_minutes: RULES.window_min_minutes,
    window_max_minutes: RULES.window_max_minutes,
    visit_minutes: RULES.visit_minutes,
    travel_buffer_minutes: RULES.travel_buffer_minutes,
    max_per_day: RULES.max_per_day,
    protected_bands: RULES.protected_bands.map((b) => ({ ...b })),
    sender: RULES.sender,
    calendar: { ...RULES.calendar },
  };
}

/** Live owner-authored approval rows, newest first, or throws. */
export type OwnerApprovalReader = (
  sinceIso: string,
  /** Booking person whose approvals to read; Marnin when omitted. */
  resource?: string,
) => Promise<BookingApprovalRecord[]>;

/** Adds `owner_booking` to every case and `owner_approval_write` to the flow. */
export async function applyOwnerBooking(
  response: SalesBookingReadResponse,
  readOwnerApprovals: OwnerApprovalReader | null,
  now = new Date(),
): Promise<SalesBookingReadResponse> {
  const result = structuredClone(response);
  const stratco = result.resource.resource_id === RULES.resource;
  // Nithin and Khairo take owner-authored texts too (no visit, no slot).
  const person = Object.hasOwn(
    SALES_BOOKING_SENDER_LINES,
    result.resource.resource_id,
  );
  let approvals: BookingApprovalRecord[] | null = null;
  let readError: string | null = null;
  if (person && readOwnerApprovals) {
    try {
      approvals = await readOwnerApprovals(
        new Date(now.getTime() - BOOKING_APPROVAL_TTL_MS).toISOString(),
        result.resource.resource_id,
      );
    } catch {
      readError = "owner_approvals_unreadable";
    }
  }
  const counts = new Map<string | null, number>();
  for (const row of result.cases) {
    counts.set(row.contact_id, (counts.get(row.contact_id) ?? 0) + 1);
  }
  const rulebook = stratco ? ownerRulebookView(now) : null;
  result.booking_flow = {
    ...result.booking_flow,
    owner_approval_write: person ? OWNER_APPROVAL_VERSION : null,
    owner_rulebook: rulebook,
    hand_sent_texts: "not_machine_checked",
    hand_sent_texts_note: HAND_SENT_TEXTS_NOTE,
    ...(readError ? { owner_approval_read_error: readError } : {}),
  };
  for (const row of result.cases) {
    const model = row.booking_read_model;
    const window = model?.proposal?.window;
    const engineProposal = !!model?.pack_revision && obj(model?.proposal);
    const eligible = person && !!row.contact_id &&
      counts.get(row.contact_id) === 1;
    const live = approvals === null
      ? null
      : approvals.filter((a) =>
        a.snapshot?.contact_id === row.contact_id &&
        a.snapshot?.case_id === row.id &&
        now.getTime() < Math.min(
            bookingInstant(a.expires_at),
            bookingInstant(a.approved_at) + BOOKING_APPROVAL_TTL_MS,
          ) &&
        now.getTime() >= bookingInstant(a.approved_at)
      ).map((a) => ({
        approval_id: a.binding_hash,
        step: a.step,
        state: a.state,
        reason: a.reason,
        approved_by_email: a.approved_by_email,
        approved_at: a.approved_at,
        expires_at: a.expires_at,
        content: a.snapshot?.content ?? null,
      }));
    (row as SalesBookingCase & { owner_booking?: BookingObject })
      .owner_booking = {
        version: OWNER_APPROVAL_VERSION,
        eligible,
        reason: eligible
          ? null
          : !person
          ? "booking_profile_required"
          : "booking_case_contact_ambiguous",
        /** Which approvals this lead can take: a visit only on Stratco. */
        steps: !eligible ? [] : stratco ? ["message", "calendar"] : ["message"],
        engine_proposal: engineProposal,
        engine_window: engineProposal && obj(window)
          ? { start: window.start ?? null, end: window.end ?? null }
          : null,
        rulebook,
        approvals: eligible ? live : null,
      };
  }
  return result;
}
