#!/usr/bin/env -S deno run --allow-env --allow-net --allow-read --allow-write --allow-run
// deno-lint-ignore-file no-explicit-any
/**
 * SES Phase C3 tranche 1 — re-attach the identity-verified builder work-order
 * artifacts for the closed tier-A card set.
 *
 * Scope is EXACTLY the fixture in `scripts/ses-c3-wo-backfill-v1.fixture.txt`:
 * the 26 board cards whose missing work-order PDF still has a servable artifact
 * in the private `makesafe-emails` bucket that is bound to the card's OWN
 * intake case and identity-verified server-side (the C2 report's recoverable
 * class A). The 30 reference/subject-matched cards (tiers B and C) are NOT in
 * this fixture; they need per-card Captain adjudication in a later tranche.
 *
 * The fixture is closed and hand-adjudicated. This script has no discovery
 * step by design: no card a human did not adjudicate can be written by it.
 *
 * Transport split, by design:
 * - every READ goes through the Supabase Management API with `read_only: true`,
 *   so a read can never mutate;
 * - the WRITE is the sanctioned ops-api `attach_email_attachment_to_job`
 *   action, which copies the private bytes server-side into the public
 *   `job-documents` bucket and then delegates to `attachMakesafeDocument` so
 *   the typed row, idempotency, visibility and ledger behaviour are identical
 *   to every other typed attach. The source `email_attachments` row and its
 *   `makesafe-emails` object are never moved, renamed or deleted;
 * - the provenance stamp is a single guarded compare-and-set UPDATE against the
 *   `job_documents` row this run created, and nothing else.
 *
 * This script never moves a board stage, never touches `jobs`, never sends a
 * communication, and writes no evidence type other than `work_order`.
 */

import { assertReportPrivacy } from "./ses-evidence-stage-checker.ts";

