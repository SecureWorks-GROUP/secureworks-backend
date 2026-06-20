// MakeSafe Reporting Autopilot (Wave 2) -- pure, testable building blocks for
// the makesafe_report_drafts READ endpoint. NO network, NO Supabase, NO Xero.
// The orchestration (index.ts:makesafeReportDrafts) imports these and supplies
// the live client + storage signing.
//
// This endpoint is READ-ONLY. It returns the jobs that are report-draft-ready
// for the informed-approve cockpit (substatus = 'admin_to_send_report'), with
// everything a human needs to make the send decision: invoice line items +
// totals, signed PDF urls (report + invoice), evidence photos, and a default
// subject + html body that the UI shows and that MUST PASS the client-send gate
// in makesafe_send_pack.ts (no review/test marker in the subject).
//
// MONEY/COMMS-adjacent: the cockpit's approve button triggers a live
// authorise+send, so the defaults composed here are written to pass the gate
// (no TEST/ROUND/DRAFT/REVIEW/INTERNAL/PREVIEW token in the subject).

import { REVIEW_MARKERS } from './makesafe_send_pack.ts'

// The substatus the reporting routine sets once it has drafted the invoice and
// rendered the report. These jobs are awaiting the human tick + send.
export const REPORT_DRAFT_READY_SUBSTATUS = 'admin_to_send_report'

// ── Default subject composer ──
//
// Gate-passing by construction: never contains a REVIEW_MARKER token. We strip
// any accidental marker token from the address/ref inputs and assert the result
// is clean (the test pins this). Shape mirrors the client-send convention:
//   "Make Safe Completion - <ref> - <address>"
// Falls back gracefully when ref/address are missing so the subject is never
// empty (the gate rejects an empty subject).
const MARKER_TOKEN_RE = new RegExp(
  '(^|[^A-Za-z0-9])(' + REVIEW_MARKERS.join('|') + ')([^A-Za-z0-9]|$)',
  'gi',
)

// Remove any standalone review-marker token from a free-text fragment so it can
// never leak into the subject. Collapses the whitespace it leaves behind.
export function stripReviewMarkers(text: string | null | undefined): string {
  let out = String(text ?? '')
  // Run repeatedly: adjacent markers can share a boundary char the first pass
  // consumes, so a single pass can miss the second token.
  let prev: string
  do {
    prev = out
    out = out.replace(MARKER_TOKEN_RE, ' ')
  } while (out !== prev)
  return out.replace(/\s+/g, ' ').trim()
}

export function composeDefaultSubject(args: {
  externalRef?: string | null
  siteAddress?: string | null
  siteSuburb?: string | null
}): string {
  const ref = stripReviewMarkers(args.externalRef)
  const addr = stripReviewMarkers(args.siteAddress || args.siteSuburb)
  const parts = ['Make Safe Completion']
  if (ref) parts.push(ref)
  if (addr) parts.push(addr)
  // Always at least "Make Safe Completion" so the subject is never empty.
  return parts.join(' - ')
}

// ── Default html body composer ──
//
// A short completion note. Plain, professional, no review markers, no em
// dashes. The sender mailbox appends the Maverick/SecureWorks signature, so the
// body deliberately does NOT add a second typed sign-off.
export function composeDefaultHtmlBody(args: {
  builderName?: string | null
  externalRef?: string | null
  clientName?: string | null
  siteAddress?: string | null
  invoiceNumber?: string | null
  totalIncGst?: number | null
}): string {
  const builder = escapeHtmlText(args.builderName || 'team')
  const ref = escapeHtmlText(args.externalRef || '')
  const client = escapeHtmlText(args.clientName || '')
  const addr = escapeHtmlText(args.siteAddress || '')
  const inv = escapeHtmlText(args.invoiceNumber || '')
  const total = args.totalIncGst != null ? formatAud(args.totalIncGst) : ''

  const detailRows: string[] = []
  if (ref) detailRows.push(row('Your reference', ref))
  if (client) detailRows.push(row('Site contact', client))
  if (addr) detailRows.push(row('Site address', addr))
  if (inv) detailRows.push(row('Invoice', inv))
  if (total) detailRows.push(row('Invoice total (inc GST)', total))

  return [
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#293C46;line-height:1.6;">',
    `<p>Hi ${builder},</p>`,
    '<p>Please find attached our make safe completion report and tax invoice for the works below.</p>',
    detailRows.length
      ? '<table style="border-collapse:collapse;margin:14px 0;">' + detailRows.join('') + '</table>'
      : '',
    '<p>The completion report sets out the work carried out and the site condition on completion. The attached tax invoice covers these works.</p>',
    '<p>Please let us know if you need anything further.</p>',
    '</div>',
  ].filter(Boolean).join('')
}

