// deno-lint-ignore-file no-import-prefix no-explicit-any
// Dispatch v2 Tweak 1, part 2: the supplier's PDFs saved to the job once an
// order is confirmed (dispatch_v2_order_documents.ts; contract
// docs/dispatch-v2-board-contract.md, section 3e.2), against the in-memory
// PostgREST and Storage stand-in in dispatch_v2_order_confirmed_test_fakes.ts.
//
// Nothing is sent and nothing touches production. Job, client and supplier
// details are made up; the PDFs are tiny made-up files.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  dispatchDocStoragePath,
  dispatchSupplierDocumentKind,
  dispatchSupplierDocumentName,
  hasPdfMagic,
  isDispatchPdfCandidate,
  saveDispatchSupplierDocuments,
  sha256HexOf,
  sweepDispatchV2OrderDocuments,
} from "./dispatch_v2_order_documents.ts";
import {
  type DispatchOrderConfirmedDeps,
  runDispatchV2OrderConfirmed,
} from "./dispatch_v2_order_confirmed_write.ts";
import {
  FAKE_STORAGE_URL,
  makeFakeClient,
  type Row,
} from "./dispatch_v2_order_confirmed_test_fakes.ts";

const ORG = "00000000-0000-0000-0000-000000000001";
const JOB = "a1000000-0000-4000-8000-000000000001";
const SUP = "b1000000-0000-4000-8000-000000000001";
const ORDER = "e1000000-0000-4000-8000-000000000001";
const OTHER_ORDER = "e1000000-0000-4000-8000-000000000002";
const NOW = "2026-11-03T02:00:00.000Z";
const CAPTURE = "context-email-attachments";

const enc = new TextEncoder();
function pdf(label: string): Uint8Array {
  return enc.encode(`%PDF-1.4\n% ${label}\n1 0 obj << >> endobj\n%%EOF\n`);
}

// ── Rules ───────────────────────────────────────────────────────────────────

Deno.test("kind: file name, then subject, then first words; earliest word wins", () => {
  assertEquals(
    dispatchSupplierDocumentKind({ fileName: "PROFORMA TAX INVOICE - 118426.pdf" }),
    "invoice",
  );
  assertEquals(
    dispatchSupplierDocumentKind({ fileName: "Stratco-Estimate-TB-WA-20261103-046.pdf" }),
    "quote",
  );
  assertEquals(
    dispatchSupplierDocumentKind({
      fileName: "SWP-90001.pdf",
      subject: "RE: Material Order Ref SWP-90001",
      snippet: "Hi Shaun, Please see attached order confirmation- pickup from Neerabup 03/11.",
    }),
    "order_confirmation",
  );
  assertEquals(
    dispatchSupplierDocumentKind({ fileName: "2882092_1.pdf", subject: "Stratco Invoice 2882092." }),
    "invoice",
  );
  assertEquals(
    dispatchSupplierDocumentKind({
      fileName: "doc.pdf",
      subject: "Metroll confirmation SO#1059031 ETA Delivery 05/11/2026",
    }),
    "order_confirmation",
  );
  // "Quote 123 confirmation": quote comes first.
  assertEquals(dispatchSupplierDocumentKind({ subject: "Quote 123 confirmation" }), "quote");
  assertEquals(
    dispatchSupplierDocumentKind({ fileName: "scan0001.pdf", subject: "Re: your order", snippet: "See attached" }),
    "order_document",
  );
});

Deno.test("name: for what it is, never 'work order'", () => {
  assertEquals(dispatchSupplierDocumentName("Stratco", "order_confirmation"), "Stratco order confirmation");
  assertEquals(dispatchSupplierDocumentName("B&D", "invoice"), "B&D invoice");
  assertEquals(dispatchSupplierDocumentName("R&R", "quote"), "R&R quote");
  assertEquals(dispatchSupplierDocumentName("Metroll", "order_document"), "Metroll order document");
  assertEquals(dispatchSupplierDocumentName(null, "invoice"), "Supplier invoice");
  // The trade app's priced work order lock (trade.html isPricedWorkOrderDocument).
  const lock = /work[\s_-]*order|\bwo\b/i;
  for (const kind of ["order_confirmation", "invoice", "quote", "order_document"] as const) {
    const name = dispatchSupplierDocumentName("Stratco", kind);
    const path = dispatchDocStoragePath(JOB, "a".repeat(64), name);
    assertEquals(lock.test(`${name}.pdf ${FAKE_STORAGE_URL}/job-documents/${path}`), false);
  }
});

