import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _classifyExtractionFailureForTest as classifyFailure,
  _extractionCycleHealthForTest as cycleHealth,
  _extractionFailureStateForTest as failureState,
  _INTAKE_EXTRACTION_DOWN_MARKER,
  _isAnthropicAuthFailureForTest as isAuthFailure,
  _itemLocalQuarantineEventForTest as itemLocalQuarantineEvent,
} from "./index.ts";
import { scanMarkEligible } from "./makesafe_intake_scan_marker.ts";

// D-a: a DEAD/absent key (auth failure) must be distinguished from a transient blip.
// Auth failure degrades the whole scan loud; a transient failure only flags one email.

Deno.test("isAnthropicAuthFailure: HTTP 401 is an auth failure (dead key)", () => {
  assert(isAuthFailure({ status: 401, message: "Unauthorized" }));
});

Deno.test("isAnthropicAuthFailure: HTTP 403 is an auth failure", () => {
  assert(isAuthFailure({ status: 403 }));
});

Deno.test("isAnthropicAuthFailure: SDK authentication_error type is an auth failure", () => {
  assert(
    isAuthFailure({ error: { type: "authentication_error" }, message: "x" }),
  );
});

Deno.test("isAnthropicAuthFailure: 'invalid x-api-key' message is an auth failure", () => {
  assert(isAuthFailure(new Error("invalid x-api-key: the key is revoked")));
});

Deno.test("isAnthropicAuthFailure: AuthenticationError name is an auth failure", () => {
  const e = new Error("bad key");
  e.name = "AuthenticationError";
  assert(isAuthFailure(e));
});

Deno.test("regression: exact Anthropic spend-cap 400 is terminal usage_cap", () => {
  const result = classifyFailure({
    status: 400,
    error: { type: "invalid_request_error" },
    message:
      "You have reached your specified API usage limits. You will regain access on 2026-08-01 at 00:00 UTC.",
  });
  assertEquals(result, {
    failureClass: "terminal",
    reason: "usage_cap",
    quarantine: true,
    stopProviderLane: true,
  });
  assertEquals(failureState(result, "usage cap").retry_state, "quarantined");
  // Usage cap is distinct from auth, despite both being terminal.
  assertEquals(
    isAuthFailure({ status: 400, message: "specified API usage limits" }),
    false,
  );
});

Deno.test("genuinely transient failures remain retryable", () => {
  assertEquals(
    classifyFailure({ status: 429, message: "rate limit exceeded" }).reason,
    "rate_limited",
  );
  assertEquals(
    classifyFailure({ status: 500, message: "internal server error" })
      .failureClass,
    "retryable",
  );
  assertEquals(
    classifyFailure(new Error("connection reset by peer")).reason,
    "network_error",
  );
  assertEquals(
    failureState(classifyFailure({ status: 500 }), "500").retry_state,
    "retryable",
  );
});

Deno.test("not every 400 is a usage cap; item-invalid requests quarantine without stopping the lane", () => {
  assertEquals(
    classifyFailure({
      status: 400,
      error: { type: "invalid_request_error" },
      message: "invalid request: PDF block is malformed",
    }),
    {
      failureClass: "terminal",
      reason: "request_invalid",
      quarantine: true,
      stopProviderLane: false,
    },
  );
  assertEquals(
    classifyFailure({ status: 400, message: "temporarily overloaded" })
      .failureClass,
    "retryable",
  );
});

Deno.test("cycle health: full failure degrades, while partial success stays OK", () => {
  assertEquals(
    cycleHealth({
      attempts: 3,
      successes: 0,
      terminalFailures: 0,
      retryableFailures: 3,
      reasons: ["upstream_5xx", "upstream_5xx", "upstream_5xx"],
    }),
    { status: "degraded", reason: "wholesale_upstream_5xx" },
  );
  assertEquals(
    cycleHealth({
      attempts: 3,
      successes: 1,
      terminalFailures: 0,
      retryableFailures: 2,
      reasons: ["network_error", "upstream_5xx"],
    }),
    { status: "ok", reason: null },
  );
});

