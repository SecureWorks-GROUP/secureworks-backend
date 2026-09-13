// deno-lint-ignore-file no-explicit-any
/**
 * The two Operations doors onto the SES pack-build attempt (CIO, 2026-09-13).
 *
 * Backlog `ses-workflow-completion-20260913` asks for three things for
 * Operations: a scoped "How it works" definition, a RUNTIME READER, and a
 * TRIGGER/RUN-STATE CONTRACT. The definition is
 * `docs/ses-pack-build-workflow-v1.md`. These are the other two.
 *
 *   - `ses_pack_build_state` (GET) is the reader. One card in, the whole
 *     attempt picture out: the current cycle, the pack pointers, every run on
 *     the card, what the admission gate would decide right now, and the drain's
 *     own observed state. Read-only. It writes nothing, not even a run row.
 *
 *   - `request_ses_pack_build` (POST) is the UI Refresh door. It ASSESSES and
 *     QUEUES the permitted work and reports progress. It is deliberately NOT a
 *     builder: it files or joins exactly one run and returns, leaving the build
 *     to the same privileged `run_ses_report_trigger` handler the drain uses.
 *     So Refresh shares the eligibility, the source version, the claim/lease,
 *     the idempotency key, the receipt and the document binding with every
 *     other surface, because it reaches all of them through the same one run.
 *
 * Neither door sends anything. `mail_sent` is a literal `false` on the Refresh
 * response, because the one thing a Refresh button must never imply is that
 * the builder has been emailed.
 *
 * There is no second overlay here: both doors consume `inspect_ses_pack` for
 * pack truth, `ses_pack_build_admission.ts` for the decision, and
 * `ses_report_trigger_runs` for attempt state. They own no schema.
 */

import {
  admitSesPackBuild,
  sesPackBuildAdmissionReceipt,
  sesPackBuildAttemptKey,
  SES_PACK_BUILD_ADMISSION_VERSION,
  type SesPackBuildAdmission,
  type SesPackBuildPackTruth,
  type SesPackBuildSiblingRun,
} from "./ses_pack_build_admission.ts";

export const SES_PACK_BUILD_DOORS_VERSION = "ses.pack-build-doors/v1";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class SesPackBuildDoorError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export interface SesPackBuildDoorDeps {
  client: any;
  orgId: string;
  /** The ONE shared pack read, already projected. `null` means unreadable. */
  readPackTruth: (jobId: string) => Promise<SesPackBuildPackTruth | null>;
  /** The drain's observed state, for the reader's run-state contract. */
  readDrainState?: (client: any) => Promise<unknown>;
  now?: () => Date;
}

interface CardReads {
  job: { id: string; job_number: string | null; status: string | null };
  cycle: { id: string; cycle_number: number | null } | null;
  runs: SesPackBuildRunRow[];
  pack: SesPackBuildPackTruth | null;
  pack_read_failed: boolean;
}

export interface SesPackBuildRunRow extends SesPackBuildSiblingRun {
  event_type: string;
  source: Record<string, unknown>;
  attempts: number;
  duplicate_events: number;
  next_attempt_at: string | null;
  claimed_by: string | null;
  last_error: string | null;
  recovery_action: string | null;
  output_content_hash: string | null;
  created_at: string;
  completed_at: string | null;
  result: Record<string, unknown> | null;
}

const RUN_COLUMNS =
  "id, dedupe_key, job_id, attendance_cycle_id, cycle_number, event_type, source, state, attempts, " +
  "duplicate_events, next_attempt_at, claimed_by, lease_expires_at, last_error, recovery_action, " +
  "docket_revision_id, output_content_hash, result, created_at, completed_at";

