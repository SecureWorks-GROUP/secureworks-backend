# Make-safe N=1 deterministic comparison

**Selected real email:** MLB-26443, received 2026-07-02  
**Manual card:** SWMS-26902  
**Selection reason:** recent inbound SES make-safe, one uploaded work-order PDF, linked live job still in the Allocated board column.

## Side-by-side

| Fact | Deterministic comparison | Existing manual card |
|---|---|---|
| Builder / claim | MLB, external reference found | ML Builders, MLB-26443 |
| WO / PO identity | Both found | Neither exposed in card lineage |
| Work-order PDF | Found | Source has one uploaded WO PDF |
| Site address | Found | Present, Navigate action available |
| Client name | **Missing** | Present |
| Phone | Not promoted because parse stopped | Present, Call and Text available |
| Result | **Exception: `adapter_parse_failure`** | Live job `SWMS-26902` |
| Board state | No automatic live job card; review case only | Allocated, `waiting_on_trade_report` |
| Work state | Not auto-created | Processing, two completed assignments, report not submitted |

## Verdict

The deterministic path correctly kept the three related source posts together as one case, reached the identity floor at 100%, found builder, claim, WO, PO, address and the designated PDF, and made zero live writes. It did **not** reproduce the manual card because it could not extract `client_name`; it would leave a visible reason-coded review exception instead of creating a live job.

The exact source allowlist resolved fully: one selected case, three correlated sources, zero unmatched source IDs, zero AI calls, and zero case/source/draft/job writes. The response's `source_read_capped` caveat concerns the surrounding 60-day aggregate window; the named source itself was fetched by exact ID as required by the runbook.

Activation remains `legacy`. This result is awaiting the Captain's explicit approval or rejection before any switch change.

## Evidence

- `docs/evidence/makesafe-n1-dark-observe-2026-07-21.json`
- `docs/evidence/makesafe-n1-manual-card-snapshot-2026-07-21.json`
- `docs/evidence/makesafe-n1-post-observe-db-state-2026-07-21.json`
