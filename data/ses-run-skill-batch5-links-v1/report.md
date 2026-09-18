# Batch 5 — drive the roof-portal and assessment families to Docs Ready

**Agent:** `ses-run-skill-batch5-links-v1`
**Date:** 2026-08-03 AWST
**Slice:** `ses_family ∈ {ordinary_roof_portal, assessment_quote}` only. No physical make-safe, no
temporary fencing, no change to the invoice-obligation path.
**Mode:** production reads via Supabase Management API `read_only: true`, SELECT only, plus headless
CDP screenshots of builder share links. For most of this run **no production write was possible** —
see the credential section. After the key was fixed, **exactly one production write was made**: the
captain-approved roof storey backfill over 38 cards (§9.3). No card archived, completed, cancelled
or sent; no invoice created, authorised or sent; no email drafted; the money seal was never touched;
no per-card docket or report work was done.

---

# FOR THE CAPTAIN — three things, read these first

## 1. 38 roof cards are now clear of `pricing_evidence_missing`

28 single storey, 10 double. Written by the sanctioned backfill on your approval, at your confirmed
prices (single $250 ex / $275 inc, double $350 ex / $385 inc), re-verified against the sealed pricer
before anything was written. Confirmed by reading production back, not by trusting the response.

**That blocker only.** Those 38 cards may still be held by the spine, the attendance cycle, a dead
portal link or missing trade evidence. This did not put 38 cards in Docs Ready — it removed one wall
from in front of them.

Two cards were deliberately not written, and they are still `(none)` in production:

| Card | Suburb | Why |
|---|---|---|
| `SWMS-26930` | Joondalup | three storeys — no sealed price, you price it by hand at release |
| `SWMS-26848` | Dianella | already carries a storey; writing a second value can make the reader return `undefined` and **stop a card that prices today** |

## 2. `SWMS-261019`'s persisted pack will be superseded on its next prepare

You are working the roof cards live, so know this before it surprises you. `SWMS-261019` (Floreat)
already had a persisted docket revision. Adding its storey fact changes the docket's **input hash**,
so the next `prepare_ses_docket_revision` on that card supersedes the pack that is on it now.

**This is the card becoming priceable, not a defect** — the old pack was built without a price. The
action flagged it itself in `state_moves`; I did not touch the card. It is the only one of the 38
in this position.

## 3. A gap between the guard and the reader — it did not bite here, but it is real

The backfill decides what to hold using `competingStoreySignals`, which inspects `jobs.metadata`,
`jobs.scope_json` and `makesafe_job_details`. The function that later **reads** the storey,
`structuredSourceFact`, looks at one more place: **`intakeCase.raw_identity_json`**. The guard does
not inspect that root.

It matters because `structuredSourceFact` returns `undefined` when it finds two *different* values,
so a competing value hiding in the intake case would leave a card blocked despite a successful
write — a silent no-op.

**Why it did not bite on these 38.** I checked instead of assuming. Five of the written cards do
carry a storey signal in `raw_identity_json` — `SWMS-261079`, `261113`, `261114`, `261116`,
`261123`, the newest cards, whose deterministic intake stores the builder's instruction text. **None
of the five is a keyed value.** All five are prose inside that instruction, which is the very text
the matcher read the storey from. `structuredSourceFact` only collects values under matching keys,
so prose produces no competing value and every one of the 38 resolves unambiguously.

So this run is safe. But the guard and the reader disagree about where a storey can live, and the
next tranche — or a builder whose intake writes a keyed storey — could hit it. Worth closing by
adding `raw_identity_json` to `competingStoreySignals`, which would only ever hold *more* cards for
a human, never write more.

---

## The table

