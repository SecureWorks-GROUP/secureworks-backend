// Quote v2 stage 3: turn a tool's or the terminal's scope into a draft
// revision payload. PROGRAM BRANCH ONLY.
//
// The iPad tools and the terminal send WHAT is being built (family, parties,
// items and quantities); the server decides what it costs. A price book item
// is costed by the database from the price book; one with required lengths
// goes through the ONE cut-to-order function first and becomes one line per
// stock length bought, costed at that length's own rate. Sell is cost x the
// family markup, or the scoper's own markup for that item (recorded with who
// set it), or a stated or adjustment sell exactly as stage 2 allows.
//
// Pure: no database, clock or network. The handler supplies the price book
// rows (price_book_current_costs) for the items named.

import {
  CUT_RULES,
  type CutPiece,
  type CutPlan,
  type CutRule,
  cutToOrder,
  CutToOrderError,
} from "../_shared/price_book/cut_to_order.ts";

export const QUOTE_FAMILIES = ["fencing", "patio", "stratco", "misc"] as const;
export type QuoteFamily = typeof QUOTE_FAMILIES[number];

/** One row of price_book_current_costs, as far as the builder reads it. */
export interface PriceBookRow {
  item_key: string;
  unit: string;
  status: "blessed" | "provisional" | "unpriced";
  cut_rule: CutRule | null;
  kerf_mm: number | string | null;
  stock_lengths_mm: number[] | null;
}

export interface ScopeItem {
  key: string;
  description: string;
  category?: string;
  qty?: number;
  unit?: string;
  price_book?: {
    item_key: string;
    /** Required lengths: bought through cut to order, one line per length. */
    cut?: {
      pieces: CutPiece[];
      stock_lengths_mm?: number[];
      rule?: CutRule;
    };
  };
  cost?: Record<string, unknown>;
  sell?: Record<string, unknown>;
  /** The scoper's markup for this item, instead of the family default. */
  markup?: { multiplier: number; reason?: string };
  splits?: { party_ref: string; share_bp: number }[];
  duplicate_ack?: string;
  note?: string;
}

export interface ScopeInput {
  family: QuoteFamily;
  scope?: Record<string, unknown>;
  parties: Record<string, unknown>[];
  items: ScopeItem[];
}

export interface CutReport {
  item_key: string;
  rule: CutRule;
  pieces: number;
  required_mm: number;
  purchased_mm: number;
  waste_mm: number;
  waste_percent: number;
  order: { length_mm: number; qty: number; special_order: boolean }[];
  stock_lengths_source: "caller" | "price_book";
  rule_source: "caller" | "price_book";
}

export interface ScopeBuildPlan {
  /** For quote_v2_create_draft (via quote_v2_build_draft). */
  payload: {
    family: QuoteFamily;
    scope: Record<string, unknown>;
    parties: Record<string, unknown>[];
    lines: Record<string, unknown>[];
  };
  /** For quote_v2_set_line_markup, set by the caller. */
  markups: { line_key: string; multiplier: number; reason: string | null }[];
  cuts: CutReport[];
}

export class ScopeBuildError extends Error {
  constructor(public readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ScopeBuildError";
  }
}

export const MAX_SCOPE_ITEMS = 300;
const KEY_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;

function fail(code: string, message: string): never {
  throw new ScopeBuildError(code, message);
}

