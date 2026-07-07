// W3-A (M-E hybrid loop) — cheap-pass INTEGRATION + makesafe_audit SURFACE tests.
//
// Exercises the live makesafeStoryRecompute pass (audit injected) against a
// data-driven Supabase mock: verdict coverage across the honest classes, the
// cleanly-closed clear, the delta-rule skip, the W2-C recheck enqueue, and the
// item-14 invariant (NO substatus / invoice / send writes — only the story table +
// the recheck marker columns). Then verifies the makesafe_audit payload surfaces
// story_verdict + computed_at + recheck queue depth.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { _makesafeAuditForTest, _makesafeStoryRecomputeForTest } from "./index.ts";
import { ADMIN_SENT_MAILBOX, SENT_FOLDER } from "./makesafe_story.ts";

// ── data-driven mock: eq/neq/in/gte/is/not/order/limit/range/maybeSingle/then +
//    upsert/update/insert/delete + count-head. Applies predicates like PostgREST. ──
type Store = Record<string, any[]>;
function makeClient(tables: Store) {
  const writes = {
    upserts: [] as Array<{ table: string; rows: any[] }>,
    updates: [] as Array<{ table: string; row: any; eqs: Record<string, any> }>,
    deletes: [] as Array<{ table: string; eqs: Record<string, any> }>,
    inserts: [] as Array<{ table: string; rows: any[] }>,
  };
  function builder(table: string) {
    tables[table] = tables[table] || [];
    const preds: Array<(r: any) => boolean> = [];
    const eqs: Record<string, any> = {};
    let op: "select" | "upsert" | "update" | "insert" | "delete" = "select";
    let payload: any = null;
    let conflict: string | null = null;
    let countMode = false;
    const rowsOf = () => tables[table];
    const matched = () => rowsOf().filter((r) => preds.every((p) => p(r)));
    const doUpsert = () => {
      const arr = Array.isArray(payload) ? payload : [payload];
      const key = conflict || "id";
      for (const row of arr) {
        const idx = rowsOf().findIndex((r) => r[key] === row[key]);
        if (idx >= 0) rowsOf()[idx] = { ...rowsOf()[idx], ...row };
        else rowsOf().push({ ...row });
      }
      writes.upserts.push({ table, rows: arr });
      return { data: null, error: null };
    };
    const doUpdate = () => {
      const rows = matched();
      for (const r of rows) Object.assign(r, payload);
      writes.updates.push({ table, row: payload, eqs: { ...eqs } });
      return { data: payload, error: null };
    };
    const doInsert = () => {
      const arr = Array.isArray(payload) ? payload : [payload];
      for (const row of arr) rowsOf().push({ ...row });
      writes.inserts.push({ table, rows: arr });
      return { data: null, error: null };
    };
    const doDelete = () => {
      const keep = rowsOf().filter((r) => !preds.every((p) => p(r)));
      tables[table] = keep;
      writes.deletes.push({ table, eqs: { ...eqs } });
      return { data: null, error: null };
    };
    const resolve = () => {
      if (op === "upsert") return doUpsert();
      if (op === "update") return doUpdate();
      if (op === "insert") return doInsert();
      if (op === "delete") return doDelete();
      if (countMode) return { count: matched().length, data: null, error: null };
      return { data: matched(), error: null };
    };
    const b: any = {
      select: (_cols?: string, opts?: any) => {
        if (opts && (opts.head || opts.count)) countMode = true;
        return b;
      },
      eq: (k: string, v: any) => { eqs[k] = v; preds.push((r) => r?.[k] === v); return b; },
      neq: (k: string, v: any) => { preds.push((r) => r?.[k] !== v); return b; },
      in: (k: string, arr: any[]) => { preds.push((r) => arr.includes(r?.[k])); return b; },
      gte: (k: string, v: any) => { preds.push((r) => r?.[k] >= v); return b; },
      is: (k: string, v: any) => {
        if (v === null) preds.push((r) => r?.[k] == null);
        else preds.push((r) => r?.[k] === v);
        return b;
      },
      not: (k: string, o: string, v: any) => {
        if (o === "is" && v === null) preds.push((r) => r?.[k] != null);
        else preds.push((r) => r?.[k] !== v);
        return b;
      },
      order: () => b,
      limit: () => b,
      range: (from: number, to: number) => {
        const r = resolve() as any;
        if (r.data && Array.isArray(r.data)) r.data = r.data.slice(from, to + 1);
        return Promise.resolve(r);
      },
      upsert: (rows: any, opts?: any) => { op = "upsert"; payload = rows; conflict = opts?.onConflict ?? null; return b; },
      update: (row: any) => { op = "update"; payload = row; return b; },
      insert: (rows: any) => { op = "insert"; payload = rows; return b; },
      delete: () => { op = "delete"; return b; },
      maybeSingle: () => Promise.resolve({ data: matched()[0] ?? null, error: null }),
      single: () => Promise.resolve({ data: matched()[0] ?? null, error: null }),
      then: (res: any, rej: any) => Promise.resolve(resolve()).then(res, rej),
    };
    return b;
  }
  return { from: (t: string) => builder(t), __writes: writes };
}

