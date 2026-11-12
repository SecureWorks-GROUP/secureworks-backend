// Restoration board stages (owner, 12 Nov 2026): restoration is its own kind
// of work with its own simple board, not a column set on the make-safe board.
// Contract: docs/restoration-board-v1.md.
//
// One card per job, seven stages, in order:
//   new                 work order in, nobody booked
//   booked              a crew is booked to attend
//   report_due          attended; the report (and quote, or invoice) is owed
//   quote_with_builder  the quote has gone to the builder (assess and quote)
//   works               the builder approved, or do-and-charge works under way
//   invoiced            the invoice has gone to the builder
//   closed              paid, or closed by hand
//
// A stage is STORED (jobs.metadata.restoration_stage) once a person, the
// terminal or one of the restoration actions moves the card. Until then it is
// worked out from the job's own facts. A stored `invoiced` card whose every
// raised invoice is PAID shows as `closed` (paid), with no write.
//
// Pure rules only: no reads, no writes. The store is restoration_stage_store.ts.

export const RESTORATION_STAGES = [
  "new",
  "booked",
  "report_due",
  "quote_with_builder",
  "works",
  "invoiced",
  "closed",
] as const;

export type RestorationStage = (typeof RESTORATION_STAGES)[number];

export const RESTORATION_STAGE_LABELS: Record<RestorationStage, string> = {
  new: "New",
  booked: "Booked",
  report_due: "Report due",
  quote_with_builder: "Quote with builder",
  works: "Works in progress",
  invoiced: "Invoiced",
  closed: "Closed",
};

const STAGE_SET = new Set<string>(RESTORATION_STAGES);
const STAGE_ORDER = new Map<string, number>(
  RESTORATION_STAGES.map((stage, index) => [stage, index]),
);

export function isRestorationStage(value: unknown): value is RestorationStage {
  return typeof value === "string" && STAGE_SET.has(value);
}

export function restorationStageOrder(stage: RestorationStage): number {
  return STAGE_ORDER.get(stage) ?? 0;
}

/** The jobs.status a stage leaves the job in (a value the jobs CHECK allows). */
export const RESTORATION_STAGE_JOB_STATUS: Record<RestorationStage, string> = {
  new: "processing",
  booked: "scheduled",
  report_due: "processing",
  quote_with_builder: "processing",
  works: "in_progress",
  invoiced: "invoiced",
  closed: "complete",
};

export interface RestorationInvoiceFact {
  invoice_number: string | null;
  status: string;
  total: number | null;
  amount_due: number | null;
}

export interface RestorationStageFacts {
  job_status: string | null;
  /** assess_and_quote | do_and_charge, from the restoration plan. */
  mode: string | null;
  /** restorationPhase(plan): assess, quote_drafted, awaiting_approval, ... */
  phase: string | null;
  /** jobs.metadata.restoration_stage, as stored. */
  stored: unknown;
  /** Genuine crew bookings (not cancelled, not ghost watchers). */
  live_assignments: number;
  report_received: boolean;
  /** Sales invoices on the job that are not VOIDED or DELETED. */
  invoices: RestorationInvoiceFact[];
}

export interface StoredRestorationStage {
  stage: RestorationStage;
  set_at: string | null;
  set_by: string | null;
  note: string | null;
  auto: boolean;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function upper(value: unknown): string {
  return text(value).toUpperCase();
}

export function readStoredRestorationStage(
  value: unknown,
): StoredRestorationStage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!isRestorationStage(row.stage)) return null;
  return {
    stage: row.stage,
    set_at: text(row.set_at) || null,
    set_by: text(row.set_by) || null,
    note: text(row.note) || null,
    auto: row.auto === true,
  };
}

/** AUTHORISED or PAID: an invoice that is out the door. DRAFT is not. */
export function raisedInvoices(
  invoices: readonly RestorationInvoiceFact[],
): RestorationInvoiceFact[] {
  return invoices.filter((inv) => {
    const status = upper(inv.status);
    return status === "AUTHORISED" || status === "PAID";
  });
}

export function draftInvoices(
  invoices: readonly RestorationInvoiceFact[],
): RestorationInvoiceFact[] {
  return invoices.filter((inv) => {
    const status = upper(inv.status);
    return status === "DRAFT" || status === "SUBMITTED";
  });
}

export function allRaisedInvoicesPaid(
  invoices: readonly RestorationInvoiceFact[],
): boolean {
  const raised = raisedInvoices(invoices);
  return raised.length > 0 && raised.every((inv) => upper(inv.status) === "PAID") &&
    draftInvoices(invoices).length === 0;
}

const CLOSED_JOB_STATUSES = new Set(["complete", "archived"]);

/** The stage a job's facts show when nobody has set one. */
export function deriveRestorationStage(
  facts: RestorationStageFacts,
): RestorationStage {
  const status = text(facts.job_status).toLowerCase();
  if (CLOSED_JOB_STATUSES.has(status)) return "closed";
  if (facts.phase === "awaiting_approval") return "quote_with_builder";
  if (facts.phase === "approved_works") return "works";
  const raised = raisedInvoices(facts.invoices);
  // An invoice sent while a quote is pending (an assessment fee) does not move
  // the card past the quote: the phase checks above come first.
  if (raised.length > 0 && facts.phase !== "quote_drafted") {
    return allRaisedInvoicesPaid(facts.invoices) ? "closed" : "invoiced";
  }
  if (facts.phase === "quote_drafted" || facts.report_received) {
    return "report_due";
  }
  if (facts.live_assignments > 0) return "booked";
  return "new";
}

