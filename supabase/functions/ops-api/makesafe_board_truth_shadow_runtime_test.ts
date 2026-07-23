// deno-lint-ignore-file no-import-prefix no-explicit-any
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _makesafeStatusCanaryFromRowsForTest,
  _makesafeStatusDisagreementsFromRowsForTest,
  _persistMakesafeStatusShadowForTest,
} from "./index.ts";

function shadowRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    job_number: "SWMS-TEST",
    substatus: "waiting_on_trade_report",
    canonical_stage: "allocated",
    computed_status: "trade_report_in",
    computed_status_job_type: "physical_makesafe",
    computed_status_reasons: ["submitted report and photos present"],
    computed_status_missing: [],
    computed_status_hold: null,
    computed_status_at: "2026-07-23T00:00:00Z",
    computed_status_evidence: {
      report_received_at: "2026-07-23T00:00:00Z",
      has_submitted_service_report: true,
      has_current_portal_capture: false,
    },
    ...overrides,
  };
}

Deno.test("shadow persistence sends one bounded RPC payload and no declared field", async () => {
  const calls: any[] = [];
  const client = {
    rpc: (name: string, args: any) => {
      calls.push({ name, args });
      return Promise.resolve({ data: 1, error: null });
    },
  };
  const result = await _persistMakesafeStatusShadowForTest(client, [
    shadowRow(),
  ]);
  assertEquals(result, { ok: true, refreshed: 1 });
  assertEquals(calls.length, 1);
  assertEquals(calls[0].name, "refresh_makesafe_status_shadow");
  assertEquals(calls[0].args.p_rows[0], {
    job_id: "job-1",
    computed_status: "trade_report_in",
    reasons: ["submitted report and photos present"],
    missing: [],
    computed_at: "2026-07-23T00:00:00Z",
  });
  assertEquals("substatus" in calls[0].args.p_rows[0], false);
});

Deno.test("runtime disagreement response carries card, declared, computed and why", () => {
  const rows = _makesafeStatusDisagreementsFromRowsForTest([shadowRow()]);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].job_number, "SWMS-TEST");
  assertEquals(rows[0].declared_substatus, "waiting_on_trade_report");
  assertEquals(rows[0].declared_status, "allocated");
  assertEquals(rows[0].computed_status, "trade_report_in");
  assertEquals(rows[0].why_they_differ.reasons, [
    "submitted report and photos present",
  ]);
});

Deno.test("runtime canary is read-only and catches the SWMS-26953 contradiction shape", () => {
  const row = shadowRow({
    id: "job-26953",
    job_number: "SWMS-26953",
    canonical_stage: "report_ready",
  });
  const before = JSON.stringify(row);
  const result = _makesafeStatusCanaryFromRowsForTest([row]);
  assertEquals(result.ok, false);
  assertEquals(
    result.alarms.some((alarm: any) =>
      alarm.code === "report_received_with_pre_report_substatus"
    ),
    true,
  );
  assertEquals(JSON.stringify(row), before);
});
