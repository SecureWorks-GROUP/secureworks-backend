#!/usr/bin/env -S deno run --allow-env --allow-net --allow-read
/**
 * Read-only census: how many currently-frozen fencing scope_revisions would
 * pass freeze-orderability/v1.
 *
 * Does not write. Does not call freeze_scope. Does not mint POs. Prints
 * counts and the most common missing field — never site addresses.
 *
 * Usage:
 *   SUPABASE_ACCESS_TOKEN=... deno run --allow-env --allow-net --allow-read \
 *     scripts/fence-freeze-orderability-census.ts
 *
 * A missing or 401 token is "not observed", not a fabricated count.
 */
import {
  inspectFreezeOrderability,
  summariseFreezeOrderability,
  type FreezeOrderabilityReport,
} from "../supabase/functions/_shared/scope_freeze/freeze_orderability.ts";

const PROJECT_REF = "kevgrhcjxspbxgovpmfl";
const MANAGEMENT_QUERY_URL =
  `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;

const WRITE_VERBS = [
  "insert",
  "update",
  "delete",
  "drop",
  "alter",
  "create",
  "truncate",
  "grant",
  "revoke",
  "comment on",
  "copy",
  "call",
  "do ",
  "vacuum",
  "refresh materialized",
];

export function assertReadOnlySql(sql: string): void {
  const normalized = sql.trim().toLowerCase();
  if (!/^(select|with)\b/.test(normalized)) {
    throw new Error(`refused non-SELECT statement: ${sql.slice(0, 80)}`);
  }
  for (const verb of WRITE_VERBS) {
    if (new RegExp(`(^|[^a-z_])${verb}(?![a-z_])`, "i").test(normalized)) {
      throw new Error(`refused statement naming write verb "${verb}"`);
    }
  }
}

export const CENSUS_SQL = `
select
  r.id,
  r.job_id,
  r.revision_number,
  r.status,
  r.tool_kind,
  r.tool_version,
  r.scope_hash,
  r.pricing_hash,
  r.frozen_at,
  r.frozen_by_user_id,
  r.scope_canonical_text,
  r.pricing_canonical_text,
  j.scope_json as live_scope_json,
  j.pricing_json as live_pricing_json
from scope_revisions r
join jobs j on j.id = r.job_id
where r.status = 'frozen'
  and r.tool_kind = 'fencing'
order by r.frozen_at desc nulls last, r.id
limit 100
`;

type CensusRow = {
  id: string
  job_id: string
  revision_number: number
  status: string
  tool_kind: string
  tool_version: string | null
  scope_hash: string | null
  pricing_hash: string | null
  frozen_at: string | null
  frozen_by_user_id: string | null
  scope_canonical_text: string | null
  pricing_canonical_text: string | null
  live_scope_json: unknown
  live_pricing_json: unknown
}

async function query<T>(sql: string, token: string): Promise<T[]> {
  assertReadOnlySql(sql);
  const response = await fetch(MANAGEMENT_QUERY_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "SecureWorks-Fence-Freeze-Orderability-Census/1.0",
    },
    body: JSON.stringify({ query: sql, read_only: true }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(payload)) {
    const message =
      payload && typeof payload === "object" && "message" in payload
        ? String((payload as { message: unknown }).message)
        : `HTTP ${response.status}`;
    throw new Error(`read-only query failed: ${message}`);
  }
  return payload as T[];
}

export async function classifyCensusRows(rows: CensusRow[]): Promise<FreezeOrderabilityReport[]> {
  const reports: FreezeOrderabilityReport[] = [];
  for (const row of rows) {
    reports.push(await inspectFreezeOrderability({
      revision: {
        id: row.id,
        job_id: row.job_id,
        tool_kind: row.tool_kind,
        tool_version: row.tool_version,
        scope_hash: row.scope_hash,
        pricing_hash: row.pricing_hash,
        frozen_at: row.frozen_at,
        frozen_by_user_id: row.frozen_by_user_id,
        scope_canonical_text: row.scope_canonical_text,
        pricing_canonical_text: row.pricing_canonical_text,
      },
      live: {
        scope_json: row.live_scope_json,
        pricing_json: row.live_pricing_json,
      },
    }));
  }
  return reports;
}

export function summariseDriftBuckets(reports: FreezeOrderabilityReport[]) {
  const summary = {
    matched: 0,
    drifted: 0,
    not_comparable: 0,
  };
  for (const report of reports) {
    summary[report.drift.comparison] += 1;
  }
  if (summary.matched + summary.drifted + summary.not_comparable !== reports.length) {
    throw new Error("drift bucket accounting does not equal examined revisions");
  }
  return summary;
}

async function main() {
  const token = Deno.env.get("SUPABASE_ACCESS_TOKEN")?.trim();
  if (!token) {
    console.log(JSON.stringify({
      observed: false,
      reason: "SUPABASE_ACCESS_TOKEN missing",
      query: "currently-frozen fencing scope_revisions joined to live jobs scope and pricing, classified by freeze-orderability/v1",
    }, null, 2));
    Deno.exit(2);
  }
  const rows = await query<CensusRow>(CENSUS_SQL, token);
  const reports = await classifyCensusRows(rows);
  const summary = summariseFreezeOrderability(reports);
  const drift = summariseDriftBuckets(reports);
  console.log(JSON.stringify({
    observed: true,
    contract_version: "freeze-orderability/v1",
    tool_kind: "fencing",
    status: "frozen",
    cap: 100,
    ...summary,
    ...drift,
  }, null, 2));
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(JSON.stringify({
      observed: false,
      reason: String((err as Error)?.message ?? err),
      query: "currently-frozen fencing scope_revisions joined to live jobs scope and pricing, classified by freeze-orderability/v1",
    }));
    Deno.exit(2);
  });
}
