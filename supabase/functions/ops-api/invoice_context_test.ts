// deno-lint-ignore-file no-explicit-any require-await
//
// Invoice context door (CIO, 2026-09-11).
//
// Pins:
//   1. A linked invoice returns job, current facts only, oldest-first conversation,
//      chase, Xero payments and an empty blocker list when the picture is complete.
//   2. Every missing piece is an owned blocker and a false coverage flag, never a blank:
//      no job, ambiguous contact, no GHL contact, no facts (with queue detail), no
//      conversation, stale Xero cache.
//   3. Link resolution order: stored job_id, stored job_number, job number in the
//      reference, single job via the Xero contact; several jobs is ambiguous with candidates.
//   4. A read failure of one source never fails the call; it is reported in sources.
//   5. Invalid input and unknown invoices are refused with a status, not thrown.
//   6. Coverage aggregates the whole open population with the same rules and counts
//      client messages, not internal notes, as conversation.
//   7. Every multi-row read pages past the PostgREST 1000-row cap instead of
//      truncating in silence.
//   8. An invoice number carrying a LIKE wildcard is refused, never matched.
//   9. An unreadable source is an "unreadable" blocker, never a "missing" one:
//      the door never asserts "Luna has not extracted" after a failed read.
//  10. The door and the coverage read agree, invoice for invoice, on every
//      coverage flag and every blocker code.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { debtContextCoverage, escapeLikeLiteral, invoiceContext, InvoiceContextError, jobNumberFromReference, parseXeroDate, queueDetail } from "./invoice_context.ts";
import { isCurrentContextFact } from "./context_visibility.ts";

const ORG = "00000000-0000-0000-0000-000000000001";
const NOW = new Date("2026-09-11T05:00:00.000Z");
const JOB1 = "a0000000-0000-4000-8000-000000000001";
const JOB2 = "a0000000-0000-4000-8000-000000000002";
const JOB3 = "a0000000-0000-4000-8000-000000000003";
const INV1 = "b0000000-0000-4000-8000-000000000001";
const INV2 = "b0000000-0000-4000-8000-000000000002";
const INV3 = "b0000000-0000-4000-8000-000000000003";
const INV4 = "b0000000-0000-4000-8000-000000000004";
const INV5 = "b0000000-0000-4000-8000-000000000005";

type Tables = Record<string, any[]>;

