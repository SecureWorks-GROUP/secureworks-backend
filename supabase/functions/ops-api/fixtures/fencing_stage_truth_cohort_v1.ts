// Frozen fencing stage-truth fixtures v1.
//
// Represents the 38 active fencing jobs measured 2026-08-27 (fence-arch-b),
// plus 14 boundary/control rows and named perturbations. No client PII.
// Declared stages follow the live census split; evidence follows the
// measured coverage (22 paid deposits, 28 PO emails, assignment dates,
// zero active PO rows, zero start clocks, zero fencing service reports).
//
// `expected_canonical` is frozen independently of `declared_stage`. The
// harness fails if the real recipe disagrees, and fails if a named
// perturbation does not move the answer.

import type { FencingCanonicalStage } from "../fencing_stage_recipe_v1.ts";
import type { FencingExecutionEvidence } from "../fencing_stage_evidence.ts";

export const FENCING_STAGE_TRUTH_FIXTURE_VERSION =
  "fencing-stage-truth-fixtures/v1";

export const FENCING_STAGE_TRUTH_PINNED_NOW = "2026-08-27T00:00:00.000Z";

export interface FencingStageTruthFixture {
  id: string;
  job_number: string;
  declared_stage: string;
  expected_canonical: FencingCanonicalStage;
  evidence: FencingExecutionEvidence;
  group: string;
}

function job(
  n: number,
  declared: string,
  expected: FencingCanonicalStage,
  group: string,
  evidence: Partial<FencingExecutionEvidence> = {},
): FencingStageTruthFixture {
  const id = `fence-${String(n).padStart(3, "0")}`;
  return {
    id,
    job_number: `SWF-26${String(n).padStart(3, "0")}`,
    declared_stage: declared,
    expected_canonical: expected,
    group,
    evidence: {
      job_id: id,
      deposit_invoice_id: evidence.deposit_invoice_id ?? null,
      invoices: evidence.invoices ?? [],
      purchase_orders: evidence.purchase_orders ?? [],
      po_communications: evidence.po_communications ?? [],
      assignments: evidence.assignments ?? [],
      service_reports: evidence.service_reports ?? [],
      unreadable: evidence.unreadable ?? [],
    },
  };
}

function paidDeposit(
  jobId: string,
  invoiceId: string,
): Partial<FencingExecutionEvidence> {
  return {
    deposit_invoice_id: invoiceId,
    invoices: [{
      id: invoiceId,
      xero_invoice_id: invoiceId,
      status: "PAID",
      invoice_type: "ACCREC",
      reference: `${jobId}-DEP`,
      amount_paid: 1500,
      fully_paid_on: "2026-07-15",
    }],
  };
}

function issuedDeposit(
  jobId: string,
  invoiceId: string,
): Partial<FencingExecutionEvidence> {
  return {
    deposit_invoice_id: invoiceId,
    invoices: [{
      id: invoiceId,
      xero_invoice_id: invoiceId,
      status: "AUTHORISED",
      invoice_type: "ACCREC",
      reference: `${jobId}-DEP`,
      amount_paid: 0,
      fully_paid_on: null,
    }],
  };
}

function outboundPoEmail(
  id: string,
): NonNullable<FencingExecutionEvidence["po_communications"]> {
  return [{
    id,
    po_id: null,
    direction: "outbound",
    created_at: "2026-08-10T00:00:00.000Z",
    sent_at: "2026-08-10T00:00:00.000Z",
    received_at: null,
  }];
}

function datedAssignment(
  id: string,
  scheduledDate: string,
  extras: Partial<FencingExecutionEvidence["assignments"][number]> = {},
): NonNullable<FencingExecutionEvidence["assignments"]> {
  return [{
    id,
    status: extras.status ?? "scheduled",
    assignment_type: extras.assignment_type ?? "install",
    scheduled_date: scheduledDate,
    started_at: extras.started_at ?? null,
    completed_at: extras.completed_at ?? null,
  }];
}

