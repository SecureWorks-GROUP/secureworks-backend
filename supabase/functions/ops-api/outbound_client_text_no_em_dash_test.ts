// deno-lint-ignore-file no-explicit-any no-import-prefix
//
// Company rule: no em dashes in outbound client text. These tests pin the
// default wording of what ops-api sends a customer: the invoice email subject,
// the client message templates, and every default subject line in index.ts.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { _CLIENT_COMMS_TEMPLATES, _verifyAndSendInvoiceEmail } from "./index.ts";
import {
  happyFixture,
  makeBody,
  makeStubClient,
  makeStubFetch,
  makeStubGetToken,
  makeStubLogBusinessEvent,
  makeStubXeroGet,
  STUB_ENV,
} from "./_test_helpers.ts";

const DASHES = /[–—]|&mdash;|&ndash;|\\u201[34]/;

async function sentInvoiceEmail(body: Record<string, any>): Promise<any> {
  const fix = happyFixture();
  const { client } = makeStubClient(fix.seed);
  const { xeroGet } = makeStubXeroGet({ invoices: { "inv-123": fix.xeroInvoice } });
  const { fetch, calls } = makeStubFetch(fix.fetchRoutes);
  const { getToken } = makeStubGetToken();
  const { logBusinessEvent } = makeStubLogBusinessEvent();
  const resp = await _verifyAndSendInvoiceEmail({
    client,
    body: makeBody(body),
    getToken,
    xeroGet,
    logBusinessEvent,
    fetch,
    xeroFetch: fetch,
    env: STUB_ENV,
  });
  assertEquals(resp.status, 200);
  const outlook = calls.find((c) => c.url.includes("send-outlook-email"));
  assert(outlook, "the invoice email must reach send-outlook-email");
  return JSON.parse(outlook.init!.body as string);
}

Deno.test("customer invoice email: the default subject is 'Invoice <number> - SecureWorks Group', with a plain hyphen", async () => {
  const sent = await sentInvoiceEmail({});
  assertEquals(sent.subject, "Invoice INV-001 - SecureWorks Group");
  assert(!DASHES.test(sent.subject), sent.subject);
  assert(!DASHES.test(sent.htmlBody), sent.htmlBody);
});

Deno.test("customer invoice email: a subject the caller names is sent as given", async () => {
  // CONTROL: the default only fills an empty subject. It never rewrites one.
  const sent = await sentInvoiceEmail({ subject_override: "Your invoice INV-001" });
  assertEquals(sent.subject, "Your invoice INV-001");
});

Deno.test("client message templates carry no em dash or en dash", () => {
  const names = Object.keys(_CLIENT_COMMS_TEMPLATES);
  assert(names.length >= 10, "the template table must be read, not empty");
  for (const name of names) {
    const { template } = _CLIENT_COMMS_TEMPLATES[name];
    assert(!DASHES.test(template), `${name}: ${template}`);
  }
  // The four that carried one keep their meaning.
  assertEquals(
    _CLIENT_COMMS_TEMPLATES.payment_received.template,
    "Payment received, thank you! We'd love a Google review: {review_link}",
  );
  assert(_CLIENT_COMMS_TEMPLATES.follow_up_day3.template.includes("just checking in, have you had a chance"));
  assert(_CLIENT_COMMS_TEMPLATES.follow_up_day7.template.includes("miss out. This quote expires soon."));
  assert(_CLIENT_COMMS_TEMPLATES.deposit_reminder_day3.template.includes("just a reminder, your deposit invoice"));
});

Deno.test("no default subject line in ops-api index.ts carries an em dash", async () => {
  const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const lines = source.split("\n");
  // A line that sets a subject (subject: ..., const xSubject = ...), comments
  // aside. The scan must find the known subjects, or it proves nothing.
  const subjectLines = lines
    .map((text, i) => ({ text, line: i + 1 }))
    .filter(({ text }) => /subject\w*\s*[:=]\s*[`'"(\w]/i.test(text) && !/^\s*(\/\/|\*|\/\*)/.test(text));
  for (const wanted of [
    "subject: siSubj || `Invoice ${siNum} - SecureWorks Group`,",
    "subject: `Your Quote - ${job.job_number || 'SecureWorks Group'}`,",
    "const updateSubject = `${job.job_number} - Update from SecureWorks`",
    "const variationSubject = `Variation #${variation.variation_number} for ${job.job_number} - ${job.site_address || 'your project'}`",
  ]) {
    assert(subjectLines.some(({ text }) => text.includes(wanted)), `subject scan missed: ${wanted}`);
  }
  const offenders = subjectLines.filter(({ text }) => DASHES.test(text.replace(/\/\/.*$/, "")));
  assertEquals(offenders.map((o) => `${o.line}: ${o.text.trim()}`), []);
  // The client email and SMS footers name the business with a plain hyphen.
  assert(!/SecureWorks Group — Patios/.test(source));
  assertEquals(source.split("SecureWorks Group - Patios | Fencing | Decking | Screening").length - 1, 3);
});
