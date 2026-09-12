// deno-lint-ignore-file no-explicit-any
//
// Invoice context door (CIO, 2026-09-11, debt dashboard directive).
//
// One read: invoice in, everything the system already holds out. Job link,
// job facts (Luna), stored conversation (five-source merge), Xero cache state,
// chase log, and an explicit owned blocker for every missing piece. SELECT-only.
// Never calls Xero or GHL, never writes, never classifies.
//
// Published shape: wiki lanes/handoffs/CIO-to-DEBT-invoice-context-door.md.
//
// A second read, debt_context_coverage, returns the coverage flags for every
// open receivable in one call so the screen and the coverage table do not need
// one door call per invoice.

import { currentDispatchWorkingState } from "./dispatch_context.ts";

export const INVOICE_CONTEXT_VERSION = "invoice-context/v1";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JOB_NUMBER = /\b(SW[A-Z]{1,3}-\d{4,8})\b/i;
const OPEN_STATUSES = ["AUTHORISED", "SUBMITTED"];
const XERO_STALE_HOURS = 24;
const IN_CHUNK = 100;
// PostgREST caps any response at 1000 rows, so .limit(n > 1000) truncates in
// silence. Every multi-row read here pages with .range() instead.
const PAGE_SIZE = 1000;
const MAX_PAGES = 20;
// An invoice number we are willing to match on. No spaces, no wildcards, and
// short enough that the escaped form cannot be used to build a pattern.
const INVOICE_NUMBER = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,63}$/;

const MODE_BOUNDS = {
  card: { conversation: 20, facts: 24 },
  full: { conversation: 100, facts: 60 },
} as const;
type Mode = keyof typeof MODE_BOUNDS;

// Message-shaped business events. Same list as getJobConversation so the
// coverage count and the door's conversation agree on what "a message" is.
const MESSAGE_EVENT_TYPES = [
  "client.reply", "client.email_in", "client.email_out",
  "client.sms_in", "client.sms_out",
  "client.call_complete", "client.message_in",
  "supplier.email_in", "ghl.note_added",
];

export class InvoiceContextError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "invalid_request") {
    super(message);
    this.name = "InvoiceContextError";
  }
}

export interface InvoiceContextDeps {
  client: any;
  orgId: string;
  /** The existing five-source conversation merge (index.ts getJobConversation). Returns newest first. */
  getJobConversation: (client: any, body: { job_id: string; limit: number }) => Promise<{ messages: any[] }>;
  /** context_visibility.isCurrentContextFact */
  isCurrentContextFact: (row: Record<string, unknown>, now?: number) => boolean;
  now?: () => Date;
}

export interface Blocker { code: string; owner: string; detail: string }
export interface SourceStatus { ok: boolean; count?: number; error?: string }

// ── small helpers ────────────────────────────────────────────────────────────

function chunk<T>(items: T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function str(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s ? s : null;
}

function daysBetween(fromIso: string | null, to: Date): number | null {
  if (!fromIso) return null;
  const from = Date.parse(fromIso.length === 10 ? `${fromIso}T00:00:00Z` : fromIso);
  if (!Number.isFinite(from)) return null;
  return Math.floor((to.getTime() - from) / 86_400_000);
}

/** Xero returns dates either as ISO strings or as "/Date(1694390400000+0000)/". */
export function parseXeroDate(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const m = value.match(/\/Date\((-?\d+)(?:[+-]\d{4})?\)\//);
  if (m) {
    const ms = Number(m[1]);
    return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null;
  }
  // A calendar date with or without a time part is taken as written, never
  // shifted through the runtime's zone.
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}

export function jobNumberFromReference(...values: Array<unknown>): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const m = value.match(JOB_NUMBER);
    if (m) return m[1].toUpperCase();
  }
  return null;
}

async function safeRead<T>(label: string, fn: () => Promise<T>): Promise<{ data: T | null; status: SourceStatus }> {
  try {
    const data = await fn();
    const count = Array.isArray(data) ? data.length : data ? 1 : 0;
    return { data, status: { ok: true, count } };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.log(`[invoice_context] ${label} read failed:`, error);
    return { data: null, status: { ok: false, count: 0, error } };
  }
}

function unwrap(result: { data: any; error: any }): any {
  if (result?.error) throw new Error(result.error.message || String(result.error));
  return result?.data;
}

/**
 * Cap-safe read. PostgREST returns at most 1000 rows per response, so a
 * `.limit(5000)` silently drops everything past the first thousand. This pages
 * with `.range()` until a short page comes back, ordered by a stable key so a
 * page boundary cannot skip a row. The page ceiling is a warning naming the
 * table, never a silent truncation.
 *
 * `build` must return a fresh query builder on every call (filters and select
 * re-applied); the reader owns the order and range.
 */
async function pageThrough(
  table: string,
  build: () => any,
  warnings: string[],
  orderColumn = "id",
): Promise<any[]> {
  const rows: any[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const from = page * PAGE_SIZE;
    const data = unwrap(await build().order(orderColumn, { ascending: true }).range(from, from + PAGE_SIZE - 1)) || [];
    rows.push(...data);
    if (data.length < PAGE_SIZE) return rows;
  }
  warnings.push(`${table}: page ceiling ${MAX_PAGES * PAGE_SIZE} rows reached; not every row was read`);
  return rows;
}

/** Escapes the PostgREST LIKE metacharacters so an ilike match is literal. */
export function escapeLikeLiteral(value: string): string {
  return value.replace(/([\\%_])/g, "\\$1");
}

// ── job link resolution ─────────────────────────────────────────────────────

