// deno-lint-ignore-file no-import-prefix no-explicit-any
//
// ── Rescue SES remainder item 2: writeMakesafeSubstatus is behaviour-preserving ─
// Spec: coding/work/campaigns/makesafe-system/SPEC.md item 2, acceptance checks
// "each of the eight origins still produces the same substatus outcome and the
// same timestamp fields as before the change" and "the cancelled/lost refusal,
// the money fence and the transition table each still fire through the helper,
// exercised via the actions that reach them".
//
// The eight origins used to PASTE the gate ahead of their own `.update(...)`.
// They now share one writer. A refactor of eight production write sites on the
// board's only coherence gate is exactly where "a safety property quietly
// dropped while a feature was added" happens, so what is asserted here is the
// PostgREST request each origin issues — table, payload keys, filter order,
// select columns, row modifier — not merely that the call returned ok.
//
// The fake client RECORDS the builder chain in call order. A chain that changed
// shape (a `.select()` that appeared where there was none, a compare-and-set
// filter that moved) shows up as a different transcript, which is the failure
// mode a `{ ok: true }` assertion cannot see.
//
// Coverage, stated honestly. Three of the eight origins are driven end-to-end
// here (`external:details`, the dispatch/`updateMakesafeSubstatus` door, and
// `internal:portal_report_done`) because their fakes are cheap. The other five
// —`internal:trade_report_submitted`, `internal:roof_report_submitted`,
// `internal:draft_pack_ready`, `internal:closeout`, `internal:reattend` — are
// covered by their own existing suites, which pass with a byte-identical
// pass/fail set across this change, and their chain SHAPES are pinned by the
// options each passes to the writer plus `makesafe_substatus_single_writer_test.ts`.
// This file does not claim to drive all eight.
//
// Run: ~/.deno/bin/deno test --no-check --allow-env --allow-net=127.0.0.1 \
//        --allow-read supabase/functions/ops-api/makesafe_substatus_writer_behaviour_test.ts

import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _markMakesafePortalReportDone,
  _updateMakesafeDetails,
  _updateMakesafeSubstatus,
  _writeMakesafeSubstatus,
} from "./index.ts";
import {
  intakeOrigin,
  internalEvidenceOrigin,
  unidentifiedOrigin,
} from "./makesafe_write_origin.ts";

// ── Recording fake PostgREST client ─────────────────────────────────────────
// Every builder method appends to `chain`, so the assertion is on the request
// that would be sent, not on a return value the fake chose.

interface Recorded {
  table: string;
  op: string;
  payload?: any;
  chain: string[];
}

interface FakeOpts {
  detailRead?: { data: any; error: any };
  jobRead?: { data: any; error: any };
  /** Result handed back to whatever terminal the write chain ends on. */
  writeResult?: { data: any; error: any };
}

