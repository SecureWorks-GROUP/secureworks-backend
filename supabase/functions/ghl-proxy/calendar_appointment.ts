import {
  fetchGhlCalendarEvents,
  fetchGhlCalendars,
  fetchGhlLocationUsers,
  type GhlCalendarGet,
} from "./calendar_events.ts";
import { scopeJsonHash } from "./hardening_helpers.ts";
import {
  appointmentFromCalendarApproval,
  appointmentMatchesApproval,
  APPROVAL_ID_PATTERN,
  approvalGateRefusal,
  type ExecutableApprovalRecord,
} from "../_shared/booking_approval_gate.ts";

type ObjectRow = Record<string, unknown>;
export type AppointmentInput = {
  calendarId: string;
  assignedUserId: string;
  contactId: string;
  startTime: string;
  endTime: string;
  title: string;
  address: string;
  idempotencyKey: string;
};
export type AppointmentResult = {
  appointmentId: string;
  calendarId: string;
  startTime: string;
  endTime: string;
};
export type AppointmentRequest = {
  fingerprint: string;
  state: "reserved" | "sending" | "complete";
  result: AppointmentResult | null;
};
export interface AppointmentLedger {
  get(locationId: string, key: string): Promise<AppointmentRequest | null>;
  reserve(args: {
    locationId: string;
    input: AppointmentInput;
    fingerprint: string;
    token: string;
  }): Promise<
    | { decision: "acquired" | "busy" | "overlap" | "conflict" }
    | { decision: "existing"; request: AppointmentRequest }
  >;
  markSending(locationId: string, key: string, token: string): Promise<boolean>;
  release(locationId: string, key: string, token: string): Promise<void>;
  complete(
    locationId: string,
    key: string,
    fingerprint: string,
    result: AppointmentResult,
  ): Promise<void>;
}
export type AppointmentDeps = {
  locationId: string;
  enabled: boolean;
  ghlGet: GhlCalendarGet;
  ghlPost: (path: string, body: ObjectRow) => Promise<ObjectRow>;
  ledger: AppointmentLedger;
  /**
   * Reads the `sales_booking_approvals` row whose binding hash equals the
   * request's idempotencyKey. A real write requires a live captain approval of
   * exactly this appointment; previews report the state and never refuse on it.
   */
  approvals: {
    find(bindingHash: string): Promise<ExecutableApprovalRecord | null>;
  };
  /**
   * The executor's per-press claim for this approval hash. A real write
   * requires a fresh unbooked calendar claim whose token matches
   * `executorClaim`; previews and replays never refuse on it.
   */
  executions: {
    find(bindingHash: string): Promise<ExecutorClaimRow | null>;
  };
  captainEmails: string[];
  now?: () => number;
};
export type ExecutorClaimRow = {
  step: string;
  state: string;
  press_token: string;
  claimed_at: string;
};
export const EXECUTOR_CLAIM_MAX_AGE_MS = 2 * 60_000;
const EXECUTOR_CLAIM_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Refusal =
  | "flag_off"
  | "overlap"
  | "read_failed"
  | "contact_not_found"
  | "invalid_window"
  | "provider_error"
  | "invalid_request"
  | "approval_required"
  | "method_not_allowed";
type ActionResult = { status: number; body: ObjectRow };
function refuse(code: Refusal, status: number, reason?: string): ActionResult {
  return { status, body: { ok: false, code, ...(reason ? { reason } : {}) } };
}
function object(value: unknown): value is ObjectRow {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function id(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);
}
function instant(value: unknown): number | null {
  if (typeof value !== "string") return null;
  // Require an explicit offset, actual date, and time; Date.parse alone rolls
  // impossible dates (e.g. February 30) into the following month.
  const match =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/
      .exec(value);
  if (
    !match || Number(match[2]) > 23 || Number(match[3]) > 59 ||
    Number(match[4]) > 59
  ) return null;
  const day = Date.parse(`${match[1]}T00:00:00Z`);
  if (
    !Number.isFinite(day) ||
    new Date(day).toISOString().slice(0, 10) !== match[1]
  ) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}
