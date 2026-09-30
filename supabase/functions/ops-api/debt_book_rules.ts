// Debt book rules: which open Xero invoices are debt, who pays them, how old they are,
// and which are held back from chasing. Pure logic, no I/O.
// Plan: docs/debt-book/PLAN.md section 3 (the captain's rulings are word for word in
// docs/debt-book/DECISIONS.md). Acceptance: debt_book_rules_test.ts against the 29 Sep
// 2026 book (debt_book_fixture_2026_09_29.ts).
//
// The rules are applied in order:
//   1. scope: ACCREC, AUTHORISED, AmountDue > 0, read live from Xero;
//   2. payer from the Xero contact (DEBT_BOOK_PAYERS, data not code);
//   3. builder invoices are debt except SAMPLE- test invoices;
//   4. client invoices: the first matching kind wins, then the captain's named
//      corrections (DEBT_BOOK_CORRECTIONS) override a wrong label;
//   5. a client final on an unfinished job is "check first", never dropped;
//   6. overdue means the Perth date is after the due date; no due date is its own bucket;
//   7. holds keep an invoice in the figure but give it no chase draft (check first: the named
//      doubts and desk classes in_dispute, not_owed, blocked_by_us and bad_debt; fix first:
//      rectification).

export type DebtBookPayerKey =
  | "client"
  | "mlb"
  | "aj"
  | "other_builder"
  | "not_chased";
export type DebtBookKind =
  | "builder"
  | "final"
  | "variation"
  | "part_payment"
  | "progress_claim"
  | "materials"
  | "deposit"
  | "plan_fee"
  | "unclear"
  | "test"
  | "out_of_scope";
export type DebtBookNotDebtReason =
  | "deposit"
  | "before_first_payment"
  | "not_chased"
  | "test_invoice"
  | "left_aside"
  | "plan_fee"
  | "unclear"
  | "out_of_scope";
export type DebtBookBuilderWork =
  | "make_safe"
  | "roof_report"
  | "assessment_report"
  | "repair";
export type DebtBookAgeBucket =
  | "not_due"
  | "1_30"
  | "31_60"
  | "61_90"
  | "90_plus"
  | "no_due_date";
export type DebtBookHoldKind = "check_first" | "fix_first";
export type DebtBookHoldCode =
  | "named_doubt"
  | "desk_class"
  | "final_on_unfinished_job"
  | "rectification";

export const DEBT_BOOK_PAYER_ORDER: Array<
  Exclude<DebtBookPayerKey, "not_chased">
> = ["client", "mlb", "aj", "other_builder"];
export const DEBT_BOOK_AGE_BUCKETS: DebtBookAgeBucket[] = [
  "not_due",
  "1_30",
  "31_60",
  "61_90",
  "90_plus",
  "no_due_date",
];
export const DEBT_BOOK_NOT_DEBT_REASONS: DebtBookNotDebtReason[] = [
  "deposit",
  "before_first_payment",
  "not_chased",
  "test_invoice",
  "left_aside",
  "plan_fee",
  "unclear",
  "out_of_scope",
];

/** Payer table: one row per Xero contact. Anyone not listed is a client. A new builder contact is one line here. */
export const DEBT_BOOK_PAYERS: ReadonlyArray<
  {
    contact_name: string;
    payer: Exclude<DebtBookPayerKey, "client">;
    label: string;
    decision: string;
  }
> = [
  {
    contact_name: "Major Loss Builders",
    payer: "mlb",
    label: "MLB",
    decision:
      'round 4: "MLB invoices concerned are Major Loss Builders (the xero contact)"',
  },
  {
    contact_name: "ML Builders",
    payer: "not_chased",
    label: "ML Builders (old MLB contact, not chased)",
    decision: 'round 4: "Others are irrelevant"',
  },
  {
    contact_name: "AJ Building & Restoration",
    payer: "aj",
    label: "AJ",
    decision: 'round 1 (D1): "obv AJ make safes to AJ"',
  },
  {
    contact_name: "Insurebuild Pty Ltd WA (AJ Building & Restoration)",
    payer: "aj",
    label: "AJ",
    decision:
      "round 1 (D1); PLAN.md risks: AJ's two contacts count as one payer",
  },
  {
    contact_name: "Emergency Trade Services",
    payer: "other_builder",
    label: "Emergency Trade Services",
    decision: "round 1 (D4): builders sit in the same book",
  },
  {
    contact_name: "Builderwest Pty Ltd",
    payer: "other_builder",
    label: "Builderwest",
    decision: "round 1 (D4)",
  },
  {
    contact_name: "Builderwest Pty Ltd ATF Builderwest Unit Trust",
    payer: "other_builder",
    label: "Builderwest",
    decision: "round 1 (D4)",
  },
  {
    contact_name: "Western Building Pty Ltd",
    payer: "other_builder",
    label: "Western Building",
    decision: "round 1 (D4)",
  },
];

