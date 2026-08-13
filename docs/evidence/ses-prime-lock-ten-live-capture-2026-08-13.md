# Prime portal lock capture: ten Allocated cards (2026-08-13)

## Scope and safety boundary

This run inspected the ten Captain-named cards after releases 703/704:

`SWMS-26853`, `SWMS-26759`, `SWMS-26748`, `SWMS-26740`, `SWMS-26732`,
`SWMS-26728`, `SWMS-26857`, `SWMS-26852`, `SWMS-26736`, and `SWMS-26735`.

The sanctioned `capture_portal_evidence.py` script opened all current Prime
share URLs headlessly with Python 3.12. It produced 31 full-page PNGs between
2026-08-13 18:27:08 and 18:29:32 AWST. No mint, send, contact rewrite, skill
rewrite, stage mutation, or synthetic capture was performed. The live share
URLs and screenshots remain outside git because they contain bearer-style
tokens and client detail.

## Live result

| Card | Fresh portal proof | U4 record gate | Board proof |
| --- | --- | --- | --- |
| SWMS-26853 | EXPIRED: assessment + scope; LOCKED: photos | The locked photo already has a canonical screenshot-backed `done` revision; no new capture requested | Allocated / `awaiting_portal_completion` |
| SWMS-26759 | EXPIRED: assessment + roof report + scope; LOCKED: photos | `portal_wrong_reference`; no capture may be bound | Allocated / `awaiting_portal_completion` |
| SWMS-26748 | EXPIRED: assessment + photos + scope | Existing unreachable revisions; no new capture requested | Allocated / `awaiting_portal_completion` |
| SWMS-26740 | EXPIRED: assessment + photos + scope | Existing unreachable revisions; no new capture requested | Allocated / `awaiting_portal_completion` |
| SWMS-26732 | EXPIRED: assessment + photos + scope | Existing unreachable revisions; no new capture requested | Allocated / `awaiting_portal_completion` |
| SWMS-26728 | EXPIRED: assessment + photos + scope | Existing unreachable revisions; no new capture requested | Allocated / `awaiting_portal_completion` |
| SWMS-26857 | EXPIRED: assessment | Existing unreachable revision; no new capture requested | Allocated / `awaiting_portal_completion` |
| SWMS-26852 | EXPIRED: assessment + photos + scope | Existing unreachable revisions; no new capture requested | Allocated / `awaiting_portal_completion` |
| SWMS-26736 | EXPIRED: assessment + photos + roof report + scope | `portal_wrong_reference`; no capture may be bound | Allocated / `awaiting_portal_completion` |
| SWMS-26735 | EXPIRED: assessment + photos + roof report + scope | `portal_wrong_reference`; no capture may be bound | Allocated / `awaiting_portal_completion` |

Aggregate fresh classification: **29 expired**, **2 present_locked**, zero
unsubmitted, absent, or indeterminate. Every card has at least one expired
required role, so no card has a complete portal lock set and none can honestly
advance to TRI or DR.

The post-capture `makesafe_board&fields=full&columns=all` read was generated at
2026-08-13T10:30:28.017Z. It placed all ten cards in `allocated`, with
`has_current_portal_capture: false`, exactly as the 701/704 capture gate
requires for these incomplete/expired role sets.

## Authentication diagnosis

The initial dry run returned HTTP 401 because the local capture script reads
`SW_API_KEY`, while the sourced operator environment also carries the narrower
`MAKESAFE_ROUTINE_KEY`. The deployed backend already has the required scoped
route authority from PR #678: `prepare_ses_docket_revision` and
`record_ses_portal_capture_evidence` are routine-allowlisted, and the recorder
handler accepts `authMode === 'routine'` while preserving producer, PNG, hash,
cycle, role, URL, and reference checks.

The live run therefore mapped `MAKESAFE_ROUTINE_KEY` into the script's existing
`SW_API_KEY` transport input for that process only. This resolved the 401
without widening backend authority or editing the reporting skill. The
SWMS-26759, SWMS-26736, and SWMS-26735 dry runs then reached U4 and returned the
business-level `portal_wrong_reference` refusal, proving authentication was no
longer the blocker.

## Verification

- Live read: `makesafe_prime_capture_sweep&limit=500` at
  2026-08-13T10:26:24.222Z supplied the canonical job IDs, roles, current source
  URLs, and prior capture revisions.
- Fresh capture: 31/31 URLs produced non-empty PNG proof; manual inspection
  confirmed both the Prime expired page and the locked Photo Schedule banner.
- U4 dry run: all ten cards were queried through
  `prepare_ses_docket_revision`; no eligible new lock record was returned.
- Board read: all ten remained Allocated after capture; no placement was faked.
- Targeted tests: 24 passed, 0 failed across
  `ses_portal_capture_evidence_test.ts` and `ops_api_operator_auth_test.ts`.

## Stop condition

No `--apply` call was made. The two locked observations were either already
persisted for the correct card/cycle/role (SWMS-26853 photos) or refused by U4's
reference-correlation gate (SWMS-26759 photos), and neither card had a complete
lock set. Applying an expired or correlation-refused result would not move a
card and would violate the instruction to record only verified done locks.
