// deno-lint-ignore-file no-import-prefix no-explicit-any
//
// Rescue SES remainder item 1 — the substatus write-gate's fail-open must be
// AUDIBLE. Spec: wiki coding/work/campaigns/makesafe-system/SPEC.md item 1.
//
// The defect these tests pin: the gate used to wrap its two pre-reads in
// try/catch and never inspect `error`. PostgREST RETURNS errors rather than
// throwing (backend AGENTS.md), so the catch was dead code, its console.warn
// never fired, and a failed read silently opened the only coherence gate in
// front of every make-safe substatus write.
//
// The fail-open is deliberate and STAYS OPEN. What is asserted here is that it
// is now named, counted and greppable, that a healthy write is silent, and that
// an absent card is not mistaken for an unreadable one.
//
// S1 checks (the ops-api action surface) drive the real `_updateMakesafeSubstatus`
// from index.ts against a fake PostgREST client and assert BOTH the marker and
// that the write still landed. The evaluator checks exercise the real decision
// function directly — no reimplemented-pure copy to drift.
//
// Run: ~/.deno/bin/deno test --no-check --allow-env --allow-net=127.0.0.1 \
//        --allow-read supabase/functions/ops-api/makesafe_substatus_gate_test.ts

import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  evaluateMakesafeSubstatusGate,
  MAKESAFE_SUBSTATUS_GATE_FAIL_OPEN_MARKER,
  MAKESAFE_SUBSTATUS_GATE_READ_THREW_MARKER,
  MAKESAFE_SUBSTATUS_TRANSITIONS,
} from "./makesafe_substatus_gate.ts";
import {
  _normalizeMakesafeSubstatus,
  _updateMakesafeSubstatus,
} from "./index.ts";
import {
  intakeOrigin,
  internalEvidenceOrigin,
  unidentifiedOrigin,
} from "./makesafe_write_origin.ts";

// ── Fake PostgREST client ────────────────────────────────────────────────────
// Mirrors the real builder shape the gate and the write use:
//   from(t).select(c).eq(k,v).maybeSingle()          — the two pre-reads
//   from(t).update(p).eq(k,v).select().single()      — the substatus write
//   from(t).insert(row)                              — the job_events line
// A PostgREST response is `{ data, error }`; a query error arrives on `error`
// and does NOT throw. That is the whole point of this suite.

interface FakeRes {
  data: any;
  error: any;
}

interface FakeClientOpts {
  detailRead?: FakeRes;
  jobRead?: FakeRes;
  /** Throw from the read builder instead — the last-resort transport fault. */
  readThrows?: string;
}

