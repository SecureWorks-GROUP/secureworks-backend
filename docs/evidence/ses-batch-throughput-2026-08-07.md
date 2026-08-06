# The docket-and-draft path at batch scale — measured, 2026-08-07

Question asked: **can the docket-and-draft path take roughly twenty cards through as a
batch without degrading?** Every mint before tonight had been proved one card at a time.

**Throughput was never the constraint, and it is not the answer.** The happy path holds
comfortably at twenty (§3). The thing that decides the safe chunk size is **what a
half-completed batch leaves behind**, and that is the finding this document leads with.

## The answer: run it in fours

**Four cards per chunk. Not twenty at once, and not ten twice.** Reasoning in §2, but the
short form:

- There is **no cross-card state** on this path, so **the chunk size IS the blast radius,
  one for one**. Attempting twenty is choosing twenty as the maximum number of cards that
  can be left needing hand recovery.
- A card that fails **before Xero is reached** is recorded as effect state `unknown` and is
  **permanently unmintable on that invoice obligation revision** (§1). It is not retryable.
  Recovery is a fresh `prepare_ses_invoice_obligation`, roughly **two minutes of careful
  hand work per card**. Two or three of those is a fix. Six is a morning.
- **Chunking costs nothing.** Machine time for 5×4 is the same 4–6 minutes as 1×20;
  throughput has ~5× headroom over what the batch needs. Spending it on recoverability is
  free.
- Chunk boundaries are where you **learn the failure class before it repeats**. A poisoned
  card in chunk one gets fixed for chunks two through five. At twenty you find out once,
  after all twenty.

**Hard ceiling if a bigger chunk is insisted on: ten**, and only after the §2 pre-flight.
Above ten, one bad class of card produces more stuck cards than anyone can hold in
their head.

---

## 1. The defect that turns a batch failure into an incident

**A refusal that happens before Xero is ever called is recorded as "outcome unknown", and
that card can then never mint again on its current invoice obligation revision.**

`executeSesExternalEffect` catches **every** throw out of `adapter.dispatch` and records
`dispatch_outcome_unknown`. But on the SES mint, `createInvoice` **is** the dispatch, and it
contains at least ten deterministic refusals that fire **before a single Xero call**: the
sealed money fence, `assertSealedSesInvoiceCreateIsUnique`,
`assertNoSyntheticLivefireJobs`, `assertMakesafePortalVerifiedForDraftInvoice`,
`assertMakesafeReportInForInvoice`, `preflightInvoiceCreation`, missing line items, missing
contact, the report-charge check — plus any Xero non-2xx, including a 429.

Every one of those is a case where the invoice **definitively does not exist**. All of them
are recorded as "outcome unknown, reconcile Xero, do not create another invoice."

Then `claim_ses_external_effect_v1` returns `claim_mode = 'reconcile'` for **every**
non-confirmed state. So the retry can only reconcile, the reconcile finds nothing (because
nothing was ever created), and the card is stuck. **The safe failures are being treated as
the unsafe ones.**

**This is live, once, right now.** `ses_external_effects` holds one `unknown`
`invoice_create`, created 2026-08-05 07:58:33 on SWMS-261114, `external_id` null, failure
message: the portal-truth guard. Nothing reached Xero. That card recovered at
2026-08-06 00:29 — **16.5 hours later, and only via a third invoice obligation revision.**

### What it costs at batch size, measured

The dominant trigger is checkable in advance, and the numbers are not comforting for a
roof-heavy batch. Of the 41 cards currently in `admin_to_send_report`, five are report-type
(roof), and **two of those five have no current-cycle portal verification** — so a mint
attempt on them throws the portal guard and burns their obligation revision. The predicted
batch is roughly **fifteen roofs**, i.e. weighted toward exactly the family that trips this.
At the observed rate that is **~6 stuck cards in a 15-roof batch**. That is not a fix, it is
an investigation.

### Its likely companion at scale

`selection.mode: "board_batch"` — the in-repo batch path — is an **unbounded `Promise.all`
over up to 50 full docket assemblies inside one edge isolate**, persisting per card (§6).
It has never been run in production. If it is ever reached for as "the batch path", the two
defects compound in the worst possible order: the isolate dies part-way with an arbitrary
subset committed, `Promise.all` discards the survivors' results so the caller cannot even
learn which, and any card that got as far as a mint refusal is separately poisoned. **Drive
batches card-by-card from the client. Do not use `board_batch`.**

