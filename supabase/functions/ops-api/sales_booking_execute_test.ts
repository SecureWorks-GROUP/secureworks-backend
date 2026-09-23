// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  bookingContentHash,
  bookingHash,
  type ExecutableApprovalRecord,
} from "../_shared/booking_approval_gate.ts";
import {
  type ExecuteResult,
  type OutlookEvent,
  salesBookingBookAction,
  type SalesBookingExecuteDeps,
  salesBookingSendAction,
  type SendLedgerRow,
} from "./sales_booking_execute.ts";
import type { SalesBookingMessage } from "./sales_booking_read.ts";

// deno-lint-ignore no-explicit-any
type Obj = Record<string, any>;
const NOW = new Date("2026-09-24T01:00:00Z");
const CAPTAIN = "marnin@secureworkswa.com.au";
const captain = { mode: "jwt" as const, email: CAPTAIN, userId: "u1" };
const apiKey = { mode: "api_key" as const };
const CONTACT = "n9rqiejpF3Sp8OG8MyRN";

async function approval(
  step: "calendar" | "message",
  content: Obj,
  overrides: Partial<ExecutableApprovalRecord> = {},
): Promise<ExecutableApprovalRecord> {
  const snapshot: Obj = {
    schema: "scope-booking-approval.v1",
    step,
    case_id: "opp:michael",
    contact_id: CONTACT,
    resource: "marnin",
    scoper_user_id: "706c5258-70dd-483a-b36c-af6864b24498",
    week_start: "2026-09-21",
    id: "opp:michael",
    profile: "fencing-stratco-marnin",
    pack_revision: "a".repeat(64),
    content_hash: null,
    content,
  };
  snapshot.content_hash = await bookingContentHash(snapshot);
  return {
    binding_hash: await bookingHash(snapshot),
    step,
    state: "approved",
    snapshot,
    approved_by_email: CAPTAIN,
    approved_at: new Date(NOW.getTime() - 60_000).toISOString(),
    expires_at: new Date(NOW.getTime() + 14 * 60_000).toISOString(),
    ...overrides,
  };
}
const CALENDAR = {
  provider: "ghl",
  calendar_id: "stratco-cal",
  assigned_user_id: "marnin-ghl",
  start_iso: "2026-09-25T09:00:00+08:00",
  end_iso: "2026-09-25T10:30:00+08:00",
  window_start_iso: "2026-09-25T09:00:00+08:00",
  window_end_iso: "2026-09-25T09:30:00+08:00",
  title: "Scope: Michael",
  address: "1 Fictional Street, Perth",
};
const MESSAGE = {
  // A text that carries no time must be sendable.
  text: "Hi Michael, does Friday suit for the fence scope?",
  sender: "+61489267776",
  recipient: "+61400000002",
  variant: "template",
};

