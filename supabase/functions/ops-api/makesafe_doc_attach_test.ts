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
import {
  _attachMakesafeDocumentForTest,
  _setMakesafeDocumentStorageAdminForTest,
} from "./index.ts";

// ── Chainable in-memory job_documents stub ──
// Stores rows in a shared array; supports the exact call shapes the function uses:
//   .from('job_documents').select(cols).eq().eq().eq().limit()  → { data, error }
//   .from('job_documents').insert(row).select('id').single()    → inserts + returns id
//   .from('job_documents').update(patch).eq('id', id)           → patches the row
//   .from('job_events').insert(row)                             → records the event
//   .from('business_events').insert(row)                        → swallowed by logBusinessEvent
//   .from('makesafe_job_details').select().eq().maybeSingle()   → null (normal job, no report_type)
type DB = { job_documents: any[]; job_events: any[]; business_events: any[] };

function makeDocClient(
  db: DB,
  opts?: { reportType?: string | null; selectBarrierCount?: number },
) {
  let idSeq = 1;
  let blockedSelects = 0;
  let releaseBlockedSelect: (() => void) | null = null;
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
      is: (col: string, val: any) => {
        preds.push((r) => val === null ? r?.[col] == null : r?.[col] === val);
        return b;
      },
      limit: (_n: number) => {
        const read = () => ({
          data: rowsFor().filter((r) => preds.every((p) => p(r))),
          error: null,
        });
        if (table === "job_documents" && opts?.selectBarrierCount) {
          blockedSelects += 1;
          if (blockedSelects < opts.selectBarrierCount) {
            return new Promise((resolve) => {
              releaseBlockedSelect = () => resolve(read());
            });
          }
          const result = read();
          releaseBlockedSelect?.();
          releaseBlockedSelect = null;
          return Promise.resolve(result);
        }
        return Promise.resolve(read());
      },
      // maybeSingle: used by the FIX-4 report-type gate on makesafe_job_details.
      // Returns a row with report_type set (when opts.reportType is non-null) or null.
      maybeSingle: () => {
        if (table === "makesafe_job_details") {
          const rt = opts?.reportType ?? null;
          return Promise.resolve({
            data: rt != null ? { report_type: rt } : null,
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      },
      insert: (row: any) => {
        if (table === "job_documents") {
          pendingInsert = { id: `doc-${idSeq++}`, ...row };
          // .insert(...) may be terminal (job_events) OR chained .select().single()
          const chain: any = {
            select: (_c?: string) => ({
              single: () => {
                const duplicate = db.job_documents.find((r) =>
                  r.superseded_at == null &&
                  pendingInsert.superseded_at == null &&
                  r.job_id === pendingInsert.job_id &&
                  r.type === pendingInsert.type &&
                  r.file_name === pendingInsert.file_name
                );
                if (duplicate) {
                  return Promise.resolve({
                    data: null,
                    error: {
                      code: "23505",
                      message:
                        'duplicate key value violates unique constraint "ux_job_documents_makesafe_attach_key"',
                    },
                  });
                }
                db.job_documents.push(pendingInsert);
                return Promise.resolve({
                  data: { id: pendingInsert.id },
                  error: null,
                });
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

Deno.test("(a) attach type 'roof_report' keeps the type + defaults trade-visible", async () => {
  const db: DB = { job_documents: [], job_events: [], business_events: [] };
  const client = makeDocClient(db);
  const res = await _attachMakesafeDocumentForTest(client, {
    job_id: "job-1",
    type: "roof_report",
    url: STORED_URL,
    file_name: "roof-report.pdf",
  });
  assertEquals(res.type, "roof_report");
  assertEquals(db.job_documents[0].type, "roof_report");
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

Deno.test("superseded attach rows do not block a new active document", async () => {
  const db: DB = {
    job_documents: [{
      id: "superseded-doc",
      job_id: "job-1",
      type: "invoice",
      file_name: "inv.pdf",
      version: 1,
      superseded_at: "2026-08-20T00:00:00Z",
    }],
    job_events: [],
    business_events: [],
  };
  const client = makeDocClient(db);

  const result = await _attachMakesafeDocumentForTest(client, {
    job_id: "job-1",
    type: "invoice",
    url: STORED_URL + "?replacement",
    file_name: "inv.pdf",
  });

  assertEquals(db.job_documents.length, 2);
  assert(result.document_id !== "superseded-doc");
  assertEquals(
    db.job_documents.filter((row) => row.superseded_at == null).length,
    1,
  );
});

Deno.test("pdf_base64 attach uploads to the provisioned bucket without creating it", async () => {
  const db: DB = { job_documents: [], job_events: [], business_events: [] };
  const client = makeDocClient(db);
  let createBucketCalls = 0;
  let uploadedPath = "";
  _setMakesafeDocumentStorageAdminForTest(() => ({
    storage: {
      createBucket: async () => {
        createBucketCalls += 1;
        return { data: null, error: null };
      },
      from: (_bucket: string) => ({
        upload: async (path: string, _bytes: Uint8Array, _opts: any) => {
          uploadedPath = path;
          return { data: { path }, error: null };
        },
        getPublicUrl: (path: string) => ({
          data: {
            publicUrl:
              `https://stub.invalid/storage/v1/object/public/job-documents/${path}`,
          },
        }),
      }),
    },
  }));
  try {
    const result = await _attachMakesafeDocumentForTest(client, {
      job_id: "job-1",
      type: "makesafe_report",
      pdf_base64: btoa("%PDF-1.4\n"),
      file_name: "report.pdf",
    });
    assertEquals(result.success, true);
    assertEquals(createBucketCalls, 0);
    assertEquals(uploadedPath, "job-1/report.pdf");
    assertEquals(db.job_documents.length, 1);
  } finally {
    _setMakesafeDocumentStorageAdminForTest(null);
  }
});

Deno.test("concurrent retry of the same attach key converges on one active row", async () => {
  const db: DB = { job_documents: [], job_events: [], business_events: [] };
  const client = makeDocClient(db, { selectBarrierCount: 2 });

  const [first, second] = await Promise.all([
    _attachMakesafeDocumentForTest(client, {
      job_id: "job-1",
      type: "invoice",
      url: STORED_URL,
      file_name: "retry.pdf",
    }),
    _attachMakesafeDocumentForTest(client, {
      job_id: "job-1",
      type: "invoice",
      url: STORED_URL + "?retry",
      file_name: "retry.pdf",
    }),
  ]);

  assertEquals(db.job_documents.length, 1);
  assertEquals(first.document_id, second.document_id);
  assertEquals(db.job_documents[0].version, 2);
});

Deno.test("migration owns the active MakeSafe attach key without rewriting document history", async () => {
  const sql = await Deno.readTextFile(
    new URL(
      "../../migrations/20260821093825_makesafe_attach_document_idempotency.sql",
      import.meta.url,
    ),
  );

  assert(
    sql.includes(
      "CREATE UNIQUE INDEX IF NOT EXISTS ux_job_documents_makesafe_attach_key",
    ),
  );
  assert(sql.includes("ON public.job_documents (job_id, type, file_name)"));
  assert(sql.includes("AND superseded_at IS NULL"));
  assert(!/\bUPDATE\s+public\.job_documents\b/i.test(sql));
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

// ── FIX 4: makesafe_report blocked on report-type jobs ──────────────────────
//
// A report-type job (report_type IS NOT NULL) must never receive a type='makesafe_report'
// document — the completion report lives on the builder portal, not the job folder.
// Other types (invoice, work_order, swms) on report jobs are unaffected.

Deno.test("FIX 4 — attaching makesafe_report to a report-type job is REFUSED", async () => {
  const db: DB = { job_documents: [], job_events: [], business_events: [] };
  // Pass reportType so the stub returns a non-null report_type for makesafe_job_details.
  const client = makeDocClient(db, { reportType: "ajs_builder_report" });
  let threw = false;
  let errMsg = "";
  try {
    await _attachMakesafeDocumentForTest(client, {
      job_id: "job-report-1",
      type: "makesafe_report",
      url: STORED_URL,
      file_name: "report.pdf",
    });
  } catch (e: any) {
    threw = true;
    errMsg = e?.message || "";
  }
  assert(
    threw,
    "expected attach to refuse makesafe_report on a report-type job",
  );
  assert(
    errMsg.includes("builder portal"),
    "error must mention the builder portal",
  );
  // No doc row must have been inserted.
  assertEquals(db.job_documents.length, 0);
});

Deno.test("FIX 4 — attaching makesafe_report to a NORMAL job (no report_type) is ALLOWED", async () => {
  const db: DB = { job_documents: [], job_events: [], business_events: [] };
  // No reportType → stub returns null → normal job path.
  const client = makeDocClient(db);
  const res = await _attachMakesafeDocumentForTest(client, {
    job_id: "job-normal-1",
    type: "makesafe_report",
    url: STORED_URL,
    file_name: "report.pdf",
  });
  assertEquals(res.success, true);
  assertEquals(db.job_documents.length, 1);
  assertEquals(db.job_documents[0].type, "makesafe_report");
});

Deno.test("FIX 4 — attaching 'invoice' to a report-type job is still ALLOWED (other types unaffected)", async () => {
  const db: DB = { job_documents: [], job_events: [], business_events: [] };
  const client = makeDocClient(db, { reportType: "ajs_builder_report" });
  const res = await _attachMakesafeDocumentForTest(client, {
    job_id: "job-report-1",
    type: "invoice",
    url: STORED_URL,
    file_name: "inv.pdf",
  });
  assertEquals(res.success, true);
  assertEquals(db.job_documents.length, 1);
  assertEquals(db.job_documents[0].type, "invoice");
});

Deno.test("FIX 4 — attaching 'swms' to a report-type job is still ALLOWED", async () => {
  const db: DB = { job_documents: [], job_events: [], business_events: [] };
  const client = makeDocClient(db, { reportType: "mlb_report" });
  const res = await _attachMakesafeDocumentForTest(client, {
    job_id: "job-report-1",
    type: "swms",
    url: STORED_URL,
    file_name: "swms.pdf",
  });
  assertEquals(res.success, true);
  assertEquals(db.job_documents.length, 1);
});

Deno.test("FIX 4 — attaching 'work_order' to a report-type job is still ALLOWED", async () => {
  const db: DB = { job_documents: [], job_events: [], business_events: [] };
  const client = makeDocClient(db, { reportType: "ajs_builder_report" });
  const res = await _attachMakesafeDocumentForTest(client, {
    job_id: "job-report-1",
    type: "work_order",
    url: STORED_URL,
    file_name: "wo.pdf",
  });
  assertEquals(res.success, true);
  assertEquals(db.job_documents.length, 1);
});

// ── G1 (2026-08-03): roof_report is DELIBERATELY exempt from the report-type
// gate — generating our own letterhead report is the whole point of the
// roof-report flow. The edge function has always allowed it; the database
// constraint had not (fixed by migration
// 20260803060000_job_documents_roof_report_type.sql). Pin the exemption at
// the edge-function layer: a roof_report attach on a report-type job must
// NOT be refused the way makesafe_report is.

Deno.test("G1 — attaching 'roof_report' to a report-type job is ALLOWED (deliberate exemption)", async () => {
  const db: DB = { job_documents: [], job_events: [], business_events: [] };
  // report_type='roof_report': the exact own-letterhead roof-report card shape.
  const client = makeDocClient(db, { reportType: "roof_report" });
  const res = await _attachMakesafeDocumentForTest(client, {
    job_id: "job-roof-1",
    type: "roof_report",
    url: STORED_URL,
    file_name: "roof-report.pdf",
  });
  assertEquals(res.success, true);
  assertEquals(db.job_documents.length, 1);
  assertEquals(db.job_documents[0].type, "roof_report");
});
