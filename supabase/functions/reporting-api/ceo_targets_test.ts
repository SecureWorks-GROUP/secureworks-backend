// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildCeoTargets,
  configAmount,
  DIVISION_ANNUAL_CONFIG_KEYS,
  DIVISION_ANNUAL_DEFAULTS,
  grossMarginBenchmarksFromConfig,
  MARGIN_CRITICAL_DEFAULT,
  MARGIN_FLOOR_CONFIG_KEY,
  MARGIN_FLOOR_DEFAULT,
  MARGIN_GOAL_DEFAULT,
  MONTHLY_REVENUE_DEFAULT,
  monthlyRunRate,
  observeDivisionRevenue,
  shortenOrgConfigKey,
} from "./ceo_targets.ts";

const row = (config_key: string, amount: number) => ({
  config_key,
  config_value: { amount },
});

Deno.test("org_config shortening leaves clean division and floor names", () => {
  assertEquals(
    shortenOrgConfigKey(DIVISION_ANNUAL_CONFIG_KEYS.patio),
    "division_annual_patio",
  );
  assertEquals(
    shortenOrgConfigKey(DIVISION_ANNUAL_CONFIG_KEYS.sheds_fencing),
    "division_annual_sheds_fencing",
  );
  assertEquals(
    shortenOrgConfigKey(DIVISION_ANNUAL_CONFIG_KEYS.insurance),
    "division_annual_insurance",
  );
  assertEquals(shortenOrgConfigKey(MARGIN_FLOOR_CONFIG_KEY), "margin_floor");
  assertEquals(shortenOrgConfigKey("monthly_revenue_target"), "revenue");
  assertEquals(shortenOrgConfigKey("margin_target_pct"), "margin");
  assertEquals(
    shortenOrgConfigKey("concentration_risk_threshold"),
    "concentration_risk",
  );
});

Deno.test("company monthly default is the rounded annual total", () => {
  const annual = DIVISION_ANNUAL_DEFAULTS.patio +
    DIVISION_ANNUAL_DEFAULTS.sheds_fencing +
    DIVISION_ANNUAL_DEFAULTS.insurance;
  assertEquals(annual, 13_000_000);
  assertEquals(MONTHLY_REVENUE_DEFAULT, Math.round(annual / 12));
  assertEquals(MONTHLY_REVENUE_DEFAULT, 1_083_333);
  assertEquals(monthlyRunRate(5_000_000), 416_667);
  assertEquals(monthlyRunRate(3_000_000), 250_000);
});

Deno.test("targets keep monthly revenue and add division run-rates", () => {
  const targets = buildCeoTargets([
    row("monthly_revenue_target", 1_083_333),
    row("margin_target_pct", 50),
    row("monthly_jobs_target", 15),
    row("win_rate_target", 40),
    row(DIVISION_ANNUAL_CONFIG_KEYS.patio, 5_000_000),
    row(DIVISION_ANNUAL_CONFIG_KEYS.sheds_fencing, 5_000_000),
    row(DIVISION_ANNUAL_CONFIG_KEYS.insurance, 3_000_000),
    row(MARGIN_FLOOR_CONFIG_KEY, 40),
  ]);

  assertEquals(targets.revenue, 1_083_333);
  assertEquals(targets.margin, 50);
  assertEquals(targets.jobs, 15);
  assertEquals(targets.win_rate, 40);
  assertEquals(targets.margin_floor, 40);
  assertEquals(targets.division_annual_patio, 5_000_000);
  assertEquals(targets.division_annual_sheds_fencing, 5_000_000);
  assertEquals(targets.division_annual_insurance, 3_000_000);
  assertEquals(targets.division_monthly_patio, 416_667);
  assertEquals(targets.division_monthly_sheds_fencing, 416_667);
  assertEquals(targets.division_monthly_insurance, 250_000);
  assertEquals(targets.divisions.patio.annual_target, 5_000_000);
  assertEquals(targets.divisions.patio.monthly_run_rate, 416_667);
  assertEquals(targets.divisions.sheds_fencing.monthly_run_rate, 416_667);
  assertEquals(targets.divisions.insurance.monthly_run_rate, 250_000);
});

