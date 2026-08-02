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
  classifyMakesafeJobType,
  closeoutSatisfied,
  completedAt,
  deriveMakesafeEvidenceStage,
  type MakesafeComputedStatus,
  type MakesafeJobKind,
  type MakesafeStatusHold,
  type MakesafeStatusInput,
} from "./makesafe_computed_status.ts";
import {
  isMakesafeTerminalDisplayStatus,
  isMakesafeTerminalJobState,
} from "./makesafe_status_apply.ts";

/**
 * Bump on any change to what this engine derives. Published on every row so a
 * past measurement stays attributable to the engine that produced it.
 */
export const SES_STAGE_ENGINE_V2_VERSION = "ses-stage-engine.v2-r1-shadow";

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

export interface SesStageV2Result {
  stage: SesStageV2Stage;
  job_type: MakesafeJobKind;
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

function terminalStageForCompletion(
  input: SesStageV2Input,
): "completed" | "archive" {
  const at = completedAt(input as MakesafeStatusInput);
  const now = new Date(input.nowIso || new Date().toISOString()).getTime();
  // R1 reproduces M1 exactly, including its weakness: an unknown completion
  // timestamp stays visible in Completed rather than aging out. Release 2 makes
  // the clock common to every terminal path and refuses to guess a missing one.
  const withinSevenDays = at == null ||
    (Number.isFinite(now) && now - at < SES_STAGE_COMPLETED_WINDOW_MS);
  return withinSevenDays ? "completed" : "archive";
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
  const kind = classifyMakesafeJobType(input.detail, input.job);
  const hold = input.evidence?.hold || null;
  const conflicts: string[] = [];
  const base = {
    job_type: kind,
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
  if (["complete", "completed", "closed"].includes(jobStatus)) {
    // R1 reproduces the newer engine as it stands, faults included: this
    // shortcut skips the seven-day clock entirely, which is why 34 jobs
    // finished months ago would show as this week's work. Release 2 is the one
    // counted change that routes this branch through the common clock.
    return {
      ...base,
      stage: "completed",
      reasons: ["job is already completed or closed"],
      missing: [],
      conflicts,
    };
  }
  if (closeoutSatisfied(input as MakesafeStatusInput)) {
    return {
      ...base,
      stage: terminalStageForCompletion(input),
      reasons: ["durable sent-pack evidence and authorised invoice agree"],
      missing: [],
      conflicts,
    };
  }

  const evidence = deriveMakesafeEvidenceStage(input as MakesafeStatusInput);
  return {
    ...base,
    stage: evidence.status,
    reasons: evidence.reasons,
    missing: evidence.missing,
    conflicts,
  };
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
