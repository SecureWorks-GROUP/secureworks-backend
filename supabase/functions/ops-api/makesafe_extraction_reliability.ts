// deno-lint-ignore-file no-explicit-any

/** Typed extraction failure policy. Terminal failures are quarantined after one
 * attempt. Retryable failures remain eligible for a later scan. */
export type ExtractionFailureReason =
  | "usage_cap"
  | "key_unset"
  | "auth_failed"
  | "configuration_failed"
  | "request_invalid"
  | "rate_limited"
  | "upstream_5xx"
  | "network_error"
  | "response_parse_failed"
  | "unknown_transient";

export interface ExtractionFailureClassification {
  failureClass: "terminal" | "retryable";
  reason: ExtractionFailureReason;
  quarantine: boolean;
  stopProviderLane: boolean;
}

function errorHaystack(err: unknown): string {
  const e = err as any;
  const body = typeof e?.error === "object"
    ? JSON.stringify(e.error)
    : String(e?.error || "");
  return `${e?.name || ""} ${e?.type || ""} ${
    e?.message || String(err)
  } ${body}`.toLowerCase();
}

export function classifyExtractionFailure(
  err: unknown,
): ExtractionFailureClassification {
  const e = err as any;
  const status = Number(e?.status ?? e?.statusCode ?? e?.response?.status);
  const hay = errorHaystack(err);

  // The exact 2026-07-14 incident shape is HTTP 400 invalid_request_error, not 429.
  // Match the provider's usage-limit language rather than treating every 400 as a cap.
  if (
    /specified api usage limits|usage limit|monthly spend|spend cap|credit balance|billing limit/
      .test(hay)
  ) {
    return {
      failureClass: "terminal",
      reason: "usage_cap",
      quarantine: true,
      stopProviderLane: true,
    };
  }
  if (
    status === 401 || status === 403 ||
    /authentication|permission_error|invalid x-api-key|invalid api key|invalid_api_key|unauthorized/
      .test(hay)
  ) {
    return {
      failureClass: "terminal",
      reason: "auth_failed",
      quarantine: true,
      stopProviderLane: true,
    };
  }
  // Proven provider/model configuration failures cannot heal on a two-minute retry.
  if (
    status === 404 ||
    /model.{0,30}(not found|does not exist|invalid|unavailable)|unsupported model/
      .test(hay)
  ) {
    return {
      failureClass: "terminal",
      reason: "configuration_failed",
      quarantine: true,
      stopProviderLane: true,
    };
  }
  // A malformed item/request is terminal for that source item, but must not stop other
  // items. Do not infer this from status 400 alone: overload/rate-limit text stays retryable.
  if (
    (status === 400 || status === 422) &&
    /invalid_request_error|unprocessable|invalid request/.test(hay)
  ) {
    return {
      failureClass: "terminal",
      reason: "request_invalid",
      quarantine: true,
      stopProviderLane: false,
    };
  }
  if (status === 429 || /rate.?limit|too many requests|overloaded/.test(hay)) {
    return {
      failureClass: "retryable",
      reason: "rate_limited",
      quarantine: false,
      stopProviderLane: false,
    };
  }
  if (status >= 500 && status <= 599) {
    return {
      failureClass: "retryable",
      reason: "upstream_5xx",
      quarantine: false,
      stopProviderLane: false,
    };
  }
  if (/json parse|unexpected token|invalid json|response parse/.test(hay)) {
    return {
      failureClass: "retryable",
      reason: "response_parse_failed",
      quarantine: false,
      stopProviderLane: false,
    };
  }
  if (
    /network|connection reset|econnreset|fetch failed|socket|timeout|timed out|dns/
      .test(hay)
  ) {
    return {
      failureClass: "retryable",
      reason: "network_error",
      quarantine: false,
      stopProviderLane: false,
    };
  }
  return {
    failureClass: "retryable",
    reason: "unknown_transient",
    quarantine: false,
    stopProviderLane: false,
  };
}

export interface ExtractionCycleOutcome {
  attempts: number;
  successes: number;
  terminalFailures: number;
  retryableFailures: number;
  reasons: ExtractionFailureReason[];
  providerLaneTerminalReason?: ExtractionFailureReason | null;
}

/** Health is degraded for a terminal provider-lane failure, or when every actual
 * extraction attempt in the cycle failed. A partial success remains healthy. */
export function extractionCycleHealth(outcome: ExtractionCycleOutcome): {
  status: "ok" | "degraded";
  reason: string | null;
} {
  if (outcome.providerLaneTerminalReason) {
    return { status: "degraded", reason: outcome.providerLaneTerminalReason };
  }
  if (
    outcome.attempts > 0 && outcome.successes === 0 &&
    outcome.terminalFailures + outcome.retryableFailures >= outcome.attempts
  ) {
    const unique = [...new Set(outcome.reasons)];
    return {
      status: "degraded",
      reason: unique.length === 1
        ? `wholesale_${unique[0]}`
        : "wholesale_extraction_failure",
    };
  }
  return { status: "ok", reason: null };
}

export function extractionFailureState(
  classification: ExtractionFailureClassification,
  message: string,
) {
  return {
    class: classification.failureClass,
    reason: classification.reason,
    retry_state: classification.quarantine ? "quarantined" : "retryable",
    automatic_attempts: 1,
    recoverable: true,
    recovery_action: classification.quarantine
      ? "reextract_intake_draft"
      : "automatic_rescan",
    message: message.slice(0, 200),
  };
}
