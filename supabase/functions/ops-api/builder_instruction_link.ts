// deno-lint-ignore-file no-explicit-any
// W4 PREPARATION (Operations, 19 Oct 2026; DSP-T3, owner call W4-3 option C).
// Read-only rules, not wired into any route or money path.
//
// Question: which builder instruction is a trade's claim line on a builder
// job (make-safe, repair, restoration) billed under? On these jobs the
// approved instruction is the BUILDER'S work order / purchase order, held as a
// `job_documents` row of type `work_order` plus the job's stated references,
// never a `work_orders` row (job work orders are fencing and patio only). No
// table links a `trade_invoice_lines` row to it today (live 19 Oct: 0 of 649
// insurance lines carry any work order id), so a claim cannot be checked
// against what the builder asked for.
//
// Rules held here, each from an existing ruling rather than a new one:
//   - The orders on a job are its first order (`metadata.builder_po_number`,
//     else the PO the sealed grammar reads from `makesafe_job_details
//     .external_ref`) plus every further order a repair landing listed
//     (`metadata.builder_additional_work_orders`), in arrival order.
//   - A work order document belongs to an order only when the sealed grammar
//     (`extractBuilderWorkOrderIdentity`) reads that order's PO from the file
//     name. Self-generated `work-order-SWMS-*.pdf` files never count (the
//     grammar refuses them). A document naming no PO stays unmatched.
//   - Several orders on one job: which order governs is the owner's pending
//     decision (insurance_repairs_board.ts, "Repair Mints As A Real SWR- Job
//     Type"), so the line is `several_orders` with every candidate listed and
//     none chosen. Array order and dates never pick one: make-safe work often
//     happens before the order arrives, so a received date cannot exclude it.
//   - The line's assignment ids must be assignments on the line's own job.

import {
  extractBuilderWorkOrderIdentity,
  normaliseRef,
} from "./makesafe_builder_work_order_identity.ts";

export const BUILDER_INSTRUCTION_LINK_SCHEMA = "builder-instruction-link.v1";

export interface BuilderInstructionJobInput {
  job: {
    id?: string | null;
    metadata?: Record<string, any> | null;
  };
  makesafe_details?: {
    external_ref?: string | null;
    requesting_company_slug?: string | null;
  } | null;
  // job_documents rows of type `work_order` on the job.
  work_order_documents?:
    | Array<{
      id: string;
      file_name?: string | null;
      created_at?: string | null;
    }>
    | null;
}

export interface BuilderInstruction {
  purchase_order: string;
  work_order_number: string | null;
  claim_ref: string | null;
  received_at: string | null;
  source: "job_first_order" | "additional_order";
  document_ids: string[];
}

export interface BuilderInstructionSet {
  orders: BuilderInstruction[];
  unmatched_document_ids: string[];
}

function clean(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text === "" ? null : text;
}

// Comparison form of one purchase order. A stored value may be fused with its
// claim ("MLB-25147PO-56236"), so it is read through the sealed grammar first
// and only a value the grammar cannot split is compared as written.
function poKey(value: unknown): string {
  const text = clean(value);
  if (!text) return "";
  const read = extractBuilderWorkOrderIdentity({ externalRef: text } as any)
    .builder_po_number;
  return normaliseRef(read ?? text).replace(/^PO/, "");
}

function documentPoKey(
  fileName: string | null | undefined,
  companySlug: string | null | undefined,
): string {
  const name = clean(fileName);
  if (!name) return "";
  const identity = extractBuilderWorkOrderIdentity({
    attachmentNames: [name],
    requestingCompanySlug: companySlug ?? null,
  } as any);
  return poKey(identity.builder_po_number);
}

