// The corrected SES stage engine — SHADOW ONLY.
//
// The board currently runs two stage engines that disagree on 71 of 407 active
// cards: the legacy ladder in `index.ts` places every card people see, while
// `computeMakesafeStatus` is what every measurement and certificate grades
// against. The captain's 2026-08-02 ruling supersedes the legacy ladder but
// explicitly refuses a straight flip to the newer engine, which is measurably
// wrong on its terminal paths. This module is the correction that will one day
// replace both.
//
// ── AUTHORITY BOUNDARY. Read this before changing anything here. ────────────
//
// This engine has NO authority over any card. `canonical_stage` remains the
// legacy ladder plus the existing overlay resolver, and `projectOpsMakesafeBoard`
// still buckets on `canonical_stage` alone. Everything this module returns is
// published as advisory `derived_stage_v2*` fields for comparison and audit.
//
// There is deliberately no flag, env var or config switch that promotes the
// advisory value to authority. The authority flip is Release 12 of the design's
// landing plan and is a separate captain-approved decision with its own exact
// manifest, overlay re-anchoring (Release 9) and soak gate (Release 11). It has
// to be WRITTEN, not thrown.
//
// Three further boundaries hold the design up:
//
// 1. PURE. `deriveSesStageV2` never receives the displayed stage and never
//    queries an overlay. Today's read model feeds the already-displayed stage
//    back into M1, which is why M1's published value short-circuits on terminal
//    display state — "display determines computation" is the circularity this
//    module exists to break. The input type structurally omits the field.
//
// 2. THE OVERLAY IS A SEPARATE RESOLVER. `sesStageV2OverlayCandidate` SIMULATES
//    what the existing resolver would do if the derivation changed. It reuses
//    the same terminal guards and the same source-equality predicate, and it
//    binds nothing. Real overlay behaviour is untouched; nine of the 46 rows
//    would unbind under a corrected derivation and five of those visibly reverse
//    the captain's own archive rulings, which is Release 9's job to re-anchor.
//
// 3. IT IS NOT THE EVIDENCE RULER. `makesafe_evidence_requirements.ts` is an
//    independent second-opinion grader with its own contract version. This
//    module neither imports it nor is imported by it.
//
// Design: data/ses-f10-stage-engine-v2-design-v1/report.md
// Evidence: docs/evidence/ses-e1-stage-engine-v2-shadow-2026-08-02.md

import {
  captureRole,
  classifyMakesafeJobType,
  closeoutSatisfied,
  deriveMakesafeEvidenceStage,
  donePortalRoles,
  externalPortalRoles,
  type MakesafeComputedStatus,
  type MakesafeJobKind,
  type MakesafeStatusHold,
  type MakesafeStatusInput,
} from "./makesafe_computed_status.ts";
import {
  isMakesafeTerminalDisplayStatus,
  isMakesafeTerminalJobState,
} from "./makesafe_status_apply.ts";
import {
  canonicalSesFamilyFromCard,
  type SesFamilyId,
} from "./ses_family_matrix.ts";
import {
  bindingMakesafeTerminalProof,
  type MakesafeTerminalProofFact,
} from "./makesafe_terminal_proof.ts";

/**
 * Bump on any change to what this engine derives. Published on every row so a
 * past measurement stays attributable to the engine that produced it.
 */
export const SES_STAGE_ENGINE_V2_VERSION = "ses-stage-engine.v2-r7-shadow";

/**
 * An invoice that has actually been issued. `DRAFT` is not terminal evidence —
 * the captain ruled that explicitly, and a draft invoice's online link cannot
 * take payment at all.
 */
export const SES_STAGE_ISSUED_INVOICE_STATUSES = [
  "AUTHORISED",
  "SUBMITTED",
  "PAID",
] as const;

/** 168 hours. Completed rolls into Archive at exactly seven days, not after. */
export const SES_STAGE_COMPLETED_WINDOW_MS = 7 * 86_400_000;

/**
 * A card whose column is not PROVED by the evidence on it. The engine says so
 * rather than picking a plausible column; the design is explicit that a
 * mechanical fall-through is not evidence about the job.
 */
