// deno-lint-ignore-file no-explicit-any
// ════════════════════════════════════════════════════════════
// MATERIALS RECONCILIATION QUEUE — OPS WORKLIST (U4, mission profit-materials-actuals)
//
// U3 (xero-sync) writes every unmatched, non-mirror ACCPAY bill into
// materials_reconciliation_queue with status='open'. U4 owns the OTHER end:
// the ops worklist that drains that queue by hand, auditably.
//
// This module owns the queue-drain logic and is the thing U4's tests replay. It
// performs its DB I/O through an INJECTED Supabase client (`client`) so the same
// functions the ops-api edge dispatch calls in prod are driven verbatim by unit
// tests against an in-memory fake client — no network, fully replayable.
//
// THREE OPERATOR ACTIONS (contract §3 U4), each recorded auditably:
//   accept-suggestion → land the advisory suggested job as a FACT (manual)
//   assign-to-job     → land ANY chosen job as a FACT (manual)
//   mark-not-job-related → close the row, write NO fact
//
// THE BOUNDARY (U3 schema §3, enforced here): a bill is NEVER simultaneously an
// open queue row AND a fact. Accept/assign writes the fact and flips the queue
// row to status='assigned'. A bill that already carries a fact (auto or manual)
// can never be re-assigned or dismissed from the queue without first reverting
// that fact — the fact is the single source of truth for the money.
//
// EVERY manual landing is stamped MANUAL and OWNED: the fact row carries
// confidence='high_manual', automation_source='manual_queue', assigned_by=<actor>;
// the queue row carries assigned_by + assigned_at; a job_events audit crumb is
// written for every job-bearing action. Nothing is silently dropped; open-count
// over time is the measurable drain (see reconStats()).
//
// CP1 Option A: facts are DERIVED rows keyed by xero_invoice_id, reversible by
// delete; source tables (xero_invoices / trade_invoices) are NEVER mutated.
// ════════════════════════════════════════════════════════════
import { amountIsKnown, HELD_QUEUE_REASONS } from "../xero-sync/materials_ingest.ts";

// ─────────────────────────────────────────────────────────────
// Row shapes (subset of the U3 migration columns we read/write).
// ─────────────────────────────────────────────────────────────
export interface QueueRow {
  id: string;
  org_id: string;
  xero_invoice_id: string;
  xero_contact_id: string | null;
  contact_name: string | null;
  invoice_number: string | null;
  sub_total: number | null; // ex-GST — the money fact
  total: number | null; // inc-GST — convenience
  invoice_date: string | null; // 'YYYY-MM-DD'
  suggested_job_id: string | null;
  suggested_job_number: string | null;
  suggestion_confidence: string | null;
  suggestion_reason: string | null;
  status: string; // open | assigned | not_job_related | void_in_xero
  assigned_job_id: string | null;
  assigned_by: string | null;
  assigned_at: string | null;
}

export interface JobRef {
  id: string;
  job_number: string | null;
}

export interface ExistingFact {
  id: string;
  xero_invoice_id: string;
  job_id: string;
  job_number: string | null;
  automation_source: string;
  confidence: string;
}

export type AssignAction = "accept-suggestion" | "assign-to-job";

// The bill pre-match agent (xero-sync/bill_prematch_run.ts) lands a confident
// match through this same path, stamped as its own source so it is traceable
// and reversible (delete the one fact, re-open the queue row).
export const AGENT_PREMATCH_SOURCE = "agent_prematch";
export interface AgentLanding {
  matchReason: string; // the proposal's rule and reason
  matchedPoId?: string | null; // the one PO a rule-1b placement rests on
}

// The live proposal the pre-match agent holds for a bill (materials_bill_proposals).
export interface BillProposal {
  xero_invoice_id: string;
  proposal_kind: string; // job | not_job_related | review
  proposed_job_id: string | null;
  proposed_job_number: string | null;
  confidence: string; // high | medium | low
  rule: string;
  reason: string;
  candidates: unknown;
  outcome: string;
  updated_at?: string | null;
}

