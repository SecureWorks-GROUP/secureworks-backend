/**
 * ONE admission gate for every SES pack-build surface (CIO, 2026-09-13).
 *
 * Backlog `ses-workflow-completion-20260913`: an eligible job reaching Trade
 * Report In must create or JOIN one durable pack-build attempt, whichever door
 * drove it. Today three doors can start a build and only one of them files a
 * run:
 *
 *   - the pg_cron drain and the manual `run_ses_report_trigger` file a run,
 *     claim it under a lease, and leave a receipt;
 *   - `prepare_ses_docket_revision` is reachable directly by the make-safe
 *     reporting routine, the agent seat and any admin/owner session, and files
 *     nothing at all.
 *
 * That is not theoretical. Measured in production 2026-09-13, job
 * `6e7103eb-49fb-49d2-8b21-692e4c0fe160` (AJBR-72221) carries BOTH a `pending`
 * run filed 2026-09-11 that has never been claimed AND a complete pack built
 * 2026-09-12 by `makesafe-reporting-routine` through the direct door, with a
 * live Xero DRAFT INV-1517 bound to it. The trigger's own conflict check asks
 * only "is there a sibling RUN in state done", never "does a PACK already
 * exist", so re-enabling the drain would hand that card back to `prepare` and
 * cut a second docket revision over bound money — the divergent pack this gate
 * exists to prevent.
 *
 * This module is PURE and decides admission only. It is not a second status
 * engine, not a second pack engine, and it owns no schema:
 *
 *   - pack truth comes from the ONE shared read, `inspectSesPackAction`
 *     (`ses_inspect_pack.ts`). This module never re-derives a pointer, a
 *     docket coordinate or an invoice status of its own.
 *   - stage placement stays with `deriveSesStageV2`. Nothing here moves a card.
 *   - building stays with `prepare_ses_docket_revision`. `admit` is permission
 *     to call it, never a build.
 *   - `mints_allowed` and `sends_allowed` are structurally `false`. No decision
 *     this gate can return authorises Xero or Graph.
 *
 * Docs Ready stays distinct from sent, in both directions: a sent pack is held
 * (`hold_pack_sent`) rather than rebuilt, and no decision here marks anything
 * sent.
 *
 * Contract: `docs/ses-pack-build-workflow-v1.md`.
 */

export const SES_PACK_BUILD_ADMISSION_VERSION = "ses.pack-build-admission/v1";

/**
 * The attempt key grammar, in ONE place.
 *
 * It must stay byte-identical to `enqueue_ses_report_trigger_run()`
 * (`20260911060000_ses_report_trigger_runs.sql`), which composes
 * `job_id || ':' || coalesce(cycle_id, 'cycle?') || ':' || identity`, and to
 * `fileManualRun` in `ses_report_trigger.ts`. A surface that composes its own
 * key files a SECOND row for work that already has one, which is the duplicate
 * attempt this whole slice removes.
 */
export const SES_PACK_BUILD_UNKNOWN_CYCLE_TOKEN = "cycle?";

export function sesPackBuildAttemptKey(
  jobId: string,
  attendanceCycleId: string | null | undefined,
  sourceIdentity: string,
): string {
  const job = String(jobId ?? "").trim();
  const cycle = String(attendanceCycleId ?? "").trim() ||
    SES_PACK_BUILD_UNKNOWN_CYCLE_TOKEN;
  const identity = String(sourceIdentity ?? "").trim();
  return `${job}:${cycle}:${identity}`;
}

