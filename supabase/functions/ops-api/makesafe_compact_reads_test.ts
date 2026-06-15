// ════════════════════════════════════════════════════════════
// COMPACT READ ENDPOINT TESTS — GAP-1..6 (Mission makesafe-live-truth-2026-06-14)
// ════════════════════════════════════════════════════════════
//
// Pure-Deno, no network. Mirrors makesafe_reconcile_test.ts: chainable Supabase
// stub returning seeded rows per table, plus a Storage stub for the GAP-2 signed
// URL. Internal functions are exported with the `_` prefix and the query client
// is stubbed.
//
// RUN:
//   ~/.deno/bin/deno test --allow-all --no-check \
//     supabase/functions/ops-api/makesafe_compact_reads_test.ts
//
// Covers (per the M2 spec):
//   - GAP-1 happy path + dedup (already-drafted/approved excluded; rejected kept)
//   - GAP-1/GAP-3 GAP-5 attachment_status_summary surfaced
//   - GAP-2 status guard (only `uploaded` mints a URL; every other status -> error)
//   - GAP-2 by attachment_id AND by (post_id, graph_attachment_id)
//   - GAP-3 pipeline_items joined to email (sender_domain/received_at) + since window
//   - GAP-4 buildPipelineSentStatusMap by target job
//   - GAP-6 happy path + tombstoned-degraded record

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _buildPipelineSentStatusMap,
  _getMakesafeAttachmentUrl,
  _getMakesafeEmail,
  _makesafeNewEmails,
  _makesafePipelineItems,
  attachmentUrlGuard,
  buildAttachmentSummaries,
  deriveFromDomain,
  emptyAttachmentSummary,
  liveAttachmentCount,
  sinceFromDays,
} from "./makesafe_compact_reads.ts";

// ── A chainable Supabase stub. Each .from(table) returns a builder that records
// the filters applied, then resolves to the seeded rows after applying the
// .eq/.in/.is/.neq/.gte filters that the compact reads actually use. Adding the
// filter logic (vs the reconcile stub's pass-through) lets the dedup + window
// assertions be meaningful. `.storage.from().createSignedUrl()` is stubbed too.
function makeClient(
  seed: Record<string, any[]>,
  opts: {
    readErrors?: Record<string, string>;
    signedUrl?: string | null;
    signError?: string | null;
    signCalls?: Array<{ path: string; ttl: number }>;
  } = {},
) {
  const readErrors = opts.readErrors || {};
  function builder(table: string) {
    const rows = (seed[table] || []).slice();
    const eqs: Array<[string, any]> = [];
    const ins: Array<[string, any[]]> = [];
    const isNull: string[] = [];
    const isNotNull: string[] = [];
    const neqs: Array<[string, any]> = [];
    const gtes: Array<[string, any]> = [];
    const readErr = readErrors[table] ? { message: readErrors[table] } : null;

    function apply(): any[] {
      let out = rows;
      for (const [c, v] of eqs) out = out.filter((r) => r[c] === v);
      for (const [c, vs] of ins) out = out.filter((r) => vs.includes(r[c]));
      for (const c of isNull) out = out.filter((r) => r[c] == null);
      for (const c of isNotNull) out = out.filter((r) => r[c] != null);
      for (const [c, v] of neqs) out = out.filter((r) => r[c] !== v);
      for (const [c, v] of gtes) out = out.filter((r) => r[c] != null && r[c] >= v);
      return out;
    }

    const b: any = {
      select: () => b,
      eq: (c: string, v: any) => { eqs.push([c, v]); return b; },
      neq: (c: string, v: any) => { neqs.push([c, v]); return b; },
      in: (c: string, vs: any[]) => { ins.push([c, vs]); return b; },
      gte: (c: string, v: any) => { gtes.push([c, v]); return b; },
      lte: () => b,
      is: (c: string, v: any) => { if (v === null) isNull.push(c); else isNotNull.push(c); return b; },
      not: () => b,
      or: () => b,
      order: () => b,
      limit: () => b,
      maybeSingle: async () => readErr ? ({ data: null, error: readErr }) : ({ data: apply()[0] ?? null, error: null }),
      single: async () => readErr ? ({ data: null, error: readErr }) : ({ data: apply()[0] ?? null, error: null }),
      then: (resolve: (v: any) => any) => {
        if (readErr) return resolve({ data: null, error: readErr });
        return resolve({ data: apply(), error: null });
      },
    };
    return b;
  }

  const signCalls = opts.signCalls || [];
  const storage = {
    from: (_bucket: string) => ({
      createSignedUrl: async (path: string, ttl: number) => {
        signCalls.push({ path, ttl });
        if (opts.signError) return { data: null, error: { message: opts.signError } };
        return { data: { signedUrl: opts.signedUrl ?? `https://signed.example/${path}?ttl=${ttl}` }, error: null };
      },
    }),
  };

  return { client: { from: (t: string) => builder(t), storage }, signCalls };
}

