# Retiring the leaked service-role key (Steps 2-4)

Date: 2026-09-30. Owner of the decision: the Captain. Nothing in this document
has been applied to production.

The project's legacy `service_role` key (fingerprint `4595ba`, the first six hex
characters of its sha256) was committed to this repository in March 2026 and
is still live. Step 1, withdrawing public execute rights on the functions that
handed it out, is applied (`20260930023008`). This document covers the rest:

| Step | What | State |
| ---- | ---- | ----- |
| 2 | Cron jobs read the key from Vault instead of carrying it | Migration ready, not applied |
| 3 | Take the key out of the repository and stop it coming back | Done in the same branch |
| 4 | Move to the new keys, switch the old ones off, revoke the old JWT secret | Caller checks (C, in part) done in code, see "Done in code" below; the rest needs dashboard work and code |

Only Step 4 makes the leaked key useless. Steps 2 and 3 shrink where it lives
so that Step 4 is one clean change instead of a hunt.

**Deadline.** Supabase says the legacy `anon` and `service_role` keys keep
working "until the end of 2026". Step 4 is due by then whatever happens.

## Step 2: cron jobs read the key from Vault

Twelve production cron jobs send the service key. Eleven have it pasted into
their command text (`xero-token-refresh`, `xero-po-sync`, `xero-reports-sync`,
`xero-projects-sync`, `xero-tracking-pl-sync`, `xero-bank-sync`,
`xero-payables-sync`, `xero-suppliers-sync`, `contact-matching`,
`system-health-check`, `xero-invoice-sync`); one, `weekly-ceo-financial-brief`,
calls the legacy helper `_sw_service_key()`.

`supabase/migrations/20260930120000_cron_service_key_from_vault.sql` rewrites
each of them in place with `cron.alter_job`, so ids, schedules and on/off state
do not move. Only the source of the key changes, to `public.sw_service_key()`.
It refuses, and changes nothing, if any job's pasted key is not the same key as
Vault holds: the requests on the wire stay byte-for-byte the same. It is covered
by the migration contract under
`supabase/tests/migration-contracts/20260930120000_cron_service_key_from_vault/`.

Merging this branch to `main` is what applies Step 2. The push to `main` runs
the Deploy Edge Functions workflow, and `scripts/apply-pending-migrations.sh`
applies every migration from the auto-apply baseline up that production's
ledger does not have yet, this one included. Do not also apply it by hand.

Procedure:

1. Before asking the Captain to merge, firstmate runs each query in
   `scripts/cron-service-key-precheck.sql` on its own against production
   (read-only, through the Supabase connection) and keeps the output. Ask for
   the merge only if query 3 says `rewrite` (or `absent` / `unchanged`) for all
   twelve jobs, query 4 returns nothing, query 2's fingerprint is `4595ba` and
   query 1 shows `version_20260930120000_taken = false`. On a no-go, do not
   merge: a refusal in the deploy lane changes no job, but it fails that deploy
   run and holds every later edge deploy until it is fixed.
2. The Captain merges; the deploy lane applies the migration. Check that the
   run's migration step passed.
3. Run `scripts/cron-service-key-postcheck.sql` straight away (queries 1-2),
   then again after an hour (queries 3-4, with the apply time filled in).
4. Only if the jobs fail because the Vault read fails in the cron worker, run
   `supabase/rollbacks/20260930120000_cron_service_key_from_vault_down.sql`.
   It pastes the key back from Vault, so never run it after Step 4 has put a
   new key in Vault.

Nothing reads Vault that did not read it yesterday: jobs 70, 73 and 90 and the
make-safe triggers already read it on every run, and since Step 1
`_sw_service_key()` is itself a Vault read. Pre-check query 5 shows those runs.

Not in Step 2: about twenty database functions still reach the key through
`_sw_service_key()` or read Vault directly. They carry no literal and need no
change until Step 4 (below), when they all move together.

## Step 3: out of the repository, and kept out

