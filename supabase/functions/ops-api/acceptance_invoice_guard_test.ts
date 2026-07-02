// Unit tests for the acceptance-invoice charge gate (_acceptanceInvoiceChargeable).
//
// HOTFIX context (2 Jul 2026): the quote self-accept flow emailed clients a branded
// "Pay Now" deposit invoice while the Xero invoice was still DRAFT. A draft's online
// link cannot take card payment, so INV-0859 / INV-0687 / INV-0686 were stranded with
// dead links. The fix (a) authorises the acceptance deposit invoice and (b) gates the
// Pay Now email/SMS behind this predicate: send ONLY when the invoice actually came
// back AUTHORISED AND a live OnlineInvoice URL was fetched.
//
// Self-contained: no network, no live Xero, no live Supabase.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { _acceptanceInvoiceChargeable } from "./index.ts"

// ── Happy path: AUTHORISED invoice + live payment URL → chargeable ──
Deno.test("chargeable: AUTHORISED + payment URL → true", () => {
  assertEquals(
    _acceptanceInvoiceChargeable("AUTHORISED", "https://in.xero.com/abc123"),
    true,
  )
})

// ── The exact bug: DRAFT invoice must NEVER be treated as chargeable, even with
//    a URL (a draft's online link is unpayable). This is what stranded clients. ──
Deno.test("NOT chargeable: DRAFT + payment URL → false (the bug)", () => {
  assertEquals(
    _acceptanceInvoiceChargeable("DRAFT", "https://in.xero.com/abc123"),
    false,
  )
})

// ── AUTHORISED but the OnlineInvoice URL fetch failed → not chargeable
//    (we would otherwise email a Pay Now with an empty/broken link). ──
Deno.test("NOT chargeable: AUTHORISED + empty URL → false", () => {
  assertEquals(_acceptanceInvoiceChargeable("AUTHORISED", ""), false)
})

// ── SUBMITTED (approval-workflow state) is not yet payable via card link. ──
Deno.test("NOT chargeable: SUBMITTED + payment URL → false", () => {
  assertEquals(
    _acceptanceInvoiceChargeable("SUBMITTED", "https://in.xero.com/abc123"),
    false,
  )
})

// ── Missing / malformed status or URL are all non-chargeable (fail-safe). ──
Deno.test("NOT chargeable: null/undefined/non-string inputs → false", () => {
  assert(!_acceptanceInvoiceChargeable(null, "https://in.xero.com/abc123"))
  assert(!_acceptanceInvoiceChargeable(undefined, "https://in.xero.com/abc123"))
  assert(!_acceptanceInvoiceChargeable("AUTHORISED", null))
  assert(!_acceptanceInvoiceChargeable("AUTHORISED", undefined))
  // A non-string URL (e.g. an object leaking through) must not be treated as a link.
  assert(!_acceptanceInvoiceChargeable("AUTHORISED", { href: "https://evil" }))
})
