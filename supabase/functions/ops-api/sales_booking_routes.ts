/** Booking routes: who books which lead, into which GHL calendar.
 *
 * Owner ask (2 Oct 2026): who gets which leads, which calendar, and simple
 * filters (lead source such as Stratco, patios vs fencing) are his to change
 * without code. The routes live in `public.sales_booking_routes`, one row per
 * rule, and every change goes through the audited write
 * (`sales_booking_route_write`, migration 20261002090000). This module is the
 * ONE place a route is chosen; the booking read, both approval paths and both
 * presses all ask `resolveSalesBookingRoute`.
 *
 * A rule matches on any of: the lead's trade (from its GHL pipeline), its
 * source (`stratco` = any Stratco signal, `normal` = a positive non-Stratco
 * signal, `salesBookingLeadKind`), one GHL tag, one GHL pipeline id. Every
 * condition a rule sets must hold; an empty condition matches anything. The
 * result is the booking person and the GHL calendar the visit goes into.
 * Enabled rules are read in `position` order and the first match wins.
 *
 * Whose lead: the GHL assignee always wins. For an assigned lead only rules
 * naming that person are read, so the calendar is that person's own: the
 * first of their rules that fully matches, else (GHL already chose the
 * person) the first of their rules for that trade and pipeline, source and
 * tag aside. An unassigned lead goes to the first matching rule's person.
 * No match means
 * the lead is shown (on the list of the person who holds that trade's
 * unrouted leads) but nothing can be approved or booked, with a plain
 * reason. A rule whose condition needs a fact that could not be read stops
 * the search there: a later, broader rule never catches a lead an earlier
 * rule might have claimed.
 *
 * Seed (owner 28 Sep 2026): Stratco fencing Marnin into STRATCO FENCING,
 * other fencing Khairo into Fencing Scope, patio Nithin into his scope
 * calendar. Imports only sales_booking_sender.ts, so every booking module can
 * use it without an import cycle.
 */
import {
  SALES_BOOKING_SENDER_LINES,
  SALES_BOOKING_STRATCO_CALENDAR_ID,
  type SalesBookingLeadKind,
} from "./sales_booking_sender.ts";

export type SalesBookingTrade = "fencing" | "patio";
export type SalesBookingRouteLeadSource = "stratco" | "normal";

export interface SalesBookingRoute {
  /** Stable slug. */
  id: string;
  /** Read order, lowest first. */
  position: number;
  enabled: boolean;
  label: string | null;
  match_trade: SalesBookingTrade | null;
  match_lead_source: SalesBookingRouteLeadSource | null;
  /** One GHL tag on the contact or opportunity, case-insensitive. */
  match_tag: string | null;
  match_pipeline_id: string | null;
  /** Booking person (`SALES_BOOKING_SENDER_LINES` key). */
  person: string;
  /** GHL calendar the visit is booked into. */
  calendar_id: string;
  calendar_name: string | null;
  updated_at?: string | null;
  updated_by_email?: string | null;
}

export const SALES_BOOKING_FENCING_PIPELINE_ID = "I9t8njpuR0Dm7B2NDcvI";
export const SALES_BOOKING_PATIO_PIPELINE_ID = "OGZLpPPVWVarN94HL6af";

/** Trade of each sales pipeline (ghl-proxy `PRODUCTION_PIPELINES`). */
export const SALES_BOOKING_PIPELINE_TRADES: Readonly<
  Record<string, SalesBookingTrade>
> = Object.freeze({
  [SALES_BOOKING_FENCING_PIPELINE_ID]: "fencing",
  [SALES_BOOKING_PATIO_PIPELINE_ID]: "patio",
});

/** Owner 28 Sep 2026. The migration seeds exactly these rows. */
export const SALES_BOOKING_SEED_ROUTES: readonly Readonly<SalesBookingRoute>[] =
  Object.freeze([
    Object.freeze({
      id: "stratco-fencing-marnin",
      position: 10,
      enabled: true,
      label: "Stratco fencing leads: Marnin",
      match_trade: "fencing" as const,
      match_lead_source: "stratco" as const,
      match_tag: null,
      match_pipeline_id: null,
      person: "marnin",
      calendar_id: SALES_BOOKING_STRATCO_CALENDAR_ID,
      calendar_name: "STRATCO FENCING",
    }),
    Object.freeze({
      id: "normal-fencing-khairo",
      position: 20,
      enabled: true,
      label: "Other fencing leads: Khairo",
      match_trade: "fencing" as const,
      match_lead_source: "normal" as const,
      match_tag: null,
      match_pipeline_id: null,
      person: "khairo",
      calendar_id: "i6j9vaCy6c94n3i93cir",
      calendar_name: "Fencing Scope",
    }),
    Object.freeze({
      id: "patio-nithin",
      position: 30,
      enabled: true,
      label: "Patio leads: Nithin",
      match_trade: "patio" as const,
      match_lead_source: null,
      match_tag: null,
      match_pipeline_id: null,
      person: "nithin",
      calendar_id: "RSQnT8cQdEE8azb5Chlq",
      calendar_name: "Nithin's scope calendar",
    }),
  ]);

