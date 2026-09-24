/** Live availability for the booking screen, read on the server.
 *
 * Before this, `booking_flow.calendar_read` was hard-coded to
 * `could_not_read / person_wide_calendars_and_prior_offer_ledger_not_connected`
 * unless the Python engine had published a pack from a terminal. This step
 * reads the person's GHL calendars live at every `sales_booking_read` (and at
 * every approval press, through the same workspace read) and publishes:
 *
 *  - `booking_flow.calendar_read`: `read`, or a named reason for that person.
 *  - `booking_flow.commitments`: open offers this system made (sent texts
 *    that name a slot, live owner approvals, bookings mid-press), from the
 *    same census the owner press uses. Null when that census is unreadable.
 *  - `booking_flow.free_times`: per bookable day, the arrival times at which
 *    a 30-minute visit fits with travel before and after it.
 *  - per case `free_times`: the same, with travel from that lead's suburb.
 *
 * GHL is the source. Outlook events the read already fetched for the diary
 * are counted as busy too (no extra Outlook read). Reads only; no writes.
 * Contract: docs/sales-booking-live-availability.md.
 */
import { bookingInstant } from "../_shared/booking_approval_gate.ts";
import type { BookingObject } from "./sales_booking_confirmation.ts";
import type {
  SalesBookingCase,
  SalesBookingDiaryEntry,
  SalesBookingReadResponse,
} from "./sales_booking_read.ts";
import {
  type GhlDirectory,
  OWNER_OFFER_CENSUS_DAYS,
  perthIso,
  STRATCO_BOOKING_RULEBOOK,
  type SystemOfferCensus,
  systemOfferCensus,
} from "./sales_booking_owner_approval.ts";
import { createOwnerApprovalDeps } from "./sales_booking_execute_live.ts";
import { ghlRead } from "./sales_booking_read.ts";
import {
  SALES_BOOKING_ON_SITE_MINUTES,
  SALES_BOOKING_TRAVEL_MODEL,
  salesBookingSuburbByUnambiguousContact,
  salesBookingSuburbPoint,
  salesBookingTravelMinutes,
} from "./sales_booking_travel.ts";

export const SALES_BOOKING_AVAILABILITY_VERSION = "live-availability-v1";
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const PERTH_OFFSET_MS = 8 * 3_600_000;
const MINUTE = 60_000;

export interface AvailabilityPerson {
  name: string;
  /** Confirmed against the live GHL roster (22-24 Sep 2026 directory). */
  ghl_user_id: string;
  roster_emails: readonly string[];
  days: readonly string[];
  day_start: string;
  day_end: string;
  weekday_start: Readonly<Record<string, string>>;
  max_per_day: number;
  protected_bands: ReadonlyArray<
    { weekday: string; start: string; end: string; label: string }
  >;
  /** Whether this system can send an offer for this person's leads. */
  system_offers: boolean;
  rules_source: string;
}

/** Days and hours are each profile's own rules in the wiki
 * `secureworks-scope-booking/profiles/*.json` (read 24 Sep 2026). The on-site
 * length and travel are the owner's 24 Sep rule, the same for everyone. */
export const SALES_BOOKING_AVAILABILITY_PEOPLE: Readonly<
  Record<string, AvailabilityPerson>
> = Object.freeze({
  marnin: {
    name: "Marnin",
    ghl_user_id: STRATCO_BOOKING_RULEBOOK.calendar.assigned_user_id,
    roster_emails: [STRATCO_BOOKING_RULEBOOK.calendar.scoper_email],
    days: STRATCO_BOOKING_RULEBOOK.days,
    day_start: STRATCO_BOOKING_RULEBOOK.day_start,
    day_end: STRATCO_BOOKING_RULEBOOK.day_end,
    weekday_start: {},
    max_per_day: STRATCO_BOOKING_RULEBOOK.max_per_day,
    protected_bands: STRATCO_BOOKING_RULEBOOK.protected_bands,
    system_offers: true,
    rules_source: STRATCO_BOOKING_RULEBOOK.source,
  },
  nithin: {
    name: "Nithin",
    ghl_user_id: "ERAycY7r6KZ8OA66WQCy",
    roster_emails: ["nithin@secureworkswa.com.au", "nithinsilas@outlook.com"],
    days: ["Mon", "Tue", "Thu", "Fri"],
    day_start: "08:00",
    day_end: "16:30",
    weekday_start: { Mon: "12:00" },
    max_per_day: 5,
    protected_bands: [],
    system_offers: false,
    rules_source: "secureworks-wiki profiles/patio-nithin.json",
  },
  khairo: {
    name: "Khairo",
    ghl_user_id: "RgDWTnYL6zL3eJA6nLht",
    roster_emails: ["khairo@secureworkswa.com.au", "khairopomare@outlook.com"],
    days: ["Mon", "Tue", "Wed", "Thu", "Fri"],
    day_start: "08:00",
    day_end: "16:30",
    weekday_start: {},
    max_per_day: 6,
    protected_bands: [],
    system_offers: false,
    rules_source: "secureworks-wiki profiles/fencing-khairo.json",
  },
});

