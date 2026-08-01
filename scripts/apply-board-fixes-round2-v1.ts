#!/usr/bin/env -S deno run --allow-env --allow-net --allow-read --allow-write
// deno-lint-ignore-file no-explicit-any no-import-prefix
/**
 * Applies the adjudicated round-2 MakeSafe board corrections.
 *
 * Safety contract:
 * - dry-run is the default and its Supabase client refuses non-GET requests;
 * - field writes are field-scoped compare-and-set updates;
 * - intake links are append-only source-job connectivity rows;
 * - every link records the adjudication report and exact match key;
 * - temp-fence relabels use the umpire fixture, with SWMS-26894 held out;
 * - re-mint supersession rows remain scope-excluded;
 * - no job is created or re-staged, and no draft, case, assignment, status, or
 *   communication row is written;
 * - verify accounts for every fixture entry and every attempted write.
 */

import {
  classifyMakesafeJobType,
} from "../supabase/functions/ops-api/makesafe_computed_status.ts";
import {
  structuralHash,
} from "../supabase/functions/ops-api/makesafe_intake_five_fates_replay.ts";

const PROJECT_REF = "kevgrhcjxspbxgovpmfl";
const ORG_ID = "00000000-0000-0000-0000-000000000001";
const DEFAULT_SUPABASE_URL = `https://${PROJECT_REF}.supabase.co`;
const PAGE_SIZE = 1000;
const FIELD_FIXTURE = new URL(
  "./board-fixes-round2-field.fixture.txt",
  import.meta.url,
);
const LINK_FIXTURE = new URL(
  "./board-fixes-round2-links.fixture.txt",
  import.meta.url,
);
const LINK_SOURCE_FIXTURE = new URL(
  "./board-fixes-round2-link-sources.fixture.txt",
  import.meta.url,
);
const TEMP_FENCE_FIXTURE = new URL(
  "./board-fixes-round2-temp-fence.fixture.txt",
  import.meta.url,
);
const SOURCE_JOB_LINK_MIGRATION = new URL(
  "../supabase/migrations/20260801000001_makesafe_source_job_links.sql",
  import.meta.url,
);
const POPULATION_FIXTURE = new URL(
  "./board-fixes-round2-population.fixture.txt",
  import.meta.url,
);
const DEFAULT_DRY_RUN = new URL(
  "./board-fixes-round2-v1.dry-run.json",
  import.meta.url,
);
const DEFAULT_LEDGER = new URL(
  "./board-fixes-round2-v1.apply-ledger.json",
  import.meta.url,
);
const DEFAULT_VERIFY = new URL(
  "./board-fixes-round2-v1.verify.json",
  import.meta.url,
);
const LINK_REPORT = "data/ses-shadow-adjudicate-v1/report.md";
const TEMP_FENCE_REPORT = "data/temp-fence-umpire-v1/report.md";
const TEMP_FENCE_HOLD = "SWMS-26894";

export interface FieldFixture {
  card: string;
  column: "jobs.metadata.makesafe_job_family";
  before: string | null;
  after: string;
  rationale: string;
  evidence: string;
}

export interface ExactLinkFixture {
  fixture_class: "exact_reference_existing_job";
  fixture_key: string;
  instruction_hash: string;
  external_ref: string;
  job_number: string;
  match_key: string;
  source_hashes: string[];
  instruction_source_count: number;
}

export interface LinkSourceFixture {
  instruction_hash: string;
  source_hashes: string[];
  first_received_at: string;
  instruction_source_count: number;
}

export interface OrphanLinkFixture {
  fixture_class: "recovered_orphan_source";
  fixture_key: string;
  job_number: string;
  source_hash: string;
  match_key: string;
  diagnosis: string;
}

export type LinkFixture = ExactLinkFixture | OrphanLinkFixture;

interface PopulationFixture {
  job_number: string;
  external_ref: string;
}

interface JobRow {
  id: string;
  job_number: string;
  type: string | null;
  status: string | null;
  metadata: Record<string, unknown> | null;
}

interface DetailRow {
  job_id: string;
  external_ref: string | null;
  report_type: string | null;
  requesting_company_slug: string | null;
}

interface CaseRow {
  id: string;
  instruction_key: string;
  state: string;
  reason_code: string | null;
  job_id: string | null;
  external_ref_canonical: string | null;
  wo_po_identity_key: string | null;
}

interface SourceRow {
  id: string;
  case_id: string;
  post_id: string;
  received_at: string;
}

interface SourceJobLinkRow {
  id: string;
  source_post_id: string;
  job_id: string;
  match_key: string;
}

export interface FieldEvaluation {
  fixture_key: string;
  card: string;
  column: string;
  expected_before: string | null;
  observed_before: string | null;
  after: string;
  job_id: string | null;
  board_kind_before: string | null;
  board_kind_after: string | null;
  eligible: boolean;
  reason: string | null;
}

export interface LinkEvaluation {
  fixture_class: LinkFixture["fixture_class"];
  fixture_key: string;
  source_post_id: string | null;
  target_job_id: string | null;
  target_job_number: string;
  expected_external_ref?: string | null;
  observed_external_ref?: string | null;
  expected_identity_key: string | null;
  match_key: string;
  eligible: boolean;
  already_applied: boolean;
  reason: string | null;
  source_count?: number;
  case_id?: string | null;
}

function pathFromUrl(url: URL): string {
  return decodeURIComponent(url.pathname);
}

function option(name: string): string | null {
  const index = Deno.args.findIndex((arg) =>
    arg === name || arg.startsWith(`${name}=`)
  );
  if (index < 0) return null;
  const arg = Deno.args[index];
  return arg.includes("=")
    ? arg.slice(arg.indexOf("=") + 1)
    : Deno.args[index + 1] || null;
}

function requiredEnv(name: string, fallback?: string): string {
  const value = Deno.env.get(name)?.trim() || fallback;
  if (!value) throw new Error(`${name} is required`);
  return value.replace(/\/+$/, "");
}

function assertProductionUrl(value: string): string {
  const url = new URL(value);
  if (url.origin !== DEFAULT_SUPABASE_URL) {
    throw new Error(
      `SUPABASE_URL must target production project ${PROJECT_REF}`,
    );
  }
  return url.origin;
}

