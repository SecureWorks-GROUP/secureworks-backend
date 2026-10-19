// deno-lint-ignore-file no-explicit-any
// Quote options the staff reads should stop counting (ticket SQ-23, reader
// half). Shared by ops-api, daily-digest, reporting-api and ops-ai.
//
// When a client accepts one fence quote option, the SQ-23 trigger
// (20261019210000_fence_quote_option_jobs.sql) marks the other open options
// superseded with a pointer and a `quote_option_superseded` job_event. It
// never changes their status, so every read that lists draft or quoted jobs
// would still show them as live work. This module is the one rule those reads
// use to leave them out (CIO receipt, 19 Oct 2026, decisions B to D):
//
// - The events are the truth: a job is superseded from its newest
//   `quote_option_superseded` event until a later `quote_option_unsuperseded`.
// - Only a job still at draft or quoted is left out. A job that moved on is
//   shown, whatever its events say.
// - A group is pending review while two or more of its options are won, or
//   while its newest `quote_option_review_needed` event with a reason in
//   QUOTE_OPTION_PENDING_REVIEW_REASONS is no older than its newest superseded
//   event. Every shown job of such a group is labelled pending review, and
//   nothing in it is left out.
// - The accepted option going back to draft or quoted brings its siblings
//   back. The accepted option going to lost or cancelled does not: they stay
//   left out until an explicit `quote_option_unsuperseded` event.
// - A job in no group has no events and is never left out, so a genuine
//   repeat job stays live.
// - Anything that cannot be read or does not agree (events against the
//   pointer, an unknown group) is shown, never hidden.
//
// Switch `quote_option_ops_reader_v1`, missing or unreadable is off. Off, the
// reads that use this are unchanged apart from reading the switch.

export const QUOTE_OPTION_OPS_READER_FLAG = "quote_option_ops_reader_v1";

export const QUOTE_OPTION_SUPERSEDED_EVENT = "quote_option_superseded";
export const QUOTE_OPTION_UNSUPERSEDED_EVENT = "quote_option_unsuperseded";
export const QUOTE_OPTION_REVIEW_EVENT = "quote_option_review_needed";

// The review reasons that mean nobody can tell which option won. Other review
// reasons (a crewed or invoiced sibling, the accepted job lost) leave the
// normal rule standing.
export const QUOTE_OPTION_PENDING_REVIEW_REASONS: readonly string[] = [
  "more_than_one_option_won",
  "sibling_busy",
  "supersede_failed",
];

// Must equal public.fence_quote_option_status_won in the SQ-23 migration, in
// its order. quote_option_reader_test.ts compares the two.
export const QUOTE_OPTION_WON_STATUSES: readonly string[] = [
  "accepted",
  "awaiting_deposit",
  "deposit",
  "approvals",
  "order_materials",
  "order_confirmed",
  "schedule_install",
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
const IN_URL_BUDGET = 6000;
const IN_MAX_COUNT = 200;

export type QuoteOptionState = "live" | "superseded" | "pending_review";

export type QuoteOptionReason =
  | "one_option_won"
  | "accepted_option_lost"
  | "several_options_won"
  | "review_needed"
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

function chunkIds(ids: string[]): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  let bytes = 0;
  for (const id of ids) {
    const cost = encodeURIComponent(id).length + 1;
    if (
      cur.length > 0 &&
      (bytes + cost > IN_URL_BUDGET || cur.length >= IN_MAX_COUNT)
    ) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(id);
    bytes += cost;
  }
  if (cur.length) out.push(cur);
  return out;
}

function eventsAsOf(events: QuoteOptionEvent[], asOf: string) {
  const asOfMs = Date.parse(asOf);
  return events.filter((e) => {
    const at = Date.parse(e.created_at);
    return Number.isFinite(at) && at <= asOfMs;
  });
}