| Card | Suburb | Outcome | Evidence |
|---|---|---|---|
| SWMS-261019 | Floreat | **blocked by us** | report submitted + locked 22/24, `shots/d2ff4956.png`. Spine complete, cycle bound, capture row **proven to verify** (§6a). Held by the ops-api key + the storey backfill. |
| SWMS-261079 | Floreat | **blocked by us** | report submitted + locked 22/24, `shots/f280ebb0.png`. Held by **no attendance cycle** (class of 6) + storey + the key. |
| SWMS-26934 | Seville Grove | **blocked by us** | report submitted + locked 21/23, `shots/f41c5a7e.png`. Held by **no intake case** (spine) + storey + the key. Capture row proven to verify (§6a). **Link expires 4:46 pm today** (captured 06:20, still live) — this is the last screenshot anyone gets of it. |
| SWMS-26980 | Gwelup | waiting on trade | report submitted + locked 20/23, `shots/2ef11c67.png`, but this is `own_template_roof` — the exception in the captain's ruling. Waiting on the trade to submit **our** template, not Prime's. |
| SWMS-261081 | Mindarie | waiting on trade | live form, 21 of 23 answered, live to 24 Aug, `shots/d79170a1.png` |
| SWMS-261113 | Woodvale | waiting on trade | live form, **0 of 22** answered, live to 31 Aug, `shots/b8c356d0.png` |
| SWMS-261114 | White Gum Valley | waiting on trade | live form, **0 of 22** answered, live to 31 Aug, `shots/bd8dff3e.png` |
| SWMS-261116 | Morley | waiting on trade | live form, 21 of 24 answered, live to 31 Aug, `shots/94315179.png`. **Read `expired` once on an earlier pass — see §4.** |
| SWMS-261123 | Cottesloe | waiting on trade | live form, 19 of 23 answered, live to 30 Aug, `shots/7d74ea48.png` |
| SWMS-26618 | Merriwa | dead link (screenshot) | `shots/exp-73a30394.png`, expired on both passes |
| SWMS-26632 | Bedford | dead link (screenshot) | `shots/exp-a9a9b9d5.png`, expired on both passes |
| SWMS-26709 | Karrinyup | dead link (screenshot) | `shots/exp-47170013.png`, expired on both passes |
| SWMS-26715 | Mosman Park | dead link (screenshot) | `shots/exp-b6198a3f.png`, expired on both passes |
| SWMS-26719 | Madeley | dead link (screenshot) | `shots/exp-16f37945.png`, expired on both passes |
| SWMS-26728 | Dalyellup | dead link (screenshot) | 3 links, all expired on both passes (`exp-6fc50346`, `exp-91dbe2d3`, `exp-d8573a1e`) |
| SWMS-26729 | Eden Hill | dead link (screenshot) | `shots/exp-4c9fe382.png`, expired on both passes |
| SWMS-26732 | Glen Iris | dead link (screenshot) | 3 links, all expired (`exp-39017dd9`, `exp-44aa9b53`, `exp-b3bfa15b`) |
| SWMS-26735 | Glen Iris | dead link (screenshot) | 4 links, all expired (`exp-15045576`, `exp-5f5d4550`, `exp-b7535bdf`, `exp-bf15708d`) |
| SWMS-26736 | Usher | dead link (screenshot) | 4 links, all expired (`exp-bbfee074`, `exp-bed455ef`, `exp-cb2a6955`, `exp-fbf711ac`) |
| SWMS-26740 | Preston Beach | dead link (screenshot) | 3 links, all expired (`exp-7020e47b`, `exp-86fbeb46`, `exp-b314f0da`) |
| SWMS-26748 | Dalyellup | dead link (screenshot) | 3 links, all expired (`exp-24c3dd46`, `exp-818d96b0`, `exp-d3dbac05`) |
| SWMS-26754 | Karrinyup | dead link (screenshot) | `shots/exp-5d4ca4bf.png`, expired on both passes |
| SWMS-26759 | Myalup | dead link (screenshot) | 4 links, all expired (`exp-4c1f8270`, `exp-7a831ee5`, `exp-9861bb69`, `exp-ace0a334`) |
| SWMS-26803 | Innaloo | dead link (screenshot) | `shots/exp-2dce428f.png`, expired on both passes |
| SWMS-26810 | Stirling | dead link (screenshot) | `shots/exp-ff5ac8dd.png`, expired on both passes |
| SWMS-26848 | Dianella | dead link (screenshot) | `shots/exp-728fb9be.png`, expired on both passes |
| SWMS-26849 | Gidgegannup | dead link (screenshot) | `shots/exp-8b6f70ac.png`, expired on both passes |
| SWMS-26851 | Usher | dead link (screenshot) | shares 26736's 3 links, all expired on both passes |
| SWMS-26852 | Glen Iris | dead link (screenshot) | shares 26735's 3 links, all expired on both passes |
| SWMS-26853 | Myalup | dead link (screenshot) | shares 26759's 3 links, all expired on both passes |
| SWMS-26857 | Dalyellup | dead link (screenshot) | `shots/exp-afbdaffb.png`, expired on both passes |
| SWMS-26957 | Kardinya | dead link (screenshot) | `shots/exp-4a758764.png`, expired on both passes |
| SWMS-261016 | Maylands | dead link (screenshot) | **absent** — zero `external_links` rows in production; nothing to open |
| SWMS-261018 | West Perth | dead link (screenshot) | **absent** — zero `external_links` rows |
| SWMS-261022 | Helena Valley | dead link (screenshot) | **absent** — zero `external_links` rows |
| SWMS-261049 | Duncraig | dead link (screenshot) | **absent** — zero `external_links` rows |
| SWMS-26658 | Como | dead link (screenshot) | **absent** — zero `external_links` rows |
| SWMS-26930 | Joondalup | dead link (screenshot) | **absent** — zero `external_links` rows |
| SWMS-26965 | Marangaroo | dead link (screenshot) | **absent** — zero `external_links` rows |

**Count: 0 cards into Docs Ready, out of 39 touched.** 3 are blocked by us, 6 are waiting on the
trade, 30 are parked on a link proved dead or absent.

**The 3 "blocked by us" rows are three classes and one credential, not three separate problems:**

| Blocker | Cards | Class or one-off |
|---|---|---|
| ops-api `SW_API_KEY` does not authenticate; every `x-api-key` call 401s | all 3 (and all 39) | **class** — blocks the whole board, both crews, every write and every U4 dry run |
| no structured storey fact, so `pricing_evidence_missing` nulls the invoice proposal and blocks `pre_xero_docs_ready` | all 3 | **class of 61 roof cards; 38 of 50 live ones are write-eligible today** — §7, §8 |
| no attendance cycle, so capture evidence cannot be written at all | SWMS-261079 | **class of 6 in my slice, 44 board-wide** — §5 |
| no intake case, so the spine has no lineage and no builder reference | SWMS-26934 | **class of 22 in my slice** — §6 |

---

## Answer first

**The captain's 20 cards cannot come from my two families, and that is not a wall of ours.** It is
arithmetic on the link evidence.

