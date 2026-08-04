import { sesSha256 } from "./ses_docket_envelope.ts";
import { SES_PRICING_CANON_VERSION } from "./makesafe_invoice_obligation.ts";

export const ROOF_STOREY_CORRECTION_JOB_NUMBER = "SWMS-261114";
export const ROOF_STOREY_CORRECTION_BUILDER_REFERENCE = "RR-26836";
export const ROOF_STOREY_CORRECTION_SUBURB = "White Gum Valley";
export const ROOF_STOREY_CORRECTION_EVIDENCE_REFERENCE = "54a70c6f";
export const ROOF_STOREY_CORRECTION_REASON_CODE =
  "locked_current_cycle_storey_correction";
export const ROOF_STOREY_CORRECTION_REVIEW_CONTRACT =
  "roof-storey-correction-recovery.v1";
export const ROOF_STOREY_CORRECTION_EVIDENCE_REFS_DOMAIN =
  "SecureWorks:roof-storey-correction-evidence-refs:v1\n";

const EXPECTED_CYCLE_NUMBER = 2;
const EXPECTED_PORTAL_CONTENT_HASH =
  "sha256:257d7a9813822a73d79589b596c00cff0eadc42532ee7ab430913daf41331993";
const EXPECTED_PORTAL_SOURCE_HASH =
  "sha256:38957022c6e4e017bfff44a7d04d195c5a10338d338aa7b13a52d5d400c21d32";
const EXPECTED_PORTAL_SCREENSHOT_HASH = EXPECTED_PORTAL_SOURCE_HASH;
const EXPECTED_PORTAL_EVIDENCE_REFS_FINGERPRINT =
  "sha256:29bf046d1801b9554bfba17103536591abe40b024db533a31dcde5ff22e1bce2";

const STOREY_ALIASES = new Set([
  "storeys",
  "storey",
  "numberofstoreys",
  "storeycount",
]);

export class MakesafeRoofStoreyCorrectionRecoveryError extends Error {
  readonly status: number;
  readonly body?: unknown;

  constructor(message: string, status = 409, body?: unknown) {
    super(message);
    this.name = "MakesafeRoofStoreyCorrectionRecoveryError";
    this.status = status;
    this.body = body;
  }
}

export interface RoofStoreyCorrectionInput {
  job_number: string;
  builder_reference: string;
  expected_storeys: "double";
  corrected_storeys: "single";
  evidence_reference: string;
  reason_code: string;
  dry_run: boolean;
  plan_token: string | null;
}

interface StoreyRoot {
  root: string;
  value: unknown;
}

export interface RoofStoreyCorrectionSnapshot {
  job: {
    id: string;
    jobNumber: string;
    type: string;
    status: string;
    suburb: string;
    updatedAt: string;
    metadata: Record<string, unknown>;
    scopeJson: unknown;
  } | null;
  detail: {
    jobId: string;
    builderReference: string;
    reportType: string | null;
    cycleNumber: number;
    attendanceCycleId: string | null;
    cycleAttribution: string | null;
    scopeJson: unknown;
  } | null;
  cycles: Array<{
    id: string;
    jobId: string;
    cycleNumber: number;
  }>;
  intakeCases: Array<{
    id: string;
    state: string;
    jobId: string | null;
    targetJobId: string | null;
    builderReference: string | null;
    rawIdentityJson: unknown;
  }>;
  portalCaptures: Array<{
    id: string;
    jobId: string;
    attendanceCycleId: string;
    role: string;
    status: string;
    captureResult: string;
    makesafeFactVersion: number;
    makesafeContentHash: string;
    sourceContentHash: string;
    screenshotContentHash: string | null;
    screenshotMediaType: string | null;
    screenshotSizeBytes: number | null;
    captureProducer: string;
    builderReference: string;
    evidenceRefCount: number;
    evidenceRefsFingerprint: string;
  }>;
  reports: Array<{ checklistJson: unknown }>;
  documents: Array<{
    type: string;
    attendanceCycleId: string | null;
    cycleAttribution: string | null;
    makesafeFactVersion: number | null;
    makesafeContentHash: string | null;
    contentPointer: string | null;
    metadata: unknown;
    dataSnapshotJson: unknown;
  }>;
  roofDraft: { storey: unknown; fieldsJson: unknown } | null;
  pricingInputStoreys: unknown;
  docketRevisions: Array<{
    id: string;
    committedAt: string;
    state: string;
    stage: string;
    preXeroDocsReady: boolean;
    storeys: unknown;
    subtotalExGst: number | null;
    totalIncGst: number | null;
    localInvoiceProposal: unknown;
  }>;
  currentDocketId: string | null;
  obligationRevisions: Array<{
    id: string;
    obligationId: string;
    docketRevisionIds: string[];
    attendanceCycleIds: string[];
    lineAttendanceCycleIds: string[][];
    state: string;
    pricingDisposition: string;
    proposal: unknown;
    proposalSchema: string;
    proposalPricingDisposition: string;
    pricingCanonVersion: string;
    reference: string;
    currency: string;
    lineQuantities: number[];
    unitPrices: number[];
    totalEx: number | null;
    totalInc: number | null;
  }>;
  invoiceObligations: Array<{
    id: string;
    status: string;
  }>;
  obligationCycles: Array<{
    obligationRevisionId: string;
    obligationId: string;
    attendanceCycleId: string;
    active: boolean;
    commerciallyClosed: boolean;
  }>;
  currentObligationIds: string[];
  xeroReferenceCandidatesFingerprint: string;
  protectedCounts: Record<string, number>;
}

