import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { _backfillOpenMakesafeContactsForTest, _groupTradeAssignmentsForTest, _isMakesafeAccessJobForTest, _isOpenTradeMakesafeDetailForTest } from "./index.ts";

Deno.test("MakeSafe access allows canonical makesafe type", () => {
  assertEquals(_isMakesafeAccessJobForTest({ type: "makesafe", job_number: "MLB-1" }), true);
});

Deno.test("MakeSafe access allows legacy SWMS job numbers even when type is not normalised", () => {
  assertEquals(_isMakesafeAccessJobForTest({ type: "misc", job_number: "SWMS-26509" }), true);
});

Deno.test("MakeSafe access still rejects ordinary non-SWMS jobs", () => {
  assertEquals(_isMakesafeAccessJobForTest({ type: "patio", job_number: "MLB-25000" }), false);
});

Deno.test("MakeSafe access allows make_safe spelling", () => {
  assertEquals(_isMakesafeAccessJobForTest({ type: "make_safe", job_number: "MLB-1" }), true);
});

Deno.test("Open MakeSafe pool backfills missing phone from primary job contact", () => {
  const jobs = [{ id: "job-1", client_name: "Kim Vo", client_phone: null }];
  const result = _backfillOpenMakesafeContactsForTest(jobs, [
    { job_id: "job-1", client_name: "Kim Vo", client_phone: "0400 111 222", is_primary: true, contact_label: "A" },
  ]);

  assertEquals(result[0].client_phone, "0400 111 222");
  assertEquals(result[0].contact_phone, "0400 111 222");
  assertEquals(result[0].contact_name, "Kim Vo");
});

Deno.test("Open MakeSafe pool does not overwrite an existing job phone", () => {
  const jobs = [{ id: "job-1", client_phone: "0400 000 000" }];
  const result = _backfillOpenMakesafeContactsForTest(jobs, [
    { job_id: "job-1", client_phone: "0400 999 999", is_primary: true, contact_label: "A" },
  ]);

  assertEquals(result[0].client_phone, "0400 000 000");
  assertEquals(result[0].contact_phone, "0400 999 999");
});

Deno.test("Open MakeSafe pool cards stay in makesafePool, not Today", () => {
  const grouped = _groupTradeAssignmentsForTest([
    { id: "makesafe-open-job-1", scheduled_date: "2026-06-08", assignment_type: "makesafe_open", role: "makesafe_open" },
    { id: "today-job-1", scheduled_date: "2026-06-08", assignment_type: "install", role: "lead" },
    { id: "week-job-1", scheduled_date: "2026-06-10", assignment_type: "install", role: "lead" },
  ], "2026-06-08", "2026-06-14");

  assertEquals(grouped.makesafePool.map((a: any) => a.id), ["makesafe-open-job-1"]);
  assertEquals(grouped.today.map((a: any) => a.id), ["today-job-1"]);
  assertEquals(grouped.thisWeek.map((a: any) => a.id), ["week-job-1"]);
});


Deno.test("Open MakeSafe pool excludes report-ready and invoicing detail states", () => {
  for (const substatus of ["admin_to_send_report", "report_ready", "ready_to_invoice", "to_invoice", "invoiced", "complete", "completed"]) {
    assertEquals(_isOpenTradeMakesafeDetailForTest({ substatus }), false);
  }
});

Deno.test("Open MakeSafe pool excludes details once report or invoice timestamps exist", () => {
  assertEquals(_isOpenTradeMakesafeDetailForTest({ report_received_at: "2026-06-08T01:00:00Z" }), false);
  assertEquals(_isOpenTradeMakesafeDetailForTest({ report_sent_at: "2026-06-08T01:00:00Z" }), false);
  assertEquals(_isOpenTradeMakesafeDetailForTest({ invoice_ready_at: "2026-06-08T01:00:00Z" }), false);
  assertEquals(_isOpenTradeMakesafeDetailForTest({ substatus: "assigned" }), true);
});
