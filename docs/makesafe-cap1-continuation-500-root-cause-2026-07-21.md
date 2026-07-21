# Make-safe cap-1 continuation 500 root cause, 2026-07-21

Structured evidence:

`docs/evidence/makesafe-cap1-continuation-500-root-cause-2026-07-21.json`

Production remained `legacy` throughout diagnosis and implementation.

## Finding

The post-response execution hypothesis is disproved. The `13:35` monitor invocation
returned HTTP 200 at `13:35:01.505Z`. Its `EdgeRuntime.waitUntil` continuation then:

1. started a separate `ops-api?action=scan_ses_makesafes` execution
2. ran for more than eight seconds
3. received the nested HTTP 500
4. logged `intake scan continuation status=500`
5. released the transferred mailbox lease at `13:35:09.884Z`

The platform did not terminate the background task. The continuation completed its
own error and settlement path exactly as designed.

## Exact failure

The nested ops scan logged its action at `13:35:01.705Z` and failed at
`13:35:09.847Z` in `readPersistedCases`. The failing PostgREST request selected case
state using:

```text
makesafe_intake_cases?instruction_key=in.(...)
```

The query contained a batch of roughly 200 long deterministic instruction keys. The
encoded GET URL crossed a reliable request boundary and the Supabase client returned
`TypeError: error sending request` before case attempts or health.

This explains all observed state:

- monitor HTTP 200 because mail sync and continuation registration succeeded
- lease held until the nested fetch settled
- nested ops scan HTTP 500
- no deterministic health because failure preceded `writeHealth`
- no cursor movement because the completion checkpoint correctly retained the page
- no business-count movement because case attempts had not started

## Fix

The runtime already had a URL-safe default `.in()` chunk size of 25 for long Graph
post IDs, but three case/lineage reads explicitly overrode it to 200. Those overrides
are removed. The following reads now use at most 25 filter values per request:

- external lineage-parent instruction keys
- persisted deterministic case instruction keys
- persisted case-source case IDs

The source input remains capped at 500, so splitting filters produces a fixed,
bounded number of requests per invocation. No timeout is raised and the continuation
or completion-checkpoint design is unchanged.

## Test boundary

A live-shaped full-open test builds 220 distinct deterministic instruction keys and
runs the live persistence path. It proves:

- all 220 cases reach persisted-state resolution
- the case-state read is split into nine requests
- no request contains more than 25 instruction keys
- cap 1 still attempts and commits only one case

The migration/static contract rejects restoration of the 200-key case-state batch.
The full deterministic suite must pass before `/no-mistakes`, merge and canonical
`ops-api` deployment. `monitor-ses-makesafes` does not require another code deploy for
this fix.
