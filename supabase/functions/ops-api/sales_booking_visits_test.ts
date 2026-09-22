// deno-lint-ignore-file no-import-prefix
import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  applySalesBookingVisits,
  bookingVisitWindow,
} from "./sales_booking_visits.ts";
import type { BookingObject } from "./sales_booking_confirmation.ts";
import type { SalesBookingReadResponse } from "./sales_booking_read.ts";
import { currentVisitOutcome, type VisitOutcome } from "./visit_outcomes.ts";
const NOW = new Date("2026-09-22T00:00:00Z");
const START = "2026-09-21T09:00:00+08:00", END = "2026-09-21T11:30:00+08:00";
function workspace(): SalesBookingReadResponse {
  return {
    resource: { resource_id: "marnin", scoper_user_id: "scoper-1" },
    week: {
      since: "2026-09-21T00:00:00+08:00",
      until_exclusive: "2026-09-28T00:00:00+08:00",
    },
    booking_flow: {
      calendar_read: { state: "could_not_read" },
      commitments: null,
    },
    diary_read: { ghl_user_id: "ghl-scoper-1" },
    cases: [{
      id: "opp:one",
      contact_id: "contact-1",
      opportunity_id: "one",
      display_name: "Example",
      booking_read_model: {
        contact_id: "contact-1",
        calendar_write: { receipt: { idempotency_key: "booking-1" } },
      },
    }],
  } as unknown as SalesBookingReadResponse;
}
function appointment(key = "booking-1") {
  return {
    idempotency_key: key,
    assigned_user_id: "ghl-scoper-1",
    start_time: START,
    end_time: END,
    state: "complete",
    result: {
      appointmentId: "event-1",
      calendarId: "calendar-1",
      startTime: START,
      endTime: END,
    },
  };
}
function outcome(id: string, supersedes: string | null): VisitOutcome {
  return {
    id,
    booking_key: "booking-1",
    contact_id: "contact-1",
    scoper_user_id: "scoper-1",
    appointment_id: "event-1",
    visit_start: START,
    supersedes,
    outcome: "happened",
    quote_owed: true,
    recorded_at: NOW.toISOString(),
  } as VisitOutcome;
}
function database(
  appointments: BookingObject[],
  outcomes: VisitOutcome[],
  fail?: string,
) {
  const calls: BookingObject[] = [];
  return {
    calls,
    from(table: string) {
      const call: BookingObject = { table, filters: [] };
      calls.push(call);
      const query: BookingObject = {};
      for (const name of ["select", "eq", "gte", "lt", "in", "order"]) {
        query[name] = (...args: unknown[]) => {
          call.filters.push([name, ...args]);
          return query;
        };
      }
      query.range = (start: number, end: number) => {
        call.range = [start, end];
        let rows: BookingObject[] = table === "visit_outcomes"
          ? outcomes
          : appointments;
        for (const [method, field, value] of call.filters) {
          if (method === "eq") rows = rows.filter((r) => r[field] === value);
          if (method === "in") {
            rows = rows.filter((r) => value.includes(r[field]));
          }
          if (method === "gte") {
            rows = rows.filter((r) =>
              Date.parse(r[field]) >= Date.parse(value)
            );
          }
          if (method === "lt") {
            rows = rows.filter((r) => Date.parse(r[field]) < Date.parse(value));
          }
        }
        return Promise.resolve({
          data: fail === table ? null : rows.slice(start, end + 1),
          error: fail === table ? { message: "failed read" } : null,
        });
      };
      return query;
    },
  };
}
Deno.test("booking read joins a successful ledger booking and two corrections by contact and booking key", async () => {
  const chain = [
    outcome("original", null),
    outcome("correction-1", "original"),
    outcome("correction-2", "correction-1"),
  ];
  const db = database([appointment()], chain);
  const result = await applySalesBookingVisits(db, workspace(), {}, NOW);
  assertEquals(result.booking_flow?.visit_outcomes_read, "complete");
  assertEquals(result.booking_flow?.visit_outcome_write, "append-only-v1");
  assertEquals(result.booked_visits?.[0].booking_key, "booking-1");
  assertEquals(result.cases[0].visit_outcome?.id, "correction-2");
  assertEquals(result.cases[0].visit_outcome_history, chain);
  assertEquals(result.visit_outcomes, chain);
  assertEquals(result.cases[0].visit_read_complete, true);
  assertEquals(result.booking_flow?.calendar_read.state, "could_not_read");
  assertEquals(
    db.calls[1].filters.some((f: unknown[]) => f[0] === "gte" || f[0] === "lt"),
    false,
  );
});
Deno.test("successful booking without an outcome is present for the amber queue; reserved writes are absent", async () => {
  const pending = { ...appointment("pending"), state: "sending", result: null };
  const result = await applySalesBookingVisits(
    database([appointment(), pending], []),
    workspace(),
    {},
    NOW,
  );
  assertEquals(result.booked_visits?.length, 1);
  assertEquals(result.cases[0].visit_outcome, null);
  assertEquals(result.visit_outcomes, []);
  assertEquals(result.booking_flow?.booked_visits_read, "complete");
});
Deno.test("failed stores, unknown person and unresolved contact never claim complete empty visits", async () => {
  for (const table of ["ghl_calendar_appointment_requests", "visit_outcomes"]) {
    const result = await applySalesBookingVisits(
      database([appointment()], [], table),
      workspace(),
      {},
      NOW,
    );
    assertEquals(result.booking_flow?.visit_outcomes_read, "could_not_read");
    assertEquals(result.booked_visits, null);
    assertEquals(result.visit_outcomes, null);
  }
  const f = workspace();
  delete f.cases[0].booking_read_model;
  const missing = await applySalesBookingVisits(
    database([appointment()], []),
    f,
    {},
    NOW,
  );
  assertEquals(missing.booking_flow?.booked_visits_read, "partial");
  assertEquals(missing.booking_flow?.visit_read.unresolved_bookings, 1);
  f.diary_read.ghl_user_id = null;
  const db = database([], []);
  assertEquals(
    (await applySalesBookingVisits(db, f, {}, NOW)).booking_flow
      ?.booked_visits_read,
    "could_not_read",
  );
  assertEquals(db.calls.length, 0);
});
Deno.test("wrong contact, duplicate lead and broken correction chain refuse outcome completeness", async () => {
  for (const scenario of ["contact", "duplicate", "chain"]) {
    const f = workspace();
    const chain = [outcome("latest", scenario === "chain" ? "missing" : null)];
    if (scenario === "contact") chain[0].contact_id = "other-contact";
    if (scenario === "duplicate") {
      f.cases.push({ ...f.cases[0], id: "opp:two" });
    }
    const result = await applySalesBookingVisits(
      database([appointment()], chain),
      f,
      {},
      NOW,
    );
    assertEquals(result.booking_flow?.visit_outcomes_read, "partial");
    assertEquals(result.booking_flow?.visit_outcome_write, null);
  }
  assertEquals(
    currentVisitOutcome([outcome("one", "two"), outcome("two", "one")]),
    null,
  );
});
Deno.test("outcome histories paginate beyond the PostgREST page without losing corrections", async () => {
  const chain = Array.from(
    { length: 501 },
    (_, i) => outcome(`r-${i}`, i ? `r-${i - 1}` : null),
  );
  const db = database([appointment()], chain);
  const result = await applySalesBookingVisits(db, workspace(), {}, NOW);
  assertEquals(result.visit_outcomes?.length, 501);
  assertEquals(result.cases[0].visit_outcome?.id, "r-500");
  assertEquals(
    db.calls.filter((c) => c.table === "visit_outcomes").map((c) => c.range),
    [[0, 499], [500, 999]],
  );
});
Deno.test("requested outcome window is validated and included alongside the selected week", () => {
  const f = workspace();
  const window = bookingVisitWindow(f, {
    visit_outcomes_from: "2026-09-01T00:00:00Z",
    visit_outcomes_to: "2026-09-22T00:00:00Z",
  }, NOW);
  assertEquals(window.since, "2026-09-01T00:00:00.000Z");
  assertEquals(window.until, "2026-09-27T16:00:00.000Z");
  assertThrows(() =>
    bookingVisitWindow(f, { visit_outcomes_from: "invalid" }, NOW)
  );
  assertThrows(() =>
    bookingVisitWindow(f, { visit_outcomes_from: "2020-01-01T00:00:00Z" }, NOW)
  );
});
