#!/usr/bin/env -S deno run --allow-env --allow-net --allow-read --allow-write
// deno-lint-ignore-file no-explicit-any no-import-prefix
/**
 * Applies the adjudicated MakeSafe board SAFE correction fixture.
 *
 * Safety contract:
 * - dry-run is the default mode and permits only GET/HEAD requests;
 * - apply permits PATCH only against jobs and makesafe_job_details;
 * - every write is compare-and-set against the fixture's expected current value;
 * - a fresh preflight with more than 10 skipped rows refuses all writes;
 * - displayed board kind is computed by the production classifier before every
 *   candidate write and must remain unchanged;
 * - verify re-reads every fixture row and re-runs the production v2 comparison.
 */

import {
  classifyMakesafeJobType,
} from "../supabase/functions/ops-api/makesafe_computed_status.ts";

const PROJECT_REF = "kevgrhcjxspbxgovpmfl";
const DEFAULT_SUPABASE_URL = `https://${PROJECT_REF}.supabase.co`;
const EXPECTED_CORRECTION_COUNT = 194;
const MAX_SKIPS_BEFORE_APPLY = 10;
const PAGE_CHUNK = 100;
const FIXTURE_URL = new URL(
  "./board-safe-fixes-v1.fixture.txt",
  import.meta.url,
);
const DEFAULT_DRY_RUN_URL = new URL(
  "./board-safe-fixes-v1.dry-run.json",
  import.meta.url,
);
const DEFAULT_LEDGER_URL = new URL(
  "./board-safe-fixes-v1.apply-ledger.json",
  import.meta.url,
);
const DEFAULT_VERIFY_URL = new URL(
  "./board-safe-fixes-v1.verify.json",
  import.meta.url,
);

export type CorrectionColumn =
  | "jobs.metadata.makesafe_job_family"
  | "makesafe_job_details.report_type"
  | "makesafe_job_details.requesting_company_slug";

export interface Correction {
  card: string;
  column: CorrectionColumn;
  current: string | null;
  after: string;
  rationale: string;
}

interface JobRow {
  id: string;
  job_number: string;
  metadata: Record<string, unknown> | null;
  type: string | null;
  status: string | null;
  updated_at: string | null;
}

interface DetailRow {
  job_id: string;
  report_type: string | null;
  requesting_company_slug: string | null;
  updated_at: string | null;
}

export interface Evaluation {
  card: string;
  column: CorrectionColumn;
  expected_current: string | null;
  observed_current: string | null;
  after: string;
  job_id: string | null;
  board_kind_before: string | null;
  board_kind_after: string | null;
  eligible: boolean;
  reason: string | null;
}

interface LoadedTargets {
  jobsByCard: Map<string, JobRow[]>;
  detailsByJob: Map<string, DetailRow[]>;
}

interface ProjectionHealth {
  complete: boolean;
  requested_job_count: number;
  projected_job_count: number;
  differing_job_count: number;
  projection_input_error_job_count: number;
  duplicate_job_ids: string[];
}

interface DryRunReport {
  schema_version: 1;
  mode: "dry-run";
  generated_at: string;
  fixture_sha256: string;
  fixture_count: number;
  summary: {
    eligible: number;
    skipped: number;
    board_kind_changed: number;
    apply_allowed: boolean;
  };
  projection_health: ProjectionHealth;
  entries: Evaluation[];
}

interface LedgerWrite {
  card: string;
  column: CorrectionColumn;
  before: string | null;
  after: string;
  timestamp: string;
  job_id: string;
  board_kind_before: string;
  board_kind_after: string;
}

type LedgerPending = LedgerWrite;

interface LedgerSkip {
  card: string;
  column: CorrectionColumn;
  expected_current: string | null;
  observed_current: string | null;
  timestamp: string;
  reason: string;
  job_id: string | null;
  board_kind_before: string | null;
  board_kind_after: string | null;
}

interface ApplyLedger {
  schema_version: 1;
  mode: "apply";
  generated_at: string;
  updated_at: string;
  fixture_sha256: string;
  fixture_count: number;
  dry_run_generated_at: string;
  summary: {
    applied_total: number;
    applied_this_run: number;
    already_applied: number;
    recovered: number;
    skipped: number;
  };
  pending: LedgerPending[];
  writes: LedgerWrite[];
  skipped: LedgerSkip[];
}

