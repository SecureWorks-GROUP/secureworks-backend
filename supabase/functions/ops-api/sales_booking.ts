// Sales Booking workflow. Production uses Supabase client + SQL RPCs.
// booking_test/psql is a test transport only. No Deno.Command/psql in this module.

import { authorisedLocalReason, runAssessment } from "./sales_booking_engine.ts";
import { validate, conservativeExtract } from "./sales_booking_assess.ts";

export const SALES_BOOKING_VERSION = "sales-booking-api/v1";

export const POLICY = {
  activation: "held",
  runner_enabled: false,
  timezone: "Australia/Perth",
  on_inbound: "dedupe_then_assess",
  debounce_seconds: 60,
  catch_up_minutes: 15,
  daily_reconcile: "06:00 Australia/Perth after CIO context pass finishes",
  send: "held",
  calendar_write: "held",
  cloud_schedule: {
    configured: false,
    observed: "not_configured",
    intended: {
      debounce_seconds: 60,
      catch_up_minutes: 15,
      daily_reconcile: "after CIO 06:00 Australia/Perth context pass finishes",
    },
    stale_skill_wording: "30-minute poll is stale; not the approved cadence",
  },
};

export const PIPELINES: Record<string, string> = {
  nithin: "OGZLpPPVWVarN94HL6af",
  marnin: "I9t8njpuR0Dm7B2NDcvI",
  khairo: "I9t8njpuR0Dm7B2NDcvI",
};
export const UNASSIGNED_FENCING = "unassigned-fencing";

function admitResourceId(existingId: string | undefined, reading: string): string | null {
  if (!existingId) {
    if (reading === "nithin") return "nithin";
    if (reading === "marnin" || reading === "khairo") return UNASSIGNED_FENCING;
    return reading;
  }
  if (existingId === reading) return existingId;
  if (existingId === UNASSIGNED_FENCING && (reading === "marnin" || reading === "khairo")) return existingId;
  return null;
}

function caseVisibleFor(resourceId: string | undefined, reading: string): boolean {
  if (reading === "nithin") return resourceId === "nithin";
  if (reading === "marnin" || reading === "khairo") return resourceId === reading || resourceId === UNASSIGNED_FENCING;
  return resourceId === reading;
}

export const RESOURCES: Record<string, {
  id: string; name: string; scoper_user_id: string; lane: string;
  sender_resolved: boolean; sender: string | null;
}> = {
  nithin: { id: "nithin", name: "Nithin", scoper_user_id: "5862cf1d-0a3b-4836-8fd1-d69f95aa2f73", lane: "patio", sender_resolved: true, sender: "+61489267774" },
  marnin: { id: "marnin", name: "Marnin", scoper_user_id: "706c5258-70dd-483a-b36c-af6864b24498", lane: "fencing", sender_resolved: false, sender: null },
  khairo: { id: "khairo", name: "Khairo", scoper_user_id: "be6c2188-2b7b-49c7-b6e4-5b0d0deb6415", lane: "fencing", sender_resolved: true, sender: "+61489267772" },
};

export class SalesBookingError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 400, code = "sales_booking_bad_request") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export type Opportunity = { id: string; contact_id: string | null; name?: string; suburb?: string; tags?: string[]; status?: string };
export type CalendarEvent = { event_id: string; subject?: string; start_iso: string; end_iso: string; suburb?: string };
export type Adapters = {
  listOpportunities: (pipelineId: string, cursor?: Record<string, unknown> | null) => Promise<{
    items: Opportunity[]; next: Record<string, unknown> | null; complete: boolean; total?: number;
  }>;
  calendarEvents: (scoperUserId: string, since: string, until: string) => Promise<{
    ok: boolean; events: CalendarEvent[]; coverage: Record<string, unknown>; mailbox?: string; retrieved_at?: string;
  }>;
  coverageForResource?: (scoperUserId: string, weekStart?: string) => Promise<{
    leave_intervals: { start_iso: string; end_iso: string; status?: string }[] | null;
    travel_minutes: number | null;
    calendar_retrieved_at: string | null;
    leave_retrieved_at: string | null;
    travel_retrieved_at: string | null;
    leave_roster_complete?: boolean;
    source_row_count?: number;
    matched_rows?: number;
    leave_state?: "observed" | "incomplete" | "unavailable" | "unread" | "not_read" | "absent";
    travel_state?: "observed" | "absent" | "unavailable" | "unread";
    travel_source?: string;
    treat_as_free?: boolean;
    any_unread_or_not_read?: boolean;
    calendar_source_coverage?: Record<string, unknown> | null;
  }>;
  getConversation?: (contactId: string) => Promise<{
    messages: Record<string, unknown>[];
    coverage?: {
      has_more?: boolean;
      complete?: boolean;
      source?: string;
      conversation_count?: number;
      conversation_pages?: number;
      message_pages?: number;
      conversations_complete?: boolean;
      messages_complete?: boolean;
      next_cursor?: unknown;
      horizon?: string;
    };
    retrieved_at?: string;
  }>;
  assessCase?: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  sendSms?: (payload: Record<string, unknown>, opts: { execute: boolean; fake: boolean }) => Promise<{ held: boolean; sent: boolean; message_id?: string }>;
  writeCalendar?: (payload: Record<string, unknown>, opts: { execute: boolean; fake: boolean }) => Promise<{ held: boolean; written: boolean; event_id?: string }>;
};

export type BookingActor = { org_id: string; user_id: string; role: string };
const STAFF_ROLES = new Set(["admin", "owner", "ops_manager"]);
export function assertBookingActor(actor?: BookingActor | null): BookingActor {
  if (!actor?.org_id || !actor.user_id) throw new SalesBookingError("An authorised operator is required", 401, "operator_required");
  if (!STAFF_ROLES.has(String(actor.role || "").toLowerCase())) throw new SalesBookingError("Staff operator role required", 403, "operator_forbidden");
  return actor;
}

export type BookingDb = {
  rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: Record<string, unknown> | null; error: { message: string } | null }>;
  upsert: (table: string, row: Record<string, unknown>) => Promise<{ error: { message: string } | null }>;
  selectMatch: (table: string, match: Record<string, unknown>) => Promise<{ data: Record<string, unknown>[] }>;
};

function nowIso() { return new Date().toISOString(); }
function phoneLike(name: string | undefined) { return !!name && /^(\+61|0)\d/.test(name.replace(/\s/g, "")); }

/** Occupancy is scoper Outlook rows with event_id. Job-assignment diary rows are not a salesperson calendar. */
export function scoperOccupancy(raw: Record<string, unknown>[] | CalendarEvent[]): { events: CalendarEvent[]; dropped_job_rows: number } {
  const events: CalendarEvent[] = [];
  let dropped = 0;
  for (const row of raw || []) {
    const rec = row as Record<string, unknown>;
    const eventId = rec.event_id || rec.id;
    if (rec.assignment_id && !rec.event_id) { dropped += 1; continue; }
    if (!eventId || !rec.start_iso || !rec.end_iso) { dropped += 1; continue; }
    events.push({
      event_id: String(eventId),
      subject: rec.subject ? String(rec.subject) : undefined,
      start_iso: String(rec.start_iso),
      end_iso: String(rec.end_iso),
      suburb: rec.suburb ? String(rec.suburb) : undefined,
    });
  }
  return { events, dropped_job_rows: dropped };
}

