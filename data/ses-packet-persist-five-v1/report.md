# SES reporting skill over five captain-named cards — persist path

Task `ses-packet-persist-five-v1`. Branch `fm/ses-packet-persist-five-v1`, isolated treehouse
worktree of `secureworks-backend`. Written as the run went.

Cards: `SWMS-261021`, `SWMS-261015`, `SWMS-261065`, `SWMS-261109`, roof card `SWMS-261019`.

---

## THE HEADLINE (written first, updated as the run went)

> **Two of the five were already done and I left them provably untouched. Three were run. Of those
> three, one persisted — the roof card `SWMS-261019`, which is now in the Docs Ready review queue
> and took it from 38 to 39. The other two walled on the same safety gate, reported verbatim
> rather than improvised around.**

| Card | Suburb | Outcome | Evidence |
|---|---|---|---|
| `SWMS-261019` (roof) | Floreat | **persisted → Docs Ready** | revision `5f7b2016…` superseded the blocked `1c93be74…`; `pre_xero_docs_ready` false → **true**; queue seq 39 |
| `SWMS-261109` | Bertram | **already done — pass, not skip** | revision `31daa258…`, queue seq 1, committed 2026-08-02T15:08Z — one of the original three |
| `SWMS-261065` | Munster | **already done — pass, not skip** | revision `e4fdae2c…`, queue seq 7, committed 2026-08-02T23:59Z — batch-5 tranche A. **See §6a: it also carries a "job is dead" ops note.** |
| `SWMS-261021` | Floreat | **WALL — not persisted** | `swms_generation_facts_missing`, `missing_facts: ["crew"]`; `assignments: []` |
| `SWMS-261015` | Tuart Hill | **WALL — not persisted** | same wall, byte-identical; `assignments: []` |

**Count line: 1 card into Docs Ready, 2 already there and untouched, 2 walled. Queue 38 → 39.**

**No card was archived, completed, cancelled or sent. No email was drafted to any recipient. No
Xero invoice was created, authorised or sent. The money seal was never approached — no money path
was called, so there was no 403 and no 409 on it.**

---

# READ THIS FIRST — two contract findings that outrank the count

Both are defects in the **documented run path**, not in any card. Both will hit the next runner on
the first card they touch. Full working in §2c, §2d and §4.

## FINDING 1 — the skill's step-2 validator gate cannot pass for ANY assembler-built pack, on any card

The run contract's step 13 and the packet's step 2 both make this a hard gate:

> `scripts/validate_review_pack.py <pack> --pre-xero` must exit 0.

**It cannot, today, for any card.** Two independent reasons, and the second is the fatal one.

**a. Before the persist there is nothing to validate.** On the U4 persist path the assembler is
**server-side**. A `dry_run: true` returns the docket envelope, item states, priced proposal and an
artifact table of paths and `sha256` hashes — but **no bytes**. The artifacts are written only on
`dry_run: false` (`ses_prepare_docket_revision.ts:2676` gates the whole persist block, upload
included). `validate_docket_manifest` requires every `ready` artifact item to resolve to an existing
in-pack file (`docket_manifest.py:608-612`). So at the moment the gate is supposed to run, the pack
does not exist. The ordering in the doc is inherited from the pre-Lavish era when the runner
assembled the pack on disk.

**b. After the persist it still fails — 25 times — because the two sides are different contracts.**
I fetched all 13 artifacts of the real persisted revision through `get_ses_reviewable_pack`'s signed
URLs, wrote them at their in-pack paths (every one matched its recorded `size_bytes`), and ran the
gate:

```
$ validate_review_pack.py pack-261019 --pre-xero
PASS: 0 jobs review-ready
FAIL: 25 validation issues
exit 1
```

**20 of the 25 come from the server's own `docket_manifest.json` and `case_story.json`, which I
copied byte-for-byte and did not author.** It is a vocabulary mismatch, not a near-miss:

