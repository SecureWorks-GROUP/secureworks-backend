// READ-ONLY local preview of the sanctioned storey matcher. Calls the exact
// production function (roofStoreyOrderedProductFact) over the exact instruction
// text the backfill assembles (roofStoreyBackfillSourceText). Writes nothing.
import { roofStoreyOrderedProductFact } from "../../../supabase/functions/ops-api/makesafe_roof_storey_fact.ts";
import { roofStoreyBackfillSourceText } from "../../../supabase/functions/ops-api/makesafe_roof_storey_backfill.ts";
const rows = JSON.parse(await Deno.readTextFile(Deno.args[0]));
const tally: Record<string, number> = {};
// deno-lint-ignore no-explicit-any -- ad hoc JSON evidence rows mirror the live payload.
const out: any[] = [];
for (const r of rows) {
  const job = {
    notes: r.notes,
    metadata: {
      makesafe_type: r.makesafe_type,
      builder_email_text_for_trade: r.builder_text,
    },
  };
  // deno-lint-ignore no-explicit-any -- ad hoc evidence payload is intentionally untyped.
  const src = roofStoreyBackfillSourceText(job as any);
  const fact = roofStoreyOrderedProductFact(src);
  let verdict: string;
  if (!fact) verdict = "no_storey_named";
  else if ("storeys" in fact) verdict = fact.storeys;
  else verdict = "refused:" + fact.refused;
  tally[verdict] = (tally[verdict] ?? 0) + 1;
  out.push({
    job_number: r.job_number,
    verdict,
    matched: fact && typeof fact === "object" && "matched" in fact
      ? fact.matched
      : null,
  });
}
console.log(JSON.stringify(tally, null, 2));
for (
  const o of out.filter((o) =>
    ["SWMS-261019", "SWMS-261079", "SWMS-26934", "SWMS-26980"].includes(
      o.job_number,
    )
  )
) {
  console.log(
    `  ${o.job_number}  -> ${o.verdict}   matched=${JSON.stringify(o.matched)}`,
  );
}
await Deno.writeTextFile(Deno.args[1], JSON.stringify(out, null, 2));
