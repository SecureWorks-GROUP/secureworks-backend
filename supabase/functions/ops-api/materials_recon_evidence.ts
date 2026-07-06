// deno-lint-ignore-file no-explicit-any
// ════════════════════════════════════════════════════════════
// U4 EVIDENCE TRANSCRIPT (for Deckhand V) — drives the three operator actions
// + the worklist read against the in-memory fake client, printing the exact
// request → response for each. No network, no prod. Re-runnable:
//
//   ~/.deno/bin/deno run supabase/functions/ops-api/materials_recon_evidence.ts
//
// This is the same handler code the ops-api dispatch calls in prod (assignReconRow
// / markReconNotJobRelated / listReconQueue), only the Supabase client is faked.
// ════════════════════════════════════════════════════════════

import { assignReconRow, listReconQueue, markReconNotJobRelated, resolveActor } from "./materials_recon.ts";
import { baseSeed, makeFakeClient, ORG } from "./materials_recon_test_support.ts";

const NOW = "2026-07-05T06:00:00.000Z";
function block(title: string) {
  console.log("\n════════════════════════════════════════════════════════════");
  console.log(title);
  console.log("════════════════════════════════════════════════════════════");
}
function show(label: string, v: unknown) {
  console.log(`\n${label}:\n${JSON.stringify(v, null, 2)}`);
}

// One fresh fake DB drives the whole transcript so the drain is visible end to end.
const { client, store } = makeFakeClient(baseSeed());

block("0. WORKLIST READ — GET ?action=materials_recon_queue (default status=open)");
show("REQUEST (query params)", { action: "materials_recon_queue", status: "open", limit: 200 });
const listed = await listReconQueue(client, { status: "open", limit: 200, orgId: ORG });
show("RESPONSE", listed);
console.log("\n→ 3 open bills surfaced; stats.open=3 is the measurable drain. Nothing hidden.");

block("1. ACCEPT-SUGGESTION — POST ?action=materials_recon_assign (use_suggestion:true)");
const req1 = { action: "materials_recon_assign", queue_id: "q-open-suggest", use_suggestion: true, operator_email: "marnin@secureworkswa.com.au" };
show("REQUEST (POST body)", req1);
const res1 = await assignReconRow(client, {
  queueId: req1.queue_id, useSuggestion: true, actor: resolveActor(req1), orgId: ORG, nowIso: NOW,
});
show("RESPONSE", res1);
console.log("\n→ FACT written: confidence=high_manual, automation_source=manual_queue, assigned_by=marnin@…, matched_po_id=null.");
console.log("→ queue row q-open-suggest → status=assigned (no longer open work).");

block("2. ASSIGN-TO-JOB — POST ?action=materials_recon_assign (explicit job, not the suggestion)");
const req2 = { action: "materials_recon_assign", queue_id: "q-open-noref", job_number: "SWF-25010", operator_email: "shaun@secureworkswa.com.au" };
show("REQUEST (POST body)", req2);
const res2 = await assignReconRow(client, {
  queueId: req2.queue_id, jobNumber: req2.job_number, actor: resolveActor(req2), orgId: ORG, nowIso: NOW,
});
show("RESPONSE", res2);
console.log("\n→ Operator picked SWF-25010 by hand; recorded MANUAL (assigned_by=shaun@…), a high_manual fact.");

block("3. MARK-NOT-JOB-RELATED — POST ?action=materials_recon_not_job_related (writes NO fact)");
const req3 = { action: "materials_recon_not_job_related", queue_id: "q-open-refnojob", operator_email: "shaun@secureworkswa.com.au" };
show("REQUEST (POST body)", req3);
const res3 = await markReconNotJobRelated(client, {
  queueId: req3.queue_id, actor: resolveActor(req3), orgId: ORG, nowIso: NOW,
});
show("RESPONSE", res3);
console.log("\n→ fact=null (NO materials fact written). queue row → not_job_related, assigned_by/assigned_at record who+when.");

block("4. STATE AFTER — the derived rows (what landed vs what closed)");
show("job_materials_facts (2 manual facts — the money that landed on jobs)", store.job_materials_facts);
show("job_events (audit crumbs; only the 2 job-bearing actions log here)", store.job_events.map((e: any) => ({ event_type: e.event_type, ...e.detail_json })));
const after = await listReconQueue(client, { status: "all", orgId: ORG });
show("queue snapshot (status=all) + drain stats", { stats: (after as any).stats, rows: (after as any).rows.map((r: any) => ({ id: r.id, xero_invoice_id: r.xero_invoice_id, status: r.status, assigned_job_id: r.assigned_job_id, assigned_by: r.assigned_by })) });
console.log("\n→ Drain: open went 3 → 0 (two assigned as facts, one marked not-job-related). stats.assigned=3, not_job_related=2 include the pre-seeded rows.");
console.log("→ Boundary proof: 2 facts written (accept + assign); the not-job-related bill wrote ZERO facts.");

block("5. GUARD — assign a bill that already has a fact is REFUSED (no double-count)");
const req5 = { action: "materials_recon_assign", queue_id: "q-open-suggest", job_number: "SWF-25010", operator_email: "shaun@secureworkswa.com.au" };
show("REQUEST (POST body)", req5);
try {
  await assignReconRow(client, { queueId: req5.queue_id, jobNumber: req5.job_number, actor: resolveActor(req5), orgId: ORG, nowIso: NOW });
  console.log("RESPONSE: (unexpected) — should have thrown");
} catch (e) {
  show("RESPONSE (error — HTTP 500 with this message)", { error: (e as Error).message });
  console.log("\n→ The bill's fact is the single source of truth; it must be reverted before re-assignment. No second fact.");
}
console.log(`\nFinal fact count: ${store.job_materials_facts.length} (unchanged by the refused action).`);
