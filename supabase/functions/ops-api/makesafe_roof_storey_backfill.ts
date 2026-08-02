/**
 * Apply the merged intake storey matcher to roof cards that already exist.
 *
 * `record explicit roof storey facts at intake` (#505) fixed the FORWARD path
 * only: a roof card created from now on records the storey the builder ordered.
 * Every card the captain wants in Docs Ready this morning is an EXISTING card,
 * so on its own that change moves none of them.
 *
 * This is the same rule applied backwards. It deliberately does NOT
 * reimplement the matching: it calls `roofStoreyOrderedProductFact`, the exact
 * function the intake path uses, so a preview and a write can never disagree
 * with the forward path or with each other.
 *
 * WHY IT DEFAULTS TO A PREVIEW, AND WHY THAT IS NOT TIMIDITY.
 * `storeys` is not ordinary metadata. For this family it is the SOLE
 * determinant of the invoice amount, and every candidate card is
 * `ses_money_sealed_at` sealed. Writing it in bulk is a money-path decision
 * even though the value is derived from the builder's own written instruction
 * rather than asserted by us. So `dry_run` defaults to TRUE - a caller has to
 * ask for the write explicitly, exactly as `backfill_makesafe_job_families`
 * does - and the preview is built to be read and refused row by row by a human,
 * which is why every row carries the matched phrase verbatim rather than just a
 * verdict.
 */

import {
  type MakesafeRoofStorey,
  roofStoreyOrderedProductFact,
} from "./makesafe_roof_storey_fact.ts";
import { roofReportPrice } from "./roof_report_template.ts";

/** Statuses that put a card beyond the point where a price matters. */
const TERMINAL_STATUSES = new Set([
  "cancelled",
  "archived",
  "lost",
  "completed",
  "invoiced",
]);

/**
 * Keys that mean "a storey is recorded somewhere on this card already".
 * Matching is intentionally broad here - the WIDER this net, the MORE cards get
 * held back for a human, so erring wide is the safe direction.
 */
const STOREY_SIGNAL_RE = /stor(?:ey|ies|y)/i;

export type RoofStoreyBackfillDisposition =
  /** A storey the sealed schedule can price. Eligible to write. */
  | "write"
  /**
   * HELD. The card already carries a storey signal somewhere in its record.
   * This is the dangerous case and the reason the preview exists.
   * U4 resolves storeys through `structuredSourceFact`, which returns
   * `undefined` when it finds two DIFFERENT values across its roots. So writing
   * a second value onto a card that already carries one can take a card that
   * prices correctly today and stop it pricing. A fix meant to unblock money
   * must never do that, so these never write automatically at any dry_run
   * setting - a human looks at them one at a time.
   */
  | "hold_competing_storey_signal"
  /** The instruction names a storey the sealed schedule has no price for. */
  | "refused_no_sealed_price"
  /** The instruction names two different storeys. Ambiguity is never authority. */
  | "refused_conflicting"
  /** No storey named against the ordered product. A genuine fact gap. */
  | "no_fact"
  /** Past the point where a price matters. */
  | "excluded_terminal";

export interface RoofStoreyBackfillRow {
  job_id: string;
  job_number: string | null;
  builder_reference: string | null;
  suburb: string | null;
  status: string | null;
  disposition: RoofStoreyBackfillDisposition;
  /** The storey that would be written, or null when nothing would be. */
  storeys: MakesafeRoofStorey | null;
  /** The builder's own words that produced the verdict. Verbatim, for reading. */
  matched_phrase: string | null;
  /** Short window around the match so a wrong hit is obvious at a glance. */
  matched_context: string | null;
  fee_ex_gst: number | null;
  fee_inc_gst: number | null;
  /** Proof nothing is being overwritten. */
  existing_storeys_fact: string | null;
  /** Why a held card is held. */
  competing_storey_signal_in: string[];
  money_sealed: boolean;
  /** This card's persisted docket would be superseded by a new revision. */
  has_persisted_docket: boolean;
  /** A bound invoice amount that would move. Expected to be false everywhere. */
  has_invoice_obligation: boolean;
  written: boolean;
}

