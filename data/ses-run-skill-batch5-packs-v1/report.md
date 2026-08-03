# Batch 5 — physical make-safe and temporary fencing driven to Docs Ready

Task `ses-run-skill-batch5-packs-v1`. Branch `fm/ses-run-skill-batch5-packs-v1`, isolated treehouse
worktree of `secureworks-backend`. Written as the run went.

**Slice: `physical_makesafe` + `temporary_fencing` only.** No card outside those two families was
written to. The invoice-obligation path was not changed.

---

## READ THIS FIRST — two things before you look at the board

### 1. The board will show you 5, and the real number is 35. Both are correct.

**30 of the 35 ready cards sit in the board's `archive` column**, because `archive` means two
different things: "this card is dead" *and* "this job finished more than seven days ago". These
cards derive `canonical_stage: archive` because their work completed more than seven days ago, not
because of their job number; the set spans `SWMS-261xx` through `SWMS-269xx`. Their packs are ready
and queued for your signoff — they just do not appear in a column you would scan for live work.

> **Counting Docs Ready by eye off the board shows 5, not 35. The number is not wrong.**
> The honest surface is the signoff queue: `ops-api?action=list_ses_docs_ready_reviews`, which
> returns 38 dockets at `needs_review` — my 35 plus the three that were already there.

### 2. Five cards to dismiss or re-sign, in one pass

These five had **already been sent to the builder** before this run (`pack.state: "sent"`). My run
minted a fresh docket revision on them, and a new revision invalidates the previous signoff tick, so
they have re-entered `needs_review`. That is noise I introduced, not work I completed — nothing was
re-sent, and no client received anything.

| Card | Suburb | What it needs |
|---|---|---|
| `SWMS-26604` | Nedlands | dismiss or re-sign |
| `SWMS-26630` | Carine | dismiss or re-sign |
| `SWMS-26654` | Bicton | dismiss or re-sign |
| `SWMS-26655` | Balcatta | dismiss or re-sign |
| `SWMS-26663` | Mount Richon | dismiss or re-sign |

Clear those five and the queue is 33: the 30 genuinely new cards plus the original three.

---

## THE NUMBER

> **35 dockets persisted and sitting in the Docs Ready review queue, out of 62 cards touched.**
> The queue held **3** when I started. It now holds **38**, and 35 of those 38 are mine.
> Verified live, not derived: `list_ses_docs_ready_reviews` returns 38 dockets at
> `state: needs_review`, my 35 plus the original three (`SWMS-261017`, `SWMS-261109`,
> `SWMS-261115`). None of mine is missing from it.

Every one of the 35 is `state: ready`, `blockers: []`, `pre_xero_docs_ready: true`, with the docket
revision **persisted** — report attached, SWMS generated where the family requires one, docket
hashed and uploaded, pack drafted.

**One honest deduction, which I am making rather than leaving for the captain to find.**
Five of the 35 (`SWMS-26604`, `SWMS-26630`, `SWMS-26654`, `SWMS-26655`, `SWMS-26663`) carry
`pack.state: "sent"` on the board — their pack had **already been sent to the builder** before this
run. My run minted a fresh docket revision on them, and per the signoff contract a new revision
invalidates the previous tick, so they have re-entered `needs_review`. That is noise I introduced,
not work I completed. The captain should expect to dismiss or re-sign those five.

> **So the number that actually means new sendable work is 30, and the queue number is 35 of 38.**
> Both are stated so neither can be mistaken for the other.

## The table