const PROPOSAL_COLUMNS =
  "xero_invoice_id, proposal_kind, proposed_job_id, proposed_job_number, confidence, rule, reason, candidates, outcome, updated_at";

// ─────────────────────────────────────────────────────────────
// Pure builders / helpers (unit-tested in isolation).
// ─────────────────────────────────────────────────────────────

// The actor string for the manual marker. ops.html's opsPost() always injects
// operator_email from the logged-in Supabase user; we accept the common aliases
// and fall back to a non-empty sentinel so assigned_by is never blank/undefined
// (a manual landing must always be attributable).
export function resolveActor(body: Record<string, unknown> | null | undefined): string {
  const raw = (body?.operator_email ?? body?.user_email ?? body?.actor ?? "") as string;
  const trimmed = String(raw || "").trim();
  return trimmed.length > 0 ? trimmed : "ops_dashboard";
}

// Human-readable audit crumb baked into the fact's match_reason.
export function manualQueueMatchReason(action: AssignAction, jobNumber: string | null | undefined): string {
  const suffix = jobNumber ? ` ${jobNumber}` : "";
  return `manual_queue:${action}${suffix}`;
}

// Build the DERIVED fact row for a manual queue landing — same shape U3 writes
// for auto facts, but stamped manual (confidence high_manual, source manual_queue,
// assigned_by set, no matched PO). Keyed by xero_invoice_id → reversible by delete.
export function buildManualFactRow(
  queue: QueueRow,
  job: JobRef,
  actor: string,
  action: AssignAction,
  nowIso: string,
  agent?: AgentLanding | null,
): Record<string, unknown> {
  return {
    org_id: queue.org_id,
    xero_invoice_id: queue.xero_invoice_id,
    invoice_number: queue.invoice_number,
    xero_contact_id: queue.xero_contact_id,
    contact_name: queue.contact_name,
    job_id: job.id,
    job_number: job.job_number ?? null,
    lane: "materials",
    kind: "actual",
    amount_ex_gst: queue.sub_total ?? 0,
    amount_inc_gst: queue.total ?? null,
    confidence: agent ? "high" : "high_manual",
    automation_source: agent ? AGENT_PREMATCH_SOURCE : "manual_queue",
    matched_po_id: agent?.matchedPoId ?? null,
    match_reason: agent ? `${AGENT_PREMATCH_SOURCE}:${agent.matchReason}` : manualQueueMatchReason(action, job.job_number),
    fact_date: queue.invoice_date,
    assigned_by: actor,
    updated_at: nowIso,
  };
}

// Given the fact (if any) that already exists for this bill and the job we are
// about to assign, decide what the assign action should do. Pure + total.
//   'proceed'    — no fact yet, write one.
//   'idempotent' — the SAME manual fact already exists for the SAME job (double
//                  click / retry); succeed without a second write.
//   'conflict'   — a DIFFERENT fact owns this bill; refuse (revert it first).
export function classifyAssign(
  existing: ExistingFact | null,
  targetJobId: string,
  source = "manual_queue",
): "proceed" | "idempotent" | "conflict" {
  if (!existing) return "proceed";
  if (existing.automation_source === source && existing.job_id === targetJobId) {
    return "idempotent";
  }
  return "conflict";
}

// ─────────────────────────────────────────────────────────────
// I/O helpers (injected client). Kept tiny so the fake client only has to
// implement the exact chain each one uses.
// ─────────────────────────────────────────────────────────────
async function loadQueueRow(
  client: any,
  args: { queueId?: string | null; xeroInvoiceId?: string | null; orgId: string },
): Promise<QueueRow | null> {
  if (args.queueId) {
    const { data, error } = await client
      .from("materials_reconciliation_queue")
      .select("*")
      .eq("id", args.queueId)
      .maybeSingle();
    if (error) throw error;
    return (data as QueueRow) ?? null;
  }
  if (args.xeroInvoiceId) {
    const { data, error } = await client
      .from("materials_reconciliation_queue")
      .select("*")
      .eq("xero_invoice_id", args.xeroInvoiceId)
      .maybeSingle();
    if (error) throw error;
    return (data as QueueRow) ?? null;
  }
  throw new Error("queue_id or xero_invoice_id is required");
}

