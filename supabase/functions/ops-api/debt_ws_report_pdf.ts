// deno-lint-ignore-file no-explicit-any
// Debt Workshop: the debt report as a PDF (docs/debt-workshop/README.md, "The debt report").
//
// Drawn server side with jsPDF, the same import the purchase order PDF and the make-safe
// report use (dispatch_order_pdf.ts), from the report data in debt_ws_report.ts, so the PDF
// that is downloaded or emailed holds exactly the figures the Debt tab's report view shows.
//
// Layout: page 1 (portrait) is the summary: cash at bank, money in, debt expected, debt by
// category with the tie to Xero's total, by job type, who owes it, aging and the top 10
// debtors. Then landscape pages: the companies, every open invoice grouped worst first,
// and the key points and notes. Every page carries "Page x of n".

import {
  type DebtReport,
  pct,
  perthClock as clock,
  REPORT_BUCKETS,
  shortDate,
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
  doc.setProperties({ title: reportPdfText(`Debt position ${r.today}`) });

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
    doc.text(reportPdfText(`DEBT POSITION  ${r.as_at.toUpperCase()}`), M, M - 2);
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

  // ── Page 1: the band, the four headline figures and the summary tables ──
  doc.setFillColor(...DARK);
  doc.rect(0, 0, W(), 24, "F");
  doc.setFillColor(...ORANGE);
  doc.rect(0, 24, W(), 1.2, "F");
  font("bold", 9, [255, 255, 255]);
  doc.text("SECUREWORKS GROUP", M, 13.5);
  font("bold", 19, [255, 255, 255]);
  doc.text("Debt position", W() - M, 12.5, { align: "right" });
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
    }Debt worked out with the Debt tab's own rules, so every number here matches the tab.`,
    7.5,
  );

  const kpis: Array<[string, string, string, boolean]> = [
    [
      "Cash at bank (all accounts)",
      r.bank.status === "ok" ? money(r.bank.total) : "Not read",
      r.bank.status === "ok"
        ? `${money(r.bank.operations)} in Operations`
        : "Xero could not be read",
      false,
    ],
    [
      "Received, last 7 days",
      r.received.status === "ok" ? money(r.received.d7.amount) : "Not read",
      r.received.status === "ok"
        ? `${r.received.d7.count} payments; 30 days ${
          money(r.received.d30.amount)
        }`
        : "",
      false,
    ],
    [
      "Total owed to us",
      money(r.total_owed.amount),
      `${r.total_owed.count} invoices${
        r.xero_check && r.xero_check.status !== "not_checked"
          ? `; ${
            r.xero_check.status === "matches"
              ? "matches Xero"
              : "does not match Xero"
          }`
          : ""
      }`,
      false,
    ],
    [
      "Debt (past due, tab rules)",
      money(r.debt.amount),
      `${r.debt.count} invoices, ${
        pct(r.debt.amount, r.xero_open.amount) || "0%"
      } of open`,
      true,
    ],
  ];
  const gap = 3;
  const kw = (usable() - gap * 3) / 4;
  kpis.forEach(([label, value, sub, hot], i) => {
    const x = M + i * (kw + gap);
    doc.setFillColor(...(hot ? BLUSH : [252, 251, 250] as RGB));
    doc.rect(x, y, kw, 18, "F");
    doc.setDrawColor(...MIST);
    doc.setLineWidth(0.2);
    doc.rect(x, y, kw, 18);
    doc.setFillColor(...(hot ? ORANGE : BLUE));
    doc.rect(x, y, kw, 1.1, "F");
    font("normal", 6.3, MID);
    doc.text(reportPdfText(label.toUpperCase()), x + 2, y + 5);
    font("bold", 13, hot ? EMBER : BLUE);
    doc.text(reportPdfText(value), x + 2, y + 11.5);
    font("normal", 6.3, MID);
    doc.text(
      doc.splitTextToSize(reportPdfText(sub), kw - 4)[0] ?? "",
      x + 2,
      y + 15.8,
    );
  });
  y += 22;

  // Debt by category, with the tie to Xero.
  subheading("Every open Xero invoice, by the Debt tab's rules");
  const catRows: Row[] = REPORT_BUCKETS.filter((b) => b.debt).map((b) => ({
    cells: [
      `${b.name}  (${b.sub})`,
      String(r.buckets[b.key].count),
      money(r.buckets[b.key].amount),
    ],
  }));
  catRows.push({
    cells: ["Total debt", String(r.debt.count), money(r.debt.amount)],
    style: "sub",
  });
  catRows.push({ cells: ["Not counted as debt", "", ""], style: "group" });
  for (
    const b of REPORT_BUCKETS.filter((b) =>
      !b.debt &&
      (r.buckets[b.key].count ||
        ["not_due", "go_ahead", "needs_a_look", "not_chased"].includes(b.key))
    )
  ) {
    const sub = b.key === "not_chased" && r.not_chased_names.length
      ? r.not_chased_names.join(", ")
      : b.sub;
    catRows.push({
      cells: [
        `${b.name}  (${sub})`,
        String(r.buckets[b.key].count),
        money(r.buckets[b.key].amount),
      ],
    });
  }
  catRows.push({
    cells: [
      "Adds up to total owed to us",
      String(r.xero_open.count),
      money(r.tie.sum),
    ],
    style: "total",
  });
  catRows.push(
    r.tie.ok
      ? {
        cells: [
          `Check: ${money(r.tie.sum)} equals the total owed in our Xero copy, ${
            money(r.tie.xero)
          }, to the cent. Every invoice was placed.`,
        ],
        style: "ok",
      }
      : {
        cells: [
          `Check failed: the buckets add up to ${
            money(r.tie.sum)
          } but the total owed in our Xero copy is ${money(r.tie.xero)}.${
            r.tie.unplaced.length
              ? ` Not placed: ${r.tie.unplaced.join(", ")}.`
              : ""
          }`,
        ],
        style: "warn",
      },
  );
  // Whether our Xero copy matched Xero itself at the last hourly check.
  catRows.push({
    cells: [xeroCheckNote(r.xero_check)],
    style: r.xero_check?.status === "matches" ? "ok" : "warn",
  });
  table(
    [{ label: "Category", w: 70 }, { label: "No.", w: 10, align: "right" }, {
      label: "Amount",
      w: 20,
      align: "right",
    }],
    catRows,
  );

  subheading(`Where the cash is (Xero, ${shortDate(r.today)})`);
  if (r.bank.status === "ok") {
    const bankRows: Row[] = [];
    for (
      const g of [
        "Main trading account",
        "Provisions (set aside)",
        "Other accounts",
      ]
    ) {
      const accts = r.bank.accounts.filter((a) => a.group === g);
      if (!accts.length) continue;
      bankRows.push({ cells: [g, ""], style: "group" });
      for (const a of accts) {
        bankRows.push({ cells: [`   ${a.name}`, money(a.closing)] });
      }
    }
    bankRows.push({
      cells: ["Total cash at bank", money(r.bank.total)],
      style: "total",
    });
    bankRows.push({
      cells: [
        "Total less provisions",
        money(r.bank.total - r.bank.provisions),
      ],
      style: "muted",
    });
    table([{ label: "Account", w: 75 }, {
      label: "Balance",
      w: 25,
      align: "right",
    }], bankRows);
  } else {
    para(
      "Xero could not be read for the bank balances when this report was made.",
      8,
      RED,
    );
  }

  subheading("Money in (customer payments applied in Xero)");
  if (r.received.status === "ok") {
    const d7 = r.received.d7, d30 = r.received.d30;
    table(
      [{ label: "", w: 50 }, { label: "Last 7 days", w: 25, align: "right" }, {
        label: "Last 30 days",
        w: 25,
        align: "right",
      }],
      [
        {
          cells: ["Total received", money(d7.amount), money(d30.amount)],
          style: "total",
        },
        {
          cells: [
            "   Fencing and patio jobs",
            money(d7.fencing_patio),
            money(d30.fencing_patio),
          ],
        },
        {
          cells: ["   Insurance and other", money(d7.other), money(d30.other)],
        },
        {
          cells: [
            "   of which deposits and planning fees",
            money(d7.deposits),
            money(d30.deposits),
          ],
          style: "muted",
        },
        {
          cells: ["Payments", String(d7.count), String(d30.count)],
          style: "muted",
        },
      ],
    );
  } else {
    para("The payments received could not be read just now.", 8, RED);
  }

  subheading("Debt expected (not yet due, by the tab's due dates)");
  table(
    [{ label: "", w: 60 }, { label: "No.", w: 15, align: "right" }, {
      label: "Amount",
      w: 25,
      align: "right",
    }],
    [
      {
        cells: [
          "Due in the next 7 days",
          String(r.expected.d7.count),
          money(r.expected.d7.amount),
        ],
      },
      {
        cells: [
          "Due in the next 30 days",
          String(r.expected.d30.count),
          money(r.expected.d30.amount),
        ],
      },
    ],
  );

  subheading("Debt by job type, and who owes it");
  table(
    [{ label: "", w: 50 }, { label: "Debt", w: 25, align: "right" }, {
      label: "Not due",
      w: 25,
      align: "right",
    }],
    [
      ...r.by_type.map((t) => ({
        cells: [t.key, money(t.debt), money(t.not_due)],
      })),
      ...r.by_lane.map((t) => ({
        cells: [t.key, money(t.debt), money(t.not_due)],
        style: "muted" as RowStyle,
      })),
    ],
  );

  subheading("Aging of all open invoices (Xero due dates)");
  table(
    r.aging.map((a) => ({ label: a.key, w: 20, align: "right" as Align })),
    [{ cells: r.aging.map((a) => money(a.amount)) }],
  );

  subheading("Top 10 debtors (past due only)");
  table(
    [
      { label: "#", w: 4 },
      { label: "Who", w: 36 },
      { label: "Type", w: 12 },
      { label: "Worst category", w: 16 },
      { label: "Invoices", w: 9, align: "right" },
      { label: "Oldest (days)", w: 10, align: "right" },
      { label: "Amount", w: 13, align: "right" },
    ],
    r.top_debtors.length
      ? [
        ...r.top_debtors.map((d, i) => ({
          cells: [
            String(i + 1),
            d.name,
            d.lane === "account" ? "Company" : "Homeowner",
            d.worst,
            String(d.count),
            String(d.oldest),
            money(d.amount),
          ],
        })),
        {
          cells: [
            "",
            `Top 10 share of total debt: ${pct(r.top_total, r.debt.amount)}`,
            "",
            "",
            "",
            "",
            money(r.top_total),
          ],
          style: "sub" as RowStyle,
        },
      ]
      : [{ cells: ["Nothing is past due."], style: "ok" as RowStyle }],
  );

  // ── Companies (landscape) ──
  newPage("landscape");
  heading("Companies (insurance and builders)");
  para(
    "Grouped after the Debt tab's company aliases (one builder can sit on several Xero contacts). Company invoices are due 10 days after the invoice date; past due goes on the weekly statement.",
  );
  table(
    [
      { label: "Company", w: 18 },
      { label: "Xero contacts", w: 18 },
      { label: "Past due", w: 9, align: "right" },
      { label: "No.", w: 4, align: "right" },
      { label: "Oldest (days)", w: 7, align: "right" },
      { label: "Not yet due", w: 9, align: "right" },
      { label: "No.", w: 4, align: "right" },
      { label: "Next due", w: 8 },
      { label: "Total open", w: 9, align: "right" },
      { label: "This week's statement", w: 14 },
    ],
    r.companies.length
      ? r.companies.map((x) => ({
        cells: [
          x.name,
          x.contacts.join("; "),
          money(x.past.amount),
          String(x.past.count),
          x.past.count ? String(x.past.oldest) : "",
          money(x.grace.amount),
          String(x.grace.count),
          shortDate(x.grace.next_due),
          money(x.total),
          x.statement_words,
        ],
      }))
      : [{ cells: ["No open company invoices."], style: "ok" as RowStyle }],
    { size: 7.5 },
  );

  // ── Every open invoice ──
  heading("Every open invoice");
  para(
    `Grouped by the Debt tab's categories, worst first, then the open invoices that are not counted as debt, so the sections add up to the total owed to us, ${
      money(r.xero_open.amount)
    }.`,
  );
  const invCols: Col[] = [
    { label: "Payer", w: 19 },
    { label: "Job", w: 8 },
    { label: "Type", w: 8 },
    { label: "Invoice", w: 7 },
    { label: "Inv. date", w: 6.5 },
    { label: "Amount due", w: 8, align: "right" },
    { label: "Days", w: 4, align: "right" },
    { label: "Status and next step", w: 22 },
    { label: "Last chase", w: 17.5 },
  ];
  for (const s of r.sections) {
    sectionBar(s.title, money(s.total));
    if (s.note) para(s.note, 7);
    table(invCols, [
      ...s.rows.map((x) => ({
        cells: [
          x.payer,
          x.job_number ?? "",
          x.stage ? `${x.job_type} (${x.stage})` : x.job_type,
          x.invoice_number ?? "",
          shortDate(x.invoice_date),
          money(x.amount),
          String(x.days),
          x.next,
          x.chase,
        ],
      })),
      {
        cells: [
          `${s.rows.length} invoice${s.rows.length === 1 ? "" : "s"}`,
          "",
          "",
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

  // ── Key points and notes ──
  heading("Key points");
  for (const k of r.key_points) bullet(k);
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
        `SecureWorks Group  |  Debt position ${r.today}  |  Page ${page} of ${pageCount}`,
      ),
      pw / 2,
      ph - 6,
      { align: "center" },
    );
  }

  const bytes = new Uint8Array(doc.output("arraybuffer") as ArrayBuffer);
  return { bytes, pageCount };
}