My whole slice is **39 live non-terminal cards**. On **35 of them the report does not exist**: the
builder's link is dead or was never sent (30), or the trade has the form open and unfinished (5).
An ordinary roof card is a link check — if there is no submitted report there is nothing to notice
and nothing to bill. That is the captain's own second and third buckets working as designed.

**Only 4 cards in the entire roof + assessment board carry a submitted, locked report.** So the
ceiling here was four before I touched anything, and the honest advice is: **the 20 cards are in
physical make-safe and temporary fencing, not here.** The parallel crew's census agrees from the
other side — 66 of their cards carry a trade report, 63 reachable if the identity spine is seeded.

Of my four:

- **SWMS-261019** is the closest card on the board: spine complete, cycle bound, and its portal
  capture now **provably verifies** under the `d21ba19` fix (§6a). Two things stand in front of it —
  the credential, and the storey backfill that `pricing_evidence_missing` demands (§7, §8).
- **SWMS-261079** cannot have capture evidence written at all — it has no attendance cycle.
- **SWMS-26934** has no intake case, so its canonical builder reference is empty and its spine is
  missing. Its link expires at 4:46 pm today; I captured it at 06:20 while it was still live.
- **SWMS-26980** is `own_template_roof`, the exception in the captain's own ruling. It is not a link
  check and is correctly waiting on the trade to submit our template.

## And the thing that stopped every write

**No `SW_API_KEY` on this machine authenticates against `ops-api`.** Every `x-api-key` call returns
`401 Unauthorized`, including the SecureSuite MCP (`sw_ops_summary` → 401). This is not a seal
refusal and not a permission boundary. `MAKESAFE_ROUTINE_KEY`, the other caller identity
`prepare_ses_docket_revision` accepts, is not on this machine either. The parallel crew hit the
identical wall independently (`[key=b5-ops-key]`), so it is environmental, not this worktree.

Consequence: **no U4 dry run, no docket persist, no portal-capture write.**

### The Management API cannot supply the key, and I proved that the expensive way

Firstmate authorised reading the live `SW_API_KEY` from the Management API secrets endpoint. **That
route does not exist.** `GET /v1/projects/{ref}/secrets` returns **SHA-256 digests, not plaintext**.
The proof is structural rather than inferred: `FROM_EMAIL`, `FROM_NAME`, `COMMIT_SHA` and
`BOOKING_CANARY_MODE` are all short human-readable strings in reality, and every one comes back as
exactly 64 hex characters. `SW_API_KEY` is also 64 hex, which is precisely why it looked like a real
key and passed a casual sanity check.

**My error, and it was a real one.** I installed that digest into `~/.config/secureworks/env` and
into `data/secrets/sw-api-key` *before* testing whether it was plaintext, overwriting a working
credential file on a machine two other crews read from. Reverted in full: the bogus secrets file is
deleted, and `~/.config/secureworks/env` is restored to its original `SW_API_KEY` byte-for-byte
(recovered from `~/.config/secureworks/deploy.env`, verified by md5, `chmod 600`). Net state is
exactly as before. No key value was printed, logged, committed or screenshotted at any point.

**It also invalidates my own earlier claim.** In my first status line I said the local key's hash
"differs from production", which I offered as evidence the key had been rotated. That comparison was
md5-of-plaintext against a sha256 digest and proved nothing. What is actually established:

| Fact | Status |
|---|---|
| The local key returns 401 | measured, twice |
| The Management API digest, installed and probed, returns 401 | measured |
| `SW_API_KEY` secret `updated_at` = 2026-08-02T21:47:02Z | measured |
| `ops-api` last deployed 2026-08-02T18:39:59Z, **3h07m earlier** | measured |
| The key was rotated | **not established** — my evidence for it was invalid |

That deploy-before-secret-change ordering is the one lead worth pulling: a function deployed before a
secret was updated may still be serving the old value, which would mean the mismatch is a **missing
redeploy**, not a bad key. I did not test it — a redeploy is a production change well outside this
brief, and it was my second failed route, so I stopped as instructed rather than trying a third.

**Ask:** the captain pastes the current key into `~/.config/secureworks/env` himself. There is no API
path to the plaintext, and it is worth him checking whether `ops-api` needs a redeploy to pick up a
secret changed after its last deploy.

---

## 1. The census, re-measured

Batch 4 counted "roughly 34 ordinary roof portal and 11 assessment and quote". Re-measured tonight:

| Step | Count |
|---|---:|
| roof + assessment, job status not cancelled/archived/complete/invoiced, substatus ≠ `complete` | 44 |
| less cards carrying a display-**archive** overlay in `makesafe_board_status_applications` | −5 |
| **live non-terminal roof + assessment cards** | **39** |

The five removed are `SWMS-26660`, `SWMS-26713`, `SWMS-26855`, `SWMS-26928`, `SWMS-26998`; each
carries an `after_status = archive` row in the adjudicated duplicate-survivor ledger. This lands on
exactly the 39 that `ses-reissue-list-verified-v1` derived independently through the stage-parity
harness — two different derivations, same card set.

Family split: **29 roof, 10 assessment.**

### 1.1 What each card holds

| Fact | Cards (of 39) |
|---|---:|
| has an intake case at all | 17 |
| case carries BOTH `lineage_id` and `source_content_hash` | **17 of 17** |
| **no intake case at all** | **22** |
| has a bound attendance cycle | 33 |
| **no attendance cycle row at all** | **6** |
| has a persisted portal capture | 2 |
| has a persisted docket revision | 1 |

