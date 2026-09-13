// deno-lint-ignore-file no-explicit-any require-await no-import-prefix
//
// SES pack-build doors (CIO, ses-workflow-completion-20260913).
//
// The Refresh door and the runtime reader, against no live provider and no
// database. Nothing here calls prepare, Xero or Graph.
//
// Pins:
//   1. Refresh on a fresh card queues exactly ONE attempt and reports progress.
//   2. A duplicate Refresh (double-click, two operators) JOINS the open attempt
//      and files no second row; the dedupe key is the guard on a lost response.
//   3. Refresh never implies mail: mail_sent is literally false on every path,
//      and no send or mint dependency exists on this module at all.
//   4. Refresh on a complete pack queues NOTHING and says the pack is done.
//   5. Refresh on a hold queues nothing and hands back the recovery action.
//   6. Refresh names the DRIVING PERSON from the verified session, never the body.
//   7. The reader is read-only: it files nothing, and it distinguishes
//      "no pack" from "the pack could not be read".
//   8. The reader carries the drain state so an idle queue is diagnosable.
//   9. The direct-prepare receipt lands `done` so a later trigger reuses rather
//      than re-preparing, and a ledger failure never breaks the build.

import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  readSesPackBuildState,
  recordDirectPrepareAttempt,
  requestSesPackBuild,
  SesPackBuildDoorError,
} from "./ses_pack_build_doors.ts";
import type { SesPackBuildPackTruth } from "./ses_pack_build_admission.ts";

const JOB = "70000000-0000-4000-8000-000000000001";
const ORG = "00000000-0000-0000-0000-000000000001";
const CYCLE1 = "72000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-09-13T03:00:00.000Z");

type Fixture = {
  job?: any;
  cycle?: any;
  runs: any[];
  pack?: SesPackBuildPackTruth | null;
  packThrows?: string;
  insertError?: string;
  /** Row that only a dedupe_key lookup finds: the winner of an insert race. */
  racedWinner?: any;
  jobError?: string;
  runsError?: string;
};

function noPack(): SesPackBuildPackTruth {
  return {
    job_id: JOB, org_id: ORG, required_documents_resolved: true,
    required_documents: { report: true, invoice: true, swms: false },
    pack: {
      exists: false, status: null, report_doc_id: null, invoice_doc_id: null,
      swms_doc_id: null, sent_at: null, send_started_at: null,
    },
    docket: null, docket_actor_identity: null, invoice: null,
  };
}

function completePack(): SesPackBuildPackTruth {
  const p = noPack();
  p.pack = {
    exists: true, status: "drafted",
    report_doc_id: "1e9c69aa-f0fa-404e-ba36-43282359b77b",
    invoice_doc_id: "1604ec27-f145-4398-8504-3b6f91f50a3c",
    swms_doc_id: null, sent_at: null, send_started_at: null,
  };
  p.docket = {
    docket_revision_id: "9983309a-e8d6-5f64-8515-6104b5631297",
    output_content_hash: "sha256:d60c7589",
  };
  p.docket_actor_identity = "makesafe-reporting-routine";
  p.invoice = { xero_invoice_id: "9b7a6ecd", number: "INV-1517", status: "DRAFT" };
  return p;
}

function baseRun(over: any = {}) {
  return {
    id: "75000000-0000-4000-8000-000000000001",
    dedupe_key: `${JOB}:${CYCLE1}:report:r1`,
    job_id: JOB, attendance_cycle_id: CYCLE1, cycle_number: 1,
    event_type: "makesafe_report_submitted", source: { kind: "makesafe_report" },
    state: "pending", attempts: 0, duplicate_events: 0, next_attempt_at: null,
    claimed_by: null, lease_expires_at: null, last_error: null, recovery_action: null,
    docket_revision_id: null, output_content_hash: null, result: {},
    created_at: "2026-09-13T02:00:00.000Z", completed_at: null, ...over,
  };
}

