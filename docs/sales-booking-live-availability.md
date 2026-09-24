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
2. GHL events for the week: the user-id window plus each of their calendars.
   Other assignees and cancelled rows never block.
3. GHL blocked-off time for the user (`/calendars/blocked-slots`).
4. Outlook events the read already fetched for the diary (Marnin only) are
   also busy. No new Outlook read. A failed Outlook read is a caveat, not a
   block: GHL is the source, and the press still re-checks Outlook.
5. Open offers: the same census the owner press uses
   (`systemOfferCensus`, `sales_booking_executions` claimed in the last 21
   days joined to their approvals, plus live owner approvals). An offer to a
   lead who now has a GHL appointment is dropped. Hand-sent texts are not
   machine-checked and say so.

`booking_flow` then carries:

| Field | Meaning |
|---|---|
| `calendar_read` | `state: read / could_not_read / not_configured`, `provider:"ghl"`, `source:"server_live_read"`, `reason`, `person`, `ghl_user_id`, `calendars`, `occupied_intervals`, `ghl_events`, `ghl_blocked_slots`, `outlook:{state,events,not_in_ghl}`, `caveats` |
| `commitments` | Open offers `{id, contact_id, state:offered/agreed, start_iso, end_iso, source}`; `null` when the census could not be read (unknown, never an empty ledger) |
| `commitments_read` | `read` or `could_not_read` with the reason |
| `free_times` | The rule, and per bookable day: `state` (`open`, `full`, `past`, `no_time_left`), `booked`, `busy[]`, `arrival_windows[]` for a lead of unknown location; intervals needing an unknown travel estimate are withheld |

Each case carries `free_times`: `location:{suburb, known}` and per day the
`arrival_windows` for a visit to that lead's suburb, excluding that lead's own
offers.

### Named reasons

`ghl_calendar_directory_unreadable: <why>`, `ghl_user_not_confirmed`,
`ghl_calendar_assignments_unreadable`, `person_has_no_ghl_calendar`
(`not_configured`), `ghl_events_unreadable: <why>`,
`ghl_blocked_slots_unreadable: <why>`, `ghl_event_times_malformed`,
`person_not_configured`, `travel_location_unknown`. Offers: `system_offers_unreadable: <why>`,
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

### Travel estimate (`straight-line-v1`)

No routing API key is configured and none was added.

`minutes = 5 + straight-line km x 1.3 / 55 km/h x 60`, rounded up to 5.
Examples: Duncraig to Hillarys 15, Duncraig to Canning Vale 50.

Locations are suburb points: the median geocoded `jobs.site_lat/site_lng` per
suburb in production (177 suburbs, read-only SELECT 24 Sep 2026), matched on
the case suburb, a GHL event's address, or its contact's case suburb. A
location that cannot be placed has no travel estimate: affected arrival gaps
are withheld, and owner approval waits until both locations resolve. Outlook
events use their location display name for the same calculation.

## Measured on 24 Sep 2026 (read-only)

- GHL directory: Marnin is on STRATCO FENCING only (no personal calendar);
  Nithin has "Nithin Silas Scope Calendar" (`RSQnT8cQdEE8azb5Chlq`); Khairo has
  "Khairo Pomare's Personal Calendar" (`NAS4UlY4ztBUG1qe750B`) and
  "SW Fencing Scope Calendar" (`i6j9vaCy6c94n3i93cir`).
- Marnin, 21 Sep to 3 Oct: GHL returned **0** events; his Outlook had **8**
  busy blocks. So GHL is not showing his Outlook today, and the read's
  `calendar_read.outlook.not_in_ghl` says how many Outlook events GHL lacks.
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
4. Reload the booking screen and check `calendar_read.outlook.not_in_ghl`
   falls to 0. If it does not, the GHL mirror is still incomplete and needs
   investigation before it can be relied on as the source of free times.

Nithin and Khairo already have GHL calendars; no click for them.

## Follow-ups

- Screen (secureworks-ux `modules/ops-sales-booking.js`): paint
  `free_times` / case `free_times`, and show `calendar_read.outlook.not_in_ghl`.
  The banner itself clears with no UX change (it reads `calendar_read.state`).
- Khairo is on the screen's switch but is not a `sales_booking_read` resource
  (400). Adding him needs a decision on which leads are his.
- Wiki profile `fencing-stratco-marnin.json` still says `visit_minutes: 60`.
