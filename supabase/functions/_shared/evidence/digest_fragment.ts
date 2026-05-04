// T7 Loop 2 — Stale-channel digest fragment
//
// Roadmap: cio/operations/2026-05-02-t7-evidence-capture-spine-roadmap.md (Section 9)
//
// Produces a short Telegram-safe text fragment for daily-digest to append
// when one or more channels that historically have traffic stopped firing
// in the last 24 hours. Pure read; uses v_evidence_health_stale.
//
// Wire into daily-digest with:
//   import { buildEvidenceStaleFragment } from '../_shared/evidence/digest_fragment.ts'
//   const stale = await buildEvidenceStaleFragment(client)
//   if (stale) brief += `\n\n${stale}`
//
// Returns null when there are no stale channels — caller appends nothing.

// deno-lint-ignore no-explicit-any
export async function buildEvidenceStaleFragment(client: any): Promise<string | null> {
  try {
    const { data, error } = await client.from("v_evidence_health_stale").select("*");
    if (error) return null;
    const rows = (data ?? []) as Array<{
      channel: string;
      rows_24h: number;
      rows_7d: number;
      last_event_at: string | null;
    }>;
    if (rows.length === 0) return null;

    const lines = rows.slice(0, 8).map((r) => {
      const last = r.last_event_at
        ? r.last_event_at.replace("T", " ").slice(0, 16) + " UTC"
        : "unknown";
      return `· ${r.channel} — 0 in 24h, ${r.rows_7d} in 7d, last ${last}`;
    });
    const more = rows.length > 8 ? `\n· (+${rows.length - 8} more)` : "";

    return [
      "🟠 *Evidence health alert — stale channels*",
      `${rows.length} channel${rows.length === 1 ? "" : "s"} with traffic this week but nothing in the last 24h:`,
      ...lines,
    ].join("\n") + more;
  } catch {
    return null;
  }
}
