// deno-lint-ignore-file no-explicit-any
// ════════════════════════════════════════════════════════════
// MAKE-SAFE INTAKE — COST LEDGER (cost hardening, M1.5)
// Mission: makesafe/intake-cost-hardening (Auto-Intake v2 Wave 1 M1.5)
// ════════════════════════════════════════════════════════════
//
// Captain's directive: "one cent per email is too much." This module turns the
// classifier's per-call token usage into a running, queryable cost so the effect of
// the text-path + template + caching levers is measurable, not asserted.
//
// RATES — Claude Haiku 4.5 (`claude-haiku-4-5`), the intake classifier model.
// Published Anthropic pricing as of 2026-07-03 (per 1,000,000 tokens):
//   input                 $1.00
//   output                $5.00
//   cache read      0.1×  input  = $0.10   (tokens served from a warm prompt cache)
//   cache write (5m 1.25× input) = $1.25   (tokens written to a 5-minute cache)
// If Anthropic changes Haiku pricing, update HAIKU_4_5_RATES below (and this comment).
export const HAIKU_4_5_RATES = {
  model: "claude-haiku-4-5",
  as_of: "2026-07-03",
  input_per_mtok: 1.0,
  output_per_mtok: 5.0,
  cache_read_per_mtok: 0.1, // 0.1 × input
  cache_write_per_mtok: 1.25, // 1.25 × input (5-minute ephemeral)
} as const;

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export const ZERO_USAGE: TokenUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

/** Normalise the SDK `response.usage` object (fields may be absent on older SDKs). */
export function readUsage(usage: any): TokenUsage {
  const n = (v: any) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    input_tokens: n(usage?.input_tokens),
    output_tokens: n(usage?.output_tokens),
    cache_read_input_tokens: n(usage?.cache_read_input_tokens),
    cache_creation_input_tokens: n(usage?.cache_creation_input_tokens),
  };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
    cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
  };
}

/** USD cost of a token bundle at the Haiku 4.5 rates. `input_tokens` is the uncached
 * remainder; cache-read and cache-write tokens are billed at their own rates, so the
 * three input buckets are summed independently (matching Anthropic billing). */
export function usdCost(u: TokenUsage, rates = HAIKU_4_5_RATES): number {
  const cost =
    (u.input_tokens / 1_000_000) * rates.input_per_mtok +
    (u.output_tokens / 1_000_000) * rates.output_per_mtok +
    (u.cache_read_input_tokens / 1_000_000) * rates.cache_read_per_mtok +
    (u.cache_creation_input_tokens / 1_000_000) * rates.cache_write_per_mtok;
  // Round to 6 dp (micro-dollars) — enough to show sub-cent per-email figures.
  return Math.round(cost * 1_000_000) / 1_000_000;
}

/** Per-email cost record stamped onto the draft's extraction_json.cost for the 24h
 * rollup and the golden-replay cost preview. */
export interface EmailCostRecord {
  model_called: boolean;
  pdf_mode: "text" | "document" | "none";
  parser: "template" | "none";
  usage: TokenUsage;
  estimated_cost_usd: number;
}

export function emailCostRecord(input: {
  model_called: boolean;
  pdf_mode: "text" | "document" | "none";
  parser: "template" | "none";
  usage: TokenUsage;
}): EmailCostRecord {
  return {
    model_called: input.model_called,
    pdf_mode: input.pdf_mode,
    parser: input.parser,
    usage: input.usage,
    estimated_cost_usd: input.model_called ? usdCost(input.usage) : 0,
  };
}

export interface ScanCostTotals {
  model_calls: number;
  model_skips: number;
  usage: TokenUsage;
}

export function emptyScanTotals(): ScanCostTotals {
  return { model_calls: 0, model_skips: 0, usage: { ...ZERO_USAGE } };
}

/** Fold one email's outcome into the per-scan running totals. */
export function accrueScanTotals(totals: ScanCostTotals, rec: EmailCostRecord): ScanCostTotals {
  return {
    model_calls: totals.model_calls + (rec.model_called ? 1 : 0),
    model_skips: totals.model_skips + (rec.model_called ? 0 : 1),
    usage: addUsage(totals.usage, rec.usage),
  };
}

/** Compute the 24h cost dashboard from the per-draft cost records created in the last
 * 24h. `records` = each draft's extraction_json.cost (may be undefined for pre-M1.5
 * drafts — those count as neither a call nor a skip). */
export function rollup24h(records: Array<Partial<EmailCostRecord> | null | undefined>) {
  let modelCalls = 0;
  let modelSkips = 0;
  let priced = 0;
  let usage: TokenUsage = { ...ZERO_USAGE };
  for (const r of records) {
    if (!r || typeof r !== "object") continue;
    // Only rows that carry a cost record (M1.5+) participate in call/skip share.
    if (typeof r.model_called !== "boolean") continue;
    priced++;
    if (r.model_called) modelCalls++;
    else modelSkips++;
    if (r.usage) usage = addUsage(usage, readUsage(r.usage));
  }
  const total = modelCalls + modelSkips;
  return {
    model_calls_24h: modelCalls,
    model_skips_24h: modelSkips,
    priced_drafts_24h: priced,
    // Share of drafts that skipped the model (template-parsed). 0 when nothing priced.
    model_skip_rate: total > 0 ? Math.round((modelSkips / total) * 1000) / 1000 : 0,
    tokens_24h: usage,
    estimated_cost_usd_24h: usdCost(usage),
  };
}
