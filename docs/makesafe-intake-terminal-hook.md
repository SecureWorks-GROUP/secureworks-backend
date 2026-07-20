# Make-safe terminal intake-check hook

## Ruling and boundary

Captain ruling 5 requires production intake to run through deterministic code while
the paid AI extraction API stays off. AI enrichment is a future optional input, not a
condition for capture, classification, review visibility or job creation.

This document is the backend contract for the intake-check capability that the
make-safe terminal skill must call. It does not implement the separate Board/Hugo read
model or sender seam, and it does not grant a terminal routine approval, allocation,
invoice, send or client-contact authority.

## Three supported operators

### Automatic code

The scheduled path calls `scan_ses_makesafes`. When the DB authority is
`deterministic`, it runs only deterministic adapters and records `ai_calls=0`. The DB
case cap and exact source/instruction allowlists remain authoritative. No API key for a
paid extraction model is required or read by this branch.

### Terminal make-safe skill

The scoped routine credential may use this sequence during every board/reporting skill
run:

1. Call `intake_health`. Stop and surface the blocker unless `intake_mode`, alarm
   readiness and source-accounting truth are explicit.
2. Call `makesafe_new_emails` to discover candidate source post ids already held in the
   capture estate. Do not file source ids or source PII in skill logs.
3. For each approved check set, POST exact ids to
   `makesafe_deterministic_intake_dark_observe`. The response is sanitized and
   zero-write.
4. If a named DB rollout allowlist has separately been approved and configured, the
   routine may call `scan_ses_makesafes`. The routine cannot set or widen that DB
   allowlist. The scanner processes only those exact cases through deterministic code.
5. Re-read `intake_health` and `list_intake_drafts`; report confirmed, blocked,
   exception, non-WO, deferred and failed counts. Use `get_makesafe_email` only when a
   named review needs source evidence.

The routine may check and trigger deterministic processing, but it may not call
`approve_intake_draft`, change rollout settings, allocate, invoice, send, or contact a
builder/client. Existing route default-deny remains the authority boundary.

### Manual operator

A privileged operator may run the same health, discovery, exact dark-observe and scan
sequence. Existing intake-draft review remains the manual surface. Canonical
case-exception resolution must use the separately reviewed case/Board seam once it
lands; operators must not bypass case authority by creating an unrelated job from a
review-only exception.

## Exact dark-observe request

```http
POST /ops-api?action=makesafe_deterministic_intake_dark_observe
x-api-key: <scoped routine credential>
Content-Type: application/json

{
  "source_ids": ["<exact captured post id>"],
  "instruction_keys": [],
  "days": 60,
  "only_unscanned": false
}
```

One of `source_ids` or `instruction_keys` is required. Values must be exact, unique and
bounded to 50. Every value must resolve or the request fails closed.

The response guarantees:

- `dry_run=true`, `ai_enabled=false`, `ai_calls=0`;
- no database or storage write;
- no returned source id/key, message content, person, address, raw/canonical builder
  reference, attachment name or URL;
- hashed case handle, proposed state/reason, builder class, blocked/missing field names,
  lineage relation and identity-evidence booleans;
- explicit selection counts and zero-unaccounted/identity-floor aggregates.

## Review-case design

Deterministic code owns canonical classification. Confirmed or blocked cases may move
through the guarded unassigned-job path. Cancellation, duplicate, revision, unknown
builder, ambiguous scope, below-floor, parse-failure and conflicting-field outcomes
remain reason-coded review cases and never fall back to paid API extraction.

Until the separate canonical Board/Hugo seam makes those cases visible and safely
resolvable, production activation remains NO-GO. Merge is not deploy. This hook makes
the deterministic check/trigger contract available to automatic code, terminal skill
runs and manual operators without pretending the missing review UI or approval seam
already exists.
