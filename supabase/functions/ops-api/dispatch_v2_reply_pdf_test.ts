// deno-lint-ignore-file no-explicit-any no-import-prefix
// Dispatch v2, Tweak 2 piece 2: the job number inside a supplier's PDF
// (dispatch_v2_reply_pdf.ts, contract section 3f.2). The rules, and the real
// reader on an in-memory attachments table and storage bucket with real
// PDF bytes. No network, no Supabase.
//
// Run: deno test --no-check --allow-env --allow-read supabase/functions/ops-api/dispatch_v2_reply_pdf_test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  jobNumbersInPdfText,
  PDF_FILES_PER_EMAIL,
  pickPdfJob,
  postgrestReplyPdfReader,
} from "./dispatch_v2_reply_pdf.ts";
import type { JobHint } from "./dispatch_v2_replies_rules.ts";

const enc = new TextEncoder();

/** A one-page PDF whose text layer holds these lines (Helvetica). */
function textPdf(lines: string[]): Uint8Array {
  const escaped = lines.map((line) =>
    line.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)")
  );
  const content = `BT /F1 10 Tf 72 760 Td ${
    escaped.map((line) => `(${line}) Tj 0 -14 Td`).join(" ")
  } ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${enc.encode(content).length} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(enc.encode(pdf).length);
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = enc.encode(pdf).length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets.slice(1)) {
    pdf += `${String(o).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${
    objects.length + 1
  } /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return enc.encode(pdf);
}

function job(id: string, number: string): JobHint {
  return {
    job_id: id,
    job_number: number,
    client_name: null,
    site_address: null,
    site_suburb: null,
    status: "scheduled",
    type: "fencing",
  };
}

// ── Rules ───────────────────────────────────────────────────────────────────

Deno.test("job numbers in PDF text: SWF, SWP and SWR, with or without the hyphen", () => {
  assertEquals(
    jobNumbersInPdfText(
      "Customer Order 11041784\nYour Ref: SWF-261586\nAlso SWP 26701, SWR261499 and SWF-261586 again",
    ),
    ["SWF-261586", "SWP-26701", "SWR-261499"],
  );
  // A label run into the number is still read ("YourRefSWF-261586").
  assertEquals(jobNumbersInPdfText("YourRefSWF-261586"), ["SWF-261586"]);
});

Deno.test("job numbers in PDF text: not make-safes, not other prefixes, not part of a longer code", () => {
  assertEquals(
    jobNumbersInPdfText(
      "SWMS-261162 XSWF-261586 SWF-12 SWF-12345678 swf-261586 SWD-26100 ABN 12 345",
    ),
    [],
  );
});

Deno.test("pick the job: exactly one of ours, ignoring numbers that are not our jobs", () => {
  const byNumber = new Map([
    ["SWF-261586", job("j1", "SWF-261586")],
    ["SWP-26701", job("j2", "SWP-26701")],
  ]);
  const one = pickPdfJob(["SWF-999999", "SWF-261586"], byNumber);
  assertEquals(one.kind, "one");
  if (one.kind === "one") {
    assertEquals([one.job.job_id, one.job_number], ["j1", "SWF-261586"]);
  }
  assertEquals(pickPdfJob([], byNumber).kind, "none");
  assertEquals(pickPdfJob(["SWF-999999"], byNumber).kind, "none");
  assertEquals(pickPdfJob(["SWF-261586", "SWP-26701"], byNumber).kind, "several");
  // The same job written twice is one job.
  const stored = new Map([["SWF-261586", job("j1", "SWF261586")]]);
  assertEquals(pickPdfJob(["SWF-261586", "SWF-261586"], stored).kind, "one");
});

// ── The real reader ─────────────────────────────────────────────────────────

const SHA = (n: number) => String(n).repeat(64).slice(0, 64);

/** The attachments table and the bucket, in memory, shaped like the
 * PostgREST client the reader uses (select ... eq / in / limit, storage
 * download). Every download is recorded. */
