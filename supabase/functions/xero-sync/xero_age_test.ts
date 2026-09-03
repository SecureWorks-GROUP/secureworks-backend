// deno-lint-ignore-file no-import-prefix

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ageBucketDaysOverdue,
  parseXeroDotNetDate,
  resolveXeroInvoiceDueDate,
} from "./xero_age.ts";

Deno.test("Xero /Date()/ due dates are not parked in current", () => {
  const parsed = parseXeroDotNetDate("/Date(1757548800000+0000)/");
  assertEquals(parsed instanceof Date, true);
  assertEquals(Number.isNaN(parsed!.getTime()), false);
  const now = new Date("2026-09-11T00:00:00.000Z");
  const due = resolveXeroInvoiceDueDate(
    { DueDate: "/Date(1756339200000+0000)/" },
    now,
  );
  assertEquals(Number.isNaN(due.getTime()), false);
});

Deno.test("DueDateString wins over the /Date()/ form", () => {
  const due = resolveXeroInvoiceDueDate({
    DueDateString: "2026-08-01T00:00:00",
    DueDate: "/Date(0+0000)/",
  }, new Date("2026-09-11T00:00:00.000Z"));
  assertEquals(due.toISOString().slice(0, 10), "2026-08-01");
});

Deno.test("age buckets match Xero aged-payables windows", () => {
  assertEquals(ageBucketDaysOverdue(-3), "current");
  assertEquals(ageBucketDaysOverdue(0), "current");
  assertEquals(ageBucketDaysOverdue(1), "1-30");
  assertEquals(ageBucketDaysOverdue(31), "31-60");
  assertEquals(ageBucketDaysOverdue(61), "61-90");
  assertEquals(ageBucketDaysOverdue(91), "90+");
  assertEquals(ageBucketDaysOverdue(Number.NaN), "current");
});