// A make-safe audit jobs[] row (the W2-D partition shape makesafeStoryRecompute reads).
function auditJob(over: Record<string, any> = {}) {
  return {
    job_id: "x", job_number: "SWMS-X", external_ref: "MLB-1", job_status: "accepted",
    substatus: "pending_allocation", invoice_no: null, live_invoice_no: null,
    live_invoice_status: null, invoices: [], sibling_invoices: [], pack_sent: false,
    pipeline_item_sent_status: null, has_report_doc: false, has_report_record: false,
    has_invoice_doc: false, has_wo: true, ...over,
  };
}

const AUDIT_JOBS = [
  auditJob({ job_id: "A", external_ref: "MLB-1001", substatus: "pending_allocation" }), // NOT-STARTED
  auditJob({ // SENT-UNRECORDED — attributed via a seeded admin@ Sent row
    job_id: "B", external_ref: "AJBR 66949", substatus: "admin_to_send_report", has_report_record: true,
  }),
  auditJob({ // report-type unverified attended -> UNVERIFIED-needs-agent + recheck stamp
    job_id: "C", external_ref: "MLB-2002", substatus: "admin_to_send_report", has_report_record: true,
  }),
  auditJob({ // cancelled + PAID -> CANCELLED-CONFLICT
    job_id: "D", external_ref: "MLB-3003", job_status: "cancelled", substatus: "cancelled",
    invoice_no: "INV-9", live_invoice_no: "INV-9", live_invoice_status: "PAID",
    invoices: [{ status: "PAID", invoice_number: "INV-9", voided: false }],
    has_report_doc: true, has_invoice_doc: true,
  }),
  auditJob({ // sibling bleed -> DECISION_NEEDED
    job_id: "E", external_ref: "MLB-4004", substatus: "ready_to_invoice", has_report_record: true,
    sibling_invoices: [{ status: "AUTHORISED", invoice_number: "INV-SIB", voided: false }],
  }),
  auditJob({ // cleanly closed (complete + paid) -> cleared
    job_id: "F", external_ref: "MLB-5005", job_status: "invoiced", substatus: "complete",
    invoice_no: "INV-F", live_invoice_no: "INV-F", live_invoice_status: "PAID",
    invoices: [{ status: "PAID", invoice_number: "INV-F", voided: false }],
    pack_sent: true, pipeline_item_sent_status: "verified_sent",
    has_report_doc: true, has_invoice_doc: true, has_report_record: true,
  }),
  auditJob({ job_id: "G", external_ref: "MLB-6006", job_status: "archived", substatus: "complete" }), // excluded
];

function baseTables(): Store {
  return {
    makesafe_job_details: [
      { job_id: "A", report_type: null, cycle_number: 1, external_links: [] },
      { job_id: "B", report_type: null, cycle_number: 1, external_links: [] },
      {
        job_id: "C", report_type: "roof_report", cycle_number: 1,
        external_links: [{ url: "https://primeeco.tech/share/tok-c", kind: "roof_report" }],
        portal_verified_at: null, portal_verified_cycle: null,
        portal_recheck_requested_at: null, portal_recheck_count: 0,
      },
      { job_id: "D", report_type: null, cycle_number: 1 },
      { job_id: "E", report_type: null, cycle_number: 1 },
      { job_id: "F", report_type: null, cycle_number: 1 },
    ],
    emails: [{
      post_id: "e1", mailbox: ADMIN_SENT_MAILBOX, folder: SENT_FOLDER,
      subject: "Make Safe Report and Invoice - Job No 66949", body_preview: "attached",
      body_content: null, to_recipients: "workorders@ajs.build", has_attachments: true,
      received_at: "2026-07-07T05:00:00Z",
    }],
    // F carries a stale prior story row that must be CLEARED when it goes cleanly closed.
    makesafe_card_story: [
      { job_id: "F", story_verdict: "SENT-UNRECORDED", signal_fingerprint: "old", computed_at: "2026-07-01T00:00:00Z" },
    ],
  };
}