async function resolveJob(
  client: any,
  jobId: string | null | undefined,
  jobNumber: string | null | undefined,
): Promise<JobRef | null> {
  if (jobId) {
    const { data, error } = await client
      .from("jobs")
      .select("id, job_number")
      .eq("id", jobId)
      .maybeSingle();
    if (error) throw error;
    return (data as JobRef) ?? null;
  }
  if (jobNumber) {
    const { data, error } = await client
      .from("jobs")
      .select("id, job_number")
      .ilike("job_number", String(jobNumber).trim())
      .limit(1);
    if (error) throw error;
    return (data && data[0]) ? (data[0] as JobRef) : null;
  }
  return null;
}

async function loadFact(client: any, xeroInvoiceId: string): Promise<ExistingFact | null> {
  const { data, error } = await client
    .from("job_materials_facts")
    .select("id, xero_invoice_id, job_id, job_number, automation_source, confidence")
    .eq("xero_invoice_id", xeroInvoiceId)
    .maybeSingle();
  if (error) throw error;
  return (data as ExistingFact) ?? null;
}

export async function loadLiveProposals(
  client: any,
  xeroInvoiceIds: string[],
): Promise<Map<string, BillProposal>> {
  const out = new Map<string, BillProposal>();
  const ids = [...new Set(xeroInvoiceIds.filter(Boolean))];
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await client
      .from("materials_bill_proposals")
      .select(PROPOSAL_COLUMNS)
      .in("xero_invoice_id", ids.slice(i, i + 100))
      .neq("outcome", "superseded");
    if (error) throw error;
    for (const p of (data || []) as BillProposal[]) out.set(p.xero_invoice_id, p);
  }
  return out;
}

// The proposal as the worklist shows it. The queue's suggestion columns only
// allow low|medium, so a high-confidence proposal reads as medium there, with
// its reason saying why it is strong.
export function presentProposal(p: BillProposal): Record<string, unknown> {
  return {
    kind: p.proposal_kind,
    job_id: p.proposed_job_id,
    job_number: p.proposed_job_number,
    confidence: p.confidence,
    suggestion_confidence: p.confidence === "low" ? "low" : "medium",
    rule: p.rule,
    reason: p.reason,
    candidates: Array.isArray(p.candidates) ? p.candidates : [],
    outcome: p.outcome,
    updated_at: p.updated_at ?? null,
  };
}

// Fire-and-forget audit crumb. job_events.job_id is NOT NULL, so this is only
// called for job-bearing actions (assign/accept); not-job-related has no job and
// its audit lives on the queue row (status + assigned_by + assigned_at).
function logJobEvent(client: any, row: Record<string, unknown>): void {
  try {
    const p = client.from("job_events").insert(row);
    if (p && typeof p.then === "function") p.then(() => {}).catch(() => {});
  } catch (_e) {
    /* audit is best-effort; never block the primary write */
  }
}

