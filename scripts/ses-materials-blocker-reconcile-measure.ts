#!/usr/bin/env -S deno run --allow-env --allow-net --allow-read
// deno-lint-ignore-file no-explicit-any
/**
 * Read-only measurement of the SES materials-charge blocker against production.
 *
 * Answers, per `standard_labour_materials` card and board-wide, which of the
 * three outcomes the materials question resolves to:
 *
 *   already_released  the CURRENT attendance cycle already shipped and is
 *                     billed, so nothing on it is still to be priced;
 *   already_invoiced  no send, but the card's issued invoice itemises priced
 *                     materials lines, which is a committed answer;
 *   ask               nobody and no instrument has answered — the operator is
 *                     asked for one figure, exactly as today.
 *
 * It runs the SHIPPED readers (`ses_invoiced_materials_evidence.ts`) over live
 * rows rather than restating their rules, so the number it reports is the
 * number the assembler will actually produce.
 *
 * Production safety:
 * - the only production access is the Supabase Management API `/database/query`
 *   endpoint with `read_only: true`, so the database itself refuses a write;
 * - `assertReadOnlySql` / `assertNoPiiColumns` are reused from the C2 harness
 *   and refuse a non-SELECT statement, or one naming a client-identifying
 *   column, before the request is sent. Nothing here selects a name, phone,
 *   email or street address; output is suburb and job reference only.
 *
 * NO write, NO prepare, NO backfill, NO stage move.
 *
 * Usage: SUPABASE_ACCESS_TOKEN=... deno run --allow-env --allow-net --allow-read \
 *          scripts/ses-materials-blocker-reconcile-measure.ts [--json]
 */

import {
  assertNoPiiColumns,
  assertReadOnlySql,
} from "./ses-c2-measure-board-evidence.ts";
import {
  readSesInvoicedMaterialsEvidence,
  readSesReleasedCycleEvidence,
} from "../supabase/functions/ops-api/ses_invoiced_materials_evidence.ts";
import { recordedMaterialsUsed } from "../supabase/functions/ops-api/ses_materials_charge_guard.ts";

const PROJECT_REF = "kevgrhcjxspbxgovpmfl";
const MANAGEMENT_QUERY_URL =
  `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;

async function query<T = Record<string, any>>(sql: string): Promise<T[]> {
  assertReadOnlySql(sql);
  assertNoPiiColumns(sql);
  const token = Deno.env.get("SUPABASE_ACCESS_TOKEN")?.trim();
  if (!token) throw new Error("SUPABASE_ACCESS_TOKEN is required");
  const response = await fetch(MANAGEMENT_QUERY_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "SecureWorks-SES-Materials-Blocker-Measure/1.0",
    },
    body: JSON.stringify({ query: sql, read_only: true }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(payload)) {
    const message = payload && typeof payload === "object" &&
        "message" in payload
      ? String((payload as any).message)
      : `HTTP ${response.status}`;
    throw new Error(`read-only query failed: ${message}`);
  }
  return payload as T[];
}

/**
 * The population is every card whose newest committed docket revision prices on
 * `standard_labour_materials` — the one basis that hosts a materials charge.
 * The basis is read off the revision the assembler itself produced rather than
 * re-derived from the family matrix here, so this cannot drift from it.
 */
const POPULATION_SQL = `
with newest as (
  select distinct on (r.job_id)
    r.job_id,
    r.current_attendance_cycle_id as cycle_id,
    r.local_invoice_proposal as proposal
  from makesafe_docket_revisions r
  where r.committed_at is not null
  order by r.job_id, r.committed_at desc
),
report as (
  select distinct on (sr.job_id, sr.attendance_cycle_id)
    sr.job_id,
    sr.attendance_cycle_id as cycle_id,
    sr.checklist_json->'materials_used' as materials_used,
    sr.checklist_json->'materials' as typed_materials,
    sr.checklist_json->'pricing'->'materials' as typed_pricing_materials
  from job_service_reports sr
  order by sr.job_id, sr.attendance_cycle_id, sr.created_at desc
)
select
  j.job_number,
  j.site_suburb,
  n.job_id::text as job_id,
  n.cycle_id::text as cycle_id,
  coalesce(rp.materials_used, '[]'::jsonb) as materials_used,
  coalesce(jsonb_array_length(rp.typed_materials), 0)
    + coalesce(jsonb_array_length(rp.typed_pricing_materials), 0) as typed_material_facts,
  n.proposal->'materials_charge' as standing_marker,
  (
    select coalesce(jsonb_agg(jsonb_build_object(
      'invoice_id', x.xero_invoice_id,
      'invoice_number', x.invoice_number,
      'status', x.status,
      'invoice_type', x.invoice_type,
      'line_items', coalesce(x.line_items, '[]'::jsonb)
    )), '[]'::jsonb)
    from xero_invoices x where x.job_id = n.job_id
  ) as invoices,
  (
    select coalesce(jsonb_agg(jsonb_build_object(
      'route_kind', p.route_kind,
      'proven_at', p.proven_at,
      'attendance_cycle_ids', to_jsonb(p.attendance_cycle_ids)
    )), '[]'::jsonb)
    from ses_release_route_proofs p where p.job_id = n.job_id
  ) as route_proofs