function fakes(records: ExecutableApprovalRecord[], env: Obj = {}) {
  const calls = {
    writer: [] as Obj[],
    sms: [] as Obj[],
    claims: 0,
  };
  const approvals = new Map(records.map((r) => [r.binding_hash, r]));
  const sends = new Map<string, SendLedgerRow>();
  const appointments = new Map<string, { state: string; result: Obj | null }>();
  let thread: SalesBookingMessage[] = [];
  let outlook: OutlookEvent[] = [];
  let writerFlagOn = true;
  let smsResponse: { status: number; body: Obj } = {
    status: 200,
    body: { success: true, messageId: "msg-1" },
  };
  const deps: SalesBookingExecuteDeps = {
    findApproval: (h) => Promise.resolve(approvals.get(h) ?? null),
    appointmentLedger: (k) => Promise.resolve(appointments.get(k) ?? null),
    readThread: () => Promise.resolve(thread),
    readOutlook: () =>
      Promise.resolve({ ok: true, mailbox: CAPTAIN, events: outlook }),
    readContactPhone: () => Promise.resolve("0400 000 002"),
    callAppointmentWriter(body) {
      calls.writer.push(body);
      const { idempotencyKey, dryRun, ...fields } = body;
      if (dryRun === true || !writerFlagOn) {
        return Promise.resolve({
          status: 200,
          body: {
            ok: false,
            code: dryRun ? "dry_run" : "flag_off",
            dryRun: true,
            approval: { state: "live", reason: null },
            wouldWrite: {
              method: "POST",
              path: "/calendars/events/appointments",
              body: { ...fields, toNotify: false },
            },
          },
        });
      }
      const result = {
        appointmentId: "appt-1",
        startTime: fields.startTime,
        endTime: fields.endTime,
      };
      appointments.set(idempotencyKey, { state: "complete", result });
      return Promise.resolve({
        status: 200,
        body: { ok: true, ...result, reused: false },
      });
    },
    callSendSms(body) {
      calls.sms.push(body);
      return Promise.resolve(smsResponse);
    },
    sends: {
      get: (h) => Promise.resolve(sends.get(h) ?? null),
      claim(row) {
        calls.claims++;
        if (sends.has(row.binding_hash)) return Promise.resolve(false);
        sends.set(row.binding_hash, {
          binding_hash: row.binding_hash,
          state: "sending",
          message_id: null,
        });
        return Promise.resolve(true);
      },
      settle(h, outcome) {
        const row = sends.get(h)!;
        if (row.state !== "sending") throw new Error("settles once");
        sends.set(h, {
          ...row,
          state: outcome.state,
          message_id: outcome.state === "sent" ? outcome.message_id : null,
        });
        return Promise.resolve();
      },
    },
    envGet: (name) => env[name],
    now: () => NOW,
  };
  return {
    deps,
    calls,
    sends,
    appointments,
    setThread: (m: SalesBookingMessage[]) => (thread = m),
    setOutlook: (e: OutlookEvent[]) => (outlook = e),
    writerFlag: (on: boolean) => (writerFlagOn = on),
    smsReturns: (r: { status: number; body: Obj }) => (smsResponse = r),
  };
}
const LIVE = {
  SALES_BOOKING_BOOK_EXECUTE: "true",
  SALES_BOOKING_SEND_EXECUTE: "true",
};
const book = (
  f: ReturnType<typeof fakes>,
  approvalId: string,
  auth: Obj = captain,
  extra: Obj = {},
) =>
  salesBookingBookAction({
    auth: auth as never,
    body: { approval_id: approvalId, ...extra },
    method: "POST",
    deps: f.deps,
  });
const send = (
  f: ReturnType<typeof fakes>,
  approvalId: string,
  auth: Obj = captain,
  extra: Obj = {},
) =>
  salesBookingSendAction({
    auth: auth as never,
    body: { approval_id: approvalId, ...extra },
    method: "POST",
    deps: f.deps,
  });
const reasonOf = (r: ExecuteResult) =>
  r.status === "refused" ? r.reason : r.status;

Deno.test("book and send each refuse, naming the failed check, and write or send nothing", async () => {
  const cal = await approval("calendar", CALENDAR);
  const msg = await approval("message", MESSAGE);
  // Distinct content per row so each has its own binding hash.
  const expired = await approval("calendar", { ...CALENDAR, title: "E" }, {
    approved_at: new Date(NOW.getTime() - 16 * 60_000).toISOString(),
    expires_at: new Date(NOW.getTime() - 60_000).toISOString(),
  });
  const notCaptain = await approval("message", { ...MESSAGE, text: "N" }, {
    approved_by_email: "khairo@secureworkswa.com.au",
  });
  const refusedDecision = await approval("calendar", {
    ...CALENDAR,
    title: "R",
  }, {
    state: "refused",
  });
  const tampered: ExecutableApprovalRecord = {
    ...msg,
    binding_hash: "c".repeat(64),
    snapshot: {
      ...(msg.snapshot as Obj),
      content: { ...MESSAGE, text: "Hi Michael, you owe us money." },
    },
  };
  const f = fakes(
    [cal, msg, expired, notCaptain, refusedDecision, tampered],
    LIVE,
  );
  const cases: Array<[Promise<ExecuteResult>, string]> = [
    [book(f, "d".repeat(64)), "approval_not_found"],
    [send(f, "d".repeat(64)), "approval_not_found"],
    [book(f, "not-a-hash"), "approval_id_required"],
    [book(f, expired.binding_hash), "approval_expired"],
    [send(f, notCaptain.binding_hash), "approval_not_by_captain"],
    [book(f, refusedDecision.binding_hash), "approval_not_approved"],
    [send(f, tampered.binding_hash), "content_hash_mismatch"],
    [book(f, msg.binding_hash), "approval_step_mismatch"],
    [send(f, cal.binding_hash), "approval_step_mismatch"],
    [
      book(f, cal.binding_hash, { mode: "jwt", email: "khairo@x.test" }),
      "press_requires_captain",
    ],
    [send(f, msg.binding_hash, { mode: "routine" }), "press_requires_captain"],
  ];
  for (const [result, reason] of cases) {
    assertEquals(reasonOf(await result), reason);
  }
  assertEquals(f.calls.writer.length, 0);
  assertEquals(f.calls.sms.length, 0);
  assertEquals(f.calls.claims, 0);
  const get = await salesBookingSendAction({
    auth: captain,
    body: { approval_id: msg.binding_hash },
    method: "GET",
    deps: f.deps,
  });
  assertEquals(reasonOf(get), "method_not_allowed");
});

