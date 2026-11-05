// Yearly division targets and the gross-margin goal / floor.
//
// org_config keys are named so getTargets' first-occurrence shortening
// (monthly_, then _target, then _pct, then _threshold) yields:
//   division_annual_target_patio          → division_annual_patio
//   division_annual_target_sheds_fencing  → division_annual_sheds_fencing
//   division_annual_target_insurance      → division_annual_insurance
//   margin_floor_pct                      → margin_floor
//
// targets.revenue stays the monthly company figure from
// monthly_revenue_target. Division monthly figures are run-rates
// (annual / 12, rounded to the nearest dollar), not a replacement for it.
// The company monthly default is round((5m + 5m + 3m) / 12) = 1,083,333.
// Rounding each division first sums to 1,083,334; those are different numbers.

export const DIVISION_ANNUAL_CONFIG_KEYS = {
  patio: "division_annual_target_patio",
  sheds_fencing: "division_annual_target_sheds_fencing",
  insurance: "division_annual_target_insurance",
} as const;

export const MARGIN_FLOOR_CONFIG_KEY = "margin_floor_pct";
export const MARGIN_GOAL_CONFIG_KEY = "margin_target_pct";
export const MARGIN_CRITICAL_CONFIG_KEY = "margin_critical_pct";
export const MONTHLY_REVENUE_CONFIG_KEY = "monthly_revenue_target";

export const DIVISION_IDS = ["patio", "sheds_fencing", "insurance"] as const;
export type DivisionId = typeof DIVISION_IDS[number];

export const DIVISION_ANNUAL_DEFAULTS: Record<DivisionId, number> = {
  patio: 5_000_000,
  sheds_fencing: 5_000_000,
  insurance: 3_000_000,
};

export const MONTHLY_REVENUE_DEFAULT = 1_083_333;
export const MARGIN_GOAL_DEFAULT = 50;
export const MARGIN_FLOOR_DEFAULT = 40;
export const MARGIN_CRITICAL_DEFAULT = 30;

// Pipeline and tracking splits are patios / fencing / decking / other.
// patio's jobs are filed under patios. sheds_fencing is not fencing, and
// insurance has no split. A missing split is never read as zero revenue.
export const DIVISION_REVENUE_SPLIT: Record<DivisionId, string | null> = {
  patio: "patios",
  sheds_fencing: null,
  insurance: null,
};

export const LEGACY_TARGET_KEYS = [
  "monthly_revenue_target",
  "margin_target_pct",
  "monthly_jobs_target",
  "monthly_marketing_budget",
  "pipeline_coverage_target",
  "dso_target",
  "cycle_time_target",
  "cost_to_revenue_target",
  "concentration_risk_threshold",
  "win_rate_target",
] as const;

export const CEO_TARGET_CONFIG_KEYS = [
  ...LEGACY_TARGET_KEYS,
  DIVISION_ANNUAL_CONFIG_KEYS.patio,
  DIVISION_ANNUAL_CONFIG_KEYS.sheds_fencing,
  DIVISION_ANNUAL_CONFIG_KEYS.insurance,
  MARGIN_FLOOR_CONFIG_KEY,
] as const;

export const GROSS_MARGIN_CONFIG_KEYS = [
  MARGIN_GOAL_CONFIG_KEY,
  MARGIN_FLOOR_CONFIG_KEY,
  MARGIN_CRITICAL_CONFIG_KEY,
] as const;

export type RevenueStatus = "observed" | "NOT OBSERVED";

export interface DivisionTarget {
  annual_target: number;
  monthly_run_rate: number;
  revenue: number | null;
  revenue_status: RevenueStatus;
}

export interface CeoTargets {
  revenue?: number;
  margin?: number;
  jobs?: number;
  marketing_budget?: number;
  pipeline_coverage?: number;
  dso?: number;
  cycle_time?: number;
  cost_to_revenue?: number;
  concentration_risk?: number;
  win_rate?: number;
  margin_floor: number;
  division_annual_patio: number;
  division_annual_sheds_fencing: number;
  division_annual_insurance: number;
  division_monthly_patio: number;
  division_monthly_sheds_fencing: number;
  division_monthly_insurance: number;
  divisions: Record<DivisionId, DivisionTarget>;
}

export interface GrossMarginBenchmarks {
  gross_margin_target: number;
  gross_margin_warning: number;
  gross_margin_critical: number;
}

export interface OrgConfigRow {
  config_key: string;
  config_value: unknown;
}

export interface OrgConfigReader {
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: string): {
        in(
          column: string,
          values: readonly string[],
        ): Promise<{ data: OrgConfigRow[] | null }>;
      };
    };
  };
}

export function shortenOrgConfigKey(configKey: string): string {
  return configKey
    .replace("monthly_", "")
    .replace("_target", "")
    .replace("_pct", "")
    .replace("_threshold", "");
}

export function configAmount(configValue: unknown): number | null {
  if (!configValue || typeof configValue !== "object") return null;
  const amount = (configValue as { amount?: unknown }).amount;
  if (typeof amount !== "number" || !Number.isFinite(amount)) return null;
  return amount;
}

