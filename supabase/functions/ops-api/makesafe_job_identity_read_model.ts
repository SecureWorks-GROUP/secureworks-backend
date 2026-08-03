import {
  builderInstructionKey,
} from "./makesafe_builder_work_order_identity.ts";

export const MAKESAFE_JOB_IDENTITY_CONTRACT = "makesafe-job-identity.v1";

export interface MakesafeJobIdentityReadModel {
  contract: typeof MAKESAFE_JOB_IDENTITY_CONTRACT;
  /** The builder work order / claim that groups related jobs. */
  work_order_number: string | null;
  /** The purchase order that identifies one job obligation. */
  purchase_order_number: string | null;
  job_grain_key: string | null;
  complete: boolean;
  authority: "intake_case" | "typed_job_metadata" | "none";
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Project only persisted typed identity. `builder_claim_ref` is the historical
 * storage name for the WO-only grouping value on MLB cards; the legacy
 * `builder_work_order_number` may contain WO+PO and is therefore not split or
 * parsed by this read model.
 */
export function projectMakesafeJobIdentity(input: {
  builder_claim_ref?: unknown;
  builder_work_order_number?: unknown;
  builder_po_number?: unknown;
  requesting_company_slug?: unknown;
  family?: unknown;
  authority: MakesafeJobIdentityReadModel["authority"];
}): MakesafeJobIdentityReadModel {
  const purchaseOrder = text(input.builder_po_number) || null;
  const workOrderGroup = text(input.builder_claim_ref) ||
    (!purchaseOrder ? text(input.builder_work_order_number) : "") || null;
  const key = builderInstructionKey({
    builder_claim_ref: workOrderGroup,
    builder_work_order_number: text(input.builder_work_order_number) ||
      workOrderGroup,
    builder_po_number: purchaseOrder,
    evidence_sources: [],
  }, {
    requestingCompanySlug: text(input.requesting_company_slug) || null,
    family: text(input.family) || null,
  });
  return {
    contract: MAKESAFE_JOB_IDENTITY_CONTRACT,
    work_order_number: workOrderGroup,
    purchase_order_number: purchaseOrder,
    job_grain_key: key,
    complete: Boolean(workOrderGroup && key),
    authority: workOrderGroup || purchaseOrder || key
      ? input.authority
      : "none",
  };
}