// ════════════════════════════════════════════════════════════
// Pure helpers
// ════════════════════════════════════════════════════════════
Deno.test("deriveFromDomain: extracts domain after last @, lowercased", () => {
  assertEquals(deriveFromDomain("Dispatch@MLB.com.au"), "mlb.com.au");
  assertEquals(deriveFromDomain("a@b@c.com"), "c.com");
  assertEquals(deriveFromDomain("noatsign"), null);
  assertEquals(deriveFromDomain(null), null);
  assertEquals(deriveFromDomain(""), null);
});

Deno.test("buildAttachmentSummaries: counts each known status; ignores unknown", () => {
  const m = buildAttachmentSummaries([
    { email_id: "p1", status: "uploaded" },
    { email_id: "p1", status: "uploaded" },
    { email_id: "p1", status: "pending" },
    { email_id: "p1", status: "failed" },
    { email_id: "p1", status: "needs_review" },
    { email_id: "p1", status: "purged" },
    { email_id: "p1", status: "bogus" }, // ignored
    { email_id: "p2", status: "uploaded" },
    { email_id: null, status: "uploaded" }, // no email_id -> ignored
  ]);
  assertEquals(m["p1"], { uploaded: 2, pending: 1, failed: 1, needs_review: 1, purged: 1 });
  assertEquals(m["p2"], { uploaded: 1, pending: 0, failed: 0, needs_review: 0, purged: 0 });
});

Deno.test("liveAttachmentCount: excludes purged from the live count", () => {
  assertEquals(liveAttachmentCount({ uploaded: 2, pending: 1, failed: 1, needs_review: 1, purged: 5 }), 5);
  assertEquals(liveAttachmentCount(emptyAttachmentSummary()), 0);
  assertEquals(liveAttachmentCount(undefined), 0);
});

Deno.test("sinceFromDays: returns ISO `days` before nowIso", () => {
  assertEquals(sinceFromDays(30, "2026-06-15T00:00:00.000Z"), "2026-05-16T00:00:00.000Z");
});

// ════════════════════════════════════════════════════════════
// GAP-2 status guard (pure)
// ════════════════════════════════════════════════════════════
Deno.test("GAP-2 guard: only 'uploaded' with a storage_path passes", () => {
  assertEquals(attachmentUrlGuard("uploaded", "ses/2026/abc.pdf").ok, true);
});

Deno.test("GAP-2 guard: 'uploaded' but no storage_path -> rejected", () => {
  const g = attachmentUrlGuard("uploaded", null);
  assertEquals(g.ok, false);
  assert(g.error!.includes("no storage_path"));
});

Deno.test("GAP-2 guard: pending/failed/needs_review/purged each rejected with a distinct reason", () => {
  for (const [status, frag] of [
    ["pending", "pending"],
    ["failed", "failed"],
    ["needs_review", "needs_review"],
    ["purged", "purged"],
  ] as Array<[string, string]>) {
    const g = attachmentUrlGuard(status, "ses/x.pdf");
    assertEquals(g.ok, false, `status ${status} should be rejected`);
    assert(g.error!.includes(frag), `reason for ${status} should mention ${frag}: ${g.error}`);
  }
});

