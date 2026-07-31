# SES Hugo notification and five-minute SLA v1

## Backend contract

The shared intake approval-settlement boundary notifies only when all of these
facts are true:

1. `makesafe_intake_job_mints` explicitly proves this draft minted the job;
2. the canonical make-safe server board contains that exact job;
3. the canonical board exposes a non-empty SES family, including physical,
   temporary fencing, roof report, assessment, repair, restoration, and quote
   request families;
4. the source is not a synthetic live-fire fixture; and
5. `arrival_general_phones` names one recipient whose phone resolves to exactly
   one staff user with `managed_verticals` containing `makesafe`.

The configured `makesafe_notify_settings.notify_enabled` kill switch and
`from_number` remain authoritative. No recipient phone is embedded in this
path.

`makesafe_intake_hugo_notifications` is the once-per-job audit boundary.
The row is claimed before GHL is called and records source IDs, canonical case,
job, board stage, attempt time, configured recipient, deep link, provider
message ID and acceptance time, or a durable failure reason. A unique collision
never causes a second dispatch. Transport failures and lost responses are not
automatically retried because provider acceptance cannot be disproved. Only
failures proven to occur before transport may reclaim the same job-keyed audit.
Legacy approved jobs, existing-job bindings, and later lifecycle updates have no
explicit mint authority and therefore remain silent.

Synthetic live-fire is rejected before board, configuration, audit, or SMS
work. Tests use injected transports or mocked `fetch`; they never call GHL.

## Honest health accounting

`intake_health.sla.logical_last_24h` reports one outcome per mature eligible
logical email:

- `job_on_board_within_300s`
- `terminal_non_work_fate_within_300s`
- `missed_or_late`

Canonical cases are the primary logical grain. Genuinely unaccounted source
rows are collapsed with the existing dual-capture identity and remain
`missed_or_late`; they do not disappear from a success-only percentile. Sources
inside their open five-minute window are reported as pending and enter the
denominator when the window closes. Synthetic fixtures are excluded.

Until an append-only clock spine stores first board observation, a currently
confirmed canonical-board job uses `jobs.created_at` as the synchronous server
visibility stop. The response names this basis explicitly. The same block
separately reports whether provider acceptance of the Hugo notification also
occurred within 300 seconds for physical jobs.

## Dashboard cache follow-up

The backend deep link is a URL fragment. It cannot invalidate the Trade app's
in-memory 90-second feed cache, so this PR does not claim the P1 cache fix.

The Trade dashboard must:

1. parse the exact job UUID from the fragment on initial load and `hashchange`;
2. invalidate or bypass the make-safe feed cache once for that UUID;
3. fetch the authenticated `makesafe_board&projection=trade` view under Hugo's
   existing JWT/profile, without widening authorisation;
4. retry that exact lookup on a bounded interval for no more than 30 seconds
   until the job is visible in `New` or `Allocated`; and
5. stop the forced refresh once found or once the bounded window expires.

This preserves the current security boundary while removing the 90-second cache
risk from notification-to-assignment.

## Release activation

Apply `20260729010000_makesafe_hugo_notification_sla_v1.sql`, then
`20260731000002_makesafe_intake_settlement_closure.sql`, before deploying the
matching `ops-api`. The ordered closure migration archives any older case-keyed
duplicates, installs job-key uniqueness, and adds explicit draft mint
authority. Development and validation send no real SMS.
