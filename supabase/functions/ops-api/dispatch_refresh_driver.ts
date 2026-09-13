// Dispatch business driver for the shared Refresh contract.
// CIO owns start/claim/finish/readback security. Operations owns this work.
// A source-hash reread is not completed Refresh.
export const DISPATCH_REFRESH_OUTPUT = "dispatch_refresh/v1";

export type DispatchRefreshScope = {
  job_id?: string;
  org_id?: string;
};

export class DispatchRefreshOutputError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export function assertDispatchRefreshOutput(result: Record<string, unknown>) {
  if (result.declared_output !== DISPATCH_REFRESH_OUTPUT) {
    throw new DispatchRefreshOutputError("Dispatch Refresh output is missing");
  }
  if (result.ok !== "true") {
    throw new DispatchRefreshOutputError(
      "Dispatch Refresh did not produce successful work",
    );
  }
  const work = result.work && typeof result.work === "object"
    ? result.work as Record<string, unknown>
    : null;
  if (!work || typeof work.jobs_read !== "number" || work.jobs_read < 1) {
    throw new DispatchRefreshOutputError(
      "Dispatch Refresh did not read accepted work",
    );
  }
  if (work.hash_only === true || work.source_read_only === true) {
    throw new DispatchRefreshOutputError(
      "A source-hash reread is not completed Refresh",
    );
  }
  if (typeof work.source_cutoff !== "string" || !work.source_cutoff) {
    throw new DispatchRefreshOutputError(
      "Dispatch Refresh source cutoff is missing",
    );
  }
}

export function dispatchRefreshResult(
  jobsRead: number,
  sourceCutoff: string,
  extras: { calendar_read?: boolean; observed_source_revision?: string | null } =
    {},
) {
  const result = {
    ok: "true" as const,
    declared_output: DISPATCH_REFRESH_OUTPUT,
    work: {
      jobs_read: jobsRead,
      calendar_read: extras.calendar_read === true,
      source_cutoff: sourceCutoff,
    },
    observed_source_revision: extras.observed_source_revision ?? null,
  };
  assertDispatchRefreshOutput(result);
  return result;
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

export function stripLeaseToken<T extends Record<string, unknown> | null>(
  data: T,
) {
  if (data && typeof data === "object" && "lease_token" in data) {
    throw new DispatchRefreshOutputError(
      "Refresh readback exposed a lease token",
      500,
    );
  }
  return data;
}