### Neither is fixed here, deliberately

The `unknown` classification needs the effect ledger to distinguish "definitely not
dispatched" from "outcome ambiguous" and permit re-dispatch from the former.
`claim_ses_external_effect_v1` returns `reconcile` for every non-confirmed state, so **that
is a migration** — named, not attempted the night before a no-coding day. `board_batch`
needs a design decision, not a patch, and bounding its concurrency does not obviously fix
it (concurrency 1 trades a memory blowout for a wall-clock risk; 2–3 is still over the heap
ceiling for photo-heavy cards). Neither omission changes tomorrow: the proven path does not
touch `board_batch`, and the `unknown` behaviour is what production already has.

One fix **was** landed, because it converts a transient batch-only failure into a
permanently poisoned card and is small enough to prove: `xeroPost` now retries a 429 when
an Idempotency-Key was supplied (§8).

---

## 2. The chunk size, and how a failure is recovered

### Telling a safe refusal from a poisoned one — at the moment it happens

This is the part that keeps a failure from becoming an investigation, and it works
**per card, in the response body**, so nobody has to reconstruct it afterwards:

| refusal code in the 409 | what it means | what to do |
|---|---|---|
| `invoice_duplicate_live` | The duplicate guard blocked. It runs **before** `buildSesEffect`, so **nothing was written**. | Safe. Investigate the existing invoice, re-run whenever. |
| `invoice_duplicate_ambiguous` | Same — pre-effect, nothing written. | Safe. Needs adjudication, not recovery. |
| **`xero_outcome_unknown`** | **Poisoned.** The effect row exists in state `unknown`. | **Not retryable.** Needs a fresh `prepare_ses_invoice_obligation`. |

The whole-batch version of the same question is one read-only query:

```sql
select job_id, created_at, failure
from ses_external_effects
where effect_kind = 'invoice_create' and state = 'unknown'
```

Anything it returns is a stuck card. Anything it does not return either succeeded or
refused cleanly.

### Recovery, per stuck card

1. **Confirm no invoice exists** — by **reference**, in Xero, not by the board flag and not
   by a `job_id` join (§7 — `job_id` is NULL on 158 PAID / 18 AUTHORISED / 3 DRAFT ACCREC
   rows, so a join reads as "nothing there" when there is).
2. `prepare_ses_invoice_obligation` for that job — a new revision mints a new
   `operation_key`, which bypasses the poisoned effect row rather than fighting it.
3. `create_ses_invoice_draft` against the new revision id.

**Never** try to force the old effect through. Reconcile-only is what stops double-minting
and must stay.

Call it **~2 minutes per card** done carefully, most of it in step 1.

### Why four

| chunk | worst case stuck | hand recovery | verdict |
|---|---|---|---|
| 4 | 4 | ~8 min | a fix — the failures are still in front of you |
| 10 | 10 | ~20 min | borderline; needs the pre-flight below to be honest |
| 20 | 20 | ~40 min | an investigation, at 8am, in front of him |

Machine time is identical either way — 5×4 and 1×20 are the same 4–6 minutes of work
(§3f) — so the only thing traded away is the operator's attention between chunks, and that
is the thing worth buying.

### Pre-flight, before each chunk (read-only, both)

- **Portal verification for report-type cards.** A roof card whose
  `portal_verified_cycle <> cycle_number` will throw the portal guard and burn its
  revision. Fix it with `mark_makesafe_portal_report_done` **first**, or leave it out of the
  chunk. This converts the dominant failure from "poisoned card" into "card not in this
  batch".
- **Existing Xero draft, by reference.** Per §7, the board publishes `missing_invoice` for
  cards that already have a hand-made DRAFT. The guard catches it, so it is safe — but it
  is a refusal you would rather predict than discover.

### Would I run twenty at once?

No. Not because it fails — it demonstrably does not on the happy path — but because the
failure mode is **per-card and permanent**, and the only thing bounding how many cards end
up permanently stuck is how many were attempted before anyone looked.

---

## 3. Measured behaviour at batch size

### 3a. Live run tonight — 20 cards, sequential, cold, `dry_run: true`

