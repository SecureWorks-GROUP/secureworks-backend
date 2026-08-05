/**
 * SES pack presentation honesty.
 *
 * The operator-facing review surface must not green-tick a refused or
 * incomplete pack, and must not label a genuinely ready U4 docket as the
 * legacy report-pack `failed` state. This module is pure presentation: it
 * never changes board placement, money gates, or send gating.
 *
 * Authority order:
 *   1. Sent close-out (durable send) is terminal presentation.
 *   2. Current U4 docket revision is pack truth when present and not sent.
 *   3. Legacy makesafe_report_packs status is only a fallback when no docket
 *      exists — and a legacy `failed` is an honest refusal, not a green ready.
 *
 * Kinds (do not collapse these):
 *   - ready      — docket proves pre_xero_docs_ready with no blockers
 *   - refused    — system declined on evidence (healthy stop; name why)
 *   - incomplete — still assembling / no pack yet (in progress, not a stop)
 *   - sent       — already out the door
 *   - none       — nothing to present
 */

export type SesPackPresentationKind =
  | "ready"
  | "refused"
  | "incomplete"
  | "sent"
  | "none";

export interface SesPackPresentationBlocker {
  code: string;
  fact: string | null;
  recovery_action: string | null;
  category: "ses_docket" | "legacy_pack" | "review_trust";
}

export interface SesPackPresentation {
  /** Honest operator-facing kind. */
  kind: SesPackPresentationKind;
  /**
   * Value for pack.state / report_pack.status. Never `failed` when a ready
   * docket supersedes a stale legacy pack row. `refused` is an honest stop;
   * it is not a send-pipeline failure.
   */
  state: string;
  /** M1 / docsReady packState input. */
  review_state: "READY" | "U4_BLOCKED" | null;
  pre_xero_docs_ready: boolean;
  docket_revision_id: string | null;
  drafted: boolean;
  /** Short operator-facing reason for refused / incomplete; null when ready/sent/none. */
  reason: string | null;
  blockers: SesPackPresentationBlocker[];
  /** Raw legacy pack status preserved for audit; not presentation authority. */
  legacy_pack_status: string | null;
}

const SENT_STATUSES = new Set([
  "sent",
  "sent_marker_failed",
  "sent_not_closed",
  "close_failed",
]);

function txt(value: unknown): string {
  return String(value ?? "").trim();
}

function lower(value: unknown): string {
  return txt(value).toLowerCase();
}

function blockerCode(raw: Record<string, unknown>): string {
  return txt(raw.code || raw.reason_code || raw.reasonCode);
}

function blockerFact(raw: Record<string, unknown>): string | null {
  const fact = txt(raw.fact || raw.reason || raw.message);
  return fact || null;
}

function blockerRecovery(raw: Record<string, unknown>): string | null {
  const recovery = txt(raw.recovery_action || raw.recoveryAction);
  return recovery || null;
}

export function normalizeSesPackPresentationBlockers(
  raw: unknown,
  category: SesPackPresentationBlocker["category"] = "ses_docket",
): SesPackPresentationBlocker[] {
  if (!Array.isArray(raw)) return [];
  const out: SesPackPresentationBlocker[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const code = blockerCode(row);
    if (!code) continue;
    out.push({
      code,
      fact: blockerFact(row),
      recovery_action: blockerRecovery(row),
      category,
    });
  }
  return out;
}

function firstReason(
  blockers: SesPackPresentationBlocker[],
  fallback: string,
): string {
  for (const blocker of blockers) {
    if (blocker.fact) return blocker.fact;
  }
  if (blockers.length === 1) {
    return `Pack refused: ${blockers[0].code}.`;
  }
  if (blockers.length > 1) {
    return `Pack refused (${blockers.map((b) => b.code).join(", ")}).`;
  }
  return fallback;
}

