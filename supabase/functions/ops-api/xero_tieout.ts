// deno-lint-ignore-file no-explicit-any
// ════════════════════════════════════════════════════════════
// TP-01 XERO TIE-OUT: the staff read (20261029120000).
//
//   xero_tieout  GET  ?as_of=YYYY-MM-DD (default today, Perth)
//                     &months=N (1..120, default 12)
//
// By month, every AUTHORISED or PAID supplier bill dollar (ex GST) in our copy
// of Xero, sorted into on a job, a named non-job bucket (overhead / not job
// related, trade-app mirror) or unplaced, with the unplaced share and the last
// 6 months. The SQL function xero_tieout_monthly does all the sorting; this
// door only passes the two parameters and refuses to show an unreadable answer
// as an empty one.
//
// Supplier credit notes (TP-07) and spend money (TP-08) come back as
// not_yet_read with null amounts, never $0. Staff only: the action is not in
// any trade, routine or agent-read list, so the ops-api front door admits only
// the staff operator set (admin, owner, ops_manager) or the server key.
// Never writes.
// ════════════════════════════════════════════════════════════

export class XeroTieoutError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export function tieoutParams(
  asOf: string | null | undefined,
  months: string | null | undefined,
): { p_as_of: string | null; p_months: number } {
  let pAsOf: string | null = null;
  if (asOf != null && String(asOf).trim() !== "") {
    const v = String(asOf).trim();
    const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00Z`) : null;
    if (!d || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) {
      throw new XeroTieoutError("as_of must be a date, YYYY-MM-DD");
    }
    pAsOf = v;
  }
  let pMonths = 12;
  if (months != null && String(months).trim() !== "") {
    const n = Number(String(months).trim());
    if (!Number.isInteger(n) || n < 1 || n > 120) {
      throw new XeroTieoutError("months must be a whole number from 1 to 120");
    }
    pMonths = n;
  }
  return { p_as_of: pAsOf, p_months: pMonths };
}

export async function readXeroTieout(
  client: any,
  opts: { asOf?: string | null; months?: string | null },
): Promise<Record<string, unknown>> {
  const params = tieoutParams(opts.asOf, opts.months);
  const { data, error } = await client.rpc("xero_tieout_monthly", params);
  // An unreadable tie-out is never shown as "nothing unplaced".
  if (
    error || !data || typeof data !== "object" ||
    !Array.isArray((data as any).months)
  ) {
    throw new XeroTieoutError(
      `Xero tie-out could not be read: ${error?.message ?? "no answer"}`,
      503,
    );
  }
  return { ok: true, tieout: data };
}
