// T7 Loop 2 — Evidence Health handler
//
// Roadmap: cio/operations/2026-05-02-t7-evidence-capture-spine-roadmap.md (Section 9, Loop 2)
//
// Read-only handler. Returns the per-channel coverage matrix, queue health,
// mailbox last-seen, proposed-action evidence-ref coverage, and stale-channel
// alarms. Driven by the views in 20260502000010_v_evidence_health.sql.
//
// Wired into ops-api via:
//   case 'get_evidence_health': return json(await getEvidenceHealth(client))
//
// No writes. No PII bodies. Only counts, percentages, and last-seen
// timestamps. Safe to surface to authenticated operators via the Evidence
// Health page.

export interface EvidenceHealthChannelRow {
  channel: string;
  direction: string;
  source_table: string;
  rows_30d: number;
  missing_job: number;
  missing_contact: number;
  missing_envelope: number;
  comms_missing_preview: number;
  preview_truncated_no_pointer: number;
  matched: number;
  ambiguous: number;
  unresolved: number;
  ignored: number;
  no_match_status: number;
  last_event_at: string | null;
  first_event_at: string | null;
}

export interface EvidenceHealthQueueRow {
  status: string;
  n: number;
  oldest_created_at: string | null;
  newest_created_at: string | null;
  newest_processed_at: string | null;
}

export interface EvidenceHealthMailboxRow {
  mailbox: string;
  rows_24h: number;
  rows_7d: number;
  rows_30d: number;
  last_message_at: string | null;
  last_processed_at: string | null;
}

export interface EvidenceHealthProposalsRow {
  rows_30d: number;
  with_evidence_refs: number;
  without_evidence_refs: number;
  with_exception_reason: number;
  proposed: number;
  approved: number;
  rejected: number;
  latest_proposal_at: string | null;
  /** Derived: ratio of rows that cite at least one EvidenceRef. */
  ref_coverage_pct: number;
}

export interface EvidenceHealthStaleRow {
  channel: string;
  rows_24h: number;
  rows_7d: number;
  last_event_at: string | null;
}

export interface EvidenceHealthResult {
  generated_at: string;
  ok: boolean;
  warnings: string[];
  channels: EvidenceHealthChannelRow[];
  queue: EvidenceHealthQueueRow[];
  mailboxes: EvidenceHealthMailboxRow[];
  proposals: EvidenceHealthProposalsRow;
  stale_channels: EvidenceHealthStaleRow[];
  /**
   * Top-line summary numbers for the page header.
   */
  summary: {
    total_rows_30d: number;
    matched_pct: number;
    unresolved_count: number;
    queue_pending: number;
    queue_dead_letter: number;
    proposals_with_refs_pct: number;
    stale_channel_count: number;
  };
}

interface ClientLike {
  from(table: string): {
    select(cols: string): {
      // deno-lint-ignore no-explicit-any
      then: any;
    };
  };
}

/**
 * Fetch all five views and assemble the result. Each view fetch is its own
 * try/catch so a missing view does not poison the rest. Until 20260502000010
 * is applied, every view will return an error → empty arrays + warnings.
 */
// deno-lint-ignore no-explicit-any
export async function getEvidenceHealth(client: any): Promise<EvidenceHealthResult> {
  const warnings: string[] = [];

  const channels = await safeFetch<EvidenceHealthChannelRow>(
    client, "v_evidence_health", warnings,
  );
  const queue = await safeFetch<EvidenceHealthQueueRow>(
    client, "v_evidence_health_queue", warnings,
  );
  const mailboxes = await safeFetch<EvidenceHealthMailboxRow>(
    client, "v_evidence_health_mailbox", warnings,
  );
  const proposalsArr = await safeFetch<Omit<EvidenceHealthProposalsRow, "ref_coverage_pct">>(
    client, "v_evidence_health_proposals", warnings,
  );
  const stale_channels = await safeFetch<EvidenceHealthStaleRow>(
    client, "v_evidence_health_stale", warnings,
  );

  const proposalsRow = proposalsArr[0] ?? {
    rows_30d: 0,
    with_evidence_refs: 0,
    without_evidence_refs: 0,
    with_exception_reason: 0,
    proposed: 0,
    approved: 0,
    rejected: 0,
    latest_proposal_at: null,
  };
  const proposals: EvidenceHealthProposalsRow = {
    ...proposalsRow,
    ref_coverage_pct: proposalsRow.rows_30d > 0
      ? Math.round((proposalsRow.with_evidence_refs / proposalsRow.rows_30d) * 1000) / 10
      : 0,
  };

  const total_rows_30d = channels.reduce((s, c) => s + (c.rows_30d ?? 0), 0);
  const matched = channels.reduce((s, c) => s + (c.matched ?? 0), 0);
  const unresolved_count = channels.reduce((s, c) => s + (c.unresolved ?? 0) + (c.ambiguous ?? 0), 0);
  const queue_pending = queue.find((q) => q.status === "pending")?.n ?? 0;
  const queue_dead_letter = queue.find((q) => q.status === "dead_letter")?.n ?? 0;

  return {
    generated_at: new Date().toISOString(),
    ok: warnings.length === 0,
    warnings,
    channels,
    queue,
    mailboxes,
    proposals,
    stale_channels,
    summary: {
      total_rows_30d,
      matched_pct: total_rows_30d > 0
        ? Math.round((matched / total_rows_30d) * 1000) / 10
        : 0,
      unresolved_count,
      queue_pending,
      queue_dead_letter,
      proposals_with_refs_pct: proposals.ref_coverage_pct,
      stale_channel_count: stale_channels.length,
    },
  };
}

async function safeFetch<T>(
  // deno-lint-ignore no-explicit-any
  client: any,
  view: string,
  warnings: string[],
): Promise<T[]> {
  try {
    // PostgREST uses .select('*') against a view the same as a table.
    const { data, error } = await client.from(view).select("*");
    if (error) {
      warnings.push(`${view}: ${error.message ?? "unknown error"}`);
      return [];
    }
    return (data ?? []) as T[];
  } catch (e) {
    warnings.push(`${view}: ${(e as Error).message ?? "throw"}`);
    return [];
  }
}