function baseTables(): Tables {
  return {
    xero_invoices: [
      { org_id: ORG, invoice_type: "ACCREC", xero_invoice_id: INV1, xero_contact_id: "xc-1", contact_name: "Major Loss Builders", invoice_number: "INV-1419", reference: "MLB-24911",
        status: "AUTHORISED", total: 6237, amount_due: 6237, amount_paid: 0, invoice_date: "2026-08-20", due_date: "2026-09-03", job_id: JOB1, job_number: null,
        synced_at: "2026-09-11T03:30:00.000Z", line_items: [{ Description: "Make safe", Quantity: 1, UnitAmount: 5670, LineAmount: 5670 }],
        raw_json: { Payments: [{ Date: "/Date(1757462400000+0000)/", Amount: 1000, Reference: "part" }] },
        debt_classification: "genuine_debt", debt_classification_reason: "no reply", debt_classified_by: "DEBT", debt_classified_at: "2026-09-10T00:00:00.000Z" },
      // no job_id, reference names a job
      { org_id: ORG, invoice_type: "ACCREC", xero_invoice_id: INV2, xero_contact_id: "xc-2", contact_name: "Jorden Harris", invoice_number: "INV-1373", reference: "SWP-261180 FINBAL",
        status: "AUTHORISED", total: 3613.78, amount_due: 3613.78, amount_paid: 0, invoice_date: "2026-08-01", due_date: "2026-08-15", job_id: null, job_number: null,
        synced_at: "2026-09-09T03:30:00.000Z", line_items: [], raw_json: {} },
      // no job, contact has two jobs
      { org_id: ORG, invoice_type: "ACCREC", xero_invoice_id: INV3, xero_contact_id: "xc-3", contact_name: "Two Jobs Pty", invoice_number: "INV-1500", reference: "deposit",
        status: "AUTHORISED", total: 500, amount_due: 500, amount_paid: 0, invoice_date: "2026-09-01", due_date: "2026-09-20", job_id: null, job_number: null,
        synced_at: "2026-09-11T04:00:00.000Z", line_items: [], raw_json: {} },
      // no job, no contact route
      { org_id: ORG, invoice_type: "ACCREC", xero_invoice_id: INV4, xero_contact_id: null, contact_name: "Unknown", invoice_number: "INV-1501", reference: null,
        status: "SUBMITTED", total: 100, amount_due: 100, amount_paid: 0, invoice_date: "2026-09-01", due_date: "2026-09-08", job_id: null, job_number: null,
        synced_at: "2026-09-11T04:00:00.000Z", line_items: [], raw_json: {} },
      // paid: not in the open population
      { org_id: ORG, invoice_type: "ACCREC", xero_invoice_id: INV5, xero_contact_id: "xc-1", contact_name: "Major Loss Builders", invoice_number: "INV-1416", reference: null,
        status: "PAID", total: 7579, amount_due: 0, amount_paid: 7579, invoice_date: "2026-08-20", due_date: "2026-09-03", job_id: JOB1, job_number: null,
        synced_at: "2026-09-11T03:30:00.000Z", line_items: [], raw_json: {} },
    ],
    jobs: [
      { id: JOB1, job_number: "SWMS-261399", type: "makesafe", status: "invoiced", client_name: "Patricia Quinn", client_phone: "0400", client_email: "p@x", site_address: "62 Lyrebird Way", site_suburb: "Thornlie",
        ghl_contact_id: "ghl-1", deposit_amount: null, deposit_at: null, pricing_json: { totalIncGST: 6237 }, quoted_at: null, accepted_at: null, scheduled_at: "2026-08-19", completed_at: "2026-08-20", created_at: "2026-08-18" },
      { id: JOB2, job_number: "SWP-261180", type: "patio", status: "completed", client_name: "Jorden Harris", ghl_contact_id: null, pricing_json: { total: 7227.56 } },
      { id: JOB3, job_number: "SWF-261300", type: "fencing", status: "quoted", client_name: "Two Jobs Pty", ghl_contact_id: "ghl-3", pricing_json: {} },
      { id: "a0000000-0000-4000-8000-000000000004", job_number: "SWF-261301", type: "fencing", status: "scheduled", client_name: "Two Jobs Pty", ghl_contact_id: "ghl-3", pricing_json: {} },
    ],
    contact_matches: [
      { xero_contact_id: "xc-3", ghl_contact_id: "ghl-3", job_id: null },
    ],
    job_variations: [{ job_id: JOB1, variation_number: 1, amount: 300, status: "approved", sent_at: "2026-08-19" }],
    work_orders: [{ job_id: JOB1, wo_number: "WO-1", trade_name: "Sonny", status: "completed", scheduled_date: "2026-08-19", completed_at: "2026-08-20", created_at: "2026-08-18" }],
    council_submissions: [],
    current_job_context_facts: [
      { id: "f1", job_id: JOB1, kind: "payment_promise", value: "Will pay Friday", provenance: { source_table: "business_events" }, updated_at: "2026-09-10T00:00:00.000Z", _context_store: "job_context" },
      { id: "f2", job_id: JOB1, kind: "note", value: "superseded", provenance: { superseded_by: "f1" }, updated_at: "2026-09-09T00:00:00.000Z", _context_store: "job_context" },
      { id: "f3", job_id: JOB1, kind: "current_state", value: "expired", provenance: {}, updated_at: "2026-09-01T00:00:00.000Z", expires_at: "2026-09-02T00:00:00.000Z", _context_store: "job_temporary_context" },
    ],
    extraction_jobs: [
      { job_id: JOB2, status: "skipped", skip_reason: "source_attribution_unproven", error: null },
      { job_id: JOB2, status: "dead_letter", skip_reason: null, error: "source_attribution_ambiguous" },
    ],
    payment_chase_logs: [
      { xero_invoice_id: INV1, method: "sms", outcome: "no_answer", notes: "left message", follow_up_date: "2026-09-15", follow_up_resolved: false, chased_by: "DEBT", created_at: "2026-09-09T00:00:00.000Z" },
      { xero_invoice_id: INV1, method: "call", outcome: "spoke", notes: "promised", follow_up_date: null, follow_up_resolved: true, chased_by: "DEBT", created_at: "2026-09-05T00:00:00.000Z" },
    ],
    ghl_conversation_cache: [
      { contact_id: "ghl-1", job_id: JOB1, message_count: 2, messages: [
        { id: "m1", type: "SMS", direction: "outbound", body: "Invoice sent", timestamp: "2026-09-01T00:00:00.000Z" },
        { id: "m2", type: "SMS", direction: "inbound", body: "Will pay Friday", timestamp: "2026-09-10T01:00:00.000Z" },
      ] },
    ],
    inbox_events: [],
    job_events: [{ job_id: JOB1, event_type: "note", created_at: "2026-09-02T00:00:00.000Z" }],
    business_events: [{ job_id: JOB1, event_type: "client.email_in", occurred_at: "2026-09-03T00:00:00.000Z" }],
  };
}