export type GhlRead<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface AvailabilityInput {
  resource: string;
  week: { week_start: string; since: string; until_exclusive: string };
  now: Date;
  directory: GhlRead<GhlDirectory>;
  /** Raw GHL events: the person's user-id window plus every calendar they are on. */
  events: GhlRead<BookingObject[]>;
  /** Raw GHL blocked-off time for the person. */
  blocked: GhlRead<BookingObject[]>;
  /** Outlook half of the diary the read already fetched. */
  outlook: {
    state: "read" | "failed" | "not_configured";
    reason: string | null;
    entries: SalesBookingDiaryEntry[];
    malformed_dropped?: number;
  };
  census: GhlRead<SystemOfferCensus>;
  cases: SalesBookingCase[];
}

interface Busy {
  start: number;
  end: number;
  source: "ghl" | "ghl_blocked" | "outlook" | "offer" | "protected_band";
  label: string | null;
  location: string | null;
  contact_id: string | null;
  event_id?: string | null;
  /** Protected bands already carry their fixed travel buffer. */
  travel_exempt: boolean;
}

const text = (v: unknown) => typeof v === "string" ? v.trim() : "";
const perthDate = (ms: number) => perthIso(ms).slice(0, 10);
const perthWeekday = (ms: number) =>
  WEEKDAYS[new Date(ms + PERTH_OFFSET_MS).getUTCDay()];
const atPerth = (date: string, hhmm: string) =>
  Date.parse(`${date}T${hhmm}:00+08:00`);
const ceil5 = (ms: number) => Math.ceil(ms / (5 * MINUTE)) * 5 * MINUTE;
const floor5 = (ms: number) => Math.floor(ms / (5 * MINUTE)) * 5 * MINUTE;

/** The GHL user must be exactly one roster entry by recorded email, and be
 * the recorded id. Then every active calendar that lists that user. */
export function personGhlCalendars(
  person: AvailabilityPerson,
  directory: GhlDirectory,
): { calendars: string[] } | {
  reason: string;
  state: "could_not_read" | "not_configured";
} {
  const roster = directory.users.filter((u) =>
    !!u.email && person.roster_emails.includes(u.email.toLowerCase())
  );
  if (roster.length !== 1 || roster[0].id !== person.ghl_user_id) {
    return { state: "could_not_read", reason: "ghl_user_not_confirmed" };
  }
  if (!directory.calendars.every((c) => c.assignments_returned)) {
    return {
      state: "could_not_read",
      reason: "ghl_calendar_assignments_unreadable",
    };
  }
  const calendars = directory.calendars.filter((c) =>
    c.is_active === true && c.assigned_user_ids.includes(person.ghl_user_id)
  ).map((c) => c.id);
  if (!calendars.length) {
    return { state: "not_configured", reason: "person_has_no_ghl_calendar" };
  }
  return { calendars };
}

/** The person's own, non-cancelled GHL rows. Other assignees never block. */
function ghlBusy(
  rows: BookingObject[],
  person: AvailabilityPerson,
  source: "ghl" | "ghl_blocked",
): Busy[] | null {
  const seen = new Set<string>();
  const out: Busy[] = [];
  for (const row of rows) {
    const assignee = text(row.assignedUserId);
    if (assignee && assignee !== person.ghl_user_id) continue;
    const status = text(row.appointmentStatus).toLowerCase();
    if (status === "cancelled" || status === "invalid") continue;
    const id = text(row.id);
    if (id) {
      if (seen.has(`${source}:${id}`)) continue;
      seen.add(`${source}:${id}`);
    }
    const start = bookingInstant(row.startTime),
      end = bookingInstant(row.endTime);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return null;
    }
    out.push({
      start,
      end,
      source,
      label: text(row.title) || null,
      location: text(row.address) || null,
      contact_id: text(row.contactId) || null,
      event_id: id || null,
      travel_exempt: false,
    });
  }
  return out;
}

