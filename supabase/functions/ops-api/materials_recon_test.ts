// ════════════════════════════════════════════════════════════
// MATERIALS RECONCILIATION QUEUE TESTS (U4)
//
// Pure-Deno, no network. Drives the SAME handlers the ops-api dispatch calls,
// against an in-memory fake Supabase client. Proves the queue-drain contract:
//   - list surfaces open rows + a measurable drain stat
//   - assign-to-job / accept-suggestion land a MANUAL fact (high_manual,
//     automation_source=manual_queue, assigned_by=actor) and flip the queue row
//   - mark-not-job-related closes the row and writes NO fact
//   - the boundary is enforced: a bill that already has a fact cannot be
//     re-assigned or dismissed (conflict), and a double-accept is idempotent
//
// RUN:
//   ~/.deno/bin/deno test --no-check --allow-none \
//     supabase/functions/ops-api/materials_recon_test.ts
// ════════════════════════════════════════════════════════════

import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  assignReconRow,
  buildManualFactRow,
  classifyAssign,
  type ExistingFact,
  listReconQueue,
  manualQueueMatchReason,
  markReconNotJobRelated,
  type QueueRow,
  reconStats,
  resolveActor,
} from "./materials_recon.ts";
import { baseSeed, makeFakeClient, ORG } from "./materials_recon_test_support.ts";

const NOW = "2026-07-05T06:00:00.000Z";

// ── Pure helpers ─────────────────────────────────────────────
Deno.test("resolveActor — operator_email wins, blank falls back to a sentinel", () => {
  assertEquals(resolveActor({ operator_email: "shaun@secureworkswa.com.au" }), "shaun@secureworkswa.com.au");
  assertEquals(resolveActor({ user_email: "jan@sec.au" }), "jan@sec.au");
  assertEquals(resolveActor({ actor: "marnin" }), "marnin");
  assertEquals(resolveActor({ operator_email: "  " }), "ops_dashboard");
  assertEquals(resolveActor({}), "ops_dashboard");
  assertEquals(resolveActor(null), "ops_dashboard");
});

Deno.test("manualQueueMatchReason — carries the action + job number", () => {
  assertEquals(manualQueueMatchReason("accept-suggestion", "SWF-25010"), "manual_queue:accept-suggestion SWF-25010");
  assertEquals(manualQueueMatchReason("assign-to-job", "SWP-25029"), "manual_queue:assign-to-job SWP-25029");
  assertEquals(manualQueueMatchReason("assign-to-job", null), "manual_queue:assign-to-job");
});

Deno.test("buildManualFactRow — stamped manual, ex-GST money, reversible key", () => {
  const q = {
    org_id: ORG, xero_invoice_id: "xinv-001", invoice_number: "12345678",
    xero_contact_id: "c-fwwa", contact_name: "Fencing Warehouse WA",
    sub_total: 1000, total: 1100, invoice_date: "2026-07-02",
  } as unknown as QueueRow;
  const row = buildManualFactRow(q, { id: "job-fence-1", job_number: "SWF-25010" }, "shaun@sec.au", "assign-to-job", NOW);
  assertEquals(row.confidence, "high_manual");
  assertEquals(row.automation_source, "manual_queue");
  assertEquals(row.assigned_by, "shaun@sec.au");
  assertEquals(row.matched_po_id, null);
  assertEquals(row.job_id, "job-fence-1");
  assertEquals(row.job_number, "SWF-25010");
  assertEquals(row.amount_ex_gst, 1000); // ex-GST sub_total is the money fact
  assertEquals(row.amount_inc_gst, 1100);
  assertEquals(row.lane, "materials");
  assertEquals(row.kind, "actual");
  assertEquals(row.xero_invoice_id, "xinv-001"); // idempotency / reversibility key
  assertEquals(row.match_reason, "manual_queue:assign-to-job SWF-25010");
});

Deno.test("classifyAssign — proceed / idempotent / conflict", () => {
  assertEquals(classifyAssign(null, "job-x"), "proceed");
  const manualSameJob: ExistingFact = { id: "f1", xero_invoice_id: "x", job_id: "job-x", job_number: "SWF-1", automation_source: "manual_queue", confidence: "high_manual" };
  assertEquals(classifyAssign(manualSameJob, "job-x"), "idempotent");
  const manualOtherJob: ExistingFact = { ...manualSameJob, job_id: "job-y" };
  assertEquals(classifyAssign(manualOtherJob, "job-x"), "conflict");
  const autoFact: ExistingFact = { ...manualSameJob, automation_source: "xero_ref_link", confidence: "high" };
  assertEquals(classifyAssign(autoFact, "job-x"), "conflict"); // never overwrite an auto fact
});

