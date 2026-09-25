// Quote v2, stage 1: the ONE cut-to-order function.
//
// Turns required lengths into the lengths we must BUY from a supplier's stock
// list, and says how much of what we pay for never ends up on the job. Every
// future tool and terminal caller must price stock through this function; do not write a
// second nesting routine.
//
// Ported from the patio tool's nestCuts / calculateStockRequired
// (patio-tool index.html, commit 884a208), read only:
//
// - one_per_stick: each piece gets the smallest stock length that holds it
//   (posts, beams). A piece longer than every stock length is a special order.
// - nest: several pieces share one stock length, separated by the saw kerf
//   (rafters, battens, slats). A single cut length preserves nestCuts placement and bar counts:
//   the smallest stock that holds one piece, switching to a longer stock only
//   when that needs FEWER sticks. Mixed cut lengths are packed first-fit
//   decreasing on each candidate stock length and the plan with the fewest
//   sticks wins, then the least length bought. All sticks in one plan share
//   one stock length, as in nestCuts.
// - cut_to_size: the supplier cuts every piece to length. Nothing is wasted,
//   and the order is the pieces themselves.
//
// Waste is what we pay for and do not install: bought length minus required
// length. It therefore includes the saw kerf. Per-stick `offcut_mm` is the
// usable remainder after every cut's kerf, clamped to zero; nestCuts omits
// the final kerf from its remainder.
//
// Pure: no database, clock or network.

export type CutRule = "one_per_stick" | "nest" | "cut_to_size";

export const CUT_RULES: readonly CutRule[] = [
  "one_per_stick",
  "nest",
  "cut_to_size",
];

/** The patio tool's saw allowance. */
export const DEFAULT_KERF_MM = 3;
export const MAX_CUT_PIECES = 1000;

export interface CutPiece {
  length_mm: number;
  qty: number;
}

export interface CutRequest {
  pieces: CutPiece[];
  rule: CutRule;
  /** Required for one_per_stick and nest; ignored for cut_to_size. */
  stock_lengths_mm?: number[];
  kerf_mm?: number;
}

export interface CutStick {
  stock_length_mm: number;
  cuts_mm: number[];
  /** Usable remainder after cuts and kerf. */
  offcut_mm: number;
}

export interface CutOrderLine {
  /** Stock length bought, or the cut length for cut_to_size / special order. */
  length_mm: number;
  qty: number;
  special_order: boolean;
}

export interface CutPlan {
  rule: CutRule;
  kerf_mm: number;
  sticks: CutStick[];
  order: CutOrderLine[];
  special_orders: CutPiece[];
  piece_count: number;
  required_mm: number;
  purchased_mm: number;
  /** purchased_mm - required_mm: paid for, not installed (kerf included). */
  waste_mm: number;
  /** waste_mm / purchased_mm, 0 when nothing was bought. */
  waste_ratio: number;
  /** waste_ratio as a percentage rounded to one decimal place. */
  waste_percent: number;
}

export class CutToOrderError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "CutToOrderError";
  }
}

function positiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validate(req: CutRequest): { stock: number[]; kerf: number } {
  if (!CUT_RULES.includes(req.rule)) {
    throw new CutToOrderError(
      "cut_rule_unknown",
      `unknown cut rule ${req.rule}`,
    );
  }
  if (!Array.isArray(req.pieces) || req.pieces.length === 0) {
    throw new CutToOrderError(
      "cut_pieces_missing",
      "at least one piece is required",
    );
  }
  let pieceCount = 0;
  for (const piece of req.pieces) {
    if (!positiveInteger(piece?.length_mm) || !positiveInteger(piece?.qty)) {
      throw new CutToOrderError(
        "cut_piece_invalid",
        "every piece needs a whole positive length_mm and qty",
      );
    }
    pieceCount += piece.qty;
    if (pieceCount > MAX_CUT_PIECES) {
      throw new CutToOrderError(
        "cut_piece_count_exceeds_limit",
        `at most ${MAX_CUT_PIECES} pieces can be planned at once`,
      );
    }
  }
  const kerf = req.kerf_mm ?? DEFAULT_KERF_MM;
  if (typeof kerf !== "number" || !Number.isFinite(kerf) || kerf < 0) {
    throw new CutToOrderError(
      "cut_kerf_invalid",
      "kerf_mm must be zero or more",
    );
  }
  if (req.rule === "cut_to_size") return { stock: [], kerf };
  const stock = [...new Set(req.stock_lengths_mm ?? [])].sort((a, b) => a - b);
  if (stock.length === 0 || !stock.every(positiveInteger)) {
    throw new CutToOrderError(
      "cut_stock_lengths_missing",
      "stock_lengths_mm must list whole positive lengths for this rule",
    );
  }
  return { stock, kerf };
}

function expand(pieces: CutPiece[]): number[] {
  const out: number[] = [];
  for (const piece of pieces) {
    for (let i = 0; i < piece.qty; i++) out.push(piece.length_mm);
  }
  return out;
}

