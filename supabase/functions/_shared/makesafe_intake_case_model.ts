// Isolated deterministic make-safe intake case contract.
//
// This module is intentionally not imported by any runtime path. It mirrors the
// inert U1 schema for later deterministic adapters, lineage commands, job
// creation and read models after separately gated migration/cutover work.

import { normaliseRef, REF_PREFIX_FLOOR } from "./makesafe_refs.ts";

export const MAKESAFE_CASE_STATES = [
  "confirmed_live_job",
  "blocked_live_job",
  "exception",
  "accounted_non_wo",
] as const;
export type MakesafeCaseState = typeof MAKESAFE_CASE_STATES[number];

export const MAKESAFE_REASON_CODES = [
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
export type MakesafeReasonCode = typeof MAKESAFE_REASON_CODES[number];

export const MAKESAFE_PARENT_RELATIONS = [
  "revision_of",
  "duplicate_of",
  "cancellation_of",
  "sibling_of",
  "reopen_of",
] as const;
export type MakesafeParentRelation = typeof MAKESAFE_PARENT_RELATIONS[number];

export const MAKESAFE_SOURCE_ROLES = [
  "original",
  "twin",
  "resend",
  "revision_notice",
  "cancellation_notice",
  "late_pdf",
] as const;
export type MakesafeSourceRole = typeof MAKESAFE_SOURCE_ROLES[number];

export type MakesafeDecisionProvenance =
  | "deterministic"
  | "ai"
  | "human"
  | "maverick"
  | "backfill";

export const MAKESAFE_NORMALISER_VERSION =
  "makesafe_refs.normaliseRef+wo_po_precedence@v1";

export interface MakesafeIdentityNormaliserInput {
  externalRefRaw: string | null;
  builderWoRaw: string | null;
  builderPoRaw: string | null;
  deliverableRefRaw: string | null;
  prefixes?: readonly string[];
}

export interface MakesafeCanonicalIdentity {
  externalRefCanonical: string | null;
  builderWoCanonical: string | null;
  builderPoCanonical: string | null;
  deliverableRefCanonical: string | null;
  woPoIdentityKey: string | null;
  normaliserVersion: string;
}

// Canonical precedence is explicit: builder WO + PO, then PO, then WO.
// Claim/external ref is display/matching context and never a live identity key.
export function normaliseMakesafeIdentity(
  input: MakesafeIdentityNormaliserInput,
): MakesafeCanonicalIdentity {
  const prefixes = input.prefixes ?? REF_PREFIX_FLOOR;
  const externalRefCanonical = normaliseRef(input.externalRefRaw, prefixes);
  const builderWoCanonical = normaliseRef(input.builderWoRaw, prefixes);
  const builderPoCanonical = normaliseOpaqueIdentity(input.builderPoRaw);
  const deliverableRefCanonical = normaliseOpaqueIdentity(
    input.deliverableRefRaw,
  );
  const woPoIdentityKey = builderWoCanonical && builderPoCanonical
    ? `wo:${builderWoCanonical}/po:${builderPoCanonical}`
    : builderPoCanonical
    ? `po:${builderPoCanonical}`
    : builderWoCanonical
    ? `wo:${builderWoCanonical}`
    : null;
  return {
    externalRefCanonical,
    builderWoCanonical,
    builderPoCanonical,
    deliverableRefCanonical,
    woPoIdentityKey,
    normaliserVersion: MAKESAFE_NORMALISER_VERSION,
  };
}

function normaliseOpaqueIdentity(raw: string | null): string | null {
  if (raw === null) return null;
  const canonical = raw.trim().toUpperCase().replace(/\s+/g, "-")
    .replace(/-+/g, "-");
  return canonical || null;
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

export interface MakesafeCaseStateShape {
  state: MakesafeCaseState;
  reasonCode: MakesafeReasonCode | null;
  blockedReasons: readonly string[];
  jobId: string | null;
  companyId: string | null;
  canonicalIdentity: string | null;
  clientName: string | null;
  siteAddress: string | null;
}

export function validateMakesafeCaseState(
  value: MakesafeCaseStateShape,
): readonly string[] {
  const errors: string[] = [];
  const live = value.state === "confirmed_live_job" ||
    value.state === "blocked_live_job";

  if (live) {
    if (value.jobId === null) errors.push(`${value.state} requires jobId`);
    if (value.reasonCode !== null) {
      errors.push(`${value.state} cannot carry reasonCode`);
    }
    if (value.companyId === null) {
      errors.push(`${value.state} requires companyId`);
    }
    if (value.canonicalIdentity === null) {
      errors.push(
        `${value.state} requires canonical builder WO/PO/ref identity`,
      );
    }
    if (value.clientName === null) {
      errors.push(`${value.state} requires clientName`);
    }
    if (value.siteAddress === null) {
      errors.push(`${value.state} requires siteAddress`);
    }
  }

  switch (value.state) {
    case "confirmed_live_job":
      if (value.blockedReasons.length > 0) {
        errors.push("confirmed_live_job cannot have blockedReasons");
      }
      break;
    case "blocked_live_job":
      if (value.blockedReasons.length === 0) {
        errors.push("blocked_live_job requires named blockedReasons");
      }
      break;
    case "exception":
      if (value.jobId !== null) errors.push("exception cannot own a jobId");
      if (value.reasonCode === null) {
        errors.push("exception requires reasonCode");
      }
      if (value.blockedReasons.length > 0) {
        errors.push("exception cannot have blockedReasons");
      }
      break;
    case "accounted_non_wo":
      if (value.jobId !== null) {
        errors.push("accounted_non_wo cannot own a jobId");
      }
      if (value.reasonCode === null) {
        errors.push("accounted_non_wo requires reasonCode");
      }
      if (value.blockedReasons.length > 0) {
        errors.push("accounted_non_wo cannot have blockedReasons");
      }
      break;
  }

  if (value.reasonCode === "cancellation" && value.jobId !== null) {
    errors.push("cancellation cannot own a jobId");
  }
  return errors;
}

function requiredOpaquePart(label: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} must not be empty`);
  return encodeURIComponent(trimmed);
}

export function buildInstructionKey(input: {
  instructionFingerprint: string;
  deliverableDiscriminator: string;
}): string {
  return `fingerprint:${
    requiredOpaquePart("instructionFingerprint", input.instructionFingerprint)
  }` +
    `/deliverable:${
      requiredOpaquePart(
        "deliverableDiscriminator",
        input.deliverableDiscriminator,
      )
    }`;
}

export function buildReplayKey(input: {
  orgId: string;
  instructionKey: string;
}): string {
  return `${requiredOpaquePart("orgId", input.orgId)}|${
    requiredOpaquePart("instructionKey", input.instructionKey)
  }`;
}

export function companyKeyFromId(companyId: string): string {
  return `company:${requiredOpaquePart("companyId", companyId)}`;
}

export function buildLiveIdentityKey(input: {
  orgId: string;
  companyKey: string | null;
  woPoIdentityKey: string | null;
  cycle: number;
}): string | null {
  if (input.companyKey === null || input.woPoIdentityKey === null) return null;
  if (!Number.isInteger(input.cycle) || input.cycle < 1) {
    throw new Error("cycle must be a positive integer");
  }
  return [
    requiredOpaquePart("orgId", input.orgId),
    requiredOpaquePart("companyKey", input.companyKey),
    requiredOpaquePart("woPoIdentityKey", input.woPoIdentityKey),
    String(input.cycle),
  ].join("|");
}

export interface MakesafeLineageSnapshot {
  id: string;
  orgId: string;
  lineageId: string;
  parentCaseId: string | null;
  parentRelation: MakesafeParentRelation | null;
  cycle: number;
  reasonCode: MakesafeReasonCode | null;
}

export function placeCaseInLineage(input: {
  newCaseId: string;
  orgId: string;
  parent: MakesafeLineageSnapshot | null;
  relation: MakesafeParentRelation | null;
}): MakesafeLineageSnapshot {
  if ((input.parent === null) !== (input.relation === null)) {
    throw new Error("parent and relation must be set together");
  }
  if (input.parent === null) {
    return {
      id: input.newCaseId,
      orgId: input.orgId,
      lineageId: input.newCaseId,
      parentCaseId: null,
      parentRelation: null,
      cycle: 1,
      reasonCode: null,
    };
  }
  if (input.parent.id === input.newCaseId) {
    throw new Error("lineage cannot link a case to itself");
  }
  assertSameOrg(input.orgId, input.parent.orgId);
  if (
    input.relation === "duplicate_of" &&
    (input.parent.id !== input.parent.lineageId ||
      input.parent.reasonCode === "duplicate")
  ) {
    throw new Error(
      "duplicate_of must point directly to a non-duplicate lineage root",
    );
  }
  return {
    id: input.newCaseId,
    orgId: input.orgId,
    lineageId: input.parent.lineageId,
    parentCaseId: input.parent.id,
    parentRelation: input.relation,
    cycle: input.relation === "reopen_of"
      ? input.parent.cycle + 1
      : input.parent.cycle,
    reasonCode: null,
  };
}

export function assertLineageImmutable(
  before: MakesafeLineageSnapshot,
  after: MakesafeLineageSnapshot,
): void {
  if (
    before.orgId !== after.orgId || before.lineageId !== after.lineageId ||
    before.parentCaseId !== after.parentCaseId ||
    before.parentRelation !== after.parentRelation ||
    before.cycle !== after.cycle
  ) {
    throw new Error("case lineage identity is immutable");
  }
}

export interface MakesafeIdentityFieldProvenance {
  method: MakesafeDecisionProvenance;
  sourcePostId?: string;
  rule?: string;
  observedAt?: string;
}

export interface MakesafeIdentity {
  readonly companySlugRaw: string | null;
  readonly externalRefRaw: string | null;
  readonly builderWoRaw: string | null;
  readonly builderPoRaw: string | null;
  readonly deliverableRefRaw: string | null;
  companyKey: string | null;
  externalRefCanonical: string | null;
  builderWoCanonical: string | null;
  builderPoCanonical: string | null;
  deliverableRefCanonical: string | null;
  woPoIdentityKey: string | null;
  normaliserVersion: string;
  fieldProvenance: Readonly<Record<string, MakesafeIdentityFieldProvenance>>;
}

export type CanonicalIdentityUpdate = Partial<
  Pick<
    MakesafeIdentity,
    | "companyKey"
    | "externalRefCanonical"
    | "builderWoCanonical"
    | "builderPoCanonical"
    | "deliverableRefCanonical"
    | "woPoIdentityKey"
    | "normaliserVersion"
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
    const prior = existing.fieldProvenance[key];
    if (
      prior !== undefined && JSON.stringify(prior) !== JSON.stringify(value)
    ) {
      throw new Error("field provenance is append-only");
    }
  }
  return {
    ...existing,
    ...update,
    companySlugRaw: existing.companySlugRaw,
    externalRefRaw: existing.externalRefRaw,
    builderWoRaw: existing.builderWoRaw,
    builderPoRaw: existing.builderPoRaw,
    deliverableRefRaw: existing.deliverableRefRaw,
    fieldProvenance: {
      ...existing.fieldProvenance,
      ...provenanceAdditions,
    },
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

export interface MakesafeSourceAccountingRow {
  orgId: string;
  caseId: string;
  postId: string;
  role: MakesafeSourceRole;
}

export function attachSourceOnce(
  existing: readonly MakesafeSourceAccountingRow[],
  candidate: MakesafeSourceAccountingRow,
): { rows: readonly MakesafeSourceAccountingRow[]; inserted: boolean } {
  const accounted = existing.find((row) =>
    row.orgId === candidate.orgId && row.postId === candidate.postId
  );
  if (accounted !== undefined) {
    if (accounted.caseId !== candidate.caseId) {
      throw new Error("source post is already accounted to another case");
    }
    return { rows: existing, inserted: false };
  }
  return { rows: [...existing, candidate], inserted: true };
}

export interface CaseUpsertPlan {
  caseWrites: number;
  sourceWrites: number;
  eventWrites: number;
  notificationWrites: number;
  domainEventWrites: number;
}

export function planBackfillInstruction(input: {
  replayKeys: ReadonlySet<string>;
  replayKey: string;
  sourceAlreadyAttached: boolean;
  sideEffectsSuppressed: boolean;
}): CaseUpsertPlan {
  if (!input.sideEffectsSuppressed) {
    throw new Error("backfill must suppress notification and domain effects");
  }
  if (input.replayKeys.has(input.replayKey)) {
    return {
      caseWrites: 0,
      sourceWrites: input.sourceAlreadyAttached ? 0 : 1,
      eventWrites: 0,
      notificationWrites: 0,
      domainEventWrites: 0,
    };
  }
  return {
    caseWrites: 1,
    sourceWrites: input.sourceAlreadyAttached ? 0 : 1,
    eventWrites: 1,
    notificationWrites: 0,
    domainEventWrites: 0,
  };
}
