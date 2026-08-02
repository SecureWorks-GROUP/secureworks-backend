// Scoped route to the existing U2 identity-spine seeder.
//
// WHY A SECOND ACTION RATHER THAN A FLAG ON `makesafe_state_seed`.
// `makesafe_state_seed` is the full-board bootstrap: the server selects the
// whole canonical board and the caller cannot narrow it, precisely so a
// convenient subset can never be dressed up as a completed board. Its
// acceptance gate is board-wide (zero `projection_input_error` cards plus a
// clean U4 canary). Adding a caller-chosen subset to that action would weaken a
// board-wide gate to prove a handful of cards.
//
// The scoped run is a DIFFERENT operation with a different promise, so it gets
// a different name. It repairs a named, hand-adjudicated tranche and it can
// never claim board completeness: every response carries
// `board_complete: false`, and the batch is hard-capped well below the board.
// Both actions call the SAME producer — `seed_makesafe_state_authority_scoped_v2`
// (`20260729000000_makesafe_state_seed_scope_accounting.sql`), which is already
// built to take an explicit job list and to partition every requested job into
// seeded / missing / out-of-scope with an append-only ledger row. Nothing here
// mints identity itself.
//
// Cards are named by JOB NUMBER, not job id. The operator adjudicates cards by
// the reference printed on the board, and a job number that does not resolve is
// refused loudly instead of a mistyped uuid silently selecting another card.

/** Selection contract published in the response and hashed into the run. */
export const MAKESAFE_STATE_SEED_SCOPE_CONTRACT =
  "makesafe-state-authority-seed-scoped.v1";

/**
 * Hard batch ceiling. The full board is ~437 cards, so this can never be a
 * sweep: reaching the whole board would take 18 separately authorised run keys,
 * each with its own ledger row. That inconvenience is the point — the sweep has
 * its own action and its own board-wide gate.
 */
export const MAKESAFE_STATE_SEED_SCOPE_MAX_CARDS = 25;

const LIVE_CASE_STATES = new Set(["confirmed_live_job", "blocked_live_job"]);

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : "";
}

export interface MakesafeStateSeedScopeRequest {
  jobNumbers: string[];
  runKey: string;
  dryRun: boolean;
}

export type MakesafeStateSeedScopeRequestResult =
  | { ok: true; request: MakesafeStateSeedScopeRequest }
  | { ok: false; status: number; error: string };

/**
 * Validate the caller's body. Nothing here reads the database, so an invalid
 * request is refused before any production row is touched.
 */
export function normalizeMakesafeStateSeedScopeRequest(
  body: unknown,
): MakesafeStateSeedScopeRequestResult {
  const record = (body ?? {}) as Record<string, unknown>;
  const dryRun = record.dry_run !== false;
  const rawNumbers = record.job_numbers;
  if (!Array.isArray(rawNumbers)) {
    return {
      ok: false,
      status: 400,
      error: "job_numbers must be an array of SES job numbers",
    };
  }
  const jobNumbers: string[] = [];
  for (const entry of rawNumbers) {
    if (typeof entry !== "string") {
      return {
        ok: false,
        status: 400,
        error: "job_numbers must contain only job number strings",
      };
    }
    const value = entry.trim();
    if (!value) {
      return {
        ok: false,
        status: 400,
        error: "job_numbers must not contain a blank job number",
      };
    }
    // A duplicate is a selection mistake, not something to silently absorb:
    // the RPC counts distinct jobs and would reject the array anyway.
    if (jobNumbers.includes(value)) {
      return {
        ok: false,
        status: 400,
        error: `job_numbers contains ${value} more than once`,
      };
    }
    jobNumbers.push(value);
  }
  if (jobNumbers.length === 0) {
    return {
      ok: false,
      status: 400,
      error: "job_numbers must name at least one card",
    };
  }
  if (jobNumbers.length > MAKESAFE_STATE_SEED_SCOPE_MAX_CARDS) {
    return {
      ok: false,
      status: 400,
      error:
        `a scoped seed is capped at ${MAKESAFE_STATE_SEED_SCOPE_MAX_CARDS} cards; use makesafe_state_seed for the whole board`,
    };
  }
  const runKey = text(record.run_key);
  if (!dryRun && !runKey) {
    return {
      ok: false,
      status: 400,
      error: "run_key is required for a live scoped seed",
    };
  }
  if (runKey.length > 160) {
    return { ok: false, status: 400, error: "run_key is too long" };
  }
  return { ok: true, request: { jobNumbers, runKey, dryRun } };
}

