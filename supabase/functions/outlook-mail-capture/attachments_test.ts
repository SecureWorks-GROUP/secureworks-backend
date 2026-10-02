// Slice EM2: attachment size limits, skip reasons and idempotence.
// deno-lint-ignore-file no-import-prefix require-await
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { OutlookAttachmentMeta } from "../_shared/evidence/outlook_mail.ts";
import {
  ATTACHMENT_POLICY,
  attachmentDecisions,
  type AttachmentDeps,
  type AttachmentLedgerRow,
  safeFileName,
  sha256Hex,
  storeEmailAttachments,
} from "./attachments.ts";
import type { AttachmentHome } from "./graph.ts";

const MB = 1024 * 1024;
const HOME: AttachmentHome = {
  kind: "message",
  mailbox: "nithin@secureworkswa.com.au",
  messageId: "G1",
};
const file = (
  id: string,
  size: number,
  extra: Partial<OutlookAttachmentMeta> = {},
): OutlookAttachmentMeta => ({
  id,
  name: `${id}.pdf`,
  contentType: "application/pdf",
  size,
  isInline: false,
  kind: "file",
  ...extra,
});

Deno.test("limits: inline, non-file, over 15 MB, over 10 files or 30 MB per email, ses scope", () => {
  const list = [
    file("a", 1 * MB),
    file("logo", 2000, { isInline: true }),
    file("fwd", 50_000, { kind: "item" }),
    file("link", 0, { kind: "reference" }),
    file("huge", 16 * MB),
    file("b", 14 * MB),
    file("c", 14 * MB), // 1 + 14 + 14 = 29 MB: fits
    file("d", 2 * MB), // would pass 30 MB
  ];
  assertEquals(attachmentDecisions(list, "sales").map((d) => d.decision), [
    "stored",
    "skipped_inline",
    "skipped_kind",
    "skipped_kind",
    "skipped_too_large",
    "stored",
    "stored",
    "skipped_message_cap",
  ]);
  const eleven = Array.from({ length: 11 }, (_, i) => file(`f${i}`, 1000));
  assertEquals(
    attachmentDecisions(eleven, "sales").filter((d) => d.decision === "stored")
      .length,
    10,
  );
  assertEquals(
    attachmentDecisions(eleven, "sales")[10].decision,
    "skipped_message_cap",
  );
  assertEquals(
    attachmentDecisions([file("s", 10)], "ses")[0].decision,
    "skipped_scope",
  );
  assertEquals(ATTACHMENT_POLICY.maxFileBytes, 15 * MB);
});

Deno.test("file names are made safe for a storage path", () => {
  assertEquals(safeFileName("../../etc/passwd"), "etc_passwd");
  assertEquals(safeFileName("Quote #12 (final).pdf"), "Quote_12_final_.pdf");
  assertEquals(safeFileName(""), "attachment");
});

function fakeDeps(state: {
  list: OutlookAttachmentMeta[];
  existing?: string[];
  bodies?: Record<string, Uint8Array | "too_large" | "fail">;
}) {
  const ledger: AttachmentLedgerRow[] = [];
  const uploads: string[] = [];
  const reads: string[] = [];
  const deps: AttachmentDeps = {
    list: async () => state.list,
    existing: async () => new Set(state.existing ?? []),
    bytes: async (_home, id, max) => {
      reads.push(id);
      const b = state.bodies?.[id] ?? new Uint8Array([1, 2, 3]);
      if (b === "too_large") {
        throw Object.assign(new Error("x"), { code: "attachment_too_large" });
      }
      if (b === "fail") {
        throw Object.assign(new Error("x"), { code: "graph_503" });
      }
      if (b.byteLength > max) {
        throw Object.assign(new Error("x"), { code: "attachment_too_large" });
      }
      return b;
    },
    upload: async (path) => {
      uploads.push(path);
    },
    record: async (row) => {
      ledger.push(row);
    },
  };
  return { deps, ledger, uploads, reads };
}

Deno.test("stores files in the private bucket with a ledger row; skipped ones get their reason", async () => {
  const f = fakeDeps({
    list: [file("a", 3), file("logo", 10, { isInline: true })],
  });
  const r = await storeEmailAttachments(f.deps, {
    home: HOME,
    providerMessageId: "email:m1@x.example",
    businessEventId: "ev-1",
    scopeLabel: "sales",
  });
  assertEquals(r, {
    stored: 1,
    skipped: 1,
    already: 0,
    errors: 0,
    error_code: null,
  });
  const stored = f.ledger.find((l) => l.status === "stored")!;
  assertEquals(stored.storage_bucket, "context-email-attachments");
  assertEquals(stored.sha256, await sha256Hex(new Uint8Array([1, 2, 3])));
  assertEquals(stored.size_bytes, 3);
  assertEquals(stored.business_event_id, "ev-1");
  assertEquals(stored.attachment_key, await sha256Hex("a"));
  assertEquals(f.uploads, [stored.storage_path]);
  assertEquals(stored.storage_path!.endsWith("/a.pdf"), true);
  assertEquals(
    f.ledger.find((l) => l.status === "skipped_inline")!.storage_path,
    null,
  );
  assertEquals(f.reads, ["a"]); // the inline logo is never downloaded
});

Deno.test("an attachment already in the ledger is never read again (duplicate email, sweep, second mailbox)", async () => {
  const f = fakeDeps({
    list: [file("a", 3)],
    existing: [await sha256Hex("a")],
  });
  const r = await storeEmailAttachments(f.deps, {
    home: HOME,
    providerMessageId: "email:m1@x.example",
    businessEventId: null,
    scopeLabel: "sales",
  });
  assertEquals(r.already, 1);
  assertEquals(f.reads, []);
  assertEquals(f.ledger, []);
});

Deno.test("a file bigger than it said is refused at download and recorded skipped_too_large", async () => {
  const f = fakeDeps({ list: [file("a", 100)], bodies: { a: "too_large" } });
  const r = await storeEmailAttachments(f.deps, {
    home: HOME,
    providerMessageId: "email:m1@x.example",
    businessEventId: null,
    scopeLabel: "sales",
  });
  assertEquals(r.skipped, 1);
  assertEquals(f.ledger[0].status, "skipped_too_large");
  assertEquals(f.uploads, []);
});

Deno.test("a failed download writes no ledger row, so the next read retries it; other files go on", async () => {
  const f = fakeDeps({
    list: [file("a", 3), file("b", 3)],
    bodies: { a: "fail" },
  });
  const r = await storeEmailAttachments(f.deps, {
    home: HOME,
    providerMessageId: "email:m1@x.example",
    businessEventId: null,
    scopeLabel: "sales",
  });
  assertEquals(r, {
    stored: 1,
    skipped: 0,
    already: 0,
    errors: 1,
    error_code: "graph_503",
  });
  assertEquals(f.ledger.map((l) => l.attachment_key), [await sha256Hex("b")]);
});

Deno.test("a mailbox that refuses the attachment list counts one error and stores nothing", async () => {
  const f = fakeDeps({ list: [] });
  f.deps.list = () =>
    Promise.reject(Object.assign(new Error("x"), { code: "graph_403" }));
  const r = await storeEmailAttachments(f.deps, {
    home: HOME,
    providerMessageId: "email:m1@x.example",
    businessEventId: null,
    scopeLabel: "sales",
  });
  assertEquals(r, {
    stored: 0,
    skipped: 0,
    already: 0,
    errors: 1,
    error_code: "graph_403",
  });
});
