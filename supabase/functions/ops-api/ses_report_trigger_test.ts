// deno-lint-ignore-file no-import-prefix no-explicit-any require-await
//
// SES report-submitted trigger handler (CIO, 2026-09-11).
//
// Pins:
//   1. A pending run is claimed exclusively, the job and current cycle are re-read,
//      one card goes to the existing prepare path with the dedupe key as
//      idempotency key, and a ready+persisted result marks the run done with the
//      docket id, output hash and the docs-ready SMS outcome.
//   2. A run whose event cycle is no longer current is refused_stale, nothing prepared.
//   3. A second done run for the same job+cycle from another identity is refused_conflict.
//   4. The prepare path's own refusal (adapter error) or a blocked result is refused_gate.
//   5. A transport failure after the claim parks the run failed with backoff; after
//      the attempt ceiling it parks unknown with a recovery action; never replayed blindly.
//   6. An unclaimable run (done, leased, terminal, missing) returns the honest state.
//   7. The manual entry requires exact job, cycle and source identity and reuses an existing run.
//   8. The pending list excludes done rows and reports age and recovery action.
//  12. The pending list reports the drain's own enable flag and recent cron runs,
//      fails closed on a missing settings row, and never fails on a drain read error.
//  15. The drain status says which "empty" it is: pg_cron absent, cron.job unreadable,
//      or a definer that does not bypass row security. A -1 run count is reported as
//      an insufficient_privilege error, not as a count and not as "pg_cron absent".
//  14. The drain status carries the whole-scheduler pulse: every visible cron job with
//      its newest run, newest first, so a stopped pg_cron is distinguishable from one
//      stopped job. Its read error is its own field.
//  13. The drain status carries the pg_cron job rows, the visible run count, the latest
//      pg_net responses and the "succeeded is not processed" note; each read reports
//      its own error (or thrown exception) and never fails the list.

import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { listSesReportTriggerRuns, runSesReportTrigger, SesReportTriggerError } from "./ses_report_trigger.ts";
import { SesAssemblerAdapterError } from "./ses_assembler_input_adapter.ts";

const JOB = "70000000-0000-4000-8000-000000000001";
const CYCLE1 = "72000000-0000-4000-8000-000000000001";
const CYCLE2 = "72000000-0000-4000-8000-000000000002";
const RUN = "75000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-09-11T03:00:00.000Z");

function baseRun(overrides: any = {}): any {
  return {
    id: RUN, dedupe_key: `${JOB}:${CYCLE1}:report:r1`, job_id: JOB, attendance_cycle_id: CYCLE1, cycle_number: 1,
    event_id: "71000000-0000-4000-8000-000000000001", event_type: "makesafe_report_submitted", source: { kind: "makesafe_report", report_id: "r1" },
    state: "pending", attempts: 0, duplicate_events: 0, next_attempt_at: null, claimed_by: null, claimed_at: null, lease_expires_at: null,
    last_error: null, recovery_action: null, docket_revision_id: null, output_content_hash: null, docs_ready_sms: null, result: {},
    created_at: "2026-09-11T02:00:00.000Z", updated_at: "2026-09-11T02:00:00.000Z", completed_at: null, ...overrides,
  };
}

type Fixture = {
  runs: Record<string, any>;
  cycles: Array<{ id: string; cycle_number: number }>;
  job?: any;
  siblings?: any[];
  claimable?: boolean;
  /** Simulate a second worker reclaiming the row (new token) right after our claim. */
  stealClaimAfterClaim?: boolean;
  /** Drain flag row; undefined = default enabled row, null = row missing. */
  drainSettings?: any;
  drainSettingsError?: string;
  cronRuns?: any[];
  cronRunsError?: string;
  cronJob?: any[];
  cronJobError?: string;
  /** undefined = 0, null = pg_cron absent or not permitted. */
  cronRunCount?: any;
  cronRunCountError?: string;
  httpResponses?: any[];
  httpResponsesError?: string;
  /** Make the rpc call itself throw, to prove the list survives an exception. */
  httpResponsesThrow?: string;
  schedulerPulse?: any[];
  schedulerPulseError?: string;
  /** undefined = a default readable row; null = the rpc returned no row at all. */
  cronVisibility?: any;
  cronVisibilityError?: string;
};

