// deno-lint-ignore-file no-explicit-any
// Job trace read (Integrated Job Framework INT-34, requirement R-24).
//
// ops-api `job_trace` takes one job and returns its chain, link by link:
//   L1 quote           the accepted scope revision (status, hash) and the sent quote
//   L2 material_lines  Dispatch material lines
//   L3 orders          purchase orders and their order emails
//   L4 supplier_bills  supplier bills and their materials facts (source, confidence)
//   L5 work_order      the job work order (approved, sealed)
//   L6 crew_lines      crew pay lines and their Xero bills
//   L7 invoices        customer invoices and payments, per paying party
//   L8 card            the job card's live reading and the H7 bill outcome
// Beside the links, `revisions` (RQ-19.d) says whether every record that
// names a scope revision (the job's costs, the newest sent quote, the job
// work order, the Dispatch fill and its material lines, the scope job drafts)
// names the accepted revision, and one of this job's own.
// Each link carries its key, its row ids and its state, and the answer names
// the first missing link with a reason code. It is the one read every
// integration acceptance is checked with, so it never computes a money
// figure: an admin/owner session sees the figures the Money pages already
// show, copied from the rows, and every other caller (the ops key, which is
// also the agents' key) gets the figure-free shape. Read only: no table
// write, no provider call, no model call. A failed read makes its link
// `unknown` with a code, never `missing`. Contract: docs/job-trace-read-contract.md.

import { JOB_WORK_ORDER_OPEN_STATUSES } from "./job_work_order_quote_fill.ts";

export const JOB_TRACE_VERSION = "job-trace-v2";

export type LinkState =
  | "present"
  | "partial"
  | "missing"
  | "unknown";

export type TraceLink = {
  link: string;
  name: string;
  state: LinkState;
  /** Why the link is not present: one of JOB_TRACE_REASONS. Null when present. */
  reason: string | null;
  /** Further codes that hold on this link (a partial link may carry several). */
  notes: string[];
  items: Record<string, unknown>[];
  truncated?: boolean;
  error?: string;
};

/** Every reason and note code the trace can return, with its meaning. */
export const JOB_TRACE_REASONS = {
  read_failed:
    "A read behind this link failed, so its state is not known. Never read as missing.",
  job_not_accepted:
    "The job has no acceptance and is not in an open (past quoted) status.",
  no_accepted_quote:
    "The job is accepted or open, but no sent quote or frozen scope revision is on record.",
  accepted_without_frozen_revision:
    "A quote was sent and the job is accepted, but no frozen scope revision marks what was accepted.",
  no_material_lines: "No Dispatch material line is on the job.",
  lines_not_reviewed: "At least one material line is still not_reviewed.",
  lines_not_on_order:
    "At least one material line marked to_order is on no purchase order.",
  no_purchase_orders: "No live purchase order is on the job.",
  legacy_po:
    "A purchase order on the job was not made by Dispatch (no source): a retyped order, not linked to lines and never sent through Dispatch.",
  order_not_sent:
    "A Dispatch purchase order on the job has no sent order email.",
  order_send_unknown:
    "A Dispatch order email is sending or send_unknown: whether it reached the supplier is not known.",
  no_supplier_bills:
    "No supplier bill is placed on the job and none is known to be waiting for it.",
  bill_not_placed:
    "A supplier bill known to belong to the job (named by its purchase order, or suggested for it) has no materials fact on the job.",
  bill_linked_no_fact:
    "Our Xero copy links a supplier bill to the job, but no materials fact counts it.",
  no_job_work_order: "The job has no job work order (kind job).",
  work_order_draft: "The job work order is a draft: not approved, not sealed.",
  work_order_not_sealed:
    "The job work order is approved but carries no seal hash.",
  no_crew_lines: "No crew pay line is on the job.",
  line_not_on_work_order:
    "A crew line on the job is not stamped onto the job work order.",
  crew_bill_held:
    "A crew line waits on office review (awaiting, queried or rejected), so its invoice is held out of Xero.",
  crew_bill_not_in_xero:
    "A crew invoice with lines on the job has no Xero bill.",
  no_customer_invoice: "No customer invoice is on the job.",
  invoice_draft_only: "The job's customer invoices are all drafts in Xero.",
  party_not_invoiced:
    "A paying party on the job has no customer invoice of its own.",
  no_live_card_reading:
    "The job card has no live reading (no live ledger generation).",
  revision_differs:
    "A record names a scope revision that is not the accepted one (or, with none accepted, the records name different revisions).",
  revision_not_on_job:
    "A record names a scope revision that is not one of this job's revisions.",
  revision_not_named:
    "A record that should name a scope revision names none (made before it kept the revision).",
  no_accepted_revision:
    "No accepted scope revision is on record, so the named revisions cannot be checked against it.",
  h7_not_released:
    "The H7 bill outcome reader is not on main (backend drafts #1129 and #1141), so the card shows no bill outcome yet.",
} as const;

export type JobTraceResult = { status: number; body: Record<string, unknown> };

export type JobTraceView = "staff" | "figure_free";

/**
 * Who may read the trace, and which shape they get. An admin/owner session
 * reads the staff shape (the figures the Money pages already show). The ops
 * key (auth mode api_key, which the agents also hold) reads the figure-free
 * shape only. Every other caller is refused.
 */
