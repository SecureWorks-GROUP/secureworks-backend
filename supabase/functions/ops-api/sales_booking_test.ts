import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  approveAction,
  claimSlot,
  createMemoryBookingDb,
  dispatch,
  onEvent,
  persistDraft,
  runnerTick,
  type Adapters,
  type BookingActor,
} from "./sales_booking.ts";

const ACTOR: BookingActor = { org_id: "00000000-0000-0000-0000-000000000001", user_id: "user-1", role: "admin" };
const OTHER: BookingActor = { org_id: "11111111-1111-1111-1111-111111111111", user_id: "user-2", role: "admin" };

function fakeAdapters(over: Partial<Adapters> = {}): Adapters {
  const opps = [
    { id: "opp-a", contact_id: "c-a", name: "Sample A", suburb: "Carlisle", tags: [] },
    { id: "opp-b", contact_id: "c-b", name: "Sample B", suburb: "Merriwa", tags: [] },
  ];
  return {
    listOpportunities: async () => ({ items: opps, next: null, complete: true, total: 2 }),
    calendarEvents: async () => ({
      ok: true, mailbox: "nithin@secureworkswa.com.au", retrieved_at: "2026-09-12T13:00:00Z", coverage: {},
      events: [{ event_id: "evt-1", subject: "Scope", start_iso: "2026-09-15T11:30:00+08:00", end_iso: "2026-09-15T12:30:00+08:00", suburb: "City Beach" }],
    }),
    coverageForResource: async () => ({
      leave_intervals: [], travel_minutes: 0,
      calendar_retrieved_at: "2026-09-12T13:00:00Z", leave_retrieved_at: "2026-09-12T13:00:00Z", travel_retrieved_at: "2026-09-12T13:00:00Z",
    }),
    sendSms: async (_p, opts) => (!opts.execute || !opts.fake) ? { held: true, sent: false } : { held: false, sent: true, message_id: "fake-sms-1" },
    writeCalendar: async (_p, opts) => (!opts.execute || !opts.fake) ? { held: true, written: false } : { held: false, written: true, event_id: "fake-cal-1" },
    assessCase: async (input) => ({ version: "test-assess", status: "needs_decision", ran: true, case_id: (input.case as { id?: string })?.id }),
    ...over,
  };
}

Deno.test("unavailable adapter is not a completed workload and remains refreshable", async () => {
  let calls = 0;
  const adapters = fakeAdapters({
    listOpportunities: async () => { calls += 1; return { items: [], next: null, complete: false }; },
  });
  const db = createMemoryBookingDb();
  const a = await dispatch("sales_booking_read", { resource: "nithin", week_start: "2026-09-14" }, {}, adapters, db, "GET", ACTOR) as any;
  const b = await dispatch("sales_booking_read", { resource: "nithin", week_start: "2026-09-14" }, { refresh: true }, adapters, db, "GET", ACTOR) as any;
  assertEquals(a.coverage.full_population, false);
  assertEquals(b.coverage.full_population, false);
  assertEquals(calls, 2);
});

Deno.test("failed draft write does not report saved revision", async () => {
  const db = createMemoryBookingDb();
  await db.upsert("sales_booking_cases", { id: "opp-a", org_id: ACTOR.org_id, resource_id: "nithin" });
  const orig = db.upsert.bind(db);
  db.upsert = async (table, row) => table === "sales_booking_drafts" ? { error: { message: "database refused" } } : orig(table, row);
  await assertRejects(() => persistDraft(db, { case_id: "opp-a", text: "x" }, ACTOR));
});

Deno.test("event failure remains retryable and then assesses", async () => {
  const db = createMemoryBookingDb();
  await db.upsert("sales_booking_cases", { id: "opp-a", org_id: ACTOR.org_id, resource_id: "nithin", source_version: "s1", status: "waiting" });
  let n = 0;
  const adapters = fakeAdapters({
    assessCase: async () => { n += 1; if (n === 1) throw new Error("boom"); return { version: "ok", status: "needs_decision" }; },
  });
  const first = await onEvent(db, adapters, { event_key: "e1", type: "inbound", case_id: "opp-a" }, ACTOR);
  const second = await onEvent(db, adapters, { event_key: "e1", type: "inbound", case_id: "opp-a" }, ACTOR);
  assertEquals(first.assessed, false);
  assertEquals(second.assessed, true);
  assertEquals(n, 2);
});

