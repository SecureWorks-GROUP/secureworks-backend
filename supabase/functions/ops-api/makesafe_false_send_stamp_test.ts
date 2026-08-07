// deno-lint-ignore-file no-explicit-any no-import-prefix
//
// Tests for the guarded false-`report_sent_at` correction
// (makesafe_false_send_stamp.ts). In-memory Supabase double, no network.
//
// The load-bearing cases are the REFUSALS. Clearing a stamp is easy; the whole
// point of this module is that it cannot clear the stamp of a card that really
// was sent — including the card whose only send record is reachable through
// `makesafe_release_revision_members`, because `ses_external_effects.job_id` is
// NULL on every route_send row and a direct job_id join reads as "never sent".
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  correctMakesafeFalseSendStamps,
  FALSE_SEND_STAMP_MAX_JOBS,
  FalseSendStampRequestError,
  readMakesafeSendEvidence,
} from "./makesafe_false_send_stamp.ts";

const JOB = "11111111-1111-1111-1111-111111111111";
const STAMP = "2026-06-30T00:12:51.200Z";

interface Store {
  [table: string]: any[];
}

class FakeQuery {
  private filters: Array<(row: any) => boolean> = [];
  constructor(
    private store: Store,
    private table: string,
    private op: "select" | "update" | "insert",
    private payload: any = null,
    private failTables: Set<string> = new Set(),
  ) {}
  eq(col: string, val: any) {
    this.filters.push((r) => String(r?.[col] ?? "") === String(val));
    return this;
  }
  in(col: string, vals: any[]) {
    const set = new Set(vals.map((v) => String(v)));
    this.filters.push((r) => set.has(String(r?.[col] ?? "")));
    return this;
  }
  order(_col: string, _opts?: any) {
    return this;
  }
  range(from: number, to: number) {
    this.window = [from, to];
    return this;
  }
  select(_cols?: string) {
    return this;
  }
  private window: [number, number] | null = null;
  private rows() {
    const matched = (this.store[this.table] || []).filter((r) =>
      this.filters.every((f) => f(r))
    );
    if (!this.window) return matched;
    return matched.slice(this.window[0], this.window[1] + 1);
  }
  private settle() {
    if (this.failTables.has(this.table)) {
      return { data: null, error: { message: `${this.table} unreadable` } };
    }
    if (this.op === "update") {
      // Snapshot the matched rows BEFORE writing: a compare-and-set update
      // filters on the value it is about to overwrite, so re-reading after the
      // write would report zero rows affected on a successful update.
      const matched = this.rows();
      for (const row of matched) Object.assign(row, this.payload);
      return { data: matched, error: null };
    }
    if (this.op === "insert") {
      (this.store[this.table] ||= []).push(this.payload);
      return { data: [this.payload], error: null };
    }
    return { data: this.rows(), error: null };
  }
  maybeSingle() {
    const r = this.settle();
    if (r.error) return Promise.resolve(r);
    return Promise.resolve({ data: (r.data || [])[0] ?? null, error: null });
  }
  then(res: any, rej?: any) {
    return Promise.resolve(this.settle()).then(res, rej);
  }
  catch(fn: any) {
    return Promise.resolve(this.settle()).catch(fn);
  }
}

function fakeClient(store: Store, failTables: string[] = []) {
  const fail = new Set(failTables);
  return {
    from(table: string) {
      return {
        select: (cols?: string) =>
          new FakeQuery(store, table, "select", null, fail).select(cols),
        update: (payload: any) => new FakeQuery(store, table, "update", payload, fail),
        insert: (payload: any) => new FakeQuery(store, table, "insert", payload, fail),
      };
    },
  };
}

/** A card with a false stamp and no send on any surface. */
function baseStore(overrides: Partial<Store> = {}): Store {
  return {
    jobs: [{ id: JOB, job_number: "SWMS-26851" }],
    makesafe_job_details: [
      { job_id: JOB, report_sent_at: STAMP, substatus: "ready_to_invoice" },
    ],
    ses_release_route_proofs: [],
    makesafe_release_revision_members: [],
    ses_external_effects: [],
    makesafe_report_packs: [],
    job_events: [],
    ...overrides,
  };
}