const PROJECT_REF = "kevgrhcjxspbxgovpmfl";
const FUNCTIONS_BASE = `https://${PROJECT_REF}.supabase.co/functions/v1`;
const MANAGEMENT_QUERY_URL =
  `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;
const SOURCE_BUCKET = "makesafe-emails";
const TARGET_BUCKET = "job-documents";
const DOCUMENT_TYPE = "work_order";

export const RUN_LABEL = "ses-c3-wo-backfill-tranche1-v1";
export const PROVENANCE_NOTE =
  "SES Phase C3 tranche 1 work-order re-attach; source C2 measurement 2026-08-01, captain phase-C plan";
export const DEFAULT_FIXTURE_PATH = "scripts/ses-c3-wo-backfill-v1.fixture.txt";

const BOOLEAN_FLAGS = new Set([
  "--help",
  "-h",
  "--overwrite-output",
  "--check-bytes",
]);
const VALUE_FLAGS = new Set([
  "--mode",
  "--fixture",
  "--output",
  "--baseline",
  "--ledger",
  "--resume",
  "--before",
  "--after",
]);
const MODES = ["measure", "dry-run", "apply", "verify"] as const;
type Mode = typeof MODES[number];

class UsageError extends Error {}

export interface FixtureRow {
  card: string;
  jobId: string;
  caseId: string;
  builderWoCanonical: string;
  attachmentId: string;
  sha256: string;
  fileName: string;
}

export interface CardState {
  card: string;
  job_found: boolean;
  job_status: string | null;
  job_archived: boolean | null;
  job_updated_at: string | null;
  case_bound: boolean;
  attachment_found: boolean;
  attachment_status: string | null;
  attachment_sha256: string | null;
  attachment_name: string | null;
  attachment_purged: boolean | null;
  attachment_storage_path: string | null;
  source_object_present: boolean;
  identity_text_matches: boolean;
  work_order_docs: number;
  work_order_docs_with_url: number;
  status_applications: number;
}

export interface EligibilityVerdict {
  eligible: boolean;
  reason: string | null;
}

export interface ResumeDocumentRow {
  id: string;
  job_id: string;
  type: string;
  run_label: string | null;
  file_name: string;
  storage_url: string;
}

export function authorizeResumeStamp(
  entry: any,
  row: FixtureRow,
  live: ResumeDocumentRow | null,
): { authorized: true; documentId: string } | { authorized: false; reason: string } {
  if (!entry || typeof entry.document_id !== "string") {
    return { authorized: false, reason: "resume_no_prior_ledger_entry" };
  }
  if (!live) return { authorized: false, reason: "resume_document_row_missing" };
  if (live.id !== entry.document_id) {
    return { authorized: false, reason: "resume_document_id_mismatch" };
  }
  if (live.job_id !== row.jobId) {
    return { authorized: false, reason: "resume_document_wrong_job" };
  }
  if (live.type !== DOCUMENT_TYPE) {
    return { authorized: false, reason: "resume_document_wrong_type" };
  }
  if (live.run_label !== null) {
    return { authorized: false, reason: "resume_document_already_stamped" };
  }
  if (live.file_name !== entry.file_name) {
    return { authorized: false, reason: "resume_document_file_name_changed" };
  }
  if (live.storage_url !== entry.storage_url) {
    return { authorized: false, reason: "resume_document_storage_url_changed" };
  }
  return { authorized: true, documentId: live.id };
}

/** Parse the closed fixture. Comment and blank lines are ignored. */
export function parseFixture(text: string): FixtureRow[] {
  const rows: FixtureRow[] = [];
  const seenCards = new Set<string>();
  const seenAttachments = new Set<string>();
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index].trim();
    if (!raw || raw.startsWith("#")) continue;
    const parts = raw.split("|");
    if (parts.length !== 7) {
      throw new Error(
        `fixture line ${index + 1} has ${parts.length} fields, expected 7`,
      );
    }
    const [
      card,
      jobId,
      caseId,
      builderWoCanonical,
      attachmentId,
      sha256,
      fileName,
    ] = parts.map((value) => value.trim());
    if (!card || !jobId || !caseId || !attachmentId || !sha256 || !fileName) {
      throw new Error(`fixture line ${index + 1} has an empty field`);
    }
    if (!/^[0-9a-f]{64}$/i.test(sha256)) {
      throw new Error(`fixture line ${index + 1} has a malformed sha256`);
    }
    if (seenCards.has(card)) {
      throw new Error(`fixture line ${index + 1} repeats card ${card}`);
    }
    if (seenAttachments.has(attachmentId)) {
      throw new Error(
        `fixture line ${index + 1} repeats attachment ${attachmentId}`,
      );
    }
    seenCards.add(card);
    seenAttachments.add(attachmentId);
    rows.push({
      card,
      jobId,
      caseId,
      builderWoCanonical,
      attachmentId,
      sha256,
      fileName,
    });
  }
  if (!rows.length) throw new Error("fixture is empty");
  return rows;
}

/**
 * The eligibility rule, pure so it is testable without production.
 *
 * A card is written only when every leg of the C2 tier-A claim still holds AND
 * the card is still in the exact state the dry run recorded. Anything else is
 * skipped with a reason — never forced.
 */
export function evaluateEligibility(
  row: FixtureRow,
  state: CardState,
): EligibilityVerdict {
  const refuse = (reason: string) => ({ eligible: false, reason });
  if (!state.job_found) return refuse("job_missing");
  if (!state.case_bound) return refuse("attachment_not_bound_to_card_case");
  if (!state.attachment_found) return refuse("attachment_missing");
  if (state.attachment_purged) return refuse("attachment_pii_purged");
  if (state.attachment_status !== "uploaded") {
    return refuse(`attachment_status_${state.attachment_status || "unknown"}`);
  }
  if (
    (state.attachment_sha256 || "").toLowerCase() !== row.sha256.toLowerCase()
  ) {
    return refuse("attachment_sha256_drift");
  }
  if ((state.attachment_name || "") !== row.fileName) {
    return refuse("attachment_name_drift");
  }
  if (!state.source_object_present) return refuse("source_object_missing");
  if (!state.identity_text_matches) return refuse("identity_text_mismatch");
  if (state.work_order_docs_with_url > 0) {
    return refuse("work_order_already_present");
  }
  if (state.work_order_docs > 0) {
    return refuse("work_order_row_exists_without_url");
  }
  return { eligible: true, reason: null };
}

/** The pure state comparison the apply re-check uses against the dry-run baseline. */
export function stateMatchesBaseline(
  baseline: CardState,
  current: CardState,
): { matches: boolean; drifted: string[] } {
  const keys: (keyof CardState)[] = [
    "job_found",
    "job_status",
    "job_archived",
    "job_updated_at",
    "case_bound",
    "attachment_found",
    "attachment_status",
    "attachment_sha256",
    "attachment_name",
    "attachment_purged",
    "attachment_storage_path",
    "source_object_present",
    "identity_text_matches",
    "work_order_docs",
    "work_order_docs_with_url",
    "status_applications",
  ];
  const drifted = keys.filter((key) => baseline[key] !== current[key]).map(
    String,
  );
  return { matches: drifted.length === 0, drifted };
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function sqlText(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function sqlUuidList(values: readonly string[]): string {
  return values.map((value) => `${sqlText(value)}::uuid`).join(",");
}

async function managementQuery(
  query: string,
  options: { readOnly?: boolean } = {},
): Promise<any[]> {
  const accessToken = requiredEnv("SUPABASE_ACCESS_TOKEN");
  const response = await fetch(MANAGEMENT_QUERY_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "User-Agent": "SecureWorks-SES-C3-WO-Backfill/1.0",
    },
    body: JSON.stringify({
      query,
      read_only: options.readOnly !== false,
    }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload && typeof payload === "object" &&
        "message" in payload
      ? String((payload as { message: unknown }).message)
      : JSON.stringify(payload);
    throw new Error(`management query HTTP ${response.status}: ${message}`);
  }
  if (!Array.isArray(payload)) {
    throw new Error("management query returned a non-row payload");
  }
  return payload;
}

/**
 * Load the live state of every fixture card in one read-only statement.
 *
 * Every predicate the tier-A claim rests on is recomputed here from production
 * rather than trusted from the C2 report: the attachment must still be reachable
 * from THIS card's intake case, its extracted PDF text must still name the
 * card's own canonical builder work-order digits, and its storage object must
 * still resolve in the private bucket.
 */
async function loadCardStates(
  rows: readonly FixtureRow[],
): Promise<Map<string, CardState>> {
  const pairs = rows.map((row) =>
    `(${sqlText(row.card)},${sqlText(row.jobId)}::uuid,${sqlText(row.caseId)}::uuid,${
      sqlText(row.attachmentId)
    }::uuid,${sqlText(row.builderWoCanonical)},${sqlText(row.fileName)})`
  ).join(",");
  const query = `
