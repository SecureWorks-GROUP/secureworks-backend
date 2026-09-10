/**
 * Match a rendered material label to one recorded service-report item.
 *
 * Exact labels win. The only display-only transformation allowed is omitting
 * a separate positive-integer ` x N` quantity suffix from a source label whose
 * preceding label contains no digits. The caller consumes the returned source
 * index, so one source occurrence cannot cover two rendered occurrences.
 */

export type SesMaterialDisplayMatch = {
  source_index: number;
  source_item: string;
  display_item: string;
} & (
  | { match_kind: "exact" }
  | { match_kind: "quantity_suffix_omitted"; source_quantity: number }
);

const QUANTITY_SUFFIX_RE = /^(.*?)\s+x\s+([1-9]\d*)$/;

export function matchSesMaterialDisplay(
  displayItem: string,
  remainingSourceItems: readonly string[],
): SesMaterialDisplayMatch | null {
  const display = String(displayItem || "").trim();
  if (!display) return null;

  const sources = remainingSourceItems.map((item) => String(item).trim());
  const exactIndex = sources.indexOf(display);
  if (exactIndex >= 0) {
    return {
      source_index: exactIndex,
      source_item: sources[exactIndex],
      display_item: display,
      match_kind: "exact",
    };
  }

  for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
    const sourceItem = sources[sourceIndex];
    const suffix = sourceItem.match(QUANTITY_SUFFIX_RE);
    if (!suffix) continue;
    const label = suffix[1].trim();
    if (!label || /\d/.test(label) || label !== display) continue;
    const sourceQuantity = Number(suffix[2]);
    if (!Number.isSafeInteger(sourceQuantity) || sourceQuantity <= 0) continue;
    return {
      source_index: sourceIndex,
      source_item: sourceItem,
      display_item: display,
      match_kind: "quantity_suffix_omitted",
      source_quantity: sourceQuantity,
    };
  }

  return null;
}