/**
 * Minimal in-memory PostgREST-style client: enough of the builder chain for the
 * door. It enforces the real 1000-row response cap, so a read that does not
 * page with .range() truncates here exactly as it does in production.
 *
 * `failFrom` fails a table from its Nth call onward (1-based), which is how the
 * job-link read can succeed while the job detail read fails.
 */
const PG_ROW_CAP = 1000;

function fakeClient(tables: Tables, failing: Set<string> = new Set(), failFrom: Record<string, number> = {}) {
  const calls: Record<string, number> = {};
  return {
    _calls: calls,
    from(table: string) {
      calls[table] = (calls[table] ?? 0) + 1;
      const callNo = calls[table];
      const filters: Array<(row: any) => boolean> = [];
      let order: { col: string; asc: boolean } | null = null;
      let limit: number | null = null;
      let range: { from: number; to: number } | null = null;
      const q: any = {};
      const chain = (fn: () => void) => (...args: any[]) => { (fn as any)(...args); return q; };
      q.select = chain(() => {});
      q.eq = chain((c: string, v: any) => filters.push((r) => r[c] === v));
      q.neq = chain((c: string, v: any) => filters.push((r) => r[c] !== v));
      q.gt = chain((c: string, v: any) => filters.push((r) => r[c] !== null && r[c] !== undefined && r[c] > v));
      q.lt = chain((c: string, v: any) => filters.push((r) => r[c] !== null && r[c] !== undefined && r[c] < v));
      q.in = chain((c: string, v: any[]) => filters.push((r) => v.includes(r[c])));
      q.ilike = chain((c: string, v: string) => filters.push((r) => String(r[c] ?? "").toLowerCase() === v.toLowerCase()));
      q.order = chain((c: string, o: any) => { order = { col: c, asc: o?.ascending !== false }; });
      q.limit = chain((n: number) => { limit = n; });
      q.range = chain((from: number, to: number) => { range = { from, to }; });
      const run = () => {
        if (failing.has(table) || (failFrom[table] !== undefined && callNo >= failFrom[table])) {
          return { data: null, error: { message: `${table} unavailable` } };
        }
        let rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
        if (order) rows = [...rows].sort((a, b) => (a[order!.col] < b[order!.col] ? -1 : a[order!.col] > b[order!.col] ? 1 : 0) * (order!.asc ? 1 : -1));
        if (limit !== null) rows = rows.slice(0, limit);
        if (range) rows = rows.slice(range.from, range.to + 1);
        // PostgREST never returns more than 1000 rows in one response.
        return { data: rows.slice(0, PG_ROW_CAP), error: null };
      };
      q.maybeSingle = async () => { const r = run(); return { data: r.error ? null : (r.data?.[0] ?? null), error: r.error }; };
      q.then = (resolve: any, reject: any) => Promise.resolve(run()).then(resolve, reject);
      return q;
    },
    rpc: async (name: string) => {
      if (failing.has(name)) return { data: null, error: { message: `${name} unavailable` } };
      return { data: null, error: null };
    },
  };
}

