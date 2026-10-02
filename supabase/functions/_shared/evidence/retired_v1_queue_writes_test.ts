// The v1 context-fact extractor that drained extraction_jobs was retired on
// 21 Sep 2026 and nothing drains that queue any more. Evidence capture
// (recordEvidence) and the call-transcription path must therefore never
// write to it: a queued row there is dead work that reads as work waiting.
//
// Pins:
//   1. recordEvidence and transcribe-call reference no extraction_jobs write.
//   2. Every remaining extraction_jobs reference under supabase/functions is
//      on a named manifest, so a new one is a reviewable act. The one left is
//      the manual ops-api backfill_ghl_conversations action, a separate
//      follow-up outside this change.
//   3. The table and its rows stay: this change only stops new writes.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { fromFileUrl, join, relative } from "https://deno.land/std@0.224.0/path/mod.ts";
import { walk } from "https://deno.land/std@0.224.0/fs/walk.ts";

const FUNCTIONS = fromFileUrl(new URL("../../", import.meta.url));
const QUEUE = /from\(\s*['"]extraction_jobs['"]\s*\)/g;

async function queueRefs(path: string): Promise<number> {
  const text = await Deno.readTextFile(path);
  return [...text.matchAll(QUEUE)].length;
}

Deno.test("recordEvidence and transcribe-call never touch the retired v1 queue", async () => {
  for (const file of [
    "_shared/evidence/record_evidence.ts",
    "_shared/evidence/types.ts",
    "_shared/evidence/audit.ts",
    "transcribe-call/index.ts",
  ]) {
    assertEquals(await queueRefs(join(FUNCTIONS, file)), 0, file);
  }
});

Deno.test("every remaining extraction_jobs reference is on the manifest", async () => {
  const found: Record<string, number> = {};
  for await (const entry of walk(FUNCTIONS, { exts: [".ts"], includeDirs: false })) {
    if (entry.path.endsWith("_test.ts")) continue;
    const n = await queueRefs(entry.path);
    if (n > 0) found[relative(FUNCTIONS, entry.path)] = n;
  }
  assertEquals(found, {
    // backfill_ghl_conversations: manual, admin-run historical backfill.
    "ops-api/index.ts": 1,
  });
});
