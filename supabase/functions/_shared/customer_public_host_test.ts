// deno-lint-ignore-file no-import-prefix no-explicit-any
// CUSTOMER_PUBLIC_HOST link builders. Unset: byte-identical to the addresses
// built before the setting (each "today" value below is the old expression).
// Set: no supabase.co, github.io or pages.dev in any customer link.
// Run: deno test supabase/functions/_shared/customer_public_host_test.ts
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts"
import {
  CUSTOMER_FILE_BUCKETS,
  CUSTOMER_QUOTE_ROUTES,
  customerPageSendQuoteBase,
  customerPaymentConfirmPostUrl,
  customerPublicHost,
  customerPublicHostInvalid,
  customerSendQuoteUrl,
  customerUrl,
  customerVariationLink,
  customerViewerUrl,
  LEGACY_PAGE_SEND_QUOTE_BASE,
} from "./customer_public_host.ts"

const SB = "https://kevgrhcjxspbxgovpmfl.supabase.co"
const HOST = "https://quote.secureworksgroup.app"
const VIEWER = "https://secureworks-website.pages.dev/quote.html"
const TOKEN = "2b7c6a1e-1111-4222-8333-944455556666"
const PDF = `${SB}/storage/v1/object/public/job-pdfs/00000000-0000-0000-0000-000000000001/job-1/quote_v3_Smith%20Patio.pdf`
const HTML = `${SB}/storage/v1/object/public/job-pdfs/00000000-0000-0000-0000-000000000001/job-1/quote_v3_web.html`
const PAGE = `${SB}/storage/v1/object/public/quote-views/pages/0f0e0d0c-1111-2222-3333-444455556666.txt`
const FORBIDDEN = /supabase\.co|supabase\.in|github\.io|pages\.dev/

Deno.test("setting: bare https origin or host name accepted; anything else is unset", () => {
  assertEquals(customerPublicHost(undefined), null)
  assertEquals(customerPublicHost(""), null)
  assertEquals(customerPublicHost("   "), null)
  assertEquals(customerPublicHost("https://quote.secureworksgroup.app"), HOST)
  assertEquals(customerPublicHost("https://quote.secureworksgroup.app/"), HOST)
  assertEquals(customerPublicHost(" quote.secureworksgroup.app "), HOST)
  assertEquals(customerPublicHost("https://Quote.SecureWorksGroup.app"), HOST)
  assertEquals(customerPublicHost("https://quote.secureworksgroup.com.au"), "https://quote.secureworksgroup.com.au")
  for (const bad of ["http://quote.secureworksgroup.app", "https://quote.secureworksgroup.app/q", "https://quote.secureworksgroup.app?x=1",
    "https://quote.secureworksgroup.app#a", "https://u:p@quote.secureworksgroup.app", "https://quote.secureworksgroup.app:8443", "ftp://x", "https://"]) {
    assertEquals(customerPublicHost(bad), null, bad)
    assert(customerPublicHostInvalid(bad), bad)
  }
  assert(!customerPublicHostInvalid(undefined))
  assert(!customerPublicHostInvalid(HOST))
})

Deno.test("unset: every builder returns today's address byte for byte", () => {
  for (const base of [SB, "https://example.test/custom-public-url"]) {
    assertEquals(`${customerSendQuoteUrl(null, base, "view")}?token=${TOKEN}`, `${base}/functions/v1/send-quote/view?token=${TOKEN}`)
    assertEquals(`${customerSendQuoteUrl(null, base, "payment-confirmed")}?token=${TOKEN}`, `${base}/functions/v1/send-quote/payment-confirmed?token=${TOKEN}`)
  }
  for (const u of [PDF, HTML, PAGE, "", null, undefined, "not a url", `${SB}/functions/v1/send-quote/view?token=a`]) {
    assertEquals(customerUrl(u as any, null), u)
  }
  for (const src of [HTML, PAGE, "https://elsewhere.example/a b?c=d&e"]) {
    assertEquals(customerViewerUrl(VIEWER, src, null), `${VIEWER}?src=${encodeURIComponent(src)}`)
  }
  assertEquals(customerPageSendQuoteBase(null), "https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/send-quote/")
  assertEquals(customerPageSendQuoteBase(null), LEGACY_PAGE_SEND_QUOTE_BASE)
  assertEquals(customerPaymentConfirmPostUrl(null, "a b&c"), `payment-confirmed?token=${encodeURIComponent("a b&c")}`)
  assertEquals(
    customerVariationLink(null, TOKEN),
    `https://secureworks-group.github.io/secureworks-ux/quote-viewer.html?token=${TOKEN}&type=variation`,
  )
})

