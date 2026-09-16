// ════════════════════════════════════════════════════════════
// SALES BOOKING READ — one bounded, honest read for the Sales Booking view
// ════════════════════════════════════════════════════════════
//
// `ops-api?action=sales_booking_read` serves the secureworks-ux Sales Booking
// view (`opsFetch('sales_booking_read', {resource, week_start, scoper_user_id})`).
// It replaces the branch-local preview server `scripts/sales-booking-local-api.mjs`
// with the same response shape, plus the two facts the browser must not derive
// itself: the scoper's Outlook `diary[]` for the week, and per-case
// `thread_facts` so the queue can paint waiting-for-reply / offer-out without
// reading every GHL thread client-side.
//
// ── READ ONLY ──
// This module performs NO writes of any kind: no Supabase mutation, no GHL
// write, no calendar create, no send. Every dependency it takes is a reader.
// There is deliberately no draft store (the reference shape's `drafts` is
// always `{}`) because that would be a new table, which is out of scope.
//
// ── HONESTY CONTRACT (wiki skill `secureworks-scope-booking`) ──
//  1. Full population, or an explicit `coverage.full_population:false` naming
//     the gap. A bounded scan that did not reach the end is never an empty book.
//  2. Never invent a GHL or calendar fact. A sub-read that failed is reported
//     `read_ok:false` with a reason, on the row, and the row still appears.
//  3. Auto-ack and missed-call templates are NOT human replies
//     (`SALES_BOOKING_TEMPLATE_MARKERS`).
//  4. Unread leave is not free capacity: `coverage.operational_leave` stays
//     `not_read` because only the scoper's PRIMARY Outlook calendar is read.
//
// A failure in any sub-read degrades that item, never the whole response. The
// action throws only on an invalid request (unknown resource / malformed week).
//
// ── SENDS AND CALENDAR WRITES ARE HELD ──
// `send_hold: true` and `policy.{activation,send,calendar_write} = 'held'` are
// constants here. This action has no capability to send or to write a calendar;
// the flags exist so the view can render the hold, not as the enforcement.

import { getGraphToken, graphFetch } from '../_shared/graph_client.ts'

export const SALES_BOOKING_API_VERSION = 'sales-booking-api/v1'

/** Perth is UTC+8 year round (no daylight saving), so a fixed offset is exact. */
export const PERTH_UTC_OFFSET = '+08:00'
export const PERTH_TIMEZONE = 'Australia/Perth'

/** Skill default: a human outbound less than this old with no reply since is
 * `waiting_reply`. Do not double-message inside it. */
export const SALES_BOOKING_QUIET_HOURS = 20

/**
 * Bodies that are automation, not a person. An outbound matching one of these
 * never becomes `last_human_outbound_at`, never starts the quiet window, and
 * never counts as "we already answered". Compared against a lower-cased,
 * whitespace-collapsed body, so casing and line wrapping do not defeat them.
 */
export const SALES_BOOKING_TEMPLATE_MARKERS: readonly string[] = [
  'thanks for reaching out to secureworks',
  'sorry we missed your call',
]

/**
 * Captain defaults for v1 (2026-09-16). Published on every response so the
 * view renders what the server actually assumed and the Captain can flip them
 * without reading code. Flipping a default is a change here, not a UI change.
 */
export const SALES_BOOKING_CAPTAIN_DEFAULTS = {
  scopers: ['nithin', 'marnin'] as const,
  scopes_done_window: 'this_week_plus_last',
  sender_lines: { nithin: '774', marnin: '776' },
  stamp_board: 'agent_driven_human_typed_later',
  recorded: '2026-09-16',
} as const

export interface SalesBookingResource {
  resource_id: string
  lane: 'patio' | 'fencing'
  /** GHL sales pipeline. Fencing and patio pipelines are never mixed. */
  pipeline_id: string
  /** Application user UUID in `scoper_preferences`, not a Microsoft directory id. */
  scoper_user_id: string
  /** Outbound SMS line for this resource. Captain default; see PR "Captain can flip tomorrow". */
  sender_line: string
  sender_line_source: string
}

/**
 * v1 roster. `nithin` is the patio pipeline on line 774; `marnin` is the
 * fencing (Stratco) profile on line 776.
 *
 * The 776 value is the CAPTAIN'S RECORDED DEFAULT, not a guess: the UI doc
 * marks Marnin's line unresolved between 772 and 776 and forbids the browser
 * from choosing. The server states the decision and names where it came from.
 * Pipeline ids match `PRODUCTION_PIPELINES` in ghl-proxy; scoper ids match the
 * `secureworks-scope-booking` skill profiles.
 */
export const SALES_BOOKING_RESOURCES: Readonly<Record<string, SalesBookingResource>> = {
  nithin: {
    resource_id: 'nithin',
    lane: 'patio',
    pipeline_id: 'OGZLpPPVWVarN94HL6af',
    scoper_user_id: '5862cf1d-0a3b-4836-8fd1-d69f95aa2f73',
    sender_line: '774',
    sender_line_source: 'patio_profile_source_backed',
  },
  marnin: {
    resource_id: 'marnin',
    lane: 'fencing',
    pipeline_id: 'I9t8njpuR0Dm7B2NDcvI',
    scoper_user_id: '706c5258-70dd-483a-b36c-af6864b24498',
    sender_line: '776',
    sender_line_source: 'captain_default_2026-09-16',
  },
}

