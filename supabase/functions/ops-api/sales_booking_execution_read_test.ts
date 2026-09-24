// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  bookingContentHash,
  bookingHash,
  type ExecutableApprovalRecord,
} from "../_shared/booking_approval_gate.ts";
import type { BookingObject } from "./sales_booking_confirmation.ts";
import {
  salesBookingBookAction,
  type SalesBookingExecuteDeps,
  salesBookingSendAction,
} from "./sales_booking_execute.ts";
import {
  applySalesBookingExecutions,
  EXECUTION_IN_PROGRESS_MS,
} from "./sales_booking_execution_read.ts";
import type { SalesBookingReadResponse } from "./sales_booking_read.ts";
import { applySalesBookingVisits } from "./sales_booking_visits.ts";

type Obj = BookingObject;
const NOW = new Date("2026-09-24T01:00:00Z");
const CAPTAIN = "marnin@secureworkswa.com.au";
const captain = { mode: "jwt" as const, email: CAPTAIN, userId: "u1" };
const GHL_USER = "marnin-ghl";
const CALENDAR = {
  provider: "ghl",
  calendar_id: "stratco-cal",
  assigned_user_id: GHL_USER,
  start_iso: "2026-09-25T09:00:00+08:00",
  end_iso: "2026-09-25T10:30:00+08:00",
  window_start_iso: "2026-09-25T09:00:00+08:00",
  window_end_iso: "2026-09-25T09:30:00+08:00",
  title: "Scope: Example",
  address: "1 Fictional Street, Perth",
};
const MESSAGE = {
  text: "Hi, does Friday suit for the fence scope?",
  sender: "+61489267776",
  recipient: "+61400000002",
  variant: "template",
};
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

async function approval(
  step: "calendar" | "message",
  contact: string,
  content: Obj,
  overrides: Partial<ExecutableApprovalRecord> = {},
): Promise<ExecutableApprovalRecord & Obj> {
  const snapshot: Obj = {
    schema: "scope-booking-approval.v1",
    step,
    case_id: `opp:${contact}`,
    contact_id: contact,
    resource: "marnin",
    scoper_user_id: "706c5258-70dd-483a-b36c-af6864b24498",
    week_start: "2026-09-21",
    id: `opp:${contact}`,
    profile: "fencing-stratco-marnin",
    pack_revision: "a".repeat(64),
    content_hash: null,
    content,
  };
  snapshot.content_hash = await bookingContentHash(snapshot);
  return {
    binding_hash: await bookingHash(snapshot),
    step,
    resource: "marnin",
    week_start: "2026-09-21",
    state: "approved",
    reason: null,
    snapshot,
    approved_by_email: CAPTAIN,
    approved_at: ago(60_000),
    expires_at: new Date(NOW.getTime() + 14 * 60_000).toISOString(),
    ...overrides,
  };
}

function lead(contact: string): Obj {
  return {
    id: `opp:${contact}`,
    contact_id: contact,
    opportunity_id: contact,
    display_name: `Lead ${contact}`,
    booking_read_model: {
      contact_id: contact,
      calendar_write: {
        state: "awaiting_approval",
        approval: null,
        receipt: null,
      },
      message: { state: "awaiting_approval", approval: null, receipt: null },
    },
  };
}

function workspace(contacts: string[], diary: Obj[] = []) {
  return {
    resource: {
      resource_id: "marnin",
      scoper_user_id: "706c5258-70dd-483a-b36c-af6864b24498",
    },
    week: {
      since: "2026-09-21T00:00:00+08:00",
      until_exclusive: "2026-09-28T00:00:00+08:00",
    },
    week_start: "2026-09-21",
    booking_flow: { version: "booking-confirm.v1" },
    diary_read: { ghl_user_id: GHL_USER },
    diary,
    cases: contacts.map(lead),
  } as unknown as SalesBookingReadResponse;
}