function fakeClient(fx: Fixture) {
  const inserts: any[] = [];
  const upserts: any[] = [];
  const client = {
    from(table: string) {
      const q: any = { _t: table, _f: [] as any[], _op: "select", _patch: null as any };
      const chain = (fn: (a: any[]) => void) => (...a: any[]) => { fn(a); return q; };
      q.select = chain(() => {});
      q.eq = chain((a) => q._f.push(["eq", a[0], a[1]]));
      q.neq = chain((a) => q._f.push(["neq", a[0], a[1]]));
      q.order = chain(() => {});
      q.limit = chain(() => {});
      q.insert = chain((a) => { q._op = "insert"; q._patch = a[0]; });
      q.upsert = chain((a) => { q._op = "upsert"; q._patch = a[0]; });
      const run = () => {
        if (table === "jobs") {
          if (fx.jobError) return { data: null, error: { message: fx.jobError } };
          return {
            data: fx.job === undefined
              ? { id: JOB, job_number: "AJBR-72221", status: "accepted" }
              : fx.job,
            error: null,
          };
        }
        if (table === "makesafe_attendance_cycles") {
          return {
            data: fx.cycle === undefined ? { id: CYCLE1, cycle_number: 1 } : fx.cycle,
            error: null,
          };
        }
        if (table === "ses_report_trigger_runs") {
          if (q._op === "insert") {
            if (fx.insertError) return { data: null, error: { message: fx.insertError } };
            const row = baseRun({ id: "75000000-0000-4000-8000-0000000000aa", ...q._patch });
            inserts.push(q._patch);
            fx.runs.push(row);
            return { data: row, error: null };
          }
          if (q._op === "upsert") {
            if (fx.insertError) return { data: null, error: { message: fx.insertError } };
            upserts.push(q._patch);
            return { data: null, error: null };
          }
          if (fx.runsError) return { data: null, error: { message: fx.runsError } };
          const key = q._f.find((f: any) => f[1] === "dedupe_key")?.[2];
          if (key) {
            const hit = fx.runs.find((r) => r.dedupe_key === key) ??
              (fx.racedWinner?.dedupe_key === key ? fx.racedWinner : null);
            return { data: hit ?? null, error: null };
          }
          return { data: fx.runs, error: null };
        }
        throw new Error(`unexpected table ${table}`);
      };
      q.maybeSingle = () => Promise.resolve(run());
      q.single = () => q.maybeSingle();
      q.then = (res: any, rej: any) => Promise.resolve(run()).then(res, rej);
      return q;
    },
  };
  return { client, inserts, upserts };
}

function deps(fx: Fixture, extra: Record<string, unknown> = {}) {
  const { client, inserts, upserts } = fakeClient(fx);
  return {
    inserts,
    upserts,
    client,
    deps: {
      client,
      orgId: ORG,
      readPackTruth: async (_jobId: string) => {
        if (fx.packThrows) throw new Error(fx.packThrows);
        return fx.pack === undefined ? noPack() : fx.pack;
      },
      now: () => NOW,
      ...extra,
    } as any,
  };
}

Deno.test("1. Refresh on a fresh card queues exactly one attempt and reports progress", async () => {
  const fx: Fixture = { runs: [] };
  const d = deps(fx);
  const out = await requestSesPackBuild({ job_id: JOB }, {
    ...d.deps,
    requestedBy: "marnin@secureworksgroup.app",
  });
  assertEquals(out.ok, true);
  assertEquals(out.queued, true);
  assertEquals(out.joined_existing, false);
  assert(out.run_id, "a queued attempt must hand back its run id");
  assertEquals(d.inserts.length, 1, "exactly one attempt is filed");
  assertEquals(d.inserts[0].state, "pending");
  assertEquals(d.inserts[0].event_type, "manual");
  assertEquals(d.inserts[0].source.kind, "ui_refresh");
  assertEquals(d.inserts[0].dedupe_key, `${JOB}:${CYCLE1}:ui_refresh:${CYCLE1}`);
  assertStringIncludes(String(out.progress), "queued");
});

Deno.test("2. a duplicate Refresh joins the open attempt and files no second row", async () => {
  // The producer already filed a run for this cycle: Refresh must join it,
  // not open a parallel attempt beside it.
  const fx: Fixture = { runs: [baseRun()] };
  const d = deps(fx);
  const out = await requestSesPackBuild({ job_id: JOB }, {
    ...d.deps,
    requestedBy: "ops@secureworksgroup.app",
  });
  assertEquals(out.queued, true);
  assertEquals(out.joined_existing, true);
  assertEquals(out.run_id, "75000000-0000-4000-8000-000000000001");
  assertEquals(d.inserts.length, 0, "joining must never file a second attempt");
  assertStringIncludes(String(out.progress), "already open");

  // And if two Refreshes race on the unique dedupe key, the loser recovers the
  // row that won rather than reporting a failure. The winner is invisible to
  // the loser's first read and appears only on the dedupe-key lookup, which is
  // exactly how the race lands in production.
  const raced: Fixture = {
    runs: [],
    insertError: "duplicate key value violates unique constraint",
    racedWinner: baseRun({
      id: "75000000-0000-4000-8000-0000000000bb",
      dedupe_key: `${JOB}:${CYCLE1}:ui_refresh:${CYCLE1}`,
      state: "pending",
      source: { kind: "ui_refresh" },
    }),
  };
  const r = deps(raced);
  const recovered = await requestSesPackBuild({ job_id: JOB }, {
    ...r.deps,
    requestedBy: "ops@secureworksgroup.app",
  });
  assertEquals(recovered.joined_existing, true);
  assertEquals(recovered.run_id, "75000000-0000-4000-8000-0000000000bb");
  assertStringIncludes(String(recovered.progress), "already queued");
});

