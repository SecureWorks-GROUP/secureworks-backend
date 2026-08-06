// Card-unique matching of UNLINKED issued ACCREC invoices to SES cards.
//
// Why this exists
// ---------------
// An SES card's close-out invoice frequently exists in the Xero mirror while
// `xero_invoices.job_id` is still null, so the C1 evidence ruler reads the card
// as having no invoice at all. The obvious repair - backfill the foreign key -
// is refused by design: `linked` is one of the verbs sealed by the write-once
// SES money fence (`_shared/sealed_ses_money_fence.ts`), and every SES board
// card carries an explicit `ses_money_sealed_at`. The Captain's 2026-08-01
// ruling was to leave the money mirror alone and let the RULER see the evidence
// instead. Full reasoning:
// `docs/evidence/ses-c3-invoice-link-seal-conflict-2026-08-01.md`.
//
// This module is therefore pure, read-only and write-free by construction: it
// maps cards to invoices in memory and never touches a database. It is the ONE
// implementation of that matching. The C1 measure entrypoints, the C2 board
// batch, the C3 cohort deriver and the C4 board UI must all consume it rather
// than re-deriving the rule, so a card's invoice evidence reads the same
// everywhere.
//
// Strictness is deliberate: a UNIQUE match only. Anything ambiguous stays
// unmatched, which leaves the ruler cell `missing` exactly as it reads today. A
// wrong invoice attributed to a card is far worse than a card that still
// reports its invoice missing.

/** Production's issued-invoice rule, mirrored from the C1 measure entrypoint. */
export const SES_ISSUED_INVOICE_STATUSES: readonly string[] = [
  "AUTHORISED",
  "SUBMITTED",
  "PAID",
];

/**
 * A builder reference only carries usable invoice identity when its digit run
 * is long enough not to collide. The tranche-2 work-order adjudication is the
 * cautionary case: a four-digit reference (`BWCWA6771`) is a substring of
 * unrelated five- and six-digit job and purchase-order numbers, so a substring
 * test attaches another builder's paperwork.
 */
export const SES_MIN_REFERENCE_DIGITS = 5;

export type SesInvoiceMatchExclusionReason =
  | "multiple_invoice_candidates"
  | "builder_reference_shared_with_other_job"
  | "invoice_claimed_by_multiple_cards";

export interface SesMatchJob {
  id: string;
  job_number?: string | null;
  /** `makesafe_job_details.external_ref` - the builder's own claim reference. */
  external_ref?: string | null;
  /**
   * `jobs.metadata.builder_po_number` - the card's OWN declared purchase order.
   *
   * This is the second half of the card's identity, and it is here because the
   * system was disagreeing with itself about what identifies a card:
   * `makesafe_docs_ready_invoice.ts` has always accepted this field as card
   * identity (`makesafeInvoiceReferenceMatchesCard`) while this module read only
   * the claim reference. Per the captain's 2026-08-02 grain ruling the purchase
   * order is the instruction key and the claim is the GROUP, so a claim shared
   * between sibling cards (live: `MLB-27037` across three) is precisely the case
   * where the PO is the only thing that tells them apart.
   *
   * OPTIONAL, and an omitted value contributes exactly nothing - a caller that
   * cannot reach `jobs.metadata` keeps its previous answer byte for byte.
   */
  builder_po_number?: string | null;
  /** Whether this job is an SES board card. Non-board jobs still contest refs. */
  on_board?: boolean;
}

export interface SesMatchInvoice {
  id: string;
  invoice_number?: string | null;
  reference?: string | null;
  status?: string | null;
  invoice_type?: string | null;
  job_id?: string | null;
  total?: string | number | null;
  invoice_date?: string | null;
}

export interface SesInvoiceMatch {
  job_id: string;
  job_number: string | null;
  external_ref: string | null;
  matched_digits: string[];
  invoice: SesMatchInvoice;
}

export interface SesInvoiceMatchExclusion {
  job_id: string;
  job_number: string | null;
  external_ref: string | null;
  reason: SesInvoiceMatchExclusionReason;
  detail: string;
}