/** Tables as arrays; the PostgREST subset the read uses. */
function database(tables: Record<string, Obj[]>, fail?: string) {
  const calls: Obj[] = [];
  return {
    calls,
    tables,
    from(table: string) {
      const call: Obj = { table, filters: [] };
      calls.push(call);
      const query: Obj = {};
      for (const name of ["select", "eq", "gte", "lt", "in", "order"]) {
        query[name] = (...args: unknown[]) => {
          call.filters.push([name, ...args]);
          return query;
        };
      }
      query.range = (start: number, end: number) => {
        let rows = tables[table] ?? [];
        for (const [method, field, value] of call.filters) {
          if (method === "eq") rows = rows.filter((r) => r[field] === value);
          if (method === "in") {
            rows = rows.filter((r) => value.includes(r[field]));
          }
          if (method === "gte") {
            rows = rows.filter((r) =>
              Date.parse(r[field]) >= Date.parse(value)
            );
          }
          if (method === "lt") {
            rows = rows.filter((r) => Date.parse(r[field]) < Date.parse(value));
          }
        }
        return Promise.resolve({
          data: fail === table ? null : rows.slice(start, end + 1),
          error: fail === table ? { message: "failed read" } : null,
        });
      };
      return query;
    },
  };
}

function press(
  a: Obj,
  state: string,
  claimedAgoMs: number,
  extra: Obj = {},
): Obj {
  const finished = !["claimed", "sending"].includes(state);
  return {
    binding_hash: a.binding_hash,
    step: a.step,
    contact_id: a.snapshot.contact_id,
    state,
    message_id: null,
    appointment_id: null,
    claimed_by_email: CAPTAIN,
    claimed_at: ago(claimedAgoMs),
    finished_at: finished ? ago(claimedAgoMs - 5_000) : null,
    ...extra,
  };
}

function writerRow(key: string, state: string, appointmentId?: string): Obj {
  return {
    location_id: "loc-1",
    idempotency_key: key,
    assigned_user_id: GHL_USER,
    start_time: CALENDAR.start_iso,
    end_time: CALENDAR.end_iso,
    state,
    result: state === "complete"
      ? {
        appointmentId,
        calendarId: "stratco-cal",
        startTime: CALENDAR.start_iso,
        endTime: CALENDAR.end_iso,
      }
      : null,
  };
}

async function read(
  db: ReturnType<typeof database>,
  response: SalesBookingReadResponse,
) {
  return await applySalesBookingVisits(
    db,
    await applySalesBookingExecutions(db, response, NOW),
    {
      visit_outcomes_from: "2026-09-17T00:00:00+08:00",
      visit_outcomes_to: "2026-09-24T09:00:00+08:00",
    },
    NOW,
  );
}
const caseOf = (r: SalesBookingReadResponse, contact: string) =>
  r.cases.find((c) => c.contact_id === contact)! as Obj;

Deno.test("1. an executor booking is a booked visit and a booked diary event, joined on the executor's record, not a publisher receipt", async () => {
  const cal = await approval("calendar", "c1", CALENDAR);
  const db = database({
    sales_booking_executions: [
      press(cal, "booked", 30 * 60_000, { appointment_id: "appt-1" }),
    ],
    sales_booking_approvals: [cal],
    ghl_calendar_appointment_requests: [
      writerRow(cal.binding_hash, "complete", "appt-1"),
    ],
    visit_outcomes: [],
  });
  const diary = [
    { event_id: "appt-1", source: "ghl", mirror_of_ghl_event_id: null },
    { event_id: "ol-1", source: "outlook", mirror_of_ghl_event_id: "appt-1" },
    { event_id: "other", source: "ghl", mirror_of_ghl_event_id: null },
  ];
  // The published model carries no receipt key: before this change the
  // booking read as unresolved and the lead as approved only.
  const result = await read(db, workspace(["c1"], diary));
  const flow = result.booking_flow!;
  assertEquals(flow.booked_visits_read, "complete");
  assertEquals(flow.visit_read.unresolved_bookings, 0);
  assertEquals(flow.execution_read.state, "complete");
  assertEquals(result.booked_visits!.length, 1);
  const visit = result.booked_visits![0];
  assertEquals(visit.booking_key, cal.binding_hash);
  assertEquals(visit.appointment_id, "appt-1");
  assertEquals(visit.contact_id, "c1");
  assertEquals(visit.bound_by, "executor");
  assertEquals(visit.execution.state, "booked");
  const row = caseOf(result, "c1");
  assertEquals(row.booked_visits.length, 1);
  assertEquals(row.booking_executions[0].state, "booked");
  assertEquals(row.booking_executions[0].words, "Booked in GHL.");
  const channel = row.booking_read_model.calendar_write;
  assertEquals(channel.state, "succeeded");
  assertEquals(channel.receipt.appointment_id, "appt-1");
  assertEquals(channel.receipt.booking_key, cal.binding_hash);
  assertEquals(channel.approval.ui_snapshot, cal.snapshot);
  const diaryRows = result.diary as Obj[];
  assertEquals(diaryRows[0].booked_visit.state, "booked");
  assertEquals(diaryRows[0].booked_visit.contact_id, "c1");
  assertEquals(diaryRows[1].booked_visit.appointment_id, "appt-1");
  assertEquals(diaryRows[2].booked_visit, null);
});

