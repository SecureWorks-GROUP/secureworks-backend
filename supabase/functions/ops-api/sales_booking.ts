// Sales Booking workflow. Production uses Supabase client + SQL RPCs.
// booking_test/psql is a test transport only. No Deno.Command/psql in this module.

export const SALES_BOOKING_VERSION = "sales-booking-api/v1";

export const POLICY = {
  activation: "held",
  runner_enabled: false,
  timezone: "Australia/Perth",
  on_inbound: "dedupe_then_assess",
  debounce_seconds: 60,
  catch_up_minutes: 15,
  daily_reconcile: "06:00 Australia/Perth after CIO context pass",
  send: "held",
  calendar_write: "held",
};

export const PIPELINES: Record<string, string> = {
  nithin: "OGZLpPPVWVarN94HL6af",
  marnin: "I9t8njpuR0Dm7B2NDcvI",
  khairo: "I9t8njpuR0Dm7B2NDcvI",
};

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
  coverageForResource?: (scoperUserId: string) => Promise<{
    leave_intervals: { start_iso: string; end_iso: string }[];
    travel_minutes: number | null;
    calendar_retrieved_at: string | null;
    leave_retrieved_at: string | null;
    travel_retrieved_at: string | null;
  }>;
  getConversation?: (contactId: string) => Promise<{ messages: Record<string, unknown>[] }>;
  assessCase?: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  sendSms?: (payload: Record<string, unknown>, opts: { execute: boolean; fake: boolean }) => Promise<{ held: boolean; sent: boolean; message_id?: string }>;
  writeCalendar?: (payload: Record<string, unknown>, opts: { execute: boolean; fake: boolean }) => Promise<{ held: boolean; written: boolean; event_id?: string }>;
};

export type BookingDb = {
  rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: Record<string, unknown> | null; error: { message: string } | null }>;
  upsert: (table: string, row: Record<string, unknown>) => Promise<{ error: { message: string } | null }>;
  selectEq: (table: string, col: string, val: unknown) => Promise<{ data: Record<string, unknown>[] }>;
};

function nowIso() { return new Date().toISOString(); }
function phoneLike(name: string | undefined) { return !!name && /^(\+61|0)\d/.test(name.replace(/\s/g, "")); }

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
  };
  function rows(t: string) { return mem[t] || (mem[t] = []); }
  return {
    _mem: mem,
    async rpc(fn, args = {}) {
      if (fn === "sales_booking_claim_slot") {
        const live = rows("sales_booking_slot_claims").filter((c) => !c.withdrawn && c.resource_id === args.p_resource_id);
        if (live.some((c) => rangesOverlap(String(c.start_iso), String(c.end_iso), String(args.p_start_iso), String(args.p_end_iso)))) {
          return { data: { ok: false, code: "slot_overlap" }, error: null };
        }
        rows("sales_booking_slot_claims").push({
          claim_id: args.p_claim_id, resource_id: args.p_resource_id, start_iso: args.p_start_iso,
          end_iso: args.p_end_iso, case_id: args.p_case_id, withdrawn: false, status: "held",
        });
        return { data: { ok: true, claim_id: args.p_claim_id }, error: null };
      }
      if (fn === "sales_booking_acquire_lease") {
        const live = rows("sales_booking_leases").find((l) =>
          l.case_id === args.p_case_id && l.action_kind === args.p_action_kind && !l.released &&
          new Date(String(l.expires_at)).getTime() > Date.now());
        if (live && live.token !== args.p_token) return { data: { ok: false, code: "lease_held", token: live.token }, error: null };
        rows("sales_booking_leases").push({
          lease_id: args.p_lease_id, case_id: args.p_case_id, action_kind: args.p_action_kind,
          token: args.p_token, owner: args.p_owner, released: false,
          expires_at: new Date(Date.now() + Number(args.p_ttl_seconds || 60) * 1000).toISOString(),
        });
        return { data: { ok: true, token: args.p_token, lease_id: args.p_lease_id }, error: null };
      }
      if (fn === "sales_booking_cas_case") {
        const row = rows("sales_booking_cases").find((c) => c.id === args.p_id);
        if (!row || row.source_version !== args.p_expected_version) return { data: { ok: false, code: "cas_conflict" }, error: null };
        row.source_version = args.p_next_version;
        if (args.p_status) row.status = args.p_status;
        return { data: { ok: true, id: args.p_id, source_version: args.p_next_version }, error: null };
      }
      if (fn === "sales_booking_ingest_event") {
        const seen = rows("sales_booking_seen_events");
        if (seen.some((e) => e.event_key === args.p_event_key)) return { data: { ok: true, duplicate: true }, error: null };
        seen.push({ event_key: args.p_event_key });
        return { data: { ok: true, duplicate: false }, error: null };
      }
      if (fn === "sales_booking_put_consumption_cursor") {
        const key = String(args.p_key || "");
        if (!key.startsWith("consume:")) return { data: { ok: false, code: "not_consumption_cursor" }, error: null };
        const cur = rows("sales_booking_cursors");
        const existing = cur.find((c) => c.key === key);
        if (existing) existing.payload = args.p_payload;
        else cur.push({ key, payload: args.p_payload });
        return { data: { ok: true, key }, error: null };
      }
      return { data: null, error: { message: `unknown rpc ${fn}` } };
    },
    async upsert(table, row) {
      const list = rows(table);
      const key = String(row.id || row.case_id || row.offer_id || row.action_id || row.claim_id || row.key || row.event_key);
      const idx = list.findIndex((r) => String(r.id || r.case_id || r.offer_id || r.action_id || r.claim_id || r.key || r.event_key) === key);
      if (idx >= 0) list[idx] = { ...list[idx], ...row };
      else list.push({ ...row });
      return { error: null };
    },
    async selectEq(table, col, val) {
      return { data: rows(table).filter((r) => r[col] === val) };
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
    async selectEq(table, col, val) {
      const { data, error } = await client.from(table).select("*").eq(col, val);
      if (error) throw new SalesBookingError(error.message, 500, "db_read");
      return { data: data || [] };
    },
  };
}