function stickUsed(cuts: number[], kerf: number): number {
  if (cuts.length === 0) return 0;
  return cuts.reduce((a, b) => a + b, 0) + (cuts.length - 1) * kerf;
}

function usableOffcut(
  stockLength: number,
  cuts: number[],
  kerf: number,
): number {
  return cuts.length === 0
    ? stockLength
    : Math.max(0, stockLength - stickUsed(cuts, kerf) - kerf);
}

/** How many pieces of one length fit in a stick (nestCuts' loop). */
function piecesPerStick(
  cut: number,
  stockLength: number,
  kerf: number,
): number {
  let n = 0;
  let used = 0;
  while (used + cut <= stockLength) {
    n++;
    used += cut + kerf;
  }
  return Math.max(n, 1);
}

function nestSingleLength(
  cut: number,
  qty: number,
  stock: number[],
  kerf: number,
): CutStick[] {
  let best = stock.find((s) => s >= cut) as number;
  let perStick = piecesPerStick(cut, best, kerf);
  for (const bigger of stock.filter((s) => s > best)) {
    const biggerPer = piecesPerStick(cut, bigger, kerf);
    if (Math.ceil(qty / biggerPer) < Math.ceil(qty / perStick)) {
      best = bigger;
      perStick = biggerPer;
    }
  }
  const sticks: CutStick[] = [];
  let remaining = qty;
  while (remaining > 0) {
    const n = Math.min(remaining, perStick);
    const cuts = Array.from({ length: n }, () => cut);
    sticks.push({
      stock_length_mm: best,
      cuts_mm: cuts,
      offcut_mm: usableOffcut(best, cuts, kerf),
    });
    remaining -= n;
  }
  return sticks;
}

function firstFitDecreasing(
  lengths: number[],
  stockLength: number,
  kerf: number,
): CutStick[] {
  const sorted = [...lengths].sort((a, b) => b - a);
  const bins: number[][] = [];
  for (const len of sorted) {
    const bin = bins.find((cuts) =>
      stickUsed(cuts, kerf) + kerf + len <= stockLength
    );
    if (bin) bin.push(len);
    else bins.push([len]);
  }
  return bins.map((cuts) => ({
    stock_length_mm: stockLength,
    cuts_mm: cuts,
    offcut_mm: usableOffcut(stockLength, cuts, kerf),
  }));
}

function nestMixed(
  lengths: number[],
  stock: number[],
  kerf: number,
): CutStick[] {
  const longest = Math.max(...lengths);
  let best: CutStick[] | null = null;
  for (const stockLength of stock.filter((s) => s >= longest)) {
    const plan = firstFitDecreasing(lengths, stockLength, kerf);
    if (
      best === null ||
      plan.length < best.length ||
      (plan.length === best.length &&
        plan.length * stockLength < best.length * best[0].stock_length_mm)
    ) {
      best = plan;
    }
  }
  return best ?? [];
}

function orderFromSticks(sticks: CutStick[]): CutOrderLine[] {
  const counts = new Map<number, number>();
  for (const stick of sticks) {
    counts.set(
      stick.stock_length_mm,
      (counts.get(stick.stock_length_mm) ?? 0) + 1,
    );
  }
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([length_mm, qty]) => ({ length_mm, qty, special_order: false }));
}

