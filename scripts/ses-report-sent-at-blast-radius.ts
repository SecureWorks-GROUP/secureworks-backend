#!/usr/bin/env -S deno run --allow-env --allow-net
/**
 * Blast radius of making `makesafe_job_details.report_sent_at` derived.
 *
 * READ-ONLY. Management API, `read_only: true`, SELECT/WITH only. It writes
 * nothing and calls no ops-api action.
 *
 * TWO MODES
 * ---------
 *   --mode=report (default) — the census: which cards carry a stamp with NO
 *     send on any surface (false stamps), and which unstamped cards DO carry
 *     send evidence (the historical gap). Its zero-loss statement is a
 *     STRUCTURAL argument, not an empirical measurement: the derived producer
 *     writes only where `report_sent_at IS NULL`, and no branch in it writes
 *     null. Report mode always exits 0 on a successful read.
 *
 *   --mode=verify — the empirical half. Re-reads production and compares every
 *     card in the pinned manifest (`ses-report-sent-at-baseline-v1.json`, the
 *     31 stamped cards measured 2026-08-07) against its pinned stamp. A card
 *     whose stamp is now NULL, whose stamp changed to a different value, or
 *     which is absent from the board FAILS the run with a non-zero exit,
 *     naming the card and both values. This is the mode that "exits non-zero
 *     if any card would lose a stamp".
 *
 * The manifest is a snapshot to prove against and must NEVER be re-snapshotted
 * to make a failing run green — same spirit as the ses-e1 stage baseline and
 * the ses-c3 backfill ledgers. A verify failure is a real defect to diagnose,
 * not drift to absorb.
 *
 * THE FOUR SURFACES, AND THE JOIN THAT IS A TRAP
 * ----------------------------------------------
 *   1. `ses_release_route_proofs`   — carries `job_id`; the trustworthy join.
 *   2. `ses_external_effects` (`effect_kind='route_send'`) reached ONLY through
 *      `makesafe_release_revision_members`. That table's own `job_id` is NULL on
 *      every route_send row, so a direct join reads as "nothing was sent".
 *   3. `makesafe_report_packs.status` in a sent/closed status.
 *   4. The legacy `MAKESAFE_PACK_SENT` job_events marker.
 *
 * NO CLIENT-IDENTIFYING COLUMNS ARE SELECTED. Cards are named by job number.
 *
 * Usage:  SUPABASE_ACCESS_TOKEN=... deno run --allow-env --allow-net \
 *           scripts/ses-report-sent-at-blast-radius.ts [--mode=report|verify]
 */

import baseline from "./ses-report-sent-at-baseline-v1.json" with {
  type: "json",
};

const PROJECT_REF = "kevgrhcjxspbxgovpmfl";
const MANAGEMENT_QUERY_URL =
  `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;

async function query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  const token = Deno.env.get("SUPABASE_ACCESS_TOKEN");
  if (!token) throw new Error("SUPABASE_ACCESS_TOKEN required");
  if (!/^\s*(with|select)\b/i.test(sql)) {
    throw new Error(
      "read-only script: only SELECT/WITH statements are permitted",
    );
  }
  const res = await fetch(MANAGEMENT_QUERY_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: sql, read_only: true }),
  });
  if (!res.ok) {
    throw new Error(
      `management query failed ${res.status}: ${await res.text()}`,
    );
  }
  return await res.json() as T[];
}

const CARD_EVIDENCE_SQL = `
with card as (
  select j.id, j.job_number, d.report_sent_at
  from jobs j
  join makesafe_job_details d on d.job_id = j.id
  where j.type in ('makesafe','insurance')
),
s1 as (select job_id, count(*) n from ses_release_route_proofs group by 1),
s2 as (
  select m.job_id, count(*) n
  from makesafe_release_revision_members m
  join ses_external_effects e
    on e.release_revision_id = m.release_revision_id
   and e.effect_kind = 'route_send'
  group by 1
),
s3 as (
  select job_id, count(*) n from makesafe_report_packs
  where lower(status) in ('sent','sent_marker_failed','sent_not_closed','close_failed')
  group by 1
),
s4 as (
  select job_id, count(*) n from job_events
  where event_type ilike '%pack_sent%'
     or detail_json::text like '%MAKESAFE_PACK_SENT%'
  group by 1
)
select
  c.job_number,
  c.report_sent_at,
  coalesce(s1.n,0) as route_proofs,
  coalesce(s2.n,0) as route_send_effects,
  coalesce(s3.n,0) as sent_packs,
  coalesce(s4.n,0) as legacy_markers