Deno.test("1. an unsettled executor claim whose GHL writer row is complete still reads booked", async () => {
  const cal = await approval("calendar", "c1", CALENDAR);
  const db = database({
    sales_booking_executions: [press(cal, "claimed", 10 * 60_000)],
    sales_booking_approvals: [cal],
    ghl_calendar_appointment_requests: [
      writerRow(cal.binding_hash, "complete", "appt-9"),
    ],
    visit_outcomes: [],
  });
  const result = await read(db, workspace(["c1"]));
  const row = caseOf(result, "c1");
  assertEquals(row.booking_executions[0].state, "booked");
  assertEquals(row.booking_executions[0].appointment_id, "appt-9");
  assertEquals(result.booked_visits![0].appointment_id, "appt-9");
});

Deno.test("1. executor and writer naming different appointments is failed, and never a booked visit", async () => {
  const cal = await approval("calendar", "c1", CALENDAR);
  const db = database({
    sales_booking_executions: [
      press(cal, "booked", 10 * 60_000, { appointment_id: "appt-A" }),
    ],
    sales_booking_approvals: [cal],
    ghl_calendar_appointment_requests: [
      writerRow(cal.binding_hash, "complete", "appt-B"),
    ],
    visit_outcomes: [],
  });
  const result = await read(db, workspace(["c1"]));
  assertEquals(caseOf(result, "c1").booking_executions[0].state, "failed");
  assertEquals(result.booked_visits, []);
  assertEquals(result.booking_flow!.booked_visits_read, "partial");
});

Deno.test("2. a sent text shows as sent with the time, the exact text and the provider message id", async () => {
  const msg = await approval("message", "c2", MESSAGE);
  const row = press(msg, "sent", 20 * 60_000, { message_id: "msg-77" });
  const db = database({
    sales_booking_executions: [row],
    sales_booking_approvals: [msg],
    ghl_calendar_appointment_requests: [],
    visit_outcomes: [],
  });
  const result = await read(db, workspace(["c2"]));
  const view = caseOf(result, "c2").booking_executions[0];
  assertEquals(view.state, "sent");
  assertEquals(view.words, "Text sent.");
  assertEquals(view.sent_at, row.finished_at);
  assertEquals(view.text, MESSAGE.text);
  assertEquals(view.message_id, "msg-77");
  assertEquals(view.sender, MESSAGE.sender);
  assertEquals(view.recipient, MESSAGE.recipient);
  const channel = caseOf(result, "c2").booking_read_model.message;
  assertEquals(channel.state, "succeeded");
  assertEquals(channel.approved_text, MESSAGE.text);
  assertEquals(channel.receipt, {
    source: "sales_booking_executions",
    message_id: "msg-77",
    sent_at: row.finished_at,
    text: MESSAGE.text,
  });
  // A text is not a booking.
  assertEquals(result.booked_visits, []);
});

