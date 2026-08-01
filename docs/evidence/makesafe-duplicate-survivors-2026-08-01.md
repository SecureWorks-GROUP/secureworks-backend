# Make-safe duplicate survivors — re-verification and adjudication (2026-08-01)

Captain ruling under adjudication: in each both-live duplicate group the card
carrying the builder PO survives; the other is archived on the display ledger
with a pointer to the survivor. Where the PO rule cannot decide, the pick is
delegated to card-activity evidence and the reasoning is recorded.

Nine groups were nominated (`ses-shadow-adjudicate-v1/report.md` §1.3 of
`board-correctness-adjudicate-v1/report.md`, plus the `board-drain-blocked-fixes-v1`
`RESOLVED-NEEDS-CAPTAIN` overlap). Each was re-verified against production before
any plan was written.

## Headline: the PO rule decides none of the nine

Two findings, both material, both contradicting the premise the ruling was
written against:

1. **Five of the nine groups are not duplicates at all.** Their members resolve
   *different* builder POs, and each PO's work-order PDF declares a *different*
   instruction. They are distinct jobs that share a claim reference and a street.
   Per the task's own instruction these are skipped, not archived.
2. **In all four genuine duplicate pairs, both cards carry the identical builder
   PO.** So "the card carrying the builder PO survives" does not discriminate
   anywhere. Every survivor below is an activity-evidence pick, not a PO pick.

The nominating audit union-found cards by *shared PO token*. Where one card had
two work-order PDFs attached, that transitively merged cards belonging to two
separate instructions into one apparent "group". That is the source of the error.

## Method

For each nominated card, three independent reads against production:

- `job_documents` rows of `type='work_order'`, parsed for the canonical PO in the
  filename — the same anchor production uses
  (`makesafe_builder_work_order_identity.ts`, pinned by
  `makesafe_bwcwa6781_filename_po_fixture_test.ts`).
- The extracted PDF text for each of those POs, read for its declared
  instruction type (`Assessment Report & Quote` / `Roof Reports` /
  `Makesafe/Emergency Repairs`).
- Activity counts: assignments, service reports, media, invoices, calendar
  events, job events.

A group is a genuine duplicate only when its members resolve **one** PO whose PDF
declares **one** instruction.

## Verdicts

| # | Ref | Verdict | Survivor | Archived |
| --- | --- | --- | --- | --- |
| 1 | MLB-25625 | duplicate **after narrowing** | SWMS-26736 | SWMS-26998 |
| 2 | MLB-26190 | **skip** — not duplicates | — | — |
| 3 | MLB-25795 | **skip** — not duplicates | — | — |
| 4 | MLB-26183 | **skip** — not duplicates | — | — |
| 5 | MLB-25765 | **skip** — not duplicates | — | — |
| 6 | MLB-26189 | duplicate | SWMS-26787 | SWMS-26791 |
| 7 | MLB-23067 | duplicate | SWMS-26845 | SWMS-26920 |
| 8 | MLB-26344 | duplicate | SWMS-261065 | SWMS-261118 |
| 9 | MLB-26072 | **skip** — not duplicates | — | — |

### PO → declared instruction

```
MLB-25625  PO-54006 Assessment Report & Quote   PO-54007 Roof Reports
MLB-25765  PO-54176 Assessment Report & Quote   PO-54177 Roof Reports
MLB-25795  PO-53893 Assessment Report & Quote   PO-53896 Roof Reports
MLB-26183  PO-53995 Assessment Report & Quote   PO-54000 Roof Reports
MLB-26190  PO-53964 Makesafe/Emergency Repairs  PO-53966 Roof Reports
MLB-26072  PO-53696 Makesafe/Emergency Repairs  PO-53698 Roof Reports
MLB-26189  PO-54425 Assessment Report & Quote   (single instruction)
MLB-23067  PO-54811 Makesafe/Emergency Repairs  (single instruction)
MLB-26344  PO-57087 Makesafe/Emergency Repairs  (single instruction)
```

### The four archives

Activity counts are `assignments / reports / media / invoices / calendar / events`.

**1. MLB-25625 (Usher) — survivor SWMS-26736, archive SWMS-26998**

