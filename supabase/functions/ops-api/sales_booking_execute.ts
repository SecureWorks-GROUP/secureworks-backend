/** Booking executor: the owner's press on an approval is the trigger.
 *
 * `sales_booking_book` and `sales_booking_send` each take one
 * `sales_booking_approvals` binding hash, re-check everything on the server at
 * the moment of the press, and then either book the exact approved GHL
 * appointment through ghl-proxy `create_calendar_appointment` or send the exact
 * approved text through ghl-proxy `send_sms`. Dry run is the default: every
 * check runs, nothing is written or sent. Contract:
 * docs/sales-booking-executor.md.
 */
import {
  appointmentFromCalendarApproval,
  APPROVAL_ID_PATTERN,
  approvalGateRefusal,
  type ApprovedAppointment,
  bookingInstant,
  type ExecutableApprovalRecord,
} from "../_shared/booking_approval_gate.ts";
import {
  salesBookingCaptainEmailsFromEnv,
  type SalesBookingEnvGet,
  type SalesBookingPackAuth,
} from "./sales_booking_pack.ts";
import {
  messageCountsAsContact,
  messageDirection,
  messageTimestamp,
  type SalesBookingMessage,
} from "./sales_booking_read.ts";

// deno-lint-ignore no-explicit-any
type Obj = Record<string, any>;
export type ExecuteKind = "book" | "send";

/** Env switches. Only the exact value "true" executes; anything else is dry run. */
export const SALES_BOOKING_BOOK_EXECUTE_ENV = "SALES_BOOKING_BOOK_EXECUTE";
export const SALES_BOOKING_SEND_EXECUTE_ENV = "SALES_BOOKING_SEND_EXECUTE";
/** The Stratco booking line. Friday's texts all come from 776 (Group Ops). */
export const SALES_BOOKING_SEND_LINE = "+61489267776";

export type ExecuteResult =
  | {
    status: "refused";
    reason: string;
    detail?: Obj;
  }
  | {
    status: "dry_run";
    reason: string | null;
    would_write?: Obj;
    would_send?: Obj;
  }
  | {
    status: "booked";
    reason: null;
    appointment_id: string;
    replayed: boolean;
    start_time: string;
    end_time: string;
  }
  | {
    status: "sent";
    reason: null;
    message_id: string;
    replayed: boolean;
  };

export type OutlookEvent = {
  id: string;
  subject: string | null;
  start: string;
  end: string;
  show_as: string | null;
  is_cancelled: boolean;
};
export type OutlookRead =
  | { ok: true; mailbox: string; events: OutlookEvent[] }
  | { ok: false; reason: string };

export type ExecutionStep = "calendar" | "message";
export interface ExecutionLedgerRow {
  binding_hash: string;
  step: ExecutionStep;
  state: "claimed" | "booked" | "sending" | "sent" | "unknown";
  press_token: string;
  message_id: string | null;
  appointment_id: string | null;
}
export interface ExecutionLedger {
  get(bindingHash: string): Promise<ExecutionLedgerRow | null>;
  /** Insert a claim, or re-claim an unbooked calendar row. False when held. */
  claim(row: {
    binding_hash: string;
    step: ExecutionStep;
    contact_id: string;
    claimed_by_email: string;
    press_token: string;
  }): Promise<boolean>;
  settle(
    bindingHash: string,
    outcome:
      | { state: "booked"; appointment_id: string }
      | { state: "sent"; message_id: string }
      | { state: "unknown" },
  ): Promise<void>;
}