function nonCommentLines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) =>
    line && !line.startsWith("#")
  );
}

export function parseFieldFixture(text: string): FieldFixture[] {
  const rows = nonCommentLines(text).map((line, index) => {
    const parts = line.split("|").map((part) => part.trim());
    if (parts.length !== 6) {
      throw new Error(`field fixture line ${index + 1} must have six fields`);
    }
    const [card, column, rawBefore, after, rationale, evidence] = parts;
    if (column !== "jobs.metadata.makesafe_job_family") {
      throw new Error(`field fixture line ${index + 1} targets ${column}`);
    }
    return {
      card,
      column,
      before: rawBefore === "NULL" ? null : rawBefore,
      after,
      rationale,
      evidence,
    } as FieldFixture;
  });
  if (rows.length !== 11) {
    throw new Error(`field fixture must contain 11 rows, got ${rows.length}`);
  }
  return rows;
}

export function parseTempFenceFixture(text: string): FieldFixture[] {
  const rows = nonCommentLines(text).map((line, index) => {
    const parts = line.split("|").map((part) => part.trim());
    if (parts.length !== 5) {
      throw new Error(
        `temp-fence fixture line ${index + 1} must have five fields`,
      );
    }
    const [card, column, before, after, rationale] = parts;
    if (
      column !== "jobs.metadata.makesafe_job_family" ||
      before !== "general_makesafe" || after !== "temp_fence_makesafe"
    ) {
      throw new Error(
        `temp-fence fixture line ${index + 1} has an unsafe transition`,
      );
    }
    return {
      card,
      column,
      before,
      after,
      rationale,
      evidence: `${TEMP_FENCE_REPORT}#fixture`,
    } as FieldFixture;
  });
  if (rows.length !== 56) {
    throw new Error(
      `temp-fence fixture must contain 56 rows, got ${rows.length}`,
    );
  }
  if (rows.some((row) => row.card === TEMP_FENCE_HOLD)) {
    throw new Error(`${TEMP_FENCE_HOLD} must not appear in the umpire fixture`);
  }
  if (new Set(rows.map((row) => row.card)).size !== rows.length) {
    throw new Error("temp-fence fixture contains duplicate cards");
  }
  return rows;
}

export function parseLinkSourceFixture(text: string): LinkSourceFixture[] {
  const rows = nonCommentLines(text).map((line, index) => {
    const parts = line.split("|").map((part) => part.trim());
    if (parts.length !== 4) {
      throw new Error(`link source line ${index + 1} must have four fields`);
    }
    const [instructionHash, sourceHashesRaw, firstReceivedAt, sourceCountRaw] =
      parts;
    const sourceHashes = sourceHashesRaw.split(",");
    const instructionSourceCount = Number(sourceCountRaw);
    if (
      !/^[0-9a-f]{16}$/.test(instructionHash) ||
      !sourceHashes.length ||
      sourceHashes.some((hash) => !/^[0-9a-f]{16}$/.test(hash)) ||
      !Number.isInteger(instructionSourceCount) || instructionSourceCount < 1 ||
      instructionSourceCount !== sourceHashes.length ||
      Number.isNaN(Date.parse(firstReceivedAt))
    ) {
      throw new Error(`link source line ${index + 1} is malformed`);
    }
    return {
      instruction_hash: instructionHash,
      source_hashes: sourceHashes,
      first_received_at: firstReceivedAt,
      instruction_source_count: instructionSourceCount,
    };
  });
  if (rows.length !== 246) {
    throw new Error(
      `link source fixture must contain 246 rows, got ${rows.length}`,
    );
  }
  if (new Set(rows.map((row) => row.instruction_hash)).size !== rows.length) {
    throw new Error(
      "link source fixture contains duplicate instruction hashes",
    );
  }
  return rows;
}

export function parseLinkFixture(
  text: string,
  sourceText?: string,
): LinkFixture[] {
  const sources = sourceText ? parseLinkSourceFixture(sourceText) : [];
  const sourceByInstruction = new Map(
    sources.map((row) => [row.instruction_hash, row]),
  );
  const rows = nonCommentLines(text).map((line, index): LinkFixture => {
    if (line.startsWith("instruction:")) {
      const match = line.match(
        /^instruction:([0-9a-f]{16}) .* ledger_ref=(\S+) board_job=(.+?) status=\S+ .* match=(\S+)$/,
      );
      if (!match) {
        throw new Error(`exact link fixture line ${index + 1} is malformed`);
      }
      const source = sourceByInstruction.get(match[1]);
      if (sourceText && !source) {
        throw new Error(
          `exact link fixture line ${
            index + 1
          } lacks a primary source coordinate`,
        );
      }
      return {
        fixture_class: "exact_reference_existing_job",
        fixture_key: `instruction:${match[1]}`,
        instruction_hash: match[1],
        external_ref: match[2],
        job_number: match[3],
        match_key: match[4],
        source_hashes: source?.source_hashes || [],
        instruction_source_count: source?.instruction_source_count || 0,
      };
    }
    const parts = line.split("|").map((part) => part.trim());
    if (parts.length !== 5) {
      throw new Error(`orphan link fixture line ${index + 1} is malformed`);
    }
    const [jobNumber, verdict, matchKey, sourceEvidence, diagnosisRaw] = parts;
    if (!["SOURCE_FOUND", "SOURCE_FOUND_ADDR_KEY"].includes(verdict)) {
      throw new Error(
        `orphan link fixture line ${index + 1} has verdict ${verdict}`,
      );
    }
    const sourceMatch = sourceEvidence.match(/^source:([0-9a-f]{16})\b/);
    if (!sourceMatch || !diagnosisRaw.startsWith("link_row_missing:")) {
      throw new Error(
        `orphan link fixture line ${index + 1} lacks source evidence`,
      );
    }
    return {
      fixture_class: "recovered_orphan_source",
      fixture_key: `orphan:${jobNumber}`,
      job_number: jobNumber,
      source_hash: sourceMatch[1],
      match_key: matchKey,
      diagnosis: diagnosisRaw.slice("link_row_missing:".length),
    };
  });
  const exact = rows.filter((row) =>
    row.fixture_class === "exact_reference_existing_job"
  );
  const orphan = rows.filter((row) =>
    row.fixture_class === "recovered_orphan_source"
  );
  if (exact.length !== 246 || orphan.length !== 43) {
    throw new Error(
      `link fixture must contain 246 exact and 43 orphan rows, got ${exact.length} and ${orphan.length}`,
    );
  }
  if (sourceText && sourceByInstruction.size !== exact.length) {
    throw new Error(
      "link source fixture does not exactly cover instruction rows",
    );
  }
  return rows;
}

