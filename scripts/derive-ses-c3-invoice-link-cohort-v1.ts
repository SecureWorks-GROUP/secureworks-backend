#!/usr/bin/env -S deno run --allow-env --allow-net --allow-read --allow-write
/**
 * SES C3 tranche 3 - invoice-link cohort derivation (STRICT READ-ONLY).
 *
 * Re-derives, from LIVE production, the set of SES board cards that own exactly
 * one unlinked issued ACCREC invoice, applying BOTH guards that
 * `data/codex-po-invoice-verify-v1/report.md` established:
 *
 *   Guard A - exactly one unlinked issued ACCREC candidate names the card's
 *             builder reference.
 *   Guard B - that builder reference is owned by exactly ONE job across the
 *             FULL jobs table. Codex refuted "one invoice candidate" as a
 *             sufficient apply guard precisely because 13 cards share a builder
 *             claim with a sibling, so the candidate set does not prove which
 *             card should receive the foreign key.
 *
 * This script NEVER writes. It exists so the tranche's cohort is re-derived from
 * production at decision time rather than trusted from a stale report fixture -
 * the discovery report's own caveat. The apply half is deliberately NOT in this
 * file: see `docs/evidence/ses-c3-invoice-link-seal-conflict-2026-08-01.md`.
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

const PROJECT_REF = "kevgrhcjxspbxgovpmfl";
const MANAGEMENT_QUERY_URL =
  `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;

/** Production's issued-invoice rule (`scripts/ses-measure-card-evidence.ts`). */
const ISSUED_INVOICE_STATUSES = ["AUTHORISED", "SUBMITTED", "PAID"] as const;

/**
 * A builder reference is only usable as invoice identity when its digit run is
 * long enough not to collide. The discovery report's match quality check used
 * >= 5 digits on whole-digit-run boundaries; a shorter run (e.g. `6781`) is a
 * substring of unrelated five- and six-digit invoice and PO numbers, which is
 * the exact failure mode the tranche-2 work-order adjudication documented.
 */
const MIN_REFERENCE_DIGITS = 5;

