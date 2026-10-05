// deno-lint-ignore-file no-explicit-any
//
// Job story read doors (story slice S2, contract section 5.4).
//
// The story is assembled in SQL (migration 20261006014000): record parts from
// the job record layer (20261006011000), the live ledger generation and the
// gaps it must name, every line cited. This module only calls those read-only
// functions and reports what failed:
//   - context_job_story(job, as_of, generation, since)  job-story-v1
//   - context_client_story(job, as_of)                  client-story-v1
//   - context_story_scorecard(as_of) and context_story_scorecard_jobs(after,
//     limit), folded into one story-scorecard-v1 answer.
// No table write, no provider call, no model call. A failed read is unknown
// with a code, never an empty story.

export const STORY_SECTIONS_VERSION = 5;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class StoryReadError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

export interface StorySourceStatus {
  ok: boolean;
  state: "ok" | "failed";
  count: number;
  code?: string;
  error?: string;
}

/** Optional instant from a request: an ISO time string, or absent. */
export function parseInstant(value: unknown, name: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new StoryReadError(
      `invalid_${name}`,
      `${name} must be an ISO date-time`,
    );
  }
  return new Date(value).toISOString();
}

/** Optional yes/no flag from a request: true, 1 or yes; false, 0, no or absent. */
export function parseFlag(value: unknown, name: string): boolean {
  if (value === undefined || value === null || value === "") return false;
  const v = typeof value === "boolean" ? String(value) : value;
  if (typeof v === "string") {
    const t = v.trim().toLowerCase();
    if (t === "true" || t === "1" || t === "yes") return true;
    if (t === "false" || t === "0" || t === "no") return false;
  }
  throw new StoryReadError(`invalid_${name}`, `${name} must be true or false`);
}

export function parseUuid(value: unknown, name: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new StoryReadError(`invalid_${name}`, `${name} must be a uuid`);
  }
  return value.toLowerCase();
}

/**
 * A job number as an exact, case-insensitive ILIKE pattern: the LIKE
 * wildcards `%` and `_` and the escape `\` are escaped. PostgREST also reads
 * `*` as `%` and cannot escape it, so a number holding `*` is refused (no job
 * number has one).
 */