const APPROVED_COLUMNS = new Set<CorrectionColumn>([
  "jobs.metadata.makesafe_job_family",
  "makesafe_job_details.report_type",
  "makesafe_job_details.requesting_company_slug",
]);
const VALUE_FLAGS = new Set(["--mode", "--output", "--baseline", "--ledger"]);
const BOOLEAN_FLAGS = new Set(["--help", "--overwrite-output"]);

class UsageError extends Error {}

function pathFromUrl(url: URL): string {
  return decodeURIComponent(url.pathname);
}

function option(name: string): string | undefined {
  const equals = Deno.args.find((arg) => arg.startsWith(`${name}=`));
  if (equals) return equals.slice(name.length + 1);
  const index = Deno.args.indexOf(name);
  return index >= 0 ? Deno.args[index + 1] : undefined;
}

function validateArgs(args: string[]): void {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const equalsIndex = arg.indexOf("=");
    const name = equalsIndex >= 0 ? arg.slice(0, equalsIndex) : arg;
    if (BOOLEAN_FLAGS.has(name)) {
      if (equalsIndex >= 0) {
        throw new UsageError(`${name} does not take a value`);
      }
      continue;
    }
    if (VALUE_FLAGS.has(name)) {
      if (equalsIndex >= 0) {
        if (!arg.slice(equalsIndex + 1)) {
          throw new UsageError(`${name} requires a value`);
        }
        continue;
      }
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new UsageError(`${name} requires a value`);
      }
      index++;
      continue;
    }
    throw new UsageError(`unknown argument ${arg}`);
  }
}

function printHelp(): void {
  console.log(
    `description: Apply the production-locked MakeSafe SAFE correction fixture
default_mode: dry-run
flags[6]{name,meaning}:
  --mode,"dry-run, apply, or verify"
  --output,"evidence output path for dry-run or verify"
  --baseline,"immutable dry-run JSON path"
  --ledger,"apply ledger JSON path"
  --overwrite-output,"allow replacing explicit dry-run evidence"
  --help,"show this reference"
environment[2]{name,required_for}:
  SUPABASE_SERVICE_ROLE_KEY,"dry-run, apply, verify"
  SUPABASE_ACCESS_TOKEN,apply
examples[3]:
  "scripts/apply-board-safe-fixes-v1.ts --mode dry-run --output <dry-run.json>"
  "scripts/apply-board-safe-fixes-v1.ts --mode apply --baseline <dry-run.json> --ledger <ledger.json>"
  "scripts/apply-board-safe-fixes-v1.ts --mode verify --baseline <dry-run.json> --ledger <ledger.json> --output <verify.json>"`,
  );
}

function printSummary(mode: string, summary: Record<string, unknown>): void {
  console.log(
    [
      `mode: ${mode}`,
      ...Object.entries(summary).map(([key, value]) =>
        `${key}: ${String(value)}`
      ),
    ].join("\n"),
  );
}

function requiredEnv(name: string, fallback?: string): string {
  const value = Deno.env.get(name)?.trim() || fallback;
  if (!value) throw new Error(`${name} is required`);
  return value.replace(/\/+$/, "");
}

export function assertProductionSupabaseUrl(value: string): string {
  const url = new URL(value);
  if (url.origin !== DEFAULT_SUPABASE_URL) {
    throw new Error(
      `SUPABASE_URL must target production project ${PROJECT_REF}`,
    );
  }
  return url.origin;
}

function chunks<T>(values: readonly T[], size = PAGE_CHUNK): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size));
  }
  return output;
}

function correctionKey(
  correction: Pick<Correction, "card" | "column">,
): string {
  return `${correction.card}\u0000${correction.column}`;
}

function parseValue(raw: string): string | null {
  return raw === "NULL" ? null : raw;
}

