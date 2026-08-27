export type TradeInvoicePersistenceOps = {
  createInvoice: () => Promise<string>;
  insertLines: (invoiceId: string) => Promise<void>;
  deleteInvoice: (invoiceId: string) => Promise<void>;
};

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
    await ops.deleteInvoice(priorDraftId);
  } catch (error) {
    return cleanupFailedInvoice(ops, replacementId, error);
  }
  return replacementId;
}