Deno.test("3. in progress, refused and failed presses each read in words, never as booked or sent", async () => {
  const fresh = EXECUTION_IN_PROGRESS_MS / 4,
    old = EXECUTION_IN_PROGRESS_MS * 5;
  const calFresh = await approval("calendar", "k1", CALENDAR);
  const msgFresh = await approval("message", "k2", MESSAGE);
  const calRefused = await approval("calendar", "k3", CALENDAR);
  const calUnknown = await approval("calendar", "k4", CALENDAR);
  const msgUnknown = await approval("message", "k5", MESSAGE);
  const msgStuck = await approval("message", "k6", MESSAGE);
  const db = database({
    sales_booking_executions: [
      press(calFresh, "claimed", fresh),
      press(msgFresh, "sending", fresh),
      press(calRefused, "claimed", old),
      press(calUnknown, "claimed", old),
      press(msgUnknown, "unknown", old),
      press(msgStuck, "sending", old),
    ],
    sales_booking_approvals: [
      calFresh,
      msgFresh,
      calRefused,
      calUnknown,
      msgUnknown,
      msgStuck,
    ],
    ghl_calendar_appointment_requests: [
      writerRow(calUnknown.binding_hash, "sending"),
    ],
    visit_outcomes: [],
  });
  const result = await read(
    db,
    workspace(["k1", "k2", "k3", "k4", "k5", "k6"]),
  );
  const expected: Array<[string, string, string, string, string]> = [
    ["k1", "calendar_write", "in_progress", "pending", "Booking in progress."],
    ["k2", "message", "in_progress", "pending", "Text sending now."],
    [
      "k3",
      "calendar_write",
      "refused",
      "failed",
      "Booking refused: pressed, but the GHL calendar writer did not book. Nothing was written to GHL.",
    ],
    [
      "k4",
      "calendar_write",
      "failed",
      "unknown",
      "Booking failed: GHL did not answer clearly, so the booking may or may not be there. It is never posted twice; pressing again only checks GHL.",
    ],
    [
      "k5",
      "message",
      "failed",
      "unknown",
      "Text send failed: the provider answer was unclear, so the text may or may not have gone. It will not be sent again.",
    ],
    [
      "k6",
      "message",
      "failed",
      "unknown",
      "Text send failed: the press never finished, so the text may or may not have gone. It will not be sent again.",
    ],
  ];
  for (const [contact, key, state, channelState, words] of expected) {
    const row = caseOf(result, contact);
    assertEquals(row.booking_executions[0].state, state, contact);
    assertEquals(row.booking_executions[0].words, words, contact);
    const channel = row.booking_read_model[key];
    assertEquals(channel.state, channelState, contact);
    assertEquals(channel.reason, words, contact);
    assertEquals(channel.receipt, null, contact);
    assertEquals(row.booking_executions[0].message_id, null, contact);
    assertEquals(row.booking_executions[0].appointment_id, null, contact);
  }
  assertEquals(result.booked_visits, []);
});

Deno.test("4. dry runs leave no record: the lead reads exactly as before the press, never booked or sent", async () => {
  const cal = await approval("calendar", "c1", CALENDAR);
  const msg = await approval("message", "c1", MESSAGE);
  const tables: Record<string, Obj[]> = {
    sales_booking_executions: [],
    sales_booking_approvals: [cal, msg],
    ghl_calendar_appointment_requests: [],
    visit_outcomes: [],
  };
  const deps = executorDeps(tables, {}); // both switches off: dry run
  const booked = await salesBookingBookAction({
    auth: captain,
    body: { approval_id: cal.binding_hash },
    method: "POST",
    deps,
  });
  const sent = await salesBookingSendAction({
    auth: captain,
    body: { approval_id: msg.binding_hash, dry_run: true },
    method: "POST",
    deps,
  });
  assertEquals(booked.status, "dry_run");
  assertEquals(sent.status, "dry_run");
  assertEquals(tables.sales_booking_executions, []);
  const before = workspace(["c1"]);
  const result = await read(database(tables), before);
  const row = caseOf(result, "c1");
  assertEquals(row.booking_executions, []);
  assertEquals(
    row.booking_read_model,
    (before.cases[0] as Obj).booking_read_model,
  );
  assertEquals(result.booked_visits, []);
});

Deno.test("a live press through the real executor reads back as booked and sent", async () => {
  const cal = await approval("calendar", "c1", CALENDAR);
  const msg = await approval("message", "c1", MESSAGE);
  const tables: Record<string, Obj[]> = {
    sales_booking_executions: [],
    sales_booking_approvals: [cal, msg],
    ghl_calendar_appointment_requests: [],
    visit_outcomes: [],
  };
  const deps = executorDeps(tables, {
    SALES_BOOKING_BOOK_EXECUTE: "true",
    SALES_BOOKING_SEND_EXECUTE: "true",
  });
  const booked = await salesBookingBookAction({
    auth: captain,
    body: { approval_id: cal.binding_hash },
    method: "POST",
    deps,
  });
  const sent = await salesBookingSendAction({
    auth: captain,
    body: { approval_id: msg.binding_hash },
    method: "POST",
    deps,
  });
  assertEquals(booked.status, "booked");
  assertEquals(sent.status, "sent");
  const result = await read(database(tables), workspace(["c1"]));
  const row = caseOf(result, "c1");
  assertEquals(
    row.booking_executions.map((e: Obj) => [e.step, e.state]).sort(),
    [["calendar", "booked"], ["message", "sent"]],
  );
  assertEquals(row.booking_read_model.calendar_write.state, "succeeded");
  assertEquals(row.booking_read_model.message.state, "succeeded");
  assertEquals(row.booking_read_model.message.receipt.message_id, "msg-1");
  assertEquals(result.booked_visits![0].appointment_id, "appt-1");
  assertEquals(result.booked_visits![0].bound_by, "executor");
});

