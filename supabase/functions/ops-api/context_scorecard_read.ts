// deno-lint-ignore-file no-explicit-any
//
// The context scorecard door (gap map W11, migration 20261006032000).
//
// GET ops-api?action=context_scorecard            rows 1 to 14 of the owner's
//     definition of done, per lane, with the lane_quiet and
//     history_load_stalled alarms (context_scorecard).
// GET ops-api?action=context_scorecard&jobs=1     one page of live jobs graded
//     per row (context_scorecard_jobs), from `after` (a job id), `limit`
//     (1 to 300, default 150) jobs at a time; `next` is the following cursor.
// Both take an optional `as_of` (an ISO instant, never in the future). It
// cuts the evidence: every business_events row captured after it is left out,
// on the card and on the job pages alike. The job list, the status functions,
// facts, Xero invoices and the story rows (11 to 13) are read as they are now.
//
// Staff front door, GET only. It calls two read-only SQL functions and writes
// nothing; a failed read is an error with a code, never an empty card.

import {
  parseInstant,
  parseUuid,
  sanitizedError,
  StoryReadError,
} from "./job_story_read.ts";

export const SCORECARD_JOBS_DEFAULT_LIMIT = 150;
export const SCORECARD_JOBS_MAX_LIMIT = 300;

export function parseScorecardLimit(value: string | null): number {
  if (value === null || value === "") return SCORECARD_JOBS_DEFAULT_LIMIT;
  if (!/^[0-9]{1,4}$/.test(value)) {
    throw new StoryReadError("invalid_limit", "limit must be a whole number");
  }
  const n = Number(value);
  if (n < 1 || n > SCORECARD_JOBS_MAX_LIMIT) {
    throw new StoryReadError(
      "invalid_limit",
      `limit must be between 1 and ${SCORECARD_JOBS_MAX_LIMIT}`,
    );
  }
  return n;
}

export async function contextScorecardAction(
  client: any,
  params: URLSearchParams,
) {
  // Every parameter is checked before any read.
  const asOf = parseInstant(params.get("as_of"), "as_of");
  const jobs = params.get("jobs");
  if (jobs !== null && jobs !== "" && jobs !== "1") {
    throw new StoryReadError("invalid_jobs", "jobs must be 1 or absent");
  }
  if (jobs === "1") {
    const after = parseUuid(params.get("after"), "after");
    const limit = parseScorecardLimit(params.get("limit"));
    const args: Record<string, unknown> = { p_after: after, p_limit: limit };
    if (asOf) args.p_as_of = asOf;
    const page = await client.rpc("context_scorecard_jobs", args);
    if (page.error) {
      throw new StoryReadError(
        "scorecard_jobs_failed",
        sanitizedError("scorecard jobs read failed", page.error),
        502,
      );
    }
    if (
      !page.data || page.data.version !== "context-scorecard-jobs-v1" ||
      !Array.isArray(page.data.jobs)
    ) {
      throw new StoryReadError(
        "scorecard_invalid_shape",
        "scorecard jobs answer not recognised",
        502,
      );
    }
    return page.data;
  }
  const card = await client.rpc("context_scorecard", asOf ? { p_as_of: asOf } : {});
  if (card.error) {
    throw new StoryReadError(
      "scorecard_failed",
      sanitizedError("scorecard read failed", card.error),
      502,
    );
  }
  if (
    !card.data || card.data.version !== "context-scorecard-v1" ||
    !Array.isArray(card.data.rows) || card.data.rows.length !== 14
  ) {
    throw new StoryReadError(
      "scorecard_invalid_shape",
      "scorecard answer not recognised",
      502,
    );
  }
  return card.data;
}
