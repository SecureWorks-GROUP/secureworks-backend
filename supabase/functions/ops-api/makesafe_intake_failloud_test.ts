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
} from "./index.ts";

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