// ════════════════════════════════════════════════════════════
// GAP-1 — makesafe_new_emails
// ════════════════════════════════════════════════════════════
Deno.test("GAP-1: happy path returns un-drafted emails with from_domain + GAP-5 summary", async () => {
  const { client } = makeClient({
    emails: [
      { post_id: "post-NEW", mailbox: "ses@secureworkswa.com.au", received_at: "2026-06-14T00:00:00Z", from_email: "dispatch@mlb.com.au", has_attachments: true, pii_purged_at: null },
    ],
    makesafe_intake_drafts: [], // nothing drafted yet
    email_attachments: [
      { email_id: "post-NEW", status: "uploaded" },
      { email_id: "post-NEW", status: "pending" },
    ],
  });
  const res = await _makesafeNewEmails(client, { nowIso: "2026-06-15T00:00:00Z" });
  assertEquals(res.count, 1);
  const row = res.emails[0];
  assertEquals(row.post_id, "post-NEW");
  assertEquals(row.from_domain, "mlb.com.au");
  assertEquals(row.has_attachments, true);
  assertEquals(row.attachment_count, 2); // uploaded + pending (live)
  assertEquals(row.attachment_status_summary.uploaded, 1);
  assertEquals(row.attachment_status_summary.pending, 1);
});

Deno.test("GAP-1 dedup: an email already in a draft (any non-rejected status) is excluded", async () => {
  const { client } = makeClient({
    emails: [
      { post_id: "post-DRAFTED", mailbox: "ses@secureworkswa.com.au", received_at: "2026-06-14T00:00:00Z", from_email: "x@mlb.com.au", has_attachments: false, pii_purged_at: null },
      { post_id: "post-APPROVED", mailbox: "ses@secureworkswa.com.au", received_at: "2026-06-14T00:00:00Z", from_email: "x@mlb.com.au", has_attachments: false, pii_purged_at: null },
      { post_id: "post-NEW", mailbox: "ses@secureworkswa.com.au", received_at: "2026-06-14T00:00:00Z", from_email: "x@mlb.com.au", has_attachments: false, pii_purged_at: null },
    ],
    makesafe_intake_drafts: [
      { graph_message_id: "post-DRAFTED", status: "draft" },
      { graph_message_id: "post-APPROVED", status: "approved" },
    ],
    email_attachments: [],
  });
  const res = await _makesafeNewEmails(client, { nowIso: "2026-06-15T00:00:00Z" });
  assertEquals(res.count, 1);
  assertEquals(res.emails[0].post_id, "post-NEW");
});

Deno.test("GAP-1 dedup: a REJECTED draft does NOT exclude its email (eligible to resurface)", async () => {
  const { client } = makeClient({
    emails: [
      { post_id: "post-REJECTED", mailbox: "ses@secureworkswa.com.au", received_at: "2026-06-14T00:00:00Z", from_email: "x@mlb.com.au", has_attachments: false, pii_purged_at: null },
    ],
    // The .neq('status','rejected') filter means this row is NOT returned, so the
    // email is not in knownIds -> it resurfaces. Seed it as rejected.
    makesafe_intake_drafts: [
      { graph_message_id: "post-REJECTED", status: "rejected" },
    ],
    email_attachments: [],
  });
  const res = await _makesafeNewEmails(client, { nowIso: "2026-06-15T00:00:00Z" });
  assertEquals(res.count, 1);
  assertEquals(res.emails[0].post_id, "post-REJECTED");
});