// ── (a) The worklist surface + drain stat ────────────────────
Deno.test("listReconQueue — default lists OPEN rows only, with drain stats", async () => {
  const { client } = makeFakeClient(baseSeed());
  const res = await listReconQueue(client, { orgId: ORG });
  const rows = res.rows as QueueRow[];
  assertEquals(res.status, "open");
  assertEquals(rows.length, 3); // 3 open, not the assigned/not_job_related
  assert(rows.every((r) => r.status === "open"));
  const stats = res.stats as Record<string, number>;
  assertEquals(stats.open, 3);
  assertEquals(stats.assigned, 1);
  assertEquals(stats.not_job_related, 1);
  assertEquals(stats.total_rows, 5);
  assertEquals(stats.open_total_ex, 1750); // 1000 + 500 + 250
  assertEquals(stats.open_total_inc, 1925); // 1100 + 550 + 275
});

Deno.test("listReconQueue — status=all returns every row", async () => {
  const { client } = makeFakeClient(baseSeed());
  const res = await listReconQueue(client, { orgId: ORG, status: "all" });
  assertEquals((res.rows as QueueRow[]).length, 5);
});

Deno.test("reconStats — pure snapshot of the drain", async () => {
  const { client } = makeFakeClient(baseSeed());
  const stats = await reconStats(client, ORG);
  assertEquals(stats.open, 3);
  assertEquals(stats.assigned, 1);
  assertEquals(stats.not_job_related, 1);
});

// ── (b) assign-to-job — lands a manual fact, flips the queue row ──
Deno.test("assign-to-job — writes ONE high_manual fact + flips queue to assigned", async () => {
  const { client, store } = makeFakeClient(baseSeed());
  const res = await assignReconRow(client, {
    queueId: "q-open-noref", jobNumber: "SWF-25010",
    actor: "shaun@secureworkswa.com.au", orgId: ORG, nowIso: NOW,
  });
  assertEquals(res.ok, true);
  assertEquals(res.action, "assign-to-job");

  // exactly one fact, stamped manual + owned
  assertEquals(store.job_materials_facts.length, 1);
  const fact = store.job_materials_facts[0];
  assertEquals(fact.xero_invoice_id, "xinv-001");
  assertEquals(fact.job_id, "job-fence-1");
  assertEquals(fact.job_number, "SWF-25010");
  assertEquals(fact.confidence, "high_manual");
  assertEquals(fact.automation_source, "manual_queue");
  assertEquals(fact.assigned_by, "shaun@secureworkswa.com.au");
  assertEquals(fact.amount_ex_gst, 1000);

  // queue row flipped + audited (who + when)
  const q = store.materials_reconciliation_queue.find((r) => r.id === "q-open-noref");
  assertEquals(q!.status, "assigned");
  assertEquals(q!.assigned_job_id, "job-fence-1");
  assertEquals(q!.assigned_by, "shaun@secureworkswa.com.au");
  assertEquals(q!.assigned_at, NOW);

  // a job_events audit crumb was written (manual marker)
  assertEquals(store.job_events.length, 1);
  assertEquals(store.job_events[0].event_type, "materials_bill_assigned");
  assertEquals(store.job_events[0].detail_json.manual, true);
  assertEquals(store.job_events[0].detail_json.assigned_by, "shaun@secureworkswa.com.au");
});

// ── (b) accept-suggestion — lands the advisory suggested job ──
Deno.test("accept-suggestion — lands the suggested job as a manual fact", async () => {
  const { client, store } = makeFakeClient(baseSeed());
  const res = await assignReconRow(client, {
    queueId: "q-open-suggest", useSuggestion: true,
    actor: "marnin@sec.au", orgId: ORG, nowIso: NOW,
  });
  assertEquals(res.action, "accept-suggestion");
  const fact = store.job_materials_facts[0];
  assertEquals(fact.job_id, "job-patio-2"); // the suggested job
  assertEquals(fact.job_number, "SWP-25029");
  assertEquals(fact.confidence, "high_manual"); // manual accept, not the suggestion's confidence
  assertEquals(fact.match_reason, "manual_queue:accept-suggestion SWP-25029");
  assertEquals(store.materials_reconciliation_queue.find((r) => r.id === "q-open-suggest")!.status, "assigned");
});

