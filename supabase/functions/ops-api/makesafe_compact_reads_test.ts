// deno-lint-ignore-file no-import-prefix no-explicit-any require-await
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
  _chunkByUrlBudget,
  _directionForDomain,
  _encodedIdCost,
  _fetchAllRowsInChunks,
  _getMakesafeAttachmentUrl,
  _getMakesafeEmail,
  _isOwnDomain,
  _makesafeNewEmails,
  _makesafePipelineItems,
  _preferPipelineSentStatus,
  attachmentUrlGuard,
  buildAttachmentSummaries,
  deriveFromDomain,
  emptyAttachmentSummary,
  IN_MAX_COUNT,
  IN_URL_BUDGET,
  liveAttachmentCount,
  OWN_OUTBOUND_DOMAINS,
  PIPELINE_SENT_STATUS_RANK,
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
  // Per-table count of how many `.in(col, list)` filters were applied across all
  // builders for that table. Used to assert multi-chunk behaviour (each chunk is a
  // fresh builder, so one .in() == one chunk == one would-be `.in()` request URL).
  const inCalls: Record<string, number> = {};
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
      for (const [c, v] of gtes) {
        out = out.filter((r) => r[c] != null && r[c] >= v);
      }
      return out;
    }

    const b: any = {
      select: () => b,
      eq: (c: string, v: any) => {
        eqs.push([c, v]);
        return b;
      },
      neq: (c: string, v: any) => {
        neqs.push([c, v]);
        return b;
      },
      in: (c: string, vs: any[]) => {
        ins.push([c, vs]);
        inCalls[table] = (inCalls[table] ?? 0) + 1;
        return b;
      },
      gte: (c: string, v: any) => {
        gtes.push([c, v]);
        return b;
      },
      lte: () => b,
      is: (c: string, v: any) => {
        if (v === null) isNull.push(c);
        else isNotNull.push(c);
        return b;
      },
      not: () => b,
      or: () => b,
      order: () => b,
      limit: () => b,
      // Paginated read terminal (fetchAllRows / fetchAllRowsInChunks): applies the
      // recorded filters then returns the rows in [from, to] inclusive. Mirrors
      // PostgREST .range(): a page shorter than the window ends pagination.
      range: async (from: number, to: number) =>
        readErr
          ? ({ data: null, error: readErr })
          : ({ data: apply().slice(from, to + 1), error: null }),
      maybeSingle: async () =>
        readErr
          ? ({ data: null, error: readErr })
          : ({ data: apply()[0] ?? null, error: null }),
      single: async () =>
        readErr
          ? ({ data: null, error: readErr })
          : ({ data: apply()[0] ?? null, error: null }),
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
        if (opts.signError) {
          return { data: null, error: { message: opts.signError } };
        }
        return {
          data: {
            signedUrl: opts.signedUrl ??
              `https://signed.example/${path}?ttl=${ttl}`,
          },
          error: null,
        };
      },
    }),
  };

  return {
    client: { from: (t: string) => builder(t), storage },
    signCalls,
    inCalls,
  };
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
  assertEquals(m["p1"], {
    uploaded: 2,
    pending: 1,
    failed: 1,
    needs_review: 1,
    purged: 1,
  });
  assertEquals(m["p2"], {
    uploaded: 1,
    pending: 0,
    failed: 0,
    needs_review: 0,
    purged: 0,
  });
});

Deno.test("liveAttachmentCount: excludes purged from the live count", () => {
  assertEquals(
    liveAttachmentCount({
      uploaded: 2,
      pending: 1,
      failed: 1,
      needs_review: 1,
      purged: 5,
    }),
    5,
  );
  assertEquals(liveAttachmentCount(emptyAttachmentSummary()), 0);
  assertEquals(liveAttachmentCount(undefined), 0);
});

Deno.test("sinceFromDays: returns ISO `days` before nowIso", () => {
  assertEquals(
    sinceFromDays(30, "2026-06-15T00:00:00.000Z"),
    "2026-05-16T00:00:00.000Z",
  );
});

// ════════════════════════════════════════════════════════════
// Own / outbound domain classification (inbound contamination filter)
// ════════════════════════════════════════════════════════════
Deno.test("isOwnDomain: our own domains (exact + subdomain) are own; builders + null are not", () => {
  // Every enumerated own domain matches exactly.
  for (const own of OWN_OUTBOUND_DOMAINS) {
    assert(_isOwnDomain(own), `${own} should be own`);
    assert(
      _isOwnDomain(own.toUpperCase()),
      `${own} (upper) should be own (case-insensitive)`,
    );
  }
  // Subdomains match by dot-anchored suffix.
  assert(
    _isOwnDomain("mail.secureworksgroup.app"),
    "mail.secureworksgroup.app is own",
  );
  // Builders (genuine inbound senders) are NOT own.
  assert(!_isOwnDomain("mlb.com.au"), "builder domain must not be own");
  assert(
    !_isOwnDomain("dispatch.ajbuildingrepairs.com.au"),
    "builder subdomain must not be own",
  );
  // primeeco.tech is the builders' inbound platform, NOT ours — it must NOT be own,
  // or genuine MLB/Prime work orders get dropped from intake as "outbound".
  assert(
    !_isOwnDomain("primeeco.tech"),
    "primeeco.tech is a builder platform, not own",
  );
  assert(
    !_isOwnDomain("notifications.primeeco.tech"),
    "notifications.primeeco.tech is inbound, not own",
  );
  assert(
    !_isOwnDomain("mlb.mailer@primeeco.tech".split("@")[1]),
    "mlb.mailer@primeeco.tech sender domain is not own",
  );
  // Look-alikes must NOT over-match (the dot anchor guards this).
  assert(
    !_isOwnDomain("notsecureworksgroup.app"),
    "look-alike must not match (no dot boundary)",
  );
  assert(
    !_isOwnDomain("primeeco.tech.evil.test"),
    "suffix-style look-alike must not match",
  );
  // Null/empty -> not own (treated as inbound so it is never silently dropped).
  assert(!_isOwnDomain(null));
  assert(!_isOwnDomain(undefined));
  assert(!_isOwnDomain(""));
});