export function jobTraceView(
  authMode: string,
  role: string | null | undefined,
): JobTraceView | null {
  if (authMode === "api_key") return "figure_free";
  const r = String(role || "").toLowerCase();
  if (authMode === "jwt" && (r === "admin" || r === "owner")) return "staff";
  return null;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROW_LIMIT = 500;

type Read = { rows: any[]; error: string | null; truncated: boolean };

async function read(query: any, label: string): Promise<Read> {
  try {
    const { data, error } = await query;
    if (error) {
      return {
        rows: [],
        error: `${label}: ${error.message ?? String(error)}`,
        truncated: false,
      };
    }
    const rows = Array.isArray(data) ? data : data ? [data] : [];
    return { rows, error: null, truncated: rows.length >= ROW_LIMIT };
  } catch (e) {
    return {
      rows: [],
      error: `${label}: ${e instanceof Error ? e.message : String(e)}`,
      truncated: false,
    };
  }
}

function link(
  id: string,
  name: string,
  state: LinkState,
  reason: string | null,
  items: Record<string, unknown>[],
  notes: string[] = [],
): TraceLink {
  return { link: id, name, state, reason, notes, items };
}

function unknownLink(id: string, name: string, errors: string[]): TraceLink {
  return {
    link: id,
    name,
    state: "unknown",
    reason: "read_failed",
    notes: [],
    items: [],
    error: errors.join("; "),
  };
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function uniq(values: unknown[]): string[] {
  const out = new Set<string>();
  for (const v of values) {
    if (typeof v === "string" && v) out.add(v);
  }
  return [...out];
}

// ── L1 · quote ──────────────────────────────────────────────────────────
//
// Which revision was accepted follows the rule the work order fill and the
// expected-costs freeze use (job_work_order_quote_fill.ts readAcceptedQuote):
// the revision recorded at acceptance, else the latest frozen at or before
// accepted_at, else (an open job with no acceptance stamp) the newest still
// frozen. Only ids, statuses and hashes are read, never the canonical text.

export function acceptedScopeRevision(
  job: any,
  revisions: any[],
): { row: any; source: string } | null {
  const accepted = typeof job.accepted_at === "string" && job.accepted_at
    ? job.accepted_at
    : null;
  const open = JOB_WORK_ORDER_OPEN_STATUSES.has(String(job.status || ""));
  const settled = revisions.filter((r) =>
    r.status === "frozen" || r.status === "superseded"
  );
  const byFrozen = (a: any, b: any) =>
    String(b.frozen_at || "").localeCompare(String(a.frozen_at || ""));

  let chosen: any = null;
  let source: string | null = null;
  const recorded = typeof job.accepted_scope_revision_id === "string"
    ? job.accepted_scope_revision_id
    : null;
  if (recorded) {
    chosen = settled.find((r) => r.id === recorded) ?? null;
    if (chosen) source = "accepted_revision";
  }
  if (!chosen && accepted) {
    chosen = settled.filter((r) => r.frozen_at && r.frozen_at <= accepted)
      .sort(byFrozen)[0] ?? null;
    if (chosen) source = "revision_at_acceptance";
  }
  if (!chosen && !accepted && !recorded && open) {
    chosen = revisions.filter((r) => r.status === "frozen").sort(byFrozen)[0] ??
      null;
    if (chosen) source = "latest_frozen_revision";
  }
  return chosen && source ? { row: chosen, source } : null;
}

export function buildQuoteLink(
  job: any,
  revisions: any[],
  sentQuotes: any[],
  builderQuotes: any[],
): TraceLink {
  const accepted = typeof job.accepted_at === "string" && job.accepted_at
    ? job.accepted_at
    : null;
  const recorded = typeof job.accepted_scope_revision_id === "string"
    ? job.accepted_scope_revision_id
    : null;
  const open = JOB_WORK_ORDER_OPEN_STATUSES.has(String(job.status || ""));
  const pick = acceptedScopeRevision(job, revisions);
  const chosen = pick?.row ?? null;
  const source = pick?.source ?? null;

  const sent = sentQuotes.filter((q) => q.sent_at);
  const issued = builderQuotes.filter((q) => q.status === "issued");
  const items: Record<string, unknown>[] = [];
  if (chosen) {
    items.push({
      kind: "scope_revision",
      key: `revision ${chosen.revision_number}`,
      row_id: chosen.id,
      state: chosen.status,
      source,
      scope_hash: chosen.scope_hash ?? null,
      pricing_hash: chosen.pricing_hash ?? null,
      frozen_at: chosen.frozen_at ?? null,
    });
  }
  for (const q of sent) {
    items.push({
      kind: "sent_quote",
      key: `version ${q.version}`,
      row_id: q.id,
      state: "sent",
      sent_at: q.sent_at,
    });
  }
  for (const q of issued) {
    items.push({
      kind: "quote_builder_quote",
      key: q.quote_number ?? `version ${q.version}`,
      row_id: q.id,
      state: "issued",
      issued_at: q.issued_at ?? null,
    });
  }

  if (!accepted && !recorded && !open) {
    return link("L1", "quote", "missing", "job_not_accepted", items);
  }
  if (chosen) return link("L1", "quote", "present", null, items);
  if (sent.length > 0 || issued.length > 0) {
    return link(
      "L1",
      "quote",
      "partial",
      "accepted_without_frozen_revision",
      items,
    );
  }
  return link("L1", "quote", "missing", "no_accepted_quote", items);
}

// ── Revision agreement (RQ-19.d) ────────────────────────────────────────
//
// Every record that keeps the scope revision it was made from, read by its
// own column, set beside the accepted revision (the same rule as L1). Only
// the newest sent quote counts: an older one may rightly name an older
// revision. A record with no revision is listed as not named: it breaks no
// agreement but makes it partial. Ids only, never a figure. States: agree,
// partial, differs, no_accepted_revision, unknown (a read failed).

export const MATERIAL_LINE_REVISION_KINDS = new Set([
  "fence_scope_revision",
  "patio_scope_revision",
]);

export type RevisionSources = {
  quotes: any[];
  workOrders: any[];
  materialLines: any[];
  fills: any[];
  draftSets: any[];
};

type Named = {
  kind: string;
  row_id: string | null;
  id: unknown;
  count?: number;
};

export function buildRevisionAgreement(
  job: any,
  revisions: any[],
  sources: RevisionSources,
): Record<string, unknown> {
  const pick = acceptedScopeRevision(job, revisions);
  const byId = new Map(revisions.map((r) => [r.id, r]));
  const named: Named[] = [];

  named.push({
    kind: "job_costs",
    row_id: job.id,
    id: job.accepted_scope_revision_id,
  });
  const newestSent = sources.quotes.filter((q) => q.sent_at)
    .sort((a, b) => String(b.sent_at).localeCompare(String(a.sent_at)))[0];
  if (newestSent) {
    named.push({
      kind: "sent_quote",
      row_id: newestSent.id,
      id: newestSent.scope_revision_id,
    });
  }
  for (const w of sources.workOrders) {
    named.push({
      kind: "job_work_order",
      row_id: w.id,
      id: w.quote_filled_scope_revision_id,
    });
  }
  for (const f of sources.fills) {
    named.push({
      kind: "dispatch_fill",
      row_id: f.job_id,
      id: f.scope_revision_id,
    });
  }
  const lineGroups = new Map<string, number>();
  for (const l of sources.materialLines) {
    if (!MATERIAL_LINE_REVISION_KINDS.has(String(l.source_kind || ""))) {
      continue;
    }
    const key = typeof l.source_version_id === "string"
      ? l.source_version_id
      : "";
    lineGroups.set(key, (lineGroups.get(key) ?? 0) + 1);
  }
  for (
    const [key, count] of [...lineGroups].sort(([a], [b]) => a.localeCompare(b))
  ) {
    named.push({
      kind: "material_lines",
      row_id: null,
      id: key || null,
      count,
    });
  }
  for (const d of sources.draftSets) {
    named.push({
      kind: "scope_job_drafts",
      row_id: d.job_id,
      id: d.scope_revision_id,
    });
    if (d.acceptance_scope_revision_id != null) {
      named.push({
        kind: "scope_job_drafts_acceptance",
        row_id: d.job_id,
        id: d.acceptance_scope_revision_id,
      });
    }
  }

  const accepted = pick?.row ?? null;
  const notes = new Set<string>();
  const items = named.map((n) => {
    const id = typeof n.id === "string" && n.id ? n.id : null;
    const rev = id ? byId.get(id) : undefined;
    let state: string;
    if (!id) {
      state = "not_named";
      if (n.kind !== "job_costs" || accepted) notes.add("revision_not_named");
    } else if (!rev) {
      state = "not_on_job";
      notes.add("revision_not_on_job");
    } else if (accepted) {
      state = id === accepted.id ? "agrees" : "differs";
      if (state === "differs") notes.add("revision_differs");
    } else {
      state = "named";
    }
    const item: Record<string, unknown> = {
      kind: n.kind,
      row_id: n.row_id,
      scope_revision_id: id,
      revision_number: rev?.revision_number ?? null,
      state,
    };
    if (n.count !== undefined) item.line_count = n.count;
    return item;
  });

  if (!accepted) {
    const ids = new Set(
      items.filter((i) => i.state === "named").map((i) => i.scope_revision_id),
    );
    if (ids.size > 1) {
      notes.add("revision_differs");
      for (const i of items) if (i.state === "named") i.state = "differs";
    }
    notes.add("no_accepted_revision");
  }

  const order = [
    "revision_not_on_job",
    "revision_differs",
    "no_accepted_revision",
    "revision_not_named",
  ];
  const codes = order.filter((c) => notes.has(c));
  const state = codes.includes("revision_not_on_job") ||
      codes.includes("revision_differs")
    ? "differs"
    : !accepted
    ? "no_accepted_revision"
    : codes.length
    ? "partial"
    : "agree";
  return {
    state,
    reason: state === "agree" ? null : codes[0],
    notes: codes,
    accepted: accepted
      ? {
        row_id: accepted.id,
        revision_number: accepted.revision_number ?? null,
        source: pick!.source,
      }
      : null,
    items,
  };
}

function unknownRevisionAgreement(errors: string[]): Record<string, unknown> {
  return {
    state: "unknown",
    reason: "read_failed",
    notes: [],
    accepted: null,
    items: [],
    error: errors.join("; "),
  };
}

// ── L2 · material lines ─────────────────────────────────────────────────

export function buildMaterialLinesLink(lines: any[]): TraceLink {
  if (lines.length === 0) {
    return link("L2", "material_lines", "missing", "no_material_lines", []);
  }
  const notes: string[] = [];
  if (lines.some((l) => l.status === "not_reviewed")) {
    notes.push("lines_not_reviewed");
  }
  if (lines.some((l) => l.status === "to_order" && !l.purchase_order_id)) {
    notes.push("lines_not_on_order");
  }
  const items = lines.map((l) => ({
    kind: "material_line",
    key: l.supplier_id,
    row_id: l.id,
    state: l.status,
    source: l.source ?? null,
    purchase_order_id: l.purchase_order_id ?? null,
  }));
  return notes.length
    ? link("L2", "material_lines", "partial", notes[0], items, notes)
    : link("L2", "material_lines", "present", null, items);
}

// ── L3 · purchase orders and their emails ───────────────────────────────

export function buildOrdersLink(pos: any[], emails: any[]): TraceLink {
  if (pos.length === 0) {
    return link("L3", "orders", "missing", "no_purchase_orders", []);
  }
  const notes = new Set<string>();
  const items = pos.map((po) => {
    const own = emails.filter((e) => e.purchase_order_id === po.id);
    const sent = own.filter((e) => e.status === "sent");
    const inFlight = own.some((e) =>
      e.status === "sending" || e.status === "send_unknown"
    );
    let state: string;
    if (po.source !== "dispatch") {
      state = "legacy";
      notes.add("legacy_po");
    } else if (sent.length > 0) {
      state = "sent";
    } else if (inFlight) {
      state = "send_unknown";
      notes.add("order_send_unknown");
    } else {
      state = "not_sent";
      notes.add("order_not_sent");
    }
    return {
      kind: "purchase_order",
      key: po.po_number ?? null,
      row_id: po.id,
      state,
      po_status: po.status ?? null,
      source: po.source ?? null,
      supplier_id: po.supplier_id ?? null,
      supplier_name: po.supplier_name ?? null,
      reference: po.reference ?? null,
      xero_po_id: po.xero_po_id ?? null,
      xero_bill_id: po.xero_bill_id ?? null,
      emails: own.map((e) => ({
        row_id: e.id,
        kind: e.kind ?? null,
        state: e.status,
        sent_at: e.sent_at ?? null,
        sent_via: e.sent_via ?? null,
      })),
      amounts: { subtotal: num(po.subtotal), total: num(po.total) },
    };
  });
  const codes = [...notes];
  return codes.length
    ? link("L3", "orders", "partial", codes[0], items, codes)
    : link("L3", "orders", "present", null, items);
}

// ── L4 · supplier bills and their facts ─────────────────────────────────

// Supplier invoice numbers a purchase order's reference names, such as
// "R&R INV-86844" on SWF-26979's PO-298035. A lead to look up, never a
// placement: the trace only reports what the matcher and the queue decided.
const BILL_TOKEN_RE = /\b[A-Z]{0,6}-?\d{4,}\b/gi;

export function billTokensFromOrders(pos: any[], jobNumber: string): string[] {
  const out = new Set<string>();
  const skip = new Set<string>([String(jobNumber || "").toUpperCase()]);
  for (const po of pos) {
    if (po.po_number) skip.add(String(po.po_number).toUpperCase());
  }
  for (const po of pos) {
    const ref = typeof po.reference === "string" ? po.reference : "";
    for (const m of ref.match(BILL_TOKEN_RE) ?? []) {
      const token = m.toUpperCase();
      if (skip.has(token) || token.startsWith("PO")) continue;
      if (/^SW(?:MS|[A-Z])-\d{4,6}$/.test(token)) continue;
      out.add(token);
    }
  }
  return [...out];
}

export function buildSupplierBillsLink(
  facts: any[],
  queueRows: any[],
  linkedBills: any[],
  namedBills: any[],
  crewBillIds: Set<string>,
): TraceLink {
  const byInvoice = new Map<string, Record<string, unknown>>();
  const notes = new Set<string>();
  for (const f of facts) {
    byInvoice.set(f.xero_invoice_id, {
      kind: "supplier_bill",
      key: f.invoice_number ?? null,
      row_id: f.xero_invoice_id,
      state: "placed",
      fact_id: f.id,
      source: f.automation_source ?? null,
      confidence: f.confidence ?? null,
      matched_po_id: f.matched_po_id ?? null,
      lane: f.lane ?? null,
      supplier: f.contact_name ?? null,
      found_via: "materials_fact",
      amounts: { amount_ex_gst: num(f.amount_ex_gst) },
    });
  }
  const queueByInvoice = new Map<string, any>();
  for (const q of queueRows) queueByInvoice.set(q.xero_invoice_id, q);

  const addUnplaced = (bill: any, foundVia: string) => {
    if (byInvoice.has(bill.xero_invoice_id)) return;
    if (crewBillIds.has(bill.xero_invoice_id)) return;
    const q = queueByInvoice.get(bill.xero_invoice_id);
    let state: string;
    let reason: string | null = null;
    if (q) {
      state = q.status === "open" ? "not_placed" : q.status;
      reason = q.suggestion_reason ?? null;
    } else {
      state = foundVia === "xero_copy_job_link"
        ? "linked_no_fact"
        : "not_placed";
    }
    if (state === "not_placed") notes.add("bill_not_placed");
    if (state === "linked_no_fact") notes.add("bill_linked_no_fact");
    byInvoice.set(bill.xero_invoice_id, {
      kind: "supplier_bill",
      key: bill.invoice_number ?? q?.invoice_number ?? null,
      row_id: bill.xero_invoice_id,
      state,
      queue_id: q?.id ?? null,
      queue_reason: reason,
      queue_suggestion: q?.suggestion_confidence ?? null,
      xero_status: bill.status ?? null,
      supplier: bill.contact_name ?? q?.contact_name ?? null,
      found_via: foundVia,
      amounts: {
        sub_total: num(bill.sub_total ?? q?.sub_total),
        total: num(bill.total ?? q?.total),
      },
    });
  };
  for (const b of linkedBills) addUnplaced(b, "xero_copy_job_link");
  for (const b of namedBills) addUnplaced(b, "named_by_po_reference");
  for (const q of queueRows) {
    if (q.status === "not_job_related") continue;
    addUnplaced(q, "queue_suggestion");
  }

  const items = [...byInvoice.values()];
  const placed = items.filter((i) => i.state === "placed").length;
  const codes = [...notes];
  if (items.length === 0) {
    return link("L4", "supplier_bills", "missing", "no_supplier_bills", []);
  }
  if (placed === 0) {
    return link(
      "L4",
      "supplier_bills",
      "missing",
      codes[0] ?? "no_supplier_bills",
      items,
      codes,
    );
  }
  return codes.length
    ? link("L4", "supplier_bills", "partial", codes[0], items, codes)
    : link("L4", "supplier_bills", "present", null, items);
}

// ── L5 · job work order ─────────────────────────────────────────────────

export function buildWorkOrderLink(workOrders: any[]): TraceLink {
  const live = workOrders.filter((w) => w.status !== "cancelled");
  if (live.length === 0) {
    return link("L5", "work_order", "missing", "no_job_work_order", []);
  }
  const items = live.map((w) => ({
    kind: "job_work_order",
    key: w.wo_number ?? null,
    row_id: w.id,
    state: w.status,
    approved_at: w.approved_at ?? null,
    approved_via: w.approved_via ?? null,
    sealed: typeof w.sealed_content_hash === "string" &&
      w.sealed_content_hash.length > 0,
    sealed_content_hash: w.sealed_content_hash ?? null,
    quote_filled_at: w.quote_filled_at ?? null,
    hand_edited_at: w.hand_edited_at ?? null,
    amounts: { agreed_labour_ex: num(w.agreed_labour_ex) },
  }));
  const approved = items.find((i) => i.approved_at);
  if (!approved) {
    return link("L5", "work_order", "partial", "work_order_draft", items);
  }
  if (!approved.sealed) {
    return link("L5", "work_order", "partial", "work_order_not_sealed", items);
  }
  return link("L5", "work_order", "present", null, items);
}

// ── L6 · crew lines and their Xero bills ────────────────────────────────

const HELD_REVIEW = new Set(["awaiting", "queried", "rejected"]);

export function buildCrewLinesLink(lines: any[], invoices: any[]): TraceLink {
  if (lines.length === 0) {
    return link("L6", "crew_lines", "missing", "no_crew_lines", []);
  }
  const invoiceById = new Map<string, any>();
  for (const inv of invoices) invoiceById.set(inv.id, inv);
  const notes = new Set<string>();
  const items = lines.map((l) => {
    const inv = invoiceById.get(l.trade_invoice_id) ?? null;
    let state: string;
    if (HELD_REVIEW.has(String(l.office_review_status || ""))) {
      state = "held";
      notes.add("crew_bill_held");
    } else if (inv?.xero_bill_id) {
      state = "billed";
    } else {
      state = "not_in_xero";
      notes.add("crew_bill_not_in_xero");
    }
    if (!l.job_work_order_id) notes.add("line_not_on_work_order");
    return {
      kind: "crew_line",
      key: inv?.invoice_number ?? null,
      row_id: l.id,
      state,
      line_type: l.line_type ?? null,
      trade_invoice_id: l.trade_invoice_id ?? null,
      invoice_status: inv?.status ?? null,
      job_work_order_id: l.job_work_order_id ?? null,
      office_review_status: l.office_review_status ?? null,
      xero_bill_id: inv?.xero_bill_id ?? null,
      xero_bill_status: inv?.xero_bill_status ?? null,
    };
  });
  const codes = [...notes];
  return codes.length
    ? link("L6", "crew_lines", "partial", codes[0], items, codes)
    : link("L6", "crew_lines", "present", null, items);
}

// ── L7 · customer invoices and payments, per party ──────────────────────

const DEAD_INVOICE = new Set(["VOIDED", "DELETED"]);
const DRAFT_INVOICE = new Set(["DRAFT", "SUBMITTED"]);

export function buildInvoicesLink(invoices: any[], parties: any[]): TraceLink {
  const live = invoices.filter((i) =>
    !DEAD_INVOICE.has(String(i.status || "").toUpperCase())
  );
  const partyById = new Map<string, any>();
  for (const p of parties) partyById.set(p.id, p);
  const items = live.map((i) => {
    const status = String(i.status || "").toUpperCase();
    const party = i.job_contact_id ? partyById.get(i.job_contact_id) : null;
    let state: string;
    if (DRAFT_INVOICE.has(status)) state = "draft";
    else if (status === "PAID") state = "paid";
    else state = "owing";
    return {
      kind: "customer_invoice",
      key: i.invoice_number ?? null,
      row_id: i.xero_invoice_id,
      state,
      xero_status: i.status ?? null,
      party: party?.contact_label ?? null,
      job_contact_id: i.job_contact_id ?? null,
      reference: i.reference ?? null,
      invoice_date: i.invoice_date ?? null,
      fully_paid_on: i.fully_paid_on ?? null,
      amounts: { total: num(i.total), amount_due: num(i.amount_due) },
    };
  });
  if (items.length === 0) {
    return link("L7", "invoices", "missing", "no_customer_invoice", []);
  }
  if (items.every((i) => i.state === "draft")) {
    return link("L7", "invoices", "partial", "invoice_draft_only", items);
  }
  // A party counts as invoiced when an invoice names it. With one party and
  // invoices that name none, that party is the one invoiced.
  const liveParties = parties.filter((p) => !p.removed_at);
  const named = new Set(uniq(items.map((i) => i.job_contact_id)));
  const missingParty = liveParties.length > 1 &&
    liveParties.some((p) => !named.has(p.id));
  if (missingParty) {
    return link("L7", "invoices", "partial", "party_not_invoiced", items);
  }
  return link("L7", "invoices", "present", null, items);
}

// ── L8 · the job card and the H7 outcome ────────────────────────────────

export function buildCardLink(
  generations: any[],
  itemStatuses: any[],
): TraceLink {
  const live = generations.find((g) => g.status === "live") ?? null;
  const counts: Record<string, number> = {};
  for (const r of itemStatuses) {
    const s = String(r.status || "unknown");
    counts[s] = (counts[s] ?? 0) + 1;
  }
  const items: Record<string, unknown>[] = [];
  if (live) {
    items.push({
      kind: "card_reading",
      key: live.reader ?? null,
      row_id: live.id,
      state: "live",
      promoted_at: live.promoted_at ?? null,
      evidence_until: live.evidence_until ?? null,
      item_counts: counts,
    });
  }
  // The H7 outcome reader is a draft (#1129, #1141). When it merges, INT-10
  // reads it here and this item carries its state.
  items.push({
    kind: "h7_outcome",
    key: null,
    row_id: null,
    state: "not_released",
  });
  if (!live) {
    return link("L8", "card", "missing", "no_live_card_reading", items, [
      "h7_not_released",
    ]);
  }
  return link("L8", "card", "partial", "h7_not_released", items, [
    "h7_not_released",
  ]);
}

// ── The answer ──────────────────────────────────────────────────────────

/**
 * The first link that breaks the chain: the first `missing` one, unless a
 * link before it is `unknown`, in which case where the chain breaks is not
 * known. A `partial` link is reported but does not break the chain.
 */
export function firstGap(links: TraceLink[]): Record<string, unknown> | null {
  for (const l of links) {
    if (l.state === "unknown") {
      return { link: l.link, name: l.name, state: "unknown", reason: l.reason };
    }
    if (l.state === "missing") {
      return { link: l.link, name: l.name, state: "missing", reason: l.reason };
    }
  }
  return null;
}

/** Drops every `amounts` object, at any depth. The agent shape. */
export function figureFree<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => figureFree(v)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "amounts") continue;
      out[k] = figureFree(v);
    }
    return out as T;
  }
  return value;
}

