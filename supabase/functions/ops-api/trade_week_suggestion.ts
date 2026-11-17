// P1-16.2. Read-only suggestions, never pay authority or stored clock edits.
type Row = Record<string, any>;
export type UsualDay = { length_hours: number; break_minutes: number };
const DEFAULT_DAY: UsualDay = { length_hours: 8, break_minutes: 30 };
const roundHours = (n: number) => Math.round(n * 100) / 100;
const day = (value: unknown) => String(value || "").slice(0, 10);
const perthDay = (now: string) =>
  new Date(Date.parse(now) + 8 * 3600000).toISOString().slice(0, 10);
const hhmm = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${
    String(minutes % 60).padStart(2, "0")
  }`;
function perthMinutes(value: unknown): number | null {
  const instant = Date.parse(String(value || ""));
  if (!Number.isFinite(instant)) return null;
  const local = new Date(instant + 8 * 3600000);
  return local.getUTCHours() * 60 + local.getUTCMinutes() +
    local.getUTCSeconds() / 60;
}

export function usualDay(rows: readonly Row[]): UsualDay {
  const samples = rows.filter((row) => row.clocked_on_at && row.clocked_off_at)
    .slice(0, 10).map((row) => {
      const breakMinutes = Math.max(0, Number(row.break_minutes) || 0);
      const length = row.hours_worked != null
        ? Number(row.hours_worked)
        : (Date.parse(row.clocked_off_at) - Date.parse(row.clocked_on_at)) /
            3600000 - breakMinutes / 60;
      return { length, breakMinutes };
    }).filter((row) =>
      Number.isFinite(row.length) && row.length > 0 && row.length <= 24
    );
  if (samples.length < 3) return { ...DEFAULT_DAY };
  const lengths = samples.map((row) => row.length).sort((a, b) => a - b);
  const middle = Math.floor(lengths.length / 2);
  const counts = new Map<number, number>();
  for (const sample of samples) {
    counts.set(sample.breakMinutes, (counts.get(sample.breakMinutes) || 0) + 1);
  }
  // Most recent wins a modal tie; input is newest booking first.
  const breaks = [...counts].sort((a, b) => b[1] - a[1]);
  return {
    length_hours: roundHours(
      lengths.length % 2
        ? lengths[middle]
        : (lengths[middle - 1] + lengths[middle]) / 2,
    ),
    break_minutes: breaks[0][0],
  };
}

export function suggestCardHours(
  card: Row,
  usual: UsualDay,
  todayPerth: string,
): Row {
  if (card.invoice_mode === "work_order") {
    return {
      source: "work_order",
      amount_ex: card.work_order_agreed_ex ?? null,
      complete: card.work_order_agreed_ex != null,
    };
  }
  const work_date = day(card.scheduled_date);
  const none = {
    source: "none",
    work_date,
    start_time: null,
    finish_time: null,
    break_minutes: null,
    hours: null,
    complete: false,
  };
  if (card.logged_time_entry) {
    return { ...card.logged_time_entry, source: "clock", complete: true };
  }
  const start = perthMinutes(card.clocked_on_at);
  const finish = perthMinutes(card.clocked_off_at);
  if (
    start != null && finish != null && card.hours_worked != null &&
    Number.isFinite(Number(card.hours_worked))
  ) {
    return {
      source: "clock",
      work_date,
      start_time: hhmm(Math.round(start / 5) * 5 % 1440),
      finish_time: hhmm(Math.round(finish / 5) * 5 % 1440),
      break_minutes: Number(card.break_minutes) || 0,
      hours: Number(card.hours_worked),
      complete: true,
    };
  }
  if (
    start != null && !card.clocked_off_at && work_date && work_date < todayPerth
  ) {
    const startMinutes = Math.floor(start);
    return {
      source: "clock_no_off",
      work_date,
      start_time: hhmm(startMinutes),
      finish_time: hhmm(
        Math.min(
          1435,
          Math.round(
            startMinutes + usual.length_hours * 60 + usual.break_minutes,
          ),
        ),
      ),
      break_minutes: usual.break_minutes,
      hours: usual.length_hours,
      complete: true,
    };
  }
  return none;
}

type SummaryOptions = {
  today: string;
  weekStart: string;
  now: string;
  rateResolved: boolean;
  payRunOn: boolean;
  streak: number;
  waitingOnCrew?: number;
  waitingOnOffice?: number;
};
export function weekSummary(cards: readonly Row[], opts: SummaryOptions) {
  const worked = cards.filter((card) => day(card.scheduled_date) <= opts.today);
  const hourly = worked.filter((card) => card.invoice_mode === "hourly");
  const needs = worked.filter((card) => !card.suggestion.complete);
  const payDay = new Date(`${opts.weekStart}T00:00:00Z`);
  // Sunday 23:59:59 Perth ends at Monday 00:00 Perth, UTC Sunday 16:00.
  const cutoff = Date.parse(`${opts.weekStart}T00:00:00+08:00`) + 7 * 86400000;
  payDay.setUTCDate(
    payDay.getUTCDate() + (Date.parse(opts.now) < cutoff ? 11 : 18),
  );
  return {
    fully_clocked: hourly.length > 0 &&
      hourly.every((card) => card.suggestion.source === "clock"),
    can_accept_in_one_press: worked.length > 0 && needs.length === 0 &&
      opts.rateResolved &&
      worked.every((card) =>
        ["hourly", "work_order"].includes(card.invoice_mode)
      ),
    lines_ready: worked.length - needs.length,
    lines_need_hours:
      needs.filter((card) => card.invoice_mode !== "work_order").length,
    waiting_on_crew: opts.waitingOnCrew || 0,
    waiting_on_office: (opts.waitingOnOffice || 0) +
      worked.filter((card) =>
        card.invoice_mode === "work_order" && !card.suggestion.complete
      ).length,
    pay_day: opts.payRunOn ? day(payDay.toISOString()) : null,
    show_clock_tip: hourly.some((card) => card.suggestion.source === "none"),
    streak_untouched_weeks: Math.min(52, opts.streak),
  };
}

// Only identity coordinates leave this bounded read, never another trade's hours.
// uq_group_work_order_time_entries starts with group_id; each URL holds at most 25 ids.
const GROUP_CONFIRMATION_LIMIT = 1000;
async function readGroupConfirmationCounts(
  client: any,
  groups: readonly Row[],
  userId: string,
  weekStart: string,
  weekEnding: string,
): Promise<{ waitingOnCrew: number; waitingOnOffice: number }> {
  const active = groups.filter((group) => group.status !== "void");
  const ids = [...new Set(active.map((group) => String(group.id || "")))];
  if (ids.includes("") || ids.length >= GROUP_CONFIRMATION_LIMIT) {
    throw new Error("group_confirmation_unreadable");
  }
  const confirmedByGroup = new Map<string, Set<string>>();
  let remaining = GROUP_CONFIRMATION_LIMIT;
  for (let offset = 0; offset < ids.length; offset += 25) {
    const { data, error } = await client.from("group_work_order_time_entries")
      .select("group_id, user_id").in(
        "group_id",
        ids.slice(offset, offset + 25),
      )
      .gte("work_date", weekStart).lte("work_date", weekEnding)
      .gt("hours", 0).limit(remaining);
    // A full page may be truncated. Never publish a partial crew confirmation.
    if (error || !Array.isArray(data) || data.length >= remaining) {
      throw new Error("group_confirmation_unreadable");
    }
    remaining -= data.length;
    for (const row of data) {
      const key = String(row.group_id);
      const confirmed = confirmedByGroup.get(key) || new Set<string>();
      confirmed.add(String(row.user_id));
      confirmedByGroup.set(key, confirmed);
    }
  }
  let waitingOnCrew = 0;
  let waitingOnOffice = 0;
  for (const group of active) {
    const participants = group.group_work_order_participants;
    if (!Array.isArray(participants)) {
      throw new Error("group_confirmation_unreadable");
    }
    if (["with_office", "disputed"].includes(group.claim_state)) {
      waitingOnOffice++;
    }
    const confirmed = confirmedByGroup.get(String(group.id)) ||
      new Set<string>();
    if (
      confirmed.has(userId) &&
      participants.some((row: Row) => !confirmed.has(String(row.user_id)))
    ) waitingOnCrew++;
  }
  return { waitingOnCrew, waitingOnOffice };
}

type ReadOptions = {
  enabled: boolean;
  userId: string;
  gstRegistered: boolean;
  groupAllJobs: boolean;
  payRunOn: boolean;
  groups: readonly Row[];
  now?: string;
};
export async function addWeekSuggestions(
  client: any,
  response: Row,
  opts: ReadOptions,
): Promise<Row> {
  if (!opts.enabled) return response;
  try {
    const [history, sentWeeks] = await Promise.all([
      // idx_job_assign_user bounds one person's bookings; only ten rows leave the database.
      client.from("job_assignments").select(
        "clocked_on_at, clocked_off_at, hours_worked, break_minutes",
      )
        .eq("user_id", opts.userId).not("clocked_on_at", "is", null).not(
          "clocked_off_at",
          "is",
          null,
        )
        .lte("scheduled_date", response.week_ending).order("scheduled_date", {
          ascending: false,
        }).order("id", { ascending: false }).limit(10),
      // idx_trade_inv_user (user_id, week_start), at most 52 sent weeks.
      client.from("trade_invoices").select("week_start, accepted_untouched")
        .eq("user_id", opts.userId).not("week_start", "is", null).not(
          "status",
          "in",
          "(draft,failed,ops-reject)",
        )
        .lte("week_start", response.week_start).order("week_start", {
          ascending: false,
        }).limit(52),
    ]);
    if (history.error || sentWeeks.error) {
      throw new Error("suggestion_history_unreadable");
    }
    const usual = usualDay(history.data || []);
    const now = opts.now || new Date().toISOString();
    const today = perthDay(now);
    const assignments = response.assignments.map((card: Row) => ({
      ...card,
      suggestion: suggestCardHours(card, usual, today),
    }));
    let streak = 0;
    for (const week of sentWeeks.data || []) {
      if (week.accepted_untouched !== true) break;
      streak++;
    }
    const { waitingOnCrew, waitingOnOffice } =
      await readGroupConfirmationCounts(
        client,
        opts.groups,
        opts.userId,
        response.week_start,
        response.week_ending,
      );
    return {
      ...response,
      assignments,
      week_summary: weekSummary(assignments, {
        today,
        weekStart: response.week_start,
        now,
        rateResolved: response.rate_resolved === true &&
          response.money_unavailable !== true,
        payRunOn: opts.payRunOn,
        streak,
        waitingOnCrew,
        waitingOnOffice,
      }),
      usual_break_minutes: usual.break_minutes,
      gst_on: opts.gstRegistered,
      gst_from_profile: true,
      trade_rate_editable: false,
      group_claim_all_jobs: opts.groupAllJobs,
    };
  } catch (error) {
    console.error(
      "[ops-api] my_hours: suggestions unavailable:",
      (error as Error).message,
    );
    // The existing hours view remains usable, including its manual entry path.
    return response;
  }
}