with fixture(card, job_id, case_id, attachment_id, wo_canonical, file_name) as (values ${pairs})
select f.card,
       (j.id is not null) as job_found,
       j.status as job_status,
       j.archived as job_archived,
       j.updated_at::text as job_updated_at,
       exists (
         select 1 from makesafe_intake_cases c
         join makesafe_intake_case_sources s on s.case_id = c.id
         where c.id = f.case_id
           and c.job_id = f.job_id
           and f.attachment_id = any(coalesce(s.attachment_refs, '{}'::uuid[]))
       ) as case_bound,
       (ea.id is not null) as attachment_found,
       ea.status as attachment_status,
       ea.sha256 as attachment_sha256,
       ea.name as attachment_name,
       (ea.pii_purged_at is not null) as attachment_purged,
       ea.storage_path as attachment_storage_path,
       exists (
         select 1 from storage.objects o
         where o.bucket_id = ${sqlText(SOURCE_BUCKET)}
           and o.name = ea.storage_path
       ) as source_object_present,
       (
         ea.pdf_extraction_text is not null
         and regexp_replace(coalesce(f.wo_canonical, ''), '\\D', '', 'g') <> ''
         and position(
           regexp_replace(coalesce(f.wo_canonical, ''), '\\D', '', 'g')
           in ea.pdf_extraction_text
         ) > 0
       ) as identity_text_matches,
       (select count(*)::int from job_documents d
         where d.job_id = f.job_id and d.type = ${sqlText(DOCUMENT_TYPE)}
       ) as work_order_docs,
       (select count(*)::int from job_documents d
         where d.job_id = f.job_id and d.type = ${sqlText(DOCUMENT_TYPE)}
           and coalesce(d.storage_url, '') <> ''
       ) as work_order_docs_with_url,
       (select count(*)::int from makesafe_board_status_applications a
         where a.job_id = f.job_id
       ) as status_applications,

from fixture f
left join jobs j on j.id = f.job_id and j.job_number = f.card
left join email_attachments ea on ea.id = f.attachment_id
order by f.card;`;
  const data = await managementQuery(query, { readOnly: true });
  const states = new Map<string, CardState>();
  for (const raw of data) {
    states.set(String(raw.card), {
      card: String(raw.card),
      job_found: raw.job_found === true,
      job_status: raw.job_status ?? null,
      job_archived: raw.job_archived ?? null,
      job_updated_at: raw.job_updated_at ?? null,
      case_bound: raw.case_bound === true,
      attachment_found: raw.attachment_found === true,
      attachment_status: raw.attachment_status ?? null,
      attachment_sha256: raw.attachment_sha256 ?? null,
      attachment_name: raw.attachment_name ?? null,
      attachment_purged: raw.attachment_purged ?? null,
      attachment_storage_path: raw.attachment_storage_path ?? null,
      source_object_present: raw.source_object_present === true,
      identity_text_matches: raw.identity_text_matches === true,
      work_order_docs: Number(raw.work_order_docs || 0),
      work_order_docs_with_url: Number(raw.work_order_docs_with_url || 0),
      status_applications: Number(raw.status_applications || 0),
    });
  }
  for (const row of rows) {
    if (!states.has(row.card)) {
      throw new Error(`state read returned no row for ${row.card}`);
    }
  }
  return states;
}

interface AttachedDocRow {
  card: string;
  document_id: string;
  file_name: string;
  storage_url: string;
  pdf_url: string | null;
  visible_to_trades: boolean | null;
  run_label: string | null;
  version: number | null;
  created_at: string | null;
  target_object_present: boolean;
}

/** Read back the work-order rows this run is responsible for. */
async function loadAttachedDocs(
  rows: readonly FixtureRow[],
): Promise<Map<string, AttachedDocRow[]>> {
  const jobIds = rows.map((row) => row.jobId);
  const query = `