/** @deprecated Maps are not production state. Tests should use createMemoryBookingDb. */
export function createStore() {
  return createMemoryBookingDb();
}

export async function claimSlot(db: BookingDb, args: { claim_id: string; resource_id: string; start_iso: string; end_iso: string; case_id: string }) {
  const { data, error } = await db.rpc("sales_booking_claim_slot", {
    p_claim_id: args.claim_id, p_resource_id: args.resource_id, p_start_iso: args.start_iso, p_end_iso: args.end_iso, p_case_id: args.case_id,
  });
  if (error) throw new SalesBookingError(error.message, 500, "rpc");
  return data || { ok: false };
}

export async function readWorkspace(
  db: BookingDb,
  adapters: Adapters,
  params: { resource: string; week_start: string; drain?: boolean; max_pages?: number },
) {
  const resource = RESOURCES[params.resource];
  if (!resource) throw new SalesBookingError("Unknown resource", 400, "unknown_resource");
  const pipeline = PIPELINES[params.resource];
  const consumeKey = `consume:${params.resource}:${params.week_start}`;
  const curRows = await db.selectEq("sales_booking_cursors", "key", consumeKey);
  let cursor = (curRows.data[0]?.payload as { next?: Record<string, unknown> | null; complete?: boolean; total?: number; pages?: number }) || { next: null, complete: false, pages: 0 };
  const maxPages = params.drain ? 50 : (params.max_pages ?? 8);
  let pages = 0;
  while (!cursor.complete && pages < maxPages) {
    const page = await adapters.listOpportunities(pipeline, cursor.next || null);
    for (const item of page.items) {
      const existing = (await db.selectEq("sales_booking_cases", "id", item.id)).data[0];
      await db.upsert("sales_booking_cases", {
        id: item.id,
        resource_id: params.resource,
        opportunity_id: item.id,
        contact_id: item.contact_id,
        pipeline_id: pipeline,
        suburb: item.suburb || null,
        display_name: phoneLike(item.name) ? (item.suburb || "Enquiry") : (item.name || "Enquiry"),
        status: existing?.status || "needs_decision",
        source_version: existing?.source_version || `ghl:${item.id}`,
        updated_at: nowIso(),
      });
    }
    cursor = { next: page.next, complete: !!page.complete || !page.next, total: page.total, pages: (cursor.pages || 0) + 1 };
    const put = await db.rpc("sales_booking_put_consumption_cursor", { p_key: consumeKey, p_payload: cursor });
    if (put.data && put.data.ok === false) throw new SalesBookingError("consumption cursor refused", 400, String(put.data.code));
    pages += 1;
    if (!page.next) { cursor.complete = true; await db.rpc("sales_booking_put_consumption_cursor", { p_key: consumeKey, p_payload: cursor }); break; }
  }
  const since = `${params.week_start}T00:00:00+08:00`;
  const untilDate = new Date(`${params.week_start}T00:00:00+08:00`);
  untilDate.setUTCDate(untilDate.getUTCDate() + 5);
  const cal = await adapters.calendarEvents(resource.scoper_user_id, since, untilDate.toISOString());
  const cov = adapters.coverageForResource
    ? await adapters.coverageForResource(resource.scoper_user_id)
    : { leave_intervals: null, travel_minutes: null, calendar_retrieved_at: cal.retrieved_at || null, leave_retrieved_at: null, travel_retrieved_at: null };
  for (const ev of cal.events || []) {
    await db.upsert("sales_booking_cases", {
      id: ev.event_id, resource_id: params.resource, event_id: ev.event_id, suburb: ev.suburb || null,
      display_name: ev.subject || "Diary", status: "booked", updated_at: nowIso(),
    });
  }
  const listed = await db.selectEq("sales_booking_cases", "resource_id", params.resource);
  const cases = listed.data;
  const enumerated = cases.filter((c) => c.opportunity_id).length;
  const leaveObserved = Array.isArray(cov.leave_intervals) && !!cov.leave_retrieved_at;
  const travelObserved = cov.travel_minutes != null && !!cov.travel_retrieved_at;
  return {
    ok: true, fixture: false, send_hold: true, version: SALES_BOOKING_VERSION, policy: POLICY,
    resource: { ...resource, calendar: { ok: cal.ok, mailbox: cal.mailbox || null } },
    week_start: params.week_start,
    coverage: {
      full_population: !!cursor.complete,
      enumerated,
      total: cursor.total ?? enumerated,
      calendar_retrieved_at: cov.calendar_retrieved_at,
      leave_retrieved_at: cov.leave_retrieved_at,
      leave_intervals: cov.leave_intervals,
      travel_retrieved_at: cov.travel_retrieved_at,
      travel_minutes: cov.travel_minutes,
      boolean_flags_are_not_capacity: true,
      gaps: [
        cursor.complete ? "Workflow consumption cursor terminal for this resource/week." : "Workflow consumption still paging; CIO owns provider ingestion.",
        leaveObserved ? "Leave intervals observed." : "Leave intervals unobserved.",
        travelObserved ? "Travel minutes observed." : "Travel unobserved.",
      ],
    },
    events: cal.events || [],
    cases,
  };
}