// ── Bounds ───────────────────────────────────────────────────
// Every scan here is bounded. A bound that was HIT is reported as a gap, never
// swallowed: an unfinished scan must not read as a finished small board.
export const SALES_BOOKING_MAX_OPPORTUNITY_PAGES = 20
export const SALES_BOOKING_OPPORTUNITY_PAGE_SIZE = 100
export const SALES_BOOKING_DEFAULT_THREAD_LIMIT = 80
export const SALES_BOOKING_MAX_THREAD_LIMIT = 250
export const SALES_BOOKING_THREAD_CONCURRENCY = 6
export const SALES_BOOKING_DEFAULT_THREAD_BUDGET_MS = 18_000

// ════════════════════════════════════════════════════════════
// Week window (pure)
// ════════════════════════════════════════════════════════════

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * The Monday of the Perth week containing `now`. ISO weekday 1..7 with Monday
 * first, computed on the Perth wall clock rather than the isolate's own zone.
 */
export function defaultPerthWeekStart(now: Date): string {
  // Shift into Perth wall time, then read the UTC parts of the shifted instant.
  const perth = new Date(now.getTime() + 8 * 3_600_000)
  const isoWeekday = perth.getUTCDay() === 0 ? 7 : perth.getUTCDay()
  const monday = new Date(perth.getTime() - (isoWeekday - 1) * 86_400_000)
  return monday.toISOString().slice(0, 10)
}

export interface SalesBookingWeekWindow {
  week_start: string
  /** Inclusive lower bound, Monday 00:00 Perth. */
  since: string
  /** Exclusive upper bound, the following Monday 00:00 Perth. */
  until_exclusive: string
  timezone: string
}

/**
 * Monday-to-Sunday Perth window for `week_start`. Throws on a malformed date or
 * a date that is not a Monday — a week grid anchored on the wrong day would
 * silently mis-place every diary block.
 */
export function perthWeekWindow(weekStart: string): SalesBookingWeekWindow {
  if (!ISO_DATE.test(weekStart)) {
    throw new Error(`week_start must be an ISO date (YYYY-MM-DD); got ${JSON.stringify(weekStart)}`)
  }
  const startMs = Date.parse(`${weekStart}T00:00:00${PERTH_UTC_OFFSET}`)
  if (!Number.isFinite(startMs)) {
    throw new Error(`week_start is not a real date: ${weekStart}`)
  }
  // Round-trip guard: Date.parse accepts 2026-02-31 and rolls it forward.
  const perthDay = new Date(startMs + 8 * 3_600_000)
  if (perthDay.toISOString().slice(0, 10) !== weekStart) {
    throw new Error(`week_start is not a real date: ${weekStart}`)
  }
  if (perthDay.getUTCDay() !== 1) {
    throw new Error(`week_start must be a Monday (Australia/Perth); ${weekStart} is not`)
  }
  const endMs = startMs + 7 * 86_400_000
  return {
    week_start: weekStart,
    since: `${weekStart}T00:00:00${PERTH_UTC_OFFSET}`,
    until_exclusive: `${new Date(endMs + 8 * 3_600_000).toISOString().slice(0, 10)}T00:00:00${PERTH_UTC_OFFSET}`,
    timezone: PERTH_TIMEZONE,
  }
}

// ════════════════════════════════════════════════════════════
// Thread facts (pure)
// ════════════════════════════════════════════════════════════

export type SalesBookingClassification =
  | 'ready_to_contact'
  | 'waiting_reply'
  | 'follow_up_due'
  | 'needs_decision'
  | 'unread'

export interface SalesBookingMessage {
  id?: string
  type?: string
  direction?: string
  body?: string
  timestamp?: string
  userId?: string
}

export interface SalesBookingThreadFacts {
  case_id: string
  contact_id: string | null
  read_ok: boolean
  reason: string | null
  last_inbound_at: string | null
  last_human_outbound_at: string | null
  /** Any outbound, template rows included. Never a substitute for the human one. */
  last_outbound_at: string | null
  quiet_window: boolean
  quiet_hours: number
  classification: SalesBookingClassification
  message_count: number
  template_outbound_count: number
}

