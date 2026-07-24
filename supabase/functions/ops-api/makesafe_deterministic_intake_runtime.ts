// DB-bound deterministic make-safe intake runtime.
// deno-lint-ignore-file no-explicit-any
//
// Reads a capped source window (a sweep half driven by a persisted received_at
// cursor plus a newest half) together with every allowlisted source by id before
// planning, so per-run cost is a constant while every in-window source is still
// eventually read. Live and dry-run runs each advance their own sweep cursor, so
// that guarantee holds separately in both modes: a live run never moves the
// dark-observe position and vice versa. Dry-run's only write is that observe
// cursor - it creates no case, draft, job, storage object or health state, and
// cutover evidence therefore comes from observation that covers the whole window.
// Live mode is reachable only through the DB-backed cutover switch and never
// falls back to AI.

import {
  buildDeterministicIntakePlan,
  DETERMINISTIC_INTAKE_VERSION,
  type DeterministicAttachment,
  type DeterministicCasePlan,
  type DeterministicCompanyProfile,
  type DeterministicIntakePlan,
  type DeterministicPdfDocument,
  type DeterministicSourceItem,
  selectIntakeMode,
} from "./makesafe_deterministic_intake.ts";
import { deriveFromDomain, isOwnDomain } from "./makesafe_compact_reads.ts";
import { stripEmailHtmlForTrade } from "./makesafe_email_links.ts";
import { isReportOnlyType } from "./makesafe_intake_gate.ts";
import {
  canonicalCompanyDedupeKey,
  canonicalExternalObligationRef,
  canonicalObligationPoCore,
  loadRefPrefixes,
} from "../_shared/makesafe_refs.ts";
import { extractPdfText, PDF_TEXT_MAX_BYTES } from "./makesafe_pdf_text.ts";

const DEFAULT_ORG_ID = "00000000-0000-0000-0000-000000000001";
const SES_MAILBOX = "ses@secureworkswa.com.au";

export type DeterministicSelectionMode = "exact" | "full_open";

export interface DeterministicRuntimeOptions {
  dryRun?: boolean;
  selectionMode?: DeterministicSelectionMode;
  days?: number;
  onlyUnscanned?: boolean;
  nowIso?: string;
  maxCases?: number;
  allowSourcePostIds?: readonly string[];
  allowInstructionKeys?: readonly string[];
  includeSanitizedCases?: boolean;
  requireAllAllowlistMatches?: boolean;
  maxSources?: number;
  approveDraft?: (client: any, body: any) => Promise<any>;
}

export interface DeterministicRolloutControls {
  mode: "legacy" | "deterministic";
  selectionMode: DeterministicSelectionMode;
  maxCases: number;
  sourcePostIds: readonly string[];
  instructionKeys: readonly string[];
}

export interface DeterministicIsolatedFailure {
  reason:
    | "fresh_multi_authority_merge"
    | "multiple_persisted_deliverables"
    | "state_mismatched_secondary_authority"
    | "persisted_authority_split_reconciliation_required"
    | "source_correction_identity_mismatch_reconciliation_required";
  source_post_ids: string[];
  persisted_case_ids: string[];
  planned_instruction_keys: string[];
}

// There is deliberately no backlog-sized runtime default. The DB starts at one,
// and both DB and runtime reject caps outside this explicit canary/batch bound.
const DEFAULT_MAX_CASES_PER_RUN = 1;
const MAX_CASES_PER_RUN = 10;
const MAX_ALLOWLIST_ITEMS = 50;
// Repeat failures must not spend the commit budget, but they still cost time, so
// one run stops after this many attempts regardless of how many committed.
const MAX_ATTEMPT_MULTIPLIER = 4;
// PostgREST caps an unranged response at 1000 rows, so batched source reads page
// below that cap rather than silently truncating.
const SOURCE_PAGE_SIZE = 500;
// A scheduled run reads at most this many window rows regardless of how large the
// mailbox has grown. Allowlisted sources are read separately by id, so a named
// source is still proved on every run even once it has aged out of the newest
// rows, and already-scanned rows inside the bound are still revisited.
const DEFAULT_MAX_SOURCES_PER_RUN = 500;
const MAX_SOURCES_PER_RUN = 2000;
// The bounded read is split sweep-first / newest-last. Newest-only truncation
// would bound cost but starve anything that ever falls behind the cap. The sweep
// half walks the window in received_at order from a cursor persisted across runs
// and restarts once it reaches the end, so progress never depends on a row being
// stamped: the vast majority of SES mail never settles a case and would otherwise
// hold the same oldest rows in front of the read forever.
const BACKLOG_READ_SHARE = 0.5;
const MAX_PDF_EXTRACTIONS_PER_RUN = 50;
const MAX_PDF_ATTACHMENTS_PER_SOURCE = 2;

export interface DeterministicRuntimeReport {
  ok: true;
  mode: "deterministic";
  completion_status: "completed" | "completed_degraded";
  dry_run: boolean;
  ai_enabled: false;
  ai_calls: 0;
  generated_at: string;
  days: number;
  totals: DeterministicIntakePlan["totals"] & {
    case_rows_created: number;
    source_rows_created: number;
    artifacts_created: number;
    drafts_created: number;
    jobs_created: number;
    resumed: number;
    write_failures: number;
    cases_attempted: number;
    cases_deferred: number;
    cases_failed: number;
    job_creation_deferred: number;
    components_failed: number;
    sources_quarantined: number;
  };
  // True when the run spent its attempt ceiling without committing a single case.
  // Repeat failures crowding out advanceable work is then visible, not silent.
  attempt_cap_reached_without_commit: boolean;
  selection: {
    mode: DeterministicSelectionMode;
    source_allowlist_count: number;
    instruction_allowlist_count: number;
    selected_cases: number;
    selected_sources: number;
    // Entries that genuinely did not resolve: every source id is read by id, and
    // every instruction key counted here either had its sources seeded by id or
    // came from an uncapped run that saw the whole window.
    unmatched_source_allowlist: number;
    unmatched_instruction_allowlist: number;
    // Instruction keys that a capped run could not have proved either way. These
    // are never reported as stale and never fail a run closed.
    cap_exposed_instruction_allowlist: number;
    quarantined_components: number;
    quarantined_sources: number;
  };
  // Per-run read bound. cap_reached means older rows in the window were not read
  // this run; allowlisted sources are read by id and are never dropped by it.
  source_read: {
    cap: number;
    backlog_cap: number;
    backlog_rows: number;
    recent_rows: number;
    window_rows: number;
    seed_rows: number;
    cap_reached: boolean;
    // Sweep timestamp this run started from and the one the next run starts from.
    // The internal post-id tie breaker is deliberately excluded: aggregate replay
    // responses must never disclose source identifiers.
    cursor_at: string | null;
    next_cursor_at: string | null;
  };
  // Evidence gates read this, not totals.unaccounted on its own. A capped run
  // only accounts for the rows it read, so its zero-unaccounted result is not a
  // statement about the window and must not count as clean dark-observe or
  // cutover evidence.
  evidence: {
    source_accounting_complete: boolean;
    zero_unaccounted_proved: boolean;
    caveats: string[];
  };
  identity_floor: {
    unit: "canonical_case";
    known_builder_work_candidates: number;
    reached: number;
    shortfall: number;
    percentage: number | null;
    formula: "reached / known_builder_work_candidates * 100";
    by_builder: Record<
      string,
      { candidates: number; reached: number; shortfall: number }
    >;
  };
  proposed_cases?: Array<{
    case_key_sha256: string;
    outcome: DeterministicCasePlan["state"];
    reason_code: DeterministicCasePlan["reasonCode"];
    builder: string;
    job_family: string | null;
    source_count: number;
    blocked_reasons: readonly string[];
    missing_fields: readonly string[];
    conflicting_field_names: string[];
    parent_relation: DeterministicCasePlan["parentRelation"];
    identity_evidence: {
      known_company: boolean;
      external_reference: boolean;
      builder_work_order: boolean;
      builder_purchase_order: boolean;
      client_name: boolean;
      site_address: boolean;
      designated_pdf: boolean;
    };
  }>;
  by_builder_and_outcome: Record<string, Record<string, number>>;
  by_builder_and_reason: Record<string, Record<string, number>>;
  // Non-PII failure classification. Keys are message classes, never source content.
  write_failure_reasons: Record<string, number>;
  // Independent lineage components rejected before writes. Source and case ids
  // are structural coordinates only; no subject/body/address content is exposed.
  isolated_failures: DeterministicIsolatedFailure[];
  // Storage read/write blockers observed this run, in first-seen order. These are
  // bucket-level failures, not credential problems, and every distinct one is kept.
  storage_blockers: string[];
}

// Maps a thrown failure onto a small fixed vocabulary. Nothing derived from
// source bodies, subjects, or identity values is retained.
function classifyWriteFailure(error: unknown): string {
  const code = (error as any)?.code;
  const message = String((error as any)?.message || error || "");
  if (/attachment staging failed/i.test(message)) return "attachment_staging";
  if (/lineage parent is not persisted/i.test(message)) {
    return "lineage_parent_pending";
  }
  if (/approval prevalidation failed/i.test(message)) {
    return "approval_validation";
  }
  if (/approval returned no job id/i.test(message)) return "approval_no_job";
  if (/no job link; reconciliation required/i.test(message)) {
    return "approved_draft_unlinked";
  }
  if (/draft insert failed/i.test(message)) return "draft_insert";
  if (/case insert failed/i.test(message)) return "case_insert";
  if (/case update failed/i.test(message)) return "case_update";
  if (/transition is not allowed/i.test(message)) {
    return "case_transition_not_allowed";
  }
  if (/source accounting failed/i.test(message)) return "source_accounting";
  if (/lineage parent read failed/i.test(message)) return "lineage_parent_read";
  if (code) return `postgres_${String(code)}`;
  return "unclassified";
}

export async function loadDeterministicIntakeMode(
  client: any,
): Promise<"legacy" | "deterministic"> {
  const { data, error } = await client.from("makesafe_cron_settings")
    .select("intake_mode")
    .eq("id", true)
    .maybeSingle();
  if (error) {
    // Pre-migration safe only for the known missing-column shape. Any network,
    // auth, timeout, or other read failure aborts the scan: it must never turn a
    // configured deterministic deployment into a silent legacy/AI fallback.
    if (
      String(error.code || "") === "42703" ||
      /intake_mode.*(?:does not exist|schema cache|column)/i.test(
        error.message || "",
      )
    ) return "legacy";
    throw new Error(`intake mode read failed: ${error.message || error}`);
  }
  return selectIntakeMode(data?.intake_mode);
}

function exactAllowlist(values: unknown, label: string): string[] {
  if (!Array.isArray(values) || values.length > MAX_ALLOWLIST_ITEMS) {
    throw new Error(
      `${label} must be an array of at most ${MAX_ALLOWLIST_ITEMS} exact values`,
    );
  }
  const result = values.map((value) => String(value));
  if (result.some((value) => !value.trim() || value !== value.trim())) {
    throw new Error(`${label} contains an empty or non-canonical value`);
  }
  if (new Set(result).size !== result.length) {
    throw new Error(`${label} contains duplicate values`);
  }
  return result;
}

/** Reads rollout authority from the single DB settings row. An old schema may
 * continue in legacy mode, but deterministic mode is never allowed to run when
 * the cap/allowlist columns cannot be proved. */
export async function loadDeterministicRolloutControls(
  client: any,
): Promise<DeterministicRolloutControls> {
  const columns = [
    "intake_mode",
    "deterministic_selection_mode",
    "deterministic_max_cases_per_run",
    "deterministic_source_allowlist",
    "deterministic_instruction_allowlist",
  ].join(",");
  const { data, error } = await client.from("makesafe_cron_settings")
    .select(columns)
    .eq("id", true)
    .maybeSingle();
  if (error) {
    const missingControls = String(error.code || "") === "42703" ||
      /deterministic_(?:selection_mode|max_cases_per_run|source_allowlist|instruction_allowlist).*(?:does not exist|schema cache|column)/i
        .test(error.message || "");
    if (!missingControls) {
      throw new Error(
        `deterministic rollout controls read failed: ${error.message || error}`,
      );
    }
    const mode = await loadDeterministicIntakeMode(client);
    if (mode === "deterministic") {
      throw new Error(
        "deterministic mode is set but DB rollout controls are unavailable",
      );
    }
    return {
      mode: "legacy",
      selectionMode: "exact",
      maxCases: 1,
      sourcePostIds: [],
      instructionKeys: [],
    };
  }
  const mode = selectIntakeMode(data?.intake_mode);
  const selectionMode = data?.deterministic_selection_mode;
  if (selectionMode !== "exact" && selectionMode !== "full_open") {
    throw new Error(
      "deterministic selection mode must be exact or full_open",
    );
  }
  const maxCases = Number(data?.deterministic_max_cases_per_run);
  if (
    !Number.isInteger(maxCases) || maxCases < 1 || maxCases > MAX_CASES_PER_RUN
  ) {
    throw new Error(
      `deterministic rollout cap must be an integer between 1 and ${MAX_CASES_PER_RUN}`,
    );
  }
  const sourcePostIds = exactAllowlist(
    data?.deterministic_source_allowlist,
    "deterministic source allowlist",
  );
  const instructionKeys = exactAllowlist(
    data?.deterministic_instruction_allowlist,
    "deterministic instruction allowlist",
  );
  const hasAllowlist = sourcePostIds.length > 0 || instructionKeys.length > 0;
  if (selectionMode === "full_open" && hasAllowlist) {
    throw new Error(
      "deterministic full_open mode requires empty exact allowlists",
    );
  }
  if (mode === "deterministic" && selectionMode === "exact" && !hasAllowlist) {
    throw new Error(
      "deterministic exact mode requires a non-empty exact allowlist",
    );
  }
  return {
    mode,
    selectionMode,
    maxCases,
    sourcePostIds,
    instructionKeys,
  };
}

// Pages like fetchAll but never reads more than `cap` rows, so a caller's read
// cost is a constant it chose rather than a function of how much history matches.
async function fetchCapped(
  cap: number,
  queryFactory: (from: number, to: number) => Promise<any>,
): Promise<any[]> {
  const rows: any[] = [];
  while (rows.length < cap) {
    const size = Math.min(SOURCE_PAGE_SIZE, cap - rows.length);
    const result = await queryFactory(rows.length, rows.length + size - 1);
    if (result.error) {
      throw new Error(result.error.message || String(result.error));
    }
    const page = result.data || [];
    rows.push(...page);
    if (page.length < size) break;
  }
  return rows.slice(0, cap);
}

