# Codex adversarial re-review of sq23/acceptance-atomic at 1d41398

Static, read-only. Saved 20 Oct 2026. Task task-mvfgquj6-4hjeuv.
**UNSOUND for switch-on.** The acceptance transaction is substantially improved, but R3 still has a suppression defect and an unreadable-switch hole. The SQL contract also contains assertions that cannot reliably prove the intended behaviour.

Confirmed branch `sq23/acceptance-atomic`, HEAD **`1d41398a7d7ae260e0d621f6177a8deacdf003fc`**. Read revision 8, the previous review and both materialised patches. No edits, builds, installs, tests, database or network calls.

References below:
- `M`: `supabase/migrations/20261019230000_quote_accept_atomic.sql`
- `T`: `supabase/migrations/20261019210000_fence_quote_option_jobs.sql`
- `C`: `supabase/tests/migration-contracts/20261019230000_quote_accept_atomic/contract.sql`
- `H`: `supabase/functions/send-quote/quote_accept_atomic.ts`
- `I`: `supabase/functions/send-quote/index.ts`

**Previous five must-fix items**

| Item | Result | Evidence and assessment |
|---|---|---|
| 1. Snapshot protocol | **RESOLVED**, within the stated concurrency boundary | `M:87–145` returns inputs and fingerprint through nested **STABLE SQL** functions. Their reads share the calling statement’s snapshot; the nested fingerprint call does not independently refresh it. Structured JSON preserves NULL positions. `M:198–204` locks existing documents, acceptances and line items before recomputation at `M:221`. |
| 2. Document re-read | **RESOLVED** | `H:66–80` checks token, raw/derived run label, contact, version and relevant timestamps. Snapshot guards reproduce the query filters at `H:85–104`; `I:1718–1733` uses them before deriving status. The RPC independently checks the current token at `M:218–225`. |
| 3. Request ownership and recovery | **RESOLVED** | Independent request UUID at `I:1633`; unique persisted ownership at `M:47–48`. Recovery reads the document’s unique attempt and compares its request ID, never its timestamp (`H:179–196`). An unreadable/absent reconciliation becomes `unknown`, with truthful handler wording at `I:1824–1831`. Ordinary SQLSTATE errors take the rollback path at `H:153–156`. |
| 4. Gap read and resolutions | **PARTLY** | Review events now appear independently (`M:378–380`), two winners are detected (`M:393–399`), and unrelated review events no longer suppress gaps. Explicit resolutions join by `(kind, ref)` (`M:405`). However, the generated open-sibling reference does not identify the sibling obligation, and the unreadable-switch catch is incomplete. See must-fix findings below. |
| 5. Completion wording | **RESOLVED** | `handler_finished_at` explicitly means reaching the response boundary, not successful follow-up (`M:36–44`, `M:321–334`, `H:199–207`). Failed invoices and unfinished council mail are no longer misrepresented as proved downstream completion. Their actual outcomes remain outside slice 1. |

For item 1, I found **no omitted field used by the inspected eligibility/status party rules**: raw and snapshot labels, publication state, ordering fields, contact identity, acceptance state and neighbour selection inputs are covered.

There are still deliberately unfingerprinted reads: job pricing/name, contact count and contact display details used to compose the acceptance event (`I:1776–1801`), plus follow-up inputs. Therefore the fingerprint proves the **acceptance decision inputs**, not the entire event payload or later financial workflow. Existing-row locks also do not establish a general serializable protocol for every concurrent insertion or writer.

**Previous four should-fix items**

| Item | Result | Evidence and assessment |
|---|---|---|
| Marker before strict switch | **RESOLVED** | `T:505–513` reads the marker first and consults the switch only when needed. The switch catch explicitly includes cancellation and assertion failures. Added coverage is at `C:174–187`. |
| Contract coverage | **PARTLY** | Fingerprint, token, ownership and gap cases are materially expanded. But mutation/read assertions remain unsound, the combination checks still inspect only status/document/mark (`C:526–539`), and there is no full handler or three-switch integration proof. |
| Per-table fault injectors | **RESOLVED** | The generic injector touches no `NEW` fields; the separate review injector accesses `NEW.event_type` only on `job_events` (`C:479–489`, `C:513–519`). |
| Required event / trusted caller | **RESOLVED** | Whole-quote calls require a non-NULL event (`M:242–248`). The service-role caller’s responsibility for deriving status and run label is explicitly stated (`M:157–160`, `M:237–240`). This is an existence guarantee, not validation of every event field. |

**Ranked must-fix findings**

1. **R3 resolutions can hide a later, different open-sibling problem.**  
   `won_with_open_sibling` uses only `winner-id@accepted_at` as its reference (`M:382–391`). After resolving winner W’s conflict with sibling S1, a newly open or reopened S2 beside the same winner produces the identical reference. `M:405` suppresses it using the earlier resolution. When `accepted_at` is NULL, every such occurrence collapses to `W@none`.

   This is newly introduced by the resolution mechanism and contradicts “suppresses only that one obligation.” Include the conflicting sibling identity and an appropriate occurrence/state coordinate, or require a resolution to match the exact current evidence it adjudicated.

