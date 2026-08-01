#!/usr/bin/env -S deno run --allow-env --allow-net --allow-read --allow-write
// deno-lint-ignore-file no-explicit-any
/**
 * SES Phase C2 — read-only board-wide evidence measurement.
 *
 * Batches the C1 single-card ruler (`scripts/ses-measure-card-evidence.ts`,
 * `supabase/functions/ops-api/makesafe_evidence_requirements.ts`) over EVERY
 * current make-safe board card.
 *
 * Production safety:
 * - the only production access is the Supabase Management API `/database/query`
 *   endpoint with `read_only: true`, so the database itself refuses a write;
 * - `assertReadOnlySql` refuses any statement that is not a SELECT/WITH or that
 *   names a write verb, before the request is sent;
 * - `assertNoPiiColumns` refuses any statement naming a client-identifying
 *   column. Nothing here selects a name, phone, email or street address.
 *
 * NO write, NO backfill, NO stage move.
 */

import {
  buildSesCardEvidenceInventory,
  type MeasureCardResult,
} from "./ses-measure-card-evidence.ts";
import {
  SES_EVIDENCE_CONTRACT_VERSION,
  SES_EVIDENCE_ITEMS,
  type SesEvidenceItem,
} from "../supabase/functions/ops-api/makesafe_evidence_requirements.ts";
import {
  describeSesBoardPopulation,
  SES_BOARD_POPULATION_CONTRACT_VERSION,
  sesBoardPopulationPredicate,
  sesBoardStatusPredicate,
} from "./ses-board-population-contract.ts";
import {
  buildSesMeasurementGeneration,
  sesCardInputHash,
} from "./ses-measurement-generation.ts";
import {
  deriveSesUnlinkedInvoiceMatches,
  indexSesInvoiceMatches,
  SES_ISSUED_INVOICE_STATUSES,
} from "../supabase/functions/ops-api/makesafe_invoice_reference_match.ts";

const PROJECT_REF = "kevgrhcjxspbxgovpmfl";
const MANAGEMENT_QUERY_URL =
  `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;

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
  "comment on",
  "copy",
  "call",
  "do ",
  "vacuum",
  "refresh materialized",
];

const PII_COLUMNS = [
  "client_name",
  "client_phone",
  "client_email",
  "site_address",
  "contact_phone",
  "contact_email",
];

export function assertReadOnlySql(sql: string): void {
  const normalized = sql.trim().toLowerCase();
  if (!/^(select|with)\b/.test(normalized)) {
    throw new Error(`refused non-SELECT statement: ${sql.slice(0, 80)}`);
  }
  for (const verb of WRITE_VERBS) {
    // The trailing guard matters: `updated_at` / `created_at` are legitimate
    // SELECT columns and must not read as the `update` / `create` verb.
    if (new RegExp(`(^|[^a-z_])${verb}(?![a-z_])`, "i").test(normalized)) {
      throw new Error(`refused statement naming write verb "${verb}"`);
    }
  }
}

export function assertNoPiiColumns(sql: string): void {
  const normalized = sql.toLowerCase();
  for (const column of PII_COLUMNS) {
    if (normalized.includes(column)) {
      throw new Error(`refused statement naming PII column "${column}"`);
    }
  }
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

let queryCount = 0;

async function query<T = Record<string, any>>(sql: string): Promise<T[]> {
  assertReadOnlySql(sql);
  assertNoPiiColumns(sql);
  queryCount++;
  const response = await fetch(MANAGEMENT_QUERY_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requiredEnv("SUPABASE_ACCESS_TOKEN")}`,
      "Content-Type": "application/json",
      "User-Agent": "SecureWorks-SES-C2-Evidence-Measure/1.0",
    },
    body: JSON.stringify({ query: sql, read_only: true }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(payload)) {
    const message =
      payload && typeof payload === "object" && "message" in payload
        ? String((payload as any).message)
        : `HTTP ${response.status}`;
    throw new Error(`read-only query failed: ${message}`);
  }
  return payload as T[];
}

/**
 * The board population. The predicate is NOT written here — it comes from the
 * named, versioned contract in `ses-board-population-contract.ts`, which every
 * artifact this script writes also records. That contract is a DEFAULT, not a
 * ruling: Captain decision C.5 (407 active vs 440 including cancelled) is open,
 * so nothing here may be described as covering "the whole board".
 */
const BOARD_SQL = `
select
  j.id, j.job_number, j.type, j.status, j.archived,
  j.created_at, j.updated_at, j.completed_at,
  j.metadata->>'makesafe_job_family' as makesafe_job_family,
  j.metadata->>'insurance_job_type' as insurance_job_type,
  j.metadata->>'own_template_requested' as own_template_requested,
  j.metadata->>'strata' as strata,
  j.metadata->>'report_delivery' as report_delivery,
  j.metadata->>'synthetic_livefire_marker' as synthetic_livefire_marker
from jobs j
where ${sesBoardPopulationPredicate()}
order by j.created_at desc, j.id desc
`;

