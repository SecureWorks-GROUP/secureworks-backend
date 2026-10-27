import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { parseBankSummary } from "./bank_summary.ts";

const cell = (v: string, id?: string) => (id ? { Value: v, Attributes: [{ Id: "accountID", Value: id }] } : { Value: v });

function report(header: string[], rows: string[][]) {
  return {
    Reports: [{
      Rows: [
        { RowType: "Header", Cells: header.map((h) => cell(h)) },
        { RowType: "Section", Rows: rows.map((r) => ({ RowType: "Row", Cells: r.map((v, i) => cell(v, i === 0 ? `id-${r[0]}` : undefined)) })) },
        { RowType: "Section", Rows: [{ RowType: "SummaryRow", Cells: [cell("Total"), cell("1")] }] },
      ],
    }],
  };
}

Deno.test("the balance stored is the Closing Balance, not the Opening Balance (live layout 19 Oct 2026)", () => {
  const out = parseBankSummary(report(
    ["Bank Accounts", "Opening Balance", "Cash Received", "Cash Spent", "Closing Balance"],
    [["Operations", "102249.38", "182542.28", "229692.99", "55098.67"]],
  ));
  assertEquals(out.closingColumn, 4);
  assertEquals(out.rows, [{ account_id: "id-Operations", account_name: "Operations", balance: 55098.67 }]);
});

Deno.test("the closing column is found by heading when an FX column is present", () => {
  const out = parseBankSummary(report(
    ["Bank Accounts", "Opening Balance", "Cash Received", "Cash Spent", "FX Gain/Loss", "Closing Balance"],
    [["USD", "10", "0", "0", "1", "11"]],
  ));
  assertEquals(out.rows[0].balance, 11);
});

Deno.test("no Closing Balance heading, or an unreadable value: nothing is stored, never $0", () => {
  assertEquals(parseBankSummary(report(["Bank Accounts", "Opening Balance"], [["Ops", "5"]])).rows, []);
  assertEquals(parseBankSummary(report(["Bank Accounts", "Opening Balance", "Closing Balance"], [["Ops", "5", ""]])).rows, []);
  assertEquals(parseBankSummary(report(["Bank Accounts", "Opening Balance", "Closing Balance"], [["Ops", "5", "n/a"]])).rows, []);
  assertEquals(parseBankSummary({}).rows, []);
});