function makeFakeClient(opts: FakeClientOpts) {
  const allUpdates: Array<Record<string, any>> = [];
  // Only the substatus write itself. A finished substatus also drives
  // closeOpenAssignmentsForJob, which updates job_assignments — real behaviour,
  // but not what these tests are asserting on.
  const updates: Array<Record<string, any>> = [];
  const events: Array<Record<string, any>> = [];
  const detailRead = opts.detailRead ?? { data: null, error: null };
  const jobRead = opts.jobRead ??
    { data: { status: "processing" }, error: null };

  const client = {
    from(table: string) {
      return {
        select(_cols?: string) {
          const chain: any = {
            eq() {
              return chain;
            },
            maybeSingle() {
              if (opts.readThrows) throw new Error(opts.readThrows);
              return Promise.resolve(table === "jobs" ? jobRead : detailRead);
            },
          };
          return chain;
        },
        update(payload: Record<string, any>) {
          allUpdates.push({ table, ...payload });
          if (table === "makesafe_job_details") {
            updates.push({ table, ...payload });
          }
          const row = {
            data: { job_id: "job-1", substatus: payload.substatus },
            error: null,
          };
          const chain: any = {
            eq() {
              return chain;
            },
            // closeOpenAssignmentsForJob (fired for a finished substatus) uses
            // .in()/.lte() and awaits the builder directly, so the fake has to
            // carry that shape or it reports a shape fault that isn't real.
            in() {
              return chain;
            },
            lte() {
              return chain;
            },
            select() {
              return chain;
            },
            single() {
              return Promise.resolve(row);
            },
            then(onFulfilled: any, onRejected: any) {
              return Promise.resolve({ data: [], error: null }).then(
                onFulfilled,
                onRejected,
              );
            },
          };
          return chain;
        },
        insert(row: Record<string, any>) {
          events.push({ table, ...row });
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
  };

  return { client, updates, allUpdates, events };
}

/** Capture console.warn for the duration of `fn`, then restore it. */
async function captureWarnings(
  fn: () => Promise<void>,
): Promise<Array<{ message: string; payload: any }>> {
  const captured: Array<{ message: string; payload: any }> = [];
  const original = console.warn;
  console.warn = (message: any, payload?: any) => {
    captured.push({ message: String(message), payload });
  };
  try {
    await fn();
  } finally {
    console.warn = original;
  }
  return captured;
}

function failOpenLines(captured: Array<{ message: string; payload: any }>) {
  return captured.filter((c) =>
    c.message.includes(MAKESAFE_SUBSTATUS_GATE_FAIL_OPEN_MARKER)
  );
}

const POSTGREST_UNDEFINED_COLUMN = {
  code: "42703",
  message: "column makesafe_job_details.substatus does not exist",
  details: null,
  hint: null,
};

// ─────────────────────────────────────────────────────────────────────────────
// S1 — drive the real action-surface write with a pre-read forced to error.
// The write must STILL LAND (fail-open preserved) and the marker must be
// emitted exactly once, carrying the job id and the PostgREST error code.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("S1: makesafe_job_details pre-read errors -> write lands AND the fail-open marker fires exactly once", async () => {
  const { client, updates } = makeFakeClient({
    detailRead: { data: null, error: POSTGREST_UNDEFINED_COLUMN },
    jobRead: { data: { status: "processing" }, error: null },
  });

  let result: any = null;
  const captured = await captureWarnings(async () => {
    result = await _updateMakesafeSubstatus(
      client,
      { job_id: "job-1", substatus: "waiting_on_trade_report" },
      { origin: internalEvidenceOrigin("trade_report") },
    );
  });

  // Fail-OPEN preserved: the write proceeded, exactly as before this change.
  assertEquals(result?.ok, true, "the substatus write must still land");
  assertEquals(updates.length, 1, "exactly one makesafe_job_details update");
  assertEquals(updates[0].substatus, "waiting_on_trade_report");

  const lines = failOpenLines(captured);
  assertEquals(
    lines.length,
    1,
    "the fail-open marker must fire exactly ONCE per gated write",
  );
  const payload = lines[0].payload;
  assertEquals(payload.marker, MAKESAFE_SUBSTATUS_GATE_FAIL_OPEN_MARKER);
  assertEquals(payload.job_id, "job-1");
  assertEquals(payload.next_substatus, "waiting_on_trade_report");
  assertEquals(payload.source, internalEvidenceOrigin("trade_report"));
  assertEquals(payload.detail_read, "unreadable");
  assertEquals(
    payload.job_read,
    "ok",
    "the healthy jobs read must not be smeared as unreadable",
  );
  assertEquals(payload.faults.length, 1);
  assertEquals(payload.faults[0].read, "makesafe_job_details");
  assertEquals(
    payload.faults[0].code,
    "42703",
    "the PostgREST error code must be present",
  );
  assertStringIncludes(payload.faults[0].message, "does not exist");
  // Name what could not be checked, so a log reader need not re-derive it.
  assertEquals(payload.skipped_checks, ["transition_table"]);
});

Deno.test("S1: jobs pre-read errors -> write lands AND the fail-open marker fires exactly once", async () => {
  const jobFault = {
    code: "57014",
    message: "canceling statement due to statement timeout",
    details: null,
    hint: null,
  };
  const { client, updates } = makeFakeClient({
    detailRead: { data: { substatus: "waiting_on_trade_report" }, error: null },
    jobRead: { data: null, error: jobFault },
  });

  let result: any = null;
  const captured = await captureWarnings(async () => {
    result = await _updateMakesafeSubstatus(
      client,
      { job_id: "job-2", substatus: "admin_to_send_report" },
      { origin: internalEvidenceOrigin("close_out") },
    );
  });

  assertEquals(result?.ok, true, "the substatus write must still land");
  assertEquals(updates.length, 1);
  assertEquals(updates[0].substatus, "admin_to_send_report");

  const lines = failOpenLines(captured);
  assertEquals(
    lines.length,
    1,
    "the fail-open marker must fire exactly ONCE per gated write",
  );
  const payload = lines[0].payload;
  assertEquals(payload.job_id, "job-2");
  assertEquals(payload.job_read, "unreadable");
  assertEquals(payload.detail_read, "ok");
  assertEquals(payload.faults[0].read, "jobs");
  assertEquals(
    payload.faults[0].code,
    "57014",
    "the PostgREST error code must be present",
  );
  // The cancelled/lost guard is the check an unreadable jobs row costs us.
  assertEquals(payload.skipped_checks, ["cancelled_lost_guard"]);
});

Deno.test("S1: BOTH pre-reads error -> still exactly ONE marker line, naming both faults", () => {
  // A marker that fires twice for one write cannot be counted. One gated write
  // is one line, however many reads inside it failed.
  const { client } = makeFakeClient({
    detailRead: { data: null, error: POSTGREST_UNDEFINED_COLUMN },
    jobRead: {
      data: null,
      error: { code: "08006", message: "connection failure" },
    },
  });

  return captureWarnings(async () => {
    await _updateMakesafeSubstatus(
      client,
      { job_id: "job-3", substatus: "waiting_on_trade_report" },
      { origin: internalEvidenceOrigin("reattend") },
    );
  }).then((captured) => {
    const lines = failOpenLines(captured);
    assertEquals(lines.length, 1);
    assertEquals(lines[0].payload.faults.map((f: any) => f.read), [
      "makesafe_job_details",
      "jobs",
    ]);
    assertEquals(lines[0].payload.skipped_checks, [
      "cancelled_lost_guard",
      "transition_table",
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The negative half of the definition of done: silence on healthy traffic.
// A gate that logs on every write is as useless as one that never logs.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("S1: the healthy path emits NO fail-open marker", async () => {
  const { client, updates } = makeFakeClient({
    detailRead: { data: { substatus: "waiting_on_trade_report" }, error: null },
    jobRead: { data: { status: "processing" }, error: null },
  });

  const captured = await captureWarnings(async () => {
    await _updateMakesafeSubstatus(
      client,
      { job_id: "job-4", substatus: "admin_to_send_report" },
      { origin: internalEvidenceOrigin("trade_report") },
    );
  });

  assertEquals(updates.length, 1, "the healthy write still lands");
  assertEquals(
    failOpenLines(captured).length,
    0,
    "a healthy write must be SILENT — otherwise the marker cannot be counted in production logs",
  );
});

Deno.test("S1: an ABSENT card (clean read, no row) is NOT reported as a fail-open", async () => {
  // Absent and unreadable are different states and the old code conflated them:
  // both produced `current = null` and an early return. A card that genuinely
  // has no makesafe_job_details row is a first-set, not an incident.
  const { client, updates } = makeFakeClient({
    detailRead: { data: null, error: null },
    jobRead: { data: { status: "processing" }, error: null },
  });

  const captured = await captureWarnings(async () => {
    await _updateMakesafeSubstatus(
      client,
      { job_id: "job-5", substatus: "company_contact_required" },
      { origin: intakeOrigin("mint") },
    );
  });

  assertEquals(updates.length, 1, "the first-set write lands");
  assertEquals(
    failOpenLines(captured).length,
    0,
    "an absent card must never be logged as an unreadable one",
  );
});

Deno.test("an absent JOB row is also not a fail-open", async () => {
  const decision = await evaluateMakesafeSubstatusGate(
    {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: null, error: null }),
          }),
        }),
      }),
    } as any,
    "job-6",
    "waiting_on_trade_report",
    internalEvidenceOrigin("trade_report"),
    {
      normalizeSubstatus: _normalizeMakesafeSubstatus,
      warn: () => assert(false, "must not warn"),
    },
  );
  assertEquals(decision.result.outcome, "checked");
  assertEquals(decision.result.detail_read, "absent");
  assertEquals(decision.result.job_read, "absent");
  assertEquals(decision.refusal, null);
});

