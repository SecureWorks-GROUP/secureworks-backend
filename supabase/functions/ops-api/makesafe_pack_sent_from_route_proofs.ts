// deno-lint-ignore-file no-explicit-any
/**
 * Stamp `makesafe_report_packs.sent_at` / `status='sent'` from confirmed SES
 * release route proofs.
 *
 * WHY
 * ---
 * Legacy `makesafe_send_pack` patches the main pack row to `sent` on closeout.
 * The sealed release graph (`execute_ses_release_revision` →
 * `commit_ses_release_closeout_v1`) writes `release_closeout` terminal proofs
 * and a `MAKESAFE_PACK_SENT | main` note, and stamps `report_sent_at`, but it
 * never updates `makesafe_report_packs`. Cards then sit with
 * `release_send_progress.kind === 'released'`, board `pack.sent=true` (from
 * triage markers), and inspect_ses_pack still showing `pack.status=drafted`
 * / `sent_at=null` — the completed-column display jam (Jolimont SWMS-261289
 * class, 31 cards measured 2026-08-24).
 *
 * This module is the ONE pack-row producer for the sealed path, and the
 * repair door for already-proved releases. It never sends mail, never mints,
 * and never takes a timestamp from a caller — only from route-proof
 * `proven_at`, same as `stampMakesafeReportSentFromRouteProofs`.
 *
 * STAMP GATE (never-sent must not look sent)
 * ------------------------------------------
 * Refuse unless ALL of:
 *   1. release progress kind is exactly `released` (no default),
 *   2. required_route_kinds is a non-empty set (empty never passes),
 *   3. every required kind appears on a proof ROW with parseable proven_at
 *      (caller-asserted proved_route_kinds are ignored),
 *   4. pack is in a stampable unsent status with sent_at null.
 * Repair additionally membership-binds job ↔ release and never selects a
 * non-released revision for a write. Refusing to stamp never blocks SEND IT.
 */

import { earliestReleaseProvenAt } from "./makesafe_report_sent_stamp.ts";

/** Pack statuses that already mean a send happened — leave them alone. */
export const PACK_ALREADY_SENT_STATUSES = [
  "sent",
  "sent_marker_failed",
  "sent_not_closed",
  "close_failed",
] as const;

/** Unsent statuses the stamp / repair may advance to `sent`. */
export const PACK_STAMPABLE_UNSENT_STATUSES = [
  "drafted",
  "draft",
  "needs_review",
  "ready",
  "authorised_not_sent",
  "authorized_not_sent",
  "failed",
] as const;

export class PackSentFromProofsRequestError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "PackSentFromProofsRequestError";
  }
}

