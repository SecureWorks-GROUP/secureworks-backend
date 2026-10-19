**SOUND WITH CHANGES** for building towards switch-on. **No switch-on approval.**

Confirmed branch **`sq23/acceptance-atomic`**, HEAD **`fb11da4`**. Reviewed the supplied patches, CIO review, checker report, previous review and revision-12 design. No edits, builds, installs, tests, database or network calls.

References below:

- **M** — `supabase/migrations/20261019230000_quote_accept_atomic.sql`
- **T** — `supabase/migrations/20261019210000_fence_quote_option_jobs.sql`
- **C** — `supabase/tests/migration-contracts/20261019230000_quote_accept_atomic/contract.sql`
- **R / S** — `rollback-contract.sql` / `setup.sql` in that same directory
- **I / H** — `supabase/functions/send-quote/index.ts` / `accept_atomic_handler_test.ts`
- **D** — `docs/sq23/acceptance-atomic-design.md`

**Requested dispositions**

| Item | Disposition | Evidence and limit |
|---|---|---|
| CIO 1: transactional run event and acceptance instant | **RESOLVED** | `M:198–200,330–341` requires the event and writes `quote_run_accepted` alongside the acceptance, stamping `detail_json.accepted_at` from `p_accepted_at`. `I:2002` also uses that instant for the subsequent business event. `job_events` has no `occurred_at`; Context must consume the detail field. |
| CIO 2: both missing R3 kinds | **PARTLY** | Both exist at `M:460–478`, with contracts at `C:423–464`. However, historical events and persistent document resolutions can hide later inconsistencies; see must-fix findings below. |
| CIO 3: strict-off triple-failure gap assertion | **RESOLVED** | `C:152–157` performs the plain update while the three fault injectors remain installed and checks both missing-event and open-sibling gaps. |
| CIO 4: strict only while atomic is reliably on | **OPEN BY DESIGN (owner decision)** | `D:44` records the order and unreadable-atomic hazard. There is no enforced dependency: `T:508–509` reads strict independently. This is documented, not satisfied as an operational invariant. |
| CIO 5: staged R5 scope | **OPEN BY DESIGN (owner decision)** | `D:28,139` leaves acceptance of the scope open. Strict still covers grouped transition triple-failure only (`T:493–520,530–535`), not every status-without-event write. |
| CIO 6: switch order and prerequisite proof | **PARTLY** | Atomic → verified Ops reader → supersede is stated at `D:42`. The supplied checker demonstrates PG16 concurrency at **60df50f**, not PG17 execution at this head. `D:116` acknowledges outstanding integration. |
| CIO 7: Context reader rule | **PARTLY** | `M:409–422` now emits `supersede_switch_unreadable`, including a NULL job ID, instead of silently omitting that uncertainty. This branch does not implement or fully restate the Context rules for read errors, uncertain chronology, `(kind, ref)` identity and access approval. |
| Checker b3x: superseded option won without trigger | **RESOLVED** | `M:445–452` counts marked winners; `M:483–486` separately lists `won_while_superseded`. `C:628–648` covers the bypass and refuses resolution of that condition. |
| Rollback surviving mutants m12–m19 | **PARTLY** | Trigger: `R:29–31`; switches: `R:33–35`; committed acceptance: `R:41–47`; accepted-at column: `R:37–39`; overloads: `R:53–55`. Renamed relations are caught only while matching the broad prefix at `R:49–51`. These assertions address the named attacks, but fresh mutant execution is unobserved and the name checks have weaknesses below. |
| Handler-level partial-fence timing proof | **PARTLY** | `H:99–129` drives the actual handler and checks arguments, skipped writes and timestamp equality. It does not reliably distinguish the fixed timestamp from the previous fresh-clock implementation. |

**Must-fix, ranked**

1. **A historical acceptance event can conceal a later unrecorded win.**  
   `M:464–465` accepts *any* `quote_accepted` or `quote_run_accepted` event ever recorded on the job. It does not associate that event with the acceptance now being diagnosed.

   For example, an earlier partial-run event followed by a legacy final acceptance whose event fails leaves the job won, but the new gap is absent. A previous acceptance followed by reopening and an unrecorded re-win has the same problem. The other gap kinds need not expose either case on an ungrouped job.

   Associate evidence with the relevant acceptance, or explicitly retain uncertainty where that association cannot be established. An event’s existence is insufficient chronology proof.

2. **The newly resolvable document condition can disappear permanently after reopening.**  
   `M:74–75` permits resolution of `accepted_document_job_not_won`; `M:472,494` keys suppression solely by document ID.

   Sequence: accepted document/job quoted → resolve → job accepted → job quoted again. The final inconsistency remains suppressed by the first resolution. Accepting the document once does not mean its job can become inconsistent only once.

   Make this condition non-resolvable, as with the other recurring conditions, or give each occurrence a durable identity. Otherwise this reintroduces the reopened-condition problem identified in the previous review.

