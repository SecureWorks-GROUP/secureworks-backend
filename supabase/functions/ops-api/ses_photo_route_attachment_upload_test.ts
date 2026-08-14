// Regression coverage for the MLB physical / MakeSafe photo-route HTTP 546
// (Supabase Edge worker resource limit) diagnosed 2026-08-14.
//
// Root cause: uploadSesGraphAttachment (index.ts) base64-encodes every
// sub-3MB attachment via _bytesToBase64, which used a naive per-byte
// `String.fromCharCode` + string-concat loop instead of the already-proven
// chunked bytesToBase64 defined a few thousand lines earlier in the same
// file (added specifically because the naive form "blows the call stack on
// large PDFs" per its own comment). The photo route calls this once per
// photo, sequentially, inside one edge isolate — a realistic 40-70 photo
// MakeSafe pack (production heaviest pins: 43 photos/14.5MB,
// 51 photos/33.5MB, 69 photos/27.9MB — all individually well under Graph's
// 3MB per-file ceiling, so the pre-Graph volume guard does not and should
// not refuse them) burned enough CPU/memory in that loop to hit the
// isolate's resource ceiling and get killed mid-send (HTTP 546), after the
// draft had already been checkpointed but before /send — see
// docs/evidence/ses-makesafe-photo-route-546-2026-08-14.md.
//
// _bytesToBase64 now delegates to the chunked bytesToBase64. These tests
// pin correctness and a generous performance ceiling at the realistic
// production pack size so a regression back to the naive loop fails loudly
// here instead of silently in production. No network call is made; Graph
// is stubbed throughout (never send real emails from tests).

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { _bytesToBase64, bytesToBase64 } from "./index.ts";
import { createSesGraphMailGateway } from "./ses_graph_mail_gateway.ts";

function decodeBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Deno std assertEquals does a slow recursive deep-compare on large typed
// arrays (multiple seconds at MB scale) that has nothing to do with
// bytesToBase64's own cost, so it would corrupt these timing-sensitive
// assertions. Use a fast manual comparison for the large-buffer checks.
function assertBytesEqual(
  actual: Uint8Array,
  expected: Uint8Array,
  msg: string,
) {
  assertEquals(actual.length, expected.length, msg);
  for (let i = 0; i < expected.length; i++) {
    if (actual[i] !== expected[i]) {
      throw new Error(`${msg}: byte mismatch at index ${i}`);
    }
  }
}

/** Deterministic pseudo-random bytes so photo content differs (no all-zero
 * buffer that would trivially compress/short-circuit any accidental fast path). */
function pseudoRandomBytes(size: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(size);
  let state = seed >>> 0;
  for (let i = 0; i < size; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    bytes[i] = state & 0xff;
  }
  return bytes;
}

Deno.test("_bytesToBase64 (the exact function uploadSesGraphAttachment calls) delegates to the chunked bytesToBase64", () => {
  const bytes = pseudoRandomBytes(1024, 7);
  assertEquals(_bytesToBase64(bytes), bytesToBase64(bytes));
});

Deno.test("_bytesToBase64 round-trips a realistic single photo (2.9 MB, just under the 3 MB direct-post ceiling)", () => {
  const bytes = pseudoRandomBytes(2.9 * 1024 * 1024, 42);
  const encoded = _bytesToBase64(bytes);
  assertBytesEqual(decodeBase64(encoded), bytes, "single photo round-trip");
});

