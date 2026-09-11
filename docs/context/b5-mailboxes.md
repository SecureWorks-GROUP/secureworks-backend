# Mailbox capture (B5)

B5 replaces monitor-inbox's unread-only, 15-minute, 20-message poll with a durable capture reader. It retains an inbound inbox_events projection for the operations inbox. The paid Haiku classifier, classification-gated evidence writes, heuristic job assignment and public supplier-attachment copies are removed from this reader. B2 owns job attribution. The separate monitor-ses-makesafes operational intake and receive-po-email Resend webhook are unchanged.

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

Sent Items and own-domain group posts are stored as outbound; they do not create an inbound operations inbox row. B2 extraction selection supplies incoming context and excludes sent-only jobs. The reader never marks mail read, sends mail, calls a paid model, changes a job or alters existing bucket visibility. Inbox projection now labels automated mail newsletter/low and other incoming mail client_reply/normal; it does not invent a recommended action. Old supplier-document auto-filing from this reader no longer occurs; evidence attachments remain privately inspectable. SES's separate document intake continues.

## Database interfaces

- context_mail_streams: one cursor/lease/status row per mailbox and folder or group.
- claim_context_mail_stream(p_stream_key text): fail-closed capture switch; exclusive 10-minute renewable lease; returns outcome and stream snapshot.
- checkpoint_context_mail_stream(p_stream_key text,p_lease_token uuid,p_state jsonb,p_complete boolean,p_error text,p_release boolean): fenced cursor update; completion timestamp only on a fully persisted round; errors preserve the last durable continuation.
- context_mail_observations: event UUID, stream key, provider item ID and direction; immutable source origin.

Rollback disables streams and removes the callable worker functions while preserving cursors, source observations and private stored evidence. Restore the prior endpoint separately only if deliberately accepting its prior behavior. No cron, credentials or existing public bucket changes are included.

## Verification

19 offline Deno behavior tests cover delta pagination/termination, persistence failure replay, bounded resume, 410 recovery, malicious continuation refusal, deleted provider items, group continuation/high-water, preview byte limits, automated rules, cross-mailbox identity, private storage, attachment pagination, duplicate source observations, outbound behavior, aggregate mailbox failures and initial metadata filtering. Endpoint typecheck and targeted lint pass. Registered SQL contracts cover the stream roster, private bucket, lease exclusion/fencing, failed-page resume, completion and capture switch; rollback keeps custody. SQL execution status is reported in the packet handoff.

No live mailbox, group permissions, provider receipts, current production schema or deployment was verified. The parent production read returned HTTP401. Khairo provisioning and orders provider topology remain operator checks, not inferred successes.

## Official API references checked

- [Message delta](https://learn.microsoft.com/en-us/graph/api/message-delta?view=graph-rest-1.0): folder-scoped nextLink/deltaLink.
- [Delta message tracking](https://learn.microsoft.com/en-us/graph/delta-query-messages): filtered delta is limited to 5,000 messages.
- [List group threads](https://learn.microsoft.com/en-us/graph/api/group-list-threads?view=graph-rest-1.0) and [list thread posts](https://learn.microsoft.com/en-us/graph/api/conversationthread-list-posts?view=graph-rest-1.0): distinct group APIs.
- [Post resource](https://learn.microsoft.com/en-us/graph/api/resources/post?view=graph-rest-1.0): no standard internetMessageId; attachment relationship.
- [Post attachments](https://learn.microsoft.com/en-us/graph/api/post-list-attachments?view=graph-rest-1.0): attachment listing application permission unsupported; post expansion example.