/**
 * The captain's corrections to invoices whose label is wrong or unclear. Each names its
 * reason and the decision it came from. The real fix is at the source (plan step 10);
 * until then this list is the authority for these invoices.
 */
export const DEBT_BOOK_CORRECTIONS: ReadonlyArray<{
  invoice_number: string;
  kind: DebtBookKind;
  counts_as_debt: boolean;
  not_debt_reason?: DebtBookNotDebtReason;
  start_step?: "jan";
  reason: string;
  decision: string;
}> = [
  {
    invoice_number: "INV-1011",
    kind: "part_payment",
    counts_as_debt: true,
    reason: "labelled a deposit but it is a part payment on a finished job",
    decision:
      'Q16, 2026-09-29: "1011 however,is a part payment, that is a debt."',
  },
  {
    invoice_number: "INV-1477",
    kind: "deposit",
    counts_as_debt: false,
    not_debt_reason: "deposit",
    reason: "Perth Zoo: labelled a progress claim but it is really a deposit",
    decision: 'round 4, 2026-09-30: "no no, this is a deposit."',
  },
  {
    invoice_number: "INV-1601",
    kind: "deposit",
    counts_as_debt: false,
    not_debt_reason: "deposit",
    reason: "deposit raised late to match a bank transfer already received",
    decision: 'Q16, 2026-09-29: "1601-3 are deposit invoices made late"',
  },
  {
    invoice_number: "INV-1602",
    kind: "deposit",
    counts_as_debt: false,
    not_debt_reason: "deposit",
    reason: "deposit raised late to match a bank transfer already received",
    decision: 'Q16, 2026-09-29: "1601-3 are deposit invoices made late"',
  },
  {
    invoice_number: "INV-1603",
    kind: "deposit",
    counts_as_debt: false,
    not_debt_reason: "deposit",
    reason: "deposit raised late to match a bank transfer already received",
    decision: 'Q16, 2026-09-29: "1601-3 are deposit invoices made late"',
  },
  {
    invoice_number: "INV-0034",
    kind: "final",
    counts_as_debt: true,
    start_step: "jan",
    reason: 'old "50% of quote" invoice already on Jan\'s list',
    decision: 'round 6, 2026-09-30: "first 2 are Jan\'s list already"',
  },
  {
    invoice_number: "INV-0267",
    kind: "final",
    counts_as_debt: true,
    start_step: "jan",
    reason: 'old "50% of quote" invoice already on Jan\'s list',
    decision: 'round 6, 2026-09-30: "first 2 are Jan\'s list already"',
  },
  {
    invoice_number: "INV-0177",
    kind: "unclear",
    counts_as_debt: false,
    not_debt_reason: "left_aside",
    reason:
      'old "% of quote" invoice our notes say was paid by bank transfer; left aside, not chased',
    decision: 'round 6, 2026-09-30: "other 2 leave first."',
  },
  {
    invoice_number: "INV-1486",
    kind: "plan_fee",
    counts_as_debt: false,
    not_debt_reason: "left_aside",
    reason: "planning fee; left aside, not chased",
    decision: 'round 6, 2026-09-30: "other 2 leave first."',
  },
];

/** Invoices still owed in Xero that our notes doubt: they stay in the figure but get no draft until Shaun checks them. */
export const DEBT_BOOK_CHECK_FIRST: ReadonlyArray<
  { invoice_number: string; reason: string; decision: string }
