# Booking screen: live availability (`live-availability-v1`, 24 Sep 2026)

Code: `supabase/functions/ops-api/sales_booking_availability.ts` (reads and
composition), `sales_booking_travel.ts` (travel estimate, pure). Tests:
`sales_booking_availability_test.ts`. Wired in `index.ts` into
`sales_booking_read` and into the workspace read every approval press uses.

## Why the banner said "not connected"

`emptyBookingFlow()` in `sales_booking_confirmation.ts` sets
`calendar_read: {state:"could_not_read", reason:"person_wide_calendars_and_prior_offer_ledger_not_connected"}`
and `commitments: null`. Only an engine pack published from a Mac terminal
(`sales_booking_pack_publish` with `booking_read_models`) ever replaced it,
and that engine is not run. It was never a GHL, Entra or Outlook permission
problem: nothing on the server read availability for the screen.

## What the read now does

After the pack overlay, for the person on screen:

1. GHL directory (`/calendars/` and `/users/`). The person's GHL user must be
   exactly one roster entry by recorded email and equal the recorded id
   (Marnin `3S20LGVTjsVYy9vTJ9wM`, Nithin `ERAycY7r6KZ8OA66WQCy`, Khairo
   `RgDWTnYL6zL3eJA6nLht`). Their calendars are every active calendar that
   lists that user. STRATCO FENCING is round robin, so only rows assigned to
   the person count.
2. GHL events for the week: the user-id window plus each confirmed-active
   calendar assigned to that person, with both calendar and user filters.
   Other assignees and cancelled rows never block.
3. GHL blocked-off time for the user (`/calendars/blocked-slots`).
4. Outlook events the read already fetched for the diary (Marnin only) are
   also busy. No new Outlook read. A failed Outlook read is a caveat, not a
   block: GHL is the source, and the press still re-checks Outlook. An Outlook
   event is counted as mirrored only when its `mirror_of_ghl_event_id` matches
   a GHL event id; time overlap or blocked time is not mirror proof. If the
   diary read dropped malformed events, a named caveat is returned and free
   times are withheld.
5. Open offers: the same census the owner press uses
   (`systemOfferCensus`, `sales_booking_executions` claimed in the last 21
   days joined to their approvals, plus live owner approvals). Offers remain holds until the census drops them; an unrelated GHL
   appointment for the same contact does not remove a separate visit commitment. Hand-sent texts are not
   machine-checked and say so.

`booking_flow` then carries:

| Field | Meaning |
|---|---|
| `calendar_read` | `state: read / could_not_read / not_configured`, `provider:"ghl"`, `source:"server_live_read"`, `reason`, `person`, `ghl_user_id`, `calendars`, `occupied_intervals`, `ghl_events`, `ghl_blocked_slots`, `outlook:{state,events,unverified_correspondence}`, `caveats` |
| `commitments` | Open offers `{id, contact_id, state:offered/agreed, start_iso, end_iso, source}`; `null` when the census could not be read (unknown, never an empty ledger) |
| `commitments_read` | `read` or `could_not_read` with the reason |
| `free_times` | The rule, and per bookable day: `state` (`open`, `full`, `past`, `no_time_left`, `travel_unknown`), `booked`, `busy[]`, `arrival_windows[]` for a lead of unknown location; null when the Outlook diary dropped malformed events or the required offer census is unreadable |

Each case carries `free_times` (null when the Outlook diary dropped malformed
events or the required offer census is unreadable): `location:{suburb, known}` and per day the `arrival_windows` for a visit
to that lead's suburb, excluding only that lead's own sent-text offers. Live owner-approval holds
remain busy and count toward that case's daily capacity.
A case already booked in GHL that day has `state: already_booked`,
`already_booked_that_day: true`, and no arrival windows.

### Named reasons

`ghl_calendar_directory_unreadable: <why>`, `ghl_user_not_confirmed`,
`ghl_calendar_assignments_unreadable`, `person_has_no_ghl_calendar`
(`not_configured`), `ghl_events_unreadable: <why>`,
`ghl_blocked_slots_unreadable: <why>`, `ghl_event_times_malformed`,
`person_not_configured`, `travel_location_unknown`,
`outlook_malformed_dropped: <count>` (free times withheld). Offers: `system_offers_unreadable: <why>`,
`system_sends_no_offers_for_this_person` (Nithin, Khairo: this system has no
send path for their leads, so its own census is complete and empty).

## Slot rule

A visit is **30 minutes on site** (owner, 24 Sep 2026), plus **travel between
consecutive visits** from their locations. No travel from home before the
first visit. An arrival window `{from_iso, to_iso}` is every arrival time at
which the visit fits: after the previous booking ends plus travel from it, and
finished, plus travel to the next booking, before that one starts. Day rules
are each person's profile (Marnin Tue/Fri 08:00 to 16:30, max 6, Tue 13:00 to
15:30 Stratco band with its fixed 30 minutes either side; Nithin Mon from
12:00, Tue, Thu, Fri, max 5; Khairo Mon to Fri, max 6).

