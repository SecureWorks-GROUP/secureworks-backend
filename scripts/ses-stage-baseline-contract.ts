// deno-lint-ignore-file no-explicit-any
/**
 * SES E1 Release 0 — the FROZEN stage baseline contract.
 *
 * The board runs two stage engines. `_deriveMakesafeBoardStage` places the
 * cards people see; `computeMakesafeStatus` is what every measurement and
 * certificate grades against. `scripts/ses-stage-parity-harness.ts` runs both
 * over one set of read-only production reads and reports where they disagree.
 *
 * This module turns one harness run into a re-provable artifact: a named
 * population, a content-derived generation id, a per-card input hash, and the
 * exact manifest of cards whose column would change after a cutover. Release 0
 * of the corrected-engine landing plan is precisely that freeze — no product
 * behaviour changes, and an independent rerun must reproduce the manifest.
 *
 * Three inversions are load-bearing, and each is easy to get backwards:
 *
 * 1. `generation_id` is CONTENT-derived, exactly as
 *    `ses-measurement-generation.ts` requires. Two runs over an unchanged board
 *    produce the same id; `snapshot_at` differs by design and is recorded
 *    beside it, never inside it. That is how a second agent independently
 *    verifies this baseline rather than taking its word.
 *
 * 2. The per-card hash covers card INPUT facts only — job state, family,
 *    substatus, allocation/report/pack/invoice presence. It deliberately
 *    excludes both engines' VERDICTS, so correcting an engine (Releases 2-6)
 *    does not read as "every card moved underneath us". Which engines produced
 *    a reading is recorded separately in `engine_fingerprints`.
 *
 * 3. The disputed set is an IDENTITY MANIFEST, not a pinned count. Live data
 *    drifts between snapshots. A frozen card that vanishes, stops being
 *    disputed, or changes its transition is the defect this exists to catch;
 *    a NEW disputed card is reported, never silently folded in and never used
 *    to re-snapshot a failure green.
 *
 * Privacy: every field projected here comes from the harness card, which is
 * itself built from SELECT-only reads that name no client name, phone, email
 * or street address. Suburb/job/builder references are the only identifiers.
 */

import { canonicalJson, sha256Hex } from "./ses-measurement-generation.ts";

/** Bump when the hashed projection or the manifest shape changes. */
export const SES_STAGE_BASELINE_CONTRACT_VERSION = "ses-stage-baseline.v1";

/** A card as the parity harness emits it (structural subset this module reads). */
export interface ParityHarnessCard {
  job_ref: string;
  job_id: string;
  job_status: string;
  substatus: string | null;
  company_slug: string | null;
  report_type: string | null;
  ses_family: string;
  legacy_stage: string;
  legacy_canonical_stage: string;
  m1_published: string;
  m1_pure: string;
  post_cutover_stage: string;
  post_cutover_overlay_binds: boolean;
  overlay: {
    present: boolean;
    binds_today: boolean;
    source_status: string | null;
    after_status: string | null;
  };
  facts: Record<string, unknown>;
  legacy_branch: string;
  divergence_cause: string;
}

export interface ParityHarnessOutput {
  computed_at: string;
  population_contract_version: string;
  population_contract: string;
  board_cards: number;
  summary: Record<string, any>;
  cards: ParityHarnessCard[];
}

/**
 * The card facts a rerun must see unchanged for its stage reading to be
 * comparable. Anything either engine READS belongs here; anything either
 * engine CONCLUDES does not.
 */
export interface SesStageCardInputFacts {
  job_ref: string;
  job_id: string;
  job_status: string;
  substatus: string | null;
  company_slug: string | null;
  report_type: string | null;
  ses_family: string;
  facts: Record<string, unknown>;
}

export function sesStageCardInputFacts(
  card: ParityHarnessCard,
): SesStageCardInputFacts {
  return {
    job_ref: String(card.job_ref || ""),
    job_id: String(card.job_id || ""),
    job_status: String(card.job_status || ""),
    substatus: card.substatus ?? null,
    company_slug: card.company_slug ?? null,
    report_type: card.report_type ?? null,
    ses_family: String(card.ses_family || ""),
    facts: (card.facts || {}) as Record<string, unknown>,
  };
}

export async function sesStageCardInputHash(
  card: ParityHarnessCard,
): Promise<string> {
  return await sha256Hex(canonicalJson(sesStageCardInputFacts(card)));
}

/** One row of the frozen disputed manifest. */
export interface SesStageDisputedCard {
  job_ref: string;
  job_id: string;
  ses_family: string;
  /** Legacy ladder + currently binding overlay — the column shown today. */
  current: string;
  /** Uncorrected pure M1 standing alone. */
  newer_pure: string;
  /** Pure M1 with the existing overlay ledger re-applied — the cutover column. */
  post_cutover: string;
  /** Whether the overlay would still bind after a cutover. */
  post_cutover_overlay_binds: boolean;
  overlay_present: boolean;
  overlay_binds_today: boolean;
  legacy_branch: string;
  divergence_cause: string;
  input_hash: string;
}

