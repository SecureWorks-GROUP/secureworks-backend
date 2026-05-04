// Tests for body_handler authorization model.
//
// Covers the auth gaps the 2026-05-03 stop-time review flagged:
//   - missing user_id rejected (unauthenticated)
//   - role denial redacts body_pointer + body_hash from the response
//   - non-admin scoped to assigned_job_ids
//   - unmatched (job_id IS NULL) rows admin-only
//   - 'internal' privacy class no longer falls through to "any role"
//   - unknown / null privacy class defaults to staff_only allowlist
//
// Run from secureworks-site-t7-restore/:
//   deno test --allow-net --allow-env --allow-read \
//     supabase/functions/_shared/evidence/body_handler_test.ts

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { getEvidenceBody, GetEvidenceBodyResponse } from "./body_handler.ts";

interface FakeRow {
  id: string;
  job_id: string | null;
  channel: string | null;
  direction: string | null;
  occurred_at: string | null;
  body_pointer: string | null;
  body_hash: string | null;
  privacy_classification: string | null;
}

function makeFakeClient(row: FakeRow | null) {
  // deno-lint-ignore no-explicit-any
  const client: any = {
    from(_table: string) {
      return {
        select(_cols: string) {
          return {
            eq(_col: string, _val: string) {
              return {
                limit(_n: number) {
                  return Promise.resolve({
                    data: row ? [row] : [],
                    error: null,
                  });
                },
              };
            },
          };
        },
        // recordEvidence calls insert(...).select() inside integrity-fail
        // path; not exercised by these tests but stubbed defensively.
        insert(_v: unknown) {
          const t: PromiseLike<{ data: null; error: null }> = {
            then(onfulfilled, onrejected) {
              return Promise.resolve({ data: null, error: null }).then(onfulfilled, onrejected);
            },
          };
          // deno-lint-ignore no-explicit-any
          (t as any).select = () => Promise.resolve({ data: [{ id: "x" }], error: null });
          return t;
        },
      };
    },
  };
  return client;
}

const stubStorage = {
  from(_b: string) {
    return {
      createSignedUrl(_p: string, _ttl: number) {
        return Promise.resolve({ data: { signedUrl: "https://stub/signed" }, error: null });
      },
    };
  },
};

const SAMPLE_ROW: FakeRow = {
  id: "spine-1",
  job_id: "job-A",
  channel: "email",
  direction: "inbound",
  occurred_at: "2026-05-03T00:00:00Z",
  body_pointer: "evidence-bodies://org/email/inbox-evt-1.txt",
  body_hash: null, // skip integrity check
  privacy_classification: "staff_only",
};

Deno.test("body_handler: missing caller.user_id returns unauthenticated denial with zero leakage", async () => {
  const client = makeFakeClient(SAMPLE_ROW);
  const r = await getEvidenceBody(client, stubStorage, { spine_event_id: "spine-1" }, {
    role: "admin",
    is_admin: true,
    // user_id intentionally omitted
  });
  assertEquals(r.body_present, false);
  assertEquals(r.body_pointer, null);
  assertEquals(r.body_hash, null);
  assertEquals(r.signed_url, null);
  assertEquals(r.job_id, null);                    // pre-spine-read: nothing leaks
  assertEquals(r.privacy_classification, null);
  assert(r.reason?.includes("unauthenticated"));
});

Deno.test("body_handler: empty caller.user_id treated as missing", async () => {
  const client = makeFakeClient(SAMPLE_ROW);
  const r = await getEvidenceBody(client, stubStorage, { spine_event_id: "spine-1" }, {
    user_id: "   ",  // whitespace only
    role: "admin",
    is_admin: true,
  });
  assertEquals(r.signed_url, null);
  assert(r.reason?.includes("unauthenticated"));
});

Deno.test("body_handler: role denial redacts body_pointer + body_hash", async () => {
  const row: FakeRow = { ...SAMPLE_ROW, privacy_classification: "restricted_pii" };
  const client = makeFakeClient(row);
  const r = await getEvidenceBody(client, stubStorage, { spine_event_id: "spine-1" }, {
    user_id: "user-1",
    role: "sales",          // not allowed for restricted_pii
    is_admin: false,
    assigned_job_ids: ["job-A"],
  });
  assertEquals(r.body_present, true);              // existence not hidden
  assertEquals(r.body_pointer, null);              // redacted
  assertEquals(r.body_hash, null);                 // redacted
  assertEquals(r.signed_url, null);
  assert(r.reason?.includes("not permitted"));
});

