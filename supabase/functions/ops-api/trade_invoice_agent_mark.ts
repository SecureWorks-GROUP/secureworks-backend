// Agent mark on a trade invoice.
//
// Owner, 11 Nov 2026: an agent (for example Grokbot) may help draft a trade's
// weekly invoice, and the invoice must say so after it is sent.
//
// A running draft carries created_by_agent, agent_label and draft_origin
// (trade_invoice_running_draft.ts, 20261024120000). Submit does not edit that
// row: generate_trade_invoice inserts a NEW invoice row and the draft is
// replaced, so the three fields were lost at the moment the invoice became
// real. This module reads them off the draft before it is replaced and stamps
// them on the invoice that replaced it.
//
// A label only. It grants nothing: an agent still cannot submit
// (agent_draft_only), and only the trade's own login reaches
// generate_trade_invoice. Nothing here touches money, lines, status or Xero.
//
// Fail open and loud: a failed read or stamp must never block or undo a
// submitted invoice, so both return quietly and log one line. PostgREST
// returns errors rather than throwing, so every call reads { error }.

export interface TradeInvoiceAgentMark {
  created_by_agent: true;
  agent_label: string | null;
  draft_origin: "staff" | "agent" | "auto" | null;
}

const DRAFT_ORIGINS = new Set(["staff", "agent", "auto"]);

/** The mark a draft row carries, or null when no agent added lines to it. */
export function agentMarkFromDraftRow(
  row: Record<string, unknown> | null | undefined,
): TradeInvoiceAgentMark | null {
  if (!row || row.created_by_agent !== true) return null;
  const label = String(row.agent_label ?? "").replace(/\s+/g, " ").trim()
    .slice(0, 80);
  const origin = String(row.draft_origin ?? "");
  return {
    created_by_agent: true,
    agent_label: label || null,
    draft_origin: DRAFT_ORIGINS.has(origin)
      ? origin as TradeInvoiceAgentMark["draft_origin"]
      : null,
  };
}

/**
 * Read the mark off the draft about to be replaced. Call before the persist.
 * Null when there is no draft, the draft is not this trade's, no agent helped,
 * or the read failed.
 */
export async function readTradeInvoiceAgentMark(
  // deno-lint-ignore no-explicit-any
  client: any,
  draftId: string | null | undefined,
  userId: string,
): Promise<TradeInvoiceAgentMark | null> {
  if (!draftId || !userId) return null;
  try {
    const { data, error } = await client.from("trade_invoices")
      .select("id, created_by_agent, agent_label, draft_origin")
      .eq("id", draftId)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) {
      console.error(
        "[ops-api] trade_invoice_agent_mark_read_failed:",
        error.code || "unknown",
      );
      return null;
    }
    return agentMarkFromDraftRow(data);
  } catch (error) {
    console.error(
      "[ops-api] trade_invoice_agent_mark_read_threw:",
      error instanceof Error ? error.name : "unknown",
    );
    return null;
  }
}

/**
 * Stamp the mark on the invoice that replaced the draft. Call after the
 * persist. True when the row was stamped; false when there was nothing to
 * stamp or the write failed. Never throws.
 */
export async function stampTradeInvoiceAgentMark(
  // deno-lint-ignore no-explicit-any
  client: any,
  invoiceId: string | null | undefined,
  userId: string,
  mark: TradeInvoiceAgentMark | null | undefined,
): Promise<boolean> {
  if (!invoiceId || !userId || !mark || mark.created_by_agent !== true) {
    return false;
  }
  try {
    const { data, error } = await client.from("trade_invoices")
      .update({
        created_by_agent: true,
        agent_label: mark.agent_label,
        draft_origin: mark.draft_origin,
      })
      .eq("id", invoiceId)
      .eq("user_id", userId)
      .select("id")
      .maybeSingle();
    if (error || !data?.id) {
      console.error(
        "[ops-api] trade_invoice_agent_mark_stamp_failed:",
        error?.code || "no_row",
      );
      return false;
    }
    return true;
  } catch (error) {
    console.error(
      "[ops-api] trade_invoice_agent_mark_stamp_threw:",
      error instanceof Error ? error.name : "unknown",
    );
    return false;
  }
}