Deno.test("terminal provider failure degrades even if no later calls are attempted", () => {
  assertEquals(
    cycleHealth({
      attempts: 1,
      successes: 0,
      terminalFailures: 1,
      retryableFailures: 0,
      reasons: ["usage_cap"],
      providerLaneTerminalReason: "usage_cap",
    }),
    { status: "degraded", reason: "usage_cap" },
  );
});

Deno.test("isAnthropicAuthFailure: a 500 / network blip is NOT an auth failure (transient)", () => {
  assertEquals(
    isAuthFailure({ status: 500, message: "internal server error" }),
    false,
  );
  assertEquals(isAuthFailure(new Error("connection reset by peer")), false);
  assertEquals(isAuthFailure(new Error("JSON parse error")), false);
});

Deno.test("extraction-down marker is the stable blocking-field constant", () => {
  // It must NOT be one of the AUTO_APPROVE_ALLOWED_MISSING_FIELDS values, so its
  // presence blocks auto-file. (The value is asserted so a rename is a visible diff.)
  assertEquals(_INTAKE_EXTRACTION_DOWN_MARKER, "extraction_down_key_dead");
});

// ── Recovery semantics regressions (decision: intake-quarantine-recovery) ──────

Deno.test("regression: a BARE 404 does not stop the provider lane without model/config evidence", () => {
  const bare = classifyFailure({ status: 404, message: "Not Found" });
  assertEquals(bare.failureClass, "retryable");
  assertEquals(bare.stopProviderLane, false);
  assertEquals(bare.quarantine, false);

  // Corroborated model/configuration evidence IS lane-terminal.
  const proven = classifyFailure({
    status: 404,
    message: "model claude-nope-1 does not exist",
  });
  assertEquals(proven.failureClass, "terminal");
  assertEquals(proven.reason, "configuration_failed");
  assertEquals(proven.stopProviderLane, true);
});

Deno.test("regression: every failure state stays automatically recoverable", () => {
  for (
    const err of [
      { status: 400, message: "exceed your specified API usage limits" },
      { status: 401, message: "invalid x-api-key" },
      { status: 404, message: "unsupported model" },
      { status: 429, message: "rate limit" },
      new Error("fetch failed"),
    ]
  ) {
    const state = failureState(classifyFailure(err), "boom");
    assertEquals(state.recoverable, true);
    // Recovery never requires a human: the source item's scan marker stays unset.
    assertEquals(state.recovery_action, "automatic_rescan");
  }
});

Deno.test("regression: a wholesale retryable cycle degrades health so nothing claims a false OK", () => {
  assertEquals(
    cycleHealth({
      attempts: 4,
      successes: 0,
      terminalFailures: 0,
      retryableFailures: 4,
      reasons: ["rate_limited", "rate_limited", "rate_limited", "rate_limited"],
      providerLaneTerminalReason: null,
    }),
    { status: "degraded", reason: "wholesale_rate_limited" },
  );
});

Deno.test("regression: a text-only 401 with no status property is still a dead key", () => {
  const failure = classifyFailure(
    new Error("Request failed with status 401"),
  );
  assertEquals(failure.reason, "auth_failed");
  assertEquals(failure.stopProviderLane, true);
  assert(isAuthFailure(new Error("Request failed with status 403")));
});

Deno.test("regression: one isolated retryable failure is retrying, not degraded", () => {
  assertEquals(
    cycleHealth({
      attempts: 1,
      successes: 0,
      terminalFailures: 0,
      retryableFailures: 1,
      reasons: ["rate_limited"],
      providerLaneTerminalReason: null,
    }),
    { status: "ok", reason: null },
  );
  // Two failed attempts with zero successes is corroborating wholesale evidence.
  assertEquals(
    cycleHealth({
      attempts: 2,
      successes: 0,
      terminalFailures: 0,
      retryableFailures: 2,
      reasons: ["rate_limited", "rate_limited"],
      providerLaneTerminalReason: null,
    }).status,
    "degraded",
  );
});

Deno.test("regression: a single item-local request_invalid does not degrade the cycle", () => {
  assertEquals(
    cycleHealth({
      attempts: 1,
      successes: 0,
      terminalFailures: 1,
      retryableFailures: 0,
      reasons: ["request_invalid"],
      providerLaneTerminalReason: null,
    }),
    { status: "ok", reason: null },
  );
});

