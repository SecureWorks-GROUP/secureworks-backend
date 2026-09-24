// Luna door: the one narrow way a local context reader (a reader on the owner's
// Mac, which holds no database key) reaches the Luna EXTRACTION path.
//
// Contract: docs/context/luna-door.md. In short:
//   - POST ops-api?action=luna_door with body `{ op, args }`.
//   - Credential: OPS_AGENT_SERVER_KEY only (a server-only secret). The
//     browser-distributed SW_API_KEY, the service-role key, the routine key and
//     every signed-in user session are refused, because this door writes
//     context facts, spends the shared 400-a-day model-call allowance and reads
//     full client message rows.
//   - Actor: `x-sw-actor` is required and must start with `luna-local:`. It is
//     recorded on the ops-api request log line like every other call.
//   - `op` is from a closed list. Each op maps to exactly one fixed database
//     call (a named rpc, or a fixed select equal to the Railway worker's own),
//     with arguments validated here. No table, column, filter or rpc name ever
//     comes from the caller. The attribution phase is not exposed.
//   - Everything runs server-side under the service role; the response carries
//     only `{ data, error }` from that one call, the same shape supabase-js
//     hands the worker.
//
// Two server-side guards go beyond a pass-through, both narrowing only:
//   - `claim_extraction_run` first renews the caller's pass lease (the worker
//     does the same before every claim), then refuses when `tick_max_jobs`
//     extraction runs were already claimed inside the last `tick_max_seconds`
//     (both from `context_cadence_policy()`), the server-side form of the
//     worker's per-tick job bound.
//   - Job-scoped reads (events, event flags, the job row, current facts) are
//     served only while the caller holds that job's live extraction run lease.
// The 400-a-day cap, per-job run ceilings, pacing and lease fencing stay where
// they are: inside the SQL functions, which this door calls unchanged.

export const LUNA_DOOR_ACTION = "luna_door";
export const LUNA_DOOR_ACTOR_PREFIX = "luna-local:";
/** The worker's own constants (secureworks-jarvis luna-context-worker.ts). */
export const LUNA_DOOR_CANDIDATE_LIMIT = 400;
export const LUNA_DOOR_EVENTS_PER_RUN = 25;
/** luna-job-extractor.ts reads current facts in pages of 200 and stops at 10,000. */
export const LUNA_DOOR_FACTS_PAGE = 200;
export const LUNA_DOOR_FACTS_MAX_OFFSET = 10_000 - LUNA_DOOR_FACTS_PAGE;
export const LUNA_DOOR_MAX_TRANSITIONS = 200;
export const LUNA_DOOR_MAX_BODY_BYTES = 6 * 1024 * 1024;
/** The only feature flags the worker reads on this path. */
export const LUNA_DOOR_FLAGS = new Set([
  "context_job_brief_v1",
  "context_job_brief_single_call_v1",
  "context_luna_fallback_claude_v1",
]);
/** The only automation lane this door reports. Attribution is not exposed. */
export const LUNA_DOOR_LANES = new Set(["extraction"]);

export type LunaDoorOp =
  | "lane_enabled"
  | "claim_pass"
  | "cadence_policy"
  | "renew_pass"
  | "extraction_candidates"
  | "revision_rpc_probe"
  | "feature_flag"
  | "claim_extraction_run"
  | "extraction_events"
  | "extraction_event_flags"
  | "job_row"
  | "current_facts_page"
  | "renew_extraction_run"
  | "reserve_model_call"
  | "persist_revision"
  | "finish_extraction_run"
  | "finish_pass";

/** The permitted argument names for each op. Any other key is refused. */
export const LUNA_DOOR_OP_ARGS: Readonly<
  Record<LunaDoorOp, readonly string[]>