export type SesPackBuildDecision =
  /** No pack for this cycle and nothing else holds it: hand the card to prepare. */
  | "admit"
  /** Another attempt already holds this job+cycle under a live lease. */
  | "join"
  /** A complete pack for this cycle already exists. Adopt it; never rebuild. */
  | "reuse"
  /** A pack exists for this cycle but its owed pointers are incomplete. */
  | "hold_divergent_pack"
  /** Another attempt already completed this job+cycle. */
  | "hold_already_built"
  /** The pack has already gone to the builder. */
  | "hold_pack_sent"
  /** The requested cycle is not the current one. */
  | "hold_stale_cycle"
  /** The card has no attendance cycle to build against. */
  | "hold_no_cycle"
  /** The family's document requirements could not be resolved. */
  | "hold_requirements_unresolved"
  /** The request names a different job than the pack that came back. */
  | "refuse_cross_job"
  /** The request names a different tenant than the job. */
  | "refuse_cross_tenant";

export interface SesPackBuildRequestedIdentity {
  job_id: string;
  attendance_cycle_id: string | null;
  source_identity: string;
  org_id?: string | null;
}

export interface SesPackBuildCycle {
  id: string;
  cycle_number: number | null;
}

/** Exactly the subset of `SesPackInspection` this gate reads. Nothing is re-derived. */
export interface SesPackBuildPackTruth {
  job_id: string;
  org_id?: string | null;
  required_documents_resolved: boolean;
  required_documents: { report: boolean; invoice: boolean; swms: boolean } | null;
  pack: {
    exists: boolean;
    status: string | null;
    report_doc_id: string | null;
    invoice_doc_id: string | null;
    swms_doc_id: string | null;
    sent_at: string | null;
    send_started_at: string | null;
  };
  docket: {
    docket_revision_id: string | null;
    output_content_hash: string | null;
  } | null;
  /** Who committed the current docket. `null` when nothing has been prepared. */
  docket_actor_identity: string | null;
  invoice: {
    xero_invoice_id: string | null;
    number: string | null;
    status: string | null;
  } | null;
}

/** One sibling attempt on the same card, as the ledger holds it. */
export interface SesPackBuildSiblingRun {
  id: string;
  dedupe_key: string;
  state: string;
  attendance_cycle_id: string | null;
  docket_revision_id: string | null;
  lease_expires_at: string | null;
}

export interface SesPackBuildAdmissionInput {
  requested: SesPackBuildRequestedIdentity;
  current_cycle: SesPackBuildCycle | null;
  pack: SesPackBuildPackTruth | null;
  /** Every other run on this job. The caller's own run must be excluded. */
  sibling_runs: SesPackBuildSiblingRun[];
  now: Date;
}

export interface SesPackBuildAdmission {
  version: typeof SES_PACK_BUILD_ADMISSION_VERSION;
  decision: SesPackBuildDecision;
  /** What is true, in the operator's words. */
  reason: string;
  /** What the operator does next. Never empty on a non-admit decision. */
  recovery_action: string | null;
  attempt_key: string;
  /** The run to join or reconcile against, when there is one. */
  join_run_id: string | null;
  /** The docket to adopt on `reuse`. */
  adopt_docket_revision_id: string | null;
  adopt_output_content_hash: string | null;
  pointers_complete: boolean;
  /** Owed pointers this card still lacks, named so a hold is actionable. */
  missing_pointers: string[];
  /** A pack exists that no ledger run explains. */
  pack_built_outside_ledger: boolean;
  /** May the caller hand this card to `prepare_ses_docket_revision`? */
  builds_allowed: boolean;
  /** Structurally false. This gate never authorises Xero. */
  mints_allowed: false;
  /** Structurally false. This gate never authorises a send. */
  sends_allowed: false;
}

/** States that mean an attempt is still live and should be joined, not duplicated. */
const LIVE_RUN_STATES = new Set(["pending", "claimed", "failed"]);

const POINTER_LABELS: Record<"report" | "invoice" | "swms", string> = {
  report: "the make-safe report document",
  invoice: "the invoice document",
  swms: "the SWMS this family requires",
};

function packHasGoneOut(pack: SesPackBuildPackTruth["pack"]): boolean {
  if (pack.sent_at || pack.send_started_at) return true;
  const status = String(pack.status || "").toLowerCase();
  return ["sent", "sent_marker_failed", "sent_not_closed", "close_failed"]
    .includes(status);
}

