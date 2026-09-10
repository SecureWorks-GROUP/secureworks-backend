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
};

/** A tiny query-builder stand-in that records writes and answers the reads the handler makes. */
function fakeClient(fx: Fixture) {
  const writes: any[] = [];
  const client = {
    rpc(name: string, args: any) {
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
