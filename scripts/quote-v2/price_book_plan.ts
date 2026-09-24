// Quote v2, stage 1: turn observations from the ten price stores into the
// price book rows to load, plus the diff report. Pure: no file, database or
// network access (the CLI in price_book_import.ts does the IO).
//
// Loading rules:
// * Only COST observations become cost rows, and only when above $0. A $0
//   sentinel creates the item with no cost, so it reads `unpriced`.
// * Legacy sell rates, dead-store rows, compound invoice lines and one-off job
//   lines are reported, never loaded. Nothing is back-computed from a sell.
// * Every loaded row is PROVISIONAL. A source's own "blessed" comment is
//   reported, not trusted: blessing happens only through a proposal decision.
// * Rows carry an import fingerprint, so re-running the import adds nothing.

import {
  type CanonicalItem,
  type CutRule,
  resolveObservation,
  steelCutRule,
} from "./price_book_catalog.ts";
import type { EvidenceKind, Observation, StoreId } from "./price_book_sources.ts";

export const IMPORT_VERSION = "quote-v2-price-book-import/v2";

export interface CostRow {
  item_key: string;
  supplier: string;
  supplier_code: string | null;
  cost_ex_gst: number;
  per_length_mm: number | null;
  as_at: string;
  evidence_kind: EvidenceKind;
  evidence_ref: string;
  evidence_note: string | null;
  fingerprint: string;
  store: StoreId;
}

export interface StockRow {
  item_key: string;
  supplier: string;
  lengths_mm: number[];
  as_at: string;
  evidence_ref: string;
  fingerprint: string;
}

export interface CutRow {
  item_key: string;
  rule: CutRule;
  as_at: string;
  evidence_ref: string;
  evidence_note: string;
  fingerprint: string;
}

export interface AllowanceRow {
  family: "patio";
  allowance_key: string;
  description: string;
  basis: "per_lm" | "per_lm_by_girth_band" | "per_m2" | "per_m2_of_girth";
  girth_min_mm: number | null;
  girth_max_mm: number | null;
  cost_ex_gst: number;
  as_at: string;
  evidence_kind: EvidenceKind;
  evidence_ref: string;
  evidence_note: string | null;
  fingerprint: string;
}

export interface DiffEntry {
  item_key: string;
  description: string;
  unit: string;
  reconciled: boolean;
  observations: {
    store: StoreId;
    value: number | null;
    as_at: string | null;
    evidence_kind: EvidenceKind;
    evidence_ref: string;
    supplier: string;
    conversion?: string;
    claimed_blessed?: string;
    staged?: boolean;
  }[];
}

export interface ImportPlan {
  items: CanonicalItem[];
  costs: CostRow[];
  stock: StockRow[];
  cuts: CutRow[];
  allowances: AllowanceRow[];
  diff: DiffEntry[];
  legacySell: Observation[];
  markups: Observation[];
  excluded: Observation[];
  unresolved: { observation: Observation; reason: string }[];
  zeroSentinels: { item_key: string; store: StoreId; source_key: string }[];
}

/** Stable identity of one observation, so the import is idempotent. */
export function fingerprint(parts: (string | number | null | undefined)[]): string {
  return `${IMPORT_VERSION}|${parts.map((p) => p ?? "").join("|")}`;
}

const GIRTH_BANDS: [number, number][] = [[0, 100], [101, 150], [151, 200], [201, 300], [301, 400]];

const ENGINE_ALLOWANCES: Record<string, { key: string; basis: AllowanceRow["basis"]; description: string }> = {
  "flashing-girth:standard": {
    key: "flashing-standard",
    basis: "per_m2_of_girth",
    description: "Flashing, standard: girth (m) x length (m) x rate",
  },
  "flashing-girth:solarspan": {
    key: "flashing-solarspan",
    basis: "per_m2_of_girth",
    description: "Flashing, Solarspan: girth (m) x length (m) x rate",
  },
  "fixings": { key: "fixings", basis: "per_m2", description: "Fixings per m2 of roof" },
};

