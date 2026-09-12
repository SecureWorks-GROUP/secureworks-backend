// Sales Booking workflow API. Isolated branch. Production deploy held.
// Consumes GHL/calendar/CIO adapters; does not ingest as a second memory system.

export const SALES_BOOKING_VERSION = "sales-booking-api/v1";

export const POLICY = {
  activation: "held",
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
  id: string;
  name: string;
  scoper_user_id: string;
  lane: string;
  sender_resolved: boolean;
  sender: string | null;
}> = {
  nithin: {
    id: "nithin",
    name: "Nithin",
    scoper_user_id: "5862cf1d-0a3b-4836-8fd1-d69f95aa2f73",
    lane: "patio",
    sender_resolved: true,
    sender: "+61489267774",
  },
  marnin: {
    id: "marnin",
    name: "Marnin",
    scoper_user_id: "706c5258-70dd-483a-b36c-af6864b24498",
    lane: "fencing",
    sender_resolved: false,
    sender: null,
  },
  khairo: {
    id: "khairo",
    name: "Khairo",
    scoper_user_id: "be6c2188-2b7b-49c7-b6e4-5b0d0deb6415",
    lane: "fencing",
    sender_resolved: true,
    sender: "+61489267772",
  },
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

export type Opportunity = {
  id: string;
  contact_id: string | null;
  name?: string;
  suburb?: string;
  tags?: string[];
  status?: string;
};

export type CalendarEvent = {
  event_id: string;
  subject?: string;
  start_iso: string;
  end_iso: string;
  suburb?: string;
};

export type ContextFact = {
  key: string;
  value?: string;
  current?: boolean;
};

export type Adapters = {
  listOpportunities: (pipelineId: string, cursor?: Record<string, unknown> | null) => Promise<{
    items: Opportunity[];
    next: Record<string, unknown> | null;
    complete: boolean;
    total?: number;
  }>;
  calendarEvents: (scoperUserId: string, since: string, until: string) => Promise<{
    ok: boolean;
    events: CalendarEvent[];
    coverage: Record<string, unknown>;
    mailbox?: string;
  }>;
  contextFacts?: (contactId: string) => Promise<ContextFact[]>;
  sendSms?: (payload: Record<string, unknown>, opts: { execute: boolean; fake: boolean }) => Promise<{
    held: boolean;
    sent: boolean;
    message_id?: string;
    provider?: string;
  }>;
  writeCalendar?: (payload: Record<string, unknown>, opts: { execute: boolean; fake: boolean }) => Promise<{
    held: boolean;
    written: boolean;
    event_id?: string;
  }>;
};

export type Store = {
  cases: Map<string, Record<string, unknown>>;
  drafts: Map<string, Record<string, unknown>>;
  offers: Map<string, Record<string, unknown>>;
  actions: Record<string, unknown>[];
  archives: Map<string, Record<string, unknown>>;
  assessments: Map<string, Record<string, unknown>>;
  cursors: Map<string, Record<string, unknown>>;
  seenEvents: Set<string>;
};

export function createStore(): Store {
  return {
    cases: new Map(),
    drafts: new Map(),
    offers: new Map(),
    actions: [],
    archives: new Map(),
    assessments: new Map(),
    cursors: new Map(),
    seenEvents: new Set(),
  };
}

function nowIso() {
  return new Date().toISOString();
}

function phoneLike(name: string | undefined) {
  return !!name && /^(\+61|0)\d/.test(name.replace(/\s/g, ""));
}

function upsertCase(store: Store, row: Record<string, unknown>) {
  const id = String(row.id);
  const prev = store.cases.get(id) || {};
  const next = { ...prev, ...row, updated_at: nowIso() };
  store.cases.set(id, next);
  return next;
}

export async function readWorkspace(
  store: Store,
  adapters: Adapters,
  params: { resource: string; week_start: string },
) {
  const resource = RESOURCES[params.resource];
  if (!resource) throw new SalesBookingError("Unknown resource", 400, "unknown_resource");
  const pipeline = PIPELINES[params.resource];
  const cursorKey = `opps:${params.resource}`;
  let cursor = (store.cursors.get(cursorKey) as { next?: Record<string, unknown> | null; complete?: boolean; total?: number }) || {
    next: null,
    complete: false,
  };
  let pages = 0;
  while (!cursor.complete && pages < 40) {
    const page = await adapters.listOpportunities(pipeline, cursor.next || null);
    for (const item of page.items) {
      const display = phoneLike(item.name) ? `${item.suburb || "Enquiry"}` : (item.name || "Enquiry");
      upsertCase(store, {
        id: item.id,
        resource_id: params.resource,
        opportunity_id: item.id,
        contact_id: item.contact_id,
        pipeline_id: pipeline,
        suburb: item.suburb || null,
        display_name: display,
        status: store.cases.get(item.id)?.status || "needs_decision",
        tags: item.tags || [],
      });
    }
    cursor = {
      next: page.next,
      complete: page.complete,
      total: page.total,
    };
    store.cursors.set(cursorKey, cursor);
    pages += 1;
    if (!page.next) break;
  }
  const since = `${params.week_start}T00:00:00+08:00`;
  const untilDate = new Date(`${params.week_start}T00:00:00+08:00`);
  untilDate.setUTCDate(untilDate.getUTCDate() + 5);
  const until = untilDate.toISOString();
  const cal = await adapters.calendarEvents(resource.scoper_user_id, since, until);
  for (const ev of cal.events || []) {
    upsertCase(store, {
      id: ev.event_id,
      resource_id: params.resource,
      event_id: ev.event_id,
      suburb: ev.suburb || null,
      display_name: ev.subject || "Diary",
      status: "booked",
      start_iso: ev.start_iso,
      end_iso: ev.end_iso,
    });
  }
  const cases = [...store.cases.values()].filter((c) => c.resource_id === params.resource);
  const enumerated = cases.filter((c) => c.opportunity_id).length;
  return {
    ok: true,
    fixture: false,
    send_hold: true,
    version: SALES_BOOKING_VERSION,
    policy: POLICY,
    resource: {
      ...resource,
      calendar: {
        ok: cal.ok,
        mailbox: cal.mailbox || null,
        leave: cal.coverage?.operational_leave || "not_read",
      },
    },
    week_start: params.week_start,
    coverage: {
      full_population: !!cursor.complete,
      enumerated,
      total: cursor.total ?? enumerated,
      calendar_view_complete: cal.ok,
      calendar_retrieved_at: cal.coverage?.retrieved_at || cal.retrieved_at || null,
      operational_leave: cal.coverage?.operational_leave || "not_read",
      leave_intervals: Array.isArray(cal.coverage?.leave_intervals) ? cal.coverage.leave_intervals : null,
      travel_minutes: typeof cal.coverage?.travel_minutes === "number" ? cal.coverage.travel_minutes : null,
      boolean_flags_are_not_capacity: true,
      gaps: [
        cursor.complete ? "Opportunity enumeration terminal for this resource." : (enumerated === 0 ? "Opportunity provider adapter returned no page. This is not an empty workload." : "Opportunity enumeration still paging."),
        "Leave and travel remain owned coverage, not free capacity.",
        "Client true/false coverage flags are not capacity proof.",
      ],
    },
    events: cal.events || [],
    cases: cases.map((c) => ({
      ...c,
      archived: store.archives.get(String(c.id)) || null,
      draft: store.drafts.get(String(c.id)) || null,
      assessment: store.assessments.get(String(c.id)) || null,
    })),
  };
}

function blockingCommitment(store: Store, caseId: string) {
  const c = store.cases.get(caseId);
  if (!c) return true;
  if (c.event_id) return true;
  if (c.exact_acceptance || c.accepted_offer_id) return true;
  for (const off of store.offers.values()) {
    if (off.case_id === caseId && (off.send_evidence === "sent" || off.send_evidence === "held")) return true;
  }
  return false;
}

export function persistDraft(store: Store, body: { case_id: string; text?: string; human_edited?: boolean; sender?: string | null }) {
  if (!body.case_id) throw new SalesBookingError("case_id required");
  const prev = store.drafts.get(body.case_id) || { case_id: body.case_id, revision: 0 };
  const next = {
    ...prev,
    text: body.text ?? prev.text,
    human_edited: body.human_edited ?? prev.human_edited ?? false,
    sender: body.sender ?? prev.sender ?? null,
    revision: Number(prev.revision || 0) + 1,
    updated_at: nowIso(),
  };
  store.drafts.set(body.case_id, next);
  return next;
}

export function persistAssessment(store: Store, body: { case_id: string; version: string; payload: Record<string, unknown> }) {
  if (!body.case_id || !body.payload) throw new SalesBookingError("assessment payload required");
  const rec = { case_id: body.case_id, version: body.version, payload: body.payload, at: nowIso() };
  store.assessments.set(body.case_id, rec);
  const c = store.cases.get(body.case_id);
  if (c) {
    upsertCase(store, {
      id: body.case_id,
      status: body.payload.status || c.status,
      exact_acceptance: !!body.payload.exact_acceptance,
      accepted_offer_id: (body.payload.accepted_offer as { offer_id?: string } | undefined)?.offer_id || null,
    });
  }
  return rec;
}

export function archiveCase(store: Store, body: { case_id: string; reason?: string; note?: string }) {
  if (!body.case_id) throw new SalesBookingError("case_id required");
  if (blockingCommitment(store, body.case_id)) {
    throw new SalesBookingError("Archive cannot hide a diary event or outstanding offer", 409, "commitment_visible");
  }
  if (!body.reason) throw new SalesBookingError("reason required");
  const c = store.cases.get(body.case_id);
  const rec = {
    case_id: body.case_id,
    reason: body.reason,
    note: body.note || "",
    restored: false,
    contact_id: c?.contact_id || null,
    at: nowIso(),
    crm_deleted: false,
  };
  store.archives.set(body.case_id, rec);
  return rec;
}

export function restoreCase(store: Store, caseId: string) {
  const rec = store.archives.get(caseId);
  if (!rec) throw new SalesBookingError("not archived", 404, "not_archived");
  const next = { ...rec, restored: true };
  store.archives.set(caseId, next);
  return { ok: true, crm_deleted: false, contact_id: rec.contact_id };
}

export async function approveAction(
  store: Store,
  adapters: Adapters,
  body: {
    case_id: string;
    kind: string;
    text?: string;
    start_iso?: string;
    exact_acceptance?: boolean;
    execute?: boolean;
    fake?: boolean;
  },
  hold = true,
) {
  const c = store.cases.get(body.case_id);
  if (!c) throw new SalesBookingError("unknown case", 404, "unknown_case");
  const resource = RESOURCES[String(c.resource_id)];
  if (resource && resource.sender_resolved === false) {
    return { ok: false, held: true, sent: false, booked: false, reason: "sender_unresolved" };
  }
  if (body.kind === "confirm_booking" && !body.exact_acceptance) {
    return { ok: false, held: true, sent: false, booked: false, reason: "no_exact_acceptance" };
  }
  const actionId = `act_${store.actions.length + 1}_${Date.now()}`;
  if (hold && !body.execute) {
    store.actions.push({
      action_id: actionId,
      case_id: body.case_id,
      kind: body.kind,
      status: "held",
      send_evidence: "held",
      created_at: nowIso(),
    });
    return { ok: false, held: true, sent: false, booked: false, waiting: false, reason: "send_hold", action_id: actionId };
  }
  if (!body.fake) {
    throw new SalesBookingError("Live provider writes are refused", 403, "live_write_refused");
  }
  if (body.kind === "approve_offer" || body.kind === "confirm_booking") {
    const sms = await adapters.sendSms?.({
      contact_id: c.contact_id,
      text: body.text,
      sender: resource?.sender,
    }, { execute: true, fake: true });
    const offerId = `off_${actionId}`;
    store.offers.set(offerId, {
      offer_id: offerId,
      case_id: body.case_id,
      slot_revision: 1,
      start_iso: body.start_iso,
      send_evidence: sms?.sent ? "sent" : "failed",
      sent_at: sms?.sent ? nowIso() : null,
    });
    store.actions.push({
      action_id: actionId,
      case_id: body.case_id,
      kind: body.kind,
      status: sms?.sent ? "sent" : "failed",
      send_evidence: sms?.sent ? "sent" : "failed",
      created_at: nowIso(),
    });
    if (body.kind === "confirm_booking" && body.exact_acceptance) {
      const cal = await adapters.writeCalendar?.({
        scoper_user_id: resource?.scoper_user_id,
        start_iso: body.start_iso,
      }, { execute: true, fake: true });
      if (cal?.written) upsertCase(store, { id: body.case_id, event_id: cal.event_id, status: "booked" });
      return { ok: true, held: false, sent: !!sms?.sent, booked: !!cal?.written, action_id: actionId, offer_id: offerId, fake: true };
    }
    if (sms?.sent) upsertCase(store, { id: body.case_id, status: "waiting", send_evidence: "sent" });
    return { ok: true, held: false, sent: !!sms?.sent, booked: false, waiting: !!sms?.sent, action_id: actionId, offer_id: offerId, fake: true };
  }
  throw new SalesBookingError("unknown action kind");
}

export function onEvent(store: Store, body: { event_key: string; type: string; case_id?: string }) {
  if (!body.event_key) throw new SalesBookingError("event_key required");
  if (store.seenEvents.has(body.event_key)) {
    return { ok: true, duplicate: true, assessed: false };
  }
  store.seenEvents.add(body.event_key);
  if (body.case_id && store.cases.has(body.case_id)) {
    const c = store.cases.get(body.case_id)!;
    if (c.status === "waiting" || c.status === "follow_up") {
      upsertCase(store, { id: body.case_id, status: "needs_decision" });
    }
  }
  return { ok: true, duplicate: false, assessed: true, type: body.type };
}

export function reconcile(store: Store, body: { case_id?: string; reason?: string }) {
  const ids = body.case_id ? [body.case_id] : [...new Set([...store.cases.keys(), ...store.assessments.keys()])];
  let invalidated = 0;
  for (const id of ids) {
    const assess = store.assessments.get(id);
    if (!assess) continue;
    store.assessments.set(id, { ...assess, invalidated: true, reason: body.reason || "reconcile", at: nowIso() });
    invalidated += 1;
  }
  return { ok: true, invalidated, activation: POLICY.activation };
}

export function runnerTick(store: Store) {
  if (POLICY.activation === "held") {
    return { ok: true, ran: false, reason: "runner_held", policy: POLICY };
  }
  return { ok: true, ran: false, reason: "not_activated" };
}

export async function dispatch(
  action: string,
  params: Record<string, string>,
  body: Record<string, unknown>,
  adapters: Adapters,
  store: Store,
  method = "GET",
): Promise<Record<string, unknown>> {
  if (action === "sales_booking_policy") return { ok: true, policy: POLICY, version: SALES_BOOKING_VERSION };
  if (action === "sales_booking_read") {
    return await readWorkspace(store, adapters, {
      resource: params.resource || String(body.resource || "nithin"),
      week_start: params.week_start || String(body.week_start || "2026-09-14"),
    });
  }
  const writes = [
    "sales_booking_draft",
    "sales_booking_assess",
    "sales_booking_archive",
    "sales_booking_restore",
    "sales_booking_approve",
    "sales_booking_confirm",
    "sales_booking_on_event",
    "sales_booking_reconcile",
    "sales_booking_runner",
  ];
  if (writes.includes(action) && method !== "POST") {
    throw new SalesBookingError(`${action} requires POST`, 405, "method_not_allowed");
  }
  if (action === "sales_booking_draft") return persistDraft(store, body as { case_id: string; text?: string });
  if (action === "sales_booking_assess") {
    return persistAssessment(store, body as { case_id: string; version: string; payload: Record<string, unknown> });
  }
  if (action === "sales_booking_archive") return archiveCase(store, body as { case_id: string; reason?: string });
  if (action === "sales_booking_restore") return restoreCase(store, String(body.case_id || params.case_id));
  if (action === "sales_booking_approve" || action === "sales_booking_confirm") {
    return await approveAction(store, adapters, {
      ...(body as {
        case_id: string;
        kind: string;
        text?: string;
        start_iso?: string;
        exact_acceptance?: boolean;
        execute?: boolean;
        fake?: boolean;
      }),
      kind: action === "sales_booking_confirm" ? "confirm_booking" : String(body.kind || "approve_offer"),
    });
  }
  if (action === "sales_booking_on_event") return onEvent(store, body as { event_key: string; type: string; case_id?: string });
  if (action === "sales_booking_reconcile") return reconcile(store, body as { case_id?: string; reason?: string });
  if (action === "sales_booking_runner") return runnerTick(store);
  throw new SalesBookingError(`unknown action ${action}`, 404, "unknown_action");
}