function parsePopulationFixture(text: string): PopulationFixture[] {
  const rows = nonCommentLines(text).map((line, index) => {
    const parts = line.split("|").map((part) => part.trim());
    if (parts.length !== 2) {
      throw new Error(`population fixture line ${index + 1} is malformed`);
    }
    return { job_number: parts[0], external_ref: parts[1] };
  });
  if (rows.length !== 4) {
    throw new Error(
      `population fixture must contain 4 rows, got ${rows.length}`,
    );
  }
  return rows;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function readOnlyFetch() {
  return async (input: string | URL | Request, init: RequestInit = {}) => {
    const method = String(
      init.method || (input instanceof Request ? input.method : "GET"),
    ).toUpperCase();
    if (!["GET", "HEAD"].includes(method)) {
      const url = new URL(input instanceof Request ? input.url : String(input));
      throw new Error(
        `read-only transport refused ${method} ${url.origin}${url.pathname}`,
      );
    }
    return await fetch(input, init);
  };
}

async function createReadClient(): Promise<any> {
  const url = assertProductionUrl(
    requiredEnv("SUPABASE_URL", DEFAULT_SUPABASE_URL),
  );
  const key = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const { createClient } = await import(
    "https://esm.sh/@supabase/supabase-js@2"
  );
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: readOnlyFetch() },
  });
}

async function pageAll(
  client: any,
  table: string,
  select: string,
  order = "id",
): Promise<any[]> {
  const rows: any[] = [];
  for (let offset = 0; offset < 100_000; offset += PAGE_SIZE) {
    const { data, error } = await client.from(table).select(select).order(
      order,
      { ascending: true },
    )
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw new Error(`${table} read failed: ${error.message}`);
    const batch = data || [];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) return rows;
  }
  throw new Error(`${table} pagination guard exhausted`);
}

function chunks<T>(values: readonly T[], size = 100): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size));
  }
  return output;
}

async function loadByValues(
  client: any,
  table: string,
  select: string,
  column: string,
  values: string[],
): Promise<any[]> {
  const rows: any[] = [];
  for (const group of chunks([...new Set(values)])) {
    if (!group.length) continue;
    const { data, error } = await client.from(table).select(select).in(
      column,
      group,
    );
    if (error) throw new Error(`${table} read failed: ${error.message}`);
    rows.push(...(data || []));
  }
  return rows;
}

function indexMany<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const value = key(row);
    map.set(value, [...(map.get(value) || []), row]);
  }
  return map;
}

function normalizedRef(value: unknown): string {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]+/g, "");
}

function canonicalBuilderRef(value: unknown): string | null {
  const normalized = normalizedRef(value);
  return normalized.match(/^(?:MLBMW|MLB|AJBR|BWCWA)\d+/)?.[0] ||
    (normalized || null);
}

function adjudicatedRefStillMatches(
  expected: string,
  observed: unknown,
): boolean {
  if (expected === "-") return canonicalBuilderRef(observed) !== null;
  return canonicalBuilderRef(expected) === canonicalBuilderRef(observed);
}

function fieldValue(job: JobRow): string | null {
  const value = job.metadata?.makesafe_job_family;
  return value == null ? null : String(value);
}

export function evaluateField(
  fixture: FieldFixture,
  jobs: JobRow[],
  details: DetailRow[],
  allowTempFence = false,
  fixtureClass = "field",
  /**
   * Cards the temp-fence class actually covers. Supplied by the safe-field
   * pass so a `temp_fence_makesafe` target it defers can be checked against
   * the class that is supposed to pick it up, rather than assumed.
   */
  tempFenceCoverage?: ReadonlySet<string>,
): FieldEvaluation {
  const base = {
    fixture_key: `${fixtureClass}:${fixture.card}`,
    card: fixture.card,
    column: fixture.column,
    expected_before: fixture.before,
    observed_before: null as string | null,
    after: fixture.after,
    job_id: null as string | null,
    board_kind_before: null as string | null,
    board_kind_after: null as string | null,
    eligible: false,
    reason: null as string | null,
  };
  if (fixture.after === "temp_fence_makesafe" && !allowTempFence) {
    // `handled_by_temp_fence_class` is a claim that another pass picks this
    // card up. When coverage is known and the card is NOT in it, that claim is
    // false and the fix is simply lost — SWMS-26692 sat NULL for exactly this
    // reason. Report the gap honestly so a certification diff surfaces it
    // instead of reading a skip as work done elsewhere.
    const deferredButUncovered = fixture.card !== TEMP_FENCE_HOLD &&
      tempFenceCoverage !== undefined &&
      !tempFenceCoverage.has(fixture.card);
    return {
      ...base,
      reason: fixture.card === TEMP_FENCE_HOLD
        ? "captain_hold_temp_fence"
        : deferredButUncovered
        ? "temp_fence_target_not_in_class"
        : "handled_by_temp_fence_class",
    };
  }
  if (jobs.length !== 1) {
    return {
      ...base,
      reason: jobs.length ? "job_number_not_unique" : "job_not_found",
    };
  }
  const job = jobs[0];
  base.job_id = job.id;
  if (details.length !== 1) {
    return {
      ...base,
      reason: details.length ? "detail_not_unique" : "detail_not_found",
    };
  }
  const detail = details[0];
  const observed = fieldValue(job);
  const nextJob = {
    ...job,
    metadata: { ...(job.metadata || {}), makesafe_job_family: fixture.after },
  };
  const beforeKind = classifyMakesafeJobType(detail, job);
  const afterKind = classifyMakesafeJobType(detail, nextJob);
  return {
    ...base,
    observed_before: observed,
    board_kind_before: beforeKind,
    board_kind_after: afterKind,
    eligible: observed === fixture.before && beforeKind === afterKind,
    reason: observed !== fixture.before
      ? "current_value_mismatch"
      : beforeKind !== afterKind
      ? "board_kind_would_change"
      : null,
  };
}