const okBody = (extra: any = {}) => ({
  job_ids: [JOB],
  expected_report_sent_at: { [JOB]: STAMP },
  reason: "retired ready_to_invoice auto-stamp; no send on any surface",
  ...extra,
});

// ── The happy path, and the fact that it is a preview by default ─────────────

Deno.test("dry run is the default: it reports would_clear and writes nothing", async () => {
  const store = baseStore();
  const res = await correctMakesafeFalseSendStamps(fakeClient(store), okBody());
  assertEquals(res.dry_run, true);
  assertEquals(res.would_clear, 1);
  assertEquals(res.cleared, 0);
  assertEquals(res.results[0].outcome, "would_clear");
  // the row is untouched
  assertEquals(store.makesafe_job_details[0].report_sent_at, STAMP);
  assertEquals(store.job_events.length, 0);
});

Deno.test("dry_run:false clears the stamp and writes one audit event", async () => {
  const store = baseStore();
  const res = await correctMakesafeFalseSendStamps(
    fakeClient(store),
    okBody({ dry_run: false }),
    { actor: "ops-api:api_key" },
  );
  assertEquals(res.cleared, 1);
  assertEquals(res.results[0].before_report_sent_at, STAMP);
  assertEquals(res.results[0].after_report_sent_at, null);
  assertEquals(store.makesafe_job_details[0].report_sent_at, null);
  // substatus is NOT touched — this corrects evidence, never placement.
  assertEquals(store.makesafe_job_details[0].substatus, "ready_to_invoice");
  assertEquals(store.job_events.length, 1);
  const ev = store.job_events[0];
  assertEquals(ev.event_type, "makesafe_evidence_correction");
  assertEquals(ev.detail_json.field, "report_sent_at");
  assertEquals(ev.detail_json.before_report_sent_at, STAMP);
  assertEquals(ev.detail_json.actor, "ops-api:api_key");
  assert(ev.detail_json.send_evidence, "audit event records the surfaces checked");
});

Deno.test("it is idempotent: a second apply refuses no_stamp_to_clear", async () => {
  const store = baseStore();
  const client = fakeClient(store);
  await correctMakesafeFalseSendStamps(client, okBody({ dry_run: false }));
  const second = await correctMakesafeFalseSendStamps(client, okBody({ dry_run: false }));
  assertEquals(second.cleared, 0);
  assertEquals(second.results[0].outcome, "refused");
  assertEquals(second.results[0].refusal_code, "no_stamp_to_clear");
  assertEquals(store.job_events.length, 1, "no second audit event");
});

// ── The refusals that make this safe ─────────────────────────────────────────

Deno.test("REFUSES a card whose send is only reachable via release members (the NULL job_id trap)", async () => {
  // ses_external_effects.job_id is NULL on every route_send row. A direct
  // job_id join returns zero and reads as "nothing sent" — which would erase a
  // real send record. The membership join is what catches it.
  const store = baseStore({
    makesafe_release_revision_members: [{ job_id: JOB, release_revision_id: "rev-1" }],
    ses_external_effects: [
      { id: "e1", job_id: null, release_revision_id: "rev-1", effect_kind: "route_send" },
    ],
  });
  const res = await correctMakesafeFalseSendStamps(
    fakeClient(store),
    okBody({ dry_run: false }),
  );
  assertEquals(res.results[0].outcome, "refused");
  assertEquals(res.results[0].refusal_code, "send_evidence_present");
  assertEquals(
    res.results[0].send_evidence?.surfaces.ses_external_effects_via_release_members,
    1,
  );
  assertEquals(store.makesafe_job_details[0].report_sent_at, STAMP, "stamp preserved");
});

Deno.test("REFUSES on a route proof", async () => {
  const store = baseStore({ ses_release_route_proofs: [{ id: "p1", job_id: JOB }] });
  const res = await correctMakesafeFalseSendStamps(fakeClient(store), okBody({ dry_run: false }));
  assertEquals(res.results[0].refusal_code, "send_evidence_present");
  assertEquals(store.makesafe_job_details[0].report_sent_at, STAMP);
});