export class PackSentFromProofsConflictError extends Error {
  readonly status = 409;
  readonly code: string;
  readonly evidence?: Record<string, unknown>;
  constructor(
    code: string,
    message: string,
    evidence?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "PackSentFromProofsConflictError";
    this.code = code;
    this.evidence = evidence;
  }
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

/**
 * Proved route kinds come ONLY from proof rows with a parseable proven_at.
 * Caller-asserted progress.proved_route_kinds must never enlarge this set.
 */
export function provedRouteKindsFromProofRows(
  proofs: PackSentProofRow[] | null | undefined,
): string[] {
  const kinds = new Set<string>();
  for (const proof of proofs || []) {
    const kind = text(proof?.route_kind);
    if (!kind) continue;
    const raw = proof?.proven_at;
    if (!raw) continue;
    const ms = new Date(String(raw)).getTime();
    if (!Number.isFinite(ms)) continue;
    kinds.add(kind);
  }
  return [...kinds].sort();
}

export interface PackSentProofRow {
  route_kind?: string | null;
  proof_hash?: string | null;
  proven_at?: string | null;
  external_message_id?: string | null;
}

export interface PackSentReleaseProgress {
  kind?: string | null;
  release_revision_id?: string | null;
  required_route_kinds?: string[] | null;
  /**
   * Ignored by the planner. Retained on the type so callers that already
   * publish progress shapes do not break — completeness is proof-row only.
   */
  proved_route_kinds?: string[] | null;
}

export interface PackSentPackRow {
  id?: string | null;
  job_id?: string | null;
  pack_kind?: string | null;
  status?: string | null;
  sent_at?: string | null;
  send_started_at?: string | null;
}

export type PackSentStampOutcomeKind =
  | "stamped"
  | "already_sent"
  | "would_stamp"
  | "no_proof"
  | "pack_missing"
  | "pack_not_stampable"
  | "write_failed";

export interface PackSentStampPlan {
  job_id: string;
  pack_id: string | null;
  pack_kind: string;
  before_status: string | null;
  before_sent_at: string | null;
  proven_at: string | null;
  release_revision_id: string | null;
  proved_route_kinds: string[];
  required_route_kinds: string[];
  stampable: boolean;
  refusal_code: string | null;
}

export interface PackSentStampOutcome extends PackSentStampPlan {
  outcome: PackSentStampOutcomeKind;
  after_status: string | null;
  after_sent_at: string | null;
  detail?: string;
}

const STAMP_PROOF_REFUSALS = new Set([
  "no_proof",
  "required_routes_unproved",
  "required_routes_empty",
  "release_not_released",
  "release_progress_required",
]);

/**
 * Substatus advance is allowed only after a fresh stamp under the hardened
 * gate. `already_sent` returns before proof completeness and must never force
 * `complete`. Dry-run may preview advance only for `would_stamp`.
 */
export function mayAdvanceSubstatusFromPackStamp(outcome: {
  outcome: string;
  dry_run?: boolean;
}): boolean {
  if (outcome.outcome === "stamped") return true;
  if (outcome.dry_run === true && outcome.outcome === "would_stamp") return true;
  return false;
}

/**
 * Pure plan: may we stamp this pack from these proofs / release progress?
 * Never invents a send — every required route must already be proved on a
 * proof row, the release must be `released`, and required must be non-empty.
 */
export function planMakesafePackSentFromRouteProofs(input: {
  job_id: string;
  pack: PackSentPackRow | null | undefined;
  proofs: PackSentProofRow[] | null | undefined;
  release_progress?: PackSentReleaseProgress | null;
  pack_kind?: string;
}): PackSentStampPlan {
  const jobId = text(input.job_id);
  const packKind = text(input.pack_kind) || "main";
  const progress = input.release_progress || null;
  const required = [...new Set(
    (progress?.required_route_kinds || [])
      .map((k) => text(k))
      .filter(Boolean),
  )].sort();
  // Completeness is derived from proof rows only — never from caller progress.
  const proved = provedRouteKindsFromProofRows(input.proofs);
  const releaseRevisionId = text(progress?.release_revision_id) || null;
  const provenAt = earliestReleaseProvenAt(input.proofs);

  const pack = input.pack || null;
  const beforeStatus = pack ? text(pack.status) || null : null;
  const beforeSentAt = pack?.sent_at ? text(pack.sent_at) || null : null;

  const base: PackSentStampPlan = {
    job_id: jobId,
    pack_id: pack?.id ? text(pack.id) : null,
    pack_kind: packKind,
    before_status: beforeStatus,
    before_sent_at: beforeSentAt,
    proven_at: provenAt,
    release_revision_id: releaseRevisionId,
    proved_route_kinds: proved,
    required_route_kinds: required,
    stampable: false,
    refusal_code: null,
  };

  if (!jobId) {
    return { ...base, refusal_code: "job_id_required" };
  }
  if (!pack) {
    return { ...base, refusal_code: "pack_missing" };
  }
  if (
    beforeSentAt ||
    (PACK_ALREADY_SENT_STATUSES as readonly string[]).includes(
      String(beforeStatus || "").toLowerCase(),
    )
  ) {
    return { ...base, refusal_code: "already_sent" };
  }
  if (
    !(PACK_STAMPABLE_UNSENT_STATUSES as readonly string[]).includes(
      String(beforeStatus || "").toLowerCase(),
    )
  ) {
    return { ...base, refusal_code: "pack_not_stampable" };
  }
  if (!provenAt || proved.length === 0) {
    return { ...base, refusal_code: "no_proof" };
  }
  // Empty required never stamps — that path used to skip the release-state
  // gate and let a partial/non-released release look fully sent.
  if (required.length === 0) {
    return { ...base, refusal_code: "required_routes_empty" };
  }
  const missing = required.filter((k) => !proved.includes(k));
  if (missing.length > 0) {
    return { ...base, refusal_code: "required_routes_unproved" };
  }
  // kind === released is unconditional. Missing kind refuses; non-released
  // refuses. Never default kind to released at the stamp entry.
  const kind = text(progress?.kind).toLowerCase();
  if (!kind) {
    return { ...base, refusal_code: "release_progress_required" };
  }
  if (kind !== "released") {
    return { ...base, refusal_code: "release_not_released" };
  }

  return { ...base, stampable: true, refusal_code: null };
}

/**
 * Additive CAS stamp of the main pack row from route proofs.
 * Never overwrites a set sent_at. Never throws on write fault — reports it.
 * Never defaults release kind to "released" or required routes to [].
 */
export async function stampMakesafePackSentFromRouteProofs(
  client: any,
  jobId: string,
  proofs: PackSentProofRow[] | null | undefined,
  ctx: {
    releaseRevisionId?: string | null;
    actor?: string | null;
    releaseProgress?: PackSentReleaseProgress | null;
    packKind?: string;
    dryRun?: boolean;
  } = {},
): Promise<PackSentStampOutcome> {
  const packKind = text(ctx.packKind) || "main";
  const packResp = await client.from("makesafe_report_packs")
    .select("id,job_id,pack_kind,status,sent_at,send_started_at")
    .eq("job_id", jobId)
    .eq("pack_kind", packKind)
    .maybeSingle();
  if (packResp.error) {
    return {
      job_id: jobId,
      pack_id: null,
      pack_kind: packKind,
      before_status: null,
      before_sent_at: null,
      proven_at: earliestReleaseProvenAt(proofs),
      release_revision_id: text(ctx.releaseRevisionId) || null,
      proved_route_kinds: [],
      required_route_kinds: [],
      stampable: false,
      refusal_code: "pack_unreadable",
      outcome: "write_failed",
      after_status: null,
      after_sent_at: null,
      detail: String(packResp.error.message || packResp.error),
    };
  }

  // No invented progress: absent kind / required stay absent so the planner
  // refuses rather than defaulting to released + [].
  const releaseProgress: PackSentReleaseProgress = {
    kind: ctx.releaseProgress?.kind ?? null,
    release_revision_id: ctx.releaseRevisionId ??
      ctx.releaseProgress?.release_revision_id ?? null,
    required_route_kinds: ctx.releaseProgress?.required_route_kinds ?? null,
  };

  const plan = planMakesafePackSentFromRouteProofs({
    job_id: jobId,
    pack: packResp.data,
    proofs,
    release_progress: releaseProgress,
    pack_kind: packKind,
  });

  if (plan.refusal_code === "already_sent") {
    return {
      ...plan,
      outcome: "already_sent",
      after_status: plan.before_status,
      after_sent_at: plan.before_sent_at,
    };
  }
  if (plan.refusal_code === "pack_missing") {
    return {
      ...plan,
      outcome: "pack_missing",
      after_status: null,
      after_sent_at: null,
    };
  }
  if (plan.refusal_code && STAMP_PROOF_REFUSALS.has(plan.refusal_code)) {
    return {
      ...plan,
      outcome: "no_proof",
      after_status: plan.before_status,
      after_sent_at: plan.before_sent_at,
    };
  }
  if (!plan.stampable || !plan.proven_at) {
    return {
      ...plan,
      outcome: "pack_not_stampable",
      after_status: plan.before_status,
      after_sent_at: plan.before_sent_at,
    };
  }

  if (ctx.dryRun) {
    return {
      ...plan,
      outcome: "would_stamp",
      after_status: "sent",
      after_sent_at: plan.proven_at,
    };
  }

  try {
    const { data, error } = await client.from("makesafe_report_packs")
      .update({
        status: "sent",
        sent_at: plan.proven_at,
        failed_step: null,
        error_detail: null,
        updated_at: new Date().toISOString(),
      })
      .eq("job_id", jobId)
      .eq("pack_kind", packKind)
      .is("sent_at", null)
      .select("id,status,sent_at");
    if (error) {
      return {
        ...plan,
        outcome: "write_failed",
        after_status: plan.before_status,
        after_sent_at: plan.before_sent_at,
        detail: String(error.message || error),
      };
    }
    if (!Array.isArray(data) || data.length === 0) {
      return {
        ...plan,
        outcome: "already_sent",
        after_status: plan.before_status,
        after_sent_at: plan.before_sent_at,
      };
    }
  } catch (err) {
    return {
      ...plan,
      outcome: "write_failed",
      after_status: plan.before_status,
      after_sent_at: plan.before_sent_at,
      detail: String((err as Error)?.message || err),
    };
  }

  try {
    await client.from("job_events").insert({
      job_id: jobId,
      event_type: "makesafe_pack_sent_at_derived",
      detail_json: {
        field: "makesafe_report_packs.sent_at",
        action: "stamped_from_route_proofs",
        source: "ses_release_route_proofs.proven_at",
        sent_at: plan.proven_at,
        pack_kind: packKind,
        release_revision_id: plan.release_revision_id,
        actor: ctx.actor ?? null,
      },
    });
  } catch (_) { /* non-blocking */ }

  return {
    ...plan,
    outcome: "stamped",
    after_status: "sent",
    after_sent_at: plan.proven_at,
  };
}

/**
 * Repair entry: load the job's released release + proofs, stamp the pack.
 * Dry-run default true. Never redispatches Graph.
 * Always membership-binds job ↔ release; never falls back to a non-released
 * revision for a write.
 */
export async function repairMakesafePackSentFromRouteProofsAction(
  client: any,
  body: Record<string, unknown> | null | undefined,
): Promise<PackSentStampOutcome & { dry_run: boolean }> {
  const dryRun = body?.dry_run !== false;
  let jobId = text(body?.job_id);
  const jobNumber = text(body?.job_number).toUpperCase();
  if (!jobId && jobNumber) {
    const resp = await client.from("jobs").select("id").eq(
      "job_number",
      jobNumber,
    ).maybeSingle();
    if (resp.error) {
      throw new PackSentFromProofsConflictError(
        "job_unreadable",
        `job_number lookup failed: ${resp.error.message}`,
      );
    }
    if (!resp.data?.id) {
      throw new PackSentFromProofsConflictError(
        "job_missing",
        `No job found for job_number ${jobNumber}`,
      );
    }
    jobId = text(resp.data.id);
  }
  if (!jobId) {
    throw new PackSentFromProofsRequestError("job_id or job_number is required");
  }

  const explicitReleaseRevisionId = text(body?.release_revision_id) || null;

  const memberResp = await client.from("makesafe_release_revision_members")
    .select("release_revision_id")
    .eq("job_id", jobId)
    .order("ordinal", { ascending: true });
  if (memberResp.error) {
    throw new PackSentFromProofsConflictError(
      "release_unreadable",
      `release members read failed: ${memberResp.error.message}`,
    );
  }
  const memberReleaseIds = [...new Set(
    (memberResp.data || []).map((r: any) => text(r.release_revision_id))
      .filter(Boolean),
  )];
  if (memberReleaseIds.length === 0) {
    throw new PackSentFromProofsConflictError(
      "release_missing",
      "No SES release revision membership exists for this job.",
    );
  }

  let releaseRevisionId: string | null = null;
  if (explicitReleaseRevisionId) {
    // Foreign release_revision_id must never stamp this job's pack.
    if (!memberReleaseIds.includes(explicitReleaseRevisionId)) {
      throw new PackSentFromProofsConflictError(
        "release_job_mismatch",
        "release_revision_id is not a member release for this job.",
        {
          job_id: jobId,
          release_revision_id: explicitReleaseRevisionId,
        },
      );
    }
    releaseRevisionId = explicitReleaseRevisionId;
  } else {
    const releasesResp = await client.from("makesafe_release_revisions")
      .select("id,state,updated_at")
      .in("id", memberReleaseIds)
      .order("updated_at", { ascending: false });
    if (releasesResp.error) {
      throw new PackSentFromProofsConflictError(
        "release_unreadable",
        `release revisions read failed: ${releasesResp.error.message}`,
      );
    }
    const released = (releasesResp.data || []).find((r: any) =>
      text(r.state).toLowerCase() === "released"
    );
    // Never fall back to a non-released revision for a write.
    releaseRevisionId = text(released?.id) || null;
    if (!releaseRevisionId) {
      throw new PackSentFromProofsConflictError(
        "release_not_released",
        "No released SES release revision exists for this job.",
        { candidate_release_ids: memberReleaseIds },
      );
    }
  }

  const [releaseResp, routesResp, proofsResp] = await Promise.all([
    client.from("makesafe_release_revisions").select("id,state,content_hash")
      .eq("id", releaseRevisionId).maybeSingle(),
    client.from("makesafe_release_revision_routes").select(
      "route_kind,required",
    ).eq("release_revision_id", releaseRevisionId),
    client.from("ses_release_route_proofs").select(
      "route_kind,proof_hash,proven_at,external_message_id",
    ).eq("release_revision_id", releaseRevisionId),
  ]);
  if (releaseResp.error || routesResp.error || proofsResp.error) {
    throw new PackSentFromProofsConflictError(
      "release_unreadable",
      `release/proof read failed: ${
        releaseResp.error?.message || routesResp.error?.message ||
        proofsResp.error?.message
      }`,
    );
  }
  if (!releaseResp.data) {
    throw new PackSentFromProofsConflictError(
      "release_missing",
      "The selected release revision no longer exists.",
      { release_revision_id: releaseRevisionId },
    );
  }

  const required = (routesResp.data || [])
    .filter((r: any) => r.required === true)
    .map((r: any) => text(r.route_kind))
    .filter(Boolean);
  const proofs = proofsResp.data || [];

  const outcome = await stampMakesafePackSentFromRouteProofs(client, jobId, proofs, {
    releaseRevisionId,
    actor: text(body?.actor) || "repair_makesafe_pack_sent_from_route_proofs",
    releaseProgress: {
      kind: text(releaseResp.data.state).toLowerCase() === "released"
        ? "released"
        : text(releaseResp.data.state),
      release_revision_id: releaseRevisionId,
      required_route_kinds: required,
      // proved_route_kinds deliberately omitted — planner reads proof rows.
    },
    dryRun,
  });

  return { ...outcome, dry_run: dryRun };
}