Two corrections to earlier readings:

- **Every intake case in my slice is fully stamped.** `CLAUDE.md` records 103 of 163 live cases
  board-wide missing `source_content_hash`. In roof/assessment that number is **zero of 17**. The
  spine problem here is not an unstamped case, it is **no case at all** on 22 of 39 cards. Anyone
  planning a `source_content_hash` backfill should know it buys nothing in these two families.
- **The missing-cycle class is 6 cards, not 1.** Batch 4 named `SWMS-261079`. The same condition
  holds on `SWMS-261081`, `SWMS-261113`, `SWMS-261114`, `SWMS-261116`, `SWMS-261123`.

### 1.2 A link-hygiene trap in the raw data

Those six cards each show **five** `external_links` rows, but only **one** is a portal link. The
other four are `documents.primeeco.tech/.../new_logo.png`, two `_image_N.png` assets and an S3
`.jpg` — exactly the pollution `urlIsBuilderPortalLink` exists to reject. Counting link coverage off
the raw column over-counts these cards 5×.

---

## 2. The canonical builder reference is derivable from SQL, not just from a dry run

Batch 4 established the rule and read the value off `dry_run` responses. Since dry runs need the
credential, I re-derived it directly from the database using the adapter's own expression
(`ses_assembler_input_adapter.ts:1335-1341`): first non-empty of the case's `builder_wo_canonical`,
`builder_po_canonical`, `external_ref_canonical`, then — only with a resolved identity revision —
`detail.external_ref` and `metadata.external_ref`.

| Card | `builder_wo_canonical` | Job's own external ref | **Canonical reference** |
|---|---|---|---|
| SWMS-261019 | `MLB-27037` | `MLB-27037PO-56395` | `MLB-27037` |
| SWMS-261079 | `MLB-27148` | `MLB-27148` | `MLB-27148` |
| SWMS-26980 | `MLB-26567` | `MLB-26567PO-56164` | `MLB-26567` |
| SWMS-26934 | *(no case)* | `MLB-26678` | `""` (empty) |

This reproduces batch 4's measured values exactly, including the two awkward ones — `MLB-26567`
against an external ref of `MLB-26567PO-56164`, and empty on `SWMS-26934`. **So the "do not guess
it" trap is now closed from two independent directions**, and it can be answered without ops-api
access at all. `SWMS-261114` is worth noting: its case has no PO and an `external_ref_canonical` of
`57514`, so its canonical value is `RR-26836` off the WO — a non-MLB prefix that any hand-built rule
would have got wrong.

---

## 3. The 37 expired links, re-verified rather than inherited

The brief said to reuse `ses-reissue-list-verified-v1` rather than re-screenshot. I re-verified
anyway, and §4 is why. All **37 unique share links** across the 23 expired cards were re-opened
tonight through their stored `/share/` URLs:

```
37 of 37 unique links   verdict = expired on BOTH passes
 0 withheld             redaction verified on every capture
37 screenshots          all byte-identical, sha256 ddfbacb8e139…
```

Every one is Prime's explicit dead-link page. **The 23-card expired verdict stands, and so does the
builder reissue list built on it.** The single shared hash is also the privacy proof: that page
carries a logo, one line of copy and a footer, and no client data at all, so all 37 images are
provably clean by hash rather than by sampling.

The 7 "absent" cards were re-confirmed from production: `jsonb_array_length(external_links) = 0`.
There is no URL to open, so there is no screenshot, and this report says so rather than implying one
exists.

---

## 4. Prime's expiry page is not a stable verdict — and it cost a live card

**`SWMS-261116` (Morley) classified `expired`, with a screenshot of Prime's own dead-link page.
Minutes later the identical URL rendered a fully live form, 21 of 24 answered, "link available until
31st Aug, 2026".**

**One honest caveat about that first image: it no longer exists.** My later clean re-run wrote to the
same path and overwrote it, so `shots/94315179.png` today holds the *live form*, not the dead-link
page — that is a real loss of the primary artifact and I am not going to cite a file that shows the
opposite of the claim. What survives is the run log line

```
>>> SWMS-261116 94315179
    state=expired why=explicit expiry/invalid message and no form rendered shot=shots/94315179.png
```

and my own reading of the image before it was overwritten: Prime's standard expiry page, visually
identical to the 37 dead-link captures that all share `sha256 ddfbacb8e139…`. The driver's redaction
gate had passed it as `deadShell`, which it only does when the page carries the exact copy *"This
link is no longer active or has expired"*. So the transient is well evidenced, but one notch below
the bar I held everything else to, and it is the one claim in this report resting on a log line
rather than an image.

This is not a classifier bug and not a settle-time bug. The classifier read the page correctly; the
page itself was wrong. Prime served its expiry shell transiently for a link that is alive.

It matters because of the **direction** of the failure. The transient turns a live, nearly complete
report into "dead link, park it and ask the builder to reissue" — the exact class of error the
captain rejected on the previous list. And the driver made it easy to hit: in the inherited
`capture.sh`, a form verdict must survive settling **and** the Job Details block laying out, while
`expired` breaks the poll loop after two identical readings. **The least-guarded verdict was the
destructive one.**

