#!/usr/bin/env -S deno run --allow-env --allow-net --allow-read --allow-write
// deno-lint-ignore-file no-explicit-any
/**
 * Re-runnable SES Phase A/B proof checker.
 *
 * This is the rollback anchor's evidence generator: it re-proves, against live
 * production and read-only, every claim the A/B certificate makes
 * (`docs/evidence/ses-ab-certificate-2026-08-01.md`).
 *
 * Production safety contract:
 * - the only production access is the Supabase Management API
 *   `/database/query` endpoint with `read_only: true`, so the database itself
 *   refuses a write even if a statement slipped through;
 * - `assertReadOnlySql` additionally refuses any statement that does not start
 *   with SELECT/WITH or that names a write verb, before the request is sent;
 * - `assertNoPiiColumns` refuses any statement naming a client-identifying
 *   column. Suburb is the only client-locating field this checker may read, and
 *   nothing here selects it either.
 *
 * What is asserted is split three ways:
 * - phase A: intake source/case accounting and the two captain-ruled creations;
 * - phase B: the adjudicated verdict table ADVANCED by the applied ledgers, and
 *   its documented holds;
 * - droid: every builder work order that production resolves to more than one
 *   card is accounted for by the committed adjudication fixture.
 *
 * The advance model (phase B) is deliberately explicit, because a fixture read
 * on its own is stale:
 *   round 1 (PR 454) -> round 2 field (PR 458) -> round 2 temp fence (PR 458)
 *   -> SWMS-26692 family backfill (PR 463) -> documented captain holds.
 * FAMILY TRUTH RULE: where round 2's production decider re-labelled a card the
 * round-1 fixture had already labelled, round 2 wins and the round-1 family
 * value is recorded as superseded, not as a mismatch.
 */

