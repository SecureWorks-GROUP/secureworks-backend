import { XeroCooldownError } from "../_shared/xero_cooldown.ts";

export type XeroQuoteWarning = Record<string, unknown> & {
  status: "failed" | "unknown";
  code: string;
  error: string;
  provider_operation: "create_xero_quote";
};

export class XeroQuoteWriteError extends Error {
  constructor(
    readonly outcome: "failed" | "unknown",
    readonly details: Record<string, unknown>,
  ) {
    super(
      outcome === "failed"
        ? "Xero rejected quote creation"
        : "Xero quote creation outcome is unknown; reconcile before another write",
    );
    this.name = "XeroQuoteWriteError";
  }
}

// This warning belongs to the Xero step AFTER email publication. It must not
// turn an accepted email into a retryable send failure or expose raw errors.
export function xeroQuoteFailureWarning(error: unknown): XeroQuoteWarning {
  if (error instanceof XeroCooldownError) {
    const rejected = error.details.provider_call_made === false ||
      (error.status >= 400 && error.status < 500 && error.status !== 408);
    return {
      ...error.details,
      status: rejected ? "failed" : "unknown",
      code: error.code,
      error: error.message,
      provider_operation: "create_xero_quote",
    };
  }
  const known = error instanceof XeroQuoteWriteError;
  const status = known ? error.outcome : "unknown";
  return {
    ...(known ? error.details : { provider_call_made: null }),
    status,
    code: status === "failed"
      ? "XERO_QUOTE_REJECTED"
      : "XERO_QUOTE_OUTCOME_UNKNOWN",
    error: known ? error.message : "The Xero quote step could not be confirmed",
    provider_operation: "create_xero_quote",
  };
}