Deno.test("body_handler: 'internal' privacy class no longer falls through to any role", async () => {
  const row: FakeRow = { ...SAMPLE_ROW, privacy_classification: "internal" };
  const client = makeFakeClient(row);
  // 'crew' is not in the internal allowlist anymore (was permitted by the
  // old "any non-empty role" fallthrough).
  const r = await getEvidenceBody(client, stubStorage, { spine_event_id: "spine-1" }, {
    user_id: "user-1",
    role: "crew",
    is_admin: false,
    assigned_job_ids: ["job-A"],
  });
  assertEquals(r.signed_url, null);
  assert(r.reason?.includes("not permitted"), `got reason: ${r.reason}`);
});

Deno.test("body_handler: null/unknown privacy class defaults to staff_only allowlist", async () => {
  const row: FakeRow = { ...SAMPLE_ROW, privacy_classification: null };
  const client = makeFakeClient(row);
  // sales is in staff_only allowlist → permitted (so we expect no role-deny).
  const r1 = await getEvidenceBody(client, stubStorage, { spine_event_id: "spine-1" }, {
    user_id: "user-1",
    role: "sales",
    is_admin: false,
    assigned_job_ids: ["job-A"],
  });
  assert(r1.signed_url !== null, `expected signed_url, got reason: ${r1.reason}`);

  // crew is NOT in staff_only → denied (old fallthrough would have allowed).
  const r2 = await getEvidenceBody(client, stubStorage, { spine_event_id: "spine-1" }, {
    user_id: "user-1",
    role: "crew",
    is_admin: false,
    assigned_job_ids: ["job-A"],
  });
  assertEquals(r2.signed_url, null);
  assert(r2.reason?.includes("not permitted"));
});

Deno.test("body_handler: non-admin denied for jobs they're not assigned to", async () => {
  const row: FakeRow = { ...SAMPLE_ROW, job_id: "job-B" };
  const client = makeFakeClient(row);
  const r = await getEvidenceBody(client, stubStorage, { spine_event_id: "spine-1" }, {
    user_id: "user-1",
    role: "sales",
    is_admin: false,
    assigned_job_ids: ["job-A"],   // not assigned to job-B
  });
  assertEquals(r.body_pointer, null);
  assertEquals(r.signed_url, null);
  assert(r.reason?.includes("not assigned to job 'job-B'"));
});

Deno.test("body_handler: non-admin denied for unmatched (job_id IS NULL) rows", async () => {
  const row: FakeRow = { ...SAMPLE_ROW, job_id: null };
  const client = makeFakeClient(row);
  const r = await getEvidenceBody(client, stubStorage, { spine_event_id: "spine-1" }, {
    user_id: "user-1",
    role: "sales",
    is_admin: false,
    assigned_job_ids: [],
  });
  assertEquals(r.signed_url, null);
  assert(r.reason?.includes("unmatched evidence"));
});

Deno.test("body_handler: admin bypasses job-scope check", async () => {
  const row: FakeRow = { ...SAMPLE_ROW, job_id: "job-Z" };
  const client = makeFakeClient(row);
  const r: GetEvidenceBodyResponse = await getEvidenceBody(
    client,
    stubStorage,
    { spine_event_id: "spine-1" },
    {
      user_id: "admin-user",
      role: "admin",
      is_admin: true,
      assigned_job_ids: [],   // empty — admin should still pass
    },
  );
  assert(r.signed_url !== null, `expected admin to get signed_url, reason: ${r.reason}`);
  assertEquals(r.integrity_verified, true);
});

Deno.test("body_handler: assigned non-admin staff with right role gets signed_url", async () => {
  const client = makeFakeClient(SAMPLE_ROW);
  const r = await getEvidenceBody(client, stubStorage, { spine_event_id: "spine-1" }, {
    user_id: "user-1",
    role: "ops_manager",
    is_admin: false,
    assigned_job_ids: ["job-A"],
  });
  assert(r.signed_url !== null, `expected signed_url, reason: ${r.reason}`);
  assertEquals(r.body_pointer, SAMPLE_ROW.body_pointer);
});

Deno.test("body_handler: spine_event_id not found returns no-row response (no auth needed past user_id)", async () => {
  const client = makeFakeClient(null);
  const r = await getEvidenceBody(client, stubStorage, { spine_event_id: "ghost" }, {
    user_id: "user-1",
    role: "admin",
    is_admin: true,
  });
  assertEquals(r.body_present, false);
  assertEquals(r.signed_url, null);
  assert(r.reason?.includes("not found"));
});

Deno.test("body_handler: ttl clamped between 60 and 900", async () => {
  const client = makeFakeClient(SAMPLE_ROW);
  const r1 = await getEvidenceBody(client, stubStorage, { spine_event_id: "spine-1", ttl_seconds: 0 }, {
    user_id: "u", role: "admin", is_admin: true,
  });
  assertEquals(r1.ttl_seconds, 60);
  const r2 = await getEvidenceBody(client, stubStorage, { spine_event_id: "spine-1", ttl_seconds: 5000 }, {
    user_id: "u", role: "admin", is_admin: true,
  });
  assertEquals(r2.ttl_seconds, 900);
});
