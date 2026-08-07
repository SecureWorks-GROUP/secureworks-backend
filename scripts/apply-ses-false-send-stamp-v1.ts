#!/usr/bin/env -S deno run --allow-env --allow-net --allow-read --allow-write
/**
 * Clear the five provably-false `makesafe_job_details.report_sent_at` stamps
 * left behind by the retired `ready_to_invoice` auto-stamp.
 *
 * WHY THESE FIVE
 * --------------
 * `report_sent_at` was never send truth. Until Rescue SES T2 removed it,
 * `updateMakesafeSubstatus` stamped it on the move to `ready_to_invoice` — an
 * operator CLAIM, not a send. Measured live 2026-08-06 across the 419-card
 * board: 33 cards carry a stamp, 15 carry a real route proof, and the two sets
 * do not intersect at all. Of the 33, twenty-eight are corroborated by the
 * legacy `MAKESAFE_PACK_SENT` marker (real pre-pack-table sends, stamps kept).
 * The five in the fixture below are the residue, and each one's stamp precedes
 * its own `ready_to_invoice` job_event by 50-350ms — the same transaction. They
 * are the auto-stamp's own output, with no send on any surface.
 *
 * This is the same defect the Captain named on Floreat SWMS-261021, which was
 * cured separately on 2026-08-06 at 10:02.
 *
 * Scope is a CLOSED, hand-checked fixture. There is deliberately no discovery
 * step, so this script can never widen its own blast radius.
 *
 * WHAT IT WRITES
 * --------------
 * `makesafe_job_details.report_sent_at` -> NULL, and nothing else. It never
 * writes a substatus, a stage, an assignment, an invoice or a communication,
 * and it never SETS a stamp. Writes go through the guarded ops-api
 * `correct_makesafe_false_send_stamp` action; no raw SQL write and no new
 * endpoint.
 *
 * (Originally it wrote `{ report_sent_at: null }` through
 * `update_makesafe_details`, because the field sat on that editor's ordinary
 * allow-list. That door was closed on 2026-08-07 — the field is now derived
 * from a recorded send and the editor refuses any request naming it — so the
 * old write would 400. See `clearStamp` below.)
 *
 * THE GUARD, AND THE JOIN THAT IS A TRAP
 * --------------------------------------
 * Before every write — at dry-run AND again at apply time, against live
 * production, never against the fixture — send truth is re-derived from the
 * four surfaces that actually record a send. Any hit refuses that card:
 *
 *   1. `ses_release_route_proofs`  — carries `job_id`; the trustworthy join.
 *   2. `ses_external_effects` (`effect_kind='route_send'`) joined through
 *      `makesafe_release_revision_members`. That table's OWN `job_id` is NULL
 *      on every route_send row, so a direct `job_id` join returns zero and
 *      reads as "nothing sent" — which is how a shipped card looks unshipped.
 *   3. `makesafe_report_packs.status` in a sent/closed status.
 *   4. The legacy `MAKESAFE_PACK_SENT` job_events marker.
 *
 * The stamp must also still equal the value recorded in the fixture, or the
 * card refuses rather than being silently overwritten.
 *
 * The durable mechanism is the guarded ops-api action
 * `correct_makesafe_false_send_stamp` (makesafe_false_send_stamp.ts), which
 * enforces all of the above server-side and is what this script now calls. The
 * client-side assessment is kept as a second opinion, so a card this script
 * would refuse is never even offered to the action.
 *
 * Modes:
 *   dry-run  read-only plan (default): card | stamp | each surface's count
 *   apply    re-derives live, refuses on any drift or evidence, writes, ledgers
 *   verify   re-reads and proves the ledger against production
 *
 * Environment: `SUPABASE_ACCESS_TOKEN` (read-only Management API) for every
 * mode; `SW_API_KEY` additionally for `apply`.
 */

const PROJECT_REF = "kevgrhcjxspbxgovpmfl";
const MANAGEMENT_QUERY_URL =
  `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;
const FUNCTIONS_BASE = `https://${PROJECT_REF}.supabase.co/functions/v1`;

export const RUN_LABEL = "ses-false-send-stamp-v1";
const LEDGER_PATH = `scripts/${RUN_LABEL}.ledger.json`;

const MODES = ["dry-run", "apply", "verify"] as const;
type Mode = (typeof MODES)[number];

// ---------------------------------------------------------------------------
// The closed fixture — measured 2026-08-06, Management API, read_only
// ---------------------------------------------------------------------------