function fakeClient(rows: any[], files: Record<string, Uint8Array>) {
  const downloads: string[] = [];
  const client = {
    downloads,
    from(table: string) {
      if (table !== "context_email_attachments") throw new Error(table);
      const filters: ((r: any) => boolean)[] = [];
      const q: any = {
        select: () => q,
        eq: (col: string, v: unknown) => {
          filters.push((r) => r[col] === v);
          return q;
        },
        in: (col: string, vs: unknown[]) => {
          filters.push((r) => vs.includes(r[col]));
          return q;
        },
        limit: (n: number) =>
          Promise.resolve({
            data: rows.filter((r) => filters.every((f) => f(r))).slice(0, n),
            error: null,
          }),
      };
      return q;
    },
    storage: {
      from: (bucket: string) => ({
        download: (path: string) => {
          downloads.push(`${bucket}/${path}`);
          const bytes = files[`${bucket}/${path}`];
          return Promise.resolve(
            bytes
              ? { data: new Blob([bytes as BlobPart]), error: null }
              : { data: null, error: { message: "not found" } },
          );
        },
      }),
    },
  };
  return client;
}

function att(
  id: number,
  message: string,
  extra: Record<string, unknown> = {},
) {
  return {
    id: `att-${id}`,
    provider_message_id: message,
    file_name: `file-${id}.pdf`,
    content_type: "application/pdf",
    sha256: SHA(id),
    storage_bucket: "context-email-attachments",
    storage_path: `p/${id}.pdf`,
    status: "stored",
    ...extra,
  };
}

Deno.test("reader: reads the job number on a stored PDF, and on a duplicate's stored copy", async () => {
  const m = "email:fw-confirm@supplier.example";
  const client = fakeClient(
    [
      att(1, m, { file_name: "CO11041784.pdf" }),
      // Kept first from another email: this one is a duplicate with no copy.
      att(2, m, {
        file_name: "Delivery docket.pdf",
        status: "skipped_duplicate",
        storage_path: null,
        storage_bucket: null,
      }),
      att(2, "email:earlier@supplier.example", { id: "att-2-copy" }),
      // Not a PDF: never downloaded.
      att(3, m, { file_name: "logo.png", content_type: "image/png" }),
    ],
    {
      "context-email-attachments/p/1.pdf": textPdf([
        "Fencing Warehouse WA",
        "Customer Order 11041784",
        "Your Ref: SWF-261586",
      ]),
      "context-email-attachments/p/2.pdf": textPdf([
        "Delivery Docket",
        "Ref SWF-261586",
      ]),
    },
  );
  const r = await postgrestReplyPdfReader(client).jobNumbersInPdfs(m);
  assertEquals(r.read, "ok");
  assertEquals(r.job_numbers, ["SWF-261586"]);
  assertEquals(r.files, ["CO11041784.pdf", "Delivery docket.pdf"]);
  assertEquals(client.downloads.sort(), [
    "context-email-attachments/p/1.pdf",
    "context-email-attachments/p/2.pdf",
  ]);
});

Deno.test("reader: no PDF, a file that is not a PDF, and a failed read", async () => {
  const m = "email:x@supplier.example";
  const none = await postgrestReplyPdfReader(fakeClient([], {}))
    .jobNumbersInPdfs(m);
  assertEquals(none.read, "none");
  // Named .pdf but the bytes are not a PDF: counts as not read.
  const fake = await postgrestReplyPdfReader(fakeClient([att(1, m)], {
    "context-email-attachments/p/1.pdf": enc.encode("<html>not a pdf</html>"),
  })).jobNumbersInPdfs(m);
  assertEquals([fake.read, fake.job_numbers], ["failed", []]);
  // The table read fails: never throws.
  const broken: any = {
    from: () => {
      throw new Error("down");
    },
  };
  const failed = await postgrestReplyPdfReader(broken).jobNumbersInPdfs(m);
  assertEquals([failed.read, failed.job_numbers], ["failed", []]);
});

Deno.test("reader: at most three PDFs an email", async () => {
  const m = "email:many@supplier.example";
  const rows = [];
  const files: Record<string, Uint8Array> = {};
  for (let i = 1; i <= 5; i++) {
    rows.push(att(i, m));
    files[`context-email-attachments/p/${i}.pdf`] = textPdf([`Ref SWF-26158${i}`]);
  }
  const client = fakeClient(rows, files);
  const r = await postgrestReplyPdfReader(client).jobNumbersInPdfs(m);
  assertEquals(client.downloads.length, PDF_FILES_PER_EMAIL);
  assertEquals(r.job_numbers.length, 3);
});