/** A tiny query-builder stand-in that records writes and answers the reads the handler makes. */
function fakeClient(fx: Fixture) {
  const writes: any[] = [];
  const client = {
    rpc(name: string, args: any) {
      if (name === "ses_report_drain_cron_runs") {
        assertEquals(args, { p_limit: 5 });
        if (fx.cronRunsError) return Promise.resolve({ data: null, error: { message: fx.cronRunsError } });
        return Promise.resolve({ data: fx.cronRuns ?? [], error: null });
      }
      if (name === "ses_report_drain_cron_job") {
        assertEquals(args, {});
        if (fx.cronJobError) return Promise.resolve({ data: null, error: { message: fx.cronJobError } });
        return Promise.resolve({ data: fx.cronJob ?? [], error: null });
      }
      if (name === "ses_report_drain_cron_run_count") {
        assertEquals(args, {});
        if (fx.cronRunCountError) return Promise.resolve({ data: null, error: { message: fx.cronRunCountError } });
        return Promise.resolve({ data: fx.cronRunCount === undefined ? 0 : fx.cronRunCount, error: null });
      }
      if (name === "ses_report_drain_cron_visibility") {
        assertEquals(args, {});
        if (fx.cronVisibilityError) return Promise.resolve({ data: null, error: { message: fx.cronVisibilityError } });
        if (fx.cronVisibility === null) return Promise.resolve({ data: [], error: null });
        return Promise.resolve({
          data: [fx.cronVisibility ?? { pg_cron_present: true, cron_run_details_present: true, definer_role: "postgres", definer_bypasses_rls: true, cron_job_select_denied: false }],
          error: null,
        });
      }
      if (name === "ses_report_cron_scheduler_pulse") {
        assertEquals(args, { p_limit: 30 });
        if (fx.schedulerPulseError) return Promise.resolve({ data: null, error: { message: fx.schedulerPulseError } });
        return Promise.resolve({ data: fx.schedulerPulse ?? [], error: null });
      }
      if (name === "ses_report_drain_http_responses") {
        assertEquals(args, { p_limit: 5 });
        if (fx.httpResponsesThrow) throw new Error(fx.httpResponsesThrow);
        if (fx.httpResponsesError) return Promise.resolve({ data: null, error: { message: fx.httpResponsesError } });
        return Promise.resolve({ data: fx.httpResponses ?? [], error: null });
      }
      assertEquals(name, "claim_ses_report_trigger_run");
      const run = fx.runs[args.p_run_id];
      const claimable = fx.claimable ?? (run && (run.state === "pending" || (run.state === "failed" && (!run.next_attempt_at || Date.parse(run.next_attempt_at) <= NOW.getTime()))));
      if (!run || !claimable) return Promise.resolve({ data: [], error: null });
      Object.assign(run, { state: "claimed", attempts: run.attempts + 1, claimed_by: args.p_owner, claimed_at: NOW.toISOString(),
        claim_token: `token-${run.attempts + 1}`, lease_expires_at: new Date(NOW.getTime() + 600_000).toISOString() });
      const snapshot = { ...run };
      if (fx.stealClaimAfterClaim) Object.assign(run, { claim_token: "token-stolen", claimed_by: args.p_owner });
      return Promise.resolve({ data: [snapshot], error: null });
    },
    from(table: string) {
      const q: any = { _table: table, _filters: [] as any[], _op: "select", _patch: null as any, _order: null as any, _limit: null as any };
      const chain = (fn: (x: any) => void) => (...a: any[]) => { fn(a); return q; };
      q.select = chain(() => {});
      q.eq = chain((a) => q._filters.push(["eq", a[0], a[1]]));
      q.neq = chain((a) => q._filters.push(["neq", a[0], a[1]]));
      q.order = chain((a) => { q._order = a; });
      q.limit = chain((a) => { q._limit = a[0]; });
      q.update = chain((a) => { q._op = "update"; q._patch = a[0]; });
      q.insert = chain((a) => { q._op = "insert"; q._patch = a[0]; });
      q.single = () => q.maybeSingle();
      const run = () => {
        if (table === "jobs") return { data: fx.job === undefined ? { id: JOB, job_number: "SWMS-261403", type: "makesafe", status: "scheduled" } : fx.job, error: null };
        if (table === "ses_report_trigger_settings") {
          if (fx.drainSettingsError) return { data: null, error: { message: fx.drainSettingsError } };
          const row = fx.drainSettings === undefined ? { drain_enabled: true, updated_at: "2026-09-11T09:00:00.000Z", updated_by: "migration" } : fx.drainSettings;
          return { data: row, error: null };
        }
        if (table === "makesafe_attendance_cycles") {
          const sorted = [...fx.cycles].sort((a, b) => b.cycle_number - a.cycle_number);
          return { data: sorted[0] ?? null, error: null };
        }
        if (table === "ses_report_trigger_runs") {
          if (q._op === "update") {
            const id = q._filters.find((f: any) => f[1] === "id")?.[2];
            const row = fx.runs[id];
            const stateOk = q._filters.every((f: any) => f[0] !== "eq" || f[1] === "id" || row?.[f[1]] === f[2]);
            if (!row || !stateOk) return { data: null, error: null };
            Object.assign(row, q._patch);
            writes.push({ id, patch: q._patch });
            return { data: { ...row }, error: null };
          }
          if (q._op === "insert") {
            const id = "76000000-0000-4000-8000-00000000000" + (Object.keys(fx.runs).length + 1);
            fx.runs[id] = baseRun({ id, ...q._patch });
            writes.push({ insert: q._patch });
            return { data: { id }, error: null };
          }
          const key = q._filters.find((f: any) => f[1] === "dedupe_key")?.[2];
          if (key) { const hit = Object.values(fx.runs).find((r: any) => r.dedupe_key === key); return { data: hit ? { id: hit.id, state: hit.state } : null, error: null }; }
          const stateEq = q._filters.find((f: any) => f[0] === "eq" && f[1] === "state")?.[2];
          if (stateEq === "done") { const s = (fx.siblings || [])[0]; return { data: s ?? null, error: null }; }
          const id = q._filters.find((f: any) => f[1] === "id")?.[2];
          if (id) return { data: fx.runs[id] ? { ...fx.runs[id] } : null, error: null };
          const stateNe = q._filters.find((f: any) => f[0] === "neq" && f[1] === "state")?.[2];
          const rows = Object.values(fx.runs).filter((r: any) => !stateNe || r.state !== stateNe);
          return { data: rows, error: null };
        }
        throw new Error(`unexpected table ${table}`);
      };
      q.maybeSingle = () => Promise.resolve(run());
      q.then = (res: any, rej: any) => Promise.resolve(run()).then(res, rej);
      return q;
    },
  };
  return { client, writes };
}