Deno.test("directionForDomain: own -> outbound, builder/null -> inbound", () => {
  assertEquals(_directionForDomain("secureworkswa.com.au"), "outbound");
  assertEquals(_directionForDomain("notifications.primeeco.tech"), "inbound");
  assertEquals(_directionForDomain("mlb.com.au"), "inbound");
  assertEquals(_directionForDomain(null), "inbound");
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
  for (
    const [status, frag] of [
      ["pending", "pending"],
      ["failed", "failed"],
      ["needs_review", "needs_review"],
      ["purged", "purged"],
    ] as Array<[string, string]>
  ) {
    const g = attachmentUrlGuard(status, "ses/x.pdf");
    assertEquals(g.ok, false, `status ${status} should be rejected`);
    assert(
      g.error!.includes(frag),
      `reason for ${status} should mention ${frag}: ${g.error}`,
    );
  }
});

// ════════════════════════════════════════════════════════════
// GAP-1 — makesafe_new_emails
// ════════════════════════════════════════════════════════════
Deno.test("GAP-1: happy path returns un-drafted emails with from_domain + GAP-5 summary", async () => {
  const { client } = makeClient({
    emails: [
      {
        post_id: "post-NEW",
        mailbox: "ses@secureworkswa.com.au",
        received_at: "2026-06-14T00:00:00Z",
        from_email: "dispatch@mlb.com.au",
        has_attachments: true,
        pii_purged_at: null,
      },
    ],
    makesafe_intake_drafts: [], // nothing drafted yet
    email_attachments: [
      { email_id: "post-NEW", status: "uploaded" },
      { email_id: "post-NEW", status: "pending" },
    ],
  });
  const res = await _makesafeNewEmails(client, {
    nowIso: "2026-06-15T00:00:00Z",
  });
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
      {
        post_id: "post-DRAFTED",
        mailbox: "ses@secureworkswa.com.au",
        received_at: "2026-06-14T00:00:00Z",
        from_email: "x@mlb.com.au",
        has_attachments: false,
        pii_purged_at: null,
      },
      {
        post_id: "post-APPROVED",
        mailbox: "ses@secureworkswa.com.au",
        received_at: "2026-06-14T00:00:00Z",
        from_email: "x@mlb.com.au",
        has_attachments: false,
        pii_purged_at: null,
      },
      {
        post_id: "post-NEW",
        mailbox: "ses@secureworkswa.com.au",
        received_at: "2026-06-14T00:00:00Z",
        from_email: "x@mlb.com.au",
        has_attachments: false,
        pii_purged_at: null,
      },
    ],
    makesafe_intake_drafts: [
      { graph_message_id: "post-DRAFTED", status: "draft" },
      { graph_message_id: "post-APPROVED", status: "approved" },
    ],
    email_attachments: [],
  });
  const res = await _makesafeNewEmails(client, {
    nowIso: "2026-06-15T00:00:00Z",
  });
  assertEquals(res.count, 1);
  assertEquals(res.emails[0].post_id, "post-NEW");
});

Deno.test("GAP-1 dedup: a REJECTED draft does NOT exclude its email (eligible to resurface)", async () => {
  const { client } = makeClient({
    emails: [
      {
        post_id: "post-REJECTED",
        mailbox: "ses@secureworkswa.com.au",
        received_at: "2026-06-14T00:00:00Z",
        from_email: "x@mlb.com.au",
        has_attachments: false,
        pii_purged_at: null,
      },
    ],
    // The .neq('status','rejected') filter means this row is NOT returned, so the
    // email is not in knownIds -> it resurfaces. Seed it as rejected.
    makesafe_intake_drafts: [
      { graph_message_id: "post-REJECTED", status: "rejected" },
    ],
    email_attachments: [],
  });
  const res = await _makesafeNewEmails(client, {
    nowIso: "2026-06-15T00:00:00Z",
  });
  assertEquals(res.count, 1);
  assertEquals(res.emails[0].post_id, "post-REJECTED");
});

Deno.test("GAP-1: tombstoned emails are excluded (pii_purged_at set)", async () => {
  const { client } = makeClient({
    emails: [
      {
        post_id: "post-TOMB",
        mailbox: "ses@secureworkswa.com.au",
        received_at: "2026-06-14T00:00:00Z",
        from_email: null,
        has_attachments: false,
        pii_purged_at: "2026-06-14T00:00:00Z",
      },
    ],
    makesafe_intake_drafts: [],
    email_attachments: [],
  });
  const res = await _makesafeNewEmails(client, {
    nowIso: "2026-06-15T00:00:00Z",
  });
  assertEquals(res.count, 0);
});

Deno.test("GAP-1 inbound filter: own/outbound (ses@-group self-copy) emails are EXCLUDED; inbound builder survives", async () => {
  // Mirrors the live contamination: the ses@ group receives a copy of every pack
  // we send (own outbound domains), so an INBOUND intake feed must drop them and
  // keep only genuine builder mail. excluded_outbound must count the drops, and
  // every surviving row must be flagged direction:"inbound".
  const { client } = makeClient({
    emails: [
      // Genuine inbound builder work-order -> KEEP.
      {
        post_id: "post-BUILDER",
        mailbox: "ses@secureworkswa.com.au",
        received_at: "2026-06-14T00:00:00Z",
        from_email: "dispatch@mlb.com.au",
        has_attachments: true,
        pii_purged_at: null,
      },
      // Our own outbound mail, self-copied into the group -> DROP (each own domain).
      {
        post_id: "post-OUT-WA",
        mailbox: "ses@secureworkswa.com.au",
        received_at: "2026-06-14T00:00:00Z",
        from_email: "ses@secureworkswa.com.au",
        has_attachments: false,
        pii_purged_at: null,
      },
      {
        post_id: "post-OUT-APP",
        mailbox: "ses@secureworkswa.com.au",
        received_at: "2026-06-14T00:00:00Z",
        from_email: "invoices@secureworksgroup.app",
        has_attachments: false,
        pii_purged_at: null,
      },
      // Subdomain of an own domain -> DROP (suffix match). Use a real own-domain
      // subdomain (mail.secureworksgroup.app) — NOT primeeco.tech, which is an
      // inbound builder platform and must NOT be classified as own (#208 fix).
      {
        post_id: "post-OUT-SUB",
        mailbox: "ses@secureworkswa.com.au",
        received_at: "2026-06-14T00:00:00Z",
        from_email: "no-reply@mail.secureworksgroup.app",
        has_attachments: false,
        pii_purged_at: null,
      },
    ],
    makesafe_intake_drafts: [],
    email_attachments: [{ email_id: "post-BUILDER", status: "uploaded" }],
  });
  const res = await _makesafeNewEmails(client, {
    nowIso: "2026-06-15T00:00:00Z",
  });
  // Only the builder email survives the inbound filter.
  assertEquals(res.count, 1);
  assertEquals(res.emails[0].post_id, "post-BUILDER");
  assertEquals(res.emails[0].from_domain, "mlb.com.au");
  assertEquals(res.emails[0].direction, "inbound");
  // The three own/outbound self-copies were counted, not silently vanished.
  assertEquals(res.excluded_outbound, 3);
  // No surviving row is ever flagged outbound (the feed is inbound-only).
  assert(
    res.emails.every((e: any) => e.direction === "inbound"),
    "every retained GAP-1 row must be inbound",
  );
});

