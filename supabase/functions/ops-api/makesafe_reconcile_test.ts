// ════════════════════════════════════════════════════════════
// RECONCILIATION TESTS — D1-D4 (Mission makesafe-live-truth-2026-06-14)
// ════════════════════════════════════════════════════════════
//
// Pure-Deno, no network. Mirrors the makesafe_board_test.ts pattern.
//
// RUN:
//   ~/.deno/bin/deno test --allow-all --no-check \
//     supabase/functions/ops-api/makesafe_reconcile_test.ts
//
// Covers (per MISSION.md):
//   - D1 normalisation candidate matching + corroboration
//   - D1 both-direction alerts (email_no_job / job_no_email)
//   - D1 ambiguous -> needs_review (never auto-linked)
//   - D2 full-inventory missing-post alert
//   - verified-gate drift summary (unresolved D1/D2 blocks "verified")
//   - D4 canary present-within-SLA / absent-after-SLA / incomplete
//   - DB-bound action wiring: alerts route to the injected business_events sink

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  checkCanary,
  combineVerifiedGate,
  type DriftSummary,
  type KnownRef,
  makesafeEmailCanary,
  makesafeEmailReconcile,
  makesafeEmailReconcileFullInventory,
  normaliseReconRef,
  type PipelineRef,
  reconcileD1,
  reconcileD2Inventory,
  seedCanaryExpectation,
  summarizeDrift,
} from "./makesafe_reconcile.ts";
// The chunking budget constants are single-sourced in makesafe_compact_reads and
// imported by makesafe_reconcile; the chunking test asserts each `.in()` chunk
// stays within them.
import { IN_MAX_COUNT, IN_URL_BUDGET } from "./makesafe_compact_reads.ts";

// ── normaliseReconRef ─────────────────────────────────────────────────────────
Deno.test("normaliseReconRef: AJBR 67200 == AJBR-67200 == 67200 (>=5 chars)", () => {
  assertEquals(normaliseReconRef("AJBR 67200"), "AJBR-67200");
  assertEquals(normaliseReconRef("AJBR-67200"), "AJBR-67200");
  assertEquals(normaliseReconRef("67200"), "67200");
  assertEquals(normaliseReconRef("  ajbr-67200 "), "AJBR-67200");
  assertEquals(normaliseReconRef(null), null);
  assertEquals(normaliseReconRef(""), null);
});

// ── D1: exact + source-email matches; both-direction gaps ─────────────────────
Deno.test("D1: source_email_id identity is the highest-trust clean match", () => {
  const pipeline: PipelineRef[] = [
    { ref: "AJBR-67200", source_email_id: "post-1" },
  ];
  const board: KnownRef[] = [
    { external_ref: "AJBR-67200", source_email_id: "post-1", job_number: "SWMS-1", substatus: "complete" },
  ];
  const r = reconcileD1(pipeline, board);
  assertEquals(r.counts.matched, 1);
  assertEquals(r.matched[0].method, "source_email_id");
  assertEquals(r.alerts.length, 0);
});

Deno.test("D1: exact normalised ref is a clean match without corroboration", () => {
  const pipeline: PipelineRef[] = [{ ref: "AJBR 67200" }];
  const board: KnownRef[] = [
    { external_ref: "AJBR-67200", source_email_id: null, job_number: "SWMS-1", substatus: null },
  ];
  const r = reconcileD1(pipeline, board);
  assertEquals(r.counts.matched, 1);
  assertEquals(r.matched[0].method, "exact_ref");
  assertEquals(r.alerts.length, 0);
});

Deno.test("D1: email with no matching job -> email_no_job ERROR (dropped intake)", () => {
  const pipeline: PipelineRef[] = [{ ref: "AJBR-99999", source_email_id: "post-x" }];
  const board: KnownRef[] = [];
  const r = reconcileD1(pipeline, board);
  assertEquals(r.counts.email_no_job, 1);
  const a = r.alerts.find((x) => x.direction === "email_no_job")!;
  assertEquals(a.severity, "ERROR");
  assertEquals(a.ref, "AJBR-99999");
});

Deno.test("D1: board job with no synced email -> job_no_email WARN (suspect)", () => {
  // The four pinned manual-send refs: jobs exist on the board, no synced email.
  const pipeline: PipelineRef[] = [];
  const board: KnownRef[] = [
    { external_ref: "AJBR-67200", source_email_id: null, job_number: "SWMS-67200", substatus: "complete" },
    { external_ref: "67005", source_email_id: null, job_number: "SWMS-67005", substatus: "complete" },
  ];
  const r = reconcileD1(pipeline, board);
  assertEquals(r.counts.job_no_email, 2);
  assertEquals(r.alerts.every((a) => a.direction === "job_no_email" && a.severity === "WARN"), true);
});

Deno.test("D1: a draft (no job_number) with no email does NOT raise job_no_email", () => {
  const pipeline: PipelineRef[] = [];
  const board: KnownRef[] = [
    { external_ref: "AJBR-70000", source_email_id: "draft-email", job_number: null, substatus: null },
  ];
  const r = reconcileD1(pipeline, board);
  assertEquals(r.counts.job_no_email, 0);
});

// ── D1: numeric-core candidate matching + corroboration ───────────────────────
Deno.test("D1: bare-numeric vs prefixed ref needs corroboration; uncorroborated -> needs_review", () => {
  // pipeline has bare "67200"; board has "AJBR-67200" (same numeric core).
  const pipeline: PipelineRef[] = [
    { ref: "67200", source_email_id: "post-1", sender_domain: "random.com", received_at: "2020-01-01T00:00:00Z" },
  ];
  const board: KnownRef[] = [
    { external_ref: "AJBR-67200", source_email_id: null, job_number: "SWMS-1", substatus: null },
  ];
  const r = reconcileD1(pipeline, board, { trustedSenderDomains: new Set(["mlb.com.au"]), nowIso: "2026-06-14T00:00:00Z" });
  // No corroboration (untrusted domain + stale date) -> ambiguous, not auto-linked.
  assertEquals(r.counts.matched, 0);
  assertEquals(r.counts.ambiguous, 1);
  assertEquals(r.needs_review[0].reason, "numeric_core_uncorroborated");
});

Deno.test("D1: bare-numeric candidate WITH trusted-sender corroboration is a clean match", () => {
  const pipeline: PipelineRef[] = [
    { ref: "67200", source_email_id: "post-1", sender_domain: "mlb.com.au", received_at: "2020-01-01T00:00:00Z" },
  ];
  const board: KnownRef[] = [
    { external_ref: "AJBR-67200", source_email_id: null, job_number: "SWMS-1", substatus: null },
  ];
  const r = reconcileD1(pipeline, board, { trustedSenderDomains: new Set(["mlb.com.au"]) });
  assertEquals(r.counts.matched, 1);
  assertEquals(r.matched[0].method, "numeric_core_corroborated");
  assertEquals(r.counts.ambiguous, 0);
});

Deno.test("D1: date-proximity alone corroborates a numeric-core candidate", () => {
  const pipeline: PipelineRef[] = [
    { ref: "67200", source_email_id: "post-1", sender_domain: "unknown.com", received_at: "2026-06-13T00:00:00Z" },
  ];
  const board: KnownRef[] = [
    { external_ref: "AJBR-67200", source_email_id: null, job_number: "SWMS-1", substatus: null },
  ];
  const r = reconcileD1(pipeline, board, { nowIso: "2026-06-14T00:00:00Z", maxDayGap: 14 });
  assertEquals(r.counts.matched, 1);
  assertEquals(r.matched[0].method, "numeric_core_corroborated");
});

Deno.test("D1: corroborated but AMBIGUOUS (two board refs share the core) -> needs_review", () => {
  const pipeline: PipelineRef[] = [
    { ref: "67200", source_email_id: "post-1", sender_domain: "mlb.com.au" },
  ];
  const board: KnownRef[] = [
    { external_ref: "AJBR-67200", source_email_id: null, job_number: "SWMS-A", substatus: null },
    { external_ref: "MLB-67200", source_email_id: null, job_number: "SWMS-B", substatus: null },
  ];
  const r = reconcileD1(pipeline, board, { trustedSenderDomains: new Set(["mlb.com.au"]) });
  assertEquals(r.counts.matched, 0);
  assertEquals(r.counts.ambiguous, 1);
  assertEquals(r.needs_review[0].reason, "numeric_core_ambiguous");
});

// M3 — exact-ref maps to MULTIPLE distinct board jobs -> ambiguous, NEVER auto-pick.
Deno.test("D1: exact ref shared by two distinct jobs -> ambiguous needs_review (M3)", () => {
  const pipeline: PipelineRef[] = [{ ref: "AJBR-67200", source_email_id: "post-1" }];
  const board: KnownRef[] = [
    { external_ref: "AJBR-67200", source_email_id: null, job_number: "SWMS-A", substatus: null },
    { external_ref: "AJBR-67200", source_email_id: null, job_number: "SWMS-B", substatus: null },
  ];
  const r = reconcileD1(pipeline, board);
  // NOT auto-linked to either job.
  assertEquals(r.counts.matched, 0);
  assertEquals(r.counts.ambiguous, 1);
  assertEquals(r.needs_review[0].reason, "exact_ref_ambiguous_multiple_jobs");
  // And the two sharing jobs do NOT ALSO raise a job_no_email (email IS present).
  assertEquals(r.counts.job_no_email, 0);
});

