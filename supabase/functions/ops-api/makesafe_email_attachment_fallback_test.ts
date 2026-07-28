// Item 11 — sw_attach_email_attachment_to_job resolves ANY mailbox message.
//
// Before: the action only resolved the intake-sync email_attachments table (which
// holds INBOUND builder WOs from watched senders only), so two real 2026-07-07
// cases 500'd — (a) our own OUTBOUND sent packs (Admin Sent Items are never in the
// inbound table) and (b) an inbound WO from Prime Notification Centre
// (noreply@notifications.primeeco.tech), a sender that was not watched.
//
// These tests prove:
//   * the code-level watched-sender floor matches the Prime notification channel;
//   * the pure Graph-attachment picker + mailbox-candidate resolver behave; and
//   * on a table miss the action falls through to a live Graph fetch and, when it
//     genuinely cannot resolve, raises a CLEAR typed error (400/404) rather than
//     the old opaque "no matching email_attachments row found" 500.
//
// Run: deno test --no-check --allow-env --allow-net=127.0.0.1 \
//   supabase/functions/ops-api/makesafe_email_attachment_fallback_test.ts
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  senderMatchesWatchedFloor,
  WATCHED_SENDER_FLOOR,
} from "../_shared/makesafe_intake_classification.ts";
import {
  _attachEmailAttachmentToJobForTest,
  _pickGraphAttachmentForTest,
  _resolveMailboxCandidatesForTest,
} from "./index.ts";

// ── Watched-sender floor (item 11b) ───────────────────────────────────────────
Deno.test("watched-sender floor matches observed builder channels, not lookalikes", () => {
  assert(senderMatchesWatchedFloor("noreply@notifications.primeeco.tech"));
  assert(senderMatchesWatchedFloor("MLB.Mailer@Notifications.PrimeEco.Tech")); // case-insensitive
  assert(senderMatchesWatchedFloor("human@mlbuilders.com.au"));
  assert(senderMatchesWatchedFloor("workorders@ajs.build"));
  assert(senderMatchesWatchedFloor("accounts@builderwest.com.au"));
  assert(senderMatchesWatchedFloor("dispatch@westernbuild.com.au"));
  // Anchored domain match — a lookalike domain must NOT drift in.
  assertEquals(senderMatchesWatchedFloor("noreply@notifications.primeeco.tech.evil.test"), false);
  assertEquals(senderMatchesWatchedFloor("spoof@evilmlbuilders.com.au"), false);
  assertEquals(senderMatchesWatchedFloor("someone@primeeco.tech"), false); // parent domain, not the channel
  assertEquals(senderMatchesWatchedFloor(""), false);
  assertEquals(senderMatchesWatchedFloor(null), false);
  assert(WATCHED_SENDER_FLOOR.includes("notifications.primeeco.tech"));
  assert(WATCHED_SENDER_FLOOR.includes("mlbuilders.com.au"));
});

// ── pickGraphAttachment (pure) ────────────────────────────────────────────────
const att = (o: Record<string, unknown>) => o as any;

Deno.test("pickGraphAttachment: explicit id wins, then name, then PDF, then first", () => {
  const list = [
    att({ id: "a1", name: "cover.txt", contentType: "text/plain", contentBytes: "AA" }),
    att({ id: "a2", name: "WorkOrder.pdf", contentType: "application/pdf", contentBytes: "BB" }),
    att({ id: "a3", name: "photo.jpg", contentType: "image/jpeg", contentBytes: "CC" }),
  ];
  assertEquals(_pickGraphAttachmentForTest(list, { attachmentId: "a3" })?.id, "a3");
  assertEquals(_pickGraphAttachmentForTest(list, { fileName: "workorder.pdf" })?.id, "a2");
  assertEquals(_pickGraphAttachmentForTest(list, {})?.id, "a2"); // first PDF
});

