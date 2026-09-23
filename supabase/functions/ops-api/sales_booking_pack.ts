import {
  DEFAULT_SALES_BOOKING_CAPTAIN_EMAIL,
  parseSalesBookingCaptainEmails,
} from "../_shared/booking_approval_gate.ts";
import {
  applyBookingConfirmationModels,
  selectBookingModels,
} from "./sales_booking_confirmation.ts";
// ════════════════════════════════════════════════════════════
// SALES BOOKING PACK STORE — engine pack + captain stamp + thread facts
// ════════════════════════════════════════════════════════════
//
// One table, four kinds. `sales_booking_pack_publish` stores the engine's
// proposals.json / coverage.json / drafts map (kind=pack). Additive
// `booking_read_models` and independent approvals:
// docs/sales-booking-confirmation-api.md.
// The legacy captain KEEP/CUT stamp (kind=stamp) is read-only now:
// `sales_booking_stamp_write` was retired 2026-09-23 (no live caller; the
// separate-v1 approvals replaced it). `sales_booking_stamp_read` still returns
// the latest stored stamp. `assertSalesBookingStampWriteAuth` survives as the
// captain gate for booking approvals: only a verified Supabase JWT whose email
// is on SALES_BOOKING_CAPTAIN_EMAILS passes; the ops API key and every other
// JWT are 403 `stamp_write_requires_captain`.
// `sales_booking_threads_refresh` re-reads GHL threads into kind=thread_facts.
// `sales_booking_read` also persists kind=roster (opportunity enumeration
// cache) on that same table; this module does not read or write it.
// `sales_booking_read` merges the latest pack onto cases by opportunity id
// (`opp:<id>` → case opportunity id) and fills drafts + stamp_state. It also
// publishes `pack.proposals` from every pack lead, keyed by opportunity id
// (or the lead id when there is none), independent of the roster and stage
// filter.
//
// Env (read at call time, not module load):
//   SALES_BOOKING_CAPTAIN_EMAILS — comma-separated JWT emails treated as the
//     captain. Case-insensitive. Unset or blank defaults to
//     marnin@secureworkswa.com.au.
//
// No send, no calendar write, no GHL write.

import {
  emptySalesBookingPackView,
  perthWeekWindow,
  resolveSalesBookingResource,
  SALES_BOOKING_MAX_THREAD_LIMIT,
  type SalesBookingCase,
  type SalesBookingCaseProposal,
  type SalesBookingPackProposal,
  salesBookingReadAction,
  type SalesBookingReadResponse,
  SalesBookingRequestError,
  type SalesBookingStampState,
} from "./sales_booking_read.ts";

export const SALES_BOOKING_PACK_KIND = "pack" as const;
export const SALES_BOOKING_STAMP_KIND = "stamp" as const;
export const SALES_BOOKING_THREAD_FACTS_KIND = "thread_facts" as const;

export type SalesBookingStampDecision = "hold" | "replace";
export type {
  SalesBookingCaseProposal,
  SalesBookingPackProposal,
  SalesBookingStampState,
};

export interface SalesBookingStampPayload {
  captain: string | null;
  approved: string[];
  rejected: string[];
  decisions: Record<string, SalesBookingStampDecision>;
  stage_moves: Array<{ id: string; to_stage_id: string }>;
}

export interface SalesBookingPackPayload {
  booking_read_models?: unknown;
  proposals: unknown;
  coverage: unknown;
  drafts: Record<string, string>;
}

export interface SalesBookingPackRow {
  id: string;
  as_of: string;
  payload: Record<string, unknown>;
}

export interface SalesBookingPackOverlay {
  pack: SalesBookingPackRow | null;
  stamp: SalesBookingPackRow | null;
  pack_error: string | null;
  stamp_error: string | null;
}

export interface SalesBookingPackAuth {
  mode: "api_key" | "jwt" | "routine" | "agent_read" | "none";
  role?: string | null;
  userId?: string | null;
  email?: string | null;
}

export type SalesBookingEnvGet = (name: string) => string | undefined;

export const SALES_BOOKING_CAPTAIN_EMAILS_ENV = "SALES_BOOKING_CAPTAIN_EMAILS";
export { DEFAULT_SALES_BOOKING_CAPTAIN_EMAIL, parseSalesBookingCaptainEmails };
export const STAMP_WRITE_REQUIRES_CAPTAIN = "stamp_write_requires_captain";

const defaultEnvGet: SalesBookingEnvGet = (name) => Deno.env.get(name);

export class SalesBookingPackError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "SalesBookingPackError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string").map((item) => item);
}

