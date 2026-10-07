// Slice EM2: attachment size limits, skip reasons and idempotence.
// deno-lint-ignore-file no-import-prefix require-await
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { OutlookAttachmentMeta } from "../_shared/evidence/outlook_mail.ts";
import {
  ATTACHMENT_POLICY,
  attachmentDecisions,
  type AttachmentDeps,
  type AttachmentLedgerRow,
  type AttachmentStatus,
  failureKey,
  hasOpenFailure,
  LIST_FAILURE_KEY,
  safeFileName,
  sha256Hex,
  storeEmailAttachments,
} from "./attachments.ts";
import type { AttachmentHome, ListedAttachment } from "./graph.ts";

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
  list: ListedAttachment[];
  existing?: string[];
  /** The sha-256 of files another copy of the email already stored. */
  storedHashes?: string[];
  bodies?: Record<
    string,
    Uint8Array | "too_large" | "fail" | "no_content"
  >;
}) {
  const ledger: AttachmentLedgerRow[] = [];
  const uploads: string[] = [];
  const reads: string[] = [];
  const lists: string[] = [];
  const deps: AttachmentDeps = {
    list: async (home) => {
      lists.push(home.kind);
      return state.list;
    },
    // What the ledger holds for the email: the given keys (stored) plus every
    // row written, with its status.
    existing: async () =>
      new Map<string, AttachmentStatus>([
        ...(state.existing ?? []).map((k) =>
          [k, "stored"] as [string, AttachmentStatus]
        ),
        ...ledger.map((l) =>
          [l.attachment_key, l.status] as [string, AttachmentStatus]
        ),
      ]),
    // The files stored for the email under any copy: the seeded hashes plus
    // every stored row written.
    storedHashes: async () =>
      new Set<string>([
        ...(state.storedHashes ?? []),
        ...ledger.filter((l) => l.status === "stored" && l.sha256).map((l) =>
          l.sha256!
        ),
      ]),
    bytes: async (_home, a, max) => {
      reads.push(a.id);
      const b = state.bodies?.[a.id] ?? new Uint8Array([1, 2, 3]);
      if (b === "too_large") {
        throw Object.assign(new Error("x"), { code: "attachment_too_large" });
      }
      if (b === "fail") {
        throw Object.assign(new Error("x"), { code: "graph_503" });
      }
      if (b === "no_content") {
        throw Object.assign(new Error("x"), { code: "attachment_no_content" });
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
      // The ledger's one-row-per-key rule: a repeat is ignored.
      if (
        !ledger.some((l) =>
          l.provider_message_id === row.provider_message_id &&
          l.attachment_key === row.attachment_key
        )
      ) ledger.push(row);
    },
  };
  return { deps, ledger, uploads, reads, lists };
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

// Lanes health (6 Oct 2026): a failure used to write nothing, so every poll
// tried again (finance@ 82 failed attempts in a day, the code logged nowhere).
// Now a failed file is recorded once with its code, polls leave it, and the
// nightly sweep and history runs (recheck) try it again.
Deno.test("a failed download is recorded once with its code; a poll does not try it again; a recheck does and stores it", async () => {
  const f = fakeDeps({
    list: [file("a", 3), file("b", 3)],
    bodies: { a: "fail" },
  });
  const args = {
    home: HOME,
    providerMessageId: "email:m1@x.example",
    businessEventId: "ev-1",
    scopeLabel: "sales",
  };
  const r = await storeEmailAttachments(f.deps, args);
  assertEquals(r, {
    stored: 1,
    skipped: 0,
    already: 0,
    errors: 1,
    error_code: "graph_503",
  });
  const keyA = await sha256Hex("a");
  const failed = f.ledger.find((l) => l.status === "failed")!;
  assertEquals(failed.attachment_key, await failureKey(keyA));
  assertEquals(failed.attachment_key, await sha256Hex(`failed:${keyA}`));
  assertEquals(failed.error_code, "graph_503");
  assertEquals(failed.storage_path, null);
  assertEquals(failed.business_event_id, "ev-1");
  assertEquals(failed.file_name, "a.pdf");
  assertEquals(
    f.ledger.find((l) => l.status === "stored")!.attachment_key,
    await sha256Hex("b"),
  );
  // Rows that are not failures carry no error_code key at all.
  assertEquals(
    "error_code" in f.ledger.find((l) => l.status === "stored")!,
    false,
  );

  // The next poll: nothing is downloaded again and no new error is counted.
  const again = await storeEmailAttachments(f.deps, args);
  assertEquals(again.errors, 0);
  assertEquals(again.already, 2);
  assertEquals(f.reads, ["a", "b"]);

  // The nightly sweep (recheck): it is tried again; a second failure adds no row.
  const stillFailing = await storeEmailAttachments(f.deps, {
    ...args,
    recheck: true,
  });
  assertEquals(stillFailing.errors, 1);
  assertEquals(f.reads, ["a", "b", "a"]);
  assertEquals(f.ledger.length, 2);

  // It works on a later recheck: the file is stored; the failure stays as history.
  f.deps.bytes = async () => new Uint8Array([9]);
  const healed = await storeEmailAttachments(f.deps, {
    ...args,
    recheck: true,
  });
  assertEquals(healed.stored, 1);
  assertEquals(
    f.ledger.filter((l) => l.status === "stored").map((l) => l.attachment_key)
      .sort(),
    [keyA, await sha256Hex("b")].sort(),
  );
  assertEquals(f.ledger.filter((l) => l.status === "failed").length, 1);
});

Deno.test("a refused attachment list is recorded once with its code; polls do not ask again; a recheck does", async () => {
  const f = fakeDeps({ list: [] });
  let refuse = true;
  f.deps.list = (home) => {
    f.lists.push(home.kind);
    return refuse
      ? Promise.reject(Object.assign(new Error("x"), { code: "graph_403" }))
      : Promise.resolve([file("a", 3)]);
  };
  const args = {
    home: HOME,
    providerMessageId: "email:m1@x.example",
    businessEventId: null,
    scopeLabel: "sales",
  };
  const r = await storeEmailAttachments(f.deps, args);
  assertEquals(r, {
    stored: 0,
    skipped: 0,
    already: 0,
    errors: 1,
    error_code: "graph_403",
  });
  assertEquals(
    f.ledger.map((l) => [l.attachment_key, l.status, l.error_code]),
    [
      [LIST_FAILURE_KEY, "failed", "graph_403"],
    ],
  );
  assertEquals(LIST_FAILURE_KEY, await sha256Hex("failed:list"));
  const again = await storeEmailAttachments(f.deps, args);
  assertEquals(again.errors, 0);
  assertEquals(f.lists, ["message"]);
  refuse = false;
  const healed = await storeEmailAttachments(f.deps, {
    ...args,
    recheck: true,
  });
  assertEquals(healed.stored, 1);
  assertEquals(f.lists, ["message", "message"]);
});

Deno.test("ses@ attachments are never read from Microsoft (the make-safe intake stores them) and leave no row", async () => {
  const f = fakeDeps({ list: [file("a", 3)] });
  f.deps.existing = () => Promise.reject(new Error("ledger read for ses@"));
  for (const recheck of [false, true]) {
    const r = await storeEmailAttachments(f.deps, {
      home: { kind: "post", groupId: "G", threadId: "T", postId: "P" },
      providerMessageId: "email:s1@x.example",
      businessEventId: "ev-9",
      scopeLabel: "ses",
      recheck,
    });
    assertEquals(r, {
      stored: 0,
      skipped: 0,
      already: 0,
      errors: 0,
      error_code: null,
    });
  }
  assertEquals(f.lists, []);
  assertEquals(f.reads, []);
  assertEquals(f.ledger, []);
});

Deno.test("a group post already in the ledger is not read again (its read carries every file); a recheck reads it only to retry a failure", async () => {
  const POST: AttachmentHome = {
    kind: "post",
    groupId: "G",
    threadId: "T",
    postId: "P",
  };
  // Two different files (the same bytes would be one file stored once).
  const f = fakeDeps({
    list: [file("a", 3), file("b", 3)],
    bodies: { a: new Uint8Array([1, 2, 3]), b: new Uint8Array([4, 5, 6]) },
  });
  const args = {
    home: POST,
    providerMessageId: "email:p1@x.example",
    businessEventId: "ev-2",
    scopeLabel: "finance",
  };
  const first = await storeEmailAttachments(f.deps, args);
  assertEquals(first.stored, 2);
  // Neither the next poll nor the nightly sweep downloads the post again.
  for (const recheck of [false, true]) {
    const again = await storeEmailAttachments(f.deps, { ...args, recheck });
    assertEquals(again, {
      stored: 0,
      skipped: 0,
      already: 2,
      errors: 0,
      error_code: null,
    });
  }
  assertEquals(f.lists, ["post"]);
  assertEquals(f.reads, ["a", "b"]);

  // A member's mailbox copy of the email stored its files first (other
  // attachment ids): the group post does not store them a second time.
  const copy = fakeDeps({
    list: [file("a", 3)],
    existing: [await sha256Hex("m-a")],
  });
  const r = await storeEmailAttachments(copy.deps, { ...args, recheck: true });
  assertEquals(r.already, 1);
  assertEquals(copy.lists, []);

  // A post with a recorded failure: polls leave it; the sweep reads it again,
  // retries the failed file and leaves the stored one alone.
  const g = fakeDeps({
    list: [file("a", 3), file("b", 3)],
    bodies: { b: "fail" },
  });
  await storeEmailAttachments(g.deps, args);
  assertEquals(g.lists, ["post"]);
  await storeEmailAttachments(g.deps, args);
  assertEquals(g.lists, ["post"]);
  g.deps.bytes = async () => new Uint8Array([7]);
  const healed = await storeEmailAttachments(g.deps, {
    ...args,
    recheck: true,
  });
  assertEquals(g.lists, ["post", "post"]);
  assertEquals(healed, {
    stored: 1,
    skipped: 0,
    already: 1,
    errors: 0,
    error_code: null,
  });
  // Healed: the next sweep has nothing open and does not download it again.
  await storeEmailAttachments(g.deps, { ...args, recheck: true });
  assertEquals(g.lists, ["post", "post"]);
});

// Review round 3: polls read sources in source_key order, so a group
// (fencing@, finance@) is read before the personal mailboxes. An email to the
// group that also reached a member's own mailbox was stored twice: the
// member's copy lists the same files under other attachment ids. A file whose
// bytes (sha-256) are already stored for the same email is now recorded
// skipped_duplicate with its hash, and never uploaded a second time.
Deno.test("a file already stored for the email from another mailbox copy (same sha-256) is recorded skipped_duplicate, not stored again", async () => {
  const A = new Uint8Array([1, 1]);
  const B = new Uint8Array([2, 2]);
  const C = new Uint8Array([3, 3]);
  const POST: AttachmentHome = {
    kind: "post",
    groupId: "G",
    threadId: "T",
    postId: "P",
  };
  const f = fakeDeps({
    list: [file("p-a", 2), file("p-b", 2)],
    bodies: { "p-a": A, "p-b": B },
  });
  const email = "email:d1@x.example";
  const first = await storeEmailAttachments(f.deps, {
    home: POST,
    providerMessageId: email,
    businessEventId: "ev-5",
    scopeLabel: "finance",
  });
  assertEquals(first.stored, 2);
  assertEquals(f.uploads.length, 2);

  // The member's copy: other attachment ids, two of the same files and one new.
  f.deps.list = async () => [file("m-a", 2), file("m-b", 2), file("m-c", 2)];
  const memberBodies: Record<string, Uint8Array> = {
    "m-a": A,
    "m-b": B,
    "m-c": C,
  };
  f.deps.bytes = async (_home, a) => {
    f.reads.push(a.id);
    return memberBodies[a.id];
  };
  const copy = await storeEmailAttachments(f.deps, {
    home: HOME,
    providerMessageId: email,
    businessEventId: "ev-5",
    scopeLabel: "sales",
  });
  assertEquals(copy, {
    stored: 1,
    skipped: 2,
    already: 0,
    errors: 0,
    error_code: null,
  });
  assertEquals(f.uploads.length, 3, "only the new file reaches the store");
  const keyMA = await sha256Hex("m-a");
  const dupes = f.ledger.filter((l) => l.status === "skipped_duplicate");
  assertEquals(
    dupes.map((l) => l.attachment_key).sort(),
    [keyMA, await sha256Hex("m-b")].sort(),
  );
  for (const d of dupes) {
    assertEquals(d.storage_path, null);
    assertEquals(d.storage_bucket, null);
    assertEquals(d.business_event_id, "ev-5");
    assertEquals("error_code" in d, false);
  }
  // The skip row names the file it duplicates by its hash.
  assertEquals(
    dupes.find((l) => l.attachment_key === keyMA)!.sha256,
    await sha256Hex(A),
  );

  // The member copy read again (poll overlap, sweep): nothing downloaded again.
  const readsBefore = f.reads.length;
  const again = await storeEmailAttachments(f.deps, {
    home: HOME,
    providerMessageId: email,
    businessEventId: "ev-5",
    scopeLabel: "sales",
    recheck: true,
  });
  assertEquals(again.already, 3);
  assertEquals(f.reads.length, readsBefore);

  // The same file attached twice to one email is stored once.
  const twice = fakeDeps({
    list: [file("x1", 2), file("x2", 2)],
    bodies: { x1: C, x2: C },
  });
  const r = await storeEmailAttachments(twice.deps, {
    home: HOME,
    providerMessageId: "email:d2@x.example",
    businessEventId: null,
    scopeLabel: "sales",
  });
  assertEquals([r.stored, r.skipped], [1, 1]);
  assertEquals(twice.uploads.length, 1);
  assertEquals(
    twice.ledger.find((l) => l.status === "skipped_duplicate")!.attachment_key,
    await sha256Hex("x2"),
  );

  // Another email's file with the same bytes is not this email's copy.
  const other = fakeDeps({
    list: [file("o1", 2)],
    bodies: { o1: A },
    storedHashes: [],
  });
  const o = await storeEmailAttachments(other.deps, {
    home: HOME,
    providerMessageId: "email:d3@x.example",
    businessEventId: null,
    scopeLabel: "sales",
  });
  assertEquals(o.stored, 1);
});

Deno.test("an open failure is one nothing has healed since", async () => {
  const k = await sha256Hex("a");
  const rows = (entries: Array<[string, AttachmentStatus]>) =>
    new Map<string, AttachmentStatus>(entries);
  assertEquals(await hasOpenFailure(rows([])), false);
  assertEquals(await hasOpenFailure(rows([[k, "stored"]])), false);
  assertEquals(
    await hasOpenFailure(rows([[await failureKey(k), "failed"]])),
    true,
  );
  assertEquals(
    await hasOpenFailure(
      rows([[await failureKey(k), "failed"], [k, "stored"]]),
    ),
    false,
  );
  assertEquals(
    await hasOpenFailure(
      rows([[await failureKey(k), "failed"], [k, "skipped_no_content"]]),
    ),
    false,
  );
  assertEquals(
    await hasOpenFailure(rows([[LIST_FAILURE_KEY, "failed"]])),
    true,
  );
  assertEquals(
    await hasOpenFailure(rows([[LIST_FAILURE_KEY, "failed"], [k, "stored"]])),
    false,
  );
});

Deno.test("a group file Microsoft sent without its bytes is recorded skipped_no_content, not retried", async () => {
  const f = fakeDeps({
    list: [file("big", 9_000_000), file("small", 3)],
    bodies: { big: "no_content" },
  });
  const r = await storeEmailAttachments(f.deps, {
    home: { kind: "post", groupId: "G", threadId: "T", postId: "P" },
    providerMessageId: "email:p2@x.example",
    businessEventId: null,
    scopeLabel: "patios",
    recheck: true,
  });
  assertEquals(r, {
    stored: 1,
    skipped: 1,
    already: 0,
    errors: 0,
    error_code: null,
  });
  const row = f.ledger.find((l) => l.status === "skipped_no_content")!;
  assertEquals(row.attachment_key, await sha256Hex("big"));
  assertEquals(row.storage_path, null);
});