function readyResponse(cycle = CYCLE1): any {
  return {
    action: "prepare_ses_docket_revision", assembler_version: "ses-pack-assembler/v1", dry_run: false,
    results: [{ state: "ready", persisted: true, docket_revision_id: "b308e68a-4435-5789-b843-59de3837cdc1", input_content_hash: "sha256:in", output_content_hash: "sha256:out",
      envelope: { spine: { job_id: JOB, current_attendance_cycle_id: cycle } }, artifacts: [{ role: "report", content_hash: "sha256:r", size_bytes: 10 }], review_spec: {} }],
    timing_summary: { count: 1, max_ms: 1, p95_ms: 1, all_within_five_minutes: true },
    docs_ready_sms: [{ job_id: JOB, outcome: "sent" }],
  };
}

Deno.test("1. pending run: claim, re-read, prepare one card with the dedupe key, mark done", async () => {
  const fx: Fixture = { runs: { [RUN]: baseRun() }, cycles: [{ id: CYCLE1, cycle_number: 1 }] };
  const { client, writes } = fakeClient(fx);
  const prepared: any[] = [];
  const out = await runSesReportTrigger({ run_id: RUN }, { client, actor: "test-drain", now: () => NOW, prepare: async (req) => { prepared.push(req); return readyResponse(); } });
  assertEquals(out.ok, true);
  assertEquals(out.outcome, "done");
  assertEquals(prepared.length, 1);
  assertEquals(prepared[0].selection, { mode: "job_id", job_id: JOB });
  assertEquals(prepared[0].dry_run, false);
  assertEquals(prepared[0].idempotency_key, `${JOB}:${CYCLE1}:report:r1`);
  const run = (out as any).run;
  assertEquals(run.docket_revision_id, "b308e68a-4435-5789-b843-59de3837cdc1");
  assertEquals(run.output_content_hash, "sha256:out");
  assertEquals(run.docs_ready_sms, [{ job_id: JOB, outcome: "sent" }]);
  assertEquals(fx.runs[RUN].state, "done");
  assertEquals(fx.runs[RUN].attempts, 1);
  assert(writes.every((w) => !w.patch || fx.runs[RUN].claimed_by === "test-drain"));
});

Deno.test("2. event cycle no longer current: refused_stale, nothing prepared", async () => {
  const fx: Fixture = { runs: { [RUN]: baseRun() }, cycles: [{ id: CYCLE1, cycle_number: 1 }, { id: CYCLE2, cycle_number: 2 }] };
  const { client } = fakeClient(fx);
  let prepared = 0;
  const out = await runSesReportTrigger({ run_id: RUN }, { client, actor: "t", now: () => NOW, prepare: async () => { prepared++; return readyResponse(); } });
  assertEquals(out.outcome, "refused");
  assertEquals(fx.runs[RUN].state, "refused_stale");
  assertEquals(prepared, 0);
  assertStringIncludes(fx.runs[RUN].recovery_action, "closed cycle");
});