Fix taken here: `evidence/capture-expired.sh` requires an `expired` reading to survive a longer
stable window **and a full page reload** before it stands. That is what let me re-verify all 37 with
confidence. Recommendation: whoever productionises the portal capture path should invert the same
way — expired must be the hardest state to reach, never the easiest.

One honest limit: I observed the transient once, in the live→dead direction. All 37 genuinely dead
links stayed dead across two passes, so I have **no** evidence of the reverse (a dead link reading
alive), and no basis to estimate a rate from a single occurrence.

---

## 5. Why six roof cards have no attendance cycle — and it is a forward gap, not historical debt

`record_ses_portal_capture_evidence` requires `attendance_cycle_id` as a mandatory UUID. Six of my
cards have no cycle row at all, so **no capture can be recorded on them by any caller**. Diagnosed,
not worked around:

An attendance cycle is opened in exactly one runtime helper,
`ensureMakesafeAttendanceCycle` (`index.ts:16775`), reached from five call sites and no others:
`allocate_job`, `submit_makesafe_report`, `assignment_reassign`, `pack_bind`, and reattend. Beyond
that, the U2-S1 migration `20260727000001` ran a **one-time backfill** creating cycles 1..N for every
existing `makesafe_job_details` row.

The evidence lines up exactly:

| Card | Assignments | Cycles | Detail created |
|---|---:|---:|---|
| SWMS-26934 | 0 | 1 | 2026-07-08 — **before** the backfill |
| SWMS-261019 | 1 | 1 | 2026-07-21 — allocated, so `allocate_job` opened one |
| SWMS-26980 | 1 | 1 | 2026-07-27 — allocated |
| SWMS-261079 | **0** | **0** | 2026-07-27 |
| SWMS-261081 | **0** | **0** | 2026-07-28 |
| SWMS-261113 / 261114 / 261116 | **0** | **0** | 2026-07-31 |
| SWMS-261123 | **0** | **0** | 2026-08-01 |

Board-wide, 44 cards have no cycle and 40 of them were created on or after 2026-07-27, the backfill
date. By family: 22 general make-safe, 16 temp fence, **6 roof**.

**The mechanism, stated plainly.** A roof-portal card is never allocated to one of our trades and
never has a report submitted through our own endpoint, because the trade works in the *builder's*
portal. So none of the five cycle-opening paths is ever reached. The migration backfill hid this for
every card created before 27 July; every card created since arrives with no cycle. **The portal
capture path structurally requires a cycle that the portal-report families structurally never
create** — and the number grows with every new card.

This is the opposite shape to the `source_content_hash` debt in `CLAUDE.md`, which has a hard cutoff
and is closed. This one has a hard cutoff and is **open at the forward end**.

**No cycle was invented.** The sanctioned repair already exists and needs no new code:
`seed_makesafe_state_authority_scoped_v2` (`20260728060000_…_u2.sql:541`) inserts the missing cycle
with `open_reason = 'state_authority_seed_existing_job'` and binds it. That is the same scoped
seeder the parallel crew needs, reached through the `makesafe_state_seed_scoped` route that landed
in `3785001` — API-key-only, which is the credential above.

---

## 6. The 22 caseless cards

22 of 39 have no `makesafe_intake_cases` row at all. That guarantees `spine_missing_lineage`
(the blocker fires on `!lineage_id || !job_id || !source_content_hash`) and, behind it,
`invoice_reference_missing`, because the canonical builder reference resolves to the empty string.

Per `CLAUDE.md` this is the caseless-intake population, and the repair is the same scoped seeder,
not a hand edit. `SWMS-26934` is the one card in this class that also has a submitted report, so it
is the only one where the spine is the thing standing between a real report and a bill.

---

## 6a. The `captured_at` fix is real — proven against the two live rows

`d21ba19` canonicalises `captured_at` **inside** `sesPortalCaptureRevisionHash`, so the writer and
reader can no longer disagree on a timestamp's spelling and no stored digest changes. Verified
read-only against both live rows in `makesafe_portal_capture_revisions` by driving the real
production module over the persisted content (`evidence/verify-capture-hash.ts`):

```
SWMS-26934   spelling "2026-08-02 15:52:16+00"     match=true
SWMS-26934   spelling "2026-08-02T15:52:16+00:00"  match=true
SWMS-261019  spelling "2026-08-02 15:51:47+00"     match=true
SWMS-261019  spelling "2026-08-02T15:51:47+00:00"  match=true
```

Both spellings verify, so the fix holds whichever form PostgREST returns. **`portal_capture_invalid`
is genuinely cleared on both cards** — that blocker is closed, measured rather than assumed.

## 7. The storey fact: two independent sources that agree

Batch 4 recorded that no roof card carries the explicit single/double storey fact U4 requires. That
is still true: **zero of 61 roof cards** carry a structured storey fact anywhere U4's
`structuredSourceFact` looks, and none of my four locked cards has a roof draft either.

There are two different facts here and it matters which one prices the job:

- **What the builder ORDERED**, read off the work-order instruction. This is the sanctioned input —
  `roofStoreyOrderedProductFact` in `makesafe_roof_storey_fact.ts`, deliberately narrow, and the
  module is explicit that widening the source re-introduces narrative inference on the money path.
- **What the trade OBSERVED**, the `Number of Storeys` field on the builder's locked Prime form.
  U4 does not read this and should not; I harvested it as corroboration, not as the pricing input.

### 7.1 The two sources agree on all four locked cards