/**
 * Owed pointers this card still lacks.
 *
 * Requirements come from `required_documents` — the pack-artifact requirement
 * map owned by `deriveSesRequiredDocuments`. This function never invents a
 * requirement: an unresolved map is handled by the caller as
 * `hold_requirements_unresolved`, never as "nothing is owed".
 */
export function sesMissingPackPointers(
  pack: SesPackBuildPackTruth,
): string[] {
  const owed = pack.required_documents;
  if (!owed) return [];
  const missing: string[] = [];
  if (owed.report && !String(pack.pack.report_doc_id || "").trim()) {
    missing.push(POINTER_LABELS.report);
  }
  if (owed.invoice && !String(pack.pack.invoice_doc_id || "").trim()) {
    missing.push(POINTER_LABELS.invoice);
  }
  if (owed.swms && !String(pack.pack.swms_doc_id || "").trim()) {
    missing.push(POINTER_LABELS.swms);
  }
  return missing;
}

function liveSibling(
  runs: SesPackBuildSiblingRun[],
  cycleId: string,
  now: Date,
): SesPackBuildSiblingRun | null {
  for (const run of runs) {
    if (run.attendance_cycle_id && run.attendance_cycle_id !== cycleId) continue;
    if (!LIVE_RUN_STATES.has(run.state)) continue;
    if (run.state === "claimed") {
      // An expired lease is not a live holder; the claim RPC will reclaim it.
      const expiry = run.lease_expires_at
        ? Date.parse(run.lease_expires_at)
        : Number.NaN;
      if (!Number.isFinite(expiry) || expiry <= now.getTime()) continue;
    }
    return run;
  }
  return null;
}

function doneSibling(
  runs: SesPackBuildSiblingRun[],
  cycleId: string,
): SesPackBuildSiblingRun | null {
  return runs.find((run) =>
    run.state === "done" &&
    (!run.attendance_cycle_id || run.attendance_cycle_id === cycleId)
  ) ?? null;
}

/**
 * The pure admission decision.
 *
 * Order is part of the contract and is deliberately identity-and-safety first:
 * a cross-job or cross-tenant request is refused before any cycle or pack fact
 * is consulted, and a sent pack is held before any reuse or rebuild is
 * considered. Every branch that is not `admit` sets `builds_allowed: false`,
 * so a caller that ignores `decision` and reads only that flag still cannot
 * build.
 */
