// deno-lint-ignore-file no-import-prefix no-explicit-any
import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { _runMakesafeReportingIntakePassForTest } from "./index.ts";

Deno.test("SES reporting run triggers exactly one bounded scan and one bounded guarded advancement sweep", async () => {
  let scans = 0;
  let advances = 0;
  let advanceBody: any = null;

  const result = await _runMakesafeReportingIntakePassForTest(
    { fake: "client" },
    {
      scan: () => {
        scans++;
        return Promise.resolve({
          completion_status: "completed",
          cases_committed: 2,
        });
      },
      advance: (_client, body) => {
        advances++;
        advanceBody = body;
        return Promise.resolve({
          checked_count: 3,
          auto_approved_count: 2,
          skipped_count: 1,
          failed_count: 0,
        });
      },
    },
  );

  assertEquals(scans, 1);
  assertEquals(advances, 1);
  assertEquals(advanceBody, {
    limit: 100,
    dry_run: false,
    triggered_by: "ses-reporting-skill",
  });
  assertEquals(result.bounded_intake_passes, 1);
  assertEquals(result.advancement_limit, 100);
  assertEquals(result.intake.completion_status, "completed");
  assertEquals(result.advancement.auto_approved_count, 2);
});

Deno.test("SES reporting hook never retries a failed scanner or starts advancement after it", async () => {
  let scans = 0;
  let advances = 0;

  await assertRejects(
    () =>
      _runMakesafeReportingIntakePassForTest(
        {},
        {
          scan: () => {
            scans++;
            return Promise.reject(new Error("scanner unavailable"));
          },
          advance: () => {
            advances++;
            return Promise.resolve({});
          },
        },
      ),
    Error,
    "scanner unavailable",
  );

  assertEquals(scans, 1);
  assertEquals(advances, 0);
});