function makeRecordingClient(opts: FakeOpts = {}) {
  const writes: Recorded[] = [];
  const events: any[] = [];
  const detailRead = opts.detailRead ?? { data: null, error: null };
  const jobRead = opts.jobRead ??
    { data: { status: "processing" }, error: null };
  const writeResult = opts.writeResult ??
    { data: { job_id: "job-1", substatus: "x" }, error: null };

  const client = {
    from(table: string) {
      return {
        select(_cols?: string) {
          const readChain: any = {
            eq: () => readChain,
            in: () => readChain,
            order: () => readChain,
            limit: () => readChain,
            maybeSingle: () =>
              Promise.resolve(table === "jobs" ? jobRead : detailRead),
            single: () =>
              Promise.resolve(table === "jobs" ? jobRead : detailRead),
            then: (ok: any, no: any) =>
              Promise.resolve({ data: [], error: null }).then(ok, no),
          };
          return readChain;
        },
        update(payload: any) {
          const rec: Recorded = { table, op: "update", payload, chain: [] };
          writes.push(rec);
          const chain: any = {
            eq: (k: string, v: any) => {
              rec.chain.push(`eq(${k}=${String(v)})`);
              return chain;
            },
            is: (k: string, v: any) => {
              rec.chain.push(`is(${k}=${String(v)})`);
              return chain;
            },
            in: () => chain,
            lte: () => chain,
            neq: () => chain,
            select: (cols?: string) => {
              rec.chain.push(`select(${cols === undefined ? "" : cols})`);
              return chain;
            },
            single: () => {
              rec.chain.push("single");
              return Promise.resolve(writeResult);
            },
            maybeSingle: () => {
              rec.chain.push("maybeSingle");
              return Promise.resolve(writeResult);
            },
            then: (ok: any, no: any) => {
              rec.chain.push("await");
              return Promise.resolve(writeResult).then(ok, no);
            },
          };
          return chain;
        },
        insert(row: any) {
          events.push({ table, ...row });
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
  };

  const detailWrites = () =>
    writes.filter((w) => w.table === "makesafe_job_details");
  return { client, writes, detailWrites, events };
}

// ─────────────────────────────────────────────────────────────────────────────
// A. The writer's own contract.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("writer: a refused transition throws 409 and issues ZERO updates", async () => {
  // Gate BEFORE update is the whole safety property. A test that only checked
  // the throw would pass even if the write had already gone out.
  const { client, detailWrites } = makeRecordingClient({
    detailRead: { data: { substatus: "complete" }, error: null },
  });
  const err = await assertRejects(
    () =>
      _writeMakesafeSubstatus(client, "job-1", {
        substatus: "ready_to_invoice",
      }, internalEvidenceOrigin("test")),
  ) as any;
  assertEquals(err.status, 409);
  assertEquals(
    detailWrites().length,
    0,
    "the update must not be issued on a refusal",
  );
});

Deno.test("writer: a cancelled job refuses 409 and issues ZERO updates", async () => {
  const { client, detailWrites } = makeRecordingClient({
    detailRead: { data: { substatus: "waiting_on_trade_report" }, error: null },
    jobRead: { data: { status: "cancelled" }, error: null },
  });
  const err = await assertRejects(
    () =>
      _writeMakesafeSubstatus(client, "job-1", {
        substatus: "admin_to_send_report",
      }, internalEvidenceOrigin("closeout")),
  ) as any;
  assertEquals(err.status, 409);
  assertEquals(detailWrites().length, 0);
});

Deno.test("writer: the internal:intake_ exemption from the cancelled guard survives EXACTLY", async () => {
  // Spec, verbatim: the exemption "is currently expressed as
  // source.startsWith('internal:intake_') … the exemption must survive with
  // identical behaviour". Same terminal job, same target substatus; only the
  // origin string differs from the test above, and the write must land.
  const { client, detailWrites } = makeRecordingClient({
    detailRead: { data: { substatus: "waiting_on_trade_report" }, error: null },
    jobRead: { data: { status: "cancelled" }, error: null },
  });
  const { error } = await _writeMakesafeSubstatus(
    client,
    "job-1",
    { substatus: "admin_to_send_report" },
    intakeOrigin("settlement"),
  );
  assertEquals(error, null);
  assertEquals(
    detailWrites().length,
    1,
    "the intake exemption must still let the write through",
  );
});

Deno.test("writer: a patch with no substatus is refused before any read or write", async () => {
  const { client, detailWrites } = makeRecordingClient();
  for (const bad of [{}, { substatus: null }, { substatus: "" }]) {
    const err = await assertRejects(
      () =>
        _writeMakesafeSubstatus(
          client,
          "job-1",
          bad,
          internalEvidenceOrigin("test"),
        ),
    ) as any;
    assertEquals(err.status, 500);
  }
  assertEquals(detailWrites().length, 0);
});

Deno.test("writer: each row shape issues exactly the request its origin issued before", async () => {
  const shapes: Array<[any, string[]]> = [
    // default (`single`) — external:details, updateMakesafeSubstatus, portal_report_done
    [{}, ["eq(job_id=job-1)", "select()", "single"]],
    // trade_report_submitted / roof_report_submitted
    [
      { select: "job_id, substatus", row: "maybeSingle" },
      ["eq(job_id=job-1)", "select(job_id, substatus)", "maybeSingle"],
    ],
    // draft_pack_ready (array), closeout (array, bare select)
    [{ select: "job_id", row: "rows" }, [
      "eq(job_id=job-1)",
      "select(job_id)",
      "await",
    ]],
    [{ row: "rows" }, ["eq(job_id=job-1)", "select()", "await"]],
    // the reopen escape: NO select at all. A bare update and an update+select
    // are different PostgREST requests; `none` must not degrade into `select()`.
    [{ row: "none" }, ["eq(job_id=job-1)", "await"]],
  ];
  for (const [opts, expected] of shapes) {
    const { client, detailWrites } = makeRecordingClient();
    await _writeMakesafeSubstatus(
      client,
      "job-1",
      { substatus: "complete" },
      internalEvidenceOrigin("test"),
      opts,
    );
    assertEquals(
      detailWrites()[0].chain,
      expected,
      `row shape ${JSON.stringify(opts)}`,
    );
  }
});

Deno.test("writer: narrow filters land between eq(job_id) and select — reattend compare-and-set", async () => {
  const { client, detailWrites } = makeRecordingClient();
  await _writeMakesafeSubstatus(
    client,
    "job-1",
    { substatus: "waiting_on_trade_report" },
    internalEvidenceOrigin("reattend"),
    {
      select: "job_id, substatus",
      row: "maybeSingle",
      narrow: (q: any) =>
        q.eq("cycle_number", 1).eq("reattend_count", 0).is(
          "report_received_at",
          null,
        ),
    },
  );
  assertEquals(detailWrites()[0].chain, [
    "eq(job_id=job-1)",
    "eq(cycle_number=1)",
    "eq(reattend_count=0)",
    "is(report_received_at=null)",
    "select(job_id, substatus)",
    "maybeSingle",
  ]);
});

Deno.test("writer: updated_at is supplied only when the caller omitted it", async () => {
  // All eight of today's callers set it themselves, so this branch changes
  // nothing now. It is asserted directly rather than left as an unexercised
  // claim in a comment.
  const kept = makeRecordingClient();
  await _writeMakesafeSubstatus(
    kept.client,
    "job-1",
    { substatus: "complete", updated_at: "2020-01-01T00:00:00.000Z" },
    internalEvidenceOrigin("test"),
  );
  assertEquals(
    kept.detailWrites()[0].payload.updated_at,
    "2020-01-01T00:00:00.000Z",
  );

  const defaulted = makeRecordingClient();
  await _writeMakesafeSubstatus(defaulted.client, "job-1", {
    substatus: "complete",
  }, internalEvidenceOrigin("test"));
  assert(
    typeof defaulted.detailWrites()[0].payload.updated_at === "string",
    "a caller that omits updated_at gets one",
  );
});

Deno.test("writer: a PostgREST error is RETURNED, not thrown", async () => {
  // This is what lets all eight origins keep their own message, status code and
  // zero-rows handling. Backend AGENTS.md: PostgREST returns errors.
  const fault = { code: "42703", message: "column does not exist" };
  const { client } = makeRecordingClient({
    writeResult: { data: null, error: fault },
  });
  const { data, error } = await _writeMakesafeSubstatus(
    client,
    "job-1",
    { substatus: "complete" },
    internalEvidenceOrigin("closeout"),
    { row: "rows" },
  );
  assertEquals(data, null);
  assertEquals(error, fault);
});

// ─────────────────────────────────────────────────────────────────────────────
// B. Origin parity — the real actions, driven end to end.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("origin external: updateMakesafeSubstatus issues the same request as before", async () => {
  const { client, detailWrites, events } = makeRecordingClient({
    detailRead: {
      data: { substatus: "company_contact_required" },
      error: null,
    },
  });
  const res: any = await _updateMakesafeSubstatus(
    client,
    { job_id: "job-1", substatus: "waiting_on_trade_report" },
    { origin: internalEvidenceOrigin("invoice_advance") },
  );
  assertEquals(res.ok, true);
  const w = detailWrites();
  assertEquals(w.length, 1);
  assertEquals(Object.keys(w[0].payload).sort(), ["substatus", "updated_at"]);
  assertEquals(w[0].payload.substatus, "waiting_on_trade_report");
  assertEquals(w[0].chain, ["eq(job_id=job-1)", "select()", "single"]);
  // The job_events line still fires with the SAME changed_at as the patch.
  const ev = events.find((e) => e.event_type === "makesafe_substatus_changed");
  assertEquals(ev?.detail_json?.changed_at, w[0].payload.updated_at);
});

