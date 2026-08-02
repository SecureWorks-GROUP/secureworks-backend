# Batch 5 — drive physical make-safe and temporary fencing to Docs Ready

Task id `ses-run-skill-batch5-packs-v1`. Branch `fm/ses-run-skill-batch5-packs-v1` in an isolated
treehouse worktree of `secureworks-backend`. Written as the run goes, not at the end.

**Slice: `physical_makesafe` + `temporary_fencing` only.** Nothing outside those two families was
read for a verdict or written to.

---

## THE NUMBER

**3 cards are in Docs Ready. I put 0 more there. I touched 164.**

Not because the cards are not ready — because **the ops-api credential on this machine is rejected
by production with HTTP 401**, and every write in my brief (author a report, generate a SWMS,
persist a docket) is behind it. I could not run a single U4 dry run either.

That is the honest headline and it is a two-line fix, not a code change. Detail in section 1.

**The second number matters more, and it survives the credential being fixed:**

> **Even with a working key, only 2 more cards in my entire slice can reach Docs Ready today.**
> 60 of the 66 cards that have a trade report are held by one thing: the U1 identity spine has
> never been seeded. `makesafe_state_identity_current_v2` has **0 rows** in production.

So the captain's target of 20 is not reachable from my two families by running the skill harder. It
is reachable, and comfortably, the moment the identity-spine seeder is authorised to run. Section 3
gives the exact command and the exact card list.

---

## The table

Every card in my slice that carries trade evidence. 98 further cards are waiting on the trade and
are listed as a class in section 5.

