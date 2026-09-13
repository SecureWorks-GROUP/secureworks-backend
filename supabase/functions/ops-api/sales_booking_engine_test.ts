import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { runAssessment, sourceHash, assembleEnvelope } from "./sales_booking_engine.ts";
import { dispatch, createMemoryBookingDb, persistDraft, type BookingActor, type Adapters } from "./sales_booking.ts";

const ACTOR: BookingActor = { org_id: "00000000-0000-0000-0000-000000000001", user_id: "user-1", role: "admin" };

Deno.test("empty messages classify unassessed, not ready", async () => {
  const r = await runAssessment({ input: { messages: [], week_start: "2026-09-14" } });
  assertEquals(r.classification, "unassessed_conversation");
  assertEquals(r.status, "needs_decision");
  assertEquals(r.proposal, null);
});

Deno.test("unchanged source hash skips a second model call", async () => {
  let calls = 0;
  const input = {
    input: {
      week_start: "2026-09-14",
      now: "2026-09-12T13:00:00Z",
      messages: [{ id: "in-1", direction: "inbound", timestamp: "2026-09-12T13:00:00Z", body: "Afternoons work" }],
      calendar_retrieved_at: "2026-09-12T13:00:00Z",
      leave_retrieved_at: "2026-09-12T13:00:00Z",
      leave_intervals: [],
      travel_retrieved_at: "2026-09-12T13:00:00Z",
      travel_minutes: 0,
      events: [],
      resource: { name: "Nithin", lane: "patio", desk_rules: { monday_from: 12, no_wednesday: true, last_start: 15.5 } },
    },
  };
  const reason = async () => {
    calls += 1;
    return { customer_windows: [] };
  };
  const first = await runAssessment(input, { reason });
  const second = await runAssessment(input, { reason, cached_hash: String(first.source_hash), cached_payload: first });
  assertEquals(first.cache, "miss");
  assertEquals(second.cache, "hit");
  assertEquals(calls, 1);
  assertEquals(first.customer_facts && (first.customer_facts as { date_specified: boolean }).date_specified, false);
});

Deno.test("unread/not_read calendar is not Ready even if roster looks complete", async () => {
  const r = await runAssessment({
    input: {
      week_start: "2026-09-14",
      now: "2026-09-13T08:00:00Z",
      messages: [{ id: "in-1", direction: "inbound", timestamp: "2026-09-12T13:00:00Z", body: "Afternoons work" }],
      calendar_retrieved_at: "2026-09-13T08:00:00Z",
      leave_retrieved_at: "2026-09-13T08:00:00Z",
      leave_intervals: [],
      travel_retrieved_at: "2026-09-13T08:00:00Z",
      travel_minutes: 12,
      events: [],
      coverage: {
        leave_roster_complete: true,
        leave_state: "not_read",
        travel_state: "observed",
        any_unread_or_not_read: true,
        treat_as_free: true,
      },
      resource: { name: "Nithin", lane: "patio", desk_rules: { monday_from: 12, no_wednesday: true, last_start: 15.5 } },
    },
  });
  assertEquals(r.status === "ready", false);
  assertEquals((r.proposal as { kind?: string } | null)?.kind === "proposal", false);
});

Deno.test("authorised local reason is configured and is not a paid model", async () => {
  const r = await runAssessment({
    input: {
      week_start: "2026-09-14",
      now: "2026-09-12T13:00:00Z",
      messages: [{ id: "in-1", direction: "inbound", timestamp: "2026-09-12T13:00:00Z", body: "Afternoons work" }],
      calendar_retrieved_at: "2026-09-12T13:00:00Z",
      leave_retrieved_at: "2026-09-12T13:00:00Z",
      leave_intervals: [],
      travel_retrieved_at: "2026-09-12T13:00:00Z",
      travel_minutes: 0,
      events: [],
      coverage: { leave_roster_complete: false, leave_state: "incomplete", travel_state: "unavailable" },
      resource: { name: "Nithin", lane: "patio", desk_rules: { monday_from: 12, no_wednesday: true, last_start: 15.5 } },
    },
  });
  assertEquals(r.reasoning, "authorised_local_reason");
  assertEquals(r.paid_model, false);
  assertEquals(r.intelligent_automation, false);
  assertEquals(r.status === "ready", false);
});

Deno.test("dispatch assess uses the TypeScript engine when no adapter is supplied", async () => {
  const db = createMemoryBookingDb();
  await db.upsert("sales_booking_cases", { id: "opp-a", org_id: ACTOR.org_id, resource_id: "nithin", source_version: "s1" });
  const adapters = { listOpportunities: async () => ({ items: [], next: null, complete: true }), calendarEvents: async () => ({ ok: true, events: [], retrieved_at: "2026-09-12T13:00:00Z", coverage: {} }) } as Adapters;
  const out = await dispatch("sales_booking_assess", {}, {
    case_id: "opp-a",
    input: {
      week_start: "2026-09-14",
      now: "2026-09-12T13:00:00Z",
      messages: [{ id: "in-1", direction: "inbound", timestamp: "2026-09-12T13:00:00Z", body: "Afternoons work" }],
      calendar_retrieved_at: "2026-09-12T13:00:00Z",
      leave_retrieved_at: "2026-09-12T13:00:00Z",
      leave_intervals: [],
      travel_retrieved_at: "2026-09-12T13:00:00Z",
      travel_minutes: 0,
      events: [],
    },
  }, adapters, db, "POST", ACTOR) as { payload: { version: string; classification: string }; version?: string };
  assertEquals(out.payload.version, "sales-booking-assess-v2.4");
  assertEquals(String(out.payload.version || out.version), "sales-booking-assess-v2.4");
});
