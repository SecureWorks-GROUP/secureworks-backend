// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { XeroCooldownError } from "../_shared/xero_cooldown.ts";
import {
  xeroQuoteFailureWarning,
  XeroQuoteWriteError,
} from "./xero_quote_outcome.ts";

Deno.test("quote warnings distinguish a refused call from an ambiguous transport result and retain retry metadata", () => {
  for (
    const [status, made, expected] of [
      [503, false, "failed"],
      [429, true, "failed"],
      [408, true, "unknown"],
      [503, true, "unknown"],
    ] as const
  ) {
    const warning = xeroQuoteFailureWarning(
      new XeroCooldownError("Safe fixture message", status, "FIXTURE_CODE", {
        provider_call_made: made,
        retry_after_seconds: 19079,
        retry_at: "2026-09-09T09:46:00Z",
        request_id: "fixture-request",
      }),
    );
    assertEquals(warning.status, expected);
    assertEquals(warning.provider_call_made, made);
    assertEquals(warning.retry_after_seconds, 19079);
    assertEquals(warning.request_id, "fixture-request");
    assertEquals(warning.provider_operation, "create_xero_quote");
  }
});

Deno.test("quote warnings retain explicit outcomes and do not expose unexpected raw errors", () => {
  for (const outcome of ["failed", "unknown"] as const) {
    const warning = xeroQuoteFailureWarning(
      new XeroQuoteWriteError(outcome, {
        provider_call_made: true,
        provider_status: 400,
      }),
    );
    assertEquals(warning.status, outcome);
    assertEquals(
      warning.code,
      outcome === "failed"
        ? "XERO_QUOTE_REJECTED"
        : "XERO_QUOTE_OUTCOME_UNKNOWN",
    );
    assertEquals(warning.provider_status, 400);
  }
  const warning = xeroQuoteFailureWarning(
    new Error("fixture raw credential material"),
  );
  assertEquals(warning.status, "unknown");
  assertEquals(warning.provider_call_made, null);
  assertEquals(JSON.stringify(warning).includes("credential"), false);
});
