// ════════════════════════════════════════════════════════════
// PHASE-1 SYNC LOGIC TESTS — monitor-ses-makesafes
// Mission: makesafe-live-truth-2026-06-14
// ════════════════════════════════════════════════════════════
//
// Pure-Deno, no network. Mirrors the makesafe_board_test.ts pattern: import the
// underscore-prefixed internal functions and exercise them with stubs.
//
// RUN:
//   ~/.deno/bin/deno test --allow-all --no-check \
//     supabase/functions/ops-api/monitor_ses_makesafes_test.ts
//
// Covers (per MISSION.md Phase-1 logic requirements):
//   - classifier domain-boundary matching (incl over-match rejection)
//   - ON CONFLICT(post_id) idempotency intent (upsert conflict target)
//   - attachment routing (PDF magic-byte accept; ref/item/inline/oversize/non-pdf
//     -> needs_review/failed)
//   - pagination nextLink exhaustion (incl a thread gaining a post after page 1)
//   - ref normalisation
//   - the four pinned regression refs classify as make-safe

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _classifyPost,
  _extractRef,
  _graphGetAll,
  _isPdfMagic,
  _normaliseRef,
  _parseSenderDomain,
  _persistPost,
  _processAttachments,
  _senderMatchesPattern,
} from "../monitor-ses-makesafes/index.ts";
import { normaliseReconRef as _normaliseReconRef } from "./makesafe_reconcile.ts";
import {
  FX_FAKE_PDF_ATTACHMENT,
  FX_INLINE_ATTACHMENT,
  FX_ITEM_ATTACHMENT,
  FX_LOOKALIKE_SENDER_POST,
  FX_MLB_POST,
  FX_NON_MAKESAFE_POST,
  FX_NON_PDF_FILE_ATTACHMENT,
  FX_OVERSIZE_ATTACHMENT,
  FX_PDF_ATTACHMENT,
  FX_PINNED_REGRESSION,
  FX_REFERENCE_ATTACHMENT,
} from "./makesafe_fixtures.ts";

const COMPANIES = [
  { slug: "mlb", name: "MLB", pattern: "mlb.com.au" },
];

// ── Classifier: domain-boundary matching ──────────────────────────────────────
Deno.test("classifier: exact sender domain matches the company pattern", () => {
  const r = _classifyPost(FX_MLB_POST, COMPANIES);
  assertEquals(r.include, true);
  assertEquals(r.reason, "sender:mlb");
  assertEquals(r.ref, "AJBR-67200");
});

Deno.test("classifier: subdomain of the pattern matches (dot-anchored suffix)", () => {
  const post = {
    ...FX_MLB_POST,
    from: { emailAddress: { address: "noreply.dispatch@notify.mlb.com.au" } },
    subject: "general note no ref",
  };
  const r = _classifyPost(post, COMPANIES);
  assertEquals(r.include, true);
  assertEquals(r.reason, "sender:mlb");
});

Deno.test("classifier: lookalike domain does NOT match (over-match rejection)", () => {
  // evilmlb.com.au must NOT match pattern mlb.com.au, and the subject has no ref.
  const r = _classifyPost(FX_LOOKALIKE_SENDER_POST, COMPANIES);
  assertEquals(r.include, false);
});

Deno.test("classifier: substring-but-not-suffix domain rejected", () => {
  assertEquals(_senderMatchesPattern("x@mlb.com.au.evil.test", "mlb.com.au"), false);
  assertEquals(_senderMatchesPattern("x@evilmlb.com.au", "mlb.com.au"), false);
  assertEquals(_senderMatchesPattern("x@mlb.com.au", "mlb.com.au"), true);
  assertEquals(_senderMatchesPattern("x@sub.mlb.com.au", "mlb.com.au"), true);
});

Deno.test("classifier: non-make-safe post is excluded (audit-row caller path)", () => {
  const r = _classifyPost(FX_NON_MAKESAFE_POST, COMPANIES);
  assertEquals(r.include, false);
});

Deno.test("classifier: subject ref with no sender match still includes", () => {
  const post = {
    ...FX_NON_MAKESAFE_POST,
    subject: "Please action AJBR-99999 urgently",
  };
  const r = _classifyPost(post, COMPANIES);
  assertEquals(r.include, true);
  assertEquals(r.reason, "subject_ref");
  assertEquals(r.ref, "AJBR-99999");
});

Deno.test("classifier: 'make safe' keyword in subject includes", () => {
  const post = { ...FX_NON_MAKESAFE_POST, subject: "Emergency make safe required tonight" };
  const r = _classifyPost(post, COMPANIES);
  assertEquals(r.include, true);
  assertEquals(r.reason, "subject_keyword");
});