> = {
  lane_enabled: ["lane"],
  claim_pass: ["run_date"],
  cadence_policy: [],
  renew_pass: ["run_date", "lease_token"],
  extraction_candidates: ["limit"],
  revision_rpc_probe: [],
  feature_flag: ["flag"],
  claim_extraction_run: ["job_id", "run_date", "pass_lease_token"],
  extraction_events: ["job_id", "run_id", "lease_token", "limit"],
  extraction_event_flags: ["job_id", "run_id", "lease_token", "event_ids"],
  job_row: ["job_id", "run_id", "lease_token"],
  current_facts_page: ["job_id", "run_id", "lease_token", "offset"],
  renew_extraction_run: ["run_id", "lease_token"],
  reserve_model_call: ["run_id", "lease_token"],
  persist_revision: [
    "run_id",
    "lease_token",
    "job_id",
    "events",
    "new",
    "supersedes",
    "retracts",
    "tokens_in",
  ],
  finish_extraction_run: [
    "run_id",
    "lease_token",
    "status",
    "event_ids",
    "tokens_in",
    "facts_new",
    "facts_superseded",
    "facts_retracted",
    "error",
    "retry_at",
  ],
  finish_pass: ["run_date", "lease_token", "status", "retry_at", "error"],
};

export const LUNA_DOOR_OPS: ReadonlySet<string> = new Set(
  Object.keys(LUNA_DOOR_OP_ARGS),
);

/** What one database call returned, in supabase-js's own shape. */
export interface LunaDoorResult {
  data: unknown;
  error: { message: string; code: string | null } | null;
}

/**
 * The fixed database calls. Each method is exactly one call with fixed shape;
 * `supabaseLunaDoorDb` is the only production implementation.
 */
export interface LunaDoorDb {
  rpc(
    name: LunaDoorRpc,
    args: Record<string, unknown>,
  ): Promise<LunaDoorResult>;
  featureFlag(flag: string): Promise<LunaDoorResult>;
  jobRow(jobId: string): Promise<LunaDoorResult>;
  currentFactsPage(jobId: string, offset: number): Promise<LunaDoorResult>;
  /** Guard read: is this exact extraction run live and held by this token? */
  heldExtractionRun(
    runId: string,
    leaseToken: string,
    jobId: string,
    nowIso: string,
  ): Promise<LunaDoorResult>;
  /** Guard read: extraction runs claimed for this date inside the window. */
  recentExtractionClaims(
    runDate: string,
    nowIso: string,
    sinceIso: string,
    cap: number,
  ): Promise<LunaDoorResult>;
}

/** Every rpc this door can name. A closed union, never a caller string. */
export type LunaDoorRpc =
  | "automation_lane_enabled"
  | "claim_context_pass"
  | "context_cadence_policy"
  | "renew_context_pass"
  | "context_extraction_candidates"
  | "persist_luna_context_revision"
  | "claim_context_extraction_run"
  | "context_extraction_events"
  | "context_extraction_event_flags"
  | "renew_context_extraction_run"
  | "reserve_context_model_call"
  | "finish_context_extraction_run"
  | "finish_context_pass";

export const LUNA_DOOR_RPCS: ReadonlySet<LunaDoorRpc> = new Set<LunaDoorRpc>([
  "automation_lane_enabled",
  "claim_context_pass",
  "context_cadence_policy",
  "renew_context_pass",
  "context_extraction_candidates",
  "persist_luna_context_revision",
  "claim_context_extraction_run",
  "context_extraction_events",
  "context_extraction_event_flags",
  "renew_context_extraction_run",
  "reserve_context_model_call",
  "finish_context_extraction_run",
  "finish_context_pass",
]);

export class LunaDoorError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "LunaDoorError";
  }
}

// ── Authorisation ──────────────────────────────────────────────────────────

export interface LunaDoorCredentialInput {
  xApiKey: string | null;
  bearerToken: string | null;
  /** OPS_AGENT_SERVER_KEY. */
  agentServerKey: string | null | undefined;
  /** SW_API_KEY (browser-distributed). */
  sharedKey: string | null | undefined;
  serviceKey: string | null | undefined;
  routineKey: string | null | undefined;
}

/**
 * True only when OPS_AGENT_SERVER_KEY is configured, distinct from every other
 * credential, and is the ONLY credential on the request. Presenting any other
 * value alongside it (SW_API_KEY in x-api-key, a user JWT in Bearer) refuses,
 * so a browser request can never ride this door.
 */
export function lunaDoorCredentialOk(input: LunaDoorCredentialInput): boolean {
  const agent = input.agentServerKey || "";
  if (!agent) return false;
  if (
    agent === input.sharedKey || agent === input.serviceKey ||
    agent === input.routineKey
  ) return false;
  const presented = [input.xApiKey, input.bearerToken].filter((v) =>
    v !== null && v !== undefined && v !== ""
  );
  if (!presented.length) return false;
  return presented.every((v) => v === agent);
}