function sentPo(
  id: string,
  status = "sent",
): NonNullable<FencingExecutionEvidence["purchase_orders"]> {
  return [{
    id,
    po_type: "material",
    status,
    xero_po_id: `xero-${id}`,
    confirmed_delivery_date: null,
    delivery_confirmed_at: null,
    delivery_date: null,
  }];
}

function merge(
  ...parts: Array<Partial<FencingExecutionEvidence>>
): Partial<FencingExecutionEvidence> {
  const out: Partial<FencingExecutionEvidence> = {};
  for (const part of parts) {
    if (part.deposit_invoice_id) {
      out.deposit_invoice_id = part.deposit_invoice_id;
    }
    if (part.invoices) {
      out.invoices = [...(out.invoices || []), ...part.invoices];
    }
    if (part.purchase_orders) {
      out.purchase_orders = [
        ...(out.purchase_orders || []),
        ...part.purchase_orders,
      ];
    }
    if (part.po_communications) {
      out.po_communications = [
        ...(out.po_communications || []),
        ...part.po_communications,
      ];
    }
    if (part.assignments) {
      out.assignments = [...(out.assignments || []), ...part.assignments];
    }
    if (part.service_reports) {
      out.service_reports = [
        ...(out.service_reports || []),
        ...part.service_reports,
      ];
    }
    if (part.unreadable) out.unreadable = part.unreadable;
  }
  return out;
}

const INSTALL_DATE = "2026-09-15";

function groupA(n: number, confirmed: boolean): FencingStageTruthFixture {
  const id = `fence-${String(n).padStart(3, "0")}`;
  return job(
    n,
    "scheduled",
    "decision_required",
    "group_a_deposit_email_assignment_no_confirm",
    merge(
      paidDeposit(id, `dep-${id}`),
      { po_communications: outboundPoEmail(`email-${id}`) },
      {
        assignments: datedAssignment(`asg-${id}`, INSTALL_DATE, {
          status: confirmed ? "confirmed" : "scheduled",
        }),
      },
    ),
  );
}

function groupC(n: number): FencingStageTruthFixture {
  const id = `fence-${String(n).padStart(3, "0")}`;
  return job(
    n,
    "rectification",
    "decision_required",
    "group_c_deposit_email_assignment_unpaid_final",
    merge(
      paidDeposit(id, `dep-${id}`),
      { po_communications: outboundPoEmail(`email-${id}`) },
      { assignments: datedAssignment(`asg-${id}`, INSTALL_DATE) },
      {
        invoices: [{
          id: `inv-${id}`,
          xero_invoice_id: `xero-inv-${id}`,
          status: "AUTHORISED",
          invoice_type: "ACCREC",
          reference: `${id}-FINAL`,
          amount_paid: 0,
          fully_paid_on: null,
        }],
      },
    ),
  );
}

