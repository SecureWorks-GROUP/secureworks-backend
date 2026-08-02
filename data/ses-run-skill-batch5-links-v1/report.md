# Batch 5 — drive the roof-portal and assessment families to Docs Ready

**Agent:** `ses-run-skill-batch5-links-v1`
**Date:** 2026-08-03 AWST
**Slice:** `ses_family ∈ {ordinary_roof_portal, assessment_quote}` only. No physical make-safe, no
temporary fencing, no change to the invoice-obligation path.
**Mode:** production reads via Supabase Management API `read_only: true`, SELECT only, plus headless
CDP screenshots of builder share links. **No production write was possible — see the credential
section.** No card archived, completed, cancelled or sent; no invoice created, authorised or sent;
no email drafted; the money seal was never touched.

---

## The table

| Card | Suburb | Outcome | Evidence |
|---|---|---|---|
| SWMS-261019 | Floreat | **blocked by us** | report submitted + locked 22/24, `shots/d2ff4956.png`. Spine complete, cycle bound, capture row already written. Held ONLY by the rotated ops-api key. |
| SWMS-261079 | Floreat | **blocked by us** | report submitted + locked 22/24, `shots/f280ebb0.png`. Held by **no attendance cycle** (class of 6) + the key. |
| SWMS-26934 | Seville Grove | **blocked by us** | report submitted + locked 21/23, `shots/f41c5a7e.png`. Held by **no intake case** (spine) + the key. **Link expires 4:46 pm today** (captured 06:20, still live) — this is the last screenshot anyone gets of it. |
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

**The 3 "blocked by us" rows are two classes and one credential, not three separate problems:**

| Blocker | Cards | Class or one-off |
|---|---|---|
| ops-api `SW_API_KEY` rotated; every `x-api-key` call 401s | all 3 (and all 39) | **class** — blocks the whole board, both crews, every write and every U4 dry run |
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

- **SWMS-261019** is genuinely one unblock from Docs Ready. Spine complete, cycle bound, portal
  capture row already written, storey fact now evidenced. Only the credential stands in front of it.
- **SWMS-261079** cannot have capture evidence written at all — it has no attendance cycle.
- **SWMS-26934** has no intake case, so its canonical builder reference is empty and its spine is
  missing. Its link expires at 4:46 pm today; I captured it at 06:20 while it was still live.
- **SWMS-26980** is `own_template_roof`, the exception in the captain's own ruling. It is not a link
  check and is correctly waiting on the trade to submit our template.

## And the thing that stopped every write

**The local `SW_API_KEY` is stale — production rotated it.** Every `x-api-key` call to `ops-api`
returns `401 Unauthorized`, including the SecureSuite MCP (`sw_ops_summary` → 401). This is not a
seal refusal and not a permission boundary; the key on disk (dated 19 Jul) no longer matches the
deployed secret. `MAKESAFE_ROUTINE_KEY`, the other caller identity
`prepare_ses_docket_revision` accepts, is not on this machine either.

Consequence: **no U4 dry run, no docket persist, no portal-capture write.** Raised to firstmate as
`needs-decision [key=ops-api-credential]` and not routed around. The current key IS readable from
the Management API secrets endpoint with the token I was issued; I verified only that it exists and
that its hash differs from the local copy, and did **not** use it without authorisation. The
parallel crew hit the identical wall independently (`[key=b5-ops-key]`), which confirms it is
environmental rather than anything about this worktree.

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

## 7. Storey facts, harvested from the locked reports

Batch 4 recorded that no roof card carries the explicit single/double storey fact U4 requires, and
that "somebody has to record single-or-double per card, from the source work order". **The fact is
on the builder's own locked report page**, which our capture already loads. Harvested read-only from
the four locked reports, each with the screenshot behind it:

| Card | Suburb | Storeys | Roof type | Form state | Locked-report price (ruling of 2026-08-03) |
|---|---|---|---|---|---|
| SWMS-261019 | Floreat | **Single Storey** | Terracotta Tiles | locked, 22 of 24 | $250 ex GST |
| SWMS-261079 | Floreat | **Double Storey** | Terracotta Tiles | locked, 22 of 24 | $350 ex GST |
| SWMS-26934 | Seville Grove | **Single Storey** | Terracotta Tiles | locked, 21 of 23 | $250 ex GST |
| SWMS-26980 | Gwelup | **Double Storey** | Terracotta Tiles | locked, 20 of 23 | own-template, priced separately |

Machine-readable in `evidence/roof-storey-facts.jsonl`; extractor in `evidence/storey.js`
(read-only, never clicks, fills or dispatches events).

**This is source-evidenced, not inferred**, which is exactly what `pricing_evidence_missing` asks
for — the pricing rule refuses to guess storeys, and it no longer has to. I recorded nothing to
production: with no credential I could not, and the storey write path is `record explicit roof
storey facts at intake` (`debdc91`) plus the preview backfill (`de59202`), which are the sanctioned
routes.

Worth carrying forward as a capability note: the storey fact is one regex away from being captured
by the portal observer at the same moment it proves the report is submitted. The observer already
loads the page; it just does not read that field.

---

## 8. What would actually happen with the key

Stated as a prediction so it can be checked rather than believed:

| Card | With the key alone | With the key + scoped seeder |
|---|---|---|
| SWMS-261019 | **Docs Ready**, if `d21ba19` really fixed the capture hash | same |
| SWMS-261079 | still blocked, `portal_capture_missing` — no cycle | **Docs Ready** |
| SWMS-26934 | still blocked, `spine_missing_lineage` | **Docs Ready** (link now expired, but the capture is banked) |
| SWMS-26980 | still waiting on the trade | unchanged |
| other 35 | unchanged — no report exists to bill | unchanged |

So: **1 card with the credential, 3 with the credential and the seeder.** Not twenty, and no honest
sequence of fixes gets to twenty inside these two families.

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

## 10. Open items for firstmate

1. **The rotated `SW_API_KEY`** — blocks both crews, every write and every U4 dry run. Nothing in
   either brief is reachable without it.
2. **The forward attendance-cycle gap (§5)** — 44 cards board-wide and growing, because no
   cycle-opening path is reached by a card whose trade works in the builder's portal. The scoped
   seeder repairs today's; it does not close the forward hole.
3. **The transient Prime expiry page (§4)** — real, observed once, in the dangerous direction.
   Recommend hardening `expired` to require a reload wherever this path is productionised. The
   23-card reissue list itself is re-verified and safe to send.
4. **The 5 unsubmitted forms** — trade chase, not a builder reissue. `SWMS-261113` and
   `SWMS-261114` are still at 0 of 22 answered, unchanged in 24 hours. `SWMS-261081` (Mindarie) is
   the opposite case and the cheapest chase on the board: 21 of 23 answered with the **Submit button
   rendered**, so the trade is two fields and one press from a billable report. `SWMS-261116` (21 of
   24) and `SWMS-261123` (19 of 23) are close behind.
5. **`SWMS-26934`'s link expires at 4:46 pm today.** The report is submitted so no reissue is
   needed, but `shots/f41c5a7e.png` is the last copy anyone gets. If the spine repair happens after
   that, the capture has to come from this image rather than from the live page.
6. **Storey facts for 4 cards are now evidenced (§7)** and can be recorded through the sanctioned
   intake/backfill route whenever someone has the credential.