| The assembler emits | The Python gate requires |
|---|---|
| `files:SOURCE/work_order_….pdf` | `file:<path>` — one character apart, and the file **is** in the pack |
| `case-story/assembler-spine-v1` (522 bytes) | `case-story/v1` with `timeline`, `attempts`, `evidence_map`, `artifact_ledger`, `recovery_cursor`, `correlation` + the full rule corpus — **12 of the 20 failures are this one artifact** |
| `line_items` in `invoice_proposal.json` | `lines` |
| `draft_builder_report_email` n/a rule `portal-is-the-report` | only `cancelled-before-builder-report` allowed |
| `hrcw_assessment` evidence `file:case_story.json#hrcw` | `rule:no-hrcw-found#<source>` |
| `supporting_invoice_pdf` reason_code `recovery-not-run` | `pre-xero-captain-invoice-approval` |

**On the substantive points the backend is the one that is right.** Four of the five remaining
failures are places the Python contract has no shape for a portal roof card: it demands a
`makesafe_report` document and a `REPORT_EMAIL_DRAFT.txt`, while the assembler correctly marks both
`not_applicable` because for MLB's sealed portal route *the portal is the report*.

**This does not mean the persist is ungated.** The backend carries the gate's twin —
`validatePreXero` (`ses_prepare_docket_revision.ts:1309-1326`): zero blockers, priced proposal
bound, `invoice_proposal` artifact present, no required item blocked except the deliberately
deferred `supporting_invoice_pdf`. `docket_manifest.py:26-30` documents the mirroring in its own
comment. That is the gate that ran, on the real pack, and it is why the card persisted.

**Consequence for the record:** this was equally true for the 35 dockets the batch-5 run persisted.
That report never mentions running the validator, which now reads as the same discovery made
silently. **Either the Python gate is retired from the persist path and `validatePreXero` named as
the gate, or the two vocabularies are reconciled.** Not a runner's call — flagging it.

*I did not translate the six vocabulary items and hand-write a `case-story/v1` to force a green.
That would have certified my transcription, not the card.*

## FINDING 2 — the persist payload documented in the wiki skill is wrong and is rejected by production

`harness/ops/skills/secureworks-makesafe-reporting/references/docs-ready-persist.md` (and the
packet, which copies it) documents:

```
selection: {job_numbers: ["SWMS-......", ...]}
```

Production answers **HTTP 400**:

```
{"error":"selection must be exactly one job_id, job_number, or board_batch limit from 1 to 50.",
 "code":"ses_selection_invalid"}
```

The real contract (`ses_assembler_input_adapter.ts:2514-2545`) is **one card per call**, mode-tagged:

```
selection: {mode: "job_number", job_number: "SWMS-261019"}
```

The other two modes are `{mode:"job_id", job_id:…}` and `{mode:"board_batch", limit: 1..50}`. A
`job_numbers` array is not a shape the adapter has — note the doc also implies you can batch several
cards into one call, and you cannot. **The wiki doc needs correcting; it is what the next runner
will copy from.**

### Bonus, same class, costs one round trip

`ops-api` dispatches on the **query-string** `action`. A POST carrying `{"action": …}` in the JSON
body alone returns `{"error":"Unknown action"}`, which reads exactly like a missing or undeployed
action and is not. Action in the URL, arguments in the body.

And: check a validator's exit status **without a pipe**. `… | head` reports `head`'s 0 and hides a
failing gate — that is how a red gate reads as green.

---

# ALSO NEEDS A RULING — `SWMS-261065` (Munster) is in the review queue saying it is dead

It has been in the Docs Ready queue since the batch-5 run (revision `e4fdae2c…`, queue seq 7),
`pre_xero_docs_ready: true`, awaiting signoff, with a completed assignment recorded against it.

Its standing ops note says the opposite:

> FIRSTMATE TRIAGE 2026-07-28: DEAD, CLOSURE PROVEN: Quote-only request; Khairo quoted 07-22; MLB
> 07-23 "please disregard job". Ops must leave this cancelled or handed-back card archived; no
> attendance, report, invoice, or outbound send is owed.

