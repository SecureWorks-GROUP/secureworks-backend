# SES Reporting U4 build evidence — 2026-07-27

Sections read before implementation:

- U4 design: full document, sections 0–18; implementation contracts applied from §3, §4, §5, §6, §7, §8, §12 and §13.
- Sealed mission contract: §2a family recipes; §3 unit U4; checkpoint CP3; seal/hold records affecting assessment and timing.
- North Star: Stage D, “Captain’s Docket.”
- Working wiki mirror used: `/Users/marninstobbe/Projects/secureworks-wiki` (not the pinned runtime copy).
- Sealed contract SHA-256: `d076dedb8e5c92932ae386084dac256d9bc1c02668acd760b0eaba34aef95d52`.

## Outcome

This change builds the deterministic U4 assembler core. One function,
`prepare_ses_docket_revision`, accepts only a job/job-number/batch selection
plus an idempotency key.
It obtains the complete `ses.assembler-input/v1` envelope through one resolver;
callers cannot pass hand-composed family, deliverable, routing or portal-status
fields into the command.

For each real (`dry_run:false`) build it produces one content-addressed
pre-Xero revision containing:

- the source work order and designated source attachments;
- the v2 manifest inside the v3 correlation-spine envelope;
- the applicable SecureWorks report, roof report and/or SWMS artifacts;
- every current-cycle photo byte plus the complete ordered photo map for
  physical work only;
- live portal-capture evidence and screenshots where the family requires them;
- a local invoice proposal;
- only the family-applicable draft email slots;
- the Captain review spec/HTML, an inert release proposal, capability evidence,
  timing evidence and hashes.

The internal revision and append-only artifact store retain the complete PDF and
photo bytes. A physical `dry_run:true` is deliberately lighter: it downloads
each current-cycle photo only long enough to calculate its raw SHA-256, discards
the bytes before moving to the next photo, and returns ordered proof records
containing the photo id, caption, hash, byte size, media type and intended pack
path. It does not base64-encode photos or invoke the PDF renderer. The real
non-dry pack build remains the only path that embeds and persists those bytes.

The `prepare_ses_docket_revision` HTTP response is a bounded proof envelope:
each artifact exposes only its role, path, media type, SHA-256, byte size and
metadata. Callers never receive raw bytes in JSON.

The append-only persistence migration adds the private artifact bucket, revision
and artifact ledgers, a current-revision view, and one idempotent commit RPC. The
SQL wall rejects any revision whose envelope or release proposal grants invoice,
authorise, send, SMS or close authority. RLS and grants restrict the ledgers/RPC
to `service_role`.

## What the Captain gets

On this branch, the Captain gets the docket below whenever the single assembler
function is invoked through the versioned `ses.assembler-input/v1` adapter. This
change also supplies the production read-model adapter and ops-api/skill
binding; the deployed Captain surface does **not** change until a separately
approved deployment.

For a ready physical docket the Captain sees the WO, completion report, every
current-cycle photo, the explicit SWMS decision/artifact, a local invoice
proposal, and three separate report/photo/invoice drafts on one review page.

For an ordinary roof docket the Captain sees the WO, the captured live portal
state, screenshot and exact link, plus the local storey-price proposal. There is
no invented local completion report and no physical photo section.

For an own-template/strata roof docket the Captain sees the WO and the
SecureWorks roof PDF rendered only from trade-authored facts, plus the local
storey-price proposal. Portal obligations are named not-applicable.

For temporary fencing the physical recipe is retained and typed panel/base
counts are mandatory. MLB and Western use their explicit hire-card rows; AJS
and AJBR use their labour-only rows.

AJS 70062 is fixed as a physical make-safe: “tarp affected areas of water
leaking” produces the completion-report/photo/SWMS-decision/invoice-proposal
recipe. Any AJS/AJBR input claiming a report-only roof or assessment family is
rejected with `ajs_misclassified_as_roof_report`; it is never silently rerouted
and produces no fallback report, photo, invoice proposal or email draft.

## Repeatability proof

The assembler canonicalises JSON with Unicode NFC, code-point key ordering,
finite-number enforcement and explicit-null rules. Revision identity and output
content hashes are domain-separated SHA-256 values. Artifact hashes cover bytes,
and the append-only commit RPC rejects an idempotency key reused with different
input or output hashes.