const PROJECT_REF = "kevgrhcjxspbxgovpmfl";
const MANAGEMENT_QUERY_URL =
  `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;
const USER_AGENT = "SecureWorks-SES-AB-Certificate-Checker/1.0";
const IN_CHUNK = 100;

const FAMILY_COLUMN = "jobs.metadata.makesafe_job_family";
const REPORT_TYPE_COLUMN = "makesafe_job_details.report_type";
const COMPANY_SLUG_COLUMN = "makesafe_job_details.requesting_company_slug";
const KNOWN_COLUMNS = new Set([
  FAMILY_COLUMN,
  REPORT_TYPE_COLUMN,
  COMPANY_SLUG_COLUMN,
]);

const WRITE_VERBS = [
  "insert",
  "update",
  "delete",
  "drop",
  "alter",
  "create",
  "truncate",
  "grant",
  "revoke",
  "comment",
  "vacuum",
  "refresh",
  "call",
  "do",
  "copy",
  "merge",
  "set",
];

/** Client-identifying columns this checker must never read. */
const PII_COLUMNS = [
  "client_name",
  "client_phone",
  "client_email",
  "site_address",
  "from_email",
  "from_name",
  "to_recipients",
  "body_content",
  "body_preview",
  "contact_phone",
  "contact_email",
];

const TERMINAL_JOB_STATUSES = new Set([
  "cancelled",
  "archived",
  "complete",
  "completed",
]);

const DISPOSITIONS = new Set([
  "archived_duplicate_pointer",
  "adjudicated_not_duplicate",
  "captain_excluded",
  "open_hold",
  "captain_hold_live_pair",
]);

/**
 * Dispositions that record an unruled group rather than a settled one, and so
 * must name the decision key the captain will rule under. `open_hold` predates
 * this rule and its rows already carry keys; `captain_hold_live_pair` is the
 * stricter successor for a hold whose members are BOTH still live.
 */
const DISPOSITIONS_REQUIRING_DECISION_KEY = new Set([
  "captain_hold_live_pair",
]);

const ERAS = new Set(["historical", "drain_minted"]);

export type CheckStatus = "PASS" | "FAIL";

export interface CheckResult {
  id: string;
  phase: "phase_a" | "phase_b" | "droid";
  title: string;
  status: CheckStatus;
  expected: unknown;
  observed: unknown;
  detail?: string;
}

export interface FixtureRow {
  card: string;
  column: string;
  before: string | null;
  after: string;
}

export interface ExpectedField {
  card: string;
  column: string;
  expect: string;
  provenance: string;
}

export interface AccountingRow {
  work_order: string;
  era: string;
  disposition: string;
  cards: string[];
  decision_key: string | null;
  evidence: string;
}

export interface MergeGroup {
  work_order: string;
  po: string;
  claim_ref: string;
  cards: string[];
}

/* -------------------------------------------------------------------------- */
/* read-only guards                                                            */
/* -------------------------------------------------------------------------- */

/** Strips SQL comments so a write verb cannot hide behind one. */
export function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ");
}

export function assertReadOnlySql(sql: string): void {
  const bare = stripSqlComments(sql).trim().toLowerCase();
  if (!bare) throw new Error("refusing an empty statement");
  if (!/^(select|with)\b/.test(bare)) {
    throw new Error(
      `refusing a statement that does not start with SELECT or WITH: ${
        bare.slice(0, 40)
      }`,
    );
  }
  if (bare.includes(";")) {
    throw new Error("refusing a multi-statement query");
  }
  for (const verb of WRITE_VERBS) {
    if (new RegExp(`\\b${verb}\\b`).test(bare)) {
      throw new Error(`refusing a statement naming the write verb ${verb}`);
    }
  }
}

export function assertNoPiiColumns(sql: string): void {
  const bare = stripSqlComments(sql).toLowerCase();
  for (const column of PII_COLUMNS) {
    if (bare.includes(column)) {
      throw new Error(
        `refusing a statement naming the client-identifying column ${column}`,
      );
    }
  }
}

/* -------------------------------------------------------------------------- */
/* fixture parsing                                                             */
/* -------------------------------------------------------------------------- */

function fixtureLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function parseValue(raw: string): string | null {
  return raw === "NULL" ? null : raw;
}

/** Round-1 SAFE fixture: `card | column | current | after | rationale`. */
export function parseRound1Fixture(text: string): FixtureRow[] {
  return fixtureLines(text).map((line, index) => {
    const parts = line.split("|").map((part) => part.trim());
    if (parts.length !== 5) {
      throw new Error(`round-1 fixture line ${index + 1} needs five fields`);
    }
    if (!KNOWN_COLUMNS.has(parts[1])) {
      throw new Error(
        `round-1 fixture line ${index + 1} targets unknown column ${parts[1]}`,
      );
    }
    return {
      card: parts[0],
      column: parts[1],
      before: parseValue(parts[2]),
      after: parts[3],
    };
  });
}

/** Round-2 field fixture: as round 1 plus a trailing source hash field. */
export function parseRound2FieldFixture(text: string): FixtureRow[] {
  return fixtureLines(text).map((line, index) => {
    const parts = line.split("|").map((part) => part.trim());
    if (parts.length !== 6) {
      throw new Error(
        `round-2 field fixture line ${index + 1} needs six fields`,
      );
    }
    if (!KNOWN_COLUMNS.has(parts[1])) {
      throw new Error(
        `round-2 field fixture line ${index + 1} targets unknown column ${
          parts[1]
        }`,
      );
    }
    return {
      card: parts[0],
      column: parts[1],
      before: parseValue(parts[2]),
      after: parts[3],
    };
  });
}

/** Round-2 temp-fence fixture: `card | column | current | after | rationale`. */
export function parseTempFenceFixture(text: string): FixtureRow[] {
  return parseRound1Fixture(text);
}

export function parseAccountingFixture(text: string): AccountingRow[] {
  return fixtureLines(text).map((line, index) => {
    const parts = line.split("|").map((part) => part.trim());
    if (parts.length !== 6) {
      throw new Error(`accounting fixture line ${index + 1} needs six fields`);
    }
    const [workOrder, era, disposition, cards, decisionKey, evidence] = parts;
    if (!ERAS.has(era)) {
      throw new Error(
        `accounting fixture line ${index + 1} has unknown era ${era}`,
      );
    }
    if (!DISPOSITIONS.has(disposition)) {
      throw new Error(
        `accounting fixture line ${
          index + 1
        } has unknown disposition ${disposition}`,
      );
    }
    const members = cards.split(",").map((card) => card.trim()).filter(Boolean);
    if (members.length < 2) {
      throw new Error(
        `accounting fixture line ${index + 1} needs at least two cards`,
      );
    }
    if (!evidence) {
      throw new Error(`accounting fixture line ${index + 1} needs evidence`);
    }
    if (
      DISPOSITIONS_REQUIRING_DECISION_KEY.has(disposition) &&
      decisionKey === "-"
    ) {
      throw new Error(
        `accounting fixture line ${
          index + 1
        } has disposition ${disposition} and must name a decision key`,
      );
    }
    return {
      work_order: workOrder,
      era,
      disposition,
      cards: members,
      decision_key: decisionKey === "-" ? null : decisionKey,
      evidence,
    };
  });
}

/* -------------------------------------------------------------------------- */
/* the phase A census invariants                                               */
/* -------------------------------------------------------------------------- */

export interface KeyCensus {
  total: number;
  live_job: number;
  exception_only: number;
  synthetic: number;
  unaccounted: number;
}

export interface CensusInvariants {
  unaccounted: number;
  partition_complete: boolean;
  keys_lost: number;
  live_job_regression: number;
  synthetic: number;
  missing_certified_keys: string[];
  synthetic_identity_drift: string[];
  live_job_regression_keys: string[];
}

export interface CertifiedIdentity {
  key: string;
  bucket: "live_job" | "exception_only" | "synthetic";
}

/**
 * The certified census is a FLOOR plus a partition rule, never an expected
 * observation: intake keeps minting keys and keeps promoting exception cases to
 * live jobs, so equality fails on healthy growth. These are the properties that
 * actually have to hold, and each one is a real defect when it breaks:
 *
 * - `unaccounted` / `partition_complete`: a key that is in no bucket, or
 *   buckets that do not sum to the total, means the census is not a partition
 *   and every other count is unsafe to read.
 * - `keys_lost`: identity keys are append-only. A total below the floor means
 *   keys were destroyed, not that intake was quiet.
 * - `live_job_regression`: promotion runs exception -> live only. A live-job
 *   count below the floor means a live job was un-bound from its key.
 * - `synthetic`: live-fire is a closed, release-blocked set; drift there is
 *   residue that must be noticed rather than absorbed as growth.
 */
export function evaluateCensusInvariants(
  floor: { total: number; live_job: number; synthetic: number },
  observed: KeyCensus,
  certifiedIdentities: CertifiedIdentity[] = [],
  observedIdentities: CertifiedIdentity[] = [],
): CensusInvariants {
  const current = new Map(observedIdentities.map((identity) => [identity.key, identity.bucket]));
  const certified = new Map(certifiedIdentities.map((identity) => [identity.key, identity.bucket]));
  const missing = [...certified.keys()].filter((key) => !current.has(key));
  const syntheticDrift = [...new Set([
    ...certifiedIdentities.filter((identity) => identity.bucket === "synthetic" && current.get(identity.key) !== "synthetic").map((identity) => identity.key),
    ...observedIdentities.filter((identity) => identity.bucket === "synthetic" && certified.get(identity.key) !== "synthetic").map((identity) => identity.key),
  ])].sort();
  const liveRegression = certifiedIdentities
    .filter((identity) => identity.bucket === "live_job" && current.get(identity.key) !== "live_job")
    .map((identity) => identity.key)
    .sort();
  return {
    unaccounted: observed.unaccounted,
    partition_complete:
      observed.live_job + observed.exception_only + observed.synthetic ===
        observed.total,
    keys_lost: Math.max(0, floor.total - observed.total),
    live_job_regression: Math.max(0, floor.live_job - observed.live_job),
    synthetic: observed.synthetic,
    missing_certified_keys: missing.sort(),
    synthetic_identity_drift: syntheticDrift,
    live_job_regression_keys: liveRegression,
  };
}

/* -------------------------------------------------------------------------- */
/* the phase B advance model                                                   */
/* -------------------------------------------------------------------------- */

export interface AdvanceInput {
  round1: FixtureRow[];
  round2Field: FixtureRow[];
  round2TempFence: FixtureRow[];
  backfills: {
    card: string;
    column: string;
    after: string;
    provenance: string;
  }[];
  holds: { card: string; column: string; held_value: string }[];
}

export interface AdvanceResult {
  expected: ExpectedField[];
  /**
   * Round-1 family targets that round 2's production decider overrode. The
   * FAMILY TRUTH RULE records these as superseded, never as a mismatch.
   */
  superseded_family_cards: string[];
}

/**
 * Folds the adjudicated verdict table forward through every applied ledger, in
 * the order production applied them, and returns the end state each card must
 * hold today.
 */
export function advanceVerdictTable(input: AdvanceInput): AdvanceResult {
  const expected = new Map<string, ExpectedField>();
  const key = (card: string, column: string) => `${card}\u0000${column}`;
  const put = (
    card: string,
    column: string,
    expect: string,
    provenance: string,
  ) => expected.set(key(card, column), { card, column, expect, provenance });

  for (const row of input.round1) {
    put(row.card, row.column, row.after, "round1");
  }
  for (const row of input.round2Field) {
    put(row.card, row.column, row.after, "round2-field");
  }

  const superseded: string[] = [];
  const round1Family = new Set(
    input.round1.filter((row) => row.column === FAMILY_COLUMN).map((r) =>
      r.card
    ),
  );
  for (const row of input.round2TempFence) {
    if (row.column === FAMILY_COLUMN && round1Family.has(row.card)) {
      superseded.push(row.card);
    }
    put(row.card, row.column, row.after, "round2-temp-fence");
  }

  for (const row of input.backfills) {
    put(row.card, row.column, row.after, row.provenance);
  }
  // Holds land last: a held card keeps the value production actually carries.
  for (const hold of input.holds) {
    put(hold.card, hold.column, hold.held_value, "captain-hold");
  }

  return {
    expected: [...expected.values()].sort((a, b) =>
      a.card === b.card
        ? a.column.localeCompare(b.column)
        : a.card.localeCompare(b.card)
    ),
    superseded_family_cards: superseded.sort(),
  };
}

/**
 * Groups the derived work-order rows into merge groups: one entry per work
 * order that resolves to more than one card.
 */
export function buildMergeGroups(
  rows: { job_number: string; claim_ref: string; po: string }[],
): MergeGroup[] {
  const byWorkOrder = new Map<string, MergeGroup>();
  for (const row of rows) {
    if (!row.po || !row.claim_ref) continue;
    const workOrder = `${row.claim_ref}PO-${row.po}`;
    const group = byWorkOrder.get(workOrder) ?? {
      work_order: workOrder,
      po: row.po,
      claim_ref: row.claim_ref,
      cards: [],
    };
    if (!group.cards.includes(row.job_number)) group.cards.push(row.job_number);
    byWorkOrder.set(workOrder, group);
  }
  return [...byWorkOrder.values()]
    .filter((group) => group.cards.length > 1)
    .map((group) => ({ ...group, cards: group.cards.slice().sort() }))
    .sort((a, b) => a.work_order.localeCompare(b.work_order));
}

/* -------------------------------------------------------------------------- */
/* production reads                                                            */
/* -------------------------------------------------------------------------- */

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  assertReadOnlySql(sql);
  assertNoPiiColumns(sql);
  const response = await fetch(MANAGEMENT_QUERY_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requiredEnv("SUPABASE_ACCESS_TOKEN")}`,
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({ query: sql, read_only: true }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(payload)) {
    const message =
      payload && typeof payload === "object" && "message" in payload
        ? String((payload as { message: unknown }).message)
        : `HTTP ${response.status}`;
    throw new Error(`read-only query failed: ${message}`);
  }
  return payload as T[];
}

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function chunk<T>(values: readonly T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    out.push(values.slice(index, index + size));
  }
  return out;
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/* -------------------------------------------------------------------------- */
/* checks                                                                      */
/* -------------------------------------------------------------------------- */

