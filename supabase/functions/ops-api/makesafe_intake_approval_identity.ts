// Deterministic identity correlation for the privileged intake-approval path.
// This runs at intake/source correlation time. Renderers must consume the typed
// result and must never recover a purchase order from a filename themselves.

import {
  builderInstructionKey,
  builderInstructionKeysForCard,
  type BuilderWorkOrderIdentity,
  extractBuilderWorkOrderIdentity,
  isSelfGeneratedMakesafeWorkOrder,
  mergeBuilderWorkOrderIdentity,
} from "./makesafe_builder_work_order_identity.ts";

export type IntakeApprovalIdentityDecision =
  | {
    action: "ready";
    extraction: Record<string, unknown>;
    instruction_key: string | null;
    identity_completed: boolean;
  }
  | {
    action: "refuse";
    reason:
      | "multiple_instruction_keys"
      | "source_identity_conflict"
      | "typed_identity_not_persistable";
    instruction_keys: string[];
  };

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map(text).filter(Boolean))].sort();
}

function typedIdentity(extraction: Record<string, unknown>): {
  workOrders: string[];
  purchaseOrders: string[];
} {
  const identities = [
    extraction.external_ref,
    extraction.builder_claim_ref,
    extraction.builder_work_order_number,
    extraction.builder_po_number,
  ].map((value) =>
    extractBuilderWorkOrderIdentity({ externalRef: text(value) || null })
  );
  return {
    workOrders: unique(identities.map((item) => item.builder_claim_ref)),
    purchaseOrders: unique(identities.map((item) => item.builder_po_number)),
  };
}

function sourceIdentity(input: {
  approved_external_ref: string | null;
  requesting_company_slug: string | null;
  attachment_names: Array<string | null | undefined>;
}): {
  identity: BuilderWorkOrderIdentity;
  workOrders: string[];
  purchaseOrders: string[];
} {
  const identities = [
    extractBuilderWorkOrderIdentity({
      externalRef: input.approved_external_ref,
      requestingCompanySlug: input.requesting_company_slug,
    }),
    ...input.attachment_names
      .filter((name) => name && !isSelfGeneratedMakesafeWorkOrder(name))
      .map((name) =>
        extractBuilderWorkOrderIdentity({
          requestingCompanySlug: input.requesting_company_slug,
          attachmentNames: [name],
        })
      ),
  ];
  const workOrders = unique(
    identities.map((item) => item.builder_claim_ref),
  );
  const purchaseOrders = unique(
    identities.map((item) => item.builder_po_number),
  );
  const workOrderNumber =
    identities.find((item) =>
      item.builder_work_order_number &&
      (!workOrders[0] || item.builder_claim_ref === workOrders[0]) &&
      (!purchaseOrders[0] || item.builder_po_number === purchaseOrders[0])
    )?.builder_work_order_number || null;
  return {
    identity: {
      builder_claim_ref: workOrders[0] || null,
      builder_work_order_number: workOrderNumber,
      builder_po_number: purchaseOrders[0] || null,
      evidence_sources: unique(
        identities.flatMap((item) => item.evidence_sources),
      ),
    },
    workOrders,
    purchaseOrders,
  };
}

/**
 * Correlate authoritative attachment identity into the typed draft extraction
 * before the approval gate and job mint consume it. The same merged object is
 * therefore used to reserve the PO-grain key and to persist jobs.metadata.
 *
 * Multiple source keys are a refusal. A single source key must be reproducible
 * from the merged typed fields; otherwise approval refuses instead of minting a
 * card whose only PO authority remains hidden in an attachment name.
 */
export function correlateIntakeApprovalIdentity(input: {
  extraction: Record<string, unknown>;
  approved_external_ref: string | null;
  requesting_company_slug: string | null;
  family: string | null;
  attachment_names: Array<string | null | undefined>;
}): IntakeApprovalIdentityDecision {
  const options = {
    requestingCompanySlug: input.requesting_company_slug,
    family: input.family,
  };
  const source = sourceIdentity(input);
  const typed = typedIdentity(input.extraction);
  const instructionKeys = new Set(builderInstructionKeysForCard({
    requestingCompanySlug: input.requesting_company_slug,
    family: input.family,
    metadata: input.extraction,
    detailExternalRef: input.approved_external_ref,
    attachmentNames: input.attachment_names,
  }));
  for (const purchaseOrder of source.purchaseOrders) {
    for (const workOrder of source.workOrders) {
      const key = builderInstructionKey({
        builder_claim_ref: workOrder,
        builder_work_order_number: null,
        builder_po_number: purchaseOrder,
        evidence_sources: [],
      }, options);
      if (key) instructionKeys.add(key);
    }
  }
  const sortedInstructionKeys = [...instructionKeys].sort();
  if (source.workOrders.length > 1 || source.purchaseOrders.length > 1) {
    return {
      action: "refuse",
      reason: sortedInstructionKeys.length > 1
        ? "multiple_instruction_keys"
        : "source_identity_conflict",
      instruction_keys: sortedInstructionKeys,
    };
  }
  if (
    typed.workOrders.length > 1 || typed.purchaseOrders.length > 1 ||
    (source.workOrders[0] && typed.workOrders[0] &&
      source.workOrders[0] !== typed.workOrders[0]) ||
    (source.purchaseOrders[0] && typed.purchaseOrders[0] &&
      source.purchaseOrders[0] !== typed.purchaseOrders[0])
  ) {
    return {
      action: "refuse",
      reason: "typed_identity_not_persistable",
      instruction_keys: sortedInstructionKeys,
    };
  }
  if (sortedInstructionKeys.length > 1) {
    return {
      action: "refuse",
      reason: "multiple_instruction_keys",
      instruction_keys: sortedInstructionKeys,
    };
  }
  const extraction = mergeBuilderWorkOrderIdentity(
    input.extraction,
    source.identity,
  );
  const persistedKey = builderInstructionKey({
    builder_claim_ref: text(extraction.builder_claim_ref) || null,
    builder_work_order_number: text(extraction.builder_work_order_number) ||
      null,
    builder_po_number: text(extraction.builder_po_number) || null,
    evidence_sources: [],
  }, options);
  const instructionKey = sortedInstructionKeys[0] || persistedKey;
  if (instructionKey && persistedKey !== instructionKey) {
    return {
      action: "refuse",
      reason: "typed_identity_not_persistable",
      instruction_keys: sortedInstructionKeys,
    };
  }

  return {
    action: "ready",
    extraction,
    instruction_key: instructionKey || null,
    identity_completed: Boolean(
      !text(input.extraction.builder_po_number) &&
        text(extraction.builder_po_number),
    ),
  };
}
