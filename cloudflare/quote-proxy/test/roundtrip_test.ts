// deno-lint-ignore-file no-import-prefix
// The backend and the worker agree: every customer link the backend builds with
// CUSTOMER_PUBLIC_HOST set is served by the worker from exactly the address the
// backend built before the setting. No network.
// Run: deno test cloudflare/quote-proxy/test/roundtrip_test.ts
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts"
import { CUSTOMER_FILE_BUCKETS as WORKER_BUCKETS, CUSTOMER_QUOTE_ROUTES as WORKER_ROUTES, rewriteLocation, upstreamFor } from "../src/index.js"
import {
  CUSTOMER_FILE_BUCKETS,
  CUSTOMER_QUOTE_ROUTES,
  customerSendQuoteUrl,
  customerUrl,
  customerVariationLink,
  customerViewerUrl,
} from "../../../supabase/functions/_shared/customer_public_host.ts"
import { customer3dLink, CUSTOMER_3D_PAGE_DEFAULT_URL } from "../../../supabase/functions/send-quote/customer_model.ts"

const HOST = "https://quote.secureworksgroup.app"
const SB = "https://kevgrhcjxspbxgovpmfl.supabase.co"
const VIEWER = "https://secureworks-website.pages.dev/quote.html"

Deno.test("same customer routes and buckets on both sides", () => {
  assertEquals([...CUSTOMER_QUOTE_ROUTES], WORKER_ROUTES)
  assertEquals([...CUSTOMER_FILE_BUCKETS], WORKER_BUCKETS)
})

Deno.test("send-quote links: our /q/<route> is served by the old function address", () => {
  for (const route of CUSTOMER_QUOTE_ROUTES) {
    const link = `${customerSendQuoteUrl(HOST, SB, route)}?token=t1`
    assertEquals(upstreamFor(link, {})?.upstream, `${customerSendQuoteUrl(null, SB, route)}?token=t1`)
  }
  assertEquals(upstreamFor(customerVariationLink(HOST, "v1"), {})?.upstream, `${SB}/functions/v1/send-quote/view?token=v1&type=variation`)
})

Deno.test("file links: our /files is served by the old storage address", () => {
  for (const bucket of CUSTOMER_FILE_BUCKETS) {
    const old = `${SB}/storage/v1/object/public/${bucket}/org/job/quote_v1_A%20B.pdf`
    assertEquals(upstreamFor(customerUrl(old, HOST), {})?.upstream, old)
  }
})

Deno.test("viewer links: the worker accepts the src the backend builds, and its redirect rewrite gives the same link", () => {
  const html = `${SB}/storage/v1/object/public/job-pdfs/org/job/quote_v1_web.html`
  const link = customerViewerUrl(VIEWER, html, HOST)
  assertEquals(upstreamFor(link, {})?.kind, "page")
  const src = new URL(link).searchParams.get("src")!
  assertEquals(upstreamFor(src, {})?.upstream, html)
  // The function's redirect before the setting, rewritten by the worker, equals the backend's link with it.
  assertEquals(rewriteLocation(customerViewerUrl(VIEWER, html, null), `${SB}/functions/v1/send-quote/view`, HOST, {}), link)
})

Deno.test("3D links: patio and fence are served by the hosted page; the token stays on our side", () => {
  for (const what of ["patio", "fence"] as const) {
    const link = customer3dLink(CUSTOMER_3D_PAGE_DEFAULT_URL, "t3", HOST, what)
    assertEquals(link, `${HOST}/3d/${what}/quote-3d.html?token=t3`)
    assertEquals(upstreamFor(link, {})?.upstream, CUSTOMER_3D_PAGE_DEFAULT_URL)
    assert(!/github\.io/.test(link))
  }
})