Twenty real cards from the live `admin_to_send_report` queue (14 general_makesafe,
3 temp_fence_makesafe, 3 roof_report), one HTTP call each, back to back:

| | value |
|---|---|
| requests | 20 |
| HTTP status | **20 × 200**, zero 5xx, zero 546, zero 429 |
| total wall | **120.5 s** |
| per card | mean 5.97 s, p50 5.38 s, p90 16.7 s, max 17.8 s, min 0.83 s |
| degradation by position | **none** — first ten 48.6 s, last ten 70.9 s, and the two slowest cards were positions 14 and 17 |
| rows written | **zero** (docket revisions 232→232, artifacts 7875→7875, effects 127→127, ACCREC 1180→1180) |

Stage totals across the twenty: **T5 = 98.3 s of 119.5 s (82 %)**, T3 6.0 s, T1 4.8 s.
T5 and T3 are the stages that fetch objects out of storage, so the cold cost of this
path is **object reads, not CPU and not the database**.

Re-running the same twenty warm: **21.6 s total**, T5 collapsing 98.3 s → 9.2 s. That
5.6× is a storage-cache effect and must **not** be used for planning — tomorrow's batch
is twenty cards nobody has read yet, so the cold number is the honest one.

### 3b. Live run tonight — concurrency

| shape | cards | wall | result |
|---|---|---|---|
| sequential, cold | 20 | 120.5 s | 20 × 200 |
| concurrency 5, cold (a different, untouched 19 cards) | 19 | **33.0 s** | 19 × 200, max card 17.8 s |
| concurrency 5, warm | 20 | 28.8 s | 20 × 200 |
| concurrency 20, warm | 20 | **6.0 s** | 20 × 200, max card 5.9 s |

Concurrency scales close to linearly and **per-card latency does not inflate**. Twenty
simultaneous ops-api invocations were served without a single error, so there is no
ops-api-side rate limiter and no shared bottleneck in the request path.

### 3c. Production history — the persisting path, which is heavier than dry-run

`dry_run: true` deliberately takes proof-only routes for photos and the physical report
(`resolvePhotoProofs` instead of `resolvePhotoArtifacts`), so it skips the byte work. The
real cost is already recorded per prepare in `makesafe_docket_revisions.duration_ms` /
`stage_durations_ms`. All 232 production prepares, 2026-08-02 → 2026-08-06:

| family | n | p50 | p90 | max | avg artifacts | avg artifact MB |
|---|---|---|---|---|---|---|
| general_makesafe | 218 | 7.88 s | 18.75 s | **32.0 s** | 35 | **12.6 MB** |
| roof_report | 13 | 2.03 s | 2.48 s | 2.67 s | 13 | 0.3 MB |
| repair | 1 | 8.96 s | — | 8.96 s | 40 | 11.4 MB |

**A roof card is ~4× cheaper than a make-safe card**, which matters because the predicted
batch is roughly fifteen roofs plus five to ten make-safes.

### 3d. Twenty cards has already happened, in production, successfully

Grouping the 232 prepares into runs (gap < 90 s), production already contains:

| run | revisions | distinct cards | wall span |
|---|---|---|---|
| 2026-08-03 00:12 | 17 | **17** | **82 s** |
| 2026-08-03 16:13 | 14 | 14 | 352 s |
| 2026-08-03 00:03 | 13 | 13 | 86 s |
| 2026-08-04 23:26 | 11 | 11 | 275 s |

Duration by position inside runs of ≥ 4 shows **no climb**: position 1 avg 8929 ms,
position 4 avg 10186 ms, position 9 avg 4145 ms, position 17 7029 ms. There is no
per-worker CPU or memory accumulation across rapid sequential calls at this scale.

Caveat, stated because it is real: this table only contains prepares that **committed**.
A prepare killed by a worker limit writes no row, so this is survivorship-biased evidence
of success, not proof that nothing ever failed. The live run in §1a is the unbiased half —
79 requests tonight, all 200.

### 3e. The mint half

Only 36 confirmed `invoice_create` effects have ever run. The tightest real burst is
2026-08-04 14:11:21 → 14:11:39: **four mints at 5–6 s intervals**, Xero dispatch phase
2192 / 2145 / 2271 / 2121 ms — **dead flat**. So a full `create_ses_invoice_draft` call is
about **6 s**, of which ~2.2 s is Xero and the rest is the duplicate guard, revision reads,
PDF store and bind.