Deno.test("REFUSES on a durable sent pack row", async () => {
  const store = baseStore({ makesafe_report_packs: [{ job_id: JOB, status: "sent" }] });
  const res = await correctMakesafeFalseSendStamps(fakeClient(store), okBody({ dry_run: false }));
  assertEquals(res.results[0].refusal_code, "send_evidence_present");
  assertEquals(store.makesafe_job_details[0].report_sent_at, STAMP);
});

Deno.test("REFUSES on the legacy MAKESAFE_PACK_SENT marker (28 of 33 live stamps are this case)", async () => {
  const store = baseStore({
    job_events: [
      { id: "e", job_id: JOB, event_type: "note_added", detail_json: { note: "MAKESAFE_PACK_SENT | main" } },
    ],
  });
  const res = await correctMakesafeFalseSendStamps(fakeClient(store), okBody({ dry_run: false }));
  assertEquals(res.results[0].refusal_code, "send_evidence_present");
  assertEquals(res.results[0].send_evidence?.surfaces.legacy_pack_sent_marker, 1);
  assertEquals(store.makesafe_job_details[0].report_sent_at, STAMP);
});

Deno.test("an UNREADABLE send surface fails closed — it never reads as 'no send'", async () => {
  const store = baseStore();
  const res = await correctMakesafeFalseSendStamps(
    fakeClient(store, ["ses_release_route_proofs"]),
    okBody({ dry_run: false }),
  );
  assertEquals(res.results[0].outcome, "refused");
  assertEquals(res.results[0].refusal_code, "send_evidence_present");
  assertEquals(res.results[0].send_evidence?.surfaces.ses_release_route_proofs, "unreadable");
  assertEquals(store.makesafe_job_details[0].report_sent_at, STAMP);
});

Deno.test("REFUSES when the stamp moved since it was measured", async () => {
  const store = baseStore();
  const res = await correctMakesafeFalseSendStamps(
    fakeClient(store),
    okBody({ expected_report_sent_at: { [JOB]: "2020-01-01T00:00:00.000Z" }, dry_run: false }),
  );
  assertEquals(res.results[0].refusal_code, "stamp_drift");
  assertEquals(store.makesafe_job_details[0].report_sent_at, STAMP);
});

Deno.test("REFUSES a job with no expectation supplied", async () => {
  const store = baseStore();
  const res = await correctMakesafeFalseSendStamps(
    fakeClient(store),
    { job_ids: [JOB], expected_report_sent_at: {}, reason: "r", dry_run: false },
  );
  assertEquals(res.results[0].refusal_code, "expectation_missing");
  assertEquals(store.makesafe_job_details[0].report_sent_at, STAMP);
});

// ── Shape guards ─────────────────────────────────────────────────────────────

Deno.test("there is NO path that sets a stamp: the payload is always null", async () => {
  const store = baseStore();
  const captured: any[] = [];
  const client = fakeClient(store);
  const orig = client.from.bind(client);
  (client as any).from = (t: string) => {
    const q = orig(t);
    const origUpdate = q.update.bind(q);
    q.update = (payload: any) => {
      if (t === "makesafe_job_details") captured.push(payload);
      return origUpdate(payload);
    };
    return q;
  };
  await correctMakesafeFalseSendStamps(client, okBody({ dry_run: false }));
  assertEquals(captured.length, 1);
  assertEquals(captured[0].report_sent_at, null);
  assert(!("substatus" in captured[0]), "never writes substatus");
});

Deno.test("requires job_ids, a reason and an expectation map; caps the batch", async () => {
  const client = fakeClient(baseStore());
  await assertRejects(() => correctMakesafeFalseSendStamps(client, { job_ids: [] }));
  await assertRejects(() =>
    correctMakesafeFalseSendStamps(client, { job_ids: [JOB], expected_report_sent_at: { [JOB]: STAMP } })
  );
  await assertRejects(() => correctMakesafeFalseSendStamps(client, { job_ids: [JOB], reason: "r" }));
  await assertRejects(() =>
    correctMakesafeFalseSendStamps(client, {
      job_ids: Array.from({ length: FALSE_SEND_STAMP_MAX_JOBS + 1 }, (_, i) => `j${i}`),
      expected_report_sent_at: {},
      reason: "r",
    })
  );
});