Deno.test("GAP-1 regression (#208): an inbound primeeco.tech builder work order SURVIVES the inbound filter", async () => {
  // Regression guard for PR #208: primeeco.tech was incorrectly listed in
  // OWN_OUTBOUND_DOMAINS, causing every MLB/PrimeEco builder work order delivered
  // via mlb.mailer@primeeco.tech to be dropped silently as "own outbound". After
  // the fix it must survive the inbound filter and NOT be counted in excluded_outbound.
  const { client } = makeClient({
    emails: [
      // Genuine inbound PrimeEco builder work order -> MUST SURVIVE.
      {
        post_id: "post-PRIMEECO-WO",
        mailbox: "ses@secureworkswa.com.au",
        received_at: "2026-06-14T00:00:00Z",
        from_email: "mlb.mailer@primeeco.tech",
        has_attachments: true,
        pii_purged_at: null,
      },
      // Own outbound self-copy -> still correctly excluded.
      {
        post_id: "post-OWN-SELF",
        mailbox: "ses@secureworkswa.com.au",
        received_at: "2026-06-14T00:00:00Z",
        from_email: "ses@secureworkswa.com.au",
        has_attachments: false,
        pii_purged_at: null,
      },
    ],
    makesafe_intake_drafts: [],
    email_attachments: [{ email_id: "post-PRIMEECO-WO", status: "uploaded" }],
  });
  const res = await _makesafeNewEmails(client, {
    nowIso: "2026-06-15T00:00:00Z",
  });
  // The PrimeEco builder WO survives; the own self-copy does not.
  assertEquals(
    res.count,
    1,
    "primeeco.tech builder WO must survive (not dropped as own-outbound)",
  );
  assertEquals(res.emails[0].post_id, "post-PRIMEECO-WO");
  assertEquals(res.emails[0].from_domain, "primeeco.tech");
  assertEquals(res.emails[0].direction, "inbound");
  // The one own-domain self-copy is correctly counted.
  assertEquals(
    res.excluded_outbound,
    1,
    "only the genuine own-domain copy is excluded",
  );
  // The PrimeEco row is not in excluded_outbound — it survived.
  assert(
    res.emails.every((e: any) => e.direction === "inbound"),
    "surviving rows must all be inbound",
  );
});

// ════════════════════════════════════════════════════════════
// GAP-3 — makesafe_pipeline_items
// ════════════════════════════════════════════════════════════
Deno.test("GAP-3: pipeline_items joined to email for sender_domain + received_at; GAP-5 summary", async () => {
  const { client } = makeClient({
    pipeline_items: [
      {
        ref: "AJBR-67200",
        mailbox: "ses@secureworkswa.com.au",
        target_job: "job-1",
        sent_status: "verified_sent",
        attachment_refs: ["a1"],
        match_score: 0.95,
        match_method: "ref",
        source_event_ids: ["ev-1"],
      },
    ],
    email_events_raw: [{ id: "ev-1", post_id: "post-1" }],
    emails: [
      {
        post_id: "post-1",
        mailbox: "ses@secureworkswa.com.au",
        from_email: "dispatch@mlb.com.au",
        received_at: "2026-06-14T00:00:00Z",
      },
    ],
    email_attachments: [{ email_id: "post-1", status: "uploaded" }],
  });
  const res = await _makesafePipelineItems(client, {
    nowIso: "2026-06-15T00:00:00Z",
  });
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
      {
        ref: "OLD-1",
        mailbox: "ses@secureworkswa.com.au",
        target_job: null,
        sent_status: "not_sent",
        attachment_refs: [],
        match_score: null,
        source_event_ids: ["ev-old"],
      },
      {
        ref: "NEW-1",
        mailbox: "ses@secureworkswa.com.au",
        target_job: null,
        sent_status: "not_sent",
        attachment_refs: [],
        match_score: null,
        source_event_ids: ["ev-new"],
      },
    ],
    email_events_raw: [
      { id: "ev-old", post_id: "post-old" },
      { id: "ev-new", post_id: "post-new" },
    ],
    emails: [
      {
        post_id: "post-old",
        mailbox: "ses@secureworkswa.com.au",
        from_email: "x@mlb.com.au",
        received_at: "2026-01-01T00:00:00Z",
      },
      {
        post_id: "post-new",
        mailbox: "ses@secureworkswa.com.au",
        from_email: "x@mlb.com.au",
        received_at: "2026-06-14T00:00:00Z",
      },
    ],
    email_attachments: [],
  });
  // since defaults to 60d before nowIso => ~2026-04-16; post-old (Jan) excluded.
  const res = await _makesafePipelineItems(client, {
    nowIso: "2026-06-15T00:00:00Z",
  });
  assertEquals(res.count, 1);
  assertEquals(res.items[0].ref, "NEW-1");
});