This group was nominated as three cards. `SWMS-26851` is the *assessment* card
(family `assessment_report_quote`, its only work order is PO-54006 "Assessment
Report & Quote") and is **not** a duplicate — it is removed from the group and
left untouched. The roof instruction (PO-54007) produced two cards:

```
SWMS-26736  4 / 0 /  0 / 1 / 4 /  8   roof_report, created 2026-06-21
SWMS-26998  1 / 0 /  0 / 0 / 1 /  6   roof_report, created 2026-07-17
```

SWMS-26736's four completed assignments name the work explicitly ("Roof report,
flexible, external" and "Tue list - 9 Keen Court, Usher (12-4PM)") and it carries
the invoice. SWMS-26998 is a later re-mint with one unworked assignment, no
invoice, no report, sitting at `company_contact_required`.

**2. MLB-26189 (Dalyellup) — survivor SWMS-26787, archive SWMS-26791**

One instruction, PO-54425. Both cards resolve it and both are
`assessment_report_quote`.

```
SWMS-26787  2 / 0 /  0 / 1 / 2 / 10   created 2026-06-24
SWMS-26791  2 / 0 /  0 / 0 / 2 /  8   created 2026-06-24
```

SWMS-26787's assignments were created 2026-06-25 for 2026-06-26 12-4PM, matching
the work order's own appointment block ("Date: 26/06/2026 Time: 12:00PM AWST -
04:00PM AWST, 14 Murtin Rd, Dalyellup"). It also carries the invoice and the
second document. SWMS-26791's assignments were created 2026-06-29 and
back-scheduled onto that date ("Make-safe run (last week) - back-scheduled").

**3. MLB-23067 (Queens Park) — survivor SWMS-26845, archive SWMS-26920**

One instruction, PO-54811 "Makesafe/Emergency Repairs". Both cards `scheduled`,
both `general_makesafe` — this is one of the two groups the captain flagged for
an evidence pick, and the evidence is one-sided.

```
SWMS-26845  2 / 1 / 13 / 2 / 2 / 22   created 2026-06-29
SWMS-26920  1 / 0 /  0 / 0 / 1 /  6   created 2026-07-06
```

SWMS-26845 carries the entire delivery: two completed assignments (one noted
"2hr temp fence"), a submitted service report, 13 media and two invoices.
SWMS-26920 has a single still-`scheduled` assignment and nothing else.

**4. MLB-26344 (Munster) — survivor SWMS-261065, archive SWMS-261118**

One instruction, PO-57087 "Makesafe/Emergency Repairs". Both cards carry that
same work-order PDF.

```
SWMS-261065  1 / 1 / 9 / 0 / 1 / 12   external_ref MLB-26344,          created 2026-07-27
SWMS-261118  0 / 0 / 0 / 0 / 0 /  1   external_ref MLB-26344PO-57087,  created 2026-07-31
```

**This group contains the sharpest trap in the set.** SWMS-261118's
`external_ref` *string* is the fuller `MLB-26344PO-57087`, so reading the PO rule
off the reference field alone would archive the wrong card — SWMS-261118 is an
empty re-mint with zero assignments, reports, media and calendar events.

Two independent signals select SWMS-261065:

- Activity: it holds the completed assignment, the submitted report and all 9 media.
- The deterministic intake's own canonical case for identity
  `wo:MLB-26344/po:PO-57087` is `confirmed_live_job` bound to **SWMS-261065**.

### The five skips

**MLB-26190 (Kardinya)** — three cards, two instructions, and the pair that
would match is already resolved:

```
SWMS-26706  WO PO-53964 (Make Safe)               processing
SWMS-26774  WO PO-53966 (Roof Reports)            ARCHIVED already
SWMS-26957  WO PO-53964 + PO-53966                processing
```

SWMS-26706's assignment reads "make-safe ceiling + tarp roof", matching PO-53964.
The canonical intake case for MLB-26190 is `confirmed_live_job` against
SWMS-26774, which is already archived. So the two live cards carry different
instructions and there is no both-live duplicate pair here.

**MLB-25795 (Eaton)**, **MLB-26183 (Glen Iris)**, **MLB-25765 (Myalup)** — the
same shape in each: one `roof_report` card and one `assessment_report_quote`
card, against a reference carrying one assessment PO and one roof PO. Both cards
have *both* work-order PDFs attached, which is what made them look like
duplicates; their families and their POs say they are two legitimate jobs.

```
MLB-25795  SWMS-26721 roof_report   SWMS-26855 assessment_report_quote
MLB-26183  SWMS-26735 roof_report   SWMS-26852 assessment_report_quote
MLB-25765  SWMS-26759 roof_report   SWMS-26853 assessment_report_quote
```

**MLB-26072 (Sorrento)** — SWMS-26657 resolves PO-53696 (general make-safe) and
SWMS-26660 resolves PO-53698 (roof). This independently confirms
`board-drain-blocked-fixes-v1`, which had already classified both as
`RESOLVED-SAFE / not_duplicate`.

### PDF-proven pairs deliberately left untouched

`board-drain-blocked-fixes-v1`'s `RESOLVED-NEEDS-CAPTAIN` class contains six
duplicate pairs: `SWMS-261057/261081`, `SWMS-26728/26856`, `SWMS-26740/26859`,
`SWMS-26748/26858`, `SWMS-26755/26844`, `SWMS-26819/26871`. **None overlaps the
nine nominated groups**, so per the ruling's scope none is touched here. They
still need their own captain decision.

## Mechanism

- Migration `20260801045000_makesafe_duplicate_survivor_archive.sql` extends the
  existing append-only `makesafe_board_status_applications` ledger with nullable
  `duplicate_of_job_id` / `duplicate_of_job_number` / `duplicate_rule` /
  `duplicate_evidence` columns. No second board-status engine is added.
- RPC `apply_makesafe_duplicate_survivor_archive` is service-role only and
  refuses: a terminal or stale loser, a terminal **or archived survivor** (so an
  archive can never strand work), a self-pointer, a pointer chain, and any batch
  over 50 rows.
- ops-api action `makesafe_duplicate_survivor_archive` is API-key only and
  **dry-run by default** — a live run requires `dry_run: false` plus explicit
  `group_keys`, `run_key`, `applied_by` and `evidence_ref`. It refuses to write
  if the plan contains any skipped group, and after writing it re-reads the board
  to confirm each loser displays `archive` and each survivor is still live.
- The authorized list is closed: `MAKESAFE_AUTHORIZED_DUPLICATE_GROUPS` in
  `makesafe_duplicate_survivor.ts` is the entire permitted surface. There is no
  discovery step, so no card that was not adjudicated here can ever be archived
  by this path.

Nothing in this path writes `jobs`, `makesafe_job_details`, assignments,
invoices, events or communications, and it deletes nothing. **No communication of
any kind results from it.**

## Release sequence

Migration first, per `docs/project-knowledge/EDGE_DEPLOY_LANE.md`:

1. Apply `20260801045000_makesafe_duplicate_survivor_archive.sql`.
2. Deploy `ops-api` from the authorized release worktree only
   (`scripts/deploy-edge-function.sh ops-api`).

> **Renumbered 2026-08-01.** The migration originally shipped as
> `20260801000001`. Production already held an out-of-band migration of a
> different name at that exact version (`makesafe_source_job_links`), so the
> production deploy run for PR 457 failed closed on a `ledger version/name
> collision` before applying anything or deploying any function — production has
> neither the pointer columns nor this `ops-api`. The SQL is byte-identical to
> the reviewed file (`sha256 85f12ef63136c998bdff2afcfd38ca6e1d73da908f4aaae1e5a7215557a6ebc5`);
> only the version changed. Steps 1 and 2 therefore both run from the merge of
> the renumbered branch to `main`.
3. The completed release sequence is recorded in the execution record below.
   Any future tranche must use a fresh dry run and confirm its exact archive
   count with zero skips:

   ```bash
   curl --fail-with-body -sS -H "x-api-key: ${SW_API_KEY}" \
     -H 'content-type: application/json' \
     "${MAKESAFE_OPS_URL}?action=makesafe_duplicate_survivor_archive" \
     --data '{"dry_run": true, "group_keys": ["mlb-25625-roof",
              "mlb-26189-assessment", "mlb-26344-makesafe"]}'
   ```

4. Only then, with the captain's confirmation of the picks, apply the selected
   tranche:

   ```json
   {
     "dry_run": false,
     "group_keys": ["mlb-25625-roof", "mlb-26189-assessment",
                    "mlb-26344-makesafe"],
     "run_key": "makesafe-duplicate-survivors-20260801-tN",
     "applied_by": "captain-approved-duplicate-survivors",
     "evidence_ref": "docs/evidence/makesafe-duplicate-survivors-2026-08-01.md"
   }
   ```

The original three-group command above is historical command shape only. It was
rescoped after the first dry run; tranche 1 is already applied, and tranche 2
must be gated separately as documented below. Any skipped group, count mismatch,
or stranded survivor is a hard stop.

`group_keys` scopes the planner for the dry run and the live apply alike, and a
live apply refuses without it. Excluding a group is therefore a parameter
choice, not a code change and not a guard bypass — `MAKESAFE_AUTHORIZED_DUPLICATE_GROUPS`
keeps all four entries and MLB-23067 stays fully adjudicated in this document.

## Delegation scope — confirmed 2026-08-01

The original ruling authorized the PO rule for seven groups and an evidence pick
for two. Re-verification found the PO rule decides none, five groups are not
duplicates, and four pairs need an evidence pick — three of which (MLB-25625,
MLB-26189, MLB-26344) had been nominated for the PO rule rather than delegated.

**The captain has confirmed the evidence-pick delegation extends to all four
pairs, MLB-25625, MLB-26189 and MLB-26344 included.** The four survivors recorded
above are therefore authorized.

That confirmation covers the *survivor selection* only. The post-deploy dry run
still gates each live apply: it must report the exact expected archive count and
zero skips for that tranche before `dry_run` is set to false.
See **Captain ruling 2026-08-01 — MLB-23067 is excluded from the apply set** below
for why.

## Pre-existing display overlays the plan did not account for (found 2026-08-01)

The plan in `data/board-duplicate-survivors-v1/dry-run-plan.json` derived each
`before_status` from raw card facts. It did **not** read
`makesafe_board_status_applications`, and five of the eight cards already carry a
row there from earlier captain-approved runs. Read-only from production:

```
job          run_key                                     source -> after      applied
SWMS-26998   makesafe-board-truth-stage1-20260724        new    -> allocated  2026-07-24
SWMS-26791   makesafe-board-truth-stage1-20260724        report_ready -> allocated  2026-07-24
SWMS-26845   makesafe-board-truth-stage3-20260724        report_ready -> archive    2026-07-24
SWMS-26920   ses-u7-three-net-close-20260728-0755        allocated -> archive       2026-07-28
SWMS-261065  ses-u7-falsification-dead-close-20260728-v1 new    -> archive          2026-07-28
```

`SWMS-26845` and `SWMS-261065` are planned **survivors**; `SWMS-26920` is a
planned **loser**. An overlay only takes effect when its `source_status` still
equals the card's freshly derived `board_stage` (`makesafe_board_read_model.ts`
`applicationApplies`), so whether each is live must be read off the deployed
board, not inferred here. But if the `SWMS-26845` or `SWMS-26920` overlay is
live, `planMakesafeDuplicateSurvivorArchives` skips `mlb-23067-makesafe` with
`survivor_terminal_display_status` / `loser_terminal_display_status`, and one
skip refuses the entire run.