function normaliseBody(body: unknown): string {
  return String(body ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
}

/** True when an outbound body is an auto-ack / missed-call template, not a person. */
export function isSalesBookingTemplateBody(body: unknown): boolean {
  const text = normaliseBody(body)
  if (!text) return false
  return SALES_BOOKING_TEMPLATE_MARKERS.some((marker) => text.includes(marker))
}

function messageTimestamp(message: SalesBookingMessage): number | null {
  const raw = message.timestamp
  if (raw === undefined || raw === null || raw === '') return null
  const ms = typeof raw === 'number' ? raw : Date.parse(String(raw))
  return Number.isFinite(ms) ? ms : null
}

function messageDirection(message: SalesBookingMessage): 'inbound' | 'outbound' {
  const declared = String(message.direction || '').toLowerCase()
  if (declared === 'inbound' || declared === 'outbound') return declared
  // Mirrors ghl-proxy get_conversation: a row carrying a userId was sent by us.
  return message.userId ? 'outbound' : 'inbound'
}

/**
 * A GHL activity/workflow row is neither a customer word nor a human reply.
 * Calls DO count as inbound contact (their words are never inferred).
 */
function messageCountsAsContact(message: SalesBookingMessage): boolean {
  const type = String(message.type || '').toUpperCase()
  return !type.includes('ACTIVITY') && !type.includes('WORKFLOW')
}

/**
 * Derive thread facts from an already-read message list.
 *
 * Pure: no clock of its own, no network. `nowMs` decides only the quiet window.
 * Classification never emits `booked` — a booking is a calendar/commitment fact
 * this function cannot see, and guessing one from chat text would invent it.
 */
export function deriveSalesBookingThreadFacts(args: {
  caseId: string
  contactId: string | null
  messages: SalesBookingMessage[]
  nowMs: number
  quietHours?: number
}): SalesBookingThreadFacts {
  const quietHours = args.quietHours ?? SALES_BOOKING_QUIET_HOURS
  let lastInbound: number | null = null
  let lastHumanOutbound: number | null = null
  let lastOutbound: number | null = null
  let templateOutbound = 0
  let counted = 0

  for (const message of args.messages) {
    if (!messageCountsAsContact(message)) continue
    const at = messageTimestamp(message)
    if (at === null) continue
    counted++
    if (messageDirection(message) === 'inbound') {
      if (lastInbound === null || at > lastInbound) lastInbound = at
      continue
    }
    if (lastOutbound === null || at > lastOutbound) lastOutbound = at
    if (isSalesBookingTemplateBody(message.body)) {
      templateOutbound++
      continue
    }
    if (lastHumanOutbound === null || at > lastHumanOutbound) lastHumanOutbound = at
  }

  const inboundIsLatest = lastInbound !== null &&
    (lastHumanOutbound === null || lastInbound > lastHumanOutbound)
  const quietWindow = lastHumanOutbound !== null && !inboundIsLatest &&
    args.nowMs - lastHumanOutbound < quietHours * 3_600_000

  let classification: SalesBookingClassification
  if (inboundIsLatest) classification = 'needs_decision'
  else if (lastHumanOutbound !== null) classification = quietWindow ? 'waiting_reply' : 'follow_up_due'
  else classification = 'ready_to_contact'

  const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString())
  return {
    case_id: args.caseId,
    contact_id: args.contactId,
    read_ok: true,
    reason: null,
    last_inbound_at: iso(lastInbound),
    last_human_outbound_at: iso(lastHumanOutbound),
    last_outbound_at: iso(lastOutbound),
    quiet_window: quietWindow,
    quiet_hours: quietHours,
    classification,
    message_count: counted,
    template_outbound_count: templateOutbound,
  }
}

/** An unread thread. The row still exists; it simply claims nothing. */
export function unreadSalesBookingThreadFacts(
  caseId: string,
  contactId: string | null,
  reason: string,
): SalesBookingThreadFacts {
  return {
    case_id: caseId,
    contact_id: contactId,
    read_ok: false,
    reason,
    last_inbound_at: null,
    last_human_outbound_at: null,
    last_outbound_at: null,
    quiet_window: false,
    quiet_hours: SALES_BOOKING_QUIET_HOURS,
    classification: 'unread',
    message_count: 0,
    template_outbound_count: 0,
  }
}

// ════════════════════════════════════════════════════════════
// Cases (pure)
// ════════════════════════════════════════════════════════════

export interface SalesBookingCase {
  id: string
  resource_id: string
  opportunity_id: string
  contact_id: string | null
  suburb: string | null
  display_name: string
  status: string
  tags: string[]
  /** Additive: GHL stage name when the pipeline stage map resolved it. */
  stage_name: string | null
  /** Additive: newest GHL activity timestamp, used to order the thread budget. */
  last_activity_at: string | null
  /** Which fact produced `status`. `unread` means nothing was proved. */
  status_source: 'thread_facts' | 'unread'
}

/** A contact whose "name" is really a phone number is an unnamed enquiry. */
export function isPhoneLikeName(name: unknown): boolean {
  const text = String(name ?? '').replace(/\s/g, '')
  return /^(\+61|0)\d/.test(text)
}

/**
 * Project one raw GHL opportunity onto a case row. Never invents a suburb: an
 * absent contact city stays null so nothing downstream places a window on a
 * guessed locality.
 */
