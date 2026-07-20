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
- **D-e `intake_reconcile`** — the "did we miss anything" invariant (0 genuinely unaccounted =
  live+true). Every source row is classified `matched` / `accounted_alias_revision` /
  `genuinely_unaccounted` with a reason and evidence pointer, so capture aliases, twin Graph posts
  and PO-suffixed reference variants no longer read as missed work.
- **D-f `intake_golden_replay`** — key-less proof: gate verdict vs the job actually created.

## Extraction reliability slice (additive, code only — no schema/cron/recipient change)

Layered on top of D-a. The dead-key preflight is now one case in a typed failure policy
(`makesafe_extraction_reliability.ts`).

- **Typed failure classification.** Every extraction failure is classified `terminal` or
  `retryable` with a reason:
  - terminal, stops the provider lane for the cycle — `usage_cap` (the exact Anthropic
    spend-cap/usage-limit shape, which arrives as HTTP **400 invalid_request_error**, not
    429), `key_unset`, `auth_failed`, `configuration_failed`;
  - terminal but **item-local** (that one email only) — `request_invalid`;
  - retryable — `rate_limited` (429/overloaded), `upstream_5xx`, `network_error`,
    `response_parse_failed`, `unknown_transient`.
- **Bounded quarantine instead of a 2-minute retry storm.** A terminal failure is
  quarantined after ONE automatic attempt. Provider-lane quarantine leaves
  `makesafe_scanned_at` unset, so the item retries automatically once the provider
  recovers (`recovery_action: automatic_rescan`). An item-local `request_invalid` failure
  is bounded: it is marked scanned only once a durable visible record exists — either the
  draft it minted, or (if an intake gate dropped the email) a
  `makesafe.intake_item_quarantined` row in `business_events` carrying the source
  identity, typed reason and the gate that dropped it. Recovery is an explicit
  `reextract_intake_draft`. The write is idempotent per (source id, reason); a FAILED
  write leaves the source unscanned and degrades health with reason
  `quarantine_persistence_failed` (composed as `<provider_reason>+quarantine_persistence_failed`
  so a provider outage can never mask broken persistence).
- **Health tells the truth.** A provider-lane terminal failure degrades immediately. A
  cycle where **every** attempt failed (≥2 attempts, 0 successes) degrades as
  `wholesale_<reason>` / `wholesale_extraction_failure` — including retryable 429/network/5xx.
  A partial success stays `ok`. Degradation clears ONLY on an observed successful
  extraction: a quiet scan with no mail no longer falsely clears a prior degraded banner.
  (Sole exception: a degradation caused only by `quarantine_persistence_failed` clears on
  a confirmed durable quarantine write.)
- **Per-draft auto-file truth.** Suppression is per draft; `scan_ses_makesafes` now also
  reports `auto_file_eligible_drafts` / `auto_file_suppressed_drafts`, plus an
  `extraction_cycle` block (`attempts`, `successes`, `terminal_failures`,
  `retryable_failures`, `quarantined`, `item_local_quarantined`,
  `item_local_quarantine_record_failures`, `quarantined_source_ids`).
- **Alarm readiness facts (read-side, `intake_health` → `alarm_readiness`).** Never infers
  that the make-safe alarm authenticated just because the cron exists or a recipient is
  configured. Authentication is proved only by a fresh timestamp
  (`makesafe_intake_health.alarm_auth_verified_at`, added by
  `20260721000001_makesafe_intake_production_controls.sql`) that the protected
  `makesafe_email_canary` route writes only after passing auth. `authentication.status` is
  `verified` when that proof is at most `authentication_max_age_minutes` old (one 15-minute
  canary cadence), `stale` when the proof exists but has expired
  (`reason: alarm_authentication_proof_stale`), `failed` on an observed 401/403
  (`reason: alarm_invocation_unauthorised`), otherwise `unverified`
  (`reason: authenticated_canary_not_observed`). `ready` requires `verified` auth AND
  `alarm_enabled` AND at least one recipient AND no settings read error. Until a canary has
  run inside the window this reads `unverified`; after each authenticated canary it reads
  `verified` and expires one cadence later. No credentials, recipients, schedules or sending
  behaviour were changed.

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
   advisory). Baselines: 17 pre-existing errors at the M1 merge gate; 19 pre-existing errors as of
   2026-07-20, the count to validate against today. Neither number is a permanent allowlist — a
   change must introduce **zero new** type-check errors, and future runs compare against the
   baseline evidence captured for that run, not against a figure hardcoded here.