Two things follow, and neither is settled by the delegation above:

- The dry run is expected to diverge from the committed fixture. The fixture is
  the stale artefact; the live response is truth.
- `archive` on the display ledger is overloaded. The 2026-07-24 cutover archived
  `SWMS-26845` because it was **completed more than seven days ago**, not because
  it was a duplicate — the same card this document selects as the survivor that
  "carries the entire delivery". The planner's terminal-display guard cannot tell
  a done-and-archived survivor from a dead one, and deliberately fails closed.
  Whether MLB-23067 still needs a duplicate archive at all, given both its cards
  already display `archive`, is a captain question, not a planner question.

### Captain ruling 2026-08-01 — MLB-23067 is excluded from the apply set

**`mlb-23067-makesafe` is not applied.** Both its cards already display
`archive`, so the ruled outcome — the duplicate off the live board, the delivery
card not shown as outstanding work — already holds. Applying would buy a pointer
column and nothing else, and the only way to get it would be to force past a
guard that is correctly refusing.

The ruling is explicit that the guard is **not** to be forced, relaxed or worked
around. MLB-23067 keeps its full adjudication above and its entry in
`MAKESAFE_AUTHORIZED_DUPLICATE_GROUPS`; it is simply left out of the `group_keys`
of the dry run and the apply. If its display state later changes so that either
card returns to a live stage, the group is already adjudicated and can be applied
then without re-litigating the survivor pick.