Deno.test("accept-suggestion — refuses when the row has no suggestion", async () => {
  const { client } = makeFakeClient(baseSeed());
  await assertRejects(
    () => assignReconRow(client, { queueId: "q-open-noref", useSuggestion: true, actor: "x", orgId: ORG, nowIso: NOW }),
    Error, "no suggested job",
  );
});

// ── (b) mark-not-job-related — closes the row, NO fact ──
Deno.test("mark-not-job-related — closes the row and writes NO fact", async () => {
  const { client, store } = makeFakeClient(baseSeed());
  const res = await markReconNotJobRelated(client, {
    queueId: "q-open-refnojob", actor: "shaun@sec.au", orgId: ORG, nowIso: NOW,
  });
  assertEquals(res.ok, true);
  assertEquals(res.fact, null);
  assertEquals(store.job_materials_facts.length, 0); // NO fact
  const q = store.materials_reconciliation_queue.find((r) => r.id === "q-open-refnojob");
  assertEquals(q!.status, "not_job_related");
  assertEquals(q!.assigned_by, "shaun@sec.au"); // still auditable: who + when
  assertEquals(q!.assigned_at, NOW);
  assertEquals(q!.assigned_job_id, null);
  assertEquals(store.job_events.length, 0); // no job → no job_events crumb
});

// ── Boundary / precision guards ──────────────────────────────
Deno.test("assign — CONFLICT when an auto fact already owns the bill", async () => {
  const seed = baseSeed();
  seed.job_materials_facts.push({
    id: "f-auto", org_id: ORG, xero_invoice_id: "xinv-001", job_id: "job-patio-2",
    job_number: "SWP-25029", automation_source: "xero_ref_link", confidence: "high",
    amount_ex_gst: 1000, lane: "materials", kind: "actual",
  });
  const { client, store } = makeFakeClient(seed);
  await assertRejects(
    () => assignReconRow(client, { queueId: "q-open-noref", jobNumber: "SWF-25010", actor: "x", orgId: ORG, nowIso: NOW }),
    Error, "already has a materials fact",
  );
  assertEquals(store.job_materials_facts.length, 1); // no second fact written
});

Deno.test("mark-not-job-related — BLOCKED when a fact already owns the bill", async () => {
  const seed = baseSeed();
  seed.job_materials_facts.push({
    id: "f-auto", org_id: ORG, xero_invoice_id: "xinv-001", job_id: "job-fence-1",
    job_number: "SWF-25010", automation_source: "xero_ref_link", confidence: "high",
  });
  const { client } = makeFakeClient(seed);
  await assertRejects(
    () => markReconNotJobRelated(client, { queueId: "q-open-noref", actor: "x", orgId: ORG, nowIso: NOW }),
    Error, "already attributed to job",
  );
});

Deno.test("assign — idempotent double-accept does NOT write a second fact", async () => {
  const seed = baseSeed();
  seed.job_materials_facts.push({
    id: "f-manual", org_id: ORG, xero_invoice_id: "xinv-001", job_id: "job-fence-1",
    job_number: "SWF-25010", automation_source: "manual_queue", confidence: "high_manual",
  });
  const { client, store } = makeFakeClient(seed);
  const res = await assignReconRow(client, {
    queueId: "q-open-noref", jobNumber: "SWF-25010", actor: "shaun@sec.au", orgId: ORG, nowIso: NOW,
  });
  assertEquals(res.idempotent, true);
  assertEquals(store.job_materials_facts.length, 1); // still just the one
  assertEquals(store.materials_reconciliation_queue.find((r) => r.id === "q-open-noref")!.status, "assigned");
});

Deno.test("assign-to-job — resolves job by job_number OR uuid", async () => {
  // by uuid
  const a = makeFakeClient(baseSeed());
  await assignReconRow(a.client, { queueId: "q-open-noref", jobId: "job-fence-1", actor: "x", orgId: ORG, nowIso: NOW });
  assertEquals(a.store.job_materials_facts[0].job_number, "SWF-25010");
  // unknown job → throws
  const b = makeFakeClient(baseSeed());
  await assertRejects(
    () => assignReconRow(b.client, { queueId: "q-open-noref", jobNumber: "SWF-99999", actor: "x", orgId: ORG, nowIso: NOW }),
    Error, "job not found",
  );
});

Deno.test("assign — unknown queue row throws", async () => {
  const { client } = makeFakeClient(baseSeed());
  await assertRejects(
    () => assignReconRow(client, { queueId: "does-not-exist", jobNumber: "SWF-25010", actor: "x", orgId: ORG, nowIso: NOW }),
    Error, "queue row not found",
  );
});