/** Strip `opp:` so a pack row id maps onto the case opportunity id. */
export function salesBookingPackOpportunityId(rowId: unknown): string | null {
  const raw = typeof rowId === "string" ? rowId.trim() : "";
  if (!raw) return null;
  // Pack row ids are `opp:<ghlOpportunityId>`. Do not strip `opp-`: that prefix
  // is a live GHL opportunity id in the booking-read fixtures (and can be one
  // in production).
  if (raw.startsWith("opp:")) return raw.slice(4) || null;
  return raw;
}

/** Engine proposals.json is a top-level array or `{leads}`. */
export function salesBookingPackProposalRows(
  proposals: unknown,
): Record<string, unknown>[] {
  if (Array.isArray(proposals)) {
    return proposals.filter(isObject);
  }
  if (!isObject(proposals)) return [];
  if (Array.isArray(proposals.leads)) {
    return proposals.leads.filter(isObject);
  }
  return [];
}

function optionalPackString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function packWindowDay(window: unknown): string | null {
  if (!isObject(window)) return null;
  return typeof window.day === "string" ? window.day : null;
}

/**
 * Full pack-lead map for the Booking door. Keyed by `opportunity_id`, or by
 * the lead `id` when there is none. Every lead is included; the door filters.
 * Independent of the roster, stage filter, and thread budget.
 */
export function salesBookingPackProposalsMap(
  proposals: unknown,
  drafts: Record<string, string> = {},
): Record<string, SalesBookingPackProposal> {
  const out: Record<string, SalesBookingPackProposal> = {};
  for (const row of salesBookingPackProposalRows(proposals)) {
    const opportunityId = optionalPackString(row.opportunity_id);
    const leadId = optionalPackString(row.id);
    const key = opportunityId || leadId;
    if (!key) continue;
    const disposition = optionalPackString(row.disposition);
    const draftFromRow = optionalPackString(row.draft);
    const draftFromMap = (opportunityId && drafts[opportunityId]) ||
      (leadId && drafts[salesBookingPackOpportunityId(leadId) ?? leadId]) ||
      null;
    out[key] = {
      disposition,
      window: "window" in row ? row.window : null,
      day: packWindowDay(row.window),
      draft: draftFromRow ?? draftFromMap,
      offer: disposition === "offer",
      name: optionalPackString(row.name),
      suburb: optionalPackString(row.suburb),
      opportunity_id: opportunityId,
      contact_id: optionalPackString(row.contact_id),
      stage: optionalPackString(row.stage),
      status: optionalPackString(row.status),
      calendar_event_id: optionalPackString(row.calendar_event_id),
    };
  }
  return out;
}

export function normaliseSalesBookingDrafts(
  drafts: unknown,
): Record<string, string> {
  if (!isObject(drafts)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(drafts)) {
    if (typeof value !== "string" || !value) continue;
    const id = salesBookingPackOpportunityId(key);
    if (id) out[id] = value;
  }
  return out;
}

/** why[] is `why` plus `failures`. Pack rows have no `checks` key. */
function collectWhy(row: Record<string, unknown>): string[] {
  const buckets = [row.why, row.failures];
  const out: string[] = [];
  for (const bucket of buckets) {
    if (!Array.isArray(bucket)) continue;
    for (const item of bucket) {
      if (typeof item === "string" && item) out.push(item);
    }
  }
  return out;
}

export function projectSalesBookingProposal(
  row: Record<string, unknown>,
  drafts: Record<string, string>,
): { opportunity_id: string; proposal: SalesBookingCaseProposal } | null {
  const opportunityId = salesBookingPackOpportunityId(row.id);
  if (!opportunityId) return null;
  const window = isObject(row.window) ? row.window : null;
  // Pack window is `{day, start, end}` only.
  const draftFromRow = typeof row.draft === "string" && row.draft
    ? row.draft
    : null;
  return {
    opportunity_id: opportunityId,
    proposal: {
      disposition: typeof row.disposition === "string" && row.disposition
        ? row.disposition
        : "needs_info",
      day: packWindowDay(window),
      window_start: window && typeof window.start === "string"
        ? window.start
        : null,
      window_end: window && typeof window.end === "string" ? window.end : null,
      draft: draftFromRow ?? drafts[opportunityId] ?? null,
      why: collectWhy(row),
    },
  };
}

function stampIdSet(ids: string[]): Set<string> {
  const set = new Set<string>();
  for (const id of ids) {
    const trimmed = String(id || "").trim();
    if (!trimmed) continue;
    set.add(trimmed);
    const stripped = salesBookingPackOpportunityId(trimmed);
    if (stripped) {
      set.add(stripped);
      set.add(`opp:${stripped}`);
    }
  }
  return set;
}