### 3f. What a twenty-card batch therefore costs

Predicted shape (15 roof + 8 make-safe), sequential, cold, real (persisting) prepares:

- docket: 15 × 2.07 s + 8 × 9.39 s ≈ **106 s**; at p90, ≈ **187 s**
- draft mint: 23 × 6 s ≈ **138 s**
- **whole batch to DRAFT ≈ 4–6 minutes**

---

## 4. Does anything serialise that should not?

No. Both concurrency primitives on this path are **per-card scoped**:

- `commit_makesafe_docket_revision_v1` takes
  `pg_advisory_xact_lock(hash(job_id || ':' || idempotency_key))`. Two different cards
  never contend. Two prepares of the *same* card with the same key serialise and the
  second returns the existing revision, or raises `input_hash_conflict` if the content
  moved — which is the correct answer, not a bug.
- `claim_ses_external_effect_v1` takes `pg_advisory_xact_lock('ses-effect:' || operation_key)`,
  and the operation key is derived from the invoice obligation revision id. Again per card.

The uniqueness guard is `UNIQUE (job_id, idempotency_key, assembler_version,
family_matrix_version)` — also per card. **There is no global lock, no global counter, and
no shared cursor on the docket-and-draft path.** Rapid sequential and concurrent use are
both safe with respect to shared state.

---

## 5. Rate limits, timeouts and resource ceilings that appear only at batch size

### 5a. The duplicate guard — big, but not the problem

`fetchAllAccrecInvoices` pages every live ACCREC row on **every** mint. Measured:
**1180 ACCREC rows, ~775 kB of `line_items`, ~595 kB of the rest of the projection**,
fetched as **3 serial PostgREST pages** (page size 500, bounded at 40 pages). Twenty
mints is 60 page reads and ~15–20 MB of JSON — real, but it is already inside the
measured 6 s per mint and it does not compound across calls. Do not "optimise" it; it is
the money fence.

### 5b. Xero's 60-calls-per-minute ceiling — the real batch-only ceiling

One `create_ses_invoice_draft` makes **4 Xero API calls**:

1. `GET /Contacts?where=Name==…` — SES suppresses the email lookup, and
   `xero_contact_id` is backfilled onto the *job*, so a new card always pays this
2. `GET /TrackingCategories`
3. `PUT /Invoices` (the create)
4. `GET /Invoices/{id}` as PDF, via `tryStoreSesDraftInvoicePdf`

`getToken` reads the DB and only refreshes within 2 minutes of expiry, so it adds at most
one or two calls per batch, not per mint.

Xero allows **60 calls per minute per tenant**. At the measured 6 s per mint, twenty
mints is **80 calls over ~120 s = 40 calls/min — under the limit, with 33 % headroom.**

**Threshold: the ceiling is reached at about 15 mints per minute.** Sequentially the path
cannot get there. **Two concurrent mint chains can** (80 calls/min), and so can any future
change that speeds a mint below 4 s. So: **mint sequentially. Never fan out the mint.**

Calls 1 and 2 are pure waste — the same two answers for every MLB card — and caching them
would halve the per-mint Xero budget. Named, deliberately not done tonight.

### 5c. Nothing else fired

No ops-api rate limiter exists (20 simultaneous invocations, 20 × 200). No worker
resource limit (HTTP 546) was reached in 79 requests. No timeout: the slowest single
production prepare on record is 32.0 s against a wall-clock budget in the hundreds.

---

## 4b. Exactly what a half-completed batch leaves behind

The defect itself is §1 and the operating consequence is §2. This is the full per-failure
map, for the record.

Cards one to eleven of a batch that dies at twelve are **fully independent** — each is its
own HTTP call, its own transaction, its own effect row. Nothing rolls back and nothing is
left half-written. **Cards 1–11 are done and stay done.**

Card twelve depends entirely on *where* it failed:

| failure point | effect state | next attempt | resumable? |
|---|---|---|---|
| duplicate guard refuses (409) | *no row written* | re-runs cleanly | **yes** |
| indexed probe refuses (409) | *no row written* | re-runs cleanly | **yes** |
| Xero created it, response lost | `unknown` | reconcile by token **finds** it, confirms, binds | **yes, self-healing** |
| Xero created + confirmed, bind write failed | `confirmed` | dup guard sees it, `sameObligation` repair path binds | **yes, self-healing** |
| **anything that throws before Xero** | **`unknown`** | reconcile finds nothing | **NO — §1** |

