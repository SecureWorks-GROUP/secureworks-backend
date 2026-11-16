// deno-lint-ignore-file no-import-prefix
// Ruling 18 K2: where the sealed-send guard sits in /send and /send-runs.
// The rules themselves are tested in _shared/scope_freeze/sealed_send_guard_test.ts.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

function between(from: string, to: string, start = 0): [number, number] {
  const a = src.indexOf(from, start);
  const b = src.indexOf(to, a + 1);
  assert(a >= 0 && b > a, `${from} .. ${to}`);
  return [a, b];
}

Deno.test("/send: judged once, refused under the claim before any email, recorded when off", () => {
  const [sendStart, sendEnd] = between("if (path === 'send' && req.method === 'POST')", "if (path === 'send-runs' && req.method === 'POST')");
  const send = src.slice(sendStart, sendEnd);
  const judge = send.indexOf("judgeSealedSend(sb, {");
  const sealedSource = send.indexOf("const sealedSource = sealedSendSource(await sourceScopeRevisionRead, doc.job_id)");
  const claim = send.indexOf("const claimed = await claimQuoteDocumentSend(sb, document_id)");
  const refuse = send.indexOf("if (sealedGuard.kind === 'miss' && sealedGuard.switch_on) {");
  const ownerRefused = send.indexOf("if (ownerPrice.kind === 'refused') {");
  const offRecord = send.indexOf("if (sealedGuard.kind === 'miss' && !sealedGuard.switch_on) {");
  const provider = send.indexOf("fetch('https://api.resend.com/emails'");
  assert(sealedSource >= 0 && judge > sealedSource, "judged on the resolved sealed source");
  assertEquals(send.indexOf("judgeSealedSend(", judge + 1), -1, "judged once");
  assert(claim > judge && refuse > claim, "refused only once the send is claimed");
  assert(ownerRefused > refuse, "before the owner price refusal");
  assert(offRecord > ownerRefused && provider > offRecord, "the off record is written before the email");

  const refusal = send.slice(refuse, send.indexOf("\n      }\n", refuse));
  assert(refusal.includes("recordSealedSendMiss(sb, sealedGuard, sealedGuardRecord)"), "a refusal is recorded");
  assert(refusal.includes("revertQuoteDocumentSendClaim(sb, document_id, claimed.token, 'pre_send')"), "the claim is released");
  assert(refusal.includes("jsonResponse(sealedGuard.body, sealedGuard.status, corsHeaders)"), "the guard's words go back");

  const off = send.slice(offRecord, send.indexOf("\n      }\n", offRecord));
  assert(off.includes("recordSealedSendMiss(sb, sealedGuard, sealedGuardRecord)"), "an off miss is recorded");
  assert(!/\breturn\b/.test(off), "switch off: the send goes on exactly as today");
});

Deno.test("/send-runs: judged under the job claim, before any document or email, outside the request prelude", () => {
  const [runsStart] = between("if (path === 'send-runs' && req.method === 'POST')", "fetch('https://api.resend.com/emails'");
  const runs = src.slice(runsStart);
  const preludeEnd = runs.indexOf("const pj = typeof job.pricing_json");
  const claim = runs.indexOf("const jobClaim = await claimJobSendRuns(sb, job.id)");
  const tryAt = runs.indexOf("try {", claim);
  const judge = runs.indexOf("judgeSealedSend(sb, {");
  const docsRead = runs.indexOf("const { data: existingQuoteRows, error: existingQuoteError } = await sb.from('job_documents')");
  const provider = runs.indexOf("fetch('https://api.resend.com/emails'");
  const finallyAt = runs.indexOf("clearJobSendRunsClaim(sb, job.id, jobClaim.claimed_at)", judge);
  assert(preludeEnd > 0 && judge > preludeEnd, "not in the prelude send_runs_request_test runs");
  assert(claim > 0 && tryAt > claim && judge > tryAt, "inside the try that releases the job claim");
  assert(docsRead > judge && provider > judge, "before any run document is made or emailed");
  assert(finallyAt > judge, "the finally releases the claim on a refusal");

  const block = runs.slice(judge, docsRead);
  assert(block.includes("recordSealedSendMiss(sb, sealedGuardRuns, {"), "every miss is recorded");
  assert(block.includes("{ storageBaseUrl: SUPABASE_URL }"), "run PDFs are read only from our own storage");
  const onlyWhenOn = block.indexOf("if (sealedGuardRuns.switch_on) {");
  const ret = block.indexOf("return jsonResponse(sealedGuardRuns.body, sealedGuardRuns.status, corsHeaders)");
  assert(onlyWhenOn > 0 && ret > onlyWhenOn, "refused only while the switch is on");
  // The one other way out is a pinned copy that could not be made, which
  // only a passed send with the switch on reaches.
  const pinBranch = block.indexOf("if (sealedGuardRuns.kind === 'pass' && sealedGuardRuns.switch_on && sealedGuardRuns.verified_run_pdfs) {");
  const second = block.indexOf("return", ret + 1);
  assert(pinBranch > ret && second > pinBranch, "the second return is inside the switch-on pin branch");
  assertEquals(block.indexOf("return", second + 1), -1, "no other way out");
});

