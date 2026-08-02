// deno-lint-ignore-file no-explicit-any
import {
  builderInstructionKey,
  type BuilderWorkOrderIdentity,
  extractBuilderWorkOrderIdentity,
  isSelfGeneratedMakesafeWorkOrder,
} from "./makesafe_builder_work_order_identity.ts";

export type WorkOrderIdentityRefreshDecision =
  | {
    action: "none";
    reason: "self_generated" | "incoming_unreadable" | "already_current";
    incomingKey: string | null;
    currentKeys: string[];
    identity: BuilderWorkOrderIdentity | null;
  }
  | {
    action: "correct";
    reason: "missing_or_junk" | "internally_conflicting";
    incomingKey: string;
    currentKeys: string[];
    identity: BuilderWorkOrderIdentity;
  }
  | {
    action: "conflict";
    reason: "good_key_disagrees" | "unresolved_internal_conflict";
    incomingKey: string;
    currentKeys: string[];
    identity: BuilderWorkOrderIdentity;
  };

function identityForRef(
  value: unknown,
  requestingCompanySlug: string | null,
): BuilderWorkOrderIdentity {
  return extractBuilderWorkOrderIdentity({
    externalRef: String(value || ""),
    requestingCompanySlug,
  });
}

export function decideAttachedWorkOrderIdentityRefresh(input: {
  fileName: string;
  requestingCompanySlug: string | null;
  metadata?: Record<string, any> | null;
  detailExternalRef?: string | null;
}): WorkOrderIdentityRefreshDecision {
  if (isSelfGeneratedMakesafeWorkOrder(input.fileName)) {
    return {
      action: "none",
      reason: "self_generated",
      incomingKey: null,
      currentKeys: [],
      identity: null,
    };
  }

  const incomingIdentity = extractBuilderWorkOrderIdentity({
    requestingCompanySlug: input.requestingCompanySlug,
    attachmentNames: [input.fileName],
  });
  const incomingKey = builderInstructionKey(incomingIdentity);
  const metadata = input.metadata || {};
  const structured = [
    metadata.builder_work_order_number,
    metadata.builder_claim_ref,
    metadata.builder_po_number,
  ].filter(Boolean).join(" ");
  const currentKeys = Array.from(
    new Set(
      [structured, metadata.external_ref, input.detailExternalRef]
        .filter(Boolean)
        .map((value) =>
          builderInstructionKey(
            identityForRef(value, input.requestingCompanySlug),
          )
        )
        .filter((value): value is string => Boolean(value)),
    ),
  ).sort();

  if (!incomingKey) {
    return {
      action: "none",
      reason: "incoming_unreadable",
      incomingKey: null,
      currentKeys,
      identity: incomingIdentity,
    };
  }
  if (currentKeys.length === 0) {
    return {
      action: "correct",
      reason: "missing_or_junk",
      incomingKey,
      currentKeys,
      identity: incomingIdentity,
    };
  }
  if (currentKeys.length === 1 && currentKeys[0] === incomingKey) {
    return {
      action: "none",
      reason: "already_current",
      incomingKey,
      currentKeys,
      identity: incomingIdentity,
    };
  }
  if (currentKeys.length > 1 && currentKeys.includes(incomingKey)) {
    return {
      action: "correct",
      reason: "internally_conflicting",
      incomingKey,
      currentKeys,
      identity: incomingIdentity,
    };
  }
  return {
    action: "conflict",
    reason: currentKeys.length === 1
      ? "good_key_disagrees"
      : "unresolved_internal_conflict",
    incomingKey,
    currentKeys,
    identity: incomingIdentity,
  };
}

export async function refreshMakesafeIdentityAfterWorkOrderAttach(
  client: any,
  input: {
    jobId: string;
    documentId: string | null;
    fileName: string;
  },
): Promise<WorkOrderIdentityRefreshDecision | null> {
  if (isSelfGeneratedMakesafeWorkOrder(input.fileName)) return null;

  const { data: detail, error: detailError } = await client
    .from("makesafe_job_details")
    .select("external_ref,requesting_company_slug")
    .eq("job_id", input.jobId)
    .maybeSingle();
  if (detailError) {
    throw new Error(
      `work-order identity detail read failed: ${
        detailError.message || detailError
      }`,
    );
  }
  // Generic document uploads can target non-make-safe jobs. Only the make-safe
  // overlay is an instruction-card authority.
  if (!detail) return null;

  const { data: job, error: jobError } = await client
    .from("jobs")
    .select("id,metadata")
    .eq("id", input.jobId)
    .maybeSingle();
  if (jobError) {
    throw new Error(
      `work-order identity job read failed: ${jobError.message || jobError}`,
    );
  }
  if (!job) return null;

  const requestingCompanySlug = String(
    detail.requesting_company_slug || job.metadata?.requesting_company?.slug ||
      "",
  ).trim() || null;
  const decision = decideAttachedWorkOrderIdentityRefresh({
    fileName: input.fileName,
    requestingCompanySlug,
    metadata: job.metadata,
    detailExternalRef: detail.external_ref,
  });

  if (decision.action === "none") return decision;
  if (decision.action === "conflict") {
    const { error } = await client.from("job_events").insert({
      job_id: input.jobId,
      event_type: "makesafe_work_order_identity_conflict",
      detail_json: {
        document_id: input.documentId,
        incoming_instruction_key: decision.incomingKey,
        current_instruction_keys: decision.currentKeys,
        reason: decision.reason,
        identity_changed: false,
      },
    });
    if (error) {
      throw new Error(
        `work-order identity conflict event failed: ${error.message || error}`,
      );
    }
    return decision;
  }

  const externalRef = decision.identity.builder_work_order_number ||
    decision.identity.builder_claim_ref;
  const metadata = {
    ...(job.metadata || {}),
    external_ref: externalRef,
    builder_claim_ref: decision.identity.builder_claim_ref,
    builder_work_order_number: decision.identity.builder_work_order_number,
    builder_po_number: decision.identity.builder_po_number,
  };
  const { error: detailUpdateError } = await client
    .from("makesafe_job_details")
    .update({ external_ref: externalRef })
    .eq("job_id", input.jobId);
  if (detailUpdateError) {
    throw new Error(
      `work-order identity detail correction failed: ${
        detailUpdateError.message || detailUpdateError
      }`,
    );
  }
  const { error: jobUpdateError } = await client
    .from("jobs")
    .update({ metadata })
    .eq("id", input.jobId);
  if (jobUpdateError) {
    throw new Error(
      `work-order identity job correction failed: ${
        jobUpdateError.message || jobUpdateError
      }`,
    );
  }
  const { error: eventError } = await client.from("job_events").insert({
    job_id: input.jobId,
    event_type: "makesafe_work_order_identity_corrected",
    detail_json: {
      document_id: input.documentId,
      prior_instruction_keys: decision.currentKeys,
      corrected_instruction_key: decision.incomingKey,
      reason: decision.reason,
    },
  });
  if (eventError) {
    throw new Error(
      `work-order identity correction event failed: ${
        eventError.message || eventError
      }`,
    );
  }
  return decision;
}
