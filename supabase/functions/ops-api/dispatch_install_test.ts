// deno-lint-ignore-file no-import-prefix no-explicit-any
// Dispatch slice 7 (docs/dispatch-slice-7-contract.md): who is booked, and
// Dispatch's own install mark. Fixtures are made up. The calendar lock is a
// fact on the booking and never the mark.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { dispatchRowFields, dispatchStageIndex } from "./dispatch_stage.ts";
import {
  dispatchInstall,
  type DispatchInstallBooking,
  dispatchInstallBookingsByJob,
  dispatchInstallBookingsOnDay,
  dispatchInstallDay,
  dispatchInstallHoldsTodo,
  dispatchInstallMark,
  dispatchInstallOpen,
  isDispatchInstallBooking,
  NAME_NOT_ON_RECORD,
} from "./dispatch_install.ts";

const JOB = "a1000000-0000-4000-8000-000000000001";
const OTHER = "a1000000-0000-4000-8000-000000000002";
const TODAY = "2026-10-18";

function booking(
  overrides: Partial<DispatchInstallBooking> = {},
): DispatchInstallBooking {
  return {
    id: "asg-1",
    job_id: JOB,
    user_id: "user-1",
    scheduled_date: "2026-10-20",
    scheduled_end: null,
    assignment_type: "install",
    status: null,
    is_ghost: false,
    role: "lead_installer",
    is_lead: false,
    confirmation_status: null,
    person: { name: "Crew One" },
    ...overrides,
  };
}

Deno.test("an install booking is type install, dated, and not cancelled, ghost or observer", () => {
  assert(isDispatchInstallBooking(booking()));
  assert(isDispatchInstallBooking(booking({ status: null })));
  assert(isDispatchInstallBooking(booking({
    scheduled_date: "2026-10-20T08:00:00+08:00",
  })));
  assert(!isDispatchInstallBooking(booking({ assignment_type: "labour" })));
  assert(!isDispatchInstallBooking(booking({ status: "Cancelled" })));
  assert(!isDispatchInstallBooking(booking({ is_ghost: true })));
  assert(!isDispatchInstallBooking(booking({ role: "Observer" })));
  assert(!isDispatchInstallBooking(booking({ scheduled_date: null })));
  assert(!isDispatchInstallBooking(booking({ scheduled_date: "next week" })));

  const grouped = dispatchInstallBookingsByJob([
    booking({ id: "keep" }),
    booking({ id: "other", job_id: OTHER }),
    booking({ id: "labour", assignment_type: "labour" }),
    booking({ id: "none", job_id: "" }),
  ]);
  assertEquals([...(grouped.get(JOB) || [])].map((row) => row.id), ["keep"]);
  assertEquals([...(grouped.get(OTHER) || [])].map((row) => row.id), ["other"]);
  assertEquals(grouped.size, 2);
});

Deno.test("the day shown is the earliest on or after today, else the latest", () => {
  const bookings = [
    booking({ id: "past", scheduled_date: "2026-10-16" }),
    booking({ id: "today", scheduled_date: TODAY }),
    booking({ id: "later", scheduled_date: "2026-10-22" }),
  ];
  assertEquals(dispatchInstallDay(bookings, TODAY), {
    state: "ahead",
    day: TODAY,
    also_days: ["2026-10-22"],
  });
  assertEquals(
    dispatchInstallDay([
      booking({ scheduled_date: "2026-10-10" }),
      booking({
        scheduled_date: "2026-10-12",
      }),
    ], TODAY),
    { state: "past", day: "2026-10-12", also_days: [] },
  );
  assertEquals(dispatchInstallDay([], TODAY), {
    state: "none",
    day: null,
    also_days: [],
  });
  assertEquals(
    dispatchInstallBookingsOnDay(bookings, TODAY).map((row) => row.id),
    ["today"],
  );
});

Deno.test("people on the day: lead first, then name in C order; a blank name is named", () => {
  const install = dispatchInstall(
    [
      booking({
        id: "amy",
        is_lead: false,
        person: { name: "amy" },
      }),
      booking({
        id: "amy-upper",
        is_lead: false,
        person: { name: "Amy" },
      }),
      booking({
        id: "lead",
        is_lead: true,
        person: { name: "Zoe" },
      }),
      booking({
        id: "blank",
        is_lead: false,
        person: { name: "  " },
      }),
      booking({ id: "other-day", scheduled_date: "2026-10-22" }),
    ],
    null,
    "2026-10-20",
  );
  assertEquals(install.people, [
    { name: "Zoe", lead: true },
    { name: "Amy", lead: false },
    { name: NAME_NOT_ON_RECORD, lead: false },
    { name: "amy", lead: false },
  ]);
});

Deno.test("end day is the latest scheduled end later than the install day", () => {
  const install = dispatchInstall(
    [
      booking({ scheduled_end: "2026-10-20" }),
      booking({ id: "span", scheduled_end: "2026-10-22" }),
      booking({ id: "sooner", scheduled_end: "2026-10-21" }),
      booking({ id: "before", scheduled_end: "2026-10-19" }),
    ],
    null,
    "2026-10-20",
  );
  assertEquals(install.day, "2026-10-20");
  assertEquals(install.end_day, "2026-10-22");
  assertEquals(
    dispatchInstall([booking({ scheduled_end: null })], null, TODAY).end_day,
    null,
  );
});

