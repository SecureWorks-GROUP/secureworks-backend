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
- JWT auth on all trade endpoints (via `authTrade` in ops-api)
- `assertAssigned` check — trades can only access jobs they're assigned to
- Session expiry detection (401/403 → auto sign-out + redirect to login)
- Prices stripped from PO line items (trades see items + quantities, not costs)

## ops-api Trade Endpoints (JWT auth required)
| Action | Method | Purpose |
|--------|--------|---------|
| `my_jobs` | GET | Jobs assigned to authenticated user, grouped by date |
| `trade_job_detail` | GET | Full job view: client, docs, media, notes, POs, crew, work order, report |
| `add_note` | POST | Add note to job timeline (via job_events) |
| `upload_photo` | POST | Upload photo (base64 dataUrl) — supports po_id for receipts |
| `get_upload_url` | POST | Get signed upload URL for direct storage upload |
| `confirm_upload` | POST | Register media record after direct upload — supports po_id |
| `submit_service_report` | POST | Save checklist + notes + signature (draft or submitted) |
| `get_service_report` | GET | Load existing report for a job |
| `update_my_assignment` | POST | Change own assignment status (confirm/in_progress/complete) + GPS |
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