Deno.test("GAP-3: sent_status filter is honoured", async () => {
  const { client } = makeClient({
    pipeline_items: [
      {
        ref: "R-SENT",
        mailbox: "ses@secureworkswa.com.au",
        target_job: "j1",
        sent_status: "verified_sent",
        attachment_refs: [],
        match_score: null,
        source_event_ids: ["e1"],
      },
      {
        ref: "R-NOTSENT",
        mailbox: "ses@secureworkswa.com.au",
        target_job: "j2",
        sent_status: "not_sent",
        attachment_refs: [],
        match_score: null,
        source_event_ids: ["e2"],
      },
    ],
    email_events_raw: [{ id: "e1", post_id: "p1" }, {
      id: "e2",
      post_id: "p2",
    }],
    emails: [
      {
        post_id: "p1",
        mailbox: "ses@secureworkswa.com.au",
        from_email: "x@mlb.com.au",
        received_at: "2026-06-14T00:00:00Z",
      },
      {
        post_id: "p2",
        mailbox: "ses@secureworkswa.com.au",
        from_email: "x@mlb.com.au",
        received_at: "2026-06-14T00:00:00Z",
      },
    ],
    email_attachments: [],
  });
  const res = await _makesafePipelineItems(client, {
    sent_status: "verified_sent",
    nowIso: "2026-06-15T00:00:00Z",
  });
  assertEquals(res.count, 1);
  assertEquals(res.items[0].ref, "R-SENT");
  assertEquals(res.sent_status, "verified_sent");
});

Deno.test("GAP-3 direction: tagged per sender_domain (inbound builder vs outbound self-copy), NOT excluded; null when unresolved", async () => {
  // GAP-3 is the fuller pipeline view, so it must KEEP both inbound and outbound
  // items but tag each so intake-audit can filter. An unresolved item (no email
  // link) has no sender_domain, so its direction is null (unknown, never guessed).
  const { client } = makeClient({
    pipeline_items: [
      {
        ref: "R-IN",
        mailbox: "ses@secureworkswa.com.au",
        target_job: "j1",
        sent_status: "needs_review",
        attachment_refs: [],
        match_score: null,
        source_event_ids: ["ev-in"],
      },
      {
        ref: "R-OUT",
        mailbox: "ses@secureworkswa.com.au",
        target_job: null,
        sent_status: "needs_review",
        attachment_refs: [],
        match_score: null,
        source_event_ids: ["ev-out"],
      },
      {
        ref: "R-UNRES",
        mailbox: "ses@secureworkswa.com.au",
        target_job: null,
        sent_status: "needs_review",
        attachment_refs: ["a-1"],
        match_score: null,
        source_event_ids: ["ev-orphan"],
      },
    ],
    email_events_raw: [
      { id: "ev-in", post_id: "post-in" },
      { id: "ev-out", post_id: "post-out" },
      { id: "ev-orphan", post_id: "post-missing" }, // no email row -> unresolved
    ],
    emails: [
      {
        post_id: "post-in",
        mailbox: "ses@secureworkswa.com.au",
        from_email: "dispatch@mlb.com.au",
        received_at: "2026-06-14T00:00:00Z",
      },
      // Our own outbound pack self-copied into the group: kept here, tagged outbound.
      {
        post_id: "post-out",
        mailbox: "ses@secureworkswa.com.au",
        from_email: "invoices@secureworksgroup.app",
        received_at: "2026-06-14T00:00:00Z",
      },
    ],
    email_attachments: [],
  });
  const res = await _makesafePipelineItems(client, {
    nowIso: "2026-06-15T00:00:00Z",
  });
  const byRef: Record<string, any> = {};
  for (const it of res.items) byRef[it.ref] = it;

  // All three retained (no direction-based exclusion in GAP-3).
  assertEquals(res.count, 3);
  // Inbound builder.
  assertEquals(byRef["R-IN"].direction, "inbound");
  assertEquals(byRef["R-IN"].sender_domain, "mlb.com.au");
  // Outbound self-copy KEPT but tagged.
  assertEquals(byRef["R-OUT"].direction, "outbound");
  assertEquals(byRef["R-OUT"].sender_domain, "secureworksgroup.app");
  // Unresolved -> direction null (never guessed).
  assertEquals(byRef["R-UNRES"].direction, null);
  assertEquals(byRef["R-UNRES"].email_link, "unresolved");
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
  const m = await _buildPipelineSentStatusMap(client, [
    "job-1",
    "job-2",
    "job-3",
  ]);
  assertEquals(m["job-1"], "verified_sent");
  assertEquals(m["job-2"], "needs_review");
  assertEquals("job-3" in m, false);
});

Deno.test("GAP-4: empty job list short-circuits to {}", async () => {
  const { client } = makeClient({});
  assertEquals(await _buildPipelineSentStatusMap(client, []), {});
});

// Multi-row precedence: verified_sent > needs_review > not_sent. Input order must
// never demote a stronger verdict (the last-write bug that let not_sent overwrite
// verified_sent when rows walked ascending id).
Deno.test("GAP-4: preferPipelineSentStatus ranks verified_sent above not_sent", () => {
  assertEquals(
    PIPELINE_SENT_STATUS_RANK.verified_sent >
      PIPELINE_SENT_STATUS_RANK.not_sent,
    true,
  );
  assertEquals(
    _preferPipelineSentStatus("verified_sent", "not_sent"),
    "verified_sent",
  );
  assertEquals(
    _preferPipelineSentStatus("not_sent", "verified_sent"),
    "verified_sent",
  );
  assertEquals(
    _preferPipelineSentStatus("needs_review", "not_sent"),
    "needs_review",
  );
  assertEquals(
    _preferPipelineSentStatus("not_sent", "needs_review"),
    "needs_review",
  );
  assertEquals(_preferPipelineSentStatus(undefined, "not_sent"), "not_sent");
  assertEquals(_preferPipelineSentStatus("verified_sent", ""), "verified_sent");
});

Deno.test("GAP-4: multi-row last-id not_sent does not demote verified_sent", async () => {
  const { client } = makeClient({
    pipeline_items: [
      { id: "pi-1", target_job: "job-1", sent_status: "verified_sent" },
      { id: "pi-2", target_job: "job-1", sent_status: "not_sent" },
    ],
  });
  const m = await _buildPipelineSentStatusMap(client, ["job-1"]);
  assertEquals(m["job-1"], "verified_sent");
});

Deno.test("GAP-4: multi-row reversed order still yields verified_sent", async () => {
  const { client } = makeClient({
    pipeline_items: [
      { id: "pi-9", target_job: "job-1", sent_status: "not_sent" },
      { id: "pi-1", target_job: "job-1", sent_status: "verified_sent" },
    ],
  });
  const m = await _buildPipelineSentStatusMap(client, ["job-1"]);
  assertEquals(m["job-1"], "verified_sent");
});