Deno.test("pickGraphAttachment: skips attachments with no inline bytes; null when none eligible", () => {
  assertEquals(
    _pickGraphAttachmentForTest([att({ id: "x", name: "big.pdf" })], {}), // no contentBytes
    null,
  );
  assertEquals(_pickGraphAttachmentForTest([], {}), null);
  assertEquals(_pickGraphAttachmentForTest(null, {}), null);
  // First eligible when no PDF and no id/name hint.
  const list = [att({ id: "i", name: "a.jpg", contentBytes: "ZZ" })];
  assertEquals(_pickGraphAttachmentForTest(list, {})?.id, "i");
});

// ── resolveMailboxCandidates (pure) ───────────────────────────────────────────
Deno.test("resolveMailboxCandidates: caller wins, then emails row, then defaults; deduped + lowercased", () => {
  assertEquals(
    _resolveMailboxCandidatesForTest("Admin@SecureWorksWA.com.au", null),
    ["admin@secureworkswa.com.au", "ses@secureworkswa.com.au"],
  );
  assertEquals(
    _resolveMailboxCandidatesForTest(null, "bunbury@x.com"),
    ["bunbury@x.com", "ses@secureworkswa.com.au", "admin@secureworkswa.com.au"],
  );
  // No hints → just the documented defaults, in order.
  assertEquals(
    _resolveMailboxCandidatesForTest(null, null),
    ["ses@secureworkswa.com.au", "admin@secureworkswa.com.au"],
  );
});

// ── Fallback orchestration: a table miss no longer 500s ───────────────────────
// Stub admin client whose email_attachments + emails lookups both miss.
function missAdminClient() {
  function builder() {
    const b: any = {
      select: () => b,
      eq: () => b,
      order: () => Promise.resolve({ data: [], error: null }),
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
    };
    return b;
  }
  return { from: () => builder() };
}

Deno.test("fallback: no synced row + no message id → clear 400 (not an opaque 500)", async () => {
  let status = 0, msg = "";
  try {
    await _attachEmailAttachmentToJobForTest(
      {}, // client (never reached)
      { job_id: "job-1", email_attachment_id: "missing-id" },
      { adminClient: missAdminClient() },
    );
  } catch (e: any) {
    status = e?.status ?? 0;
    msg = e?.message ?? "";
  }
  assertEquals(status, 400);
  assert(msg.includes("fetch the attachment live"), `unexpected: ${msg}`);
});

Deno.test("fallback: OUTBOUND sent pack (not in table) → live Graph fetch tried across mailboxes", async () => {
  const tried: string[] = [];
  let status = 0, msg = "";
  try {
    await _attachEmailAttachmentToJobForTest(
      {},
      { job_id: "job-1", message_id: "AAMkGraphMsgId", file_name: "Make Safe Report.pdf" },
      {
        adminClient: missAdminClient(),
        // Simulate the message existing in no mailbox we can read (all fail).
        fetchGraphAttachments: (mailbox: string) => {
          tried.push(mailbox);
          return Promise.resolve({ ok: false as const, status: 404, error: "not found" });
        },
      },
    );
  } catch (e: any) {
    status = e?.status ?? 0;
    msg = e?.message ?? "";
  }
  // It fell THROUGH to the Graph fallback (old code threw before ever trying).
  assertEquals(tried, ["ses@secureworkswa.com.au", "admin@secureworkswa.com.au"]);
  assertEquals(status, 404);
  assert(msg.includes("AAMkGraphMsgId"), `unexpected: ${msg}`);
});

Deno.test("fallback: message resolves but carries no eligible attachment → 404 naming the message", async () => {
  let status = 0, msg = "";
  try {
    await _attachEmailAttachmentToJobForTest(
      {},
      { job_id: "job-1", email_id: "msg-77", mailbox: "admin@secureworkswa.com.au" },
      {
        adminClient: missAdminClient(),
        fetchGraphAttachments: () =>
          Promise.resolve({ ok: true as const, attachments: [att({ id: "z", name: "note.txt" })] }), // no contentBytes
      },
    );
  } catch (e: any) {
    status = e?.status ?? 0;
    msg = e?.message ?? "";
  }
  assertEquals(status, 404);
  assert(msg.includes("no eligible"), `unexpected: ${msg}`);
});
