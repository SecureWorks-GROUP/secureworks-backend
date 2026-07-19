// M0 · U2 — First-contact + lead-source stamping (single source of truth).
//
// Mission: sales-m0-data-truth-2026-07-05 (Lane A / U2). Contract §2a call 2 + 3.
// Migration: 20260705000100_m0_first_contact_lead_source.sql (DRAFT).
//
// This module is the ONE implementation of first-contact semantics. It is
// exercised at runtime (record_evidence choke point + job creation) AND by the
// fixtures (first_contact_test.ts) — so there is no drift between the tested
// logic and the shipped logic.
//
// Two grains:
//   * LIFETIME  (contact_matches.contact_first_seen_at) — earliest eligible
//     inbound/outbound touch for a contact across ALL episodes. Recomputed by
//     a min-scan so it self-heals / backdates idempotently when a
//     previously-unresolved touch later resolves to the contact.
//   * EPISODE   (jobs.first_contacted_at / _channel / _direction) — earliest
//     eligible touch for THIS opportunity, bounded below by the prior
//     episode's last activity and above by the next episode's start, so a
//     repeat client's new opportunity never inherits an old timestamp.
//
// All writes are monotonic-min + idempotent (guarded so a value only ever
// moves earlier, never later). Every function accepts { dry_run } to compute
// the would-be change without writing (used by the backfill + fixtures).

import { Channel, Direction } from "./types.ts";

// deno-lint-ignore no-explicit-any
export type SupabaseLike = any;

/** Channels that count as a client "contact" touch. Stage moves, quotes, notes,
 *  telegram (internal ops chatter) and system rows never set first-contact. */
export const FIRST_CONTACT_CHANNELS: Channel[] = ["sms", "call", "email"];

/** A first contact is a real inbound OR outbound touch — not internal/system. */
export const FIRST_CONTACT_DIRECTIONS: Direction[] = ["inbound", "outbound"];

/** lead_source values that mean "not really attributed" — treated as unattributed. */
const LEAD_SOURCE_PLACEHOLDERS = new Set(["", "unknown", "unattributed"]);

const DEFAULT_ORG_ID = "00000000-0000-0000-0000-000000000001";

export function isFirstContactEligible(
  channel: string | null | undefined,
  direction: string | null | undefined,
): boolean {
  return (
    !!channel &&
    !!direction &&
    (FIRST_CONTACT_CHANNELS as string[]).includes(channel) &&
    (FIRST_CONTACT_DIRECTIONS as string[]).includes(direction)
  );
}

export interface StampResult {
  changed: boolean;
  before?: string | null;
  after?: string | null;
  reason?: string;
}

/**
 * LIFETIME stamp. Recomputes the earliest eligible touch for the contact and
 * writes it to every contact_matches row sharing the ghl_contact_id, but only
 * where the stored value is null or later (monotonic min). Because it derives
 * the value from the full event set rather than a single event, it is
 * order-independent and backdates automatically when an earlier touch becomes
 * visible (late resolution).
 *
 * No contact_matches row yet => nothing to stamp (the row is created by the
 * matcher/attribution path first). The history backfill reconciles those.
 */