/** Conversation merge stub: newest first, like getJobConversation. */
function fakeConversation(tables: Tables) {
  return async (_client: any, body: { job_id: string; limit: number }) => {
    const msgs: any[] = [];
    for (const row of tables.ghl_conversation_cache ?? []) {
      if (row.job_id !== body.job_id) continue;
      for (const m of row.messages) msgs.push({ id: `ghl:${m.id}`, channel: "sms", direction: m.direction, occurred_at: m.timestamp, author: null, body: m.body, preview: m.body, source_system: "ghl_cache", source_ref: m.id });
    }
    for (const e of tables.job_events ?? []) if (e.job_id === body.job_id) msgs.push({ id: "note:1", channel: "note", direction: "internal", occurred_at: e.created_at, body: "internal note", preview: "internal note", source_system: "job_events", source_ref: "1" });
    for (const e of tables.business_events ?? []) if (e.job_id === body.job_id) msgs.push({ id: "bev:1", channel: "email", direction: "inbound", occurred_at: e.occurred_at, body: "email in", preview: "email in", source_system: "business_events", source_ref: "1" });
    msgs.sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : -1));
    return { messages: msgs.slice(0, body.limit) };
  };
}

function deps(tables: Tables, failing?: Set<string>, failFrom?: Record<string, number>) {
  return { client: fakeClient(tables, failing, failFrom), orgId: ORG, getJobConversation: fakeConversation(tables), isCurrentContextFact, now: () => NOW };
}

Deno.test("1. a linked invoice returns the complete picture with no blockers", async () => {
  const t = baseTables();
  const out = await invoiceContext(new URLSearchParams({ invoice: "inv-1419" }), deps(t));
  assertEquals(out.invoice.invoice_number, "INV-1419");
  assertEquals(out.invoice.days_overdue, 8);
  assertEquals(out.invoice.classification.class, "genuine_debt");
  assertEquals(out.invoice.chase.count, 2);
  assertEquals(out.invoice.chase.next_follow_up, "2026-09-15");
  assertEquals(out.link, { status: "linked", method: "invoice.job_id", job_id: JOB1, job_number: "SWMS-261399", candidates: [] });
  assertEquals(out.job.promised.quote_total, 6237);
  assertEquals(out.job.promised.variations, [{ number: "VAR1", amount: 300, status: "approved", sent_at: "2026-08-19" }]);
  assertEquals(out.job.other_open_invoices, []);
  // only the current fact: superseded and expired rows are filtered
  assertEquals(out.facts.map((f: any) => f.id), ["f1"]);
  // oldest first, internal note included in messages but not in the client picture
  assertEquals(out.conversation.messages.map((m: any) => m.source_ref), ["m1", "1", "1", "m2"]);
  assertEquals(out.conversation.last_client_message?.preview, "Will pay Friday");
  assertEquals(out.conversation.last_outbound?.preview, "Invoice sent");
  // all five merge sources are always present, zero included
  assertEquals(out.conversation.sources, { ghl_cache: 2, inbox: 0, job_events: 1, business_events: 1, chat_logs: 0 });
  assertEquals(out.bank.xero_payments, [{ date: "2025-09-10", amount: 1000, reference: "part" }]);
  assertEquals(out.bank.paid_in_bank_unreconciled, null);
  assertEquals(out.blockers, []);
  assertEquals(out.coverage, { job_linked: true, contact_known: true, facts_present: true, conversation_present: true, xero_fresh: true });
  assertEquals(out.warnings, []);
});