> = [
  {
    invoice_number: "INV-0938",
    reason:
      "Emergency Trade Services: same PO1479 reference and total as INV-1481, probably invoiced twice",
    decision: "PLAN.md section 2, check first list (debt-baseline-s2 3.4 C)",
  },
  {
    invoice_number: "INV-1481",
    reason:
      "Emergency Trade Services: same PO1479 reference and total as INV-0938, on the known-duplicate list",
    decision: "PLAN.md section 2, check first list (debt-baseline-s2 3.4 C)",
  },
  {
    invoice_number: "INV-1424",
    reason:
      "Emergency Trade Services: shares PO9066 with INV-1829, both carry a fence retrieval fee",
    decision: "PLAN.md section 2, check first list (debt-baseline-s2 3.4 C)",
  },
  {
    invoice_number: "INV-1829",
    reason:
      "Emergency Trade Services: shares PO9066 with INV-1424, both carry a fence retrieval fee",
    decision: "PLAN.md section 2, check first list (debt-baseline-s2 3.4 C)",
  },
  {
    invoice_number: "INV-0597",
    reason: "Builderwest rejected it: missing PO, job number and photos",
    decision: "PLAN.md section 2, check first list (debt-baseline-s2 3.4 C)",
  },
  {
    invoice_number: "INV-0702",
    reason: "Builderwest rejected it: missing PO, job number and photos",
    decision: "PLAN.md section 2, check first list (debt-baseline-s2 3.4 C)",
  },
  {
    invoice_number: "INV-1456",
    reason: "MLB: in dispute, a sibling of disputed INV-1504",
    decision: "PLAN.md section 2, check first list (debt-baseline-s2 3.4 C)",
  },
  {
    invoice_number: "INV-0080",
    reason:
      "desk notes say the client overpaid ($275.28 received against $231 owed)",
    decision:
      "PLAN.md section 2, check first list (debt-baseline-s2 section 5)",
  },
];

/** Job statuses that mean the work is finished (rectification included, per the captain). */
export const DEBT_BOOK_FINISHED_JOB_STATUSES = [
  "complete",
  "invoiced",
  "final_payment",
  "archived",
  "rectification",
] as const;
/**
 * Clear Debt desk classes that put a debt invoice on "check first". bad_debt is held too:
 * a write-off is only Shaun's, in Xero (Q15), so nothing chases it until he has checked it.
 */
export const DEBT_BOOK_HOLD_DESK_CLASSES = [
  "in_dispute",
  "not_owed",
  "blocked_by_us",
  "bad_debt",
] as const;

export interface DebtBookInvoice {
  xero_invoice_id: string;
  invoice_number: string;
  type: string;
  status: string;
  contact_id: string | null;
  contact_name: string;
  reference: string;
  line_descriptions: string[];
  line_count?: number;
  invoice_date: string | null;
  due_date: string | null;
  total: number | null;
  amount_due: number;
  amount_paid: number | null;
  amount_credited: number | null;
  online_invoice_url?: string | null;
}

export interface DebtBookJobContext {
  job_id?: string | null;
  job_number: string | null;
  job_status: string | null;
  /**
   * true when the job has had any money: jobs.deposit_at, a PAID sales invoice, or an
   * amount paid on this or any other sales invoice of the job; null when not known.
   */
  first_payment: boolean | null;
  link_source: "copy_job_id" | "reference_job_number" | null;
  /** The Clear Debt desk class on our copy of the invoice (xero_invoices.debt_classification). */
  desk_class: string | null;
}

export interface DebtBookHoldReason {
  code: DebtBookHoldCode;
  kind: DebtBookHoldKind;
  reason: string;
}

export interface DebtBookClassification {
  in_scope: boolean;
  payer: { key: DebtBookPayerKey; label: string; contact_name: string };
  kind: DebtBookKind;
  builder_work: DebtBookBuilderWork | null;
  counts_as_debt: boolean;
  not_debt_reason: DebtBookNotDebtReason | null;
  overdue: boolean;
  days_overdue: number | null;
  age_bucket: DebtBookAgeBucket;
  hold: { kind: DebtBookHoldKind; reasons: DebtBookHoldReason[] } | null;
  start_step: "jan" | null;
  corrections: Array<
    { invoice_number: string; reason: string; decision: string }
  >;
  /** Plain-English reasons, in rule order. The first is the payer, the last the age. */
  reasons: string[];
}

// ── Helpers ──

const norm = (s: unknown) =>
  String(s ?? "").trim().replace(/\s+/g, " ").toLowerCase();