Deno.test("origin external: company_contacted_at is still stamped HERE, not by the writer", async () => {
  // Deliberately NOT hoisted into writeMakesafeSubstatus: the details editor can
  // also write company_contact_done and does not stamp it, so hoisting would
  // change that origin's output.
  const viaAction = makeRecordingClient({
    detailRead: {
      data: { substatus: "company_contact_required" },
      error: null,
    },
  });
  await _updateMakesafeSubstatus(viaAction.client, {
    job_id: "job-1",
    substatus: "company_contact_done",
  });
  assert(
    typeof viaAction.detailWrites()[0].payload.company_contacted_at ===
      "string",
    "the dispatch door still stamps company_contacted_at",
  );

  const viaWriter = makeRecordingClient({
    detailRead: {
      data: { substatus: "company_contact_required" },
      error: null,
    },
  });
  await _writeMakesafeSubstatus(
    viaWriter.client,
    "job-1",
    { substatus: "company_contact_done", updated_at: "now" },
    unidentifiedOrigin("external:details"),
  );
  assertEquals(
    viaWriter.detailWrites()[0].payload.company_contacted_at,
    undefined,
    "the writer must NOT invent the stamp for origins that never had it",
  );
});

Deno.test("origin external:details — a substatus edit goes through the writer, a plain edit does not", async () => {
  const withSubstatus = makeRecordingClient({
    detailRead: {
      data: { substatus: "company_contact_required" },
      error: null,
    },
  });
  await _updateMakesafeDetails(
    withSubstatus.client,
    { job_id: "job-1", substatus: "company_contact_done", invoice_notes: "n" },
    { authMode: "api_key" },
  );
  const w = withSubstatus.detailWrites();
  assertEquals(w.length, 1);
  assertEquals(w[0].payload.substatus, "company_contact_done");
  assertEquals(w[0].payload.invoice_notes, "n");
  assertEquals(w[0].chain, ["eq(job_id=job-1)", "select()", "single"]);

  // No substatus in the body -> ordinary details edit, same request as always,
  // and it must NOT acquire a gate it never had (the pre-reads would show as a
  // refusal here: the card's stored substatus is terminal for this target).
  const plain = makeRecordingClient({
    detailRead: { data: { substatus: "complete" }, error: null },
    jobRead: { data: { status: "cancelled" }, error: null },
  });
  const res: any = await _updateMakesafeDetails(plain.client, {
    job_id: "job-1",
    invoice_notes: "n",
  });
  assertEquals(
    res.ok,
    true,
    "a non-substatus details edit is not gated, before or after",
  );
  assertEquals(plain.detailWrites().length, 1);
  assertEquals(plain.detailWrites()[0].payload.substatus, undefined);
});