Deno.test("2. reference job number links the job; missing facts and conversation are owned blockers with queue detail", async () => {
  const t = baseTables();
  const out = await invoiceContext(new URLSearchParams({ xero_invoice_id: INV2 }), deps(t));
  assertEquals(out.link.status, "linked");
  assertEquals(out.link.method, "reference_job_number");
  assertEquals(out.link.job_number, "SWP-261180");
  const codes = out.blockers.map((b) => `${b.code}:${b.owner}`);
  assertEquals(codes, ["no_ghl_contact:CIO", "facts_missing:CIO", "conversation_missing:CIO", "xero_stale:CIO"]);
  assertStringIncludes(out.blockers[1].detail, "skipped:1 (source_attribution_unproven)");
  assertStringIncludes(out.blockers[1].detail, "dead_letter:1 (source_attribution_ambiguous)");
  assertEquals(out.coverage, { job_linked: true, contact_known: true, facts_present: false, conversation_present: false, xero_fresh: false });
});

Deno.test("3. a contact with several jobs is ambiguous with candidates; no route at all is no_job_linked", async () => {
  const t = baseTables();
  const amb = await invoiceContext(new URLSearchParams({ invoice: "INV-1500" }), deps(t));
  assertEquals(amb.link.status, "ambiguous");
  assertEquals(amb.link.candidates.map((c) => c.job_number).sort(), ["SWF-261300", "SWF-261301"]);
  assertEquals(amb.job, null);
  assertEquals(amb.blockers.map((b) => b.code), ["job_link_ambiguous", "xero_stale"].filter((c) => c !== "xero_stale"));
  assertEquals(amb.blockers[0].owner, "BOOKKEEPING");

  const none = await invoiceContext(new URLSearchParams({ invoice: "INV-1501" }), deps(t));
  assertEquals(none.link.status, "none");
  assertEquals(none.blockers.map((b) => `${b.code}:${b.owner}`), ["no_contact:BOOKKEEPING", "no_job_linked:BOOKKEEPING"]);
  assertEquals(none.coverage.job_linked, false);
});

Deno.test("3b. a single job through the Xero contact links; a stored job_number beats the reference", async () => {
  const t = baseTables();
  t.jobs = t.jobs.filter((j) => j.id !== "a0000000-0000-4000-8000-000000000004");
  const single = await invoiceContext(new URLSearchParams({ invoice: "INV-1500" }), deps(t));
  assertEquals(single.link.method, "contact_single_job");
  assertEquals(single.link.job_number, "SWF-261300");

  t.xero_invoices[1].job_number = "swf-261300";
  const stored = await invoiceContext(new URLSearchParams({ invoice: "INV-1373" }), deps(t));
  assertEquals(stored.link.method, "invoice.job_number");
  assertEquals(stored.link.job_number, "SWF-261300");
});

Deno.test("4. one failing source is reported, the rest of the picture still returns", async () => {
  const t = baseTables();
  const out = await invoiceContext(new URLSearchParams({ invoice: "INV-1419" }), deps(t, new Set(["current_job_context_facts", "payment_chase_logs"])));
  assertEquals(out.sources.facts.ok, false);
  assertStringIncludes(out.sources.facts.error!, "current_job_context_facts unavailable");
  assertEquals(out.sources.chase.ok, false);
  assertEquals(out.invoice.chase.count, 0);
  assertEquals(out.job.job_number, "SWMS-261399");
  assertEquals(out.conversation.messages.length, 4);
  assert(out.warnings.some((w) => w.startsWith("facts: read failed")));
  // a failed facts read still surfaces as a blocker so the card is never blank,
  // but it must NOT claim Luna has not extracted the job (M2)
  assert(out.blockers.some((b) => b.code === "facts_unreadable" && b.owner === "CIO"));
  assertEquals(out.blockers.some((b) => b.code === "facts_missing"), false);
  assertEquals(out.blockers.every((b) => !b.detail.includes("has not extracted")), true);
  assertEquals(out.coverage.facts_present, false);
});

