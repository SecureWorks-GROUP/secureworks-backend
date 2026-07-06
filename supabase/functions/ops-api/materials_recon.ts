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
  status: string; // open | assigned | not_job_related
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
    confidence: "high_manual",
    automation_source: "manual_queue",
    matched_po_id: null,
    match_reason: manualQueueMatchReason(action, job.job_number),
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
): "proceed" | "idempotent" | "conflict" {
  if (!existing) return "proceed";
  if (existing.automation_source === "manual_queue" && existing.job_id === targetJobId) {
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
  const { data, error } = await client
    .from("materials_reconciliation_queue")
    .select("status, total, sub_total")
    .eq("org_id", orgId);
  if (error) throw error;
  const stats = {
    open: 0,
    assigned: 0,
    not_job_related: 0,
    total_rows: 0,
    open_total_inc: 0,
    open_total_ex: 0,
  };
  for (const r of (data || []) as Array<Record<string, any>>) {
    stats.total_rows += 1;
    if (r.status === "open") {
      stats.open += 1;
      stats.open_total_inc += Number(r.total ?? 0);
      stats.open_total_ex += Number(r.sub_total ?? 0);
    } else if (r.status === "assigned") {
      stats.assigned += 1;
    } else if (r.status === "not_job_related") {
      stats.not_job_related += 1;
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
  return { ok: true, status, rows: data || [], stats };
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
  },
): Promise<Record<string, unknown>> {
  const now = args.nowIso || new Date().toISOString();
  const queue = await loadQueueRow(client, args);
  if (!queue) throw new Error("reconciliation queue row not found");

  // Resolve the target job.
  const action: AssignAction = args.useSuggestion ? "accept-suggestion" : "assign-to-job";
  let job: JobRef | null;
  if (args.useSuggestion) {
    if (!queue.suggested_job_id) {
      throw new Error("this row has no suggested job to accept — use assign-to-job with an explicit job");
    }
    // Resolve to get a canonical job_number even if the suggestion column is stale.
    job = await resolveJob(client, queue.suggested_job_id, null);
    if (!job) job = { id: queue.suggested_job_id, job_number: queue.suggested_job_number };
  } else {
    if (!args.jobId && !args.jobNumber) {
      throw new Error("job_id or job_number is required to assign this bill");
    }
    job = await resolveJob(client, args.jobId, args.jobNumber);
    if (!job) throw new Error(`job not found: ${args.jobId || args.jobNumber}`);
  }

  // BOUNDARY GUARD: a bill can only ever carry one fact.
  const existing = await loadFact(client, queue.xero_invoice_id);
  const disposition = classifyAssign(existing, job.id);
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
  const factRow = buildManualFactRow(queue, job, args.actor, action, now);
  const { data: fact, error: fErr } = await client
    .from("job_materials_facts")
    .insert(factRow)
    .select()
    .single();
  if (fErr) throw fErr;

  // Flip the queue row → assigned (the bill is no longer open work).
  const { data: updatedQueue, error: qErr } = await client
    .from("materials_reconciliation_queue")
    .update({
      status: "assigned",
      assigned_job_id: job.id,
      assigned_by: args.actor,
      assigned_at: now,
      updated_at: now,
    })
    .eq("id", queue.id)
    .select()
    .single();
  if (qErr) throw qErr;

  // Audit crumb (job-bearing → job_events).
  logJobEvent(client, {
    job_id: job.id,
    event_type: "materials_bill_assigned",
    detail_json: {
      source: "materials_recon_queue",
      action,
      manual: true,
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
    .select()
    .single();
  if (error) throw error;

  // No fact written; audit lives on the queue row (status + assigned_by + assigned_at).
  return { ok: true, action: "mark-not-job-related", fact: null, queue: updatedQueue };
}