export async function stampContactFirstSeen(
  supabase: SupabaseLike,
  args: { ghlContactId: string; dry_run?: boolean },
): Promise<StampResult> {
  const { ghlContactId, dry_run } = args;
  if (!ghlContactId) return { changed: false, reason: "no_contact_id" };

  const earliest = await earliestEligibleTouch(supabase, { contactId: ghlContactId });
  if (!earliest) return { changed: false, reason: "no_eligible_touch" };

  const { data: rows, error } = await supabase
    .from("contact_matches")
    .select("id, contact_first_seen_at")
    .eq("ghl_contact_id", ghlContactId);
  if (error) throw new Error(`stampContactFirstSeen read failed: ${error.message}`);
  if (!Array.isArray(rows) || rows.length === 0) {
    return { changed: false, reason: "no_contact_row" };
  }

  const needsUpdate = rows.filter(
    (r: { contact_first_seen_at: string | null }) =>
      r.contact_first_seen_at == null || isBefore(earliest.occurred_at, r.contact_first_seen_at),
  );
  if (needsUpdate.length === 0) return { changed: false, reason: "already_min" };

  if (dry_run) {
    return { changed: true, after: earliest.occurred_at, reason: `would_update_${needsUpdate.length}_rows` };
  }

  const { error: upErr } = await supabase
    .from("contact_matches")
    .update({ contact_first_seen_at: earliest.occurred_at })
    .eq("ghl_contact_id", ghlContactId)
    .or(`contact_first_seen_at.is.null,contact_first_seen_at.gt.${earliest.occurred_at}`);
  if (upErr) throw new Error(`stampContactFirstSeen update failed: ${upErr.message}`);
  return { changed: true, after: earliest.occurred_at };
}

/**
 * EPISODE stamp, O(1) live path. The incoming touch is already attributed to
 * jobId by the matcher, so it belongs to this episode by construction. Writes
 * it only when it is earlier than the stored value (monotonic min). Used by
 * record_evidence for touches that arrive AFTER the job exists.
 */
export async function stampJobFirstContact(
  supabase: SupabaseLike,
  args: {
    jobId: string;
    occurredAt: string;
    channel: string;
    direction: string;
    dry_run?: boolean;
  },
): Promise<StampResult> {
  const { jobId, occurredAt, channel, direction, dry_run } = args;
  if (!jobId || !occurredAt) return { changed: false, reason: "missing_args" };
  if (!isFirstContactEligible(channel, direction)) return { changed: false, reason: "ineligible" };

  const { data: job, error } = await supabase
    .from("jobs")
    .select("id, first_contacted_at")
    .eq("id", jobId)
    .maybeSingle();
  if (error) throw new Error(`stampJobFirstContact read failed: ${error.message}`);
  if (!job) return { changed: false, reason: "no_job" };

  if (job.first_contacted_at != null && !isBefore(occurredAt, job.first_contacted_at)) {
    return { changed: false, reason: "already_earlier_or_equal", before: job.first_contacted_at };
  }
  if (dry_run) {
    return { changed: true, before: job.first_contacted_at ?? null, after: occurredAt };
  }

  const { error: upErr } = await supabase
    .from("jobs")
    .update({
      first_contacted_at: occurredAt,
      first_contact_channel: channel,
      first_contact_direction: direction,
    })
    .eq("id", jobId)
    .or(`first_contacted_at.is.null,first_contacted_at.gt.${occurredAt}`);
  if (upErr) throw new Error(`stampJobFirstContact update failed: ${upErr.message}`);
  return { changed: true, before: job.first_contacted_at ?? null, after: occurredAt };
}

export interface EpisodeFirstContact {
  occurred_at: string;
  channel: string;
  direction: string;
}

/**
 * Compute the episode first-contact for a job by bounding the contact's touch
 * stream to THIS opportunity:
 *   lower bound = the prior DIFFERENT-opportunity episode's last activity
 *                 (or that job's created_at as a fallback), exclusive.
 *   upper bound = the next DIFFERENT-opportunity episode's start, exclusive.
 * Then take the earliest eligible touch inside the window. Jobs of the SAME
 * opportunity (e.g. a patio + fence split) do not bound each other, so they
 * share the inquiry. Read-only.
 */