// Graph post ids and deterministic instruction keys are long. Keep PostgREST
// .in() URLs comfortably below gateway limits rather than batching by a
// row-count that is safe only for UUIDs.
function chunk<T>(values: readonly T[], size = 25): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < values.length; i += size) {
    result.push(values.slice(i, i + size) as T[]);
  }
  return result;
}

function linksFromBody(
  postId: string,
  body: string | null,
): Array<{ url: string; label: null; sourcePostId: string }> {
  const found = new Set<string>();
  for (const match of String(body || "").matchAll(/https:\/\/[^\s<>"']+/gi)) {
    found.add(match[0].replace(/[),.;]+$/, ""));
  }
  return [...found].map((url) => ({ url, label: null, sourcePostId: postId }));
}

// Resolves allowlisted instruction keys to the source ids their persisted case
// already accounts for, before the bounded window read. Those ids then seed the
// read by id exactly like the source allowlist, so an instruction key that has a
// case is cap-proof and a cap-induced miss can never be reported as a stale key.
// Keys with no persisted case (or a pre-migration DB) simply stay unresolved:
// they are then treated as cap-exposed rather than stale on a capped run.
async function resolveInstructionKeySeeds(
  client: any,
  instructionKeys: readonly string[],
): Promise<{ postIds: string[]; capProofKeys: Set<string> }> {
  const postIds: string[] = [];
  const capProofKeys = new Set<string>();
  if (!instructionKeys.length) return { postIds, capProofKeys };
  const keyByCaseId = new Map<string, string>();
  try {
    for (const keys of chunk(instructionKeys)) {
      const { data, error } = await client.from("makesafe_intake_cases")
        .select("id,instruction_key")
        .eq("org_id", DEFAULT_ORG_ID)
        .in("instruction_key", keys);
      if (error) return { postIds: [], capProofKeys: new Set() };
      for (const row of (data || [])) {
        if (row?.id && row?.instruction_key) {
          keyByCaseId.set(row.id, row.instruction_key);
        }
      }
    }
    for (const ids of chunk([...keyByCaseId.keys()])) {
      const { data, error } = await client.from("makesafe_intake_case_sources")
        .select("post_id,case_id")
        .eq("org_id", DEFAULT_ORG_ID)
        .in("case_id", ids);
      if (error) return { postIds: [], capProofKeys: new Set() };
      for (const row of (data || [])) {
        if (!row?.post_id) continue;
        postIds.push(row.post_id);
        const key = keyByCaseId.get(row.case_id);
        if (key) capProofKeys.add(key);
      }
    }
  } catch {
    return { postIds: [], capProofKeys: new Set() };
  }
  return { postIds, capProofKeys };
}

interface PersistedSourceAuthority {
  id: string;
  instruction_key: string;
  cycle: number;
  parent_relation: DeterministicCasePlan["parentRelation"];
  source_fingerprint: string | null;
  state: string;
  job_id: string | null;
}

interface SourceAuthorityCorrection {
  id: string;
  source_post_id: string;
  legacy_case_id: string | null;
  effective_case_id: string | null;
  target_job_id: string | null;
  expected_identity_key: string;
}

interface SourceAuthorityCorrectionSupersession {
  source_post_id: string;
  superseded_correction_id: string;
  prior_authority_case_id: string;
  effective_case_id: string;
  expected_identity_key: string | null;
}

// An exact source that is already canonical-accounted is stronger authority than
// whichever correlated neighbours happen to share this run's moving capped page.
// Seed its complete persisted source closure before planning, then bind the plan
// back to the persisted case below. Without both halves, a later cursor page can
// re-key the same source as a new sibling and defeat idempotency.
async function resolvePersistedSourceAuthorities(
  client: any,
  sourcePostIds: readonly string[],
): Promise<{
  byPostId: Map<string, PersistedSourceAuthority>;
  targetJobByPostId: Map<string, string>;
  expectedIdentityByPostId: Map<string, string>;
  seedPostIds: string[];
}> {
  const byPostId = new Map<string, PersistedSourceAuthority>();
  const targetJobByPostId = new Map<string, string>();
  const expectedIdentityByPostId = new Map<string, string>();
  if (!sourcePostIds.length) {
    return {
      byPostId,
      targetJobByPostId,
      expectedIdentityByPostId,
      seedPostIds: [],
    };
  }

  const caseIdByPostId = new Map<string, string>();
  const correctionIdByPostId = new Map<string, string>();
  for (const ids of chunk(sourcePostIds)) {
    const { data, error } = await client.from("makesafe_intake_case_sources")
      .select("post_id,case_id")
      .eq("org_id", DEFAULT_ORG_ID)
      .in("post_id", ids);
    if (error) {
      throw new Error(
        `deterministic source authority read failed: ${error.message || error}`,
      );
    }
    for (const row of data || []) {
      if (row?.post_id && row?.case_id) {
        caseIdByPostId.set(row.post_id, row.case_id);
      }
    }
  }

  // The original source ledger is append-only. Parser corrections therefore
  // overlay effective authority here instead of rewriting historical ownership.
  // A target_job_id is a separately guarded instruction to account a fresh source
  // against an already-created operational job without drafting or minting again.
  for (const ids of chunk(sourcePostIds)) {
    const { data, error } = await client.from(
      "makesafe_intake_source_authority_corrections",
    )
      .select(
        "id,source_post_id,legacy_case_id,effective_case_id,target_job_id,expected_identity_key",
      )
      .eq("org_id", DEFAULT_ORG_ID)
      .in("source_post_id", ids);
    if (error) {
      throw new Error(
        `deterministic source correction read failed: ${
          error.message || error
        }`,
      );
    }
    for (const row of (data || []) as SourceAuthorityCorrection[]) {
      const actualLegacy = caseIdByPostId.get(row.source_post_id) || null;
      if (
        row.legacy_case_id && actualLegacy !== row.legacy_case_id
      ) {
        throw new Error(
          "deterministic source correction legacy authority mismatch; reconciliation required",
        );
      }
      if (row.effective_case_id) {
        caseIdByPostId.set(row.source_post_id, row.effective_case_id);
      }
      correctionIdByPostId.set(row.source_post_id, row.id);
      if (row.target_job_id) {
        targetJobByPostId.set(row.source_post_id, row.target_job_id);
      }
      expectedIdentityByPostId.set(
        row.source_post_id,
        row.expected_identity_key,
      );
    }
  }

  // The first correction ledger is deliberately one-row-per-source and
  // append-only. A reviewed second-round split therefore supersedes its
  // effective authority in a separate immutable ledger. Validate both the
  // correction row and its resulting authority before applying the overlay;
  // stale reconciliation data must fail loudly instead of silently rebinding.
  for (const ids of chunk(sourcePostIds)) {
    const { data, error } = await client.from(
      "makesafe_intake_source_authority_correction_supersessions",
    )
      .select(
        "source_post_id,superseded_correction_id,prior_authority_case_id,effective_case_id,expected_identity_key",
      )
      .eq("org_id", DEFAULT_ORG_ID)
      .in("source_post_id", ids);
    if (error) {
      throw new Error(
        `deterministic source correction supersession read failed: ${
          error.message || error
        }`,
      );
    }
    for (
      const row of (data || []) as SourceAuthorityCorrectionSupersession[]
    ) {
      if (
        correctionIdByPostId.get(row.source_post_id) !==
          row.superseded_correction_id
      ) {
        throw new Error(
          "deterministic source correction supersession target mismatch; reconciliation required",
        );
      }
      if (
        caseIdByPostId.get(row.source_post_id) !==
          row.prior_authority_case_id
      ) {
        throw new Error(
          "deterministic source correction supersession prior authority mismatch; reconciliation required",
        );
      }
      caseIdByPostId.set(row.source_post_id, row.effective_case_id);
      if (row.expected_identity_key) {
        expectedIdentityByPostId.set(
          row.source_post_id,
          row.expected_identity_key,
        );
      } else {
        expectedIdentityByPostId.delete(row.source_post_id);
      }
    }
  }

  const authorityByCaseId = new Map<string, PersistedSourceAuthority>();
  for (const ids of chunk([...new Set(caseIdByPostId.values())])) {
    const { data, error } = await client.from("makesafe_intake_cases")
      .select(
        "id,instruction_key,cycle,parent_relation,source_fingerprint,state,job_id",
      )
      .eq("org_id", DEFAULT_ORG_ID)
      .in("id", ids);
    if (error) {
      throw new Error(
        `deterministic source authority case read failed: ${
          error.message || error
        }`,
      );
    }
    for (const row of data || []) {
      if (row?.id && row?.instruction_key) authorityByCaseId.set(row.id, row);
    }
  }

  for (const [postId, caseId] of caseIdByPostId) {
    const authority = authorityByCaseId.get(caseId);
    if (!authority) {
      throw new Error(
        "deterministic source authority points to an unreadable canonical case",
      );
    }
    byPostId.set(postId, authority);
  }
  const persistedSources = await readPersistedSourcePostIds(
    client,
    [...authorityByCaseId.keys()],
  );
  const correctedSourcePostIds: string[] = [];
  for (const ids of chunk([...authorityByCaseId.keys()])) {
    const { data, error } = await client.from(
      "makesafe_intake_source_authority_corrections",
    )
      .select("source_post_id,effective_case_id")
      .eq("org_id", DEFAULT_ORG_ID)
      .in("effective_case_id", ids);
    if (error) {
      throw new Error(
        `deterministic corrected source closure read failed: ${
          error.message || error
        }`,
      );
    }
    for (const row of data || []) {
      if (row?.source_post_id) correctedSourcePostIds.push(row.source_post_id);
    }
  }
  for (const ids of chunk([...authorityByCaseId.keys()])) {
    const { data, error } = await client.from(
      "makesafe_intake_source_authority_correction_supersessions",
    )
      .select("source_post_id,effective_case_id")
      .eq("org_id", DEFAULT_ORG_ID)
      .in("effective_case_id", ids);
    if (error) {
      throw new Error(
        `deterministic superseded source closure read failed: ${
          error.message || error
        }`,
      );
    }
    for (const row of data || []) {
      if (row?.source_post_id) correctedSourcePostIds.push(row.source_post_id);
    }
  }
  const seedPostIds = [
    ...new Set([
      ...[...persistedSources.values()].flatMap((ids) => [...ids]),
      ...correctedSourcePostIds,
    ]),
  ];
  return {
    byPostId,
    targetJobByPostId,
    expectedIdentityByPostId,
    seedPostIds,
  };
}

// Live scanning and dark observation sweep the same window independently, so each
// owns its own position. Sharing one column would make a live run skip rows an
// observe run had already passed, and would make pre-cutover observation depend on
// live runs that do not exist yet.
const LIVE_CURSOR_COLUMNS: CursorColumns = {
  at: "deterministic_scan_cursor_at",
  postId: "deterministic_scan_cursor_post_id",
};
const OBSERVE_CURSOR_COLUMNS: CursorColumns = {
  at: "deterministic_observe_cursor_at",
  postId: "deterministic_observe_cursor_post_id",
};

// The sweep position is a (received_at, post_id) tuple, not a bare timestamp. A
// bare timestamp cursor advanced with `.gt(received_at)` skips every row sharing
// the boundary timestamp, so more rows at one received_at than the read cap could
// permanently strand the overflow. Pairing the tie-breaker post_id makes the
// completeness guarantee hold for any timestamp collision, not just probabilistically.
type CursorColumns = { at: string; postId: string };
type SweepCursor = { receivedAt: string; postId: string };

// The sweep cursor is deliberately tolerant on both ends. A pre-migration DB, or
// a health row that has never been written, simply sweeps from the oldest row
// every run; that is the old behaviour, not a new failure. Losing the cursor
// costs coverage, so the run says so through a caveat rather than throwing.
async function readScanCursor(
  client: any,
  columns: CursorColumns,
): Promise<SweepCursor | null> {
  try {
    const { data, error } = await client.from("makesafe_intake_health")
      .select(`${columns.at},${columns.postId}`)
      .eq("id", true)
      .maybeSingle();
    if (error) return null;
    const receivedAt = data?.[columns.at] ?? null;
    if (receivedAt == null) return null;
    // A legacy row that stored only the timestamp resolves to an empty post_id,
    // which the tuple filter treats as "the start of this timestamp" and re-reads
    // the boundary rows rather than skipping them - safe, and self-corrects on the
    // next persist.
    return {
      receivedAt: String(receivedAt),
      postId: String(data?.[columns.postId] ?? ""),
    };
  } catch {
    return null;
  }
}

async function persistScanCursor(
  client: any,
  columns: CursorColumns,
  cursor: SweepCursor | null,
): Promise<boolean> {
  try {
    const { error } = await client.from("makesafe_intake_health").upsert({
      id: true,
      [columns.at]: cursor?.receivedAt ?? null,
      [columns.postId]: cursor?.postId ?? null,
    }, { onConflict: "id" });
    return !error;
  } catch {
    return false;
  }
}

function eligiblePdfAttachments(
  source: DeterministicSourceItem,
): DeterministicAttachment[] {
  return source.attachments.filter((attachment) =>
    attachment.status === "uploaded" && !!attachment.storagePath &&
    (/pdf/i.test(attachment.contentType || "") ||
      /\.pdf$/i.test(attachment.name || ""))
  ).sort((a, b) => {
    const score = (attachment: DeterministicAttachment) =>
      /work\s*order|works\s*order|(?:^|[^A-Z])WO(?:[^A-Z]|$)/i.test(
          attachment.name || "",
        )
        ? 0
        : 1;
    return score(a) - score(b) ||
      String(a.name || "").localeCompare(String(b.name || "")) ||
      a.id.localeCompare(b.id);
  }).slice(0, MAX_PDF_ATTACHMENTS_PER_SOURCE);
}

function pdfDocument(
  source: DeterministicSourceItem,
  attachment: DeterministicAttachment,
  values: Partial<DeterministicPdfDocument>,
): DeterministicPdfDocument {
  return {
    sourcePostId: source.postId,
    attachmentId: attachment.id,
    attachmentName: attachment.name,
    status: "quarantined",
    text: null,
    charCount: 0,
    pageCount: null,
    extractor: null,
    truncated: false,
    reason: null,
    ...values,
  };
}

export async function enrichSourcesWithPdfText(
  client: any,
  sources: readonly DeterministicSourceItem[],
  priorityPostIds: readonly string[] = [],
): Promise<DeterministicSourceItem[]> {
  const priority = new Set(priorityPostIds);
  const ordered = [...sources].sort((a, b) =>
    Number(priority.has(b.postId)) - Number(priority.has(a.postId)) ||
    a.receivedAt.localeCompare(b.receivedAt) ||
    a.postId.localeCompare(b.postId)
  );
  const documentsByPost = new Map<string, DeterministicPdfDocument[]>();
  let attempted = 0;
  for (const source of ordered) {
    if (source.direction === "own_outbound") continue;
    for (const attachment of eligiblePdfAttachments(source)) {
      let document: DeterministicPdfDocument;
      if (attempted >= MAX_PDF_EXTRACTIONS_PER_RUN) {
        document = pdfDocument(source, attachment, {
          status: "deferred",
          reason: "run_extraction_cap",
        });
      } else if (
        Number(attachment.sizeBytes || 0) > PDF_TEXT_MAX_BYTES
      ) {
        attempted++;
        document = pdfDocument(source, attachment, {
          reason: "pdf_too_large",
        });
      } else {
        attempted++;
        try {
          const storage = client?.storage?.from?.("makesafe-emails");
          const { data: blob, error } = storage
            ? await storage.download(attachment.storagePath!)
            : { data: null, error: new Error("storage unavailable") };
          if (error || !blob) {
            document = pdfDocument(source, attachment, {
              reason: "download_failed",
            });
          } else {
            const bytes = new Uint8Array(await blob.arrayBuffer());
            const extracted = await extractPdfText(bytes);
            document = pdfDocument(source, attachment, {
              status: extracted.mode === "text" ? "extracted" : "quarantined",
              text: extracted.mode === "text" ? extracted.text : null,
              charCount: extracted.charCount,
              pageCount: extracted.pageCount ?? null,
              extractor: extracted.extractor ?? null,
              truncated: extracted.truncated === true,
              reason: extracted.mode === "text"
                ? null
                : extracted.note || "no_usable_text",
            });
          }
        } catch {
          document = pdfDocument(source, attachment, {
            reason: "extraction_failed",
          });
        }
      }
      documentsByPost.set(source.postId, [
        ...(documentsByPost.get(source.postId) || []),
        document,
      ]);
    }
  }
  return sources.map((source) => ({
    ...source,
    pdfDocuments: documentsByPost.get(source.postId) || [],
  }));
}

async function readInputs(
  client: any,
  options:
    & Required<
      Pick<
        DeterministicRuntimeOptions,
        "days" | "onlyUnscanned" | "nowIso" | "maxSources"
      >
    >
    & { seedPostIds: readonly string[]; cursor: SweepCursor | null },
): Promise<
  {
    sources: DeterministicSourceItem[];
    profiles: DeterministicCompanyProfile[];
    read: DeterministicRuntimeReport["source_read"];
    // Internal tuple used to persist sweep progress. Its source-id tie breaker is
    // never copied into the aggregate runtime report.
    nextCursor: SweepCursor | null;
  }
> {
  const since = new Date(Date.parse(options.nowIso) - options.days * 86_400_000)
    .toISOString();
  const columns = [
    "post_id",
    "internet_message_id",
    "conversation_id",
    "thread_id",
    "subject",
    "body_content",
    "body_preview",
    "from_email",
    "from_name",
    "received_at",
    "makesafe_scanned_at",
  ].join(",");
  // Two-part, hard-capped read. One run's cost is the cap, not the size of the
  // mailbox history inside the window, and the cursor-driven sweep half gives the
  // bound a progress guarantee: every in-window source is eventually planned,
  // whether or not anything ever stamps it as scanned.
  const backlogCap = Math.max(
    1,
    Math.floor(options.maxSources * BACKLOG_READ_SHARE),
  );
  const backlogRows = await fetchCapped(
    backlogCap,
    async (from, to) => {
      let query = client.from("emails").select(columns)
        .eq("mailbox", SES_MAILBOX)
        .is("pii_purged_at", null)
        .gte("received_at", since);
      if (options.cursor) {
        const { receivedAt, postId } = options.cursor;
        // Keyset resume on the (received_at, post_id) tuple: strictly after the
        // cursor row, which keeps rows that merely share the boundary received_at.
        query = query
          .gte("received_at", receivedAt)
          .or(
            `received_at.gt."${receivedAt}",and(received_at.eq."${receivedAt}",post_id.gt."${postId}")`,
          );
      }
      return await query
        .order("received_at", { ascending: true })
        .order("post_id", { ascending: true })
        .range(from, to);
    },
  );
  const recentCap = Math.max(0, options.maxSources - backlogRows.length);
  const recentRows = recentCap === 0 ? [] : await fetchCapped(
    recentCap,
    async (from, to) => {
      let query = client.from("emails").select(columns)
        .eq("mailbox", SES_MAILBOX)
        .is("pii_purged_at", null)
        .gte("received_at", since)
        .order("received_at", { ascending: false })
        .range(from, to);
      if (options.onlyUnscanned) query = query.is("makesafe_scanned_at", null);
      return await query;
    },
  );
  const byPostId = new Map<string, any>();
  for (const row of [...backlogRows, ...recentRows]) {
    if (row?.post_id) byPostId.set(row.post_id, row);
  }
  const windowRows = byPostId.size;
  const missingSeeds = [...new Set(options.seedPostIds)].filter((postId) =>
    !byPostId.has(postId)
  );
  let seedRows = 0;
  for (const ids of chunk(missingSeeds)) {
    const { data, error } = await client.from("emails").select(columns)
      .eq("mailbox", SES_MAILBOX)
      .is("pii_purged_at", null)
      .in("post_id", ids);
    if (error) {
      throw new Error(
        `emails allowlist read failed: ${error.message || error}`,
      );
    }
    for (const row of (data || [])) {
      if (row?.post_id && !byPostId.has(row.post_id)) {
        byPostId.set(row.post_id, row);
        seedRows++;
      }
    }
  }
  const emails = [...byPostId.values()].sort((a, b) =>
    String(a.received_at).localeCompare(String(b.received_at))
  );
  const postIds = emails.map((row) => row.post_id).filter(Boolean);
  const attachmentRows: any[] = [];
  for (const ids of chunk(postIds)) {
    const { data, error } = await client.from("email_attachments")
      .select("id,email_id,name,content_type,storage_path,status,size_bytes")
      .in("email_id", ids);
    if (error) {
      throw new Error(
        `email_attachments read failed: ${error.message || error}`,
      );
    }
    attachmentRows.push(...(data || []));
  }
  const attachmentsByPost = new Map<string, DeterministicAttachment[]>();
  for (const row of attachmentRows) {
    const attachment: DeterministicAttachment = {
      id: row.id,
      sourcePostId: row.email_id,
      name: row.name || null,
      contentType: row.content_type || null,
      storagePath: row.storage_path || null,
      status: row.status || null,
      sizeBytes: row.size_bytes || null,
    };
    attachmentsByPost.set(row.email_id, [
      ...(attachmentsByPost.get(row.email_id) || []),
      attachment,
    ]);
  }
  const { data: companies, error: companyError } = await client.from(
    "makesafe_companies",
  )
    .select("id,slug,name,sender_patterns,parsing_rules")
    .eq("active", true);
  if (companyError) {
    throw new Error(
      `makesafe_companies read failed: ${companyError.message || companyError}`,
    );
  }
  const profiles = (companies || []).map((row: any) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    senderPatterns: Array.isArray(row.sender_patterns)
      ? row.sender_patterns
      : [],
    parsingRules: row.parsing_rules || null,
  }));
  const sourceRows = emails.map((row: any): DeterministicSourceItem => {
    const rawBody = row.body_content || row.body_preview || "";
    // Match the proven legacy intake shape: regexes receive readable text, not a
    // newline-free HTML document whose tags hide labels and make address captures
    // consume the rest of a reply chain. Links still come from the raw body.
    const body = stripEmailHtmlForTrade(rawBody) || row.body_preview || "";
    return {
      postId: row.post_id,
      internetMessageId: row.internet_message_id || null,
      conversationId: row.conversation_id || null,
      threadId: row.thread_id || null,
      fromEmail: row.from_email || null,
      fromName: row.from_name || null,
      subject: row.subject || null,
      body,
      receivedAt: row.received_at,
      attachments: attachmentsByPost.get(row.post_id) || [],
      links: linksFromBody(row.post_id, rawBody),
      direction: isOwnDomain(deriveFromDomain(row.from_email))
        ? "own_outbound"
        : "inbound",
    };
  });
  const sources = await enrichSourcesWithPdfText(
    client,
    sourceRows,
    options.seedPostIds,
  );
  const backlogPageFull = backlogRows.length >= backlogCap;
  const recentPageFull = recentCap === 0 || recentRows.length >= recentCap;
  const nextCursor = backlogPageFull
    ? {
      receivedAt: String(backlogRows[backlogRows.length - 1].received_at),
      postId: String(backlogRows[backlogRows.length - 1].post_id),
    }
    : null;
  return {
    sources,
    profiles,
    read: {
      cap: options.maxSources,
      backlog_cap: backlogCap,
      backlog_rows: backlogRows.length,
      recent_rows: recentRows.length,
      window_rows: windowRows,
      seed_rows: seedRows,
      // Either full sub-read leaves structural uncertainty. In particular, a
      // full sweep page means a non-null next cursor even when recent/backlog
      // overlap keeps their raw sum below maxSources. That was the gate report's
      // false clean-sweep shape (250 backlog + 194 recent, cursor still present).
      cap_reached: backlogPageFull || recentPageFull,
      cursor_at: options.cursor?.receivedAt ?? null,
      next_cursor_at: nextCursor?.receivedAt ?? null,
    },
    nextCursor,
  };
}