The owner press (`sales_booking_owner_approval.ts`) applies the same rule:
`visit_minutes` is now 30, and a GHL booking or open offer clashes unless the
gap covers the computed travel. It refuses a neighboring event or offer when
either location cannot be placed.

### Travel estimate (`straight-line-v3`)

No routing API key is configured and none was added.

`minutes = 5 + straight-line km x 1.3 / 55 km/h x 60`, rounded up to 5.
Examples: Duncraig to Hillarys 15, Duncraig to Canning Vale 50.

Different suburbs use the median geocoded `jobs.site_lat/site_lng` point per
suburb in production (177 suburbs, read-only SELECT 24 Sep 2026). Two different
visits in the same known suburb use a 15-minute minimum. Identical numbered
addresses use the location formula, which gives the 5-minute floor. Contact-based
event and offer locations are used only when every loaded case for that contact
agrees on one suburb. A location that cannot be placed has no travel estimate:
affected arrival gaps are withheld, and owner approval waits until both
locations resolve. Outlook events use their location display name for the same
calculation.

The day state is `travel_unknown` when an on-site visit could fit if travel
were known, but every remaining candidate window depends on an unknown travel
gap. `no_time_left` means there is no remaining 30-minute on-site gap even
without travel. Each case derives its state and windows using that case's own
suburb, so a generic day with unknown travel can still have an `open` case row.

## Measured on 24 Sep 2026 (read-only)

- GHL directory: Marnin is on STRATCO FENCING only (no personal calendar);
  Nithin has "Nithin Silas Scope Calendar" (`RSQnT8cQdEE8azb5Chlq`); Khairo has
  "Khairo Pomare's Personal Calendar" (`NAS4UlY4ztBUG1qe750B`) and
  "SW Fencing Scope Calendar" (`i6j9vaCy6c94n3i93cir`).
- Marnin, 21 Sep to 3 Oct: GHL returned **0** events; his Outlook had **8**
  busy blocks. So GHL is not showing his Outlook today, and the read's
  `calendar_read.outlook.unverified_correspondence` counts Outlook events whose correspondence is unverified. The custom marker
  proves only this system's GHL-to-Outlook copies; native GHL sync does not supply it.
- Production behaviour of the new read, including the blocked-slots call,
  has not been observed: it ships with the next edge deploy.

## Owner clicks

The banner clears when this change deploys. To make Marnin's GHL calendar
contain the Outlook conflicts required by the intended setup, the owner must
connect Outlook and set it as the conflict calendar for STRATCO FENCING.
Today GHL has 0 of his 8 Outlook blocks. The current server read separately
counts those Outlook blocks for Marnin, but that does not connect or populate
his GHL calendar:

1. In GHL, open Settings > Calendars > Connections, signed in as Marnin.
2. Connect Microsoft 365 / Outlook with marnin@secureworkswa.com.au.
3. Set that Outlook calendar as the conflict calendar for STRATCO FENCING.
4. Confirm in GHL that a known Outlook busy interval prevents booking on
   STRATCO FENCING. The unverified-correspondence count cannot certify native
   sync success or failure and need not fall to zero after connection.

Nithin and Khairo already have GHL calendars; no click for them.

## Follow-ups

- Screen (secureworks-ux `modules/ops-sales-booking.js`): paint
  `free_times` / case `free_times`, and show `calendar_read.outlook.unverified_correspondence`.
  The banner itself clears with no UX change (it reads `calendar_read.state`).
- Khairo is on the screen's switch but is not a `sales_booking_read` resource
  (400). Adding him needs a decision on which leads are his.
- Wiki profile `fencing-stratco-marnin.json` still says `visit_minutes: 60`.

Approval checks overlap against every busy interval and calculates travel only
against the immediately preceding and following intervals across GHL appointments,
GHL blocked slots, Outlook and open offers. The owner press re-reads blocked slots
for that person and day; failed or malformed reads refuse as
`ghl_blocked_slots_unreadable`. Availability retains neighboring visits outside
working hours for travel while keeping arrival windows within working hours. An unreadable offer census preserves `calendar_read.state: read`
and names its failure in `commitments_read`, while withholding both free-time outputs.

Each advertised arrival window has `from_iso` and `to_iso` exactly 60 minutes
apart, plus `end_iso` 30 minutes after the latest arrival. Windows start on a
five-minute grid and include travel clearance on both sides. Approval continues
to accept 60–90-minute arrival windows; exact-time bookings are not permitted.
The read and approval share `ownerVisitTiming` for window and on-site duration.

When neighboring intervals tie on their end or start, every tied location
constrains travel. The largest known travel gap applies; any unknown location
withholds that gap's arrival windows.