function positive(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/** The price book item keys a scope names, to read their rows once. */
export function scopePriceBookKeys(input: ScopeInput): string[] {
  const keys = new Set<string>();
  for (const item of input.items ?? []) {
    if (item?.price_book?.item_key) keys.add(item.price_book.item_key);
  }
  return [...keys];
}

function metres(mm: number): string {
  const m = mm / 1000;
  return Number.isInteger(m) ? `${m}` : `${Number(m.toFixed(3))}`;
}

export function planScopeBuild(
  input: ScopeInput,
  priceBook: PriceBookRow[],
): ScopeBuildPlan {
  if (!input || typeof input !== "object") {
    fail("quote_scope_invalid", "send the scope as an object");
  }
  if (!QUOTE_FAMILIES.includes(input.family)) {
    fail("quote_family_unknown", `${input.family}`);
  }
  if (!Array.isArray(input.parties) || input.parties.length === 0) {
    fail("quote_parties_missing", "name at least the client");
  }
  if (!Array.isArray(input.items) || input.items.length === 0) {
    fail("quote_revision_no_lines", "a quote needs at least one item");
  }
  if (input.items.length > MAX_SCOPE_ITEMS) {
    fail("quote_scope_too_large", `at most ${MAX_SCOPE_ITEMS} items`);
  }
  const rows = new Map(priceBook.map((r) => [r.item_key, r]));
  const lines: Record<string, unknown>[] = [];
  const markups: ScopeBuildPlan["markups"] = [];
  const cuts: CutReport[] = [];
  const seen = new Set<string>();
  const addLine = (line: Record<string, unknown>) => {
    const k = String(line.line_key);
    if (seen.has(k)) fail("quote_line_key_duplicate", `${k} appears twice`);
    seen.add(k);
    lines.push(line);
  };

  for (const item of input.items) {
    if (!item || typeof item !== "object") {
      fail("quote_line_invalid", "every item is an object");
    }
    if (typeof item.key !== "string" || !KEY_RE.test(item.key)) {
      fail(
        "quote_line_key_invalid",
        `item key ${
          JSON.stringify(item.key)
        } must be lower-case letters, digits, dot, dash or underscore`,
      );
    }
    if (typeof item.description !== "string" || !item.description.trim()) {
      fail("quote_line_invalid", `${item.key} needs a description`);
    }
    const sources = [item.price_book, item.cost].filter(Boolean).length;
    if (sources > 1) {
      fail(
        "quote_line_cost_ambiguous",
        `${item.key}: name a price book item or a stated cost, not both`,
      );
    }
    const sell = item.sell ?? { basis: "cost_markup" };
    if (item.markup !== undefined) {
      if (sell.basis !== "cost_markup") {
        fail(
          "quote_line_not_marked_up",
          `${item.key} has a ${
            String(sell.basis)
          } sell, so a markup does not apply`,
        );
      }
      if (!positive(item.markup.multiplier) || item.markup.multiplier < 1) {
        fail(
          "quote_markup_below_cost",
          `${item.key}: a markup under 1.0 sells under cost`,
        );
      }
    }
    const common = {
      description: item.description.trim(),
      ...(item.category ? { category: item.category } : {}),
      sell,
      ...(item.splits ? { splits: item.splits } : {}),
      ...(item.duplicate_ack ? { duplicate_ack: item.duplicate_ack } : {}),
      ...(item.note ? { note: item.note } : {}),
    };
    const markFor = (lineKey: string) => {
      if (item.markup) {
        markups.push({
          line_key: lineKey,
          multiplier: item.markup.multiplier,
          reason: item.markup.reason?.trim() || null,
        });
      }
    };

    if (!item.price_book) {
      const line: Record<string, unknown> = {
        line_key: item.key,
        ...common,
        cost: item.cost ?? { source: "none" },
      };
      if (item.qty !== undefined) line.qty = item.qty;
      if (item.unit !== undefined) line.unit = item.unit;
      if (sell.basis !== "adjustment" && !positive(item.qty)) {
        fail("quote_line_qty_invalid", `${item.key} needs a quantity above 0`);
      }
      addLine(line);
      markFor(item.key);
      continue;
    }

    const itemKey = item.price_book.item_key;
    const row = rows.get(itemKey);
    if (!row) {
      fail(
        "quote_line_item_unknown",
        `${item.key}: no price book item ${itemKey}`,
      );
    }
    if (row.status === "unpriced") {
      fail(
        "quote_line_unpriced",
        `${item.key}: ${itemKey} has no cost in the price book yet`,
      );
    }
    const cut = item.price_book.cut;
    if (!cut) {
      if (!positive(item.qty)) {
        fail("quote_line_qty_invalid", `${item.key} needs a quantity above 0`);
      }
      addLine({
        line_key: item.key,
        ...common,
        qty: item.qty,
        ...(item.unit ? { unit: item.unit } : {}),
        cost: { source: "price_book", item_key: itemKey },
      });
      markFor(item.key);
      continue;
    }

    if (row.unit !== "lm") {
      fail(
        "quote_line_stock_length_needs_lm_item",
        `${item.key}: ${itemKey} is priced per ${row.unit}, so it is not cut to order`,
      );
    }
    if (item.qty !== undefined) {
      fail(
        "quote_line_qty_invalid",
        `${item.key}: the quantity of a cut item comes from its lengths`,
      );
    }
    if (cut.rule !== undefined && !CUT_RULES.includes(cut.rule)) {
      fail("cut_rule_unknown", `${item.key}: ${cut.rule}`);
    }
    const rule = cut.rule ?? row.cut_rule;
    if (!rule) {
      fail(
        "cut_rule_unknown_for_item",
        `${itemKey} has no cut rule; state one`,
      );
    }
    const stock = Array.isArray(cut.stock_lengths_mm)
      ? cut.stock_lengths_mm
      : row.stock_lengths_mm ?? undefined;
    if (rule !== "cut_to_size" && !stock?.length) {
      fail(
        "stock_lengths_unknown",
        `${itemKey} has no stock lengths recorded; state them or record them first`,
      );
    }
    let plan: CutPlan;
    try {
      plan = cutToOrder({
        rule,
        pieces: cut.pieces,
        stock_lengths_mm: stock,
        kerf_mm: row.kerf_mm == null ? undefined : Number(row.kerf_mm),
      });
    } catch (e) {
      if (e instanceof CutToOrderError) {
        fail(e.code, `${item.key}: ${e.message}`);
      }
      throw e;
    }
    cuts.push({
      item_key: itemKey,
      rule,
      pieces: plan.piece_count,
      required_mm: plan.required_mm,
      purchased_mm: plan.purchased_mm,
      waste_mm: plan.waste_mm,
      waste_percent: plan.waste_percent,
      order: plan.order,
      stock_lengths_source: Array.isArray(cut.stock_lengths_mm)
        ? "caller"
        : "price_book",
      rule_source: cut.rule ? "caller" : "price_book",
    });
    for (const o of plan.order) {
      const lineKey = `${item.key}@${o.length_mm}`;
      const size = rule === "cut_to_size" ? "cut to" : "lengths of";
      addLine({
        line_key: lineKey,
        ...common,
        description: `${common.description} (${size} ${metres(o.length_mm)} m)`,
        qty: o.qty,
        unit: "length",
        cost: {
          source: "price_book",
          item_key: itemKey,
          stock_length_mm: o.length_mm,
        },
        ...(o.special_order
          ? {
            note: [
              common.note,
              "special order: longer than every stock length, priced at the stock rate",
            ].filter(Boolean).join("; "),
          }
          : {}),
      });
      markFor(lineKey);
    }
  }

  return {
    payload: {
      family: input.family,
      scope: input.scope ?? {},
      parties: input.parties,
      lines,
    },
    markups,
    cuts,
  };
}