Deno.test("GAP-1: tombstoned emails are excluded (pii_purged_at set)", async () => {
  const { client } = makeClient({
    emails: [
      { post_id: "post-TOMB", mailbox: "ses@secureworkswa.com.au", received_at: "2026-06-14T00:00:00Z", from_email: null, has_attachments: false, pii_purged_at: "2026-06-14T00:00:00Z" },
    ],
    makesafe_intake_drafts: [],
    email_attachments: [],
  });
  const res = await _makesafeNewEmails(client, { nowIso: "2026-06-15T00:00:00Z" });
  assertEquals(res.count, 0);
});

// ════════════════════════════════════════════════════════════
// GAP-3 — makesafe_pipeline_items
// ════════════════════════════════════════════════════════════
Deno.test("GAP-3: pipeline_items joined to email for sender_domain + received_at; GAP-5 summary", async () => {
  const { client } = makeClient({
    pipeline_items: [
      { ref: "AJBR-67200", mailbox: "ses@secureworkswa.com.au", target_job: "job-1", sent_status: "verified_sent", attachment_refs: ["a1"], match_score: 0.95, match_method: "ref", source_event_ids: ["ev-1"] },
    ],
    email_events_raw: [{ id: "ev-1", post_id: "post-1" }],
    emails: [
      { post_id: "post-1", mailbox: "ses@secureworkswa.com.au", from_email: "dispatch@mlb.com.au", received_at: "2026-06-14T00:00:00Z" },
    ],
    email_attachments: [{ email_id: "post-1", status: "uploaded" }],
  });
  const res = await _makesafePipelineItems(client, { nowIso: "2026-06-15T00:00:00Z" });
  assertEquals(res.count, 1);
  const r = res.items[0];
  assertEquals(r.ref, "AJBR-67200");
  assertEquals(r.source_email_id, "post-1");
  assertEquals(r.sender_domain, "mlb.com.au");
  assertEquals(r.received_at, "2026-06-14T00:00:00Z");
  assertEquals(r.sent_status, "verified_sent");
  assertEquals(r.has_target_job, true);
  assertEquals(r.match_score, 0.95);
  assertEquals(r.attachment_count, 1);
  assertEquals(r.attachment_status_summary.uploaded, 1);
});

Deno.test("GAP-3: items whose email is older than the `since` window are excluded", async () => {
  const { client } = makeClient({
    pipeline_items: [
      { ref: "OLD-1", mailbox: "ses@secureworkswa.com.au", target_job: null, sent_status: "not_sent", attachment_refs: [], match_score: null, source_event_ids: ["ev-old"] },
      { ref: "NEW-1", mailbox: "ses@secureworkswa.com.au", target_job: null, sent_status: "not_sent", attachment_refs: [], match_score: null, source_event_ids: ["ev-new"] },
    ],
    email_events_raw: [
      { id: "ev-old", post_id: "post-old" },
      { id: "ev-new", post_id: "post-new" },
    ],
    emails: [
      { post_id: "post-old", mailbox: "ses@secureworkswa.com.au", from_email: "x@mlb.com.au", received_at: "2026-01-01T00:00:00Z" },
      { post_id: "post-new", mailbox: "ses@secureworkswa.com.au", from_email: "x@mlb.com.au", received_at: "2026-06-14T00:00:00Z" },
    ],
    email_attachments: [],
  });
  // since defaults to 60d before nowIso => ~2026-04-16; post-old (Jan) excluded.
  const res = await _makesafePipelineItems(client, { nowIso: "2026-06-15T00:00:00Z" });
  assertEquals(res.count, 1);
  assertEquals(res.items[0].ref, "NEW-1");
});

