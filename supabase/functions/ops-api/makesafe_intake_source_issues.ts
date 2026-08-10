// deno-lint-ignore-file no-explicit-any

export const INTAKE_SOURCE_ISSUE_REASONS = [
  "run_cap_deferred",
  "source_closure_cap",
  "pdf_extraction_cap",
  "pdf_extraction_pending",
  "pdf_attachment_limit",
  "lineage_quarantine",
  "awaiting_parent",
  "source_persist_failed",
  "attachment_recovery_failed",
  "legacy_draft_source_missing",
  "legacy_draft_attribution_ambiguous",
  "committed_without_site_suburb",
] as const;

export type IntakeSourceIssueReason =
  typeof INTAKE_SOURCE_ISSUE_REASONS[number];

const DEFERRED_REASONS = new Set<IntakeSourceIssueReason>([
  "run_cap_deferred",
  "source_closure_cap",
  "pdf_extraction_cap",
  "pdf_extraction_pending",
  "pdf_attachment_limit",
  "awaiting_parent",
  "attachment_recovery_failed",
]);

export const INTAKE_SOURCE_ISSUE_NEXT_ACTION: Readonly<
  Record<IntakeSourceIssueReason, string>
> = {
  run_cap_deferred: "retry_exact_source",
  source_closure_cap: "retry_exact_source_with_case_closure",
  pdf_extraction_cap: "retry_exact_source_pdf_priority",
  pdf_extraction_pending: "wait_for_pdf_belt_then_retry_exact_source",
  pdf_attachment_limit: "review_attachment_selection",
  lineage_quarantine: "correct_lineage_authority",
  awaiting_parent: "replay_parent_or_bind_exact_target",
  source_persist_failed: "investigate_source_persistence",
  attachment_recovery_failed: "recover_attachment_then_replay",
  legacy_draft_source_missing: "locate_or_import_exact_ses_source",
  legacy_draft_attribution_ambiguous: "human_resolve_exact_attribution",
  committed_without_site_suburb: "human_supply_site_suburb",
};

export function intakeSourceIssueChangeType(
  reason: IntakeSourceIssueReason,
):
  | `intake_deferred_${IntakeSourceIssueReason}`
  | `intake_exception_${IntakeSourceIssueReason}` {
  return `${
    DEFERRED_REASONS.has(reason) ? "intake_deferred" : "intake_exception"
  }_${reason}`;
}

export function parseIntakeSourceIssueReason(
  changeType: string | null | undefined,
): IntakeSourceIssueReason | null {
  const value = String(changeType || "");
  if (
    value === "scan_run_cap_deferred" ||
    value === "intake_deferred_scan_run_cap_deferred"
  ) return "run_cap_deferred";
  const reason = value.replace(/^intake_(?:deferred|exception)_/, "");
  return (INTAKE_SOURCE_ISSUE_REASONS as readonly string[]).includes(reason)
    ? reason as IntakeSourceIssueReason
    : null;
}

export interface PersistIntakeSourceIssueArgs {
  orgId: string;
  mailbox: string;
  postId: string;
  receivedAt?: string | null;
  conversationId?: string | null;
  threadId?: string | null;
  reason: IntakeSourceIssueReason;
  instructionKey?: string | null;
  caseId?: string | null;
  isolatedFailureCode?: string | null;
  attachmentIds?: readonly string[];
  attachmentNames?: readonly string[];
  attachmentCount?: number | null;
  syntheticLivefireMarker?: string | null;
}

/**
 * Writes one idempotent non-PII issue fact. A duplicate is success because the
 * migration's partial unique index makes first observation authoritative.
 */
export async function persistIntakeSourceIssue(
  client: any,
  args: PersistIntakeSourceIssueArgs,
): Promise<{ created: boolean; changeType: string }> {
  const changeType = intakeSourceIssueChangeType(args.reason);
  const { data: prior, error: priorError } = await client.from(
    "email_events_raw",
  )
    .select("change_type")
    .eq("org_id", args.orgId)
    .eq("post_id", args.postId);
  if (priorError) {
    throw new Error(
      `intake source issue preflight failed (${args.reason}): ${priorError.message}`,
    );
  }
  const existing = (prior || []).find((row: any) =>
    parseIntakeSourceIssueReason(row?.change_type) === args.reason
  );
  if (existing) {
    return { created: false, changeType: String(existing.change_type) };
  }
  const { error } = await client.from("email_events_raw").insert({
    org_id: args.orgId,
    mailbox: args.mailbox,
    post_id: args.postId,
    change_type: changeType,
    received_at: args.receivedAt ?? null,
    conversation_id: args.conversationId ?? null,
    thread_id: args.threadId ?? null,
    exclusion_reason: args.reason,
    page_meta: {
      source_fate: "open_source_issue",
      next_action_code: INTAKE_SOURCE_ISSUE_NEXT_ACTION[args.reason],
      instruction_key: args.instructionKey ?? null,
      case_id: args.caseId ?? null,
      isolated_failure_code: args.isolatedFailureCode ?? null,
      attachment_ids: [...(args.attachmentIds ?? [])],
      attachment_names: [...(args.attachmentNames ?? [])],
      attachment_count: args.attachmentCount ?? null,
      ...(args.syntheticLivefireMarker
        ? { synthetic_livefire_marker: args.syntheticLivefireMarker }
        : {}),
    },
  });
  if (error && error.code !== "23505") {
    throw new Error(
      `intake source issue persistence failed (${args.reason}): ${error.message}`,
    );
  }
  return { created: !error, changeType };
}