export function presentSesPackHonesty(input: {
  docket?: {
    id?: string | null;
    state?: string | null;
    pre_xero_docs_ready?: boolean | null;
    blockers?: unknown;
  } | null;
  /**
   * Read-time trust refusals (e.g. curated_source_missing) that are not yet
   * stored on the docket row. These are honest stops, not pipeline failures.
   */
  review_blockers?: unknown;
  legacy_pack?: {
    status?: string | null;
    failed_step?: string | null;
    error_detail?: unknown;
  } | null;
  pack_sent?: boolean | null;
  /** Typed makesafe_report document attached. */
  has_report_doc?: boolean | null;
  /** Trade service report submitted (even if no curated PDF yet). */
  has_trade_report?: boolean | null;
}): SesPackPresentation {
  const legacyStatus = lower(input.legacy_pack?.status);
  const legacyPackStatus = txt(input.legacy_pack?.status) || null;
  const packSent = input.pack_sent === true || SENT_STATUSES.has(legacyStatus);
  const docket = input.docket || null;
  const docketId = docket?.id ? String(docket.id) : null;
  const docketBlockers = normalizeSesPackPresentationBlockers(
    docket?.blockers,
    "ses_docket",
  );
  const reviewBlockers = normalizeSesPackPresentationBlockers(
    input.review_blockers,
    "review_trust",
  );
  const allBlockers = [...docketBlockers, ...reviewBlockers];
  const preXero = docket?.pre_xero_docs_ready === true;
  const docketState = lower(docket?.state);

  if (packSent) {
    return {
      kind: "sent",
      state: legacyStatus && SENT_STATUSES.has(legacyStatus)
        ? legacyStatus
        : "sent",
      review_state: null,
      pre_xero_docs_ready: preXero,
      docket_revision_id: docketId,
      drafted: true,
      reason: null,
      blockers: allBlockers,
      legacy_pack_status: legacyPackStatus,
    };
  }

  // Current U4 docket is pack authority when present and not sent.
  if (docketId) {
    // A blocker or blocked state is an honest stop — not a green ready and not
    // a send-pipeline "failed".
    if (allBlockers.length > 0 || docketState === "blocked") {
      return {
        kind: "refused",
        state: "refused",
        review_state: "U4_BLOCKED",
        pre_xero_docs_ready: false,
        docket_revision_id: docketId,
        drafted: true,
        reason: firstReason(
          allBlockers,
          "The current SES docket is blocked on evidence.",
        ),
        blockers: allBlockers,
        legacy_pack_status: legacyPackStatus,
      };
    }
    // Ready: docket proves docs ready and no refusal blockers.
    if (preXero) {
      return {
        kind: "ready",
        // Never publish stale legacy `failed` over a ready docket.
        state: "drafted",
        review_state: "READY",
        pre_xero_docs_ready: true,
        docket_revision_id: docketId,
        drafted: true,
        reason: null,
        blockers: [],
        legacy_pack_status: legacyPackStatus,
      };
    }
    // Docket exists but is not yet ready and names no refusal — still assembling.
    return {
      kind: "incomplete",
      state: "drafted",
      review_state: "U4_BLOCKED",
      pre_xero_docs_ready: false,
      docket_revision_id: docketId,
      drafted: true,
      reason: "The SES docket is still assembling and is not ready for review.",
      blockers: [],
      legacy_pack_status: legacyPackStatus,
    };
  }

  // No docket: legacy pack row is the only signal.
  if (legacyStatus === "failed") {
    const detail = input.legacy_pack?.error_detail;
    const detailText = typeof detail === "string"
      ? txt(detail)
      : (detail && typeof detail === "object"
        ? txt(
          (detail as Record<string, unknown>).message ||
            (detail as Record<string, unknown>).error ||
            JSON.stringify(detail),
        )
        : "");
    const step = txt(input.legacy_pack?.failed_step);
    const fact = detailText ||
      (step
        ? `Legacy pack refused at ${step}.`
        : "Legacy pack draft was refused on evidence.");
    return {
      kind: "refused",
      state: "refused",
      review_state: null,
      pre_xero_docs_ready: false,
      docket_revision_id: null,
      drafted: false,
      reason: fact,
      blockers: [{
        code: step || "legacy_pack_failed",
        fact,
        recovery_action:
          "Assemble a current SES docket revision; the legacy draft path is not pack truth.",
        category: "legacy_pack",
      }],
      legacy_pack_status: legacyPackStatus,
    };
  }

  if (
    legacyStatus === "drafting" ||
    legacyStatus === "sending" ||
    legacyStatus === "ready_to_build"
  ) {
    return {
      kind: "incomplete",
      state: legacyStatus,
      review_state: null,
      pre_xero_docs_ready: false,
      docket_revision_id: null,
      drafted: false,
      reason: "A pack is still assembling.",
      blockers: [],
      legacy_pack_status: legacyPackStatus,
    };
  }

  if (
    legacyStatus === "drafted" ||
    legacyStatus === "authorised_not_sent" ||
    legacyStatus === "authorized_not_sent"
  ) {
    // Legacy drafted row without a U4 docket is incomplete relative to SES review.
    return {
      kind: "incomplete",
      state: legacyStatus === "authorised_not_sent" ||
          legacyStatus === "authorized_not_sent"
        ? "authorised_not_sent"
        : "drafted",
      review_state: null,
      pre_xero_docs_ready: false,
      docket_revision_id: null,
      drafted: true,
      reason:
        "A legacy pack row exists, but no current SES docket revision is assembled for review.",
      blockers: [],
      legacy_pack_status: legacyPackStatus,
    };
  }

  if (input.has_report_doc === true || input.has_trade_report === true) {
    return {
      kind: "incomplete",
      state: "not_started",
      review_state: null,
      pre_xero_docs_ready: false,
      docket_revision_id: null,
      drafted: false,
      reason: input.has_report_doc === true
        ? "Report evidence exists, but no SES pack has been assembled yet."
        : "A trade report is in, but no SES pack has been assembled yet.",
      blockers: [],
      legacy_pack_status: legacyPackStatus,
    };
  }

  if (!legacyPackStatus) {
    return {
      kind: "none",
      state: "not_started",
      review_state: null,
      pre_xero_docs_ready: false,
      docket_revision_id: null,
      drafted: false,
      reason: null,
      blockers: [],
      legacy_pack_status: null,
    };
  }

  return {
    kind: "incomplete",
    state: legacyStatus || "not_started",
    review_state: null,
    pre_xero_docs_ready: false,
    docket_revision_id: null,
    drafted: false,
    reason: "Pack state is not yet ready for review.",
    blockers: [],
    legacy_pack_status: legacyPackStatus,
  };
}
