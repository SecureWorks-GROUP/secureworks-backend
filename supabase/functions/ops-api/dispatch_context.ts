// Interpret Dispatch working-state events already on business_events.
// Do not ingest Dispatch, mint facts, or claim provider actions.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const DISPATCH_PLAN_CHANGED = "dispatch.plan.changed";

export type DispatchContextEvent = {
  id: string;
  event_type: string;
  correlation_id?: string | null;
  job_id?: string | null;
  payload?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
};

export type DispatchWorkingState = {
  present: true;
  not_provider_fact: true;
  evidence_role: "human_working_state";
  provider_action: false;
  job_id: string;
  plan_version: number;
  source_version: unknown;
  command: unknown;
  contract_version: unknown;
  source_ref: unknown;
  snapshot: unknown;
  event_id: string;
  correlation_id: string | null;
};

export function isDispatchWorkingStateEvent(event: DispatchContextEvent): boolean {
  if (event.event_type !== DISPATCH_PLAN_CHANGED) return false;
  const meta = event.metadata ?? {};
  return meta.evidence_role === "human_working_state" && meta.provider_action === false;
}

export function isProviderExtractableEvent(event: DispatchContextEvent): boolean {
  if (event.event_type === DISPATCH_PLAN_CHANGED) return false;
  const meta = event.metadata ?? {};
  if (meta.provider_action === false) return false;
  if (meta.evidence_role === "human_working_state") return false;
  return true;
}

function jobIdOf(event: DispatchContextEvent): string | null {
  const raw = event.job_id ?? event.payload?.job_id;
  if (typeof raw !== "string" || !UUID.test(raw)) return null;
  return raw;
}

function planVersionOf(event: DispatchContextEvent): number {
  const v = event.payload?.plan_version;
  return typeof v === "number" && Number.isFinite(v) ? v : -1;
}

/** Latest human Dispatch review state for a job. Never a provider fact. */
export function currentDispatchWorkingState(
  events: DispatchContextEvent[],
): DispatchWorkingState | { present: false } {
  const seen = new Set<string>();
  const eligible: DispatchContextEvent[] = [];
  for (const event of events) {
    if (!isDispatchWorkingStateEvent(event)) continue;
    if (!jobIdOf(event)) continue;
    const key = event.correlation_id || event.id;
    if (seen.has(key)) continue;
    seen.add(key);
    eligible.push(event);
  }
  if (eligible.length === 0) return { present: false };
  let current = eligible[0];
  for (const event of eligible.slice(1)) {
    const cv = planVersionOf(current);
    const ev = planVersionOf(event);
    if (ev > cv) current = event;
  }
  const jobId = jobIdOf(current)!;
  return {
    present: true,
    not_provider_fact: true,
    evidence_role: "human_working_state",
    provider_action: false,
    job_id: jobId,
    plan_version: planVersionOf(current),
    source_version: current.payload?.source_version ?? null,
    command: current.payload?.command ?? null,
    contract_version: current.payload?.contract_version ?? null,
    source_ref: current.metadata?.source_ref ?? null,
    snapshot: current.payload?.state ?? null,
    event_id: current.id,
    correlation_id: current.correlation_id ?? null,
  };
}