export function listBuilderInstructions(
  input: BuilderInstructionJobInput,
): BuilderInstructionSet {
  const meta = input.job?.metadata ?? {};
  const slug = input.makesafe_details?.requesting_company_slug ?? null;
  const fromRef = extractBuilderWorkOrderIdentity({
    externalRef: input.makesafe_details?.external_ref ?? null,
    requestingCompanySlug: slug,
  } as any);

  const orders: BuilderInstruction[] = [];
  const seen = new Set<string>();
  const push = (order: Omit<BuilderInstruction, "document_ids">) => {
    const key = poKey(order.purchase_order);
    if (!key || seen.has(key)) return;
    seen.add(key);
    orders.push({ ...order, document_ids: [] });
  };

  const firstPo = clean(meta.builder_po_number) ??
    clean(fromRef.builder_po_number);
  if (firstPo) {
    push({
      purchase_order: firstPo,
      work_order_number: clean(meta.builder_work_order_number) ??
        clean(fromRef.builder_work_order_number),
      claim_ref: clean(meta.builder_claim_ref) ??
        clean(fromRef.builder_claim_ref),
      received_at: null,
      source: "job_first_order",
    });
  }
  for (
    const entry of Array.isArray(meta.builder_additional_work_orders)
      ? meta.builder_additional_work_orders
      : []
  ) {
    const po = clean(entry?.purchase_order);
    if (!po) continue;
    push({
      purchase_order: po,
      work_order_number: clean(entry?.work_order_number),
      claim_ref: clean(entry?.claim_ref),
      received_at: clean(entry?.received_at),
      source: "additional_order",
    });
  }

  const unmatched: string[] = [];
  for (const doc of input.work_order_documents ?? []) {
    if (!clean(doc?.id)) continue;
    const key = documentPoKey(doc.file_name, slug);
    const order = key
      ? orders.find((o) => poKey(o.purchase_order) === key)
      : undefined;
    if (order) order.document_ids.push(doc.id);
    else unmatched.push(doc.id);
  }
  return { orders, unmatched_document_ids: unmatched };
}

export type BuilderInstructionLinkState =
  | "linked"
  | "several_orders"
  | "document_only"
  | "no_instruction"
  | "assignment_mismatch";

export interface BuilderInstructionLineInput {
  line: {
    job_id: string;
    assignment_ids?: string[] | null;
  };
  // job_assignments rows for every id on the line (any job).
  assignments?: Array<{ id: string; job_id: string | null }> | null;
}

export interface BuilderInstructionLink {
  schema: typeof BUILDER_INSTRUCTION_LINK_SCHEMA;
  state: BuilderInstructionLinkState;
  // Set only when state is `linked`.
  order: BuilderInstruction | null;
  candidates: BuilderInstruction[];
  unmatched_document_ids: string[];
  assignment_linked: boolean;
  foreign_assignment_ids: string[];
}

export function linkTradeLineToBuilderInstruction(
  input: BuilderInstructionLineInput,
  instructions: BuilderInstructionSet,
): BuilderInstructionLink {
  const ids = (input.line.assignment_ids ?? []).filter((id) => clean(id));
  const byId = new Map((input.assignments ?? []).map((a) => [a.id, a]));
  // An id we were not given a row for is unknown, and unknown is not proof it
  // is on this job, so it counts as foreign.
  const foreign = ids.filter((id) =>
    String(byId.get(id)?.job_id ?? "") !== input.line.job_id
  );
  const base = {
    schema: BUILDER_INSTRUCTION_LINK_SCHEMA,
    candidates: instructions.orders,
    unmatched_document_ids: instructions.unmatched_document_ids,
    assignment_linked: ids.length > 0 && foreign.length === 0,
    foreign_assignment_ids: foreign,
  } as const;
  if (foreign.length > 0) {
    return { ...base, state: "assignment_mismatch", order: null };
  }
  if (instructions.orders.length === 1) {
    return { ...base, state: "linked", order: instructions.orders[0] };
  }
  if (instructions.orders.length > 1) {
    return { ...base, state: "several_orders", order: null };
  }
  return {
    ...base,
    state: instructions.unmatched_document_ids.length > 0
      ? "document_only"
      : "no_instruction",
    order: null,
  };
}