export const SES_STAGE_DECISION_REQUIRED = "decision_required" as const;

export type SesStageV2Stage =
  | MakesafeComputedStatus
  | typeof SES_STAGE_DECISION_REQUIRED;

/**
 * Structurally denies this engine the displayed stage. A caller that tries to
 * pass one is a type error, not a silent regression to the circular path.
 */
export type SesStageV2Input = Omit<MakesafeStatusInput, "displayedStatus">;

/**
 * R4 — how a canonical family resolves for stage purposes.
 *
 * `kind` is the evidence path the family delegates to, and it is deliberately
 * NOT the family: temporary fencing, repair and restoration all prove their
 * stage the physical way while keeping their own identity. `kind` is null only
 * when no evidence path is defined, which today means `unknown` alone.
 */
export interface SesStageV2FamilyResolution {
  family: SesFamilyId;
  kind: MakesafeJobKind | null;
  /**
   * `sealed` — the captain has ruled how this family reports.
   * `unknown` — the family itself could not be identified from the card.
   *
   * There is no `unsealed` member any more. The design specified one for repair
   * and restoration, and the captain's 2026-08-02 ruling closed both before
   * this release landed; see the switch below. Re-introducing it needs a ruling
   * that re-opens a family, not a code edit.
   */
  recipe_state: "sealed" | "unknown";
}

export interface SesStageV2Result {
  stage: SesStageV2Stage;
  job_type: MakesafeJobKind;
  /** The canonical family this card actually is, not the three-kind guess. */
  ses_family: SesFamilyId;
  /** The evidence path the family delegates to; null when none is defined. */
  family_kind: MakesafeJobKind | null;
  family_recipe_state: "sealed" | "unknown";
  reasons: string[];
  /** Evidence the card is short of, from the shared evidence definition. */
  missing: string[];
  /**
   * Facts on the card that contradict each other. A conflict is never a stage;
   * it is the reason a stage is or is not proved, and it is what a cutover gate
   * refuses on.
   */
  conflicts: string[];
  hold: MakesafeStatusHold | null;
  engine_version: string;
}

/**
 * A completion time this engine is willing to age a card against, in priority
 * order, with the source named.
 *
 * The newer engine's list ends in generic `jobs.updated_at`, which is a row
 * touch and not completion proof — any unrelated write makes a job finished
 * months ago look like it closed today. `makesafe_job_details.invoice_ready_at`
 * is likewise a readiness marker, not an issue or a send. Both are dropped
 * here. What survives is exactly the design's allow-list: a durable send time,
 * an issued invoice's date or creation, or an explicit job completion time.
 *
 * The newer engine's own list stays where it is, in
 * `makesafe_computed_status.ts`'s `completedAt`, so the two are readable side
 * by side rather than one quietly editing the other.
 */
const TRUSTED_COMPLETION_SOURCES: ReadonlyArray<
  { source: string; read: (input: SesStageV2Input) => unknown }
> = [
  // R7 — a bound terminal proof states when the work was proved finished, and
  // it outranks the rest because it is the only source recorded FOR that
  // purpose. Every other entry is a timestamp on some other record that the
  // engine is willing to read as a completion time. On a card with no proof
  // this reads null and the list behaves exactly as it did before.
  {
    source: "terminal_proof.proven_at",
    read: (i) => sesStageBindingTerminalProof(i)?.proven_at,
  },
  { source: "pack.sent_at", read: (i) => i.evidence?.pack?.sent_at },
  { source: "invoice.invoice_date", read: (i) => i.evidence?.invoiceDate },
  { source: "invoice.created_at", read: (i) => i.evidence?.invoiceCreatedAt },
  { source: "jobs.completed_at", read: (i) => i.job?.completed_at },
  { source: "detail.report_sent_at", read: (i) => i.detail?.report_sent_at },
];

/**
 * R7 — the `makesafe_terminal_proofs` row that covers this card, or null.
 *
 * The binding rule is NOT restated here; it is the one in
 * `makesafe_terminal_proof.ts` that `makesafe_state_projection.ts` already
 * applies, so the two consumers of the contract cannot answer differently.
 *
 * This is a READ of recorded evidence, not a second way to assert a stage. The
 * proof names its own producer (`proven_by`) and the artifacts it was proved
 * against (`evidence_refs`); this engine consumes that record and adds nothing
 * to it. A card with no proof is entirely unaffected.
 */