export interface MakesafeStateSeedScopeJobRow {
  id?: unknown;
  job_number?: unknown;
  type?: unknown;
  metadata?: unknown;
}

/**
 * Preview mirror of the RPC's own scope guard
 * (`20260729000000_makesafe_state_seed_scope_accounting.sql`: `j.type =
 * 'makesafe' OR (j.type = 'insurance' AND metadata->>'insurance_job_type' =
 * 'restoration')`).
 *
 * This is a PREVIEW ONLY. On a live run the RPC re-classifies every id under
 * `FOR SHARE` and its answer is authoritative; the caller is told when the two
 * disagree rather than this copy being trusted.
 */
export function isCanonicalSeedScopeJob(
  row: MakesafeStateSeedScopeJobRow,
): boolean {
  const type = text(row.type);
  if (type === "makesafe") return true;
  if (type !== "insurance") return false;
  const metadata = (row.metadata ?? {}) as Record<string, unknown>;
  return text(metadata.insurance_job_type) === "restoration";
}

export interface MakesafeStateSeedScopeSelection {
  job_number: string;
  job_id: string;
}

export interface MakesafeStateSeedScopeOutOfScope {
  job_number: string;
  job_id: string;
  observed_type: string;
  observed_insurance_job_type: string | null;
}

export interface MakesafeStateSeedScopePlan {
  selected: MakesafeStateSeedScopeSelection[];
  unknown_job_numbers: string[];
  out_of_scope: MakesafeStateSeedScopeOutOfScope[];
  ambiguous_job_numbers: string[];
}

/**
 * Resolve requested job numbers against the rows actually read from `jobs`.
 * Every requested number lands in exactly one bucket, so the caller can always
 * account for what it asked for.
 */
export function resolveMakesafeStateSeedScope(
  jobNumbers: readonly string[],
  rows: readonly MakesafeStateSeedScopeJobRow[],
): MakesafeStateSeedScopePlan {
  const byNumber = new Map<string, MakesafeStateSeedScopeJobRow[]>();
  for (const row of rows) {
    const number = text(row.job_number);
    if (!number) continue;
    const bucket = byNumber.get(number);
    if (bucket) bucket.push(row);
    else byNumber.set(number, [row]);
  }
  const plan: MakesafeStateSeedScopePlan = {
    selected: [],
    unknown_job_numbers: [],
    out_of_scope: [],
    ambiguous_job_numbers: [],
  };
  for (const jobNumber of jobNumbers) {
    const matches = byNumber.get(jobNumber) || [];
    if (matches.length === 0) {
      plan.unknown_job_numbers.push(jobNumber);
      continue;
    }
    // Two cards sharing a job number is recorded ambiguity, not a card to pick
    // between. Refuse it here rather than seeding an arbitrary one.
    if (matches.length > 1) {
      plan.ambiguous_job_numbers.push(jobNumber);
      continue;
    }
    const row = matches[0];
    const jobId = text(row.id);
    if (!jobId) {
      plan.unknown_job_numbers.push(jobNumber);
      continue;
    }
    if (!isCanonicalSeedScopeJob(row)) {
      const metadata = (row.metadata ?? {}) as Record<string, unknown>;
      plan.out_of_scope.push({
        job_number: jobNumber,
        job_id: jobId,
        observed_type: text(row.type),
        observed_insurance_job_type: text(metadata.insurance_job_type) || null,
      });
      continue;
    }
    plan.selected.push({ job_number: jobNumber, job_id: jobId });
  }
  return plan;
}

export interface SesSpineCaseRow {
  state?: unknown;
  lineage_id?: unknown;
  instruction_key?: unknown;
  source_content_hash?: unknown;
}

export interface SesSpineIdentityRow {
  authority_kind?: unknown;
  lineage_id?: unknown;
  source_instruction_id?: unknown;
  source_content_hash?: unknown;
}

