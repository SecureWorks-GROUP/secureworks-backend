import { buildRoofStoreyBackfillRow } from "../../../supabase/functions/ops-api/makesafe_roof_storey_backfill.ts";
const rows = JSON.parse(await Deno.readTextFile(Deno.args[0]));
const tally: Record<string, number> = {};
// deno-lint-ignore no-explicit-any -- ad hoc JSON evidence rows mirror the live payload.
const out: any[] = [];
for (const r of rows) {
  const job = {
    id: r.job_number,
    job_number: r.job_number,
    status: r.status,
    notes: r.notes,
    metadata: r.metadata,
    scope_json: r.scope_json,
    site_suburb: null,
  };
  // deno-lint-ignore no-explicit-any -- ad hoc evidence payload is intentionally untyped.
  const row: any = buildRoofStoreyBackfillRow(job as any, r.detail ?? null, {
    hasPersistedDocket: (r.dockets ?? 0) > 0,
    hasInvoiceObligation: false,
  });
  const d = row.disposition ?? "(none)";
  tally[d] = (tally[d] ?? 0) + 1;
  out.push({
    job_number: r.job_number,
    disposition: d,
    storeys: row.storeys ?? null,
    reason: row.reason ?? row.refusal ?? null,
  });
}
console.log(JSON.stringify(tally, null, 2));
await Deno.writeTextFile(Deno.args[1], JSON.stringify(out, null, 2));