// ─────────────────────────────────────────────────────────────
// reconStats — the measurable drain. Snapshot counts by status + open dollars.
// The historical trend is derivable from created_at/assigned_at, but the live
// open-count is what the worklist header renders and what a watcher polls.
// ─────────────────────────────────────────────────────────────
export async function reconStats(client: any, orgId: string): Promise<Record<string, number>> {
  // Paged: the queue passes PostgREST's 1,000-row cap, which cuts silently.
  const PAGE = 1000;
  const data: Array<Record<string, any>> = [];
  for (let from = 0;; from += PAGE) {
    const { data: page, error } = await client
      .from("materials_reconciliation_queue")
      .select("status, total, sub_total")
      .eq("org_id", orgId)
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw error;
    data.push(...(page || []));
    if (!page || page.length < PAGE) break;
  }
  const stats = {
    open: 0,
    assigned: 0,
    not_job_related: 0,
    void_in_xero: 0,
    total_rows: 0,
    open_total_inc: 0,
    open_total_ex: 0,
  };
  for (const r of data) {
    stats.total_rows += 1;
    if (r.status === "open") {
      stats.open += 1;
      stats.open_total_inc += Number(r.total ?? 0);
      stats.open_total_ex += Number(r.sub_total ?? 0);
    } else if (r.status === "assigned") {
      stats.assigned += 1;
    } else if (r.status === "not_job_related") {
      stats.not_job_related += 1;
    } else if (r.status === "void_in_xero") {
      stats.void_in_xero += 1;
    }
  }
  // round the money to cents (float accumulation hygiene)
  stats.open_total_inc = Math.round(stats.open_total_inc * 100) / 100;
  stats.open_total_ex = Math.round(stats.open_total_ex * 100) / 100;
  return stats;
}

// ─────────────────────────────────────────────────────────────
// PUBLIC HANDLERS — called by the ops-api dispatch AND by the U4 tests.
// ─────────────────────────────────────────────────────────────

// (a) THE WORKLIST SURFACE — list queue rows (default: open) + drain stats.
export async function listReconQueue(
  client: any,
  args: { status?: string; limit?: number; orgId: string },
): Promise<Record<string, unknown>> {
  const status = args.status || "open";
  const limit = Math.min(Math.max(Number(args.limit) || 200, 1), 1000);
  let q = client
    .from("materials_reconciliation_queue")
    .select("*")
    .eq("org_id", args.orgId);
  if (status && status !== "all") q = q.eq("status", status);
  q = q.order("invoice_date", { ascending: false }).limit(limit);
  const { data, error } = await q;
  if (error) throw error;
  const stats = await reconStats(client, args.orgId);
  // The pre-match agent's proposal and its reason ride on each row. A failed
  // proposal read leaves the rows as they are and says so; it never reads as
  // "no proposals".
  const rows = (data || []) as Array<Record<string, any>>;
  let proposals: "ok" | "failed" = "ok";
  try {
    const live = await loadLiveProposals(client, rows.map((r) => r.xero_invoice_id));
    for (const r of rows) {
      const p = live.get(r.xero_invoice_id);
      r.proposal = p ? presentProposal(p) : null;
      // Fill the existing "Suggested job" columns (which every sync blanks) from
      // a job proposal, so the screen's suggestion and Use it work unchanged.
      if (p && p.proposal_kind === "job" && !r.suggested_job_id && r.status === "open") {
        r.suggested_job_id = p.proposed_job_id;
        r.suggested_job_number = p.proposed_job_number;
        r.suggestion_confidence = p.confidence === "low" ? "low" : "medium";
        r.suggestion_source = AGENT_PREMATCH_SOURCE;
      }
    }
  } catch (e) {
    proposals = "failed";
    console.error("[materials_recon] proposal read failed:", (e as Error).message);
  }
  return { ok: true, status, rows, stats, proposals };
}