**Should-fix, ranked**

1. **Make the timing test discriminate against the old code.**  
   `H:121` compares timestamps, but the fake RPC resolves immediately (`H:82–83`). Two `new Date()` calls can return the same millisecond, so the previous implementation can pass. Advance a controlled clock between acceptance and follow-up. Likewise, call-list order at `H:123–127` proves invocation order, not waiting for transaction completion; a deferred RPC would test that boundary.

2. **Narrow rollback object checks and strengthen rename detection.**  
   `R:49–54` searches unrelated schemas too. Moreover, `_` in `LIKE 'quote_acceptance%'` is a wildcard, not a literal underscore. Unrelated relations or same-named functions can therefore produce false failures. Conversely, renaming the attempts table outside that prefix escapes detection. Capture the owned relation identities before rollback and scope function checks to the owning schema. The trigger check establishes presence, not enabled state or correct function binding.

3. **Correct revision-12 documentation.**  
   `D:60` still requires an event only for whole quotes. `D:70–73` describes the old signature, three resolvable kinds and two condition kinds. `D:28,38` overstates what strict does for “every writer”; the grouped transition restriction still applies. Preserve CIO’s complete consumer rule explicitly.

**Other requested checks**

- **Handler extraction:** No production behaviour change found from the extraction itself. The URL handling, OPTIONS response, client construction and existing body remain in place (`I:684–700`). Default 404 and error returns remain (`I:3908–3915`). Production calls `sendQuoteHandler(req)` without dependencies (`I:3919–3920`); request content cannot supply `deps.sb`.

- **Fake-client fidelity:** Suitable for a narrow wiring test, not database or legacy-parity proof. `H:38–64` mostly ignores filters, projections, cardinality and mutations; `H:86–87` silently succeeds for unknown RPCs. HTTP likewise always succeeds (`H:17–22`). The legacy test counts writes but does not check their payloads (`H:140–143`). The snapshot-before-guard assertion is real for this fixture, but the fake does not validate guard query semantics.

- **Committed setup fixture:** `S:38–51` supplies genuine pre-down data, addressing the previously vacuous preservation assertion. It is **shared suite state**: `run.sh:162–189` runs all setups before all behaviour contracts. Its distinct IDs, ungrouped patio job and matching acceptance event avoid the obvious collisions and new-gap noise. Full-suite compatibility is not established statically.

- **Gap noise and `p_since`:** The missing-event kind scans all job types in the shared won-status vocabulary, including operational and completed work, not just customer quote acceptances (`M:462`; `T:118–120`). Expect historical/manual-work findings, not necessarily failed customer acceptances. `p_since` filters only the two new acceptance kinds (`M:463,478`), not the whole answer. NULL job acceptance times remain included; stale old timestamps can exclude a recent staff win. It is an acceptance-time filter, **not a reliable change cursor**.

- **Resolution identities:** Settlement-run IDs and review-event IDs are durable occurrences (`M:424–430`). The unfinished-handler document ID is supported by the one-attempt-per-document model. Winner/sibling, multi-winner and switch references cannot be resolved. The new document condition is the exception requiring correction above.

- **Required `p_accept_event`:** The current production caller supplies it for both branches (`I:1779–1824`); no current legitimate caller omission was found. Older atomic handler code supplies NULL for runs and would now be refused, including before replay (`M:198–200,223–228`). Keep the feature off through coordinated rollout.

- **Event content:** Whole-quote detail keys match the legacy producer (`I:1802–1813` versus `I:2163–2174`); the acceptance instant intentionally changes to the shared instant. The new run job event contains contact/source plus database-owned document, instant, status and run label (`I:1779–1782`; `M:334–337`). Existing `quote.run_accepted` business-event keys remain unchanged; only atomic-path `occurred_at` changes (`I:1998–2015`).

- **Legacy path:** With **atomic and strict both off**, the whole-branch diff preserves legacy write payloads, guards and response paths. Added switch reads, UUID generation and no-op finish calls remain. This is static semantic parity, not a fresh byte-parity result.

- **Break contract:** It should still fail at **`C:118–119`**, with **“R4: an atomic acceptance whose supersede run records nothing must be refused”**. The replacement omits the marker and returns success; the new setup acceptance does not interfere with that assertion.

Not verifiable here: execution at **fb11da4**, PG17 behaviour, fresh mutation results, timing-test reliability in practice, full-suite fixture interactions, concurrent sessions, live schema/grants, deployed entry behaviour or Context/Ops consumer integration. The supplied successful dynamic results belong to **60df50f**, not this head.

Codex session ID: 01a15521-bb82-73d0-9740-55ef27df704d
Resume in Codex: codex resume 01a15521-bb82-73d0-9740-55ef27df704d
