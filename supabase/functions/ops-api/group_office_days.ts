// deno-lint-ignore-file no-explicit-any
// ════════════════════════════════════════════════════════════
// The office enters a missing crew member's days on a group work order (G4).
//
//   office_enter_group_hours    POST  office staff: a signed-in person, or the
//                                     ops agent's server key naming one
//   dispute_office_group_hours  POST  the crew member, their own days only
//
// One trade who never enters hours holds the whole crew's claim in
// waiting_hours. The office can enter that person's days for them, with a
// reason. The days carry who entered them, when and why, and the person sees
// that on their own share and can dispute it. An open dispute holds the group
// (no freeze, no invoiced claim) until the office enters the days again, or
// the person changes the day themselves, which makes it their own entry.
//
// Behind group_office_day_entry_v1, seeded off: off or missing is 409
// group_office_day_entry_disabled with no write, unreadable is 503 with no
// write. Every write and every rule is in the SQL functions
// group_office_enter_hours / group_office_dispute_hours (20261119091500): they
// re-check the switch, the person and the group under the job lock. Hours are
// worked out here from the start and finish times by the one time-entry rule;
// a bare number of hours is refused.
// ════════════════════════════════════════════════════════════

import { GroupWorkOrderError, groupHoursFromBody } from "./group_work_order.ts";

export const GROUP_OFFICE_DAY_ENTRY_FLAG = "group_office_day_entry_v1";
export const OFFICE_REASON_MIN = 3;
export const OFFICE_REASON_MAX = 500;
const MAX_DAYS = 31;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** SQL raise text -> what the caller is told. */
const RPC_FAULTS: Array<{ needle: string; code: string; status: number; message: string }> = [
  { needle: "group_office_day_entry_disabled", code: "group_office_day_entry_disabled", status: 409, message: "The office cannot enter crew days yet: it is switched off." },
  { needle: "group_reason_invalid", code: "group_reason_invalid", status: 400, message: "Give a reason of 3 to 500 characters." },
  { needle: "group_office_actor_not_staff", code: "group_office_actor_not_staff", status: 403, message: "Only office staff or a pay run approver can enter days for a crew member." },
  { needle: "group_office_target_invalid", code: "group_office_target_invalid", status: 400, message: "Choose the crew member whose days you are entering, not yourself." },
  { needle: "group_office_target_not_member", code: "group_office_target_not_member", status: 409, message: "That person is not on this group's crew." },
  { needle: "group_work_order_not_found", code: "group_work_order_not_found", status: 404, message: "That group was not found." },
  { needle: "group_work_order_void", code: "group_work_order_void", status: 409, message: "This group work order was cancelled." },
  { needle: "group_split_frozen", code: "group_split_frozen", status: 409, message: "The split is frozen. The office must unfreeze it before days change." },
  { needle: "group_claim_invoiced", code: "group_claim_invoiced", status: 409, message: "This claim has been invoiced. Its days cannot change." },
  { needle: "group_day_invalid", code: "group_day_invalid", status: 400, message: "Each day needs a date not after today, a start and finish time, and no day twice." },
  { needle: "group_hours_required", code: "group_hours_required", status: 400, message: "Enter 1 to 31 days." },
  { needle: "group_claim_not_member", code: "group_claim_not_member", status: 403, message: "You are not on this group's crew." },
  { needle: "group_office_entry_not_found", code: "group_office_entry_not_found", status: 409, message: "The office has not entered any of your days on this group." },
  { needle: "group_actor_required", code: "group_actor_required", status: 403, message: "Sign in as yourself to do this." },
];

function rpcFault(error: any, what: string): GroupWorkOrderError {
  const text = String(error?.message ?? error ?? "");
  const known = RPC_FAULTS.find((row) => text.includes(row.needle));
  if (known) return new GroupWorkOrderError(known.code, known.message, known.status);
  return new GroupWorkOrderError(
    "group_office_days_unreadable",
    `The office day entry could not be ${what}. Nothing was changed by this request.`,
    503,
  );
}

/** Reason rule, the same as the database's: 3 to 500 characters once trimmed. */
export function officeReason(raw: unknown): string {
  const reason = typeof raw === "string" ? raw.trim() : "";
  if (reason.length < OFFICE_REASON_MIN || reason.length > OFFICE_REASON_MAX) {
    throw new GroupWorkOrderError("group_reason_invalid", "Give a reason of 3 to 500 characters.", 400);
  }
  return reason;
}

/** The switch. Off or missing: refused. A failed read: refused as unreadable. */
export async function assertOfficeDayEntryOn(client: any): Promise<void> {
  const { data, error } = await client.from("feature_flags").select("enabled")
    .eq("flag_name", GROUP_OFFICE_DAY_ENTRY_FLAG).maybeSingle();
  if (error) {
    throw new GroupWorkOrderError(
      "group_office_day_entry_unreadable",
      "Could not read whether office day entry is on. Nothing was changed.",
      503,
    );
  }
  if (data?.enabled !== true) {
    throw new GroupWorkOrderError(
      "group_office_day_entry_disabled",
      "The office cannot enter crew days yet: it is switched off.",
      409,
    );
  }
}

/**
 * The days to write. `entries` is a list of dated days with start and finish
 * times; a single day may be sent at the top level instead. Hours are worked
 * out from the times. A bare number of hours with no times is refused: the
 * office does not invent anyone's start and finish.
 */