// ─────────────────────────────────────────────────────────────────────────────
// The returned value: "passed the check" and "could not read" must stop
// looking identical to a caller. Item 2's helper consumes this.
// ─────────────────────────────────────────────────────────────────────────────

function gateClient(detail: FakeRes, job: FakeRes) {
  return makeFakeClient({ detailRead: detail, jobRead: job }).client as any;
}

Deno.test("outcome distinguishes a real check from a step-aside", async () => {
  const warned: any[] = [];
  const deps = {
    normalizeSubstatus: _normalizeMakesafeSubstatus,
    warn: (_m: string, p: Record<string, unknown>) => warned.push(p),
  };

  const checked = await evaluateMakesafeSubstatusGate(
    gateClient(
      { data: { substatus: "waiting_on_trade_report" }, error: null },
      { data: { status: "processing" }, error: null },
    ),
    "job-a",
    "admin_to_send_report",
    unidentifiedOrigin("external"),
    deps,
  );
  assertEquals(checked.result.outcome, "checked");
  assertEquals(checked.result.current_substatus, "waiting_on_trade_report");
  assertEquals(checked.result.job_status, "processing");
  assertEquals(checked.refusal, null);

  const steppedAside = await evaluateMakesafeSubstatusGate(
    gateClient({ data: null, error: POSTGREST_UNDEFINED_COLUMN }, {
      data: { status: "processing" },
      error: null,
    }),
    "job-b",
    "admin_to_send_report",
    unidentifiedOrigin("external"),
    deps,
  );
  assertEquals(steppedAside.result.outcome, "fail_open_unreadable");
  assertEquals(steppedAside.result.current_substatus, null);
  assertEquals(
    steppedAside.refusal,
    null,
    "the fail-open STAYS OPEN — it must never start refusing",
  );
  assertEquals(warned.length, 1);
});

