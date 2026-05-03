// T7 Loop 4 — MCP / JARVIS tool-call audit helper
//
// Roadmap: cio/operations/2026-05-02-t7-evidence-capture-spine-roadmap.md (Section 7 audit)
// Closes: T5-DEVQ-7 partial (agent_audit_log table existed in code references but had no migration)
//
// Single helper for every MCP / JARVIS tool call. Two writes:
//
//   1. agent_audit_log row — full payload, indexed by tool_name + verdict + job_id.
//   2. business_events row via recordEvidence — channel='audit', direction='system',
//      bypass_feature_flag: true (audit logging is structurally always-on).
//
// The bypass means audit rows land even when evidence_capture_v1 is OFF.
// This is correct: an audit gap during the rollout window would be worse
// than the rollout itself.
//
// Wired into ghl-proxy / mcp-server / sw_send_* tools by:
//   await recordMcpAudit(client, {
//     tool_name: 'sw_send_sms',
//     verdict: 'executed',
//     job_id: 'SWP-26090',
//     request_summary: 'sms to client SWP-26090: "we will be there at 2pm"',
//     response_summary: 'message_id=abc123',
//     request_payload: { contactId, message },
//     response_payload: result,
//     caller: 'jarvis',
//     model: 'claude-haiku-4-5',
//   });

import { recordEvidence } from "./record_evidence.ts";

export type AuditVerdict =
  | "approved"
  | "rejected"
  | "gated"
  | "executed"
  | "dry_run"
  | "error";

export interface RecordMcpAuditInput {
  tool_name: string;
  tool_version?: string;
  caller?: "jarvis" | "human" | "cron" | "system";
  caller_user_id?: string;
  caller_chat_id?: string;
  job_id?: string | null;
  contact_id?: string | null;
  correlation_id?: string;
  verdict: AuditVerdict;
  policy_reason?: string;
  request_summary?: string;          // ≤500c redacted
  response_summary?: string;         // ≤500c redacted
  request_payload?: Record<string, unknown>;
  response_payload?: Record<string, unknown>;
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  cost_usd?: number;
  error_message?: string;
  error_stack?: string;
  metadata?: Record<string, unknown>;
}

export interface RecordMcpAuditResult {
  audit_id: string;
  spine_event_id?: string;
  warnings: string[];
}

const DEFAULT_ORG_ID = "00000000-0000-0000-0000-000000000001";

/**
 * Record an MCP / JARVIS tool call.
 *
 * - Best-effort: if the agent_audit_log insert fails, we still try the
 *   spine write so the call leaves at least one trace.
 * - Auto-truncates request_summary / response_summary to 500c.
 * - Spine write uses bypass_feature_flag so audit logging is structurally
 *   always-on.
 */
export async function recordMcpAudit(
  // deno-lint-ignore no-explicit-any
  client: any,
  input: RecordMcpAuditInput,
  options: { org_id?: string } = {},
): Promise<RecordMcpAuditResult> {
  const orgId = options.org_id ?? DEFAULT_ORG_ID;
  const warnings: string[] = [];
  let audit_id = `unwritten-${cryptoRandom()}`;

  const auditRow = {
    occurred_at: new Date().toISOString(),
    tool_name: input.tool_name,
    tool_version: input.tool_version ?? null,
    caller: input.caller ?? "jarvis",
    caller_user_id: input.caller_user_id ?? null,
    caller_chat_id: input.caller_chat_id ?? null,
    job_id: input.job_id ?? null,
    contact_id: input.contact_id ?? null,
    correlation_id: input.correlation_id ?? null,
    verdict: input.verdict,
    policy_reason: input.policy_reason ?? null,
    request_summary: truncate(input.request_summary, 500),
    response_summary: truncate(input.response_summary, 500),
    request_payload: input.request_payload ?? {},
    response_payload: input.response_payload ?? {},
    model: input.model ?? null,
    input_tokens: input.input_tokens ?? null,
    output_tokens: input.output_tokens ?? null,
    cost_usd: input.cost_usd ?? null,
    error_message: input.error_message ?? null,
    error_stack: input.error_stack ?? null,
    metadata: input.metadata ?? {},
  };

  try {
    const { data, error } = await client
      .from("agent_audit_log")
      .insert(auditRow)
      .select("id")
      .single();
    if (error) {
      warnings.push(`agent_audit_log insert failed: ${error.message}`);
    } else if (data?.id) {
      audit_id = data.id;
    }
  } catch (e) {
    warnings.push(`agent_audit_log throw: ${(e as Error).message}`);
  }

  // Spine row via recordEvidence with bypass_feature_flag.
  let spine_event_id: string | undefined;
  try {
    const result = await recordEvidence(client, {
      event_type: `agent.tool.${input.verdict}`,
      source: `mcp/${input.tool_name}`,
      channel: "audit",
      direction: "system",
      occurred_at: auditRow.occurred_at,
      source_table: "agent_audit_log",
      source_id: audit_id,
      job_id: input.job_id ?? null,
      contact_id: input.contact_id ?? null,
      entity_type: "tool_call",
      entity_id: audit_id,
      match_method: input.job_id ? "direct_job_id" : "none",
      body_preview: truncate(
        `${input.tool_name} ${input.verdict}: ${input.request_summary ?? ""}`,
        500,
      ) ?? undefined,
      safe_summary: truncate(
        `${input.tool_name} ${input.verdict}${input.policy_reason ? ` (${input.policy_reason})` : ""}`,
        280,
      ) ?? undefined,
      privacy_classification: "internal",
      retention_class: "90d_transient",
      payload: {
        tool_name: input.tool_name,
        verdict: input.verdict,
        caller: auditRow.caller,
        cost_usd: input.cost_usd ?? null,
        model: input.model ?? null,
      },
      // Audit rows are NEVER extractor-eligible. Force off.
      enqueueExtraction: false,
    }, {
      org_id: orgId,
      bypass_feature_flag: true,    // <-- audit is always-on
      storage_client: undefined,    // no body bucket needed
    });
    spine_event_id = result.spine_event_id;
  } catch (e) {
    warnings.push(`spine audit insert failed: ${(e as Error).message}`);
  }

  return { audit_id, spine_event_id, warnings };
}

function truncate(s: string | undefined | null, max: number): string | null {
  if (!s) return null;
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + "...";
}

function cryptoRandom(): string {
  const arr = new Uint8Array(8);
  crypto.getRandomValues(arr);
  return Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join("");
}