Deno.test("_bytesToBase64 encodes a realistic 43-photo MakeSafe pack (~14.5 MB, matching the production 546 repro) within a generous time budget", () => {
  // Mirrors the real job whose route_send effect stuck in `dispatching`
  // (draft checkpointed, never sent) immediately before an HTTP 546 in
  // production edge logs on 2026-08-13: 43 artifacts / 14,483,314 bytes.
  // _bytesToBase64 is the exact function uploadSesGraphAttachment calls per
  // attachment on the SES photo/report/invoice upload path.
  const photoCount = 43;
  const totalBytes = 14_483_314;
  const perPhoto = Math.floor(totalBytes / photoCount);

  const photos = Array.from(
    { length: photoCount },
    (_, i) => pseudoRandomBytes(perPhoto, i + 1),
  );

  // Time only the encode loop — this is the actual work the photo route
  // performs sequentially inside one edge isolate. Correctness is checked
  // separately, outside the timed section.
  const started = performance.now();
  const encoded = photos.map((bytes) => _bytesToBase64(bytes));
  const elapsedMs = performance.now() - started;

  encoded.forEach((b64, i) => {
    assertBytesEqual(decodeBase64(b64), photos[i], `photo ${i} round-trip`);
  });

  // The naive per-byte String.fromCharCode + concat loop this replaces was
  // slow enough to contribute to a production worker-limit kill; the
  // chunked implementation clears this pack in a couple hundred
  // milliseconds. 3s is a generous CI-safe ceiling that still fails hard on
  // a regression back to the naive per-character loop.
  assert(
    elapsedMs < 3000,
    `encoding a realistic 43-photo pack took ${elapsedMs}ms — regression toward the naive per-byte base64 loop that caused the production HTTP 546`,
  );
});

Deno.test("photo route: createDraftAndSend completes a realistic 43-attachment pack without a real network call", async () => {
  const token = "SES-photo-route-546-regression";
  const uploaded: Array<{ name: string; bytes: number }> = [];
  let draftSent = false;

  // Mirrors uploadSesGraphAttachment's direct-POST branch (every attachment
  // here is under 3MB, same as the real production pack): base64-encode via
  // the fixed helper, then a stubbed Graph POST. No fetch, no real mailbox.
  const uploadAttachment = async (
    _mailbox: string,
    _messageId: string,
    attachment: { name: string; contentType: string; bytes: Uint8Array },
  ) => {
    const encoded = _bytesToBase64(attachment.bytes);
    assert(encoded.length > 0);
    uploaded.push({
      name: attachment.name,
      bytes: attachment.bytes.byteLength,
    });
  };

  const graphJson = async (
    url: string,
    init: RequestInit,
    expected: number[],
  ) => {
    const method = String(init.method || "GET").toUpperCase();
    if (
      method === "POST" && url.endsWith("/messages") && !url.includes("/send")
    ) {
      assert(expected.includes(201));
      return { id: "draft-photo-1" };
    }
    if (method === "POST" && url.endsWith("/send")) {
      draftSent = true;
      assert(expected.includes(202));
      return null;
    }
    if (method === "GET" && url.includes("mailFolders/sentitems")) {
      if (!draftSent) return { value: [] };
      return {
        value: [{
          id: "sent-photo-1",
          internetMessageId: "<photo-pack@example>",
          subject: "Photo Evidence",
          internetMessageHeaders: [{
            name: "x-secureworks-ses-operation",
            value: token,
          }],
        }],
      };
    }
    if (method === "GET" && url.includes("mailFolders/drafts")) {
      return { value: [] };
    }
    throw new Error(`unexpected graph call ${method} ${url}`);
  };

  const photoCount = 43;
  const totalBytes = 14_483_314;
  const perPhoto = Math.floor(totalBytes / photoCount);
  const hashes = Array.from({ length: photoCount }, (_, i) => `hash-${i}`);

  const gateway = createSesGraphMailGateway({
    graphJson: graphJson as any,
    loadAttachments: async () =>
      hashes.map((hash, i) => ({
        name: `${hash}.jpg`,
        contentType: "image/jpeg",
        bytes: pseudoRandomBytes(perPhoto, i + 1),
      })),
    checkpointDraft: async () => {},
    uploadAttachment,
    sentPollAttempts: 3,
    sentPollDelayMs: 1,
  });

  const started = performance.now();
  const sent = await gateway.createDraftAndSend(
    {
      subject: "Photo Evidence",
      body: "Photos attached.",
      recipients: ["mlb.mailer@primeeco.tech"],
      cc: [],
      attachment_hashes: hashes,
    },
    { external_token: token, operation_key: "op-photo-1" },
  );
  const elapsedMs = performance.now() - started;

  assertEquals(sent.message_id, "sent-photo-1");
  assertEquals(uploaded.length, photoCount);
  assert(draftSent);
  assert(
    elapsedMs < 5000,
    `photo route send took ${elapsedMs}ms for a realistic 43-photo pack — regression risk toward the production HTTP 546`,
  );
});