Deno.test("a lead with no executor record is unchanged apart from an empty press list", async () => {
  const other = await approval("message", "c2", MESSAGE);
  const db = database({
    sales_booking_executions: [
      press(other, "sent", 60_000 * 30, { message_id: "m" }),
    ],
    sales_booking_approvals: [other],
    ghl_calendar_appointment_requests: [],
    visit_outcomes: [],
  });
  const before = workspace(["c1", "c2"]);
  const after = await applySalesBookingExecutions(db, before, NOW);
  assertEquals(caseOf(after, "c1"), {
    ...(before.cases[0] as Obj),
    booking_executions: [],
  });
  assertEquals(caseOf(after, "c2").booking_executions.length, 1);
});

Deno.test("a newer live approval that has not been pressed keeps its own approved state", async () => {
  const oldText = await approval("message", "c1", MESSAGE);
  const newText = await approval("message", "c1", {
    ...MESSAGE,
    text: "Confirmed for Friday 9am.",
  });
  const db = database({
    sales_booking_executions: [
      press(oldText, "sent", 60 * 60_000, { message_id: "m-old" }),
    ],
    sales_booking_approvals: [oldText, newText],
    ghl_calendar_appointment_requests: [],
    visit_outcomes: [],
  });
  const response = workspace(["c1"]);
  (response.cases[0] as Obj).booking_read_model.message = {
    state: "approved",
    approval: { binding_hash: newText.binding_hash },
    receipt: null,
  };
  const result = await applySalesBookingExecutions(db, response, NOW);
  const channel = caseOf(result, "c1").booking_read_model.message;
  assertEquals(channel.state, "approved");
  assertEquals(channel.approval.binding_hash, newText.binding_hash);
  assertEquals(channel.execution.message_id, "m-old");
});

Deno.test("an unreadable executor ledger never claims no press and leaves channels alone", async () => {
  const before = workspace(["c1"]);
  const result = await applySalesBookingExecutions(
    database({}, "sales_booking_executions"),
    before,
    NOW,
  );
  assertEquals(result.booking_flow!.execution_read.state, "could_not_read");
  assertEquals(
    result.booking_flow!.execution_read.reason,
    "booking_executions_store_unreadable",
  );
  assertEquals(caseOf(result, "c1").booking_executions, null);
  assertEquals(
    caseOf(result, "c1").booking_read_model,
    (before.cases[0] as Obj).booking_read_model,
  );
});

Deno.test("a press on another resource or a contact on two leads is not attached", async () => {
  const foreign = await approval("message", "c1", MESSAGE);
  foreign.snapshot = { ...(foreign.snapshot as Obj), resource: "nithin" };
  const dup = await approval("message", "c2", MESSAGE);
  const db = database({
    sales_booking_executions: [
      press(foreign, "sent", 60_000 * 30, { message_id: "m1" }),
      press(dup, "sent", 60_000 * 30, { message_id: "m2" }),
    ],
    sales_booking_approvals: [foreign, dup],
    ghl_calendar_appointment_requests: [],
    visit_outcomes: [],
  });
  const response = workspace(["c1", "c2"]);
  response.cases.push({ ...lead("c2"), id: "opp:c2-second" } as never);
  const result = await applySalesBookingExecutions(db, response, NOW);
  assertEquals(caseOf(result, "c1").booking_executions, []);
  assertEquals(
    result.cases.filter((c) => c.contact_id === "c2").map((c) =>
      c.booking_executions
    ),
    [[], []],
  );
  assertEquals(result.booking_flow!.execution_read.unattached, 1);
});

