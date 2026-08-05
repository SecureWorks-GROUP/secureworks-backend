// deno-lint-ignore-file no-explicit-any
import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  assertSesPhotoMailVolumeFits,
  base64EncodedLength,
  evaluateSesPhotoMailVolume,
  estimateAttachmentGraphCalls,
  formatByteCount,
  GRAPH_ATTACHMENT_DIRECT_POST_MAX_BYTES,
  GRAPH_ATTACHMENT_UPLOAD_SESSION_MAX_BYTES,
  GRAPH_DEFAULT_MESSAGE_SIZE_LIMIT_BYTES,
  PHOTO_MAIL_VOLUME_EXCEEDS_GRAPH_LIMIT,
  resolveSesMailTransport,
  resolveSesMailTransportForPrepare,
  sesPhotoMailVolumeBlocker,
  sesPhotoMailVolumeRefusal,
} from "./ses_photo_mail_volume_guard.ts";
import { createSesGraphMailGateway } from "./ses_graph_mail_gateway.ts";

function nBytes(n: number, name = "photo.jpg"): { name: string; size_bytes: number } {
  return { name, size_bytes: n };
}

Deno.test("base64EncodedLength matches RFC 4648 padded length", () => {
  assertEquals(base64EncodedLength(0), 0);
  assertEquals(base64EncodedLength(1), 4);
  assertEquals(base64EncodedLength(2), 4);
  assertEquals(base64EncodedLength(3), 4);
  assertEquals(base64EncodedLength(4), 8);
  assertEquals(base64EncodedLength(3 * 1024 * 1024), 4 * 1024 * 1024);
});

Deno.test("formatByteCount is human-readable", () => {
  assertEquals(formatByteCount(512), "512 B");
  assertStringIncludes(formatByteCount(10 * 1024), "KiB");
  assertStringIncludes(formatByteCount(31 * 1024 * 1024), "MiB");
});

Deno.test("resolveSesMailTransport: thread reply vs user mailbox", () => {
  assertEquals(
    resolveSesMailTransport({ reply_to_thread_id: "t1" }),
    "group_thread_reply",
  );
  assertEquals(
    resolveSesMailTransport({ requires_thread_reply: true }),
    "group_thread_reply",
  );
  assertEquals(resolveSesMailTransport({}), "user_mailbox");
});

Deno.test("resolveSesMailTransportForPrepare: MLB physical photo is group thread", () => {
  assertEquals(
    resolveSesMailTransportForPrepare({
      builder_key: "MLB",
      family: "physical_makesafe",
      route_kind: "photo",
    }),
    "group_thread_reply",
  );
  assertEquals(
    resolveSesMailTransportForPrepare({
      builder_key: "AJ",
      family: "physical_makesafe",
      route_kind: "photo",
    }),
    "user_mailbox",
  );
  assertEquals(
    resolveSesMailTransportForPrepare({
      builder_key: "MLB",
      family: "physical_makesafe",
      route_kind: "invoice",
    }),
    "user_mailbox",
  );
});

Deno.test("user mailbox: 70 ~450 KiB photos (~31 MiB) passes under 35 MiB default", () => {
  const per = Math.floor((31 * 1024 * 1024) / 70);
  const attachments = Array.from({ length: 70 }, (_, i) =>
    nBytes(per, `photo-${i + 1}.jpg`)
  );
  const verdict = evaluateSesPhotoMailVolume(attachments, "user_mailbox");
  assertEquals(verdict.ok, true);
  if (verdict.ok) {
    assertEquals(verdict.attachment_count, 70);
    assert(verdict.total_raw_bytes < GRAPH_DEFAULT_MESSAGE_SIZE_LIMIT_BYTES);
    // Sequential attachment POSTs: one per file under 3 MB.
    assertEquals(verdict.estimated_attachment_graph_calls, 70);
  }
});

