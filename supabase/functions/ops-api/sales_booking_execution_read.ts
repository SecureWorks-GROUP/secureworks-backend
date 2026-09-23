/** Read-only: what the booking executor did after the owner pressed.
 *
 * `sales_booking_book` / `sales_booking_send` record every live press in
 * `sales_booking_executions` (sales_booking_execute.ts). This module joins those
 * rows, the approval snapshot each press executed, and (for a booking) the GHL
 * writer's own ledger row, onto the lead they belong to. No provider call, no
 * write. Contract: docs/sales-booking-executor.md "What the read shows".
 *
 * Dry runs and refusals decided before the claim (approval expired, customer
 * replied, Outlook clash, ...) are returned to the press only and leave no
 * row, so the read can never show them as booked or sent: the lead stays as it
 * was before the press.
 */
import type { BookingObject } from "./sales_booking_confirmation.ts";
import type {
  SalesBookingCase,
  SalesBookingReadResponse,
} from "./sales_booking_read.ts";

type Client = { from: (table: string) => BookingObject };

export const EXECUTION_READ_COLUMNS =
  "binding_hash,step,contact_id,state,message_id,appointment_id,claimed_by_email,claimed_at,finished_at";
const APPROVAL_COLUMNS =
  "binding_hash,step,resource,week_start,state,reason,snapshot,approved_by_email,approved_at,expires_at";
const WRITER_COLUMNS = "idempotency_key,state,result,start_time,end_time";
/** A press not settled within this long is over: the GHL writer refuses a
 * claim older than two minutes and both provider calls time out at 60s. */
export const EXECUTION_IN_PROGRESS_MS = 2 * 60_000;
const PAGE = 500;
const MAX_ROWS = 10_000;
const CHUNK = 50;

export type BookingExecutionState =
  | "in_progress"
  | "booked"
  | "sent"
  | "refused"
  | "failed";

export interface BookingExecutionView {
  binding_hash: string;
  step: "calendar" | "message";
  state: BookingExecutionState;
  /** Plain words for the screen. */
  words: string;
  contact_id: string;
  case_id: string | null;
  week_start: string | null;
  pressed_by: string;
  pressed_at: string;
  finished_at: string | null;
  /** The executor's raw row state, and the GHL writer's (calendar only). */
  executor_state: string;
  ghl_ledger_state: string | null;
  appointment_id: string | null;
  start: string | null;
  end: string | null;
  message_id: string | null;
  sent_at: string | null;
  text: string | null;
  sender: string | null;
  recipient: string | null;
}

export interface BookingExecutionRecords {
  executions: BookingObject[];
  approvals: BookingObject[];
  writer: BookingObject[];
}

/** A cap or failed page is never a complete empty read. Stable ordering is required. */
async function pages(query: () => BookingObject): Promise<BookingObject[]> {
  const rows: BookingObject[] = [];
  for (let offset = 0; offset <= MAX_ROWS; offset += PAGE) {
    const { data, error } = await query().range(offset, offset + PAGE - 1);
    if (error || !Array.isArray(data)) throw new Error("store_unreadable");
    rows.push(...data);
    if (rows.length > MAX_ROWS) throw new Error("read_limit_reached");
    if (data.length < PAGE) return rows;
  }
  throw new Error("read_limit_reached");
}

async function chunked(
  values: string[],
  read: (chunk: string[]) => Promise<BookingObject[]>,
): Promise<BookingObject[]> {
  const rows: BookingObject[] = [];
  for (let i = 0; i < values.length; i += CHUNK) {
    rows.push(...await read(values.slice(i, i + CHUNK)));
  }
  return rows;
}

/** Every press for these contacts, the approval each executed, and the GHL
 * writer's row for each booking key. Throws on any unreadable page. */
export async function readBookingExecutionRecords(
  client: Client,
  contactIds: string[],
): Promise<BookingExecutionRecords> {
  const contacts = [...new Set(contactIds.filter(Boolean))].sort();
  const executions = await chunked(
    contacts,
    (chunk) =>
      pages(() =>
        client.from("sales_booking_executions").select(EXECUTION_READ_COLUMNS)
          .in("contact_id", chunk).order("contact_id").order("binding_hash")
      ),
  );
  const hashes = [...new Set(executions.map((e) => String(e.binding_hash)))]
    .sort();
  const approvals = await chunked(
    hashes,
    (chunk) =>
      pages(() =>
        client.from("sales_booking_approvals").select(APPROVAL_COLUMNS)
          .in("binding_hash", chunk).order("binding_hash")
      ),
  );
  const keys = [
    ...new Set(
      executions.filter((e) => e.step === "calendar").map((e) =>
        String(e.binding_hash)
      ),
    ),
  ].sort();
  const writer = await chunked(
    keys,
    (chunk) =>
      pages(() =>
        client.from("ghl_calendar_appointment_requests").select(WRITER_COLUMNS)
          .in("idempotency_key", chunk).order("idempotency_key")
      ),
  );
  return { executions, approvals, writer };
}