export interface SesStageBaseline {
  contract_version: string;
  /** Content hash over the whole measured population. Reproducible by design. */
  generation_id: string;
  /** Content hash over the disputed manifest alone. */
  disputed_manifest_id: string;
  /** Wall clock of the read. Differs per run BY DESIGN; not in either id. */
  snapshot_at: string;
  population_contract_version: string;
  population_contract: string;
  /** Source identity of the engines that produced this reading (advisory). */
  engine_fingerprints: Record<string, string>;
  board_cards: number;
  /** Counts the harness itself summarised, carried for side-by-side reporting. */
  counts: {
    legacy_canonical_column_counts: Record<string, number>;
    m1_pure_column_counts: Record<string, number>;
    post_cutover_column_counts: Record<string, number>;
    cards_changing_column_m1_pure_vs_legacy_canonical: number;
    cards_changing_column_after_cutover_with_overlays_reapplied: number;
    overlays_total: number;
    overlays_binding_today: number;
    overlays_binding_today_that_would_unbind: number;
  };
  /** Every measured card's identity + input hash, sorted by job_id. */
  cards: Array<{ job_id: string; job_ref: string; input_hash: string }>;
  /** The exact disputed manifest, sorted by job_ref. */
  disputed: SesStageDisputedCard[];
}

function sortByJobId<T extends { job_id: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) =>
    a.job_id < b.job_id ? -1 : a.job_id > b.job_id ? 1 : 0
  );
}

function sortByJobRef<T extends { job_ref: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) =>
    a.job_ref < b.job_ref ? -1 : a.job_ref > b.job_ref ? 1 : 0
  );
}

export async function buildSesStageBaseline(
  parity: ParityHarnessOutput,
  engineFingerprints: Record<string, string> = {},
): Promise<SesStageBaseline> {
  const cards: Array<{ job_id: string; job_ref: string; input_hash: string }> =
    [];
  const disputed: SesStageDisputedCard[] = [];
  for (const card of parity.cards || []) {
    const inputHash = await sesStageCardInputHash(card);
    cards.push({
      job_id: String(card.job_id),
      job_ref: String(card.job_ref),
      input_hash: inputHash,
    });
    if (card.legacy_canonical_stage !== card.post_cutover_stage) {
      disputed.push({
        job_ref: String(card.job_ref),
        job_id: String(card.job_id),
        ses_family: String(card.ses_family || ""),
        current: card.legacy_canonical_stage,
        newer_pure: card.m1_pure,
        post_cutover: card.post_cutover_stage,
        post_cutover_overlay_binds: card.post_cutover_overlay_binds === true,
        overlay_present: card.overlay?.present === true,
        overlay_binds_today: card.overlay?.binds_today === true,
        legacy_branch: card.legacy_branch,
        divergence_cause: card.divergence_cause,
        input_hash: inputHash,
      });
    }
  }
  const sortedCards = sortByJobId(cards);
  const sortedDisputed = sortByJobRef(disputed);
  const summary = parity.summary || {};
  return {
    contract_version: SES_STAGE_BASELINE_CONTRACT_VERSION,
    generation_id: await sha256Hex(canonicalJson({
      contract_version: SES_STAGE_BASELINE_CONTRACT_VERSION,
      population_contract_version: parity.population_contract_version,
      cards: sortedCards,
    })),
    disputed_manifest_id: await sha256Hex(canonicalJson({
      contract_version: SES_STAGE_BASELINE_CONTRACT_VERSION,
      disputed: sortedDisputed.map((row) => ({
        job_ref: row.job_ref,
        current: row.current,
        post_cutover: row.post_cutover,
      })),
    })),
    snapshot_at: parity.computed_at,
    population_contract_version: parity.population_contract_version,
    population_contract: parity.population_contract,
    engine_fingerprints: engineFingerprints,
    board_cards: Number(parity.board_cards ?? sortedCards.length),
    counts: {
      legacy_canonical_column_counts: summary.legacy_canonical_column_counts ??
        {},
      m1_pure_column_counts: summary.m1_pure_column_counts ?? {},
      post_cutover_column_counts: summary.post_cutover_column_counts ?? {},
      cards_changing_column_m1_pure_vs_legacy_canonical: Number(
        summary.cards_changing_column_m1_pure_vs_legacy_canonical ?? 0,
      ),
      cards_changing_column_after_cutover_with_overlays_reapplied: Number(
        summary.cards_changing_column_after_cutover_with_overlays_reapplied ??
          0,
      ),
      overlays_total: Number(summary.overlays_total ?? 0),
      overlays_binding_today: Number(summary.overlays_binding_today ?? 0),
      overlays_binding_today_that_would_unbind: Number(
        summary.overlays_binding_today_that_would_unbind ?? 0,
      ),
    },
    cards: sortedCards,
    disputed: sortedDisputed,
  };
}

