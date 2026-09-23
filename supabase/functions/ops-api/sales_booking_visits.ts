/** Read-only appointment/outcome composition. The ledger owns booking success;
 * published GHL-contact bindings own lead identity. No provider or write calls. */
import type { BookingObject } from "./sales_booking_confirmation.ts";
import {
  type SalesBookingReadParams,
  type SalesBookingReadResponse,
  SalesBookingRequestError,
} from "./sales_booking_read.ts";
import { currentVisitOutcome, type VisitOutcome } from "./visit_outcomes.ts";

const APPOINTMENT_COLUMNS =
  "idempotency_key,assigned_user_id,start_time,end_time,state,result";
export const BOOKING_OUTCOME_COLUMNS =
  "id,booking_key,appointment_id,contact_id,opportunity_id,job_id,scoper_user_id,scoper_name,visit_start,outcome,reason,note,quote_owed,recorded_by_user_id,recorded_at,source,supersedes";
const PAGE = 500;
const MAX_ROWS = 10_000;
type Client = { from: (table: string) => BookingObject };

/** A cap or failed page is never a complete empty read. Stable ordering is required. */
async function pages(query: () => BookingObject): Promise<BookingObject[]> {
  const rows: BookingObject[] = [];
  for (let offset = 0; offset <= MAX_ROWS; offset += PAGE) {
    const { data, error } = await query().range(offset, offset + PAGE - 1);
    if (error || !Array.isArray(data)) throw new Error("store_unreadable");
    rows.push(...data);
    if (rows.length > MAX_ROWS) throw new Error("read_limit_reached");
    if (data.length < PAGE) return rows;
  }
  throw new Error("read_limit_reached");
}

export function bookingVisitWindow(
  response: SalesBookingReadResponse,
  params: SalesBookingReadParams,
  now: Date,
): { since: string; until: string } {
  const since = params.visit_outcomes_from ??
    new Date(now.getTime() - 7 * 86400000).toISOString();
  const until = params.visit_outcomes_to ?? now.toISOString();
  const valid = (v: string) =>
    /(Z|[+-]\d\d:\d\d)$/.test(v) && Number.isFinite(Date.parse(v));
  if (
    !valid(since) || !valid(until) || Date.parse(until) <= Date.parse(since) ||
    Date.parse(until) - Date.parse(since) > 366 * 86400000
  ) {
    throw new SalesBookingRequestError("Invalid visit outcome date window");
  }
  // The last-seven-days queue and the selected week's bookings both belong here.
  return {
    since: new Date(
      Math.min(Date.parse(since), Date.parse(response.week.since)),
    ).toISOString(),
    until: new Date(
      Math.max(Date.parse(until), Date.parse(response.week.until_exclusive)),
    ).toISOString(),
  };
}