const SEED_ALLOWANCES: Record<string, string> = {
  "patio-tool:flashing:flashing-standard": "flashing-girth:standard",
  "patio-tool:flashing:flashing-solarspan": "flashing-girth:solarspan",
  "patio-tool:fixings:fixings-per-sqm": "fixings",
};

export function buildPlan(observations: Observation[]): ImportPlan {
  const items = new Map<string, CanonicalItem>();
  const costs = new Map<string, CostRow>();
  const stock = new Map<string, StockRow>();
  const cuts = new Map<string, CutRow>();
  const allowances: AllowanceRow[] = [];
  const diff = new Map<string, DiffEntry>();
  const plan: ImportPlan = {
    items: [],
    costs: [],
    stock: [],
    cuts: [],
    allowances,
    diff: [],
    legacySell: [],
    markups: [],
    excluded: [],
    unresolved: [],
    zeroSentinels: [],
  };

  const addItem = (item: CanonicalItem) => {
    const prior = items.get(item.item_key);
    if (!prior || (!prior.reconciled && item.reconciled)) items.set(item.item_key, item);
  };
  const addCut = (itemKey: string, rule: CutRule, o: Observation, note: string) => {
    const fp = fingerprint(["cut", itemKey, rule, o.evidence_ref]);
    if (!cuts.has(itemKey)) {
      cuts.set(itemKey, {
        item_key: itemKey,
        rule,
        as_at: o.as_at ?? "2026-09-24",
        evidence_ref: o.evidence_ref,
        evidence_note: note,
        fingerprint: fp,
      });
    }
  };

  for (const o of observations) {
    if (o.kind === "legacy_sell") {
      plan.legacySell.push(o);
      continue;
    }
    if (o.kind === "markup") {
      plan.markups.push(o);
      continue;
    }
    if (o.kind === "not_a_price" || o.excluded_reason) {
      plan.excluded.push(o);
      continue;
    }
    // Fixings and girth-based flashing rates are job allowances, not items.
    const allowanceKey = o.store === "s07_patio_engine_snapshot"
      ? o.source_key
      : o.store === "s04_fence_parity_seed_sql"
      ? SEED_ALLOWANCES[o.source_key]
      : o.store === "s05_patio_hardcoded" && o.source_key === "DEFAULT_RATES.Fixings ($/sqm)"
      ? "fixings"
      : undefined;
    if (allowanceKey && ENGINE_ALLOWANCES[allowanceKey]) {
      const a = ENGINE_ALLOWANCES[allowanceKey];
      if (!o.value) {
        plan.zeroSentinels.push({ item_key: `allowance:${a.key}`, store: o.store, source_key: o.source_key });
        continue;
      }
      if (o.value && o.value > 0 && o.as_at) {
        allowances.push({
          family: "patio",
          allowance_key: a.key,
          description: a.description,
          basis: a.basis,
          girth_min_mm: null,
          girth_max_mm: null,
          cost_ex_gst: o.value,
          as_at: o.as_at,
          evidence_kind: o.evidence_kind,
          evidence_ref: o.evidence_ref,
          evidence_note: o.note ?? null,
          fingerprint: fingerprint([
            "allowance",
            a.key,
            a.basis,
            null,
            null,
            o.value,
            o.as_at,
            o.evidence_kind,
            o.evidence_ref,
          ]),
        });
      }
      continue;
    }

    const r = resolveObservation(o);
    if ("unresolved" in r) {
      plan.unresolved.push({ observation: o, reason: r.unresolved });
      continue;
    }
    addItem(r.item);

    if (o.kind === "stock_lengths") {
      if (o.stock_lengths_mm?.length) {
        const stockAsAt = o.as_at ?? "2026-09-24";
        const fp = fingerprint([
          "stock",
          r.item.item_key,
          o.supplier,
          o.stock_lengths_mm.join(","),
          stockAsAt,
          "tool_constant",
          o.evidence_ref,
        ]);
        stock.set(fp, {
          item_key: r.item.item_key,
          supplier: o.supplier,
          lengths_mm: o.stock_lengths_mm,
          as_at: stockAsAt,
          evidence_ref: o.evidence_ref,
          fingerprint: fp,
        });
        const rule = r.item.category === "steel" ? steelCutRule(r.item.item_key) : "nest";
        addCut(r.item.item_key, rule, o, rule === "one_per_stick"
          ? "posts and beams: one piece per stick (patio nestCuts use)"
          : "several pieces nest per stick (patio nestCuts use)");
      } else if (o.note === "cut_to_size") {
        addCut(r.item.item_key, "cut_to_size", o, "the supplier cuts to length (patio STOCK_LENGTH_WASTE_CONFIG)");
      }
      continue;
    }

    // cost
    const entry = diff.get(r.item.item_key) ?? {
      item_key: r.item.item_key,
      description: r.item.description,
      unit: r.item.unit,
      reconciled: r.item.reconciled,
      observations: [],
    };
    entry.observations.push({
      store: o.store,
      value: r.value,
      as_at: o.as_at,
      evidence_kind: o.evidence_kind,
      evidence_ref: o.evidence_ref,
      supplier: o.supplier,
      conversion: r.conversion,
      claimed_blessed: o.claimed_blessed,
      staged: o.staged_for_blessing,
    });
    diff.set(r.item.item_key, entry);

    if (r.value == null) {
      plan.zeroSentinels.push({ item_key: r.item.item_key, store: o.store, source_key: o.source_key });
      continue;
    }
    if (!o.as_at) {
      plan.unresolved.push({ observation: o, reason: "no as-at date" });
      continue;
    }
    const notes = [
      r.conversion,
      o.note,
      o.claimed_blessed ? `source comment claims blessed ${o.claimed_blessed}; loaded provisional` : null,
      o.staged_for_blessing ? "source marks this staged for blessing" : null,
    ].filter(Boolean).join("; ");
    const fp = fingerprint([
      "cost",
      r.item.item_key,
      o.supplier,
      r.value,
      r.per_length_mm ?? null,
      o.as_at,
      o.evidence_kind,
      o.evidence_ref,
    ]);
    costs.set(fp, {
      item_key: r.item.item_key,
      supplier: o.supplier,
      supplier_code: o.supplier_code ?? null,
      cost_ex_gst: r.value,
      per_length_mm: r.per_length_mm ?? null,
      as_at: o.as_at,
      evidence_kind: o.evidence_kind,
      evidence_ref: o.evidence_ref,
      evidence_note: notes || null,
      fingerprint: fp,
      store: o.store,
    });

    // Stratco estimate rows carry their stock length and whether Stratco
    // cuts to size.
    if (o.family === "stratco" && o.stock_lengths_mm?.length) {
      const sfp = fingerprint([
        "stock",
        r.item.item_key,
        o.supplier,
        o.stock_lengths_mm.join(","),
        o.as_at,
        "tool_constant",
        o.evidence_ref,
      ]);
      stock.set(sfp, {
        item_key: r.item.item_key,
        supplier: o.supplier,
        lengths_mm: o.stock_lengths_mm,
        as_at: o.as_at,
        evidence_ref: o.evidence_ref,
        fingerprint: sfp,
      });
    }
    if (o.family === "stratco") {
      const cutToSize = /cut to size/i.test(o.description);
      addCut(r.item.item_key, cutToSize ? "cut_to_size" : "nest", o, cutToSize
        ? "Stratco cuts to size (no waste, higher rate)"
        : "stock bars, several pieces nest per bar");
    }
  }

  // Flashing girth bands: the mean of the newest cost per girth item and
  // supplier inside each band. The tool's $10.50/LM family average stays as
  // the fallback when the girth is unknown.
  const flashing = [...costs.values()].filter((c) => c.item_key.startsWith("flashing-girth-"));
  const newest = new Map<string, CostRow>();
  for (const c of flashing) {
    const k = `${c.item_key}|${c.supplier}`;
    const prior = newest.get(k);
    if (!prior || prior.as_at < c.as_at) newest.set(k, c);
  }
  for (const [lo, hi] of GIRTH_BANDS) {
    const inBand = [...newest.values()].filter((c) => {
      const g = Number(c.item_key.match(/^flashing-girth-(\d+)-/)?.[1]);
      return g >= lo && g <= hi;
    });
    if (!inBand.length) continue;
    const mean = Math.round(
      (inBand.reduce((a, c) => a + c.cost_ex_gst, 0) / inBand.length) * 10000,
    ) / 10000;
    const asAt = inBand.map((c) => c.as_at).sort().at(-1)!;
    const refs = inBand.map((c) => `${c.item_key} ${c.supplier} $${c.cost_ex_gst.toFixed(2)}`).join("; ");
    allowances.push({
      family: "patio",
      allowance_key: "flashing",
      description: `Flashing per metre, girth ${lo} to ${hi} mm`,
      basis: "per_lm_by_girth_band",
      girth_min_mm: lo,
      girth_max_mm: hi,
      cost_ex_gst: mean,
      as_at: asAt,
      evidence_kind: "invoice",
      evidence_ref: `mean of ${inBand.length} newest invoice/order rates in band`,
      evidence_note: refs,
      fingerprint: fingerprint([
        "allowance",
        "flashing-band",
        "per_lm_by_girth_band",
        lo,
        hi,
        mean,
        asAt,
        "invoice",
        refs,
      ]),
    });
  }
  const familyAverage = observations.find((o) =>
    o.store === "s05_patio_hardcoded" && o.source_key === "DEFAULT_RATES.Ridge Cap" && (o.value ?? 0) > 0
  );
  if (familyAverage?.as_at && familyAverage.value) {
    allowances.push({
      family: "patio",
      allowance_key: "flashing-unknown-girth",
      description: "Flashing per metre when the girth is not known (family average)",
      basis: "per_lm",
      girth_min_mm: null,
      girth_max_mm: null,
      cost_ex_gst: familyAverage.value,
      as_at: familyAverage.as_at,
      evidence_kind: "tool_constant",
      evidence_ref: familyAverage.evidence_ref,
      evidence_note: "family average of 13 invoice lines across 3 suppliers (patio PR 102, 13 Jun)",
      fingerprint: fingerprint([
        "allowance",
        "flashing-unknown-girth",
        "per_lm",
        null,
        null,
        familyAverage.value,
        familyAverage.as_at,
        familyAverage.evidence_kind,
        familyAverage.evidence_ref,
      ]),
    });
  }

  // Every row's item must exist.
  for (const row of [...costs.values(), ...stock.values(), ...cuts.values()]) {
    if (!items.has(row.item_key)) throw new Error(`plan: row for unknown item ${row.item_key}`);
  }

  plan.items = [...items.values()].sort((a, b) => a.item_key.localeCompare(b.item_key));
  plan.costs = [...costs.values()];
  plan.stock = [...stock.values()];
  plan.cuts = [...cuts.values()];
  plan.diff = [...diff.values()].sort((a, b) => a.item_key.localeCompare(b.item_key));
  return plan;
}

