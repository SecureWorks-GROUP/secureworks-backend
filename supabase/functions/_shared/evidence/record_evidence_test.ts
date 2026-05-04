// T7 Loop 1 — Tests for recordEvidence + match + evidence_ref + storage helpers.
//
// Run from secureworks-site/:
//   deno test --allow-net --allow-env --allow-read \
//     supabase/functions/_shared/evidence/record_evidence_test.ts
//
// All tests use dry_run mode + fake Supabase. No live DB calls.

import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  EvidenceCapture,
  BODY_PREVIEW_MAX,
  SAFE_SUMMARY_MAX,
  EXTRACTOR_ELIGIBLE_CHANNELS,
} from "./types.ts";
import { resolveMatch } from "./match.ts";
import {
  computeHash,
  buildPointerPath,
  pickExtension,
  writeBody,
  parsePointer,
  readBodyAndVerify,
  signBodyUrl,
} from "./storage.ts";
import { makeEvidenceRef, validateProposalEvidenceRefs } from "./evidence_ref.ts";
import { recordEvidence } from "./record_evidence.ts";
import { _resetFlagCache } from "./feature_flag.ts";
import { insertProposalWithEvidenceCheck } from "./insert_proposal.ts";

// ---------- Fake Supabase ----------

interface InsertCall {
  table: string;
  values: Record<string, unknown>;
}

interface FakeOpts {
  failOn?: string;
  spineId?: string;
  enqueueId?: string;
  /** When true (default), the flag reader returns evidence_capture_v1 enabled. */
  flagOn?: boolean;
}

// deno-lint-ignore no-explicit-any
function makeFakeSupabase(opts: FakeOpts = {}): { client: any; calls: InsertCall[] } {
  _resetFlagCache(); // every test starts with a clean flag cache
  const calls: InsertCall[] = [];
  const flagOn = opts.flagOn ?? true; // default ON to mirror the live-writer assumption

  // Real-Supabase semantics:
  //   .insert(values)                         -> data: null (just await it)
  //   .insert(values).select(cols)            -> data: [row]
  //   .insert(values).select(cols).single()   -> data: row
  // The mock honors all three so a writer that forgets to chain .select()
  // gets data:null in the test (matching prod behavior) instead of being
  // saved by an over-generous fake.
  function insertResultForTable(table: string) {
    if (opts.failOn === table) {
      return { rows: null as Array<Record<string, unknown>> | null, error: { message: "simulated failure" } };
    }
    if (table === "business_events") {
      return {
        rows: [{ id: opts.spineId ?? "spine-uuid-1", occurred_at: "2026-05-02T00:00:00Z" }],
        error: null as { message: string } | null,
      };
    }
    if (table === "extraction_jobs") {
      return { rows: [{ id: opts.enqueueId ?? "queue-uuid-1" }], error: null };
    }
    return { rows: [] as Array<Record<string, unknown>>, error: null };
  }

  // deno-lint-ignore no-explicit-any
  const client: any = {
    from(table: string) {
      return {
        // SELECT chain used by the feature_flag reader.
        // deno-lint-ignore no-explicit-any
        select(_cols: string): any {
          const chain = {
            // deno-lint-ignore no-explicit-any
            eq(_col: string, _val: unknown): any { return chain; },
            // deno-lint-ignore no-explicit-any
            limit(_n: number): any {
              if (table === "feature_flags") {
                return Promise.resolve({
                  data: [{ enabled: flagOn, shadow_mode: false }],
                  error: null,
                });
              }
              return Promise.resolve({ data: [], error: null });
            },
          };
          return chain;
        },
        // deno-lint-ignore no-explicit-any
        insert(values: unknown): any {
          calls.push({ table, values: values as Record<string, unknown> });
          const r = insertResultForTable(table);
          // Thenable: awaiting the insert directly returns data:null,
          // mirroring real Supabase (which only returns rows when you
          // chain .select()).
          const directThenable: PromiseLike<{ data: null; error: { message: string } | null }> = {
            then(onfulfilled, onrejected) {
              return Promise.resolve({ data: null, error: r.error })
                .then(onfulfilled, onrejected);
            },
          };
          // Attach a .select(cols) chain that DOES return rows.
          // deno-lint-ignore no-explicit-any
          (directThenable as any).select = (_cols: string) => {
            const selectThenable: PromiseLike<{ data: Array<Record<string, unknown>> | null; error: { message: string } | null }> = {
              then(onfulfilled, onrejected) {
                return Promise.resolve({ data: r.rows, error: r.error })
                  .then(onfulfilled, onrejected);
              },
            };
            // deno-lint-ignore no-explicit-any
            (selectThenable as any).single = () => {
              return Promise.resolve({
                data: r.rows && r.rows.length > 0 ? r.rows[0] : null,
                error: r.error,
              });
            };
            return selectThenable;
          };
          return directThenable;
        },
      };
    },
  };
  return { client, calls };
}