export interface SesSpineFacts {
  job_number: string;
  job_id: string;
  live_case_count: number;
  identity_authority_kind: string | null;
  lineage_id_present: boolean;
  source_instruction_present: boolean;
  source_content_hash_present: boolean;
  spine_complete: boolean;
}

/**
 * Diagnostic mirror of the three identity terms U4 reads
 * (`ses_assembler_input_adapter.ts` `buildSesAssemblerInput`) and of the
 * conditions that raise `spine_missing_source` / `spine_missing_lineage`
 * (`ses_prepare_docket_revision.ts`).
 *
 * `spine_missing_lineage` is misleadingly named: its condition is
 * `!lineage_id || !job_id || !source_content_hash`. On the SES board the term
 * that is actually absent is almost always `source_content_hash`, not lineage.
 *
 * This is a REPORTING aid so a run can show its own before/after. It is not a
 * second status engine and nothing branches on it — the authoritative check
 * remains a U4 `dry_run` prepare. `ses_spine_diagnostic_parity_test.ts` pins it
 * against the real adapter so the two cannot drift.
 */
export function deriveSesSpineFacts(input: {
  job_id: string;
  job_number: string;
  cases: readonly SesSpineCaseRow[];
  identity_revision: SesSpineIdentityRow | null | undefined;
}): SesSpineFacts {
  const liveCases = input.cases.filter((item) =>
    LIVE_CASE_STATES.has(text(item.state))
  );
  // `sourceCase()`: zero or two live cases are both "no authority", because
  // recorded ambiguity is not authority.
  const sourceCase = liveCases.length === 1 ? liveCases[0] : null;
  const revision =
    text(input.identity_revision?.authority_kind) === "unresolved_authority"
      ? null
      : input.identity_revision || null;
  const lineageId = text(sourceCase?.lineage_id) ||
    text(revision?.lineage_id);
  const sourceInstruction = text(sourceCase?.instruction_key) ||
    text(revision?.source_instruction_id);
  const sourceContentHash = text(sourceCase?.source_content_hash) ||
    text(revision?.source_content_hash);
  const jobId = text(input.job_id);
  return {
    job_number: input.job_number,
    job_id: jobId,
    live_case_count: liveCases.length,
    identity_authority_kind: text(input.identity_revision?.authority_kind) ||
      null,
    lineage_id_present: Boolean(lineageId),
    source_instruction_present: Boolean(sourceInstruction),
    source_content_hash_present: Boolean(sourceContentHash),
    spine_complete: Boolean(
      lineageId && jobId && sourceContentHash && sourceInstruction,
    ),
  };
}

export interface MakesafeStateSeedScopeRpcCheck {
  agrees: boolean;
  requested: number;
  seeded: number;
  skipped: number;
  error: string | null;
}

/**
 * Check the RPC's own accounting against what this action asked it to do. The
 * RPC is the authority on scope; this only proves it answered for the exact
 * selection sent, so a partial or re-classified run is visible instead of being
 * reported as a clean seed.
 */
export function checkMakesafeStateSeedScopeResult(
  result: Record<string, unknown> | null | undefined,
  expectedRequested: number,
): MakesafeStateSeedScopeRpcCheck {
  const number = (value: unknown): number | null =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? value
      : null;
  const requested = number(result?.requested);
  const accounted = number(result?.accounted);
  const seeded = number(result?.seeded);
  const skipped = number(result?.skipped);
  if (
    requested === null || accounted === null || seeded === null ||
    skipped === null
  ) {
    return {
      agrees: false,
      requested: 0,
      seeded: 0,
      skipped: 0,
      error: "scoped seed returned invalid accounting",
    };
  }
  if (requested !== expectedRequested) {
    return {
      agrees: false,
      requested,
      seeded,
      skipped,
      error:
        `scoped seed accounted for ${requested} jobs but ${expectedRequested} were selected`,
    };
  }
  if (accounted !== requested || seeded + skipped !== accounted) {
    return {
      agrees: false,
      requested,
      seeded,
      skipped,
      error: "scoped seed did not partition every selected job exactly once",
    };
  }
  if (skipped !== 0) {
    return {
      agrees: false,
      requested,
      seeded,
      skipped,
      error: `scoped seed skipped ${skipped} selected job${skipped === 1 ? "" : "s"}`,
    };
  }
  return { agrees: true, requested, seeded, skipped, error: null };
}