Deno.test("GAP-3: sent_status filter is honoured", async () => {
  const { client } = makeClient({
    pipeline_items: [
      { ref: "R-SENT", mailbox: "ses@secureworkswa.com.au", target_job: "j1", sent_status: "verified_sent", attachment_refs: [], match_score: null, source_event_ids: ["e1"] },
      { ref: "R-NOTSENT", mailbox: "ses@secureworkswa.com.au", target_job: "j2", sent_status: "not_sent", attachment_refs: [], match_score: null, source_event_ids: ["e2"] },
    ],
    email_events_raw: [{ id: "e1", post_id: "p1" }, { id: "e2", post_id: "p2" }],
    emails: [
      { post_id: "p1", mailbox: "ses@secureworkswa.com.au", from_email: "x@mlb.com.au", received_at: "2026-06-14T00:00:00Z" },
      { post_id: "p2", mailbox: "ses@secureworkswa.com.au", from_email: "x@mlb.com.au", received_at: "2026-06-14T00:00:00Z" },
    ],
    email_attachments: [],
  });
  const res = await _makesafePipelineItems(client, { sent_status: "verified_sent", nowIso: "2026-06-15T00:00:00Z" });
  assertEquals(res.count, 1);
  assertEquals(res.items[0].ref, "R-SENT");
  assertEquals(res.sent_status, "verified_sent");
});

// ════════════════════════════════════════════════════════════
// GAP-4 — buildPipelineSentStatusMap
// ════════════════════════════════════════════════════════════
Deno.test("GAP-4: buildPipelineSentStatusMap maps target_job -> sent_status", async () => {
  const { client } = makeClient({
    pipeline_items: [
      { target_job: "job-1", sent_status: "verified_sent" },
      { target_job: "job-2", sent_status: "needs_review" },
      { target_job: null, sent_status: "not_sent" }, // no job -> ignored
    ],
  });
  const m = await _buildPipelineSentStatusMap(client, ["job-1", "job-2", "job-3"]);
  assertEquals(m["job-1"], "verified_sent");
  assertEquals(m["job-2"], "needs_review");
  assertEquals("job-3" in m, false);
});

Deno.test("GAP-4: empty job list short-circuits to {}", async () => {
  const { client } = makeClient({});
  assertEquals(await _buildPipelineSentStatusMap(client, []), {});
});

// ════════════════════════════════════════════════════════════
// GAP-2 — get_makesafe_attachment_url (DB-bound)
// ════════════════════════════════════════════════════════════
Deno.test("GAP-2: an uploaded attachment by attachment_id mints a 60s signed URL", async () => {
  const { client, signCalls } = makeClient({
    email_attachments: [
      { id: "att-1", email_id: "post-1", graph_attachment_id: "g-1", status: "uploaded", storage_path: "ses/2026/wo.pdf", name: "wo.pdf", content_type: "application/pdf" },
    ],
  });
  const res = await _getMakesafeAttachmentUrl(client, { attachment_id: "att-1" });
  assertEquals(res.ok, true);
  assertEquals(res.attachment_id, "att-1");
  assertEquals(res.expires_in, 60);
  assert(res.signed_url!.includes("ses/2026/wo.pdf"));
  assertEquals(signCalls[0].ttl, 60);
  assertEquals(signCalls[0].path, "ses/2026/wo.pdf");
});

Deno.test("GAP-2: lookup by (post_id, graph_attachment_id) works", async () => {
  const { client } = makeClient({
    email_attachments: [
      { id: "att-2", email_id: "post-2", graph_attachment_id: "g-2", status: "uploaded", storage_path: "ses/x.pdf", name: "x.pdf", content_type: "application/pdf" },
    ],
  });
  const res = await _getMakesafeAttachmentUrl(client, { post_id: "post-2", graph_attachment_id: "g-2" });
  assertEquals(res.ok, true);
  assertEquals(res.attachment_id, "att-2");
});

Deno.test("GAP-2 status guard: a non-uploaded (pending) attachment is rejected, no URL minted", async () => {
  const { client, signCalls } = makeClient({
    email_attachments: [
      { id: "att-3", email_id: "post-3", graph_attachment_id: "g-3", status: "pending", storage_path: null },
    ],
  });
  const res = await _getMakesafeAttachmentUrl(client, { attachment_id: "att-3" });
  assertEquals(res.ok, false);
  assertEquals(res.status, "pending");
  assert(res.error!.includes("pending"));
  assertEquals(signCalls.length, 0); // never tried to sign
});