// ---------- match.ts tests ----------

Deno.test("match: direct_job_id forces matched + high confidence", () => {
  const r = resolveMatch({ job_id: "SWP-26090", match_method: "direct_job_id" });
  assertEquals(r.match_status, "matched");
  assertEquals(r.match_method, "direct_job_id");
  assert(r.match_confidence !== null && r.match_confidence >= 0.95);
  assertEquals(r.job_id, "SWP-26090");
});

Deno.test("match: confidence below floor downgrades to unresolved and drops job_id", () => {
  const r = resolveMatch({ job_id: "SWP-1", match_method: "single_recent_active_job", match_confidence: 0.4 });
  assertEquals(r.match_status, "unresolved");
  assertEquals(r.job_id, null, "low-confidence guess must not leak job_id");
  assertEquals(r.match_confidence, 0.4);
  assert(r.notes.some((n) => n.includes("below floor")));
});

Deno.test("match: confidence at floor keeps matched", () => {
  const r = resolveMatch({ job_id: "SWP-1", match_method: "contact_id", match_confidence: 0.6 });
  assertEquals(r.match_status, "matched");
  assertEquals(r.job_id, "SWP-1");
});

Deno.test("match: no job_id but positive confidence -> ambiguous", () => {
  const r = resolveMatch({ job_id: null, match_method: "single_recent_active_job", match_confidence: 0.55 });
  assertEquals(r.match_status, "ambiguous");
  assertEquals(r.job_id, null);
});

Deno.test("match: no job_id no confidence -> unresolved", () => {
  const r = resolveMatch({ job_id: null });
  assertEquals(r.match_status, "unresolved");
});

Deno.test("match: no_match_attempted -> ignored", () => {
  const r = resolveMatch({ job_id: null, no_match_attempted: true });
  assertEquals(r.match_status, "ignored");
  assertEquals(r.match_method, "none");
});

Deno.test("match: confidence clamp >1 and <0", () => {
  const hi = resolveMatch({ job_id: "x", match_method: "direct_reference", match_confidence: 1.7 });
  assertEquals(hi.match_confidence, 1);
  const lo = resolveMatch({ job_id: null, match_confidence: -0.4 });
  assertEquals(lo.match_confidence, 0);
});

// ---------- storage.ts tests ----------

Deno.test("storage: computeHash is stable for same canonical text", async () => {
  const a = await computeHash("hello\r\nworld   \n");
  const b = await computeHash("hello\nworld\n");
  assertEquals(a, b, "CRLF + trailing spaces canonicalized to LF + trimmed");
});

Deno.test("storage: pickExtension uses filename when present", () => {
  assertEquals(pickExtension(undefined, "quote.pdf"), ".pdf");
  assertEquals(pickExtension("text/plain", undefined), ".txt");
  assertEquals(pickExtension("audio/mpeg", undefined), ".mp3");
  assertEquals(pickExtension(undefined, undefined), ".txt");
});

Deno.test("storage: bodies pointer path uses channel prefix", () => {
  const path = buildPointerPath({
    org_id: "org-1",
    channel: "email",
    source_id: "inbox-evt-9",
    bucket: "evidence-bodies",
  });
  assertEquals(path, "org-1/email/inbox-evt-9.txt");
});

Deno.test("storage: audio bucket includes job dir", () => {
  const path = buildPointerPath({
    org_id: "org-1",
    channel: "call",
    source_id: "ghl-call-7",
    job_id: "SWP-26090",
    mime: "audio/mpeg",
    bucket: "evidence-audio",
  });
  assertEquals(path, "org-1/SWP-26090/call/ghl-call-7.mp3");
});

Deno.test("storage: orphan attachment when no job_id", () => {
  const path = buildPointerPath({
    org_id: "org-1",
    channel: "email",
    source_id: "inbox-evt-1",
    filename: "quote.pdf",
    bucket: "evidence-attachments",
  });
  assertEquals(path, "org-1/orphan/inbox-evt-1/quote.pdf");
});