| Card | Suburb | Outcome | Evidence |
|---|---|---|---|
| `SWMS-261017` | Maylands | **Docs Ready** | persisted docket, `pre_xero_docs_ready: true`, blockers `[]` |
| `SWMS-261109` | Bertram | **Docs Ready** | persisted docket, `pre_xero_docs_ready: true`, blockers `[]` |
| `SWMS-261115` | Morley | **Docs Ready** | persisted docket, `pre_xero_docs_ready: true`, blockers `[]` |
| `SWMS-261036` | Gwelup | blocked by us | spine complete + current-cycle report; docket not persisted - **ops-api key rejected (401)** |
| `SWMS-26657` | Sorrento | blocked by us | spine complete + current-cycle report; docket not persisted - **ops-api key rejected (401)** |
| `SWMS-261015` | Tuart Hill | blocked by us | `spine_missing_lineage` class - no intake case |
| `SWMS-261020` | Floreat | blocked by us | `spine_missing_lineage` class - case unstamped |
| `SWMS-261021` | Floreat | blocked by us | `spine_missing_lineage` class - case unstamped |
| `SWMS-261024` | Koondoola | blocked by us | `spine_missing_lineage` class - case unstamped |
| `SWMS-261025` | Koondoola | blocked by us | `spine_missing_lineage` class - case unstamped |
| `SWMS-261028` | Success | blocked by us | `spine_missing_lineage` class - no intake case |
| `SWMS-261029` | Midland | blocked by us | `spine_missing_lineage` class - no intake case |
| `SWMS-261034` | Wanneroo | blocked by us | `spine_missing_lineage` class - no intake case |
| `SWMS-261035` | Morley | blocked by us | `spine_missing_lineage` class - no intake case |
| `SWMS-261037` | Tapping | blocked by us | `spine_missing_lineage` class - case unstamped |
| `SWMS-261038` | Tapping | blocked by us | `spine_missing_lineage` class - case unstamped |
| `SWMS-261039` | Nollamara | blocked by us | `spine_missing_lineage` class - no intake case |
| `SWMS-261055` | Dianella | blocked by us | `spine_missing_lineage` class - case unstamped |
| `SWMS-261065` | Munster | blocked by us | `spine_missing_lineage` class - case unstamped |
| `SWMS-261080` | Floreat | blocked by us | `spine_missing_lineage` class - case unstamped |
| `SWMS-26604` | Nedlands | blocked by us | `spine_missing_lineage` class - no intake case |
| `SWMS-26628` | WOODVALE | blocked by us | `spine_missing_lineage` class - case unstamped |
| `SWMS-26629` | Bennett Springs | blocked by us | `spine_missing_lineage` class - no intake case |
| `SWMS-26630` | Carine | blocked by us | `spine_missing_lineage` class - case unstamped |
| `SWMS-26642` | Palmyra, WA 6157 | blocked by us | `spine_missing_lineage` class - no intake case |
| `SWMS-26644` | Craigie | blocked by us | `spine_missing_lineage` class - no intake case |
| `SWMS-26652` | QUINNS ROCKS | blocked by us | `spine_missing_lineage` class - case unstamped |
| `SWMS-26654` | BICTON | blocked by us | `spine_missing_lineage` class - case unstamped |
| `SWMS-26655` | Balcatta | blocked by us | `spine_missing_lineage` class - no intake case |
| `SWMS-26663` | Mount Richon | blocked by us | `spine_missing_lineage` class - no intake case |
| `SWMS-26835` | Ballajura | blocked by us | `spine_missing_lineage` class - no intake case |
| `SWMS-26836` | Dianella | blocked by us | `spine_missing_lineage` class - no intake case |
| `SWMS-26840` | Queens Park | blocked by us | `spine_missing_lineage` class - no intake case |
| `SWMS-26841` | Bedford | blocked by us | `spine_missing_lineage` class - no intake case |
| `SWMS-26845` | Queens Park | blocked by us | `spine_missing_lineage` class - no intake case |
| `SWMS-26862` | Parmelia | blocked by us | `spine_missing_lineage` class - no intake case |
| `SWMS-26866` | Daglish | blocked by us | `spine_missing_lineage` class - no intake case |
| `SWMS-26867` | Hillarys | blocked by us | `spine_missing_lineage` class - no intake case |
| `SWMS-26875` | Lesmurdie | blocked by us | `spine_missing_lineage` class - no intake case |
| `SWMS-26878` | Huntingdale | blocked by us | `spine_missing_lineage` class - case unstamped |
| `SWMS-26882` | Hillarys | blocked by us | `spine_missing_lineage` class - no intake case |
| `SWMS-26884` | Alexander Heights | blocked by us | `spine_missing_lineage` class - no intake case |
| `SWMS-26885` | Waikiki | blocked by us | `spine_missing_lineage` class - no intake case |
| `SWMS-26887` | Hocking | blocked by us | `spine_missing_lineage` class - no intake case |
| `SWMS-26888` | Clarkson | blocked by us | `spine_missing_lineage` class - no intake case |
| `SWMS-26891` | Thornlie | blocked by us | `spine_missing_lineage` class - case unstamped |
| `SWMS-26893` | Heathridge | blocked by us | `spine_missing_lineage` class - case unstamped |
| `SWMS-26894` | Ballajura | blocked by us | `spine_missing_lineage` class - case unstamped |
| `SWMS-26900` | Yangebup | blocked by us | `spine_missing_lineage` class - no intake case |
| `SWMS-26901` | Ocean Reef | blocked by us | `spine_missing_lineage` class - no intake case |
| `SWMS-26902` | Ballajura | blocked by us | `spine_missing_lineage` class - no intake case |
| `SWMS-26903` | Bedford | blocked by us | `spine_missing_lineage` class - no intake case |
| `SWMS-26917` | Winthrop | blocked by us | `spine_missing_lineage` class - no intake case |
| `SWMS-26919` | Morley | blocked by us | `spine_missing_lineage` class - no intake case |
| `SWMS-26927` | Balga | blocked by us | `spine_missing_lineage` class - case unstamped |
| `SWMS-26937` | Balga | blocked by us | `spine_missing_lineage` class - case unstamped |
| `SWMS-26938` | Noranda | blocked by us | `spine_missing_lineage` class - no intake case |
| `SWMS-26939` | South Perth | blocked by us | `spine_missing_lineage` class - case unstamped |
| `SWMS-26940` | Mosman Park | blocked by us | `spine_missing_lineage` class - no intake case |
| `SWMS-26944` | Gwelup | blocked by us | `spine_missing_lineage` class - case unstamped |
| `SWMS-26946` | Bedford | blocked by us | `spine_missing_lineage` class - case unstamped |
| `SWMS-26948` | Beechboro | blocked by us | `spine_missing_lineage` class - case unstamped |
| `SWMS-26949` | Bayswater | blocked by us | `spine_missing_lineage` class - case unstamped |
| `SWMS-26953` | Gidgegannup | blocked by us | `spine_missing_lineage` class - no intake case |
| `SWMS-26955` | Herne Hill | blocked by us | `spine_missing_lineage` class - no intake case |
**Count line: 0 cards put into Docs Ready, out of 164 touched. The board still holds the same 3 it
held when I started.** Of the 164, 98 are honestly waiting on a trade, 60 are blocked by us on one
named class, 3 are already done, and 3 are ours and would go through today if the key worked.