The original apply set was three groups. After tranche 1, only
`mlb-26189-assessment` remains pending, gated at one archive and zero skips.

`SWMS-261065` (survivor, MLB-26344) also carries an `archive` overlay, but its
`source_status` is `new` while the card now sits at `admin_to_send_report`, so
the overlay is expected to read stale and not apply. That expectation is not
load-bearing: if it turns out to be live, the dry run reports a skip and the run
stops, exactly as it should.

## Execution record — 2026-08-01

The migration and `ops-api` reached production through workflow run
`30685465945` (`APPLY 20260801045000`, `PASS migration auto-apply: applied=1`,
`PASS edge schema preflight`). PR 457's own deploy had failed closed on a ledger
version collision; see the renumber note under the release sequence.

### First dry run — three groups requested, one skipped

```
SWMS-26998   allocated -> archive  ptr SWMS-26736   mlb-25625-roof       planned
SWMS-261118  new       -> archive  ptr SWMS-261065  mlb-26344-makesafe   planned
mlb-26189-assessment   SKIPPED   survivor_terminal_display_status: archive
```

Both planned archives matched the committed fixture exactly, `before_status`
included, and the predicted stale overlay on `SWMS-261065` did read stale. The
skip was new information, so nothing was applied.

`SWMS-26787` has **zero** rows in `makesafe_board_status_applications`, so its
`archive` display is not an overlay — it is the card's own derived stage. The
assessment closed out on 2026-06-30 with an `AUTHORISED` `ACCREC` invoice and a
report sent 2026-06-29, more than seven days before the run. The board archives
it because it is **finished**.