export interface SalesBookingExecuteDeps {
  findApproval(bindingHash: string): Promise<ExecutableApprovalRecord | null>;
  /** The writer's own ledger row for this key (ghl_calendar_appointment_requests). */
  appointmentLedger(key: string): Promise<
    { state: string; result: Obj | null } | null
  >;
  readThread(contactId: string): Promise<SalesBookingMessage[]>;
  /** Busy events on the resource's Outlook primary calendar in [start, end). */
  readOutlook(
    resource: string,
    startIso: string,
    endIso: string,
  ): Promise<OutlookRead>;
  readContactPhone(contactId: string): Promise<string | null>;
  /** POST ghl-proxy?action=create_calendar_appointment (server credential). */
  callAppointmentWriter(body: Obj): Promise<{ status: number; body: Obj }>;
  /** POST ghl-proxy?action=send_sms (server credential). */
  callSendSms(body: Obj): Promise<{ status: number; body: Obj }>;
  executions: ExecutionLedger;
  envGet?: SalesBookingEnvGet;
  now?: () => Date;
}

/** A transport failure means GHL may or may not have the booking. Retrying
 * the same approval is safe: the writer is keyed on the approval hash. */
async function writer(
  deps: SalesBookingExecuteDeps,
  body: Obj,
): Promise<{ status: number; body: Obj }> {
  try {
    return await deps.callAppointmentWriter(body);
  } catch {
    return { status: 502, body: { ok: false, code: "outcome_unknown" } };
  }
}

const refused = (reason: string, detail?: Obj): ExecuteResult => ({
  status: "refused",
  reason,
  ...(detail ? { detail } : {}),
});

/** Who pressed and whether that press may execute. */
function pressAuthority(
  auth: SalesBookingPackAuth,
  envGet: SalesBookingEnvGet | undefined,
): { ok: true; email: string; liveAllowed: boolean } | {
  ok: false;
  reason: string;
} {
  if (auth.mode === "api_key") {
    // Desk dry runs: every check, never a write or a send.
    return { ok: true, email: "ops-api:api_key", liveAllowed: false };
  }
  const email = String(auth.email || "").trim().toLowerCase();
  if (
    auth.mode === "jwt" && email &&
    salesBookingCaptainEmailsFromEnv(envGet).includes(email)
  ) return { ok: true, email, liveAllowed: true };
  return { ok: false, reason: "press_requires_captain" };
}

/** Any customer word after the owner approved means he approved stale context. */
export function customerRepliedAfter(
  messages: SalesBookingMessage[],
  approvedAtMs: number,
): SalesBookingMessage | null {
  return messages.find((m) => {
    const at = messageTimestamp(m);
    return messageDirection(m) === "inbound" && messageCountsAsContact(m) &&
      at !== null && at > approvedAtMs;
  }) ?? null;
}

/** Busy (not free, not cancelled) Outlook events overlapping [start, end). */
export function outlookClashes(
  events: OutlookEvent[],
  startIso: string,
  endIso: string,
): OutlookEvent[] {
  const start = bookingInstant(startIso), end = bookingInstant(endIso);
  return events.filter((e) => {
    if (e.is_cancelled || e.show_as === "free") return false;
    const s = bookingInstant(e.start), f = bookingInstant(e.end);
    // Unparseable times are conservative busy evidence.
    if (!Number.isFinite(s) || !Number.isFinite(f)) return true;
    return s < end && f > start;
  });
}

function sameNumber(a: string | null, b: string): boolean {
  if (!a) return false;
  const digits = (v: string) => {
    const d = v.replace(/[^\d+]/g, "");
    return d.startsWith("0") ? `+61${d.slice(1)}` : d;
  };
  return digits(a) === digits(b);
}

type Loaded = {
  record: ExecutableApprovalRecord;
  snapshot: Obj;
  press: { email: string; liveAllowed: boolean };
  now: Date;
  live: boolean;
  /** Why this press is a dry run; null when it executes. */
  dryReason: string | null;
};

/** Checks shared by both actions, in the order the refusal is reported. */
async function loadApproval(
  kind: ExecuteKind,
  args: {
    auth: SalesBookingPackAuth;
    body: Obj;
    method: string;
    deps: SalesBookingExecuteDeps;
  },
): Promise<
  { ok: true; loaded: Loaded } | { ok: false; result: ExecuteResult }