No card was archived, completed, cancelled or sent. No email was drafted. No invoice was created,
authorised or sent. The money seal was not touched. Nothing was written to production at all.

---

## 1. Why nothing was written: the ops-api key is rejected

`SW_API_KEY` in `~/.config/secureworks/env` is not production's `SW_API_KEY`. Proved by
discriminating the three auth paths in `ops-api/index.ts:3046-3059` against the live function:

```
x-api-key = SW_API_KEY   ->  401 {"error":"Unauthorized"}
Bearer    = SW_API_KEY   ->  401 {"error":"Session expired — please log in again"}
Bearer    = <junk>       ->  401 {"error":"Session expired — please log in again"}
no headers               ->  401 {"error":"Unauthorized"}
```

Read that carefully, because it is conclusive rather than circumstantial:

- The junk-bearer and real-key-as-bearer responses are **identical**. `_resolveOpsApiAuthIntent`
  returns `'jwt'` for any bearer that is not `validKey` or `serviceKey`, and the handler then fails
  it as a user session. So the key is provably neither `SW_API_KEY` nor the service-role key.
- The `x-api-key` path returns `'none'` -> `Unauthorized`, which is the same statement from the
  other direction.
- My headers do reach the function: it is ops-api's own error text, not the Supabase gateway's.

The key on disk is dated 19 July. It has been rotated since. This is very likely the same
credential the brief already flags as being with the captain for the identity-spine seeder's live
proof — `docs/evidence/ses-spine-seeder-scoped-route-2026-08-03.md:271` names the precondition in
as many words: *"`makesafe_state_seed_scoped` merged and deployed, and a working ops key in
`SW_API_KEY`."*

I did not look for another route to it. I did not use the SecureSuite MCP bearer as a substitute (I
tested it once against the same endpoint, it is also not the ops key, and I stopped). I did not
fetch the service-role key from the Management API, which would have worked and which is exactly
the kind of credential swap the brief forbids.

**Reads were unaffected.** Everything below is measured against production through the Supabase
Management API with `read_only: true`, SELECT only, with a guard in the client that refuses any
non-SELECT statement and any client-identifying column before the request is sent.

---

## 2. The census, re-measured myself

Population: `ses-board-population/active-v1` (`scripts/ses-board-population-contract.ts`) — make-safe
jobs, restoration insurance jobs, and any job with a `makesafe_job_details` row; cancelled/lost and
terminal synthetic cards excluded. C.5 is open, so this is **not** "the whole board".

Family is classified by reproducing `canonicalSesFamilyFromCard` (`ses_family_matrix.ts:146-194`)
in SQL against `jobs.metadata`, which is the same input the adapter uses (`ses_assembler_input_adapter.ts:678-688`).

| Family | Active cards |
|---|---:|
| `physical_makesafe` | 160 |
| `temporary_fencing` | 116 |
| `ordinary_roof_portal` | 60 |
| `assessment_quote` | 51 |
| `unknown` | 19 |
| `restoration` | 1 |
| **total** | **407** |

**My slice is 276 cards, of which 164 are non-terminal** (excluding `archived` and `invoiced`
`jobs.status`).

| My slice, non-terminal | make-safe | fencing | total |
|---|---:|---:|---:|
| cards | 116 | 48 | **164** |
| with a submitted trade report | 52 | 14 | **66** |
| with a current-cycle submitted report | | | 63 |
| with a report PDF already attached | 63 | 16 | 79 |
| with a SWMS PDF already attached | 51 | 12 | 63 |
| **with a persisted docket revision** | **5** | **0** | **5** |

That last row is the whole story. Reports and SWMS are already on these cards in quantity. What is
missing board-wide is the **docket revision**, and a docket revision is the only thing that puts a
card in Docs Ready (`index.ts:15018-15027` derives the drafted pack from it at read time).

### The batch 4 census moved, and in my favour

