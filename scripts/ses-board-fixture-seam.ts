#!/usr/bin/env -S deno run --allow-read --allow-env
// Deterministic Board seam for the SES e2e fixture driver.
// Calls the production makesafe board trade route (canonical loader + auth).
// stdin JSON: { profiles, rowsByTable, authUser, generatedAt? }
// stdout JSON: board response body + status
// This is NOT live five-minute SLA evidence.

import { _makesafeBoardActionForTest } from "../supabase/functions/ops-api/index.ts";

type CallRecord = {
  table: string;
  select?: string;
  eqs: Array<{ column: string; value: unknown }>;
};

function makeClient(
  profiles: Record<string, any>,
  rowsByTable: Record<string, any[]>,
) {
  const calls: CallRecord[] = [];
  function builder(table: string) {
    const rows =
      (table === "users" ? Object.values(profiles) : rowsByTable[table] || [])
        .slice();
    const predicates: Array<(row: any) => boolean> = [];
    const call: CallRecord = { table, eqs: [] };
    calls.push(call);
    const query: any = {
      select: (columns?: string) => {
        if (columns) call.select = columns;
        return query;
      },
      eq: (column: string, value: any) => {
        call.eqs.push({ column, value });
        predicates.push((row) => {
          if (Object.prototype.hasOwnProperty.call(row ?? {}, column)) {
            return row?.[column] === value;
          }
          if (column.includes(".")) {
            const parts = column.split(".");
            let cursor: any = row;
            for (const part of parts) cursor = cursor?.[part];
            return cursor === value;
          }
          return row?.[column] === value;
        });
        return query;
      },
      neq: (column: string, value: any) => {
        predicates.push((row) => row?.[column] !== value);
        return query;
      },
      not: (column: string, operator: string, value: string) => {
        if (operator === "in") {
          const excluded = value.slice(1, -1).split(",").map((item) =>
            item.replaceAll('"', "")
          );
          predicates.push((row) => !excluded.includes(String(row?.[column])));
        }
        return query;
      },
      gte: (column: string, value: any) => {
        predicates.push((row) => String(row?.[column] || "") >= String(value));
        return query;
      },
      in: (column: string, values: any[]) => {
        predicates.push((row) => values.includes(row?.[column]));
        return query;
      },
      order: () => query,
      range: async (from: number, to: number) => ({
        data: rows.filter((row) => predicates.every((p) => p(row))).slice(
          from,
          to + 1,
        ),
        error: null,
      }),
      maybeSingle: async () => ({
        data: rows.filter((row) => predicates.every((p) => p(row)))[0] || null,
        error: null,
      }),
      then: (resolve: (v: any) => any) => {
        const data = rows.filter((row) => predicates.every((p) => p(row)));
        return resolve({ data, error: null });
      },
    };
    return query;
  }
  return {
    calls,
    tableCalls: () => calls.map((c) => c.table),
    from: (table: string) => builder(table),
  };
}

const raw = await new Response(Deno.stdin.readable).text();
const input = JSON.parse(raw || "{}");
const profiles = input.profiles || {};
const rowsByTable = input.rowsByTable || {};
const authUser = input.authUser;
const generatedAt = input.generatedAt;
const expectedJobIds: string[] = Array.isArray(input.expectedJobIds)
  ? input.expectedJobIds.map(String)
  : [];

if (!authUser?.id) {
  console.log(JSON.stringify({
    ok: false,
    status: 400,
    error: "authUser.id required",
    evidence: "NOT_BUILT_YET",
  }));
  Deno.exit(0);
}

const client = makeClient(profiles, rowsByTable);
try {
  const response = await _makesafeBoardActionForTest(
    client,
    "jwt",
    authUser,
    "trade",
    generatedAt ? { generatedAt } : {},
  );
  const body = JSON.parse(await response.text());
  const boardIds = new Set(
    (body.rows || []).map((row: any) => String(row?.id || "")).filter(Boolean),
  );
  const missing = expectedJobIds.filter((id) => !boardIds.has(id));
  const jobsQueried = client.tableCalls().includes("jobs");
  const visibleToHugo = response.status === 200 &&
    missing.length === 0 &&
    expectedJobIds.length > 0 &&
    jobsQueried &&
    body.permissions?.sees_all_makesafes === true;

  console.log(JSON.stringify({
    ok: response.status === 200,
    status: response.status,
    body,
    visibleToHugo,
    jobsQueried,
    expectedJobIds,
    missingJobIds: missing,
    boardJobIds: Array.from(boardIds),
    generated_at: body.generated_at || null,
    source: "makesafe_board",
    seam: "scripts/ses-board-fixture-seam.ts",
    evidence_type: "deterministic_fixture_board_route",
    live_sla_claim: false,
  }));
} catch (error) {
  console.log(JSON.stringify({
    ok: false,
    status: 500,
    error: (error as Error).message,
    evidence: "NOT_BUILT_YET",
    live_sla_claim: false,
  }));
}
