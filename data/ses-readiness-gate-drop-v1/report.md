# SES readiness gate drop v1

**Branch:** `fm/ses-readiness-gate-drop-v1`
**Captain's ruling:** `data/decisions/2026-08-03-captain-drops-the-readiness-precondition.md` (firstmate home) — option 3, drop the precondition, never assert readiness. Extended the same day, via FirstMate, to the third instance on the approval path.
**Status:** implementation complete, **PR #511 open with CI green**. Three unsatisfiable readiness gates dropped, none asserted. Live mint on SWMS-261109 deliberately deferred to post-merge (section 9.1).
**PR:** https://github.com/SecureWorks-GROUP/secureworks-backend/pull/511 — pipeline run `01KZ2FFG1WBVYBH8HNYY2R3W4P`, **zero findings at every step** (intent, rebase, review, test, document, lint, push, pr, ci). The one pipeline commit, `8ada542`, condensed the `AGENTS.md` entry to a pointer at this report, per that file's own "point to the authoritative file" bar.

**The three things worth reading first**

1. All three gates were unsatisfiable for the same reason, and in all three the
   `RAISE` was not the whole change — something downstream depended on the record
   or the column the guard guaranteed (sections 2 and 6.2). Deleting the check
   alone would have swapped a clean refusal for a `23502` a few statements later,
   three times over.
2. The third gate is **not** a copy of the first two. It bundles the
   unsatisfiable readiness test with a **genuine** optimistic-concurrency check.
   The readiness half is dropped; the freshness half is kept verbatim and is
   reachable for the first time (section 6.1).
3. This stops at **recording** the approval. Two further sites on the **Xero
   execution** path carry the same unsatisfiable test and are deliberately
   untouched, because the task fences execution off (section 6.3). The captain
   should rule on those two together.

---

## 1. The deadlock, re-proved end to end

### Static trace (repo)

| Fact | Evidence |
|---|---|
| `ready` defaults false | `20260728000001_..._u2.sql:223` |
| Only `commit_makesafe_readiness` sets it true | `..._u2.sql:565` |
| Exactly two callers repo-wide | `..._u5_u6.sql:745`, `:1593` — grep for `commit_makesafe_readiness` across `*.sql` + `*.ts` returns only those two `PERFORM` sites, one `CREATE`, the REVOKE/GRANT pair, and the rollback `DROP` |
| Caller 1 refuses unless already ready | `..._u5_u6.sql:610-613` |
| Caller 2 refuses unless already ready | `..._u5_u6.sql:1417-1418` |
| Caller 2 is the only site that *would* write `true` unconditionally | `..._u5_u6.sql:1589` passes literal `true` — but only after its own precondition passes |
| Caller 1 can only propagate | `next_ready := prior_readiness.current_ready AND ...` (`:738-739`) |
| The only creator of the row writes it false | `invalidate_makesafe_readiness` (`..._u2.sql:503-545`) |
| No later migration replaces either function | grep for both function names finds only `20260728020000` (definition + REVOKE + GRANT) and the two TS RPC call sites |

### Behavioural proof (production, read-only Management API, `read_only: true`)

```
readiness_rows            191      -- makesafe_readiness_current
readiness_ready_true        0
readiness_revisions         0      -- makesafe_readiness_revisions is EMPTY
readiness_revisions_ready   0
obligation_revisions        0
invalidations             511      -- the invalidator has been running fine all along
approvals                   0
makesafe_invoice_obligations total = 0
```

This is **stronger than the static argument**. The precondition is not merely
"unsatisfiable in principle": both preconditions `JOIN
makesafe_readiness_revisions`, and that table has **zero rows in production**.
`NOT FOUND` is therefore unconditionally true for **every job on the board**,
always. The `NOT ... current_ready` half of the test has never even been
evaluated.

`invalidations = 511` against `readiness_revisions = 0` is the shape of a
half-built phase exactly as described: the invalidator shipped, the producer
did not.

---

## 2. The minimum honest change is NOT "delete the RAISE blocks"

The task invited me to say so if my reading disagreed. It does.

`prior_readiness` is consumed **downstream** of the precondition in both
functions:

- fn 1: `.dependency_envelope` (`:724`), `.current_ready` (`:738`),
  `.blockers` (`:741-743`), `.attendance_cycle_set_hash` /
  `.family_matrix_revision` (`:749-750`)
- fn 2: `.dependency_envelope` (`:1571`), `.attendance_cycle_set_hash` /
  `.family_matrix_revision` / `.blockers` (`:1587-1591`)

With the `RAISE` deleted and nothing else changed, `prior_readiness` is an
all-NULL record. Traced:

1. `jsonb_set(NULL, …)` → NULL (`jsonb_set` is STRICT)
2. `makesafe_readiness_revision_v1(NULL)` → NULL (declared `STRICT`)
3. `commit_makesafe_readiness(…, p_readiness_revision => NULL, …)` — every
   guard inside it compares NULL to NULL and passes (`IS DISTINCT FROM`
   between two NULLs is false; `jsonb_typeof(NULL) <> 'object'` is NULL, so
   the `IF` is not taken)