| Card | Suburb | Outcome | Evidence |
|---|---|---|---|
| `SWMS-261020` | Floreat | **Docs Ready** | persisted docket, `pre_xero_docs_ready: true`, blockers `[]` |
| `SWMS-261025` | Koondoola | **Docs Ready** | persisted docket, `pre_xero_docs_ready: true`, blockers `[]` |
| `SWMS-261028` | Success | **Docs Ready** | persisted docket, `pre_xero_docs_ready: true`, blockers `[]` |
| `SWMS-261029` | Midland | **Docs Ready** | persisted docket, `pre_xero_docs_ready: true`, blockers `[]` |
| `SWMS-261034` | Wanneroo | **Docs Ready** | persisted docket, `pre_xero_docs_ready: true`, blockers `[]` |
| `SWMS-261036` | Gwelup | **Docs Ready** | persisted docket, `pre_xero_docs_ready: true`, blockers `[]` |
| `SWMS-261038` | Tapping | **Docs Ready** | persisted docket, `pre_xero_docs_ready: true`, blockers `[]` |
| `SWMS-261039` | Nollamara | **Docs Ready** | persisted docket, `pre_xero_docs_ready: true`, blockers `[]` |
| `SWMS-261055` | Dianella | **Docs Ready** | persisted docket, `pre_xero_docs_ready: true`, blockers `[]` |
| `SWMS-261065` | Munster | **Docs Ready** | persisted docket, `pre_xero_docs_ready: true`, blockers `[]` |
| `SWMS-261080` | Floreat | **Docs Ready** | persisted docket, `pre_xero_docs_ready: true`, blockers `[]` |
| `SWMS-26604` | Nedlands | **Docs Ready** | persisted docket, `pre_xero_docs_ready: true`, blockers `[]` |
| `SWMS-26630` | Carine | **Docs Ready** | persisted docket, `pre_xero_docs_ready: true`, blockers `[]` |
| `SWMS-26654` | BICTON | **Docs Ready** | persisted docket, `pre_xero_docs_ready: true`, blockers `[]` |
| `SWMS-26655` | Balcatta | **Docs Ready** | persisted docket, `pre_xero_docs_ready: true`, blockers `[]` |
| `SWMS-26663` | Mount Richon | **Docs Ready** | persisted docket, `pre_xero_docs_ready: true`, blockers `[]` |
| `SWMS-26841` | Bedford | **Docs Ready** | persisted docket, `pre_xero_docs_ready: true`, blockers `[]` |
| `SWMS-26845` | Queens Park | **Docs Ready** | persisted docket, `pre_xero_docs_ready: true`, blockers `[]` |
| `SWMS-26867` | Hillarys | **Docs Ready** | persisted docket, `pre_xero_docs_ready: true`, blockers `[]` |
| `SWMS-26875` | Lesmurdie | **Docs Ready** | persisted docket, `pre_xero_docs_ready: true`, blockers `[]` |
| `SWMS-26884` | Alexander Heights | **Docs Ready** | persisted docket, `pre_xero_docs_ready: true`, blockers `[]` |
| `SWMS-26887` | Hocking | **Docs Ready** | persisted docket, `pre_xero_docs_ready: true`, blockers `[]` |
| `SWMS-26888` | Clarkson | **Docs Ready** | persisted docket, `pre_xero_docs_ready: true`, blockers `[]` |
| `SWMS-26891` | Thornlie | **Docs Ready** | persisted docket, `pre_xero_docs_ready: true`, blockers `[]` |
| `SWMS-26894` | Ballajura | **Docs Ready** | persisted docket, `pre_xero_docs_ready: true`, blockers `[]` |
| `SWMS-26901` | Ocean Reef | **Docs Ready** | persisted docket, `pre_xero_docs_ready: true`, blockers `[]` |
| `SWMS-26917` | Winthrop | **Docs Ready** | persisted docket, `pre_xero_docs_ready: true`, blockers `[]` |
| `SWMS-26919` | Morley | **Docs Ready** | persisted docket, `pre_xero_docs_ready: true`, blockers `[]` |
| `SWMS-26927` | Balga | **Docs Ready** | persisted docket, `pre_xero_docs_ready: true`, blockers `[]` |
| `SWMS-26937` | Balga | **Docs Ready** | persisted docket, `pre_xero_docs_ready: true`, blockers `[]` |
| `SWMS-26944` | Gwelup | **Docs Ready** | persisted docket, `pre_xero_docs_ready: true`, blockers `[]` |
| `SWMS-26946` | Bedford | **Docs Ready** | persisted docket, `pre_xero_docs_ready: true`, blockers `[]` |
| `SWMS-26948` | Beechboro | **Docs Ready** | persisted docket, `pre_xero_docs_ready: true`, blockers `[]` |
| `SWMS-26949` | Bayswater | **Docs Ready** | persisted docket, `pre_xero_docs_ready: true`, blockers `[]` |
| `SWMS-26955` | Herne Hill | **Docs Ready** | persisted docket, `pre_xero_docs_ready: true`, blockers `[]` |
| `SWMS-26902` | Ballajura | waiting on trade | no current-cycle trade report; U4 `trade_evidence_missing` |
| `SWMS-26953` | Gidgegannup | waiting on trade | no current-cycle trade report; U4 `trade_evidence_missing` |
| `SWMS-261015` | Tuart Hill | blocked by us | `swms_generation_facts_missing` - no crew on work order, report, job or assignment |
| `SWMS-261021` | Floreat | blocked by us | `swms_generation_facts_missing` - no crew on work order, report, job or assignment |
| `SWMS-261024` | Koondoola | blocked by us | `swms_generation_facts_missing` - no crew on work order, report, job or assignment |
| `SWMS-261035` | Morley | blocked by us | `swms_generation_facts_missing` - no crew on work order, report, job or assignment |
| `SWMS-261037` | Tapping | blocked by us | `swms_generation_facts_missing` - no crew on work order, report, job or assignment |
| `SWMS-26628` | WOODVALE | blocked by us | `pricing_evidence_missing` - work order states no panel/base quantities |
| `SWMS-26629` | Bennett Springs | blocked by us | `routing_evidence_missing` - no builder report recipient in `makesafe_companies` |
| `SWMS-26642` | Palmyra, WA 6157 | blocked by us | `routing_evidence_missing` - no builder report recipient in `makesafe_companies` |
| `SWMS-26644` | Craigie | blocked by us | `pricing_evidence_missing` - work order states no panel/base quantities + `routing_evidence_missing` - no builder report recipient in `makesafe_companies` |
| `SWMS-26652` | QUINNS ROCKS | blocked by us | `pricing_evidence_missing` - work order states no panel/base quantities |
| `SWMS-26657` | Sorrento | blocked by us | `routing_evidence_missing` - no builder report recipient in `makesafe_companies` |
| `SWMS-26835` | Ballajura | blocked by us | `pricing_evidence_missing` - work order states no panel/base quantities + `swms_generation_template_unavailable` - captain must seal the template |
| `SWMS-26836` | Dianella | blocked by us | `swms_generation_template_unavailable` - captain must seal the template |
| `SWMS-26840` | Queens Park | blocked by us | `pricing_evidence_missing` - work order states no panel/base quantities |
| `SWMS-26862` | Parmelia | blocked by us | `pricing_evidence_missing` - work order states no panel/base quantities |
| `SWMS-26866` | Daglish | blocked by us | `pricing_evidence_missing` - work order states no panel/base quantities |
| `SWMS-26878` | Huntingdale | blocked by us | `pricing_evidence_missing` - work order states no panel/base quantities |
| `SWMS-26882` | Hillarys | blocked by us | `pricing_evidence_missing` - work order states no panel/base quantities |
| `SWMS-26885` | Waikiki | blocked by us | `pricing_evidence_missing` - work order states no panel/base quantities |
| `SWMS-26893` | Heathridge | blocked by us | `pricing_evidence_missing` - work order states no panel/base quantities |
| `SWMS-26900` | Yangebup | blocked by us | `pricing_evidence_missing` - work order states no panel/base quantities |
| `SWMS-26903` | Bedford | blocked by us | `pricing_evidence_missing` - work order states no panel/base quantities |
| `SWMS-26938` | Noranda | blocked by us | `swms_generation_facts_missing` - no crew on work order, report, job or assignment |
| `SWMS-26939` | South Perth | blocked by us | `pricing_evidence_missing` - work order states no panel/base quantities |
| `SWMS-26940` | Mosman Park | blocked by us | `swms_generation_facts_missing` - no crew on work order, report, job or assignment |

