// deno-lint-ignore-file no-import-prefix
// Context cadence slice K3 (cadence design §9.C): invoice status evidence rows.
//
// The named rows are the four writers §9.C names:
//   1. approve_invoice            -> invoice.authorised
//   2. approve_and_send_invoice   -> invoice.authorised
//   3. makesafe_send_pack         -> invoice.authorised
//   4. send_invoice_email (Outlook path, _verifyAndSendInvoiceEmail) -> invoice.emailed
//
// What each must prove:
//   - a known job id is kept as direct custody (match_method 'direct_job_id'),
//     so the attribution ladder's rule A does not strip it;
//   - the words the ladder reads are digit-free, so ladder step 1 (job, invoice
//     and PO numbers anywhere in the words) can never mis-link the row;
//   - the invoice number stays in payload, and no address reaches the words;
//   - the authorised insert stays unconditional (straight to business_events,
//     never behind the capture lane) and never throws.
//
// No network, no live Supabase, no Xero.

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { INVOICE_EMAILED_BODY_PREVIEW, writeInvoiceAuthorisedEvidence } from "./invoice_status_evidence.ts";
import { _verifyAndSendInvoiceEmail } from "./index.ts";
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

// The words the ladder reads: public.context_event_text
// (migrations/20260911171000_context_capture_attribution.sql). Payload keys
// first, body_preview last.
const CONTEXT_TEXT_PAYLOAD_KEYS = [
  "body",
  "message_text",
  "text",
  "note_text",
  "note",
  "transcript",
];
type Row = Record<string, unknown>;
function contextEventText(row: Row): string {
  const payload = (row.payload || {}) as Row;
  for (const key of CONTEXT_TEXT_PAYLOAD_KEYS) {
    if (typeof payload[key] === "string" && payload[key] !== "") {
      return payload[key];
    }
  }
  return String(row.body_preview ?? "");
}

// Ladder step 1 token rule: ' ' || upper(regexp_replace(words,'[^a-zA-Z0-9-]+',' ','g')) || ' '
// contains ' ' || upper(<number>) || ' '.
function stepOneMatches(words: string, reference: string): boolean {
  const haystack = " " + words.replace(/[^a-zA-Z0-9-]+/g, " ").toUpperCase() +
    " ";
  return haystack.includes(" " + reference.toUpperCase() + " ");
}

// Real references named in the cadence design (R18: INV-1477 on SWP-261247)
// plus the shapes step 1 matches: our job numbers, ACCREC invoice numbers, POs.
const REFERENCES = ["INV-1477", "SWP-261247", "SWF-261463", "PO-1001", "1477"];

const JOB_ID = "ace953b5-0000-4000-8000-000000000001";

// ── The writer all three authorised sites call. ──
// A client that records every table it is asked for. Any read other than the
// business_events insert (for example the capture lane in automation_switches)
// fails the test, which is what "unconditional" means here.
function recordingClient(
  insertResult: () => Promise<{ error: { message: string } | null }>,
) {
  const tables: string[] = [];
  const rows: Row[] = [];
  const client = {
    from(table: string) {
      tables.push(table);
      if (table !== "business_events") {
        throw new Error(`unexpected table read: ${table}`);
      }
      return {
        insert(row: Row) {
          rows.push(row);
          return insertResult();
        },
      };
    },
  };
  return { client, tables, rows };
}

Deno.test("K3 write: a returned PostgREST error is reported, never thrown", async () => {
  const { client, rows } = recordingClient(() =>
    Promise.resolve({ error: { message: "insert rejected" } })
  );
  const written = await writeInvoiceAuthorisedEvidence(client, {
    source: "ops-api/approve_invoice",
    xeroInvoiceId: "x",
    jobId: JOB_ID,
    payload: {},
    operator: null,
  });
  assertEquals(written, false);
  assertEquals(rows.length, 1);
});

Deno.test("K3 write: a thrown transport fault is reported, never thrown", async () => {
  const { client } = recordingClient(() =>
    Promise.reject(new Error("network down"))
  );
  const written = await writeInvoiceAuthorisedEvidence(client, {
    source: "ops-api/makesafe_send_pack",
    xeroInvoiceId: "x",
    jobId: JOB_ID,
    payload: {},
    operator: null,
  });
  assertEquals(written, false);
});

// ── invoice.emailed through the real Outlook send path. ──
// Only linked invoices reach this writer: the shared money fence refuses an
// unlinked ACCREC send before any audit row (index_test.ts T7).
Deno.test("K3 emailed (linked): digit-free words, no address, number kept in payload", async () => {
  const fix = happyFixture();
  const seed = structuredClone(fix.seed);
  seed.xero_invoices["inv-123"].invoice_number = "INV-1477";
  const { client } = makeStubClient(seed);
  const { xeroGet } = makeStubXeroGet({
    invoices: { "inv-123": fix.xeroInvoice },
  });
  const { fetch } = makeStubFetch(fix.fetchRoutes);
  const { getToken } = makeStubGetToken();
  const { logBusinessEvent, events } = makeStubLogBusinessEvent();
  const resp = await _verifyAndSendInvoiceEmail({
    client,
    body: makeBody(),
    getToken,
    xeroGet,
    logBusinessEvent,
    fetch,
    xeroFetch: fetch,
    env: STUB_ENV,
  });

  assertEquals(resp.status, 200);
  assertEquals(events.length, 1);
  const ev = events[0];
  assertEquals(ev.event_type, "invoice.emailed");
  assertEquals(ev.body_preview, INVOICE_EMAILED_BODY_PREVIEW);
  // Job id comes from the invoice link; logBusinessEvent stamps direct custody for it.
  assertEquals(ev.job_id, "job-uuid-1");

  const words = contextEventText(ev);
  assertEquals(words, INVOICE_EMAILED_BODY_PREVIEW);
  assert(!/\d/.test(words), "emailed words must be digit-free");
  assert(!words.includes("@"), "emailed words must carry no address");
  for (const ref of REFERENCES) {
    assert(
      !stepOneMatches(words, ref),
      `step 1 must not match ${ref} in the words`,
    );
  }
  assertEquals(ev.payload.invoice_number, "INV-1477");
  assertEquals(ev.payload.to, "client@example.com");
});