Deno.test("3. another identity already built this cycle: refused_conflict for reconciliation", async () => {
  const fx: Fixture = { runs: { [RUN]: baseRun() }, cycles: [{ id: CYCLE1, cycle_number: 1 }], siblings: [{ id: "x", dedupe_key: `${JOB}:${CYCLE1}:roof:d:h`, state: "done", docket_revision_id: "d-1" }] };
  const { client } = fakeClient(fx);
  let prepared = 0;
  const out = await runSesReportTrigger({ run_id: RUN }, { client, actor: "t", now: () => NOW, prepare: async () => { prepared++; return readyResponse(); } });
  assertEquals(out.outcome, "refused");
  assertEquals(fx.runs[RUN].state, "refused_conflict");
  assertEquals(prepared, 0);
  assertStringIncludes(fx.runs[RUN].last_error, "roof:d:h");
});

Deno.test("4. the pack path's own refusal or a blocked result is refused_gate, terminal for this identity", async () => {
  const fxA: Fixture = { runs: { [RUN]: baseRun() }, cycles: [{ id: CYCLE1, cycle_number: 1 }] };
  const a = fakeClient(fxA);
  const outA = await runSesReportTrigger({ run_id: RUN }, { client: a.client, actor: "t", now: () => NOW, prepare: async () => { throw new SesAssemblerAdapterError("ses_family_required_document_missing", "SWMS missing", 409); } });
  assertEquals(outA.outcome, "refused");
  assertEquals(fxA.runs[RUN].state, "refused_gate");
  assertStringIncludes(fxA.runs[RUN].last_error, "ses_family_required_document_missing");

  const fxB: Fixture = { runs: { [RUN]: baseRun() }, cycles: [{ id: CYCLE1, cycle_number: 1 }] };
  const b = fakeClient(fxB);
  const blocked = readyResponse(); blocked.results[0].state = "blocked"; blocked.results[0].persisted = false; blocked.results[0].blockers = ["photo_missing"];
  const outB = await runSesReportTrigger({ run_id: RUN }, { client: b.client, actor: "t", now: () => NOW, prepare: async () => blocked });
  assertEquals(outB.outcome, "refused");
  assertEquals(fxB.runs[RUN].state, "refused_gate");
  assertEquals(fxB.runs[RUN].result.blockers, ["photo_missing"]);
});

Deno.test("5. transport failure parks failed with backoff; at the ceiling it parks unknown; a cycle drift after prepare parks unknown", async () => {
  const fx: Fixture = { runs: { [RUN]: baseRun() }, cycles: [{ id: CYCLE1, cycle_number: 1 }] };
  const { client } = fakeClient(fx);
  const out = await runSesReportTrigger({ run_id: RUN }, { client, actor: "t", now: () => NOW, prepare: async () => { throw new Error("fetch timeout"); } });
  assertEquals(out.outcome, "failed");
  assertEquals(fx.runs[RUN].state, "failed");
  assertEquals(fx.runs[RUN].next_attempt_at, new Date(NOW.getTime() + 60_000).toISOString());

  const fx2: Fixture = { runs: { [RUN]: baseRun({ state: "failed", attempts: 5 }) }, cycles: [{ id: CYCLE1, cycle_number: 1 }] };
  const c2 = fakeClient(fx2);
  const out2 = await runSesReportTrigger({ run_id: RUN }, { client: c2.client, actor: "t", now: () => NOW, prepare: async () => { throw new Error("still down"); } });
  assertEquals(out2.outcome, "unknown");
  assertEquals(fx2.runs[RUN].state, "unknown");
  assertStringIncludes(fx2.runs[RUN].recovery_action, "read back the docket");

  const fx3: Fixture = { runs: { [RUN]: baseRun() }, cycles: [{ id: CYCLE1, cycle_number: 1 }] };
  const c3 = fakeClient(fx3);
  const out3 = await runSesReportTrigger({ run_id: RUN }, { client: c3.client, actor: "t", now: () => NOW, prepare: async () => readyResponse(CYCLE2) });
  assertEquals(out3.outcome, "unknown");
  assertEquals(fx3.runs[RUN].state, "unknown");
  assertEquals(fx3.runs[RUN].docket_revision_id, "b308e68a-4435-5789-b843-59de3837cdc1");
});