export async function computeEpisodeFirstContact(
  supabase: SupabaseLike,
  job: {
    id: string;
    ghl_contact_id: string | null;
    ghl_opportunity_id: string | null;
    created_at: string;
  },
): Promise<EpisodeFirstContact | null> {
  if (!job.ghl_contact_id) return null;
  const oppKey = job.ghl_opportunity_id ?? "";

  // Prior + next jobs of the same contact (episode boundaries).
  const { data: siblings, error: sibErr } = await supabase
    .from("jobs")
    .select("id, created_at, ghl_opportunity_id")
    .eq("ghl_contact_id", job.ghl_contact_id)
    .neq("id", job.id);
  if (sibErr) throw new Error(`computeEpisodeFirstContact siblings failed: ${sibErr.message}`);

  const differentOpp = (s: { ghl_opportunity_id: string | null }) =>
    (s.ghl_opportunity_id ?? "") !== oppKey;

  const priorJobs = (siblings ?? []).filter(
    (s: { created_at: string; ghl_opportunity_id: string | null }) =>
      isBefore(s.created_at, job.created_at) && differentOpp(s),
  );
  const nextJobs = (siblings ?? []).filter(
    (s: { created_at: string; ghl_opportunity_id: string | null }) =>
      isBefore(job.created_at, s.created_at) && differentOpp(s),
  );

  // lower bound: last activity of the prior episode, else its created_at.
  let lowerBound: string | null = null;
  if (priorJobs.length > 0) {
    const priorIds = priorJobs.map((p: { id: string }) => p.id);
    const { data: lastTouch, error: ltErr } = await supabase
      .from("business_events")
      .select("occurred_at")
      .in("job_id", priorIds)
      .order("occurred_at", { ascending: false })
      .limit(1);
    if (ltErr) throw new Error(`computeEpisodeFirstContact lower failed: ${ltErr.message}`);
    lowerBound = lastTouch?.[0]?.occurred_at ??
      maxBy(priorJobs, (p: { created_at: string }) => p.created_at);
  }

  // upper bound: earliest start of a later different-opportunity episode.
  const upperBound = nextJobs.length > 0
    ? minBy(nextJobs, (n: { created_at: string }) => n.created_at)
    : null;

  let q = supabase
    .from("business_events")
    .select("occurred_at, channel, direction")
    .eq("contact_id", job.ghl_contact_id)
    .in("channel", FIRST_CONTACT_CHANNELS as string[])
    .in("direction", FIRST_CONTACT_DIRECTIONS as string[])
    .order("occurred_at", { ascending: true });
  if (lowerBound) q = q.gt("occurred_at", lowerBound);
  if (upperBound) q = q.lt("occurred_at", upperBound);
  q = q.limit(1);

  const { data: hit, error: hitErr } = await q;
  if (hitErr) throw new Error(`computeEpisodeFirstContact scan failed: ${hitErr.message}`);
  const row = hit?.[0];
  if (!row) return null;
  return { occurred_at: row.occurred_at, channel: row.channel, direction: row.direction };
}

/**
 * Resolve the lead source for a contact from the existing attribution write
 * (contact_matches.lead_source, set by ghl-webhook-receiver from gclid/utm).
 * A real attributed value passes through (form lead); null / unknown /
 * unattributed collapse to 'unattributed'. The comms channel is NEVER used.
 */
export async function resolveLeadSource(
  supabase: SupabaseLike,
  args: { ghlContactId: string | null },
): Promise<string> {
  if (!args.ghlContactId) return "unattributed";
  const { data, error } = await supabase
    .from("contact_matches")
    .select("lead_source")
    .eq("ghl_contact_id", args.ghlContactId)
    .not("lead_source", "is", null)
    .limit(1);
  if (error) throw new Error(`resolveLeadSource failed: ${error.message}`);
  const raw = data?.[0]?.lead_source;
  if (raw && !LEAD_SOURCE_PLACEHOLDERS.has(String(raw).toLowerCase())) return String(raw);
  return "unattributed";
}

export interface JobPropagationResult {
  changed: boolean;
  first_contact?: EpisodeFirstContact | null;
  lead_source?: string;
  patch?: Record<string, unknown>;
  reason?: string;
}

/**
 * Job-creation (and backfill) propagation: compute the episode first-contact
 * from the contact's pre-job touch stream and set the job's episode columns +
 * lead_source. Idempotent: first-contact fields only move earlier; lead_source
 * is only filled when currently null. Safe to re-run.
 */