export async function applySalesBookingVisits(
  client: Client,
  response: SalesBookingReadResponse,
  params: SalesBookingReadParams = {},
  now = new Date(),
): Promise<SalesBookingReadResponse> {
  const window = bookingVisitWindow(response, params, now);
  const flow: BookingObject = {
    ...response.booking_flow,
    booked_visits_read: "could_not_read",
    visit_outcomes_read: "could_not_read",
    visit_outcome_write: null,
    visit_read: { ...window, as_of: now.toISOString(), reason: null },
  };
  const result: SalesBookingReadResponse = {
    ...response,
    booking_flow: flow,
    booked_visits: null,
    visit_outcomes: null,
    cases: response.cases.map((row) => ({
      ...row,
      booked_visits: null,
      visit_outcome: null,
      visit_outcome_history: null,
      visit_read_complete: false,
    })),
  };
  const person = response.diary_read.ghl_user_id;
  if (!person) {
    flow.visit_read.reason = "ghl_scoper_identity_unreadable";
    return result;
  }
  let appointments: BookingObject[];
  try {
    appointments = await pages(() =>
      client.from("ghl_calendar_appointment_requests")
        .select(APPOINTMENT_COLUMNS).eq("assigned_user_id", person).eq(
          "state",
          "complete",
        )
        .gte("start_time", window.since).lt("start_time", window.until)
        .order("start_time").order("idempotency_key")
    );
  } catch (error) {
    flow.visit_read.reason = `booked_visits_${(error as Error).message}`;
    return result;
  }
  let outcomes: VisitOutcome[];
  try {
    const keys = [...new Set(appointments.map((a) => a.idempotency_key))];
    outcomes = [];
    // Sequential URL-budget chunks; page entire chains, never just current rows.
    for (let i = 0; i < keys.length; i += 50) {
      outcomes.push(
        ...await pages(() =>
          client.from("visit_outcomes")
            .select(BOOKING_OUTCOME_COLUMNS).in(
              "booking_key",
              keys.slice(i, i + 50),
            )
            .order("booking_key").order("recorded_at").order("id")
        ) as VisitOutcome[],
      );
    }
  } catch (error) {
    flow.visit_read.reason = `visit_outcomes_${(error as Error).message}`;
    return result;
  }
  const visits: BookingObject[] = [], history: VisitOutcome[] = [];
  let unresolved = 0;
  for (const appointment of appointments) {
    const key = appointment.idempotency_key;
    const chain = outcomes.filter((o) => o.booking_key === key);
    const current = currentVisitOutcome(chain);
    if (
      (chain.length && !current) ||
      appointments.filter((a) => a.idempotency_key === key).length !== 1
    ) {
      unresolved++;
      continue;
    }
    // A successful provider receipt contains no contact. Bind only an exact key
    // from the executor's own record of the press (the ledger key IS its
    // approval binding hash), a contact-bound published model, or the current
    // durable outcome.
    const pressFor = (row: BookingObject) =>
      Array.isArray(row.booking_executions)
        ? row.booking_executions.find((e: BookingObject) =>
          e.step === "calendar" && e.binding_hash === key &&
          e.contact_id === row.contact_id
        )
        : undefined;
    const candidates = response.cases.filter((row) => {
      if (!row.contact_id) return false;
      const model = row.booking_read_model;
      const receipt = model?.calendar_write?.receipt;
      const modelKey = receipt?.booking_key ?? receipt?.idempotency_key;
      const modelBound = model?.contact_id === row.contact_id &&
        modelKey === key;
      const outcomeBound = current?.contact_id === row.contact_id &&
        current.scoper_user_id === response.resource.scoper_user_id;
      return !!pressFor(row) || modelBound || outcomeBound;
    });
    const row = candidates[0];
    const receipt = appointment.result;
    const press = row ? pressFor(row) : undefined;
    if (
      candidates.length !== 1 || !row || !receipt?.appointmentId ||
      (press && (press.state !== "booked" ||
        press.appointment_id !== receipt.appointmentId)) ||
      !(Date.parse(receipt.endTime) > Date.parse(receipt.startTime)) ||
      Date.parse(receipt.startTime) !== Date.parse(appointment.start_time) ||
      Date.parse(receipt.endTime) !== Date.parse(appointment.end_time) ||
      (current && (current.contact_id !== row.contact_id ||
        current.scoper_user_id !== response.resource.scoper_user_id))
    ) {
      unresolved++;
      continue;
    }
    visits.push({
      booking_key: key,
      appointment_id: receipt.appointmentId,
      contact_id: row.contact_id,
      opportunity_id: row.opportunity_id,
      job_id: current?.job_id ?? null,
      scoper_user_id: response.resource.scoper_user_id,
      display_name: row.display_name,
      visit_start: receipt.startTime,
      visit_end: receipt.endTime,
      visit_outcome: current,
      visit_outcome_history: chain,
      // Additive: which record bound this booking to its lead.
      bound_by: press
        ? "executor"
        : current?.contact_id === row.contact_id
        ? "visit_outcome"
        : "published_receipt",
      execution: press ?? null,
    });
    history.push(...chain);
  }
  result.booked_visits = visits;
  result.visit_outcomes = history;
  // The diary shows each booked visit on its GHL event and its Outlook mirror.
  if (Array.isArray(result.diary)) {
    result.diary = result.diary.map((entry) => {
      const ghlId = entry.source === "outlook"
        ? entry.mirror_of_ghl_event_id
        : entry.event_id;
      const visit = ghlId
        ? visits.find((v) => v.appointment_id === ghlId)
        : undefined;
      return {
        ...entry,
        booked_visit: visit
          ? {
            state: "booked",
            booking_key: visit.booking_key,
            appointment_id: visit.appointment_id,
            contact_id: visit.contact_id,
            display_name: visit.display_name,
            bound_by: visit.bound_by,
          }
          : null,
      };
    });
  }
  flow.booked_visits_read = unresolved ? "partial" : "complete";
  flow.visit_outcomes_read = unresolved ? "partial" : "complete";
  flow.visit_outcome_write = unresolved ? null : "append-only-v1";
  flow.visit_read.unresolved_bookings = unresolved;
  flow.visit_read.reason = unresolved
    ? "booking_contact_or_outcome_identity_unresolved"
    : null;
  result.cases = result.cases.map((row) => {
    const mine = visits.filter((v) => v.contact_id === row.contact_id);
    const latest = [...mine].sort((a, b) =>
      Date.parse(b.visit_start) - Date.parse(a.visit_start)
    )[0];
    return {
      ...row,
      booked_visits: mine,
      visit_outcome: latest?.visit_outcome ?? null,
      visit_outcome_history: history.filter((o) =>
        mine.some((v) =>
          v.booking_key === o.booking_key
        )
      ),
      visit_read_complete: !unresolved,
    };
  });
  return result;
}