function identityKey(caseRow: CaseRow): string | null {
  const stored = String(caseRow.wo_po_identity_key || "").trim();
  if (stored) return stored;
  const ref = String(caseRow.external_ref_canonical || "").trim();
  return ref ? `wo:${ref}` : null;
}

export function evaluateLinks(input: {
  fixtures: LinkFixture[];
  jobs: JobRow[];
  details: DetailRow[];
  cases: CaseRow[];
  sources: SourceRow[];
  sourceJobLinks: SourceJobLinkRow[];
}): LinkEvaluation[] {
  const jobsByNumber = indexMany(input.jobs, (row) => row.job_number);
  const detailsByJob = indexMany(input.details, (row) => row.job_id);
  const casesById = new Map(input.cases.map((row) => [row.id, row]));
  const sourcesByHash = indexMany(
    input.sources,
    (row) => structuralHash(row.post_id),
  );
  const linksByPair = indexMany(
    input.sourceJobLinks,
    (row) => `${row.source_post_id}\u0000${row.job_id}`,
  );
  return input.fixtures.map((fixture): LinkEvaluation => {
    const base: LinkEvaluation = {
      fixture_class: fixture.fixture_class,
      fixture_key: fixture.fixture_key,
      source_post_id: null,
      target_job_id: null,
      target_job_number: fixture.job_number,
      expected_external_ref: fixture.fixture_class ===
          "exact_reference_existing_job"
        ? fixture.external_ref
        : null,
      observed_external_ref: null,
      expected_identity_key: null,
      match_key: fixture.match_key,
      eligible: false,
      already_applied: false,
      reason: null,
    };
    if (
      fixture.fixture_class === "recovered_orphan_source" &&
      fixture.diagnosis.includes("source_case_already_carries_job")
    ) {
      return {
        ...base,
        reason: "scope_excluded_remint_supersession_captain_pile",
      };
    }
    const jobs = jobsByNumber.get(fixture.job_number) || [];
    if (jobs.length !== 1) {
      return {
        ...base,
        reason: jobs.length
          ? "target_job_number_not_unique"
          : "target_job_not_found",
      };
    }
    const job = jobs[0];
    base.target_job_id = job.id;
    const details = detailsByJob.get(job.id) || [];
    if (details.length !== 1) {
      return {
        ...base,
        reason: details.length
          ? "target_detail_not_unique"
          : "target_detail_not_found",
      };
    }
    base.observed_external_ref = details[0].external_ref;

    let sourceRows: SourceRow[];
    if (fixture.fixture_class === "exact_reference_existing_job") {
      if (!fixture.source_hashes.length) {
        return { ...base, reason: "primary_source_coordinate_missing" };
      }
      sourceRows = sourcesByHash.get(fixture.source_hashes[0]) || [];
      if (sourceRows.length !== 1) {
        return {
          ...base,
          reason: sourceRows.length
            ? "source_hash_not_unique"
            : "source_hash_not_found",
        };
      }
      if (
        !adjudicatedRefStillMatches(
          fixture.external_ref,
          details[0].external_ref,
        )
      ) {
        return {
          ...base,
          reason: "job_external_ref_mismatch",
        };
      }
      base.source_count = fixture.instruction_source_count;
    } else {
      sourceRows = sourcesByHash.get(fixture.source_hash) || [];
      if (sourceRows.length !== 1) {
        return {
          ...base,
          reason: sourceRows.length
            ? "source_hash_not_unique"
            : "source_hash_not_found",
        };
      }
      const caseRow = casesById.get(sourceRows[0].case_id);
      if (!caseRow) return { ...base, reason: "source_case_not_found" };
    }
    const source = sourceRows[0];
    const caseRow = casesById.get(source.case_id)!;
    base.case_id = caseRow.id;
    base.source_count ??= sourceRows.length;
    base.source_post_id = source.post_id;
    base.expected_identity_key = identityKey(caseRow);
    const existing = linksByPair.get(`${source.post_id}\u0000${job.id}`) || [];
    if (existing.length > 1) {
      return { ...base, reason: "source_job_link_not_unique" };
    }
    if (existing.length === 1) {
      return { ...base, already_applied: true, reason: "already_applied" };
    }
    return { ...base, eligible: true };
  });
}

function populationEvaluations(
  fixtures: PopulationFixture[],
  jobs: JobRow[],
  details: DetailRow[],
) {
  const jobsByNumber = indexMany(jobs, (row) => row.job_number);
  const detailsByJob = indexMany(details, (row) => row.job_id);
  return fixtures.map((fixture) => {
    const jobRows = jobsByNumber.get(fixture.job_number) || [];
    const job = jobRows.length === 1 ? jobRows[0] : null;
    const detailRows = job ? detailsByJob.get(job.id) || [] : [];
    const detail = detailRows.length === 1 ? detailRows[0] : null;
    const oldPopulation = !!job && (job.type === "makesafe" ||
      (job.type === "insurance" &&
        String(job.metadata?.insurance_job_type || "") === "restoration"));
    return {
      job_number: fixture.job_number,
      expected_external_ref: fixture.external_ref,
      job_id: job?.id || null,
      job_type: job?.type || null,
      job_status: job?.status || null,
      observed_external_ref: detail?.external_ref || null,
      has_makesafe_job_details: !!detail,
      old_population_match: oldPopulation,
      corrected_population_match: !!detail || oldPopulation,
      eligible: !!job && !!detail && !oldPopulation,
      reason: !job
        ? "job_not_found"
        : !detail
        ? "detail_not_found"
        : oldPopulation
        ? "already_in_old_population"
        : null,
    };
  });
}

async function loadSourceJobLinksRest(client: any): Promise<{
  rows: SourceJobLinkRow[];
  tablePresent: boolean;
}> {
  try {
    const rows = await pageAll(
      client,
      "makesafe_source_job_links",
      "id,source_post_id,job_id,match_key",
    ) as SourceJobLinkRow[];
    return { rows, tablePresent: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.includes("makesafe_source_job_links") &&
      (message.includes("schema cache") || message.includes("does not exist"))
    ) return { rows: [], tablePresent: false };
    throw error;
  }
}

