// deno-lint-ignore-file no-explicit-any
// The ops-api Supabase client is intentionally untyped at this boundary,
// matching the sibling store modules.
//
// The Restoration board's reads and its one stage write
// (docs/restoration-board-v1.md). Rules live in restoration_stage.ts.
//
// What it writes, and nothing else:
//   - jobs.metadata.restoration_stage  {stage, set_at, set_by, note, auto}
//   - jobs.status                      the status the stage leaves the job in
//   - job_events                       one `restoration_stage_changed` row
// Both jobs columns are written together, compare-and-set on jobs.updated_at.
// It sends nothing, touches no invoice and no make-safe substatus.

import {
  isRestorationStage,
  presentRestorationStage,
  RESTORATION_STAGE_JOB_STATUS,
  RESTORATION_STAGE_LABELS,
  RESTORATION_STAGES,
  restorationAutoAdvanceTarget,
  type RestorationInvoiceFact,
  type RestorationStage,
  type RestorationStageFacts,
  restorationStageNextStep,
  restorationStageRefusal,
  type RestorationStageTrigger,
} from "./restoration_stage.ts";
import {
  restorationBoardStatus,
  restorationScopeText,
  RestorationWorkflowError,
} from "./restoration_workflow.ts";
import {
  isRestorationCard,
  type RestorationCaller,
} from "./restoration_workflow_store.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Never scope_json or pricing_json: this is a list read.
const BOARD_JOB_COLUMNS =
  "id, org_id, job_number, type, status, client_name, site_address, site_suburb, notes, metadata, created_at, updated_at";

const OBSERVER_ROLES = new Set(["observer", "ghost", "watcher"]);