// The newest superseded event of each job that no later unsuperseded event
// undoes, as of `asOf`. On a tie the unsuperseded event counts as later.
export function openSupersessions(
  events: QuoteOptionEvent[],
  asOf: string,
): Map<string, QuoteOptionEvent> {
  const rank = (e: QuoteOptionEvent) =>
    e.event_type === QUOTE_OPTION_UNSUPERSEDED_EVENT ? 1 : 0;
  const byJob = new Map<string, QuoteOptionEvent[]>();
  for (const e of eventsAsOf(events, asOf)) {
    if (
      e.event_type !== QUOTE_OPTION_SUPERSEDED_EVENT &&
      e.event_type !== QUOTE_OPTION_UNSUPERSEDED_EVENT
    ) continue;
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

// Why a group is pending review as of `asOf`, or null when it is not.
// `events` are every quote-option event of the group's members.
export function groupPendingReview(
  members: QuoteOptionMember[],
  events: QuoteOptionEvent[],
  asOf: string,
): "several_options_won" | "review_needed" | null {
  if (members.filter((m) => isWonQuoteOptionStatus(m.status)).length >= 2) {
    return "several_options_won";
  }
  let lastSuperseded = -Infinity;
  let lastReview = -Infinity;
  for (const e of eventsAsOf(events, asOf)) {
    const at = Date.parse(e.created_at);
    if (e.event_type === QUOTE_OPTION_SUPERSEDED_EVENT) {
      lastSuperseded = Math.max(lastSuperseded, at);
    } else if (
      e.event_type === QUOTE_OPTION_REVIEW_EVENT &&
      QUOTE_OPTION_PENDING_REVIEW_REASONS.includes(
        String(e.detail_json?.reason ?? ""),
      )
    ) {
      lastReview = Math.max(lastReview, at);
    }
  }
  // Written in the same transaction as marks it sits beside (one now()), so
  // a tie counts as pending.
  return lastReview > -Infinity && lastReview >= lastSuperseded
    ? "review_needed"
    : null;
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

// Decide every member of every group, given all their events.
export function decideQuoteOptionGroups(
  membersByGroup: Map<string, QuoteOptionMember[]>,
  events: QuoteOptionEvent[],
  asOf: string,
): Map<string, QuoteOptionDecision> {
  const decisions = new Map<string, QuoteOptionDecision>();
  const open = openSupersessions(events, asOf);
  const groupOf = new Map<string, string>();
  for (const [g, members] of membersByGroup) {
    for (const m of members) groupOf.set(m.id, g);
  }
  for (const [g, members] of membersByGroup) {
    const ids = new Set(members.map((m) => m.id));
    const groupEvents = events.filter((e) =>
      ids.has(e.job_id) || text(e.detail_json?.quote_option_group_id) === g
    );
    const pending = groupPendingReview(members, groupEvents, asOf);
    for (const m of members) {
      const event = open.get(m.id);
      if (pending) {
        decisions.set(m.id, {
          state: "pending_review",
          reason: pending,
          quote_option_group_id: g,
          superseded_by_job_id: text(event?.detail_json?.superseded_by_job_id),
        });
      } else if (event && isOpenQuoteStatus(m.status)) {
        decisions.set(m.id, decideSupersededJob(m.id, event, membersByGroup));
      }
    }
  }
  // An open superseded event whose job was not found in any group read.
  for (const [jobId, event] of open) {
    if (!groupOf.has(jobId)) {
      decisions.set(jobId, decideSupersededJob(jobId, event, membersByGroup));
    }
  }
  return decisions;
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

const EVENT_TYPES = [
  QUOTE_OPTION_SUPERSEDED_EVENT,
  QUOTE_OPTION_UNSUPERSEDED_EVENT,
  QUOTE_OPTION_REVIEW_EVENT,
];

async function readEvents(
  client: any,
  ids: string[],
): Promise<QuoteOptionEvent[] | null> {
  const out: QuoteOptionEvent[] = [];
  for (const chunk of chunkIds(ids)) {
    const { data, error } = await client.from("job_events")
      .select("job_id, event_type, created_at, detail_json")
      .in("job_id", chunk)
      .in("event_type", EVENT_TYPES)
      .order("created_at", { ascending: true })
      .limit(READ_LIMIT);
    if (error || !Array.isArray(data) || data.length >= READ_LIMIT) {
      console.error(
        "[quote_options] events read failed",
        error?.message || "row limit",
      );
      return null;
    }
    out.push(...data.map((e: any) => ({ ...e, job_id: String(e.job_id) })));
  }
  return out;
}

// Reads what the decision needs for the given jobs, which may be of any
// status. Three reads at most: the jobs' quote-option events, the groups
// those events name (by the indexed jobs.quote_option_group_id), and the
// events of group members not already read. Decisions are returned only for
// the given jobs.
export async function loadQuoteOptionVisibility(
  client: any,
  jobs: Array<{ id?: unknown; status?: unknown }>,
  options: { asOf?: string; flagOn?: boolean } = {},
): Promise<QuoteOptionVisibility> {
  const flagOn = options.flagOn ?? await readQuoteOptionReaderFlag(client);
  if (!flagOn) return quoteOptionVisibilityOff();
  const asOf = options.asOf ?? new Date().toISOString();
  const ids = [...new Set(jobs.filter((j) => j?.id).map((j) => String(j.id)))];
  const result: QuoteOptionVisibility = {
    status: "ok",
    decisions: new Map(),
    hidden: new Set(),
  };
  if (ids.length === 0) return result;

  try {
    const events = await readEvents(client, ids);
    if (!events) return failed();
    const groupIds = [
      ...new Set(
        events.map((e) => text(e.detail_json?.quote_option_group_id))
          .filter((g): g is string => !!g),
      ),
    ];
    if (groupIds.length === 0) return result;

    const membersByGroup = new Map<string, QuoteOptionMember[]>();
    for (const chunk of chunkIds(groupIds)) {
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
    const given = new Set(ids);
    const others = [...membersByGroup.values()].flat().map((m) => m.id)
      .filter((id) => !given.has(id));
    const otherEvents = others.length ? await readEvents(client, others) : [];
    if (!otherEvents) return failed();

    const decisions = decideQuoteOptionGroups(membersByGroup, [
      ...events,
      ...otherEvents,
    ], asOf);
    for (const [jobId, decision] of decisions) {
      if (!given.has(jobId)) continue;
      result.decisions.set(jobId, decision);
      if (decision.state === "superseded") result.hidden.add(jobId);
    }
    return result;
  } catch (err) {
    console.error("[quote_options] read threw", String(err));
    return failed();
  }
}

export function isQuoteOptionHidden(
  visibility: QuoteOptionVisibility,
  jobId: unknown,
): boolean {
  return visibility.hidden.has(String(jobId));
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

// For a reader that only needs the superseded options left out: returns the
// rows without them. Only draft and quoted rows (or rows with no status) are
// looked up. Switch off or a failed read: the rows come back as they were.
export async function dropSupersededQuoteOptions(
  client: any,
  rows: any[],
  options: { asOf?: string } = {},
): Promise<{ rows: any[]; visibility: QuoteOptionVisibility }> {
  const visibility = await loadQuoteOptionVisibility(
    client,
    rows.filter((r) => isOpenQuoteStatus(r?.status)),
    options,
  );
  return {
    rows: visibility.hidden.size > 0
      ? rows.filter((r) => !visibility.hidden.has(String(r?.id)))
      : rows,
    visibility,
  };
}