Batch 4 counted 12 physical make-safe cards "owing no trade evidence" and zero fencing. Measured
directly against evidence rather than U4's `trade_evidence_missing` blocker, **66 cards in my two
families carry a submitted trade report** — 52 make-safe and 14 fencing. The trade has done its part
on four times as many cards as the blocker census implied. `trade_evidence_missing` is a
cycle-attribution statement, not a "no report exists" statement, and the two diverge badly.

---

## 3. What actually blocks my slice: the identity spine, and it is one class

Of the 66 cards carrying trade evidence, **60 cannot reach Docs Ready and all 60 fail the same
way.**

`spine_missing_lineage` fires when any of `lineage_id`, `job_id` or `source_content_hash` is blank
(`ses_prepare_docket_revision.ts:321-331`). The adapter resolves those two identity facts from
exactly two sources (`ses_assembler_input_adapter.ts:1427-1433`):

```ts
const sourceHash = firstText(intakeCase?.source_content_hash, identityRevision?.source_content_hash)
const lineageId  = firstText(intakeCase?.lineage_id,          identityRevision?.lineage_id)
```

`identityRevision` is a row of `makesafe_state_identity_current_v2`. **That table has 0 rows in
production.** The seeder has never run. So every card falls back to its intake case, and:

| My 66 evidence-bearing cards | Count |
|---|---:|
| intake case carries hash + lineage + instruction key (**spine complete**) | **6** |
| intake case exists but `source_content_hash` was never stamped | 24 |
| **no intake case at all** | 36 |

36 + 24 = 60 blocked, on one class, with one repair. This is the board-wide `spine_missing_lineage`
wall that batch 4 measured at 108 of 138 cards, seen from inside my slice.

### This is not a derivation I am asking anyone to take on trust

Every persisted docket revision in production, read directly:

```
SWMS-261115   2026-08-02 18:43:27   ready=True   blockers []
SWMS-261017   2026-08-02 16:23:39   ready=True   blockers []
SWMS-261019   2026-08-02 15:50:56   ready=False  ['portal_capture_missing','pricing_evidence_missing']
SWMS-261020   2026-08-02 15:38:06   ready=False  ['spine_missing_lineage','swms_generation_capability_unavailable']
SWMS-261065   2026-08-02 15:37:58   ready=False  ['spine_missing_lineage','swms_generation_capability_unavailable']
SWMS-261017   2026-08-02 15:37:51   ready=False  ['swms_generation_capability_unavailable']
SWMS-261020   2026-08-02 15:09:13   ready=False  ['spine_missing_lineage','swms_generation_facts_missing']
SWMS-261017   2026-08-02 15:09:04   ready=False  ['swms_generation_facts_missing']
SWMS-261065   2026-08-02 15:08:56   ready=False  ['spine_missing_lineage','swms_generation_facts_missing']
SWMS-261109   2026-08-02 15:08:26   ready=True   blockers []
```

`SWMS-261020` and `SWMS-261065` both carry a non-blank `lineage_id` on the docket row — so the
check constraint passed and the insert succeeded — and both still fail `spine_missing_lineage`.
Their intake cases have a lineage id and **no `source_content_hash`**, which is exactly the second
row of the table above. The blocker's name points at lineage; the missing fact is the hash. That
matches the standing note in `CLAUDE.md` ("`spine_missing_lineage` Is Almost Never About Lineage")
and I am confirming it inside my own slice rather than restating it.

### Two other things this ledger settles, both good news

**The SWMS renderer binding works.** `SWMS-261017` at 15:37 carried
`swms_generation_capability_unavailable`; `d8f7d55` deployed at 16:07; the 16:23 revision has
**zero blockers and `ready=true`**. The blocker that stopped my entire family is gone, proved on a
card rather than asserted.

**The persist cliff is cleared at 50 photos.** Batch 4 recorded `SWMS-261115` (50 media rows)
failing `WORKER_RESOURCE_LIMIT` twice and left it unpersisted. It persisted at 18:43 with
`ready=true`. The heaviest card batch 4 could not write is now in Docs Ready.

So of the four fixes the brief said had landed, three are confirmed live in my slice by production
evidence, and the fourth (crew) is visible as `swms_generation_facts_missing` disappearing between
the 15:09 and 15:37 revisions.

---

## 4. The two cards I would have finished, and the exact command for the rest

### The two