/** Every maximal digit run, e.g. `MLB-26344PO-57087` -> ["26344","57087"]. */
export function digitRuns(value: unknown): string[] {
  return String(value ?? "").match(/\d+/g) ?? [];
}

/**
 * The identity digits a builder reference contributes. A reference carrying
 * several long runs (the `MLB-26344PO-57087` shape) contributes ALL of them, so
 * a card whose reference embeds a purchase order cannot quietly match on the PO
 * half without that being visible in `matched_digits`.
 */
export function builderReferenceDigits(externalRef: unknown): string[] {
  return digitRuns(externalRef).filter((run) =>
    run.length >= SES_MIN_REFERENCE_DIGITS
  );
}

/**
 * Every identity digit run a card contributes: its builder claim reference plus
 * its own declared purchase order, as ONE de-duplicated set.
 *
 * The de-duplication is load-bearing, not tidiness. The commonest live shape is
 * a card whose `external_ref` ALREADY embeds its own purchase order
 * (`MLB-24881PO-56387` with `builder_po_number: PO-56387` - 30 of the 67
 * PO-bearing production rows on 2026-08-07). Concatenating the two sources
 * without a set yields the run `56387` twice, the ownership map below then
 * counts the card as two separate owners of its own digits, guard 2 reads that
 * self-collision as a shared reference, and the card LOSES a correct match. That
 * is not hypothetical: measured against live production, the naive version
 * destroyed SWMS-261018's correct match to its own AUTHORISED INV-1083.
 *
 * Order is claim digits first, then any purchase-order digits the claim did not
 * already carry, so a card with no `builder_po_number` produces the identical
 * array this module produced before the field existed.
 */
export function sesMatchJobIdentityDigits(job: SesMatchJob): string[] {
  return [
    ...new Set([
      ...builderReferenceDigits(job.external_ref),
      ...builderReferenceDigits(job.builder_po_number),
    ]),
  ];
}

/** Whole-digit-run containment. Never a substring test. */
export function invoiceNamesBuilderReference(
  invoiceReference: unknown,
  referenceDigits: readonly string[],
): string[] {
  if (referenceDigits.length === 0) return [];
  const runs = new Set(digitRuns(invoiceReference));
  return referenceDigits.filter((digits) => runs.has(digits));
}

/** An unlinked, issued, ACCREC row: the only shape eligible to be matched. */
export function isUnlinkedIssuedAccrec(invoice: SesMatchInvoice): boolean {
  return !invoice.job_id &&
    String(invoice.invoice_type ?? "").toUpperCase() === "ACCREC" &&
    SES_ISSUED_INVOICE_STATUSES.includes(
      String(invoice.status ?? "").toUpperCase(),
    );
}

/**
 * Map SES board cards to their card-unique unlinked issued ACCREC invoice.
 *
 * Three guards, all of which must hold:
 *
 * 1. Exactly one eligible invoice names the card's identity digits (claim
 *    reference and/or the card's own purchase order - see
 *    `sesMatchJobIdentityDigits`).
 * 2. Those digits are owned by exactly ONE job across the FULL `jobs` table.
 *    Adversarial verification refuted "one invoice candidate" as sufficient:
 *    cards routinely share a builder claim with a sibling, so the candidate set
 *    alone does not prove which card owns the money. Both sides of a contested
 *    reference are excluded - symmetrically, never by picking a winner.
 * 3. No other card claims the same invoice.
 *
 * `jobs` must be the FULL job population, not just board cards, or guard 2
 * silently weakens. Only jobs with `on_board !== false` can receive a match.
 */