- `PHASE2_HANDOFFS.md` now shows the Vault form instead of the pasted key.
- The five historical migrations that carried it
  (`20260322000004`, `20260322000011`, `20260322000012`, `20260404000002`,
  `20260405000001`) now carry `REDACTED-legacy-service-role-key` plus a note.
  The repository's rules allow this: they sit below the auto-apply baseline
  (`MIN_VERSION=20260722000001` in `scripts/apply-pending-migrations.sh`), are
  never re-applied, are on no hash-pinned exclusion list, and ledger checksum
  drift is advisory. No test reads them.
- `scripts/check-no-committed-service-keys.sh` fails when any tracked file holds
  a JWT whose role is `service_role`, or an `sb_secret_` key. It runs, with its
  own test, on every PR that `pr-check.yml`'s `paths:` filter admits (which
  includes the browser-key files Step G edits), and works as a pre-commit hook
  with `--cached`. It prints file, line and fingerprint, never the key.
- Git history still has the key and is deliberately not rewritten; rewriting
  history would disrupt every clone, and Step 4 makes the old copy worthless.

## Step 4: switch to the new keys, then kill the old ones

### In one paragraph

Supabase now issues two kinds of keys: a **publishable** key (`sb_publishable_…`,
public, replaces `anon`) and **secret** keys (`sb_secret_…`, private, replace
`service_role`). Both kinds work side by side with the old keys, so the safe
order is: create the new keys, move every user of the old keys across one at a
time and check each, and only when nothing uses the old keys, switch them off and
revoke the old signing secret. Switching off first breaks everything at once.

### Why the order matters

The new secret keys are not JWTs. That has three consequences, and the whole
plan follows from them:

1. They must be sent in an `apikey` header, never as `Authorization: Bearer`.
   Every cron job and database function here sends `Authorization: Bearer`.
2. An edge function with the platform's "verify JWT" check on rejects them. Seven
   functions have that check on and must be switched to checking in code first.
3. Several functions decide "is this caller our server?" by comparing the
   presented token, as a plain string, with `SUPABASE_SERVICE_ROLE_KEY`. That
   comparison never asks Supabase whether the key is still valid, so it can go on
   accepting the leaked key after the keys are switched off. Those checks must be
   changed to the new key and the old comparison removed; switching keys off in
   the dashboard alone does not close them.

### Captain: dashboard steps

**A. Create the new keys (safe, changes nothing).**
Settings → API Keys → "Publishable and secret API keys" tab → "Create new API
keys". This makes a publishable key and a secret key named `default`. Then add
more secret keys so that one leak never forces a rotation of everything: we
recommend `cron` (database jobs), `edge` (edge functions calling each other) and
`ops` (operator scripts). Do not paste any key into chat, email, a ticket or a
file. Confirm that Edge Functions → Secrets now lists `SUPABASE_SECRET_KEYS` and
`SUPABASE_PUBLISHABLE_KEYS`.

**B. Put the `cron` secret key into Vault under a NEW name.**
Database → Vault → add secret `sb_secret_key` with the `cron` key. Leave the
existing `service_role_key` alone for now: every current database caller still
needs it, and `public.sw_service_key()` refuses anything that is not a JWT, so
overwriting it would stop every job at once.

Then hand over to the code steps (C-G). Each is a reviewed change with its own
check; the Captain does not need to act until step H.

### Code and configuration changes (agents, in this order)

Each change is dual-accepting: it adds the new key and keeps the old path until
step G, so each one can ship and be checked alone.

**Done in code (branch `fm/sec-key-rotate-4`).** Nothing below changes what
production accepts while the legacy keys are on.

- The fourteen exact-match caller checks listed under C now go through one
  module, `supabase/functions/_shared/service_credential.ts`. It accepts a new
  `sb_secret_` key from `SUPABASE_SECRET_KEYS` in `apikey`, `x-api-key` or
  `Authorization: Bearer`, and accepts the legacy key only while the project's
  own API gateway still honours it (it asks `GET /auth/v1/settings` with the
  key as `apikey`, cached five minutes per isolate). So step K on its own now
  stops these fourteen functions accepting the legacy key, whatever
  `SUPABASE_SERVICE_ROLE_KEY` still holds. If the gateway cannot answer, the
  exact injected key keeps working (its own database calls fail in that outage
  anyway) and a role-claim-only token is refused.