Deno.test("6. unclaimable runs return the honest state and prepare nothing", async () => {
  const fx: Fixture = { runs: { [RUN]: baseRun({ state: "done", docket_revision_id: "d" }) }, cycles: [{ id: CYCLE1, cycle_number: 1 }] };
  const { client } = fakeClient(fx);
  let prepared = 0;
  const out = await runSesReportTrigger({ run_id: RUN }, { client, actor: "t", now: () => NOW, prepare: async () => { prepared++; return readyResponse(); } });
  assertEquals(out.ok, false);
  assertEquals(out.code, "ses_trigger_run_not_claimable");
  assertEquals(out.state, "done");
  assertEquals(prepared, 0);
  const missing = await runSesReportTrigger({ run_id: "75000000-0000-4000-8000-000000000009" }, { client, actor: "t", now: () => NOW, prepare: async () => readyResponse() });
  assertEquals(missing.state, "missing");
});

Deno.test("7. manual entry needs exact job, cycle and identity; reuses an existing run for the same identity", async () => {
  const fx: Fixture = { runs: { [RUN]: baseRun() }, cycles: [{ id: CYCLE1, cycle_number: 1 }] };
  const { client, writes } = fakeClient(fx);
  for (const body of [{ job_id: JOB }, { job_id: JOB, attendance_cycle_id: CYCLE1 }, { attendance_cycle_id: CYCLE1, source_identity: "report:r1" }]) {
    let threw: any = null;
    try { await runSesReportTrigger(body, { client, actor: "t", now: () => NOW, prepare: async () => readyResponse() }); } catch (e) { threw = e; }
    assert(threw instanceof SesReportTriggerError, "manual entry without exact identity must refuse");
  }
  const reused = await runSesReportTrigger({ job_id: JOB, attendance_cycle_id: CYCLE1, source_identity: "report:r1" }, { client, actor: "manual", now: () => NOW, prepare: async () => readyResponse() });
  assertEquals((reused as any).run.id, RUN);
  assert(!writes.some((w) => w.insert), "an existing identity must not be re-inserted");
  const fresh = await runSesReportTrigger({ job_id: JOB, attendance_cycle_id: CYCLE1, source_identity: "report:r2" }, { client, actor: "manual", now: () => NOW, prepare: async () => readyResponse() });
  assert(writes.some((w) => w.insert?.dedupe_key === `${JOB}:${CYCLE1}:report:r2`));
  assertEquals((fresh as any).run.event_type, "manual");
});

Deno.test("9. a stolen lease (new claim token) means the late worker cannot write its outcome", async () => {
  const fx: Fixture = { runs: { [RUN]: baseRun() }, cycles: [{ id: CYCLE1, cycle_number: 1 }], stealClaimAfterClaim: true };
  const { client, writes } = fakeClient(fx);
  let threw: any = null;
  try { await runSesReportTrigger({ run_id: RUN }, { client, actor: "late-worker", now: () => NOW, prepare: async () => readyResponse() }); } catch (e) { threw = e; }
  assert(threw instanceof SesReportTriggerError && threw.code === "ses_trigger_lease_lost", `expected lease lost, got ${threw}`);
  assertEquals(writes.filter((w) => w.patch).length, 0, "no transition may land under a foreign token");
  assertEquals(fx.runs[RUN].claim_token, "token-stolen");
});

Deno.test("10. a job with no attendance cycle is refused_gate with an executable recovery action", async () => {
  const fx: Fixture = { runs: { [RUN]: baseRun({ attendance_cycle_id: null, cycle_number: null }) }, cycles: [] };
  const { client } = fakeClient(fx);
  let prepared = 0;
  const out = await runSesReportTrigger({ run_id: RUN }, { client, actor: "t", now: () => NOW, prepare: async () => { prepared++; return readyResponse(); } });
  assertEquals(out.outcome, "refused");
  assertEquals(fx.runs[RUN].state, "refused_gate");
  assertEquals(prepared, 0);
  assertStringIncludes(fx.runs[RUN].recovery_action, "attendance cycle");
});

