// M0 · U2 — First-contact + lead-source fixtures.
//
// Mission: sales-m0-data-truth-2026-07-05 (Lane A / U2). Verifier V re-runs this.
//
// Run from secureworks-backend/:
//   deno test --allow-net --allow-env --allow-read \
//     supabase/functions/_shared/evidence/first_contact_test.ts
//
// Self-contained: an in-memory PostgREST-like layer backs jobs / contact_matches
// / business_events / feature_flags. NO live DB. The real first_contact.ts
// helpers (and recordEvidence for the choke-point case) run against it, so the
// tested logic IS the shipped logic. Every scenario named in the contract is
// covered: idempotent replay, monotonic-min, unresolved->resolved backdating,
// and repeat-client two-episode freshness.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  computeEpisodeFirstContact,
  isFirstContactEligible,
  propagateJobFirstContactAndLeadSource,
  resolveLeadSource,
  stampContactFirstSeen,
  stampJobFirstContact,
} from "./first_contact.ts";
import { recordEvidence } from "./record_evidence.ts";
import { _resetFlagCache } from "./feature_flag.ts";

// ── Minimal in-memory PostgREST ─────────────────────────────────────────────
// Supports exactly the query surface first_contact.ts + record_evidence.ts use:
// select/insert/update, eq/neq/in/gt/lt/is/not, order/limit/range/maybeSingle,
// count head, and .or('a.is.null,a.gt.X') guarded predicates.

type Row = Record<string, unknown>;