from card c
left join s1 on s1.job_id = c.id
left join s2 on s2.job_id = c.id
left join s3 on s3.job_id = c.id
left join s4 on s4.job_id = c.id
order by c.job_number
`;

interface CardRow {
  job_number: string;
  report_sent_at: string | null;
  route_proofs: number;
  route_send_effects: number;
  sent_packs: number;
  legacy_markers: number;
}

function evidenceCount(row: CardRow): number {
  return Number(row.route_proofs) + Number(row.route_send_effects) +
    Number(row.sent_packs) + Number(row.legacy_markers);
}

function surfaces(row: CardRow): string {
  return `proof=${row.route_proofs} effect=${row.route_send_effects} ` +
    `pack=${row.sent_packs} marker=${row.legacy_markers}`;
}

function normaliseUtcSecond(raw: string): string | null {
  const s = raw.trim().replace(" ", "T");
  const m = s.match(
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/,
  );
  if (m && (!m[2] || m[2] === "Z" || /^[+-]00:?00$/.test(m[2]))) return m[1];
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 19);
}

async function report(): Promise<number> {
  const rows = await query<CardRow>(CARD_EVIDENCE_SQL);
  const stamped = rows.filter((r) => r.report_sent_at !== null);
  const unstamped = rows.filter((r) => r.report_sent_at === null);
  const stampedTrue = stamped.filter((r) => evidenceCount(r) > 0);
  const stampedFalse = stamped.filter((r) => evidenceCount(r) === 0);
  const unstampedSent = unstamped.filter((r) => evidenceCount(r) > 0);

  console.log(`\nses-report-sent-at-blast-radius — ${rows.length} SES cards\n`);
  console.log(`  stamped                       ${stamped.length}`);
  console.log(
    `    corroborated by a surface   ${stampedTrue.length}  (kept — no write touches them)`,
  );
  console.log(
    `    no surface at all           ${stampedFalse.length}  (false stamps; clearing them is correct_makesafe_false_send_stamp's job, not this change's)`,
  );
  console.log(`  unstamped                     ${unstamped.length}`);
  console.log(
    `    but a surface records a send ${unstampedSent.length}  (the historical gap; NOT backfilled by this change)`,
  );

  console.log(
    `\n  stamps that would CHANGE under the derivation: 0 — STRUCTURAL,`,
  );
  console.log(`    not measured here: the derived producer writes only where`);
  console.log(`    report_sent_at IS NULL, and no branch in it writes null.`);
  console.log(
    `    The empirical check is --mode=verify against the pinned manifest.\n`,
  );

  if (stampedFalse.length) {
    console.log(
      "  Stamped with NO send evidence (pre-existing, untouched here):",
    );
    for (const r of stampedFalse) {
      console.log(
        `    ${r.job_number.padEnd(14)} ${
          String(r.report_sent_at).slice(0, 19)
        }  ${surfaces(r)}`,
      );
    }
  }
  console.log("");
  return 0;
}

async function verify(): Promise<number> {
  const rows = await query<CardRow>(CARD_EVIDENCE_SQL);
  const byJobNumber = new Map(rows.map((r) => [r.job_number, r]));
  const failures: string[] = [];
  let ok = 0;

  for (const card of baseline.cards) {
    const live = byJobNumber.get(card.job_number);
    if (!live) {
      failures.push(
        `${card.job_number}: ABSENT from the board (pinned ${card.report_sent_at})`,
      );
      continue;
    }
    if (live.report_sent_at === null) {
      failures.push(
        `${card.job_number}: stamp is now NULL (pinned ${card.report_sent_at})`,
      );
      continue;
    }
    const liveNormalised = normaliseUtcSecond(live.report_sent_at);
    if (liveNormalised !== card.report_sent_at) {
      failures.push(
        `${card.job_number}: stamp changed — pinned ${card.report_sent_at}, live ${live.report_sent_at}`,
      );
      continue;
    }
    ok += 1;
  }

  console.log(
    `\nses-report-sent-at-blast-radius --mode=verify — ${baseline.cards.length} pinned cards (${baseline.measured_at})\n`,
  );
  console.log(`  unchanged  ${ok}`);
  console.log(`  failures   ${failures.length}\n`);

  if (failures.length > 0) {
    console.error(
      `FAIL: ${failures.length} pinned card(s) lost or changed a stamp. Diagnose the defect; never re-snapshot the manifest to make this green.`,
    );
    for (const f of failures) console.error(`  ${f}`);
    return 1;
  }
  console.log("  OK: every pinned stamp is intact and unchanged.\n");
  return 0;
}

async function main(): Promise<number> {
  const modeArg = Deno.args.find((a) => a.startsWith("--mode="));
  const mode = modeArg ? modeArg.slice("--mode=".length) : "report";
  if (mode === "report") return await report();
  if (mode === "verify") return await verify();
  console.error(`unknown mode "${mode}" — use --mode=report or --mode=verify`);
  return 2;
}

if (import.meta.main) {
  Deno.exit(await main());
}