export function sesStageBindingTerminalProof(
  input: SesStageV2Input,
): MakesafeTerminalProofFact | null {
  return bindingMakesafeTerminalProof(
    input.evidence?.terminalProofs,
    input.evidence?.attendanceCycleIds,
    input.evidence?.currentAttendanceCycleId,
  );
}

export interface SesStageCompletionClock {
  at: number | null;
  source: string | null;
}

/** The first trusted completion timestamp, or none. Never guesses. */
export function sesStageTrustedCompletionAt(
  input: SesStageV2Input,
): SesStageCompletionClock {
  for (const candidate of TRUSTED_COMPLETION_SOURCES) {
    const raw = candidate.read(input);
    if (!raw) continue;
    const value = new Date(String(raw)).getTime();
    if (Number.isFinite(value)) return { at: value, source: candidate.source };
  }
  return { at: null, source: null };
}

export interface SesStageTerminalResult {
  stage: "completed" | "archive" | typeof SES_STAGE_DECISION_REQUIRED;
  reasons: string[];
  conflicts: string[];
}

/**
 * THE one common clock. Every terminal path runs through here.
 *
 * The newer engine applies the rolling seven-day window on its close-out path
 * and skips it entirely on the raw complete/completed/closed shortcut, which is
 * why 34 jobs finished months ago would appear in "Completed This Week". The
 * captain's ruling names this as precondition 2: the clock applies on EVERY
 * path, including the shortcut.
 *
 * A missing trusted timestamp is refused rather than guessed. The newer engine
 * treats an unknown completion time as "within the window" and parks the card
 * in Completed forever; that is a claim about this week that no evidence
 * supports.
 *
 * The boundary is strict and matches the legacy rolling-window helper: under
 * 168 hours is Completed, exactly 168 hours is Archive.
 */
export function sesStageCompletedStage(
  input: SesStageV2Input,
  reason: string,
): SesStageTerminalResult {
  const { at, source } = sesStageTrustedCompletionAt(input);
  if (at == null) {
    return {
      stage: SES_STAGE_DECISION_REQUIRED,
      reasons: [reason],
      conflicts: ["completion_timestamp_missing"],
    };
  }
  const now = new Date(input.nowIso || new Date().toISOString()).getTime();
  const withinSevenDays = Number.isFinite(now) &&
    now - at < SES_STAGE_COMPLETED_WINDOW_MS;
  return {
    stage: withinSevenDays ? "completed" : "archive",
    reasons: [
      reason,
      withinSevenDays
        ? `completion time from ${source} is under 7 days old`
        : `completion time from ${source} is at least 7 days old`,
    ],
    conflicts: [],
  };
}

/**
 * R4 — the canonical family, and the evidence path it delegates to.
 *
 * The engine previously asked `classifyMakesafeJobType`, which can only ever
 * answer physical / roof / assessment and falls through to physical for
 * everything it does not recognise. On the measured snapshot that mislabels 136
 * cards — 116 temporary fencing, 1 restoration and 19 whose family cannot be
 * identified at all — as physical make-safes. Their columns happen not to move,
 * because the delegated evidence path is physical for the first two groups
 * anyway, but the diagnostic identity on every one of them was wrong.
 *
 * The switch is EXHAUSTIVE over `SesFamilyId` and the `never` check below is
 * load-bearing: adding a family to `ses_family_matrix.ts` without deciding how
 * it proves a stage is a type error here, not a silent fall-through to physical.
 *
 * Repair and restoration are SEALED by the captain's ruling of 2026-08-02
 * (`data/decisions/2026-08-02-docs-ready-repair-restoration.md`):
 *
 *   repair      — "let's just keep it really simple for now and make it just
 *                  match the whole existing system"
 *   restoration — "exactly the same as any other job, so it is a different
 *                  family type"
 *
 * So both take the standard evidence path and keep their own family identity.
 * The design that preceded that ruling had them returning unsealed-recipe
 * blockers; the ruling explicitly closed both and named Release 4 as one of the
 * things it unblocks. Encoding a blocker here now would contradict it and would
 * move the one live restoration card, which must not happen in this release.
 */
