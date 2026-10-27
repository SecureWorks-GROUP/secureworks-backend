// Xero Bank Summary report → one closing balance per bank account.
//
// The report's columns are: Bank Accounts, Opening Balance, Cash Received, Cash
// Spent, (FX gain/loss when present), Closing Balance. The balance of an account
// at the report date is the Closing Balance, found by its heading, never by a
// fixed position. A row whose closing balance cannot be read is left out: an
// unknown balance is never stored as $0.

export interface BankBalanceRow {
  account_id: string;
  account_name: string;
  balance: number;
}

export function parseBankSummary(report: any): { rows: BankBalanceRow[]; closingColumn: number | null } {
  const r = report?.Reports?.[0];
  const sections: any[] = r?.Rows || [];
  const header = sections.find((s) => s?.RowType === "Header");
  const titles: string[] = (header?.Cells || []).map((c: any) => String(c?.Value || "").trim().toLowerCase());
  const idx = titles.findIndex((t) => t === "closing balance");
  if (idx < 1) return { rows: [], closingColumn: null };
  const rows: BankBalanceRow[] = [];
  for (const section of sections) {
    if (section?.RowType !== "Section" || !Array.isArray(section.Rows)) continue;
    for (const row of section.Rows) {
      if (row?.RowType !== "Row" || !Array.isArray(row.Cells)) continue;
      const name = String(row.Cells[0]?.Value || "").trim();
      if (!name) continue;
      const raw = row.Cells[idx]?.Value;
      if (raw === undefined || raw === null || String(raw).trim() === "") continue;
      const balance = Number(String(raw).replace(/,/g, ""));
      if (!Number.isFinite(balance)) continue;
      // Same key as before 19 Oct 2026, so new rows continue the old series.
      const id = row.Cells[0]?.Attributes?.[0]?.Value || name;
      rows.push({ account_id: String(id), account_name: name, balance });
    }
  }
  return { rows, closingColumn: idx };
}