Deno.test("5. bad input and unknown invoices are refused with a status", async () => {
  const t = baseTables();
  await assertRejects(() => invoiceContext(new URLSearchParams({}), deps(t)), InvoiceContextError, "invoice or xero_invoice_id is required");
  await assertRejects(() => invoiceContext(new URLSearchParams({ xero_invoice_id: "nope" }), deps(t)), InvoiceContextError, "must be a UUID");
  await assertRejects(() => invoiceContext(new URLSearchParams({ invoice: "INV-1419", mode: "everything" }), deps(t)), InvoiceContextError, "mode must be card or full");
  // LIKE wildcards are refused by name, so no invoice number can become a pattern
  await assertRejects(() => invoiceContext(new URLSearchParams({ invoice: "INV-%" }), deps(t)), InvoiceContextError, "wildcard characters % or _");
  await assertRejects(() => invoiceContext(new URLSearchParams({ invoice: "%" }), deps(t)), InvoiceContextError, "wildcard characters % or _");
  await assertRejects(() => invoiceContext(new URLSearchParams({ invoice: "INV_1419" }), deps(t)), InvoiceContextError, "wildcard characters % or _");
  await assertRejects(() => invoiceContext(new URLSearchParams({ invoice: "INV 1419" }), deps(t)), InvoiceContextError, "not a valid invoice number");
  await assertRejects(() => invoiceContext(new URLSearchParams({ invoice: "-INV-1419" }), deps(t)), InvoiceContextError, "not a valid invoice number");
  await assertRejects(() => invoiceContext(new URLSearchParams({ invoice: "I".repeat(65) }), deps(t)), InvoiceContextError, "not a valid invoice number");
  const err = await assertRejects(() => invoiceContext(new URLSearchParams({ invoice: "INV-9999" }), deps(t)), InvoiceContextError);
  assertEquals(err.status, 404);
  assertEquals(err.code, "invoice_not_found");
  // the paid invoice is still readable by number (the door is not limited to open ones)
  const paid = await invoiceContext(new URLSearchParams({ invoice: "INV-1416" }), deps(t));
  assertEquals(paid.invoice.status, "PAID");
  assertEquals(paid.job.other_open_invoices.map((o: any) => o.invoice_number), ["INV-1419"]);
});

Deno.test("6. coverage counts the open population with the same rules", async () => {
  const t = baseTables();
  const out = await debtContextCoverage(new URLSearchParams({}), deps(t));
  assertEquals(out.totals, {
    invoices: 4, amount_due: 10450.78, overdue: 3, linked: 2, ambiguous: 1, none: 1,
    contact_known: 3, ghl_contact_known: 1, facts_present: 1, conversation_present: 1, xero_fresh: 3, complete: 1, distinct_linked_jobs: 2,
  });
  const byNo = Object.fromEntries(out.rows.map((r: any) => [r.invoice_number, r]));
  assertEquals(byNo["INV-1419"].complete, true);
  assertEquals(byNo["INV-1419"].conversation_count, 3);
  assertEquals(byNo["INV-1419"].conversation_sources, { ghl_cache: 2, inbox: 0, business_events: 1, notes: 1 });
  // H2: coverage derives the last client message from inbox_events and inbound
  // business_events only. The GHL cache time lives in the door, which reads the
  // merged conversation for the one job.
  assertEquals(byNo["INV-1419"].last_client_message_at, "2026-09-03T00:00:00.000Z");
  assertEquals(out.warnings, []);
  // candidates are empty unless the link is ambiguous (L2)
  assertEquals(byNo["INV-1419"].candidates, []);
  assertEquals(byNo["INV-1373"].candidates, []);
  assertEquals(byNo["INV-1373"].blockers, ["no_ghl_contact", "facts_missing", "conversation_missing", "xero_stale"]);
  assertEquals(byNo["INV-1373"].extraction_queue, "skipped:1 (source_attribution_unproven), dead_letter:1 (source_attribution_ambiguous)");
  assertEquals(byNo["INV-1500"].link_status, "ambiguous");
  assertEquals(byNo["INV-1500"].candidates.length, 2);
  assertEquals(byNo["INV-1501"].blockers, ["no_contact", "no_job_linked"]);
  assertEquals(out.rows.some((r: any) => r.invoice_number === "INV-1416"), false);

  const overdue = await debtContextCoverage(new URLSearchParams({ population: "overdue" }), deps(t));
  assertEquals(overdue.totals.invoices, 3);
  await assertRejects(() => debtContextCoverage(new URLSearchParams({ population: "all" }), deps(t)), InvoiceContextError);
});

