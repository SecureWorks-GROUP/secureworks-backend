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

export type DispatchDerivation = {
  owner: "dispatch";
  event_id: string;
  plan_version: number;
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
  derivation: DispatchDerivation;
};

export type ProjectedDispatchFact = {
  id: string;
  job_id: string;
  kind: string;
  value: { text: string; command: unknown; plan_version: number };
  provenance: { derivation: DispatchDerivation; writer_role: "projection" };
  _context_store: "dispatch_projection";
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

export function derivationOf(event: DispatchContextEvent): DispatchDerivation | null {
  const raw = event.metadata?.derivation as Record<string, unknown> | undefined;
  const planVersion = typeof raw?.plan_version === "number" ? raw.plan_version : planVersionOf(event);
  const eventId = typeof raw?.event_id === "string" && UUID.test(raw.event_id)
    ? raw.event_id
    : (typeof event.correlation_id === "string" && UUID.test(event.correlation_id) ? event.correlation_id : null);
  if (!eventId || planVersion < 0) return null;
  if (raw && raw.owner !== undefined && raw.owner !== "dispatch") return null;
  return { owner: "dispatch", event_id: eventId, plan_version: planVersion };
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
    if (!derivationOf(event)) continue;
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
  const derivation = derivationOf(current);
  if (!derivation) return { present: false };
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
    derivation,
  };
}

/** Read-time fact projection. Does not persist. Lineage must survive for Dispatch source-hash exclusion. */
export function projectDispatchDerivedFacts(
  state: DispatchWorkingState | { present: false },
): ProjectedDispatchFact[] {
  if (!state.present) return [];
  return [{
    id: `dispatch-derived:${state.derivation.event_id}`,
    job_id: state.job_id,
    kind: "note",
    value: {
      text: "Dispatch working review state. Not a claim that an order was sent, purchased, delivered or paid.",
      command: state.command,
      plan_version: state.plan_version,
    },
    provenance: { derivation: { ...state.derivation }, writer_role: "projection" },
    _context_store: "dispatch_projection",
  }];
}

/** Mirrors Dispatch SQL: source hash excludes facts whose derivation.owner is dispatch. */
export function factsForDispatchSourceHash<T extends { provenance?: { derivation?: { owner?: string } } }>(facts: T[]): T[] {
  return facts.filter((fact) => fact.provenance?.derivation?.owner !== "dispatch");
}

export function dispatchSourceFingerprint(facts: Array<{ id: string; provenance?: { derivation?: { owner?: string } } }>): string {
  return JSON.stringify(factsForDispatchSourceHash(facts).map((fact) => fact.id).sort());
}

export type OrgRollupToJob = {
  facts: ProjectedDispatchFact[];
  needs_richer_lineage: boolean;
};

/** Org summaries that feed a job keep Dispatch lineage. Mixed own+independent inputs are not silently merged. */
export function projectOrgRollupOntoJob(
  orgFacts: Array<{ id: string; kind: string; value: unknown; provenance?: { derivation?: DispatchDerivation | { owner?: string } } }>,
  jobId: string,
): OrgRollupToJob {
  const dispatchOwned = orgFacts.filter((fact) => fact.provenance?.derivation?.owner === "dispatch");
  const independent = orgFacts.filter((fact) => fact.provenance?.derivation?.owner !== "dispatch");
  if (dispatchOwned.length > 0 && independent.length > 0) {
    return { facts: [], needs_richer_lineage: true };
  }
  return {
    needs_richer_lineage: false,
    facts: dispatchOwned.map((fact) => {
      const derivation = fact.provenance?.derivation as DispatchDerivation;
      return {
        id: `org-rollup:${fact.id}`,
        job_id: jobId,
        kind: "note",
        value: { text: "Organisation summary derived from Dispatch. Not a provider claim.", command: null, plan_version: derivation.plan_version },
        provenance: { derivation: { ...derivation }, writer_role: "projection" },
        _context_store: "dispatch_projection",
      };
    }),
  };
}
