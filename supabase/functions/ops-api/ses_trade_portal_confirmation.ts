/**
 * The trade channel for roof-report completion (captain ruling, 2026-08-02 —
 * `portal-producer-and-voice-notes.md` section 1).
 *
 * > "for a roof report job with a prime link it should already know that and it
 * > should just ask a question like is this roof report done and then when you
 * > tick that then it goes over."
 *
 * Two rules shape this whole file:
 *
 * 1. **The card classifies itself.** Everything the record needs — role, portal
 *    URL, builder reference, attendance cycle — is DERIVED here from facts the
 *    card already carries. The trade is asked one question and supplies one
 *    answer; the request body is a job id. Nothing in this module reads a role,
 *    a family, a URL or a cycle from the caller.
 * 2. **This records evidence, never a stage.** The tick appends one row to the
 *    same append-only `makesafe_portal_capture_revisions` ledger the
 *    deterministic Prime reader writes, under a second approved producer. It
 *    writes no `canonical_stage`, no substatus, no `jobs.status`. Stage
 *    derivation reads the evidence and works the column out, which is the point
 *    of the corrected engine.
 *
 * The predicates here are PURE so both the board read model (which decides
 * whether the control is offered) and the write action (which decides whether
 * the tick is accepted) answer from one implementation. A control that is
 * offered and a tick that is refused would be the same bug from two sides.
 */

import { extractPortalLinks } from "./makesafe_portal_guard.ts";
import {
  canonicalSesPortalSourceUrl,
  SES_TRADE_PORTAL_CONFIRMATION_PRODUCER,
  SES_TRADE_PORTAL_CONFIRMATION_ROLE,
} from "./ses_portal_capture_contract.ts";

const token = (value: unknown) =>
  String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * Card states nobody should be ticking. Deliberately NARROWER than
 * `isMakesafeTerminalJobState`: `complete` / `completed` / `closed` stay
 * eligible while no completion evidence exists, because a card that reads done
 * on the ladder but carries nothing behind it is exactly the population this
 * channel was built to unblock. Only genuinely dead cards are excluded.
 */
const DEAD_JOB_STATES = new Set([
  "cancelled",
  "canceled",
  "lost",
  "deleted",
  "void",
  "voided",
  "duplicate",
  "duplicated",
  "archived",
]);

/** report_type / family tokens that mean "this is a roof card". */
const ROOF_CARD_TOKENS = new Set([
  "roofreport",
  "ordinaryroofportal",
  "owntemplateroof",
]);

export type SesRoofConfirmationReason =
  | "eligible"
  | "already_confirmed"
  | "not_a_roof_card"
  | "no_portal_roof_link"
  | "ambiguous_portal_roof_link"
  | "no_attendance_cycle"
  | "no_builder_reference"
  | "card_not_live";

export interface SesRoofConfirmationTarget {
  job_id: string;
  attendance_cycle_id: string;
  cycle_number: number;
  role: typeof SES_TRADE_PORTAL_CONFIRMATION_ROLE;
  source_url: string;
  builder_reference: string;
}

export interface SesRoofConfirmationEligibility {
  /** A roof card carrying exactly one resolvable Prime roof link. */
  applicable: boolean;
  /** Current-cycle roof completion evidence already exists (either producer). */
  confirmed: boolean;
  /** applicable && !confirmed — the control belongs on this card. */
  offered: boolean;
  reason: SesRoofConfirmationReason;
  target: SesRoofConfirmationTarget | null;
}

export interface SesRoofConfirmationCard {
  id?: unknown;
  status?: unknown;
  metadata?: { makesafe_job_family?: unknown } | null;
  external_ref?: unknown;
  makesafe_details?: {
    report_type?: unknown;
    external_ref?: unknown;
    external_links?: unknown;
    attendance_cycle_id?: unknown;
    cycle_number?: unknown;
  } | null;
}

export interface SesRoofConfirmationCaptureLike {
  role?: unknown;
  kind?: unknown;
  status?: unknown;
  cycle_number?: unknown;
}

export function isSesRoofCard(card: SesRoofConfirmationCard): boolean {
  const detail = card?.makesafe_details || {};
  return ROOF_CARD_TOKENS.has(
    token(detail?.report_type || card?.metadata?.makesafe_job_family),
  );
}

/**
 * The card's single Prime roof link, or null.
 *
 * Typed `roof_report` links outrank the generic `builder_portal` link: a card
 * routinely carries both, and treating them as rivals would make the common
 * shape "ambiguous" and hide the control from the cards that need it. Within a
 * tier, more than one distinct URL is genuinely ambiguous and fails closed —
 * the ruling forbids asking the trade to choose.
 */