export function officeDaysFromBody(body: Record<string, unknown>, today?: string) {
  const raw = Array.isArray(body.entries) ? body.entries : [body];
  if (raw.length < 1 || raw.length > MAX_DAYS) {
    throw new GroupWorkOrderError("group_hours_required", "Enter 1 to 31 days.", 400);
  }
  const seen = new Set<string>();
  return raw.map((item) => {
    if (!item || typeof item !== "object") {
      throw new GroupWorkOrderError("group_day_invalid", "Each day needs a date and a start and finish time.", 400);
    }
    let entry;
    try {
      entry = groupHoursFromBody(item as Record<string, unknown>, today);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Each day needs a date and a start and finish time.";
      throw new GroupWorkOrderError("group_day_invalid", message, 400);
    }
    if (seen.has(entry.work_date)) {
      throw new GroupWorkOrderError("group_day_invalid", `${entry.work_date} is entered twice.`, 400);
    }
    seen.add(entry.work_date);
    return entry;
  });
}

export type OfficeActor = {
  userId: string | null;
  isStaff: boolean;
  // True only for the ops agent's server key presented with a server secret.
  // Such a caller is no person: it names the office person it acts for in
  // body.actor_user_id (owner, 21 Nov 2026: the office backfills days for the
  // crew, through an agent too). The database checks that person is office
  // staff or a pay run approver, exactly as it checks a signed-in one.
  serverKey?: boolean;
};

/** Marks a reason as entered by the office agent, so the crew member reads who really keyed it. */
export const OFFICE_AGENT_REASON_MARK = " (entered by the office agent)";

export async function officeEnterGroupHours(
  client: any,
  actor: OfficeActor,
  body: Record<string, unknown>,
  today?: string,
) {
  // The entry names a person. A signed-in person is that person. The ops
  // agent's server key is not one, so it must name the office person it acts
  // for; any other caller with no person is refused.
  let actorUserId = actor.userId && UUID_RE.test(actor.userId) ? actor.userId : null;
  const viaAgent = !actorUserId && actor.serverKey === true;
  if (viaAgent) {
    const named = String(body.actor_user_id ?? "").trim();
    if (!UUID_RE.test(named)) {
      throw new GroupWorkOrderError(
        "group_actor_required",
        "Name the office person these days are entered for (actor_user_id).",
        403,
      );
    }
    actorUserId = named;
  }
  if (!actorUserId) {
    throw new GroupWorkOrderError(
      "group_actor_required",
      "Sign in as yourself to enter days for a crew member.",
      403,
    );
  }
  const groupId = String(body.group_id ?? "").trim();
  const target = String(body.target_user_id ?? "").trim();
  if (!UUID_RE.test(groupId) || !UUID_RE.test(target)) {
    throw new GroupWorkOrderError("group_office_target_invalid", "Send group_id and target_user_id.", 400);
  }
  let reason = officeReason(body.reason);
  if (viaAgent) {
    // Kept inside the database's 500 character limit.
    reason = reason.slice(0, OFFICE_REASON_MAX - OFFICE_AGENT_REASON_MARK.length) + OFFICE_AGENT_REASON_MARK;
  }
  const days = officeDaysFromBody(body, today);
  await assertOfficeDayEntryOn(client);
  const { data, error } = await client.rpc("group_office_enter_hours", {
    p_group_id: groupId,
    p_actor: actorUserId,
    p_target: target,
    p_days: days,
    p_reason: reason,
  });
  if (error) throw rpcFault(error, "saved");
  return data;
}

export async function disputeOfficeGroupHours(
  client: any,
  userId: string,
  body: Record<string, unknown>,
) {
  const groupId = String(body.group_id ?? "").trim();
  if (!UUID_RE.test(groupId)) {
    throw new GroupWorkOrderError("group_work_order_not_found", "Send group_id.", 400);
  }
  const reason = officeReason(body.reason);
  await assertOfficeDayEntryOn(client);
  // Self only: the caller is the session's own person, never a body field.
  const { data, error } = await client.rpc("group_office_dispute_hours", {
    p_group_id: groupId,
    p_actor: userId,
    p_reason: reason,
  });
  if (error) throw rpcFault(error, "saved");
  return data;
}

/**
 * Adds the office-entry marks of the caller's OWN days to their my-share
 * answer. Never another person's. Nothing is added when the caller is not on
 * the group. A failed read says so (office_entry_unknown) rather than reading
 * as "the office entered nothing".
 */
export async function withOwnOfficeEntryMarks(
  client: any,
  userId: string,
  share: any,
): Promise<any> {
  if (!share || typeof share !== "object" || share.participant === false) return share;
  const groupId = String(share.group_id ?? "");
  if (!UUID_RE.test(groupId)) return share;
  const { data, error } = await client.from("group_work_order_time_entries")
    .select("work_date, entered_by_office, office_entered_at, office_entry_reason, disputed_at, dispute_reason, dispute_resolved_at")
    .eq("group_id", groupId).eq("user_id", userId).order("work_date");
  if (error || !Array.isArray(data)) return { ...share, office_entry_unknown: true };
  return { ...share, ...officeEntryMarks(data) };
}

/** The marks for one person's rows. Pure. */
export function officeEntryMarks(rows: Array<Record<string, any>>) {
  const office = rows.filter((row) => row.entered_by_office === true);
  if (office.length === 0) {
    return { office_entered: false, disputed: false };
  }
  const latest = [...office].sort((a, b) =>
    String(b.office_entered_at ?? "").localeCompare(String(a.office_entered_at ?? ""))
  )[0];
  const open = office.filter((row) => row.disputed_at != null && row.dispute_resolved_at == null);
  return {
    office_entered: true,
    office_entry_reason: latest.office_entry_reason ?? null,
    office_entered_at: latest.office_entered_at ?? null,
    office_entered_dates: office.map((row) => String(row.work_date)),
    disputed: open.length > 0,
    dispute_reason: open[0]?.dispute_reason ?? null,
  };
}