export function parseFixture(text: string): Correction[] {
  const rows = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const corrections = rows.map((line, index): Correction => {
    const parts = line.split("|").map((part) => part.trim());
    if (parts.length !== 5) {
      throw new Error(`fixture line ${index + 1} must have five pipe fields`);
    }
    const [card, rawColumn, rawCurrent, after, rationale] = parts;
    if (!card || !rawColumn || !after || !rationale) {
      throw new Error(`fixture line ${index + 1} contains an empty field`);
    }
    if (!APPROVED_COLUMNS.has(rawColumn as CorrectionColumn)) {
      throw new Error(
        `fixture line ${index + 1} targets unapproved column ${rawColumn}`,
      );
    }
    const column = rawColumn as CorrectionColumn;
    const current = parseValue(rawCurrent);
    const allowed = column === "jobs.metadata.makesafe_job_family"
      ? current === null &&
        ["general_makesafe", "temp_fence_makesafe"].includes(after)
      : column === "makesafe_job_details.report_type"
      ? current === null && ["roof_report", "assessment_report"].includes(after)
      : current === "ajbr" && after === "aj";
    if (!allowed) {
      throw new Error(
        `fixture line ${index + 1} has an unapproved transition for ${column}`,
      );
    }
    return { card, column, current, after, rationale };
  });
  if (corrections.length !== EXPECTED_CORRECTION_COUNT) {
    throw new Error(
      `fixture must contain ${EXPECTED_CORRECTION_COUNT} rows, got ${corrections.length}`,
    );
  }
  const seen = new Set<string>();
  for (const correction of corrections) {
    const key = correctionKey(correction);
    if (seen.has(key)) throw new Error(`duplicate fixture correction ${key}`);
    seen.add(key);
  }
  return corrections;
}

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  )
    .join("");
}

function targetValue(
  correction: Correction,
  job: JobRow,
  detail: DetailRow,
): string | null {
  if (correction.column === "jobs.metadata.makesafe_job_family") {
    const value = job.metadata?.makesafe_job_family;
    return value === undefined || value === null ? null : String(value);
  }
  if (correction.column === "makesafe_job_details.report_type") {
    return detail.report_type;
  }
  return detail.requesting_company_slug;
}

function withCorrection(
  correction: Correction,
  job: JobRow,
  detail: DetailRow,
): { job: JobRow; detail: DetailRow } {
  if (correction.column === "jobs.metadata.makesafe_job_family") {
    return {
      job: {
        ...job,
        metadata: {
          ...(job.metadata || {}),
          makesafe_job_family: correction.after,
        },
      },
      detail,
    };
  }
  if (correction.column === "makesafe_job_details.report_type") {
    return { job, detail: { ...detail, report_type: correction.after } };
  }
  return {
    job,
    detail: { ...detail, requesting_company_slug: correction.after },
  };
}

export function evaluateCorrection(
  correction: Correction,
  jobs: readonly JobRow[],
  details: readonly DetailRow[],
): Evaluation {
  if (jobs.length !== 1) {
    return {
      card: correction.card,
      column: correction.column,
      expected_current: correction.current,
      observed_current: null,
      after: correction.after,
      job_id: null,
      board_kind_before: null,
      board_kind_after: null,
      eligible: false,
      reason: jobs.length === 0 ? "job_not_found" : "job_number_not_unique",
    };
  }
  const job = jobs[0];
  if (details.length !== 1) {
    return {
      card: correction.card,
      column: correction.column,
      expected_current: correction.current,
      observed_current: null,
      after: correction.after,
      job_id: job.id,
      board_kind_before: null,
      board_kind_after: null,
      eligible: false,
      reason: details.length === 0 ? "detail_not_found" : "detail_not_unique",
    };
  }
  const detail = details[0];
  const observed = targetValue(correction, job, detail);
  const next = withCorrection(correction, job, detail);
  const beforeKind = classifyMakesafeJobType(detail, job);
  const afterKind = classifyMakesafeJobType(next.detail, next.job);
  const currentMatches = observed === correction.current;
  const kindMatches = beforeKind === afterKind;
  return {
    card: correction.card,
    column: correction.column,
    expected_current: correction.current,
    observed_current: observed,
    after: correction.after,
    job_id: job.id,
    board_kind_before: beforeKind,
    board_kind_after: afterKind,
    eligible: currentMatches && kindMatches,
    reason: !currentMatches
      ? "current_value_mismatch"
      : !kindMatches
      ? "board_kind_would_change"
      : null,
  };
}

