// ════════════════════════════════════════════════════════════
// MAKE-SAFE GROUP-POST FIXTURES (Mission makesafe-live-truth-2026-06-14)
// ════════════════════════════════════════════════════════════
//
// ⚠️ TODO(integration-validation): these are REPRESENTATIVE fixtures, built from
// the documented Graph Groups conversations/threads/posts shape — NOT real
// captured ses@ payloads. MISSION.md requires real captured group-post payloads
// to be committed here before deploy approval (the integration-validation step),
// to resolve the open unknown of whether `internetMessageId` is present on group
// posts and the real attachment shape. Replace these with the captured payloads
// at that step; the parser/matcher tests below should then re-run unchanged.
//
// The four pinned regression refs (Erskine 67200, Alexander Heights 67005,
// Tapping 67134, Bassendean 67166) are represented so the classifier + recon can
// be exercised against them.

// A minimal Graph group "post" shape (mirrors GraphPost in monitor-ses-makesafes).
export interface FxPost {
  id: string;
  internetMessageId?: string; // presence UNCONFIRMED on group posts — read defensively
  conversationId?: string;
  conversationThreadId?: string;
  createdDateTime?: string;
  receivedDateTime?: string;
  from?: { emailAddress?: { address?: string; name?: string } };
  subject?: string;
  hasAttachments?: boolean;
  body?: { contentType?: string; content?: string };
}

// A representative make-safe builder email (MLB sender, ref in subject, PDF WO).
export const FX_MLB_POST: FxPost = {
  id: "AAMkAG-post-mlb-67200",
  internetMessageId: "<msg-67200@mlb.com.au>",
  conversationId: "conv-67200",
  conversationThreadId: "thread-67200",
  createdDateTime: "2026-06-13T01:00:00Z",
  receivedDateTime: "2026-06-13T01:00:00Z",
  from: { emailAddress: { address: "dispatch@mlb.com.au", name: "MLB Dispatch" } },
  subject: "Work Order AJBR-67200 — Erskine make safe",
  hasAttachments: true,
  body: { contentType: "html", content: "<p>Please attend the Erskine make safe. WO attached.</p>" },
};

// Same conversation, a THREADED REPLY post added later (re-poll coverage case).
export const FX_MLB_THREAD_REPLY: FxPost = {
  id: "AAMkAG-post-mlb-67200-reply",
  internetMessageId: "<reply-67200@mlb.com.au>",
  conversationId: "conv-67200",
  conversationThreadId: "thread-67200",
  createdDateTime: "2026-06-13T02:30:00Z",
  receivedDateTime: "2026-06-13T02:30:00Z",
  from: { emailAddress: { address: "dispatch@mlb.com.au", name: "MLB Dispatch" } },
  subject: "RE: Work Order AJBR-67200 — Erskine make safe",
  hasAttachments: false,
  body: { contentType: "text", content: "Confirming attendance window." },
};

// A non-make-safe post (marketing) — must be EXCLUDED with an audit row.
export const FX_NON_MAKESAFE_POST: FxPost = {
  id: "AAMkAG-post-newsletter",
  conversationId: "conv-news",
  conversationThreadId: "thread-news",
  receivedDateTime: "2026-06-13T03:00:00Z",
  from: { emailAddress: { address: "news@somesupplier.com", name: "Supplier News" } },
  subject: "June product catalogue is here",
  hasAttachments: false,
  body: { contentType: "html", content: "<p>Check out our new range.</p>" },
};

// An over-match probe: a lookalike domain that must NOT match pattern "mlb.com.au".
export const FX_LOOKALIKE_SENDER_POST: FxPost = {
  id: "AAMkAG-post-lookalike",
  conversationId: "conv-evil",
  conversationThreadId: "thread-evil",
  receivedDateTime: "2026-06-13T03:30:00Z",
  from: { emailAddress: { address: "spam@evilmlb.com.au", name: "Evil MLB" } },
  // No make-safe keyword/ref in the subject — so the ONLY thing that could
  // include this is a sender-domain match, which must be rejected (evilmlb.com.au
  // is not a dot-anchored suffix of mlb.com.au).
  subject: "totally legit promotion inside",
  hasAttachments: false,
  body: { contentType: "text", content: "nope" },
};

// ── Graph attachment fixtures ────────────────────────────────────────────────
export interface FxAttachment {
  id?: string;
  "@odata.type"?: string;
  name?: string;
  contentType?: string;
  size?: number;
  isInline?: boolean;
  contentBytes?: string; // base64
}