/** `dryRun: true` and `executorClaim` are the only optional fields. */
function parseRequest(
  body: unknown,
):
  | { input: AppointmentInput; dryRun: boolean; executorClaim: string | null }
  | null {
  if (!object(body)) return null;
  if ("dryRun" in body && body.dryRun !== true) return null;
  if (
    "executorClaim" in body &&
    (typeof body.executorClaim !== "string" ||
      !EXECUTOR_CLAIM_PATTERN.test(body.executorClaim))
  ) return null;
  const { dryRun, executorClaim, ...rest } = body;
  const input = parse(rest);
  return input
    ? {
      input,
      dryRun: dryRun === true,
      executorClaim: typeof executorClaim === "string" ? executorClaim : null,
    }
    : null;
}

function parse(raw: unknown): AppointmentInput | null {
  if (!object(raw)) return null;
  const keys = [
    "calendarId",
    "assignedUserId",
    "contactId",
    "startTime",
    "endTime",
    "title",
    "address",
    "idempotencyKey",
  ];
  if (Object.keys(raw).some((key) => !keys.includes(key))) return null;
  if (![raw.calendarId, raw.assignedUserId, raw.contactId].every(id)) {
    return null;
  }
  for (const key of ["title", "address", "idempotencyKey"]) {
    if (
      typeof raw[key] !== "string" || !raw[key].trim() ||
      raw[key] !== raw[key].trim() || [...raw[key]].some((char) =>
        char.charCodeAt(0) < 32
      )
    ) return null;
  }
  if (
    (raw.title as string).length > 200 ||
    (raw.address as string).length > 1000 ||
    (raw.idempotencyKey as string).length > 200
  ) return null;
  return raw as AppointmentInput;
}
function success(result: AppointmentResult, reused: boolean): ActionResult {
  return { status: 200, body: { ok: true, ...result, reused } };
}

/** Strict wrapper is local to the write: preserve the legacy read API contract. */
async function windowEvents(
  deps: AppointmentDeps,
  input: AppointmentInput,
  calendarId?: string,
) {
  const scan = await fetchGhlCalendarEvents({
    locationId: deps.locationId,
    startMs: instant(input.startTime)!,
    endMs: instant(input.endTime)!,
    ...(calendarId ? { calendarId } : { userId: input.assignedUserId }),
    ghlGet: async (path) => {
      const body = await deps.ghlGet(path);
      if (
        !object(body) || !Array.isArray(body.events) ||
        !body.events.every(object)
      ) throw new Error("malformed");
      // The documented window API is unpaged. Any explicit incomplete receipt
      // is uncertainty, never permission to create.
      if (
        body.nextPage || body.nextPageUrl || body.hasMore ||
        body.complete === false || body.error
      ) throw new Error("incomplete");
      return body;
    },
  });
  if (scan.failure) throw new Error("read_failed");
  return scan.events;
}

function overlaps(event: ObjectRow, input: AppointmentInput): boolean {
  if (event.assignedUserId != null && !id(event.assignedUserId)) {
    throw new Error("malformed_assignee");
  }
  if (event.assignedUserId && event.assignedUserId !== input.assignedUserId) {
    return false;
  }
  if (["cancelled", "invalid"].includes(String(event.appointmentStatus))) {
    return false;
  }
  const start = instant(event.startTime), end = instant(event.endTime);
  if (start === null || end === null || end <= start) {
    throw new Error("malformed_event");
  }
  return start < instant(input.endTime)! && end > instant(input.startTime)!;
}

function matchingAppointment(
  event: ObjectRow,
  payload: ObjectRow,
): AppointmentResult | null {
  if (
    !id(event.id) || event.title !== payload.title ||
    event.calendarId !== payload.calendarId ||
    event.contactId !== payload.contactId ||
    event.assignedUserId !== payload.assignedUserId ||
    instant(event.startTime) !== instant(payload.startTime) ||
    instant(event.endTime) !== instant(payload.endTime)
  ) return null;
  return {
    appointmentId: event.id,
    calendarId: event.calendarId as string,
    startTime: event.startTime as string,
    endTime: event.endTime as string,
  };
}

async function recover(
  deps: AppointmentDeps,
  input: AppointmentInput,
  payload: ObjectRow,
  fingerprint: string,
): Promise<ActionResult> {
  let events: ObjectRow[];
  try {
    events = await windowEvents(deps, input, input.calendarId);
  } catch {
    return refuse("read_failed", 502);
  }
  const matches = events.map((event) => matchingAppointment(event, payload))
    .filter((result) => result !== null);
  const unique = new Map(
    matches.map((result) => [result.appointmentId, result]),
  );
  // Absence is not proof that the previous POST failed: GHL may still commit it.
  if (unique.size !== 1) {
    return refuse("provider_error", 503, "outcome_unknown");
  }
  const result = [...unique.values()][0];
  await deps.ledger.complete(
    deps.locationId,
    input.idempotencyKey,
    fingerprint,
    result,
  );
  return success(result, true);
}