from newest n
join jobs j on j.id = n.job_id
left join report rp on rp.job_id = n.job_id and rp.cycle_id = n.cycle_id
where n.proposal->>'basis' = 'standard_labour_materials'
order by j.job_number
`;

type Outcome =
  | "already_released"
  | "already_invoiced"
  | "ask"
  | "standing_decision"
  | "typed_priced_materials"
  | "no_materials_recorded";

interface CardResult {
  job_number: string;
  site_suburb: string | null;
  outcome: Outcome;
  detail: string;
}

function classify(row: Record<string, any>): CardResult {
  const base = {
    job_number: row.job_number,
    site_suburb: row.site_suburb ?? null,
  };
  const materials = recordedMaterialsUsed(row.materials_used);
  const invoices = Array.isArray(row.invoices) ? row.invoices : [];
  const proofs = Array.isArray(row.route_proofs) ? row.route_proofs : [];

  // Same precedence the guard applies, in the same order. A card already
  // carrying a decision keeps it: both readings answer an UNANSWERED question,
  // so neither may rewrite a docket that already shipped under a figure.
  if (row.standing_marker != null) {
    return {
      ...base,
      outcome: "standing_decision",
      detail: `card already carries a ${
        String(row.standing_marker?.decision ?? "recorded")
      } decision`,
    };
  }
  const released = readSesReleasedCycleEvidence({
    attendance_cycle_id: row.cycle_id ?? null,
    route_proofs: proofs,
    invoices,
  });
  if (materials.length && released.kind === "released") {
    return {
      ...base,
      outcome: "already_released",
      detail: `shipped ${
        released.evidence.route_kinds.join("+")
      }, billed ${released.evidence.invoice_number}`,
    };
  }
  if (!materials.length) {
    return {
      ...base,
      outcome: "no_materials_recorded",
      detail: "no materials recorded, so nothing is asked",
    };
  }
  if (Number(row.typed_material_facts) > 0) {
    return {
      ...base,
      outcome: "typed_priced_materials",
      detail: "proposal already prices typed materials lines",
    };
  }
  const invoiced = readSesInvoicedMaterialsEvidence(invoices);
  if (invoiced.kind === "evidence") {
    return {
      ...base,
      outcome: "already_invoiced",
      detail:
        `${invoiced.evidence.invoice_number} prices $${invoiced.evidence.materials_ex_gst} ex of materials`,
    };
  }
  return { ...base, outcome: "ask", detail: invoiced.detail };
}

if (import.meta.main) {
  const rows = await query(POPULATION_SQL);
  const results = rows.map(classify);
  const byOutcome = new Map<Outcome, CardResult[]>();
  for (const result of results) {
    const list = byOutcome.get(result.outcome) ?? [];
    list.push(result);
    byOutcome.set(result.outcome, list);
  }

  if (Deno.args.includes("--json")) {
    console.log(
      JSON.stringify(
        { measured_at: new Date().toISOString(), results },
        null,
        2,
      ),
    );
  } else {
    console.log(
      `standard_labour_materials cards measured: ${results.length}\n`,
    );
    for (
      const outcome of [
        "already_released",
        "already_invoiced",
        "ask",
        "standing_decision",
        "typed_priced_materials",
        "no_materials_recorded",
      ] as Outcome[]
    ) {
      const list = byOutcome.get(outcome) ?? [];
      console.log(`${outcome}: ${list.length}`);
      for (const card of list) {
        console.log(
          `   ${card.job_number.padEnd(14)} ${
            (card.site_suburb ?? "-").padEnd(20)
          } ${card.detail}`,
        );
      }
      console.log("");
    }
    const cleared = (byOutcome.get("already_released") ?? []).length +
      (byOutcome.get("already_invoiced") ?? []).length;
    console.log(
      `cards this change clears: ${cleared} (${
        (byOutcome.get("already_released") ?? []).length
      } terminal, ${
        (byOutcome.get("already_invoiced") ?? []).length
      } itemised invoice)`,
    );
  }
}