Plus **98 cards waiting on the trade as a class** — no submitted `job_service_reports` row at all
(64 physical make-safe, 34 temporary fencing). They are enumerated in `census-appendix.md` §5.
Nothing is owed from us on those.

**Count line: 35 cards into Docs Ready, out of 62 touched. Board 3 → 38.**

No card was archived, completed, cancelled or sent. No email was drafted to a real recipient. No
invoice was created, authorised or sent. The money seal was never approached — no 403 or 409 on the
money path occurred, because no money path was called.

---

## 1. What actually unlocked this: the identity spine, seeded

The previous session proved the whole family was held by one class: `makesafe_state_identity_current_v2`
had **zero rows**, so every card fell back to its intake case, and 60 of the 66 evidence-bearing
cards in my slice failed `spine_missing_lineage`.

The captain authorised `makesafe_state_seed_scoped`. I ran it **staged, four cards first**, as
instructed.

### Tranche A — the four proof cards

| Card | Before | After |
|---|---|---|
| `SWMS-261020` Floreat | `identity_authority_kind: null`, `source_content_hash_present: false`, `spine_complete: false` | `effective_intake_case`, hash present, **`spine_complete: true`** |
| `SWMS-261025` Koondoola | same | same |
| `SWMS-261065` Munster | same | same |
| `SWMS-261080` Floreat | same | same |