export interface SesStageBaselineVerification {
  ok: boolean;
  /** Hard failures: a frozen identity or a frozen adjudication went missing. */
  failures: string[];
  /** Reported, never failed: the board legitimately grows between snapshots. */
  observations: string[];
  frozen_generation_id: string;
  fresh_generation_id: string;
  frozen_disputed_manifest_id: string;
  fresh_disputed_manifest_id: string;
  frozen_disputed: number;
  fresh_disputed: number;
  cards_with_moved_input_hash: string[];
  disputed_missing: string[];
  disputed_changed: Array<{
    job_ref: string;
    frozen: string;
    fresh: string;
  }>;
  disputed_added: string[];
}

/**
 * Compares a fresh baseline against the frozen one.
 *
 * A hash difference is NOT a failure on its own — the input hash exists to tell
 * an apply "this card moved, re-read it", and between two production snapshots
 * some cards legitimately move. The failures are the ones the freeze exists to
 * catch: a measured card that disappeared, a frozen disputed card that is no
 * longer disputed or lands somewhere new, or a different denominator.
 */
export function verifySesStageBaseline(
  frozen: SesStageBaseline,
  fresh: SesStageBaseline,
): SesStageBaselineVerification {
  const failures: string[] = [];
  const observations: string[] = [];

  if (frozen.contract_version !== fresh.contract_version) {
    failures.push(
      `baseline contract version changed: ${frozen.contract_version} -> ${fresh.contract_version}`,
    );
  }
  if (
    frozen.population_contract_version !== fresh.population_contract_version
  ) {
    failures.push(
      `population contract changed: ${frozen.population_contract_version} -> ${fresh.population_contract_version}; the denominator is not comparable`,
    );
  }

  const freshById = new Map(fresh.cards.map((c) => [c.job_id, c]));
  const frozenById = new Map(frozen.cards.map((c) => [c.job_id, c]));
  const movedHash: string[] = [];
  for (const card of frozen.cards) {
    const now = freshById.get(card.job_id);
    if (!now) {
      failures.push(
        `certified card ${card.job_ref} is absent from the fresh population`,
      );
      continue;
    }
    if (now.input_hash !== card.input_hash) movedHash.push(card.job_ref);
  }
  const added = fresh.cards.filter((c) => !frozenById.has(c.job_id));
  if (added.length > 0) {
    observations.push(
      `${added.length} card(s) entered the population since the freeze: ${
        added.map((c) => c.job_ref).sort().join(", ")
      }`,
    );
  }
  if (movedHash.length > 0) {
    observations.push(
      `${movedHash.length} card(s) changed input facts since the freeze: ${
        movedHash.slice().sort().join(", ")
      }`,
    );
  }

  const freshDisputed = new Map(fresh.disputed.map((d) => [d.job_ref, d]));
  const frozenDisputed = new Map(frozen.disputed.map((d) => [d.job_ref, d]));
  const missing: string[] = [];
  const changed: Array<{ job_ref: string; frozen: string; fresh: string }> = [];
  for (const row of frozen.disputed) {
    const now = freshDisputed.get(row.job_ref);
    if (!now) {
      missing.push(row.job_ref);
      failures.push(
        `certified disputed card ${row.job_ref} (${row.current} -> ${row.post_cutover}) is no longer disputed`,
      );
      continue;
    }
    if (now.current !== row.current || now.post_cutover !== row.post_cutover) {
      changed.push({
        job_ref: row.job_ref,
        frozen: `${row.current} -> ${row.post_cutover}`,
        fresh: `${now.current} -> ${now.post_cutover}`,
      });
      failures.push(
        `certified disputed card ${row.job_ref} changed adjudication: ${row.current} -> ${row.post_cutover} became ${now.current} -> ${now.post_cutover}`,
      );
    }
  }
  const disputedAdded = fresh.disputed
    .filter((d) => !frozenDisputed.has(d.job_ref))
    .map((d) => d.job_ref)
    .sort();
  if (disputedAdded.length > 0) {
    observations.push(
      `${disputedAdded.length} card(s) became disputed after the freeze: ${
        disputedAdded.join(", ")
      }`,
    );
  }

  for (const [key, frozenValue] of Object.entries(frozen.engine_fingerprints)) {
    const freshValue = fresh.engine_fingerprints[key];
    if (freshValue && freshValue !== frozenValue) {
      observations.push(
        `engine source ${key} changed since the freeze (${
          frozenValue.slice(0, 12)
        } -> ${freshValue.slice(0, 12)})`,
      );
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    observations,
    frozen_generation_id: frozen.generation_id,
    fresh_generation_id: fresh.generation_id,
    frozen_disputed_manifest_id: frozen.disputed_manifest_id,
    fresh_disputed_manifest_id: fresh.disputed_manifest_id,
    frozen_disputed: frozen.disputed.length,
    fresh_disputed: fresh.disputed.length,
    cards_with_moved_input_hash: movedHash.slice().sort(),
    disputed_missing: missing.sort(),
    disputed_changed: changed,
    disputed_added: disputedAdded,
  };
}