export function exactJobNumberPattern(number: string): string {
  if (number.includes("*")) {
    throw new StoryReadError(
      "invalid_job_number",
      "job_number cannot contain *",
    );
  }
  return number.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** One job by id, or by job number (case-insensitive, exact). */
export async function resolveStoryJob(
  client: any,
  ref: { job_id?: unknown; job_number?: unknown },
): Promise<
  { id: string; job_number: string | null; ghl_contact_id: string | null }
> {
  const id = parseUuid(ref.job_id, "job_id");
  const number = typeof ref.job_number === "string" && ref.job_number.trim()
    ? ref.job_number.trim()
    : null;
  if (!id && !number) {
    throw new StoryReadError(
      "job_required",
      "job_id or job_number is required",
    );
  }
  // Refuse a number no exact pattern can express before touching the table.
  const pattern = id ? null : exactJobNumberPattern(number!);
  const cols = "id, job_number, ghl_contact_id";
  const { data, error } = id
    ? await client.from("jobs").select(cols).eq("id", id).limit(1)
    : await client.from("jobs").select(cols).ilike("job_number", pattern)
      .limit(2);
  if (error) {
    throw new StoryReadError(
      "job_read_failed",
      `job read failed: ${error.message}`,
      502,
    );
  }
  const rows: any[] = Array.isArray(data) ? data : data ? [data] : [];
  // By number, only an exact case-insensitive match counts, whatever the
  // pattern matched; two would be ambiguous (job numbers are unique today).
  const matches = id
    ? rows.slice(0, 1)
    : rows.filter((r) =>
      typeof r?.job_number === "string" &&
      r.job_number.toUpperCase() === number!.toUpperCase()
    );
  if (matches.length > 1) {
    throw new StoryReadError(
      "job_number_ambiguous",
      `more than one job is numbered ${number}`,
      409,
    );
  }
  const row = matches[0];
  if (!row) {
    throw new StoryReadError("job_not_found", `no job ${id || number}`, 404);
  }
  return {
    id: row.id,
    job_number: row.job_number ?? null,
    ghl_contact_id: row.ghl_contact_id ?? null,
  };
}

function failed(code: string, error?: string): StorySourceStatus {
  return {
    ok: false,
    state: "failed",
    count: 0,
    code,
    ...(error ? { error } : {}),
  };
}

/** job-story-v1 for one job, or null with a failed status. */
export async function readJobStory(
  client: any,
  input: {
    jobId: string;
    asOf?: string | null;
    since?: string | null;
    generationId?: string | null;
    recordOnly?: boolean;
  },
): Promise<{ story: any | null; status: StorySourceStatus }> {
  const args: Record<string, unknown> = { p_job_id: input.jobId };
  if (input.asOf) args.p_as_of = input.asOf;
  if (input.generationId) args.p_generation_id = input.generationId;
  if (input.since) args.p_since = input.since;
  // The records alone (no ledger read), for the ledger reader's own prompt.
  if (input.recordOnly) args.p_record_only = true;
  try {
    const { data, error } = await client.rpc("context_job_story", args);
    if (error) {
      return { story: null, status: failed("rpc_failed", error.message) };
    }
    if (!data || typeof data !== "object") {
      return { story: null, status: failed("empty_payload") };
    }
    if (data.version !== "job-story-v1") {
      return { story: null, status: failed("invalid_shape") };
    }
    return {
      story: data,
      status: {
        ok: true,
        state: "ok",
        count: Array.isArray(data.loops) ? data.loops.length : 0,
      },
    };
  } catch (e) {
    return { story: null, status: failed("rpc_threw", (e as Error).message) };
  }
}

/** client-story-v1 for the client of one job, or null with a failed status. */
export async function readClientStory(
  client: any,
  input: { jobId: string; asOf?: string | null },
): Promise<{ client: any | null; status: StorySourceStatus }> {
  const args: Record<string, unknown> = { p_job_id: input.jobId };
  if (input.asOf) args.p_as_of = input.asOf;
  try {
    const { data, error } = await client.rpc("context_client_story", args);
    if (error) {
      return { client: null, status: failed("rpc_failed", error.message) };
    }
    if (!data || typeof data !== "object") {
      return { client: null, status: failed("empty_payload") };
    }
    if (data.version !== "client-story-v1") {
      return { client: null, status: failed("invalid_shape") };
    }
    return {
      client: data,
      status: {
        ok: true,
        state: "ok",
        count: Array.isArray(data.jobs) ? data.jobs.length : 0,
      },
    };
  } catch (e) {
    return { client: null, status: failed("rpc_threw", (e as Error).message) };
  }
}

/**
 * The dossier in mode `story`: the usual job header plus the story and the
 * client story, without the conversation, events and facts reads.
 */
export async function buildStoryDossier(client: any, jobRow: any, body: any) {
  const asOf = parseInstant(body?.as_of, "as_of");
  const since = parseInstant(body?.since, "since");
  const generationId = parseUuid(body?.generation_id, "generation_id");
  const [storyRead, clientRead] = await Promise.all([
    readJobStory(client, { jobId: jobRow.id, asOf, since, generationId }),
    readClientStory(client, { jobId: jobRow.id, asOf }),
  ]);
  const sourceStatus = {
    jobs: { ok: true, state: "ok", count: 1 },
    story: storyRead.status,
    client: clientRead.status,
  };
  return {
    job: {
      id: jobRow.id,
      job_number: jobRow.job_number,
      type: jobRow.type,
      status: jobRow.status,
      client_name: jobRow.client_name,
      client_phone: jobRow.client_phone,
      client_email: jobRow.client_email,
      site_address: jobRow.site_address,
      site_suburb: jobRow.site_suburb,
      deposit_amount: jobRow.deposit_amount,
      created_at: jobRow.created_at,
      quoted_at: jobRow.quoted_at,
      accepted_at: jobRow.accepted_at,
      scheduled_at: jobRow.scheduled_at,
      completed_at: jobRow.completed_at,
      updated_at: jobRow.updated_at,
    },
    story: storyRead.story,
    client: clientRead.client,
    diagnostics: {
      ok: storyRead.status.ok && clientRead.status.ok,
      sourceStatus,
      warnings: [] as string[],
    },
    generatedAt: new Date().toISOString(),
    mode: "story",
    _kind: "job_dossier_v1",
    sections_version: STORY_SECTIONS_VERSION,
    _ghlContactId: jobRow.ghl_contact_id || null,
  };
}

/**
 * GET job_story: job_id or job_number, optional as_of, since, generation_id,
 * record_only (the records alone, no ledger).
 */
export async function jobStoryAction(client: any, params: URLSearchParams) {
  const asOf = parseInstant(params.get("as_of"), "as_of");
  const since = parseInstant(params.get("since"), "since");
  const generationId = parseUuid(params.get("generation_id"), "generation_id");
  const recordOnly = parseFlag(params.get("record_only"), "record_only");
  const job = await resolveStoryJob(client, {
    job_id: params.get("job_id"),
    job_number: params.get("job_number"),
  });
  const read = await readJobStory(client, {
    jobId: job.id,
    asOf,
    since,
    generationId,
    recordOnly,
  });
  if (!read.story) {
    throw new StoryReadError(
      read.status.code || "story_failed",
      read.status.error || "story read failed",
      502,
    );
  }
  return read.story;
}

/** GET client_story: job_id (or job_number), optional as_of. */
export async function clientStoryAction(client: any, params: URLSearchParams) {
  const asOf = parseInstant(params.get("as_of"), "as_of");
  const job = await resolveStoryJob(client, {
    job_id: params.get("job_id"),
    job_number: params.get("job_number"),
  });
  const read = await readClientStory(client, { jobId: job.id, asOf });
  if (!read.client) {
    throw new StoryReadError(
      read.status.code || "client_story_failed",
      read.status.error || "client story read failed",
      502,
    );
  }
  return read.client;
}

const SCORECARD_PAGE = 150;
const SCORECARD_MAX_PAGES = 20;

/**
 * GET context_story_scorecard: the cheap rows from context_story_scorecard,
 * then every page of context_story_scorecard_jobs folded into rows 11 to 13.
 * Each SQL call stays under the API statement timeout on its own.
 */
export async function storyScorecardAction(
  client: any,
  params: URLSearchParams,
) {
  const asOf = parseInstant(params.get("as_of"), "as_of");
  const head = await client.rpc(
    "context_story_scorecard",
    asOf ? { p_as_of: asOf } : {},
  );
  if (head.error) {
    throw new StoryReadError("scorecard_failed", head.error.message, 502);
  }
  const card = head.data;
  if (
    !card || card.version !== "story-scorecard-v1" || !Array.isArray(card.rows)
  ) {
    throw new StoryReadError(
      "scorecard_invalid_shape",
      "scorecard answer not recognised",
      502,
    );
  }
  const jobs: any[] = [];
  let after: string | null = null;
  let pages = 0;
  let complete = false;
  while (pages < SCORECARD_MAX_PAGES) {
    const page: any = await client.rpc("context_story_scorecard_jobs", {
      p_after: after,
      p_limit: SCORECARD_PAGE,
    });
    pages += 1;
    if (page.error) {
      throw new StoryReadError(
        "scorecard_jobs_failed",
        page.error.message,
        502,
      );
    }
    const rows = Array.isArray(page.data?.jobs) ? page.data.jobs : [];
    jobs.push(...rows);
    after = page.data?.next ?? null;
    if (!after) {
      complete = true;
      break;
    }
  }
  const n = jobs.length;
  const count = (key: string) => jobs.filter((j) => j?.[key] === true).length;
  const fold: Record<
    number,
    { green: boolean | null; value: string; detail: string }
  > = {
    11: {
      green: complete && n > 0 ? count("row11_green") === n : null,
      value: `${
        count("row11_green")
      } of ${n} live jobs have a timeline and a live ledger with phase notes`,
      detail:
        `${
          jobs.filter((j) => (j?.timeline_rows ?? 0) >= 2).length
        } have a record timeline; ` +
        `${jobs.filter((j) => j?.ledger === "live").length} have a live ledger`,
    },
    12: {
      green: complete && n > 0 ? count("row12_green") === n : null,
      value: `${
        count("row12_green")
      } of ${n} live jobs have a live ledger (promises and asks come from the words)`,
      detail:
        `${
          jobs.reduce((s, j) => s + (j?.record_loops ?? 0), 0)
        } record loops, ` +
        `${jobs.reduce((s, j) => s + (j?.candidates ?? 0), 0)} candidates, ` +
        `${
          jobs.reduce((s, j) => s + (j?.checks ?? 0), 0)
        } checks across live jobs; ` +
        `${
          count("ledger_needs_person")
        } need a person (three ledger readings in a row failed their checks)`,
    },
    13: {
      green: complete && n > 0 ? count("row13_green") === n : null,
      value: `${
        count("row13_green")
      } of ${n} live jobs can be matched to their client`,
      detail: `${
        n - count("row13_green")
      } live jobs have no CRM contact and no client email`,
    },
  };
  const rows = card.rows.map((r: any) =>
    fold[r.row] ? { ...r, ...fold[r.row] } : r
  );
  return {
    ...card,
    rows,
    per_job: { ...card.per_job, pages, jobs_read: n, complete },
  };
}
