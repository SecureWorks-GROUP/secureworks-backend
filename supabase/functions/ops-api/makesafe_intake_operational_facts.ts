// deno-lint-ignore-file no-explicit-any

import {
  INTAKE_SOURCE_ISSUE_NEXT_ACTION,
  INTAKE_SOURCE_ISSUE_REASONS,
  type IntakeSourceIssueReason,
  parseIntakeSourceIssueReason,
} from "./makesafe_intake_source_issues.ts";

export interface IntakeOperationalSourceIssue {
  reason_code: IntakeSourceIssueReason;
  next_action_code: string;
  severity: "warning" | "critical";
}

export interface IntakeOperationalFact {
  item_id: `case:${string}` | `source:${string}`;
  source_instruction_id: string;
  source_received_at: string;
  age_seconds: number;
  case_id: string | null;
  instruction_key: string | null;
  lineage_id: string | null;
  parent_case_id: string | null;
  parent_relation:
    | "revision_of"
    | "duplicate_of"
    | "cancellation_of"
    | "sibling_of"
    | "reopen_of"
    | null;
  job_id: string | null;
  target_relation: "cancellation_of" | "revision_of" | "reopen_of" | null;
  target_job_id: string | null;
  fate:
    | "confirmed_live_job"
    | "blocked_live_job"
    | "reason_coded_exception"
    | "lineage_update"
    | "accounted_non_work"
    | "open_source_issue";
  reason_code: string | null;
  blocked_reasons: string[];
  cancellation_job_status: string | null;
  provenance_complete: boolean;
  attachment_issue_codes: string[];
  source_issues: IntakeOperationalSourceIssue[];
  next_action_code: string | null;
  severity: "info" | "warning" | "critical";
}

export interface IntakeCaseOperationalRow {
  id: string;
  instruction_key: string;
  lineage_id: string;
  parent_case_id: string | null;
  parent_relation: IntakeOperationalFact["parent_relation"];
  job_id: string | null;
  target_relation: IntakeOperationalFact["target_relation"];
  target_job_id: string | null;
  state:
    | "confirmed_live_job"
    | "blocked_live_job"
    | "exception"
    | "accounted_non_wo";
  reason_code: string | null;
  blocked_reasons: string[] | null;
  received_at: string;
  field_provenance?: Record<string, unknown> | null;
  source_count?: number;
  attachment_issue_codes?: string[];
}

export interface IntakeSourceIssueOperationalRow {
  post_id: string;
  change_type: string;
  exclusion_reason: string | null;
  received_at: string | null;
  observed_at: string;
  page_meta: Record<string, unknown> | null;
}

export interface LoadIntakeOperationalFactsOptions {
  orgId: string;
  mailbox?: string;
  nowIso?: string;
  pageSize?: number;
  recentFromIso?: string;
  recentToIso?: string;
}

const SES_MAILBOX = "ses@secureworkswa.com.au";

