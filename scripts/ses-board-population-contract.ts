/**
 * SES board POPULATION CONTRACT — the named denominator every SES measurement
 * reports itself against.
 *
 * Why this file exists: the same board predicate was hand-written in each
 * harness. A measurement that does not name its denominator can be true and
 * useless — every count in this campaign silently omits the cancelled cards,
 * and nobody said so until a red-team read it out of the SQL
 * (plan v2 §C.5, "What 'the whole board' means").
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS CONTRACT IS NOT FINAL. DO NOT TREAT `active-v1` AS THE RATIFIED BOARD.
 *
 * Captain decision C.5 is OPEN. It asks whether "the board" means the ~407
 * ACTIVE cards or all ~440 INCLUDING the ~33 cancelled ones. The recommended
 * answer on file is "certify the active board, and certify cancelled separately
 * with its own smaller floor", but no ruling has been recorded.
 *
 * Until C.5 is answered:
 *   - `SES_BOARD_POPULATION_ACTIVE_V1` is the DEFAULT because it is exactly the
 *     predicate the harnesses already ran. Naming it changes no measured number.
 *   - Nothing here, and nothing consuming this, may claim to cover
 *     "the whole board". `describeSesBoardPopulation()` deliberately renders the
 *     scope caveat alongside the version so a downstream reader cannot quote a
 *     count without also getting its denominator.
 *   - When C.5 lands, add the ruled contract as a NEW versioned entry (e.g.
 *     `all-including-cancelled-v2`) and switch `SES_BOARD_POPULATION_CONTRACT`.
 *     Do NOT edit `active-v1` in place: past measurements carry this version
 *     string and must stay attributable to the population that produced them,
 *     the same way `SES_EVIDENCE_CONTRACT_VERSION` keeps a ruler reading
 *     attributable to its ruler.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The predicate itself mirrors ops-api `makesafePipeline` with `history=all`:
 * make-safe-typed jobs, restoration insurance jobs, and any job carrying a
 * `makesafe_job_details` row; minus cancelled/lost; minus terminal synthetic
 * live-fire cards. It is SQL-fragment-shaped rather than a row predicate because
 * both consumers bound the read at the database, which is what keeps a
 * measurement from ever loading a card outside its own denominator.
 */

export interface SesBoardPopulationContract {
  /** Stable identifier recorded in every measurement artifact. */
  readonly version: string;
  /** One-line human summary, rendered next to the version. */
  readonly summary: string;
  /**
   * The open Captain decision that may replace this contract, or null once a
   * ruling has been recorded. A non-null value means NO artifact produced under
   * this contract may be described as covering "the whole board".
   */
  readonly pending_captain_decision: string | null;
  /** Job statuses excluded from the population. */
  readonly excluded_job_statuses: readonly string[];
}

/**
 * The population the SES harnesses have measured all along: active cards only.
 * ~407 cards at 2026-08-01, with ~33 cancelled cards outside it.
 */
export const SES_BOARD_POPULATION_ACTIVE_V1: SesBoardPopulationContract = {
  version: "ses-board-population/active-v1",
  summary:
    "make-safe-typed jobs, restoration insurance jobs, and any job with a " +
    "makesafe_job_details row; excludes cancelled/lost and terminal synthetic " +
    "live-fire cards. Cancelled cards are OUTSIDE this denominator.",
  // Non-null: C.5 is open, so this is a default, not a ratified board.
  pending_captain_decision: "C.5 (active-only vs all-including-cancelled)",
  excluded_job_statuses: ["cancelled", "lost"],
};

/**
 * The contract the harnesses consume. Switch this — never edit a versioned
 * entry in place — when C.5 is ruled.
 */
export const SES_BOARD_POPULATION_CONTRACT: SesBoardPopulationContract =
  SES_BOARD_POPULATION_ACTIVE_V1;

/** Convenience alias for artifacts that record only the version string. */
export const SES_BOARD_POPULATION_CONTRACT_VERSION =
  SES_BOARD_POPULATION_CONTRACT.version;

function excludedStatusList(
  contract: SesBoardPopulationContract,
): string {
  return contract.excluded_job_statuses.map((s) => `'${s}'`).join(",");
}

/**
 * The status half of the contract, for a query already joined to `jobs`.
 *
 * @param alias the `jobs` alias in the caller's SQL
 */
export function sesBoardStatusPredicate(
  alias = "j",
  contract: SesBoardPopulationContract = SES_BOARD_POPULATION_CONTRACT,
): string {
  return `${alias}.status not in (${excludedStatusList(contract)})`;
}

/**
 * The membership half: what makes a job an SES board card at all.
 *
 * @param alias the `jobs` alias in the caller's SQL
 * @param detailAlias a `makesafe_job_details` alias that must not collide with
 *   one already bound in the caller's statement
 */
export function sesBoardMembershipPredicate(
  alias = "j",
  detailAlias = "d",
): string {
  return `(
    ${alias}.type = 'makesafe'
    or (${alias}.type = 'insurance' and ${alias}.metadata->>'insurance_job_type' = 'restoration')
    or exists (select 1 from makesafe_job_details ${detailAlias} where ${detailAlias}.job_id = ${alias}.id)
  )`;
}

/**
 * The synthetic-live-fire exclusion. Terminal synthetic cards are permanently
 * release-blocked and must never enter a board measurement.
 */
export function sesBoardSyntheticExclusionPredicate(alias = "j"): string {
  return `not exists (
    select 1 from ses_synthetic_livefire_runs r
    where r.state = 'terminal' and r.job_ids ? ${alias}.id::text
  )`;
}

/**
 * The full population predicate, for a `from jobs {alias}` select.
 *
 * `includeSyntheticExclusion` is false for board-SCOPED joins (evidence rows
 * hanging off a card), which have always relied on the card set itself already
 * being bounded — keeping that shape is what makes naming the contract a pure
 * refactor with no measured-number movement.
 */
export function sesBoardPopulationPredicate(options: {
  alias?: string;
  detailAlias?: string;
  includeSyntheticExclusion?: boolean;
  contract?: SesBoardPopulationContract;
} = {}): string {
  const {
    alias = "j",
    detailAlias = "d",
    includeSyntheticExclusion = true,
    contract = SES_BOARD_POPULATION_CONTRACT,
  } = options;
  const clauses = [
    sesBoardStatusPredicate(alias, contract),
    sesBoardMembershipPredicate(alias, detailAlias),
  ];
  if (includeSyntheticExclusion) {
    clauses.push(sesBoardSyntheticExclusionPredicate(alias));
  }
  return clauses.join("\n  and ");
}

/**
 * Renders the contract for a run banner or an artifact header. Always emits the
 * pending-decision caveat when one is open, so a count can never be quoted as
 * "the whole board" by accident.
 */
export function describeSesBoardPopulation(
  contract: SesBoardPopulationContract = SES_BOARD_POPULATION_CONTRACT,
): string {
  const caveat = contract.pending_captain_decision
    ? ` [NOT FINAL — pending ${contract.pending_captain_decision}; ` +
      `this is not "the whole board"]`
    : "";
  return `${contract.version}${caveat}`;
}
