// deno-lint-ignore-file no-explicit-any
// ════════════════════════════════════════════════════════════
// TP-01 XERO TIE-OUT: the staff read (20261029121500).
//
//   xero_tieout  GET  ?as_of=YYYY-MM-DD (default today, Perth)
//                     &months=N (1..120, default 12)
//
// By month, every AUTHORISED or PAID supplier bill dollar (ex GST) in our copy
// of Xero, sorted into on a job, trade-app labour (already counted on jobs by
// the trade app), overhead / not job related, or unplaced, with the unplaced
// share and the last 6 months. The SQL function xero_tieout_monthly does all
// the sorting; this door only passes the parameters and the caller's org, and
// refuses to show an unreadable answer as an empty one.
//
// Org: always the caller's. A staff session reads its profile's org (never
// the server org substituted for a missing one); the server key reads the
// server org, as the other staff reads here do.
//
// as_of picks the months shown and nothing else: allocation rows and Bills to
// place states are read as they are today.
//
// Spend money (TP-08) comes back as not_yet_read with a null amount, never $0,
// inside the bills answer. Since 20261115110000 the door also asks
// xero_spend_revenue_monthly for the two sides the bills answer does not cover
// (card and bank spend sorted by Xero account, and customer invoices against
// Job Profit) and returns it beside the bills answer as spend_revenue:
// { ok: true, answer } or { ok: false, reason }. The bills answer is never
// changed by it and never fails because of it: a second read that cannot be
// read says so and the page keeps showing "Not read yet".
// Supplier credit notes (TP-07) do too until xero-sync has finished a full
// read of the org's credit notes; after it each month carries its credit
// notes beside the bills total, never netted from it (20261030060000). Staff
// only: the action is not in
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

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function tieoutParams(
  asOf: string | null | undefined,
  months: string | null | undefined,
  orgId: string | null | undefined,
): { p_as_of: string | null; p_months: number; p_org_id: string } {
  const org = String(orgId ?? "").trim();
  if (!UUID_RE.test(org)) {
    throw new XeroTieoutError(
      "Your profile has no organisation, so the tie-out cannot be read",
      403,
    );
  }
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
  return { p_as_of: pAsOf, p_months: pMonths, p_org_id: org };
}

export async function readXeroTieout(
  client: any,
  opts: { asOf?: string | null; months?: string | null; orgId: string | null },
): Promise<Record<string, unknown>> {
  const params = tieoutParams(opts.asOf, opts.months, opts.orgId);
  const [{ data, error }, spendRevenue] = await Promise.all([
    client.rpc("xero_tieout_monthly", params),
    readSpendRevenue(client, params),
  ]);
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
  return { ok: true, tieout: data, spend_revenue: spendRevenue };
}

export type SpendRevenueRead =
  | { ok: true; answer: Record<string, unknown> }
  | { ok: false; reason: string };

// The second read. Whatever goes wrong here is reported, never thrown: the
// bills answer stands on its own.
async function readSpendRevenue(
  client: any,
  params: { p_as_of: string | null; p_months: number; p_org_id: string },
): Promise<SpendRevenueRead> {
  try {
    const { data, error } = await client.rpc(
      "xero_spend_revenue_monthly",
      params,
    );
    if (error) {
      return { ok: false, reason: String(error.message ?? "read failed") };
    }
    if (
      !data || typeof data !== "object" || !Array.isArray((data as any).months)
    ) {
      return { ok: false, reason: "no answer" };
    }
    return { ok: true, answer: data };
  } catch (e) {
    return { ok: false, reason: (e as Error)?.message ?? "read failed" };
  }
}