export interface JobLink {
  status: "linked" | "ambiguous" | "none";
  method: "invoice.job_id" | "invoice.job_number" | "reference_job_number" | "contact_single_job" | null;
  job_id: string | null;
  job_number: string | null;
  /** Only populated when status is "ambiguous". */
  candidates: Array<{ job_id: string; job_number: string | null; status: string | null; why: string }>;
  /** Why the link failed, for the no_job_linked blocker detail. Not part of the wire shape. */
  hint?: string | null;
}

const JOB_LINK_COLS = "id, job_number, status, ghl_contact_id";

/**
 * Resolves the job for a batch of invoices with four bounded reads instead of
 * one per invoice. Order: stored job_id, stored job_number, a job number in the
 * reference or invoice number, then the Xero contact's jobs via contact_matches
 * (one job = linked, several = ambiguous with candidates).
 */
export async function resolveJobLinks(client: any, invoices: any[]): Promise<Map<string, JobLink>> {
  const links = new Map<string, JobLink>();
  const none = (): JobLink => ({ status: "none", method: null, job_id: null, job_number: null, candidates: [], hint: null });

  const wantIds = new Set<string>();
  const wantNumbers = new Set<string>();
  const wantContacts = new Set<string>();
  for (const inv of invoices) {
    if (inv.job_id) wantIds.add(inv.job_id);
    else {
      const n = str(inv.job_number)?.toUpperCase() || jobNumberFromReference(inv.reference, inv.invoice_number);
      if (n) wantNumbers.add(n);
      else if (inv.xero_contact_id) wantContacts.add(inv.xero_contact_id);
    }
  }

  const jobsById = new Map<string, any>();
  for (const ids of chunk([...wantIds])) {
    const rows = unwrap(await client.from("jobs").select(JOB_LINK_COLS).in("id", ids));
    for (const j of rows || []) jobsById.set(j.id, j);
  }
  const jobsByNumber = new Map<string, any>();
  for (const numbers of chunk([...wantNumbers])) {
    const rows = unwrap(await client.from("jobs").select(JOB_LINK_COLS).in("job_number", numbers));
    for (const j of rows || []) jobsByNumber.set(String(j.job_number).toUpperCase(), j);
  }

  // Contact route: contact_matches gives job ids and GHL contact ids for a Xero contact.
  const contactJobIds = new Map<string, Set<string>>();
  const contactGhlIds = new Map<string, Set<string>>();
  for (const ids of chunk([...wantContacts])) {
    const rows = unwrap(await client.from("contact_matches")
      .select("xero_contact_id, ghl_contact_id, job_id").in("xero_contact_id", ids));
    for (const m of rows || []) {
      if (!m.xero_contact_id) continue;
      if (m.job_id) (contactJobIds.get(m.xero_contact_id) ?? contactJobIds.set(m.xero_contact_id, new Set()).get(m.xero_contact_id)!).add(m.job_id);
      if (m.ghl_contact_id) (contactGhlIds.get(m.xero_contact_id) ?? contactGhlIds.set(m.xero_contact_id, new Set()).get(m.xero_contact_id)!).add(m.ghl_contact_id);
    }
  }
  const allContactJobIds = new Set<string>();
  const allGhlIds = new Set<string>();
  for (const s of contactJobIds.values()) for (const id of s) allContactJobIds.add(id);
  for (const s of contactGhlIds.values()) for (const id of s) allGhlIds.add(id);
  const contactJobs = new Map<string, any>();
  for (const ids of chunk([...allContactJobIds])) {
    const rows = unwrap(await client.from("jobs").select(JOB_LINK_COLS).in("id", ids));
    for (const j of rows || []) contactJobs.set(j.id, j);
  }
  const jobsByGhl = new Map<string, any[]>();
  for (const ids of chunk([...allGhlIds])) {
    const rows = unwrap(await client.from("jobs").select(JOB_LINK_COLS).in("ghl_contact_id", ids));
    for (const j of rows || []) {
      const list = jobsByGhl.get(j.ghl_contact_id) ?? [];
      list.push(j);
      jobsByGhl.set(j.ghl_contact_id, list);
      contactJobs.set(j.id, j);
    }
  }

  for (const inv of invoices) {
    const key = inv.xero_invoice_id;
    if (inv.job_id) {
      const j = jobsById.get(inv.job_id);
      links.set(key, j
        ? { status: "linked", method: "invoice.job_id", job_id: j.id, job_number: j.job_number ?? null, candidates: [] }
        : { ...none(), hint: `the invoice's job_id ${inv.job_id} points at a job that does not exist` });
      continue;
    }
    const stored = str(inv.job_number)?.toUpperCase();
    const fromRef = stored ? null : jobNumberFromReference(inv.reference, inv.invoice_number);
    const n = stored || fromRef;
    if (n) {
      const j = jobsByNumber.get(n);
      if (j) {
        links.set(key, { status: "linked", method: stored ? "invoice.job_number" : "reference_job_number", job_id: j.id, job_number: j.job_number ?? null, candidates: [] });
        continue;
      }
      links.set(key, { ...none(), hint: `job number ${n} in the invoice does not match any job` });
      continue;
    }
    if (inv.xero_contact_id) {
      const found = new Map<string, any>();
      for (const id of contactJobIds.get(inv.xero_contact_id) ?? []) { const j = contactJobs.get(id); if (j) found.set(j.id, j); }
      for (const g of contactGhlIds.get(inv.xero_contact_id) ?? []) for (const j of jobsByGhl.get(g) ?? []) found.set(j.id, j);
      if (found.size === 1) {
        const j = [...found.values()][0];
        links.set(key, { status: "linked", method: "contact_single_job", job_id: j.id, job_number: j.job_number ?? null, candidates: [] });
        continue;
      }
      if (found.size > 1) {
        links.set(key, {
          status: "ambiguous", method: null, job_id: null, job_number: null,
          candidates: [...found.values()].map((j) => ({ job_id: j.id, job_number: j.job_number ?? null, status: j.status ?? null, why: "same Xero contact" })),
        });
        continue;
      }
    }
    links.set(key, none());
  }
  return links;
}