interface ArrivalWindow {
  from_iso: string;
  to_iso: string;
  minutes: number;
  travel_before_minutes: number;
  travel_before_basis: string;
  travel_after_minutes: number | null;
  travel_after_basis: string | null;
}

/** Arrival times on one day at which a 30-minute visit at `location` fits:
 * after the previous booking plus travel from it, and finished with travel
 * to the next one before it starts. No travel from home at day start. */
export function arrivalWindows(
  busy: Busy[],
  dayStart: number,
  dayEnd: number,
  earliest: number,
  location: string | null,
): ArrivalWindow[] {
  return arrivalWindowsWithTravelStatus(
    busy,
    dayStart,
    dayEnd,
    earliest,
    location,
  ).windows;
}

function arrivalWindowsWithTravelStatus(
  busy: Busy[],
  dayStart: number,
  dayEnd: number,
  earliest: number,
  location: string | null,
): { windows: ArrivalWindow[]; travel_unknown: boolean } {
  const onSite = SALES_BOOKING_ON_SITE_MINUTES * MINUTE;
  const items = busy.filter((b) => b.end > dayStart && b.start < dayEnd)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out: ArrivalWindow[] = [];
  let travelUnknown = false;
  let prev: Busy | null = null;
  const travel = (from: string | null, to: string | null, exempt: boolean) =>
    exempt
      ? { minutes: 0, basis: "protected_band_buffer" }
      : salesBookingTravelMinutes(from, to);
  const push = (next: Busy | null) => {
    const before = prev
      ? travel(prev.location, location, prev.travel_exempt)
      : { minutes: 0, basis: "day_start" };
    const after = next
      ? travel(location, next.location, next.travel_exempt)
      : null;
    if (before.minutes === null || after?.minutes === null) {
      const possibleFrom = ceil5(Math.max(
        dayStart,
        earliest,
        prev
          ? prev.end + (before.minutes ?? 0) * MINUTE
          : dayStart,
      ));
      const possibleLatest = next
        ? next.start - ((after?.minutes ?? 0) * MINUTE) - onSite
        : dayEnd - onSite;
      const possibleTo = floor5(Math.min(possibleLatest, dayEnd - onSite));
      if (possibleTo >= possibleFrom) travelUnknown = true;
      return;
    }
    const from = ceil5(Math.max(
      dayStart,
      earliest,
      prev ? prev.end + before.minutes * MINUTE : dayStart,
    ));
    const latest = next
      ? next.start - (after!.minutes * MINUTE) - onSite
      : dayEnd - onSite;
    const to = floor5(Math.min(latest, dayEnd - onSite));
    if (to < from) return;
    out.push({
      from_iso: perthIso(from),
      to_iso: perthIso(to),
      minutes: (to - from) / MINUTE,
      travel_before_minutes: before.minutes,
      travel_before_basis: before.basis,
      travel_after_minutes: after ? after.minutes : null,
      travel_after_basis: after ? after.basis : null,
    });
  };
  for (const item of items) {
    push(item);
    if (!prev || item.end > prev.end) prev = item;
  }
  push(null);
  return { windows: out, travel_unknown: travelUnknown };
}

function bookingDates(person: AvailabilityPerson, weekStart: string): string[] {
  const out: string[] = [];
  const monday = Date.parse(`${weekStart}T12:00:00+08:00`);
  for (let i = 0; i < 7; i++) {
    const noon = monday + i * 86_400_000;
    if (person.days.includes(perthWeekday(noon))) out.push(perthDate(noon));
  }
  return out;
}

function busySummary(b: Busy) {
  return {
    start_iso: perthIso(b.start),
    end_iso: perthIso(b.end),
    source: b.source,
    label: b.label,
    location: b.location,
  };
}