async function readCard(
  jobId: string,
  deps: SesPackBuildDoorDeps,
): Promise<CardReads> {
  const { client } = deps;
  const job = await client.from("jobs")
    .select("id, job_number, status").eq("id", jobId).maybeSingle();
  if (job.error) {
    throw new SesPackBuildDoorError(
      "ses_pack_build_job_unreadable",
      `The job could not be read: ${job.error.message || job.error}`,
      503,
    );
  }
  if (!job.data) {
    throw new SesPackBuildDoorError(
      "ses_pack_build_job_missing",
      "No such job.",
      404,
    );
  }

  const cycle = await client.from("makesafe_attendance_cycles")
    .select("id, cycle_number").eq("job_id", jobId)
    .order("cycle_number", { ascending: false }).limit(1).maybeSingle();
  if (cycle.error) {
    throw new SesPackBuildDoorError(
      "ses_pack_build_cycle_unreadable",
      `The attendance cycle could not be read: ${
        cycle.error.message || cycle.error
      }`,
      503,
    );
  }

  const runs = await client.from("ses_report_trigger_runs")
    .select(RUN_COLUMNS).eq("job_id", jobId)
    .order("created_at", { ascending: true }).limit(100);
  if (runs.error) {
    throw new SesPackBuildDoorError(
      "ses_pack_build_ledger_unavailable",
      `The attempt ledger could not be read: ${
        runs.error.message || runs.error
      }`,
      503,
    );
  }

  // A pack read fault must be reported as a fault, never as "no pack". The
  // gate fails closed on null; the reader says so out loud.
  let pack: SesPackBuildPackTruth | null = null;
  let packReadFailed = false;
  try {
    pack = await deps.readPackTruth(jobId);
    if (!pack) packReadFailed = true;
  } catch (_error) {
    pack = null;
    packReadFailed = true;
  }

  return {
    job: job.data,
    cycle: (cycle.data as { id: string; cycle_number: number | null }) ?? null,
    runs: (runs.data as SesPackBuildRunRow[]) || [],
    pack,
    pack_read_failed: packReadFailed,
  };
}

/** The live attempt on this cycle, if there is one, oldest first. */
function openRunForCycle(
  runs: SesPackBuildRunRow[],
  cycleId: string | null,
): SesPackBuildRunRow | null {
  const open = new Set(["pending", "claimed", "failed"]);
  return runs.find((run) =>
    open.has(run.state) &&
    (!cycleId || !run.attendance_cycle_id || run.attendance_cycle_id === cycleId)
  ) ?? null;
}

function doneRunForCycle(
  runs: SesPackBuildRunRow[],
  cycleId: string | null,
): SesPackBuildRunRow | null {
  return runs.find((run) =>
    run.state === "done" &&
    (!cycleId || !run.attendance_cycle_id || run.attendance_cycle_id === cycleId)
  ) ?? null;
}

function projectRun(run: SesPackBuildRunRow, now: Date) {
  return {
    id: run.id,
    dedupe_key: run.dedupe_key,
    attendance_cycle_id: run.attendance_cycle_id,
    event_type: run.event_type,
    source: run.source,
    state: run.state,
    attempts: run.attempts,
    duplicate_events: run.duplicate_events,
    age_seconds: Math.max(
      0,
      Math.round((now.getTime() - Date.parse(run.created_at)) / 1000),
    ),
    claimed_by: run.claimed_by,
    lease_expires_at: run.lease_expires_at,
    next_attempt_at: run.next_attempt_at,
    last_error: run.last_error,
    recovery_action: run.recovery_action,
    docket_revision_id: run.docket_revision_id,
    output_content_hash: run.output_content_hash,
    admission: (run.result as any)?.admission ?? null,
    completed_at: run.completed_at,
  };
}

function admissionFor(
  card: CardReads,
  sourceIdentity: string,
  orgId: string,
  now: Date,
  excludeRunId?: string | null,
): SesPackBuildAdmission {
  return admitSesPackBuild({
    requested: {
      job_id: card.job.id,
      attendance_cycle_id: card.cycle?.id ?? null,
      source_identity: sourceIdentity,
      org_id: orgId,
    },
    current_cycle: card.cycle
      ? { id: card.cycle.id, cycle_number: card.cycle.cycle_number }
      : null,
    pack: card.pack,
    sibling_runs: card.runs.filter((run) => run.id !== excludeRunId),
    now,
  });
}

