# PR 351 canonical deploy and stop report

## Outcome

`ops-api` was deployed from the canonical release worktree at merged `origin/main` commit `5ce103e6aed938ad6139e23f750fefa438e049f8`.

The function is production version 848 with `verify_jwt=false`. An authenticated diagnostic confirms:

- `source_repo=secureworks-site`
- expected build label is present
- runtime `commit_sha` exactly matches `5ce103e6aed938ad6139e23f750fefa438e049f8`
- all 67 required actions are recognised
- complete guarded smoke passes 9/9

## Anomaly and stop

The first guarded post-deploy smoke was invoked with `/Users/marninstobbe/kun-agent-workspace/state/.sw-api-key`. Captain records identify this as the deliberately unused rotated key retained for a future coordinated credential migration. Production had previously been restored to the older key embedded in active clients.

That first request therefore received HTTP 401. The smoke reported 6 passes and 3 failures because its action-recognition checks do not classify the application-level 401 response as an authentication failure. The failed exact-binary assertions were:

1. canonical source
2. build label
3. commit SHA

A diagnostic rerun using the active production client credential from `tools/shared/cloud.js` passed all 9 checks and proved the deployed binary. No key value was logged, copied into evidence or committed.

The deploy is technically verified, but the Captain's order was to stop on any anomaly. The sequence therefore stopped before deterministic activation.

## Production state

- `intake_mode`: `legacy`
- deterministic case cap: 1
- source allowlist count: 1
- instruction allowlist count: 0
- N=1 canary attempted: no
- full-live widening attempted: no

A fresh authorization is required to treat the credential-selection issue as resolved and resume at the exact N=1 canary.

## Evidence

- `docs/evidence/makesafe-pr351-deploy-stop-2026-07-21.json`
- deployed function list: `ops-api` version 848, `verify_jwt=false`
- runtime version response: commit `5ce103e6aed938ad6139e23f750fefa438e049f8`, deployed at `2026-07-21T09:55:50Z`