interface FixtureRow {
  card: string;
  jobId: string;
  /** The stamp as measured. Apply refuses if production no longer matches. */
  observedStamp: string;
  /** The `ready_to_invoice` job_event this stamp was minted alongside. */
  autoStampEvidence: string;
}

export const FIXTURE: FixtureRow[] = [
  {
    card: "SWMS-26851",
    jobId: "c2b58041-bbfa-4135-9c2a-42b23d38cf89",
    observedStamp: "2026-06-30T00:12:51.200Z",
    autoStampEvidence: "ready_to_invoice event 2026-06-30T00:12:51.279Z (+79ms)",
  },
  {
    card: "SWMS-26852",
    jobId: "0ec5c7d3-bc1a-48ad-9a70-0bc916200ea3",
    observedStamp: "2026-06-30T00:12:52.782Z",
    autoStampEvidence: "ready_to_invoice event 2026-06-30T00:12:52.901Z (+119ms)",
  },
  {
    card: "SWMS-26853",
    jobId: "1caa4531-910c-45af-95c5-d5ce3b99d4e9",
    observedStamp: "2026-06-30T00:12:53.360Z",
    autoStampEvidence: "ready_to_invoice event 2026-06-30T00:12:53.414Z (+54ms)",
  },
  {
    card: "SWMS-26855",
    jobId: "39d082b7-2819-4595-bee2-c3e8509dfb0c",
    observedStamp: "2026-06-30T00:46:35.841Z",
    autoStampEvidence: "ready_to_invoice event 2026-06-30T00:46:36.195Z (+354ms)",
  },
  {
    card: "SWMS-26857",
    jobId: "232a2e8c-863c-4ffa-bc43-254bfbf6fe56",
    observedStamp: "2026-06-30T00:46:37.118Z",
    autoStampEvidence: "ready_to_invoice event 2026-06-30T00:46:37.216Z (+98ms)",
  },
];

// ---------------------------------------------------------------------------
// Read-only production access
// ---------------------------------------------------------------------------

async function query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  const token = Deno.env.get("SUPABASE_ACCESS_TOKEN");
  if (!token) throw new Error("SUPABASE_ACCESS_TOKEN required");
  if (!/^\s*(with|select)\b/i.test(sql)) {
    throw new Error("read-only script: only SELECT/WITH statements are permitted");
  }
  const res = await fetch(MANAGEMENT_QUERY_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql, read_only: true }),
  });
  if (!res.ok) throw new Error(`management query failed ${res.status}: ${await res.text()}`);
  return await res.json() as T[];
}

function idList(ids: string[]): string {
  return ids.map((id) => `'${id.replace(/'/g, "''")}'`).join(",");
}

interface LiveRow {
  jobId: string;
  card: string;
  stamp: string | null;
  substatus: string | null;
  routeProofs: number;
  effectSends: number;
  sentPacks: number;
  legacyMarkers: number;
}

/**
 * Re-derive the stamp and all four send surfaces for every fixture card,
 * straight from production. Note surface 2's join: through
 * `makesafe_release_revision_members`, never `ses_external_effects.job_id`.
 */
async function readLive(ids: string[]): Promise<Map<string, LiveRow>> {
  const rows = await query<Record<string, string | number | null>>(`
    with pop as (
      select j.id, j.job_number, d.report_sent_at, d.substatus
      from jobs j join makesafe_job_details d on d.job_id = j.id
      where j.id in (${idList(ids)})
    )
    select
      p.id                as job_id,
      p.job_number        as card,
      p.report_sent_at    as stamp,
      p.substatus         as substatus,
      (select count(*) from ses_release_route_proofs rp where rp.job_id = p.id)
                          as route_proofs,
      (select count(*)
         from ses_external_effects e
         join makesafe_release_revision_members m
           on m.release_revision_id = e.release_revision_id
        where e.effect_kind = 'route_send' and m.job_id = p.id)
                          as effect_sends,
      (select count(*) from makesafe_report_packs k
        where k.job_id = p.id
          and lower(coalesce(k.status,'')) in
              ('sent','sent_marker_failed','sent_not_closed','close_failed'))
                          as sent_packs,
      (select count(*) from job_events ev
        where ev.job_id = p.id
          and (ev.event_type ilike '%pack_sent%'
               or ev.detail_json::text like '%MAKESAFE_PACK_SENT%'))
                          as legacy_markers
    from pop p
    order by p.job_number
  `);
  const out = new Map<string, LiveRow>();
  for (const r of rows) {
    out.set(String(r.job_id), {
      jobId: String(r.job_id),
      card: String(r.card),
      stamp: r.stamp === null ? null : new Date(String(r.stamp)).toISOString(),
      substatus: r.substatus === null ? null : String(r.substatus),
      routeProofs: Number(r.route_proofs ?? 0),
      effectSends: Number(r.effect_sends ?? 0),
      sentPacks: Number(r.sent_packs ?? 0),
      legacyMarkers: Number(r.legacy_markers ?? 0),
    });
  }
  return out;
}