const JOB_COLUMNS =
  "id, job_number, type, status, accepted_at, accepted_scope_revision_id:expected_costs->>scope_revision_id";

async function resolveJob(
  client: any,
  params: URLSearchParams,
): Promise<{ job?: any; fail?: JobTraceResult }> {
  const jobId = (params.get("job_id") || params.get("jobId") || "").trim();
  const jobNumber = (params.get("job_number") || params.get("jobNumber") || "")
    .trim().toUpperCase();
  if (!jobId && !jobNumber) {
    return {
      fail: { status: 400, body: { error: "job_number or job_id required" } },
    };
  }
  if (jobId && !UUID_RE.test(jobId)) {
    return { fail: { status: 400, body: { error: "job_id must be a UUID" } } };
  }
  if (!jobId && !/^[A-Z0-9-]{3,40}$/.test(jobNumber)) {
    return {
      fail: { status: 400, body: { error: "job_number is not a job number" } },
    };
  }
  const q = client.from("jobs").select(JOB_COLUMNS);
  const r = await read(
    (jobId ? q.eq("id", jobId) : q.eq("job_number", jobNumber)).limit(2),
    "jobs",
  );
  if (r.error) {
    return {
      fail: { status: 500, body: { error: `job read failed: ${r.error}` } },
    };
  }
  if (r.rows.length === 0) {
    return { fail: { status: 404, body: { error: "no job matches" } } };
  }
  if (r.rows.length > 1) {
    return {
      fail: {
        status: 409,
        body: {
          error: "job_number matches more than one job; pass job_id",
          job_ids: r.rows.map((j: any) => j.id),
        },
      },
    };
  }
  return { job: r.rows[0] };
}

