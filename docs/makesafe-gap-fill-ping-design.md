# Design: trade-report-submitted ping for the gap-fill / reporting sweep

**Status:** DESIGN — ready to implement, **not implemented in this PR.** The
real-time push half needs a captain decision on the delivery channel because a
genuine external push requires a shared secret, and the campaign forbids adding a
new secret blind (captain ruling 3, 2026-07-21). The **pull half is live now.**

Companion to `docs/makesafe-gap-fill-batch-skill.md`. Both triggers drive the
captain's **subscription Claude**, never the paid API.

---

## The two triggers, and what already exists

Captain ruling 2 asks for two triggers:

- **(a) A ping/webhook when a trade submits a report**, notifying that reporting
  work is ready → *this document.*
- **(b) 3-4 scheduled daily batch runs** that convert ready work into
  human-review-ready state → already served by the `makesafe_gap_fill_queue`
  endpoint (a Claude Code `/schedule` routine pulls it; see the skill doc).

### What is already in place (no new code needed)

When a trade submits a make-safe report, `submit_makesafe_report`
(`supabase/functions/ops-api/index.ts`) already, atomically:

1. inserts/updates a `job_service_reports` row (`status='submitted'`);
2. sets `makesafe_job_details.substatus='admin_to_send_report'` +
   `report_received_at`;
3. inserts a `job_events` row `event_type='makesafe_report_submitted'`.

And the gap-fill queue's `report_ready` section
(`makesafe_gap_fill_report_ready.ts`) already surfaces exactly these jobs — every
job that is "submitted but the pack has not been drafted", using the same
`selectDraftPackDueJobIds` predicate the reporting run itself uses. So a scheduled
sweep (trigger b) **already** catches submitted reports at its next run with zero
new code. The only thing (a) adds is **latency**: a real-time nudge so the sweep
runs within seconds of submission instead of at the next scheduled slot.

---

## The gap: delivering the nudge to subscription Claude

"Drive subscription Claude, not the API" is the hard constraint. The subscription
Claude runs on the captain's machine (Claude Code) or the always-on Claude browser.
Nothing inside this repo can *invoke* that session directly. A push therefore needs
a **delivery channel** the captain's Claude environment listens on, and that
channel needs an address + a shared secret. That secret is the blocker: adding it
silently violates ruling 3, so the channel is a captain decision.

### Recommended design (implement once the channel is chosen)

**Emit an idempotent, durable "reporting work ready" signal at submit time, and let
a thin relay deliver it.** Two pieces:

**1. In-repo signal (safe to build now; deferred only to keep this PR pull-only).**
Add, at the end of the `submittingFinal` branch of `submit_makesafe_report` (right
after the existing `makesafe_report_submitted` `job_events` insert), a
non-throwing, deduplicated enqueue mirroring the existing arrival-notify ledger
pattern (`makesafe_notify_log`, `UNIQUE(org_id, dedup_key)` — see
`supabase/functions/ops-api/makesafe_notify.ts` and migration
`20260704000006_makesafe_notify_settings.sql`):

```ts
// dedup_key = `report_ready:${job_id}:${cycle_number}` — one signal per job cycle.
// Best-effort: a failure here must NEVER fail the trade's submission (wrap in
// try/catch and push a warning, exactly like the existing event_sync block).
```

This gives a durable, replayable "ready" signal keyed per job-cycle. It is additive
and idempotent (a resubmit collides on the key and is skipped).

**2. Relay to subscription Claude (the part that needs the captain decision).**
Pick ONE channel:

| Channel | How it reaches subscription Claude | Secret needed |
|---|---|---|
| **pg_cron + pg_net → webhook** | A 1-2 min `pg_cron` job POSTs new unsent signal rows to a small webhook the captain's Claude Code environment polls/receives | webhook URL + shared HMAC secret (**new**) |
| **Poll the queue** | The captain's Claude Code `/schedule` runs the queue every ~15 min; no push at all | none (this is just trigger b at a tighter cadence) |
| **Telegram ping** | Reuse `sw_send_telegram_message` to ping a channel the captain watches, then trigger a sweep manually | existing Telegram token (owner-comms, not "drive Claude") |

**Recommendation:** ship piece 1 (the durable signal) plus a **tightened poll**
(trigger b at ~10-15 min) as the zero-secret path, and reserve the webhook relay
for when the captain nominates a channel + secret. That delivers near-real-time
behaviour with **no new secret**, and upgrades cleanly to a true push later.

### Why not push straight from the edge function

`submit_makesafe_report` could `fetch()` a webhook inline, but that (a) needs the
secret now, (b) couples the trade's submission latency/reliability to an external
endpoint, and (c) has no idempotency if the submit is retried. The durable signal +
relay avoids all three.

---

## Explicit decision needed from the captain

1. **Channel for the real-time push:** webhook relay (new secret), tightened poll
   (no secret, recommended interim), or Telegram ping (existing secret)?
2. On that answer, implement piece 1 (durable signal) + the chosen relay. Piece 1
   is ~15 lines in `submit_makesafe_report` plus a `makesafe_report_ready_signals`
   table (or reuse `makesafe_notify_log` with a new dedup namespace); the relay is
   a `pg_cron` job or a `/schedule` cadence change.

Until then, trigger (a) is served functionally by trigger (b): every submitted
report is already visible in `makesafe_gap_fill_queue.report_ready` and is swept on
the next scheduled run.
