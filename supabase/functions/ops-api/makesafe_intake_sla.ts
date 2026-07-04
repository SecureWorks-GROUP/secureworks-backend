// ════════════════════════════════════════════════════════════
// MAKE-SAFE INTAKE — SLA latency (email received -> card created) — B5
// Mission: fix/makesafe-board-hardening (zero-mistakes wave 2B)
// ════════════════════════════════════════════════════════════
//
// The email->board-card pipeline is a 2-minute cron. This computes the arrival->card
// latency so the cadence is PROVABLE: per-scan (folded into makesafe_intake_health as
// a last-scan snapshot) and 24h-rolling (computed on read in the intake_health action
// from the per-draft created_at/received_at columns). Pure + deterministic — no I/O,
// no dependencies — so it is trivially unit-testable.
//
// received_at on a draft = the email's received timestamp (set at parse time).
// created_at on a draft   = when scanSesMakesafes inserted the row.
// latency  = created_at - received_at, clamped to >= 0 (a negative delta means clock
//            skew / a mis-stamped received_at; it is dropped, never counted negative).

export interface SlaLatencyRow {
  received_at?: string | null;
  created_at?: string | null;
}

export interface SlaLatencySummary {
  samples: number;
  p50_sec: number;
  p95_sec: number;
  max_sec: number;
}

/** Nearest-rank percentile (0..1) over an ascending-sorted numeric array. */
function percentile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const rank = Math.ceil(q * sortedAsc.length);
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, rank - 1));
  return sortedAsc[idx];
}

/**
 * Compute p50/p95/max of the received->created latency (in whole seconds) over the
 * given draft rows. Rows missing either timestamp, or with an unparseable / negative
 * delta, are excluded (never counted). Returns all-zero when there are no valid rows.
 */
export function computeLatencySla(rows: SlaLatencyRow[] | null | undefined): SlaLatencySummary {
  const deltas: number[] = [];
  for (const r of rows || []) {
    const rec = r?.received_at ? Date.parse(r.received_at) : NaN;
    const cre = r?.created_at ? Date.parse(r.created_at) : NaN;
    if (Number.isNaN(rec) || Number.isNaN(cre)) continue;
    const sec = Math.round((cre - rec) / 1000);
    if (sec < 0) continue; // clock skew / mis-stamp — do not count a negative latency
    deltas.push(sec);
  }
  if (deltas.length === 0) {
    return { samples: 0, p50_sec: 0, p95_sec: 0, max_sec: 0 };
  }
  deltas.sort((a, b) => a - b);
  return {
    samples: deltas.length,
    p50_sec: percentile(deltas, 0.5),
    p95_sec: percentile(deltas, 0.95),
    max_sec: deltas[deltas.length - 1],
  };
}
