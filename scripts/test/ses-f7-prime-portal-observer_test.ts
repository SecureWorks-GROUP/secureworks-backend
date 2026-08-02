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
  observerPopulationForJobStatus,
  ObserverUsageError,
  parseOptions,
  planCaptureRevision,
  type PrimePortalVerdict,
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
