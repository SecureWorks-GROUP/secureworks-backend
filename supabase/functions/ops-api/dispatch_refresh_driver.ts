// Shared Refresh response contract; claimed work lives in dispatch_refresh_worker.ts.
// CIO owns start/claim/finish/readback security. Operations owns this work.
// A source-hash reread is not completed Refresh.
export const DISPATCH_REFRESH_OUTPUT = "dispatch_refresh/v1";

export class DispatchRefreshOutputError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export function salesPerformanceUnpublished(now = new Date().toISOString()) {
  return {
    ok: true,
    unpublished: true,
    storage_provenance: null,
    rows: [],
    week_starts: [],
    available_weeks: [],
    week_start: null,
    latest_closed_week: null,
    missing_latest_closed_week: true,
    fetched_at: now,
    coverage: {
      complete: false,
      reason: "public.sales_performance_weeks is not deployed",
    },
  };
}

export function pendingRefreshDoor(reason = "shared_refresh_rpc_missing") {
  return {
    outcome: "unavailable",
    capability: "pending",
    workflow: "dispatch",
    reason,
    declared_output: DISPATCH_REFRESH_OUTPUT,
  };
}

export function operatorRefreshResult(data: Record<string, unknown> | null) {
  if (data && typeof data === "object" && "lease_token" in data) {
    throw new DispatchRefreshOutputError(
      "Refresh readback exposed a lease token",
      500,
    );
  }
  if (data?.outcome === "completed" || data?.status === "completed") {
    return pendingRefreshDoor("dispatch_verified_output_unavailable");
  }
  return data;
}