export function projectSalesBookingCase(
  opportunity: Record<string, unknown>,
  resourceId: string,
  stages: Record<string, string> = {},
): SalesBookingCase | null {
  const id = typeof opportunity.id === 'string' ? opportunity.id : ''
  if (!id) return null
  const contact = (opportunity.contact && typeof opportunity.contact === 'object'
    ? opportunity.contact
    : {}) as Record<string, unknown>
  const rawName = (typeof contact.name === 'string' && contact.name) ||
    (typeof opportunity.name === 'string' && opportunity.name) || ''
  const suburb = typeof contact.city === 'string' && contact.city.trim() ? contact.city.trim() : null
  const stageId = typeof opportunity.pipelineStageId === 'string' ? opportunity.pipelineStageId : ''
  const updatedAt = [
    opportunity.updatedAt,
    opportunity.dateUpdated,
    opportunity.lastStatusChangeAt,
    opportunity.createdAt,
  ].find((value) => typeof value === 'string' && value)
  return {
    id,
    resource_id: resourceId,
    opportunity_id: id,
    contact_id: (typeof contact.id === 'string' && contact.id) ||
      (typeof opportunity.contactId === 'string' && opportunity.contactId) || null,
    suburb,
    display_name: isPhoneLikeName(rawName) ? 'Enquiry' : (rawName || 'Enquiry'),
    status: 'needs_decision',
    tags: Array.isArray(contact.tags) ? contact.tags.map((t) => String(t)) : [],
    stage_name: (stageId && stages[stageId]) || null,
    last_activity_at: typeof updatedAt === 'string' ? updatedAt : null,
    status_source: 'unread',
  }
}

// ════════════════════════════════════════════════════════════
// Diary (pure)
// ════════════════════════════════════════════════════════════

export type SalesBookingDiaryKind = 'busy' | 'leave' | 'personal'

export interface SalesBookingDiaryEntry {
  event_id: string
  start: string
  end: string
  title: string | null
  kind: SalesBookingDiaryKind
  source: string
  /** Raw Graph `showAs`, so a consumer can re-derive `kind` without trusting it. */
  show_as: string | null
  /** False for a `free` block: on the diary, but not occupancy. */
  blocks_capacity: boolean
  is_all_day: boolean
  location: string | null
  /** True when the subject was withheld because the event is marked private. */
  title_withheld: boolean
}

const DIARY_SOURCE = 'outlook_primary'

/**
 * Graph renders `start.dateTime` in the timezone asked for via the `Prefer`
 * header and returns it WITHOUT an offset. Perth has no daylight saving, so
 * appending +08:00 to a Perth-rendered value is exact rather than approximate.
 */
export function perthGraphInstant(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null
  const trimmed = value.replace(/\.\d+$/, '')
  if (/(?:Z|[+-]\d{2}:\d{2})$/.test(trimmed)) {
    return Number.isFinite(Date.parse(trimmed)) ? trimmed : null
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(trimmed)) return null
  const withOffset = `${trimmed}${PERTH_UTC_OFFSET}`
  return Number.isFinite(Date.parse(withOffset)) ? withOffset : null
}

/**
 * Project one Graph calendarView event onto a diary entry.
 *
 * `kind` is read off provider fields only, never off subject text: `showAs:oof`
 * is leave, a private/confidential/personal sensitivity is personal, everything
 * else is busy. Keyword-sniffing a subject for "leave" would invent a fact the
 * calendar did not state. Returns null for a malformed event; the caller counts
 * the drop rather than hiding it.
 */
export function projectSalesBookingDiaryEntry(
  event: Record<string, unknown>,
): SalesBookingDiaryEntry | null {
  const id = typeof event.id === 'string' ? event.id : ''
  const start = perthGraphInstant((event.start as Record<string, unknown> | undefined)?.dateTime)
  const end = perthGraphInstant((event.end as Record<string, unknown> | undefined)?.dateTime)
  if (!id || !start || !end) return null

  const showAs = typeof event.showAs === 'string' ? event.showAs : null
  const sensitivity = String(event.sensitivity || '').toLowerCase()
  const isPrivate = sensitivity === 'private' || sensitivity === 'personal' ||
    sensitivity === 'confidential'
  const kind: SalesBookingDiaryKind = showAs === 'oof'
    ? 'leave'
    : isPrivate
    ? 'personal'
    : 'busy'
  const subject = typeof event.subject === 'string' && event.subject ? event.subject : null
  const location = (event.location as Record<string, unknown> | undefined)?.displayName
  return {
    event_id: id,
    start,
    end,
    // A private calendar entry's subject is not ops information. The block is.
    title: isPrivate ? null : subject,
    kind,
    source: DIARY_SOURCE,
    show_as: showAs,
    blocks_capacity: showAs !== 'free',
    is_all_day: event.isAllDay === true,
    location: isPrivate || typeof location !== 'string' || !location ? null : location,
    title_withheld: isPrivate && subject !== null,
  }
}

// ════════════════════════════════════════════════════════════
// Assembly (pure)
// ════════════════════════════════════════════════════════════

export interface SalesBookingOpportunityScan {
  opportunities: Record<string, unknown>[]
  stages: Record<string, string>
  /** True only when the scan reached the real end of the result set. */
  exhausted: boolean
  pages_scanned: number
  total: number | null
  /** Non-null when the roster read failed or stopped short. */
  reason: string | null
}

export interface SalesBookingDiaryScan {
  read_ok: boolean
  reason: string | null
  entries: SalesBookingDiaryEntry[]
  malformed_dropped: number
  calendar_email: string | null
  scoper_user_id: string | null
}

export interface SalesBookingThreadScan {
  facts: Record<string, SalesBookingThreadFacts>
  attempted: number
  read_ok_count: number
  /** Cases that were never attempted because a bound was hit. */
  not_attempted: number
  budget_exhausted: boolean
  enabled: boolean
}

