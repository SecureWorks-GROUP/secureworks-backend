/** Booking texts go from the line of the person doing the visit.
 *
 * Owner ruling (2026-09-24): "I need my text to go from 776. Then if Nithin's
 * doing it, it needs to go from his number or Khairo's doing it, go from his
 * number." Each person's number is copied from their own scope-booking
 * profile in the wiki (`sms.from_number`), never guessed:
 * secureworks-wiki `harness/ops/skills/secureworks-scope-booking/profiles/`
 * `fencing-stratco-marnin.json`, `patio-nithin.json`, `fencing-khairo.json`
 * @c5640616. The fencing lane contract says the same ("one owner per number.
 * 772 is Khairo's alone. Stratco sends from Marnin's 776.",
 * `harness/ops/skills/secureworks-sales-weekly/lanes/fencing.json`).
 * Change a line here and in that profile together.
 *
 * This is the ONE table of booking people: app user, GHL user and line. The
 * booking read's resources, the screen defaults, both approval routes and the
 * executor all derive from it; do not restate a line or id elsewhere.
 *
 * Whose lead is it (owner decision 2026-09-24, "khairo is all normal fencing
 * all stratco fencing is mine"): the opportunity's current GHL assignee always
 * wins. When nobody is assigned, a patio lead is Nithin's and a fencing lead
 * goes by `salesBookingLeadKind`: any Stratco signal is Marnin's, a positive
 * normal-lead signal is Khairo's, and neither is owner unclear (shown on
 * Marnin's list, flagged, never approved or texted until it is assigned in
 * GHL). A possible Stratco lead never reaches Khairo's line. Anyone else's
 * lead belongs to nobody here. GHL user ids: Marnin's matches the Stratco
 * calendar assignee, Khairo's the user on his 772 replies, Nithin's is from
 * that decision.
 *
 * The person on an approval is its `scoper_user_id`. Its `resource` and
 * `profile`, when they name a known person, must name the same one. There is
 * no fallback line: an unknown or missing person refuses with a named reason.
 * This module imports nothing so the read, owner-approval and executor
 * modules can all use it without an import cycle.
 */

export interface SalesBookingSenderPerson {
  person: string;
  name: string;
  /** Application user UUID (`users.id` / `scoper_preferences`). */
  scoper_user_id: string;
  /** Wiki scope-booking profile that owns this line. */
  profile: string;
  /** E.164 GHL number this person's booking texts go from. */
  line: string;
  /** GHL user id: an opportunity assigned to it is this person's lead. */
  ghl_user_id: string;
}

export interface SalesBookingOpportunityOwnership {
  assignedTo: string | null;
  pipelineId: string;
  /** `salesBookingLeadKind` of the same opportunity read. Decides only an
   * unassigned fencing lead: Stratco Marnin, normal Khairo, unclear held. */
  kind: SalesBookingLeadKind;
  /** The contact or STRATCO FENCING calendar read an unassigned fencing
   * lead's `kind` needs failed, so it is held `unclear`. */
  kindUnread?: boolean;
}

/** What an unassigned fencing lead is: see `salesBookingLeadKind`. */
export type SalesBookingLeadKind = "stratco" | "normal" | "unclear";

/** Plain label the screen shows on an owner-unclear lead. */
export const SALES_BOOKING_OWNER_UNCLEAR_LABEL =
  "Owner unclear, Stratco or normal?";

export const SALES_BOOKING_SENDER_LINES: Readonly<
  Record<string, Readonly<SalesBookingSenderPerson>>
> = Object.freeze({
  nithin: Object.freeze({
    person: "nithin",
    name: "Nithin Silas",
    scoper_user_id: "5862cf1d-0a3b-4836-8fd1-d69f95aa2f73",
    profile: "patio-nithin",
    line: "+61489267774",
    ghl_user_id: "ERAycY7r6KZ8OA66WQCy",
  }),
  marnin: Object.freeze({
    person: "marnin",
    name: "Marnin Stobbe",
    scoper_user_id: "706c5258-70dd-483a-b36c-af6864b24498",
    profile: "fencing-stratco-marnin",
    line: "+61489267776",
    ghl_user_id: "3S20LGVTjsVYy9vTJ9wM",
  }),
  khairo: Object.freeze({
    person: "khairo",
    name: "Khairo Pomare",
    scoper_user_id: "be6c2188-2b7b-49c7-b6e4-5b0d0deb6415",
    profile: "fencing-khairo",
    line: "+61489267772",
    ghl_user_id: "RgDWTnYL6zL3eJA6nLht",
  }),
});

export type SalesBookingSenderResolution =
  | { ok: true; sender: Readonly<SalesBookingSenderPerson> }
  | {
    ok: false;
    /** `booking_scoper_unassigned` | `booking_scoper_line_unknown` |
     * `booking_scoper_ambiguous` */
    reason: string;
    detail: Record<string, unknown>;
  };

const text = (v: unknown) => typeof v === "string" ? v.trim() : "";

/** The line for the person doing the visit on one approval snapshot. */
export function salesBookingSenderFor(snapshot: {
  scoper_user_id?: unknown;
  resource?: unknown;
  profile?: unknown;
}): SalesBookingSenderResolution {
  const userId = text(snapshot.scoper_user_id);
  if (!userId) {
    return {
      ok: false,
      reason: "booking_scoper_unassigned",
      detail: { resource: text(snapshot.resource) || null },
    };
  }
  const people = Object.values(SALES_BOOKING_SENDER_LINES);
  const sender = people.find((p) => p.scoper_user_id === userId);
  if (!sender) {
    return {
      ok: false,
      reason: "booking_scoper_line_unknown",
      detail: { scoper_user_id: userId },
    };
  }
  // A resource or profile naming a different known person means the snapshot
  // does not agree on who is doing the visit; never pick one of them.
  const resource = text(snapshot.resource);
  const profile = text(snapshot.profile);
  const byResource = Object.hasOwn(SALES_BOOKING_SENDER_LINES, resource)
    ? SALES_BOOKING_SENDER_LINES[resource]
    : null;
  const byProfile = people.find((p) => p.profile === profile) ?? null;
  if (
    (byResource && byResource !== sender) ||
    (byProfile && byProfile !== sender)
  ) {
    return {
      ok: false,
      reason: "booking_scoper_ambiguous",
      detail: {
        scoper_user_id: userId,
        resource: resource || null,
        profile: profile || null,
      },
    };
  }
  return { ok: true, sender };
}

