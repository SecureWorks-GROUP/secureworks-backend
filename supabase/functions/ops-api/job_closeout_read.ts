// The paid close-out as the Ops board and job view see it (read only, staff only).
//
// job_closeout_state and job_review_claims are service-role tables written only by
// job_closeout.ts; no screen can read them. This module projects them, with the
// get_review entry time the archive sweep uses, into one `closeout` block per fencing or
// patio job:
//
//   closeout: {
//     paid_less_than_quoted: boolean,      job_closeout_state (false when never checked)
//     shortfall_inc: number | null,        job_closeout_state, only while the marker is on
//     review: { status, reason } | null,   the job's review claim (claimed | sent | skipped
//                                          | unconfirmed, with its reason); with no claim,
//                                          the newest review_request_not_sent row
//                                          (status not_sent, reason refused or the row's
//                                          reason); with neither, null. Only what the
//                                          sender recorded: a send that kept no claim and
//                                          logged nothing (no contact, paid too long ago)
//                                          reads null, never a predicted outcome
//     get_review_entered_at: string | null, loadGetReviewEntries, the sweep's own rule
//     archive_due_at: string | null,       entry + CLOSEOUT_ARCHIVE_AFTER_MS while the job
//                                          is in get_review, else null
//     held: 'rectification' | 'callback' | null,  closeoutHold
//     review_opt_out: boolean,             jobs.review_opt_out: a person switched the
//                                          review text off for this job (false when never)
//     review_claim_status: string | null,  the job's job_review_claims status, or null
//                                          with no claim; once set, the switch is refused
//   }
//
// This block is the one place the screen reads review_opt_out and review_claim_status,
// on the pipeline row and the job detail alike; neither is copied to the top level. The
// job detail's job (select '*') still carries the raw jobs columns review_opt_out,
// review_opt_out_at and review_opt_out_by; the pipeline row selects none of them.
//
// Every read is batched over the whole job list (chunked .in() filters, one wave), never
// one query per job; each table reads its chunks one after another, so a full board holds
// at most one request per table in flight. A draft is never read: it cannot have been
// paid, claimed or put in get_review, so it gets the empty block. It writes nothing and decides nothing: a card's move, text and
// archive are job_closeout.ts's. Any failed read returns null, so a caller shows no tags
// rather than tags made from a partial read.

import {
  CLOSEOUT_ARCHIVE_AFTER_MS,
  CLOSEOUT_REVIEW_STATUS,
  closeoutHold,
  isCloseoutJobType,
} from "../_shared/job_paid_closeout.ts";
import { loadGetReviewEntries } from "./job_closeout.ts";

export interface CloseoutReview {
  status: string;
  reason: string | null;
}

export interface CloseoutBlock {
  paid_less_than_quoted: boolean;
  shortfall_inc: number | null;
  review: CloseoutReview | null;
  get_review_entered_at: string | null;
  archive_due_at: string | null;
  held: "rectification" | "callback" | null;
  review_opt_out: boolean;
  review_claim_status: string | null;
}

/** The job columns the block needs; is_callback and review_opt_out are read here when a
 *  caller lacks them. */
export interface CloseoutReadJob {
  id: string;
  type: string | null;
  status: string | null;
  is_callback?: boolean | null;
  review_opt_out?: boolean | null;
}

/** Ids per PostgREST .in() filter. */
const ID_CHUNK = 50;

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += ID_CHUNK) {
    out.push(items.slice(i, i + ID_CHUNK));
  }
  return out;
}

/** Rows of `table` for these job ids, one query per chunk, chunks in turn; null when any
 *  chunk fails. */
async function readRows(
  // deno-lint-ignore no-explicit-any
  client: any,
  table: string,
  columns: string,
  ids: string[],
  // deno-lint-ignore no-explicit-any
  extra?: (q: any) => any,
  // deno-lint-ignore no-explicit-any
): Promise<any[] | null> {
  // deno-lint-ignore no-explicit-any
  const rows: any[] = [];
  for (const part of chunks(ids)) {
    let q = client.from(table).select(columns).in(
      table === "jobs" ? "id" : "job_id",
      part,
    );
    if (extra) q = extra(q);
    const { data, error } = await q.limit(5000);
    if (error) return null;
    rows.push(...(data ?? []));
  }
  return rows;
}