Deno.test("3. Refresh never implies mail was sent, on every path", async () => {
  for (
    const fx of [
      { runs: [] } as Fixture,
      { runs: [baseRun()] } as Fixture,
      { runs: [], pack: completePack() } as Fixture,
      { runs: [], pack: null } as Fixture,
      { runs: [], cycle: null } as Fixture,
    ]
  ) {
    const d = deps(fx);
    const out = await requestSesPackBuild({ job_id: JOB }, {
      ...d.deps,
      requestedBy: "ops@secureworksgroup.app",
    });
    assertEquals(out.mail_sent, false, "mail_sent must be literally false");
    assertStringIncludes(String(out.note), "never sends");
  }

  // Structural, not just behavioural: this module imports no send, no Xero and
  // no prepare dependency, so no future edit can reach one by accident.
  const source = await Deno.readTextFile(
    new URL("./ses_pack_build_doors.ts", import.meta.url),
  );
  const imports = source.match(/from "\.\/[^"]+"/g) ?? [];
  assertEquals(
    imports,
    ['from "./ses_pack_build_admission.ts"'],
    "the doors module must depend on the admission gate alone",
  );
  for (const forbidden of ["graph", "xero", "sendSms", "prepareSesDocket", "Mail.Send"]) {
    assert(
      !source.includes(forbidden),
      `the doors module must not reference ${forbidden}`,
    );
  }
});

Deno.test("4. Refresh on a complete pack queues nothing and says so", async () => {
  const fx: Fixture = {
    runs: [baseRun({ state: "done", docket_revision_id: "9983309a" })],
    pack: completePack(),
  };
  const d = deps(fx);
  const out = await requestSesPackBuild({ job_id: JOB }, {
    ...d.deps,
    requestedBy: "ops@secureworksgroup.app",
  });
  assertEquals(out.queued, false);
  assertEquals(out.ok, true, "a finished card is a good outcome, not a failure");
  assertEquals((out.admission as any).decision, "reuse");
  assertEquals(d.inserts.length, 0);
  assertStringIncludes(String(out.progress), "already complete");
  assertEquals(out.mail_sent, false);
});

Deno.test("5. Refresh on a hold queues nothing and hands back the recovery action", async () => {
  const fx: Fixture = { runs: [], cycle: null };
  const d = deps(fx);
  const out = await requestSesPackBuild({ job_id: JOB }, {
    ...d.deps,
    requestedBy: "ops@secureworksgroup.app",
  });
  assertEquals(out.queued, false);
  assertEquals(out.ok, false);
  assertEquals((out.admission as any).decision, "hold_no_cycle");
  assertEquals(d.inserts.length, 0, "a guaranteed refusal must not spend the dedupe key");
  assertStringIncludes(String(out.progress), "attendance cycle");

  // A bad job id refuses before any read.
  let threw: unknown = null;
  try {
    await requestSesPackBuild({ job_id: "not-a-uuid" }, {
      ...d.deps,
      requestedBy: "ops@secureworksgroup.app",
    });
  } catch (e) {
    threw = e;
  }
  assert(threw instanceof SesPackBuildDoorError);
  assertEquals((threw as SesPackBuildDoorError).code, "ses_pack_build_job_id_required");
});

Deno.test("6. the driving person is named from the session, never from the body", async () => {
  const fx: Fixture = { runs: [] };
  const d = deps(fx);
  await requestSesPackBuild(
    { job_id: JOB, requested_by: "someone-else@example.com", actor: "spoofed" },
    { ...d.deps, requestedBy: "marnin@secureworksgroup.app" },
  );
  assertEquals(d.inserts[0].source.requested_by, "marnin@secureworksgroup.app");
  assert(
    !JSON.stringify(d.inserts[0]).includes("spoofed"),
    "a body-supplied actor must never reach the ledger",
  );
  assert(
    !JSON.stringify(d.inserts[0]).includes("someone-else@example.com"),
    "a body-supplied requester must never reach the ledger",
  );
});