// base64 of "%PDF-1.4\n..." (valid PDF magic bytes).
function b64(bytes: number[]): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
// "%PDF" + filler.
const PDF_BYTES = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x00];
// Not a PDF ("HTML" magic-ish).
const NOT_PDF_BYTES = [0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e];

export const FX_PDF_ATTACHMENT: FxAttachment = {
  id: "att-pdf-1",
  "@odata.type": "#microsoft.graph.fileAttachment",
  name: "Work Order AJBR-67200.pdf",
  contentType: "application/pdf",
  size: PDF_BYTES.length,
  isInline: false,
  contentBytes: b64(PDF_BYTES),
};

export const FX_REFERENCE_ATTACHMENT: FxAttachment = {
  id: "att-ref-1",
  "@odata.type": "#microsoft.graph.referenceAttachment",
  name: "SharedLink.url",
  contentType: "application/octet-stream",
  size: 0,
  isInline: false,
};

export const FX_ITEM_ATTACHMENT: FxAttachment = {
  id: "att-item-1",
  "@odata.type": "#microsoft.graph.itemAttachment",
  name: "Forwarded message",
  contentType: "message/rfc822",
  size: 1024,
  isInline: false,
};

export const FX_INLINE_ATTACHMENT: FxAttachment = {
  id: "att-inline-1",
  "@odata.type": "#microsoft.graph.fileAttachment",
  name: "logo.png",
  contentType: "image/png",
  size: 200,
  isInline: true,
  contentBytes: b64([0x89, 0x50, 0x4e, 0x47]),
};

export const FX_OVERSIZE_ATTACHMENT: FxAttachment = {
  id: "att-big-1",
  "@odata.type": "#microsoft.graph.fileAttachment",
  name: "huge-plans.pdf",
  contentType: "application/pdf",
  size: 6 * 1024 * 1024, // > 4MB inline cap -> large-attachment $value path
  isInline: false,
  // No contentBytes (not inlined because too large).
};

export const FX_NON_PDF_FILE_ATTACHMENT: FxAttachment = {
  id: "att-doc-1",
  "@odata.type": "#microsoft.graph.fileAttachment",
  name: "notes.txt",
  contentType: "text/plain",
  size: NOT_PDF_BYTES.length,
  isInline: false,
  contentBytes: b64(NOT_PDF_BYTES),
};

// A file attachment that CLAIMS pdf but whose bytes fail the magic-byte check.
export const FX_FAKE_PDF_ATTACHMENT: FxAttachment = {
  id: "att-fakepdf-1",
  "@odata.type": "#microsoft.graph.fileAttachment",
  name: "Work Order.pdf",
  contentType: "application/pdf",
  size: NOT_PDF_BYTES.length,
  isInline: false,
  contentBytes: b64(NOT_PDF_BYTES), // not %PDF
};

// The four pinned regression refs (subjects only, for classifier coverage).
//
// classifierRef = what monitor-ses-makesafes classifyPost (via extractRef)
// extracts from the subject. B1 FIX: SUBJECT_REF now allows a SPACE between
// prefix and digits AND a bare-numeric (>=5 digit) fallback runs on the full
// subject (then the body), so EVERY make-safe post is persisted with a non-null
// ref — closing the B1 drop path where ref=null skipped the pipeline_items
// projection and the post evaded D1 (while D2 saw the email present).
//
//   - "Make Safe 67005 …"  -> bare-numeric core 67005  (was null pre-B1)
//   - "AJBR 67134 …"       -> AJBR-67134               (was null pre-B1)
//
// reconNorm = the normaliseReconRef canonical form used by D1 candidate matching
// (unchanged; it already normalised bare/spaced forms). classifierRef now equals
// the sync-side normaliseRef canonical form, which lines up with reconNorm.
export const FX_PINNED_REGRESSION = [
  { subject: "Work Order AJBR-67200 Erskine", classifierRef: "AJBR-67200", reconNorm: "AJBR-67200" },
  { subject: "Make Safe 67005 Alexander Heights", classifierRef: "67005", reconNorm: "67005" },
  { subject: "AJBR 67134 Tapping work order", classifierRef: "AJBR-67134", reconNorm: "AJBR-67134" },
  { subject: "MLB-67166 Bassendean", classifierRef: "MLB-67166", reconNorm: "MLB-67166" },
];
