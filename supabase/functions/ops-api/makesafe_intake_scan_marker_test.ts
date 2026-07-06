// deno-lint-ignore-file no-explicit-any
// Tests for the extract-at-most-once marker helpers (makesafe_intake_scan_marker.ts) —
// the cost-leak fix. Covers the mark-eligibility rule and the batched/idempotent/
// pre-migration-safe DB write.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  markEmailsScanned,
  partitionForMark,
  scanMarkEligible,
} from "./makesafe_intake_scan_marker.ts";

const BASE = {
  templateParsed: false,
  modelValidResult: false,
  authFailed: false,
  transientFailed: false,
  keyDegradedOrAbsent: false,
};

Deno.test("scanMarkEligible: a valid model result marks the email (incl. a non-WO classification)", () => {
  // A non-work-order email that the model classifies not_a_work_order STILL returned a
  // valid result -> mark it, so it is never re-extracted (the leak that was fixed).
  assertEquals(scanMarkEligible({ ...BASE, modelValidResult: true }), true);
});

Deno.test("scanMarkEligible: a deterministic template parse marks the email", () => {
  assertEquals(scanMarkEligible({ ...BASE, templateParsed: true }), true);
});

Deno.test("scanMarkEligible: an AUTH failure does NOT mark (retries when key recovers)", () => {
  assertEquals(scanMarkEligible({ ...BASE, authFailed: true }), false);
  // even if a result somehow also flagged, auth failure wins (never mark a dead-key email)
  assertEquals(scanMarkEligible({ ...BASE, modelValidResult: true, authFailed: true }), false);
});

Deno.test("scanMarkEligible: a TRANSIENT failure does NOT mark (retries next cycle)", () => {
  assertEquals(scanMarkEligible({ ...BASE, transientFailed: true }), false);
});

Deno.test("scanMarkEligible: a dead/absent key (model not called) does NOT mark", () => {
  assertEquals(scanMarkEligible({ ...BASE, keyDegradedOrAbsent: true }), false);
});

Deno.test("scanMarkEligible: nothing happened -> not marked", () => {
  assertEquals(scanMarkEligible({ ...BASE }), false);
});

Deno.test("partitionForMark chunks correctly", () => {
  assertEquals(partitionForMark([1, 2, 3, 4, 5, 6, 7], 3), [[1, 2, 3], [4, 5, 6], [7]]);
  assertEquals(partitionForMark([], 3), []);
  assertEquals(partitionForMark([1, 2], 10), [[1, 2]]);
});

// ── markEmailsScanned: mock client capturing the update chain ──
function makeClient(opts: { failAll?: boolean } = {}) {
  const updates: Array<{ set: any; inList: string[]; isCol: string; isVal: any }> = [];
  const from = (_t: string) => ({
    update: (set: any) => {
      const rec: any = { set };
      const chain: any = {
        in: (_c: string, list: string[]) => {
          rec.inList = list;
          return chain;
        },
        is: (col: string, val: any) => {
          rec.isCol = col;
          rec.isVal = val;
          updates.push(rec);
          return Promise.resolve(opts.failAll ? { error: { message: "boom" } } : { error: null });
        },
      };
      return chain;
    },
  });
  return { from, updates };
}

Deno.test("markEmailsScanned: marks all ids in chunks, idempotently (WHERE scanned_at IS NULL)", async () => {
  const client = makeClient();
  const ids = Array.from({ length: 65 }, (_v, i) => `post_${i}`);
  const r = await markEmailsScanned(client as any, ids, { columnAvailable: true, chunkSize: 30, nowIso: "2026-07-04T00:00:00Z" });
  assertEquals(r.attempted, true);
  assertEquals(r.marked, 65);
  assertEquals(r.errorChunks, 0);
  assertEquals(client.updates.length, 3); // 30 + 30 + 5
  for (const u of client.updates) {
    assertEquals(u.set.makesafe_scanned_at, "2026-07-04T00:00:00Z");
    assertEquals(u.isCol, "makesafe_scanned_at");
    assertEquals(u.isVal, null); // idempotency guard: only unmarked rows
  }
});

Deno.test("markEmailsScanned: PRE-MIGRATION (column absent) does NOTHING", async () => {
  const client = makeClient();
  const r = await markEmailsScanned(client as any, ["post_1"], { columnAvailable: false });
  assertEquals(r.attempted, false);
  assertEquals(r.marked, 0);
  assertEquals(client.updates.length, 0);
});

Deno.test("markEmailsScanned: empty id list is a no-op", async () => {
  const client = makeClient();
  const r = await markEmailsScanned(client as any, [], { columnAvailable: true });
  assertEquals(r.attempted, false);
  assertEquals(client.updates.length, 0);
});

Deno.test("markEmailsScanned: a chunk error is tolerated (no throw, retries next run)", async () => {
  const client = makeClient({ failAll: true });
  const ids = Array.from({ length: 40 }, (_v, i) => `post_${i}`);
  const r = await markEmailsScanned(client as any, ids, { columnAvailable: true, chunkSize: 30 });
  assertEquals(r.attempted, true);
  assertEquals(r.marked, 0); // nothing counted as marked on error
  assert(r.errorChunks >= 1); // both chunks errored, but the scan never crashed
});
