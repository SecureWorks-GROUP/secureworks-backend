// deno-lint-ignore-file no-import-prefix no-explicit-any
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _makesafeReportingIntakePassResponseForTest,
  _runMakesafeReportingIntakePassForTest,
  _scanSesMakesafesForTest,
} from "./index.ts";

Deno.test("standing SES scan enforces the edge CPU source budget and returns its bounded report", async () => {
  let capturedOptions: any = null;
  let runs = 0;

  const report = await _scanSesMakesafesForTest(
    { fake: "client" },
    {
      loadRollout: () =>
        Promise.resolve({
          selectionMode: "full_open",
          maxCases: 10,
          sourcePostIds: [],
          instructionKeys: [],
        }),
      autoApproveEnabled: () => false,
      run: (_client, options) => {
        runs++;
        capturedOptions = options;
        return Promise.resolve({
          ok: true,
          completion_status: "completed",
          source_read: {
            cap: options.maxSources,
            next_cursor_at: "2026-06-05T05:40:00.000Z",
          },
        });
      },
    },
  );

  assertEquals(runs, 1);
  assertEquals(capturedOptions.maxSources, 4);
  assertEquals(capturedOptions.dryRun, false);
  assertEquals(capturedOptions.selectionMode, "full_open");
  assertEquals(capturedOptions.days, 60);
  assertEquals(capturedOptions.onlyUnscanned, false);
  assertEquals(report.ok, true);
  assertEquals(report.source_read, {
    cap: 4,
    next_cursor_at: "2026-06-05T05:40:00.000Z",
  });
});

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
          mode: "deterministic",
          completion_status: "completed",
          cases_committed: 2,
          evidence: {
            durable_source_fates: {
              checked: 3,
              final: 2,
              transient: 1,
            },
          },
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
  assertEquals(result.accounting, { checked: 3, final: 2, transient: 1 });
  assertEquals(result.advancement.auto_approved_count, 2);
});

Deno.test("SES reporting handler returns bounded JSON and no advancement after a deterministic write failure", async () => {
  let advances = 0;
  const response = await _makesafeReportingIntakePassResponseForTest(
    { fake: "client" },
    {
      scan: () =>
        Promise.resolve({
          mode: "deterministic",
          completion_status: "completed_degraded",
          selection: { selected_cases: 2, selected_sources: 2 },
          totals: {
            cases_attempted: 2,
            cases_failed: 1,
            cases_deferred: 0,
            write_failures: 1,
            drafts_created: 1,
            jobs_created: 1,
          },
          evidence: {
            durable_source_fates: { checked: 2, final: 1, transient: 1 },
          },
          isolated_failures: Array.from(
            { length: 100 },
            () => ({ detail: "must-not-enter-the-http-response" }),
          ),
        }),
      advance: () => {
        advances++;
        return Promise.resolve({});
      },
    },
  );

  assertEquals(advances, 0);
  assertEquals(response.status, 503);
  assertEquals(response.headers.get("content-type"), "application/json");
  const text = await response.text();
  assert(
    text.length < 2_048,
    `expected bounded JSON, got ${text.length} bytes`,
  );
  assertEquals(text.includes("must-not-enter-the-http-response"), false);
  assertEquals(JSON.parse(text), {
    contract_version: "makesafe-reporting-intake-pass.v2",
    ok: false,
    error: "deterministic_write_failure",
    trigger: "ses-reporting-skill",
    bounded_intake_passes: 1,
    advancement_limit: 100,
    intake: {
      completion_status: "completed_degraded",
      selected_cases: 2,
      selected_sources: 2,
      cases_attempted: 2,
      cases_failed: 1,
      cases_deferred: 0,
      write_failures: 1,
      drafts_created: 1,
      jobs_created: 1,
    },
    accounting: { checked: 2, final: 1, transient: 1 },
    advancement: {
      started: false,
      checked_count: 0,
      auto_approved_count: 0,
      skipped_count: 0,
      failed_count: 0,
    },
  });
});