Deno.test("D1: exact ref with a single job + a draft of the same ref still auto-matches (M3 not over-strict)", () => {
  const pipeline: PipelineRef[] = [{ ref: "AJBR-67201", source_email_id: "post-2" }];
  const board: KnownRef[] = [
    { external_ref: "AJBR-67201", source_email_id: null, job_number: "SWMS-A", substatus: null },
    { external_ref: "AJBR-67201", source_email_id: null, job_number: null, substatus: null }, // a draft, no job_number
  ];
  const r = reconcileD1(pipeline, board);
  assertEquals(r.counts.matched, 1);
  assertEquals(r.matched[0].method, "exact_ref");
  assertEquals(r.counts.ambiguous, 0);
});

// ── D2: full-post inventory ───────────────────────────────────────────────────
Deno.test("D2: a live post absent from the store raises a missing_post ERROR", () => {
  const live = ["post-1", "post-2", "post-3"];
  const stored = ["post-1", "post-3"]; // post-2 never ingested
  const r = reconcileD2Inventory(live, stored, { conversations: 1, threads: 2, posts: 3 });
  assertEquals(r.missing_post_ids, ["post-2"]);
  assertEquals(r.posts_seen, 3);
  assertEquals(r.posts_in_store, 2);
  const a = r.alerts[0];
  assertEquals(a.direction, "missing_post");
  assertEquals(a.severity, "ERROR");
  assertEquals(a.post_id, "post-2");
});

Deno.test("D2: full coverage -> zero missing, zero alerts", () => {
  const r = reconcileD2Inventory(["a", "b"], ["a", "b"]);
  assertEquals(r.missing_post_ids.length, 0);
  assertEquals(r.alerts.length, 0);
});

// ── Verified-gate drift summary ───────────────────────────────────────────────
Deno.test("drift: clean D1+D2 with no pending attachments is verified=OK", () => {
  const d1 = reconcileD1([{ ref: "AJBR-1", source_email_id: "p1" }], [{ external_ref: "AJBR-1", source_email_id: "p1", job_number: "J1", substatus: null }]);
  const d2 = reconcileD2Inventory(["p1"], ["p1"]);
  const s = summarizeDrift(d1, d2, 0);
  assertEquals(s.verified, true);
  assertEquals(s.mode, "OK");
});

Deno.test("drift: an email_no_job or missing_post blocks verified (ERROR)", () => {
  const d1 = reconcileD1([{ ref: "AJBR-X", source_email_id: "px" }], []);
  const s = summarizeDrift(d1, null, 0);
  assertEquals(s.verified, false);
  assertEquals(s.mode, "ERROR");

  const d2 = reconcileD2Inventory(["p1"], []);
  const s2 = summarizeDrift(null, d2, 0);
  assertEquals(s2.verified, false);
  assertEquals(s2.mode, "ERROR");
});

Deno.test("drift: pending attachments alone -> DEGRADED (not verified, not ERROR)", () => {
  const d1 = reconcileD1([], []);
  const s = summarizeDrift(d1, reconcileD2Inventory([], []), 3);
  assertEquals(s.verified, false);
  assertEquals(s.mode, "DEGRADED");
  assertEquals(s.unresolved_attachments, 3);
});

// ── D4 canary (pure) ──────────────────────────────────────────────────────────
const CANARY = {
  marker: "CANARY-2026-06-14-abc123",
  seeded_at: "2026-06-14T00:00:00Z",
  sla_minutes: 30,
  require_pdf: true,
  require_threaded_reply: true,
};

Deno.test("canary: present, with PDF + threaded reply, within SLA -> ok, no alert", () => {
  const { ok, alert } = checkCanary(CANARY, {
    marker: CANARY.marker,
    observed_at: "2026-06-14T00:05:00Z",
    has_pdf_attachment: true,
    has_threaded_reply: true,
  }, "2026-06-14T00:10:00Z");
  assertEquals(ok, true);
  assertEquals(alert, null);
});

Deno.test("canary: absent before SLA elapses -> no alert yet", () => {
  const { ok, alert } = checkCanary(CANARY, null, "2026-06-14T00:10:00Z");
  assertEquals(ok, false);
  assertEquals(alert, null);
});

Deno.test("canary: absent AFTER SLA elapses -> canary_missing ERROR", () => {
  const { ok, alert } = checkCanary(CANARY, null, "2026-06-14T01:00:00Z");
  assertEquals(ok, false);
  assertEquals(alert!.direction, "canary_missing");
  assertEquals(alert!.severity, "ERROR");
});

Deno.test("canary: present but missing PDF/threaded reply -> WARN incomplete", () => {
  const { ok, alert } = checkCanary(CANARY, {
    marker: CANARY.marker,
    observed_at: "2026-06-14T00:05:00Z",
    has_pdf_attachment: false,
    has_threaded_reply: true,
  }, "2026-06-14T00:10:00Z");
  assertEquals(ok, false);
  assertEquals(alert!.severity, "WARN");
  assert(alert!.detail.includes("pdf_attachment"));
});

// ════════════════════════════════════════════════════════════
// DB-bound action wiring (recording stubs; no network)
// ════════════════════════════════════════════════════════════

// A recording AlertSink — captures business_events + SMS calls.
function makeSink() {
  const events: any[] = [];
  const smsMessages: string[] = [];
  return {
    sink: {
      logBusinessEvent: async (_c: any, e: any) => { events.push(e); },
      notifySms: async (t: string) => { smsMessages.push(t); },
    },
    events,
    smsMessages,
  };
}

// A chainable Supabase stub that returns seeded rows per table and records upserts
// + inserts. Supports the call shapes the reconcile actions use:
//   .from(t).select(...).eq().gte().in()...                 -> { data }
//   .from(t).select(..., {count, head}).eq().in()           -> { count }
//   .from(t).select(...)...maybeSingle()                    -> { data }
//   .from(t).upsert(row, {onConflict})                      -> records, { error:null }
//   .from(t).insert(row)                                    -> records, { error:null }
//
// Error injection (for the fail-closed sweep):
//   countErrors[t]  -> the COUNT query on table t returns { count:null, error }
//   readErrors[t]   -> a non-count SELECT on table t returns { data:null, error }
//                      (covers list reads, .maybeSingle(), and .single())
//   writeErrors[t]  -> an upsert/insert/update on table t returns { error } (so we
//                      can prove an unchecked write that fails leaves the action
//                      FAILING CLOSED, not silently succeeding)
function makeReconClient(
  seed: Record<string, any[]>,
  counts: Record<string, number> = {},
  // FINDING 3 — tables listed here return an ERROR on their COUNT query (so we can
  // prove the attachment-count error is NOT coerced to 0). Maps table -> message.
  countErrors: Record<string, string> = {},
  // SWEEP — tables listed here return an ERROR on a non-count SELECT.
  readErrors: Record<string, string> = {},
  // BLOCKER 1/3 — tables listed here return an ERROR on upsert/insert/update.
  writeErrors: Record<string, string> = {},
) {
  const writes: Array<{ table: string; op: string; row: any }> = [];
  // CHUNK INSTRUMENTATION — every `.in(col, list)` call across every builder, so a
  // chunking test can assert the long-id list was split into multiple `.in()` reads
  // (each safely under the URL budget) AND that all matching rows came back.
  const inCalls: Array<{ table: string; column: string; list: any[] }> = [];
  function builder(table: string) {
    const rows = seed[table] || [];
    let isCount = false;
    // Captured `.in(col, list)` filters for THIS builder instance. A paginated/
    // chunked read makes ONE fresh builder per chunk (the factory returns a new
    // builder each call), so each builder sees exactly one chunk's id list.
    const inFilters: Array<{ column: string; list: any[] }> = [];
    const readErr = readErrors[table] ? { message: readErrors[table] } : null;
    const writeErr = writeErrors[table] ? { message: writeErrors[table] } : null;
    // Apply the captured `.in()` filters to the seeded rows so a chunked read
    // returns ONLY the rows whose id is in this chunk (mirrors PostgREST). With no
    // `.in()` filter, all seeded rows pass (existing tests rely on this).
    const filteredRows = () => {
      let out = rows;
      for (const f of inFilters) {
        const set = new Set(f.list);
        out = out.filter((r: any) => set.has(r?.[f.column]));
      }
      return out;
    };
    // .range(offset, to) is the pagination terminal. Page 0 returns the (filtered)
    // rows; subsequent offsets return an empty page so reconFetchAllRows stops.
    let ranged = false;
    const b: any = {
      select: (_c?: any, opts?: any) => { if (opts?.count) isCount = true; return b; },
      eq: () => b,
      neq: () => b,
      not: () => b,
      gte: () => b,
      lte: () => b,
      in: (column: string, list: any[]) => {
        inFilters.push({ column, list });
        inCalls.push({ table, column, list });
        return b;
      },
      or: () => b,
      order: () => b,
      limit: () => b,
      range: async (offset: number, _to: number) => {
        if (readErr) return { data: null, error: readErr };
        if (offset > 0 || ranged) return { data: [], error: null };
        ranged = true;
        return { data: filteredRows(), error: null };
      },
      maybeSingle: async () => readErr ? ({ data: null, error: readErr }) : ({ data: filteredRows()[0] ?? null, error: null }),
      single: async () => readErr ? ({ data: null, error: readErr }) : ({ data: filteredRows()[0] ?? null, error: null }),
      upsert: async (row: any, _o?: any) => { writes.push({ table, op: "upsert", row }); return { error: writeErr }; },
      insert: async (row: any) => { writes.push({ table, op: "insert", row }); return { error: writeErr }; },
      // N1 — .update(row).eq(...) chain (used to mark a passed canary resolved).
      update: (row: any) => {
        writes.push({ table, op: "update", row });
        return { eq: async () => ({ error: writeErr }) };
      },
      then: (resolve: (v: any) => any) => {
        if (isCount) {
          if (countErrors[table]) {
            // The count query errored: count is null + an error is returned.
            return resolve({ count: null, error: { message: countErrors[table] } });
          }
          return resolve({ count: counts[table] ?? 0, error: null });
        }
        if (readErr) return resolve({ data: null, error: readErr });
        return resolve({ data: filteredRows(), error: null });
      },
    };
    return b;
  }
  return { client: { from: (t: string) => builder(t) }, writes, inCalls };
}