Deno.test("GAP-4: empty/null sent_status rows do not invent a sent verdict", async () => {
  const { client } = makeClient({
    pipeline_items: [
      { id: "pi-e", target_job: "job-1", sent_status: null },
      { id: "pi-b", target_job: "job-1", sent_status: "" },
    ],
  });
  const m = await _buildPipelineSentStatusMap(client, ["job-1"]);
  assertEquals("job-1" in m, false);
});

// ════════════════════════════════════════════════════════════
// GAP-2 — get_makesafe_attachment_url (DB-bound)
// ════════════════════════════════════════════════════════════
Deno.test("GAP-2: an uploaded attachment by attachment_id mints a 60s signed URL", async () => {
  const { client, signCalls } = makeClient({
    email_attachments: [
      {
        id: "att-1",
        email_id: "post-1",
        graph_attachment_id: "g-1",
        status: "uploaded",
        storage_path: "ses/2026/wo.pdf",
        name: "wo.pdf",
        content_type: "application/pdf",
      },
    ],
  });
  const res = await _getMakesafeAttachmentUrl(client, {
    attachment_id: "att-1",
  });
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
      {
        id: "att-2",
        email_id: "post-2",
        graph_attachment_id: "g-2",
        status: "uploaded",
        storage_path: "ses/x.pdf",
        name: "x.pdf",
        content_type: "application/pdf",
      },
    ],
  });
  const res = await _getMakesafeAttachmentUrl(client, {
    post_id: "post-2",
    graph_attachment_id: "g-2",
  });
  assertEquals(res.ok, true);
  assertEquals(res.attachment_id, "att-2");
});

Deno.test("GAP-2 status guard: a non-uploaded (pending) attachment is rejected, no URL minted", async () => {
  const { client, signCalls } = makeClient({
    email_attachments: [
      {
        id: "att-3",
        email_id: "post-3",
        graph_attachment_id: "g-3",
        status: "pending",
        storage_path: null,
      },
    ],
  });
  const res = await _getMakesafeAttachmentUrl(client, {
    attachment_id: "att-3",
  });
  assertEquals(res.ok, false);
  assertEquals(res.status, "pending");
  assert(res.error!.includes("pending"));
  assertEquals(signCalls.length, 0); // never tried to sign
});

Deno.test("GAP-2 status guard: a purged attachment is rejected with a purged reason", async () => {
  const { client } = makeClient({
    email_attachments: [
      {
        id: "att-4",
        email_id: "post-4",
        graph_attachment_id: "g-4",
        status: "purged",
        storage_path: null,
      },
    ],
  });
  const res = await _getMakesafeAttachmentUrl(client, {
    attachment_id: "att-4",
  });
  assertEquals(res.ok, false);
  assert(res.error!.includes("purged"));
});

Deno.test("GAP-2: a missing attachment returns ok:false not found", async () => {
  const { client } = makeClient({ email_attachments: [] });
  const res = await _getMakesafeAttachmentUrl(client, {
    attachment_id: "nope",
  });
  assertEquals(res.ok, false);
  assert(res.error!.includes("not found"));
});