/** Pure. Everything the screen needs from the reads above. */
export function computeSalesBookingAvailability(
  input: AvailabilityInput,
): {
  calendar_read: BookingObject;
  commitments: BookingObject[] | null;
  commitments_read: BookingObject;
  free_times: BookingObject | null;
  case_free_times: Record<string, BookingObject>;
} {
  const person = SALES_BOOKING_AVAILABILITY_PEOPLE[input.resource];
  const asOf = input.now.toISOString();
  const base = {
    provider: "ghl",
    source: "server_live_read",
    version: SALES_BOOKING_AVAILABILITY_VERSION,
    as_of: asOf,
    stale: false,
  };
  const unreadCommitments = (reason: string) => ({
    state: "could_not_read",
    reason,
    as_of: asOf,
    stale: false,
  });
  const none = (state: string, reason: string, extra: BookingObject = {}) => ({
    calendar_read: {
      ...base,
      state,
      reason,
      person: person?.name ?? input.resource,
      occupied_intervals: null,
      ...extra,
    },
    commitments: null,
    commitments_read: unreadCommitments("calendar_not_read"),
    free_times: null,
    case_free_times: {},
  });
  if (!person) return none("not_configured", "person_not_configured");
  if (!input.directory.ok) {
    return none(
      "could_not_read",
      `ghl_calendar_directory_unreadable: ${input.directory.reason}`,
    );
  }
  const found = personGhlCalendars(person, input.directory.value);
  if ("reason" in found) {
    return none(found.state, found.reason, { ghl_user_id: person.ghl_user_id });
  }
  const identity = {
    person: person.name,
    ghl_user_id: person.ghl_user_id,
    calendars: found.calendars,
  };
  if (!input.events.ok) {
    return none(
      "could_not_read",
      `ghl_events_unreadable: ${input.events.reason}`,
      identity,
    );
  }
  if (!input.blocked.ok) {
    return none(
      "could_not_read",
      `ghl_blocked_slots_unreadable: ${input.blocked.reason}`,
      identity,
    );
  }
  const events = ghlBusy(input.events.value, person, "ghl");
  const blocked = ghlBusy(input.blocked.value, person, "ghl_blocked");
  if (!events || !blocked) {
    return none("could_not_read", "ghl_event_times_malformed", identity);
  }
  const caveats: string[] = [];
  const droppedOutlookCount = input.outlook.malformed_dropped ?? 0;
  const outlookMalformedDropped = Number.isInteger(droppedOutlookCount) &&
      droppedOutlookCount > 0
    ? droppedOutlookCount
    : 0;
  if (outlookMalformedDropped) {
    caveats.push(`outlook_malformed_dropped: ${outlookMalformedDropped}`);
  }
  const outlook: Busy[] = [];
  if (input.outlook.state === "read") {
    for (const e of input.outlook.entries) {
      if (e.source !== "outlook" || !e.blocks_capacity) continue;
      const s = bookingInstant(e.start), f = bookingInstant(e.end);
      if (!Number.isFinite(s) || !Number.isFinite(f) || f <= s) continue;
      outlook.push({
        start: s,
        end: f,
        source: "outlook",
        label: e.title,
        location: e.location,
        contact_id: null,
        travel_exempt: false,
      });
    }
  } else if (input.outlook.state === "failed") {
    caveats.push(`outlook_unread: ${input.outlook.reason ?? "unknown"}`);
  }
  const ghlEventIds = new Set(events.flatMap((e) =>
    e.source === "ghl" && e.event_id ? [e.event_id] : []
  ));
  const outlookNotInGhl = input.outlook.state === "read"
    ? input.outlook.entries.filter((o) =>
      o.source === "outlook" && o.blocks_capacity &&
      (!o.mirror_of_ghl_event_id ||
        !ghlEventIds.has(o.mirror_of_ghl_event_id))
    ).length
    : 0;

  const suburbByContact = salesBookingSuburbByUnambiguousContact(input.cases);
  for (const e of events) {
    if (!e.location && e.contact_id) {
      e.location = suburbByContact.get(e.contact_id) ?? null;
    }
  }

  // Open offers. Only a profile this system can send for has any.
  let offers: Busy[] = [];
  let commitments: BookingObject[] | null = null;
  let commitmentsRead: BookingObject;
  if (!person.system_offers) {
    commitments = [];
    commitmentsRead = {
      state: "read",
      reason: "system_sends_no_offers_for_this_person",
      as_of: asOf,
      stale: false,
      hand_sent_texts: "not_machine_checked",
    };
  } else if (!input.census.ok) {
    commitmentsRead = unreadCommitments(
      `system_offers_unreadable: ${input.census.reason}`,
    );
  } else {
    const bookedInGhl = new Set(
      events.map((e) => e.contact_id).filter((c): c is string => !!c),
    );
    const live = input.census.value.offers.filter((o) =>
      !bookedInGhl.has(o.contact_id)
    );
    commitments = live.map((o) => ({
      id: o.binding_hash,
      contact_id: o.contact_id,
      state: o.source === "booking_in_flight" ? "agreed" : "offered",
      start_iso: o.start_iso,
      end_iso: o.end_iso,
      source: o.source,
      as_of: asOf,
      stale: false,
    }));
    offers = live.map((o) => ({
      start: bookingInstant(o.start_iso),
      end: bookingInstant(o.end_iso),
      source: "offer" as const,
      label: null,
      location: suburbByContact.get(o.contact_id) ?? null,
      contact_id: o.contact_id,
      travel_exempt: false,
    }));
    commitmentsRead = {
      state: "read",
      reason: null,
      as_of: asOf,
      stale: false,
      census_days: OWNER_OFFER_CENSUS_DAYS,
      sources: [
        "sent_texts_naming_a_slot",
        "live_owner_approvals",
        "bookings_mid_press",
      ],
      booked_in_ghl_dropped: input.census.value.offers.length - live.length,
      unverified_texts: input.census.value.unverified_texts.length,
      hand_sent_texts: "not_machine_checked",
    };
  }

  const now = input.now.getTime();
  const busyBase = [...events, ...blocked, ...outlook];
  const onSite = SALES_BOOKING_ON_SITE_MINUTES * MINUTE;
  const days = bookingDates(person, input.week.week_start).map((date) => {
    const weekday = perthWeekday(Date.parse(`${date}T12:00:00+08:00`));
    const dayStart = atPerth(
      date,
      person.weekday_start[weekday] ?? person.day_start,
    );
    const dayEnd = atPerth(date, person.day_end);
    const bands: Busy[] = person.protected_bands.filter((b) =>
      b.weekday === weekday
    ).map((b) => ({
      start: atPerth(date, b.start) -
        STRATCO_BOOKING_RULEBOOK.travel_buffer_minutes * MINUTE,
      end: atPerth(date, b.end) +
        STRATCO_BOOKING_RULEBOOK.travel_buffer_minutes * MINUTE,
      source: "protected_band",
      label: b.label,
      location: null,
      contact_id: null,
      travel_exempt: true,
    }));
    const inDay = (b: Busy) =>
      b.end > atPerth(date, "00:00") &&
      b.start < atPerth(date, "00:00") + 86_400_000;
    const busy = [...busyBase, ...offers, ...bands].filter(inDay);
    const ghlCount = events.filter(inDay).length;
    const offeredContacts = new Set(
      offers.filter(inDay).map((o) => o.contact_id),
    );
    const count = ghlCount + offeredContacts.size;
    const state = dayEnd - onSite <= now
      ? "past"
      : count >= person.max_per_day
      ? "full"
      : "open";
    const availability = state === "open"
      ? arrivalWindowsWithTravelStatus(busy, dayStart, dayEnd, now, null)
      : { windows: [], travel_unknown: false };
    const dayState = state === "open" && !availability.windows.length
      ? availability.travel_unknown ? "travel_unknown" : "no_time_left"
      : state;
    return {
      date,
      weekday,
      state: dayState,
      day_start: person.weekday_start[weekday] ?? person.day_start,
      day_end: person.day_end,
      booked: count,
      max_per_day: person.max_per_day,
      busy: busy.sort((a, b) => a.start - b.start).map(busySummary),
      arrival_windows: availability.windows,
      _busy: busy,
      _dayStart: dayStart,
      _dayEnd: dayEnd,
      _ghlCount: ghlCount,
      _offeredContactIds: [...offeredContacts],
    };
  });

  const caseFree: Record<string, BookingObject> = {};
  for (const row of input.cases) {
    if (!row.contact_id) continue;
    caseFree[row.id] = {
      location: {
        suburb: row.suburb,
        known: salesBookingSuburbPoint(row.suburb) !== null,
      },
      days: days.map((d) => {
        const caseCount = d._ghlCount + d._offeredContactIds.filter((id) =>
          id !== row.contact_id
        ).length;
        const caseDayState = d.state === "past"
          ? "past"
          : caseCount >= d.max_per_day
          ? "full"
          : "open";
        const caseAvailability = caseDayState === "past" ||
            caseDayState === "full"
          ? { windows: [], travel_unknown: false }
          : arrivalWindowsWithTravelStatus(
            d._busy.filter((b) => b.contact_id !== row.contact_id),
            d._dayStart,
            d._dayEnd,
            now,
            row.suburb,
          );
        const state = caseAvailability.windows.length
          ? "open"
          : caseAvailability.travel_unknown
          ? "travel_unknown"
          : caseDayState === "past" || caseDayState === "full"
          ? caseDayState
          : "no_time_left";
        return {
          date: d.date,
          state,
          already_booked_that_day: d._busy.some((b) =>
            b.source === "ghl" && b.contact_id === row.contact_id
          ),
          arrival_windows: caseAvailability.windows,
        };
      }),
    };
  }

  const occupied = [...busyBase, ...offers].sort((a, b) => a.start - b.start)
    .map(busySummary);
  return {
    calendar_read: {
      ...base,
      state: "read",
      reason: null,
      ...identity,
      occupied_intervals: occupied,
      ghl_events: events.length,
      ghl_blocked_slots: blocked.length,
      outlook: {
        state: input.outlook.state,
        events: outlook.length,
        not_in_ghl: outlookNotInGhl,
      },
      caveats,
    },
    commitments,
    commitments_read: commitmentsRead,
    free_times: outlookMalformedDropped ? null : {
      version: SALES_BOOKING_AVAILABILITY_VERSION,
      as_of: asOf,
      person: person.name,
      rule: {
        on_site_minutes: SALES_BOOKING_ON_SITE_MINUTES,
        travel: { ...SALES_BOOKING_TRAVEL_MODEL },
        days: [...person.days],
        day_start: person.day_start,
        day_end: person.day_end,
        weekday_start: { ...person.weekday_start },
        max_per_day: person.max_per_day,
        protected_bands: person.protected_bands.map((b) => ({
          ...b,
          buffer_minutes: STRATCO_BOOKING_RULEBOOK.travel_buffer_minutes,
        })),
        source: person.rules_source,
        note: "Intervals needing travel to or from an unknown location are " +
          "withheld. Each case's free_times uses that lead's suburb.",
      },
      days: days.map(({
        _busy,
        _dayStart,
        _dayEnd,
        _ghlCount,
        _offeredContactIds,
        ...d
      }) => d),
    },
    case_free_times: outlookMalformedDropped ? {} : caseFree,
  };
}