export const _readInputsForTest = readInputs;

function byBuilderOutcome(
  plan: DeterministicIntakePlan,
): Record<string, Record<string, number>> {
  const result: Record<string, Record<string, number>> = {};
  const caseByInstruction = new Map(
    plan.cases.map((c) => [c.instructionKey, c]),
  );
  for (const item of plan.sourceClassifications) {
    const builder =
      caseByInstruction.get(item.instructionKey)?.identity.builderSlug ||
      "unknown";
    result[builder] ||= {};
    result[builder][item.outcome] = (result[builder][item.outcome] || 0) + 1;
  }
  return result;
}

function byBuilderReason(
  plan: DeterministicIntakePlan,
): Record<string, Record<string, number>> {
  const result: Record<string, Record<string, number>> = {};
  for (const intakeCase of plan.cases) {
    const builder = intakeCase.identity.builderSlug || "unknown";
    const reason = intakeCase.reasonCode ||
      (intakeCase.state === "blocked_live_job"
        ? "blocked_secondary"
        : "confirmed");
    result[builder] ||= {};
    result[builder][reason] = (result[builder][reason] || 0) +
      intakeCase.sourcePostIds.length;
  }
  return result;
}

function selectedPlan(
  fullPlan: DeterministicIntakePlan,
  sourcePostIds: readonly string[],
  instructionKeys: readonly string[],
): DeterministicIntakePlan {
  const sourceSet = new Set(sourcePostIds);
  const selectedKeys = new Set(instructionKeys);
  for (const intakeCase of fullPlan.cases) {
    if (intakeCase.sourcePostIds.some((postId) => sourceSet.has(postId))) {
      selectedKeys.add(intakeCase.instructionKey);
    }
  }
  // Exact authority names the case to advance, but a child cannot be validated or
  // persisted without its complete semantic ancestry. Pull the transitive parent
  // chain from the already-bounded plan. A fresh review-exception `sibling_of`
  // remains the deliberate exception: sibling orientation is arbitrary, so exact
  // authority promotes it to its own root rather than writing an ambient sibling.
  // Semantic revision/cancellation/reopen parents and non-work sibling ancestry
  // are never dropped. This does not select descendants or unrelated siblings,
  // and the normal per-run case cap still bounds writes.
  const byInstructionKey = new Map(
    fullPlan.cases.map((intakeCase) => [intakeCase.instructionKey, intakeCase]),
  );
  const pending = [...selectedKeys];
  while (pending.length) {
    const intakeCase = byInstructionKey.get(pending.pop()!);
    if (
      intakeCase?.state === "exception" &&
      intakeCase.parentRelation === "sibling_of"
    ) {
      continue;
    }
    const parentKey = intakeCase?.parentInstructionKey;
    if (!parentKey || selectedKeys.has(parentKey)) continue;
    selectedKeys.add(parentKey);
    pending.push(parentKey);
  }
  const cases = fullPlan.cases.filter((intakeCase) =>
    selectedKeys.has(intakeCase.instructionKey)
  );
  return planWithCases(fullPlan, cases);
}

function planWithCases(
  fullPlan: DeterministicIntakePlan,
  cases: readonly DeterministicCasePlan[],
): DeterministicIntakePlan {
  const sourceClassifications = cases.flatMap((intakeCase) =>
    intakeCase.sourceClassifications
  );
  const uniqueSources = new Set(
    sourceClassifications.map((item) => item.postId),
  );
  return {
    ...fullPlan,
    cases,
    sourceClassifications,
    totals: {
      sources: uniqueSources.size,
      cases: cases.length,
      confirmed:
        sourceClassifications.filter((item) =>
          item.outcome === "confirmed_canonical_input"
        ).length,
      blocked:
        sourceClassifications.filter((item) =>
          item.outcome === "visible_blocked_with_recovery"
        ).length,
      exceptions:
        sourceClassifications.filter((item) =>
          item.outcome === "reason_coded_exception"
        ).length,
      nonWork:
        sourceClassifications.filter((item) =>
          item.outcome === "accounted_non_work"
        ).length,
      unaccounted: uniqueSources.size -
        new Set(sourceClassifications.map((item) => item.postId)).size,
    },
  };
}

function replaceInstructionKey(
  value: string,
  from: string,
  to: string,
): string {
  return value.split(from).join(to);
}

function instructionKeyForCycle(instructionKey: string, cycle: number): string {
  if (!/\/cycle:\d+$/.test(instructionKey)) {
    throw new Error("deterministic instruction key has no cycle suffix");
  }
  return instructionKey.replace(/\/cycle:\d+$/, `/cycle:${cycle}`);
}