All four were confirmed live on U4 **before** the seed as `spine_missing_lineage` with 14 blocked
items each, and confirmed after as `state: ready`, `blockers: []`, `pre_xero_docs_ready: true`,
docket persisted. `accounting.agrees: true`, `seeded: 4`, `skipped: 0`,
`identity_revisions_inserted: 4`, `idempotent_replay: false`.

Nothing behaved unexpectedly, so I continued as the brief directed.

### Tranches B, C, D — the remaining 56

| Tranche | Run key | Cards | Seeded | Skipped | Identity revisions | Spine complete after |
|---|---|---:|---:|---:|---:|---|
| A | `b5-packs-tranche-a-2026-08-03` | 4 | 4 | 0 | 4 | 4/4 |
| B | `b5-packs-tranche-b-2026-08-03` | 25 | 25 | 0 | 25 | 25/25 |
| C | `b5-packs-tranche-c-2026-08-03` | 25 | 25 | 0 | 25 | 25/25 |
| D | `b5-packs-tranche-d-2026-08-03` | 6 | 6 | 0 | 6 | 6/6 |
| **total** | | **60** | **60** | **0** | **60** | **60/60** |

`accounting.agrees: true` on every tranche. **Nothing was overwritten**: every one of the 60 read
`identity_authority_kind: null` in `spine_before`, so there was no existing identity row to
displace, exactly as the authorisation anticipated. I did not have to stop for that reason once.

Two side effects worth naming rather than burying:

- Tranche B inserted **9 `terminal_proofs`**. That is the seeder recording proof of a terminal state
  the card was already in, not a state change. No card was moved to terminal by me.
- `facts_seeded_or_bound` totalled 1,552 across the four runs, and `attendance_cycles_created` was
  **0** on all four — the seeder's cycle-minting branch never fired on this selection.

---

## 2. Every remaining blocker, named, with card counts

25 cards are blocked by us. They are **four classes, not 25 problems**, and none of them is a
defect in the pack factory.

| Class | Cards | Is it one card or a class? | What it needs |
|---|---:|---|---|
| `pricing_evidence_missing` — temporary-fencing panel/base quantities | **14** | class | The work order and structured scope state no panel and base or block counts. The adapter already looks in `pricing.panel_count`, `checklist.panel_count` and six structured-source aliases (`ses_assembler_input_adapter.ts:991-1020`) — the lookup is broad, the data genuinely is not there. |
| `swms_generation_facts_missing` — no crew | **7** | class | Crew is absent from the work order, bound field report, job *and* assignment. **This is the safety gate working and I did not soften it.** |
| `routing_evidence_missing` — no builder report recipient | **4** | class | One `makesafe_companies` row per affected builder. A data fix, not a code fix. |
| `swms_generation_template_unavailable` — asbestos | **2** | class | `SWMS-26835`, `SWMS-26836`. Asbestos is evidenced but the sealed asbestos template is scoped to fibre-cement fence make-safe (`ses_swms_template.ts:568-589`). **Captain must seal the matching template**; U4 then generates it automatically. |