2. **Deploy** `ops-api` + `monitor-ses-makesafes` via the guarded path
   (`scripts/deploy-edge-function.sh`, `--no-verify-jwt` on ops-api).
3. **Apply migrations** (db push or Management-API), then verify the live cron cadence (above).
4. **Verify the classifier key.** `ANTHROPIC_API_KEY` EXISTS as a function secret (digest present
   in `supabase secrets list`) — but a digest does not prove it is live. Confirm with:
   `ops-api?action=intake_health` → `extraction.status` should be `ok` after the first scan. If it
   reads `degraded`, read `extraction.degraded_reason` — `key_unset`/`auth_failed` mean a dead or
   absent key: `supabase secrets set ANTHROPIC_API_KEY=<key>` and the scan recovers on the next
   cycle that actually extracts something. `usage_cap` means the Anthropic spend cap is hit (lift
   the cap; no redeploy). `wholesale_*` means every attempt failed that cycle.
   `quarantine_persistence_failed` means the durable quarantine record could not be written
   (check `business_events` RLS/schema) — treat that as urgent, it is the one state where items
   keep hitting the provider unbounded. Note the banner no longer self-clears on a quiet scan; it
   clears on the next observed successful extraction.
5. **Confirm switches:** `makesafe_cron_settings.cron_enabled = true` (the master poll gate — a
   bare db push never starts polling) and `auto_file_enabled = true` (Captain D1).
6. **Health:** `intake_health` → `healthy: true` (classifier ok AND unaccounted = 0 AND a
   known `intake_mode` AND `alarm_readiness.ready`). The response also carries `intake_mode`
   and a `deterministic_rollout` block (`max_cases_per_run`, source/instruction allowlist
   counts, `exact_allowlist_configured`).
7. **Proof (Captain's D1 rider — joint accuracy-testing window):** `intake_golden_replay` — read
   each email's replay verdict vs the draft/job actually created; investigate any
   `agreement.draft_presence_match: false` or `family_match: false`. This is the artifact to walk
   through with the Captain before fully trusting auto-file.
8. **Link backfill (D-c):** `makesafe_intake_link_backfill` (dry-run) → review `patches` +
   `no_source` → when satisfied, run live with `{ "dry_run": false }` (privileged). In-place
   metadata patch only; no delete/reopen. Deterministic regex, so it runs even with a dead key.
9. **Audit:** `intake_reconcile` → `counts.genuinely_unaccounted` should be 0. Every source email
   comes back in `items[]` with an explicit `classification` — `matched` (linked draft or a
   deterministic non-work-order gate verdict), `accounted_alias_revision` (a twin Graph post, or a
   resend/revision of an already-captured claim/PO), or `genuinely_unaccounted` — plus a `reason`
   and an `evidence` pointer (`{ kind: 'draft' | 'job' | 'classification', id }`). Each item also
   carries the raw source reference (`raw_reference`) beside the separately canonicalised
   `canonical_claim_ref` and `canonical_po_ref`. Only `genuinely_unaccounted` items are real emails
   with no draft/job — intake them by hand (manual fallback path in the intake skill). Two explicit
   different POs are never collapsed, so a new PO against a legacy claim-only job stays visible. A
   bare `Order No <digits>` is read as the sender's own work-order reference, not a PO, so those
   rows show a null `canonical_po_ref` — that is expected, not a parse miss.

## Rollback / brakes

- Auto-file too eager? `UPDATE makesafe_cron_settings SET auto_file_enabled = false;` → drafts-only,
  no redeploy. (Env override `MAKESAFE_AUTO_APPROVE_CLEAN_INTAKE=false` is a second brake.)
- Whole intake too noisy? `UPDATE makesafe_cron_settings SET cron_enabled = false;` → poll stops.
- Cadence back to 5 min? re-run `cron.schedule('makesafe-ses-poll','*/5 * * * *', …)`.
- Item quarantined by mistake? Nothing is discarded — find it via
  `business_events.event_type = 'makesafe.intake_item_quarantined'` (or the draft carrying
  `extraction_failure`) and requeue with `reextract_intake_draft`. Provider-lane quarantines need
  no action: they retry themselves on the next scan once the provider is healthy.