export function admitSesPackBuild(
  input: SesPackBuildAdmissionInput,
): SesPackBuildAdmission {
  const requestedJob = String(input.requested.job_id || "").trim();
  const attemptKey = sesPackBuildAttemptKey(
    requestedJob,
    input.requested.attendance_cycle_id,
    input.requested.source_identity,
  );

  const base = {
    version: SES_PACK_BUILD_ADMISSION_VERSION,
    attempt_key: attemptKey,
    join_run_id: null,
    adopt_docket_revision_id: null,
    adopt_output_content_hash: null,
    pointers_complete: false,
    missing_pointers: [] as string[],
    pack_built_outside_ledger: false,
    builds_allowed: false,
    mints_allowed: false,
    sends_allowed: false,
  } as const;

  const pack = input.pack;

  // 1. Identity, before anything else. A pack read that came back for another
  //    job is never evidence about this one.
  if (pack && String(pack.job_id || "").trim() !== requestedJob) {
    return {
      ...base,
      decision: "refuse_cross_job",
      reason:
        `The request names job ${requestedJob} but the pack read returned job ${pack.job_id}.`,
      recovery_action:
        "Nothing was built. Re-file this attempt against the job the report actually belongs to.",
    };
  }

  // 2. Tenant. An org that does not match is refused, and an org this caller
  //    could not state is NOT treated as a match.
  const requestedOrg = String(input.requested.org_id || "").trim();
  const packOrg = String(pack?.org_id || "").trim();
  if (requestedOrg && packOrg && requestedOrg !== packOrg) {
    return {
      ...base,
      decision: "refuse_cross_tenant",
      reason:
        `The request is scoped to organisation ${requestedOrg} but the job belongs to ${packOrg}.`,
      recovery_action:
        "Nothing was built. This card belongs to another tenant; it is not this operator's to build.",
    };
  }

  // 3. A cycle to build against.
  if (!input.current_cycle) {
    return {
      ...base,
      decision: "hold_no_cycle",
      reason: "This card has no attendance cycle, so there is nothing to build a pack for.",
      recovery_action:
        "Open the attendance cycle on the make-safe board, then re-file this attempt.",
    };
  }
  const cycleId = input.current_cycle.id;

  // 4. Staleness. A report from a closed cycle must never build over the
  //    current one.
  const requestedCycle = String(input.requested.attendance_cycle_id || "").trim();
  if (requestedCycle && requestedCycle !== cycleId) {
    return {
      ...base,
      decision: "hold_stale_cycle",
      reason:
        `This report belongs to attendance cycle ${requestedCycle}, which is closed. The current cycle is ${cycleId}.`,
      recovery_action:
        "No action. The current cycle files its own attempt when its own report is submitted.",
    };
  }

  // 5. Sent is terminal for building. Docs Ready is distinct from sent, and a
  //    pack already with the builder is never rebuilt underneath them.
  if (pack && packHasGoneOut(pack.pack)) {
    return {
      ...base,
      decision: "hold_pack_sent",
      reason:
        `This pack has already gone to the builder${pack.pack.sent_at ? ` (sent ${pack.pack.sent_at})` : ""}.`,
      recovery_action:
        "No action. If the builder needs a corrected pack, that is a new attendance cycle or an explicit re-prepare, not this attempt.",
    };
  }

  // 6. Somebody else is already on it. Join rather than start a second attempt.
  const live = liveSibling(input.sibling_runs, cycleId, input.now);
  if (live) {
    return {
      ...base,
      decision: "join",
      join_run_id: live.id,
      reason:
        `Attempt ${live.dedupe_key} is already open on this card and cycle (state ${live.state}).`,
      recovery_action:
        "No action. Watch that run; this request joined it rather than starting a second build.",
    };
  }

  const explained = doneSibling(input.sibling_runs, cycleId);
  const missing = pack ? sesMissingPackPointers(pack) : [];
  const requirementsKnown = Boolean(
    pack && pack.required_documents_resolved && pack.required_documents,
  );
  const hasDocket = Boolean(
    String(pack?.docket?.docket_revision_id || "").trim(),
  );
  const packPresent = Boolean(pack && (pack.pack.exists || hasDocket));
  const builtOutsideLedger = packPresent && !explained;

  // 7. A complete pack already exists. Adopt it. This is the reuse the ask
  //    requires: repeated triggers and manual retries land here, no second
  //    docket revision is cut, and no invoice can be minted twice because
  //    nothing is handed to prepare at all. It is checked BEFORE the
  //    already-built refusal below so an attempt whose work is genuinely
  //    finished completes rather than parking a human with a reconcile.
  if (pack && requirementsKnown && packPresent && missing.length === 0) {
    return {
      ...base,
      decision: "reuse",
      join_run_id: explained?.id ?? null,
      adopt_docket_revision_id: pack.docket?.docket_revision_id ?? null,
      adopt_output_content_hash: pack.docket?.output_content_hash ?? null,
      pointers_complete: true,
      pack_built_outside_ledger: builtOutsideLedger,
      reason: builtOutsideLedger
        ? `A complete pack already exists for this cycle, built by ${pack.docket_actor_identity || "another door"} outside this ledger. Its documents are reused; nothing was rebuilt.`
        : "A complete pack already exists for this cycle. Its documents are reused; nothing was rebuilt.",
      recovery_action: null,
    };
  }

  // 8. A sibling attempt already completed this cycle but the pack is not
  //    complete (or is unreadable). This is the pre-existing refused_conflict
  //    contract and is preserved exactly: a later submission superseding a
  //    built docket is INSURANCE's call, never an automatic rebuild.
  if (explained) {
    return {
      ...base,
      decision: "hold_already_built",
      join_run_id: explained.id,
      missing_pointers: missing,
      reason:
        `This cycle was already built from ${explained.dedupe_key}${explained.docket_revision_id ? ` (docket ${explained.docket_revision_id})` : ""}.`,
      recovery_action:
        "Reconcile: INSURANCE decides whether this later submission supersedes the built docket; if so prepare a revision manually.",
    };
  }

  // 9. From here on a pack read is required. Without one this gate cannot tell
  //    a first build from a rebuild over bound money, and it fails closed.
  if (!pack) {
    return {
      ...base,
      decision: "hold_divergent_pack",
      reason:
        "The current pack could not be read, so this gate cannot tell a first build from a rebuild over an existing one.",
      recovery_action:
        "Nothing was built. Read the card with inspect_ses_pack; if it genuinely has no pack, re-file this attempt.",
    };
  }

  // 10. Requirements must be known before "complete" can mean anything.
  if (!requirementsKnown) {
    return {
      ...base,
      decision: "hold_requirements_unresolved",
      reason:
        "This card's family document requirements did not resolve, so which documents the pack owes is unknown.",
      recovery_action:
        "Nothing was built. Resolve the builder family or matrix authority on the card, then re-file this attempt.",
    };
  }

  // 11. Nothing has been built for this cycle: this is a genuine first attempt.
  if (!packPresent) {
    return {
      ...base,
      decision: "admit",
      reason: "No pack exists for this attendance cycle.",
      recovery_action: null,
      pointers_complete: false,
      missing_pointers: missing,
      builds_allowed: true,
    };
  }

  // 12. A pack exists but is incomplete. Rebuilding could cut a new docket
  //     revision over a bound live invoice and invalidate a Docs Ready
  //     signoff, so this is a hold with the missing pointers named, never an
  //     automatic rebuild.
  return {
    ...base,
    decision: "hold_divergent_pack",
    // Step 8 already returned for every explained pack, so anything reaching
    // here is by construction a pack no ledger run accounts for.
    join_run_id: null,
    pointers_complete: false,
    missing_pointers: missing,
    pack_built_outside_ledger: builtOutsideLedger,
    reason: builtOutsideLedger
      ? `A partly built pack already exists for this cycle, committed by ${pack.docket_actor_identity || "another door"} outside this ledger, and it is still missing ${missing.join(", ")}.`
      : `The pack for this cycle is still missing ${missing.join(", ")}.`,
    recovery_action: pack.invoice?.xero_invoice_id
      ? `Nothing was rebuilt: invoice ${pack.invoice.number || pack.invoice.xero_invoice_id} (${pack.invoice.status || "unknown status"}) is already bound to this card. Complete the missing documents through the existing Build Pack doors, then re-file this attempt.`
      : "Nothing was rebuilt. Complete the missing documents through the existing Build Pack doors, then re-file this attempt.",
  };
}