`SWMS-26644` carries both pricing and routing; `SWMS-26835` carries both pricing and template. That
overlap is why 14+7+4+2 lands at 25 distinct cards.

### On the two I refused to force

`pricing_evidence_missing` on fencing wants panel and base counts, and
`swms_generation_facts_missing` wants the names of the people who attended. Both would have been
trivial to make pass by supplying a plausible number or a carried-over crew. Both would have put an
invented quantity on a money document and invented names on a **safety** document. I left all 21
blocked. That is the correct outcome, not a shortfall.

---

## 3. What I did NOT have to fight, because it was already fixed

Confirmed live in my slice, on cards, not asserted:

- **`d8f7d55` — SWMS renderer bound.** Not one card in this run returned
  `swms_generation_capability_unavailable`. The blocker that stopped 63 cards is gone. Cards whose
  family requires a SWMS generated one and reached Docs Ready.
- **`053bddb` + `7f7cb5f` — persist cliff.** No card returned `WORKER_RESOURCE_LIMIT`. 35 dockets
  persisted, including photo-heavy make-safe cards.
- **`cf23e28` — crew lookup.** The 7 cards still short on crew are short in all four sources at
  once, which is the honest residue, not the lookup dropping a name it had.
- **`3785001` — spine seeder route.** Its live proof was blocked on a credential. The captain set a
  new `SW_API_KEY`; it authenticates, and **this run is that live proof**: 60 cards seeded across
  four ledgered run keys with accounting agreeing on every one.

---

## 4. No card was parked on a dead link, and none should have been

Zero screenshots, and that is correct rather than an omission. The captain's ruling
(`2026-08-02-roof-and-assessment-are-link-checks.md`) scopes the Prime-portal link check to roof and
assessment. Neither of my families is a link-check family, no card in my slice returned a portal
blocker, and I therefore never reached a link verdict that would have needed a screenshot to
support it.

---

## 5. Method, and the honest caveats

- Writes went through `ops-api` `prepare_ses_docket_revision` and `makesafe_state_seed_scoped` with
  the ops key read from disk at call time. Every card was **dry-run first**, and persisted only when
  the dry run returned `state: ready` with zero blockers. No card was persisted blind.
- The key value was never printed, echoed, committed, logged or screenshotted.
- No client name, phone number, email address or street address appears in this report, in any query
  I ran, or in any file I wrote. Suburb, job reference and builder reference only.
- **`supporting_invoice_pdf` reads `blocked` on all 35 Docs Ready cards.** That is the invoice
  obligation, which the brief told me to skip and another crew is changing. It does not gate
  `pre_xero_docs_ready` and it did not stop a single card. I did not touch that path.
- **Caveat on the blocker classes:** I wanted to confirm from production that the 14 fencing cards
  genuinely carry no panel counts under some unread key. **Both read credentials are stale** — the
  Management API token in `~/.config/secureworks/env` returns 403, and the Supabase MCP returns
  `Unauthorized`. Only the ops key was refreshed. So the pricing verdict rests on reading the
  adapter's resolution order rather than on a production probe. I stopped after two attempts rather
  than hunting for another route to a credential.
- The 98 "waiting on trade" cards are carried forward from the census in `census-appendix.md`, which
  measured them directly. I did not re-measure them this run.
- Two strikes was reached once, on the read-credential probe above. No card was fought with twice.

---

## 6. Board verification, done live rather than assumed