Deno.test("cheap pass: verdict coverage across the honest classes", async () => {
  const tables = baseTables();
  const client = makeClient(tables);
  const res: any = await _makesafeStoryRecomputeForTest(client, {
    nowIso: "2026-07-08T00:00:00Z",
    makesafeAudit: () => Promise.resolve({ jobs: AUDIT_JOBS, known_refs: [] }),
  });
  assertEquals(res.active, 6, "G (archived) excluded from active");
  assertEquals(res.computed, 5);
  assertEquals(res.closed_cleared, 1);
  assertEquals(res.enqueued, 1);
  assertEquals(res.verdict_counts["NOT-STARTED"], 1);
  assertEquals(res.verdict_counts["SENT-UNRECORDED"], 1);
  assertEquals(res.verdict_counts["UNVERIFIED-needs-agent"], 1);
  assertEquals(res.verdict_counts["CANCELLED-CONFLICT"], 1);
  assertEquals(res.verdict_counts["DECISION_NEEDED"], 1);

  const byJob: Record<string, any> = {};
  for (const s of tables.makesafe_card_story) byJob[s.job_id] = s;
  assertEquals(byJob["A"].story_verdict, "NOT-STARTED");
  assertEquals(byJob["B"].story_verdict, "SENT-UNRECORDED"); // proved by the admin@ Sent mirror
  assertEquals(byJob["C"].story_verdict, "UNVERIFIED-needs-agent");
  assertEquals(byJob["C"].needs_agent, true);
  assertEquals(byJob["C"].recheck_enqueued, true);
  assertEquals(byJob["D"].story_verdict, "CANCELLED-CONFLICT");
  assertEquals(byJob["E"].story_verdict, "DECISION_NEEDED");
  assertEquals(byJob["F"], undefined, "cleanly-closed card's stale row was cleared");
});

Deno.test("cheap pass: item-14 — NEVER writes substatus / invoices / sends (only story + recheck markers)", async () => {
  const tables = baseTables();
  const client = makeClient(tables);
  await _makesafeStoryRecomputeForTest(client, {
    nowIso: "2026-07-08T00:00:00Z",
    makesafeAudit: () => Promise.resolve({ jobs: AUDIT_JOBS, known_refs: [] }),
  });
  const w = client.__writes;
  // The ONLY tables written are the story cache + the make-safe detail recheck marker.
  const written = new Set([
    ...w.upserts.map((u) => u.table), ...w.updates.map((u) => u.table),
    ...w.inserts.map((u) => u.table), ...w.deletes.map((u) => u.table),
  ]);
  assertEquals([...written].sort(), ["makesafe_card_story", "makesafe_job_details"]);
  // The makesafe_job_details write is MARKER-ONLY: recheck columns, never substatus.
  for (const u of w.updates.filter((x) => x.table === "makesafe_job_details")) {
    const keys = Object.keys(u.row);
    assert(!keys.includes("substatus"), "recheck stamp must never touch substatus");
    for (const k of keys) {
      assert(
        ["portal_recheck_requested_at", "portal_recheck_count", "portal_recheck_reason", "updated_at"].includes(k),
        `unexpected column written by cheap pass: ${k}`,
      );
    }
  }
  // C's recheck marker was stamped (count incremented, timestamp set).
  const c = tables.makesafe_job_details.find((d) => d.job_id === "C");
  assertEquals(c.portal_recheck_count, 1);
  assert(typeof c.portal_recheck_requested_at === "string");
});

