/**
 * `confirm_roof_report_done` — the trade side of the captain's 2026-08-02
 * portal-producer ruling.
 *
 * One question, one tick. The request body carries a job id and NOTHING else
 * that shapes the record: role, portal URL, builder reference, attendance cycle
 * and timestamp are all server-derived from the card
 * (`ses_trade_portal_confirmation.ts`). The trade is never asked to classify
 * the job.
 *
 * What it writes: one row on the append-only
 * `makesafe_portal_capture_revisions` ledger, under the second approved
 * producer, through the SAME `commit_makesafe_portal_capture_v1` RPC the
 * deterministic Prime reader uses.
 *
 * What it does NOT write: `canonical_stage`, `makesafe_job_details.substatus`,
 * `jobs.status`, any invoice, any send. It is not an invoice action and never
 * touches the sealed SES money mirror.
 */

import { projectMakesafePortalCaptures } from "./makesafe_board_read_model.ts";
import {
  SES_TRADE_PORTAL_CONFIRMATION_PRODUCER,
  SES_TRADE_PORTAL_CONFIRMATION_QUESTION,
  SES_TRADE_PORTAL_CONFIRMATION_ROLE,
  type SesPortalCaptureRevisionContent,
  sesPortalCaptureRevisionHash,
  type SesTradePortalConfirmationAttestation,
  sesTradePortalConfirmationAttestationHash,
  sesTradePortalConfirmationIdempotencyKey,
} from "./ses_portal_capture_contract.ts";
import {
  isSesConfirmingTradeAssignment,
  type SesRoofConfirmationEligibility,
  sesRoofConfirmationEligibility,
} from "./ses_trade_portal_confirmation.ts";

export class SesRoofConfirmationError extends Error {
  status: number;
  code: string;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "SesRoofConfirmationError";
    this.status = status;
    this.code = code;
  }
}

const DETAIL_COLUMNS =
  "job_id, report_type, external_ref, external_links, attendance_cycle_id, " +
  "cycle_number, portal_verified_at, portal_verified_cycle, " +
  "portal_verified_signal, portal_captures, portal_evidence";

const LEDGER_COLUMNS =
  "id, job_id, attendance_cycle_id, role, status, makesafe_fact_version, " +
  "capture_result, source_url, source_content_hash, builder_reference, " +
  "captured_at, captured_by, capture_producer, capture_idempotency_key, " +
  "signal, screenshot_object_key, screenshot_media_type, " +
  "screenshot_content_hash, screenshot_size_bytes";

/**
 * Field-facing refusal text. A trade who cannot tick must be told something
 * true and actionable, not a reason code.
 */
const REASON_MESSAGE: Record<string, string> = {
  not_a_roof_card:
    "This card is not a roof report job, so there is no roof report to confirm.",
  no_portal_roof_link:
    "This card has no builder roof report link yet — ask the office to chase the builder for it.",
  ambiguous_portal_roof_link:
    "This card carries more than one roof report link, so the office has to say which one counts.",
  no_attendance_cycle:
    "This card has no current attendance cycle, so a confirmation cannot be tied to a visit.",
  no_builder_reference:
    "This card has no builder reference, so a confirmation cannot be tied to the builder's job.",
  card_not_live: "This card is closed, so it no longer takes a confirmation.",
};

export interface SesRoofConfirmationResult {
  success: true;
  job_id: string;
  already_confirmed: boolean;
  question: string;
  role: typeof SES_TRADE_PORTAL_CONFIRMATION_ROLE;
  attendance_cycle_id: string;
  cycle_number: number;
  producer: typeof SES_TRADE_PORTAL_CONFIRMATION_PRODUCER;
  confirmed_by: string;
  confirmed_at: string | null;
  revision_id: string | null;
  /** Stated so no caller ever reads this as a board move. */
  stage_written: false;
}

// deno-lint-ignore no-explicit-any
type Client = any;

async function loadLedgerRows(
  client: Client,
  jobId: string,
): Promise<Record<string, unknown>[]> {
  const { data, error } = await client
    .from("makesafe_portal_capture_revisions")
    .select(LEDGER_COLUMNS)
    .eq("job_id", jobId)
    .order("makesafe_fact_version", { ascending: false });
  if (error) {
    throw new SesRoofConfirmationError(
      "ses_roof_confirmation_read_failed",
      `portal capture ledger read failed: ${error.message || error}`,
      500,
    );
  }
  return (data || []) as Record<string, unknown>[];
}

