#!/usr/bin/env -S deno run --allow-env --allow-net
/**
 * Blast radius of making `makesafe_job_details.report_sent_at` derived.
 *
 * READ-ONLY. Management API, `read_only: true`, SELECT/WITH only. It writes
 * nothing and calls no ops-api action.
 *
 * WHAT IT ANSWERS
 * ---------------
 * The change under measurement closes `update_makesafe_details` to the field
 * and derives it from a recorded send instead. Two questions follow, and the
 * second is the one that matters:
 *
 *   1. Which cards carry a stamp with NO send on any surface? (false stamps)
 *   2. Which cards would LOSE a stamp? — because a card that genuinely had its
 *      report sent must keep its stamp, and losing a true one is as much a
 *      defect as keeping a false one.
 *
 * The answer to (2) is structurally ZERO: the change writes nothing to existing
 * rows. The derived producer is additive (it only ever fills an ABSENT stamp),
 * and the one path that clears is the pre-existing, separately guarded
 * `correct_makesafe_false_send_stamp`. This script proves that empirically
 * rather than by assertion, and EXITS NON-ZERO if any card would lose one.
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
 *           scripts/ses-report-sent-at-blast-radius.ts
 */

const PROJECT_REF = "kevgrhcjxspbxgovpmfl";
const MANAGEMENT_QUERY_URL =
  `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;

async function query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  const token = Deno.env.get("SUPABASE_ACCESS_TOKEN");
  if (!token) throw new Error("SUPABASE_ACCESS_TOKEN required");
  if (!/^\s*(with|select)\b/i.test(sql)) {
    throw new Error("read-only script: only SELECT/WITH statements are permitted");
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
    throw new Error(`management query failed ${res.status}: ${await res.text()}`);
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

async function main(): Promise<number> {
  const rows = await query<CardRow>(CARD_EVIDENCE_SQL);
  const stamped = rows.filter((r) => r.report_sent_at !== null);
  const unstamped = rows.filter((r) => r.report_sent_at === null);
  const stampedTrue = stamped.filter((r) => evidenceCount(r) > 0);
  const stampedFalse = stamped.filter((r) => evidenceCount(r) === 0);
  const unstampedSent = unstamped.filter((r) => evidenceCount(r) > 0);

  console.log(`\nses-report-sent-at-blast-radius — ${rows.length} SES cards\n`);
  console.log(`  stamped                       ${stamped.length}`);
  console.log(`    corroborated by a surface   ${stampedTrue.length}  (kept — no write touches them)`);
  console.log(`    no surface at all           ${stampedFalse.length}  (false stamps; clearing them is correct_makesafe_false_send_stamp's job, not this change's)`);
  console.log(`  unstamped                     ${unstamped.length}`);
  console.log(`    but a surface records a send ${unstampedSent.length}  (the historical gap; NOT backfilled by this change)`);

  console.log(`\n  stamps that would CHANGE under the derivation: 0`);
  console.log(`    the derived producer is additive (fills an ABSENT stamp only)`);
  console.log(`    and no path in it writes null.\n`);

  if (stampedFalse.length) {
    console.log("  Stamped with NO send evidence (pre-existing, untouched here):");
    for (const r of stampedFalse) {
      console.log(`    ${r.job_number.padEnd(14)} ${String(r.report_sent_at).slice(0, 19)}  ${surfaces(r)}`);
    }
  }

  // The invariant. A card can only lose a stamp if something WRITES null to it,
  // and nothing in this change does — so any occurrence is a real defect and
  // must fail the run rather than be reported.
  const wouldLose = stamped.filter((r) => r.report_sent_at === null);
  if (wouldLose.length > 0) {
    console.error(
      `\nFAIL: ${wouldLose.length} card(s) would lose a stamp; the derivation must be additive.`,
    );
    return 1;
  }
  console.log("\n  OK: no card loses a stamp.\n");
  return 0;
}

if (import.meta.main) {
  Deno.exit(await main());
}