// ── SQL ─────────────────────────────────────────────────────────────────

function lit(v: string | number | null | undefined): string {
  if (v == null) return "NULL";
  if (typeof v === "number") return String(v);
  return `'${v.replace(/'/g, "''")}'`;
}

/** Idempotent SQL for the plan. Every row is provisional. */
export function planSql(plan: ImportPlan, recordedBy = IMPORT_VERSION): string {
  const out: string[] = [
    `-- ${IMPORT_VERSION}: generated, provisional rows only. LOCAL DATABASES ONLY.`,
    "BEGIN;",
  ];
  for (const i of plan.items) {
    out.push(
      `INSERT INTO public.price_book_items (item_key, family, category, description, unit, note, created_by, import_fingerprint) VALUES (${
        [i.item_key, i.family, i.category, i.description, i.unit,
          i.reconciled ? null : "imported as-is; not reconciled with other sources",
          recordedBy, `${IMPORT_VERSION}|item|${i.item_key}`].map(lit).join(", ")
      }) ON CONFLICT DO NOTHING;`,
    );
  }
  for (const c of plan.costs) {
    out.push(
      `INSERT INTO public.price_book_costs (item_key, supplier, supplier_code, cost_ex_gst, per_length_mm, as_at, evidence_kind, evidence_ref, evidence_note, recorded_by, import_fingerprint) VALUES (${
        [c.item_key, c.supplier, c.supplier_code, c.cost_ex_gst, c.per_length_mm, c.as_at, c.evidence_kind,
          c.evidence_ref, c.evidence_note, recordedBy, c.fingerprint].map(lit).join(", ")
      }) ON CONFLICT (import_fingerprint) DO NOTHING;`,
    );
  }
  for (const s of plan.stock) {
    out.push(
      `INSERT INTO public.price_book_stock_lengths (item_key, supplier, lengths_mm, as_at, evidence_kind, evidence_ref, recorded_by, import_fingerprint) VALUES (${
        [s.item_key, s.supplier].map(lit).join(", ")
      }, ARRAY[${s.lengths_mm.join(",")}]::integer[], ${
        [s.as_at, "tool_constant", s.evidence_ref, recordedBy, s.fingerprint].map(lit).join(", ")
      }) ON CONFLICT (import_fingerprint) DO NOTHING;`,
    );
  }
  for (const c of plan.cuts) {
    out.push(
      `INSERT INTO public.price_book_cut_rules (item_key, rule, as_at, evidence_kind, evidence_ref, evidence_note, recorded_by, import_fingerprint) VALUES (${
        [c.item_key, c.rule, c.as_at, "tool_constant", c.evidence_ref, c.evidence_note, recordedBy, c.fingerprint]
          .map(lit).join(", ")
      }) ON CONFLICT (import_fingerprint) DO NOTHING;`,
    );
  }
  for (const a of plan.allowances) {
    out.push(
      `INSERT INTO public.price_book_allowances (family, allowance_key, description, basis, girth_min_mm, girth_max_mm, cost_ex_gst, as_at, evidence_kind, evidence_ref, evidence_note, recorded_by, import_fingerprint) VALUES (${
        [a.family, a.allowance_key, a.description, a.basis, a.girth_min_mm, a.girth_max_mm,
          a.cost_ex_gst, a.as_at, a.evidence_kind, a.evidence_ref, a.evidence_note, recordedBy,
          a.fingerprint].map(lit).join(", ")
      }) ON CONFLICT (import_fingerprint) DO NOTHING;`,
    );
  }
  out.push("COMMIT;", "");
  return out.join("\n");
}