Deno.test("set: send-quote routes on /q, files on /files, viewer on /view with our src", () => {
  assertEquals(`${customerSendQuoteUrl(HOST, SB, "view")}?token=${TOKEN}`, `${HOST}/q/view?token=${TOKEN}`)
  assertEquals(customerSendQuoteUrl(HOST, SB, "payment-confirmed"), `${HOST}/q/payment-confirmed`)
  assertEquals(customerUrl(PDF, HOST), `${HOST}/files/job-pdfs/00000000-0000-0000-0000-000000000001/job-1/quote_v3_Smith%20Patio.pdf`)
  assertEquals(customerUrl(PAGE, HOST), `${HOST}/files/quote-views/pages/0f0e0d0c-1111-2222-3333-444455556666.txt`)
  assertEquals(customerUrl(`${SB}/functions/v1/send-quote/accept?token=a`, HOST), `${HOST}/q/accept?token=a`)
  assertEquals(
    customerViewerUrl(VIEWER, HTML, HOST),
    `${HOST}/view?src=${encodeURIComponent(`${HOST}/files/job-pdfs/00000000-0000-0000-0000-000000000001/job-1/quote_v3_web.html`)}`,
  )
  assertEquals(customerPageSendQuoteBase(HOST), `${HOST}/q/`)
  assertEquals(customerPaymentConfirmPostUrl(HOST, "tok"), `${HOST}/q/payment-confirmed?token=tok`)
  assertEquals(customerVariationLink(HOST, TOKEN), `${HOST}/q/view?token=${TOKEN}&type=variation`)
  for (const link of [
    customerSendQuoteUrl(HOST, SB, "view"), customerUrl(PDF, HOST), customerUrl(HTML, HOST), customerUrl(PAGE, HOST),
    customerViewerUrl(VIEWER, HTML, HOST), customerViewerUrl(VIEWER, PAGE, HOST), customerPageSendQuoteBase(HOST),
    customerPaymentConfirmPostUrl(HOST, TOKEN), customerVariationLink(HOST, TOKEN),
  ]) {
    assert(!FORBIDDEN.test(decodeURIComponent(link)), link)
    assert(link.startsWith(`${HOST}/`), link)
  }
})

Deno.test("set: addresses outside the map are left alone (they still work), the viewer keeps today's shell for them", () => {
  for (const u of [
    `${SB}/storage/v1/object/public/job-photos/a.jpg`,
    `${SB}/storage/v1/object/public/job-documents/a.pdf`,
    `${SB}/functions/v1/send-quote/send`,
    `${SB}/functions/v1/ops-api?action=x`,
    `${SB}/storage/v1/object/sign/job-pdfs/a.pdf?token=x`,
    "http://kevgrhcjxspbxgovpmfl.supabase.co/storage/v1/object/public/job-pdfs/a.pdf",
    "https://in.xero.com/abc",
  ]) assertEquals(customerUrl(u, HOST), u)
  const odd = `${SB}/storage/v1/object/public/job-photos/a.jpg`
  assertEquals(customerViewerUrl(VIEWER, odd, HOST), `${VIEWER}?src=${encodeURIComponent(odd)}`)
})

Deno.test("route and bucket lists are the customer ones only", () => {
  assertEquals([...CUSTOMER_QUOTE_ROUTES], ["view", "accept", "decline", "payment-confirmed", "upload-plans", "model"])
  assertEquals([...CUSTOMER_FILE_BUCKETS], ["job-pdfs", "quote-views"])
})