export function resolveSesStageV2Family(
  input: SesStageV2Input,
): SesStageV2FamilyResolution {
  const family: SesFamilyId = input.ses_family ?? canonicalSesFamilyFromCard({
    makesafe_job_family: input.job?.metadata?.makesafe_job_family,
    insurance_job_type: input.job?.metadata?.insurance_job_type,
    own_template_requested: input.job?.metadata?.own_template_requested,
    strata: input.job?.metadata?.strata,
    report_delivery: input.job?.metadata?.report_delivery ??
      input.detail?.report_delivery,
  });

  switch (family) {
    case "physical_makesafe":
      return { family, kind: "physical_makesafe", recipe_state: "sealed" };
    case "ordinary_roof_portal":
      return { family, kind: "roof_report", recipe_state: "sealed" };
    case "own_template_roof":
      // The roof evidence path today. Release 5 adds the own-template
      // submitted-draft reader; there are 0 such cards at this snapshot.
      return { family, kind: "roof_report", recipe_state: "sealed" };
    case "assessment_quote":
      return {
        family,
        kind: "assessment_report_quote",
        recipe_state: "sealed",
      };
    case "temporary_fencing":
      // Delegates its stage evidence to physical, keeps its own identity.
      return { family, kind: "physical_makesafe", recipe_state: "sealed" };
    case "repair":
    case "restoration":
      // Captain-sealed 2026-08-02: both behave as the standard job does.
      return { family, kind: "physical_makesafe", recipe_state: "sealed" };
    case "unknown":
      // No evidence path. Refused for advancement below; never read as physical.
      return { family, kind: null, recipe_state: "unknown" };
    default: {
      const exhaustive: never = family;
      throw new Error(`unhandled SES family: ${String(exhaustive)}`);
    }
  }
}

/**
 * R5 — own-template roof report-in evidence.
 *
 * An own-template roof is the family where SecureWorks renders its OWN branded
 * PDF from a trade-filled template, rather than the trade completing a form on
 * the builder's Prime portal. There is therefore no Prime form for the portal
 * reader to observe, and a typed portal capture can never arrive for one of
 * these cards. Proving it the ordinary-roof way means it can only ever sit at
 * Allocated — the gap this release closes.
 *
 * The design's rule, verbatim: the current-cycle own-roof draft is `submitted`,
 * its `report_doc_id` is the attached `roof_report` document, and its submitted
 * cycle matches. All three are required, and all three are facts the running
 * submit path already persists before it advances the checklist
 * (`docs/evidence/roof-report-template-flow-2026-07-22.md`).
 *
 * `report_doc_id` present is NOT the same as the document being attached. The
 * draft row can name a document id that never became a `roof_report`
 * `job_documents` row, so the attachment is checked independently rather than
 * inferred from the id.
 */
export function sesStageOwnRoofReportIn(
  input: SesStageV2Input,
): { satisfied: boolean; missing: string[] } {
  const draft = input.evidence?.ownRoofDraft || null;
  const missing: string[] = [];
  if (!draft) {
    missing.push("a current-cycle own-template roof report draft");
    return { satisfied: false, missing };
  }
  if (String(draft.status || "").toLowerCase() !== "submitted") {
    missing.push(
      "the own-template roof report to be submitted, not left in draft",
    );
  }
  const cardCycle = Number(input.detail?.cycle_number ?? 1);
  const draftCycle = Number(draft.cycle_number ?? 1);
  if (draftCycle !== cardCycle) {
    missing.push(
      `an own-template roof report for the current attendance cycle (report is cycle ${draftCycle}, card is cycle ${cardCycle})`,
    );
  }
  if (!String(draft.report_doc_id || "").trim()) {
    missing.push("the rendered own-template roof report document");
  } else if (
    !input.evidence?.documents?.ownRoofReportDocumentIds?.has(
      String(draft.report_doc_id),
    )
  ) {
    // The draft names a document that is not attached to the card as a
    // `roof_report`. Evidence that was rendered but never landed is not proof.
    missing.push("the rendered own-template roof report to be attached");
  }
  return { satisfied: missing.length === 0, missing };
}