Harvested read-only from the locked Prime reports (`evidence/roof-storey-facts.jsonl`,
extractor `evidence/storey.js` — never clicks, fills or dispatches events), then compared against
the production matcher run over the exact instruction text the backfill assembles:

| Card | Suburb | Builder ORDERED (sanctioned matcher) | Trade OBSERVED (Prime form) | Agree | Price |
|---|---|---|---|---|---|
| SWMS-261019 | Floreat | `single` — *"single storey roof report"* | Single Storey | ✅ | $250 ex |
| SWMS-261079 | Floreat | `double` — *"two storey roof report"* | Double Storey | ✅ | $350 ex |
| SWMS-26934 | Seville Grove | `single` — *"single storey roof report"* | Single Storey | ✅ | $250 ex |
| SWMS-26980 | Gwelup | `double` — *"two storey roof report"* | Double Storey | ✅ | own-template |

Four of four, from two entirely independent sources — one written by the builder before the job, one
filled in by the trade on site afterwards. That is the corroboration worth having before a
money-path write on a sealed card.

### 7.2 A read-only preview of the whole roof family

I ran the **production** matcher — `roofStoreyOrderedProductFact` over
`roofStoreyBackfillSourceText`, the same two functions the sanctioned backfill calls, so a preview
cannot disagree with the write — across all 50 live roof cards (`evidence/storey-preview.ts`,
`evidence/roof-storey-matcher-preview.json`):

| Matcher verdict | Cards |
|---|---:|
| `single` | 28 |
| `double` | 11 |
| **resolvable total** | **39 of 50** |
| no storey named in the instruction | 10 |
| refused, three storeys have no sealed price | 1 |

**So the storey wall is 39 cards wide and already answerable from the builder's own words.** The
one refusal is the Joondalup three-storey card and it is correct behaviour, not a gap.

### 7.2b The full disposition, not just the match

The match is not the whole rule, so I also drove the real
`buildRoofStoreyBackfillRow` — the production function the sanctioned action itself calls — over
the same 50 cards with their `metadata`, `scope_json` and detail rows
(`evidence/storey-dispositions.ts`, `evidence/roof-storey-backfill-dispositions.json`):

| Disposition | Cards |
|---|---:|
| **`write`** — a priceable storey, eligible | **38** |
| `no_fact` — the instruction names no storey | 10 |
| `hold_competing_storey_signal` — a human decides | 1 |
| `refused_no_sealed_price` — three storeys | 1 |

**38 of 50 live roof cards are eligible to write**, which is the number worth taking to the captain.
The one hold is `SWMS-26848` (Dianella): it resolves `double` but already carries a storey signal
elsewhere in its record, and the backfill correctly refuses to write a second value — doing so can
make `structuredSourceFact` return `undefined` and stop a card that prices today. The one refusal is
`SWMS-26930` (Joondalup), the three-storey card batch 4 flagged for a captain price decision; the
two agree, which is a useful independent check on both.

**All four of my locked cards come back `write`** (261019 single, 261079 double, 26934 single, 26980
double) — matching both the instruction matcher and the trade's own form.

Every one of these cards is `ses_money_sealed_at` sealed, which is exactly why that action is
dry-run-by-default and why each row is meant to be read and refused one at a time by a human.
**I wrote nothing, and this preview is a read-only local computation over production reads — it is
not a substitute for running the action's own dry run once the credential is available.**

### 7.3 What the trade's own form recorded

Full harvest from the four locked reports, each with its screenshot
(`evidence/roof-storey-facts.jsonl`):

| Card | Suburb | Storeys | Roof type | Form state |
|---|---|---|---|---|
| SWMS-261019 | Floreat | Single Storey | Terracotta Tiles | locked, 22 of 24 |
| SWMS-261079 | Floreat | Double Storey | Terracotta Tiles | locked, 22 of 24 |
| SWMS-26934 | Seville Grove | Single Storey | Terracotta Tiles | locked, 21 of 23 |
| SWMS-26980 | Gwelup | Double Storey | Terracotta Tiles | locked, 20 of 23 |

I recorded nothing to production: with no credential I could not, and the sanctioned write paths are
`record explicit roof storey facts at intake` (`debdc91`, forward only) plus the preview backfill
(`de59202`) for existing cards.

**Correcting my own earlier framing in this run.** I first wrote that this harvest was "exactly what
`pricing_evidence_missing` asks for". It is not — U4 reads storeys through `structuredSourceFact`
and our own roof draft, and the Prime form is neither. The harvest's value is corroboration of the
builder-instruction matcher (§7.1), not substitution for it.

---

## 8. What would actually happen with the key

**I had this wrong first time and the correction is load-bearing.** My initial prediction was
"SWMS-261019 goes to Docs Ready with the credential alone". It does not. `pre_xero_docs_ready`
requires **zero blockers AND a non-null invoice proposal** (`validatePreXero`,
`ses_prepare_docket_revision.ts:1315`), and `pricing_evidence_missing` both nulls the proposal and
adds a blocker. With no structured storey fact on any of 61 roof cards, **every roof card stays
`blocked` no matter what else is fixed.** The storey backfill is not an optional extra on the way to
Docs Ready in this family; it is on the critical path for all of them.

Corrected, and stated so it can be checked rather than believed:

