// deno-lint-ignore-file no-explicit-any
// Quote options the Ops reads should stop counting (ticket SQ-23, Ops half).
//
// When a client accepts one fence quote option, the SQ-23 trigger
// (20261019210000_fence_quote_option_jobs.sql) marks the other open options
// superseded with a pointer and a `quote_option_superseded` job_event. It
// never changes their status, so every Ops read that lists draft or quoted
// jobs would still show them as live work. This module is the one rule those
// reads use to leave them out (CIO receipt, 19 Oct 2026, decisions B to D):
//
// - The events are the truth: a job is superseded from its newest
//   `quote_option_superseded` event until a later `quote_option_unsuperseded`.
// - Only a job still at draft or quoted is left out. A job that moved on is
//   shown, whatever its events say.
// - Two or more won options in the group (a simultaneous acceptance) leaves
//   every option shown, marked pending review: nothing is decided for them.
// - The accepted option going back to draft or quoted brings its siblings
//   back. The accepted option going to lost or cancelled does not: they stay
//   left out until an explicit `quote_option_unsuperseded` event.
// - A job in no group has no events and is never left out, so a genuine
//   repeat job stays live.
// - Anything that cannot be read or does not agree (events against the
//   pointer, an unknown group) is shown, never hidden.
//
// Switch `quote_option_ops_reader_v1`, missing or unreadable is off. Off, the
// reads above are unchanged apart from reading the switch.

import { chunkByUrlBudget } from "./makesafe_compact_reads.ts";

export const QUOTE_OPTION_OPS_READER_FLAG = "quote_option_ops_reader_v1";

export const QUOTE_OPTION_SUPERSEDED_EVENT = "quote_option_superseded";
export const QUOTE_OPTION_UNSUPERSEDED_EVENT = "quote_option_unsuperseded";

// Copied from public.fence_quote_option_status_won (20261019210000). The
// contract test pins the two lists together.
export const QUOTE_OPTION_WON_STATUSES: readonly string[] = [
  "accepted",
  "processing",
  "awaiting_supplier",
  "scheduled",
  "in_progress",
  "rectification",
  "final_payment",
  "invoiced",
  "complete",
  "get_review",
];

const READ_LIMIT = 1000;

export type QuoteOptionState = "live" | "superseded" | "pending_review";

export type QuoteOptionReason =
  | "one_option_won"
  | "accepted_option_lost"
  | "several_options_won"
  | "accepted_option_reopened"
  | "group_unknown"
  | "pointer_disagrees"
  | "option_moved_on";

export interface QuoteOptionDecision {
  state: QuoteOptionState;
  reason: QuoteOptionReason;
  quote_option_group_id: string | null;
  superseded_by_job_id: string | null;
}

export interface QuoteOptionEvent {
  job_id: string;
  event_type: string;
  created_at: string;
  detail_json: Record<string, unknown> | null;
}

export interface QuoteOptionMember {
  id: string;
  status: string | null;
  quote_option_group_id: string | null;
  superseded_at: string | null;
}

export interface QuoteOptionVisibility {
  // off: the switch is off, nothing was read. failed: a read failed, nothing
  // is left out.
  status: "off" | "ok" | "failed";
  decisions: Map<string, QuoteOptionDecision>;
  hidden: Set<string>;
}

export function isOpenQuoteStatus(status: unknown): boolean {
  const value = status == null ? "draft" : String(status);
  return value === "draft" || value === "quoted";
}

