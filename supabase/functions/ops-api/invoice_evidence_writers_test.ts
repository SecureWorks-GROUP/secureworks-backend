// The invoice evidence ops-api writes must land on the invoice's job (gap plan
// B-4). business_events.job_id is a uuid: invoice.created used to pass the job
// NUMBER there, so every write failed (22P02) and was swallowed as non-blocking.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

function blocksAround(marker: string, before = 400, after = 900): string[] {
  const out: string[] = [];
  for (let at = source.indexOf(marker); at >= 0; at = source.indexOf(marker, at + 1)) {
    out.push(source.slice(Math.max(0, at - before), at + after));
  }
  return out;
}

Deno.test("invoice.created passes the job uuid and the raised key, never the job number", () => {
  const writes = blocksAround("event_type: 'invoice.created'", 0, 700);
  assertEquals(writes.length, 2);
  for (const block of writes) {
    assert(/\bjob_id: jId,/.test(block), block);
    assert(!/job_id: job\??\.job_number/.test(block), block);
    assert(block.includes("provider_message_id: `xero:invoice:${invoiceResult.xero_invoice_id}:raised`"), block);
  }
});

Deno.test("a keyed duplicate is the same fact, not a failure", () => {
  const helper = blocksAround("async function logBusinessEvent(", 0, 4500)[0];
  assert(helper.includes("event.provider_message_id ? { provider_message_id: event.provider_message_id } : {}"));
  assert(helper.includes("error.code === '23505'"));
});

Deno.test("void, delete and manual paid rows carry the invoice's own job", () => {
  const voided = blocksAround("source: 'ops-api/void_invoice'", 1200, 400)[0];
  assert(voided.includes(".select('invoice_number, total, status, job_id')"));
  assert(voided.includes("voidInvRecord?.job_id ? { job_id: voidInvRecord.job_id, match_method: 'direct_job_id' } : {}"));
  const paid = blocksAround("source: 'ops-api/mark_invoice_paid'", 1200, 400)[0];
  assert(paid.includes(".select('job_id, invoice_number, total')"));
  assert(paid.includes("inv.job_id ? { job_id: inv.job_id, match_method: 'direct_job_id' } : {}"));
});
