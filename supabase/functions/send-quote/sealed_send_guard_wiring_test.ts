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
  assertEquals(block.indexOf("return", ret + 1), -1, "no other way out");
});
