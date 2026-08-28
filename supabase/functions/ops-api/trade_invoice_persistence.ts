export type TradeInvoicePersistenceOps = {
  createInvoice: () => Promise<string>;
  insertLines: (invoiceId: string) => Promise<void>;
  deleteInvoice: (invoiceId: string) => Promise<void>;
  replacePriorDraft?: (
    priorDraftId: string,
    replacementId: string,
  ) => Promise<void>;
};

export function tradeInvoiceXeroIdempotencyKey(invoiceId: unknown): string {
  const normalized = String(invoiceId ?? "").trim();
  if (!normalized) {
    throw new Error("Trade invoice ID is required for Xero idempotency");
  }
  return `trade-inv-${normalized}`;
}

export function tradeInvoiceHasExternalXeroIdentity(value: unknown): boolean {
  const invoice = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
  return String(invoice.xero_bill_id ?? "").trim() !== "" ||
    String(invoice.xero_pushed_at ?? "").trim() !== "";
}

export async function replaceTradeInvoicePriorDraft(
  client: {
    rpc: (
      name: string,
      args: Record<string, unknown>,
    ) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
  },
  priorDraftId: string,
  replacementId: string,
  userId: string,
  assignmentIds: string[] = [],
): Promise<void> {
  const { data, error } = await client.rpc("replace_trade_invoice_draft_v1", {
    p_prior_draft_id: priorDraftId,
    p_replacement_id: replacementId,
    p_user_id: userId,
    p_assignment_ids: [...new Set(assignmentIds)],
  });
  if (error || String(data || "") !== replacementId) {
    throw new Error(
      "Failed to replace prior trade invoice draft: " +
        (error?.message || "replacement identity was not confirmed"),
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function cleanupFailedInvoice(
  ops: TradeInvoicePersistenceOps,
  invoiceId: string,
  failure: unknown,
): Promise<never> {
  try {
    await ops.deleteInvoice(invoiceId);
  } catch (cleanupError) {
    throw new Error(
      `${errorMessage(failure)}; replacement cleanup also failed: ${
        errorMessage(cleanupError)
      }`,
    );
  }
  throw failure;
}

export async function createTradeInvoiceBeforeExternalWrite(
  ops: TradeInvoicePersistenceOps,
): Promise<string> {
  const invoiceId = await ops.createInvoice();
  try {
    await ops.insertLines(invoiceId);
  } catch (error) {
    return cleanupFailedInvoice(ops, invoiceId, error);
  }
  return invoiceId;
}

export async function replaceTradeInvoiceDraftKeepingPrior(
  ops: TradeInvoicePersistenceOps,
  priorDraftId: string | null,
): Promise<string> {
  const replacementId = await createTradeInvoiceBeforeExternalWrite(ops);
  if (!priorDraftId) return replacementId;

  try {
    if (!ops.replacePriorDraft) {
      throw new Error(
        "Draft replacement requires a guarded replacement boundary",
      );
    }
    await ops.replacePriorDraft(priorDraftId, replacementId);
  } catch (error) {
    return cleanupFailedInvoice(ops, replacementId, error);
  }
  return replacementId;
}