/**
 * THE RUNTIME READER. One card in, the whole attempt picture out.
 *
 * Deliberately read-only and deliberately honest about its own blind spots:
 * `pack_read_failed` distinguishes "this card has no pack" from "the pack
 * could not be read", and the drain block carries its own errors so an empty
 * cron answer is never silently read as "not scheduled".
 */
export async function readSesPackBuildState(
  params: URLSearchParams,
  deps: SesPackBuildDoorDeps,
): Promise<Record<string, unknown>> {
  const now = (deps.now ?? (() => new Date()))();
  const jobId = String(params.get("job_id") || "").trim();
  if (!UUID.test(jobId)) {
    throw new SesPackBuildDoorError(
      "ses_pack_build_job_id_required",
      "job_id must be an exact job UUID.",
    );
  }
  const card = await readCard(jobId, deps);
  const open = openRunForCycle(card.runs, card.cycle?.id ?? null);
  const done = doneRunForCycle(card.runs, card.cycle?.id ?? null);

  // The hypothetical: what would a fresh Refresh decide right now. The open
  // run, if any, is excluded so the answer is not simply "join yourself".
  const admission = admissionFor(
    card,
    open?.dedupe_key ?? sesPackBuildAttemptKey(
      jobId,
      card.cycle?.id ?? null,
      "ui_refresh",
    ),
    deps.orgId,
    now,
    open?.id ?? null,
  );

  const drain = deps.readDrainState
    ? await deps.readDrainState(deps.client)
    : null;

  return {
    version: SES_PACK_BUILD_DOORS_VERSION,
    admission_version: SES_PACK_BUILD_ADMISSION_VERSION,
    ok: true,
    retrieved_at: now.toISOString(),
    job: {
      id: card.job.id,
      job_number: card.job.job_number,
      status: card.job.status,
    },
    current_attendance_cycle: card.cycle,
    pack: card.pack
      ? {
        exists: card.pack.pack.exists,
        status: card.pack.pack.status,
        report_doc_id: card.pack.pack.report_doc_id,
        invoice_doc_id: card.pack.pack.invoice_doc_id,
        swms_doc_id: card.pack.pack.swms_doc_id,
        sent_at: card.pack.pack.sent_at,
        required_documents: card.pack.required_documents,
        required_documents_resolved: card.pack.required_documents_resolved,
        docket_revision_id: card.pack.docket?.docket_revision_id ?? null,
        output_content_hash: card.pack.docket?.output_content_hash ?? null,
        prepared_by: card.pack.docket_actor_identity,
        invoice: card.pack.invoice,
      }
      : null,
    pack_read_failed: card.pack_read_failed,
    attempt: {
      open_run_id: open?.id ?? null,
      completed_run_id: done?.id ?? null,
      would_decide: sesPackBuildAdmissionReceipt(admission),
    },
    runs: card.runs.map((run) => projectRun(run, now)),
    drain,
    docs_ready_is_not_sent:
      "Docs Ready means the documents exist and are bound. It never means the builder has been emailed; that is a separate approved release.",
    contract: "docs/ses-pack-build-workflow-v1.md",
  };
}

export interface SesPackBuildRequestResult extends Record<string, unknown> {
  mail_sent: false;
}

/**
 * THE REFRESH DOOR. Assess, queue the permitted work, report progress.
 *
 * What it will NOT do, all structurally rather than by convention: it never
 * calls `prepare`, never touches Xero, never dispatches mail, and never claims
 * a run. It files or joins exactly one attempt and hands back its id. The
 * privileged `run_ses_report_trigger` handler remains the only thing that
 * builds, so eligibility, source versions, claim/lease, receipt and document
 * binding cannot diverge between Refresh and the interval: they are the same
 * run, executed by the same handler.
 */