function check(
  id: string,
  phase: CheckResult["phase"],
  title: string,
  expected: unknown,
  observed: unknown,
  detail?: string,
): CheckResult {
  const status: CheckStatus =
    JSON.stringify(expected) === JSON.stringify(observed) ? "PASS" : "FAIL";
  return { id, phase, title, status, expected, observed, detail };
}

interface Baseline {
  phase_a: Record<string, any>;
  phase_b: Record<string, any>;
  droid_cross_check: Record<string, any>;
}

async function runPhaseA(baseline: Baseline): Promise<CheckResult[]> {
  const expected = baseline.phase_a;
  const results: CheckResult[] = [];

  const [census] = await query<Record<string, number>>(
    `select
       (select count(*) from emails)::int as emails,
       (select count(*) from makesafe_intake_case_sources)::int as case_source_rows,
       (select count(distinct post_id) from makesafe_intake_case_sources)::int as distinct_source_post_ids,
       (select count(*) from emails e where not exists (
          select 1 from makesafe_intake_case_sources s where s.post_id = e.post_id
        ))::int as emails_without_case_source`,
  );
  results.push(check(
    "a1_sources_equal_case_rows",
    "phase_a",
    "every physical SES source has exactly one canonical case-source row",
    {
      emails: expected.emails,
      case_source_rows: expected.case_source_rows,
      distinct_source_post_ids: expected.distinct_source_post_ids,
    },
    {
      emails: census.emails,
      case_source_rows: census.case_source_rows,
      distinct_source_post_ids: census.distinct_source_post_ids,
    },
    "emails == case_source_rows == distinct post ids",
  ));
  results.push(check(
    "a2_emails_without_case",
    "phase_a",
    "no persisted SES email lacks a case-source row",
    expected.emails_without_case_source,
    census.emails_without_case_source,
  ));

  const [keys] = await query<Record<string, number>>(
    `with k as (
       select wo_po_identity_key as key,
         count(*) filter (where state = 'confirmed_live_job') as live,
         count(*) filter (where state = 'exception') as exc,
         count(*) filter (where state = 'synthetic_livefire_terminal') as syn
       from makesafe_intake_cases
       where wo_po_identity_key is not null
       group by 1
     )
     select count(*)::int as total,
       count(*) filter (where live > 0)::int as live_job,
       count(*) filter (where live = 0 and syn = 0 and exc > 0)::int as exception_only,
       count(*) filter (where syn > 0)::int as synthetic,
       count(*) filter (where live = 0 and syn = 0 and exc = 0)::int as unaccounted,
       count(*) filter (where live > 1)::int as two_live
     from k`,
  );
  const certifiedIdentities = (expected.certified_identity_keys ?? []) as CertifiedIdentity[];
  const [observedIdentityRows, observedLiveCases] = await Promise.all([
    query<CertifiedIdentity>(`select wo_po_identity_key as key,
      case when count(*) filter (where state = 'synthetic_livefire_terminal') > 0 then 'synthetic'
           when count(*) filter (where state = 'confirmed_live_job') > 0 then 'live_job'
           else 'exception_only' end as bucket
      from makesafe_intake_cases where wo_po_identity_key is not null group by wo_po_identity_key`),
    query<{ id: string; state: string; job_id: string | null }>(
      `select id, state, job_id from makesafe_intake_cases where state = 'confirmed_live_job'`,
    ),
  ]);
  // The certified census numbers are a FLOOR and a partition rule, not an
  // expected observation. Ordinary intake keeps minting keys and keeps
  // promoting exception cases to live jobs, so pinning the exact counts made
  // the certificate fail on healthy growth (the 2026-08-01 +3 live-job drift).
  // What actually has to hold is structural: every key lands in exactly one
  // bucket, no key is destroyed, and promotion only ever runs exception ->
  // live. Growth above the floor is reported, never failed.
  const invariants = evaluateCensusInvariants({
    total: expected.identity_keys_total,
    live_job: expected.identity_keys_live_job,
    synthetic: expected.identity_keys_synthetic,
  }, {
    total: keys.total,
    live_job: keys.live_job,
    exception_only: keys.exception_only,
    synthetic: keys.synthetic,
    unaccounted: keys.unaccounted,
  }, certifiedIdentities, observedIdentityRows);
  const totalGrowth = keys.total - expected.identity_keys_total;
  const liveJobGrowth = keys.live_job - expected.identity_keys_live_job;
  results.push(check(
    "a3_identity_key_census",
    "phase_a",
    "identity keys are fully accounted as live-job / exception-only / synthetic",
    {
      unaccounted: 0,
      partition_complete: true,
      keys_lost: 0,
      live_job_regression: 0,
      synthetic: expected.identity_keys_synthetic,
      missing_certified_keys: [],
      synthetic_identity_drift: [],
      live_job_regression_keys: [],
    },
    invariants,
    `census invariant, not a pinned count: certified floor ${expected.identity_keys_total} total / ` +
      `${expected.identity_keys_live_job} live-job / ${expected.identity_keys_exception_only} exception-only / ` +
      `${expected.identity_keys_synthetic} synthetic; live now ` +
      `${keys.total} total (${totalGrowth >= 0 ? "+" : ""}${totalGrowth}) / ` +
      `${keys.live_job} live-job (${
        liveJobGrowth >= 0 ? "+" : ""
      }${liveJobGrowth}) / ` +
      `${keys.exception_only} exception-only / ${keys.synthetic} synthetic. ` +
      `${expected.identity_key_census_rule} ` +
      `The brief's pre-recovery census was ${expected.brief_pre_recovery_census.identity_keys_total} total / ` +
      `${expected.brief_pre_recovery_census.identity_keys_live_job} live-job; ` +
      expected.brief_pre_recovery_census.reconciliation,
  ));
  results.push(check(
    "a6_keys_with_two_live_jobs",
    "phase_a",
    "no identity key carries two live case-bound jobs",
    expected.identity_keys_with_two_live_case_bound_jobs,
    keys.two_live,
  ));

  const [integrity] = await query<Record<string, number>>(
    `select
       (select count(*) from makesafe_intake_cases
          where state = 'confirmed_live_job' and job_id is null)::int as live_case_without_job,
       (select count(*) from makesafe_intake_cases c
          where c.job_id is not null
            and not exists (select 1 from jobs j where j.id = c.job_id))::int as dangling_case_job,
       (select count(*) from makesafe_intake_cases c
          where c.target_job_id is not null
            and not exists (select 1 from jobs j where j.id = c.target_job_id))::int as dangling_target_job,
       (select count(*) from makesafe_source_job_links l
          where not exists (select 1 from jobs j where j.id = l.job_id))::int as dangling_link_job,
       (select count(*) from makesafe_intake_cases where state = 'confirmed_live_job')::int as live_cases`,
  );
  const certifiedLiveCases = (expected.certified_live_case_ids ?? []) as string[];
  const observedLiveCaseIds = new Set(observedLiveCases.map((row) => row.id));
  const missingLiveCases = certifiedLiveCases.filter((id) => !observedLiveCaseIds.has(id)).sort();
  const certifiedLiveCasesWithoutJob = observedLiveCases
    .filter((row) => certifiedLiveCases.includes(row.id) && row.job_id === null)
    .map((row) => row.id)
    .sort();
  results.push(check(
    "a4_live_case_without_job",
    "phase_a",
    "no confirmed_live_job case is missing its job",
    {
      live_case_without_job: expected.live_case_without_job,
      missing_certified_live_cases: [],
      certified_live_cases_without_job: [],
    },
    {
      live_case_without_job: integrity.live_case_without_job,
      missing_certified_live_cases: missingLiveCases,
      certified_live_cases_without_job: certifiedLiveCasesWithoutJob,
    },
    `certified identity set ${certifiedLiveCases.length} live cases; live now ${integrity.live_cases} ` +
      `(${integrity.live_cases - expected.live_cases >= 0 ? "+" : ""}${
        integrity.live_cases - expected.live_cases
      } post-baseline intake growth).`,
  ));
  results.push(check(
    "a5_dangling_job_ids",
    "phase_a",
    "no case, correction target or source link points at a missing job",
    {
      case_job: expected.dangling_job_ids,
      target_job: expected.dangling_job_ids,
      link_job: expected.dangling_job_ids,
    },
    {
      case_job: integrity.dangling_case_job,
      target_job: integrity.dangling_target_job,
      link_job: integrity.dangling_link_job,
    },
  ));

  const [roof, historical] = expected.captain_ruled_creations as Record<
    string,
    any
  >[];
  const [roofRow] = await query<Record<string, unknown>>(
    `select j.job_number,
       j.metadata->>'makesafe_job_family' as family,
       d.external_ref, d.requesting_company_slug,
       c.state as case_state, c.wo_po_identity_key as identity_key,
       (select count(*) from makesafe_intake_case_sources s where s.case_id = c.id)::int as case_sources,
       (select count(*) from job_documents doc where doc.job_id = j.id and doc.type = 'work_order')::int as work_orders
     from jobs j
     left join makesafe_job_details d on d.job_id = j.id
     left join makesafe_intake_cases c on c.job_id = j.id
     where j.job_number = ${sqlLiteral(roof.job_number)}`,
  );
  results.push(check(
    "a7_captain_creation_roof_report",
    "phase_a",
    `${roof.job_number} exists as a roof_report card with lineage to ${roof.external_ref}`,
    {
      family: roof.family,
      external_ref: roof.external_ref,
      requesting_company_slug: roof.requesting_company_slug,
      case_state: roof.case_state,
      identity_key: roof.identity_key,
      case_sources_at_least: true,
      work_orders_at_least: true,
    },
    {
      family: roofRow?.family ?? null,
      external_ref: roofRow?.external_ref ?? null,
      requesting_company_slug: roofRow?.requesting_company_slug ?? null,
      case_state: roofRow?.case_state ?? null,
      identity_key: roofRow?.identity_key ?? null,
      case_sources_at_least:
        Number(roofRow?.case_sources ?? 0) >= Number(roof.min_case_sources),
      work_orders_at_least: Number(roofRow?.work_orders ?? 0) >=
        Number(roof.min_work_order_documents),
    },
  ));

  const [historicalRow] = await query<Record<string, unknown>>(
    `select j.job_number,
       j.metadata->>'makesafe_job_family' as family,
       d.external_ref, d.requesting_company_slug,
       (select after_status from makesafe_board_status_current c where c.job_id = j.id) as display_after_status,
       (select count(*) from makesafe_intake_source_authority_corrections k where k.target_job_id = j.id)::int as corrections,
       (select count(*) from xero_invoices x
          where x.job_id = j.id
            and x.invoice_number = ${sqlLiteral(historical.invoice_number)}
            and x.status = ${sqlLiteral(historical.invoice_status)}
            and x.invoice_type = ${
      sqlLiteral(historical.invoice_type)
    })::int as invoices
     from jobs j
     left join makesafe_job_details d on d.job_id = j.id
     where j.job_number = ${sqlLiteral(historical.job_number)}`,
  );
  results.push(check(
    "a8_captain_creation_historical_backfill",
    "phase_a",
    `${historical.job_number} exists, displays archive and carries ${historical.invoice_number}`,
    {
      family: historical.family,
      external_ref: historical.external_ref,
      requesting_company_slug: historical.requesting_company_slug,
      display_after_status: historical.display_after_status,
      invoice_rows: 1,
      corrections_at_least: true,
    },
    {
      family: historicalRow?.family ?? null,
      external_ref: historicalRow?.external_ref ?? null,
      requesting_company_slug: historicalRow?.requesting_company_slug ?? null,
      display_after_status: historicalRow?.display_after_status ?? null,
      invoice_rows: Number(historicalRow?.invoices ?? 0),
      corrections_at_least: Number(historicalRow?.corrections ?? 0) >=
        Number(historical.min_authority_corrections),
    },
  ));

  return results;
}

