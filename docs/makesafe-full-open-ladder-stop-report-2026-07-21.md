# Make-safe full-open ladder stop report, 2026-07-21

## Outcome

The explicit `full_open` production contract was activated successfully and passed
clean deterministic observations at case caps 1 and 2. The ladder stopped at cap 5
because scheduled requests exceeded the scheduler's 5-second HTTP timeout, advanced
the deterministic sweep cursor, and did not advance deterministic health beyond the
last cap-2 scan.

Intake authority was returned to `legacy` at
`2026-07-21T12:01:17.046572Z`. No cap-10 or unrestricted-live step was attempted.
Append-only case/source evidence was retained.

Structured evidence:

`docs/evidence/makesafe-full-open-ladder-stop-2026-07-21.json`

## Release gate

- Migration `20260721000002_makesafe_intake_full_open.sql` was applied before code.
- Canonical `origin/main` commit
  `9fd9e07404f2fccc102aeeb063b082d85e2be26e` was deployed as `ops-api` v854.
- `verify_jwt=false` was confirmed.
- The recurring inactive local smoke credential was replaced with the active
  production client credential in the mode-600 local `deploy.env`. No credential is
  present in this evidence.
- Guarded smoke then passed 9/9, including exact deployed commit and action surface.

## Legacy degraded context

The pre-activation `2026-07-21T11:29:11.498Z` health row reported
`degraded_reason=usage_cap` and one model call. The captain ruled that this was the
pre-existing legacy AI extraction condition the deterministic path replaces, not a
new deterministic anomaly. Activation therefore proceeded, and all ladder decisions
below were based only on deterministic-path results.

After rollback, the next legacy scan again wrote `usage_cap` and one model call at
`2026-07-21T12:03:09.511Z`. That later row is also legacy context, not evidence about
the deterministic path.

## Full-open cap 1

The atomic activation at `2026-07-21T11:47:32.639256Z` set:

- `intake_mode=deterministic`
- `deterministic_selection_mode=full_open`
- case cap 1
- both exact allowlists empty

Scheduled deterministic health was green at `11:53:01.750Z`: status `ok`, no degraded
reason and zero model calls. One bounded exception case accounted three correlated
sources. It was a loud MLB `adapter_parse_failure` for missing `client_name`, retained
no job or artifact, and had side effects suppressed.

A cap-1 diagnostic invocation returned HTTP 200 and a complete deterministic report:
zero unaccounted, zero write failures, zero AI calls, one case/source commit, and no
artifact, draft or job. The read correctly carried `source_read_capped` and
`source_sweep_partial` caveats, so it was not misrepresented as whole-window proof.

## Full-open cap 2

The `11:55` scheduled scan completed green:

- health `ok`
- zero model calls
- zero drafts and auto-files
- zero healed/live insert conflicts
- zero dropped work orders
- no artifact, draft or job count increase
- deterministic sweep cursor completed and reset

Production totals after the clean cap-2 observation were five cases, fourteen sources,
four artifacts, two deterministic drafts and zero case-linked jobs. The artifact and
draft totals were unchanged from before full-open activation.

## Full-open cap 5 anomaly

Cap 5 was set at `2026-07-21T11:56:04.441672Z`. The scheduled intake requests at
11:57, 11:59 and 12:01 each hit the scheduler's 5-second HTTP timeout. During this
period:

- deterministic health remained pinned to the `11:55:02.131Z` cap-2 scan
- business counts remained unchanged
- the deterministic cursor advanced without a corresponding completed health record

This is a deterministic-path scheduler/health-truthfulness anomaly. Per the captain's
stop rule, the cap was not increased again and authority was immediately returned to
legacy. A request that began before rollback continued far enough to move the cursor,
but it created no additional case, source, artifact, draft or job.

## Safe state and required follow-up

Production currently has `intake_mode=legacy`. The `full_open`, cap-5 controls remain
inert while legacy owns authority. To resume the ladder safely, first make scheduled
cap-5 execution compatible with the scheduler timeout or move the work behind a
quick-ack/leased worker boundary. A completed scheduled scan must update deterministic
health truthfully before cap 10 can be considered.