Deno.test("user mailbox: total raw over 35 MiB refuses with named code and sizes", () => {
  const attachments = [
    nBytes(20 * 1024 * 1024, "a.jpg"),
    nBytes(16 * 1024 * 1024, "b.jpg"),
  ];
  const verdict = evaluateSesPhotoMailVolume(attachments, "user_mailbox");
  assertEquals(verdict.ok, false);
  if (!verdict.ok) {
    assertEquals(verdict.code, PHOTO_MAIL_VOLUME_EXCEEDS_GRAPH_LIMIT);
    assertEquals(verdict.exceeded, "message_total");
    assertEquals(
      verdict.message_size_limit_bytes,
      GRAPH_DEFAULT_MESSAGE_SIZE_LIMIT_BYTES,
    );
    assertEquals(verdict.total_raw_bytes, 36 * 1024 * 1024);
    assertStringIncludes(verdict.reason, "36.00 MiB");
    assertStringIncludes(verdict.reason, "35.00 MiB");
    assertStringIncludes(verdict.reason, "not culled");
    assertStringIncludes(verdict.recommendation, "split");
    // Guard never implies cull.
    const blocker = sesPhotoMailVolumeBlocker(verdict);
    assertEquals(blocker.reason_code, PHOTO_MAIL_VOLUME_EXCEEDS_GRAPH_LIMIT);
    assertEquals(blocker.facts?.photo_cull, false);
    const refusal = sesPhotoMailVolumeRefusal(verdict);
    assertEquals(refusal.code, PHOTO_MAIL_VOLUME_EXCEEDS_GRAPH_LIMIT);
    assertEquals(refusal.state, "refused");
    assertEquals(refusal.evidence?.photo_cull, false);
  }
});

Deno.test("group thread: single attachment over 3 MiB refuses (no upload session)", () => {
  const verdict = evaluateSesPhotoMailVolume(
    [nBytes(GRAPH_ATTACHMENT_DIRECT_POST_MAX_BYTES + 1, "big.jpg")],
    "group_thread_reply",
  );
  assertEquals(verdict.ok, false);
  if (!verdict.ok) {
    assertEquals(verdict.exceeded, "group_post_no_upload_session");
    assertEquals(
      verdict.per_attachment_limit_bytes,
      GRAPH_ATTACHMENT_DIRECT_POST_MAX_BYTES,
    );
    assertStringIncludes(verdict.reason, "group-post");
  }
});

Deno.test("group thread: base64 wire size over message ceiling refuses", () => {
  // 28 MiB raw → ~37.3 MiB base64 > 35 MiB message limit
  const raw = 28 * 1024 * 1024;
  const verdict = evaluateSesPhotoMailVolume(
    [nBytes(raw, "pack.jpg")],
    "group_thread_reply",
  );
  // 28 MiB < 3 MiB? No - 28 MiB is over per-attachment 3 MiB first.
  assertEquals(verdict.ok, false);
  if (!verdict.ok) {
    assertEquals(verdict.exceeded, "group_post_no_upload_session");
  }

  // Many small files whose base64 sum exceeds 35 MiB
  const per = 500 * 1024; // 500 KiB each, under 3 MiB
  const count = 80; // 40 MiB raw → ~53 MiB base64
  const many = Array.from({ length: count }, (_, i) =>
    nBytes(per, `p${i}.jpg`)
  );
  const manyVerdict = evaluateSesPhotoMailVolume(many, "group_thread_reply");
  assertEquals(manyVerdict.ok, false);
  if (!manyVerdict.ok) {
    assertEquals(manyVerdict.exceeded, "message_total");
    assert(manyVerdict.total_base64_bytes > GRAPH_DEFAULT_MESSAGE_SIZE_LIMIT_BYTES);
  }
});

Deno.test("user mailbox allows a single file between 3 MiB and 150 MiB", () => {
  const size = 10 * 1024 * 1024;
  const verdict = evaluateSesPhotoMailVolume(
    [nBytes(size, "large.pdf")],
    "user_mailbox",
  );
  assertEquals(verdict.ok, true);
  if (verdict.ok) {
    assertEquals(
      verdict.per_attachment_limit_bytes,
      GRAPH_ATTACHMENT_UPLOAD_SESSION_MAX_BYTES,
    );
    // createUploadSession + chunk PUTs
    assert(verdict.estimated_attachment_graph_calls >= 2);
  }
});