- `monitor-ses-makesafes` (still deployed with verify-JWT on) no longer
  trusts a `role` claim alone; a claim counts only once the gateway confirms
  that exact token. No function's verify-JWT setting changes here.
- `makesafe_cost_report.ts` signs links with `MAKESAFE_REPORT_SECRET`, else
  `SW_API_KEY`, never the service key; with neither set no link is minted or
  accepted. Production sets `SW_API_KEY`, so existing links keep working.
- The Railway fallback was already removed in #901
  (`ops-api/secureworks_agent_bearer.ts`).
- `daily-digest`'s undeclared `SERVICE_ROLE_KEY` (E) is gone. It sat in the
  day-3 / day-7 house-plans client reminders and threw before any send, so none
  has ever gone out. They stay off; switching them on is a separate decision.

Not yet done: the admin client key in all 22 functions (below), D, E, F, H, I
and M. `ghl-message-reconcile` and `ghl-history-load` (newer than this runbook)
still accept the exact key or a role claim behind the platform's verify-JWT
check; they need the same treatment as D before their cron caller moves to a
secret key.

**C. Edge functions accept the new secret key.**
Read the admin key from `JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS'))[...]`
instead of `SUPABASE_SERVICE_ROLE_KEY`, and let each server-caller check also
accept the `apikey` header when it equals a named secret key. Places:

- Admin client key, all 22 functions: `agent-runner`, `attribution-backfill`, `completion-pack`, `daily-digest`,
  `followup-signal-sync`, `ghl-proxy`, `ghl-webhook`, `ghl-webhook-receiver`,
  `google-ads-ingest`, `monitor-inbox`, `monitor-ses-makesafes`, `ops-ai`,
  `ops-api`, `receive-po-email`, `reporting-api`, `resend-webhook`,
  `send-outlook-email`, `send-po-email`, `send-quote`, `system-health`,
  `transcribe-call`, `xero-sync`. (`monitor-inbox`, `monitor-ses-makesafes` and
  `send-outlook-email` also fall back to `SUPABASE_SERVICE_KEY`.)
- Exact-match server-caller checks: `ops-api/index.ts`
  `_opsApiServerSecretPresented` (~3700); `ghl-proxy/hardening_helpers.ts:123`;
  `agent-runner:766`; `attribution-backfill:68`; `completion-pack:538`;
  `daily-digest:1320`; `followup-signal-sync:58`; `monitor-ses-makesafes:132`;
  `ops-ai:3315`; `reporting-api:183`; `send-outlook-email:669`;
  `send-po-email:215`; `send-quote:649`; `system-health:30`.
- `ops-api/makesafe_cost_report.ts:45` uses the service key as a fallback
  signing secret for cost-report links. Set `MAKESAFE_REPORT_SECRET` (or rely on
  `SW_API_KEY`) first, or every issued link breaks when the key changes.
