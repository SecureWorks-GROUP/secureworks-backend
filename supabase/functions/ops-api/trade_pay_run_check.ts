// deno-lint-ignore-file no-explicit-any
// ════════════════════════════════════════════════════════════
// Trade pay-run check: the staff read (20261115140000, rule trade-pay-check-v1).
//
//   trade_pay_run_check  GET  ?as_of=YYYY-MM-DD (default today, Perth)
//                             &weeks=N (1..26, default 2)
//
// Every live trade invoice in the pay weeks ending with the week of as_of,
// marked clean or stopped with plain reasons, so the bookkeeper approves the
// clean bills in Xero in one batch and looks only at the stopped ones. The SQL
// function trade_pay_run_check does every check; this door only passes the
// parameters and the caller's org, and refuses to show an unreadable answer as
// an empty one. Contract: docs/trade-pay-run-check-v1.md.
//
// Org: always the caller's. A staff session reads its profile's org (never the
// server org substituted for a missing one); the server key reads the server
// org, as the other staff reads here do.
//
// Staff only: the action is not in any trade, routine or agent-read list, so
// the ops-api front door admits only the staff operator set (admin, owner,
// ops_manager) or the server key. It names trades and their pay. Never writes,
// never calls Xero.
// ════════════════════════════════════════════════════════════

export class TradePayRunCheckError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function payRunCheckParams(
  asOf: string | null | undefined,
  weeks: string | null | undefined,
  orgId: string | null | undefined,
): { p_as_of: string | null; p_weeks: number; p_org_id: string } {
  const org = String(orgId ?? "").trim();
  if (!UUID_RE.test(org)) {
    throw new TradePayRunCheckError(
      "Your profile has no organisation, so the pay-run check cannot be read",
      403,
    );
  }
  let pAsOf: string | null = null;
  if (asOf != null && String(asOf).trim() !== "") {
    const v = String(asOf).trim();
    const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00Z`) : null;
    if (!d || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) {
      throw new TradePayRunCheckError("as_of must be a date, YYYY-MM-DD");
    }
    pAsOf = v;
  }
  let pWeeks = 2;
  if (weeks != null && String(weeks).trim() !== "") {
    const w = String(weeks).trim();
    const n = /^\d{1,2}$/.test(w) ? Number(w) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > 26) {
      throw new TradePayRunCheckError(
        "weeks must be a whole number from 1 to 26",
      );
    }
    pWeeks = n;
  }
  return { p_as_of: pAsOf, p_weeks: pWeeks, p_org_id: org };
}

export async function readTradePayRunCheck(
  client: any,
  opts: { asOf?: string | null; weeks?: string | null; orgId: string | null },
): Promise<Record<string, unknown>> {
  const params = payRunCheckParams(opts.asOf, opts.weeks, opts.orgId);
  const { data, error } = await client.rpc("trade_pay_run_check", params);
  // An unreadable check is never shown as "every bill clean".
  if (
    error || !data || typeof data !== "object" ||
    (data as any).rule !== "trade-pay-check-v1" ||
    !Array.isArray((data as any).invoices) ||
    !(data as any).counts || typeof (data as any).counts !== "object" ||
    (data as any).counts.invoices !== (data as any).invoices.length ||
    (data as any).counts.clean + (data as any).counts.stopped !==
      (data as any).invoices.length ||
    // A bill reads clean only when it carries no stop.
    !(data as any).invoices.every((inv: any) =>
      Array.isArray(inv?.stops) &&
      inv.verdict === (inv.stops.length > 0 ? "stopped" : "clean")
    )
  ) {
    throw new TradePayRunCheckError(
      `The pay-run check could not be read: ${error?.message ?? "no answer"}`,
      503,
    );
  }
  return { ok: true, check: data };
}