// ── diff report ─────────────────────────────────────────────────────────

const STORE_LABEL: Record<StoreId, string> = {
  s01_fence_cost_prices: "1 fence COST_PRICES",
  s02_fence_sell_defaults: "2 fence sell defaults",
  s03_fence_business_rules_dead: "3 fence business_rules.js (dead)",
  s04_fence_parity_seed_sql: "4 fence parity seed SQL",
  s05_patio_hardcoded: "5 patio hardcoded tables",
  s06_patio_device_cache: "6 patio per-device cache",
  s07_patio_engine_snapshot: "7 patio engine snapshot (unused)",
  s08_scope_tool_defaults: "8 scope_tool_defaults (repo seed)",
  s09_material_price_ledger: "9 material_price_ledger (live)",
  s10_wiki_supplier_csv: "10 wiki supplier CSVs",
};

const TOOL_STORES = new Set<StoreId>([
  "s01_fence_cost_prices",
  "s04_fence_parity_seed_sql",
  "s05_patio_hardcoded",
  "s07_patio_engine_snapshot",
  "s08_scope_tool_defaults",
]);

const LIVE_TOOL_STORES = new Set<StoreId>(["s01_fence_cost_prices", "s05_patio_hardcoded"]);

const money = (v: number | null) => (v == null ? "$0 / none" : `$${v.toFixed(2)}`);