/**
 * R6 — what the deterministic portal reader has actually established about one
 * required role.
 *
 * The four values are deliberately distinct, and the third is the whole point
 * of this release:
 *
 * - `proved`             — an accepted capture revision says the Prime form is
 *                          submitted and locked.
 * - `observed_not_done`  — we DID see the portal and the form is not submitted.
 *                          That is a real negative fact about the work.
 * - `cannot_observe`     — a capture ran and could not read the portal. This is
 *                          the ABSENCE of evidence, never evidence of absence.
 *                          It says nothing about whether the trade did the work
 *                          and must never be rendered as though it did.
 * - `no_capture`         — nothing has been attempted yet.
 */
export type SesPortalRoleObservation =
  | "proved"
  | "observed_not_done"
  | "cannot_observe"
  | "no_capture";

/** The typed roles each portal family must prove. Driven by canonical family. */
export const SES_PORTAL_REQUIRED_ROLES: Partial<
  Record<SesFamilyId, readonly string[]>
> = {
  ordinary_roof_portal: ["roof_report"],
  assessment_quote: ["assessment_report", "photos", "quote"],
};

export function sesStagePortalRoleObservation(
  input: SesStageV2Input,
  role: string,
): SesPortalRoleObservation {
  // ONE acceptance path. `donePortalRoles` is the read model's contract as the
  // running product already applies it - exact typed role, exact current-cycle
  // URL match against the card's own external link, done, locked, screenshot
  // backed. This engine consumes that decision and never re-decides it, so a
  // capture this module calls proved is exactly one the board already accepts.
  if (donePortalRoles(input as MakesafeStatusInput).has(role)) return "proved";

  const cycle = Number(input.detail?.cycle_number ?? 1);
  const captures = (input.evidence?.portalCaptures || []).filter((item) =>
    captureRole(item) === role &&
    (item.cycle_number == null || Number(item.cycle_number) === cycle)
  );
  const datedCaptures = captures.filter((item) =>
    String(item.captured_at || "").trim()
  );
  const capture = datedCaptures.length === 0
    ? captures[0]
    : datedCaptures.reduce((latest, item) => {
      const timeOrder = String(item.captured_at || "").localeCompare(
        String(latest.captured_at || ""),
      );
      if (timeOrder !== 0) return timeOrder > 0 ? item : latest;
      return String(item.revision_id || "").localeCompare(
          String(latest.revision_id || ""),
        ) > 0
        ? item
        : latest;
    });
  const status = String(capture?.status || "").toLowerCase();
  if (status === "not_done") return "observed_not_done";
  // `unreachable` is the reader telling us it could not see the portal. The
  // newer engine funnels it into the same "still needs a capture" sentence as
  // never-attempted unless an expiry phrase happens to appear in the signal,
  // which conflates a failed observation with an unfinished job.
  if (status === "unreachable") return "cannot_observe";
  return "no_capture";
}

/**
 * R6 — portal report-in for the two portal families.
 *
 * Satisfaction is unchanged: every required role must be `proved`, decided by
 * the single shared acceptance path. What this adds is an honest account of WHY
 * an unproved role is unproved, so a card blocked by a reader failure is never
 * reported as a trade that has not done the work.
 */