export interface RoofStoreyCorrectionDependencies {
  loadSnapshot(): Promise<RoofStoreyCorrectionSnapshot>;
  compareAndSetStoreys(input: {
    jobId: string;
    expectedJobNumber: string;
    expectedUpdatedAt: string;
    expectedMetadata: Record<string, unknown>;
    replacementMetadata: Record<string, unknown>;
  }): Promise<boolean>;
}

type CorrectionDisposition =
  | "correct_to_single"
  | "already_corrected"
  | "refused";

interface CorrectionPlan {
  disposition: CorrectionDisposition;
  reason_code: string;
  reason: string;
  confidence: "high" | "low";
  exact_facts: {
    job_number: string;
    builder_reference: string | null;
    suburb: string | null;
    cycle_number: number | null;
    source_storeys: string | null;
    pricing_input_storeys: string | null;
    storey_source_value_counts: Record<string, number>;
    portal_evidence: {
      verification_state: string;
      evidence_reference: string;
    };
    current_docket_price: {
      storeys: string | null;
      subtotal_ex_gst: number | null;
      total_inc_gst: number | null;
    };
    current_obligation_unit_prices_ex_gst: number[];
    protected_counts: Record<string, number>;
  };
  selector_follow_up: {
    required: boolean;
    reason_codes: string[];
  };
  snapshot_fingerprint: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function canonicalKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function canonicalValue(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : String(value);
}

function hasValue(value: unknown): boolean {
  return value !== null && value !== undefined &&
    (typeof value !== "string" || value.trim() !== "");
}

function collectStoreyOccurrences(value: unknown): string[] {
  const matches: string[] = [];
  const queue: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let visited = 0;
  while (queue.length && visited < 1_000) {
    const current = queue.shift()!;
    visited++;
    if (
      !current.value || typeof current.value !== "object" ||
      Array.isArray(current.value) || current.depth > 6
    ) continue;
    for (const [key, child] of Object.entries(record(current.value))) {
      if (STOREY_ALIASES.has(canonicalKey(key)) && hasValue(child)) {
        matches.push(canonicalValue(child));
      }
      if (
        child && typeof child === "object" && !Array.isArray(child) &&
        current.depth < 6
      ) {
        queue.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
  return matches.sort();
}

export function collectStoreyValues(value: unknown): string[] {
  return [...new Set(collectStoreyOccurrences(value))].sort();
}

function storeyRoots(snapshot: RoofStoreyCorrectionSnapshot): StoreyRoot[] {
  return [
    { root: "jobs.metadata", value: snapshot.job?.metadata },
    { root: "jobs.scope_json", value: snapshot.job?.scopeJson },
    {
      root: "makesafe_job_details.scope_json",
      value: snapshot.detail?.scopeJson,
    },
    ...snapshot.intakeCases.map((row, index) => ({
      root: `makesafe_intake_cases.raw_identity_json#${index + 1}`,
      value: row.rawIdentityJson,
    })),
    ...snapshot.reports.map((row, index) => ({
      root: `job_service_reports.checklist_json#${index + 1}`,
      value: row.checklistJson,
    })),
    ...snapshot.documents.map((row, index) => ({
      root: `job_documents.metadata#${index + 1}`,
      value: {
        metadata: row.metadata,
        data_snapshot_json: row.dataSnapshotJson,
      },
    })),
    ...(snapshot.roofDraft
      ? [{
        root: "makesafe_roof_report_drafts",
        value: {
          storey: snapshot.roofDraft.storey,
          fields_json: snapshot.roofDraft.fieldsJson,
        },
      }]
      : []),
    ...snapshot.docketRevisions.map((row, index) => ({
      root: `makesafe_docket_revisions.local_invoice_proposal#${index + 1}`,
      value: row.localInvoiceProposal,
    })),
    ...snapshot.obligationRevisions.map((row, index) => ({
      root: `makesafe_invoice_obligation_revisions.proposal#${index + 1}`,
      value: row.proposal,
    })),
  ];
}

function storeyFacts(snapshot: RoofStoreyCorrectionSnapshot) {
  return Object.fromEntries(
    storeyRoots(snapshot).map(({ root, value }) => [
      root,
      collectStoreyOccurrences(value),
    ]),
  );
}

function storeyFactCounts(snapshot: RoofStoreyCorrectionSnapshot) {
  return Object.fromEntries(
    Object.entries(storeyFacts(snapshot))
      .filter(([, values]) => values.length > 0)
      .map(([root, values]) => [root, values.length]),
  );
}

function normalizedSnapshot(snapshot: RoofStoreyCorrectionSnapshot) {
  return {
    ...snapshot,
    cycles: [...snapshot.cycles].sort((a, b) =>
      a.cycleNumber - b.cycleNumber || a.id.localeCompare(b.id)
    ),
    intakeCases: [...snapshot.intakeCases].sort((a, b) =>
      a.id.localeCompare(b.id)
    ),
    portalCaptures: [...snapshot.portalCaptures].sort((a, b) =>
      a.id.localeCompare(b.id)
    ),
    docketRevisions: [...snapshot.docketRevisions].sort((a, b) =>
      a.committedAt.localeCompare(b.committedAt) || a.id.localeCompare(b.id)
    ),
    obligationRevisions: [...snapshot.obligationRevisions].sort((a, b) =>
      a.id.localeCompare(b.id)
    ),
    invoiceObligations: [...snapshot.invoiceObligations].sort((a, b) =>
      a.id.localeCompare(b.id)
    ),
    obligationCycles: [...snapshot.obligationCycles].sort((a, b) =>
      a.obligationRevisionId.localeCompare(b.obligationRevisionId) ||
      a.attendanceCycleId.localeCompare(b.attendanceCycleId)
    ),
    currentObligationIds: [...snapshot.currentObligationIds].sort(),
    protectedCounts: Object.fromEntries(
      Object.entries(snapshot.protectedCounts).sort(([a], [b]) =>
        a.localeCompare(b)
      ),
    ),
  };
}

async function snapshotFingerprint(snapshot: RoofStoreyCorrectionSnapshot) {
  return await sesSha256(
    normalizedSnapshot(snapshot),
    "SecureWorks:roof-storey-correction-snapshot:v1\n",
  );
}

async function protectedFingerprint(snapshot: RoofStoreyCorrectionSnapshot) {
  const normalized = normalizedSnapshot(snapshot);
  const metadata = { ...(normalized.job?.metadata || {}) };
  delete metadata.storeys;
  return await sesSha256({
    ...normalized,
    job: normalized.job
      ? { ...normalized.job, metadata, updatedAt: null }
      : null,
    pricingInputStoreys: null,
  }, "SecureWorks:roof-storey-correction-protected-state:v1\n");
}

function exactFacts(
  snapshot: RoofStoreyCorrectionSnapshot,
): CorrectionPlan["exact_facts"] {
  const currentDocket = snapshot.docketRevisions.find((row) =>
    row.id === snapshot.currentDocketId
  );
  const currentObligations = snapshot.obligationRevisions.filter((row) =>
    snapshot.currentObligationIds.includes(row.id)
  );
  const currentCapture = snapshot.portalCaptures.find((row) =>
    row.attendanceCycleId === snapshot.detail?.attendanceCycleId &&
    row.role === "roof_report"
  );
  return {
    job_number: snapshot.job?.jobNumber || ROOF_STOREY_CORRECTION_JOB_NUMBER,
    builder_reference: snapshot.detail?.builderReference || null,
    suburb: snapshot.job?.suburb || null,
    cycle_number: snapshot.detail?.cycleNumber ?? null,
    source_storeys: typeof snapshot.job?.metadata.storeys === "string"
      ? snapshot.job.metadata.storeys
      : null,
    pricing_input_storeys: typeof snapshot.pricingInputStoreys === "string"
      ? snapshot.pricingInputStoreys
      : null,
    storey_source_value_counts: storeyFactCounts(snapshot),
    portal_evidence: {
      verification_state: currentCapture
        ? `${currentCapture.status}/${currentCapture.captureResult}`
        : "missing",
      evidence_reference: ROOF_STOREY_CORRECTION_EVIDENCE_REFERENCE,
    },
    current_docket_price: {
      storeys: typeof currentDocket?.storeys === "string"
        ? currentDocket.storeys
        : null,
      subtotal_ex_gst: currentDocket?.subtotalExGst ?? null,
      total_inc_gst: currentDocket?.totalIncGst ?? null,
    },
    current_obligation_unit_prices_ex_gst: currentObligations.flatMap((row) =>
      row.unitPrices
    ).sort((a, b) => a - b),
    protected_counts: { ...snapshot.protectedCounts },
  };
}

async function refusal(
  snapshot: RoofStoreyCorrectionSnapshot,
  reasonCode: string,
  reason: string,
): Promise<CorrectionPlan> {
  return {
    disposition: "refused",
    reason_code: reasonCode,
    reason,
    confidence: "low",
    exact_facts: exactFacts(snapshot),
    selector_follow_up: { required: false, reason_codes: [] },
    snapshot_fingerprint: await snapshotFingerprint(snapshot),
  };
}

function expectedProtectedCounts(
  snapshot: RoofStoreyCorrectionSnapshot,
  sourceStoreys: string,
) {
  const required: Record<string, number> = {
    assignments: 0,
    board_status_applications: 0,
    communications: 0,
    external_effects: 0,
    hugo_notifications: 0,
    arrival_notifications: 0,
    invoice_approvals: 0,
    invoice_obligations: 1,
    invoice_obligation_cycles: sourceStoreys === "single" &&
        snapshot.protectedCounts.docket_revisions === 2
      ? 2
      : 1,
    job_documents: 1,
    job_media: 0,
    outbound_messages: 0,
    portal_captures: 1,
    release_memberships: 0,
    report_packs: 0,
    roof_report_drafts: 0,
    service_reports: 0,
    xero_invoices: 0,
    canonical_unlinked_xero_invoices: 0,
  };
  const fixedCountsMatch = Object.entries(required).every(([key, value]) =>
    snapshot.protectedCounts[key] === value
  );
  if (!fixedCountsMatch) return false;
  const revisionCounts = [
    snapshot.protectedCounts.docket_revisions,
    snapshot.protectedCounts.invoice_obligation_revisions,
    snapshot.protectedCounts.review_events,
  ];
  if (sourceStoreys === "double") {
    return revisionCounts.every((count) => count === 1);
  }
  return revisionCounts.every((count) => count === 1) ||
    revisionCounts.every((count) => count === 2);
}

function exactPortalAuthority(snapshot: RoofStoreyCorrectionSnapshot) {
  if (!snapshot.detail?.attendanceCycleId) return false;
  const current = snapshot.portalCaptures.filter((row) =>
    row.jobId === snapshot.job?.id &&
    row.attendanceCycleId === snapshot.detail?.attendanceCycleId &&
    row.role === "roof_report"
  );
  return current.length === 1 && current[0].status === "verified" &&
    current[0].captureResult === "done" &&
    current[0].makesafeFactVersion === 1 &&
    current[0].makesafeContentHash === EXPECTED_PORTAL_CONTENT_HASH &&
    current[0].sourceContentHash === EXPECTED_PORTAL_SOURCE_HASH &&
    current[0].screenshotContentHash === EXPECTED_PORTAL_SCREENSHOT_HASH &&
    current[0].screenshotMediaType === "image/png" &&
    Number(current[0].screenshotSizeBytes) > 0 &&
    current[0].captureProducer === "capture_portal_evidence.py/v1" &&
    current[0].builderReference === ROOF_STOREY_CORRECTION_BUILDER_REFERENCE &&
    current[0].evidenceRefCount === 2 &&
    current[0].evidenceRefsFingerprint ===
      EXPECTED_PORTAL_EVIDENCE_REFS_FINGERPRINT;
}

function exactObligationProposal(
  row: RoofStoreyCorrectionSnapshot["obligationRevisions"][number],
  docketRevisionId: string,
  attendanceCycleId: string,
  unitPrice: number,
  totalInc: number,
) {
  return row.proposalSchema === "secureworks.makesafe.invoice-proposal/v1" &&
    row.proposalPricingDisposition === "priced_from_canon" &&
    row.pricingCanonVersion === SES_PRICING_CANON_VERSION &&
    row.reference === ROOF_STOREY_CORRECTION_BUILDER_REFERENCE &&
    row.currency === "AUD" &&
    JSON.stringify(row.docketRevisionIds) ===
      JSON.stringify([docketRevisionId]) &&
    JSON.stringify(row.attendanceCycleIds) ===
      JSON.stringify([attendanceCycleId]) &&
    JSON.stringify(row.lineAttendanceCycleIds) ===
      JSON.stringify([[attendanceCycleId]]) &&
    JSON.stringify(row.lineQuantities) === JSON.stringify([1]) &&
    JSON.stringify(row.unitPrices) === JSON.stringify([unitPrice]) &&
    row.totalEx === unitPrice && row.totalInc === totalInc;
}

async function planSnapshot(
  snapshot: RoofStoreyCorrectionSnapshot,
): Promise<CorrectionPlan> {
  const job = snapshot.job;
  const detail = snapshot.detail;
  if (
    !job || job.jobNumber !== ROOF_STOREY_CORRECTION_JOB_NUMBER ||
    job.type !== "makesafe" || job.status !== "accepted" ||
    job.suburb !== ROOF_STOREY_CORRECTION_SUBURB || !job.updatedAt
  ) {
    return await refusal(
      snapshot,
      "job_identity_drifted",
      "The exact authorized card no longer matches the sealed recovery identity.",
    );
  }
  if (
    !detail || detail.jobId !== job.id ||
    detail.builderReference !== ROOF_STOREY_CORRECTION_BUILDER_REFERENCE ||
    detail.reportType !== "roof_report" ||
    detail.cycleNumber !== EXPECTED_CYCLE_NUMBER ||
    detail.cycleAttribution !== "bound" || !detail.attendanceCycleId
  ) {
    return await refusal(
      snapshot,
      "current_cycle_authority_drifted",
      "The current roof-report detail binding no longer matches the authorized cycle.",
    );
  }
  if (
    snapshot.cycles.length !== 1 ||
    snapshot.cycles[0].jobId !== job.id ||
    snapshot.cycles[0].id !== detail.attendanceCycleId ||
    snapshot.cycles[0].cycleNumber !== EXPECTED_CYCLE_NUMBER
  ) {
    return await refusal(
      snapshot,
      "immutable_cycle_membership_drifted",
      "The current detail is not the sole exact member of the immutable cycle set.",
    );
  }
  const directCases = snapshot.intakeCases.filter((row) =>
    row.state === "confirmed_live_job" && row.jobId === job.id &&
    !row.targetJobId
  );
  if (
    directCases.length !== 1 ||
    directCases[0].builderReference !==
      ROOF_STOREY_CORRECTION_BUILDER_REFERENCE
  ) {
    return await refusal(
      snapshot,
      "current_intake_authority_drifted",
      "Exactly one direct confirmed intake authority must prove the builder reference.",
    );
  }
  if (!exactPortalAuthority(snapshot)) {
    return await refusal(
      snapshot,
      "locked_portal_evidence_drifted",
      "The submitted-and-locked current-cycle portal evidence no longer matches the sealed receipt.",
    );
  }
  const stored = canonicalValue(job.metadata.storeys);
  if (!expectedProtectedCounts(snapshot, stored)) {
    return await refusal(
      snapshot,
      "protected_state_drifted",
      "Protected operational, evidence, outbound, or money row counts changed from the reviewed preimage.",
    );
  }

  const facts = storeyFacts(snapshot);
  const sourceStoreys = collectStoreyOccurrences(job.metadata);
  const competingUpstream = Object.entries(facts).filter(([root, values]) =>
    !root.startsWith("makesafe_docket_revisions.") &&
    !root.startsWith("makesafe_invoice_obligation_revisions.") &&
    root !== "jobs.metadata" && values.length > 0
  );
  if (
    sourceStoreys.length !== 1 || sourceStoreys[0] !== stored ||
    competingUpstream.length > 0 ||
    !["double", "single"].includes(stored) ||
    canonicalValue(snapshot.pricingInputStoreys) !== stored
  ) {
    return await refusal(
      snapshot,
      "typed_storey_sources_inconsistent",
      "The typed current-cycle pricing roots no longer resolve one exact storey fact.",
    );
  }

  const currentDocket = snapshot.docketRevisions.find((row) =>
    row.id === snapshot.currentDocketId
  );
  const currentObligations = snapshot.obligationRevisions.filter((row) =>
    snapshot.currentObligationIds.includes(row.id)
  );
  if (
    !currentDocket || currentDocket.state !== "ready" ||
    currentDocket.stage !== "pre_xero" ||
    !currentDocket.preXeroDocsReady || currentObligations.length !== 1 ||
    currentObligations[0].state !== "proposed" ||
    currentObligations[0].pricingDisposition !== "priced_from_canon"
  ) {
    return await refusal(
      snapshot,
      "invoice_selector_preimage_drifted",
      "The current docket and active pre-Xero obligation no longer form the reviewed selector pair.",
    );
  }

  const currentObligation = currentObligations[0];
  const parentObligations = snapshot.invoiceObligations.filter((row) =>
    row.id === currentObligation.obligationId
  );
  const currentCycleBindings = snapshot.obligationCycles.filter((row) =>
    row.obligationRevisionId === currentObligation.id
  );
  if (
    snapshot.invoiceObligations.length !== 1 ||
    parentObligations.length !== 1 || parentObligations[0].status !== "open" ||
    currentCycleBindings.length !== 1 ||
    currentCycleBindings[0].obligationId !== currentObligation.obligationId ||
    currentCycleBindings[0].attendanceCycleId !== detail.attendanceCycleId ||
    !currentCycleBindings[0].active ||
    currentCycleBindings[0].commerciallyClosed
  ) {
    return await refusal(
      snapshot,
      "invoice_obligation_binding_drifted",
      "The current obligation parent and active cycle binding no longer match the reviewed selector.",
    );
  }

  const selectorIsSingle = currentDocket.storeys === "single" &&
    currentDocket.subtotalExGst === 250 &&
    currentDocket.totalIncGst === 275 &&
    exactObligationProposal(
      currentObligation,
      currentDocket.id,
      detail.attendanceCycleId,
      250,
      275,
    );
  const selectorIsDouble = currentDocket.storeys === "double" &&
    currentDocket.subtotalExGst === 350 &&
    currentDocket.totalIncGst === 385 &&
    exactObligationProposal(
      currentObligation,
      currentDocket.id,
      detail.attendanceCycleId,
      350,
      385,
    );
  if (stored === "double" && !selectorIsDouble) {
    return await refusal(
      snapshot,
      "double_selector_preimage_drifted",
      "The persisted double source no longer matches the reviewed double docket and obligation price.",
    );
  }
  if (stored === "single" && !selectorIsSingle && !selectorIsDouble) {
    return await refusal(
      snapshot,
      "single_selector_state_ambiguous",
      "The corrected source is single but the invoice-facing selector is neither the reviewed historical double nor a complete single supersession.",
    );
  }
  if (stored === "single" && selectorIsSingle) {
    const historicalRevisions = snapshot.obligationRevisions.filter((row) =>
      row.id !== currentObligation.id
    );
    const historicalCycles = snapshot.obligationCycles.filter((row) =>
      row.obligationRevisionId !== currentObligation.id
    );
    const historicalDocket = historicalRevisions.length === 1
      ? snapshot.docketRevisions.find((row) =>
        row.id === historicalRevisions[0].docketRevisionIds[0]
      )
      : undefined;
    if (
      historicalRevisions.length !== 1 ||
      historicalRevisions[0].state !== "superseded" ||
      historicalRevisions[0].obligationId !== currentObligation.obligationId ||
      historicalRevisions[0].pricingDisposition !== "priced_from_canon" ||
      !historicalDocket || historicalDocket.id === currentDocket.id ||
      historicalDocket.state !== "ready" ||
      historicalDocket.stage !== "pre_xero" ||
      !historicalDocket.preXeroDocsReady ||
      historicalDocket.storeys !== "double" ||
      historicalDocket.subtotalExGst !== 350 ||
      historicalDocket.totalIncGst !== 385 ||
      !exactObligationProposal(
        historicalRevisions[0],
        historicalDocket.id,
        detail.attendanceCycleId,
        350,
        385,
      ) ||
      historicalCycles.length !== 1 || historicalCycles[0].active ||
      historicalCycles[0].commerciallyClosed ||
      historicalCycles[0].obligationId !== currentObligation.obligationId ||
      historicalCycles[0].attendanceCycleId !== detail.attendanceCycleId
    ) {
      return await refusal(
        snapshot,
        "invoice_obligation_supersession_incomplete",
        "The historical double obligation is not preserved as one inactive superseded revision.",
      );
    }
  }

  const selectorReasonCodes = selectorIsDouble
    ? [
      "persist_single_storey_docket_revision",
      "supersede_double_invoice_obligation_revision",
    ]
    : [];
  return {
    disposition: stored === "double"
      ? "correct_to_single"
      : "already_corrected",
    reason_code: stored === "double"
      ? ROOF_STOREY_CORRECTION_REASON_CODE
      : "authoritative_storey_already_single",
    reason: stored === "double"
      ? "Correct the sole typed current-cycle storey source from double to single."
      : "The authoritative typed current-cycle storey source already reads single.",
    confidence: "high",
    exact_facts: exactFacts(snapshot),
    selector_follow_up: {
      required: selectorIsDouble,
      reason_codes: selectorReasonCodes,
    },
    snapshot_fingerprint: await snapshotFingerprint(snapshot),
  };
}

function assertExactInput(input: RoofStoreyCorrectionInput) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new MakesafeRoofStoreyCorrectionRecoveryError(
      "storey correction body must be a JSON object",
      400,
    );
  }
  const wanted = [
    "builder_reference",
    "corrected_storeys",
    "dry_run",
    "evidence_reference",
    "expected_storeys",
    "job_number",
    "plan_token",
    "reason_code",
  ].sort();
  const actual = Object.keys(input).sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new MakesafeRoofStoreyCorrectionRecoveryError(
      `storey correction body must contain exactly: ${wanted.join(", ")}`,
      400,
    );
  }
  if (
    input.job_number !== ROOF_STOREY_CORRECTION_JOB_NUMBER ||
    input.builder_reference !== ROOF_STOREY_CORRECTION_BUILDER_REFERENCE ||
    input.expected_storeys !== "double" ||
    input.corrected_storeys !== "single" ||
    input.evidence_reference !== ROOF_STOREY_CORRECTION_EVIDENCE_REFERENCE ||
    input.reason_code !== ROOF_STOREY_CORRECTION_REASON_CODE
  ) {
    throw new MakesafeRoofStoreyCorrectionRecoveryError(
      "storey correction request is outside the exact Captain-authorized recovery contract",
      403,
    );
  }
  if (typeof input.dry_run !== "boolean") {
    throw new MakesafeRoofStoreyCorrectionRecoveryError(
      "dry_run must be an explicit boolean",
      400,
    );
  }
  if (input.dry_run && input.plan_token !== null) {
    throw new MakesafeRoofStoreyCorrectionRecoveryError(
      "dry-run plan_token must be null",
      400,
    );
  }
  if (
    !input.dry_run &&
    (typeof input.plan_token !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(input.plan_token))
  ) {
    throw new MakesafeRoofStoreyCorrectionRecoveryError(
      "storey correction apply requires the exact immediately preceding plan_token",
      400,
    );
  }
}

async function planToken(plan: CorrectionPlan) {
  return await sesSha256({
    contract: ROOF_STOREY_CORRECTION_REVIEW_CONTRACT,
    job_number: ROOF_STOREY_CORRECTION_JOB_NUMBER,
    builder_reference: ROOF_STOREY_CORRECTION_BUILDER_REFERENCE,
    evidence_reference: ROOF_STOREY_CORRECTION_EVIDENCE_REFERENCE,
    reason_code: plan.reason_code,
    disposition: plan.disposition,
    snapshot_fingerprint: plan.snapshot_fingerprint,
    selector_follow_up: plan.selector_follow_up,
  }, "SecureWorks:roof-storey-correction-plan:v1\n");
}

function result(
  plan: CorrectionPlan,
  token: string,
  dryRun: boolean,
  writesApplied: number,
) {
  return {
    ok: plan.disposition !== "refused",
    dry_run: dryRun,
    contract: ROOF_STOREY_CORRECTION_REVIEW_CONTRACT,
    plan,
    plan_token: token,
    writes_applied: writesApplied,
    external_mutations: {
      assignments: 0,
      board_or_job_state: 0,
      cycle_membership: 0,
      evidence_content: 0,
      invoices: 0,
      notifications: 0,
      outbound_queues: 0,
    },
  };
}

export async function runRoofStoreyCorrectionRecovery(
  input: RoofStoreyCorrectionInput,
  deps: RoofStoreyCorrectionDependencies,
): Promise<Record<string, unknown>> {
  assertExactInput(input);
  const initial = await deps.loadSnapshot();
  const initialPlan = await planSnapshot(initial);
  const initialToken = await planToken(initialPlan);
  if (input.dry_run) return result(initialPlan, initialToken, true, 0);
  if (input.plan_token !== initialToken) {
    throw new MakesafeRoofStoreyCorrectionRecoveryError(
      "storey correction apply refused: plan token is stale or belongs to another preimage",
      409,
      result(initialPlan, initialToken, false, 0),
    );
  }
  if (initialPlan.disposition === "refused") {
    throw new MakesafeRoofStoreyCorrectionRecoveryError(
      `storey correction apply refused: ${initialPlan.reason_code}`,
      409,
      result(initialPlan, initialToken, false, 0),
    );
  }

  const preflight = await deps.loadSnapshot();
  const preflightPlan = await planSnapshot(preflight);
  if (
    preflightPlan.snapshot_fingerprint !== initialPlan.snapshot_fingerprint ||
    preflightPlan.disposition !== initialPlan.disposition
  ) {
    throw new MakesafeRoofStoreyCorrectionRecoveryError(
      "storey correction apply refused: live state drifted after planning",
      409,
      result(preflightPlan, await planToken(preflightPlan), false, 0),
    );
  }
  if (preflightPlan.disposition === "already_corrected") {
    return result(preflightPlan, initialToken, false, 0);
  }

  const job = preflight.job!;
  const beforeProtected = await protectedFingerprint(preflight);
  const replacementMetadata = { ...job.metadata, storeys: "single" };
  const updated = await deps.compareAndSetStoreys({
    jobId: job.id,
    expectedJobNumber: ROOF_STOREY_CORRECTION_JOB_NUMBER,
    expectedUpdatedAt: job.updatedAt,
    expectedMetadata: job.metadata,
    replacementMetadata,
  });
  if (!updated) {
    throw new MakesafeRoofStoreyCorrectionRecoveryError(
      "storey correction compare-and-set matched no exact row",
      409,
      result(preflightPlan, initialToken, false, 0),
    );
  }

  const finalSnapshot = await deps.loadSnapshot();
  const finalPlan = await planSnapshot(finalSnapshot);
  const afterProtected = await protectedFingerprint(finalSnapshot);
  if (
    finalPlan.disposition !== "already_corrected" ||
    finalPlan.exact_facts.source_storeys !== "single" ||
    finalPlan.exact_facts.pricing_input_storeys !== "single" ||
    beforeProtected !== afterProtected
  ) {
    throw new MakesafeRoofStoreyCorrectionRecoveryError(
      "storey correction postcondition failed: current source or protected state did not settle exactly",
      503,
      result(finalPlan, await planToken(finalPlan), false, 1),
    );
  }
  return result(finalPlan, initialToken, false, 1);
}