export interface DiffSummary {
  items: number;
  reconciled_multi_source: number;
  tool_vs_evidence_compared: number;
  tool_vs_evidence_over_5pct: number;
  tool_only: number;
  evidence_only: number;
  unpriced_items: number;
  zero_sentinels: number;
  legacy_sell_rates: number;
  excluded_rows: number;
  cost_rows: number;
  stock_rows: number;
  cut_rows: number;
  allowance_rows: number;
  claimed_blessed_not_trusted: number;
}

export interface ItemComparison {
  entry: DiffEntry;
  tool: DiffEntry["observations"];
  evidence: DiffEntry["observations"];
  latestEvidence: DiffEntry["observations"][number] | null;
  toolLatest: DiffEntry["observations"][number] | null;
  deltaPct: number | null;
}

export function compare(entry: DiffEntry): ItemComparison {
  const priced = entry.observations.filter((o) => o.value != null);
  const tool = entry.observations.filter((o) => TOOL_STORES.has(o.store));
  const evidence = priced.filter((o) => o.store === "s10_wiki_supplier_csv" || o.store === "s09_material_price_ledger");
  const latestEvidence = [...evidence].sort((a, b) => (b.as_at ?? "").localeCompare(a.as_at ?? ""))[0] ?? null;
  // Compare what the live tools use today (fence COST_PRICES, patio tables)
  // first; seeds and the unused engine only when no live tool prices it.
  const toolPriced = tool.filter((o) => o.value != null);
  const live = toolPriced.filter((o) => LIVE_TOOL_STORES.has(o.store));
  const toolLatest = [...(live.length ? live : toolPriced)]
    .sort((a, b) => (b.as_at ?? "").localeCompare(a.as_at ?? ""))[0] ?? null;
  const deltaPct = latestEvidence && toolLatest
    ? Math.round(((toolLatest.value! - latestEvidence.value!) / latestEvidence.value!) * 1000) / 10
    : null;
  return { entry, tool, evidence, latestEvidence, toolLatest, deltaPct };
}

