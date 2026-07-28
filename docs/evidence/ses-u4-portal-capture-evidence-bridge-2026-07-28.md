# SES U4 portal capture evidence bridge

## Decision

`ops-api` does not launch Chrome. The approved `capture_portal_evidence.py`
runner remains an agent-side producer. It records its result through
`record_ses_portal_capture_evidence`; U4 consumes the resulting append-only
`makesafe_portal_capture_revisions` row and private screenshot.

This closes the production runtime binding without adding a browser stack to the
Supabase Edge Function.

## Producer request contract

The producer calls:

```text
POST /functions/v1/ops-api?action=record_ses_portal_capture_evidence
x-api-key: <privileged SW_API_KEY>
```

Body:

```json
{
  "job_id": "<uuid>",
  "attendance_cycle_id": "<current cycle uuid>",
  "role": "roof_report",
  "capture_result": "done",
  "source_url": "https://primeeco.tech/share/...",
  "source_content_hash": "sha256:<64 lowercase hex>",
  "builder_reference": "<canonical U4 builder reference, or empty string>",
  "captured_at": "2026-07-28T07:55:00.000Z",
  "captured_by": "<operator or agent identity>",
  "capture_producer": "capture_portal_evidence.py/v1",
  "capture_idempotency_key": "<stable per capture attempt>",
  "signal": "submitted-and-locked",
  "screenshot": {
    "media_type": "image/png",
    "content_hash": "sha256:<SHA-256 of exact PNG bytes>",
    "bytes_base64": "<exact PNG bytes>"
  }
}
```

Allowed roles are `roof_report`, `assessment`, `photos`, and `scope`. The
producer may submit `assessment_report` as an alias for `assessment`, and
`quote` as an alias for `scope`.

Allowed results are:

- `done`: the form is submitted and locked; PNG required.
- `not_done`: the form is reachable but not submitted/locked; PNG required.
- `unreachable`: the exact URL cannot be opened; PNG forbidden.

`source_content_hash` is the raw SHA-256 of the exact classifiable text passed
to the existing `classify()` function. Before classification and hashing, the
producer must normalize that text by converting CRLF and CR to LF and applying
Unicode NFC, then hash its UTF-8 bytes. Empty/unreachable rendered text therefore
uses the SHA-256 of the empty byte string. It is not the screenshot hash. The
screenshot hash is the raw SHA-256 of the decoded PNG bytes. The backend verifies
the PNG signature and byte hash, then creates a domain-separated aggregate hash
over every persisted capture field.

The producer must send the exact current `job_id`, `attendance_cycle_id`,
canonical `builder_reference`, typed role, and canonical source URL presented by
U4. `builder_reference` remains an exact-match field but may be empty when the
card already has a separate source-spine blocker; capture evidence must not be
held behind that unrelated fact. The endpoint rejects stale cycles, mismatched
references, unbound URLs, unapproved producer identifiers, invalid hashes, and
changed payloads that reuse an idempotency key.

The endpoint is API-key/admin-owner only and POST-only. It uploads a
content-addressed PNG under the private `makesafe-docket-artifacts` bucket and
commits the evidence revision through the service-role-only
`commit_makesafe_portal_capture_v1` RPC.

## U4 consumer contract

For every required portal role, U4 selects the newest evidence row that exactly
matches:

```text
job_id + current attendance_cycle_id + role + source_url + builder_reference
```

It verifies the aggregate revision hash. For `done`, it also downloads the tied
private PNG and verifies its byte count and SHA-256 before accepting the capture.
The docket evidence records `captured_by`, `captured_at`, `capture_producer`,
source URL, source content fingerprint, and evidence revision id.

When the row is absent U4 emits `portal_capture_missing`, naming the exact job,
cycle, role, and URL required. Corrupt or incomplete evidence emits
`portal_capture_invalid`. These replace the former bare
`capability_portal_degraded` blocker.

Cards with no required portal role do not invoke the capture resolver and retain
`portal_capture: not_required`.

## Agent-repo follow-up

The separate agent-repo task must update the approved Chrome runner to:

1. obtain the canonical U4 job/cycle/reference/role/URL tuple;
2. normalize the extracted PDF text before passing it to the existing
   classifier, then compute the two hashes exactly as defined above;
3. POST this contract with a stable idempotency key and truthful actor/time;
4. retry only with the same payload for the same key; and
5. run U4 again after the evidence revision commits.

No ES family matrix, assessment classification, or docket signoff surface is
changed by this bridge.
