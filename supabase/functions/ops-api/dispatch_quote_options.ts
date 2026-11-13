// deno-lint-ignore-file no-explicit-any
// Ruling 14 step 1 (contract 4.4): the supplier order lines of the quote options
// a job's customer took. Each taken option that goes to a supplier carries its
// sealed order_line, a scope_json.lines[] entry shaped exactly as the same extra
// would be in the price, so it is read by the same rule as the sealed lines
// (scopeEngineSealedLines). Shared by both Dispatch fills
// (dispatch_v2_store.ts, dispatch_materials_store.ts).
import { readTakenQuoteOptions, takenLines } from "../_shared/quote_options/taken_options.ts";
import { scopeEngineSealedLines, type ScopeEngineSealedLine } from "./scope_engine_materials.ts";

export type TakenOptionOrderItems =
  | { state: "unreadable" }
  | { state: "read"; items: ScopeEngineSealedLine[]; notes: string[] };

export async function takenQuoteOptionOrderItems(client: any, jobId: string): Promise<TakenOptionOrderItems> {
  const taken = await readTakenQuoteOptions(client, jobId);
  if (taken.state === "unreadable") return { state: "unreadable" };
  if (taken.state === "none") return { state: "read", items: [], notes: [] };
  return takenOptionOrderItems(taken.options);
}

/** Pure: the order items of taken supplier options, and a note naming them. */
export function takenOptionOrderItems(
  options: Array<{ id: string; name: string; goes: string | null; sealed: Record<string, unknown> }>,
): { state: "read"; items: ScopeEngineSealedLine[]; notes: string[] } {
  const supplier = options.filter((o) => o.goes === "supplier");
  const withLine = takenLines(supplier, "supplier");
  const items = scopeEngineSealedLines(withLine.map((o) => o.line));
  const notes: string[] = [];
  if (withLine.length) {
    notes.push(`Taken quote option${withLine.length === 1 ? "" : "s"} on this order: ${withLine.map((o) => o.name).join(", ")}.`);
  }
  const unread = supplier.filter((o) => !withLine.some((w) => w.id === o.id));
  if (unread.length) {
    notes.push(`The quote option${unread.length === 1 ? "" : "s"} ${unread.map((o) => o.name).join(", ")} ${unread.length === 1 ? "has" : "have"} no order line in the sealed quote. Check the quote.`);
  }
  return { state: "read", items, notes };
}