export type RestorationStageSource = "set" | "derived" | "paid";

export interface PresentedRestorationStage {
  stage: RestorationStage;
  label: string;
  source: RestorationStageSource;
  stored: StoredRestorationStage | null;
  derived: RestorationStage;
}

/** What the board shows: the stored stage, else the derived one. */
export function presentRestorationStage(
  facts: RestorationStageFacts,
): PresentedRestorationStage {
  const stored = readStoredRestorationStage(facts.stored);
  const derived = deriveRestorationStage(facts);
  if (!stored) {
    return {
      stage: derived,
      label: RESTORATION_STAGE_LABELS[derived],
      source: "derived",
      stored: null,
      derived,
    };
  }
  if (stored.stage === "invoiced" && allRaisedInvoicesPaid(facts.invoices)) {
    return {
      stage: "closed",
      label: RESTORATION_STAGE_LABELS.closed,
      source: "paid",
      stored,
      derived,
    };
  }
  return {
    stage: stored.stage,
    label: RESTORATION_STAGE_LABELS[stored.stage],
    source: "set",
    stored,
    derived,
  };
}

export interface RestorationStageRefusal {
  code: string;
  message: string;
}

/**
 * Whether a card may be put in `target`. Moving back is always allowed (a
 * mistake is undone the same way). Moving into a stage that claims something
 * happened needs that thing on record.
 */
export function restorationStageRefusal(
  target: RestorationStage,
  facts: RestorationStageFacts,
  options: { no_charge_reason?: string | null } = {},
): RestorationStageRefusal | null {
  const raised = raisedInvoices(facts.invoices);
  switch (target) {
    case "quote_with_builder":
      if (facts.mode !== "assess_and_quote") {
        return {
          code: "restoration_stage_no_quote_stage",
          message:
            "This job is do and charge, so it has no quote stage. Set the plan to assess and quote first if a quote is needed.",
        };
      }
      if (facts.phase !== "awaiting_approval" && facts.phase !== "approved_works") {
        return {
          code: "restoration_stage_quote_not_sent",
          message:
            "No quote is recorded as sent to the builder. Send the quote, then record it as sent (restoration_mark_quote_sent).",
        };
      }
      return null;
    case "works":
      if (facts.mode === "assess_and_quote" && facts.phase !== "approved_works") {
        return {
          code: "restoration_stage_quote_not_approved",
          message:
            "The builder's approval of the quote is not recorded. Record it first (restoration_record_quote_decision), then the works can start.",
        };
      }
      return null;
    case "invoiced":
      if (raised.length === 0) {
        return {
          code: "restoration_stage_no_invoice",
          message:
            "No approved (AUTHORISED) invoice is on this job yet. Approve and send the invoice first.",
        };
      }
      return null;
    case "closed": {
      const reason = text(options.no_charge_reason);
      if (reason) return null;
      if (raised.length === 0) {
        return {
          code: "restoration_stage_close_without_invoice",
          message:
            "Nothing has been invoiced on this job. Invoice it first, or close it with a no_charge_reason.",
        };
      }
      const drafts = draftInvoices(facts.invoices);
      if (drafts.length > 0) {
        return {
          code: "restoration_stage_close_with_draft",
          message: `Invoice ${
            drafts.map((d) => d.invoice_number || "draft").join(", ")
          } is still a draft. Approve and send it, or void it, before closing.`,
        };
      }
      return null;
    }
    default:
      return null;
  }
}

export type RestorationStageTrigger =
  | "quote_sent"
  | "quote_approved"
  | "invoice_sent";

/**
 * Where a restoration action moves the card on its own, or null for no move.
 * Only ever forward: an action never drags a card back.
 */
export function restorationAutoAdvanceTarget(
  trigger: RestorationStageTrigger,
  current: RestorationStage,
  facts: RestorationStageFacts,
): RestorationStage | null {
  let target: RestorationStage | null = null;
  if (trigger === "quote_sent") target = "quote_with_builder";
  if (trigger === "quote_approved") target = "works";
  if (trigger === "invoice_sent") {
    // An assessment fee sent while the quote is still with the builder (or
    // being written) does not move the card past the quote.
    if (facts.phase === "awaiting_approval" || facts.phase === "quote_drafted") {
      return null;
    }
    if (facts.mode === "assess_and_quote" && facts.phase === "assess") return null;
    target = "invoiced";
  }
  if (!target) return null;
  if (restorationStageOrder(target) <= restorationStageOrder(current)) return null;
  if (restorationStageRefusal(target, facts)) return null;
  return target;
}

/** The plain next step for a card in a stage. */
export function restorationStageNextStep(
  stage: RestorationStage,
  mode: string | null,
): string {
  const quoting = mode === "assess_and_quote";
  switch (stage) {
    case "new":
      return "Book a crew to attend.";
    case "booked":
      return quoting
        ? "Attend and inspect, then submit the report."
        : "Attend and do the works, then submit the report.";
    case "report_due":
      return quoting
        ? "Send the report and the quote to the builder, then record the quote as sent."
        : "Send the report and photos, then approve and send the invoice.";
    case "quote_with_builder":
      return "Waiting on the builder. When they approve, record the approval and the card moves to Works in progress.";
    case "works":
      return "Carry out the works. When they are finished, approve and send the invoice.";
    case "invoiced":
      return "Invoice sent. The card closes when it is paid, or close it by hand.";
    case "closed":
      return "Closed.";
  }
}