/** What a route decision knows about one lead. */
export interface SalesBookingRouteLead {
  pipelineId: string;
  /** GHL assignee id; null or "" when unassigned. */
  assignedTo: string | null;
  kind: SalesBookingLeadKind;
  /** The lead's source could not be read (held `unclear`). */
  kindUnread?: boolean;
  /** GHL tags on the contact and opportunity; null when not read. */
  tags?: readonly string[] | null;
}

export type SalesBookingRouteDecision =
  | { ok: true; route: SalesBookingRoute }
  | {
    ok: false;
    reason:
      | "booking_route_missing"
      | "booking_route_lead_source_unread"
      | "booking_route_tags_unread"
      | "booking_route_assignee_not_booking_person";
    /** Plain words for the screen. */
    message: string;
    /** The rule whose condition could not be checked, when one stopped it. */
    route_id?: string;
  };

export const SALES_BOOKING_ROUTE_MESSAGES = Object.freeze({
  booking_route_missing:
    "No booking rule matches this lead, so it cannot be booked. Assign it in GHL or add a rule.",
  booking_route_lead_source_unread:
    "Could not read whether this lead is Stratco, so it cannot be booked yet. Try again shortly.",
  booking_route_tags_unread:
    "Could not read this lead's GHL tags, so it cannot be booked yet. Try again shortly.",
  booking_route_assignee_not_booking_person:
    "This lead is assigned in GHL to someone who does not book visits here.",
  booking_routes_unreadable:
    "The booking rules could not be read, so nothing can be booked right now.",
});

const tagKey = (v: string) => v.trim().toLowerCase();