export function perthDate(at: Date): string {
  return new Date(at.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}

export function perthTimestamp(at: Date): string {
  return new Date(at.getTime() + 8 * 3600_000).toISOString().slice(0, 19) +
    "+08:00";
}

function dayNumber(isoDate: string): number {
  return Math.round(Date.parse(isoDate + "T00:00:00Z") / 86_400_000);
}

const cents = (n: unknown) => Math.round(Number(n || 0) * 100);
const dollars = (c: number) => Math.round(c) / 100;
const fmtMoney = (c: number) =>
  "$" +
  (c / 100).toLocaleString("en-AU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

export function resolvePayer(
  contactName: string,
): { key: DebtBookPayerKey; label: string } {
  const n = norm(contactName);
  const hit = DEBT_BOOK_PAYERS.find((p) => norm(p.contact_name) === n);
  return hit
    ? { key: hit.payer, label: hit.label }
    : { key: "client", label: "Client" };
}

/** Reference split into tokens: "SWF-26624-B-BAL" -> SWF, 26624, B, BAL. */
function tokens(reference: string): string[] {
  return reference.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
}

function builderWork(inv: DebtBookInvoice): DebtBookBuilderWork {
  const text = [inv.reference, ...inv.line_descriptions].join("\n")
    .toLowerCase();
  if (text.includes("roof report")) return "roof_report";
  if (text.includes("assessment report")) return "assessment_report";
  if (
    /supply and install|(remove|strip),? dispose and replace|polycarbonate roof sheets|colorbond fencing installation/
      .test(text)
  ) return "repair";
  return "make_safe";
}

function clientKind(inv: DebtBookInvoice): { kind: DebtBookKind; why: string } {
  const t = tokens(inv.reference);
  const lines = inv.line_descriptions.map((l) => l.trim().toLowerCase());
  const has = (re: RegExp) => t.some((x) => re.test(x));
  if (has(/^PROG$/)) {
    return {
      kind: "progress_claim",
      why: "reference carries PROG: a progress claim",
    };
  }
  if (has(/^MAT(50)?$/)) {
    return {
      kind: "materials",
      why: "reference carries MAT: a materials invoice",
    };
  }
  if (has(/^VAR\d*$/)) {
    return { kind: "variation", why: "reference carries VAR: a variation" };
  }
  if (
    !inv.reference.trim() &&
    lines.some((l) => l.includes("extra labour and material"))
  ) {
    return {
      kind: "variation",
      why:
        'no reference and the line reads "Extra Labour and Material": a variation',
    };
  }
  if (has(/^DEP\d*$/)) {
    return { kind: "deposit", why: "reference carries DEP: a deposit" };
  }
  if (lines.some((l) => l.startsWith("deposit"))) {
    return { kind: "deposit", why: 'a line starts "Deposit": a deposit' };
  }
  if (has(/^(FINBAL\d*|FINAL|BAL)$/)) {
    return {
      kind: "final",
      why: "reference carries FINBAL, FINAL or -BAL: a final invoice",
    };
  }
  if (
    lines.some((l) =>
      l.startsWith("balance") || l.includes("remaining quote amount")
    )
  ) {
    return {
      kind: "final",
      why:
        'a line starts "Balance" or reads "Remaining quote amount": a final invoice',
    };
  }
  if (has(/^PRIVATE$/)) {
    return {
      kind: "final",
      why:
        "reference carries PRIVATE: a final invoice for finished private work",
    };
  }
  if (has(/^PLAN$/)) {
    return { kind: "plan_fee", why: "reference carries PLAN: a planning fee" };
  }
  if (lines.some((l) => /\d+\s*%\s*of\s*quote/.test(l))) {
    return {
      kind: "unclear",
      why:
        'an old "N% of quote" line with no kind token: unclear, not debt by default',
    };
  }
  return {
    kind: "unclear",
    why:
      "no kind token in the reference or line text: unclear, not debt by default",
  };
}

function ageOf(
  dueDate: string | null,
  perth: string,
): { days: number | null; bucket: DebtBookAgeBucket } {
  if (!dueDate || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
    return { days: null, bucket: "no_due_date" };
  }
  const days = dayNumber(perth) - dayNumber(dueDate);
  if (days <= 0) return { days, bucket: "not_due" };
  if (days <= 30) return { days, bucket: "1_30" };
  if (days <= 60) return { days, bucket: "31_60" };
  if (days <= 90) return { days, bucket: "61_90" };
  return { days, bucket: "90_plus" };
}

// ── The rules ──

export function classifyDebtBookInvoice(
  inv: DebtBookInvoice,
  job: DebtBookJobContext,
  opts: { perthDate: string },
): DebtBookClassification {
  const payer = resolvePayer(inv.contact_name);
  const reasons: string[] = [];
  const age = ageOf(inv.due_date, opts.perthDate);
  const base = {
    payer: { ...payer, contact_name: inv.contact_name },
    builder_work: null as DebtBookBuilderWork | null,
    overdue: false,
    days_overdue: age.days,
    age_bucket: age.bucket,
    hold: null,
    start_step: null,
    corrections: [] as DebtBookClassification["corrections"],
  };

  // 1. Scope.
  if (
    inv.type !== "ACCREC" || inv.status !== "AUTHORISED" ||
    !(Number(inv.amount_due) > 0)
  ) {
    return {
      ...base,
      in_scope: false,
      kind: "out_of_scope",
      counts_as_debt: false,
      not_debt_reason: "out_of_scope",
      reasons: [
        `Not in the open book: ${inv.type} ${inv.status}, ${
          fmtMoney(cents(inv.amount_due))
        } due`,
      ],
    };
  }

  // 2. Payer.
  reasons.push(
    payer.key === "client"
      ? `Payer: the client (Xero contact "${inv.contact_name}")`
      : `Payer: ${payer.label} (Xero contact "${inv.contact_name}")`,
  );

  let kind: DebtBookKind;
  let counts: boolean;
  let notDebt: DebtBookNotDebtReason | null = null;
  let work: DebtBookBuilderWork | null = null;
  let startStep: "jan" | null = null;
  const corrections: DebtBookClassification["corrections"] = [];

  if (payer.key === "not_chased") {
    kind = "builder";
    counts = false;
    notDebt = "not_chased";
    reasons.push(
      'Not debt: only the "Major Loss Builders" contact counts for MLB; this contact is listed apart and not chased (captain, round 4)',
    );
  } else if (payer.key !== "client") {
    // 3. Builder invoices.
    if (/SAMPLE-/i.test(inv.reference)) {
      kind = "test";
      counts = false;
      notDebt = "test_invoice";
      reasons.push("Not debt: a test invoice (reference contains SAMPLE-)");
    } else {
      kind = "builder";
      work = builderWork(inv);
      counts = true;
      reasons.push(
        `Debt: builder invoice for ${
          work.replace(/_/g, " ").replace("make safe", "make-safe")
        } work already done`,
      );
    }
  } else {
    // 4. Client invoices.
    const detected = clientKind(inv);
    kind = detected.kind;
    const correction = DEBT_BOOK_CORRECTIONS.find((c) =>
      c.invoice_number === inv.invoice_number
    );
    if (correction) {
      corrections.push({
        invoice_number: correction.invoice_number,
        reason: correction.reason,
        decision: correction.decision,
      });
      kind = correction.kind;
      counts = correction.counts_as_debt;
      notDebt = correction.counts_as_debt
        ? null
        : correction.not_debt_reason ?? "unclear";
      startStep = correction.start_step ?? null;
      reasons.push(`Label says: ${detected.why}`);
      reasons.push(
        `${
          counts ? "Debt" : "Not debt"
        }: the captain's correction, ${correction.reason} (${correction.decision})`,
      );
      if (startStep === "jan") {
        reasons.push("Starts at the Jan step: already on Jan's list");
      }
    } else if (kind === "progress_claim" || kind === "materials") {
      counts = job.first_payment === true;
      if (counts) {
        reasons.push(
          `Debt: ${detected.why}, and the job has had its first payment`,
        );
      } else {
        notDebt = "before_first_payment";
        reasons.push(
          job.first_payment === false
            ? `Not debt: ${detected.why}, and the job has had no first payment yet (deposits list)`
            : `Not debt: ${detected.why}, and no first payment on the job could be shown${
              job.job_number ? "" : " (no job linked)"
            } (deposits list)`,
        );
      }
    } else if (kind === "final" || kind === "variation") {
      counts = true;
      reasons.push(`Debt: ${detected.why}`);
    } else {
      counts = false;
      notDebt = kind === "deposit"
        ? "deposit"
        : kind === "plan_fee"
        ? "plan_fee"
        : "unclear";
      reasons.push(`Not debt: ${detected.why}`);
    }
  }

  // 5-7. Job, holds.
  const holds: DebtBookHoldReason[] = [];
  if (counts) {
    const status = job.job_status ? String(job.job_status).toLowerCase() : null;
    const jobText = job.job_number
      ? `job ${job.job_number} is ${status ?? "of unknown status"}`
      : status
      ? `the linked job is ${status}`
      : "no job is linked";
    const named = DEBT_BOOK_CHECK_FIRST.find((c) =>
      c.invoice_number === inv.invoice_number
    );
    if (named) {
      holds.push({
        code: "named_doubt",
        kind: "check_first",
        reason: named.reason,
      });
    }
    if (status === "rectification") {
      holds.push({
        code: "rectification",
        kind: "fix_first",
        reason:
          "the job is in rectification: it counts, but no chase until the fix is done (captain, round 6)",
      });
    }
    if (
      job.desk_class &&
      (DEBT_BOOK_HOLD_DESK_CLASSES as readonly string[]).includes(
        job.desk_class,
      )
    ) {
      holds.push({
        code: "desk_class",
        kind: "check_first",
        reason: `the Clear Debt desk marks it ${
          job.desk_class.replace(/_/g, " ")
        }`,
      });
    }
    if (
      payer.key === "client" && kind === "final" &&
      !(status &&
        (DEBT_BOOK_FINISHED_JOB_STATUSES as readonly string[]).includes(status))
    ) {
      holds.push({
        code: "final_on_unfinished_job",
        kind: "check_first",
        reason: `a final invoice but ${jobText}, not a finished job`,
      });
    }
    if (payer.key === "client") {
      reasons.push(
        `Job: ${jobText}${
          job.link_source === "reference_job_number"
            ? " (linked by the job number in the reference)"
            : ""
        }`,
      );
    }
  }
  const hold = holds.length
    ? {
      kind: holds.some((h) => h.code === "named_doubt")
        ? "check_first" as const
        : holds.some((h) => h.kind === "fix_first")
        ? "fix_first" as const
        : "check_first" as const,
      reasons: holds,
    }
    : null;
  if (hold) {
    reasons.push(
      `${hold.kind === "fix_first" ? "Fix first" : "Check first"}: ${
        holds.map((h) => h.reason).join("; ")
      }`,
    );
  }

  // 6. Age by Perth date.
  const overdue = age.days !== null && age.days > 0;
  reasons.push(
    age.days === null
      ? "No due date"
      : overdue
      ? `Overdue ${age.days} day${
        age.days === 1 ? "" : "s"
      } (due ${inv.due_date}, Perth date ${opts.perthDate})`
      : `Not due yet (due ${inv.due_date}, Perth date ${opts.perthDate})`,
  );

  return {
    ...base,
    in_scope: true,
    kind,
    builder_work: work,
    counts_as_debt: counts,
    not_debt_reason: counts ? null : notDebt,
    overdue,
    hold,
    start_step: startStep,
    corrections,
    reasons,
  };
}

/** One-line reason for the screen: the rule that decided debt or not debt. */
export function debtBookHeadlineReason(c: DebtBookClassification): string {
  return c.reasons.find((r) => /^(Debt|Not debt)/.test(r)) ?? c.reasons[0] ??
    "";
}

// ── Normalising a raw Xero invoice (server-side trim) ──

const MAX_LINES = 5;
const MAX_LINE_CHARS = 200;

function xeroDate(dateString: unknown, msDate: unknown): string | null {
  if (typeof dateString === "string" && /^\d{4}-\d{2}-\d{2}/.test(dateString)) {
    return dateString.slice(0, 10);
  }
  if (typeof msDate === "string") {
    const m = /\/Date\((-?\d+)(?:[+-]\d{4})?\)\//.exec(msDate);
    if (m) return new Date(Number(m[1])).toISOString().slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}/.test(msDate)) return msDate.slice(0, 10);
  }
  return null;
}

