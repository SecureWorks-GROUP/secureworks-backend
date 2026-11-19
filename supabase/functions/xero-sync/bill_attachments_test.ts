// Supplier bill PDF findings. Fake client only. ZZTEST fixtures.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { _resetSwitchCacheForTest } from "../_shared/switch_cache.ts";
import { XeroCooldownError } from "../_shared/xero_cooldown.ts";
import { PDF_TEXT_MAX_BYTES } from "../ops-api/makesafe_pdf_text.ts";
import {
  billAttachmentLimit,
  findingsFromText,
  poNumbersIn,
  readBillAttachments,
  readBillAttachmentsRequest,
  type BillAttachmentXeroFile,
} from "./bill_attachments.ts";
import { attachmentFindingTexts, documentTexts, type MatchDocument } from "./match/doc_clues.ts";

const ORG = "00000000-0000-4000-8000-000000000001";
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
const TEXT = "Job SWF-26123\nPO-1000999\nDeliver to: 12 Test Street ZZTEST\nOrder ref: ZZ-100\n";

function bareDoc(): MatchDocument {
  return {
    subject_id: "xero_bill:b",
    document_kind: "xero_bill",
    document_id: "b",
    party_id: null,
    party_name: null,
    document_number: "INV-1",
    reference: "REF",
    document_date: null,
    total_ex: null,
    lines: [{
      line_key: "n:1",
      description: "Posts",
      account_code: null,
      tracking_option: null,
      amount_ex: 1,
    }],
  };
}

Deno.test("document texts stay the bill's own fields when no PDF findings are attached", () => {
  assertEquals(documentTexts(bareDoc()), [
    { where: "Xero reference box", text: "INV-1" },
    { where: "reference", text: "REF" },
    { where: "line 1 description", text: "Posts" },
  ]);
  const withPdf = {
    ...bareDoc(),
    attachment_texts: attachmentFindingTexts([{
      job_numbers: ["SWF-26123"],
      po_numbers: ["PO-1000999"],
      order_ref: "ZZ-100",
      delivery_address: "12 Test Street ZZTEST",
    }]),
  };
  const texts = documentTexts(withPdf);
  assertEquals(texts.slice(0, 3), documentTexts(bareDoc()));
  assertEquals(texts.slice(3).map((t) => t.text), [
    "SWF-26123",
    "PO-1000999",
    "ZZ-100",
    "12 Test Street ZZTEST",
  ]);
});

Deno.test("findings keep a job number, a PO and a delivery line, and never the document text", () => {
  const found = findingsFromText(TEXT);
  assertEquals(found.job_numbers, ["SWF-26123"]);
  assertEquals(found.po_numbers, ["PO-1000999"]);
  assertEquals(found.order_ref, "ZZ-100");
  assertEquals(found.delivery_address, "12 Test Street ZZTEST");
  assertEquals("text" in found, false);
  assertEquals(poNumbersIn("PO BOX 6000 and POSTED 12345"), []);
  assertEquals(billAttachmentLimit(null), 20);
  assertEquals(billAttachmentLimit("100"), 40);
  assertEquals(billAttachmentLimit("0"), 1);
});

interface Seed {
  flag?: boolean;
  flagError?: boolean;
  bills?: Array<Record<string, unknown>>;
  seen?: string[];
  trade?: string[];
  emails?: Array<Record<string, unknown>>;
  files?: Record<string, BillAttachmentXeroFile[]>;
  bytes?: Uint8Array;
  downloadError?: boolean;
  listError?: "cooldown" | "other";
}