// ── facts, queue, conversation counts (batched, for coverage) ───────────────

async function factsCountByJob(deps: InvoiceContextDeps, jobIds: string[], warnings: string[]): Promise<{ counts: Map<string, number>; status: SourceStatus }> {
  const counts = new Map<string, number>();
  const now = (deps.now ?? (() => new Date()))().getTime();
  const read = await safeRead("current_job_context_facts", async () => {
    const rows: any[] = [];
    for (const ids of chunk(jobIds)) {
      rows.push(...await pageThrough("current_job_context_facts", () => deps.client.from("current_job_context_facts")
        .select("id, job_id, kind, provenance, expires_at, _context_store").in("job_id", ids), warnings));
    }
    return rows;
  });
  for (const row of read.data || []) {
    if (!deps.isCurrentContextFact(row, now)) continue;
    counts.set(row.job_id, (counts.get(row.job_id) ?? 0) + 1);
  }
  return { counts, status: read.status };
}

export interface QueueSummary { pending: number; processing: number; done: number; skipped: number; failed: number; dead_letter: number; skip_reasons: string[]; errors: string[] }

async function queueByJob(client: any, jobIds: string[], warnings: string[]): Promise<{ queues: Map<string, QueueSummary>; status: SourceStatus }> {
  const queues = new Map<string, QueueSummary>();
  const read = await safeRead("extraction_jobs", async () => {
    const rows: any[] = [];
    for (const ids of chunk(jobIds)) {
      rows.push(...await pageThrough("extraction_jobs", () => client.from("extraction_jobs")
        .select("id, job_id, status, skip_reason, error").in("job_id", ids), warnings));
    }
    return rows;
  });
  for (const row of read.data || []) {
    const q = queues.get(row.job_id) ?? { pending: 0, processing: 0, done: 0, skipped: 0, failed: 0, dead_letter: 0, skip_reasons: [], errors: [] };
    if (row.status in q) (q as any)[row.status] += 1;
    if (row.skip_reason && !q.skip_reasons.includes(row.skip_reason) && q.skip_reasons.length < 5) q.skip_reasons.push(row.skip_reason);
    if (row.status === "dead_letter" && row.error && !q.errors.includes(row.error) && q.errors.length < 3) q.errors.push(String(row.error).slice(0, 120));
    queues.set(row.job_id, q);
  }
  return { queues, status: read.status };
}

export function queueDetail(q: QueueSummary | undefined, queueReadOk = true): string {
  // A failed queue read is not evidence of an empty queue. Saying
  // "never_enqueued" there would assert something we did not read.
  if (!queueReadOk) return "unknown (queue unreadable)";
  if (!q) return "never_enqueued";
  const parts: string[] = [];
  if (q.pending) parts.push(`pending:${q.pending}`);
  if (q.processing) parts.push(`processing:${q.processing}`);
  if (q.done) parts.push(`done:${q.done}`);
  if (q.skipped) parts.push(`skipped:${q.skipped}${q.skip_reasons.length ? ` (${q.skip_reasons.join(", ")})` : ""}`);
  if (q.failed) parts.push(`failed:${q.failed}`);
  if (q.dead_letter) parts.push(`dead_letter:${q.dead_letter}${q.errors.length ? ` (${q.errors.join("; ")})` : ""}`);
  return parts.join(", ") || "never_enqueued";
}

interface ConversationCounts { ghl_cache: number; inbox: number; job_events: number; business_events: number; last_client_message_at: string | null }