const num = (
  v: unknown,
) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function normaliseXeroInvoice(
  // deno-lint-ignore no-explicit-any
  raw: Record<string, any>,
): DebtBookInvoice & { line_count: number } {
  const lines: unknown[] = Array.isArray(raw.LineItems) ? raw.LineItems : [];
  const descriptions = lines
    .map((
      l,
    ) => (l && typeof l === "object"
      ? String((l as Record<string, unknown>).Description ?? "").trim()
      : "")
    )
    .filter(Boolean);
  const contact = raw.Contact && typeof raw.Contact === "object"
    ? raw.Contact
    : {};
  return {
    xero_invoice_id: String(raw.InvoiceID ?? "").toLowerCase(),
    invoice_number: String(raw.InvoiceNumber ?? ""),
    type: String(raw.Type ?? ""),
    status: String(raw.Status ?? ""),
    contact_id: contact.ContactID
      ? String(contact.ContactID).toLowerCase()
      : null,
    contact_name: String(contact.Name ?? "").trim(),
    reference: String(raw.Reference ?? "").trim(),
    line_descriptions: descriptions.slice(0, MAX_LINES).map((d) =>
      d.slice(0, MAX_LINE_CHARS)
    ),
    line_count: lines.length,
    invoice_date: xeroDate(raw.DateString, raw.Date),
    due_date: xeroDate(raw.DueDateString, raw.DueDate),
    total: num(raw.Total),
    amount_due: num(raw.AmountDue) ?? 0,
    amount_paid: num(raw.AmountPaid),
    amount_credited: num(raw.AmountCredited),
  };
}