export function isWonQuoteOptionStatus(status: unknown): boolean {
  return QUOTE_OPTION_WON_STATUSES.includes(String(status ?? ""));
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// The newest superseded event of each job that no later unsuperseded event
// undoes, as of `asOf`. On a tie the unsuperseded event counts as later.
export function openSupersessions(
  events: QuoteOptionEvent[],
  asOf: string,
): Map<string, QuoteOptionEvent> {
  const asOfMs = Date.parse(asOf);
  const rank = (e: QuoteOptionEvent) =>
    e.event_type === QUOTE_OPTION_UNSUPERSEDED_EVENT ? 1 : 0;
  const byJob = new Map<string, QuoteOptionEvent[]>();
  for (const e of events) {
    if (
      e.event_type !== QUOTE_OPTION_SUPERSEDED_EVENT &&
      e.event_type !== QUOTE_OPTION_UNSUPERSEDED_EVENT
    ) continue;
    const at = Date.parse(e.created_at);
    if (!Number.isFinite(at) || at > asOfMs) continue;
    const list = byJob.get(e.job_id) || [];
    list.push(e);
    byJob.set(e.job_id, list);
  }
  const open = new Map<string, QuoteOptionEvent>();
  for (const [jobId, list] of byJob) {
    list.sort((a, b) =>
      Date.parse(a.created_at) - Date.parse(b.created_at) || rank(a) - rank(b)
    );
    const last = list[list.length - 1];
    if (last.event_type === QUOTE_OPTION_SUPERSEDED_EVENT) {
      open.set(jobId, last);
    }
  }
  return open;
}

// Decide one draft or quoted job that has an open superseded event.
export function decideSupersededJob(
  jobId: string,
  event: QuoteOptionEvent,
  membersByGroup: Map<string, QuoteOptionMember[]>,
): QuoteOptionDecision {
  const groupId = text(event.detail_json?.quote_option_group_id);
  const supersededBy = text(event.detail_json?.superseded_by_job_id);
  const base = {
    quote_option_group_id: groupId,
    superseded_by_job_id: supersededBy,
  };
  const members = groupId ? membersByGroup.get(groupId) : undefined;
  const self = members?.find((m) => m.id === jobId);
  if (!groupId || !members || !self || self.quote_option_group_id !== groupId) {
    return { ...base, state: "live", reason: "group_unknown" };
  }
  // The job's own status as read with its group decides, not the caller's
  // copy: a job that moved past draft or quoted is shown.
  if (!isOpenQuoteStatus(self.status)) {
    return { ...base, state: "live", reason: "option_moved_on" };
  }
  // The pointer and the events must agree before anything is left out.
  if (!self.superseded_at) {
    return { ...base, state: "live", reason: "pointer_disagrees" };
  }
  const won = members.filter((m) => isWonQuoteOptionStatus(m.status));
  if (won.length >= 2) {
    return { ...base, state: "pending_review", reason: "several_options_won" };
  }
  if (won.length === 1) {
    return { ...base, state: "superseded", reason: "one_option_won" };
  }
  const accepted = supersededBy
    ? members.find((m) => m.id === supersededBy)
    : undefined;
  if (!accepted) return { ...base, state: "live", reason: "group_unknown" };
  if (isOpenQuoteStatus(accepted.status)) {
    return { ...base, state: "live", reason: "accepted_option_reopened" };
  }
  // Lost, cancelled or anything else: the marks stand until someone writes
  // an unsuperseded event.
  return { ...base, state: "superseded", reason: "accepted_option_lost" };
}

export function quoteOptionVisibilityOff(): QuoteOptionVisibility {
  return { status: "off", decisions: new Map(), hidden: new Set() };
}

function failed(): QuoteOptionVisibility {
  return { status: "failed", decisions: new Map(), hidden: new Set() };
}

export async function readQuoteOptionReaderFlag(client: any): Promise<boolean> {
  try {
    const { data, error } = await client.from("feature_flags").select("enabled")
      .eq("flag_name", QUOTE_OPTION_OPS_READER_FLAG).limit(1);
    if (error) return false;
    return data?.[0]?.enabled === true;
  } catch {
    return false;
  }
}

// Reads what the decision needs for the given jobs. Only draft or quoted jobs
// are looked at; a job passed with no status is looked at too and decided by
// the status read with its group. Two reads at most: the jobs' own supersede events, then the
// groups those events name (by the indexed jobs.quote_option_group_id).
export async function loadQuoteOptionVisibility(
  client: any,
  jobs: Array<{ id?: unknown; status?: unknown }>,
  options: { asOf?: string; flagOn?: boolean } = {},
): Promise<QuoteOptionVisibility> {
  const flagOn = options.flagOn ?? await readQuoteOptionReaderFlag(client);
  if (!flagOn) return quoteOptionVisibilityOff();
  const asOf = options.asOf ?? new Date().toISOString();
  const candidateIds = [
    ...new Set(
      jobs.filter((j) => j?.id && isOpenQuoteStatus(j.status)).map((j) =>
        String(j.id)
      ),
    ),
  ];
  const result: QuoteOptionVisibility = {
    status: "ok",
    decisions: new Map(),
    hidden: new Set(),
  };
  if (candidateIds.length === 0) return result;

  try {
    const events: QuoteOptionEvent[] = [];
    for (const chunk of chunkByUrlBudget(candidateIds)) {
      const { data, error } = await client.from("job_events")
        .select("job_id, event_type, created_at, detail_json")
        .in("job_id", chunk)
        .in("event_type", [
          QUOTE_OPTION_SUPERSEDED_EVENT,
          QUOTE_OPTION_UNSUPERSEDED_EVENT,
        ])
        .order("created_at", { ascending: true })
        .limit(READ_LIMIT);
      if (error || !Array.isArray(data) || data.length >= READ_LIMIT) {
        console.error(
          "[quote_options] supersede events read failed",
          error?.message || "row limit",
        );
        return failed();
      }
      events.push(...data);
    }
    const open = openSupersessions(events, asOf);
    if (open.size === 0) return result;

    const groupIds = [
      ...new Set(
        [...open.values()].map((e) =>
          text(e.detail_json?.quote_option_group_id)
        )
          .filter((g): g is string => !!g),
      ),
    ];
    const membersByGroup = new Map<string, QuoteOptionMember[]>();
    for (const chunk of chunkByUrlBudget(groupIds)) {
      const { data, error } = await client.from("jobs")
        .select("id, status, quote_option_group_id, superseded_at")
        .in("quote_option_group_id", chunk)
        .limit(READ_LIMIT);
      if (error || !Array.isArray(data) || data.length >= READ_LIMIT) {
        console.error(
          "[quote_options] option group read failed",
          error?.message || "row limit",
        );
        return failed();
      }
      for (const row of data as QuoteOptionMember[]) {
        const g = String(row.quote_option_group_id);
        const list = membersByGroup.get(g) || [];
        list.push({ ...row, id: String(row.id) });
        membersByGroup.set(g, list);
      }
    }
    for (const [jobId, event] of open) {
      const decision = decideSupersededJob(jobId, event, membersByGroup);
      result.decisions.set(jobId, decision);
      if (decision.state === "superseded") result.hidden.add(jobId);
    }
    return result;
  } catch (err) {
    console.error("[quote_options] read threw", String(err));
    return failed();
  }
}

// The block a reader adds to its answer when the switch is on.
export function quoteOptionSummary(visibility: QuoteOptionVisibility) {
  if (visibility.status === "off") return {};
  const pending = [...visibility.decisions].filter(([, d]) =>
    d.state === "pending_review"
  ).map(([id]) => id).sort();
  return {
    quote_options: {
      status: visibility.status,
      superseded_hidden: visibility.hidden.size,
      pending_review_job_ids: pending,
    },
  };
}
