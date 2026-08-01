#!/usr/bin/env -S deno run --allow-env --allow-net --allow-read --allow-write
/**
 * SES C3 tranche 3 - card-unique unlinked invoice cohort (STRICT READ-ONLY).
 *
 * Re-derives, from LIVE production, the SES board cards that own exactly one
 * unlinked issued ACCREC invoice. The matching rule itself lives in
 * `supabase/functions/ops-api/makesafe_invoice_reference_match.ts` and is shared
 * with the C1/C2 evidence measurement entrypoints and the C4 board UI, so a
 * card's invoice evidence reads identically everywhere. This script is I/O only.
 *
 * It exists because the cohort must be re-derived from production at decision
 * time rather than trusted from a stale report fixture - the discovery report's
 * own caveat.
 *
 * There is deliberately NO apply half. Backfilling `xero_invoices.job_id` is
 * refused by the write-once SES money seal; the Captain's 2026-08-01 ruling was
 * to teach the ruler to read this evidence instead. See
 * `docs/evidence/ses-c3-invoice-link-seal-conflict-2026-08-01.md`.
 *
 * Usage:
 *   SUPABASE_ACCESS_TOKEN=... deno run --allow-env --allow-net --allow-read \
 *     --allow-write scripts/derive-ses-c3-invoice-link-cohort-v1.ts \
 *     --out=scripts/ses-c3-invoice-links-t3-v1.cohort.json
 */
import {
  assertNoPiiColumns,
  assertReadOnlySql,
} from "./ses-c2-measure-board-evidence.ts";
import {
  deriveSesUnlinkedInvoiceMatches,
  SES_ISSUED_INVOICE_STATUSES,
  type SesMatchInvoice,
  type SesMatchJob,
} from "../supabase/functions/ops-api/makesafe_invoice_reference_match.ts";

const PROJECT_REF = "kevgrhcjxspbxgovpmfl";
const MANAGEMENT_QUERY_URL =
  `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;

let queryCount = 0;

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  assertReadOnlySql(sql);
  assertNoPiiColumns(sql);
  queryCount++;
  const response = await fetch(MANAGEMENT_QUERY_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requiredEnv("SUPABASE_ACCESS_TOKEN")}`,
      "Content-Type": "application/json",
      "User-Agent": "SecureWorks-SES-C3-InvoiceMatch-Derive/1.0",
    },
    body: JSON.stringify({ query: sql, read_only: true }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(payload)) {
    const message = payload && typeof payload === "object" &&
        "message" in payload
      ? String((payload as Record<string, unknown>).message)
      : `HTTP ${response.status}`;
    throw new Error(`read-only query failed: ${message}`);
  }
  return payload as T[];
}

/** The FULL job population: non-board jobs still contest a builder reference. */
export const JOBS_SQL = `
  select
    j.id,
    j.job_number,
    j.status,
    j.ses_money_sealed_at,
    d.external_ref,
    (
      j.type = 'makesafe'
      or (j.type = 'insurance' and j.metadata->>'insurance_job_type' = 'restoration')
      or d.job_id is not null
    ) as on_board
  from jobs j
  left join makesafe_job_details d on d.job_id = j.id
  order by j.job_number`;

export const INVOICES_SQL = `
  select
    x.id,
    x.xero_invoice_id,
    x.invoice_number,
    x.reference,
    x.status,
    x.invoice_type,
    x.job_id,
    x.total,
    x.invoice_date
  from xero_invoices x
  where x.invoice_type = 'ACCREC'
    and x.job_id is null
    and x.status in (${
  SES_ISSUED_INVOICE_STATUSES.map((s) => `'${s}'`).join(",")
})
  order by x.invoice_number`;