**Those two records disagree, and the disagreement is sitting in the captain's review queue looking
like work.** Either the note is stale, or the docket should be withdrawn from the queue. I did not
touch the card and I am not deciding which. It needs a ruling.

---

## 0. Two corrections to the packet, found before any write

**a. PR #511 is MERGED and DEPLOYED.** The packet says "PR #511 is green but NOT merged, so the
invoice-obligation gate is still live in production. Expect the 409." It is not still live.
`ops_api_version` returns:

```
commit_sha   049248189eed073c01d7ec84266873e11f96051d
deployed_at  2026-08-03T00:36:25Z
build_label  ops-apiV1-trusted-18MAY-plus-secure-sale
```

`0492481` is `fix(ops-api): drop unsatisfiable SES readiness preconditions (#511)`, and it is the
HEAD of `main` in this repo. Per the deploy lane, migrations apply before the edge deploy, so
`20260803010000` and `20260803020000` went in with it.

**Confirmed by the orchestrator mid-run**: #511 is merged and live as `0492481`, migrations applied
and verified, and the expected-409 instruction in the packet is withdrawn. That matches what I had
already read off the deploy identity before any write.

**No readiness refusal occurred, and no invoice-obligation call was made.** The obligation step
(`prepare_ses_invoice_obligation`) is not in this packet's scope — the packet's only action is
`prepare_ses_docket_revision` — so this run is not a test of that gate in either direction. If a
later run does call it and it still refuses on readiness grounds, that is the thing to stop on; I
have nothing to report there because I never reached it.

**b. `ops-api` dispatches on the QUERY-STRING `action`, not the JSON body.** A POST carrying
`{"action": ...}` in the body alone returns `{"error":"Unknown action"}` — which reads exactly like
a missing action and is not. The action must be in the URL; the body carries the arguments. Cost me
one wrong turn; recording it so it costs the next crew none.

---

## 1. Read-only before-state — the whole reason two cards were left alone

Read live from the canonical server board (`makesafe_board`, 440 rows) and the signoff queue
(`list_ses_docs_ready_reviews`, 38 dockets), joined on the board's `id`.

| Card | Family | `pack.state` | Revision persisted | `pre_xero_docs_ready` | In review queue | `canonical_stage` |
|---|---|---|---|---|---|---|
| `SWMS-261021` | physical_makesafe | `failed` | no (`null`) | false | no | `trade_report_in` |
| `SWMS-261015` | physical_makesafe | `failed` | no (`null`) | false | no | `trade_report_in` |
| `SWMS-261065` | physical_makesafe | `drafted` | **yes** `e4fdae2c…` | **true** | **yes** | `report_ready` |
| `SWMS-261109` | physical_makesafe | `drafted` | **yes** `31daa258…` | **true** | **yes** | `report_ready` |
| `SWMS-261019` | ordinary_roof_portal | `drafted` | **yes** `1c93be74…` | **false** | no | `allocated` |

**No card reads `pack.state: sent`**, so the stop-and-report rule for a sent pack never fired.

The queue rows confirm provenance directly:

- `SWMS-261109` — docket `31daa258-5fc7-540c-9ced-c9d1b468195d`, committed `2026-08-02T15:08:26Z`,
  `review_event_sequence: 1`. That is one of the **original three** dockets that were in the queue
  before the batch-5 run, exactly as the packet anticipated.
- `SWMS-261065` — docket `e4fdae2c-ed67-53e3-83e8-ca7f61660bd9`, committed `2026-08-02T23:59:20Z`,
  `review_event_sequence: 7`. That is the **batch-5 run** (`ses-run-skill-batch5-packs-v1`), where
  it was one of the four staged tranche-A proof cards.

Both are `review_state: needs_review`, `event_kind: prepared`, `invalidated_signoff_event_id: null`,
`assembler_version: ses-pack-assembler/v1`.

### Verdict on those two: already done, do NOT re-persist. Recorded as a pass, not a skip.