Deno.test("a validation fault is a typed 400, not a 500-shaped plain Error", async () => {
  const client = fakeClient(baseStore());
  for (
    const body of [
      { job_ids: [] },
      { job_ids: [JOB], expected_report_sent_at: { [JOB]: STAMP } }, // no reason
      { job_ids: [JOB], reason: "r" }, // no expectation map
    ]
  ) {
    const err = await correctMakesafeFalseSendStamps(client, body).then(
      () => null,
      (e) => e,
    );
    assert(
      err instanceof FalseSendStampRequestError,
      "the router maps this class to 400; a plain Error surfaces as an outage",
    );
    assertEquals((err as FalseSendStampRequestError).status, 400);
  }
});

Deno.test("the legacy marker is found beyond the first page of job_events", async () => {
  // The scan is paged so a long history cannot pull every event body into one
  // isolate — but a marker on a later page must still refuse.
  const events = Array.from({ length: 450 }, (_, i) => ({
    id: `e${String(i).padStart(4, "0")}`,
    job_id: JOB,
    event_type: "status_change",
    detail_json: { note: `routine ${i}` },
  }));
  events[430] = {
    id: "e0430",
    job_id: JOB,
    event_type: "note_added",
    detail_json: { note: "MAKESAFE_PACK_SENT | main | INV-0700" },
  };
  const store = baseStore({ job_events: events });
  const res = await correctMakesafeFalseSendStamps(
    fakeClient(store),
    okBody({ dry_run: false }),
  );
  assertEquals(res.results[0].refusal_code, "send_evidence_present");
  assertEquals(res.results[0].send_evidence?.surfaces.legacy_pack_sent_marker, 1);
  assertEquals(store.makesafe_job_details[0].report_sent_at, STAMP);
});

Deno.test("a history longer than the scan ceiling is unreadable, never 'no marker'", async () => {
  const events = Array.from({ length: 4200 }, (_, i) => ({
    id: `e${String(i).padStart(5, "0")}`,
    job_id: JOB,
    event_type: "status_change",
    detail_json: { note: `routine ${i}` },
  }));
  const ev = await readMakesafeSendEvidence(
    fakeClient(baseStore({ job_events: events })),
    JOB,
  );
  assertEquals(ev.surfaces.legacy_pack_sent_marker, "unreadable");
  assertEquals(ev.sent, true);
});

Deno.test("the clear is a compare-and-set: a stamp that moves mid-apply is a lost race, not a silent overwrite", async () => {
  const store = baseStore();
  const client = fakeClient(store);
  const orig = client.from.bind(client);
  (client as any).from = (t: string) => {
    const q = orig(t);
    if (t === "makesafe_job_details") {
      const origUpdate = q.update.bind(q);
      q.update = (payload: any) => {
        // Another writer (the unguarded update_makesafe_details door) moves the
        // stamp after the drift read and before this write.
        store.makesafe_job_details[0].report_sent_at = "2026-08-01T00:00:00.000Z";
        return origUpdate(payload);
      };
    }
    return q;
  };
  const res = await correctMakesafeFalseSendStamps(client, okBody({ dry_run: false }));
  assertEquals(res.cleared, 0);
  assertEquals(res.results[0].outcome, "refused");
  assertEquals(res.results[0].refusal_code, "stamp_drift");
  assertEquals(
    store.makesafe_job_details[0].report_sent_at,
    "2026-08-01T00:00:00.000Z",
    "the other writer's value is preserved, not clobbered",
  );
  assertEquals(store.job_events.length, 0, "no audit event for a clear that did not happen");
});

Deno.test("readMakesafeSendEvidence reports a clean card as not sent, with all four surfaces at zero", async () => {
  const ev = await readMakesafeSendEvidence(fakeClient(baseStore()), JOB);
  assertEquals(ev.sent, false);
  assertEquals(ev.surfaces, {
    ses_release_route_proofs: 0,
    ses_external_effects_via_release_members: 0,
    makesafe_report_packs_status: 0,
    legacy_pack_sent_marker: 0,
  });
});