> {
  const { deps } = args;
  const fail = (reason: string) => ({
    ok: false as const,
    result: refused(reason),
  });
  if (args.method !== "POST") return fail("method_not_allowed");
  const press = pressAuthority(args.auth, deps.envGet);
  if (!press.ok) return fail(press.reason);
  const approvalId = args.body?.approval_id;
  if (typeof approvalId !== "string" || !APPROVAL_ID_PATTERN.test(approvalId)) {
    return fail("approval_id_required");
  }
  if (
    "dry_run" in (args.body ?? {}) && typeof args.body.dry_run !== "boolean"
  ) {
    return fail("invalid_dry_run");
  }
  let record: ExecutableApprovalRecord | null;
  try {
    record = await deps.findApproval(approvalId);
  } catch {
    return fail("approval_unreadable");
  }
  if (!record) return fail("approval_not_found");
  const step = kind === "book" ? "calendar" : "message";
  if (record.step !== step) return fail("approval_step_mismatch");
  const env = deps.envGet ?? ((n: string) => Deno.env.get(n));
  const switchOn = env(
    kind === "book"
      ? SALES_BOOKING_BOOK_EXECUTE_ENV
      : SALES_BOOKING_SEND_EXECUTE_ENV,
  ) === "true";
  const dryReason = !press.liveAllowed
    ? "api_key_press_is_dry_run"
    : args.body?.dry_run === true
    ? "dry_run_requested"
    : !switchOn
    ? `${kind}_switch_off`
    : null;
  return {
    ok: true,
    loaded: {
      record,
      snapshot: record.snapshot as Obj,
      press,
      now: (deps.now ?? (() => new Date()))(),
      live: dryReason === null,
      dryReason,
    },
  };
}

/** The approval gate, then the thread tail. Returns the tail when clear. */
async function gate(
  loaded: Loaded,
  step: "calendar" | "message",
  deps: SalesBookingExecuteDeps,
): Promise<{ refusal: ExecuteResult } | { messages: SalesBookingMessage[] }> {
  const refusal = await approvalGateRefusal(
    loaded.record,
    step,
    loaded.now,
    salesBookingCaptainEmailsFromEnv(deps.envGet),
  );
  if (refusal) return { refusal: refused(refusal) };
  let messages: SalesBookingMessage[];
  try {
    messages = await deps.readThread(loaded.snapshot.contact_id);
  } catch {
    return { refusal: refused("thread_unreadable") };
  }
  const reply = customerRepliedAfter(
    messages,
    bookingInstant(loaded.record.approved_at),
  );
  if (reply) {
    return {
      refusal: refused("customer_replied_since_approval", {
        message_id: reply.id ?? null,
        at: reply.timestamp ?? null,
      }),
    };
  }
  return { messages };
}

function bookedFrom(result: Obj, replayed: boolean): ExecuteResult {
  return {
    status: "booked",
    reason: null,
    appointment_id: String(result.appointmentId),
    replayed,
    start_time: String(result.startTime),
    end_time: String(result.endTime),
  };
}

/** Map the writer's refusal codes to named executor refusals. */
function writerRefusal(res: { status: number; body: Obj }): ExecuteResult {
  const code = String(res.body?.code ?? `http_${res.status}`);
  const reason = res.body?.reason ? String(res.body.reason) : null;
  if (code === "overlap") return refused("ghl_calendar_clash");
  if (code === "approval_required") return refused(reason ?? code);
  return refused(`appointment_writer_${code}`, reason ? { reason } : undefined);
}