That is materially different from MLB-23067, where both cards display `archive`
and the ruled outcome already holds. Here the loser `SWMS-26791` has no invoice
and no sent report, so it is not closed out and remains on the live board — the
duplicate the ruling is meant to remove.

### Tranche 1 — applied

`run_key` `makesafe-duplicate-survivors-20260801-t1`. Dry run rescoped to the two
clean groups returned two archives and zero skips; the live apply wrote ledger
rows 45 and 46 and returned an empty `stranded_survivors`.

Verified read-only afterwards, independently of the action's own re-read: both
losers carry exactly one duplicate row pointing at their survivor, both survivors
carry none and remain non-terminal, every `jobs.updated_at` still predates the
apply, assignment and invoice counts are unchanged, and there are **zero**
`job_events` on any of the four cards since the apply. Evidence:
`scripts/board-duplicate-survivors-v1.tranche1-{dry-run,apply-ledger,verify}.json`.

### The natural-completion survivor exception

Captain decision: extend the survivor guard minimally so a survivor whose
`archive` display comes from natural completion is accepted, leaving every other
refusal untouched. `survivorArchiveIsNaturalCompletion` in
`makesafe_duplicate_survivor.ts` requires all four of:

- the display is `archive` specifically — `cancelled` still refuses;
- `declared_stage` is also `archive`, so the stage is the card's own, and
  `status_application` is null, so no earlier run's decision is being read as
  completion;
- the card is not itself an archived duplicate, which would build a pointer chain;
- the read model's independent `closeout_satisfied` verdict is true. It is
  computed before the display-status short-circuit and requires a durable send
  record plus an `AUTHORISED`/`PAID` `ACCREC` invoice, which is the "done and
  invoiced" evidence the exception requires.

No migration accompanies this. The RPC's survivor guard tests raw `jobs.status`
and the pointer-chain `NOT EXISTS`, never the display stage, so it already
accepts `SWMS-26787` (`processing`, no duplicate rows). The change is confined to
the planner. The RPC's stale-plan guard also still holds for the loser:
`SWMS-26791` sends `source_status: report_ready` against its 2026-07-24 overlay
row and `before_status: allocated`, which is that row's `after_status`.

### Tranche 2 — pending

`mlb-26189-assessment` needs this planner change deployed before it can be dry
run again. It is therefore a separate tranche after this PR merges, gated the
same way: one archive, zero skips, before `dry_run` goes false.

MLB-23067 stays excluded and is not in either tranche.
