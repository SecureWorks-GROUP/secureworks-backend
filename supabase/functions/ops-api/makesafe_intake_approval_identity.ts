// Deterministic identity correlation for the privileged intake-approval path.
// This runs at intake/source correlation time. Renderers must consume the typed
// result and must never recover a purchase order from a filename themselves.

import {
  applyParsedWorkOrderReferenceToExtraction,
  attachmentNameHasUnparseablePoLabel,
  builderIdentityTokensInAttachmentName,
  builderIdentityTokensInLabelledBody,
  builderInstructionKey,
  builderInstructionKeysForCard,
  type BuilderWorkOrderIdentity,
  declaredBuilderInstructionKeysForCard,
  distinctBuilderInstructionKeys,
  extractBuilderWorkOrderIdentity,
  hasUnparseablePoRemainder,
  isSelfGeneratedMakesafeWorkOrder,
  parseWorkOrderReferenceFromEvidence,
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

/** Identity sees every declared attachment; PDF servability is a later gate. */
export function intakeIdentityAttachmentNames(
  attachments: readonly unknown[],
): Array<string | null | undefined> {
  return (attachments || []).map((attachment) => {
    if (typeof attachment === "string") return attachment;
    if (!attachment || typeof attachment !== "object") return null;
    const item = attachment as Record<string, unknown>;
    return text(item.file_name) || text(item.filename) || text(item.name) ||
      null;
  });
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
  document_texts?: Array<string | null | undefined>;
}): {
  identity: BuilderWorkOrderIdentity;
  workOrders: string[];
  purchaseOrders: string[];
  unparseablePoPresent: boolean;
} {
  const attachmentNames = input.attachment_names.filter((name) =>
    name && !isSelfGeneratedMakesafeWorkOrder(name)
  );
  const documentTexts = (input.document_texts || []).filter((text) =>
    String(text || "").trim()
  );
  // Conservative multi-source parse: attachment names + labelled WO PDF/body
  // text + approved external_ref. First-match extraction is not used here —
  // a multi-candidate set or source disagreement writes nothing.
  const parsed = parseWorkOrderReferenceFromEvidence({
    attachmentNames,
    documentTexts,
    externalRef: input.approved_external_ref,
    requestingCompanySlug: input.requesting_company_slug,
  });
  const attachmentTokens = attachmentNames.map((name) =>
    builderIdentityTokensInAttachmentName(name)
  );
  const documentTokens = documentTexts.map((text) =>
    builderIdentityTokensInLabelledBody(text)
  );
  const workOrders = unique(
    [
      ...(parsed.action === "filled" && parsed.identity.builder_claim_ref
        ? [parsed.identity.builder_claim_ref]
        : []),
      ...attachmentTokens.flatMap((item) => item.builder_claim_refs),
      ...documentTokens.flatMap((item) => item.builder_claim_refs),
      ...builderIdentityTokensInAttachmentName(
        input.approved_external_ref,
      ).builder_claim_refs,
    ],
  );
  const purchaseOrders = unique(
    [
      ...(parsed.action === "filled" && parsed.identity.builder_po_number
        ? [parsed.identity.builder_po_number]
        : []),
      ...attachmentTokens.flatMap((item) => item.builder_po_numbers),
      ...documentTokens.flatMap((item) => item.builder_po_numbers),
      ...builderIdentityTokensInAttachmentName(
        input.approved_external_ref,
      ).builder_po_numbers,
    ],
  );
  // When the conservative parse refused, surface the multi-candidate sets so
  // the approval gate can 409 rather than mint with empty typed identity.
  return {
    identity: parsed.action === "filled" ? parsed.identity : {
      builder_claim_ref: null,
      builder_work_order_number: null,
      builder_po_number: null,
      evidence_sources: [],
    },
    workOrders,
    purchaseOrders,
    unparseablePoPresent: parsed.action === "empty" &&
        parsed.reason === "unparseable_po" ||
      hasUnparseablePoRemainder(String(input.approved_external_ref || "")) ||
      attachmentNames.some(attachmentNameHasUnparseablePoLabel),
  };
}

/**
 * Correlate authoritative attachment + work-order PDF identity into the typed
 * draft extraction before the approval gate and job mint consume it. The same
 * merged object is therefore used to reserve the PO-grain key and to persist
 * jobs.metadata via createMakesafeJob — never via update_job_field.
 *
 * Multiple source keys are a refusal. A single source key must be reproducible
 * from the merged typed fields; otherwise approval refuses instead of minting a
 * card whose only PO authority remains hidden in an attachment name or PDF body.
 */
export function correlateIntakeApprovalIdentity(input: {
  extraction: Record<string, unknown>;
  approved_external_ref: string | null;
  requesting_company_slug: string | null;
  family: string | null;
  attachment_names: Array<string | null | undefined>;
  /** Labelled WO PDF / body text already extracted for this draft. */
  document_texts?: Array<string | null | undefined>;
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
  // One instruction may legitimately be enumerated under both its PO-grain key
  // and its repair WO-fallback key (a work order carrying BOTH numbers, read
  // from sources of unequal completeness). Conflict decisions and the single
  // instruction key run on the distinct-instruction set; the WO fallback is
  // subsumed only by a PO this card DECLARES in the same scope, never by a PO
  // token observed on an attached filename or in ambient source text.
  const sortedInstructionKeys = distinctBuilderInstructionKeys(
    [...instructionKeys].sort(),
    declaredBuilderInstructionKeysForCard({
      requestingCompanySlug: input.requesting_company_slug,
      family: input.family,
      metadata: input.extraction,
      detailExternalRef: input.approved_external_ref,
    }),
  );
  if (
    input.attachment_names.length > 0 &&
    input.attachment_names.some((name) => !text(name))
  ) {
    return {
      action: "refuse",
      reason: "typed_identity_not_persistable",
      instruction_keys: sortedInstructionKeys,
    };
  }
  if (source.unparseablePoPresent) {
    return {
      action: "refuse",
      reason: "source_identity_conflict",
      instruction_keys: sortedInstructionKeys,
    };
  }
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
  // Conservative parse only: empty-on-ambiguity, fill empty typed slots only.
  // Never overwrites a human/prior value; never first-match guesses.
  const parse = parseWorkOrderReferenceFromEvidence({
    attachmentNames: input.attachment_names,
    documentTexts: input.document_texts,
    externalRef: input.approved_external_ref,
    requestingCompanySlug: input.requesting_company_slug,
  });
  const extraction = applyParsedWorkOrderReferenceToExtraction(
    input.extraction as Record<string, any>,
    parse,
  );
  const persistedKey = builderInstructionKey({
    builder_claim_ref: text(extraction.builder_claim_ref) || null,
    builder_work_order_number: text(extraction.builder_work_order_number) ||
      null,
    builder_po_number: text(extraction.builder_po_number) || null,
    evidence_sources: [],
  }, options);
  const instructionKey = sortedInstructionKeys[0] || persistedKey;
  if (
    ((source.purchaseOrders.length > 0 || typed.purchaseOrders.length > 0) &&
      !persistedKey) ||
    (instructionKey && persistedKey !== instructionKey)
  ) {
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