function fail(code: string, message: string, status = 400): never {
  throw new RestorationWorkflowError(code, message, status);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

function readFailed(what: string, error: any): never {
  fail(
    "restoration_read_failed",
    `${what} could not be read (${
      text(error?.message) || "unknown database error"
    }). Nothing was changed.`,
    503,
  );
}

function chunk<T>(items: T[], size = 50): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function genuineCrewRow(row: any): boolean {
  const status = text(row?.status).toLowerCase();
  if (status === "cancelled" || status === "declined") return false;
  if (row?.is_ghost === true) return false;
  const role = text(row?.role).toLowerCase();
  return !OBSERVER_ROLES.has(role) && role !== "makesafe_open";
}

function siteLine(job: any): string {
  const address = text(job.site_address);
  const suburb = text(job.site_suburb);
  if (!address) return suburb;
  return suburb && !address.toLowerCase().includes(suburb.toLowerCase())
    ? `${address}, ${suburb}`
    : address;
}

interface JobContext {
  detail: any | null;
  builderName: string | null;
  crew: Array<{ user_id: string; name: string | null; scheduled_date: string | null; status: string | null }>;
  invoices: Array<RestorationInvoiceFact & { xero_invoice_id: string | null }>;
}

/** Everything the stage rules read, for a set of jobs, in five batched reads. */
async function loadJobContexts(
  client: any,
  jobIds: string[],
): Promise<Map<string, JobContext>> {
  const contexts = new Map<string, JobContext>();
  for (const id of jobIds) {
    contexts.set(id, { detail: null, builderName: null, crew: [], invoices: [] });
  }
  if (jobIds.length === 0) return contexts;

  const details: any[] = [];
  const assignments: any[] = [];
  const invoices: any[] = [];
  for (const ids of chunk(jobIds)) {
    const [d, a, x] = await Promise.all([
      client.from("makesafe_job_details")
        .select(
          "job_id, external_ref, requesting_company_id, requesting_company_name, requesting_company_slug, special_instructions, report_received_at",
        )
        .in("job_id", ids),
      client.from("job_assignments")
        .select("job_id, user_id, status, role, is_ghost, scheduled_date")
        .in("job_id", ids),
      client.from("xero_invoices")
        .select("job_id, xero_invoice_id, invoice_number, invoice_type, status, total, amount_due")
        .in("job_id", ids),
    ]);
    if (d.error) readFailed("The jobs' builder details", d.error);
    if (a.error) readFailed("The jobs' crew bookings", a.error);
    if (x.error) readFailed("The jobs' invoices", x.error);
    details.push(...(d.data || []));
    assignments.push(...(a.data || []));
    invoices.push(...(x.data || []));
  }

  const companyIds = [...new Set(details.map((d) => text(d.requesting_company_id)).filter(Boolean))];
  const companyNames = new Map<string, string>();
  if (companyIds.length) {
    const { data, error } = await client.from("makesafe_companies")
      .select("id, name").in("id", companyIds);
    if (!error) {
      for (const row of data || []) if (text(row.name)) companyNames.set(row.id, text(row.name));
    }
  }
  const crewRows = assignments.filter(genuineCrewRow);
  const userIds = [...new Set(crewRows.map((r) => text(r.user_id)).filter(Boolean))];
  const userNames = new Map<string, string>();
  if (userIds.length) {
    const { data, error } = await client.from("users").select("id, name").in("id", userIds);
    if (!error) for (const row of data || []) if (text(row.name)) userNames.set(row.id, text(row.name));
  }

  for (const d of details) {
    const ctx = contexts.get(d.job_id);
    if (!ctx) continue;
    ctx.detail = d;
    const name = companyNames.get(text(d.requesting_company_id)) || text(d.requesting_company_name);
    ctx.builderName = name && name.toLowerCase() !== text(d.requesting_company_slug).toLowerCase()
      ? name
      : companyNames.get(text(d.requesting_company_id)) || name || null;
  }
  for (const row of crewRows) {
    contexts.get(row.job_id)?.crew.push({
      user_id: row.user_id,
      name: userNames.get(row.user_id) || null,
      scheduled_date: row.scheduled_date || null,
      status: row.status || null,
    });
  }
  for (const inv of invoices) {
    const type = text(inv.invoice_type).toUpperCase();
    const status = text(inv.status).toUpperCase();
    if (type && type !== "ACCREC") continue;
    if (status === "VOIDED" || status === "DELETED") continue;
    contexts.get(inv.job_id)?.invoices.push({
      xero_invoice_id: inv.xero_invoice_id || null,
      invoice_number: inv.invoice_number || null,
      status,
      total: inv.total == null ? null : Number(inv.total),
      amount_due: inv.amount_due == null ? null : Number(inv.amount_due),
    });
  }
  return contexts;
}

function factsFor(job: any, ctx: JobContext): {
  facts: RestorationStageFacts;
  plan: Record<string, unknown>;
} {
  const plan = restorationBoardStatus(
    job.metadata,
    restorationScopeText(job, ctx.detail),
  );
  const metadata = record(job.metadata);
  return {
    plan,
    facts: {
      job_status: text(job.status) || null,
      mode: text(plan.mode) || null,
      phase: text(plan.phase) || null,
      stored: metadata.restoration_stage,
      live_assignments: ctx.crew.length,
      report_received: Boolean(ctx.detail?.report_received_at),
      invoices: ctx.invoices,
    },
  };
}

function boardCard(job: any, ctx: JobContext): Record<string, unknown> {
  const { facts, plan } = factsFor(job, ctx);
  const presented = presentRestorationStage(facts);
  const mode = text(plan.mode) || null;
  const metadata = record(job.metadata);
  return {
    id: job.id,
    job_number: job.job_number || null,
    job_status: job.status || null,
    site: siteLine(job) || null,
    site_suburb: job.site_suburb || null,
    client_name: job.client_name || null,
    builder: ctx.builderName,
    builder_reference: text(ctx.detail?.external_ref) || text(metadata.builder_claim_ref) || null,
    builder_purchase_order: text(metadata.builder_po_number) || null,
    mode,
    mode_label: mode === "assess_and_quote"
      ? "Assess and quote"
      : mode === "do_and_charge"
      ? "Do and charge"
      : null,
    stage: presented.stage,
    stage_label: presented.label,
    stage_source: presented.source,
    stage_set_at: presented.stored?.set_at || null,
    stage_set_by: presented.stored?.set_by || null,
    derived_stage: presented.derived,
    next_step: restorationStageNextStep(presented.stage, mode),
    quote: {
      number: plan.quote_number || null,
      status: plan.quote_status || null,
      sent_at: plan.quote_sent_at || null,
      approved_number: plan.approved_quote_number || null,
    },
    invoices: ctx.invoices.map((inv) => ({
      invoice_number: inv.invoice_number,
      status: inv.status,
      total: inv.total,
      amount_due: inv.amount_due,
    })),
    crew: ctx.crew.map((c) => ({ name: c.name, scheduled_date: c.scheduled_date, status: c.status })),
    report_received_at: ctx.detail?.report_received_at || null,
    moves: RESTORATION_STAGES.filter((s) => s !== presented.stage).map((s) => {
      const refusal = restorationStageRefusal(s, facts);
      return {
        stage: s,
        label: RESTORATION_STAGE_LABELS[s],
        allowed: !refusal || s === "closed",
        needs: refusal?.message || null,
      };
    }),
    created_at: job.created_at || null,
    updated_at: job.updated_at || null,
  };
}

async function listRestorationJobs(
  client: any,
  orgId: string | null,
  options: { includeClosed: boolean },
): Promise<any[]> {
  let query = client.from("jobs").select(BOARD_JOB_COLUMNS)
    .in("type", ["makesafe", "insurance"])
    .or(
      "metadata->>makesafe_job_family.eq.restoration,metadata->>insurance_job_type.eq.restoration,metadata->>ses_family.eq.restoration",
    )
    .order("created_at", { ascending: false })
    .limit(500);
  if (orgId) query = query.eq("org_id", orgId);
  const { data, error } = await query;
  if (error) readFailed("The restoration jobs", error);
  return (data || []).filter((job: any) => {
    if (!isRestorationCard(job)) return false;
    const status = text(job.status).toLowerCase();
    if (status === "cancelled" || status === "lost") return options.includeClosed;
    return true;
  });
}

/** READ. Every restoration job, in its stage, with what it needs next. */
export async function restorationBoardAction(
  client: any,
  params: { include_closed?: unknown; job_id?: unknown; job_number?: unknown },
  caller: RestorationCaller,
): Promise<Record<string, unknown>> {
  const includeClosed = text(params.include_closed) === "1" ||
    text(params.include_closed) === "true";
  let jobs = await listRestorationJobs(client, caller.orgId, { includeClosed });
  const onlyId = text(params.job_id);
  const onlyNumber = text(params.job_number).toUpperCase();
  if (onlyId) jobs = jobs.filter((j) => j.id === onlyId);
  if (onlyNumber) jobs = jobs.filter((j) => text(j.job_number).toUpperCase() === onlyNumber);
  const contexts = await loadJobContexts(client, jobs.map((j) => j.id));
  let cards = jobs.map((job) => boardCard(job, contexts.get(job.id)!));
  // Closed cards stay on the board for 30 days after their last change.
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
  if (!includeClosed) {
    cards = cards.filter((c) =>
      c.stage !== "closed" || Date.parse(String(c.updated_at || "")) >= cutoff
    );
  }
  const columns = RESTORATION_STAGES.map((stage) => ({
    key: stage,
    label: RESTORATION_STAGE_LABELS[stage],
    count: cards.filter((c) => c.stage === stage).length,
  }));
  return {
    success: true,
    contract_version: "restoration-board/v1",
    generated_at: new Date().toISOString(),
    columns,
    cards,
  };
}

async function loadOneJob(client: any, selector: any, caller: RestorationCaller): Promise<any> {
  const jobId = text(selector?.job_id);
  const jobNumber = text(selector?.job_number).toUpperCase();
  if (!jobId && !jobNumber) fail("job_required", "job_id or job_number is required.");
  if (jobId && !UUID_RE.test(jobId)) fail("job_id_invalid", "job_id must be a job UUID.");
  let query = client.from("jobs").select(BOARD_JOB_COLUMNS);
  query = jobId ? query.eq("id", jobId) : query.eq("job_number", jobNumber);
  const { data: job, error } = await query.maybeSingle();
  if (error) readFailed("The job", error);
  if (!job || (caller.orgId && job.org_id && job.org_id !== caller.orgId)) {
    fail("job_not_found", "No job matched.", 404);
  }
  if (!isRestorationCard(job)) {
    fail(
      "not_a_restoration_job",
      `${job.job_number || "This job"} is not a restoration job. Set its family to Restoration first if that is what it is.`,
      409,
    );
  }
  return job;
}

async function writeStage(
  client: any,
  job: any,
  stage: RestorationStage,
  entry: { set_by: string; note: string | null; auto: boolean; now: string },
  from: { stage: RestorationStage; source: string },
): Promise<any> {
  const metadata = {
    ...record(job.metadata),
    restoration_stage: {
      stage,
      set_at: entry.now,
      set_by: entry.set_by,
      note: entry.note,
      auto: entry.auto,
    },
  };
  const status = RESTORATION_STAGE_JOB_STATUS[stage];
  const { data, error } = await client.from("jobs")
    .update({ metadata, status })
    .eq("id", job.id)
    .eq("updated_at", job.updated_at)
    .select(BOARD_JOB_COLUMNS);
  if (error) {
    fail(
      "restoration_stage_write_failed",
      `The stage could not be saved (${text(error.message) || "unknown database error"}).`,
      503,
    );
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    fail(
      "job_changed",
      `${job.job_number || "The job"} changed while this was being saved; nothing was written. Read it again and retry.`,
      409,
    );
  }
  try {
    const { error: eventError } = await client.from("job_events").insert({
      job_id: job.id,
      event_type: "restoration_stage_changed",
      detail_json: {
        from_stage: from.stage,
        from_source: from.source,
        to_stage: stage,
        job_status: status,
        prior_job_status: job.status || null,
        set_by: entry.set_by,
        note: entry.note,
        auto: entry.auto,
        changed_at: entry.now,
      },
    });
    if (eventError) console.error("[restoration] stage event not written:", eventError.message);
  } catch (e) {
    console.error("[restoration] stage event write threw:", e);
  }
  return row;
}

/** WRITE. Put a restoration card in a stage. */
export async function setRestorationStageAction(
  client: any,
  body: any,
  caller: RestorationCaller,
  deps: { now?: () => string } = {},
): Promise<Record<string, unknown>> {
  const target = text(body?.stage).toLowerCase();
  if (!isRestorationStage(target)) {
    fail(
      "restoration_stage_invalid",
      `stage must be one of: ${RESTORATION_STAGES.join(", ")}.`,
    );
  }
  const actor = text(caller.label) || text(body?.operator_email);
  if (!actor) {
    fail("operator_required", "Say who is doing this (operator_email), so the record names a person.");
  }
  const job = await loadOneJob(client, body, caller);
  const ctx = (await loadJobContexts(client, [job.id])).get(job.id)!;
  const { facts } = factsFor(job, ctx);
  const presented = presentRestorationStage(facts);
  if (presented.stage === target && presented.source === "set") {
    return { success: true, unchanged: true, card: boardCard(job, ctx) };
  }
  const refusal = restorationStageRefusal(target, facts, {
    no_charge_reason: body?.no_charge_reason,
  });
  if (refusal) fail(refusal.code, refusal.message, 409);
  const note = [text(body?.note), text(body?.no_charge_reason) && `No charge: ${text(body?.no_charge_reason)}`]
    .filter(Boolean).join(" | ") || null;
  const now = (deps.now || (() => new Date().toISOString()))();
  const written = await writeStage(client, job, target, { set_by: actor, note, auto: false, now }, {
    stage: presented.stage,
    source: presented.source,
  });
  return { success: true, card: boardCard(written, ctx) };
}

/**
 * Move the card on after a restoration action: the quote went out, the builder
 * approved, the invoice went out. Forward only, never throws: the action that
 * called it has already done its work, and a missed move is fixed on the board.
 */
export async function advanceRestorationStageAfter(
  client: any,
  jobId: string,
  trigger: RestorationStageTrigger,
  actorLabel: string,
): Promise<{ moved: boolean; stage?: RestorationStage; reason?: string }> {
  try {
    const { data: job, error } = await client.from("jobs").select(BOARD_JOB_COLUMNS)
      .eq("id", jobId).maybeSingle();
    if (error || !job || !isRestorationCard(job)) {
      return { moved: false, reason: error ? "job_unreadable" : "not_restoration" };
    }
    const ctx = (await loadJobContexts(client, [job.id])).get(job.id)!;
    const { facts } = factsFor(job, ctx);
    const presented = presentRestorationStage(facts);
    const target = restorationAutoAdvanceTarget(trigger, presented.stage, facts);
    if (!target) return { moved: false, stage: presented.stage, reason: "no_move" };
    await writeStage(client, job, target, {
      set_by: actorLabel || "restoration action",
      note: `Moved on ${trigger.replace(/_/g, " ")}.`,
      auto: true,
      now: new Date().toISOString(),
    }, { stage: presented.stage, source: presented.source });
    return { moved: true, stage: target };
  } catch (e) {
    console.error(`[restoration] stage advance after ${trigger} failed for ${jobId}:`, e);
    return { moved: false, reason: "advance_failed" };
  }
}
