// P1-13.6. The edge derives suggestions. The database owns membership, the
// split and each transaction. Only the verified session supplies the actor.
import {
  GROUP_CLAIM_FLOW_FLAG,
  groupHoursFromBody,
  GroupWorkOrderError,
} from "./group_work_order.ts";
import { loggedTimeEntryForCard } from "./trade_invoice_time_entry.ts";
import { suggestCardHours, usualDay } from "./trade_week_suggestion.ts";

type Row = Record<string, any>;
type Mode = "replace" | "upsert" | "delete";
const failures: Record<string, [number, string]> = {
  group_claim_disabled: [409, "Group claims are switched off."],
  group_claim_not_member: [403, "You are not on this claim."],
  group_claim_invoiced: [409, "This claim has already been invoiced."],
  group_work_order_void: [409, "This group is closed."],
  group_split_frozen: [409, "The office needs to reopen this split."],
  group_split_changed: [409, "The hours changed. Check the split again."],
  group_clock_changed: [
    409,
    "The booking changed. Check your suggested hours again.",
  ],
  group_hours_required: [400, "Enter at least one day, or leave the claim."],
  group_reason_invalid: [400, "Give a reason between 3 and 500 characters."],
  group_pot_missing: [409, "The office needs to check the work order amount."],
};
function refuse(code: string): never {
  const [status, message] = failures[code] ||
    [503, "The claim could not be checked. Try again."];
  throw new GroupWorkOrderError(
    failures[code] ? code : "group_claim_unreadable",
    message,
    status,
  );
}
async function rpc(client: any, name: string, args: Row): Promise<Row> {
  let result;
  try {
    result = await client.rpc(name, args);
  } catch {
    refuse("group_claim_unreadable");
  }
  if (
    result?.error || !result?.data || typeof result.data !== "object" ||
    Array.isArray(result.data)
  ) {
    refuse(String(result?.error?.message));
  }
  return result.data;
}

// An unreadable switch must never choose the old, unfenced hours writer.
export async function readGroupClaimFlow(client: any): Promise<boolean> {
  let result;
  try {
    result = await client.from("feature_flags").select("enabled").eq(
      "flag_name",
      GROUP_CLAIM_FLOW_FLAG,
    ).maybeSingle();
  } catch {
    refuse("group_claim_unreadable");
  }
  if (
    !result || result.error ||
    (result.data !== null && typeof result.data?.enabled !== "boolean")
  ) refuse("group_claim_unreadable");
  return result.data?.enabled === true;
}

function suggestedDays(clock: Row, userId: string) {
  if (!Array.isArray(clock?.bookings) || !Array.isArray(clock?.history)) {
    refuse("group_claim_unreadable");
  }
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const usual = usualDay(clock.history);
  return (clock.bookings as Row[]).flatMap((b: Row) => {
    const suggested = suggestCardHours(
      {
        ...b,
        logged_time_entry: loggedTimeEntryForCard(
          b.logged,
          b.hours_worked,
          userId,
        ),
      },
      usual,
      today,
    );
    if (!suggested.complete) return [];
    return [{
      booking_id: b.id,
      work_date: suggested.work_date,
      start_time: suggested.start_time,
      finish_time: suggested.finish_time,
      break_minutes: suggested.break_minutes,
      hours: suggested.hours,
      source: suggested.source,
    }];
  });
}

export async function readGroupClaim(
  client: any,
  groupId: string,
  callerUserId: string,
) {
  const { clock, ...claim } = await rpc(client, "group_claim_read", {
    p_group_id: groupId,
    p_actor: callerUserId,
  });
  if (
    !Array.isArray(claim.my_days) || !Array.isArray(claim.crew) ||
    !claim.crew.some((p: Row) => p.user_id === callerUserId) ||
    claim.pot_total == null || claim.my_hours == null ||
    (claim.split_hash != null && claim.my_share == null)
  ) {
    refuse("group_claim_unreadable");
  }
  return {
    state: claim.state,
    split_hash: claim.split_hash,
    pot_total: claim.pot_total,
    deadline_at: claim.deadline_at,
    i_answered: claim.i_answered,
    my_days: claim.my_days,
    my_hours: claim.my_hours,
    my_share: claim.my_share,
    my_suggested_days: suggestedDays(clock, callerUserId),
    crew: claim.crew.map((
      { user_id, name, how, hours_confirmed, answered }: Row,
    ) => ({ user_id, name, how, hours_confirmed, answered })),
  };
}

function requestedGroup(body: Row) {
  if (typeof body.group_id !== "string" || !body.group_id.trim()) {
    throw new GroupWorkOrderError(
      "group_id_required",
      "Choose the group claim.",
      400,
    );
  }
  return body.group_id;
}

export async function confirmGroupWorkOrderHours(
  client: any,
  userId: string,
  body: Row,
  mode: Mode = "replace",
) {
  const args = { p_group_id: requestedGroup(body), p_actor: userId };
  const clock = await rpc(client, "group_claim_clock", args);
  const suggestions = suggestedDays(clock, userId);
  if (!Array.isArray(body.days) || !body.days.length) {
    refuse("group_hours_required");
  }
  const seenDates = new Set<string>();
  const seenBookings = new Set<string>();
  const days = body.days.map((day: Row) => {
    if (mode === "delete") return { work_date: day.work_date };
    // Compute the duration from clocks. Ignore client-supplied hours and audit fields.
    const entry = groupHoursFromBody({
      work_date: day?.work_date,
      start_time: day?.start_time,
      finish_time: day?.finish_time,
      break_minutes: day?.break_minutes,
      ...(mode === "upsert" ? { hours: day?.hours } : {}),
    });
    if (entry.break_minutes > 600 || seenDates.has(entry.work_date)) {
      throw new GroupWorkOrderError(
        "group_day_invalid",
        "Check the break and enter each day once.",
        400,
      );
    }
    seenDates.add(entry.work_date);
    const matches = day.booking_id != null
      ? suggestions.filter((s) => s.booking_id === day.booking_id)
      : suggestions.filter((s) =>
        s.work_date === entry.work_date &&
        !body.days.some((d: Row) => d?.booking_id === s.booking_id)
      );
    if (
      matches.length > 1 || (day.booking_id != null && matches.length !== 1)
    ) refuse("group_clock_changed");
    const suggested = matches[0];
    if (suggested && seenBookings.has(suggested.booking_id)) {
      refuse("group_clock_changed");
    }
    if (suggested) seenBookings.add(suggested.booking_id);
    return {
      ...entry,
      suggested: suggested ?? { source: "none" },
      changed_from_suggestion: suggested
        ? entry.work_date !== suggested.work_date ||
          Math.abs(
              Math.round(entry.hours * 100) - Math.round(suggested.hours * 100),
            ) > 1
        : null,
    };
  });
  const result = await rpc(client, "group_claim_hours", {
    ...args,
    p_mode: mode,
    p_days: days,
    p_clock: clock,
  });
  if (result.ok !== true) refuse("group_claim_unreadable");
  return { ok: true };
}

export async function decideGroupSplit(
  client: any,
  userId: string,
  body: Row,
  decision: "approve" | "dispute",
) {
  const result = await rpc(client, "group_claim_decide", {
    p_group_id: requestedGroup(body),
    p_actor: userId,
    p_hash: typeof body.split_hash === "string" ? body.split_hash : null,
    p_decision: decision,
    p_reason: decision === "dispute" && typeof body.reason === "string"
      ? body.reason
      : null,
  });
  if (typeof result.all_approved !== "boolean") {
    refuse("group_claim_unreadable");
  }
  return { all_approved: result.all_approved };
}
