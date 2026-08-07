/**
 * Automated trade chase on the 4 PM next-day KPI (Harden SES v1, ticket 10).
 *
 * The KPI is fixed: work allocated for day X means the trade's report is in
 * by 4 PM (Perth) the NEXT business day. Past that, the system reminds the
 * allocated trade on the existing internal SMS path — never client or builder
 * channels, and never the Captain's phone.
 *
 * Fences, in order of importance:
 *   - DARK BY DEFAULT: the caller resolves `enabled` from
 *     SES_TRADE_CHASE_ENABLED; anything but an explicit enable returns an
 *     inert summary. Switched on only after the backlog reconcile (ticket 09)
 *     so ancient backlog cannot spam every trade on day one.
 *   - Recipient is ONLY the phone on the card's live crew assignment (an
 *     internal user row). Numbers on the forbidden list (the Captain's) and
 *     absent numbers are skipped and reported, never substituted.
 *   - Exact-once per job per local day via the `trade_chase_sms` external
 *     effect: artifact_hash covers {job_id, local date}, so concurrent runs
 *     or a re-run in the same day can never double-text a trade. Tomorrow is
 *     a new coordinate — an unfixed card is chased once per day, not once
 *     ever.
 *   - Never throws to its caller; a failed SMS parks its effect row at
 *     `failed` so the ledger says honestly that no chase went out.
 */

import {
  buildSesEffect,
  type SesExternalEffectStore,
} from "./ses_external_effects.ts";
import { sesSha256 } from "./ses_docket_envelope.ts";

export const SES_TRADE_CHASE_VERSION = "ses.trade-chase/v1";

/** Perth is UTC+8 year-round; the KPI clock reads 4 PM local. */
export const SES_TRADE_CHASE_TZ_OFFSET_MINUTES = 8 * 60;
export const SES_TRADE_CHASE_KPI_HOUR_LOCAL = 16;

export interface SesTradeChaseCard {
  job_id: string;
  job_number: string;
  address: string;
}

export interface SesTradeChaseAssignment {
  user_name: string;
  phone: string | null;
  /** YYYY-MM-DD the work was scheduled/allocated for (KPI day X). */
  scheduled_date: string | null;
}

export interface SesTradeChaseDeps {
  org_id: string;
  enabled: boolean;
  now: Date;
  store: SesExternalEffectStore;
  sendSms: (phone: string, message: string) => Promise<boolean>;
  /** Cards currently owing a trade report (canonical_stage = allocated). */
  listCards: () => Promise<SesTradeChaseCard[]>;
  latestLiveAssignment: (
    jobId: string,
  ) => Promise<SesTradeChaseAssignment | null>;
  /** E.164 numbers that must never receive a chase (the Captain's). */
  forbiddenPhones: string[];
  actor: string;
}

export interface SesTradeChaseOutcome {
  job_id: string;
  job_number: string;
  outcome:
    | "sent"
    | "already_chased_today"
    | "not_overdue"
    | "no_assignment"
    | "no_phone"
    | "phone_forbidden"
    | "failed";
  to_name?: string;
  due_local?: string;
  detail?: string;
}

export interface SesTradeChaseSummary {
  enabled: boolean;
  version: string;
  checked: number;
  chases: SesTradeChaseOutcome[];
}

function toLocal(now: Date): Date {
  return new Date(now.getTime() + SES_TRADE_CHASE_TZ_OFFSET_MINUTES * 60_000);
}

function localDateStr(local: Date): string {
  return local.toISOString().slice(0, 10);
}

/**
 * KPI deadline for work scheduled on `scheduledDate` (YYYY-MM-DD): 4 PM local
 * on the next business day. Weekends only — WA public holidays are a grace
 * day the trade gets for free rather than a table this module must maintain.
 */