function cmp(a: unknown, b: unknown): number {
  const da = Date.parse(String(a)), db = Date.parse(String(b));
  if (!Number.isNaN(da) && !Number.isNaN(db)) return da - db;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function parseOr(orStr: string): (r: Row) => boolean {
  const clauses = orStr.split(",").map((c) => {
    const [col, op, ...rest] = c.split(".");
    const val = rest.join(".");
    return { col, op, val };
  });
  return (r: Row) =>
    clauses.some(({ col, op, val }) => {
      if (op === "is" && val === "null") return r[col] == null;
      if (op === "gt") return r[col] != null && cmp(r[col], val) > 0;
      if (op === "lt") return r[col] != null && cmp(r[col], val) < 0;
      return false;
    });
}

function makeDb(seed: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = {};
  for (const [k, v] of Object.entries(seed)) tables[k] = v.map((r) => ({ ...r }));
  let idSeq = 1000;

  function builder(table: string) {
    const preds: Array<(r: Row) => boolean> = [];
    let orderCol: string | null = null;
    let asc = true;
    let limitN: number | null = null;
    let rangeFromTo: [number, number] | null = null;
    let mode: "select" | "update" | "insert" | "count" = "select";
    let patch: Row = {};
    let insertRows: Row[] = [];
    let headCount = false;

    const rows = () => (tables[table] ??= []);

    function apply(): Row[] {
      let out = rows().filter((r) => preds.every((p) => p(r)));
      if (orderCol) out = [...out].sort((a, b) => (asc ? 1 : -1) * cmp(a[orderCol!], b[orderCol!]));
      if (rangeFromTo) out = out.slice(rangeFromTo[0], rangeFromTo[1] + 1);
      if (limitN != null) out = out.slice(0, limitN);
      return out;
    }

    function run(): { data: unknown; error: null; count?: number } {
      if (mode === "count") {
        const n = rows().filter((r) => preds.every((p) => p(r))).length;
        return { data: null, error: null, count: n };
      }
      if (mode === "insert") {
        const added = insertRows.map((r) => {
          const row = { id: r.id ?? `row-${idSeq++}`, ...r };
          rows().push(row);
          return row;
        });
        return { data: added, error: null };
      }
      if (mode === "update") {
        const targets = rows().filter((r) => preds.every((p) => p(r)));
        for (const t of targets) Object.assign(t, patch);
        return { data: targets, error: null };
      }
      return { data: apply(), error: null };
    }

    const chain: Record<string, unknown> = {
      select(_cols?: string, opts?: { count?: string; head?: boolean }) {
        if (opts?.head) { mode = "count"; headCount = true; }
        return chain;
      },
      insert(v: Row | Row[]) { mode = "insert"; insertRows = Array.isArray(v) ? v : [v]; return chain; },
      update(p: Row) { mode = "update"; patch = p; return chain; },
      eq(c: string, v: unknown) { preds.push((r) => r[c] === v); return chain; },
      neq(c: string, v: unknown) { preds.push((r) => r[c] !== v); return chain; },
      gt(c: string, v: unknown) { preds.push((r) => r[c] != null && cmp(r[c], v) > 0); return chain; },
      lt(c: string, v: unknown) { preds.push((r) => r[c] != null && cmp(r[c], v) < 0); return chain; },
      is(c: string, _v: null) { preds.push((r) => r[c] == null); return chain; },
      not(c: string, _op: string, _v: null) { preds.push((r) => r[c] != null); return chain; },
      in(c: string, arr: unknown[]) { preds.push((r) => arr.includes(r[c])); return chain; },
      or(s: string) { preds.push(parseOr(s)); return chain; },
      order(c: string, o?: { ascending?: boolean }) { orderCol = c; asc = o?.ascending ?? true; return chain; },
      limit(n: number) { limitN = n; return thenable(); },
      range(a: number, b: number) { rangeFromTo = [a, b]; return thenable(); },
      maybeSingle() {
        const out = apply();
        return Promise.resolve({ data: out[0] ?? null, error: null });
      },
      single() {
        const r = run();
        const arr = r.data as Row[];
        return Promise.resolve({ data: arr?.[0] ?? null, error: null });
      },
    };

    function thenable() {
      (chain as Record<string, unknown>).then = (onf: (v: unknown) => unknown, onr?: (e: unknown) => unknown) =>
        Promise.resolve(run()).then(onf, onr);
      return chain;
    }
    // Make the base chain awaitable too (for calls that end at a filter).
    (chain as Record<string, unknown>).then = (onf: (v: unknown) => unknown, onr?: (e: unknown) => unknown) =>
      Promise.resolve(run()).then(onf, onr);
    return chain;
  }

  return {
    from: (t: string) => builder(t),
    _tables: tables,
  };
}

const ORG = "00000000-0000-0000-0000-000000000001";
function iso(s: string): string { return new Date(s).toISOString(); }

// ────────────────────────────────────────────────────────────────────────────
Deno.test("eligibility: only sms/call/email inbound|outbound count", () => {
  assert(isFirstContactEligible("sms", "inbound"));
  assert(isFirstContactEligible("call", "outbound"));
  assert(isFirstContactEligible("email", "inbound"));
  assert(!isFirstContactEligible("telegram", "inbound"));   // internal ops chatter
  assert(!isFirstContactEligible("quote", "outbound"));      // not a contact touch
  assert(!isFirstContactEligible("note", "internal"));
  assert(!isFirstContactEligible("sms", "internal"));         // wrong direction
  assert(!isFirstContactEligible("sms", null));
  assert(!isFirstContactEligible(null, "inbound"));
});

Deno.test("lifetime: monotonic-min, idempotent replay, backdates on late resolution", async () => {
  // Contact C1 has a contact_matches row. Events arrive out of order; one early
  // touch was 'unresolved' at write (contact_id null) and only becomes visible
  // once it carries the contact id (late resolution).
  const db = makeDb({
    contact_matches: [{ id: "cm1", ghl_contact_id: "C1", contact_first_seen_at: null, lead_source: null }],
    business_events: [
      { id: "e2", contact_id: "C1", channel: "sms", direction: "outbound", occurred_at: iso("2026-03-10T09:00:00Z"), job_id: null },
      { id: "e3", contact_id: "C1", channel: "email", direction: "inbound", occurred_at: iso("2026-03-12T09:00:00Z"), job_id: null },
      // e1 is the true earliest but was unresolved (contact_id null) at first.
      { id: "e1", contact_id: null, channel: "sms", direction: "inbound", occurred_at: iso("2026-03-08T09:00:00Z"), job_id: null },
    ],
  });

  // First stamp: only e2/e3 are visible for C1 -> earliest = 2026-03-10.
  const r1 = await stampContactFirstSeen(db, { ghlContactId: "C1" });
  assert(r1.changed);
  assertEquals(db._tables.contact_matches[0].contact_first_seen_at, iso("2026-03-10T09:00:00Z"));

  // Idempotent replay: nothing changes.
  const r2 = await stampContactFirstSeen(db, { ghlContactId: "C1" });
  assertEquals(r2.changed, false);
  assertEquals(db._tables.contact_matches[0].contact_first_seen_at, iso("2026-03-10T09:00:00Z"));

  // Late resolution: e1 now resolves to C1 (reconciler set its contact_id).
  db._tables.business_events.find((r) => r.id === "e1")!.contact_id = "C1";
  const r3 = await stampContactFirstSeen(db, { ghlContactId: "C1" });
  assert(r3.changed); // backdates to the true earliest
  assertEquals(db._tables.contact_matches[0].contact_first_seen_at, iso("2026-03-08T09:00:00Z"));

  // And replay is still idempotent after backdating.
  const r4 = await stampContactFirstSeen(db, { ghlContactId: "C1" });
  assertEquals(r4.changed, false);
  assertEquals(db._tables.contact_matches[0].contact_first_seen_at, iso("2026-03-08T09:00:00Z"));
});

Deno.test("lifetime: a later touch never overwrites an earlier stamp", async () => {
  const db = makeDb({
    contact_matches: [{ id: "cm1", ghl_contact_id: "C1", contact_first_seen_at: iso("2026-02-01T00:00:00Z"), lead_source: null }],
    business_events: [
      { id: "e1", contact_id: "C1", channel: "sms", direction: "inbound", occurred_at: iso("2026-05-01T00:00:00Z"), job_id: null },
    ],
  });
  const r = await stampContactFirstSeen(db, { ghlContactId: "C1" });
  // earliest visible touch (May) is LATER than the stored Feb value -> no change.
  assertEquals(r.changed, false);
  assertEquals(db._tables.contact_matches[0].contact_first_seen_at, iso("2026-02-01T00:00:00Z"));
});

Deno.test("episode: single episode stamps the pre-job inquiry + lead_source (form lead)", async () => {
  const db = makeDb({
    contact_matches: [{ id: "cm1", ghl_contact_id: "C1", lead_source: "google_ads", contact_first_seen_at: null }],
    jobs: [{
      id: "J1", ghl_contact_id: "C1", ghl_opportunity_id: "OPP1", created_at: iso("2026-03-15T00:00:00Z"),
      first_contacted_at: null, first_contact_channel: null, first_contact_direction: null, lead_source: null,
    }],
    business_events: [
      { id: "e1", contact_id: "C1", channel: "sms", direction: "inbound", occurred_at: iso("2026-03-10T08:00:00Z"), job_id: null },
      { id: "e2", contact_id: "C1", channel: "call", direction: "outbound", occurred_at: iso("2026-03-11T08:00:00Z"), job_id: "J1" },
    ],
  });
  const r = await propagateJobFirstContactAndLeadSource(db, { jobId: "J1" });
  assert(r.changed);
  const j = db._tables.jobs[0];
  assertEquals(j.first_contacted_at, iso("2026-03-10T08:00:00Z")); // the inquiry, pre-job
  assertEquals(j.first_contact_channel, "sms");
  assertEquals(j.first_contact_direction, "inbound");
  assertEquals(j.lead_source, "google_ads"); // form attribution propagated

  // Idempotent re-run.
  const r2 = await propagateJobFirstContactAndLeadSource(db, { jobId: "J1" });
  assertEquals(r2.changed, false);
  assertEquals(db._tables.jobs[0].first_contacted_at, iso("2026-03-10T08:00:00Z"));
});

Deno.test("lead_source: non-form / unknown collapses to 'unattributed', never the channel", async () => {
  const db = makeDb({
    contact_matches: [{ id: "cm1", ghl_contact_id: "C2", lead_source: "unknown", contact_first_seen_at: null }],
    jobs: [{
      id: "J2", ghl_contact_id: "C2", ghl_opportunity_id: "OPP2", created_at: iso("2026-04-01T00:00:00Z"),
      first_contacted_at: null, lead_source: null,
    }],
    business_events: [
      { id: "e1", contact_id: "C2", channel: "sms", direction: "inbound", occurred_at: iso("2026-03-30T00:00:00Z"), job_id: null },
    ],
  });
  assertEquals(await resolveLeadSource(db, { ghlContactId: "C2" }), "unattributed");
  await propagateJobFirstContactAndLeadSource(db, { jobId: "J2" });
  assertEquals(db._tables.jobs[0].lead_source, "unattributed");
  // The channel ('sms') must never leak into lead_source.
  assert(db._tables.jobs[0].lead_source !== "sms");

  // A contact with no attribution row at all -> 'unattributed'.
  const db2 = makeDb({ contact_matches: [] });
  assertEquals(await resolveLeadSource(db2, { ghlContactId: "ZZZ" }), "unattributed");
});

Deno.test("repeat client: a second opportunity gets a FRESH episode stamp", async () => {
  // C3 is a repeat client. Episode A (OPP-A, job JA) ran Jan; its conversation's
  // last touch was 2026-01-20. Thirty days later the client inquires again,
  // spawning episode B (OPP-B, job JB). JB must stamp the NEW inquiry, not JA's.
  const db = makeDb({
    contact_matches: [{ id: "cm1", ghl_contact_id: "C3", lead_source: null, contact_first_seen_at: null }],
    jobs: [
      { id: "JA", ghl_contact_id: "C3", ghl_opportunity_id: "OPP-A", created_at: iso("2026-01-05T00:00:00Z"), first_contacted_at: null, lead_source: null },
      { id: "JB", ghl_contact_id: "C3", ghl_opportunity_id: "OPP-B", created_at: iso("2026-02-20T00:00:00Z"), first_contacted_at: null, lead_source: null },
    ],
    business_events: [
      // Episode A touches (linked to JA)
      { id: "a1", contact_id: "C3", channel: "sms", direction: "inbound", occurred_at: iso("2026-01-03T10:00:00Z"), job_id: "JA" },
      { id: "a2", contact_id: "C3", channel: "call", direction: "outbound", occurred_at: iso("2026-01-20T10:00:00Z"), job_id: "JA" },
      // Episode B inquiry (new, before JB created)
      { id: "b1", contact_id: "C3", channel: "sms", direction: "inbound", occurred_at: iso("2026-02-15T10:00:00Z"), job_id: null },
      { id: "b2", contact_id: "C3", channel: "email", direction: "inbound", occurred_at: iso("2026-02-18T10:00:00Z"), job_id: "JB" },
    ],
  });

  // Episode A first-contact = its earliest touch.
  const epA = await computeEpisodeFirstContact(db, db._tables.jobs[0] as any);
  assertEquals(epA?.occurred_at, iso("2026-01-03T10:00:00Z"));

  // Episode B first-contact = the NEW inquiry (after A's last activity), NOT a1.
  const epB = await computeEpisodeFirstContact(db, db._tables.jobs[1] as any);
  assertEquals(epB?.occurred_at, iso("2026-02-15T10:00:00Z"));

  await propagateJobFirstContactAndLeadSource(db, { jobId: "JA" });
  await propagateJobFirstContactAndLeadSource(db, { jobId: "JB" });
  assertEquals(db._tables.jobs[0].first_contacted_at, iso("2026-01-03T10:00:00Z"));
  assertEquals(db._tables.jobs[1].first_contacted_at, iso("2026-02-15T10:00:00Z"));
  // The repeat episode did NOT inherit episode A's timestamp.
  assert(db._tables.jobs[1].first_contacted_at !== db._tables.jobs[0].first_contacted_at);
});

Deno.test("episode: monotonic-min live stamp (stampJobFirstContact) never regresses", async () => {
  const db = makeDb({
    jobs: [{ id: "J1", first_contacted_at: iso("2026-03-10T00:00:00Z"), first_contact_channel: "sms", first_contact_direction: "inbound" }],
  });
  // A later touch must not overwrite.
  const r1 = await stampJobFirstContact(db, { jobId: "J1", occurredAt: iso("2026-03-20T00:00:00Z"), channel: "call", direction: "outbound" });
  assertEquals(r1.changed, false);
  assertEquals(db._tables.jobs[0].first_contacted_at, iso("2026-03-10T00:00:00Z"));
  // An earlier touch backdates.
  const r2 = await stampJobFirstContact(db, { jobId: "J1", occurredAt: iso("2026-03-01T00:00:00Z"), channel: "email", direction: "inbound" });
  assert(r2.changed);
  assertEquals(db._tables.jobs[0].first_contacted_at, iso("2026-03-01T00:00:00Z"));
  assertEquals(db._tables.jobs[0].first_contact_channel, "email");
});

Deno.test("dry_run writes nothing (backfill safety): plans the change, mutates no row", async () => {
  const db = makeDb({
    contact_matches: [{ id: "cm1", ghl_contact_id: "C1", contact_first_seen_at: null, lead_source: "google_ads" }],
    jobs: [{ id: "J1", ghl_contact_id: "C1", ghl_opportunity_id: "OPP1", created_at: iso("2026-03-15T00:00:00Z"), first_contacted_at: null, lead_source: null }],
    business_events: [
      { id: "e1", contact_id: "C1", channel: "sms", direction: "inbound", occurred_at: iso("2026-03-10T00:00:00Z"), job_id: null },
    ],
  });
  const jr = await propagateJobFirstContactAndLeadSource(db, { jobId: "J1", dry_run: true });
  const cr = await stampContactFirstSeen(db, { ghlContactId: "C1", dry_run: true });
  // Both report a planned change...
  assert(jr.changed);
  assertEquals(jr.patch?.first_contacted_at, iso("2026-03-10T00:00:00Z"));
  assertEquals(jr.patch?.lead_source, "google_ads");
  assert(cr.changed);
  // ...but the store is untouched.
  assertEquals(db._tables.jobs[0].first_contacted_at, null);
  assertEquals(db._tables.jobs[0].lead_source, null);
  assertEquals(db._tables.contact_matches[0].contact_first_seen_at, null);
});

Deno.test("choke point: recordEvidence stamps when flag ON, and only then", async () => {
  function seed() {
    return {
      feature_flags: [
        { flag_name: "evidence_capture_v1", enabled: true },
        { flag_name: "first_contact_stamp_v1", enabled: true },
      ],
      contact_matches: [{ id: "cm1", ghl_contact_id: "C9", contact_first_seen_at: null, lead_source: null }],
      jobs: [{ id: "J9", ghl_contact_id: "C9", first_contacted_at: null }],
      business_events: [] as Row[],
    };
  }
  const capture = {
    event_type: "client.sms_in",
    source: "test",
    source_table: "sms_messages",
    source_id: "sms-1",
    channel: "sms" as const,
    direction: "inbound" as const,
    job_id: "J9",
    contact_id: "C9",
    match_method: "contact_id" as const,
    match_confidence: 0.95,
    occurred_at: iso("2026-06-01T00:00:00Z"),
  };

  // Flag ON -> both grains stamped.
  _resetFlagCache();
  const dbOn = makeDb(seed());
  await recordEvidence(dbOn, capture, { org_id: ORG });
  assertEquals(dbOn._tables.jobs[0].first_contacted_at, iso("2026-06-01T00:00:00Z"));
  assertEquals(dbOn._tables.contact_matches[0].contact_first_seen_at, iso("2026-06-01T00:00:00Z"));

  // Flag OFF (capture still on) -> spine row written, NO stamping.
  _resetFlagCache();
  const off = seed();
  off.feature_flags[1].enabled = false;
  const dbOff = makeDb(off);
  await recordEvidence(dbOff, capture, { org_id: ORG });
  assertEquals(dbOff._tables.jobs[0].first_contacted_at, null);
  assertEquals(dbOff._tables.contact_matches[0].contact_first_seen_at, null);
  // The spine row was still captured (capture flag independent).
  assert(dbOff._tables.business_events.length >= 1);
});
