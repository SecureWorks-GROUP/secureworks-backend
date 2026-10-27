// deno-lint-ignore-file no-explicit-any
// ════════════════════════════════════════════════════════════
// BILL PRE-MATCH RUN — xero-sync's materials step, after the queue upsert.
//
// For every OPEN Bills to place row (materials_reconciliation_queue):
//   1. a bill voided or deleted in Xero leaves the list (status void_in_xero,
//      closed_reason kept; nothing else changes);
//   2. bill_prematch.ts decides; the decision is kept in materials_bill_proposals
//      (a changed decision supersedes the old row, history kept, never wiped);
//   3. a CONFIDENT decision (a job number on the bill or its PO naming one live
//      job, nothing disagreeing) is placed through the same landing a staff
//      press makes (ops-api materials_recon.ts assignReconRow), stamped
//      automation_source agent_prematch with the rule and reason, reversible by
//      deleting that one fact. Everything else waits for one staff press.
//
// Never writes Xero. Never moves a bill a person placed or filed, and never
// places a bill again once a person undid the agent's placement. Any read that
// the decision depends on failing (jobs, purchase orders, email attachments)
// stops the matching for this run: the unique-match guard needs the FULL job
// population, so a partial read must never feed it.
// ════════════════════════════════════════════════════════════

import {
  buildAddressIndex,
  buildDocumentIndex,
  buildJobMaps,
  decideBillPrematch,
  decisionFingerprint,
  duplicateDocumentsOf,
  fileNameGrams,
  invoiceKeyForms,
  invoiceNumberKey,
  type PrematchBill,
  type PrematchDecision,
  type PrematchJob,
  type PrematchPO,
} from "./bill_prematch.ts";
import { AGENT_PREMATCH_SOURCE, assignReconRow } from "../ops-api/materials_recon.ts";
import { HELD_QUEUE_REASONS } from "./materials_ingest.ts";

const PAGE = 1000;
const CHUNK = 100;
// A run's write budget; the rest carries to the next sync (every 15 minutes).
export const PREMATCH_MAX_PROPOSAL_WRITES = 150;
export const PREMATCH_MAX_ASSIGNS = 25;

export interface BillPrematchResult {
  ran: boolean;
  reason?: string;
  open_bills: number;
  voided_closed: number;
  decided: Record<string, number>;
  proposals_written: number;
  proposals_superseded: number;
  assigned: number;
  assign_refused: number;
  deferred: number;
  errors: number;
}

export async function readAll<T>(build: () => any): Promise<T[] | null> {
  const rows: T[] = [];
  for (let from = 0;; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error || !Array.isArray(data)) return null;
    rows.push(...data);
    if (data.length < PAGE) return rows;
  }
}

async function readIn<T>(
  sb: any,
  table: string,
  cols: string,
  col: string,
  ids: string[],
  extra?: (q: any) => any,
): Promise<T[] | null> {
  const out: T[] = [];
  const uniq = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < uniq.length; i += CHUNK) {
    const chunk = uniq.slice(i, i + CHUNK);
    // One chunk can pass 1,000 rows (proposal history), so page it too.
    const rows = await readAll<T>(() => {
      let q = sb.from(table).select(cols).in(col, chunk);
      if (extra) q = extra(q);
      return q.order("id");
    });
    if (!rows) return null;
    out.push(...rows);
  }
  return out;
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function businessUnit(tracking: unknown): string | null {
  if (!Array.isArray(tracking)) return null;
  const bu = tracking.find((t: any) => String(t?.Name || "").toLowerCase() === "business unit");
  return bu?.Option ? String(bu.Option) : null;
}

/** A xero_invoices row (with line_items) as the matcher reads it. */
/** The supplier-document identity of a bill as Xero holds it now (queue copy only as a fallback). */
export function currentDocument(bill: PrematchBill, inv: any) {
  if (!inv) return bill;
  return {
    xero_invoice_id: bill.xero_invoice_id,
    invoice_number: inv.invoice_number ?? null,
    xero_contact_id: inv.xero_contact_id ?? null,
    contact_name: inv.contact_name ?? null,
    sub_total: inv.sub_total ?? null,
  };
}