| Card | Key alone | Key + storey backfill | Key + storey + scoped seeder |
|---|---|---|---|
| SWMS-261019 | still blocked, `pricing_evidence_missing` | **Docs Ready** — capture proven valid in §6a, spine complete, cycle bound | same |
| SWMS-261079 | still blocked | still blocked, `portal_capture_missing` — no cycle | **Docs Ready** |
| SWMS-26934 | still blocked | still blocked, `spine_missing_lineage` | **Docs Ready** (link now expired; the capture is banked and verifies) |
| SWMS-26980 | waiting on the trade | unchanged | unchanged |
| other 35 | unchanged — no report exists to bill | unchanged | unchanged |

So: **0 cards with the credential alone, 1 with the storey backfill, 3 with the seeder as well.**
Not twenty, and no honest sequence of fixes reaches twenty inside these two families.

The storey backfill is the highest-leverage of the three, and its reach is far wider than my slice:
it makes **38 of 50 live roof cards** eligible to write (§7.2b), so it is the unblock that matters for whichever
crew inherits them once the trade reports in. It is also the only one of the three that touches the
money path, which is why it is dry-run-by-default and wants the captain row by row.

---

## 9. Method and constraints

- Production reads: Management API `/database/query`, `read_only: true`, SELECT only. No client
  name, phone, email or street address was selected in any query. Suburb, job number and builder
  reference only.
- Screenshots: headless Chrome over CDP through `chrome-devtools-axi`, entering by the stored
  `/share/` URL. Capture is gated on **verified redaction** — `redact.js` returns `ok:false` if any
  `Customer` / `Site Address` label is uncovered or the page has not settled, and the driver refuses
  to take the picture. 47 images retained (37 dead-link, 9 live-link, 1 re-check), 0 withheld after
  the contention fix in §9.1, `covered=2 / labels=2 / uncovered=[]` on every form page, and all 37
  dead-link images share one hash.
- Redaction is additive overlay `div`s only. No page text and no form input was mutated, so autosave
  on live forms could not fire. No click, fill or submit anywhere.
- No live board URL was opened at all, so the `?noAutoIntake=1` requirement had no opportunity to be
  missed.
- The money seal was never bypassed, relaxed or worked around, and no money-path call was retried.

### 9.1 One process error of mine, and what it cost

I started the expired-link sweep in the background and then started a second sweep in the
foreground. Both drove the same Chrome instance, so pages were navigated underneath each other. Two
captures came back with redaction unverified and their screenshots correctly **withheld** — the gate
did its job — and one evidence file was truncated by the second run. Nothing was published from the
contended pass: I discarded those five results and re-ran them cleanly, which is where the final
37-of-37 comes from, and I deleted the contended run's stray images so `shots/` holds only final
evidence. Worth recording because the failure was otherwise silent, and because the same overwrite
behaviour is what lost the §4 artifact.

### 9.2 Two strikes

Only one repeated failure was hit: `ops-api` 401. It was reproduced twice (direct `curl`, then the
SecureSuite MCP), then reported and not retried, not credential-swapped, and not routed around.

---

## 9.3 The storey backfill, run for real on the captain's approval

Captain approved 2026-08-03 and confirmed the prices himself: single **$250 ex GST**, double
**$350 ex GST**, matching the schedule locked 2026-07-16. Verified against the sealed pricer before
writing — `roofReportPrice("single")` → $250 ex / $275 inc, `("double")` → $350 ex / $385 inc.

**Scope control.** `preview_makesafe_roof_storey_backfill` takes **no job list** — it selects every
`report_type='roof_report'` card itself and writes every `write` row, with only `dry_run` and
`expected_count` as controls. So "exactly the 39 in the committed preview" could not be enforced by
parameter. Instead I ran the dry run first and diffed its write set against the committed
`roof-storey-backfill-dispositions.json`:

```
live write set: 38     approved set: 38
in LIVE but NOT approved: []
in APPROVED but not live: []
storey value disagreements: []
SETS IDENTICAL: True
```

Both captain-named hold-outs were already outside the write set by the action's own rules:
`SWMS-26930` (three storeys, `refused_no_sealed_price`) and `SWMS-26848` (already carries a storey,
`hold_competing_storey_signal`). The captain's two exclusions and the code's two exclusions are the
same two cards, independently derived.

The 39-vs-38 reconciliation: 39 cards resolve to a priceable storey (28 single + 11 double), and
`SWMS-26848` is the eleventh double — held, not written. So 38.

**Applied** with `expected_count: 38` armed as the refuse-if-drifted guard:

```
ok: true   dry_run: false   error: null
counts: total 61, write 38 (28 single, 10 double), hold 1, refused 1, no_fact 11, excluded_terminal 10
write_candidates marked written: 38 of 38, none skipped
```

Verified independently in production rather than from the response: `jobs.metadata->>'storeys'` is
now `single` on 28 and `double` on 10 roof cards, and **both hold-outs are still `(none)`**.
Ledgers: `evidence/roof-storey-backfill-bf-dry.json`, `evidence/roof-storey-backfill-bf-apply.json`.

### Do all 38 actually clear `pricing_evidence_missing`?

Yes, and the one thing that could have broken it was checked rather than assumed.
`structuredSourceFact` returns `undefined` when it finds two **different** values across its roots,
which would leave a card blocked despite the write. Its roots include
`intakeCase.raw_identity_json`, which `competingStoreySignals` does **not** inspect — a real gap
between the guard and the reader.

