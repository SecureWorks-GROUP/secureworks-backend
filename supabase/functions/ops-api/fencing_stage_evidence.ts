// Fencing execution evidence adapter.
//
// Projects live table rows into the recipe input. Structurally omits the
// operator board claim, GHL stage, and the stage-entry clocks written by
// that same claim. `deposit_invoice_id` is a money identity pointer, not a
// stage claim.

import {
  FENCING_PO_CANCELLED_STATUS,
  FENCING_PO_DELETED_STATUS,
  isFencingAssignmentNonFieldWork,
  normalizeStatusToken,
  referenceLooksLikeDeposit,
} from "./fencing_stage_recipe_v1.ts";

export interface FencingInvoiceFact {
  id: string | null;
  xero_invoice_id: string | null;
  status: string | null;
  invoice_type: string | null;
  reference: string | null;
  amount_paid: number | null;
  fully_paid_on: string | null;
}

export interface FencingPoFact {
  id: string | null;
  po_type: string | null;
  status: string | null;
  xero_po_id: string | null;
  confirmed_delivery_date: string | null;
  delivery_confirmed_at: string | null;
  delivery_date: string | null;
}

export interface FencingPoCommFact {
  id: string | null;
  po_id: string | null;
  direction: string | null;
  created_at: string | null;
  sent_at: string | null;
  message_id?: string | null;
  received_at: string | null;
}

export interface FencingAssignmentFact {
  id: string | null;
  status: string | null;
  assignment_type: string | null;
  scheduled_date: string | null;
  started_at: string | null;
  completed_at: string | null;
  is_ghost: boolean | null;
  role: string | null;
}

export interface FencingServiceReportFact {
  id: string | null;
  status: string | null;
  submitted_at: string | null;
}

/**
 * Recipe input. Structurally omits the operator board claim and its
 * stage-entry clocks. Widening this type to take that claim is the
 * circularity the proof greps for.
 */
export interface FencingExecutionEvidence {
  job_id: string;
  deposit_invoice_id: string | null;
  invoices: FencingInvoiceFact[];
  purchase_orders: FencingPoFact[];
  po_communications: FencingPoCommFact[];
  assignments: FencingAssignmentFact[];
  service_reports: FencingServiceReportFact[];
  /** Named extra-read failures. Empty when every stage-truth join succeeded. */
  unreadable: string[];
}

export interface FencingStageEvidenceRef {
  kind:
    | "deposit_invoice"
    | "final_invoice"
    | "purchase_order"
    | "po_communication"
    | "assignment"
    | "service_report";
  id: string | null;
  status: string | null;
}

export interface FencingPipelineStageTruthRows {
  invoices: Array<Record<string, unknown>>;
  purchaseOrders: Array<Record<string, unknown>>;
  poCommunications: Array<Record<string, unknown>>;
  assignments: Array<Record<string, unknown>>;
  serviceReports: Array<Record<string, unknown>>;
  unreadable: string[];
}

function asText(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function asNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function projectInvoice(row: Record<string, unknown>): FencingInvoiceFact {
  return {
    id: asText(row.id),
    xero_invoice_id: asText(row.xero_invoice_id),
    status: asText(row.status),
    invoice_type: asText(row.invoice_type),
    reference: asText(row.reference),
    amount_paid: asNumber(row.amount_paid),
    fully_paid_on: asText(row.fully_paid_on),
  };
}

function projectPo(row: Record<string, unknown>): FencingPoFact {
  return {
    id: asText(row.id),
    po_type: asText(row.po_type),
    status: asText(row.status),
    xero_po_id: asText(row.xero_po_id),
    confirmed_delivery_date: asText(row.confirmed_delivery_date),
    delivery_confirmed_at: asText(row.delivery_confirmed_at),
    delivery_date: asText(row.delivery_date),
  };
}

function projectComm(row: Record<string, unknown>): FencingPoCommFact {
  return {
    id: asText(row.id),
    po_id: asText(row.po_id),
    direction: asText(row.direction),
    created_at: asText(row.created_at),
    sent_at: asText(row.sent_at),
    message_id: asText(row.message_id),
    received_at: asText(row.received_at),
  };
}

function projectAssignment(
  row: Record<string, unknown>,
): FencingAssignmentFact {
  return {
    id: asText(row.id),
    status: asText(row.status),
    assignment_type: asText(row.assignment_type),
    scheduled_date: asText(row.scheduled_date),
    started_at: asText(row.started_at),
    completed_at: asText(row.completed_at),
    is_ghost: row.is_ghost === true
      ? true
      : row.is_ghost === false
      ? false
      : null,
    role: asText(row.role),
  };
}

function projectReport(
  row: Record<string, unknown>,
): FencingServiceReportFact {
  return {
    id: asText(row.id),
    status: asText(row.status),
    submitted_at: asText(row.submitted_at),
  };
}

export function emptyFencingExecutionEvidence(
  jobId: string,
  depositInvoiceId: string | null = null,
): FencingExecutionEvidence {
  return {
    job_id: jobId,
    deposit_invoice_id: depositInvoiceId,
    invoices: [],
    purchase_orders: [],
    po_communications: [],
    assignments: [],
    service_reports: [],
    unreadable: [],
  };
}

export function fencingExecutionEvidenceFromPipelineRows(
  jobId: string,
  depositInvoiceId: string | null,
  rows: FencingPipelineStageTruthRows,
): FencingExecutionEvidence {
  const matchJob = (row: Record<string, unknown>) =>
    asText(row.job_id) === jobId;

  const purchaseOrders = rows.purchaseOrders
    .filter(matchJob)
    .map(projectPo)
    .filter((po) => normalizeStatusToken(po.po_type) === "material")
    .filter((po) => {
      const status = normalizeStatusToken(po.status);
      return status !== FENCING_PO_DELETED_STATUS &&
        status !== FENCING_PO_CANCELLED_STATUS;
    });

  const assignments = rows.assignments
    .filter(matchJob)
    .map(projectAssignment)
    .filter((assignment) => !isFencingAssignmentNonFieldWork(assignment));

  return {
    job_id: jobId,
    deposit_invoice_id: asText(depositInvoiceId),
    invoices: rows.invoices.filter(matchJob).map(projectInvoice),
    purchase_orders: purchaseOrders,
    po_communications: rows.poCommunications.filter(matchJob).map(projectComm),
    assignments,
    service_reports: rows.serviceReports.filter(matchJob).map(projectReport),
    unreadable: [...rows.unreadable].sort(),
  };
}

export function isDepositInvoiceFact(
  invoice: FencingInvoiceFact,
  depositInvoiceId: string | null,
): boolean {
  if (
    asText(invoice.invoice_type) &&
    String(invoice.invoice_type).toUpperCase() !== "ACCREC"
  ) {
    return false;
  }
  if (
    depositInvoiceId &&
    asText(invoice.xero_invoice_id) === asText(depositInvoiceId)
  ) {
    return true;
  }
  return referenceLooksLikeDeposit(invoice.reference);
}

export function isFinalInvoiceFact(
  invoice: FencingInvoiceFact,
  depositInvoiceId: string | null,
): boolean {
  if (
    asText(invoice.invoice_type) &&
    String(invoice.invoice_type).toUpperCase() !== "ACCREC"
  ) {
    return false;
  }
  return !isDepositInvoiceFact(invoice, depositInvoiceId);
}
