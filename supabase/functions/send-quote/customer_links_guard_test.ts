// deno-lint-ignore-file no-import-prefix
// Guard: every customer link in send-quote and the variation email goes through
// the CUSTOMER_PUBLIC_HOST builders (_shared/customer_public_host.ts), so a new
// hand-built supabase, GitHub or pages.dev link fails here instead of reaching a customer.
// Run: deno test --allow-read supabase/functions/send-quote/customer_links_guard_test.ts
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts"

const sendQuote = await Deno.readTextFile(new URL("./index.ts", import.meta.url))
const opsApi = await Deno.readTextFile(new URL("../ops-api/index.ts", import.meta.url))

const count = (s: string, re: RegExp) => (s.match(re) || []).length

Deno.test("send-quote: no hand-built customer link on a supabase, GitHub or pages.dev address", () => {
  assertEquals(count(sendQuote, /kevgrhcjxspbxgovpmfl\.supabase\.co\/functions/g), 0, "page scripts use PAGE_SEND_QUOTE_BASE")
  assertEquals(count(sendQuote, /\$\{QUOTE_VIEWER_BASE\}\?src=/g), 0, "viewer links use customerViewerUrl")
  assertEquals(count(sendQuote, /\$\{(BASE_URL|SUPABASE_URL)\}\/functions\/v1\/send-quote\/(view|accept|decline|payment-confirmed|upload-plans|model)/g), 0, "use customerSendQuoteUrl")
  assertEquals(count(sendQuote, /\$\{url\.origin\}\$\{url\.pathname\}/g), 1, "only currentQuoteViewBase's unset branch")
  assertEquals(count(sendQuote, /\$\{(doc|d)\.pdf_url\}|\? d\.pdf_url \+|encodeURIComponent\(doc\.pdf_url\)/g), 0, "pdf links use customerUrl")
  assertEquals(count(sendQuote, /pdfUrl: doc\.pdf_url/g), 0, "email pdf link uses customerUrl")
  assertEquals(count(sendQuote, /github\.io|pages\.dev/g), 1, "only QUOTE_VIEWER_BASE's default names pages.dev")
})

Deno.test("send-quote: every 3D link and the model route are told the host", () => {
  const lines = sendQuote.split("\n")
  const links = lines.filter((l) => l.includes("customer3dLink("))
  assert(links.length >= 2)
  for (const l of links) assert(l.includes("CUSTOMER_HOST"), l)
  const model = lines.filter((l) => l.includes("handleCustomerModelRequest("))
  assertEquals(model.length, 1)
  assert(model[0].includes("CUSTOMER_HOST)"), model[0])
})

Deno.test("ops-api: the variation link uses customerVariationLink", () => {
  assertEquals(count(opsApi, /secureworks-ux\/quote-viewer\.html/g), 0)
  assertEquals(count(opsApi, /customerVariationLink\(customerPublicHost\(Deno\.env\.get\('CUSTOMER_PUBLIC_HOST'\)\), variation\.share_token\)/g), 1)
})

Deno.test("send-quote: the Google PDF viewer is used only when the company host is off", () => {
  const lines = sendQuote.split("\n").filter((l) => l.includes("docs.google.com/gview"))
  assert(lines.length >= 1)
  for (const l of lines) assert(/CUSTOMER_HOST \? customerUrl\(/.test(l), l)
})