export function sesStagePortalReportIn(
  input: SesStageV2Input,
  family: SesFamilyId,
): {
  satisfied: boolean;
  missing: string[];
  observations: Record<string, SesPortalRoleObservation>;
} {
  const required = SES_PORTAL_REQUIRED_ROLES[family] ?? [];
  const links = externalPortalRoles(input as MakesafeStatusInput);
  const observations: Record<string, SesPortalRoleObservation> = {};
  const missing: string[] = [];
  for (const role of required) {
    const observed = sesStagePortalRoleObservation(input, role);
    observations[role] = observed;
    if (observed === "proved") continue;
    if (!links.has(role)) {
      missing.push(
        `the builder's ${role} portal link, which the work order email does not contain`,
      );
      continue;
    }
    missing.push(
      observed === "observed_not_done"
        ? `the builder's ${role} form to be submitted and locked in Prime`
        : observed === "cannot_observe"
        // Deliberately about US, not about the trade.
        ? `a readable capture of the builder's ${role} portal - the last attempt could not observe it, which is not evidence the work is unfinished`
        : `a capture of the builder's ${role} portal proving the form is submitted and locked`,
    );
  }
  return { satisfied: missing.length === 0, missing, observations };
}

/**
 * The pure, corrected stage derivation.
 *
 * Resolution precedence is part of the contract (design section 2.1):
 * cancelled, archived, corroborated terminal, READY pack, report-in,
 * allocation, new. Steps 4-7 come from `deriveMakesafeEvidenceStage`, the ONE
 * shared definition of what the evidence on a card proves — this module must
 * never keep a second copy of it.
 */
export function deriveSesStageV2(input: SesStageV2Input): SesStageV2Result {
  const jobStatus = String(input.job?.status || "").toLowerCase();
  const family = resolveSesStageV2Family(input);
  // The evidence path. For every family with a defined one this equals the
  // three-kind guess on today's data; `unknown` has none and is refused below
  // rather than silently read as physical.
  const kind = family.kind ?? classifyMakesafeJobType(input.detail, input.job);
  const hold = input.evidence?.hold || null;
  const conflicts: string[] = [];
  const base = {
    job_type: kind,
    ses_family: family.family,
    family_kind: family.kind,
    family_recipe_state: family.recipe_state,
    hold,
    engine_version: SES_STAGE_ENGINE_V2_VERSION,
  };

  if (["cancelled", "canceled"].includes(jobStatus)) {
    return {
      ...base,
      stage: "cancelled",
      reasons: ["job is cancelled"],
      missing: [],
      conflicts,
    };
  }
  if (jobStatus === "archived") {
    return {
      ...base,
      stage: "archive",
      reasons: ["job is archived"],
      missing: [],
      conflicts,
    };
  }
  // R7 — a bound terminal proof closes the card.
  //
  // This sits ABOVE the raw complete/closed branch deliberately. That branch
  // exists because `jobs.status` is a CLAIM about the job that needs
  // corroborating; a terminal proof is not a claim, it is the recorded evidence
  // contract for "this card's work is finished", carrying its own producer, its
  // own timestamp and the artifacts it was proved against. Reaching the invoice
  // test first would let a card with real recorded proof fail on the absence of
  // a LOCAL invoice mirror row — which is exactly the shape of card the proof
  // contract exists to close.
  //
  // It sits BELOW cancelled and archived because those are explicit current
  // states of the job itself, and a proof does not revive a cancelled card.
  const terminalProof = sesStageBindingTerminalProof(input);
  if (terminalProof) {
    const terminal = sesStageCompletedStage(
      input,
      `a ${terminalProof.kind} terminal proof covers this card's exact attendance-cycle set`,
    );
    return {
      ...base,
      stage: terminal.stage,
      reasons: terminal.reasons,
      missing: [],
      conflicts: [...conflicts, ...terminal.conflicts],
    };
  }
  if (["complete", "completed", "closed"].includes(jobStatus)) {
    // R3 — the raw terminal value is a CLAIM, not proof. It is eligible to
    // close a card only when an issued invoice corroborates it. Uncorroborated,
    // it pre-empts stronger evidence sitting on the card: two live cards carry
    // a submitted current-cycle report and the photo floor, and the shortcut
    // would bury both in Completed.
    const invoiceStatus = String(input.evidence?.invoiceStatus || "")
      .toUpperCase();
    if (
      (SES_STAGE_ISSUED_INVOICE_STATUSES as readonly string[]).includes(
        invoiceStatus,
      )
    ) {
      const terminal = sesStageCompletedStage(
        input,
        "job is completed or closed and an issued invoice corroborates it",
      );
      return {
        ...base,
        stage: terminal.stage,
        reasons: terminal.reasons,
        missing: [],
        conflicts: [...conflicts, ...terminal.conflicts],
      };
    }
    conflicts.push("terminal_without_issued_invoice");
    const evidence = deriveSesStageEvidence(input, family);
    // A mechanical fall-through to New is NOT evidence that the job is new. If
    // the card carries no later-stage evidence at all, the raw terminal claim
    // and the empty evidence contradict each other and NOTHING is proved. The
    // engine says so and stops a cutover rather than inventing a column.
    if (evidence.status === "new") {
      conflicts.push("terminal_without_supporting_evidence");
      return {
        ...base,
        stage: SES_STAGE_DECISION_REQUIRED,
        reasons: [
          "raw job state says completed or closed, no issued invoice corroborates it, and no evidence on the card proves any other column",
        ],
        missing: evidence.missing,
        conflicts,
      };
    }
    return {
      ...base,
      stage: evidence.status,
      reasons: [
        ...evidence.reasons,
        "raw completed/closed job state is not corroborated by an issued invoice, so it does not close the card",
      ],
      missing: evidence.missing,
      conflicts,
    };
  }
  if (closeoutSatisfied(input as MakesafeStatusInput)) {
    const terminal = sesStageCompletedStage(
      input,
      "durable sent-pack evidence and authorised invoice agree",
    );
    return {
      ...base,
      stage: terminal.stage,
      reasons: terminal.reasons,
      missing: [],
      conflicts: [...conflicts, ...terminal.conflicts],
    };
  }

  // R4 — an unidentifiable family has no evidence path, so nothing downstream
  // can prove what this card needs. Refuse the ADVANCEMENT rather than read it
  // as a physical make-safe, which is what the three-kind guess did to 19 cards.
  // This sits after every terminal branch on purpose: an explicit raw
  // cancelled / archived / corroborated-complete state is a fact about the job
  // that holds whatever the family is, and those returned above untouched.
  if (family.recipe_state === "unknown") {
    conflicts.push("family_unknown");
    return {
      ...base,
      stage: SES_STAGE_DECISION_REQUIRED,
      reasons: [
        "the card's SES family cannot be identified, so no evidence recipe defines what would advance it",
      ],
      missing: [],
      conflicts,
    };
  }

  const evidence = deriveSesStageEvidence(input, family);
  return {
    ...base,
    stage: evidence.status,
    reasons: evidence.reasons,
    missing: evidence.missing,
    conflicts,
  };
}

