// Restoration work on the SES board: the plan, the quote and the builder's
// decision (docs/restoration-workflow-v1.md).
//
// Owner's word, 12 Nov 2026: restoration work is accepted through ses@. It
// comes in two shapes, and one card carries either:
//
//   do_and_charge     attend, do the work, report + photos + invoice. The
//                     existing physical pack path, unchanged.
//   assess_and_quote  attend and inspect, send the report and a quote for the
//                     restoration works, wait for the builder's yes, carry out
//                     the works over as many attendances as it takes, invoice.
//
// This module is PURE: no client, no clock it was not handed, no network. It
// owns the plan's shape, the rules for moving it, the phase a card is in, and
// the one hand-off to money.
//
// Where it is stored (restoration_workflow_store.ts does the reads and
// writes). A trade can read `jobs.metadata`, and a trade sees no money, so
// the job carries a PRICE-FREE record only (`restorationPlanForStorage`): the
// mode, the builder's limits, and for each quote revision its number, status,
// who sent and who decided, the document it is filed as and a hash of its
// content. The priced content (`restorationQuoteContent`: lines, scope,
// exclusions) lives on the quote's own office-only job document, which no
// trade read returns. The hash binds the two: an approval is an approval of
// exactly that content, and a document that no longer matches is refused.
//
// Money boundary (do not widen). Nothing here prices an invoice. An approved
// quote reaches an invoice only as a `commercial_quantity_override` object,
// the existing staff-locked instrument on `prepare_ses_invoice_obligation`,
// which a person then reviews and approves like any other SES invoice. The
// sealed labour schedule, the floors and the money fence are untouched.
//
// What is never done here: a quote is never emailed by this system (the
// sealed release graph is the only builder pack transport and it carries no
// quote route yet), and a builder's approval is recorded only from what a
// person or the terminal tells us, with its evidence.

import {
  SES_COMMERCIAL_QUANTITY_OVERRIDE_SCHEMA,
  type SesCommercialQuantityOverrideInput,
} from "./ses_commercial_quantity_override.ts";

export const RESTORATION_WORKFLOW_VERSION = "restoration-workflow/v1" as const;

export const RESTORATION_MODES = ["do_and_charge", "assess_and_quote"] as const;
export type RestorationMode = (typeof RESTORATION_MODES)[number];

export const RESTORATION_QUOTE_LINE_KINDS = [
  "labour",
  "materials",
  "equipment",
  "disposal",
  "other",
] as const;
export type RestorationQuoteLineKind =
  (typeof RESTORATION_QUOTE_LINE_KINDS)[number];

export type RestorationQuoteStatus = "draft" | "sent" | "approved" | "declined";

export type RestorationPhase =
  /** do and charge, no quote on file: attend, then report + invoice. */
  | "attend_and_charge"
  /** assess and quote, no quote yet: attend, inspect, write the quote. */
  | "assess"
  /** a quote is saved and has not gone to the builder. */
  | "quote_drafted"
  /** the quote is with the builder; nothing further is authorised yet. */
  | "awaiting_approval"
  /** the builder said yes: carry out the works, then invoice the quote. */
  | "approved_works"
  /** the builder said no: only the attendance already made is billable. */
  | "declined";

export interface RestorationQuoteLine {
  line_id: string;
  kind: RestorationQuoteLineKind;
  description: string;
  quantity: number;
  unit: string | null;
  unit_price_ex_gst: number;
  line_total_ex_gst: number;
}

export interface RestorationQuoteSent {
  at: string;
  to: string | null;
  channel: string;
  recorded_by: string;
  note: string | null;
}

export interface RestorationQuoteDecision {
  decision: "approved" | "declined";
  /** The builder's person who decided ("Amber Rollo"). */
  decided_by: string;
  decided_at: string;
  /** Our person, or the terminal acting for them, who recorded it. */
  recorded_by: string;
  recorded_at: string;
  /** Where the decision can be read: an email, a call, a new purchase order. */
  evidence_kind: "email" | "phone" | "purchase_order" | "portal" | "other";
  evidence_ref: string | null;
  note: string | null;
}

export interface RestorationQuote {
  revision: number;
  quote_number: string;
  status: RestorationQuoteStatus;
  lines: RestorationQuoteLine[];
  subtotal_ex_gst: number;
  gst: number;
  total_inc_gst: number;
  scope_of_works: string | null;
  exclusions: string | null;
  validity_days: number;
  prepared_by: string;
  prepared_at: string;
  document_id: string | null;
  pdf_url: string | null;
  sent: RestorationQuoteSent | null;
  decision: RestorationQuoteDecision | null;
}

export interface RestorationPlan {
  version: typeof RESTORATION_WORKFLOW_VERSION;
  mode: RestorationMode;
  /** Who chose the mode: read off the work order, or set by a person. */
  mode_source: "work_order_scope" | "operator";
  /**
   * The builder's authority limit for the initial attendance, ex GST (ML
   * Builders: "DAL"). Null when the work order states none. It is a limit the
   * builder set, shown beside the first invoice; it never prices anything.
   */
  authority_limit_ex_gst: number | null;
  authority_limit_source: "work_order_scope" | "operator" | null;
  /** A cap the builder put on hired equipment, in days, when stated. */
  equipment_day_cap: number | null;
  /** Every quote revision, oldest first. The last one is the current quote. */
  quotes: RestorationQuote[];
  updated_at: string | null;
  updated_by: string | null;
}

