// Builder reference rule (finish line B3, 3 Nov 2026).
//
// A builder invoice raised straight in Xero carries the builder's claim and
// purchase order (MLB-26303PO-58097, AJBR-70487, 20305206-05) and no job number
// of ours, so the reference link never fires and only Bookkeeping's ledger
// placed it, days later (INV-1772, INV-1775, INV-1787, INV-1805).
//
// A plain claim or PO rule is not safe: the claim and the PO often sit on the
// make-safe card while the repair or fence work is billed under them (INV-1580,
// INV-1419, INV-1646, INV-1775 went to the make-safe card in the 3 Nov test).
// A wrong invoice on a job is far worse than one left for a person
// (ops-api/makesafe_invoice_reference_match.ts), so this rule links only when
// exactly one job is left after every check, and otherwise names the
// candidates for a person:
//
//  1. Keys: the claim and PO digit runs (5+ digits) in the reference, or in the
//     first line when the reference has none. A run straight after "PO" is a PO;
//     Ambrose's "20305206-05" is claim 20305206 and PO 2030520605.
//  2. Candidates: every job whose own builder fields carry a key
//     (makesafe_job_details.external_ref; metadata external_ref,
//     builder_claim_ref, mlb_ref, builder_work_order_number, builder_po_number,
//     purchase_order_number), plus the open jobs at the same site
//     (context_address_key) for the same customer or builder that carry no
//     other instruction's reference. SQL: xero_builder_reference_candidates.
//  3. Trade: the invoice reads as make-safe or as works from its Xero tracking
//     (Business Unit) and its line text; only jobs of that trade stay (job type,
//     else prefix SWMS / SWR, SWF, SWP, SWB). Mixed or unclear text links nothing.
//     Temporary fencing words are make-safe words only, never works words.
//     Cancelled, lost, draft, holding and old-system jobs never stay, nor a
//     finished job its other invoices already cover in full.
//  4. One job left: link. Several: the one whose own PO is the invoice's PO
//     (the PO is the instruction key, the claim the group: 2 Aug 2026 ruling).
//     A claim-only reference whose claim covers both a make-safe card and a
//     works job is left for a person: nothing in it names the instruction.
//
// Only invoices dated from 1 Jul 2026 (this financial year), the population it
// was measured on; older unlinked invoices stay with the other rules and a person.
//
// Measured on all 316 customer invoices since 1 Jul 2026 with no job number
// (truth: the job link, else Bookkeeping's evidence): context-system evidence
// 20261103-b3-rule.

export const BUILDER_REFERENCE_RULE = "builder_reference_v1";

/** The first invoice date the rule acts on (the measured population starts here). */
export const BUILDER_REFERENCE_FROM = "2026-07-01";

/** The sync-time reference link's job number pattern (index.ts upsert loop). */
export const REFERENCE_JOB_NUMBER = /SWMS-\d{4,6}(?!\d)|SWREST-\d{4,6}(?!\d)|SW[A-Z]?-?\d{3,6}(?!\d)/i;

const MAKESAFE_UNITS = new Set(["SW - MAKESAFE", "ROOF REPORTS", "ASSESSMENT REPORTS"]);
const WORKS_UNITS = new Set(["SW - INSURANCE WORK", "SW - FENCING", "SW - PATIOS"]);
const MAKESAFE_TEXT =
  /make[\s-]?safe|temp(?:orary)?\.?\s*fenc|fence hire|roof report|assessment report|inspection report|drying equipment|dehumidif|air mover|moisture|mould|restoration|attendance|re-?attend|\btrades? x \d/i;
