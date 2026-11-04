// B1 (Scope Engine finish line): a quote send updates GHL, and the job system records that update.
// The quote send logs its email as a note on the customer's GHL contact through ghl-proxy add_note.
// ghl-proxy records a ghl_note_added job event only when the request names the job (jobId). The send
// named no job, so no quote send ever left a GHL record on the job, and B1 could not count one.
// The note now names the job and goes after the send is recorded (quote_revisions.sent_at), so the job
// event lands after the send it belongs to.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { ghlEmailNoteRequest, quoteSentGhl, quoteSentNoteBody, quoteSentStageId, revisionLabelFromSealed } from "./ghl_email_note.ts";

const SEND_QUOTE = new URL("./index.ts", import.meta.url);
const GHL_PROXY = new URL("../ghl-proxy/index.ts", import.meta.url);

Deno.test("the note names the job, so ghl-proxy records it on the job", () => {
  const req = ghlEmailNoteRequest({ contactId: "c1", jobId: "j1", subject: "Your quote", recipient: "a@b.test" });
  assertEquals(req, { contactId: "c1", jobId: "j1", body: 'Email sent: "Your quote" to a@b.test' });
});

Deno.test("no GHL contact: no note", () => {
  assertEquals(ghlEmailNoteRequest({ contactId: null, jobId: "j1", subject: "s", recipient: "r" }), null);
  assertEquals(ghlEmailNoteRequest({ contactId: "", jobId: "j1", subject: "s", recipient: "r" }), null);
});

Deno.test("no job named: the note still goes, without a job record (council and invoice emails, unchanged)", () => {
  assertEquals(ghlEmailNoteRequest({ contactId: "c1", subject: "s", recipient: "r" }), { contactId: "c1", body: 'Email sent: "s" to r' });
});

Deno.test("ghl-proxy add_note records ghl_note_added only when the request names the job", async () => {
  const src = await Deno.readTextFile(GHL_PROXY);
  const start = src.indexOf("if (action === 'add_note'");
  assert(start > 0, "add_note handler found");
  const handler = src.slice(start, start + 1500);
  assert(/const \{ contactId, body: noteBody, jobId \} = body/.test(handler), "add_note reads jobId");
  assert(/if \(jobId\) \{[\s\S]*event_type: 'ghl_note_added'/.test(handler), "ghl_note_added is written when jobId is given");
});

Deno.test("the quote send's GHL note names the job and goes after the send is recorded", async () => {
  const src = await Deno.readTextFile(SEND_QUOTE);
  const call = "await recordQuoteSentOnGhl({";
  const at = src.indexOf(call);
  assert(at > 0, "the quote send tells GHL after the email");
  assertEquals(src.indexOf(call, at + 1), -1, "one quote-sent GHL tell");
  const released = src.indexOf("releasedRevisionId = await recordReleasedQuoteRevision(");
  assert(released > 0 && at > released, "the note goes after the released quote revision (sent_at) is recorded");
  assertEquals(src.indexOf("logEmailToGHL(doc.jobs?.ghl_contact_id, emailSubject, client_email, doc.job_id)"), -1, "the quote send no longer uses the subject-only note");
  assert(src.includes("quoteNumber: doc.quote_number"), "the note is given the quote number");
  assert(src.includes("revisionLabelFromSealed("), "the note is given the revision");
  assert(src.includes("opportunityId: doc.jobs?.ghl_opportunity_id"), "the stage move is given the opportunity");
  assert(src.includes("if (!SW_API_KEY) return"), "no API key posts nothing");
});

Deno.test("a sent quote note names the quote and the revision and carries no price", () => {
  assertEquals(quoteSentNoteBody({ quoteNumber: "Q-1", revisionLabel: "Rev 2" }), "Quote Q-1 Rev 2 sent.");
  assertEquals(quoteSentNoteBody({ quoteNumber: "Q-1" }), "Quote Q-1 sent.");
  assert(!quoteSentNoteBody({ quoteNumber: "Q-1", revisionLabel: "Rev 2" }).includes("$"));
});

Deno.test("the stage is the trade's existing Quote Sent stage, and a missing link posts nothing", () => {
  assertEquals(quoteSentStageId("patio"), "d2fb3af7-91e5-4317-b778-2be117341f07");
  assertEquals(quoteSentStageId("fencing"), "02476ea1-6ef4-4b73-80fa-7d685c016bf7");
  assertEquals(quoteSentStageId("shed"), null);
  const full = quoteSentGhl({
    contactId: "c1", jobId: "j1", opportunityId: "opp", jobType: "patio", quoteNumber: "Q-1", revisionLabel: "Rev 2",
  });
  assertEquals(full.note, { contactId: "c1", jobId: "j1", body: "Quote Q-1 Rev 2 sent." });
  assertEquals(full.stage, { opportunityId: "opp", stageId: "d2fb3af7-91e5-4317-b778-2be117341f07", jobId: "j1" });
  assertEquals(quoteSentGhl({ contactId: null, opportunityId: null, jobType: "patio", quoteNumber: "Q-1" }), { note: null, stage: null });
  assertEquals(quoteSentGhl({ contactId: "c1", opportunityId: "opp", jobType: "shed", quoteNumber: "Q-1" }).stage, null);
});

Deno.test("Rev N is read from the sealed scope, not from a price", () => {
  assertEquals(revisionLabelFromSealed({ identity: { revision: { n: 2 } } }, { totalIncGST: 10 }), "Rev 2");
  assertEquals(revisionLabelFromSealed(null, null), null);
});

Deno.test("planted fault: the request as it stood names no job, so ghl-proxy would record nothing", () => {
  const asItStood = (contactId: string, subject: string, recipient: string) => ({ contactId, body: `Email sent: "${subject}" to ${recipient}` });
  const req: Record<string, unknown> = asItStood("c1", "s", "r");
  assertEquals("jobId" in req, false);
  const fixed = ghlEmailNoteRequest({ contactId: "c1", jobId: "j1", subject: "s", recipient: "r" }) as Record<string, unknown>;
  assertEquals(fixed.jobId, "j1");
});