Deno.test("11. refile moves a refused or parked run back to pending with the actor recorded; done rows cannot be refiled", async () => {
  const fx: Fixture = { runs: { [RUN]: baseRun({ state: "refused_gate", last_error: "SWMS missing", recovery_action: "fix then refile", completed_at: "2026-09-11T02:30:00.000Z" }) }, cycles: [{ id: CYCLE1, cycle_number: 1 }] };
  const { client, writes } = fakeClient(fx);
  const out = await runSesReportTrigger({ job_id: JOB, attendance_cycle_id: CYCLE1, source_identity: "report:r1", refile: true, actor: "insurance-desk" },
    { client, actor: "manual", now: () => NOW, prepare: async () => readyResponse() });
  assertEquals(out.outcome, "done", JSON.stringify(out));
  const refile = writes.find((w) => w.patch?.state === "pending");
  assert(refile, "refile must move the row to pending before the claim");
  assertEquals(refile.patch.result.refiled.by, "insurance-desk");
  assertEquals(refile.patch.result.refiled.from_state, "refused_gate");

  const fxDone: Fixture = { runs: { [RUN]: baseRun({ state: "done" }) }, cycles: [{ id: CYCLE1, cycle_number: 1 }] };
  const d = fakeClient(fxDone);
  let threw: any = null;
  try { await runSesReportTrigger({ job_id: JOB, attendance_cycle_id: CYCLE1, source_identity: "report:r1", refile: true }, { client: d.client, actor: "manual", now: () => NOW, prepare: async () => readyResponse() }); } catch (e) { threw = e; }
  assert(threw instanceof SesReportTriggerError && threw.code === "ses_trigger_refile_not_allowed");
  assertEquals(fxDone.runs[RUN].state, "done");
});

Deno.test("8. pending list excludes done rows and carries age and recovery action", async () => {
  const fx: Fixture = {
    runs: { [RUN]: baseRun({ state: "failed", last_error: "x", recovery_action: "automatic retry" }), "75000000-0000-4000-8000-000000000002": baseRun({ id: "75000000-0000-4000-8000-000000000002", dedupe_key: "k2", state: "done" }) },
    cycles: [],
  };
  const { client } = fakeClient(fx);
  const out = await listSesReportTriggerRuns(new URLSearchParams(""), client, () => NOW);
  assertEquals(out.count, 1);
  const row = (out as any).runs[0];
  assertEquals(row.state, "failed");
  assertEquals(row.age_seconds, 3600);
  assertEquals(row.recovery_action, "automatic retry");
  const all = await listSesReportTriggerRuns(new URLSearchParams("include_done=true"), client, () => NOW);
  assertEquals(all.count, 2);
});

Deno.test("12. pending list carries the drain's own flag and recent cron runs; read errors never fail the list", async () => {
  const run = baseRun();
  const cronRow = { status: "succeeded", return_message: "1 row", start_time: "2026-09-11T02:59:00.000Z", end_time: "2026-09-11T02:59:00.050Z" };
  const on = await listSesReportTriggerRuns(new URLSearchParams(""), fakeClient({ runs: { [RUN]: { ...run } }, cycles: [], cronRuns: [cronRow] }).client, () => NOW);
  const d = (on as any).drain;
  assertEquals(d.drain_enabled, true);
  assertEquals(d.settings_row_present, true);
  assertEquals(d.updated_by, "migration");
  assertEquals(d.settings_error, null);
  assertEquals(d.recent_cron_runs, [cronRow]);
  assertEquals(d.cron_runs_error, null);
  assertEquals(d.cron_job_name, "ses-report-trigger-drain");
  assertStringIncludes(d.gate, "ses_report_drain_enabled");

  const off = await listSesReportTriggerRuns(new URLSearchParams(""), fakeClient({ runs: { [RUN]: { ...run } }, cycles: [], drainSettings: { drain_enabled: false, updated_at: null, updated_by: "ops" } }).client, () => NOW);
  assertEquals((off as any).drain.drain_enabled, false);
  assertEquals((off as any).drain.recent_cron_runs, []);

  const missing = await listSesReportTriggerRuns(new URLSearchParams(""), fakeClient({ runs: { [RUN]: { ...run } }, cycles: [], drainSettings: null }).client, () => NOW);
  assertEquals((missing as any).drain.drain_enabled, false);
  assertEquals((missing as any).drain.settings_row_present, false);

  const broken = await listSesReportTriggerRuns(
    new URLSearchParams(""),
    fakeClient({ runs: { [RUN]: { ...run } }, cycles: [], drainSettingsError: "permission denied", cronRunsError: "function missing" }).client,
    () => NOW,
  );
  assertEquals(broken.ok, true);
  assertEquals(broken.count, 1);
  assertEquals((broken as any).drain.drain_enabled, null);
  assertEquals((broken as any).drain.settings_error, "permission denied");
  assertEquals((broken as any).drain.recent_cron_runs, null);
  assertEquals((broken as any).drain.cron_runs_error, "function missing");
  assert(!("drain_enabled" in broken));
});

