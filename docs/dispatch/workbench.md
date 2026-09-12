# Dispatch review workbench

Shaun can retain accepted jobs with no order/date/deposit, organise stable requirements into arbitrary groups, review the complete set, capture notes, allocate ordered supply, count physical stock, receive/transfer material, prepare a real unsent PO draft and edit exact email drafts. This is a review workflow. No action invokes purchase authorisation, supplier/customer sends or crew rescheduling.

## HTTP contract

The existing authenticated `ops-api` accepts only office operators (admin/owner/ops_manager JWT or privileged server credentials). JWT organisation and actor come from authentication; request-supplied tenant/actor are ignored. All `dispatch_*` actions have the same office gate. Routine/read-agent credentials remain denied by their existing exhaustive allowlists.

GET actions:
- `dispatch_list?cursor=<uuid>&limit=50`: accepted/unresolved eligible jobs, `next_cursor`, explicit coverage. The SQL view includes accepted quotes independent of job stage and retains post-acceptance-stage jobs with unresolved evidence. Archived/cancelled/deleted jobs are excluded explicitly.
- `dispatch_job?job_id=<uuid>`: `{job,version,source_version,groups,requirements,notes,drafts,movements,allocations,receipts,order_drafts,purchase_orders,documents,communications,media,context_facts,supply_lots,assessment,coverage,live_actions_enabled:false}`.
- `dispatch_supply?kind=po|stock&cursor=...`: existing ordered PO lines across the organisation or audited physical stock counts. Capacity is checked again atomically during allocation.
- `dispatch_communications?scope=job|all&job_id=...&search=...&cursor=...`: captured PO communication records with original job/message/thread provenance. Captured mail is not complete Outlook history.
- `dispatch_outlook_search?mailbox=...&search=...&cursor=...`: actual Microsoft Graph read adapter, using incumbent token/request utility. `DISPATCH_READ_MAILBOXES_BY_ORG` maps tenant UUIDs to an explicit array of readable mailboxes. No configuration means unavailable; it does not default to somebody's mailbox. Exact continuation URL is constrained to the selected mailbox/query, never an arbitrary token-bearing URL. Search is provider-bounded (1000); records remain unlinked until an explicit attribution action. Group conversations require their own source adapter.
- `dispatch_calendar?from=YYYY-MM-DD&to=YYYY-MM-DD`: shared assignment/PO source identities and proposed Dispatch movements, with dated and undated arrays. Staff uses incumbent overlap and cancellation semantics. Per-source bounded coverage is explicit.

POST `dispatch_command` envelope: `{job_id,expected_version,source_version,request_id:<uuid>,command,payload}`. Returns the refreshed complete aggregate. Reuse the same request ID and exact envelope on uncertain retry; conflicting reuse is rejected. Version/source conflicts return HTTP409.

Commands:
- `group_upsert {id,name,position}`, `group_delete {id}` (unassigns, never deletes requirements).
- `requirement_upsert {id,group_id,description,quantity,unit,specification,source_ref,phase,destination,needed_by,owner}`, `requirement_move {id,group_id}`, `requirement_review {id}`, `set_review {}`. A supplied requirement must reconcile allocations before editing quantities/specs. Scope refresh never overwrites manual rows; source revision changes invalidate review.
- `note_upsert {id,text}`, `note_promote {id,requirement}` (deliberate, single promotion).
- `stock_record {id,description,quantity,unit,location,evidence}` is a recorded physical count, not an inferred inventory row.
- `allocation_upsert {id,requirement_id,supply_id,quantity}`, `allocation_delete {id}`. Stable supply IDs are `po:<id>:<line-index>` or `stock:<id>`. PO line revision/reordering with outstanding reservations refuses until reconciled; it cannot create a second independent capacity pool. Units must match. Damaged quantities allow replacement allocations without counting unusable goods twice.
- `receipt_upsert {id,allocation_id,usable_quantity,damaged_quantity,location,evidence}`, `receipt_transfer {id,location,evidence}`. Move the same counted receipt from yard to destination; never create a duplicate receipt for the same goods.
- `order_prepare {id,supplier_name,xero_contact_id,delivery_date,delivery_address,requirement_ids,unit_prices,notes,existing_supply_reviewed:true}`. Current reviewed requirements become lines in an incumbent `purchase_orders` draft within the same transaction. Only the identical Dispatch-owned unsent draft can be edited. Null prices/financial totals remain unknown, never fabricated zero costs. No Xero/provider action occurs.
- `draft_upsert {id,sender,to,cc,subject,body,attachments:[{id,name,source_ref,revision}],po_id,thread_id,proposed_delivery_at}`, `draft_review {id}`. Review binds exact content hash/source. Editing strips prior review. PO association must belong to job. Review confers no live execution authority.
- `movement_upsert {id,title,from_location,to_location,date,time,requirement_ids}` saves a proposal only.
- `communication_link {id,communication_id,source_job_id,reason}` verifies original captured-mail job/tenant. Native Graph results retain mailbox custody; a provider-message attribution adapter is a remaining integration item.

