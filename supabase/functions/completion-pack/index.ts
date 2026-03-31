// ════════════════════════════════════════════════════════════
// SecureWorks — Completion Pack Generator
//
// Generates a branded HTML completion report for a job:
//   Page 1: Letterhead, job details, description of works
//   Page 2: Completion photos in grid with captions
//   Page 3: Warranty, maintenance tips, client signature
//   Page 4: Google review CTA, refer-a-friend, branded footer
//
// Stores the HTML in Supabase Storage and optionally emails
// the client via GHL.
//
// Deploy:
//   /Users/marninstobbe/.local/bin/supabase functions deploy completion-pack --no-verify-jwt
//
// Usage:
//   POST { job_id, send_email?: boolean }
// ════════════════════════════════════════════════════════════

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || ''
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
const DEFAULT_ORG_ID = '00000000-0000-0000-0000-000000000001'

// ── Constants ──
const COMPANY_PHONE = '0489 267 771'
const COMPANY_EMAIL = 'swwa@secureworkswa.com.au'
const COMPANY_WEBSITE = 'secureworkswa.com.au'
const COMPANY_ABN = '64 689 223 416'
const GOOGLE_REVIEW_URL = 'https://g.page/r/CY-SwuwXayc1EBM/review'
const REFERRAL_INCENTIVE = '$200'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key',
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  })
}