export async function requestSesPackBuild(
  body: Record<string, unknown>,
  deps: SesPackBuildDoorDeps & { requestedBy: string },
): Promise<SesPackBuildRequestResult> {
  const now = (deps.now ?? (() => new Date()))();
  const jobId = String(body.job_id || "").trim();
  if (!UUID.test(jobId)) {
    throw new SesPackBuildDoorError(
      "ses_pack_build_job_id_required",
      "job_id must be an exact job UUID.",
    );
  }
  const card = await readCard(jobId, deps);

  const queuedNothing = (
    admission: SesPackBuildAdmission,
    runId: string | null,
    progress: string,
  ): SesPackBuildRequestResult => ({
    version: SES_PACK_BUILD_DOORS_VERSION,
    ok: admission.decision === "reuse" || admission.decision === "join",
    queued: false,
    run_id: runId,
    progress,
    admission: sesPackBuildAdmissionReceipt(admission),
    mail_sent: false,
    note:
      "Refresh assesses and queues the pack build. It never sends anything to the builder.",
  });

  // Already open on this cycle: this IS the one attempt. Join it.
  const open = openRunForCycle(card.runs, card.cycle?.id ?? null);
  if (open) {
    const admission = admissionFor(
      card,
      open.dedupe_key,
      deps.orgId,
      now,
      open.id,
    );
    return {
      version: SES_PACK_BUILD_DOORS_VERSION,
      ok: true,
      queued: true,
      joined_existing: true,
      run_id: open.id,
      progress: `An attempt is already open on this card (state ${open.state}, attempt ${open.attempts}). This request joined it; no second attempt was filed.`,
      admission: sesPackBuildAdmissionReceipt(admission),
      run: projectRun(open, now),
      mail_sent: false,
      note:
        "Refresh assesses and queues the pack build. It never sends anything to the builder.",
    };
  }

  const identity = `ui_refresh:${card.cycle?.id ?? "cycle?"}`;
  const admission = admissionFor(card, identity, deps.orgId, now, null);

  if (admission.decision === "reuse") {
    const done = doneRunForCycle(card.runs, card.cycle?.id ?? null);
    return queuedNothing(
      admission,
      done?.id ?? null,
      "The pack for this cycle is already complete. Nothing was queued and nothing was rebuilt.",
    );
  }
  if (admission.decision !== "admit") {
    // An honest hold. Queue nothing: the recovery action is the operator's
    // next step, and filing a run that is guaranteed to refuse would just
    // spend the dedupe key and hide the real answer behind a ledger row.
    return queuedNothing(
      admission,
      null,
      admission.recovery_action ?? admission.reason,
    );
  }

  const attemptKey = sesPackBuildAttemptKey(jobId, card.cycle?.id ?? null, identity);
  // Idempotent file. The UNIQUE dedupe key is the guard: a double-click, two
  // operators, or a retry after a dropped response all converge on one row.
  const inserted = await deps.client.from("ses_report_trigger_runs").insert({
    dedupe_key: attemptKey,
    job_id: jobId,
    attendance_cycle_id: card.cycle?.id ?? null,
    cycle_number: card.cycle?.cycle_number ?? null,
    event_type: "manual",
    source: {
      kind: "ui_refresh",
      identity,
      requested_by: deps.requestedBy,
      requested_at: now.toISOString(),
    },
    state: "pending",
  }).select(RUN_COLUMNS).maybeSingle();

  if (inserted.error) {
    const existing = await deps.client.from("ses_report_trigger_runs")
      .select(RUN_COLUMNS).eq("dedupe_key", attemptKey).maybeSingle();
    if (existing.data) {
      return {
        version: SES_PACK_BUILD_DOORS_VERSION,
        ok: true,
        queued: true,
        joined_existing: true,
        run_id: existing.data.id,
        progress:
          "This exact attempt was already queued; this request joined it rather than filing a second one.",
        admission: sesPackBuildAdmissionReceipt(admission),
        run: projectRun(existing.data as SesPackBuildRunRow, now),
        mail_sent: false,
        note:
          "Refresh assesses and queues the pack build. It never sends anything to the builder.",
      };
    }
    throw new SesPackBuildDoorError(
      "ses_pack_build_ledger_unavailable",
      `The attempt could not be filed: ${
        inserted.error.message || inserted.error
      }`,
      503,
    );
  }

  return {
    version: SES_PACK_BUILD_DOORS_VERSION,
    ok: true,
    queued: true,
    joined_existing: false,
    run_id: inserted.data?.id ?? null,
    progress:
      "One pack-build attempt was queued for this card. It is built by the same handler the interval uses; watch this run for progress.",
    admission: sesPackBuildAdmissionReceipt(admission),
    run: inserted.data
      ? projectRun(inserted.data as SesPackBuildRunRow, now)
      : null,
    mail_sent: false,
    note:
      "Refresh assesses and queues the pack build. It never sends anything to the builder.",
  };
}