function rekeyCasePlan(
  intakeCase: DeterministicCasePlan,
  instructionKey: string,
): DeterministicCasePlan {
  const oldKey = intakeCase.instructionKey;
  if (oldKey === instructionKey) return intakeCase;
  const rewrite = (value: string) =>
    replaceInstructionKey(value, oldKey, instructionKey);
  return {
    ...intakeCase,
    instructionKey,
    sourceClassifications: intakeCase.sourceClassifications.map((item) => ({
      ...item,
      instructionKey,
    })),
    recoveryCursor: {
      ...intakeCase.recoveryCursor,
      stagedArtifactKeys: intakeCase.recoveryCursor.stagedArtifactKeys.map(
        rewrite,
      ),
      sideEffectKeys: {
        ...intakeCase.recoveryCursor.sideEffectKeys,
        draft: rewrite(intakeCase.recoveryCursor.sideEffectKeys.draft),
        job: rewrite(intakeCase.recoveryCursor.sideEffectKeys.job),
        pdfs: intakeCase.recoveryCursor.sideEffectKeys.pdfs.map(rewrite),
        screenshots: intakeCase.recoveryCursor.sideEffectKeys.screenshots.map(
          rewrite,
        ),
        invoices: intakeCase.recoveryCursor.sideEffectKeys.invoices.map(
          rewrite,
        ),
        outboundMessages: intakeCase.recoveryCursor.sideEffectKeys
          .outboundMessages.map(rewrite),
        approvals: intakeCase.recoveryCursor.sideEffectKeys.approvals.map(
          rewrite,
        ),
      },
    },
  };
}

function deliverableSegment(instructionKey: string): string {
  const match = /\/deliverable:([^/]+)\//.exec(instructionKey);
  if (!match) {
    throw new Error("deterministic instruction key has no deliverable segment");
  }
  return match[1];
}

class PersistedAuthorityBindingError extends Error {
  constructor(
    readonly failure: DeterministicIsolatedFailure,
    message: string,
  ) {
    super(message);
    this.name = "PersistedAuthorityBindingError";
  }
}

function bindingFailure(
  reason: DeterministicIsolatedFailure["reason"],
  plan: DeterministicIntakePlan,
  authorityByPostId: Map<string, PersistedSourceAuthority>,
  message: string,
): PersistedAuthorityBindingError {
  return new PersistedAuthorityBindingError({
    reason,
    source_post_ids: [
      ...new Set(plan.cases.flatMap((item) => item.sourcePostIds)),
    ].sort(),
    persisted_case_ids: [
      ...new Set(
        plan.cases.flatMap((item) =>
          item.sourcePostIds.flatMap((postId) => {
            const authority = authorityByPostId.get(postId);
            return authority ? [authority.id] : [];
          })
        ),
      ),
    ].sort(),
    planned_instruction_keys: plan.cases.map((item) => item.instructionKey)
      .sort(),
  }, message);
}

function bindSelectedPlanToPersistedSourceAuthority(
  plan: DeterministicIntakePlan,
  authorityByPostId: Map<string, PersistedSourceAuthority>,
): DeterministicIntakePlan {
  // A moving partial page can compute a different this-run key for any canonical
  // source, not only an exact allowlist seed. Bind every selected node back to the
  // stable case owning its primary source (or its first owned source). Production
  // history can contain several older canonical cases that the current planner now
  // groups together; their sources stay where they are and the primary owner gives
  // the merged plan one deterministic orientation.
  //
  // Any in-plan child parented to the this-run key must follow that parent back to
  // its stable key, or the lineage guard would read the child as an orphan.
  const plannedKeysByAuthority = new Map<string, Set<string>>();
  for (const intakeCase of plan.cases) {
    for (const postId of intakeCase.sourcePostIds) {
      const authority = authorityByPostId.get(postId);
      if (!authority) continue;
      const keys = plannedKeysByAuthority.get(authority.id) ||
        new Set<string>();
      keys.add(intakeCase.instructionKey);
      plannedKeysByAuthority.set(authority.id, keys);
    }
  }
  if (
    [...plannedKeysByAuthority.values()].some((instructionKeys) =>
      instructionKeys.size > 1
    )
  ) {
    throw bindingFailure(
      "persisted_authority_split_reconciliation_required",
      plan,
      authorityByPostId,
      "one persisted source authority backs multiple corrected deterministic instructions; reconciliation required",
    );
  }

  const keyRemap = new Map<string, string>();
  const cases = plan.cases.map((intakeCase) => {
    // Grouped history is legitimate only when every source is already canonical,
    // every authority shares one deliverable, and each non-primary case is already
    // in the state this plan derives. Anything fresh or state-divergent is a real
    // cross-case merge: binding it silently could attribute new evidence to the
    // wrong primary row, so it must fail loudly.
    const ownedAuthorities = new Map<string, PersistedSourceAuthority>();
    for (const postId of intakeCase.sourcePostIds) {
      const owned = authorityByPostId.get(postId);
      if (owned) ownedAuthorities.set(owned.id, owned);
    }
    const authority = authorityByPostId.get(intakeCase.primarySourcePostId) ||
      [...ownedAuthorities.values()][0];
    if (!authority) return intakeCase;
    if (ownedAuthorities.size > 1) {
      const unownedSources = intakeCase.sourcePostIds.filter((postId) =>
        !authorityByPostId.has(postId)
      );
      if (unownedSources.length) {
        throw bindingFailure(
          "fresh_multi_authority_merge",
          plan,
          authorityByPostId,
          "one deterministic plan merged a fresh source across multiple persisted cases",
        );
      }
      const primaryDeliverable = deliverableSegment(authority.instruction_key);
      for (const candidate of ownedAuthorities.values()) {
        if (
          deliverableSegment(candidate.instruction_key) !== primaryDeliverable
        ) {
          throw bindingFailure(
            "multiple_persisted_deliverables",
            plan,
            authorityByPostId,
            "one deterministic plan merged canonical sources from multiple persisted deliverables",
          );
        }
        if (
          candidate.id !== authority.id &&
          candidate.state !== resolvedState(intakeCase, candidate.job_id)
        ) {
          throw bindingFailure(
            "state_mismatched_secondary_authority",
            plan,
            authorityByPostId,
            "one deterministic plan merged a state-mismatched secondary persisted case",
          );
        }
      }
    }
    const oldKey = intakeCase.instructionKey;
    const stableKey = authority.instruction_key;
    if (oldKey !== stableKey) keyRemap.set(oldKey, stableKey);
    const stableFingerprint = authority.source_fingerprint ||
      intakeCase.instructionFingerprint;
    const rebound = rekeyCasePlan(intakeCase, stableKey);
    return {
      ...rebound,
      instructionFingerprint: stableFingerprint,
      // The source already belongs to this row. Its persisted lineage is
      // authoritative; a partial page may enrich it but cannot re-parent it.
      parentInstructionKey: null,
      parentRelation: authority.parent_relation ?? null,
      cycle: authority.cycle,
    };
  });
  const relinked = keyRemap.size
    ? cases.map((intakeCase) => {
      const parentKey = intakeCase.parentInstructionKey;
      if (!parentKey) return intakeCase;
      const stableParent = keyRemap.get(parentKey);
      if (!stableParent || stableParent === parentKey) return intakeCase;
      return { ...intakeCase, parentInstructionKey: stableParent };
    })
    : cases;
  return {
    ...plan,
    cases: relinked,
    sourceClassifications: relinked.flatMap((intakeCase) =>
      intakeCase.sourceClassifications
    ),
  };
}

function bindPlanComponentsToPersistedAuthority(
  plan: DeterministicIntakePlan,
  authorityByPostId: Map<string, PersistedSourceAuthority>,
  expectedIdentityByPostId: ReadonlyMap<string, string>,
): {
  plan: DeterministicIntakePlan;
  isolatedFailures: DeterministicIsolatedFailure[];
} {
  const parent = plan.cases.map((_, index) => index);
  const find = (index: number): number =>
    parent[index] === index ? index : (parent[index] = find(parent[index]));
  const union = (left: number, right: number) => {
    const a = find(left);
    const b = find(right);
    if (a !== b) parent[b] = a;
  };
  const firstByLineage = new Map<string, number>();
  const firstByAuthority = new Map<string, number>();
  for (const [index, intakeCase] of plan.cases.entries()) {
    const lineageIndex = firstByLineage.get(intakeCase.lineageClusterKey);
    if (lineageIndex === undefined) {
      firstByLineage.set(intakeCase.lineageClusterKey, index);
    } else {
      union(lineageIndex, index);
    }
    for (const postId of intakeCase.sourcePostIds) {
      const authority = authorityByPostId.get(postId);
      if (!authority) continue;
      const authorityIndex = firstByAuthority.get(authority.id);
      if (authorityIndex === undefined) {
        firstByAuthority.set(authority.id, index);
      } else {
        // A parser correction can split one old authority across otherwise
        // independent lineage clusters. Keep those clusters in one validation
        // component so the inverse guard quarantines the entire ambiguity.
        union(authorityIndex, index);
      }
    }
  }
  const components = new Map<number, DeterministicCasePlan[]>();
  for (const [index, intakeCase] of plan.cases.entries()) {
    const root = find(index);
    const component = components.get(root) || [];
    component.push(intakeCase);
    components.set(root, component);
  }
  const accepted: DeterministicCasePlan[] = [];
  const isolatedFailures: DeterministicIsolatedFailure[] = [];
  for (const cases of components.values()) {
    const componentPlan = planWithCases(plan, cases);
    try {
      for (const intakeCase of componentPlan.cases) {
        const actualIdentity = intakeCase.identity.builderWoCanonical
          ? `wo:${intakeCase.identity.builderWoCanonical}`
          : intakeCase.identity.builderPoCanonical
          ? `po:${intakeCase.identity.builderPoCanonical}`
          : intakeCase.identity.externalRefCanonical
          ? `ref:${intakeCase.identity.externalRefCanonical}`
          : null;
        if (
          intakeCase.sourcePostIds.some((postId) => {
            const expected = expectedIdentityByPostId.get(postId);
            return expected && expected !== actualIdentity;
          })
        ) {
          throw bindingFailure(
            "source_correction_identity_mismatch_reconciliation_required",
            componentPlan,
            authorityByPostId,
            "source correction no longer matches deterministic identity; reconciliation required",
          );
        }
      }
      accepted.push(
        ...bindSelectedPlanToPersistedSourceAuthority(
          componentPlan,
          authorityByPostId,
        ).cases,
      );
    } catch (error) {
      if (!(error instanceof PersistedAuthorityBindingError)) throw error;
      isolatedFailures.push(error.failure);
    }
  }
  return {
    plan: planWithCases(plan, accepted),
    isolatedFailures,
  };
}

function identityFloorFacts(
  plan: DeterministicIntakePlan,
): DeterministicRuntimeReport["identity_floor"] {
  const excludedReasons = new Set([
    "cancellation",
    "duplicate",
    "revision",
    "non_makesafe",
  ]);
  const candidates = plan.cases.filter((intakeCase) =>
    Boolean(intakeCase.identity.companyId) &&
    intakeCase.state !== "accounted_non_wo" &&
    !excludedReasons.has(String(intakeCase.reasonCode || ""))
  );
  const byBuilder: DeterministicRuntimeReport["identity_floor"]["by_builder"] =
    {};
  let reached = 0;
  for (const intakeCase of candidates) {
    const builder = intakeCase.identity.builderSlug || "known";
    byBuilder[builder] ||= { candidates: 0, reached: 0, shortfall: 0 };
    byBuilder[builder].candidates++;
    // This gate measures canonical instruction identity, not whether every field
    // and artefact needed to create a new job is already available. Client name,
    // address, phone, WO PDF and portal capture are recovery/job-readiness facts.
    // Treating those as identity made 89 cases with builder WO/PO/ref evidence
    // report 0% merely because all recent MLB client names live in image-font PDFs.
    // Claim-only evidence remains below the floor and cannot create a live job.
    const reaches = Boolean(intakeCase.identity.woPoIdentityKey);
    if (reaches) {
      reached++;
      byBuilder[builder].reached++;
    } else byBuilder[builder].shortfall++;
  }
  return {
    unit: "canonical_case",
    known_builder_work_candidates: candidates.length,
    reached,
    shortfall: candidates.length - reached,
    percentage: candidates.length === 0
      ? null
      : Math.round((reached / candidates.length) * 10_000) / 100,
    formula: "reached / known_builder_work_candidates * 100",
    by_builder: byBuilder,
  };
}

async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string"
    ? new TextEncoder().encode(value)
    : value;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes as unknown as BufferSource,
  );
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

async function sanitizedCases(
  plan: DeterministicIntakePlan,
): Promise<NonNullable<DeterministicRuntimeReport["proposed_cases"]>> {
  return await Promise.all(plan.cases.map(async (intakeCase) => ({
    case_key_sha256: await sha256Hex(intakeCase.instructionKey),
    outcome: intakeCase.state,
    reason_code: intakeCase.reasonCode,
    builder: intakeCase.identity.builderSlug || "unknown",
    job_family: intakeCase.identity.jobFamily || null,
    source_count: intakeCase.sourcePostIds.length,
    blocked_reasons: intakeCase.blockedReasons,
    missing_fields: intakeCase.missingFields,
    conflicting_field_names: Object.keys(intakeCase.conflictingFields).sort(),
    parent_relation: intakeCase.parentRelation,
    identity_evidence: {
      known_company: Boolean(intakeCase.identity.companyId),
      external_reference: Boolean(intakeCase.identity.externalRefCanonical),
      builder_work_order: Boolean(intakeCase.identity.builderWoCanonical),
      builder_purchase_order: Boolean(intakeCase.identity.builderPoCanonical),
      client_name: Boolean(intakeCase.identity.clientName),
      site_address: Boolean(intakeCase.identity.siteAddress),
      designated_pdf: intakeCase.recoveryCursor.sideEffectKeys.pdfs.length > 0,
    },
  })));
}

function sourceRole(plan: DeterministicCasePlan, postId: string): string {
  const eventKinds = plan.story.filter((event) => event.sourcePostId === postId)
    .map((event) => event.kind);
  if (eventKinds.includes("cancellation")) return "cancellation_notice";
  if (eventKinds.includes("revision")) return "revision_notice";
  if (postId !== plan.primarySourcePostId) return "resend";
  return "original";
}

function inferredParentRelation(
  plan: DeterministicCasePlan,
): DeterministicCasePlan["parentRelation"] {
  if (plan.parentRelation) return plan.parentRelation;
  if (plan.reasonCode === "cancellation") return "cancellation_of";
  if (plan.story.some((event) => event.kind === "reopen")) return "reopen_of";
  if (plan.story.some((event) => event.kind === "revision")) {
    return "revision_of";
  }
  return null;
}

function resolvedState(plan: DeterministicCasePlan, jobId: string | null) {
  return jobId
    ? plan.state
    : plan.state === "accounted_non_wo"
    ? "accounted_non_wo"
    : "exception";
}

