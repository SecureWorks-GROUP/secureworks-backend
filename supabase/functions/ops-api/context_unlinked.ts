// Slice B0 (adminbucket.md, Trace C): the two read-only doors onto the
// unlinked-evidence census, behind the ops-api staff front door.
//
//   GET ?action=context_unlinked_census[&budget_ms=]
//       -> RPC context_unlinked_census(p_budget_ms, p_phase, p_cursor_at,
//          p_cursor_id), called again from each part's `next` (the API role
//          stops any one statement at 8 s) and the parts added up here
//   GET ?action=context_unlinked_rows[&scope=&reason=&source=&since=&cursor_at=&cursor_id=&limit=]
//       -> RPC context_unlinked_rows(...)
//
// Both return what the database returns; there is no redaction layer here
// (Review S1): the rows read carries what the job read carries. Neither writes.
// Every call logs one line with the actor (the signed-in user id, else the
// x-sw-actor header, else actor_missing; the one rule is F-ACT's
// _shared/request_actor.ts) and counts, never row content.

import { resolveRequestActor } from "../_shared/request_actor.ts";

export class ContextUnlinkedError extends Error {
  constructor(
    public code: string,
    public status: number,
    message: string,
    public detail: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const UNLINKED_SCOPES = [
  "bucket",
  "null_status",
  "unplaced",
  "holding_job",
  "custody_multi_ref",
] as const;

// The closed reason list of context_bucket_reason_detail (plus the two
// scope-level reasons the rows read stamps itself).
export const UNLINKED_REASONS = [
  "error",
  "thread_conflict",
  "unverified_writer",
  "restamped_legacy",
  "hint_stripped",
  "platform_sender",
  "multi_ref_many",
  "multi_ref",
  "single_ref",
  "ref_not_found",
  "identity_unread",
  "identity_conflict",
  "contact_has_candidates",
  "contact_no_jobs",
  "contact_only_finished",
  "before_any_job",
  "no_identity_site",
  "supplier_no_ref",
  "own_party",
  "no_identity",
  "custody_multi_ref",
  "unplaced",
] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE = /^[A-Za-z0-9_.:-]{1,64}$/;

type Rpc = {
  rpc: (
    fn: string,
    args?: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: unknown }>;
};

type RpcError = { code?: unknown; message?: unknown };

function bad(message: string): never {
  throw new ContextUnlinkedError("invalid_request", 400, message);
}

function isoOrNull(params: URLSearchParams, key: string): string | null {
  const raw = params.get(key);
  if (raw === null || raw === "") return null;
  const t = Date.parse(raw);
  if (!/^\d{4}-\d{2}-\d{2}/.test(raw) || Number.isNaN(t)) {
    bad(`${key} must be an ISO date-time`);
  }
  return new Date(t).toISOString();
}

function intIn(
  params: URLSearchParams,
  key: string,
  min: number,
  max: number,
): number | null {
  const raw = params.get(key);
  if (raw === null || raw === "") return null;
  if (!/^\d+$/.test(raw)) bad(`${key} must be a whole number`);
  const n = Number(raw);
  if (n < min || n > max) bad(`${key} must be between ${min} and ${max}`);
  return n;
}

/** The actor for the log line (INTEGRATION X31: recorded, never required).
 * The one rule lives in _shared/request_actor.ts (slice F-ACT); ops-api
 * resolves it once per request and passes it in. */
export function unlinkedActor(
  userId: string | null | undefined,
  headers: Headers,
  trustActorHeader: boolean,
): string {
  return resolveRequestActor({
    verifiedUserId: userId,
    headers,
    trustActorHeader,
  }).actor;
}

export function censusArgs(params: URLSearchParams): Record<string, unknown> {
  const budget = intIn(params, "budget_ms", 1, 7000);
  return budget === null ? {} : { p_budget_ms: budget };
}

type ReasonPart = {
  reason: string;
  rows: number;
  age: Record<string, number>;
  sample_ids: string[];
};

function mergeReasons(a: unknown, b: unknown): ReasonPart[] {
  const out = new Map<string, ReasonPart>();
  for (const list of [a, b]) {
    for (const r of (Array.isArray(list) ? list : []) as ReasonPart[]) {
      const cur = out.get(r.reason) ??
        { reason: r.reason, rows: 0, age: {}, sample_ids: [] };
      cur.rows += Number(r.rows) || 0;
      for (const [k, v] of Object.entries(r.age ?? {})) {
        cur.age[k] = (cur.age[k] ?? 0) + (Number(v) || 0);
      }
      cur.sample_ids = [...cur.sample_ids, ...(r.sample_ids ?? [])].slice(0, 5);
      out.set(r.reason, cur);
    }
  }
  return [...out.values()].sort((x, y) =>
    y.rows - x.rows || (x.reason < y.reason ? -1 : x.reason > y.reason ? 1 : 0)
  );
}

function num(v: unknown): number {
  return Number(v) || 0;
}

// deno-lint-ignore no-explicit-any
type Part = Record<string, any>;

/** Adds one census part to the running total. Whole-table sections come from
 * the first part only; per-phase counts and samples add up. */
export function mergeCensus(acc: Part | null, part: Part): Part {
  if (acc === null) return { ...part, calls: 1 };
  const counts = (o: Part | undefined) =>
    o && typeof o.restamped_legacy_by_prior_method === "object"
      ? o.restamped_legacy_by_prior_method
      : {};
  const restamped: Record<string, number> = { ...counts(acc.admin_bucket) };
  for (const [k, v] of Object.entries(counts(part.admin_bucket))) {
    restamped[k] = (restamped[k] ?? 0) + num(v);
  }
  return {
    ...acc,
    complete: part.complete === true,
    next: part.next ?? null,
    calls: num(acc.calls) + 1,
    elapsed_ms: num(acc.elapsed_ms) + num(part.elapsed_ms),
    admin_bucket: {
      classified: num(acc.admin_bucket?.classified) +
        num(part.admin_bucket?.classified),
      by_reason: mergeReasons(
        acc.admin_bucket?.by_reason,
        part.admin_bucket?.by_reason,
      ),
      restamped_legacy_by_prior_method: restamped,
    },
    holding_job: {
      classified: num(acc.holding_job?.classified) +
        num(part.holding_job?.classified),
      by_reason: mergeReasons(
        acc.holding_job?.by_reason,
        part.holding_job?.by_reason,
      ),
    },
    custody_multi_ref: {
      checked: num(acc.custody_multi_ref?.checked) +
        num(part.custody_multi_ref?.checked),
      rows: num(acc.custody_multi_ref?.rows) +
        num(part.custody_multi_ref?.rows),
      sample_ids: [
        ...(acc.custody_multi_ref?.sample_ids ?? []),
        ...(part.custody_multi_ref?.sample_ids ?? []),
      ].slice(0, 5),
    },
  };
}

export function rowsArgs(params: URLSearchParams): Record<string, unknown> {
  const scope = params.get("scope") || "bucket";
  if (!(UNLINKED_SCOPES as readonly string[]).includes(scope)) {
    bad(`scope must be one of ${UNLINKED_SCOPES.join(", ")}`);
  }
  const reason = params.get("reason") || null;
  if (
    reason !== null && !(UNLINKED_REASONS as readonly string[]).includes(reason)
  ) {
    bad("reason is not a known unlinked reason");
  }
  const source = params.get("source") || null;
  if (source !== null && !SOURCE.test(source)) {
    bad("source is not a source name");
  }
  const cursorAt = isoOrNull(params, "cursor_at");
  const cursorId = params.get("cursor_id") || null;
  if (cursorId !== null && !UUID.test(cursorId)) {
    bad("cursor_id must be a uuid");
  }
  if ((cursorAt === null) !== (cursorId === null)) {
    bad("cursor_at and cursor_id go together");
  }
  return {
    p_scope: scope,
    p_reason: reason,
    p_source: source,
    p_since: isoOrNull(params, "since"),
    p_cursor_at: cursorAt,
    p_cursor_id: cursorId,
    p_limit: intIn(params, "limit", 1, 100) ?? 25,
  };
}

function rpcCode(error: RpcError): string {
  const code = typeof error.code === "string" ? error.code.trim() : "";
  return /^[A-Za-z0-9_]{1,32}$/.test(code) ? code : "rpc_error_no_code";
}

async function callRpc(
  client: Rpc,
  fn: string,
  args: Record<string, unknown>,
  actor: string,
): Promise<Record<string, unknown>> {
  const { data, error } = await client.rpc(fn, args);
  if (error || !data || typeof data !== "object") {
    const e = (error && typeof error === "object" ? error : {}) as RpcError;
    const reason = error ? rpcCode(e) : "empty_payload";
    console.error(JSON.stringify({ event: `${fn}_rpc_failed`, actor, reason }));
    if (reason === "57014") {
      throw new ContextUnlinkedError(
        fn === "context_unlinked_census" ? "census_timeout" : "rows_timeout",
        504,
        "The unlinked-evidence read ran out of time.",
        { reason },
      );
    }
    if (reason === "22023") {
      throw new ContextUnlinkedError(
        "invalid_request",
        400,
        "The database refused the request parameters.",
        { reason },
      );
    }
    throw new ContextUnlinkedError(
      "context_unlinked_unavailable",
      503,
      "Unlinked evidence could not be read.",
      { reason },
    );
  }
  return data as Record<string, unknown>;
}

/** Census. Follows each part's `next` until the census is complete, at most
 * `maxCalls` calls or `maxWallMs` of wall time, adding the parts up. An
 * unfinished census is 504 census_timeout carrying the partial totals and
 * where it stopped (adminbucket F6), never a silent partial 200. */
export async function contextUnlinkedCensus(
  client: Rpc,
  params: URLSearchParams,
  actor: string,
  limits: { maxCalls?: number; maxWallMs?: number; now?: () => number } = {},
): Promise<Record<string, unknown>> {
  const maxCalls = limits.maxCalls ?? 40;
  const maxWallMs = limits.maxWallMs ?? 90_000;
  const now = limits.now ?? Date.now;
  const started = now();
  const base = censusArgs(params);
  let acc: Part | null = null;
  let next: Part | null = null;
  do {
    const args = next
      ? {
        ...base,
        p_phase: next.phase,
        p_cursor_at: next.cursor_at ?? null,
        p_cursor_id: next.cursor_id ?? null,
      }
      : base;
    const part = await callRpc(client, "context_unlinked_census", args, actor);
    acc = mergeCensus(acc, part);
    next = part.complete === true ? null : (part.next as Part | null) ?? null;
    if (part.complete !== true && !next) break;
  } while (next && num(acc.calls) < maxCalls && now() - started < maxWallMs);
  console.log(JSON.stringify({
    event: "context_unlinked_census",
    actor,
    complete: acc.complete === true,
    calls: acc.calls,
    classified: acc.admin_bucket?.classified ?? null,
    elapsed_ms: acc.elapsed_ms ?? null,
  }));
  if (acc.complete !== true) {
    throw new ContextUnlinkedError(
      "census_timeout",
      504,
      "The census ran out of time; partial totals attached.",
      { partial: acc },
    );
  }
  return acc;
}

export async function contextUnlinkedRows(
  client: Rpc,
  params: URLSearchParams,
  actor: string,
): Promise<Record<string, unknown>> {
  const args = rowsArgs(params);
  const data = await callRpc(client, "context_unlinked_rows", args, actor);
  console.log(JSON.stringify({
    event: "context_unlinked_rows",
    actor,
    scope: args.p_scope,
    reason: args.p_reason,
    returned: Array.isArray(data.rows) ? data.rows.length : null,
    scanned: data.scanned ?? null,
  }));
  return data;
}