/** ops-api `job_trace`: one job's chain, link by link. Read only. */
export async function jobTraceAction(
  client: any,
  params: URLSearchParams,
  view: JobTraceView,
): Promise<JobTraceResult> {
  const resolved = await resolveJob(client, params);
  if (resolved.fail) return resolved.fail;
  const job = resolved.job;
  const jobId = job.id;

  // Round 1: everything keyed by the job alone.
  const [
    revisions,
    sentQuotes,
    builderQuotes,
    lines,
    pos,
    emails,
    facts,
    queueRows,
    linkedBills,
    workOrders,
    crewLines,
    invoices,
    parties,
    generations,
    revQuotes,
    revWorkOrders,
    revLines,
    revFills,
    revDraftSets,
  ] = await Promise.all([
    read(
      client.from("scope_revisions")
        .select(
          "id, revision_number, status, scope_hash, pricing_hash, frozen_at, superseded_at",
        )
        .eq("job_id", jobId).limit(ROW_LIMIT),
      "scope_revisions",
    ),
    read(
      client.from("quote_revisions").select("id, version, sent_at")
        .eq("job_id", jobId).limit(ROW_LIMIT),
      "quote_revisions",
    ),
    read(
      client.from("quote_builder_versions")
        .select("id, version, status, quote_number, issued_at")
        .eq("job_id", jobId).eq("kind", "scope").limit(ROW_LIMIT),
      "quote_builder_versions",
    ),
    read(
      client.from("job_material_lines")
        .select("id, supplier_id, status, source, purchase_order_id")
        .eq("job_id", jobId).limit(ROW_LIMIT),
      "job_material_lines",
    ),
    read(
      client.from("purchase_orders")
        .select(
          "id, po_number, supplier_id, supplier_name, source, status, reference, xero_po_id, xero_bill_id, subtotal, total",
        )
        .eq("job_id", jobId).neq("status", "deleted").limit(ROW_LIMIT),
      "purchase_orders",
    ),
    read(
      client.from("job_order_emails")
        .select("id, purchase_order_id, kind, status, sent_at, sent_via")
        .eq("job_id", jobId).neq("status", "discarded").limit(ROW_LIMIT),
      "job_order_emails",
    ),
    read(
      client.from("job_materials_facts")
        .select(
          "id, xero_invoice_id, invoice_number, contact_name, lane, confidence, automation_source, matched_po_id, amount_ex_gst",
        )
        .eq("job_id", jobId).eq("kind", "actual").limit(ROW_LIMIT),
      "job_materials_facts",
    ),
    read(
      client.from("materials_reconciliation_queue")
        .select(
          "id, xero_invoice_id, invoice_number, contact_name, status, suggestion_reason, suggestion_confidence, sub_total, total",
        )
        .eq("suggested_job_id", jobId).limit(ROW_LIMIT),
      "materials_reconciliation_queue",
    ),
    read(
      client.from("xero_invoices")
        .select(
          "xero_invoice_id, invoice_number, contact_name, status, sub_total, total",
        )
        .eq("job_id", jobId).eq("invoice_type", "ACCPAY").limit(ROW_LIMIT),
      "xero_invoices (bills)",
    ),
    read(
      client.from("work_orders")
        .select(
          "id, wo_number, status, approved_at, approved_via, sealed_content_hash, quote_filled_at, hand_edited_at, agreed_labour_ex",
        )
        .eq("job_id", jobId).eq("kind", "job").limit(ROW_LIMIT),
      "work_orders",
    ),
    read(
      client.from("trade_invoice_lines")
        .select(
          "id, trade_invoice_id, line_type, job_work_order_id, office_review_status",
        )
        .eq("job_id", jobId).limit(ROW_LIMIT),
      "trade_invoice_lines",
    ),
    read(
      client.from("xero_invoices")
        .select(
          "xero_invoice_id, invoice_number, status, reference, job_contact_id, invoice_date, fully_paid_on, total, amount_due",
        )
        .eq("job_id", jobId).eq("invoice_type", "ACCREC").limit(ROW_LIMIT),
      "xero_invoices (customer)",
    ),
    read(
      client.from("job_contacts").select("id, contact_label, removed_at")
        .eq("job_id", jobId).limit(ROW_LIMIT),
      "job_contacts",
    ),
    read(
      client.from("context_ledger_generations")
        .select("id, status, reader, promoted_at, evidence_until")
        .eq("job_id", jobId).eq("status", "live").limit(2),
      "context_ledger_generations",
    ),
    // Revision agreement: own reads, so a missing column touches no link.
    read(
      client.from("quote_revisions").select("id, sent_at, scope_revision_id")
        .eq("job_id", jobId).limit(ROW_LIMIT),
      "quote_revisions (revision)",
    ),
    read(
      client.from("work_orders").select("id, quote_filled_scope_revision_id")
        .eq("job_id", jobId).eq("kind", "job").limit(ROW_LIMIT),
      "work_orders (revision)",
    ),
    read(
      client.from("job_material_lines")
        .select("id, source_kind, source_version_id")
        .eq("job_id", jobId).limit(ROW_LIMIT),
      "job_material_lines (revision)",
    ),
    read(
      client.from("dispatch_v2_scope_fills").select("job_id, scope_revision_id")
        .eq("job_id", jobId).limit(ROW_LIMIT),
      "dispatch_v2_scope_fills",
    ),
    read(
      client.from("scope_job_draft_sets")
        .select("job_id, scope_revision_id, acceptance_scope_revision_id")
        .eq("job_id", jobId).limit(ROW_LIMIT),
      "scope_job_draft_sets",
    ),
  ]);

  // Round 2: reads keyed by round 1's rows.
  const tradeInvoiceIds = uniq(crewLines.rows.map((l) => l.trade_invoice_id));
  const tokens = pos.error
    ? []
    : billTokensFromOrders(pos.rows, job.job_number);
  const poBillIds = uniq(pos.rows.map((p) => p.xero_bill_id));
  const liveGeneration = generations.rows.find((g) => g.status === "live");
  const none: Read = { rows: [], error: null, truncated: false };
  const [tradeInvoices, namedByNumber, namedById, cardItems] = await Promise
    .all([
      tradeInvoiceIds.length
        ? read(
          client.from("trade_invoices")
            .select(
              "id, invoice_number, status, xero_bill_id, xero_bill_status",
            )
            .in("id", tradeInvoiceIds),
          "trade_invoices",
        )
        : none,
      tokens.length
        ? read(
          client.from("xero_invoices")
            .select(
              "xero_invoice_id, invoice_number, contact_name, status, sub_total, total",
            )
            .eq("invoice_type", "ACCPAY").in("invoice_number", tokens)
            .limit(50),
          "xero_invoices (named by PO)",
        )
        : none,
      poBillIds.length
        ? read(
          client.from("xero_invoices")
            .select(
              "xero_invoice_id, invoice_number, contact_name, status, sub_total, total",
            )
            .eq("invoice_type", "ACCPAY").in("xero_invoice_id", poBillIds)
            .limit(50),
          "xero_invoices (PO bill id)",
        )
        : none,
      liveGeneration
        ? read(
          client.from("context_ledger_items").select("status")
            .eq("generation_id", liveGeneration.id).limit(2000),
          "context_ledger_items",
        )
        : none,
    ]);

  // The queue rows for the bills the POs name (they carry the matcher's reason).
  const namedBills = [...namedByNumber.rows, ...namedById.rows];
  const namedIds = uniq(namedBills.map((b) => b.xero_invoice_id))
    .filter((id) => !queueRows.rows.some((q) => q.xero_invoice_id === id));
  const namedQueue = namedIds.length
    ? await read(
      client.from("materials_reconciliation_queue")
        .select(
          "id, xero_invoice_id, invoice_number, contact_name, status, suggestion_reason, suggestion_confidence, sub_total, total",
        )
        .in("xero_invoice_id", namedIds),
      "materials_reconciliation_queue (named)",
    )
    : none;

  // A crew bill mirror (trade_invoices.xero_bill_id) is never a supplier bill.
  const crewBillIds = new Set(
    uniq(tradeInvoices.rows.map((t) => t.xero_bill_id)),
  );

  const errs = (...rs: Read[]) =>
    rs.map((r) => r.error).filter(Boolean) as string[];
  const trunc = (l: TraceLink, ...rs: Read[]) => {
    if (rs.some((r) => r.truncated)) l.truncated = true;
    return l;
  };
  const build = (
    id: string,
    name: string,
    rs: Read[],
    make: () => TraceLink,
  ): TraceLink => {
    const e = errs(...rs);
    return e.length ? unknownLink(id, name, e) : trunc(make(), ...rs);
  };

  const links: TraceLink[] = [
    build(
      "L1",
      "quote",
      [revisions, sentQuotes, builderQuotes],
      () =>
        buildQuoteLink(
          job,
          revisions.rows,
          sentQuotes.rows,
          builderQuotes.rows,
        ),
    ),
    build(
      "L2",
      "material_lines",
      [lines],
      () => buildMaterialLinesLink(lines.rows),
    ),
    build(
      "L3",
      "orders",
      [pos, emails],
      () => buildOrdersLink(pos.rows, emails.rows),
    ),
    build(
      "L4",
      "supplier_bills",
      [
        facts,
        queueRows,
        linkedBills,
        pos,
        namedByNumber,
        namedById,
        namedQueue,
        tradeInvoices,
      ],
      () =>
        buildSupplierBillsLink(
          facts.rows,
          [...queueRows.rows, ...namedQueue.rows],
          linkedBills.rows,
          namedBills,
          crewBillIds,
        ),
    ),
    build(
      "L5",
      "work_order",
      [workOrders],
      () => buildWorkOrderLink(workOrders.rows),
    ),
    build(
      "L6",
      "crew_lines",
      [crewLines, tradeInvoices],
      () => buildCrewLinesLink(crewLines.rows, tradeInvoices.rows),
    ),
    build(
      "L7",
      "invoices",
      [invoices, parties],
      () => buildInvoicesLink(invoices.rows, parties.rows),
    ),
    build(
      "L8",
      "card",
      [generations, cardItems],
      () => buildCardLink(generations.rows, cardItems.rows),
    ),
  ];

  const revisionReads = [
    revisions,
    revQuotes,
    revWorkOrders,
    revLines,
    revFills,
    revDraftSets,
  ];
  const revisionErrors = errs(...revisionReads);
  const revisionAgreement = revisionErrors.length
    ? unknownRevisionAgreement(revisionErrors)
    : buildRevisionAgreement(job, revisions.rows, {
      quotes: revQuotes.rows,
      workOrders: revWorkOrders.rows,
      materialLines: revLines.rows,
      fills: revFills.rows,
      draftSets: revDraftSets.rows,
    });
  if (revisionReads.some((r) => r.truncated)) {
    revisionAgreement.truncated = true;
  }

  const body: Record<string, unknown> = {
    ok: true,
    version: JOB_TRACE_VERSION,
    view,
    job: {
      id: job.id,
      job_number: job.job_number ?? null,
      type: job.type ?? null,
      status: job.status ?? null,
      accepted_at: job.accepted_at ?? null,
    },
    first_gap: firstGap(links),
    links,
    revisions: revisionAgreement,
    reasons: JOB_TRACE_REASONS,
  };
  return { status: 200, body: view === "staff" ? body : figureFree(body) };
}
