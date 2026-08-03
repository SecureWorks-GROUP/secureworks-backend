// Deterministic identity correlation for the privileged intake-approval path.
// This runs at intake/source correlation time. Renderers must consume the typed
// result and must never recover a purchase order from a filename themselves.

import {
  builderInstructionKey,
  builderInstructionKeysForCard,
  extractBuilderWorkOrderIdentity,
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
    reason: "multiple_instruction_keys" | "typed_identity_not_persistable";
    instruction_keys: string[];
  };

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
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
  const instructionKeys = builderInstructionKeysForCard({
    requestingCompanySlug: input.requesting_company_slug,
    family: input.family,
    metadata: input.extraction,
    detailExternalRef: input.approved_external_ref,
    attachmentNames: input.attachment_names,
  });
  if (instructionKeys.length > 1) {
    return {
      action: "refuse",
      reason: "multiple_instruction_keys",
      instruction_keys: instructionKeys,
    };
  }

  const sourceIdentity = extractBuilderWorkOrderIdentity({
    externalRef: input.approved_external_ref,
    requestingCompanySlug: input.requesting_company_slug,
    attachmentNames: input.attachment_names,
  });
  const extraction = mergeBuilderWorkOrderIdentity(
    input.extraction,
    sourceIdentity,
  );
  const persistedKey = builderInstructionKey({
    builder_claim_ref: text(extraction.builder_claim_ref) || null,
    builder_work_order_number: text(extraction.builder_work_order_number) ||
      null,
    builder_po_number: text(extraction.builder_po_number) || null,
    evidence_sources: [],
  }, options);
  const instructionKey = instructionKeys[0] || persistedKey;
  if (instructionKey && persistedKey !== instructionKey) {
    return {
      action: "refuse",
      reason: "typed_identity_not_persistable",
      instruction_keys: instructionKeys,
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
