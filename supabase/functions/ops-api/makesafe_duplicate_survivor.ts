// Captain-authorized duplicate-survivor archive planning (2026-08-01).
//
// A both-live duplicate group is two board cards minted from ONE builder work
// order instruction. The survivor stays live; the loser is archived on the
// display ledger with a durable pointer to the survivor.
//
// Planning is pure and closed over an explicitly reviewed group list. There is
// deliberately NO discovery step here: a planner that re-derived duplicate
// groups at apply time could archive a card no human ever adjudicated. The
// authorized list below is the whole permitted surface, and a group whose live
// facts no longer match its recorded adjudication is skipped, not applied.
//
// The verification that produced this list is in
// docs/evidence/makesafe-duplicate-survivors-2026-08-01.md.

import {
  isMakesafeTerminalDisplayStatus,
  isMakesafeTerminalJobState,
  type MakesafeStatusApplyRow,
} from "./makesafe_status_apply.ts";

/** Which captain rule selected the survivor. */
export type MakesafeDuplicateRule = "builder_po" | "activity_evidence";

export interface MakesafeDuplicateGroup {
  /** Stable group key, used as the per-group idempotency suffix. */
  key: string;
  /** Builder work-order reference shared by every member. */
  external_ref: string;
  /** The one canonical builder PO the group's members were minted from. */
  builder_po: string;
  survivor_job_number: string;
  loser_job_number: string;
  rule: MakesafeDuplicateRule;
  /** Why this survivor won, in the words of the recorded adjudication. */
  reasoning: string;
  /** Machine-checkable activity counts behind an activity_evidence pick. */
  evidence: {
    survivor: MakesafeDuplicateActivity;
    loser: MakesafeDuplicateActivity;
  };
}

export interface MakesafeDuplicateActivity {
  assignments: number;
  service_reports: number;
  media: number;
  invoices: number;
  calendar_events: number;
  job_events: number;
}

export interface MakesafeDuplicateArchive {
  job_id: string;
  job_number: string;
  source_status: string;
  before_status: string;
  after_status: "archive";
  computed_at: string;
  computed_reasons: string[];
  computed_missing: string[];
  duplicate_of_job_id: string;
  duplicate_of_job_number: string;
  duplicate_rule: MakesafeDuplicateRule;
  duplicate_evidence: Record<string, unknown>;
}

export interface MakesafeDuplicateSkip {
  group_key: string;
  loser_job_number: string;
  survivor_job_number: string;
  reason:
    | "loser_not_found"
    | "survivor_not_found"
    | "loser_terminal_display_status"
    | "loser_terminal_job_status"
    | "survivor_terminal_display_status"
    | "survivor_terminal_job_status"
    | "already_archived_as_duplicate"
    | "group_not_authorized";
  detail?: string;
}