Deno.test("user mailbox refuses a single file over 150 MiB", () => {
  const verdict = evaluateSesPhotoMailVolume(
    [nBytes(GRAPH_ATTACHMENT_UPLOAD_SESSION_MAX_BYTES + 1, "huge.bin")],
    "user_mailbox",
  );
  assertEquals(verdict.ok, false);
  if (!verdict.ok) {
    assertEquals(verdict.exceeded, "per_attachment");
  }
});

Deno.test("estimateAttachmentGraphCalls: sequential per-file posts explain ~70 calls", () => {
  const sizes = Array.from({ length: 70 }, () => 400 * 1024);
  assertEquals(estimateAttachmentGraphCalls("user_mailbox", sizes), 70);
  assertEquals(estimateAttachmentGraphCalls("group_thread_reply", sizes), 1);
});

Deno.test("assertSesPhotoMailVolumeFits throws named code before any caller Graph work", () => {
  assertThrows(
    () =>
      assertSesPhotoMailVolumeFits(
        [{
          name: "a.jpg",
          bytes: new Uint8Array(20 * 1024 * 1024),
        }, {
          name: "b.jpg",
          bytes: new Uint8Array(16 * 1024 * 1024),
        }],
        "user_mailbox",
      ),
    Error,
    PHOTO_MAIL_VOLUME_EXCEEDS_GRAPH_LIMIT,
  );
});

Deno.test("gateway createDraftAndSend refuses oversized pack before Graph", async () => {
  let graphCalled = false;
  const gateway = createSesGraphMailGateway({
    graphJson: async () => {
      graphCalled = true;
      throw new Error("graph must not be called");
    },
    loadAttachments: async () => [{
      name: "a.jpg",
      contentType: "image/jpeg",
      bytes: new Uint8Array(20 * 1024 * 1024),
    }, {
      name: "b.jpg",
      contentType: "image/jpeg",
      bytes: new Uint8Array(16 * 1024 * 1024),
    }],
    checkpointDraft: async () => {
      throw new Error("checkpoint must not run");
    },
    uploadAttachment: async () => {
      throw new Error("upload must not run");
    },
  });
  let failed = false;
  try {
    await gateway.createDraftAndSend(
      {
        subject: "Photos",
        body: "Photo pack",
        recipients: ["workorders@ajs.build"],
        cc: ["ses@secureworkswa.com.au"],
        attachment_hashes: ["h1", "h2"],
      },
      { external_token: "SES-volume-test", operation_key: "op-volume" },
    );
  } catch (err) {
    failed = true;
    assertStringIncludes(
      String((err as Error).message),
      PHOTO_MAIL_VOLUME_EXCEEDS_GRAPH_LIMIT,
    );
  }
  assertEquals(failed, true);
  assertEquals(graphCalled, false);
});

Deno.test("gateway createDraftAndSend refuses oversized group-thread pack before Graph", async () => {
  let graphCalled = false;
  const gateway = createSesGraphMailGateway({
    graphJson: async () => {
      graphCalled = true;
      throw new Error("graph must not be called");
    },
    loadAttachments: async () => [{
      name: "big.jpg",
      contentType: "image/jpeg",
      // Over group-post 3 MB per-file limit
      bytes: new Uint8Array(GRAPH_ATTACHMENT_DIRECT_POST_MAX_BYTES + 100),
    }],
    checkpointDraft: async () => {
      throw new Error("checkpoint must not run");
    },
    uploadAttachment: async () => {
      throw new Error("upload must not run");
    },
    resolveIntakeGroupId: async () => "group-1",
  });
  let failed = false;
  try {
    await gateway.createDraftAndSend(
      {
        subject: "Photos",
        body: "Photo pack",
        recipients: ["site@mlb.example"],
        attachment_hashes: ["h1"],
        reply_to_thread_id: "thread-1",
        requires_thread_reply: true,
      },
      { external_token: "SES-volume-thread", operation_key: "op-thread-vol" },
    );
  } catch (err) {
    failed = true;
    assertStringIncludes(
      String((err as Error).message),
      PHOTO_MAIL_VOLUME_EXCEEDS_GRAPH_LIMIT,
    );
  }
  assertEquals(failed, true);
  assertEquals(graphCalled, false);
});