export interface SalesBookingAvailabilityDeps {
  readGhlDirectory(): Promise<GhlDirectory>;
  readGhlEvents(
    selector: { userId: string } | { calendarId: string; userId: string },
    startIso: string,
    endIso: string,
  ): Promise<BookingObject[]>;
  readGhlBlockedSlots(
    userId: string,
    startIso: string,
    endIso: string,
  ): Promise<BookingObject[]>;
  readSystemOfferRecords(sinceIso: string): Promise<{
    executions: BookingObject[];
    approvals: BookingObject[];
  }>;
  now?: () => Date;
}

const failure = (e: unknown) =>
  (e as Error)?.message
    ? String((e as Error).message).slice(0, 200)
    : "unknown";

/** Runs the reads, then overwrites `booking_flow.calendar_read` and
 * `commitments` with the live answer and adds `free_times`. */
export async function applySalesBookingAvailability(
  response: SalesBookingReadResponse,
  deps: SalesBookingAvailabilityDeps,
): Promise<SalesBookingReadResponse> {
  const resource = response.resource.resource_id;
  const person = SALES_BOOKING_AVAILABILITY_PEOPLE[resource];
  const week = response.week;
  const read = async <T>(run: () => Promise<T>): Promise<GhlRead<T>> => {
    try {
      return { ok: true, value: await run() };
    } catch (e) {
      return { ok: false, reason: failure(e) };
    }
  };
  const directory = await read(() => deps.readGhlDirectory());
  let events: GhlRead<BookingObject[]> = { ok: false, reason: "not_attempted" };
  let blocked: GhlRead<BookingObject[]> = {
    ok: false,
    reason: "not_attempted",
  };
  if (person && directory.ok) {
    const found = personGhlCalendars(person, directory.value);
    if (!("reason" in found)) {
      events = await read(async () => {
        const batches = [
          await deps.readGhlEvents(
            { userId: person.ghl_user_id },
            week.since,
            week.until_exclusive,
          ),
        ];
        for (const calendarId of found.calendars) {
          batches.push(
            await deps.readGhlEvents(
              { calendarId, userId: person.ghl_user_id },
              week.since,
              week.until_exclusive,
            ),
          );
        }
        return batches.flat();
      });
      if (events.ok) {
        blocked = await read(() =>
          deps.readGhlBlockedSlots(
            person.ghl_user_id,
            week.since,
            week.until_exclusive,
          )
        );
      }
    }
  }
  const now = (deps.now ?? (() => new Date()))();
  const census: GhlRead<SystemOfferCensus> = person?.system_offers
    ? await read(async () => {
      const since = new Date(
        now.getTime() - OWNER_OFFER_CENSUS_DAYS * 86_400_000,
      ).toISOString();
      const records = await deps.readSystemOfferRecords(since);
      return systemOfferCensus(records.executions, records.approvals, now);
    })
    : { ok: false, reason: "not_applicable" };
  const outlookSource = response.diary_read?.sources?.outlook;
  const computed = computeSalesBookingAvailability({
    resource,
    week,
    now,
    directory,
    events,
    blocked,
    outlook: {
      state: outlookSource?.state ?? "not_configured",
      reason: outlookSource?.reason ?? null,
      entries: (response.diary ?? []).filter((e) => e.source === "outlook"),
      malformed_dropped: outlookSource?.malformed_dropped ?? 0,
    },
    census,
    cases: response.cases,
  });
  const flow = { ...(response.booking_flow ?? {}) };
  delete flow.published_calendar_read;
  // A published engine census that is still fresh adds its holds (never
  // removes ours): offers it saw in hand-read threads stay blocked.
  let commitments = computed.commitments;
  if (
    commitments && Array.isArray(flow.commitments) &&
    flow.commitments_read?.state === "read"
  ) {
    const ids = new Set(commitments.map((c) => c.id));
    commitments = [
      ...commitments,
      ...flow.commitments.filter((c: BookingObject) => !ids.has(c.id)),
    ];
  }
  return {
    ...response,
    booking_flow: {
      ...flow,
      calendar_read: computed.calendar_read,
      commitments,
      commitments_read: computed.commitments_read,
      free_times: computed.free_times,
    },
    cases: response.cases.map((row) => ({
      ...row,
      free_times: computed.case_free_times[row.id] ?? null,
    })),
  };
}

