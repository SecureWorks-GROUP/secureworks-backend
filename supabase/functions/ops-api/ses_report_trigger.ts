// SES trade-report-submitted trigger (CIO, 2026-09-11).
//
// One bounded handler for both the drain (webhook-style, one run id) and the
// manual command (inspection, reconciliation, or an explicit retry of one exact
// event). It never builds a pack itself: it claims a run from the durable
// ledger, re-reads the job and its current attendance cycle, refuses stale or
// conflicting work, and hands the one card to the existing
// prepare_ses_docket_revision path, which already carries the DRAFT authority,
// the invoice-identity guards and the exact-once docs-ready admin SMS.
//
// Contract: lanes/handoffs/INSURANCE-to-CIO-SES-trigger-contract-2026-09-10.md.
//
// States on public.ses_report_trigger_runs:
//   pending -> claimed -> done | refused_stale | refused_conflict | refused_gate | failed | unknown
// `failed` carries next_attempt_at and is re-claimable; `unknown` is parked for
// a human with a recovery_action and is never blindly replayed.

import type { SesPrepareRequest } from "./ses_docket_envelope.ts";
import type { SesPrepareResponse } from "./ses_prepare_docket_revision.ts";
import { SesAssemblerAdapterError } from "./ses_assembler_input_adapter.ts";

