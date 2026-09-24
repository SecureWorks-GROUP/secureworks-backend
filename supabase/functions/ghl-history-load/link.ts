// The M4 link action: put a GHL contact on live jobs that have none, so the
// history load (history_load.ts) folds them in and the ladder places their
// texts normally (context slice M4; captain, 24 Sep 2026: "yes link all live
// jobs to their contacts").
//
// Rules (bounded here and in SQL, migration 20260925031500):
//   * only live jobs (context_ghl_history_live_jobs) whose ghl_contact_id is
//     null or blank; never an overwrite (link_job_ghl_contact compares and
//     sets, and reports already_linked instead). Both judged phone/email keys
//     are rechecked under the job lock; drift returns key_changed without
//     a link or audit row, for a fresh search on a later run;
//   * the job's client_phone and client_email keys (B0 context_phone_key,
//     context_email_key; TS twins phoneKey, emailKey) are searched in GHL, and
//     a returned contact counts only when its own phone or email has the SAME
//     key. Names are never read or compared;
//   * certain: exactly one GHL contact matches, and the contact our own
//     records already give those keys (context_contact_for_key) is either
//     none or that same contact. ambiguous: several contacts, the phone and
//     the email name different contacts, our records name another contact or
//     several, or the GHL search could not be read to its end. none: no key,
//     or no GHL contact carries the key. failed: the search could not be read.
//     The provider adapter retains matches across up to five cursor pages;
//     only explicit has_more=false proves exhaustion. An unfinished search
//     remains ambiguous even if its returned matches look unique;
//   * candidates come a keyset page at a time, by job id: each run starts
//     after the last job the previous run of the same kind judged (its run
//     row cursor), or after_job_id when given, and records where it stopped,
//     so repeated runs reach every live job with no contact; a run that
//     reaches the end starts the next one from the beginning;
//   * a dry run (the default) writes nothing but its own run row
//     (ghl_history_link_dry) and returns the counts and the job numbers of
//     the ambiguous, none and failed jobs (numbers only, no names). A real run
//     (dry_run exactly false) writes each certain link with one audit row
//     (context_ghl_contact_links), reversible by reverse_ghl_contact_link.
//
// Pure orchestration over injected reads and writes. No model call.

import { emailKey, phoneKey } from "../_shared/job_refs.ts";
import {
  failureStopsRun,
  type ProviderFailure,
  safeCode,
} from "../ghl-message-reconcile/reconcile.ts";
import type { RunRow } from "./history_load.ts";

export const LINK_RUN_SOURCE = "ghl_history_link";
export const LINK_DRY_RUN_SOURCE = "ghl_history_link_dry";

export interface LinkPolicy {
  searchLimit: number;
  timeBudgetMs: number;
  runningStaleMs: number;
  defaultMaxJobs: number;
  maxJobsCeiling: number;
}

export const LINK_POLICY: Readonly<LinkPolicy> = {
  searchLimit: 100,
  timeBudgetMs: 100_000,
  runningStaleMs: 10 * 60_000,
  defaultMaxJobs: 500,
  maxJobsCeiling: 500,
};

export interface LinkCandidate {
  job_id: string;
  job_number: string | null;
  tier: number;
  phone_key: string | null;
  email_key: string | null;
  own_contact_id: string | null;
  own_contacts: number;
}

export type LinkWriteOutcome =
  | { outcome: "linked"; link_id?: string }
  | { outcome: "already_linked"; same_contact?: boolean }
  | { outcome: "key_changed" }
  | { outcome: "not_live" }
  | { outcome: "job_missing" }
  | { outcome: "booking_draft_conflict" }
  | { outcome: "unique_conflict" }
  | { outcome: "error"; code?: string };

export interface LinkDeps {
  now(): number;
  latestRun(source: string): Promise<RunRow | null>;
  recordRun(run: Record<string, unknown>): Promise<string>;
  /** context_ghl_history_link_candidates(after, limit). Throws when unreadable. */
  candidates(after: string | null, limit: number): Promise<LinkCandidate[]>;
  /** GHL contact search (list_ghl_contacts query). Throws a provider failure. */
  searchContacts(query: string, limit: number): Promise<{
    contacts: Record<string, unknown>[];
    complete: boolean;
  }>;
  /** link_job_ghl_contact(row). Never throws: a fault is outcome error. */
  link(row: Record<string, unknown>): Promise<LinkWriteOutcome>;
}