// ── Summary ──

type Tally = { count: number; amount: number };
type TallyWithInvoices = Tally & { invoices: string[] };

export function summariseDebtBook(
  rows: Array<
    { invoice: DebtBookInvoice; classification: DebtBookClassification }
  >,
) {
  const t = () => ({ n: 0, c: 0 });
  const add = (x: { n: number; c: number }, c: number) => {
    x.n += 1;
    x.c += c;
  };
  const out = (x: { n: number; c: number }): Tally => ({
    count: x.n,
    amount: dollars(x.c),
  });

  const open = t(),
    debt = t(),
    overdue = t(),
    overdueChaseable = t(),
    noDue = t(),
    notDebt = t(),
    chaseable = t();
  const notDebtBy = Object.fromEntries(
    DEBT_BOOK_NOT_DEBT_REASONS.map((r) => [r, { ...t(), inv: [] as string[] }]),
  );
  const holds = {
    check_first: { ...t(), inv: [] as string[] },
    fix_first: { ...t(), inv: [] as string[] },
  };
  const payers = Object.fromEntries(
    DEBT_BOOK_PAYER_ORDER.map((p) => [p, { all: t(), overdue: t() }]),
  );
  const ages = Object.fromEntries(
    DEBT_BOOK_AGE_BUCKETS.map((
      b,
    ) => [b, {
      all: t(),
      by: Object.fromEntries(DEBT_BOOK_PAYER_ORDER.map((p) => [p, t()])),
    }]),
  );

  for (const { invoice, classification: c } of rows) {
    const amt = cents(invoice.amount_due);
    if (!c.in_scope) {
      add(notDebtBy.out_of_scope, amt);
      notDebtBy.out_of_scope.inv.push(invoice.invoice_number);
      continue;
    }
    add(open, amt);
    if (!c.counts_as_debt) {
      const r = c.not_debt_reason ?? "unclear";
      add(notDebt, amt);
      add(notDebtBy[r], amt);
      notDebtBy[r].inv.push(invoice.invoice_number);
      continue;
    }
    add(debt, amt);
    const p = c.payer.key as Exclude<DebtBookPayerKey, "not_chased">;
    add(payers[p].all, amt);
    add(ages[c.age_bucket].all, amt);
    add(ages[c.age_bucket].by[p], amt);
    if (c.age_bucket === "no_due_date") add(noDue, amt);
    if (c.overdue) {
      add(overdue, amt);
      add(payers[p].overdue, amt);
      if (!c.hold) add(overdueChaseable, amt);
    }
    if (c.hold) {
      add(holds[c.hold.kind], amt);
      holds[c.hold.kind].inv.push(invoice.invoice_number);
    } else add(chaseable, amt);
  }

  const withInvoices = (
    x: { n: number; c: number; inv: string[] },
  ): TallyWithInvoices => ({ ...out(x), invoices: [...x.inv].sort() });
  return {
    open_in_xero: out(open),
    debt: {
      ...out(debt),
      overdue_count: overdue.n,
      overdue_amount: dollars(overdue.c),
      overdue_chaseable_count: overdueChaseable.n,
      overdue_chaseable_amount: dollars(overdueChaseable.c),
      chaseable_count: chaseable.n,
      chaseable_amount: dollars(chaseable.c),
      no_due_date: out(noDue),
    },
    not_debt: {
      ...out(notDebt),
      by_reason: Object.fromEntries(
        DEBT_BOOK_NOT_DEBT_REASONS.map((r) => [r, withInvoices(notDebtBy[r])]),
      ) as Record<DebtBookNotDebtReason, TallyWithInvoices>,
    },
    holds: {
      check_first: withInvoices(holds.check_first),
      fix_first: withInvoices(holds.fix_first),
    },
    by_payer: DEBT_BOOK_PAYER_ORDER.map((p) => ({
      payer: p,
      count: payers[p].all.n,
      amount: dollars(payers[p].all.c),
      overdue_count: payers[p].overdue.n,
      overdue_amount: dollars(payers[p].overdue.c),
    })),
    by_age: DEBT_BOOK_AGE_BUCKETS.map((b) => ({
      bucket: b,
      all: out(ages[b].all),
      by_payer: Object.fromEntries(
        DEBT_BOOK_PAYER_ORDER.map((p) => [p, out(ages[b].by[p])]),
      ) as Record<Exclude<DebtBookPayerKey, "not_chased">, Tally>,
    })),
  };
}