Deno.test("pdf: PDFs by type or by name with a generic type; bytes checked", () => {
  assertEquals(isDispatchPdfCandidate({ file_name: "a.pdf", content_type: "application/pdf" }), true);
  assertEquals(isDispatchPdfCandidate({ file_name: "2880765_1.pdf", content_type: "application/octet-stream" }), true);
  assertEquals(isDispatchPdfCandidate({ file_name: "image002.png", content_type: "image/png" }), false);
  assertEquals(isDispatchPdfCandidate({ file_name: "logo.pdf", content_type: "image/png" }), false);
  assertEquals(isDispatchPdfCandidate({ file_name: "quote.xlsx", content_type: "application/octet-stream" }), false);
  assertEquals(hasPdfMagic(pdf("x")), true);
  assertEquals(hasPdfMagic(enc.encode("GIF89a")), false);
});

// ── Saving ──────────────────────────────────────────────────────────────────

type Fixture = {
  tables: Record<string, Row[]>;
  objects: Map<string, Uint8Array>;
  shas: Record<string, string>;
};

async function fixture(): Promise<Fixture> {
  const files = {
    confirmation: pdf("stratco confirmation"),
    invoice: pdf("stratco invoice"),
    statement: pdf("statement"),
  };
  const shas: Record<string, string> = {};
  for (const [k, v] of Object.entries(files)) shas[k] = await sha256HexOf(v);
  const objects = new Map<string, Uint8Array>([
    [`${CAPTURE}/m1/SWP-90001.pdf`, files.confirmation],
    [`${CAPTURE}/m3/2882092_1.pdf`, files.invoice],
    [`${CAPTURE}/m4/statement.pdf`, files.statement],
  ]);
  const reply = (id: string, msg: string, extra: Row) => ({
    id,
    org_id: ORG,
    order_id: ORDER,
    job_id: JOB,
    state: "matched",
    provider_message_id: msg,
    subject: "",
    snippet: "",
    received_at: "2026-11-01T03:00:00Z",
    updated_at: "2026-11-01T03:00:00Z",
    ...extra,
  });
  const att = (id: string, msg: string, extra: Row) => ({
    id,
    provider_message_id: msg,
    file_name: null,
    content_type: "application/pdf",
    sha256: null,
    storage_bucket: CAPTURE,
    storage_path: null,
    status: "stored",
    ...extra,
  });
  return {
    shas,
    objects,
    tables: {
      dispatch_supplier_order_emails: [{
        id: ORDER,
        org_id: ORG,
        job_id: JOB,
        supplier_id: SUP,
        supplier_name: "Stratco",
        status: "sent",
        sent_at: "2026-11-01T01:00:00Z",
        delivery_date: "2026-11-03",
        body_text: "Hi Team, could we please order the following for pickup from Neerabup:\n\nDate: 3 November 2026",
      }],
      job_material_suppliers: [],
      dispatch_v2_supplier_emails: [
        reply("r1", "email:m1", {
          subject: "RE: Material Order Ref SWP-90001",
          snippet: "Please see attached order confirmation- pickup from Neerabup 03/11.",
          received_at: "2026-11-01T03:00:00Z",
        }),
        // The same confirmation forwarded again: the same file.
        reply("r2", "email:m2", { subject: "FW: order", received_at: "2026-11-01T04:00:00Z" }),
        // A statement guessed at, waiting for a person: never saved.
        reply("r4", "email:m4", {
          state: "needs_confirmation",
          subject: "Statement",
          received_at: "2026-11-01T05:00:00Z",
        }),
      ],
      context_email_attachments: [
        att("a1", "email:m1", {
          file_name: "SWP-90001.pdf",
          sha256: shas.confirmation,
          storage_path: "m1/SWP-90001.pdf",
        }),
        // The signature logo the old poller used to save: not a PDF.
        att("a1i", "email:m1", {
          file_name: "image002.gif",
          content_type: "image/gif",
          status: "skipped_inline",
          storage_bucket: null,
        }),
        att("a2", "email:m2", {
          file_name: "SWP-90001.pdf",
          sha256: shas.confirmation,
          status: "skipped_duplicate",
          storage_bucket: null,
        }),
        att("a4", "email:m4", {
          file_name: "statement.pdf",
          sha256: shas.statement,
          storage_path: "m4/statement.pdf",
        }),
      ],
      dispatch_v2_order_documents: [],
      dispatch_v2_order_crew_lines: [],
      dispatch_v2_supplier_order_refs: [],
      job_documents: [],
      job_events: [],
    },
  };
}

const UNIQUE = {
  dispatch_v2_order_documents: [["job_id", "content_sha256"]],
  dispatch_v2_order_crew_lines: [["order_id", "seq"]],
};

