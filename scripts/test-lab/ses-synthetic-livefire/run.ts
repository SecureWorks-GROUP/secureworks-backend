#!/usr/bin/env -S deno run --allow-env --allow-net --allow-read --allow-write

import {
  buildFixtureRun,
  type FixtureRun,
  type SyntheticFixture,
} from "./fixtures.ts";
import { LivefireClient, LivefireHttpError } from "./client.ts";

const DEFAULT_URL = "https://kevgrhcjxspbxgovpmfl.supabase.co";
const ARTIFACT_ROOT = new URL(
  "../../../artifacts/ses-synthetic-livefire/",
  import.meta.url,
);
const POLL_MS = 15_000;
const SCAN_TIMEOUT_MS = 6 * 60_000;
const MARKER_PREFIX = "SWG-SES-LIVEFIRE-TEST-ONLY-";
const OPTIONAL_MUTABLE_TABLES = new Set(["draft_notes"]);

type JsonRecord = Record<string, unknown>;

export interface Inventory {
  marker: string;
  emails: JsonRecord[];
  attachments: JsonRecord[];
  rawEvents: JsonRecord[];
  sourceIssues: JsonRecord[];
  caseSources: JsonRecord[];
  cases: JsonRecord[];
  caseEvents: JsonRecord[];
  intakeArtifacts: JsonRecord[];
  jobs: JsonRecord[];
  details: JsonRecord[];
  jobEvents: JsonRecord[];
  jobDocuments: JsonRecord[];
  attendanceCycles: JsonRecord[];
  readinessCurrent: JsonRecord[];
  readinessInvalidations: JsonRecord[];
  boardApplications: JsonRecord[];
  docketRevisions: JsonRecord[];
  docketArtifacts: JsonRecord[];
  releaseRevisions: JsonRecord[];
  releaseMembers: JsonRecord[];
  revisionApprovals: JsonRecord[];
  externalEffects: JsonRecord[];
  xeroInvoices: JsonRecord[];
  emailEvents: JsonRecord[];
  intakeDrafts: JsonRecord[];
  mutableOperationalRows: Record<string, JsonRecord[]>;
}

interface RunEvidence {
  schemaVersion: 1;
  runId: string;
  marker: string;
  startedAt: string;
  finishedAt?: string;
  phase: string;
  baseline: Record<string, number>;
  injections: Array<{
    fixtureId: string;
    subject: string;
    attemptedAt: string;
    acceptedAt?: string;
    status: "attempted" | "accepted";
    response?: unknown;
  }>;
  stages: JsonRecord[];
  inventory?: Record<string, number>;
  cleanup?: JsonRecord;
  errors: string[];
}

function env(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function runId(): string {
  const supplied = Deno.env.get("SYNTHETIC_LIVEFIRE_RUN_ID")?.trim();
  return supplied || crypto.randomUUID();
}

function assertRunId(value: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(value)
  ) {
    throw new Error("synthetic live-fire run id must be a UUID");
  }
}

export function isMissingOptionalMutableTable(
  error: unknown,
  table: string,
): boolean {
  return OPTIONAL_MUTABLE_TABLES.has(table) &&
    error instanceof LivefireHttpError &&
    error.operation === `GET ${table}` &&
    error.status === 404 &&
    error.detail.includes('"code":"PGRST205"') &&
    error.detail.includes(`'public.${table}'`);
}

function isScopedJobDocumentPath(
  path: string,
  markedJobPrefixes: readonly string[],
): boolean {
  return markedJobPrefixes.some((prefix) => path.startsWith(prefix)) ||
    /^makesafe-deterministic\/[0-9a-f]{16}\/sha256-[0-9a-f]{64}\.pdf$/i
      .test(path);
}

export function assertExclusiveJobDocumentStorageRefs(
  run: FixtureRun,
  found: Inventory,
  path: string,
  references: readonly JsonRecord[],
): void {
  const expectedIds = new Set(
    found.jobDocuments
      .filter((row) => row.storage_url === path)
      .map((row) => String(row.id)),
  );
  const markedJobIds = new Set(strings(found.jobs, "id"));
  if (
    references.length !== expectedIds.size ||
    references.some((row) =>
      !expectedIds.has(String(row.id)) ||
      !markedJobIds.has(String(row.job_id)) ||
      row.storage_url !== path ||
      !containsMarker(row.data_snapshot_json, run.marker)
    )
  ) {
    throw new Error(
      `cleanup refused shared or foreign job-document object: ${path}`,
    );
  }
}

function assertMarker(value: string): void {
  if (
    !new RegExp(
      `^${MARKER_PREFIX}[0-9A-F]{8}-[0-9A-F]{4}-[1-8][0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$`,
    ).test(value)
  ) {
    throw new Error(`refusing invalid synthetic marker: ${value}`);
  }
}