const WORKS_TEXT =
  /remove (?:and|&|\/) ?(?:dispose|replace)|supply (?:and|&) install|replace|carpentry|fencing\s*[-(:]|\bgate|gutter|fascia|downpipe|cladding|deposit/i;
// Temporary fencing is make-safe gear, so its words never count as works: Ambrose's INV-1709
// "collected 5 panels of temp fencing (temp fence pickup)" read "fencing (" as a fence trade
// heading and went to a person as both trades (B3, 3 Nov 2026).
const TEMP_FENCE = /\btemp(?:orary)?\.?\s*fenc(?:e|es|ing)(?:\s+(?:panels?|gates?|hire))?/gi;

const DEAD_STATUSES = new Set(["cancelled", "lost", "draft"]);
const FINISHED_STATUSES = new Set(["complete", "invoiced", "final_payment", "archived"]);
const CLAIM_FIELDS = ["details_external_ref", "external_ref", "builder_claim_ref", "mlb_ref", "builder_work_order_number"] as const;
const PO_FIELDS = ["builder_po_number", "purchase_order_number"] as const;

export type InvoiceTrade = "makesafe" | "works" | "mixed" | "unknown";
export type JobTrade = "makesafe" | "works" | "any" | "other";

// deno-lint-ignore no-explicit-any
type LineItem = { Description?: string | null; Tracking?: any[] | null } & Record<string, any>;

export interface BuilderRefInvoice {
  id: string;
  xero_invoice_id?: string | null;
  invoice_number?: string | null;
  invoice_type?: string | null;
  invoice_date?: string | null;
  reference?: string | null;
  line_items?: LineItem[] | null;
}

/** One row of xero_builder_reference_candidates. */
export interface BuilderRefJob {
  id: string;
  job_number: string | null;
  type: string | null;
  status: string | null;
  legacy: boolean | null;
  created_at?: string | null;
  client_name: string | null;
  ghl_contact_id: string | null;
  site_key: string | null;
  builder: string | null;
  quoted_value: number | string | null;
  work_order_value_ex_gst: number | string | null;
  do_not_schedule: boolean | null;
  refs: Partial<Record<(typeof CLAIM_FIELDS)[number] | (typeof PO_FIELDS)[number], string | null>>;
  invoices: Array<{ id: string; invoice_number: string | null; total: number | string | null; status: string | null; created_at?: string | null }> | null;
}

export interface BuilderRefKeys {
  claims: string[];
  pos: string[];
  source: "reference" | "first_line" | null;
}

export interface BuilderRefCandidate {
  job_id: string;
  job_number: string | null;
  found: "reference" | "site";
  matched: string[];
  site_of: string[];
  trade: JobTrade;
  status: string | null;
  kept: boolean;
  dropped: string | null;
}

export interface BuilderRefEvidence {
  rule: typeof BUILDER_REFERENCE_RULE;
  keys: BuilderRefKeys;
  invoice_trade: InvoiceTrade;
  step?: "unique" | "po_instruction";
  candidates: BuilderRefCandidate[];
}

export type BuilderRefDecision =
  | {
    outcome: "not_applicable";
    reason: "not_customer_invoice" | "before_measured_period" | "job_number_in_reference" | "no_builder_reference";
  }
  | { outcome: "no_candidate"; evidence: BuilderRefEvidence }
  | { outcome: "link"; job_id: string; job_number: string | null; evidence: BuilderRefEvidence }
  | {
    outcome: "person";
    reason: "several_jobs" | "no_job_of_this_trade" | "trade_unclear" | "claim_only_cross_trade";
    evidence: BuilderRefEvidence;
  };

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const MONEY = /\$\s?[\d,]+(?:\.\d+)?/g;

/** Claim and PO keys of one text. Job numbers, SES tokens and dollar amounts are not keys. */
export function parseBuilderKeys(text: string | null | undefined): { claims: string[]; pos: string[] } {
  const s = String(text ?? "")
    .replace(new RegExp(REFERENCE_JOB_NUMBER.source, "gi"), " ")
    .replace(UUID, " ")
    .replace(MONEY, " ");
  const claims = new Set<string>();
  const pos = new Set<string>();
  for (const m of s.matchAll(/(PO[\s-]*)?(?<!\d)(\d{5,})(?:-(\d{2}))?(?!\d)/gi)) {
    if (m[1]) {
      pos.add(m[2]);
    } else {
      claims.add(m[2]);
      if (m[3]) pos.add(m[2] + m[3]);
    }
  }
  return { claims: [...claims], pos: [...pos] };
}

/** The invoice's keys: from the reference, else from the first line. */
export function builderReferenceKeys(invoice: BuilderRefInvoice): BuilderRefKeys {
  const fromRef = parseBuilderKeys(invoice.reference);
  if (fromRef.claims.length + fromRef.pos.length > 0) return { ...fromRef, source: "reference" };
  const first = Array.isArray(invoice.line_items) ? invoice.line_items[0]?.Description : null;
  const fromLine = parseBuilderKeys(first);
  if (fromLine.claims.length + fromLine.pos.length > 0) return { ...fromLine, source: "first_line" };
  return { claims: [], pos: [], source: null };
}

/** Make-safe or works, from the Business Unit tracking and the line text. */
export function invoiceTrade(invoice: BuilderRefInvoice): InvoiceTrade {
  const lines = Array.isArray(invoice.line_items) ? invoice.line_items : [];
  const units = new Set<string>();
  for (const line of lines) {
    for (const t of Array.isArray(line?.Tracking) ? line.Tracking : []) {
      const option = String(t?.Option ?? "").trim().toUpperCase();
      if (option) units.add(option);
    }
  }
  const text = `${lines.map((l) => l?.Description ?? "").join(" \n ")} \n ${invoice.reference ?? ""}`;
  const msText = MAKESAFE_TEXT.test(text);
  const worksText = WORKS_TEXT.test(text.replace(TEMP_FENCE, " "));
  const msUnit = [...units].some((u) => MAKESAFE_UNITS.has(u));
  const worksUnit = [...units].some((u) => WORKS_UNITS.has(u));
  if (msUnit && worksUnit) return "mixed";
  if (msUnit) return worksText && !msText ? "mixed" : "makesafe";
  if (worksUnit) return msText && worksText ? "mixed" : msText ? "makesafe" : "works";
  if (msText && !worksText) return "makesafe";
  if (worksText && !msText) return "works";
  return "unknown";
}

/** A job's trade: its type, else its number's prefix. */
export function jobTrade(job: Pick<BuilderRefJob, "type" | "job_number">): JobTrade {
  const type = String(job.type ?? "").toLowerCase();
  if (type === "makesafe") return "makesafe";
  if (["repair", "fencing", "patio", "decking"].includes(type)) return "works";
  if (type === "insurance") return "any";
  const prefix = String(job.job_number ?? "").toUpperCase().match(/^[A-Z]+/)?.[0] ?? "";
  if (prefix === "SWMS" || prefix === "SWREST") return "makesafe";
  if (["SWR", "SWF", "SWP", "SWB", "SWD"].includes(prefix)) return "works";
  return "other";
}

// One parse per row: the sync decides every invoice in the pass against one batch.
const IDENTITY = new WeakMap<object, { claims: Set<string>; pos: Set<string> }>();

/** The claims and POs a job's own builder fields carry. */
export function jobIdentity(job: Pick<BuilderRefJob, "refs">): { claims: Set<string>; pos: Set<string> } {
  const cached = IDENTITY.get(job);
  if (cached) return cached;
  const claims = new Set<string>();
  const pos = new Set<string>();
  for (const field of CLAIM_FIELDS) {
    const k = parseBuilderKeys(job.refs?.[field]);
    k.claims.forEach((c) => claims.add(c));
    k.pos.forEach((p) => pos.add(p));
  }
  for (const field of PO_FIELDS) {
    const k = parseBuilderKeys(job.refs?.[field]);
    [...k.claims, ...k.pos].forEach((p) => pos.add(p));
  }
  const identity = { claims, pos };
  IDENTITY.set(job, identity);
  return identity;
}

/** Dated on or after BUILDER_REFERENCE_FROM; an undated invoice is not acted on. */
export function inMeasuredPeriod(invoice: Pick<BuilderRefInvoice, "invoice_date">): boolean {
  const d = String(invoice.invoice_date ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= BUILDER_REFERENCE_FROM;
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(String(v ?? "").trim());
  return v === null || v === undefined || String(v).trim() === "" || !Number.isFinite(n) ? null : n;
}

/** Finished, and its other customer invoices already cover its value (inc GST). */
export function invoicedInFull(job: BuilderRefJob, invoiceId: string): boolean {
  if (!FINISHED_STATUSES.has(String(job.status ?? ""))) return false;
  const quoted = num(job.quoted_value);
  const workOrder = num(job.work_order_value_ex_gst);
  const value = quoted && quoted > 0 ? quoted : workOrder && workOrder > 0 ? Math.round(workOrder * 110) / 100 : null;
  if (!value) return false;
  const invoiced = (job.invoices ?? [])
    .filter((x) => x.id !== invoiceId && ["AUTHORISED", "PAID"].includes(String(x.status ?? "").toUpperCase()))
    .reduce((sum, x) => sum + (num(x.total) ?? 0), 0);
  return invoiced >= value - 0.01;
}

function sameName(a: string | null, b: string | null): boolean {
  const n = (s: string | null) => String(s ?? "").toLowerCase().replace(/[^a-z]/g, "");
  return n(a) !== "" && n(a) === n(b);
}

function droppedReason(job: BuilderRefJob, trade: InvoiceTrade, invoiceId: string): string | null {
  if (job.legacy) return "old_system_record";
  if (DEAD_STATUSES.has(String(job.status ?? ""))) return `status_${job.status}`;
  if (job.do_not_schedule) return "holding_job";
  const jt = jobTrade(job);
  if (trade === "mixed" || trade === "unknown") return `invoice_trade_${trade}`;
  if (jt !== trade && jt !== "any") return `trade_${jt}`;
  if (invoicedInFull(job, invoiceId)) return "finished_and_invoiced_in_full";
  return null;
}

/**
 * Decide one invoice against the candidate rows (any superset: the batch read
 * for several invoices gives the same answer as a read for this one).
 */
export function decideBuilderReference(invoice: BuilderRefInvoice, rows: readonly BuilderRefJob[]): BuilderRefDecision {
  if (invoice.invoice_type && String(invoice.invoice_type).toUpperCase() !== "ACCREC") {
    return { outcome: "not_applicable", reason: "not_customer_invoice" };
  }
  if (!inMeasuredPeriod(invoice)) return { outcome: "not_applicable", reason: "before_measured_period" };
  if (REFERENCE_JOB_NUMBER.test(String(invoice.reference ?? ""))) {
    return { outcome: "not_applicable", reason: "job_number_in_reference" };
  }
  const keys = builderReferenceKeys(invoice);
  const all = new Set([...keys.claims, ...keys.pos]);
  if (all.size === 0) return { outcome: "not_applicable", reason: "no_builder_reference" };
  const trade = invoiceTrade(invoice);

  const candidates = new Map<string, { job: BuilderRefJob; c: BuilderRefCandidate }>();
  const identity = new Map<string, { claims: Set<string>; pos: Set<string> }>();
  for (const job of rows) identity.set(job.id, jobIdentity(job));
  for (const job of rows) {
    const id = identity.get(job.id)!;
    const matched = [...all].filter((k) => id.claims.has(k) || id.pos.has(k));
    if (matched.length === 0) continue;
    candidates.set(job.id, {
      job,
      c: { job_id: job.id, job_number: job.job_number, found: "reference", matched, site_of: [], trade: jobTrade(job), status: job.status, kept: false, dropped: null },
    });
  }
  const direct = [...candidates.values()].map((x) => x.job);
  for (const anchor of direct) {
    if (!anchor.site_key) continue;
    for (const job of rows) {
      if (candidates.has(job.id) && candidates.get(job.id)!.c.found === "reference") continue;
      if (job.site_key !== anchor.site_key) continue;
      const status = String(job.status ?? "");
      if (DEAD_STATUSES.has(status) || FINISHED_STATUSES.has(status)) continue;
      const id = identity.get(job.id)!;
      if (id.claims.size + id.pos.size > 0) continue; // another instruction's reference
      const sameCustomer = sameName(job.client_name, anchor.client_name) ||
        (!!job.ghl_contact_id && job.ghl_contact_id === anchor.ghl_contact_id);
      const sameBuilder = !!job.builder && job.builder === anchor.builder;
      if (!sameCustomer && !sameBuilder) continue;
      const seen = candidates.get(job.id);
      if (seen) {
        if (anchor.job_number && !seen.c.site_of.includes(anchor.job_number)) seen.c.site_of.push(anchor.job_number);
        continue;
      }
      candidates.set(job.id, {
        job,
        c: { job_id: job.id, job_number: job.job_number, found: "site", matched: [], site_of: anchor.job_number ? [anchor.job_number] : [], trade: jobTrade(job), status: job.status, kept: false, dropped: null },
      });
    }
  }

  const evidence: BuilderRefEvidence = { rule: BUILDER_REFERENCE_RULE, keys, invoice_trade: trade, candidates: [] };
  if (candidates.size === 0) return { outcome: "no_candidate", evidence };

  let kept: BuilderRefJob[] = [];
  for (const { job, c } of candidates.values()) {
    c.dropped = droppedReason(job, trade, invoice.id);
    c.kept = c.dropped === null;
    if (c.kept) kept.push(job);
    evidence.candidates.push(c);
  }
  evidence.candidates.sort((a, b) => Number(b.kept) - Number(a.kept) || String(a.job_number).localeCompare(String(b.job_number)));

  if (trade === "mixed" || trade === "unknown") return { outcome: "person", reason: "trade_unclear", evidence };
  if (kept.length === 0) return { outcome: "person", reason: "no_job_of_this_trade", evidence };

  if (keys.pos.length === 0) {
    const liveTrades = new Set(
      direct.filter((j) => !j.legacy && !DEAD_STATUSES.has(String(j.status ?? ""))).map((j) => jobTrade(j)),
    );
    if (liveTrades.has("makesafe") && (liveTrades.has("works") || liveTrades.has("any"))) {
      return { outcome: "person", reason: "claim_only_cross_trade", evidence };
    }
  }

  let step: "unique" | "po_instruction" = "unique";
  if (kept.length > 1 && keys.pos.length > 0) {
    const byPo = kept.filter((j) => keys.pos.some((p) => identity.get(j.id)!.pos.has(p)));
    if (byPo.length === 1) {
      kept = byPo;
      step = "po_instruction";
    }
  }
  if (kept.length !== 1) return { outcome: "person", reason: "several_jobs", evidence };
  evidence.step = step;
  return { outcome: "link", job_id: kept[0].id, job_number: kept[0].job_number, evidence };
}

const TRADE_WORDS: Record<JobTrade, string> = { makesafe: "make-safe", works: "works", any: "insurance", other: "other" };
const DROP_WORDS: Record<string, string> = {
  old_system_record: "old-system record",
  holding_job: "holding job",
  finished_and_invoiced_in_full: "finished, invoiced in full",
  invoice_trade_mixed: "invoice reads as both make-safe and works",
  invoice_trade_unknown: "invoice trade not clear",
};
const REASON_WORDS: Record<string, string> = {
  several_jobs: "more than one job fits",
  no_job_of_this_trade: "no job of the invoice's trade carries it",
  trade_unclear: "the invoice does not read clearly as make-safe or works",
  claim_only_cross_trade: "the reference has the claim but no PO, and the claim is on a make-safe card and a works job",
};

/** The unlinked_invoice annotation a person resolves (same shape and source_ref as Strategy 3). */
export function builderReferenceAnnotation(
  invoice: BuilderRefInvoice & { total?: number | string | null },
  decision: Extract<BuilderRefDecision, { outcome: "person" }>,
  orgId: string,
) {
  const ev = decision.evidence;
  const ref = String(invoice.reference ?? "").trim() || ev.keys.claims.concat(ev.keys.pos).join(", ");
  const list = ev.candidates.map((c) => {
    const why = c.kept ? "" : `, not this one: ${DROP_WORDS[c.dropped ?? ""] ?? String(c.dropped ?? "").replace(/^status_/, "").replace(/^trade_/, "trade ").replace(/_/g, " ")}`;
    const where = c.found === "site" ? `, same site as ${c.site_of.join(", ")}` : "";
    return `${c.job_number ?? c.job_id} (${TRADE_WORDS[c.trade]}, ${c.status ?? "no status"}${where}${why})`;
  });
  const options = [...ev.candidates.filter((c) => c.kept), ...ev.candidates.filter((c) => !c.kept)].slice(0, 4);
  return {
    org_id: orgId,
    entity_type: "invoice",
    entity_id: null,
    ui_location: "today",
    annotation_type: "unlinked_invoice",
    category: "financial",
    title: `${invoice.invoice_number} ($${Math.round(num(invoice.total) ?? 0).toLocaleString()}) builder reference ${ref}: ${ev.candidates.length} possible job${ev.candidates.length === 1 ? "" : "s"}`,
    body: `"${ref}" is on: ${list.join("; ")}. Not linked by itself: ${REASON_WORDS[decision.reason]}. Link manually.`,
    structured_data: {
      xero_invoice_id: invoice.xero_invoice_id,
      invoice_number: invoice.invoice_number,
      rule: ev.rule,
      reason: decision.reason,
      keys: ev.keys,
      invoice_trade: ev.invoice_trade,
      candidate_jobs: ev.candidates.map((c) => ({ id: c.job_id, job_number: c.job_number, found: c.found, matched: c.matched, site_of: c.site_of, trade: c.trade, status: c.status, kept: c.kept, dropped: c.dropped })),
    },
    response_type: "choice",
    response_options: options
      .map((c) => ({ value: "link:" + c.job_id, label: "Link to " + (c.job_number ?? c.job_id), style: "primary" }))
      .concat([{ value: "dismiss", label: "Not Related", style: "ghost" }]),
    priority: 70,
    severity: "amber",
    source: "xero-sync",
    source_ref: `sync:unlinked:${invoice.xero_invoice_id}`,
    confidence: 0.5,
  };
}

/**
 * One read for every invoice in the pass. A failed or malformed read returns
 * ready = false and the caller links nothing by this rule.
 */
// deno-lint-ignore no-explicit-any
export async function loadBuilderReferenceCandidates(client: any, invoices: readonly BuilderRefInvoice[]): Promise<{ ready: boolean; rows: BuilderRefJob[]; error?: string }> {
  const keys = new Set<string>();
  for (const inv of invoices) {
    if (inv.invoice_type && String(inv.invoice_type).toUpperCase() !== "ACCREC") continue;
    if (!inMeasuredPeriod(inv) || REFERENCE_JOB_NUMBER.test(String(inv.reference ?? ""))) continue;
    const k = builderReferenceKeys(inv);
    [...k.claims, ...k.pos].forEach((x) => keys.add(x));
  }
  if (keys.size === 0) return { ready: true, rows: [] };
  try {
    const { data, error } = await client.rpc("xero_builder_reference_candidates", { p_keys: [...keys].sort() });
    if (error) return { ready: false, rows: [], error: String(error.message ?? error) };
    if (!Array.isArray(data)) return { ready: false, rows: [], error: "candidate read did not return a list" };
    return { ready: true, rows: data as BuilderRefJob[] };
  } catch (e) {
    return { ready: false, rows: [], error: (e as Error).message };
  }
}