Deno.test("action D1: email_no_job + job_no_email both fire business_events alerts", async () => {
  // pipeline_items has ref AJBR-77777 (-> no board job); board has SWMS-67200
  // job with ref AJBR-67200 (-> no synced email).
  const { client } = makeReconClient({
    pipeline_items: [
      { ref: "AJBR-77777", target_job: null, source_event_ids: ["ev-1"] },
    ],
    emails: [
      { post_id: "post-77777", from_email: "x@random.com", received_at: "2026-06-13T00:00:00Z", has_attachments: false },
    ],
    email_events_raw: [{ id: "ev-1", post_id: "post-77777" }],
    makesafe_companies: [{ sender_patterns: ["mlb.com.au"] }],
  }, { email_attachments: 0 });

  const { sink, events } = makeSink();
  const fakeAudit = async () => ({
    known_refs: [
      { external_ref: "AJBR-67200", source_email_id: null, job_number: "SWMS-67200", substatus: "complete" },
    ],
  });

  const res = await makesafeEmailReconcile(client, sink, { mode: "D1", makesafeAudit: fakeAudit, nowIso: "2026-06-14T00:00:00Z" });
  assertEquals(res.d1.counts.email_no_job, 1);
  assertEquals(res.d1.counts.job_no_email, 1);
  // Both alerts emitted as business_events.
  const types = events.map((e) => e.event_type);
  assert(types.includes("makesafe.reconcile.email_no_job"));
  assert(types.includes("makesafe.reconcile.job_no_email"));
  // Verified gate is blocked (an email_no_job is a hard fail).
  assertEquals(res.drift.verified, false);
  assertEquals(res.drift.mode, "ERROR");
});

Deno.test("action D2: a missing post id alerts + a scan log is persisted", async () => {
  const { client, writes } = makeReconClient({
    emails: [{ post_id: "post-A" }], // post-B will be missing
  });
  const { sink, events } = makeSink();

  const deps = {
    getGraphToken: async () => "tok",
    resolveGroupId: async (_t: string) => "group-1",
    collectPosts: async (_t: string, _g: string, _s: string) => ({
      posts: [{ id: "post-A" }, { id: "post-B" }],
      pageCounts: { conversations: 1, threads: 1, posts: 2 },
    }),
    nowIso: "2026-06-14T00:00:00Z",
  };

  const r = await makesafeEmailReconcileFullInventory(client, sink, deps);
  assertEquals(r.missing_post_ids, ["post-B"]);
  assert(events.some((e) => e.event_type === "makesafe.reconcile.missing_post"));
  // A D2 inventory scan log row is appended to email_events_raw.
  const scanLog = writes.find((w) => w.table === "email_events_raw" && w.row?.change_type === "inventory_scan");
  assert(scanLog, "expected a D2 inventory_scan log row");
  assertEquals(scanLog!.row.post_id, "_D2_INVENTORY_SCAN");
  assertEquals(scanLog!.row.page_meta.missing_count, 1);
});

Deno.test("action D4: an outstanding canary absent after SLA raises canary_missing", async () => {
  const { client } = makeReconClient({
    makesafe_canary_expectations: [
      { marker: "CANARY-X", seeded_at: "2026-06-14T00:00:00Z", sla_minutes: 30, require_pdf: true, require_threaded_reply: true, resolved: false },
    ],
    emails: [], // canary never landed
  });
  const { sink, events } = makeSink();
  const r = await makesafeEmailCanary(client, sink, { nowIso: "2026-06-14T02:00:00Z" });
  assertEquals(r.checked, 1);
  assertEquals(r.ok, 0);
  assert(events.some((e) => e.event_type === "makesafe.reconcile.canary_missing"));
});

Deno.test("action D1: clean state emits no alerts and reports verified=OK", async () => {
  const { client } = makeReconClient({
    pipeline_items: [{ ref: "AJBR-67200", target_job: "job-uuid", source_event_ids: ["ev-1"] }],
    emails: [{ post_id: "post-1", from_email: "dispatch@mlb.com.au", received_at: "2026-06-13T00:00:00Z" }],
    email_events_raw: [{ id: "ev-1", post_id: "post-1" }],
    makesafe_companies: [{ sender_patterns: ["mlb.com.au"] }],
    // B2/B3 — D2 has run clean and the historical floor is established, so the
    // COMBINED gate can claim verified on this clean D1 run.
    sync_state: [{
      recon_d2_verified: true,
      recon_d2_missing_posts: 0,
      recon_inventory_floor: "1970-01-01T00:00:00Z",
      recon_inventory_ceiling: "2026-06-14T00:00:00Z",
      // BLOCKER (atomic backfill) — a completed full backfill is now required to verify.
      backfill_complete: true,
    }],
  }, { email_attachments: 0 });
  const { sink, events } = makeSink();
  const fakeAudit = async () => ({
    known_refs: [{ external_ref: "AJBR-67200", source_email_id: null, job_number: "SWMS-67200", substatus: "complete" }],
  });
  const res = await makesafeEmailReconcile(client, sink, { mode: "D1", makesafeAudit: fakeAudit, nowIso: "2026-06-14T00:00:00Z" });
  assertEquals(res.d1.alerts.length, 0);
  assertEquals(events.length, 0);
  assertEquals(res.drift.verified, true);
  // Combined gate is verified because D2 last ran clean within established bounds.
  assertEquals(res.gate.recon_verified, true);
});

// ════════════════════════════════════════════════════════════
// B2/B3 — combined verified gate across SEPARATE D1 + D2 runs
// ════════════════════════════════════════════════════════════
const CLEAN_DRIFT: DriftSummary = {
  verified: true, mode: "OK", email_no_job: 0, job_no_email: 0, ambiguous: 0,
  missing_posts: 0, unresolved_attachments: 0, reason: "no unexplained drift",
};

Deno.test("B2: a clean D1 CANNOT claim verified while a persisted D2 drop is unresolved", () => {
  const gate = combineVerifiedGate(CLEAN_DRIFT, {
    otherVerified: false,
    d2MissingPosts: 3,             // a real D2 drop persists
    inventoryFloor: "1970-01-01T00:00:00Z",
    inventoryCeiling: "2026-06-14T00:00:00Z",
  });
  assertEquals(gate.recon_verified, false);
  assertEquals(gate.recon_mode, "ERROR");
  assert(gate.recon_reason.includes("persisted_d2_missing_posts=3"));
});

Deno.test("B2: a clean D1 with D2 never having run -> DEGRADED, not verified", () => {
  const gate = combineVerifiedGate(CLEAN_DRIFT, {
    otherVerified: null,           // D2 never ran
    d2MissingPosts: null,
    inventoryFloor: "1970-01-01T00:00:00Z",
    inventoryCeiling: "2026-06-14T00:00:00Z",
  });
  assertEquals(gate.recon_verified, false);
  assertEquals(gate.recon_mode, "DEGRADED");
  assert(gate.recon_reason.includes("other_check_never_ran"));
});

Deno.test("B3: verified requires the historical inventory floor to be established", () => {
  // Both checks clean, but no historical backfill yet -> coverage incomplete.
  const gate = combineVerifiedGate(CLEAN_DRIFT, {
    otherVerified: true,
    d2MissingPosts: 0,
    inventoryFloor: null,          // floor never established
    inventoryCeiling: "2026-06-14T00:00:00Z",
  });
  assertEquals(gate.recon_verified, false);
  assertEquals(gate.recon_mode, "DEGRADED");
  assert(gate.recon_reason.includes("inventory_floor_unestablished"));
});

Deno.test("B2+B3: both checks clean AND floor established AND no D2 drop -> verified", () => {
  // FINDING 2 — the ceiling must reach UP TO NOW (within the bounded skew), not
  // merely within a lookback window. Pin nowIso == ceiling so the freshness bound
  // is deterministically satisfied.
  const NOW = "2026-06-15T00:00:00Z";
  const gate = combineVerifiedGate(CLEAN_DRIFT, {
    otherVerified: true,
    d2MissingPosts: 0,
    inventoryFloor: "1970-01-01T00:00:00Z",
    inventoryCeiling: NOW,
    nowIso: NOW,
    backfillComplete: true,
  });
  assertEquals(gate.recon_verified, true);
  assertEquals(gate.recon_mode, "OK");
});