/**
 * The shared evidence ladder, with the own-template roof report-in substitution
 * applied for that family alone. Every other family goes through the ladder
 * untouched, so this adds a family-scoped reader rather than a second ladder.
 */
function deriveSesStageEvidence(
  input: SesStageV2Input,
  family: SesStageV2FamilyResolution,
) {
  if (family.family === "own_template_roof") {
    const reportIn = sesStageOwnRoofReportIn(input);
    return deriveMakesafeEvidenceStage(input as MakesafeStatusInput, {
      reportIn,
      reportInReason:
        "the current-cycle own-template roof report is submitted and its rendered document is attached",
    });
  }
  if (SES_PORTAL_REQUIRED_ROLES[family.family]) {
    const reportIn = sesStagePortalReportIn(input, family.family);
    return deriveMakesafeEvidenceStage(input as MakesafeStatusInput, {
      reportIn: { satisfied: reportIn.satisfied, missing: reportIn.missing },
      reportInReason:
        "every required builder portal capture is accepted as submitted and locked",
    });
  }
  return deriveMakesafeEvidenceStage(input as MakesafeStatusInput);
}

/** The overlay row shape the resolver reads. */
export interface SesStageOverlayApplication {
  source_status?: string | null;
  after_status?: string | null;
}

export interface SesStageV2OverlayCandidate {
  stage: string;
  binds: boolean;
}

/**
 * SIMULATES the existing display-overlay resolver against a v2 derivation.
 *
 * This is the advisory answer to "which column would this card land in after a
 * cutover", and it binds NOTHING. It mirrors `buildCanonicalMakesafeRows`'s
 * predicate exactly — same terminal-display guard, same terminal-job-state
 * guard, same strict source equality — because the point of the measurement is
 * to expose which captain decisions would unbind, not to make more of them bind.
 * Relaxing any of these three guards here would understate that risk.
 */
