# SECUREWORKS — SCOPING TOOLS & JOB MANAGEMENT STRATEGY

> **⚠️ HISTORICAL DOCUMENT — Superseded by `SYSTEM-UPGRADE-PLAN.md` (9 March 2026)**
> This file covers the original scoping tools persistence strategy (local → cloud → job lifecycle).
> For the active dashboard/ops system upgrade plan, see `SYSTEM-UPGRADE-PLAN.md` at project root.

## For context handoff to other Claude instances

---

## 1. WHAT EXISTS TODAY

### Scoping Tools (Built, Working)

Two standalone single-HTML-file scoping tools, each ~6500 lines:

**Fencing Scoping Tool** (`reference/fencing-scoping-tool/fence-designer-main/index.html`)
- Visual fence run designer — define runs with length, height, retaining steps, gates, patio tubes
- Per-panel retaining height calculator (steps terrain automatically)
- Full pricing engine with material costs, labour rates, margin calculation
- 3D Three.js visualisation of the designed fence (PBR materials, corrugated panels, realistic lighting)
- Photo/video capture system (camera + library upload, labels, compression)
- PDF generation (jsPDF): Quote, Material Order, Work Order — all branded
- HTML tabbed output viewer (same 3 documents in browser)
- AI prompt generator for Gemini (screenshots 3D view + generates descriptive prompt)
- Colorbond colour palette with stock/non-stock indicators
- Supplier profiles (RNR, Metroll, Lysaght, Stratco) with panel widths + profiles
- All state in memory — no persistence beyond the browser session

**Patio Scoping Tool** (`reference/patio-scoping-tool/patio-main/index.html`)
- More mature than fencing — has been through more iterations
- SolarSpan insulated panel calculator
- Roof style selection (flat, gable, hip, flyover, freestanding)
- Colour selector with visual swatches
- Beam/post engineering lookup tables
- 3D visualisation with PMREMGenerator environment mapping
- Custom flashing profile editor (draw cross-sections, dimensions, colour side indicator)
- Photo/video capture + annotation
- PDF generation suite (Quote, Material Order, Work Order, Sheets Order)
- Gemini AI integration for realistic render previews
- Same architecture: single HTML, all in-memory