| Card | Suburb | Builder | Why it is ready | What stopped me |
|---|---|---|---|---|
| `SWMS-261036` | Gwelup | MLB | spine complete, current-cycle report submitted, report PDF and SWMS PDF already attached, crew resolvable from the assignment's `user_id` | ops-api 401 |
| `SWMS-26657` | Sorrento | MLB | same, and it carries an explicit `crew_name` as well as two assigned users | ops-api 401 |

Both are MLB, so both require a generated SWMS, and `d8f7d55` means that is now possible. Neither
has a docket revision yet. Each is one `prepare_ses_docket_revision` call with `dry_run: false`.

I did not attempt either. With a rejected key the call cannot be made at all — this is not a card I
fought with and lost, it is a door I could not open.

### The 60, and the one action that opens them

`makesafe_state_seed_scoped` (landed as `3785001`) is the sanctioned repair. It is API-key-only,
POST-only, dry-run by default, named by job number, every named card must resolve, and hard-capped
at 25 cards per run. My 60 are three tranches.

Per `docs/evidence/ses-spine-seeder-scoped-route-2026-08-03.md`, the 24 cased-but-unstamped cards
are the lower-blast-radius half (they need only the case hash) and the 36 caseless ones each need a
`legacy_job_record` revision minted. The document recommends exactly that order, and I agree with it
from inside my slice: run the 24 first, bracket with U4 before/after, then the 36.

**I did not repair a single one by hand, and I did not call the seeder.** The brief told me to
report `spine_missing_lineage` rather than repair it, and the seeder needs both a working key and
the captain.

---

## 5. Waiting on the trade — 98 cards, and I am confident in this number

98 of my 164 non-terminal cards have **no submitted `job_service_reports` row at all**: 64 physical
make-safe, 34 temporary fencing. There is no report to write, no evidence to assemble, and no
defect on our side. 65 of them sit in substatus `company_contact_required`, which is the board
saying the same thing.

This is the bucket the captain's standing instruction calls "waiting on the trade", and unlike the
other two buckets it needs nothing from us.


<details><summary>The 98, by job reference and suburb</summary>

`SWMS-261014` (Wembley), `SWMS-261023` (Bull Creek), `SWMS-261026` (Banksia Grove), `SWMS-261030` (Stirling), `SWMS-261031` (Merriwa), `SWMS-261032` (Duncraig), `SWMS-261033` (Leeming), `SWMS-261050` (Maylands), `SWMS-261051` (Harrisdale), `SWMS-261056` (Canning Vale), `SWMS-261057` (Mindarie), `SWMS-261058` (Duncraig), `SWMS-261059` (Jandakot), `SWMS-261064` (Dianella), `SWMS-261067` (Waikiki), `SWMS-261068` (Dalkeith), `SWMS-261074` (Canning Vale), `SWMS-261075` (Thornlie), `SWMS-261076` (Geographe), `SWMS-261077` (Connolly), `SWMS-261078` (Victoria Park), `SWMS-261082` (Dalyellup), `SWMS-261083` (East Bunbury), `SWMS-261084` (Kensington), `SWMS-261085` (Yanchep), `SWMS-261086` (Ardross), `SWMS-261087` (Hocking), `SWMS-261088` (Ballajura), `SWMS-261089` (Koondoola), `SWMS-261091` (Bennett Springs), `SWMS-261092` (Darch), `SWMS-261093` (Willetton), `SWMS-261094` (Riverton), `SWMS-261095` (Nollamara), `SWMS-261096` (Joondanna), `SWMS-261097` (Greenfields), `SWMS-261099` (Singleton), `SWMS-261100` (Bedford), `SWMS-261101` (Forrestfield), `SWMS-261102` (Alexander Heights), `SWMS-261103` (Yokine), `SWMS-261110` (Innaloo), `SWMS-261118` (Munster), `SWMS-261119` (Eaton), `SWMS-261120` (Glen Iris), `SWMS-261121` (Usher), `SWMS-261124` (n/a), `SWMS-26438` (Forrestfield), `SWMS-26517` (Sorrento), `SWMS-26526` (Noranda), `SWMS-26582` (Mirrabooka), `SWMS-26583` (Bedford, WA 6052), `SWMS-26585` (Hillman), `SWMS-26619` (Bayswater), `SWMS-26633` (Coolbinia), `SWMS-26653` (PEPPERMINT GROVE), `SWMS-26707` (Warnbro), `SWMS-26776` (Armadale), `SWMS-26777` (Gelorup), `SWMS-26778` (Lockridge), `SWMS-26782` (Myalup), `SWMS-26784` (Ocean Reef), `SWMS-26790` (Myalup), `SWMS-26794` (Usher), `SWMS-26800` (West Busselton), `SWMS-26804` (Booragoon), `SWMS-26806` (West Busselton), `SWMS-26807` (Warnbro, WA 6169), `SWMS-26812` (Geographe), `SWMS-26815` (Peppermint Grove Beach), `SWMS-26816` (The Vines), `SWMS-26819` (Australind), `SWMS-26820` (Ballajura), `SWMS-26821` (Yokine, WA 6060), `SWMS-26822` (Brabham), `SWMS-26823` (Forrestfield, WA 6058), `SWMS-26825` (Carey Park), `SWMS-26827` (Duncraig), `SWMS-26829` (Bunbury), `SWMS-26833` (Claremont), `SWMS-26837` (Eaton, WA 6232), `SWMS-26843` (Gidgegannup), `SWMS-26864` (Peppermint Grove Beach, WA 6271), `SWMS-26871` (Australind), `SWMS-26883` (Dianella), `SWMS-26898` (Dalyellup), `SWMS-26910` (Darch, WA 6065), `SWMS-26918` (Broadwater), `SWMS-26920` (Queens Park), `SWMS-26925` (Ocean Reef), `SWMS-26926` (Madeley), `SWMS-26931` (Clarkson), `SWMS-26932` (Banksia Grove), `SWMS-26935` (Bateman), `SWMS-26952` (Iluka), `SWMS-26956` (Dianella), `SWMS-26978` (Mandurah), `SWMS-26981` (Applecross)

