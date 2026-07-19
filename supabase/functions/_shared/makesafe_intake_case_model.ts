// Isolated deterministic make-safe intake case contract.
//
// This module is intentionally not imported by any current runtime path. It is
// the typed seam for later adapters, job creation and read-model units after the
// structural migration is separately approved and applied.

export const MAKESAFE_CASE_STATES = [
  "confirmed_live_job",
  "blocked_live_job",
  "exception",
  "accounted_non_wo",
] as const;

export type MakesafeCaseState = typeof MAKESAFE_CASE_STATES[number];

export const MAKESAFE_EXCEPTION_REASONS = [
  "cancellation",
  "duplicate",
  "revision",
  "unknown_builder",
  "non_makesafe",
  "ambiguous_scope",
  "below_identity_floor",
  "adapter_parse_failure",
  "conflicting_fields",
] as const;

export type MakesafeExceptionReason = typeof MAKESAFE_EXCEPTION_REASONS[number];

export const MAKESAFE_LINEAGE_RELATIONS = [
  "revision_of",
  "duplicate_of",
  "cancellation_of",
  "sibling_of",
  "reopen_of",
] as const;

export type MakesafeLineageRelation = typeof MAKESAFE_LINEAGE_RELATIONS[number];
export type MakesafeDecisionProvenance = "deterministic" | "ai" | "human";

export interface MakesafeCaseStateShape {
  currentState: MakesafeCaseState;
  resultJobId: string | null;
  relatedJobId: string | null;
  blockingReasons: readonly string[];
  exceptionReasonCode: MakesafeExceptionReason | null;
  accountedNonWoReason: string | null;
}

const TRANSITIONS: Readonly<
  Record<MakesafeCaseState, readonly MakesafeCaseState[]>
> = {
  confirmed_live_job: ["blocked_live_job"],
  blocked_live_job: ["confirmed_live_job", "exception"],
  exception: [
    "confirmed_live_job",
    "blocked_live_job",
    "accounted_non_wo",
  ],
  accounted_non_wo: ["exception"],
};

export function isMakesafeCaseTransitionAllowed(
  from: MakesafeCaseState,
  to: MakesafeCaseState,
): boolean {
  return TRANSITIONS[from].includes(to);
}

export function validateMakesafeCaseState(
  value: MakesafeCaseStateShape,
): readonly string[] {
  const errors: string[] = [];
  const hasResultJob = value.resultJobId !== null;
  const hasBlockingReasons = value.blockingReasons.length > 0;
  const hasExceptionReason = value.exceptionReasonCode !== null;
  const hasNonWoReason = (value.accountedNonWoReason ?? "").trim().length > 0;

  switch (value.currentState) {
    case "confirmed_live_job":
      if (!hasResultJob) errors.push("confirmed_live_job requires resultJobId");
      if (hasBlockingReasons) {
        errors.push("confirmed_live_job cannot have blockingReasons");
      }
      if (hasExceptionReason || hasNonWoReason) {
        errors.push("confirmed_live_job cannot carry exception/non-WO reasons");
      }
      break;
    case "blocked_live_job":
      if (!hasResultJob) errors.push("blocked_live_job requires resultJobId");
      if (!hasBlockingReasons) {
        errors.push("blocked_live_job requires named blockingReasons");
      }
      if (hasExceptionReason || hasNonWoReason) {
        errors.push("blocked_live_job cannot carry exception/non-WO reasons");
      }
      break;
    case "exception":
      if (hasResultJob) errors.push("exception cannot own a resultJobId");
      if (hasBlockingReasons) {
        errors.push("exception cannot have blockingReasons");
      }
      if (!hasExceptionReason) errors.push("exception requires a reason code");
      if (hasNonWoReason) errors.push("exception cannot carry a non-WO reason");
      break;
    case "accounted_non_wo":
      if (hasResultJob || value.relatedJobId !== null) {
        errors.push("accounted_non_wo cannot reference a job");
      }
      if (hasBlockingReasons || hasExceptionReason) {
        errors.push("accounted_non_wo cannot carry block/exception reasons");
      }
      if (!hasNonWoReason) {
        errors.push("accounted_non_wo requires an accounting reason");
      }
      break;
  }

  return errors;
}

export interface SourceInstructionIdentity {
  sourceMessageId: string;
  deliverableDiscriminator?: string;
}