export function resolveSesRoofPortalUrl(
  card: SesRoofConfirmationCard,
): { url: string | null; ambiguous: boolean } {
  const detail = card?.makesafe_details || {};
  const roofCard = isSesRoofCard(card);
  const typed: string[] = [];
  const generic: string[] = [];
  for (const link of extractPortalLinks(detail?.external_links)) {
    const url = canonicalSesPortalSourceUrl(link.url);
    if (!url) continue;
    const role = token(link.role);
    if (role === "roofreport") {
      if (!typed.includes(url)) typed.push(url);
    } else if (role === "builderportal" && roofCard) {
      if (!generic.includes(url)) generic.push(url);
    }
  }
  const tier = typed.length ? typed : generic;
  if (tier.length === 1) return { url: tier[0], ambiguous: false };
  if (tier.length > 1) return { url: null, ambiguous: true };
  return { url: null, ambiguous: false };
}

/**
 * Is current-cycle roof completion already recorded? Read from the SAME
 * projected capture list M1 reads, so "the control is hidden" and "the engine
 * counts it as done" can never disagree.
 *
 * Substatus is deliberately NOT an input. A card sitting at `ready_to_invoice`
 * with nothing behind it is unproven, and hiding the control there is the exact
 * inverse bug that PR 229 fixed: the control vanished precisely where it was
 * needed.
 */
export function sesRoofCompletionRecorded(
  card: SesRoofConfirmationCard,
  captures: SesRoofConfirmationCaptureLike[] | null | undefined,
): boolean {
  const detail = card?.makesafe_details || {};
  const cycle = Number(detail?.cycle_number ?? 1);
  return (captures || []).some((capture) => {
    const role = token(capture?.role ?? capture?.kind);
    return (role === "roofreport" || role === "roof") &&
      token(capture?.status) === "done" &&
      (capture?.cycle_number == null ||
        Number(capture.cycle_number) === cycle);
  });
}

export function sesRoofConfirmationEligibility(
  card: SesRoofConfirmationCard,
  captures: SesRoofConfirmationCaptureLike[] | null | undefined,
): SesRoofConfirmationEligibility {
  const none = (reason: SesRoofConfirmationReason) => ({
    applicable: false,
    confirmed: false,
    offered: false,
    reason,
    target: null,
  });

  const jobId = String(card?.id ?? "").trim();
  // Roof identity is settled BEFORE liveness so `card_not_live` always means
  // "a roof card that is dead", never "some other card that is dead". A
  // measurement that counts by reason depends on that ordering.
  if (!jobId || !isSesRoofCard(card)) return none("not_a_roof_card");
  if (DEAD_JOB_STATES.has(token(card?.status))) return none("card_not_live");

  const detail = card?.makesafe_details || {};
  const attendanceCycleId = String(detail?.attendance_cycle_id ?? "").trim();
  if (!attendanceCycleId) return none("no_attendance_cycle");
  const builderReference = String(
    detail?.external_ref ?? card?.external_ref ?? "",
  ).trim();
  if (!builderReference) return none("no_builder_reference");

  const link = resolveSesRoofPortalUrl(card);
  if (link.ambiguous) return none("ambiguous_portal_roof_link");
  if (!link.url) return none("no_portal_roof_link");

  const target: SesRoofConfirmationTarget = {
    job_id: jobId,
    attendance_cycle_id: attendanceCycleId,
    cycle_number: Number(detail?.cycle_number ?? 1),
    role: SES_TRADE_PORTAL_CONFIRMATION_ROLE,
    source_url: link.url,
    builder_reference: builderReference,
  };
  const confirmed = sesRoofCompletionRecorded(card, captures);
  return {
    applicable: true,
    confirmed,
    offered: !confirmed,
    reason: confirmed ? "already_confirmed" : "eligible",
    target,
  };
}

/**
 * A non-cancelled assignment on this exact job is what makes a trade "on the
 * job". Mirrors `isGenuineTradeAssignment`'s intent locally so the predicate is
 * unit-testable without the ops-api module graph.
 */
export function isSesConfirmingTradeAssignment(assignment: {
  status?: unknown;
}): boolean {
  return token(assignment?.status) !== "cancelled";
}

/**
 * The trade-safe shape published on the board. It carries no client name,
 * phone, email or street address — only the card's own portal link, which the
 * trade already opens to do the work.
 */
export interface SesRoofConfirmationPayload {
  producer: typeof SES_TRADE_PORTAL_CONFIRMATION_PRODUCER;
  applicable: boolean;
  confirmed: boolean;
  offered: boolean;
  can_confirm: boolean;
  reason: SesRoofConfirmationReason;
  question: string | null;
  source_url: string | null;
  attendance_cycle_id: string | null;
  cycle_number: number | null;
}