export function toPrematchBill(q: any, inv: any): PrematchBill {
  const lines = Array.isArray(inv?.line_items) ? inv.line_items : [];
  return {
    xero_invoice_id: q.xero_invoice_id,
    invoice_number: q.invoice_number ?? inv?.invoice_number ?? null,
    xero_contact_id: q.xero_contact_id ?? null,
    contact_name: q.contact_name ?? null,
    reference: inv?.reference ?? null,
    sub_total: q.sub_total != null ? Number(q.sub_total) : null,
    invoice_date: q.invoice_date ?? null,
    xero_job_id: inv?.job_id ?? null,
    lines: lines.map((l: any) => ({
      description: l?.Description ?? null,
      account_code: l?.AccountCode != null ? String(l.AccountCode) : null,
      amount: l?.LineAmount != null ? Number(l.LineAmount) : null,
      business_unit: businessUnit(l?.Tracking),
    })),
  };
}

/** The full live job population as the matcher reads it. */
export function toPrematchJobs(rows: any[]): PrematchJob[] {
  return rows
    .filter((j) => j?.id && j?.job_number)
    .map((j) => ({
      id: j.id,
      job_number: String(j.job_number).toUpperCase(),
      status: j.status ?? null,
      created_at: j.created_at ?? null,
      site_address: j.site_address ?? null,
      holding: j.do_not_schedule === true || j.do_not_schedule === "true",
    }));
}

/** For each bill, the jobs whose filed email carries that bill's invoice number as a file name. */
export function emailJobsByBill(
  bills: PrematchBill[],
  attachments: Array<{ file_name: string | null; job_id: string | null }>,
): Map<string, string[]> {
  const jobsByKey = new Map<string, Set<string>>();
  for (const a of attachments) {
    if (!a.job_id) continue;
    for (const g of fileNameGrams(a.file_name)) {
      if (!jobsByKey.has(g)) jobsByKey.set(g, new Set());
      jobsByKey.get(g)!.add(a.job_id);
    }
  }
  const out = new Map<string, string[]>();
  for (const b of bills) {
    const key = invoiceNumberKey(b.invoice_number);
    if (!key) continue;
    const jobs = new Set<string>();
    for (const k of invoiceKeyForms(key)) for (const j of jobsByKey.get(k) || []) jobs.add(j);
    if (jobs.size) out.set(b.xero_invoice_id, [...jobs]);
  }
  return out;
}

function proposalRow(
  q: any,
  d: Exclude<PrematchDecision, { kind: "excluded" } | { kind: "none" }>,
  hash: string,
  nowIso: string,
  outcomeReason: string | null,
): Record<string, unknown> {
  return {
    org_id: q.org_id,
    xero_invoice_id: q.xero_invoice_id,
    queue_id: q.id,
    invoice_number: q.invoice_number ?? null,
    proposal_kind: d.kind,
    proposed_job_id: d.kind === "job" ? d.job_id : null,
    proposed_job_number: d.kind === "job" ? d.job_number : null,
    confidence: d.confidence,
    rule: d.rule,
    reason: d.reason,
    candidates: "candidates" in d ? d.candidates : [],
    signals: d.kind === "job" && d.po_id ? { po_id: d.po_id } : {},
    input_hash: hash,
    outcome: "queued_for_review",
    outcome_reason: outcomeReason,
    created_at: nowIso,
    updated_at: nowIso,
  };
}