/** 38 active fencing jobs. IDs fence-001 .. fence-038. */
export const FENCING_STAGE_TRUTH_COHORT: FencingStageTruthFixture[] = [
  job(1, "accepted", "unknown", "empty_claim"),
  job(2, "accepted", "unknown", "empty_claim"),
  job(
    3,
    "order_materials",
    "order_materials",
    "paid_deposit_only",
    paidDeposit("fence-003", "dep-fence-003"),
  ),
  job(
    4,
    "order_materials",
    "order_materials",
    "paid_deposit_only",
    paidDeposit("fence-004", "dep-fence-004"),
  ),
  job(
    5,
    "order_materials",
    "order_materials",
    "paid_deposit_only",
    paidDeposit("fence-005", "dep-fence-005"),
  ),
  job(6, "order_materials", "unknown", "empty_claim"),
  job(
    7,
    "awaiting_supplier",
    "order_materials",
    "paid_deposit_outbound_email",
    merge(
      paidDeposit("fence-007", "dep-fence-007"),
      { po_communications: outboundPoEmail("email-fence-007") },
    ),
  ),
  job(
    8,
    "awaiting_supplier",
    "order_materials",
    "paid_deposit_outbound_email",
    merge(
      paidDeposit("fence-008", "dep-fence-008"),
      { po_communications: outboundPoEmail("email-fence-008") },
    ),
  ),
  job(
    9,
    "awaiting_supplier",
    "order_materials",
    "paid_deposit_outbound_email",
    merge(
      paidDeposit("fence-009", "dep-fence-009"),
      { po_communications: outboundPoEmail("email-fence-009") },
    ),
  ),
  job(
    10,
    "schedule_install",
    "decision_required",
    "assignment_without_deposit",
    merge(
      { po_communications: outboundPoEmail("email-fence-010") },
      { assignments: datedAssignment("asg-fence-010", INSTALL_DATE) },
    ),
  ),
  job(
    11,
    "schedule_install",
    "decision_required",
    "assignment_without_deposit",
    { assignments: datedAssignment("asg-fence-011", INSTALL_DATE) },
  ),
  ...[12, 13, 14, 15, 16, 17, 18, 19].map((n) => groupA(n, true)),
  ...[20, 21, 22].map((n) => groupA(n, false)),
  job(
    23,
    "scheduled",
    "decision_required",
    "assignment_without_deposit",
    merge(
      { po_communications: outboundPoEmail("email-fence-023") },
      { assignments: datedAssignment("asg-fence-023", INSTALL_DATE) },
    ),
  ),
  job(
    24,
    "scheduled",
    "decision_required",
    "assignment_without_deposit",
    merge(
      { po_communications: outboundPoEmail("email-fence-024") },
      { assignments: datedAssignment("asg-fence-024", INSTALL_DATE) },
    ),
  ),
  job(
    25,
    "scheduled",
    "decision_required",
    "assignment_without_deposit",
    merge(
      { po_communications: outboundPoEmail("email-fence-025") },
      { assignments: datedAssignment("asg-fence-025", INSTALL_DATE) },
    ),
  ),
  job(
    26,
    "scheduled",
    "decision_required",
    "assignment_without_deposit",
    merge(
      { po_communications: outboundPoEmail("email-fence-026") },
      { assignments: datedAssignment("asg-fence-026", INSTALL_DATE) },
    ),
  ),
  job(
    27,
    "scheduled",
    "decision_required",
    "paid_final_without_deposit",
    merge(
      { po_communications: outboundPoEmail("email-fence-027") },
      { assignments: datedAssignment("asg-fence-027", INSTALL_DATE) },
      {
        invoices: [{
          id: "inv-fence-027",
          xero_invoice_id: "xero-inv-fence-027",
          status: "PAID",
          invoice_type: "ACCREC",
          reference: "fence-027-FINAL",
          amount_paid: 8800,
          fully_paid_on: "2026-08-20",
        }],
      },
    ),
  ),
  job(
    28,
    "scheduled",
    "decision_required",
    "paid_final_without_deposit",
    merge(
      { po_communications: outboundPoEmail("email-fence-028") },
      { assignments: datedAssignment("asg-fence-028", INSTALL_DATE) },
      {
        invoices: [{
          id: "inv-fence-028",
          xero_invoice_id: "xero-inv-fence-028",
          status: "PAID",
          invoice_type: "ACCREC",
          reference: "fence-028-FINAL",
          amount_paid: 9200,
          fully_paid_on: "2026-08-18",
        }],
      },
    ),
  ),
  job(29, "in_progress", "unknown", "empty_claim"),
  job(30, "in_progress", "unknown", "empty_claim"),
  job(31, "in_progress", "unknown", "empty_claim"),
  job(
    32,
    "in_progress",
    "decision_required",
    "assignment_without_deposit",
    merge(
      { po_communications: outboundPoEmail("email-fence-032") },
      {
        assignments: datedAssignment("asg-fence-032", INSTALL_DATE, {
          status: "in_progress",
        }),
      },
    ),
  ),
  job(
    33,
    "in_progress",
    "decision_required",
    "assignment_without_deposit",
    merge(
      { po_communications: outboundPoEmail("email-fence-033") },
      {
        assignments: datedAssignment("asg-fence-033", INSTALL_DATE, {
          status: "in_progress",
        }),
      },
    ),
  ),
  ...[34, 35, 36, 37, 38].map((n) => groupC(n)),
];