Deno.test("storage: writeBody returns hash + pointer (Loop 1 stub)", async () => {
  const r = await writeBody({
    org_id: "org-1",
    channel: "email",
    source_id: "x",
    body_full: "hello world",
  });
  assertEquals(r.bucket, "evidence-bodies");
  assertEquals(r.pointer, "evidence-bodies://org-1/email/x.txt");
  assertEquals(r.hash.length, 64);
  assertEquals(r.bytes, 11);
});

Deno.test("storage: writeBody live mode uploads via storage_client", async () => {
  const uploads: Array<{ bucket: string; path: string; bytes: number }> = [];
  const fakeStorage = {
    from(bucket: string) {
      return {
        // deno-lint-ignore no-explicit-any
        async upload(path: string, data: Uint8Array, _opts: any) {
          uploads.push({ bucket, path, bytes: data.byteLength });
          return { data: { path }, error: null };
        },
      };
    },
  };
  const r = await writeBody({
    org_id: "org-1",
    channel: "email",
    source_id: "evt-9",
    body_full: "hello world",
    mime: "text/plain",
  }, fakeStorage);
  assertEquals(uploads.length, 1);
  assertEquals(uploads[0].bucket, "evidence-bodies");
  assertEquals(uploads[0].path, "org-1/email/evt-9.txt");
  assertEquals(r.hash.length, 64);
});

Deno.test("storage: writeBody propagates upload errors", async () => {
  const fakeStorage = {
    from(_bucket: string) {
      return {
        async upload() {
          return { data: null, error: { message: "RLS denied" } };
        },
      };
    },
  };
  await assertRejects(
    () => writeBody({
      org_id: "org-1",
      channel: "email",
      source_id: "evt-9",
      body_full: "hello world",
    }, fakeStorage),
    Error,
    "RLS denied",
  );
});

Deno.test("storage: parsePointer round-trip", () => {
  const p = parsePointer("evidence-bodies://org-1/email/evt-9.txt");
  assertEquals(p, { bucket: "evidence-bodies", path: "org-1/email/evt-9.txt" });
  assertEquals(parsePointer("not a pointer"), null);
});

Deno.test("storage: readBodyAndVerify rejects on hash mismatch", async () => {
  const body = "hello world";
  const correctHash = await computeHash(body);
  const fakeStorage = {
    from(_bucket: string) {
      return {
        async download() {
          // Return DIFFERENT bytes than the caller will hash against.
          return {
            data: new Blob([new TextEncoder().encode("tampered")]),
            error: null,
          };
        },
      };
    },
  };
  await assertRejects(
    () => readBodyAndVerify(fakeStorage, "evidence-bodies://org-1/email/x.txt", correctHash),
    Error,
    "hash mismatch",
  );
});

Deno.test("storage: readBodyAndVerify passes when hash matches", async () => {
  const body = "hello world";
  const correctHash = await computeHash(body);
  const fakeStorage = {
    from(_bucket: string) {
      return {
        async download() {
          return {
            data: new Blob([new TextEncoder().encode(body)]),
            error: null,
          };
        },
      };
    },
  };
  const buf = await readBodyAndVerify(
    fakeStorage,
    "evidence-bodies://org-1/email/x.txt",
    correctHash,
  );
  assertEquals(new TextDecoder().decode(buf), body);
});

Deno.test("storage: signBodyUrl returns signed URL", async () => {
  const fakeStorage = {
    from(_bucket: string) {
      return {
        async createSignedUrl(_path: string, _ttl: number) {
          return { data: { signedUrl: "https://example/signed?token=abc" }, error: null };
        },
      };
    },
  };
  const url = await signBodyUrl(fakeStorage, "evidence-bodies://org-1/email/x.txt");
  assertEquals(url, "https://example/signed?token=abc");
});

// ---------- evidence_ref.ts tests ----------

Deno.test("evidence_ref: makeEvidenceRef prefers safe_summary over body_preview", () => {
  const ref = makeEvidenceRef({
    id: "spine-1",
    source_table: "inbox_events",
    source_id: "evt-9",
    channel: "email",
    direction: "inbound",
    occurred_at: "2026-05-02T00:00:00Z",
    job_id: "SWP-26090",
    contact_id: "contact-1",
    safe_summary: "Client asked for callback",
    body_preview: "Hi, I would like a callback this afternoon if possible. Thanks. — Sue",
  });
  assertEquals(ref.summary, "Client asked for callback");
  assertEquals(ref.evidence_id, "spine-1");
});