async function setup(extra: Parameters<typeof makeFakeClient>[1] = {}) {
  const f = await fixture();
  const fake = makeFakeClient(f.tables, { unique: UNIQUE, objects: f.objects, ...extra });
  return { ...fake, shas: f.shas };
}

const save = (client: any, now = NOW) =>
  saveDispatchSupplierDocuments(client, {
    orgId: ORG,
    order: {
      id: ORDER,
      job_id: JOB,
      supplier_id: SUP,
      supplier_name: "Stratco",
    },
    trigger: "stage_set",
    now,
  });

Deno.test("save: the matched reply's PDF goes on the job once, crew-visible, named for what it is", async () => {
  const t = await setup();
  const r = await save(t.client);
  assertEquals(r.read, "ok");
  assertEquals(r.found, 1);
  assertEquals(r.saved.map((s) => s.name), ["Stratco order confirmation.pdf"]);
  const [doc] = t.tables.job_documents;
  const path = `${JOB}/dispatch-orders/${t.shas.confirmation.slice(0, 16)}-Stratco-order-confirmation.pdf`;
  assertEquals(
    [doc.job_id, doc.type, doc.file_name, doc.visible_to_trades, doc.pdf_url, doc.storage_url],
    [
      JOB,
      "material_order",
      "Stratco order confirmation.pdf",
      true,
      `${FAKE_STORAGE_URL}/job-documents/${path}`,
      `${FAKE_STORAGE_URL}/job-documents/${path}`,
    ],
  );
  assertEquals(doc.metadata.content_sha256, t.shas.confirmation);
  assertEquals(doc.metadata.order_id, ORDER);
  // The bytes are the supplier's own file.
  assertEquals(t.objects.get(`job-documents/${path}`), t.objects.get(`${CAPTURE}/m1/SWP-90001.pdf`));
  assertEquals(t.uploads.map((u) => u.contentType), ["application/pdf"]);
  const [ledger] = t.tables.dispatch_v2_order_documents;
  assertEquals([ledger.state, ledger.job_document_id, ledger.kind], ["saved", doc.id, "order_confirmation"]);
  assertEquals(t.tables.job_events.map((e) => e.event_type), ["dispatch_v2_order_document_saved"]);

  // Run again (the sweep, or a second press): nothing new.
  const again = await save(t.client);
  assertEquals(again.saved, []);
  assertEquals(again.skipped.map((s) => s.reason), ["already_saved"]);
  assertEquals(t.tables.job_documents.length, 1);
});

Deno.test("save: a later invoice is saved too; the statement guess never is", async () => {
  const t = await setup();
  await save(t.client);
  t.tables.dispatch_v2_supplier_emails.push({
    id: "r3",
    org_id: ORG,
    order_id: ORDER,
    job_id: JOB,
    state: "matched",
    provider_message_id: "email:m3",
    subject: "Stratco Invoice 2882092.",
    snippet: "",
    received_at: "2026-11-02T03:00:00Z",
    updated_at: "2026-11-02T03:00:00Z",
  });
  t.tables.context_email_attachments.push({
    id: "a3",
    provider_message_id: "email:m3",
    file_name: "2882092_1.pdf",
    content_type: "application/octet-stream",
    sha256: t.shas.invoice,
    storage_bucket: CAPTURE,
    storage_path: "m3/2882092_1.pdf",
    status: "stored",
  });
  const r = await save(t.client);
  assertEquals(r.saved.map((s) => s.name), ["Stratco invoice.pdf"]);
  assertEquals(t.tables.job_documents.map((d) => d.file_name), [
    "Stratco order confirmation.pdf",
    "Stratco invoice.pdf",
  ]);
  assertEquals(
    t.tables.dispatch_v2_order_documents.some((d) => d.content_sha256 === t.shas.statement),
    false,
  );
});

Deno.test("save: bytes that are not the file recorded, or not a PDF, are refused and the claim given back", async () => {
  const t = await setup();
  t.objects.set(`${CAPTURE}/m1/SWP-90001.pdf`, pdf("someone changed me"));
  const r = await save(t.client);
  assertEquals(r.skipped.map((s) => s.reason), ["hash_mismatch"]);
  assertEquals(t.tables.dispatch_v2_order_documents.length, 0);

  const t2 = await setup();
  const gif = enc.encode("GIF89a not a pdf");
  t2.objects.set(`${CAPTURE}/m1/SWP-90001.pdf`, gif);
  t2.tables.context_email_attachments[0].sha256 = await sha256HexOf(gif);
  const r2 = await save(t2.client);
  assertEquals(r2.skipped.map((s) => s.reason), ["not_a_pdf"]);
  assertEquals(t2.tables.job_documents.length, 0);
});

