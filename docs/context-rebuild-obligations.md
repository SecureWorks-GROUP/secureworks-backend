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