async function conversationCountsByJob(client: any, jobs: Array<{ id: string; ghl_contact_id: string | null }>, warnings: string[]): Promise<{ counts: Map<string, ConversationCounts>; status: SourceStatus }> {
  const counts = new Map<string, ConversationCounts>();
  const get = (id: string) => counts.get(id) ?? counts.set(id, { ghl_cache: 0, inbox: 0, job_events: 0, business_events: 0, last_client_message_at: null }).get(id)!;
  const jobIds = jobs.map((j) => j.id);
  const errors: string[] = [];
  const ghlToJob = new Map<string, string>();
  for (const j of jobs) if (j.ghl_contact_id) ghlToJob.set(j.ghl_contact_id, j.id);

  // GHL cache: one row per contact or job. The `messages` jsonb is NOT selected
  // here. Pulling it would drag the whole conversation body of every job in the
  // population through one coverage call. The count comes from message_count;
  // the GHL last-message timestamp lives only in the door, which reads the
  // merged conversation for the one job. Coverage derives
  // last_client_message_at from inbox_events and inbound business_events only.
  const GHL_COLS = "contact_id, job_id, message_count, synced_at";
  try {
    const seen = new Set<string>();
    const apply = (row: any, jobId: string) => {
      if (!jobId || seen.has(`${jobId}:${row.contact_id ?? ""}:${row.job_id ?? ""}`)) return;
      seen.add(`${jobId}:${row.contact_id ?? ""}:${row.job_id ?? ""}`);
      get(jobId).ghl_cache += num(row.message_count) ?? 0;
    };
    for (const ids of chunk([...ghlToJob.keys()])) {
      const data = unwrap(await client.from("ghl_conversation_cache").select(GHL_COLS).in("contact_id", ids));
      for (const row of data || []) apply(row, ghlToJob.get(row.contact_id) ?? row.job_id);
    }
    for (const ids of chunk(jobIds)) {
      const data = unwrap(await client.from("ghl_conversation_cache").select(GHL_COLS).in("job_id", ids));
      for (const row of data || []) apply(row, row.job_id);
    }
  } catch (e) { errors.push(`ghl_cache: ${e instanceof Error ? e.message : String(e)}`); }

  try {
    for (const ids of chunk(jobIds)) {
      const rows = await pageThrough("inbox_events", () => client.from("inbox_events").select("id, job_id, received_at").in("job_id", ids), warnings);
      for (const row of rows) {
        const c = get(row.job_id); c.inbox += 1;
        if (row.received_at && (!c.last_client_message_at || row.received_at > c.last_client_message_at)) c.last_client_message_at = row.received_at;
      }
    }
  } catch (e) { errors.push(`inbox: ${e instanceof Error ? e.message : String(e)}`); }

  try {
    for (const ids of chunk(jobIds)) {
      const rows = await pageThrough("job_events", () => client.from("job_events").select("id, job_id").eq("event_type", "note").in("job_id", ids), warnings);
      for (const row of rows) get(row.job_id).job_events += 1;
    }
  } catch (e) { errors.push(`job_events: ${e instanceof Error ? e.message : String(e)}`); }

  try {
    for (const ids of chunk(jobIds)) {
      const rows = await pageThrough("business_events", () => client.from("business_events").select("id, job_id, event_type, occurred_at").in("event_type", MESSAGE_EVENT_TYPES).in("job_id", ids), warnings);
      for (const row of rows) {
        const c = get(row.job_id); c.business_events += 1;
        const inbound = String(row.event_type).endsWith("_in") || row.event_type === "client.reply";
        if (inbound && row.occurred_at && (!c.last_client_message_at || row.occurred_at > c.last_client_message_at)) c.last_client_message_at = row.occurred_at;
      }
    }
  } catch (e) { errors.push(`business_events: ${e instanceof Error ? e.message : String(e)}`); }

  return { counts, status: errors.length ? { ok: false, count: counts.size, error: errors.join("; ") } : { ok: true, count: counts.size } };
}

// ── the door ────────────────────────────────────────────────────────────────

const INVOICE_COLS = "id, xero_invoice_id, xero_contact_id, contact_name, invoice_number, reference, invoice_type, status, total, amount_due, amount_paid, invoice_date, due_date, fully_paid_on, line_items, raw_json, job_id, job_number, synced_at, debt_classification, debt_classification_reason, debt_classified_by, debt_classified_at";

function invoiceView(inv: any, now: Date) {
  const syncedAt = str(inv.synced_at);
  const ageMinutes = syncedAt ? Math.max(0, Math.round((now.getTime() - Date.parse(syncedAt)) / 60_000)) : null;
  const dueDays = daysBetween(str(inv.due_date), now);
  const lineItems = Array.isArray(inv.line_items) ? inv.line_items : [];
  return {
    xero_invoice_id: inv.xero_invoice_id,
    invoice_number: inv.invoice_number ?? null,
    reference: inv.reference ?? null,
    invoice_type: inv.invoice_type ?? null,
    status: inv.status ?? null,
    total: num(inv.total), amount_due: num(inv.amount_due), amount_paid: num(inv.amount_paid),
    invoice_date: inv.invoice_date ?? null, due_date: inv.due_date ?? null,
    days_overdue: dueDays === null ? null : Math.max(0, dueDays),
    contact: { xero_contact_id: inv.xero_contact_id ?? null, name: inv.contact_name ?? null },
    line_items: lineItems.slice(0, 50).map((li: any) => ({
      description: li?.Description ?? li?.description ?? null,
      quantity: num(li?.Quantity ?? li?.quantity), unit_amount: num(li?.UnitAmount ?? li?.unit_amount), line_amount: num(li?.LineAmount ?? li?.line_amount),
    })),
    xero_synced_at: syncedAt, xero_cache_age_minutes: ageMinutes,
    classification: {
      class: inv.debt_classification ?? null, reason: inv.debt_classification_reason ?? null,
      by: inv.debt_classified_by ?? null, at: inv.debt_classified_at ?? null,
    },
  };
}

function xeroPayments(raw: any): Array<{ date: string | null; amount: number | null; reference: string | null }> {
  const list = Array.isArray(raw?.Payments) ? raw.Payments : [];
  return list.map((p: any) => ({ date: parseXeroDate(p?.Date), amount: num(p?.Amount), reference: str(p?.Reference) }));
}

function quoteTotal(pricing: any): number | null {
  if (!pricing || typeof pricing !== "object") return null;
  return num(pricing.totalIncGST) ?? num(pricing.total) ?? num(pricing.grandTotal) ?? num(pricing.amount);
}

