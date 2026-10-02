/** A lead already booked with a scoper is booked, not "to contact".
 *
 * Owner finish line (2026-09-24): "A lead already booked with a scoper shows
 * as booked with them and leaves every to-contact list." The booking read
 * stamps `case.scope_appointment` when ANY booking person's GHL calendar
 * holds a live future appointment for that lead's contact, whoever's list the
 * lead is on. The Booking screen (secureworks-ux `modules/ops-sales-booking.js`)
 * reads that field and moves the lead from To contact to Booked; nothing else
 * decides it and nothing is guessed from names, stages or threads.
 *
 * Read only: GHL `/calendars/events` per booking person's GHL user id
 * (`SALES_BOOKING_SENDER_LINES`, the one people table). Cancelled, no-show,
 * invalid and deleted appointments are not bookings. A calendar that could not
 * be read is named as a gap: a lead booked there may still read as to contact,
 * and the read never claims otherwise.
 */

import { SALES_BOOKING_SENDER_LINES } from "./sales_booking_sender.ts";

/** How far ahead a booked scope visit is looked for. */
export const SALES_BOOKING_SCOPE_APPOINTMENT_HORIZON_DAYS = 60;

export interface SalesBookingScopeAppointment {
  start_iso: string;
  end_iso: string | null;
  /** First name of the person whose calendar holds it ("Khairo"). */
  owner_name: string;
  owner_resource_id: string;
  /** GHL `appointmentStatus`, lower case ("confirmed", "new", ...). */
  status: string;
  event_id: string;
}

export interface SalesBookingScopeCalendarRead {
  resource_id: string;
  read_ok: boolean;
  reason: string | null;
  events: Record<string, unknown>[];
}

/** One person's GHL calendar events over a window. May throw or name a failure. */
export type SalesBookingScopeCalendarReader = (args: {
  ghlUserId: string;
  startMs: number;
  endMs: number;
  deadlineMs?: number;
}) => Promise<{ events: Record<string, unknown>[]; failure: string | null }>;

const NOT_A_BOOKING = new Set([
  "cancelled",
  "canceled",
  "noshow",
  "no_show",
  "no-show",
  "invalid",
]);

/** Read every booking person's GHL calendar from now to the horizon. Never throws. */
export async function readSalesBookingScopeCalendars(args: {
  read: SalesBookingScopeCalendarReader;
  nowMs: number;
  deadlineMs?: number;
}): Promise<SalesBookingScopeCalendarRead[]> {
  const endMs = args.nowMs +
    SALES_BOOKING_SCOPE_APPOINTMENT_HORIZON_DAYS * 86_400_000;
  return await Promise.all(
    Object.values(SALES_BOOKING_SENDER_LINES).map(async (person) => {
      try {
        const scan = await args.read({
          ghlUserId: person.ghl_user_id,
          startMs: args.nowMs,
          endMs,
          deadlineMs: args.deadlineMs,
        });
        return scan.failure
          ? {
            resource_id: person.person,
            read_ok: false,
            reason: scan.failure,
            events: [],
          }
          : {
            resource_id: person.person,
            read_ok: true,
            reason: null,
            events: scan.events,
          };
      } catch (error) {
        return {
          resource_id: person.person,
          read_ok: false,
          reason: (error as Error)?.message || "ghl_calendar_read_failed",
          events: [],
        };
      }
    }),
  );
}

/** A GHL time as an ISO string with an offset (Perth when GHL sent none). */
function ghlInstant(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim();
  const iso = /(Z|[+-]\d{2}:?\d{2})$/.test(text) ? text : `${text}+08:00`;
  return Number.isFinite(Date.parse(iso)) ? iso : null;
}

/**
 * The earliest live future appointment per GHL contact id, across every
 * calendar that was read. Live: not cancelled / no-show / invalid / deleted,
 * and not already over at `nowMs`.
 */
