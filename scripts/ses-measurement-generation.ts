// deno-lint-ignore-file no-explicit-any
/**
 * SES measurement GENERATION self-description.
 *
 * Plan v2 write-safety rule D.0/3: every measurement emits `generation_id`,
 * `snapshot_at`, the population-contract version, the ruler version, and a
 * PER-CARD input hash. A later apply re-reads each target immediately before
 * writing and proceeds only while that card's hash still matches; on any
 * difference it skips with a reason code and writes nothing. Never force,
 * never best-effort.
 *
 * Two design decisions carry the whole mechanism, and both are easy to get
 * backwards:
 *
 * 1. `generation_id` is CONTENT-derived, never random and never clock-derived.
 *    The plan's independent-verification step is "a second agent re-runs the
 *    harness and reproduces the same generation hash" — which is only possible
 *    if the id is a function of the measured state. Two runs over an unchanged
 *    board produce the same `generation_id`; the differing `snapshot_at` is
 *    recorded alongside it, not inside it.
 *
 * 2. The per-card hash covers the card's INPUT facts, NOT the ruler's verdict.
 *    Hashing the verdict would make a ruler bump (Batch 1 raises
 *    `SES_EVIDENCE_CONTRACT_VERSION`) look like "every card changed
 *    underneath us", and an apply would skip the entire approved set for the
 *    wrong reason. Which ruler produced a reading is recorded separately, in
 *    `ruler_contract_version`. So: card state moves the hash; ruler opinion
 *    moves the version.
 *
 * Privacy: the hashed projection is an allow-list of structural facts —
 * families, stages, cycle counters, evidence presence booleans and counts. It
 * carries no client name, phone, email or street address, and it deliberately
 * omits the inventory's free-text `detail` provenance so that rewording a
 * measurement message cannot invalidate an approved apply set.
 */

import {
  SES_EVIDENCE_ITEMS,
  type SesEvidenceItem,
} from "../supabase/functions/ops-api/makesafe_evidence_requirements.ts";

/** The evidence-fact keys that enter the hash. `detail` is deliberately absent. */
const HASHED_FACT_KEYS = [
  "present",
  "substitute_present",
  "transit_record_without_artifact",
  "count",
] as const;

/**
 * Canonical JSON: object keys sorted at every depth, so two runs that build the
 * same facts in a different order still hash identically. Arrays keep their
 * order (it is meaningful); `undefined` is dropped so an absent optional and an
 * explicitly-undefined optional agree.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${
    entries
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(",")
  }}`;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The card facts an apply must see unchanged. Anything that can move a card's
 * family, its stage, or the evidence a verdict is read from belongs here;
 * anything that is the ruler's OPINION about those facts does not.
 */
export interface SesCardInputFacts {
  job_id: string;
  job_ref: string;
  job_status: string;
  archived: boolean;
  family: string | null;
  family_refusal: string | null;
  stage: string;
  computed_stage: string;
  display_overlay_stage: string | null;
  substatus: string | null;
  company_slug: string | null;
  cycle_number: number;
  reattend_boundary: boolean;
  completion_photo_count: number;
  evidence: Record<string, Record<string, unknown>>;
}

/** A measured card, in the shape both the C1 result and the C2 row satisfy. */
export interface HashableCard {
  job_id: string;
  job_ref: string;
  job_status?: string;
  archived?: boolean;
  family: string | null;
  family_refusal: string | null;
  stage: string;
  computed_stage: string;
  display_overlay_stage: string | null;
  substatus?: string | null;
  company_slug?: string | null;
  cycle_number: number;
  reattend_boundary: boolean;
  completion_photo_count: number;
  inventory: Record<string, any>;
}

/** Projects a measured card down to the privacy-safe facts that get hashed. */
export function sesCardInputFacts(card: HashableCard): SesCardInputFacts {
  const evidence: Record<string, Record<string, unknown>> = {};
  for (const item of SES_EVIDENCE_ITEMS as readonly SesEvidenceItem[]) {
    const fact = card.inventory?.[item] ?? {};
    const projected: Record<string, unknown> = {};
    for (const key of HASHED_FACT_KEYS) {
      if (fact[key] !== undefined) projected[key] = fact[key];
    }
    evidence[item] = projected;
  }
  return {
    job_id: String(card.job_id || ""),
    job_ref: String(card.job_ref || ""),
    job_status: String(card.job_status || ""),
    archived: card.archived === true,
    family: card.family ?? null,
    family_refusal: card.family_refusal ?? null,
    stage: String(card.stage || ""),
    computed_stage: String(card.computed_stage || ""),
    display_overlay_stage: card.display_overlay_stage ?? null,
    substatus: card.substatus ?? null,
    company_slug: card.company_slug ?? null,
    cycle_number: Number(card.cycle_number ?? 0),
    reattend_boundary: card.reattend_boundary === true,
    completion_photo_count: Number(card.completion_photo_count ?? 0),
    evidence,
  };
}

/** The per-card drift key an apply compares against before it writes. */
export async function sesCardInputHash(card: HashableCard): Promise<string> {
  return await sha256Hex(canonicalJson(sesCardInputFacts(card)));
}

export interface SesMeasurementGeneration {
  /** Content hash of this measurement. Equal across reruns of unchanged state. */
  generation_id: string;
  /** Wall clock of the read. Differs per run BY DESIGN and is not in the id. */
  snapshot_at: string;
  /** Which denominator was measured. */
  population_contract_version: string;
  /** Human-readable denominator, carrying any not-yet-ruled caveat. */
  population_contract: string;
  /** Which ruler produced the verdicts. */
  ruler_contract_version: string;
  /** Cards covered by this generation. */
  card_count: number;
}

/**
 * Builds the generation header.
 *
 * `cardHashes` is the per-card `{job_id, input_hash}` set. It is sorted by
 * job_id before hashing so read order — which PostgREST does not guarantee to
 * be stable forever — cannot change the generation id.
 */
export async function buildSesMeasurementGeneration(input: {
  snapshotAt: string;
  populationContractVersion: string;
  populationContract: string;
  rulerContractVersion: string;
  cardHashes: Array<{ job_id: string; input_hash: string }>;
}): Promise<SesMeasurementGeneration> {
  const sorted = [...input.cardHashes].sort((a, b) =>
    a.job_id < b.job_id ? -1 : a.job_id > b.job_id ? 1 : 0
  );
  const generationId = await sha256Hex(canonicalJson({
    population_contract_version: input.populationContractVersion,
    ruler_contract_version: input.rulerContractVersion,
    cards: sorted,
  }));
  return {
    generation_id: generationId,
    snapshot_at: input.snapshotAt,
    population_contract_version: input.populationContractVersion,
    population_contract: input.populationContract,
    ruler_contract_version: input.rulerContractVersion,
    card_count: sorted.length,
  };
}