Deno.test("GAP-2 status guard: a purged attachment is rejected with a purged reason", async () => {
  const { client } = makeClient({
    email_attachments: [
      { id: "att-4", email_id: "post-4", graph_attachment_id: "g-4", status: "purged", storage_path: null },
    ],
  });
  const res = await _getMakesafeAttachmentUrl(client, { attachment_id: "att-4" });
  assertEquals(res.ok, false);
  assert(res.error!.includes("purged"));
});

Deno.test("GAP-2: a missing attachment returns ok:false not found", async () => {
  const { client } = makeClient({ email_attachments: [] });
  const res = await _getMakesafeAttachmentUrl(client, { attachment_id: "nope" });
  assertEquals(res.ok, false);
  assert(res.error!.includes("not found"));
});

// ════════════════════════════════════════════════════════════
// GAP-6 — get_makesafe_email (DB-bound)
// ════════════════════════════════════════════════════════════
Deno.test("GAP-6: happy path returns the email + attachments + GAP-5 summary", async () => {
  const { client } = makeClient({
    emails: [
      { post_id: "post-1", mailbox: "ses@secureworkswa.com.au", subject: "WO AJBR-67200", body_preview: "make safe needed", from_email: "dispatch@mlb.com.au", received_at: "2026-06-14T00:00:00Z", has_attachments: true, pii_purged_at: null },
    ],
    email_attachments: [
      { id: "a1", email_id: "post-1", graph_attachment_id: "g1", name: "wo.pdf", content_type: "application/pdf", size_bytes: 1234, status: "uploaded", attachment_kind: "fileAttachment" },
    ],
  });
  const res = await _getMakesafeEmail(client, { post_id: "post-1" });
  assertEquals(res.found, true);
  assertEquals(res.tombstoned, false);
  assertEquals(res.email!.subject, "WO AJBR-67200");
  assertEquals(res.email!.from_domain, "mlb.com.au");
  assertEquals(res.attachments!.length, 1);
  assertEquals(res.attachments![0].attachment_id, "a1");
  assertEquals(res.attachments![0].name, "wo.pdf");
  assertEquals(res.attachment_status_summary!.uploaded, 1);
});

Deno.test("GAP-6: a tombstoned email returns a DEGRADED record flagged tombstoned (PII nulled)", async () => {
  const { client } = makeClient({
    emails: [
      // After purge: PII columns are null, pii_purged_at set, status -> purged.
      { post_id: "post-T", mailbox: "ses@secureworkswa.com.au", subject: null, body_preview: null, from_email: null, received_at: "2026-01-01T00:00:00Z", has_attachments: true, pii_purged_at: "2026-04-01T00:00:00Z" },
    ],
    email_attachments: [
      { id: "a-purged", email_id: "post-T", graph_attachment_id: "g-p", name: null, content_type: null, size_bytes: null, status: "purged", attachment_kind: "fileAttachment" },
    ],
  });
  const res = await _getMakesafeEmail(client, { post_id: "post-T" });
  assertEquals(res.found, true);
  assertEquals(res.tombstoned, true);
  assertEquals(res.email!.subject, null);
  assertEquals(res.email!.body_preview, null);
  assertEquals(res.email!.from_domain, null);
  // The skeleton + attachment status survive for audit continuity.
  assertEquals(res.email!.pii_purged_at, "2026-04-01T00:00:00Z");
  assertEquals(res.attachments![0].name, null); // PII nulled
  assertEquals(res.attachment_status_summary!.purged, 1);
});

Deno.test("GAP-6: an unknown post_id returns found:false", async () => {
  const { client } = makeClient({ emails: [], email_attachments: [] });
  const res = await _getMakesafeEmail(client, { post_id: "ghost" });
  assertEquals(res.found, false);
  assertEquals(res.post_id, "ghost");
});
