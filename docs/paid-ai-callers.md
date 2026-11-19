# Paid AI callers

P4-08.7. Subscriptions only. This register is remaining work, not permission to disable a route. No listed function, key, switch or cron is changed here.

Source: backend main `b7e90a2d`; Jarvis main `c55f6218` fetched from GitHub on 18 Nov 2026. Anchors below refer to those reads. Jarvis is another repository, listed but not checked by the backend test. Rows 1 and 3 correct the ticket labels: row 1 calls are in the Ops chat handler, after getAutoContext; the paid calls are in the request handler, outside `executeConfirmedAction`.

The JSON is `supabase/functions/_shared/paid_ai_register.json`. Line and function arrays align; `other_repository_sites` lists additional Jarvis files. The test checks backend endpoint markers, function ownership and anchors, and prints 17 rows. Endpoint markers in comments are inventoried too.

Calls a day not knowable from code are read by the director from the provider usage page per key. No runtime counter is added and no provider request is made here.

| # | Repository and file:line | Function | Provider / model | What | Runs | Fate | Safe without key |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | B supabase/functions/ops-ai/index.ts:3525,3605,3673,3691 | <request handler> | Anthropic / per call: Sonnet 4 or Haiku 4.5 | Ops dashboard chat, up to four calls per message | per chat message | Switch off after ops_chat_engine_agent_v1 is on (P4-08.4); then remove this function key | No: preserve the key until chat cutover |
| 2 | B supabase/functions/ops-ai/index.ts:2699 | evaluateAction | Anthropic / claude-haiku-4-5-20251001 | Judges a proposed chat action | per chat action | Switch off with row 1 | No: preserve action safety until cutover |
| 3 | B supabase/functions/agent-runner/index.ts:872,895 | <request handler> | Anthropic / claude-sonnet-4-20250514 | Agent turn in edge function; executeConfirmedAction is a separate branch | on request; count not knowable from code | Switch off if no caller remains; else move callers to subscription service chat | No: model turn requires key |
| 4 | B supabase/functions/daily-digest/index.ts:97 | generateNarrative | Anthropic / claude-sonnet-4-20250514 | Daily digest prose paragraph | daily; cron daily-digest at 0 23 * * * | Move to subscription runner | Yes: empty paragraph; digest continues |
| 5 | B supabase/functions/daily-digest/index.ts:322,427 | generateCoachingInsights, generateObservationReport | Anthropic / Sonnet 4; Haiku 4.5 | Coaching and observation paragraphs | weekly code paths; exact count not knowable | Replace with code using computed counts | Yes: coaching null; observation code-built fallback |
| 6 | B supabase/functions/daily-digest/index.ts:898,1088,1235,1395 | generateWeeklyLetter, generateWeeklyPulse, generateFinancialSnapshot, _dailyDigestRequestHandlerForTest | Anthropic / claude-sonnet-4-20250514 | Weekly letter, pulse and financial snapshot prose | weekly code paths; manual requests also exist | Move to subscription runner; money figures only from books lines | Partial: empty letter and computed pulse/snapshot survive; financial brief requires key |
| 7 | B supabase/functions/reporting-api/index.ts:4330 | computeJobIntelligence | Anthropic / claude-haiku-4-5-20251001 | Summary of one job | per request | Replace with code reading job_page_get | Yes: model skipped; deterministic unavailable summary |
| 8 | B supabase/functions/ops-api/index.ts:34903 | _reextractExtractFields | Anthropic / claude-haiku-4-5-20251001 | Re-reads make-safe documents into fields | per re-extract request | Move to worker read-picture document reader | Degraded: deterministic parsing remains; extraction marked degraded |
| 9 | B supabase/functions/ops-api/index.ts:37617 | retiredPaidAiIntakeImplementation | Anthropic / claude-haiku-4-5-20251001 | Retired intake reader | not determined | Switch off: delete only after caller findings resolved | Not a live entry point; preserve manual-test export here |
| 10 | B supabase/functions/ops-api/index.ts:61964 | analyseSupplierQuote | Anthropic / claude-sonnet-4-20250514 | Reads supplier quote documents | per upload | Move to worker document reader | No: extraction needs key |
| 11 | B supabase/functions/ops-api/index.ts:65368 | submitExpense | Anthropic / claude-haiku-4-5-20251001 | Reads receipt photo after receipt saved | per receipt | Move to worker picture reader; save first and fill fields later | Yes: receipt inserted before optional extraction |
| 12 | B supabase/functions/ops-api/index.ts:67880 | _callClaude | Anthropic / caller-selected model | Debt follow-up drafts | per draft request | Move to subscription runner; drafts only, never AI sends | No: helper throws without key |
| 13 | B supabase/functions/transcribe-call/index.ts:24,58; J src/automation/transcribe-worker.ts:161 | <module> | OpenAI / whisper-1 | Call recording transcription | per recorded call | P4-08.8 compares routes for one week; director decides switch off or named exception | No paid transcript; recording capture is separate |
| 14 | J src/utils/embeddings.ts:20 | getClient | OpenAI / text-embedding-3-small | Memory search vectors | per memory write and search | Ends with subscription chat rebuild; outside-chat callers listed below | No: throws; some callers catch and omit vectors |
| 15 | J src/orchestrator/commitment-detector-v2.ts:27 | getAnthropic | Anthropic / claude-haiku-4-5-20251001 | Detects promises in messages | not determined | Switch off: notes reader replaces it; delete if caller search clear | No: client requires key |
| 16 | J src/automation/context-extractor.ts:59; J src/automation/context-fact-extractor.ts:84; J src/automation/context-fact-extractor-v2.ts:285 | anth | Anthropic / claude-haiku-4-5-20251001 | Older fact extractors | not determined | Switch off: retired fact lanes; preserve shared subscription helpers | No for paid classifier; injected subscription classifier is separate |
| 17 | J src/agent.ts:45; J src/channels/email/email-processor.ts:58; J src/workers/memory-consolidation.ts:38 | <module> | Anthropic / per-module chat, triage and consolidation configuration | Chat, email triage and memory consolidation | per chat, email and consolidation run | Moved by P4-08.2, P4-08.3 and P4-08.5; cutover not observed here | No for old engine; use follow-up cutovers |

