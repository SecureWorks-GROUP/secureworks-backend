# Story card causes, 14 October 2026

This change fixes the backend portions of the three-job written-story trial's causes 1, 3 and 4. It does not make Overview v2 the default or certify rewritten stories. The migration changes function definitions, comments and helper grants only. It contains no data update, insert, delete, placement, flag, setting, rebuild request or cron change. The Edge change affects future Outlook captures only.

## Measured before editing

SELECT-only reads of production `kevgrhcjxspbxgovpmfl`, 14 October 2026. All replaced bodies were obtained with `pg_get_functiondef`, not reconstructed from older migrations. Version `20261014120000` was absent from the live ledger and repository. No production write, deployment, rebuild, placement drain or re-check was run.

* **Cause 1:** all F-C1 through F-C4 and F-S14 already appear in `context_ledger_packet.held.rows` and `context_job_story_writer_input.card.held_messages.items`. The live reader returns 18 worded held rows for SWF-261423; the card's 21 unplaced count includes rows that do not pass this worded-message admission. F-C1 is 4,780 characters and the extra-concrete promise begins at 4,122. The packet cut it at 3,000 and the card at 400. F-C2 is 5,508 characters. Both now fit the same 6,000-character transcript/document limit used for placed evidence; other messages use 3,000. Every cut is marked. Row caps, candidate jobs, certainty, citations, evidence counts and `evidence_until` are unchanged.
* **Cause 3:** S-City's saved `inbox_events` body is a 251-character preview ending inside the forwarded headers; its old business-event copy has the same 251 characters. The later Outlook internal forward contains only its 89-character subject. `emails` has no saved full copy for this subject. Outlook capture requested `uniqueBody` but not `body`; Graph's unique part omitted the supplied correspondence. The Graph read now also requests the full body. Explicit forwards retain that body separately in `payload.forwarded_correspondence`, bounded and labelled. `context_story_message_text` adds it only for notes evidence and citation text. `context_event_text`, the placement ladder, sender/recipient identity, privacy admission and ordinary replies remain unchanged. Receipt of existing plans is not patio approval.
* **Cause 4:** SWP-261267's only value check is kind 7 (no app `sent_at`). Its quote was actually emailed, with the stored quote PDF bound to that exact outbound event. The proposed read finds that event at 20 August 05:38 UTC. It accepts the exact quote filename token, or a whole-job filename only with one quote on that Perth day, same job/customer, captured by the read time and no intervening version. No send stamp is written.

SELECT-only counterfactual: the new value function's SELECT body was executed inline against production (no function installed). It keeps all values and issued totals unchanged:

| Job | Before check kinds | After check kinds | Value | Issued |
| --- | --- | --- | ---: | ---: |
| SWF-261423 | 8, invoice on another job | unchanged | 4,763.00 | 2,381.50 |
| SWP-261267 | 7, missing app send stamp | none | 10,497.38 | 5,248.69 |
| SWP-261180 | 3 and 6, invoice base/final balance conflicts | unchanged | 6,298.71 | 3,790.60 |

The existing R8 loop still decides whether work is complete. When it says `not_due` and money has a known uninvoiced amount, the card now explicitly marks the amount `held: true`, `status: not_due` and says it is not owed now. This neither adds an issued debt nor clears a genuine C2 conflict.

## Remaining delivery dependencies

The live backend already exposed held messages, but Jarvis's field-by-field consumers discard them. On main inspected during this task: `src/automation/luna-job-ledger.ts:270-274` returns no `held` field; its prompt at `:1667-1684` renders evidence and siblings only. `src/automation/luna-story-writer.ts:320-430` renders named card blocks and notes but no `held_messages`. These are Jarvis changes, not backend changes. [The separate writer fix](https://github.com/SecureWorks-GROUP/secureworks-jarvis/pull/237) was read back as merged; held-channel consumption remains a distinct dependency. It must preserve job-not-certain context and sibling distinctions, not turn the damaged-side panel/cash into this job's matter or make off-job evidence citable.

D-S30 and D-S2 remain `admin_bucket` with no stored candidate jobs, so they are outside the held-message rule. This PR does not invent candidates or run the held placement decision. The missing historical City body cannot be recovered by a SQL reader: an authorised history recovery is required, followed by authorised rereads and the same three-story independent audit. No existing receipt, note or written story is rewritten here. The migration does not make a held row wake a notes read.

## Function changes from the live definitions

The following are exact body diffs, with comments/grants described separately. The pre-image guard accepts only the measured live body or this migration's own body. The rollback restores the seven measured bodies and comments exactly. New helper names also refuse an unknown pre-existing implementation.

