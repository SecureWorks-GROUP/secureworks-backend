// deno-lint-ignore-file no-explicit-any
// Debt Workshop: the debt report as a PDF (docs/debt-workshop/README.md, "The debt report").
//
// Drawn server side with jsPDF, the same import the purchase order PDF and the make-safe
// report use (dispatch_order_pdf.ts), from the report data in debt_ws_report.ts, so the PDF
// that is downloaded or emailed holds exactly the figures the Debt tab's report view shows.
//
// Layout, portrait throughout (Shaun, 4 Nov 2026): page 1 is the summary: Receivables,
// Debt overdue, Bad debt, Other receivables and cash at bank; where the receivables sit
// with the tie to our Xero copy; debt by how overdue (Private and Companies); coming due in
// the next 7 days; what happened this week; and the terms. Then every invoice, by how
// overdue it is, and the notes. Every page carries "Page x of n".

import {
  type DebtReport,
  invoiceWords,
  overdueSections,
  perthClock as clock,
  shortDate,
  termsNote,
  tieWords,
  typeWords,
  weekLines,
  xeroCheckNote,
} from "./debt_ws_report.ts";
import { money } from "./debt_ws_rules.ts";

export interface DebtReportPdf {
  bytes: Uint8Array;
  pageCount: number;
}

type RGB = [number, number, number];
const DARK: RGB = [26, 39, 46];
const BLUE: RGB = [41, 60, 70];
const MID: RGB = [76, 106, 124];
const HAZE: RGB = [143, 164, 178];
const MIST: RGB = [212, 222, 228];
const FROST: RGB = [237, 241, 244];
const ORANGE: RGB = [241, 90, 41];
const EMBER: RGB = [196, 72, 31];
const BLUSH: RGB = [253, 242, 238];
const TEXT: RGB = [50, 50, 50];
const GREEN: RGB = [46, 107, 58];
const RED: RGB = [142, 43, 30];
const M = 12; // page margin, mm

// jsPDF's built-in Helvetica is WinAnsi: anything outside it is replaced, so a stray
// character in a client name can never break the file.
export function reportPdfText(value: unknown): string {
  return String(value ?? "")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u00D7/g, "x")
    .replace(/[^\x20-\x7e\u00A0-\u00FF]/g, "?");
}

type Align = "left" | "right";
interface Col {
  label: string;
  /** Share of the usable width. */
  w: number;
  align?: Align;
}
type RowStyle = "normal" | "group" | "total" | "sub" | "ok" | "warn" | "muted";
interface Row {
  cells: string[];
  style?: RowStyle;
}