function nextIsoDate(date: string) {
  const [y, m, d] = String(date).slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/** Join crew_availability.user_id to the scoper staff id. Missing rows are not a complete roster. */
export function staffLeaveFromCrewAvailability(
  rows: Array<{ user_id?: string; date?: string; status?: string }>,
  scoperUserId: string,
  retrievedAt: string,
) {
  const source_row_count = Array.isArray(rows) ? rows.length : 0;
  const leave_intervals = (rows || [])
    .filter((r) => r && r.user_id === scoperUserId && (r.status === "leave" || r.status === "unavailable") && r.date)
    .map((r) => ({
      start_iso: `${String(r.date).slice(0, 10)}T00:00:00+08:00`,
      end_iso: `${nextIsoDate(String(r.date).slice(0, 10))}T00:00:00+08:00`,
      status: String(r.status),
      source: "crew_availability",
    }));
  return {
    leave_intervals,
    leave_retrieved_at: retrievedAt,
    travel_minutes: null,
    travel_retrieved_at: null,
    calendar_retrieved_at: retrievedAt,
    leave_roster_complete: false,
    leave_state: "incomplete" as const,
    travel_state: "unavailable" as const,
    travel_source: "drive_time_cache",
    source_row_count,
    matched_rows: leave_intervals.length,
    gaps: [
      leave_intervals.length
        ? `Staff availability leave/unavailable days for this scoper were applied from crew_availability (${leave_intervals.length} day(s)). Roster completeness is not declared (incomplete, not absent).`
        : `Staff availability was read (${source_row_count} row(s)). None matched this scoper user id. That is incomplete roster coverage, not proof of no leave (absent).`,
      "Travel source drive_time_cache is unavailable in this isolated database. Unavailable is not unread.",
    ],
  };
}

export type CioCalendarCoverage = {
  owner_key?: string;
  any_unread_or_not_read?: boolean;
  calendars?: Array<{
    calendar_id?: string;
    coverage_status?: string;
    treat_as_free?: boolean;
    last_check_at?: string | null;
  }>;
};

export function mergeCioCalendarCoverage<T extends {
  leave_roster_complete?: boolean;
  leave_state?: string;
}>(crew: T, cio: CioCalendarCoverage | null | undefined): T & {
  leave_roster_complete: boolean;
  leave_state: string;
  treat_as_free: false;
  any_unread_or_not_read: boolean;
  calendar_source_coverage: CioCalendarCoverage | null;
} {
  const calendars = Array.isArray(cio?.calendars) ? cio!.calendars! : [];
  const anyUnread = cio?.any_unread_or_not_read === true || calendars.some((c) => {
    const status = String(c.coverage_status || "");
    return status === "unread" || status === "not_read" || status === "error";
  });
  const leaveCal = calendars.find((c) => c.calendar_id === "leave");
  const leaveStatus = String(leaveCal?.coverage_status || "");
  let leave_state = String(crew.leave_state || "incomplete");
  if (anyUnread) {
    leave_state = leaveStatus === "unread" ? "unread" : "not_read";
  }
  return {
    ...crew,
    leave_roster_complete: anyUnread ? false : crew.leave_roster_complete === true,
    leave_state,
    treat_as_free: false,
    any_unread_or_not_read: anyUnread,
    calendar_source_coverage: cio || null,
  };
}

export function isCustomerFacingMessage(m: Record<string, unknown>) {
  const dir = String(m.direction || "").toLowerCase();
  if (dir !== "inbound" && dir !== "outbound") return false;
  const body = String(m.body || m.text || "").trim();
  if (!body) return false;
  if (/^opportunity created$/i.test(body)) return false;
  return true;
}

/** Local queue hygiene from captured evidence. Does not write GHL. Age/text is not a completed scope. */
export function reconcileLeadState(input: {
  status?: string;
  archived?: boolean;
  event_id?: string | null;
  capture_completeness?: string | null;
  messages?: Record<string, unknown>[];
  sender_resolved?: boolean;
  resource_id?: string;
}) {
  if (input.archived) {
    return { queue_state: "archived", status: "archived", evidence: "manual_archive", scoped: false };
  }
  if (input.status === "completed") {
    return { queue_state: "scoped", status: "completed", evidence: "completed_status", scoped: true };
  }
  if (input.status === "booked" || input.event_id) {
    return { queue_state: "booked_until_scoped", status: "booked", evidence: "booked_visit", scoped: false };
  }
  if (input.sender_resolved === false || input.resource_id === "unassigned-fencing") {
    return { queue_state: "unresolved_ownership", status: "needs_decision", evidence: "ownership", scoped: false };
  }
  const completeness = input.capture_completeness || null;
  if (!completeness || completeness === "unknown" || completeness === "partial") {
    return {
      queue_state: "needs_decision",
      status: "needs_decision",
      evidence: completeness ? "capture_" + completeness : "capture_missing",
      stale_evidence: completeness !== "complete",
      scoped: false,
    };
  }
  const facing = (input.messages || []).filter(isCustomerFacingMessage)
    .sort((a, b) => String(a.timestamp || "").localeCompare(String(b.timestamp || "")));
  const last = facing[facing.length - 1];
  const hadOutbound = facing.some((m) => String(m.direction).toLowerCase() === "outbound");
  if (!last || !hadOutbound) {
    return { queue_state: "uncontacted", status: "ready", evidence: "no_outbound", scoped: false };
  }
  if (String(last.direction).toLowerCase() === "outbound") {
    return { queue_state: "waiting_reply", status: "waiting", evidence: "last_outbound", scoped: false };
  }
  return { queue_state: "follow_up", status: "follow_up", evidence: "last_inbound_after_contact", scoped: false };
}

function rangesOverlap(a0: string, a1: string, b0: string, b1: string) {
  const A0 = Date.parse(a0), A1 = Date.parse(a1), B0 = Date.parse(b0), B1 = Date.parse(b1);
  if ([A0, A1, B0, B1].some((n) => Number.isNaN(n))) return true;
  return A0 < B1 && B0 < A1;
}

/** In-process RPC stand-in for unit tests. Same names as SQL reducers. */
export function createMemoryBookingDb(): BookingDb & { _mem: Record<string, Record<string, unknown>[]> } {
  const mem: Record<string, Record<string, unknown>[]> = {
    sales_booking_cases: [],
    sales_booking_drafts: [],
    sales_booking_offers: [],
    sales_booking_actions: [],
    sales_booking_archives: [],
    sales_booking_assessments: [],
    sales_booking_cursors: [],
    sales_booking_seen_events: [],
    sales_booking_slot_claims: [],
    sales_booking_leases: [],
    sales_booking_source_revisions: [],
    sales_booking_runner_journal: [],
    sales_booking_action_journal: [],
    sales_booking_conversation_captures: [],
    sales_booking_needs_scoper: [],
  };
  function rows(t: string) { return mem[t] || (mem[t] = []); }
  return {
    _mem: mem,
    async rpc(fn, args = {}) {
      if (!args.p_org_id) return { data: { ok: false, code: "org_required" }, error: null };
      if (fn === "sales_booking_claim_slot") {
        const live = rows("sales_booking_slot_claims").filter((c) => !c.withdrawn && c.org_id === args.p_org_id && c.resource_id === args.p_resource_id);
        if (live.some((c) => c.claim_id === args.p_claim_id)) {
          return { data: { ok: true, claim_id: args.p_claim_id, idempotent: true }, error: null };
        }
        if (live.some((c) => c.claim_id !== args.p_claim_id && rangesOverlap(String(c.start_iso), String(c.end_iso), String(args.p_start_iso), String(args.p_end_iso)))) {
          return { data: { ok: false, code: "slot_overlap" }, error: null };
        }
        rows("sales_booking_slot_claims").push({
          claim_id: args.p_claim_id, org_id: args.p_org_id, resource_id: args.p_resource_id, start_iso: args.p_start_iso,
          end_iso: args.p_end_iso, case_id: args.p_case_id, withdrawn: false, status: "held",
        });
        return { data: { ok: true, claim_id: args.p_claim_id }, error: null };
      }
      if (fn === "sales_booking_acquire_lease") {
        const now = Date.now();
        for (const l of rows("sales_booking_leases")) {
          if (!l.released && new Date(String(l.expires_at)).getTime() <= now) l.released = true;
        }
        const live = rows("sales_booking_leases").find((l) =>
          l.org_id === args.p_org_id && l.case_id === args.p_case_id && l.action_kind === args.p_action_kind && !l.released &&
          new Date(String(l.expires_at)).getTime() > now);
        if (live) return { data: { ok: false, code: "lease_held", token: live.token, lease_id: live.lease_id }, error: null };
        const gen = `g-${now}-${Math.random().toString(16).slice(2)}`;
        rows("sales_booking_leases").push({
          lease_id: args.p_lease_id, org_id: args.p_org_id, case_id: args.p_case_id, action_kind: args.p_action_kind,
          token: args.p_token, owner: args.p_owner, released: false, generation: gen,
          expires_at: new Date(now + Number(args.p_ttl_seconds || 60) * 1000).toISOString(),
        });
        return { data: { ok: true, token: args.p_token, lease_id: args.p_lease_id, generation: gen }, error: null };
      }
      if (fn === "sales_booking_release_lease") {
        const hit = rows("sales_booking_leases").find((l) => l.org_id === args.p_org_id && l.lease_id === args.p_lease_id);
        if (hit) hit.released = true;
        return { data: { ok: true, lease_id: args.p_lease_id }, error: null };
      }
      if (fn === "sales_booking_cas_draft") {
        const row = rows("sales_booking_drafts").find((d) => d.case_id === args.p_case_id && d.org_id === args.p_org_id);
        const cur = row ? Number(row.revision || 0) : 0;
        if (args.p_expected_revision != null && Number(args.p_expected_revision) !== cur) {
          return { data: { ok: false, code: "cas_conflict", revision: cur }, error: null };
        }
        const nxt = cur + 1;
        if (row) {
          row.text = args.p_text;
          row.human_edited = args.p_human_edited;
          row.sender = args.p_sender;
          row.actor_id = args.p_actor_id;
          row.revision = nxt;
          row.updated_at = nowIso();
        } else {
          rows("sales_booking_drafts").push({
            case_id: args.p_case_id, org_id: args.p_org_id, text: args.p_text,
            human_edited: args.p_human_edited, sender: args.p_sender, actor_id: args.p_actor_id,
            revision: nxt, updated_at: nowIso(),
          });
        }
        return { data: { ok: true, revision: nxt, text: args.p_text, case_id: args.p_case_id, human_edited: args.p_human_edited, sender: args.p_sender }, error: null };
      }
      if (fn === "sales_booking_cas_case") {
        const row = rows("sales_booking_cases").find((c) => c.id === args.p_id && c.org_id === args.p_org_id);
        if (!row || row.source_version !== args.p_expected_version) return { data: { ok: false, code: "cas_conflict" }, error: null };
        row.source_version = args.p_next_version;
        if (args.p_status) row.status = args.p_status;
        return { data: { ok: true, id: args.p_id, source_version: args.p_next_version }, error: null };
      }
      if (fn === "sales_booking_ingest_event") {
        const seen = rows("sales_booking_seen_events");
        const hit = seen.find((e) => e.org_id === args.p_org_id && e.event_key === args.p_event_key);
        if (hit && hit.processed) return { data: { ok: true, duplicate: true, processed: true, retry: false }, error: null };
        if (hit && !hit.processed) return { data: { ok: true, duplicate: false, processed: false, retry: true }, error: null };
        seen.push({ org_id: args.p_org_id, event_key: args.p_event_key, processed: false });
        return { data: { ok: true, duplicate: false, processed: false, retry: false }, error: null };
      }
      if (fn === "sales_booking_mark_event_processed") {
        const hit = rows("sales_booking_seen_events").find((e) => e.org_id === args.p_org_id && e.event_key === args.p_event_key);
        if (hit) hit.processed = true;
        return { data: { ok: true }, error: null };
      }
      if (fn === "sales_booking_put_consumption_cursor") {
        const key = String(args.p_key || "");
        if (!key.startsWith("consume:")) return { data: { ok: false, code: "not_consumption_cursor" }, error: null };
        const cur = rows("sales_booking_cursors");
        const existing = cur.find((c) => c.key === key && c.org_id === args.p_org_id);
        if (existing) existing.payload = args.p_payload;
        else cur.push({ key, org_id: args.p_org_id, payload: args.p_payload });
        return { data: { ok: true, key }, error: null };
      }
      return { data: null, error: { message: `unknown rpc ${fn}` } };
    },
    async upsert(table, row) {
      if (row._fail) return { error: { message: "forced upsert failure" } };
      const list = rows(table);
      const key = String(row.item_id || row.capture_id || row.id || row.case_id || row.offer_id || row.action_id || row.claim_id || row.key || row.event_key);
      const idx = list.findIndex((r) =>
        r.org_id === row.org_id && String(r.item_id || r.capture_id || r.id || r.case_id || r.offer_id || r.action_id || r.claim_id || r.key || r.event_key) === key);
      if (idx >= 0) list[idx] = { ...list[idx], ...row };
      else list.push({ ...row });
      return { error: null };
    },
    async selectMatch(table, match) {
      return {
        data: rows(table).filter((r) => Object.entries(match).every(([k, v]) => r[k] === v)),
      };
    },
  };
}

export function supabaseBookingDb(client: { rpc: Function; from: Function }): BookingDb {
  return {
    async rpc(fn, args = {}) {
      const { data, error } = await client.rpc(fn, args);
      return { data, error };
    },
    async upsert(table, row) {
      const { error } = await client.from(table).upsert(row);
      return { error };
    },
    async selectMatch(table, match) {
      let q = client.from(table).select("*");
      for (const [k, v] of Object.entries(match)) q = q.eq(k, v);
      const { data, error } = await q;
      if (error) throw new SalesBookingError(error.message, 500, "db_read");
      return { data: data || [] };
    },
  };
}

/** @deprecated Maps are not production state. Tests should use createMemoryBookingDb. */
export function createStore() {
  return createMemoryBookingDb();
}

export async function claimSlot(db: BookingDb, actor: BookingActor, args: { claim_id: string; resource_id: string; start_iso: string; end_iso: string; case_id: string }) {
  const a = assertBookingActor(actor);
  const { data, error } = await db.rpc("sales_booking_claim_slot", {
    p_org_id: a.org_id, p_claim_id: args.claim_id, p_resource_id: args.resource_id,
    p_start_iso: args.start_iso, p_end_iso: args.end_iso, p_case_id: args.case_id,
  });
  if (error) throw new SalesBookingError(error.message, 500, "rpc");
  return data || { ok: false };
}

function requireUpsert(result: { error: { message: string } | null }) {
  if (result.error) throw new SalesBookingError(result.error.message, 500, "upsert_failed");
}

async function journalActionStage(
  db: BookingDb,
  actor: BookingActor,
  actionId: string,
  stage: string,
  detail: Record<string, unknown>,
) {
  requireUpsert(await db.upsert("sales_booking_action_journal", {
    id: `jnl-${actionId}-${stage}-${Date.now()}`,
    org_id: actor.org_id,
    action_id: actionId,
    stage,
    actor_id: actor.user_id,
    detail,
    at: nowIso(),
  }));
}

export async function readWorkspace(
  db: BookingDb,
  adapters: Adapters,
  params: { resource: string; week_start: string; drain?: boolean; max_pages?: number; refresh?: boolean },
  actor: BookingActor,
) {
  const a = assertBookingActor(actor);
  const resource = RESOURCES[params.resource];
  if (!resource) throw new SalesBookingError("Unknown resource", 400, "unknown_resource");
  const pipeline = PIPELINES[params.resource];
  const consumeKey = `consume:${params.resource}:${params.week_start}`;
  const curRows = await db.selectMatch("sales_booking_cursors", { key: consumeKey, org_id: a.org_id });
  let cursor = (curRows.data[0]?.payload as { next?: Record<string, unknown> | null; complete?: boolean; total?: number; pages?: number; retrieved_at?: string }) || { next: null, complete: false, pages: 0 };
  const terminalCursor = cursor.complete === true ? { ...cursor } : null;
  if (params.drain && params.refresh && cursor.complete) {
    cursor = { next: null, complete: false, pages: 0, total: cursor.total };
  }
  const maxPages = params.drain ? 50 : (params.max_pages ?? 8);
  let pages = 0;
  let providerCalls = 0;
  const consume = cursor.complete !== true || params.drain === true;
  while (consume && !cursor.complete && pages < maxPages) {
    const page = await adapters.listOpportunities(pipeline, cursor.next || null);
    providerCalls += 1;
    for (const item of page.items) {
      const existing = (await db.selectMatch("sales_booking_cases", { id: item.id, org_id: a.org_id })).data[0];
      const admitted = admitResourceId(existing?.resource_id as string | undefined, params.resource);
      if (!admitted) continue;
      requireUpsert(await db.upsert("sales_booking_cases", {
        id: item.id, org_id: a.org_id, resource_id: admitted, opportunity_id: item.id,
        contact_id: item.contact_id, pipeline_id: pipeline, suburb: item.suburb || null,
        display_name: phoneLike(item.name) ? (item.suburb || "Enquiry") : (item.name || "Enquiry"),
        status: existing?.status || "needs_decision",
        source_version: `ghl:${item.id}:${item.status || "open"}`,
        updated_at: nowIso(),
      }));
    }
    const nextCursor = {
      next: page.next || null,
      complete: page.complete === true,
      total: page.total ?? cursor.total,
      pages: (cursor.pages || 0) + 1,
      retrieved_at: nowIso(),
    };
    if (terminalCursor && nextCursor.complete !== true) {
      cursor = terminalCursor;
      break;
    }
    cursor = nextCursor;
    const put = await db.rpc("sales_booking_put_consumption_cursor", { p_org_id: a.org_id, p_key: consumeKey, p_payload: cursor });
    if (put.data && put.data.ok === false) throw new SalesBookingError("consumption cursor refused", 400, String(put.data.code));
    pages += 1;
    if (page.complete !== true && !params.drain) break;
    if (page.complete !== true && params.drain && !page.next) break;
  }
  const since = `${params.week_start}T00:00:00+08:00`;
  const untilDate = new Date(`${params.week_start}T00:00:00+08:00`);
  untilDate.setUTCDate(untilDate.getUTCDate() + 5);
  const cal = await adapters.calendarEvents(resource.scoper_user_id, since, untilDate.toISOString());
  const occupancy = scoperOccupancy(((cal.events || []) as unknown) as Record<string, unknown>[]);
  cal.events = occupancy.events;
  const crewCov = adapters.coverageForResource
    ? await adapters.coverageForResource(resource.scoper_user_id, params.week_start)
    : { leave_intervals: null, travel_minutes: null, calendar_retrieved_at: cal.retrieved_at || null, leave_retrieved_at: null, travel_retrieved_at: null, leave_roster_complete: false };
  let cioCoverage: CioCalendarCoverage | null = null;
  try {
    const cioRpc = await db.rpc("read_calendar_coverage", { p_org_id: a.org_id, p_owner_key: params.resource });
    if (!cioRpc.error && cioRpc.data && typeof cioRpc.data === "object") cioCoverage = cioRpc.data as CioCalendarCoverage;
  } catch {
    cioCoverage = null;
  }
  const cov = mergeCioCalendarCoverage(crewCov, cioCoverage);
  for (const ev of cal.events || []) {
    const existing = (await db.selectMatch("sales_booking_cases", { id: ev.event_id, org_id: a.org_id })).data[0];
    if (existing?.resource_id && existing.resource_id !== params.resource) continue;
    requireUpsert(await db.upsert("sales_booking_cases", {
      id: ev.event_id, org_id: a.org_id, resource_id: params.resource, event_id: ev.event_id, suburb: ev.suburb || null,
      display_name: ev.subject || "Diary", status: "booked", updated_at: nowIso(),
    }));
  }
  const listedAll = await db.selectMatch("sales_booking_cases", { org_id: a.org_id });
  const listed = { data: listedAll.data.filter((c) => caseVisibleFor(c.resource_id as string | undefined, params.resource)) };
  const drafts = await db.selectMatch("sales_booking_drafts", { org_id: a.org_id });
  const assessments = await db.selectMatch("sales_booking_assessments", { org_id: a.org_id });
  const archives = await db.selectMatch("sales_booking_archives", { org_id: a.org_id });
  const captures = await db.selectMatch("sales_booking_conversation_captures", { org_id: a.org_id });
  const cases = listed.data.map((c) => {
    const assessment = assessments.data.find((d) => d.case_id === c.id) || null;
    const payload = (assessment?.payload || {}) as { source_version?: string; stale?: boolean; actionable?: boolean; classification?: string; status?: string; proposal?: { start_iso?: string } };
    const assessmentStale = !!(
      assessment && (
        payload.stale === true ||
        payload.actionable === false ||
        payload.classification === "unassessed_conversation" ||
        (payload.source_version && payload.source_version !== c.source_version)
      )
    );
    const archive = archives.data.find((d) => d.case_id === c.id && !d.restored) || null;
    const capture = latestCapture(captures.data, String(c.id), String(c.source_version || ""))
      || captures.data.filter((row) => row.case_id === c.id).sort((a, b) => String(b.captured_at || "").localeCompare(String(a.captured_at || "")))[0];
    const resourceMeta = RESOURCES[String(c.resource_id)] || null;
    const lead = reconcileLeadState({
      status: String(c.status || ""),
      archived: !!archive,
      event_id: (c.event_id as string | null) || null,
      capture_completeness: capture ? String(capture.completeness || "") : null,
      messages: capture && Array.isArray(capture.messages) ? capture.messages as Record<string, unknown>[] : [],
      sender_resolved: resourceMeta ? resourceMeta.sender_resolved : true,
      resource_id: String(c.resource_id || ""),
    });
    const suburbKey = String(c.suburb || "").trim().toLowerCase();
    const siblings = listed.data.filter((row) =>
      row.id !== c.id
      && row.contact_id
      && row.contact_id === c.contact_id
      && String(row.suburb || "").trim().toLowerCase() === suburbKey
      && suburbKey !== ""
      && row.status !== "completed"
      && !archives.data.some((ar) => ar.case_id === row.id && !ar.restored)
    );
    const siblingHasProposal = siblings.some((row) => {
      const ass = assessments.data.find((d) => d.case_id === row.id);
      const prop = (ass?.payload as { proposal?: { start_iso?: string } } | undefined)?.proposal;
      return !!(prop && prop.start_iso);
    });
    const duplicate_scope_review = siblings.length > 0;
    const suppress_new_proposal = duplicate_scope_review && siblingHasProposal;
    const viewStatus = assessmentStale && (lead.status === "ready" || c.status === "ready" || c.status === "proposal")
      ? "needs_decision"
      : (lead.status || c.status);
    return {
      ...c,
      opportunity_id: c.opportunity_id,
      status: viewStatus,
      queue_state: lead.queue_state,
      queue_evidence: lead.evidence,
      stale_evidence: !!lead.stale_evidence || assessmentStale,
      assessment_stale: assessmentStale,
      proposal_stale: assessmentStale || c.proposal_stale,
      duplicate_scope_review,
      suppress_new_proposal,
      sibling_case_ids: siblings.map((row) => row.id),
      lane: resourceMeta?.lane || null,
      draft: drafts.data.find((d) => d.case_id === c.id) || null,
      assessment,
      archived: archive,
      capture_completeness: capture ? capture.completeness : null,
    };
  });
  const enumerated = cases.filter((c) => (c as { opportunity_id?: string }).opportunity_id).length;
  const censusCases = cases.filter((c) => !String(c.id).startsWith("review-") && !String(c.id).startsWith("sql-"));
  const evidenceBackedUnscoped = censusCases.filter((c) => {
    if (c.queue_state === "scoped" || c.queue_state === "archived") return false;
    if (c.queue_state === "booked_until_scoped") return true;
    const completeness = String(c.capture_completeness || "");
    return completeness === "complete" || completeness === "partial" || completeness === "unknown";
  });
  return {
    ok: true, fixture: false, send_hold: true, version: SALES_BOOKING_VERSION, policy: POLICY,
    resource: { ...resource, calendar: { ok: cal.ok, mailbox: cal.mailbox || null } },
    week_start: params.week_start,
    coverage: {
      full_population: cursor.complete === true,
      enumerated,
      total: cursor.total ?? null,
      provider_calls: providerCalls,
      calendar_state: cal.ok === false ? "unavailable" : "observed",
      calendar_retrieved_at: cov.calendar_retrieved_at || cal.retrieved_at || null,
      leave_retrieved_at: cov.leave_retrieved_at,
      leave_intervals: cov.leave_intervals,
      leave_roster_complete: cov.leave_roster_complete === true,
      leave_state: cov.leave_state || (cov.leave_retrieved_at ? "incomplete" : "unread"),
      treat_as_free: false,
      any_unread_or_not_read: cov.any_unread_or_not_read === true,
      calendar_source_coverage: cov.calendar_source_coverage || cioCoverage,
      travel_retrieved_at: cov.travel_retrieved_at,
      travel_minutes: cov.travel_minutes,
      travel_state: cov.travel_state || (cov.travel_retrieved_at ? "observed" : "unavailable"),
      travel_source: cov.travel_source || "drive_time_cache",
      population: {
        lane: resource.lane,
        resource: params.resource,
        opportunities: listed.data.filter((c) => c.opportunity_id && !String(c.id).startsWith("review-") && !String(c.id).startsWith("sql-")).length,
        unique_customers: new Set(listed.data.filter((c) => c.contact_id && c.opportunity_id).map((c) => String(c.contact_id))).size,
        uncaptured_opportunities: censusCases.filter((c) =>
          c.opportunity_id
          && c.queue_state !== "booked_until_scoped"
          && c.queue_state !== "scoped"
          && c.queue_state !== "archived"
          && !c.capture_completeness
        ).length,
        captured_complete: censusCases.filter((c) => c.capture_completeness === "complete").length,
        captured_incomplete: censusCases.filter((c) => c.capture_completeness === "partial" || c.capture_completeness === "unknown").length,
        eligible_unscoped_cases: evidenceBackedUnscoped.length,
        booked_until_visit: censusCases.filter((c) => c.queue_state === "booked_until_scoped").length,
        archived_cases: archives.data.filter((ar) => !ar.restored && censusCases.some((c) => c.id === ar.case_id)).length,
        uncontacted: censusCases.filter((c) => c.queue_state === "uncontacted").length,
        waiting_reply: censusCases.filter((c) => c.queue_state === "waiting_reply").length,
        follow_up: censusCases.filter((c) => c.queue_state === "follow_up").length,
        booked_until_scoped: censusCases.filter((c) => c.queue_state === "booked_until_scoped").length,
        scoped: censusCases.filter((c) => c.queue_state === "scoped").length,
        duplicate_scope_review: censusCases.filter((c) => c.opportunity_id && c.duplicate_scope_review).length,
        other_lane_events_excluded: true,
        note: "Enumerated opportunity IDs are not the unscoped visit workload. Eligible unscoped is booked-until-scoped (calendar visit still outstanding) plus captured conversations that are not scoped or archived. Uncaptured IDs are enumerated only. Queue states are local evidence overlays, not GHL writes. Age is not a completed scope.",
      },
      boolean_flags_are_not_capacity: true,
      gaps: [
        cursor.complete === true ? "Provider reported terminal consumption for this resource/week." : "Provider page is not terminal. Empty or missing-next is not a completed workload.",
        occupancy.dropped_job_rows ? (occupancy.dropped_job_rows + " job-assignment rows were not used as Outlook occupancy.") : "Occupancy is scoper Outlook event_id rows.",
        cov.leave_state === "unavailable" ? "Leave source was unavailable (read failed). Unavailable is not absent." :
        cov.leave_state === "unread" || cov.leave_state === "not_read" ? "Leave/calendar coverage is unread or not_read. Unread is not free capacity." :
        cov.any_unread_or_not_read === true ? "A calendar source is unread or not_read. Unread is not free capacity." :
        cov.leave_roster_complete === true
          ? (cov.matched_rows ? "Leave intervals observed against a complete staff roster." : "Leave source was read against a complete roster and no leave rows exist for this scoper (absent).")
          : (cov.matched_rows
            ? "Staff availability leave days for this scoper were applied. Roster completeness is incomplete, not absent."
            : "Staff availability was read; no row matched this scoper. Incomplete roster coverage, not proof of no leave (absent)."),
        cov.travel_state === "observed" ? "Travel minutes observed from drive_time_cache." :
        cov.travel_state === "unavailable" ? "Travel source drive_time_cache is unavailable in this environment. Unavailable is not unread." :
        "Travel unread.",
      ],
    },
    events: cal.events || [],
    cases,
  };
}

export async function persistDraft(db: BookingDb, body: { case_id: string; text?: string; human_edited?: boolean; sender?: string | null; expected_revision?: number }, actor: BookingActor) {
  const a = assertBookingActor(actor);
  if (!body.case_id) throw new SalesBookingError("case_id required");
  const actorUuid = /^[0-9a-f-]{36}$/i.test(a.user_id) ? a.user_id : null;
  const { data, error } = await db.rpc("sales_booking_cas_draft", {
    p_org_id: a.org_id,
    p_case_id: body.case_id,
    p_text: body.text ?? "",
    p_human_edited: !!body.human_edited,
    p_sender: body.sender ?? null,
    p_actor_id: actorUuid,
    p_expected_revision: body.expected_revision ?? 0,
  });
  if (error) throw new SalesBookingError(error.message, 500, "rpc");
  if (!data || data.ok === false) {
    throw new SalesBookingError("Draft revision conflict", 409, String(data && data.code || "cas_conflict"));
  }
  const readback = (await db.selectMatch("sales_booking_drafts", { case_id: body.case_id, org_id: a.org_id })).data[0];
  if (!readback) throw new SalesBookingError("Draft readback missing", 500, "upsert_failed");
  return readback;
}

export async function persistAssessment(db: BookingDb, body: { case_id: string; version: string; payload: Record<string, unknown>; lease_generation?: string; observed_source_version?: string }, actor: BookingActor) {
  const a = assertBookingActor(actor);
  if (!body.case_id || !body.payload) throw new SalesBookingError("assessment payload required");
  const c = (await db.selectMatch("sales_booking_cases", { id: body.case_id, org_id: a.org_id })).data[0];
  if (!c) throw new SalesBookingError("unknown case", 404, "unknown_case");
  if (body.observed_source_version && c.source_version !== body.observed_source_version) {
    throw new SalesBookingError("stale source version", 409, "stale_source");
  }
  if (body.lease_generation) {
    const leases = await db.selectMatch("sales_booking_leases", { org_id: a.org_id, case_id: body.case_id });
    const live = leases.data.find((l) => !l.released);
    if (live && live.generation !== body.lease_generation) throw new SalesBookingError("stale lease generation", 409, "stale_lease");
  }
  const prior = (await db.selectMatch("sales_booking_assessments", { case_id: body.case_id, org_id: a.org_id })).data[0];
  const priorPayload = (prior?.payload || {}) as { status?: string; classification?: string; source_hash?: string };
  const incomingHash = (body.payload.source_hash as string | undefined) || null;
  const incomplete = body.payload.classification === "unassessed_conversation" ||
    body.payload.stale === true ||
    body.payload.ok === false;
  let payload: Record<string, unknown>;
  if (incomplete) {
    payload = {
      ...body.payload,
      source_version: c.source_version,
      source_hash: incomingHash,
      lease_generation: body.lease_generation || null,
      classification: body.payload.classification || "unassessed_conversation",
      status: "needs_decision",
      proposal: null,
      stale: true,
      held: true,
      actionable: false,
      invalidated: true,
      prior_invalidated: priorPayload.status === "ready" || priorPayload.classification === "ready" || priorPayload.classification === "assessed",
      reason: body.payload.reason || "Current conversation or source read is incomplete. A previous Ready proposal is not current.",
    };
    if (c.status === "ready" || c.status === "proposal") {
      requireUpsert(await db.upsert("sales_booking_cases", { ...c, status: "needs_decision", updated_at: nowIso() }));
    }
  } else {
    payload = {
      ...body.payload,
      source_version: c.source_version,
      lease_generation: body.lease_generation || null,
      stale: false,
      actionable: body.payload.actionable !== false,
    };
  }
  const rec = {
    case_id: body.case_id,
    org_id: a.org_id,
    version: body.version,
    source_hash: incomingHash,
    payload,
    at: nowIso(),
  };
  requireUpsert(await db.upsert("sales_booking_assessments", rec));
  return rec;
}

function draftTextAllowed(text: string) {
  if (!text || !text.trim()) return { ok: false, code: "draft_required" };
  if (text.indexOf("\u2014") >= 0 || text.indexOf("—") >= 0) return { ok: false, code: "em_dash_forbidden" };
  if (/\$\s*\d/.test(text) || /quote for/i.test(text)) return { ok: false, code: "price_forbidden" };
  return { ok: true };
}

/** Unwrap GHL pager envelopes. data.messages may be { messages, nextPage, lastMessageId }. */
export function extractGhlPage(raw: Record<string, unknown>, keys: string[]) {
  const bags: Record<string, unknown>[] = [raw];
  if (raw.data && typeof raw.data === "object" && !Array.isArray(raw.data)) bags.push(raw.data as Record<string, unknown>);
  for (const bag of bags) {
    for (const k of keys) {
      const v = bag[k];
      if (Array.isArray(v)) return v as Record<string, unknown>[];
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const inner = v as Record<string, unknown>;
        if (Array.isArray(inner.messages)) return inner.messages as Record<string, unknown>[];
        if (Array.isArray(inner.conversations)) return inner.conversations as Record<string, unknown>[];
      }
    }
  }
  if (Array.isArray(raw.data)) return raw.data as Record<string, unknown>[];
  return [] as Record<string, unknown>[];
}

