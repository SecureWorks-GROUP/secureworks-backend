/**
 * Build Pack continuation after SES trigger prepare.
 *
 * The trigger already persists a docket via prepare_ses_docket_revision.
 * Docs Ready still needs the canonical bind spine (report + invoice pointers,
 * SWMS when owed). This module plans that spine. It never sends, never
 * authorises, and never mints when an existing same-job invoice is present.
 *
 * Production apply is omitted: the plan parks as awaiting_pack until an
 * isolated fixture executor (tests) or a later named bind yes runs the
 * existing Build Pack doors. Isolated apply records pointer results only.
 */

export const SES_BUILD_PACK_CONTINUATION_VERSION = "ses.build-pack-continuation/v1";

export type SesRequiredDocumentsOwed = {
  report: boolean;
  invoice: boolean;
  swms: boolean;
};

export type SesPackPointerView = {
  job_id: string;
  job_number?: string | null;
  required_documents: SesRequiredDocumentsOwed;
  pack: {
    report_doc_id: string | null;
    invoice_doc_id: string | null;
    swms_doc_id: string | null;
    sent_at: string | null;
  };
  xero_binding?: {
    invoice_number?: string | null;
    status?: string | null;
    xero_invoice_id?: string | null;
  } | null;
  invoice?: {
    number?: string | null;
    status?: string | null;
    doc_id?: string | null;
  } | null;
};

export type SesRetainedArtifacts = {
  job_id: string;
  org_id?: string | null;
  report_doc_id?: string | null;
  invoice_number?: string | null;
  invoice_doc_id?: string | null;
  invoice_status?: string | null;
  pdf_sha256?: string | null;
  photo_count?: number;
  unsupported_family?: boolean;
  missing_photos?: boolean;
  tenant_ok?: boolean;
};

export type SesContinuationKind =
  | "already_sent"
  | "docs_ready_unsent"
  | "reuse_invoice_and_bind"
  | "bind_report"
  | "hold_missing_photos"
  | "hold_unsupported_family"
  | "refuse_cross_job"
  | "refuse_tenant"
  | "awaiting_pack";

export type SesContinuationPlan = {
  version: typeof SES_BUILD_PACK_CONTINUATION_VERSION;
  kind: SesContinuationKind;
  live_bind: false;
  live_mint: false;
  live_send: false;
  reuse_invoice_number: string | null;
  report_doc_id: string | null;
  invoice_doc_id: string | null;
  reason: string;
};

function owed(view: SesPackPointerView): SesRequiredDocumentsOwed {
  return {
    report: view.required_documents?.report !== false,
    invoice: view.required_documents?.invoice !== false,
    swms: view.required_documents?.swms === true,
  };
}

function pointersComplete(view: SesPackPointerView): boolean {
  const need = owed(view);
  if (need.report && !view.pack.report_doc_id) return false;
  if (need.invoice && !view.pack.invoice_doc_id) return false;
  if (need.swms && !view.pack.swms_doc_id) return false;
  return true;
}

function existingInvoiceNumber(
  view: SesPackPointerView,
  retained?: SesRetainedArtifacts | null,
): string | null {
  const fromView = String(
    view.invoice?.number || view.xero_binding?.invoice_number || "",
  ).trim();
  if (fromView) return fromView;
  const fromRetained = String(retained?.invoice_number || "").trim();
  return fromRetained || null;
}

