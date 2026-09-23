// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  bookingContentHash,
  bookingHash,
  type ExecutableApprovalRecord,
} from "../_shared/booking_approval_gate.ts";
import {
  type ExecuteResult,
  type ExecutionLedgerRow,
  type OutlookEvent,
  outlookMirrorIdentity,
  salesBookingBookAction,
  type SalesBookingExecuteDeps,
  salesBookingSendAction,
} from "./sales_booking_execute.ts";
import type { SalesBookingMessage } from "./sales_booking_read.ts";
import {
  type OutlookMirrorGraphResponse,
  writeOutlookMirrorEvent,
} from "./sales_booking_outlook_mirror.ts";

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
  snapshotOverrides: Obj = {},
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
    ...snapshotOverrides,
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

/** The GHL contact the Outlook title is named from. Fictional. */
const GHL_CONTACT = {
  id: CONTACT,
  locationId: "loc-1",
  firstName: "Michael",
  lastName: "Example",
  city: "Scarborough",
  address1: "1 Fictional Street",
  phone: "+61400000002",
};

function fakes(records: ExecutableApprovalRecord[], env: Obj = {}) {
  const calls = {
    writer: [] as Obj[],
    sms: [] as Obj[],
    claims: 0,
    contactReads: 0,
    outlookGets: [] as string[],
    outlookPosts: [] as Obj[],
  };
  // A fake Outlook calendar behind the real mirror write (lookup + create).
  const outlookEvents = new Map<string, string>();
  let outlookPost: (() => OutlookMirrorGraphResponse) | null = null;
  const mirrorGraph = {
    env: (name: string) => env[name],
    graphGet(url: string) {
      calls.outlookGets.push(url);
      const filter = new URL(url).searchParams.get("$filter") ?? "";
      const ghlId = filter.match(/ep\/value eq '([^']+)'/)?.[1] ?? "";
      const id = outlookEvents.get(ghlId);
      return Promise.resolve({
        status: 200,
        body: { value: id ? [{ id }] : [] },
      });
    },
    graphPost(_url: string, body: unknown) {
      calls.outlookPosts.push(body as Obj);
      if (outlookPost) return Promise.resolve(outlookPost());
      const ghlId = (body as Obj).singleValueExtendedProperties[0].value;
      const id = `outlook-${outlookEvents.size + 1}`;
      outlookEvents.set(ghlId, id);
      return Promise.resolve({ status: 201, body: { id } });
    },
  };
  const approvals = new Map(records.map((r) => [r.binding_hash, r]));
  const executions = new Map<string, ExecutionLedgerRow>();
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
    readContact: () => {
      calls.contactReads++;
      return Promise.resolve({ ...GHL_CONTACT });
    },
    mirrorToOutlook: (input) => writeOutlookMirrorEvent(input, mirrorGraph),
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
    executions: {
      get: (h) => Promise.resolve(executions.get(h) ?? null),
      claim(row) {
        calls.claims++;
        const existing = executions.get(row.binding_hash);
        if (existing) {
          if (row.step === "calendar" && existing.state !== "booked") {
            executions.set(row.binding_hash, {
              ...existing,
              press_token: row.press_token,
              state: "claimed",
            });
            return Promise.resolve(true);
          }
          return Promise.resolve(false);
        }
        executions.set(row.binding_hash, {
          binding_hash: row.binding_hash,
          step: row.step,
          state: row.step === "calendar" ? "claimed" : "sending",
          press_token: row.press_token,
          message_id: null,
          appointment_id: null,
        });
        return Promise.resolve(true);
      },
      settle(h, outcome) {
        const row = executions.get(h)!;
        if (row.step === "message" && row.state !== "sending") {
          throw new Error("settles once");
        }
        if (row.step === "calendar" && row.state === "booked") {
          throw new Error("settles once");
        }
        executions.set(h, {
          ...row,
          state: outcome.state,
          message_id: outcome.state === "sent" ? outcome.message_id : null,
          appointment_id: outcome.state === "booked"
            ? outcome.appointment_id
            : null,
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
    executions,
    appointments,
    setThread: (m: SalesBookingMessage[]) => (thread = m),
    setOutlook: (e: OutlookEvent[]) => (outlook = e),
    writerFlag: (on: boolean) => (writerFlagOn = on),
    smsReturns: (r: { status: number; body: Obj }) => (smsResponse = r),
    outlookEvents,
    outlookPostReturns: (
      r: (() => OutlookMirrorGraphResponse) | null,
    ) => (outlookPost = r),
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
  assertEquals(typeof f.calls.writer[0].executorClaim, "string");
  assertEquals(f.calls.claims, 1);
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
    assertEquals(f.executions.size, 0);
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
  assertEquals(
    first.status === "booked" && first.outlook_mirror.outlook,
    "dry_run",
  );
  assertEquals({ ...first, outlook_mirror: null }, {
    status: "booked",
    reason: null,
    appointment_id: "appt-1",
    replayed: false,
    start_time: CALENDAR.start_iso,
    end_time: CALENDAR.end_iso,
    outlook_mirror: null,
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

// ── Outlook mirror after the GHL booking (Decision D2) ──

const MIRROR_ON = {
  ...LIVE,
  SALES_BOOKING_OUTLOOK_MIRROR_WRITE_ENABLED: "true",
};
const EXPECTED_OUTLOOK_BODY = (ghlId: string) => ({
  subject: "Scope: Michael Example, Scarborough",
  start: { dateTime: "2026-09-25T09:00:00", timeZone: "Australia/Perth" },
  end: { dateTime: "2026-09-25T09:30:00", timeZone: "Australia/Perth" },
  showAs: "busy",
  isAllDay: false,
  responseRequested: false,
  attendees: [],
  body: {
    contentType: "text",
    content:
      `Arrival window 09:00 to 09:30. Booked in GHL, appointment ${ghlId}.`,
  },
  transactionId: `sw-ghl-mirror-${ghlId}`,
  singleValueExtendedProperties: [{
    id:
      "String {6f1c2d4e-8a3b-4c5d-9e7f-5b0a1c2d3e4f} Name SecureWorksGhlAppointmentId",
    value: ghlId,
  }],
  location: { displayName: CALENDAR.address },
});

Deno.test("success: a live booking writes GHL once and its Outlook mirror once, keyed on the GHL appointment id", async () => {
  const cal = await approval("calendar", CALENDAR);
  const f = fakes([cal], MIRROR_ON);
  const result = await book(f, cal.binding_hash);
  assertEquals(result, {
    status: "booked",
    reason: null,
    appointment_id: "appt-1",
    replayed: false,
    start_time: CALENDAR.start_iso,
    end_time: CALENDAR.end_iso,
    outlook_mirror: {
      outlook: "written",
      reason: null,
      outlook_event_id: "outlook-1",
      message: "Outlook calendar written.",
    },
  });
  assertEquals(f.calls.writer.length, 1);
  assertEquals(f.calls.outlookPosts, [EXPECTED_OUTLOOK_BODY("appt-1")]);
  assertEquals(f.outlookEvents.get("appt-1"), "outlook-1");
});

Deno.test("dry run: names both the GHL and the Outlook would-writes and calls neither", async () => {
  const cal = await approval("calendar", CALENDAR);
  for (
    const [env, auth, extra, reason] of [
      [{}, captain, {}, "book_switch_off"],
      [MIRROR_ON, apiKey, {}, "api_key_press_is_dry_run"],
      [MIRROR_ON, captain, { dry_run: true }, "dry_run_requested"],
    ] as Array<[Obj, Obj, Obj, string]>
  ) {
    const f = fakes([cal], env);
    const result = await book(f, cal.binding_hash, auth, extra);
    assertEquals(result.status, "dry_run");
    if (result.status !== "dry_run") continue;
    assertEquals(result.would_write?.body.startTime, CALENDAR.start_iso);
    assertEquals(result.outlook_mirror?.outlook, "dry_run");
    if (result.outlook_mirror?.outlook !== "dry_run") continue;
    assertEquals(result.outlook_mirror.reason, reason);
    assertEquals(result.outlook_mirror.would_write, {
      method: "POST",
      path: "/users/marnin%40secureworkswa.com.au/calendar/events",
      body: EXPECTED_OUTLOOK_BODY("pending_ghl_appointment_id"),
    });
    assertEquals(f.calls.writer.map((w) => w.dryRun), [true]);
    assertEquals(f.calls.outlookGets.length, 0);
    assertEquals(f.calls.outlookPosts.length, 0);
    assertEquals(f.calls.claims, 0);
  }
});

Deno.test("Outlook failure after GHL success: the booking stands and the response says Outlook was not written and why", async () => {
  const cal = await approval("calendar", CALENDAR);
  const f = fakes([cal], MIRROR_ON);
  f.outlookPostReturns(() => ({ status: 403, body: { error: "denied" } }));
  const result = await book(f, cal.binding_hash);
  assertEquals(result.status, "booked");
  if (result.status !== "booked") return;
  assertEquals(result.appointment_id, "appt-1");
  assertEquals(result.outlook_mirror, {
    outlook: "failed",
    reason: "mirror_write_failed: outlook_create_http_403",
    message: "Booked in GHL, but the Outlook calendar was NOT written " +
      "(mirror_write_failed: outlook_create_http_403). Press again to retry " +
      "Outlook; GHL will not be booked a second time.",
  });
  assertEquals(f.calls.writer.length, 1);
  assertEquals(f.executions.get(cal.binding_hash)?.state, "booked");

  // A mirror that throws is still a booked result, never a refusal.
  const g = fakes([cal], MIRROR_ON);
  g.deps.mirrorToOutlook = () => Promise.reject(new Error("socket"));
  const thrown = await book(g, cal.binding_hash);
  assertEquals(
    thrown.status === "booked" && thrown.outlook_mirror.reason,
    "outlook_mirror_outcome_unknown",
  );
});

Deno.test("retry of the same press writes Outlook once and books GHL zero more times", async () => {
  const cal = await approval("calendar", CALENDAR);
  const f = fakes([cal], MIRROR_ON);
  f.outlookPostReturns(() => ({ status: 503, body: null }));
  const first = await book(f, cal.binding_hash);
  assertEquals(
    first.status === "booked" && first.outlook_mirror.outlook,
    "failed",
  );
  // Outlook recovers. The retry comes after the approval has expired.
  f.outlookPostReturns(null);
  f.deps.now = () => new Date(NOW.getTime() + 60 * 60_000);
  const retry = await book(f, cal.binding_hash);
  assertEquals(retry.status === "booked" && retry.replayed, true);
  assertEquals(
    retry.status === "booked" && retry.outlook_mirror,
    {
      outlook: "written",
      reason: null,
      outlook_event_id: "outlook-1",
      message: "Outlook calendar written.",
    },
  );
  const third = await book(f, cal.binding_hash);
  assertEquals(
    third.status === "booked" && third.outlook_mirror.reason,
    "already_mirrored",
  );
  assertEquals(f.calls.writer.length, 1); // GHL booked once, never again
  assertEquals(f.appointments.size, 1);
  // One failed POST, then exactly one successful create; the third press
  // found the event and posted nothing.
  assertEquals(f.calls.outlookPosts.length, 2);
  assertEquals(f.outlookEvents.size, 1);

  // Mirror switch off at the booking: Outlook named, not written; once the
  // switch is on, the same press writes it without a second GHL booking.
  const env: Obj = { ...LIVE };
  const g = fakes([cal], env);
  const off = await book(g, cal.binding_hash);
  assertEquals(
    off.status === "booked" && off.outlook_mirror.reason,
    "outlook_mirror_switch_off",
  );
  assertEquals(g.calls.outlookPosts.length, 0);
  env.SALES_BOOKING_OUTLOOK_MIRROR_WRITE_ENABLED = "true";
  const on = await book(g, cal.binding_hash);
  assertEquals(on.status === "booked" && on.outlook_mirror.outlook, "written");
  assertEquals(g.calls.writer.length, 1);
  assertEquals(g.calls.outlookPosts.length, 1);
});

Deno.test("an Outlook event that cannot be named refuses before GHL is booked; a GHL-only person books without one", async () => {
  // Street-only address and no city on the contact: no suburb to name.
  const cal = await approval("calendar", {
    ...CALENDAR,
    address: "1 Fictional Street",
  });
  const f = fakes([cal], MIRROR_ON);
  f.deps.readContact = () =>
    Promise.resolve({ ...GHL_CONTACT, city: "", address1: "" });
  assertEquals(await book(f, cal.binding_hash), {
    status: "refused",
    reason: "outlook_mirror_unbuildable",
    detail: { reason: "contact_suburb_not_given" },
  });
  f.deps.readContact = () => Promise.reject(new Error("GHL 500"));
  assertEquals(await book(f, cal.binding_hash), {
    status: "refused",
    reason: "outlook_mirror_unbuildable",
    detail: { reason: "contact_unreadable" },
  });
  assertEquals(f.calls.writer.length, 0);
  assertEquals(f.calls.claims, 0);

  const patio = await approval("calendar", CALENDAR, {}, {
    resource: "nithin",
  });
  const g = fakes([patio], MIRROR_ON);
  const result = await book(g, patio.binding_hash);
  assertEquals(
    result.status === "booked" && result.outlook_mirror,
    {
      outlook: "not_applicable",
      reason: "resource_has_no_outlook_calendar",
      message:
        "This person books in GHL only; there is no Outlook calendar to write.",
    },
  );
  assertEquals(g.calls.contactReads, 0);
  assertEquals(g.calls.outlookPosts.length, 0);
});

Deno.test("Outlook title names the suburb from the contact, else from the approved address, never guessed", () => {
  const michael = { firstName: "Michael", lastName: "Hore", city: "" };
  assertEquals(
    outlookMirrorIdentity(
      { ...michael, address1: "Bassendean" },
      "Scope visit: Michael Hore",
      "Bassendean",
    ),
    { ok: true, client_name: "Michael Hore", suburb: "Bassendean" },
  );
  assertEquals(
    outlookMirrorIdentity(
      michael,
      "Scope visit: Michael",
      "2 Wedge Way, Merriwa",
    )
      .ok && "parsed",
    "parsed",
  );
  for (const address of ["1 Fictional Street", "Smith Street", ""]) {
    assertEquals(outlookMirrorIdentity(michael, "Scope: Michael", address), {
      ok: false,
      reason: "contact_suburb_not_given",
    });
  }
  assertEquals(
    outlookMirrorIdentity({ city: "Scarborough" }, "Scope visit: Michael", "")
      .ok,
    true,
  );
  assertEquals(
    outlookMirrorIdentity({ firstName: "0400 000 000" }, "", "Perth"),
    { ok: false, reason: "client_name_not_given" },
  );
});