A fresh revision on either would invalidate the existing signoff tick and re-open it as review
noise — the exact harm the batch-5 run inflicted on five other cards and reported honestly. I did
not re-persist them.

---

## 2. Two more packet corrections, found while running

**c. The packet's persist payload is rejected by production.** The packet (and the wiki skill doc
`references/docs-ready-persist.md`) both specify:

```
selection: {job_numbers: ["SWMS-..."]}
```

Production answers that with HTTP 400:

```
{"error":"selection must be exactly one job_id, job_number, or board_batch limit from 1 to 50.",
 "code":"ses_selection_invalid"}
```

The real contract (`ses_assembler_input_adapter.ts:2514-2545`) is **one card per call**, tagged by
mode:

```
selection: {mode: "job_number", job_number: "SWMS-261019"}
```

`job_id` and `board_batch` (limit 1-50) are the other two modes; a `job_numbers` array is not a
shape the adapter has. I used the real contract. **The wiki skill doc is wrong on this and should
be corrected** — it is the doc a future runner will copy from.

**d. The local `validate_review_pack.py --pre-xero` gate cannot run before the persist, because the
pack does not exist yet.** This is the substantive one.

The packet orders it: build local pack → validate → dry-run → persist. That ordering is from the
pre-Lavish workflow, where the runner assembled the pack on disk. On the U4 persist path **the
assembler is server-side**. The dry-run returns the docket envelope, the item states, the priced
proposal and an artifact table of paths and `sha256` hashes — but no bytes:

```
SOURCE/work_order_MLB-27037PO-56395_...pdf     sha256:2eedfa2c…  154899 bytes
EVIDENCE/portal_roof_report.png                sha256:5a26c079…  248339 bytes
ARTIFACTS/invoice_proposal.json                sha256:33cdfe78…     322 bytes
case_story.json, docket_manifest.json, review_spec.json, …
```

The bytes are written only on `dry_run: false` (`ses_prepare_docket_revision.ts:2676` gates the
whole persist, artifact upload included). `validate_docket_manifest` requires every `ready` artifact
item to resolve to **an existing in-pack file** (`docket_manifest.py:608-612`), so before the
persist there is nothing on disk for it to read. I could only have satisfied it by hand-transcribing
the server's own envelope into a local folder and validating my transcription — which tests my
typing, not the card.

**The gate itself is not skipped, because the backend carries its twin.** `validatePreXero`
(`ses_prepare_docket_revision.ts:1309-1326`) enforces the same rule the Python gate does, and
`docket_manifest.py:26-30` says so in its own comment — zero blockers, a priced proposal present,
no required item blocked except the deliberately deferred `supporting_invoice_pdf`, and an
`invoice_proposal` artifact bound. That is the gate that actually ran, server-side, on the real
pack. I then ran the **Python gate after the persist**, against the real assembled pack, and
reported what it said (section 4).

One vocabulary note, checked so it is not mistaken for a defect: the packet asks for
`supporting_invoice_pdf` blocked with reason_code `pre-xero-captain-invoice-approval`. The backend
emits `recovery-not-run` and excludes the item structurally instead. Those are two implementations
of one rule, not a disagreement — `docket_manifest.py`'s own comment documents the mirroring.

---

## 3. Per-card results

All three live cards were dry-run first (read-only — `dry_run: true` skips the entire persist
block). Idempotency keys are fresh per card and reused between the dry-run and the real call.

### `SWMS-261021` — Floreat, ML Builders `MLB-27037` — **WALL, not persisted**

- **Dry-run:** `state: blocked`, planned revision `34ec00c8-837b-56f0-a547-13de47eae26f`,
  `input_content_hash: sha256:1ee8e45b…`, `persisted: false`.
- **Validator gate:** not reached. A blocked docket cannot pass `--pre-xero` (the backend twin
  refuses at `blockers.length`), so there was nothing to gate.
- **Persist:** **not attempted.** Persisting a blocked docket would put a card with no SWMS into
  the review queue.
- **Board:** unchanged — still `pack.state: failed`, no revision, not in the queue.