export interface LunaDoorActorInput {
  actor: string;
  source: string;
}

/** The trusted `x-sw-actor` header, required, prefixed `luna-local:`. */
export function lunaDoorActorOk(actor: LunaDoorActorInput): boolean {
  return actor.source === "header" &&
    actor.actor.startsWith(LUNA_DOOR_ACTOR_PREFIX) &&
    actor.actor.length > LUNA_DOOR_ACTOR_PREFIX.length;
}

export function authorizeLunaDoor(input: {
  method: string;
  credential: LunaDoorCredentialInput;
  actor: LunaDoorActorInput;
}): void {
  if (!lunaDoorCredentialOk(input.credential)) {
    throw new LunaDoorError(
      403,
      "luna_door_credential_refused",
      "The Luna door accepts only the server agent credential.",
    );
  }
  if (!lunaDoorActorOk(input.actor)) {
    throw new LunaDoorError(
      403,
      "luna_door_actor_refused",
      `The Luna door requires an x-sw-actor starting with '${LUNA_DOOR_ACTOR_PREFIX}'.`,
    );
  }
  if (input.method !== "POST") {
    throw new LunaDoorError(405, "luna_door_method", "luna_door requires POST");
  }
}

// ── Argument validation ────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ERROR_CODE_RE = /^[a-z0-9_.:-]{1,120}$/i;

function invalid(detail: string): never {
  throw new LunaDoorError(400, "luna_door_args_invalid", detail);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function uuid(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || !UUID_RE.test(v)) {
    invalid(`${key} must be a uuid`);
  }
  return v;
}

function date(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || !DATE_RE.test(v)) {
    invalid(`${key} must be YYYY-MM-DD`);
  }
  const parsed = new Date(`${v}T00:00:00Z`);
  if (
    Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== v
  ) {
    invalid(`${key} must be a real date`);
  }
  return v;
}

function int(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number {
  const v = args[key];
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) {
    invalid(`${key} must be an integer ${min}..${max}`);
  }
  return v;
}

function optionalInt(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  fallback: number,
): number {
  return args[key] === undefined ? fallback : int(args, key, min, max);
}

function oneOf<T extends string>(
  args: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T {
  const v = args[key];
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
    invalid(`${key} must be one of ${allowed.join(", ")}`);
  }
  return v as T;
}

function uuidList(
  args: Record<string, unknown>,
  key: string,
  max: number,
): string[] {
  const v = args[key];
  if (!Array.isArray(v) || v.length > max) {
    invalid(`${key} must be an array of at most ${max} uuids`);
  }
  for (const item of v) {
    if (typeof item !== "string" || !UUID_RE.test(item)) {
      invalid(`${key} must contain uuids only`);
    }
  }
  return v as string[];
}

function objectList(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): Record<string, unknown>[] {
  const v = args[key];
  if (!Array.isArray(v) || v.length < min || v.length > max) {
    invalid(`${key} must be an array of ${min}..${max} objects`);
  }
  if (!v.every(isPlainObject)) invalid(`${key} must contain objects only`);
  return v as Record<string, unknown>[];
}

function nullableIso(
  args: Record<string, unknown>,
  key: string,
): string | null {
  const v = args[key];
  if (v === null || v === undefined) return null;
  if (typeof v !== "string" || v.length > 40 || Number.isNaN(Date.parse(v))) {
    invalid(`${key} must be an ISO timestamp or null`);
  }
  return v;
}

function nullableErrorCode(
  args: Record<string, unknown>,
  key: string,
): string | null {
  const v = args[key];
  if (v === null || v === undefined) return null;
  if (typeof v !== "string" || !ERROR_CODE_RE.test(v)) {
    invalid(`${key} must be a short error code or null`);
  }
  return v;
}

/** Parse `{ op, args }`: closed op list, closed argument names, no extras. */
export function parseLunaDoorRequest(
  body: unknown,
): { op: LunaDoorOp; args: Record<string, unknown> } {
  if (!isPlainObject(body)) invalid("body must be { op, args }");
  for (const key of Object.keys(body)) {
    if (key !== "op" && key !== "args") invalid(`unknown body field '${key}'`);
  }
  const op = body.op;
  if (typeof op !== "string" || !LUNA_DOOR_OPS.has(op)) {
    throw new LunaDoorError(
      400,
      "luna_door_op_unknown",
      "op is not on the Luna door allow-list",
    );
  }
  const args = body.args === undefined ? {} : body.args;
  if (!isPlainObject(args)) invalid("args must be an object");
  const allowed = LUNA_DOOR_OP_ARGS[op as LunaDoorOp];
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) invalid(`unknown argument '${key}' for ${op}`);
  }
  return { op: op as LunaDoorOp, args };
}

