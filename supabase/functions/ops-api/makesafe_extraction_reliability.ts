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

/** Name/type/message only — deliberately EXCLUDES the serialised error body, whose
 * request ids and nested fields would otherwise let an incidental "401"/"403" promote a
 * transient failure into a lane-stopping auth terminal. */
function errorMessageText(err: unknown): string {
  const e = err as any;
  return `${e?.name || ""} ${e?.type || ""} ${e?.message || String(err)}`
    .toLowerCase();
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
  // A fetch-layer wrapper may surface the status only as text ("Request failed with
  // status 401") with no status property, and that must still fail loud as a dead key.
  // The bare-status match is anchored to actual status wording in the message text so an
  // incidental 401/403 inside a serialised body or request id cannot stop the lane.
  const textOnlyAuthStatus =
    /\b(?:status|statuscode|status code|code|http|failed with)\W{0,12}\b40[13]\b/
      .test(errorMessageText(err));
  if (
    status === 401 || status === 403 || textOnlyAuthStatus ||
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
  // A BARE 404 is not proof: an intervening proxy/gateway or a routing blip returns 404
  // too. Require corroborating model/configuration evidence before stopping the lane.
  const modelConfigEvidence =
    /model.{0,30}(not found|does not exist|invalid|unavailable)|unsupported model|not_found_error/
      .test(hay);
  if (modelConfigEvidence) {
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

/** A single isolated retryable failure is RETRYING, not systemic degradation: it stays
 * unscanned, cannot auto-file, and the next scan retries it. Wholesale degradation needs
 * corroborating evidence — at least this many failed attempts with zero successes. */
export const WHOLESALE_FAILURE_MIN_ATTEMPTS = 2;

/** Health is degraded immediately for a terminal provider-lane failure, or when a
 * wholesale run of attempts all failed. A partial success remains healthy. */
export function extractionCycleHealth(outcome: ExtractionCycleOutcome): {
  status: "ok" | "degraded";
  reason: string | null;
} {
  if (outcome.providerLaneTerminalReason) {
    return { status: "degraded", reason: outcome.providerLaneTerminalReason };
  }
  if (
    outcome.attempts >= WHOLESALE_FAILURE_MIN_ATTEMPTS && outcome.successes === 0 &&
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

/** The durable visible record for an ITEM-LOCAL permanent failure whose email is then
 * dropped by an intake gate, so no draft carries its evidence. It preserves the source
 * identity, the typed failure reason and the gate that dropped it, and is what licenses
 * marking the source scanned — without it the item stays unscanned and keeps retrying. */
export function itemLocalQuarantineEvent(s: {
  graphMessageId: string;
  postId: string | null;
  subject: string | null;
  fromEmail: string | null;
  receivedAt: string | null;
  dropReason: string;
  reason: ExtractionFailureReason;
  message: string;
}) {
  return {
    event_type: "makesafe.intake_item_quarantined",
    source: "app/makesafe-intake",
    entity_type: "makesafe_intake_source",
    entity_id: s.postId || s.graphMessageId,
    body_preview:
      `Intake extraction permanently failed (${s.reason}) and the email was dropped at the ${s.dropReason} gate; source captured for review, no draft minted: ${
        s.subject || s.graphMessageId
      }`.slice(0, 500),
    payload: {
      graph_message_id: s.graphMessageId,
      post_id: s.postId,
      subject: s.subject,
      from_email: s.fromEmail,
      received_at: s.receivedAt,
      drop_reason: s.dropReason,
      failure_reason: s.reason,
      failure_message: String(s.message || "").slice(0, 200),
    },
    metadata: {
      mission: "makesafe/intake-extraction-reliability",
      review_only: true,
      recovery_action: "manual_requeue",
    },
  };
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
    // Provider-lane quarantine is visible, not consumed: the source item's scan marker
    // stays unset, so recovery is automatic once provider health returns. An ITEM-LOCAL
    // permanent failure cannot heal on a rescan, so it is bounded after one attempt and
    // recovers through an explicit requeue instead of hitting the provider forever.
    recovery_action: !classification.quarantine || classification.stopProviderLane
      ? "automatic_rescan"
      : "manual_requeue",
    manual_recovery_action: classification.quarantine
      ? "reextract_intake_draft"
      : null,
    message: message.slice(0, 200),
  };
}