Deno.test("a stored monthly target is not replaced by the new default", () => {
  const targets = buildCeoTargets([
    row("monthly_revenue_target", 180_000),
    row("margin_target_pct", 30),
  ]);
  assertEquals(targets.revenue, 180_000);
  assertEquals(targets.margin, 30);
  assertEquals(targets.division_annual_patio, DIVISION_ANNUAL_DEFAULTS.patio);
  assertEquals(targets.margin_floor, MARGIN_FLOOR_DEFAULT);
});

Deno.test("missing division rows use the yearly defaults, not zero", () => {
  const targets = buildCeoTargets([]);
  assertEquals(targets.revenue, undefined);
  assertEquals(targets.division_annual_patio, 5_000_000);
  assertEquals(targets.division_annual_sheds_fencing, 5_000_000);
  assertEquals(targets.division_annual_insurance, 3_000_000);
  assertEquals(targets.margin_floor, 40);
  assertEquals(targets.division_monthly_patio, 416_667);
});

Deno.test("divisions without a revenue split are not observed, never zero", () => {
  const unread = buildCeoTargets([
    row(DIVISION_ANNUAL_CONFIG_KEYS.patio, 5_000_000),
    row(DIVISION_ANNUAL_CONFIG_KEYS.sheds_fencing, 5_000_000),
    row(DIVISION_ANNUAL_CONFIG_KEYS.insurance, 3_000_000),
  ]);
  for (
    const division of [
      unread.divisions.patio,
      unread.divisions.sheds_fencing,
      unread.divisions.insurance,
    ]
  ) {
    assertEquals(division.revenue, null);
    assertEquals(division.revenue_status, "NOT OBSERVED");
  }

  const fencingOnly = buildCeoTargets([], { fencing: 100_000 });
  assertEquals(fencingOnly.divisions.sheds_fencing.revenue, null);
  assertEquals(
    fencingOnly.divisions.sheds_fencing.revenue_status,
    "NOT OBSERVED",
  );
  assertEquals(fencingOnly.divisions.insurance.revenue, null);
  assertEquals(fencingOnly.divisions.patio.revenue, null);

  assertEquals(observeDivisionRevenue("insurance", { insurance: 10 }), {
    revenue: null,
    revenue_status: "NOT OBSERVED",
  });
  assertEquals(observeDivisionRevenue("patio", {}), {
    revenue: null,
    revenue_status: "NOT OBSERVED",
  });
  assertEquals(observeDivisionRevenue("patio", { patios: 0 }), {
    revenue: 0,
    revenue_status: "observed",
  });
  assertEquals(observeDivisionRevenue("patio", { patios: 1_200 }), {
    revenue: 1_200,
    revenue_status: "observed",
  });
});

Deno.test("gross margin benchmarks read org_config and otherwise use 50 / 40 / 30", () => {
  assertEquals(grossMarginBenchmarksFromConfig([]), {
    gross_margin_target: MARGIN_GOAL_DEFAULT,
    gross_margin_warning: MARGIN_FLOOR_DEFAULT,
    gross_margin_critical: MARGIN_CRITICAL_DEFAULT,
  });
  assertEquals(MARGIN_GOAL_DEFAULT, 50);
  assertEquals(MARGIN_FLOOR_DEFAULT, 40);
  assertEquals(MARGIN_CRITICAL_DEFAULT, 30);

  assertEquals(
    grossMarginBenchmarksFromConfig([
      row("margin_target_pct", 50),
      row("margin_floor_pct", 40),
      row("margin_critical_pct", 30),
    ]),
    {
      gross_margin_target: 50,
      gross_margin_warning: 40,
      gross_margin_critical: 30,
    },
  );

  assertEquals(
    grossMarginBenchmarksFromConfig([row("margin_target_pct", 30)])
      .gross_margin_target,
    30,
  );
});

Deno.test("a non-numeric org_config amount is not read as zero for a new target", () => {
  assertEquals(configAmount({ amount: "5000000" }), null);
  assertEquals(configAmount(null), null);
  const targets = buildCeoTargets([
    {
      config_key: DIVISION_ANNUAL_CONFIG_KEYS.patio,
      config_value: { amount: "5000000" },
    },
  ]);
  assertEquals(targets.division_annual_patio, DIVISION_ANNUAL_DEFAULTS.patio);
});