function sendEvidenceCount(live: LiveRow): number {
  return live.routeProofs + live.effectSends + live.sentPacks + live.legacyMarkers;
}

interface Assessment {
  card: string;
  jobId: string;
  ok: boolean;
  refusal?: string;
  live: LiveRow | null;
}

function assess(row: FixtureRow, live: LiveRow | undefined): Assessment {
  if (!live) {
    return { card: row.card, jobId: row.jobId, ok: false, refusal: "card not readable in production", live: null };
  }
  if (live.stamp === null) {
    return { card: row.card, jobId: row.jobId, ok: false, refusal: "already cleared (no stamp)", live };
  }
  if (live.stamp !== row.observedStamp) {
    return {
      card: row.card,
      jobId: row.jobId,
      ok: false,
      refusal: `stamp drift: fixture ${row.observedStamp}, production ${live.stamp}`,
      live,
    };
  }
  const evidence = sendEvidenceCount(live);
  if (evidence > 0) {
    return {
      card: row.card,
      jobId: row.jobId,
      ok: false,
      refusal:
        `send evidence present (proofs=${live.routeProofs} effects=${live.effectSends} ` +
        `packs=${live.sentPacks} markers=${live.legacyMarkers}) — stamp is NOT provably false`,
      live,
    };
  }
  return { card: row.card, jobId: row.jobId, ok: true, live };
}

function report(assessments: Assessment[]): void {
  console.log(
    `${"card".padEnd(13)}${"stamp".padEnd(26)}${"proofs".padStart(7)}` +
      `${"effects".padStart(9)}${"packs".padStart(7)}${"markers".padStart(9)}  verdict`,
  );
  for (const a of assessments) {
    const l = a.live;
    console.log(
      `${a.card.padEnd(13)}${String(l?.stamp ?? "-").padEnd(26)}` +
        `${String(l?.routeProofs ?? "-").padStart(7)}${String(l?.effectSends ?? "-").padStart(9)}` +
        `${String(l?.sentPacks ?? "-").padStart(7)}${String(l?.legacyMarkers ?? "-").padStart(9)}  ` +
        (a.ok ? "CLEAR (provably false)" : `REFUSED: ${a.refusal}`),
    );
  }
}

// ---------------------------------------------------------------------------
// The write — through the deployed typed ops-api action, never raw SQL
// ---------------------------------------------------------------------------

/**
 * REPOINTED. This used to write `{ report_sent_at: null }` through
 * `update_makesafe_details`, which was possible only because that editor
 * carried the field on its ordinary allow-list — the unguarded door the module
 * header called out. That door is now closed: the field is derived from a
 * recorded send, and the editor refuses any request that names it at all
 * (`bodyAssertsReportSentAt`), so the old write would now 400.
 *
 * The correction goes through `correct_makesafe_false_send_stamp`, which
 * enforces server-side the identical guard this script computes client-side —
 * the same four surfaces, the same fail-closed reading, plus a compare-and-set
 * on the stamp the caller observed. Belt and braces: this script keeps its own
 * assessment (so a card it would refuse is never even offered), and the action
 * refuses independently if production disagrees.
 */