const DETAIL_SQL = `
select
  d.job_id, d.report_type, d.external_ref, d.external_links,
  d.cycle_number, d.attendance_cycle_id, d.cycle_attribution,
  d.reattend_count, d.report_sent_at, d.report_received_at,
  d.invoice_ready_at, d.substatus, d.portal_verified_signal,
  d.portal_verified_cycle, d.requesting_company_slug, d.computed_status
from makesafe_job_details d
join jobs j on j.id = d.job_id
where ${sesBoardStatusPredicate()}
`;

function boardScopedSql(select: string, table: string, alias: string): string {
  return `
select ${select}
from ${table} ${alias}
join jobs j on j.id = ${alias}.job_id
where ${
    sesBoardPopulationPredicate({
      detailAlias: "d2",
      includeSyntheticExclusion: false,
    })
  }
`;
}

function groupByJob<T extends { job_id?: string | null }>(
  rows: T[],
): Record<string, T[]> {
  const map: Record<string, T[]> = {};
  for (const row of rows) {
    const id = String(row.job_id || "");
    if (!id) continue;
    (map[id] ||= []).push(row);
  }
  return map;
}

export interface C2CardRow extends MeasureCardResult {
  job_status: string;
  archived: boolean;
  substatus: string | null;
  company_slug: string | null;
  created_at: string | null;
  verdict: string;
  item_status: Record<SesEvidenceItem, string>;
  item_requirement: Record<SesEvidenceItem, string>;
  item_signal: Record<SesEvidenceItem, string>;
  /**
   * Drift key over this card's privacy-safe INPUT facts (D.0 rule 3). A later
   * apply re-reads the card, recomputes this, and writes only while it still
   * matches. It deliberately excludes the ruler's verdict, so bumping
   * `SES_EVIDENCE_CONTRACT_VERSION` does not read as board-wide drift.
   */
  input_hash: string;
}