export function salesBookingStampStateForCase(
  opportunityId: string,
  stamp: SalesBookingStampPayload | null,
): SalesBookingStampState {
  if (!stamp) return "none";
  const approved = stampIdSet(stamp.approved);
  const rejected = stampIdSet(stamp.rejected);
  if (approved.has(opportunityId) || approved.has(`opp:${opportunityId}`)) {
    return "approved";
  }
  if (rejected.has(opportunityId) || rejected.has(`opp:${opportunityId}`)) {
    return "rejected";
  }
  return "none";
}

export function parseSalesBookingStampPayload(
  raw: unknown,
): SalesBookingStampPayload {
  const body = isObject(raw) ? raw : {};
  const decisionsRaw = isObject(body.decisions) ? body.decisions : {};
  const decisions: Record<string, SalesBookingStampDecision> = {};
  for (const [key, value] of Object.entries(decisionsRaw)) {
    if (value === "hold" || value === "replace") decisions[key] = value;
  }
  const stageMoves = Array.isArray(body.stage_moves)
    ? body.stage_moves.filter(isObject).flatMap((row) => {
      const id = typeof row.id === "string" ? row.id : "";
      const to = typeof row.to_stage_id === "string" ? row.to_stage_id : "";
      return id && to ? [{ id, to_stage_id: to }] : [];
    })
    : [];
  return {
    captain: typeof body.captain === "string" && body.captain
      ? body.captain
      : null,
    approved: asStringArray(body.approved),
    rejected: asStringArray(body.rejected),
    decisions,
    stage_moves: stageMoves,
  };
}

export function emptySalesBookingPackOverlay(): SalesBookingPackOverlay {
  return { pack: null, stamp: null, pack_error: null, stamp_error: null };
}

export function emptySalesBookingStampView(): SalesBookingReadResponse[
  "stamp"
] {
  return {
    present: false,
    as_of: null,
    approved: [],
    rejected: [],
    decisions: {},
    stage_moves: [],
  };
}

/**
 * Merge the latest pack + stamp onto an already-assembled booking read.
 * Missing overlay is an honest empty pack, not a guessed proposal.
 * `pack.proposals` is built from the pack row itself, not from `cases[]`.
 */
export function applySalesBookingPackOverlay(
  response: SalesBookingReadResponse,
  overlay: SalesBookingPackOverlay = emptySalesBookingPackOverlay(),
): SalesBookingReadResponse {
  const gaps = [...response.coverage.gaps];
  if (overlay.pack_error) {
    gaps.push(`Booking pack unread (${overlay.pack_error}).`);
  }
  if (overlay.stamp_error) {
    gaps.push(`Booking stamp unread (${overlay.stamp_error}).`);
  }

  const packPayload = overlay.pack && isObject(overlay.pack.payload)
    ? overlay.pack.payload
    : null;
  const drafts = packPayload
    ? normaliseSalesBookingDrafts(packPayload.drafts)
    : {};
  const proposalByOpp = new Map<string, SalesBookingCaseProposal>();
  if (packPayload) {
    for (const row of salesBookingPackProposalRows(packPayload.proposals)) {
      const projected = projectSalesBookingProposal(row, drafts);
      if (!projected) continue;
      proposalByOpp.set(projected.opportunity_id, projected.proposal);
      if (projected.proposal.draft && !drafts[projected.opportunity_id]) {
        drafts[projected.opportunity_id] = projected.proposal.draft;
      }
    }
  }

  const stamp = overlay.stamp
    ? parseSalesBookingStampPayload(overlay.stamp.payload)
    : null;

  const cases: SalesBookingCase[] = response.cases.map((row) => {
    const proposal = proposalByOpp.get(row.opportunity_id) ??
      proposalByOpp.get(row.id) ??
      null;
    return {
      ...row,
      proposal,
      stamp_state: salesBookingStampStateForCase(row.opportunity_id, stamp),
    };
  });

  return applyBookingConfirmationModels({
    ...response,
    coverage: { ...response.coverage, gaps },
    cases,
    drafts,
    pack: overlay.pack
      ? {
        present: true,
        as_of: overlay.pack.as_of,
        proposals: salesBookingPackProposalsMap(
          packPayload?.proposals,
          drafts,
        ),
      }
      : emptySalesBookingPackView(),
    stamp: stamp && overlay.stamp
      ? {
        present: true,
        as_of: overlay.stamp.as_of,
        approved: stamp.approved,
        rejected: stamp.rejected,
        decisions: stamp.decisions,
        stage_moves: stamp.stage_moves,
      }
      : emptySalesBookingStampView(),
  }, packPayload?.booking_read_models);
}