Deno.test("cheap pass: delta rule — a second run with unchanged signals recomputes nothing", async () => {
  const tables = baseTables();
  const client = makeClient(tables);
  const audit = () => Promise.resolve({ jobs: AUDIT_JOBS, known_refs: [] });
  await _makesafeStoryRecomputeForTest(client, { nowIso: "2026-07-08T00:00:00Z", makesafeAudit: audit });
  const res2: any = await _makesafeStoryRecomputeForTest(client, { nowIso: "2026-07-08T01:00:00Z", makesafeAudit: audit });
  assertEquals(res2.computed, 0, "no signal changed within 24h -> nothing recomputed");
  assertEquals(res2.skipped, 5);
  assertEquals(res2.enqueued, 0, "recheck rate-limited within the 6h window");
});

Deno.test("cheap pass: a changed substatus re-triggers a recompute (delta rule)", async () => {
  const tables = baseTables();
  const client = makeClient(tables);
  await _makesafeStoryRecomputeForTest(client, {
    nowIso: "2026-07-08T00:00:00Z",
    makesafeAudit: () => Promise.resolve({ jobs: AUDIT_JOBS, known_refs: [] }),
  });
  // A moves pending_allocation -> in_progress (attended); now UNVERIFIED-needs-agent.
  const movedJobs = AUDIT_JOBS.map((j) =>
    j.job_id === "A" ? { ...j, substatus: "in_progress", job_status: "in_progress" } : j
  );
  const res2: any = await _makesafeStoryRecomputeForTest(client, {
    nowIso: "2026-07-08T02:00:00Z",
    makesafeAudit: () => Promise.resolve({ jobs: movedJobs, known_refs: [] }),
  });
  assert(res2.computed >= 1, "the moved card recomputes");
  const a = tables.makesafe_card_story.find((s) => s.job_id === "A");
  assertEquals(a.story_verdict, "UNVERIFIED-needs-agent");
});

// ════════════════════ makesafe_audit SURFACE ════════════════════

Deno.test("makesafe_audit: surfaces story_verdict + computed_at + recheck queue depth", async () => {
  const tables: Store = {
    jobs: [
      { id: "jobX", job_number: "SWMS-X", type: "makesafe", status: "accepted", site_lat: -31.9, site_lng: 115.8, metadata: {}, created_at: "2026-07-01T00:00:00Z" },
      { id: "jobY", job_number: "SWMS-Y", type: "makesafe", status: "accepted", site_lat: null, site_lng: null, metadata: {}, created_at: "2026-07-02T00:00:00Z" },
    ],
    makesafe_job_details: [
      {
        job_id: "jobX", external_ref: "MLB-1", requesting_company_name: "MLB", requesting_company_slug: "mlb",
        substatus: "admin_to_send_report", report_type: "roof_report",
        portal_recheck_requested_at: "2026-07-08T00:00:00Z", portal_verified_at: null,
      },
      { job_id: "jobY", external_ref: "MLB-2", substatus: "pending_allocation", report_type: null },
    ],
    makesafe_card_story: [{
      job_id: "jobX", story_verdict: "UNVERIFIED-needs-agent", needs_agent: true, recheck_enqueued: true,
      evidence_gaps: ["portal-state-unverified: needs an agent capture"], blockers: ["past not-started with no backend send proof"],
      computed_at: "2026-07-08T00:05:00Z",
    }],
    job_documents: [], job_service_reports: [], xero_invoices: [], makesafe_intake_drafts: [],
    job_events: [], pipeline_items: [],
  };
  const client = makeClient(tables);
  const res: any = await _makesafeAuditForTest(client, new URLSearchParams());

  const jobX = res.jobs.find((j: any) => j.job_id === "jobX");
  const jobY = res.jobs.find((j: any) => j.job_id === "jobY");
  assertEquals(jobX.story_verdict, "UNVERIFIED-needs-agent");
  assertEquals(jobX.story_needs_agent, true);
  assertEquals(jobX.story_computed_at, "2026-07-08T00:05:00Z");
  assertEquals(jobX.story_evidence_gaps.length, 1);
  assertEquals(jobX.story_blockers.length, 1);
  // A card with no story row reads null (no cheap-pass concern / cleanly closed).
  assertEquals(jobY.story_verdict, null);
  assertEquals(jobY.story_needs_agent, false);

  assertEquals(res.recheck_queue_depth, 1, "jobX is report-type, enqueued, unverified");
  assertEquals(res.story.verdict_counts["UNVERIFIED-needs-agent"], 1);
  assertEquals(res.story.needs_agent, 1);
  assertEquals(res.story.total, 1);
});
