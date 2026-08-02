// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  assertReadOnlySql,
  buildSafeEvidenceFrameHtml,
  classifyPrimePortalText,
  decideCaptureWrite,
  observerPopulationForJobStatus,
  ObserverUsageError,
  parseOptions,
  planCaptureRevision,
  type PrimePortalVerdict,
  printHelp,
  SES_PORTAL_CAPTURE_WRITE_ACTION,
} from "../ses-f7-prime-portal-observer.ts";

Deno.test("F7 classifies an observed locked Prime form as done even when fields are incomplete", () => {
  assertEquals(
    classifyPrimePortalText(
      "Prime\nThis form has been locked and is no longer available for editing or submission\n21 of 23",
    ),
    {
      outcome: "submitted_locked",
      capture_result: "done",
      reason_code: "locked_or_submitted_observed",
      answered_fields: 21,
      total_fields: 23,
      observed_phrase: "This form has been locked.",
      signal: "submitted/locked observed, 21 of 23 fields answered",
    },
  );
});

Deno.test("F7 classifies a reachable partially answered form as in progress", () => {
  const verdict = classifyPrimePortalText("Roof report\n8 of 23\nSubmit");
  assertEquals(verdict.outcome, "in_progress");
  assertEquals(verdict.capture_result, "not_done");
  assertEquals(verdict.reason_code, "answered_fields_without_submission");
});

Deno.test("F7 classifies an explicit zero-field form as not started", () => {
  const verdict = classifyPrimePortalText("Roof report\n0 of 23\nSubmit");
  assertEquals(verdict.outcome, "not_started");
  assertEquals(verdict.capture_result, "not_done");
  assertEquals(verdict.reason_code, "zero_answered_fields");
});

Deno.test("F7 treats an expired Prime link as cannot observe, never not done", () => {
  const verdict = classifyPrimePortalText(
    "This share link is no longer active or has expired.",
  );
  assertEquals(verdict.outcome, "cannot_observe");
  assertEquals(verdict.capture_result, "unreachable");
  assertEquals(verdict.reason_code, "expired_or_inactive_link");
});

Deno.test("F7 treats a failed or empty page as cannot observe", () => {
  const failed = classifyPrimePortalText("", false);
  assertEquals(failed.outcome, "cannot_observe");
  assertEquals(failed.capture_result, "unreachable");
  assertEquals(failed.reason_code, "page_failed_to_load");
});

Deno.test("F7 labels archived evidence off-board without dropping it", () => {
  assertEquals(
    observerPopulationForJobStatus("allocated"),
    "canonical_live_board",
  );
  assertEquals(
    observerPopulationForJobStatus("archived"),
    "off_board_observed",
  );
});

Deno.test("F7 idempotency planner skips an unchanged exact-cycle capture", () => {
  const candidate = {
    job_id: "job-1",
    attendance_cycle_id: "cycle-1",
    role: "roof_report" as const,
    capture_result: "done" as const,
    source_url: "https://WWW.primeeco.tech/share/example",
    source_content_hash: `sha256:${"1".repeat(64)}`,
    screenshot_content_hash: `sha256:${"2".repeat(64)}`,
  };
  assertEquals(
    planCaptureRevision(candidate, [{
      ...candidate,
      source_url: "https://www.primeeco.tech/share/example",
      screenshot_content_hash: `sha256:${"9".repeat(64)}`,
    }]),
    {
      action: "idempotent_noop",
      reason: "unchanged_capture_exists",
    },
  );
  assertEquals(
    planCaptureRevision(candidate, [{
      ...candidate,
      screenshot_content_hash: null,
    }]),
    {
      action: "create_revision",
      reason: "new_or_changed_observation",
    },
  );
  assertEquals(
    planCaptureRevision(candidate, [{
      ...candidate,
      source_content_hash: `sha256:${"3".repeat(64)}`,
    }]),
    {
      action: "create_revision",
      reason: "new_or_changed_observation",
    },
  );
});

Deno.test("F7 evidence frame ignores arbitrary page/client text", () => {
  const injected = {
    outcome: "in_progress",
    capture_result: "not_done",
    reason_code: "answered_fields_without_submission",
    answered_fields: 4,
    total_fields: 23,
    observed_phrase: "PRIVATE_NAME_TOKEN PRIVATE_ADDRESS_TOKEN",
    signal: "PRIVATE_EMAIL_TOKEN PRIVATE_PHONE_TOKEN",
  } satisfies PrimePortalVerdict;
  const html = buildSafeEvidenceFrameHtml({
    jobNumber: "SWMS-TEST",
    builderReference: "MLB-TEST",
    verdict: injected,
    capturedAt: "2026-08-02T00:00:00.000Z",
  });
  assert(!html.includes("PRIVATE_NAME_TOKEN"));
  assert(!html.includes("PRIVATE_ADDRESS_TOKEN"));
  assert(!html.includes("PRIVATE_EMAIL_TOKEN"));
  assert(!html.includes("PRIVATE_PHONE_TOKEN"));
  assert(html.includes("4 of 23"));
  assert(html.includes("Job details panel redacted before capture"));
});

