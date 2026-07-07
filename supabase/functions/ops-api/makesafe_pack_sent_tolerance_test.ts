// Item 8 — pack-sent marker tolerance + writer/detector consolidation.
//
// Anchor case — SWMS-26832 (MLB-26393, 2026-06-30): a GENUINE bundled send was
// recorded as a freeform note that did NOT carry the canonical
// "MAKESAFE_PACK_SENT | main" prefix, so the covered card showed a permanent
// false OUTSTANDING-TO-SEND. These tests prove:
//   * the canonical detector now tolerates separator/spacing/case drift, but
//     still refuses "| photo" and freeform notes (the money/comms gates stay
//     strict);
//   * the BOARD-TRIAGE predicate additionally recognises the documented legacy
//     bundled-coverage note (bundle phrase + INV token), so buildPackSentMap
//     stops re-surfacing a bundled-covered job as unsent;
//   * there is ONE canonical writer, and index.ts keeps no private detector copy.
//
// Run: deno test --no-check --allow-env --allow-net=127.0.0.1 \
//   supabase/functions/ops-api/makesafe_pack_sent_tolerance_test.ts
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildPackSentMarkerText,
  isBundledCoverageSendNote,
  isPackSentMainEvent,
  isPackSentTriageEvent,
  packSentMainTextMatches,
} from "./makesafe_send_pack.ts";
import { _buildPackSentMapForTest } from "./index.ts";

// The exact SWMS-26832 2026-06-30 note (the freeform legacy record of the send).
const SWMS_26832_LEGACY_NOTE =
  "BUNDLED into SWMS-26837 temp-fence make-safe (one WO) - no separate invoice; " +
  "labour+report+SWMS covered under INV-0835. Sent to bunbury@ in the MLB-26393 " +
  "claim email 2026-06-30T08:32:20Z.";

const noteEvent = (text: string) => ({ event_type: "note", detail_json: { text } });

// ── Canonical detector: tolerant to spacing / separator / case drift ──────────
Deno.test("packSentMainTextMatches: canonical marker matches", () => {
  assert(packSentMainTextMatches(
    "MAKESAFE_PACK_SENT | main | INV-0814 | to=b@x.com | 2026-06-30T08:32:01Z | msgid=abc",
  ));
});

Deno.test("packSentMainTextMatches: tolerates no-space, extra-space and case drift", () => {
  assert(packSentMainTextMatches("MAKESAFE_PACK_SENT|main | INV-1 | to=x"));
  assert(packSentMainTextMatches("MAKESAFE_PACK_SENT  |  Main | INV-1"));
  assert(packSentMainTextMatches("  makesafe_pack_sent | MAIN | INV-1  "));
});

Deno.test("packSentMainTextMatches: refuses photo, agent-reply, freeform, empty", () => {
  assertEquals(packSentMainTextMatches("MAKESAFE_PACK_SENT | photo | INV-1"), false);
  assertEquals(packSentMainTextMatches("MAKESAFE_AGENT_REPLY | fixed the total"), false);
  assertEquals(packSentMainTextMatches(SWMS_26832_LEGACY_NOTE), false);
  assertEquals(packSentMainTextMatches(""), false);
  assertEquals(packSentMainTextMatches(null), false);
});

// buildPackSentMarkerText (the single canonical writer) always emits a body the
// tolerant detector accepts — writer and detector agree by construction.
Deno.test("buildPackSentMarkerText output is detected by isPackSentMainEvent", () => {
  const text = buildPackSentMarkerText({
    invoiceNumber: "INV-0814",
    to: "bunbury@mlbuilders.com.au",
    nowIso: "2026-06-30T08:32:01Z",
    messageId: "abc",
  });
  assert(text.startsWith("MAKESAFE_PACK_SENT | main"));
  assert(isPackSentMainEvent(noteEvent(text)));
});

// ── Documented legacy bundled-coverage note (SWMS-26832) ──────────────────────
Deno.test("isBundledCoverageSendNote: matches the real SWMS-26832 legacy note", () => {
  assert(isBundledCoverageSendNote(SWMS_26832_LEGACY_NOTE));
});

Deno.test("isBundledCoverageSendNote: needs BOTH a bundle phrase AND an INV token", () => {
  // Bundle phrase but no invoice = an in-planning note, never counts.
  assertEquals(
    isBundledCoverageSendNote("BUNDLED into SWMS-26837 (will invoice together later)"),
    false,
  );
  // INV token but no bundle phrase = an ordinary invoice note, never counts.
  assertEquals(isBundledCoverageSendNote("Raised INV-0835 for this job"), false);
  // Both present = a genuine bundled-coverage record.
  assert(isBundledCoverageSendNote("covered under INV-0835 on the sibling bundle"));
});

// ── The split: triage tolerates the legacy note; the strict gate never does ───
Deno.test("SWMS-26832 legacy note: triage=true, strict main detector=false", () => {
  const ev = noteEvent(SWMS_26832_LEGACY_NOTE);
  assertEquals(isPackSentMainEvent(ev), false, "irreversible-action gates stay strict");
  assertEquals(isPackSentTriageEvent(ev), true, "board triage tolerates the legacy note");
});

Deno.test("canonical marker is both triage and strict-main true", () => {
  const ev = noteEvent("MAKESAFE_PACK_SENT | main | INV-0814 | to=x | ts | msgid=y");
  assert(isPackSentMainEvent(ev));
  assert(isPackSentTriageEvent(ev));
});

// ── buildPackSentMap integration: a bundled-covered job is now pack_sent=true ──
function packSentClient(eventsByJob: Record<string, string[]>) {
  const rows: any[] = [];
  let id = 1;
  for (const [jobId, texts] of Object.entries(eventsByJob)) {
    for (const text of texts) {
      rows.push({ id: id++, job_id: jobId, event_type: "note", detail_json: { text } });
    }
  }
  function builder() {
    const preds: Array<(r: any) => boolean> = [];
    const b: any = {
      select: () => b,
      eq: (col: string, val: any) => { preds.push((r) => r?.[col] === val); return b; },
      in: (col: string, vals: any[]) => { preds.push((r) => vals.includes(r?.[col])); return b; },
      order: () => b,
      range: async (from: number, to: number) => {
        const data = rows.filter((r) => preds.every((p) => p(r))).slice(from, to + 1);
        return { data, error: null };
      },
    };
    return b;
  }
  return { from: () => builder() };
}

Deno.test("buildPackSentMap: canonical marker AND legacy bundled note both count as sent", async () => {
  const client = packSentClient({
    "job-canonical": ["MAKESAFE_PACK_SENT | main | INV-1 | to=x | ts | msgid=y"],
    "job-bundled": [SWMS_26832_LEGACY_NOTE],
    "job-unsent": ["crew attended, awaiting report"],
    "job-photo-only": ["MAKESAFE_PACK_SENT | photo | INV-1 | to=x"],
  });
  const map = await _buildPackSentMapForTest(client, [
    "job-canonical",
    "job-bundled",
    "job-unsent",
    "job-photo-only",
  ]);
  assertEquals(map["job-canonical"], true);
  assertEquals(map["job-bundled"], true); // SWMS-26832 class: no longer false OUTSTANDING-TO-SEND
  assertEquals(map["job-unsent"], undefined);
  assertEquals(map["job-photo-only"], undefined); // photo alone is never a verified send
});