interface LedgerBundle {
  round1: any;
  round2: any;
  backfill: any;
}

async function runPhaseB(
  baseline: Baseline,
  root: URL,
  ledgers: LedgerBundle,
): Promise<{ results: CheckResult[]; advance: AdvanceResult }> {
  const expected = baseline.phase_b;
  const results: CheckResult[] = [];

  const readText = (relative: string) =>
    Deno.readTextFile(new URL(relative, root));

  const round1Text = await readText("./board-safe-fixes-v1.fixture.txt");
  const round1Hash = await sha256(round1Text);
  results.push(check(
    "b1_round1_fixture_integrity",
    "phase_b",
    "the committed round-1 fixture still hashes to the value its apply ledger recorded",
    {
      fixture_sha256: ledgers.round1.fixture_sha256,
      applied: expected.round1_applied,
      skipped: expected.round1_skipped,
    },
    {
      fixture_sha256: round1Hash,
      applied: ledgers.round1.summary?.applied_total,
      skipped: ledgers.round1.summary?.skipped,
    },
  ));

  // The round-2 ledger hashes a six-file concatenation whose first member is the
  // source-job-link migration. The committed migration ends one newline shorter
  // than the text hashed at apply time (repo formatting landed after the run),
  // so both variants are tried and the matching one is reported.
  const round2Inputs = [
    "../supabase/migrations/20260801000001_makesafe_source_job_links.sql",
    "./board-fixes-round2-field.fixture.txt",
    "./board-fixes-round2-temp-fence.fixture.txt",
    "./board-fixes-round2-links.fixture.txt",
    "./board-fixes-round2-link-sources.fixture.txt",
    "./board-fixes-round2-population.fixture.txt",
  ];
  const round2Texts: string[] = [];
  for (const relative of round2Inputs) {
    round2Texts.push(await readText(relative));
  }
  const asCommitted = await sha256(round2Texts.join("\n"));
  const withMigrationNewline = await sha256(
    [round2Texts[0] + "\n", ...round2Texts.slice(1)].join("\n"),
  );
  const round2Match = asCommitted === ledgers.round2.fixture_sha256
    ? "as_committed"
    : withMigrationNewline === ledgers.round2.fixture_sha256
    ? "migration_trailing_newline"
    : "none";
  results.push(check(
    "b2_round2_fixture_integrity",
    "phase_b",
    "the committed round-2 fixture set still hashes to the value its apply ledger recorded",
    {
      matched: true,
      field_applied: expected.round2_field_applied,
      field_skipped: expected.round2_field_skipped,
      temp_fence_applied: expected.round2_temp_fence_applied,
      temp_fence_skipped: expected.round2_temp_fence_skipped,
      link_applied: expected.round2_link_applied,
      link_skipped: expected.round2_link_skipped,
    },
    {
      matched: round2Match !== "none",
      field_applied: ledgers.round2.summary?.field_fixes?.applied,
      field_skipped: ledgers.round2.summary?.field_fixes?.skipped,
      temp_fence_applied: ledgers.round2.summary?.temp_fence_relabels?.applied,
      temp_fence_skipped: ledgers.round2.summary?.temp_fence_relabels?.skipped,
      link_applied: ledgers.round2.summary?.link_backfill?.applied,
      link_skipped: ledgers.round2.summary?.link_backfill?.skipped,
    },
    `hash variant matched: ${round2Match}`,
  ));

  const round1Rows = parseRound1Fixture(round1Text);
  const round2FieldRows = parseRound2FieldFixture(round2Texts[1]);
  const tempFenceRows = parseTempFenceFixture(round2Texts[2]);
  const holds = (expected.documented_holds as Record<string, string>[]).map(
    (hold) => ({
      card: hold.card,
      column: hold.column,
      held_value: hold.held_value,
    }),
  );
  const advance = advanceVerdictTable({
    round1: round1Rows,
    round2Field: round2FieldRows,
    round2TempFence: tempFenceRows,
    backfills: [{
      card: ledgers.backfill.target,
      column: ledgers.backfill.evaluation.column,
      after: ledgers.backfill.evaluation.after,
      provenance: "swms-26692-backfill",
    }],
    holds,
  });

  results.push(check(
    "b3_family_supersession",
    "phase_b",
    "round 2's production decider superseded the round-1 family axis on exactly the recorded cards",
    expected.family_supersession_card_count,
    advance.superseded_family_cards.length,
    "FAMILY TRUTH RULE: the production decider on full post-drain inputs is authoritative; " +
      "the superseded round-1 family values are recorded, not counted as mismatches.",
  ));

  const cards = [...new Set(advance.expected.map((row) => row.card))].sort();
  const live = new Map<string, Record<string, unknown>>();
  for (const batch of chunk(cards)) {
    const rows = await query<Record<string, unknown>>(
      `select j.job_number,
         j.metadata->>'makesafe_job_family' as family,
         d.report_type, d.requesting_company_slug
       from jobs j
       left join makesafe_job_details d on d.job_id = j.id
       where j.job_number in (${batch.map(sqlLiteral).join(",")})`,
    );
    for (const row of rows) live.set(String(row.job_number), row);
  }
  const columnKey: Record<string, string> = {
    [FAMILY_COLUMN]: "family",
    [REPORT_TYPE_COLUMN]: "report_type",
    [COMPANY_SLUG_COLUMN]: "requesting_company_slug",
  };
  const mismatches = advance.expected.filter((row) => {
    const observed = live.get(row.card);
    if (!observed) return true;
    return observed[columnKey[row.column]] !== row.expect;
  }).map((row) => ({
    card: row.card,
    column: row.column,
    expected: row.expect,
    observed: live.get(row.card)?.[columnKey[row.column]] ?? "CARD_MISSING",
    provenance: row.provenance,
  }));
  results.push(check(
    "b4_board_field_diff",
    "phase_b",
    "the live board matches the adjudicated verdict table advanced by the applied ledgers",
    { assertions: expected.expected_field_assertions, mismatches: 0 },
    { assertions: advance.expected.length, mismatches: mismatches.length },
    mismatches.length ? JSON.stringify(mismatches.slice(0, 10)) : undefined,
  ));

  const heldCards = holds.map((hold) => hold.card);
  const heldObserved = heldCards.map((card) => ({
    card,
    family: live.get(card)?.family ?? null,
  }));
  results.push(check(
    "b5_documented_holds_untouched",
    "phase_b",
    "every documented captain hold still carries its held value",
    holds.map((hold) => ({ card: hold.card, family: hold.held_value })),
    heldObserved,
  ));

  const linkWrites = ledgers.round2.link_backfill.writes as Record<
    string,
    string
  >[];
  let presentLinks = 0;
  for (const batch of chunk(linkWrites)) {
    const values = batch
      .map((row) =>
        `(${sqlLiteral(row.source_post_id)},${sqlLiteral(row.target_job_id)})`
      )
      .join(",");
    const [row] = await query<Record<string, number>>(
      `with want(post_id, job_id) as (values ${values})
       select count(*) filter (where exists (
         select 1 from makesafe_source_job_links l
         where l.source_post_id = w.post_id and l.job_id = w.job_id::uuid
       ))::int as present
       from want w`,
    );
    presentLinks += Number(row.present);
  }
  const [linkTotals] = await query<Record<string, number>>(
    `select count(*)::int as rows from makesafe_source_job_links`,
  );
  results.push(check(
    "b6_source_job_links",
    "phase_b",
    "every applied source-to-job link is live and no link exists beyond the ledger",
    {
      ledger_writes: expected.round2_link_applied,
      present: expected.round2_link_applied,
      table_rows: expected.source_job_link_rows,
    },
    {
      ledger_writes: linkWrites.length,
      present: presentLinks,
      table_rows: Number(linkTotals.rows),
    },
    `documented skips: ${
      JSON.stringify(expected.documented_link_skip_reasons)
    }`,
  ));

  const populationRows = ledgers.round2.board_population.rows as Record<
    string,
    string
  >[];
  const populationObserved = await query<Record<string, unknown>>(
    `select j.job_number, d.external_ref, (d.job_id is not null) as has_detail
     from jobs j
     left join makesafe_job_details d on d.job_id = j.id
     where j.job_number in (${
      populationRows.map((row) => sqlLiteral(row.job_number)).join(",")
    })
     order by j.job_number`,
  );
  results.push(check(
    "b7_board_population",
    "phase_b",
    "every adjudicated stray carries the make-safe detail row that puts it on the board",
    populationRows
      .map((row) => ({
        job_number: row.job_number,
        external_ref: row.expected_external_ref,
        has_detail: true,
      }))
      .sort((a, b) => a.job_number.localeCompare(b.job_number)),
    populationObserved.map((row) => ({
      job_number: String(row.job_number),
      external_ref: row.external_ref,
      has_detail: row.has_detail,
    })),
  ));

  const pointerExpected = (expected.duplicate_survivor_pointers as Record<
    string,
    string
  >[]).slice().sort((a, b) => a.loser.localeCompare(b.loser));
  const pointerRows = await query<Record<string, unknown>>(
    `select c.job_number as loser, c.duplicate_of_job_number as survivor, c.run_key
     from makesafe_board_status_current c
     where c.duplicate_of_job_id is not null
     order by c.job_number`,
  );
  results.push(check(
    "b8_duplicate_survivor_pointers",
    "phase_b",
    "the applied duplicate-survivor archives are exactly the adjudicated set",
    pointerExpected,
    pointerRows.map((row) => ({
      loser: String(row.loser),
      survivor: String(row.survivor),
      run_key: String(row.run_key),
    })),
  ));

  // Captain rule (2026-08-01 live board review): no card may carry a blank or
  // absent work-order identity. A card with no makesafe_job_details row has no
  // identity at all, which is the same defect in a harsher form, so both are
  // counted as offenders rather than only the blank string case.
  const identityOffenders = await query<Record<string, unknown>>(
    `select j.job_number,
       (select count(*) from makesafe_job_details d where d.job_id = j.id)::int as detail_rows
     from jobs j
     where (j.type = 'makesafe'
            or (j.type = 'insurance'
                and j.metadata->>'insurance_job_type' = 'restoration'))
       and j.status <> 'lost'
       and not exists (
         select 1 from ses_synthetic_livefire_runs r
         where r.state = 'terminal' and r.job_ids ? j.id::text
       )
       and not exists (
         select 1 from makesafe_job_details d
         where d.job_id = j.id
           and d.external_ref is not null
           and btrim(d.external_ref) <> ''
       )
     order by j.job_number`,
  );
  const [populationRow] = await query<Record<string, number>>(
    `select count(*)::int as population
     from jobs j
     where (j.type = 'makesafe'
            or (j.type = 'insurance'
                and j.metadata->>'insurance_job_type' = 'restoration'))
       and j.status <> 'lost'
       and not exists (
         select 1 from ses_synthetic_livefire_runs r
         where r.state = 'terminal' and r.job_ids ? j.id::text
       )`,
  );
  // Each exception is named and keyed to a captain decision. It excuses exactly
  // one card, and it cannot outlive the defect it covers: an exception whose
  // card has since gained an identity is reported stale and fails the run, so
  // the entry has to be removed once that card is backfilled.
  const exceptions =
    (expected.card_work_order_identity_exceptions ?? []) as Record<
      string,
      string
    >[];
  const exceptedCards = new Set(exceptions.map((row) => row.card));
  const offenderNames = identityOffenders.map((row) => String(row.job_number));
  const unexcepted = offenderNames.filter((name) => !exceptedCards.has(name));
  const staleExceptions = [...exceptedCards].filter((card) =>
    !offenderNames.includes(card)
  );
  results.push(check(
    "b10_card_work_order_identity",
    "phase_b",
    "no card carries a blank or absent work-order identity, outside named legacy exceptions",
    {
      board_population: expected.board_population,
      unexcepted_offenders: expected.cards_without_work_order_identity,
      named_exceptions: exceptions.length,
      stale_exceptions: 0,
    },
    {
      board_population: Number(populationRow.population),
      unexcepted_offenders: unexcepted.length,
      named_exceptions: exceptions.length,
      stale_exceptions: staleExceptions.length,
    },
    [
      unexcepted.length
        ? `unexcepted offending cards: ${
          JSON.stringify(
            identityOffenders
              .filter((row) => unexcepted.includes(String(row.job_number)))
              .map((row) => ({
                job_number: String(row.job_number),
                makesafe_job_details_rows: Number(row.detail_rows),
              })),
          )
        }`
        : null,
      staleExceptions.length
        ? `named exceptions that no longer offend, remove them: ${
          JSON.stringify(staleExceptions)
        }`
        : null,
      exceptions.length
        ? `named legacy exceptions: ${
          exceptions.map((row) => `${row.card} (${row.decision_key})`).join(
            ", ",
          )
        }`
        : null,
    ].filter(Boolean).join("; ") || undefined,
  ));

  const survivors = pointerExpected.map((row) => row.survivor);
  const survivorRows = await query<Record<string, unknown>>(
    `select j.job_number, j.status,
       (select count(*) from makesafe_board_status_current c
          where c.job_id = j.id and c.duplicate_of_job_id is not null)::int as pointers
     from jobs j
     where j.job_number in (${survivors.map(sqlLiteral).join(",")})
     order by j.job_number`,
  );
  results.push(check(
    "b9_survivors_not_stranded",
    "phase_b",
    "no survivor is itself terminal or itself an archived duplicate",
    survivors.slice().sort().map((survivor) => ({
      job_number: survivor,
      terminal: false,
      pointers: 0,
    })),
    survivorRows.map((row) => ({
      job_number: String(row.job_number),
      terminal: TERMINAL_JOB_STATUSES.has(String(row.status)),
      pointers: Number(row.pointers),
    })),
  ));

  return { results, advance };
}