/** One POST surface. Provider text never crosses this boundary. */
export async function createCalendarAppointmentAction(args: {
  method: string;
  body: unknown;
  deps: AppointmentDeps;
}): Promise<ActionResult> {
  if (args.method !== "POST") return refuse("method_not_allowed", 405);
  const request = parseRequest(args.body);
  if (!request || !id(args.deps.locationId)) {
    return refuse("invalid_request", 400);
  }
  const { input } = request;
  const start = instant(input.startTime), end = instant(input.endTime);
  if (start === null || end === null || end <= start) {
    return refuse("invalid_window", 400);
  }
  const { deps } = args;
  const enabled = deps.enabled && !request.dryRun;
  const nowMs = () => deps.now?.() ?? Date.now();
  // Null means a live captain approval of exactly this appointment, keyed by
  // the approval binding hash the executor passes as idempotencyKey.
  const approvalRefusal = async (): Promise<string | null> => {
    if (!APPROVAL_ID_PATTERN.test(input.idempotencyKey)) {
      return "approval_not_found";
    }
    let record: ExecutableApprovalRecord | null;
    try {
      record = await deps.approvals.find(input.idempotencyKey);
    } catch {
      return "approval_unreadable";
    }
    if (!record) return "approval_not_found";
    const refusal = await approvalGateRefusal(
      record,
      "calendar",
      new Date(nowMs()),
      deps.captainEmails,
    );
    if (refusal) return refusal;
    const approved = appointmentFromCalendarApproval(record.snapshot);
    return approved && appointmentMatchesApproval(input, approved)
      ? null
      : "content_hash_mismatch";
  };
  const claimRefusal = async (): Promise<string | null> => {
    const token = request.executorClaim;
    if (!token) return "executor_claim_missing";
    let row: ExecutorClaimRow | null;
    try {
      row = await deps.executions.find(input.idempotencyKey);
    } catch {
      return "executor_claim_unreadable";
    }
    if (!row || row.step !== "calendar" || row.state !== "claimed") {
      return "executor_claim_missing";
    }
    if (row.press_token !== token) return "executor_claim_mismatch";
    const claimedAt = Date.parse(row.claimed_at);
    if (
      !Number.isFinite(claimedAt) ||
      nowMs() - claimedAt > EXECUTOR_CLAIM_MAX_AGE_MS
    ) return "executor_claim_expired";
    return null;
  };
  const fingerprint = await scopeJsonHash({
    locationId: deps.locationId,
    ...input,
  });
  // Title is round-tripped by the documented event read. A deterministic marker
  // lets a retry recover a lost POST response without trusting fuzzy identity.
  const marker = await scopeJsonHash({
    locationId: deps.locationId,
    key: input.idempotencyKey,
  });
  const { idempotencyKey: _key, ...fields } = input;
  const payload = {
    ...fields,
    locationId: deps.locationId,
    title: `${input.title} [SW booking:${marker}]`,
    appointmentStatus: "confirmed",
    toNotify: false,
    ignoreDateRange: false,
    ignoreFreeSlotValidation: false,
  };
  try {
    if (enabled) {
      const previous = await deps.ledger.get(
        deps.locationId,
        input.idempotencyKey,
      );
      if (
        previous?.fingerprint !== undefined &&
        previous.fingerprint !== fingerprint
      ) return refuse("invalid_request", 409, "idempotency_key_reused");
      if (previous?.state === "complete" && previous.result) {
        return success(previous.result, true);
      }
      if (previous?.state === "sending") {
        return await recover(deps, input, payload, fingerprint);
      }
    }
    if (start <= nowMs()) {
      return refuse("invalid_window", 400);
    }
    let contact: ObjectRow;
    try {
      contact = await deps.ghlGet(`/contacts/${input.contactId}`);
    } catch (error) {
      // Only an explicit provider 404 means nonexistent. All other failures
      // (including auth/rate limit/transport) remain unread.
      if (
        (error as { status?: number })?.status === 404 ||
        /^GHL 404:/.test(String((error as Error)?.message))
      ) return refuse("contact_not_found", 404);
      return refuse("read_failed", 502);
    }
    if (!object(contact) || !object(contact.contact)) {
      return refuse("read_failed", 502);
    }
    if (
      contact.contact.id !== input.contactId ||
      contact.contact.locationId !== deps.locationId
    ) return refuse("contact_not_found", 404);
    const calendars = await fetchGhlCalendars(deps);
    const users = await fetchGhlLocationUsers(deps);
    if (
      !calendars.receipt.ok || users.failure ||
      calendars.calendars.some((row) => !row.assignments_returned)
    ) return refuse("read_failed", 502);
    const calendar = calendars.calendars.find((row) =>
      row.id === input.calendarId
    );
    if (
      !calendar?.is_active ||
      !calendar.assigned_user_ids.includes(input.assignedUserId) ||
      !users.users.some((row) => row.id === input.assignedUserId)
    ) return refuse("invalid_request", 400, "calendar_user_not_available");
    const assigned = calendars.calendars.filter((row) =>
      row.assigned_user_ids.includes(input.assignedUserId)
    );
    const checkWindow = async (): Promise<ActionResult | null> => {
      try {
        // Read user diary PLUS each assigned calendar, covering separate calendars
        // and events without a returned assignee. Every constituent must succeed.
        const batches = [await windowEvents(deps, input)];
        for (const row of assigned) {
          batches.push(await windowEvents(deps, input, row.id));
        }
        if (batches.flat().some((event) => overlaps(event, input))) {
          return refuse("overlap", 409);
        }
        return null;
      } catch {
        return refuse("read_failed", 502);
      }
    };
    if (!enabled) {
      const refusal = await checkWindow();
      if (refusal) return refusal;
      const approval = await approvalRefusal();
      return {
        status: 200,
        body: {
          ok: false,
          // flag_off: the server switch is off. dry_run: the caller asked.
          code: deps.enabled ? "dry_run" : "flag_off",
          dryRun: true,
          // Informational in a preview; a real write refuses without it.
          approval: approval
            ? { state: "missing", reason: approval }
            : { state: "live", reason: null },
          wouldWrite: {
            method: "POST",
            path: "/calendars/events/appointments",
            version: "2023-02-21",
            body: payload,
          },
        },
      };
    }
    // Replays and recoveries never post. Everything from the reservation on
    // can, so no caller books without the captain's live approval of these
    // exact fields and the executor's per-press claim
    // (docs/sales-booking-executor.md).
    const approval = await approvalRefusal();
    if (approval) return refuse("approval_required", 409, approval);
    const claim = await claimRefusal();
    if (claim) return refuse("approval_required", 409, claim);
    const token = crypto.randomUUID();
    const reservation = await deps.ledger.reserve({
      locationId: deps.locationId,
      input,
      fingerprint,
      token,
    });
    if (reservation.decision === "conflict") {
      return refuse("invalid_request", 409, "idempotency_key_reused");
    }
    if (reservation.decision === "overlap") return refuse("overlap", 409);
    if (reservation.decision === "busy") {
      return refuse("provider_error", 503, "request_in_progress");
    }
    if (reservation.decision === "existing") {
      if (
        reservation.request.state === "complete" && reservation.request.result
      ) return success(reservation.request.result, true);
      return await recover(deps, input, payload, fingerprint);
    }
    const refusal = await checkWindow();
    if (refusal || start <= nowMs()) {
      await deps.ledger.release(deps.locationId, input.idempotencyKey, token);
      return refusal ?? refuse("invalid_window", 400);
    }
    // CAS must commit before the POST. A sending row is never automatically
    // released, even after a timeout/crash: it is an indefinite uncertainty fence.
    if (
      !await deps.ledger.markSending(
        deps.locationId,
        input.idempotencyKey,
        token,
      )
    ) return refuse("provider_error", 503, "reservation_lost");
    const response = await deps.ghlPost(
      "/calendars/events/appointments",
      payload,
    );
    const result = matchingAppointment(response, payload);
    if (!result) return refuse("provider_error", 502, "outcome_unknown");
    await deps.ledger.complete(
      deps.locationId,
      input.idempotencyKey,
      fingerprint,
      result,
    );
    return success(result, false);
  } catch {
    return refuse("provider_error", 502);
  }
}