export async function persistDraft(db: BookingDb, body: { case_id: string; text?: string; human_edited?: boolean; sender?: string | null }) {
  if (!body.case_id) throw new SalesBookingError("case_id required");
  const prev = (await db.selectEq("sales_booking_drafts", "case_id", body.case_id)).data[0] || { revision: 0 };
  const next = {
    case_id: body.case_id, text: body.text ?? prev.text, human_edited: body.human_edited ?? prev.human_edited ?? false,
    sender: body.sender ?? prev.sender ?? null, revision: Number(prev.revision || 0) + 1, updated_at: nowIso(),
  };
  await db.upsert("sales_booking_drafts", next);
  return next;
}

export async function persistAssessment(db: BookingDb, body: { case_id: string; version: string; payload: Record<string, unknown> }) {
  if (!body.case_id || !body.payload) throw new SalesBookingError("assessment payload required");
  const rec = { case_id: body.case_id, version: body.version, payload: body.payload, at: nowIso() };
  await db.upsert("sales_booking_assessments", rec);
  return rec;
}

export async function onEvent(
  db: BookingDb,
  adapters: Adapters,
  body: { event_key: string; type: string; case_id?: string },
) {
  if (!body.event_key) throw new SalesBookingError("event_key required");
  const ingest = await db.rpc("sales_booking_ingest_event", { p_event_key: body.event_key });
  if (ingest.data?.duplicate) return { ok: true, duplicate: true, assessed: false };
  if (!body.case_id || !adapters.assessCase) {
    return { ok: true, duplicate: false, assessed: false, reason: adapters.assessCase ? "no_case" : "no_assess_worker" };
  }
  const lease = await db.rpc("sales_booking_acquire_lease", {
    p_lease_id: `lease-${body.event_key}`, p_case_id: body.case_id, p_action_kind: "assess",
    p_token: `tok-${body.event_key}`, p_owner: "event-worker", p_ttl_seconds: 120,
  });
  if (lease.data?.ok === false) return { ok: true, duplicate: false, assessed: false, reason: "lease_held" };
  const cases = await db.selectEq("sales_booking_cases", "id", body.case_id);
  const c = cases.data[0];
  if (!c) return { ok: true, duplicate: false, assessed: false, reason: "unknown_case" };
  const payload = await adapters.assessCase({ case: c, event: body });
  await persistAssessment(db, { case_id: body.case_id, version: String(payload.version || SALES_BOOKING_VERSION), payload });
  return { ok: true, duplicate: false, assessed: true, type: body.type };
}