POST `dispatch_assess` uses the same optimistic envelope. POST `dispatch_trigger {job_ids:[up to25]}` creates deduplicated source+plan-version tasks. POST `dispatch_run {}` leases up to10, persists outcomes, and retries failures with bounded attempts. Lease tokens fence stale workers. Cloud scheduling/activation is deliberately not installed by this change. Current job-context source is read through `current_job_context_facts` plus incumbent visibility rules, never re-ingested. Company-context contract remains CIO-owned and not yet release-proven.

## Persistence and release

Migration: `20260912150402_dispatch_workbench.sql`. New tables are private to service_role, RLS enabled, no browser policies. Existing jobs/POs/documents/communications/media/assignments/context sources feed database-owned revision guards. Aggregate CAS, idempotency, reservation and PO preparation are one transaction. Parent org locking serializes cross-job capacity. No production migration applied.

Local evidence: Deno reducer/provider adapter tests plus isolated native PostgreSQL17 fixture (`tests/dispatch/fixture.sql`, `persistence.sql`, `workflow.sql`, `concurrency.py`). The SQL fixture is intentionally minimal; this proves actual PostgreSQL semantics, not production schema or deployment. Cross-job concurrent final-unit allocation permits one claimant and rejects the other. No real provider credentials or sends in tests.

Release limitations to resolve in review: actual environment schema/API integration, live mailbox read permissions/configuration, complete company context, operational scheduling activation, accepted production case and frontend integration. Source scope/BOM remains evidence; there is no automatic fabricated kit. Runtime/test fixtures must never be product fallback data.

## Review amendments and held execution

PO supply lifecycle follows incumbent ordered states: submitted/authorised/sent/confirmed/delivered/billed; quote_requested/draft/approved do not prove an order. Missing physical units refuse allocation (a quantity-one lump-sum fence PO is not one physical fence kit). PO-wide line snapshot fencing prevents a line reorder from creating duplicate capacity at a new array index.

Order preparation accepts `quantities:{[requirementId]:number}` and defaults to the uncovered amount after allocation and other prepared drafts, supporting partial orders and multiple suppliers. `requirement_reconcile {...fields,reason}` retains custody through explicit scope changes and exposes excess/unit mismatch. Metadata changes stay editable after receipt. `context_review {}` acknowledges the exact source/fact revision. `receipt_transfer` supports an optional `quantity` and `new_id` for a conserved partial split.

Execution is now implemented as a separate held action lifecycle, not an unsupported command. Configured Captain user IDs may POST `dispatch_draft_approve` (normal optimistic envelope, payload `{id,approval_id,content_hash,communications_approved:true,purchase_approved:true}` for supplier commitment). Review and approval remain separate. Exact approval survives only matching content/source. POST `dispatch_execute {job_id,draft_id,approval_id}` claims one durable identity, prepares a provider draft, persists provider identity before sending, records accepted-not-delivered or outcome-unknown, and never automatically resends. POST `dispatch_execution_readback {approval_id}` performs read-only provider reconciliation. GET `dispatch_execution?job_id` supplies actions, coverage and capabilities.

Both environment `DISPATCH_SEND_RELEASED=true` and tenant `dispatch_release_controls.communications_enabled=true` are required; defaults remain held. `DISPATCH_APPROVER_USER_IDS` has no default approver. Tests inject a fake provider; no actual send is made. Native Outlook new-mail adapter reuses existing Graph token/request, mailbox verification, SES delivery guard and attachment download restrictions, hashes actual attachment bytes against reviewed revisions, and retains immutable provider draft IDs. Provider acceptance never establishes delivery. Captured Resend thread IDs cannot be used as native Outlook message IDs; native/captured reply execution remains a stated integration gap, not a fake reply.

Joint browser fixture: `tests/dispatch/local_server.ts` runs the actual production handler/reducer/SQL with a narrow local PostgreSQL query transport. `browser_fixture.sql` seeds unmistakable synthetic records. It omits real JWT verification, provider calls and PostgREST projection fidelity. It is bound to loopback ports55581/55582 and the fixed `dispatch_ui` database. Browser writes and reloads preserve actual persisted state; never deploy this fixture.