/**
 * 12 stage-boundary rows, one archive row, one decision_required row.
 * These carry the PO/clock facts the live 38-job cohort does not have,
 * so a critic can see every named bucket the recipe is willing to emit.
 */
export const FENCING_STAGE_TRUTH_BOUNDARY: FencingStageTruthFixture[] = [
  job(101, "quoted", "unknown", "boundary_quoted_empty"),
  job(
    102,
    "awaiting_deposit",
    "awaiting_deposit",
    "boundary_awaiting_deposit",
    issuedDeposit("fence-102", "dep-fence-102"),
  ),
  job(
    103,
    "order_materials",
    "order_materials",
    "boundary_order_materials",
    paidDeposit("fence-103", "dep-fence-103"),
  ),
  job(
    104,
    "awaiting_supplier",
    "awaiting_supplier",
    "boundary_awaiting_supplier_sent_po",
    merge(
      paidDeposit("fence-104", "dep-fence-104"),
      { purchase_orders: sentPo("po-fence-104", "sent") },
    ),
  ),
  job(
    105,
    "order_confirmed",
    "schedule_install",
    "boundary_schedule_install",
    merge(
      paidDeposit("fence-105", "dep-fence-105"),
      {
        purchase_orders: [{
          id: "po-fence-105",
          po_type: "material",
          status: "confirmed",
          xero_po_id: "xero-po-fence-105",
          confirmed_delivery_date: "2026-08-20",
          delivery_confirmed_at: null,
          delivery_date: "2026-08-20",
        }],
      },
    ),
  ),
  job(
    106,
    "scheduled",
    "scheduled",
    "boundary_scheduled",
    merge(
      paidDeposit("fence-106", "dep-fence-106"),
      {
        purchase_orders: [{
          id: "po-fence-106",
          po_type: "material",
          status: "confirmed",
          xero_po_id: "xero-po-fence-106",
          confirmed_delivery_date: "2026-08-20",
          delivery_confirmed_at: "2026-08-20T00:00:00.000Z",
          delivery_date: "2026-08-20",
        }],
      },
      {
        assignments: datedAssignment("asg-fence-106", "2026-09-15", {
          status: "confirmed",
        }),
      },
    ),
  ),
  job(
    107,
    "schedule_install",
    "scheduled",
    "boundary_scheduled_near_term",
    merge(
      paidDeposit("fence-107", "dep-fence-107"),
      {
        purchase_orders: [{
          id: "po-fence-107",
          po_type: "material",
          status: "confirmed",
          xero_po_id: "xero-po-fence-107",
          confirmed_delivery_date: "2026-08-26",
          delivery_confirmed_at: "2026-08-26T00:00:00.000Z",
          delivery_date: "2026-08-26",
        }],
      },
      {
        assignments: datedAssignment("asg-fence-107", "2026-08-28", {
          status: "confirmed",
        }),
      },
    ),
  ),
  job(
    108,
    "in_progress",
    "in_progress",
    "boundary_in_progress_clock",
    merge(
      paidDeposit("fence-108", "dep-fence-108"),
      {
        purchase_orders: [{
          id: "po-fence-108",
          po_type: "material",
          status: "delivered",
          xero_po_id: "xero-po-fence-108",
          confirmed_delivery_date: "2026-08-01",
          delivery_confirmed_at: "2026-08-01T00:00:00.000Z",
          delivery_date: "2026-08-01",
        }],
      },
      {
        assignments: datedAssignment("asg-fence-108", "2026-08-26", {
          status: "in_progress",
          started_at: "2026-08-26T08:00:00.000Z",
        }),
      },
    ),
  ),
  job(
    109,
    "complete",
    "complete",
    "boundary_complete_clock",
    merge(
      paidDeposit("fence-109", "dep-fence-109"),
      {
        purchase_orders: [{
          id: "po-fence-109",
          po_type: "material",
          status: "delivered",
          xero_po_id: "xero-po-fence-109",
          confirmed_delivery_date: "2026-08-01",
          delivery_confirmed_at: "2026-08-01T00:00:00.000Z",
          delivery_date: "2026-08-01",
        }],
      },
      {
        assignments: datedAssignment("asg-fence-109", "2026-08-20", {
          status: "complete",
          started_at: "2026-08-20T08:00:00.000Z",
          completed_at: "2026-08-20T16:00:00.000Z",
        }),
      },
    ),
  ),
  job(
    110,
    "final_payment",
    "final_payment",
    "boundary_final_payment",
    merge(
      paidDeposit("fence-110", "dep-fence-110"),
      {
        purchase_orders: [{
          id: "po-fence-110",
          po_type: "material",
          status: "billed",
          xero_po_id: "xero-po-fence-110",
          confirmed_delivery_date: "2026-07-01",
          delivery_confirmed_at: "2026-07-01T00:00:00.000Z",
          delivery_date: "2026-07-01",
        }],
      },
      {
        assignments: datedAssignment("asg-fence-110", "2026-08-10", {
          status: "complete",
          started_at: "2026-08-10T08:00:00.000Z",
          completed_at: "2026-08-10T16:00:00.000Z",
        }),
      },
      {
        invoices: [{
          id: "inv-fence-110",
          xero_invoice_id: "xero-inv-fence-110",
          status: "AUTHORISED",
          invoice_type: "ACCREC",
          reference: "fence-110-FINAL",
          amount_paid: 0,
          fully_paid_on: null,
        }],
      },
    ),
  ),
  job(
    111,
    "get_review",
    "get_review",
    "boundary_get_review",
    merge(
      paidDeposit("fence-111", "dep-fence-111"),
      {
        purchase_orders: [{
          id: "po-fence-111",
          po_type: "material",
          status: "billed",
          xero_po_id: "xero-po-fence-111",
          confirmed_delivery_date: "2026-07-01",
          delivery_confirmed_at: "2026-07-01T00:00:00.000Z",
          delivery_date: "2026-07-01",
        }],
      },
      {
        assignments: datedAssignment("asg-fence-111", "2026-08-22", {
          status: "complete",
          started_at: "2026-08-22T08:00:00.000Z",
          completed_at: "2026-08-22T16:00:00.000Z",
        }),
      },
      {
        invoices: [{
          id: "inv-fence-111",
          xero_invoice_id: "xero-inv-fence-111",
          status: "PAID",
          invoice_type: "ACCREC",
          reference: "fence-111-FINAL",
          amount_paid: 10000,
          fully_paid_on: "2026-08-23",
        }],
      },
    ),
  ),
  job(
    112,
    "rectification",
    "decision_required",
    "boundary_rectification_without_prefix",
    merge(
      paidDeposit("fence-112", "dep-fence-112"),
      { po_communications: outboundPoEmail("email-fence-112") },
      {
        assignments: datedAssignment("asg-fence-112", "2026-08-28", {
          status: "scheduled",
          assignment_type: "rectification",
        }),
      },
    ),
  ),
  job(
    113,
    "complete",
    "archived",
    "boundary_archive",
    merge(
      paidDeposit("fence-113", "dep-fence-113"),
      {
        purchase_orders: [{
          id: "po-fence-113",
          po_type: "material",
          status: "billed",
          xero_po_id: "xero-po-fence-113",
          confirmed_delivery_date: "2026-07-01",
          delivery_confirmed_at: "2026-07-01T00:00:00.000Z",
          delivery_date: "2026-07-01",
        }],
      },
      {
        assignments: datedAssignment("asg-fence-113", "2026-08-01", {
          status: "complete",
          started_at: "2026-08-01T08:00:00.000Z",
          completed_at: "2026-08-01T16:00:00.000Z",
        }),
      },
      {
        invoices: [{
          id: "inv-fence-113",
          xero_invoice_id: "xero-inv-fence-113",
          status: "PAID",
          invoice_type: "ACCREC",
          reference: "fence-113-FINAL",
          amount_paid: 10000,
          fully_paid_on: "2026-08-02",
        }],
      },
    ),
  ),
  job(
    114,
    "scheduled",
    "decision_required",
    "boundary_decision_required_skip",
    merge(
      paidDeposit("fence-114", "dep-fence-114"),
      { assignments: datedAssignment("asg-fence-114", INSTALL_DATE) },
    ),
  ),
];