async function runDroid(
  baseline: Baseline,
  root: URL,
): Promise<CheckResult[]> {
  const expected = baseline.droid_cross_check;
  const results: CheckResult[] = [];
  const accounting = parseAccountingFixture(
    await Deno.readTextFile(
      new URL("./ses-ab-certificate-v1.duplicate-accounting.txt", root),
    ),
  );

  // The identity anchor is the production grammar: underscores in the work-order
  // filename are normalised to spaces before the claim/PO tokens are read.
  const woRows = await query<Record<string, string>>(
    `with wo as (
       select j.job_number,
         (regexp_match(replace(coalesce(d.file_name, ''), '_', ' '),
            '(MLB|BWCWA|AJBR|WB|MS)[ -]?([0-9]{3,6})[ -]?PO[ -]?([0-9]{4,6})')) as m
       from job_documents d
       join jobs j on j.id = d.job_id
       where d.type = 'work_order'
     )
     select job_number, m[1] || '-' || m[2] as claim_ref, m[3] as po
     from wo where m is not null`,
  );
  const groups = buildMergeGroups(
    woRows.map((row) => ({
      job_number: String(row.job_number),
      claim_ref: String(row.claim_ref),
      po: String(row.po),
    })),
  );

  const accountingByWorkOrder = new Map(
    accounting.map((row) => [row.work_order, row]),
  );
  const unaccounted = groups
    .filter((group) => !accountingByWorkOrder.has(group.work_order))
    .map((group) => ({ work_order: group.work_order, cards: group.cards }));
  const stale = accounting
    .filter((row) =>
      !groups.some((group) => group.work_order === row.work_order)
    )
    .map((row) => row.work_order);

  results.push(check(
    "d1_merge_list_accounted",
    "droid",
    "every work order production resolves to more than one card is adjudicated",
    {
      groups: expected.merge_groups_total,
      historical: expected.merge_groups_historical,
      drain_minted: expected.merge_groups_drain_minted,
      unaccounted: expected.unaccounted,
      stale_fixture_rows: 0,
    },
    {
      groups: groups.length,
      historical: accounting.filter((row) =>
        row.era === "historical" &&
        groups.some((group) => group.work_order === row.work_order)
      ).length,
      drain_minted: accounting.filter((row) =>
        row.era === "drain_minted" &&
        groups.some((group) => group.work_order === row.work_order)
      ).length,
      unaccounted: unaccounted.length,
      stale_fixture_rows: stale.length,
    },
    unaccounted.length || stale.length
      ? JSON.stringify({ unaccounted, stale })
      : undefined,
  ));

  const membershipDrift = groups
    .filter((group) => {
      const row = accountingByWorkOrder.get(group.work_order);
      if (!row) return false;
      return JSON.stringify(row.cards.slice().sort()) !==
        JSON.stringify(group.cards);
    })
    .map((group) => ({
      work_order: group.work_order,
      fixture: accountingByWorkOrder.get(group.work_order)?.cards ?? [],
      production: group.cards,
    }));
  results.push(check(
    "d2_merge_group_membership",
    "droid",
    "each adjudicated group still has exactly the cards it was adjudicated with",
    0,
    membershipDrift.length,
    membershipDrift.length ? JSON.stringify(membershipDrift) : undefined,
  ));

  const memberCards = [
    ...new Set(accounting.flatMap((row) => row.cards)),
  ].sort();
  const memberRows = await query<Record<string, unknown>>(
    `select j.job_number, j.status, j.created_at,
       c.duplicate_of_job_number, c.after_status
     from jobs j
     left join makesafe_board_status_current c on c.job_id = j.id
     where j.job_number in (${memberCards.map(sqlLiteral).join(",")})`,
  );
  const byCard = new Map(
    memberRows.map((row) => [String(row.job_number), row]),
  );

  const dispositionFailures: unknown[] = [];
  const dispositionCounts: Record<string, number> = {
    archived_duplicate_pointer: 0,
    adjudicated_not_duplicate: 0,
    captain_excluded: 0,
    open_hold: 0,
    captain_hold_live_pair: 0,
  };
  const drainMintedJobs: string[] = [];
  for (const row of accounting) {
    dispositionCounts[row.disposition] += 1;
    const members = row.cards.map((card) => ({
      card,
      row: byCard.get(card),
    }));
    const missing = members.filter((member) => !member.row).map((m) => m.card);
    if (missing.length) {
      dispositionFailures.push({ work_order: row.work_order, missing });
      continue;
    }
    const pointers = members.filter((member) =>
      member.row?.duplicate_of_job_number
    );
    if (row.era === "drain_minted") {
      // The drain-minted duplicate is the group's newest card: it was minted
      // against a work order an older card already held.
      const newest = members
        .slice()
        .sort((a, b) =>
          String(a.row?.created_at).localeCompare(String(b.row?.created_at))
        )
        .at(-1);
      if (newest) drainMintedJobs.push(newest.card);
    }
    if (row.disposition === "archived_duplicate_pointer") {
      const survivorNames = pointers.map((p) =>
        String(p.row?.duplicate_of_job_number)
      );
      if (
        pointers.length !== 1 ||
        !row.cards.includes(survivorNames[0])
      ) {
        dispositionFailures.push({
          work_order: row.work_order,
          disposition: row.disposition,
          reason: "expected exactly one in-group duplicate pointer",
          pointers: survivorNames,
        });
      }
    } else if (pointers.length !== 0) {
      dispositionFailures.push({
        work_order: row.work_order,
        disposition: row.disposition,
        reason:
          "a card was archived as a duplicate under a non-archive disposition",
        pointers: pointers.map((p) => p.card),
      });
    }
    if (row.disposition === "open_hold") {
      const liveMembers = members.filter((member) =>
        !TERMINAL_JOB_STATUSES.has(String(member.row?.status))
      );
      if (liveMembers.length > 1) {
        dispositionFailures.push({
          work_order: row.work_order,
          disposition: row.disposition,
          reason:
            "an unruled hold has more than one live card on one work order",
          live: liveMembers.map((member) => member.card),
        });
      }
    }
    if (row.disposition === "captain_hold_live_pair") {
      // A hold that openly records BOTH members still live. This is the honest
      // state for a group proved to be one instruction whose survivor the
      // standing ruling cannot pick. It is accounted, so the certificate does
      // not fail; but it is not settled, so the checker pins the exact shape it
      // was recorded in. If anyone archives a member, points a duplicate
      // pointer at one, or the pair stops being a live pair, the hold no longer
      // describes production and this fails - forcing re-adjudication rather
      // than letting a stale hold silently absorb a real change.
      const liveMembers = members.filter((member) =>
        !TERMINAL_JOB_STATUSES.has(String(member.row?.status))
      );
      if (liveMembers.length !== members.length) {
        dispositionFailures.push({
          work_order: row.work_order,
          disposition: row.disposition,
          reason:
            "the hold recorded every member as live; one is now terminal, so the pair must be re-adjudicated",
          terminal: members
            .filter((member) =>
              TERMINAL_JOB_STATUSES.has(String(member.row?.status))
            )
            .map((member) => member.card),
        });
      }
      // A duplicate pointer on a hold member is already reported by the shared
      // non-archive-disposition branch above; it is not re-reported here.
    }
    if (row.disposition === "captain_excluded") {
      const notArchived = members.filter((member) =>
        String(member.row?.after_status) !== "archive"
      );
      if (notArchived.length) {
        dispositionFailures.push({
          work_order: row.work_order,
          disposition: row.disposition,
          reason:
            "the exclusion rested on both cards already displaying archive; one no longer does",
          cards: notArchived.map((member) => member.card),
        });
      }
    }
  }
  results.push(check(
    "d3_dispositions_hold",
    "droid",
    "production still matches every adjudicated disposition",
    { failures: 0, counts: expected.disposition_counts },
    { failures: dispositionFailures.length, counts: dispositionCounts },
    dispositionFailures.length
      ? JSON.stringify(dispositionFailures.slice(0, 10))
      : undefined,
  ));

  results.push(check(
    "d4_drain_minted_duplicates",
    "droid",
    "the drain-minted duplicate jobs are exactly the adjudicated set",
    (expected.drain_minted_duplicate_jobs as string[]).slice().sort(),
    drainMintedJobs.slice().sort(),
  ));

  return results;
}