Deno.test("evidence_ref: validator off mode always passes", () => {
  const r = validateProposalEvidenceRefs({}, "off");
  assertEquals(r.ok, true);
});

Deno.test("evidence_ref: soft-warn returns ok=false but does not throw on missing refs", () => {
  const r = validateProposalEvidenceRefs({ action_payload: {} }, "soft-warn");
  assertEquals(r.ok, false);
  assert(r.errors.some((e) => e.includes("evidence_refs must be an array")));
});

Deno.test("evidence_ref: strict rejects missing refs", () => {
  const r = validateProposalEvidenceRefs({ action_payload: { evidence_refs: [] } }, "strict");
  assertEquals(r.ok, false);
  assert(r.errors.some((e) => e.includes("empty")));
});

Deno.test("evidence_ref: strict accepts well-formed ref", () => {
  const r = validateProposalEvidenceRefs({
    action_payload: {
      evidence_refs: [{
        evidence_id: "spine-1",
        source_table: "business_events",
        source_id: "spine-1",
        summary: "Client SMS reply",
      }],
    },
  }, "strict");
  assertEquals(r.ok, true);
});

Deno.test("evidence_ref: exception accepted only with system writer_role", () => {
  const ok = validateProposalEvidenceRefs({
    action_payload: { exception_reason: "synthetic_probe" },
    provenance: { writer_role: "system" },
  }, "strict");
  assertEquals(ok.ok, true);
  const bad = validateProposalEvidenceRefs({
    action_payload: { exception_reason: "synthetic_probe" },
    provenance: { writer_role: "classifier" },
  }, "strict");
  assertEquals(bad.ok, false);
});

Deno.test("evidence_ref: unknown exception_reason rejected", () => {
  const r = validateProposalEvidenceRefs({
    action_payload: { exception_reason: "i-just-felt-like-it" },
    provenance: { writer_role: "system" },
  }, "strict");
  assertEquals(r.ok, false);
});

// ---------- recordEvidence.ts tests ----------

Deno.test("recordEvidence: requires source_table / source_id", async () => {
  const { client } = makeFakeSupabase();
  await assertRejects(
    () => recordEvidence(client, {
      event_type: "client.email_in",
      source: "monitor-inbox",
      channel: "email",
      direction: "inbound",
      job_id: null,
      // @ts-expect-error testing
      source_table: undefined,
      source_id: "x",
    }, { org_id: "org-1", dry_run: true }),
    Error,
    "source_table required",
  );
});

Deno.test("recordEvidence: undefined job_id is a programmer error", async () => {
  const { client } = makeFakeSupabase();
  await assertRejects(
    () => recordEvidence(client, {
      event_type: "client.email_in",
      source: "monitor-inbox",
      channel: "email",
      direction: "inbound",
      // @ts-expect-error testing
      job_id: undefined,
      source_table: "inbox_events",
      source_id: "x",
    }, { org_id: "org-1", dry_run: true }),
    Error,
    "job_id must be string or null",
  );
});

Deno.test("recordEvidence: dry_run produces full envelope without inserts", async () => {
  const { client, calls } = makeFakeSupabase();
  const cap: EvidenceCapture = {
    event_type: "client.email_in",
    source: "monitor-inbox",
    channel: "email",
    direction: "inbound",
    source_table: "inbox_events",
    source_id: "evt-9",
    job_id: "SWP-26090",
    match_method: "direct_job_id",
    body_preview: "Client wants update",
  };
  const r = await recordEvidence(client, cap, { org_id: "org-1", dry_run: true });
  assertEquals(calls.length, 0, "dry_run must not insert");
  assertEquals(r.spine_row.match_status, "matched");
  assertEquals(r.spine_row.match_confidence, 0.99);
  assertEquals(r.evidence_ref.source_table, "inbox_events");
  assertEquals(r.evidence_ref.summary, "Client wants update");
});

Deno.test("recordEvidence: body_preview > cap is truncated and warned", async () => {
  const { client } = makeFakeSupabase();
  const longBody = "a".repeat(BODY_PREVIEW_MAX + 200);
  const r = await recordEvidence(client, {
    event_type: "client.email_in",
    source: "monitor-inbox",
    channel: "email",
    direction: "inbound",
    source_table: "inbox_events",
    source_id: "evt-9",
    job_id: null,
    body_preview: longBody,
  }, { org_id: "org-1", dry_run: true });
  assertEquals(r.spine_row.match_status, "unresolved");
  assert(r.warnings.some((w) => w.includes("body_preview truncated")));
});