Deno.test("13. drain status carries the cron job, visible run count, recent pg_net responses and the note; each read fails on its own", async () => {
  const run = baseRun();
  const cronRow = { status: "succeeded", return_message: "1 row", start_time: "2026-09-11T00:07:00.000Z", end_time: "2026-09-11T00:07:00.050Z" };
  const jobRow = { jobid: 41, jobname: "ses-report-trigger-drain", schedule: "* * * * *", active: false, username: "postgres", command_preview: "SELECT public.trigger_ses_report_trigger_drain()" };
  const httpRow = { id: 9001, status_code: 200, content_preview: "{\"ok\":true}", created: "2026-09-11T00:07:01.000Z", timed_out: false, error_msg: null };

  const ok = await listSesReportTriggerRuns(
    new URLSearchParams(""),
    fakeClient({ runs: { [RUN]: { ...run } }, cycles: [], cronRuns: [cronRow], cronJob: [jobRow], cronRunCount: "187", httpResponses: [httpRow] }).client,
    () => NOW,
  );
  const d = (ok as any).drain;
  assertEquals(d.cron_job, [jobRow]);
  assertEquals(d.cron_job[0].active, false);
  assertEquals(d.cron_job_error, null);
  assertEquals(d.cron_run_count, 187);
  assertEquals(d.cron_run_count_error, null);
  assertEquals(d.recent_http_responses, [httpRow]);
  assertEquals(d.http_responses_error, null);
  assertStringIncludes(d.http_responses_scope, "not proven to be a drain post");
  assertEquals(d.note, "A cron run marked succeeded means the drain query ran and a post was queued; it does not prove ops-api processed the run.");
  assertEquals(d.cron_job_name, "ses-report-trigger-drain");
  assertEquals(d.recent_cron_runs, [cronRow]);

  // No visible job and a null count (pg_cron absent, hidden by another role, or not permitted) stay empty and null, not 0.
  const hidden = await listSesReportTriggerRuns(
    new URLSearchParams(""),
    fakeClient({ runs: { [RUN]: { ...run } }, cycles: [], cronJob: [], cronRunCount: null }).client,
    () => NOW,
  );
  assertEquals((hidden as any).drain.cron_job, []);
  assertEquals((hidden as any).drain.cron_run_count, null);
  assertEquals((hidden as any).drain.cron_run_count_error, null);

  // Each read fails alone, including a thrown exception; the list and the other reads survive.
  const broken = await listSesReportTriggerRuns(
    new URLSearchParams(""),
    fakeClient({
      runs: { [RUN]: { ...run } }, cycles: [], cronRuns: [cronRow],
      cronJobError: "permission denied for schema cron", cronRunCountError: "function missing", httpResponsesThrow: "socket closed",
    }).client,
    () => NOW,
  );
  assertEquals(broken.ok, true);
  assertEquals(broken.count, 1);
  const b = (broken as any).drain;
  assertEquals(b.drain_enabled, true);
  assertEquals(b.recent_cron_runs, [cronRow]);
  assertEquals(b.cron_runs_error, null);
  assertEquals(b.cron_job, null);
  assertEquals(b.cron_job_error, "permission denied for schema cron");
  assertEquals(b.cron_run_count, null);
  assertEquals(b.cron_run_count_error, "function missing");
  assertEquals(b.recent_http_responses, null);
  assertEquals(b.http_responses_error, "socket closed");
  assertEquals(b.note, "A cron run marked succeeded means the drain query ran and a post was queued; it does not prove ops-api processed the run.");
});

Deno.test("14. drain status carries the whole-scheduler pulse, and its read fails on its own", async () => {
  const run = baseRun();
  const drainJob = { jobid: 41, jobname: "ses-report-trigger-drain", schedule: "* * * * *", active: true, username: "postgres", last_start_time: "2026-09-11T00:07:00.000Z", last_status: "succeeded" };
  const neverRan = { jobid: 42, jobname: "makesafe-email-poll", schedule: "*/5 * * * *", active: true, username: "postgres", last_start_time: null, last_status: null };

  const ok = await listSesReportTriggerRuns(
    new URLSearchParams(""),
    fakeClient({ runs: { [RUN]: { ...run } }, cycles: [], schedulerPulse: [drainJob, neverRan] }).client,
    () => NOW,
  );
  const d = (ok as any).drain;
  assertEquals(d.scheduler_pulse, [drainJob, neverRan]);
  assertEquals(d.scheduler_pulse[1].last_start_time, null);
  assertEquals(d.scheduler_pulse_error, null);

  // pg_cron absent, or every job hidden by pg_cron row security: empty, not null.
  const empty = await listSesReportTriggerRuns(
    new URLSearchParams(""),
    fakeClient({ runs: { [RUN]: { ...run } }, cycles: [], schedulerPulse: [] }).client,
    () => NOW,
  );
  assertEquals((empty as any).drain.scheduler_pulse, []);
  assertEquals((empty as any).drain.scheduler_pulse_error, null);

  // The pulse read fails alone; the list and the other drain reads survive.
  const broken = await listSesReportTriggerRuns(
    new URLSearchParams(""),
    fakeClient({ runs: { [RUN]: { ...run } }, cycles: [], schedulerPulseError: "permission denied for schema cron" }).client,
    () => NOW,
  );
  assertEquals(broken.ok, true);
  assertEquals(broken.count, 1);
  assertEquals((broken as any).drain.scheduler_pulse, null);
  assertEquals((broken as any).drain.scheduler_pulse_error, "permission denied for schema cron");
  assertEquals((broken as any).drain.drain_enabled, true);
});

