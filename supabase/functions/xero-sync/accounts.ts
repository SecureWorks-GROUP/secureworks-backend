// Our copy of Xero's chart of accounts (xero_accounts, 20261115110000). One GET,
// no write to Xero. Each account's Type and Class are stored exactly as Xero
// sent them: they are what says whether a spend money line is a direct cost, an
// overhead or not a cost at all (xero_spend_revenue_monthly). An account missing
// from an answer is left as it was, never deleted: Xero lists archived accounts
// too, and a line coded to one must still be readable.
import { xeroCollection, type XeroRecord, xeroText } from "../_shared/xero_settlement_evidence.ts";

export type XeroAccountRow = {
  org_id: string;
  xero_account_id: string;
  code: string | null;
  name: string | null;
  type: string | null;
  class: string | null;
  status: string | null;
  tax_type: string | null;
  synced_at: string;
};

export function xeroAccountRow(raw: XeroRecord, orgId: string, now: Date): XeroAccountRow | null {
  const id = xeroText(raw.AccountID);
  if (!id) return null;
  return {
    org_id: orgId,
    xero_account_id: id,
    code: xeroText(raw.Code),
    name: xeroText(raw.Name),
    type: xeroText(raw.Type),
    class: xeroText(raw.Class),
    status: xeroText(raw.Status),
    tax_type: xeroText(raw.TaxType),
    synced_at: now.toISOString(),
  };
}

type Get = (
  path: string,
  params: Record<string, string>,
  headers: Record<string, string>,
) => Promise<unknown>;

// deno-lint-ignore no-explicit-any
type Client = { from: (t: string) => any };

export async function syncXeroAccounts(
  sb: Client,
  orgId: string,
  get: Get,
  now = () => new Date(),
): Promise<{ ok: true; accounts: number }> {
  const at = now();
  const seen = new Set<string>();
  const rows: XeroAccountRow[] = [];
  for (const raw of xeroCollection(await get("/Accounts", {}, {}), "Accounts")) {
    const row = xeroAccountRow(raw, orgId, at);
    if (!row || seen.has(row.xero_account_id)) continue;
    seen.add(row.xero_account_id);
    rows.push(row);
  }
  // An empty chart is not a chart: refuse it and keep what we hold.
  if (rows.length === 0) throw new Error("Xero returned no accounts; the chart copy is unchanged");
  const { error } = await sb.from("xero_accounts").upsert(rows, { onConflict: "org_id,xero_account_id" });
  if (error) throw new Error(`Chart of accounts write failed: ${error.message}`);
  return { ok: true, accounts: rows.length };
}