// ── Dispatch ───────────────────────────────────────────────────────────────

async function requireHeldRun(
  db: LunaDoorDb,
  args: Record<string, unknown>,
  now: Date,
): Promise<string> {
  const jobId = uuid(args, "job_id");
  const runId = uuid(args, "run_id");
  const leaseToken = uuid(args, "lease_token");
  const held = await db.heldExtractionRun(
    runId,
    leaseToken,
    jobId,
    now.toISOString(),
  );
  if (held.error) {
    throw new LunaDoorError(
      503,
      "luna_door_guard_unreadable",
      "The run lease could not be read.",
    );
  }
  const row = held.data as { id?: unknown } | null;
  if (!row || row.id !== runId) {
    throw new LunaDoorError(
      409,
      "luna_door_run_not_held",
      "The caller does not hold a live extraction run for this job.",
    );
  }
  return jobId;
}

/** tick_max_jobs / tick_max_seconds from the one policy, never a constant. */
async function tickBound(
  db: LunaDoorDb,
): Promise<{ maxJobs: number; maxSeconds: number }> {
  const policy = await db.rpc("context_cadence_policy", {});
  const p = policy.data as Record<string, unknown> | null;
  const maxJobs = Number(p?.tick_max_jobs);
  const maxSeconds = Number(p?.tick_max_seconds);
  if (
    policy.error || !Number.isSafeInteger(maxJobs) || maxJobs < 1 ||
    !Number.isSafeInteger(maxSeconds) || maxSeconds < 1
  ) {
    throw new LunaDoorError(
      503,
      "luna_door_guard_unreadable",
      "The cadence policy could not be read.",
    );
  }
  return { maxJobs, maxSeconds };
}