Deno.test("15. drain status tells absent pg_cron, an unreadable cron schema and row-security hiding apart", async () => {
  const run = baseRun();

  // pg_cron absent: present false, the denied probe not attempted (null), and a
  // null run count with NO error, which is the documented "absent" reading.
  const absent = await listSesReportTriggerRuns(
    new URLSearchParams(""),
    fakeClient({
      runs: { [RUN]: { ...run } }, cycles: [], cronJob: [], cronRunCount: null,
      cronVisibility: { pg_cron_present: false, cron_run_details_present: false, definer_role: "postgres", definer_bypasses_rls: true, cron_job_select_denied: null },
    }).client,
    () => NOW,
  );
  const a = (absent as any).drain;
  assertEquals(a.cron_visibility.pg_cron_present, false);
  assertEquals(a.cron_visibility.cron_job_select_denied, null);
  assertEquals(a.cron_visibility_error, null);
  assertEquals(a.cron_run_count, null);
  assertEquals(a.cron_run_count_error, null);
  assertStringIncludes(a.visibility_note, "hidden by pg_cron row security");

  // pg_cron present but cron.job unreadable by this role: denied true.
  const denied = await listSesReportTriggerRuns(
    new URLSearchParams(""),
    fakeClient({
      runs: { [RUN]: { ...run } }, cycles: [], cronJob: [],
      cronVisibility: { pg_cron_present: true, cron_run_details_present: true, definer_role: "ops_definer", definer_bypasses_rls: false, cron_job_select_denied: true },
    }).client,
    () => NOW,
  );
  const dn = (denied as any).drain.cron_visibility;
  assertEquals(dn.pg_cron_present, true);
  assertEquals(dn.cron_job_select_denied, true);
  assertEquals(dn.definer_bypasses_rls, false);
  assertEquals(dn.definer_role, "ops_definer");

  // -1 from the run count is insufficient_privilege, reported as an error and
  // never as a count. This is the case a plain null used to swallow.
  const hidden = await listSesReportTriggerRuns(
    new URLSearchParams(""),
    fakeClient({ runs: { [RUN]: { ...run } }, cycles: [], cronJob: [], cronRunCount: "-1" }).client,
    () => NOW,
  );
  const h = (hidden as any).drain;
  assertEquals(h.cron_run_count, null);
  assertStringIncludes(h.cron_run_count_error, "insufficient_privilege");
  assertStringIncludes(h.cron_run_count_error, "cron.job_run_details");
  assertEquals(h.cron_visibility.definer_bypasses_rls, true);

  // A real zero is still a zero, not an error.
  const zero = await listSesReportTriggerRuns(
    new URLSearchParams(""),
    fakeClient({ runs: { [RUN]: { ...run } }, cycles: [], cronRunCount: 0 }).client,
    () => NOW,
  );
  assertEquals((zero as any).drain.cron_run_count, 0);
  assertEquals((zero as any).drain.cron_run_count_error, null);

  // The visibility read fails alone, and a no-row answer is null, not invented.
  const broken = await listSesReportTriggerRuns(
    new URLSearchParams(""),
    fakeClient({ runs: { [RUN]: { ...run } }, cycles: [], cronVisibilityError: "permission denied for function ses_report_drain_cron_visibility" }).client,
    () => NOW,
  );
  assertEquals(broken.ok, true);
  assertEquals((broken as any).drain.cron_visibility, null);
  assertStringIncludes((broken as any).drain.cron_visibility_error, "permission denied");
  assertEquals((broken as any).drain.drain_enabled, true);

  const noRow = await listSesReportTriggerRuns(
    new URLSearchParams(""),
    fakeClient({ runs: { [RUN]: { ...run } }, cycles: [], cronVisibility: null }).client,
    () => NOW,
  );
  assertEquals((noRow as any).drain.cron_visibility, null);
  assertEquals((noRow as any).drain.cron_visibility_error, null);
});