export function assertSalesBookingThreadsRefreshAuth(
  auth: SalesBookingPackAuth,
): void {
  if (auth.mode === "api_key") return;
  if (auth.mode === "none") {
    throw new SalesBookingPackError(
      "sales_booking_threads_refresh requires the ops API key",
      401,
    );
  }
  throw new SalesBookingPackError(
    "sales_booking_threads_refresh requires the ops API key",
    403,
  );
}

export function assertSalesBookingPackPublishAuth(
  auth: SalesBookingPackAuth,
): void {
  if (auth.mode === "api_key") return;
  if (auth.mode === "none") {
    throw new SalesBookingPackError(
      "sales_booking_pack_publish requires the ops API key",
      401,
    );
  }
  throw new SalesBookingPackError(
    "sales_booking_pack_publish requires the ops API key",
    403,
  );
}

export function assertSalesBookingStampReadAuth(
  auth: SalesBookingPackAuth,
): void {
  if (auth.mode === "api_key") return;
  if (auth.mode === "none") {
    throw new SalesBookingPackError(
      "sales_booking_stamp_read requires the ops API key",
      401,
    );
  }
  throw new SalesBookingPackError(
    "sales_booking_stamp_read requires the ops API key",
    403,
  );
}

export function salesBookingCaptainEmailsFromEnv(
  envGet: SalesBookingEnvGet = defaultEnvGet,
): string[] {
  return parseSalesBookingCaptainEmails(
    envGet(SALES_BOOKING_CAPTAIN_EMAILS_ENV),
  );
}

function stampWriteCallerId(auth: SalesBookingPackAuth): string {
  if (auth.mode === "jwt") {
    const email = String(auth.email || "").trim();
    if (email) return email;
    if (auth.userId) return auth.userId;
    return "jwt";
  }
  if (auth.mode === "api_key") return auth.userId || "api_key";
  return auth.mode;
}

function refuseStampWrite(auth: SalesBookingPackAuth): never {
  console.warn(
    `sales_booking_stamp_write refused ${STAMP_WRITE_REQUIRES_CAPTAIN} caller=${
      stampWriteCallerId(auth)
    }`,
  );
  throw new SalesBookingPackError(STAMP_WRITE_REQUIRES_CAPTAIN, 403);
}

/**
 * Captain KEEP/CUT write: allow-listed JWT email only.
 * Returns the verified JWT email used as `published_by`.
 */
export function assertSalesBookingStampWriteAuth(
  auth: SalesBookingPackAuth,
  envGet: SalesBookingEnvGet = defaultEnvGet,
): string {
  if (auth.mode !== "jwt") refuseStampWrite(auth);
  const email = String(auth.email || "").trim();
  if (!email) refuseStampWrite(auth);
  const allowed = salesBookingCaptainEmailsFromEnv(envGet);
  if (!allowed.includes(email.toLowerCase())) refuseStampWrite(auth);
  return email;
}

function publishedBy(auth: SalesBookingPackAuth): string {
  if (auth.mode === "jwt" && auth.userId) return auth.userId;
  return "ops-api:api_key";
}

function resolveWeekStart(weekStart: unknown): string {
  const raw = String(weekStart ?? "").trim();
  if (!raw) {
    throw new SalesBookingRequestError("week_start is required");
  }
  try {
    return perthWeekWindow(raw).week_start;
  } catch (error) {
    throw new SalesBookingRequestError((error as Error).message);
  }
}

function parseAsOf(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) {
    throw new SalesBookingRequestError("as_of is required");
  }
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) {
    throw new SalesBookingRequestError(`as_of is not a timestamp: ${raw}`);
  }
  return new Date(ms).toISOString();
}

// deno-lint-ignore no-explicit-any
type PackClient = { from: (table: string) => any };

async function insertPackRow(
  client: PackClient,
  row: {
    resource: string;
    week_start: string;
    kind: string;
    as_of: string;
    payload: Record<string, unknown>;
    published_by: string;
  },
): Promise<{ id: string; as_of: string }> {
  const { data, error } = await client
    .from("sales_booking_packs")
    .upsert(row, { onConflict: "resource,week_start,kind,as_of" })
    .select("id, as_of")
    .single();
  if (error) {
    throw new SalesBookingPackError(
      `sales_booking_packs write failed: ${error.message || "unknown"}`,
      503,
    );
  }
  const id = data && typeof data.id === "string" ? data.id : "";
  const asOf = data &&
    (typeof data.as_of === "string" ? data.as_of : row.as_of);
  if (!id) {
    throw new SalesBookingPackError(
      "sales_booking_packs write returned no id",
      503,
    );
  }
  return { id, as_of: asOf };
}