## Row 3: caller finding

`B supabase/functions/agent-runner/index.ts:827` calls `executeConfirmedAction` from the HTTP handler. Paid calls at 872 and 895 belong to another branch of that handler. No external caller or cron posting to `functions/v1/agent-runner` was found in either repository's tracked code or backend migrations. The handler is itself an exposed request surface: callers outside these repositories are not knowable from this search, so deletion is not yet established as safe.

## Row 9: caller finding

`B supabase/functions/ops-api/index.ts:38915-38916` exports `_retiredPaidAiIntakeImplementationForManualTest`. `makesafe_deterministic_intake_migration_test.ts:178` names the declaration as source proof. No production invocation or cron was found in either repository. No production caller found: safe to delete in a follow-up together with its manual-test export and the proof naming it. Nothing is deleted here.

## Row 14: callers outside chat

Jarvis calls `generateEmbedding` from `src/channels/email/email-processor.ts:94,128`, `src/channels/telegram-group.ts:117,155`, `src/workers/memory-consolidation.ts:107`, `src/tools/memory/store-observation.ts:115` and `src/tools/memory/search-memory.ts:138`. Email, group ingestion and consolidation are outside the chat engine itself; the tools also have their own entry points. No external use of `generateEmbeddings` was found. Chat cutover alone does not prove these calls stopped. Follow-ups must account for these callers before key removal. No backend caller was found.

## Row 15: caller finding

No caller found: safe to delete in the follow-up. The export is `detectCommitments` at `J src/orchestrator/commitment-detector-v2.ts:61`. No import of this module, invocation of this export, or backend cron was found in either repository. Other commitment detectors are separate modules.

## Row 16: caller finding

Do not delete the modules wholesale. `J src/automation/context-extractor.ts:342` calls its own `runContextExtractor`; no external caller of its instruction builder was found. `src/automation/extraction-worker.ts:56-57,318-319` imports and chooses the old extractors; `src/automation/registry.ts:66-77` records the lane as retired. `src/automation/luna-context-extractor.ts:3-4,51` imports helpers and calls `extractV2` with an injected subscription classifier, so that use is not the paid default classifier. `scripts/eval-fact-extractor.ts:34,38,271` also imports old extractors for evaluation. Remove the paid defaults only while preserving the shared helpers and accounting for evaluation callers. No backend production invocation or cron was found.

Search scope: both repositories' tracked code and scripts, function and module names, edge-function URL names, and backend migration crons. No deployed or external caller was observed. No keys or environment files were read.

## Move handoffs

- Row 4 sends digest snapshot and up to five alerts; expects one plain-text morning paragraph, with an empty string as the existing failure result.
- Row 6: letter sends pulse, AI performance, observations, shadow results and optional canary/graduation/learning context and expects prose; pulse and snapshot send computed weekly/financial data and expect narrative text; the handler sends cash states, leaks and benchmarks and expects a structured text brief. Money in follow-up prose must come from books lines.
- Row 8 sends sender/subject/body plus extracted PDF text or PDF document blocks; expects JSON fields, confidence and missing_fields, retaining deterministic parsing when unavailable.
- Row 10 sends quote/email documents and order context; expects JSON classification, delivery/issue details, document fields, totals and line_items with raw and normalised unit fields. Commercial fields retain human review.
- Row 11 sends receipt photo URL after saving the receipt; expects JSON vendor_name, receipt_date, total_amount, gst_amount and line_items containing description, quantity, unit_price and total.
- Row 12 sends caller-selected system instruction and user content with debt context; expects text, often JSON with code fences stripped, for a draft only.
- Row 17 is covered by P4-08.2, P4-08.3 and P4-08.5. This inventory does not claim their cutovers are live.

## Row 13: transcript comparison, P4-08.8

Backend report: `supabase/checks/call_transcript_routes_report.sql`. Director command on an authorised copy: `psql "$COPY_DB_URL" -v ON_ERROR_STOP=1 -f supabase/checks/call_transcript_routes_report.sql`. An authorised live read belongs to the director. The builder ran neither.

Partial: step 2 requires `J scripts/call-transcript-pairs.ts` and its test, in another repository. This backend-only slice cannot complete that step. The pairs script, its tests and Jarvis build remain for a Jarvis slice. No transcript words were read or saved here.

Run date: not run. Window: seven full Perth days. Counts (calls, with_recording, route1_saved, route1_not_returned, route1_failed, route1_pending, route1_not_expected, route2_saved, both, route1_only, route2_only, neither_but_recorded, route1_late_over_2h): not observed. The ticket says nine counts but requests these thirteen measures; retain all of them. Verdict counts (same, route1_better, route2_better_small, route2_better_changes_meaning): not observed. Decision: not made. The director records the date, counts, verdicts, decision and "one week, one run" after running the comparison. No switch change follows from this unrun report.