export function sesTradeChaseDueLocal(scheduledDate: string): Date | null {
  const parsed = new Date(`${scheduledDate}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  const due = new Date(parsed.getTime());
  do {
    due.setUTCDate(due.getUTCDate() + 1);
  } while (due.getUTCDay() === 0 || due.getUTCDay() === 6);
  due.setUTCHours(SES_TRADE_CHASE_KPI_HOUR_LOCAL, 0, 0, 0);
  return due;
}

function chaseText(
  card: SesTradeChaseCard,
  dueLocal: Date,
): string {
  const at = card.address ? ` at ${card.address}` : "";
  const due = `${dueLocal.toISOString().slice(0, 10)} 4pm`;
  return `SecureWorks: trade report for ${card.job_number}${at} was due ${due} and is not in. Please submit it in the Trade app now, or reply to ops if you could not attend.`;
}

/**
 * Run one chase pass. Best-effort per card; no failure propagates. The
 * returned summary is the run's honest record — every considered card
 * appears with an outcome.
 */
export async function runSesTradeChase(
  deps: SesTradeChaseDeps,
): Promise<SesTradeChaseSummary> {
  if (!deps.enabled) {
    return {
      enabled: false,
      version: SES_TRADE_CHASE_VERSION,
      checked: 0,
      chases: [],
    };
  }
  const local = toLocal(deps.now);
  const today = localDateStr(local);
  const forbidden = new Set(
    (deps.forbiddenPhones || []).map((p) => p.replace(/\s+/g, "")),
  );
  const cards = await deps.listCards();
  const chases: SesTradeChaseOutcome[] = [];
  for (const card of cards) {
    const base = { job_id: card.job_id, job_number: card.job_number };
    let dispatchingKey: string | null = null;
    try {
      const assignment = await deps.latestLiveAssignment(card.job_id);
      if (!assignment || !assignment.scheduled_date) {
        chases.push({ ...base, outcome: "no_assignment" });
        continue;
      }
      const dueLocal = sesTradeChaseDueLocal(assignment.scheduled_date);
      if (!dueLocal) {
        chases.push({ ...base, outcome: "no_assignment" });
        continue;
      }
      if (local.getTime() <= dueLocal.getTime()) {
        chases.push({
          ...base,
          outcome: "not_overdue",
          due_local: dueLocal.toISOString(),
        });
        continue;
      }
      const phone = (assignment.phone || "").replace(/\s+/g, "");
      if (!phone) {
        chases.push({
          ...base,
          outcome: "no_phone",
          to_name: assignment.user_name,
        });
        continue;
      }
      if (forbidden.has(phone)) {
        chases.push({
          ...base,
          outcome: "phone_forbidden",
          to_name: assignment.user_name,
        });
        continue;
      }
      const artifactHash = await sesSha256(
        { version: SES_TRADE_CHASE_VERSION, job_id: card.job_id, date: today },
        "SecureWorks:ses-trade-chase-day:v1\n",
      );
      const effect = await buildSesEffect({
        org_id: deps.org_id,
        job_id: card.job_id,
        effect_kind: "trade_chase_sms",
        artifact_hash: artifactHash,
        payload: {
          version: SES_TRADE_CHASE_VERSION,
          job_id: card.job_id,
          date: today,
          to: phone,
          to_name: assignment.user_name,
        },
      });
      const claim = await deps.store.claim(effect, deps.actor);
      if (claim.claim_mode !== "dispatch") {
        chases.push({ ...base, outcome: "already_chased_today" });
        continue;
      }
      await deps.store.transition(
        effect.operation_key,
        "reserved",
        "dispatching",
        "trade_chase_sms_dispatch",
        { job_id: card.job_id, date: today },
        deps.actor,
      );
      dispatchingKey = effect.operation_key;
      const delivered = await deps.sendSms(phone, chaseText(card, dueLocal));
      if (!delivered) throw new Error("GHL SMS send returned false");
      await deps.store.transition(
        effect.operation_key,
        "dispatching",
        "confirmed",
        "trade_chase_sms_confirmed",
        { job_id: card.job_id, date: today },
        deps.actor,
      );
      chases.push({
        ...base,
        outcome: "sent",
        to_name: assignment.user_name,
        due_local: dueLocal.toISOString(),
      });
    } catch (error) {
      const detail = (error as Error)?.message || String(error);
      console.error("[ops-api] trade_chase_sms failed", {
        job_id: card.job_id,
        detail,
      });
      if (dispatchingKey) {
        await deps.store.transition(
          dispatchingKey,
          "dispatching",
          "failed",
          "trade_chase_sms_failed",
          { job_id: card.job_id, detail },
          deps.actor,
        ).catch(() => {});
      }
      chases.push({ ...base, outcome: "failed", detail });
    }
  }
  return {
    enabled: true,
    version: SES_TRADE_CHASE_VERSION,
    checked: cards.length,
    chases,
  };
}