// (b1) accept-suggestion / assign-to-job — land a manual FACT, flip queue → assigned.
export async function assignReconRow(
  client: any,
  args: {
    queueId?: string | null;
    xeroInvoiceId?: string | null;
    jobId?: string | null;
    jobNumber?: string | null;
    useSuggestion?: boolean;
    actor: string;
    orgId: string;
    nowIso?: string;
    agent?: AgentLanding | null; // set only by the pre-match agent
  },
): Promise<Record<string, unknown>> {
  const now = args.nowIso || new Date().toISOString();
  const queue = await loadQueueRow(client, args);
  if (!queue) throw new Error("reconciliation queue row not found");
  // The agent only ever places a bill nobody has placed or filed.
  if (args.agent && queue.status !== "open") {
    throw new Error(`bill ${queue.xero_invoice_id} is ${queue.status}; the agent never moves a placed or filed bill`);
  }
  // A row held for a person (the sync removed a contradicted fact, or Xero links
  // another job) is never placed by the agent.
  if (args.agent && HELD_QUEUE_REASONS.has(String((queue as any).suggestion_reason || ""))) {
    throw new Error(`bill ${queue.xero_invoice_id} is held for staff (${(queue as any).suggestion_reason})`);
  }
  // Unknown cost is never placed as $0: the bill's amount must be known.
  if (!amountIsKnown(queue.sub_total)) {
    throw new Error(`bill ${queue.xero_invoice_id} has no known amount yet; it cannot be placed on a job`);
  }
  // A trade-invoice mirror is labour already counted from the trade lines: it
  // never becomes a materials cost, whoever places it.
  {
    const { data: mirror, error: mErr } = await client
      .from("trade_invoices").select("id").eq("xero_bill_id", queue.xero_invoice_id).limit(1);
    if (mErr) throw mErr;
    if (Array.isArray(mirror) && mirror.length > 0) {
      throw new Error(`bill ${queue.xero_invoice_id} is a trade invoice already counted as labour; it is never a materials cost`);
    }
  }

  // Resolve the target job.
  const action: AssignAction = args.useSuggestion ? "accept-suggestion" : "assign-to-job";
  let job: JobRef | null;
  if (args.useSuggestion) {
    let suggestedId = queue.suggested_job_id;
    let suggestedNumber = queue.suggested_job_number;
    if (!suggestedId) {
      // The sync blanks the queue's suggestion columns; the agent's job proposal
      // is the suggestion the screen shows (listReconQueue), so accept that.
      const p = (await loadLiveProposals(client, [queue.xero_invoice_id])).get(queue.xero_invoice_id);
      if (p && p.proposal_kind === "job" && p.proposed_job_id) {
        suggestedId = p.proposed_job_id;
        suggestedNumber = p.proposed_job_number;
      }
    }
    if (!suggestedId) {
      throw new Error("this row has no suggested job to accept — use assign-to-job with an explicit job");
    }
    // Resolve to get a canonical job_number even if the suggestion column is stale.
    job = await resolveJob(client, suggestedId, null);
    if (!job) job = { id: suggestedId, job_number: suggestedNumber };
  } else {
    if (!args.jobId && !args.jobNumber) {
      throw new Error("job_id or job_number is required to assign this bill");
    }
    job = await resolveJob(client, args.jobId, args.jobNumber);
    if (!job) throw new Error(`job not found: ${args.jobId || args.jobNumber}`);
  }

  // BOUNDARY GUARD: a bill can only ever carry one fact.
  const existing = await loadFact(client, queue.xero_invoice_id);
  const source = args.agent ? AGENT_PREMATCH_SOURCE : "manual_queue";
  const disposition = classifyAssign(existing, job.id, source);
  if (disposition === "conflict") {
    throw new Error(
      `bill ${queue.xero_invoice_id} already has a materials fact on job ${existing!.job_number ?? existing!.job_id} ` +
        `(source ${existing!.automation_source}); revert that fact before manual assignment`,
    );
  }

  if (disposition === "idempotent") {
    // Same manual fact already exists for the same job — make sure the queue row
    // reflects it and return without a second fact write.
    const { data: q2, error: qErr } = await client
      .from("materials_reconciliation_queue")
      .update({
        status: "assigned",
        assigned_job_id: job.id,
        assigned_by: args.actor,
        assigned_at: queue.assigned_at || now,
        updated_at: now,
      })
      .eq("id", queue.id)
      .select()
      .single();
    if (qErr) throw qErr;
    return { ok: true, idempotent: true, action, fact: existing, queue: q2 };
  }

  // Land the fact.
  const factRow = buildManualFactRow(queue, job, args.actor, action, now, args.agent);
  const { data: fact, error: fErr } = await client
    .from("job_materials_facts")
    .insert(factRow)
    .select()
    .single();
  if (fErr) throw fErr;

  // Flip the queue row → assigned (the bill is no longer open work). The agent's
  // flip only lands on a row still open; if a person moved it meanwhile, its
  // fact is taken back off and the person's decision stands.
  let flip = client
    .from("materials_reconciliation_queue")
    .update({
      status: "assigned",
      assigned_job_id: job.id,
      assigned_by: args.actor,
      assigned_at: now,
      updated_at: now,
    })
    .eq("id", queue.id);
  if (args.agent) {
    // Re-checked at the write: still open and still not held.
    flip = flip.eq("status", "open")
      .or(`suggestion_reason.is.null,suggestion_reason.not.in.(${[...HELD_QUEUE_REASONS].join(",")})`);
  }
  const { data: updatedQueue, error: qErr } = await flip.select().single();
  if (qErr) {
    if (args.agent && fact?.id) {
      await client.from("job_materials_facts").delete().eq("id", fact.id);
    }
    throw qErr;
  }

  // Audit crumb (job-bearing → job_events).
  logJobEvent(client, {
    job_id: job.id,
    event_type: "materials_bill_assigned",
    detail_json: {
      source: args.agent ? AGENT_PREMATCH_SOURCE : "materials_recon_queue",
      action: args.agent ? "agent-prematch" : action,
      manual: !args.agent,
      reason: args.agent ? args.agent.matchReason : undefined,
      reversible: args.agent ? "delete this bill's job_materials_facts row and re-open its queue row" : undefined,
      xero_invoice_id: queue.xero_invoice_id,
      invoice_number: queue.invoice_number,
      contact_name: queue.contact_name,
      amount_ex_gst: queue.sub_total ?? 0,
      job_number: job.job_number,
      assigned_by: args.actor,
      assigned_at: now,
    },
  });

  return { ok: true, action, fact, queue: updatedQueue };
}