function row(label: string, value: string): string {
  return `<tr><td style="padding:3px 16px 3px 0;color:#4C6A7C;font-weight:700;">${label}</td>` +
    `<td style="padding:3px 0;">${value}</td></tr>`
}

// Minimal HTML-text escape for values we interpolate into the body. Not a full
// sanitiser: these inputs are our own job data, this just prevents accidental
// tag breakage / injection from a stray '<'.
export function escapeHtmlText(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function formatAud(n: number): string {
  const v = Number(n) || 0
  return '$' + v.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// ── Invoice line-item normalisation ──
//
// xero_invoices.line_items is a JSONB array stored in Xero's native shape
// (Description / Quantity / UnitAmount / LineAmount). createInvoice does NOT
// write line_items into the local row -- only the 2-hourly xero-sync does -- so
// a freshly-drafted make-safe invoice can have NULL/[] lines locally until sync
// runs. We normalise whatever shape is present and tolerate snake_case too.
export interface NormalisedLine {
  description: string
  quantity: number
  unit_price: number
  line_total: number
}

export function normaliseLineItems(raw: unknown): NormalisedLine[] {
  if (!Array.isArray(raw)) return []
  return raw.map((li: any) => {
    const description = String(li?.Description ?? li?.description ?? '')
    const quantity = num(li?.Quantity ?? li?.quantity ?? 1)
    const unitPrice = num(li?.UnitAmount ?? li?.unit_price ?? li?.unitPrice ?? 0)
    // Prefer the stored LineAmount; otherwise derive qty * unit.
    const lineTotal = li?.LineAmount != null || li?.line_total != null || li?.lineTotal != null
      ? num(li?.LineAmount ?? li?.line_total ?? li?.lineTotal)
      : Math.round(quantity * unitPrice * 100) / 100
    return { description, quantity, unit_price: unitPrice, line_total: lineTotal }
  })
}

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

// ── Total computation ──
//
// Prefer the stored header totals (xero_invoices.sub_total = ex GST,
// xero_invoices.total = inc GST). When the header is missing, fall back to the
// sum of local line totals (ex GST) and gross up by 1.1. Returns rounded values.
export function computeInvoiceTotals(args: {
  subTotal?: number | null
  total?: number | null
  lines: NormalisedLine[]
}): { total_ex_gst: number; total_inc_gst: number; source: 'header' | 'lines' } {
  const hasHeaderEx = args.subTotal != null && Number.isFinite(Number(args.subTotal))
  const hasHeaderInc = args.total != null && Number.isFinite(Number(args.total))
  if (hasHeaderEx || hasHeaderInc) {
    const ex = hasHeaderEx ? round2(Number(args.subTotal)) : round2(Number(args.total) / 1.1)
    const inc = hasHeaderInc ? round2(Number(args.total)) : round2(Number(args.subTotal) * 1.1)
    return { total_ex_gst: ex, total_inc_gst: inc, source: 'header' }
  }
  const ex = round2(args.lines.reduce((s, l) => s + (l.line_total || 0), 0))
  return { total_ex_gst: ex, total_inc_gst: round2(ex * 1.1), source: 'lines' }
}

function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100
}

// ── Builder recipient email resolution (BLOCKER C — fail-closed) ──
//
// MONEY/COMMS-sensitive. The make-safe report pack To MUST be the builder's
// WORK-ORDERS inbox (makesafe_companies.report_recipient), NOT the per-builder
// BILLING contact (invoice_email). For AJS the billing contact is
// vanessa@ajs.build, who must NEVER be the To of a report send.
//
// Resolution is report_recipient ONLY. When it is absent we return null and the
// cockpit shows a "no work-order recipient configured" warning (the human cannot
// approve a send with no recipient). We do NOT silently fall back to
// invoice_email — that would put vanessa on the To. invoice_email is accepted as
// an arg purely for back-compat of the signature but is never used as the To.
export function resolveRecipientEmail(args: {
  companyReportRecipient?: string | null
  companyInvoiceEmail?: string | null
  detailInvoiceEmail?: string | null
}): string | null {
  // The work-orders inbox is the ONLY acceptable To. No fallback to billing.
  const fromReportRecipient = clean(args.companyReportRecipient)
  if (fromReportRecipient) return fromReportRecipient
  return null
}

function clean(s: unknown): string | null {
  const v = String(s ?? '').trim()
  return v.length ? v : null
}

// Test-only aliases (mirror the `_`-prefixed convention in the sibling modules).
export const _composeDefaultSubject = composeDefaultSubject
export const _composeDefaultHtmlBody = composeDefaultHtmlBody
export const _normaliseLineItems = normaliseLineItems
export const _computeInvoiceTotals = computeInvoiceTotals
export const _resolveRecipientEmail = resolveRecipientEmail
export const _stripReviewMarkers = stripReviewMarkers