**The wall, verbatim:**

```
"reason_code": "swms_generation_facts_missing",
"reason": "U4 cannot generate the job-specific SWMS because crew is absent from the work order,
           bound field report, job or assignment.",
"searches_attempted": ["canonical-input-envelope", "sealed-swms-template-catalogue"],
"rejected_candidates": [],
"recovery_action": "Recover the named real-world fact from the work order, field report, job or
                    assignment and re-run U4; staff do not need to attach a SWMS.",
"facts": {"missing_facts": ["crew"]}
```

This is the safety gate working and I did not soften it. The board confirms the cause independently:
`assignments: []` — the card has **no assignment at all**, so there is no crew to read in any of the
four sources. This is the same `swms_generation_facts_missing` class the batch-5 run recorded for
this exact card; it has not moved, and re-running the skill will never clear it. It needs a named
crew recorded against the attendance, which is a data fact only a human has.

Everything else on the card is ready: work order retrieved, identified and attached
(`MLB-27037` / `PO-56459`), deliverables bound, HRCW assessed, builder routing resolved, report PDF
planned, and a priced proposal (`1 trade x 3 hours @ $85 = $255 ex / $280.50 inc`; reported 2 hours
raised to the 3-hour floor). **One missing fact is holding an otherwise complete card.**

### `SWMS-261015` — Tuart Hill, ML Builders `MLB-26658PO-56313` — **WALL, not persisted**

- **Dry-run:** `state: blocked`, planned revision `76851644-3a70-52e9-ad3e-67cc4ed39c83`,
  `input_content_hash: sha256:94d22661…`, `persisted: false`.
- **Validator gate:** not reached, same reason.
- **Persist:** **not attempted.**
- **Board:** unchanged — still `pack.state: failed`, no revision, not in the queue.

**The wall, verbatim:** byte-identical to `SWMS-261021` above — same `reason_code`, same reason
string, same `searches_attempted`, same `recovery_action`, same `"missing_facts": ["crew"]`.

Also `assignments: []`. Priced proposal `1 trade x 3.5 hours @ $85 = $297.50 ex / $327.25 inc`.

This card carries a standing ops note that says the same thing from the other side, dated six days
ago:

> FIRSTMATE TRIAGE 2026-07-28: CODE-CRACK. The trade app holds a current-cycle submitted report and
> 23 photos, but U4 still loses the source reference and deliverables and raises known-false SWMS
> fact inputs. System team must repair the source and input binding and re-run U4; staff must not
> attach a SWMS.

**Half of that note is now stale and worth correcting.** U4 no longer "loses the source reference
and deliverables" — as of today `source_work_order_retrieval`, `source_work_order_identity`,
`source_work_order_attachment` and `instruction_deliverables` all read `ready` on this card. The
only surviving blocker is crew. The note's instruction to staff — do not attach a SWMS — still
stands.

### `SWMS-261019` — Floreat, ML Builders `MLB-27037` (roof) — **dry-run READY**

- **Dry-run:** `state: ready`, `blockers: []`, planned revision
  `5f7b2016-b8f8-571a-8c9a-3e1db3f1e892`, `input_content_hash: sha256:35bd8b4a…`,
  `output_content_hash: sha256:700a8883…`.
- The persisted revision on the card before this run was `1c93be74-0421-51b9-92e9-586eed0cfc2f`,
  and it was **blocked** on `portal_capture_missing` + `pricing_evidence_missing`. The planned
  revision id is different, which is the **supersession the packet predicted**: the storey backfill
  changed the input hash. **This is the card becoming priceable, not a fault.**

**The backfill landed and it is what unblocked the card.** The proposal now reads:

```json
{"version": "ses-local-invoice-proposal/v1", "builder_reference": "MLB-27037",
 "basis": "roof_storey_fixed", "storeys": "single",
 "line_items": [{"description": "MLB-27037 - Single Storey roof report",
                 "quantity": 1, "unit_price_ex_gst": 250, "amount_ex_gst": 250}],
 "subtotal_ex_gst": 250, "gst": 25, "total_inc_gst": 275, "xero_identity": null}
```