Deno.test("book re-checks the thread tail and Outlook at the press, naming the clash", async () => {
  const cal = await approval("calendar", CALENDAR);
  const f = fakes([cal], LIVE);
  f.setThread([{
    id: "m9",
    direction: "inbound",
    type: "TYPE_SMS",
    body: "Actually Friday is no good",
    timestamp: new Date(NOW.getTime() - 10_000).toISOString(),
  }]);
  const replied = await book(f, cal.binding_hash);
  assertEquals(reasonOf(replied), "customer_replied_since_approval");
  f.setThread([{
    id: "m1",
    direction: "inbound",
    type: "TYPE_SMS",
    body: "Friday works",
    timestamp: new Date(NOW.getTime() - 3_600_000).toISOString(),
  }]);
  f.setOutlook([{
    id: "o1",
    subject: "Scope: Melanie Nouchy",
    start: "2026-09-25T02:00:00Z", // 10:00 Perth
    end: "2026-09-25T03:00:00Z",
    show_as: "busy",
    is_cancelled: false,
  }]);
  const clash = await book(f, cal.binding_hash);
  assertEquals(clash, {
    status: "refused",
    reason: "outlook_calendar_clash",
    detail: {
      mailbox: CAPTAIN,
      events: [{
        subject: "Scope: Melanie Nouchy",
        start: "2026-09-25T02:00:00Z",
        end: "2026-09-25T03:00:00Z",
      }],
    },
  });
  // Free, cancelled and adjacent events never block.
  f.setOutlook([
    {
      id: "a",
      subject: "Lunch",
      start: "2026-09-25T01:00:00Z",
      end: "2026-09-25T02:00:00Z",
      show_as: "free",
      is_cancelled: false,
    },
    {
      id: "b",
      subject: "Cancelled",
      start: "2026-09-25T01:00:00Z",
      end: "2026-09-25T02:00:00Z",
      show_as: "busy",
      is_cancelled: true,
    },
    {
      id: "c",
      subject: "Before",
      start: "2026-09-25T00:00:00Z",
      end: "2026-09-25T01:00:00Z",
      show_as: "busy",
      is_cancelled: false,
    },
  ]);
  assertEquals((await book(f, cal.binding_hash)).status, "booked");
  assertEquals(f.calls.writer.length, 1);
  const unreadable = fakes([cal], LIVE);
  unreadable.deps.readOutlook = () =>
    Promise.resolve({ ok: false, reason: "outlook_http_403" });
  assertEquals(
    reasonOf(await book(unreadable, cal.binding_hash)),
    "outlook_unreadable",
  );
  assertEquals(unreadable.calls.writer.length, 0);
});

Deno.test("dry run by default: every check runs, the writer previews, nothing is written or sent", async () => {
  const cal = await approval("calendar", CALENDAR);
  const msg = await approval("message", MESSAGE);
  for (
    const [env, auth, extra, reason] of [
      [{}, captain, {}, "book_switch_off"],
      [LIVE, apiKey, {}, "api_key_press_is_dry_run"],
      [LIVE, captain, { dry_run: true }, "dry_run_requested"],
    ] as Array<[Obj, Obj, Obj, string]>
  ) {
    const f = fakes([cal, msg], env);
    const booked = await book(f, cal.binding_hash, auth, extra);
    assertEquals(booked.status, "dry_run");
    if (booked.status !== "dry_run") continue;
    assertEquals(booked.reason, reason);
    assertEquals(booked.would_write?.body.startTime, CALENDAR.start_iso);
    assertEquals(booked.would_write?.outlook_checked.clashes, 0);
    assertEquals(f.calls.writer.map((w) => w.dryRun), [true]);
    assertEquals(f.appointments.size, 0);
    const sent = await send(f, msg.binding_hash, auth, extra);
    assertEquals(sent.status, "dry_run");
    if (sent.status !== "dry_run") continue;
    assertEquals(sent.would_send?.body, {
      contactId: CONTACT,
      message: MESSAGE.text,
      fromNumber: "+61489267776",
    });
    assertEquals(f.calls.sms.length, 0);
    assertEquals(f.calls.claims, 0);
    assertEquals(f.sends.size, 0);
  }
  // Switch on, but the writer's own GHL flag is off: still a preview.
  const f = fakes([cal], LIVE);
  f.writerFlag(false);
  const preview = await book(f, cal.binding_hash);
  assertEquals(
    preview.status === "dry_run" && preview.reason,
    "appointment_writer_flag_off",
  );
});