export function extractGhlPageMeta(raw: Record<string, unknown>) {
  const pag = (raw.pagination && typeof raw.pagination === "object") ? raw.pagination as Record<string, unknown> : {};
  const data = (raw.data && typeof raw.data === "object" && !Array.isArray(raw.data)) ? raw.data as Record<string, unknown> : {};
  const bag = (data.messages && typeof data.messages === "object" && !Array.isArray(data.messages)) ? data.messages as Record<string, unknown> : {};
  const has_more = raw.has_more === true || pag.has_more === true || bag.nextPage === true;
  const complete = raw.complete === true || pag.complete === true;
  const next = raw.next_cursor || pag.next_cursor || pag.next || bag.lastMessageId;
  const returned = Number(pag.returned ?? raw.returned ?? 0);
  return { has_more, complete, next, returned };
}

function canonicalCapturedMessage(m: Record<string, unknown>) {
  return {
    id: String(m.id || ""),
    direction: String(m.direction || ""),
    timestamp: String(m.timestamp || ""),
    body: String(m.body || m.text || ""),
  };
}

async function hashCapturedMessages(messages: Record<string, unknown>[]) {
  const payload = JSON.stringify(messages.map(canonicalCapturedMessage));
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function captureConversation(
  db: BookingDb,
  adapters: Adapters,
  body: { case_id: string },
  actor: BookingActor,
) {
  const a = assertBookingActor(actor);
  const c = (await db.selectMatch("sales_booking_cases", { id: body.case_id, org_id: a.org_id })).data[0];
  if (!c) throw new SalesBookingError("unknown case", 404, "unknown_case");
  if (!c.contact_id) throw new SalesBookingError("case has no contact", 400, "no_contact");
  if (!adapters.getConversation) throw new SalesBookingError("conversation capture is unavailable", 409, "capture_unavailable");
  let convo: {
    messages?: Record<string, unknown>[];
    coverage?: {
      has_more?: boolean;
      complete?: boolean;
      source?: string;
      conversation_count?: number;
      conversation_pages?: number;
      message_pages?: number;
      conversations_complete?: boolean;
      messages_complete?: boolean;
      next_cursor?: unknown;
      horizon?: string;
    };
    retrieved_at?: string;
  };
  try {
    convo = await adapters.getConversation(String(c.contact_id));
  } catch (err) {
    throw new SalesBookingError((err as Error).message || "capture failed", 409, "capture_unavailable");
  }
  const messages = (Array.isArray(convo.messages) ? convo.messages : []).map(canonicalCapturedMessage);
  const cov = convo.coverage || {};
  const retrieved_at = convo.retrieved_at || null;
  let completeness: "complete" | "partial" | "unknown" = "unknown";
  if (cov.complete === true && cov.has_more === false && retrieved_at) completeness = "complete";
  else if (cov.has_more === true || cov.complete === false) completeness = "partial";
  else completeness = "unknown";
  const content_hash = await hashCapturedMessages(messages);
  const rec = {
    capture_id: `cap_${crypto.randomUUID()}`,
    org_id: a.org_id,
    case_id: String(c.id),
    contact_id: String(c.contact_id),
    source_version: String(c.source_version || ""),
    captured_at: nowIso(),
    cutoff_at: messages.reduce((acc, m) => (m.timestamp > acc ? m.timestamp : acc), ""),
    content_hash,
    messages,
    has_more: completeness !== "complete",
    completeness,
    coverage: cov,
    retrieved_at: retrieved_at || nowIso(),
  };
  requireUpsert(await db.upsert("sales_booking_conversation_captures", rec));
  return {
    ok: true,
    capture_id: rec.capture_id,
    case_id: rec.case_id,
    contact_id: rec.contact_id,
    source_version: rec.source_version,
    content_hash,
    message_count: messages.length,
    has_more: rec.has_more,
    completeness,
    incomplete: completeness !== "complete",
    retrieved_at: rec.retrieved_at,
    coverage: cov,
  };
}

function latestCapture(rows: Record<string, unknown>[], caseId: string, sourceVersion: string) {
  return rows
    .filter((r) => r.case_id === caseId && String(r.source_version || "") === sourceVersion)
    .sort((a, b) => String(b.captured_at || "").localeCompare(String(a.captured_at || "")))[0];
}

export async function submitInterpretation(
  db: BookingDb,
  body: {
    case_id: string;
    observed_source_version?: string;
    resource_id?: string;
    input?: Record<string, unknown>;
    interpretation: {
      interpreter: { identity: string; version?: string };
      cited_message_ids?: string[];
      customer_windows?: Record<string, unknown>[];
      candidate_slots?: { start_iso: string; end_iso: string }[];
      proposed_text?: string;
      customer_intent?: string;
      holds?: string[];
    };
  },
  actor: BookingActor,
) {
  const a = assertBookingActor(actor);
  if (!body.case_id || !body.interpretation) throw new SalesBookingError("interpretation required");
  const c = (await db.selectMatch("sales_booking_cases", { id: body.case_id, org_id: a.org_id })).data[0];
  if (!c) throw new SalesBookingError("unknown case", 404, "unknown_case");
  if (body.observed_source_version && c.source_version !== body.observed_source_version) {
    throw new SalesBookingError("stale source version", 409, "stale_source");
  }
  if (body.resource_id && body.resource_id !== c.resource_id) {
    throw new SalesBookingError("wrong staff resource", 409, "wrong_staff");
  }
  const interp = body.interpretation;
  if (!interp.interpreter || !interp.interpreter.identity) throw new SalesBookingError("interpreter identity required", 400, "interpreter_required");
  const captures = await db.selectMatch("sales_booking_conversation_captures", { org_id: a.org_id, case_id: body.case_id });
  const capture = latestCapture(captures.data, body.case_id, String(c.source_version || ""));
  if (!capture) throw new SalesBookingError("authoritative conversation capture required", 409, "capture_required");
  if (String(capture.contact_id || "") !== String(c.contact_id || "")) {
    throw new SalesBookingError("capture contact does not match the case", 409, "wrong_contact");
  }
  if (String(capture.source_version || "") !== String(c.source_version || "")) {
    throw new SalesBookingError("capture is not for the current source revision", 409, "stale_capture");
  }
  if (String(capture.completeness || "") !== "complete" || capture.has_more) {
    throw new SalesBookingError("conversation capture is incomplete", 409, "capture_incomplete");
  }
  const messages = (Array.isArray(capture.messages) ? capture.messages : []).map((m) => canonicalCapturedMessage(m as Record<string, unknown>));
  const callerMessages = Array.isArray((body.input as { messages?: unknown[] } | undefined)?.messages)
    ? ((body.input as { messages: Record<string, unknown>[] }).messages).map(canonicalCapturedMessage)
    : [];
  for (const id of interp.cited_message_ids || []) {
    const captured = messages.find((m) => m.id === String(id));
    if (!captured) throw new SalesBookingError("caller-only citation is not captured evidence", 400, "caller_only_citation");
    const caller = callerMessages.find((m) => m.id === String(id));
    if (caller && caller.body !== captured.body) {
      throw new SalesBookingError("cited message body does not match capture", 400, "altered_body");
    }
  }
  if (interp.proposed_text) {
    const allowed = draftTextAllowed(interp.proposed_text);
    if (!allowed.ok) throw new SalesBookingError("proposed text refused", 400, allowed.code);
  }
  const resource = RESOURCES[String(c.resource_id)] || RESOURCES.nithin;
  const input = {
    ...(body.input || {}),
    messages,
    week_start: String((body.input as { week_start?: string } | undefined)?.week_start || "2026-09-14"),
    now: String((body.input as { now?: string } | undefined)?.now || new Date().toISOString()),
    resource,
    suburb: c.suburb || (body.input as { suburb?: string } | undefined)?.suburb,
    coverage: (body.input as { coverage?: Record<string, unknown> } | undefined)?.coverage || { leave_roster_complete: false, leave_state: "incomplete", travel_state: "unavailable" },
  };
  const ground = conservativeExtract(input);
  const model = {
    customer_windows: interp.customer_windows || [],
    candidate_slots: interp.candidate_slots || [],
    proposed_text: interp.proposed_text,
    interpreter: `${interp.interpreter.identity}/${interp.interpreter.version || "unversioned"}`,
  };
  const payload = validate(ground, model, input) as Record<string, unknown>;
  payload.interpreter = interp.interpreter;
  payload.customer_intent = interp.customer_intent || null;
  payload.submitted_holds = interp.holds || [];
  payload.capture_id = capture.capture_id;
  payload.capture_hash = capture.content_hash;
  payload.cited_message_ids = interp.cited_message_ids || [];
  payload.capture_completeness = capture.completeness;
  payload.intelligent_automation = interp.interpreter.identity !== "authorised_local_reason";
  payload.paid_model = false;
  if (c.contact_id) {
    const suburbKey = String(c.suburb || (body.input as { suburb?: string } | undefined)?.suburb || "").trim().toLowerCase();
    const siblings = (await db.selectMatch("sales_booking_cases", { org_id: a.org_id, contact_id: c.contact_id })).data.filter((row) => row.id !== c.id);
    const archives = await db.selectMatch("sales_booking_archives", { org_id: a.org_id });
    for (const sib of siblings) {
      const archived = archives.data.some((ar) => ar.case_id === sib.id && !ar.restored);
      if (archived || sib.status === "completed") continue;
      const sibSuburb = String(sib.suburb || "").trim().toLowerCase();
      const sameScope = suburbKey !== "" && sibSuburb === suburbKey;
      if (!sameScope) continue;
      const ass = (await db.selectMatch("sales_booking_assessments", { case_id: sib.id, org_id: a.org_id })).data[0];
      const prop = (ass?.payload as { proposal?: { start_iso?: string } } | undefined)?.proposal;
      if (prop && prop.start_iso) {
        payload.ambiguous_duplicate_scope = true;
        payload.review_reasons = [
          ...((payload.review_reasons as string[]) || []),
          "Another open opportunity for this contact at the same suburb may be the same scope. Keep both visible until staff confirm they are distinct jobs.",
        ];
        break;
      }
    }
  }
  const rec = await persistAssessment(db, {
    case_id: body.case_id,
    version: String(payload.version || SALES_BOOKING_VERSION),
    payload,
    observed_source_version: String(c.source_version || ""),
  }, a);
  if (payload.draft) {
    const existingDraft = (await db.selectMatch("sales_booking_drafts", { case_id: body.case_id, org_id: a.org_id })).data[0];
    if (!existingDraft || !existingDraft.human_edited) {
      await persistDraft(db, {
        case_id: body.case_id,
        text: String(payload.draft),
        human_edited: false,
        expected_revision: existingDraft ? Number(existingDraft.revision) : 0,
      }, a);
    }
  }
  return rec;
}

export async function archiveCase(db: BookingDb, body: { case_id: string; reason?: string; note?: string }, actor: BookingActor) {
  const a = assertBookingActor(actor);
  const c = (await db.selectMatch("sales_booking_cases", { id: body.case_id, org_id: a.org_id })).data[0];
  if (!c) throw new SalesBookingError("unknown case", 404, "unknown_case");
  if (c.event_id || c.exact_acceptance || c.accepted_offer_id) throw new SalesBookingError("Archive cannot hide a diary event or outstanding offer", 409, "commitment_visible");
  const offers = await db.selectMatch("sales_booking_offers", { case_id: body.case_id, org_id: a.org_id });
  if (offers.data.some((o) => o.send_evidence === "sent" || o.send_evidence === "held")) {
    throw new SalesBookingError("Archive cannot hide an outstanding offer", 409, "commitment_visible");
  }
  if (!body.reason) throw new SalesBookingError("reason required");
  const rec = { case_id: body.case_id, org_id: a.org_id, reason: body.reason, note: body.note || "", restored: false, contact_id: c.contact_id || null, at: nowIso(), crm_deleted: false };
  requireUpsert(await db.upsert("sales_booking_archives", rec));
  return rec;
}

export async function restoreCase(db: BookingDb, caseId: string, actor: BookingActor) {
  const a = assertBookingActor(actor);
  const rec = (await db.selectMatch("sales_booking_archives", { case_id: caseId, org_id: a.org_id })).data[0];
  if (!rec) throw new SalesBookingError("not archived", 404, "not_archived");
  requireUpsert(await db.upsert("sales_booking_archives", { ...rec, restored: true }));
  return { ok: true, crm_deleted: false, contact_id: rec.contact_id };
}

export async function onEvent(db: BookingDb, adapters: Adapters, body: { event_key: string; type: string; case_id?: string; message_id?: string; input?: { messages?: unknown[] } }, actor: BookingActor) {
  const a = assertBookingActor(actor);
  if (!body.event_key) throw new SalesBookingError("event_key required");
  const ingest = await db.rpc("sales_booking_ingest_event", { p_org_id: a.org_id, p_event_key: body.event_key });
  if (ingest.data?.processed) return { ok: true, duplicate: true, assessed: false };
  const assessFn = adapters.assessCase || ((input: Record<string, unknown>) => runAssessment(input));
  if (!body.case_id) {
    return { ok: true, duplicate: false, assessed: false, reason: "no_case" };
  }
  const invocation = crypto.randomUUID();
  const leaseId = `assess:${a.org_id}:${body.case_id}:${invocation}`;
  const lease = await db.rpc("sales_booking_acquire_lease", {
    p_org_id: a.org_id, p_lease_id: leaseId, p_case_id: body.case_id, p_action_kind: "assess",
    p_token: invocation, p_owner: a.user_id, p_ttl_seconds: 120,
  });
  if (lease.data?.ok === false) return { ok: true, duplicate: false, assessed: false, reason: "lease_held" };
  const c = (await db.selectMatch("sales_booking_cases", { id: body.case_id, org_id: a.org_id })).data[0];
  if (!c) {
    await db.rpc("sales_booking_release_lease", { p_org_id: a.org_id, p_lease_id: leaseId, p_token: invocation });
    return { ok: true, duplicate: false, assessed: false, reason: "unknown_case" };
  }
  if ((body.type === "inbound" || body.type === "email_inbound") && body.message_id) {
    const nextVersion = `ghl:${c.id}:msg:${body.message_id}`;
    if (String(c.source_version || "") !== nextVersion) {
      requireUpsert(await db.upsert("sales_booking_cases", { ...c, source_version: nextVersion, updated_at: nowIso() }));
      c.source_version = nextVersion;
    }
  }
  if (c.archived) { /* archives joined separately */ }
  const arch = (await db.selectMatch("sales_booking_archives", { case_id: body.case_id, org_id: a.org_id })).data[0];
  if (arch && !arch.restored) {
    requireUpsert(await db.upsert("sales_booking_archives", { ...arch, restored: true, reason: "inbound_reopen" }));
  }
  try {
    const eventHasMessages = Array.isArray(body.input?.messages);
    if ((body.type === "inbound" || body.type === "email_inbound") && !eventHasMessages) {
      await db.rpc("sales_booking_mark_event_processed", { p_org_id: a.org_id, p_event_key: body.event_key });
      return { ok: true, duplicate: false, assessed: false, reason: "source_bumped_stale_proposal", source_version: c.source_version };
    }
    const payload = await assessFn({ case: c, event: body, org_id: a.org_id });
    if (payload.classification === "unassessed_conversation" && !eventHasMessages) {
      await db.rpc("sales_booking_mark_event_processed", { p_org_id: a.org_id, p_event_key: body.event_key });
      return { ok: true, duplicate: false, assessed: false, reason: "unassessed_conversation" };
    }
    await persistAssessment(db, {
      case_id: body.case_id, version: String(payload.version || SALES_BOOKING_VERSION), payload,
      lease_generation: String(lease.data?.generation || ""), observed_source_version: String(c.source_version || ""),
    }, a);
    await db.rpc("sales_booking_mark_event_processed", { p_org_id: a.org_id, p_event_key: body.event_key });
    return { ok: true, duplicate: false, assessed: true, type: body.type };
  } catch (err) {
    return { ok: false, duplicate: false, assessed: false, reason: "assess_failed", error: (err as Error).message };
  } finally {
    await db.rpc("sales_booking_release_lease", { p_org_id: a.org_id, p_lease_id: leaseId, p_token: invocation });
  }
}

export async function reconcile(db: BookingDb, body: { case_id?: string; reason?: string; expected_version?: string }, actor: BookingActor) {
  const a = assertBookingActor(actor);
  if (body.case_id && body.expected_version) {
    const cas = await db.rpc("sales_booking_cas_case", {
      p_org_id: a.org_id, p_id: body.case_id, p_expected_version: body.expected_version, p_next_version: `rec:${Date.now()}`, p_status: "needs_decision",
    });
    if (cas.data?.ok === false) return { ok: false, invalidated: 0, code: cas.data.code };
    const rows = await db.selectMatch("sales_booking_assessments", { case_id: body.case_id, org_id: a.org_id });
    if (rows.data[0]) requireUpsert(await db.upsert("sales_booking_assessments", { ...rows.data[0], payload: { ...(rows.data[0].payload as object || {}), invalidated: true, reason: body.reason || "reconcile" } }));
    return { ok: true, invalidated: 1 };
  }
  return { ok: true, invalidated: 0, reason: "scoped_reconcile_required" };
}

export async function runnerTick(db: BookingDb, adapters: Adapters, opts: { runner_enabled?: boolean } | undefined, actor: BookingActor) {
  const a = assertBookingActor(actor);
  const enabled = opts?.runner_enabled ?? POLICY.runner_enabled;
  requireUpsert(await db.upsert("sales_booking_runner_journal", {
    id: `j-${Date.now()}`, org_id: a.org_id, kind: "tick", status: enabled ? "running" : "held",
    detail: { runner_enabled: enabled, send: "held", calendar_write: "held" }, at: nowIso(),
  }));
  if (!enabled) return { ok: true, ran: false, reason: "runner_held", policy: POLICY, sent: 0, journaled: true };
  const assessFn = adapters.assessCase || ((input: Record<string, unknown>) => runAssessment(input));
  const dueRows = await db.selectMatch("sales_booking_cases", { org_id: a.org_id, status: "needs_decision" });
  const due: Record<string, unknown>[] = [];
  for (const c of dueRows.data.sort((x, y) => String(x.last_runner_at || "").localeCompare(String(y.last_runner_at || "")))) {
    const existing = (await db.selectMatch("sales_booking_assessments", { case_id: c.id, org_id: a.org_id })).data[0];
    const payload = existing?.payload as { invalidated?: boolean; source_version?: string } | undefined;
    if (existing && !payload?.invalidated && payload?.source_version === c.source_version) continue;
    due.push(c);
  }
  let assessed = 0;
  for (const c of due.slice(0, 20)) {
    const existing = (await db.selectMatch("sales_booking_assessments", { case_id: c.id, org_id: a.org_id })).data[0];
    const invocation = crypto.randomUUID();
    const leaseId = `assess:${a.org_id}:${c.id}:${invocation}`;
    const lease = await db.rpc("sales_booking_acquire_lease", {
      p_org_id: a.org_id, p_lease_id: leaseId, p_case_id: String(c.id), p_action_kind: "assess",
      p_token: invocation, p_owner: a.user_id, p_ttl_seconds: 60,
    });
    if (lease.data?.ok === false) continue;
    const observed = String(c.source_version || "");
    try {
      let messages: Record<string, unknown>[] = [];
      let conversation_state: "observed" | "empty" | "unavailable" | "unread" = "unread";
      const captureRows = (await db.selectMatch("sales_booking_conversation_captures", { org_id: a.org_id, case_id: String(c.id) })).data;
      const capture = latestCapture(captureRows, String(c.id), observed);
      if (capture && String(capture.completeness) === "complete" && Array.isArray(capture.messages)) {
        messages = capture.messages as Record<string, unknown>[];
        conversation_state = messages.length ? "observed" : "empty";
      } else if (adapters.getConversation && c.contact_id) {
        try {
          const convo = await adapters.getConversation(String(c.contact_id));
          messages = Array.isArray(convo.messages) ? convo.messages : [];
          conversation_state = messages.length ? "observed" : "empty";
        } catch {
          conversation_state = "unavailable";
        }
      }
      const resMeta = RESOURCES[String(c.resource_id)];
      const crewCov = adapters.coverageForResource && resMeta
        ? await adapters.coverageForResource(resMeta.scoper_user_id, String((c as { week_start?: string }).week_start || "2026-09-14"))
        : { leave_intervals: null, travel_minutes: null, calendar_retrieved_at: null, leave_retrieved_at: null, travel_retrieved_at: null, leave_state: "unread" as const, travel_state: "unavailable" as const, leave_roster_complete: false };
      let cioCoverage: CioCalendarCoverage | null = null;
      try {
        const cioRpc = await db.rpc("read_calendar_coverage", { p_org_id: a.org_id, p_owner_key: String(c.resource_id || "nithin") });
        if (!cioRpc.error && cioRpc.data && typeof cioRpc.data === "object") cioCoverage = cioRpc.data as CioCalendarCoverage;
      } catch {
        cioCoverage = null;
      }
      const cov = mergeCioCalendarCoverage(crewCov, cioCoverage);
      const result = await assessFn({
        case: c,
        source: "runner",
        org_id: a.org_id,
        cached_hash: existing?.source_hash,
        cached_payload: existing?.payload as Record<string, unknown> | undefined,
        input: {
          messages,
          week_start: String((c as { week_start?: string }).week_start || "2026-09-14"),
          resource: resMeta,
          conversation_state,
          coverage: {
            leave_state: cov.leave_state,
            travel_state: cov.travel_state,
            leave_roster_complete: cov.leave_roster_complete === true,
            any_unread_or_not_read: cov.any_unread_or_not_read === true,
            treat_as_free: false,
          },
          leave_retrieved_at: cov.leave_retrieved_at,
          travel_retrieved_at: cov.travel_retrieved_at,
          leave_intervals: cov.leave_intervals,
          travel_minutes: cov.travel_minutes,
          calendar_retrieved_at: cov.calendar_retrieved_at,
        },
      });
      await persistAssessment(db, {
        case_id: String(c.id), version: String(result.version || SALES_BOOKING_VERSION), payload: result,
        lease_generation: String(lease.data?.generation || ""), observed_source_version: observed,
      }, a);
      requireUpsert(await db.upsert("sales_booking_cases", { ...c, last_runner_at: nowIso() }));
      assessed += 1;
    } catch (err) {
      if (err instanceof SalesBookingError && err.code === "stale_source") throw err;
      requireUpsert(await db.upsert("sales_booking_cases", { ...c, last_runner_at: nowIso() }));
    } finally {
      await db.rpc("sales_booking_release_lease", { p_org_id: a.org_id, p_lease_id: leaseId, p_token: invocation });
    }
  }
  return { ok: true, ran: true, assessed, sent: 0, send: "held", calendar_write: "held" };
}

export async function approveAction(
  db: BookingDb,
  adapters: Adapters,
  body: { case_id: string; kind: string; text?: string; start_iso?: string; end_iso?: string; exact_acceptance?: boolean; execute?: boolean; fake?: boolean; action_id?: string; expected_draft_revision?: number; resource_id?: string; revoke?: boolean; expired?: boolean },
  actor: BookingActor,
  hold = true,
) {
  const a = assertBookingActor(actor);
  const c = (await db.selectMatch("sales_booking_cases", { id: body.case_id, org_id: a.org_id })).data[0];
  if (!c) throw new SalesBookingError("unknown case", 404, "unknown_case");
  const resource = RESOURCES[String(c.resource_id)];
  if (resource && resource.sender_resolved === false) return { ok: false, held: true, sent: false, reason: "sender_unresolved" };
  const assessment = (await db.selectMatch("sales_booking_assessments", { case_id: body.case_id, org_id: a.org_id })).data[0];
  const assessPayload = (assessment?.payload || {}) as { stale?: boolean; actionable?: boolean; classification?: string; source_version?: string; status?: string };
  if (
    assessPayload.stale === true ||
    assessPayload.actionable === false ||
    assessPayload.classification === "unassessed_conversation" ||
    (assessPayload.source_version && assessPayload.source_version !== c.source_version)
  ) {
    return { ok: false, held: true, sent: false, booked: false, reason: "assessment_stale" };
  }
  if (body.kind === "confirm_booking") {
    if (!c.exact_acceptance || !c.accepted_start_iso || !c.accepted_end_iso) {
      return { ok: false, held: true, sent: false, booked: false, reason: "no_exact_acceptance" };
    }
    if (body.start_iso && c.accepted_start_iso !== body.start_iso) return { ok: false, held: true, booked: false, reason: "accepted_slot_mismatch" };
    if (body.end_iso && c.accepted_end_iso !== body.end_iso) return { ok: false, held: true, booked: false, reason: "accepted_slot_mismatch" };
  }
  if (body.start_iso && body.end_iso && resource) {
    const claim = await claimSlot(db, a, {
      claim_id: `claim-${a.org_id}-${body.case_id}-${body.start_iso}-${body.end_iso}`,
      resource_id: resource.id, start_iso: body.start_iso, end_iso: body.end_iso, case_id: body.case_id,
    });
    if (claim.ok === false) return { ok: false, held: true, sent: false, reason: "slot_overlap" };
  }
  const idempotencyKey = `hold:${a.org_id}:${body.case_id}:${body.kind}:${c.source_version || ""}:${body.start_iso || ""}:${body.end_iso || ""}`;
  const priorActions = await db.selectMatch("sales_booking_actions", { org_id: a.org_id, case_id: body.case_id });
  const prior = priorActions.data.find((row) => row.idempotency_key === idempotencyKey);
  if (prior && !(body.fake && body.execute)) {
    return {
      ok: false,
      held: prior.status === "held",
      sent: false,
      booked: false,
      waiting: false,
      reason: prior.status === "held" ? "send_hold" : String(prior.reason || prior.status),
      action_id: prior.action_id,
      idempotent: true,
    };
  }
  const actionId = body.action_id || (prior && body.fake && body.execute ? String(prior.action_id) : `act_${crypto.randomUUID()}`);
  const serverHold = hold || POLICY.send === "held";
  requireUpsert(await db.upsert("sales_booking_actions", {
    action_id: actionId, org_id: a.org_id, case_id: body.case_id, kind: body.kind, status: serverHold && !body.fake ? "held" : "proposed",
    stage: "proposed", source_version: c.source_version, send_evidence: "held",
    idempotency_key: idempotencyKey, provider_uncertain: false, created_at: nowIso(),
  }));
  await journalActionStage(db, a, actionId, "proposed", { kind: body.kind, source_version: c.source_version, draft_revision: body });
  if (serverHold && !body.fake) {
    requireUpsert(await db.upsert("sales_booking_actions", {
      action_id: actionId, org_id: a.org_id, case_id: body.case_id, kind: body.kind, status: "held",
      stage: "held", source_version: c.source_version, send_evidence: "held",
      idempotency_key: idempotencyKey, provider_uncertain: false, created_at: nowIso(),
    }));
    await journalActionStage(db, a, actionId, "held", { reason: "send_hold", live: false });
    return { ok: false, held: true, sent: false, booked: false, waiting: false, reason: "send_hold", action_id: actionId, stage: "held" };
  }
  if (!body.fake) throw new SalesBookingError("Live provider writes are refused", 403, "live_write_refused");
  return executeFakeSequence(db, adapters, {
    actionId, caseRow: c, body, actor: a, resource, idempotencyKey,
  });
}

async function executeFakeSequence(
  db: BookingDb,
  adapters: Adapters,
  args: {
    actionId: string;
    caseRow: Record<string, unknown>;
    body: { case_id: string; kind: string; text?: string; start_iso?: string; end_iso?: string; expected_draft_revision?: number; resource_id?: string; revoke?: boolean; expired?: boolean };
    actor: BookingActor;
    resource: { id: string; sender?: string | null; scoper_user_id: string } | undefined;
    idempotencyKey: string;
  },
) {
  const { actionId, caseRow: c, body, actor: a, resource, idempotencyKey } = args;
  const live = (await db.selectMatch("sales_booking_actions", { org_id: a.org_id, action_id: actionId })).data[0];
  if (live?.revoked || body.revoke) {
    await journalActionStage(db, a, actionId, "revoked", { reason: "approval_revoked" });
    return { ok: false, held: true, reason: "approval_revoked", action_id: actionId };
  }
  if (live?.expires_at && Date.parse(String(live.expires_at)) < Date.now() || body.expired) {
    await journalActionStage(db, a, actionId, "expired", { reason: "approval_expired" });
    return { ok: false, held: true, reason: "approval_expired", action_id: actionId };
  }
  if (body.resource_id && resource && body.resource_id !== resource.id) {
    return { ok: false, held: true, reason: "wrong_staff", action_id: actionId };
  }
  if (body.expected_draft_revision != null) {
    const draft = (await db.selectMatch("sales_booking_drafts", { org_id: a.org_id, case_id: body.case_id })).data[0];
    if (!draft || Number(draft.revision) !== Number(body.expected_draft_revision)) {
      return { ok: false, held: true, reason: "draft_revision_mismatch", action_id: actionId };
    }
  }
  const observedSource = String(c.source_version || "");
  const recordedSource = String(live?.source_version || observedSource);
  if (observedSource && recordedSource && observedSource !== recordedSource) {
    return { ok: false, held: true, reason: "source_changed", action_id: actionId };
  }
  const invocation = crypto.randomUUID();
  const lease = await db.rpc("sales_booking_acquire_lease", {
    p_org_id: a.org_id, p_lease_id: `exec:${actionId}:${invocation}`, p_case_id: body.case_id,
    p_action_kind: "execute", p_token: invocation, p_owner: a.user_id, p_ttl_seconds: 60,
  });
  if (lease.data?.ok === false) return { ok: false, held: true, reason: "lease_held", action_id: actionId };
  try {
    await journalActionStage(db, a, actionId, "executing", { fake: true, live: false });
    const journal = (await db.selectMatch("sales_booking_action_journal", { org_id: a.org_id, action_id: actionId })).data;
    const smsAlready = journal.some((row) => row.stage === "sms_sent");
    let sms: { held?: boolean; sent?: boolean; message_id?: string } | undefined;
    if (!smsAlready) {
      sms = await adapters.sendSms?.({ contact_id: c.contact_id, text: body.text, sender: resource?.sender }, { execute: true, fake: true });
      if (!sms || sms.held || !sms.sent || !sms.message_id) {
        await journalActionStage(db, a, actionId, "sms_failed", { sent: !!sms?.sent, message_id: sms?.message_id || null });
        requireUpsert(await db.upsert("sales_booking_actions", {
          action_id: actionId, org_id: a.org_id, case_id: body.case_id, kind: body.kind, status: "uncertain",
          stage: "uncertain", source_version: c.source_version, send_evidence: "uncertain",
          idempotency_key: idempotencyKey, provider_uncertain: true, created_at: nowIso(),
        }));
        return { ok: false, held: false, sent: false, booked: false, fake: true, reason: "sms_uncertain", action_id: actionId, provider_uncertain: true };
      }
      await journalActionStage(db, a, actionId, "sms_sent", { message_id: sms.message_id });
      requireUpsert(await db.upsert("sales_booking_offers", {
        offer_id: `off_${actionId}`, org_id: a.org_id, case_id: body.case_id, slot_revision: 1,
        start_iso: body.start_iso, end_iso: body.end_iso, send_evidence: "sent", sent_at: nowIso(),
      }));
    }
    let booked = false;
    if (body.kind === "confirm_booking") {
      const cal = await adapters.writeCalendar?.({ scoper_user_id: resource?.scoper_user_id, start_iso: body.start_iso, end_iso: body.end_iso, case_id: body.case_id }, { execute: true, fake: true });
      if (!cal?.written || !cal?.event_id) {
        await journalActionStage(db, a, actionId, "calendar_failed", { written: !!cal?.written, event_id: cal?.event_id || null });
        requireUpsert(await db.upsert("sales_booking_actions", {
          action_id: actionId, org_id: a.org_id, case_id: body.case_id, kind: body.kind, status: "uncertain",
          stage: "uncertain", source_version: c.source_version, send_evidence: "sent",
          idempotency_key: idempotencyKey, provider_uncertain: true, created_at: nowIso(),
        }));
        return { ok: false, sent: true, booked: false, fake: true, reason: "calendar_uncertain", action_id: actionId, provider_uncertain: true };
      }
      booked = true;
      await journalActionStage(db, a, actionId, "calendar_written", { event_id: cal.event_id });
      requireUpsert(await db.upsert("sales_booking_cases", { ...c, event_id: cal.event_id, status: "booked" }));
    }
    requireUpsert(await db.upsert("sales_booking_actions", {
      action_id: actionId, org_id: a.org_id, case_id: body.case_id, kind: body.kind, status: "complete",
      stage: "complete", source_version: c.source_version, send_evidence: "sent",
      idempotency_key: idempotencyKey, provider_uncertain: false, created_at: nowIso(),
    }));
    await journalActionStage(db, a, actionId, "complete", { fake: true, booked });
    return { ok: true, held: false, sent: true, booked, fake: true, action_id: actionId, stage: "complete", provider_uncertain: false };
  } finally {
    await db.rpc("sales_booking_release_lease", { p_org_id: a.org_id, p_lease_id: `exec:${actionId}:${invocation}`, p_token: invocation });
  }
}

function questionFingerprint(caseId: string, question: string) {
  return `${caseId}:${question.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 180)}`;
}

function inQuietHours(nowIsoStr: string) {
  const d = new Date(nowIsoStr);
  const perthHour = (d.getUTCHours() + 8) % 24;
  return perthHour >= 21 || perthHour < 7;
}

export async function openNeedsScoper(
  db: BookingDb,
  adapters: Adapters,
  body: { case_id: string; question: string; context?: string; notify?: boolean; fake?: boolean; now?: string },
  actor: BookingActor,
) {
  const a = assertBookingActor(actor);
  const c = (await db.selectMatch("sales_booking_cases", { id: body.case_id, org_id: a.org_id })).data[0];
  if (!c) throw new SalesBookingError("unknown case", 404, "unknown_case");
  const q = String(body.question || "").trim();
  if (!q) throw new SalesBookingError("question required", 400, "question_required");
  const fp = questionFingerprint(String(c.id), q);
  const existing = (await db.selectMatch("sales_booking_needs_scoper", { org_id: a.org_id, case_id: body.case_id })).data.find((row) => row.fingerprint === fp && row.status !== "closed");
  if (existing) {
    return { ok: true, deduped: true, item_id: existing.item_id, status: existing.status, notify: existing.notify_state };
  }
  const resource = RESOURCES[String(c.resource_id)] || RESOURCES.nithin;
  const itemId = `ns_${crypto.randomUUID()}`;
  const now = body.now || nowIso();
  let notify_state = "held";
  if (body.notify && body.fake) {
    notify_state = inQuietHours(now) ? "quiet_hours" : "fake_pending";
    const sms = await adapters.sendSms?.({
      contact_id: "staff-nithin",
      text: `Needs scoper: ${q.slice(0, 140)}`,
      sender: resource.sender,
      internal: true,
    }, { execute: true, fake: true });
    if (notify_state !== "quiet_hours") notify_state = sms?.sent ? "fake_delivered" : "fake_error";
  }
  const rec = {
    item_id: itemId, org_id: a.org_id, case_id: body.case_id, resource_id: c.resource_id,
    question: q, context: body.context || null, fingerprint: fp, status: "open",
    notify_state, scoper_user_id: resource.scoper_user_id, actor_id: a.user_id,
    client_send: "held", created_at: now,
  };
  requireUpsert(await db.upsert("sales_booking_needs_scoper", rec));
  return { ok: true, deduped: false, item_id: itemId, status: "open", notify: notify_state, client_send: "held" };
}

export async function answerNeedsScoper(
  db: BookingDb,
  body: { item_id: string; answer: string; apply_to_client_draft?: boolean },
  actor: BookingActor,
) {
  const a = assertBookingActor(actor);
  const items = (await db.selectMatch("sales_booking_needs_scoper", { org_id: a.org_id })).data;
  const item = items.find((row) => row.item_id === body.item_id);
  if (!item) throw new SalesBookingError("unknown item", 404, "unknown_item");
  const answer = String(body.answer || "").trim();
  if (!answer) throw new SalesBookingError("answer required", 400, "answer_required");
  requireUpsert(await db.upsert("sales_booking_needs_scoper", {
    ...item, status: "closed", answer, answered_at: nowIso(), client_send: "held",
  }));
  let draft = null;
  if (body.apply_to_client_draft) {
    draft = await persistDraft(db, {
      case_id: String(item.case_id),
      text: `Hi, ${answer} Nithin, SecureWorks Patios`,
      human_edited: false,
    }, a);
  }
  return { ok: true, item_id: body.item_id, status: "closed", client_send: "held", forwarded_to_client: false, draft_revision: draft && (draft as { revision?: number }).revision };
}

export async function dispatch(
  action: string,
  params: Record<string, string>,
  body: Record<string, unknown>,
  adapters: Adapters,
  db: BookingDb,
  method = "GET",
  actor?: BookingActor | null,
): Promise<Record<string, unknown>> {
  const a = assertBookingActor(actor);
  if (action === "sales_booking_policy") return { ok: true, policy: POLICY, version: SALES_BOOKING_VERSION };
  if (action === "sales_booking_reason") {
    const prompt = (body.prompt || body) as Record<string, unknown>;
    const out = await authorisedLocalReason(prompt);
    return { ok: true, ...out };
  }
  if (action === "sales_booking_read") {
    return await readWorkspace(db, adapters, {
      resource: params.resource || String(body.resource || "nithin"),
      week_start: params.week_start || String(body.week_start || "2026-09-14"),
      drain: params.drain === "1" || body.drain === true,
      refresh: params.refresh === "1" || body.refresh === true,
    }, a);
  }
  const writes = ["sales_booking_draft", "sales_booking_assess", "sales_booking_interpret", "sales_booking_capture_conversation", "sales_booking_archive", "sales_booking_restore", "sales_booking_approve", "sales_booking_confirm", "sales_booking_on_event", "sales_booking_reconcile", "sales_booking_runner", "sales_booking_claim_slot", "sales_booking_needs_scoper", "sales_booking_needs_scoper_answer"];
  if (writes.includes(action) && method !== "POST") throw new SalesBookingError(`${action} requires POST`, 405, "method_not_allowed");
  if (action === "sales_booking_draft") return persistDraft(db, body as { case_id: string; text?: string; human_edited?: boolean; sender?: string | null; expected_revision?: number }, a);
  if (action === "sales_booking_capture_conversation") {
    return captureConversation(db, adapters, body as { case_id: string }, a);
  }
  if (action === "sales_booking_needs_scoper") {
    return openNeedsScoper(db, adapters, body as { case_id: string; question: string; context?: string; notify?: boolean; fake?: boolean; now?: string }, a);
  }
  if (action === "sales_booking_needs_scoper_answer") {
    return answerNeedsScoper(db, body as { item_id: string; answer: string; apply_to_client_draft?: boolean }, a);
  }
  if (action === "sales_booking_interpret") {
    return submitInterpretation(db, body as Parameters<typeof submitInterpretation>[1], a);
  }
  if (action === "sales_booking_assess") {
    const cases = await db.selectMatch("sales_booking_cases", { id: body.case_id, org_id: a.org_id });
    if (!cases.data[0]) throw new SalesBookingError("unknown case", 404, "unknown_case");
    const prior = (await db.selectMatch("sales_booking_assessments", { case_id: body.case_id, org_id: a.org_id })).data[0];
    const assessFn = adapters.assessCase || ((input: Record<string, unknown>) => runAssessment(input));
    const payload = await assessFn({
      case: cases.data[0],
      input: body.input,
      org_id: a.org_id,
      cached_hash: prior?.source_hash,
      cached_payload: prior?.payload as Record<string, unknown> | undefined,
    });
    return persistAssessment(db, {
      case_id: String(body.case_id),
      version: String(payload.version || SALES_BOOKING_VERSION),
      payload,
      observed_source_version: String(cases.data[0].source_version || ""),
    }, a);
  }
  if (action === "sales_booking_archive") return archiveCase(db, body as { case_id: string; reason?: string; note?: string }, a);
  if (action === "sales_booking_restore") return restoreCase(db, String(body.case_id), a);
  if (action === "sales_booking_on_event") return onEvent(db, adapters, body as { event_key: string; type: string; case_id?: string }, a);
  if (action === "sales_booking_reconcile") return reconcile(db, body as { case_id?: string; expected_version?: string; reason?: string }, a);
  if (action === "sales_booking_runner") return runnerTick(db, adapters, { runner_enabled: body.runner_enabled === true }, a);
  if (action === "sales_booking_claim_slot") return claimSlot(db, a, body as { claim_id: string; resource_id: string; start_iso: string; end_iso: string; case_id: string });
  if (action === "sales_booking_approve" || action === "sales_booking_confirm") {
    return approveAction(db, adapters, {
      ...(body as { case_id: string; kind: string; text?: string; start_iso?: string; end_iso?: string; exact_acceptance?: boolean; execute?: boolean; fake?: boolean }),
      kind: action === "sales_booking_confirm" ? "confirm_booking" : String(body.kind || "approve_offer"),
    }, a);
  }
  throw new SalesBookingError(`unknown action ${action}`, 404, "unknown_action");
}
