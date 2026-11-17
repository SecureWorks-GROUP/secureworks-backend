// deno-lint-ignore-file no-explicit-any
// Dispatch v2 item 16 part 1: the files on an Unmatched supplier email
// (dispatch_v2_tray_attachments.ts), against an in-memory store. The four
// Ampelite "FW: Scanned Document" emails of 16 Nov 2026 are the shape
// (one scanned PDF each); their ids and hashes here are made up.
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  addTrayAttachments,
  openTrayAttachment,
  saveTrayAttachmentsToJob,
  TRAY_SIGNED_URL_SECONDS,
  TrayAttachmentError,
  type TrayAttachmentRow,
  type TrayAttachmentStore,
  trayDocumentName,
  trayKindLabel,
  traySizeLabel,
} from "./dispatch_v2_tray_attachments.ts";
import { sha256HexOf } from "./dispatch_v2_order_documents.ts";

const ORG = "00000000-0000-4000-8000-000000000001";
const JOB = "10000000-0000-4000-8000-000000000001";
const EMAIL = (n: number) => `e0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ATT = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PMID = (n: number) => `graph:ampelite-${n}`;
const enc = (s: string) => new TextEncoder().encode(s);

async function fake(opts: { failRead?: boolean; onJob?: string[]; badBytes?: boolean } = {}) {
  const pdf1 = enc("%PDF-1.4 scan one");
  const pdf2 = enc("%PDF-1.4 scan two");
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const sha1 = await sha256HexOf(pdf1);
  const sha2 = await sha256HexOf(pdf2);
  const shaJ = await sha256HexOf(jpg);
  const files = new Map<string, Uint8Array>([
    ["cap/1.pdf", pdf1],
    ["cap/2.pdf", pdf2],
    ["cap/j.jpg", jpg],
  ]);
  const row = (o: Partial<TrayAttachmentRow>): TrayAttachmentRow => ({
    id: ATT(0), provider_message_id: PMID(1), file_name: null, content_type: null,
    size_bytes: null, sha256: null, storage_bucket: null, storage_path: null, status: "stored", ...o,
  });
  const atts: TrayAttachmentRow[] = [
    // Email 1: one scanned PDF and a signature logo.
    row({ id: ATT(1), provider_message_id: PMID(1), file_name: "16112026124402-0001.pdf", content_type: "application/pdf", size_bytes: 192853, sha256: sha1, storage_bucket: "context-email-attachments", storage_path: "cap/1.pdf" }),
    row({ id: ATT(2), provider_message_id: PMID(1), file_name: "image001.png", content_type: "image/png", size_bytes: 4000, status: "skipped_inline" }),
    // Email 2: the same PDF again (no copy of its own), a photo, and a file
    // too big to keep.
    row({ id: ATT(3), provider_message_id: PMID(2), file_name: "copy.pdf", content_type: "application/pdf", size_bytes: 192853, sha256: sha1, status: "skipped_duplicate" }),
    row({ id: ATT(4), provider_message_id: PMID(2), file_name: "site.jpg", content_type: "image/jpeg", size_bytes: 1_500_000, sha256: shaJ, storage_bucket: "context-email-attachments", storage_path: "cap/j.jpg" }),
    row({ id: ATT(5), provider_message_id: PMID(2), file_name: "huge.pdf", content_type: "application/pdf", size_bytes: 20_000_000, status: "skipped_too_large" }),
    // Email 3: a second PDF.
    row({ id: ATT(6), provider_message_id: PMID(3), file_name: "16112026124201-0001.pdf", content_type: "application/pdf", size_bytes: 191599, sha256: sha2, storage_bucket: "context-email-attachments", storage_path: "cap/2.pdf" }),
  ];
  const emails = [
    { id: EMAIL(1), provider_message_id: PMID(1), supplier_name: "Ampelite" },
    { id: EMAIL(2), provider_message_id: PMID(2), supplier_name: "Ampelite" },
    { id: EMAIL(3), provider_message_id: PMID(3), supplier_name: "Ampelite" },
    { id: EMAIL(4), provider_message_id: null, supplier_name: "Ampelite" },
  ];
  const log = {
    signed: [] as any[], uploads: [] as any[], docs: [] as any[], events: [] as any[], downloads: [] as string[],
  };
  const onJob = new Set((opts.onJob || []).map((k) => ({ sha1, sha2, shaJ } as any)[k]));
  const store: TrayAttachmentStore = {
    async emailsByIds(org, ids) {
      if (opts.failRead) throw new Error("down");
      assertEquals(org, ORG);
      return emails.filter((e) => ids.includes(e.id));
    },
    async attachmentsFor(pmids) {
      return atts.filter((a) => pmids.includes(a.provider_message_id));
    },
    async storedBySha(shas) {
      return atts.filter((a) => a.status === "stored" && a.sha256 && shas.includes(a.sha256));
    },
    async signedUrl(bucket, path, seconds) {
      log.signed.push({ bucket, path, seconds });
      return `https://signed.test/${bucket}/${path}?t=${seconds}`;
    },
    async download(_bucket, path) {
      log.downloads.push(path);
      if (opts.badBytes) return enc("not the same file");
      return files.get(path) ?? null;
    },
    async jobFileShas(_jobId, shas) {
      return new Set(shas.filter((s) => onJob.has(s)));
    },
    async upload(path, bytes, contentType) {
      log.uploads.push({ path, size: bytes.length, contentType });
      return `https://public.test/job-documents/${path}`;
    },
    async insertJobDocument(r) {
      log.docs.push(r);
      return `d0000000-0000-4000-8000-${String(log.docs.length).padStart(12, "0")}`;
    },
    async logJobEvent(r) {
      log.events.push(r);
    },
  };
  return { store, log, sha1, sha2, shaJ };
}

