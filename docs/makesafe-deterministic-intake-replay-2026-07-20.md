# Deterministic make-safe intake replay evidence

**Run:** 2026-07-20T00:53:09Z  
**Mode:** local code against production read-only data access  
**Window:** 60 days, `makesafe_scanned_at IS NULL`  
**Writes:** none  
**AI calls:** 0

The replay used the production `emails`, `email_attachments`, and active
`makesafe_companies` evidence through the local deterministic runtime with
`dryRun=true`. It returned aggregates only. No message body, source identifier,
attachment URL, secret, address, client, or contact data was logged or filed.

## Totals

| Measure | Count |
|---|---:|
| Source emails | 1,155 |
| Planned canonical cases | 889 |
| Confirmed canonical inputs | 265 |
| Visible blocked inputs | 0 |
| Reason-coded exceptions | 493 |
| Accounted non-work/chatter | 397 |
| Unaccounted | 0 |
| AI calls | 0 |
| Case rows created | 0 |
| Drafts created | 0 |
| Jobs created | 0 |
| Write failures | 0 |

## Builder and outcome

| Builder | Confirmed | Blocked | Exception | Non-work |
|---|---:|---:|---:|---:|
| MLB, including Prime wrapper | 265 | 0 | 344 | 169 |
| AJS/AJBR, one company profile | 0 | 0 | 110 | 203 |
| Unknown | 0 | 0 | 39 | 25 |
| RAPID | 0 | 0 | 0 | 0 |

## Aggregate exception reasons

| Builder | Reason | Count |
|---|---|---:|
| MLB | below identity floor | 121 |
| MLB | conflicting fields | 92 |
| MLB | required deterministic artifact/capture incomplete | 129 |
| MLB | cancellation | 2 |
| AJS/AJBR | below identity floor | 110 |
| Unknown | unknown builder | 39 |

## Verdict

The no-write and zero-unaccounted proofs pass. The current visible source backlog does
**not** prove the contract's 95% known-builder deterministic coverage threshold. The
shortfall remains visible and reason-coded rather than being promoted with claim-only,
conflicting, or incomplete evidence. The package must not be described as cutover-ready
from this replay alone.

No overlap was found with open backend PR 334. That PR changes `ops_summary` calendar
projection and pipeline pricing JSON paths. This package touches neither query. Its own
reads use named columns, 500-row pagination, and 25-ID attachment batches, with no
`scope_json`, `pricing_json`, or list/feed `select('*')` transfer.