function harness(seed: Seed = {}) {
  _resetSwitchCacheForTest();
  const writes: Array<Record<string, unknown>> = [];
  const calls: string[] = [];
  const tables: string[] = [];
  // deno-lint-ignore no-explicit-any
  const sb: any = {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const run = () => {
        tables.push(table);
        if (table === "feature_flags") {
          if (seed.flagError) return { data: null, error: { code: "XX000" } };
          return { data: [{ enabled: seed.flag === true }], error: null };
        }
        if (table === "xero_bill_attachment_reads" && !("upsert" in filters)) {
          return {
            data: (seed.seen ?? []).map((xero_invoice_id) => ({ xero_invoice_id })),
            error: null,
          };
        }
        if (table === "xero_invoices") return { data: seed.bills ?? [], error: null };
        if (table === "trade_invoices") {
          const ids = (filters["in:xero_bill_id"] as string[]) ?? [];
          return {
            data: (seed.trade ?? []).filter((id) => ids.includes(id)).map((xero_bill_id) => ({ xero_bill_id })),
            error: null,
          };
        }
        if (table === "context_email_attachments") return { data: seed.emails ?? [], error: null };
        return { data: [], error: null };
      };
      // deno-lint-ignore no-explicit-any
      const chain: any = {
        select: () => chain,
        eq: (k: string, v: unknown) => (filters[k] = v, chain),
        not: () => chain,
        or: () => chain,
        order: () => chain,
        limit: () => chain,
        gt: () => chain,
        in: (k: string, v: unknown) => (filters[`in:${k}`] = v, chain),
        ilike: () => chain,
        upsert: (row: Record<string, unknown>) => {
          tables.push(table);
          writes.push(row);
          filters.upsert = true;
          return Promise.resolve({ error: null });
        },
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
      };
      return chain;
    },
    storage: {
      from(bucket: string) {
        return {
          async download(path: string) {
            calls.push(`download:${bucket}:${path}`);
            if (seed.downloadError) return { data: null, error: { code: "XX000" } };
            return { data: seed.bytes ?? PDF, error: null };
          },
        };
      },
    },
  };
  const xero = {
    async list(invoiceId: string) {
      calls.push(`list:${invoiceId}`);
      if (seed.listError === "cooldown") {
        throw new XeroCooldownError("paused", 429, "XERO_RATE_LIMITED");
      }
      if (seed.listError === "other") throw new Error("list_down");
      return seed.files?.[invoiceId] ?? [];
    },
    async download(invoiceId: string, fileName: string) {
      calls.push(`xero:${invoiceId}:${fileName}`);
      return seed.bytes ?? PDF;
    },
  };
  return { sb, xero, writes, calls, tables };
}

const bill = (over: Record<string, unknown> = {}) => ({
  xero_invoice_id: "bill-1",
  invoice_number: "INV-83831",
  reference: "",
  has_attachments: "true",
  ...over,
});

const email = (over: Record<string, unknown> = {}) => ({
  id: "email-att-1",
  file_name: "INV-83831.pdf",
  content_type: "application/pdf",
  storage_bucket: "context-email-attachments",
  storage_path: "zz/INV-83831.pdf",
  size_bytes: 120,
  ...over,
});

function run(seed: Seed, limit = 20) {
  const h = harness(seed);
  return readBillAttachments(h.sb, {
    orgId: ORG,
    limit,
    xero: h.xero,
    extractText: async () => ({ text: TEXT }),
  }).then((body) => ({ ...h, body }));
}

Deno.test("switch off: no Xero call and no write", async () => {
  const h = harness({ flag: false, bills: [bill()] });
  const body = await readBillAttachments(h.sb, {
    orgId: ORG,
    xero: {
      list: () => { throw new Error("xero"); },
      download: () => { throw new Error("xero"); },
    },
  });
  assertEquals(body, { skipped: "switch_off" });
  assertEquals(h.calls, []);
  assertEquals(h.writes, []);
  assertEquals(h.tables, ["feature_flags"]);
});

Deno.test("a stored email PDF is read and Xero is not called", async () => {
  const { body, calls, writes } = await run({ flag: true, bills: [bill()], emails: [email()] });
  assertEquals(body.skipped, undefined);
  assertEquals(calls.some((c) => c.startsWith("list:")), false);
  assertEquals(calls.some((c) => c.startsWith("xero:")), false);
  assertEquals(writes.length, 1);
  assertEquals(writes[0].source, "email");
  assertEquals(writes[0].state, "text_read");
  assertEquals(writes[0].job_numbers, ["SWF-26123"]);
  assertEquals(writes[0].po_numbers, ["PO-1000999"]);
  assertEquals(writes[0].delivery_address, "12 Test Street ZZTEST");
  assertEquals(typeof writes[0].text_sha256, "string");
  assertEquals((writes[0].text_sha256 as string).length, 64);
  assertEquals("text" in writes[0], false);
  assertEquals(body.email, 1);
  assertEquals(body.text_read, 1);
});

