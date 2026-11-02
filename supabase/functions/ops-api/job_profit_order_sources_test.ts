// deno-lint-ignore-file no-explicit-any
import { deepStrictEqual as assertEquals } from "node:assert";
import { canonicalJsonAndHash } from "../_shared/release_packet/canonicalize.ts";
import { readJobProfitOrderSources } from "./job_profit_order_sources.ts";

const JOB = "job-a", REV = "revision-a";
const EVENT = {
  source: "materials_fact",
  source_id: "fact-a",
  document_id: "bill-a",
};
async function fixture() {
  const { canonical, hash } = await canonicalJsonAndHash({
    lines: [{ id: "post" }, { id: "gate" }],
  });
  return {
    job_materials_facts: [{
      id: "fact-a",
      job_id: JOB,
      xero_invoice_id: "bill-a",
      matched_po_id: "po-a",
    }],
    purchase_orders: [{
      id: "po-a",
      job_id: JOB,
      po_number: "PO-1000001",
      line_items: [
        {
          line_id: "material-post",
          source_version_id: REV,
          source_line_id: "post",
          source_kind: "fence_scope_revision",
        },
        {
          line_id: "material-gate",
          source_version_id: REV,
          source_line_id: "gate",
          source_kind: "fence_scope_revision",
        },
      ],
    }],
    scope_revisions: [{
      id: REV,
      job_id: JOB,
      status: "superseded",
      frozen_at: "2026-10-20T00:00:00Z",
      scope_canonical_text: canonical,
      scope_hash: hash,
    }],
  } as Record<string, any[]>;
}

// Only read methods exist. Mutation attempts throw, and every table is scoped
// using the same predicates as the production reader.
function reader(
  tables: Record<string, any[]>,
  errors: Record<string, string> = {},
) {
  const calls: string[] = [];
  return {
    calls,
    from(table: string) {
      calls.push(table);
      let rows = tables[table] ?? [];
      const result = () =>
        errors[table]
          ? { data: null, error: { message: errors[table] } }
          : { data: rows, error: null };
      const q: any = {
        select() {
          return q;
        },
        eq(key: string, value: unknown) {
          rows = rows.filter((r) => r[key] === value);
          return q;
        },
        limit(n: number) {
          rows = rows.slice(0, n);
          return q;
        },
        maybeSingle() {
          const r = result();
          return Promise.resolve({ ...r, data: r.data?.[0] ?? null });
        },
        then(resolve: (r: unknown) => unknown) {
          return Promise.resolve(result()).then(resolve);
        },
      };
      return q;
    },
  };
}

Deno.test("bill source names its recorded order and exact superseded manifest, never allocates the bill amount to demand lines", async () => {
  const tables = await fixture(), db = reader(tables);
  const result = await readJobProfitOrderSources(db, JOB, [EVENT]);
  assertEquals(result.status, "ok");
  assertEquals(result.links[0], {
    fact_id: "fact-a",
    invoice_id: "bill-a",
    purchase_order_id: "po-a",
    po_number: "PO-1000001",
    line_allocation: {
      status: "unknown",
      reason: "invoice_line_allocation_not_recorded",
    },
    status: "verified_order_manifest",
    reason: null,
    scope_lines: ["post", "gate"].map((id) => ({
      material_line_id: "material-" + id,
      scope_revision_id: REV,
      scope_revision_status: "superseded",
      scope_hash: tables.scope_revisions[0].scope_hash,
      scope_line_id: id,
    })),
  });
  assertEquals(db.calls.filter((t) => t === "scope_revisions").length, 1);
});

Deno.test("an empty returned materials slice is not a whole-job completeness claim and reads nothing", async () => {
  const db = reader(await fixture());
  assertEquals(
    await readJobProfitOrderSources(db, JOB, [{ source: "trade_invoice" }]),
    {
      status: "ok",
      reason: null,
      basis: "returned_materials_fact_events",
      links: [],
    },
  );
  assertEquals(db.calls, []);
});

const cases: Array<[string, (t: Record<string, any[]>) => void, string]> = [
  ["missing fact", (t) => {
    t.job_materials_facts = [];
  }, "fact_identity_unverified"],
  ["different bill", (t) => {
    t.job_materials_facts[0].xero_invoice_id = "bill-b";
  }, "fact_identity_unverified"],
  ["unrecorded order", (t) => {
    t.job_materials_facts[0].matched_po_id = null;
  }, "order_link_not_recorded"],
  ["foreign job order", (t) => {
    t.purchase_orders[0].job_id = "job-b";
  }, "order_identity_unverified"],
  ["empty order", (t) => {
    t.purchase_orders[0].line_items = [];
  }, "order_lines_missing"],
  ["legacy order line", (t) => {
    delete t.purchase_orders[0].line_items[0].source_version_id;
  }, "order_source_not_recorded"],
  ["duplicated demand ID", (t) => {
    t.purchase_orders[0].line_items.push(t.purchase_orders[0].line_items[0]);
  }, "order_source_ambiguous"],
  ["wrong demand ID", (t) => {
    t.purchase_orders[0].line_items[0].source_line_id = "made-up";
  }, "order_line_absent_from_scope"],
  ["missing frozen revision", (t) => {
    t.scope_revisions = [];
  }, "scope_revision_missing"],
  ["foreign revision", (t) => {
    t.scope_revisions[0].job_id = "job-b";
  }, "scope_revision_missing"],
  ["changed frozen bytes", (t) => {
    t.scope_revisions[0].scope_canonical_text += " ";
  }, "scope_hash_mismatch"],
];
for (const [name, mutate, reason] of cases) {
  Deno.test(`bill source does not claim a verified chain for ${name}`, async () => {
    const tables = await fixture();
    mutate(tables);
    const result = await readJobProfitOrderSources(reader(tables), JOB, [
      EVENT,
    ]);
    assertEquals(result.links[0].status, "unknown");
    assertEquals(result.links[0].reason, reason);
    assertEquals(result.links[0].scope_lines, null);
    assertEquals(result.links[0].line_allocation.status, "unknown");
  });
}
for (
  const [table, reason] of [["job_materials_facts", "facts_unreadable"], [
    "purchase_orders",
    "orders_unreadable",
  ]]
) {
  Deno.test(`bill source reports ${table} read failure without throwing or manufacturing an empty known chain`, async () => {
    const result = await readJobProfitOrderSources(
      reader(await fixture(), { [table]: "planted failure" }),
      JOB,
      [EVENT],
    );
    assertEquals(result, {
      status: "unknown",
      reason,
      basis: "returned_materials_fact_events",
      links: [],
    });
  });
}
Deno.test("truncated evidence is unknown rather than a partial verified chain", async () => {
  const tables = await fixture();
  tables.job_materials_facts = Array.from(
    { length: 2001 },
    (_, i) => ({ ...tables.job_materials_facts[0], id: "fact-" + i }),
  );
  const result = await readJobProfitOrderSources(reader(tables), JOB, [EVENT]);
  assertEquals(result.status, "unknown");
  assertEquals(result.reason, "fact_coverage_limit");
});