### `context_ledger_packet`

Live `md5(prosrc)`: `b04863d6bd6f8ceaadb102532b8136a2`. Proposed: `93ddf3979e8c0c3625c425a3934f4838`.

```diff
--- live/context_ledger_packet

+++ proposed/context_ledger_packet

@@ -103,6 +103,6 @@

  -- refuses them as off the job), and their placement is not read as this job's. A rebuild is given
  -- the newest 40; an update the newest 40 that landed after p_since and, when there is one, the 6
- -- newest it was given before, to read them by. Oldest first; text capped at 3,000 characters for
- -- a transcript or document text and 1,500 otherwise.
+ -- newest it was given before, to read them by. Oldest first; text capped at 6,000 characters for
+ -- a transcript or document text and 3,000 otherwise, as for placed evidence; cuts are explicit.
  WITH h AS (
   SELECT * FROM public.context_ledger_held_rows(ARRAY[p_job_id], v_as_of)
@@ -128,5 +128,6 @@

      'placed_on', 'none', 'certainty', 'job_not_certain', 'from_this_customer', sel.same_contact,
      'held_rule', sel.held_rule, 'candidate_jobs', sel.candidate_jobs, 'other_jobs', to_jsonb(sel.other_jobs),
-     'text', left(sel.body, CASE WHEN sel.kind IN ('call.transcript_completed', 'document.text_extracted') THEN 3000 ELSE 1500 END))
+     'text', left(sel.body, CASE WHEN sel.kind IN ('call.transcript_completed', 'document.text_extracted') THEN 6000 ELSE 3000 END),
+     'cut', length(sel.body) > CASE WHEN sel.kind IN ('call.transcript_completed', 'document.text_extracted') THEN 6000 ELSE 3000 END)
      ORDER BY sel.at, sel.src_id) FROM sel), '[]'::jsonb))
  INTO v_held;
```

### `context_job_story`

Live `md5(prosrc)`: `72da3ec164693a91819016eace85e895`. Proposed: `9ba28fe55db39844b2a9b83dc448eaad`.

```diff
--- live/context_job_story

+++ proposed/context_job_story

@@ -8,5 +8,5 @@

  -- this job's (context_job_story_held), marked job not certain: only when there are any, so a job
  -- with none reads exactly as before, and never in the records-only read
- SELECT st.story || CASE WHEN hm.held IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('held_messages', hm.held) END
+ SELECT public.context_job_story_payment_terms(st.story) || CASE WHEN hm.held IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('held_messages', hm.held) END
  FROM (SELECT public.context_job_story_assemble(
   (SELECT jsonb_build_object('id', jb.id, 'job_number', jb.job_number, 'type', jb.type, 'status', jb.status,
```

### `context_job_record_value`

Live `md5(prosrc)`: `ed329078f075719e650797926df6d3da`. Proposed: `b21ec0726cc49af6c7275adc3bb8f50c`.

```diff
--- live/context_job_record_value

+++ proposed/context_job_record_value

@@ -24,7 +24,9 @@

   FROM j
  ),
+ qs AS MATERIALIZED (SELECT * FROM public.context_job_quote_email_sends(p_job_ids, p_as_of)),
  qd AS (  -- quote documents as the reference reads them (type contains "quote"), stamps after p_as_of unset
   SELECT d.id, d.job_id, d.quote_number, d.version, d.created_at,
-         CASE WHEN d.sent_at <= p_as_of THEN d.sent_at END AS sent_at,
+         coalesce(CASE WHEN d.sent_at <= p_as_of THEN d.sent_at END,
+                  (SELECT es.sent_at FROM qs es WHERE es.document_id = d.id)) AS sent_at,
          CASE WHEN d.accepted_at <= p_as_of THEN d.accepted_at END AS accepted_at,
          CASE WHEN d.declined_at <= p_as_of THEN d.declined_at END AS declined_at,
```

### `context_job_story_held`

Live `md5(prosrc)`: `e9e5db3d25199d2273eac53c4fbb1786`. Proposed: `ed4eb54cdbc2e903f4c9f33b8bfee840`.