// (b3) mark-not-job-related — close the row, write NO fact.
export async function markReconNotJobRelated(
  client: any,
  args: {
    queueId?: string | null;
    xeroInvoiceId?: string | null;
    actor: string;
    orgId: string;
    nowIso?: string;
  },
): Promise<Record<string, unknown>> {
  const now = args.nowIso || new Date().toISOString();
  const queue = await loadQueueRow(client, args);
  if (!queue) throw new Error("reconciliation queue row not found");

  // If a fact already owns this bill, dismissing the queue row would contradict
  // the money. Refuse — the fact must be reverted first.
  const existing = await loadFact(client, queue.xero_invoice_id);
  if (existing) {
    throw new Error(
      `bill ${queue.xero_invoice_id} is already attributed to job ${existing.job_number ?? existing.job_id}; ` +
        `revert that materials fact before marking not-job-related`,
    );
  }

  const { data: updatedQueue, error } = await client
    .from("materials_reconciliation_queue")
    .update({
      status: "not_job_related",
      assigned_job_id: null,
      assigned_by: args.actor,
      assigned_at: now,
      updated_at: now,
    })
    .eq("id", queue.id)
    // Only if the row is as it was read: if the agent placed the bill meanwhile,
    // this refuses (and the person sees it placed) instead of hiding a live cost.
    .eq("status", queue.status)
    .select()
    .single();
  if (error?.code === "PGRST116") {
    throw new Error(`bill ${queue.xero_invoice_id} changed while you were filing it; reload and try again`);
  }
  if (error) throw error;

  // No fact written; audit lives on the queue row (status + assigned_by + assigned_at).
  return { ok: true, action: "mark-not-job-related", fact: null, queue: updatedQueue };
}