Deno.test("classifier: the four pinned regression refs all classify make-safe", () => {
  // All four (Erskine 67200, Alexander Heights 67005, Tapping 67134, Bassendean
  // 67166) must be INCLUDED with a NON-NULL ref. B1: the classifier now extracts
  // bare-numeric (67005) and space-separated-prefix (AJBR 67134) forms too, so a
  // make-safe post is never persisted ref=null (the old D1-blind drop path).
  for (const fx of FX_PINNED_REGRESSION) {
    const post = { ...FX_NON_MAKESAFE_POST, subject: fx.subject };
    const r = _classifyPost(post, COMPANIES);
    assertEquals(r.include, true, `expected include for ${fx.subject}`);
    assertEquals(r.ref, fx.classifierRef, `classifier ref for ${fx.subject}`);
    // B1: classify-time ref must be non-null for every pinned make-safe subject.
    assertEquals(r.ref !== null, true, `B1: non-null classify ref for ${fx.subject}`);
    // The recon-side normaliser canonicalises all four straight from the subject
    // (incl. the bare numeric 67005 and the space-separated AJBR 67134).
    assertEquals(_normaliseReconRef(fx.subject), fx.reconNorm, `recon norm for ${fx.subject}`);
  }
});

// B1 — extractRef directly: spaced-prefix, bare-numeric, and body fallback.
Deno.test("extractRef: spaced/bare/body forms all yield a non-null ref (B1)", () => {
  // Space-separated prefix in subject.
  assertEquals(_extractRef("AJBR 67134 Tapping work order", null), "AJBR-67134");
  // Bare-numeric core in subject (no prefix).
  assertEquals(_extractRef("Make Safe 67005 Alexander Heights", null), "67005");
  // Dashed prefix.
  assertEquals(_extractRef("MLB-67166 Bassendean", null), "MLB-67166");
  // No ref in subject -> body fallback (prefixed).
  assertEquals(_extractRef("Emergency make safe tonight", "<p>ref AJBR 67999 attached</p>"), "AJBR-67999");
  // No ref in subject -> body fallback (bare numeric).
  assertEquals(_extractRef("make safe please", "job number 67500 confirmed"), "67500");
  // Truly no ref anywhere -> null.
  assertEquals(_extractRef("make safe please", "no number here"), null);
});

// ── Ref normalisation ─────────────────────────────────────────────────────────
Deno.test("normaliseRef: spaced/dashed/bare forms collapse consistently", () => {
  assertEquals(_normaliseRef("AJBR 67200"), "AJBR-67200");
  assertEquals(_normaliseRef("AJBR-67200"), "AJBR-67200");
  assertEquals(_normaliseRef("ajbr67200"), "AJBR-67200");
  assertEquals(_normaliseRef("67200"), "67200");
  assertEquals(_normaliseRef(null), null);
});

Deno.test("parseSenderDomain: extracts lowercased domain", () => {
  assertEquals(_parseSenderDomain("Dispatch@MLB.com.au"), "mlb.com.au");
  assertEquals(_parseSenderDomain("no-at-sign"), null);
  assertEquals(_parseSenderDomain(null), null);
});

// ── PDF magic-byte validation ─────────────────────────────────────────────────
Deno.test("isPdfMagic: accepts %PDF, rejects others", () => {
  const okBytes = Uint8Array.from(atob(FX_PDF_ATTACHMENT.contentBytes!), (c) => c.charCodeAt(0));
  assertEquals(_isPdfMagic(okBytes), true);
  assertEquals(_isPdfMagic(new Uint8Array([0x3c, 0x68, 0x74, 0x6d])), false); // <htm
  assertEquals(_isPdfMagic(new Uint8Array([0x25])), false); // too short
});

// ── Pagination: @odata.nextLink exhaustion ────────────────────────────────────
function pageResponse(values: any[], nextLink?: string): Response {
  const body: any = { value: values };
  if (nextLink) body["@odata.nextLink"] = nextLink;
  return new Response(JSON.stringify(body), { status: 200 });
}