async function run(): Promise<void> {
  const outPath = Deno.args.find((a) => a.startsWith("--out="))?.slice(6) ??
    "/tmp/ses-c2-measure.json";

  // Stamped before the first read, so `snapshot_at` can never claim the board
  // was read later than it was.
  const snapshotAt = new Date().toISOString();

  const board = await query(BOARD_SQL);
  console.error(`population: ${describeSesBoardPopulation()}`);
  console.error(`board cards: ${board.length}`);

  const [
    details,
    assignments,
    reports,
    documents,
    media,
    invoices,
    packs,
    apps,
  ] = await Promise.all([
    query(DETAIL_SQL),
    query(boardScopedSql(
      "a.id, a.job_id, a.status, a.attendance_cycle_id, a.cycle_attribution, a.created_at",
      "job_assignments",
      "a",
    )),
    query(boardScopedSql(
      "r.id, r.job_id, r.status, r.cycle_number, r.attendance_cycle_id, r.cycle_attribution, r.created_at",
      "job_service_reports",
      "r",
    )),
    query(boardScopedSql(
      "dd.id, dd.job_id, dd.type, dd.file_name, dd.storage_url, dd.created_at",
      "job_documents",
      "dd",
    )),
    query(boardScopedSql(
      "m.id, m.job_id, m.type, m.phase, m.storage_url, m.created_at",
      "job_media",
      "m",
    )),
    query(
      boardScopedSql(
        "x.id, x.job_id, x.status, x.invoice_type, x.invoice_date, x.created_at",
        "xero_invoices",
        "x",
      ) + " and x.invoice_type = 'ACCREC'",
    ),
    query(boardScopedSql(
      "p.id, p.job_id, p.pack_kind, p.status, p.review_state, p.report_doc_id, p.invoice_doc_id, p.swms_doc_id, p.sent_at",
      "makesafe_report_packs",
      "p",
    )),
    query(
      boardScopedSql(
        "s.id, s.job_id, s.source_status, s.before_status, s.after_status, s.applied_at",
        "makesafe_board_status_applications",
        "s",
      ) + " order by s.id desc",
    ),
  ]);

  console.error(
    `rows: details=${details.length} assignments=${assignments.length} reports=${reports.length} documents=${documents.length} media=${media.length} invoices=${invoices.length} packs=${packs.length} status_apps=${apps.length}`,
  );

  // The card-unique unlinked issued ACCREC matches. `xero_invoices.job_id` can
  // never be backfilled (the write-once SES money seal refuses `linked`), so a
  // real invoice sitting unlinked in the mirror would otherwise measure as no
  // invoice at all. Guard 2 needs the FULL reference-ownership universe, so the
  // ownership read deliberately does NOT reuse `DETAIL_SQL`, which drops
  // cancelled/lost jobs - a cancelled sibling still contests a builder
  // reference, and omitting it would manufacture false uniqueness.
  const [refUniverse, unlinkedInvoices] = await Promise.all([
    query("select job_id, external_ref from makesafe_job_details"),
    query(
      `select x.id, x.job_id, x.invoice_number, x.reference, x.status,
              x.invoice_type, x.total
       from xero_invoices x
       where x.job_id is null and x.invoice_type = 'ACCREC'
         and x.status in (${
        SES_ISSUED_INVOICE_STATUSES.map((s) => `'${s}'`).join(",")
      })`,
    ),
  ]);
  const { matches: unlinkedMatches, exclusions: unlinkedExclusions } =
    deriveSesUnlinkedInvoiceMatches(
      (refUniverse as any[]).map((row) => ({
        id: String(row.job_id),
        external_ref: row.external_ref ?? null,
      })),
      unlinkedInvoices as any[],
    );
  const unlinkedMatchByJob = indexSesInvoiceMatches(unlinkedMatches);
  console.error(
    `unlinked invoice matches: ${unlinkedMatches.length} matched, ${unlinkedExclusions.length} excluded as ambiguous`,
  );

  const detailByJob: Record<string, any> = {};
  for (const row of details) detailByJob[String(row.job_id)] = row;
  const assignmentsByJob = groupByJob(assignments as any[]);
  const reportsByJob = groupByJob(reports as any[]);
  const documentsByJob = groupByJob(documents as any[]);
  const mediaByJob = groupByJob(media as any[]);
  const invoicesByJob = groupByJob(invoices as any[]);
  const packsByJob = groupByJob(packs as any[]);
  const appsByJob = groupByJob(apps as any[]);

  const opsModule = await import(
    new URL("../supabase/functions/ops-api/index.ts", import.meta.url).href
  );

  const results: C2CardRow[] = [];
  for (const job of board) {
    const jobId = String(job.id);
    const docs = documentsByJob[jobId] || [];
    const docFlags = opsModule._makesafeDocBooleansForTest(docs);
    const detail = detailByJob[jobId] || null;
    const base = buildSesCardEvidenceInventory({
      job,
      detail,
      assignments: assignmentsByJob[jobId] || [],
      serviceReports: reportsByJob[jobId] || [],
      documents: docs,
      docFlags,
      media: mediaByJob[jobId] || [],
      invoices: invoicesByJob[jobId] || [],
      packs: packsByJob[jobId] || [],
      statusApplication: (appsByJob[jobId] || [])[0] || null,
      unlinkedInvoiceMatch: unlinkedMatchByJob.get(jobId) ?? null,
    });
    const itemStatus = {} as Record<SesEvidenceItem, string>;
    const itemReq = {} as Record<SesEvidenceItem, string>;
    const itemSignal = {} as Record<SesEvidenceItem, string>;
    for (const item of SES_EVIDENCE_ITEMS) {
      const reading = base.reading?.items.find((r) => r.item === item);
      itemStatus[item] = reading?.status ?? "unmeasured";
      itemReq[item] = reading?.requirement ?? "unmeasured";
      itemSignal[item] = reading?.signal ?? "none";
    }
    const row: Omit<C2CardRow, "input_hash"> = {
      ...base,
      job_status: String(job.status || ""),
      archived: job.archived === true,
      substatus: detail?.substatus ?? null,
      company_slug: detail?.requesting_company_slug ?? null,
      created_at: job.created_at ?? null,
      verdict: base.reading?.verdict ?? "refused",
      item_status: itemStatus,
      item_requirement: itemReq,
      item_signal: itemSignal,
    };
    results.push({ ...row, input_hash: await sesCardInputHash(row) });
  }

  // D.0 rule 3: the artifact must self-describe its generation, so a later
  // apply can tell "this is the set I approved" from "this board moved".
  const generation = await buildSesMeasurementGeneration({
    snapshotAt,
    populationContractVersion: SES_BOARD_POPULATION_CONTRACT_VERSION,
    populationContract: describeSesBoardPopulation(),
    rulerContractVersion: SES_EVIDENCE_CONTRACT_VERSION,
    cardHashes: results.map((row) => ({
      job_id: row.job_id,
      input_hash: row.input_hash,
    })),
  });

  await Deno.writeTextFile(
    outPath,
    JSON.stringify(
      {
        generated_from: "management-api /database/query read_only:true",
        ...generation,
        queries_issued: queryCount,
        board_cards: results.length,
        cards: results,
      },
      null,
      2,
    ),
  );
  console.error(
    `generation ${generation.generation_id} @ ${generation.snapshot_at}`,
  );
  console.error(`population ${generation.population_contract}`);
  console.error(`ruler      ${generation.ruler_contract_version}`);
  console.error(
    `wrote ${outPath} (${results.length} cards, ${queryCount} queries)`,
  );
}

if (import.meta.main) {
  await run();
}
