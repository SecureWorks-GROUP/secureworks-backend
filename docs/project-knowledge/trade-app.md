# Trade Mobile App (trade.html)

## Status: BUILT & DEPLOYED (3 March 2026)
**File**: `dashboard/trade.html` (~3,250 LOC)
**Service Worker**: `dashboard/sw-trade.js` (cache v3)
**Manifest**: `dashboard/manifest.json` (PWA installable)
**User**: Field installers (Henry, Isaac, etc.)
**Auth**: Supabase magic link via cloud.js
**API**: `ops-api` edge function (trade endpoints use JWT auth)

## Bottom Nav (3 tabs)
1. **My Jobs** — assigned jobs grouped: Today / This Week / Upcoming / Recent
2. **Job** (enabled when job selected) — full job detail
3. **Report** (enabled when job selected) — service report with signature

## Features Built

### My Jobs View
- Today's summary card (dark, shows job count + weather)
- Weather widget (Open-Meteo API, Perth -31.95/115.86, 30-min cache)
- Job cards with: client name, suburb, type badge, date, status pill
- Quick action icons on cards: phone (tap-to-call), navigate (Google Maps directions)
- Pull-to-refresh with 2-second throttle
- Empty state with icon

### Job Detail View
- **Client card**: name, phone (tap-to-call), address + Navigate button (Google Maps directions URL: `www.google.com/maps/dir/?api=1&destination=`)
- **Assignment status buttons**: Confirm → On Site → Complete (with GPS check-in + haptic feedback)
- **Live timer**: ticks every 30s when status is in_progress
- **Crew section**: who else is assigned today
- **Work order**: structured scope items + special instructions + PDF link
- **Materials / Purchase Orders**: PO cards with status badges, line items, delivery dates
  - Draft POs show lock icon: "PO not yet approved — do not purchase"
  - Approved POs show "Add Receipt Photo" button
  - Receipt thumbnails grouped per PO
- **Photos**: Before/After comparison grid, scope photos, completion photos
  - Photo grid collapses at 6+ with "Show more" toggle
  - Lightbox with swipe navigation + arrow keys + counter
- **Completion photo upload**: via signed URL (get_upload_url → PUT → confirm_upload)
  - Client-side image compression (max 1600px, 0.7 JPEG quality)
  - Sequential upload for weak signal
  - Progress bar with file counter
- **Notes timeline**: all notes + input with auto-resize textarea
  - Voice-to-text (Web Speech API, en-AU, continuous recognition)
  - Double-tap prevention on Send button
  - Pending offline notes shown with "Pending sync" label

### Service Report View
- Completion checklist (loaded from org_config per job type)
- Completion notes textarea
- Photo upload for completion phase
- **Signature pad**: HTML5 Canvas with touch-action:none
  - Clear button with confirmation dialog
  - Placeholder text "Sign here"
- Homeowner name text input
- Submit button with custom confirmation dialog
- Save Draft (offline-first: localStorage then server sync)
- **Form preservation**: switching between Job/Report tabs preserves in-progress form
- **Unsaved changes warning**: navigating away from dirty report prompts confirmation
- **Shared report link**: generates public URL via share_token for homeowner viewing

### Receipt Capture (PO-linked)
- Receipt photos linked to specific purchase order via `po_id` column on `job_media`
- Phase = 'receipt' distinguishes from scope/completion photos
- Only approved POs (status=authorised/billed) show upload button
- Creates `receipt_added` event in job timeline
- Migration 015 adds: receipt phase to job_media constraint + po_id FK column

### Offline & PWA
- Service worker caches app shell (trade.html, brand.js, cloud.js, supabase CDN)
- Offline indicator bar (red banner)
- Notes saved to localStorage when offline, synced on reconnect
- Draft reports saved to localStorage
- iOS safe areas (notch/Dynamic Island): `env(safe-area-inset-top)` / `env(safe-area-inset-bottom)`
- iOS keyboard handling (hides bottom nav when keyboard is up)
- Android back button support via `history.pushState`

### Auth & Security
- JWT auth on all trade endpoints (via `authTrade` in ops-api). `authTrade` also
  loads the caller's `users` row and returns the server-owned authorization
  context (`orgId`, `role`, `managedVerticals`). Tenant, role, and manager scope
  are never taken from request params. A failed profile lookup is 503 (transient,
  retry); a profile with no `org_id` is 403.