export interface FencingStageTruthPerturbation {
  id: string;
  description: string;
  base_id: string;
  mutate: (evidence: FencingExecutionEvidence) => FencingExecutionEvidence;
  /** Canonical stage that must NOT survive the mutation. */
  must_not_remain: FencingCanonicalStage;
  expected_canonical: FencingCanonicalStage;
}

function cloneEvidence(
  evidence: FencingExecutionEvidence,
): FencingExecutionEvidence {
  return structuredClone(evidence);
}

export const FENCING_STAGE_TRUTH_PERTURBATIONS:
  FencingStageTruthPerturbation[] = [
    {
      id: "flip_sent_po_to_draft",
      description: "A draft PO must never classify as awaiting-supplier",
      base_id: "fence-104",
      mutate: (evidence) => {
        const next = cloneEvidence(evidence);
        next.purchase_orders = next.purchase_orders.map((po) => ({
          ...po,
          status: "draft",
        }));
        return next;
      },
      must_not_remain: "awaiting_supplier",
      expected_canonical: "order_materials",
    },
    {
      id: "remove_deposit_payment",
      description:
        "Removing deposit cash demotes order-materials, never stays later",
      base_id: "fence-103",
      mutate: (evidence) => {
        const next = cloneEvidence(evidence);
        next.invoices = next.invoices.map((invoice) => ({
          ...invoice,
          status: "AUTHORISED",
          amount_paid: 0,
          fully_paid_on: null,
        }));
        return next;
      },
      must_not_remain: "order_materials",
      expected_canonical: "awaiting_deposit",
    },
    {
      id: "blank_assignment_date",
      description: "Blanking the assignment date must require scheduling",
      base_id: "fence-106",
      mutate: (evidence) => {
        const next = cloneEvidence(evidence);
        next.assignments = next.assignments.map((row) => ({
          ...row,
          scheduled_date: null,
        }));
        return next;
      },
      must_not_remain: "scheduled",
      expected_canonical: "schedule_install",
    },
    {
      id: "echo_claimed_complete_on_empty",
      description:
        "Empty evidence with claimed complete must not echo the claim",
      base_id: "fence-029",
      mutate: (evidence) => cloneEvidence(evidence),
      must_not_remain: "in_progress",
      expected_canonical: "unknown",
    },
  ];

export const FENCING_STAGE_TRUTH_PLANTED_LIE = {
  id: "fence-003",
  false_expected: "scheduled" as FencingCanonicalStage,
  true_expected: "order_materials" as FencingCanonicalStage,
};

export const FENCING_STAGE_TRUTH_EMPTY_COMPLETE: FencingStageTruthFixture = job(
  200,
  "complete",
  "unknown",
  "claimed_complete_empty_evidence",
);