function esc(s: string): string {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ── SecureWorks logo as inline SVG ──
function logoSVG(height = 36): string {
  return `<svg viewBox="0 0 62.54 79.55" xmlns="http://www.w3.org/2000/svg" style="height:${height}px;width:auto;">
    <polygon fill="#fff" points="53.54 30.35 53.54 22.29 31.54 8.51 9 22.26 9 34.53 45.72 42.34 45.72 52.83 38.68 52.83 31.53 45.47 24.29 52.83 16.81 52.83 16.81 39 9 37.4 9 60.64 27.56 60.64 31.5 56.65 35.38 60.64 53.54 60.64 53.54 36.01 16.81 28.21 16.81 26.65 31.49 17.69 45.72 26.61 45.72 31.95 53.54 33.41 53.54 30.35"/>
  </svg>`
}

// ── Star rating SVG (5 stars) ──
function starsSVG(): string {
  const star = `<svg viewBox="0 0 24 24" width="32" height="32" fill="#F15A29"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>`
  return star.repeat(5)
}

// ── QR code as inline SVG placeholder ──
// In production, generate from GOOGLE_REVIEW_URL via a QR library or API
function qrCodeSVG(): string {
  return `<div style="width:140px;height:140px;background:#fff;border:2px solid #293C46;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:4px;">
    <svg viewBox="0 0 24 24" width="48" height="48" fill="#293C46"><path d="M3 11h8V3H3v8zm2-6h4v4H5V5zm8-2v8h8V3h-8zm6 6h-4V5h4v4zM3 21h8v-8H3v8zm2-6h4v4H5v-4zm13-2h-2v2h2v-2zm0 4h-2v2h2v-2zm-4-4h-2v2h2v-2zm4 4h2v2h-2v-2zm0-4h2v2h-2v-2zm-4 4h-2v2h2v-2z"/></svg>
    <span style="font-size:8px;color:#4C6A7C;text-align:center;">Scan to review</span>
  </div>`
}

// ── Warranty text by job type ──
function warrantyText(type: string): string {
  switch (type) {
    case 'patio':
      return `<strong>10-Year Structural Warranty</strong><br>
SecureWorks Group warrants that all structural components of your patio installation — including posts, beams, footings, and roof structure — are free from defects in materials and workmanship for a period of <strong>10 years</strong> from the date of completion.<br><br>
This warranty covers structural integrity only. Normal wear, cosmetic changes (e.g. minor colour fade from UV), damage from misuse, extreme weather events beyond design specifications, or modifications made by others are not covered.<br><br>
<strong>Manufacturer Warranties</strong><br>
SolarSpan/Bondor insulated panels carry their own manufacturer warranty (typically 15 years for thermal performance). Colorbond steel carries BlueScope's standard warranty. These are in addition to our structural warranty.`
    case 'decking':
      return `<strong>10-Year Structural Warranty</strong><br>
SecureWorks Group warrants that all structural components of your decking installation — including subframe, bearers, joists, and footings — are free from defects in materials and workmanship for a period of <strong>10 years</strong> from the date of completion.<br><br>
This warranty covers structural integrity of the subframe only. Normal wear, cosmetic changes, and surface weathering of boards are not covered under the structural warranty.<br><br>
<strong>Manufacturer Warranties</strong><br>
Composite decking boards carry the manufacturer's warranty (typically 25 years for structural integrity, 10 years for colour fade). Hardwood boards are a natural product and are not covered by manufacturer warranty — regular oiling is required to maintain appearance.`
    case 'fencing':
      return `<strong>5-Year Structural Warranty</strong><br>
SecureWorks Group warrants that all structural components of your fencing installation — including posts, rails, footings, and panel attachment — are free from defects in materials and workmanship for a period of <strong>5 years</strong> from the date of completion.<br><br>
This warranty covers structural integrity, post integrity, panel attachment, and gate mechanisms. Normal wear, cosmetic changes, gate hardware (springs, closers), damage from external forces (e.g. fallen trees, vehicle impact), or modifications made by others are not covered.<br><br>
<strong>Manufacturer Warranties</strong><br>
COLORBOND&reg; steel carries BlueScope's standard 10-year fencing warranty for colour and corrosion. This is in addition to our structural warranty.`
    default:
      return `<strong>Structural Warranty</strong><br>
SecureWorks Group warrants that all structural components of your installation are free from defects in materials and workmanship. Patio and decking structures carry a 10-year structural warranty. Fencing carries a 5-year structural warranty. Please contact us for specific warranty details for your installation.`
  }
}

// ── Maintenance tips by job type ──
function maintenanceTips(type: string): string[] {
  switch (type) {
    case 'patio':
      return [
        'Clean panels and beams with mild soapy water annually to prevent dirt buildup.',
        'Check gutter outlets and downpipes for debris — clear after autumn leaf fall.',
        'Inspect flashings and panel joints after severe storms for any water ingress.',
        'Do not walk on insulated panels — they are not designed for foot traffic.',
        'If you have lighting or fan fittings, have electrical connections checked annually by a licensed electrician.',
        'Inspect all fixings and connections annually — tighten any that have loosened.',
        'Check footings for any signs of ground movement, especially after heavy rain.',
      ]
    case 'fencing':
      return [
        'Hose down panels quarterly to prevent dirt and salt buildup.',
        'Lubricate gate hinges and latches with silicone spray annually.',
        'Check gate closers and adjust tension seasonally — they can stiffen in cold weather.',
        'Check post bases for soil erosion and maintain ground levels.',
        'Avoid leaning heavy objects against fence panels — this can cause bowing over time.',
        'If near the coast, wash more frequently to prevent salt corrosion.',
        'Inspect all fixings and connections annually — tighten any that have loosened.',
      ]
    case 'decking':
      return [
        'Sweep regularly to prevent dirt and leaf buildup, which can cause staining.',
        'Clean with a composite deck cleaner every 6 months (avoid harsh chemicals).',
        'For hardwood decking: oil every 12 months with a quality decking oil to maintain colour and weather resistance.',
        'Move planters and furniture periodically to prevent uneven weathering.',
        'Avoid dragging heavy furniture across the deck surface — use felt pads under legs.',
        'Check subframe fixings annually and tighten any that have loosened.',
        'Ensure drainage under the deck is clear — standing water can cause long-term issues.',
      ]
    default:
      return [
        'Inspect all fixings and connections annually — tighten any that have loosened.',
        'Keep gutters and downpipes clear of leaves and debris.',
        'Check footings for any signs of ground movement, especially after heavy rain.',
        'Clean with mild soapy water annually to maintain appearance.',
      ]
  }
}

// ── Build the HTML completion pack ──
function buildCompletionPackHTML(job: any, photos: any[], signature: any): string {
  const completedDate = job.completed_at
    ? new Date(job.completed_at).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Australia/Perth' })
    : new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Australia/Perth' })

  // Extract scope details into readable format
  let scopeItems: string[] = []
  if (job.scope_json) {
    const scope = typeof job.scope_json === 'string' ? JSON.parse(job.scope_json) : job.scope_json

    // Try structured sections first
    if (scope.sections) {
      for (const section of scope.sections) {
        if (section.label && section.value) {
          scopeItems.push(`<strong>${esc(section.label)}:</strong> ${esc(String(section.value))}`)
        }
      }
    }
    // Try items array
    if (scope.items && Array.isArray(scope.items)) {
      for (const item of scope.items) {
        const text = typeof item === 'string' ? item : (item.description || item.name || '')
        if (text) scopeItems.push(esc(text))
      }
    }
    // Try summary
    if (scope.summary) scopeItems.push(esc(scope.summary))

    // Try common patio/fencing scope fields
    if (scope.config || scope.client) {
      const cfg = scope.config || scope
      const cl = scope.client || {}
      if (cfg.roofStyle) scopeItems.push(`<strong>Roof Style:</strong> ${esc(cfg.roofStyle)}`)
      if (cfg.width && cfg.projection) scopeItems.push(`<strong>Dimensions:</strong> ${esc(String(cfg.width))}m wide &times; ${esc(String(cfg.projection))}m deep`)
      if (cfg.sheetType || cfg.panelType) scopeItems.push(`<strong>Panels:</strong> ${esc(cfg.sheetType || cfg.panelType)}`)
      if (cfg.sheetColour || cfg.colour) scopeItems.push(`<strong>Colour:</strong> ${esc(cfg.sheetColour || cfg.colour)}`)
      if (cfg.beamSize) scopeItems.push(`<strong>Beams:</strong> ${esc(cfg.beamSize)}`)
      if (cfg.posts) scopeItems.push(`<strong>Posts:</strong> ${esc(String(cfg.posts))}`)
      // Fencing-specific
      if (cfg.profile) scopeItems.push(`<strong>Profile:</strong> ${esc(cfg.profile)}`)
      if (cfg.totalMetres) scopeItems.push(`<strong>Total Length:</strong> ${esc(String(cfg.totalMetres))}m`)
      if (cfg.totalPanels) scopeItems.push(`<strong>Panels:</strong> ${esc(String(cfg.totalPanels))}`)
    }

    // Fallback: flatten any remaining key-value pairs
    if (scopeItems.length === 0 && typeof scope === 'object') {
      for (const [key, val] of Object.entries(scope)) {
        if (typeof val === 'string' || typeof val === 'number') {
          const label = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
          scopeItems.push(`<strong>${esc(label)}:</strong> ${esc(String(val))}`)
        }
      }
    }
  }

  const tips = maintenanceTips(job.type)
  const warranty = warrantyText(job.type)
  const jobType = (job.type || 'patio').charAt(0).toUpperCase() + (job.type || 'patio').slice(1)
  const clientFirst = (job.client_name || '').split(' ')[0] || 'there'

  // ── CSS ──
  const css = `
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;color:#293C46;background:#fff;line-height:1.6;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.page{max-width:794px;margin:0 auto}

/* Page breaks for print/PDF */
.page-break{page-break-before:always;break-before:page}

/* ── Page 1: Letterhead + Job Details ── */
.letterhead{background:#293C46;color:#fff;padding:40px;position:relative}
.letterhead::after{content:'';display:block;height:4px;background:#F15A29;position:absolute;bottom:0;left:0;right:0}
.lh-top{display:flex;justify-content:space-between;align-items:flex-start}
.lh-logo{display:flex;align-items:center;gap:14px}
.lh-company{font-size:20px;font-weight:700;letter-spacing:-0.3px}
.lh-company span{color:#F15A29;font-style:italic}
.lh-contact{text-align:right;font-size:11px;line-height:1.8;opacity:0.75}
.lh-title{margin-top:28px;font-size:28px;font-weight:700;letter-spacing:-0.5px}
.lh-subtitle{font-size:13px;opacity:0.6;margin-top:4px}
.lh-badge{display:inline-block;margin-top:16px;background:rgba(241,90,41,0.15);border:1px solid rgba(241,90,41,0.3);padding:6px 16px;font-size:12px;font-weight:700;letter-spacing:1px;color:#F15A29}

/* Sections */
.section{padding:28px 40px;border-bottom:1px solid #E8E4DF}
.section:last-child{border-bottom:none}
.section-title{font-size:11px;text-transform:uppercase;letter-spacing:1.2px;color:#4C6A7C;font-weight:700;margin-bottom:16px}
.section-title::before{content:'';display:inline-block;width:3px;height:14px;background:#F15A29;margin-right:8px;vertical-align:-2px}

/* Info grid */
.info-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px 32px}
.info-item .label{font-size:10px;text-transform:uppercase;letter-spacing:0.8px;color:#4C6A7C;font-weight:700}
.info-item .value{font-size:15px;margin-top:2px;color:#293C46}

/* Scope list */
.scope-list{list-style:none;display:grid;gap:6px}
.scope-list li{padding:10px 14px;background:#F8F6F3;font-size:14px;line-height:1.5}

/* ── Page 2: Photos ── */
.photo-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.photo-card{background:#F8F6F3;overflow:hidden}
.photo-card img{width:100%;aspect-ratio:4/3;object-fit:cover;display:block}
.photo-card .caption{padding:8px 12px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#4C6A7C}

/* ── Page 3: Warranty + Signature ── */
.warranty-box{background:#293C46;color:#fff;padding:28px;line-height:1.7;font-size:13px}
.warranty-box strong{color:#F15A29}
.tips-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px 20px}
.tip-item{padding:10px 0;font-size:13px;display:flex;gap:10px;align-items:baseline;border-bottom:1px solid #eee}
.tip-num{background:#F15A29;color:#fff;width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;flex-shrink:0}
.sig-block{display:flex;align-items:center;gap:32px;padding:24px;background:#F8F6F3}
.sig-block img{max-width:280px;width:100%;flex-shrink:0}
.sig-details{font-size:14px;color:#4C6A7C}
.sig-details .sig-name{font-size:16px;font-weight:700;color:#293C46;margin-bottom:4px}

/* ── Page 4: Review + Referral ── */
.cta-section{background:#F8F6F3;padding:36px 40px;text-align:center}
.cta-section h2{font-size:22px;font-weight:700;color:#293C46;margin-bottom:8px}
.cta-section p{font-size:14px;color:#4C6A7C;max-width:500px;margin:0 auto;line-height:1.6}
.stars{margin:16px 0;display:flex;justify-content:center;gap:4px}
.review-content{display:flex;align-items:center;justify-content:center;gap:32px;margin-top:20px}

.referral-section{padding:36px 40px;border-top:3px solid #F15A29}
.referral-section h2{font-size:20px;font-weight:700;color:#293C46;margin-bottom:4px}
.referral-amount{font-size:48px;font-weight:700;color:#F15A29;letter-spacing:-2px;line-height:1}
.referral-text{font-size:14px;color:#4C6A7C;line-height:1.6;max-width:500px;margin:12px 0}
.referral-contact{margin-top:16px;font-size:15px;font-weight:600;color:#293C46}
.referral-contact span{color:#F15A29}

/* Footer */
.footer{background:#293C46;color:rgba(255,255,255,0.7);padding:32px 40px;font-size:12px;line-height:1.8}
.footer-inner{display:flex;justify-content:space-between;align-items:center}
.footer strong{color:#fff}
.footer .accent{color:#F15A29}

/* Print */
@media print{
  body{background:#fff}
  .page{max-width:100%}
  .section{break-inside:avoid}
  .photo-grid{grid-template-columns:1fr 1fr}
  .photo-card{break-inside:avoid}
}
@media(max-width:600px){
  .letterhead{padding:24px 20px}
  .lh-top{flex-direction:column;gap:12px}
  .lh-contact{text-align:left}
  .section{padding:20px}
  .info-grid{grid-template-columns:1fr}
  .photo-grid{grid-template-columns:1fr}
  .tips-grid{grid-template-columns:1fr}
  .review-content{flex-direction:column}
  .sig-block{flex-direction:column}
  .footer-inner{flex-direction:column;gap:12px}
}`

  // ════════════════════════════════════════
  // PAGE 1 — Letterhead + Job Details
  // ════════════════════════════════════════
  let html = `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Project Completion Report — ${esc(job.job_number)} — ${esc(job.client_name)}</title>
<style>${css}</style></head><body>
<div class="page">

<!-- LETTERHEAD -->
<div class="letterhead">
  <div class="lh-top">
    <div class="lh-logo">
      ${logoSVG(40)}
      <div class="lh-company">SecureWorks <span>WA</span></div>
    </div>
    <div class="lh-contact">
      ABN ${COMPANY_ABN}<br>
      ${COMPANY_PHONE}<br>
      ${COMPANY_EMAIL}
    </div>
  </div>
  <div class="lh-title">Project Completion Report</div>
  <div class="lh-subtitle">${jobType} Installation</div>
  <div class="lh-badge">${esc(job.job_number)}</div>
</div>

<!-- JOB DETAILS -->
<div class="section">
  <div class="section-title">Job Details</div>
  <div class="info-grid">
    <div class="info-item"><div class="label">Client</div><div class="value">${esc(job.client_name)}</div></div>
    <div class="info-item"><div class="label">Job Number</div><div class="value">${esc(job.job_number)}</div></div>
    <div class="info-item"><div class="label">Site Address</div><div class="value">${esc((job.site_address || '') + (job.site_suburb ? ', ' + job.site_suburb : ''))}</div></div>
    <div class="info-item"><div class="label">Completion Date</div><div class="value">${completedDate}</div></div>
  </div>
</div>`

  // DESCRIPTION OF WORKS
  if (scopeItems.length > 0) {
    html += `
<div class="section">
  <div class="section-title">Description of Works</div>
  <ul class="scope-list">
    ${scopeItems.map(item => `<li>${item}</li>`).join('\n    ')}
  </ul>
</div>`
  }

  // ════════════════════════════════════════
  // PAGE 2 — Completion Photos
  // ════════════════════════════════════════
  if (photos.length > 0) {
    html += `
<div class="page-break"></div>
<div class="section">
  <div class="section-title">Completion Photos</div>
  <div class="photo-grid">
    ${photos.slice(0, 6).map(p => `<div class="photo-card">
      <img src="${esc(p.storage_url || p.url)}" alt="${esc(p.label || p.caption || 'Completion photo')}" loading="lazy">
      <div class="caption">${esc(p.label || p.caption || 'Completed works')}</div>
    </div>`).join('\n    ')}
  </div>
</div>`
  }

  // ════════════════════════════════════════
  // PAGE 3 — Warranty + Maintenance + Signature
  // ════════════════════════════════════════
  html += `
<div class="page-break"></div>
<div class="section">
  <div class="section-title">Warranty Information</div>
  <div class="warranty-box">${warranty}</div>
</div>

<div class="section">
  <div class="section-title">Care &amp; Maintenance</div>
  <div class="tips-grid">
    ${tips.map((tip, i) => `<div class="tip-item"><div class="tip-num">${i + 1}</div><div>${esc(tip)}</div></div>`).join('\n    ')}
  </div>
</div>`

  // Client signature
  if (signature && signature.signature_data) {
    const sigDate = signature.signed_at || job.completed_at
    const sigDateFormatted = sigDate
      ? new Date(sigDate).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Australia/Perth' })
      : completedDate
    html += `
<div class="section">
  <div class="section-title">Client Acceptance</div>
  <div class="sig-block">
    <img src="${signature.signature_data}" alt="Client signature">
    <div class="sig-details">
      ${signature.signature_name ? `<div class="sig-name">${esc(signature.signature_name)}</div>` : ''}
      <div>Accepted: ${sigDateFormatted}</div>
      <div style="margin-top:8px;font-size:12px;color:#8FA4B2;">By signing, the homeowner acknowledges that the works described in this report have been completed to their satisfaction.</div>
    </div>
  </div>
</div>`
  }

  // ════════════════════════════════════════
  // PAGE 4 — Review + Referral + Footer
  // ════════════════════════════════════════
  html += `
<div class="page-break"></div>

<!-- GOOGLE REVIEW -->
<div class="cta-section">
  <h2>We'd Love Your Feedback</h2>
  <p>Scan to leave us a review on Google — it takes 30 seconds and helps other Perth families find quality outdoor living.</p>
  <div class="stars">${starsSVG()}</div>
  <div class="review-content">
    ${qrCodeSVG()}
    <div style="text-align:left;font-size:13px;color:#4C6A7C;line-height:1.7;">
      <strong style="color:#293C46;">How to leave a review:</strong><br>
      1. Scan the QR code with your phone camera<br>
      2. Sign in to your Google account<br>
      3. Tap the stars and write a few words<br><br>
      <span style="font-size:12px;">Or visit: <strong style="color:#F15A29">${esc(GOOGLE_REVIEW_URL)}</strong></span>
    </div>
  </div>
</div>

<!-- REFER A FRIEND -->
<div class="referral-section">
  <div style="display:flex;gap:32px;align-items:center;flex-wrap:wrap;">
    <div>
      <h2>Refer a Friend</h2>
      <div class="referral-amount">${REFERRAL_INCENTIVE}</div>
      <div style="font-size:12px;color:#F15A29;font-weight:700;text-transform:uppercase;letter-spacing:1px;">Off your next project</div>
    </div>
    <div style="flex:1;min-width:260px;">
      <div class="referral-text">
        Know someone who'd love a new patio, fence, or deck? Refer them to SecureWorks and receive <strong style="color:#F15A29;">${REFERRAL_INCENTIVE} off your next project</strong> when they book.<br><br>
        Just have them mention your name when they enquire.
      </div>
      <div class="referral-contact">
        <span>&#9742;</span> ${COMPANY_PHONE} &nbsp;&middot;&nbsp; <span>&#9670;</span> ${COMPANY_WEBSITE}
      </div>
    </div>
  </div>
</div>

<!-- FOOTER -->
<div class="footer">
  <div class="footer-inner">
    <div>
      ${logoSVG(28)}
      <div style="margin-top:8px;">
        <strong>SecureWorks Group Pty Ltd</strong><br>
        ABN ${COMPANY_ABN}<br>
        Perth, Western Australia
      </div>
    </div>
    <div style="text-align:right;">
      <span class="accent">Phone:</span> ${COMPANY_PHONE}<br>
      <span class="accent">Email:</span> ${COMPANY_EMAIL}<br>
      <span class="accent">Web:</span> ${COMPANY_WEBSITE}<br><br>
      <span style="opacity:0.5;">Thank you for choosing SecureWorks, ${esc(clientFirst)}.<br>We hope you love your new outdoor living space.</span>
    </div>
  </div>
</div>

</div></body></html>`

  return html
}

// ── Plain-text helpers for PDF generation ──

function extractScopeItems(job: any): string[] {
  const items: string[] = []
  if (!job.scope_json) return items
  try {
    const scope = typeof job.scope_json === 'string' ? JSON.parse(job.scope_json) : job.scope_json
    if (scope.sections) {
      for (const s of scope.sections) { if (s.label && s.value) items.push(`${s.label}: ${s.value}`) }
    }
    if (scope.items && Array.isArray(scope.items)) {
      for (const i of scope.items) { const t = typeof i === 'string' ? i : (i.description || i.name || ''); if (t) items.push(t) }
    }
    if (scope.summary) items.push(scope.summary)
    const cfg = scope.config || scope
    if (cfg.roofStyle) items.push(`Roof Style: ${cfg.roofStyle}`)
    if (cfg.width && cfg.projection) items.push(`Dimensions: ${cfg.width}m x ${cfg.projection}m`)
    if (cfg.length && cfg.projection) items.push(`Dimensions: ${cfg.length}m x ${cfg.projection}m`)
    if (cfg.sheetType || cfg.panelType) items.push(`Panels: ${cfg.sheetType || cfg.panelType}`)
    if (cfg.sheetColour || cfg.colour) items.push(`Colour: ${cfg.sheetColour || cfg.colour}`)
    if (cfg.totalMetres || cfg.totalLength) items.push(`Total Length: ${cfg.totalMetres || cfg.totalLength}m`)
    if (cfg.material) items.push(`Material: ${cfg.material}`)
    if (cfg.height) items.push(`Height: ${cfg.height}mm`)
  } catch { /* ignore */ }
  return items
}

function getWarrantyText(type: string): string[] {
  const t = (type || 'patio').toLowerCase()
  if (t === 'fencing') {
    return [
      'Warranty Information — Fencing',
      'Your fence is covered by a 10-year structural warranty from SecureWorks Group.',
      'Colorbond steel is warranted by BlueScope for up to 10 years against perforation by corrosion.',
      'Warranty does not cover: damage from third parties, natural disasters, failure to maintain.',
      'Keep vegetation clear of fence panels to prevent moisture damage.',
    ]
  }
  if (t === 'decking') {
    return [
      'Warranty Information — Decking',
      'Your deck is covered by a 10-year structural warranty from SecureWorks Group.',
      'Composite decking boards carry a manufacturer warranty of up to 25 years.',
      'Warranty does not cover: cosmetic variations, damage from furniture without pads, DIY modifications.',
      'Clean with mild soap and water every 3-6 months. Avoid pressure washing above 1500 PSI.',
    ]
  }
  return [
    'Warranty Information — Insulated Patio',
    'Your patio is covered by a 10-year structural warranty from SecureWorks Group.',
    'SolarSpan insulated panels carry a Bondor manufacturer warranty of up to 15 years.',
    'Colorbond roofing and flashings are warranted by BlueScope for up to 10 years.',
    'Warranty does not cover: damage caused by third parties, modifications, or acts of nature.',
    'Gutters should be cleaned every 6-12 months. Inspect flashings annually.',
  ]
}

// ════════════════════════════════════════════════════════════
// MAIN HANDLER
// ════════════════════════════════════════════════════════════

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })

  // ── API Key Authentication ──
  const apiKey = req.headers.get('x-api-key') || req.headers.get('authorization')?.replace('Bearer ', '')
  const validKey = Deno.env.get('SW_API_KEY')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!apiKey || (apiKey !== validKey && apiKey !== serviceKey)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...CORS, 'Content-Type': 'application/json' }
    })
  }

  try {
    const body = await req.json()
    const jId = body.job_id || body.jobId
    if (!jId) return json({ error: 'job_id required' }, 400)

    const client = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

    // Fetch job data
    const { data: job, error: jobErr } = await client
      .from('jobs')
      .select('id, job_number, client_name, client_email, client_phone, type, status, site_address, site_suburb, scope_json, pricing_json, completed_at, ghl_contact_id')
      .eq('id', jId)
      .single()
    if (jobErr || !job) return json({ error: 'Job not found' }, 404)

    // Fetch completion photos
    const { data: photos } = await client
      .from('job_media')
      .select('storage_url, label, caption')
      .eq('job_id', jId)
      .eq('phase', 'completion')
      .order('uploaded_at', { ascending: false })

    // Fetch signature (from job_media where phase='signature')
    const { data: sigMedia } = await client
      .from('job_media')
      .select('storage_url, label')
      .eq('job_id', jId)
      .eq('phase', 'signature')
      .order('uploaded_at', { ascending: false })
      .limit(1)

    // Also check service report for signature data
    const { data: report } = await client
      .from('job_service_reports')
      .select('signature_data, signature_name, signed_at, status')
      .eq('job_id', jId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    // Build signature object — prefer service report (has inline data), fallback to media
    let signature: any = null
    if (report?.signature_data) {
      signature = report
    } else if (sigMedia && sigMedia.length > 0) {
      signature = {
        signature_data: sigMedia[0].storage_url,
        signature_name: job.client_name,
        signed_at: job.completed_at,
      }
    }

    // Build HTML (always — used as fallback and for email)
    const html = buildCompletionPackHTML(job, photos || [], signature)

    // Attempt PDF generation with jsPDF (fallback to HTML if it fails)
    let pdfBlob: Blob | null = null
    let usedPdf = false
    try {
      const { jsPDF } = await import('https://esm.sh/jspdf@2.5.1')
      const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
      const pageW = 210, margin = 20, contentW = pageW - 2 * margin

      // ── Page 1: Cover ──
      doc.setFillColor(41, 60, 70) // dark blue
      doc.rect(0, 0, pageW, 45, 'F')
      doc.setTextColor(255, 255, 255)
      doc.setFontSize(22)
      doc.setFont('helvetica', 'bold')
      doc.text('SecureWorks Group', margin, 25)
      doc.setFontSize(10)
      doc.setFont('helvetica', 'normal')
      doc.text('Project Completion Report', margin, 33)

      // Orange accent bar
      doc.setFillColor(241, 90, 41)
      doc.rect(0, 45, pageW, 3, 'F')

      // Job details
      doc.setTextColor(41, 60, 70)
      doc.setFontSize(14)
      doc.setFont('helvetica', 'bold')
      doc.text(job.client_name || 'Client', margin, 62)
      doc.setFontSize(11)
      doc.setFont('helvetica', 'normal')
      doc.setTextColor(76, 106, 124)
      const details = [
        `Job: ${job.job_number || 'N/A'}`,
        `Type: ${(job.type || 'patio').charAt(0).toUpperCase() + (job.type || 'patio').slice(1)}`,
        `Address: ${job.site_address || ''}, ${job.site_suburb || ''}`,
        `Completed: ${job.completed_at ? new Date(job.completed_at).toLocaleDateString('en-AU') : 'N/A'}`,
      ]
      let y = 72
      details.forEach(d => { doc.text(d, margin, y); y += 7 })

      // Scope summary
      const scopeItems = extractScopeItems(job)
      if (scopeItems.length > 0) {
        y += 8
        doc.setFontSize(12)
        doc.setFont('helvetica', 'bold')
        doc.setTextColor(41, 60, 70)
        doc.text('Description of Works', margin, y)
        y += 8
        doc.setFontSize(10)
        doc.setFont('helvetica', 'normal')
        doc.setTextColor(76, 106, 124)
        scopeItems.slice(0, 10).forEach(item => {
          if (y > 270) { doc.addPage(); y = 20 }
          doc.text(`• ${item}`, margin + 2, y)
          y += 6
        })
      }

      // ── Page 2: Photos ──
      if ((photos || []).length > 0) {
        doc.addPage()
        doc.setFillColor(41, 60, 70)
        doc.rect(0, 0, pageW, 12, 'F')
        doc.setTextColor(255, 255, 255)
        doc.setFontSize(12)
        doc.setFont('helvetica', 'bold')
        doc.text('Completion Photos', margin, 9)

        // Note: jsPDF can embed images but fetching and converting to base64
        // in a Deno edge function is unreliable. Show photo list as text instead.
        doc.setTextColor(76, 106, 124)
        doc.setFontSize(10)
        doc.setFont('helvetica', 'normal')
        let py = 22
        ;(photos || []).slice(0, 8).forEach((p: any, i: number) => {
          doc.text(`${i + 1}. ${p.label || p.caption || 'Completion photo'}`, margin, py)
          py += 6
        })
        doc.text(`View all ${(photos || []).length} photos in the online version.`, margin, py + 4)
      }

      // ── Page 3: Warranty ──
      doc.addPage()
      doc.setFillColor(41, 60, 70)
      doc.rect(0, 0, pageW, 12, 'F')
      doc.setTextColor(255, 255, 255)
      doc.setFontSize(12)
      doc.setFont('helvetica', 'bold')
      doc.text('Warranty & Care', margin, 9)

      doc.setTextColor(41, 60, 70)
      doc.setFontSize(10)
      doc.setFont('helvetica', 'normal')
      let wy = 22
      const warrantyLines = getWarrantyText(job.type)
      warrantyLines.forEach(line => {
        if (wy > 270) { doc.addPage(); wy = 20 }
        const split = doc.splitTextToSize(line, contentW)
        doc.text(split, margin, wy)
        wy += split.length * 5 + 3
      })

      // ── Page 4: Review CTA ──
      doc.addPage()
      doc.setFillColor(241, 90, 41)
      doc.rect(0, 0, pageW, 3, 'F')
      doc.setTextColor(41, 60, 70)
      doc.setFontSize(16)
      doc.setFont('helvetica', 'bold')
      doc.text('Leave Us a Review', margin, 25)
      doc.setFontSize(11)
      doc.setFont('helvetica', 'normal')
      doc.setTextColor(76, 106, 124)
      doc.text('We\'d love to hear about your experience!', margin, 35)
      doc.text(`Review us on Google: ${GOOGLE_REVIEW_URL}`, margin, 45)
      doc.text(`Refer a friend and receive ${REFERRAL_INCENTIVE} off your next project.`, margin, 60)

      // Footer on all pages
      const totalPages = doc.getNumberOfPages()
      for (let i = 1; i <= totalPages; i++) {
        doc.setPage(i)
        doc.setFontSize(8)
        doc.setTextColor(150, 150, 150)
        doc.text(`SecureWorks Group | ABN ${COMPANY_ABN} | ${COMPANY_PHONE}`, margin, 290)
        doc.text(`Page ${i} of ${totalPages}`, pageW - margin - 25, 290)
      }

      pdfBlob = doc.output('blob')
      usedPdf = true
      console.log('[completion-pack] PDF generated successfully')
    } catch (pdfErr) {
      console.warn('[completion-pack] jsPDF import/generation failed, falling back to HTML:', (pdfErr as Error).message)
      usedPdf = false
    }

    // Store in Supabase Storage
    const bucket = 'completion-packs'
    try { await client.storage.createBucket(bucket, { public: true }) } catch { /* exists */ }

    let fileName: string
    let uploadBody: Blob
    let contentType: string

    if (usedPdf && pdfBlob) {
      fileName = `${DEFAULT_ORG_ID}/${jId}/${job.job_number || 'pack'}-completion.pdf`
      uploadBody = pdfBlob
      contentType = 'application/pdf'
    } else {
      fileName = `${DEFAULT_ORG_ID}/${jId}/${job.job_number || 'pack'}-completion.html`
      uploadBody = new Blob([html], { type: 'text/html' })
      contentType = 'text/html'
    }

    const { error: uploadErr } = await client.storage
      .from(bucket)
      .upload(fileName, uploadBody, { contentType, upsert: true })
    if (uploadErr) {
      console.error('[completion-pack] Storage upload error:', uploadErr)
      return json({ error: 'Failed to store completion pack' }, 500)
    }

    const { data: urlData } = client.storage.from(bucket).getPublicUrl(fileName)
    const publicUrl = urlData.publicUrl

    // Log event
    await client.from('job_events').insert({
      job_id: jId,
      event_type: 'completion_pack_generated',
      detail_json: {
        url: publicUrl,
        format: usedPdf ? 'pdf' : 'html',
        photos_count: (photos || []).length,
        has_signature: !!signature?.signature_data,
      },
    })

    // Optionally email via GHL
    let emailSent = false
    if (body.send_email && job.ghl_contact_id) {
      try {
        const ghlUrl = `${SUPABASE_URL}/functions/v1/ghl-proxy?action=send_email`
        const emailResp = await fetch(ghlUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contactId: job.ghl_contact_id,
            subject: `Your SecureWorks Project Completion Report — ${job.job_number}`,
            htmlBody: `<div style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;color:#293C46;">
              <div style="background:#293C46;padding:24px 32px;text-align:center;">
                <div style="color:#fff;font-size:18px;font-weight:700;">SecureWorks <span style="color:#F15A29;font-style:italic;">WA</span></div>
              </div>
              <div style="padding:32px;">
                <p style="font-size:16px;">Hi ${esc(clientFirst)},</p>
                <p>Thank you for choosing SecureWorks Group! Your ${jobType.toLowerCase()} project is now complete.</p>
                <p>We've prepared your Project Completion Report with job details, completion photos, warranty information, and maintenance tips:</p>
                <p style="text-align:center;margin:28px 0;">
                  <a href="${publicUrl}" style="background:#F15A29;color:#fff;padding:14px 28px;text-decoration:none;font-weight:700;font-size:15px;display:inline-block;">View Your Completion Report</a>
                </p>
                <p style="font-size:13px;color:#4C6A7C;">If you have any questions or need anything in the future, we're just a call away on <strong>${COMPANY_PHONE}</strong>.</p>
                <p>Warm regards,<br><strong>The SecureWorks Group Team</strong></p>
              </div>
              <div style="background:#F8F6F3;padding:16px 32px;font-size:12px;color:#4C6A7C;text-align:center;">
                SecureWorks Group Pty Ltd | ABN ${COMPANY_ABN} | ${COMPANY_WEBSITE}
              </div>
            </div>`,
          }),
        })
        const emailResult = await emailResp.json()
        emailSent = emailResult.success || false

        if (emailSent) {
          await client.from('job_events').insert({
            job_id: jId,
            event_type: 'completion_pack_emailed',
            detail_json: { url: publicUrl, email: job.client_email },
          })
        }
      } catch (e) {
        console.log('[completion-pack] Email send failed (non-blocking):', e)
      }
    }

    return json({
      success: true,
      url: publicUrl,
      email_sent: emailSent,
      photos_count: (photos || []).length,
      has_signature: !!signature?.signature_data,
      has_scope: (job.scope_json != null),
    })

  } catch (err) {
    console.error('[completion-pack] ERROR:', err)
    return json({ error: (err as Error).message || 'Internal error' }, 500)
  }
})