// ════════════════════════════════════════════════════════════
// B3 (STILL-OPEN fix) — recon_inventory_ceiling is now ENFORCED
// Pre-fix: combineVerifiedGate checked only the FLOOR; recon_verified could be set
// with a null OR stale ceiling, so a recent un-inventoried tail evaded detection.
// These pin nowIso so they are deterministic (not wall-clock dependent).
// ════════════════════════════════════════════════════════════
const NOW = "2026-06-15T00:00:00Z";

Deno.test("B3: a NULL ceiling -> NOT verified (ceiling now enforced, not just floor)", () => {
  const gate = combineVerifiedGate(CLEAN_DRIFT, {
    otherVerified: true,
    d2MissingPosts: 0,
    inventoryFloor: "1970-01-01T00:00:00Z",
    inventoryCeiling: null,           // computed-but-never-set; previously slipped through
    nowIso: NOW,
    coverageWindowDays: 7,
  });
  assertEquals(gate.recon_verified, false);
  assertEquals(gate.recon_mode, "DEGRADED");
  assert(gate.recon_reason.includes("inventory_ceiling_unestablished"));
});

Deno.test("B3: a STALE ceiling (older than the window) -> NOT verified", () => {
  // Ceiling is 60 days before NOW but the window only covers 7 days -> the recent
  // 53-day tail is un-inventoried, so verified must be blocked.
  const gate = combineVerifiedGate(CLEAN_DRIFT, {
    otherVerified: true,
    d2MissingPosts: 0,
    inventoryFloor: "1970-01-01T00:00:00Z",
    inventoryCeiling: "2026-04-16T00:00:00Z", // ~60 days before NOW
    nowIso: NOW,
    coverageWindowDays: 7,
  });
  assertEquals(gate.recon_verified, false);
  assertEquals(gate.recon_mode, "DEGRADED");
  assert(gate.recon_reason.includes("inventory_ceiling_stale_does_not_cover_window"));
});

Deno.test("B3: a NULL floor -> NOT verified (floor still required alongside ceiling)", () => {
  const gate = combineVerifiedGate(CLEAN_DRIFT, {
    otherVerified: true,
    d2MissingPosts: 0,
    inventoryFloor: null,
    inventoryCeiling: NOW,            // fresh ceiling, but no floor
    nowIso: NOW,
    coverageWindowDays: 7,
  });
  assertEquals(gate.recon_verified, false);
  assert(gate.recon_reason.includes("inventory_floor_unestablished"));
});

Deno.test("B3: floor + FRESH ceiling + both checks clean + no attachment backlog -> verified", () => {
  // The only path to verified: floor established, ceiling present AND reaching UP
  // TO NOW (within the bounded skew, finding 2), the other check clean, no D2 drop,
  // and zero attachment backlog. The ceiling is 30 min before NOW (< 1h skew).
  const gate = combineVerifiedGate(CLEAN_DRIFT, {
    otherVerified: true,
    d2MissingPosts: 0,
    inventoryFloor: "1970-01-01T00:00:00Z",
    inventoryCeiling: "2026-06-14T23:30:00Z", // 30 min before NOW (within 1h skew)
    nowIso: NOW,
    coverageWindowDays: 7,
    unresolvedAttachments: 0,
    backfillComplete: true,
  });
  assertEquals(gate.recon_verified, true);
  assertEquals(gate.recon_mode, "OK");
});

// ════════════════════════════════════════════════════════════
// ATTACHMENT-GATE (NEW MAJOR) — a non-zero attachment backlog blocks recon_verified
// on EITHER run, even when D1+D2 drift is otherwise clean. Pre-fix the D2 path
// passed 0 to summarizeDrift, so D2 could verify with attachments pending/failed.
// ════════════════════════════════════════════════════════════
Deno.test("attachment-gate: backlog > 0 blocks verified even with clean D1+D2 drift", () => {
  const gate = combineVerifiedGate(CLEAN_DRIFT, {
    otherVerified: true,
    d2MissingPosts: 0,
    inventoryFloor: "1970-01-01T00:00:00Z",
    inventoryCeiling: "2026-06-14T12:00:00Z",
    nowIso: NOW,
    coverageWindowDays: 7,
    unresolvedAttachments: 3,          // pending/failed/needs_review backlog
  });
  assertEquals(gate.recon_verified, false);
  assertEquals(gate.recon_mode, "DEGRADED");
  assert(gate.recon_reason.includes("unresolved_attachments=3"));
});

Deno.test("attachment-gate: the D2 ACTION blocks verified when a backlog exists (was passing 0)", async () => {
  // D2 sees full coverage (no missing posts) AND D1 last ran clean within bounds,
  // so the ONLY thing that can block verified is the live attachment backlog. This
  // proves the D2 path now folds the real backlog in (instead of the hard-coded 0).
  const { client, writes } = makeReconClient({
    emails: [{ post_id: "post-A" }],
    sync_state: [{
      recon_d1_verified: true,
      recon_inventory_floor: "1970-01-01T00:00:00Z",
      recon_inventory_ceiling: "2026-06-14T00:00:00Z",
    }],
  }, { email_attachments: 2 }); // 2 unresolved attachments for this mailbox
  const { sink } = makeSink();
  const deps = {
    getGraphToken: async () => "tok",
    resolveGroupId: async (_t: string) => "group-1",
    // Live traversal == store -> zero missing posts (D2 drift clean).
    collectPosts: async (_t: string, _g: string, _s: string) => ({
      posts: [{ id: "post-A" }],
      pageCounts: { conversations: 1, threads: 1, posts: 1 },
    }),
    historical: true,            // establishes the floor so only the backlog blocks
    nowIso: NOW,
  };
  const r = await makesafeEmailReconcileFullInventory(client, sink, deps);
  assertEquals(r.missing_post_ids.length, 0);       // D2 drift is clean
  assertEquals(r.gate.recon_verified, false);       // but verified is BLOCKED
  assert(r.gate.recon_reason.includes("unresolved_attachments=2"));
  // sync_state persisted the blocked gate.
  const ss = writes.find((w) => w.table === "sync_state" && w.op === "upsert")!;
  assertEquals(ss.row.recon_verified, false);
});

Deno.test("attachment-gate: the D2 ACTION verifies when the backlog is zero (control)", async () => {
  // Same as above but with zero backlog -> verified can be claimed (proves the
  // backlog is the ONLY blocker, not an unrelated regression).
  const { client } = makeReconClient({
    emails: [{ post_id: "post-A" }],
    sync_state: [{
      recon_d1_verified: true,
      recon_inventory_floor: "1970-01-01T00:00:00Z",
      recon_inventory_ceiling: "2026-06-14T00:00:00Z",
    }],
  }, { email_attachments: 0 });
  const { sink } = makeSink();
  const deps = {
    getGraphToken: async () => "tok",
    resolveGroupId: async (_t: string) => "group-1",
    collectPosts: async (_t: string, _g: string, _s: string) => ({
      posts: [{ id: "post-A" }],
      pageCounts: { conversations: 1, threads: 1, posts: 1 },
    }),
    historical: true,
    nowIso: NOW,
  };
  const r = await makesafeEmailReconcileFullInventory(client, sink, deps);
  assertEquals(r.missing_post_ids.length, 0);
  assertEquals(r.gate.recon_verified, true);
});

Deno.test("B2: a D1 run persists recon_d1_* + combined gate but NEVER writes recon_d2_*", async () => {
  const { client, writes } = makeReconClient({
    pipeline_items: [],
    emails: [],
    makesafe_companies: [{ sender_patterns: ["mlb.com.au"] }],
    // Persisted: D2 found a drop earlier and it is still unresolved.
    sync_state: [{ recon_d2_verified: false, recon_d2_missing_posts: 2, recon_inventory_floor: "1970-01-01T00:00:00Z" }],
  }, { email_attachments: 0 });
  const { sink } = makeSink();
  const fakeAudit = async () => ({ known_refs: [] });
  const res = await makesafeEmailReconcile(client, sink, { mode: "D1", makesafeAudit: fakeAudit, nowIso: "2026-06-14T00:00:00Z" });
  // D1 itself is clean, but the combined gate is blocked by the persisted D2 drop.
  assertEquals(res.gate.recon_verified, false);
  const ss = writes.find((w) => w.table === "sync_state" && w.op === "upsert")!;
  // D1 writes its own signal + the combined gate.
  assertEquals(ss.row.recon_d1_verified, true);
  assertEquals(typeof ss.row.recon_verified, "boolean");
  // B2: D1 must NOT touch any recon_d2_* column (it cannot clear D2's drift).
  assertEquals("recon_d2_verified" in ss.row, false);
  assertEquals("recon_d2_missing_posts" in ss.row, false);
});