export async function runLunaDoor(
  db: LunaDoorDb,
  body: unknown,
  now: Date = new Date(),
): Promise<LunaDoorResult & { op: LunaDoorOp }> {
  const bytes = new TextEncoder().encode(JSON.stringify(body ?? null)).length;
  if (bytes > LUNA_DOOR_MAX_BODY_BYTES) {
    throw new LunaDoorError(
      413,
      "luna_door_body_too_large",
      `body exceeds ${LUNA_DOOR_MAX_BODY_BYTES} bytes`,
    );
  }
  const { op, args } = parseLunaDoorRequest(body);
  const out = (r: LunaDoorResult) => ({ op, data: r.data, error: r.error });

  switch (op) {
    case "lane_enabled":
      // A1/C1/D8/D12. Extraction only.
      return out(
        await db.rpc("automation_lane_enabled", {
          lane: oneOf(args, "lane", [...LUNA_DOOR_LANES]),
        }),
      );
    case "claim_pass":
      // A2. SQL refuses any date that is not Perth today.
      return out(
        await db.rpc("claim_context_pass", {
          p_run_date: date(args, "run_date"),
        }),
      );
    case "cadence_policy":
      // A3.
      return out(await db.rpc("context_cadence_policy", {}));
    case "renew_pass":
      // A4/D1.
      return out(
        await db.rpc("renew_context_pass", {
          p_run_date: date(args, "run_date"),
          p_lease_token: uuid(args, "lease_token"),
        }),
      );
    case "extraction_candidates":
      // C2.
      return out(
        await db.rpc("context_extraction_candidates", {
          p_limit: optionalInt(
            args,
            "limit",
            1,
            LUNA_DOOR_CANDIDATE_LIMIT,
            LUNA_DOOR_CANDIDATE_LIMIT,
          ),
        }),
      );
    case "revision_rpc_probe":
      // C3. Nine nulls select the J2 overload, which raises
      // luna_job_revision_invalid and writes nothing.
      return out(
        await db.rpc("persist_luna_context_revision", {
          p_run_id: null,
          p_lease_token: null,
          p_job_id: null,
          p_events: null,
          p_new: null,
          p_supersedes: null,
          p_retracts: null,
          p_extractor_version: null,
          p_tokens_in: null,
        }),
      );
    case "feature_flag":
      // C4/C5/D11.
      return out(
        await db.featureFlag(oneOf(args, "flag", [...LUNA_DOOR_FLAGS])),
      );
    case "claim_extraction_run": {
      // D2, behind D1 (the worker renews the pass before every claim) and the
      // server-side tick bound.
      const jobId = uuid(args, "job_id");
      const runDate = date(args, "run_date");
      const passLease = uuid(args, "pass_lease_token");
      const renewed = await db.rpc("renew_context_pass", {
        p_run_date: runDate,
        p_lease_token: passLease,
      });
      if (renewed.error || renewed.data !== true) {
        throw new LunaDoorError(
          409,
          "luna_door_pass_lease_lost",
          "The caller does not hold the context pass.",
        );
      }
      const bound = await tickBound(db);
      const since = new Date(now.getTime() - bound.maxSeconds * 1000);
      const recent = await db.recentExtractionClaims(
        runDate,
        now.toISOString(),
        since.toISOString(),
        bound.maxJobs,
      );
      if (recent.error || !Array.isArray(recent.data)) {
        throw new LunaDoorError(
          503,
          "luna_door_guard_unreadable",
          "Recent extraction claims could not be read.",
        );
      }
      if (recent.data.length >= bound.maxJobs) {
        throw new LunaDoorError(
          429,
          "luna_door_tick_max_jobs",
          `At most ${bound.maxJobs} extraction runs per ${bound.maxSeconds} seconds.`,
        );
      }
      return out(
        await db.rpc("claim_context_extraction_run", {
          p_job_id: jobId,
          p_run_date: runDate,
          p_phase: "extraction",
        }),
      );
    }
    case "extraction_events": {
      // D3. Every argument is validated before the guard read.
      const limit = optionalInt(
        args,
        "limit",
        1,
        LUNA_DOOR_EVENTS_PER_RUN,
        LUNA_DOOR_EVENTS_PER_RUN,
      );
      const jobId = await requireHeldRun(db, args, now);
      return out(
        await db.rpc("context_extraction_events", {
          p_job_id: jobId,
          p_limit: limit,
        }),
      );
    }
    case "extraction_event_flags": {
      // D4.
      const eventIds = uuidList(args, "event_ids", LUNA_DOOR_EVENTS_PER_RUN);
      const jobId = await requireHeldRun(db, args, now);
      return out(
        await db.rpc("context_extraction_event_flags", {
          p_job_id: jobId,
          p_event_ids: eventIds,
        }),
      );
    }
    case "job_row": {
      // D5.
      const jobId = await requireHeldRun(db, args, now);
      return out(await db.jobRow(jobId));
    }
    case "current_facts_page": {
      // D6.
      const offset = int(args, "offset", 0, LUNA_DOOR_FACTS_MAX_OFFSET);
      if (offset % LUNA_DOOR_FACTS_PAGE !== 0) {
        invalid(`offset must be a multiple of ${LUNA_DOOR_FACTS_PAGE}`);
      }
      const jobId = await requireHeldRun(db, args, now);
      return out(await db.currentFactsPage(jobId, offset));
    }
    case "renew_extraction_run":
      // D9.
      return out(
        await db.rpc("renew_context_extraction_run", {
          p_run_id: uuid(args, "run_id"),
          p_lease_token: uuid(args, "lease_token"),
        }),
      );
    case "reserve_model_call":
      // D10. Phase fixed to extraction; the 400-a-day cap is the rpc's own.
      return out(
        await db.rpc("reserve_context_model_call", {
          p_phase: "extraction",
          p_run_id: uuid(args, "run_id"),
          p_lease_token: uuid(args, "lease_token"),
        }),
      );
    case "persist_revision":
      // D13. Extractor version fixed to the worker's.
      return out(
        await db.rpc("persist_luna_context_revision", {
          p_run_id: uuid(args, "run_id"),
          p_lease_token: uuid(args, "lease_token"),
          p_job_id: uuid(args, "job_id"),
          p_events: objectList(args, "events", 1, LUNA_DOOR_EVENTS_PER_RUN),
          p_new: objectList(args, "new", 0, LUNA_DOOR_MAX_TRANSITIONS),
          p_supersedes: objectList(
            args,
            "supersedes",
            0,
            LUNA_DOOR_MAX_TRANSITIONS,
          ),
          p_retracts: objectList(
            args,
            "retracts",
            0,
            LUNA_DOOR_MAX_TRANSITIONS,
          ),
          p_extractor_version: "luna_v2",
          p_tokens_in: int(args, "tokens_in", 0, 2_000_000_000),
        }),
      );
    case "finish_extraction_run": {
      // D14.
      const status = oneOf(args, "status", ["done", "failed"] as const);
      const eventIds = uuidList(args, "event_ids", LUNA_DOOR_EVENTS_PER_RUN);
      if (status === "failed" && eventIds.length) {
        invalid("a failed run acknowledges no events");
      }
      return out(
        await db.rpc("finish_context_extraction_run", {
          p_run_id: uuid(args, "run_id"),
          p_lease_token: uuid(args, "lease_token"),
          p_status: status,
          p_event_ids: eventIds,
          p_tokens_in: int(args, "tokens_in", 0, 2_000_000_000),
          p_facts_new: int(args, "facts_new", 0, 100_000),
          p_facts_superseded: int(args, "facts_superseded", 0, 100_000),
          p_facts_retracted: int(args, "facts_retracted", 0, 100_000),
          p_error: nullableErrorCode(args, "error"),
          p_retry_at: nullableIso(args, "retry_at"),
        }),
      );
    }
    case "finish_pass":
      // E1.
      return out(
        await db.rpc("finish_context_pass", {
          p_run_date: date(args, "run_date"),
          p_lease_token: uuid(args, "lease_token"),
          p_status: oneOf(args, "status", ["done", "failed"] as const),
          p_retry_at: nullableIso(args, "retry_at"),
          p_error: nullableErrorCode(args, "error"),
        }),
      );
  }
}