export async function salesBookingBookAction(args: {
  auth: SalesBookingPackAuth;
  body: Obj;
  method: string;
  deps: SalesBookingExecuteDeps;
}): Promise<ExecuteResult> {
  const { deps } = args;
  const start = await loadApproval("book", args);
  if (!start.ok) return start.result;
  const { loaded } = start;
  const key = loaded.record.binding_hash;

  // Already ran? A second press returns the first result and books nothing.
  let prior: { state: string; result: Obj | null } | null;
  try {
    prior = await deps.appointmentLedger(key);
  } catch {
    return refused("execution_ledger_unreadable");
  }
  if (prior?.state === "complete" && prior.result?.appointmentId) {
    return bookedFrom(prior.result, true);
  }
  const appointment: ApprovedAppointment | null =
    appointmentFromCalendarApproval(loaded.snapshot);
  if (prior?.state === "sending") {
    // A post may already have reached GHL. Only the writer's own read-back
    // recovery may settle it; it never posts again.
    if (!loaded.live || !appointment) {
      return refused("execution_outcome_unknown");
    }
    const res = await writer(deps, {
      ...appointment,
      idempotencyKey: key,
    });
    if (res.body?.ok === true && res.body.appointmentId) {
      try {
        await deps.executions.settle(key, {
          state: "booked",
          appointment_id: String(res.body.appointmentId),
        });
      } catch {
        // Recovery already has the appointment; the claim row can stay claimed.
      }
      return bookedFrom(res.body, true);
    }
    return refused("execution_outcome_unknown");
  }

  const gated = await gate(loaded, "calendar", deps);
  if ("refusal" in gated) return gated.refusal;
  if (!appointment) return refused("content_hash_mismatch");

  const resource = loaded.snapshot.resource;
  let outlook: OutlookRead;
  try {
    outlook = await deps.readOutlook(
      resource,
      appointment.startTime,
      appointment.endTime,
    );
  } catch {
    outlook = { ok: false, reason: "outlook_read_failed" };
  }
  if (!outlook.ok) {
    return refused("outlook_unreadable", { reason: outlook.reason });
  }
  const clashes = outlookClashes(
    outlook.events,
    appointment.startTime,
    appointment.endTime,
  );
  if (clashes.length) {
    return refused("outlook_calendar_clash", {
      mailbox: outlook.mailbox,
      events: clashes.map((e) => ({
        subject: e.subject,
        start: e.start,
        end: e.end,
      })),
    });
  }

  // The writer re-reads the person's GHL diary and every assigned calendar,
  // and re-checks the approval itself, immediately before any POST.
  let executorClaim: string | undefined;
  if (loaded.live) {
    const pressToken = crypto.randomUUID();
    let claimed: boolean;
    try {
      claimed = await deps.executions.claim({
        binding_hash: key,
        step: "calendar",
        contact_id: String(loaded.snapshot.contact_id),
        claimed_by_email: loaded.press.email,
        press_token: pressToken,
      });
    } catch {
      return refused("execution_ledger_unwritable");
    }
    if (!claimed) {
      const winner = await deps.executions.get(key).catch(() => null);
      return winner?.state === "booked" && winner.appointment_id
        ? bookedFrom({
          appointmentId: winner.appointment_id,
          startTime: appointment.startTime,
          endTime: appointment.endTime,
        }, true)
        : refused("execution_outcome_unknown");
    }
    executorClaim = pressToken;
  }
  const res = await writer(deps, {
    ...appointment,
    idempotencyKey: key,
    ...(loaded.live ? {} : { dryRun: true }),
    ...(executorClaim ? { executorClaim } : {}),
  });
  if (res.body?.dryRun === true && res.body.wouldWrite) {
    return {
      status: "dry_run",
      reason: loaded.dryReason ?? "appointment_writer_flag_off",
      would_write: {
        ...res.body.wouldWrite,
        approval: res.body.approval ?? null,
        outlook_checked: { mailbox: outlook.mailbox, clashes: 0 },
      },
    };
  }
  if (res.body?.ok === true && res.body.appointmentId) {
    if (loaded.live) {
      try {
        await deps.executions.settle(key, {
          state: "booked",
          appointment_id: String(res.body.appointmentId),
        });
      } catch {
        // The GHL ledger still holds the appointment; a later press replays it.
      }
    }
    return bookedFrom(res.body, res.body.reused === true);
  }
  return writerRefusal(res);
}