```diff
--- live/context_job_story_held

+++ proposed/context_job_story_held

@@ -25,5 +25,6 @@

       't', h.src_table, 'id', h.src_id, 'at', h.at, 'channel', h.channel, 'kind', h.kind, 'direction', h.direction,
       'from', h.sender, 'from_role', h.sender_role, 'ours', h.ours, 'automated', h.automated, 'subject', h.subject,
-      'text', left(h.body, 400), 'cut', length(h.body) > 400,
+      'text', left(h.body, CASE WHEN h.kind IN ('call.transcript_completed', 'document.text_extracted') THEN 6000 ELSE 3000 END),
+      'cut', length(h.body) > CASE WHEN h.kind IN ('call.transcript_completed', 'document.text_extracted') THEN 6000 ELSE 3000 END,
       'job_certain', false,
       'label', CASE WHEN h.same_contact THEN 'from this customer, job not certain' ELSE 'may be about this job, job not certain' END,
```

### `context_ledger_evidence_rows`

Live `md5(prosrc)`: `2c3dbfef58572e08a630444692d61242`. Proposed: `f660fe3e9484200448b451cfa5f33d64`.

```diff
--- live/context_ledger_evidence_rows

+++ proposed/context_ledger_evidence_rows

@@ -35,5 +35,5 @@

    (coalesce(e.payload ->> 'sent_by_kind', '') = 'workflow' OR public.context_internal_text_role(e) <> 'other') AS automated,
    nullif(btrim(e.payload ->> 'subject'), '') AS subject,
-   public.context_event_text(e) AS body,
+   public.context_story_message_text(e) AS body,
    'this_job'::text AS placed_on,
    -- A call log (not a transcript) says whether its transcript is on the job: the
```

### `context_ledger_cite`

Live `md5(prosrc)`: `c126255e2f405fa17341545146723fe0`. Proposed: `44b8faee5207fa4a4604dbcb25cbfc12`.

```diff
--- live/context_ledger_cite

+++ proposed/context_ledger_cite

@@ -37,5 +37,5 @@

    RETURN jsonb_build_object('ok', false, 'code', 'citation_not_admissible', 'detail', v_table || ':' || v_id);
   END IF;
-  v_body := public.context_event_text(e);
+  v_body := public.context_story_message_text(e);
   v_worded := btrim(v_body) <> '';
   v_subject := nullif(btrim(e.payload ->> 'subject'), '');
```

### `context_ledger_held_rows`

Live `md5(prosrc)`: `dcdfdb1d63e56dd4f85def29bc9b7c3e`. Proposed: `df1971a701be94dec3900448b3b53c69`.

```diff
--- live/context_ledger_held_rows

+++ proposed/context_ledger_held_rows

@@ -34,5 +34,5 @@

    (coalesce(e.payload ->> 'sent_by_kind', '') = 'workflow' OR public.context_internal_text_role(e) <> 'other') AS automated,
    nullif(btrim(e.payload ->> 'subject'), '') AS subject,
-   public.context_event_text(e) AS body,
+   public.context_story_message_text(e) AS body,
    nullif(btrim(e.metadata ->> 'placement_rule'), '') AS held_rule,
    e.attribution_status AS held_status,
```

New helpers, all executable only by `service_role`:

* `context_job_quote_email_sends(uuid[], timestamptz)`: reads the captured sent email and its stored named quote attachment; no model or text-only mention can prove sending. `context_job_record_value` materializes the batch once.
* `context_job_story_payment_terms(jsonb)`: pure card decoration from the existing R8 judgement; does not determine completion or calculate money.
* `context_story_message_text(business_events)`: pure evidence-text composition, deliberately not used by placement. Admissibility and excerpt checks remain in their existing owners.

Definitions are in `supabase/migrations/20261014120000_context_story_card_causes.sql`. Replaced functions preserve signatures, security attributes and grants. Comments retain their original slice prefixes. Older contracts reverse this migration inside their rolled-back reapply/break proofs before asserting an older body's identity.

## Validation

* Full registered PostgreSQL migration stack applied on a task-owned disposable PostgreSQL 17 database.
* Every registered behaviour contract passed sequentially against that stack, including existing story safety, held-message, ledger-store and quote-builder contracts.
* New invented-name fixtures prove the long held transcript reaches the real writer-input read without becoming citable; full forwarded correspondence is readable/citable but excluded from placement text; sent quote proof, wrong recipient, whole-token boundaries, ambiguous same-day quotes and later versions; genuine final-invoice conflict retained; a future balance held with zero owing.
* New migration reapply is unchanged; rollback restores all seven live body hashes. Deliberately broken send proof fails the new contract. An unknown helper implementation refuses migration.
* Outlook capture/Graph/builder and generated SQL row parity: 80 Deno tests passed. Both `ops-api/index.ts` and `outlook-mail-capture/index.ts` pass `deno check`; the three edited implementation modules pass `deno lint`.

The three live stories have not been regenerated or certified by this work.