async function clearStamp(jobId: string, observedStamp: string): Promise<void> {
  const key = Deno.env.get("SW_API_KEY");
  if (!key) throw new Error("SW_API_KEY required for apply");
  const res = await fetch(
    `${FUNCTIONS_BASE}/ops-api?action=correct_makesafe_false_send_stamp`,
    {
      method: "POST",
      headers: { "x-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        job_ids: [jobId],
        expected_report_sent_at: { [jobId]: observedStamp },
        reason:
          `${RUN_LABEL}: retired ready_to_invoice auto-stamp; no send on any of the four surfaces`,
        dry_run: false,
      }),
    },
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `correct_makesafe_false_send_stamp failed ${res.status}: ${text.slice(0, 400)}`,
    );
  }
  // The action returns 200 with a per-card outcome; a refusal is NOT an HTTP
  // error, so an unchecked 200 would report a clear that never happened.
  let parsed: {
    results?: Array<
      { outcome?: string; refusal_code?: string; refusal_fact?: string }
    >;
  };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`correct_makesafe_false_send_stamp returned unparseable JSON: ${text.slice(0, 200)}`);
  }
  const outcome = (parsed?.results || [])[0];
  if (outcome?.outcome !== "cleared") {
    throw new Error(
      `correct_makesafe_false_send_stamp did not clear ${jobId}: ` +
        `${outcome?.outcome ?? "no result"} (${outcome?.refusal_code ?? "-"}) ${outcome?.refusal_fact ?? ""}`,
    );
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const modeArg = (Deno.args.find((a) => a.startsWith("--mode")) || "--mode=dry-run")
    .replace(/^--mode[= ]?/, "") || "dry-run";
  const mode = modeArg as Mode;
  if (!MODES.includes(mode)) {
    console.error(`usage: --mode=${MODES.join("|")}`);
    return 2;
  }

  const ids = FIXTURE.map((f) => f.jobId);
  const live = await readLive(ids);
  const assessments = FIXTURE.map((f) => assess(f, live.get(f.jobId)));

  console.log(`\n${RUN_LABEL} — mode=${mode} — ${FIXTURE.length} card fixture\n`);
  report(assessments);

  const clearable = assessments.filter((a) => a.ok);
  console.log(`\n${clearable.length} clearable, ${assessments.length - clearable.length} refused\n`);

  if (mode === "dry-run") return 0;

  if (mode === "verify") {
    let bad = 0;
    for (const a of assessments) {
      const l = a.live;
      if (!l) { console.error(`  ${a.card}: unreadable`); bad++; continue; }
      if (l.stamp !== null) {
        console.error(`  ${a.card}: stamp still present (${l.stamp})`);
        bad++;
      } else if (sendEvidenceCount(l) > 0) {
        console.error(`  ${a.card}: send evidence appeared after the clear — investigate`);
        bad++;
      } else {
        console.log(`  ${a.card}: cleared, substatus '${l.substatus}' unchanged`);
      }
    }
    console.log(bad === 0 ? "\nverify OK\n" : `\nverify FAILED (${bad})\n`);
    return bad === 0 ? 0 : 1;
  }

  // apply — re-derive once more immediately before each write
  const ledger: unknown[] = [];
  let failed = 0;
  for (const a of clearable) {
    const fresh = await readLive([a.jobId]);
    const recheck = assess(FIXTURE.find((f) => f.jobId === a.jobId)!, fresh.get(a.jobId));
    if (!recheck.ok) {
      console.error(`  ${a.card}: REFUSED at apply — ${recheck.refusal}`);
      failed++;
      continue;
    }
    const observedStamp = recheck.live?.stamp ?? a.live?.stamp ?? null;
    if (!observedStamp) {
      console.error(`  ${a.card}: REFUSED at apply — no observed stamp to compare-and-set against`);
      failed++;
      continue;
    }
    try {
      await clearStamp(a.jobId, observedStamp);
      console.log(`  ${a.card}: cleared`);
      ledger.push({
        card: a.card,
        job_id: a.jobId,
        before_report_sent_at: a.live?.stamp ?? null,
        after_report_sent_at: null,
        substatus_unchanged: a.live?.substatus ?? null,
        send_evidence_at_apply: {
          route_proofs: recheck.live?.routeProofs ?? null,
          effect_sends_via_release_members: recheck.live?.effectSends ?? null,
          sent_packs: recheck.live?.sentPacks ?? null,
          legacy_markers: recheck.live?.legacyMarkers ?? null,
        },
        applied_at: new Date().toISOString(),
      });
    } catch (err) {
      console.error(`  ${a.card}: write FAILED — ${err instanceof Error ? err.message : err}`);
      failed++;
    }
  }
  await Deno.writeTextFile(
    LEDGER_PATH,
    JSON.stringify({ run: RUN_LABEL, applied: ledger.length, ledger }, null, 2) + "\n",
  );
  console.log(`\nledger written: ${LEDGER_PATH} (${ledger.length} rows, ${failed} failed)\n`);
  return failed === 0 ? 0 : 1;
}

if (import.meta.main) Deno.exit(await main());
