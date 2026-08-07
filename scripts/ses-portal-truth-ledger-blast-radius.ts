#!/usr/bin/env -S deno run --allow-env --allow-net --allow-read --allow-write
// deno-lint-ignore-file no-explicit-any
/**
 * Blast radius of pointing the item-14 portal-truth guard at the capture ledger.
 *
 * The guard used to answer "is this card portal-verified?" from
 * `makesafe_job_details.portal_verified_at` / `.portal_verified_cycle` alone.
 * Those columns have ONE writer (`mark_makesafe_portal_report_done`), while the
 * portal observer and the trade attestation record captures in the append-only
 * `makesafe_portal_capture_revisions` ledger and stamp no column. This script
 * measures exactly which cards change answer, and proves each newly-eligible one
 * genuinely holds a compliant current-cycle capture.
 *
 * It REIMPLEMENTS NOTHING. The verdicts come from the shipped functions:
 *   - `portalCapturesFromLedger`  (board read model) — which ledger rows count
 *   - `ledgerPortalCapturesSatisfy` (portal guard)   — whether they are enough
 *   - `portalVerificationSatisfied` (portal guard)   — before vs after
 * A second, cruder copy of "is this capture good" is precisely the defect this
 * change exists to remove, so there is no SQL predicate for it here.
 *
 * Production safety:
 * - the only production access is the Supabase Management API `/database/query`
 *   endpoint with `read_only: true`, so the database itself refuses a write;
 * - `assertReadOnlySql` refuses any statement that is not a SELECT/WITH or that
 *   names a write verb, before the request is sent;
 * - `assertNoPiiColumns` refuses any statement naming a client-identifying
 *   column. Nothing here selects a name, phone, email or street address.
 *
 * NO write, NO mint, NO approve, NO stage move.
 *
 * Usage:  SUPABASE_ACCESS_TOKEN=... deno run -A \
 *           scripts/ses-portal-truth-ledger-blast-radius.ts [--json out.json]
 */

import { portalCapturesFromLedger } from "../supabase/functions/ops-api/makesafe_board_read_model.ts";
import {
  ledgerPortalCapturesSatisfy,
  portalVerificationSatisfied,
  requiredPortalCaptureRoles,
} from "../supabase/functions/ops-api/makesafe_portal_guard.ts";

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
  "refresh materialized",
  "do $$",
];

// Client-identifying columns. This measurement needs none of them.
const PII_COLUMNS = [
  "client_name",
  "client_phone",
  "client_email",
  "site_address",
  "contact_name",
  "contact_phone",
  "contact_email",
  "policyholder",
];

function assertReadOnlySql(sql: string): void {
  const normalized = sql.trim().toLowerCase();
  if (!normalized.startsWith("select") && !normalized.startsWith("with")) {
    throw new Error("refusing a statement that is not a SELECT/WITH");
  }
  for (const verb of WRITE_VERBS) {
    if (normalized.includes(verb)) {
      throw new Error(`refusing a statement naming the write verb '${verb}'`);
    }
  }
}