export async function readLatestSalesBookingPackRow(
  client: PackClient,
  args: {
    resource: string;
    week_start: string;
    kind: "pack" | "stamp" | "thread_facts";
  },
): Promise<{ row: SalesBookingPackRow | null; error: string | null }> {
  const { data, error } = await client
    .from("sales_booking_packs")
    .select("id, as_of, payload")
    .eq("resource", args.resource)
    .eq("week_start", args.week_start)
    .eq("kind", args.kind)
    .order("as_of", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    return { row: null, error: error.message || "unreadable" };
  }
  if (!data || typeof data !== "object") return { row: null, error: null };
  const id = typeof data.id === "string" ? data.id : "";
  const asOf = typeof data.as_of === "string" ? data.as_of : "";
  if (!id || !asOf) return { row: null, error: null };
  return {
    row: {
      id,
      as_of: asOf,
      payload: isObject(data.payload) ? data.payload : {},
    },
    error: null,
  };
}

export async function loadSalesBookingPackOverlay(
  client: PackClient,
  resourceId: string,
  weekStart: string,
): Promise<SalesBookingPackOverlay> {
  const [pack, stamp] = await Promise.all([
    readLatestSalesBookingPackRow(client, {
      resource: resourceId,
      week_start: weekStart,
      kind: SALES_BOOKING_PACK_KIND,
    }),
    readLatestSalesBookingPackRow(client, {
      resource: resourceId,
      week_start: weekStart,
      kind: SALES_BOOKING_STAMP_KIND,
    }),
  ]);
  return {
    pack: pack.row,
    stamp: stamp.row,
    pack_error: pack.error,
    stamp_error: stamp.error,
  };
}

export async function salesBookingPackPublishAction(
  client: PackClient,
  auth: SalesBookingPackAuth,
  body: Record<string, unknown>,
): Promise<{ ok: true; id: string; as_of: string }> {
  assertSalesBookingPackPublishAuth(auth);
  const resource = resolveSalesBookingResource(body.resource);
  const weekStart = resolveWeekStart(body.week_start);
  const asOf = parseAsOf(body.as_of);
  // Validate only the manifest-selected generation, never stale file entries.
  selectBookingModels(body.booking_read_models);
  const payload: SalesBookingPackPayload = {
    booking_read_models: body.booking_read_models ?? null,
    proposals: body.proposals ?? null,
    coverage: body.coverage ?? null,
    drafts: normaliseSalesBookingDrafts(body.drafts),
  };
  const written = await insertPackRow(client, {
    resource: resource.resource_id,
    week_start: weekStart,
    kind: SALES_BOOKING_PACK_KIND,
    as_of: asOf,
    payload: payload as unknown as Record<string, unknown>,
    published_by: publishedBy(auth),
  });
  return { ok: true, id: written.id, as_of: written.as_of };
}

export async function salesBookingStampReadAction(
  client: PackClient,
  auth: SalesBookingPackAuth,
  params: { resource?: unknown; week_start?: unknown },
): Promise<
  { ok: true; stamp: SalesBookingStampPayload | null; as_of: string | null }
> {
  assertSalesBookingStampReadAuth(auth);
  const resource = resolveSalesBookingResource(params.resource);
  const weekStart = resolveWeekStart(params.week_start);
  const latest = await readLatestSalesBookingPackRow(client, {
    resource: resource.resource_id,
    week_start: weekStart,
    kind: SALES_BOOKING_STAMP_KIND,
  });
  if (latest.error) {
    throw new SalesBookingPackError(
      `sales_booking_packs stamp unread: ${latest.error}`,
      503,
    );
  }
  if (!latest.row) return { ok: true, stamp: null, as_of: null };
  return {
    ok: true,
    stamp: parseSalesBookingStampPayload(latest.row.payload),
    as_of: latest.row.as_of,
  };
}

export async function salesBookingThreadsRefreshAction(
  client: PackClient,
  auth: SalesBookingPackAuth,
  body: Record<string, unknown>,
): Promise<SalesBookingReadResponse> {
  assertSalesBookingThreadsRefreshAuth(auth);
  const resource = resolveSalesBookingResource(body.resource);
  return await salesBookingReadAction(client, {
    resource: resource.resource_id,
    week_start: typeof body.week_start === "string" ? body.week_start : null,
    include_thread_facts: true,
    force_refresh: true,
    thread_limit: SALES_BOOKING_MAX_THREAD_LIMIT,
    thread_budget_ms: 60_000,
  });
}