Two independent fixture runs with the same input and intent produced identical
revision IDs, output hashes and artifact hash lists. Every shippable row in the
11-row matrix has a ready golden and an intentional stale-matrix negative
golden. The assessment row retains an intentional blocker golden because the
original fixture predates the sealed recipe and lacks the required live portal
proof.

## Family coverage

| Builder | Physical | Temporary fence | Ordinary roof portal | Own-template roof | Assessment |
| --- | --- | --- | --- | --- | --- |
| MLB | ready golden | ready golden | ready golden | ready golden | intentionally blocked |
| AJS | ready golden | ready golden | rejected by rule | rejected by rule | rejected by rule |
| AJBR | ready golden | ready golden | rejected by rule | rejected by rule | rejected by rule |
| Western | ready golden | ready golden | closed/unsealed class | closed/unsealed class | closed/unsealed class |

Restoration is now a first-class SES family, but it is intentionally outside the
builder recipe rows until the Captain seals its reporting recipe. A canonical
restoration card is retained as typed input and returns the reason-coded
`restoration_recipe_unsealed` blocker with its real card facts; it does not select
a report, pack, portal, SWMS, pricing, invoice proposal or outbound draft.

The original assessment fixture blocked report/photo/invoice draft sets with
`assessment_recipe_unapproved`. That historical negative is superseded by the
sealed `assessment-triad-invoice-only/2026-07-27` recipe; current assessment
cards remain fail-closed only when their work order, typed Prime links, or
screenshot-backed locked captures are missing.

## Portal truth

Portal families cannot become ready without the capture adapter opening every
typed link. `done` is accepted only with tied JSON **and screenshot** evidence;
`not_done` blocks with
`portal_not_submitted`; network/runner failure blocks with
`portal_unreachable`; mismatched job/docket/reference/URL blocks with
`portal_wrong_reference`; unavailable capture capability blocks with
`capability_portal_degraded`. No persisted portal timestamp or prose is accepted
as a substitute for that read.

The tests prove invocation and all fail-closed mappings with deterministic
capture fixtures. A credentialed staging/live browser run was not performed in
this no-production-mutation lane, so real portal latency and selectors remain a
staging validation item.

## Five-minute promise

The per-job clock starts before input resolution and stops after the append-only
commit returns. It includes resolver reads, source recovery, portal capture,
rendering, proposal construction, validation, artifact storage and the commit
RPC. Ready and reason-coded blocked revisions both stop the clock. Batch jobs run
in parallel; one job’s stages remain sequential.

`TIMING.json` records accepted/committed timestamps, total duration, T0–T12
durations, retries and degraded capabilities. The response records count, max
and P95. The deterministic 20-job synthetic-clock boundary holds max and P95
between 250 and 300 seconds, with all 20 below the hard five-minute ceiling.

The hard result is `duration_ms <= 300000`; one over-budget job makes the batch
summary false. This is a CI boundary proof, not a substitute for the required
credentialed staging wall-clock run with real portal and storage I/O.

### Physical dry-run resource boundary

The first production proof of the 11-photo MLB-26267 card exposed two synchronous
memory spikes before the HTTP adapter could return: the old canonical byte-array
artifact hash peaked at about 247 MB RSS for the real 5.75 MB photo set, while
base64 conversion plus jsPDF rendering peaked at about 218 MB RSS. The deployed
edge worker returned `WORKER_RESOURCE_LIMIT`.

The proof-only SHA-256 loop over those same 11 real files completed locally in
18 ms, produced 1,532 bytes of proof JSON, and peaked at about 82 MB RSS. The
regression fixture uses the real 11-file size distribution and proves that a
dry-run never calls the retained-byte resolver or renderer, emits all 11
id/caption/hash proofs, contains no raw-byte field and remains below 100 kB.

## Where the wall sits

The wall is before invoice creation and release:

1. U4 creates only `ARTIFACTS/invoice_proposal.json`; it has no Xero identity.
2. The TypeScript dependency surface contains no Xero, mail/SMS, board or
   closeout capability.