export async function renderDebtReportPdf(
  r: DebtReport,
): Promise<DebtReportPdf> {
  // deno-lint-ignore no-import-prefix
  const { jsPDF } = await import("https://esm.sh/jspdf@2.5.1");
  const doc: any = new jsPDF({
    orientation: "portrait",
    unit: "mm",
    format: "a4",
  });
  // Fixed creation date and file id from the report's own facts: the same report makes
  // the same bytes.
  doc.setCreationDate(new Date(`${r.today}T00:00:00.000Z`));
  doc.setProperties({
    title: reportPdfText(`Debt and receivables ${r.today}`),
  });

  let orientation: "portrait" | "landscape" = "portrait";
  const W = () => doc.internal.pageSize.getWidth();
  const H = () => doc.internal.pageSize.getHeight();
  const usable = () => W() - M * 2;
  const bottom = () => H() - M - 6;
  const lineH = (pt: number) => pt * 0.3528 * 1.2;
  let y = M;

  const font = (style: "normal" | "bold", size: number, color: RGB) => {
    doc.setFont("helvetica", style);
    doc.setFontSize(size);
    doc.setTextColor(...color);
  };

  // A later page: a thin orange bar and the report's name.
  const newPage = (o: "portrait" | "landscape" = orientation) => {
    orientation = o;
    doc.addPage("a4", o);
    doc.setFillColor(...ORANGE);
    doc.rect(0, 0, W(), 2.5, "F");
    font("bold", 8, MID);
    doc.text(
      reportPdfText(`DEBT AND RECEIVABLES  ${r.as_at.toUpperCase()}`),
      M,
      M - 2,
    );
    y = M + 4;
  };
  const ensure = (h: number) => {
    if (y + h > bottom()) {
      newPage();
      return true;
    }
    return false;
  };

  const heading = (text: string) => {
    ensure(14);
    y += 2;
    font("bold", 12.5, BLUE);
    doc.text(reportPdfText(text), M, y + 4);
    doc.setDrawColor(...ORANGE);
    doc.setLineWidth(0.6);
    doc.line(M, y + 6, M + usable(), y + 6);
    y += 9;
  };
  const subheading = (text: string) => {
    ensure(9);
    font("bold", 8.5, BLUE);
    doc.text(reportPdfText(text.toUpperCase()), M, y + 3.5);
    y += 5.5;
  };
  const sectionBar = (text: string, amount: string) => {
    ensure(16);
    y += 1.5;
    doc.setFillColor(...FROST);
    doc.rect(M, y, usable(), 6.5, "F");
    doc.setFillColor(...ORANGE);
    doc.rect(M, y, 1, 6.5, "F");
    font("bold", 9, BLUE);
    doc.text(reportPdfText(text), M + 3, y + 4.5);
    font("bold", 9, EMBER);
    doc.text(reportPdfText(amount), M + usable() - 2, y + 4.5, {
      align: "right",
    });
    y += 8;
  };
  const para = (text: string, size = 8, color: RGB = MID, indent = 0) => {
    font("normal", size, color);
    const lines: string[] = doc.splitTextToSize(
      reportPdfText(text),
      usable() - indent,
    );
    for (const line of lines) {
      ensure(lineH(size));
      doc.text(line, M + indent, y + lineH(size) * 0.8);
      y += lineH(size);
    }
    y += 1;
  };
  const bullet = (text: string, size = 8.5) => {
    font("normal", size, TEXT);
    const lines: string[] = doc.splitTextToSize(
      reportPdfText(text),
      usable() - 5,
    );
    // Keep a short point on one page; a long one may run over.
    ensure(lineH(size) * Math.min(lines.length, 8));
    doc.text("-", M + 1, y + lineH(size) * 0.8);
    for (const line of lines) {
      ensure(lineH(size));
      doc.text(line, M + 5, y + lineH(size) * 0.8);
      y += lineH(size);
    }
    y += 1.2;
  };

  /** A table across the usable width, its header repeated on every page it runs onto. */
  const table = (
    cols: Col[],
    rows: Row[],
    opts: { size?: number; header?: boolean; width?: number } = {},
  ) => {
    const size = opts.size ?? 8;
    const width = opts.width ?? usable();
    const total = cols.reduce((s, c) => s + c.w, 0);
    const widths = cols.map((c) => (c.w / total) * width);
    const xs = widths.map((_, i) =>
      M + widths.slice(0, i).reduce((s, w) => s + w, 0)
    );
    const pad = 1.2;
    const drawHeader = () => {
      if (opts.header === false) return;
      font("bold", size - 0.8, MID);
      const heads = cols.map((c, i) =>
        doc.splitTextToSize(reportPdfText(c.label), widths[i] - pad * 2) as string[]
      );
      const h = Math.max(...heads.map((l) => l.length)) * lineH(size - 0.8) + 1.5;
      cols.forEach((c, i) => {
        heads[i].forEach((line, k) => {
          const ty = y + lineH(size - 0.8) * (k + 0.8);
          if (c.align === "right") {
            doc.text(line, xs[i] + widths[i] - pad, ty, { align: "right" });
          } else doc.text(line, xs[i] + pad, ty);
        });
      });
      y += h;
      doc.setDrawColor(...HAZE);
      doc.setLineWidth(0.25);
      doc.line(M, y - 0.4, M + width, y - 0.4);
    };
    if (y + 12 > bottom()) newPage();
    drawHeader();
    for (const row of rows) {
      const style = row.style ?? "normal";
      const bold = style === "group" || style === "total" || style === "sub" ||
        style === "ok" || style === "warn";
      const color: RGB = style === "sub"
        ? EMBER
        : style === "total" || style === "group"
        ? BLUE
        : style === "ok"
        ? GREEN
        : style === "warn"
        ? RED
        : style === "muted"
        ? MID
        : TEXT;
      font(bold ? "bold" : "normal", size, color);
      // A group, ok or warn row runs across the whole table in its first cell.
      const span = style === "group" || style === "ok" || style === "warn";
      const wrapped = row.cells.map((cell, i) =>
        doc.splitTextToSize(
          reportPdfText(cell),
          (span && i === 0 ? width : widths[i]) - pad * 2,
        ) as string[]
      );
      const lines = Math.max(
        1,
        ...wrapped.map((l, i) => (span && i > 0 ? 0 : l.length)),
      );
      const h = lines * lineH(size) + 1.4;
      if (y + h > bottom()) {
        newPage();
        drawHeader();
        font(bold ? "bold" : "normal", size, color);
      }
      if (style === "sub") {
        doc.setFillColor(...BLUSH);
        doc.rect(M, y, width, h, "F");
      }
      if (style === "total") {
        doc.setDrawColor(...BLUE);
        doc.setLineWidth(0.4);
        doc.line(M, y, M + width, y);
      }
      row.cells.forEach((_, i) => {
        if (span && i > 0) return;
        wrapped[i].forEach((line, k) => {
          const ty = y + 0.7 + lineH(size) * (k + 0.8);
          if (cols[i].align === "right" && !(span && i === 0)) {
            doc.text(line, xs[i] + widths[i] - pad, ty, { align: "right" });
          } else doc.text(line, xs[i] + pad, ty);
        });
      });
      y += h;
      if (style !== "group" && style !== "total") {
        doc.setDrawColor(...FROST);
        doc.setLineWidth(0.2);
        doc.line(M, y, M + width, y);
      }
    }
    y += 3;
  };

  // ── Page 1: the band, the five headline figures and the summary tables ──
  doc.setFillColor(...DARK);
  doc.rect(0, 0, W(), 24, "F");
  doc.setFillColor(...ORANGE);
  doc.rect(0, 24, W(), 1.2, "F");
  font("bold", 9, [255, 255, 255]);
  doc.text("SECUREWORKS GROUP", M, 13.5);
  font("bold", 19, [255, 255, 255]);
  doc.text("Debt and receivables", W() - M, 12.5, { align: "right" });
  font("normal", 8.5, MIST);
  doc.text(reportPdfText(`As at ${r.as_at}`), W() - M, 19, { align: "right" });
  y = 29;
  para(
    `Invoices from our Xero copy${
      r.synced_at ? `, last synced at ${clock(r.synced_at)} Perth time` : ""
    }. ${
      r.bank.status === "ok"
        ? `Bank balances read live from Xero at ${clock(r.bank.read_at)}. `
        : ""
    }Worked out with the Debt tab's own rules, so every number here matches the tab.`,
    7.5,
  );

  const rv = r.receivables;
  const kpis: Array<[string, string, string, boolean]> = [
    [
      "Receivables",
      money(rv.amount),
      `${rv.count} unpaid invoices${
        r.tie.ok ? "; ties to our Xero copy" : "; does not tie to our Xero copy"
      }`,
      false,
    ],
    [
      "Debt overdue",
      money(rv.debt_overdue.amount),
      `${rv.debt_overdue.count} invoices past pay by`,
      true,
    ],
    [
      "Bad debt (21 days or more)",
      money(rv.bad_debt.amount),
      `${rv.bad_debt.count} invoices`,
      true,
    ],
    [
      "Other receivables",
      money(rv.other.amount),
      `${money(rv.other_overdue.amount)} of it overdue`,
      false,
    ],
    [
      "Cash at bank",
      r.bank.status === "ok" ? money(r.bank.total) : "Not read",
      r.bank.status === "ok"
        ? `${money(r.bank.total - r.bank.provisions)} less provisions`
        : "Xero could not be read",
      false,
    ],
  ];
  const gap = 2.5;
  const kw = (usable() - gap * (kpis.length - 1)) / kpis.length;
  kpis.forEach(([label, value, sub, hot], i) => {
    const x = M + i * (kw + gap);
    doc.setFillColor(...(hot ? BLUSH : [252, 251, 250] as RGB));
    doc.rect(x, y, kw, 18, "F");
    doc.setDrawColor(...MIST);
    doc.setLineWidth(0.2);
    doc.rect(x, y, kw, 18);
    doc.setFillColor(...(hot ? ORANGE : BLUE));
    doc.rect(x, y, kw, 1.1, "F");
    font("normal", 5.8, MID);
    doc.text(
      doc.splitTextToSize(reportPdfText(label.toUpperCase()), kw - 3)[0] ?? "",
      x + 1.5,
      y + 5,
    );
    font("bold", 11.5, hot ? EMBER : BLUE);
    doc.text(reportPdfText(value), x + 1.5, y + 11.5);
    font("normal", 5.8, MID);
    doc.text(
      doc.splitTextToSize(reportPdfText(sub), kw - 3)[0] ?? "",
      x + 1.5,
      y + 15.8,
    );
  });
  y += 22;

  // Where the receivables sit, with the tie to our Xero copy.
  subheading("Where the receivables sit");
  const whereRows: Row[] = rv.lines.map((l) => ({
    cells: [`${l.name}  (${l.sub})`, String(l.count), money(l.amount)],
    style: l.key === "debt_overdue" ? "sub" as RowStyle : "normal" as RowStyle,
  }));
  whereRows.push({
    cells: ["Receivables", String(rv.count), money(rv.amount)],
    style: "total",
  });
  whereRows.push({ cells: [tieWords(r)], style: r.tie.ok ? "ok" : "warn" });
  // Whether our Xero copy matched Xero itself at the last hourly check.
  whereRows.push({
    cells: [xeroCheckNote(r.xero_check)],
    style: r.xero_check?.status === "matches" ? "ok" : "warn",
  });
  table(
    [{ label: "", w: 70 }, { label: "No.", w: 10, align: "right" }, {
      label: "Amount",
      w: 20,
      align: "right",
    }],
    whereRows,
  );

  subheading("Debt, by how overdue");
  const bandSum = (k: "private" | "companies" | "total") =>
    r.debt_bands.reduce((s, b) => s + Math.round(b[k].amount * 100), 0) / 100;
  table(
    [
      { label: "Days overdue", w: 34 },
      { label: "Private", w: 18, align: "right" },
      { label: "Companies", w: 18, align: "right" },
      { label: "No.", w: 10, align: "right" },
      { label: "Total", w: 20, align: "right" },
    ],
    [
      ...r.debt_bands.map((b) => ({
        cells: [
          b.name,
          money(b.private.amount),
          money(b.companies.amount),
          String(b.total.count),
          money(b.total.amount),
        ],
        style: b.key === "d21" ? "sub" as RowStyle : "normal" as RowStyle,
      })),
      {
        cells: [
          "All debt",
          money(bandSum("private")),
          money(bandSum("companies")),
          String(rv.debt.count),
          money(bandSum("total")),
        ],
        style: "total" as RowStyle,
      },
    ],
  );

  subheading(
    `Coming due in the next 7 days (${shortDate(r.coming_due.from)} to ${
      shortDate(r.coming_due.to)
    })`,
  );
  table(
    [{ label: "", w: 60 }, { label: "No.", w: 15, align: "right" }, {
      label: "Amount",
      w: 25,
      align: "right",
    }],
    [
      {
        cells: [
          "Debt",
          String(r.coming_due.debt.count),
          money(r.coming_due.debt.amount),
        ],
      },
      {
        cells: [
          "Other receivables",
          String(r.coming_due.other.count),
          money(r.coming_due.other.amount),
        ],
      },
    ],
  );

  subheading(
    `What happened this week (${shortDate(r.week.from)} to ${
      shortDate(r.week.to)
    })`,
  );
  table(
    [{ label: "", w: 70 }, { label: "", w: 30, align: "right" }],
    weekLines(r).map(([k, v]) => ({ cells: [k, v] })),
    { header: false },
  );
  para(termsNote(r), 7.5);

  // ── Every invoice, by how overdue it is ──
  newPage("portrait");
  heading("Every invoice, by how overdue it is");
  para(
    `Every unpaid invoice in Receivables, most overdue first. Days overdue count from the pay-by date. The sections add up to Receivables, ${
      money(rv.amount)
    }.`,
  );
  const invCols: Col[] = [
    { label: "Who", w: 27 },
    { label: "Invoice", w: 17 },
    { label: "Type", w: 17 },
    { label: "Amount", w: 11, align: "right" },
    { label: "Invoiced", w: 9.5 },
    { label: "Pay by", w: 9.5 },
    { label: "Days overdue", w: 9, align: "right" },
  ];
  for (const s of overdueSections(r)) {
    sectionBar(s.title, money(s.total));
    table(invCols, [
      ...s.rows.map((x) => ({
        cells: [
          x.hold ? `${x.payer} (held: ${x.hold})` : x.payer,
          invoiceWords(x),
          typeWords(x),
          money(x.amount),
          shortDate(x.invoice_date),
          shortDate(x.pay_by),
          String(x.days_overdue),
        ],
      })),
      {
        cells: [
          `${s.rows.length} invoice${s.rows.length === 1 ? "" : "s"}`,
          "",
          "",
          money(s.total),
          "",
          "",
          "",
        ],
        style: "total",
      },
    ], { size: 7 });
  }

  // ── Notes ──
  heading("Notes");
  for (const n of r.notes) bullet(n, 7.8);
  y += 2;
  para(
    `Prepared from the Debt tab for ${r.prepared_by}, SecureWorks Group, ${r.as_at}. Read only: nothing was changed while preparing this report.`,
    7,
  );

  // Page numbers.
  const pageCount: number = doc.getNumberOfPages();
  for (let page = 1; page <= pageCount; page++) {
    doc.setPage(page);
    font("normal", 7, MID);
    const pw = doc.internal.pageSize.getWidth();
    const ph = doc.internal.pageSize.getHeight();
    doc.text(
      reportPdfText(
        `SecureWorks Group  |  Debt and receivables ${r.today}  |  Page ${page} of ${pageCount}`,
      ),
      pw / 2,
      ph - 6,
      { align: "center" },
    );
  }

  const bytes = new Uint8Array(doc.output("arraybuffer") as ArrayBuffer);
  return { bytes, pageCount };
}