const str = (v: unknown): string | null =>
  typeof v === "string" && v ? v : null;

/** Pure: one executor row -> what happened, in words. */
export function classifyBookingExecution(
  execution: BookingObject,
  approval: BookingObject | undefined,
  writerRows: BookingObject[],
  now: Date,
): BookingExecutionView {
  const snapshot = approval?.snapshot ?? {};
  const content = snapshot.content ?? {};
  const claimedAt = Date.parse(execution.claimed_at);
  const fresh = Number.isFinite(claimedAt) &&
    now.getTime() - claimedAt < EXECUTION_IN_PROGRESS_MS;
  const view: BookingExecutionView = {
    binding_hash: String(execution.binding_hash),
    step: execution.step,
    state: "failed",
    words: "",
    contact_id: String(execution.contact_id),
    case_id: str(snapshot.case_id),
    week_start: str(snapshot.week_start) ?? str(approval?.week_start),
    pressed_by: String(execution.claimed_by_email ?? ""),
    pressed_at: String(execution.claimed_at ?? ""),
    finished_at: str(execution.finished_at),
    executor_state: String(execution.state),
    ghl_ledger_state: null,
    appointment_id: null,
    start: null,
    end: null,
    message_id: null,
    sent_at: null,
    text: null,
    sender: null,
    recipient: null,
  };
  const set = (state: BookingExecutionState, words: string) => {
    view.state = state;
    view.words = words;
    return view;
  };
  if (execution.step === "message") {
    view.text = str(content.text);
    view.sender = str(content.sender);
    view.recipient = str(content.recipient);
    if (execution.state === "sent" && str(execution.message_id)) {
      view.message_id = execution.message_id;
      view.sent_at = view.finished_at;
      return set("sent", "Text sent.");
    }
    if (execution.state === "sending" && fresh) {
      return set("in_progress", "Text sending now.");
    }
    return set(
      "failed",
      execution.state === "unknown"
        ? "Text send failed: the provider answer was unclear, so the text may or may not have gone. It will not be sent again."
        : "Text send failed: the press never finished, so the text may or may not have gone. It will not be sent again.",
    );
  }
  view.start = str(content.start_iso);
  view.end = str(content.end_iso);
  const rows = writerRows.filter((r) =>
    r.idempotency_key === execution.binding_hash
  );
  const writer = rows.length === 1 ? rows[0] : null;
  view.ghl_ledger_state = writer ? String(writer.state) : null;
  const writerAppointment = writer?.state === "complete"
    ? str(writer.result?.appointmentId)
    : null;
  if (writerAppointment) {
    view.start = str(writer!.result?.startTime) ?? view.start;
    view.end = str(writer!.result?.endTime) ?? view.end;
  }
  if (rows.length > 1) {
    return set(
      "failed",
      "Booking could not be confirmed: more than one GHL writer record for this press.",
    );
  }
  if (execution.state === "booked" && str(execution.appointment_id)) {
    if (writerAppointment && writerAppointment !== execution.appointment_id) {
      return set(
        "failed",
        "Booking could not be confirmed: the executor and the GHL writer name different appointments.",
      );
    }
    view.appointment_id = execution.appointment_id;
    return set("booked", "Booked in GHL.");
  }
  if (writerAppointment) {
    // The executor's own settle did not land; the writer holds the booking.
    view.appointment_id = writerAppointment;
    return set("booked", "Booked in GHL.");
  }
  if (fresh) return set("in_progress", "Booking in progress.");
  if (writer?.state === "sending") {
    return set(
      "failed",
      "Booking failed: GHL did not answer clearly, so the booking may or may not be there. It is never posted twice; pressing again only checks GHL.",
    );
  }
  return set(
    "refused",
    "Booking refused: pressed, but the GHL calendar writer did not book. Nothing was written to GHL.",
  );
}

const CHANNEL_STATE: Record<BookingExecutionState, string> = {
  booked: "succeeded",
  sent: "succeeded",
  in_progress: "pending",
  failed: "unknown",
  refused: "failed",
};

function newestFirst(a: BookingExecutionView, b: BookingExecutionView) {
  return Date.parse(b.pressed_at) - Date.parse(a.pressed_at) ||
    a.binding_hash.localeCompare(b.binding_hash);
}