3. `release_payload.json` fixes `invoice_create_approved`,
   `client_send_approved`, `create_invoice`, `authorise_invoice`, `send_email`,
   `send_sms` and `close_job` to `false`.
4. The persistence check constraint enforces those values again and rejects a
   local proposal containing `xero_invoice_id`.
5. The static/runtime tripwire verifies the assembler does not call the retired
   draft-pack, invoice-create or send paths and that persistence invokes only
   private artifact storage plus `commit_makesafe_docket_revision_v1`.

Nothing in this change creates any Xero object, sends anything to a builder,
mutates operational board state, changes a job, closes work, applies a migration,
schedules a cron, deploys, merges or touches production. The shared board
read-model overlay may project a ready U4 revision as pre-Xero Docs Ready; it
does not write the board or job state.

## Validation

- `deno check` passed for all five new TypeScript surfaces.
- `deno fmt --check` passed.
- `deno lint` passed on the new surfaces.
- Targeted U4 suite: 15 passed, 0 failed, including full photo-byte recovery,
  missing-photo rejection and submitted-without-screenshot rejection.
- Required root gate:
  `deno check --config deno.jsonc supabase/functions/ops-api/index.ts` passed.
  This includes the two separately authorised annotation-only baseline repairs:
  `monitor-ses-makesafes/index.ts:2100-2107` and `ops-api/index.ts:16904`.
- `deno task test:ops-api` still stops during test-file type-checking on five
  existing errors outside U4
  (`makesafe_intake_recapture_test.ts`,
   `makesafe_submit_report_test.ts` twice, and
  `monitor_ses_makesafes_test.ts`). The runtime-only whole directory run then
  recorded 2,152 passed and 26 failed; the failures are existing attendance
  cycle/U3 fixture drift and no U4 test failed. The remaining listed
  files/routes were not changed.

## Release truth and live invocation binding

The follow-up live binding registers `prepare_ses_docket_revision` in
`ops-api/index.ts`, adds it to the reporting-routine default-deny allowlist and
deploy required-action manifest, and supplies the canonical
`ses.assembler-input/v1` adapter in `ses_assembler_input_adapter.ts`.

### Assessment recipe addendum — 2026-07-27

The Captain subsequently sealed assessment as
`assessment-triad-invoice-only/2026-07-27`. The intentional assessment hold
described above is therefore superseded: the ready recipe is work order + typed
Prime assessment/photos/quote-or-scope links + screenshot-backed locked captures
for all three + the fixed assessment invoice proposal. It produces one invoice
draft and no SWMS, local report, or separate photo draft. Human-only portal
confirmation cannot satisfy the assessment floor.

Callers provide a card selector, never a hand-authored envelope:

```bash
curl -sS -X POST \
  -H "x-api-key: $SW_API_KEY" \
  -H "Content-Type: application/json" \
  "https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/ops-api?action=prepare_ses_docket_revision" \
  --data '{
    "selection":{"mode":"job_number","job_number":"SWMS-26980"},
    "idempotency_key":"proof-swms-26980-20260727",
    "dry_run":true,
    "force_refresh":true
  }'
```

The adapter uses the shared U2 cycle-evidence helpers and exact live card facts.
It does not invent a missing U1 source/version/hash, family classification,
portal capture, storey price, HR-CW classification or assessment recipe. Missing
facts therefore return the named U4 blockers. For the sanitized SWMS-26980
production snapshot this is a deterministic HTTP-200 dry-run envelope with no
persistence call and the specific source/lineage and `family_unknown` blockers.

`dry_run:false` uses only the existing append-only U4 revision/artifact
persistence. The shared server board read overlays a current ready revision as
pre-Xero Docs Ready without creating an invoice; blocked revisions stay in Trade
Report In and expose their blockers. No job, substatus, assignment, invoice or
communication row is mutated.

The backend still does not pretend it can inspect a Prime SPA: real portal
screenshots remain owned by the approved agent-side
`capture_portal_evidence.py` runner. Until that capture capability is bound into
a run, portal cards fail closed as `capability_portal_degraded`; assessment
cards otherwise use the sealed recipe above and fail only on missing evidence.