function token(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function upper(value: unknown): string {
  return String(value ?? "").trim().toUpperCase();
}

/**
 * The reviewed 2026-08-01 adjudication.
 *
 * Every entry was verified against production before landing: the group's
 * members must resolve the SAME single builder PO, and that PO's work-order PDF
 * must declare ONE instruction. Groups whose members resolved DIFFERENT POs are
 * absent by design — they are distinct jobs, not duplicates. See the evidence
 * doc for the five groups that failed re-verification and why.
 *
 * In all four surviving groups both cards carry the identical builder PO, so
 * the captain's "card carrying the builder PO survives" test does not
 * discriminate; each pick is therefore an activity_evidence pick. The captain
 * confirmed on 2026-08-01 that the evidence-pick delegation covers all four
 * pairs, including the three originally nominated for the PO rule.
 */
export const MAKESAFE_AUTHORIZED_DUPLICATE_GROUPS:
  readonly MakesafeDuplicateGroup[] = [
    {
      key: "mlb-25625-roof",
      external_ref: "MLB-25625",
      builder_po: "PO-54007",
      survivor_job_number: "SWMS-26736",
      loser_job_number: "SWMS-26998",
      rule: "activity_evidence",
      reasoning:
        "MLB-25625 carries two distinct instructions: PO-54006 (Assessment Report & Quote) " +
        "and PO-54007 (Roof Reports). SWMS-26851 is the assessment card and is NOT part of " +
        "this duplicate group. The roof instruction produced two cards. SWMS-26736 did the " +
        "work: four completed assignments explicitly noted 'Roof report ... external' at " +
        "9 Keen Court Usher, plus an invoice. SWMS-26998 was minted 2026-07-17, carries one " +
        "un-worked assignment, no invoice and no report, and sits at company_contact_required.",
      evidence: {
        survivor: {
          assignments: 4,
          service_reports: 0,
          media: 0,
          invoices: 1,
          calendar_events: 4,
          job_events: 8,
        },
        loser: {
          assignments: 1,
          service_reports: 0,
          media: 0,
          invoices: 0,
          calendar_events: 1,
          job_events: 6,
        },
      },
    },
    {
      key: "mlb-26189-assessment",
      external_ref: "MLB-26189",
      builder_po: "PO-54425",
      survivor_job_number: "SWMS-26787",
      loser_job_number: "SWMS-26791",
      rule: "activity_evidence",
      reasoning:
        "MLB-26189 has exactly one instruction (PO-54425, Assessment Report & Quote) and both " +
        "cards resolve it, so the PO rule cannot discriminate. SWMS-26787's assignments match " +
        "the work order's own appointment window (14 Murtin Rd Dalyellup, 26/06 12-4PM) and it " +
        "carries the invoice and the second document. SWMS-26791 was created three days later " +
        "and back-scheduled onto the same date with no invoice.",
      evidence: {
        survivor: {
          assignments: 2,
          service_reports: 0,
          media: 0,
          invoices: 1,
          calendar_events: 2,
          job_events: 10,
        },
        loser: {
          assignments: 2,
          service_reports: 0,
          media: 0,
          invoices: 0,
          calendar_events: 2,
          job_events: 8,
        },
      },
    },
    {
      key: "mlb-23067-makesafe",
      external_ref: "MLB-23067",
      builder_po: "PO-54811",
      survivor_job_number: "SWMS-26845",
      loser_job_number: "SWMS-26920",
      rule: "activity_evidence",
      reasoning:
        "MLB-23067 has exactly one instruction (PO-54811, Makesafe/Emergency Repairs) and both " +
        "cards resolve it. SWMS-26845 carries the entire delivery: two completed assignments " +
        "(including the 2hr temp fence), a submitted service report, 13 media and two invoices. " +
        "SWMS-26920 has a single still-scheduled assignment and no report, media or invoice.",
      evidence: {
        survivor: {
          assignments: 2,
          service_reports: 1,
          media: 13,
          invoices: 2,
          calendar_events: 2,
          job_events: 22,
        },
        loser: {
          assignments: 1,
          service_reports: 0,
          media: 0,
          invoices: 0,
          calendar_events: 1,
          job_events: 6,
        },
      },
    },
    {
      key: "mlb-26344-makesafe",
      external_ref: "MLB-26344",
      builder_po: "PO-57087",
      survivor_job_number: "SWMS-261065",
      loser_job_number: "SWMS-261118",
      rule: "activity_evidence",
      reasoning:
        "MLB-26344 has exactly one instruction (PO-57087, Makesafe/Emergency Repairs) and both " +
        "cards carry that same work-order PDF. Note the trap: SWMS-261118's external_ref string " +
        "is the fuller 'MLB-26344PO-57087', so a naive reading of the PO rule would pick the " +
        "empty card. The deterministic intake's own canonical case for wo:MLB-26344/po:PO-57087 " +
        "is confirmed_live_job against SWMS-261065, and SWMS-261065 holds the completed " +
        "assignment, the submitted report and all 9 media. SWMS-261118 is an empty re-mint: zero " +
        "assignments, reports, media and calendar events, one lifecycle event.",
      evidence: {
        survivor: {
          assignments: 1,
          service_reports: 1,
          media: 9,
          invoices: 0,
          calendar_events: 1,
          job_events: 12,
        },
        loser: {
          assignments: 0,
          service_reports: 0,
          media: 0,
          invoices: 0,
          calendar_events: 0,
          job_events: 1,
        },
      },
    },
  ];

export interface MakesafeDuplicateSurvivorRow extends MakesafeStatusApplyRow {
  /** Set when this card already carries a duplicate pointer from an earlier run. */
  duplicate_of_job_id?: string | null;
  /**
   * The status-application overlay currently driving this card's display, or
   * null when the card derives its own stage. Non-null means an earlier run
   * decided the stage, which the natural-completion exception must never read
   * as evidence that the work is finished.
   */
  status_application?: Record<string, unknown> | null;
}

/**
 * A survivor displaying `archive` because it is genuinely FINISHED, not because
 * something declared it dead.
 *
 * `archive` on this board is overloaded. A make-safe that closed out more than
 * seven days ago derives to `archive` all on its own — that is the ordinary end
 * of a completed job, and such a card is the correct survivor to point a
 * duplicate at. The terminal-display guard cannot tell that apart from a card an
 * earlier run archived as dead, so by default it refuses both.
 *
 * This narrows the refusal to exactly the cases that earn it. Every condition
 * below must hold:
 *
 * - the display is `archive` specifically — `cancelled` and every other terminal
 *   display still refuse;
 * - the card derived that stage from its OWN facts (`declared_stage`), with no
 *   status-application overlay in play, so nothing a previous run decided is
 *   being read as completion;
 * - the card is not itself an archived duplicate, which would build a pointer
 *   chain;
 * - and the independent M1 computed status agrees the work is closed out. That
 *   verdict comes from `closeoutSatisfied` — a durable send record plus an
 *   AUTHORISED/PAID ACCREC invoice — which is the "done and invoiced" evidence
 *   this exception is meant to require, checked by an engine that knows nothing
 *   about duplicates.
 *
 * Anything short of all four keeps the original refusal.
 */
export function survivorArchiveIsNaturalCompletion(
  survivor: MakesafeDuplicateSurvivorRow,
): boolean {
  if (token(survivor?.canonical_stage) !== "archive") return false;
  if (token(survivor?.declared_stage) !== "archive") return false;
  if (survivor?.status_application) return false;
  if (survivor?.duplicate_of_job_id) return false;
  return ["archive", "completed"].includes(token(survivor?.computed_status));
}

/**
 * Plan the duplicate archives for an explicit group-key list.
 *
 * `rows` are canonical board rows. Only groups present in
 * MAKESAFE_AUTHORIZED_DUPLICATE_GROUPS can ever be planned.
 */
export function planMakesafeDuplicateSurvivorArchives(
  rows: MakesafeDuplicateSurvivorRow[],
  requestedGroupKeys: string[] | null | undefined,
  nowIso: string,
): {
  requested: number;
  archives: MakesafeDuplicateArchive[];
  skipped: MakesafeDuplicateSkip[];
  survivors: { group_key: string; job_number: string; job_id: string | null }[];
} {
  const allRows = rows || [];
  const byNumber = new Map(
    allRows
      .filter((row) => row?.job_number)
      .map((row) => [upper(row.job_number), row]),
  );

  const requestedKeys = requestedGroupKeys?.length
    ? [
      ...new Set(
        requestedGroupKeys.map((value) => String(value).trim()).filter(Boolean),
      ),
    ]
    : MAKESAFE_AUTHORIZED_DUPLICATE_GROUPS.map((group) => group.key);

  const archives: MakesafeDuplicateArchive[] = [];
  const skipped: MakesafeDuplicateSkip[] = [];
  const survivors: {
    group_key: string;
    job_number: string;
    job_id: string | null;
  }[] = [];

  for (const key of requestedKeys) {
    const group = MAKESAFE_AUTHORIZED_DUPLICATE_GROUPS.find((entry) =>
      entry.key === key
    );
    if (!group) {
      skipped.push({
        group_key: key,
        loser_job_number: "",
        survivor_job_number: "",
        reason: "group_not_authorized",
        detail: "not in the reviewed 2026-08-01 adjudication",
      });
      continue;
    }

    const loser = byNumber.get(upper(group.loser_job_number));
    const survivor = byNumber.get(upper(group.survivor_job_number));
    const base = {
      group_key: group.key,
      loser_job_number: group.loser_job_number,
      survivor_job_number: group.survivor_job_number,
    };

    if (!survivor) {
      skipped.push({ ...base, reason: "survivor_not_found" });
      continue;
    }
    survivors.push({
      group_key: group.key,
      job_number: group.survivor_job_number,
      job_id: survivor.id || null,
    });

    if (!loser) {
      skipped.push({ ...base, reason: "loser_not_found" });
      continue;
    }
    // A survivor that is itself dead or archived cannot absorb a duplicate —
    // unless its archive is the ordinary end of a finished job, in which case it
    // is exactly the card the duplicate should point at.
    if (
      isMakesafeTerminalDisplayStatus(survivor.canonical_stage) &&
      !survivorArchiveIsNaturalCompletion(survivor)
    ) {
      skipped.push({
        ...base,
        reason: "survivor_terminal_display_status",
        detail: token(survivor.canonical_stage),
      });
      continue;
    }
    if (isMakesafeTerminalJobState(survivor.job_state)) {
      skipped.push({
        ...base,
        reason: "survivor_terminal_job_status",
        detail: token(survivor.job_state),
      });
      continue;
    }
    if (loser.duplicate_of_job_id) {
      skipped.push({
        ...base,
        reason: "already_archived_as_duplicate",
        detail: String(loser.duplicate_of_job_id),
      });
      continue;
    }
    const before = token(loser.canonical_stage);
    if (isMakesafeTerminalDisplayStatus(before)) {
      skipped.push({
        ...base,
        reason: "loser_terminal_display_status",
        detail: before,
      });
      continue;
    }
    if (isMakesafeTerminalJobState(loser.job_state)) {
      skipped.push({
        ...base,
        reason: "loser_terminal_job_status",
        detail: token(loser.job_state),
      });
      continue;
    }

    archives.push({
      job_id: String(loser.id),
      job_number: String(loser.job_number),
      source_status: token(loser.declared_stage || loser.canonical_stage),
      before_status: before,
      after_status: "archive",
      computed_at: nowIso,
      computed_reasons: [
        "duplicate_survivor_archive",
        `duplicate_of:${group.survivor_job_number}`,
        `builder_po:${group.builder_po}`,
        `external_ref:${group.external_ref}`,
        `rule:${group.rule}`,
      ],
      computed_missing: [],
      duplicate_of_job_id: String(survivor.id),
      duplicate_of_job_number: String(survivor.job_number),
      duplicate_rule: group.rule,
      duplicate_evidence: {
        group_key: group.key,
        external_ref: group.external_ref,
        builder_po: group.builder_po,
        reasoning: group.reasoning,
        activity: group.evidence,
      },
    });
  }

  return { requested: requestedKeys.length, archives, skipped, survivors };
}
