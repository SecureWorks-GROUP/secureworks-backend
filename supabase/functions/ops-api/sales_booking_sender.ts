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
 * The person is the approval snapshot's `scoper_user_id`. Its `resource` and
 * `profile`, when they name a known person, must name the same one. There is
 * no fallback line: an unknown or missing person refuses with a named reason.
 * This module imports nothing so the owner-approval and executor modules can
 * both use it without an import cycle.
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
}

export const SALES_BOOKING_SENDER_LINES: Readonly<
  Record<string, Readonly<SalesBookingSenderPerson>>
> = Object.freeze({
  marnin: Object.freeze({
    person: "marnin",
    name: "Marnin Stobbe",
    scoper_user_id: "706c5258-70dd-483a-b36c-af6864b24498",
    profile: "fencing-stratco-marnin",
    line: "+61489267776",
  }),
  nithin: Object.freeze({
    person: "nithin",
    name: "Nithin Silas",
    scoper_user_id: "5862cf1d-0a3b-4836-8fd1-d69f95aa2f73",
    profile: "patio-nithin",
    line: "+61489267774",
  }),
  khairo: Object.freeze({
    person: "khairo",
    name: "Khairo Pomare",
    scoper_user_id: "be6c2188-2b7b-49c7-b6e4-5b0d0deb6415",
    profile: "fencing-khairo",
    line: "+61489267772",
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