Measured: 5 of the 38 carry a storey signal in `raw_identity_json` (`SWMS-261079`, `261113`,
`261114`, `261116`, `261123` — the newest cards, whose deterministic intake stores the instruction
text). **None is a keyed value**; all five are prose in the builder's instruction, which is the very
text the matcher read. `structuredSourceFact` collects values under matching keys, so prose produces
no competing value and no card resolves ambiguously.

**38 roof cards clear `pricing_evidence_missing`.** That blocker only — the spine, attendance-cycle,
portal-link and trade-evidence blockers on those cards are untouched.

One consequence to flag, from the action's own `state_moves`: **`SWMS-261019` has a persisted docket
revision that will be superseded** on its next prepare, because the storey fact changes the input
hash. That is expected and is the card becoming priceable, not a defect.

---

## 9.4 A repo defect this run surfaced, and one open question it leaves behind

Landing this evidence exposed a defect that has nothing to do with SES: **an evidence-only or
docs-only PR is unmergeable in this repository.** `deno-check` is the only required status on `main`
(`required_status_checks.contexts = ['deno-check']`), and `.github/workflows/pr-check.yml` matched
neither `data/**` nor the root markdown files — so such a PR triggers no workflow at all, the
required status never registers, and the PR sits at `BLOCKED` with zero checks forever.

Measured on this run's own PR #509 (68 files, all under `data/` plus `AGENTS.md`): `gh pr checks`
reported *no checks reported*, `statusCheckRollup` 0, `mergeStateStatus` BLOCKED.

Fixed in a **separate** PR (#510, CI green) rather than bolted onto this one, so it is judged on the
repo defect and not on getting this PR through: `data/**` and `*.md` added to the path list, paths
only, no job logic. It is the fourth instance of a bug that file already documents twice in its own
comments, for migrations/scripts and for the watchdog.

### The open question, recorded so it is not lost

Adding these paths means the required status now **registers** — and the `deno-check` job runs
**seven unconditional steps** that are not gated on `has_changes`:

```
Shell syntax check on deploy scripts
Test ops-api action-surface smoke contract
Test bundled ops-api deploy metadata
Test Edge Function schema preflight
Test migration auto-apply
Check migration extension schema contract
Test edge deploy workflow classification
```

Only the deno check and deno cache steps are guarded. **So a data-only PR can now go red if `main`
is red.** This does not turn BLOCKED into guaranteed GREEN; it turns blocked-forever into
coupled-to-main's-health.

That was accepted deliberately, on precedent: migrations-only, scripts-only and watchdog-only PRs
already carry exactly this coupling and the repo has accepted it three times, and those seven steps
test repo invariants a data-only change cannot move, so they are green whenever `main` is green.

**Open: should those seven steps be gated on relevant changes?** It is a real question and it was
deliberately NOT answered in #510, because it changes shared CI behaviour for every contributor and
does not belong attached to a paths fix. It needs its own change and its own decision.

*(This corrects an earlier claim of mine in the #510 commit message that both jobs "already no-op to
pass". They do not — only two of twelve steps are guarded. The review caught it and the commit
message was rewritten before it landed.)*

---

## 10. Open items for firstmate

1. **The `SW_API_KEY` that will not authenticate** — blocks both crews, every write and every U4 dry
   run. Nothing in either brief is reachable without it. The Management API cannot supply it (it
   returns digests); the captain has to paste it. Check the redeploy question in the credential
   section first — the secret changed 3h07m *after* `ops-api` was last deployed.
2. **DONE — the storey backfill ran** (§9.3): 38 roof cards written, both hold-outs excluded, all 38 clear `pricing_evidence_missing`. Originally flagged as: on the critical path for the whole roof family, not just my three
   cards. `pricing_evidence_missing` blocks `pre_xero_docs_ready` outright, no roof card carries the
   fact, and the sanctioned backfill would write **38 of 50** live roof cards from the builder's own
   instruction text today (§7.2). Dry-run-by-default, money-path, wants the captain row by row. The
   read-only preview is committed at `evidence/roof-storey-matcher-preview.json`.
3. **The forward attendance-cycle gap (§5)** — 44 cards board-wide and growing, because no
   cycle-opening path is reached by a card whose trade works in the builder's portal. The scoped
   seeder repairs today's; it does not close the forward hole.
4. **The transient Prime expiry page (§4)** — real, observed once, in the dangerous direction.
   Recommend hardening `expired` to require a reload wherever this path is productionised. The
   23-card reissue list itself is re-verified and safe to send.
5. **The 5 unsubmitted forms** — trade chase, not a builder reissue. `SWMS-261113` and
   `SWMS-261114` are still at 0 of 22 answered, unchanged in 24 hours. `SWMS-261081` (Mindarie) is
   the opposite case and the cheapest chase on the board: 21 of 23 answered with the **Submit button
   rendered**, so the trade is two fields and one press from a billable report. `SWMS-261116` (21 of
   24) and `SWMS-261123` (19 of 23) are close behind.
6. **`SWMS-26934`'s link expires at 4:46 pm today.** The report is submitted so no reissue is
   needed, but `shots/f41c5a7e.png` is the last copy anyone gets. If the spine repair happens after
   that, the capture has to come from this image rather than from the live page.
7. **Storey facts for 4 cards are now evidenced (§7)** and can be recorded through the sanctioned
   intake/backfill route whenever someone has the credential.