export async function reconcile(db: BookingDb, body: { case_id?: string; reason?: string; expected_version?: string }) {
  if (body.case_id && body.expected_version) {
    const cas = await db.rpc("sales_booking_cas_case", {
      p_id: body.case_id, p_expected_version: body.expected_version, p_next_version: `rec:${Date.now()}`, p_status: "needs_decision",
    });
    if (cas.data?.ok === false) return { ok: false, invalidated: 0, code: cas.data.code };
    const rows = await db.selectEq("sales_booking_assessments", "case_id", body.case_id);
    if (rows.data[0]) {
      await db.upsert("sales_booking_assessments", { ...rows.data[0], payload: { ...(rows.data[0].payload as object || {}), invalidated: true, reason: body.reason || "reconcile" } });
    }
    return { ok: true, invalidated: 1 };
  }
  return { ok: true, invalidated: 0, reason: "scoped_reconcile_required" };
}

export async function runnerTick(db: BookingDb, adapters: Adapters, opts?: { runner_enabled?: boolean }) {
  const enabled = opts?.runner_enabled ?? POLICY.runner_enabled;
  if (!enabled) return { ok: true, ran: false, reason: "runner_held", policy: POLICY, sent: 0 };
  if (!adapters.assessCase) return { ok: true, ran: false, reason: "no_assess_worker", sent: 0 };
  const due = await db.selectEq("sales_booking_cases", "status", "needs_decision");
  let assessed = 0;
  for (const c of due.data.slice(0, 20)) {
    const lease = await db.rpc("sales_booking_acquire_lease", {
      p_lease_id: `run-${c.id}`, p_case_id: c.id, p_action_kind: "assess",
      p_token: `run-tok-${c.id}`, p_owner: "runner", p_ttl_seconds: 60,
    });
    if (lease.data?.ok === false) continue;
    const payload = await adapters.assessCase({ case: c, source: "runner" });
    await persistAssessment(db, { case_id: String(c.id), version: String(payload.version || SALES_BOOKING_VERSION), payload });
    assessed += 1;
  }
  return { ok: true, ran: true, assessed, sent: 0, send: "held", calendar_write: "held" };
}