/**
 * Whose lead an opportunity is: the booking person its GHL assignee names, or
 * `unassignedOwner` (the pipeline's default person) when nobody is assigned.
 * An assignee who is not a booking person, or an unreadable value, is nobody.
 */
export function salesBookingLeadOwner(
  assignedTo: unknown,
  unassignedOwner: string | null,
): string | null {
  if (assignedTo === null || assignedTo === "") {
    return unassignedOwner;
  }
  if (typeof assignedTo !== "string") return null;
  return Object.values(SALES_BOOKING_SENDER_LINES).find((p) =>
    p.ghl_user_id === assignedTo
  )?.person ?? null;
}

/** The STRATCO FENCING GHL calendar (wiki GO-LIVE.md; owner approval's
 * `STRATCO_BOOKING_RULEBOOK.calendar` reads it from here). */
export const SALES_BOOKING_STRATCO_CALENDAR_ID = "dEQKVKHthsjSYaen1fiE";

/** Env naming the GHL custom field that carries the Stratco allocation ref. */
export const SALES_BOOKING_STRATCO_ALLOCATION_FIELD_ENV =
  "GHL_STRATCO_ALLOCATION_FIELD_ID";

const STRATCO = /stratco/i;
/** Sources that name a normal (non-Stratco) enquiry: the website form,
 * Google, Facebook, a referral, or a phone-in on Khairo's own 772 line. */
const NORMAL_SOURCE =
  /\b(website|web ?form|web enquiry|google|facebook|referral|phone[- ]?in)\b|(\+?61|0)489 ?267 ?772/i;
/** Tags GHL puts on a normal enquiry. */
const NORMAL_TAGS = new Set([
  "web - enquiry",
  "answered-call",
  "source:organic",
]);

const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? v as Record<string, unknown>
    : {};

function customFieldSet(fields: unknown, fieldId: string): boolean {
  if (!Array.isArray(fields)) return false;
  return fields.some((raw) => {
    const field = record(raw);
    if (field.id !== fieldId) return false;
    return [
      field.value,
      field.fieldValue,
      field.fieldValueString,
      field.field_value,
    ].some((value) =>
      (typeof value === "string" && value.trim() !== "") ||
      (typeof value === "number" && Number.isFinite(value)) ||
      (Array.isArray(value) && value.length > 0)
    );
  });
}

function stratcoAllocationFieldId(): string {
  try {
    return (Deno.env.get(SALES_BOOKING_STRATCO_ALLOCATION_FIELD_ENV) || "")
      .trim();
  } catch {
    return "";
  }
}

/**
 * What a GHL fencing opportunity is, for an unassigned lead:
 *  - `stratco`: a `stratco` tag (contact or opportunity), Stratco in the
 *    opportunity name, contact name or source (wiki `fencing-stratco-marnin.json`
 *    `match.require_any`), a non-empty Stratco allocation-ref custom field on
 *    the opportunity or contact (field id from env
 *    `GHL_STRATCO_ALLOCATION_FIELD_ID`, when set), or `stratcoCalendarBooked`:
 *    the contact has an appointment on the STRATCO FENCING calendar.
 *  - `normal`: none of those, and a known non-Stratco source or tag.
 *  - `unclear`: neither. Held for someone to assign it in GHL.
 * Any Stratco signal wins over a normal one. `contact` is the lead's own GHL
 * contact read (GET /contacts/{id}); its tags, custom fields, name and source
 * count like the opportunity's contact's, which search rows omit.
 */
export function salesBookingLeadKind(
  opportunity: unknown,
  signals: { stratcoCalendarBooked?: boolean; contact?: unknown } = {},
): SalesBookingLeadKind {
  const opp = record(opportunity);
  const contacts = [record(opp.contact), record(signals.contact)];
  const tags = [
    ...contacts.flatMap((contact) =>
      Array.isArray(contact.tags) ? contact.tags : []
    ),
    ...(Array.isArray(opp.tags) ? opp.tags : []),
  ].filter((tag): tag is string => typeof tag === "string");
  const sources = [opp.source, ...contacts.map((contact) => contact.source)]
    .filter((v): v is string => typeof v === "string");
  const fieldId = stratcoAllocationFieldId();
  if (
    signals.stratcoCalendarBooked === true ||
    [
      ...tags,
      opp.name,
      ...contacts.map((contact) => contact.name),
      ...sources,
    ].some((value) => typeof value === "string" && STRATCO.test(value)) ||
    (fieldId !== "" &&
      [opp, ...contacts].some((holder) =>
        customFieldSet(holder.customFields, fieldId)
      ))
  ) return "stratco";
  if (
    sources.some((source) => NORMAL_SOURCE.test(source)) ||
    tags.some((tag) => NORMAL_TAGS.has(tag.trim().toLowerCase()))
  ) return "normal";
  return "unclear";
}

/** The short line label the screen shows (`776`). */
export function salesBookingLineLabel(person: string): string {
  return SALES_BOOKING_SENDER_LINES[person].line.slice(-3);
}