Deno.test("F7 Management API guard accepts SELECT and refuses writes", () => {
  assertReadOnlySql("select job_id from makesafe_job_details");
  assertThrows(
    () => assertReadOnlySql("update makesafe_job_details set substatus='x'"),
    Error,
    "refused non-SELECT",
  );
});

Deno.test("F7 observer CLI rejects unknown flags before doing work", () => {
  assertThrows(
    () => parseOptions(["--write=true"]),
    ObserverUsageError,
    "unknown flag --write",
  );
  assertEquals(parseOptions(["--help"]).help, true);
});

Deno.test("F7 observer does not write unless --commit is asked for explicitly", () => {
  // Dry run is what you get by default, and by every accidental spelling.
  for (const args of [[], ["--job=SWMS-1"], ["--limit=3"]]) {
    assertEquals(parseOptions(args).commit, false);
  }
  assertEquals(parseOptions(["--job=SWMS-1", "--commit"]).commit, true);

  // `--commit=false` must not read as "off" - it is a switch, and a caller who
  // types a value has misunderstood it.
  assertThrows(
    () => parseOptions(["--job=SWMS-1", "--commit=false"]),
    ObserverUsageError,
    "--commit is a switch and takes no value",
  );
});

Deno.test("F7 observer refuses to commit board-wide", () => {
  assertThrows(
    () => parseOptions(["--commit"]),
    ObserverUsageError,
    "--commit requires --job=",
  );
  assertThrows(
    () => parseOptions(["--limit=50", "--commit"]),
    ObserverUsageError,
    "--commit requires --job=",
  );
  // The write cap defaults to one and is meaningless without a commit run.
  assertEquals(parseOptions(["--job=SWMS-1", "--commit"]).maxWrites, 1);
  assertEquals(
    parseOptions(["--job=SWMS-1", "--commit", "--max-writes=3"]).maxWrites,
    3,
  );
  assertThrows(
    () => parseOptions(["--max-writes=3"]),
    ObserverUsageError,
    "--max-writes is only meaningful with --commit",
  );
  assertThrows(
    () => parseOptions(["--job=SWMS-1", "--commit", "--max-writes=0"]),
    ObserverUsageError,
    "--max-writes must be a positive integer",
  );
});

Deno.test("F7 write decision cannot upgrade an unrecordable observation", () => {
  const base = { writesUsed: 0, maxWrites: 1 };
  // A missing element is refused in BOTH modes, and keeps its reason.
  for (const commit of [false, true]) {
    assertEquals(
      decideCaptureWrite({
        ...base,
        commit,
        plannedAction: "cannot_record",
        planReason: "missing_builder_reference",
      }),
      { outcome: "write_refused", reason: "missing_builder_reference" },
    );
  }
  // A recordable observation is still only planned without --commit.
  assertEquals(
    decideCaptureWrite({
      ...base,
      commit: false,
      plannedAction: "create_revision",
      planReason: "new_or_changed_observation",
    }),
    { outcome: "dry_run", reason: "commit_not_requested" },
  );
  assertEquals(
    decideCaptureWrite({
      ...base,
      commit: true,
      plannedAction: "create_revision",
      planReason: "new_or_changed_observation",
    }),
    { outcome: "written", reason: "new_or_changed_observation" },
  );
});

Deno.test("F7 write cap reports what it left behind rather than dropping it", () => {
  assertEquals(
    decideCaptureWrite({
      commit: true,
      plannedAction: "create_revision",
      planReason: "new_or_changed_observation",
      writesUsed: 1,
      maxWrites: 1,
    }),
    { outcome: "write_skipped_write_cap", reason: "write_cap_reached_at_1" },
  );
});

Deno.test("F7 observer help documents the write path and its default", () => {
  const help: string[] = [];
  const realLog = console.log;
  console.log = (line: string) => help.push(line);
  try {
    parseOptions(["--help"]);
    printHelp();
  } finally {
    console.log = realLog;
  }
  const text = help.join("\n");
  assert(text.includes("dry-run by default"));
  assert(text.includes("--commit,false"));
  assert(text.includes("requires --job"));
  assert(text.includes(SES_PORTAL_CAPTURE_WRITE_ACTION));
  assert(
    text.includes("An unreachable or expired link records cannot-observe"),
  );
});