export function readOnlyFetch() {
  return async (
    input: string | URL | Request,
    init: RequestInit = {},
  ): Promise<Response> => {
    const method = String(
      init.method || (input instanceof Request ? input.method : "GET"),
    ).toUpperCase();
    if (["GET", "HEAD"].includes(method)) {
      return await fetch(input, init);
    }
    const url = new URL(input instanceof Request ? input.url : String(input));
    throw new Error(
      `read-only transport refused ${method} ${url.origin}${url.pathname}`,
    );
  };
}

async function createClient(): Promise<any> {
  const supabaseUrl = assertProductionSupabaseUrl(
    requiredEnv("SUPABASE_URL", DEFAULT_SUPABASE_URL),
  );
  const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const { createClient } = await import(
    "https://esm.sh/@supabase/supabase-js@2"
  );
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: readOnlyFetch() },
  });
}

async function loadTargets(
  client: any,
  corrections: readonly Correction[],
): Promise<LoadedTargets> {
  const cards = [...new Set(corrections.map((row) => row.card))];
  const jobsByCard = new Map<string, JobRow[]>();
  for (const cardChunk of chunks(cards)) {
    const { data, error } = await client.from("jobs")
      .select("id,job_number,metadata,type,status,updated_at")
      .in("job_number", cardChunk);
    if (error) throw new Error(`jobs read failed: ${error.message}`);
    for (const row of data || []) {
      const card = String(row.job_number || "");
      jobsByCard.set(card, [...(jobsByCard.get(card) || []), row as JobRow]);
    }
  }
  const jobIds = [...jobsByCard.values()].flat().map((job) => job.id);
  const detailsByJob = new Map<string, DetailRow[]>();
  for (const idChunk of chunks(jobIds)) {
    const { data, error } = await client.from("makesafe_job_details")
      .select("job_id,report_type,requesting_company_slug,updated_at")
      .in("job_id", idChunk);
    if (error) {
      throw new Error(`makesafe_job_details read failed: ${error.message}`);
    }
    for (const row of data || []) {
      const id = String(row.job_id || "");
      detailsByJob.set(id, [...(detailsByJob.get(id) || []), row as DetailRow]);
    }
  }
  return { jobsByCard, detailsByJob };
}

function evaluateAll(
  corrections: readonly Correction[],
  targets: LoadedTargets,
): Evaluation[] {
  return corrections.map((correction) => {
    const jobs = targets.jobsByCard.get(correction.card) || [];
    const details = jobs.length === 1
      ? targets.detailsByJob.get(jobs[0].id) || []
      : [];
    return evaluateCorrection(correction, jobs, details);
  });
}

async function runProjectionComparison(client: any): Promise<ProjectionHealth> {
  const opsModule = await import(
    "../supabase/functions/ops-api/index.ts"
  );
  const compareModule = await import(
    "../supabase/functions/ops-api/makesafe_state_compare.ts"
  );
  const canonicalRows = await opsModule._loadCanonicalMakesafeBoardForTest(
    client,
  );
  const comparison = await compareModule
    .attachMakesafeStateV2SeedPreviewComparison(
      client,
      canonicalRows,
      new Date().toISOString(),
    );
  return comparison.projection_health as ProjectionHealth;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await Deno.readTextFile(path)) as T;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await Deno.writeTextFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

function projectionHealthComplete(health: ProjectionHealth): boolean {
  return health.complete === true &&
    health.requested_job_count === health.projected_job_count &&
    health.duplicate_job_ids.length === 0;
}

function assertDryRunBaseline(
  baseline: DryRunReport,
  fixtureHash: string,
): void {
  if (
    baseline.schema_version !== 1 || baseline.mode !== "dry-run" ||
    baseline.fixture_sha256 !== fixtureHash ||
    baseline.fixture_count !== EXPECTED_CORRECTION_COUNT
  ) {
    throw new Error("dry-run baseline does not match this fixture");
  }
  if (baseline.summary.skipped > MAX_SKIPS_BEFORE_APPLY) {
    throw new Error(
      `dry-run skipped ${baseline.summary.skipped}, above the ${MAX_SKIPS_BEFORE_APPLY}-card apply limit`,
    );
  }
  if (baseline.summary.board_kind_changed !== 0) {
    throw new Error("dry-run found a displayed board kind change");
  }
  if (!baseline.summary.apply_allowed) {
    throw new Error("dry-run baseline did not authorize apply");
  }
  if (!projectionHealthComplete(baseline.projection_health)) {
    throw new Error("dry-run v2 projection comparison was incomplete");
  }
}

