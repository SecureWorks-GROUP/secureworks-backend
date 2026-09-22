/** Durable Booking business records. Intentionally import-free: this module
 * has the record/list RPCs plus the shared current-outcome chain helper,
 * never messaging/provider/calendar code.
 * Contract: docs/visit-outcomes-api.md.
 */
export class VisitOutcomeError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
    this.name = "VisitOutcomeError";
  }
}

export interface VisitOutcomeAuth {
  mode: string;
  userId?: string | null;
  /** Server-owned _opsApiCallerIsStaffOperator result, never request input. */
  isStaffOperator: boolean;
}

export interface VisitOutcome {
  id: string;
  booking_key: string;
  appointment_id: string | null;
  contact_id: string;
  opportunity_id: string | null;
  job_id: string | null;
  scoper_user_id: string;
  scoper_name: string;
  visit_start: string;
  outcome: "happened" | "did_not_happen";
  reason: "customer_not_home" | "we_did_not_attend" | "rescheduled" | null;
  note: string | null;
  quote_owed: boolean;
  recorded_by_user_id: string;
  recorded_at: string;
  source: "booking_screen";
  supersedes: string | null;
}

type OutcomeInput = Omit<
  VisitOutcome,
  "id" | "recorded_by_user_id" | "recorded_at" | "source"
>;
export interface VisitOutcomePage {
  outcomes: VisitOutcome[];
  /** Present only with include_history=true; includes the current row too. */
  history?: VisitOutcome[];
  limit: number;
  offset: number;
  has_more: boolean;
}
export interface VisitOutcomeDatabase {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{
    data: unknown;
    error: { code?: string; message?: string } | null;
  }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function textField(value: unknown, name: string, max = 300): string {
  if (
    typeof value !== "string" || !value.trim() ||
    [...value.trim()].length > max ||
    // Intentional: one-line fields refuse control characters, including NUL.
    // deno-lint-ignore no-control-regex
    /[\u0000-\u001f\u007f\u0085\u2028\u2029]/u.test(value)
  ) {
    throw new VisitOutcomeError(
      `${name} must be non-empty, one line, at most ${max} characters`,
    );
  }
  return value.trim();
}
function uuidField(value: unknown, name: string): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new VisitOutcomeError(`${name} must be a UUID`);
  }
  return value.toLowerCase();
}
function nullableText(value: unknown, name: string): string | null {
  return value === undefined || value === null ? null : textField(value, name);
}
function nullableUuid(value: unknown, name: string): string | null {
  return value === undefined || value === null ? null : uuidField(value, name);
}

/** Explicit offset required; reject JS date rollover (e.g. February 30). */
function instant(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/
      .test(value)
  ) {
    throw new VisitOutcomeError(`${name} must be an ISO timestamp with offset`);
  }
  const local = value.slice(0, 19);
  const localMs = Date.parse(`${local}Z`);
  const ms = Date.parse(value);
  if (
    !Number.isFinite(localMs) || !Number.isFinite(ms) ||
    new Date(localMs).toISOString().slice(0, 19) !== local
  ) {
    throw new VisitOutcomeError(`${name} must be a real timestamp`);
  }
  return new Date(ms).toISOString();
}

export function parseVisitOutcome(body: unknown): OutcomeInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new VisitOutcomeError("Expected a JSON object");
  }
  const b = body as Record<string, unknown>;
  if (b.outcome !== "happened" && b.outcome !== "did_not_happen") {
    throw new VisitOutcomeError("outcome must be happened or did_not_happen");
  }
  const reason = b.reason ?? null;
  if (
    b.outcome === "happened" ? reason !== null : (typeof reason !== "string" ||
      !["customer_not_home", "we_did_not_attend", "rescheduled"].includes(
        reason,
      ))
  ) {
    throw new VisitOutcomeError(
      "reason must be null for happened, or a listed reason for did_not_happen",
    );
  }
  if (b.quote_owed !== undefined && typeof b.quote_owed !== "boolean") {
    throw new VisitOutcomeError("quote_owed must be boolean");
  }
  return {
    booking_key: textField(b.booking_key, "booking_key"),
    appointment_id: nullableText(b.appointment_id, "appointment_id"),
    contact_id: textField(b.contact_id, "contact_id"),
    opportunity_id: nullableText(b.opportunity_id, "opportunity_id"),
    job_id: nullableUuid(b.job_id, "job_id"),
    scoper_user_id: uuidField(b.scoper_user_id, "scoper_user_id"),
    scoper_name: textField(b.scoper_name, "scoper_name", 200),
    visit_start: instant(b.visit_start, "visit_start"),
    outcome: b.outcome,
    reason: reason as OutcomeInput["reason"],
    note: b.note === undefined || b.note === null || b.note === ""
      ? null
      : textField(b.note, "note", 200),
    quote_owed: b.quote_owed === undefined
      ? b.outcome === "happened"
      : b.quote_owed,
    supersedes: nullableUuid(b.supersedes, "supersedes"),
  };
}