async function loadState(
  client: any,
  fields: FieldFixture[],
  links: LinkFixture[],
  population: PopulationFixture[],
) {
  const targetJobNumbers = [
    ...new Set([
      ...fields.map((row) => row.card),
      ...links.map((row) => row.job_number),
      ...population.map((row) => row.job_number),
    ]),
  ];
  try {
    const jobs = await loadByValues(
      client,
      "jobs",
      "id,job_number,type,status,metadata",
      "job_number",
      targetJobNumbers,
    ) as JobRow[];
    const details = await loadByValues(
      client,
      "makesafe_job_details",
      "job_id,external_ref,report_type,requesting_company_slug",
      "job_id",
      jobs.map((row) => row.id),
    ) as DetailRow[];
    const [cases, sources, sourceJobLinkState] = await Promise.all([
      pageAll(
        client,
        "makesafe_intake_cases",
        "id,instruction_key,state,reason_code,job_id,external_ref_canonical,wo_po_identity_key",
      ) as Promise<CaseRow[]>,
      pageAll(
        client,
        "makesafe_intake_case_sources",
        "id,case_id,post_id,received_at",
      ) as Promise<SourceRow[]>,
      loadSourceJobLinksRest(client),
    ]);
    return {
      jobs,
      details,
      cases,
      sources,
      sourceJobLinks: sourceJobLinkState.rows,
      sourceJobLinkTablePresent: sourceJobLinkState.tablePresent,
    };
  } catch (error) {
    console.error(
      `REST read unavailable, using Management API read-only SQL: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return await loadStateViaManagementApi(targetJobNumbers);
  }
}

async function loadStateViaManagementApi(targetJobNumbers: string[]) {
  const jobArray = `ARRAY[${targetJobNumbers.map(sqlText).join(",")}]::text[]`;
  const jobs = await managementDatabaseQuery(
    `SELECT id::text, job_number, type, status, metadata FROM public.jobs WHERE job_number = ANY(${jobArray}) ORDER BY job_number, id;`,
    true,
  ) as JobRow[];
  const details = jobs.length
    ? await managementDatabaseQuery(
      `SELECT job_id::text, external_ref, report_type, requesting_company_slug FROM public.makesafe_job_details WHERE job_id = ANY(ARRAY[${
        jobs.map((row) => sqlUuid(row.id)).join(",")
      }]::uuid[]) ORDER BY job_id;`,
      true,
    ) as DetailRow[]
    : [];
  const [cases, sources, tableState] = await Promise.all([
    managementDatabaseQuery(
      "SELECT id::text, instruction_key, state, reason_code, job_id::text, external_ref_canonical, wo_po_identity_key FROM public.makesafe_intake_cases ORDER BY id;",
      true,
    ) as Promise<CaseRow[]>,
    managementDatabaseQuery(
      "SELECT id::text, case_id::text, post_id, received_at::text FROM public.makesafe_intake_case_sources ORDER BY id;",
      true,
    ) as Promise<SourceRow[]>,
    managementDatabaseQuery(
      "SELECT to_regclass('public.makesafe_source_job_links') IS NOT NULL AS table_present;",
      true,
    ),
  ]);
  const sourceJobLinkTablePresent = tableState[0]?.table_present === true;
  const sourceJobLinks = sourceJobLinkTablePresent
    ? await managementDatabaseQuery(
      "SELECT id::text, source_post_id, job_id::text, match_key FROM public.makesafe_source_job_links ORDER BY id;",
      true,
    ) as SourceJobLinkRow[]
    : [];
  return {
    jobs,
    details,
    cases,
    sources,
    sourceJobLinks,
    sourceJobLinkTablePresent,
  };
}

function summarize(
  fields: FieldEvaluation[],
  tempFence: FieldEvaluation[],
  links: LinkEvaluation[],
  population: any[],
) {
  const linkClass = (name: LinkFixture["fixture_class"]) => {
    const rows = links.filter((row) => row.fixture_class === name);
    return {
      requested: rows.length,
      eligible: rows.filter((row) => row.eligible).length,
      already_applied: rows.filter((row) => row.already_applied).length,
      skipped:
        rows.filter((row) => !row.eligible && !row.already_applied).length,
    };
  };
  return {
    field_fixes: {
      requested: fields.length,
      eligible: fields.filter((row) => row.eligible).length,
      skipped: fields.filter((row) => !row.eligible).length,
    },
    temp_fence_relabels: {
      requested: tempFence.length,
      eligible: tempFence.filter((row) => row.eligible).length,
      skipped: tempFence.filter((row) => !row.eligible).length,
    },
    exact_reference_links: linkClass("exact_reference_existing_job"),
    recovered_orphan_links: linkClass("recovered_orphan_source"),
    board_population: {
      requested: population.length,
      eligible: population.filter((row: any) => row.eligible).length,
      skipped: population.filter((row: any) => !row.eligible).length,
    },
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await Deno.writeTextFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJson(path: string): Promise<any> {
  return JSON.parse(await Deno.readTextFile(path));
}

async function buildDryRun(
  client: any,
  fixtureHash: string,
  fields: FieldFixture[],
  tempFence: FieldFixture[],
  links: LinkFixture[],
  population: PopulationFixture[],
) {
  const holdFixture = fields.find((row) => row.card === TEMP_FENCE_HOLD);
  if (!holdFixture) {
    throw new Error(
      `${TEMP_FENCE_HOLD} captain hold is absent from safe fixture`,
    );
  }
  const state = await loadState(
    client,
    [...fields, ...tempFence],
    links,
    population,
  );
  const jobsByNumber = indexMany(state.jobs, (row) => row.job_number);
  const detailsByJob = indexMany(state.details, (row) => row.job_id);
  const tempFenceCoverage = new Set(tempFence.map((fixture) => fixture.card));
  const fieldEvaluations = fields.map((fixture) => {
    const jobs = jobsByNumber.get(fixture.card) || [];
    return evaluateField(
      fixture,
      jobs,
      jobs.length === 1 ? detailsByJob.get(jobs[0].id) || [] : [],
      false,
      "safe-field",
      tempFenceCoverage,
    );
  });
  const tempFenceEvaluations = tempFence.map((fixture) => {
    const jobs = jobsByNumber.get(fixture.card) || [];
    return evaluateField(
      fixture,
      jobs,
      jobs.length === 1 ? detailsByJob.get(jobs[0].id) || [] : [],
      true,
      "temp-fence",
    );
  });
  const holdJobs = jobsByNumber.get(holdFixture.card) || [];
  tempFenceEvaluations.push(evaluateField(
    holdFixture,
    holdJobs,
    holdJobs.length === 1 ? detailsByJob.get(holdJobs[0].id) || [] : [],
    false,
    "temp-fence",
  ));
  const linkEvaluations = evaluateLinks({ fixtures: links, ...state });
  const populationRows = populationEvaluations(
    population,
    state.jobs,
    state.details,
  );
  return {
    schema_version: 1,
    mode: "dry-run",
    generated_at: new Date().toISOString(),
    fixture_sha256: fixtureHash,
    safety: {
      dry_run_first: true,
      compare_and_set: true,
      link_table: "public.makesafe_source_job_links",
      link_table_present: state.sourceJobLinkTablePresent,
      authority_ledger_mutations: false,
      job_row_creation_or_restage: false,
      job_mutations_limited_to_guarded_metadata_field: true,
      temp_fence_umpire_fixture_applied: true,
      temp_fence_captain_hold: TEMP_FENCE_HOLD,
      captain_pile_excluded: true,
    },
    summary: summarize(
      fieldEvaluations,
      tempFenceEvaluations,
      linkEvaluations,
      populationRows,
    ),
    field_fixes: fieldEvaluations,
    temp_fence_relabels: tempFenceEvaluations,
    link_backfill: linkEvaluations,
    board_population: populationRows,
  };
}

function sqlText(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlUuid(value: string): string {
  if (
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
      .test(value)
  ) {
    throw new Error(`invalid UUID ${value}`);
  }
  return `${sqlText(value)}::uuid`;
}

async function managementDatabaseQuery(
  query: string,
  readOnly: boolean,
): Promise<any[]> {
  const token = requiredEnv("SUPABASE_ACCESS_TOKEN");
  const response = await fetch(
    `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "SecureWorks-Board-Fixes-Round2/1.0",
      },
      body: JSON.stringify({ query, read_only: readOnly }),
    },
  );
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      `Management API HTTP ${response.status}: ${JSON.stringify(payload)}`,
    );
  }
  if (!Array.isArray(payload)) {
    throw new Error("Management API returned non-row payload");
  }
  return payload;
}