Deno.test("recordEvidence: live insert path writes to business_events", async () => {
  const { client, calls } = makeFakeSupabase({ spineId: "spine-7" });
  const r = await recordEvidence(client, {
    event_type: "note.added",
    source: "ops-api/add_note",
    channel: "note",
    direction: "internal",
    source_table: "job_events",
    source_id: "je-1",
    job_id: "SWP-26090",
    match_method: "direct_job_id",
    body_preview: "Site visit booked",
  }, { org_id: "org-1" });
  assertEquals(r.spine_event_id, "spine-7");
  assertEquals(calls[0].table, "business_events");
  // Notes are extractor-eligible -> queue insert too.
  assertEquals(calls[1].table, "extraction_jobs");
});

Deno.test("recordEvidence: extraction NOT enqueued when match_status != matched", async () => {
  const { client, calls } = makeFakeSupabase();
  const r = await recordEvidence(client, {
    event_type: "client.email_in",
    source: "monitor-inbox",
    channel: "email",
    direction: "inbound",
    source_table: "inbox_events",
    source_id: "evt-9",
    job_id: null,        // no match
    body_preview: "ambiguous client mail",
  }, { org_id: "org-1" });
  assertEquals(r.spine_event_id, "spine-uuid-1");
  assertEquals(calls.length, 1, "no extraction enqueue for unmatched");
  assertEquals(r.extraction_job_id, undefined);
});

Deno.test("recordEvidence: enqueueExtraction=false skips queue even when matched + eligible", async () => {
  const { client, calls } = makeFakeSupabase();
  const r = await recordEvidence(client, {
    event_type: "client.email_in",
    source: "monitor-inbox",
    channel: "email",
    direction: "inbound",
    source_table: "inbox_events",
    source_id: "evt-9",
    job_id: "SWP-26090",
    match_method: "direct_job_id",
    enqueueExtraction: false,
  }, { org_id: "org-1" });
  assertEquals(r.spine_event_id, "spine-uuid-1");
  assertEquals(calls.length, 1);
  assertEquals(r.extraction_job_id, undefined);
});

Deno.test("recordEvidence: channel default privacy classifications", async () => {
  const { client } = makeFakeSupabase();
  const callRow = await recordEvidence(client, {
    event_type: "client.call_complete",
    source: "ghl-webhook-receiver",
    channel: "call",
    direction: "inbound",
    source_table: "business_events",
    source_id: "spine-call-1",
    job_id: "SWP-26090",
    match_method: "direct_job_id",
  }, { org_id: "org-1", dry_run: true });
  assertEquals(callRow.spine_row.match_status, "matched");

  const auditRow = await recordEvidence(client, {
    event_type: "agent.tool_called",
    source: "mcp",
    channel: "audit",
    direction: "system",
    source_table: "agent_audit_log",
    source_id: "audit-1",
    job_id: "SWP-26090",
    match_method: "direct_job_id",
    no_match_attempted: false as never,
  } as unknown as EvidenceCapture, { org_id: "org-1", dry_run: true });
  assertEquals(auditRow.spine_row.match_status, "matched");
});

Deno.test("recordEvidence: enqueue allowlist excludes audit channel by default", async () => {
  const { client, calls } = makeFakeSupabase();
  const r = await recordEvidence(client, {
    event_type: "agent.tool_called",
    source: "mcp",
    channel: "audit",
    direction: "system",
    source_table: "agent_audit_log",
    source_id: "audit-1",
    job_id: "SWP-26090",
    match_method: "direct_job_id",
  }, { org_id: "org-1" });
  assertEquals(r.spine_event_id, "spine-uuid-1");
  assertEquals(calls.length, 1, "audit channel must not enqueue extraction");
});

Deno.test("recordEvidence: spine insert failure throws and emits failure event", async () => {
  const { client, calls } = makeFakeSupabase({ failOn: "business_events" });
  await assertRejects(
    () => recordEvidence(client, {
      event_type: "client.email_in",
      source: "monitor-inbox",
      channel: "email",
      direction: "inbound",
      source_table: "inbox_events",
      source_id: "evt-9",
      job_id: "SWP-26090",
      match_method: "direct_job_id",
    }, { org_id: "org-1" }),
    Error,
    "spine insert failed",
  );
  // Two calls attempted: original + the failure log (which also fails in this fixture).
  assertEquals(calls.length, 2);
  assertEquals(calls[1].values.event_type, "system.evidence_capture_failed");
});