export function summarise(plan: ImportPlan): DiffSummary {
  const comparisons = plan.diff.map(compare);
  const pricedKeys = new Set(plan.costs.map((c) => c.item_key));
  return {
    items: plan.items.length,
    reconciled_multi_source: plan.diff.filter((d) => d.reconciled && new Set(d.observations.map((o) => o.store)).size > 1).length,
    tool_vs_evidence_compared: comparisons.filter((c) => c.deltaPct != null).length,
    tool_vs_evidence_over_5pct: comparisons.filter((c) => c.deltaPct != null && Math.abs(c.deltaPct) > 5).length,
    tool_only: comparisons.filter((c) => c.toolLatest && !c.latestEvidence).length,
    evidence_only: comparisons.filter((c) => c.latestEvidence && !c.tool.length).length,
    unpriced_items: plan.items.filter((i) => !pricedKeys.has(i.item_key)).length,
    zero_sentinels: plan.zeroSentinels.length,
    legacy_sell_rates: plan.legacySell.length,
    excluded_rows: plan.excluded.length,
    cost_rows: plan.costs.length,
    stock_rows: plan.stock.length,
    cut_rows: plan.cuts.length,
    allowance_rows: plan.allowances.length,
    claimed_blessed_not_trusted: plan.diff.flatMap((d) => d.observations).filter((o) => o.claimed_blessed).length,
  };
}

