// deno-lint-ignore-file no-explicit-any
// Work order lines from the accepted quote. Contract:
// docs/quote-work-order-lines-v1.md.
//
// Pure: no I/O. job_work_order_quote_fill.ts owns the reads (the frozen quote
// revision and the scoping tool's cost table) and the one write (filling an
// untouched job work order draft, job_work_orders.ts).
//
// Captain's answers, 12 Oct 2026, that this module follows:
// - The quote's own cost table is the only rate source (scope_tool_defaults,
//   the table the fence tool prices from). No other rate card is read.
// - The agreed labour is the quote's own labour figure (labourCostEstimate,
//   else internal.labour), never a sum re-priced from today's table. A line
//   counts toward it only when it is part of that figure; the rest stay on the
//   work order, uncounted and flagged.
// - Fencing install is shown as quoted, per metre. Hours appear only where the
//   quote itself has hours.
// - A custom labour line counts as labour, whatever the cost breakdown called it.
// - No trade sees a dollar figure: each line's trade-safe reading is its
//   description, qty and unit (hours ride as qty with unit "hrs"), and the
//   description never carries a rate, amount, percent or money word.
//
// Reading older quotes: the fence tool saved every custom line as "material"
// until it learned to ask. A material line priced in hours ("Root removal /
// hard digging, 2 hrs") is read as labour and flagged. Any other material line
// is not guessed at: it stays on the work order uncounted and flagged
// labour_or_material_unknown, even when its words mention hours.

export const QUOTE_WORK_ORDER_LINES_SCHEMA = "quote-work-order-lines.v1";

// scope_tool_defaults item keys (scope_tool 'fence-designer') the fencing
// labour split reads. These are the keys the fence tool overlays its own
// COST_PRICES from, so the split uses the same table the quote was priced from.
export const FENCE_LABOUR_COST_KEYS = {
  installPerMetre: "base-labour",
  plinthInstall: "plinth-install",
  gatePedestrian: "gate-labour-pedestrian",
  gateDouble: "gate-labour-double",
  removeHardie: "remove-hardie-cost",
  removeTimber: "remove-timber-cost",
  removeColorbond: "remove-colorbond-cost",
  removeAsbestos: "remove-asbestos-cost",
  vegetationClear: "veg-clear-cost",
} as const;

export const FENCE_LABOUR_COST_ITEM_KEYS: readonly string[] = Object.values(
  FENCE_LABOUR_COST_KEYS,
);

/** item_key -> ex-GST cost rate, from scope_tool_defaults.default_cost_rate. */
export type QuoteCostTable = Readonly<Record<string, number>>;

export type QuoteWorkOrderLineBasis =
  | "fence_install"
  | "fence_plinths"
  | "fence_gate"
  | "fence_access"
  | "removal"
  | "quote_labour_line"
  | "quote_extra";

/** One work order line, in the job work order's scope_items shape
 *  (docs/job-work-orders-v1.md). The trade view keeps description, qty and
 *  unit only; every other key is office-only. */
export type QuoteWorkOrderLine = {
  /** Stable within one quote: "<install|gate|removal|labour|extra>:<index in
   *  pricing.line_items>", or "plinths" and "access" for the lines summed or
   *  derived from several rows. */
  line_key: string;
  source: "quote";
  basis: QuoteWorkOrderLineBasis;
  description: string;
  qty: number | null;
  unit: string | null;
  hours: number | null;
  rate: number | null;
  rate_unit: string | null;
  total: number | null;
  counted: boolean;
  flags: string[];
  /** True when any flag on the line asks the approver to look. */
  needs_review: boolean;
  /** What the quote's cost breakdown put against a line it is not certain is
   *  labour. Office-only, never counted. */
  quote_cost_ex?: number | null;
};