function existingTradeConfirmation(
  rows: Record<string, unknown>[],
  attendanceCycleId: string,
): Record<string, unknown> | null {
  return rows.find((row) =>
    String(row?.job_id ?? "") !== "" &&
    String(row?.attendance_cycle_id ?? "") === attendanceCycleId &&
    String(row?.role ?? "") === SES_TRADE_PORTAL_CONFIRMATION_ROLE &&
    row?.capture_producer === SES_TRADE_PORTAL_CONFIRMATION_PRODUCER &&
    String(row?.capture_result ?? "") === "done"
  ) || null;
}

function confirmationResult(args: {
  jobId: string;
  eligibility: SesRoofConfirmationEligibility;
  alreadyConfirmed: boolean;
  row: Record<string, unknown> | null;
  confirmedBy: string;
  confirmedAt: string | null;
}): SesRoofConfirmationResult {
  const target = args.eligibility.target!;
  return {
    success: true,
    job_id: args.jobId,
    already_confirmed: args.alreadyConfirmed,
    question: SES_TRADE_PORTAL_CONFIRMATION_QUESTION,
    role: SES_TRADE_PORTAL_CONFIRMATION_ROLE,
    attendance_cycle_id: target.attendance_cycle_id,
    cycle_number: target.cycle_number,
    producer: SES_TRADE_PORTAL_CONFIRMATION_PRODUCER,
    confirmed_by: String(args.row?.captured_by ?? args.confirmedBy),
    confirmed_at: (args.row?.captured_at as string | undefined) ??
      args.confirmedAt,
    revision_id: (args.row?.id as string | undefined) ?? null,
    stage_written: false,
  };
}

