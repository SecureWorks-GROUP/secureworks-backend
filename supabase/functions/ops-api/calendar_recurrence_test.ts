// Calendar recurrence rule -> dates (pure). See calendar_recurrence.ts.
import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  expandRecurrenceDates,
  normaliseRecurrenceRule,
  RECURRENCE_MAX_OCCURRENCES,
  RecurrenceRuleError,
} from "./calendar_recurrence.ts";

const expand = (start: string, raw: unknown) => expandRecurrenceDates(start, normaliseRecurrenceRule(raw)!);

Deno.test("no repeat: missing, null and freq none all mean a single event", () => {
  assertEquals(normaliseRecurrenceRule(undefined), null);
  assertEquals(normaliseRecurrenceRule(null), null);
  assertEquals(normaliseRecurrenceRule({ freq: "none" }), null);
});

Deno.test("weekly, never ends = every week up to (not including) the same date next year", () => {
  const dates = expand("2026-10-05", { freq: "weekly", interval: 1, endType: "never" });
  // The bound is the day before the anniversary, so Mon 4 Oct 2027 is the
  // last meeting: 53 Mondays in all.
  assertEquals(dates.length, 53);
  assertEquals(dates[0], "2026-10-05");
  assertEquals(dates[1], "2026-10-12");
  assertEquals(dates[52], "2027-10-04");
  for (const d of dates) assertEquals(new Date(d + "T00:00:00Z").getUTCDay(), 1, `${d} is a Monday`);
});

Deno.test("weekly after N occurrences", () => {
  assertEquals(expand("2026-10-07", { freq: "weekly", endType: "count", endCount: 3 }), [
    "2026-10-07", "2026-10-14", "2026-10-21",
  ]);
});

Deno.test("end on date is inclusive", () => {
  assertEquals(expand("2026-10-09", { freq: "weekly", endType: "date", endDate: "2026-10-23" }), [
    "2026-10-09", "2026-10-16", "2026-10-23",
  ]);
});

Deno.test("daily with interval", () => {
  assertEquals(expand("2026-10-05", { freq: "daily", interval: 2, endType: "count", endCount: 3 }), [
    "2026-10-05", "2026-10-07", "2026-10-09",
  ]);
});

Deno.test("weekdays skips Saturday and Sunday", () => {
  assertEquals(expand("2026-10-08", { freq: "weekdays", endType: "count", endCount: 4 }), [
    "2026-10-08", "2026-10-09", "2026-10-12", "2026-10-13",
  ]);
});

Deno.test("monthly skips months without the day instead of clamping", () => {
  assertEquals(expand("2026-01-31", { freq: "monthly", endType: "count", endCount: 3 }), [
    "2026-01-31", "2026-03-31", "2026-05-31",
  ]);
});

Deno.test("yearly", () => {
  assertEquals(expand("2026-12-25", { freq: "yearly", endType: "count", endCount: 2 }), [
    "2026-12-25", "2027-12-25",
  ]);
});

Deno.test("custom: every 2 weeks on Mon + Wed (0 = Mon, the modal's picker order)", () => {
  assertEquals(expand("2026-10-05", { freq: "custom", interval: 2, endType: "count", endCount: 4, days: [0, 2] }), [
    "2026-10-05", "2026-10-07", "2026-10-19", "2026-10-21",
  ]);
});

Deno.test("custom: chosen days before the start date in week one are skipped", () => {
  // Start Wed 7 Oct; Mon 5 Oct is earlier and must not appear.
  assertEquals(expand("2026-10-07", { freq: "custom", interval: 1, endType: "count", endCount: 3, days: [0, 4] }), [
    "2026-10-09", "2026-10-12", "2026-10-16",
  ]);
});

Deno.test("every series is capped", () => {
  const dates = expand("2026-10-05", { freq: "daily", endType: "count", endCount: 5000 });
  assertEquals(dates.length, RECURRENCE_MAX_OCCURRENCES);
});

Deno.test("bad rules are refused with a RecurrenceRuleError", () => {
  assertThrows(() => normaliseRecurrenceRule({ freq: "fortnightly" }), RecurrenceRuleError);
  assertThrows(() => normaliseRecurrenceRule({ freq: "weekly", interval: 0 }), RecurrenceRuleError);
  assertThrows(() => normaliseRecurrenceRule({ freq: "weekly", endType: "date" }), RecurrenceRuleError);
  assertThrows(() => normaliseRecurrenceRule({ freq: "weekly", endType: "count", endCount: 0 }), RecurrenceRuleError);
  assertThrows(() => normaliseRecurrenceRule({ freq: "custom", days: [7] }), RecurrenceRuleError);
  assertThrows(
    () => expand("2026-10-05", { freq: "weekly", endType: "date", endDate: "2026-10-01" }),
    RecurrenceRuleError,
  );
});