/* -------------------------------------------------------------------------- */
/* CLI                                                                         */
/* -------------------------------------------------------------------------- */

function printHelp(): void {
  console.log(
    `description: Re-prove the SES Phase A/B certificate against live production, read-only
default_mode: run
flags[3]{name,meaning}:
  --output,"write the machine-readable run JSON to this path"
  --baseline,"certified baseline JSON (default scripts/ses-ab-certificate-v1.baseline.json)"
  --help,"show this reference"
environment[1]{name,required_for}:
  SUPABASE_ACCESS_TOKEN,"every run; used only for read_only:true management queries"
exit[2]{code,meaning}:
  0,"every check PASSed"
  1,"at least one check FAILed, or the run could not complete"
examples[2]:
  "scripts/ses-ab-certificate-checker.ts"
  "scripts/ses-ab-certificate-checker.ts --output docs/evidence/ses-ab-certificate-2026-08-01.run.json"`,
  );
}

function option(name: string): string | undefined {
  const withEquals = Deno.args.find((arg) => arg.startsWith(`${name}=`));
  if (withEquals) return withEquals.slice(name.length + 1);
  const index = Deno.args.indexOf(name);
  return index >= 0 ? Deno.args[index + 1] : undefined;
}

export async function run(): Promise<number> {
  if (Deno.args.includes("--help")) {
    printHelp();
    return 0;
  }
  const root = new URL("./", import.meta.url);
  const baselinePath = option("--baseline") ??
    new URL("./ses-ab-certificate-v1.baseline.json", root).pathname;
  const baseline = JSON.parse(
    await Deno.readTextFile(baselinePath),
  ) as Baseline;

  const ledgers: LedgerBundle = {
    round1: JSON.parse(
      await Deno.readTextFile(
        new URL("./board-safe-fixes-v1.apply-ledger.json", root),
      ),
    ),
    round2: JSON.parse(
      await Deno.readTextFile(
        new URL("./board-fixes-round2-v1.apply-ledger.json", root),
      ),
    ),
    backfill: JSON.parse(
      await Deno.readTextFile(
        new URL("./swms-26692-family-backfill-v1.apply-ledger.json", root),
      ),
    ),
  };

  const started = new Date().toISOString();
  const phaseA = await runPhaseA(baseline);
  const { results: phaseB, advance } = await runPhaseB(baseline, root, ledgers);
  const droid = await runDroid(baseline, root);
  const checks = [...phaseA, ...phaseB, ...droid];
  const failed = checks.filter((result) => result.status === "FAIL");

  for (const result of checks) {
    console.log(
      `${result.status.padEnd(4)} ${
        result.phase.padEnd(8)
      } ${result.id}  ${result.title}`,
    );
    console.log(`       expected ${JSON.stringify(result.expected)}`);
    console.log(`       observed ${JSON.stringify(result.observed)}`);
    if (result.detail) console.log(`       note     ${result.detail}`);
  }

  const summary =
    `SES A/B certificate checker: ${
      checks.length - failed.length
    }/${checks.length} PASS` +
    ` (phase A ${
      phaseA.filter((r) => r.status === "PASS").length
    }/${phaseA.length},` +
    ` phase B ${
      phaseB.filter((r) => r.status === "PASS").length
    }/${phaseB.length},` +
    ` droid ${
      droid.filter((r) => r.status === "PASS").length
    }/${droid.length})` +
    ` — ${failed.length === 0 ? "CERTIFIABLE" : "NOT CERTIFIABLE"}`;
  console.log("");
  console.log(summary);

  const outputPath = option("--output");
  if (outputPath) {
    await Deno.writeTextFile(
      outputPath,
      JSON.stringify(
        {
          schema_version: 1,
          tool: "scripts/ses-ab-certificate-checker.ts",
          project_ref: PROJECT_REF,
          access: "management-api /database/query, read_only:true",
          started_at: started,
          finished_at: new Date().toISOString(),
          summary,
          certifiable: failed.length === 0,
          counts: {
            total: checks.length,
            passed: checks.length - failed.length,
            failed: failed.length,
          },
          superseded_family_cards: advance.superseded_family_cards,
          checks,
        },
        null,
        2,
      ) + "\n",
    );
    console.log(`wrote ${outputPath}`);
  }

  return failed.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  Deno.exit(await run());
}