Deno.test("origin external:details — the routine-key money fence still refuses, with ZERO updates", async () => {
  // B3 (Wave 0): the automation routine key must never set sent/closed states.
  // It runs ahead of the writer, so the refusal must still land before any row
  // changes — a fence that refuses after the write is not a fence.
  const { client, detailWrites } = makeRecordingClient({
    detailRead: { data: { substatus: "admin_to_send_report" }, error: null },
  });
  const err = await assertRejects(
    () =>
      _updateMakesafeDetails(
        client,
        { job_id: "job-1", substatus: "ready_to_invoice" },
        { authMode: "routine" },
      ),
  ) as any;
  assertEquals(err.status, 403);
  assertEquals(detailWrites().length, 0);
});

Deno.test("origin internal:portal_report_done — same payload keys and same request", async () => {
  const { client, detailWrites, events } = makeRecordingClient({
    detailRead: {
      data: {
        job_id: "job-1",
        substatus: "waiting_on_trade_report",
        report_type: "roof",
        external_links: [],
        cycle_number: 2,
        portal_verified_at: null,
        portal_verified_cycle: null,
      },
      error: null,
    },
  });
  const res: any = await _markMakesafePortalReportDone(client, {
    job_id: "job-1",
    portal_url: "https://example.test/portal/abc",
  });
  assertEquals(res.ok, true);
  assertEquals(res.already_done, false);

  const w = detailWrites();
  assertEquals(w.length, 1);
  assertEquals(w[0].chain, ["eq(job_id=job-1)", "select()", "single"]);
  assertEquals(w[0].payload.substatus, "admin_to_send_report");
  // The evidence stamps this origin owns stay on this origin's patch.
  assertEquals(w[0].payload.report_received_at, w[0].payload.updated_at);
  assertEquals(w[0].payload.portal_verified_cycle, 2);
  assert(
    Array.isArray(w[0].payload.external_links),
    "the append-only link merge survives",
  );
  assert(events.some((e) => e.event_type === "makesafe_portal_report_done"));
});

Deno.test("origin internal:portal_report_done — the transition table still refuses through the writer", async () => {
  // A stored substatus with NO row in MAKESAFE_SUBSTATUS_TRANSITIONS has an
  // empty allow-list, so every move out of it is incoherent. That is the
  // table's own refusal, reached through the writer under this origin rather
  // than through a pasted assert.
  const { client, detailWrites } = makeRecordingClient({
    detailRead: { data: { substatus: "some_unmapped_state" }, error: null },
  });
  const err = await assertRejects(
    () =>
      _writeMakesafeSubstatus(
        client,
        "job-1",
        { substatus: "complete" },
        internalEvidenceOrigin("portal_report_done"),
      ),
  ) as any;
  assertEquals(err.status, 409);
  assertEquals(detailWrites().length, 0);
});
