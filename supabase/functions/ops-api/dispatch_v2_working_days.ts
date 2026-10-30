// Dispatch v2: WA working days and the earliest install day (piece C).
//
// Pure: no database, no clock. Every day is a Perth calendar day as
// "YYYY-MM-DD", the same shape the Dispatch board uses everywhere.
//
// A working day is Monday to Friday and not a WA public holiday. The
// earliest install is the next working day after the last open order's
// confirmed date (or after today, when every date is already behind us), so
// the crew never turns up on a day the materials might not be there.
//
// What it does not do: it knows nothing of crew leave, other bookings or
// the weather. It is a suggestion for the person booking, never a booking.

// WA public holidays, as the WA Government lists them on its "Public
// holidays in Western Australia" page (wa.gov.au), checked 30 October 2026. Where a holiday falls on a weekend, the weekday
// WA gives in its place is listed (Anzac Day 2026 and 2027, Boxing Day 2026,
// Christmas and Boxing Day 2027). Easter Sunday is a WA public holiday but
// always a Sunday, so it is not listed.
//
// Add each new year here before it starts. A day past the end of this list
// is treated as an ordinary weekday, so a missing year only means a holiday
// could be suggested, never that a working day is skipped.
export const WA_PUBLIC_HOLIDAYS: ReadonlySet<string> = new Set([
  // 2026
  "2026-01-01", // New Year's Day
  "2026-01-26", // Australia Day
  "2026-03-02", // Labour Day
  "2026-04-03", // Good Friday
  "2026-04-06", // Easter Monday
  "2026-04-27", // Anzac Day (Saturday 25 April, Monday in its place)
  "2026-06-01", // Western Australia Day
  "2026-09-28", // King's Birthday
  "2026-12-25", // Christmas Day
  "2026-12-28", // Boxing Day (Saturday 26 December, Monday in its place)
  // 2027
  "2027-01-01", // New Year's Day
  "2027-01-26", // Australia Day
  "2027-03-01", // Labour Day
  "2027-03-26", // Good Friday
  "2027-03-29", // Easter Monday
  "2027-04-26", // Anzac Day (Sunday 25 April, Monday in its place)
  "2027-06-07", // Western Australia Day
  "2027-09-27", // King's Birthday
  "2027-12-27", // Christmas Day (Saturday 25 December, Monday in its place)
  "2027-12-28", // Boxing Day (Sunday 26 December, Tuesday in its place)
]);

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// The weekday of a calendar day, 0 = Sunday to 6 = Saturday. Worked out in
// UTC so the machine's own time zone never shifts the day.
function weekdayOf(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function nextDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/** True for Monday to Friday that is not a WA public holiday. */
export function isWaWorkingDay(day: string): boolean {
  if (!DAY_PATTERN.test(day)) return false;
  const weekday = weekdayOf(day);
  if (weekday === 0 || weekday === 6) return false;
  return !WA_PUBLIC_HOLIDAYS.has(day);
}

/** The first WA working day after `day` (never `day` itself). */
export function nextWaWorkingDayAfter(day: string): string {
  let candidate = nextDay(day);
  // At most a long weekend plus Christmas: the loop ends within a few days.
  while (!isWaWorkingDay(candidate)) candidate = nextDay(candidate);
  return candidate;
}

export type DispatchEarliestInstallOrder = {
  // Not delivered (or picked up) yet.
  open: boolean;
  // The order's delivery or pickup day, "YYYY-MM-DD", or null.
  date: string | null;
  // The supplier confirmed that day.
  confirmed: boolean;
};

export type DispatchEarliestInstall = {
  // The earliest day to book the install.
  day: string;
  // The last open order's confirmed date: the day all materials should be
  // in. Null when every order is already delivered.
  after_day: string | null;
};

/**
 * The earliest install day for a job: the next WA working day after the
 * later of the last open order's confirmed date and today.
 *
 * Null (not known) when there are no orders, or when any open order has no
 * confirmed date yet: one order still to come with no day means there is no
 * honest earliest day to suggest. Delivered orders are ignored.
 */
export function dispatchEarliestInstall(input: {
  today: string;
  orders: DispatchEarliestInstallOrder[];
}): DispatchEarliestInstall | null {
  if (!DAY_PATTERN.test(input.today)) return null;
  if (input.orders.length === 0) return null;
  let lastDate: string | null = null;
  for (const order of input.orders) {
    if (!order.open) continue;
    if (!order.confirmed || !order.date || !DAY_PATTERN.test(order.date)) {
      return null;
    }
    if (lastDate === null || order.date > lastDate) lastDate = order.date;
  }
  const from = lastDate !== null && lastDate > input.today
    ? lastDate
    : input.today;
  return { day: nextWaWorkingDayAfter(from), after_day: lastDate };
}