export async function runBillPrematch(
  sb: any,
  opts: { orgId: string; nowIso?: string; maxProposalWrites?: number; maxAssigns?: number },
): Promise<BillPrematchResult> {
  const now = opts.nowIso || new Date().toISOString();
  const maxWrites = opts.maxProposalWrites ?? PREMATCH_MAX_PROPOSAL_WRITES;
  const maxAssigns = opts.maxAssigns ?? PREMATCH_MAX_ASSIGNS;
  const result: BillPrematchResult = {
    ran: false,
    open_bills: 0,
    voided_closed: 0,
    decided: {},
    proposals_written: 0,
    proposals_superseded: 0,
    assigned: 0,
    assign_refused: 0,
    deferred: 0,
    errors: 0,
  };

  // Open rows and their bills.
  const queue = await readAll<any>(() =>
    sb.from("materials_reconciliation_queue")
      .select("id, org_id, xero_invoice_id, invoice_number, xero_contact_id, contact_name, sub_total, invoice_date, status, assigned_by, suggestion_reason")
      .eq("org_id", opts.orgId).eq("status", "open").order("id")
  );
  if (!queue) return { ...result, reason: "queue_unreadable" };
  result.open_bills = queue.length;
  const invoices = await readIn<any>(
    sb,
    "xero_invoices",
    "xero_invoice_id, invoice_number, status, reference, line_items, job_id, xero_contact_id, contact_name, sub_total",
    "xero_invoice_id",
    queue.map((q) => q.xero_invoice_id),
  );
  if (!invoices) return { ...result, reason: "bills_unreadable" };
  const invById = new Map(invoices.map((i) => [i.xero_invoice_id, i]));

  // 1. Voided or deleted in Xero: leave the list (status change only).
  const live: any[] = [];
  for (const q of queue) {
    const inv = invById.get(q.xero_invoice_id);
    const st = String(inv?.status || "").toUpperCase();
    if (st === "VOIDED" || st === "DELETED") {
      const { data, error } = await sb.from("materials_reconciliation_queue")
        .update({
          status: "void_in_xero",
          closed_reason: st === "VOIDED" ? "xero_bill_voided" : "xero_bill_deleted",
          assigned_by: "xero-sync",
          assigned_at: now,
          updated_at: now,
        })
        .eq("id", q.id).eq("status", "open").select("id");
      if (error) result.errors++;
      else if (Array.isArray(data) && data.length) result.voided_closed++;
      continue;
    }
    // Only an issued bill can become a job's cost: DRAFT and SUBMITTED bills
    // stay on the list untouched until Xero authorises them.
    if (inv && (st === "AUTHORISED" || st === "PAID")) live.push(q);
  }

  // 2. Everything a decision reads. Any failure stops the matching (never a partial population).
  const jobRows = await readAll<any>(() =>
    sb.from("jobs")
      .select("id, job_number, status, created_at, site_address, do_not_schedule:metadata->do_not_schedule")
      .eq("org_id", opts.orgId).order("id")
  );
  if (!jobRows) return { ...result, reason: "jobs_unreadable" };
  const jobs = toPrematchJobs(jobRows);
  const { jobsById, jobsByNumber, duplicateNumbers, digitTwins } = buildJobMaps(jobs);
  const addressIndex = buildAddressIndex(jobs);

  const pos = await readAll<PrematchPO>(() =>
    sb.from("purchase_orders")
      .select("id, po_number, job_id, xero_contact_id, supplier_name, subtotal, status, xero_bill_id")
      .order("id")
  );
  if (!pos) return { ...result, reason: "purchase_orders_unreadable" };
  const poFacts = await readAll<any>(() =>
    sb.from("job_materials_facts").select("xero_invoice_id, matched_po_id")
      .not("matched_po_id", "is", null).order("id")
  );
  if (!poFacts) return { ...result, reason: "purchase_order_facts_unreadable" };
  const poFactBills = new Map<string, string[]>();
  for (const f of poFacts) {
    if (!poFactBills.has(f.matched_po_id)) poFactBills.set(f.matched_po_id, []);
    poFactBills.get(f.matched_po_id)!.push(f.xero_invoice_id);
  }

  // A trade-invoice mirror is labour already counted from the trade lines; it is
  // never a materials fact, even if its queue row is still open.
  const mirrorRows = await readIn<any>(sb, "trade_invoices", "xero_bill_id", "xero_bill_id", live.map((q) => q.xero_invoice_id));
  if (!mirrorRows) return { ...result, reason: "trade_mirrors_unreadable" };
  const mirrorIds = new Set(mirrorRows.map((m) => m.xero_bill_id));
  // Keep live and bills index-aligned: drop mirrors from live itself.
  for (let i = live.length - 1; i >= 0; i--) if (mirrorIds.has(live[i].xero_invoice_id)) live.splice(i, 1);
  const bills = live.map((q) => toPrematchBill(q, invById.get(q.xero_invoice_id)));
  const atts = await readAll<any>(() =>
    sb.from("context_email_attachments").select("file_name, business_event_id")
      .not("business_event_id", "is", null).order("id")
  );
  if (!atts) return { ...result, reason: "email_attachments_unreadable" };
  // Only events whose attachment names a bill's invoice number are looked up.
  const keys = new Set(
    bills.flatMap((b) => {
      const k = invoiceNumberKey(b.invoice_number);
      return k ? invoiceKeyForms(k) : [];
    }),
  );
  const wanted = atts.filter((a) => fileNameGrams(a.file_name).some((g) => keys.has(g)));
  const events = await readIn<any>(sb, "business_events", "id, job_id", "id", wanted.map((a) => a.business_event_id));
  if (!events) return { ...result, reason: "email_events_unreadable" };
  const eventJob = new Map(events.map((e) => [e.id, e.job_id]));
  const emailJobs = emailJobsByBill(
    bills,
    wanted.map((a) => ({ file_name: a.file_name, job_id: eventJob.get(a.business_event_id) ?? null })),
  );

  // The same supplier document entered twice (even under two contacts) is held
  // for a person: every live supplier bill is read so a duplicate is never missed.
  const allBills = await readAll<any>(() =>
    sb.from("xero_invoices")
      .select("xero_invoice_id, invoice_number, xero_contact_id, contact_name, sub_total, status")
      .eq("org_id", opts.orgId).eq("invoice_type", "ACCPAY").order("xero_invoice_id")
  );
  if (!allBills) return { ...result, reason: "supplier_documents_unreadable" };
  const documentIndex = buildDocumentIndex(allBills);

  const facts = await readIn<any>(sb, "job_materials_facts", "xero_invoice_id, automation_source", "xero_invoice_id", bills.map((b) => b.xero_invoice_id));
  const proposals = await readIn<any>(
    sb,
    "materials_bill_proposals",
    "id, xero_invoice_id, outcome, outcome_reason, input_hash, auto_assigned_at",
    "xero_invoice_id",
    bills.map((b) => b.xero_invoice_id),
  );
  if (!facts || !proposals) return { ...result, reason: "existing_rows_unreadable" };
  const hasFact = new Set(facts.map((f) => f.xero_invoice_id));
  const liveProposal = new Map<string, any>();
  const placedBefore = new Set<string>(
    live.filter((q) => q.assigned_by === AGENT_PREMATCH_SOURCE).map((q) => q.xero_invoice_id),
  );
  for (const p of proposals) {
    if (p.outcome !== "superseded") liveProposal.set(p.xero_invoice_id, p);
    if (p.auto_assigned_at) placedBefore.add(p.xero_invoice_id);
  }
  result.ran = true;

  const supersede = async (id: string, why: string) => {
    const { error } = await sb.from("materials_bill_proposals")
      .update({ outcome: "superseded", outcome_reason: why, updated_at: now })
      .eq("id", id).neq("outcome", "superseded");
    if (error) result.errors++;
    else result.proposals_superseded++;
    return !error;
  };

  // 3. Decide, keep, and place the confident ones.
  for (let i = 0; i < live.length; i++) {
    const q = live[i];
    const bill = bills[i];
    const d = decideBillPrematch(bill, {
      jobsById,
      jobsByNumber,
      duplicateNumbers,
      digitTwins,
      addressIndex,
      pos,
      poFactBills,
      emailJobIds: emailJobs.get(bill.xero_invoice_id) || [],
      // Detected on the bill as Xero holds it now, not the queue's older copy.
      duplicateDocuments: duplicateDocumentsOf(currentDocument(bill, invById.get(bill.xero_invoice_id)), documentIndex),
    });
    const bucket = d.kind === "job" ? `job_${d.confidence}` : d.kind;
    result.decided[bucket] = (result.decided[bucket] || 0) + 1;
    const current = liveProposal.get(bill.xero_invoice_id);

    if (d.kind === "excluded" || d.kind === "none") {
      if (current) await supersede(current.id, `no longer matches (${d.rule})`);
      continue;
    }
    const hash = await sha256Hex(decisionFingerprint(d));
    const undone = placedBefore.has(bill.xero_invoice_id); // a person undid an agent placement
    // A row held for a person (the sync removed a contradicted fact, or Xero
    // links another job) is proposed but never placed by the agent.
    // A duplicated supplier document is held on its queue row for good: if a
    // copy is voided later, the bill left still waits for a person.
    if (d.kind === "review" && d.rule === "duplicate_document" && q.suggestion_reason !== "duplicate_document") {
      const { data: heldRows, error: hErr } = await sb.from("materials_reconciliation_queue")
        .update({ suggestion_reason: "duplicate_document", updated_at: now })
        .eq("id", q.id).eq("status", "open").select("id");
      if (hErr || !Array.isArray(heldRows)) result.errors++;
      else if (heldRows.length) q.suggestion_reason = "duplicate_document";
    }
    const held = HELD_QUEUE_REASONS.has(String(q.suggestion_reason || ""));
    const canPlace = d.kind === "job" && d.confidence === "high" && !hasFact.has(bill.xero_invoice_id) && !undone && !held;
    if (current && current.input_hash === hash && current.outcome === "queued_for_review") {
      // Unchanged, and either not for the agent to place or already refused once: leave it.
      const refused = String(current.outcome_reason || "").startsWith("agent placement refused");
      if (!canPlace || refused) continue;
    }
    // A live "assigned" proposal on a bill that is open again means a person undid
    // the placement: it falls through, is superseded, and is never placed again.

    if (result.proposals_written >= maxWrites || (canPlace && result.assigned + result.assign_refused >= maxAssigns)) {
      result.deferred++;
      continue;
    }
    if (current && !(await supersede(current.id, undone ? "the agent's placement was undone" : "replaced by a newer decision"))) {
      continue;
    }
    const outcomeReason = undone && d.kind === "job" && d.confidence === "high"
      ? "an earlier agent placement of this bill was undone; left for staff"
      : null;
    const { data: ins, error: insErr } = await sb.from("materials_bill_proposals")
      .insert(proposalRow(q, d, hash, now, outcomeReason)).select("id").single();
    if (insErr || !ins) {
      result.errors++;
      continue;
    }
    result.proposals_written++;
    if (!canPlace || d.kind !== "job") continue;

    try {
      await assignReconRow(sb, {
        queueId: q.id,
        jobId: d.job_id,
        actor: AGENT_PREMATCH_SOURCE,
        orgId: opts.orgId,
        nowIso: now,
        agent: { matchReason: `${d.rule}: ${d.reason}`, matchedPoId: d.po_id },
      });
      if (d.po_id) {
        if (!poFactBills.has(d.po_id)) poFactBills.set(d.po_id, []);
        poFactBills.get(d.po_id)!.push(q.xero_invoice_id);
      }
      const { error } = await sb.from("materials_bill_proposals")
        .update({ outcome: "assigned", outcome_reason: "placed by the agent", auto_assigned_at: now, updated_at: now })
        .eq("id", ins.id);
      if (error) result.errors++;
      result.assigned++;
    } catch (e) {
      result.assign_refused++;
      await sb.from("materials_bill_proposals")
        .update({ outcome_reason: `agent placement refused: ${(e as Error).message}`.slice(0, 500), updated_at: now })
        .eq("id", ins.id);
    }
  }

  // 4. A proposal waiting on a bill that is no longer open is history.
  const openIds = new Set(live.map((q) => q.xero_invoice_id));
  const waiting = await readAll<any>(() =>
    sb.from("materials_bill_proposals").select("id, xero_invoice_id")
      .eq("outcome", "queued_for_review").order("id")
  );
  for (const p of waiting || []) {
    if (!openIds.has(p.xero_invoice_id)) await supersede(p.id, "bill no longer open");
  }
  return result;
}
