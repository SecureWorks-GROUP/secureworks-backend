import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { _assertAssignedOrMakesafeAccessForTest, _backfillOpenMakesafeContactsForTest, _groupTradeAssignmentsForTest, _isMakesafeAccessJobForTest, _isOpenTradeMakesafeDetailForTest } from "./index.ts";

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

function makeAccessClient(job: any) {
  return {
    from(table: string) {
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        neq: () => builder,
        limit: () => builder,
        maybeSingle: async () => {
          if (table === "job_assignments") return { data: null, error: null };
          if (table === "jobs") return { data: job, error: null };
          if (table === "makesafe_job_details") return { data: job?.has_makesafe_detail ? { job_id: job.id } : null, error: null };
          return { data: null, error: null };
        },
      };
      return builder;
    },
  };
}

Deno.test("Unassigned MakeSafe report access is available to logged-in trades", async () => {
  await _assertAssignedOrMakesafeAccessForTest(
    makeAccessClient({ id: "job-ms", type: "makesafe", job_number: "SWMS-26600" }),
    "job-ms",
    "trade-user",
    false,
  );
});

Deno.test("Unassigned ordinary jobs remain allocation-gated", async () => {
  await assertRejects(
    () => _assertAssignedOrMakesafeAccessForTest(
      makeAccessClient({ id: "job-patio", type: "patio", job_number: "SWP-26000" }),
      "job-patio",
      "trade-user",
      false,
    ),
    Error,
    "You are not assigned to this job",
  );
});

Deno.test("same-tenant fencing manager may read an unassigned managed fencing job", async () => {
  await _assertAssignedOrMakesafeAccessForTest(
    makeAccessClient({
      id: "job-fence",
      org_id: "tenant-a",
      type: "fencing",
      job_number: "SWF-26593",
    }),
    "job-fence",
    "henry",
    false,
    { orgId: "tenant-a", managedVerticals: ["fencing"] },
  );
});

Deno.test("fencing manager is denied an unmanaged same-tenant vertical", async () => {
  await assertRejects(
    () => _assertAssignedOrMakesafeAccessForTest(
      makeAccessClient({
        id: "job-patio",
        org_id: "tenant-a",
        type: "patio",
        job_number: "SWP-1",
      }),
      "job-patio",
      "henry",
      false,
      { orgId: "tenant-a", managedVerticals: ["fencing"] },
    ),
    Error,
    "You are not assigned to this job",
  );
});

Deno.test("fencing manager is denied a managed vertical in another tenant", async () => {
  await assertRejects(
    () => _assertAssignedOrMakesafeAccessForTest(
      makeAccessClient({
        id: "job-fence-b",
        org_id: "tenant-b",
        type: "fencing",
        job_number: "SWF-B",
      }),
      "job-fence-b",
      "henry",
      false,
      { orgId: "tenant-a", managedVerticals: ["fencing"] },
    ),
    Error,
    "not authorized",
  );
});

Deno.test("dispatcher retains same-tenant unassigned detail access", async () => {
  await _assertAssignedOrMakesafeAccessForTest(
    makeAccessClient({
      id: "job-patio",
      org_id: "tenant-a",
      type: "patio",
      job_number: "SWP-1",
    }),
    "job-patio",
    "dispatcher",
    true,
    { orgId: "tenant-a", managedVerticals: [] },
  );
});