export function monthlyRunRate(annual: number): number {
  return Math.round(annual / 12);
}

export function observeDivisionRevenue(
  division: DivisionId,
  observedBySplit: Readonly<Record<string, number>> | null,
): { revenue: number | null; revenue_status: RevenueStatus } {
  const split = DIVISION_REVENUE_SPLIT[division];
  if (
    split == null || observedBySplit == null ||
    !Object.prototype.hasOwnProperty.call(observedBySplit, split)
  ) {
    return { revenue: null, revenue_status: "NOT OBSERVED" };
  }
  const revenue = observedBySplit[split];
  if (typeof revenue !== "number" || !Number.isFinite(revenue)) {
    return { revenue: null, revenue_status: "NOT OBSERVED" };
  }
  return { revenue, revenue_status: "observed" };
}

function rowsByKey(
  rows: ReadonlyArray<OrgConfigRow>,
): Map<string, unknown> {
  return new Map(rows.map((row) => [row.config_key, row.config_value]));
}

function storedOrDefault(
  byKey: Map<string, unknown>,
  key: string,
  fallback: number,
): number {
  if (!byKey.has(key)) return fallback;
  return configAmount(byKey.get(key)) ?? fallback;
}

export function grossMarginBenchmarksFromConfig(
  rows: ReadonlyArray<OrgConfigRow>,
): GrossMarginBenchmarks {
  const byKey = rowsByKey(rows);
  return {
    gross_margin_target: storedOrDefault(
      byKey,
      MARGIN_GOAL_CONFIG_KEY,
      MARGIN_GOAL_DEFAULT,
    ),
    gross_margin_warning: storedOrDefault(
      byKey,
      MARGIN_FLOOR_CONFIG_KEY,
      MARGIN_FLOOR_DEFAULT,
    ),
    gross_margin_critical: storedOrDefault(
      byKey,
      MARGIN_CRITICAL_CONFIG_KEY,
      MARGIN_CRITICAL_DEFAULT,
    ),
  };
}

export function buildCeoTargets(
  rows: ReadonlyArray<OrgConfigRow>,
  observedRevenueBySplit: Readonly<Record<string, number>> | null = null,
): CeoTargets {
  const byKey = rowsByKey(rows);
  const legacy: Record<string, number> = {};
  for (const key of LEGACY_TARGET_KEYS) {
    if (!byKey.has(key)) continue;
    const value = byKey.get(key) as { amount?: number } | null | undefined;
    legacy[shortenOrgConfigKey(key)] = value?.amount || 0;
  }

  const annual = {
    patio: storedOrDefault(
      byKey,
      DIVISION_ANNUAL_CONFIG_KEYS.patio,
      DIVISION_ANNUAL_DEFAULTS.patio,
    ),
    sheds_fencing: storedOrDefault(
      byKey,
      DIVISION_ANNUAL_CONFIG_KEYS.sheds_fencing,
      DIVISION_ANNUAL_DEFAULTS.sheds_fencing,
    ),
    insurance: storedOrDefault(
      byKey,
      DIVISION_ANNUAL_CONFIG_KEYS.insurance,
      DIVISION_ANNUAL_DEFAULTS.insurance,
    ),
  };
  const marginFloor = storedOrDefault(
    byKey,
    MARGIN_FLOOR_CONFIG_KEY,
    MARGIN_FLOOR_DEFAULT,
  );

  const divisionTarget = (
    id: DivisionId,
    annualTarget: number,
  ): DivisionTarget => {
    const observed = observeDivisionRevenue(id, observedRevenueBySplit);
    return {
      annual_target: annualTarget,
      monthly_run_rate: monthlyRunRate(annualTarget),
      revenue: observed.revenue,
      revenue_status: observed.revenue_status,
    };
  };

  return {
    ...legacy,
    [shortenOrgConfigKey(DIVISION_ANNUAL_CONFIG_KEYS.patio)]: annual.patio,
    [shortenOrgConfigKey(DIVISION_ANNUAL_CONFIG_KEYS.sheds_fencing)]:
      annual.sheds_fencing,
    [shortenOrgConfigKey(DIVISION_ANNUAL_CONFIG_KEYS.insurance)]:
      annual.insurance,
    [shortenOrgConfigKey(MARGIN_FLOOR_CONFIG_KEY)]: marginFloor,
    division_monthly_patio: monthlyRunRate(annual.patio),
    division_monthly_sheds_fencing: monthlyRunRate(annual.sheds_fencing),
    division_monthly_insurance: monthlyRunRate(annual.insurance),
    margin_floor: marginFloor,
    division_annual_patio: annual.patio,
    division_annual_sheds_fencing: annual.sheds_fencing,
    division_annual_insurance: annual.insurance,
    divisions: {
      patio: divisionTarget("patio", annual.patio),
      sheds_fencing: divisionTarget("sheds_fencing", annual.sheds_fencing),
      insurance: divisionTarget("insurance", annual.insurance),
    },
  };
}