if (import.meta.main) {
  const outArg = Deno.args.find((a) => a.startsWith("--out="));
  const fixtureArg = Deno.args.find((a) => a.startsWith("--fixture-out="));
  const jobs = await query<
    SesMatchJob & { ses_money_sealed_at: string | null }
  >(
    JOBS_SQL,
  );
  const invoices = await query<SesMatchInvoice>(INVOICES_SQL);
  const { matches, exclusions } = deriveSesUnlinkedInvoiceMatches(
    jobs,
    invoices,
  );

  const sealedById = new Map(
    jobs.map((job) => [job.id, !!job.ses_money_sealed_at]),
  );
  const cohort = matches.map((match) => ({
    job_id: match.job_id,
    job_number: match.job_number,
    external_ref: match.external_ref,
    matched_digits: match.matched_digits,
    invoice_row_id: match.invoice.id,
    invoice_number: match.invoice.invoice_number ?? null,
    invoice_reference: match.invoice.reference ?? null,
    invoice_status: match.invoice.status ?? null,
    invoice_total: match.invoice.total ?? null,
    invoice_date: match.invoice.invoice_date ?? null,
    money_sealed: sealedById.get(match.job_id) === true,
  }));

  const money = cohort.reduce(
    (sum, entry) => sum + Number(entry.invoice_total ?? 0),
    0,
  );
  const byStatus: Record<string, number> = {};
  for (const entry of cohort) {
    const key = String(entry.invoice_status ?? "unknown");
    byStatus[key] = (byStatus[key] ?? 0) + 1;
  }

  const result = {
    generated_at: new Date().toISOString(),
    mode: "read_only_derivation",
    matcher: "makesafe_invoice_reference_match/deriveSesUnlinkedInvoiceMatches",
    queries_run: queryCount,
    population: {
      jobs_total: jobs.length,
      board_cards: jobs.filter((job) => job.on_board !== false).length,
      unlinked_issued_accrec: invoices.length,
    },
    cohort_size: cohort.length,
    cohort_money_inc: Number(money.toFixed(2)),
    cohort_by_invoice_status: byStatus,
    money_sealed_targets: cohort.filter((entry) => entry.money_sealed).length,
    deposit_shaped_references: cohort.filter((entry) =>
      /dep/i.test(String(entry.invoice_reference ?? ""))
    ).length,
    exclusions_total: exclusions.length,
    exclusions_by_reason: exclusions.reduce((acc, entry) => {
      acc[entry.reason] = (acc[entry.reason] ?? 0) + 1;
      return acc;
    }, {} as Record<string, number>),
    cohort,
    exclusions: [...exclusions].sort((a, b) =>
      String(a.job_number).localeCompare(String(b.job_number))
    ),
  };

  const json = JSON.stringify(result, null, 2);
  if (outArg) {
    await Deno.writeTextFile(outArg.slice("--out=".length), json + "\n");
  }

  // The exact matcher INPUT, so the offline test re-runs the real production
  // population rather than asserting the committed output against itself. Only
  // jobs carrying a builder reference are kept: a job with no reference cannot
  // match or contest, so dropping it changes no verdict and keeps the fixture
  // small. Builder references and invoice references only - no client PII.
  if (fixtureArg) {
    const fixture = {
      generated_at: result.generated_at,
      note:
        "Matcher input captured from live production, read-only. Regenerate " +
        "with --fixture-out=. Contains no client name, phone, email or address.",
      jobs: jobs
        .filter((job) =>
          (job.external_ref ?? "") !== ""
        )
        .map((job) => ({
          id: job.id,
          job_number: job.job_number ?? null,
          external_ref: job.external_ref ?? null,
          on_board: job.on_board !== false,
        })),
      invoices: invoices.map((invoice) => ({
        id: invoice.id,
        job_id: invoice.job_id ?? null,
        invoice_number: invoice.invoice_number ?? null,
        reference: invoice.reference ?? null,
        status: invoice.status ?? null,
        invoice_type: invoice.invoice_type ?? null,
        total: invoice.total ?? null,
      })),
    };
    await Deno.writeTextFile(
      fixtureArg.slice("--fixture-out=".length),
      JSON.stringify(fixture, null, 2) + "\n",
    );
  }
  console.log(
    JSON.stringify(
      {
        ...result,
        cohort: `[${cohort.length} entries]`,
        exclusions: `[${exclusions.length} entries]`,
      },
      null,
      2,
    ),
  );
}