export interface RoofStoreyBackfillResult {
  ok: boolean;
  dry_run: boolean;
  error?: string;
  counts: Record<string, number>;
  expected_count?: number | null;
  /** Cards eligible to write: disposition === "write". */
  write_candidates: RoofStoreyBackfillRow[];
  /** Held, refused and no-fact rows, so the captain can see what did NOT happen. */
  held: RoofStoreyBackfillRow[];
  refused: RoofStoreyBackfillRow[];
  no_fact: RoofStoreyBackfillRow[];
  excluded_terminal: RoofStoreyBackfillRow[];
  /** Cards whose state moves if the write proceeds. */
  state_moves: { job_number: string | null; reason: string }[];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/**
 * The same instruction text the intake path hands the matcher: the description
 * that becomes `jobs.notes`, the make-safe type, and the builder work-order
 * text. Newline-joined so a phrase can never be formed by running the end of
 * one field into the start of the next.
 */
export function roofStoreyBackfillSourceText(
  job: Record<string, unknown>,
): string {
  const metadata = record(job.metadata);
  return [
    text(job.notes),
    text(metadata.makesafe_type),
    text(metadata.builder_email_text_for_trade),
  ].filter((part) => part.trim()).join("\n");
}

/** A short readable window around the matched phrase. */
export function matchedContext(
  source: string,
  phrase: string | null,
  window = 40,
): string | null {
  if (!phrase) return null;
  const at = source.toLowerCase().indexOf(phrase.toLowerCase());
  if (at < 0) return null;
  const start = Math.max(0, at - window);
  const end = Math.min(source.length, at + phrase.length + window);
  return `${start > 0 ? "..." : ""}${
    source.slice(start, end).replace(/\s+/g, " ").trim()
  }${end < source.length ? "..." : ""}`;
}

/**
 * Which record roots already mention a storey. Deliberately checks the whole
 * serialised value of each root rather than named keys, because the point is to
 * catch ANY pre-existing signal and hold the card, not to be clever about it.
 */
export function competingStoreySignals(
  job: Record<string, unknown>,
  detail: Record<string, unknown> | null,
): string[] {
  const found: string[] = [];
  const metadata = record(job.metadata);
  // The instruction text itself is the SOURCE of our verdict, so it is not a
  // competing signal; everything else is.
  const metadataWithoutSource = { ...metadata };
  delete metadataWithoutSource.builder_email_text_for_trade;
  delete metadataWithoutSource.makesafe_type;
  delete metadataWithoutSource.description;
  if (STOREY_SIGNAL_RE.test(JSON.stringify(metadataWithoutSource))) {
    found.push("jobs.metadata");
  }
  if (job.scope_json && STOREY_SIGNAL_RE.test(JSON.stringify(job.scope_json))) {
    found.push("jobs.scope_json");
  }
  if (detail && STOREY_SIGNAL_RE.test(JSON.stringify(detail))) {
    found.push("makesafe_job_details");
  }
  return found;
}

export function buildRoofStoreyBackfillRow(
  job: Record<string, unknown>,
  detail: Record<string, unknown> | null,
  flags: { hasPersistedDocket: boolean; hasInvoiceObligation: boolean },
): RoofStoreyBackfillRow {
  const metadata = record(job.metadata);
  const source = roofStoreyBackfillSourceText(job);
  const fact = roofStoreyOrderedProductFact(source);
  const existing = metadata.storeys === undefined || metadata.storeys === null
    ? null
    : String(metadata.storeys);
  const signals = competingStoreySignals(job, detail);
  const status = text(job.status).toLowerCase();

  const base: RoofStoreyBackfillRow = {
    job_id: text(job.id),
    job_number: text(job.job_number) || null,
    builder_reference: detail ? text(detail.external_ref) || null : null,
    suburb: text(job.site_suburb) || null,
    status: text(job.status) || null,
    disposition: "no_fact",
    storeys: null,
    matched_phrase: null,
    matched_context: null,
    fee_ex_gst: null,
    fee_inc_gst: null,
    existing_storeys_fact: existing,
    competing_storey_signal_in: signals,
    money_sealed: Boolean(job.ses_money_sealed_at),
    has_persisted_docket: flags.hasPersistedDocket,
    has_invoice_obligation: flags.hasInvoiceObligation,
    written: false,
  };

  if (TERMINAL_STATUSES.has(status)) {
    return { ...base, disposition: "excluded_terminal" };
  }
  if (!fact) return base;

  const phrase = fact.matched;
  const context = matchedContext(source, phrase);

  if ("refused" in fact) {
    return {
      ...base,
      disposition: fact.refused === "conflicting_storey_counts"
        ? "refused_conflicting"
        : "refused_no_sealed_price",
      matched_phrase: phrase,
      matched_context: context,
    };
  }

  // A storey we can price - unless the card already says something about
  // storeys somewhere else, in which case a human decides, not this.
  const price = roofReportPrice(fact.storeys);
  const priced = {
    ...base,
    storeys: fact.storeys,
    matched_phrase: phrase,
    matched_context: context,
    fee_ex_gst: price.ex_gst,
    fee_inc_gst: price.inc_gst,
  };
  if (existing !== null || signals.length > 0) {
    return { ...priced, disposition: "hold_competing_storey_signal" };
  }
  return { ...priced, disposition: "write" };
}

export function summariseRoofStoreyBackfill(
  rows: RoofStoreyBackfillRow[],
): RoofStoreyBackfillResult {
  const by = (disposition: RoofStoreyBackfillDisposition) =>
    rows.filter((row) => row.disposition === disposition);
  const writes = by("write");
  const counts: Record<string, number> = {
    total: rows.length,
    write: writes.length,
    write_single: writes.filter((row) => row.storeys === "single").length,
    write_double: writes.filter((row) => row.storeys === "double").length,
    hold_competing_storey_signal: by("hold_competing_storey_signal").length,
    refused_no_sealed_price: by("refused_no_sealed_price").length,
    refused_conflicting: by("refused_conflicting").length,
    no_fact: by("no_fact").length,
    excluded_terminal: by("excluded_terminal").length,
  };
  return {
    ok: true,
    dry_run: true,
    counts,
    write_candidates: writes,
    held: by("hold_competing_storey_signal"),
    refused: [...by("refused_no_sealed_price"), ...by("refused_conflicting")],
    no_fact: by("no_fact"),
    excluded_terminal: by("excluded_terminal"),
    state_moves: writes
      .filter((row) => row.has_persisted_docket || row.has_invoice_obligation)
      .map((row) => ({
        job_number: row.job_number,
        reason: row.has_invoice_obligation
          ? "a bound invoice obligation amount would move"
          : "the persisted docket revision would be superseded",
      })),
  };
}

/**
 * Read the board, build one row per roof-report card, and (only when a caller
 * explicitly passes `dry_run: false`) write the storey fact for the eligible
 * ones.
 *
 * `expected_count` is the caller's assertion about how many cards it believes
 * are eligible. If reality disagrees the run refuses and writes nothing - the
 * same guard `backfill_makesafe_job_families` uses, and the reason it is here is
 * that this is a money-path write: a silent change in the candidate set between
 * a captain reading a preview and approving it must stop the write, not widen
 * it.
 */
// deno-lint-ignore no-explicit-any
export async function runMakesafeRoofStoreyBackfill(
  // deno-lint-ignore no-explicit-any
  client: any,
  // deno-lint-ignore no-explicit-any
  body: any,
): Promise<RoofStoreyBackfillResult> {
  const dryRun = body?.dry_run !== false;
  const expectedCount =
    body?.expected_count === undefined || body?.expected_count === null
      ? null
      : Number(body.expected_count);

  const { data: details, error: detailsError } = await client
    .from("makesafe_job_details")
    .select("job_id, external_ref, report_type, substatus")
    .eq("report_type", "roof_report");
  if (detailsError) throw detailsError;

  const jobIds = (details || []).map((row: { job_id: string }) => row.job_id);
  if (!jobIds.length) {
    return { ...summariseRoofStoreyBackfill([]), dry_run: dryRun };
  }

  const { data: jobs, error: jobsError } = await client
    .from("jobs")
    .select(
      "id, job_number, status, notes, metadata, scope_json, site_suburb, ses_money_sealed_at",
    )
    .in("id", jobIds);
  if (jobsError) throw jobsError;

  const { data: dockets } = await client
    .from("makesafe_docket_revisions").select("job_id").in("job_id", jobIds);
  const { data: obligations } = await client
    .from("makesafe_invoice_obligation_revisions").select("job_id").in(
      "job_id",
      jobIds,
    );
  const docketJobs = new Set(
    (dockets || []).map((row: { job_id: string }) => row.job_id),
  );
  const obligationJobs = new Set(
    (obligations || []).map((row: { job_id: string }) => row.job_id),
  );
  const detailByJob = new Map<string, Record<string, unknown>>();
  for (const row of (details || [])) detailByJob.set(row.job_id, row);

  const rows = (jobs || []).map((job: Record<string, unknown>) =>
    buildRoofStoreyBackfillRow(job, detailByJob.get(String(job.id)) || null, {
      hasPersistedDocket: docketJobs.has(String(job.id)),
      hasInvoiceObligation: obligationJobs.has(String(job.id)),
    })
  ).sort((left: RoofStoreyBackfillRow, right: RoofStoreyBackfillRow) =>
    String(left.job_number).localeCompare(String(right.job_number))
  );

  const result = { ...summariseRoofStoreyBackfill(rows), dry_run: dryRun };
  if (expectedCount !== null && result.counts.write !== expectedCount) {
    return {
      ...result,
      ok: false,
      error:
        `expected_count mismatch: expected ${expectedCount} writeable cards, got ${result.counts.write}. Nothing was written.`,
      expected_count: expectedCount,
    };
  }
  if (dryRun) return { ...result, expected_count: expectedCount };

  // Only `write` rows are ever written. Held, refused, no-fact and terminal
  // rows are untouched at every setting - there is no flag that makes them
  // write, deliberately.
  for (const row of result.write_candidates) {
    const { data: current, error: readError } = await client
      .from("jobs").select("metadata").eq("id", row.job_id).maybeSingle();
    if (readError) throw readError;
    const metadata = record(current?.metadata);
    // Re-check at write time: if a storey appeared between preview and write,
    // leave it alone rather than racing it.
    if (metadata.storeys !== undefined && metadata.storeys !== null) continue;
    const { error: writeError } = await client.from("jobs")
      .update({ metadata: { ...metadata, storeys: row.storeys } })
      .eq("id", row.job_id);
    if (writeError) throw writeError;
    row.written = true;
  }
  return { ...result, expected_count: expectedCount };
}