// ════════════════════════════════════════════════════════════
// M2 — D2 excludes terminal (classifier-excluded) posts from missing
// ════════════════════════════════════════════════════════════
Deno.test("M2: a legitimately-excluded post is NOT reported as missing by D2", async () => {
  const { client, writes } = makeReconClient({
    emails: [{ post_id: "post-A" }],                       // make-safe, ingested
    email_classifier_exclusions: [{ post_id: "post-EXCL" }], // excluded (terminal)
  });
  const { sink, events } = makeSink();
  const deps = {
    getGraphToken: async () => "tok",
    resolveGroupId: async (_t: string) => "group-1",
    collectPosts: async (_t: string, _g: string, _s: string) => ({
      // Live traversal sees the ingested one, the excluded one, AND a real drop.
      posts: [{ id: "post-A" }, { id: "post-EXCL" }, { id: "post-DROP" }],
      pageCounts: { conversations: 1, threads: 1, posts: 3 },
    }),
    nowIso: "2026-06-14T00:00:00Z",
  };
  const r = await makesafeEmailReconcileFullInventory(client, sink, deps);
  // Only the real drop is flagged; the excluded post passes (no false alarm).
  assertEquals(r.missing_post_ids, ["post-DROP"]);
  assertEquals(events.filter((e) => e.event_type === "makesafe.reconcile.missing_post").length, 1);
});

Deno.test("M2/B3: the historical D2 backfill establishes the inventory floor", async () => {
  const { client, writes } = makeReconClient({ emails: [{ post_id: "post-A" }] });
  const { sink } = makeSink();
  let capturedSince = "";
  const deps = {
    getGraphToken: async () => "tok",
    resolveGroupId: async (_t: string) => "group-1",
    collectPosts: async (_t: string, _g: string, since: string) => {
      capturedSince = since;
      return { posts: [{ id: "post-A" }], pageCounts: { conversations: 1, threads: 1, posts: 1 } };
    },
    nowIso: "2026-06-14T00:00:00Z",
    historical: true,
  };
  await makesafeEmailReconcileFullInventory(client, sink, deps);
  // Historical sweep traverses from epoch and sets the floor to epoch.
  assertEquals(capturedSince, new Date(0).toISOString());
  const ss = writes.find((w) => w.table === "sync_state" && w.op === "upsert")!;
  assertEquals(ss.row.recon_inventory_floor, new Date(0).toISOString());
  // A recurring (non-historical) sweep, by contrast, must NOT set the floor — proven
  // by the D2 action test below where prior floor is preserved as null.
});

Deno.test("B3: a recurring (non-historical) D2 sweep does NOT lower the historical floor", async () => {
  const { client, writes } = makeReconClient({
    emails: [{ post_id: "post-A" }],
    // No prior floor established.
    sync_state: [{ recon_d1_verified: true, recon_inventory_floor: null, recon_inventory_ceiling: null }],
  });
  const { sink } = makeSink();
  const deps = {
    getGraphToken: async () => "tok",
    resolveGroupId: async (_t: string) => "group-1",
    collectPosts: async (_t: string, _g: string, _s: string) => ({
      posts: [{ id: "post-A" }], pageCounts: { conversations: 1, threads: 1, posts: 1 },
    }),
    nowIso: "2026-06-14T00:00:00Z",
    // historical omitted -> recurring bounded sweep.
  };
  const r = await makesafeEmailReconcileFullInventory(client, sink, deps);
  const ss = writes.find((w) => w.table === "sync_state" && w.op === "upsert")!;
  // Floor stays null (recurring sweep cannot claim historical coverage)...
  assertEquals(ss.row.recon_inventory_floor, null);
  // ...so even with D1 clean + zero missing, the combined gate is NOT verified.
  assertEquals(r.gate.recon_verified, false);
  assert(r.gate.recon_reason.includes("inventory_floor_unestablished"));
});

// ════════════════════════════════════════════════════════════
// N1 — a passing canary is marked resolved (not rechecked forever)
// ════════════════════════════════════════════════════════════
Deno.test("N1: a canary that PASSES is marked resolved + resolved_at", async () => {
  const { client, writes } = makeReconClient({
    makesafe_canary_expectations: [
      { marker: "CANARY-PASS", seeded_at: "2026-06-14T00:00:00Z", sla_minutes: 30, require_pdf: true, require_threaded_reply: true, resolved: false },
    ],
    // The canary landed, with a matching email.
    emails: [{ post_id: "post-canary", received_at: "2026-06-14T00:05:00Z", has_attachments: true, subject: "CANARY-PASS work order", body_preview: "CANARY-PASS" }],
  }, { email_attachments: 1, emails: 2 }); // pdfCount=1 uploaded, threadCount=2 (>1)
  const { sink } = makeSink();
  const r = await makesafeEmailCanary(client, sink, { nowIso: "2026-06-14T00:10:00Z" });
  assertEquals(r.ok, 1);
  const upd = writes.find((w) => w.table === "makesafe_canary_expectations" && w.op === "update");
  assert(upd, "expected a resolve update on the passed canary");
  assertEquals(upd!.row.resolved, true);
  assertEquals(typeof upd!.row.resolved_at, "string");
});

// ════════════════════════════════════════════════════════════
// FINDING 2 — ceiling coverage must reach UP TO NOW, not merely within a lookback
// window. Ceiling exactly now -> verified; ceiling now-2days (stale) -> NOT
// verified. (Pre-fix the bound was (now - coverageWindowDays), so a days-old
// ceiling over a generous window wrongly verified.)
// ════════════════════════════════════════════════════════════
Deno.test("FINDING 2: a ceiling EXACTLY now -> verified", () => {
  const NOW2 = "2026-06-15T00:00:00Z";
  const gate = combineVerifiedGate(CLEAN_DRIFT, {
    otherVerified: true,
    d2MissingPosts: 0,
    inventoryFloor: "1970-01-01T00:00:00Z",
    inventoryCeiling: NOW2,        // ceiling == now
    nowIso: NOW2,
    coverageWindowDays: 30,        // a generous window must NOT relax freshness
    unresolvedAttachments: 0,
    backfillComplete: true,
  });
  assertEquals(gate.recon_verified, true);
  assertEquals(gate.recon_mode, "OK");
});

Deno.test("FINDING 2: a ceiling now-2days (stale) -> NOT verified (window does not relax it)", () => {
  const NOW2 = "2026-06-15T00:00:00Z";
  const gate = combineVerifiedGate(CLEAN_DRIFT, {
    otherVerified: true,
    d2MissingPosts: 0,
    inventoryFloor: "1970-01-01T00:00:00Z",
    inventoryCeiling: "2026-06-13T00:00:00Z", // 2 days before NOW
    nowIso: NOW2,
    coverageWindowDays: 30,        // even a 30-day window must NOT verify a 2-day-stale ceiling
    unresolvedAttachments: 0,
  });
  assertEquals(gate.recon_verified, false);
  assertEquals(gate.recon_mode, "DEGRADED");
  assert(gate.recon_reason.includes("inventory_ceiling_stale_does_not_cover_window"));
});

// ════════════════════════════════════════════════════════════
// FINDING 3 — the attachment-count query ERROR must NOT be coerced to 0. A failed
// count is an UNKNOWN backlog that BLOCKS recon_verified (not a silent pass).
// Applies to BOTH the D1 and D2 paths.
// ════════════════════════════════════════════════════════════
Deno.test("FINDING 3: attachment-count query ERROR blocks verified on the D1 action (not silent 0)", async () => {
  const { client, writes } = makeReconClient(
    {
      // Clean D1 (no pipeline refs, no board jobs) + D2 last ran clean within bounds.
      pipeline_items: [],
      emails: [],
      makesafe_companies: [{ sender_patterns: ["mlb.com.au"], parsing_rules: {} }],
      sync_state: [{
        recon_d2_verified: true,
        recon_d2_missing_posts: 0,
        recon_inventory_floor: "1970-01-01T00:00:00Z",
        recon_inventory_ceiling: "2026-06-14T00:00:00Z",
      }],
    },
    {}, // no counts
    { email_attachments: "simulated count-query failure" }, // FINDING 3: count errors
  );
  const { sink } = makeSink();
  const fakeAudit = async () => ({ known_refs: [] });
  const res = await makesafeEmailReconcile(client, sink, {
    mode: "D1",
    makesafeAudit: fakeAudit,
    nowIso: "2026-06-14T00:00:00Z",
  });
  // The backlog is UNKNOWN -> verified is blocked (NOT silently zero/clean).
  assertEquals(res.gate.recon_verified, false);
  assert(res.gate.recon_reason.includes("attachment_backlog_unknown_count_query_failed"));
  const ss = writes.find((w) => w.table === "sync_state" && w.op === "upsert")!;
  assertEquals(ss.row.recon_verified, false);
});