/**
 * Projection of an admission for a ledger `result` column and for the runtime
 * reader. Deliberately small: coordinates and the operator's words, never a
 * request body, a recipient or a secret.
 */
export function sesPackBuildAdmissionReceipt(
  admission: SesPackBuildAdmission,
): Record<string, unknown> {
  return {
    version: admission.version,
    decision: admission.decision,
    reason: admission.reason,
    recovery_action: admission.recovery_action,
    attempt_key: admission.attempt_key,
    join_run_id: admission.join_run_id,
    adopt_docket_revision_id: admission.adopt_docket_revision_id,
    adopt_output_content_hash: admission.adopt_output_content_hash,
    pointers_complete: admission.pointers_complete,
    missing_pointers: admission.missing_pointers,
    pack_built_outside_ledger: admission.pack_built_outside_ledger,
    builds_allowed: admission.builds_allowed,
  };
}

/**
 * Map an admission onto the EXISTING ledger states. This slice deliberately
 * adds no new state and owns no migration: `reuse` is a real completion of the
 * attempt (the documents exist and are bound), every hold is the existing
 * `refused_gate`, staleness is `refused_stale`, and a pack another door built
 * is `refused_conflict` — the state the trigger already used for exactly this
 * shape, now reachable from pack truth rather than only from a sibling run.
 */