Deno.test("recordEvidence: SAFE_SUMMARY_MAX honored", async () => {
  const { client } = makeFakeSupabase();
  const big = "X".repeat(SAFE_SUMMARY_MAX + 100);
  const r = await recordEvidence(client, {
    event_type: "client.email_in",
    source: "monitor-inbox",
    channel: "email",
    direction: "inbound",
    source_table: "inbox_events",
    source_id: "evt-9",
    job_id: "SWP-26090",
    match_method: "direct_job_id",
    safe_summary: big,
  }, { org_id: "org-1", dry_run: true });
  // We can only check via the ref summary length.
  assert(r.evidence_ref.summary.length <= SAFE_SUMMARY_MAX);
});

Deno.test("recordEvidence: SWP-26090 fixture (T5 verification job)", async () => {
  // Simulates a recent inbox event for the canonical T5 verification job.
  const { client, calls } = makeFakeSupabase({ spineId: "spine-swp-26090-1" });
  const r = await recordEvidence(client, {
    event_type: "client.email_in",
    source: "monitor-inbox",
    channel: "email",
    direction: "inbound",
    source_table: "inbox_events",
    source_id: "graph-msg-id-abc",
    job_id: "SWP-26090",
    contact_id: "ghl-contact-7",
    match_method: "direct_reference",
    match_confidence: 0.9,
    body_preview: "Re: SWP-26090 — please call me back this afternoon.",
    thread_key: "<thread-id-xyz@graph>",
  }, { org_id: "org-marninstobbe-default" });
  assertEquals(r.spine_row.match_status, "matched");
  assertEquals(r.spine_row.match_method, "direct_reference");
  assertEquals(r.spine_row.match_confidence, 0.9);
  assertEquals(r.evidence_ref.job_id, "SWP-26090");
  assertEquals(r.evidence_ref.thread_key, "<thread-id-xyz@graph>");
  // matched + email channel + job_id present -> extraction enqueued.
  assertEquals(calls.length, 2);
  assertEquals(calls[1].table, "extraction_jobs");
  const eqRow = calls[1].values as { metadata: { spine_event_id: string } };
  assertEquals(eqRow.metadata.spine_event_id, "spine-swp-26090-1");
});

Deno.test("recordEvidence: flag OFF short-circuits to dry-run", async () => {
  const { client, calls } = makeFakeSupabase({ flagOn: false });
  const r = await recordEvidence(client, {
    event_type: "client.email_in",
    source: "monitor-inbox",
    channel: "email",
    direction: "inbound",
    source_table: "inbox_events",
    source_id: "evt-9",
    job_id: "SWP-26090",
    match_method: "direct_job_id",
    body_preview: "Client wants update",
  }, { org_id: "org-1" });
  // Only the feature_flag SELECT chain ran; no spine insert, no queue insert.
  assertEquals(calls.length, 0, "flag OFF must not insert");
  assert(r.warnings.some((w) => w.includes("evidence_capture_v1 OFF")));
  // Result still includes a fully-shaped EvidenceRef (so callers can still
  // cite — even in dry-run — when wiring proposal writers).
  assertEquals(r.evidence_ref.source_table, "inbox_events");
});

Deno.test("recordEvidence: bypass_feature_flag forces live insert even with flag OFF", async () => {
  const { client, calls } = makeFakeSupabase({ flagOn: false });
  await recordEvidence(client, {
    event_type: "agent.tool_called",
    source: "mcp",
    channel: "audit",
    direction: "system",
    source_table: "agent_audit_log",
    source_id: "audit-1",
    job_id: "SWP-26090",
    match_method: "direct_job_id",
  }, { org_id: "org-1", bypass_feature_flag: true });
  assertEquals(calls.length, 1, "bypass must insert");
  assertEquals(calls[0].table, "business_events");
});

// ---------- insert_proposal.ts tests ----------

interface FakeProposalSupabase {
  // deno-lint-ignore no-explicit-any
  client: any;
  inserts: Array<{ table: string; values: Record<string, unknown> }>;
}