function groupPieces(lengths: number[]): CutPiece[] {
  const counts = new Map<number, number>();
  for (const len of lengths) counts.set(len, (counts.get(len) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([length_mm, qty]) => ({ length_mm, qty }));
}

export function cutToOrder(req: CutRequest): CutPlan {
  const { stock, kerf } = validate(req);
  const all = expand(req.pieces);
  const required = all.reduce((a, b) => a + b, 0);

  if (req.rule === "cut_to_size") {
    const order = groupPieces(all).map((p) => ({
      length_mm: p.length_mm,
      qty: p.qty,
      special_order: false,
    }));
    return finish(
      req.rule,
      kerf,
      [],
      order,
      [],
      all.length,
      required,
      required,
    );
  }

  const maxStock = stock[stock.length - 1];
  const special = all.filter((len) => len > maxStock);
  const fits = all.filter((len) => len <= maxStock);
  const specialOrders = groupPieces(special);

  let sticks: CutStick[] = [];
  if (fits.length > 0) {
    if (req.rule === "one_per_stick") {
      sticks = fits.map((len) => {
        const s = stock.find((x) => x >= len) as number;
        return {
          stock_length_mm: s,
          cuts_mm: [len],
          offcut_mm: usableOffcut(s, [len], kerf),
        };
      });
    } else if (new Set(fits).size === 1) {
      sticks = nestSingleLength(fits[0], fits.length, stock, kerf);
    } else {
      sticks = nestMixed(fits, stock, kerf);
    }
  }

  const order = [
    ...orderFromSticks(sticks),
    ...specialOrders.map((p) => ({
      length_mm: p.length_mm,
      qty: p.qty,
      special_order: true,
    })),
  ];
  const specialMm = special.reduce((a, b) => a + b, 0);
  const purchased = sticks.reduce((a, s) => a + s.stock_length_mm, 0) +
    specialMm;
  return finish(
    req.rule,
    kerf,
    sticks,
    order,
    specialOrders,
    all.length,
    required,
    purchased,
  );
}

function finish(
  rule: CutRule,
  kerf: number,
  sticks: CutStick[],
  order: CutOrderLine[],
  specialOrders: CutPiece[],
  pieceCount: number,
  required: number,
  purchased: number,
): CutPlan {
  const waste = purchased - required;
  const ratio = purchased > 0 ? waste / purchased : 0;
  return {
    rule,
    kerf_mm: kerf,
    sticks,
    order,
    special_orders: specialOrders,
    piece_count: pieceCount,
    required_mm: required,
    purchased_mm: purchased,
    waste_mm: waste,
    waste_ratio: ratio,
    waste_percent: Math.round(ratio * 1000) / 10,
  };
}

/**
 * One current rate for an item, per stock length (PB-9). `per_length_mm`
 * null is the supplier's generic $/LM rate with no stated length. Read from
 * `price_book_current_length_costs`.
 */
export interface LengthRate {
  per_length_mm: number | null;
  /** Cost ex GST per lineal metre, for that length. */
  cost_ex_gst: number;
  cost_row_id?: string | null;
  status?: string | null;
}

export type LengthRateBasis = "length_rate" | "per_lm_rate";

export interface CostedOrderLine extends CutOrderLine {
  /** Which rate priced this length, or null when none did (unpriced). */
  rate_basis: LengthRateBasis | null;
  cost_row_id: string | null;
  /** What one stock length of this size costs, ex GST. */
  each_ex_gst: number | null;
  line_ex_gst: number | null;
}

export interface CutPlanCost {
  lines: CostedOrderLine[];
  /** Whole stock lengths bought, ex GST; null when any length is unpriced. */
  purchased_ex_gst: number | null;
  /** The bought-but-not-installed share of that, ex GST. */
  waste_ex_gst: number | null;
  unpriced_lengths_mm: number[];
  special_order_priced_at_stock_rate: boolean;
}

/**
 * Cents for one length, exactly: the price book stores $/LM to 4 decimals and
 * lengths are whole mm, so rate x mm is a whole number of 1/10,000,000 dollars.
 * Rounded half up, like PostgreSQL round(numeric, 2) on a positive value.
 */
function lengthCents(costPerLm: number, lengthMm: number): number {
  const rate4 = Math.round(costPerLm * 10_000);
  const tenMillionths = rate4 * lengthMm;
  return Math.floor((tenMillionths + 50_000) / 100_000);
}

/**
 * Cost of what a plan BUYS: every stock length at the rate the supplier
 * charges for THAT length (PB-9). A 5.5 m length is priced from the 5.5 m
 * price, never from the 6.5 m length's cheaper $/LM. With no price for a
 * length, the supplier's generic $/LM rate is used and named; with neither,
 * the length is unpriced and the plan has no total. Same rule as the SQL
 * `quote_v2_price_book_line_cost`: one length costs round(rate x metres, 2).
 * Special orders are priced like any other length and flagged, because the
 * supplier's special order price is not the stock rate.
 */
export function costCutPlanByLength(
  plan: CutPlan,
  rates: LengthRate[],
): CutPlanCost {
  for (const rate of rates) {
    if (!Number.isFinite(rate.cost_ex_gst) || rate.cost_ex_gst <= 0) {
      throw new CutToOrderError(
        "cut_cost_invalid",
        "cost per metre must be above zero",
      );
    }
  }
  const exact = new Map<number, LengthRate>();
  let generic: LengthRate | null = null;
  for (const rate of rates) {
    if (rate.per_length_mm == null) generic ??= rate;
    else if (!exact.has(rate.per_length_mm)) {
      exact.set(rate.per_length_mm, rate);
    }
  }
  const unpriced: number[] = [];
  let totalCents = 0;
  const lines = plan.order.map((line): CostedOrderLine => {
    const hit = exact.get(line.length_mm);
    const rate = hit ?? generic;
    if (!rate) {
      unpriced.push(line.length_mm);
      return {
        ...line,
        rate_basis: null,
        cost_row_id: null,
        each_ex_gst: null,
        line_ex_gst: null,
      };
    }
    const eachCents = lengthCents(rate.cost_ex_gst, line.length_mm);
    totalCents += eachCents * line.qty;
    return {
      ...line,
      rate_basis: hit ? "length_rate" : "per_lm_rate",
      cost_row_id: rate.cost_row_id ?? null,
      each_ex_gst: eachCents / 100,
      line_ex_gst: (eachCents * line.qty) / 100,
    };
  });
  const priced = unpriced.length === 0;
  return {
    lines,
    purchased_ex_gst: priced ? totalCents / 100 : null,
    waste_ex_gst: priced && plan.purchased_mm > 0
      ? Math.round((totalCents * plan.waste_mm) / plan.purchased_mm) / 100
      : priced
      ? 0
      : null,
    unpriced_lengths_mm: unpriced,
    special_order_priced_at_stock_rate: plan.special_orders.length > 0,
  };
}