I did not trust my own per-card returns. After the run I read the canonical server board
(`makesafe_board`, 440 rows, `parity.ok`) and the signoff queue (`list_ses_docs_ready_reviews`) and
reconciled them against my 35.

| Check | Result |
|---|---|
| Docs Ready review queue size | **38 dockets, all `needs_review`** (was 3) |
| Of those, mine | **35** |
| Mine missing from the queue | **0** |
| Board-wide cards with `pre_xero_docs_ready: true` | 33, of which 30 are mine |
| My 35 by `canonical_stage` | 5 `report_ready`, 30 `archive` |

Two things that table shows which a per-card log would have hidden:

- **30 of my 35 sit in the board's `archive` column.** That is not a card being dead. `archive` is
  overloaded — it is also "this job finished more than seven days ago" — and these cards derive
  `canonical_stage: archive` from completion age, not their job number. The set spans `SWMS-261xx`
  through `SWMS-269xx`. Their packs are ready and they are in the signoff queue; they just will not
  appear in a column the captain scans for live work. **If he is counting Docs Ready by eye off the
  board, he will see 5, not 35.** The queue is the honest surface.
- **The 5 already-sent cards are exactly the 5 whose board `pack.pre_xero_docs_ready` reads
  `false`** while their fresh docket reads `true`. The board is showing the historical sent pack
  (`docket_revision_id: null`), the queue is showing my new revision. That disagreement is the
  signature of the re-issue described in THE NUMBER, and it is how I found it.

I corrected one mistake of my own here: my first reconciliation joined the queue's `job_id` to a
board field named `job_id`, which does not exist — board rows key on `id`. That join produced
"0 of 38 are mine", which was wrong. Rejoined on `id`, it is 35 of 38.

---

## 7. The finding that outlives this run: fencing pricing has a reader and no producer

The 14-card `pricing_evidence_missing` class is not a data-entry backlog. It is a **missing
producer**, and it will block every temporary-fencing card that ever reaches U4, not just these 14.

`ses_prepare_docket_revision.ts:665-712` prices temporary fencing from three facts —
`panel_count`, `base_count`, and `star_picket_count` for hire-basis cards. The adapter resolves
each of them thoroughly, from `pricing.*`, `checklist.*` and six structured-source aliases apiece
(`ses_assembler_input_adapter.ts:991-1030`).

Then this, run across the whole of `supabase/functions/`:

| Fact | References outside the adapter's reader and U4's blocker |
|---|---:|
| `panel_count` | **0** |
| `base_count` | **0** |
| `star_picket_count` | **0** |
| `hours_per_trade` | **0** |

**Nothing in the backend ever writes any of them.** `submit_makesafe_report` does not collect them,
no migration defaults them, no gap-fill path sets them. The read side is complete and correct; the
write side does not exist. So no amount of re-running the skill will ever clear this class, and it
is not a stale blocker to re-test — it is a permanent floor until a producer is built.

This is the same shape as the four walls the earlier batches found (renderer built and unbound,
crew resolved and dropped, seeder migrated with no route, capture written and rejected on read),
with the halves reversed: here the **consumer** is the half that exists.

I did not build the producer. It needs a trade-app form change to capture the quantities and a
captain sign-off on the pricing inputs, which is outside a pack-assembly brief and outside my two
families' write authority. **Recommend it as the next unit of work: it is worth 14 cards now and
every fencing card thereafter.**

### The other three classes, ranked by what they cost

| Class | Cards | Owner | Effort |
|---|---:|---|---|
| Fencing quantity producer (above) | 14 | needs a build + captain pricing sign-off | the big one |
| `routing_evidence_missing` | 4 | one `makesafe_companies` row per affected builder | minutes, data only |
| `swms_generation_facts_missing` | 7 | genuinely no crew recorded anywhere | correctly blocked, may never clear |
| `swms_generation_template_unavailable` | 2 | captain seals an asbestos template | one decision |

The routing class is the cheapest 4 cards on the board and needs no code at all — but setting a
builder's outbound report recipient is a business decision about where real mail goes, so I left it
for the captain rather than guessing an address.