export interface SalesBookingReadResponse {
  ok: true
  fixture: false
  send_hold: true
  version: string
  week_start: string
  week: SalesBookingWeekWindow
  resource: SalesBookingResource
  coverage: {
    full_population: boolean
    enumerated: number
    total: number | null
    operational_leave: 'not_read'
    gaps: string[]
    pages_scanned: number
    threads_read: number
    threads_attempted: number
    diary_read_ok: boolean
  }
  cases: SalesBookingCase[]
  diary: SalesBookingDiaryEntry[]
  diary_read: { read_ok: boolean; reason: string | null; source: string; calendar_email: string | null }
  thread_facts: Record<string, SalesBookingThreadFacts>
  drafts: Record<string, never>
  defaults: typeof SALES_BOOKING_CAPTAIN_DEFAULTS
  policy: { activation: 'held'; send: 'held'; calendar_write: 'held' }
}

/**
 * Compose the response from three already-run scans. Pure, so the whole shape
 * and every coverage sentence is unit-testable without a network.
 */
export function assembleSalesBookingRead(input: {
  resource: SalesBookingResource
  week: SalesBookingWeekWindow
  /** Already de-duplicated and projected. */
  projectedCases: SalesBookingCase[]
  opportunities: SalesBookingOpportunityScan
  diary: SalesBookingDiaryScan
  threads: SalesBookingThreadScan
}): SalesBookingReadResponse {
  const { resource, week, opportunities, diary, threads } = input
  const cases = input.projectedCases

  const gaps: string[] = []
  gaps.push(
    opportunities.exhausted
      ? 'Opportunity enumeration terminal for this resource.'
      : 'Opportunity enumeration did not reach the end of the result set; this is not a completed empty book.',
  )
  if (opportunities.reason) {
    gaps.push(`Opportunity roster read degraded: ${opportunities.reason}`)
  }
  gaps.push(
    diary.read_ok
      ? 'Primary Outlook calendar read for this week. Operational leave, travel and non-primary calendars remain unread. Missing coverage is not free capacity.'
      : `Scoper calendar unread (${diary.reason || 'unknown'}). Missing coverage is not free capacity.`,
  )
  if (diary.malformed_dropped > 0) {
    gaps.push(`${diary.malformed_dropped} calendar event(s) were dropped as malformed and are not represented in the diary.`)
  }
  if (!threads.enabled) {
    gaps.push('Thread facts were not requested; no case carries a proved conversation state.')
  } else {
    const unread = threads.attempted - threads.read_ok_count
    if (threads.not_attempted > 0) {
      gaps.push(
        `${threads.not_attempted} case(s) had no thread read${threads.budget_exhausted ? ' (time budget exhausted)' : ' (row budget reached)'}; their status is unproved, not clear.`,
      )
    }
    if (unread > 0) {
      gaps.push(`${unread} thread read(s) failed; those cases stay on the board as unread.`)
    }
  }

  return {
    ok: true,
    fixture: false,
    send_hold: true,
    version: SALES_BOOKING_API_VERSION,
    week_start: week.week_start,
    week,
    resource: { ...resource },
    coverage: {
      // Full population means the roster was terminal. Thread and calendar gaps
      // are named separately: they narrow what is KNOWN about a case, not
      // whether the book is complete.
      full_population: opportunities.exhausted && !opportunities.reason,
      enumerated: cases.length,
      total: opportunities.total,
      operational_leave: 'not_read',
      gaps,
      pages_scanned: opportunities.pages_scanned,
      threads_read: threads.read_ok_count,
      threads_attempted: threads.attempted,
      diary_read_ok: diary.read_ok,
    },
    cases,
    diary: diary.entries,
    diary_read: {
      read_ok: diary.read_ok,
      reason: diary.reason,
      source: DIARY_SOURCE,
      calendar_email: diary.calendar_email,
    },
    thread_facts: threads.facts,
    // No draft store exists server-side (a new table is out of scope for v1).
    drafts: {},
    defaults: SALES_BOOKING_CAPTAIN_DEFAULTS,
    policy: { activation: 'held', send: 'held', calendar_write: 'held' },
  }
}

// ════════════════════════════════════════════════════════════
// Runner + dependencies
// ════════════════════════════════════════════════════════════

export interface SalesBookingReadParams {
  resource?: string | null
  week_start?: string | null
  scoper_user_id?: string | null
  include_thread_facts?: boolean
  thread_limit?: number
  thread_budget_ms?: number
  case_ids?: string[] | null
}

export interface SalesBookingReadDependencies {
  /** Bounded, terminal-or-honest GHL opportunity roster for one pipeline. */
  readOpportunities(args: { pipelineId: string }): Promise<SalesBookingOpportunityScan>
  /** One scoper's primary Outlook events for the week. Never throws. */
  readDiary(args: {
    scoperUserId: string
    since: string
    untilExclusive: string
  }): Promise<SalesBookingDiaryScan>
  /** One contact's GHL conversation messages. Rejects on a failed read. */
  readThread(args: { contactId: string }): Promise<SalesBookingMessage[]>
  now(): Date
}

export class SalesBookingRequestError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
    this.name = 'SalesBookingRequestError'
  }
}