let queryCount = 0;

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function query<T = Record<string, any>>(sql: string): Promise<T[]> {
  assertReadOnlySql(sql);
  assertNoPiiColumns(sql);
  queryCount++;
  const response = await fetch(MANAGEMENT_QUERY_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requiredEnv("SUPABASE_ACCESS_TOKEN")}`,
      "Content-Type": "application/json",
      "User-Agent": "SecureWorks-SES-C3-InvoiceLink-Derive/1.0",
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

/** Every maximal digit run in a string, e.g. `MLB-26344PO-57087` -> 26344,57087. */
export function digitRuns(value: unknown): string[] {
  return String(value ?? "").match(/\d+/g) ?? [];
}

/**
 * The identity digits a builder reference contributes. A reference carrying
 * several long runs (the `MLB-26344PO-57087` shape) is deliberately reduced to
 * ALL of its long runs, so a card whose ref embeds a PO cannot silently match on
 * the PO half alone without that being visible in the evidence.
 */
export function referenceDigits(externalRef: unknown): string[] {
  return digitRuns(externalRef).filter((d) => d.length >= MIN_REFERENCE_DIGITS);
}

/** Whole-digit-run containment: never a substring test. */
export function invoiceNamesReference(
  invoiceReference: unknown,
  refDigits: string[],
): string[] {
  if (refDigits.length === 0) return [];
  const invoiceRuns = new Set(digitRuns(invoiceReference));
  return refDigits.filter((d) => invoiceRuns.has(d));
}

type JobRow = {
  id: string;
  job_number: string | null;
  type: string | null;
  status: string | null;
  archived: boolean | null;
  external_ref: string | null;
  ses_money_sealed_at: string | null;
  on_board: boolean;
};

type InvoiceRow = {
  id: string;
  xero_invoice_id: string | null;
  invoice_number: string | null;
  reference: string | null;
  status: string | null;
  invoice_type: string | null;
  total: string | null;
  invoice_date: string | null;
};

const JOBS_SQL = `
  select
    j.id,
    j.job_number,
    j.type,
    j.status,
    j.archived,
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

const INVOICES_SQL = `
  select
    x.id,
    x.xero_invoice_id,
    x.invoice_number,
    x.reference,
    x.status,
    x.invoice_type,
    x.total,
    x.invoice_date
  from xero_invoices x
  where x.invoice_type = 'ACCREC'
    and x.job_id is null
    and x.status in (${ISSUED_INVOICE_STATUSES.map((s) => `'${s}'`).join(",")})
  order by x.invoice_number`;

export type CohortEntry = {
  job_id: string;
  job_number: string | null;
  job_status: string | null;
  archived: boolean | null;
  external_ref: string | null;
  matched_digits: string[];
  invoice_row_id: string;
  xero_invoice_id: string | null;
  invoice_number: string | null;
  invoice_reference: string | null;
  invoice_status: string | null;
  invoice_total: string | null;
  invoice_date: string | null;
  sealed: boolean;
  sealed_by: string;
  reference_is_deposit_shaped: boolean;
};

export type ExclusionEntry = {
  job_number: string | null;
  job_id: string;
  external_ref: string | null;
  reason: string;
  detail: string;
};

/** Mirrors `_shared/sealed_ses_money_fence.ts` classifySealedSesJob. */
export function classifySealed(job: JobRow, hasDetail: boolean): {
  sealed: boolean;
  by: string;
} {
  if (job.ses_money_sealed_at) return { sealed: true, by: "job_seal" };
  if (
    String(job.type ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "") ===
      "makesafe"
  ) return { sealed: true, by: "job_type" };
  if (/^SWMS-/i.test(String(job.job_number ?? "").trim())) {
    return { sealed: true, by: "job_number" };
  }
  if (hasDetail) return { sealed: true, by: "makesafe_detail" };
  return { sealed: false, by: "" };
}

export function deriveCohort(jobs: JobRow[], invoices: InvoiceRow[]): {
  cohort: CohortEntry[];
  exclusions: ExclusionEntry[];
} {
  // Guard B input: how many jobs across the FULL table claim each digit run.
  const ownersByDigits = new Map<string, JobRow[]>();
  for (const job of jobs) {
    for (const digits of referenceDigits(job.external_ref)) {
      const list = ownersByDigits.get(digits) ?? [];
      list.push(job);
      ownersByDigits.set(digits, list);
    }
  }

  const cohort: CohortEntry[] = [];
  const exclusions: ExclusionEntry[] = [];

  for (const job of jobs) {
    if (!job.on_board) continue;
    const refDigits = referenceDigits(job.external_ref);
    if (refDigits.length === 0) continue; // no usable builder identity: silent, not an exclusion

    const candidates = invoices
      .map((inv) => ({
        inv,
        matched: invoiceNamesReference(inv.reference, refDigits),
      }))
      .filter((c) => c.matched.length > 0);

    if (candidates.length === 0) continue;

    if (candidates.length > 1) {
      exclusions.push({
        job_number: job.job_number,
        job_id: job.id,
        external_ref: job.external_ref,
        reason: "multiple_invoice_candidates",
        detail: candidates.map((c) => c.inv.invoice_number).join(", "),
      });
      continue;
    }

    // Guard B: the matched digits must be owned by exactly one job overall.
    const contested = candidates[0].matched.filter((d) =>
      (ownersByDigits.get(d)?.length ?? 0) > 1
    );
    if (contested.length > 0) {
      const siblings = new Set<string>();
      for (const d of contested) {
        for (const owner of ownersByDigits.get(d) ?? []) {
          if (owner.id !== job.id) siblings.add(owner.job_number ?? owner.id);
        }
      }
      exclusions.push({
        job_number: job.job_number,
        job_id: job.id,
        external_ref: job.external_ref,
        reason: "builder_reference_shared_with_other_job",
        detail: `contested digits ${contested.join(",")}; also owned by ${
          [...siblings].sort().join(", ")
        }`,
      });
      continue;
    }

    const { inv, matched } = candidates[0];
    const seal = classifySealed(job, job.external_ref !== null);
    cohort.push({
      job_id: job.id,
      job_number: job.job_number,
      job_status: job.status,
      archived: job.archived,
      external_ref: job.external_ref,
      matched_digits: matched,
      invoice_row_id: inv.id,
      xero_invoice_id: inv.xero_invoice_id,
      invoice_number: inv.invoice_number,
      invoice_reference: inv.reference,
      invoice_status: inv.status,
      invoice_total: inv.total,
      invoice_date: inv.invoice_date,
      sealed: seal.sealed,
      sealed_by: seal.by,
      reference_is_deposit_shaped: /dep/i.test(String(inv.reference ?? "")),
    });
  }

  // An invoice may only fund ONE card. Any invoice claimed by two cards is
  // removed from both rather than arbitrated here.
  const claimCount = new Map<string, number>();
  for (const entry of cohort) {
    claimCount.set(
      entry.invoice_row_id,
      (claimCount.get(entry.invoice_row_id) ?? 0) + 1,
    );
  }
  const contestedInvoices = new Set(
    [...claimCount.entries()].filter(([, n]) => n > 1).map(([id]) => id),
  );
  const kept = cohort.filter((e) => {
    if (!contestedInvoices.has(e.invoice_row_id)) return true;
    exclusions.push({
      job_number: e.job_number,
      job_id: e.job_id,
      external_ref: e.external_ref,
      reason: "invoice_claimed_by_multiple_cards",
      detail: `${e.invoice_number} is also claimed by another card`,
    });
    return false;
  });

  return { cohort: kept, exclusions };
}

if (import.meta.main) {
  const outArg = Deno.args.find((a) => a.startsWith("--out="));
  const jobs = await query<JobRow>(JOBS_SQL);
  const invoices = await query<InvoiceRow>(INVOICES_SQL);
  const { cohort, exclusions } = deriveCohort(jobs, invoices);

  const money = cohort.reduce((sum, e) => sum + Number(e.invoice_total ?? 0), 0);
  const byStatus: Record<string, number> = {};
  for (const e of cohort) {
    const key = String(e.invoice_status ?? "unknown");
    byStatus[key] = (byStatus[key] ?? 0) + 1;
  }

  const result = {
    generated_at: new Date().toISOString(),
    mode: "read_only_derivation",
    queries_run: queryCount,
    population: {
      jobs_total: jobs.length,
      board_cards: jobs.filter((j) => j.on_board).length,
      unlinked_issued_accrec: invoices.length,
    },
    cohort_size: cohort.length,
    cohort_money_inc: Number(money.toFixed(2)),
    cohort_by_invoice_status: byStatus,
    sealed_targets: cohort.filter((e) => e.sealed).length,
    deposit_shaped_references: cohort.filter((e) =>
      e.reference_is_deposit_shaped
    ).length,
    exclusions_total: exclusions.length,
    exclusions_by_reason: exclusions.reduce((acc, e) => {
      acc[e.reason] = (acc[e.reason] ?? 0) + 1;
      return acc;
    }, {} as Record<string, number>),
    cohort,
    exclusions: exclusions.sort((a, b) =>
      String(a.job_number).localeCompare(String(b.job_number))
    ),
  };

  const json = JSON.stringify(result, null, 2);
  if (outArg) {
    await Deno.writeTextFile(outArg.slice("--out=".length), json + "\n");
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
