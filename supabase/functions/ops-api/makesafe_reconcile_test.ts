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
  summarizeDrift,
} from "./makesafe_reconcile.ts";

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

// A recording AlertSink — captures business_events + Telegram calls.
function makeSink() {
  const events: any[] = [];
  const telegrams: string[] = [];
  return {
    sink: {
      logBusinessEvent: async (_c: any, e: any) => { events.push(e); },
      notifyTelegram: async (t: string) => { telegrams.push(t); },
    },
    events,
    telegrams,
  };
}

// A chainable Supabase stub that returns seeded rows per table and records upserts
// + inserts. Supports the call shapes the reconcile actions use:
//   .from(t).select(...).eq().gte().in()...                 -> { data }
//   .from(t).select(..., {count, head}).eq().in()           -> { count }
//   .from(t).select(...)...maybeSingle()                    -> { data }
//   .from(t).upsert(row, {onConflict})                      -> records, { error:null }
//   .from(t).insert(row)                                    -> records, { error:null }
function makeReconClient(seed: Record<string, any[]>, counts: Record<string, number> = {}) {
  const writes: Array<{ table: string; op: string; row: any }> = [];
  function builder(table: string) {
    const rows = seed[table] || [];
    let isCount = false;
    const b: any = {
      select: (_c?: any, opts?: any) => { if (opts?.count) isCount = true; return b; },
      eq: () => b,
      neq: () => b,
      not: () => b,
      gte: () => b,
      lte: () => b,
      in: () => b,
      or: () => b,
      order: () => b,
      limit: () => b,
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      single: async () => ({ data: rows[0] ?? null, error: null }),
      upsert: async (row: any, _o?: any) => { writes.push({ table, op: "upsert", row }); return { error: null }; },
      insert: async (row: any) => { writes.push({ table, op: "insert", row }); return { error: null }; },
      // N1 — .update(row).eq(...) chain (used to mark a passed canary resolved).
      update: (row: any) => {
        writes.push({ table, op: "update", row });
        return { eq: async () => ({ error: null }) };
      },
      then: (resolve: (v: any) => any) =>
        resolve(isCount ? { count: counts[table] ?? 0, error: null } : { data: rows, error: null }),
    };
    return b;
  }
  return { client: { from: (t: string) => builder(t) }, writes };
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
  const gate = combineVerifiedGate(CLEAN_DRIFT, {
    otherVerified: true,
    d2MissingPosts: 0,
    inventoryFloor: "1970-01-01T00:00:00Z",
    inventoryCeiling: "2026-06-14T00:00:00Z",
  });
  assertEquals(gate.recon_verified, true);
  assertEquals(gate.recon_mode, "OK");
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