/** Production reads: the owner press's own GHL directory, events and offer
 * census readers, plus GHL blocked-off time. Reads only. */
export function createSalesBookingAvailabilityDeps(
  client: Parameters<typeof createOwnerApprovalDeps>[0],
): SalesBookingAvailabilityDeps {
  const owner = createOwnerApprovalDeps(client);
  return {
    readGhlDirectory: owner.readGhlDirectory,
    readGhlEvents: owner.readGhlEvents,
    readSystemOfferRecords: owner.readSystemOfferRecords,
    async readGhlBlockedSlots(userId, startIso, endIso) {
      const locationId = Deno.env.get("GHL_LOCATION_ID") || "";
      if (!locationId) throw new Error("location_unconfigured");
      const query = new URLSearchParams({
        locationId,
        userId,
        startTime: String(Date.parse(startIso)),
        endTime: String(Date.parse(endIso)),
      });
      const body = await ghlRead(
        `/calendars/blocked-slots?${query.toString()}`,
      );
      const rows = body?.events;
      if (
        !Array.isArray(rows) ||
        !rows.every((r) => !!r && typeof r === "object" && !Array.isArray(r)) ||
        body.nextPage || body.nextPageUrl || body.hasMore || body.error
      ) throw new Error("ghl_blocked_slots_incomplete");
      return rows as BookingObject[];
    },
  };
}
