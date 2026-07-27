import {
  invoiceLinkRequiredRefusal,
  sealedSesMoneyRefusal,
} from "../_shared/sealed_ses_money_fence.ts";

export function validateBrandedInvoiceDeliveryBinding(
  invoiceRecord: {
    invoice_type?: string | null;
    job_id?: string | null;
    invoice_obligation_revision_id?: string | null;
    ses_external_token?: string | null;
  },
  callerJobId: string,
  xeroInvoiceId: string,
):
  | { allowed: true; job_id: string }
  | {
    allowed: false;
    status: 409;
    refusal:
      | ReturnType<typeof sealedSesMoneyRefusal>
      | ReturnType<typeof invoiceLinkRequiredRefusal>;
  } {
  if (
    invoiceRecord.invoice_obligation_revision_id ||
    invoiceRecord.ses_external_token
  ) {
    return {
      allowed: false,
      status: 409,
      refusal: sealedSesMoneyRefusal("send-quote/send-invoice", {
        job_id: invoiceRecord.job_id || null,
        invoice_obligation_revision_id:
          invoiceRecord.invoice_obligation_revision_id || null,
        has_ses_external_token: !!invoiceRecord.ses_external_token,
      }),
    };
  }
  if (!invoiceRecord.job_id || invoiceRecord.job_id !== callerJobId) {
    return {
      allowed: false,
      status: 409,
      refusal: invoiceLinkRequiredRefusal("send-quote/send-invoice", {
        xero_invoice_id: xeroInvoiceId,
        caller_job_id: callerJobId,
        invoice_job_id: invoiceRecord.job_id || null,
      }),
    };
  }
  return { allowed: true, job_id: invoiceRecord.job_id };
}
