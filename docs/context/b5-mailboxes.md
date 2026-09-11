# Mailbox capture (B5)

B5 replaces monitor-inbox's unread-only, 15-minute, 20-message poll with a durable capture reader. It retains an inbound inbox_events projection for the operations inbox. Classification-gated evidence writes, heuristic job assignment and public supplier-attachment copies are removed from capture. The separate postcapture compatibility consumer below preserves the predecessor business inbox classifier within its original paid eligibility boundary. B2 owns job attribution. The separate monitor-ses-makesafes operational intake and receive-po-email Resend webhook are unchanged.

## Coverage and boundaries

| Source | Capture route | Boundary |
| --- | --- | --- |
| marnin, jan, shaun, admin, nithin | User Inbox and Sent Items, one durable delta per folder | Requires existing app Mail.Read permission and actual mailbox access |
| khairo | Two registered but disabled streams | Explicit mailbox_not_provisioned; never reported as zero mail or complete |
| patios, fencing, ses | Group threads/posts traversal | No invented user mailbox or folder-delta route |
| orders | Explicit Inbox/Sent Items attempts | Its M365 provisioning is unverified. Existing PO mail uses a Resend sender and tagged secureworksgroup.app reply webhook, which is not proof of a Graph mailbox. 403/404 remains a coverage error |

Every response reports every stream as complete, continuing, deferred, unavailable, busy/paused or error. `success` is true only when every stream completed. An unavailable Khairo stream therefore keeps overall coverage incomplete until provisioned. Cursor and provider failure details are stored; access tokens and delta URLs are not returned. The oldest-started streams are attempted first so a 90-second bounded tick does not starve later mailboxes.

User folders follow exact nextLink URLs and save deltaLink only after every message, private body, attachment, evidence row, source observation and inbound-inbox projection in the page is durable. Failed pages replay idempotently. A 410 resets to the original capture boundary. Initial/reset rounds scan all folder metadata without a date filter: Microsoft documents a 5,000-message limit for filtered delta. Only messages on/after the migration's capture_from boundary are hydrated and captured; this is no historical evidence/model backfill. Initial metadata catch-up may span ticks.

Groups have no equivalent delta feed. A durable queue follows thread and post pages with a completed-scan high-water and a 24-hour thread overlap. Every thread-list page is read; old unchanged threads skip post hydration. A partially completed traversal never advances high-water. Group 410 restarts the prior scan; capture IDs dedupe the overlap.

User messages dedupe globally by internetMessageId. Group posts do not expose that standard property: they use a group/mailbox-scoped Graph post ID. Group-to-user transport twins therefore remain a known dedupe limitation; no content-hash guess suppresses a real repeated message. A source-observation row preserves each mailbox/folder origin even when the event dedupes. Missing user internetMessageId also uses an explicit graph_item_fallback identity recorded on the event.

## Private evidence and operational behavior

A new private context-mail-evidence bucket stores the complete body bytes and attachment bytes by SHA-256; immutable existing hashes are reused. Preview text strips quoted trails and signatures and is capped at 4,096 UTF-8 bytes. The evidence row stores preview, private pointer and hash, source date, direction, sender/recipient and attachment pointers. Attachments are retained even for unmatched messages. Automated rules recognize auto-submitted/list headers, bulk/list precedence, no-reply senders and automatic-reply subjects; no model is called.

Cloud/reference attachments are stored as their complete provider reference envelope, not asserted to be downloaded external document contents. Embedded item attachments retain the expanded item JSON. Unsupported/missing attachment content is a coverage failure and prevents page checkpointing.

Group attachment listing has no documented app-only permission. The reader uses the existing SES pattern, GET post with expand=attachments; if the tenant does not return attachments, it stops that page and reports group_attachments_unavailable. Actual tenant acceptance is still required.

Sent Items and own-domain group posts are stored as outbound; they do not create an inbound operations inbox row. B2 extraction selection supplies incoming context and excludes sent-only jobs. Canonical capture never marks mail read, sends mail, calls a paid model, changes a job or alters existing bucket visibility. Inbox projection now labels automated mail newsletter/low and other incoming mail client_reply/normal; it does not invent a recommended action. Postcapture compatibility restores attributed supplier-document filing using private canonical pointers. SES's separate document intake continues.

## Database interfaces

- context_mail_streams: one cursor/lease/status row per mailbox and folder or group.
- claim_context_mail_stream(p_stream_key text): fail-closed capture switch; exclusive 10-minute renewable lease; returns outcome and stream snapshot.
- checkpoint_context_mail_stream(p_stream_key text,p_lease_token uuid,p_state jsonb,p_complete boolean,p_error text,p_release boolean): fenced cursor update; completion timestamp only on a fully persisted round; errors preserve the last durable continuation.
- context_mail_observations: event UUID, stream key, provider item ID and direction; immutable source origin.

Rollback disables streams and removes the callable worker functions while preserving cursors, source observations and private stored evidence. Restore the prior endpoint separately only if deliberately accepting its prior behavior. No cron, credentials or existing public bucket changes are included.

## Verification