async function managementQuery(query: string): Promise<any[]> {
  return await managementDatabaseQuery(query, false);
}

export function buildFieldUpdateSql(row: FieldEvaluation): string {
  if (!row.job_id || !row.eligible) {
    throw new Error(`field row ${row.fixture_key} is not eligible`);
  }
  const expected = row.expected_before === null
    ? "NULL"
    : sqlText(row.expected_before);
  return `WITH locked AS MATERIALIZED (
  SELECT j.id
  FROM public.jobs j
  JOIN public.makesafe_job_details d ON d.job_id = j.id
  WHERE j.id = ${sqlUuid(row.job_id)}
    AND j.job_number = ${sqlText(row.card)}
    AND (j.metadata->>'makesafe_job_family') IS NOT DISTINCT FROM ${expected}
  FOR UPDATE OF j, d
), changed AS (
  UPDATE public.jobs j
  SET metadata = jsonb_set(COALESCE(j.metadata, '{}'::jsonb), '{makesafe_job_family}', to_jsonb(${
    sqlText(row.after)
  }::text), true)
  FROM locked
  WHERE j.id = locked.id
  RETURNING j.id, j.metadata->>'makesafe_job_family' AS value
)
SELECT id::text, value FROM changed;`;
}

export function buildLinkInsertSql(rows: LinkEvaluation[]): string {
  const eligible = rows.filter((row) => row.eligible);
  if (!eligible.length) {
    return "SELECT NULL::text AS source_post_id, NULL::text AS target_job_id WHERE false;";
  }
  const values = eligible.map((row) =>
    `(${sqlText(row.source_post_id!)}, ${sqlUuid(row.target_job_id!)}, ${
      sqlText(row.expected_identity_key!)
    }, ${sqlText(row.fixture_class)}, ${sqlText(row.fixture_key)}, ${
      sqlText(row.match_key)
    })`
  ).join(",\n    ");
  return `WITH input(source_post_id, target_job_id, expected_identity_key, fixture_class, fixture_key, match_key) AS (
  VALUES
    ${values}
), inserted AS (
  INSERT INTO public.makesafe_source_job_links (
    org_id, source_post_id, job_id, match_key, provenance
  )
  SELECT
    ${sqlUuid(ORG_ID)}, i.source_post_id, i.target_job_id, i.match_key,
    jsonb_build_object(
      'adjudication_report', ${sqlText(LINK_REPORT)},
      'match_key', i.match_key,
      'expected_identity_key', i.expected_identity_key,
      'fixture_class', i.fixture_class,
      'fixture_key', i.fixture_key,
      'script', 'scripts/apply-board-fixes-round2-v1.ts'
    )
  FROM input i
  JOIN public.emails e ON e.post_id = i.source_post_id
  JOIN public.jobs j ON j.id = i.target_job_id AND j.org_id = ${sqlUuid(ORG_ID)}
  JOIN public.makesafe_job_details d ON d.job_id = j.id
  WHERE NOT EXISTS (
    SELECT 1 FROM public.makesafe_source_job_links l
    WHERE l.org_id = ${sqlUuid(ORG_ID)}
      AND l.source_post_id = i.source_post_id
      AND l.job_id = i.target_job_id
  )
  ON CONFLICT (org_id, source_post_id, job_id) DO NOTHING
  RETURNING source_post_id, job_id
)
SELECT source_post_id, job_id::text AS target_job_id FROM inserted ORDER BY source_post_id;`;
}