// ── Our copy (xero_invoices) against Xero ──

export interface DebtBookCopyRow {
  xero_invoice_id: string;
  invoice_number: string | null;
  status: string | null;
  amount_due: number | null;
  due_date: string | null;
  synced_at: string | null;
}

const copyOpen = (r: DebtBookCopyRow) =>
  r.status === "AUTHORISED" && Number(r.amount_due || 0) > 0;

/**
 * Compare the live Xero open book with our copy. `copyRows` should hold the copy's row for
 * every Xero invoice plus every row the copy believes is open. Xero wins (D2); this only
 * reports how far the copy has drifted.
 */
export function diffDebtBookCopy(
  xero: DebtBookInvoice[],
  copyRows: DebtBookCopyRow[],
  opts: { readAt: string },
) {
  const open = xero.filter((i) =>
    i.type === "ACCREC" && i.status === "AUTHORISED" && i.amount_due > 0
  );
  const xeroIds = new Set(open.map((i) => i.xero_invoice_id.toLowerCase()));
  const copy = new Map<string, DebtBookCopyRow>();
  for (const r of copyRows) {
    copy.set(String(r.xero_invoice_id).toLowerCase(), r);
  }

  const missing: Array<
    { xero_invoice_id: string; invoice_number: string; xero_amount_due: number }
  > = [];
  const notOpen: Array<
    {
      xero_invoice_id: string;
      invoice_number: string;
      xero_amount_due: number;
      copy_status: string | null;
      copy_amount_due: number;
      copy_synced_at: string | null;
    }
  > = [];
  const amountDiffers: Array<
    {
      xero_invoice_id: string;
      invoice_number: string;
      xero_amount_due: number;
      copy_amount_due: number;
    }
  > = [];
  const dueDiffers: Array<
    {
      xero_invoice_id: string;
      invoice_number: string;
      xero_due_date: string | null;
      copy_due_date: string | null;
    }
  > = [];
  const stale: Array<
    {
      xero_invoice_id: string;
      invoice_number: string | null;
      copy_amount_due: number;
      copy_synced_at: string | null;
    }
  > = [];
  const differing = new Set<string>();
  let gapCents = 0;

  for (const i of open) {
    const id = i.xero_invoice_id.toLowerCase();
    const row = copy.get(id);
    const x = cents(i.amount_due);
    if (!row) {
      missing.push({
        xero_invoice_id: id,
        invoice_number: i.invoice_number,
        xero_amount_due: dollars(x),
      });
      differing.add(id);
      gapCents += x;
      continue;
    }
    if (!copyOpen(row)) {
      notOpen.push({
        xero_invoice_id: id,
        invoice_number: i.invoice_number,
        xero_amount_due: dollars(x),
        copy_status: row.status,
        copy_amount_due: dollars(cents(row.amount_due)),
        copy_synced_at: row.synced_at,
      });
      differing.add(id);
      gapCents += x;
      continue;
    }
    const c = cents(row.amount_due);
    if (c !== x) {
      amountDiffers.push({
        xero_invoice_id: id,
        invoice_number: i.invoice_number,
        xero_amount_due: dollars(x),
        copy_amount_due: dollars(c),
      });
      differing.add(id);
      gapCents += Math.abs(x - c);
    }
    if ((row.due_date ?? null) !== (i.due_date ?? null)) {
      dueDiffers.push({
        xero_invoice_id: id,
        invoice_number: i.invoice_number,
        xero_due_date: i.due_date,
        copy_due_date: row.due_date,
      });
      differing.add(id);
    }
  }
  const copyOpenRows = [...copy.values()].filter(copyOpen);
  for (const r of copyOpenRows) {
    const id = String(r.xero_invoice_id).toLowerCase();
    if (xeroIds.has(id)) continue;
    stale.push({
      xero_invoice_id: id,
      invoice_number: r.invoice_number,
      copy_amount_due: dollars(cents(r.amount_due)),
      copy_synced_at: r.synced_at,
    });
    differing.add(id);
    gapCents += cents(r.amount_due);
  }

  const matches = differing.size === 0;
  const hhmm = perthTimestamp(new Date(opts.readAt)).slice(11, 16);
  const byNumber = <T extends { invoice_number: string | null }>(a: T[]) =>
    a.sort((p, q) =>
      String(p.invoice_number).localeCompare(String(q.invoice_number))
    );
  return {
    matches,
    stamp: matches
      ? `Matches Xero, read ${hhmm}`
      : `Differs by ${fmtMoney(gapCents)} on ${differing.size} invoice${
        differing.size === 1 ? "" : "s"
      }`,
    xero_open: {
      count: open.length,
      amount: dollars(open.reduce((a, i) => a + cents(i.amount_due), 0)),
    },
    copy_open: {
      count: copyOpenRows.length,
      amount: dollars(
        copyOpenRows.reduce((a, r) => a + cents(r.amount_due), 0),
      ),
    },
    differing_count: differing.size,
    differing_amount: dollars(gapCents),
    missing_from_copy: byNumber(missing),
    copy_not_open: byNumber(notOpen),
    copy_open_not_in_xero: byNumber(stale),
    amount_differs: byNumber(amountDiffers),
    due_date_differs: byNumber(dueDiffers),
  };
}