export async function confirmSesRoofReportDone(
  client: Client,
  args: {
    // deno-lint-ignore no-explicit-any
    body: any;
    callerUserId?: string | null;
    nowIso?: string;
  },
): Promise<SesRoofConfirmationResult> {
  const jobId = String(args.body?.job_id ?? args.body?.jobId ?? "").trim();
  if (!jobId) {
    throw new SesRoofConfirmationError(
      "ses_roof_confirmation_invalid",
      "job_id required",
    );
  }
  const callerUserId = String(args.callerUserId ?? "").trim();
  if (!callerUserId) {
    throw new SesRoofConfirmationError(
      "ses_roof_confirmation_unauthenticated",
      "Login required",
      401,
    );
  }

  const { data: job, error: jobError } = await client
    .from("jobs")
    .select("id, type, status, job_number, metadata")
    .eq("id", jobId)
    .maybeSingle();
  if (jobError) {
    throw new SesRoofConfirmationError(
      "ses_roof_confirmation_read_failed",
      `job read failed: ${jobError.message || jobError}`,
      500,
    );
  }
  if (!job) {
    throw new SesRoofConfirmationError(
      "ses_roof_confirmation_not_found",
      "job not found",
      404,
    );
  }

  // AUTHORIZATION FIRST, before any card fact is resolved or returned. "Any
  // trade that's on the job" means a real, non-cancelled assignment on THIS
  // job. Being an admin is explicitly not a qualification for this channel —
  // the ruling names the trade who did the work.
  const { data: assignments, error: assignmentError } = await client
    .from("job_assignments")
    .select("id, status")
    .eq("job_id", jobId)
    .eq("user_id", callerUserId);
  if (assignmentError) {
    throw new SesRoofConfirmationError(
      "ses_roof_confirmation_read_failed",
      `assignment read failed: ${assignmentError.message || assignmentError}`,
      500,
    );
  }
  if (!(assignments || []).some(isSesConfirmingTradeAssignment)) {
    throw new SesRoofConfirmationError(
      "ses_roof_confirmation_forbidden",
      "Only a trade assigned to this job can confirm its roof report.",
      403,
    );
  }

  const { data: detail, error: detailError } = await client
    .from("makesafe_job_details")
    .select(DETAIL_COLUMNS)
    .eq("job_id", jobId)
    .maybeSingle();
  if (detailError) {
    throw new SesRoofConfirmationError(
      "ses_roof_confirmation_read_failed",
      `make-safe detail read failed: ${detailError.message || detailError}`,
      500,
    );
  }

  const card = {
    id: String(job.id),
    status: job.status,
    metadata: job.metadata || {},
    external_ref: job.metadata?.external_ref ?? null,
    makesafe_details: detail || null,
  };
  const ledgerRows = await loadLedgerRows(client, jobId);
  const captures = projectMakesafePortalCaptures(card, ledgerRows);
  const eligibility = sesRoofConfirmationEligibility(card, captures);

  if (!eligibility.applicable) {
    throw new SesRoofConfirmationError(
      `ses_roof_confirmation_${eligibility.reason}`,
      REASON_MESSAGE[eligibility.reason] ||
        "This card cannot take a roof report confirmation.",
      409,
    );
  }
  const target = eligibility.target!;

  // Idempotence, part 1: completion already recorded for this cycle — by this
  // trade, another trade, or the deterministic reader. A second tick is a
  // no-op, and it answers the trade the same way the first one did.
  if (eligibility.confirmed) {
    return confirmationResult({
      jobId,
      eligibility,
      alreadyConfirmed: true,
      row: existingTradeConfirmation(ledgerRows, target.attendance_cycle_id),
      confirmedBy: callerUserId,
      confirmedAt: null,
    });
  }

  const confirmedAt = args.nowIso || new Date().toISOString();
  const attestation: SesTradePortalConfirmationAttestation = {
    job_id: target.job_id,
    attendance_cycle_id: target.attendance_cycle_id,
    role: target.role,
    source_url: target.source_url,
    builder_reference: target.builder_reference,
    confirmed_by_user_id: callerUserId,
    confirmed_at: confirmedAt,
    question: SES_TRADE_PORTAL_CONFIRMATION_QUESTION,
    answer: "yes",
  };
  const attestationHash = await sesTradePortalConfirmationAttestationHash(
    attestation,
  );
  const content: SesPortalCaptureRevisionContent = {
    job_id: target.job_id,
    attendance_cycle_id: target.attendance_cycle_id,
    role: target.role,
    capture_result: "done",
    source_url: target.source_url,
    source_content_hash: attestationHash,
    builder_reference: target.builder_reference,
    captured_at: confirmedAt,
    captured_by: callerUserId,
    capture_producer: SES_TRADE_PORTAL_CONFIRMATION_PRODUCER,
    capture_idempotency_key: sesTradePortalConfirmationIdempotencyKey(
      target.attendance_cycle_id,
    ),
    signal:
      `Trade confirmed the builder roof report is complete on the portal link ` +
      `("${SES_TRADE_PORTAL_CONFIRMATION_QUESTION}" answered yes).`,
    screenshot_object_key: null,
    screenshot_media_type: null,
    screenshot_content_hash: null,
    screenshot_size_bytes: null,
  };
  const makesafeContentHash = await sesPortalCaptureRevisionHash(content);

  const committed = await client.rpc("commit_makesafe_portal_capture_v1", {
    p_capture: {
      ...content,
      status: "verified",
      makesafe_content_hash: makesafeContentHash,
      evidence_refs: [{
        kind: "trade_portal_confirmation",
        url: target.source_url,
        content_hash: attestationHash,
        confirmed_by_user_id: callerUserId,
        question: SES_TRADE_PORTAL_CONFIRMATION_QUESTION,
      }],
      created_by: callerUserId,
    },
  });

  if (committed.error) {
    // Idempotence, part 2: two trades ticking at once. The RPC serialises them
    // on its advisory lock and raises 23505 for the loser, whose content hash
    // differs only in who answered and when. That is still one confirmation,
    // so re-read and answer with the winner's row rather than an error.
    const raced = await loadLedgerRows(client, jobId);
    const existing = existingTradeConfirmation(
      raced,
      target.attendance_cycle_id,
    );
    if (existing) {
      return confirmationResult({
        jobId,
        eligibility,
        alreadyConfirmed: true,
        row: existing,
        confirmedBy: callerUserId,
        confirmedAt: null,
      });
    }
    throw new SesRoofConfirmationError(
      "ses_roof_confirmation_commit_failed",
      committed.error.message || "roof report confirmation could not be saved.",
      409,
    );
  }
  const row = (committed.data || null) as Record<string, unknown> | null;

  // Additive audit only. No board consumer selects this event type, and it
  // carries no stage, substatus or status field.
  try {
    await client.from("job_events").insert({
      job_id: jobId,
      user_id: callerUserId,
      event_type: "makesafe_roof_report_trade_confirmed",
      detail_json: {
        producer: SES_TRADE_PORTAL_CONFIRMATION_PRODUCER,
        role: target.role,
        attendance_cycle_id: target.attendance_cycle_id,
        cycle_number: target.cycle_number,
        revision_id: row?.id ?? null,
        source_content_hash: attestationHash,
      },
    });
  } catch (error) {
    console.error(
      "[ops-api] roof confirmation audit event failed:",
      (error as Error).message,
    );
  }

  return confirmationResult({
    jobId,
    eligibility,
    alreadyConfirmed: false,
    row,
    confirmedBy: callerUserId,
    confirmedAt,
  });
}