export function salesBookingScopeAppointmentsByContact(
  reads: SalesBookingScopeCalendarRead[],
  nowMs: number,
): Map<string, SalesBookingScopeAppointment> {
  const byContact = new Map<string, SalesBookingScopeAppointment>();
  for (const read of reads) {
    if (!read.read_ok) continue;
    const person = SALES_BOOKING_SENDER_LINES[read.resource_id];
    if (!person) continue;
    for (const event of read.events) {
      const contactId = typeof event.contactId === "string"
        ? event.contactId.trim()
        : "";
      const eventId = typeof event.id === "string" ? event.id : "";
      if (!contactId || !eventId || event.deleted === true) continue;
      const status = String(
        event.appointmentStatus ?? event.appoinmentStatus ?? "",
      ).trim().toLowerCase();
      if (NOT_A_BOOKING.has(status)) continue;
      const start = ghlInstant(event.startTime);
      if (!start) continue;
      const end = ghlInstant(event.endTime);
      if (Date.parse(end ?? start) <= nowMs) continue;
      const prior = byContact.get(contactId);
      if (prior && Date.parse(prior.start_iso) <= Date.parse(start)) continue;
      byContact.set(contactId, {
        start_iso: start,
        end_iso: end,
        owner_name: person.name.split(/\s+/)[0],
        owner_resource_id: person.person,
        status: status || "booked",
        event_id: eventId,
      });
    }
  }
  return byContact;
}

/**
 * Stamp `scope_appointment` on each case whose contact is booked (null when
 * none was found). Returns every booked contact (the response's
 * `scope_appointments`) and a coverage gap for every calendar left unread.
 */
export function applySalesBookingScopeAppointments(
  cases: Array<
    {
      contact_id: string | null;
      scope_appointment?: SalesBookingScopeAppointment | null;
    }
  >,
  reads: SalesBookingScopeCalendarRead[],
  nowMs: number,
): {
  by_contact: Record<string, SalesBookingScopeAppointment>;
  gaps: string[];
} {
  const byContact = salesBookingScopeAppointmentsByContact(reads, nowMs);
  for (const row of cases) {
    row.scope_appointment = (row.contact_id && byContact.get(row.contact_id)) ||
      null;
  }
  const gaps = reads.filter((read) => !read.read_ok).map((read) =>
    `Booked-elsewhere check: ${
      SALES_BOOKING_SENDER_LINES[read.resource_id]?.name ?? read.resource_id
    }'s GHL calendar unread (${
      read.reason || "unknown"
    }); a lead booked there may still show as to contact.`
  );
  return { by_contact: Object.fromEntries(byContact), gaps };
}

/**
 * A lead the engine pack offers a time to, not on this read's list, whose
 * contact is already booked in a GHL calendar. The Booking screen would draw
 * such a pack-only offer as a to-contact row (it cannot see the booking), so
 * the read lists it itself, carrying `scope_appointment`: the screen then
 * shows it under Booked ("Booked with Khairo, ...") and offers nothing.
 * Returns the opportunity ids to add, with their appointment.
 */
export function salesBookingBookedPackOffers(
  proposals: Record<string, {
    disposition: string | null;
    offer: boolean;
    opportunity_id: string | null;
    contact_id: string | null;
  }>,
  scopeAppointments: Record<string, SalesBookingScopeAppointment> | undefined,
  listedOpportunityIds: ReadonlySet<string>,
): Array<{ key: string; appointment: SalesBookingScopeAppointment }> {
  if (!scopeAppointments) return [];
  const out: Array<
    { key: string; appointment: SalesBookingScopeAppointment }
  > = [];
  for (const [key, proposal] of Object.entries(proposals)) {
    if (!proposal.offer && proposal.disposition !== "offer") continue;
    const opportunityId = proposal.opportunity_id || key;
    if (listedOpportunityIds.has(opportunityId)) continue;
    const appointment = proposal.contact_id &&
        Object.hasOwn(scopeAppointments, proposal.contact_id)
      ? scopeAppointments[proposal.contact_id]
      : null;
    if (appointment) out.push({ key, appointment });
  }
  return out;
}