export async function propagateJobFirstContactAndLeadSource(
  supabase: SupabaseLike,
  args: { jobId: string; dry_run?: boolean },
): Promise<JobPropagationResult> {
  const { jobId, dry_run } = args;
  const { data: job, error } = await supabase
    .from("jobs")
    .select(
      "id, ghl_contact_id, ghl_opportunity_id, created_at, first_contacted_at, first_contact_channel, first_contact_direction, lead_source",
    )
    .eq("id", jobId)
    .maybeSingle();
  if (error) throw new Error(`propagateJob read failed: ${error.message}`);
  if (!job) return { changed: false, reason: "no_job" };

  const episode = await computeEpisodeFirstContact(supabase, job);
  const leadSource = await resolveLeadSource(supabase, { ghlContactId: job.ghl_contact_id });

  const firstContactPatch: Record<string, unknown> = {};
  if (
    episode &&
    (job.first_contacted_at == null || isBefore(episode.occurred_at, job.first_contacted_at))
  ) {
    firstContactPatch.first_contacted_at = episode.occurred_at;
    firstContactPatch.first_contact_channel = episode.channel;
    firstContactPatch.first_contact_direction = episode.direction;
  }
  const setLeadSource = job.lead_source == null;

  if (Object.keys(firstContactPatch).length === 0 && !setLeadSource) {
    return { changed: false, first_contact: episode, lead_source: leadSource, reason: "already_set" };
  }

  const patch: Record<string, unknown> = { ...firstContactPatch };
  if (setLeadSource) patch.lead_source = leadSource;

  if (dry_run) {
    return { changed: true, first_contact: episode, lead_source: leadSource, patch };
  }

  if (Object.keys(firstContactPatch).length > 0) {
    const { error: fcErr } = await supabase
      .from("jobs")
      .update(firstContactPatch)
      .eq("id", jobId)
      .or(`first_contacted_at.is.null,first_contacted_at.gt.${episode!.occurred_at}`);
    if (fcErr) throw new Error(`propagateJob first-contact update failed: ${fcErr.message}`);
  }
  if (setLeadSource) {
    const { error: lsErr } = await supabase
      .from("jobs")
      .update({ lead_source: leadSource })
      .eq("id", jobId)
      .is("lead_source", null);
    if (lsErr) throw new Error(`propagateJob lead_source update failed: ${lsErr.message}`);
  }
  return { changed: true, first_contact: episode, lead_source: leadSource, patch };
}

// ── internals ────────────────────────────────────────────────────────────────

async function earliestEligibleTouch(
  supabase: SupabaseLike,
  args: { contactId: string },
): Promise<{ occurred_at: string } | null> {
  const { data, error } = await supabase
    .from("business_events")
    .select("occurred_at")
    .eq("contact_id", args.contactId)
    .in("channel", FIRST_CONTACT_CHANNELS as string[])
    .in("direction", FIRST_CONTACT_DIRECTIONS as string[])
    .order("occurred_at", { ascending: true })
    .limit(1);
  if (error) throw new Error(`earliestEligibleTouch failed: ${error.message}`);
  const row = data?.[0];
  return row ? { occurred_at: row.occurred_at } : null;
}

function isBefore(a: string, b: string): boolean {
  return new Date(a).getTime() < new Date(b).getTime();
}

function maxBy<T>(arr: T[], key: (t: T) => string): string {
  return arr.map(key).reduce((m, v) => (new Date(v) > new Date(m) ? v : m));
}

function minBy<T>(arr: T[], key: (t: T) => string): string {
  return arr.map(key).reduce((m, v) => (new Date(v) < new Date(m) ? v : m));
}

// Re-export for callers that check the kill-switch.
export const FIRST_CONTACT_FLAG = "first_contact_stamp_v1" as const;
export { DEFAULT_ORG_ID as FIRST_CONTACT_DEFAULT_ORG_ID };