Deno.test("FINDING 3: attachment-count query ERROR blocks verified on the D2 action (not silent 0)", async () => {
  const { client, writes } = makeReconClient(
    {
      emails: [{ post_id: "post-A" }],
      sync_state: [{
        recon_d1_verified: true,
        recon_inventory_floor: "1970-01-01T00:00:00Z",
        recon_inventory_ceiling: "2026-06-14T00:00:00Z",
      }],
    },
    {},
    { email_attachments: "simulated count-query failure" }, // FINDING 3
  );
  const { sink } = makeSink();
  const deps = {
    getGraphToken: async () => "tok",
    resolveGroupId: async (_t: string) => "group-1",
    // Live traversal == store -> zero missing posts (D2 drift clean), so the ONLY
    // possible blocker is the UNKNOWN attachment backlog.
    collectPosts: async (_t: string, _g: string, _s: string) => ({
      posts: [{ id: "post-A" }],
      pageCounts: { conversations: 1, threads: 1, posts: 1 },
    }),
    historical: true, // establish the floor so only the backlog can block
    nowIso: NOW,
  };
  const r = await makesafeEmailReconcileFullInventory(client, sink, deps);
  assertEquals(r.missing_post_ids.length, 0);          // D2 drift is clean
  assertEquals(r.gate.recon_verified, false);          // but verified is BLOCKED
  assert(r.gate.recon_reason.includes("attachment_backlog_unknown_count_query_failed"));
  const ss = writes.find((w) => w.table === "sync_state" && w.op === "upsert")!;
  assertEquals(ss.row.recon_verified, false);
});

// CONTROL — a SUCCESSFUL zero count on the same clean state DOES verify (proves the
// blocker above is the count ERROR, not an unrelated regression).
Deno.test("FINDING 3 control: a clean count (0, no error) on the D2 action verifies", async () => {
  const { client } = makeReconClient(
    {
      emails: [{ post_id: "post-A" }],
      sync_state: [{
        recon_d1_verified: true,
        recon_inventory_floor: "1970-01-01T00:00:00Z",
        recon_inventory_ceiling: "2026-06-14T00:00:00Z",
      }],
    },
    { email_attachments: 0 }, // clean zero, no error
  );
  const { sink } = makeSink();
  const deps = {
    getGraphToken: async () => "tok",
    resolveGroupId: async (_t: string) => "group-1",
    collectPosts: async (_t: string, _g: string, _s: string) => ({
      posts: [{ id: "post-A" }],
      pageCounts: { conversations: 1, threads: 1, posts: 1 },
    }),
    historical: true,
    nowIso: NOW,
  };
  const r = await makesafeEmailReconcileFullInventory(client, sink, deps);
  assertEquals(r.gate.recon_verified, true);
});

// ════════════════════════════════════════════════════════════
// BLOCKER 1 — every sync_state UPSERT is checked + FAILS CLOSED on write error.
// A failed verdict-persist must throw (the caller returns 500) so a prior row with
// recon_verified=true is NEVER left silently in place after a run that should have
// re-evaluated (and possibly blocked) it. We also prove a stale prior verdict is
// NOT confirmed: the action throws instead of returning success.
// ════════════════════════════════════════════════════════════

// Standard clean-D1 seed where, absent any injected error, the action would persist
// recon_verified=true. We then inject a write error and assert it fails closed.
function cleanD1Seed() {
  return {
    pipeline_items: [{ ref: "AJBR-67200", target_job: "job-uuid", source_event_ids: ["ev-1"] }],
    emails: [{ post_id: "post-1", from_email: "dispatch@mlb.com.au", received_at: "2026-06-13T00:00:00Z" }],
    email_events_raw: [{ id: "ev-1", post_id: "post-1" }],
    makesafe_companies: [{ sender_patterns: ["mlb.com.au"] }],
    sync_state: [{
      recon_d2_verified: true,
      recon_d2_missing_posts: 0,
      recon_inventory_floor: "1970-01-01T00:00:00Z",
      recon_inventory_ceiling: "2026-06-14T00:00:00Z",
      // BLOCKER (atomic backfill) — a completed full backfill is required to verify.
      backfill_complete: true,
    }],
  };
}
const CLEAN_D1_AUDIT = async () => ({
  known_refs: [{ external_ref: "AJBR-67200", source_email_id: null, job_number: "SWMS-67200", substatus: "complete" }],
});

Deno.test("BLOCKER 1 (D1): a failed sync_state upsert FAILS CLOSED (throws, does not silently succeed)", async () => {
  const { client } = makeReconClient(
    cleanD1Seed(),
    { email_attachments: 0 },
    {},
    {},
    { sync_state: "simulated upsert write failure" }, // the verdict-persist write fails
  );
  const { sink } = makeSink();
  // The action would otherwise return verified=true; a failed persist must throw
  // so the prior recon_verified is NEVER left stale and success is NEVER reported.
  const err = await assertRejects(
    () => makesafeEmailReconcile(client, sink, { mode: "D1", makesafeAudit: CLEAN_D1_AUDIT, nowIso: "2026-06-14T00:00:00Z" }),
    Error,
  );
  assertStringIncludes(err.message, "sync_state upsert (D1 verdict persist) failed");
  assertStringIncludes(err.message, "failing closed");
});

Deno.test("BLOCKER 1 (D2): a failed sync_state upsert FAILS CLOSED (throws, does not silently succeed)", async () => {
  const { client } = makeReconClient(
    {
      emails: [{ post_id: "post-A" }],
      sync_state: [{
        recon_d1_verified: true,
        recon_inventory_floor: "1970-01-01T00:00:00Z",
        recon_inventory_ceiling: "2026-06-14T00:00:00Z",
      }],
    },
    { email_attachments: 0 },
    {},
    {},
    { sync_state: "simulated upsert write failure" },
  );
  const { sink } = makeSink();
  const deps = {
    getGraphToken: async () => "tok",
    resolveGroupId: async (_t: string) => "group-1",
    collectPosts: async (_t: string, _g: string, _s: string) => ({
      posts: [{ id: "post-A" }],
      pageCounts: { conversations: 1, threads: 1, posts: 1 },
    }),
    historical: true,
    nowIso: NOW,
  };
  const err = await assertRejects(
    () => makesafeEmailReconcileFullInventory(client, sink, deps),
    Error,
  );
  assertStringIncludes(err.message, "sync_state upsert (D2 verdict persist) failed");
  assertStringIncludes(err.message, "failing closed");
});

// ════════════════════════════════════════════════════════════
// BLOCKER 3 — the D2 inventory scan-log insert is checked + FAILS CLOSED. D2 must
// NOT persist a verified state without its scan evidence. We inject an insert error
// on email_events_raw and assert the action throws BEFORE the sync_state upsert.
// ════════════════════════════════════════════════════════════
Deno.test("BLOCKER 3 (D2): a failed scan-log insert FAILS CLOSED (no verified state without scan evidence)", async () => {
  const { client, writes } = makeReconClient(
    {
      emails: [{ post_id: "post-A" }],
      sync_state: [{
        recon_d1_verified: true,
        recon_inventory_floor: "1970-01-01T00:00:00Z",
        recon_inventory_ceiling: "2026-06-14T00:00:00Z",
      }],
    },
    { email_attachments: 0 },
    {},
    {},
    { email_events_raw: "simulated scan-log insert failure" },
  );
  const { sink } = makeSink();
  const deps = {
    getGraphToken: async () => "tok",
    resolveGroupId: async (_t: string) => "group-1",
    collectPosts: async (_t: string, _g: string, _s: string) => ({
      posts: [{ id: "post-A" }],
      pageCounts: { conversations: 1, threads: 1, posts: 1 },
    }),
    historical: true,
    nowIso: NOW,
  };
  const err = await assertRejects(
    () => makesafeEmailReconcileFullInventory(client, sink, deps),
    Error,
  );
  assertStringIncludes(err.message, "D2 scan-log insert failed");
  // And critically: the sync_state verdict was NEVER written (we failed BEFORE it).
  const ss = writes.find((w) => w.table === "sync_state" && w.op === "upsert");
  assertEquals(ss, undefined);
});

// ════════════════════════════════════════════════════════════
// FINDING 2 — future-ceiling rejection + clamped skew.
// A ceiling AHEAD of now (clock skew / corrupt timestamp) must NOT verify; an
// absurd skew must be clamped so it cannot re-open the stale-ceiling hole.
// ════════════════════════════════════════════════════════════
Deno.test("FINDING 2 (future ceiling): a ceiling AHEAD of now -> NOT verified", () => {
  const NOW3 = "2026-06-15T00:00:00Z";
  const gate = combineVerifiedGate(CLEAN_DRIFT, {
    otherVerified: true,
    d2MissingPosts: 0,
    inventoryFloor: "1970-01-01T00:00:00Z",
    inventoryCeiling: "2026-06-16T00:00:00Z", // 1 day in the FUTURE
    nowIso: NOW3,
  });
  assertEquals(gate.recon_verified, false);
  assertEquals(gate.recon_mode, "DEGRADED");
  assertStringIncludes(gate.recon_reason, "inventory_ceiling_in_future_clock_skew");
});

Deno.test("FINDING 2 (clamp): an absurd skew is clamped and does NOT re-open the stale-ceiling hole", () => {
  const NOW3 = "2026-06-15T00:00:00Z";
  // Ceiling is 10 days stale. A malicious/corrupt 100-day skew would, if honoured,
  // make minFreshMs = now - 100d and wrongly verify. Clamped to <= 1h, it still
  // rejects the 10-day-stale ceiling.
  const gate = combineVerifiedGate(CLEAN_DRIFT, {
    otherVerified: true,
    d2MissingPosts: 0,
    inventoryFloor: "1970-01-01T00:00:00Z",
    inventoryCeiling: "2026-06-05T00:00:00Z", // 10 days stale
    nowIso: NOW3,
    ceilingSkewSeconds: 100 * 86_400, // absurd 100-day skew
  });
  assertEquals(gate.recon_verified, false);
  assertEquals(gate.recon_mode, "DEGRADED");
  assertStringIncludes(gate.recon_reason, "inventory_ceiling_stale_does_not_cover_window");
});

