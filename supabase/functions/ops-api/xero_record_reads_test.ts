import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ATTACHMENT_MAX_BYTES,
  getXeroAttachment,
  listXeroAttachments,
  readXeroHistory,
} from "./xero_record_reads.ts";

const id = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

function deps(attachment: Record<string, unknown> = {}) {
  const paths: string[] = [];
  let downloads = 0;
  const pdf = new TextEncoder().encode("%PDF-1.4 test");
  return {
    paths,
    get downloads() {
      return downloads;
    },
    deps: {
      getToken: async () => ({ accessToken: "t", tenantId: id(10) }),
      xeroGet: async (path: string) => {
        paths.push(path);
        if (path.endsWith("/History")) {
          return {
            HistoryRecords: [{
              Changes: "Created",
              DateUTCString: "2026-09-11T02:00:00",
              User: "Jan Example",
              Details: "INV created",
            }],
          };
        }
        return {
          Attachments: [{
            AttachmentID: id(7),
            FileName: "bill.pdf",
            Url: "https://api.xero.com/secret",
            MimeType: "application/pdf",
            ContentLength: pdf.length,
            ...attachment,
          }],
        };
      },
      xeroGetBinary: async (_path: string, _t: string, _ten: string, accept: string) => {
        downloads++;
        assertEquals(accept, "application/pdf");
        return { bytes: pdf, contentType: "application/pdf" };
      },
    },
  };
}

const params = (o: Record<string, string>) => new URLSearchParams(o);

Deno.test("history names who changed a record and when", async () => {
  const d = deps();
  const r = await readXeroHistory(null, params({ kind: "invoice", id: id(1) }), d.deps);
  assertEquals(d.paths, [`/Invoices/${id(1)}/History`]);
  assertEquals(r.records[0], {
    date_utc: "2026-09-11T02:00:00",
    user: "Jan Example",
    changes: "Created",
    details: "INV created",
  });
  const b = deps();
  await readXeroHistory(null, params({ kind: "bank_transaction", id: id(1) }), b.deps);
  assertEquals(b.paths, [`/BankTransactions/${id(1)}/History`]);
});

Deno.test("attachment listing drops Xero's file URL", async () => {
  const d = deps();
  const r = await listXeroAttachments(null, params({ kind: "credit_note", id: id(1) }), d.deps);
  assertEquals(d.paths, [`/CreditNotes/${id(1)}/Attachments`]);
  assertEquals(Object.keys(r.attachments[0]).sort(), [
    "attachment_id",
    "content_length",
    "file_name",
    "mime_type",
  ]);
});

Deno.test("a PDF attachment comes back as base64", async () => {
  const d = deps();
  const r = await getXeroAttachment(
    null,
    params({ kind: "invoice", id: id(1), attachment_id: id(7) }),
    d.deps,
  );
  assertEquals(atob(r.base64), "%PDF-1.4 test");
  assertEquals(r.mime_type, "application/pdf");
  assertEquals(d.downloads, 1);
});

Deno.test("oversized, unsupported or missing attachments are refused before download", async () => {
  for (
    const [extra, attachmentId, code] of [
      [{ ContentLength: ATTACHMENT_MAX_BYTES + 1 }, id(7), "ATTACHMENT_TOO_LARGE"],
      [{ MimeType: "application/zip" }, id(7), "ATTACHMENT_TYPE_UNSUPPORTED"],
      [{}, id(99), "ATTACHMENT_NOT_FOUND"],
    ] as const
  ) {
    const d = deps(extra);
    const error = await assertRejects(() =>
      getXeroAttachment(
        null,
        params({ kind: "invoice", id: id(1), attachment_id: attachmentId }),
        d.deps,
      )
    ) as { code: string };
    assertEquals(error.code, code);
    assertEquals(d.downloads, 0);
  }
});

Deno.test("reads validate kind and ids before calling Xero", async () => {
  for (
    const p of [
      { kind: "payment", id: id(1) },
      { kind: "invoice", id: "INV-1" },
      { kind: "invoice" },
    ]
  ) {
    const d = deps();
    await assertRejects(() => readXeroHistory(null, params(p as Record<string, string>), d.deps));
    assertEquals(d.paths.length, 0);
  }
  const d = deps();
  await assertRejects(() =>
    getXeroAttachment(null, params({ kind: "invoice", id: id(1), attachment_id: "x" }), d.deps)
  );
  assertEquals(d.paths.length, 0);
});