Deno.test("no stored PDF lists and downloads the Xero PDF", async () => {
  const { calls, writes, body } = await run({
    flag: true,
    bills: [bill()],
    files: {
      "bill-1": [{
        attachment_id: "x-att-1",
        file_name: "supplier.pdf",
        mime_type: "application/pdf",
        content_length: 80,
      }],
    },
  });
  assertEquals(calls, ["list:bill-1", "xero:bill-1:supplier.pdf"]);
  assertEquals(writes[0].source, "xero");
  assertEquals(writes[0].state, "text_read");
  assertEquals(writes[0].job_numbers, ["SWF-26123"]);
  assertEquals(body.xero, 1);
});

Deno.test("a file over 5 MB is not downloaded", async () => {
  const { calls, writes } = await run({
    flag: true,
    bills: [bill()],
    files: {
      "bill-1": [{
        attachment_id: "x-att-big",
        file_name: "big.pdf",
        mime_type: "application/pdf",
        content_length: PDF_TEXT_MAX_BYTES + 1,
      }],
    },
  });
  assertEquals(calls, ["list:bill-1"]);
  assertEquals(writes[0].state, "too_large");
  assertEquals("text" in writes[0], false);
});

Deno.test("a non-PDF is stored as unsupported and not downloaded", async () => {
  const { calls, writes } = await run({
    flag: true,
    bills: [bill()],
    files: {
      "bill-1": [{
        attachment_id: "x-att-png",
        file_name: "photo.png",
        mime_type: "image/png",
        content_length: 40,
      }],
    },
  });
  assertEquals(calls, ["list:bill-1"]);
  assertEquals(writes[0].state, "unsupported");
});

Deno.test("a blank bill with no PDF is marked and Xero is not called", async () => {
  const { calls, writes } = await run({
    flag: true,
    bills: [bill({ has_attachments: "false", invoice_number: null })],
  });
  assertEquals(calls, []);
  assertEquals(writes[0].state, "no_text");
  assertEquals(writes[0].error_code, "no_pdf");
  assertEquals(writes[0].job_numbers, []);
});

Deno.test("a bill already read is skipped", async () => {
  const { calls, writes, body } = await run({
    flag: true,
    bills: [bill()],
    seen: ["bill-1"],
  });
  assertEquals(calls, []);
  assertEquals(writes, []);
  assertEquals(body.bills, 0);
});

Deno.test("a trade bill is not a supplier bill", async () => {
  const { calls, writes } = await run({
    flag: true,
    bills: [bill()],
    trade: ["bill-1"],
  });
  assertEquals(calls, []);
  assertEquals(writes, []);
});

Deno.test("a Xero 429 stops the run and is not retried", async () => {
  const { calls, body } = await run({
    flag: true,
    bills: [bill(), bill({ xero_invoice_id: "bill-2" })],
    listError: "cooldown",
  });
  assertEquals(body.stopped, "cooldown");
  assertEquals(calls, ["list:bill-1"]);
});

Deno.test("the door refuses any caller but a POST with the exact service key", async () => {
  const url = "https://x.invalid/xero-sync?action=read_bill_attachments";
  const throwing = { from() { throw new Error("read"); } };
  for (const [method, auth, status] of [
    ["POST", "Bearer anon", 403],
    ["POST", null, 403],
    ["GET", "Bearer server-key", 405],
  ] as const) {
    const headers: Record<string, string> = auth ? { authorization: auth } : {};
    const out = await readBillAttachmentsRequest(
      new Request(url, { method, headers }),
      throwing,
      "server-key",
      { orgId: ORG },
    );
    assertEquals(out.status, status);
  }
  const off = harness({ flag: false });
  const ok = await readBillAttachmentsRequest(
    new Request(`${url}&limit=9`, { method: "POST", headers: { authorization: "Bearer server-key" } }),
    off.sb,
    "server-key",
    { orgId: ORG, xero: off.xero },
  );
  assertEquals([ok.status, ok.body.skipped], [200, "switch_off"]);
  assert(off.calls.length === 0);
});