Deno.test("kind and size words", () => {
  assertEquals(trayKindLabel("application/pdf", "x"), "PDF");
  assertEquals(trayKindLabel(null, "Scan.PDF"), "PDF");
  assertEquals(trayKindLabel("image/jpeg", "a.jpg"), "Image");
  assertEquals(trayKindLabel("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "a.docx"), "Word");
  assertEquals(trayKindLabel("application/vnd.ms-excel", "a.xls"), "Excel");
  assertEquals(trayKindLabel("application/zip", "a.zip"), "File");
  assertEquals(traySizeLabel(192853), "188 KB");
  assertEquals(traySizeLabel(1_500_000), "1.4 MB");
  assertEquals(traySizeLabel(900), "900 bytes");
  assertEquals(traySizeLabel(null), null);
});

Deno.test("the name on the job: supplier, then the file name as sent", () => {
  assertEquals(trayDocumentName("Ampelite", "16112026124402-0001.pdf", "application/pdf"), { name: "Ampelite 16112026124402-0001", extension: "pdf" });
  assertEquals(trayDocumentName("Ampelite", "Ampelite invoice.PDF", "application/pdf"), { name: "Ampelite invoice", extension: "pdf" });
  assertEquals(trayDocumentName(null, "photo", "image/jpeg"), { name: "photo", extension: "jpg" });
});

Deno.test("the tray read lists each email's files, never the inline logos", async () => {
  const { store } = await fake();
  const answer = { ok: true, emails: [{ id: EMAIL(1) }, { id: EMAIL(2) }, { id: EMAIL(4) }], counts: {} };
  const out = await addTrayAttachments(store, ORG, answer);
  assertEquals(out.attachments_read, "ok");
  assertEquals(out.ok, true);
  const [e1, e2, e4] = out.emails as any[];
  assertEquals(e1.attachments.map((a: any) => [a.kind_label, a.file_name, a.size_label, a.openable]), [["PDF", "16112026124402-0001.pdf", "188 KB", true]]);
  // The duplicate opens through the kept copy; the too-big one says why.
  assertEquals(e2.attachments.map((a: any) => [a.file_name, a.openable]), [["copy.pdf", true], ["huge.pdf", false], ["site.jpg", true]]);
  assertEquals(e2.attachments[1].not_kept_reason, "Not saved: over 15 MB");
  assertEquals(e4.attachments, []);
});

Deno.test("a failed files read leaves the tray working, each email's files null", async () => {
  const { store } = await fake({ failRead: true });
  const out = await addTrayAttachments(store, ORG, { ok: true, emails: [{ id: EMAIL(1) }] });
  assertEquals(out.attachments_read, "failed");
  assertEquals((out.emails as any[])[0].attachments, null);
  assertEquals((await addTrayAttachments(store, ORG, { ok: true, emails: [] })).attachments_read, "ok");
});

Deno.test("Open makes a two-minute link to the kept copy", async () => {
  const { store, log } = await fake();
  const out = await openTrayAttachment(store, ORG, new URLSearchParams({ email_id: EMAIL(2), attachment_id: ATT(3) }));
  assertEquals(out.ok, true);
  assertEquals(out.expires_in, TRAY_SIGNED_URL_SECONDS);
  assertEquals(TRAY_SIGNED_URL_SECONDS, 120);
  assertEquals(out.file_name, "copy.pdf");
  // The duplicate's link is to the first email's stored copy.
  assertEquals(log.signed, [{ bucket: "context-email-attachments", path: "cap/1.pdf", seconds: 120 }]);
});

Deno.test("Open refuses a file of another email, a file not kept, an inline logo and a bad id", async () => {
  const { store } = await fake();
  const open = (email: string, att: string) => openTrayAttachment(store, ORG, new URLSearchParams({ email_id: email, attachment_id: att }));
  const e1 = await assertRejects(() => open(EMAIL(1), ATT(6)), TrayAttachmentError);
  assertEquals((e1 as TrayAttachmentError).code, "attachment_not_found");
  const e2 = await assertRejects(() => open(EMAIL(2), ATT(5)), TrayAttachmentError);
  assertEquals([(e2 as TrayAttachmentError).status, (e2 as TrayAttachmentError).code], [409, "attachment_not_kept"]);
  const e3 = await assertRejects(() => open(EMAIL(1), ATT(2)), TrayAttachmentError);
  assertEquals((e3 as TrayAttachmentError).code, "attachment_not_found");
  const e4 = await assertRejects(() => open("nope", ATT(1)), TrayAttachmentError);
  assertEquals((e4 as TrayAttachmentError).status, 400);
  const e5 = await assertRejects(() => open(EMAIL(9), ATT(1)), TrayAttachmentError);
  assertEquals((e5 as TrayAttachmentError).code, "email_not_found");
});

const SAVE = (emailId: string) => ({ orgId: ORG, emailId, jobId: JOB, operatorUserId: null, operatorEmail: "shaun@ops.test", via: "screen" });

Deno.test("Put on job saves the email's kept files to the job, office only", async () => {
  const { store, log, sha1, shaJ } = await fake();
  const out = await saveTrayAttachmentsToJob(store, SAVE(EMAIL(2)));
  assertEquals(out.read, "ok");
  assertEquals(out.saved.map((s) => s.name).sort(), ["Ampelite copy.pdf", "Ampelite site.jpg"]);
  assertEquals(out.skipped, [{ file_name: "huge.pdf", reason: "not_kept" }]);
  assertEquals(log.docs.length, 2);
  for (const d of log.docs) {
    assertEquals(d.type, "material_order");
    assertEquals(d.visible_to_trades, false);
    assertEquals(d.job_id, JOB);
    assertEquals(d.metadata.office_only, true);
    assertEquals(d.metadata.reply_email_id, EMAIL(2));
  }
  assertEquals(log.docs.map((d) => d.metadata.content_sha256).sort(), [sha1, shaJ].sort());
  assert(log.uploads.every((u) => u.path.startsWith(`${JOB}/dispatch-tray/`)));
  assertEquals(log.uploads.find((u) => u.path.endsWith(".jpg"))!.contentType, "image/jpeg");
  assertEquals(log.events.map((e) => [e.event_type, e.detail_json.visible_to_trades]), [["dispatch_v2_tray_file_saved", false], ["dispatch_v2_tray_file_saved", false]]);
});

Deno.test("once only: a file already on the job (by its hash) is not saved again", async () => {
  const { store, log } = await fake({ onJob: ["sha1"] });
  const out = await saveTrayAttachmentsToJob(store, SAVE(EMAIL(1)));
  assertEquals(out.saved, []);
  assertEquals(out.skipped, [{ file_name: "16112026124402-0001.pdf", reason: "already_on_job" }]);
  assertEquals(log.downloads, []);
  assertEquals(log.docs, []);
});

Deno.test("bytes that do not match the hash are never saved", async () => {
  const { store, log } = await fake({ badBytes: true });
  const out = await saveTrayAttachmentsToJob(store, SAVE(EMAIL(3)));
  assertEquals(out.saved, []);
  assertEquals(out.skipped, [{ file_name: "16112026124201-0001.pdf", reason: "hash_mismatch" }]);
  assertEquals(log.uploads, []);
});

Deno.test("a failed read says so and saves nothing; an email with no files saves nothing", async () => {
  const { store } = await fake({ failRead: true });
  assertEquals(await saveTrayAttachmentsToJob(store, SAVE(EMAIL(1))), { read: "failed", saved: [], skipped: [] });
  const ok = await fake();
  assertEquals(await saveTrayAttachmentsToJob(ok.store, SAVE(EMAIL(4))), { read: "ok", saved: [], skipped: [] });
});