export function resolveSalesBookingResource(resource: unknown): SalesBookingResource {
  const key = String(resource ?? 'nithin').trim().toLowerCase()
  const found = SALES_BOOKING_RESOURCES[key]
  if (!found) {
    throw new SalesBookingRequestError(
      `Unknown resource ${JSON.stringify(resource)}. Use: ${Object.keys(SALES_BOOKING_RESOURCES).join(', ')}`,
    )
  }
  return found
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(Math.max(Math.trunc(parsed), min), max)
}

/**
 * Read threads for the selected cases under BOTH a row cap and a wall-clock
 * budget, at bounded concurrency. Cases beyond either bound are reported as
 * not attempted rather than silently omitted, so the view can tell "no reply
 * needed" from "nobody looked".
 */
async function scanThreads(
  deps: SalesBookingReadDependencies,
  cases: SalesBookingCase[],
  params: SalesBookingReadParams,
): Promise<SalesBookingThreadScan> {
  const enabled = params.include_thread_facts !== false
  const facts: Record<string, SalesBookingThreadFacts> = {}
  if (!enabled || cases.length === 0) {
    return { facts, attempted: 0, read_ok_count: 0, not_attempted: enabled ? cases.length : 0, budget_exhausted: false, enabled }
  }

  const limit = clampInt(params.thread_limit, SALES_BOOKING_DEFAULT_THREAD_LIMIT, 0, SALES_BOOKING_MAX_THREAD_LIMIT)
  const budgetMs = clampInt(params.thread_budget_ms, SALES_BOOKING_DEFAULT_THREAD_BUDGET_MS, 1_000, 60_000)
  const wanted = params.case_ids && params.case_ids.length
    ? new Set(params.case_ids.map((id) => String(id)))
    : null

  // Newest activity first: the budget should be spent on the live end of the board.
  const ordered = cases
    .filter((row) => (wanted ? wanted.has(row.id) : true))
    .slice()
    .sort((a, b) => Date.parse(b.last_activity_at || '') - Date.parse(a.last_activity_at || '') || a.id.localeCompare(b.id))
  const selected = ordered.slice(0, limit)

  const startedAt = deps.now().getTime()
  let budgetExhausted = false
  let cursor = 0
  const worker = async () => {
    for (;;) {
      const index = cursor++
      if (index >= selected.length) return
      if (deps.now().getTime() - startedAt >= budgetMs) {
        budgetExhausted = true
        return
      }
      const row = selected[index]
      if (!row.contact_id) {
        facts[row.id] = unreadSalesBookingThreadFacts(row.id, null, 'no_ghl_contact_on_opportunity')
        continue
      }
      try {
        const messages = await deps.readThread({ contactId: row.contact_id })
        facts[row.id] = deriveSalesBookingThreadFacts({
          caseId: row.id,
          contactId: row.contact_id,
          messages,
          nowMs: deps.now().getTime(),
        })
      } catch (error) {
        facts[row.id] = unreadSalesBookingThreadFacts(
          row.id,
          row.contact_id,
          `ghl_thread_unread: ${(error as Error)?.message || 'unknown'}`,
        )
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(SALES_BOOKING_THREAD_CONCURRENCY, selected.length) }, () => worker()),
  )

  const attempted = Object.keys(facts).length
  const readOk = Object.values(facts).filter((f) => f.read_ok).length
  return {
    facts,
    attempted,
    read_ok_count: readOk,
    not_attempted: Math.max(0, (wanted ? ordered.length : cases.length) - attempted),
    budget_exhausted: budgetExhausted,
    enabled,
  }
}

/**
 * Run one sales booking read.
 *
 * Throws only for an invalid request (unknown resource, malformed week_start).
 * Every DATA failure degrades its own item and is named in `coverage.gaps`.
 */
export async function salesBookingRead(
  deps: SalesBookingReadDependencies,
  params: SalesBookingReadParams,
): Promise<SalesBookingReadResponse> {
  const resource = resolveSalesBookingResource(params.resource)
  const weekStart = params.week_start && String(params.week_start).trim()
    ? String(params.week_start).trim()
    : defaultPerthWeekStart(deps.now())
  let week: SalesBookingWeekWindow
  try {
    week = perthWeekWindow(weekStart)
  } catch (error) {
    throw new SalesBookingRequestError((error as Error).message)
  }

  const scoperUserId = params.scoper_user_id && String(params.scoper_user_id).trim()
    ? String(params.scoper_user_id).trim()
    : resource.scoper_user_id

  const [opportunities, diary] = await Promise.all([
    deps.readOpportunities({ pipelineId: resource.pipeline_id }),
    deps.readDiary({ scoperUserId, since: week.since, untilExclusive: week.until_exclusive }),
  ])

  const projected: SalesBookingCase[] = []
  const seen = new Set<string>()
  for (const raw of opportunities.opportunities) {
    const row = projectSalesBookingCase(raw, resource.resource_id, opportunities.stages)
    if (!row || seen.has(row.id)) continue
    seen.add(row.id)
    projected.push(row)
  }

  const threads = await scanThreads(deps, projected, params)
  return assembleSalesBookingRead({
    resource,
    week,
    projectedCases: projected,
    opportunities,
    diary,
    threads,
  })
}