export interface LinkRequest {
  dryRun: boolean;
  maxJobs: number;
  actor: string;
  /** Start after this job id instead of where the previous run stopped. */
  afterJobId?: string | null;
}

export type LinkVerdict =
  | {
    kind: "certain";
    contact_id: string;
    key_kind: "phone" | "email" | "phone_and_email";
  }
  | {
    kind: "ambiguous";
    reason:
      | "several_contacts"
      | "phone_email_disagree"
      | "own_records_disagree"
      | "own_records_several"
      | "search_incomplete";
  }
  | { kind: "none"; reason: "no_keys" | "not_in_ghl" }
  | { kind: "failed"; code: string };

export type LinkResult =
  | { outcome: "run_in_progress"; run_id: string }
  | {
    outcome: "ran";
    run_id: string;
    dry_run: boolean;
    status: "succeeded" | "partial" | "failed";
    error_code: string | null;
    counts: Record<string, number>;
    ambiguous_job_numbers: string[];
    none_job_numbers: string[];
    failed_job_numbers: string[];
    /** Where this run started and where the next one starts (null: from the beginning). */
    after_job_id: string | null;
    next_after_job_id: string | null;
  };

const COUNT_KEYS = [
  "dry_run",
  "jobs_considered",
  "certain",
  "ambiguous",
  "none",
  "failed",
  "no_keys",
  "not_in_ghl",
  "several_contacts",
  "phone_email_disagree",
  "own_records_disagree",
  "own_records_several",
  "search_incomplete",
  "searches",
  "by_phone",
  "by_email",
  "by_phone_and_email",
  "contacts_on_several_jobs",
  "linked",
  "already_linked",
  "key_changed",
  "not_live",
  "job_missing",
  "link_conflicts",
  "link_errors",
  "backlog_jobs",
] as const;
type CountKey = typeof COUNT_KEYS[number];

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function providerFailure(error: unknown): ProviderFailure {
  const e = (error ?? {}) as Record<string, unknown>;
  return {
    code: typeof e.code === "string" ? e.code : undefined,
    status: typeof e.status === "number" ? e.status : undefined,
    providerStatus: typeof e.providerStatus === "number"
      ? e.providerStatus
      : undefined,
  };
}

/** GHL stores Australian numbers as +61 then the nine digits the key keeps. */
export function phoneQuery(key: string): string {
  return `+61${key}`;
}

/** The GHL contacts in a search answer whose own phone or email has this key. */
export function contactsWithKey(
  contacts: Record<string, unknown>[],
  kind: "phone" | "email",
  key: string,
): Set<string> {
  const out = new Set<string>();
  for (const c of contacts) {
    const id = text(c.id);
    if (!id || !/^[A-Za-z0-9_-]{6,64}$/.test(id)) continue;
    const own = kind === "phone"
      ? phoneKey(text(c.phone))
      : emailKey(text(c.email));
    if (own === key) out.add(id);
  }
  return out;
}

class StopRun extends Error {
  constructor(public stopCode: string) {
    super(stopCode);
  }
}

