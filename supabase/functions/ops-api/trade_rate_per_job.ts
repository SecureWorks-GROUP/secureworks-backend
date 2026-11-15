// A trade's own hourly rate on a booked job (owner, 15 Nov 2026: "Let trades
// decide per job but flag on invoices when they input rates higher than
// what's on their office rate").
//
// Before this, a rate the trade typed on a booked job card was never read:
// every booked line billed the office rate from trade_rates. Now:
// - a rate the trade typed for a job card bills that card, and the line is
//   client_entered;
// - a rate above the office rate is flagged in the line's query note, and the
//   pay-run check (trade_pay_run_check, rule rate_above_office) stops the bill
//   until a person has looked; at or below the office rate it passes;
// - no rate, or the office rate itself, bills the office rate as before;
// - a rate that is not a positive amount of dollars and cents is refused,
//   never guessed.
// The office rate stays the only rate when none is on file (RATE_NOT_CONFIGURED
// is unchanged). my_hours says so to the apps with trade_rate_editable.

export class TradeJobRateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TradeJobRateError";
  }
}

/**
 * The rate a trade typed on a booked job card, or null when the card bills
 * the office rate. Throws TradeJobRateError for a rate that cannot be read.
 */
export function tradeTypedJobRate(
  raw: unknown,
  officeRate: number,
  label: string,
): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string" && raw.trim() === "") return null;
  let n = NaN;
  if (typeof raw === "number") n = raw;
  else if (
    typeof raw === "string" && /^\d{1,5}(\.\d{1,2})?$/.test(raw.trim())
  ) {
    n = Number(raw.trim());
  }
  if (!Number.isFinite(n) || n < 0) {
    throw new TradeJobRateError(
      `Check the hourly rate on ${label}: it must be an amount in dollars and cents.`,
    );
  }
  if (n === 0) return null;
  const cents = Math.round(n * 100) / 100;
  if (Math.abs(cents - n) > 0.000001) {
    throw new TradeJobRateError(
      `Check the hourly rate on ${label}: it must be an amount in dollars and cents.`,
    );
  }
  if (Math.abs(cents - officeRate) <= 0.004) return null;
  return cents;
}

function dollars(n: number): string {
  return "$" + n.toFixed(2);
}

/** The words a booked line carries about its rate, for the office. */
export function tradeJobRateNote(
  rate: number,
  officeRate: number,
  clientEntered: boolean,
): string {
  if (!clientEntered) return "Server-resolved rate from trade_rates.";
  const base = "Rate set by the trade for this job: " + dollars(rate) + "/hr.";
  if (officeRate > 0 && rate > officeRate + 0.004) {
    return base + " Above the office rate of " + dollars(officeRate) +
      "/hr: check before approving.";
  }
  return base + " At or below the office rate of " + dollars(officeRate) +
    "/hr.";
}