export class RestorationWorkflowError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "RestorationWorkflowError";
    this.code = code;
    this.status = status;
  }
}

function fail(code: string, message: string, status = 400): never {
  throw new RestorationWorkflowError(code, message, status);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** Cents-exact rounding for AUD amounts. */
export function roundCents(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// ── Reading the plan off the work order ──────────────────────────────────────

// The builder asks us to price further works: "provide a quote for structural
// drying", "inspect and quote", "report and quote". A scope that only says
// what to do (remove the cabinetry, dry the carpets) is do and charge.
const QUOTE_REQUEST_RE =
  /\b(?:provide|submit|supply|send|forward|prepare|issue)\b[^.\n]{0,60}\bquot(?:e|ation)\b|\bquot(?:e|ation)\s+(?:for|to)\b|\b(?:inspect|assess|report)\s+(?:and|&)\s+(?:provide\s+(?:a\s+)?)?quot(?:e|ation)\b|\bquot(?:e|ation)\s+(?:is\s+)?required\b/i;

// "DAL (designated authority limit) - $1k for initial attendance",
// "The delegated DAL limit for this claim is $1000."
const AUTHORITY_LIMIT_RE =
  /\b(?:DAL|(?:designated|delegated)\s+authority\s+limit|authority\s+limit)\b[^$\n]{0,80}\$\s*([\d,]+(?:\.\d+)?)\s*(k)?\b/i;

// "Please cap drying equipment at 5 days."
const EQUIPMENT_DAY_CAP_RE =
  /\bcap\b[^.\n]{0,40}\bequipment\b[^.\n]{0,20}\b(\d{1,2})\s*days?\b|\bequipment\b[^.\n]{0,40}\bcap(?:ped)?\b[^.\n]{0,20}\b(\d{1,2})\s*days?\b/i;

export interface RestorationScopeReading {
  mode: RestorationMode;
  authority_limit_ex_gst: number | null;
  equipment_day_cap: number | null;
}

/**
 * What the work order's own scope says about how the job runs. Deterministic
 * and conservative: with no request for a quote the job is do and charge, the
 * path that needs nothing extra from anyone.
 */
export function readRestorationScope(
  scopeText: string | null | undefined,
): RestorationScopeReading {
  const scope = String(scopeText || "");
  const limit = scope.match(AUTHORITY_LIMIT_RE);
  let authorityLimit: number | null = null;
  if (limit) {
    const amount = Number(limit[1].replace(/,/g, ""));
    if (Number.isFinite(amount) && amount > 0) {
      authorityLimit = roundCents(limit[2] ? amount * 1000 : amount);
    }
  }
  const cap = scope.match(EQUIPMENT_DAY_CAP_RE);
  const capDays = cap ? Number(cap[1] || cap[2]) : NaN;
  return {
    mode: QUOTE_REQUEST_RE.test(scope) ? "assess_and_quote" : "do_and_charge",
    authority_limit_ex_gst: authorityLimit,
    equipment_day_cap: Number.isFinite(capDays) && capDays > 0 ? capDays : null,
  };
}

// ── Stored shape ─────────────────────────────────────────────────────────────

function storedLine(value: unknown): RestorationQuoteLine | null {
  const row = record(value);
  const kind = text(row.kind) as RestorationQuoteLineKind;
  const quantity = finiteNumber(row.quantity);
  const unitPrice = finiteNumber(row.unit_price_ex_gst);
  if (
    !text(row.line_id) || !text(row.description) ||
    !(RESTORATION_QUOTE_LINE_KINDS as readonly string[]).includes(kind) ||
    quantity === null || unitPrice === null
  ) return null;
  return {
    line_id: text(row.line_id),
    kind,
    description: text(row.description),
    quantity,
    unit: text(row.unit) || null,
    unit_price_ex_gst: unitPrice,
    line_total_ex_gst: roundCents(quantity * unitPrice),
  };
}

function storedQuote(value: unknown): RestorationQuote | null {
  const row = record(value);
  const revision = finiteNumber(row.revision);
  const status = text(row.status) as RestorationQuoteStatus;
  if (
    revision === null || revision < 1 ||
    !["draft", "sent", "approved", "declined"].includes(status)
  ) return null;
  const lines = (Array.isArray(row.lines) ? row.lines : [])
    .map(storedLine);
  if (!lines.length || lines.some((line) => line === null)) return null;
  const totals = quoteTotals(lines as RestorationQuoteLine[]);
  const sent = record(row.sent);
  const decision = record(row.decision);
  const decided = text(decision.decision);
  return {
    revision,
    quote_number: text(row.quote_number),
    status,
    lines: lines as RestorationQuoteLine[],
    ...totals,
    scope_of_works: text(row.scope_of_works) || null,
    exclusions: text(row.exclusions) || null,
    validity_days: finiteNumber(row.validity_days) || 30,
    prepared_by: text(row.prepared_by),
    prepared_at: text(row.prepared_at),
    document_id: text(row.document_id) || null,
    pdf_url: text(row.pdf_url) || null,
    sent: text(sent.at)
      ? {
        at: text(sent.at),
        to: text(sent.to) || null,
        channel: text(sent.channel) || "email",
        recorded_by: text(sent.recorded_by),
        note: text(sent.note) || null,
      }
      : null,
    decision: decided === "approved" || decided === "declined"
      ? {
        decision: decided,
        decided_by: text(decision.decided_by),
        decided_at: text(decision.decided_at),
        recorded_by: text(decision.recorded_by),
        recorded_at: text(decision.recorded_at),
        evidence_kind: (["email", "phone", "purchase_order", "portal", "other"]
            .includes(text(decision.evidence_kind))
          ? text(decision.evidence_kind)
          : "other") as RestorationQuoteDecision["evidence_kind"],
        evidence_ref: text(decision.evidence_ref) || null,
        note: text(decision.note) || null,
      }
      : null,
  };
}

/**
 * The plan a card carries. A stored plan wins; without one the plan is read
 * off the work order's scope and marked as not stored, so a caller can show it
 * without anything having been written. A stored block this version cannot
 * read is refused, never guessed around: it holds a quote someone approved.
 */
export function readRestorationPlan(
  metadata: unknown,
  scopeText: string | null | undefined,
): { plan: RestorationPlan; stored: boolean } {
  const stored = record(metadata).restoration;
  const scope = readRestorationScope(scopeText);
  if (stored === undefined || stored === null) {
    return {
      stored: false,
      plan: {
        version: RESTORATION_WORKFLOW_VERSION,
        mode: scope.mode,
        mode_source: "work_order_scope",
        authority_limit_ex_gst: scope.authority_limit_ex_gst,
        authority_limit_source: scope.authority_limit_ex_gst === null
          ? null
          : "work_order_scope",
        equipment_day_cap: scope.equipment_day_cap,
        quotes: [],
        updated_at: null,
        updated_by: null,
      },
    };
  }
  const row = record(stored);
  const mode = text(row.mode) as RestorationMode;
  if (
    row.version !== RESTORATION_WORKFLOW_VERSION ||
    !(RESTORATION_MODES as readonly string[]).includes(mode)
  ) {
    fail(
      "restoration_plan_unreadable",
      "This job's stored restoration plan could not be read, so nothing was changed. It needs a person to look at it.",
      409,
    );
  }
  const quotes = (Array.isArray(row.quotes) ? row.quotes : []).map(storedQuote);
  if (quotes.some((quote) => quote === null)) {
    fail(
      "restoration_plan_unreadable",
      "This job's stored restoration quote could not be read, so nothing was changed. It needs a person to look at it.",
      409,
    );
  }
  const limit = finiteNumber(row.authority_limit_ex_gst);
  const cap = finiteNumber(row.equipment_day_cap);
  return {
    stored: true,
    plan: {
      version: RESTORATION_WORKFLOW_VERSION,
      mode,
      mode_source: row.mode_source === "operator"
        ? "operator"
        : "work_order_scope",
      authority_limit_ex_gst: limit !== null && limit > 0 ? limit : null,
      authority_limit_source: limit !== null && limit > 0
        ? (row.authority_limit_source === "operator"
          ? "operator"
          : "work_order_scope")
        : null,
      equipment_day_cap: cap !== null && cap > 0 ? cap : null,
      quotes: quotes as RestorationQuote[],
      updated_at: text(row.updated_at) || null,
      updated_by: text(row.updated_by) || null,
    },
  };
}

// ── What is stored where ─────────────────────────────────────────────────────

/** The priced content of a quote, as filed on its office-only document. */
export interface RestorationQuoteContent {
  quote_number: string;
  revision: number;
  lines: RestorationQuoteLine[];
  subtotal_ex_gst: number;
  gst: number;
  total_inc_gst: number;
  scope_of_works: string | null;
  exclusions: string | null;
  validity_days: number;
}

export function restorationQuoteContent(
  quote: RestorationQuote,
): RestorationQuoteContent {
  return {
    quote_number: quote.quote_number,
    revision: quote.revision,
    lines: quote.lines,
    subtotal_ex_gst: quote.subtotal_ex_gst,
    gst: quote.gst,
    total_inc_gst: quote.total_inc_gst,
    scope_of_works: quote.scope_of_works,
    exclusions: quote.exclusions,
    validity_days: quote.validity_days,
  };
}

/**
 * The exact text a quote's content hash is taken over: what the builder is
 * asked to approve, in one fixed order. Totals are left out because they are
 * worked out from the lines; names of people and dates are not content.
 */
export function restorationQuoteCanonicalText(
  content: {
    quote_number: unknown;
    revision: unknown;
    lines: unknown;
    scope_of_works?: unknown;
    exclusions?: unknown;
    validity_days?: unknown;
  },
): string {
  const lines = (Array.isArray(content.lines) ? content.lines : []).map(
    (value) => {
      const line = record(value);
      return [
        text(line.line_id),
        text(line.kind),
        text(line.description),
        finiteNumber(line.quantity),
        text(line.unit) || null,
        finiteNumber(line.unit_price_ex_gst),
      ];
    },
  );
  return JSON.stringify([
    RESTORATION_WORKFLOW_VERSION,
    text(content.quote_number),
    finiteNumber(content.revision),
    lines,
    text(content.scope_of_works) || null,
    text(content.exclusions) || null,
    finiteNumber(content.validity_days),
  ]);
}

/**
 * The plan as the job carries it: no line, no price, no total, no link to the
 * priced PDF. `contentHashes` gives each revision's content hash.
 */
export function restorationPlanForStorage(
  plan: RestorationPlan,
  contentHashes: ReadonlyMap<number, string>,
): Record<string, unknown> {
  return {
    version: plan.version,
    mode: plan.mode,
    mode_source: plan.mode_source,
    authority_limit_ex_gst: plan.authority_limit_ex_gst,
    authority_limit_source: plan.authority_limit_source,
    equipment_day_cap: plan.equipment_day_cap,
    quotes: plan.quotes.map((quote) => ({
      revision: quote.revision,
      quote_number: quote.quote_number,
      status: quote.status,
      prepared_by: quote.prepared_by,
      prepared_at: quote.prepared_at,
      document_id: quote.document_id,
      content_hash: contentHashes.get(quote.revision) || null,
      sent: quote.sent,
      decision: quote.decision,
    })),
    updated_at: plan.updated_at,
    updated_by: plan.updated_by,
  };
}

// ── Quote arithmetic ─────────────────────────────────────────────────────────

export function quoteTotals(
  lines: readonly RestorationQuoteLine[],
): { subtotal_ex_gst: number; gst: number; total_inc_gst: number } {
  const subtotal = roundCents(
    lines.reduce((sum, line) => sum + line.line_total_ex_gst, 0),
  );
  const gst = roundCents(subtotal * 0.1);
  return {
    subtotal_ex_gst: subtotal,
    gst,
    total_inc_gst: roundCents(subtotal + gst),
  };
}

/** The server works out every total; whatever totals a caller sends are ignored. */
export function normaliseQuoteLines(raw: unknown): RestorationQuoteLine[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    fail("quote_lines_required", "A quote needs at least one line.");
  }
  if (raw.length > 60) {
    fail("quote_lines_too_many", "A quote can hold at most 60 lines.");
  }
  const seen = new Set<string>();
  return raw.map((value, index) => {
    const row = record(value);
    const description = text(row.description);
    const kindRaw = text(row.kind || row.line_kind).toLowerCase() || "other";
    const quantity = finiteNumber(row.quantity);
    const unitPrice = finiteNumber(row.unit_price_ex_gst ?? row.unit_price);
    const where = `Quote line ${index + 1}`;
    if (!description) fail("quote_line_invalid", `${where} has no description.`);
    if (description.length > 400) {
      fail("quote_line_invalid", `${where} description is over 400 characters.`);
    }
    if (!(RESTORATION_QUOTE_LINE_KINDS as readonly string[]).includes(kindRaw)) {
      fail(
        "quote_line_invalid",
        `${where} kind must be one of ${RESTORATION_QUOTE_LINE_KINDS.join(", ")}.`,
      );
    }
    if (quantity === null || quantity <= 0) {
      fail("quote_line_invalid", `${where} needs a quantity above zero.`);
    }
    if (unitPrice === null || unitPrice < 0) {
      fail(
        "quote_line_invalid",
        `${where} needs a unit price ex GST of zero or more.`,
      );
    }
    let lineId = text(row.line_id) || `l${index + 1}`;
    while (seen.has(lineId)) lineId = `${lineId}-${index + 1}`;
    seen.add(lineId);
    return {
      line_id: lineId,
      kind: kindRaw as RestorationQuoteLineKind,
      description,
      quantity: quantity as number,
      unit: text(row.unit) || null,
      unit_price_ex_gst: roundCents(unitPrice as number),
      line_total_ex_gst: roundCents(
        (quantity as number) * roundCents(unitPrice as number),
      ),
    };
  });
}

// ── Moves ────────────────────────────────────────────────────────────────────

export interface RestorationActor {
  /** Who is acting: a staff email, or the name the terminal was given. */
  label: string;
  now: string;
}

function stamped(plan: RestorationPlan, actor: RestorationActor): RestorationPlan {
  return { ...plan, updated_at: actor.now, updated_by: actor.label };
}

export function currentQuote(plan: RestorationPlan): RestorationQuote | null {
  return plan.quotes.length ? plan.quotes[plan.quotes.length - 1] : null;
}

/**
 * The quote the builder has said yes to and that is still in force: the
 * newest approved revision. A later revision that is still a draft, still
 * with the builder, or declined leaves the earlier approval standing.
 */
export function approvedQuote(plan: RestorationPlan): RestorationQuote | null {
  for (let i = plan.quotes.length - 1; i >= 0; i--) {
    if (plan.quotes[i].status === "approved") return plan.quotes[i];
  }
  return null;
}

export function setRestorationPlan(
  plan: RestorationPlan,
  input: {
    mode?: unknown;
    authority_limit_ex_gst?: unknown;
    equipment_day_cap?: unknown;
  },
  actor: RestorationActor,
): RestorationPlan {
  let next = { ...plan };
  if (input.mode !== undefined) {
    const mode = text(input.mode) as RestorationMode;
    if (!(RESTORATION_MODES as readonly string[]).includes(mode)) {
      fail(
        "restoration_mode_invalid",
        `mode must be one of ${RESTORATION_MODES.join(", ")}.`,
      );
    }
    next = { ...next, mode, mode_source: "operator" };
  }
  if (input.authority_limit_ex_gst !== undefined) {
    if (input.authority_limit_ex_gst === null) {
      next = {
        ...next,
        authority_limit_ex_gst: null,
        authority_limit_source: null,
      };
    } else {
      const limit = finiteNumber(input.authority_limit_ex_gst);
      if (limit === null || limit <= 0) {
        fail(
          "authority_limit_invalid",
          "authority_limit_ex_gst must be an amount above zero, or null for none.",
        );
      }
      next = {
        ...next,
        authority_limit_ex_gst: roundCents(limit as number),
        authority_limit_source: "operator",
      };
    }
  }
  if (input.equipment_day_cap !== undefined) {
    const cap = input.equipment_day_cap === null
      ? null
      : finiteNumber(input.equipment_day_cap);
    if (cap !== null && (cap <= 0 || !Number.isInteger(cap))) {
      fail(
        "equipment_day_cap_invalid",
        "equipment_day_cap must be a whole number of days, or null for none.",
      );
    }
    next = { ...next, equipment_day_cap: cap };
  }
  return stamped(next, actor);
}

export interface RestorationQuoteSaveInput {
  lines: unknown;
  scope_of_works?: unknown;
  exclusions?: unknown;
  validity_days?: unknown;
  /** Required to start a new revision once a quote is approved. */
  revise_approved?: unknown;
}

/**
 * Save the quote. A draft is edited in place. Once a quote has gone to the
 * builder it is never rewritten: saving starts the next revision, and the one
 * the builder saw stays exactly as it was. Revising an APPROVED quote is a
 * deliberate act (`revise_approved: true`), because the earlier approval keeps
 * standing until the builder approves the new one.
 */
export function saveRestorationQuote(
  plan: RestorationPlan,
  input: RestorationQuoteSaveInput,
  jobNumber: string,
  actor: RestorationActor,
): { plan: RestorationPlan; quote: RestorationQuote } {
  const lines = normaliseQuoteLines(input.lines);
  const totals = quoteTotals(lines);
  if (totals.subtotal_ex_gst <= 0) {
    fail("quote_total_zero", "The quote adds up to nothing. Check the lines.");
  }
  const validity = input.validity_days === undefined
    ? 30
    : finiteNumber(input.validity_days);
  if (validity === null || validity < 1 || validity > 365) {
    fail("quote_validity_invalid", "validity_days must be between 1 and 365.");
  }
  const existing = currentQuote(plan);
  if (existing?.status === "approved" && input.revise_approved !== true) {
    fail(
      "quote_already_approved",
      `Quote ${existing.quote_number} is approved. To change the price, send revise_approved: true; the approved quote keeps standing until the builder approves the new one.`,
      409,
    );
  }
  const editInPlace = existing?.status === "draft";
  const revision = editInPlace
    ? existing!.revision
    : (existing?.revision || 0) + 1;
  const quote: RestorationQuote = {
    revision,
    quote_number: `${jobNumber || "RESTORATION"}-Q${revision}`,
    status: "draft",
    lines,
    ...totals,
    scope_of_works: text(input.scope_of_works) || null,
    exclusions: text(input.exclusions) || null,
    validity_days: validity as number,
    prepared_by: actor.label,
    prepared_at: actor.now,
    document_id: null,
    pdf_url: null,
    sent: null,
    decision: null,
  };
  const quotes = editInPlace
    ? [...plan.quotes.slice(0, -1), quote]
    : [...plan.quotes, quote];
  return { plan: stamped({ ...plan, quotes }, actor), quote };
}

function replaceCurrent(
  plan: RestorationPlan,
  quote: RestorationQuote,
  actor: RestorationActor,
): RestorationPlan {
  return stamped(
    { ...plan, quotes: [...plan.quotes.slice(0, -1), quote] },
    actor,
  );
}

function requireRevision(
  plan: RestorationPlan,
  revision: unknown,
): RestorationQuote {
  const quote = currentQuote(plan);
  if (!quote) {
    fail("quote_missing", "This job has no quote on file yet.", 409);
  }
  const wanted = finiteNumber(revision);
  if (wanted === null) {
    fail(
      "quote_revision_required",
      `Say which quote revision this is about (the current one is ${quote!.revision}).`,
    );
  }
  if (wanted !== quote!.revision) {
    fail(
      "quote_revision_stale",
      `The current quote is revision ${quote!.revision}, not ${wanted}. Read the job again before recording this.`,
      409,
    );
  }
  return quote as RestorationQuote;
}

/** The quote's PDF was filed; remember where. */
export function attachRestorationQuoteDocument(
  plan: RestorationPlan,
  documentId: string,
  pdfUrl: string | null,
  actor: RestorationActor,
): RestorationPlan {
  const quote = currentQuote(plan);
  if (!quote) return plan;
  return replaceCurrent(
    plan,
    { ...quote, document_id: documentId, pdf_url: pdfUrl },
    actor,
  );
}

/**
 * Record that the quote went to the builder. This system does not send it; a
 * person does, and says so here.
 */
export function markRestorationQuoteSent(
  plan: RestorationPlan,
  input: {
    revision?: unknown;
    sent_to?: unknown;
    sent_at?: unknown;
    channel?: unknown;
    note?: unknown;
  },
  actor: RestorationActor,
): { plan: RestorationPlan; quote: RestorationQuote } {
  const quote = requireRevision(plan, input.revision);
  if (quote.status !== "draft" && quote.status !== "sent") {
    fail(
      "quote_already_decided",
      `Quote ${quote.quote_number} is already ${quote.status}.`,
      409,
    );
  }
  const sentAt = text(input.sent_at) || actor.now;
  if (Number.isNaN(Date.parse(sentAt))) {
    fail("quote_sent_at_invalid", "sent_at must be a date and time.");
  }
  const next: RestorationQuote = {
    ...quote,
    status: "sent",
    sent: {
      at: sentAt,
      to: text(input.sent_to) || null,
      channel: text(input.channel) || "email",
      recorded_by: actor.label,
      note: text(input.note) || null,
    },
  };
  return { plan: replaceCurrent(plan, next, actor), quote: next };
}

/**
 * Record the builder's answer. It needs who at the builder decided and where
 * that can be read; "approved" with no name and no evidence is refused,
 * because this is the record an invoice will later stand on.
 */
export function decideRestorationQuote(
  plan: RestorationPlan,
  input: {
    revision?: unknown;
    decision?: unknown;
    decided_by?: unknown;
    decided_at?: unknown;
    evidence_kind?: unknown;
    evidence_ref?: unknown;
    note?: unknown;
  },
  actor: RestorationActor,
): { plan: RestorationPlan; quote: RestorationQuote } {
  const quote = requireRevision(plan, input.revision);
  const decision = text(input.decision).toLowerCase();
  if (decision !== "approved" && decision !== "declined") {
    fail("quote_decision_invalid", "decision must be approved or declined.");
  }
  if (quote.status === "approved" || quote.status === "declined") {
    if (quote.status === decision) return { plan, quote };
    fail(
      "quote_already_decided",
      `Quote ${quote.quote_number} is already ${quote.status}. Save a new revision to change it.`,
      409,
    );
  }
  const decidedBy = text(input.decided_by);
  if (!decidedBy) {
    fail(
      "quote_decision_needs_person",
      "Say who at the builder gave the answer (decided_by).",
    );
  }
  const evidenceKind = text(input.evidence_kind).toLowerCase() || "email";
  if (
    !["email", "phone", "purchase_order", "portal", "other"].includes(
      evidenceKind,
    )
  ) {
    fail(
      "quote_decision_evidence_invalid",
      "evidence_kind must be email, phone, purchase_order, portal or other.",
    );
  }
  const evidenceRef = text(input.evidence_ref);
  if (decision === "approved" && !evidenceRef) {
    fail(
      "quote_decision_needs_evidence",
      "An approval needs evidence_ref: the email subject and date, the call time, or the new purchase order number.",
    );
  }
  const decidedAt = text(input.decided_at) || actor.now;
  if (Number.isNaN(Date.parse(decidedAt))) {
    fail("quote_decided_at_invalid", "decided_at must be a date and time.");
  }
  const next: RestorationQuote = {
    ...quote,
    status: decision,
    // A decision on a quote nobody marked as sent still means it was sent.
    sent: quote.sent || {
      at: decidedAt,
      to: null,
      channel: "unknown",
      recorded_by: actor.label,
      note: "Recorded with the builder's decision; the send itself was not logged.",
    },
    decision: {
      decision,
      decided_by: decidedBy,
      decided_at: decidedAt,
      recorded_by: actor.label,
      recorded_at: actor.now,
      evidence_kind: evidenceKind as RestorationQuoteDecision["evidence_kind"],
      evidence_ref: evidenceRef || null,
      note: text(input.note) || null,
    },
  };
  return { plan: replaceCurrent(plan, next, actor), quote: next };
}

// ── Where the job is at ──────────────────────────────────────────────────────

export function restorationPhase(plan: RestorationPlan): RestorationPhase {
  const quote = currentQuote(plan);
  if (!quote) {
    return plan.mode === "assess_and_quote" ? "assess" : "attend_and_charge";
  }
  // An approval stands while a later revision is drafted or with the builder.
  if (quote.status === "approved") return "approved_works";
  if (quote.status === "draft") {
    return approvedQuote(plan) ? "approved_works" : "quote_drafted";
  }
  if (quote.status === "sent") {
    return approvedQuote(plan) ? "approved_works" : "awaiting_approval";
  }
  return approvedQuote(plan) ? "approved_works" : "declined";
}

export const RESTORATION_PHASE_LABELS: Record<RestorationPhase, string> = {
  attend_and_charge: "Do and charge",
  assess: "Assess and quote",
  quote_drafted: "Quote drafted",
  awaiting_approval: "Quote with builder",
  approved_works: "Quote approved",
  declined: "Quote declined",
};

/** One plain line: what happens next, and who does it. */
export function restorationNextStep(plan: RestorationPlan): string {
  const quote = currentQuote(plan);
  const approved = approvedQuote(plan);
  switch (restorationPhase(plan)) {
    case "attend_and_charge":
      return "Attend and do the work, then send the report, photos and invoice as for any make-safe.";
    case "assess":
      return "Attend and inspect. Then save the quote for the restoration works and send it to the builder with the report.";
    case "quote_drafted":
      return `Quote ${quote!.quote_number} is saved and has not gone to the builder. Send it, then record that it was sent.`;
    case "awaiting_approval":
      return `Quote ${quote!.quote_number} is with the builder. Do not start the quoted works until their approval is recorded.`;
    case "approved_works":
      return quote && approved && quote.revision !== approved.revision
        ? `Quote ${approved.quote_number} is approved and in force. Revision ${quote.revision} is ${quote.status === "sent" ? "with the builder" : quote.status} and changes nothing until it is approved.`
        : `Quote ${approved!.quote_number} is approved. Carry out the works, then invoice the approved quote.`;
    case "declined":
      return `Quote ${quote!.quote_number} was declined. Only the attendance already made can be invoiced.`;
  }
}

// ── The hand-off to money ────────────────────────────────────────────────────

export interface RestorationInvoiceHandoffContext {
  job_number: string;
  /** The sealed labour rate on the card's current docket proposal. */
  sealed_labour_rate_ex_gst: number | null;
  /** The sealed floor and the trade's own hours, both left as recorded. */
  sealed_billable_hours_floor: number | null;
  trade_reported_hours_per_trade: number | null;
  /** The staff member locking the figure. */
  authorised_by: string;
  now: string;
}

export type RestorationInvoiceHandoff =
  | {
    ready: true;
    quote_number: string;
    total_ex_gst: number;
    commercial_quantity_override: SesCommercialQuantityOverrideInput;
  }
  | { ready: false; code: string; reason: string };

/**
 * Turn the approved quote into the staff-locked figure
 * `prepare_ses_invoice_obligation` already accepts. Nothing is priced here:
 * the lines are the builder-approved quote, word for word and cent for cent,
 * and every rule of that instrument still applies when it is used.
 *
 * The instrument has two limits a quote must fit, and a quote that does not
 * fit is refused with the reason rather than bent:
 *  - it needs at least one labour line;
 *  - every labour line bills one hourly rate (the sealed schedule rate, or one
 *    named rate for this card).
 */
export function restorationInvoiceHandoff(
  plan: RestorationPlan,
  context: RestorationInvoiceHandoffContext,
): RestorationInvoiceHandoff {
  const quote = approvedQuote(plan);
  if (!quote) {
    return {
      ready: false,
      code: "no_approved_quote",
      reason: "No quote on this job has been approved by the builder.",
    };
  }
  if (!quote.decision) {
    return {
      ready: false,
      code: "approval_unrecorded",
      reason: `Quote ${quote.quote_number} is marked approved with no decision on record.`,
    };
  }
  if (
    context.sealed_labour_rate_ex_gst === null ||
    context.sealed_billable_hours_floor === null ||
    context.trade_reported_hours_per_trade === null
  ) {
    return {
      ready: false,
      code: "docket_not_prepared",
      reason: "Prepare the docket for the completed works first; the invoice is priced against it.",
    };
  }
  if (!text(context.authorised_by)) {
    return {
      ready: false,
      code: "authorised_by_required",
      reason: "Say which staff member is locking the approved quote onto the invoice.",
    };
  }
  const labour = quote.lines.filter((line) => line.kind === "labour");
  if (!labour.length) {
    return {
      ready: false,
      code: "quote_has_no_labour_line",
      reason: `Quote ${quote.quote_number} has no labour line, and an SES invoice must show its labour. Revise the quote so the labour is its own line.`,
    };
  }
  const labourRates = [...new Set(labour.map((line) => line.unit_price_ex_gst))];
  if (labourRates.length > 1) {
    return {
      ready: false,
      code: "quote_labour_rates_differ",
      reason: `Quote ${quote.quote_number} bills labour at ${labourRates.map((rate) => `$${rate}`).join(" and ")} an hour. An SES invoice carries one labour rate per card, so this one needs a person to invoice it.`,
    };
  }
  const labourRate = labourRates[0];
  const sealedRate = context.sealed_labour_rate_ex_gst;
  const approvedOn = quote.decision.decided_at.slice(0, 10);
  const basis =
    `Builder-approved restoration quote ${quote.quote_number} (${quote.decision.decided_by}, ${approvedOn}` +
    `${quote.decision.evidence_ref ? `, ${quote.decision.evidence_ref}` : ""})`;
  return {
    ready: true,
    quote_number: quote.quote_number,
    total_ex_gst: quote.subtotal_ex_gst,
    commercial_quantity_override: {
      schema: SES_COMMERCIAL_QUANTITY_OVERRIDE_SCHEMA,
      authorised_by: text(context.authorised_by),
      authorised_at: context.now,
      decision_key:
        `restoration-quote:${context.job_number}:r${quote.revision}`,
      reason: `Commercial figure: ${basis}. Trade hours stay as recorded.`,
      trade_reported_hours_per_trade: context.trade_reported_hours_per_trade,
      sealed_billable_hours_floor: context.sealed_billable_hours_floor,
      lines: quote.lines.map((line) => ({
        line_kind: line.kind === "labour" ? "labour" : "materials",
        description: line.description,
        quantity: line.quantity,
        unit_price_ex_gst: line.unit_price_ex_gst,
      })),
      authority_kind: "staff_lock",
      proposal_source: `${RESTORATION_WORKFLOW_VERSION}:${quote.quote_number}`,
      ...(labourRate !== sealedRate
        ? {
          labour_rate_override: {
            sealed_unit_price_ex_gst: sealedRate,
            authorised_unit_price_ex_gst: labourRate,
            reason: `${basis} sets labour at $${labourRate} an hour for this job.`,
          },
        }
        : {}),
    },
  };
}

/**
 * The builder's authority limit beside the invoice about to be raised for the
 * initial attendance. It only reports; holding an invoice is a person's call.
 */
export function authorityLimitCheck(
  plan: RestorationPlan,
  proposalSubtotalExGst: number | null,
): {
  limit_ex_gst: number | null;
  proposal_ex_gst: number | null;
  status: "no_limit" | "not_priced" | "within_limit" | "over_limit";
  note: string;
} {
  const limit = plan.authority_limit_ex_gst;
  if (limit === null) {
    return {
      limit_ex_gst: null,
      proposal_ex_gst: proposalSubtotalExGst,
      status: "no_limit",
      note: "The work order states no authority limit.",
    };
  }
  if (proposalSubtotalExGst === null) {
    return {
      limit_ex_gst: limit,
      proposal_ex_gst: null,
      status: "not_priced",
      note: `The builder's authority limit for the initial attendance is $${limit} ex GST.`,
    };
  }
  if (approvedQuote(plan)) {
    return {
      limit_ex_gst: limit,
      proposal_ex_gst: proposalSubtotalExGst,
      status: "within_limit",
      note: `The builder's $${limit} ex GST limit covered the initial attendance; an approved quote now sets what may be invoiced.`,
    };
  }
  const over = proposalSubtotalExGst > limit + 0.005;
  return {
    limit_ex_gst: limit,
    proposal_ex_gst: proposalSubtotalExGst,
    status: over ? "over_limit" : "within_limit",
    note: over
      ? `The invoice proposal is $${proposalSubtotalExGst} ex GST, over the builder's $${limit} authority limit for the initial attendance. Get their approval before it is invoiced.`
      : `The invoice proposal is $${proposalSubtotalExGst} ex GST, inside the builder's $${limit} authority limit.`,
  };
}

/** What a read of the plan returns: the plan, where it is at, what is next. */
export function describeRestorationPlan(
  plan: RestorationPlan,
  stored: boolean,
): Record<string, unknown> {
  const phase = restorationPhase(plan);
  const quote = currentQuote(plan);
  const approved = approvedQuote(plan);
  return {
    version: plan.version,
    stored,
    mode: plan.mode,
    mode_source: plan.mode_source,
    phase,
    phase_label: RESTORATION_PHASE_LABELS[phase],
    next_step: restorationNextStep(plan),
    authority_limit_ex_gst: plan.authority_limit_ex_gst,
    authority_limit_source: plan.authority_limit_source,
    equipment_day_cap: plan.equipment_day_cap,
    quote,
    approved_quote_number: approved?.quote_number || null,
    approved_total_ex_gst: approved?.subtotal_ex_gst ?? null,
    quote_revisions: plan.quotes.map((row) => ({
      revision: row.revision,
      quote_number: row.quote_number,
      status: row.status,
      subtotal_ex_gst: row.subtotal_ex_gst,
      prepared_at: row.prepared_at,
    })),
    updated_at: plan.updated_at,
    updated_by: plan.updated_by,
  };
}