/** The verdict for one job. Throws StopRun on a failure that must stop the run. */
export async function judgeJob(
  deps: Pick<LinkDeps, "searchContacts">,
  job: LinkCandidate,
  policy: Readonly<LinkPolicy>,
  count: (key: CountKey) => void,
): Promise<LinkVerdict> {
  if (!job.phone_key && !job.email_key) {
    return { kind: "none", reason: "no_keys" };
  }
  if (job.own_contacts > 1) {
    return { kind: "ambiguous", reason: "own_records_several" };
  }
  const found: Record<"phone" | "email", Set<string>> = {
    phone: new Set(),
    email: new Set(),
  };
  let incomplete = false;
  for (const kind of ["phone", "email"] as const) {
    const key = kind === "phone" ? job.phone_key : job.email_key;
    if (!key) continue;
    let answer;
    try {
      count("searches");
      answer = await deps.searchContacts(
        kind === "phone" ? phoneQuery(key) : key,
        policy.searchLimit,
      );
    } catch (error) {
      const f = providerFailure(error);
      if (failureStopsRun(f)) {
        throw new StopRun(
          f.status === 429 || f.providerStatus === 429
            ? "ghl_rate_limited"
            : safeCode(f.code ?? "provider_read_failed"),
        );
      }
      return { kind: "failed", code: safeCode(f.code ?? "search_failed") };
    }
    found[kind] = contactsWithKey(answer.contacts, kind, key);
    if (!answer.complete) incomplete = true;
  }
  if (incomplete) return { kind: "ambiguous", reason: "search_incomplete" };
  const all = new Set([...found.phone, ...found.email]);
  if (all.size > 1) {
    return {
      kind: "ambiguous",
      reason: found.phone.size <= 1 && found.email.size <= 1
        ? "phone_email_disagree"
        : "several_contacts",
    };
  }
  if (all.size === 0) return { kind: "none", reason: "not_in_ghl" };
  const contact = [...all][0];
  if (job.own_contact_id && job.own_contact_id !== contact) {
    return { kind: "ambiguous", reason: "own_records_disagree" };
  }
  const byPhone = found.phone.has(contact);
  const byEmail = found.email.has(contact);
  return {
    kind: "certain",
    contact_id: contact,
    key_kind: byPhone && byEmail
      ? "phone_and_email"
      : byPhone
      ? "phone"
      : "email",
  };
}

export function parseLinkRequest(
  body: Record<string, unknown>,
  actor: string,
  policy: Readonly<LinkPolicy> = LINK_POLICY,
): LinkRequest {
  const n = typeof body.max_jobs === "number" && Number.isInteger(body.max_jobs)
    ? body.max_jobs
    : policy.defaultMaxJobs;
  const after = typeof body.after_job_id === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        body.after_job_id,
      )
    ? body.after_job_id.toLowerCase()
    : null;
  return {
    dryRun: body.dry_run !== false,
    maxJobs: Math.min(Math.max(n, 1), policy.maxJobsCeiling),
    actor,
    afterJobId: after,
  };
}