Deno.test("FINDING 2 (clamp): a tiny ceiling skew within the clamp still verifies a just-finished sweep", () => {
  const NOW3 = "2026-06-15T00:00:00Z";
  const gate = combineVerifiedGate(CLEAN_DRIFT, {
    otherVerified: true,
    d2MissingPosts: 0,
    inventoryFloor: "1970-01-01T00:00:00Z",
    inventoryCeiling: "2026-06-14T23:45:00Z", // 15 min stale (within 1h clamp)
    nowIso: NOW3,
    ceilingSkewSeconds: 1800, // 30 min, under the clamp
    backfillComplete: true,
  });
  assertEquals(gate.recon_verified, true);
  assertEquals(gate.recon_mode, "OK");
});

// ════════════════════════════════════════════════════════════
// SWEEP — every gate-feeding READ fails closed (throws) on a DB error, so a
// transient read failure can NEVER be coerced into a passing/clean value that lets
// recon_verified pass or suppresses an alert. One test per gate-feeding read site.
// ════════════════════════════════════════════════════════════

// D1: pipeline_items read (already threw pre-mission) — regression guard.
Deno.test("SWEEP (D1): pipeline_items read error fails closed", async () => {
  const { client } = makeReconClient(cleanD1Seed(), { email_attachments: 0 }, {}, { pipeline_items: "boom" });
  const { sink } = makeSink();
  await assertRejects(
    () => makesafeEmailReconcile(client, sink, { mode: "D1", makesafeAudit: CLEAN_D1_AUDIT, nowIso: "2026-06-14T00:00:00Z" }),
    Error,
    "pipeline_items read failed",
  );
});

// D1: emails (corroboration) read — error must not become an empty evidence set.
Deno.test("SWEEP (D1): emails (corroboration) read error fails closed", async () => {
  const { client } = makeReconClient(cleanD1Seed(), { email_attachments: 0 }, {}, { emails: "boom" });
  const { sink } = makeSink();
  await assertRejects(
    () => makesafeEmailReconcile(client, sink, { mode: "D1", makesafeAudit: CLEAN_D1_AUDIT, nowIso: "2026-06-14T00:00:00Z" }),
    Error,
    "emails (D1 corroboration) read failed",
  );
});

// D1: email_events_raw (event->post) read — error must not strip source_email_id links.
Deno.test("SWEEP (D1): email_events_raw (event->post) read error fails closed", async () => {
  const { client } = makeReconClient(cleanD1Seed(), { email_attachments: 0 }, {}, { email_events_raw: "boom" });
  const { sink } = makeSink();
  await assertRejects(
    () => makesafeEmailReconcile(client, sink, { mode: "D1", makesafeAudit: CLEAN_D1_AUDIT, nowIso: "2026-06-14T00:00:00Z" }),
    Error,
    "email_events_raw (event->post) read failed",
  );
});

// D1: makesafe_companies (trusted domains) read — error must not change the match surface.
Deno.test("SWEEP (D1): makesafe_companies (trusted domains) read error fails closed", async () => {
  const { client } = makeReconClient(cleanD1Seed(), { email_attachments: 0 }, {}, { makesafe_companies: "boom" });
  const { sink } = makeSink();
  await assertRejects(
    () => makesafeEmailReconcile(client, sink, { mode: "D1", makesafeAudit: CLEAN_D1_AUDIT, nowIso: "2026-06-14T00:00:00Z" }),
    Error,
  );
});

// D1: prior sync_state (D2 signal) read — error must not drop a persisted D2 drop to null.
Deno.test("SWEEP (D1): prior sync_state (D2 signal) read error fails closed", async () => {
  const { client } = makeReconClient(cleanD1Seed(), { email_attachments: 0 }, {}, { sync_state: "boom" });
  const { sink } = makeSink();
  await assertRejects(
    () => makesafeEmailReconcile(client, sink, { mode: "D1", makesafeAudit: CLEAN_D1_AUDIT, nowIso: "2026-06-14T00:00:00Z" }),
    Error,
    "sync_state (prior D2 signal) read failed",
  );
});

// D2: emails (inventory) read (already threw pre-mission) — regression guard.
function cleanD2Seed() {
  return {
    emails: [{ post_id: "post-A" }],
    sync_state: [{
      recon_d1_verified: true,
      recon_inventory_floor: "1970-01-01T00:00:00Z",
      recon_inventory_ceiling: "2026-06-14T00:00:00Z",
    }],
  };
}
function cleanD2Deps(extra: Record<string, unknown> = {}) {
  return {
    getGraphToken: async () => "tok",
    resolveGroupId: async (_t: string) => "group-1",
    collectPosts: async (_t: string, _g: string, _s: string) => ({
      posts: [{ id: "post-A" }],
      pageCounts: { conversations: 1, threads: 1, posts: 1 },
    }),
    historical: true,
    nowIso: NOW,
    ...extra,
  };
}

Deno.test("SWEEP (D2): emails (inventory) read error fails closed", async () => {
  const { client } = makeReconClient(cleanD2Seed(), { email_attachments: 0 }, {}, { emails: "boom" });
  const { sink } = makeSink();
  await assertRejects(
    () => makesafeEmailReconcileFullInventory(client, sink, cleanD2Deps()),
    Error,
    "emails inventory read failed",
  );
});

// D2: email_classifier_exclusions read — error must not corrupt the accounted set.
Deno.test("SWEEP (D2): email_classifier_exclusions read error fails closed", async () => {
  const { client } = makeReconClient(cleanD2Seed(), { email_attachments: 0 }, {}, { email_classifier_exclusions: "boom" });
  const { sink } = makeSink();
  await assertRejects(
    () => makesafeEmailReconcileFullInventory(client, sink, cleanD2Deps()),
    Error,
    "email_classifier_exclusions read failed",
  );
});

// D2: email_events_raw (excluded events) read — error must not corrupt the accounted set.
// (emails read is fine here; only email_events_raw errors — but email_events_raw is
//  used for BOTH the excluded-events read AND the scan-log insert. The read fires
//  first, so it is the throw we expect.)
Deno.test("SWEEP (D2): email_events_raw (excluded events) read error fails closed", async () => {
  const { client } = makeReconClient(cleanD2Seed(), { email_attachments: 0 }, {}, { email_events_raw: "boom" });
  const { sink } = makeSink();
  await assertRejects(
    () => makesafeEmailReconcileFullInventory(client, sink, cleanD2Deps()),
    Error,
    "email_events_raw (excluded events) read failed",
  );
});

// D2: prior sync_state (D1 signal) read — error must not drop the persisted D1 signal/bounds.
Deno.test("SWEEP (D2): prior sync_state (D1 signal) read error fails closed", async () => {
  const { client } = makeReconClient(cleanD2Seed(), { email_attachments: 0 }, {}, { sync_state: "boom" });
  const { sink } = makeSink();
  await assertRejects(
    () => makesafeEmailReconcileFullInventory(client, sink, cleanD2Deps()),
    Error,
    "sync_state (prior D1 signal) read failed",
  );
});

// ════════════════════════════════════════════════════════════
// SWEEP (D4) — the canary alert path fails closed: an expectations-read error must
// not be coerced into "no canary in flight" (which would suppress canary_missing).
// ════════════════════════════════════════════════════════════
Deno.test("SWEEP (D4): makesafe_canary_expectations read error fails closed", async () => {
  const { client } = makeReconClient({ emails: [] }, {}, {}, { makesafe_canary_expectations: "boom" });
  const { sink } = makeSink();
  await assertRejects(
    () => makesafeEmailCanary(client, sink, { nowIso: "2026-06-14T02:00:00Z" }),
    Error,
    "makesafe_canary_expectations read failed",
  );
});

Deno.test("SWEEP (D4): canary emails-hit read error fails closed", async () => {
  const { client } = makeReconClient(
    {
      makesafe_canary_expectations: [
        { marker: "CANARY-X", seeded_at: "2026-06-14T00:00:00Z", sla_minutes: 30, require_pdf: true, require_threaded_reply: true, resolved: false },
      ],
    },
    {},
    {},
    { emails: "boom" },
  );
  const { sink } = makeSink();
  await assertRejects(
    () => makesafeEmailCanary(client, sink, { nowIso: "2026-06-14T02:00:00Z" }),
    Error,
    "emails (canary hit) read failed",
  );
});

Deno.test("SWEEP (D4): seedCanaryExpectation upsert error fails closed", async () => {
  const { client } = makeReconClient({}, {}, {}, {}, { makesafe_canary_expectations: "boom" });
  await assertRejects(
    () => seedCanaryExpectation(client, { marker: "CANARY-SEED" }),
    Error,
    "makesafe_canary_expectations seed upsert failed",
  );
});