Deno.test("helpers: Xero dates, reference job numbers, queue detail", () => {
  assertEquals(parseXeroDate("/Date(1757462400000+0000)/"), "2025-09-10");
  assertEquals(parseXeroDate("2026-09-10T00:00:00"), "2026-09-10");
  assertEquals(parseXeroDate(null), null);
  assertEquals(jobNumberFromReference("Deposit swp-261180 patio"), "SWP-261180");
  assertEquals(jobNumberFromReference("MLB-24911", "INV-1419"), null);
  assertEquals(queueDetail(undefined), "never_enqueued");
});

Deno.test("7. multi-row reads page past the PostgREST 1000-row cap", async () => {
  const t = baseTables();
  // The fake client enforces the real 1000-row response cap, so an unpaged
  // .limit(5000) would come back with exactly 1000 of these.
  t.business_events = [];
  for (let i = 0; i < 2500; i += 1) {
    t.business_events.push({ id: `be-${String(i).padStart(5, "0")}`, job_id: JOB1, event_type: "client.email_in", occurred_at: `2026-08-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z` });
  }
  t.current_job_context_facts = [];
  for (let i = 0; i < 1500; i += 1) {
    t.current_job_context_facts.push({ id: `f-${String(i).padStart(5, "0")}`, job_id: JOB1, kind: "note", value: `n${i}`, provenance: {}, updated_at: "2026-09-10T00:00:00.000Z", _context_store: "job_context" });
  }

  const out = await debtContextCoverage(new URLSearchParams({}), deps(t));
  const row = out.rows.find((r: any) => r.invoice_number === "INV-1419")!;
  assertEquals(row.conversation_sources!.business_events, 2500);
  assertEquals(row.conversation_count, 2502); // 2500 business_events + 2 ghl_cache
  assertEquals(row.facts_count, 1500);
  assertEquals(out.warnings, []);
  assertEquals(out.totals.facts_present, 1);

  // the door agrees, through the same batched counter
  const door = await invoiceContext(new URLSearchParams({ invoice: "INV-1419" }), deps(t));
  assertEquals(door.coverage.conversation_present, true);
  assertEquals(door.coverage.facts_present, true);
});

Deno.test("8. a LIKE wildcard is escaped, never interpreted", () => {
  assertEquals(escapeLikeLiteral("INV-1419"), "INV-1419");
  assertEquals(escapeLikeLiteral("INV%19"), "INV\\%19");
  assertEquals(escapeLikeLiteral("INV_19"), "INV\\_19");
  assertEquals(escapeLikeLiteral("INV\\19"), "INV\\\\19");
});