function strings(rows: JsonRecord[], key: string): string[] {
  return rows.map((row) => String(row[key] || "")).filter(Boolean);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function counts(inventory: Inventory): Record<string, number> {
  return Object.fromEntries(
    Object.entries(inventory)
      .filter(([key]) => key !== "marker")
      .map(([key, value]) => [key, Array.isArray(value) ? value.length : 0]),
  );
}

export function operationalCounts(
  inventory: Inventory,
): Record<string, number> {
  return {
    active_jobs: inventory.jobs.length,
    attachment_objects:
      inventory.attachments.filter((row) => !!row.storage_path).length,
    intake_drafts: inventory.intakeDrafts.length,
    job_documents: inventory.jobDocuments.length,
    document_objects:
      inventory.jobDocuments.filter((row) => !!row.storage_url).length,
    email_events: inventory.emailEvents.length,
    docket_revisions: inventory.docketRevisions.length,
    docket_artifacts: inventory.docketArtifacts.length,
    release_revisions: inventory.releaseRevisions.length,
    release_members: inventory.releaseMembers.length,
    revision_approvals: inventory.revisionApprovals.length,
    external_effects: inventory.externalEffects.length,
    xero_invoices: inventory.xeroInvoices.length,
    mutable_operational_rows: Object.values(inventory.mutableOperationalRows)
      .reduce((sum, rows) => sum + rows.length, 0),
  };
}

export function assertCleanupSettled(
  inventory: Inventory,
  expectedAttempted: number,
): void {
  if (inventory.emails.length !== expectedAttempted) {
    throw new Error(
      `cleanup deferred: captured ${inventory.emails.length}/${expectedAttempted} attempted fixture messages`,
    );
  }
  if (
    expectedAttempted > 0 &&
    inventory.emails.some((email) => email.attachments_settled !== true)
  ) {
    throw new Error(
      "cleanup deferred: at least one attempted fixture has not finished attachment sync",
    );
  }
}

function containsMarker(value: unknown, marker: string): boolean {
  return JSON.stringify(value).includes(marker);
}

function fixtureIdFromSubject(subject: unknown): string | null {
  return String(subject || "").match(/\[FIXTURE:([a-z_]+)\]/)?.[1] || null;
}

async function writeJson(path: URL, value: unknown): Promise<void> {
  await Deno.mkdir(new URL(".", path), { recursive: true });
  await Deno.writeTextFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeFixtures(run: FixtureRun, root: URL): Promise<void> {
  const fixtureDir = new URL("fixtures/", root);
  await Deno.mkdir(fixtureDir, { recursive: true });
  for (const fixture of run.fixtures) {
    await Deno.writeTextFile(
      new URL(`${fixture.id}.html`, fixtureDir),
      fixture.htmlBody,
    );
    if (fixture.attachment) {
      await Deno.writeFile(
        new URL(`${fixture.id}.pdf`, fixtureDir),
        fixture.attachment.bytes,
      );
    }
  }
  await writeJson(
    new URL("manifest.json", fixtureDir),
    {
      runId: run.runId,
      marker: run.marker,
      sender: run.sender,
      mailbox: run.mailbox,
      expiresAt: new Date(run.expiresAtMs).toISOString(),
      fixtures: run.fixtures.map((fixture) => ({
        id: fixture.id,
        kind: fixture.kind,
        ref: fixture.ref,
        subject: fixture.subject,
        attachment: fixture.attachment?.name || null,
        expected: fixture.expected,
      })),
    },
  );
}

async function inventory(
  client: LivefireClient,
  marker: string,
  sinceIso?: string,
): Promise<Inventory> {
  assertMarker(marker);
  const emailQuery: Record<string, string> = {
    select:
      "post_id,mailbox,from_email,to_recipients,subject,received_at,makesafe_scanned_at,attachments_settled",
    subject: `ilike.*${marker}*`,
    order: "received_at.asc",
  };
  if (sinceIso) emailQuery.received_at = `gte.${sinceIso}`;
  const emails = await client.rest<JsonRecord[]>("emails", emailQuery);
  const postIds = strings(emails, "post_id");
  const attachments = await client.rowsForIds<JsonRecord>(
    "email_attachments",
    "email_id",
    postIds,
    "id,email_id,name,content_type,storage_path,status,size_bytes",
  );
  const rawEvents = await client.rowsForIds<JsonRecord>(
    "email_events_raw",
    "post_id",
    postIds,
    "id,post_id,mailbox,change_type,exclusion_reason,page_meta,observed_at",
  );
  const sourceIssues = rawEvents.filter((row) =>
    String(row.change_type || "").startsWith("intake_")
  );
  const caseSources = await client.rowsForIds<JsonRecord>(
    "makesafe_intake_case_sources",
    "post_id",
    postIds,
    "id,case_id,post_id,role,raw_identity_json,evidence,created_at",
  );
  const caseIds = unique(strings(caseSources, "case_id"));
  const cases = await client.rowsForIds<JsonRecord>(
    "makesafe_intake_cases",
    "id",
    caseIds,
    "id,job_id,state,reason_code,parent_case_id,parent_relation,cycle,adapter_id,raw_identity_json,story_json,evidence_map,created_at",
  );
  const caseEvents = await client.rowsForIds<JsonRecord>(
    "makesafe_intake_case_events",
    "case_id",
    caseIds,
  );
  const intakeArtifacts = await client.rowsForIds<JsonRecord>(
    "makesafe_intake_artifacts",
    "case_id",
    caseIds,
  );
  const directJobs = await client.rest<JsonRecord[]>("jobs", {
    select: "id,job_number,status,metadata,created_at",
    "metadata->>synthetic_livefire_marker": `eq.${marker}`,
  });
  const jobIds = unique([
    ...strings(cases, "job_id"),
    ...strings(directJobs, "id"),
  ]);
  const jobs = await client.rowsForIds<JsonRecord>(
    "jobs",
    "id",
    jobIds,
    "id,job_number,status,metadata,created_at",
  );
  const [
    details,
    jobEvents,
    jobDocuments,
    attendanceCycles,
    readinessCurrent,
    readinessInvalidations,
    boardApplications,
    docketRevisions,
    revisionApprovals,
    xeroInvoices,
    intakeDrafts,
  ] = await Promise.all([
    client.rowsForIds<JsonRecord>("makesafe_job_details", "job_id", jobIds),
    client.rowsForIds<JsonRecord>("job_events", "job_id", jobIds),
    client.rowsForIds<JsonRecord>("job_documents", "job_id", jobIds),
    client.rowsForIds<JsonRecord>(
      "makesafe_attendance_cycles",
      "job_id",
      jobIds,
    ),
    client.rowsForIds<JsonRecord>(
      "makesafe_readiness_current",
      "job_id",
      jobIds,
    ),
    client.rowsForIds<JsonRecord>(
      "makesafe_readiness_invalidations",
      "job_id",
      jobIds,
    ),
    client.rowsForIds<JsonRecord>(
      "makesafe_board_status_applications",
      "job_id",
      jobIds,
    ),
    client.rowsForIds<JsonRecord>(
      "makesafe_docket_revisions",
      "job_id",
      jobIds,
    ),
    client.rowsForIds<JsonRecord>(
      "makesafe_revision_approvals",
      "job_id",
      jobIds,
    ),
    client.rowsForIds<JsonRecord>("xero_invoices", "job_id", jobIds),
    client.rest<JsonRecord[]>("makesafe_intake_drafts", {
      select: "*",
      "extraction_json->>synthetic_livefire_marker": `eq.${marker}`,
    }),
  ]);
  const docketArtifacts = await client.rowsForIds<JsonRecord>(
    "makesafe_docket_artifacts",
    "revision_id",
    strings(docketRevisions, "id"),
  );
  const releaseMembers = await client.rowsForIds<JsonRecord>(
    "makesafe_release_revision_members",
    "job_id",
    jobIds,
  );
  const releaseRevisions = await client.rowsForIds<JsonRecord>(
    "makesafe_release_revisions",
    "id",
    strings(releaseMembers, "release_revision_id"),
  );
  const externalEffects = await client.rowsForIds<JsonRecord>(
    "ses_external_effects",
    "job_id",
    jobIds,
  );
  const emailEvents = await client.rest<JsonRecord[]>("email_events", {
    select: "*",
    subject: `ilike.*${marker}*`,
  });
  const mutableOperationalRows: Record<string, JsonRecord[]> = {};
  for (
    const table of [
      "job_assignments",
      "job_media",
      "job_contacts",
      "job_service_reports",
      "makesafe_report_packs",
      "makesafe_status_holds",
      "draft_notes",
      "job_variations",
      "purchase_orders",
    ]
  ) {
    try {
      mutableOperationalRows[table] = await client.rowsForIds<JsonRecord>(
        table,
        "job_id",
        jobIds,
      );
    } catch (error) {
      if (!isMissingOptionalMutableTable(error, table)) throw error;
      mutableOperationalRows[table] = [];
    }
  }
  mutableOperationalRows.trade_invoice_lines = await client.rowsForIds<
    JsonRecord
  >(
    "trade_invoice_lines",
    "job_id",
    jobIds,
  );
  return {
    marker,
    emails,
    attachments,
    rawEvents,
    sourceIssues,
    caseSources,
    cases,
    caseEvents,
    intakeArtifacts,
    jobs,
    details,
    jobEvents,
    jobDocuments,
    attendanceCycles,
    readinessCurrent,
    readinessInvalidations,
    boardApplications,
    docketRevisions,
    docketArtifacts,
    releaseRevisions,
    releaseMembers,
    revisionApprovals,
    externalEffects,
    xeroInvoices,
    emailEvents,
    intakeDrafts,
    mutableOperationalRows,
  };
}

export function guardInventory(run: FixtureRun, found: Inventory): void {
  const expectedSubjects = new Set(
    run.fixtures.map((fixture) => fixture.subject),
  );
  for (const email of found.emails) {
    if (
      !expectedSubjects.has(String(email.subject)) ||
      String(email.from_email).toLowerCase() !== run.sender ||
      String(email.mailbox).toLowerCase() !== run.mailbox
    ) {
      throw new Error(
        `cleanup refused unrecognised source ${String(email.post_id)}`,
      );
    }
  }
  const postIds = new Set(strings(found.emails, "post_id"));
  for (const row of [...found.attachments, ...found.rawEvents]) {
    const postId = String(row.email_id || row.post_id || "");
    if (!postIds.has(postId)) {
      throw new Error(
        `cleanup refused source child outside marker roots: ${postId}`,
      );
    }
  }
  for (const issue of found.sourceIssues) {
    if (
      !postIds.has(String(issue.post_id)) ||
      String(issue.mailbox).toLowerCase() !== run.mailbox
    ) {
      throw new Error(
        `cleanup refused source issue outside exact marker source roots: ${
          String(issue.id)
        }`,
      );
    }
  }
  for (const source of found.caseSources) {
    if (
      !postIds.has(String(source.post_id)) ||
      !containsMarker(
        {
          raw_identity_json: source.raw_identity_json,
          evidence: source.evidence,
        },
        run.marker,
      )
    ) {
      throw new Error(
        `cleanup refused unmarked case source outside marker roots: ${
          String(source.post_id)
        }`,
      );
    }
  }
  for (const intakeCase of found.cases) {
    if (!containsMarker(intakeCase, run.marker)) {
      throw new Error(
        `cleanup refused case without exact marker: ${String(intakeCase.id)}`,
      );
    }
  }
  const caseIds = new Set(strings(found.cases, "id"));
  for (const row of [...found.caseEvents, ...found.intakeArtifacts]) {
    if (
      !caseIds.has(String(row.case_id)) ||
      !containsMarker(row, run.marker)
    ) {
      throw new Error(
        `cleanup refused unmarked case evidence: ${String(row.id)}`,
      );
    }
  }
  for (const job of found.jobs) {
    const metadata = job.metadata as JsonRecord | null;
    if (metadata?.synthetic_livefire_marker !== run.marker) {
      throw new Error(
        `cleanup refused job without exact marker: ${String(job.id)}`,
      );
    }
  }
  const jobIds = new Set(strings(found.jobs, "id"));
  for (
    const row of [
      ...found.details,
      ...found.attendanceCycles,
      ...found.readinessCurrent,
      ...found.readinessInvalidations,
    ]
  ) {
    if (!jobIds.has(String(row.job_id))) {
      throw new Error(
        `cleanup refused operational child outside marker jobs: ${
          String(row.id)
        }`,
      );
    }
  }
  for (const event of found.jobEvents) {
    if (
      !jobIds.has(String(event.job_id)) ||
      !containsMarker(event.detail_json, run.marker)
    ) {
      throw new Error(
        `cleanup refused unmarked job event: ${String(event.id)}`,
      );
    }
  }
  for (const draft of found.intakeDrafts) {
    if (!containsMarker(draft.extraction_json, run.marker)) {
      throw new Error(
        `cleanup refused intake draft without exact marker: ${
          String(draft.id)
        }`,
      );
    }
  }
  for (const document of found.jobDocuments) {
    if (
      !jobIds.has(String(document.job_id)) ||
      !containsMarker(document.data_snapshot_json, run.marker)
    ) {
      throw new Error(
        `cleanup refused job document without exact marker: ${
          String(document.id)
        }`,
      );
    }
  }
  for (const event of found.emailEvents) {
    if (
      !expectedSubjects.has(String(event.subject)) ||
      String(event.sender || "").toLowerCase() !== run.sender ||
      String(event.recipient || "").toLowerCase() !== run.mailbox
    ) {
      throw new Error(
        `cleanup refused unmarked self-send event: ${String(event.id)}`,
      );
    }
  }
  for (const [table, rows] of Object.entries(found.mutableOperationalRows)) {
    for (const row of rows) {
      if (!jobIds.has(String(row.job_id))) {
        throw new Error(
          `cleanup refused mutable operational row outside marker jobs: ${table}/${
            String(row.id)
          }`,
        );
      }
    }
  }
  const emailPaths = strings(found.attachments, "storage_path");
  for (const path of emailPaths) {
    if (
      path.startsWith("/") || path.includes("..") ||
      !strings(found.emails, "post_id").some((postId) =>
        path.startsWith(`${postId}/`)
      )
    ) {
      throw new Error(
        `cleanup refused unscoped makesafe-emails object: ${path}`,
      );
    }
  }
  const markedJobPrefixes = strings(found.jobs, "id").map((id) => `${id}/`);
  for (const path of strings(found.jobDocuments, "storage_url")) {
    if (
      path.startsWith("/") || path.includes("..") ||
      !isScopedJobDocumentPath(path, markedJobPrefixes)
    ) {
      throw new Error(
        `cleanup refused unscoped job-documents object: ${path}`,
      );
    }
  }
  const forbidden = [
    ["board status applications", found.boardApplications],
    ["docket revisions", found.docketRevisions],
    ["docket artifacts", found.docketArtifacts],
    ["release revisions", found.releaseRevisions],
    ["release members", found.releaseMembers],
    ["revision approvals", found.revisionApprovals],
    ["external effects", found.externalEffects],
    ["Xero invoices", found.xeroInvoices],
    [
      "trade invoice lines",
      found.mutableOperationalRows.trade_invoice_lines || [],
    ],
  ] as const;
  for (const [label, rows] of forbidden) {
    if (rows.length) {
      throw new Error(
        `cleanup refused: synthetic run unexpectedly created ${rows.length} ${label}`,
      );
    }
  }
}

async function waitFor(
  label: string,
  timeoutMs: number,
  predicate: () => Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error(
    `${label} did not settle within ${timeoutMs / 60_000} minutes`,
  );
}

async function preflight(
  client: LivefireClient,
  run: FixtureRun,
  startedAt: string,
): Promise<Inventory> {
  const capability = await client.action<JsonRecord>(
    "ops-api",
    "ses_synthetic_livefire_capabilities",
  );
  if (
    capability.contract_version !== "ses-synthetic-livefire/v1" ||
    capability.marker_prefix !== MARKER_PREFIX ||
    capability.real_front_door !== "m365-group:ses@secureworkswa.com.au" ||
    capability.synthetic_sender !== run.sender ||
    capability.terminal_accounting !== true ||
    capability.cleanup_contract_version !==
      "ledger-bound-case-tombstone-purge/v2" ||
    capability.release_refusal_probe !== true ||
    capability.outbound_actions !== false ||
    capability.xero_actions !== false
  ) {
    throw new Error(
      `deployed synthetic live-fire capability is absent or unsafe: ${
        JSON.stringify(capability)
      }`,
    );
  }
  const profiles = await client.rest<JsonRecord[]>("makesafe_companies", {
    select:
      "id,slug,name,active,sender_patterns,invoice_email,report_recipient,parsing_rules,billing_rules",
    slug: "eq.synthetic-livefire",
  });
  if (
    profiles.length !== 1 || profiles[0].active !== true ||
    JSON.stringify(profiles[0].sender_patterns) !== "[]" ||
    profiles[0].invoice_email !== "marnin@secureworkswa.com.au" ||
    profiles[0].report_recipient !== "marnin@secureworkswa.com.au"
  ) {
    throw new Error(
      "synthetic-livefire profile is absent or not locked to empty senders and owned routes",
    );
  }
  const legacyOwnChatter = await client.rest<JsonRecord[]>(
    "ses_synthetic_livefire_runs",
    {
      select: "marker,state,source_post_ids,case_ids,job_ids,evidence",
      "evidence->>kind": "eq.legacy_own_mail_chatter",
    },
  );
  if (
    legacyOwnChatter.length !== 1 ||
    legacyOwnChatter[0].state !== "terminal" ||
    !Array.isArray(legacyOwnChatter[0].source_post_ids) ||
    (legacyOwnChatter[0].source_post_ids as unknown[]).length === 0 ||
    !Array.isArray(legacyOwnChatter[0].job_ids) ||
    (legacyOwnChatter[0].job_ids as unknown[]).length !== 0
  ) {
    throw new Error(
      "pre-existing own-mail chatter is not terminally accounted and excluded",
    );
  }
  const existing = await inventory(client, run.marker, startedAt);
  if (Object.values(counts(existing)).some((count) => count !== 0)) {
    throw new Error(
      `marker collision before injection: ${JSON.stringify(counts(existing))}`,
    );
  }
  const priorRuns = await client.rest<JsonRecord[]>(
    "ses_synthetic_livefire_runs",
    { marker: `eq.${run.marker}`, select: "marker,state" },
  );
  if (priorRuns.length) {
    throw new Error(`synthetic run marker already exists: ${run.marker}`);
  }
  return existing;
}

async function beginRun(
  client: LivefireClient,
  run: FixtureRun,
  baseline: Inventory,
): Promise<void> {
  await client.rest<JsonRecord[]>("ses_synthetic_livefire_runs", {}, {
    method: "POST",
    body: JSON.stringify({
      marker: run.marker,
      run_id: run.runId,
      state: "active",
      baseline: operationalCounts(baseline),
      evidence: {
        own_sender: run.sender,
        own_mailbox: run.mailbox,
        outbound_scope: "one_self_addressed_physical_fixture_email_only",
        xero_disabled: true,
      },
    }),
  });
}

async function injectWave(
  client: LivefireClient,
  run: FixtureRun,
  fixtures: readonly SyntheticFixture[],
  evidence: RunEvidence,
): Promise<void> {
  for (const fixture of fixtures) {
    const attempt = {
      fixtureId: fixture.id,
      subject: fixture.subject,
      attemptedAt: new Date().toISOString(),
      status: "attempted" as const,
    };
    evidence.injections.push(attempt);
    await client.rest<JsonRecord[]>(
      "ses_synthetic_livefire_runs",
      { marker: `eq.${run.marker}` },
      {
        method: "PATCH",
        body: JSON.stringify({
          evidence: {
            own_sender: run.sender,
            own_mailbox: run.mailbox,
            outbound_scope: "one_self_addressed_physical_fixture_email_only",
            xero_disabled: true,
            attempted_fixture_ids: evidence.injections.map((row) =>
              row.fixtureId
            ),
            attempted_fixture_subjects: evidence.injections.map((row) =>
              row.subject
            ),
          },
        }),
      },
    );
    const response = await client.sendFixture(fixture);
    const acceptedAt = new Date().toISOString();
    if (
      response.success !== true ||
      JSON.stringify(response.to) !== JSON.stringify([
          "ses@secureworkswa.com.au",
        ]) ||
      JSON.stringify(response.cc) !== "[]" ||
      JSON.stringify(response.bcc) !== "[]"
    ) {
      throw new Error(`unsafe or failed envelope for fixture ${fixture.id}`);
    }
    evidence.injections[evidence.injections.length - 1] = {
      ...attempt,
      acceptedAt,
      status: "accepted",
      response,
    };
  }
}

async function verifyStages(
  client: LivefireClient,
  run: FixtureRun,
  found: Inventory,
  evidence: RunEvidence,
): Promise<void> {
  guardInventory(run, found);
  if (found.emails.length !== 1 || found.jobs.length !== 1) {
    throw new Error(
      `single-run intake proof expected one email and one job, found ${found.emails.length} emails and ${found.jobs.length} jobs`,
    );
  }
  const fixtureById = new Map(
    run.fixtures.map((fixture) => [fixture.id, fixture]),
  );
  const sourceCase = new Map(
    found.caseSources.map((source) => [
      String(source.post_id),
      String(source.case_id),
    ]),
  );
  const caseById = new Map(found.cases.map((row) => [String(row.id), row]));
  const jobById = new Map(found.jobs.map((row) => [String(row.id), row]));
  const fates: JsonRecord[] = [];
  for (const email of found.emails) {
    const id = fixtureIdFromSubject(email.subject);
    const fixture = id ? fixtureById.get(id) : null;
    const intakeCase = caseById.get(
      sourceCase.get(String(email.post_id)) || "",
    );
    if (!fixture || !intakeCase) {
      throw new Error(
        `source ${String(email.post_id)} has no fixture/case accounting`,
      );
    }
    const elapsed = new Date(String(intakeCase.created_at)).getTime() -
      new Date(String(email.received_at)).getTime();
    if (elapsed < 0 || elapsed > 5 * 60_000) {
      throw new Error(
        `${fixture.id} intake fate exceeded five minutes: ${elapsed}ms`,
      );
    }
    if (
      fixture.expected.carded &&
      !["confirmed_live_job", "blocked_live_job"].includes(
        String(intakeCase.state),
      )
    ) {
      throw new Error(
        `${fixture.id} expected a live card, got ${String(intakeCase.state)}`,
      );
    }
    if (fixture.expected.carded && !String(intakeCase.job_id || "")) {
      throw new Error(`${fixture.id} reached a carded state without a job`);
    }
    if (fixture.expected.carded) {
      const job = jobById.get(String(intakeCase.job_id));
      const metadata = job?.metadata as JsonRecord | null;
      const company = metadata?.requesting_company as JsonRecord | null;
      if (
        !job ||
        metadata?.makesafe_job_family !== fixture.expected.family ||
        company?.slug !== "synthetic-livefire"
      ) {
        throw new Error(
          `${fixture.id} card has the wrong family or reserved builder identity`,
        );
      }
    }
    if (
      !fixture.expected.carded &&
      String(intakeCase.state) !== "accounted_non_wo"
    ) {
      throw new Error(
        `${fixture.id} expected silent accounting, got ${
          String(intakeCase.state)
        }`,
      );
    }
    if (
      fixture.expected.relation !== "root" &&
      fixture.expected.relation !== "none" &&
      intakeCase.parent_relation !== fixture.expected.relation
    ) {
      throw new Error(
        `${fixture.id} expected ${fixture.expected.relation}, got ${
          String(intakeCase.parent_relation)
        }`,
      );
    }
    fates.push({
      fixture: fixture.id,
      post_id: email.post_id,
      case_id: intakeCase.id,
      state: intakeCase.state,
      reason_code: intakeCase.reason_code,
      parent_case_id: intakeCase.parent_case_id,
      parent_relation: intakeCase.parent_relation,
      job_id: intakeCase.job_id,
      fate_ms: elapsed,
    });
  }
  evidence.stages.push({ stage: "intake_fates", result: "PASS", rows: fates });

  const board = await client.action<JsonRecord>(
    "ops-api",
    "makesafe_board",
  );
  const boardRows = Array.isArray(board.rows) ? board.rows as JsonRecord[] : [];
  const projected: JsonRecord[] = [];
  for (const job of found.jobs) {
    const matches = boardRows.filter((row) => row.id === job.id);
    if (matches.length !== 1) {
      throw new Error(
        `job ${
          String(job.job_number)
        } appeared ${matches.length} times on the canonical board`,
      );
    }
    const row = matches[0];
    if (
      !String(row.canonical_stage || "") ||
      !String(row.declared_stage || "") ||
      row.job_state !== job.status
    ) {
      throw new Error(
        `job ${
          String(job.job_number)
        } lacks an honest state-authority projection`,
      );
    }
    projected.push({
      id: job.id,
      job_number: job.job_number,
      raw_job_state: job.status,
      declared_stage: row.declared_stage,
      canonical_stage: row.canonical_stage,
      status_application: row.status_application,
      computed_status: row.computed_status,
      computed_status_reasons: row.computed_status_reasons,
    });
  }
  evidence.stages.push({
    stage: "board_and_state_authority",
    result: "PASS",
    jobs: projected,
  });

  const afterCardProof = await inventory(client, run.marker);
  if (
    afterCardProof.docketRevisions.length ||
    afterCardProof.revisionApprovals.length ||
    afterCardProof.releaseRevisions.length ||
    afterCardProof.releaseMembers.length ||
    afterCardProof.externalEffects.length ||
    afterCardProof.xeroInvoices.length
  ) {
    throw new Error(
      "intake-only run produced forbidden docket/release/Xero state",
    );
  }
  evidence.stages.push({
    stage: "downstream_synthetic_scope",
    result: "NOT_RUN_BY_CAPTAIN_ORDER",
    docket_revisions: 0,
    release_revisions: 0,
    approvals: 0,
    external_effects: 0,
    xero_invoices: 0,
    note:
      "Downstream docket and workflow validation belongs on existing real cards; the synthetic run ends after card classification.",
  });
}

async function cleanup(
  client: LivefireClient,
  run: FixtureRun,
  found: Inventory,
  evidence: RunEvidence,
  expectedAttempted: number,
): Promise<void> {
  assertCleanupSettled(found, expectedAttempted);
  guardInventory(run, found);
  const jobDocumentStorageReferenceProof: JsonRecord[] = [];
  const dryRunPlan = {
    terminal_accounting: {
      emails: strings(found.emails, "post_id"),
      email_attachments: strings(found.attachments, "id"),
      email_events_raw: strings(found.rawEvents, "id"),
      cases: strings(found.cases, "id"),
      case_sources: strings(found.caseSources, "id"),
      case_events: strings(found.caseEvents, "id"),
      intake_artifacts: strings(found.intakeArtifacts, "id"),
      job_events: strings(found.jobEvents, "id"),
      board_applications: strings(found.boardApplications, "id"),
    },
    hard_delete: {
      jobs: strings(found.jobs, "id"),
      job_details: strings(found.details, "job_id"),
      attendance_cycles: strings(found.attendanceCycles, "id"),
      readiness_current: strings(found.readinessCurrent, "job_id"),
      readiness_invalidations: strings(found.readinessInvalidations, "id"),
      intake_drafts: strings(found.intakeDrafts, "id"),
      job_documents: strings(found.jobDocuments, "id"),
      email_events: strings(found.emailEvents, "id"),
      mutable_operational: Object.fromEntries(
        Object.entries(found.mutableOperationalRows).map(([table, rows]) => [
          table,
          strings(rows, "id"),
        ]),
      ),
    },
    storage_delete: {
      makesafe_emails: unique(strings(found.attachments, "storage_path")),
      job_documents: unique(strings(found.jobDocuments, "storage_url")),
    },
    storage_reference_proof: {
      job_documents: jobDocumentStorageReferenceProof,
    },
    mailbox_retained: found.emails.map((row) => ({
      post_id: row.post_id,
      subject: row.subject,
    })),
  };
  evidence.cleanup = { dryRunPlan };
  const runRoot = new URL(`${run.marker}/`, ARTIFACT_ROOT);

  const terminalAt = new Date().toISOString();
  for (const path of unique(strings(found.jobDocuments, "storage_url"))) {
    const references = await client.rest<JsonRecord[]>("job_documents", {
      select: "id,job_id,storage_url,data_snapshot_json",
      storage_url: `eq.${path}`,
    });
    assertExclusiveJobDocumentStorageRefs(run, found, path, references);
    jobDocumentStorageReferenceProof.push({
      path,
      reference_ids: strings(references, "id"),
    });
  }
  await writeJson(new URL("cleanup-dry-run.json", runRoot), dryRunPlan);

  await client.removeStorageObjects(
    "makesafe-emails",
    unique(strings(found.attachments, "storage_path")),
  );
  await client.removeStorageObjects(
    "job-documents",
    unique(strings(found.jobDocuments, "storage_url")),
  );
  const tombstonedAttachments: JsonRecord[] = [];
  for (const attachment of found.attachments) {
    const rows = await client.rest<JsonRecord[]>(
      "email_attachments",
      { id: `eq.${String(attachment.id)}` },
      {
        method: "PATCH",
        body: JSON.stringify({
          storage_path: null,
          name: null,
          content_type: null,
          last_error: null,
          pii_purged_at: terminalAt,
          status: "purged",
          updated_at: terminalAt,
        }),
      },
    );
    tombstonedAttachments.push(...rows);
  }
  const deleted = {
    intake_drafts: await client.deleteIds(
      "makesafe_intake_drafts",
      "id",
      strings(found.intakeDrafts, "id"),
    ),
    job_documents: await client.deleteIds(
      "job_documents",
      "id",
      strings(found.jobDocuments, "id"),
    ),
    email_events: await client.deleteIds(
      "email_events",
      "id",
      strings(found.emailEvents, "id"),
    ),
  };
  const deletedMutableOperational: Record<string, JsonRecord[]> = {};
  deletedMutableOperational.makesafe_job_details = await client.deleteIds(
    "makesafe_job_details",
    "job_id",
    strings(found.details, "job_id"),
  );
  const purgedAttendanceCycles = await client.rpc<number>(
    "purge_synthetic_livefire_attendance_cycles",
    { p_marker: run.marker },
  );
  if (Number(purgedAttendanceCycles || 0) !== found.attendanceCycles.length) {
    throw new Error(
      `synthetic attendance purge count mismatch: purged ${
        String(purgedAttendanceCycles)
      } of ${found.attendanceCycles.length}`,
    );
  }
  deletedMutableOperational.makesafe_attendance_cycles = found.attendanceCycles
    .slice(0, Number(purgedAttendanceCycles || 0));
  for (const [table, rows] of Object.entries(found.mutableOperationalRows)) {
    deletedMutableOperational[table] = await client.deleteIds(
      table,
      "id",
      strings(rows, "id"),
    );
  }
  const purgedJobState = await client.rpc<JsonRecord>(
    "purge_synthetic_livefire_jobs",
    { p_marker: run.marker },
  );
  const expectedJobIds = unique(strings(found.jobs, "id"));
  const purgedJobIds = unique(
    Array.isArray(purgedJobState.jobs_deleted)
      ? purgedJobState.jobs_deleted.map(String)
      : [],
  );
  if (JSON.stringify(purgedJobIds) !== JSON.stringify(expectedJobIds)) {
    throw new Error(
      `synthetic job purge mismatch: expected ${
        JSON.stringify(expectedJobIds)
      } but deleted ${JSON.stringify(purgedJobIds)}`,
    );
  }

  await client.rest<JsonRecord[]>(
    "ses_synthetic_livefire_runs",
    { marker: `eq.${run.marker}` },
    {
      method: "PATCH",
      body: JSON.stringify({
        state: "cleanup_complete",
        evidence: {
          deletable_store_cleanup_verified: true,
          projection_exclusion_verified: false,
          cleanup_completed_at: terminalAt,
        },
      }),
    },
  );

  await waitFor("board projection exclusion", 90_000, async () => {
    // include_archive=1: the default board is active-columns-only, and a purged
    // synthetic job parked in archive would be absent from it either way. Only
    // the full-column board proves terminal accounting did the excluding.
    const board = await client.action<JsonRecord>("ops-api", "makesafe_board", {
      query: { include_archive: "1" },
    });
    return !containsMarker(board, run.marker) &&
      strings(found.jobs, "id").every((id) =>
        !JSON.stringify(board).includes(id)
      );
  });

  const projectionProof: Record<string, boolean> = {};
  for (
    const probe of [
      { action: "makesafe_board", query: { include_archive: "1" } },
      { action: "makesafe_audit" },
      { action: "makesafe_pipeline" },
      { action: "intake_health" },
      { action: "ops_summary" },
    ]
  ) {
    const action = probe.action;
    const response = await client.action<JsonRecord>("ops-api", action, {
      query: probe.query,
    });
    projectionProof[action] = !containsMarker(response, run.marker) &&
      strings(found.jobs, "id").every((id) =>
        !JSON.stringify(response).includes(id)
      );
  }
  if (Object.values(projectionProof).some((ok) => !ok)) {
    throw new Error(
      `terminal synthetic rows leaked into a live projection: ${
        JSON.stringify(projectionProof)
      }`,
    );
  }

  const after = await inventory(client, run.marker);
  const operationalResidue = operationalCounts(after);
  if (
    JSON.stringify(operationalResidue) !== JSON.stringify(evidence.baseline)
  ) {
    throw new Error(
      `cleanup did not restore the marker-scoped operational baseline: before=${
        JSON.stringify(evidence.baseline)
      } after=${JSON.stringify(operationalResidue)}`,
    );
  }
  const healthBeforeTerminalRows = await client.rpc<JsonRecord[]>(
    "makesafe_intake_fresh_source_health",
    {
      p_org_id: "00000000-0000-0000-0000-000000000001",
      p_mailbox: run.mailbox,
      p_since: evidence.startedAt,
      p_now: new Date().toISOString(),
    },
  );
  const healthBeforeTerminal = healthBeforeTerminalRows[0] || {};
  const sourceHealthBeforeTerminal = await client.rpc<JsonRecord>(
    "makesafe_synthetic_livefire_source_health",
    {
      p_org_id: "00000000-0000-0000-0000-000000000001",
      p_mailbox: run.mailbox,
      p_since: evidence.startedAt,
      p_source_post_ids: strings(found.emails, "post_id"),
      p_terminal_override: false,
    },
  );
  const sourceStatesBeforeTerminal = Array.isArray(
      sourceHealthBeforeTerminal.sources,
    )
    ? sourceHealthBeforeTerminal.sources as JsonRecord[]
    : [];
  if (
    sourceStatesBeforeTerminal.length !== found.emails.length ||
    sourceStatesBeforeTerminal.some((source) =>
      source.source_present !== true || source.excluded === true ||
      source.eligible !== true
    )
  ) {
    throw new Error(
      "pre-terminal synthetic source health inclusion proof failed",
    );
  }
  const terminalEvidence: JsonRecord = {
    deletable_store_cleanup_verified: true,
    projection_exclusion_verified: true,
    operational_baseline_restored: true,
    operational_baseline: evidence.baseline,
    operational_residue: operationalResidue,
    projections: projectionProof,
    fresh_source_health_before_terminal: healthBeforeTerminal,
    fresh_source_health_before_terminal_sources: sourceHealthBeforeTerminal,
    synthetic_health_timestamps_included_before_terminal: true,
    tombstoned_attachment_count: tombstonedAttachments.length,
    deleted_counts: Object.fromEntries(
      Object.entries(deleted).map(([key, rows]) => [key, rows.length]),
    ),
    mutable_operational_rows_deleted: Object.fromEntries(
      Object.entries(deletedMutableOperational).map(([table, rows]) => [
        table,
        rows.length,
      ]),
    ),
    jobs_deleted: purgedJobIds.length,
    ledger_bound_job_purge: purgedJobState,
    retained_audit_counts: {
      emails: after.emails.length,
      cases: after.cases.length,
      case_sources: after.caseSources.length,
      case_events: after.caseEvents.length,
      intake_artifacts: after.intakeArtifacts.length,
      raw_source_events: after.rawEvents.length,
      job_events: after.jobEvents.length,
      attendance_cycles: after.attendanceCycles.length,
      attachment_tombstones: after.attachments.length,
      mailbox_messages: after.emails.length,
    },
  };
  const sourceHealthAfterTerminal = await client.rpc<JsonRecord>(
    "terminalize_synthetic_livefire_run",
    {
      p_marker: run.marker,
      p_evidence: terminalEvidence,
      p_terminal_at: terminalAt,
    },
  );
  terminalEvidence.fresh_source_health_after_terminal_sources =
    sourceHealthAfterTerminal;
  terminalEvidence.synthetic_health_timestamps_excluded = true;
  evidence.cleanup = {
    ...evidence.cleanup,
    deleted,
    terminalEvidence,
    finalInventory: counts(after),
  };
}

async function main(): Promise<void> {
  const command = Deno.args[0] || "full";
  if (!["generate", "preflight", "cleanup", "full"].includes(command)) {
    throw new Error("usage: run.ts [generate|preflight|cleanup|full]");
  }
  const id = runId();
  assertRunId(id);
  const serviceRoleKey = command === "generate"
    ? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "generation-only-db-key"
    : env("SUPABASE_SERVICE_ROLE_KEY");
  const signingKey = command === "generate"
    ? Deno.env.get("SW_API_KEY") || "generation-only-signing-key"
    : env("SW_API_KEY");
  const fixtureRun = await buildFixtureRun({
    runId: id,
    expiresAtMs: Date.now() + 14 * 60_000,
    secret: signingKey,
  });
  const productionFixtures = fixtureRun.fixtures.filter((fixture) =>
    fixture.id === "physical"
  );
  if (productionFixtures.length !== 1) {
    throw new Error(
      "single physical live-fire fixture is missing or duplicated",
    );
  }
  assertMarker(fixtureRun.marker);
  const startedAt = new Date().toISOString();
  const runRoot = new URL(`${fixtureRun.marker}/`, ARTIFACT_ROOT);
  const evidence: RunEvidence = {
    schemaVersion: 1,
    runId: id,
    marker: fixtureRun.marker,
    startedAt,
    phase: "generated",
    baseline: {},
    injections: [],
    stages: [],
    errors: [],
  };
  if (command !== "cleanup") {
    await writeFixtures(
      command === "generate"
        ? fixtureRun
        : { ...fixtureRun, fixtures: productionFixtures },
      runRoot,
    );
  }
  if (command === "generate") {
    console.log(
      `Generated ${fixtureRun.fixtures.length} fixtures at ${runRoot}`,
    );
    return;
  }
  const client = new LivefireClient({
    supabaseUrl: Deno.env.get("SUPABASE_URL") || DEFAULT_URL,
    serviceRoleKey,
    opsApiKey: signingKey,
  });
  if (command === "cleanup") {
    const rows = await client.rest<JsonRecord[]>(
      "ses_synthetic_livefire_runs",
      {
        select: "marker,state,baseline,evidence,created_at",
        marker: `eq.${fixtureRun.marker}`,
      },
    );
    if (rows.length !== 1) {
      throw new Error(
        `cleanup requires one existing run ledger for ${fixtureRun.marker}`,
      );
    }
    if (rows[0].state === "terminal") {
      console.log(`Run ${fixtureRun.marker} is already terminal.`);
      return;
    }
    evidence.startedAt = String(rows[0].created_at || startedAt);
    evidence.baseline = (rows[0].baseline as Record<string, number> | null) ||
      {};
    const ledgerEvidence = rows[0].evidence as JsonRecord | null;
    const attemptedFixtureIds = Array.isArray(
        ledgerEvidence?.attempted_fixture_ids,
      )
      ? ledgerEvidence.attempted_fixture_ids as unknown[]
      : [];
    const found = await inventory(client, fixtureRun.marker);
    evidence.inventory = counts(found);
    await cleanup(
      client,
      fixtureRun,
      found,
      evidence,
      attemptedFixtureIds.length,
    );
    evidence.phase = "cleanup_complete";
    evidence.finishedAt = new Date().toISOString();
    await writeJson(new URL("run-evidence.json", runRoot), evidence);
    console.log(`Cleanup PASS: ${fixtureRun.marker} is terminal.`);
    return;
  }
  const baseline = await preflight(client, fixtureRun, startedAt);
  evidence.baseline = operationalCounts(baseline);
  evidence.phase = "preflight_passed";
  await writeJson(new URL("run-evidence.json", runRoot), evidence);
  if (command === "preflight") {
    console.log(
      `Preflight passed for ${fixtureRun.marker}; no email was sent.`,
    );
    return;
  }
  if (
    Deno.env.get("SYNTHETIC_LIVEFIRE_CONFIRM") !==
      "SEND_1_SELF_ADDRESSED_TEST_EMAIL"
  ) {
    throw new Error(
      "full injection requires SYNTHETIC_LIVEFIRE_CONFIRM=SEND_1_SELF_ADDRESSED_TEST_EMAIL",
    );
  }
  await beginRun(client, fixtureRun, baseline);
  console.log(`Synthetic live-fire run started: ${fixtureRun.marker}`);

  try {
    await injectWave(
      client,
      fixtureRun,
      productionFixtures,
      evidence,
    );
    await waitFor("single fixture intake fate", SCAN_TIMEOUT_MS, async () => {
      const found = await inventory(client, fixtureRun.marker, startedAt);
      return found.emails.length === 1 && found.caseSources.length === 1;
    });
    const found = await inventory(client, fixtureRun.marker, startedAt);
    evidence.inventory = counts(found);
    await verifyStages(client, fixtureRun, found, evidence);
    evidence.phase = "verified";
    await cleanup(
      client,
      fixtureRun,
      found,
      evidence,
      evidence.injections.length,
    );
    evidence.phase = "complete";
    evidence.finishedAt = new Date().toISOString();
  } catch (error) {
    evidence.phase = "failed";
    evidence.errors.push(
      error instanceof Error ? error.message : String(error),
    );
    evidence.finishedAt = new Date().toISOString();
    if (evidence.injections.length) {
      try {
        const recoverable = await inventory(
          client,
          fixtureRun.marker,
          startedAt,
        );
        await cleanup(
          client,
          fixtureRun,
          recoverable,
          evidence,
          evidence.injections.length,
        );
        evidence.phase = "failed_cleaned";
      } catch (cleanupError) {
        evidence.errors.push(
          `automatic cleanup failed: ${
            cleanupError instanceof Error
              ? cleanupError.message
              : String(cleanupError)
          }`,
        );
      }
    }
    throw error;
  } finally {
    await writeJson(new URL("run-evidence.json", runRoot), evidence);
  }
  console.log(
    `Synthetic live-fire PASS: ${fixtureRun.fixtures.length} emails, marker ${fixtureRun.marker}`,
  );
  console.log(`Evidence: ${new URL("run-evidence.json", runRoot)}`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    if (error instanceof LivefireHttpError) {
      console.error(error.message);
    } else {
      console.error(error);
    }
    Deno.exit(1);
  }
}