select j.job_number as card,
       d.id::text as document_id,
       d.file_name,
       coalesce(d.storage_url, '') as storage_url,
       d.pdf_url,
       d.visible_to_trades,
       d.run_label,
       d.version,
       d.created_at::text as created_at,
       exists (
         select 1 from storage.objects o
         where o.bucket_id = ${sqlText(TARGET_BUCKET)}
           and position(o.name in coalesce(d.storage_url, '')) > 0
       ) as target_object_present
from job_documents d
join jobs j on j.id = d.job_id
where d.job_id in (${sqlUuidList(jobIds)})
  and d.type = ${sqlText(DOCUMENT_TYPE)}
order by j.job_number, d.created_at;`;
  const data = await managementQuery(query, { readOnly: true });
  const byCard = new Map<string, AttachedDocRow[]>();
  for (const raw of data) {
    const card = String(raw.card);
    const list = byCard.get(card) || [];
    list.push({
      card,
      document_id: String(raw.document_id),
      file_name: String(raw.file_name || ""),
      storage_url: String(raw.storage_url || ""),
      pdf_url: raw.pdf_url ?? null,
      visible_to_trades: raw.visible_to_trades ?? null,
      run_label: raw.run_label ?? null,
      version: raw.version ?? null,
      created_at: raw.created_at ?? null,
      target_object_present: raw.target_object_present === true,
    });
    byCard.set(card, list);
  }
  return byCard;
}

/**
 * Attach one work order through the sanctioned ops-api action.
 *
 * `attach_email_attachment_to_job` re-hosts a COPY of the private bytes; the
 * `email_attachments` row and its `makesafe-emails` object are left untouched.
 */
async function attachWorkOrder(
  row: FixtureRow,
): Promise<{ documentId: string; url: string; raw: any }> {
  const apiKey = requiredEnv("SW_API_KEY");
  const response = await fetch(
    `${FUNCTIONS_BASE}/ops-api?action=attach_email_attachment_to_job`,
    {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        job_id: row.jobId,
        email_attachment_id: row.attachmentId,
        type: DOCUMENT_TYPE,
        file_name: row.fileName,
        operator_email: `${RUN_LABEL} (${PROVENANCE_NOTE})`,
      }),
    },
  );
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.success || !payload?.document_id) {
    throw new Error(
      `${row.card} attach failed HTTP ${response.status}: ${
        JSON.stringify(payload)
      }`,
    );
  }
  return {
    documentId: String(payload.document_id),
    url: String(payload.url || ""),
    raw: payload,
  };
}

/**
 * Stamp provenance on the row this run just created.
 *
 * Guarded compare-and-set: the update names the exact document id, requires the
 * row to still be the untagged `work_order` row on the expected job, and
 * returns the stamped row so a zero-row result is a loud failure rather than a
 * silent no-op.
 */
async function stampProvenance(
  row: FixtureRow,
  documentId: string,
): Promise<boolean> {
  const provenance = {
    run_label: RUN_LABEL,
    note: PROVENANCE_NOTE,
    source: "data/ses-c2-evidence-measure-v1/report.md#3.3 recoverable class A",
    source_bucket: SOURCE_BUCKET,
    source_email_attachment_id: row.attachmentId,
    source_sha256: row.sha256,
    intake_case_id: row.caseId,
    builder_wo_canonical: row.builderWoCanonical,
  };
  const query = `
with stamped as (
  update public.job_documents d
  set run_label = ${sqlText(RUN_LABEL)},
      metadata = coalesce(d.metadata, '{}'::jsonb) || ${
    sqlText(JSON.stringify(provenance))
  }::jsonb
  where d.id = ${sqlText(documentId)}::uuid
    and d.job_id = ${sqlText(row.jobId)}::uuid
    and d.type = ${sqlText(DOCUMENT_TYPE)}
    and d.run_label is null
  returning d.id
)
select id::text as id from stamped;`;
  const data = await managementQuery(query, { readOnly: false });
  return data.length === 1 && String(data[0]?.id) === documentId;
}

async function resumeDocumentId(
  row: FixtureRow,
  entry: any,
): Promise<ReturnType<typeof authorizeResumeStamp>> {
  const documentId = typeof entry?.document_id === "string"
    ? entry.document_id
    : null;
  if (!documentId) return authorizeResumeStamp(entry, row, null);
  const data = await managementQuery(`
select id::text as id, job_id::text as job_id, type, run_label,
       file_name, storage_url
from public.job_documents
where id = ${sqlText(documentId)}::uuid
;`, { readOnly: true });
  const live = data.length === 1
    ? {
      id: String(data[0].id),
      job_id: String(data[0].job_id),
      type: String(data[0].type),
      run_label: data[0].run_label ?? null,
      file_name: String(data[0].file_name),
      storage_url: String(data[0].storage_url),
    }
    : null;
  const verdict = authorizeResumeStamp(entry, row, live);
  return verdict;
}

/**
 * Fetch the published copy and hash it.
 *
 * The strongest available proof that the re-attach preserved the artifact: the
 * public `job-documents` URL must serve bytes whose sha256 equals the sha256
 * the intake recorded for the private source attachment.
 */
async function publishedSha256(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`document fetch HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

