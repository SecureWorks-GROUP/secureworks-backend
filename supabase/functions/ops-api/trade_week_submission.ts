// P1-16.3. Server-owned send evidence; client suggestions are never read.
import { suggestCardHours, usualDay } from "./trade_week_suggestion.ts";
import {
  loadLoggedTimesByCard,
  loggedTimeEntryForCard,
} from "./trade_invoice_time_entry.ts";
type Row = Record<string, any>;
export const OFFICE_RATE_NOTE = "Rate is set by the office";
export const todayPerth = () =>
  new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);

export async function readWeekSendEvidence(
  client: any,
  userId: string,
  weekStart: string | null,
  weekEnd: string | null,
) {
  if (!weekStart || !weekEnd) return null;
  try {
    const [bookings, history] = await Promise.all([
      // idx_job_assign_user: one person's week, no jobs blob or contact fields.
      client.from("job_assignments").select(
        "id,job_id,scheduled_date,status,is_ghost,invoiced_in,clocked_on_at,clocked_off_at,hours_worked,break_minutes",
      )
        .eq("user_id", userId).eq("is_ghost", false)
        .gte("scheduled_date", weekStart).lte("scheduled_date", weekEnd)
        .in("status", ["scheduled", "confirmed", "in_progress", "complete"])
        .limit(1000),
      // Same ten completed bookings the read-side usualDay uses.
      client.from("job_assignments").select(
        "clocked_on_at,clocked_off_at,hours_worked,break_minutes",
      )
        .eq("user_id", userId).not("clocked_on_at", "is", null).not(
          "clocked_off_at",
          "is",
          null,
        )
        .lte("scheduled_date", weekEnd).order("scheduled_date", {
          ascending: false,
        })
        .order("id", { ascending: false }).limit(10),
    ]);
    if (
      bookings.error || history.error || !Array.isArray(bookings.data) ||
      bookings.data.length >= 1000
    ) throw new Error("bookings unreadable");
    const logged = await loadLoggedTimesByCard(
      client,
      bookings.data.map((row: Row) => row.id),
    );
    if (logged.error) throw new Error(logged.error);
    const usual = usualDay(history.data || []);
    const cards = bookings.data.map((row: Row) => ({
      ...row,
      logged_time_entry: loggedTimeEntryForCard(
        logged.byCard.get(String(row.id)),
        row.hours_worked,
        userId,
      ),
    }));
    return { cards, usual };
  } catch (error) {
    console.error(
      "[ops-api] week send: suggestion unavailable:",
      String(error),
    );
    // Hours still send through today's validation. Unknown is never untouched.
    return null;
  }
}

export function officeRateForDay(
  rates: readonly Row[],
  workDay: string,
): number {
  const matches = rates.filter((row) =>
    row.effective_from <= workDay &&
    (!row.effective_to || row.effective_to >= workDay)
  );
  if (matches.length !== 1) return 0;
  const rate = Number(matches[0].hourly_rate);
  return Number.isFinite(rate) && rate > 0 ? rate : 0;
}

export function typedRateEvidence(typed: unknown, rate: number): Row {
  if (
    typed == null || typed === "" || !Number.isFinite(Number(typed)) ||
    Math.abs(Number(typed) - rate) <= 0.004
  ) return {};
  return {
    sent_values: { typed_rate: Number(typed) },
    office_review_note: OFFICE_RATE_NOTE,
  };
}

export function bookedLineEvidence(
  card: Row | undefined,
  evidence: Awaited<ReturnType<typeof readWeekSendEvidence>>,
  line: Row,
): Row {
  const suggested = card && evidence
    ? suggestCardHours(card, evidence.usual, todayPerth())
    : { source: "none", hours: null, complete: false };
  return {
    suggested,
    changed_from_suggestion: suggested.source === "none" || !suggested.complete
      ? null
      : (suggested.work_date != null &&
        suggested.work_date !== (line.work_date || line.line_date)) ||
        (suggested.hours != null &&
          Math.abs(Number(suggested.hours) - Number(line.total_hours)) > 0.01),
  };
}

export function weekAcceptance(
  evidence: Awaited<ReturnType<typeof readWeekSendEvidence>>,
  lines: readonly Row[],
  confirmMs: unknown,
): Row {
  const included = new Set(
    lines.flatMap((line) => line.assignment_ids || []).map(String),
  );
  const jobLevel = new Set(
    lines.filter((line) => line.suggested?.source === "work_order").map((
      line,
    ) => String(line.job_id)),
  );
  return {
    accepted_untouched: evidence != null && lines.length > 0 &&
      lines.every((line) => line.changed_from_suggestion === false) &&
      evidence.cards.every((card: Row) =>
        included.has(String(card.id)) || jobLevel.has(String(card.job_id))
      ),
    confirm_seconds:
      typeof confirmMs === "number" && Number.isFinite(confirmMs) &&
        confirmMs >= 0 && confirmMs <= 86400000
        ? Math.round(confirmMs / 1000)
        : null,
  };
}
