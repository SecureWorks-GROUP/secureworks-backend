// Trade invoice numbers: SW-INV-{initials}-{YYMMDD}-{seq} (6 Nov 2026).
//
// The sequence used to be the trade's invoice count plus one. A deleted row
// lowers the count, and two trades with the same initials share the prefix,
// so a number could repeat. The database now refuses a repeat
// (trade_invoices_invoice_number_key). This picks the first free number from
// the old starting point, so existing numbering carries on unchanged.

export class TradeInvoiceNumberError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export function tradeInvoiceInitials(name: unknown): string {
  const initials = String(name || "XX")
    .split(" ")
    .map((part) => part.charAt(0).toUpperCase())
    .join("")
    .slice(0, 3);
  return initials || "XX";
}

export function tradeInvoiceDay(now: Date = new Date()): string {
  return now.toISOString().slice(2, 10).replace(/-/g, "");
}

export function formatTradeInvoiceNumber(initials: string, day: string, seq: number): string {
  return `SW-INV-${initials}-${day}-${String(seq).padStart(3, "0")}`;
}

/** The first free number at or after the trade's count plus one (plus `skip`,
 * used after a collision at insert). A failed read of the taken numbers falls
 * back to the old count rule; the unique index still refuses a repeat. */
export async function nextTradeInvoiceNumber(
  client: any,
  input: { userId: string; initials: string; day: string; skip?: number },
): Promise<string> {
  const { count, error: countErr } = await client.from("trade_invoices")
    .select("id", { count: "exact", head: true })
    .eq("user_id", input.userId);
  if (countErr) {
    throw new TradeInvoiceNumberError("The next invoice number could not be worked out. Try again.");
  }
  let seq = (count || 0) + 1 + Math.max(0, input.skip ?? 0);
  const prefix = `SW-INV-${input.initials}-${input.day}-`;
  const { data: taken, error: takenErr } = await client.from("trade_invoices")
    .select("invoice_number")
    .like("invoice_number", `${prefix}%`);
  if (takenErr) return formatTradeInvoiceNumber(input.initials, input.day, seq);
  const used = new Set((taken || []).map((row: { invoice_number?: string | null }) => String(row.invoice_number || "")));
  while (used.has(formatTradeInvoiceNumber(input.initials, input.day, seq))) seq++;
  return formatTradeInvoiceNumber(input.initials, input.day, seq);
}

export const TRADE_INVOICE_NUMBER_INDEX = "trade_invoices_invoice_number_key";

/** A unique-number refusal from the database: the PostgREST error itself, or
 * an Error whose message carries it (the persist paths wrap the message). */
export function isTradeInvoiceNumberCollision(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown; details?: unknown } | null;
  const text = `${e?.message ?? ""} ${e?.details ?? ""}`;
  if (text.includes(TRADE_INVOICE_NUMBER_INDEX)) return true;
  return String(e?.code ?? "") === "23505" && text.includes("invoice_number");
}