interface MeasureSummary {
  card: string;
  stage: string | null;
  stage_source: string | null;
  computed_stage: string | null;
  display_overlay_stage: string | null;
  verdict: string | null;
  builder_wo_doc_present: boolean;
  builder_wo_doc_detail: string | null;
}

/**
 * Run the C1 measure entrypoint (`scripts/ses-measure-card-evidence.ts`) once
 * per card and keep only the fields this backfill is accountable for. The
 * entrypoint is invoked as a subprocess deliberately: it is the shipped C1
 * contract, and shelling out to it means this script cannot accidentally
 * measure with a private re-implementation.
 */
async function measureCards(
  rows: readonly FixtureRow[],
): Promise<MeasureSummary[]> {
  const out: MeasureSummary[] = [];
  for (const row of rows) {
    const command = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-env",
        "--allow-net",
        "--allow-read",
        "scripts/ses-measure-card-evidence.ts",
        "--job",
        row.card,
        "--json",
      ],
      stdout: "piped",
      stderr: "piped",
    });
    const result = await command.output();
    const stdout = new TextDecoder().decode(result.stdout);
    if (!result.success) {
      const stderr = new TextDecoder().decode(result.stderr);
      throw new Error(`${row.card} C1 measure failed: ${stderr.trim()}`);
    }
    const parsed = JSON.parse(stdout);
    const item = parsed?.inventory?.builder_wo_doc || {};
    out.push({
      card: row.card,
      stage: parsed?.stage ?? null,
      stage_source: parsed?.stage_source ?? null,
      computed_stage: parsed?.computed_stage ?? null,
      display_overlay_stage: parsed?.display_overlay_stage ?? null,
      verdict: parsed?.reading?.verdict ?? null,
      builder_wo_doc_present: item?.present === true,
      builder_wo_doc_detail: item?.detail ?? null,
    });
  }
  return out;
}

async function readJson(path: string): Promise<any> {
  return JSON.parse(await Deno.readTextFile(path));
}

