/**
 * Docs Ready SMS (Harden SES v1, ticket 06).
 *
 * Captain 2026-08-07: when a card newly reaches Docs Ready he gets ONE SMS on
 * the existing GHL path — his ONLY ping from the whole system. Everything else
 * (including this path's own failures) alerts on ops surfaces, never his phone.
 *
 * Exact-once per job per attendance cycle through the `docs_ready_sms`
 * external-effect kind: the claim is a uniquely-indexed ledger row, so a
 * re-persisted docket revision in the same cycle, or two concurrent prepares,
 * can never text him twice. A genuine reattend mints a new attendance cycle
 * and may legitimately text again.
 *
 * This module never throws to its caller: a docket persist must not fail
 * because a courtesy SMS could not be sent.
 */

import {
  buildSesEffect,
  type SesExternalEffectStore,
} from "./ses_external_effects.ts";
import { sesSha256 } from "./ses_docket_envelope.ts";
import type { SesPreparedRevision } from "./ses_docket_envelope.ts";

export const SES_DOCS_READY_SMS_VERSION = "ses.docs-ready-sms/v1";

/** Overridable destination; defaults to the Captain's mobile. */
export const SES_DOCS_READY_SMS_DEFAULT_TO = "+61404777984";

export interface SesDocsReadySmsDeps {
  org_id: string;
  store: SesExternalEffectStore;
  sendSms: (phone: string, message: string) => Promise<boolean>;
  /** E.164 destination. Resolve from env SES_DOCS_READY_SMS_TO at the caller. */
  phone: string;
  lookupJobNumber: (jobId: string) => Promise<string | null>;
  actor: string;
}

export interface SesDocsReadySmsOutcome {
  job_id: string;
  outcome: "sent" | "already_notified" | "not_ready" | "failed";
  detail?: string;
}

function smsText(
  jobNumber: string | null,
  jobId: string,
  address: string,
  builderReference: string,
  commercialCaveatCount = 0,
): string {
  const name = jobNumber || jobId;
  const at = address ? ` at ${address}` : "";
  const ref = builderReference ? ` (${builderReference})` : "";
  const caveats = commercialCaveatCount > 0
    ? ` ${commercialCaveatCount} commercial caveat${
      commercialCaveatCount === 1 ? "" : "s"
    }.`
    : "";
  return `Docs Ready: ${name}${at}${ref}. Docket and draft invoice await your press.${caveats}`;
}

function readReviewCard(result: SesPreparedRevision): {
  address: string;
  builder_reference: string;
  commercial_review_count: number;
} {
  const spec = (result.review_spec || {}) as Record<string, unknown>;
  const cards = Array.isArray(spec.cards) ? spec.cards : [];
  const card = (cards[0] || {}) as Record<string, unknown>;
  const codes = Array.isArray(card.commercial_review_codes)
    ? card.commercial_review_codes.filter((code) => String(code || "").trim())
    : [];
  return {
    address: String(spec.address || ""),
    builder_reference: String(card.builder_reference || ""),
    commercial_review_count: codes.length,
  };
}

/**
 * Notify for every persisted docs-ready result in a prepare response.
 * Best-effort: each failure is logged and reported in the outcome list; no
 * failure propagates.
 */
export async function notifySesDocsReadySms(
  results: SesPreparedRevision[],
  deps: SesDocsReadySmsDeps,
): Promise<SesDocsReadySmsOutcome[]> {
  const outcomes: SesDocsReadySmsOutcome[] = [];
  for (const result of results || []) {
    const jobId = result?.envelope?.spine?.job_id || "";
    if (!jobId) continue;
    if (result.state !== "ready" || !result.persisted) {
      outcomes.push({ job_id: jobId, outcome: "not_ready" });
      continue;
    }
    let dispatchingKey: string | null = null;
    try {
      const cycleId = result.envelope.spine.current_attendance_cycle_id;
      const artifactHash = await sesSha256(
        { version: SES_DOCS_READY_SMS_VERSION, attendance_cycle_id: cycleId },
        "SecureWorks:ses-docs-ready-sms-cycle:v1\n",
      );
      const effect = await buildSesEffect({
        org_id: deps.org_id,
        job_id: jobId,
        effect_kind: "docs_ready_sms",
        artifact_hash: artifactHash,
        payload: {
          version: SES_DOCS_READY_SMS_VERSION,
          job_id: jobId,
          attendance_cycle_id: cycleId,
          to: deps.phone,
        },
      });
      const claim = await deps.store.claim(effect, deps.actor);
      if (claim.claim_mode !== "dispatch") {
        outcomes.push({ job_id: jobId, outcome: "already_notified" });
        continue;
      }
      await deps.store.transition(
        effect.operation_key,
        "reserved",
        "dispatching",
        "docs_ready_sms_dispatch",
        { job_id: jobId },
        deps.actor,
      );
      dispatchingKey = effect.operation_key;
      const jobNumber = await deps.lookupJobNumber(jobId).catch(() => null);
      const card = readReviewCard(result);
      const delivered = await deps.sendSms(
        deps.phone,
        smsText(
          jobNumber,
          jobId,
          card.address,
          card.builder_reference,
          card.commercial_review_count,
        ),
      );
      if (!delivered) throw new Error("GHL SMS send returned false");
      await deps.store.transition(
        effect.operation_key,
        "dispatching",
        "confirmed",
        "docs_ready_sms_confirmed",
        { job_id: jobId },
        deps.actor,
      );
      outcomes.push({ job_id: jobId, outcome: "sent" });
    } catch (error) {
      const detail = (error as Error)?.message || String(error);
      // Ops-surface alert, never the Captain's phone.
      console.error("[ops-api] docs_ready_sms failed", { job_id: jobId, detail });
      if (dispatchingKey) {
        // Park the row at `failed` so the ledger says honestly that no SMS
        // went out. Recovery is an ops action, not an automatic re-text.
        await deps.store.transition(
          dispatchingKey,
          "dispatching",
          "failed",
          "docs_ready_sms_failed",
          { job_id: jobId, detail },
          deps.actor,
        ).catch(() => {});
      }
      outcomes.push({ job_id: jobId, outcome: "failed", detail });
    }
  }
  return outcomes;
}
