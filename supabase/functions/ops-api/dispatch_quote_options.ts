// deno-lint-ignore-file no-explicit-any
// Ruling 14 step 1 (contract 4.4): the supplier order lines of the quote options
// a job's customer took. Each taken option that goes to a supplier carries its
// sealed order_line, a scope_json.lines[] entry shaped exactly as the same extra
// would be in the price, so it is read by the same rule as the sealed lines
// (scopeEngineSealedLines). Shared by both Dispatch fills
// (dispatch_v2_store.ts, dispatch_materials_store.ts).
import { readTakenQuoteOptions, takenLines } from "../_shared/quote_options/taken_options.ts";
import { scopeEngineSealedLines, type ScopeEngineSealedLine } from "./scope_engine_materials.ts";
import { goesOnSupplierCopy } from "../_shared/quote_options/supplier_copy_rule.ts";
import { dispatchSuggestedLines } from "./dispatch_materials.ts";

export type TakenOptionOrderItems =
  | { state: "unreadable" }
  /** A taken supplier option whose sealed line gives no order line: the fill is held, never short. */
  | { state: "unusable"; option_ids: string[] }
  | { state: "read"; items: ScopeEngineSealedLine[]; notes: string[] };

export async function takenQuoteOptionOrderItems(client: any, jobId: string): Promise<TakenOptionOrderItems> {
  const taken = await readTakenQuoteOptions(client, jobId);
  if (taken.state === "unreadable") return { state: "unreadable" };
  if (taken.state === "none") return { state: "read", items: [], notes: [] };
  return takenOptionOrderItems(taken.options);
}

/**
 * Pure: the order items of taken supplier options, and a note naming them.
 * Each taken supplier option must give exactly one order line by the sealed
 * line rule that both Dispatch fills keep; one that gives none (missing,
 * empty, an office fixing, or never on supplier copy) holds the fill as
 * "unusable" rather than be reported on the order while dropped.
 */
export function takenOptionOrderItems(
  options: Array<{ id: string; name: string; goes: string | null; sealed: Record<string, unknown> }>,
): Extract<TakenOptionOrderItems, { state: "read" | "unusable" }> {
  const supplier = options.filter((o) => o.goes === "supplier");
  const items: ScopeEngineSealedLine[] = [];
  const unusable: string[] = [];
  for (const o of supplier) {
    const line = takenLines([o], "supplier")[0]?.line;
    const parsed = line ? scopeEngineSealedLines([line]) : [];
    // Exactly one order line that both fills keep: one never on supplier copy
    // (the v2 exclusions) or dropped by the suggestion cleaner is unusable.
    if (
      parsed.length !== 1 || !goesOnSupplierCopy(parsed[0].description) ||
      dispatchSuggestedLines([parsed[0]]).length !== 1
    ) unusable.push(o.id);
    else items.push(parsed[0]);
  }
  if (unusable.length) return { state: "unusable", option_ids: unusable };
  const notes = supplier.length
    ? [`Taken quote option${supplier.length === 1 ? "" : "s"} on this order: ${supplier.map((o) => o.name).join(", ")}.`]
    : [];
  return { state: "read", items, notes };
}
