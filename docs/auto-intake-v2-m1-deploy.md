# Auto-Intake v2 — Wave 1 (M1) deploy runbook

Branch: `makesafe/intake-resurrect-harden`. Deploys/merges are the First Mate's; the Captain's
"push till live" consent covered the BUILD only. This is the two-minute morning go-live ritual.

## What shipped (all additive, safe on a plain db push)

- **D-a fail-loud key preflight + `intake_health`** — a dead/absent `ANTHROPIC_API_KEY` degrades
  the scan LOUD (`makesafe_intake_health` banner + `extraction_down_key_dead` on every affected
  draft, forced `needs_review`, never auto-filed). No more silent empty extractions.
- **D-b cron 5 → 2 min** on `makesafe-ses-poll` (Captain D2). The `cron_enabled` gate is intact.
- **D-c** per-email canonical links + `makesafe_intake_link_backfill` (dry-run-first) for
  report-family jobs missing links.
- **D-d auto-file** — clean high-confidence WOs auto-approved through the gated internal path
  (`approved_by: 'auto-intake'` + `makesafe_auto_filed` job event). Kill switch:
  `makesafe_cron_settings.auto_file_enabled` (default TRUE).
- **D-e `intake_reconcile`** — the "did we miss anything" invariant (0 unaccounted = live+true).
- **D-f `intake_golden_replay`** — key-less proof: gate verdict vs the job actually created.

## Migrations

- `20260703000001_makesafe_intake_health_and_autofile.sql` — adds
  `makesafe_cron_settings.auto_file_enabled` (default TRUE) + `makesafe_intake_health` (single row).
- `20260703000002_makesafe_ses_poll_cadence_2min.sql` — reschedules `makesafe-ses-poll` to `*/2`.

⚠ **Live cron drift (M0 risk 4).** The migration history is not guaranteed to match the live
`cron.job` row. After deploy, VERIFY via the Management-API single-SQL pattern (do not assume the
migration took effect):

```sql
SELECT jobname, schedule FROM cron.job WHERE jobname = 'makesafe-ses-poll';   -- expect */2 * * * *
-- if still */5, apply live (cron.schedule upserts by jobname):
SELECT cron.schedule('makesafe-ses-poll', '*/2 * * * *',
  $$SELECT public.trigger_monitor_ses_makesafes()$$);
```

## Go-live steps (First Mate)

1. **Merge** the backend PR on green CI (import-resolution is the hard gate; `deno check` is
   advisory and unchanged at the pre-existing 17 errors — none in M1 code).
2. **Deploy** `ops-api` + `monitor-ses-makesafes` via the guarded path
   (`scripts/deploy-edge-function.sh`, `--no-verify-jwt` on ops-api).
3. **Apply migrations** (db push or Management-API), then verify the live cron cadence (above).
4. **Verify the classifier key.** `ANTHROPIC_API_KEY` EXISTS as a function secret (digest present
   in `supabase secrets list`) — but a digest does not prove it is live. Confirm with:
   `ops-api?action=intake_health` → `extraction.status` should be `ok` after the first scan. If it
   reads `degraded` (`key_unset`/`auth_failed`), set a live key:
   `supabase secrets set ANTHROPIC_API_KEY=<key>` — the scan recovers on the next 2-min cycle.
5. **Confirm switches:** `makesafe_cron_settings.cron_enabled = true` (the master poll gate — a
   bare db push never starts polling) and `auto_file_enabled = true` (Captain D1).
6. **Health:** `intake_health` → `healthy: true` (classifier ok AND unaccounted = 0).
7. **Proof (Captain's D1 rider — joint accuracy-testing window):** `intake_golden_replay` — read
   each email's replay verdict vs the draft/job actually created; investigate any
   `agreement.draft_presence_match: false` or `family_match: false`. This is the artifact to walk
   through with the Captain before fully trusting auto-file.
8. **Link backfill (D-c):** `makesafe_intake_link_backfill` (dry-run) → review `patches` +
   `no_source` → when satisfied, run live with `{ "dry_run": false }` (privileged). In-place
   metadata patch only; no delete/reopen. Deterministic regex, so it runs even with a dead key.
9. **Audit:** `intake_reconcile` → `unaccounted.count` should be 0. Any items are real emails with
   no draft/job — intake them by hand (manual fallback path in the intake skill).

## Rollback / brakes

- Auto-file too eager? `UPDATE makesafe_cron_settings SET auto_file_enabled = false;` → drafts-only,
  no redeploy. (Env override `MAKESAFE_AUTO_APPROVE_CLEAN_INTAKE=false` is a second brake.)
- Whole intake too noisy? `UPDATE makesafe_cron_settings SET cron_enabled = false;` → poll stops.
- Cadence back to 5 min? re-run `cron.schedule('makesafe-ses-poll','*/5 * * * *', …)`.