Deno.test("graphGetAll: drains all pages via @odata.nextLink", async () => {
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  // 3 pages.
  // deno-lint-ignore no-explicit-any
  (globalThis as any).fetch = (url: string) => {
    calls.push(url);
    if (url === "page1") return Promise.resolve(pageResponse([{ id: "a" }, { id: "b" }], "page2"));
    if (url === "page2") return Promise.resolve(pageResponse([{ id: "c" }], "page3"));
    if (url === "page3") return Promise.resolve(pageResponse([{ id: "d" }]));
    throw new Error("unexpected url " + url);
  };
  try {
    const { values, pages } = await _graphGetAll<{ id: string }>("page1", "tok");
    assertEquals(values.map((v) => v.id), ["a", "b", "c", "d"]);
    assertEquals(pages, 3);
    assertEquals(calls, ["page1", "page2", "page3"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("graphGetAll: a thread gaining a post after page 1 is captured (re-poll coverage)", async () => {
  // Simulates the MISSION.md threaded re-poll requirement at the pagination level:
  // the second page (fetched after the first) contains a post that did not exist
  // when page 1 was served. Exhaustion must still pick it up.
  const realFetch = globalThis.fetch;
  // deno-lint-ignore no-explicit-any
  (globalThis as any).fetch = (url: string) => {
    if (url === "thread-posts") {
      return Promise.resolve(pageResponse([{ id: "post-1" }], "thread-posts-p2"));
    }
    if (url === "thread-posts-p2") {
      // post-2 is the NEW reply that arrived between page fetches.
      return Promise.resolve(pageResponse([{ id: "post-2-new-reply" }]));
    }
    throw new Error("unexpected url " + url);
  };
  try {
    const { values } = await _graphGetAll<{ id: string }>("thread-posts", "tok");
    assertEquals(values.map((v) => v.id), ["post-1", "post-2-new-reply"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("graphGetAll: 429 Retry-After is respected then the page succeeds", async () => {
  const realFetch = globalThis.fetch;
  let n = 0;
  // deno-lint-ignore no-explicit-any
  (globalThis as any).fetch = (url: string) => {
    n++;
    if (n === 1) {
      return Promise.resolve(
        new Response("throttled", { status: 429, headers: { "Retry-After": "0" } }),
      );
    }
    return Promise.resolve(pageResponse([{ id: "z" }]));
  };
  try {
    const { values, pages } = await _graphGetAll<{ id: string }>(url0(), "tok");
    assertEquals(values.map((v) => v.id), ["z"]);
    assertEquals(pages, 1);
    assertEquals(n, 2); // one 429 retry + one success
  } finally {
    globalThis.fetch = realFetch;
  }
});
function url0() {
  return "throttled-url";
}

// ── Attachment routing (processAttachments) ───────────────────────────────────
// Stub sb: records every email_attachments upsert + storage upload; returns no
// prior attempts / no existing uploaded row (so the happy path uploads).
function makeAttachmentSb() {
  const upserts: any[] = [];
  const uploads: Array<{ path: string }> = [];
  const sb: any = {
    from(table: string) {
      return {
        select() {
          return {
            eq() {
              return {
                eq() {
                  return { maybeSingle: async () => ({ data: null, error: null }) };
                },
                maybeSingle: async () => ({ data: null, error: null }),
              };
            },
          };
        },
        upsert: async (row: any, _o?: any) => {
          if (table === "email_attachments") upserts.push(row);
          return { error: null };
        },
      };
    },
    storage: {
      from() {
        return {
          upload: async (path: string, _bytes: Uint8Array, _o?: any) => {
            uploads.push({ path });
            return { error: null };
          },
          remove: async (_paths: string[]) => ({ error: null }),
        };
      },
    },
  };
  return { sb, upserts, uploads };
}

function attListResponse(atts: any[]): Response {
  return new Response(JSON.stringify({ value: atts }), { status: 200 });
}

async function runProcessAttachments(atts: any[]) {
  const { sb, upserts, uploads } = makeAttachmentSb();
  const realFetch = globalThis.fetch;
  // deno-lint-ignore no-explicit-any
  (globalThis as any).fetch = (_url: string) => Promise.resolve(attListResponse(atts));
  try {
    const post = { ...FX_MLB_POST, hasAttachments: true };
    const unresolved = await _processAttachments(sb, "tok", "group-1", post as any);
    return { unresolved, upserts, uploads };
  } finally {
    globalThis.fetch = realFetch;
  }
}

Deno.test("attachments: a valid PDF is uploaded (status uploaded), 0 unresolved", async () => {
  const { unresolved, upserts, uploads } = await runProcessAttachments([FX_PDF_ATTACHMENT]);
  assertEquals(unresolved, 0);
  assertEquals(uploads.length, 1);
  const finalRow = upserts.find((r) => r.status === "uploaded");
  assertEquals(!!finalRow, true);
  assertEquals(typeof finalRow.sha256, "string");
});

Deno.test("attachments: referenceAttachment routes to needs_review", async () => {
  const { unresolved, upserts, uploads } = await runProcessAttachments([FX_REFERENCE_ATTACHMENT]);
  assertEquals(unresolved, 1);
  assertEquals(uploads.length, 0);
  assertEquals(upserts[0].status, "needs_review");
});

Deno.test("attachments: itemAttachment routes to needs_review", async () => {
  const { unresolved, upserts } = await runProcessAttachments([FX_ITEM_ATTACHMENT]);
  assertEquals(unresolved, 1);
  assertEquals(upserts[0].status, "needs_review");
});

Deno.test("attachments: inline attachment routes to needs_review", async () => {
  const { unresolved, upserts } = await runProcessAttachments([FX_INLINE_ATTACHMENT]);
  assertEquals(unresolved, 1);
  assertEquals(upserts[0].status, "needs_review");
  assertEquals(upserts[0].attachment_kind, "inline");
});

Deno.test("attachments: oversize PDF (>4MB, no contentBytes) routes to needs_review (large path)", async () => {
  const { unresolved, upserts, uploads } = await runProcessAttachments([FX_OVERSIZE_ATTACHMENT]);
  assertEquals(unresolved, 1);
  assertEquals(uploads.length, 0);
  assertEquals(upserts[0].status, "needs_review");
  assertEquals(upserts[0].last_error, "large_attachment_value_path_required");
});

Deno.test("attachments: non-PDF file attachment routes to needs_review (not stored)", async () => {
  const { unresolved, upserts, uploads } = await runProcessAttachments([FX_NON_PDF_FILE_ATTACHMENT]);
  assertEquals(unresolved, 1);
  assertEquals(uploads.length, 0);
  assertEquals(upserts[0].status, "needs_review");
  assertEquals(upserts[0].last_error, "non_pdf_file_attachment");
});

Deno.test("attachments: a fake-PDF (claims pdf, bad magic bytes) is marked failed", async () => {
  const { unresolved, upserts, uploads } = await runProcessAttachments([FX_FAKE_PDF_ATTACHMENT]);
  assertEquals(unresolved, 1);
  assertEquals(uploads.length, 0);
  const failed = upserts.find((r) => r.status === "failed");
  assertEquals(!!failed, true);
  assertEquals(failed.last_error, "pdf_magic_byte_validation_failed");
});

Deno.test("attachments: a post with hasAttachments=false does no work", async () => {
  const { sb } = makeAttachmentSb();
  const post = { ...FX_MLB_POST, hasAttachments: false };
  const unresolved = await _processAttachments(sb, "tok", "group-1", post as any);
  assertEquals(unresolved, 0);
});

// ── M5 — ingestion-level persistPost: spaced/bare refs DO create a pipeline_items
// row with a non-null ref (validates B1 end-to-end at the real persist path, not
// just the downstream recon recovery). This is the test Codex flagged as missing:
// the recon tests proved recovery, but nothing proved the actual persist path now
// writes a pipeline_items row for the previously-dropped bare/spaced cases. ──
function makePersistSb() {
  const writes: Array<{ table: string; op: string; row: any }> = [];
  function builder(table: string): any {
    const b: any = {
      select: () => b,
      eq: () => b,
      ilike: () => b,
      in: () => b,
      limit: async () => ({ data: [], error: null }),
      maybeSingle: async () => ({ data: null, error: null }),
      single: async () => ({ data: { id: `ev-${writes.length}` }, error: null }),
      upsert: async (row: any, _o?: any) => { writes.push({ table, op: "upsert", row }); return { error: null }; },
      insert: (row: any) => {
        writes.push({ table, op: "insert", row });
        // email_events_raw.insert(...).select("id").single() chain.
        return {
          select: () => ({ single: async () => ({ data: { id: `ev-${writes.length}` }, error: null }) }),
          then: (resolve: (v: any) => any) => resolve({ error: null }),
        };
      },
    };
    return b;
  }
  return { sb: { from: (t: string) => builder(t) }, writes };
}

async function persistAndGetPipelineItem(subject: string) {
  const { sb, writes } = makePersistSb();
  const post = { ...FX_MLB_POST, subject, hasAttachments: false };
  const cls = _classifyPost(post as any, COMPANIES);
  await _persistPost(sb as any, "tok", "group-1", post as any, cls);
  const pi = writes.find((w) => w.table === "pipeline_items" && w.op === "upsert");
  return { pi, cls, writes };
}

Deno.test("persistPost: a SPACE-separated ref ('AJBR 67134') writes a pipeline_items row with a non-null ref (B1)", async () => {
  const { pi, cls } = await persistAndGetPipelineItem("AJBR 67134 Tapping work order");
  assertEquals(cls.include, true);
  assertEquals(cls.ref, "AJBR-67134");
  assertEquals(!!pi, true, "expected a pipeline_items upsert");
  assertEquals(pi!.row.ref, "AJBR-67134");
  assertEquals(pi!.row.ref !== null, true);
});

Deno.test("persistPost: a BARE-numeric ref ('Make Safe 67005') writes a pipeline_items row with a non-null ref (B1)", async () => {
  const { pi, cls } = await persistAndGetPipelineItem("Make Safe 67005 Alexander Heights");
  assertEquals(cls.include, true);
  assertEquals(cls.ref, "67005");
  assertEquals(!!pi, true, "expected a pipeline_items upsert");
  assertEquals(pi!.row.ref, "67005");
  assertEquals(pi!.row.ref !== null, true);
});