function makeProposalFake(refsMode: "off" | "soft-warn" | "strict"): FakeProposalSupabase {
  _resetFlagCache();
  const inserts: Array<{ table: string; values: Record<string, unknown> }> = [];
  // refsMode test fixture mapping post-shadow_mode-removal:
  //   'strict'    => evidence_refs_strict_mode = true
  //   'soft-warn' => evidence_refs_soft_warn   = true (strict false)
  //   'off'       => both false / absent
  // The mock keys feature_flags rows by the flag_name passed to the .eq()
  // chain so getRefsValidatorMode's two isFlagOn calls resolve correctly.
  let lastFlagName = "";
  // deno-lint-ignore no-explicit-any
  const client: any = {
    from(table: string) {
      const chain = {
        select(_cols: string) {
          return {
            // deno-lint-ignore no-explicit-any
            eq(col: string, val: unknown): any {
              if (table === "feature_flags" && col === "flag_name") {
                lastFlagName = String(val);
              }
              return chain.select(_cols);
            },
            // deno-lint-ignore no-explicit-any
            limit(_n: number): any {
              if (table === "feature_flags") {
                let enabled = false;
                if (lastFlagName === "evidence_refs_strict_mode" && refsMode === "strict") enabled = true;
                if (lastFlagName === "evidence_refs_soft_warn" && refsMode === "soft-warn") enabled = true;
                return Promise.resolve({ data: [{ enabled }], error: null });
              }
              return Promise.resolve({ data: [], error: null });
            },
            single() {
              if (table === "ai_proposed_actions") {
                return Promise.resolve({ data: { id: "proposal-1" }, error: null });
              }
              return Promise.resolve({ data: null, error: null });
            },
          };
        },
        insert(values: unknown) {
          inserts.push({ table, values: values as Record<string, unknown> });
          if (table === "business_events") {
            return Promise.resolve({
              data: [{ id: "spine-1", occurred_at: "2026-05-02T00:00:00Z" }],
              error: null,
            });
          }
          if (table === "ai_proposed_actions") {
            return {
              select() {
                return {
                  single() {
                    return Promise.resolve({ data: { id: "proposal-1" }, error: null });
                  },
                };
              },
            };
          }
          return Promise.resolve({ data: null, error: null });
        },
      };
      return chain;
    },
  };
  return { client, inserts };
}

Deno.test("insert_proposal: off mode inserts without check", async () => {
  const { client, inserts } = makeProposalFake("off");
  const r = await insertProposalWithEvidenceCheck(client, {
    action_type: "send_follow_up",
    action_payload: { exception_reason: undefined },
    job_id: "SWP-1",
  });
  assertEquals(r.ok, true);
  assertEquals(r.mode, "off");
  // Only the ai_proposed_actions insert; no spine row.
  assertEquals(inserts.length, 1);
  assertEquals(inserts[0].table, "ai_proposed_actions");
});

Deno.test("insert_proposal: soft-warn logs proposal.missing_evidence_refs and inserts", async () => {
  const { client, inserts } = makeProposalFake("soft-warn");
  const r = await insertProposalWithEvidenceCheck(client, {
    action_type: "send_follow_up",
    action_payload: {},
    job_id: "SWP-1",
  });
  assertEquals(r.ok, true);
  assertEquals(r.mode, "soft-warn");
  // Two inserts: spine warn + ai_proposed_actions.
  assert(inserts.some((i) => i.table === "business_events"));
  assert(inserts.some((i) => i.table === "ai_proposed_actions"));
  const spineRow = inserts.find((i) => i.table === "business_events");
  assertEquals(spineRow?.values.event_type, "proposal.missing_evidence_refs");
});

Deno.test("insert_proposal: strict rejects when missing refs", async () => {
  const { client, inserts } = makeProposalFake("strict");
  const r = await insertProposalWithEvidenceCheck(client, {
    action_type: "send_follow_up",
    action_payload: {},
    job_id: "SWP-1",
  });
  assertEquals(r.ok, false);
  assertEquals(r.mode, "strict");
  assert(r.reason && r.reason.includes("evidence_refs"));
  // No ai_proposed_actions insert when strict rejects.
  assertEquals(inserts.filter((i) => i.table === "ai_proposed_actions").length, 0);
});