export function deriveSesUnlinkedInvoiceMatches(
  jobs: readonly SesMatchJob[],
  invoices: readonly SesMatchInvoice[],
): {
  matches: SesInvoiceMatch[];
  exclusions: SesInvoiceMatchExclusion[];
} {
  const eligible = invoices.filter(isUnlinkedIssuedAccrec);

  // Guard 2 input: how many jobs anywhere claim each digit run.
  const ownersByDigits = new Map<string, SesMatchJob[]>();
  for (const job of jobs) {
    for (const digits of sesMatchJobIdentityDigits(job)) {
      const owners = ownersByDigits.get(digits) ?? [];
      owners.push(job);
      ownersByDigits.set(digits, owners);
    }
  }

  const provisional: SesInvoiceMatch[] = [];
  const exclusions: SesInvoiceMatchExclusion[] = [];

  for (const job of jobs) {
    if (job.on_board === false) continue;
    const referenceDigits = sesMatchJobIdentityDigits(job);
    // No usable builder identity is not an exclusion; there is nothing to match.
    if (referenceDigits.length === 0) continue;

    const candidates = eligible
      .map((invoice) => ({
        invoice,
        matched: invoiceNamesBuilderReference(
          invoice.reference,
          referenceDigits,
        ),
      }))
      .filter((candidate) => candidate.matched.length > 0);

    if (candidates.length === 0) continue;

    if (candidates.length > 1) {
      exclusions.push({
        job_id: job.id,
        job_number: job.job_number ?? null,
        external_ref: job.external_ref ?? null,
        reason: "multiple_invoice_candidates",
        detail: candidates.map((c) => c.invoice.invoice_number ?? c.invoice.id)
          .join(", "),
      });
      continue;
    }

    const contested = candidates[0].matched.filter((digits) =>
      (ownersByDigits.get(digits)?.length ?? 0) > 1
    );
    if (contested.length > 0) {
      const siblings = new Set<string>();
      for (const digits of contested) {
        for (const owner of ownersByDigits.get(digits) ?? []) {
          if (owner.id !== job.id) siblings.add(owner.job_number ?? owner.id);
        }
      }
      exclusions.push({
        job_id: job.id,
        job_number: job.job_number ?? null,
        external_ref: job.external_ref ?? null,
        reason: "builder_reference_shared_with_other_job",
        detail: `contested digits ${contested.join(",")}; also owned by ${
          [...siblings].sort().join(", ")
        }`,
      });
      continue;
    }

    provisional.push({
      job_id: job.id,
      job_number: job.job_number ?? null,
      external_ref: job.external_ref ?? null,
      matched_digits: candidates[0].matched,
      invoice: candidates[0].invoice,
    });
  }

  // Guard 3: one invoice may fund only one card. A contested invoice is removed
  // from every claimant rather than arbitrated here.
  const claims = new Map<string, number>();
  for (const match of provisional) {
    claims.set(match.invoice.id, (claims.get(match.invoice.id) ?? 0) + 1);
  }
  const matches = provisional.filter((match) => {
    if ((claims.get(match.invoice.id) ?? 0) <= 1) return true;
    exclusions.push({
      job_id: match.job_id,
      job_number: match.job_number,
      external_ref: match.external_ref,
      reason: "invoice_claimed_by_multiple_cards",
      detail: `${
        match.invoice.invoice_number ?? match.invoice.id
      } is also claimed by another card`,
    });
    return false;
  });

  return { matches, exclusions };
}

/** Index matches by job id for O(1) lookup by a per-card reader. */
export function indexSesInvoiceMatches(
  matches: readonly SesInvoiceMatch[],
): Map<string, SesInvoiceMatch> {
  return new Map(matches.map((match) => [match.job_id, match]));
}

/**
 * The provenance string the ruler records for a matched-but-unlinked invoice.
 * Kept here so every consumer reports the same wording, and so the reading is
 * always self-describing about WHY the invoice is not linked.
 */
export function sesUnlinkedInvoiceDetail(match: SesInvoiceMatch): string {
  return `card-unique unlinked issued ACCREC ${
    match.invoice.invoice_number ?? match.invoice.id
  } (${String(match.invoice.status ?? "").toUpperCase()}) names builder ` +
    `reference digits ${match.matched_digits.join(",")}; not linked because ` +
    `the SES money seal refuses xero_invoices.job_id writes`;
}