function assertNoPiiColumns(sql: string): void {
  const normalized = sql.toLowerCase();
  for (const column of PII_COLUMNS) {
    if (normalized.includes(column)) {
      throw new Error(`refusing a statement naming '${column}'`);
    }
  }
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function query<T = Record<string, any>>(sql: string): Promise<T[]> {
  assertReadOnlySql(sql);
  assertNoPiiColumns(sql);
  const response = await fetch(MANAGEMENT_QUERY_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requiredEnv("SUPABASE_ACCESS_TOKEN")}`,
      "Content-Type": "application/json",
      "User-Agent": "SecureWorks-SES-Portal-Truth-Blast-Radius/1.0",
    },
    body: JSON.stringify({ query: sql, read_only: true }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(payload)) {
    const message = payload && typeof payload === "object" &&
        "message" in payload
      ? String((payload as any).message)
      : `HTTP ${response.status}`;
    throw new Error(`read-only query failed: ${message}`);
  }
  return payload as T[];
}

/**
 * Every card the guard could ever gate: a make-safe detail row whose report type
 * is a report family (persisted `report_type`, or a report-family
 * `jobs.metadata.makesafe_job_family` for a card whose type has not self-healed).
 * Non-report make-safes are outside this guard entirely.
 *
 * Deliberately NOT filtered by job status: an archived or cancelled card cannot
 * be invoiced anyway, but excluding it here would understate the population the
 * predicate now answers differently. Status is reported per card instead.
 */
const CARDS_SQL = `
select
  j.id                        as job_id,
  j.job_number,
  j.status                    as job_status,
  j.metadata->>'makesafe_job_family' as job_family,
  d.report_type,
  d.substatus,
  d.cycle_number,
  d.attendance_cycle_id,
  d.external_ref,
  d.external_links,
  d.portal_verified_at,
  d.portal_verified_cycle,
  d.portal_verified_signal
from public.jobs j
join public.makesafe_job_details d on d.job_id = j.id
where coalesce(d.report_type, '') <> ''
   or j.metadata->>'makesafe_job_family' in ('roof_report', 'assessment_report_quote')
order by j.job_number
`;

/**
 * Every ledger row for those cards' CURRENT attendance cycles. Narrowing by
 * `attendance_cycle_id` here mirrors what the runtime read does, so this
 * measurement cannot flatter the change by looking at rows the guard would not
 * load. Prior-cycle rows are counted separately by the second query below,
 * purely so the report can say how many exist and confirm none of them counts.
 */
const CAPTURES_SQL = `
select
  r.id,
  r.job_id,
  r.attendance_cycle_id,
  r.role,
  r.capture_result,
  r.status,
  r.source_url,
  r.source_content_hash,
  r.builder_reference,
  r.capture_producer,
  r.captured_by,
  r.captured_at,
  r.signal,
  r.screenshot_object_key,
  r.screenshot_media_type,
  r.screenshot_content_hash,
  r.screenshot_size_bytes,
  r.makesafe_fact_version
from public.makesafe_portal_capture_revisions r
join public.makesafe_job_details d
  on d.job_id = r.job_id
 and d.attendance_cycle_id = r.attendance_cycle_id
`;

const PRIOR_CYCLE_SQL = `
select count(*)::int as prior_cycle_rows
from public.makesafe_portal_capture_revisions r
join public.makesafe_job_details d on d.job_id = r.job_id
where d.attendance_cycle_id is distinct from r.attendance_cycle_id
`;

/** The runtime's report-family -> report-type resolution, one behaviour. */
function resolveReportType(card: any): string | null {
  const persisted = String(card.report_type || "").trim();
  if (persisted) return persisted;
  const family = String(card.job_family || "").trim().toLowerCase();
  if (family === "roof_report") return "roof_report";
  if (family === "assessment_report_quote") return "assessment_report";
  return null;
}

type CardVerdict = {
  job_number: string;
  job_id: string;
  job_status: string | null;
  substatus: string | null;
  report_type: string;
  external_ref: string | null;
  cycle_number: number;
  attendance_cycle_id: string | null;
  portal_verified_at: string | null;
  portal_verified_cycle: number | null;
  required_roles: string[];
  ledger_rows_current_cycle: number;
  accepted_captures: Array<{
    revision_id: string | null;
    role: string;
    result: string;
    producer: string;
    captured_by: string;
    captured_at: string | null;
    has_screenshot: boolean;
  }>;
  satisfied_before: boolean;
  satisfied_after: boolean;
};

async function main(): Promise<void> {
  const jsonFlagIndex = Deno.args.indexOf("--json");
  const jsonOut = jsonFlagIndex >= 0 ? Deno.args[jsonFlagIndex + 1] : null;

  const [cards, captureRows, priorCycle] = await Promise.all([
    query(CARDS_SQL),
    query(CAPTURES_SQL),
    query<{ prior_cycle_rows: number }>(PRIOR_CYCLE_SQL),
  ]);

  const byJob = new Map<string, any[]>();
  for (const row of captureRows) {
    const key = String(row.job_id);
    const list = byJob.get(key);
    if (list) list.push(row);
    else byJob.set(key, [row]);
  }

  const producerById = new Map<string, any>(
    captureRows.map((row) => [String(row.id), row]),
  );

  const verdicts: CardVerdict[] = [];
  for (const card of cards) {
    const reportType = resolveReportType(card);
    if (!reportType) continue;
    const rows = byJob.get(String(card.job_id)) || [];

    const detail = {
      report_type: reportType,
      cycle_number: card.cycle_number,
      attendance_cycle_id: card.attendance_cycle_id,
      external_ref: card.external_ref,
      external_links: card.external_links,
    };
    // The runtime read is scoped to the card's own attendance cycle, and the
    // projection re-checks it. Both are reproduced here.
    const currentCycleRows = String(card.attendance_cycle_id || "").trim()
      ? rows.filter((row) =>
        String(row.attendance_cycle_id || "") ===
          String(card.attendance_cycle_id)
      )
      : [];
    const captures = currentCycleRows.length > 0
      ? portalCapturesFromLedger(
        {
          id: String(card.job_id),
          external_ref: card.external_ref,
          makesafe_details: detail,
        },
        currentCycleRows,
      )
      : [];
    const ledgerCaptureSatisfied = ledgerPortalCapturesSatisfy(
      reportType,
      captures,
    );

    const requiresAssessmentProof = reportType === "assessment_report" ||
      reportType === "assessment_report_quote";
    const columnState = {
      isReportType: true,
      currentCycle: Number(card.cycle_number ?? 1),
      verifiedAt: card.portal_verified_at ?? null,
      verifiedCycle: card.portal_verified_cycle ?? null,
      requiresAssessmentProof,
      // The assessment stored-signal proof is a card-column concern the ledger
      // path does not touch. It is read as unsatisfied here ONLY for the BEFORE
      // figure of a card that has no stamp at all, which is the population this
      // change moves; a stamped assessment card's before/after are equal either
      // way, so this cannot inflate the reported blast radius.
      assessmentProofSatisfied: !requiresAssessmentProof,
    };
    const satisfiedBefore = portalVerificationSatisfied(columnState);
    const satisfiedAfter = portalVerificationSatisfied({
      ...columnState,
      ledgerCaptureSatisfied,
    });

    verdicts.push({
      job_number: String(card.job_number),
      job_id: String(card.job_id),
      job_status: card.job_status ?? null,
      substatus: card.substatus ?? null,
      report_type: reportType,
      external_ref: card.external_ref ?? null,
      cycle_number: Number(card.cycle_number ?? 1),
      attendance_cycle_id: card.attendance_cycle_id ?? null,
      portal_verified_at: card.portal_verified_at ?? null,
      portal_verified_cycle: card.portal_verified_cycle ?? null,
      required_roles: [...requiredPortalCaptureRoles(reportType)],
      ledger_rows_current_cycle: currentCycleRows.length,
      accepted_captures: captures.map((capture: any) => {
        const source = producerById.get(String(capture.revision_id));
        return {
          revision_id: capture.revision_id ?? null,
          role: String(capture.role),
          result: String(capture.status),
          producer: String(source?.capture_producer ?? ""),
          captured_by: String(source?.captured_by ?? ""),
          captured_at: capture.captured_at ?? null,
          has_screenshot: !!capture.screenshot,
        };
      }),
      satisfied_before: satisfiedBefore,
      satisfied_after: satisfiedAfter,
    });
  }

  const newlyEligible = verdicts.filter((v) =>
    !v.satisfied_before && v.satisfied_after
  );
  // Must be empty by construction: the new term can only ADD a way to satisfy.
  const newlyRefused = verdicts.filter((v) =>
    v.satisfied_before && !v.satisfied_after
  );

  const report = {
    generated_from: "management-api /database/query read_only:true",
    report_cards_examined: verdicts.length,
    satisfied_before: verdicts.filter((v) => v.satisfied_before).length,
    satisfied_after: verdicts.filter((v) => v.satisfied_after).length,
    newly_eligible_count: newlyEligible.length,
    newly_refused_count: newlyRefused.length,
    prior_cycle_ledger_rows_ignored: priorCycle[0]?.prior_cycle_rows ?? 0,
    still_refused_count: verdicts.filter((v) => !v.satisfied_after).length,
    newly_eligible: newlyEligible,
    newly_refused: newlyRefused,
  };

  console.log(JSON.stringify(report, null, 2));

  if (jsonOut) {
    await Deno.writeTextFile(jsonOut, JSON.stringify(report, null, 2));
    console.error(`wrote ${jsonOut}`);
  }

  // A card becoming eligible without a compliant current-cycle capture, or a
  // card losing eligibility, is a defect — not a result worth reporting quietly.
  let failed = false;
  for (const card of newlyEligible) {
    if (card.accepted_captures.length === 0) {
      console.error(
        `DEFECT: ${card.job_number} became eligible with no accepted capture`,
      );
      failed = true;
    }
    for (const role of card.required_roles) {
      if (
        !card.accepted_captures.some((c) =>
          c.role === role && c.result === "done"
        )
      ) {
        console.error(
          `DEFECT: ${card.job_number} became eligible without a done '${role}' capture`,
        );
        failed = true;
      }
    }
  }
  if (newlyRefused.length > 0) {
    console.error(
      `DEFECT: ${newlyRefused.length} card(s) LOST eligibility; this term may only add.`,
    );
    failed = true;
  }
  if (failed) Deno.exit(1);
}

if (import.meta.main) {
  await main();
}