19 offline Deno behavior tests cover delta pagination/termination, persistence failure replay, bounded resume, 410 recovery, malicious continuation refusal, deleted provider items, group continuation/high-water, preview byte limits, automated rules, cross-mailbox identity, private storage, attachment pagination, duplicate source observations, outbound behavior, aggregate mailbox failures and initial metadata filtering. Endpoint typecheck and targeted lint pass. Registered SQL contracts cover the stream roster, private bucket, lease exclusion/fencing, failed-page resume, completion and capture switch; rollback keeps custody. These contracts passed on disposable PostgreSQL 17 in cio_codex_b5_20260911, including the deliberate Khairo false-provisioning failure and rollback. The combined historical migration registry remains a parent integration check.

No live mailbox, group permissions, provider receipts, current production schema or deployment was verified. The parent production read returned HTTP401. Khairo provisioning and orders provider topology remain operator checks, not inferred successes.

## Official API references checked

- [Message delta](https://learn.microsoft.com/en-us/graph/api/message-delta?view=graph-rest-1.0): folder-scoped nextLink/deltaLink.
- [Delta message tracking](https://learn.microsoft.com/en-us/graph/delta-query-messages): filtered delta is limited to 5,000 messages.
- [List group threads](https://learn.microsoft.com/en-us/graph/api/group-list-threads?view=graph-rest-1.0) and [list thread posts](https://learn.microsoft.com/en-us/graph/api/conversationthread-list-posts?view=graph-rest-1.0): distinct group APIs.
- [Post resource](https://learn.microsoft.com/en-us/graph/api/resources/post?view=graph-rest-1.0): no standard internetMessageId; attachment relationship.
- [Post attachments](https://learn.microsoft.com/en-us/graph/api/post-list-attachments?view=graph-rest-1.0): attachment listing application permission unsupported; post expansion example.

## Business inbox compatibility repair

The postcapture `mail_compatibility.ts` consumer restores the predecessor's inbox classification, priority and recommended-action fields separately from the context pipeline. The unchanged Haiku classifier (same SDK, model, prompt, 200-token output and failure fallback) is retained only for the predecessor seven-mailbox roster, user Inbox messages explicitly unread and received within 15 minutes when captured. It uses the provider's original 500-character body preview. Read/older messages, Sent Items, group posts (no user isRead property), orders and ses never enter this paid path. Context captures them anyway. This is existing business-inbox model spend, not new Luna context spend. No historical classification replay is authorized.

The consumer takes up to ten inbox rows after Graph capture. A compare-and-swap timestamp and ten-minute claim fence concurrent ticks; classification is cached in inbox metadata before file writes. Existing predecessor graph-message rows supply their already-paid classification during overlap rather than triggering another call. Oldest-attempted rows rotate, including rows awaiting later attribution. Partial PDF/image filing retries converge on deterministic primary keys derived from canonical event ID, content hash and filename. Classification failures retain the predecessor `other/normal/no action` fallback. A crash after a provider response but before its cache commit can repeat that call; this does not claim exactly-once external model billing.

Canonical business_events rows are never reclassified, duplicated or edited by compatibility. Actual persisted B2 job_id, match_status=matched and attribution_status in direct/thread/single_open/single_line/luna are the filing authority. Classifier references and contact heuristics never bind a job. Unresolved evidence stays in the admin bucket and is reconsidered automatically; there is no human attribution queue. Current supplier.email_in readers in reporting-api, invoice_context and ops-api also accept client.email_in, so the canonical capture event remains visible to those consumers.

PDFs retain supplier_quote/supplier_work_order/supplier_invoice semantics and invoice trade hiding. Images retain receipt/photo semantics. Files point at the original private SHA-256 object: no public copies, new buckets, persisted signed URLs, or changes to existing bucket visibility. Schema/type errors stay retryable rather than silently filing an invoice as a quote. Item/reference JSON envelopes are not filed as downloaded PDFs. The ops job detail and authorized trade job detail readers now sign those private pointers for 300 seconds, after their existing visibility filters; existing public links pass through. Sign failure yields null URLs and an explicit file_unavailable flag. Scope mismatch or malformed canonical keys refuse signing.

The read projection only covers these existing job detail surfaces. Other raw document/export APIs still return storage pointers and require their own authorized projection before offering a download. This change neither signs arbitrary caller URLs nor broadens caller access.

Offline repair proof: 20 capture tests plus seven compatibility tests exercise partial-file failure/retry, cached classification, concurrent claiming, delayed B2 attribution, switch refusal, paid eligibility gating, PDF type/visibility, stable IDs and private signing/scope/failure handling. No live provider, paid call, database reset, deployment or browser file download was performed. Initial provider coverage caveats above remain open.

Repair validation also checked both monitor-inbox and ops-api endpoints successfully with cached dependencies. Existing trade access suites ran with --no-check: 124 passed, one add_note cross-tenant control failed; the identical failure was reproduced against the untouched B5 HEAD source. Their ordinary test typecheck reports 14 completion_evidence nullable errors in existing assertions. Those failures are outside this change; the focused 27-test repair suite typechecks and passes.
