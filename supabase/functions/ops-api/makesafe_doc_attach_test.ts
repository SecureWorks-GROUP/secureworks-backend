// Tests for the M3 make-safe close-out doc-attach path (attachMakesafeDocument):
//   (a) typed attach keeps the type — invoice/makesafe_report/swms do NOT
//       downgrade to 'general' (the old uploadDocument/confirmDocumentUpload
//       whitelist bug); and
//   (b) idempotency — attaching the same type+file twice yields ONE row
//       (update + version bump, not a second insert).
//
// Uses the URL path (no pdf_base64) so the test never touches storage/createClient.
//
// Run: deno test --allow-all --no-check supabase/functions/ops-api/makesafe_doc_attach_test.ts
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { _attachMakesafeDocumentForTest } from "./index.ts";

// ── Chainable in-memory job_documents stub ──
// Stores rows in a shared array; supports the exact call shapes the function uses:
//   .from('job_documents').select(cols).eq().eq().eq().limit()  → { data, error }
//   .from('job_documents').insert(row).select('id').single()    → inserts + returns id
//   .from('job_documents').update(patch).eq('id', id)           → patches the row
//   .from('job_events').insert(row)                             → records the event
//   .from('business_events').insert(row)                        → swallowed by logBusinessEvent
type DB = { job_documents: any[]; job_events: any[]; business_events: any[] };

function makeDocClient(db: DB) {
  let idSeq = 1;
  function builder(table: string) {
    const preds: Array<(r: any) => boolean> = [];
    let pendingInsert: any = null;
    const rowsFor = () =>
      table === "job_documents"
        ? db.job_documents
        : table === "business_events"
        ? db.business_events
        : db.job_events;
    const b: any = {
      select: (_cols?: string) => b,
      eq: (col: string, val: any) => {
        preds.push((r) => r?.[col] === val);
        return b;
      },
      limit: (_n: number) => {
        const data = rowsFor().filter((r) => preds.every((p) => p(r)));
        return Promise.resolve({ data, error: null });
      },
      insert: (row: any) => {
        if (table === "job_documents") {
          pendingInsert = { id: `doc-${idSeq++}`, ...row };
          // .insert(...) may be terminal (job_events) OR chained .select().single()
          const chain: any = {
            select: (_c?: string) => ({
              single: () => {
                db.job_documents.push(pendingInsert);
                return Promise.resolve({ data: { id: pendingInsert.id }, error: null });
              },
            }),
            // terminal insert (no .select) — resolve when awaited
            then: (resolve: (v: any) => any) => {
              db.job_documents.push(pendingInsert);
              return resolve({ error: null });
            },
          };
          return chain;
        }
        // job_events / business_events: terminal insert
        rowsFor().push(row);
        return Promise.resolve({ error: null });
      },
      update: (patch: any) => ({
        eq: (col: string, val: any) => {
          const target = db.job_documents.find((r) => r?.[col] === val);
          if (target) Object.assign(target, patch);
          return Promise.resolve({ error: null });
        },
      }),
    };
    return b;
  }
  return { from: (table: string) => builder(table) };
}

const STORED_URL =
  "https://stub.invalid/storage/v1/object/public/job-documents/job-1/inv.pdf";

Deno.test("(a) attach type 'invoice' keeps the type (no downgrade to general)", async () => {
  const db: DB = { job_documents: [], job_events: [], business_events: [] };
  const client = makeDocClient(db);
  const res = await _attachMakesafeDocumentForTest(client, {
    job_id: "job-1",
    type: "invoice",
    url: STORED_URL,
    file_name: "inv.pdf",
  });
  assertEquals(res.success, true);
  assertEquals(res.type, "invoice");
  assertEquals(db.job_documents.length, 1);
  assertEquals(db.job_documents[0].type, "invoice"); // NOT 'general'
  // invoice defaults trades-hidden
  assertEquals(db.job_documents[0].visible_to_trades, false);
  // pdf_url set for PDFs
  assertEquals(db.job_documents[0].pdf_url, STORED_URL);
});

Deno.test("(a) attach type 'makesafe_report' keeps the type + defaults trade-visible", async () => {
  const db: DB = { job_documents: [], job_events: [], business_events: [] };
  const client = makeDocClient(db);
  const res = await _attachMakesafeDocumentForTest(client, {
    job_id: "job-1",
    type: "makesafe_report",
    url: STORED_URL,
    file_name: "report.pdf",
  });
  assertEquals(res.type, "makesafe_report");
  assertEquals(db.job_documents[0].type, "makesafe_report");
  assertEquals(db.job_documents[0].visible_to_trades, true);
});

Deno.test("(a) attach type 'swms' keeps the type + defaults trade-visible", async () => {
  const db: DB = { job_documents: [], job_events: [], business_events: [] };
  const client = makeDocClient(db);
  const res = await _attachMakesafeDocumentForTest(client, {
    job_id: "job-1",
    type: "swms",
    url: STORED_URL,
    file_name: "swms.pdf",
  });
  assertEquals(res.type, "swms");
  assertEquals(db.job_documents[0].type, "swms");
  assertEquals(db.job_documents[0].visible_to_trades, true);
});

Deno.test("(b) idempotent: same type+file attached twice → one row, version bumped", async () => {
  const db: DB = { job_documents: [], job_events: [], business_events: [] };
  const client = makeDocClient(db);

  const first = await _attachMakesafeDocumentForTest(client, {
    job_id: "job-1",
    type: "invoice",
    url: STORED_URL,
    file_name: "inv.pdf",
  });
  assertEquals(db.job_documents.length, 1);
  assertEquals(db.job_documents[0].version, 1);

  const second = await _attachMakesafeDocumentForTest(client, {
    job_id: "job-1",
    type: "invoice",
    url: STORED_URL + "?v2",
    file_name: "inv.pdf",
  });

  // Still ONE row (update, not a second insert)
  assertEquals(db.job_documents.length, 1);
  // Same document id returned
  assertEquals(second.document_id, first.document_id);
  // Version bumped, storage_url updated
  assertEquals(db.job_documents[0].version, 2);
  assertEquals(db.job_documents[0].storage_url, STORED_URL + "?v2");
});

Deno.test("rejects unknown type", async () => {
  const db: DB = { job_documents: [], job_events: [], business_events: [] };
  const client = makeDocClient(db);
  let threw = false;
  try {
    await _attachMakesafeDocumentForTest(client, {
      job_id: "job-1",
      type: "general",
      url: STORED_URL,
    });
  } catch (_e) {
    threw = true;
  }
  assert(threw, "expected attach to reject type 'general'");
});

Deno.test("writes a makesafe_document_attached job_event", async () => {
  const db: DB = { job_documents: [], job_events: [], business_events: [] };
  const client = makeDocClient(db);
  await _attachMakesafeDocumentForTest(client, {
    job_id: "job-1",
    type: "swms",
    url: STORED_URL,
    file_name: "swms.pdf",
  });
  assertEquals(db.job_events.length, 1);
  assertEquals(db.job_events[0].event_type, "makesafe_document_attached");
  assertEquals(db.job_events[0].detail_json.type, "swms");
});