function authorize(auth: VisitOutcomeAuth, write: boolean): void {
  if (write && (auth.mode !== "jwt" || !auth.userId)) {
    throw new VisitOutcomeError(
      "record_visit_outcome requires a signed-in user",
      401,
    );
  }
  if (!auth.isStaffOperator || !["jwt", "api_key"].includes(auth.mode)) {
    throw new VisitOutcomeError(
      "An authorised booking operator is required",
      403,
    );
  }
}
async function callRpc<T>(
  db: VisitOutcomeDatabase,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await db.rpc(name, args);
  if (error) {
    if (error.code === "23505" || error.code === "P0001") {
      throw new VisitOutcomeError(
        error.message || "Outcome correction conflict",
        409,
      );
    }
    if (["23514", "23502", "22P02", "22007"].includes(error.code || "")) {
      throw new VisitOutcomeError(error.message || "Invalid outcome", 400);
    }
    console.error(`${name} failed`, error);
    throw new VisitOutcomeError("Visit outcome store unavailable", 503);
  }
  if (data === null || data === undefined) {
    throw new VisitOutcomeError("Visit outcome store returned no result", 503);
  }
  return data as T;
}

export async function recordVisitOutcomeAction(
  db: VisitOutcomeDatabase,
  auth: VisitOutcomeAuth,
  body: unknown,
  method = "POST",
): Promise<{ visit_outcome: VisitOutcome }> {
  if (method !== "POST") {
    throw new VisitOutcomeError("record_visit_outcome requires POST", 405);
  }
  authorize(auth, true);
  const record = parseVisitOutcome(body);
  const result = await callRpc<VisitOutcome | VisitOutcome[]>(
    db,
    "record_visit_outcome",
    {
      p_record: record,
      p_recorded_by_user_id: uuidField(auth.userId, "authenticated user id"),
    },
  );
  // Composite RPC responses can be a singleton array; the HTTP contract is
  // always one row, never an array or an empty success.
  const row = Array.isArray(result)
    ? (result.length === 1 ? result[0] : null)
    : result;
  if (!row || typeof row !== "object" || typeof row.id !== "string") {
    throw new VisitOutcomeError(
      "Visit outcome store returned an invalid record",
      503,
    );
  }
  return { visit_outcome: row };
}

export async function listVisitOutcomesAction(
  db: VisitOutcomeDatabase,
  auth: VisitOutcomeAuth,
  query: Record<string, unknown>,
  method = "GET",
): Promise<VisitOutcomePage> {
  if (method !== "GET") {
    throw new VisitOutcomeError("list_visit_outcomes requires GET", 405);
  }
  authorize(auth, false);
  const since = instant(query.since, "since");
  const until = instant(query.until, "until");
  const duration = Date.parse(until) - Date.parse(since);
  if (duration <= 0 || duration > 366 * 86_400_000) {
    throw new VisitOutcomeError(
      "Date range must be positive and at most 366 days",
    );
  }
  const integer = (
    value: unknown,
    name: string,
    fallback: number,
    min: number,
    max: number,
  ) => {
    const n = value === undefined || value === null ? fallback : Number(value);
    if (
      !Number.isSafeInteger(n) || n < min || n > max || value === "" ||
      typeof value === "boolean"
    ) {
      throw new VisitOutcomeError(
        `${name} must be an integer from ${min} to ${max}`,
      );
    }
    return n;
  };
  const history = query.include_history ?? false;
  if (![true, false, "true", "false"].includes(history as boolean | string)) {
    throw new VisitOutcomeError("include_history must be true or false");
  }
  return await callRpc<VisitOutcomePage>(db, "list_visit_outcomes", {
    p_since: since,
    p_until: until,
    p_scoper_user_id: nullableUuid(query.scoper_user_id, "scoper_user_id"),
    p_contact_id: nullableText(query.contact_id, "contact_id"),
    p_include_history: history === true || history === "true",
    p_limit: integer(query.limit, "limit", 100, 1, 500),
    p_offset: integer(query.offset, "offset", 0, 0, 1_000_000),
  });
}

/** A complete correction chain has one root and one tip, without missing links.
 * Never choose the latest timestamp when the append-only lineage is incomplete. */
export function currentVisitOutcome(
  history: VisitOutcome[],
): VisitOutcome | null {
  if (!history.length) return null;
  const byId = new Map(history.map((row) => [row.id, row]));
  if (
    byId.size !== history.length ||
    new Set(history.map((r) => r.booking_key)).size !== 1
  ) return null;
  const superseded = new Set(
    history.map((row) => row.supersedes).filter(Boolean),
  );
  const tips = history.filter((row) => !superseded.has(row.id));
  if (tips.length !== 1) return null;
  let row: VisitOutcome | undefined = tips[0];
  const seen = new Set<string>();
  while (row) {
    if (seen.has(row.id)) return null;
    seen.add(row.id);
    if (!row.supersedes) break;
    row = byId.get(row.supersedes);
    if (!row) return null;
  }
  return seen.size === history.length ? tips[0] : null;
}