Deno.test("save: an upload that fails leaves nothing claimed, so the next run tries again", async () => {
  const t = await setup({ failUpload: ["job-documents"] });
  const r = await save(t.client);
  assertEquals(r.skipped.map((s) => s.reason), ["upload_failed"]);
  assertEquals(t.tables.dispatch_v2_order_documents.length, 0);
  assertEquals(t.tables.job_documents.length, 0);
});

Deno.test("save: a fresh claim by another run is left alone; a stale one is taken over", async () => {
  const t = await setup();
  t.tables.dispatch_v2_order_documents.push({
    id: "claim-1",
    org_id: ORG,
    job_id: JOB,
    order_id: ORDER,
    content_sha256: "",
    state: "claimed",
    claimed_at: "2026-11-03T01:55:00.000Z",
  });
  t.tables.dispatch_v2_order_documents[0].content_sha256 = t.shas.confirmation;
  const busy = await save(t.client);
  assertEquals(busy.skipped.map((s) => s.reason), ["in_progress"]);
  const later = await save(t.client, "2026-11-03T02:10:00.000Z");
  assertEquals(later.saved.length, 1);
  assertEquals(t.tables.dispatch_v2_order_documents.length, 1);
  assertEquals(t.tables.dispatch_v2_order_documents[0].state, "saved");
});

Deno.test("save: a read that fails saves nothing and says so", async () => {
  const t = await setup({
    fail: { context_email_attachments: { select: { code: "42501", message: "denied" } } },
  });
  const r = await save(t.client);
  assertEquals([r.read, r.found, r.saved.length], ["failed", 0, 0]);
});

// ── The order-confirmed step and the sweep ──────────────────────────────────

const deps: DispatchOrderConfirmedDeps = {
  writeNote: () => Promise.resolve({ id: "9e000000-0000-4000-8000-000000000001" }),
};

Deno.test("confirmed: Order confirmed writes the crew line and saves the documents", async () => {
  const t = await setup();
  const r = await runDispatchV2OrderConfirmed(t.client, {
    orgId: ORG,
    jobId: JOB,
    supplierId: SUP,
    trigger: "stage_set",
    operator: { userId: null, email: "shaun@ops.test" },
  }, { ...deps, now: () => NOW });
  assertEquals((r.crew_line as any).text, "Stratco pickup Tue 3 Nov · from Neerabup");
  assertEquals(r.documents?.saved.map((s) => s.name), ["Stratco order confirmation.pdf"]);
});

Deno.test("confirmed (Tweak 7 Part A): a by-hand date ticked Confirmed saves the documents; one not ticked does not", async () => {
  const pencilled = await setup();
  const r1 = await runDispatchV2OrderConfirmed(pencilled.client, {
    orgId: ORG,
    jobId: JOB,
    supplierId: SUP,
    trigger: "date_set",
    operator: { userId: null, email: "shaun@ops.test" },
  }, { ...deps, now: () => NOW });
  assertEquals(r1.documents, null);
  const ticked = await setup();
  const r2 = await runDispatchV2OrderConfirmed(ticked.client, {
    orgId: ORG,
    jobId: JOB,
    supplierId: SUP,
    trigger: "date_confirmed",
    operator: { userId: null, email: "shaun@ops.test" },
  }, { ...deps, now: () => NOW });
  assertEquals((r2.crew_line as any).kind, "confirmed");
  assertEquals(r2.documents?.saved.map((s) => s.name), ["Stratco order confirmation.pdf"]);
});

Deno.test("sweep: only confirmed orders with a recently changed matched reply are opened", async () => {
  const t = await setup();
  // No crew line yet (confirmed before Tweak 1 shipped): never swept.
  assertEquals(await sweepDispatchV2OrderDocuments(t.client, { orgId: ORG, now: NOW }), {
    orders: 0,
    saved: 0,
    failed: 0,
  });
  t.tables.dispatch_v2_order_crew_lines.push(
    { id: "l1", org_id: ORG, order_id: ORDER, seq: 1, created_at: "2026-11-01T06:00:00Z" },
    { id: "l2", org_id: ORG, order_id: OTHER_ORDER, seq: 1, created_at: "2026-11-01T06:00:00Z" },
  );
  assertEquals(await sweepDispatchV2OrderDocuments(t.client, { orgId: ORG, now: NOW }), {
    orders: 1,
    saved: 1,
    failed: 0,
  });
  // A month later the replies are old news: nothing is opened.
  assertEquals(
    await sweepDispatchV2OrderDocuments(t.client, { orgId: ORG, now: "2026-12-01T02:00:00.000Z" }),
    { orders: 0, saved: 0, failed: 0 },
  );
});