Deno.test("9. an unreadable source is an unreadable blocker, never a missing one", async () => {
  // facts view down: the door must not say Luna has not extracted the job
  const t1 = baseTables();
  const facts = await invoiceContext(new URLSearchParams({ invoice: "INV-1419" }), deps(t1, new Set(["current_job_context_facts"])));
  assertEquals(facts.blockers.map((b) => b.code), ["facts_unreadable"]);
  assertEquals(facts.blockers[0].owner, "CIO");
  assertStringIncludes(facts.blockers[0].detail, "is unknown");
  assertEquals(facts.coverage.facts_present, false);

  // extraction queue down: queue detail is "unknown", never "never_enqueued" (L1)
  const t2 = baseTables();
  t2.current_job_context_facts = [];
  const queue = await invoiceContext(new URLSearchParams({ invoice: "INV-1419" }), deps(t2, new Set(["extraction_jobs"])));
  const missing = queue.blockers.find((b) => b.code === "facts_missing")!;
  assertStringIncludes(missing.detail, "unknown (queue unreadable)");
  assertEquals(queueDetail(undefined, false), "unknown (queue unreadable)");
  assertEquals(queueDetail(undefined, true), "never_enqueued");

  // message counts down: conversation_unreadable, and the flag is false
  const t3 = baseTables();
  const conv = await invoiceContext(new URLSearchParams({ invoice: "INV-1419" }), deps(t3, new Set(["inbox_events"])));
  assert(conv.blockers.some((b) => b.code === "conversation_unreadable" && b.owner === "CIO"));
  assertEquals(conv.blockers.some((b) => b.code === "conversation_missing"), false);
  assertEquals(conv.coverage.conversation_present, false);
  assert(conv.warnings.some((w) => w.startsWith("conversation_presence: read failed")));

  // job detail read down while the link itself resolved: job_read_failed (M2)
  const t4 = baseTables();
  const jobDown = await invoiceContext(new URLSearchParams({ invoice: "INV-1419" }), deps(t4, undefined, { jobs: 2 }));
  assert(jobDown.blockers.some((b) => b.code === "job_read_failed" && b.owner === "CIO"));
  assertEquals(jobDown.blockers.some((b) => b.code === "no_job_linked"), false);
  assertEquals(jobDown.link.status, "linked");
  assertEquals(jobDown.coverage.job_linked, false);

  // coverage carries the same codes
  const cov = await debtContextCoverage(new URLSearchParams({}), deps(baseTables(), new Set(["current_job_context_facts", "inbox_events"])));
  const row = cov.rows.find((r: any) => r.invoice_number === "INV-1419")!;
  assertEquals(row.blockers, ["facts_unreadable", "conversation_unreadable"]);
  assertEquals(row.facts_count, null);
  assertEquals(row.conversation_count, null);
  assertEquals(row.complete, false);
  assert(cov.warnings.some((w) => w.startsWith("facts: read failed")));
});

Deno.test("10. the door and the coverage read agree on every flag and blocker", async () => {
  const t = baseTables();
  const cov = await debtContextCoverage(new URLSearchParams({}), deps(t));
  assert(cov.rows.length > 0);
  for (const row of cov.rows) {
    const door = await invoiceContext(new URLSearchParams({ xero_invoice_id: row.xero_invoice_id }), deps(t));
    assertEquals(door.link.status, row.link_status, `${row.invoice_number} link status`);
    assertEquals(door.coverage.job_linked, Boolean(row.job_id), `${row.invoice_number} job_linked`);
    assertEquals(door.coverage.contact_known, row.contact_known, `${row.invoice_number} contact_known`);
    assertEquals(door.coverage.facts_present, (row.facts_count ?? 0) > 0, `${row.invoice_number} facts_present`);
    assertEquals(door.coverage.conversation_present, (row.conversation_count ?? 0) > 0, `${row.invoice_number} conversation_present`);
    assertEquals(door.coverage.xero_fresh, row.xero_fresh, `${row.invoice_number} xero_fresh`);
    assertEquals(
      door.blockers.map((b) => b.code).sort(),
      [...row.blockers].sort(),
      `${row.invoice_number} blockers`,
    );
    // candidates only when ambiguous (L2)
    assertEquals(door.link.candidates.length > 0, door.link.status === "ambiguous", `${row.invoice_number} candidates`);
  }
});

Deno.test("11. a job number that matches nothing is named in the blocker, not in candidates", async () => {
  const t = baseTables();
  t.jobs = t.jobs.filter((j) => j.job_number !== "SWP-261180");
  const out = await invoiceContext(new URLSearchParams({ invoice: "INV-1373" }), deps(t));
  assertEquals(out.link.status, "none");
  assertEquals(out.link.candidates, []);
  const b = out.blockers.find((x) => x.code === "no_job_linked")!;
  assertStringIncludes(b.detail, "SWP-261180");
  assertStringIncludes(b.detail, "does not match any job");

  // a stored job_id pointing at nothing is also a blocker detail, not a candidate
  const t2 = baseTables();
  t2.jobs = t2.jobs.filter((j) => j.id !== JOB1);
  const ghost = await invoiceContext(new URLSearchParams({ invoice: "INV-1419" }), deps(t2));
  assertEquals(ghost.link.candidates, []);
  assertStringIncludes(ghost.blockers.find((x) => x.code === "no_job_linked")!.detail, "points at a job that does not exist");
});