// ════════════════════════════════════════════════════════════
// GAP-6 — get_makesafe_email (DB-bound)
// ════════════════════════════════════════════════════════════
Deno.test("GAP-6: happy path returns the email + attachments + GAP-5 summary", async () => {
  const { client } = makeClient({
    emails: [
      {
        post_id: "post-1",
        mailbox: "ses@secureworkswa.com.au",
        subject: "WO AJBR-67200",
        body_preview: "make safe needed",
        from_email: "dispatch@mlb.com.au",
        received_at: "2026-06-14T00:00:00Z",
        has_attachments: true,
        pii_purged_at: null,
      },
    ],
    email_attachments: [
      {
        id: "a1",
        email_id: "post-1",
        graph_attachment_id: "g1",
        name: "wo.pdf",
        content_type: "application/pdf",
        size_bytes: 1234,
        status: "uploaded",
        attachment_kind: "fileAttachment",
      },
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
      {
        post_id: "post-T",
        mailbox: "ses@secureworkswa.com.au",
        subject: null,
        body_preview: null,
        from_email: null,
        received_at: "2026-01-01T00:00:00Z",
        has_attachments: true,
        pii_purged_at: "2026-04-01T00:00:00Z",
      },
    ],
    email_attachments: [
      {
        id: "a-purged",
        email_id: "post-T",
        graph_attachment_id: "g-p",
        name: null,
        content_type: null,
        size_bytes: null,
        status: "purged",
        attachment_kind: "fileAttachment",
      },
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

// ════════════════════════════════════════════════════════════
// PostgREST 1000-row cap — pagination (.range()) must return ALL rows
// ════════════════════════════════════════════════════════════
Deno.test("Pagination: GAP-1 returns ALL emails across >1000-row pages (not capped at 1000)", async () => {
  // 2500 ses@ emails in window, none drafted. The stub's .range() returns
  // [from,to] slices, so a non-paginating read would stop at 1000.
  const N = 2500;
  const emails = Array.from({ length: N }, (_, i) => ({
    post_id: `post-${i}`,
    mailbox: "ses@secureworkswa.com.au",
    received_at: "2026-06-14T00:00:00Z",
    from_email: "x@mlb.com.au",
    has_attachments: false,
    pii_purged_at: null,
  }));
  const { client } = makeClient({
    emails,
    makesafe_intake_drafts: [],
    email_attachments: [],
  });
  const res = await _makesafeNewEmails(client, {
    nowIso: "2026-06-15T00:00:00Z",
  });
  assertEquals(res.count, N); // ALL 2500, not 1000
  assertEquals(res.emails.length, N);
});

Deno.test("Pagination GAP-1 drafts: an already-drafted email beyond row 1000 is STILL excluded (no resurfacing)", async () => {
  // The drafts read has NO window -> it is the soonest to truncate. Put a known
  // already-drafted id at draft index 1500 (page 2). If the drafts read stopped
  // at 1000 it would be missing from knownIds and the email would resurface as
  // "new" -> duplicate intake. Paginated, it must stay excluded.
  const NEW = "post-NEW";
  const DRAFTED = "post-DRAFTED-1500";
  const emails = [
    {
      post_id: NEW,
      mailbox: "ses@secureworkswa.com.au",
      received_at: "2026-06-14T00:00:00Z",
      from_email: "x@mlb.com.au",
      has_attachments: false,
      pii_purged_at: null,
    },
    {
      post_id: DRAFTED,
      mailbox: "ses@secureworkswa.com.au",
      received_at: "2026-06-14T00:00:00Z",
      from_email: "x@mlb.com.au",
      has_attachments: false,
      pii_purged_at: null,
    },
  ];
  // 2000 drafts; the one matching DRAFTED sits at index 1500 (second page).
  const drafts = Array.from({ length: 2000 }, (_, i) => ({
    graph_message_id: i === 1500 ? DRAFTED : `draft-filler-${i}`,
    status: "approved",
  }));
  const { client } = makeClient({
    emails,
    makesafe_intake_drafts: drafts,
    email_attachments: [],
  });
  const res = await _makesafeNewEmails(client, {
    nowIso: "2026-06-15T00:00:00Z",
  });
  assertEquals(res.count, 1);
  assertEquals(res.emails[0].post_id, NEW);
  assert(
    !res.emails.some((e: any) => e.post_id === DRAFTED),
    "already-drafted email beyond row 1000 must NOT resurface",
  );
});

Deno.test("Pagination: GAP-3 returns ALL pipeline_items across >1000-row pages", async () => {
  const N = 2300;
  const pipeline_items = Array.from({ length: N }, (_, i) => ({
    ref: `R-${i}`,
    mailbox: "ses@secureworkswa.com.au",
    target_job: null,
    sent_status: "not_sent",
    attachment_refs: [],
    match_score: null,
    source_event_ids: [`ev-${i}`],
  }));
  const email_events_raw = Array.from(
    { length: N },
    (_, i) => ({ id: `ev-${i}`, post_id: `post-${i}` }),
  );
  const emails = Array.from({ length: N }, (_, i) => ({
    post_id: `post-${i}`,
    mailbox: "ses@secureworkswa.com.au",
    from_email: "x@mlb.com.au",
    received_at: "2026-06-14T00:00:00Z",
  }));
  const { client } = makeClient({
    pipeline_items,
    email_events_raw,
    emails,
    email_attachments: [],
  });
  const res = await _makesafePipelineItems(client, {
    nowIso: "2026-06-15T00:00:00Z",
  });
  assertEquals(res.count, N); // ALL 2300, not 1000
});

// ════════════════════════════════════════════════════════════
// GAP-3 no-silent-drops — unresolvable items must NOT vanish
// ════════════════════════════════════════════════════════════
Deno.test("GAP-3 no-silent-drops: an unresolvable item is INCLUDED flagged unresolved; resolved-but-old is excluded", async () => {
  const { client } = makeClient({
    pipeline_items: [
      // Resolved + in window -> included, email_link:"resolved".
      {
        ref: "R-OK",
        mailbox: "ses@secureworkswa.com.au",
        target_job: "j1",
        sent_status: "not_sent",
        attachment_refs: [],
        match_score: null,
        source_event_ids: ["ev-ok"],
      },
      // Resolved but email older than `since` -> excluded.
      {
        ref: "R-OLD",
        mailbox: "ses@secureworkswa.com.au",
        target_job: null,
        sent_status: "not_sent",
        attachment_refs: [],
        match_score: null,
        source_event_ids: ["ev-old"],
      },
      // Unresolvable: source_event_ids points at an event with no email row.
      {
        ref: "R-UNRESOLVED",
        mailbox: "ses@secureworkswa.com.au",
        target_job: null,
        sent_status: "needs_review",
        attachment_refs: ["a-1"],
        match_score: null,
        source_event_ids: ["ev-orphan"],
      },
    ],
    email_events_raw: [
      { id: "ev-ok", post_id: "post-ok" },
      { id: "ev-old", post_id: "post-old" },
      { id: "ev-orphan", post_id: "post-missing" }, // points to an email that does not exist
    ],
    emails: [
      {
        post_id: "post-ok",
        mailbox: "ses@secureworkswa.com.au",
        from_email: "x@mlb.com.au",
        received_at: "2026-06-14T00:00:00Z",
      },
      {
        post_id: "post-old",
        mailbox: "ses@secureworkswa.com.au",
        from_email: "x@mlb.com.au",
        received_at: "2026-01-01T00:00:00Z",
      },
      // post-missing intentionally absent -> R-UNRESOLVED has no usable email link.
    ],
    email_attachments: [],
  });
  const res = await _makesafePipelineItems(client, {
    nowIso: "2026-06-15T00:00:00Z",
  });
  const byRef: Record<string, any> = {};
  for (const it of res.items) byRef[it.ref] = it;

  // Resolved + in window: present, flagged resolved.
  assert(byRef["R-OK"], "resolved in-window item must be present");
  assertEquals(byRef["R-OK"].email_link, "resolved");
  assertEquals(byRef["R-OK"].source_email_id, "post-ok");

  // Resolved but old: correctly excluded.
  assertEquals(
    "R-OLD" in byRef,
    false,
    "resolved-but-old item must be excluded by the window",
  );

  // Unresolvable: INCLUDED, flagged, with null source_email_id + received_at.
  assert(
    byRef["R-UNRESOLVED"],
    "unresolvable item must NOT be dropped (no-silent-drops)",
  );
  assertEquals(byRef["R-UNRESOLVED"].email_link, "unresolved");
  assertEquals(byRef["R-UNRESOLVED"].source_email_id, null);
  assertEquals(byRef["R-UNRESOLVED"].received_at, null);
  // attachment_count falls back to attachment_refs length when the email is unresolved.
  assertEquals(byRef["R-UNRESOLVED"].attachment_count, 1);

  // notes documents the rule.
  assert(
    res.notes.includes("unresolved"),
    "GAP-3 response must carry a notes field documenting the rule",
  );
});

// ════════════════════════════════════════════════════════════
// Fix A — fetchAllRowsInChunks dedups ids before chunking
// (boundary is forced via the exported IN_MAX_COUNT count cap, not a hardcoded
//  100/500, so it stays correct if the budget/cap is ever re-tuned.)
// ════════════════════════════════════════════════════════════
Deno.test("fetchAllRowsInChunks: a duplicate id straddling a chunk boundary returns its DB row exactly once", async () => {
  // Build (IN_MAX_COUNT + 1) short ids where the duplicate sits at index 0 AND
  // index IN_MAX_COUNT. Short ids stay well under IN_URL_BUDGET, so the count cap
  // (IN_MAX_COUNT) is what forces the split: chunk 1 = indices 0..IN_MAX_COUNT-1,
  // chunk 2 = index IN_MAX_COUNT. The dup therefore lands in BOTH chunks. Without
  // the dedup the .in() read for each chunk would match the same DB row, returning
  // it twice. One DB row per distinct id is the contract.
  const DUP = "dup-id";
  const ids = [DUP];
  for (let i = 1; i < IN_MAX_COUNT; i++) ids.push(`id-${i}`); // fills indices 1..IN_MAX_COUNT-1
  ids.push(DUP); // index IN_MAX_COUNT -> would be chunk 2 without dedup
  assertEquals(ids.length, IN_MAX_COUNT + 1);

  // Seed one DB row per distinct id (IN_MAX_COUNT distinct ids -> IN_MAX_COUNT rows).
  const distinct = Array.from(new Set(ids));
  assertEquals(distinct.length, IN_MAX_COUNT);
  const { client } = makeClient({
    widgets: distinct.map((id) => ({
      widget_id: id,
      payload: `row-for-${id}`,
    })),
  });

  const rows = await _fetchAllRowsInChunks<{ widget_id: string }>(
    ids,
    (chunkIds) =>
      client.from("widgets").select("widget_id, payload").in(
        "widget_id",
        chunkIds,
      ),
    "widgets read",
  );

  // Total rows == distinct ids (no double-count from the straddling duplicate).
  assertEquals(rows.length, IN_MAX_COUNT);
  // The duplicate id's row appears exactly once.
  const dupRows = rows.filter((r) => r.widget_id === DUP);
  assertEquals(
    dupRows.length,
    1,
    "duplicate id must return its DB row exactly once",
  );
  // Every distinct id appears exactly once.
  const seen = new Set(rows.map((r) => r.widget_id));
  assertEquals(seen.size, IN_MAX_COUNT);
});

// ════════════════════════════════════════════════════════════
// Fix C (2026-06-16) — URL-BUDGET chunking. A FIXED COUNT cannot be safe for both
// 37-char UUIDs (email_events_raw.id, GAP-3) and ~150-char Graph post-ids
// (email_attachments.email_id = emails.post_id, GAP-1): 100 long post-ids build a
// ~15-20KB `.in()` URL the Supabase gateway drops ("Invalid URL" / "error sending
// request"). chunkByUrlBudget sizes each chunk by encoded byte budget instead, so
// EVERY chunk's `.in()` list stays under IN_URL_BUDGET regardless of id length.
// These are the regression guards for the live GAP-1/GAP-3 500.
// ════════════════════════════════════════════════════════════
Deno.test("budget constants: IN_URL_BUDGET leaves gateway headroom; IN_MAX_COUNT under the row cap", () => {
  // ~6000B list + the rest of the URL (table, columns, `id=in.(`, headers) stays
  // well under the ~8KB gateway limit that 500'd GAP-1/GAP-3.
  assert(
    IN_URL_BUDGET <= 6500,
    `IN_URL_BUDGET=${IN_URL_BUDGET} must leave headroom under the ~8KB gateway URL limit`,
  );
  assert(
    IN_URL_BUDGET >= 2000,
    `IN_URL_BUDGET=${IN_URL_BUDGET} too small — would over-chunk short UUIDs`,
  );
  // The secondary count cap keeps chunks under the PostgREST 1000-row response cap.
  assert(
    IN_MAX_COUNT <= 1000,
    "IN_MAX_COUNT must not exceed the PostgREST 1000-row cap",
  );
});

Deno.test("chunkByUrlBudget: short UUIDs pack many per chunk; every chunk stays within budget AND count cap", () => {
  // 600 UUID-shaped ids. encodedIdCost(uuid) ~= 37, so ~162 fit under IN_URL_BUDGET,
  // but IN_MAX_COUNT (the count cap) caps each chunk first.
  const ids = Array.from(
    { length: 600 },
    (_, i) => `${i}`.padStart(8, "0") + "-1234-5678-9abc-def012345678",
  );
  const chunks = _chunkByUrlBudget(ids);
  // No id is lost or duplicated.
  assertEquals(chunks.reduce((n, c) => n + c.length, 0), ids.length);
  assertEquals(new Set(chunks.flat()).size, ids.length);
  for (const c of chunks) {
    const listBytes = c.reduce((n, id) => n + _encodedIdCost(id), 0);
    assert(
      listBytes <= IN_URL_BUDGET,
      `chunk list ${listBytes}B exceeds IN_URL_BUDGET ${IN_URL_BUDGET}`,
    );
    assert(
      c.length <= IN_MAX_COUNT,
      `chunk count ${c.length} exceeds IN_MAX_COUNT ${IN_MAX_COUNT}`,
    );
  }
  // Short ids should pack densely: far fewer chunks than one-per-id.
  assert(chunks.length < ids.length, "short ids must pack multiple per chunk");
});

Deno.test("chunkByUrlBudget: LONG ~150-char Graph post-ids force few-per-chunk; every chunk's encoded list stays under budget", () => {
  // The GAP-1 live bug: email_attachments.email_id = emails.post_id is a Graph
  // post id ~100-150 chars with URL-special chars (/, +, =). A fixed count of 100
  // of these blew the URL. Budget chunking must split them into many small chunks.
  const LONG_LEN = 150;
  const makeLongId = (i: number) =>
    `AAMkAGI2/${i}+Tsz==` + "x".repeat(LONG_LEN - 18); // ~150 chars, with /, +, = (encoded longer)
  const ids = Array.from({ length: 300 }, (_, i) => makeLongId(i));
  // Sanity: a single encoded long id is large; 100 of them would blow the URL.
  const oneCost = _encodedIdCost(ids[0]);
  assert(oneCost > 100, `long id encoded cost ${oneCost} should be >100 chars`);
  assert(
    oneCost * 100 > IN_URL_BUDGET,
    "100 long ids must exceed the URL budget (the live bug)",
  );

  const chunks = _chunkByUrlBudget(ids);
  // No id lost or duplicated.
  assertEquals(chunks.reduce((n, c) => n + c.length, 0), ids.length);
  assertEquals(new Set(chunks.flat()).size, ids.length);
  // EVERY chunk's encoded id-list stays under the budget (the core guarantee).
  for (const c of chunks) {
    const listBytes = c.reduce((n, id) => n + _encodedIdCost(id), 0);
    assert(
      listBytes <= IN_URL_BUDGET,
      `long-id chunk list ${listBytes}B exceeds IN_URL_BUDGET ${IN_URL_BUDGET}`,
    );
  }
  // Long ids -> many chunks (fewer ids each) vs short ids.
  assert(chunks.length > 1, "long ids must split into multiple chunks");
  // Each long-id chunk holds far fewer than IN_MAX_COUNT (budget binds first).
  assert(
    chunks[0].length < IN_MAX_COUNT,
    "long-id chunk should be budget-bound, not count-bound",
  );
});

Deno.test("chunkByUrlBudget: a single over-budget id still gets its own 1-element chunk (no drop, no infinite loop)", () => {
  // One id whose encoded cost alone exceeds IN_URL_BUDGET must NOT be dropped and
  // must NOT loop forever — it lands in its own chunk.
  const huge = "z".repeat(IN_URL_BUDGET + 500);
  const chunks = _chunkByUrlBudget([huge, "small-1", "small-2"]);
  // The huge id is present in exactly one chunk, alone.
  const hugeChunk = chunks.find((c) => c.includes(huge));
  assert(hugeChunk, "over-budget id must not be dropped");
  assertEquals(
    hugeChunk!.length,
    1,
    "over-budget id must be alone in its chunk",
  );
  // No id is lost.
  assertEquals(new Set(chunks.flat()).size, 3);
});

Deno.test("chunkByUrlBudget: empty input -> no chunks", () => {
  assertEquals(_chunkByUrlBudget([]), []);
});

Deno.test("fetchAllRowsInChunks: LONG post-ids are split into multiple small .in() reads and ALL rows return exactly once", async () => {
  // End-to-end: feed long Graph post-ids through fetchAllRowsInChunks (the path
  // GAP-1's email_attachments.email_id .in() and GAP-3's joins take). Assert
  // multiple chunks, every chunk under budget, and every row returned once.
  const LONG_LEN = 150;
  const ids = Array.from(
    { length: 250 },
    (_, i) => `AAMkAGI2/${i}+Tsz==` + "x".repeat(LONG_LEN - 18),
  );
  const seenChunkBytes: number[] = [];

  const { client, inCalls } = makeClient({
    widgets: ids.map((id) => ({ widget_id: id })),
  });

  const rows = await _fetchAllRowsInChunks<{ widget_id: string }>(
    ids,
    (chunkIds) => {
      // Record each chunk's encoded `.in()` list size as it is actually issued.
      seenChunkBytes.push(
        chunkIds.reduce((n, id) => n + _encodedIdCost(id), 0),
      );
      return client.from("widgets").select("widget_id").in(
        "widget_id",
        chunkIds,
      );
    },
    "widgets read",
  );

  // Multiple `.in()` reads were issued (multi-chunk for long ids).
  assert(
    inCalls["widgets"] > 1,
    "long ids must split into multiple .in() reads",
  );
  assertEquals(inCalls["widgets"], seenChunkBytes.length);
  // EVERY issued chunk's encoded id-list stayed under the URL budget.
  for (const b of seenChunkBytes) {
    assert(
      b <= IN_URL_BUDGET,
      `issued chunk ${b}B exceeded IN_URL_BUDGET ${IN_URL_BUDGET}`,
    );
  }
  // All rows returned exactly once.
  assertEquals(rows.length, ids.length);
  assertEquals(new Set(rows.map((r) => r.widget_id)).size, ids.length);
});

Deno.test("fetchAllRowsInChunks: many short ids split by the count cap into multiple .in() reads; ALL rows return", async () => {
  // 2.5x IN_MAX_COUNT short ids -> 3 chunks via the count cap -> 3 `.in()` reads.
  const N = IN_MAX_COUNT * 2 + Math.floor(IN_MAX_COUNT / 2); // 2.5 cap-sized chunks
  const ids = Array.from({ length: N }, (_, i) => `id-${i}`);
  const expectedChunks = Math.ceil(N / IN_MAX_COUNT);
  assertEquals(expectedChunks, 3);

  const { client, inCalls } = makeClient({
    widgets: ids.map((id) => ({ widget_id: id })),
  });

  const rows = await _fetchAllRowsInChunks<{ widget_id: string }>(
    ids,
    (chunkIds) =>
      client.from("widgets").select("widget_id").in("widget_id", chunkIds),
    "widgets read",
  );

  // Count-cap split: one .in() per cap-sized chunk.
  assertEquals(
    inCalls["widgets"],
    expectedChunks,
    "each cap-sized chunk must be a separate .in() read",
  );
  assertEquals(rows.length, N);
  assertEquals(new Set(rows.map((r) => r.widget_id)).size, N);
});

// ════════════════════════════════════════════════════════════
// Fix B — GAP-6 attachment read is paginated (no 1000-row truncation)
// ════════════════════════════════════════════════════════════
Deno.test("GAP-6: an email with >1000 attachments returns ALL of them across 2 .range() pages (status summary counts all)", async () => {
  // 1500 uploaded attachments on one email forces a second .range() page (the
  // stub slices [from,to], so an unpaginated read would stop at 1000). All 1500
  // must come back and the GAP-5 summary must count every one.
  const N = 1500;
  const email_attachments = Array.from({ length: N }, (_, i) => ({
    id: `att-${i}`,
    email_id: "post-big",
    graph_attachment_id: `g-${i}`,
    name: `file-${i}.pdf`,
    content_type: "application/pdf",
    size_bytes: 100,
    status: "uploaded",
    attachment_kind: "fileAttachment",
  }));
  const { client } = makeClient({
    emails: [
      {
        post_id: "post-big",
        mailbox: "ses@secureworkswa.com.au",
        subject: "many attachments",
        body_preview: "p",
        from_email: "x@mlb.com.au",
        received_at: "2026-06-14T00:00:00Z",
        has_attachments: true,
        pii_purged_at: null,
      },
    ],
    email_attachments,
  });

  const res = await _getMakesafeEmail(client, { post_id: "post-big" });
  assertEquals(res.found, true);
  assertEquals(res.attachments!.length, N); // ALL 1500, not capped at 1000
  assertEquals(res.attachment_status_summary!.uploaded, N); // summary counts them all
});
