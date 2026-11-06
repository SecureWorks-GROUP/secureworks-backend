// One live no-week invoice per person per claim (B16, 6 Nov 2026).
//
// The one-per-week rule stops a weekly invoice being sent twice. An invoice
// with no week (a work-order or extras claim) had no such rule, so a double
// tap sent the same claim twice. A claim is a line's work order plus its line
// kind; a line naming no work order is not one. The database refuses a second live
// claim (trigger trg_trade_invoice_lines_no_week_claim_guard); this is the
// same rule read first, so the trade gets a plain answer before anything is
// saved. Group shares are one per person by their own rule; travel and
// deductions are not claims. Keep this key equal to
// trade_invoice_no_week_claim_key() in 20261106163712.

type Row = Record<string, any>;

export const NO_WEEK_CLAIM_REFUSAL = "no_week_claim_already_invoiced";
export const NO_WEEK_CLAIM_MESSAGE =
  "This work is already on one of your invoices that is still open, so it was not sent again. If something is missing, ask the office.";
const RELEASED = ["draft", "failed", "ops-reject"];

export function noWeekClaimKey(line: Row): string | null {
  if (!line?.source_work_order_id || line.group_share_id) return null;
  const kind = String(line.line_type ?? "").trim().toLowerCase();
  if (kind === "group share" || kind.includes("travel")) return null;
  if (!(Number(line.line_total_ex ?? 0) > 0)) return null;
  return `wo:${line.source_work_order_id}|${kind}`;
}

export type NoWeekClaimCheck =
  | { ok: true; conflict: null }
  | { ok: true; conflict: { invoice_id: string; invoice_number: string | null } }
  | { ok: false };

export async function findNoWeekClaimConflict(
  client: any,
  userId: string,
  lines: readonly Row[],
): Promise<NoWeekClaimCheck> {
  const keys = new Set(lines.map(noWeekClaimKey).filter((key): key is string => Boolean(key)));
  if (keys.size === 0) return { ok: true, conflict: null };
  const { data: invoices, error } = await client.from("trade_invoices")
    .select("id, invoice_number, status")
    .eq("user_id", userId)
    .is("week_start", null)
    .not("status", "in", `(${RELEASED.join(",")})`);
  if (error) return { ok: false };
  const live: Row[] = (invoices || []).filter((row: Row) => !RELEASED.includes(String(row.status || "")));
  if (live.length === 0) return { ok: true, conflict: null };
  const { data: existing, error: linesErr } = await client.from("trade_invoice_lines")
    .select("trade_invoice_id, job_id, line_type, line_total_ex, source_work_order_id, group_share_id")
    .in("trade_invoice_id", live.map((row) => row.id));
  if (linesErr) return { ok: false };
  for (const row of existing || []) {
    const key = noWeekClaimKey(row);
    if (key && keys.has(key)) {
      const invoice = live.find((inv) => inv.id === row.trade_invoice_id);
      return {
        ok: true,
        conflict: {
          invoice_id: String(row.trade_invoice_id),
          invoice_number: invoice?.invoice_number ?? null,
        },
      };
    }
  }
  return { ok: true, conflict: null };
}

export function isNoWeekClaimRefusal(error: unknown): boolean {
  const message = error instanceof Error
    ? error.message
    : String((error as { message?: unknown })?.message ?? error ?? "");
  return message.includes(NO_WEEK_CLAIM_REFUSAL);
}