Deno.test("held approval retry is idempotent on the same claim", async () => {
  const db = createMemoryBookingDb();
  await dispatch("sales_booking_read", { resource: "nithin", week_start: "2026-09-14" }, {}, fakeAdapters(), db, "GET", ACTOR);
  const a = await approveAction(db, fakeAdapters(), { case_id: "opp-a", kind: "approve_offer", start_iso: "2026-09-17T13:00:00+08:00", end_iso: "2026-09-17T14:00:00+08:00" }, ACTOR);
  const b = await approveAction(db, fakeAdapters(), { case_id: "opp-a", kind: "approve_offer", start_iso: "2026-09-17T13:00:00+08:00", end_iso: "2026-09-17T14:00:00+08:00" }, ACTOR);
  assertEquals(a.reason, "send_hold");
  assertEquals(b.reason, "send_hold");
});

Deno.test("archive endpoint exists and is tenant scoped", async () => {
  const db = createMemoryBookingDb();
  await db.upsert("sales_booking_cases", { id: "opp-a", org_id: ACTOR.org_id, resource_id: "nithin", status: "ready" });
  const rec = await dispatch("sales_booking_archive", {}, { case_id: "opp-a", reason: "declined" }, fakeAdapters(), db, "POST", ACTOR) as any;
  assertEquals(rec.crm_deleted, false);
  await assertRejects(() => dispatch("sales_booking_archive", {}, { case_id: "opp-a", reason: "declined" }, fakeAdapters(), db, "POST", OTHER));
});

Deno.test("stale runner completion is refused when source moved", async () => {
  const db = createMemoryBookingDb();
  await db.upsert("sales_booking_cases", { id: "opp-a", org_id: ACTOR.org_id, resource_id: "nithin", status: "needs_decision", source_version: "s1" });
  let started = 0;
  const adapters = fakeAdapters({
    assessCase: async () => {
      started += 1;
      await db.upsert("sales_booking_cases", { id: "opp-a", org_id: ACTOR.org_id, resource_id: "nithin", status: "needs_decision", source_version: "s2" });
      return { version: "late", status: "needs_decision" };
    },
  });
  await assertRejects(() => runnerTick(db, adapters, { runner_enabled: true }, ACTOR));
  assertEquals(started, 1);
});

Deno.test("interval overlap still holds across cases", async () => {
  const db = createMemoryBookingDb();
  const a = await claimSlot(db, ACTOR, { claim_id: "c1", resource_id: "nithin", start_iso: "2026-09-17T13:00:00+08:00", end_iso: "2026-09-17T13:30:00+08:00", case_id: "case-a" });
  const b = await claimSlot(db, ACTOR, { claim_id: "c2", resource_id: "nithin", start_iso: "2026-09-17T13:15:00+08:00", end_iso: "2026-09-17T13:45:00+08:00", case_id: "case-b" });
  assertEquals(a.ok, true);
  assertEquals(b.code, "slot_overlap");
});

Deno.test("confirm fake execute calls writeCalendar", async () => {
  const db = createMemoryBookingDb();
  await db.upsert("sales_booking_cases", {
    id: "opp-a", org_id: ACTOR.org_id, resource_id: "nithin", exact_acceptance: true,
    accepted_start_iso: "2026-09-17T13:00:00+08:00", accepted_end_iso: "2026-09-17T14:00:00+08:00",
  });
  let cal = 0;
  const adapters = fakeAdapters({
    writeCalendar: async (_p, opts) => { cal += 1; return { held: false, written: !!opts.fake, event_id: "fake-cal-1" }; },
  });
  const r = await approveAction(db, adapters, {
    case_id: "opp-a", kind: "confirm_booking", exact_acceptance: true,
    start_iso: "2026-09-17T13:00:00+08:00", end_iso: "2026-09-17T14:00:00+08:00", fake: true, execute: true,
  }, ACTOR);
  assertEquals(cal, 1);
  assertEquals(r.booked, true);
});

Deno.test("unaccepted case cannot confirm by asserting exact_acceptance", async () => {
  const db = createMemoryBookingDb();
  await db.upsert("sales_booking_cases", { id: "opp-a", org_id: ACTOR.org_id, resource_id: "nithin" });
  const r = await approveAction(db, fakeAdapters(), { case_id: "opp-a", kind: "confirm_booking", exact_acceptance: true, fake: true, execute: true }, ACTOR);
  assertEquals(r.reason, "no_exact_acceptance");
});

Deno.test("staff operator is required", async () => {
  const db = createMemoryBookingDb();
  await assertRejects(() => dispatch("sales_booking_read", { resource: "nithin", week_start: "2026-09-14" }, {}, fakeAdapters(), db, "GET", { org_id: ACTOR.org_id, user_id: "x", role: "trade" }));
});
