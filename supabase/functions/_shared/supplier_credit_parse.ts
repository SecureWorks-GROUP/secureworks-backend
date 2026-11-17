// Pure document readers. Legacy invoice helpers keep their existing semantics.
function parseMoney(s: string | null | undefined): number | null {
  if (!s) return null;
  const n = Number(s.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

// Best-effort invoice-number extraction across the supplier classes we email with.
export function parseInvoiceNumber(text: string): string | null {
  const patterns = [
    /Tax\s+Invoice\s*(?:No\.?|Number|#)?\s*[:#]?\s*([A-Z0-9][A-Z0-9\-\/]{3,})/i,
    /Invoice\s*(?:No\.?|Number|#)\s*[:#]?\s*([A-Z0-9][A-Z0-9\-\/]{3,})/i,
    /\bINV[\-\s]?([A-Z0-9\-\/]{3,})/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[1].replace(/[.,;]+$/, "").toUpperCase();
  }
  return null;
}

// Amount extraction: prefer an explicit ex-GST subtotal; fall back to the
// GST-inclusive total (flagged separately so the caller knows which it got).
export function parseAmounts(
  text: string,
): { exGst: number | null; incGst: number | null } {
  const exMatch =
    text.match(/Sub[\s\-]?total\s*(?:\(ex[^)]*\))?\s*\$?\s*([\d,]+\.\d{2})/i) ||
    text.match(/Total\s*\(ex[^)]*\)\s*\$?\s*([\d,]+\.\d{2})/i);
  const incMatch = text.match(
    /Total\s*(?:\(inc[^)]*\)|Due|Amount)?\s*\$?\s*([\d,]+\.\d{2})/i,
  ) ||
    text.match(/Amount\s*Due\s*\$?\s*([\d,]+\.\d{2})/i);
  return { exGst: parseMoney(exMatch?.[1]), incGst: parseMoney(incMatch?.[1]) };
}

export interface ParsedSupplierCredit {
  credit_number: string;
  credit_date: string | null;
  amount_ex: number | null;
  amount_inc: number | null;
  names_bill_number: string | null;
}

function creditDate(text: string): string | null {
  // Inspect only the first date label, never skip an invalid date for a later one.
  const tail = text.match(/\bdate\b\s*[:.#]?\s*([^\n]*)/i)?.[1];
  if (!tail) return null;
  const numeric = tail.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/);
  const written = tail.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\b/);
  const months = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ];
  const parts = numeric ?? written;
  if (!parts) return null;
  const day = Number(parts[1]);
  const month = numeric
    ? Number(parts[2])
    : months.findIndex((name) =>
      parts[2].toLowerCase() === name ||
      parts[2].toLowerCase() === name.slice(0, 3)
    ) + 1;
  const year = Number(parts[3]);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  if (
    month < 1 || month > 12 || date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day
  ) return null;
  return `${parts[3]}-${String(month).padStart(2, "0")}-${
    String(day).padStart(2, "0")
  }`;
}

export function parseSupplierCredit(text: string): ParsedSupplierCredit | null {
  if (
    !/\b(?:credit\s+note|adjustment\s+note|credit\s+memo)\b/i.test(
      text.slice(0, 1500),
    )
  ) return null;
  const creditNumber = text.match(
    /\b(?:credit\s+note\s+(?:number|no)|credit\s+no|adjustment\s+note\s+no|document\s+no)\b\.?\s*[:#]?\s*([A-Z0-9][A-Z0-9/-]*)/i,
  )?.[1] ??
    text.match(/\bcredit\s+note\s+([A-Z0-9][A-Z0-9/-]*\d[A-Z0-9/-]*)\b/i)?.[1];
  // The bare CREDIT NOTE CN-... form is also a printed number (ticket example).
  if (!creditNumber) return null;
  const billNumber = text.match(
    /\b(?:original\s+invoice|against\s+invoice|invoice\s+(?:number|no)|re\s+invoice|applies\s+to)\b(?:\s+(?:number|no))?\.?\s*[:#]?\s*([A-Z0-9][A-Z0-9/-]*)/i,
  )?.[1] ?? null;
  // Credit-only normalization: the shared legacy invoice reader remains unchanged.
  const amountsText = text
    .replace(
      /\btotal\s+(inc(?:lusive)?|ex(?:clusive)?)\s+GST\b/gi,
      "Total ($1 GST)",
    )
    .replace(/(?:-\s*\$?\s*|\(\s*\$?\s*-?)(?=\d[\d,]*\.\d{2})/g, "");
  const amounts = parseAmounts(amountsText);
  const tax = amountsText.match(/\bGST\s*:?\s*\$?\s*([\d,]+\.\d{2})/i);
  const gst = parseMoney(tax?.[1]);
  const ex = amounts.exGst ??
    (amounts.incGst !== null && gst !== null && gst <= amounts.incGst
      ? Math.round((amounts.incGst - gst) * 100) / 100
      : null);
  return {
    credit_number: creditNumber,
    credit_date: creditDate(text),
    amount_ex: ex,
    amount_inc: amounts.incGst,
    names_bill_number: billNumber,
  };
}
