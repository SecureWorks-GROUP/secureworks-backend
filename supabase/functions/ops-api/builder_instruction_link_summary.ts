// deno-lint-ignore-file no-explicit-any
// W4 preparation: read-only summary of builder-instruction links.
// Input: JSON lines from operations/workstreams/W4/sql/builder-instruction-link-export.sql.
// Output: counts and dollars by state, with job numbers only (no file names,
// no client details). Usage: deno run --allow-read <this file> export.jsonl
import {
  linkTradeLineToBuilderInstruction,
  listBuilderInstructions,
} from "./builder_instruction_link.ts";

export interface SummaryRow {
  state: string;
  lines: number;
  line_total_ex: number;
  job_numbers: string[];
}

export function summariseBuilderInstructionLinks(rows: any[]): SummaryRow[] {
  const byState = new Map<string, SummaryRow>();
  for (const row of rows) {
    const link = linkTradeLineToBuilderInstruction(
      { line: row.line, assignments: row.assignments },
      listBuilderInstructions({
        job: row.job,
        makesafe_details: row.makesafe_details,
        work_order_documents: row.work_order_documents,
      }),
    );
    const state =
      link.state === "linked" && link.order?.document_ids.length === 0
        ? "linked_no_pdf"
        : link.state;
    const entry = byState.get(state) ??
      { state, lines: 0, line_total_ex: 0, job_numbers: [] };
    entry.lines += 1;
    entry.line_total_ex = Math.round(
      (entry.line_total_ex + Number(row.line?.line_total_ex ?? 0)) * 100,
    ) / 100;
    const jobNumber = String(row.job?.job_number ?? "");
    if (jobNumber && !entry.job_numbers.includes(jobNumber)) {
      entry.job_numbers.push(jobNumber);
    }
    byState.set(state, entry);
  }
  return [...byState.values()].sort((a, b) => a.state < b.state ? -1 : 1);
}

if (import.meta.main) {
  const text = await Deno.readTextFile(Deno.args[0]);
  const rows = text.split("\n").filter((l) => l.trim()).map((l) =>
    JSON.parse(l)
  );
  console.log(JSON.stringify(summariseBuilderInstructionLinks(rows), null, 2));
}