async function applyCorrections(
  client: any,
  baseline: any,
  fixtureHash: string,
  fields: FieldFixture[],
  tempFence: FieldFixture[],
  links: LinkFixture[],
  population: PopulationFixture[],
  ledgerPath: string,
) {
  if (baseline.mode !== "dry-run" || baseline.fixture_sha256 !== fixtureHash) {
    throw new Error("dry-run baseline does not match fixtures");
  }
  const fresh = await buildDryRun(
    client,
    fixtureHash,
    fields,
    tempFence,
    links,
    population,
  );
  if (!fresh.safety.link_table_present) {
    throw new Error(
      "public.makesafe_source_job_links is missing; apply the reviewed migration before data writes",
    );
  }
  const ledger: any = {
    schema_version: 1,
    mode: "apply",
    generated_at: new Date().toISOString(),
    fixture_sha256: fixtureHash,
    dry_run_generated_at: baseline.generated_at,
    field_fixes: { writes: [], skipped: [] },
    temp_fence_relabels: { writes: [], skipped: [] },
    link_backfill: { writes: [], already_applied: [], skipped: [] },
    board_population: {
      code_change: "makesafe_job_details authority backstop",
      rows: fresh.board_population,
    },
  };
  await writeJson(ledgerPath, ledger);

  for (
    const [section, rows] of [
      ["field_fixes", fresh.field_fixes],
      ["temp_fence_relabels", fresh.temp_fence_relabels],
    ] as const
  ) {
    for (const row of rows as FieldEvaluation[]) {
      if (!row.eligible) {
        ledger[section].skipped.push({
          ...row,
          timestamp: new Date().toISOString(),
        });
        continue;
      }
      const result = await managementQuery(buildFieldUpdateSql(row));
      if (
        result.length === 1 && String(result[0].id) === row.job_id &&
        String(result[0].value) === row.after
      ) {
        ledger[section].writes.push({
          ...row,
          timestamp: new Date().toISOString(),
        });
      } else {
        ledger[section].skipped.push({
          ...row,
          eligible: false,
          reason: "compare_and_set_miss",
          timestamp: new Date().toISOString(),
        });
      }
      await writeJson(ledgerPath, ledger);
    }
  }

  const linkRows = fresh.link_backfill as LinkEvaluation[];
  const seen = new Map<string, LinkEvaluation>();
  const uniqueEligible: LinkEvaluation[] = [];
  for (const row of linkRows) {
    if (row.already_applied) {
      ledger.link_backfill.already_applied.push({
        ...row,
        timestamp: new Date().toISOString(),
      });
      continue;
    }
    if (!row.eligible || !row.source_post_id) {
      ledger.link_backfill.skipped.push({
        ...row,
        timestamp: new Date().toISOString(),
      });
      continue;
    }
    const pairKey = `${row.source_post_id}\u0000${row.target_job_id}`;
    const prior = seen.get(pairKey);
    if (prior) {
      ledger.link_backfill.skipped.push({
        ...row,
        eligible: false,
        reason: "duplicate_fixture_same_binding",
        satisfied_by: prior.fixture_key,
        timestamp: new Date().toISOString(),
      });
      continue;
    }
    seen.set(pairKey, row);
    uniqueEligible.push(row);
  }
  const inserted = await managementQuery(buildLinkInsertSql(uniqueEligible));
  const insertedKeys = new Set(
    inserted.map((row) => `${row.source_post_id}\u0000${row.target_job_id}`),
  );
  for (const row of uniqueEligible) {
    const key = `${row.source_post_id}\u0000${row.target_job_id}`;
    const entry = { ...row, timestamp: new Date().toISOString() };
    if (insertedKeys.has(key)) ledger.link_backfill.writes.push(entry);
    else {ledger.link_backfill.skipped.push({
        ...entry,
        eligible: false,
        reason: "compare_and_set_miss",
      });}
  }
  ledger.summary = {
    field_fixes: {
      applied: ledger.field_fixes.writes.length,
      skipped: ledger.field_fixes.skipped.length,
    },
    temp_fence_relabels: {
      applied: ledger.temp_fence_relabels.writes.length,
      skipped: ledger.temp_fence_relabels.skipped.length,
    },
    link_backfill: {
      applied: ledger.link_backfill.writes.length,
      already_applied: ledger.link_backfill.already_applied.length,
      skipped: ledger.link_backfill.skipped.length,
    },
    board_population: {
      code_rows:
        fresh.board_population.filter((row: any) => row.eligible).length,
      skipped:
        fresh.board_population.filter((row: any) => !row.eligible).length,
    },
  };
  await writeJson(ledgerPath, ledger);
  return ledger;
}