Deno.test("SES reporting distinguishes non-write degraded scans from deterministic write failures", async () => {
  let advances = 0;
  const response = await _makesafeReportingIntakePassResponseForTest(
    { fake: "client" },
    {
      scan: () =>
        Promise.resolve({
          mode: "deterministic",
          completion_status: "completed_degraded",
          selection: { selected_cases: 1, selected_sources: 1 },
          totals: {
            cases_attempted: 1,
            cases_failed: 1,
            cases_deferred: 0,
            write_failures: 0,
            drafts_created: 0,
            jobs_created: 0,
          },
          evidence: {
            durable_source_fates: { checked: 1, final: 1, transient: 0 },
          },
        }),
      advance: () => {
        advances++;
        return Promise.resolve({});
      },
    },
  );

  assertEquals(advances, 0);
  assertEquals(response.status, 503);
  const body = await response.json();
  assertEquals(body.error, "deterministic_intake_degraded");
  assertEquals(body.intake.cases_failed, 1);
  assertEquals(body.intake.write_failures, 0);
});

Deno.test("SES reporting handler preserves a bounded healthy JSON proof", async () => {
  const response = await _makesafeReportingIntakePassResponseForTest(
    { fake: "client" },
    {
      scan: () =>
        Promise.resolve({
          mode: "deterministic",
          completion_status: "completed",
          selection: { selected_cases: 1, selected_sources: 2 },
          totals: {
            cases_attempted: 1,
            cases_failed: 0,
            cases_deferred: 0,
            write_failures: 0,
            drafts_created: 1,
            jobs_created: 1,
          },
          evidence: {
            durable_source_fates: { checked: 2, final: 2, transient: 0 },
          },
        }),
      advance: () =>
        Promise.resolve({
          checked_count: 3,
          auto_approved_count: 1,
          skipped_count: 2,
          failed_count: 0,
        }),
    },
  );

  assertEquals(response.status, 200);
  assertEquals(response.headers.get("content-type"), "application/json");
  const body = await response.json();
  assertEquals(body.ok, true);
  assertEquals(body.error, undefined);
  assertEquals(body.intake.completion_status, "completed");
  assertEquals(body.accounting, { checked: 2, final: 2, transient: 0 });
  assertEquals(body.advancement, {
    started: true,
    checked_count: 3,
    auto_approved_count: 1,
    skipped_count: 2,
    failed_count: 0,
  });
});

Deno.test("SES reporting preserves existing healthy-scan advancement result semantics", async () => {
  const response = await _makesafeReportingIntakePassResponseForTest(
    { fake: "client" },
    {
      scan: () =>
        Promise.resolve({
          mode: "deterministic",
          completion_status: "completed",
          selection: { selected_cases: 1, selected_sources: 1 },
          totals: {
            cases_attempted: 1,
            cases_failed: 0,
            cases_deferred: 0,
            write_failures: 0,
            drafts_created: 1,
            jobs_created: 0,
          },
          evidence: {
            durable_source_fates: { checked: 1, final: 1, transient: 0 },
          },
        }),
      advance: () =>
        Promise.resolve({
          checked_count: 1,
          auto_approved_count: 0,
          skipped_count: 0,
          failed_count: 1,
        }),
    },
  );

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.ok, true);
  assertEquals(body.advancement, {
    started: true,
    checked_count: 1,
    auto_approved_count: 0,
    skipped_count: 0,
    failed_count: 1,
  });
});

Deno.test("SES reporting stops before advancement when source-fate evidence is incomplete", async () => {
  let advances = 0;
  await assertRejects(
    () =>
      _runMakesafeReportingIntakePassForTest(
        {},
        {
          scan: () =>
            Promise.resolve({
              mode: "deterministic",
              evidence: {
                durable_source_fates: {
                  checked: 2,
                  final: 1,
                  transient: 0,
                },
              },
            }),
          advance: () => {
            advances++;
            return Promise.resolve({});
          },
        },
      ),
    Error,
    "source-fate assertion is incomplete",
  );
  assertEquals(advances, 0);
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