export function sesPackBuildAdmissionRunState(
  decision: SesPackBuildDecision,
): "done" | "refused_stale" | "refused_conflict" | "refused_gate" | null {
  switch (decision) {
    case "admit":
    case "join":
      return null;
    case "reuse":
      return "done";
    case "hold_stale_cycle":
      return "refused_stale";
    case "hold_divergent_pack":
    case "hold_already_built":
      return "refused_conflict";
    case "hold_pack_sent":
    case "hold_no_cycle":
    case "hold_requirements_unresolved":
    case "refuse_cross_job":
    case "refuse_cross_tenant":
      return "refused_gate";
  }
}

/**
 * Project the ONE shared pack read onto exactly what this gate reads.
 *
 * Kept as a pure projection (not a reader) so the gate never acquires its own
 * database path and can never disagree with `inspect_ses_pack` about a
 * pointer, a docket coordinate or an invoice status. The caller supplies the
 * inspection; `index.ts` owns the single call site.
 */
export function sesPackTruthFromInspection(
  // Structurally the `SesPackInspection` fields this gate reads. Typed
  // loosely on purpose so this module does not import the cockpit read
  // surface, which would drag a database dependency into a pure decision.
  inspection: {
    job_id: string;
    required_documents_resolved: boolean;
    required_documents:
      | { report?: boolean; invoice?: boolean; swms?: boolean }
      | null;
    pack: {
      exists: boolean;
      status: string | null;
      report_doc_id: string | null;
      invoice_doc_id: string | null;
      swms_doc_id: string | null;
      sent_at: string | null;
      send_started_at: string | null;
    };
    docket?: {
      docket_revision_id?: string | null;
      output_content_hash?: string | null;
    } | null;
    review?: { actor_identity?: string | null } | null;
    invoice?: {
      xero_invoice_id?: string | null;
      number?: string | null;
      status?: string | null;
    } | null;
  },
  orgId?: string | null,
): SesPackBuildPackTruth {
  const owed = inspection.required_documents;
  return {
    job_id: inspection.job_id,
    org_id: orgId ?? null,
    required_documents_resolved: inspection.required_documents_resolved === true,
    // An unresolved map stays null. Never defaulted to "nothing is owed":
    // that would let an unknown family reuse an empty pack as complete.
    required_documents: inspection.required_documents_resolved && owed
      ? {
        report: owed.report === true,
        invoice: owed.invoice === true,
        swms: owed.swms === true,
      }
      : null,
    pack: {
      exists: inspection.pack.exists === true,
      status: inspection.pack.status ?? null,
      report_doc_id: inspection.pack.report_doc_id ?? null,
      invoice_doc_id: inspection.pack.invoice_doc_id ?? null,
      swms_doc_id: inspection.pack.swms_doc_id ?? null,
      sent_at: inspection.pack.sent_at ?? null,
      send_started_at: inspection.pack.send_started_at ?? null,
    },
    docket: inspection.docket
      ? {
        docket_revision_id: inspection.docket.docket_revision_id ?? null,
        output_content_hash: inspection.docket.output_content_hash ?? null,
      }
      : null,
    docket_actor_identity: inspection.review?.actor_identity ?? null,
    invoice: inspection.invoice
      ? {
        xero_invoice_id: inspection.invoice.xero_invoice_id ?? null,
        number: inspection.invoice.number ?? null,
        status: inspection.invoice.status ?? null,
      }
      : null,
  };
}