export function planSesBuildPackContinuation(
  view: SesPackPointerView,
  retained?: SesRetainedArtifacts | null,
): SesContinuationPlan {
  const base: Omit<SesContinuationPlan, "kind" | "reason"> = {
    version: SES_BUILD_PACK_CONTINUATION_VERSION,
    live_bind: false,
    live_mint: false,
    live_send: false,
    reuse_invoice_number: null,
    report_doc_id: view.pack.report_doc_id,
    invoice_doc_id: view.pack.invoice_doc_id,
  };
  if (retained && retained.tenant_ok === false) {
    return {
      ...base,
      kind: "refuse_tenant",
      reason: "wrong organisation or tenant for this inspect",
    };
  }
  if (retained && retained.job_id !== view.job_id) {
    return {
      ...base,
      kind: "refuse_cross_job",
      reason: `retained artifacts belong to ${retained.job_id}, inspect is ${view.job_id}`,
    };
  }
  if (view.pack.sent_at) {
    return {
      ...base,
      kind: "already_sent",
      reason: "pack sent_at is set; continuation must not send or rebind",
    };
  }
  if (retained?.unsupported_family) {
    return {
      ...base,
      kind: "hold_unsupported_family",
      reason: "unsupported report family; hold with the named family, do not mint",
    };
  }
  if (retained?.missing_photos) {
    return {
      ...base,
      kind: "hold_missing_photos",
      reason: "photos incomplete; hold, do not mint or send",
    };
  }
  if (pointersComplete(view)) {
    return {
      ...base,
      kind: "docs_ready_unsent",
      reason: "report and invoice pointers present (SWMS when owed); unsent Docs Ready",
    };
  }
  const invoiceNumber = existingInvoiceNumber(view, retained);
  if (invoiceNumber && !view.pack.invoice_doc_id && owed(view).invoice) {
    return {
      ...base,
      kind: "reuse_invoice_and_bind",
      reuse_invoice_number: invoiceNumber,
      invoice_doc_id: retained?.invoice_doc_id || view.pack.invoice_doc_id,
      report_doc_id: view.pack.report_doc_id || retained?.report_doc_id || null,
      reason: `reuse existing ${invoiceNumber}; never mint a second invoice`,
    };
  }
  if (owed(view).report && !view.pack.report_doc_id && retained?.report_doc_id) {
    return {
      ...base,
      kind: "bind_report",
      report_doc_id: retained.report_doc_id,
      reason: "bind retained current-cycle report; attach is not bind",
    };
  }
  return {
    ...base,
    kind: "awaiting_pack",
    reason:
      "docket prepared; Build Pack bind spine still owed. Production must not auto-bind or mint.",
  };
}

export type IsolatedBindResult = {
  report_doc_id: string | null;
  invoice_doc_id: string | null;
  swms_doc_id: string | null;
  applied: string[];
};

/**
 * Isolated fixture apply only. Copies retained pointer ids onto the view.
 * Never calls Xero, attach, or send. Refuses if the plan is a live money/send
 * action or if artifacts belong to another job.
 */
export function applyIsolatedSesPackContinuation(
  view: SesPackPointerView,
  plan: SesContinuationPlan,
  retained: SesRetainedArtifacts,
): IsolatedBindResult {
  if (plan.live_bind || plan.live_mint || plan.live_send) {
    throw new Error("isolated continuation refuses live bind/mint/send");
  }
  if (retained.job_id !== view.job_id) {
    throw new Error("isolated continuation refuses cross-job artifacts");
  }
  const applied: string[] = [];
  let report = view.pack.report_doc_id;
  let invoice = view.pack.invoice_doc_id;
  const swms = view.pack.swms_doc_id;
  if (
    (plan.kind === "bind_report" || plan.kind === "reuse_invoice_and_bind") &&
    !report &&
    retained.report_doc_id
  ) {
    report = retained.report_doc_id;
    applied.push("bind_report:" + retained.report_doc_id);
  }
  if (plan.kind === "reuse_invoice_and_bind" && !invoice && retained.invoice_doc_id) {
    invoice = retained.invoice_doc_id;
    applied.push("reuse_invoice:" + (plan.reuse_invoice_number || retained.invoice_number));
  }
  return { report_doc_id: report, invoice_doc_id: invoice, swms_doc_id: swms, applied };
}

export function pointerViewAfterIsolatedApply(
  view: SesPackPointerView,
  applied: IsolatedBindResult,
): SesPackPointerView {
  return {
    ...view,
    pack: {
      ...view.pack,
      report_doc_id: applied.report_doc_id,
      invoice_doc_id: applied.invoice_doc_id,
      swms_doc_id: applied.swms_doc_id,
      sent_at: null,
    },
  };
}
