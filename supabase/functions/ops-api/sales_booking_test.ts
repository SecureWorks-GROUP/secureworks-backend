import { assert, assertEquals, assertRejects, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  approveAction,
  archiveCase,
  createStore,
  dispatch,
  onEvent,
  persistDraft,
  reconcile,
  restoreCase,
  runnerTick,
  type Adapters,
} from "./sales_booking.ts";

function fakeAdapters(over: Partial<Adapters> = {}): Adapters {
  const opps = [
    { id: "opp-a", contact_id: "c-a", name: "Sample A", suburb: "Carlisle", tags: [] },
    { id: "opp-b", contact_id: "c-b", name: "Sample B", suburb: "Merriwa", tags: ["web - enquiry"] },
    { id: "opp-c", contact_id: "c-c", name: "0411111111", suburb: "Fremantle", tags: ["sw fencing"] },
  ];
  return {
    listOpportunities: async () => ({ items: opps, next: null, complete: true, total: 3 }),
    calendarEvents: async () => ({
      ok: true,
      mailbox: "nithin@secureworkswa.com.au",
      coverage: { operational_leave: "not_read", calendar_view_complete: true },
      events: [{
        event_id: "evt-1",
        subject: "Scope visit",
        start_iso: "2026-09-15T11:30:00+08:00",
        end_iso: "2026-09-15T12:30:00+08:00",
        suburb: "City Beach",
      }],
    }),
    contextFacts: async () => [{ key: "suburb", value: "Carlisle", current: true }],
    sendSms: async (_p, opts) => {
      if (!opts.execute) return { held: true, sent: false };
      if (!opts.fake) throw new Error("live send");
      return { held: false, sent: true, message_id: "fake-sms-1", provider: "fake" };
    },
    writeCalendar: async (_p, opts) => {
      if (!opts.execute) return { held: true, written: false };
      if (!opts.fake) throw new Error("live calendar");
      return { held: false, written: true, event_id: "fake-cal-1" };
    },
    ...over,
  };
}

Deno.test("full unscoped workload read enumerates fake opportunities and diary events", async () => {
  const store = createStore();
  const data = await dispatch("sales_booking_read", { resource: "nithin", week_start: "2026-09-14" }, {}, fakeAdapters(), store) as any;
  assertEquals(data.ok, true);
  assertEquals(data.fixture, false);
  assertEquals(data.send_hold, true);
  assertEquals(data.coverage.full_population, true);
  assertEquals(data.coverage.enumerated, 3);
  assert(data.cases.some((c: { id: string }) => c.id === "opp-a"));
  assert(data.cases.some((c: { status: string }) => c.status === "booked"));
  assertEquals(data.coverage.operational_leave, "not_read");
});

Deno.test("draft persist is durable across a later read", async () => {
  const store = createStore();
  await dispatch("sales_booking_read", { resource: "nithin", week_start: "2026-09-14" }, {}, fakeAdapters(), store);
  const draft = persistDraft(store, { case_id: "opp-a", text: "Hi, Thursday 1pm?", human_edited: true });
  assertEquals(draft.revision, 1);
  const again = await dispatch("sales_booking_read", { resource: "nithin", week_start: "2026-09-14" }, {}, fakeAdapters(), store) as any;
  const row = again.cases.find((c: { id: string }) => c.id === "opp-a");
  assertEquals(row.draft.text, "Hi, Thursday 1pm?");
});

Deno.test("archive refuses outstanding commitment and restore does not delete contact", async () => {
  const store = createStore();
  await dispatch("sales_booking_read", { resource: "nithin", week_start: "2026-09-14" }, {}, fakeAdapters(), store);
  assertThrows(() => archiveCase(store, { case_id: "evt-1", reason: "declined" }));
  const rec = archiveCase(store, { case_id: "opp-b", reason: "declined" });
  assertEquals(rec.crm_deleted, false);
  assertEquals(rec.contact_id, "c-b");
  const restored = restoreCase(store, "opp-b");
  assertEquals(restored.crm_deleted, false);
  assertEquals(restored.contact_id, "c-b");
});

Deno.test("held approve does not send; fake execute sends only through fake provider", async () => {
  const store = createStore();
  const adapters = fakeAdapters();
  await dispatch("sales_booking_read", { resource: "nithin", week_start: "2026-09-14" }, {}, adapters, store);
  const held = await approveAction(store, adapters, { case_id: "opp-a", kind: "approve_offer", text: "Hi" });
  assertEquals(held.sent, false);
  assertEquals(held.held, true);
  assertEquals(held.waiting, false);
  const fake = await approveAction(store, adapters, {
    case_id: "opp-a",
    kind: "approve_offer",
    text: "Hi",
    start_iso: "2026-09-17T13:00:00+08:00",
    execute: true,
    fake: true,
  }, false);
  assertEquals(fake.sent, true);
  assertEquals(fake.fake, true);
  await assertRejects(() =>
    approveAction(store, adapters, {
      case_id: "opp-a",
      kind: "approve_offer",
      execute: true,
      fake: false,
    }, false)
  );
});

Deno.test("confirm booking without exact acceptance is refused", async () => {
  const store = createStore();
  await dispatch("sales_booking_read", { resource: "nithin", week_start: "2026-09-14" }, {}, fakeAdapters(), store);
  const result = await approveAction(store, fakeAdapters(), {
    case_id: "opp-a",
    kind: "confirm_booking",
    exact_acceptance: false,
  });
  assertEquals(result.reason, "no_exact_acceptance");
  assertEquals(result.booked, false);
});

Deno.test("Marnin sender unresolved blocks approve", async () => {
  const store = createStore();
  const adapters = fakeAdapters();
  await dispatch("sales_booking_read", { resource: "marnin", week_start: "2026-09-14" }, {}, adapters, store);
  const result = await approveAction(store, adapters, { case_id: "opp-a", kind: "approve_offer" });
  // opp-a was stored under last read resource marnin
  assertEquals(result.reason, "sender_unresolved");
});

Deno.test("event hook dedupes and leaves waiting", async () => {
  const store = createStore();
  await dispatch("sales_booking_read", { resource: "nithin", week_start: "2026-09-14" }, {}, fakeAdapters(), store);
  store.cases.get("opp-a")!.status = "waiting";
  const first = onEvent(store, { event_key: "ghl:msg:1", type: "inbound", case_id: "opp-a" });
  const second = onEvent(store, { event_key: "ghl:msg:1", type: "inbound", case_id: "opp-a" });
  assertEquals(first.duplicate, false);
  assertEquals(second.duplicate, true);
  assertEquals(store.cases.get("opp-a")!.status, "needs_decision");
});

Deno.test("reconcile invalidates assessments; runner stays held", async () => {
  const store = createStore();
  store.assessments.set("opp-a", { case_id: "opp-a", version: "v2.1", payload: { status: "ready" } });
  const rec = reconcile(store, { reason: "calendar_change" });
  assertEquals(rec.invalidated, 1);
  assertEquals(store.assessments.get("opp-a")!.invalidated, true);
  const run = runnerTick(store);
  assertEquals(run.ran, false);
  assertEquals(run.reason, "runner_held");
});

Deno.test("writes require POST", async () => {
  const store = createStore();
  await assertRejects(() => dispatch("sales_booking_draft", {}, { case_id: "x" }, fakeAdapters(), store, "GET"));
});