// ── Production wiring ────────────────────────────────────────

const GHL_BASE = 'https://services.leadconnectorhq.com'

async function ghlRead(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const token = Deno.env.get('GHL_API_TOKEN') || ''
  if (!token) throw new Error('GHL API token not configured')
  const res = await fetch(`${GHL_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Version: '2021-07-28',
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`GHL ${res.status}: ${text.slice(0, 300)}`)
  return JSON.parse(text)
}

/**
 * Page `/opportunities/search` to a terminal page for one pipeline, exactly as
 * ghl-proxy's `fetchOpportunityPages` does: a SHORT page or an empty page is
 * the only positive proof the result set ended, and a stalled cursor stops the
 * scan with `exhausted:false` so a caller fails closed on an absence.
 */
async function readOpportunitiesLive(pipelineId: string): Promise<SalesBookingOpportunityScan> {
  const locationId = Deno.env.get('GHL_LOCATION_ID') || ''
  const limit = SALES_BOOKING_OPPORTUNITY_PAGE_SIZE
  const opportunities: Record<string, unknown>[] = []
  const seen = new Set<string>()
  let startAfter: string | number | null = null
  let startAfterId: string | null = null
  let pages = 0
  let total: number | null = null
  let exhausted = false
  let reason: string | null = null

  try {
    for (let page = 1; page <= SALES_BOOKING_MAX_OPPORTUNITY_PAGES; page++) {
      const query = new URLSearchParams({ locationId, limit: String(limit), pipelineId, status: 'open' })
      if (startAfter != null) query.set('startAfter', String(startAfter))
      if (startAfterId) query.set('startAfterId', startAfterId)
      const data = await ghlRead(`/opportunities/search?${query.toString()}`, { headers: { Version: 'v3' } })
      const rows = Array.isArray(data.opportunities) ? data.opportunities as Record<string, unknown>[] : []
      const meta = (data.meta && typeof data.meta === 'object' ? data.meta : {}) as Record<string, unknown>
      pages++
      if (typeof meta.total === 'number') total = meta.total
      if (rows.length === 0) { exhausted = true; break }
      let fresh = 0
      for (const row of rows) {
        const id = typeof row.id === 'string' ? row.id : ''
        if (id && seen.has(id)) continue
        if (id) seen.add(id)
        opportunities.push(row)
        fresh++
      }
      if (rows.length < limit) { exhausted = true; break }
      const last = rows[rows.length - 1] as Record<string, unknown>
      const sort = Array.isArray(last?.sort) ? last.sort : []
      const nextAfter = meta.startAfter ?? sort[0] ?? null
      const nextAfterId = meta.startAfterId ?? sort[1] ?? last?.contactId ?? null
      if (fresh === 0 || nextAfter == null || nextAfterId == null) break
      startAfter = nextAfter as string | number
      startAfterId = String(nextAfterId)
    }
    if (!exhausted && pages >= SALES_BOOKING_MAX_OPPORTUNITY_PAGES) {
      reason = `page cap ${SALES_BOOKING_MAX_OPPORTUNITY_PAGES} reached`
    }
  } catch (error) {
    reason = (error as Error)?.message || 'opportunity search failed'
  }

  let stages: Record<string, string> = {}
  try {
    const data = await ghlRead(`/opportunities/pipelines?locationId=${encodeURIComponent(locationId)}`)
    const pipelines = Array.isArray(data.pipelines) ? data.pipelines as Record<string, unknown>[] : []
    for (const pipeline of pipelines) {
      if (pipeline.id !== pipelineId) continue
      const list = Array.isArray(pipeline.stages) ? pipeline.stages as Record<string, unknown>[] : []
      stages = Object.fromEntries(
        list.filter((s) => typeof s.id === 'string').map((s) => [String(s.id), String(s.name ?? '')]),
      )
    }
  } catch {
    // Stage names are presentation only; an unread stage map leaves stage_name
    // null rather than degrading the roster.
    stages = {}
  }

  return { opportunities, stages, exhausted, pages_scanned: pages, total, reason }
}

/**
 * One contact's conversation messages, same two-step and same shape tolerance
 * as ghl-proxy `get_conversation`: conversation search, then messages. A read
 * failure REJECTS so the caller records `read_ok:false` rather than an empty
 * (and therefore falsely quiet) thread.
 */
async function readThreadLive(contactId: string): Promise<SalesBookingMessage[]> {
  const locationId = Deno.env.get('GHL_LOCATION_ID') || ''
  const search = await ghlRead(
    `/conversations/search?contactId=${encodeURIComponent(contactId)}&locationId=${encodeURIComponent(locationId)}`,
  )
  const conversations = Array.isArray(search.conversations) ? search.conversations as Record<string, unknown>[] : []
  if (conversations.length === 0) return []
  const conversationId = String(conversations[0].id || '')
  if (!conversationId) return []
  const result = await ghlRead(
    `/conversations/${encodeURIComponent(conversationId)}/messages?limit=30&type=TYPE_SMS,TYPE_EMAIL,TYPE_CALL&sort=desc&sortBy=dateAdded`,
  )
  const nested = result.messages && typeof result.messages === 'object'
    ? (result.messages as Record<string, unknown>).messages
    : null
  const raw = Array.isArray(result.messages)
    ? result.messages
    : Array.isArray(nested)
    ? nested
    : Array.isArray(result.data)
    ? result.data
    : []
  return (raw as Record<string, unknown>[]).map((m) => ({
    id: typeof m.id === 'string' ? m.id : undefined,
    type: String(m.messageType || m.type || 'SMS').toUpperCase(),
    direction: typeof m.direction === 'string' ? m.direction : undefined,
    body: String(m.body || m.message || m.text || ''),
    timestamp: String(m.dateAdded || m.createdAt || m.timestamp || ''),
    userId: typeof m.userId === 'string' ? m.userId : undefined,
  }))
}

/**
 * The scoper's PRIMARY Outlook calendar for the window.
 *
 * `scoper_preferences.work_calendar_email` is LIVE DRIFT: the column is
 * populated in production and read by the jarvis `sw_scoper_calendar_events`
 * tool, but the only repo file defining it sits under
 * `supabase/migrations/_drafts/`. PostgREST answers a missing column with a 400
 * and `data:null`, which would read as "this scoper has no calendar", so the
 * error is checked and surfaced as `read_ok:false` with its reason. Never
 * throws: an unread calendar degrades the diary, not the response.
 */
async function readDiaryLive(
  client: { from: (table: string) => any },
  scoperUserId: string,
  since: string,
  untilExclusive: string,
): Promise<SalesBookingDiaryScan> {
  const fail = (reason: string, email: string | null = null): SalesBookingDiaryScan => ({
    read_ok: false,
    reason,
    entries: [],
    malformed_dropped: 0,
    calendar_email: email,
    scoper_user_id: scoperUserId,
  })

  let email: string | null = null
  try {
    const { data, error } = await client
      .from('scoper_preferences')
      .select('user_id,work_calendar_email')
      .eq('user_id', scoperUserId)
      .maybeSingle()
    if (error) return fail(`scoper_preferences_unreadable: ${error.message || error.code || 'unknown'}`)
    email = (data && typeof data.work_calendar_email === 'string' && data.work_calendar_email) || null
    if (!email) return fail('scoper_has_no_work_calendar_email')
  } catch (error) {
    return fail(`scoper_preferences_unreadable: ${(error as Error)?.message || 'unknown'}`)
  }

  const entries: SalesBookingDiaryEntry[] = []
  let dropped = 0
  try {
    let token = await getGraphToken()
    const url = new URL(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(email)}/calendarView`,
    )
    url.searchParams.set('startDateTime', since)
    url.searchParams.set('endDateTime', untilExclusive)
    url.searchParams.set('$select', 'id,subject,start,end,location,isAllDay,showAs,sensitivity')
    url.searchParams.set('$top', '100')

    let next: string | null = url.toString()
    const seenPages = new Set<string>()
    for (let page = 0; page < 10 && next; page++) {
      if (seenPages.has(next)) return fail('calendar_pagination_stalled', email)
      seenPages.add(next)
      const res: Response = await graphFetch(next, token, {
        init: {
          method: 'GET',
          redirect: 'error',
          signal: AbortSignal.timeout(20_000),
          headers: { Prefer: `outlook.timezone="${PERTH_TIMEZONE}"` },
        },
        refresh: async () => {
          token = await getGraphToken({ forceRefresh: true })
          return token
        },
      })
      if (!res.ok) {
        return fail(`calendar_http_${res.status}`, email)
      }
      const data = await res.json().catch(() => null)
      if (!data || !Array.isArray(data.value)) return fail('calendar_page_malformed', email)
      for (const item of data.value) {
        const entry = item && typeof item === 'object'
          ? projectSalesBookingDiaryEntry(item as Record<string, unknown>)
          : null
        if (entry) entries.push(entry)
        else dropped++
      }
      const link = data['@odata.nextLink']
      next = typeof link === 'string' && link.startsWith('https://graph.microsoft.com/') ? link : null
    }
  } catch (error) {
    return fail(`calendar_read_failed: ${(error as Error)?.message || 'unknown'}`, email)
  }

  entries.sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.event_id.localeCompare(b.event_id))
  return {
    read_ok: true,
    reason: null,
    entries,
    malformed_dropped: dropped,
    calendar_email: email,
    scoper_user_id: scoperUserId,
  }
}

/** Real readers for the dispatch. Every one is read-only. */
export function createSalesBookingReadDependencies(
  client: { from: (table: string) => any },
): SalesBookingReadDependencies {
  return {
    readOpportunities: ({ pipelineId }) => readOpportunitiesLive(pipelineId),
    readDiary: ({ scoperUserId, since, untilExclusive }) =>
      readDiaryLive(client, scoperUserId, since, untilExclusive),
    readThread: ({ contactId }) => readThreadLive(contactId),
    now: () => new Date(),
  }
}

/** Dispatch entry point: parse the request, run the read, return the payload. */
export async function salesBookingReadAction(
  client: { from: (table: string) => any },
  params: SalesBookingReadParams,
): Promise<SalesBookingReadResponse> {
  return await salesBookingRead(createSalesBookingReadDependencies(client), params)
}