function casePayload(
  plan: DeterministicCasePlan,
  jobId: string | null,
  parent: { id: string; lineage_id: string; cycle: number } | null,
): Record<string, any> {
  const state = resolvedState(plan, jobId);
  const reason = jobId
    ? plan.reasonCode
    : plan.reasonCode || (plan.state === "accounted_non_wo"
      ? "non_makesafe"
      : plan.state === "confirmed_live_job" || plan.state === "blocked_live_job"
      // The adapter parsed fine; the case is only accounted ahead of the guarded
      // job creation, so it must not be reported as an adapter failure.
      ? "awaiting_job_creation"
      : "adapter_parse_failure");
  return {
    org_id: DEFAULT_ORG_ID,
    instruction_key: plan.instructionKey,
    ...(parent
      ? {
        parent_case_id: parent.id,
        parent_relation: inferredParentRelation(plan),
      }
      : {}),
    company_id: plan.identity.companyId,
    company_slug_raw: plan.identity.builderSlug,
    company_key: plan.identity.companyKey,
    external_ref_raw: plan.identity.externalRefRaw,
    external_ref_canonical: plan.identity.externalRefCanonical,
    builder_wo_raw: plan.identity.builderWoRaw,
    builder_wo_canonical: plan.identity.builderWoCanonical,
    builder_po_raw: plan.identity.builderPoRaw,
    builder_po_canonical: plan.identity.builderPoCanonical,
    deliverable_ref_raw: plan.identity.deliverableRefRaw,
    deliverable_ref_canonical: plan.identity.deliverableRefCanonical,
    wo_po_identity_key: plan.identity.woPoIdentityKey,
    normaliser_version: plan.identity.normaliserVersion,
    raw_identity_json: {
      builder_slug: plan.identity.builderSlug,
      external_ref: plan.identity.externalRefRaw,
      builder_wo: plan.identity.builderWoRaw,
      builder_po: plan.identity.builderPoRaw,
      deliverable: plan.identity.deliverableRefRaw,
      description: plan.identity.description,
      work_order_pdf_text: plan.pdfDocuments.map((document) => ({
        source_post_id: document.sourcePostId,
        attachment_id: document.attachmentId,
        attachment_name: document.attachmentName,
        status: document.status,
        text: document.text,
        char_count: document.charCount,
        page_count: document.pageCount,
        extractor: document.extractor,
        truncated: document.truncated,
        reason: document.reason,
      })),
    },
    field_provenance: plan.identity.companyId
      ? {
        deterministic_adapter_v1: {
          method: "deterministic",
          rule: plan.adapterVersion,
          sourcePostId: plan.primarySourcePostId,
        },
        ...plan.fieldProvenance,
      }
      : { ...plan.fieldProvenance },
    client_name: plan.identity.clientName,
    client_phone: plan.identity.clientPhone,
    client_email: plan.identity.clientEmail,
    site_address: plan.identity.siteAddress,
    site_suburb: plan.identity.siteSuburb,
    missing_fields: plan.missingFields,
    conflicting_fields: plan.conflictingFields,
    state,
    reason_code: state === "exception" || state === "accounted_non_wo"
      ? reason
      : null,
    blocked_reasons: state === "blocked_live_job" ? plan.blockedReasons : [],
    job_id: jobId,
    is_authoritative: true,
    // Guarded approval passes suppress_manager_notification for this provenance,
    // so the manager SMS side effect really is suppressed for deterministic cases.
    side_effects_suppressed: true,
    last_decision_provenance: "deterministic",
    last_decision_actor: DETERMINISTIC_INTAKE_VERSION,
    last_decision_reason: jobId
      ? `deterministic ${state}`
      : `deterministic ${reason}`,
    received_at: plan.story[0]?.occurredAt || new Date().toISOString(),
    adapter_id: plan.adapterId,
    adapter_version: plan.adapterVersion,
    manifest_version: plan.manifestVersion,
    story_json: plan.story,
    evidence_map: plan.evidenceMap,
    recovery_cursor: plan.recoveryCursor,
    source_fingerprint: plan.instructionFingerprint,
  };
}

type PersistedOutcome = "artifact" | "draft";

