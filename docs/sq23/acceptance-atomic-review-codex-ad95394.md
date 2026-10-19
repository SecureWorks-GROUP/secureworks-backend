# Codex adversarial re-review of sq23/acceptance-atomic at ad95394

Static, read-only. Saved 20 Oct 2026. Task task-mvfgymj2-mjyclk.
**UNSOUND for building towards switch-on.** Two retained defects and one new snapshot regression remain. Nothing was switched on.

Confirmed branch `sq23/acceptance-atomic`, HEAD **`ad95394`**. Reviewed both materialised patches, the prior review and revision 9. No edits, builds, installs, tests, database or network calls.

References:

- **M**: `supabase/migrations/20261019230000_quote_accept_atomic.sql`
- **T**: `supabase/migrations/20261019210000_fence_quote_option_jobs.sql`
- **C**: `supabase/tests/migration-contracts/20261019230000_quote_accept_atomic/contract.sql`
- **I**: `supabase/functions/send-quote/index.ts`
- **D**: `docs/sq23/acceptance-atomic-design.md`

| Previous finding | Result | Assessment |
|---|---|---|
| 1. Per-obligation open-sibling resolution | **PARTLY** | `M:389–402` now distinguishes siblings and preserves NULL acceptance timestamps using `none`. A new `quote_option_unsuperseded` event changes the reference. However, reopening an **unmarked** sibling need not produce that event; an earlier resolution can still hide it. |
| 2. Gap-reader exception list | **RESOLVED** | `M:371` explicitly catches `query_canceled`, `assert_failure` and `OTHERS`. Added cases cover `57014`, `P0004`, `42501` and `P0001` at `C:512–525`. |
| 3. Contract statement separation | **PARTLY** | The main positive assertions are split, and handler-finished calls are separate at `C:406–411`. Mixed mutation/read expressions remain at `C:137–138`, `C:182–184` and `C:328–332`. |
| 4. Legacy run-neighbour selection | **RESOLVED as query parity** | Atomic selection at `I:1730–1735` now matches the legacy query at `I:1756–1761`, including unordered `LIMIT 1`. But placing that query outside the snapshot introduces the new defect below. |

**Ranked must-fix**

1. **New: the neighbour read reintroduces the split-snapshot problem.**  
   `I:1730–1745` reads the neighbour separately from `atomicSnap`, then `I:1784` uses it to derive the status. The RPC checks only the original snapshot fingerprint (`M:221`).

   Concrete sequence: snapshot sees neighbour N1; another writer changes it to N2; the separate query returns N2; the writer restores N1 before the RPC locks and fingerprints. The fingerprint matches, but the committed decision used N2. This matters because neighbour identity controls required parties, accepted status and deposit eligibility (`quote_party_view.ts:79–92`).

   Return the legacy-style selection from the same snapshot statement, or otherwise bind and validate the selected evidence. Fingerprinting the surrounding rows at two instants does not validate an intervening read.

2. **Retained: reopening an unmarked sibling can reuse a resolved reference.**  
   `M:392–394` changes the occurrence coordinate only through `quote_option_unsuperseded`. That event is written only when clearing an existing superseded mark (`T:306–314`).

   Example: resolve W/S while S is quoted and unmarked; move S to cancelled, then back to quoted. Neither transition crosses the won/non-won boundary, so the trigger does not run (`T:530–535`). W’s acceptance timestamp and S’s unsuperseded event remain unchanged. The renewed gap is suppressed at `M:416`, including when W’s timestamp is NULL.

   The new test merely inserts an unsuperseded event (`C:503–510`); it does not prove reopening produces one. Bind resolution to an actual occurrence/state transition covering these paths.

3. **Retained: contract mutation/read separation is incomplete.**  
   The remaining sites are:

   - `C:137–138`: `qa_today` calls the writing `qa_try` and reads status in one `IF` expression. This successful-write case can observe the pre-write statement snapshot.
   - `C:182–184`: the strict-unreadable assertion combines acceptance and document verification.
   - `C:328–332`: the missing-document call remains inside the assertion containing the document read. Its expected failure limits the immediate visibility problem, but it still violates the requested separation.

   Assign each call’s result in one PL/pgSQL statement, then inspect effects in the next. The fingerprint helper (`C:254–265`) and combination helper (`C:593–600`) already separate these correctly. `D:102` currently overclaims that every mutation has been separated.

**Independent-check findings**

- **(a) Covered:** `M:389–402` has no review-event suppression or non-NULL acceptance requirement. `C:476–494` explicitly covers an unstamped winner beside an older unrelated review event.
- **(b) Covered:** `M:404–410` lists multiple unmarked winners independently of acceptance timestamps and the supersede switch. `C:448–453` covers two trigger-bypassed wins.
- **(c) Direction recorded:** `D:46` explicitly says simultaneous winners stay live, matching the stated CIO direction. `T:412–425` preserves that branch and records review. I did **not** independently reproduce the two-session result.
- **(d) Covered as an open owning-review decision:** `T:505–514` checks the atomic marker first, treats unreadable strict as off and logs SQLSTATE. `D:42–44` records the consequence and leaves the decision unsettled.

**Should-fix**

- Correct the proof description at `D:100–104`: the run-neighbour unit test was removed, “each field” conflicts with the stated coverage limit, and complete statement separation is not yet true.

**Break contract and legacy path**

The break contract should **still fail at the intended R4 message**, statically. Its replacement accepts without setting the marker; `qa_try` returns `ok`; `set_config('qa.r', …, true)` runs inside the explicit transaction begun at `C:82`; the following assertion at `C:116–117` rejects `ok`. I found no new `set_config` obstacle before R4. Exact execution remains unobserved.

With atomic **and strict off**, the whole-branch diff preserves the legacy guards, pre-reads, write payloads and response builders. Added overhead includes the flag read, UUID generation and no-op finish calls. Thus business semantics remain today’s; execution is not byte-for-byte or timing-identical. Atomic off alone does not guarantee legacy behaviour if strict is independently enabled.

Not verifiable statically: PostgreSQL execution and exact break output, real concurrent-session outcomes, deployed schema/grants, full handler and follow-up parity, or Ops-reader integration.

Codex session ID: 01a154fe-c409-7072-8727-9bda88d1233e
Resume in Codex: codex resume 01a154fe-c409-7072-8727-9bda88d1233e
