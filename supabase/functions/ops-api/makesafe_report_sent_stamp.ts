// deno-lint-ignore-file no-explicit-any
/**
 * `makesafe_job_details.report_sent_at` is DERIVED from a recorded send. It is
 * never an assertion a caller may supply.
 *
 * WHY
 * ---
 * The field used to be an ordinary editable column on `update_makesafe_details`.
 * Anything holding the ops key could therefore claim a report went to a builder,
 * and nothing checked whether one had: whatever value arrived was written down
 * and thereafter believed. That is worse than an absent stamp, because a card
 * claiming a send drops out of `sentClosed` surfacing silently — no chase, no
 * follow-up, no readiness sweep. Five cards carried exactly that false stamp and
 * were cleared on 2026-08-07.
 *
 * THE THREE PRODUCERS, AND NOTHING ELSE
 * -------------------------------------
 *   1. `applyMakesafeCloseOut` (index.ts) — the legacy `makesafe_send_pack`
 *      close. Both of its call sites are gated on a real send: the
 *      `MAKESAFE_PACK_SENT | main` marker, or a durable pack row already in a
 *      sent status. It stamps only when the stamp is absent.
 *   2. `stampMakesafeReportSentFromRouteProofs` (this module) — the sealed
 *      release graph. Until now a card sent through it got NO stamp at all, so
 *      the field was wrong in both directions.
 *   3. `correct_makesafe_false_send_stamp` (makesafe_false_send_stamp.ts) — the
 *      one privileged CORRECTION, and it only ever CLEARS. There is deliberately
 *      no privileged path that SETS a stamp on demand: a set-by-hand door is the
 *      hole this module closes, and re-opening it under a new name would give
 *      back exactly what was taken away.
 *
 * Every producer writes a value it read off a send record. None of them accepts
 * a timestamp from a caller.
 */

/**
 * Callers who supply `report_sent_at` to the generic detail editor are REFUSED,
 * not silently ignored. Dropping the key quietly would tell a correction script
 * its write landed when it did not — the same class of false belief this guard
 * exists to end.
 *
 * The refusal covers `null` as well as a timestamp. Clearing a stamp is a
 * correction, and a correction has to prove the card was never sent; that proof
 * lives in `correct_makesafe_false_send_stamp`, which re-derives send truth
 * server-side and refuses any card it cannot clear safely.
 */
export const REPORT_SENT_AT_ASSERTION_REFUSAL =
  "report_sent_at is derived from a recorded send and cannot be set through update_makesafe_details. " +
  "A send stamps it (makesafe_send_pack close-out, or the sealed release graph route proof); " +
  "to clear a provably-false stamp use correct_makesafe_false_send_stamp, which re-derives send truth server-side.";

/**
 * True when a request body carries `report_sent_at` at all — by presence of the
 * key, not by truthiness. `{ report_sent_at: null }` is the shape the applied
 * 5-card correction used, and it must refuse rather than read as "not supplied".
 */
export function bodyAssertsReportSentAt(body: any): boolean {
  if (!body || typeof body !== "object") return false;
  return Object.prototype.hasOwnProperty.call(body, "report_sent_at") ||
    Object.prototype.hasOwnProperty.call(body, "reportSentAt");
}

/** One confirmed route proof, as stored. `proven_at` is the send record's own time. */
export interface RouteProofRow {
  proven_at?: string | null;
}

/**
 * The earliest `proven_at` across a release's confirmed route proofs, or null.
 *
 * The proofs are NOT filtered by `job_id`, and that is deliberate.
 * `ses_release_route_proofs.job_id` is the FIRST member's id only
 * (`confirm_ses_release_route_v1` stores
 * `(array_agg(member.job_id ORDER BY member.ordinal))[1]`); the real membership
 * is the release's member set. Filtering the proofs by that column would stamp
 * only the first card of a multi-card release and silently skip the rest — the
 * same "reads as nothing was sent" shape as the `ses_external_effects.job_id`
 * join trap. The caller supplies the member job ids; this function supplies the
 * one send time they share.
 *
 * EARLIEST, not latest: a multi-route release (report, photo, invoice) is one
 * send event with several legs, and the moment the builder first received the
 * pack is when it went out. Taking the latest would drift the stamp forward
 * every time a further leg confirmed.
 *
 * A proof with an unparseable `proven_at` contributes nothing rather than
 * defaulting to now — a fabricated clock reading is the assertion this module
 * exists to refuse.
 */