/** Enabled routes in read order (position, then id). */
export function orderedSalesBookingRoutes(
  routes: readonly SalesBookingRoute[],
): SalesBookingRoute[] {
  return routes.filter((r) => r.enabled === true).sort((a, b) =>
    a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

function assignedPerson(assignedTo: string | null): string | null | false {
  if (assignedTo === null || assignedTo === "") return null;
  return Object.values(SALES_BOOKING_SENDER_LINES).find((p) =>
    p.ghl_user_id === assignedTo
  )?.person ?? false;
}

/** The route for one lead: the first enabled rule that matches. */
export function resolveSalesBookingRoute(
  routes: readonly SalesBookingRoute[],
  lead: SalesBookingRouteLead,
): SalesBookingRouteDecision {
  const assignee = assignedPerson(lead.assignedTo);
  if (assignee === false) {
    return {
      ok: false,
      reason: "booking_route_assignee_not_booking_person",
      message:
        SALES_BOOKING_ROUTE_MESSAGES.booking_route_assignee_not_booking_person,
    };
  }
  const trade = SALES_BOOKING_PIPELINE_TRADES[lead.pipelineId] ?? null;
  const tags = lead.tags ? new Set(lead.tags.map(tagKey)) : null;
  const ordered = orderedSalesBookingRoutes(routes).filter((route) =>
    (!assignee || route.person === assignee) &&
    (!route.match_pipeline_id || route.match_pipeline_id === lead.pipelineId) &&
    (!route.match_trade || route.match_trade === trade)
  );
  for (const route of ordered) {
    if (route.match_lead_source) {
      if (lead.kindUnread) {
        return {
          ok: false,
          reason: "booking_route_lead_source_unread",
          message:
            SALES_BOOKING_ROUTE_MESSAGES.booking_route_lead_source_unread,
          route_id: route.id,
        };
      }
      if (route.match_lead_source !== lead.kind) continue;
    }
    if (route.match_tag) {
      if (!tags) {
        return {
          ok: false,
          reason: "booking_route_tags_unread",
          message: SALES_BOOKING_ROUTE_MESSAGES.booking_route_tags_unread,
          route_id: route.id,
        };
      }
      if (!tags.has(tagKey(route.match_tag))) continue;
    }
    return { ok: true, route: { ...route } };
  }
  // GHL already chose the person: their first rule for this trade.
  if (assignee && ordered.length) return { ok: true, route: { ...ordered[0] } };
  return {
    ok: false,
    reason: "booking_route_missing",
    message: SALES_BOOKING_ROUTE_MESSAGES.booking_route_missing,
  };
}

/** Rules that could apply to a lead in this pipeline. */
function routesForPipeline(
  routes: readonly SalesBookingRoute[],
  pipelineId: string,
): SalesBookingRoute[] {
  const trade = SALES_BOOKING_PIPELINE_TRADES[pipelineId] ?? null;
  return orderedSalesBookingRoutes(routes).filter((r) =>
    (!r.match_pipeline_id || r.match_pipeline_id === pipelineId) &&
    (!r.match_trade || r.match_trade === trade)
  );
}

/** Whether a lead in this pipeline needs its source read to be routed. */
export function salesBookingRoutesNeedLeadSource(
  routes: readonly SalesBookingRoute[],
  pipelineId: string,
): boolean {
  return routesForPipeline(routes, pipelineId).some((r) =>
    r.match_lead_source !== null
  );
}

/** Whether a lead in this pipeline needs its GHL tags read to be routed. */
export function salesBookingRoutesNeedTags(
  routes: readonly SalesBookingRoute[],
  pipelineId: string,
): boolean {
  return routesForPipeline(routes, pipelineId).some((r) =>
    r.match_tag !== null
  );
}

// ── Validation of an owner edit ───────────────────────────────────────────

export const SALES_BOOKING_ROUTE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ID_RE = SALES_BOOKING_ROUTE_ID_RE;
/** GHL ids are 20-character alphanumerics; allow a little slack. */
const GHL_ID_RE = /^[A-Za-z0-9]{6,64}$/;

export type SalesBookingRouteInputResult =
  | { ok: true; route: SalesBookingRoute }
  | { ok: false; reason: string; field: string };

const text = (v: unknown) => typeof v === "string" ? v.trim() : "";
const optionalText = (v: unknown): string | null | undefined =>
  v === null || v === undefined || v === ""
    ? null
    : typeof v === "string"
    ? v.trim() || null
    : undefined;

/** A whole route row from an owner edit, checked field by field. */
export function validateSalesBookingRouteInput(
  id: unknown,
  raw: unknown,
): SalesBookingRouteInputResult {
  const bad = (field: string, reason = "route_field_invalid") => ({
    ok: false as const,
    reason,
    field,
  });
  if (typeof id !== "string" || !ID_RE.test(id)) return bad("id");
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return bad("route", "route_required");
  }
  const r = raw as Record<string, unknown>;
  const position = r.position;
  if (
    typeof position !== "number" || !Number.isInteger(position) ||
    position < 1 || position > 10000
  ) return bad("position");
  if (typeof r.enabled !== "boolean") return bad("enabled");
  const label = optionalText(r.label);
  if (label === undefined || (label && label.length > 200)) return bad("label");
  const trade = optionalText(r.match_trade);
  if (trade === undefined || (trade && !["fencing", "patio"].includes(trade))) {
    return bad("match_trade");
  }
  const source = optionalText(r.match_lead_source);
  if (
    source === undefined ||
    (source && !["stratco", "normal"].includes(source))
  ) return bad("match_lead_source");
  const tag = optionalText(r.match_tag);
  if (tag === undefined || (tag && tag.length > 100)) return bad("match_tag");
  const pipeline = optionalText(r.match_pipeline_id);
  if (pipeline === undefined || (pipeline && !GHL_ID_RE.test(pipeline))) {
    return bad("match_pipeline_id");
  }
  const person = text(r.person);
  if (!Object.hasOwn(SALES_BOOKING_SENDER_LINES, person)) {
    return bad("person", "route_person_unknown");
  }
  const calendar = text(r.calendar_id);
  if (!GHL_ID_RE.test(calendar)) return bad("calendar_id");
  const calendarName = optionalText(r.calendar_name);
  if (
    calendarName === undefined || (calendarName && calendarName.length > 200)
  ) {
    return bad("calendar_name");
  }
  return {
    ok: true,
    route: {
      id,
      position,
      enabled: r.enabled,
      label,
      match_trade: trade as SalesBookingTrade | null,
      match_lead_source: source as SalesBookingRouteLeadSource | null,
      match_tag: tag,
      match_pipeline_id: pipeline,
      person,
      calendar_id: calendar,
      calendar_name: calendarName,
    },
  };
}

/** A stored row as the code reads it; null when the row is malformed. */
export function salesBookingRouteFromRow(
  row: unknown,
): SalesBookingRoute | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const checked = validateSalesBookingRouteInput(r.id, r);
  if (!checked.ok) return null;
  return {
    ...checked.route,
    updated_at: typeof r.updated_at === "string" ? r.updated_at : null,
    updated_by_email: typeof r.updated_by_email === "string"
      ? r.updated_by_email
      : null,
  };
}

export const SALES_BOOKING_ROUTE_COLUMNS =
  "id,position,enabled,label,match_trade,match_lead_source,match_tag," +
  "match_pipeline_id,person,calendar_id,calendar_name,updated_at," +
  "updated_by_email";

// deno-lint-ignore no-explicit-any
type RouteClient = { from(table: string): any };

/** Every stored route, or throws: a malformed row or a failed read is never
 * read as "no rules". */
export async function loadSalesBookingRoutes(
  client: RouteClient,
): Promise<SalesBookingRoute[]> {
  const { data, error } = await client.from("sales_booking_routes")
    .select(SALES_BOOKING_ROUTE_COLUMNS).order("position", { ascending: true })
    .order("id", { ascending: true });
  if (error || !Array.isArray(data)) {
    throw new Error("booking_routes_unreadable");
  }
  const routes = data.map(salesBookingRouteFromRow);
  if (routes.some((r: SalesBookingRoute | null) => r === null)) {
    throw new Error("booking_routes_malformed");
  }
  return routes as SalesBookingRoute[];
}