/** The real executor over an in-memory copy of the two ledgers it writes. */
function executorDeps(
  tables: Record<string, Obj[]>,
  env: Obj,
): SalesBookingExecuteDeps {
  const execs = tables.sales_booking_executions;
  const find = (h: string) => execs.find((r) => r.binding_hash === h);
  return {
    findApproval: (h) =>
      Promise.resolve(
        (tables.sales_booking_approvals.find((a) =>
          a.binding_hash === h
        ) as ExecutableApprovalRecord) ?? null,
      ),
    appointmentLedger: (k) =>
      Promise.resolve(
        (tables.ghl_calendar_appointment_requests.find((r) =>
          r.idempotency_key === k
        ) as { state: string; result: Obj | null } | undefined) ?? null,
      ),
    readThread: () => Promise.resolve([]),
    readOutlook: () =>
      Promise.resolve({ ok: true, mailbox: CAPTAIN, events: [] }),
    readContactPhone: () => Promise.resolve("0400 000 002"),
    readOutlookLead: () =>
      Promise.resolve({
        contact: {
          firstName: "Example",
          lastName: "Lead",
          city: "Scarborough",
        },
        suburb: "Scarborough",
      }),
    mirrorToOutlook: () =>
      Promise.resolve({
        ok: true,
        code: "mirrored",
        wrote: true,
        outlook_event_id: "outlook-1",
        ghl_appointment_id: "appt-1",
      }),
    callAppointmentWriter(body) {
      const { idempotencyKey, dryRun, ...fields } = body;
      if (dryRun === true) {
        return Promise.resolve({
          status: 200,
          body: {
            ok: false,
            code: "dry_run",
            dryRun: true,
            wouldWrite: fields,
          },
        });
      }
      const row = writerRow(idempotencyKey, "complete", "appt-1");
      tables.ghl_calendar_appointment_requests.push(row);
      return Promise.resolve({
        status: 200,
        body: { ok: true, ...row.result, reused: false },
      });
    },
    callSendSms: () =>
      Promise.resolve({
        status: 200,
        body: { success: true, messageId: "msg-1" },
      }),
    executions: {
      get: (h) => Promise.resolve((find(h) as never) ?? null),
      claim(row) {
        if (find(row.binding_hash)) return Promise.resolve(false);
        execs.push({
          ...row,
          state: row.step === "calendar" ? "claimed" : "sending",
          message_id: null,
          appointment_id: null,
          claimed_at: NOW.toISOString(),
          finished_at: null,
        });
        return Promise.resolve(true);
      },
      settle(h, outcome) {
        Object.assign(find(h)!, {
          state: outcome.state,
          message_id: outcome.state === "sent" ? outcome.message_id : null,
          appointment_id: outcome.state === "booked"
            ? outcome.appointment_id
            : null,
          finished_at: NOW.toISOString(),
        });
        return Promise.resolve();
      },
    },
    envGet: (name) => env[name],
    now: () => NOW,
  };
}

Deno.test("with no executor rows the composed read equals the old composition, apart from additive keys", async () => {
  // Marnin's week as it stands: a published-receipt booking, a diary with a
  // GHL event, its Outlook mirror and a private block, and nothing executed.
  const response = workspace(["c1", "c2"], [
    { event_id: "appt-p", source: "ghl", mirror_of_ghl_event_id: null },
    { event_id: "ol-p", source: "outlook", mirror_of_ghl_event_id: "appt-p" },
    { event_id: "ol-x", source: "outlook", mirror_of_ghl_event_id: null },
  ]);
  (response.cases[0] as Obj).booking_read_model.calendar_write.receipt = {
    booking_key: "published-key",
  };
  const tables = {
    sales_booking_executions: [],
    sales_booking_approvals: [],
    ghl_calendar_appointment_requests: [
      writerRow("published-key", "complete", "appt-p"),
    ],
    visit_outcomes: [],
  };
  const window = {
    visit_outcomes_from: "2026-09-17T00:00:00+08:00",
    visit_outcomes_to: "2026-09-24T09:00:00+08:00",
  };
  const before = await applySalesBookingVisits(
    database(tables),
    response,
    window,
    NOW,
  );
  const after = await read(database(tables), response);
  const strip = (r: SalesBookingReadResponse) => {
    const copy = structuredClone(r) as Obj;
    delete copy.booking_flow.execution_read;
    for (const row of copy.cases) delete row.booking_executions;
    for (const entry of copy.diary) delete entry.booked_visit;
    for (const visit of copy.booked_visits) {
      delete visit.bound_by;
      delete visit.execution;
    }
    for (const row of copy.cases) {
      for (const visit of row.booked_visits) {
        delete visit.bound_by;
        delete visit.execution;
      }
    }
    return copy;
  };
  assertEquals(strip(after), strip(before));
  assertEquals(after.booked_visits![0].bound_by, "published_receipt");
  assertEquals(
    (after.diary as Obj[]).map((e) => e.booked_visit?.state ?? null),
    ["booked", "booked", null],
  );
});