export async function approveAction(
  db: BookingDb,
  adapters: Adapters,
  body: { case_id: string; kind: string; text?: string; start_iso?: string; end_iso?: string; exact_acceptance?: boolean; execute?: boolean; fake?: boolean },
  hold = true,
) {
  const found = await db.selectEq("sales_booking_cases", "id", body.case_id);
  const c = found.data[0];
  if (!c) throw new SalesBookingError("unknown case", 404, "unknown_case");
  const resource = RESOURCES[String(c.resource_id)];
  if (resource && resource.sender_resolved === false) return { ok: false, held: true, sent: false, reason: "sender_unresolved" };
  if (body.kind === "confirm_booking") {
    if (!body.exact_acceptance) return { ok: false, held: true, sent: false, booked: false, reason: "no_exact_acceptance" };
    if (c.accepted_start_iso && body.start_iso && c.accepted_start_iso !== body.start_iso) {
      return { ok: false, held: true, booked: false, reason: "accepted_slot_mismatch" };
    }
    if (c.accepted_end_iso && body.end_iso && c.accepted_end_iso !== body.end_iso) {
      return { ok: false, held: true, booked: false, reason: "accepted_slot_mismatch" };
    }
  }
  if (body.start_iso && body.end_iso && resource) {
    const claim = await claimSlot(db, {
      claim_id: `claim-${body.case_id}-${body.start_iso}`,
      resource_id: resource.id, start_iso: body.start_iso, end_iso: body.end_iso, case_id: body.case_id,
    });
    if (claim.ok === false) return { ok: false, held: true, sent: false, reason: "slot_overlap" };
  }
  const actionId = `act_${Date.now()}`;
  if (hold && !body.execute) {
    await db.upsert("sales_booking_actions", { action_id: actionId, case_id: body.case_id, kind: body.kind, status: "held", send_evidence: "held", created_at: nowIso() });
    return { ok: false, held: true, sent: false, booked: false, waiting: false, reason: "send_hold", action_id: actionId };
  }
  if (!body.fake) throw new SalesBookingError("Live provider writes are refused", 403, "live_write_refused");
  const sms = await adapters.sendSms?.({ contact_id: c.contact_id, text: body.text, sender: resource?.sender }, { execute: true, fake: true });
  await db.upsert("sales_booking_offers", {
    offer_id: `off_${actionId}`, case_id: body.case_id, slot_revision: 1, start_iso: body.start_iso, end_iso: body.end_iso,
    send_evidence: sms?.sent ? "sent" : "failed", sent_at: sms?.sent ? nowIso() : null,
  });
  return { ok: true, held: false, sent: !!sms?.sent, booked: false, fake: true, action_id: actionId };
}

export async function dispatch(
  action: string,
  params: Record<string, string>,
  body: Record<string, unknown>,
  adapters: Adapters,
  db: BookingDb,
  method = "GET",
): Promise<Record<string, unknown>> {
  if (action === "sales_booking_policy") return { ok: true, policy: POLICY, version: SALES_BOOKING_VERSION };
  if (action === "sales_booking_read") {
    return await readWorkspace(db, adapters, {
      resource: params.resource || String(body.resource || "nithin"),
      week_start: params.week_start || String(body.week_start || "2026-09-14"),
      drain: params.drain === "1" || body.drain === true,
    });
  }
  const writes = ["sales_booking_draft", "sales_booking_assess", "sales_booking_archive", "sales_booking_restore", "sales_booking_approve", "sales_booking_confirm", "sales_booking_on_event", "sales_booking_reconcile", "sales_booking_runner", "sales_booking_claim_slot"];
  if (writes.includes(action) && method !== "POST") throw new SalesBookingError(`${action} requires POST`, 405, "method_not_allowed");
  if (action === "sales_booking_draft") return persistDraft(db, body as { case_id: string; text?: string });
  if (action === "sales_booking_assess") {
    if (!adapters.assessCase) throw new SalesBookingError("assess worker required", 400, "no_assess_worker");
    const cases = await db.selectEq("sales_booking_cases", "id", body.case_id);
    const payload = await adapters.assessCase({ case: cases.data[0], input: body.input });
    return persistAssessment(db, { case_id: String(body.case_id), version: String(payload.version || SALES_BOOKING_VERSION), payload });
  }
  if (action === "sales_booking_on_event") return onEvent(db, adapters, body as { event_key: string; type: string; case_id?: string });
  if (action === "sales_booking_reconcile") return reconcile(db, body as { case_id?: string; expected_version?: string; reason?: string });
  if (action === "sales_booking_runner") return runnerTick(db, adapters, { runner_enabled: body.runner_enabled === true });
  if (action === "sales_booking_claim_slot") {
    return claimSlot(db, body as { claim_id: string; resource_id: string; start_iso: string; end_iso: string; case_id: string });
  }
  if (action === "sales_booking_approve" || action === "sales_booking_confirm") {
    return approveAction(db, adapters, {
      ...(body as { case_id: string; kind: string; text?: string; start_iso?: string; end_iso?: string; exact_acceptance?: boolean; execute?: boolean; fake?: boolean }),
      kind: action === "sales_booking_confirm" ? "confirm_booking" : String(body.kind || "approve_offer"),
    });
  }
  throw new SalesBookingError(`unknown action ${action}`, 404, "unknown_action");
}