export function renderDiff(
  plan: ImportPlan,
  meta: { generatedAt: string; refs: Record<string, string>; notObserved: string[] },
): string {
  const s = summarise(plan);
  const comparisons = plan.diff.map(compare);
  const lines: string[] = [];
  lines.push("# Price book import: diff report (quote v2, stage 1)", "");
  lines.push(`Generated ${meta.generatedAt} by \`scripts/quote-v2/price_book_import.ts\` (${IMPORT_VERSION}), dry run.`);
  lines.push(`Sources read at: ${Object.entries(meta.refs).map(([k, v]) => `${k} \`${v}\``).join(", ")}.`, "");
  lines.push("All loaded rows are **cost to us, ex GST, provisional**. Sell rates are listed separately and never loaded as costs; no cost is back-computed from a sell rate.", "");
  lines.push("## Counts", "");
  lines.push("| Measure | Count |", "|---|---:|");
  const label: Record<keyof DiffSummary, string> = {
    items: "Price book items",
    reconciled_multi_source: "Items with prices from more than one store",
    tool_vs_evidence_compared: "Items where a tool constant can be compared with invoice or supplier evidence",
    tool_vs_evidence_over_5pct: "...of those, tool differs from latest evidence by more than 5%",
    tool_only: "Items priced only by a tool constant (no invoice evidence)",
    evidence_only: "Items priced only by invoice or supplier evidence",
    unpriced_items: "Items with no cost at all (read as unpriced)",
    zero_sentinels: "$0 sentinel values found (never loaded)",
    legacy_sell_rates: "Legacy sell rates (reported, not loaded)",
    excluded_rows: "Rows excluded (dead store, compound line, one-off, not a price)",
    cost_rows: "Cost rows to load",
    stock_rows: "Stock length rows to load",
    cut_rows: "Cut rule rows to load",
    allowance_rows: "Allowance rows to load",
    claimed_blessed_not_trusted: "Values a tool comment calls blessed (loaded provisional)",
  };
  for (const [k, v] of Object.entries(s)) lines.push(`| ${label[k as keyof DiffSummary]} | ${v} |`);
  lines.push("");
  if (meta.notObserved.length) {
    lines.push("## Stores not observed", "");
    for (const n of meta.notObserved) lines.push(`- ${n}`);
    lines.push("");
  }

  lines.push("## Tool constant vs wiki CSV vs latest invoice evidence", "");
  lines.push("Sorted by the size of the gap. Delta is (tool minus latest evidence) / latest evidence, where tool is the value the live fence or patio tool uses today (store 1 or 5), else the newest seed or engine value. Store numbers: 1 fence COST_PRICES, 4 parity seed, 5 patio tables, 7 patio engine, 8 repo seed.", "");
  lines.push("| Item | Unit | Tool constants | Wiki CSV rows | Latest evidence | Delta |", "|---|---|---|---|---|---:|");
  const withBoth = comparisons.filter((c) => c.deltaPct != null)
    .sort((a, b) => Math.abs(b.deltaPct!) - Math.abs(a.deltaPct!));
  for (const c of withBoth) {
    const toolCell = c.tool.map((o) => `${STORE_LABEL[o.store].split(" ")[0]}: ${money(o.value)}`).join("<br>");
    const csv = c.evidence.filter((o) => o.store === "s10_wiki_supplier_csv");
    const csvCell = csv.length
      ? `${csv.length} rows, ${money(Math.min(...csv.map((o) => o.value!)))} to ${money(Math.max(...csv.map((o) => o.value!)))}`
      : "none";
    const le = c.latestEvidence!;
    lines.push(`| \`${c.entry.item_key}\` | ${c.entry.unit} | ${toolCell} | ${csvCell} | ${money(le.value)} ${le.as_at} ${le.supplier}${le.conversion ? ` (${le.conversion})` : ""} | ${c.deltaPct! > 0 ? "+" : ""}${c.deltaPct}% |`);
  }
  lines.push("");

  lines.push("## Priced only by a tool constant (no invoice evidence on file)", "");
  lines.push("| Item | Unit | Tool values | Note |", "|---|---|---|---|");
  for (const c of comparisons.filter((c) => c.toolLatest && !c.latestEvidence)) {
    const blessed = c.tool.find((o) => o.claimed_blessed)?.claimed_blessed;
    const vals = [...new Set(c.tool.filter((o) => o.value != null).map((o) => `${STORE_LABEL[o.store].split(" ")[0]}: ${money(o.value)}`))].join("<br>");
    const spread = new Set(c.tool.filter((o) => o.value != null).map((o) => o.value)).size > 1 ? "tools disagree" : "";
    lines.push(`| \`${c.entry.item_key}\` | ${c.entry.unit} | ${vals} | ${[spread, blessed ? `comment says blessed ${blessed}` : ""].filter(Boolean).join("; ")} |`);
  }
  lines.push("");

  lines.push("## Held mappings: fence panel kits with no stated width", "");
  lines.push("The fence tool keys panel kits by height and post length only. R&R sells 2380 and 3150 wide panels at different prices, so these are not merged until the width is confirmed.", "");
  lines.push("| Tool item | Tool values | R&R candidates (latest) |", "|---|---|---|");
  for (const c of comparisons) {
    const m = c.entry.item_key.match(/^fencing-panel-kit-(\d+)-(\d+)$/);
    if (!m) continue;
    const re = new RegExp(`^fence-panel-kit-h${m[1]}-w(\\d+)-post${m[2]}$`);
    const cands = comparisons.filter((x) => re.test(x.entry.item_key) && x.latestEvidence)
      .map((x) => `W${x.entry.item_key.match(re)![1]}: ${money(x.latestEvidence!.value)}`);
    lines.push(`| \`${c.entry.item_key}\` | ${c.tool.filter((o) => o.value != null).map((o) => money(o.value)).join(", ")} | ${cands.join(", ") || "none on file"} |`);
  }
  lines.push("");

  lines.push("## Priced only by invoice or supplier evidence", "");
  lines.push("| Item | Unit | Latest | Rows |", "|---|---|---|---:|");
  for (const c of comparisons.filter((c) => c.latestEvidence && !c.tool.length)) {
    const le = c.latestEvidence!;
    lines.push(`| \`${c.entry.item_key}\` | ${c.entry.unit} | ${money(le.value)} ${le.as_at} ${le.supplier}${le.staged ? " (staged for blessing)" : ""} | ${c.evidence.length} |`);
  }
  lines.push("");

  lines.push("## Unpriced items ($0 sentinels, never loaded as a price)", "");
  const unpricedKeys = new Set(plan.items.map((i) => i.item_key));
  for (const c of plan.costs) unpricedKeys.delete(c.item_key);
  lines.push([...unpricedKeys].map((k) => `\`${k}\``).join(", ") || "none", "");

  lines.push("## Legacy sell rates (reported only, missing cost flagged)", "");
  lines.push("The owner ruled cost is the primary value. These are what the tools charge the customer today; each needs a real cost before a markup can replace it.", "");
  lines.push("| Store | Key | Sell | Unit |", "|---|---|---:|---|");
  for (const o of plan.legacySell) {
    lines.push(`| ${STORE_LABEL[o.store]} | ${o.source_key} | ${money(o.value)} | ${o.source_unit} |`);
  }
  lines.push("");

  lines.push("## Markup found in the stores", "");
  lines.push("| Store | Key | Value |", "|---|---|---:|");
  for (const o of plan.markups) lines.push(`| ${STORE_LABEL[o.store]} | ${o.source_key} | ${o.value} |`);
  lines.push("", "Loaded by the migration as family defaults: patio 1.35 provisional (for the patio lead to set), Stratco 1.4 provisional, fencing and misc not set.", "");

  lines.push("## Allowances loaded", "");
  lines.push("| Allowance | Basis | Band | Cost ex GST | Evidence |", "|---|---|---|---:|---|");
  for (const a of plan.allowances) {
    lines.push(`| ${a.allowance_key} | ${a.basis} | ${a.girth_min_mm == null ? "" : `${a.girth_min_mm} to ${a.girth_max_mm} mm`} | $${a.cost_ex_gst.toFixed(2)} | ${a.evidence_note ?? a.evidence_ref} |`);
  }
  lines.push("");

  lines.push("## Excluded rows", "");
  const reasons = new Map<string, number>();
  for (const o of plan.excluded) {
    const r = `${STORE_LABEL[o.store]}: ${o.excluded_reason ?? "not a price"}`;
    reasons.set(r, (reasons.get(r) ?? 0) + 1);
  }
  lines.push("| Reason | Rows |", "|---|---:|");
  for (const [r, n] of reasons) lines.push(`| ${r} | ${n} |`);
  lines.push("");
  if (plan.unresolved.length) {
    lines.push("## Not loaded: could not be placed", "");
    for (const u of plan.unresolved) {
      lines.push(`- ${STORE_LABEL[u.observation.store]} \`${u.observation.source_key}\`: ${u.reason}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