- The board/list reads (`my_jobs` incl. the dispatcher see-all feed and every open
  pool, `trade_calendar`, `my_work_orders`) are filtered to the caller's `org_id`,
  so another tenant's work is never listed. `trade_job_detail` checks the job's `org_id` first and
  refuses a cross-tenant job outright.
- Per-job access is ONE tier decision, `resolveTradeJobAccessTier` (office /
  division manager / allocated trade / the open-MakeSafe field-report exception /
  refused), reached by every per-job door through
  `assertAssignedOrMakesafeAccess`. Only office and a manager of the job's
  vertical see the quote. Contract and the full per-surface gap table:
  `docs/evidence/trade-access-model-2026-08-17.md`.
- Session expiry detection: any 401 → auto sign-out + redirect to login. That is
  why ops-api reserves 401 for `user_jwt_required` (no/invalid session); a
  staff-role refusal is `403 operator_access_required` — a polite refusal, never
  a logout (see the "ops-api Role Gates" entry in AGENTS.md)
- Prices stripped from PO line items (trades see items + quantities, not costs)

## ops-api Trade Endpoints (JWT auth required)
| Action | Method | Purpose |
|--------|--------|---------|
| `my_jobs` | GET | Jobs assigned to authenticated user, grouped by date. `mode=all` is the managed Board list: a dispatcher sees every crew's tenant-scoped assignment across the full range, a fencing manager sees the complete historical/future/unscheduled fencing range, and other vertical managers retain their existing rolling/backstop range. Ordinary installers stay own-only whatever `mode` says. Null-dated allocations reach the `unscheduled` group through the full-range dispatcher/fencing-manager reads. Open-pool cards are de-duplicated against assignments that still hold the job at any date, so allocated work is never offered as available. Every `job_assignments` read in the feed (occupancy probe included) carries `.eq('is_ghost', false)` — the `calendar_events` view's own predicate — so stale-dated ghost `role:'observer'` rows never reach a card (`docs/evidence/trade-feed-ghost-row-source-exclusion-2026-08-06.md`). See `docs/trade-all-means-all-v1.md` for the complete visibility contract. |
| `search_all_jobs` | GET | Jobs list/search feed. Everyone-lens users get the full tenant and history on an empty query, including never-assigned jobs; ordinary crew keep the active assigned browse. Results are tenant-scoped, paged, and return an honest `total`; the detailed response and client follow-up are owned by `docs/trade-all-means-all-v1.md`. |
| `trade_calendar` | GET | Tenant-scoped calendar assignments for the Trade Schedule view. Params: `from`/`to` (`YYYY-MM-DD`, default today → +14 days), `mode=mine` (default) or `all`, optional `type`, `page_size` (max 500) and `offset`. `all` is honoured for a dispatcher or bounded to a manager's `managed_verticals` (asking for an unmanaged `type` there is 403); ordinary installers are downgraded to `mine`. Multi-day overlap and null `scheduled_end` semantics are preserved. Returns `trade-calendar.v1` with `org_id` stripped plus deterministic `truncated`/`next_offset` paging |
| `my_work_orders` | GET | Manual work-order selector. Default/mine remains own-only; `mode=all` widens only for dispatchers or vertical managers and stays tenant/vertical scoped. It is intentionally independent of the selected invoice week, supports search (`q`) and deterministic offset paging, and reports any live same-tenant invoice plus server-derived acknowledged negative-charge candidates. Returns `trade-work-orders.v1` with `total`, `offset`, `page_size` (default 30, max 500) and `truncated`/`next_offset` |
| `submit_work_order_invoice` | POST | Existing Xero draft work-order invoice path. Authorises own work, dispatchers, or same-tenant managed-vertical work; 409s on a second live invoice for the work order across all trades and on another trade's unfinished draft (only the office can clear that one); the caller's own stale draft is still deleted and retried. Optional `negative_charge_line_ids` are revalidated against acknowledged same-job/same-tenant live invoice lines and deducted before GST, but can never pull the invoice to zero or below; arbitrary client amounts are never accepted |
| `generate_trade_invoice` | POST | Generates the holder's invoice from weekly hours and structured extras. Work-order extras persist `wo_allocated`, `wo_labour_deduction`, and cleaned `wo_labour_lines`; the server rejects a claimed WO net that does not equal allocation minus declared labour. The holder line description is server-owned and states the WO total, each named labourer with hours/rate/amount, total deduction, net payable, and that named crew bill SecureWorks Group directly. No payout invoice is auto-created; unroutable lines remain in `wo_labour_unresolved` and the `trade.wo_labour_unresolved` event for office reconciliation. The legacy clocked lane auto-fills, so it applies the same eligibility filter as the `my_hours` read and the manual lane: job cards held by a LIVE invoice and never-clocked `status='complete'` cards (no hours) are silently skipped, never re-billed or consumed by a $0 line. The Layer B assignment lock decides claimability BEFORE stamping `invoiced_in` (shared predicates in `supabase/functions/ops-api/trade_invoice_assignment_lock.ts`); a refusal names the blocking job cards, rolls back only the rows this request stamped, and releases the invoice to `'draft'` (never the CHECK-illegal `'failed'`) so the week can retry. The shared weekly draft is promoted compare-and-swap from `'draft'`, so a concurrent double-tap 409s instead of corrupting the winner. Root cause: `docs/trade-invoice-assignment-lock-root-cause-2026-08-06.md` |
| `trade_job_detail` | GET | Full job view: client, docs, media, notes, POs, crew, work order, and the current-cycle report. `documents` is tier-dependent: office and a manager of the job's vertical get the full document set, an allocated trade (and the open-MakeSafe tier) get `visible_to_trades = true` rows minus every `quote`/`invoice` type whatever the flag says, and `job.scope_json` is quote-redacted server-side for those tiers (`redactTradeScopeQuote`). The response carries the resolved `access_tier` and `quote_visible`, so the client never re-derives authority. Tier contract: `docs/evidence/trade-access-model-2026-08-17.md`. Additive keys: `scopeSummary` (derived from `scope_json` by the same `buildScopeSummaryLine` ops uses for invoice descriptions), `workOrders` (every live work order — `workOrder` remains the newest one), `workOrderDocuments`, `crew[].is_lead`/`crew[].name`, `leadInstaller` (null when nobody is designated), and `job_identity` (typed WO group, typed PO job grain, and canonical key; no metadata or render-time filename parsing). MakeSafe detail also carries the server-owned completion handoff (`physical`, `own_template`, `builder_portal`, or `unknown`) and a flag-only billing-review warning; it never carries invoice identifiers, amounts, or disposition options. Contract: `docs/evidence/trade-crew-visibility-lead-2026-08-03.md` |
| `set_job_lead` | POST | Name (or clear, with `clear:true`) the lead installer on a job's crew, by `assignmentId` or `userId`. Gated by the SAME `assertAssignmentMutationAuthz` that gates `create_assignment`: dashboard/service key, dispatcher, or a manager of that job's vertical. An ordinary assigned installer is refused, including on their own row. Like `allocate_job` it is on the front door's profile-scoped JWT allow-list (`OPS_API_PROFILE_SCOPED_JWT_ACTIONS` in `ops-api/index.ts`), so a signed-in non-staff caller reaches that route gate instead of the staff-role 403; dropping it from that list silently refuses every vertical manager before the gate runs. At most one lead per job is enforced by `uq_job_assignments_one_lead`, not by application code |
| `add_note` | POST | Add note to job timeline (via job_events). Non-operators are held to `assertAssignedOrMakesafeAccess` per-user with the same tenant + managed-vertical access context `trade_job_detail` honours (so a manager of the job's vertical may note it; see AGENTS.md "Trade App Visibility Contract"); staff operators (admin/owner/ops_manager, the one front-door predicate) may note any job |
| `get_crew_availability` | GET | Crew availability for a date range — trade.html calls it on sign-in (login path). NOTE: the handler does no per-user scoping and returns all crew rows incl. name/email/phone, matching pre-#667 shared-key behaviour; tightening it is a flagged follow-up |
| `upload_photo` | POST | Upload photo (base64 dataUrl) — supports po_id for receipts |
| `get_upload_url` | POST | Get signed upload URL for direct storage upload |
| `confirm_upload` | POST | Register media record after direct upload — supports po_id; MakeSafe media is bound server-side to the current attendance cycle |
| `submit_service_report` | POST | Save checklist + notes + signature (draft or submitted) |
| `submit_makesafe_report` | POST | Submit the make-safe field report against the authoritative current attendance cycle; final submissions require immutable authenticated submitter attribution and a genuine non-lead trade assignment bound to that cycle, while drafts and unassigned intake remain supported. Reattendance requires current-cycle evidence, including at least five photos. A browser request carrying both the dashboard `x-api-key` and the trade JWT uses the verified JWT user as the server-owned report/event attribution; a body-supplied user ID cannot override it |
| `reattend_makesafe` | POST | Start the next required-reason MakeSafe attendance cycle. Allowed for dispatchers, managers of the job's vertical, or a trade with a non-cancelled assignment on that job; unrelated and cancelled-assignment users are refused. The action is additive, keeps one board card, and does not create an assignment or send an SMS |
| `get_service_report` | GET | Load existing report for a job |
| `update_my_assignment` | POST | Change own assignment status (confirm/in_progress/complete) + GPS |
| `clock_event` | POST | Timer/stage events on the caller's OWN assignment (`clock_on`, `clock_off`, `start_travel`, `arrived`, `pause`, `resume`, `materials_check`, `manual_override`). Ownership is asserted before any idempotency lookup or return, assignment mutation or event write, so a foreign caller gets `Not your assignment` and cannot even learn another crew's replay state from an `idempotency_key`. There is deliberately no manager/dispatcher override: cross-crew stage authority would need its own reviewed action and audit contract |
| `view_shared_report` | GET | **Public (no auth)** — rendered HTML page for homeowner via share_token |

## Database (Migrations 011, 013, 014, 015)
- **011**: `job_service_reports` table (checklist_json, signature_data, signature_name, status)
- **013**: Time tracking on `job_assignments` (started_at, completed_at)
- **014**: `share_token` on `job_service_reports` (for public report link)
- **015**: `receipt` added to `job_media.phase` constraint + `po_id` FK to purchase_orders

## GPS Check-in
- `navigator.geolocation.getCurrentPosition()` on status changes (in_progress, complete)
- 5-second timeout, graceful fallback if denied
- Stored in `job_events.detail_json.location` (lat, lng, accuracy)

## Known Issues / TODO

### BLOCKING — Login not loading jobs
After login, the My Jobs view shows spinner but jobs don't load. Root cause is likely the `INITIAL_SESSION` bug in cloud.js (see gotchas.md). The `onAuthStateChange` handler only catches `SIGNED_IN`, not `INITIAL_SESSION` which Supabase v2 fires for existing sessions. **Fix needed in `tools/shared/cloud.js` line ~201** — add `|| event === 'INITIAL_SESSION'` to the condition. This affects ALL dashboards, not just Trade.

There are also debug `console.log` statements in trade.html that should be removed once the login issue is resolved:
- Line ~1355: `console.log('[trade] onLogin called...')`
- Line ~1490: `console.log('[trade] loadMyJobs...')`
- Line ~1493: `console.log('[trade] my_jobs response...')`

### Test data in production
3 test assignments were created for Marnin (user ID `706c5258-70dd-483a-b36c-af6864b24498`):
- 2026-03-03: job `b80f0cd4-8d94-4cf2-91f0-22decb614f6c` (Jody Saxon, patio)
- 2026-03-04: job `dcfebb71-2277-4328-bfe8-279715390eea` (Christine Emerson, patio)
- 2026-03-05: job `a03be576-f737-4e0f-8104-90d9729435f5` (Mikaela Cross, patio)
These can be deleted after testing.

### Other TODO
- Magic link redirect: cloud.js `sendMagicLink` redirect URL for `file:` protocol points to `index.html` not `trade.html` — only affects local `file://` testing, works fine on localhost/production
- No push notifications yet (would need Firebase or similar)
- No offline job cache (only notes and drafts cache offline, job list requires network)
- EzyBills integration researched but deferred — simple in-app receipt capture built instead. EzyBills (AU$25/mo) has REST API for OCR + Xero PO matching if needed later
- `site_address` and `site_suburb` are NULL on most jobs (GHL sync doesn't pull address). Navigate buttons and suburb labels will be empty until address data is backfilled
- Service worker cache is at v3 — bump on every trade.html change

## Business Process: PO → Receipt Flow
The user (Marnin) wants this enforced: **no approved PO = no purchase allowed**.
1. Ops creates PO in ops dashboard (or synced from Xero)
2. PO gets approved (via Xero workflow → status becomes `authorised`)
3. Trade sees approved POs on their job in the app
4. Draft POs show lock icon: "PO not yet approved — do not purchase"
5. Approved POs show "Add Receipt Photo" button
6. Trade buys materials per PO, photographs receipt → linked to PO
7. Ops can verify receipt matches PO in job detail
8. Bookkeeper enters into Xero with proper job/project coding