export function earliestReleaseProvenAt(
  proofs: RouteProofRow[] | null | undefined,
): string | null {
  let best: number | null = null;
  let bestIso: string | null = null;
  for (const proof of proofs || []) {
    const raw = proof?.proven_at;
    if (!raw) continue;
    const ms = new Date(String(raw)).getTime();
    if (!Number.isFinite(ms)) continue;
    if (best === null || ms < best) {
      best = ms;
      bestIso = new Date(ms).toISOString();
    }
  }
  return bestIso;
}

export interface ReportSentStampOutcome {
  job_id: string;
  /**
   * stamped        — the card had no stamp and now carries the proven send time
   * already_stamped — a stamp was already present and was LEFT ALONE
   * no_proof       — no route proof named this job; nothing was written
   * write_failed   — the update was rejected; the send is unaffected
   */
  outcome: "stamped" | "already_stamped" | "no_proof" | "write_failed";
  report_sent_at: string | null;
  detail?: string;
}

/**
 * Stamp `report_sent_at` from confirmed route proofs. ADDITIVE ONLY.
 *
 * Three properties are load-bearing:
 *
 *  - It NEVER overwrites. The write is a compare-and-set on
 *    `report_sent_at IS NULL`, so a card that already carries a stamp — a real
 *    one from the legacy close, or a re-attend's earlier cycle — keeps it, and
 *    a concurrent writer cannot be clobbered. A zero-row update is reported as
 *    `already_stamped`, never as a failed send.
 *  - It NEVER clears. There is no branch here that writes null.
 *  - It NEVER throws. The send is already irreversible by the time this runs;
 *    a stamping fault must not turn a delivered pack into a failed action, and
 *    must never be retried by re-sending. A failure is reported, and the card is
 *    simply left in the pre-existing state of a sent card with no stamp — the
 *    condition this function exists to reduce, not a new one.
 */
export async function stampMakesafeReportSentFromRouteProofs(
  client: any,
  jobId: string,
  proofs: RouteProofRow[] | null | undefined,
  ctx: { releaseRevisionId?: string | null; actor?: string | null } = {},
): Promise<ReportSentStampOutcome> {
  const provenAt = earliestReleaseProvenAt(proofs);
  if (!provenAt || !jobId) {
    return { job_id: jobId, outcome: "no_proof", report_sent_at: null };
  }

  try {
    const { data, error } = await client.from("makesafe_job_details")
      .update({
        report_sent_at: provenAt,
        updated_at: new Date().toISOString(),
      })
      .eq("job_id", jobId)
      .is("report_sent_at", null)
      .select("job_id");
    // PostgREST RETURNS errors, it does not throw, so the `error` field is the
    // only way to tell a rejected write from a no-op one.
    if (error) {
      return {
        job_id: jobId,
        outcome: "write_failed",
        report_sent_at: null,
        detail: String((error as any)?.message || error),
      };
    }
    if (!Array.isArray(data) || data.length === 0) {
      return {
        job_id: jobId,
        outcome: "already_stamped",
        report_sent_at: null,
      };
    }
  } catch (err) {
    return {
      job_id: jobId,
      outcome: "write_failed",
      report_sent_at: null,
      detail: String((err as Error)?.message || err),
    };
  }

  // Audit is best-effort and deliberately after the write: an unwritten audit
  // row must not undo a correct stamp.
  try {
    await client.from("job_events").insert({
      job_id: jobId,
      event_type: "makesafe_report_sent_at_derived",
      detail_json: {
        field: "report_sent_at",
        action: "stamped_from_send_record",
        source: "ses_release_route_proofs.proven_at",
        report_sent_at: provenAt,
        release_revision_id: ctx.releaseRevisionId ?? null,
        actor: ctx.actor ?? null,
      },
    });
  } catch (_) { /* non-blocking audit trail */ }

  return { job_id: jobId, outcome: "stamped", report_sent_at: provenAt };
}