Deno.test("/send, switch on: the customer link moves to the pinned copy of the checked bytes before any email", () => {
  const [sendStart, sendEnd] = between("if (path === 'send' && req.method === 'POST')", "if (path === 'send-runs' && req.method === 'POST')");
  const send = src.slice(sendStart, sendEnd);
  const refuse = send.indexOf("if (sealedGuard.kind === 'miss' && sealedGuard.switch_on) {");
  const pin = send.indexOf("if (sealedGuard.kind === 'pass' && sealedGuard.switch_on && sealedGuard.verified_pdf) {");
  const ownerRefused = send.indexOf("if (ownerPrice.kind === 'refused') {");
  const emailBuilt = send.indexOf("pdfUrl: customerUrl(doc.pdf_url, CUSTOMER_HOST)");
  const provider = send.indexOf("fetch('https://api.resend.com/emails'");
  assert(pin > refuse && ownerRefused > pin && emailBuilt > pin && provider > pin, "pinned after the claim, before the email is built");
  const block = send.slice(pin, ownerRefused);
  assert(block.includes("pinSealedQuotePdf(sb, doc.job_id, sealedGuard.verified_pdf)"), "the checked bytes are pinned");
  assert(block.includes("linkDocumentsToSealedCopy(sb, [document_id], pinned.url, String(doc.pdf_url))"), "only the checked address is moved");
  assert(block.includes("revertQuoteDocumentSendClaim(sb, document_id, claimed.token, 'pre_send')"), "a failed copy releases the claim");
  assert(block.includes("recordSealedSendMiss(sb, failed, sealedGuardRecord)"), "a failed copy is recorded");
  assert(block.includes("doc.pdf_url = pinned.url"), "the email and release record use the copy");
});

Deno.test("/send-runs, switch on: run documents link to pinned copies and the email carries only the checked bytes", () => {
  const [runsStart] = between("if (path === 'send-runs' && req.method === 'POST')", "fetch('https://api.resend.com/emails'");
  const runs = src.slice(runsStart);
  const judge = runs.indexOf("judgeSealedSend(sb, {");
  const pin = runs.indexOf("const pinned = await pinSealedQuotePdf(sb, job.id, pdf)");
  const docsRead = runs.indexOf("const { data: existingQuoteRows, error: existingQuoteError } = await sb.from('job_documents')");
  assert(pin > judge && docsRead > pin, "pinned under the job claim, before any run document is made");
  assert(runs.includes("const runPdfUrl = sealedRunPdfs?.get(run.run_label)?.url || run_pdfs?.[run.run_label] || null"), "new run documents link to the copy");
  const relink = runs.indexOf("if (sealedRunPdfs) {");
  const provider = runs.indexOf("fetch('https://api.resend.com/emails'");
  assert(relink > docsRead && provider > relink, "reused run documents are relinked before any email");
  assert(runs.slice(relink, provider).includes("abortAfterDocumentClaimRelease(false,"), "a failed relink releases the document claims");
  const attach = runs.indexOf("if (ownerPriceRuns.kind === 'approved' || sealedRunPdfs) {");
  const urlBranch = runs.indexOf("attachments.push({ path: pdfUrl, filename })", attach);
  const bytesBranch = runs.slice(attach, urlBranch);
  assert(attach > 0 && urlBranch > attach, "bytes first, the URL only otherwise");
  assert(bytesBranch.includes("sealedRunPdfs?.get(run.run_label || '')?.bytes"), "the guard's checked bytes, by run label");
  assert(!bytesBranch.includes("path:"), "never asks the provider to fetch the URL");
});

Deno.test("ghl-proxy never issues an upload address over a pinned copy", async () => {
  const proxy = await Deno.readTextFile(new URL("../ghl-proxy/index.ts", import.meta.url));
  assert(proxy.includes("const reusePinnedCopy = isSealedQuoteCopyPath(reusedPdfPath)"));
  assert(proxy.includes("const cPinnedCopy = isSealedQuoteCopyPath(cReusedPdfPath)"));
  assertEquals((proxy.match(/createSignedUploadUrl\(existingPdfPath/g) || []).length, 1);
  assertEquals((proxy.match(/createSignedUploadUrl\(cPdfPath/g) || []).length, 1);
});