function money(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function text(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** The review a not-sent row records: refused, else its reason, else its status. */
function reviewFromNotSentEvent(
  detail: Record<string, unknown> | null,
): CloseoutReview {
  const status = text(detail?.status);
  const reason = status === "refused"
    ? "refused"
    : text(detail?.reason) || status || null;
  return { status: "not_sent", reason };
}

/**
 * The closeout block for every fencing and patio job in `jobs`, keyed by job id. Other
 * job types get no entry. Null when any read fails.
 */
export async function loadCloseoutBlocks(
  // deno-lint-ignore no-explicit-any
  client: any,
  jobs: CloseoutReadJob[],
): Promise<Map<string, CloseoutBlock> | null> {
  const out = new Map<string, CloseoutBlock>();
  const closeoutJobs: CloseoutReadJob[] = [];
  for (const j of jobs) {
    if (!isCloseoutJobType(j.type)) continue;
    if (j.status === "draft") {
      out.set(j.id, {
        paid_less_than_quoted: false,
        shortfall_inc: null,
        review: null,
        get_review_entered_at: null,
        archive_due_at: null,
        held: j.is_callback === true ? "callback" : null,
        review_opt_out: j.review_opt_out === true,
        review_claim_status: null,
      });
    } else {
      closeoutJobs.push(j);
    }
  }
  if (!closeoutJobs.length) return out;
  const ids = closeoutJobs.map((j) => j.id);
  const missingJobColumns = closeoutJobs.filter((j) =>
    j.is_callback === undefined || j.review_opt_out === undefined
  )
    .map((j) => j.id);

  const [states, claims, notSent, entries, jobColumns] = await Promise
    .all([
      readRows(
        client,
        "job_closeout_state",
        "job_id, paid_less_than_quoted, shortfall_inc",
        ids,
      ),
      readRows(client, "job_review_claims", "job_id, status, reason", ids),
      readRows(
        client,
        "job_events",
        "job_id, detail_json, created_at",
        ids,
        (q) =>
          q.eq("event_type", "review_request_not_sent").order("created_at", {
            ascending: false,
          }),
      ),
      loadGetReviewEntries(client, ids),
      readRows(
        client,
        "jobs",
        "id, is_callback, review_opt_out",
        missingJobColumns,
      ),
    ]);
  if (!states || !claims || !notSent || !entries || !jobColumns) {
    return null;
  }

  const stateBy = new Map(states.map((r) => [r.job_id, r]));
  const claimBy = new Map(claims.map((r) => [r.job_id, r]));
  const notSentBy = new Map<string, Record<string, unknown> | null>();
  for (const r of notSent) {
    if (!notSentBy.has(r.job_id)) {
      notSentBy.set(r.job_id, r.detail_json ?? null);
    }
  }
  const jobColumnsBy = new Map(jobColumns.map((r) => [r.id, r]));

  for (const job of closeoutJobs) {
    const state = stateBy.get(job.id);
    const short = state?.paid_less_than_quoted === true;
    const claim = claimBy.get(job.id);
    let review: CloseoutReview | null = null;
    if (claim) {
      review = { status: claim.status, reason: claim.reason ?? null };
    } else if (notSentBy.has(job.id)) {
      review = reviewFromNotSentEvent(notSentBy.get(job.id) ?? null);
    }
    const entered = entries.get(job.id) ?? null;
    const enteredMs = entered ? new Date(entered).getTime() : NaN;
    const archiveDue = job.status === CLOSEOUT_REVIEW_STATUS &&
        Number.isFinite(enteredMs)
      ? new Date(enteredMs + CLOSEOUT_ARCHIVE_AFTER_MS).toISOString()
      : null;
    out.set(job.id, {
      paid_less_than_quoted: short,
      shortfall_inc: short ? money(state?.shortfall_inc) : null,
      review,
      get_review_entered_at: entered,
      archive_due_at: archiveDue,
      held: closeoutHold({
        status: job.status,
        is_callback: job.is_callback === undefined
          ? jobColumnsBy.get(job.id)?.is_callback ?? null
          : job.is_callback,
      }),
      review_opt_out: (job.review_opt_out === undefined
        ? jobColumnsBy.get(job.id)?.review_opt_out
        : job.review_opt_out) === true,
      review_claim_status: claim?.status ?? null,
    });
  }
  return out;
}