async function dryRun(
  client: any,
  corrections: Correction[],
  fixtureHash: string,
  outputPath: string,
): Promise<DryRunReport> {
  const evaluations = evaluateAll(
    corrections,
    await loadTargets(client, corrections),
  );
  const skipped = evaluations.filter((entry) => !entry.eligible).length;
  const boardKindChanged =
    evaluations.filter((entry) =>
      entry.board_kind_before !== entry.board_kind_after
    ).length;
  const projectionHealth = await runProjectionComparison(client);
  const report: DryRunReport = {
    schema_version: 1,
    mode: "dry-run",
    generated_at: new Date().toISOString(),
    fixture_sha256: fixtureHash,
    fixture_count: corrections.length,
    summary: {
      eligible: evaluations.length - skipped,
      skipped,
      board_kind_changed: boardKindChanged,
      apply_allowed: skipped <= MAX_SKIPS_BEFORE_APPLY &&
        boardKindChanged === 0 && projectionHealthComplete(projectionHealth),
    },
    projection_health: projectionHealth,
    entries: evaluations,
  };
  await writeJson(outputPath, report);
  printSummary(report.mode, report.summary);
  return report;
}

function sqlText(value: string | null): string {
  return value === null ? "NULL" : `'${value.replaceAll("'", "''")}'`;
}

function sqlUuid(value: string): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(value)
  ) {
    throw new Error(`invalid job UUID ${value}`);
  }
  return `'${value}'::uuid`;
}

export function buildConditionalUpdateSql(
  correction: Correction,
  job: JobRow,
  detail: DetailRow,
): string {
  const locked = `
WITH locked AS MATERIALIZED (
  SELECT j.id
  FROM public.jobs AS j
  JOIN public.makesafe_job_details AS d ON d.job_id = j.id
  WHERE j.id = ${sqlUuid(job.id)}
    AND j.job_number IS NOT DISTINCT FROM ${sqlText(correction.card)}
    AND (j.metadata->>'makesafe_job_family') IS NOT DISTINCT FROM ${
    sqlText(
      job.metadata?.makesafe_job_family == null
        ? null
        : String(job.metadata.makesafe_job_family),
    )
  }
    AND d.report_type IS NOT DISTINCT FROM ${sqlText(detail.report_type)}
    AND d.requesting_company_slug IS NOT DISTINCT FROM ${
    sqlText(detail.requesting_company_slug)
  }
  FOR UPDATE OF j, d
)`;
  if (correction.column === "jobs.metadata.makesafe_job_family") {
    return `${locked},
changed AS (
  UPDATE public.jobs AS j
  SET metadata = jsonb_set(
    COALESCE(j.metadata, '{}'::jsonb),
    '{makesafe_job_family}',
    to_jsonb(${sqlText(correction.after)}::text),
    true
  )
  FROM locked
  WHERE j.id = locked.id
  RETURNING j.id, j.metadata->>'makesafe_job_family' AS value
)
SELECT id::text, value FROM changed;`;
  }
  const field = correction.column === "makesafe_job_details.report_type"
    ? "report_type"
    : "requesting_company_slug";
  return `${locked},
changed AS (
  UPDATE public.makesafe_job_details AS d
  SET ${field} = ${sqlText(correction.after)}
  FROM locked
  WHERE d.job_id = locked.id
  RETURNING d.job_id, d.${field} AS value
)
SELECT job_id::text AS id, value FROM changed;`;
}