Note the shape of that table: **the only self-healing failures are the ones where Xero
actually did something.** Every failure where it definitively did not is the permanent one.
That is backwards, and it is the whole of §1.

The honest one-line statement:

> **Partial failure never double-mints, and never corrupts the cards that succeeded. But a
> card that fails before Xero is not retryable — it needs a fresh
> `prepare_ses_invoice_obligation` before it can mint at all. The batch is resumable
> card-by-card, not by re-running the same command.**

---

## 6. `board_batch` — the one way to break this

`prepare_ses_docket_revision` accepts `selection: { mode: "board_batch", limit: 1..50 }`.
It resolves cards from `makesafe_job_details` where `substatus = 'admin_to_send_report'`,
oldest `updated_at` first, and then runs:

```ts
const results = await Promise.all(selections.map((selection, index) => prepareOne(...)))
```

**Unbounded fan-out, up to fifty full docket assemblies, inside one edge isolate.** Four
separate things are wrong with it at batch size:

1. **Memory.** Production general_makesafe prepares average **12.6 MB of artifacts** each,
   and this file's own standing note records the docket persist path costing **206–280 MB
   of heap for a single 33.5 MB photo set** (a 6–8× re-encoding multiple). Twenty
   concurrent make-safe cards is ~250 MB of raw bytes before that multiple. Against a
   ~256 MB isolate, that is an HTTP 546, not a slow response. Currently in the queue:
   **28 cards carrying 593 current-cycle photos, 244.5 MB total; heaviest card 20.0 MB /
   50 photos; p50 6.7 MB.**
2. **Partial persistence.** `prepareOne` persists per card. A 546 part-way through leaves an
   arbitrary subset committed with no way for the caller to learn which.
3. **`Promise.all` rejects on the first throw**, discarding the other nineteen results even
   though those cards already persisted. The caller gets one error and no manifest.
4. **The queue head is a quarantined card.** Ordered oldest-`updated_at`-first, the current
   head of `admin_to_send_report` is **SWMS-26845 (Queens Park), last touched
   2026-06-30** — one of the four cards under a do-not-touch instruction. Any `board_batch`
   run starts there.

**It has never been used.** Zero of 232 production docket revisions carry the
`:job:<n>` idempotency-key suffix that `board_batch` mints, and it appears nowhere in
`docs/` or `data/`. Deliberately left alone rather than redesigned the night before a
no-coding day: the proven path is unaffected by it, and bounding the concurrency does not
obviously fix it either (concurrency 1 trades a memory blowout for a wall-clock risk on a
20-card single request, and concurrency 2–3 is still over the heap ceiling for
photo-heavy cards).

**Do not reach for `board_batch` as "the batch path".** Drive the batch card-by-card from
the client, which is the shape that has been measured and the shape production has always
used.

---

## 7. Board `missing_invoice` is not authority to mint — and the guard already knows

Reported separately tonight: the board publishes `missing_invoice` for cards that already
have a hand-made Xero DRAFT nobody linked. Verified and quantified here because it is a
mint-safety input at batch scale.

Live: **3 unlinked live ACCREC DRAFTs** (`job_id` NULL), 1180 ACCREC rows in total, of
which 158 PAID / 18 AUTHORISED / 3 DRAFT are unlinked. The two named cards:

| card | card's `external_ref` | unlinked DRAFT reference |
|---|---|---|
| SWMS-261015 | `MLB-26658PO-56313` | INV-1115 `MLB-26658PO-56313` |
| SWMS-261021 | `MLB-27037` | INV-1116 `MLB-27037PO-56459` |

Running the **real** `resolveExistingInvoice` against those exact production references:

```
SWMS-261015 ref=MLB-26658PO-56313 -> BLOCKED by INV-1115 (DRAFT) via reference
SWMS-261021 ref=MLB-27037         -> BLOCKED by INV-1116 (DRAFT) via reference_substring
```