2. **The gap reader does not implement “unreadable means off” for all promised failures.**  
   `M:366–371` catches `OTHERS` only. PostgreSQL excludes `query_canceled` (`57014`) and `assert_failure` (`P0004`) from that category. Either error in the flag read aborts the entire gap function, including otherwise readable review and unfinished-handler records.

   Match the explicit exception list already used by the trigger at `T:366` and `T:510`. Add gap-reader cases for both errors; the current combination tests exercise the trigger, not this reader.

3. **Separate contract mutations from their verification statements.**  
   For example, `C:216–221` calls the accepting function and queries sibling/run state within the same outer `SELECT`. The outer queries use that statement’s snapshot and cannot serve as post-commit observations of writes made by the nested function. Similar problems occur at `C:353–355`, `C:362–366`, and `C:376–387`.

   This is a **retained defect**, not wholly introduced this round. Successful implementation behaviour can fail these assertions even in a single-session PostgreSQL 17 runner. Execute the mutation first, then verify in a subsequent statement.

   The new finish assertion also chains three stateful calls with `AND` (`C:390–393`). SQL expression evaluation order is not a sequencing guarantee. Give each call its own statement and assertion.

**Should-fix findings and requested probes**

- **Run-neighbour selection is not demonstrably identical across paths.** The legacy query takes `LIMIT 1` without ordering (`I:1743–1748`); the snapshot orders line items by ID (`M:142–145`, `H:107–110`). If a run has conflicting contact IDs, the selected neighbour can change when atomic mode is enabled. Prove a single-contact invariant or explicitly adjudicate this difference. The unit fixture itself contains two different contacts for one run (`quote_accept_atomic_test.ts:112–116`).

- **Coverage claims still exceed the cases.** The document-match test changes only a subset of fields (`quote_accept_atomic_test.ts:89–98`). The fingerprint cases do not individually mutate every included field. Neither is evidence of complete field-by-field coverage.

- **Timestamp handling is not a new blocker.** Snapshot JSON carries timestamp strings, while fingerprint timestamps are numeric epochs (`M:98–106`, `M:131–139`). `sameInstant` parses strings rather than comparing formatting (`H:60–61`), and the ordering helper also parses timestamps. Ordinary offset differences are handled. JavaScript truncates PostgreSQL microseconds, so “exactly matches” is stronger than this comparison proves; the party ordering already uses millisecond precision.

- **`STABLE` plus an exception block and `RETURN QUERY` is not inherently invalid.** This function performs reads; its exception block does not itself make it a writing function. `#variable_conflict use_column` and qualified output references avoid the obvious output-variable ambiguity (`M:358–405`). The concrete defect is the exception coverage above.

- **The `qa_token` fixture is sound for the supplied stack.** It fills NULL tokens before insertion (`C:85–87`); the setup adds `share_token text` without a default (`setup.sql:20`). It is rolled back with the fixtures. If this contract is later run against a schema with a non-NULL token default, the trigger preserves that default, so the hard-coded `tok-…` restoration would need adjustment.

- **The break contract should still target R4.** Its replacement omits the atomic marker and returns successful acceptance (`break-contract.sql:8–14`). With strict off and the three injectors active, `C:114–116` should fail with the expected R4 message. That check precedes the problematic positive-control assertions. This is a static expectation, not an observed runner result.

**Legacy path and switch combinations**

Against the whole-branch patch, the legacy acceptance guards, three pre-reads, writes and response builders remain intact when atomic mode is off/missing/unreadable. The additions are the flag read, local UUID generation and no-op finish calls. I found no changed legacy acceptance predicate or write payload. “Exactly today’s” is supportable for those semantics, not identical timing or request count.

With strict off:

| Atomic flag | Supersede flag | Backend result |
|---|---|---|
| Off/missing/unreadable | Off/missing/unreadable | Legacy split writes; supersede trigger silent |
| On | Off/missing/unreadable | Atomic acceptance; no sibling marking |
| Off/missing/unreadable | On | Legacy split writes; existing unrecorded-status residual |
| On | On | Atomic acceptance and supersede work; triple failure rolls back |

The Ops-reader flag does not affect these backend branches. For **each row**, reader on versus off/missing/unreadable remains a separate presentation contract, unavailable for verification in this branch.

The proposed **atomic → verified Ops reader → supersede** order remains compatible. Reverse order is appropriate for disabling. It is not sufficient protection if atomic becomes unreadable while supersede and strict remain on: fallback can again accept the document before a refused status update. Universal raise-for-all remains an owning-review decision; this review does not authorise it.

Not verifiable statically: PostgreSQL 17 execution and exact break output, concurrent insertion/lock behaviour, deployed schema/grants, full handler response and follow-up parity, or Ops-reader integration. Slice 2 remains designed rather than implemented.

Codex session ID: 01a154f9-3b28-7562-b756-5d6baac05414
Resume in Codex: codex resume 01a154f9-3b28-7562-b756-5d6baac05414