async function conditionalUpdate(
  correction: Correction,
  job: JobRow,
  detail: DetailRow,
): Promise<boolean> {
  const accessToken = requiredEnv("SUPABASE_ACCESS_TOKEN");
  const response = await fetch(
    `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "User-Agent": "SecureWorks-Board-Safe-Fixes/1.0",
      },
      body: JSON.stringify({
        query: buildConditionalUpdateSql(correction, job, detail),
        read_only: false,
      }),
    },
  );
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(
      `${correction.card} update returned non-JSON HTTP ${response.status}`,
    );
  }
  if (!response.ok) {
    const message = typeof payload === "object" && payload !== null &&
        "message" in payload
      ? String((payload as { message: unknown }).message)
      : JSON.stringify(payload);
    throw new Error(
      `${correction.card} update returned HTTP ${response.status}: ${message}`,
    );
  }
  if (!Array.isArray(payload)) {
    throw new Error(`${correction.card} update returned a non-row payload`);
  }
  if (payload.length === 0) return false;
  if (
    payload.length !== 1 || String(payload[0]?.id || "") !== job.id ||
    String(payload[0]?.value || "") !== correction.after
  ) {
    throw new Error(`${correction.card} update returned unexpected rows`);
  }
  return true;
}

function newLedger(
  fixtureHash: string,
  baseline: DryRunReport,
): ApplyLedger {
  const now = new Date().toISOString();
  return {
    schema_version: 1,
    mode: "apply",
    generated_at: now,
    updated_at: now,
    fixture_sha256: fixtureHash,
    fixture_count: EXPECTED_CORRECTION_COUNT,
    dry_run_generated_at: baseline.generated_at,
    summary: {
      applied_total: 0,
      applied_this_run: 0,
      already_applied: 0,
      recovered: 0,
      skipped: 0,
    },
    pending: [],
    writes: [],
    skipped: [],
  };
}

async function loadOrCreateLedger(
  path: string,
  fixtureHash: string,
  baseline: DryRunReport,
): Promise<ApplyLedger> {
  try {
    const ledger = await readJson<ApplyLedger>(path);
    if (
      ledger.schema_version !== 1 || ledger.mode !== "apply" ||
      ledger.fixture_sha256 !== fixtureHash
    ) {
      throw new Error("existing apply ledger does not match this fixture");
    }
    ledger.pending ||= [];
    ledger.summary.recovered ??= 0;
    return ledger;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return newLedger(fixtureHash, baseline);
    }
    throw error;
  }
}

async function apply(
  client: any,
  corrections: Correction[],
  fixtureHash: string,
  baselinePath: string,
  ledgerPath: string,
): Promise<ApplyLedger> {
  const baseline = await readJson<DryRunReport>(baselinePath);
  assertDryRunBaseline(baseline, fixtureHash);
  const ledger = await loadOrCreateLedger(ledgerPath, fixtureHash, baseline);
  const targets = await loadTargets(client, corrections);
  const evaluations = evaluateAll(corrections, targets);
  const evaluationsByKey = new Map(
    evaluations.map((evaluation) => [correctionKey(evaluation), evaluation]),
  );
  ledger.summary.recovered = 0;
  for (const pending of [...ledger.pending]) {
    const key = correctionKey(pending);
    const evaluation = evaluationsByKey.get(key);
    if (!evaluation) {
      throw new Error(`pending ledger row is not in fixture: ${key}`);
    }
    if (evaluation.observed_current === pending.after) {
      if (!ledger.writes.some((write) => correctionKey(write) === key)) {
        ledger.writes.push(pending);
        ledger.summary.recovered++;
      }
      ledger.pending = ledger.pending.filter((entry) =>
        correctionKey(entry) !== key
      );
      continue;
    }
    if (evaluation.observed_current !== pending.before) {
      throw new Error(
        `${pending.card} unresolved pending write now has ${evaluation.observed_current}`,
      );
    }
  }
  if (ledger.summary.recovered > 0) {
    ledger.updated_at = new Date().toISOString();
    ledger.summary.applied_total = ledger.writes.length;
    await writeJson(ledgerPath, ledger);
  }
  const writesByKey = new Map(
    ledger.writes.map((write) => [correctionKey(write), write]),
  );
  const alreadyAppliedKeys = new Set<string>();
  const freshSkipped = evaluations.filter((evaluation) => {
    const key = correctionKey(evaluation);
    const prior = writesByKey.get(key);
    if (prior && evaluation.observed_current === evaluation.after) {
      alreadyAppliedKeys.add(key);
      return false;
    }
    return !evaluation.eligible;
  });
  if (freshSkipped.length > MAX_SKIPS_BEFORE_APPLY) {
    throw new Error(
      `fresh apply preflight skipped ${freshSkipped.length}, above the ${MAX_SKIPS_BEFORE_APPLY}-card apply limit; no writes performed`,
    );
  }
  ledger.skipped = [];
  ledger.summary.applied_this_run = 0;
  ledger.summary.already_applied = alreadyAppliedKeys.size;
  for (let index = 0; index < corrections.length; index++) {
    const correction = corrections[index];
    const evaluation = evaluations[index];
    const key = correctionKey(correction);
    if (alreadyAppliedKeys.has(key)) continue;
    if (!evaluation.eligible || !evaluation.job_id) {
      ledger.skipped.push({
        card: correction.card,
        column: correction.column,
        expected_current: correction.current,
        observed_current: evaluation.observed_current,
        timestamp: new Date().toISOString(),
        reason: evaluation.reason || "not_eligible",
        job_id: evaluation.job_id,
        board_kind_before: evaluation.board_kind_before,
        board_kind_after: evaluation.board_kind_after,
      });
      continue;
    }
    const jobs = targets.jobsByCard.get(correction.card) || [];
    const details = targets.detailsByJob.get(evaluation.job_id) || [];
    const pending: LedgerPending = {
      card: correction.card,
      column: correction.column,
      before: correction.current,
      after: correction.after,
      timestamp: new Date().toISOString(),
      job_id: evaluation.job_id,
      board_kind_before: evaluation.board_kind_before!,
      board_kind_after: evaluation.board_kind_after!,
    };
    ledger.pending = ledger.pending.filter((entry) =>
      correctionKey(entry) !== key
    );
    ledger.pending.push(pending);
    ledger.updated_at = new Date().toISOString();
    await writeJson(ledgerPath, ledger);
    const updated = await conditionalUpdate(
      correction,
      jobs[0],
      details[0],
    );
    ledger.pending = ledger.pending.filter((entry) =>
      correctionKey(entry) !== key
    );
    if (!updated) {
      ledger.skipped.push({
        card: correction.card,
        column: correction.column,
        expected_current: correction.current,
        observed_current: evaluation.observed_current,
        timestamp: new Date().toISOString(),
        reason: "compare_and_set_miss",
        job_id: evaluation.job_id,
        board_kind_before: evaluation.board_kind_before,
        board_kind_after: evaluation.board_kind_after,
      });
    } else {
      ledger.writes.push(pending);
      writesByKey.set(key, pending);
      ledger.summary.applied_this_run++;
    }
    ledger.updated_at = new Date().toISOString();
    ledger.summary.applied_total = ledger.writes.length;
    ledger.summary.skipped = ledger.skipped.length;
    await writeJson(ledgerPath, ledger);
  }
  ledger.updated_at = new Date().toISOString();
  ledger.summary.applied_total = ledger.writes.length;
  ledger.summary.skipped = ledger.skipped.length;
  await writeJson(ledgerPath, ledger);
  printSummary(ledger.mode, ledger.summary);
  return ledger;
}

async function verify(
  client: any,
  corrections: Correction[],
  fixtureHash: string,
  baselinePath: string,
  ledgerPath: string,
  outputPath: string,
): Promise<boolean> {
  const baseline = await readJson<DryRunReport>(baselinePath);
  assertDryRunBaseline(baseline, fixtureHash);
  const ledger = await readJson<ApplyLedger>(ledgerPath);
  if (ledger.fixture_sha256 !== fixtureHash) {
    throw new Error("apply ledger does not match this fixture");
  }
  const writesByKey = new Map(
    ledger.writes.map((write) => [correctionKey(write), write]),
  );
  const skipsByKey = new Map(
    ledger.skipped.map((skip) => [correctionKey(skip), skip]),
  );
  const baselineByKey = new Map(
    baseline.entries.map((entry) => [correctionKey(entry), entry]),
  );
  const evaluations = evaluateAll(
    corrections,
    await loadTargets(client, corrections),
  );
  const entries = evaluations.map((evaluation) => {
    const key = correctionKey(evaluation);
    const write = writesByKey.get(key);
    const skip = skipsByKey.get(key);
    const before = baselineByKey.get(key);
    const finalStateOk = write
      ? evaluation.observed_current === write.after
      : skip
      ? evaluation.observed_current === skip.observed_current
      : false;
    const boardKindUnchanged =
      before?.board_kind_before === evaluation.board_kind_before;
    return {
      card: evaluation.card,
      column: evaluation.column,
      expected_final: write?.after ?? skip?.observed_current ?? null,
      observed_final: evaluation.observed_current,
      ledger_status: write ? "applied" : skip ? "skipped" : "unaccounted",
      final_state_ok: finalStateOk,
      board_kind_before: before?.board_kind_before ?? null,
      board_kind_after: evaluation.board_kind_before,
      board_kind_unchanged: boardKindUnchanged,
    };
  });
  const projectionHealth = await runProjectionComparison(client);
  const stateFailures = entries.filter((entry) => !entry.final_state_ok).length;
  const boardKindChanges =
    entries.filter((entry) => !entry.board_kind_unchanged).length;
  const projectionErrorsBefore =
    baseline.projection_health.projection_input_error_job_count;
  const projectionErrorsAfter =
    projectionHealth.projection_input_error_job_count;
  const projectionErrorsDidNotIncrease =
    projectionErrorsAfter <= projectionErrorsBefore;
  const projectionComplete = projectionHealthComplete(projectionHealth);
  const success = stateFailures === 0 && boardKindChanges === 0 &&
    projectionErrorsDidNotIncrease && projectionComplete &&
    (ledger.pending || []).length === 0 &&
    entries.length === EXPECTED_CORRECTION_COUNT;
  const report = {
    schema_version: 1,
    mode: "verify",
    generated_at: new Date().toISOString(),
    fixture_sha256: fixtureHash,
    fixture_count: corrections.length,
    summary: {
      applied: ledger.writes.length,
      skipped: ledger.skipped.length,
      pending: (ledger.pending || []).length,
      state_failures: stateFailures,
      board_kind_changes: boardKindChanges,
      projection_errors_before: projectionErrorsBefore,
      projection_errors_after: projectionErrorsAfter,
      projection_errors_did_not_increase: projectionErrorsDidNotIncrease,
      projection_complete: projectionComplete,
      success,
    },
    projection_health: projectionHealth,
    entries,
  };
  await writeJson(outputPath, report);
  printSummary(report.mode, report.summary);
  return success;
}

async function main(): Promise<void> {
  validateArgs(Deno.args);
  if (Deno.args.includes("--help")) {
    printHelp();
    return;
  }
  const mode = option("--mode") || "dry-run";
  if (!["dry-run", "apply", "verify"].includes(mode)) {
    throw new Error(`unsupported --mode ${mode}`);
  }
  const fixtureText = await Deno.readTextFile(FIXTURE_URL);
  const corrections = parseFixture(fixtureText);
  const fixtureHash = await sha256(fixtureText);
  const baselinePath = option("--baseline") || pathFromUrl(DEFAULT_DRY_RUN_URL);
  const ledgerPath = option("--ledger") || pathFromUrl(DEFAULT_LEDGER_URL);
  if (mode === "dry-run") {
    const outputPath = option("--output") || baselinePath;
    if (
      await fileExists(outputPath) && !Deno.args.includes("--overwrite-output")
    ) {
      throw new Error(
        `refusing to overwrite dry-run evidence ${outputPath}; choose a new --output path`,
      );
    }
    const client = await createClient();
    const report = await dryRun(
      client,
      corrections,
      fixtureHash,
      outputPath,
    );
    if (!report.summary.apply_allowed) Deno.exitCode = 2;
    return;
  }
  if (mode === "apply") {
    const client = await createClient();
    await apply(client, corrections, fixtureHash, baselinePath, ledgerPath);
    return;
  }
  const client = await createClient();
  const outputPath = option("--output") || pathFromUrl(DEFAULT_VERIFY_URL);
  const success = await verify(
    client,
    corrections,
    fixtureHash,
    baselinePath,
    ledgerPath,
    outputPath,
  );
  if (!success) Deno.exitCode = 1;
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(
      `error: ${
        JSON.stringify(message)
      }\nhelp[1]:\n  Run scripts/apply-board-safe-fixes-v1.ts --help`,
    );
    Deno.exitCode = error instanceof UsageError ? 2 : 1;
  }
}
