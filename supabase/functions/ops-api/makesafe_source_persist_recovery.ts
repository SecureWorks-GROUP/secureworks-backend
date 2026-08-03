// deno-lint-ignore-file no-explicit-any

export const SOURCE_PERSIST_RECOVERY_EXTERNAL_REF = "MLB-RR-26836";
export const SOURCE_PERSIST_RECOVERY_PURCHASE_ORDER = "PO-57602";

export class SourcePersistRecoveryError extends Error {
  constructor(message: string, readonly status = 409) {
    super(message);
    this.name = "SourcePersistRecoveryError";
  }
}

export interface SourcePersistRecoveryTarget {
  externalRef: typeof SOURCE_PERSIST_RECOVERY_EXTERNAL_REF;
  builderPurchaseOrder: typeof SOURCE_PERSIST_RECOVERY_PURCHASE_ORDER;
}

export interface SourcePersistRecoveryAuthority {
  caseId: string;
  instructionKey: string;
  state: string;
  reasonCode: string | null;
  lastDecisionReason: string | null;
  isAuthoritative: boolean;
  jobId: string | null;
  sourceCount: number;
}

export interface SourcePersistRecoveryQueueSnapshot {
  targetCards: number;
  unrelatedCards: number;
  unrelatedFingerprint: string;
}

export interface SourcePersistRecoveryOutcome {
  caseAuthoritative: boolean;
  caseState: string;
  caseReasonCode: string | null;
  jobExists: boolean;
  jobUnassigned: boolean;
  logicalJobs: number;
  assignments: number;
  invoices: number;
  communications: number;
  notifications: number;
  outboundQueueRows: number;
}

export interface SourcePersistRecoveryDeps {
  loadQueueSnapshot: (
    target: SourcePersistRecoveryTarget,
    generatedAt: string,
  ) => Promise<SourcePersistRecoveryQueueSnapshot>;
  loadAuthority: (
    target: SourcePersistRecoveryTarget,
  ) => Promise<SourcePersistRecoveryAuthority | null>;
  recover: (
    target: SourcePersistRecoveryTarget,
    authority: SourcePersistRecoveryAuthority,
  ) => Promise<any>;
  loadOutcome: (
    target: SourcePersistRecoveryTarget,
    authority: SourcePersistRecoveryAuthority,
  ) => Promise<SourcePersistRecoveryOutcome>;
}

function exactInput(value: unknown): string {
  return String(value ?? "").trim().toUpperCase();
}

export function sourcePersistRecoveryTarget(
  body: any,
): SourcePersistRecoveryTarget {
  const externalRef = exactInput(body?.external_ref ?? body?.externalRef);
  const builderPurchaseOrder = exactInput(
    body?.builder_purchase_order ?? body?.builderPurchaseOrder,
  );
  if (
    externalRef !== SOURCE_PERSIST_RECOVERY_EXTERNAL_REF ||
    builderPurchaseOrder !== SOURCE_PERSIST_RECOVERY_PURCHASE_ORDER
  ) {
    throw new SourcePersistRecoveryError(
      "source-persistence recovery is authorized only for the exact named obligation",
      403,
    );
  }
  return {
    externalRef: SOURCE_PERSIST_RECOVERY_EXTERNAL_REF,
    builderPurchaseOrder: SOURCE_PERSIST_RECOVERY_PURCHASE_ORDER,
  };
}

export async function runSourcePersistRecovery(
  body: any,
  deps: SourcePersistRecoveryDeps,
) {
  const target = sourcePersistRecoveryTarget(body);
  const generatedAt = new Date().toISOString();
  const before = await deps.loadQueueSnapshot(target, generatedAt);
  if (before.targetCards !== 1) {
    throw new SourcePersistRecoveryError(
      "exact recovery target must resolve to one actionable exception card",
    );
  }

  const authority = await deps.loadAuthority(target);
  if (
    !authority || authority.state !== "exception" ||
    authority.reasonCode !== "adapter_parse_failure" ||
    authority.lastDecisionReason !==
      "deterministic source_persist_failed case_insert" ||
    authority.isAuthoritative || authority.jobId || authority.sourceCount < 1
  ) {
    throw new SourcePersistRecoveryError(
      "exact recovery authority is missing, drifted, or already consumed",
    );
  }

  const report = await deps.recover(target, authority);
  const totals = report?.totals || {};
  if (
    Number(totals.cases_attempted || 0) !== 1 ||
    Number(totals.cases_failed || 0) !== 0 ||
    Number(totals.jobs_created || 0) !== 1 ||
    Number(totals.hugo_notifications_required || 0) !== 1 ||
    Number(totals.hugo_notifications_suppressed || 0) !== 1 ||
    Number(totals.hugo_notifications_recorded || 0) !== 0 ||
    Number(totals.hugo_notifications_accepted || 0) !== 0 ||
    Number(totals.hugo_notifications_failed || 0) !== 0
  ) {
    throw new SourcePersistRecoveryError(
      "exact recovery runtime postcondition failed",
      503,
    );
  }

  const outcome = await deps.loadOutcome(target, authority);
  if (
    !outcome.caseAuthoritative ||
    !["confirmed_live_job", "blocked_live_job"].includes(outcome.caseState) ||
    outcome.caseReasonCode !== null || !outcome.jobExists ||
    !outcome.jobUnassigned || outcome.logicalJobs !== 1 ||
    outcome.assignments !== 0 || outcome.invoices !== 0 ||
    outcome.communications !== 0 || outcome.notifications !== 0 ||
    outcome.outboundQueueRows !== 0
  ) {
    throw new SourcePersistRecoveryError(
      "exact recovery operational postcondition failed",
      503,
    );
  }

  const after = await deps.loadQueueSnapshot(target, generatedAt);
  if (
    after.targetCards !== 0 ||
    after.unrelatedCards !== before.unrelatedCards ||
    after.unrelatedFingerprint !== before.unrelatedFingerprint
  ) {
    throw new SourcePersistRecoveryError(
      "exact recovery exception-queue isolation postcondition failed",
      503,
    );
  }

  return {
    ok: true,
    contract_version: "makesafe-source-persist-recovery.v1",
    target: {
      external_ref: target.externalRef,
      builder_purchase_order: target.builderPurchaseOrder,
    },
    scope: {
      authoritative: true,
      source_rows: authority.sourceCount,
    },
    job: {
      created: true,
      unassigned: true,
      logical_jobs: 1,
    },
    notifications: {
      required: 1,
      suppressed: 1,
      recorded: 0,
      accepted: 0,
      failed: 0,
    },
    side_effects: {
      assignments: 0,
      invoices: 0,
      communications: 0,
      outbound_queue_rows: 0,
      unrelated_exception_cards_unchanged: true,
      unrelated_exception_cards: after.unrelatedCards,
    },
  };
}
