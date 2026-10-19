// deno-lint-ignore-file no-explicit-any
// W4 PREPARATION (Operations, 19 Oct 2026; DSP-T3, owner call W4-3 option C).
// Read-only rules, not wired into any route or money path.
//
// Question: which builder instruction is a trade's claim line on a builder
// job (make-safe, repair, restoration) billed under? On these jobs the
// approved instruction is the BUILDER'S work order / purchase order, held as a
// `job_documents` row of type `work_order` plus the job's stated references,
// never a `work_orders` row (job work orders are fencing and patio only). No
// table links a `trade_invoice_lines` row to it today (live 19 Oct: 0 of 657
// builder-job lines carry any work order id), so a claim cannot be checked
// against what the builder asked for.
//
// Rules held here, each from an existing ruling rather than a new one:
//   - An instruction is the canonical instruction key
//     (`builderInstructionKey`, captain 2026-08-02): builder scope plus
//     purchase order; AJ on its job number (AJ issues no purchase order);
//     repair on its work order. The job's instructions are the keys its own
//     DECLARED identity proves (`declaredBuilderInstructionKeysForCard`: the
//     typed metadata triple and the stored external reference, never file
//     names) plus every further order a repair landing listed
//     (`metadata.builder_additional_work_orders`), collapsed by
//     `distinctBuilderInstructionKeys`. A declared purchase order whose
//     builder scope cannot be told (no prefix, unknown company) is still an
//     instruction on its own job, kept as `UNSCOPED:PO-n`.
//   - A work order document belongs to an instruction only when the key read
//     from its file name is that instruction's key. MLB attaches every PDF of
//     a claim to every card, so a key read from a file name never creates an
//     instruction; it only attaches the PDF to one the job declared. Our own
//     `work-order-SWMS-*.pdf` never counts.
//   - Several instructions on one job: which governs is the owner's pending
//     decision ("which order governs" on the Repairs card), so the line is
//     `several_orders` with every candidate listed and none chosen. Array
//     order and dates never pick one: make-safe work often happens before the
//     order arrives, so a received date cannot exclude it.
//   - The line's assignment ids must be assignments on the line's own job.

import { isInsuranceRepairFamily } from "./insurance_repairs_board.ts";
import {
  builderInstructionKey,
  type BuilderInstructionKeyOptions,
  declaredBuilderInstructionKeysForCard,
  distinctBuilderInstructionKeys,
  extractBuilderWorkOrderIdentity,
} from "./makesafe_builder_work_order_identity.ts";

export const BUILDER_INSTRUCTION_LINK_SCHEMA = "builder-instruction-link.v2";

export interface BuilderInstructionJobInput {
  job: {
    id?: string | null;
    type?: string | null;
    metadata?: Record<string, any> | null;
  };
  makesafe_details?: {
    external_ref?: string | null;
    requesting_company_slug?: string | null;
    report_type?: string | null;
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
  // e.g. `MLB:PO-56236`, `AJ:JOB-70271`, `MLB:WO-24645`, `UNSCOPED:PO-20919`.
  key: string;
  purchase_order: string | null;
  received_at: string | null;
  source: "job_declared" | "additional_order";
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

function poOf(key: string): string | null {
  const match = key.match(/:PO-(\d+)$/);
  return match ? `PO-${match[1]}` : null;
}

// A key, or for a purchase order the grammar reads but no scope can be told
// for, the unscoped purchase-order key.
function keyFor(
  text: string | null,
  options: BuilderInstructionKeyOptions,
  attachment = false,
): string | null {
  if (!text) return null;
  const identity = extractBuilderWorkOrderIdentity(
    attachment
      ? {
        attachmentNames: [text],
        requestingCompanySlug: options.requestingCompanySlug,
      }
      : {
        externalRef: text,
        requestingCompanySlug: options.requestingCompanySlug,
      },
  );
  const key = builderInstructionKey(identity, options);
  if (key) return key;
  const po = String(identity.builder_po_number || "").match(/(\d{3,})$/);
  return po ? `UNSCOPED:PO-${po[1]}` : null;
}

function sameInstruction(a: string, b: string): boolean {
  if (a === b) return true;
  const pa = poOf(a);
  return pa !== null && pa === poOf(b) &&
    (a.startsWith("UNSCOPED:") || b.startsWith("UNSCOPED:"));
}

export function listBuilderInstructions(
  input: BuilderInstructionJobInput,
): BuilderInstructionSet {
  const meta = input.job?.metadata ?? {};
  const slug = input.makesafe_details?.requesting_company_slug ?? null;
  const repair = isInsuranceRepairFamily({
    ...input.job,
    makesafe_details: input.makesafe_details ?? null,
  });
  const options: BuilderInstructionKeyOptions = {
    requestingCompanySlug: slug,
    family: repair ? "repair" : (clean(meta.makesafe_job_family) ?? null),
  };
  const detailRef = clean(input.makesafe_details?.external_ref);

  const declared = declaredBuilderInstructionKeysForCard({
    requestingCompanySlug: slug,
    family: options.family,
    metadata: meta,
    detailExternalRef: detailRef,
  });
  if (declared.length === 0) {
    // Unscoped fallback: a declared purchase order with no readable scope.
    const structured = [
      meta.builder_work_order_number,
      meta.builder_claim_ref,
      meta.builder_po_number,
    ].filter(Boolean).join(" ");
    for (const text of [clean(structured), detailRef]) {
      const key = keyFor(text, options);
      if (key?.startsWith("UNSCOPED:") && !declared.includes(key)) {
        declared.push(key);
      }
    }
  }

  const additional: Array<{ key: string; received_at: string | null }> = [];
  for (
    const entry of Array.isArray(meta.builder_additional_work_orders)
      ? meta.builder_additional_work_orders
      : []
  ) {
    const text = [
      entry?.claim_ref,
      entry?.work_order_number,
      entry?.purchase_order,
    ]
      .map(clean).filter(Boolean).join(" ");
    const key = keyFor(text || null, options);
    if (key) additional.push({ key, received_at: clean(entry?.received_at) });
  }

  const all = [...declared, ...additional.map((a) => a.key)];
  const distinct = distinctBuilderInstructionKeys(all, all);
  const orders: BuilderInstruction[] = [];
  for (const key of distinct) {
    if (orders.some((o) => sameInstruction(o.key, key))) continue;
    const extra = additional.find((a) => a.key === key);
    orders.push({
      key,
      purchase_order: poOf(key),
      received_at: declared.includes(key) ? null : extra?.received_at ?? null,
      source: declared.includes(key) ? "job_declared" : "additional_order",
      document_ids: [],
    });
  }

  const unmatched: string[] = [];
  for (const doc of input.work_order_documents ?? []) {
    if (!clean(doc?.id)) continue;
    const key = keyFor(clean(doc.file_name), options, true);
    const order = key
      ? orders.find((o) => sameInstruction(o.key, key))
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