function requiredOpaquePart(label: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} must not be empty`);
  return encodeURIComponent(trimmed);
}

export function buildSourceInstructionKey(
  identity: SourceInstructionIdentity,
): string {
  const message = requiredOpaquePart(
    "sourceMessageId",
    identity.sourceMessageId,
  );
  const deliverable = requiredOpaquePart(
    "deliverableDiscriminator",
    identity.deliverableDiscriminator ?? "instruction:0",
  );
  return `message:${message}/deliverable:${deliverable}`;
}

export function buildReplayKey(input: {
  orgId: string;
  sourceSystem: string;
  sourceMailbox: string;
  sourceInstructionKey: string;
}): string {
  return [
    requiredOpaquePart("orgId", input.orgId),
    requiredOpaquePart("sourceSystem", input.sourceSystem),
    requiredOpaquePart("sourceMailbox", input.sourceMailbox),
    requiredOpaquePart("sourceInstructionKey", input.sourceInstructionKey),
  ].join("|");
}

export interface MakesafeIdentityFieldProvenance {
  method: MakesafeDecisionProvenance;
  sourceMessageId?: string;
  rule?: string;
  observedAt?: string;
}

export interface MakesafeIdentity {
  readonly rawBuilderName: string | null;
  readonly rawExternalRef: string | null;
  readonly rawPoNumber: string | null;
  readonly rawDeliverableRef: string | null;
  canonicalBuilderSlug: string | null;
  canonicalExternalRef: string | null;
  canonicalPoNumber: string | null;
  canonicalDeliverableRef: string | null;
  identityProvenance: Readonly<
    Record<string, MakesafeIdentityFieldProvenance>
  >;
}

export type CanonicalIdentityUpdate = Partial<
  Pick<
    MakesafeIdentity,
    | "canonicalBuilderSlug"
    | "canonicalExternalRef"
    | "canonicalPoNumber"
    | "canonicalDeliverableRef"
  >
>;

export function applyCanonicalIdentityUpdate(
  existing: MakesafeIdentity,
  update: CanonicalIdentityUpdate,
  provenanceAdditions: Readonly<
    Record<string, MakesafeIdentityFieldProvenance>
  >,
): MakesafeIdentity {
  if (
    Object.keys(update).length > 0 &&
    Object.keys(provenanceAdditions).length === 0
  ) {
    throw new Error("canonical identity changes require field provenance");
  }
  for (const [key, value] of Object.entries(provenanceAdditions)) {
    const prior = existing.identityProvenance[key];
    if (
      prior !== undefined && JSON.stringify(prior) !== JSON.stringify(value)
    ) {
      throw new Error("identity provenance is append-only");
    }
  }
  return {
    ...existing,
    ...update,
    identityProvenance: {
      ...existing.identityProvenance,
      ...provenanceAdditions,
    },
    rawBuilderName: existing.rawBuilderName,
    rawExternalRef: existing.rawExternalRef,
    rawPoNumber: existing.rawPoNumber,
    rawDeliverableRef: existing.rawDeliverableRef,
  };
}

export function assertSameOrg(
  expectedOrgId: string,
  ...relatedOrgIds: readonly string[]
): void {
  if (relatedOrgIds.some((orgId) => orgId !== expectedOrgId)) {
    throw new Error("make-safe case relationship crosses org boundary");
  }
}

export interface MakesafeLineageEdge {
  orgId: string;
  fromCaseId: string;
  relationType: MakesafeLineageRelation;
  toCaseId: string;
}

export function canonicalSiblingEdge(
  orgId: string,
  firstCaseId: string,
  secondCaseId: string,
): MakesafeLineageEdge {
  if (firstCaseId === secondCaseId) {
    throw new Error("lineage cannot link a case to itself");
  }
  const [fromCaseId, toCaseId] = [firstCaseId, secondCaseId].sort();
  return { orgId, fromCaseId, relationType: "sibling_of", toCaseId };
}

export function validateLineageEdge(
  existingEdges: readonly MakesafeLineageEdge[],
  candidate: MakesafeLineageEdge,
): readonly string[] {
  const errors: string[] = [];
  if (candidate.fromCaseId === candidate.toCaseId) {
    errors.push("lineage cannot link a case to itself");
  }
  if (
    candidate.relationType === "sibling_of" &&
    candidate.fromCaseId >= candidate.toCaseId
  ) {
    errors.push("sibling edge must be stored once in canonical order");
  }
  if (
    candidate.relationType === "duplicate_of" &&
    existingEdges.some((edge) =>
      edge.orgId === candidate.orgId &&
      edge.fromCaseId === candidate.fromCaseId &&
      edge.relationType === "duplicate_of"
    )
  ) {
    errors.push("duplicate case already has a canonical parent");
  }
  if (
    existingEdges.some((edge) =>
      edge.orgId === candidate.orgId &&
      edge.fromCaseId === candidate.fromCaseId &&
      edge.toCaseId === candidate.toCaseId &&
      edge.relationType === candidate.relationType
    )
  ) {
    errors.push("lineage edge already exists");
  }

  if (candidate.relationType !== "sibling_of") {
    const adjacency = new Map<string, string[]>();
    for (const edge of existingEdges) {
      if (
        edge.orgId !== candidate.orgId || edge.relationType === "sibling_of"
      ) {
        continue;
      }
      adjacency.set(edge.fromCaseId, [
        ...(adjacency.get(edge.fromCaseId) ?? []),
        edge.toCaseId,
      ]);
    }
    const pending = [candidate.toCaseId];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (current === candidate.fromCaseId) {
        errors.push("lineage edge would create a cycle");
        break;
      }
      if (visited.has(current)) continue;
      visited.add(current);
      pending.push(...(adjacency.get(current) ?? []));
    }
  }

  return errors;
}