`$275 inc` matches the locked single-storey roof price exactly (repo `CLAUDE.md`: Single $275 inc /
Double $385 inc, 2026-07-16). `pricing_evidence_missing` is gone because the storey fact now exists.

`portal_capture_missing` is gone too, and not because I did anything — the capture already existed
and the fresh derivation now reads it:

```
role: roof_report   status: done
captured_at: 2026-08-02T15:51:47Z   captured_by: ses-run-skill-batch1-v1
capture_producer: capture_portal_evidence.py/v1
signal: "form locked/submitted (form-locked banner), 22 of 24 answered"
content_fingerprint: sha256:95aad3ba…
```

Item states: `swms_artifact: not_applicable` (report-only), `supporting_report_pdf: not_applicable`
(the portal **is** the report for MLB's sealed portal route), `roof_report_link` and
`roof_report_capture` both `ready`, `draft_invoice_bundle_email` `ready`. The **only** blocked item
is `supporting_invoice_pdf`, which is the deliberate pre-Xero deferral.

**Persist** — same idempotency key `packet-five-261019-2026-08-03`, `dry_run: false`:

```
state: ready          persisted: true          blockers: []
docket_revision_id:  5f7b2016-b8f8-571a-8c9a-3e1db3f1e892
input_content_hash:  sha256:35bd8b4a4b6e5cfd6f2967270d48665a1bd8869db05c3bf1b6226a1b69436f55
output_content_hash: sha256:700a8883acf93667844457434df091608eefadc62a2baf5175fe86f7077a2dd4
committed_at: 2026-08-03T00:46:47.759115Z   duration 2218 ms   within_five_minutes: true
degraded_capabilities: []   retries: {}
```

**The planned revision and the persisted revision are the same id and the same two hashes.** The
dry-run predicted the persist exactly; nothing moved between the two calls.

**Board, re-read live afterwards** (`makesafe_board`, 440 rows, `parity.ok: true`, 0 errors):

| | before | after |
|---|---|---|
| `pack.docket_revision_id` | `1c93be74-0421-51b9-92e9-586eed0cfc2f` | **`5f7b2016-b8f8-571a-8c9a-3e1db3f1e892`** |
| `pack.pre_xero_docs_ready` | `false` | **`true`** |
| in Docs Ready review queue | no | **yes** |
| `blockers.real` | `portal_capture_missing`, `pricing_evidence_missing` | **`[]`** |
| queue size board-wide | 38 | **39** |

Queue row: `review_event_sequence: 39`, `review_state: needs_review`, `event_kind: prepared`,
`actor_identity: ops-api:api_key`, `invalidated_signoff_event_id: null`, reason *"The assembler
completed the audit-grade family pack."*

**One thing that did NOT move, and the captain should know it.** `canonical_stage` is still
`allocated`, not `report_ready`. The card is in the Docs Ready **queue** but it still renders in the
board's **Allocated** column. Its substatus is `company_contact_required`, which the board itself
flags as a stale artifact:

```
"stale_artifacts": [{"code": "stale_company_contact_substatus",
                     "source": "known_allocation_write_path"}]
```

So this is the same lesson batch 5 recorded from the other direction: **the queue is the honest
surface, the board column is not.** Counting Docs Ready by eye off the board will miss this card.

---

## 4. The `validate_review_pack.py --pre-xero` gate: run, and it FAILS

I ran it properly rather than skipping it or declaring it green. Because the bytes only exist after
the persist (section 2d), I ran it **after** the persist, against the **real** pack: I fetched all
13 artifacts of the persisted revision through `get_ses_reviewable_pack`'s signed URLs and wrote
them to disk at their in-pack paths. Every one matched its recorded `size_bytes`.

```
$ validate_review_pack.py pack-261019 --pre-xero
PASS: 0 jobs review-ready
HOLD: 0 jobs need review
FAIL: 25 validation issues
WARN: 0 advisories
exit 1
```

**Note the exit code was checked without a pipe.** Piping the run into `head` reports `head`'s
status, which is 0, and reads exactly like a pass. The gate's real exit is **1**.

### The 25, split by which artifact produced them

| Source | Count |
|---|---:|
| The **server's own** `docket_manifest.json` and `case_story.json`, copied byte-for-byte | **20** |
| My hand-built `MANIFEST.json` job-entry wrapper | 5 (of which 1 is really server data — see below) |

The split is mechanical: every failure prefixed `manifest:` is reading the server's docket manifest
or case story; the other five are the outer job entry I wrote.

**The 20 server-side failures are not near-misses. They are a different vocabulary.** Representative:

| The server emits | The Python gate requires |
|---|---|
| `files:SOURCE/work_order_….pdf` | `file:<path>` — a one-character prefix apart, and the file **is** in the pack |
| `case_story/assembler-spine-v1` (522 bytes) | `secureworks.makesafe.case-story/v1` with `timeline`, `attempts`, `evidence_map`, `artifact_ledger`, `recovery_cursor`, `correlation` and the full rule corpus — **12 of the 20 failures are this one artifact** |
| `draft_builder_report_email` n/a rule `portal-is-the-report` | only `cancelled-before-builder-report` is allowed for that item |
| `hrcw_assessment` evidence `file:case_story.json#hrcw` | `rule:no-hrcw-found#<source>` |
| `builder_routing` evidence `company:…#matrix:…#rule:mlb-perth-routing` | a bare regional rule name (the right rule name is present, in the wrong wrapper) |
| `supporting_invoice_pdf` reason_code `recovery-not-run` | `pre-xero-captain-invoice-approval` |

Of my five, four are places the Python contract has **no shape for a portal roof card**: it requires
a `makesafe_report` document and a `REPORT_EMAIL_DRAFT.txt`, while the backend correctly marks both
`not_applicable` because for MLB's sealed portal route *the portal is the report*. The fifth,
`invoice line metadata must include lines`, is server data — its `invoice_proposal.json` uses
`line_items` where the validator expects `lines`.

### What this means, stated carefully

**This is not the card failing. It is the two gates being two different contracts.**

- The card passed the gate that actually governs the persist: `validatePreXero`
  (`ses_prepare_docket_revision.ts:1309-1326`) — zero blockers, priced proposal bound,
  `invoice_proposal` artifact present, no required item blocked. That is why it persisted.
- `validate_review_pack.py` was written for **locally assembled** packs, from the era before U4
  did the assembly. Pointed at a U4 pack it rejects the assembler's own vocabulary.

I want to be careful about the one thing this does *not* prove. **I did not find a defect in the
card, and I am not claiming the U4 pack is wrong.** On the two substantive points I could check, the
backend is the one that is right: a portal roof card genuinely has no local report PDF and no
builder report email. The mismatch is in the skill's Python gate and in the wiki doc that still
names it as step 2 of the persist path.

**So the packet's step 2 as written — "`validate_review_pack.py <pack> --pre-xero` must exit 0" — is
not satisfiable for any U4-assembled pack today, on any card.** Not for mine, and not for the 35 the
batch-5 run persisted. That run never mentions running it, which now reads as the same discovery
made silently.

I did not "fix" this by editing the manifest until the gate went green. Translating the six
vocabulary items and hand-writing a `case-story/v1` would have produced a pass that certified my
transcription rather than the card.

---

## 5. What I did not do, and why

- **`SWMS-261065` and `SWMS-261109`: not re-persisted.** Verified after the run: both still carry
  their original `docket_revision_id`, the same `review_event_id`, and the same
  `review_event_sequence` (7 and 1). Untouched, provably.
- **`SWMS-261021` and `SWMS-261015`: not persisted.** Both dockets are `state: blocked`. Persisting
  either would have added a card with no SWMS to the captain's queue.
- **No Xero invoice created, authorised or sent**, on any card. The money seal was never
  approached — no money-path action was called, so there was no 403 and no 409 to report. All five
  cards are sealed; `supporting_invoice_pdf` reads `blocked` on the one docket I persisted, which is
  the deferral working as designed.
- **No draft invoice PDF was attached to the roof card.** `prepare_ses_docket_revision` writes only
  the append-only docket revision and artifact ledger; it attaches no `job_documents` row, so the
  close-out gate that would archive a roof card was never touched.
- **No card archived, completed, cancelled or sent. No email drafted to any recipient.** The one
  email draft in the persisted pack is the assembler's own `INVOICE_EMAIL_DRAFT.txt`, which lives
  inside the docket and is not addressed to or sent to anyone.
- **No Lavish page rendered or opened.** Lavish is retired.
- **The two Xero execution functions were never approached.**
  `begin_ses_release_execution_v1` and `begin_ses_invoice_execution_v1` were not called, not read
  and not referenced by anything in this run. The release-execution gate is awaiting the captain's
  explicit ruling and nothing here extends it, including by accident.
- **The Supabase Management API was never called**, its token never tested, and its `/secrets`
  endpoint never fetched. The failed deploy workflow was not re-run or inspected.
- **Two strikes:** reached once, on the packet's `job_numbers` selection shape. First call 400'd; I
  read the adapter, used the real contract, and it worked on the second. No card was fought twice.

---

## 6. Two card-level findings the captain should see

**a. `SWMS-261065` (Munster) is in the Docs Ready queue carrying a "job is dead" ops note.**
Stated in full at the front of this report under **ALSO NEEDS A RULING** — it is the one item here
that needs the captain rather than an engineer. Supporting detail: docket `e4fdae2c…`, queue seq 7,
committed 2026-08-02T23:59Z by the batch-5 run, `pre_xero_docs_ready: true`, one assignment
recorded `status: complete` with `completed_at: 2026-07-30T02:24:17Z`, and a submitted report with
9 photos on cycle 1 — all of which is why it reads as finished work rather than as a dead card.

**b. The standing note on `SWMS-261015` is now half stale.** It says U4 "loses the source reference
and deliverables and raises known-false SWMS fact inputs". As of today
`source_work_order_retrieval`, `source_work_order_identity`, `source_work_order_attachment` and
`instruction_deliverables` all read `ready`. The source binding was repaired. **Only the crew fact
is still missing**, and the note's instruction to staff — do not attach a SWMS — still stands.

---

## 7. Method and honest caveats

- Every write went through `ops-api` `prepare_ses_docket_revision` with the run key read from disk
  at call time. The key value was never printed, echoed, committed or logged.
- **Exactly one production write occurred**, and it was the authorised one: the docket persist on
  `SWMS-261019`. Everything else in this run was a GET.
- No client name, phone number, email address or street address appears in this report. Suburb, job
  reference and builder reference only. The materialised pack (which does contain a street address,
  a client name and the builder's mailbox) was written to the session scratchpad and is **not** in
  this repo or this commit.
- **The Supabase Management API was never used.** The packet reports its tokens dead and I did not
  test that or chase it. Consequence, stated exactly: every production fact in this report comes
  from `ops-api` reads (`makesafe_board`, `list_ses_docs_ready_reviews`, `job_detail`,
  `get_ses_reviewable_pack`) rather than from SQL. That was sufficient for every claim here — board
  stage, pack state, queue membership, docket revision ids, hashes and blocker text are all served
  by those endpoints. The one thing SQL would have added is a direct read of the
  `makesafe_ses_docket_revisions` row to confirm the old revision `1c93be74` is marked superseded
  rather than merely no longer pointed at by the board. **I could not verify that, and I am not
  claiming it** — what I verified is that the board's `pack.docket_revision_id` now names the new
  revision and the old one no longer appears.
- I did not fetch anything from the Management API `/secrets` endpoint.
- The `pre_xero_docs_ready` key is absent from the `prepare_ses_docket_revision` response itself; I
  read it from the board row after the persist, which is where it is derived.