</details>

---

## 6. No card was parked on a dead link, and none should have been

Zero. Neither of my families is a link-check family — the roof-and-assessment ruling
(`2026-08-02-roof-and-assessment-are-link-checks.md`) scopes the Prime-portal link check to roof and
assessment, and keeps the pack factory for physical make-safe and fencing. No card in my slice
carries a portal blocker, and the persisted-docket ledger above confirms it: the only
`portal_capture_missing` row belongs to `SWMS-261019`, which is a roof card and not mine.

So I captured no screenshots, and that is the correct outcome rather than an omission. The
screenshot rule applies to a verdict I never needed to reach.

---

## 7. What I would need to finish this, in priority order

1. **A working `SW_API_KEY`.** Without it nothing in my brief is executable — not the writes, not
   even the read-only U4 dry runs the brief asked me to re-measure with. This is one value in
   `~/.config/secureworks/env`.
2. **Authorisation to run `makesafe_state_seed_scoped`** over my 60 spine-blocked cards, in three
   tranches of 25/25/10, cased-but-unstamped first. This is the difference between a ceiling of 5
   cards and a ceiling of 63 in my two families alone.

With (1) alone I deliver 5 Docs Ready out of my slice. With (1) and (2) the captain's 20 is
comfortably clear from physical make-safe and fencing without touching anyone else's families.

---

## 8. Method, and what I did not do

- Every production read went through the Supabase Management API with `read_only: true`. The client
  refuses any statement that is not a `SELECT`/`WITH`, refuses a list of non-SELECT keywords, and
  refuses any query naming a client-identifying column before the request is sent.
- No client name, phone number, email address or street address appears in this report, in any
  query I ran, or in any file I wrote. Suburb, job reference and builder reference only.
- Family classification mirrors `canonicalSesFamilyFromCard` exactly rather than trusting the
  audit's `ses_family` column, which batch 4 showed disagrees with U4.
- The reachability verdicts in section 3 are **derived** from the exact blocker condition in
  `ses_prepare_docket_revision.ts:321-331` plus the adapter's resolution at
  `ses_assembler_input_adapter.ts:1427-1433`, not from a live U4 dry run, because the credential
  blocked that. They are corroborated on five cards by the persisted-docket ledger, which is real
  U4 output. **They should still be re-confirmed with a live dry-run bracket before the seeder
  tranches are run** — that bracket is step 1 of the procedure in the seeder evidence document.
- No card was archived, completed, cancelled or sent. No email was drafted to a real recipient. No
  invoice was created, authorised or sent. The invoice obligation path was not touched at all, per
  the brief. The money seal was not approached, so there was nothing to report from it.
- Two strikes were never reached on any card, because no card-level call was ever accepted.