export async function invoiceContext(params: URLSearchParams, deps: InvoiceContextDeps) {
  const now = (deps.now ?? (() => new Date()))();
  const client = deps.client;
  const invoiceNo = str(params.get("invoice"));
  const xeroId = str(params.get("xero_invoice_id"));
  if (!invoiceNo && !xeroId) throw new InvoiceContextError("invoice or xero_invoice_id is required");
  if (xeroId && !UUID.test(xeroId)) throw new InvoiceContextError("xero_invoice_id must be a UUID");
  if (invoiceNo) {
    // % and _ are LIKE metacharacters. Rejecting them by name beats a generic
    // "invalid" so a caller with a genuinely odd invoice number knows why.
    if (/[%_]/.test(invoiceNo)) throw new InvoiceContextError("invoice must not contain the wildcard characters % or _");
    if (!INVOICE_NUMBER.test(invoiceNo)) throw new InvoiceContextError("invoice is not a valid invoice number");
  }
  const modeRaw = str(params.get("mode")) ?? "card";
  if (!(modeRaw in MODE_BOUNDS)) throw new InvoiceContextError("mode must be card or full");
  const mode = modeRaw as Mode;
  const clamp = (raw: string | null, cap: number) => { const n = num(raw); return n && n > 0 ? Math.min(Math.floor(n), cap) : cap; };
  const conversationLimit = clamp(params.get("conversation_limit"), MODE_BOUNDS[mode].conversation);
  const factsLimit = clamp(params.get("facts_limit"), MODE_BOUNDS[mode].facts);

  // 1. Invoice row. An invoice number can appear once per org in practice, but
  //    read two rows so a duplicate is refused rather than silently picked.
  let q = client.from("xero_invoices").select(INVOICE_COLS).eq("org_id", deps.orgId).eq("invoice_type", "ACCREC");
  // xero-sync stores InvoiceNumber exactly as Xero returns it (no case
  // normalisation, see xero-sync/index.ts:633), so an .eq on an uppercased
  // value would miss. ilike on the escaped literal is an exact,
  // case-insensitive match with no pattern left in it.
  q = xeroId ? q.eq("xero_invoice_id", xeroId) : q.ilike("invoice_number", escapeLikeLiteral(invoiceNo!));
  const invRows = unwrap(await q.limit(2));
  if (!invRows || invRows.length === 0) throw new InvoiceContextError(`invoice not found: ${xeroId ?? invoiceNo}`, 404, "invoice_not_found");
  if (invRows.length > 1) throw new InvoiceContextError(`invoice number matches ${invRows.length} rows; pass xero_invoice_id`, 409, "invoice_ambiguous");
  const inv = invRows[0];

  const sources: Record<string, SourceStatus> = { invoice: { ok: true, count: 1 } };
  const blockers: Blocker[] = [];
  const warnings: string[] = [];

  // 2. Link.
  const linkRead = await safeRead("job_link", () => resolveJobLinks(client, [inv]));
  const link: JobLink = linkRead.data?.get(inv.xero_invoice_id) ?? { status: "none", method: null, job_id: null, job_number: null, candidates: [] };
  sources.job_link = linkRead.status;

  // 3. Job and everything hanging off it.
  let job: any = null;
  let facts: any[] = [];
  let dispatchWorkingState: ReturnType<typeof currentDispatchWorkingState> = { present: false };
  let conversation: any[] = [];
  let queue: QueueSummary | undefined;
  let queueOk = true;
  let otherOpen: any[] = [];
  // Conversation presence is decided by the same batched counter the coverage
  // read uses, so the door and the coverage table can never disagree about
  // conversation_present. The mode-sliced merge below is for display only.
  let conversationPresenceOk = true;
  let clientMessageCount = 0;
  if (link.status === "linked" && link.job_id) {
    const jobRead = await safeRead("jobs", async () => unwrap(await client.from("jobs")
      .select("id, job_number, type, status, client_name, client_phone, client_email, site_address, site_suburb, ghl_contact_id, deposit_amount, deposit_at, pricing_json, quoted_at, accepted_at, scheduled_at, completed_at, created_at")
      .eq("id", link.job_id).maybeSingle()));
    sources.job = jobRead.status;
    const jobRow = jobRead.data;
    if (jobRow) {
      const [variations, workOrders, council, factsRead, convRead, queueRead, presenceRead, openRead, dispatchRead] = await Promise.all([
        safeRead("job_variations", async () => unwrap(await client.from("job_variations").select("variation_number, amount, status, sent_at").eq("job_id", jobRow.id).order("variation_number", { ascending: true }).limit(50))),
        safeRead("work_orders", async () => unwrap(await client.from("work_orders").select("wo_number, trade_name, status, scheduled_date, completed_at").eq("job_id", jobRow.id).order("created_at", { ascending: false }).limit(50))),
        safeRead("council_submissions", async () => unwrap(await client.from("council_submissions").select("template_type, overall_status").eq("job_id", jobRow.id).order("updated_at", { ascending: false }).limit(1))),
        safeRead("current_job_context_facts", async () => unwrap(await client.from("current_job_context_facts")
          .select("id, job_id, kind, value, provenance, expires_at, _context_store, updated_at").eq("job_id", jobRow.id).order("updated_at", { ascending: false }).limit(factsLimit * 2))),
        safeRead("conversation", async () => (await deps.getJobConversation(client, { job_id: jobRow.id, limit: conversationLimit })).messages || []),
        queueByJob(client, [jobRow.id], warnings),
        conversationCountsByJob(client, [{ id: jobRow.id, ghl_contact_id: jobRow.ghl_contact_id ?? null }], warnings),
        safeRead("other_open_invoices", async () => unwrap(await client.from("xero_invoices").select("invoice_number, xero_invoice_id, amount_due, due_date, status")
          .eq("org_id", deps.orgId).eq("invoice_type", "ACCREC").eq("job_id", jobRow.id).in("status", OPEN_STATUSES).gt("amount_due", 0).neq("xero_invoice_id", inv.xero_invoice_id).limit(20))),
        safeRead("dispatch_working_state", async () => unwrap(await client.from("business_events")
          .select("id, event_type, correlation_id, job_id, payload, metadata")
          .eq("job_id", jobRow.id).eq("event_type", "dispatch.plan.changed").order("id").limit(200))),
      ]);
      sources.promised = { ok: variations.status.ok && workOrders.status.ok && council.status.ok, error: [variations.status.error, workOrders.status.error, council.status.error].filter(Boolean).join("; ") || undefined };
      sources.facts = factsRead.status;
      sources.conversation = convRead.status;
      sources.extraction_queue = queueRead.status;
      sources.conversation_presence = presenceRead.status;
      sources.other_open_invoices = openRead.status;
      sources.dispatch_working_state = dispatchRead.status;
      facts = (factsRead.data || []).filter((row: any) => deps.isCurrentContextFact(row, now.getTime())).slice(0, factsLimit);
      dispatchWorkingState = currentDispatchWorkingState(dispatchRead.data || []);
      if (facts.length < (factsRead.data || []).length && (factsRead.data || []).length >= factsLimit * 2) warnings.push(`facts: read cap ${factsLimit * 2} reached; older facts not shown`);
      conversation = [...(convRead.data || [])].reverse();
      queue = queueRead.queues.get(jobRow.id);
      queueOk = queueRead.status.ok;
      conversationPresenceOk = presenceRead.status.ok;
      const presence = presenceRead.counts.get(jobRow.id);
      clientMessageCount = presence ? presence.ghl_cache + presence.inbox + presence.business_events : 0;
      otherOpen = openRead.data || [];
      job = {
        id: jobRow.id, job_number: jobRow.job_number ?? null, type: jobRow.type ?? null, status: jobRow.status ?? null,
        client_name: jobRow.client_name ?? null, client_phone: jobRow.client_phone ?? null, client_email: jobRow.client_email ?? null,
        site_address: jobRow.site_address ?? null, site_suburb: jobRow.site_suburb ?? null, ghl_contact_id: jobRow.ghl_contact_id ?? null,
        quoted_at: jobRow.quoted_at ?? null, accepted_at: jobRow.accepted_at ?? null, scheduled_at: jobRow.scheduled_at ?? null, completed_at: jobRow.completed_at ?? null,
        deposit_at: jobRow.deposit_at ?? null,
        promised: {
          quote_total: quoteTotal(jobRow.pricing_json), deposit_amount: num(jobRow.deposit_amount),
          variations: (variations.data || []).map((v: any) => ({ number: `VAR${v.variation_number ?? ""}`, amount: num(v.amount), status: v.status ?? null, sent_at: v.sent_at ?? null })),
          work_orders: (workOrders.data || []).map((w: any) => ({ wo_number: w.wo_number ?? null, trade: w.trade_name ?? null, status: w.status ?? null, scheduled_date: w.scheduled_date ?? null, completed_at: w.completed_at ?? null })),
          council: (council.data || [])[0] ? { template_type: council.data![0].template_type ?? null, overall_status: council.data![0].overall_status ?? null } : null,
        },
        other_open_invoices: otherOpen.map((o: any) => ({ invoice_number: o.invoice_number ?? null, xero_invoice_id: o.xero_invoice_id, amount_due: num(o.amount_due), due_date: o.due_date ?? null })),
      };
    } else if (jobRead.status.ok) {
      blockers.push({ code: "no_job_linked", owner: "BOOKKEEPING", detail: `Link points at job ${link.job_id} which no longer exists; link the invoice to the right job` });
    } else {
      // The link is good; we simply could not read the job. Never report that
      // as "no job linked".
      blockers.push({ code: "job_read_failed", owner: "CIO", detail: `Job ${link.job_id} could not be read (${jobRead.status.error ?? "unknown error"}); the job picture is unknown` });
    }
  }

  // 4. Chase log.
  const chaseRead = await safeRead("payment_chase_logs", async () => unwrap(await client.from("payment_chase_logs")
    .select("method, outcome, notes, follow_up_date, follow_up_resolved, chased_by, created_at").eq("xero_invoice_id", inv.xero_invoice_id).order("created_at", { ascending: false }).limit(50)));
  sources.chase = chaseRead.status;
  const chaseRows = chaseRead.data || [];
  const nextFollowUp = chaseRows.find((c: any) => c.follow_up_date && !c.follow_up_resolved)?.follow_up_date ?? null;

  // 5. Blockers and coverage flags. Every missing piece has an owner.
  const contactKnown = Boolean(inv.xero_contact_id);
  if (!contactKnown) blockers.push({ code: "no_contact", owner: "BOOKKEEPING", detail: "Invoice has no Xero contact" });
  if (link.status === "none" && !blockers.some((b) => b.code === "no_job_linked")) {
    blockers.push({
      code: "no_job_linked", owner: "BOOKKEEPING",
      detail: link.hint
        ? `${link.hint}; link it or name the job`
        : "No job on the invoice and no job number in the reference; link it or name the job",
    });
  }
  if (link.status === "ambiguous") {
    blockers.push({ code: "job_link_ambiguous", owner: "BOOKKEEPING", detail: `Contact has ${link.candidates.length} jobs; pick one (candidates listed)` });
  }
  if (job && !job.ghl_contact_id) blockers.push({ code: "no_ghl_contact", owner: "CIO", detail: "Job has no GHL contact, so SMS and call history cannot attach" });
  if (job && sources.facts?.ok === false) {
    blockers.push({ code: "facts_unreadable", owner: "CIO", detail: `The job_context read failed (${sources.facts.error ?? "unknown error"}); whether Luna has extracted this job is unknown` });
  } else if (job && facts.length === 0) {
    blockers.push({ code: "facts_missing", owner: "CIO", detail: `Luna has not extracted this job yet (queue status: ${queueDetail(queue, queueOk)})` });
  }
  const clientMessages = conversation.filter((m: any) => m.direction !== "internal");
  if (job && !conversationPresenceOk) {
    blockers.push({ code: "conversation_unreadable", owner: "CIO", detail: `The stored message counts could not be read (${sources.conversation_presence?.error ?? "unknown error"}); whether this job has client messages is unknown` });
  } else if (job && clientMessageCount === 0) {
    blockers.push({ code: "conversation_missing", owner: "CIO", detail: "No stored client messages for this job in any source" });
  }
  const cacheAgeMinutes = inv.synced_at ? (now.getTime() - Date.parse(inv.synced_at)) / 60_000 : null;
  const xeroFresh = cacheAgeMinutes !== null && cacheAgeMinutes <= XERO_STALE_HOURS * 60;
  if (!xeroFresh) blockers.push({ code: "xero_stale", owner: "CIO", detail: cacheAgeMinutes === null ? "Invoice row has no sync time" : `Cache older than ${XERO_STALE_HOURS} h; balance may be wrong` });
  for (const [label, s] of Object.entries(sources)) if (!s.ok) warnings.push(`${label}: read failed (${s.error ?? "unknown"})`);
  if (job && sources.facts?.ok && facts.length === 0) warnings.push("facts: 0 rows, extractor has not written for this job yet");

  const lastClient = [...clientMessages].reverse().find((m: any) => m.direction === "inbound") ?? null;
  const lastOutbound = [...clientMessages].reverse().find((m: any) => m.direction === "outbound") ?? null;
  const brief = (m: any) => m ? { at: m.occurred_at ?? null, channel: m.channel ?? null, preview: m.preview ?? String(m.body ?? "").slice(0, 500) } : null;
  // All five merge sources are always present, zero included, so the screen
  // never has to tell "no rows" apart from "key absent".
  const perSource: Record<string, number> = { ghl_cache: 0, inbox: 0, job_events: 0, business_events: 0, chat_logs: 0 };
  for (const m of conversation) {
    const key = m.source_system ?? "unknown";
    perSource[key] = (perSource[key] ?? 0) + 1;
  }

  return {
    version: INVOICE_CONTEXT_VERSION,
    as_of: now.toISOString(),
    mode,
    invoice: {
      ...invoiceView(inv, now),
      chase: { count: chaseRows.length, last: chaseRows[0] ? { at: chaseRows[0].created_at, method: chaseRows[0].method, outcome: chaseRows[0].outcome ?? null, notes: chaseRows[0].notes ?? null, by: chaseRows[0].chased_by ?? null } : null, next_follow_up: nextFollowUp },
    },
    link: { status: link.status, method: link.method, job_id: link.job_id, job_number: link.job_number, candidates: link.status === "ambiguous" ? link.candidates : [] },
    job,
    facts: facts.map((f: any) => ({ id: f.id, kind: f.kind, value: f.value, provenance: f.provenance ?? null, updated_at: f.updated_at ?? null })),
    dispatch_working_state: dispatchWorkingState,
    conversation: {
      messages: conversation.map((m: any) => ({
        at: m.occurred_at ?? null, channel: m.channel ?? null, direction: m.direction ?? null, author: m.author ?? null, subject: m.subject ?? null,
        preview: m.preview ?? String(m.body ?? "").slice(0, 500), source_system: m.source_system ?? null, source_ref: m.source_ref ?? null,
      })),
      last_client_message: brief(lastClient), last_outbound: brief(lastOutbound), sources: perSource,
    },
    bank: { xero_payments: xeroPayments(inv.raw_json), paid_in_bank_unreconciled: null },
    blockers,
    coverage: {
      job_linked: link.status === "linked" && Boolean(job),
      contact_known: contactKnown,
      facts_present: facts.length > 0,
      conversation_present: conversationPresenceOk && clientMessageCount > 0,
      xero_fresh: xeroFresh,
    },
    sources,
    warnings,
  };
}

