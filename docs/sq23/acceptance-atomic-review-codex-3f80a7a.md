# Codex adversarial re-review of sq23/acceptance-atomic at 3f80a7a

Static, read-only. Saved 20 Oct 2026. Task task-mvfh6uy0-7htyr1.
**UNSOUND for building towards switch-on.** Two must-fix defects remain. Nothing was switched on.

Confirmed branch `sq23/acceptance-atomic`, HEAD **`3f80a7a`**. Reviewed both supplied patches, the previous review, revision 10 and relevant local source. No edits, builds, installs, tests, database or network calls.

File references below:

- **M**: `supabase/migrations/20261019230000_quote_accept_atomic.sql`
- **C**: `supabase/tests/migration-contracts/20261019230000_quote_accept_atomic/contract.sql`
- **I**: `supabase/functions/send-quote/index.ts`
- **D**: `docs/sq23/acceptance-atomic-design.md`
- **U**: `supabase/functions/send-quote/quote_accept_atomic_test.ts`

| Previous finding | Result | Evidence |
|---|---|---|
| 1. Neighbour read outside snapshot | **RESOLVED**, with a new validation defect | `M:123–149` reads the neighbour and fingerprint in one STABLE statement; `I:1728–1734` consumes it. The RPC validates membership at `M:265–276`, but mishandles NULL, detailed below. |
| 2. Reopened sibling hidden by an earlier resolution | **PARTLY** | `M:408,419` now includes both jobs’ transaction IDs. This covers ordinary later-transaction reopening, but `xmin` is not a durable occurrence identifier. |
| 3. Mixed mutation/verification statements | **RESOLVED** | The former sites are separated at `C:141–143`, `C:187–189`, and `C:332–338`. Rechecked the remaining assertions and PL/pgSQL helpers; found no remaining mutation-plus-independent-effect-read expression. |
| 4. Proof-description accuracy | **PARTLY** | `D:100` now describes the seven document mutations accurately. `D:95` still says every fingerprint input is exercised; `D:102` misstates transaction-ID behaviour. The documented signatures at `D:50,53` are also stale. |

**Must-fix, ranked**

1. **The new neighbour check rejects a legitimate legacy selection.**  
   `M:148–149` selects an arbitrary matching line item, including one whose `job_contact_id` is NULL. But `M:268–271` rejects NULL whenever **any other** matching item has a non-NULL contact.

   Concrete case: run A contains one NULL-contact item and one contact-N item. The unchanged snapshot selects the NULL item. Its fingerprint matches under lock, yet acceptance returns `stale/run_neighbour_unbound`. Repeated retries can keep returning 503 without any data changing.

   NULL is permitted by `supabase/migrations/20260324000001_multi_neighbour_runs.sql:14`; there is no per-run contact-uniformity constraint there. The legacy query at `I:1745–1749` accepts that same NULL selection.

   Validate NULL as a legitimate selected value when a matching NULL-contact item exists, or when the run has no items. Do not silently change the selector to prefer non-NULL contacts: that changes legacy party/deposit decisions. Add mixed-NULL, all-NULL, empty-run and invalid-contact contract cases. The existing run fixtures at `C:387–408` contain **no run line items**, so they miss this defect.

2. **`xmin` cannot guarantee that a reopened obligation gets a new reference.**  
   The permanent suppression at `M:431` relies on references built from `xmin` at `M:408,419`.

   - Repeated updates in the same transaction/subtransaction can share `xmin`. For example: update an open sibling, resolve its current gap, then cancel and reopen it in that same transaction. Its final reference can still equal the resolved reference.
   - A writing savepoint subtransaction gets its own transaction ID. Consequently, `C:510–516` is a reasonable positive case for reopening under a **different** XID. It does not prove the same-XID case.
   - HOT updates still create tuple versions; they do not supply a unique per-update occurrence number.
   - Modern PostgreSQL freezing normally preserves the raw `xmin` value while marking it frozen. It does not add an epoch or make the identifier permanently unique.
   - `xmin` is a wrapping 32-bit ID. Persistent resolution strings can eventually collide with a later occurrence.
   - Unrelated updates in a new transaction re-list the gap. That conservative behaviour is explicitly documented and acceptable; it does not repair the false-suppression cases.

   Use a durable generation/occurrence coordinate that changes on the relevant transitions, including repeated transitions within one transaction. The savepoint test improves coverage but does not establish the claimed invariant.

**Should-fix**

Correct `D:50,53` to include `run_label` on the snapshot and `run_neighbour` on acceptance. Replace “every fingerprint input” at `D:95` with the actual tested subset. Correct `D:71,102`: `xmin` does not change on every update, and subtransactions mean not every write within one top-level transaction shares one XID.

**Snapshot boundary and signatures**

The committed party-derived status and run deposit-eligibility calculation now use snapshot inputs. However, “no decision input outside the snapshot” would still be too broad:

- The preliminary guard queries at `I:1656–1707` can reject before the snapshot guards run.
- Whole-quote event names, amount and contact count come from other reads at `I:1777–1802`.
- Follow-up pricing and notifications retain later reads.

These do not recreate the original neighbour/status split-snapshot defect, but the guarantee should remain scoped accordingly.

Executable signatures agree across migration/grants, down migration, contract helper/direct calls, rollback contract, break replacement and TypeScript arguments. The unit tests check NULL argument plumbing; they do not exercise the SQL neighbour validator or non-NULL acceptance arguments.

**Break contract and legacy path**

Statically, the break should still fail at the intended **R4 message** (`C:118–119`). Its replacement has the updated signature, omits the marker, and should return successfully through `qa_try`; the following assertion then rejects that success. Exact execution is unobserved.

With **atomic and strict both off**, the whole-branch diff preserves legacy guards, pre-reads, write payloads and response paths. Added overhead includes the flag read, UUID generation and no-op finish calls. Atomic off alone does not preserve legacy behaviour if strict is independently enabled.

Not verifiable statically: actual PostgreSQL contract/break results, concurrent-session behaviour, live schema or data prevalence, deployed grants/functions, full handler/follow-up execution, and Ops-reader integration.

Codex session ID: 01a15504-a0b2-7be2-ad45-8b1524685517
Resume in Codex: codex resume 01a15504-a0b2-7be2-ad45-8b1524685517