4. `INSERT INTO makesafe_readiness_revisions (… readiness_revision …) VALUES (… NULL …)`
   → **`23502` not-null violation**

So a bare deletion swaps a clean `23514` for an uglier `23502`. The card still
never mints. The honest change has to decide what the readiness re-commit does
when there is nothing to re-commit.

### The shape chosen

> When there **is** a certified prior readiness revision, behave exactly as
> today, byte for byte. When there is **not**, record the invalidation and
> **skip the readiness re-commit entirely.**

Readiness is never asserted, never synthesised, never defaulted to true. The
uncertified branch leaves `makesafe_readiness_current` in the state it is
already in for all 191 live rows — `readiness_revision = NULL`, `ready =
false`, `invalidated_at` set — which is the truthful state: *readiness does not
know*.

This is minimal in the strict sense: **the only behaviour that changes is on
the path that previously raised.** Every input that would have been accepted
before is handled by identical code.

---

## 3. Scope decisions

### 3.1 `commit_ses_invoice_obligation_revision_v1` (`:610-613`) — CHANGED

In scope, explicitly. This is the 409 on every card.

### 3.2 `commit_ses_invoice_bound_docket_v1` (`:1417-1418`) — CHANGED

**Reasoning, as required.** Its message ("new evidence landed; review the
current docket revision again") reads as a freshness check, and in the intended
Phase-2 world it *is* one: after each material fact change the invalidator
clears the pointer, and the producer re-commits, so a stale binding would find
no matching revision. But:

1. **It is implemented as a readiness-ready precondition, not a freshness
   check.** It compares nothing against the docket it is binding from. A real
   freshness check here would test `current_row.readiness_revision =
   base.readiness_revision` (the `pre_xero` docket revision it copies).
   Dropping the `ready` test therefore removes no freshness comparison,
   because there is no freshness comparison to remove.
2. **It is equally unsatisfiable, and provably so after the fn-1 fix.** fn 1
   only ever *propagates* an existing `true`; it never bootstraps one. So after
   fn 1 is fixed, readiness on these cards is still `ready = false` with a NULL
   revision. fn 2's `NOT FOUND` fires for exactly the same reason it fires
   today. It moves the same deadlock one step later, which is the case the
   ruling names.
3. **Leaving it would be actively worse than changing it**, because fn 2 is the
   one site that passes a literal `true` to `commit_makesafe_readiness`
   (`:1589`). Any careless later "fix" that just deletes its `RAISE` would turn
   fn 2 into a readiness *forger*. The change here forecloses that: the
   uncertified branch skips the commit, so the `true` is unreachable without a
   real prior certification.

Changed, with the identical never-assert shape.

### 3.3 `next_ready := prior_readiness.current_ready AND …` (`:738-739`) — UNCHANGED

It now lives inside the certified branch, where `current_ready` is true by
construction, so it reduces to `p_revision->>'state' <> 'blocked'` — its intended
meaning. Left verbatim because:

- Making it `true` would assert readiness. Forbidden.
- Making it `false` would destroy a legitimately certified readiness state once
  the Phase-2 producer exists — a real regression planted for later.
- As written it can only ever **weaken** readiness (`true AND x`), never
  manufacture it. That is exactly the property the ruling wants preserved.

---

## 4. Recording that readiness was NOT certified

No schema change was needed. `invalidate_makesafe_readiness` already writes an
append-only `makesafe_readiness_invalidations` row on every obligation commit,
carrying `dependency_kind`, `dependency_identity` (**the exact obligation
revision id**), `reason`, `actor` and `generation_after`, with `UNIQUE (job_id,
generation_after)`. The same `reason` lands on
`makesafe_readiness_current.invalidation_reason`, so it is visible on the card
as well as in the ledger.

The uncertified branch passes a **distinct reason string** naming the ruling:

```
… ; readiness was NOT certified at mint (captain ruling 2026-08-03 …)
```

So "which obligations were minted under this decision" is a single join, on
schema that already exists, append-only, with no new column and no new table.

Query for the captain:

```sql
SELECT i.job_id, i.dependency_identity AS obligation_revision_id, i.invalidated_at
FROM public.makesafe_readiness_invalidations i
WHERE i.dependency_kind = 'makesafe_invoice_obligation_revisions'
  AND i.reason LIKE '%readiness was NOT certified at mint%';
```

`commit_ses_invoice_obligation_revision_v1` additionally returns a new
`readiness_certified` boolean key. It is additive; the TS caller passes the RPC
result straight through (`ses_reporting_actions.ts:725-737`).

---

## 5. What is NOT changed

| Gate | Status | How it is proved |
|---|---|---|
| Money seal `jobs.ses_money_sealed_at` and `_shared/sealed_ses_money_fence.ts` | untouched | **Neither** migration contains an executable statement referencing `ses_money_sealed_at` or `xero_invoices` — pinned by two tests that strip `--` comments (the seal is named in prose only, to record it as out of scope). The fence file is not modified. `sealed_ses_money_fence_test.ts` is green and unchanged. |
| Human APPROVE INVOICE gate | untouched | `ses_reporting_actions.ts` is not modified by any of this work. Pinned by a control test on `!authority.allowed \|\| operatorAuth.mode !== "jwt" \|\| !auth.user` and on `loadOperatorAuth` returning `{ mode: "api_key" \| "routine" }` without a user — a routine or api-key caller can never reach `jwt` mode. **This is the gate that matters most here**: dropping the in-database readiness test does not let a non-human approve, because a non-human cannot reach the RPC. |
| `record_ses_revision_approval_v1`'s allowlist, mechanically-clean and Captain-override tests | untouched | Control test pins all four refusal strings plus the operator identity on the insert. Only the readiness half of its compound `IF` changed. |
| The Xero **execution** gates (`makesafe_revision_approvals_current_v2` `WHERE readiness.ready = true`; `begin_ses_invoice_execution_v1`; `begin_ses_release_execution_v1`) | untouched | Control test pins the view predicate and `NOT current_readiness.ready` in release execute, and asserts neither drop migration rewrites the view or an execution function. See section 6.3. |
| Every other precondition in the three changed functions | untouched | 12 refusal strings across sites 1 and 2, 4 across site 3, asserted present in the effective bodies. |
| Readiness table, invalidator, recording behaviour | untouched | Neither migration contains `DROP TABLE`/`DROP FUNCTION`/`DROP TRIGGER`, no `UPDATE public.makesafe_readiness_current`, and both write **zero rows at apply time** (verified by stripping the `AS $$ … $$;` bodies and asserting no top-level `INSERT`/`UPDATE`/`DELETE`/`TRUNCATE`). `invalidate_makesafe_readiness` is still called on every commit, certified or not. |
| The approvals table's append-only guard | untouched | `trg_makesafe_revision_approvals_append_only` fires `BEFORE UPDATE OR DELETE`; the site-3 migration performs only DDL and an INSERT-shaped function change, and a test asserts it never names that trigger. |
| Pricing, duplicate probe, blockers, cycle binding | untouched | The three function bodies are otherwise byte-identical to the originals — see the diffs in section 8.2. |

---

## 6. The third gate — `record_ses_revision_approval_v1`

`record_ses_revision_approval_v1` (`..._u5_u6.sql:978-997`) carries a **third**
instance of the same unsatisfiable gate:

```sql
IF NOT FOUND
   OR NOT current_readiness.ready
   OR NOT current_readiness.revision_ready
   OR current_readiness.readiness_revision IS DISTINCT FROM p_approval->>'readiness_revision'
   OR current_readiness.dependency_generation IS DISTINCT FROM (…)::bigint THEN
  RAISE EXCEPTION 'new evidence landed; review the current docket revision again'
```

Same `INNER JOIN makesafe_readiness_revisions` (0 rows), same `NOT … ready`.
This is the RPC behind **APPROVE INVOICE** itself, so clearing sites 1 and 2
lets the obligation mint and the cockpit bind it, but pressing the button still
409s.

**Status: authorised by the captain on 2026-08-03 as the same ruling extended to
the third instance** (relayed via FirstMate). It was raised as a needs-decision
in the first pass of this report; that is now resolved and the work is in scope.

### 6.1 Site 3 is NOT a copy of sites 1 and 2 — and the difference is in our favour

At sites 1 and 2 the whole `IF` was readiness-ready and nothing else. Site 3
bundles **two different tests into one `IF`**:

| Half | What it is | Verdict |
|---|---|---|
| `NOT FOUND` (inner join) + `NOT ready` + `NOT revision_ready` | the unsatisfiable readiness certification test | **drop** |
| `readiness_revision IS DISTINCT FROM p_approval->>'readiness_revision'` and `dependency_generation IS DISTINCT FROM (…)::bigint` | a genuine optimistic-concurrency check: what the cockpit displayed to the operator vs what the row says now | **keep, verbatim** |

The second half is what the message `new evidence landed; review the current
docket revision again` actually describes, and unlike sites 1 and 2 it **is
satisfiable**: `dependency_generation` is a real, moving, non-null value (41 on
SWMS-261109), bumped by every invalidation. The cockpit reads it
(`ses_reporting_actions.ts:423`) and passes it back
(`:1158`); if an invalidation lands between render and press, the values differ
and the approval is correctly refused.

So the honest change at site 3 removes only the unsatisfiable half and makes the
freshness half **reachable for the first time**. The `INNER JOIN` becomes a
`LEFT JOIN` (so the current row is found when no revision has ever been
certified) and the `ready` / `revision_ready` tests move inside a certified
branch, exactly as at sites 1 and 2:

- certified (`readiness_revision IS NOT NULL`) → full original test, including
  `ready` and `revision_ready`, byte-for-byte behaviour;
- uncertified → the freshness comparison alone.

Two equivalences worth pinning: with the original `INNER JOIN`, a non-null
`readiness_revision` with no matching revision row raised via `NOT FOUND`; under
the `LEFT JOIN` it raises via `NOT COALESCE(revision_ready, false)` in the
certified branch — same refusal, same message, same SQLSTATE. And an absent
`makesafe_readiness_current` row still raises, because `NOT FOUND` is kept.

Readiness is still never asserted. Nothing writes `ready`, and site 3 does not
call `commit_makesafe_readiness` at all.

### 6.2 The real blocker at site 3 is a NOT NULL audit column, not the RAISE

Dropping the gate is necessary but **not sufficient**. `record_ses_revision_approval_v1`
inserts into `makesafe_revision_approvals`, whose readiness identity column is
(`20260728000001_..._u2.sql:264-265`):

```sql
readiness_revision text NOT NULL
  CHECK (readiness_revision ~ '^sha256:[0-9a-f]{64}$'),
```

Production's `makesafe_readiness_current.readiness_revision` is NULL on all 191
rows, so the cockpit passes `readiness_revision: null` and the INSERT fails
`23502` four statements after the gate. This is the same trap as section 2, one
level harder: there it was a plpgsql record, here it is a table constraint.

Only three shapes exist, and two are excluded by the ruling:

| Option | Verdict |
|---|---|
| Leave the column NOT NULL, drop only the gate | **useless** — swaps a `40001` for a `23502`; the captain still cannot approve |
| Synthesise a `sha256:…` value for the column | **forbidden** — fabricating a readiness identity on the money path is exactly "assert readiness" |
| Relax the column to `NULL` allowed, keeping the format CHECK for non-null values | **the only honest option** |

Taken, and it is not an invented pattern — it is the **existing idiom in the
same table**. `approval_content_hash` was added by `..._u5_u6.sql:383-389` as
exactly this shape:

```sql
CHECK (approval_content_hash IS NULL OR approval_content_hash ~ '^sha256:[0-9a-f]{64}$')
```

So the change mirrors its neighbour:

```sql
ALTER TABLE public.makesafe_revision_approvals
  ALTER COLUMN readiness_revision DROP NOT NULL;
-- CHECK re-added as: readiness_revision IS NULL OR readiness_revision ~ '^sha256:…'
```

Why this is cheap and safe:

- **Zero rows.** `makesafe_revision_approvals` has 0 rows in production
  (section 1), so the relaxation has no effect on any existing data and no
  backfill question.
- **No index or unique constraint** references `readiness_revision` (grep over
  every migration returns none), so NULL semantics cannot corrupt a key.
- **The append-only trigger is unaffected**: `trg_..._append_only` fires
  `BEFORE UPDATE OR DELETE` only (`..._u2.sql:375-400`). Inserts and DDL are
  untouched, and the table stays append-only.
- **NULL is the truthful value.** It records "no readiness certification existed
  when this was approved" — the section 4 property, now on the approval row
  itself rather than only in the invalidation ledger. That is strictly more
  visible than what a NOT NULL column could have expressed.

### 6.3 What this does NOT unblock, deliberately

Recording the approval is the end of the authorised path. Two further sites
still test the same unsatisfiable readiness, and **both are on the Xero
execution path, which this task explicitly fences off** ("no draft invoice, no
Xero call, no send"):

| Site | Test | Effect |
|---|---|---|
| `makesafe_revision_approvals_current_v2` (`..._u5_u6.sql:449-458`) | `WHERE readiness.ready = true`, plus a join on `readiness.readiness_revision = approval.readiness_revision` which is NULL-unsafe | an uncertified approval is recorded but never appears in this view |
| `begin_ses_invoice_execution_v1` / `begin_ses_release_execution_v1` (`:1119-1129`, `:1213-1218`) | read that view / re-test `NOT current_readiness.ready` | execution refuses |

I have **not** touched either. Removing them would be removing a check to make
something pass on the money path, which the task forbids, and they guard the
step that actually calls Xero.

The consequence is worth stating exactly, because it is a real boundary and not
a hedge:

> After this change the captain can open the cockpit, see APPROVE INVOICE
> enabled, press it, and have the decision **durably recorded** in
> `makesafe_revision_approvals` with his identity, the docket revision, the
> obligation revision and the content hash. The subsequent **SEND IT /
> create-the-Xero-invoice** step will still refuse until those two execution
> sites are ruled on.

Importantly, this is **not** the deadlock moved one step later in the sense the
original task warned about. The cockpit control itself does not read the
approvals table — `buildSesCockpitView` derives `approve_invoice.enabled` from
the docket and obligation alone (`ses_review_cockpit.ts:340-347`) — so the
button works, stays working, and the approval is real. What is deferred is
execution, which was never in scope.

**Recommendation for the next ruling:** treat the two execution sites as one
decision, not two, and rule on them together with the money seal in view.

---

## 7. Pre-existing defect noticed in passing (not fixed, not in scope)

`invalidate_makesafe_readiness` requires `jobs.type = 'makesafe'` (`..._u2.sql:521-525`)
and raises `current make-safe job not found` otherwise. The obligation commit calls
it unconditionally. Restoration cards are `jobs.type = 'insurance'` with
`metadata.insurance_job_type = 'restoration'` (per repo `CLAUDE.md`), so the
obligation path would throw for a restoration card. Pre-existing — the call is
unconditional in the original migration and this change does not alter it.

---

## 8. Proof

### 8.1 Files

| File | What |
|---|---|
| `supabase/migrations/20260803010000_ses_drop_unsatisfiable_readiness_precondition.sql` | sites 1+2 — two `CREATE OR REPLACE FUNCTION`, grants restated, two `COMMENT ON FUNCTION`. **Writes zero rows.** |
| `supabase/rollbacks/20260803010000_..._down.sql` | restores the two bodies **byte-identically** to lines 550-766 and 1318-1606 of `20260728020000`, generated mechanically from that file rather than retyped, with a header warning that running it today re-blocks the whole board |
| `supabase/migrations/20260803020000_ses_drop_approval_readiness_precondition.sql` | site 3 — one column relaxation (`DROP NOT NULL` + CHECK re-added admitting NULL), one `COMMENT ON COLUMN`, one `CREATE OR REPLACE FUNCTION`, grants restated, one `COMMENT ON FUNCTION`, plus a post-state assertion that fails the migration loudly if the relaxation did not take. **Writes zero rows.** |
| `supabase/rollbacks/20260803020000_..._down.sql` | restores the approval body **byte-identically** to lines 935-1060 of `20260728020000` (verified by `diff`, empty) and re-imposes NOT NULL, refusing with a count if any approval was recorded uncertified |
| `supabase/functions/ops-api/ses_readiness_precondition_drop_test.ts` | 19 tests: 10 that fail on the old shape, 9 controls/invariants that pass on both |

**Why site 3 is a separate migration.** 20260803010000's header states it writes
zero rows and replaces two function bodies, and explicitly records site 3 as out
of scope at the time. Rewriting that history would be worse than adding a second,
clearly-dated file. Site 3 also contains DDL, which is a different risk class and
deserves its own rollback twin. 20260803010000 now carries a one-line forward
pointer to it.

Version `20260803010000` was checked against the **live** ledger
(`supabase_migrations.schema_migrations`), not just against the repo. Live max was
`20260802030000` and the repo max is the same, so repo and production were in
sync and both `20260803010000` and `20260803020000` are unused — no ledger
version/name collision. **Caveat:** that check was run in the earlier pass. It
could not be re-run for `20260803020000` because `SUPABASE_ACCESS_TOKEN` now
returns 401 (section 8.7). `bash scripts/apply-pending-migrations.sh --dry-run`
with a working production token reproduces the gate read-only and is the cheap
pre-merge re-check.

No edge-function source changed, so no
`scripts/edge-function-schema-requirements.txt` entry is needed. The manifest is
checked per **changed function**, and none changed; its marker kinds
(table/column/constraint/index/policy/trigger) also cannot express "this column
is nullable", which is the only schema fact site 3 depends on. No exclusion or
alias is involved.

### 8.2 The change is exactly the intended diff

A mechanical unified diff of the two effective bodies against the originals
removes **only**:

- the two `IF NOT FOUND OR NOT prior_readiness.current_ready THEN RAISE … END IF;` blocks
- the two hard-coded invalidation reason literals, replaced by a `CASE` that
  appends the uncertified marker
- the readiness-commit blocks, which are **re-added verbatim, re-indented,
  inside `IF readiness_certified THEN`**

Nothing else is removed. Structural balance check on the four bodies:
`IF`/`END IF` nets to 0 in all four; `BEGIN`/`END` nets to `-(number of CASE
expressions)` in all four, which is correct because a `CASE … END` expression
contributes one bare `END` (originals: −1 and 0 with 1 and 0 CASEs; new: −2 and
−1 with 2 and 1 CASEs).

For site 3 the same claim is stronger, because the diff is machine-checkable
against the original in one piece. `diff -u` of the new body against lines
935-1060 of `20260728020000` is **only** the readiness block:

```
+  readiness_certified boolean;                      (DECLARE)
-  JOIN public.makesafe_readiness_revisions revision
+  LEFT JOIN public.makesafe_readiness_revisions revision
-  IF NOT FOUND
-     OR NOT current_readiness.ready
-     OR NOT current_readiness.revision_ready
-     OR current_readiness.readiness_revision IS DISTINCT FROM …
+  IF NOT FOUND THEN … END IF;
+  readiness_certified := current_readiness.readiness_revision IS NOT NULL;
+  IF readiness_certified AND (NOT …ready OR NOT COALESCE(…revision_ready,false)) THEN … END IF;
+  IF current_readiness.readiness_revision IS DISTINCT FROM …
```

The allowlist test, the mechanically-clean test, the Captain-override test, both
`INSERT`s and the `RETURN` are byte-identical. `IF`/`END IF` balances 5→7 (one
combined `IF` split into three). The rollback body `diff`s **empty** against the
original.

Neither migration could be executed against a database (section 9), so this
mechanical diff plus the balance checks is the strongest available static proof;
first real parse is in the deploy lane, in a transaction, ledgering only on
success.

### 8.3 The regression test fails on the old shape

Proved by moving **only** the two migrations out of the tree and re-running the
**byte-identical** test file. Exact output:

```
### OLD SHAPE (both drop migrations reverted, test file byte-identical) ###
running 19 tests from ./supabase/functions/ops-api/ses_readiness_precondition_drop_test.ts
the drop migration owns the effective obligation and bind bodies ... FAILED (2ms)
the obligation commit no longer refuses on an uncertified readiness revision ... FAILED (0ms)
the invoice-bound docket commit no longer refuses on an uncertified readiness revision ... FAILED (0ms)
readiness is dropped as a blocker, never asserted ... FAILED (0ms)
an uncertified mint is recorded, not silently omitted ... FAILED (0ms)
no other precondition on the obligation path was removed ... ok (0ms)
CONTROL: the human APPROVE INVOICE gate is untouched ... ok (0ms)
the approval drop migration owns the effective approval body ... FAILED (0ms)
the approval commit no longer refuses on an uncertified readiness revision ... FAILED (0ms)
readiness is never asserted on the approval path ... ok (0ms)
an uncertified approval can actually be recorded ... FAILED (0ms)
the approval drop migration destroys nothing and touches no money row ... FAILED (0ms)
CONTROL: the approval path keeps its genuine freshness check ... ok (0ms)
CONTROL: the approval authority tests are untouched ... ok (0ms)
CONTROL: the Xero execution gates still test readiness and are untouched ... ok (0ms)
the drop migration destroys nothing and touches no money row ... FAILED (0ms)
CONTROL: the readiness table, its invalidator and its recording behaviour survive ... ok (0ms)
CONTROL: the money seal fence is intact ... ok (0ms)
CONTROL: a genuinely blocked docket still cannot produce an executable obligation ... ok (0ms)
FAILED | 9 passed | 10 failed (7ms)
```

The four site-3 failure messages, verbatim:

```
the approval drop migration owns the effective approval body
  AssertionError: Values are not equal.
  -   20260728020000_makesafe_ses_invoice_release_u5_u6.sql
  +   20260803020000_ses_drop_approval_readiness_precondition.sql

the approval commit no longer refuses on an uncertified readiness revision
  AssertionError: the approval read still INNER JOINs the empty readiness revisions table

an uncertified approval can actually be recorded
  AssertionError: the approval drop migration is missing

the approval drop migration destroys nothing and touches no money row
  AssertionError: the approval drop migration is missing
```

The tests read the **effective** body — every migration scanned in version
order, last `CREATE OR REPLACE FUNCTION` wins, which is what the database ends
up holding. That is why removing a migration flips them, and it also means a
future migration that re-introduces any of the three preconditions fails these
tests too.

On the new shape:

```
ok | 19 passed | 0 failed (5ms)
```

### 8.4 Controls: pass on BOTH shapes

Nine tests are **`ok` on the old shape and `ok` on the new shape** (see the two
runs above). None of them reads either new migration, by design, so they are
shape-independent:

| Control | Old shape | New shape | What it pins |
|---|---|---|---|
| the human APPROVE INVOICE gate is untouched | ok | ok | `!authority.allowed \|\| operatorAuth.mode !== "jwt" \|\| !auth.user`, and that `loadOperatorAuth` returns `{ mode: "api_key" \| "routine" }` with no user — a **routine or api-key caller can never reach `jwt` mode**, so it can never approve |
| the money seal fence is intact | ok | ok | `SEALED_SES_MONEY_READ_EXEMPT_ACTIONS` still closed |
| a genuinely blocked docket still cannot produce an executable obligation | ok | ok | the pre-RPC docket refusals and `jsonb_array_length(blockers) > 0` at execute |
| the readiness table, its invalidator and its recording behaviour survive | ok | ok | tables, `invalidate_makesafe_readiness`, the false-write, no later dropper |
| no other precondition on the obligation path was removed | ok | ok | 12 refusal strings across sites 1 and 2 |
| CONTROL: the approval authority tests are untouched | ok | ok | action whitelist, SES release allowlist, mechanically-clean, Captain-override, operator identity on the insert |
| CONTROL: the approval path keeps its genuine freshness check | ok | ok | both `IS DISTINCT FROM` comparisons and the message |
| CONTROL: the Xero execution gates still test readiness and are untouched | ok | ok | `AND readiness.ready = true;` in the view, `NOT current_readiness.ready` in release execute, and that **neither** drop migration rewrites the view or an execution function |
| readiness is never asserted on the approval path | ok | ok | no `commit_makesafe_readiness`, no `ready = true`, no synthesised `sha256:` literal |

The three controls the task named explicitly:

- **The money seal still refuses.** Passes on both shapes. Neither migration
  contains an executable statement mentioning `ses_money_sealed_at` or
  `xero_invoices` (comment lines are stripped before the check, because both
  migrations name the seal in prose precisely to record it as out of scope), and
  `_shared/sealed_ses_money_fence.ts` is not modified.
- **A routine non-human key still cannot approve an invoice.** Passes on both
  shapes. `ses_reporting_actions.ts` is not modified by any of this work; the
  control pins the `jwt` + `auth.user` requirement and the fact that api-key and
  routine callers structurally never reach `jwt` mode.
- **A genuinely blocked docket still does not mint an executable obligation.**
  Passes on both shapes. Precise claim unchanged from the first pass: a blocked
  docket *does* still mint a `state = 'blocked'` obligation revision carrying its
  concrete blockers (designed behaviour, pinned by
  `makesafe_invoice_obligation_test.ts`); what it cannot do is become executable.
  Stating it as "does not mint" would be false.

The old "CONTROL: `record_ses_revision_approval_v1` keeps its own readiness
recheck" test is **gone**, replaced by the site-3 regression tests. That is the
correct consequence of the captain extending the ruling: a control asserting the
third gate still fires would now be asserting the defect.

The blocked-docket control pins the real refusals: `No U4 pre-Xero docket exists
for this invoice proposal.`, `The current docket is not a pre-Xero proposal that
can mint an invoice obligation.`, `pricing_evidence_missing`, and — at the
execute step — `jsonb_array_length(target_revision.blockers) > 0` →
`the invoice obligation has no executable priced line set`.

### 8.5 Full suite and type gate

```
baseline (clean tree):         FAILED | 2942 passed | 18 failed | 1 ignored (15s)
sites 1+2 only (commit 127d04a): FAILED | 2954 passed | 18 failed | 1 ignored (15s)
sites 1+2+3 (this branch):     FAILED | 2961 passed | 18 failed | 1 ignored (16s)
```

The failing test set is **identical across all three runs** — 18 in every case,
all pre-existing and in files this work does not touch (one of them,
`ses_artifact_hash_budget_test.ts`, is the documented `--allow-run`-less red
noted in the repo `CLAUDE.md`). The delta is exactly **+19 passes**, which is
this change's 19 new tests. **Zero regressions.**

`deno check --config deno.jsonc supabase/functions/ops-api/index.ts` → exit 0.
`deno fmt --check` and `deno lint` clean on the test file.

### 8.6 Live card: `SWMS-261109` Bertram — before state (read-only)

Read-only via the Supabase Management API with `read_only: true`, SELECT only.

```
job_id                208450c0-7161-4b30-9514-66226b054609
job_number            SWMS-261109        type makesafe   status accepted
site_suburb           Bertram            substatus admin_to_send_report
ses_money_sealed_at   2026-07-29 05:31:05.558259+00      <- SEALED

docket_revision_id    31daa258-5fc7-540c-9ced-c9d1b468195d
  stage               pre_xero
  state               ready
  pre_xero_docs_ready true
  blockers            0
  readiness_revision  NULL               <- readiness never certified
  committed_at        2026-08-02 15:08:26.83199+00
  proposal            480.00 ex / 48.00 GST / 528.00 inc, 1 line item
  builder_reference   AJBR-70271

makesafe_invoice_obligations            0
makesafe_invoice_obligation_revisions   0
makesafe_readiness_current              1 row, ready = false, generation 41,
                                        readiness_revision NULL,
                                        invalidation_reason
                                        'INSERT changed a makesafe-state.v2 dependency'
makesafe_readiness_invalidations       41
xero_invoices linked to this job        0
```

$528 inc GST and zero blockers reproduce the batch-1 crew's measurement exactly.
This card is held by nothing but the gate.

### 8.7 Live mint: NOT PERFORMED — deferred to post-merge by design

**The blocker is structural, not credential.** The new function bodies exist only
on this branch. Production still holds the `20260728020000` bodies, so a mint
attempt today executes the OLD function and returns the same `23514`. The
migrations apply on merge to `main` (section 9) — a merge I am forbidden to
perform. Firstmate confirmed the mint is deliberately deferred until then.

For completeness on the earlier credential report: the `SW_API_KEY` blocker
recorded in the first pass **has been resolved** — the captain replaced the key
and it is verified authenticating against production. It is not on the critical
path here, because (a) above is what actually prevents the mint.

A **new** credential blocker appeared in this pass and is reported, not routed
around: `SUPABASE_ACCESS_TOKEN` (44 chars, correct `sbp_` shape, loaded from
`~/.config/secureworks/env`) now returns `401 Unauthorized` from the Management
API, on `POST /v1/projects/{ref}/database/query` **and** on a bare
`GET /v1/projects`. The same token worked earlier today for the section-1 and
section-8.6 measurements, so it has been revoked or expired since.

**I did not swap credentials and did not seek another route.** Consequences,
stated exactly:

- No production read was possible in this pass. Every production number in this
  report is from the earlier pass and is labelled as such.
- The live schema of `makesafe_revision_approvals.readiness_revision` could not be
  re-verified against `information_schema.columns`. Section 6.2 reasons from the
  repo migration. This is the one place repo/live drift could bite: **if
  production has already relaxed that column, the migration is a harmless
  no-op there** (the DO block drops whatever CHECK exists, `DROP NOT NULL` is
  idempotent, and the post-state assertion passes either way). If production has
  a differently-*named* CHECK, the DO block finds it by definition rather than by
  name, which is why it was written that way.
- No production write was performed. The mint attempt would have written nothing
  in any case: the readiness precondition raises *before* the `INSERT INTO
  makesafe_invoice_obligations`, so the old function's refusal is write-free.

---

## 9. How this deploys

**Migration-only.** No edge-function source changed.

On merge to `main`, `.github/workflows/deploy-edge-functions.yml` runs in the
`production` environment. Its reviewed migration lane runs
`scripts/apply-pending-migrations.sh`, which applies repository migrations
missing from the production ledger in version order through the Management API,
verifying and ledgering each one. Per
`docs/project-knowledge/EDGE_DEPLOY_LANE.md`, **migration-only merges deploy
zero functions** — so this merge applies the two migrations and deploys no code.

Version order matters and is correct as filed: `20260803010000` (sites 1+2) then
`20260803020000` (site 3). They are independent — neither reads the other's
output — so the order is a formality, but the runner applies in version order
regardless.

**Nothing needs to be run by hand for the deploy itself.** No exclusion, no
alias, no ledger debt, no manual `supabase db push`, no function deploy. Both
versions are above the audited automatic boundary (`20260722000001`), so they are
in the automatic lane.

The cheap pre-merge check is
`bash scripts/apply-pending-migrations.sh --dry-run` with a **working**
production `SUPABASE_ACCESS_TOKEN` (the local one is currently 401 — section
8.7), which reproduces the gate read-only and also re-checks for a ledger
version/name collision.

**Caveat worth stating:** neither migration was **executed against any
database**. There is no local Postgres, no docker, and no `psql` on this
machine, and production is SELECT-only for me, so `CREATE OR REPLACE FUNCTION`
and `ALTER TABLE` could not be validated by execution. What was verified instead:
the three bodies are byte-identical to already-applied production bodies except
for the audited diffs (8.2), `IF`/`END IF` and `BEGIN`/`END`/`CASE` all balance,
and `$$` tokens pair. First real parse happens in the deploy lane, which applies
each migration in a transaction and ledgers only on success — a syntax error
would fail the run before anything ships, not half-apply. Migration 2 also
carries its own post-state assertion, so a silently-ineffective relaxation fails
the migration rather than surfacing later as a `23502` under the captain's
finger.

### 9.1 What has to happen after merge, in order

1. **Merge the PR.** The deploy workflow applies `20260803010000` then
   `20260803020000` and ledgers both. Nothing else is needed for the code to be
   live.
2. **Re-measure `SWMS-261109` before state** (read-only, Management API,
   `read_only: true`). Section 8.6 is the expected baseline; re-derive it rather
   than trusting it, because the docket revision may have moved.
3. **Mint the obligation on that one card**, via the deployed `ops-api`
   `prepare_ses_invoice_obligation` action with the working `SW_API_KEY`.
4. **Re-measure after state** and record the obligation id, the revision id, its
   `state`, and the new `makesafe_readiness_invalidations` row whose `reason`
   carries `readiness was NOT certified at mint (captain ruling 2026-08-03…)`.
5. **STOP.** No draft invoice, no Xero call, no approval, no send, no archive, no
   status change. Pressing APPROVE INVOICE is now *possible* after this merge,
   but it is a separate authorised act and was not authorised here.

A working `SUPABASE_ACCESS_TOKEN` is needed for steps 2 and 4, and a working
`SW_API_KEY` for step 3.

---

## 10. The pattern named

The task asked me to name it if I met it.

This is the **mirror image** of the usual finding on this codebase. The familiar
shape is "the capability already existed and only the wiring was missing." Here
the capability was deliberately **not built** — readiness shipped as an
explicitly labelled Phase-1 compare-only shadow with its producer scheduled for
a later phase — and the U5 money path wired it in anyway, as a hard
precondition. Half a mechanism plus a consumer that assumes the other half is a
deadlock, and it is silent: the invalidator kept running (511 rows), so the
subsystem *looked* alive right up to the point where something asked it a
question it could never answer.

The tell was in the data, not the code: **511 invalidations against 0
revisions.** A producer/consumer pair where one side has thousands of rows and
the other has none is the signature. Worth checking for on the other Phase-1
shadows.

And a second, smaller one worth recording: **"delete the check" was not the
minimum change** (section 2). The check was load-bearing for the code after it —
it guaranteed a non-NULL record to five downstream readers. Deleting it swaps a
clean refusal for a `23502` four statements later. Whenever a guard's variable
is read downstream, removing the guard is a two-part change, and the second part
is where the real decision lives.

Extending to site 3 confirmed that second pattern and sharpened it. All three
gates had a downstream dependency on the thing the guard guaranteed, and each
time the dependency was one step further from the guard: a plpgsql record at
sites 1 and 2, and at site 3 a `NOT NULL` **table constraint** on the audit
column the function writes 30 lines later. The generalisation: an unsatisfiable
guard means everything downstream of it has been dead code since the day it
shipped, so it has never been type-checked by reality. Removing the guard is the
first time that code runs, and its assumptions are all unverified. Budget for
that, and check what the guard was standing in front of before deciding the
change is a deletion.

A third, from site 3 specifically: **a compound `IF` can hide a good check inside
a bad one.** Site 3's single condition was five `OR`ed terms — three
unsatisfiable, two genuinely useful — under one error message that described only
the useful half. Reading the message would have led to leaving the whole thing
alone; reading only the first term would have led to deleting the whole thing.
Neither is right. Splitting the condition was the change, and it made the
optimistic-concurrency check reachable for the first time rather than removing
anything.
