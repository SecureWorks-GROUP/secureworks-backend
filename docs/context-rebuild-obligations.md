# TP-16: preserve unresolved notes before rebuilding

The 30 October real fence reread removed paid invoice debt but also lost a
recipient dispute and folded a separate confirmation request into a payment
item. Whole-generation item counts did not detect this loss. Rebuild packets
currently carry only person-locked notes; updates already receive unresolved
notes and can transition their exact keys.

`context_ledger_rebuild_packet(run_id, lease_token)` is an additive preparation
API for a **claimed, empty building rebuild**, before model writes. It snapshots
the current generation's open/disputed/info notes and all person corrections
into that building generation, preserving keys, opening evidence, closure
predicates and reply requirements. It returns the normal whole-history packet
with those same seeded notes. The existing writer can then close the payment
item without silently dropping unrelated matters. It never rewrites live notes.

The seed has an audit transition, not a new verification claim. A repeated call
does not reseed, duplicate notes or restore a payment item the writer closed.
Wrong/expired leases, wrong generation, switched-off extraction, prior model
writes and invalid/moved opening sources stop preparation. A person's correction
remains their authority. Access stays service-role only. Rollback removes only
the added API and retains evidence; stop any adopted caller before rollback.

## Delivery boundary

This migration alone is dormant. No current packet/claim/writer, reader model,
reader setting or production note changes. A consumer must deliberately use the
new API for rebuilds. No reader rollout or independent reader acceptance is
claimed by this database change.

The local contract exercises the real packet and writer: distinct payment,
confirmation and dispute, person closure, retry after paid correction, lease
refusal, unchanged live notes, moved-source refusal, restricted access. Its
planted fault removes the dispute from reader input and must fail. These are
synthetic SQL checks, not a model or signed-in staff journey.

Remaining integration work: wire the leased reader call, ensure its output
explicitly reconciles each seeded obligation, test real source correction through
reader/story/card and freshness, and obtain the existing independent acceptance.
This default snapshots the current generation; it does not automatically recover
notes already lost by an older rebuild. The observed fence case still needs a
source-backed recovery from its preserved prior generation, without restoring
paid debt. Invalid/moved prior sources are surfaced as a refusal; automated
placement correction and recovery are not proved by this API.

## Financial change scheduling candidate (30 October, unreleased)

Migration20261030112226 adds a service-only record packet containing the
record-only story and its existing record-sig-v1/money-sig-v1 source witness in
one statement snapshot. A reader persists the witness with successful output.
The separate `context_ledger_financial_refresh_v1` flag, absent/off by default,
lets the judge request a preserving whole rebuild when the current reading's
witness differs. Financial change takes priority over a new-message partial
update. Existing rollout, source-admission, budget, backoff and window rules
remain. The migration neither enables the flag nor changes reader settings.

Tests cover payment/reopen, cache touches, moved invoice effects on both jobs,
snapshot witnesses, access restrictions and missing/off behavior. A planted
constant signature must fail the financial-change test. The guarded rollback
restores the exact prior judge and removes only the added APIs. Stop the caller
and disable activation first. Required independent review and deployed proof
remain owed; current signature fields do not imply complete financial coverage.

## Current invoice facts beside preserved wording (30 October, unreleased)

The actual-model development replay preserved both old keys but retained a
present-tense owing claim inside the recipient dispute. Keeping the obligation
is necessary; presenting an old financial assertion as current is wrong.

Migration `20261030160000_context_note_current_invoice` changes the canonical
`context_job_story_ledger` read, shared by the story assembler and writer input.
For unresolved non-payment invoice matters it prefixes the exact same-job invoice
record's status/balance and explicitly labels the preserved note as historical
wording. The raw note stays byte-for-byte in `source_what`; stored rows, keys,
citations, person locks, statuses, and closure predicates never change. Payment
does not settle a confirmation request, recipient dispute, refund, or other
separate matter. The existing payment-obligation rules remain untouched.

`current_invoice_evidence` names the read's timestamp, exact invoice row, status,
balance and match resolution. Match by the complete invoice number or application
row ID only; no text/name/substring inference. Missing or ambiguous matches and
null balances remain Unknown. Held or invalid citations do not borrow this job's
financial evidence. This is the existing record snapshot, not a new provider
fetch, bank-settlement signoff or job cost-close.

The projection is live immediately upon an authorized migration, not behind the
financial-refresh flag. A subsequent source correction changes the next common
story read without a model rerun; the story hash changes so the existing writer
can rewrite through its ordinary queue/budget. It does not restore notes absent
from the live generation or prove queue/worker freshness. No caller or schema
change is required. The guarded rollback restores the exact old read and drops
only the helper, preserving all stored evidence.

The registered contract covers paid/reopened/moved sources, separate obligation
identity, unchanged raw rows, missing/ambiguous/null balances, held/person notes,
canonical story/writer parity and service-only access. A bypassed projection
must fail the negative contract; unknown preimage and exact rollback are tested.
Required independent database/money review, authorized rollout, actual lost-note
recovery, deployed source-to-card lag and reader/staff acceptance remain owed.

## Bounded historical omission recovery (operator candidate, unreleased)

A preservation rebuild alone cannot restore matters already absent from its live
source generation. `scripts/context-recover-rebuild-items.sql` defines two
session-local operator helpers, not permanent database APIs. Loading it performs
no recovery. The operation requires an owned, leased building rebuild, the exact
retired source generation, expected current live generation, and at most20exact
item keys with UTC row-MD5 preimages. Only unresolved non-payment model notes are
eligible. It copies their original identity/content/citations into the building
generation and leaves the current live reading and all financial rows untouched.

Preparation first invokes the normal preserving packet. Missing/changed source
rows, invalid or moved opening citations, a later exact decision/supersession,
a potentially duplicate same-kind obligation or related staff decision refuse
the entire statement. A closed model payment from the same message does not
replace a separately owed reply. Source messages and ledger rows are locked while
checked. Changed retry manifests are refused; identical retries recheck sources
without recreating closed items. The original source generation/key/hash and
recovery transition are retained for audit.

This is an operator recovery operation, not a generic historical-backlog replay.
Do not hand its prepared run to an ordinary worker or call unguarded finish.
`pg_temp.context_recover_rebuild_finish(request,meta)` repeats the source/staff
checks under the same locks as the normal finish and requires the reader's
financial witness still to match. It then invokes the ordinary finish and retains
the recovery manifest under the reader checks. An intervening source/staff/money
change prevents promotion; run a fresh read, do not override it. The helper does
not change global mode, flags, models or budgets.

Production still requires independent database/money review of this operation
and its prerequisite migrations, normal owned-claim authority, a supported SQL
execution route, a fresh read of the prepared packet and current source witnesses,
and authorized rollout/recovery. The old development answer is NOT a substitute
for that fresh read. A reviewable dry run must be enclosed in BEGIN/ROLLBACK;
only an explicitly authorized operation may COMMIT. No real job or lease tokens
are embedded in the repository. There is no production execution receipt yet.

Local proof: `psql -X -v ON_ERROR_STOP=1 -f
supabase/tests/context-recovery/recovery.sql` against the existing disposable
migration-stack database.13synthetic scenarios/37assertions use the actual
preparation, normal writer, guarded finish, current-generation read and rollback.
They include a new customer reply closing only its own confirmation, later staff
and financial changes, invalid source, exact-key recovery and retained provenance.
These are intervening-change tests, not a parallel-session race proof, model
quality, production restoration or independent acceptance. A deliberately ignored
staff-decision check is detected by the same tests.