// ── The production database binding ────────────────────────────────────────

/** Only the message and code of a database error leave the server. */
export function lunaDoorError(
  error: { message?: unknown; code?: unknown } | null | undefined,
): LunaDoorResult["error"] {
  if (!error) return null;
  return {
    message: String(error.message ?? "database_error").slice(0, 500),
    code: typeof error.code === "string" ? error.code : null,
  };
}

// deno-lint-ignore no-explicit-any
type AnyClient = any;

/** Binds the fixed calls to a service-role supabase-js client. */
export function supabaseLunaDoorDb(client: AnyClient): LunaDoorDb {
  const wrap = async (
    p: PromiseLike<{ data: unknown; error: unknown }>,
  ): Promise<LunaDoorResult> => {
    const { data, error } = await p;
    return {
      data: error ? null : data ?? null,
      error: lunaDoorError(error as { message?: unknown; code?: unknown }),
    };
  };
  return {
    rpc: (name, args) => {
      if (!LUNA_DOOR_RPCS.has(name)) {
        throw new LunaDoorError(500, "luna_door_rpc_unknown", "rpc not bound");
      }
      return wrap(client.rpc(name, args));
    },
    featureFlag: (flag) =>
      wrap(
        client.from("feature_flags").select("enabled").eq("flag_name", flag)
          .maybeSingle(),
      ),
    jobRow: (jobId) =>
      wrap(
        client.from("jobs").select(
          "id,job_number,type,status,site_suburb,ghl_contact_id",
        ).eq("id", jobId).single(),
      ),
    currentFactsPage: (jobId, offset) =>
      wrap(
        client.from("current_job_context_facts").select("*").eq(
          "job_id",
          jobId,
        ).order("id").order("_context_store").range(
          offset,
          offset + LUNA_DOOR_FACTS_PAGE - 1,
        ),
      ),
    heldExtractionRun: (runId, leaseToken, jobId, nowIso) =>
      wrap(
        client.from("context_extraction_runs").select("id")
          .eq("id", runId)
          .eq("lease_token", leaseToken)
          .eq("job_id", jobId)
          .eq("phase", "extraction")
          .eq("status", "running")
          .gt("lease_expires_at", nowIso)
          .maybeSingle(),
      ),
    recentExtractionClaims: (runDate, nowIso, sinceIso, cap) =>
      wrap(
        client.from("context_extraction_runs").select("id")
          .eq("run_date", runDate)
          .eq("phase", "extraction")
          .or(
            `and(status.eq.running,lease_expires_at.gt."${nowIso}"),finished_at.gt."${sinceIso}"`,
          )
          .limit(cap),
      ),
  };
}