Deno.test("the calendar lock is shown and never counts as Dispatch's mark", () => {
  const locked = dispatchInstall(
    [
      booking({ confirmation_status: "Confirmed" }),
    ],
    null,
    TODAY,
  );
  assertEquals(locked.calendar_confirmed, true);
  assertEquals(locked.confirmed, null);
  assertEquals(locked.confirmed_current, false);
  assertEquals(dispatchInstallHoldsTodo(locked), true);
  assertEquals(dispatchInstallOpen(locked, 6, true), "not_confirmed");

  const otherDay = dispatchInstall(
    [
      booking({
        scheduled_date: "2026-10-16",
        confirmation_status: "confirmed",
      }),
      booking({ scheduled_date: "2026-10-20", confirmation_status: null }),
    ],
    null,
    TODAY,
  );
  assertEquals(otherDay.day, "2026-10-20");
  assertEquals(otherDay.calendar_confirmed, false);
});

Deno.test("install_confirmed_for_day stands while a booking remains on that day", () => {
  const mark = {
    install_confirmed_at: "2026-10-17T01:00:00.000Z",
    install_confirmed_by: "user-9",
    install_confirmed_by_email: "office@example.test",
    install_confirmed_for_day: "2026-10-16",
    install_confirmer: { name: "Office Person" },
  };
  assertEquals(dispatchInstallMark(mark), {
    at: "2026-10-17T01:00:00.000Z",
    by: "Office Person",
    for_day: "2026-10-16",
  });
  assertEquals(
    dispatchInstallMark({
      ...mark,
      install_confirmer: { name: "  " },
    })?.by,
    "office@example.test",
  );
  assertEquals(dispatchInstallMark({ install_confirmed_at: "  " }), null);
  assertEquals(dispatchInstallMark(null), null);

  // The day shown has moved on. The mark is still current: the old day still
  // has its install booking.
  const still = dispatchInstall(
    [
      booking({ id: "marked", scheduled_date: "2026-10-16" }),
      booking({ id: "next", scheduled_date: "2026-10-20" }),
    ],
    mark,
    TODAY,
  );
  assertEquals(still.state, "ahead");
  assertEquals(still.day, "2026-10-20");
  assertEquals(still.confirmed?.for_day, "2026-10-16");
  assertEquals(still.confirmed_current, true);
  assertEquals(dispatchInstallHoldsTodo(still), false);
  assertEquals(dispatchInstallOpen(still, 6, false), null);

  const moved = dispatchInstall(
    [
      booking({ scheduled_date: "2026-10-20" }),
    ],
    mark,
    TODAY,
  );
  assertEquals(moved.confirmed_current, false);
  assertEquals(dispatchInstallHoldsTodo(moved), true);
  assertEquals(dispatchInstallOpen(moved, 6, true), "moved");
});

Deno.test("a mark made with nothing booked lapses once an install is booked ahead", () => {
  const mark = {
    install_confirmed_at: "2026-10-17T01:00:00.000Z",
    install_confirmed_by_email: "office@example.test",
    install_confirmed_for_day: null,
    install_confirmer: null,
  };
  const quiet = dispatchInstall([], mark, TODAY);
  assertEquals(quiet.state, "none");
  assertEquals(quiet.confirmed?.for_day, null);
  assertEquals(quiet.confirmed_current, true);
  assertEquals(dispatchInstallHoldsTodo(quiet), false);

  const since = dispatchInstall([booking()], mark, TODAY);
  assertEquals(since.state, "ahead");
  assertEquals(since.confirmed_current, false);
  assertEquals(dispatchInstallHoldsTodo(since), true);
  assertEquals(dispatchInstallOpen(since, 6, true), "booked_after");
});

Deno.test("open is only set for a stop 6 job that is in To do because of the install", () => {
  const ahead = dispatchInstall([booking()], null, TODAY);
  assertEquals(dispatchInstallOpen(ahead, 5, true), null);
  assertEquals(dispatchInstallOpen(ahead, 6, false), null);
  assertEquals(dispatchInstallOpen(null, 6, true), null);
  assertEquals(dispatchStageIndex("trade_scheduled"), 6);

  const past = dispatchInstall(
    [
      booking({ scheduled_date: "2026-10-10" }),
    ],
    null,
    TODAY,
  );
  assertEquals(past.state, "past");
  assertEquals(dispatchInstallHoldsTodo(past), false);
});

Deno.test("the list row: a scheduled fence stays in To do until the mark matches the booking", () => {
  const job = { type: "fencing", status: "scheduled", council_required: false };
  const bookings = [booking({ confirmation_status: "confirmed" })];
  const before = dispatchRowFields(job, null, { bookings, today: TODAY });
  assertEquals(before.dispatch_stage, "trade_scheduled");
  assertEquals(before.dispatch_stage_index, 6);
  assertEquals(before.dispatch_todo, true);
  assertEquals(before.dispatch_install_open, "not_confirmed");
  assertEquals(before.dispatch_install?.calendar_confirmed, true);
  assertEquals(before.dispatch_install?.confirmed, null);

  const marked = dispatchRowFields(job, {
    install_confirmed_at: "2026-10-18T03:00:00.000Z",
    install_confirmed_by_email: "office@example.test",
    install_confirmed_for_day: "2026-10-20",
    install_confirmer: { name: "Office Person" },
  }, { bookings, today: TODAY });
  assertEquals(marked.dispatch_install?.confirmed?.for_day, "2026-10-20");
  assertEquals(marked.dispatch_install?.confirmed_current, true);
  assertEquals(marked.dispatch_todo, false);
  assertEquals(marked.dispatch_install_open, null);

  const shifted = dispatchRowFields(job, {
    install_confirmed_at: "2026-10-18T03:00:00.000Z",
    install_confirmed_by_email: "office@example.test",
    install_confirmed_for_day: "2026-10-16",
    install_confirmer: { name: "Office Person" },
  }, { bookings, today: TODAY });
  assertEquals(shifted.dispatch_todo, true);
  assertEquals(shifted.dispatch_install_open, "moved");
});