Deno.test("the substatus alias map is injected, not duplicated — pending_allocation still normalises", async () => {
  // index.ts owns the alias; a second copy here is how the gate would drift
  // away from the board's reading of the same row.
  const decision = await evaluateMakesafeSubstatusGate(
    gateClient({ data: { substatus: "pending_allocation" }, error: null }, {
      data: { status: "processing" },
      error: null,
    }),
    "job-c",
    "waiting_on_trade_report",
    unidentifiedOrigin("external"),
    { normalizeSubstatus: _normalizeMakesafeSubstatus, warn: () => {} },
  );
  assertEquals(decision.result.current_substatus, "company_contact_required");
  assertEquals(
    decision.refusal,
    null,
    "company_contact_required -> waiting_on_trade_report is a coherent move",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Regression: the healthy-path refusals keep their exact behaviour. This item
// makes the gate audible, NOT stricter.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("regression: the cancelled/lost refusal still 409s on the healthy path", async () => {
  for (const jobState of ["cancelled", "lost"]) {
    const decision = await evaluateMakesafeSubstatusGate(
      gateClient({
        data: { substatus: "waiting_on_trade_report" },
        error: null,
      }, { data: { status: jobState }, error: null }),
      "job-d",
      "admin_to_send_report",
      unidentifiedOrigin("external"),
      { normalizeSubstatus: _normalizeMakesafeSubstatus, warn: () => {} },
    );
    assertEquals(decision.refusal?.status, 409);
    assertEquals(decision.refusal?.rule, "job_terminal");
    assertStringIncludes(decision.refusal!.message, `job is ${jobState}`);
  }
});

Deno.test("regression: intake sources are still exempt from the cancelled/lost refusal", async () => {
  const decision = await evaluateMakesafeSubstatusGate(
    gateClient(
      { data: { substatus: "waiting_on_trade_report" }, error: null },
      { data: { status: "cancelled" }, error: null },
    ),
    "job-e",
    "admin_to_send_report",
    intakeOrigin("recover"),
    { normalizeSubstatus: _normalizeMakesafeSubstatus, warn: () => {} },
  );
  assertEquals(decision.refusal, null);
});

Deno.test("regression: an incoherent transition still 409s, and a coherent one still passes", async () => {
  const deps = {
    normalizeSubstatus: _normalizeMakesafeSubstatus,
    warn: () => {},
  };

  const refused = await evaluateMakesafeSubstatusGate(
    gateClient(
      { data: { substatus: "company_contact_required" }, error: null },
      { data: { status: "processing" }, error: null },
    ),
    "job-f",
    "ready_to_invoice",
    unidentifiedOrigin("external"),
    deps,
  );
  assertEquals(refused.refusal?.status, 409);
  assertEquals(refused.refusal?.rule, "incoherent_transition");
  assertStringIncludes(refused.refusal!.message, "is not a coherent move");

  const allowed = await evaluateMakesafeSubstatusGate(
    gateClient({ data: { substatus: "admin_to_send_report" }, error: null }, {
      data: { status: "processing" },
      error: null,
    }),
    "job-g",
    "ready_to_invoice",
    unidentifiedOrigin("external"),
    deps,
  );
  assertEquals(allowed.refusal, null);
});

Deno.test("regression: an idempotent repeat is a clean CHECKED pass, not a step-aside", async () => {
  const decision = await evaluateMakesafeSubstatusGate(
    gateClient({ data: { substatus: "ready_to_invoice" }, error: null }, {
      data: { status: "processing" },
      error: null,
    }),
    "job-h",
    "ready_to_invoice",
    unidentifiedOrigin("external"),
    {
      normalizeSubstatus: _normalizeMakesafeSubstatus,
      warn: () => assert(false, "must not warn"),
    },
  );
  assertEquals(decision.result.outcome, "checked");
  assertEquals(decision.refusal, null);
});

Deno.test("the transition table moved module without changing a single edge", () => {
  // The table is the gate's business contract. Extracting it must not have
  // silently widened or narrowed one row.
  assertEquals(Object.keys(MAKESAFE_SUBSTATUS_TRANSITIONS).sort(), [
    "admin_to_send_report",
    "awaiting_portal_completion",
    "company_contact_done",
    "company_contact_required",
    "complete",
    "ready_to_invoice",
    "waiting_on_trade_report",
  ]);
  assertEquals(MAKESAFE_SUBSTATUS_TRANSITIONS.admin_to_send_report, [
    "waiting_on_trade_report",
    "awaiting_portal_completion",
    "ready_to_invoice",
    "complete",
  ]);
  assertEquals(MAKESAFE_SUBSTATUS_TRANSITIONS.complete, [
    "waiting_on_trade_report",
    "admin_to_send_report",
  ]);
});

// ─────────────────────────────────────────────────────────────────────────────
// The last-resort catch: kept, but under its OWN marker. PostgREST returns
// errors rather than throwing, so a throw here is a transport/client fault —
// a different incident, and it must never be counted as a query fail-open.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("a THROWN read logs the distinct read-threw marker, never the fail-open one", async () => {
  const warned: Array<{ m: string; p: any }> = [];
  const { client } = makeFakeClient({ readThrows: "fetch failed" });

  const decision = await evaluateMakesafeSubstatusGate(
    client as any,
    "job-i",
    "waiting_on_trade_report",
    internalEvidenceOrigin("trade_report"),
    {
      normalizeSubstatus: _normalizeMakesafeSubstatus,
      warn: (m, p) => warned.push({ m, p }),
    },
  );

  assertEquals(warned.length, 1, "one incident, one line");
  assertStringIncludes(warned[0].m, MAKESAFE_SUBSTATUS_GATE_READ_THREW_MARKER);
  assert(
    !warned[0].m.includes(MAKESAFE_SUBSTATUS_GATE_FAIL_OPEN_MARKER),
    "a transport fault must not be counted as a PostgREST fail-open",
  );
  assertEquals(warned[0].p.job_id, "job-i");
  // Still fails open, and still reports itself as unreadable rather than absent.
  assertEquals(decision.refusal, null);
  assertEquals(decision.result.outcome, "fail_open_unreadable");
  assertEquals(decision.result.detail_read, "unreadable");
  assertEquals(decision.result.job_read, "unreadable");
});
