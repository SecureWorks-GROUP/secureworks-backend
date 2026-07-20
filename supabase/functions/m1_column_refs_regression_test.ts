// ════════════════════════════════════════════════════════════
// M1 REGRESSION — broken column refs, quoted_value guard, unresolved sites
//
// Source-contract tests (read the shipped files). No network, no DB.
// Complements match_unlinked_strategy2_test.ts which exercises the loop.
//
// Covers:
//   • jsonb_typeof guard on jobs.quoted_value generated column
//   • renamed/dropped PostgREST column refs on the fixed call sites
//   • the three deliberately-unresolved query sites left for product call
//
// RUN:
//   ~/.deno/bin/deno test --no-check --allow-read \
//     supabase/functions/m1_column_refs_regression_test.ts
// ════════════════════════════════════════════════════════════

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const ROOT = new URL("..", import.meta.url); // repo root from supabase/functions/

async function readRepo(rel: string): Promise<string> {
  return await Deno.readTextFile(new URL(rel, ROOT));
}

// ── Pure mirror of the migration CASE expression ────────────
// Mirrors 20260717000001_jobs_quoted_value_generated.sql so a non-numeric
// pricing_json value yields NULL rather than raising (which would break
// every job write that touched pricing_json).
function quotedValueFromPricingJson(
  pricing: Record<string, unknown> | null | undefined,
): number | null {
  if (!pricing || typeof pricing !== "object") return null;
  for (const key of ["totalIncGST", "totalIncGst", "total_inc_gst"] as const) {
    const v = pricing[key];
    // jsonb_typeof = 'number' equivalent: only JS numbers (not numeric strings)
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

// ════════════════════════════════════════════════════════════
// 1. JSON type guard — generated column expression
// ════════════════════════════════════════════════════════════

Deno.test("quoted_value migration: uses jsonb_typeof guard, not bare cast", async () => {
  const sql = await readRepo(
    "migrations/20260717000001_jobs_quoted_value_generated.sql",
  );
  assert(
    sql.includes("jsonb_typeof"),
    "migration must guard with jsonb_typeof so non-numeric JSON cannot break writes",
  );
  assert(
    sql.includes("GENERATED ALWAYS AS"),
    "quoted_value must be a generated column",
  );
  assert(sql.includes("STORED"), "quoted_value must be STORED");
  // Bare cast of the jsonb node (not ->>) raises on non-numeric values.
  assert(
    !/\(pricing_json\s*->\s*'totalIncGST'\)\s*::\s*numeric/.test(sql),
    "must not bare-cast pricing_json->'totalIncGST'::numeric (raises on string)",
  );
  // Text extraction via ->> under the typeof guard is the safe form.
  assert(
    sql.includes("pricing_json ->> 'totalIncGST'"),
    "must extract text via ->> under the typeof guard",
  );
  for (const key of ["totalIncGST", "totalIncGst", "total_inc_gst"]) {
    assert(sql.includes(key), `migration must fallback across ${key}`);
  }
});

Deno.test("quoted_value type guard: number keys populate; string/object/null stay null", () => {
  assertEquals(
    quotedValueFromPricingJson({ totalIncGST: 6809.5 }),
    6809.5,
  );
  assertEquals(
    quotedValueFromPricingJson({ totalIncGst: 100 }),
    100,
  );
  assertEquals(
    quotedValueFromPricingJson({ total_inc_gst: 50 }),
    50,
  );
  // Prefer canonical key when multiple present
  assertEquals(
    quotedValueFromPricingJson({
      totalIncGST: 1,
      totalIncGst: 2,
      total_inc_gst: 3,
    }),
    1,
  );
  // Non-numeric JSON must NOT throw and must yield null (write-safe)
  assertEquals(
    quotedValueFromPricingJson({ totalIncGST: "not-a-number" as unknown as number }),
    null,
  );
  assertEquals(
    quotedValueFromPricingJson({ totalIncGST: { amount: 10 } as unknown as number }),
    null,
  );
  assertEquals(quotedValueFromPricingJson({ totalIncGST: null as unknown as number }), null);
  assertEquals(quotedValueFromPricingJson({}), null);
  assertEquals(quotedValueFromPricingJson(null), null);
  assertEquals(quotedValueFromPricingJson(undefined), null);
});

// ════════════════════════════════════════════════════════════
// 2. Renamed / corrected PostgREST reads (source contracts)
// ════════════════════════════════════════════════════════════

Deno.test("xero_invoices: fixed sites use invoice_date / invoice_type / fully_paid_on", async () => {
  const daily = await readRepo("functions/daily-digest/index.ts");
  const opsAi = await readRepo("functions/ops-ai/index.ts");
  const telegram = await readRepo("functions/telegram-bot/index.ts");

  // Aliased selects keep downstream property names stable
  assert(
    daily.includes("date:invoice_date") &&
      daily.includes("type:invoice_type") &&
      daily.includes("fully_paid_on_date:fully_paid_on"),
    "daily-digest must alias real xero_invoices columns",
  );
  assert(
    daily.includes(".eq('invoice_type', 'ACCREC')") ||
      daily.includes('.eq("invoice_type", "ACCREC")'),
    "daily-digest filters must use invoice_type, not type",
  );
  assert(
    daily.includes(".not('fully_paid_on', 'is', null)"),
    "daily-digest fully_paid filter must use fully_paid_on",
  );

  assert(
    opsAi.includes("date:invoice_date") &&
      opsAi.includes("type:invoice_type"),
    "ops-ai must alias invoice_date / invoice_type",
  );
  assert(
    opsAi.includes(".eq('invoice_type', 'ACCREC')"),
    "ops-ai must filter on invoice_type",
  );

  assert(
    telegram.includes(".eq('invoice_type', 'ACCREC')"),
    "telegram-bot must filter on invoice_type",
  );
  assert(
    telegram.includes(".gte('invoice_date', weekAgo)"),
    "telegram-bot must filter on invoice_date",
  );
});

Deno.test("business_events: fixed sites filter/order on occurred_at", async () => {
  const daily = await readRepo("functions/daily-digest/index.ts");
  const health = await readRepo("functions/system-health/index.ts");
  const telegram = await readRepo("functions/telegram-bot/index.ts");

  assert(
    daily.includes("created_at:occurred_at") ||
      daily.includes(".gte('occurred_at'"),
    "daily-digest business_events must use occurred_at",
  );
  // No remaining created_at filter on business_events for the canary path
  assert(
    daily.includes(".gte('occurred_at', fourHoursAgo)") ||
      daily.includes(".gte('occurred_at', weekAgo)"),
    "daily-digest must gte on occurred_at",
  );
  assert(
    health.includes(".gte('occurred_at'"),
    "system-health must count recent events on occurred_at",
  );
  assert(
    telegram.includes(".gte('occurred_at', todayStart)") &&
      telegram.includes(".gte('occurred_at', fourHoursAgo)"),
    "telegram-bot context-capture cooldown must use occurred_at",
  );
});

Deno.test("jobs / PO / trade_invoices / annotations renames stay correct", async () => {
  const daily = await readRepo("functions/daily-digest/index.ts");
  const ops = await readRepo("functions/ops-api/index.ts");
  const reporting = await readRepo("functions/reporting-api/index.ts");
  const telegram = await readRepo("functions/telegram-bot/index.ts");

  assert(
    daily.includes("scheduled_start:scheduled_at"),
    "daily-digest: scheduled_start must alias scheduled_at",
  );
  assert(
    daily.includes("job_type:type"),
    "daily-digest: job_type must alias type",
  );
  assert(
    daily.includes("total_amount:total") &&
      daily.includes("from('purchase_orders')"),
    "daily-digest: purchase_orders total_amount must alias total",
  );
  assert(
    daily.includes("address:site_address") &&
      daily.includes("suburb:site_suburb"),
    "daily-digest: jobs address/suburb must alias site_*",
  );

  assert(
    telegram.includes("address:site_address") &&
      telegram.includes("suburb:site_suburb") &&
      telegram.includes("job_type:type"),
    "telegram-bot findJobByRef must alias site_* / type",
  );

  assert(
    ops.includes("xero_bill_number:xero_bill_id") &&
      ops.includes("week_ending:week_end") &&
      ops.includes("subtotal:subtotal_ex") &&
      ops.includes("total:total_inc"),
    "ops-api trade_invoices selects must alias live columns",
  );
  assert(
    ops.includes(".eq('week_end', weekEnding)") ||
      ops.includes(".eq('week_end', week_ending)"),
    "ops-api must filter trade_invoices on week_end",
  );
  // Dropped columns must not reappear on work_orders / PO selects that M1 fixed
  assert(
    !ops.includes(
      "estimated_hours, trade_cost, crew_rates",
    ),
    "ops-api tradeJobDetail must not select dropped work_orders columns",
  );
  assert(
    !/from\('purchase_orders'\)[\s\S]{0,120}delivery_address/.test(ops) ||
      ops.includes(".select('job_id, delivery_date, notes, status')"),
    "ops-api myJobs PO select must not request delivery_address",
  );

  assert(
    reporting.includes("content:body") &&
      reporting.includes(".eq('entity_type', 'job')") &&
      reporting.includes(".eq('entity_id', jobId)"),
    "reporting-api ai_annotations must use body + entity_type/entity_id",
  );
  assert(
    !reporting.includes(".eq('job_id', jobId)") ||
      !/from\('ai_annotations'\)[\s\S]{0,200}\.eq\('job_id'/.test(reporting),
    "reporting-api must not filter ai_annotations on non-existent job_id",
  );
  assert(
    reporting.includes("channel:communication_type"),
    "reporting-api po_communications must alias communication_type",
  );
});

Deno.test("trade_invoices submit write uses live column names", async () => {
  const ops = await readRepo("functions/ops-api/index.ts");
  // Extract the invoiceRecord object literal keys (not comments / return fields).
  const recMatch = ops.match(
    /const invoiceRecord = \{([\s\S]*?)\n  \}\n/,
  );
  assert(recMatch, "expected trade_invoices invoiceRecord insert block");
  const body = recMatch[1];
  const keys = [...body.matchAll(/^\s{4}([a-z_]+):/gm)].map((m) => m[1]);
  for (const required of [
    "week_start",
    "week_end",
    "subtotal_ex",
    "total_inc",
    "xero_bill_id",
  ]) {
    assert(
      keys.includes(required),
      `invoiceRecord must include ${required}; got ${keys.join(",")}`,
    );
  }
  for (const banned of [
    "week_ending",
    "line_items",
    "subtotal",
    "total",
    "xero_bill_number",
    "xero_invoice_id",
  ]) {
    assert(
      !keys.includes(banned),
      `invoiceRecord must not write legacy key ${banned}; got ${keys.join(",")}`,
    );
  }
});

// ════════════════════════════════════════════════════════════
// 3. Three deliberately unresolved sites (product call required)
// ════════════════════════════════════════════════════════════

Deno.test("unresolved site 1: ops-api quote_revisions.quote_number search stays guarded", async () => {
  const ops = await readRepo("functions/ops-api/index.ts");
  assert(
    ops.includes("quote_revisions has no quote_number column") ||
      ops.includes("BROKEN — left unchanged deliberately"),
    "must keep the product-decision comment on quote_number search",
  );
  // The broken filter is intentionally still present
  assert(
    /from\('quote_revisions'\)[\s\S]{0,200}\.ilike\('quote_number'/.test(ops),
    "quote_number ilike must remain (dropping it would false-match any term)",
  );
});

Deno.test("unresolved site 2: ops-api quote_revisions.superseded_at stays pending", async () => {
  const ops = await readRepo("functions/ops-api/index.ts");
  assert(
    ops.includes("NEEDS A DECISION: quote_revisions has no superseded_at"),
    "must keep the NEEDS A DECISION comment on superseded_at",
  );
  assert(
    /from\('quote_revisions'\)[\s\S]{0,250}\.is\('superseded_at',\s*null\)/.test(
      ops,
    ),
    "superseded_at filter left as-is pending product call",
  );
  // Ordering was the safe fix we did apply
  assert(
    ops.includes(".order('staged_at', { ascending: false })"),
    "quote_revisions order must use staged_at (created_at was wrong)",
  );
});

Deno.test("unresolved site 3: monitor-inbox purchase_orders.supplier_email stays pending", async () => {
  const inbox = await readRepo("functions/monitor-inbox/index.ts");
  assert(
    inbox.includes("NEEDS A DECISION (M1): purchase_orders has no supplier_email") ||
      inbox.includes("purchase_orders has no supplier_email column"),
    "must keep the product-decision comment on supplier_email",
  );
  assert(
    /from\('purchase_orders'\)[\s\S]{0,200}\.ilike\('supplier_email'/.test(
      inbox,
    ),
    "supplier_email filter left as-is (join via suppliers.email is the real fix)",
  );
});
