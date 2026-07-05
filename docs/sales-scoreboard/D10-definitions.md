# Sales scoreboard — the counting rules (D10)

> Mission `sales-m0-data-truth-2026-07-05`, Lane B / U4. This is the plain-English
> sheet the reps and Marnin agree on **before** the numbers are used in a meeting.
> Every rule here maps 1:1 to a SQL view in
> `supabase/migrations/20260705000600_m0_u4_sales_scoreboard.sql`. If a rule and the
> SQL ever disagree, the SQL is wrong — fix the SQL, not the meaning.

## What the scoreboard measures

One line = one **lead episode**. An episode is one sales opportunity for one
customer. Today the only durable per-opportunity record in the system is a **job**
(a job carries the GHL opportunity id), so the scoreboard counts jobs in the sales
verticals: **fencing, patio, decking**. Make-safe jobs are a different (insurance)
funnel and are excluded.

A repeat customer who inquires twice is two episodes (two jobs), each measured on
its own clock. Nothing inherits an old timestamp.

### The honest boundary — read this first

**59% of people who contact us never get a job created.** They inquire, maybe get
one reply, and never reach the point where a job record exists. Because the
scoreboard counts jobs, **every number below only sees the ~41% of leads that
became a job.** Speed-to-lead, in particular, is measured jobs-only and is
therefore optimistic — the slowest leads (the ones we never logged) are invisible.

This is a known gap, not a bug. The fix is ingesting GHL opportunities as
first-class episodes so pre-job leads are counted too; that is filed as an Idea for
M2 (`coding/work/requests/2026-07-05-google-ads-attribution-sync.md` and the
opportunity-ingestion Idea). Until then, treat the top of the funnel as "leads that
became jobs," and say so in the meeting.

## The columns

### 1. Leads in
**Count of episodes (jobs) created in the week**, sales verticals only, test rows
excluded. This is the denominator for the week.

### 2. Speed-to-lead (per episode)
For an episode, the gap between the customer's **first inbound message** and our
**first outbound reply** on that job, in minutes. Weekly board shows the **median**
over episodes whose first contact fell in the week.

- Anchored on `jobs.first_contacted_at` (from U2), which is the episode's first
  touch and is already episode-scoped (a repeat customer's new inquiry does not
  inherit an old stamp). Speed-to-lead = the first `outbound` `business_events` row
  at or after that stamp, minus the stamp.
- Only counted for **inbound-first** episodes (`first_contact_direction = 'inbound'`),
  where a response time is meaningful. If we reached out first, or have not replied
  yet, the episode has no value and is left out of the median — never counted as zero.
- Reads NULL until U2's first-contact backfill runs (Marnin-gated); it fills in
  after. Anchoring on U2's stamp (not the raw earliest event) is deliberate — a raw
  min(inbound)/min(outbound) over all job history conflates old back-and-forth and
  reports days, not minutes.
- **Jobs-only** — see the honest boundary above.

### 3. Scoped
**Count of episodes with a sales scope visit** = jobs that have a `job_assignments`
row with `assignment_type = 'sales_scope'`, counted by the first visit's
`scheduled_date` in the week (one per episode).

- `'sales_scope'` is a distinct value chosen for the sales funnel. It does **not**
  overlap with the operations `'scope'` value that the ops reporting already counts
  (`reporting-api` uses `assignment_type = 'scope'` at index.ts:3187 / 3195 / 3394).
  The two counts measure different things by construction and will not match — the
  sales board counts sales scope visits, ops counts operational scope scheduling.
- This is 0 until the sales dashboard starts writing `'sales_scope'` rows (U3). The
  view is correct now and fills in as real visits are booked.

### 4. Quoted-from-site
**Count of episodes where a quote was provably sent from site.** Counts a
`business_events` row of type `quote.sent` whose `payload->>'from_site'` is exactly
`'true'`, by `occurred_at` in the week. The proof detail
(`payload->'from_site_evidence'`: tool session, scoper, the scope sign-off event,
timestamp) is surfaced on the scoreboard.

- **Explicit proof only.** Office resends, regenerations, and the historical
  4-hour-window estimate never count here. Estimated rows may be shown for context
  but are never in this number.
- The flag is written server-side by the scoping tool's on-site sign-off flow (U3).
  This view is the single consumer of that flag, so U3 must write it into the
  `quote.sent` payload. 0 until U3 ships; correct now.

### 5. Won / Lost
- **Won** = episodes with `jobs.accepted_at` in the week.
- **Lost** = `lost_reasons` rows created in the week, grouped by `reason_code`
  (9-code enum) with the rep's free text available for detail.

A separate weekly lost-reasons breakdown view gives the reason mix.

### 6. Follow-up compliance
Of the follow-up nudges **raised** in the week (`smart_nudges` by `created_at`,
job-linked to a sales vertical), the share that were **acted on** (`acted_at` set)
versus dismissed versus still open. Compliance % = acted / raised.

- Anchored on `created_at`, not `sent_at`: today every acted nudge has `acted_at`
  but no `sent_at` (they are acted straight from pending), so `sent_at` is not a
  usable denominator.
- `acted_at` is written today from two surfaces: the nudge act button
  (`sw_act_nudge`, always on) and — once its flag is on — the proposed-action send
  surface (U4b, flag `nudge_acted_from_proposed_v1`, default OFF).
- **Honest coverage note:** compliance only reflects follow-ups done through those
  two surfaces. A rep who follows up entirely outside the system (e.g. a personal
  call the machine never sees) is not counted as compliant. A nudge raised late in
  the week may not have had time to be acted. The one-tap rep loop that drives real
  coverage is M1; until then this column is a floor, not the whole truth.

## Exclusions (every view)
- **Test rows:** excluded via `jobs.is_test = true`. U4 creates the column
  (default false); U7 flags the known test rows. Nothing is deleted.
- **Make-safe** jobs (insurance funnel), and any non-sales vertical.

## Views this maps to
- `sales_scoreboard_episode` — one row per episode, all six facts above.
- `sales_scoreboard_weekly` — the weekly meeting board (Monday-start weeks).
- `sales_scoreboard_lost_reasons_weekly` — the lost-reason mix per week.

All three are read-only views. They write nothing and apply no data changes.