/** Pure: attach executor presses to their leads. Additive only. */
export function projectBookingExecutions(
  response: SalesBookingReadResponse,
  records: BookingExecutionRecords,
  now: Date,
): SalesBookingReadResponse {
  const result = structuredClone(response);
  const resource = result.resource.resource_id;
  const counts = new Map<string, number>();
  for (const row of result.cases) {
    if (row.contact_id) {
      counts.set(row.contact_id, (counts.get(row.contact_id) ?? 0) + 1);
    }
  }
  const byContact = new Map<string, BookingExecutionView[]>();
  let unattached = 0;
  for (const execution of records.executions) {
    const approval = records.approvals.find((a) =>
      a.binding_hash === execution.binding_hash
    );
    if (
      !approval || approval.step !== execution.step ||
      approval.snapshot?.contact_id !== execution.contact_id ||
      approval.snapshot?.resource !== resource
    ) {
      // Another resource's press, or one whose approval no longer matches.
      if (approval?.snapshot?.resource === resource || !approval) unattached++;
      continue;
    }
    if (counts.get(execution.contact_id) !== 1) {
      unattached++;
      continue;
    }
    const view = classifyBookingExecution(
      execution,
      approval,
      records.writer,
      now,
    );
    byContact.set(view.contact_id, [
      ...(byContact.get(view.contact_id) ?? []),
      view,
    ]);
  }
  result.booking_flow = {
    ...result.booking_flow,
    execution_read: {
      state: "complete",
      reason: null,
      as_of: now.toISOString(),
      presses: [...byContact.values()].reduce((n, v) => n + v.length, 0),
      unattached,
      unrecorded:
        "dry_runs_and_refusals_before_the_claim_are_returned_to_the_press_only",
    },
  };
  result.cases = result.cases.map((row) => {
    const views = row.contact_id && counts.get(row.contact_id) === 1
      ? [...(byContact.get(row.contact_id) ?? [])].sort(newestFirst)
      : [];
    const next: SalesBookingCase = { ...row, booking_executions: views };
    const model = next.booking_read_model;
    if (!model) return next;
    for (const step of ["calendar", "message"] as const) {
      const latest = views.find((v) => v.step === step);
      if (!latest) continue;
      const key = step === "calendar" ? "calendar_write" : "message";
      const channel = { ...(model[key] ?? {}) };
      // A newer live approval that has not been pressed keeps its own state.
      const liveBinding = channel.state === "approved" ||
          channel.state === "refused"
        ? channel.approval?.binding_hash
        : null;
      channel.execution = latest;
      if (liveBinding && liveBinding !== latest.binding_hash) {
        model[key] = channel;
        continue;
      }
      const approval = records.approvals.find((a) =>
        a.binding_hash === latest.binding_hash
      )!;
      channel.state = CHANNEL_STATE[latest.state];
      channel.reason = latest.state === "booked" || latest.state === "sent"
        ? null
        : latest.words;
      channel.approval = {
        ...approval,
        ui_snapshot: approval.snapshot,
      };
      if (step === "message") {
        channel.chosen = "template";
        channel.approved_text = latest.text;
      }
      if (latest.state === "booked") {
        channel.receipt = {
          source: "sales_booking_executions",
          booking_key: latest.binding_hash,
          idempotency_key: latest.binding_hash,
          appointment_id: latest.appointment_id,
          start: latest.start,
          end: latest.end,
        };
      } else if (latest.state === "sent") {
        channel.receipt = {
          source: "sales_booking_executions",
          message_id: latest.message_id,
          sent_at: latest.sent_at,
          text: latest.text,
        };
      }
      model[key] = channel;
    }
    next.booking_read_model = { ...model };
    return next;
  });
  return result;
}

/** Compose executor presses into the read. A failed read never claims "no
 * press": leads get `booking_executions: null` and channels stay unchanged. */
export async function applySalesBookingExecutions(
  client: Client,
  response: SalesBookingReadResponse,
  now = new Date(),
): Promise<SalesBookingReadResponse> {
  let records: BookingExecutionRecords;
  try {
    records = await readBookingExecutionRecords(
      client,
      response.cases.map((row) => row.contact_id ?? "").filter(Boolean),
    );
  } catch (error) {
    return {
      ...response,
      booking_flow: {
        ...response.booking_flow,
        execution_read: {
          state: "could_not_read",
          reason: `booking_executions_${(error as Error).message}`,
          as_of: now.toISOString(),
        },
      },
      cases: response.cases.map((row) => ({
        ...row,
        booking_executions: null,
      })),
    };
  }
  return projectBookingExecutions(response, records, now);
}
