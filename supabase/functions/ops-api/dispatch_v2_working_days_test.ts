// Tests for dispatch_v2_working_days.ts (piece C). Pure: no database.
// Run: deno test supabase/functions/ops-api/dispatch_v2_working_days_test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  dispatchEarliestInstall,
  isWaWorkingDay,
  nextWaWorkingDayAfter,
  WA_PUBLIC_HOLIDAYS,
} from "./dispatch_v2_working_days.ts";

Deno.test("working days: weekdays count, weekends and WA public holidays do not", () => {
  assertEquals(isWaWorkingDay("2026-11-02"), true); // Monday
  assertEquals(isWaWorkingDay("2026-11-06"), true); // Friday
  assertEquals(isWaWorkingDay("2026-10-31"), false); // Saturday
  assertEquals(isWaWorkingDay("2026-11-01"), false); // Sunday
  assertEquals(isWaWorkingDay("2026-12-25"), false); // Christmas Day
  assertEquals(isWaWorkingDay("2026-12-28"), false); // Boxing Day, in lieu
  assertEquals(isWaWorkingDay("2027-03-01"), false); // Labour Day
  assertEquals(isWaWorkingDay("not a day"), false);
});

Deno.test("working days: every listed holiday is a weekday, and each year has ten", () => {
  for (const day of WA_PUBLIC_HOLIDAYS) {
    const [y, m, d] = day.split("-").map(Number);
    const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    assertEquals(weekday !== 0 && weekday !== 6, true, day);
  }
  const perYear = (year: string) =>
    [...WA_PUBLIC_HOLIDAYS].filter((day) => day.startsWith(year)).length;
  assertEquals([perYear("2026"), perYear("2027")], [10, 10]);
});

Deno.test("working days: the next working day skips weekends and holidays, never the day itself", () => {
  assertEquals(nextWaWorkingDayAfter("2026-11-03"), "2026-11-04"); // Tue to Wed
  assertEquals(nextWaWorkingDayAfter("2026-11-06"), "2026-11-09"); // Fri to Mon
  assertEquals(nextWaWorkingDayAfter("2026-10-31"), "2026-11-02"); // Sat to Mon
  // Christmas: Thu 24 to Tue 29 (Fri 25 Christmas, weekend, Mon 28 Boxing Day).
  assertEquals(nextWaWorkingDayAfter("2026-12-24"), "2026-12-29");
  // Easter 2027: Thu 25 March to Tue 30 March.
  assertEquals(nextWaWorkingDayAfter("2027-03-25"), "2027-03-30");
  // Across the year end.
  assertEquals(nextWaWorkingDayAfter("2026-12-31"), "2027-01-04");
});

Deno.test("earliest install: the next working day after the last confirmed date", () => {
  const earliest = dispatchEarliestInstall({
    today: "2026-10-30",
    orders: [
      { open: true, date: "2026-11-02", confirmed: true },
      { open: true, date: "2026-11-04", confirmed: true }, // Wednesday
      // Delivered: ignored, even with no date.
      { open: false, date: null, confirmed: false },
    ],
  });
  assertEquals(earliest, { day: "2026-11-05", after_day: "2026-11-04" });
  // The last date on a Friday: the install is the Monday.
  assertEquals(
    dispatchEarliestInstall({
      today: "2026-10-30",
      orders: [{ open: true, date: "2026-11-06", confirmed: true }],
    }),
    { day: "2026-11-09", after_day: "2026-11-06" },
  );
});

Deno.test("earliest install: not known while any open order has no confirmed date, or there are no orders", () => {
  const today = "2026-10-30";
  const confirmed = { open: true, date: "2026-11-04", confirmed: true };
  assertEquals(
    dispatchEarliestInstall({ today, orders: [confirmed, { open: true, date: null, confirmed: false }] }),
    null,
  );
  // A date the supplier has not confirmed is not enough.
  assertEquals(
    dispatchEarliestInstall({ today, orders: [confirmed, { open: true, date: "2026-11-03", confirmed: false }] }),
    null,
  );
  assertEquals(dispatchEarliestInstall({ today, orders: [] }), null);
  assertEquals(dispatchEarliestInstall({ today: "", orders: [confirmed] }), null);
});

Deno.test("earliest install: dates already behind us, or every order in, count from today", () => {
  // A confirmed date in the past that nobody marked delivered.
  assertEquals(
    dispatchEarliestInstall({
      today: "2026-11-04",
      orders: [{ open: true, date: "2026-11-02", confirmed: true }],
    }),
    { day: "2026-11-05", after_day: "2026-11-02" },
  );
  // Every order delivered: the next working day after today.
  assertEquals(
    dispatchEarliestInstall({
      today: "2026-11-06",
      orders: [{ open: false, date: "2026-11-02", confirmed: true }],
    }),
    { day: "2026-11-09", after_day: null },
  );
});