// ════════════════════════════════════════════════════════════
// CONTROL — with NO injected errors, the same clean seeds DO verify + persist, so
// the fail-closed throws above are caused by the injected error, not a regression.
// ════════════════════════════════════════════════════════════
Deno.test("CONTROL: clean D1 with no injected errors persists recon_verified=true", async () => {
  const { client, writes } = makeReconClient(cleanD1Seed(), { email_attachments: 0 });
  const { sink } = makeSink();
  const res = await makesafeEmailReconcile(client, sink, { mode: "D1", makesafeAudit: CLEAN_D1_AUDIT, nowIso: "2026-06-14T00:00:00Z" });
  assertEquals(res.gate.recon_verified, true);
  const ss = writes.find((w) => w.table === "sync_state" && w.op === "upsert")!;
  assertEquals(ss.row.recon_verified, true);
});

Deno.test("CONTROL: clean D2 with no injected errors persists a scan log + verdict", async () => {
  const { client, writes } = makeReconClient(cleanD2Seed(), { email_attachments: 0 });
  const { sink } = makeSink();
  const r = await makesafeEmailReconcileFullInventory(client, sink, cleanD2Deps());
  assertEquals(r.gate.recon_verified, true);
  // scan log + sync_state verdict both written.
  assert(writes.find((w) => w.table === "email_events_raw" && w.row?.change_type === "inventory_scan"));
  assert(writes.find((w) => w.table === "sync_state" && w.op === "upsert"));
});

// ════════════════════════════════════════════════════════════
// D1 RECONCILE .in() CHUNKING — the */30 reconcile 500 bug
// ════════════════════════════════════════════════════════════
//
// The D1 reconcile resolves each pipeline item's source email via
// email_events_raw.id IN (eventIds), where eventIds come from
// pipeline_items.source_event_ids[]. Those are Graph/Exchange event ids
// (~100-150 chars, URL-special chars). The PREVIOUS single unbounded `.in()` built
// an over-long request URL the Supabase gateway DROPS before sending — the same
// class as the compact-reads fix. These tests prove the reconcile path now chunks
// the id list by URL budget AND paginates each chunk, returning EVERY row.

// Build a realistic long Graph post/event id (~150 chars, with URL-special chars).
function longGraphId(n: number): string {
  // Mirrors the shape of a real Graph post id: base-prefix + a long opaque token
  // carrying '/', '+', '=' which all GROW under URL encoding. ~150 chars total.
  const pad = "AAMkAGI2TG93AAA=/Conversation+Thread/Post=".repeat(2);
  return `AQMkAD${pad}${String(n).padStart(6, "0")}_evt`;
}

Deno.test("D1 chunking: a long source_event_id list is split into MULTIPLE budgeted .in() reads, all events resolved", async () => {
  // 400 pipeline items, each with a UNIQUE ~150-char Graph event id -> ~60KB of
  // ids. A single .in() URL would be dropped by the gateway; the fix must chunk it.
  const N = 400;
  const pipeline_items: any[] = [];
  const email_events_raw: any[] = [];
  const emails: any[] = [];
  const known_refs: any[] = [];
  for (let i = 0; i < N; i++) {
    const evId = longGraphId(i);
    const postId = `post-${i}`;
    const ref = `AJBR-${70000 + i}`;
    pipeline_items.push({ ref, target_job: `job-${i}`, source_event_ids: [evId] });
    email_events_raw.push({ id: evId, post_id: postId });
    emails.push({ post_id: postId, from_email: "dispatch@mlb.com.au", received_at: "2026-06-13T00:00:00Z", has_attachments: false });
    // Board side has the SAME ref -> a clean exact match IFF the event->post link
    // resolved (which only happens if every chunk was read). source_email_id is
    // null so the match MUST come through the resolved email evidence path.
    known_refs.push({ external_ref: ref, source_email_id: null, job_number: `SWMS-${70000 + i}`, substatus: "complete" });
  }

  const { client, inCalls } = makeReconClient({
    pipeline_items,
    emails,
    email_events_raw,
    makesafe_companies: [{ sender_patterns: ["mlb.com.au"] }],
  }, { email_attachments: 0 });

  const { sink } = makeSink();
  const fakeAudit = async () => ({ known_refs });

  const res = await makesafeEmailReconcile(client, sink, {
    mode: "D1",
    makesafeAudit: fakeAudit,
    nowIso: "2026-06-14T00:00:00Z",
  });

  // 1) The event->post read was CHUNKED: more than one `.in()` on email_events_raw.
  const eventReads = inCalls.filter((c) => c.table === "email_events_raw" && c.column === "id");
  assert(
    eventReads.length > 1,
    `expected the long event-id list to be split into >1 .in() reads, got ${eventReads.length}`,
  );

  // 2) EVERY budgeted chunk's encoded, comma-joined id list is under IN_URL_BUDGET
  //    (with headroom) and within the secondary count cap — i.e. each chunk is a URL
  //    the gateway would accept.
  for (const c of eventReads) {
    const encodedBytes = c.list.map((id: string) => encodeURIComponent(id).length + 1)
      .reduce((a: number, b: number) => a + b, 0);
    assert(
      encodedBytes <= IN_URL_BUDGET,
      `a chunk exceeded IN_URL_BUDGET (${encodedBytes} > ${IN_URL_BUDGET})`,
    );
    assert(c.list.length <= IN_MAX_COUNT, `a chunk exceeded IN_MAX_COUNT (${c.list.length})`);
    assert(c.list.length >= 1, "a chunk was empty");
  }

  // 3) The union of all chunks covers EVERY event id exactly once (dedup + complete).
  const allChunked = new Set<string>();
  for (const c of eventReads) for (const id of c.list) allChunked.add(id);
  assertEquals(allChunked.size, N, "every event id must appear across the chunks");

  // 4) COMPLETENESS: because every chunk was read, every pipeline ref resolved its
  //    source email and matched the board exact ref. NO email_no_job ERRORs, NO
  //    job_no_email gaps, NO ambiguity — the verified gate is clean on the D1 side.
  assertEquals(res.d1.counts.matched, N);
  assertEquals(res.d1.counts.email_no_job, 0);
  assertEquals(res.d1.counts.job_no_email, 0);
  assertEquals(res.d1.counts.ambiguous, 0);
  assertEquals(res.drift.email_no_job, 0);
});

Deno.test("D1 chunking: a SHORT event-id list still works as a single .in() read (no regression)", async () => {
  const { client, inCalls } = makeReconClient({
    pipeline_items: [{ ref: "AJBR-67200", target_job: "job-1", source_event_ids: ["ev-1"] }],
    emails: [{ post_id: "post-1", from_email: "dispatch@mlb.com.au", received_at: "2026-06-13T00:00:00Z" }],
    email_events_raw: [{ id: "ev-1", post_id: "post-1" }],
    makesafe_companies: [{ sender_patterns: ["mlb.com.au"] }],
  }, { email_attachments: 0 });
  const { sink } = makeSink();
  const fakeAudit = async () => ({
    known_refs: [{ external_ref: "AJBR-67200", source_email_id: null, job_number: "SWMS-67200", substatus: "complete" }],
  });
  const res = await makesafeEmailReconcile(client, sink, { mode: "D1", makesafeAudit: fakeAudit, nowIso: "2026-06-14T00:00:00Z" });
  // One short id -> exactly one .in() read, the ref resolved + matched cleanly.
  const eventReads = inCalls.filter((c) => c.table === "email_events_raw" && c.column === "id");
  assertEquals(eventReads.length, 1);
  assertEquals(res.d1.counts.matched, 1);
  assertEquals(res.d1.counts.email_no_job, 0);
});

Deno.test("D1 chunking: duplicate event ids across pipeline items are DEDUPED before chunking", async () => {
  // Two pipeline items share the SAME long event id. The chunked read must dedup so
  // the shared id is fetched ONCE (a straddling duplicate would otherwise double-read).
  const evId = longGraphId(1);
  const { client, inCalls } = makeReconClient({
    pipeline_items: [
      { ref: "AJBR-67200", target_job: "job-1", source_event_ids: [evId] },
      { ref: "AJBR-67201", target_job: "job-2", source_event_ids: [evId] },
    ],
    emails: [{ post_id: "post-1", from_email: "dispatch@mlb.com.au", received_at: "2026-06-13T00:00:00Z" }],
    email_events_raw: [{ id: evId, post_id: "post-1" }],
    makesafe_companies: [{ sender_patterns: ["mlb.com.au"] }],
  }, { email_attachments: 0 });
  const { sink } = makeSink();
  const fakeAudit = async () => ({
    known_refs: [
      { external_ref: "AJBR-67200", source_email_id: null, job_number: "SWMS-1", substatus: "complete" },
      { external_ref: "AJBR-67201", source_email_id: null, job_number: "SWMS-2", substatus: "complete" },
    ],
  });
  await makesafeEmailReconcile(client, sink, { mode: "D1", makesafeAudit: fakeAudit, nowIso: "2026-06-14T00:00:00Z" });
  const eventReads = inCalls.filter((c) => c.table === "email_events_raw" && c.column === "id");
  // The shared id appears in the chunked reads exactly ONCE (deduped).
  const occurrences = eventReads.flatMap((c) => c.list).filter((id) => id === evId).length;
  assertEquals(occurrences, 1, "a duplicate event id must be deduped before chunking");
});