export type QuoteWorkOrderLines = {
  schema: typeof QUOTE_WORK_ORDER_LINES_SCHEMA;
  job_type: "fencing" | "patio" | "other";
  lines: QuoteWorkOrderLine[];
  /** The quote's own labour figure; null when the quote has none. */
  agreed_labour_ex: number | null;
  /** Line totals by group, counted or not (office breakdown). */
  totals: {
    install_labour_ex: number;
    removal_ex: number;
    extras_labour_ex: number;
    uncertain_cost_ex: number;
  };
  /** The quote's own labour figure (labourCostEstimate), for comparison. */
  quote_labour_ex: number | null;
  /** The counted lines reproduce the quote's labour figure. Null when they
   *  could not be compared (no labour figure, a rate missing or changed since
   *  the quote). */
  labour_matches_quote: boolean | null;
  needs_review: boolean;
  flags: string[];
};

// Line flags. Informational ones explain a line; the rest put it in review.
export const QUOTE_LINE_FLAGS = {
  savedAsMaterial: "saved_as_material",
  kindMissing: "kind_missing",
  labourOrMaterialUnknown: "labour_or_material_unknown",
  hoursInWords: "hours_in_words",
  hoursMissing: "hours_missing",
  costMissing: "cost_missing",
  rateMissing: "rate_missing",
  quoteCountedAsMaterials: "quote_counted_as_materials",
  licensedRemoval: "licensed_removal",
  ratesChangedSinceQuote: "rates_changed_since_quote",
  labourDiffersFromQuote: "labour_differs_from_quote",
  outsideQuoteLabour: "outside_quote_labour",
} as const;

export const QUOTE_RESULT_FLAGS = {
  noQuoteLines: "no_quote_lines",
  quoteLabourMissing: "quote_labour_missing",
  labourDiffersFromQuote: "labour_differs_from_quote",
  ratesChangedSinceQuote: "rates_changed_since_quote",
  unsupportedJobType: "unsupported_job_type",
} as const;