Deno.test("regression: item-local request_invalid recovers by requeue, provider outages by rescan", () => {
  const itemLocal = failureState(
    classifyFailure({ status: 400, message: "invalid_request_error" }),
    "malformed",
  );
  assertEquals(itemLocal.reason, "request_invalid");
  assertEquals(itemLocal.recovery_action, "manual_requeue");
  assertEquals(itemLocal.manual_recovery_action, "reextract_intake_draft");
  const providerWide = failureState(
    classifyFailure({ status: 400, message: "exceed your specified API usage limits" }),
    "cap",
  );
  assertEquals(providerWide.recovery_action, "automatic_rescan");
});

// An incidental "401"/"403" inside a serialised error body or request id must NOT be read
// as a dead key: that would stop the provider lane and degrade health on a transient blip.
Deno.test("regression: an incidental 401/403 in a serialised body does not stop the lane", () => {
  const overloadedWithRequestId = classifyFailure({
    status: 429,
    message: "overloaded_error",
    error: {
      type: "rate_limit_error",
      request_id: "req_014036_401_403",
      message: "Number of requests has exceeded your rate limit",
    },
  });
  assertEquals(overloadedWithRequestId.reason, "rate_limited");
  assertEquals(overloadedWithRequestId.failureClass, "retryable");
  assertEquals(overloadedWithRequestId.stopProviderLane, false);

  const fiveHundredWithDigits = classifyFailure({
    status: 503,
    message: "upstream unavailable",
    error: { trace: "shard-403 node-401" },
  });
  assertEquals(fiveHundredWithDigits.reason, "upstream_5xx");
  assertEquals(fiveHundredWithDigits.stopProviderLane, false);

  // The genuine text-only status wording still fails loud as a dead key.
  assert(isAuthFailure(new Error("Request failed with status 401")));
  assert(isAuthFailure(new Error("HTTP 403 returned by the gateway")));
});

// A gate-dropped item-local terminal never reaches a draft, so the durable exception is
// the ONLY record of it. It must carry the source evidence and the typed reason, and it is
// what licenses marking the source scanned — otherwise the item retries the provider
// every two minutes forever.
Deno.test("regression: a gate-dropped item-local terminal gets a durable evidence record", () => {
  const ev = itemLocalQuarantineEvent({
    graphMessageId: "graph-1",
    postId: "post-1",
    subject: "Make safe request",
    fromEmail: "builder@example.com",
    receivedAt: "2026-07-20T01:00:00Z",
    dropReason: "not_a_new_work_order",
    reason: "request_invalid",
    message: "invalid_request_error: body too large",
  });
  assertEquals(ev.entity_type, "makesafe_intake_source");
  assertEquals(ev.entity_id, "post-1");
  assertEquals(ev.payload.graph_message_id, "graph-1");
  assertEquals(ev.payload.subject, "Make safe request");
  assertEquals(ev.payload.from_email, "builder@example.com");
  assertEquals(ev.payload.drop_reason, "not_a_new_work_order");
  assertEquals(ev.payload.failure_reason, "request_invalid");
  assertEquals(ev.metadata.review_only, true);
  assertEquals(ev.metadata.recovery_action, "manual_requeue");
  assert(ev.body_preview.includes("request_invalid"));
});

Deno.test("regression: a gate-dropped item-local terminal is bounded only once its record is durable", () => {
  const base = {
    templateParsed: false,
    modelValidResult: false,
    authFailed: false,
    transientFailed: false,
    terminalQuarantined: true,
    keyDegradedOrAbsent: false,
  };
  // Durable write failed -> stays unscanned and retries.
  assertEquals(scanMarkEligible({ ...base, itemLocalTerminalRecorded: false }), false);
  // Durable write confirmed -> bounded.
  assertEquals(scanMarkEligible({ ...base, itemLocalTerminalRecorded: true }), true);
  // A provider outage is NOT bounded this way even if a record exists: it never got a
  // real attempt, so it must stay automatically retryable.
  assertEquals(
    scanMarkEligible({
      ...base,
      keyDegradedOrAbsent: true,
      itemLocalTerminalRecorded: true,
    }),
    false,
  );
  assertEquals(
    scanMarkEligible({ ...base, authFailed: true, itemLocalTerminalRecorded: true }),
    false,
  );
});