/**
 * Receipt for the DIRECT `prepare_ses_docket_revision` door.
 *
 * That door is reachable by the make-safe reporting routine, the agent seat
 * and any admin/owner session, and until now it filed nothing — which is how
 * AJBR-72221 ended up with a complete pack and a `pending` run that knew
 * nothing about it. This records the attempt that actually happened, in the
 * one ledger, so every surface shares a receipt.
 *
 * Two boundaries are deliberate and must not be "tidied up":
 *
 *  - It RECORDS; it does not gate. The operator or the reporting routine
 *    driving that door is the authority, and silently blocking the Captain's
 *    own cockpit press would be a worse failure than a late receipt. The
 *    admission gate ENFORCES on the trigger path, where refusal is already
 *    the contract.
 *  - It is fail-open and audible. A ledger write must never turn a completed
 *    pack build into an error response, so every failure is caught and logged
 *    under one marker rather than raised.
 *
 * The row lands `done`, because the build genuinely happened. A later trigger
 * run therefore sees an explained pack and answers `reuse`, not
 * `hold_divergent_pack`.
 */
export async function recordDirectPrepareAttempt(
  args: {
    client: any;
    jobId: string;
    attendanceCycleId: string | null;
    idempotencyKey: string;
    actor: string;
    docketRevisionId: string | null;
    outputContentHash: string | null;
    state: string;
    persisted: boolean;
    now?: () => Date;
  },
): Promise<{ recorded: boolean; reason?: string }> {
  const now = (args.now ?? (() => new Date()))();
  if (!UUID.test(String(args.jobId || "").trim())) {
    return { recorded: false, reason: "job_id is not a job UUID" };
  }
  const identity = `direct_prepare:${String(args.idempotencyKey || "").trim()}`;
  const dedupeKey = sesPackBuildAttemptKey(
    args.jobId,
    args.attendanceCycleId,
    identity,
  );
  try {
    const { error } = await args.client.from("ses_report_trigger_runs")
      .upsert({
        dedupe_key: dedupeKey,
        job_id: args.jobId,
        attendance_cycle_id: args.attendanceCycleId,
        event_type: "manual",
        source: {
          kind: "direct_prepare",
          identity,
          prepared_by: args.actor,
          prepared_at: now.toISOString(),
        },
        state: "done",
        docket_revision_id: args.docketRevisionId,
        output_content_hash: args.outputContentHash,
        completed_at: now.toISOString(),
        result: {
          admission: {
            version: SES_PACK_BUILD_ADMISSION_VERSION,
            decision: "recorded_direct_prepare",
            reason:
              "Built through the direct prepare door. Recorded so the one ledger explains this pack.",
            builds_allowed: false,
          },
          prepare_state: args.state,
          persisted: args.persisted,
        },
      }, { onConflict: "dedupe_key", ignoreDuplicates: true });
    if (error) {
      console.error("ses_pack_build_direct_receipt_unwritten", {
        job_id: args.jobId,
        error: String(error.message || error),
      });
      return { recorded: false, reason: String(error.message || error) };
    }
    return { recorded: true };
  } catch (error) {
    console.error("ses_pack_build_direct_receipt_unwritten", {
      job_id: args.jobId,
      error: String((error as Error)?.message || error),
    });
    return {
      recorded: false,
      reason: String((error as Error)?.message || error),
    };
  }
}