Deno.test("insert_proposal: strict accepts when refs supplied", async () => {
  const { client, inserts } = makeProposalFake("strict");
  const r = await insertProposalWithEvidenceCheck(client, {
    action_type: "send_follow_up",
    action_payload: {
      evidence_refs: [{
        evidence_id: "spine-x",
        source_table: "business_events",
        source_id: "spine-x",
        summary: "Client SMS asked us to call back",
      }],
    },
    job_id: "SWP-1",
  });
  assertEquals(r.ok, true);
  assertEquals(r.mode, "strict");
  assert(inserts.some((i) => i.table === "ai_proposed_actions"));
});

Deno.test("insert_proposal: strict accepts system exception with allowed reason", async () => {
  const { client, inserts } = makeProposalFake("strict");
  const r = await insertProposalWithEvidenceCheck(client, {
    action_type: "synthetic_probe",
    action_payload: { exception_reason: "synthetic_probe" },
    provenance: { writer_role: "system" },
    job_id: null,
  });
  assertEquals(r.ok, true);
  assertEquals(r.mode, "strict");
  assert(inserts.some((i) => i.table === "ai_proposed_actions"));
});

Deno.test("EXTRACTOR_ELIGIBLE_CHANNELS is the conservative T5 Iter-5 allowlist", () => {
  // Sanity: the allowlist must match T5 Iter-5's pre-flip recommendation
  // (start with client.email_in + note.added). 'sms' is intentionally NOT
  // here in Loop 1.
  assertEquals(EXTRACTOR_ELIGIBLE_CHANNELS.includes("email"), true);
  assertEquals(EXTRACTOR_ELIGIBLE_CHANNELS.includes("note"), true);
  assertEquals(EXTRACTOR_ELIGIBLE_CHANNELS.includes("sms"), false);
  assertEquals(EXTRACTOR_ELIGIBLE_CHANNELS.includes("audit"), false);
});

// ───────────────────────────────────────────────────────────────────────
// Regression: canonical-event-drop bug (2026-05-02 stop-time review)
// ───────────────────────────────────────────────────────────────────────
//
// The bug: recordEvidence used .insert(spineRow) without .select() — real
// Supabase returns data:null on a bare insert, so the helper falsely
// threw "spine insert returned no row" after the row had successfully
// landed in Postgres. Caller try/catch then silently dropped the event
// with no fallback to legacy insert.
//
// These tests are the regression bar. The realistic mock returns data:null
// on bare insert and only returns rows when .select() is chained — so if
// anyone ever removes the .select() from record_evidence.ts, these tests
// fail immediately.

Deno.test("regression: recordEvidence chains .select() and returns spine_event_id from inserted row", async () => {
  // The mock returns spineId='spine-uuid-regression' only when .select()
  // is chained on the insert. If recordEvidence forgets .select(), the
  // helper will throw "spine insert returned no row" because the bare
  // insert returns data:null.
  const { client } = makeFakeSupabase({ spineId: "spine-uuid-regression" });
  const result = await recordEvidence(client, {
    event_type: "client.email_in",
    source: "monitor-inbox",
    channel: "email",
    direction: "inbound",
    occurred_at: "2026-05-02T00:00:00Z",
    source_table: "inbox_events",
    source_id: "inbox-evt-1",
    job_id: "job-1",
    match_method: "direct_job_id",
    body_preview: "regression test body",
    payload: {},
  }, {
    org_id: "00000000-0000-0000-0000-000000000001",
    storage_client: undefined,
  });
  // The id only flows through if .insert(...).select("id, occurred_at")
  // is chained correctly. data:null from a bare insert would have raised
  // the false "no row" throw before we got here.
  assertEquals(result.spine_event_id, "spine-uuid-regression");
});

Deno.test("regression: mock honors real Supabase semantics (bare insert returns data:null)", async () => {
  // Documents the test contract: the mock MUST mirror prod (bare insert
  // returns data:null, .select() returns rows). This test guards the mock
  // itself — if someone weakens it back to "insert always returns rows"
  // the .select() chain bug becomes invisible to the suite again.
  const { client } = makeFakeSupabase({ spineId: "guard-row" });
  // Bare insert: data must be null (matches prod).
  const bare = await client.from("business_events").insert({ event_type: "x" });
  assertEquals(bare.data, null);
  // With .select() chained: data must be the row array.
  const withSelect = await client.from("business_events")
    .insert({ event_type: "x" })
    .select("id, occurred_at");
  assert(Array.isArray(withSelect.data));
  assertEquals((withSelect.data as Array<{ id: string }>)[0].id, "guard-row");
});