So **the mint-time duplicate guard blocks both**, via the reference tiers, exactly because
it does not depend on `job_id`. The board's flag is wrong; the money fence is not. That is
a classification defect and a display defect — it is **not** a route to a second live
draft. Both cards are findings, not work items, and are left alone.

The batch consequence: some cards in a twenty-card batch will refuse with
`invoice_duplicate_live`. **That refusal is clean** — it happens before `buildSesEffect`,
writes nothing, and can be re-run — so it must not be confused with the poisoned-effect
case in §1.

---

## 8. What changed in code

One fix, scoped tightly: **`xeroPost` now retries a 429, and only when an
Idempotency-Key was supplied.**

`xeroGet` has always retried a rate limit; the write path did not. On the sealed SES mint
that asymmetry is not "one slow card" but a dead one, because per §1 the throw lands in
`executeSesExternalEffect`'s catch and burns the obligation revision. A rate limit is the
textbook failure that only appears at batch size, which is why one-card-at-a-time proving
never surfaced it.

The idempotency key is the whole safety argument: Xero honours it for 12 hours, so a
keyed create / authorise / void collapses a repeat into the same record. The un-keyed
writes here are not merely unproven — they are the ones that must never repeat, because
`POST /Invoices/{id}/Email` sends a real client email on every success. So an un-keyed 429
still throws on the first response, exactly as before. Retries are bounded at 3 and honour
`Retry-After`.

Tests: `xero_post_rate_limit_retry_test.ts` — drives the real `xeroPost` through a stubbed
`globalThis.fetch` (no network, no Xero) and pins all five directions: keyed retry
succeeds carrying the same key, retries bounded at 3, un-keyed 429 never repeats, a 400
validation failure is not retried and keeps its message, and a clean success makes exactly
one call.

### Named, not fixed

- **Pre-Xero refusals classified as `unknown` (§1).** The one that turns a batch failure
  into an incident. The correct fix is to let the effect ledger distinguish "definitely not
  dispatched" from "outcome ambiguous" and permit re-dispatch from the former.
  `claim_ses_external_effect_v1` returns `reconcile` for every non-confirmed state, so
  **that needs a migration** — named, not attempted.
- **`board_batch` (§6).** Its likely companion at scale. Unused; needs a design decision,
  not a patch.
- **Xero contact / tracking-category lookups repeated per mint (§5b).** Halving the Xero
  call budget is worth doing, but it is a money-path change with no urgency at the proven
  sequential cadence.

---

## 9. Operating rules for tomorrow

The chunk size is at the top of this document: **fours**, ceiling of ten with the §2
pre-flight, never twenty in one go. Alongside it:

1. **One card per HTTP call.** Do not use `selection.mode: "board_batch"` (§6).
2. **Mint sequentially, never concurrently.** Two concurrent mint chains reach Xero's
   60-per-minute ceiling; one does not (§5b).
3. **Check portal verification before minting a roof card.** A failed portal guard costs
   that card its invoice obligation revision, and 2 of the 5 report-type cards in the
   queue would trip it today (§1).
4. **A card that refuses with `invoice_duplicate_live` is safe and re-runnable. A card that
   refuses with `xero_outcome_unknown` is not** — it needs a fresh
   `prepare_ses_invoice_obligation` before it can ever mint (§2).
5. **Treat a board `missing_invoice` flag as a question, not an instruction** (§7).

Note what the chunk size is **not** limited by. Docket prepare has ~5× the headroom the
batch needs, and twenty ran clean tonight; forty would still be a throughput question
rather than a safety one. **Fours is chosen entirely for recoverability**, and it costs
nothing to choose it.

## Re-proving this

- Board/queue and history: read-only Management API (`read_only: true`) against
  `makesafe_docket_revisions` (`duration_ms`, `stage_durations_ms`, `committed_at`),
  `ses_external_effects`, `xero_invoices`, `makesafe_job_details`.
- Live batch: `POST ops-api?action=prepare_ses_docket_revision` with `dry_run: true` and a
  unique `idempotency_key` per call. Write-free — confirmed by bracketing the run with row
  counts on `makesafe_docket_revisions`, `makesafe_docket_artifacts`,
  `ses_external_effects` and `xero_invoices`, all four unchanged. Remember `dry_run` takes
  proof-only photo and report routes, so it under-states the persisting path by roughly
  1.5× (dry-run mean 5.97 s against the production real-prepare average 8.98 s).
