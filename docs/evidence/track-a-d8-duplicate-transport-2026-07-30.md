# Track A D8: duplicate transport rows — sha256 dedupe and replay evidence

Date: 2026-07-30. Contract: `TRACK-A-INTAKE-DIFF-2026-07-30.md` (secureworks-wiki
PR 233), divergence D8. All production access was strictly read-only: SQL
SELECT probes via the management API, and two runs of the GET/HEAD-only
five-fates shadow replay (`scripts/replay-makesafe-five-fates.ts`, 70 days /
1,480 sources, run 2026-07-30) — one at the pre-fix planner, one at the fixed
planner. No cursor was advanced and no production row was written.

## The defect, measured

Dual capture stores one physical message twice — a Graph group post and a
mailbox message (`mailbox_<sha>` post id) — with byte-identical attachments
under distinct `email_attachments` rows. Ingest dedupes bytes per email only,
and group posts expose no `internetMessageId`, so the twins cannot converge on
any transport id. Probes (2026-07-30): 401 attachment content hashes appear
under more than one email row (840 rows); 363 groups are same-message twin
pairs (received within 120 s); 39 duplicated contents were owned by more than
one intake case, 33 across different lineages.

## The fix (one content hash feeds the planner once; both rows stay for audit)

- `email_attachments.sha256` now threads into `DeterministicAttachment` and
  `DeterministicPdfDocument` (runtime select, replay select, adapters).
- Sha-identical uploaded attachments are an authoritative correlation
  coordinate (same bucket family as thread/conversation/message ids), so a
  twin pair shares one lineage cluster even when only one twin's PDF made the
  extraction budget.
- Identity-less sources key their instruction by `content:<sha>` before
  falling back to the per-post key; instruction assembly keeps one PDF
  evidence entry per content hash (most-recovered copy wins) and stages one
  artifact per content hash.
- `enrichSourcesWithPdfText` spends the extraction budget once per content
  hash and shares only deterministic outcomes (extracted text, too-large,
  not-a-PDF); transient download/extraction failures are never shared.

Fixture tests: `supabase/functions/ops-api/makesafe_duplicate_transport_dedupe_test.ts`
(real production twin shape work_order_MLB-26219PO-53996; budget-starved twin;
identity-less twins; one download per hash; multi-PO WOs stay separate).

## Shadow replay: before vs after (same corpus, same day)

| Measure | Pre-fix planner | Fixed planner |
| --- | --- | --- |
| PDF documents extracted (of 596) | 50 | 96 |
| deferred | 546 | 500 |
| planner live_job | 166 | 184 |
| blocked_live_job | 11 | 17 |
| reason_coded_exception | 574 | 550 |
| accounted_non_work | 729 | 729 |

- Per-source diff: 24 sources changed fate, every one an improvement
  (18 exception -> live_job, 6 exception -> blocked_live_job); **0 sources
  degraded**. The mechanism is budget liberation: twins no longer double-spend
  the extraction budget, so 46 more documents extract and their sources reach
  the identity they always carried. 0 lineage assignments changed.
- Independent ground-truth catalogue matches are unchanged (14/36 planner
  matches before and after — the remaining gaps are D2-D7 territory).
- Twin-pair instruction convergence: 355 of 363 same-message twin groups plan
  as ONE instruction (the durable production ledger has 8 of these split
  across cases). The 8 replay non-convergences are all deliberate or
  out-of-scope: 5 are SecureWorks own-outbound copies that account per-post as
  non-work by design, and 3 are distinct-body double-sends (different email
  text, same PDF) whose resolution belongs to sibling divergences — MLB-25795
  (wo-vs-ref identity anchoring, D6/D7), MLB-24664 "RE:" material quote
  (revision semantics), MLB-25321 (same WO+PO with conflicting family
  evidence between the two bodies, D2). None of the 8 mints a duplicate
  deliverable: all are exception/non-work lane.

## D1 replay evidence (per the D1 evidence note)

In the fixed-planner replay of the full 1,480-source corpus, **zero** planner
verdicts carry a `po:BOX` or `po:SENT` identity. The two transport rows of the
historical SENT case (MLB-24481) plan as ONE instruction with fate
`reason_coded_exception` / `below_identity_floor` — the truth-set fate for a
claim-only chaser with no parseable PO — confirming the deployed v2 grammar
produces the corrected identity and the committed migration only has to repair
the stored historical rows.
