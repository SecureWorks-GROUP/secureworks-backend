# GHL ↔ Scoping Tool Integration

## Status: LIVE (deployed 2026-03-01)

## Architecture
- **Edge function:** `supabase/functions/ghl-proxy/index.ts` — deployed on project `kevgrhcjxspbxgovpmfl`
- ALL Supabase queries route through edge function (service role key) to bypass RLS
- Photos + videos upload via signed URLs (not base64) — handles any file size
- GHL API token: Private Integration Token with all scopes enabled

## Key URLs
- Patio tool: `https://secureworks-group.github.io/patio/`
- Fencing tool: `https://secureworks-group.github.io/fence-designer/`
- Patio repo: `https://github.com/SecureWorks-GROUP/patio.git`
- Fencing repo: `https://github.com/SecureWorks-GROUP/fence-designer.git`

## Edge Function Endpoints
- `opportunities`, `search`, `contact`, `update_contact` — GHL API
- `find_job`, `create_job`, `save_scope`, `load_job` — Supabase jobs (bypass RLS)
- `list_media`, `get_upload_url`, `register_media`, `upload_photo`, `delete_media` — media
- `link` — moves GHL opportunity to Scope Complete + adds rich note to contact
- `get_profile` — user profile load (bypass RLS)
- `setup_storage` — makes storage buckets public

## Pipeline IDs (from ghl-proxy/index.ts)
- **Sales**: Fencing `I9t8njpuR0Dm7B2NDcvI`, Patios `OGZLpPPVWVarN94HL6af`
- **Execution**: Fencing `fgV2mkFh6BD4gOZZx94y`, Patios `SxayUz0KRDlCUk58apCC`
- **Materials**: `SkgfC3nzTsOHqTSv9LNl`
- **Scope Complete stages**: Fencing `418534d4-6356-4c20-a274-51fbb892c2fa`, Patios `9b9e5313-8e0e-4ed6-8654-d50413b99885`

## Key Files (shared between both tools)
- `tools/shared/cloud.js` — Supabase client, auth, GHL API methods
- `tools/shared/integration.js` — toolbar, save/load, photo/video upload, GHL picker

## Critical Lesson: RLS
ALL client-side Supabase queries hang due to RLS policies. Every operation must go through the edge function with service role key. This includes: job CRUD, user profile load, media queries, saves.

## Auth
- Magic link (OTP) via Supabase Auth
- Session persists in localStorage, profile loads via edge function
- Supabase allowed redirects: both GitHub Pages URLs configured

## GHL ↔ Xero Sync (added March 2026)
See `sync-layer.md` for full details. Summary:
- `link` action now also: generates SW job number, creates/finds Xero contact, pushes $ to GHL
- Job numbers: SWP (patio), SWF (fencing), SWD (decking), SWR (reno/roofing), SWI (insurance)
- Xero contact lookup: email first (reliable), then exact name match
- All sync steps are non-blocking — scope complete still succeeds if Xero/GHL calls fail
- `send-quote` also pushes monetary value to GHL opportunity
