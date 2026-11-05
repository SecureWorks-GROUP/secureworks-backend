// Dispatch v2: what happens once a supplier order is confirmed (Tweak 1,
// approved by Shaun on 4 Nov 2026). Contract:
// docs/dispatch-v2-board-contract.md, section 3e. This file holds the RULES
// only (no reads, no writes), so each one can be tested on its own. The
// writer that uses them is dispatch_v2_order_confirmed_write.ts.
//
// An order counts as confirmed when a person presses Accept on a supplier
// reply's date suggestion, or moves the box's material stage to Order
// confirmed by hand. Then, once per order:
//
//   1. The crew pickup line. One note in the job's crew thread, the same
//      kind the Dispatch "Add a note" button writes (Office tag, internal
//      only, never sent to the client, never synced to GHL), e.g.
//        "Stratco pickup Tue 3 Nov · from Neerabup · ref 123456"
//        "R&R delivery Mon 2 Nov"
//        "Fencing Warehouse pickup ASAP"
//      "from <branch>" only when the order email says it ("for pickup from
//      Neerabup"); "ref" only when a supplier reference was found in the
//      replies. When the date changes later, a new short line follows:
//        "Stratco pickup moved to Thu 5 Nov"
//      An ASAP order writes "pickup ASAP", then a full line once a date
//      lands.

import { dayLabel } from "./dispatch_v2_replies_rules.ts";
import {
  dispatchV2DateModeOf,
  type DispatchV2Fulfilment,
  dispatchV2FulfilmentOf,
} from "./dispatch_v2_emails.ts";

// The parts of a crew line are joined with a middle dot, as Shaun wrote them.
export const DISPATCH_CREW_LINE_JOIN = " · ";

// A branch name longer than this is not a branch: it is the rest of a
// sentence someone typed, so it is left off the line.
const BRANCH_MAX_CHARS = 40;

function cleanText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isIsoDay(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function instant(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/** The supplier branch an order email names on its opening line, e.g.
 * "could we please order the following for pickup from Neerabup:" gives
 * "Neerabup". Only "pickup / pick up / collect ... from / at <place>" counts,
 * and only on the opening line (the line the order builder writes). Null
 * when the email does not say. */
export function dispatchOrderBranchOf(bodyText: unknown): string | null {
  const first = String(bodyText ?? "").split(/\r?\n/).find((line) =>
    line.trim() !== ""
  ) ?? "";
  const match = first.match(
    /\b(?:pick[\s-]?up|collect(?:ion)?)\s+(?:from|at)\s+(?:the\s+)?(.+?)\s*[:.,;!]*\s*$/i,
  );
  if (!match) return null;
  // "from Neerabup branch" / "from the Neerabup store" read as "Neerabup".
  const branch = match[1]
    .replace(/\s+(?:branch|store|yard|depot|warehouse)$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!branch || branch.length > BRANCH_MAX_CHARS) return null;
  // A branch is a place name: letters, spaces, & ' - . and digits only.
  if (!/^[A-Za-z0-9][A-Za-z0-9 &'.\-]*$/.test(branch)) return null;
  return branch;
}

/** Pickup or delivery for an order, from its opening line. */
export function dispatchOrderFulfilmentOf(
  bodyText: unknown,
): DispatchV2Fulfilment {
  return dispatchV2FulfilmentOf(bodyText);
}

// What a crew line says about the date: a day, ASAP (the order asked for no
// day), or "no date yet" (the order asked for a day but none is known).
export type DispatchCrewLineWhen =
  | { kind: "date"; date: string }
  | { kind: "asap" }
  | { kind: "none" };

/** The date the crew line carries for one order, by the same rule the board
 * uses for the current order (dispatch_v2_material_stage.ts, rule 7): the
 * box's own date, unless it was set before this order was sent (then it
 * belonged to an earlier order); else the date the order email asked for;
 * else ASAP when the email said "Date: ASAP"; else no date yet. */
export function dispatchCrewLineWhen(input: {
  box: { delivery_date?: unknown; delivery_date_set_at?: unknown } | null;
  order: { sent_at?: unknown; delivery_date?: unknown; body_text?: unknown };
}): DispatchCrewLineWhen {
  const box = input.box || {};
  const sentAt = instant(input.order.sent_at);
  const boxSetAt = instant(box.delivery_date_set_at);
  const boxDateIsOlder = sentAt !== null && boxSetAt !== null &&
    boxSetAt < sentAt;
  if (isIsoDay(box.delivery_date) && !boxDateIsOlder) {
    return { kind: "date", date: box.delivery_date };
  }
  if (isIsoDay(input.order.delivery_date)) {
    return { kind: "date", date: input.order.delivery_date };
  }
  return dispatchV2DateModeOf(input.order.body_text) === "asap"
    ? { kind: "asap" }
    : { kind: "none" };
}

/** The supplier reference for the line: the first one in the list given
 * (the caller puts the accepted reply's references first, then those saved
 * on the order, then those on its other matched replies). Null when none. */
export function dispatchCrewLineRef(
  candidates: Array<string[] | string | null | undefined>,
): string | null {
  for (const group of candidates) {
    const list = Array.isArray(group) ? group : [group];
    for (const ref of list) {
      const clean = cleanText(ref);
      if (clean && clean.length <= 40) return clean;
    }
  }
  return null;
}

export type DispatchCrewLineKind = "confirmed" | "moved";

/** The words of one crew line. */
export function dispatchCrewLineText(input: {
  kind: DispatchCrewLineKind;
  supplier: string;
  fulfilment: DispatchV2Fulfilment;
  when: DispatchCrewLineWhen;
  branch?: string | null;
  ref?: string | null;
}): string {
  const head = `${input.supplier} ${input.fulfilment}`;
  if (input.kind === "moved") {
    // Only ever written for a new day (see dispatchCrewLineDecision).
    const day = input.when.kind === "date" ? dayLabel(input.when.date) : "";
    return `${head} moved to ${day}`.trim();
  }
  const when = input.when.kind === "date"
    ? dayLabel(input.when.date)
    : input.when.kind === "asap"
    ? "ASAP"
    : "no date yet";
  const parts = [`${head} ${when}`];
  const branch = cleanText(input.branch);
  if (branch) parts.push(`from ${branch}`);
  const ref = cleanText(input.ref);
  if (ref) parts.push(`ref ${ref}`);
  return parts.join(DISPATCH_CREW_LINE_JOIN);
}

// The last line already written for an order (null = none yet).
export type DispatchCrewLinePrevious = {
  line_date: string | null;
} | null;

/** Whether to write a line now, and which kind:
 *   - nothing written yet for the order: the full line ("confirmed"), unless
 *     the caller only follows up (a by-hand date change on an order that was
 *     never confirmed writes nothing);
 *   - the last line had a day and the day is now different: "moved to";
 *   - the last line had no day (ASAP or no date yet) and a day lands: the
 *     full line, so the crew gets the branch and ref with the day;
 *   - same day, or the day was cleared: nothing (the crew keeps the last
 *     line; a cleared date is not news for the yard). */
export function dispatchCrewLineDecision(input: {
  previous: DispatchCrewLinePrevious;
  when: DispatchCrewLineWhen;
  followUpOnly?: boolean;
}): DispatchCrewLineKind | null {
  const prev = input.previous;
  const day = input.when.kind === "date" ? input.when.date : null;
  if (!prev) return input.followUpOnly ? null : "confirmed";
  if (!day) return null;
  if (!prev.line_date) return "confirmed";
  return prev.line_date === day ? null : "moved";
}
