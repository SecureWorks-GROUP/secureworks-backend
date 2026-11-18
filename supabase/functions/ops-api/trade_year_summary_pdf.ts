import { assembleTextPdf } from "./trade_invoice_pdf.ts";
import { countedHistoryInvoice, historyAmount, historyInvoiceTotals, mondayOf } from "./trade_money.ts";
import { invoiceColumns } from "./trade_pay_history_read.ts";

const tradeRoles = new Set(["crew", "installer", "lead_installer"]);
const money = (value: number) => "$" + value.toFixed(2);
const footer = "Built from your SecureWorks invoices. A summary, not tax advice. Give it to your accountant.";
type Row = Record<string, any>;

// Standard PDF Helvetica uses WinAnsi. Hex strings keep user text out of PDF operators.
const winAnsi = new Map(Array.from({ length: 256 }, (_, i) =>
  [new TextDecoder("windows-1252").decode(Uint8Array.of(i)), i] as const));

function textAt(text: string, x: number, y: number, size: number, width: number) {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  const hex = chars.map(c => {
    const byte = winAnsi.get(c);
    if (byte === undefined) throw new Error("pdf_character_unsupported");
    return byte.toString(16).padStart(2, "0");
  }).join("");
  const scale = Math.min(100, 100 * width / Math.max(1, chars.reduce((sum, c) => sum + ("WM@%".includes(c) ? 1.05 : /[A-Z]/.test(c) ? 0.8 : 0.62), 0) * size));
  return `BT /F1 ${size} Tf ${scale.toFixed(2)} Tz 1 0 0 1 ${x} ${y} Tm <${hex}> Tj ET`;
}

function invoiceLine(row: Row) {
  const day = row.week_end || row.created_at?.slice(0, 10);
  if (!day || !row.invoice_number) throw new Error("summary_unreadable");
  const { totals } = historyInvoiceTotals(row, day);
  const repayment = row.recurring_deduction_amount;
  if (repayment === undefined || (repayment === null && row.recurring_deduction_label)) {
    throw new Error("summary_unreadable");
  }
  return {
    number: String(row.invoice_number), week: row.week_start || mondayOf(day),
    amounts: [totals.total_inc_super, totals.paid_to_super, totals.paid_to_you,
      totals.reimbursements, historyAmount(row.gst), repayment === null ? 0 : historyAmount(repayment)],
  };
}

function render(fy: number, profile: Row, rows: Row[]) {
  const invoices = rows.map(invoiceLine).sort((a, b) =>
    a.week.localeCompare(b.week) || a.number.localeCompare(b.number));
  const rowHeight = Math.min(16, Math.max(10, Math.floor(510 / invoices.length)));
  const height = Math.max(792, 282 + invoices.length * rowHeight);
  const ops: string[] = [];
  let y = height - 46;
  ops.push(textAt(`Pay summary, 1 July ${fy - 1} to 30 June ${fy}`, 36, y, 17, 540));
  y -= 26;
  ops.push(textAt(profile.name, 36, y, 12, 540));
  y -= 17;
  ops.push(textAt("ABN " + profile.abn, 36, y, 10, 540));
  y -= 26;
  ["Total (includes super)", "Paid to your super fund", "Paid to you", "Reimbursements", "GST", "Repayments"]
    .forEach((label, i) => {
      const cents = invoices.reduce((sum, inv) => sum + Math.round(inv.amounts[i] * 100), 0);
      ops.push(textAt(label, 36, y, 11, 240), textAt(money(cents / 100), 276, y, 11, 290));
      y -= 16;
    });
  y -= 10;
  const columns = [36, 195, 302, 393, 480, 576];
  function tableRow(values: string[], fontSize: number) {
    values.forEach((value, i) => ops.push(textAt(value, columns[i], y, fontSize, columns[i + 1] - columns[i] - 5)));
  }
  tableRow(["Invoice number", "Week starting", "Total", "Super", "Paid to you"], 10);
  ops.push(`0.6 G 36 ${y - 3} m 576 ${y - 3} l S`);
  for (const invoice of invoices) {
    y -= rowHeight;
    tableRow([invoice.number, invoice.week, ...invoice.amounts.slice(0, 3).map(money)], Math.min(10, rowHeight - 1));
  }
  ops.push(textAt(footer, 36, y - 27, 9, 540));
  return assembleTextPdf([new TextEncoder().encode(ops.join("\n"))], height, true);
}

export async function myPayYearSummaryPdf(
  client: any, caller: { id: string; role: string }, method: string,
  params: URLSearchParams, cors: Record<string, string> = {},
): Promise<Response> {
  const headers = { ...cors, "Cache-Control": "private, no-store" };
  const refuse = (status: number, code: string) => Response.json({ code }, { status, headers });
  if (!caller.id || !tradeRoles.has(caller.role) || params.has("user_id") || params.has("trade_id")) {
    return refuse(403, "own_pay_only");
  }
  if (method !== "GET") return refuse(405, "get_required");
  const fy = params.get("fy") || "";
  if (params.getAll("fy").length !== 1 || !/^[1-9]\d{3}$/.test(fy)) return refuse(400, "fy_invalid");
  const start = String(Number(fy) - 1).padStart(4, "0") + "-07-01";
  const end = fy + "-06-30";
  try {
    const invoices: Row[] = [];
    // The legacy time is read only on invoices with no week end, like pay history.
    const range = `and(week_end.gte.${start},week_end.lte.${end}),and(week_end.is.null,created_at.gte.${start},created_at.lt.${fy}-07-01)`;
    const pageSize = 250;
    let after: string | undefined;
    for (;;) {
      let query = client.from("trade_invoices").select(invoiceColumns).eq("user_id", caller.id)
        .not("status", "in", "(draft,ops-reject,failed)").or(range)
        .eq("reimbursements.line_type", "reimbursement").order("id").limit(pageSize);
      if (after) query = query.gt("id", after);
      const { data, error } = await query;
      if (error || !Array.isArray(data)) throw new Error("summary_unreadable");
      invoices.push(...data.filter(countedHistoryInvoice));
      if (data.length < pageSize) break;
      after = data[data.length - 1].id;
    }
    if (!invoices.length) return refuse(404, "no_invoices_that_year");
    const { data, error } = await client.from("users").select("name,abn").eq("id", caller.id).maybeSingle();
    if (error || !data?.name?.trim() || !String(data.abn ?? "").trim()) throw new Error("summary_unreadable");
    return new Response(render(Number(fy), data, invoices), { headers: { ...headers,
      "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="pay-summary-${fy}.pdf"`,
    } });
  } catch {
    return refuse(503, "pay_year_summary_unreadable");
  }
}
