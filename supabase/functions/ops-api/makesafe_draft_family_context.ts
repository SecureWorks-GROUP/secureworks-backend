import type { MakeSafeJobFamilyContext } from "./makesafe_intake_gate.ts";
import { extractPdfDeclaredType } from "./makesafe_pdf_declared_type.ts";

export const PDF_EXTRACTION_PENDING_REASON = "pdf_extraction_pending";
export const MULTIPLE_WORK_ORDERS_REASON = "multiple_work_orders";

export interface DraftWorkOrderPdfDocument {
  status?: string | null;
  text?: string | null;
  reason?: string | null;
}

export class DraftFamilyContextRefusal extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "DraftFamilyContextRefusal";
  }
}

/**
 * Build the classifier context for a review/approve draft from its own work-order
 * PDF evidence. Classification is allowed only after exactly one work order has
 * extracted text. Pending text uses the deterministic lane's existing reason;
 * multiple work orders refuse because choosing either document would bind the
 * wrong declared-type header to a card.
 */
export function resolveDraftFamilyClassifierContext(input: {
  builder?: string | null;
  workOrderCount: number;
  pdfDocuments: readonly DraftWorkOrderPdfDocument[];
}): MakeSafeJobFamilyContext {
  if (input.workOrderCount > 1) {
    throw new DraftFamilyContextRefusal(MULTIPLE_WORK_ORDERS_REASON);
  }

  const extracted = input.pdfDocuments.filter((document) =>
    document?.status === "extracted" && !!String(document?.text || "").trim()
  );
  if (input.workOrderCount !== 1 || extracted.length !== 1) {
    const settledFailure = input.pdfDocuments.find((document) =>
      document?.status !== "extracted" &&
      document?.reason &&
      document.reason !== PDF_EXTRACTION_PENDING_REASON
    );
    throw new DraftFamilyContextRefusal(
      settledFailure?.reason || PDF_EXTRACTION_PENDING_REASON,
    );
  }

  return {
    builder: input.builder || null,
    pdfDeclaredType: extractPdfDeclaredType(extracted[0].text),
  };
}