Deno.test("idempotent: a second press returns the first result and never books or sends twice", async () => {
  const cal = await approval("calendar", CALENDAR);
  const msg = await approval("message", MESSAGE);
  const f = fakes([cal, msg], LIVE);
  const first = await book(f, cal.binding_hash);
  assertEquals(first, {
    status: "booked",
    reason: null,
    appointment_id: "appt-1",
    replayed: false,
    start_time: CALENDAR.start_iso,
    end_time: CALENDAR.end_iso,
  });
  // Later press, after the approval expired and the booking now shows in the
  // diary: still the first result, no second writer call.
  f.deps.now = () => new Date(NOW.getTime() + 60 * 60_000);
  f.setOutlook([{
    id: "mirror",
    subject: "Scope: Michael",
    start: "2026-09-25T01:00:00Z",
    end: "2026-09-25T02:30:00Z",
    show_as: "busy",
    is_cancelled: false,
  }]);
  const second = await book(f, cal.binding_hash);
  assertEquals(second.status === "booked" && second.replayed, true);
  assertEquals(f.calls.writer.length, 1);

  f.deps.now = () => NOW;
  const sent = await send(f, msg.binding_hash);
  assertEquals(sent, {
    status: "sent",
    reason: null,
    message_id: "msg-1",
    replayed: false,
  });
  const again = await send(f, msg.binding_hash);
  assertEquals(again, {
    status: "sent",
    reason: null,
    message_id: "msg-1",
    replayed: true,
  });
  assertEquals(f.calls.sms.length, 1);
  assertEquals(f.calls.sms[0], {
    contactId: CONTACT,
    message: MESSAGE.text,
    fromNumber: "+61489267776",
  });

  // An unclear provider answer settles `unknown` and is never re-sent.
  const g = fakes([msg], LIVE);
  g.smsReturns({ status: 200, body: { success: false, error: "GHL 500" } });
  assertEquals(
    reasonOf(await send(g, msg.binding_hash)),
    "send_outcome_unknown",
  );
  assertEquals(
    reasonOf(await send(g, msg.binding_hash)),
    "execution_outcome_unknown",
  );
  assertEquals(g.calls.sms.length, 1);

  // Two concurrent presses: exactly one send.
  const h = fakes([msg], LIVE);
  const both = await Promise.all([
    send(h, msg.binding_hash),
    send(h, msg.binding_hash),
  ]);
  assertEquals(h.calls.sms.length, 1);
  assertEquals(both.filter((r) => r.status === "sent").length >= 1, true);
});

Deno.test("send re-checks the recipient, the sender line and the thread at the press", async () => {
  const msg = await approval("message", MESSAGE);
  const f = fakes([msg], LIVE);
  f.deps.readContactPhone = () => Promise.resolve("+61499999999");
  assertEquals(reasonOf(await send(f, msg.binding_hash)), "recipient_changed");
  const other = await approval("message", {
    ...MESSAGE,
    sender: "+61489267771",
  });
  const g = fakes([other], LIVE);
  assertEquals(
    reasonOf(await send(g, other.binding_hash)),
    "sender_not_line_776",
  );
  const h = fakes([msg], LIVE);
  h.setThread([{
    id: "sent-by-hand",
    direction: "outbound",
    type: "TYPE_SMS",
    body: MESSAGE.text,
    timestamp: NOW.toISOString(),
  }]);
  assertEquals(
    reasonOf(await send(h, msg.binding_hash)),
    "text_already_in_thread",
  );
  const i = fakes([msg], LIVE);
  i.deps.readThread = () => Promise.reject(new Error("GHL 500"));
  assertEquals(reasonOf(await send(i, msg.binding_hash)), "thread_unreadable");
  for (const x of [f, g, h, i]) assertEquals(x.calls.sms.length, 0);
});

Deno.test("a GHL diary clash from the writer is named, and nothing is booked", async () => {
  const cal = await approval("calendar", CALENDAR);
  const f = fakes([cal], LIVE);
  f.deps.callAppointmentWriter = () =>
    Promise.resolve({ status: 409, body: { ok: false, code: "overlap" } });
  assertEquals(reasonOf(await book(f, cal.binding_hash)), "ghl_calendar_clash");
  f.deps.callAppointmentWriter = () => Promise.reject(new Error("timeout"));
  assertEquals(
    reasonOf(await book(f, cal.binding_hash)),
    "appointment_writer_outcome_unknown",
  );
});