- (Already removed in #901.) `ops-api/index.ts:~47870` sent the service key to the external Railway agent
  when `AGENT_BEARER_TOKEN` and `SW_API_KEY` are unset. Set one of those first.
- Tests that pin the old variable: `ops-api/manual_dispatch_test.ts`,
  `makesafe_intake_recapture_test.ts`, `monitor_ses_makesafes_test.ts`,
  `send-quote/auth_test.ts`.

Check: deploy, then `scripts/smoke-edge-functions.sh`, and one call per function
with the new key in `apikey` returns what the old key returned.

**D. Turn off the platform "verify JWT" check where it is on, and check in code
instead.** On today (their `index.ts` header lacks `--no-verify-jwt`, which is
what `deploy-edge-functions.yml` reads): `google-ads-ingest`, `monitor-inbox`,
`monitor-ses-makesafes`, `reporting-api`, `system-health`, `transcribe-call`,
`xero-sync`. `xero-sync` and `transcribe-call` have no check of their own at
all today, so each needs one before the flag goes off.

**Trap:** `monitor-ses-makesafes/index.ts:98-133` accepts any token whose
`role` claim reads `service_role` without checking its signature, trusting the
platform check to have done so. Remove that path in the same change, before the
flag goes off, or anyone can forge a token and pass.

Check: a call with no credentials gets 401 from each of the seven; a call with
the new key in `apikey` succeeds.

**E. Edge functions call each other with the new key.** Send the named `edge`
secret key as `apikey` (not `Authorization: Bearer`): `agent-runner` (→ ops-api,
reporting-api, ghl-proxy, send-quote), `daily-digest` (→ ops-ai, reporting-api,
ops-api, completion-pack), `ghl-proxy` (→ xero-sync), `ghl-webhook` (→ ops-api),
`ghl-webhook-receiver` (→ transcribe-call), `monitor-ses-makesafes` (→ ops-api),
`ops-ai` (→ ops-api, reporting-api, ghl-proxy, send-quote), `ops-api` (→
ghl-proxy, send-quote, reporting-api, transcribe-call, xero-sync),
`receive-po-email` (→ ops-api), `send-outlook-email` (→ ghl-proxy), `send-quote`
(→ ghl-proxy, ops-api), `xero-sync` (→ ops-api). Fix on the way:
`daily-digest/index.ts:1605,1623` use an undeclared `SERVICE_ROLE_KEY` today.

Check: the daily digest, CEO brief and a quote send run clean in the function
logs.

**F. The database sends the new key.** One migration:

- a new accessor, `public.sw_secret_key()`, reading Vault `sb_secret_key`,
  locked to `postgres`, checking the `sb_secret_` shape (the old
  `sw_service_key()` refuses anything that is not a JWT);
- every pg_net caller sends `apikey: <secret key>` instead of
  `Authorization: Bearer`: the twelve Step 2 cron jobs (rewrite in place exactly
  as Step 2 did; after Step 2 each carries one recognisable
  `'Bearer ' || public.sw_service_key()` expression), and the functions
  `send_ghl_sms`, `send_ghl_email`, `trigger_daily_digest`,
  `process_outbound_queue`, `send_outlook_email`, `trigger_monitor_inbox`,
  `trigger_monitor_ses_makesafes`, `fn_process_payment_events`,
  `trigger_makesafe_reconcile`, `trigger_makesafe_draft_pack_due`,
  `trigger_makesafe_portal_recheck`, `trigger_makesafe_sent_mirror`,
  `trigger_makesafe_story_recompute`, `trigger_makesafe_status_shadow_refresh`,
  `trigger_makesafe_status_canary`, `trigger_ghl_message_reconcile`,
  `trigger_ses_report_trigger_drain`, plus the live-only
  `trigger_generate_nudges` and `trigger_batch_intelligence` (read their live
  bodies first). `trigger_makesafe_pdf_extraction_drain` uses `sw_api_key` and
  is unaffected.

This must follow C and D: a target that still has "verify JWT" on, or still
only accepts the old key, rejects the new header.

Check: in `net._http_response`, the share of 2xx responses does not fall, and
`cron.job_run_details` shows the jobs succeeding. Note that about 300 an hour
of `401 user_jwt_required` already happen today (report `debt-key-check-s3`
section 4e); compare against that baseline, and expect it to fall once callers
present a key the target recognises.

**G. Browser apps and the public site use the publishable key.**
`supabase/config.js:3` (tracked in git, despite `supabase/SETUP.md` calling it
ignored), `supabase/config.example.js`, `tools/fencing/index.html:8195`, anything
reading `tools/shared/cloud.js` (`window.SUPABASE_ANON_KEY` or the
`supabase-anon-key` meta tag), and the copies of `cloud.js` in
`secureworks-ux` (Ops and Trade apps), `secureworks-sale` and `patio-tool`.
Public Realtime connections are limited to 24 hours on the publishable key
unless the user is signed in.

Check: sign in to Ops and Trade, load a board, open the fencing tool.

**H. Operator scripts and other repositories.** Set the named `ops` secret key
in the operator environment, sent as `apikey`: `scripts/apply-board-safe-fixes-v1.ts`,
`scripts/apply-board-fixes-round2-v1.ts`, `scripts/apply-ses-c3-wo-backfill-v1.ts`,
`scripts/replay-makesafe-five-fates.ts`, `scripts/ses-evidence-stage-checker.ts`,
`scripts/ses-measure-card-evidence.ts`, `scripts/test-lab/ses-synthetic-livefire/`
(`run.ts`, `client.ts`, `run-full.sh`, `cleanup-run.sh`, which look the key up
by the name `service_role`). Outside this repository: the secureworks-wiki
skills, the MCP / relay callers and any laptop `.env` that holds the old key.
GitHub Actions hold no Supabase API key (`SUPABASE_ACCESS_TOKEN` is a management
token and `SW_API_KEY` is separate; both unaffected).

**I. Remove the old paths.** Delete the exact-match comparisons against
`SUPABASE_SERVICE_ROLE_KEY` added in C's dual-accept, and every remaining read of
`SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_ANON_KEY`. Deploy. This is what stops a
function accepting the leaked key as a plain string, whatever the dashboard says.

### Captain: switch the old keys off

**J. Watch for a day.** In Settings → API Keys, check the last-used indicators
on the legacy keys if the page shows them (Supabase's own guides disagree about
whether it does), and ask firstmate to confirm `net._http_response` and the
function logs show no failures.

**K. Deactivate the legacy keys.** Settings → API Keys → Legacy tab →
deactivate `anon` and `service_role`. Reversible: re-activate if something was
missed, fix it, try again.

**L. Revoke the legacy JWT secret. This is what makes `4595ba` dead.**
Settings → JWT Keys.

- If the legacy secret is still "In use": click "Migrate JWT secret", then
  "Rotate keys" to the new standby key, then wait at least the access-token
  lifetime plus 15 minutes (1 h 15 min on the default setting) so signed-in
  users are not thrown out.
- Then, under "Previously used", revoke the legacy secret. Supabase requires the
  legacy keys to be deactivated first (step K).
- Reversible: "Move to standby", then rotate back.

**M. Tidy up (code).** Delete Vault `service_role_key`, retire
`public.sw_service_key()` and `public._sw_service_key()`, and remove the Step 2
rollback file, which would otherwise paste whatever Vault holds into cron.

### What breaks if the order is wrong

| Done too early | What breaks |
| -------------- | ----------- |
| Overwrite Vault `service_role_key` with a new key (instead of B) | Every cron job and database trigger at once: `sw_service_key()` refuses a non-JWT |
| F before C/D | The target functions reject the new header; Xero sync, SMS/email sends, digests and make-safe triggers stop |
| D without removing the `monitor-ses-makesafes` role shortcut | Anyone can forge a token and run that function |
| K (deactivate) before C-H | All 22 edge functions lose database access, every cron job fails, Ops/Trade/fencing apps stop, operator scripts fail |
| L (revoke) before K | Supabase refuses; the legacy keys must be off first |
| L without I | The fourteen caller checks already refuse the legacy key once the gateway does; D's functions still need their own change; any read of `SUPABASE_SERVICE_ROLE_KEY` left elsewhere (admin clients, outbound calls) still breaks |
| Revoke without waiting after a rotation | Signed-in users are signed out |
| Changing the key before re-homing `makesafe_cost_report.ts`'s secret | Existing cost-report links stop working |

Unaffected throughout: `SW_API_KEY` (Vault `sw_api_key`, MCP and relay callers)
and the `SUPABASE_ACCESS_TOKEN` management token.

### Not established

- Whether the platform still injects a working `SUPABASE_SERVICE_ROLE_KEY` after
  deactivation, and whether its value equals `4595ba` (the 401 pattern in report
  `debt-key-check-s3` section 4e suggests it may already differ). Step I makes
  the answer irrelevant.
- Whether user sessions are already signed by a new key (a test fixture
  suggests ES256); check the JWT Keys tab at step L.
- The live bodies of `trigger_generate_nudges` and `trigger_batch_intelligence`,
  which exist only in production.

Sources: Supabase guides "Migrating to publishable and secret API keys",
"Understanding API keys" and "JWT Signing Keys" (read 2026-09-30); report
`debt-key-check-s3` (2026-09-29).