export async function salesBookingSendAction(args: {
  auth: SalesBookingPackAuth;
  body: Obj;
  method: string;
  deps: SalesBookingExecuteDeps;
}): Promise<ExecuteResult> {
  const { deps } = args;
  const start = await loadApproval("send", args);
  if (!start.ok) return start.result;
  const { loaded } = start;
  const key = loaded.record.binding_hash;

  let prior: ExecutionLedgerRow | null;
  try {
    prior = await deps.executions.get(key);
  } catch {
    return refused("execution_ledger_unreadable");
  }
  if (prior?.state === "sent" && prior.message_id) {
    return {
      status: "sent",
      reason: null,
      message_id: prior.message_id,
      replayed: true,
    };
  }
  // A claim that never settled may already have reached the customer.
  if (prior) return refused("execution_outcome_unknown");

  const gated = await gate(loaded, "message", deps);
  if ("refusal" in gated) return gated.refusal;

  const content = loaded.snapshot.content ?? {};
  const text = content.text,
    sender = content.sender,
    recipient = content.recipient;
  const contactId = loaded.snapshot.contact_id;
  if (
    typeof text !== "string" || !text || typeof recipient !== "string" ||
    typeof contactId !== "string" || !contactId
  ) return refused("content_hash_mismatch");
  if (sender !== SALES_BOOKING_SEND_LINE) return refused("sender_not_line_776");

  // The approved recipient must still be the contact's number in GHL.
  let phone: string | null;
  try {
    phone = await deps.readContactPhone(contactId);
  } catch {
    return refused("recipient_unreadable");
  }
  if (!sameNumber(phone, recipient)) return refused("recipient_changed");

  // Someone may have sent this exact text by hand since the approval.
  const messages = gated.messages;
  const approvedAt = bookingInstant(loaded.record.approved_at);
  if (
    messages.some((m) =>
      messageDirection(m) === "outbound" && m.body === text &&
      (messageTimestamp(m) ?? -Infinity) >= approvedAt
    )
  ) return refused("text_already_in_thread");

  const wouldSend = {
    method: "POST",
    path: "ghl-proxy?action=send_sms",
    body: { contactId, message: text, fromNumber: sender },
    recipient,
  };
  if (!loaded.live) {
    return {
      status: "dry_run",
      reason: loaded.dryReason,
      would_send: wouldSend,
    };
  }

  // Claim before the provider call; a concurrent press loses here.
  let claimed: boolean;
  try {
    claimed = await deps.executions.claim({
      binding_hash: key,
      step: "message",
      contact_id: contactId,
      claimed_by_email: loaded.press.email,
      press_token: crypto.randomUUID(),
    });
  } catch {
    return refused("execution_ledger_unwritable");
  }
  if (!claimed) {
    const winner = await deps.executions.get(key).catch(() => null);
    return winner?.state === "sent" && winner.message_id
      ? {
        status: "sent",
        reason: null,
        message_id: winner.message_id,
        replayed: true,
      }
      : refused("execution_outcome_unknown");
  }
  let res: { status: number; body: Obj } | null = null;
  try {
    res = await deps.callSendSms(wouldSend.body);
  } catch {
    res = null;
  }
  const messageId = res?.body?.success === true && res.body.messageId
    ? String(res.body.messageId)
    : null;
  try {
    await deps.executions.settle(
      key,
      messageId
        ? { state: "sent", message_id: messageId }
        : { state: "unknown" },
    );
  } catch {
    // The claim stays `sending`: still a fence, never a second send.
  }
  if (messageId) {
    return {
      status: "sent",
      reason: null,
      message_id: messageId,
      replayed: false,
    };
  }
  // Never resend on an unclear provider answer; the claim is the fence.
  return refused("send_outcome_unknown", {
    provider_status: res?.status ?? null,
  });
}