### Shared Patterns Across Both Tools
- Brand constants: `SW_ORANGE` (#F15A29), `SW_DARK` (#293C46), `SW_MID` (#4C6A7C)
- SVG logo embedded as constant (`SW_LOGO_WHITE`), rendered to PNG via canvas for PDF
- Same PDF structure: orange accent bar → dark blue header band → logo → content
- Same `_header()`, `_footer()`, `_sectionHeader()`, `_label()`, `_value()` PDF helpers
- Same photo/video capture approach (`scopeMedia` object)
- `_collectOutputData()` gathers all state into a flat data object for output generation
- T&Cs stored as JS arrays of `{ title, items[] }` objects

### What's NOT Built Yet
- No database — everything dies when you close the tab
- No user auth
- No multi-user / team access
- No job lifecycle beyond "generate quote"
- No integration with GHL CRM (forms are separate)
- Photos stored as base64 data URLs in memory (not uploaded anywhere)
- No version history / audit trail on quotes
- No supplier ordering integration
- No scheduling / calendar

---

## 2. DATABASE STRATEGY

### Philosophy
The scoping tools work great as standalone calculators. The database layer should be additive — the tools should still work offline/standalone, but gain persistence and collaboration when connected.

### Recommended Stack

**Option A: Supabase (Recommended)**
- PostgreSQL under the hood — real relational DB
- Built-in auth (email, magic link, OAuth)
- Row-level security — team members see their jobs, admin sees all
- Storage buckets for photos/videos (S3-compatible)
- Realtime subscriptions (live updates if two people view same job)
- Generous free tier, hosted, no DevOps needed
- JS client library works directly from browser (no backend needed initially)

**Option B: Firebase/Firestore**
- Simpler but NoSQL (less structured)
- Good for rapid prototyping but harder to query complex relationships later
- Better offline support out of the box

**Option C: Self-hosted (later)**
- PostgreSQL + Express/Fastify API + S3
- Full control but requires server management
- Only worth it at scale (50+ concurrent users)

### Schema Concept

```
organisations
  ├── id, name, abn, settings_json
  └── branding (logo_url, colours, etc.)

users
  ├── id, org_id, name, email, role (admin|estimator|installer)
  └── phone, avatar_url

jobs
  ├── id, org_id, created_by, created_at, updated_at
  ├── status (draft|quoted|accepted|scheduled|in_progress|complete|invoiced)
  ├── type (fencing|patio|combo)
  ├── client_name, client_phone, client_email
  ├── site_address, site_suburb, site_lat, site_lng
  ├── scope_json          ← THE BIG ONE: entire scoping tool state
  ├── pricing_json        ← calculated pricing snapshot
  ├── notes
  └── ghl_contact_id      ← link back to GHL CRM

job_documents
  ├── id, job_id, type (quote|material_order|work_order|variation)
  ├── version (1, 2, 3...)
  ├── pdf_url             ← stored PDF
  ├── data_snapshot_json   ← the data used to generate this version
  ├── created_at, created_by
  └── sent_to_client (bool), sent_at

job_media
  ├── id, job_id, phase (scope|in_progress|completion)
  ├── type (photo|video)
  ├── storage_url          ← Supabase Storage / S3 URL
  ├── thumbnail_url
  ├── label, notes
  ├── lat, lng, taken_at
  └── uploaded_by, uploaded_at

job_events  (audit trail / activity log)
  ├── id, job_id, user_id, event_type, detail_json, created_at
  └── e.g. "quote_generated", "status_changed", "photo_added", "quote_sent"

job_assignments
  ├── job_id, user_id, role (lead_installer|helper|estimator)
  └── scheduled_date, notes
```

### Key Design Decisions

1. **`scope_json` is the entire tool state** — when you load a job, you hydrate the scoping tool from this JSON. When you save, you serialise the tool state back. This means the scoping tool doesn't need to know about the database schema — it just loads/saves its own state blob.

2. **`pricing_json` is a snapshot** — prices change over time. When a quote is generated, the pricing at that moment is frozen. The scope_json may reference current rates, but the quote document references the snapshot.

3. **Versioned documents** — every time a quote is regenerated, it's a new version. Old versions are kept. This gives you audit trail and lets you see what changed.

4. **Media stored externally** — photos/videos upload to Supabase Storage (or S3) and get a URL. The scoping tool references URLs instead of holding base64 blobs in memory. This is critical for performance.

---

## 3. PHOTO & VIDEO PIPELINE

### Current State
- `scopeMedia` object captures photos via `<input type="file" capture="environment">`
- Photos compressed client-side using `browser-image-compression` library
- Stored as base64 data URLs in a JS array
- Embedded directly into PDFs via `doc.addImage(dataUrl, 'JPEG', ...)`
- Videos captured but only stored as object URLs (lost on page reload)
- No cloud upload, no persistence

### Target Architecture

```
[Camera/Gallery] → [Client-side compress] → [Upload to Storage] → [URL reference]
                         ↓                         ↓
                   Thumbnail generated        Original preserved
                   (200px for grid)           (full res for PDF/docs)
```

**Upload flow:**
1. User captures photo (camera or library)
2. Client-side compression (already done — `browser-image-compression`)
3. Generate thumbnail (canvas resize to 200px width)
4. Upload both to Supabase Storage bucket: `/{org_id}/{job_id}/photos/{uuid}.jpg`
5. Store URL + metadata in `job_media` table
6. Scoping tool references URL instead of data URL
7. PDF generation fetches images by URL (or uses cached data URL if still in memory)

**Video handling:**
- Videos are large — must upload to storage, never hold in memory
- Consider chunked upload for reliability on mobile
- Thumbnail: extract first frame via canvas
- Storage path: `/{org_id}/{job_id}/videos/{uuid}.mp4`

**Offline consideration:**
- Service worker caches photos locally if offline
- Queue uploads for when connectivity returns
- IndexedDB as local buffer

---

## 4. MIGRATION PATH (How to Get There)

### Phase 1: Local Persistence (Quick Win)
- Add localStorage/IndexedDB save/load to both scoping tools
- Auto-save state every 30 seconds + on major actions
- "Resume last job" on page load
- Job list sidebar showing saved drafts
- **No server needed. Just client-side.**

### Phase 2: Cloud Persistence (Supabase)
- Set up Supabase project (free tier)
- Add auth (magic link email — no passwords to manage)
- Save/load `scope_json` to `jobs` table
- Upload photos to Supabase Storage
- Job list shows all jobs, searchable, sortable
- Multiple devices can access same job

### Phase 3: Document Management
- Generated PDFs uploaded to storage (not just downloaded locally)
- Version history on quotes
- "Send to client" button (email via Supabase Edge Function or GHL)
- Client-facing quote acceptance page (sign digitally)
- Track quote status: sent → viewed → accepted/declined

### Phase 4: Job Lifecycle
- Status workflow: Draft → Quoted → Accepted → Scheduled → In Progress → Complete → Invoiced
- Dashboard showing pipeline (how many jobs at each stage)
- Calendar view for scheduled installs
- Installer app view (mobile-optimised) — see today's jobs, check specs, upload completion photos

### Phase 5: Integrations
- **GHL sync**: When a lead comes in via GHL form, auto-create a draft job
- **Supplier ordering**: "Send to supplier" button on Material Order → emails formatted PO
- **Accounting**: Export to Xero/MYOB (invoice data)
- **SMS/notifications**: Job status updates to client, reminders to installers

---

## 5. JOB MANAGEMENT VISION

### The Dashboard (Future)

```
┌─────────────────────────────────────────────────────────┐
│  SecureWorks Group — Job Management                     │
├──────┬──────────────────────────────────────────────────┤
│      │  Pipeline Overview                               │
│ MENU │  ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐      │
│      │  │Draft│ │Quoted│ │Won  │ │Build│ │Done │      │
│ Jobs │  │  4  │→│  7  │→│  3  │→│  2  │→│ 12  │      │
│ Cal  │  └─────┘ └─────┘ └─────┘ └─────┘ └─────┘      │
│ Team │                                                  │
│ Mat  │  This Week                                       │
│ $$   │  ┌──────────────────────────────────────┐       │
│      │  │ Mon: Smith Fencing (Joondalup) - 12m │       │
│      │  │ Tue: Patel Patio (Wanneroo) - 6×4    │       │
│      │  │ Wed: (available)                      │       │
│      │  │ Thu: Cooper Fence+Patio (Balcatta)   │       │
│      │  │ Fri: Rain day buffer                  │       │
│      │  └──────────────────────────────────────┘       │
│      │                                                  │
│      │  Revenue This Month: $47,200                    │
│      │  Pipeline Value: $128,500                       │
│      │  Win Rate: 62%                                  │
└──────┴──────────────────────────────────────────────────┘
```

### User Roles

**Admin (Marnin)**
- Full access to everything
- Pricing controls, margin visibility
- Team management, job assignment
- Financial dashboard

**Estimator**
- Create/edit jobs, run scoping tools
- Generate quotes (see pricing, not internal costs)
- Send quotes to clients
- Convert accepted quotes to work orders

**Installer (future team)**
- Mobile-first view
- See assigned jobs for today/week
- View work order + scope details
- Upload completion photos
- Mark job stages complete
- Cannot see pricing/margins

### Job Lifecycle Detail

```
1. LEAD ARRIVES
   └── GHL form submission or manual entry
   └── Auto-creates draft job with client details + suburb

2. SITE SCOPE
   └── Open fencing/patio scoping tool
   └── Design the job (runs, panels, retaining, gates, etc.)
   └── Capture site photos/video
   └── Save scope to database

3. QUOTE GENERATION
   └── Generate Quote PDF (branded, conversion-optimised)
   └── Review internally (check margin %)
   └── Send to client (email/SMS with PDF or link)
   └── Track: sent → viewed → response

4. ACCEPTANCE
   └── Client signs (digital acceptance page or PDF sign-return)
   └── Deposit invoice auto-generated
   └── Status → Accepted
   └── Material order auto-generated

5. SCHEDULING
   └── Assign to installer team
   └── Pick install date(s)
   └── Order materials (send PO to supplier)
   └── Notify client of scheduled date

6. INSTALLATION
   └── Installer checks in (GPS + timestamp)
   └── Work order on their phone
   └── Progress photos uploaded
   └── Mark stages complete (posts in, panels up, gates hung)
   └── Site issues logged (rock, services, access problems)

7. COMPLETION
   └── QC photos uploaded
   └── Client walkthrough
   └── Digital sign-off
   └── Final invoice generated
   └── Warranty registered

8. POST-JOB
   └── Review request sent (7 days later)
   └── Referral program trigger
   └── Job archived with full history
```

---

## 6. TECHNICAL ARCHITECTURE (Target State)

```
┌──────────────────────────────────────────────┐
│                  FRONTEND                     │
│                                              │
│  ┌────────────┐  ┌────────────┐  ┌────────┐ │
│  │  Fencing   │  │   Patio    │  │  Job   │ │
│  │  Scoping   │  │  Scoping   │  │ Mgmt   │ │
│  │   Tool     │  │   Tool     │  │ Dash   │ │
│  └─────┬──────┘  └─────┬──────┘  └───┬────┘ │
│        │               │             │       │
│        └───────────┬────┘─────────────┘       │
│                    │                          │
│           ┌───────┴────────┐                 │
│           │  Shared Layer  │                 │
│           │  - Auth        │                 │
│           │  - DB client   │                 │
│           │  - Media upload│                 │
│           │  - PDF gen     │                 │
│           └───────┬────────┘                 │
└───────────────────┼──────────────────────────┘
                    │
                    ▼
┌──────────────────────────────────────────────┐
│               SUPABASE                        │
│                                              │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐  │
│  │ Postgres │  │ Storage  │  │   Auth    │  │
│  │  (jobs,  │  │ (photos, │  │ (magic    │  │
│  │  media,  │  │  videos, │  │  link,    │  │
│  │  docs)   │  │  PDFs)   │  │  roles)   │  │
│  └──────────┘  └──────────┘  └───────────┘  │
│                                              │
│  ┌──────────────────┐  ┌──────────────────┐  │
│  │ Edge Functions   │  │  Realtime        │  │
│  │ - Email sending  │  │  - Live updates  │  │
│  │ - GHL webhook    │  │  - Job status    │  │
│  │ - Supplier PO    │  │    changes       │  │
│  └──────────────────┘  └──────────────────┘  │
└──────────────────────────────────────────────┘
                    │
                    ▼
┌──────────────────────────────────────────────┐
│            EXTERNAL INTEGRATIONS              │
│                                              │
│  GoHighLevel (CRM/leads) ←→ Webhooks         │
│  Xero/MYOB (accounting)  ←→ Edge Functions   │
│  Twilio/SMS               ←→ Notifications   │
│  BlueScope (warranty reg) ←→ Future API      │
└──────────────────────────────────────────────┘
```

### Why Keep Single-HTML Architecture (For Now)

The scoping tools work as single HTML files embedded in any context — GHL page, standalone, iframe, mobile browser. This is a feature, not a limitation. The database layer can be added as an optional module:

```javascript
// At the top of each tool, optionally load the cloud module
if (window.SECUREWORKS_CLOUD) {
  // Auth, save/load, media upload available
  // UI shows "Save to Cloud" button, job picker, etc.
} else {
  // Tool works fully offline, local only
  // Same as today
}
```

This means the tools never break if the backend is down. They degrade gracefully to local-only mode.

---

## 7. FILE STRUCTURE (Current vs Target)

### Current
```
secureworks-site/
├── CLAUDE.md                    ← project context
├── STRATEGY.md                  ← this file
├── index.html                   ← main landing page
├── assets/
│   ├── logo/svg/                ← brand logos
│   └── photos/                  ← project photos
└── reference/
    ├── fencing-scoping-tool/
    │   └── fence-designer-main/
    │       └── index.html       ← fencing scoping tool (~6500 lines)
    └── patio-scoping-tool/
        └── patio-main/
            └── index.html       ← patio scoping tool (~19000 lines)
```

### Target
```
secureworks-site/
├── CLAUDE.md
├── STRATEGY.md
├── landing/                     ← marketing landing page
│   └── index.html
├── tools/
│   ├── shared/
│   │   ├── cloud.js             ← Supabase client, auth, media upload
│   │   ├── brand.js             ← SW_LOGO, colours, PDF helpers
│   │   └── media.js             ← photo/video capture + upload
│   ├── fencing/
│   │   └── index.html           ← fencing scoping tool
│   └── patio/
│       └── index.html           ← patio scoping tool
├── dashboard/                   ← job management (future)
│   ├── index.html
│   ├── jobs.html
│   ├── calendar.html
│   └── installer.html           ← mobile installer view
└── assets/
    └── logo/
```

---

## 8. IMMEDIATE NEXT STEPS (Priority Order)

1. **Finish PDF quality polish** — Quote, Material Order, Work Order PDFs need to look 8/10 minimum (currently ~3/10 per user feedback). Consistent typography, proper spacing, professional layout.

2. **Local persistence** — Add save/load to localStorage so jobs survive page refresh. Job list sidebar. Auto-save.

3. **Supabase setup** — Create project, define schema, add auth. Connect scoping tools to cloud save/load.

4. **Photo upload pipeline** — Replace in-memory data URLs with cloud-stored URLs. Keep working offline with graceful sync.

5. **Job status tracking** — Basic pipeline: Draft → Quoted → Accepted → Complete. Dashboard view.

6. **Quote sending** — "Send to Client" button that emails the PDF (via Supabase Edge Function or direct email API).

---

## 9. KEY CONSTRAINTS & DECISIONS

- **Marnin is not a developer** — tools must stay simple to maintain. Single HTML files. No build step. No npm. No framework.
- **Mobile-first** — most field use is on phones/iPads at client sites
- **GHL is the CRM** — don't rebuild CRM features, integrate with GHL
- **Perth, WA context** — all defaults, codes, standards are WA-specific
- **Faith-based business** — professional but values-driven. No aggressive sales tactics.
- **Scaling to team** — currently founder-led. Tools need to support handoff to estimators and installers who aren't Marnin.

---

*This document is a living strategy reference. Update as decisions are made and phases are completed.*