export function sesStageV2OverlayCandidate(
  derivedStage: SesStageV2Stage,
  application: SesStageOverlayApplication | null | undefined,
  rawJobState: unknown,
): SesStageV2OverlayCandidate {
  const stage = String(derivedStage || "").toLowerCase();
  const binds = !!application &&
    !isMakesafeTerminalDisplayStatus(stage) &&
    !isMakesafeTerminalJobState(rawJobState) &&
    String(application.source_status || "").toLowerCase() === stage;
  return {
    stage: binds
      ? String(application?.after_status || stage).toLowerCase()
      : stage,
    binds,
  };
}

/** The published advisory subset of a canonical board row the gate reads. */
export interface SesStageGateRow {
  id?: string | null;
  job_number?: string | null;
  canonical_stage?: string | null;
  /**
   * Deliberately `unknown`. The gate's whole fail-closed branch exists because
   * this value may be absent or not a string on a row that never reached the
   * corrected engine, so a narrower type would be the declaration telling a
   * caller something the runtime does not believe. `sesStageCutoverGate` proves
   * it is a non-empty string before using it.
   */
  derived_stage_v2?: unknown;
  derived_stage_v2_conflicts?: string[] | null;
  derived_stage_v2_reasons?: string[] | null;
}

export interface SesStageCutoverGateBlocker {
  job_id: string | null;
  job_ref: string | null;
  canonical_stage: string | null;
  conflicts: string[];
  reasons: string[];
}

export interface SesStageCutoverGateResult {
  ok: boolean;
  checked: number;
  engine_version: string;
  blocked: SesStageCutoverGateBlocker[];
}

/**
 * The cutover gate.
 *
 * A card the corrected engine refuses to place STOPS a cutover. That is the
 * whole point of `decision_required`: `SWMS-261059` said completed, had no
 * issued invoice, no current-cycle report and no live assignment, and its true
 * column was a captain question. Dropping it into New, Docs Ready, Completed or
 * Archive because the code has to return something is exactly the failure this
 * refuses.
 *
 * That card is also the worked example of how such a question is ANSWERED: the
 * captain opened it, read the four artifacts on it and signed it off, and that
 * decision was recorded as a `makesafe_terminal_proofs` row naming him as the
 * producer. The engine then derived `completed` from the evidence — nobody
 * wrote a stage. See
 * `docs/evidence/ses-261059-captain-signoff-2026-08-02.md`.
 *
 * This gate reads the published advisory value and grants nothing. It cannot
 * move a card, and passing it is not a cutover authorisation — Release 12 is,
 * and it needs its own exact manifest and captain approval on top of this.
 */
export function sesStageCutoverGate(
  rows: SesStageGateRow[],
): SesStageCutoverGateResult {
  const blocked: SesStageCutoverGateBlocker[] = [];
  for (const row of rows || []) {
    if (
      typeof row?.derived_stage_v2 !== "string" ||
      row.derived_stage_v2.trim() === ""
    ) {
      blocked.push({
        job_id: row?.id ?? null,
        job_ref: row?.job_number ?? null,
        canonical_stage: row?.canonical_stage ?? null,
        conflicts: ["advisory_stage_missing"],
        reasons: [
          "advisory stage missing - the corrected engine did not place this row, so a cutover cannot be proved",
        ],
      });
      continue;
    }
    if (row?.derived_stage_v2 !== SES_STAGE_DECISION_REQUIRED) continue;
    blocked.push({
      job_id: row?.id ?? null,
      job_ref: row?.job_number ?? null,
      canonical_stage: row?.canonical_stage ?? null,
      conflicts: row?.derived_stage_v2_conflicts ?? [],
      reasons: row?.derived_stage_v2_reasons ?? [],
    });
  }
  return {
    ok: blocked.length === 0,
    checked: (rows || []).length,
    engine_version: SES_STAGE_ENGINE_V2_VERSION,
    blocked,
  };
}