async function stageAttachments(
  client: any,
  caseId: string,
  plan: DeterministicCasePlan,
  sources: Map<string, DeterministicSourceItem>,
  onStorageBlocker: (blocker: string) => void,
  onPersistedOutcome: (outcome: PersistedOutcome) => void,
): Promise<any[]> {
  const result = new Map<string, any>();
  const attachments = plan.sourcePostIds.flatMap((id) =>
    sources.get(id)?.attachments || []
  )
    .filter((a) =>
      a.status === "uploaded" && a.storagePath &&
      (/pdf/i.test(a.contentType || "") || /\.pdf$/i.test(a.name || ""))
    );
  for (const attachment of attachments) {
    const { data: blob, error: downloadError } = await client.storage.from(
      "makesafe-emails",
    ).download(attachment.storagePath!);
    if (downloadError || !blob) {
      onStorageBlocker("makesafe-emails_download_failed");
      continue;
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const contentSha256 = await sha256Hex(bytes);
    const artifactKey = `pdf:${plan.instructionKey}:sha256:${contentSha256}`;
    if (result.has(artifactKey)) continue;

    const { data: existing, error: existingError } = await client.from(
      "makesafe_intake_artifacts",
    )
      .select("case_id,artifact_key,status,storage_locator")
      .eq("org_id", DEFAULT_ORG_ID)
      .eq("artifact_key", artifactKey)
      .maybeSingle();
    if (existingError) {
      throw new Error(
        `artifact ledger read failed: ${
          existingError.message || existingError
        }`,
      );
    }
    let path = existing?.status === "completed"
      ? existing.storage_locator
      : null;
    if (existing && existing.case_id !== caseId) {
      throw new Error("artifact ledger case mismatch");
    }
    if (!path) {
      path = `makesafe-deterministic/${
        encodeURIComponent(plan.instructionFingerprint)
      }/sha256-${contentSha256}.pdf`;
      const { error: uploadError } = await client.storage.from("job-documents")
        .upload(path, bytes, {
          contentType: "application/pdf",
          upsert: true,
        });
      if (uploadError) {
        onStorageBlocker("job-documents_upload_failed");
        continue;
      }
      const { error: ledgerError } = await client.from(
        "makesafe_intake_artifacts",
      ).insert({
        org_id: DEFAULT_ORG_ID,
        case_id: caseId,
        artifact_key: artifactKey,
        artifact_kind: "pdf",
        status: "completed",
        storage_locator: path,
        evidence: {
          content_sha256: contentSha256,
          size_bytes: bytes.byteLength,
        },
        recovery_cursor: { version: DETERMINISTIC_INTAKE_VERSION },
        completed_at: new Date().toISOString(),
      });
      if (ledgerError && String(ledgerError.code) !== "23505") {
        throw new Error(
          `artifact ledger insert failed: ${
            ledgerError.message || ledgerError
          }`,
        );
      }
      if (!ledgerError) onPersistedOutcome("artifact");
      if (ledgerError) {
        const { data: raced, error: racedError } = await client.from(
          "makesafe_intake_artifacts",
        )
          .select("case_id,artifact_key,status,storage_locator")
          .eq("org_id", DEFAULT_ORG_ID)
          .eq("artifact_key", artifactKey)
          .maybeSingle();
        if (
          racedError || raced?.case_id !== caseId ||
          raced?.status !== "completed"
        ) {
          throw new Error(
            "artifact ledger race did not resolve to the approved case",
          );
        }
        path = raced.storage_locator;
      }
    }
    const { data: publicUrl } = client.storage.from("job-documents")
      .getPublicUrl(path);
    result.set(artifactKey, {
      name: attachment.name,
      file_name: attachment.name,
      storage_url: path,
      pdf_url: publicUrl?.publicUrl || null,
      is_work_order: true,
      deterministic_artifact_key: artifactKey,
      content_sha256: contentSha256,
    });
  }
  return [...result.values()];
}

async function findCase(
  client: any,
  instructionKey: string,
): Promise<any | null> {
  const { data } = await client.from("makesafe_intake_cases")
    .select("id,instruction_key,lineage_id,cycle,state,job_id")
    .eq("org_id", DEFAULT_ORG_ID)
    .eq("instruction_key", instructionKey)
    .maybeSingle();
  return data || null;
}

// Resolve the selected lineage once for both observation and live execution.
// Exact N=1 authority is case authority, not authority to persist an ambient
// sibling merely because the full mailbox plan happened to encounter it first.
// A fresh selected review-exception sibling may therefore become the root of its
// own authorised lineage. Live candidates and semantic parents
// (revision/cancellation/reopen) remain mandatory.
async function resolveSelectedLineage(
  client: any,
  plan: DeterministicIntakePlan,
  exactSourcePostIds: readonly string[],
): Promise<{
  plan: DeterministicIntakePlan;
  missingParents: DeterministicCasePlan[];
}> {
  const selectedKeys = new Set(plan.cases.map((item) => item.instructionKey));
  const parentKeys = [
    ...new Set(
      plan.cases.flatMap((item) =>
        item.parentInstructionKey ? [item.parentInstructionKey] : []
      ),
    ),
  ];

  // A parent can already be persisted while also appearing in the full-open
  // selected plan. Its database cycle is still authoritative, so read every
  // parent key rather than only dependencies outside the selected set.
  const persisted = new Map<string, { cycle: number }>();
  for (const keys of chunk(parentKeys)) {
    const { data, error } = await client.from("makesafe_intake_cases")
      .select("instruction_key,cycle")
      .eq("org_id", DEFAULT_ORG_ID)
      .in("instruction_key", keys);
    if (error) {
      throw new Error(
        `deterministic lineage dependency read failed: ${
          error.message || error
        }`,
      );
    }
    for (const row of data || []) {
      if (
        row?.instruction_key && Number.isInteger(row.cycle) && row.cycle > 0
      ) {
        persisted.set(row.instruction_key, { cycle: row.cycle });
      }
    }
  }

  const exactSources = new Set(exactSourcePostIds);
  const promotionRemap = new Map<string, string>();
  const cases = plan.cases.map((item) => {
    const missingExternalParent = item.parentInstructionKey &&
      !selectedKeys.has(item.parentInstructionKey) &&
      !persisted.has(item.parentInstructionKey);
    const exactSelected = item.sourcePostIds.some((postId) =>
      exactSources.has(postId)
    );
    if (
      missingExternalParent && exactSelected && item.state === "exception" &&
      item.parentRelation === "sibling_of"
    ) {
      // Exact N=1 authority promotes this review exception to a real root while
      // semantic revision/cancellation/reopen dependencies remain mandatory.
      const rootKey = instructionKeyForCycle(item.instructionKey, 1);
      if (rootKey !== item.instructionKey) {
        promotionRemap.set(item.instructionKey, rootKey);
      }
      return {
        ...rekeyCasePlan(item, rootKey),
        parentInstructionKey: null,
        parentRelation: null,
        cycle: 1,
      };
    }
    return item;
  });

  // Normalize every selected node to the cycle the database trigger derives:
  // roots are cycle 1; reopen children are parent+1; every other relation
  // (sibling, revision, cancellation, duplicate) inherits the parent's cycle.
  // This preserves the typed ancestry and only aligns deterministic key identity
  // with the trigger before any write. Recursive resolution also rebases reopen
  // descendants when an earlier sibling/root collapses to its database cycle.
  const selectedByKey = new Map<string, DeterministicCasePlan>();
  for (const item of cases) selectedByKey.set(item.instructionKey, item);
  for (const [oldKey, newKey] of promotionRemap) {
    const item = selectedByKey.get(newKey);
    if (item) selectedByKey.set(oldKey, item);
  }
  const normalized = new Map<DeterministicCasePlan, DeterministicCasePlan>();
  const visiting = new Set<DeterministicCasePlan>();
  const normalize = (item: DeterministicCasePlan): DeterministicCasePlan => {
    const cached = normalized.get(item);
    if (cached) return cached;
    if (visiting.has(item)) {
      throw new Error("deterministic selected lineage contains a cycle");
    }
    visiting.add(item);

    let parentKey = item.parentInstructionKey;
    let parentCycle: number | null = null;
    if (parentKey) {
      const promotedParentKey = promotionRemap.get(parentKey) || parentKey;
      const selectedParent = selectedByKey.get(parentKey) ||
        selectedByKey.get(promotedParentKey);
      if (selectedParent) {
        const resolvedParent = normalize(selectedParent);
        parentKey = resolvedParent.instructionKey;
        parentCycle = resolvedParent.cycle;
      } else {
        const persistedParent = persisted.get(parentKey) ||
          persisted.get(promotedParentKey);
        if (persistedParent) parentCycle = persistedParent.cycle;
        parentKey = promotedParentKey;
      }
    }

    const expectedCycle = parentKey && parentCycle !== null
      ? item.parentRelation === "reopen_of" ? parentCycle + 1 : parentCycle
      : parentKey
      ? item.cycle
      : 1;
    const instructionKey = instructionKeyForCycle(
      item.instructionKey,
      expectedCycle,
    );
    const result = {
      ...rekeyCasePlan(item, instructionKey),
      parentInstructionKey: parentKey,
      cycle: expectedCycle,
    };
    visiting.delete(item);
    normalized.set(item, result);
    return result;
  };
  const relinked = cases.map(normalize);
  const selectedResolvedKeys = new Set(
    relinked.map((item) => item.instructionKey),
  );
  const resolvedPlan = {
    ...plan,
    cases: relinked,
    sourceClassifications: relinked.flatMap((item) =>
      item.sourceClassifications
    ),
  };
  const missingParents = relinked.filter((item) =>
    item.parentInstructionKey &&
    !selectedResolvedKeys.has(item.parentInstructionKey) &&
    !persisted.has(item.parentInstructionKey)
  );
  return { plan: resolvedPlan, missingParents };
}

// Statuses that mean an existing job is no longer a live obligation. A later
// genuine re-issue of the same claim/PO must NOT bind to a dead job, so these are
// excluded from the obligation match (the boundary then creates a live job).
const OBLIGATION_DEAD_STATUSES = new Set([
  "cancelled",
  "canceled",
  "void",
  "voided",
  "superseded",
]);

function isDeadObligationJobStatus(status: unknown): boolean {
  return OBLIGATION_DEAD_STATUSES.has(
    String(status ?? "").trim().toLowerCase(),
  );
}

function obligationRefNumericCore(value: unknown): string | null {
  const matches = String(value ?? "").match(/\d{5,}/g);
  return matches?.[0] ?? null;
}

function obligationAddressKey(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\bwa\b/g, " ")
    .replace(/\b\d{4}\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function obligationAddressesMatch(left: unknown, right: unknown): boolean {
  const a = obligationAddressKey(left);
  const b = obligationAddressKey(right);
  if (!a || !b) return false;
  return a === b || (a.length >= 12 && b.length >= 12 &&
    (a.includes(b) || b.includes(a)));
}

async function readExistingObligationJobs(
  client: any,
  cases: readonly DeterministicCasePlan[],
  targetJobByPostId: ReadonlyMap<string, string>,
): Promise<Map<string, string>> {
  if (!cases.some((item) => item.identity.externalRefCanonical)) {
    return new Map();
  }
  const prefixes = await loadRefPrefixes(client);
  // A truncated page would hide an existing obligation past the PostgREST
  // 1000-row cap and let runDeterministicIntake create a duplicate live job for
  // the same obligation, so the dedupe read is paged to exhaustion.
  const data: any[] = [];
  for (let from = 0;; from += SOURCE_PAGE_SIZE) {
    const { data: page, error } = await client.from("makesafe_job_details")
      .select(
        "job_id,external_ref,requesting_company_slug,requesting_company_name,report_type,jobs(metadata,status,site_address,type)",
      )
      .order("job_id", { ascending: true })
      .range(from, from + SOURCE_PAGE_SIZE - 1);
    if (error) {
      throw new Error(
        `deterministic external-obligation dedupe read failed: ${
          error.message || error
        }`,
      );
    }
    const rows = page || [];
    data.push(...rows);
    if (rows.length < SOURCE_PAGE_SIZE) break;
  }
  const matches = new Map<string, string>();
  for (const item of cases) {
    // Exception/accounted rows cannot carry a job_id under the case-model DB
    // checks. They remain safely accounted without a job until evidence makes
    // them live-ready; the same boundary will bind the recovery job on that run.
    if (
      item.state !== "confirmed_live_job" && item.state !== "blocked_live_job"
    ) continue;
    const targetRef = canonicalExternalObligationRef(
      item.identity.externalRefCanonical,
      prefixes,
    );
    const targetCompany = canonicalCompanyDedupeKey(item.identity.builderSlug);
    const targetAddress = item.identity.siteAddress;
    const correctedTargetJobIds = new Set(
      item.sourcePostIds.flatMap((postId) => {
        const jobId = targetJobByPostId.get(postId);
        return jobId ? [jobId] : [];
      }),
    );
    if (correctedTargetJobIds.size > 1) {
      throw new Error(
        "one deterministic instruction maps to multiple corrected target jobs; reconciliation required",
      );
    }
    const correctedTargetJobId = [...correctedTargetJobIds][0] || null;
    // Mirror the existing/approve side: a distinct PO carried only in the work
    // order field or the composite external ref still discriminates, so two
    // explicitly-different POs are never over-deduped into one obligation.
    const targetPo =
      canonicalObligationPoCore(item.identity.builderPoCanonical) ||
      canonicalObligationPoCore(item.identity.builderWoCanonical, true) ||
      canonicalObligationPoCore(item.identity.externalRefCanonical, true);
    if (!targetRef || !targetCompany) continue;
    const targetReportOnly = deterministicPrimaryIsReportOnly(item);
    const matchingRows = (data || []).filter((row: any) => {
      if (!row?.job_id) return false;
      const existingCompany = canonicalCompanyDedupeKey(
        row.requesting_company_slug || row.requesting_company_name,
      );
      if (!existingCompany || existingCompany !== targetCompany) return false;
      if (isReportOnlyType(row.report_type) !== targetReportOnly) return false;
      const existingJob = Array.isArray(row.jobs) ? row.jobs[0] : row.jobs;
      if (existingJob?.type && existingJob.type !== "makesafe") return false;
      // A cancelled/void/superseded job is a dead obligation: a later genuine
      // re-issue of the same claim/PO must create a live job, not bind here.
      if (isDeadObligationJobStatus(existingJob?.status)) return false;
      const existingRef = canonicalExternalObligationRef(
        row.external_ref,
        prefixes,
      );
      const exactRefMatch = existingRef === targetRef;
      // Direct-ops jobs can store the same builder-scoped obligation as a bare
      // number (AJBR-70062 versus 70062). Accept that storage difference only
      // when builder and address also agree; reference core alone is insufficient.
      const targetRefCore = obligationRefNumericCore(targetRef);
      const builderScopedBareRefMatch = !!targetAddress &&
        targetRefCore !== null &&
        targetRefCore === obligationRefNumericCore(existingRef) &&
        obligationAddressesMatch(targetAddress, existingJob?.site_address);
      if (!exactRefMatch && !builderScopedBareRefMatch) return false;
      const metadata = existingJob?.metadata &&
          typeof existingJob.metadata === "object"
        ? existingJob.metadata
        : {};
      // Distinct explicit PO stored only in builder_work_order_number still
      // counts, so two explicitly-different POs are never over-deduped.
      const existingPo =
        canonicalObligationPoCore(metadata.builder_po_number) ||
        canonicalObligationPoCore(metadata.builder_work_order_number, true) ||
        canonicalObligationPoCore(row.external_ref, true);
      // One claim can carry distinct PO-backed instructions. Canonical claim
      // matching dedupes storage variants, never two explicitly different POs.
      return !(targetPo && existingPo && targetPo !== existingPo);
    });
    const uniqueMatches = [
      ...new Map(
        matchingRows.map((row: any) => [String(row.job_id), row]),
      ).values(),
    ];
    if (uniqueMatches.length > 1) {
      throw new Error(
        "multiple live jobs matched one deterministic builder reference and address; reconciliation required",
      );
    }
    const match = uniqueMatches[0] || null;
    if (
      correctedTargetJobId &&
      (!match || String(match.job_id) !== correctedTargetJobId)
    ) {
      throw new Error(
        "corrected target job no longer uniquely matches deterministic identity; reconciliation required",
      );
    }
    if (match) matches.set(item.instructionKey, match.job_id);
  }
  return matches;
}

async function readPersistedCases(
  client: any,
  cases: readonly DeterministicCasePlan[],
): Promise<Map<string, any>> {
  const rows = new Map<string, any>();
  for (const keys of chunk(cases.map((c) => c.instructionKey))) {
    const { data, error } = await client.from("makesafe_intake_cases")
      .select(
        "id,instruction_key,lineage_id,cycle,state,job_id,last_decision_provenance,normaliser_version",
      )
      .eq("org_id", DEFAULT_ORG_ID)
      .in("instruction_key", keys);
    // Failing open would silently degrade the run ordering back to a plain
    // head-of-list slice, so a partial read aborts instead.
    if (error) {
      throw new Error(
        `deterministic case state read failed: ${error.message || error}`,
      );
    }
    for (const row of data || []) rows.set(row.instruction_key, row);
  }
  return rows;
}

// Which sources a case has already accounted. New evidence arriving on a case is
// the only reason a previously stuck case can advance, so it is the signal that
// keeps repeat failures from re-occupying the priority head of every run.
async function readPersistedSourcePostIds(
  client: any,
  caseIds: readonly string[],
): Promise<Map<string, Set<string>>> {
  const byCase = new Map<string, Set<string>>();
  for (const ids of chunk(caseIds)) {
    // A truncated page would look like unaccounted evidence and put stuck cases
    // back at the head of every run, so the read is paged to exhaustion.
    for (let from = 0;; from += SOURCE_PAGE_SIZE) {
      const { data, error } = await client.from("makesafe_intake_case_sources")
        .select("case_id,post_id")
        .eq("org_id", DEFAULT_ORG_ID)
        .in("case_id", ids)
        .order("case_id", { ascending: true })
        .order("post_id", { ascending: true })
        .range(from, from + SOURCE_PAGE_SIZE - 1);
      if (error) {
        throw new Error(
          `deterministic case source read failed: ${error.message || error}`,
        );
      }
      const rows = data || [];
      for (const row of rows) {
        const set = byCase.get(row.case_id) || new Set<string>();
        set.add(row.post_id);
        byCase.set(row.case_id, set);
      }
      if (rows.length < SOURCE_PAGE_SIZE) break;
    }
  }
  return byCase;
}

async function findIdentityParent(
  client: any,
  plan: DeterministicCasePlan,
): Promise<any | null> {
  if (!inferredParentRelation(plan) || !plan.identity.companyKey) return null;
  let query = client.from("makesafe_intake_cases")
    .select("id,instruction_key,lineage_id,cycle,state,job_id")
    .eq("org_id", DEFAULT_ORG_ID)
    .eq("company_key", plan.identity.companyKey)
    .in("state", ["confirmed_live_job", "blocked_live_job"])
    .order("received_at", { ascending: false })
    .limit(1);
  if (plan.identity.woPoIdentityKey) {
    query = query.eq("wo_po_identity_key", plan.identity.woPoIdentityKey);
  } else if (plan.identity.externalRefCanonical) {
    query = query.eq(
      "external_ref_canonical",
      plan.identity.externalRefCanonical,
    );
  } else return null;
  const { data, error } = await query.maybeSingle();
  if (error) {
    throw new Error(`lineage parent read failed: ${error.message || error}`);
  }
  return data || null;
}

async function findDraft(
  client: any,
  deterministicKey: string,
): Promise<any | null> {
  const { data } = await client.from("makesafe_intake_drafts")
    .select("id,status,approved_job_id")
    .eq("org_id", DEFAULT_ORG_ID)
    .eq("deterministic_key", deterministicKey)
    .maybeSingle();
  return data || null;
}

// Parity with approveIntakeDraft's combinedSplitObligation: a report-family plan
// whose primary is a combined make-safe + report keeps a physical WO on the
// primary card, so the split report type belongs to the secondary card only.
const COMBINED_OBLIGATION_MISSING_FIELD = "combined_makesafe_and_report";

function deterministicSplitObligation(
  plan: DeterministicCasePlan,
): { reportType: string } | null {
  const so = plan.secondaryObligation;
  if (!so || typeof so !== "object") return null;
  if (so.reason !== COMBINED_OBLIGATION_MISSING_FIELD) return null;
  return isReportOnlyType(so.type) ? { reportType: so.type } : null;
}

// Mirrors approveIntakeDraft's primaryIsReportOnly: a report family is report-only
// UNLESS it carries a split obligation, in which case the primary is physical and a
// servable work-order PDF is required before any storage/artifact/draft write.
function deterministicPrimaryIsReportOnly(
  plan: DeterministicCasePlan,
): boolean {
  if (deterministicSplitObligation(plan)) return false;
  return plan.identity.jobFamily === "roof_report" ||
    plan.identity.jobFamily === "assessment_report_quote";
}

function approvalPrevalidationMissingFields(
  plan: DeterministicCasePlan,
  sourceMap: Map<string, DeterministicSourceItem>,
): string[] {
  const missing: string[] = [];
  if (!plan.identity.builderSlug) missing.push("requesting_company");
  if (
    !plan.identity.builderWoCanonical &&
    !plan.identity.externalRefCanonical
  ) missing.push("external_ref");
  if (!plan.identity.clientName) missing.push("client_name");
  if (!plan.identity.siteAddress) missing.push("site_address");
  const reportOnly = deterministicPrimaryIsReportOnly(plan);
  const hasWorkOrderPdf = plan.sourcePostIds.some((postId) =>
    (sourceMap.get(postId)?.attachments || []).some((attachment) =>
      attachment.status === "uploaded" && Boolean(attachment.storagePath) &&
      (/pdf/i.test(attachment.contentType || "") ||
        /\.pdf$/i.test(attachment.name || ""))
    )
  );
  if (!reportOnly && !hasWorkOrderPdf) missing.push("work_order_pdf");
  return missing;
}

async function ensureDraftAndJob(
  client: any,
  caseId: string,
  plan: DeterministicCasePlan,
  sourceMap: Map<string, DeterministicSourceItem>,
  approveDraft: (client: any, body: any) => Promise<any>,
  onStorageBlocker: (blocker: string) => void,
  onPersistedOutcome: (outcome: PersistedOutcome) => void,
): Promise<
  {
    jobId: string;
    draftCreated: boolean;
    jobCreated: boolean;
    resumed: boolean;
  }
> {
  // Run the same required-field gate as approval before storage, artifact-ledger
  // or draft writes. A validation rejection must leave no persisted side effects.
  const prevalidationMissing = approvalPrevalidationMissingFields(
    plan,
    sourceMap,
  );
  if (prevalidationMissing.length) {
    throw new Error(
      `deterministic approval prevalidation failed: ${
        prevalidationMissing.join(", ")
      }`,
    );
  }
  const key = plan.recoveryCursor.sideEffectKeys.draft;
  let draft = await findDraft(client, key);
  let draftCreated = false;
  if (!draft) {
    const primary = sourceMap.get(plan.primarySourcePostId)!;
    const attachments = await stageAttachments(
      client,
      caseId,
      plan,
      sourceMap,
      onStorageBlocker,
      onPersistedOutcome,
    );
    if (!attachments.length && !deterministicPrimaryIsReportOnly(plan)) {
      throw new Error("deterministic work-order attachment staging failed");
    }
    const splitObligation = deterministicSplitObligation(plan);
    const extraction = {
      deterministic_intake: true,
      deterministic_version: DETERMINISTIC_INTAKE_VERSION,
      makesafe_job_family: plan.identity.jobFamily,
      builder_claim_ref: plan.identity.externalRefCanonical,
      builder_work_order_number: plan.identity.builderWoCanonical,
      builder_po_number: plan.identity.builderPoCanonical,
      portal_links: primary.links,
      story: plan.story,
      evidence_map: plan.evidenceMap,
      recovery_cursor: plan.recoveryCursor,
      builder_email_subject: primary.subject,
      builder_email_received_at: primary.receivedAt,
      description: plan.identity.description,
      work_order_pdf_text: plan.pdfDocuments.map((document) => ({
        source_post_id: document.sourcePostId,
        attachment_id: document.attachmentId,
        attachment_name: document.attachmentName,
        status: document.status,
        text: document.text,
        char_count: document.charCount,
        page_count: document.pageCount,
        extractor: document.extractor,
        truncated: document.truncated,
        reason: document.reason,
      })),
      pdf_field_provenance: plan.fieldProvenance,
      pdf_sourced_fields: Object.keys(plan.fieldProvenance),
      ...(plan.secondaryObligation
        ? { secondary_obligation: plan.secondaryObligation }
        : {}),
    };
    const { data, error } = await client.from("makesafe_intake_drafts").insert({
      org_id: DEFAULT_ORG_ID,
      mailbox: SES_MAILBOX,
      graph_message_id: `deterministic:${plan.instructionFingerprint}`,
      received_at: primary.receivedAt,
      from_email: primary.fromEmail,
      from_name: primary.fromName || null,
      subject: primary.subject,
      body_preview: null,
      requesting_company_slug: plan.identity.builderSlug,
      requesting_company_name: plan.identity.builderSlug,
      external_ref: plan.identity.builderWoCanonical ||
        plan.identity.externalRefCanonical,
      client_name: plan.identity.clientName,
      client_phone: plan.identity.clientPhone,
      client_email: plan.identity.clientEmail,
      site_address: plan.identity.siteAddress,
      site_suburb: plan.identity.siteSuburb,
      description: plan.identity.description || plan.identity.jobFamily,
      confidence: "high",
      missing_fields: plan.blockedReasons,
      extraction_json: extraction,
      attachments_json: attachments,
      report_type: splitObligation
        ? null
        : plan.identity.jobFamily === "roof_report"
        ? "roof_report"
        : plan.identity.jobFamily === "assessment_report_quote"
        ? "assessment_report"
        : null,
      status: "needs_review",
      deterministic_key: key,
    }).select("id,status,approved_job_id").single();
    if (error) {
      draft = await findDraft(client, key);
      if (!draft) {
        throw new Error(
          `deterministic draft insert failed: ${error.message || error}`,
        );
      }
    } else {
      draft = data;
      draftCreated = true;
      onPersistedOutcome("draft");
    }
  }
  if (draft.approved_job_id) {
    return {
      jobId: draft.approved_job_id,
      draftCreated,
      jobCreated: false,
      resumed: true,
    };
  }
  if (draft.status === "approved") {
    const refreshed = await findDraft(client, key);
    if (refreshed?.approved_job_id) {
      return {
        jobId: refreshed.approved_job_id,
        draftCreated,
        jobCreated: false,
        resumed: true,
      };
    }
    throw new Error(
      "approved deterministic draft has no job link; reconciliation required",
    );
  }
  const approved = await approveDraft(client, {
    draft_id: draft.id,
    approved_by: DETERMINISTIC_INTAKE_VERSION,
    review_notes:
      "Deterministic adapter approval through the existing guarded intake gate. No allocation, invoice, send or money action.",
  });
  const jobId = approved?.job?.id;
  if (!jobId) throw new Error("guarded approval returned no job id");
  return { jobId, draftCreated, jobCreated: true, resumed: !draftCreated };
}

export const _ensureDraftAndJobForTest = ensureDraftAndJob;

// Mirrors makesafe_intake_case_transition_allowed in migration 20260720000001.
// An upgrade is attempted only along an edge the database already accepts.
const ALLOWED_TRANSITIONS: Record<string, readonly string[]> = {
  confirmed_live_job: ["blocked_live_job"],
  blocked_live_job: ["confirmed_live_job", "exception"],
  exception: ["confirmed_live_job", "blocked_live_job", "accounted_non_wo"],
  accounted_non_wo: ["exception"],
};

async function insertCaseAndSources(
  client: any,
  plan: DeterministicCasePlan,
  jobId: string | null,
  sourceMap: Map<string, DeterministicSourceItem>,
  knownExisting?: any | null,
  skipSources = false,
): Promise<
  {
    caseRow: any;
    caseCreated: boolean;
    caseUpgraded: boolean;
    sourceCreated: number;
    resumed: boolean;
  }
> {
  let existing = knownExisting !== undefined
    ? knownExisting
    : await findCase(client, plan.instructionKey);
  let caseCreated = false;
  let caseUpgraded = false;
  if (!existing) {
    const parent = plan.parentInstructionKey
      ? await findCase(client, plan.parentInstructionKey)
      : await findIdentityParent(client, plan);
    if (plan.parentInstructionKey && !parent) {
      throw new Error("lineage parent is not persisted yet; retry child later");
    }
    const { data, error } = await client.from("makesafe_intake_cases")
      .insert(casePayload(plan, jobId, parent))
      .select("id,instruction_key,lineage_id,cycle,state,job_id")
      .single();
    if (error) {
      existing = await findCase(client, plan.instructionKey);
      if (!existing) {
        throw new Error(
          `deterministic case insert failed: ${error.message || error}`,
        );
      }
    } else {
      existing = data;
      caseCreated = true;
    }
  } else {
    // A resumed case is re-decided against the current plan. Late evidence (a work
    // order PDF that landed after the instruction email) must be able to promote a
    // reason-coded exception into a live job rather than staying stuck forever.
    const desired = casePayload(plan, jobId, null);
    const nextState = desired.state as string;
    if (
      nextState !== existing.state &&
      (ALLOWED_TRANSITIONS[existing.state as string] || []).includes(nextState)
    ) {
      // Persisted instruction/lineage/identity fields are authority. Resuming a
      // case may enrich its operational facts and state, but a moving page must
      // never restamp immutable identity (especially after a correction overlay).
      const mutable = {
        client_name: desired.client_name,
        client_phone: desired.client_phone,
        client_email: desired.client_email,
        site_address: desired.site_address,
        site_suburb: desired.site_suburb,
        missing_fields: desired.missing_fields,
        conflicting_fields: desired.conflicting_fields,
        state: desired.state,
        reason_code: desired.reason_code,
        blocked_reasons: desired.blocked_reasons,
        is_authoritative: desired.is_authoritative,
        side_effects_suppressed: desired.side_effects_suppressed,
        last_decision_provenance: desired.last_decision_provenance,
        last_decision_actor: desired.last_decision_actor,
        last_decision_reason: desired.last_decision_reason,
        story_json: desired.story_json,
        evidence_map: desired.evidence_map,
        recovery_cursor: desired.recovery_cursor,
      };
      const { data, error } = await client.from("makesafe_intake_cases")
        .update({ ...mutable, job_id: jobId ?? existing.job_id ?? null })
        .eq("org_id", DEFAULT_ORG_ID)
        .eq("instruction_key", plan.instructionKey)
        .select("id,instruction_key,lineage_id,cycle,state,job_id")
        .single();
      if (error) {
        throw new Error(
          `deterministic case update failed: ${error.message || error}`,
        );
      }
      existing = data;
      caseUpgraded = true;
    }
  }
  let sourceCreated = 0;
  for (const postId of skipSources ? [] : plan.sourcePostIds) {
    const source = sourceMap.get(postId)!;
    const refs = source.attachments.map((a) => a.id);
    const { error } = await client.from("makesafe_intake_case_sources").insert({
      org_id: DEFAULT_ORG_ID,
      case_id: existing.id,
      post_id: postId,
      role: sourceRole(plan, postId),
      internet_message_id: source.internetMessageId || null,
      conversation_id: source.conversationId || null,
      thread_id: source.threadId || null,
      attachment_refs: refs,
      raw_identity_json: {},
      evidence: {
        adapter_id: plan.adapterId,
        instruction_key: plan.instructionKey,
        pdf_extraction: (source.pdfDocuments || []).map((document) => ({
          attachment_id: document.attachmentId,
          attachment_name: document.attachmentName,
          status: document.status,
          text: document.text,
          char_count: document.charCount,
          page_count: document.pageCount,
          extractor: document.extractor,
          truncated: document.truncated,
          reason: document.reason,
        })),
      },
      provenance: "deterministic",
      received_at: source.receivedAt,
    });
    if (!error) sourceCreated++;
    else if (
      String(error.code) !== "23505" &&
      !/duplicate|unique/i.test(error.message || "")
    ) {
      throw new Error(
        `deterministic source accounting failed: ${error.message || error}`,
      );
    }
  }
  return {
    caseRow: existing,
    caseCreated,
    caseUpgraded,
    sourceCreated,
    resumed: !caseCreated,
  };
}

// A run that filed nothing because its configuration sat outside the read cap is
// not a successful extraction. It must degrade the durable health row too, or the
// alarm and morning-report surfaces keep reading a fresh success while the scan
// response is the only place the caveat exists.
async function writeHealth(
  client: any,
  nowIso: string,
  writeFailures: number,
  draftsCreated: number,
  jobsCreated: number,
  degradedReason?: string,
): Promise<void> {
  const reason = writeFailures > 0
    ? "deterministic_write_failure"
    : (degradedReason ?? null);
  const { error } = await client.from("makesafe_intake_health").upsert({
    id: true,
    extraction_status: reason ? "degraded" : "ok",
    degraded_reason: reason,
    degraded_since: reason ? nowIso : null,
    last_scan_at: nowIso,
    ...(reason ? {} : { last_successful_extraction_at: nowIso }),
    last_scan_drafts_created: draftsCreated,
    last_scan_auto_filed: jobsCreated,
    intake_mode: "deterministic",
    last_scan_model_calls: 0,
    updated_at: nowIso,
  }, { onConflict: "id" });
  if (error) {
    throw new Error(
      `deterministic health write failed: ${error.message || error}`,
    );
  }
}

export async function runDeterministicIntake(
  client: any,
  options: DeterministicRuntimeOptions = {},
): Promise<DeterministicRuntimeReport> {
  const dryRun = options.dryRun !== false;
  const selectionMode = options.selectionMode ?? "exact";
  if (selectionMode !== "exact" && selectionMode !== "full_open") {
    throw new Error("deterministic selection mode must be exact or full_open");
  }
  const days = Math.max(1, Math.min(options.days ?? 60, 180));
  const nowIso = options.nowIso || new Date().toISOString();
  const onlyUnscanned = options.onlyUnscanned === true;
  const allowSourcePostIds = exactAllowlist(
    options.allowSourcePostIds ?? [],
    "source allowlist",
  );
  const allowInstructionKeys = exactAllowlist(
    options.allowInstructionKeys ?? [],
    "instruction allowlist",
  );
  const hasAllowlist = allowSourcePostIds.length > 0 ||
    allowInstructionKeys.length > 0;
  if (!dryRun && selectionMode === "exact" && !hasAllowlist) {
    throw new Error(
      "deterministic exact mode requires a non-empty exact DB allowlist",
    );
  }
  if (selectionMode === "full_open" && hasAllowlist) {
    throw new Error(
      "deterministic full_open mode requires empty exact allowlists",
    );
  }
  if (options.includeSanitizedCases && !hasAllowlist) {
    throw new Error(
      "case-level dark observe requires a non-empty exact allowlist",
    );
  }
  const maxSources = Number(options.maxSources ?? DEFAULT_MAX_SOURCES_PER_RUN);
  if (
    !Number.isInteger(maxSources) || maxSources < 1 ||
    maxSources > MAX_SOURCES_PER_RUN
  ) {
    throw new Error(
      `deterministic source read cap must be an integer between 1 and ${MAX_SOURCES_PER_RUN}`,
    );
  }
  const instructionSeeds = await resolveInstructionKeySeeds(
    client,
    allowInstructionKeys,
  );
  const exactSourceAuthorities = await resolvePersistedSourceAuthorities(
    client,
    allowSourcePostIds,
  );
  const cursorColumns = dryRun ? OBSERVE_CURSOR_COLUMNS : LIVE_CURSOR_COLUMNS;
  const cursor = await readScanCursor(client, cursorColumns);
  const input = await readInputs(client, {
    days,
    onlyUnscanned,
    nowIso,
    maxSources,
    cursor,
    seedPostIds: [
      ...allowSourcePostIds,
      ...instructionSeeds.postIds,
      ...exactSourceAuthorities.seedPostIds,
    ],
  });
  // Selection and ranking must use canonical ownership for every bounded source.
  // Otherwise a moving page can regroup an already-accounted source under another
  // case, classify it as fresh, and spend the whole case cap on duplicate inserts
  // while genuinely unaccounted tail sources starve.
  const sourceAuthorities = await resolvePersistedSourceAuthorities(
    client,
    input.sources.map((source) => source.postId),
  );
  // The cursor is a completion checkpoint, not a read-ahead marker. Persisting it
  // here used to let a caller timeout after the read but before accounting/health,
  // temporarily hiding an entire page behind unproved progress. Commit it only
  // after the run has completed its writes and truthful health update. A failed or
  // cancelled request therefore rereads the same page; deterministic natural keys
  // make that retry safe.
  const fullPlan = buildDeterministicIntakePlan(input.sources, input.profiles);
  // Canonical source ownership is part of selection, not a repair after it. Full
  // open binds its whole bounded plan. Exact mode must not validate or fail on an
  // unrelated case merely because that case shares the ambient 500-source page:
  // close the raw selected ancestry, bind only that closure, then select/close it
  // again. The second pass prunes a page-only ambient ancestor when a persisted
  // exact source binds back to its authoritative root; a genuinely fresh child
  // keeps its edge and therefore keeps its required parent closure.
  // Instruction allowlists seed their persisted sources before the bounded read;
  // include those ids as internal selection coordinates so a moving raw key can
  // still reach the case that binding restores to the allowlisted stable key.
  const exactSelectionSourcePostIds = [
    ...allowSourcePostIds,
    ...instructionSeeds.postIds,
  ];
  const rawSelected = selectionMode === "full_open"
    ? fullPlan
    : hasAllowlist
    ? selectedPlan(
      fullPlan,
      exactSelectionSourcePostIds,
      allowInstructionKeys,
    )
    : fullPlan;
  const boundSelection = bindPlanComponentsToPersistedAuthority(
    rawSelected,
    sourceAuthorities.byPostId,
    sourceAuthorities.expectedIdentityByPostId,
  );
  const selected = selectionMode === "exact" && hasAllowlist
    ? selectedPlan(
      boundSelection.plan,
      exactSelectionSourcePostIds,
      allowInstructionKeys,
    )
    : boundSelection.plan;
  const isolatedFailures = boundSelection.isolatedFailures;
  const requireAllAllowlistMatches =
    options.requireAllAllowlistMatches === true ||
    options.includeSanitizedCases === true;
  const lineage = await resolveSelectedLineage(
    client,
    selected,
    allowSourcePostIds,
  );
  const plan = lineage.plan;
  const missingParents = lineage.missingParents;
  const matchedCaseSources = new Set(
    [
      ...plan.cases.flatMap((intakeCase) => intakeCase.sourcePostIds),
      ...isolatedFailures.flatMap((failure) => failure.source_post_ids),
    ],
  );
  const matchedCaseKeys = new Set(
    [
      ...plan.cases.map((intakeCase) => intakeCase.instructionKey),
      ...isolatedFailures.flatMap((failure) =>
        failure.planned_instruction_keys
      ),
    ],
  );
  // Source ids are always read by id, so an unmatched one is always genuinely
  // stale. An instruction key is only a fair test when its sources were seeded by
  // id or the run read the whole window; otherwise the cap, not the key, is the
  // reason it missed.
  const unmatchedSourceAllowlist = allowSourcePostIds.filter((postId) =>
    !matchedCaseSources.has(postId)
  );
  const unresolvedInstructionKeys = allowInstructionKeys.filter((key) =>
    !matchedCaseKeys.has(key)
  );
  const capExposedInstructionKeys = input.read.cap_reached
    ? unresolvedInstructionKeys.filter((key) =>
      !instructionSeeds.capProofKeys.has(key)
    )
    : [];
  const capExposedSet = new Set(capExposedInstructionKeys);
  const unmatchedInstructionAllowlist = unresolvedInstructionKeys.filter((
    key,
  ) => !capExposedSet.has(key));
  if (
    requireAllAllowlistMatches &&
    (unmatchedSourceAllowlist.length || unmatchedInstructionAllowlist.length)
  ) {
    throw new Error(
      `exact deterministic allowlist did not resolve (${unmatchedSourceAllowlist.length} source ids, ${unmatchedInstructionAllowlist.length} instruction keys)`,
    );
  }
  const caveats: string[] = [];
  if (input.read.cap_reached || input.read.next_cursor_at !== null) {
    caveats.push("source_read_capped");
  }
  if (input.read.cursor_at !== null) caveats.push("source_sweep_partial");
  if (capExposedInstructionKeys.length) {
    caveats.push("instruction_allowlist_cap_exposed");
  }
  if (missingParents.length) caveats.push("lineage_parent_unselected");
  if (isolatedFailures.length) {
    caveats.push("lineage_components_quarantined");
  }
  // Nothing this run could act on was inside the cap, and every unresolved
  // allowlist entry was cap-exposed rather than stale. That is a no-op the sweep
  // will resolve on a later run, so it is reported loudly instead of throwing.
  const capExposedNoOp = !plan.cases.length &&
    capExposedInstructionKeys.length > 0 &&
    !unmatchedSourceAllowlist.length &&
    !unmatchedInstructionAllowlist.length;
  if (capExposedNoOp) caveats.push("no_cases_readable_within_cap");
  const isolatedNoOp = !plan.cases.length && isolatedFailures.length > 0;
  const sourceAccountingComplete = !input.read.cap_reached &&
    input.read.cursor_at === null && input.read.next_cursor_at === null;
  const report: DeterministicRuntimeReport = {
    ok: true,
    mode: "deterministic",
    completion_status: missingParents.length || isolatedFailures.length
      ? "completed_degraded"
      : "completed",
    dry_run: dryRun,
    ai_enabled: false,
    ai_calls: 0,
    generated_at: nowIso,
    days,
    totals: {
      ...plan.totals,
      case_rows_created: 0,
      source_rows_created: 0,
      artifacts_created: 0,
      drafts_created: 0,
      jobs_created: 0,
      resumed: 0,
      write_failures: missingParents.length,
      cases_attempted: 0,
      cases_deferred: 0,
      cases_failed: missingParents.length,
      job_creation_deferred: 0,
      components_failed: isolatedFailures.length,
      sources_quarantined: new Set(
        isolatedFailures.flatMap((failure) => failure.source_post_ids),
      ).size,
    },
    attempt_cap_reached_without_commit: false,
    selection: {
      mode: selectionMode,
      source_allowlist_count: allowSourcePostIds.length,
      instruction_allowlist_count: allowInstructionKeys.length,
      selected_cases: plan.cases.length,
      selected_sources: plan.totals.sources,
      unmatched_source_allowlist: unmatchedSourceAllowlist.length,
      unmatched_instruction_allowlist: unmatchedInstructionAllowlist.length,
      cap_exposed_instruction_allowlist: capExposedInstructionKeys.length,
      quarantined_components: isolatedFailures.length,
      quarantined_sources: new Set(
        isolatedFailures.flatMap((failure) => failure.source_post_ids),
      ).size,
    },
    source_read: input.read,
    evidence: {
      source_accounting_complete: sourceAccountingComplete,
      zero_unaccounted_proved: sourceAccountingComplete &&
        plan.totals.unaccounted === 0,
      caveats,
    },
    identity_floor: identityFloorFacts(plan),
    by_builder_and_outcome: byBuilderOutcome(plan),
    by_builder_and_reason: byBuilderReason(plan),
    write_failure_reasons: missingParents.length
      ? { lineage_parent_unselected: missingParents.length }
      : {},
    isolated_failures: isolatedFailures,
    storage_blockers: [],
  };
  for (const failure of isolatedFailures) {
    report.write_failure_reasons[failure.reason] =
      (report.write_failure_reasons[failure.reason] || 0) + 1;
    report.totals.write_failures++;
    report.totals.cases_failed++;
  }
  if (options.includeSanitizedCases) {
    report.proposed_cases = await sanitizedCases(plan);
  }
  const commitCompletedCursor = async (): Promise<void> => {
    if (!(await persistScanCursor(client, cursorColumns, input.nextCursor))) {
      report.evidence.caveats.push("scan_cursor_unavailable");
    }
  };
  if (dryRun) {
    await commitCompletedCursor();
    return report;
  }

  if (missingParents.length || isolatedNoOp) {
    report.evidence.caveats.push(
      "scan_page_completed_degraded_retry_next_sweep",
    );
    await writeHealth(client, nowIso, report.totals.write_failures, 0, 0);
    await commitCompletedCursor();
    return report;
  }
  // A stale entry (aged out, deleted, or no longer grouping into a case) is
  // reported through selection.unmatched_* and the run continues on whatever the
  // allowlist did resolve. Only a fully unresolved allowlist fails closed, so a
  // missing key is never mistaken for a successful empty scan.
  // Volume meeting configuration must never poison the cron. When the only reason
  // nothing resolved is that the sources sit outside this run's cap, the run ends
  // as a reported no-op and the sweep brings them inside the cap on a later run.
  if (capExposedNoOp) {
    await writeHealth(
      client,
      nowIso,
      0,
      0,
      0,
      "deterministic_no_cases_readable_within_cap",
    );
    await commitCompletedCursor();
    return report;
  }
  if (!plan.cases.length) {
    throw new Error(
      `exact deterministic allowlist resolved no cases (${report.selection.unmatched_source_allowlist} source ids, ${report.selection.unmatched_instruction_allowlist} instruction keys unmatched, ${report.selection.cap_exposed_instruction_allowlist} instruction keys unread inside the per-run cap)`,
    );
  }
  if (!options.approveDraft) {
    throw new Error(
      "deterministic live mode requires the guarded approval callback",
    );
  }
  const sourceMap = new Map(
    input.sources.map((source) => [source.postId, source]),
  );
  const onStorageBlocker = (blocker: string) => {
    if (!report.storage_blockers.includes(blocker)) {
      report.storage_blockers.push(blocker);
    }
  };
  const maxCases = Number(options.maxCases ?? DEFAULT_MAX_CASES_PER_RUN);
  if (
    !Number.isInteger(maxCases) || maxCases < 1 || maxCases > MAX_CASES_PER_RUN
  ) {
    throw new Error(
      `deterministic runtime cap must be an integer between 1 and ${MAX_CASES_PER_RUN}`,
    );
  }
  // A case can only advance if it is new, if it carries evidence the case row has
  // not accounted yet, or if its persisted state no longer matches what this plan
  // would write for the job it already has. Everything else is stuck until more
  // evidence arrives, including a case whose job creation failed on an earlier run:
  // its sources were accounted before that attempt, so it is not mistaken for
  // fresh work and cannot re-occupy the priority head of every subsequent run.
  const existingObligationJobs = await readExistingObligationJobs(
    client,
    plan.cases,
    sourceAuthorities.targetJobByPostId,
  );
  const persisted = await readPersistedCases(client, plan.cases);
  const persistedSources = await readPersistedSourcePostIds(
    client,
    [...persisted.values()].map((row) => row.id),
  );
  const canonicallyAccountedSources = new Set(
    sourceAuthorities.byPostId.keys(),
  );
  type CaseRank = "fresh" | "job_retry" | "stuck";
  const rankCase = (casePlan: DeterministicCasePlan): CaseRank => {
    const row = persisted.get(casePlan.instructionKey);
    if (!row) return "fresh";
    const known = persistedSources.get(row.id) || new Set<string>();
    if (
      casePlan.sourcePostIds.some((postId) =>
        !known.has(postId) && !canonicallyAccountedSources.has(postId)
      )
    ) {
      return "fresh";
    }
    // The BOX reconciliation migration creates corrected authorities solely to
    // replace a false shared PO identity. They are deliberately non-operational:
    // an ordinary catch-up sweep must not turn reconciled history into hundreds
    // of jobs. Genuinely new, unaccounted evidence still takes the branch above
    // and can advance the corrected authority normally.
    if (
      row.last_decision_provenance === "backfill" &&
      String(row.normaliser_version || "").includes(
        "po_box_reconciliation@v1",
      )
    ) {
      return "stuck";
    }
    const obligationJobId = existingObligationJobs.get(
      casePlan.instructionKey,
    );
    const effectiveJobId = row.job_id || obligationJobId || null;
    if (row.state !== resolvedState(casePlan, effectiveJobId)) {
      return "fresh";
    }
    if (!row.job_id && obligationJobId) return "fresh";
    // Accounted case whose job creation was deferred or failed earlier. It can
    // still advance, but a systematically failing one must never crowd out work
    // that has never been attempted, so it only gets a bounded share of the run.
    if (
      !row.job_id &&
      (casePlan.state === "confirmed_live_job" ||
        casePlan.state === "blocked_live_job")
    ) {
      return "job_retry";
    }
    return "stuck";
  };
  const ranked = new Map<DeterministicCasePlan, CaseRank>();
  for (const c of plan.cases) ranked.set(c, rankCase(c));
  const fresh = plan.cases.filter((c) => ranked.get(c) === "fresh");
  const jobRetries = plan.cases.filter((c) => ranked.get(c) === "job_retry");
  const retryHead = Math.max(1, Math.floor(maxCases / 2));
  const ordered = [
    ...jobRetries.slice(0, retryHead),
    ...fresh,
    ...jobRetries.slice(retryHead),
  ];
  // The budget counts cases that actually committed, so a failure never spends a
  // commit slot. Attempts still carry their own ceiling so one run stays bounded.
  const maxAttempts = maxCases * MAX_ATTEMPT_MULTIPLIER;
  let attempted = 0;
  let committed = 0;
  for (const casePlan of ordered) {
    if (committed >= maxCases || attempted >= maxAttempts) break;
    attempted++;
    try {
      const existing = persisted.get(casePlan.instructionKey) || null;
      const stateBeforeRun: string | null = existing?.state ?? null;
      let jobId: string | null = existing?.job_id ||
        existingObligationJobs.get(casePlan.instructionKey) || null;
      // Account the case and its sources before any job-creating work. Nothing is
      // left outside the accounting invariant when the job attempt fails, and the
      // failed attempt becomes visible to the next run's ordering.
      let saved = await insertCaseAndSources(
        client,
        casePlan,
        jobId,
        sourceMap,
        existing,
      );
      let resumedCase = saved.resumed;
      if (saved.caseCreated) report.totals.case_rows_created++;
      report.totals.source_rows_created += saved.sourceCreated;
      const wantsJob = !jobId &&
        (casePlan.state === "confirmed_live_job" ||
          casePlan.state === "blocked_live_job");
      // Never create a guarded job the case row cannot then be moved to: the
      // update would be skipped and the job left with no case linkage. This is a
      // deferral, not a write failure - the case itself committed. The edge is
      // judged against the state the case held before this run, so accounting it
      // through the permitted exception hop cannot launder a forbidden edge into
      // an allowed one.
      const transitionAllowed = !stateBeforeRun ||
        stateBeforeRun === casePlan.state ||
        (ALLOWED_TRANSITIONS[stateBeforeRun] || []).includes(casePlan.state);
      if (wantsJob && !transitionAllowed) {
        report.totals.job_creation_deferred++;
      }
      if (wantsJob && transitionAllowed) {
        const live = await ensureDraftAndJob(
          client,
          saved.caseRow.id,
          casePlan,
          sourceMap,
          options.approveDraft,
          onStorageBlocker,
          (outcome) => {
            if (outcome === "artifact") report.totals.artifacts_created++;
            if (outcome === "draft") report.totals.drafts_created++;
          },
        );
        jobId = live.jobId;
        if (live.jobCreated) report.totals.jobs_created++;
        resumedCase = resumedCase || live.resumed;
        // Sources were already accounted by the pre-job hop above, so this call
        // only moves the case onto its job.
        saved = await insertCaseAndSources(
          client,
          casePlan,
          jobId,
          sourceMap,
          saved.caseRow,
          true,
        );
      }
      committed++;
      // One case counts once, however many of its artefacts already existed.
      if (resumedCase) report.totals.resumed++;
      // Stamp per case, not once at the end, so a wall-clock timeout keeps the
      // accounting for every case this run already committed.
      //
      // Sources of a case still awaiting evidence stay unstamped: the next run must
      // be able to re-read the original instruction alongside the late work order in
      // order to promote the case. A case that already produced a live job is not
      // awaiting anything, so it settles even when downgraded to an exception.
      const settled = saved.caseRow.state !== "exception" || Boolean(jobId);
      if (!settled) continue;
      for (const ids of chunk(casePlan.sourcePostIds)) {
        const { error } = await client.from("emails")
          .update({ makesafe_scanned_at: nowIso })
          .in("post_id", ids);
        if (error) report.totals.write_failures++;
      }
    } catch (error) {
      // No source contents or PII are logged; only a fixed failure class. The
      // exception/case remains visible on replay and the deterministic natural keys
      // make the next run resumable.
      const reason = classifyWriteFailure(error);
      report.write_failure_reasons[reason] =
        (report.write_failure_reasons[reason] || 0) + 1;
      report.totals.write_failures++;
      report.totals.cases_failed++;
    }
  }
  report.totals.cases_attempted = attempted;
  report.totals.cases_deferred = plan.cases.length - attempted;
  report.attempt_cap_reached_without_commit = attempted >= maxAttempts &&
    committed === 0;
  await writeHealth(
    client,
    nowIso,
    report.totals.write_failures,
    report.totals.drafts_created,
    report.totals.jobs_created,
  );
  if (report.totals.write_failures > 0 || report.totals.cases_failed > 0) {
    report.completion_status = "completed_degraded";
    // This invocation completed and wrote truthful degraded health, so advance
    // rather than letting one poison case pin every older page. The full sweep
    // resets to the window head and retries it on the next cycle; the caveat keeps
    // that delayed retry explicit. Cancellation/throws never reach this checkpoint
    // and therefore retain the prior cursor for immediate idempotent reread.
    report.evidence.caveats.push(
      "scan_page_completed_degraded_retry_next_sweep",
    );
  }
  await commitCompletedCursor();
  return report;
}