async function writeEvidence(
  path: string,
  payload: unknown,
  overwrite: boolean,
): Promise<void> {
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  assertReportPrivacy(text);
  if (!overwrite) {
    try {
      await Deno.stat(path);
      throw new UsageError(
        `${path} already exists; pass --overwrite-output to replace it`,
      );
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  await Deno.writeTextFile(path, text);
}

function printHelp(): void {
  console.log(
    `description: Re-attach the identity-verified tier-A builder work-order PDFs (SES Phase C3 tranche 1)
default_mode: dry-run
flags[9]{name,meaning}:
  --mode,"measure, dry-run, apply, or verify"
  --fixture,"closed card fixture (default ${DEFAULT_FIXTURE_PATH})"
  --output,"evidence output path for measure, dry-run or verify"
  --baseline,"immutable dry-run JSON path"
  --ledger,"apply ledger JSON path"
  --before,"pre-apply C1 measure JSON (verify)"
  --after,"post-apply C1 measure JSON (verify)"
  --overwrite-output,"allow replacing an existing evidence file"
  --check-bytes,"verify fetches each published copy and re-hashes it (verify)"
environment[3]{name,required_for}:
  SUPABASE_ACCESS_TOKEN,"measure, dry-run, apply, verify"
  SW_API_KEY,apply
  SUPABASE_SERVICE_ROLE_KEY,"measure (read by the C1 entrypoint)"
examples[4]:
  "scripts/apply-ses-c3-wo-backfill-v1.ts --mode measure --output <c1-before.json>"
  "scripts/apply-ses-c3-wo-backfill-v1.ts --mode dry-run --output <dry-run.json>"
  "scripts/apply-ses-c3-wo-backfill-v1.ts --mode apply --baseline <dry-run.json> --ledger <ledger.json>"
  "scripts/apply-ses-c3-wo-backfill-v1.ts --mode verify --baseline <dry-run.json> --ledger <ledger.json> --before <c1-before.json> --after <c1-after.json> --output <verify.json>"`,
  );
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

function option(args: string[], name: string): string | null {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === name) return args[index + 1] ?? null;
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return null;
}

function flag(args: string[], name: string): boolean {
  return args.includes(name);
}

export function parseMode(value: string | null): Mode {
  const mode = (value || "dry-run") as Mode;
  if (!MODES.includes(mode)) {
    throw new UsageError(`--mode must be one of ${MODES.join(", ")}`);
  }
  return mode;
}

function summarise(mode: string, summary: Record<string, unknown>): void {
  console.log(
    [
      `mode: ${mode}`,
      ...Object.entries(summary).map(([key, value]) => `${key}: ${value}`),
    ].join("\n"),
  );
}

async function runMeasure(
  rows: readonly FixtureRow[],
  outputPath: string,
  overwrite: boolean,
): Promise<void> {
  const measurements = await measureCards(rows);
  await writeEvidence(outputPath, {
    run_label: RUN_LABEL,
    mode: "measure",
    contract: "scripts/ses-measure-card-evidence.ts --json",
    cards: measurements,
  }, overwrite);
  summarise("measure", {
    cards: measurements.length,
    builder_wo_doc_present: measurements.filter((m) => m.builder_wo_doc_present)
      .length,
  });
}

async function runDryRun(
  rows: readonly FixtureRow[],
  outputPath: string,
  overwrite: boolean,
): Promise<void> {
  const plan = rows.map((row) => {
    const state = states.get(row.card)!;
    const verdict = evaluateEligibility(row, state);
    return {
      card: row.card,
      job_id: row.jobId,
      intake_case_id: row.caseId,
      builder_wo_canonical: row.builderWoCanonical,
      source: {
        email_attachment_id: row.attachmentId,
        sha256: row.sha256,
        bucket: SOURCE_BUCKET,
        storage_path: state.attachment_storage_path,
        disposition: "copied, never moved or deleted",
      },
      planned_row: {
        table: "job_documents",
        job_id: row.jobId,
        type: DOCUMENT_TYPE,
        file_name: row.fileName,
        storage_url: `${TARGET_BUCKET} public URL for ${row.jobId}/${
          row.fileName.replace(/[^a-zA-Z0-9._-]/g, "_")
        }`,
        visible_to_trades: true,
        run_label: RUN_LABEL,
        provenance_note: PROVENANCE_NOTE,
      },
      before: state,
      eligible: verdict.eligible,
      reason: verdict.reason,
    };
  });
  await writeEvidence(outputPath, {
    run_label: RUN_LABEL,
    mode: "dry-run",
    project_ref: PROJECT_REF,
    fixture_cards: rows.length,
    eligible: plan.filter((entry) => entry.eligible).length,
    skipped: plan.filter((entry) => !entry.eligible).length,
    cards: plan,
  }, overwrite);
  summarise("dry-run", {
    cards: plan.length,
    eligible: plan.filter((entry) => entry.eligible).length,
    skipped: plan.filter((entry) => !entry.eligible).length,
  });
}

async function runApply(
  rows: readonly FixtureRow[],
  baselinePath: string,
  ledgerPath: string,
  resumePath: string | null,
): Promise<void> {
  const baseline = await readJson(baselinePath);
  if (baseline?.run_label !== RUN_LABEL || baseline?.mode !== "dry-run") {
    throw new UsageError(`${baselinePath} is not this run's dry-run baseline`);
  }
  const baselineByCard = new Map<string, any>(
    (baseline.cards || []).map((entry: any) => [String(entry.card), entry]),
  );
  const resumeByCard = new Map<string, any>();
  if (resumePath) {
    const resume = await readJson(resumePath);
    for (const entry of resume?.cards || []) {
      resumeByCard.set(String(entry.card), entry);
    }
  }
  const ledger: any[] = [];
  let applied = 0;
  let skipped = 0;
  const flush = async () => {
    await Deno.writeTextFile(
      ledgerPath,
      `${
        JSON.stringify(
          {
            run_label: RUN_LABEL,
            mode: "apply",
            project_ref: PROJECT_REF,
            baseline: baselinePath,
            applied,
            skipped,
            cards: ledger,
          },
          null,
          2,
        )
      }\n`,
    );
  };

  for (const row of rows) {
    // The bulk read is only a pre-pass. Authorization for each write uses a
    // fresh single-card read so concurrent drift is always observed.
    const state = await loadCardStates([row]).then((live) => live.get(row.card)!);
    const planned = baselineByCard.get(row.card);
    const record: any = {
      card: row.card,
      job_id: row.jobId,
      before: state,
      after: null,
      outcome: "skipped",
      reason: null as string | null,
      document_id: null as string | null,
      storage_url: null as string | null,
      provenance_stamped: false,
    };
    if (!planned) {
      record.reason = "card_absent_from_baseline";
    } else if (!planned.eligible) {
      record.reason = `baseline_skipped_${planned.reason}`;
    } else {
      const drift = stateMatchesBaseline(planned.before as CardState, state);
      const verdict = evaluateEligibility(row, state);
      const resumeEntry = resumeByCard.get(row.card);
      const onlyDocumentDrift = drift.drifted.every((key) =>
        key === "work_order_docs" || key === "work_order_docs_with_url"
      );
      const resumableStamp = Boolean(
        resumeEntry && onlyDocumentDrift &&
          verdict.reason === "work_order_already_present",
      );
      const resumeRefusal = resumePath && onlyDocumentDrift &&
        verdict.reason === "work_order_already_present"
        ? await resumeDocumentId(row, resumeEntry)
        : null;
      if (resumableStamp && resumeRefusal?.authorized) {
        const documentId = resumeRefusal.documentId;
        record.document_id = documentId;
        try {
          record.provenance_stamped = await stampProvenanceWithRetry(
            row,
            documentId,
          );
          record.outcome = "applied";
          record.reason = "resumed_provenance_stamp";
          applied++;
        } catch (error) {
          record.outcome = "resumable";
          record.reason = error instanceof Error ? error.message : String(error);
          ledger.push(record);
          await flush();
          throw new Error(`${row.card} apply failed: ${record.reason}`);
        }
      } else if (resumeRefusal && !resumeRefusal.authorized) {
        record.reason = resumeRefusal.reason;
      } else if (!drift.matches) {
        record.reason = `state_changed_since_dry_run:${
          drift.drifted.join(",")
        }`;
      } else if (!verdict.eligible) {
        record.reason = verdict.reason;
      } else {
        // A failure is recorded and flushed BEFORE the run aborts, so the
        // ledger is never quieter than reality about a half-done card.
        try {
          const attached = await attachWorkOrder(row);
          record.document_id = attached.documentId;
          record.storage_url = attached.url;
          record.provenance_stamped = await stampProvenanceWithRetry(row, attached.documentId);
          if (!record.provenance_stamped) {
            throw new Error(
              `provenance stamp did not match exactly one row (document ${attached.documentId})`,
            );
          }
          record.outcome = "applied";
          applied++;
        } catch (error) {
          record.outcome = "failed";
          record.reason = error instanceof Error
            ? error.message
            : String(error);
          if (record.reason.startsWith("provenance stamp resumable")) {
            record.outcome = "resumable";
          }
          ledger.push(record);
          await flush();
          throw new Error(`${row.card} apply failed: ${record.reason}`);
        }
      }
    }
    if (record.outcome === "skipped") skipped++;
    ledger.push(record);
    await flush();
  }

  const afterStates = await loadCardStates(rows);
  for (const record of ledger) {
    record.after = afterStates.get(record.card) || null;
  }
  await flush();
  summarise("apply", { cards: ledger.length, applied, skipped });
}

async function stampProvenanceWithRetry(
  row: FixtureRow,
  documentId: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (await stampProvenance(row, documentId)) return true;
  }
  throw new Error(
    `provenance stamp resumable after attach (document ${documentId})`,
  );
}

async function runVerify(
  rows: readonly FixtureRow[],
  baselinePath: string,
  ledgerPath: string,
  beforePath: string,
  afterPath: string,
  outputPath: string,
  overwrite: boolean,
  checkBytes: boolean,
): Promise<void> {
  const baseline = await readJson(baselinePath);
  const ledgerFile = await readJson(ledgerPath);
  const beforeFile = await readJson(beforePath);
  const afterFile = await readJson(afterPath);
  const baselineByCard = new Map<string, any>(
    (baseline.cards || []).map((e: any) => [String(e.card), e]),
  );
  const ledgerByCard = new Map<string, any>(
    (ledgerFile.cards || []).map((e: any) => [String(e.card), e]),
  );
  const beforeByCard = new Map<string, MeasureSummary>(
    (beforeFile.cards || []).map((e: any) => [String(e.card), e]),
  );
  const afterByCard = new Map<string, MeasureSummary>(
    (afterFile.cards || []).map((e: any) => [String(e.card), e]),
  );

  const states = await loadCardStates(rows);
  const docs = await loadAttachedDocs(rows);
  const results: any[] = [];
  let failures = 0;

  for (const row of rows) {
    const state = states.get(row.card)!;
    const planned = baselineByCard.get(row.card);
    const applied = ledgerByCard.get(row.card);
    const before = beforeByCard.get(row.card);
    const after = afterByCard.get(row.card);
    const cardDocs = docs.get(row.card) || [];
    const problems: string[] = [];
    let publishedHash: string | null = null;

    if (!before || !after) problems.push("c1_measurement_missing");
    if (!applied) problems.push("ledger_entry_missing");

    if (applied?.outcome === "applied") {
      if (cardDocs.length !== 1) {
        problems.push(`expected_one_work_order_row_found_${cardDocs.length}`);
      }
      const doc = cardDocs[0];
      if (doc) {
        if (doc.document_id !== applied.document_id) {
          problems.push("document_id_mismatch");
        }
        if (doc.file_name !== row.fileName) problems.push("file_name_mismatch");
        if (!doc.storage_url) problems.push("storage_url_blank");
        if (!doc.target_object_present) {
          problems.push("target_storage_object_missing");
        }
        if (doc.run_label !== RUN_LABEL) problems.push("run_label_missing");
        if (doc.visible_to_trades !== true) {
          problems.push("work_order_not_visible_to_trades");
        }
        if (checkBytes && doc.storage_url) {
          try {
            publishedHash = await publishedSha256(doc.storage_url);
            if (publishedHash.toLowerCase() !== row.sha256.toLowerCase()) {
              problems.push("published_bytes_sha256_mismatch");
            }
          } catch (error) {
            problems.push(
              `published_bytes_unreadable:${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
      }
      if (state.work_order_docs_with_url !== 1) {
        problems.push("work_order_doc_count_not_one");
      }
      if (after && !after.builder_wo_doc_present) {
        problems.push("builder_wo_doc_still_absent");
      }
    } else if (cardDocs.length !== 0) {
      problems.push("skipped_card_gained_a_work_order_row");
    }

    // Board stage must be untouched on EVERY card, applied or skipped.
    if (before && after) {
      if (before.stage !== after.stage) problems.push("stage_changed");
      if (before.computed_stage !== after.computed_stage) {
        problems.push("computed_stage_changed");
      }
      if (before.display_overlay_stage !== after.display_overlay_stage) {
        problems.push("display_overlay_changed");
      }
    }
    // The job row and its display ledger must be untouched.
    if (planned?.before) {
      const planBefore = planned.before as CardState;
      if (planBefore.job_status !== state.job_status) {
        problems.push("job_status_changed");
      }
      if (planBefore.job_archived !== state.job_archived) {
        problems.push("job_archived_changed");
      }
      if (planBefore.job_updated_at !== state.job_updated_at) {
        problems.push("job_updated_at_changed");
      }
      if (planBefore.status_applications !== state.status_applications) {
        problems.push("status_application_ledger_changed");
      }
      // The source artifact must still be exactly where it was.
      if (
        planBefore.attachment_storage_path !== state.attachment_storage_path
      ) {
        problems.push("source_storage_path_changed");
      }
      if (planBefore.attachment_sha256 !== state.attachment_sha256) {
        problems.push("source_sha256_changed");
      }
      if (!state.source_object_present) {
        problems.push("source_object_removed");
      }
    }

    if (problems.length) failures++;
    results.push({
      card: row.card,
      outcome: applied?.outcome ?? "unknown",
      document_id: applied?.document_id ?? null,
      work_order_rows: cardDocs.length,
      builder_wo_doc_before: before?.builder_wo_doc_present ?? null,
      builder_wo_doc_after: after?.builder_wo_doc_present ?? null,
      stage_before: before?.stage ?? null,
      stage_after: after?.stage ?? null,
      verdict_before: before?.verdict ?? null,
      verdict_after: after?.verdict ?? null,
      source_intact: state.source_object_present,
      published_sha256_matches_source: checkBytes
        ? publishedHash !== null &&
          publishedHash.toLowerCase() === row.sha256.toLowerCase()
        : null,
      problems,
      ok: problems.length === 0,
    });
  }

  await writeEvidence(outputPath, {
    run_label: RUN_LABEL,
    mode: "verify",
    project_ref: PROJECT_REF,
    published_byte_check: checkBytes,
    cards: results,
    ok: failures === 0,
    failures,
  }, overwrite);
  summarise("verify", {
    cards: results.length,
    ok: results.filter((entry) => entry.ok).length,
    failures,
  });
  if (failures) Deno.exit(1);
}

async function main(): Promise<void> {
  const args = [...Deno.args];
  if (flag(args, "--help") || flag(args, "-h")) {
    printHelp();
    return;
  }
  validateArgs(args);
  const mode = parseMode(option(args, "--mode"));
  const fixturePath = option(args, "--fixture") || DEFAULT_FIXTURE_PATH;
  const rows = parseFixture(await Deno.readTextFile(fixturePath));
  const overwrite = flag(args, "--overwrite-output");

  if (mode === "measure") {
    const output = option(args, "--output");
    if (!output) throw new UsageError("--output is required for measure");
    await runMeasure(rows, output, overwrite);
    return;
  }
  if (mode === "dry-run") {
    const output = option(args, "--output");
    if (!output) throw new UsageError("--output is required for dry-run");
    await runDryRun(rows, output, overwrite);
    return;
  }
  if (mode === "apply") {
    const baseline = option(args, "--baseline");
    const ledger = option(args, "--ledger");
    if (!baseline || !ledger) {
      throw new UsageError("--baseline and --ledger are required for apply");
    }
    await runApply(rows, baseline, ledger, option(args, "--resume"));
    return;
  }
  const baseline = option(args, "--baseline");
  const ledger = option(args, "--ledger");
  const before = option(args, "--before");
  const after = option(args, "--after");
  const output = option(args, "--output");
  if (!baseline || !ledger || !before || !after || !output) {
    throw new UsageError(
      "--baseline, --ledger, --before, --after and --output are required for verify",
    );
  }
  await runVerify(
    rows,
    baseline,
    ledger,
    before,
    after,
    output,
    overwrite,
    flag(args, "--check-bytes"),
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`usage: ${error.message}`);
      printHelp();
      Deno.exit(2);
    }
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }
}
