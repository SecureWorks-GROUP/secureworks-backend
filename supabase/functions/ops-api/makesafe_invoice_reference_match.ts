// Card-unique matching of UNLINKED issued ACCREC invoices to SES cards.
//
// Why this exists
// ---------------
// An SES card's close-out invoice frequently exists in the Xero mirror while
// `xero_invoices.job_id` is still null, so the C1 evidence ruler reads the card
// as having no invoice at all. This pure fallback was introduced while relinks
// were blocked by the former SES money seal. The Captain made that classifier
// inert on 2026-08-13, but historical unlinked rows still need the same unique,
// read-only evidence projection until normal relinking catches them. Earlier
// reasoning:
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

import { type SesWorkRefRelation, splitRefPo } from "./makesafe_send_pack.ts";

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
  | "invoice_claimed_by_multiple_cards"
  | "po_mismatch";

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

/**
 * A card-unique candidate the matcher will NOT call a match because the
 * purchase-order evidence is one-sided: the card names a PO and the invoice
 * does not, or the reverse (`sesMatchPoRelation` -> `po_indeterminate`). One
 * claim routinely hosts several POs, so the claim digits alone cannot prove the
 * money is this card's, and keeping the candidate visible is not proof that it
 * is (DSP-T3-GAP-1, Codex 19 Oct 2026). It is reported on its own list so no
 * consumer reading `matches` can treat it as an accepted match; a person
 * decides.
 */
export interface SesInvoiceManualReview extends SesInvoiceMatch {
  review_status: "manual_review";
  reason: "po_indeterminate";
  detail: string;
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
 * The purchase orders a card declares: the PO token in its own claim
 * reference and its `builder_po_number`. The PO grammar is the deployed
 * duplicate guard's (`splitRefPo`, `makesafe_send_pack.ts`), consumed rather
 * than restated. A bare all-digit `builder_po_number` is that card's PO too:
 * the field holds nothing else.
 */
export function sesMatchJobPurchaseOrders(job: SesMatchJob): string[] {
  const pos = new Set<string>();
  const fromRef = splitRefPo(job.external_ref).po;
  if (fromRef) pos.add(fromRef);
  const declared = String(job.builder_po_number ?? "").trim();
  const fromField = splitRefPo(declared).po ??
    (/^\d+$/.test(declared) ? declared : null);
  if (fromField) pos.add(fromField);
  return [...pos];
}

/**
 * How a candidate invoice's purchase order relates to the card's, in the
 * deployed guard's vocabulary (`SesWorkRefRelation`). The claim side is already
 * settled by the digit-run match, so this answers only the PO question:
 *
 * - `same_work`        both sides name no PO, or the invoice names one of the
 *                      card's own POs
 * - `distinct_po`      both name a PO and they differ: other work on the claim
 * - `po_indeterminate` exactly one side names a PO
 *
 * Only `distinct_po` excludes a match (guard 4). `po_indeterminate` stays
 * matchable because the 51-card production cohort carries one such genuine
 * match (a PO-bearing invoice on a card that declares none); a reader that must
 * hold one-sided pairs reads this function instead.
 */
export function sesMatchPoRelation(
  job: SesMatchJob,
  invoice: SesMatchInvoice,
): Exclude<SesWorkRefRelation, "unrelated"> {
  const cardPos = sesMatchJobPurchaseOrders(job);
  const invoicePo = splitRefPo(invoice.reference).po;
  if (cardPos.length === 0 && !invoicePo) return "same_work";
  if (cardPos.length > 0 && invoicePo) {
    return cardPos.includes(invoicePo) ? "same_work" : "distinct_po";
  }
  return "po_indeterminate";
}

/**
 * Map SES board cards to their card-unique unlinked issued ACCREC invoice.
 *
 * Five guards, all of which must hold:
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
 * 4. The invoice does not name a different purchase order from the card's own
 *    (`sesMatchPoRelation` -> `distinct_po`). One claim routinely hosts several
 *    POs, so the shared claim digits alone do not prove the money is this
 *    card's (DSP-T3-GAP-1, 19 Oct 2026).
 * 5. Both sides agree on the purchase order, or neither names one. A pair where
 *    only one side names a PO (`po_indeterminate`) is reported in
 *    `manual_review`, never in `matches`.
 *
 * Guards 4 and 5 run AFTER guard 3 counts every claimant, so a card they
 * refuse still contests its invoice: neither PO guard can create a match main
 * refuses.
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
  manual_review: SesInvoiceManualReview[];
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
  // from every claimant rather than arbitrated here. It counts EVERY claimant
  // before the PO guards drop any: a card the PO guards would refuse still
  // contests the invoice, or dropping it would hand the invoice to the other
  // claimant and CREATE a match main refuses (V's B1 on fad6a11).
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  const claims = new Map<string, number>();
  for (const match of provisional) {
    claims.set(match.invoice.id, (claims.get(match.invoice.id) ?? 0) + 1);
  }
  const uncontested = provisional.filter((match) => {
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

  // Guard 4: same claim, different purchase order is other work.
  const survivors = uncontested.filter((match) => {
    const job = jobsById.get(match.job_id);
    // A card missing from the index cannot be PO-checked; guard 5 holds it.
    if (!job || sesMatchPoRelation(job, match.invoice) !== "distinct_po") {
      return true;
    }
    exclusions.push({
      job_id: match.job_id,
      job_number: match.job_number,
      external_ref: match.external_ref,
      reason: "po_mismatch",
      detail: `${match.invoice.invoice_number ?? match.invoice.id} names PO ${
        splitRefPo(match.invoice.reference).po
      }; card declares ${sesMatchJobPurchaseOrders(job).join(",")}`,
    });
    return false;
  });

  // Guard 5: one-sided purchase-order evidence is never an accepted match. It
  // runs after guard 3 so a contested invoice is still excluded outright.
  const matches: SesInvoiceMatch[] = [];
  const manual_review: SesInvoiceManualReview[] = [];
  for (const match of survivors) {
    const job = jobsById.get(match.job_id);
    // Fail closed: only a PO-checked same_work pair is an accepted match.
    if (job && sesMatchPoRelation(job, match.invoice) === "same_work") {
      matches.push(match);
      continue;
    }
    const cardPos = job ? sesMatchJobPurchaseOrders(job) : [];
    const invoicePo = splitRefPo(match.invoice.reference).po;
    manual_review.push({
      ...match,
      review_status: "manual_review",
      reason: "po_indeterminate",
      detail: invoicePo
        ? `${
          match.invoice.invoice_number ?? match.invoice.id
        } names PO ${invoicePo}; card declares no PO`
        : `${
          match.invoice.invoice_number ?? match.invoice.id
        } names no PO; card declares ${cardPos.join(",")}`,
    });
  }

  return { matches, exclusions, manual_review };
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