export async function runGhlContactLink(
  deps: LinkDeps,
  req: LinkRequest,
  policy: Readonly<LinkPolicy> = LINK_POLICY,
): Promise<LinkResult> {
  const source = req.dryRun ? LINK_DRY_RUN_SOURCE : LINK_RUN_SOURCE;
  const started = deps.now();
  const latest = await deps.latestRun(source);
  // Where the previous run of this kind stopped, unless the caller says.
  const previousNext = latest && latest.status !== "running" &&
      latest.cursor && typeof latest.cursor === "object"
    ? (latest.cursor as Record<string, unknown>).next_after
    : null;
  const after = req.afterJobId ??
    (typeof previousNext === "string" ? previousNext : null);
  if (latest?.status === "running") {
    const updated = Date.parse(latest.updated_at) || 0;
    if (started - updated < policy.runningStaleMs) {
      return { outcome: "run_in_progress", run_id: latest.id };
    }
    await deps.recordRun({
      run_id: latest.id,
      source,
      status: "failed",
      error_code: "run_abandoned",
    });
  }

  const counts = Object.fromEntries(COUNT_KEYS.map((k) => [k, 0])) as Record<
    CountKey,
    number
  >;
  counts.dry_run = req.dryRun ? 1 : 0;
  const count = (k: CountKey) => {
    counts[k]++;
  };
  const runId = await deps.recordRun({
    source,
    status: "running",
    window_to: new Date(started).toISOString(),
    cursor: { v: 1, actor: req.actor, after, next_after: after },
    counts,
  });

  const ambiguous: string[] = [];
  const none: string[] = [];
  const failed: string[] = [];
  const contactJobs = new Map<string, number>();
  let stop: string | null = null;
  let firstIssue: string | null = null;
  const label = (job: LinkCandidate) => job.job_number ?? job.job_id;
  let nextAfter: string | null = null;

  try {
    const jobs = await deps.candidates(after, req.maxJobs);
    // A full page may have more after it; a short one reached the end.
    const fullPage = jobs.length >= req.maxJobs;
    nextAfter = fullPage && jobs.length ? jobs[jobs.length - 1].job_id : null;
    if (fullPage) counts.backlog_jobs = 1; // at least the next page
    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];
      if (deps.now() - started >= policy.timeBudgetMs) {
        counts.backlog_jobs = Math.max(counts.backlog_jobs, jobs.length - i);
        nextAfter = i > 0 ? jobs[i - 1].job_id : after;
        break;
      }
      counts.jobs_considered++;
      let verdict: LinkVerdict;
      try {
        verdict = await judgeJob(deps, job, policy, count);
      } catch (error) {
        if (error instanceof StopRun) {
          stop = error.stopCode;
          counts.backlog_jobs = Math.max(counts.backlog_jobs, jobs.length - i);
          counts.jobs_considered--;
          nextAfter = i > 0 ? jobs[i - 1].job_id : after;
          break;
        }
        throw error;
      }
      if (verdict.kind === "failed") {
        counts.failed++;
        failed.push(label(job));
        firstIssue ??= `search_failed:${verdict.code}`;
        continue;
      }
      if (verdict.kind === "none") {
        counts.none++;
        counts[verdict.reason]++;
        none.push(label(job));
        continue;
      }
      if (verdict.kind === "ambiguous") {
        counts.ambiguous++;
        counts[verdict.reason]++;
        ambiguous.push(label(job));
        continue;
      }
      counts.certain++;
      counts[
        verdict.key_kind === "phone"
          ? "by_phone"
          : verdict.key_kind === "email"
          ? "by_email"
          : "by_phone_and_email"
      ]++;
      const seen = (contactJobs.get(verdict.contact_id) ?? 0) + 1;
      contactJobs.set(verdict.contact_id, seen);
      if (seen === 2) counts.contacts_on_several_jobs++;
      if (req.dryRun) continue;
      const written = await deps.link({
        job_id: job.job_id,
        contact_id: verdict.contact_id,
        key_kind: verdict.key_kind,
        phone_key: job.phone_key,
        email_key: job.email_key,
        run_id: runId,
        actor: req.actor,
      });
      if (written.outcome === "linked") counts.linked++;
      else if (written.outcome === "already_linked") counts.already_linked++;
      else if (written.outcome === "key_changed") counts.key_changed++;
      else if (written.outcome === "not_live") counts.not_live++;
      else if (written.outcome === "job_missing") counts.job_missing++;
      else if (
        written.outcome === "booking_draft_conflict" ||
        written.outcome === "unique_conflict"
      ) {
        counts.link_conflicts++;
        ambiguous.push(label(job));
      } else {
        counts.link_errors++;
        firstIssue ??= `link_error:${safeCode(written.code, "unknown")}`;
      }
      if (i % 10 === 9) {
        await deps.recordRun({
          run_id: runId,
          source,
          counts,
          cursor: { v: 1, actor: req.actor, after, next_after: job.job_id },
        });
      }
    }
  } catch (error) {
    stop = safeCode(providerFailure(error).code ?? "run_error");
    // Nothing after the start point can be trusted as judged: start there again.
    nextAfter = after;
  }

  const status: "succeeded" | "partial" | "failed" = stop
    ? "failed"
    : firstIssue || counts.backlog_jobs > 0
    ? "partial"
    : "succeeded";
  const errorCode = stop ?? firstIssue;
  await deps.recordRun({
    run_id: runId,
    source,
    status,
    counts,
    error_code: errorCode,
    cursor: { v: 1, actor: req.actor, after, next_after: nextAfter },
  });
  return {
    outcome: "ran",
    run_id: runId,
    dry_run: req.dryRun,
    after_job_id: after,
    next_after_job_id: nextAfter,
    status,
    error_code: errorCode,
    counts,
    ambiguous_job_numbers: ambiguous,
    none_job_numbers: none,
    failed_job_numbers: failed,
  };
}