// ── coverage over the whole population ──────────────────────────────────────

export async function debtContextCoverage(params: URLSearchParams, deps: InvoiceContextDeps) {
  const now = (deps.now ?? (() => new Date()))();
  const client = deps.client;
  const population = str(params.get("population")) ?? "open";
  if (population !== "open" && population !== "overdue") throw new InvoiceContextError("population must be open or overdue");
  const today = now.toISOString().slice(0, 10);

  let q = client.from("xero_invoices")
    .select("xero_invoice_id, xero_contact_id, contact_name, invoice_number, reference, status, amount_due, due_date, invoice_date, job_id, job_number, synced_at, debt_classification")
    .eq("org_id", deps.orgId).eq("invoice_type", "ACCREC").in("status", OPEN_STATUSES).gt("amount_due", 0)
    .order("due_date", { ascending: true }).limit(1000);
  if (population === "overdue") q = q.lt("due_date", today);
  const invoices: any[] = unwrap(await q) || [];
  const sources: Record<string, SourceStatus> = { invoices: { ok: true, count: invoices.length } };
  const warnings: string[] = [];
  // The population read is deliberately capped at one page: 1000 open
  // receivables is already far past the real book. A cap hit is a warning, not
  // a source failure (contract rule 6).
  if (invoices.length >= PAGE_SIZE) warnings.push(`invoices: read cap ${PAGE_SIZE} reached; the open population may be larger than this page`);

  const linkRead = await safeRead("job_link", () => resolveJobLinks(client, invoices));
  sources.job_link = linkRead.status;
  const links = linkRead.data ?? new Map<string, JobLink>();
  const linkedIds = [...new Set([...links.values()].filter((l) => l.status === "linked" && l.job_id).map((l) => l.job_id!))];

  const jobsRead = await safeRead("jobs", async () => {
    const rows: any[] = [];
    for (const ids of chunk(linkedIds)) {
      rows.push(...await pageThrough("jobs", () => client.from("jobs").select("id, job_number, ghl_contact_id").in("id", ids), warnings));
    }
    return rows;
  });
  sources.jobs = jobsRead.status;
  const jobs = new Map<string, any>();
  for (const j of jobsRead.data || []) jobs.set(j.id, j);

  const [facts, queues, conv] = await Promise.all([
    factsCountByJob(deps, linkedIds, warnings),
    queueByJob(client, linkedIds, warnings),
    conversationCountsByJob(client, linkedIds.map((id) => ({ id, ghl_contact_id: jobs.get(id)?.ghl_contact_id ?? null })), warnings),
  ]);
  sources.facts = facts.status;
  sources.extraction_queue = queues.status;
  sources.conversation = conv.status;

  // Rule 1 holds on every row: a false flag always carries a blocker, and an
  // unreadable source is never reported as an empty one.
  const factsOk = facts.status.ok;
  const conversationOk = conv.status.ok;
  const jobsOk = jobsRead.status.ok;
  for (const [label, st] of Object.entries(sources)) if (!st.ok) warnings.push(`${label}: read failed (${st.error ?? "unknown"})`);

  const totals = { invoices: invoices.length, amount_due: 0, overdue: 0, linked: 0, ambiguous: 0, none: 0, contact_known: 0, ghl_contact_known: 0, facts_present: 0, conversation_present: 0, xero_fresh: 0, complete: 0, distinct_linked_jobs: linkedIds.length };
  const rows = invoices.map((inv) => {
    const link = links.get(inv.xero_invoice_id) ?? { status: "none", method: null, job_id: null, job_number: null, candidates: [] } as JobLink;
    const jobId = link.status === "linked" ? link.job_id : null;
    const job = jobId ? jobs.get(jobId) : null;
    const factsCount = jobId ? facts.counts.get(jobId) ?? 0 : 0;
    const c = jobId ? conv.counts.get(jobId) : undefined;
    const clientCount = c ? c.ghl_cache + c.inbox + c.business_events : 0;
    const factsPresent = Boolean(jobId) && factsOk && factsCount > 0;
    const conversationPresent = Boolean(jobId) && conversationOk && clientCount > 0;
    const contactKnown = Boolean(inv.xero_contact_id);
    const ghlKnown = Boolean(job?.ghl_contact_id);
    const ageMinutes = inv.synced_at ? (now.getTime() - Date.parse(inv.synced_at)) / 60_000 : null;
    const xeroFresh = ageMinutes !== null && ageMinutes <= XERO_STALE_HOURS * 60;
    const blockers: string[] = [];
    if (!contactKnown) blockers.push("no_contact");
    if (link.status === "none") blockers.push("no_job_linked");
    if (link.status === "ambiguous") blockers.push("job_link_ambiguous");
    if (link.status === "linked" && !job) blockers.push(jobsOk ? "no_job_linked" : "job_read_failed");
    if (jobId && job && !ghlKnown) blockers.push("no_ghl_contact");
    if (jobId && !factsOk) blockers.push("facts_unreadable"); else if (jobId && factsCount === 0) blockers.push("facts_missing");
    if (jobId && !conversationOk) blockers.push("conversation_unreadable"); else if (jobId && clientCount === 0) blockers.push("conversation_missing");
    if (!xeroFresh) blockers.push("xero_stale");
    const dueDays = daysBetween(str(inv.due_date), now);
    const overdue = dueDays !== null && dueDays > 0;
    const complete = Boolean(jobId) && Boolean(job) && contactKnown && factsPresent && conversationPresent && xeroFresh;
    totals.amount_due += num(inv.amount_due) ?? 0;
    if (overdue) totals.overdue += 1;
    if (link.status === "linked") totals.linked += 1; else if (link.status === "ambiguous") totals.ambiguous += 1; else totals.none += 1;
    if (contactKnown) totals.contact_known += 1;
    if (ghlKnown) totals.ghl_contact_known += 1;
    if (factsPresent) totals.facts_present += 1;
    if (conversationPresent) totals.conversation_present += 1;
    if (xeroFresh) totals.xero_fresh += 1;
    if (complete) totals.complete += 1;
    return {
      invoice_number: inv.invoice_number ?? null, xero_invoice_id: inv.xero_invoice_id, contact_name: inv.contact_name ?? null,
      amount_due: num(inv.amount_due), due_date: inv.due_date ?? null, days_overdue: dueDays === null ? null : Math.max(0, dueDays),
      classification: inv.debt_classification ?? null,
      link_status: link.status, link_method: link.method, job_id: jobId, job_number: link.job_number ?? job?.job_number ?? null,
      candidates: link.status === "ambiguous" ? link.candidates : [],
      contact_known: contactKnown, ghl_contact_known: jobId ? ghlKnown : null,
      facts_count: jobId && factsOk ? factsCount : null,
      conversation_count: jobId && conversationOk ? clientCount : null,
      conversation_sources: c ? { ghl_cache: c.ghl_cache, inbox: c.inbox, business_events: c.business_events, notes: c.job_events } : null,
      last_client_message_at: c?.last_client_message_at ?? null,
      extraction_queue: jobId ? queueDetail(queues.queues.get(jobId), queues.status.ok) : null,
      xero_fresh: xeroFresh, blockers, complete,
    };
  });
  totals.amount_due = Math.round(totals.amount_due * 100) / 100;

  return { version: INVOICE_CONTEXT_VERSION, as_of: now.toISOString(), population, totals, rows, sources, warnings };
}
