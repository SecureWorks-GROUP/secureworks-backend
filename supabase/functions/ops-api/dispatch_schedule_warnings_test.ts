// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { dispatchScheduleWarnings } from "./dispatch_schedule_warnings.ts";

const proposed = "2026-11-06";
const confirmed = (delivery_date: string) => ({
  supplier_id: "fabricator",
  supplier_name: "Example Fabricator",
  delivery_date,
  date_confirmed: true,
  date_source: "box",
  box_date_source: "supplier_reply",
});

Deno.test("proposed install before confirmed fabrication date warns with provenance", () => {
  const result = dispatchScheduleWarnings(proposed, {
    orders: [confirmed("2026-11-09")],
  }, true);
  assertEquals(result.latest_confirmed_delivery_date, "2026-11-09");
  assertEquals(result.schedule_warnings.map((w) => w.code), [
    "supplier_ready_after_install",
  ]);
  assertEquals(result.schedule_warnings[0].box_date_source, "supplier_reply");
  assertEquals(result.schedule_warnings[0].date_confirmed, true);
});

Deno.test("confirmed date on or before proposed install has no date warning", () => {
  const result = dispatchScheduleWarnings(proposed, {
    orders: [confirmed("2026-11-05"), confirmed(proposed)],
  }, true);
  assertEquals(result.latest_confirmed_delivery_date, proposed);
  assertEquals(result.schedule_warnings, []);
});

Deno.test("latest supplier date governs the warning, never an average or earlier supplier", () => {
  const result = dispatchScheduleWarnings(proposed, {
    orders: [
      confirmed("2026-11-05"),
      confirmed("2026-11-10"),
      confirmed("2026-11-09"),
    ],
  }, true);
  assertEquals(result.latest_confirmed_delivery_date, "2026-11-10");
  assertEquals(result.schedule_warnings.length, 2);
});

Deno.test("a requested date is uncertain and never becomes confirmed readiness", () => {
  const result = dispatchScheduleWarnings(proposed, {
    orders: [{
      ...confirmed("2026-11-09"),
      date_confirmed: false,
      date_source: "requested",
      box_date_source: null,
    }],
  }, true);
  assertEquals(result.latest_confirmed_delivery_date, null);
  assertEquals(result.schedule_warnings.map((w) => w.code), [
    "supplier_date_unconfirmed",
    "supplier_ready_after_install",
  ]);
  assertEquals(result.schedule_warnings.every((w) => !w.date_confirmed), true);
});

Deno.test("missing dates warn without inventing fabrication days", () => {
  const result = dispatchScheduleWarnings(proposed, {
    orders: [{ supplier_name: "Example Fabricator" }],
  }, true);
  assertEquals(result.latest_confirmed_delivery_date, null);
  assertEquals(result.schedule_warnings[0].code, "supplier_date_missing");
  assertEquals(result.schedule_warnings[0].delivery_date, null);
});

Deno.test("no supplier rows or unreadable rows remain unknown", () => {
  assertEquals(
    dispatchScheduleWarnings(proposed, { orders: [] }, true)
      .schedule_warnings[0].code,
    "supplier_dates_missing",
  );
  assertEquals(
    dispatchScheduleWarnings(proposed, null, false).schedule_warnings[0].code,
    "supplier_dates_unreadable",
  );
});

Deno.test("delivered materials and extra orders do not warn or move an install", () => {
  const input = {
    orders: [{ ...confirmed("2026-11-09"), material_stage: "delivered" }, {
      ...confirmed("2026-11-10"),
      extra: true,
    }],
  };
  const before = structuredClone(input);
  const result = dispatchScheduleWarnings(proposed, input, true);
  assertEquals(result.schedule_warnings, []);
  assertEquals(result.proposed_install_date, proposed);
  assertEquals(input, before);
});