async function loadPagedRows(
  buildQuery: (from: number, to: number) => any,
  pageSize: number,
  label: string,
): Promise<any[]> {
  const rows: any[] = [];
  for (let from = 0;; from += pageSize) {
    const { data, error } = await buildQuery(from, from + pageSize - 1);
    if (error) {
      throw new Error(`${label} page read failed: ${error.message || error}`);
    }
    const page = data || [];
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

function issueReasonFromRow(
  row: IntakeSourceIssueOperationalRow,
): ReturnType<typeof parseIntakeSourceIssueReason> {
  return parseIntakeSourceIssueReason(row.change_type) ||
    parseIntakeSourceIssueReason(
      row.exclusion_reason ? `intake_exception_${row.exclusion_reason}` : null,
    );
}

function sourceIssueSeverity(
  row: IntakeSourceIssueOperationalRow,
): IntakeOperationalSourceIssue["severity"] {
  return row.change_type.startsWith("intake_deferred_") ||
      row.change_type === "scan_run_cap_deferred"
    ? "warning"
    : "critical";
}

function sourceIssuePriority(issue: IntakeOperationalSourceIssue): number {
  const severity = issue.severity === "critical" ? 0 : 1;
  const reason = INTAKE_SOURCE_ISSUE_REASONS.indexOf(issue.reason_code);
  return severity * INTAKE_SOURCE_ISSUE_REASONS.length +
    (reason < 0 ? INTAKE_SOURCE_ISSUE_REASONS.length : reason);
}

function aggregateSourceIssues(
  rows: readonly IntakeSourceIssueOperationalRow[],
): IntakeOperationalSourceIssue[] {
  const byReason = new Map<
    IntakeSourceIssueReason,
    IntakeOperationalSourceIssue
  >();
  for (const row of rows) {
    const reason = issueReasonFromRow(row);
    if (!reason) continue;
    const candidate: IntakeOperationalSourceIssue = {
      reason_code: reason,
      next_action_code: INTAKE_SOURCE_ISSUE_NEXT_ACTION[reason],
      severity: sourceIssueSeverity(row),
    };
    const current = byReason.get(reason);
    if (!current || candidate.severity === "critical") {
      byReason.set(reason, candidate);
    }
  }
  return [...byReason.values()].sort((left, right) =>
    sourceIssuePriority(left) - sourceIssuePriority(right) ||
    left.reason_code.localeCompare(right.reason_code)
  );
}

/**
 * Loads the complete U1 input for the island-2 projector. Every constituent
 * relation is paged to exhaustion; a failed page rejects the whole read rather
 * than returning a plausible-looking partial board.
 */
export async function loadIntakeOperationalFacts(
  client: any,
  options: LoadIntakeOperationalFactsOptions,
): Promise<IntakeOperationalFact[]> {
  const pageSize = Math.max(1, Math.min(options.pageSize ?? 500, 1000));
  const mailbox = (options.mailbox || SES_MAILBOX).toLowerCase();
  const nowIso = options.nowIso || new Date().toISOString();
  const recentFromIso = options.recentFromIso;
  const recentToIso = options.recentToIso;

  const [cases, sources, events] = await Promise.all([
    loadPagedRows(
      (from, to) =>
        (() => {
          let query = client.from("makesafe_intake_cases")
            .select(
              "id,instruction_key,lineage_id,parent_case_id,parent_relation,job_id,target_relation,target_job_id,state,reason_code,blocked_reasons,received_at,field_provenance",
            )
            .eq("org_id", options.orgId);
          if (recentFromIso) query = query.gte("received_at", recentFromIso);
          if (recentToIso) query = query.lte("received_at", recentToIso);
          return query.order("id", { ascending: true }).range(from, to);
        })(),
      pageSize,
      "intake cases",
    ),
    loadPagedRows(
      (from, to) => {
        let query = client.from("makesafe_intake_case_sources")
          .select("id,case_id,post_id")
          .eq("org_id", options.orgId);
        if (recentFromIso) query = query.gte("received_at", recentFromIso);
        if (recentToIso) query = query.lte("received_at", recentToIso);
        return query.order("id", { ascending: true }).range(from, to);
      },
      pageSize,
      "intake case sources",
    ),
    loadPagedRows(
      (from, to) =>
        (() => {
          let query = client.from("email_events_raw")
            .select(
              "id,post_id,change_type,exclusion_reason,received_at,observed_at,page_meta",
            )
            .eq("org_id", options.orgId)
            .eq("mailbox", mailbox);
          if (recentFromIso) query = query.gte("received_at", recentFromIso);
          if (recentToIso) query = query.lte("received_at", recentToIso);
          return query.order("id", { ascending: true }).range(from, to);
        })(),
      pageSize,
      "intake source events",
    ),
  ]);

  const eventPostIds = [...new Set(events.map((row) => String(row.post_id)))]
    .filter(Boolean);
  const exclusionPostIds: string[] = [];
  for (let offset = 0; offset < eventPostIds.length; offset += 25) {
    const { data, error } = await client.from("email_classifier_exclusions")
      .select("post_id")
      .eq("mailbox", mailbox)
      .in("post_id", eventPostIds.slice(offset, offset + 25));
    if (error) {
      throw new Error(
        `intake non-work exclusions read failed: ${error.message || error}`,
      );
    }
    exclusionPostIds.push(
      ...(data || []).map((row: any) => String(row.post_id)),
    );
  }

  const sourceIdsByCase = new Map<string, string[]>();
  for (const source of sources) {
    const current = sourceIdsByCase.get(String(source.case_id)) || [];
    current.push(String(source.post_id));
    sourceIdsByCase.set(String(source.case_id), current);
  }

  const issueRows = events.filter((event) => issueReasonFromRow(event));
  const issueRowsByPost = new Map<string, any[]>();
  for (const event of issueRows) {
    const postId = String(event.post_id);
    const current = issueRowsByPost.get(postId) || [];
    current.push(event);
    issueRowsByPost.set(postId, current);
  }
  const attachmentIssuesByCase = new Map<string, string[]>();
  for (const [caseId, postIds] of sourceIdsByCase) {
    const reasons = postIds.flatMap((postId) =>
      (issueRowsByPost.get(postId) || [])
        .map(issueReasonFromRow)
        .filter((reason): reason is NonNullable<typeof reason> => !!reason)
        .filter((reason) =>
          reason.startsWith("pdf_") ||
          reason === "attachment_recovery_failed"
        )
    );
    attachmentIssuesByCase.set(caseId, [...new Set(reasons)].sort());
  }

  const targetJobIds = [
    ...new Set(
      cases.map((row) => row.target_job_id).filter((id): id is string => !!id),
    ),
  ];
  const targetStatusById = new Map<string, string>();
  for (let offset = 0; offset < targetJobIds.length; offset += 25) {
    const ids = targetJobIds.slice(offset, offset + 25);
    const { data, error } = await client.from("jobs")
      .select("id,status")
      .in("id", ids);
    if (error) {
      throw new Error(
        `cancellation target status read failed: ${error.message || error}`,
      );
    }
    for (const job of data || []) {
      targetStatusById.set(String(job.id), String(job.status || ""));
    }
  }

  const facts = cases.map((row) =>
    buildCaseOperationalFact(
      {
        ...row,
        source_count: (sourceIdsByCase.get(String(row.id)) || []).length,
        attachment_issue_codes: attachmentIssuesByCase.get(String(row.id)) ||
          [],
      },
      row.target_job_id
        ? targetStatusById.get(String(row.target_job_id)) || null
        : null,
      nowIso,
    )
  );
  const excludedPosts = new Set(exclusionPostIds);
  for (
    const [postId, rows] of issueRowsByPost
  ) {
    if (!excludedPosts.has(postId)) {
      facts.push(buildSourceIssueOperationalFact(rows, nowIso));
    }
  }
  return facts.sort((a, b) =>
    a.source_received_at.localeCompare(b.source_received_at) ||
    a.item_id.localeCompare(b.item_id)
  );
}

function ageSeconds(at: string, nowIso: string): number {
  return Math.max(
    0,
    Math.floor((Date.parse(nowIso) - Date.parse(at)) / 1000),
  );
}

function nextActionForCase(row: IntakeCaseOperationalRow): string | null {
  if (row.state === "blocked_live_job") return "resolve_case_blockers";
  switch (row.reason_code) {
    case "cancellation_target_not_found":
      return "find_exact_cancellation_target";
    case "cancellation_target_ambiguous":
      return "human_select_exact_cancellation_target";
    case "cancellation_live_invoice_review":
      return "resolve_live_invoice_then_retry";
    case "cancellation_target_terminal_conflict":
      return "review_terminal_target_state";
    case "cancellation_apply_failed":
      return "retry_canonical_cancellation";
    case "unknown_builder":
      return "map_builder_profile";
    case "below_identity_floor":
      return "recover_strong_builder_identity";
    case "wo_ref_without_pdf_pending_review":
      return "review_maybe_box_create_job";
    case "adapter_parse_failure":
      return "recover_required_case_fields";
    case "conflicting_fields":
    case "ambiguous_scope":
      return "human_resolve_case_evidence";
    default:
      return null;
  }
}

export function buildCaseOperationalFact(
  row: IntakeCaseOperationalRow,
  targetJobStatus: string | null,
  nowIso: string,
): IntakeOperationalFact {
  const lineageUpdate = row.parent_relation !== null ||
    row.target_relation !== null;
  const fate: IntakeOperationalFact["fate"] = lineageUpdate
    ? "lineage_update"
    : row.state === "exception"
    ? "reason_coded_exception"
    : row.state === "accounted_non_wo"
    ? "accounted_non_work"
    : row.state;
  const nextAction = nextActionForCase(row);
  return {
    item_id: `case:${row.id}`,
    source_instruction_id: row.instruction_key,
    source_received_at: row.received_at,
    age_seconds: ageSeconds(row.received_at, nowIso),
    case_id: row.id,
    instruction_key: row.instruction_key,
    lineage_id: row.lineage_id,
    parent_case_id: row.parent_case_id,
    parent_relation: row.parent_relation,
    job_id: row.job_id,
    target_relation: row.target_relation,
    target_job_id: row.target_job_id,
    fate,
    reason_code: row.reason_code,
    blocked_reasons: [...(row.blocked_reasons ?? [])],
    cancellation_job_status: row.target_relation === "cancellation_of"
      ? targetJobStatus
      : null,
    provenance_complete: (row.source_count ?? 0) > 0 &&
      row.field_provenance !== null,
    attachment_issue_codes: [...(row.attachment_issue_codes ?? [])],
    source_issues: [],
    next_action_code: nextAction,
    severity: nextAction
      ? row.state === "blocked_live_job" ? "warning" : "critical"
      : "info",
  };
}

export function buildSourceIssueOperationalFact(
  rows: readonly IntakeSourceIssueOperationalRow[],
  nowIso: string,
): IntakeOperationalFact {
  const orderedRows = [...rows].sort((left, right) => {
    const leftAt = left.received_at || left.observed_at;
    const rightAt = right.received_at || right.observed_at;
    return leftAt.localeCompare(rightAt) ||
      left.change_type.localeCompare(right.change_type);
  });
  const first = orderedRows[0];
  const sourceIssues = aggregateSourceIssues(orderedRows);
  const primary = sourceIssues[0];
  if (!first || !primary) {
    throw new Error("unsupported empty intake source issue group");
  }
  const at = first.received_at || first.observed_at;
  const instructionKeys = [
    ...new Set(
      orderedRows.flatMap((row) =>
        typeof row.page_meta?.instruction_key === "string" &&
          row.page_meta.instruction_key.trim()
          ? [row.page_meta.instruction_key.trim()]
          : []
      ),
    ),
  ].sort();
  const instructionKey = instructionKeys.length === 1
    ? instructionKeys[0]
    : null;
  return {
    item_id: `source:${first.post_id}`,
    source_instruction_id: first.post_id,
    source_received_at: at,
    age_seconds: ageSeconds(at, nowIso),
    case_id: null,
    instruction_key: instructionKey,
    lineage_id: null,
    parent_case_id: null,
    parent_relation: null,
    job_id: null,
    target_relation: null,
    target_job_id: null,
    fate: "open_source_issue",
    reason_code: primary.reason_code,
    blocked_reasons: [],
    cancellation_job_status: null,
    provenance_complete: false,
    attachment_issue_codes: sourceIssues
      .map((issue) => issue.reason_code)
      .filter((reason) =>
        reason.startsWith("pdf_") || reason === "attachment_recovery_failed"
      ),
    source_issues: sourceIssues,
    next_action_code: primary.next_action_code,
    severity: primary.severity,
  };
}