Deno.test("7. the reader is read-only and tells 'no pack' apart from 'unreadable'", async () => {
  const fx: Fixture = { runs: [baseRun()] };
  const d = deps(fx);
  const out = await readSesPackBuildState(
    new URLSearchParams({ job_id: JOB }),
    d.deps,
  );
  assertEquals(out.ok, true);
  assertEquals(d.inserts.length, 0, "the reader must write nothing");
  assertEquals((out.job as any).job_number, "AJBR-72221");
  assertEquals(out.pack_read_failed, false);
  assertEquals((out.runs as any[]).length, 1);
  assertEquals((out.attempt as any).open_run_id, "75000000-0000-4000-8000-000000000001");
  assertStringIncludes(String(out.docs_ready_is_not_sent), "never means");

  // A pack read that throws is reported as a fault, not as an empty card.
  const broken = deps({ runs: [], packThrows: "boom" });
  const out2 = await readSesPackBuildState(
    new URLSearchParams({ job_id: JOB }),
    broken.deps,
  );
  assertEquals(out2.pack_read_failed, true);
  assertEquals(out2.pack, null);
  assertEquals((out2.attempt as any).would_decide.decision, "hold_divergent_pack");
  assertEquals((out2.attempt as any).would_decide.builds_allowed, false);

  // A card that genuinely has no pack is a different answer.
  const empty = deps({ runs: [] });
  const out3 = await readSesPackBuildState(
    new URLSearchParams({ job_id: JOB }),
    empty.deps,
  );
  assertEquals(out3.pack_read_failed, false);
  assertEquals((out3.attempt as any).would_decide.decision, "admit");
});

Deno.test("8. the reader carries the drain state so an idle queue is diagnosable", async () => {
  const fx: Fixture = { runs: [baseRun()] };
  const d = deps(fx, {
    readDrainState: async () => ({
      drain_enabled: true,
      cron_job: [{ jobname: "ses-report-trigger-drain", active: false }],
    }),
  });
  const out = await readSesPackBuildState(
    new URLSearchParams({ job_id: JOB }),
    d.deps,
  );
  // The whole point: the flag says on while the job is off. A reader that
  // showed only the flag would call this healthy.
  assertEquals((out.drain as any).drain_enabled, true);
  assertEquals((out.drain as any).cron_job[0].active, false);

  // Without a drain reader the key is present and null, never silently absent.
  const bare = deps({ runs: [] });
  const out2 = await readSesPackBuildState(
    new URLSearchParams({ job_id: JOB }),
    bare.deps,
  );
  assertEquals(out2.drain, null);
});

Deno.test("9. the direct-prepare receipt lands done, and a ledger failure never breaks the build", async () => {
  const fx: Fixture = { runs: [] };
  const d = deps(fx);
  const ok = await recordDirectPrepareAttempt({
    client: d.client,
    jobId: JOB,
    attendanceCycleId: CYCLE1,
    idempotencyKey: "skill-run-1",
    actor: "makesafe-reporting-routine",
    docketRevisionId: "9983309a",
    outputContentHash: "sha256:out",
    state: "ready",
    persisted: true,
    now: () => NOW,
  });
  assertEquals(ok.recorded, true);
  assertEquals(d.upserts.length, 1);
  assertEquals(d.upserts[0].state, "done", "the build genuinely happened");
  assertEquals(d.upserts[0].source.kind, "direct_prepare");
  assertEquals(
    d.upserts[0].dedupe_key,
    `${JOB}:${CYCLE1}:direct_prepare:skill-run-1`,
  );
  assertEquals(d.upserts[0].docket_revision_id, "9983309a");

  // Fail-open: a ledger fault is reported, never raised.
  const broken = deps({ runs: [], insertError: "ledger down" });
  const bad = await recordDirectPrepareAttempt({
    client: broken.client,
    jobId: JOB,
    attendanceCycleId: CYCLE1,
    idempotencyKey: "skill-run-2",
    actor: "routine",
    docketRevisionId: null,
    outputContentHash: null,
    state: "ready",
    persisted: true,
    now: () => NOW,
  });
  assertEquals(bad.recorded, false);
  assertStringIncludes(String(bad.reason), "ledger down");

  // A non-UUID job is refused rather than writing a junk row.
  const junk = await recordDirectPrepareAttempt({
    client: d.client,
    jobId: "",
    attendanceCycleId: null,
    idempotencyKey: "k",
    actor: "routine",
    docketRevisionId: null,
    outputContentHash: null,
    state: "ready",
    persisted: true,
    now: () => NOW,
  });
  assertEquals(junk.recorded, false);
  assertEquals(d.upserts.length, 1, "no junk row is written");
});
