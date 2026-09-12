import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  approveAction,
  claimSlot,
  createMemoryBookingDb,
  dispatch,
  onEvent,
  persistDraft,
  runnerTick,
  type Adapters,
} from "./sales_booking.ts";

function fakeAdapters(over: Partial<Adapters> = {}): Adapters {
  const opps = [
    { id: "opp-a", contact_id: "c-a", name: "Sample A", suburb: "Carlisle", tags: [] },
    { id: "opp-b", contact_id: "c-b", name: "Sample B", suburb: "Merriwa", tags: [] },
  ];
  return {
    listOpportunities: async () => ({ items: opps, next: null, complete: true, total: 2 }),
    calendarEvents: async () => ({
      ok: true,
      mailbox: "nithin@secureworkswa.com.au",
      retrieved_at: "2026-09-12T13:00:00Z",
      coverage: {},
      events: [{ event_id: "evt-1", subject: "Scope", start_iso: "2026-09-15T11:30:00+08:00", end_iso: "2026-09-15T12:30:00+08:00", suburb: "City Beach" }],
    }),
    coverageForResource: async () => ({
      leave_intervals: [],
      travel_minutes: 0,
      calendar_retrieved_at: "2026-09-12T13:00:00Z",
      leave_retrieved_at: "2026-09-12T13:00:00Z",
      travel_retrieved_at: "2026-09-12T13:00:00Z",
    }),
    sendSms: async (_p, opts) => {
      if (!opts.execute || !opts.fake) return { held: true, sent: false };
      return { held: false, sent: true, message_id: "fake-sms-1" };
    },
    assessCase: async (input) => ({ version: "test-assess", status: "needs_decision", ran: true, case_id: (input.case as { id?: string })?.id }),
    ...over,
  };
}

Deno.test("workload read enumerates and stores consumption cursor", async () => {
  const db = createMemoryBookingDb();
  const data = await dispatch("sales_booking_read", { resource: "nithin", week_start: "2026-09-14" }, {}, fakeAdapters(), db) as any;
  assertEquals(data.ok, true);
  assertEquals(data.coverage.full_population, true);
  assertEquals(data.coverage.enumerated, 2);
  assert(data.coverage.leave_retrieved_at);
  assertEquals(Array.isArray(data.coverage.leave_intervals), true);
});

Deno.test("interval overlap: 13:00-13:30 conflicts with 13:15-13:45", async () => {
  const db = createMemoryBookingDb();
  const a = await claimSlot(db, { claim_id: "c1", resource_id: "nithin", start_iso: "2026-09-17T13:00:00+08:00", end_iso: "2026-09-17T13:30:00+08:00", case_id: "case-a" });
  const b = await claimSlot(db, { claim_id: "c2", resource_id: "nithin", start_iso: "2026-09-17T13:15:00+08:00", end_iso: "2026-09-17T13:45:00+08:00", case_id: "case-b" });
  assertEquals(a.ok, true);
  assertEquals(b.ok, false);
  assertEquals(b.code, "slot_overlap");
});

Deno.test("adjacent 13:00-13:30 and 13:30-14:00 do not overlap", async () => {
  const db = createMemoryBookingDb();
  const a = await claimSlot(db, { claim_id: "c1", resource_id: "nithin", start_iso: "2026-09-17T13:00:00+08:00", end_iso: "2026-09-17T13:30:00+08:00", case_id: "a" });
  const b = await claimSlot(db, { claim_id: "c2", resource_id: "nithin", start_iso: "2026-09-17T13:30:00+08:00", end_iso: "2026-09-17T14:00:00+08:00", case_id: "b" });
  assertEquals(a.ok, true);
  assertEquals(b.ok, true);
});

Deno.test("leases are distinct from occupancy claims", async () => {
  const db = createMemoryBookingDb();
  await claimSlot(db, { claim_id: "occ", resource_id: "nithin", start_iso: "2026-09-17T13:00:00+08:00", end_iso: "2026-09-17T14:00:00+08:00", case_id: "a" });
  const l1 = await db.rpc("sales_booking_acquire_lease", { p_lease_id: "l1", p_case_id: "a", p_action_kind: "assess", p_token: "t1", p_owner: "w1", p_ttl_seconds: 60 });
  const l2 = await db.rpc("sales_booking_acquire_lease", { p_lease_id: "l2", p_case_id: "a", p_action_kind: "assess", p_token: "t2", p_owner: "w2", p_ttl_seconds: 60 });
  assertEquals(l1.data?.ok, true);
  assertEquals(l2.data?.ok, false);
  assertEquals(l2.data?.code, "lease_held");
});

Deno.test("onEvent does not report assessed without a worker", async () => {
  const db = createMemoryBookingDb();
  const adapters = fakeAdapters();
  delete (adapters as { assessCase?: unknown }).assessCase;
  const r = await onEvent(db, adapters, { event_key: "e1", type: "inbound", case_id: "opp-a" });
  assertEquals(r.assessed, false);
  assertEquals(r.reason, "no_assess_worker");
});

Deno.test("onEvent runs assess worker once; duplicate is idempotent", async () => {
  const db = createMemoryBookingDb();
  await db.upsert("sales_booking_cases", { id: "opp-a", resource_id: "nithin", status: "waiting" });
  const a = await onEvent(db, fakeAdapters(), { event_key: "e2", type: "inbound", case_id: "opp-a" });
  const b = await onEvent(db, fakeAdapters(), { event_key: "e2", type: "inbound", case_id: "opp-a" });
  assertEquals(a.assessed, true);
  assertEquals(b.duplicate, true);
  assertEquals(b.assessed, false);
});

Deno.test("runner enabled assesses; send remains held", async () => {
  const db = createMemoryBookingDb();
  await db.upsert("sales_booking_cases", { id: "opp-a", resource_id: "nithin", status: "needs_decision" });
  const held = await runnerTick(db, fakeAdapters(), { runner_enabled: false });
  assertEquals(held.ran, false);
  const ran = await runnerTick(db, fakeAdapters(), { runner_enabled: true });
  assertEquals(ran.ran, true);
  assertEquals(ran.assessed, 1);
  assertEquals(ran.sent, 0);
});

Deno.test("provider cursor keys are refused as consumption cursors", async () => {
  const db = createMemoryBookingDb();
  const r = await db.rpc("sales_booking_put_consumption_cursor", { p_key: "ghl-provider:nithin", p_payload: { start_after: 1 } });
  assertEquals(r.data?.ok, false);
  assertEquals(r.data?.code, "not_consumption_cursor");
});

Deno.test("held approve does not send; fake execute still isolated", async () => {
  const db = createMemoryBookingDb();
  await dispatch("sales_booking_read", { resource: "nithin", week_start: "2026-09-14" }, {}, fakeAdapters(), db);
  const held = await approveAction(db, fakeAdapters(), { case_id: "opp-a", kind: "approve_offer", text: "Hi" });
  assertEquals(held.sent, false);
  assertEquals(held.reason, "send_hold");
});

Deno.test("draft persists in the db stand-in", async () => {
  const db = createMemoryBookingDb();
  await db.upsert("sales_booking_cases", { id: "opp-a", resource_id: "nithin" });
  const d = await persistDraft(db, { case_id: "opp-a", text: "hello", human_edited: true });
  assertEquals(d.revision, 1);
  const again = await persistDraft(db, { case_id: "opp-a", text: "hello2" });
  assertEquals(again.revision, 2);
});