async function verifyCorrections(
  client: any,
  baseline: any,
  ledger: any,
  fixtureHash: string,
  fields: FieldFixture[],
  tempFence: FieldFixture[],
  links: LinkFixture[],
  population: PopulationFixture[],
) {
  if (
    baseline.fixture_sha256 !== fixtureHash ||
    ledger.fixture_sha256 !== fixtureHash
  ) throw new Error("verify artifacts do not match fixtures");
  const fresh = await buildDryRun(
    client,
    fixtureHash,
    fields,
    tempFence,
    links,
    population,
  );
  const fieldByKey = new Map(
    (fresh.field_fixes as FieldEvaluation[]).map((
      row,
    ) => [row.fixture_key, row]),
  );
  const tempFenceByKey = new Map(
    (fresh.temp_fence_relabels as FieldEvaluation[]).map((row) => [
      row.fixture_key,
      row,
    ]),
  );
  const linkByKey = new Map(
    (fresh.link_backfill as LinkEvaluation[]).map((
      row,
    ) => [row.fixture_key, row]),
  );
  const fieldWrites = ledger.field_fixes.writes.map((write: any) => ({
    fixture_key: write.fixture_key,
    expected_final: write.after,
    observed_final: fieldByKey.get(write.fixture_key)?.observed_before ?? null,
    ok: fieldByKey.get(write.fixture_key)?.observed_before === write.after,
  }));
  const tempFenceWrites = ledger.temp_fence_relabels.writes.map((
    write: any,
  ) => ({
    fixture_key: write.fixture_key,
    expected_final: write.after,
    observed_final: tempFenceByKey.get(write.fixture_key)?.observed_before ??
      null,
    ok: tempFenceByKey.get(write.fixture_key)?.observed_before === write.after,
  }));
  const linkWrites = ledger.link_backfill.writes.map((write: any) => {
    const observed = linkByKey.get(write.fixture_key);
    return {
      fixture_key: write.fixture_key,
      source_post_id: write.source_post_id,
      target_job_id: write.target_job_id,
      observed_reason: observed?.reason || null,
      ok: observed?.already_applied === true,
    };
  });
  const populationRows = fresh.board_population.map((row: any) => ({
    ...row,
    code_contract_ok: row.has_makesafe_job_details === true &&
      row.corrected_population_match === true,
  }));
  const success = fieldWrites.every((row: any) => row.ok) &&
    tempFenceWrites.every((row: any) => row.ok) &&
    linkWrites.every((row: any) => row.ok) &&
    populationRows.every((row: any) => row.code_contract_ok) &&
    (ledger.field_fixes.writes.length + ledger.field_fixes.skipped.length ===
      11) &&
    (ledger.temp_fence_relabels.writes.length +
        ledger.temp_fence_relabels.skipped.length === 57) &&
    (ledger.link_backfill.writes.length +
        ledger.link_backfill.already_applied.length +
        ledger.link_backfill.skipped.length === 289);
  return {
    schema_version: 1,
    mode: "verify",
    generated_at: new Date().toISOString(),
    fixture_sha256: fixtureHash,
    summary: {
      field_applied: ledger.field_fixes.writes.length,
      field_skipped: ledger.field_fixes.skipped.length,
      temp_fence_applied: ledger.temp_fence_relabels.writes.length,
      temp_fence_skipped: ledger.temp_fence_relabels.skipped.length,
      link_applied: ledger.link_backfill.writes.length,
      link_already_applied: ledger.link_backfill.already_applied.length,
      link_skipped: ledger.link_backfill.skipped.length,
      population_code_rows:
        populationRows.filter((row: any) => row.code_contract_ok).length,
      field_state_failures: fieldWrites.filter((row: any) => !row.ok).length,
      temp_fence_state_failures:
        tempFenceWrites.filter((row: any) => !row.ok).length,
      link_state_failures: linkWrites.filter((row: any) => !row.ok).length,
      population_failures:
        populationRows.filter((row: any) => !row.code_contract_ok).length,
      success,
    },
    field_writes: fieldWrites,
    temp_fence_writes: tempFenceWrites,
    link_writes: linkWrites,
    board_population: populationRows,
    accounted_skips: {
      field_fixes: ledger.field_fixes.skipped,
      temp_fence_relabels: ledger.temp_fence_relabels.skipped,
      link_backfill: ledger.link_backfill.skipped,
    },
  };
}

function printHelp() {
  console.log(`description: Apply guarded round-2 MakeSafe board corrections
default_mode: dry-run
flags[6]{name,meaning}:
  --mode,"dry-run, apply, or verify"
  --output,"dry-run or verify JSON path"
  --baseline,"dry-run JSON path"
  --ledger,"apply ledger JSON path"
  --overwrite-output,"allow replacing an output artifact"
  --help,"show this reference"
environment[2]{name,required_for}:
  SUPABASE_SERVICE_ROLE_KEY,"dry-run, apply, verify"
  SUPABASE_ACCESS_TOKEN,apply`);
}

async function main() {
  if (Deno.args.includes("--help")) return printHelp();
  const mode = option("--mode") || "dry-run";
  if (!["dry-run", "apply", "verify"].includes(mode)) {
    throw new Error(`unsupported mode ${mode}`);
  }
  const [
    migrationText,
    fieldText,
    tempFenceText,
    linkText,
    linkSourceText,
    populationText,
  ] = await Promise.all([
    Deno.readTextFile(SOURCE_JOB_LINK_MIGRATION),
    Deno.readTextFile(FIELD_FIXTURE),
    Deno.readTextFile(TEMP_FENCE_FIXTURE),
    Deno.readTextFile(LINK_FIXTURE),
    Deno.readTextFile(LINK_SOURCE_FIXTURE),
    Deno.readTextFile(POPULATION_FIXTURE),
  ]);
  const fields = parseFieldFixture(fieldText);
  const tempFence = parseTempFenceFixture(tempFenceText);
  const links = parseLinkFixture(linkText, linkSourceText);
  const population = parsePopulationFixture(populationText);
  const fixtureHash = await sha256(
    `${migrationText}\n${fieldText}\n${tempFenceText}\n${linkText}\n${linkSourceText}\n${populationText}`,
  );
  const client = await createReadClient();
  const baselinePath = option("--baseline") || pathFromUrl(DEFAULT_DRY_RUN);
  const ledgerPath = option("--ledger") || pathFromUrl(DEFAULT_LEDGER);
  if (mode === "dry-run") {
    const output = option("--output") || baselinePath;
    if (!Deno.args.includes("--overwrite-output")) {
      try {
        await Deno.stat(output);
        throw new Error(
          `refusing to overwrite ${output}; pass --overwrite-output`,
        );
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
    const report = await buildDryRun(
      client,
      fixtureHash,
      fields,
      tempFence,
      links,
      population,
    );
    await writeJson(output, report);
    console.log(JSON.stringify(report.summary));
    return;
  }
  const baseline = await readJson(baselinePath);
  if (mode === "apply") {
    const ledger = await applyCorrections(
      client,
      baseline,
      fixtureHash,
      fields,
      tempFence,
      links,
      population,
      ledgerPath,
    );
    console.log(JSON.stringify(ledger.summary));
    return;
  }
  const ledger = await readJson(ledgerPath);
  const report = await verifyCorrections(
    client,
    baseline,
    ledger,
    fixtureHash,
    fields,
    tempFence,
    links,
    population,
  );
  const output = option("--output") || pathFromUrl(DEFAULT_VERIFY);
  await writeJson(output, report);
  console.log(JSON.stringify(report.summary));
  if (!report.summary.success) Deno.exitCode = 1;
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(
      `error: ${error instanceof Error ? error.message : String(error)}`,
    );
    Deno.exitCode = 1;
  }
}