const INFORMATIONAL_LINE_FLAGS: ReadonlySet<string> = new Set([
  QUOTE_LINE_FLAGS.savedAsMaterial,
  QUOTE_LINE_FLAGS.quoteCountedAsMaterials,
]);

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function asObject(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

function positive(value: unknown): number | null {
  const n = typeof value === "string" && value.trim() !== ""
    ? Number(value)
    : value;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function isHoursUnit(unit: unknown): boolean {
  return /^(?:h|hr|hrs|hour|hours)$/i.test(text(unit));
}

const HOURS_IN_WORDS_RE = /\b\d+(?:\.\d+)?\s*(?:hours?|hrs?)\b/i;

function jobTypeOf(jobType: unknown): "fencing" | "patio" | "other" {
  const t = text(jobType).toLowerCase();
  return t === "fencing" || t === "patio" ? t : "other";
}

function costRate(table: QuoteCostTable | undefined, key: string) {
  return positive(table?.[key]);
}

function lineItems(pricing: Record<string, any>): Record<string, any>[] {
  return (Array.isArray(pricing.line_items) ? pricing.line_items : [])
    .map(asObject)
    .filter((row) => Object.keys(row).length > 0);
}

function category(row: Record<string, any>): string {
  return text(row.category).toLowerCase();
}

// ── Fencing install split (the fence tool's own labour formula) ─────────────
//
// labourCostEstimate = (metres x base-labour + plinths x plinth-install
//   + gates x gate labour) x (1 + access %). The access percent is read from
// the quote's own "Access surcharge (N%)" line, so it is the quote's rate.
// Measured 13 Oct 2026: this rebuild equals labourCostEstimate on all 140
// fencing quotes since 1 Aug 2026.

// The fence tool writes its run line as "16× Ridgeside (37.6m total)". The
// trade view withholds a whole line that carries a money word, and "total" is
// one, so the line is reworded; the metres ride in qty and unit.
export function fenceInstallDescription(quoted: string): string {
  const m = quoted.match(/^\s*(\d+)\s*[×x]\s*(.+?)\s*(?:\(.*\))?\s*$/i);
  if (m) {
    const panels = Number(m[1]);
    return `Install ${m[2]} fence (${panels} panel${panels === 1 ? "" : "s"})`;
  }
  const cleaned = quoted.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ")
    .trim();
  return cleaned ? `Install ${cleaned}` : "Install fence";
}

function fencingInstallLines(
  items: Record<string, any>[],
  table: QuoteCostTable | undefined,
  changed: ReadonlySet<string>,
): { lines: QuoteWorkOrderLine[]; complete: boolean; ratesChanged: boolean } {
  const lines: QuoteWorkOrderLine[] = [];
  let complete = true;
  let ratesChanged = false;
  const priced = (
    key: string,
    basis: QuoteWorkOrderLineBasis,
    description: string,
    qty: number,
    unit: string,
    rateKey: string,
    rateUnit: string,
  ) => {
    const rate = costRate(table, rateKey);
    const flags: string[] = [];
    if (rate === null) {
      complete = false;
      flags.push(QUOTE_LINE_FLAGS.rateMissing);
    } else if (changed.has(rateKey)) {
      ratesChanged = true;
      flags.push(QUOTE_LINE_FLAGS.ratesChangedSinceQuote);
    }
    lines.push({
      line_key: key,
      source: "quote",
      basis,
      description,
      qty,
      unit,
      hours: null,
      rate,
      rate_unit: rate === null ? null : rateUnit,
      total: rate === null ? null : round2(qty * rate),
      counted: false,
      flags,
      needs_review: false,
    });
  };

  items.forEach((row, i) => {
    if (category(row) !== "fencing") return;
    const metres = positive(row.quantity);
    if (metres === null) return;
    priced(
      `install:${i}`,
      "fence_install",
      fenceInstallDescription(text(row.description)),
      metres,
      "m",
      FENCE_LABOUR_COST_KEYS.installPerMetre,
      "m",
    );
  });

  const plinths = items
    .filter((row) =>
      category(row) === "materials" && /plinth/i.test(text(row.description))
    )
    .reduce((sum, row) => sum + (positive(row.quantity) ?? 0), 0);
  if (plinths > 0) {
    priced(
      "plinths",
      "fence_plinths",
      "Install retaining plinths",
      plinths,
      "ea",
      FENCE_LABOUR_COST_KEYS.plinthInstall,
      "ea",
    );
  }

  items.forEach((row, i) => {
    if (category(row) !== "gates") return;
    const qty = positive(row.quantity) ?? 1;
    const what = text(row.description) || "gate";
    const double = /double|sliding/i.test(what);
    priced(
      `gate:${i}`,
      "fence_gate",
      `Install ${what.charAt(0).toLowerCase()}${what.slice(1)}`,
      qty,
      "ea",
      double
        ? FENCE_LABOUR_COST_KEYS.gateDouble
        : FENCE_LABOUR_COST_KEYS.gatePedestrian,
      "ea",
    );
  });

  const subtotal = round2(
    lines.reduce((sum, line) => sum + (line.total ?? 0), 0),
  );
  const accessRow = items.find((row) =>
    category(row) === "surcharges" && /access/i.test(text(row.description))
  );
  const accessPct = accessRow
    ? positive(
      (text(accessRow.description).match(/\(\s*([\d.]+)\s*%\s*\)/) || [])[1],
    )
    : null;
  if (accessPct !== null && lines.length > 0) {
    const accessFlags = !complete
      ? [QUOTE_LINE_FLAGS.rateMissing]
      : ratesChanged
      ? [QUOTE_LINE_FLAGS.ratesChangedSinceQuote]
      : [];
    lines.push({
      line_key: "access",
      source: "quote",
      basis: "fence_access",
      description: accessPct >= 20
        ? "Difficult site access, extra time on the install"
        : "Moderate site access, extra time on the install",
      qty: 1,
      unit: "lot",
      hours: null,
      rate: accessPct,
      rate_unit: "pct",
      total: complete ? round2(subtotal * accessPct / 100) : null,
      counted: false,
      flags: accessFlags,
      needs_review: false,
    });
  }
  return { lines, complete, ratesChanged };
}

// ── Removal (the quote counts these under materials) ────────────────────────
//
// Never part of the quote's labour figure, so never counted.

function removalLines(
  items: Record<string, any>[],
  table: QuoteCostTable | undefined,
  changed: ReadonlySet<string>,
): QuoteWorkOrderLine[] {
  const out: QuoteWorkOrderLine[] = [];
  items.forEach((row, i) => {
    if (category(row) !== "removal") return;
    const what = text(row.description);
    // A licence certificate is a fee, not a task on site.
    if (/asbestos/i.test(what) && /certificate/i.test(what)) return;
    let rateKey: string | null = null;
    const flags: string[] = [QUOTE_LINE_FLAGS.quoteCountedAsMaterials];
    if (/asbestos/i.test(what)) {
      rateKey = FENCE_LABOUR_COST_KEYS.removeAsbestos;
      flags.push(QUOTE_LINE_FLAGS.licensedRemoval);
    } else if (/hardie|super\s*6/i.test(what)) {
      rateKey = FENCE_LABOUR_COST_KEYS.removeHardie;
    } else if (/timber|lap/i.test(what)) {
      rateKey = FENCE_LABOUR_COST_KEYS.removeTimber;
    } else if (/colou?rbond/i.test(what)) {
      rateKey = FENCE_LABOUR_COST_KEYS.removeColorbond;
    } else if (/vegetation|site clear/i.test(what)) {
      rateKey = FENCE_LABOUR_COST_KEYS.vegetationClear;
    }
    const qty = positive(row.quantity) ?? 1;
    const unit = text(row.unit) || "lot";
    const rate = rateKey ? costRate(table, rateKey) : null;
    if (rate === null) flags.push(QUOTE_LINE_FLAGS.rateMissing);
    else if (changed.has(rateKey!)) {
      flags.push(QUOTE_LINE_FLAGS.ratesChangedSinceQuote);
    }
    out.push({
      line_key: `removal:${i}`,
      source: "quote",
      basis: "removal",
      description: what || "Removal",
      qty,
      unit,
      hours: null,
      rate,
      rate_unit: rate === null ? null : unit,
      total: rate === null ? null : round2(qty * rate),
      counted: false,
      flags,
      needs_review: false,
    });
  });
  return out;
}

// ── Labour lines and custom extras ──────────────────────────────────────────
//
// Shapes read, oldest first:
// - fence tool custom line: {category:'custom', kind:'material'|'labour',
//   quantity, unit ('hrs','job','m',...), cost_price (per unit), description}
// - patio labour line: {category:'labour', unit:'hrs', quantity (hours),
//   cost_price (per hour), description 'Labour — 2 trades × 1.5 days'}
// - labour lines that carry their own hours and cost per hour (the quoting
//   tools' new shape): {kind:'labour', hours, cost_per_hour} alongside
//   quantity, unit and cost_price.

function labourLine(
  row: Record<string, any>,
  key: string,
  basis: QuoteWorkOrderLineBasis,
  description: string,
  extraFlags: string[],
): QuoteWorkOrderLine {
  const flags = [...extraFlags];
  const qty = positive(row.quantity ?? row.qty);
  const unit = text(row.unit) || null;
  const explicitHours = positive(row.hours);
  const hours = explicitHours ?? (isHoursUnit(unit) ? qty : null);
  const costPerHour = positive(row.cost_per_hour);
  const costPerUnit = positive(row.cost_price);

  let rate: number | null = null;
  let rateUnit: string | null = null;
  let total: number | null = null;
  // cost_price is per quoted unit, so it multiplies the quoted quantity (the
  // hours, when the unit is hours).
  const perUnitBase = isHoursUnit(unit) ? hours : qty;
  if (hours !== null && costPerHour !== null) {
    rate = costPerHour;
    rateUnit = "hr";
    total = round2(hours * costPerHour);
  } else if (costPerUnit !== null && perUnitBase !== null) {
    rate = costPerUnit;
    rateUnit = isHoursUnit(unit) ? "hr" : unit;
    total = round2(perUnitBase * costPerUnit);
  }
  if (
    hours === null &&
    !/^(?:m|lm|ea|each|m2|sqm|sheet|sheets)$/i.test(unit || "")
  ) {
    flags.push(QUOTE_LINE_FLAGS.hoursMissing);
  }
  if (total === null) flags.push(QUOTE_LINE_FLAGS.costMissing);
  return {
    line_key: key,
    source: "quote",
    basis,
    description,
    // Hours ride as qty with unit hrs, so the trade view (description, qty,
    // unit) shows the time on every line priced by the hour.
    qty: hours !== null ? hours : qty,
    unit: hours !== null ? "hrs" : unit,
    hours,
    rate,
    rate_unit: rateUnit,
    total,
    counted: false,
    flags,
    needs_review: false,
  };
}

function uncertainExtra(
  row: Record<string, any>,
  key: string,
  description: string,
  extraFlags: string[],
): QuoteWorkOrderLine {
  const flags = [...extraFlags, QUOTE_LINE_FLAGS.labourOrMaterialUnknown];
  if (HOURS_IN_WORDS_RE.test(description)) {
    flags.push(QUOTE_LINE_FLAGS.hoursInWords);
  }
  const qty = positive(row.quantity ?? row.qty);
  const cost = positive(row.cost_price);
  return {
    line_key: key,
    source: "quote",
    basis: "quote_extra",
    description,
    qty,
    unit: text(row.unit) || null,
    hours: null,
    rate: null,
    rate_unit: null,
    total: null,
    counted: false,
    flags,
    needs_review: false,
    quote_cost_ex: cost !== null && qty !== null ? round2(qty * cost) : null,
  };
}

function extraLines(items: Record<string, any>[]): QuoteWorkOrderLine[] {
  const out: QuoteWorkOrderLine[] = [];
  items.forEach((row, i) => {
    const cat = category(row);
    const kind = text(row.kind).toLowerCase();
    const description = text(row.description);
    if (!description) return;
    const hasHours = isHoursUnit(row.unit) ||
      positive(row.hours) !== null;
    if (cat === "labour" || kind === "labour") {
      out.push(
        labourLine(row, `labour:${i}`, "quote_labour_line", description, []),
      );
      return;
    }
    if (cat !== "custom") return;
    if (hasHours) {
      out.push(labourLine(
        row,
        `extra:${i}`,
        "quote_labour_line",
        description,
        [
          kind === "material"
            ? QUOTE_LINE_FLAGS.savedAsMaterial
            : QUOTE_LINE_FLAGS.kindMissing,
        ],
      ));
      return;
    }
    out.push(uncertainExtra(
      row,
      `extra:${i}`,
      description,
      kind === "material" ? [] : [QUOTE_LINE_FLAGS.kindMissing],
    ));
  });
  return out;
}

// ── The builder ─────────────────────────────────────────────────────────────

export function buildQuoteWorkOrderLines(input: {
  jobType: unknown;
  pricing: unknown;
  costTable?: QuoteCostTable;
  /** Cost table item keys changed since the quote was frozen (or whose
   *  change time is unknown): lines priced from them cannot reproduce the
   *  quote. */
  ratesChangedSinceQuote?: readonly string[];
}): QuoteWorkOrderLines {
  const jobType = jobTypeOf(input.jobType);
  const pricing = asObject(input.pricing);
  const items = lineItems(pricing);
  const changed = new Set(input.ratesChangedSinceQuote ?? []);
  const flags: string[] = [];
  const quoteLabour = positive(pricing.labourCostEstimate) ??
    positive(asObject(pricing.internal).labour);

  // The base lines are the ones the quote's labour figure is built from:
  // the fencing install split, or the patio quote's labour rows.
  let base: QuoteWorkOrderLine[] = [];
  let baseComparable = true;
  let installLines: QuoteWorkOrderLine[] = [];
  let removal: QuoteWorkOrderLine[] = [];
  if (jobType === "fencing") {
    const install = fencingInstallLines(items, input.costTable, changed);
    installLines = install.lines;
    base = installLines;
    baseComparable = install.complete && !install.ratesChanged;
    removal = removalLines(items, input.costTable, changed);
  } else if (jobType === "other") {
    flags.push(QUOTE_RESULT_FLAGS.unsupportedJobType);
  }

  const extras = extraLines(items);
  if (jobType === "patio") {
    const labourRowKeys = new Set(
      items.flatMap((row, i) =>
        category(row) === "labour" ? [`labour:${i}`] : []
      ),
    );
    base = extras.filter((l) => labourRowKeys.has(l.line_key));
  }
  const extraLabour = extras.filter((l) =>
    l.basis === "quote_labour_line" && !base.includes(l)
  );

  const lines = [...installLines, ...removal, ...extras];
  if (lines.length === 0) flags.push(QUOTE_RESULT_FLAGS.noQuoteLines);

  const sum = (ls: QuoteWorkOrderLine[]) =>
    round2(ls.reduce((s, l) => s + (l.total ?? 0), 0));
  const near = (a: number, b: number) => Math.abs(round2(a) - round2(b)) <= 0.5;

  let counted: QuoteWorkOrderLine[] = [];
  let labourMatches: boolean | null = null;
  if (jobType !== "other" && lines.length > 0) {
    if (quoteLabour === null) {
      flags.push(QUOTE_RESULT_FLAGS.quoteLabourMissing);
    } else if (baseComparable) {
      const pricedExtras = extraLabour.filter((l) => l.total !== null);
      if (near(sum(base), quoteLabour)) {
        counted = base;
        labourMatches = true;
      } else if (
        pricedExtras.length > 0 &&
        near(sum(base) + sum(pricedExtras), quoteLabour)
      ) {
        // The quoting tools' new shape: custom labour lines are part of the
        // quote's labour figure.
        counted = [...base, ...pricedExtras];
        labourMatches = true;
      } else {
        labourMatches = false;
        flags.push(QUOTE_RESULT_FLAGS.labourDiffersFromQuote);
        for (const line of [...base, ...removal]) {
          line.flags.push(QUOTE_LINE_FLAGS.labourDiffersFromQuote);
        }
      }
    }
    for (const line of extraLabour) {
      if (!counted.includes(line)) {
        line.flags.push(QUOTE_LINE_FLAGS.outsideQuoteLabour);
      }
    }
  }
  if (
    lines.some((l) => l.flags.includes(QUOTE_LINE_FLAGS.ratesChangedSinceQuote))
  ) {
    flags.push(QUOTE_RESULT_FLAGS.ratesChangedSinceQuote);
  }
  for (const line of lines) {
    line.counted = counted.includes(line);
    line.needs_review = line.flags.some((f) =>
      !INFORMATIONAL_LINE_FLAGS.has(f)
    );
  }

  const totalOf = (pick: (l: QuoteWorkOrderLine) => boolean) =>
    sum(lines.filter(pick));

  return {
    schema: QUOTE_WORK_ORDER_LINES_SCHEMA,
    job_type: jobType,
    lines,
    agreed_labour_ex: quoteLabour,
    totals: {
      install_labour_ex: totalOf((l) => l.basis.startsWith("fence_")),
      removal_ex: totalOf((l) => l.basis === "removal"),
      extras_labour_ex: totalOf((l) => l.basis === "quote_labour_line"),
      uncertain_cost_ex: round2(
        lines.reduce((s, l) => s + (l.quote_cost_ex ?? 0), 0),
      ),
    },
    quote_labour_ex: quoteLabour,
    labour_matches_quote: labourMatches,
    needs_review: flags.length > 0 || lines.some((l) => l.needs_review),
    flags,
  };
}