export const SES_REPORT_TRIGGER_VERSION = "ses.report-trigger/v1";
const MAX_ATTEMPTS = 6;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SesReportTriggerRun {
  id: string;
  dedupe_key: string;
  job_id: string;
  attendance_cycle_id: string | null;
  cycle_number: number | null;
  event_id: string | null;
  event_type: string;
  source: Record<string, unknown>;
  state: string;
  attempts: number;
  duplicate_events: number;
  next_attempt_at: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
  claim_token: string | null;
  lease_expires_at: string | null;
  last_error: string | null;
  recovery_action: string | null;
  docket_revision_id: string | null;
  output_content_hash: string | null;
  docs_ready_sms: unknown;
  result: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface SesReportTriggerDeps {
  // deno-lint-ignore no-explicit-any
  client: any;
  actor: string;
  /** The existing prepare path for ONE card, non-dry-run, with the docs-ready
   * notifier attached. Injected so the handler stays testable. */
  prepare: (request: SesPrepareRequest) => Promise<SesPrepareResponse & { docs_ready_sms?: unknown }>;
  now?: () => Date;
}

export class SesReportTriggerError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400, readonly detail?: Record<string, unknown>) {
    super(message);
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

function backoffSeconds(attempts: number): number {
  return Math.min(3600, 60 * Math.pow(2, Math.max(0, attempts - 1)));
}

async function readRun(client: any, id: string): Promise<SesReportTriggerRun | null> {
  const { data, error } = await client.from("ses_report_trigger_runs").select("*").eq("id", id).maybeSingle();
  if (error) throw new SesReportTriggerError("ses_trigger_ledger_unavailable", `run read failed: ${error.message || error}`, 503);
  return (data as SesReportTriggerRun) || null;
}

/** CAS transition: only the holder of THIS claim moves the row. The per-claim
 * token minted by claim_ses_report_trigger_run is the key, so a late worker
 * whose lease expired cannot overwrite a newer claim that shares its actor. */
async function transition(client: any, run: SesReportTriggerRun, patch: Record<string, unknown>) {
  if (!run.claim_token) throw new SesReportTriggerError("ses_trigger_lease_lost", "The run carries no claim token; refusing to transition.", 409);
  const { data, error } = await client.from("ses_report_trigger_runs")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", run.id).eq("state", "claimed").eq("claim_token", run.claim_token)
    .select("*").maybeSingle();
  if (error) throw new SesReportTriggerError("ses_trigger_ledger_unavailable", `run transition failed: ${error.message || error}`, 503);
  if (!data) throw new SesReportTriggerError("ses_trigger_lease_lost", "The run lease was lost before the transition; nothing further was written.", 409);
  return data as SesReportTriggerRun;
}

/**
 * Manual entry: file (or find) the run for one exact job and cycle, then
 * process it. The identity is explicit so a human cannot ask for "the latest
 * document" by accident.
 */
async function fileManualRun(client: any, body: Record<string, unknown>): Promise<string> {
  const jobId = text(body.job_id);
  const cycleId = text(body.attendance_cycle_id);
  const identity = text(body.source_identity);
  if (!UUID.test(jobId)) throw new SesReportTriggerError("ses_trigger_job_id_required", "job_id must be an exact job UUID.");
  if (!UUID.test(cycleId)) throw new SesReportTriggerError("ses_trigger_cycle_required", "attendance_cycle_id must be the exact current attendance cycle UUID.");
  if (!identity) throw new SesReportTriggerError("ses_trigger_source_identity_required", "source_identity is required (for example report:<report_id> or roof:<doc_id>:<render_hash>).");
  const key = `${jobId}:${cycleId}:${identity}`;
  const existing = await client.from("ses_report_trigger_runs").select("id, state").eq("dedupe_key", key).maybeSingle();
  if (existing.error) throw new SesReportTriggerError("ses_trigger_ledger_unavailable", `run lookup failed: ${existing.error.message || existing.error}`, 503);
  if (existing.data?.id) {
    // Explicit refile: a human moves a refused or parked run back to pending,
    // with their name on it. Never done rows; never implicit.
    if (body.refile === true && ["refused_stale", "refused_conflict", "refused_gate", "failed", "unknown"].includes(String(existing.data.state))) {
      const refiled = await client.from("ses_report_trigger_runs")
        .update({ state: "pending", next_attempt_at: null, claimed_by: null, claim_token: null, lease_expires_at: null, last_error: null,
          recovery_action: null, completed_at: null, updated_at: new Date().toISOString(),
          result: { refiled: { by: text(body.actor) || "manual", at: new Date().toISOString(), from_state: existing.data.state } } })
        .eq("id", existing.data.id).eq("state", existing.data.state).select("id").maybeSingle();
      if (refiled.error) throw new SesReportTriggerError("ses_trigger_ledger_unavailable", `refile failed: ${refiled.error.message || refiled.error}`, 503);
      if (!refiled.data) throw new SesReportTriggerError("ses_trigger_refile_raced", "The run changed state before the refile; read it again.", 409);
    } else if (body.refile === true) {
      throw new SesReportTriggerError("ses_trigger_refile_not_allowed", `A run in state ${existing.data.state} cannot be refiled.`, 409, { state: existing.data.state });
    }
    return existing.data.id as string;
  }
  const inserted = await client.from("ses_report_trigger_runs").insert({
    dedupe_key: key, job_id: jobId, attendance_cycle_id: cycleId, event_type: "manual",
    source: { kind: "manual", identity, filed_by: text(body.actor) || "manual" }, state: "pending",
  }).select("id").single();
  if (inserted.error) throw new SesReportTriggerError("ses_trigger_ledger_unavailable", `run insert failed: ${inserted.error.message || inserted.error}`, 503);
  return inserted.data.id as string;
}

export async function runSesReportTrigger(
  body: Record<string, unknown>,
  deps: SesReportTriggerDeps,
): Promise<Record<string, unknown>> {
  const now = deps.now ?? (() => new Date());
  const { client } = deps;
  const runId = text(body.run_id) || await fileManualRun(client, body);
  if (!UUID.test(runId)) throw new SesReportTriggerError("ses_trigger_run_id_invalid", "run_id must be a UUID.");

  // 1. Exclusive bounded claim.
  const claimed = await client.rpc("claim_ses_report_trigger_run", { p_run_id: runId, p_owner: deps.actor, p_lease_seconds: 300 });
  if (claimed.error) throw new SesReportTriggerError("ses_trigger_ledger_unavailable", `claim failed: ${claimed.error.message || claimed.error}`, 503);
  const rows: SesReportTriggerRun[] = Array.isArray(claimed.data) ? claimed.data : claimed.data ? [claimed.data] : [];
  if (rows.length === 0) {
    const current = await readRun(client, runId);
    return {
      version: SES_REPORT_TRIGGER_VERSION, ok: false, code: "ses_trigger_run_not_claimable",
      state: current?.state ?? "missing",
      reason: !current ? "no such run" : current.state === "done" ? "already built for this identity" : current.state === "claimed" ? "another worker holds the lease" : `terminal state ${current.state}; re-file manually with the exact identity if it should run again`,
      run: current,
    };
  }
  let run = rows[0];

  try {
    // 2. Re-read the job and its CURRENT attendance cycle before any effect.
    const job = await client.from("jobs").select("id, job_number, type, status").eq("id", run.job_id).maybeSingle();
    if (job.error || !job.data) throw new SesReportTriggerError("ses_trigger_job_missing", "The job could not be read.", 404);
    const cycle = await client.from("makesafe_attendance_cycles").select("id, cycle_number")
      .eq("job_id", run.job_id).order("cycle_number", { ascending: false }).limit(1).maybeSingle();
    if (cycle.error) throw new SesReportTriggerError("ses_trigger_ledger_unavailable", `cycle read failed: ${cycle.error.message || cycle.error}`, 503);
    const currentCycle = cycle.data as { id: string; cycle_number: number } | null;
    if (!currentCycle) {
      run = await transition(client, run, { state: "refused_gate", last_error: "no attendance cycle on this job", recovery_action: "open the attendance cycle in the board, then re-file this identity", completed_at: now().toISOString() });
      return receipt(run, "refused");
    }
    if (run.attendance_cycle_id && run.attendance_cycle_id !== currentCycle.id) {
      run = await transition(client, run, {
        state: "refused_stale", last_error: `event cycle ${run.attendance_cycle_id} is not the current cycle ${currentCycle.id}`,
        recovery_action: "no action; the report belongs to a closed cycle. If the current cycle needs a pack, its own submission will file a run.", completed_at: now().toISOString(),
      });
      return receipt(run, "refused");
    }
    if (!run.attendance_cycle_id) {
      run = await transition(client, run, { attendance_cycle_id: currentCycle.id, cycle_number: currentCycle.cycle_number });
    }

    // 3. Conflict: a different source identity already built this job+cycle.
    const sibling = await client.from("ses_report_trigger_runs").select("id, dedupe_key, state, docket_revision_id")
      .eq("job_id", run.job_id).eq("attendance_cycle_id", currentCycle.id).eq("state", "done").neq("id", run.id).limit(1).maybeSingle();
    if (sibling.error) throw new SesReportTriggerError("ses_trigger_ledger_unavailable", `sibling read failed: ${sibling.error.message || sibling.error}`, 503);
    if (sibling.data) {
      run = await transition(client, run, {
        state: "refused_conflict", last_error: `cycle already built from ${sibling.data.dedupe_key} (docket ${sibling.data.docket_revision_id})`,
        recovery_action: "reconcile: INSURANCE decides whether this later submission supersedes the built docket; if so prepare a revision manually", completed_at: now().toISOString(),
      });
      return receipt(run, "refused");
    }

    // 4. Hand the one card to the existing prepare path. Idempotency key is the
    //    dedupe key so a retry of this exact run cannot mint a second docket.
    const request: SesPrepareRequest = {
      selection: { mode: "job_id", job_id: run.job_id },
      dry_run: false,
      idempotency_key: run.dedupe_key,
      assembler_version: "ses-pack-assembler/v1",
    } as SesPrepareRequest;
    let response: Awaited<ReturnType<SesReportTriggerDeps["prepare"]>>;
    try {
      response = await deps.prepare(request);
    } catch (error) {
      if (error instanceof SesAssemblerAdapterError) {
        run = await transition(client, run, {
          state: "refused_gate", last_error: `${error.code}: ${error.message}`.slice(0, 500),
          recovery_action: "the pack path refused on its own gate; fix the named condition on the card, then re-file this identity", completed_at: now().toISOString(),
          result: { refusal: { code: error.code, status: error.status } },
        });
        return receipt(run, "refused");
      }
      throw error;
    }
    const result = (response.results || [])[0];
    if (!result) {
      run = await transition(client, run, { state: "refused_gate", last_error: "prepare returned no result for this job", recovery_action: "check the job is on the make-safe board; re-file if so", completed_at: now().toISOString() });
      return receipt(run, "refused");
    }
    const spineCycle = (result as any)?.envelope?.spine?.current_attendance_cycle_id as string | undefined;
    if (spineCycle && spineCycle !== currentCycle.id) {
      // The assembler saw a different cycle than the pre-read: something moved between reads.
      run = await transition(client, run, {
        state: "unknown", last_error: `assembler cycle ${spineCycle} differs from pre-read ${currentCycle.id}`,
        recovery_action: "read back the docket by dedupe key; if it was persisted for the right cycle mark done, otherwise re-file",
        docket_revision_id: result.docket_revision_id ?? null, output_content_hash: result.output_content_hash ?? null,
      });
      return receipt(run, "unknown");
    }
    if (result.state === "ready" && result.persisted) {
      run = await transition(client, run, {
        state: "done", docket_revision_id: result.docket_revision_id, output_content_hash: result.output_content_hash,
        docs_ready_sms: response.docs_ready_sms ?? null, last_error: null, recovery_action: null, completed_at: now().toISOString(),
        result: { state: result.state, artifacts: (result.artifacts || []).map((a: any) => ({ role: a.role, content_hash: a.content_hash, size_bytes: a.size_bytes })) },
      });
      return receipt(run, "done");
    }
    // Blocked or not persisted: the pack path's own gate said no. Terminal for this identity.
    run = await transition(client, run, {
      state: "refused_gate", last_error: `prepare state ${result.state}, persisted ${result.persisted}`.slice(0, 500),
      recovery_action: "clear the blockers on the card (see result.blockers), then re-file this identity",
      result: { state: result.state, persisted: result.persisted, blockers: (result as any).blockers ?? null }, completed_at: now().toISOString(),
    });
    return receipt(run, "refused");
  } catch (error) {
    if (error instanceof SesReportTriggerError && error.code === "ses_trigger_lease_lost") throw error;
    // Transport, timeout or unexpected failure after the claim. The effect may or
    // may not have happened inside the prepare path; the ledger says so honestly.
    const detail = (error as Error)?.message || String(error);
    const attempts = run.attempts;
    const patch = attempts >= MAX_ATTEMPTS
      ? { state: "unknown", last_error: detail.slice(0, 500), recovery_action: "attempts exhausted: read back the docket by dedupe key, then mark done or re-file" }
      : { state: "failed", last_error: detail.slice(0, 500), recovery_action: "automatic retry", next_attempt_at: new Date(now().getTime() + backoffSeconds(attempts) * 1000).toISOString() };
    try { run = await transition(client, run, patch); } catch { /* lease lost while recording; the row still shows claimed with an expired lease and will be reclaimed */ }
    return receipt(run, patch.state === "unknown" ? "unknown" : "failed", detail);
  }
}

function receipt(run: SesReportTriggerRun, outcome: string, detail?: string): Record<string, unknown> {
  return {
    version: SES_REPORT_TRIGGER_VERSION, ok: outcome === "done", outcome, state: run.state,
    run: {
      id: run.id, dedupe_key: run.dedupe_key, job_id: run.job_id, attendance_cycle_id: run.attendance_cycle_id, cycle_number: run.cycle_number,
      event_type: run.event_type, source: run.source, attempts: run.attempts, duplicate_events: run.duplicate_events,
      docket_revision_id: run.docket_revision_id, output_content_hash: run.output_content_hash, docs_ready_sms: run.docs_ready_sms,
      last_error: run.last_error, recovery_action: run.recovery_action, next_attempt_at: run.next_attempt_at, completed_at: run.completed_at,
    },
    ...(detail ? { detail } : {}),
    note: "A done run means the docket revision was persisted through the existing prepare path and the docs-ready ping went through its own exact-once effect. No client send occurs here.",
  };
}

/** Pending-work view: every run that is not done, with age and the exact recovery action. */
export async function listSesReportTriggerRuns(
  params: URLSearchParams,
  client: any,
  now: () => Date = () => new Date(),
): Promise<Record<string, unknown>> {
  const includeDone = params.get("include_done") === "true";
  const limitRaw = Number(params.get("limit") || 50);
  const limit = Number.isSafeInteger(limitRaw) && limitRaw >= 1 && limitRaw <= 200 ? limitRaw : 50;
  let query = client.from("ses_report_trigger_runs").select("*").order("created_at", { ascending: true }).limit(limit);
  if (!includeDone) query = query.neq("state", "done");
  const jobId = text(params.get("job_id"));
  if (jobId) query = query.eq("job_id", jobId);
  const { data, error } = await query;
  if (error) throw new SesReportTriggerError("ses_trigger_ledger_unavailable", `list failed: ${error.message || error}`, 503);
  const rows = (data as SesReportTriggerRun[]) || [];
  const t = now().getTime();
  const drain = await readSesReportDrainState(client);
  return {
    version: SES_REPORT_TRIGGER_VERSION, ok: true, count: rows.length, include_done: includeDone, retrieved_at: now().toISOString(),
    drain,
    runs: rows.map((r) => ({
      id: r.id, dedupe_key: r.dedupe_key, job_id: r.job_id, attendance_cycle_id: r.attendance_cycle_id, cycle_number: r.cycle_number,
      event_type: r.event_type, source: r.source, state: r.state, attempts: r.attempts, duplicate_events: r.duplicate_events,
      age_seconds: Math.max(0, Math.round((t - Date.parse(r.created_at)) / 1000)),
      claimed_by: r.claimed_by, lease_expires_at: r.lease_expires_at, next_attempt_at: r.next_attempt_at,
      last_error: r.last_error, recovery_action: r.recovery_action, docket_revision_id: r.docket_revision_id, completed_at: r.completed_at,
    })),
    coverage: "public.ses_report_trigger_runs only; job_events is audit and is not read here",
  };
}

export const SES_REPORT_DRAIN_NOTE =
  "A cron run marked succeeded means the drain query ran and a post was queued; it does not prove ops-api processed the run.";

export interface SesReportDrainCronJob {
  jobid: number | null;
  jobname: string | null;
  schedule: string | null;
  active: boolean | null;
  username: string | null;
  command_preview: string | null;
}

export interface SesReportDrainHttpResponse {
  id: number | null;
  status_code: number | null;
  content_preview: string | null;
  created: string | null;
  timed_out: boolean | null;
  error_msg: string | null;
}

export interface SesReportCronSchedulerPulse {
  jobid: number | null;
  jobname: string | null;
  schedule: string | null;
  active: boolean | null;
  username: string | null;
  last_start_time: string | null;
  last_status: string | null;
}

export interface SesReportDrainCronVisibility {
  pg_cron_present: boolean | null;
  cron_run_details_present: boolean | null;
  /** The role every reader here sees pg_cron through (the functions' owner). */
  definer_role: string | null;
  definer_bypasses_rls: boolean | null;
  /** true when a plain SELECT on cron.job raised insufficient_privilege; null when pg_cron is absent. */
  cron_job_select_denied: boolean | null;
}

/** What an empty cron_job / scheduler_pulse actually means, given cron_visibility. */
export const SES_REPORT_DRAIN_VISIBILITY_NOTE =
  "An empty cron_job or scheduler_pulse is only 'the job is not scheduled' when cron_visibility says pg_cron_present true, cron_job_select_denied false and definer_bypasses_rls true. With definer_bypasses_rls false it may instead be scheduled under another database role and hidden by pg_cron row security.";

export interface SesReportDrainState {
  /** true/false from public.ses_report_trigger_settings; null when it could not be read. */
  drain_enabled: boolean | null;
  settings_row_present: boolean | null;
  updated_at: string | null;
  updated_by: string | null;
  settings_error: string | null;
  /** Newest first. Empty when the cron job has not run or pg_cron is absent; null when unreadable. */
  recent_cron_runs: Array<{ status: string | null; return_message: string | null; start_time: string | null; end_time: string | null }> | null;
  cron_runs_error: string | null;
  /**
   * cron.job rows named ses-report-trigger-drain visible to the database role that
   * owns the reader. Empty means no such job for that role (unscheduled, pg_cron
   * absent, or owned by another role and hidden by pg_cron row security); null when unreadable.
   */
  cron_job: SesReportDrainCronJob[] | null;
  cron_job_error: string | null;
  /** Every visible job_run_details row for that jobname; null when pg_cron is absent or not permitted. */
  cron_run_count: number | null;
  cron_run_count_error: string | null;
  /** Latest net._http_response rows overall, newest first; null when unreadable. */
  recent_http_responses: SesReportDrainHttpResponse[] | null;
  http_responses_error: string | null;
  http_responses_scope: string;
  /**
   * Every cron.job row visible to the reader's database role with its newest run,
   * newest first. If every job's last run is old the whole pg_cron scheduler
   * stopped, not just the drain. Empty when pg_cron is absent or every job is
   * hidden by pg_cron row security; null when unreadable.
   */
  scheduler_pulse: SesReportCronSchedulerPulse[] | null;
  scheduler_pulse_error: string | null;
  /** Tells absent pg_cron, an unreadable cron schema and row-security hiding apart. Null when unreadable. */
  cron_visibility: SesReportDrainCronVisibility | null;
  cron_visibility_error: string | null;
  visibility_note: string;
  gate: string;
  cron_job_name: string;
  note: string;
}

type DrainRow = Record<string, unknown>;

function drainRows(data: unknown): DrainRow[] {
  return Array.isArray(data) ? (data as DrainRow[]) : [];
}

// deno-lint-ignore no-explicit-any
async function readDrainRpc(client: any, name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: string | null }> {
  try {
    const { data, error } = await client.rpc(name, args);
    if (error) return { data: null, error: String(error.message || error) };
    return { data, error: null };
  } catch (error) {
    return { data: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Observable drain state for the pending list: the drain's own enable flag, the
 * pg_cron job row, its recent runs and visible run count, and the latest pg_net
 * responses. Each read reports its own error and never fails the list itself.
 */
export async function readSesReportDrainState(client: any): Promise<SesReportDrainState> {
  const out: SesReportDrainState = {
    drain_enabled: null, settings_row_present: null, updated_at: null, updated_by: null, settings_error: null,
    recent_cron_runs: null, cron_runs_error: null,
    cron_job: null, cron_job_error: null,
    cron_run_count: null, cron_run_count_error: null,
    recent_http_responses: null, http_responses_error: null,
    scheduler_pulse: null, scheduler_pulse_error: null,
    cron_visibility: null, cron_visibility_error: null,
    visibility_note: SES_REPORT_DRAIN_VISIBILITY_NOTE,
    http_responses_scope:
      "Latest net._http_response rows from every pg_net caller. pg_net does not keep the request URL with a response, so a row here is not proven to be a drain post. pg_net deletes responses after its TTL (6 hours by default).",
    gate: "public.ses_report_drain_enabled() (public.ses_report_trigger_settings.drain_enabled; missing row = off)",
    cron_job_name: "ses-report-trigger-drain",
    note: SES_REPORT_DRAIN_NOTE,
  };
  try {
    const { data, error } = await client.from("ses_report_trigger_settings")
      .select("drain_enabled, updated_at, updated_by").eq("id", true).maybeSingle();
    if (error) {
      out.settings_error = String(error.message || error);
    } else if (!data) {
      // Mirrors the SQL helper: a missing row means the drain is off.
      out.drain_enabled = false;
      out.settings_row_present = false;
    } else {
      out.drain_enabled = data.drain_enabled === true;
      out.settings_row_present = true;
      out.updated_at = data.updated_at ?? null;
      out.updated_by = data.updated_by ?? null;
    }
  } catch (error) {
    out.settings_error = error instanceof Error ? error.message : String(error);
  }

  const [runs, job, count, http, pulse, visibility] = await Promise.all([
    readDrainRpc(client, "ses_report_drain_cron_runs", { p_limit: 5 }),
    readDrainRpc(client, "ses_report_drain_cron_job", {}),
    readDrainRpc(client, "ses_report_drain_cron_run_count", {}),
    readDrainRpc(client, "ses_report_drain_http_responses", { p_limit: 5 }),
    readDrainRpc(client, "ses_report_cron_scheduler_pulse", { p_limit: 30 }),
    readDrainRpc(client, "ses_report_drain_cron_visibility", {}),
  ]);

  if (runs.error !== null) {
    out.cron_runs_error = runs.error;
  } else {
    out.recent_cron_runs = drainRows(runs.data).map((r) => ({
      status: (r.status as string) ?? null, return_message: (r.return_message as string) ?? null,
      start_time: (r.start_time as string) ?? null, end_time: (r.end_time as string) ?? null,
    }));
  }

  if (job.error !== null) {
    out.cron_job_error = job.error;
  } else {
    out.cron_job = drainRows(job.data).map((r) => ({
      jobid: (r.jobid as number) ?? null, jobname: (r.jobname as string) ?? null, schedule: (r.schedule as string) ?? null,
      active: (r.active as boolean) ?? null, username: (r.username as string) ?? null, command_preview: (r.command_preview as string) ?? null,
    }));
  }

  if (count.error !== null) {
    out.cron_run_count_error = count.error;
  } else if (count.data !== null && count.data !== undefined) {
    // bigint may arrive as a number or a numeric string. null stays null and means
    // pg_cron is absent; -1 is the reader's sentinel for "this role may not read
    // cron.job_run_details" and is reported as an error, not as a count.
    const n = Number(count.data);
    if (!Number.isFinite(n)) {
      out.cron_run_count = null;
    } else if (n === -1) {
      out.cron_run_count_error =
        "insufficient_privilege: the reader's database role may not SELECT cron.job_run_details (missing grant, or pg_cron row security). Not the same as pg_cron being absent, which reads as a null count with no error.";
    } else {
      out.cron_run_count = n;
    }
  }

  if (http.error !== null) {
    out.http_responses_error = http.error;
  } else {
    out.recent_http_responses = drainRows(http.data).map((r) => ({
      id: (r.id as number) ?? null, status_code: (r.status_code as number) ?? null, content_preview: (r.content_preview as string) ?? null,
      created: (r.created as string) ?? null, timed_out: (r.timed_out as boolean) ?? null, error_msg: (r.error_msg as string) ?? null,
    }));
  }

  if (pulse.error !== null) {
    out.scheduler_pulse_error = pulse.error;
  } else {
    out.scheduler_pulse = drainRows(pulse.data).map((r) => ({
      jobid: (r.jobid as number) ?? null, jobname: (r.jobname as string) ?? null, schedule: (r.schedule as string) ?? null,
      active: (r.active as boolean) ?? null, username: (r.username as string) ?? null,
      last_start_time: (r.last_start_time as string) ?? null, last_status: (r.last_status as string) ?? null,
    }));
  }

  if (visibility.error !== null) {
    out.cron_visibility_error = visibility.error;
  } else {
    // The function always returns exactly one row; PostgREST hands back an array.
    const row = drainRows(visibility.data)[0];
    out.cron_visibility = row === undefined ? null : {
      pg_cron_present: (row.pg_cron_present as boolean) ?? null,
      cron_run_details_present: (row.cron_run_details_present as boolean) ?? null,
      definer_role: (row.definer_role as string) ?? null,
      definer_bypasses_rls: (row.definer_bypasses_rls as boolean) ?? null,
      cron_job_select_denied: (row.cron_job_select_denied as boolean) ?? null,
    };
  }

  return out;
}
